/**
 * Streaming assistant speech-vocalization.
 *
 * The vocalizer turns the assistant's STREAMING output into spoken audio as a
 * side effect of the normal turn. Two pipelines share the synthesis/playback
 * tail:
 *
 * - Mechanical (default): deltas run through a {@link SpeakableStream} — which
 *   drops code/tables/markup, speaks link labels and URL hosts, and cuts
 *   speakable segments the moment a boundary appears — and each ready segment
 *   is pushed to the TTS worker.
 * - Enhanced (`speech.enhanced`, requires a session-wired
 *   {@link SpeechEnhancer}): deltas accumulate into fence-aware markdown
 *   blocks; each block (small ones coalesced) is rewritten into natural spoken
 *   prose by the tiny/smol model — at most {@link MAX_REWRITES_IN_FLIGHT}
 *   completions in flight, results pushed strictly in order — then segmented
 *   by the same {@link SpeakableStream} as a safety net. A failed or timed-out
 *   rewrite falls back to mechanical cleanup of the raw block, so speech never
 *   blocks on the model.
 *
 * In both modes the synthesis session (worker, player) opens lazily on the
 * first speakable segment, and an idle timer speaks buffered text when
 * generation stalls (tool call, thinking block). One
 * {@link StreamingAudioPlayer} per utterance plays chunks back gaplessly;
 * utterance playback is chained so sequential utterances never overlap.
 *
 * Overspeech control:
 * - {@link clear} stops playback instantly (kills every live player) and
 *   aborts in-flight synthesis and rewrites — wired to a new turn, an
 *   Esc/Ctrl+C interrupt, and a sent message.
 * - {@link duck}/{@link unduck} lower/restore the volume while the user is
 *   speaking (push-to-talk), so the assistant doesn't talk over them.
 *
 * Errors are swallowed (debug-logged) so a synthesis or playback failure never
 * throws into the turn. A process-level singleton ({@link vocalizer}) is shared
 * by the event controller (streaming deltas) and the ask tool (spoken
 * questions); the event controller wires the per-session enhancer via
 * {@link Vocalizer.setEnhancer}.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { DEFAULT_TTS_VOICE } from "./models";
import type { SpeechPlaybackQueue } from "./playback-queue";
import { SpeakableStream } from "./speakable";
import { BlockAccumulator, type SpeechEnhancer } from "./speech-enhancer";
import { createStreamingPlayer, DUCK_GAIN } from "./streaming-player";
import { type TtsStreamHandle, ttsClient } from "./tts-client";

/** Quiet time on the delta stream before the buffered partial is spoken. */
const IDLE_FLUSH_MS = 1000;
/** Coalesce completed blocks until this many chars before one rewrite call. */
const COALESCE_MIN_CHARS = 400;
/** Bounded rewrite concurrency across utterances. */
const MAX_REWRITES_IN_FLIGHT = 2;

export interface VocalizerPlayer {
	start(sampleRate: number): void;
	write(pcm: Float32Array): void;
	setGain(gain: number): void;
	end(): Promise<void>;
	stop(): void;
}

/**
 * Session-local speech configuration installed by the `/tts` controller. When
 * present it wins over the persisted `speech.*` settings, so a stale `yield`
 * mode, an English voice or enhanced rewriting cannot degrade the player's
 * language, latency or streaming.
 */
export interface SpeechRuntimeConfig {
	enabled: boolean;
	mode: "all" | "assistant" | "yield";
	voice: string;
	enhanced: boolean;
}

/**
 * A synthesis session plus the block ids it feeds. `blockIds[i]` is the queue
 * block for the chunk whose `index` is `i`: {@link Vocalizer.pushSegments}
 * enqueues and pushes in the same order, so the mapping stays positional.
 * `responseId` is null when no queue is attached (ask tool, non-TUI contexts).
 */
export interface ManagedTtsHandle {
	stream: TtsStreamHandle;
	responseId: string | null;
	blockIds: string[];
}

/**
 * State of one enhanced-mode utterance. Detached from the vocalizer at
 * {@link Vocalizer.flush} so in-flight rewrites finish and the session closes
 * after the last ordered push, even while the next utterance streams.
 */
interface EnhancedUtterance {
	blocks: BlockAccumulator;
	/** Segments the (rewritten) prose; also the safety net for leaked markup. */
	speakable: SpeakableStream;
	/** Completed blocks held back for coalescing into one rewrite call. */
	pending: string[];
	pendingChars: number;
	/** First rewrite skips coalescing for fast time-to-first-audio. */
	dispatchedFirst: boolean;
	/** FIFO chain that pushes rewrite results in block order. */
	order: Promise<void>;
	handle: ManagedTtsHandle | null;
	/** Aborted by {@link Vocalizer.clear} (current or detached); gates every deferred step. */
	abort: AbortController;
}

