import { describe, expect, test } from "bun:test";
import { VoiceboxEngine, VoiceboxUnavailableError, VoiceboxVoiceError } from "./voicebox-engine";

/** Profiles shaped exactly like the ones `/profiles` returns on this machine. */
const PROFILES = [
	{
		id: "sara-id",
		name: "Sara IT",
		language: "it",
		voice_type: "preset",
		preset_engine: "kokoro",
		preset_voice_id: "if_sara",
		default_engine: "kokoro",
	},
	{
		id: "adam-id",
		name: "Adam EN",
		language: "en",
		voice_type: "preset",
		preset_engine: "kokoro",
		preset_voice_id: "am_adam",
		default_engine: "kokoro",
	},
	{
		id: "mine-id",
		name: "myVoice",
		language: "it",
		voice_type: "cloned",
		preset_engine: null,
		preset_voice_id: null,
		default_engine: "qwen",
	},
];

interface Recorded {
	path: string;
	body: unknown;
}

/**
 * Stands in for the Voicebox server. `statuses` is the sequence `/history`
 * reports, so a test can make the job take several polls, the way the real one
 * does — never settling instantly.
 */
function makeServer(options: { profiles?: unknown[]; statuses?: string[]; failGenerate?: number } = {}) {
	const calls: Recorded[] = [];
	let polled = 0;
	const statuses = options.statuses ?? ["completed"];
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const json = (value: unknown, status = 200) =>
			new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
		if (path === "/profiles") return json(options.profiles ?? PROFILES);
		if (path === "/generate") {
			if (options.failGenerate) return new Response("engine rifiutato", { status: options.failGenerate });
			return json({ id: "gen-1" });
		}
		if (path.startsWith("/history/")) {
			const status = statuses[Math.min(polled, statuses.length - 1)] ?? "completed";
			polled += 1;
			return json({ id: "gen-1", status, duration: status === "completed" ? 4.6 : null, error: null });
		}
		if (path.startsWith("/audio/")) return new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]));
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls, polls: () => polled };
}

describe("VoiceboxEngine", () => {
	test("resolves the profile by preset_voice_id and reuses it", async () => {
		const server = makeServer();
		const engine = new VoiceboxEngine({ voiceId: "if_sara", language: "it", fetchImpl: server.fetchImpl });
		const profile = await engine.ensureReady();
		expect(profile.name).toBe("Sara IT");
		expect(engine.label).toBe("Sara IT");

		// The voice is a user-visible identity: it is resolved once, not per block.
		await engine.ensureReady();
		expect(server.calls.filter(c => c.path === "/profiles").length).toBe(1);
	});

	test("synthesizes a block and returns the WAV with the reported duration", async () => {
		const server = makeServer({ statuses: ["processing", "processing", "completed"] });
		const engine = new VoiceboxEngine({ voiceId: "if_sara", language: "it", fetchImpl: server.fetchImpl });
		const audio = await engine.synthesize("Un blocco italiano.");

		expect(audio.durationSeconds).toBe(4.6);
		expect(Array.from(audio.wav.slice(0, 4))).toEqual([82, 73, 70, 70]); // "RIFF"
		// It really waited instead of taking the first answer.
		expect(server.polls()).toBe(3);

		const generate = server.calls.find(c => c.path === "/generate");
		expect(generate?.body).toEqual({
			profile_id: "sara-id",
			text: "Un blocco italiano.",
			engine: "kokoro",
			language: "it",
		});
	});

	test("falls back to a preset profile of the same language, never another one", async () => {
		const server = makeServer();
		const engine = new VoiceboxEngine({ voiceId: "if_missing", language: "it", fetchImpl: server.fetchImpl });
		const profile = await engine.ensureReady();
		// Sara is the preset Italian one; the cloned Italian profile is not a preset,
		// and the English profile must never be chosen for Italian text.
		expect(profile.name).toBe("Sara IT");
		expect(profile.language).toBe("it");
	});

	test("refuses to speak when no profile of the language exists", async () => {
		const server = makeServer({ profiles: [PROFILES[1]] }); // only English
		const engine = new VoiceboxEngine({ voiceId: "if_sara", language: "it", fetchImpl: server.fetchImpl });
		await expect(engine.ensureReady()).rejects.toBeInstanceOf(VoiceboxVoiceError);
		// The message must name what is missing and what there is.
		await engine.ensureReady().catch((error: Error) => {
			expect(error.message).toContain("it");
			expect(error.message).toContain("Adam EN");
		});
	});

	test("a dead server raises a message telling the user what to do", async () => {
		const fetchImpl = (async () => {
			throw new Error("connection refused");
		}) as unknown as typeof fetch;
		const engine = new VoiceboxEngine({ voiceId: "if_sara", language: "it", fetchImpl });
		await expect(engine.ensureReady()).rejects.toBeInstanceOf(VoiceboxUnavailableError);
		await engine.ensureReady().catch((error: Error) => {
			expect(error.message).toContain("Voicebox.app");
		});
	});

	test("an HTTP error surfaces the status and the server's explanation", async () => {
		const server = makeServer({ failGenerate: 400 });
		const engine = new VoiceboxEngine({ voiceId: "if_sara", language: "it", fetchImpl: server.fetchImpl });
		await expect(engine.synthesize("testo")).rejects.toThrow(/400.*engine rifiutato/s);
	});

	test("a failed generation reports the server's error instead of hanging", async () => {
		const server = makeServer({ statuses: ["processing", "failed"] });
		const engine = new VoiceboxEngine({ voiceId: "if_sara", language: "it", fetchImpl: server.fetchImpl });
		await expect(engine.synthesize("testo")).rejects.toThrow(/failed/);
	});
});
