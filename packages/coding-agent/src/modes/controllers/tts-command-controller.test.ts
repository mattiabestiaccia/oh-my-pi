import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../config/keybindings";
import { Settings } from "../../config/settings";
import { vocalizer } from "../../tts/vocalizer";
import { initTheme, theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { TtsCommandController } from "./tts-command-controller";

/**
 * Minimal stand-in for the interactive context: only the surfaces the
 * controller actually touches. This suite exists because the controller was
 * previously created only by the real TUI, so a plain `ReferenceError` in
 * `initializeFromSettings` reached a live session instead of a test.
 */
/** Assistant/user turns as `agent.state.messages` holds them. */
function transcript(...turns: Array<{ role: string; text: string }>) {
	return turns.map(t => ({ role: t.role, content: [{ type: "text", text: t.text }] }));
}

function makeContext(options: { speechEnabled?: boolean; cwd: string; messages?: unknown[]; overlayFails?: boolean }) {
	const renders = { count: 0 };
	const keyHandlers = new Map<string, () => void>();
	const ttsContainer = new Container();
	const overlay: { built: number; component: { render(width: number): readonly string[]; dispose?(): void } | null } =
		{
			built: 0,
			component: null,
		};
	const warnings: string[] = [];
	const ctx = {
		ui: {
			requestRender: () => {
				renders.count += 1;
			},
		},
		ttsContainer,
		editor: {
			setCustomKeyHandler: (key: string, handler: () => void) => keyHandlers.set(key, handler),
			removeCustomKeyHandler: (key: string) => keyHandlers.delete(key),
		},
		session: {
			ttsEnabled: false,
			messages: options.messages ?? [],
			setTtsModeEnabled(enabled: boolean) {
				this.ttsEnabled = enabled;
			},
		},
		sessionManager: {
			getCwd: () => options.cwd,
			getSessionFile: () => join(options.cwd, "2026-08-22T00-00-00_abc.jsonl"),
		},
		keybindings: KeybindingsManager.inMemory(),
		settings: { get: (key: string) => (key === "speech.enabled" ? (options.speechEnabled ?? false) : undefined) },
		// Invokes the factory, the way the real host does. A double that only
		// returns let a broken overlay ship: the controller swallows factory
		// errors into a debug log, so nothing else would have caught it.
		showHookCustom: async (factory: unknown) => {
			const build = factory as (
				tui: unknown,
				theme: unknown,
				keybindings: KeybindingsManager,
				done: (value: undefined) => void,
			) => { render(width: number): readonly string[]; dispose?(): void };
			overlay.component = build({}, theme, KeybindingsManager.inMemory(), () => {});
			overlay.built += 1;
			if (options.overlayFails) throw new Error("host esploso");
			return undefined;
		},
		showWarning: (message: string) => warnings.push(message),
	};
	return {
		ctx: ctx as unknown as InteractiveModeContext,
		renders,
		keyHandlers,
		ttsContainer,
		raw: ctx,
		overlay,
		warnings,
	};
}

async function makeController(options: { speechEnabled?: boolean; messages?: unknown[]; overlayFails?: boolean } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "omp-tts-ctrl-"));
	const harness = makeContext({ ...options, cwd });
	return { ...harness, controller: new TtsCommandController(harness.ctx), cwd };
}