export class Vocalizer {
	/** Mechanical mode: open stream session for the current utterance. */
	#handle: ManagedTtsHandle | null = null;
	/** Block queue owning playback when the `/tts` player drives the session. */
	#queue: SpeechPlaybackQueue | null = null;
	/** Session-local override of the persisted `speech.*` settings. */
	#runtime: SpeechRuntimeConfig | null = null;
	/** Response the current segments belong to; one per user prompt. */
	#responseId: string | null = null;
	/** Mechanical mode: markdown → segment transform for the current utterance. */
	#speakable: SpeakableStream | null = null;
	/** Enhanced mode: the utterance currently receiving deltas. */
	#enhanced: EnhancedUtterance | null = null;
	/** Per-session rewrite service; wired by the event controller, null elsewhere. */
	#enhancer: SpeechEnhancer | null = null;
	/** Fires when the delta stream goes quiet mid-sentence; speaks the partial. */
	#idleTimer: NodeJS.Timeout | null = null;
	/** Abort controllers of every not-yet-finished utterance; all aborted on {@link clear}. */
	#liveAborts = new Set<AbortController>();
	/** Players of every not-yet-finished utterance; ducked together, stopped on {@link clear}. */
	#livePlayers = new Set<VocalizerPlayer>();
	/** Serialized playback chain across utterances; awaited by {@link idle}. */
	#chain: Promise<void> = Promise.resolve();
	/** Whether the user is currently speaking; new sessions open ducked. */
	#ducked = false;
	/** Active scopes that suppress local TTS while another speech surface owns audio. */
	#suspensions = 0;
	/** Available rewrite slots; blocks queue when exhausted. */
	#rewriteSlots = MAX_REWRITES_IN_FLIGHT;
	#slotWaiters: Array<() => void> = [];
	#createPlayer: () => VocalizerPlayer;
	#openStream: (modelKey: string, options: { voice: string; signal: AbortSignal }) => TtsStreamHandle;

	constructor(
		createPlayer: () => VocalizerPlayer = createStreamingPlayer,
		openStream: (modelKey: string, options: { voice: string; signal: AbortSignal }) => TtsStreamHandle = (
			modelKey,
			options,
		) => ttsClient.synthesizeStream(modelKey, options),
	) {
		this.#createPlayer = createPlayer;
		this.#openStream = openStream;
	}

	/** Wire (or drop) the per-session enhanced-rewrite service. */
	setEnhancer(enhancer: SpeechEnhancer | null): void {
		this.#enhancer = enhancer;
	}

	/**
	 * Hand playback to the `/tts` block queue, or take it back. While a queue is
	 * attached the synthesized chunks land in it instead of a
	 * {@link StreamingAudioPlayer}: the queue owns the WAV cache, the transport
	 * and the HUD. Detaching restores the plain streaming behaviour used by the
	 * ask tool, `omp say` and non-TUI contexts.
	 */
	attachPlaybackQueue(queue: SpeechPlaybackQueue | null): void {
		this.#queue = queue;
	}

	/**
	 * Install (or drop) the session-local speech configuration. With a config
	 * present every getter reads it; without one they fall back to the
	 * persisted `speech.*` settings.
	 */
	configureRuntime(config: SpeechRuntimeConfig | undefined): void {
		this.#runtime = config ?? null;
	}

	/** Whether vocalization is on, runtime override first. */
	isRuntimeEnabled(): boolean {
		return this.#runtime ? this.#runtime.enabled : settings.get("speech.enabled");
	}

	/** What to speak: all, assistant messages only, or the final message. */
	runtimeMode(): "all" | "assistant" | "yield" {
		return this.#runtime ? this.#runtime.mode : settings.get("speech.mode");
	}

	/** Kokoro voice for this session. */
	runtimeVoice(): string {
		return this.#runtime ? this.#runtime.voice : settings.get("speech.voice") || DEFAULT_TTS_VOICE;
	}

	/** Whether the tiny-model rewrite runs before synthesis. */
	runtimeEnhanced(): boolean {
		return this.#runtime ? this.#runtime.enhanced : settings.get("speech.enhanced");
	}

