import { describe, expect, test } from "bun:test";
import { DEFAULT_TTS_VOICE, KOKORO_VOICES, resolveTtsVoice, TTS_LOCAL_VOICE_VALUES } from "./models";

describe("Kokoro voice catalog", () => {
	/**
	 * The native catalog must list only what kokoro-js can actually speak.
	 * kokoro-js 1.2.1 (the latest release) refuses every non-English voice with
	 * `Voice "…" not found` — the `.bin` files ship but the g2p for those
	 * languages is not implemented. A non-English id here would be a voice that
	 * fails on every single synthesis; the Italian voice lives on the Voicebox
	 * engine instead.
	 */
	test("lists only voices the native runtime accepts (English)", () => {
		for (const voice of KOKORO_VOICES) {
			expect(voice.id).toMatch(/^[ab][fm]_/);
		}
		expect(KOKORO_VOICES.some(v => v.id === "if_sara")).toBe(false);
	});

	test("the default is an English voice the runtime can load", () => {
		expect(DEFAULT_TTS_VOICE).toBe("af_heart");
		expect(TTS_LOCAL_VOICE_VALUES).toContain(DEFAULT_TTS_VOICE);
	});

	test("resolveTtsVoice validates against the catalog without silent fallback", () => {
		expect(resolveTtsVoice("kokoro", "af_heart")).toBe("af_heart");
		expect(resolveTtsVoice("kokoro", "bm_george")).toBe("bm_george");
		// An id outside the catalog — including the Italian one, which the native
		// runtime cannot load — resolves to the default rather than being passed
		// through to a synthesis that would fail.
		expect(resolveTtsVoice("kokoro", "if_sara")).toBe(DEFAULT_TTS_VOICE);
		expect(resolveTtsVoice("kokoro", "zz_unknown")).toBe(DEFAULT_TTS_VOICE);
		expect(resolveTtsVoice("kokoro", undefined)).toBe(DEFAULT_TTS_VOICE);
	});

	test("voice id list feeds the settings picker", () => {
		expect(TTS_LOCAL_VOICE_VALUES.length).toBe(KOKORO_VOICES.length);
		expect(TTS_LOCAL_VOICE_VALUES[0]).toBe(KOKORO_VOICES[0]?.id);
	});
});
