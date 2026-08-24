/**
 * Synthesis engine backed by the local Voicebox app.
 *
 * Why this exists: the native on-device path (kokoro-js 1.2.1, the latest
 * release) only exposes the English voices — `if_sara` and every other
 * non-English voice is refused with `Voice "…" not found`, even though the
 * `.bin` files ship inside the package, because the other languages need a g2p
 * (misaki) the package does not implement. Voicebox runs the full Kokoro with
 * that g2p, so it is the only local path that speaks Italian today.
 *
 * The server is an HTTP job queue on the loopback interface: `POST /generate`
 * returns an id, `GET /history/{id}` reports progress, `GET /audio/{id}`
 * returns the finished WAV. Nothing leaves the machine.
 *
 * Failures are explicit. A missing server or a missing profile for the wanted
 * language raises, so `/tts` can say what is wrong instead of quietly speaking
 * Italian text with an English voice.
 */

/** Default address of the Voicebox app's local server. */
export const VOICEBOX_DEFAULT_URL = "http://127.0.0.1:17493";

/** How long a single block may take before it is abandoned. */
const GENERATE_TIMEOUT_MS = 60_000;
/** Poll cadence while a generation is running. A block takes about a second. */
const POLL_INTERVAL_MS = 100;
/** Timeout of one individual HTTP call. */
const REQUEST_TIMEOUT_MS = 30_000;

/** A voice profile as the server reports it. Field names copied from `/profiles`. */
export interface VoiceboxProfile {
	id: string;
	name: string;
	language: string | null;
	voice_type: string;
	preset_engine: string | null;
	preset_voice_id: string | null;
	default_engine: string | null;
}

/** The finished generation record from `/history/{id}`. */
interface VoiceboxGeneration {
	id: string;
	status: string;
	duration: number | null;
	error: string | null;
}

/** WAV bytes plus the duration the server measured. */
export interface VoiceboxAudio {
	wav: Uint8Array;
	durationSeconds: number;
}

export class VoiceboxUnavailableError extends Error {
	constructor(cause: string) {
		super(`Voicebox non risponde su ${VOICEBOX_DEFAULT_URL} (${cause}). Apri Voicebox.app e riprova.`);
		this.name = "VoiceboxUnavailableError";
	}
}

export class VoiceboxVoiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VoiceboxVoiceError";
	}
}

export interface VoiceboxEngineOptions {
	baseUrl?: string;
	/** Preferred `preset_voice_id`, e.g. `if_sara`. */
	voiceId?: string;
	/** Language the profile must speak; a profile of another language is never used. */
	language?: string;
	/** Injected for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Talks to the Voicebox server and returns one finished WAV per block. The
 * chosen profile is resolved once and cached: it is a user-visible identity
 * (the voice you hear) and must not silently change between blocks.
 */
export class VoiceboxEngine {
	#baseUrl: string;
	#voiceId: string | undefined;
	#language: string | undefined;
	#fetch: typeof fetch;
	#profile: VoiceboxProfile | null = null;

	constructor(options: VoiceboxEngineOptions = {}) {
		this.#baseUrl = (options.baseUrl ?? VOICEBOX_DEFAULT_URL).replace(/\/$/, "");
		this.#voiceId = options.voiceId;
		this.#language = options.language;
		this.#fetch = options.fetchImpl ?? globalThis.fetch;
	}

	/** The resolved profile, once `ensureReady` has run. */
	get profile(): VoiceboxProfile | null {
		return this.#profile;
	}

	/** Human-readable label of the active voice, for the HUD. */
	get label(): string {
		return this.#profile?.name ?? "Voicebox";
	}