	/**
	 * Open the speech history entry for one user prompt. Every intermediate
	 * tool turn stays inside it until {@link finalizeResponse}.
	 */
	beginResponse(id: string): void {
		this.#responseId = id;
		this.#queue?.beginResponse(id);
	}

	/** Close the response opened by {@link beginResponse} (terminal agent_end). */
	finalizeResponse(id: string): void {
		this.#queue?.finalizeResponse(id);
		if (this.#responseId === id) this.#responseId = null;
	}

	/**
	 * Suppress new vocalization until the returned idempotent release function runs.
	 * Existing synthesis and playback stop immediately; nested scopes release independently.
	 */
	suspend(): () => void {
		this.#suspensions += 1;
		this.clear();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#suspensions = Math.max(0, this.#suspensions - 1);
		};
	}

	/**
	 * Stream a delta of assistant text into the pipeline. No-op when
	 * vocalization is disabled. The synthesis session (worker, player) is only
	 * opened once the first speakable segment exists, so a reply that
	 * normalizes to silence (pure code, tables, URLs) costs nothing. The
	 * trailing partial is flushed by {@link flush} or the idle timer. The
	 * pipeline (enhanced vs mechanical) is latched per utterance.
	 */
	pushDelta(text: string): void {
		if (this.#suspensions > 0 || !this.isRuntimeEnabled()) return;
		if (!text) return;
		if (this.#enhanced || (!this.#speakable && this.#enhancer && this.runtimeEnhanced())) {
			this.#pushEnhanced(text);
			return;
		}
		this.#speakable ??= new SpeakableStream();
		const speakable = this.#speakable;
		this.#pushSegments(speakable.push(text));
		this.#armIdle(() => {
			if (this.#speakable !== speakable) return;
			this.#pushSegments(speakable.flushIdle());
		});
	}

	/**
	 * Close the current input stream (call at message/turn end). Drains the
	 * trailing partial as final segments; in enhanced mode the session ends
	 * only after the last in-flight rewrite has pushed, while the next
	 * utterance may already be streaming.
	 */
	flush(): void {
		this.#clearIdleTimer();
		const utterance = this.#enhanced;
		if (utterance) {
			this.#enhanced = null;
			const last = utterance.blocks.flush();
			if (last !== null) {
				utterance.pending.push(last);
				utterance.pendingChars += last.length;
			}
			this.#dispatchPending(utterance);
			utterance.order = utterance.order.then(() => {
				if (utterance.abort.signal.aborted) return;
				utterance.handle?.stream.end();
				// A rewrite-only utterance (nothing speakable, no session) has no
				// playback teardown to reap its abort controller — do it here.
				if (!utterance.handle) this.#liveAborts.delete(utterance.abort);
			});
			return;
		}
		const speakable = this.#speakable;
		this.#speakable = null;
		if (speakable) this.#pushSegments(speakable.flush());
		this.#handle?.stream.end();
		this.#handle = null;
	}

	/**
	 * Speak a complete piece of text in one shot (ask questions, yield-mode final
	 * message): stream it in and immediately close the input. No-op when disabled.
	 */
	speak(text: string): void {
		this.pushDelta(text);
		this.flush();
	}

