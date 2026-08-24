import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../config/keybindings";
import { type PlaybackProcess, SpeechPlaybackQueue, type SpeechPlaybackSnapshot } from "../../tts/playback-queue";
import { initTheme, theme } from "../theme/theme";
import { formatClock, TtsChaptersOverlay, TtsHudComponent } from "./tts-player";

/** The widths the plan pins the HUD's three shapes to. */
const WIDTHS = [32, 40, 60, 120];

class FakeProcess implements PlaybackProcess {
	pid = 1;
	signals: (string | number)[] = [];
	exited = new Promise<number>(() => {});
	kill(signal?: string | number): void {
		this.signals.push(signal ?? "SIGTERM");
	}
}

async function makeQueue(options: { autoplay?: boolean } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "omp-tts-hud-"));
	const procs: FakeProcess[] = [];
	const queue = new SpeechPlaybackQueue(
		{
			cwd: dir,
			sessionId: "sess-hud",
			autoplay: options.autoplay ?? false,
			spawnPlayback: () => {
				const proc = new FakeProcess();
				procs.push(proc);
				return proc;
			},
			synthesizeBlock: async () => ({ kind: "pcm" as const, pcm: new Float32Array(24_000), sampleRate: 24_000 }),
		},
		() => {},
	);
	return { queue, procs };
}

const pcm = () => new Float32Array(24_000).fill(0.01);

/** Strip SGR sequences so assertions read the visible text. Built at runtime:
 * a literal ESC inside a regex is rejected by the linter. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (text: string) => text.replace(ANSI, "");

/** Indexed access that fails the test instead of asserting non-null. */
function nth<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`expected an item at index ${index}`);
	return item;
}

async function seed(queue: SpeechPlaybackQueue, blocks: string[]): Promise<void> {
	queue.beginResponse("r1");
	for (const text of blocks) queue.enqueue("r1", text);
	await queue.acceptAudio("r1:0", pcm(), 24_000);
}

describe("TtsHudComponent", () => {
	beforeAll(async () => {
		await initTheme();
	});

	test("never wraps and never exceeds the width it is given", async () => {
		const { queue } = await makeQueue();
		await seed(queue, [
			"Un blocco con un testo abbastanza lungo da dover essere troncato in un terminale stretto.",
			"Secondo blocco.",
		]);
		const hud = new TtsHudComponent(queue.snapshot(), theme);
		for (const width of WIDTHS) {
			const lines = hud.render(width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).not.toContain("\n");
			}
		}
	});

	test("collapses to one line under 40 columns and keeps two above", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Blocco."]);
		const hud = new TtsHudComponent(queue.snapshot(), theme);
		expect(hud.render(32).length).toBe(1);
		expect(hud.render(40).length).toBe(2);
		expect(hud.render(60).length).toBe(2);
		expect(hud.render(120).length).toBe(2);
	});

	test("shows the transport state, the counters and the speed", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Primo.", "Secondo."]);
		await queue.togglePlayPause();
		queue.stepSpeed(0.1);
		const hud = new TtsHudComponent(queue.snapshot(), theme);
		const wide = hud.render(120).join(" ");
		expect(wide).toContain("playing");
		expect(wide).toContain("1/2");
		expect(wide).toContain("1.1×");
		expect(wide).toContain("Sara IT");
	});

	test("warm-up and error states replace the transport segment", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Blocco."]);
		queue.setWarmProgress(0.5, true);
		const hud = new TtsHudComponent(queue.snapshot(), theme);
		expect(hud.render(120).join(" ")).toContain("warm-up 50%");

		queue.setWarmProgress(undefined, false);
		hud.update(queue.snapshot());
		expect(hud.render(120).join(" ")).not.toContain("warm-up");
	});

	test("formatClock renders mm:ss", () => {
		expect(formatClock(0)).toBe("0:00");
		expect(formatClock(9_000)).toBe("0:09");
		expect(formatClock(75_000)).toBe("1:15");
	});
});

