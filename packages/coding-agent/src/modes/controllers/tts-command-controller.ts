/**
 * Owner of the `/tts` streaming player: the block queue, the HUD above the
 * composer, the chapter overlay and the shortcuts.
 *
 * Everything here is session-local. `/tts on|off` changes only this session's
 * runtime and never calls `settings.flush()`, so a momentary gesture cannot
 * turn into an accidental global preference. The persisted `speech.enabled` is
 * read once, at session start, to decide whether the mode comes up already on.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { MAX_SPEED, MIN_SPEED, RESPONSE_CAP, SpeechPlaybackQueue } from "../../tts/playback-queue";
import { SpeakableStream } from "../../tts/speakable";
import { vocalizer } from "../../tts/vocalizer";
import { VoiceboxEngine } from "../../tts/voicebox-engine";
import {
	TTS_OVERLAY_HEIGHT_RATIO,
	TTS_OVERLAY_MARGIN,
	TtsChaptersOverlay,
	TtsHudComponent,
} from "../components/tts-player";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../types";

/**
 * The Italian voice, and the engine that can actually speak it.
 *
 * The native on-device runtime cannot: kokoro-js 1.2.1 exposes only the English
 * voices and refuses `if_sara` outright (verified 2026-08-22). Voicebox runs
 * the full Kokoro with the Italian g2p, so the player synthesizes through its
 * local server. If it is not up, `/tts` says so — it never falls back to an
 * English voice reading Italian text.
 */
const TTS_VOICE = "if_sara";
const TTS_LANGUAGE = "it";

/** Shortcuts installed on the editor only while the mode is active. */
const TTS_KEYS = [
	"app.tts.playPause",
	"app.tts.stop",
	"app.tts.previous",
	"app.tts.next",
	"app.tts.speedDown",
	"app.tts.speedUp",
	"app.tts.overlay",
	"app.tts.autoplay",
] as const;

/** Result of a `/tts …` invocation, rendered by the slash command. */
export interface TtsCommandOutcome {
	/** Line to show the user; omitted when the HUD already says it. */
	message?: string;
}

export class TtsCommandController {
	readonly #ctx: InteractiveModeContext;
	#queue: SpeechPlaybackQueue | null = null;
	#unsubscribe: (() => void) | null = null;
	#overlayOpen = false;
	#engine: VoiceboxEngine | null = null;
	#hud: TtsHudComponent | null = null;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	/** Whether the player is running for this session. */
	get active(): boolean {
		return this.#queue !== null;
	}

	/** The live queue, for tests and for the event controller. */
	get queue(): SpeechPlaybackQueue | null {
		return this.#queue;
	}