	/**
	 * Interrupt and drop every utterance, killing in-flight playback, synthesis,
	 * and rewrites (new turn / user message / Esc interrupt). Audio stops at once.
	 */
	clear(): void {
		this.#clearIdleTimer();
		this.#enhanced = null;
		this.#speakable = null;
		this.#handle = null;
		for (const abort of this.#liveAborts) abort.abort();
		this.#liveAborts.clear();
		for (const player of this.#livePlayers) player.stop();
		this.#livePlayers.clear();
		// The queue drops its process and pending audio but keeps history and
		// the cached WAVs navigable: an interrupt must not erase what was said.
		this.#queue?.clear();
	}

	/**
	 * True while any utterance is still audible or synthesizing — a live
	 * player, an unfinished stream handle, or an in-flight rewrite is enough.
	 * Callers (Esc handler) treat this as the "silence me" signal.
	 */
	isSpeaking(): boolean {
		if (this.#livePlayers.size > 0 || this.#liveAborts.size > 0 || this.#handle !== null) return true;
		const state = this.#queue?.snapshot().state;
		return state === "playing" || state === "waiting";
	}

	/** Lower the volume while the user is speaking (push-to-talk), so speech doesn't drown them out. */
	duck(): void {
		this.#ducked = true;
		for (const player of this.#livePlayers) player.setGain(DUCK_GAIN);
	}

	/** Restore full volume once the user stops speaking. */
	unduck(): void {
		this.#ducked = false;
		for (const player of this.#livePlayers) player.setGain(1);
	}

	/** Resolve once the playback chain has drained (tests / shutdown). */
	idle(): Promise<void> {
		return this.#chain;
	}

	// --- Enhanced pipeline ---------------------------------------------------

	#pushEnhanced(text: string): void {
		if (!this.#enhanced) this.#enhanced = this.#newEnhancedUtterance();
		const utterance = this.#enhanced;
		for (const block of utterance.blocks.push(text)) {
			utterance.pending.push(block);
			utterance.pendingChars += block.length;
			// The first rewrite dispatches immediately for fast first audio;
			// later blocks coalesce so a heading and its list cost one call.
			if (!utterance.dispatchedFirst || utterance.pendingChars >= COALESCE_MIN_CHARS) {
				this.#dispatchPending(utterance);
			}
		}
		this.#armIdle(() => {
			if (this.#enhanced !== utterance) return;
			const partial = utterance.blocks.flushPartial();
			if (partial !== null) {
				utterance.pending.push(partial);
				utterance.pendingChars += partial.length;
			}
			this.#dispatchPending(utterance);
		});
	}

	#newEnhancedUtterance(): EnhancedUtterance {
		const abort = new AbortController();
		this.#liveAborts.add(abort);
		return {
			blocks: new BlockAccumulator(),
			speakable: new SpeakableStream(),
			pending: [],
			pendingChars: 0,
			dispatchedFirst: false,
			order: Promise.resolve(),
			handle: null,
			abort,
		};
	}

	/**
	 * Send the coalesced pending blocks to the rewriter and chain the ordered
	 * push of the result. The completion runs concurrently (bounded by the
	 * slot pool); only the push into the synthesizer is serialized, so block
	 * N+1's rewrite overlaps block N's synthesis.
	 */
	#dispatchPending(utterance: EnhancedUtterance): void {
		if (utterance.pending.length === 0) return;
		const block = utterance.pending.join("\n\n");
		utterance.pending = [];
		utterance.pendingChars = 0;
		utterance.dispatchedFirst = true;
		const result = this.#boundedRewrite(block, utterance.abort.signal);
		utterance.order = utterance.order.then(async () => {
			const rewritten = await result;
			if (utterance.abort.signal.aborted) return;
			// Empty string: the model judged the block unspeakable (pure code).
			if (rewritten === "") return;
			// Null: rewrite failed/timed out — mechanical cleanup of the raw
			// block via the SpeakableStream keeps speech flowing.
			const spoken = rewritten ?? block;
			const segments = utterance.speakable.push(spoken.endsWith("\n") ? spoken : `${spoken}\n`);
			if (segments.length === 0) return;
			if (this.#enqueueOnly(segments)) return;
			utterance.handle ??= this.#openSession(utterance.abort);
			this.#feed(utterance.handle, segments);
		});
	}

	/** Run one rewrite through the bounded slot pool; never rejects. */
	async #boundedRewrite(block: string, signal: AbortSignal): Promise<string | null> {
		await this.#acquireSlot();
		try {
			if (signal.aborted || !this.#enhancer) return null;
			return await this.#enhancer.rewrite(block, signal);
		} finally {
			this.#releaseSlot();
		}
	}

	#acquireSlot(): Promise<void> {
		if (this.#rewriteSlots > 0) {
			this.#rewriteSlots--;
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#slotWaiters.push(resolve);
		return promise;
	}

	#releaseSlot(): void {
		const next = this.#slotWaiters.shift();
		if (next) next();
		else this.#rewriteSlots++;
	}

	// --- Shared synthesis/playback tail --------------------------------------

	/** Mechanical mode: feed ready segments, opening the session lazily. */
	#pushSegments(segments: string[]): void {
		if (segments.length === 0) return;
		if (this.#enqueueOnly(segments)) return;
		if (!this.#handle) {
			const abort = new AbortController();
			this.#liveAborts.add(abort);
			this.#handle = this.#openSession(abort);
		}
		this.#feed(this.#handle, segments);
	}

	/**
	 * When the queue owns synthesis (the Voicebox engine), the vocalizer's job
	 * ends at the text: it enqueues each segment and the queue synthesizes them
	 * in order. No stream is opened, so there is no chunk index to map onto
	 * blocks — the whole positional mapping below simply does not apply.
	 * Returns true when the segments were handled here.
	 */
	#enqueueOnly(segments: string[]): boolean {
		const queue = this.#queue;
		if (!queue?.ownsSynthesis) return false;
		const responseId = this.#responseId;
		if (!responseId) {
			logger.debug("vocalizer: segments dropped, no open response");
			return true;
		}
		for (const segment of segments) queue.enqueue(responseId, segment);
		return true;
	}

	/**
	 * Push segments into a session, registering one queue block per segment
	 * first. Enqueue and push happen in the same order in the same loop, which
	 * is what makes `blockIds[chunk.index]` the right block later on.
	 */
	#feed(handle: ManagedTtsHandle, segments: string[]): void {
		const queue = this.#queue;
		for (const segment of segments) {
			if (queue && handle.responseId !== null) {
				handle.blockIds.push(queue.enqueue(handle.responseId, segment));
			}
			handle.stream.push(segment);
		}
	}

