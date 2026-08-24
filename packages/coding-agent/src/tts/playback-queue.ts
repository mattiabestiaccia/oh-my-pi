import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { encodeWav } from "./wav";

/**
 * Playback states of a single speech block. `queued` waits for synthesis,
 * `synthesizing` is being rendered by the worker, `ready` has a WAV on disk,
 * `playing`/`paused` are the active states, `played` finished naturally,
 * `failed` means the WAV could not be produced.
 */
export type SpeechBlockState = "queued" | "synthesizing" | "ready" | "playing" | "paused" | "played" | "failed";

/** Aggregate player state surfaced to the HUD and controller. */
export type PlaybackState = "warming" | "idle" | "waiting" | "playing" | "paused" | "error";

/** A spoken sentence with a stable id and the audio it maps to. */
export interface SpeechBlock {
	id: string;
	responseId: string;
	text: string;
	state: SpeechBlockState;
	wavPath?: string;
	durationSeconds?: number;
	error?: string;
	startedAt?: number;
	pausedAt?: number;
	pausedTotalMs?: number;
	/**
	 * Seeded from the transcript rather than produced by a live reply: it has no
	 * audio yet and must not be synthesized until someone asks to hear it.
	 * Otherwise activating `/tts` would render the whole backlog at once.
	 */
	deferred?: boolean;
}

/** One assistant response, holding its ordered blocks. */
export interface SpeechResponse {
	id: string;
	ordinal: number;
	blocks: SpeechBlock[];
	finalized: boolean;
}

/**
 * Snapshot of the whole player. `responses` holds up to RESPONSE_CAP entries
 * newest-first; `selectedResponseIndex`/`selectedBlockIndex` point into it.
 */
export interface SpeechPlaybackSnapshot {
	state: PlaybackState;
	responses: SpeechResponse[];
	selectedResponseIndex: number;
	selectedBlockIndex: number;
	speed: number;
	warming: boolean;
	warmProgress?: number;
	activeBlockId: string | null;
	elapsedMs: number;
	error: string | null;
	/** Whether the queue moves on by itself when a block ends. */
	autoplay: boolean;
}

/**
 * Process launched for one WAV. Production passes `Bun.spawn(["afplay", "-r",
 * rate, "-q", "1", path])`; tests inject a fake recording signals.
 */
export interface PlaybackProcess {
	pid: number;
	exited: Promise<number>;
	kill(signal?: string | number): void;
}

/**
 * Audio for one block, in whichever form the engine produced it. The native
 * on-device path yields raw PCM; Voicebox returns a finished WAV, which is
 * stored as-is rather than decoded and re-encoded for nothing.
 */
export type SynthesizedBlock =
	| { kind: "pcm"; pcm: Float32Array; sampleRate: number }
	| { kind: "wav"; wav: Uint8Array; durationSeconds: number };

export interface SpeechPlaybackQueueOptions {
	cwd: string;
	sessionId: string;
	spawnPlayback: (wavPath: string, speed: number) => PlaybackProcess;
	/**
	 * Synthesize this text. Used to retry a failed or expired block and, when
	 * `ownsSynthesis` is set, as the queue's own engine. Returns null on
	 * failure; a thrown error surfaces its message on the block and the player.
	 */
	synthesizeBlock: (text: string, signal: AbortSignal) => Promise<SynthesizedBlock | null>;
	/**
	 * Drive synthesis from inside the queue, one block at a time in queue order,
	 * instead of waiting for audio pushed in by the vocalizer. This is the
	 * Voicebox path: its server takes a whole block and hands back a WAV, so
	 * there is no chunk stream to map onto blocks.
	 */
	ownsSynthesis?: boolean;
	voice?: string;
	autoplay?: boolean;
}

/** Maximum responses kept in memory (oldest dropped first). */
export const RESPONSE_CAP = 20;

/** WAV TTL before a sweep removes it. */
export const CACHE_TTL_MS = 3_600_000;

/** Sweep cadence once the queue is alive. */
export const SWEEP_INTERVAL_MS = 300_000;

/** Ticker cadence while a block is audible, for elapsed/total in the HUD. */
export const TICK_INTERVAL_MS = 250;

/** Speed bounds; `stepSpeed` moves in 0.1 increments inside them. */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/**
 * Block-queue decoupling Kokoro's serial synthesis from afplay playback.
 * `enqueue` + `acceptAudio` feed it; `togglePlayPause`/`stop`/`selectBlock`
 * drive a single afplay process whose lifecycle uses SIGSTOP/SIGCONT/SIGTERM.
 *
 * Two pointers are deliberately distinct. `#activeBlockId` is what is audible
 * (or awaited); `#selectedResponseIndex`/`#selectedBlockIndex` is where the
 * user is navigating. Autoplay follows the queue in chronological order, never
 * the selection pointer: a response arriving mid-block moves the selection but
 * must not steal the audio.
 */