describe("TtsChaptersOverlay", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const GLOBAL_KEYS = {
		playPause: ["alt+t"],
		stop: ["alt+s"],
		previous: ["alt+,"],
		next: ["alt+."],
		speedDown: ["alt+-"],
		speedUp: ["alt+="],
		overlay: ["alt+h"],
		autoplay: ["alt+shift+a"],
	};

	/**
	 * Terminal height is injected in every test: reading `process.stdout.rows`
	 * would make the windowing depend on whoever runs the suite.
	 */
	const TALL = 200;

	function makeOverlay(queue: SpeechPlaybackQueue, options: { globalKeys?: typeof GLOBAL_KEYS; rows?: number } = {}) {
		let closed = 0;
		let renders = 0;
		const overlay = new TtsChaptersOverlay({
			queue,
			theme,
			keybindings: KeybindingsManager.inMemory(),
			close: () => {
				closed += 1;
			},
			requestRender: () => {
				renders += 1;
			},
			globalKeys: options.globalKeys ?? GLOBAL_KEYS,
			terminalRows: () => options.rows ?? TALL,
		});
		return { overlay, closed: () => closed, renders: () => renders };
	}

	test("paints an opaque framed panel: every row fills the full width", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Corto.", "Un blocco molto piu' lungo del precedente, per avere righe disuguali."]);
		const { overlay } = makeOverlay(queue);
		for (const width of WIDTHS) {
			const lines = overlay.render(width);
			// An overlay paints over the transcript: a row shorter than the panel
			// would let the text underneath show through.
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(width);
			}
			// Framed top and bottom, so it reads as a panel and not as loose text.
			expect(lines.length).toBeGreaterThan(2);
			expect(visibleWidth(nth(lines, 0))).toBe(width);
			expect(visibleWidth(nth(lines, lines.length - 1))).toBe(width);
		}
		overlay.dispose();
	});

	test("lists every block with its state glyph, inside the given width", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Primo blocco.", "Secondo blocco.", "Terzo blocco."]);
		const { overlay } = makeOverlay(queue);
		for (const width of WIDTHS) {
			for (const line of overlay.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		const rendered = overlay.render(120).join("\n");
		expect(rendered).toContain("Primo blocco.");
		expect(rendered).toContain("Terzo blocco.");
		expect(rendered).toContain("●"); // ready
		expect(rendered).toContain("○"); // queued
		overlay.dispose();
	});

	test("wraps long lines instead of cutting them, and keeps the panel opaque", async () => {
		const verso = "Stasera al buio sarò solo con le stelle e il silenzio è pieno di parole che ho già detto a te.";
		const { queue } = await makeQueue();
		await seed(queue, [verso, "Corto."]);
		const { overlay } = makeOverlay(queue);

		for (const width of [40, 60, 120]) {
			const lines = overlay.render(width);
			const flat = plain(lines.join("\n"));
			// Every word of the sentence survives somewhere in the panel.
			for (const word of verso.split(" ")) {
				expect(flat).toContain(word);
			}
			// Still opaque, still inside the frame.
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
		}
		overlay.dispose();
	});

	test("the controls list is never cut mid-word", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Blocco."]);
		const { overlay } = makeOverlay(queue);
		for (const width of [40, 60, 120]) {
			const flat = plain(overlay.render(width).join("\n"));
			// Nothing elided, and every control still named — the line may wrap
			// across rows, which is the point.
			expect(flat).not.toContain("…");
			for (const token of ["Space", "Enter", "velocità", "stop", "Esc", "chiude"]) {
				expect(flat).toContain(token);
			}
		}
		overlay.dispose();
	});

	test("h opens the help view, which explains and lists both key sets", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Blocco."]);
		const { overlay } = makeOverlay(queue);

		overlay.handleInput("h");
		const flat = plain(overlay.render(80).join("\n"));
		// What the player does, in words.
		expect(flat).toContain("capitolo");
		expect(flat).toContain("autoplay");
		// In-panel keys.
		for (const key of ["Space", "Enter", "n p", "+ -", "Esc"]) expect(flat).toContain(key);
		// And the real global bindings the controller passed in.
		for (const key of ["alt+t", "alt+.", "alt+shift+a", "alt+h"]) expect(flat).toContain(key);
		// Plus the slash-command route.
		expect(flat).toContain("/tts");
		overlay.dispose();
	});

	test("the help view shows the user's own bindings, not the defaults", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Blocco."]);
		const { overlay } = makeOverlay(queue, { globalKeys: { ...GLOBAL_KEYS, playPause: ["ctrl+j"], autoplay: [] } });
		overlay.handleInput("h");
		const flat = plain(overlay.render(80).join("\n"));
		expect(flat).toContain("ctrl+j");
		expect(flat).not.toContain("alt+t");
		// An action with no binding is simply not listed.
		expect(flat).not.toContain("alt+shift+a");
		overlay.dispose();
	});

	test("escape in the help view pops back to the list, it does not close", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Un blocco riconoscibile."]);
		const { overlay, closed } = makeOverlay(queue);

		overlay.handleInput("h");
		expect(plain(overlay.render(80).join("\n"))).toContain("aiuto");

		// This is the multi-view escape-ordering trap: it must pop one level.
		overlay.handleInput("\x1b");
		expect(closed()).toBe(0);
		expect(plain(overlay.render(80).join("\n"))).toContain("Un blocco riconoscibile.");

		// A second escape, now at the top level, closes.
		overlay.handleInput("\x1b");
		expect(closed()).toBe(1);
		overlay.dispose();
	});

	test("h toggles the help view off as well", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Blocco."]);
		const { overlay, closed } = makeOverlay(queue);
		overlay.handleInput("h");
		overlay.handleInput("h");
		expect(closed()).toBe(0);
		expect(plain(overlay.render(80).join("\n"))).toContain("Capitoli");
		overlay.dispose();
	});

	test("transport keys do nothing while the help view is open", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Blocco."]);
		const { overlay } = makeOverlay(queue);
		overlay.handleInput("h");
		const before = queue.snapshot();

		for (const key of [" ", "s", "+", "-", "a", "n", "p"]) overlay.handleInput(key);
		await Promise.resolve();
		const after = queue.snapshot();
		expect(after.state).toBe(before.state);
		expect(after.speed).toBe(before.speed);
		expect(after.autoplay).toBe(before.autoplay);
		overlay.dispose();
	});

	test("the help view is opaque and framed at every width", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Blocco."]);
		const { overlay } = makeOverlay(queue);
		overlay.handleInput("h");
		for (const width of WIDTHS) {
			const lines = overlay.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
		}
		overlay.dispose();
	});

	test("windows a long list and says how many rows are out of view", async () => {
		const { queue } = await makeQueue();
		queue.beginResponse("r1");
		for (let i = 0; i < 30; i += 1) queue.enqueue("r1", `Blocco numero ${i}.`);
		await queue.acceptAudio("r1:0", pcm(), 24_000);
		// A short terminal, so the list cannot fit and must window.
		const { overlay } = makeOverlay(queue, { rows: 20 });
		await queue.selectBlock(20);
		const rendered = plain(overlay.render(120).join("\n"));
		expect(rendered).toContain("righe sopra");
		expect(rendered).toContain("sotto");
		// Singular is not "1 righe".
		expect(rendered).not.toContain("1 righe");
		// The selection is kept in view: that is the point of the anchor.
		expect(rendered).toContain("Blocco numero 20.");
		overlay.dispose();
	});

	test("the body never exceeds what the terminal can show", async () => {
		const { queue } = await makeQueue();
		queue.beginResponse("r1");
		for (let i = 0; i < 40; i += 1) queue.enqueue("r1", `Un blocco piuttosto lungo, il numero ${i}, che va a capo.`);
		await queue.acceptAudio("r1:0", pcm(), 24_000);
		for (const rows of [12, 20, 40]) {
			const { overlay } = makeOverlay(queue, { rows });
			const painted = overlay.render(60).length;
			// Whatever the content, the panel fits inside the host's clamp.
			expect(painted).toBeLessThanOrEqual(Math.floor(rows * 0.8) - 2);
			overlay.dispose();
		}
	});

	test("the help view scrolls instead of hiding its tail", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Blocco."]);
		const { overlay } = makeOverlay(queue, { rows: 16 });
		overlay.handleInput("h");

		const top = plain(overlay.render(70).join("\n"));
		expect(top).toContain("La risposta viene divisa");
		expect(top).toContain("righe sotto");
		// The global-keys section is past the fold at this height.
		expect(top).not.toContain("alt+shift+a");
		expect(top).toContain("↑↓ scorre");

		// Scrolling down reaches it: keep paging until it shows, bounded.
		let found = false;
		for (let i = 0; i < 40 && !found; i += 1) {
			overlay.handleInput("\x1b[B");
			found = plain(overlay.render(70).join("\n")).includes("alt+shift+a");
		}
		expect(found).toBe(true);
		expect(plain(overlay.render(70).join("\n"))).toContain("righe sopra");

		// And arrows scroll back up one row at a time.
		for (let i = 0; i < 40; i += 1) overlay.handleInput("\x1b[A");
		expect(plain(overlay.render(70).join("\n"))).toContain("La risposta viene divisa");
		overlay.dispose();
	});

	test("leaving the help view resets its scroll", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Blocco."]);
		const { overlay } = makeOverlay(queue, { rows: 16 });
		overlay.handleInput("h");
		for (let i = 0; i < 4; i += 1) overlay.handleInput("\x1b[6~");
		expect(plain(overlay.render(70).join("\n"))).toContain("righe sopra");

		overlay.handleInput("h");
		overlay.handleInput("h");
		// Reopened at the top, not where it was left.
		expect(plain(overlay.render(70).join("\n"))).toContain("La risposta viene divisa");
		overlay.dispose();
	});

	test("page keys scroll the list without moving the selection", async () => {
		const { queue } = await makeQueue();
		queue.beginResponse("r1");
		for (let i = 0; i < 40; i += 1) queue.enqueue("r1", `Blocco ${i}.`);
		await queue.acceptAudio("r1:0", pcm(), 24_000);
		const { overlay } = makeOverlay(queue, { rows: 16 });
		const selectedBefore = queue.snapshot().selectedBlockIndex;

		overlay.handleInput("\x1b[6~");
		expect(queue.snapshot().selectedBlockIndex).toBe(selectedBefore);
		overlay.dispose();
	});

	test("escape closes only the overlay and touches no playback", async () => {
		const { queue, procs } = await makeQueue();
		await seed(queue, ["Blocco."]);
		await queue.togglePlayPause();
		const { overlay, closed } = makeOverlay(queue);

		overlay.handleInput("\x1b");
		expect(closed()).toBe(1);
		// The transport is untouched: still playing, no signal sent.
		expect(queue.snapshot().state).toBe("playing");
		expect(procs[0]?.signals ?? []).toEqual([]);
		overlay.dispose();
	});

	test("space toggles, s stops and +/- step the speed", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Blocco."]);
		const { overlay } = makeOverlay(queue);

		overlay.handleInput(" ");
		await Promise.resolve();
		expect(queue.snapshot().state).toBe("playing");

		overlay.handleInput("+");
		expect(queue.snapshot().speed).toBe(1.1);
		overlay.handleInput("-");
		overlay.handleInput("-");
		expect(queue.snapshot().speed).toBe(0.9);

		overlay.handleInput("s");
		expect(queue.snapshot().state).toBe("idle");
		overlay.dispose();
	});

	test("arrows move the cursor, left/right walk the response history", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Uno.", "Due."]);
		queue.beginResponse("r2");
		queue.enqueue("r2", "Nuova risposta.");
		const { overlay } = makeOverlay(queue);

		// The newest response is at index 0; left goes towards the older ones.
		expect(queue.snapshot().selectedResponseIndex).toBe(0);
		overlay.handleInput("\x1b[D");
		expect(queue.snapshot().selectedResponseIndex).toBe(1);
		overlay.handleInput("\x1b[C");
		expect(queue.snapshot().selectedResponseIndex).toBe(0);

		// Both the CSI and SS3 arrow forms must land: Herdr sends the classic ones.
		overlay.handleInput("\x1bOD");
		expect(queue.snapshot().selectedResponseIndex).toBe(1);
		overlay.handleInput("\x1b[B");
		await Promise.resolve();
		expect(queue.snapshot().selectedBlockIndex).toBe(1);
		overlay.dispose();
	});

	test("the overlay follows the queue without polling", async () => {
		const { queue } = await makeQueue();
		await seed(queue, ["Uno."]);
		let renders = 0;
		const overlay = new TtsChaptersOverlay({
			queue,
			theme,
			keybindings: KeybindingsManager.inMemory(),
			close: () => {},
			requestRender: () => {
				renders += 1;
			},
		});
		queue.enqueue("r1", "Due.");
		expect(renders).toBeGreaterThan(0);
		expect(overlay.render(120).join("\n")).toContain("Due.");

		// Disposing unsubscribes: no further renders are requested.
		overlay.dispose();
		const before = renders;
		queue.enqueue("r1", "Tre.");
		expect(renders).toBe(before);
	});
});

/** The snapshot type is part of the components' contract; keep it referenced. */
export type _SnapshotContract = SpeechPlaybackSnapshot;