	/**
	 * Open a streaming-synthesis session and chain its playback after any
	 * prior utterance's, so sequential utterances never overlap.
	 */
	#openSession(abort: AbortController): ManagedTtsHandle {
		const modelKey = settings.get("tts.localModel");
		const handle: ManagedTtsHandle = {
			stream: this.#openStream(modelKey, { voice: this.runtimeVoice(), signal: abort.signal }),
			responseId: this.#queue ? this.#responseId : null,
			blockIds: [],
		};
		this.#liveAborts.add(abort);
		// With a queue attached the audio goes to disk and afplay, so no
		// StreamingAudioPlayer is created at all — and duck/unduck, which act on
		// the player's gain, do not apply to that path.
		if (handle.responseId !== null) {
			this.#chain = this.#chain.then(async () => {
				try {
					await this.#drainIntoQueue(handle, abort.signal);
				} finally {
					this.#liveAborts.delete(abort);
				}
			});
			return handle;
		}
		const player = this.#createPlayer();
		player.setGain(this.#ducked ? DUCK_GAIN : 1);
		this.#livePlayers.add(player);
		this.#chain = this.#chain.then(async () => {
			try {
				await this.#play(handle.stream, player, abort.signal);
			} finally {
				this.#liveAborts.delete(abort);
				this.#livePlayers.delete(player);
			}
		});
		return handle;
	}

	/**
	 * Queue path: hand each synthesized chunk to the block it belongs to. A
	 * missing or repeated index is an error of that one block — it is logged
	 * and skipped, never allowed to shift the mapping of the following chunks.
	 */
	async #drainIntoQueue(handle: ManagedTtsHandle, signal: AbortSignal): Promise<void> {
		const queue = this.#queue;
		if (!queue) return;
		const seen = new Set<number>();
		try {
			for await (const chunk of handle.stream.chunks) {
				if (signal.aborted) break;
				const blockId = handle.blockIds[chunk.index];
				if (blockId === undefined) {
					logger.debug("vocalizer: chunk index has no block", { index: chunk.index });
					continue;
				}
				if (seen.has(chunk.index)) {
					logger.debug("vocalizer: duplicate chunk index", { index: chunk.index, blockId });
					continue;
				}
				seen.add(chunk.index);
				await queue.acceptAudio(blockId, chunk.pcm, chunk.sampleRate);
			}
		} catch (error) {
			logger.debug("vocalizer: queue stream failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * (Re)arm the stall timer: if no delta arrives for {@link IDLE_FLUSH_MS},
	 * speak buffered text instead of holding it through a tool call or
	 * thinking block. The callback checks utterance identity itself.
	 */
	#armIdle(onIdle: () => void): void {
		this.#clearIdleTimer();
		const timer = setTimeout(() => {
			this.#idleTimer = null;
			onIdle();
		}, IDLE_FLUSH_MS);
		timer.unref?.();
		this.#idleTimer = timer;
	}

	#clearIdleTimer(): void {
		if (this.#idleTimer === null) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = null;
	}

	/** Feed each synthesized segment into the player in arrival order; abort stops it. */
	async #play(handle: TtsStreamHandle, player: VocalizerPlayer, signal: AbortSignal): Promise<void> {
		let started = false;
		try {
			for await (const chunk of handle.chunks) {
				if (signal.aborted) break;
				if (!started) {
					player.start(chunk.sampleRate);
					started = true;
				}
				player.write(chunk.pcm);
			}
			if (started && !signal.aborted) {
				await player.end();
				return;
			}
		} catch (error) {
			logger.debug("vocalizer: stream failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		player.stop();
	}
}

/** Process-level vocalizer shared by the event controller and the ask tool. */
export const vocalizer = new Vocalizer();