	/**
	 * Bring the mode up if `speech.enabled` was persisted true. Called once at
	 * session start: HUD and autoplay, no overlay.
	 */
	async initializeFromSettings(): Promise<void> {
		if (!this.#ctx.settings.get("speech.enabled")) return;
		await this.enable();
	}

	/**
	 * `/tts` with no argument: enable if off, and always open the overlay.
	 * Repeating it re-opens the overlay rather than switching the mode off.
	 */
	async handleCommand(argument = ""): Promise<TtsCommandOutcome> {
		const [verb = "", rest = ""] = argument.trim().split(/\s+/, 2);
		switch (verb.toLowerCase()) {
			case "":
				await this.enable();
				void this.openOverlay();
				// The overlay and the HUD are the feedback; a warning line on top of
				// them is just noise in the transcript.
				return {};
			case "on":
				await this.enable();
				return { message: this.#statusLine() };
			case "off":
				await this.disable();
				return { message: "Player TTS spento. La cronologia resta in cache fino alla scadenza." };
			case "status":
				return { message: this.#statusLine() };
			// Transport verbs show their effect in the HUD, so they stay silent
			// unless the player is off and nothing would visibly happen.
			case "play":
				await this.#queue?.togglePlayPause();
				return this.#silentUnlessOff();
			case "pause":
				this.#queue?.pause();
				return this.#silentUnlessOff();
			case "stop":
				this.#queue?.stop();
				return this.#silentUnlessOff();
			case "next":
				await this.step(1);
				return this.#silentUnlessOff();
			case "previous":
				await this.step(-1);
				return this.#silentUnlessOff();
			case "older":
				this.stepResponse(1);
				return this.#silentUnlessOff();
			case "newer":
				this.stepResponse(-1);
				return this.#silentUnlessOff();
			case "speed":
				return { message: this.#setSpeed(rest) };
			case "autoplay":
				return { message: this.#setAutoplay(rest) };
			default:
				return { message: `Sottocomando /tts sconosciuto: ${verb}` };
		}
	}

	/**
	 * Start the player: create the queue, hand it to the vocalizer, install the
	 * runtime config and the format prompt, mount the HUD and the shortcuts, and
	 * warm the Kokoro model in the background.
	 */
	async enable(): Promise<void> {
		if (this.#queue) return;
		const engine = new VoiceboxEngine({ voiceId: TTS_VOICE, language: TTS_LANGUAGE });
		this.#engine = engine;
		const queue = new SpeechPlaybackQueue(
			{
				cwd: this.#ctx.sessionManager.getCwd(),
				sessionId: this.#sessionId(),
				voice: TTS_VOICE,
				autoplay: true,
				// Voicebox takes a whole block and returns a finished WAV, so the
				// queue drives synthesis itself instead of waiting for pushed chunks.
				ownsSynthesis: true,
				spawnPlayback: (wavPath, speed) => this.#spawnAfplay(wavPath, speed),
				synthesizeBlock: async (text, signal) => {
					const audio = await engine.synthesize(text, signal);
					return { kind: "wav", wav: audio.wav, durationSeconds: audio.durationSeconds };
				},
			},
			message => logger.debug("tts player", { message }),
		);
		this.#queue = queue;
		vocalizer.attachPlaybackQueue(queue);
		vocalizer.configureRuntime({ enabled: true, mode: "assistant", voice: TTS_VOICE, enhanced: false });
		this.#ctx.session.setTtsModeEnabled(true);
		this.#mountHud(queue);
		this.#installShortcuts();
		this.#seedFromTranscript(queue);
		void this.#warmEngine(queue, engine);
		this.#ctx.ui.requestRender();
	}

	/**
	 * Load the assistant replies already in the transcript into the player, so
	 * turning `/tts` on mid-session can still reach what has been said. They are
	 * segmented by the same {@link SpeakableStream} the live path uses, so the
	 * blocks match what streaming would have produced, and they stay unrendered
	 * until played — activating the player must not synthesize a whole backlog.
	 */
	#seedFromTranscript(queue: SpeechPlaybackQueue): void {
		const replies: Array<{ id: string; texts: string[] }> = [];
		for (const [index, message] of (this.#ctx.session.messages ?? []).entries()) {
			if (message.role !== "assistant") continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map(block => block.text)
							.join("\n");
			if (!text.trim()) continue;
			const speakable = new SpeakableStream();
			const texts = [...speakable.push(`${text}\n`), ...speakable.flush()];
			if (texts.length > 0) replies.push({ id: `history-${index}`, texts });
		}
		// Oldest first, capped: each seedResponse becomes the newest response.
		for (const reply of replies.slice(-RESPONSE_CAP)) queue.seedResponse(reply.id, reply.texts);
	}

	/** Stop audio and synthesis, drop the prompt, the HUD and the shortcuts. */
	async disable(): Promise<void> {
		const queue = this.#queue;
		if (!queue) return;
		this.#queue = null;
		this.#removeShortcuts();
		this.#unmountHud();
		vocalizer.configureRuntime({ enabled: false, mode: "assistant", voice: TTS_VOICE, enhanced: false });
		vocalizer.clear();
		vocalizer.attachPlaybackQueue(null);
		this.#ctx.session.setTtsModeEnabled(false);
		this.#engine = null;
		await queue.dispose();
		this.#ctx.ui.requestRender();
	}

	/** Open the chapter list. Escape inside it closes only the overlay. */
	async openOverlay(): Promise<void> {
		const queue = this.#queue;
		if (!queue || this.#overlayOpen) return;
		this.#overlayOpen = true;
		try {
			await this.#ctx.showHookCustom<void>(
				(_tui, overlayTheme, keybindings, done) =>
					new TtsChaptersOverlay({
						queue,
						theme: overlayTheme,
						keybindings,
						close: () => done(undefined),
						requestRender: () => this.#ctx.ui.requestRender(),
						// The overlay windows its body to what the host will paint, so it
						// needs the same terminal height the host measures.
						terminalRows: () => this.#ctx.ui.terminal?.rows || process.stdout.rows || 40,
						// The real bindings, not the overlay's in-memory defaults: the
						// help view must show the keys this user actually has.
						globalKeys: {
							playPause: this.#ctx.keybindings.getKeys("app.tts.playPause"),
							stop: this.#ctx.keybindings.getKeys("app.tts.stop"),
							previous: this.#ctx.keybindings.getKeys("app.tts.previous"),
							next: this.#ctx.keybindings.getKeys("app.tts.next"),
							speedDown: this.#ctx.keybindings.getKeys("app.tts.speedDown"),
							speedUp: this.#ctx.keybindings.getKeys("app.tts.speedUp"),
							overlay: this.#ctx.keybindings.getKeys("app.tts.overlay"),
							autoplay: this.#ctx.keybindings.getKeys("app.tts.autoplay"),
						},
					}),
				{
					overlay: true,
					// Geometry shared with the component, so the box it scrolls inside
					// is exactly the box drawn here.
					overlayOptions: {
						width: "90%",
						minWidth: 32,
						maxHeight: `${Math.round(TTS_OVERLAY_HEIGHT_RATIO * 100)}%`,
						anchor: "center",
						margin: TTS_OVERLAY_MARGIN,
					},
				},
			);
		} catch (error) {
			// Shown, not just debug-logged: a ReferenceError here once left `/tts`
			// silently opening nothing at all, with no trace for the user.
			const detail = error instanceof Error ? error.message : String(error);
			logger.debug("tts overlay failed", { error: detail });
			this.#ctx.showWarning(`Pannello TTS non aperto: ${detail}`);
		} finally {
			this.#overlayOpen = false;
		}
	}

	/** Silent when the HUD already shows the effect; explicit when it cannot. */
	#silentUnlessOff(): TtsCommandOutcome {
		return this.#queue ? {} : { message: "Player TTS spento." };
	}

	/** Move one block forward (+1) or back (-1) and speak it. */
	async step(delta: number): Promise<void> {
		const queue = this.#queue;
		if (!queue) return;
		await queue.selectBlock(queue.snapshot().selectedBlockIndex + delta, { play: true });
	}

	/** Move one response older (+1) or newer (-1). */
	stepResponse(delta: number): void {
		const queue = this.#queue;
		if (!queue) return;
		queue.selectResponse(queue.snapshot().selectedResponseIndex + delta);
	}

	/** Release everything on session teardown. */
	async dispose(): Promise<void> {
		await this.disable();
	}

	/**
	 * `on`/`off` set it explicitly, no argument toggles. Turning it off never
	 * interrupts the block being spoken: it stops the queue from moving on when
	 * that block ends.
	 */
	#setAutoplay(raw: string): string {
		const queue = this.#queue;
		if (!queue) return "Player TTS spento.";
		const arg = raw.trim().toLowerCase();
		if (arg !== "" && arg !== "on" && arg !== "off") {
			return `Valore non valido: ${arg}. Usa "on", "off" o nessun argomento per invertire.`;
		}
		const next = arg === "" ? !queue.autoplay : arg === "on";
		queue.setAutoplay(next);
		this.#ctx.ui.requestRender();
		return next
			? "Autoplay attivo: la lettura continua da sola al blocco successivo."
			: "Autoplay spento: ogni blocco si riproduce solo su richiesta.";
	}

	#setSpeed(raw: string): string {
		const queue = this.#queue;
		if (!queue) return "Player TTS spento.";
		const target = Number.parseFloat(raw);
		if (!Number.isFinite(target)) return `Velocità non valida: ${raw || "(vuota)"}`;
		if (target < MIN_SPEED || target > MAX_SPEED) return `Velocità fuori intervallo (${MIN_SPEED}–${MAX_SPEED}×).`;
		// stepSpeed is the only mutation point, so the clamp and the restart rule
		// stay in one place: walk to the requested value in its own increments.
		for (let guard = 0; guard < 32; guard += 1) {
			const current = queue.snapshot().speed;
			const gap = Math.round((target - current) * 10) / 10;
			if (gap === 0) break;
			queue.stepSpeed(gap > 0 ? 0.1 : -0.1);
		}
		return `Velocità ${queue.snapshot().speed.toFixed(1)}×.`;
	}

	#statusLine(): string {
		const queue = this.#queue;
		if (!queue) return "Player TTS spento.";
		const snapshot = queue.snapshot();
		const response = snapshot.responses[snapshot.selectedResponseIndex];
		const blocks = response?.blocks.length ?? 0;
		const blockNo = blocks === 0 ? 0 : snapshot.selectedBlockIndex + 1;
		// While warming the voice profile is not resolved yet, so naming it would
		// just repeat the engine: say what it is doing instead.
		const voice = snapshot.warming ? "connessione a Voicebox" : this.#voiceLabel();
		const error = snapshot.error ? ` · ${snapshot.error}` : "";
		const autoplay = queue.autoplay ? "" : " · autoplay off";
		return `TTS ${snapshot.state} · blocco ${blockNo}/${blocks} · risposta ${
			snapshot.responses.length === 0 ? 0 : snapshot.selectedResponseIndex + 1
		}/${snapshot.responses.length} · ${snapshot.speed.toFixed(1)}×${autoplay} · ${voice}${error}`;
	}

	#sessionId(): string {
		const file = this.#ctx.sessionManager.getSessionFile();
		if (!file) return "session";
		// Only the basename, so the cache never mirrors an absolute path.
		return (file.split("/").pop() ?? "session").replace(/\.jsonl$/, "");
	}

	/** What the HUD calls the voice: the Voicebox profile name once resolved. */
	#voiceLabel(): string {
		return this.#engine?.label ?? "Voicebox";
	}