export class SpeechPlaybackQueue {
	#cwd: string;
	#sessionId: string;
	#spawnPlayback: (wavPath: string, speed: number) => PlaybackProcess;
	#synthesizeBlock: (text: string, signal: AbortSignal) => Promise<SynthesizedBlock | null>;
	#ownsSynthesis: boolean;
	/** True while the queue's own engine is busy: synthesis stays serial. */
	#synthesizing = false;
	#voice: string;
	#autoplay: boolean;
	/**
	 * Set by `stop()`, cleared by any explicit play. Without it a stop followed
	 * by fresh audio would silently restart the player behind the user's back.
	 */
	#autoplayHalted = false;
	#responses: SpeechResponse[] = [];
	#selectedResponseIndex = 0;
	#selectedBlockIndex = 0;
	#speed = 1;
	#state: PlaybackState = "idle";
	#warming = false;
	#warmProgress: number | undefined;
	#activeProcess: PlaybackProcess | null = null;
	#activeBlockId: string | null = null;
	#lastError: string | null = null;
	#listeners = new Set<(snapshot: SpeechPlaybackSnapshot) => void>();
	#sweepTimer: ReturnType<typeof setInterval> | null = null;
	#ticker: ReturnType<typeof setInterval> | null = null;
	#sweepPromise: Promise<void> | null = null;
	#writingPaths = new Set<string>();
	#resynthesizing = false;
	#abort = new AbortController();
	#cacheRoot: string;
	#sessionCacheDir: string;
	#log: (message: string) => void;

	constructor(options: SpeechPlaybackQueueOptions, log: (message: string) => void = m => console.error("[tts]", m)) {
		this.#cwd = options.cwd;
		this.#sessionId = options.sessionId;
		this.#spawnPlayback = options.spawnPlayback;
		this.#synthesizeBlock = options.synthesizeBlock;
		this.#ownsSynthesis = options.ownsSynthesis ?? false;
		this.#voice = options.voice ?? "if_sara";
		this.#autoplay = options.autoplay ?? false;
		this.#log = log;
		this.#cacheRoot = resolve(options.cwd, ".omp", "tts-cache");
		this.#sessionCacheDir = resolve(this.#cacheRoot, options.sessionId);
		void this.sweepExpired();
		this.#sweepTimer = setInterval(() => void this.sweepExpired(), SWEEP_INTERVAL_MS);
		this.#sweepTimer.unref?.();
	}

	/** Working directory the cache hangs off; exposed for the controller/HUD. */
	get cwd(): string {
		return this.#cwd;
	}

	/** Session id used as the cache sub-directory. */
	get sessionId(): string {
		return this.#sessionId;
	}

	/** Voice the queue re-synthesizes with; the plan pins this to `if_sara`. */
	get voice(): string {
		return this.#voice;
	}

	/**
	 * Whether finishing a block moves on to the next one by itself. Off means
	 * every block is played by an explicit request.
	 */
	get autoplay(): boolean {
		return this.#autoplay;
	}

	/**
	 * Whether the queue drives synthesis itself. When true the vocalizer only
	 * enqueues text and opens no synthesis stream at all.
	 */
	get ownsSynthesis(): boolean {
		return this.#ownsSynthesis;
	}