describe("TtsCommandController", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	test("initializeFromSettings stays off when speech.enabled is false", async () => {
		const { controller } = await makeController({ speechEnabled: false });
		await controller.initializeFromSettings();
		expect(controller.active).toBe(false);
		expect(controller.queue).toBeNull();
	});

	test("initializeFromSettings brings the player up when speech.enabled is true", async () => {
		const { controller, raw, ttsContainer, keyHandlers } = await makeController({ speechEnabled: true });
		await controller.initializeFromSettings();
		expect(controller.active).toBe(true);
		// The HUD is mounted, the shortcuts installed, the prompt turned on.
		expect(ttsContainer.children.length).toBe(1);
		expect(keyHandlers.size).toBeGreaterThan(0);
		expect(raw.session.ttsEnabled).toBe(true);
		await controller.dispose();
	});

	test("enable installs every shortcut and disable removes them all", async () => {
		const { controller, keyHandlers } = await makeController();
		await controller.enable();
		// Installed by enable(), with no dependency on the overlay being open:
		// the HUD alone gives you the whole transport.
		expect(Array.from(keyHandlers.keys()).sort()).toEqual([
			"alt+,",
			"alt+-",
			"alt+.",
			"alt+=",
			"alt+h",
			"alt+s",
			"alt+shift+a",
			"alt+t",
		]);

		await controller.disable();
		expect(keyHandlers.size).toBe(0);
		expect(controller.active).toBe(false);
	});

	test("/tts autoplay toggles, takes on|off, and refuses anything else", async () => {
		const { controller } = await makeController();
		await controller.enable();
		// The player starts with autoplay on.
		expect(controller.queue?.autoplay).toBe(true);

		expect((await controller.handleCommand("autoplay")).message).toContain("spento");
		expect(controller.queue?.autoplay).toBe(false);

		expect((await controller.handleCommand("autoplay")).message).toContain("attivo");
		expect(controller.queue?.autoplay).toBe(true);

		await controller.handleCommand("autoplay off");
		expect(controller.queue?.autoplay).toBe(false);
		// Idempotent: `off` twice leaves it off.
		await controller.handleCommand("autoplay off");
		expect(controller.queue?.autoplay).toBe(false);

		await controller.handleCommand("autoplay on");
		expect(controller.queue?.autoplay).toBe(true);

		expect((await controller.handleCommand("autoplay maybe")).message).toContain("non valido");
		expect(controller.queue?.autoplay).toBe(true);
		await controller.dispose();
	});

	test("the autoplay shortcut flips it, and status reports it when off", async () => {
		const { controller, keyHandlers } = await makeController();
		await controller.enable();
		const toggle = keyHandlers.get("alt+shift+a");
		if (!toggle) throw new Error("expected the autoplay shortcut to be installed");

		toggle();
		expect(controller.queue?.autoplay).toBe(false);
		expect((await controller.handleCommand("status")).message).toContain("autoplay off");

		toggle();
		expect(controller.queue?.autoplay).toBe(true);
		expect((await controller.handleCommand("status")).message).not.toContain("autoplay off");
		await controller.dispose();
	});

	test("autoplay off while the player is off is reported, not silently ignored", async () => {
		const { controller } = await makeController();
		expect((await controller.handleCommand("autoplay off")).message).toContain("spento");
	});

	test("disable unmounts the HUD, drops the prompt and detaches the queue", async () => {
		const { controller, raw, ttsContainer } = await makeController();
		await controller.enable();
		expect(raw.session.ttsEnabled).toBe(true);
		expect(vocalizer.isRuntimeEnabled()).toBe(true);

		await controller.disable();
		expect(ttsContainer.children.length).toBe(0);
		expect(raw.session.ttsEnabled).toBe(false);
		expect(vocalizer.isRuntimeEnabled()).toBe(false);
	});

	test("/tts on enables without the overlay, /tts off reports the cache is kept", async () => {
		const { controller } = await makeController();
		const on = await controller.handleCommand("on");
		// Reports the state it just entered, rather than a generic confirmation.
		expect(on.message).toContain("TTS");
		expect(controller.active).toBe(true);

		const off = await controller.handleCommand("off");
		expect(off.message).toContain("cache");
		expect(controller.active).toBe(false);
	});

	test("/tts status answers whether the player is off or on", async () => {
		const { controller } = await makeController();
		expect((await controller.handleCommand("status")).message).toContain("spento");
		await controller.enable();
		expect((await controller.handleCommand("status")).message).toContain("TTS");
		await controller.dispose();
	});

	test("/tts speed validates the range and reaches the requested rate", async () => {
		const { controller } = await makeController();
		await controller.enable();
		expect((await controller.handleCommand("speed 1.5")).message).toContain("1.5×");
		expect(controller.queue?.snapshot().speed).toBe(1.5);
		// Out of range and non-numeric are refused without changing the rate.
		expect((await controller.handleCommand("speed 9")).message).toContain("fuori intervallo");
		expect((await controller.handleCommand("speed abc")).message).toContain("non valida");
		expect(controller.queue?.snapshot().speed).toBe(1.5);
		await controller.dispose();
	});

	test("an unknown subcommand is reported, not silently ignored", async () => {
		const { controller } = await makeController();
		const result = await controller.handleCommand("frobnicate");
		expect(result.message).toContain("sconosciuto");
	});

	test("with the player on, transport verbs stay silent: the HUD is the feedback", async () => {
		const { controller } = await makeController();
		await controller.enable();
		for (const verb of ["play", "pause", "stop", "next", "previous", "older", "newer"]) {
			expect((await controller.handleCommand(verb)).message).toBeUndefined();
		}
		// `/tts` itself is silent too: the overlay it opens is the feedback.
		expect((await controller.handleCommand("")).message).toBeUndefined();
		await controller.dispose();
	});

	test("transport subcommands are inert while the player is off", async () => {
		const { controller } = await makeController();
		for (const verb of ["play", "pause", "stop", "next", "previous", "older", "newer"]) {
			const result = await controller.handleCommand(verb);
			expect(result.message).toContain("spento");
		}
		expect(controller.active).toBe(false);
	});

	test("/tts builds an overlay that actually renders", async () => {
		const { controller, overlay } = await makeController();
		// `/tts` opens the overlay fire-and-forget, so let the microtasks run.
		await controller.handleCommand("");
		for (let i = 0; i < 8; i += 1) await Promise.resolve();
		// The factory ran and produced a component…
		expect(overlay.built).toBe(1);
		expect(overlay.component).not.toBeNull();
		// …and that component paints something at a realistic width.
		const lines = overlay.component?.render(80) ?? [];
		expect(lines.length).toBeGreaterThan(2);
		expect(lines.join("\n")).toContain("Capitoli");
		overlay.component?.dispose?.();
		await controller.dispose();
	});

	test("a failed overlay says so instead of doing nothing visible", async () => {
		const { controller, warnings } = await makeController({ overlayFails: true });
		await controller.enable();
		await controller.openOverlay();
		expect(warnings.join(" ")).toContain("Pannello TTS non aperto");
		expect(warnings.join(" ")).toContain("host esploso");
		// And the guard is released, so a later attempt is not blocked forever.
		await controller.openOverlay();
		expect(warnings.length).toBe(2);
		await controller.dispose();
	});

	test("enabling mid-session loads the replies already in the transcript", async () => {
		const { controller } = await makeController({
			messages: transcript(
				{ role: "user", text: "ciao" },
				{ role: "assistant", text: "Primo paragrafo della risposta.\n\nSecondo paragrafo.\n" },
				{ role: "user", text: "e poi?" },
				{ role: "assistant", text: "Una risposta successiva.\n" },
			),
		});
		await controller.enable();
		const snapshot = controller.queue?.snapshot();
		// Two assistant replies, newest first; user turns are not spoken history.
		expect(snapshot?.responses.length).toBe(2);
		const newest = snapshot?.responses[0];
		expect(newest?.blocks.length).toBe(1);
		expect(newest?.blocks[0]?.text).toContain("Una risposta successiva");
		const older = snapshot?.responses[1];
		expect(older?.blocks.length ?? 0).toBeGreaterThanOrEqual(2);
		await controller.dispose();
	});

	test("the seeded backlog is not synthesized until something is played", async () => {
		const { controller } = await makeController({
			messages: transcript({ role: "assistant", text: "Un paragrafo.\n\nUn altro.\n" }),
		});
		await controller.enable();
		const blocks = controller.queue?.snapshot().responses[0]?.blocks ?? [];
		expect(blocks.length).toBeGreaterThan(0);
		// Everything stays queued: activating the player must not render the
		// whole backlog through the engine.
		expect(blocks.every(b => b.state === "queued")).toBe(true);
		await controller.dispose();
	});

	test("an empty transcript seeds nothing and does not throw", async () => {
		const { controller } = await makeController({ messages: [] });
		await controller.enable();
		expect(controller.queue?.snapshot().responses.length).toBe(0);
		await controller.dispose();
	});

	test("enable is idempotent: a second call does not build a second queue", async () => {
		const { controller, ttsContainer } = await makeController();
		await controller.enable();
		const first = controller.queue;
		await controller.enable();
		expect(controller.queue).toBe(first);
		expect(ttsContainer.children.length).toBe(1);
		await controller.dispose();
	});
});