	#mountHud(queue: SpeechPlaybackQueue): void {
		const hud = new TtsHudComponent(queue.snapshot(), theme, this.#voiceLabel());
		this.#hud = hud;
		this.#ctx.ttsContainer.addChild(hud);
		this.#unsubscribe = queue.subscribe(snapshot => {
			hud.update(snapshot);
			this.#ctx.ui.requestRender();
		});
	}

	#unmountHud(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		this.#hud = null;
		this.#ctx.ttsContainer.disposeChildren();
	}

	#installShortcuts(): void {
		for (const action of TTS_KEYS) {
			for (const key of this.#ctx.keybindings.getKeys(action)) {
				this.#ctx.editor.setCustomKeyHandler(key, () => this.#runShortcut(action));
			}
		}
	}

	#removeShortcuts(): void {
		for (const action of TTS_KEYS) {
			for (const key of this.#ctx.keybindings.getKeys(action)) {
				this.#ctx.editor.removeCustomKeyHandler(key);
			}
		}
	}

	#runShortcut(action: (typeof TTS_KEYS)[number]): void {
		const queue = this.#queue;
		if (!queue) return;
		switch (action) {
			case "app.tts.playPause":
				void queue.togglePlayPause();
				return;
			case "app.tts.stop":
				queue.stop();
				return;
			case "app.tts.previous":
				void this.step(-1);
				return;
			case "app.tts.next":
				void this.step(1);
				return;
			case "app.tts.speedDown":
				queue.stepSpeed(-0.1);
				return;
			case "app.tts.speedUp":
				queue.stepSpeed(0.1);
				return;
			case "app.tts.overlay":
				void this.openOverlay();
				return;
			case "app.tts.autoplay":
				queue.setAutoplay(!queue.autoplay);
				this.#ctx.ui.requestRender();
		}
	}

	/**
	 * Reach the Voicebox server and resolve the voice profile before any text is
	 * queued, so a closed app is reported once, up front, instead of as a stream
	 * of failed blocks. Blocks stay `queued` while this runs.
	 */
	async #warmEngine(queue: SpeechPlaybackQueue, engine: VoiceboxEngine): Promise<void> {
		queue.setWarmProgress(undefined, true);
		try {
			await engine.ensureReady();
			if (this.#queue !== queue) return;
			this.#hud?.setVoiceLabel(engine.label);
			queue.setWarmProgress(undefined, false);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.debug("tts engine unavailable", { error: message });
			if (this.#queue !== queue) return;
			// Leave the mode on but stopped, with the reason visible in the HUD:
			// the user has to fix Voicebox, not guess at silence.
			queue.setWarmProgress(undefined, false);
			queue.reportError(message);
		}
	}

	/**
	 * One afplay per WAV. `-r` is the playback rate and `-q 1` its high-quality
	 * resampler; pause/resume ride on SIGSTOP/SIGCONT of this process.
	 */
	#spawnAfplay(wavPath: string, speed: number) {
		const proc = Bun.spawn(["afplay", "-r", String(speed), "-q", "1", wavPath], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		return {
			pid: proc.pid,
			exited: proc.exited,
			// Bun accepts both the signal name and its number; pass it through.
			kill: (signal?: string | number) => proc.kill(signal as Parameters<typeof proc.kill>[0]),
		};
	}
}