	/**
	 * Begin a new assistant response. Unique per user prompt; tool turns stay
	 * inside the same response until finalizeResponse.
	 */
	beginResponse(id: string): void {
		if (this.#responses.some(r => r.id === id)) return;
		const ordinal = this.#responses.length ? Math.max(...this.#responses.map(r => r.ordinal)) + 1 : 1;
		this.#responses.unshift({ id, ordinal, blocks: [], finalized: false });
		if (this.#responses.length > RESPONSE_CAP) this.#responses.length = RESPONSE_CAP;
		this.#selectedResponseIndex = 0;
		this.#selectedBlockIndex = 0;
		this.#emit();
	}

	/**
	 * Enqueue a speakable segment. Returns a stable block id used by acceptAudio
	 * and the UI. Each emission becomes a navigable chapter.
	 */
	enqueue(responseId: string, text: string): string {
		if (!this.#findResponse(responseId)) {
			this.#log(`enqueue: unknown response ${responseId}; creating`);
			this.beginResponse(responseId);
		}
		const response = this.#findResponse(responseId);
		if (!response) return responseId;
		const id = `${responseId}:${response.blocks.length}`;
		response.blocks.push({ id, responseId, text, state: "queued" });
		this.#emit();
		this.#pumpSynthesis();
		return id;
	}

	/**
	 * Add a past reply from the transcript, so activating the player mid-session
	 * can still reach what has already been said. The blocks land `queued` and
	 * `deferred`: no synthesis runs until one is explicitly played.
	 *
	 * Seed oldest-first — each call becomes the newest response.
	 */
	seedResponse(id: string, texts: string[]): void {
		if (texts.length === 0) return;
		this.beginResponse(id);
		const response = this.#findResponse(id);
		if (!response) return;
		for (const text of texts) {
			response.blocks.push({
				id: `${id}:${response.blocks.length}`,
				responseId: id,
				text,
				state: "queued",
				deferred: true,
			});
		}
		response.finalized = true;
		this.#emit();
	}

	/**
	 * Accept synthesized audio: encode WAV, persist atomically, mark ready and
	 * hand back to the pump. Returns without awaiting playback so the worker
	 * keeps synthesizing the next block while afplay renders this one.
	 */
	async acceptAudio(blockId: string, pcm: Float32Array, sampleRate: number): Promise<void> {
		await this.#storeAudio(blockId, encodeWav(pcm, sampleRate), pcm.length / sampleRate, "acceptAudio");
	}

	/**
	 * Accept a WAV that an engine already produced (the Voicebox path). Skips
	 * the decode/re-encode round trip that going through PCM would cost.
	 */
	async acceptWav(blockId: string, wav: Uint8Array, durationSeconds: number): Promise<void> {
		await this.#storeAudio(blockId, wav, durationSeconds, "acceptWav");
	}

	/** Persist a block's WAV, mark it ready and let the pump decide what plays. */
	async #storeAudio(blockId: string, wav: Uint8Array, durationSeconds: number, origin: string): Promise<void> {
		const block = this.#findBlock(blockId);
		if (!block) {
			this.#log(`${origin}: unknown block ${blockId}`);
			return;
		}
		block.wavPath = await this.#writeWav(block, wav);
		block.durationSeconds = durationSeconds;
		block.state = "ready";
		block.error = undefined;
		block.deferred = undefined;
		this.#pump();
		this.#emit();
	}

	/**
	 * The queue's own synthesis loop, active only with `ownsSynthesis`. Takes
	 * the oldest still-queued block, synthesizes it and stores the result, one
	 * at a time: the engine is a single local server, and a block that is
	 * already audible must not be overtaken by a later one.
	 */
	#pumpSynthesis(): void {
		if (!this.#ownsSynthesis || this.#synthesizing || this.#warming) return;
		const block = this.#nextQueuedBlock();
		if (!block) return;
		this.#synthesizing = true;
		block.state = "synthesizing";
		this.#emit();
		void this.#synthesizeInto(block).finally(() => {
			this.#synthesizing = false;
			// Chain to the next queued block, if the stream produced more meanwhile.
			this.#pumpSynthesis();
		});
	}

	/** One engine call, with the failure confined to its own block. */
	async #synthesizeInto(block: SpeechBlock): Promise<void> {
		try {
			const audio = await this.#synthesizeBlock(block.text, this.#abort.signal);
			if (this.#abort.signal.aborted) return;
			if (!audio) {
				this.#failBlock(block, "sintesi senza audio");
				return;
			}
			if (audio.kind === "wav") await this.acceptWav(block.id, audio.wav, audio.durationSeconds);
			else await this.acceptAudio(block.id, audio.pcm, audio.sampleRate);
		} catch (error) {
			if (this.#abort.signal.aborted) return;
			this.#failBlock(block, error instanceof Error ? error.message : String(error));
		}
	}

	/** Mark one block failed and surface its message, without stopping the rest. */
	#failBlock(block: SpeechBlock, message: string): void {
		block.state = "failed";
		block.error = message;
		this.#lastError = message;
		this.#emit();
	}

	/**
	 * What to synthesize next, in order of urgency:
	 *
	 * 1. the block the player is *waiting* on — nothing can be heard until it
	 *    exists, deferred or not;
	 * 2. the oldest block of a live reply, which is the streaming path;
	 * 3. the block right after whatever is audible — the prefetch that keeps
	 *    autoplay from stalling at every paragraph boundary.
	 *
	 * Backlog blocks are never picked by (2): activating the player must not
	 * render a whole transcript. They are reached only through (1) and (3), i.e.
	 * because someone is listening to the paragraph just before them.
	 */
	#nextQueuedBlock(): SpeechBlock | undefined {
		if (this.#state === "waiting" && this.#activeBlockId) {
			const awaited = this.#findBlock(this.#activeBlockId);
			if (awaited?.state === "queued") return awaited;
		}
		const live = this.#orderedBlocks().find(block => block.state === "queued" && !block.deferred);
		if (live) return live;
		const active = this.#activeBlock();
		if (!active) return undefined;
		const next = this.#blockAfter(active);
		return next?.state === "queued" ? next : undefined;
	}

	/** Mark a response complete (agent_end). No more blocks will arrive. */
	finalizeResponse(id: string): void {
		const response = this.#findResponse(id);
		if (response) response.finalized = true;
		this.#emit();
	}

	/**
	 * Transport: one transition per state. playing -> pause (SIGSTOP),
	 * paused -> resume (SIGCONT), anything else -> play the selected block. A
	 * second play during playback is therefore a pause, never a no-op warning.
	 */
	async togglePlayPause(): Promise<void> {
		if (this.#state === "playing") {
			this.pause();
			return;
		}
		if (this.#state === "paused") {
			this.resume();
			return;
		}
		await this.play();
	}

	/** Pause: SIGSTOP freezes afplay in place; the position survives. */
	pause(): void {
		if (this.#state !== "playing") return;
		this.#activeProcess?.kill("SIGSTOP");
		const block = this.#activeBlock();
		if (block) {
			block.state = "paused";
			block.pausedAt = Date.now();
		}
		this.#state = "paused";
		this.#stopTicker();
		this.#emit();
	}

	/** Resume: SIGCONT the same afplay process, position preserved. */
	resume(): void {
		if (this.#state !== "paused") return;
		this.#autoplayHalted = false;
		const block = this.#activeBlock();
		if (!this.#activeProcess) {
			// The process died while paused: restart the block rather than hang.
			if (block?.wavPath) void this.#spawnAndPlay(block, block.wavPath);
			return;
		}
		this.#activeProcess.kill("SIGCONT");
		if (block) {
			block.state = "playing";
			if (block.pausedAt !== undefined) {
				block.pausedTotalMs = (block.pausedTotalMs ?? 0) + Date.now() - block.pausedAt;
				block.pausedAt = undefined;
			}
		}
		this.#state = "playing";
		this.#startTicker();
		this.#emit();
	}

	/**
	 * Stop: SIGTERM the process, keep the pointer on the block, go idle (not
	 * paused — corrects the Pi defect where stop set paused too). Autoplay stays
	 * halted until an explicit play, so incoming audio does not resurrect it.
	 */
	stop(): void {
		this.#stopCurrentProcess();
		this.#releaseActiveBlock();
		this.#autoplayHalted = true;
		this.#stopTicker();
		this.#state = "idle";
		this.#emit();
	}

	/**
	 * Play what is selected. If its WAV is not ready yet, become `waiting` and
	 * start as soon as acceptAudio delivers that exact block.
	 */
	async play(): Promise<void> {
		const block = this.#selectedBlock();
		if (!block) return;
		this.#autoplayHalted = false;
		if (this.#state === "playing") {
			this.pause();
			return;
		}
		if (this.#state === "paused") {
			this.resume();
			return;
		}
		await this.#playBlock(block);
	}

	/**
	 * Select a block within the current response (0-based) and optionally play
	 * it. Skip kills the current process first, so it restarts cleanly; if the
	 * target WAV is not ready the player waits on it instead of skipping ahead.
	 */
	async selectBlock(index: number, options: { play?: boolean } = {}): Promise<void> {
		const response = this.#responses[this.#selectedResponseIndex];
		const block = response?.blocks[index];
		if (!block) return;
		this.#selectedBlockIndex = index;
		if (options.play) {
			this.#autoplayHalted = false;
			await this.#playBlock(block);
		}
		this.#emit();
	}

	/**
	 * Move the response pointer. Does not interrupt audio; the next explicit
	 * play targets the newly selected response.
	 */
	selectResponse(index: number): void {
		if (index < 0 || index >= this.#responses.length) return;
		this.#selectedResponseIndex = index;
		this.#selectedBlockIndex = 0;
		this.#emit();
	}

	/**
	 * Change speed by delta (0.1 steps), clamped to [0.5, 2]. If a block is
	 * audible, restart it from the beginning at the new rate: blocks are short
	 * and this is deterministic, unlike estimating a resume position.
	 */
	stepSpeed(delta: number): void {
		const next = Math.round((this.#speed + delta) * 10) / 10;
		if (next < MIN_SPEED || next > MAX_SPEED) return;
		this.#speed = next;
		const block = this.#activeBlock();
		if ((this.#state === "playing" || this.#state === "paused") && block?.wavPath) {
			void this.#spawnAndPlay(block, block.wavPath);
		}
		this.#emit();
	}

	/** Snapshot for the UI; copies responses and blocks so components can diff. */
	snapshot(): SpeechPlaybackSnapshot {
		const active = this.#activeBlock();
		let elapsedMs = 0;
		// Only a block that is actually running has an elapsed time; otherwise a
		// stale startedAt made the HUD count past the block's own duration.
		if (active?.startedAt !== undefined && (this.#state === "playing" || this.#state === "paused")) {
			const pausedMs =
				(active.pausedAt !== undefined ? Date.now() - active.pausedAt : 0) + (active.pausedTotalMs ?? 0);
			elapsedMs = Math.max(0, Date.now() - active.startedAt - pausedMs);
		}
		return {
			state: this.#state,
			responses: this.#responses.map(r => ({
				...r,
				blocks: r.blocks.map(b => ({ ...b, state: this.#projectedState(b) })),
			})),
			selectedResponseIndex: this.#selectedResponseIndex,
			selectedBlockIndex: this.#selectedBlockIndex,
			speed: this.#speed,
			warming: this.#warming,
			warmProgress: this.#warmProgress,
			activeBlockId: this.#activeBlockId,
			elapsedMs,
			error: this.#lastError,
			autoplay: this.#autoplay,
		};
	}

	/**
	 * The state the UI should show for a block.
	 *
	 * `playing` and `paused` are properties of *the player*, not of a block, and
	 * keeping them as block state meant two representations of one fact that
	 * could drift apart — the overlay showed two ▶ at once, one of them on a
	 * block whose audio had stopped long before. Here exactly one block can be
	 * audible by construction: the one `#activeBlockId` names.
	 */
	#projectedState(block: SpeechBlock): SpeechBlockState {
		if (block.id !== this.#activeBlockId) {
			// Never audible unless it is the active one.
			return block.state === "playing" || block.state === "paused"
				? block.wavPath
					? "ready"
					: "queued"
				: block.state;
		}
		if (this.#state === "playing") return "playing";
		if (this.#state === "paused") return "paused";
		if (this.#state === "waiting") return block.wavPath ? "ready" : "synthesizing";
		return block.state === "playing" || block.state === "paused" ? "ready" : block.state;
	}

	/** Subscribe to snapshots; returns an unsubscribe fn. Emits immediately. */
	subscribe(listener: (snapshot: SpeechPlaybackSnapshot) => void): () => void {
		this.#listeners.add(listener);
		queueMicrotask(() => listener(this.snapshot()));
		return () => this.#listeners.delete(listener);
	}

	/** Enable/disable autoplay of newly accepted audio. */
	setAutoplay(enabled: boolean): void {
		this.#autoplay = enabled;
		if (enabled) {
			this.#autoplayHalted = false;
			this.#pumpSynthesis();
			this.#pump();
		}
		// Turning it off never interrupts what is already audible: it only stops
		// the queue from moving on when the current block ends.
		this.#emit();
	}

	/**
	 * Report model warm-up: while true the player shows `warming` and blocks
	 * stay queued; when it clears, the pump may start whatever is ready.
	 */
	setWarmProgress(progress: number | undefined, warming: boolean): void {
		this.#warming = warming;
		this.#warmProgress = progress;
		if (warming) this.#state = "warming";
		else if (this.#state === "warming") this.#state = "idle";
		if (!warming) {
			this.#pumpSynthesis();
			this.#pump();
		}
		this.#emit();
	}

	/**
	 * Surface an engine-level failure (the synthesis server is unreachable) on
	 * the player itself. Distinct from a failed block: nothing can be spoken
	 * until it is fixed, so it must be visible rather than silent.
	 */
	reportError(message: string): void {
		this.#lastError = message;
		this.#state = "error";
		this.#emit();
	}

	/**
	 * Drop pending audio and stop the process on interrupt or a new user
	 * prompt, keeping history and cached WAVs navigable.
	 */
	clear(): void {
		this.#stopCurrentProcess();
		for (const response of this.#responses) {
			for (const block of response.blocks) {
				if (block.state !== "playing" && block.state !== "paused") continue;
				block.state = block.wavPath ? "ready" : "queued";
				block.pausedAt = undefined;
				block.startedAt = undefined;
			}
		}
		this.#activeBlockId = null;
		this.#stopTicker();
		this.#state = this.#warming ? "warming" : "idle";
		this.#emit();
	}

	/**
	 * The single decision point for "should something start now?". Called after
	 * every event that can make a block playable. Honours a pending `waiting`
	 * first (an explicit play on a block whose audio had not landed yet), then
	 * autoplay in chronological queue order.
	 */
	#pump(): void {
		if (this.#warming || this.#activeProcess) return;
		if (this.#state === "playing" || this.#state === "paused") return;
		let target: SpeechBlock | undefined;
		if (this.#state === "waiting" && this.#activeBlockId) {
			const waiting = this.#findBlock(this.#activeBlockId);
			if (waiting?.state === "ready" && waiting.wavPath) target = waiting;
		}
		if (!target && this.#autoplay && !this.#autoplayHalted) target = this.#nextPlayableBlock();
		if (!target?.wavPath) return;
		void this.#spawnAndPlay(target, target.wavPath);
	}

	/**
	 * Every block in reading order: oldest response first (the array is
	 * newest-first), blocks in emission order. This flat sequence is what both
	 * autoplay and "play from here" walk.
	 */
	#orderedBlocks(): SpeechBlock[] {
		const ordered: SpeechBlock[] = [];
		for (let i = this.#responses.length - 1; i >= 0; i -= 1) {
			const response = this.#responses[i];
			if (!response) continue;
			ordered.push(...response.blocks);
		}
		return ordered;
	}

	/**
	 * First block with audio that has not been heard yet. Used when audio
	 * arrives and nothing is playing — the start of a fresh reply.
	 */
	#nextPlayableBlock(): SpeechBlock | undefined {
		return this.#orderedBlocks().find(block => block.state === "ready" && block.wavPath);
	}

	/**
	 * The block right after this one in reading order, whatever its state.
	 *
	 * This is what autoplay follows once something has been played, and it is
	 * deliberately positional rather than state-based: jumping back to an
	 * earlier paragraph and pressing play has to resume reading *from there*,
	 * not skip ahead to the first block nobody has heard yet.
	 */
	#blockAfter(block: SpeechBlock): SpeechBlock | undefined {
		const ordered = this.#orderedBlocks();
		const index = ordered.indexOf(block);
		if (index === -1) return undefined;
		return ordered[index + 1];
	}

	/**
	 * Play one block on the explicit path: kill whatever runs, re-synthesize if
	 * the audio failed or expired, otherwise start it or wait for it.
	 */
	async #playBlock(block: SpeechBlock): Promise<void> {
		this.#stopCurrentProcess();
		if (this.#activeBlockId !== block.id) this.#releaseActiveBlock();
		const pending = block.state === "queued" || block.state === "synthesizing";
		// A deferred block has never been rendered: playing it is the request to
		// render it, so synthesize now instead of waiting for audio that is not
		// coming from anywhere.
		if (block.state === "failed" || (block.deferred && !block.wavPath) || (!pending && !block.wavPath)) {
			// Not awaited on purpose: synthesis takes a second or more, and a key
			// press must not block on it. The player shows `waiting`, and playback
			// starts by itself when the audio lands.
			void this.#resynthesizeAndPlay(block);
			return;
		}
		if (pending || !block.wavPath) {
			this.#state = "waiting";
			this.#activeBlockId = block.id;
			this.#emit();
			return;
		}
		await this.#spawnAndPlay(block, block.wavPath);
	}

	/**
	 * Spawn afplay for a ready block and wire its completion. Marks the block
	 * playing; on exit 0 -> played and advance, non-zero -> failed/error. The
	 * selection pointer follows what is audible so the HUD and overlay agree.
	 */
	async #spawnAndPlay(block: SpeechBlock, wavPath: string): Promise<void> {
		this.#stopCurrentProcess();
		// Whatever was audible stops being audible: exactly one block at a time
		// may be in `playing`.
		this.#releaseActiveBlock();
		block.state = "playing";
		block.startedAt = Date.now();
		block.pausedAt = undefined;
		block.pausedTotalMs = 0;
		this.#activeBlockId = block.id;
		this.#syncSelectionTo(block);
		this.#state = "playing";
		this.#lastError = null;
		this.#startTicker();
		this.#emit();
		// Render the next paragraph while this one plays, so autoplay does not
		// stop at every boundary waiting for the engine.
		this.#pumpSynthesis();
		const proc = this.#spawnPlayback(wavPath, this.#speed);
		this.#activeProcess = proc;
		proc.exited
			.then(code => {
				if (this.#activeProcess !== proc) return;
				this.#activeProcess = null;
				this.#stopTicker();
				if (code === 0) {
					block.state = "played";
					this.#state = "idle";
					this.#advanceAfterPlayed(block);
				} else {
					block.state = "failed";
					block.error = `afplay exited ${code}`;
					this.#lastError = block.error;
					this.#state = "error";
				}
				this.#emit();
			})
			.catch(err => {
				if (this.#activeProcess !== proc) return;
				this.#activeProcess = null;
				this.#stopTicker();
				this.#lastError = String(err);
				this.#state = "error";
				this.#emit();
			});
	}

	/**
	 * After a block finishes naturally, autoplay continues with the block that
	 * follows it in reading order — so replaying an earlier paragraph resumes
	 * the whole reply from that point instead of jumping to the end.
	 *
	 * If the next block has no audio yet (the reply is still streaming) the
	 * player waits on it and `#pump` starts it the moment it lands. When there
	 * is no next block at all, a newer response that arrived mid-playback is
	 * picked up here.
	 */
	#advanceAfterPlayed(finished: SpeechBlock): void {
		if (!this.#autoplay || this.#autoplayHalted) return;
		const next = this.#blockAfter(finished);
		if (next) {
			// Any block with audio is spoken, `played` included: replaying an
			// earlier paragraph has to read forward through blocks already heard.
			if (next.wavPath) {
				void this.#spawnAndPlay(next, next.wavPath);
				return;
			}
			// No audio yet. Point at it and wait — and ask for it: a backlog block
			// would otherwise sit queued forever, because the synthesis pump skips
			// deferred blocks and nothing else is going to produce it.
			this.#state = "waiting";
			this.#activeBlockId = next.id;
			this.#pumpSynthesis();
			return;
		}
		const fresh = this.#nextPlayableBlock();
		if (fresh?.wavPath) void this.#spawnAndPlay(fresh, fresh.wavPath);
	}

	/** Point the navigation cursor at the block that is (about to be) audible. */
	#syncSelectionTo(block: SpeechBlock): void {
		const responseIndex = this.#responses.findIndex(r => r.id === block.responseId);
		const response = this.#responses[responseIndex];
		if (!response) return;
		const blockIndex = response.blocks.indexOf(block);
		if (blockIndex === -1) return;
		this.#selectedResponseIndex = responseIndex;
		this.#selectedBlockIndex = blockIndex;
	}

	/**
	 * Failure path: re-synthesize a block on demand (priority over prefetch)
	 * then persist and play. Only one on-demand resynthesis may run at a time;
	 * a second request just waits on its block.
	 */
	async #resynthesizeAndPlay(block: SpeechBlock): Promise<void> {
		this.#state = "waiting";
		this.#activeBlockId = block.id;
		if (this.#resynthesizing) {
			this.#emit();
			return;
		}
		this.#resynthesizing = true;
		block.state = "synthesizing";
		block.error = undefined;
		this.#emit();
		try {
			const audio = await this.#synthesizeBlock(block.text, this.#abort.signal);
			if (audio?.kind === "wav") {
				await this.acceptWav(block.id, audio.wav, audio.durationSeconds);
			} else if (audio) {
				await this.acceptAudio(block.id, audio.pcm, audio.sampleRate);
			} else {
				block.state = "failed";
				block.error = "synthesis returned no audio";
				this.#lastError = block.error;
				this.#state = "error";
			}
		} catch (err) {
			block.state = "failed";
			block.error = String(err);
			this.#lastError = block.error;
			this.#state = "error";
		} finally {
			this.#resynthesizing = false;
			this.#emit();
		}
	}

	/* Cache and process helpers ------------------------------------------- */

	/**
	 * Lazy-create the cache dir with an internal `.gitignore` containing `*` so
	 * WAVs never appear in the git status of any project. The cache only comes
	 * into existence at the first `/tts` activation.
	 */
	async #ensureCacheDir(): Promise<string> {
		await mkdir(this.#sessionCacheDir, { recursive: true });
		const ignore = resolve(this.#cacheRoot, ".gitignore");
		await writeFile(ignore, "*\n", { flag: "wx" }).catch(() => {});
		return this.#sessionCacheDir;
	}

	/**
	 * Write a block's WAV atomically (`.part` then rename) so a sweep never
	 * sees a half-written file and afplay never reads one.
	 */
	async #writeWav(block: SpeechBlock, wav: Uint8Array): Promise<string> {
		const dir = await this.#ensureCacheDir();
		const stem = `${block.responseId}-${this.#blockOrdinal(block)}-${this.#blockHash8(block.text)}`;
		const wavPath = resolve(dir, `${stem}.wav`);
		const partPath = resolve(dir, `${stem}.part`);
		this.#writingPaths.add(partPath);
		try {
			await writeFile(partPath, wav);
			await rename(partPath, wavPath);
		} finally {
			this.#writingPaths.delete(partPath);
		}
		return wavPath;
	}

	/** Stable 8-hex hash of the block text (FNV-1a) for the filename. */
	#blockHash8(text: string): string {
		let hash = 2166136261;
		for (let i = 0; i < text.length; i += 1) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0).toString(16).padStart(8, "0");
	}

	/** Ordinal (1-based) of a block within its response, for the filename. */
	#blockOrdinal(block: SpeechBlock): number {
		const response = this.#findResponse(block.responseId);
		return response ? response.blocks.indexOf(block) + 1 : 1;
	}

	#findResponse(id: string): SpeechResponse | undefined {
		return this.#responses.find(r => r.id === id);
	}

	#findBlock(id: string): SpeechBlock | undefined {
		for (const response of this.#responses) {
			const found = response.blocks.find(b => b.id === id);
			if (found) return found;
		}
		return undefined;
	}

	#activeBlock(): SpeechBlock | undefined {
		return this.#activeBlockId ? this.#findBlock(this.#activeBlockId) : undefined;
	}

	#selectedBlock(): SpeechBlock | undefined {
		return this.#responses[this.#selectedResponseIndex]?.blocks[this.#selectedBlockIndex];
	}

	#stopCurrentProcess(): void {
		if (!this.#activeProcess) return;
		this.#activeProcess.kill("SIGTERM");
		this.#activeProcess = null;
	}

	/**
	 * Take the active block out of the audible states and clear its timing.
	 *
	 * Interrupting a block mid-sentence — a skip, a speed change, a jump to
	 * another paragraph — kills the process, and the dead process's completion
	 * handler bails out early because it is no longer the active one. Without
	 * this, that block stayed `playing` forever: the overlay showed two ▶ at
	 * once and its elapsed counter ran past its own duration.
	 *
	 * It goes back to `ready`, not `played`: it was cut short, so it is still
	 * there to be heard.
	 */
	#releaseActiveBlock(): void {
		const block = this.#activeBlock();
		if (!block) return;
		if (block.state === "playing" || block.state === "paused") {
			block.state = block.wavPath ? "ready" : "queued";
		}
		block.startedAt = undefined;
		block.pausedAt = undefined;
		block.pausedTotalMs = 0;
	}

	#startTicker(): void {
		if (this.#ticker) return;
		this.#ticker = setInterval(() => this.#emit(), TICK_INTERVAL_MS);
		this.#ticker.unref?.();
	}

	#stopTicker(): void {
		if (!this.#ticker) return;
		clearInterval(this.#ticker);
		this.#ticker = null;
	}

	/**
	 * Sweep the cache: remove `.wav` and `.part` older than CACHE_TTL_MS,
	 * except the currently playing file and files being written. Uses `lstat`
	 * so a symlink is never followed, and deletes only real descendants of the
	 * resolved cache root. Concurrent callers share one pass.
	 */
	async sweepExpired(): Promise<void> {
		if (this.#sweepPromise) return this.#sweepPromise;
		this.#sweepPromise = this.#sweep();
		try {
			await this.#sweepPromise;
		} finally {
			this.#sweepPromise = null;
		}
	}

	async #sweep(): Promise<void> {
		const root = resolve(this.#cacheRoot);
		let sessionDirs: string[];
		try {
			sessionDirs = await readdir(root);
		} catch {
			return;
		}
		const now = Date.now();
		const activeWav = this.#activeBlock()?.wavPath;
		for (const entry of sessionDirs) {
			const dir = resolve(root, entry);
			if (!dir.startsWith(root + sep)) continue;
			let dirInfo: Awaited<ReturnType<typeof lstat>>;
			try {
				dirInfo = await lstat(dir);
			} catch {
				continue;
			}
			// lstat, not stat: a symlinked session dir is not a real descendant.
			if (!dirInfo.isDirectory()) continue;
			let files: string[];
			try {
				files = await readdir(dir);
			} catch {
				continue;
			}
			for (const file of files) {
				if (!file.endsWith(".wav") && !file.endsWith(".part")) continue;
				const full = resolve(dir, file);
				if (this.#writingPaths.has(full)) continue;
				if (activeWav === full) continue;
				let info: Awaited<ReturnType<typeof lstat>>;
				try {
					info = await lstat(full);
				} catch {
					continue;
				}
				if (!info.isFile()) continue;
				if (now - info.mtimeMs <= CACHE_TTL_MS) continue;
				await rm(full, { force: true }).catch(() => {});
			}
		}
	}

	/**
	 * Dispose: abort synthesis, stop process and timers, remove partial `.part`
	 * writes. Valid WAVs stay until their TTL, as the plan requires.
	 */
	async dispose(): Promise<void> {
		this.#abort.abort();
		this.#stopCurrentProcess();
		this.#stopTicker();
		if (this.#sweepTimer) {
			clearInterval(this.#sweepTimer);
			this.#sweepTimer = null;
		}
		for (const part of this.#writingPaths) {
			await rm(part, { force: true }).catch(() => {});
		}
		this.#writingPaths.clear();
		this.#listeners.clear();
		this.#state = "idle";
		this.#activeBlockId = null;
	}

	#emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.#listeners) {
			try {
				listener(snapshot);
			} catch {
				this.#log("listener error");
			}
		}
	}
}