	/**
	 * Verify the server answers and resolve the profile to speak with. Called
	 * at `/tts` activation, so a dead server is reported before any text is
	 * queued rather than as a stream of failed blocks.
	 */
	async ensureReady(signal?: AbortSignal): Promise<VoiceboxProfile> {
		if (this.#profile) return this.#profile;
		const profiles = await this.#json<VoiceboxProfile[]>("/profiles", signal);
		this.#profile = this.#pickProfile(profiles);
		return this.#profile;
	}

	/**
	 * Synthesize one block. Resolves with the WAV, or throws with a message
	 * meant to be shown: a silent fallback to another voice is exactly what the
	 * plan forbids.
	 */
	async synthesize(text: string, signal?: AbortSignal): Promise<VoiceboxAudio> {
		const profile = await this.ensureReady(signal);
		const engine = profile.default_engine ?? profile.preset_engine ?? undefined;
		const created = await this.#json<{ id: string }>("/generate", signal, {
			profile_id: profile.id,
			text,
			...(engine ? { engine } : {}),
			...(profile.language ? { language: profile.language } : {}),
		});
		const record = await this.#awaitCompletion(created.id, signal);
		const wav = await this.#bytes(`/audio/${created.id}`, signal);
		return { wav, durationSeconds: record.duration ?? 0 };
	}

	/**
	 * Pick the profile: the requested `preset_voice_id` first, then any preset
	 * profile of the requested language. A profile of a different language is
	 * never acceptable — reading Italian with an English voice is the failure
	 * this whole engine exists to avoid.
	 */
	#pickProfile(profiles: VoiceboxProfile[]): VoiceboxProfile {
		if (this.#voiceId) {
			const exact = profiles.find(p => p.preset_voice_id === this.#voiceId);
			if (exact) return exact;
		}
		if (this.#language) {
			const sameLanguage = profiles.find(p => p.language === this.#language && p.voice_type === "preset");
			if (sameLanguage) return sameLanguage;
			throw new VoiceboxVoiceError(
				`Voicebox non ha un profilo preset per la lingua "${this.#language}"` +
					(this.#voiceId ? ` né la voce "${this.#voiceId}"` : "") +
					`. Profili disponibili: ${profiles.map(p => `${p.name} (${p.language ?? "?"})`).join(", ")}.`,
			);
		}
		const first = profiles.find(p => p.voice_type === "preset");
		if (!first) throw new VoiceboxVoiceError("Voicebox non espone nessun profilo preset.");
		return first;
	}

	/** Poll until the job settles. The server has no push channel. */
	async #awaitCompletion(id: string, signal?: AbortSignal): Promise<VoiceboxGeneration> {
		const deadline = Date.now() + GENERATE_TIMEOUT_MS;
		let last = "?";
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new Error("sintesi annullata");
			const record = await this.#json<VoiceboxGeneration>(`/history/${id}`, signal);
			last = record.status;
			if (last === "completed") return record;
			if (last === "failed" || last === "error" || last === "cancelled") {
				throw new Error(record.error ?? `generazione ${last}`);
			}
			await this.#wait(POLL_INTERVAL_MS, signal);
		}
		throw new Error(`generazione ancora "${last}" dopo ${GENERATE_TIMEOUT_MS / 1000}s`);
	}

	/** Sleep that honours the abort signal, so a clear() does not wait it out. */
	#wait(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			timer.unref?.();
			const onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async #json<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
		const response = await this.#call(path, signal, body);
		return (await response.json()) as T;
	}

	async #bytes(path: string, signal?: AbortSignal): Promise<Uint8Array> {
		const response = await this.#call(path, signal);
		return new Uint8Array(await response.arrayBuffer());
	}

	async #call(path: string, signal?: AbortSignal, body?: unknown): Promise<Response> {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await this.#fetch(`${this.#baseUrl}${path}`, {
				method: body === undefined ? "GET" : "POST",
				signal: merged,
				...(body === undefined
					? {}
					: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
			});
		} catch (error) {
			if (signal?.aborted) throw new Error("sintesi annullata");
			throw new VoiceboxUnavailableError(error instanceof Error ? error.message : String(error));
		}
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`Voicebox ${response.status} su ${path}: ${detail.slice(0, 200)}`);
		}
		return response;
	}
}
