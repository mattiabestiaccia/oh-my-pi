import { describe, expect, test } from "bun:test";
import { lutimes, mkdtemp, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	CACHE_TTL_MS,
	type PlaybackProcess,
	RESPONSE_CAP,
	SpeechPlaybackQueue,
	type SynthesizedBlock,
} from "./playback-queue";

/**
 * Fake afplay process. Records every signal and exposes a controlled `exited`
 * promise so a test decides *when* a block finishes — never a runner that
 * resolves immediately, which is what made the Pi controls untestable.
 * Mirrors the shape of the `Bun.spawn` result used in production.
 */
class FakeProcess implements PlaybackProcess {
	pid: number;
	signals: (string | number)[] = [];
	exitCode = 0;
	wavPath?: string;
	speed?: number;
	#resolveExit!: (code: number) => void;
	exited: Promise<number>;

	constructor(pid: number) {
		this.pid = pid;
		this.exited = new Promise<number>(resolve => {
			this.#resolveExit = resolve;
		});
	}

	kill(signal?: string | number): void {
		this.signals.push(signal ?? "SIGTERM");
	}

	/** Test-only: settle the process with its exit code. */
	finish(code = this.exitCode): void {
		this.#resolveExit(code);
	}
}

function makeTtsAudio(seconds: number) {
	const sampleRate = 24_000;
	return { pcm: new Float32Array(seconds * sampleRate).fill(0.01), sampleRate };
}

/** Indexed access that fails the test instead of asserting non-null. */
function nth<T>(items: T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`expected an item at index ${index}, got none`);
	return item;
}

interface Fixture {
	queue: SpeechPlaybackQueue;
	procs: FakeProcess[];
	logs: string[];
	dir: string;
}

async function makeFixture(
	options: {
		autoplay?: boolean;
		synthesize?: () => Promise<SynthesizedBlock | null>;
		/** When set, the queue drives synthesis itself with this engine. */
		engine?: (text: string) => Promise<SynthesizedBlock | null>;
	} = {},
): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "omp-tts-"));
	const logs: string[] = [];
	const procs: FakeProcess[] = [];
	let pid = 1000;
	const queue = new SpeechPlaybackQueue(
		{
			cwd: dir,
			sessionId: "sess-test",
			autoplay: options.autoplay ?? false,
			spawnPlayback: (wavPath, speed) => {
				const proc = new FakeProcess(pid++);
				proc.wavPath = wavPath;
				proc.speed = speed;
				procs.push(proc);
				return proc;
			},
			ownsSynthesis: options.engine !== undefined,
			synthesizeBlock:
				options.engine ?? options.synthesize ?? (async () => ({ kind: "pcm" as const, ...makeTtsAudio(1) })),
		},
		msg => {
			logs.push(msg);
		},
	);
	return { queue, procs, logs, dir };
}

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

/**
 * Wait until the queue reports the expected shape. Storing audio crosses a real
 * `writeFile`, so microtask flushing is not enough — and a timer would be
 * arbitrary synchronization. Subscribing resolves on the actual state change.
 */
function waitFor(
	queue: SpeechPlaybackQueue,
	predicate: (snapshot: ReturnType<SpeechPlaybackQueue["snapshot"]>) => boolean,
): Promise<void> {
	return new Promise<void>(resolve => {
		let unsubscribe: (() => void) | null = null;
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			unsubscribe?.();
			resolve();
		};
		unsubscribe = queue.subscribe(snapshot => {
			if (predicate(snapshot)) done();
		});
		if (predicate(queue.snapshot())) done();
	});
}

/** Settle the given fake process and let the completion path run. */
async function finish(proc: FakeProcess, code = 0): Promise<void> {
	proc.finish(code);
	await flush();
	await flush();
}

describe("SpeechPlaybackQueue transport with a controllable slow process", () => {
	test("play->pause->resume cycles SIGSTOP/SIGCONT and preserves the pointer", async () => {
		const { queue, procs } = await makeFixture();
		queue.beginResponse("r1");
		queue.enqueue("r1", "Primo blocco.");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await flush();

		// autoplay is off: audio arriving must not start anything by itself.
		expect(procs.length).toBe(0);
		expect(queue.snapshot().state).toBe("idle");

		await queue.togglePlayPause();
		await flush();
		expect(procs.length).toBe(1);
		const proc = nth(procs, 0);
		expect(proc.speed).toBe(1);
		expect(queue.snapshot().state).toBe("playing");
		expect(queue.snapshot().activeBlockId).toBe("r1:0");

		await queue.togglePlayPause();
		await flush();
		expect(proc.signals).toContain("SIGSTOP");
		expect(queue.snapshot().state).toBe("paused");
		expect(queue.snapshot().activeBlockId).toBe("r1:0");

		await queue.togglePlayPause();
		await flush();
		expect(proc.signals).toContain("SIGCONT");
		expect(queue.snapshot().state).toBe("playing");
		// resume reuses the same process: the position survives.
		expect(procs.length).toBe(1);
	});

	test("play->stop->play: stop goes idle (not paused) and a later play restarts", async () => {
		const { queue, procs } = await makeFixture();
		queue.beginResponse("r1");
		queue.enqueue("r1", "blocco uno");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await queue.togglePlayPause();
		await flush();
		expect(queue.snapshot().state).toBe("playing");

		queue.stop();
		expect(queue.snapshot().state).toBe("idle");
		expect(nth(procs, 0).signals).toContain("SIGTERM");

		await queue.togglePlayPause();
		await flush();
		expect(queue.snapshot().state).toBe("playing");
		expect(procs.length).toBe(2);
		expect(queue.snapshot().activeBlockId).toBe("r1:0");
	});

	test("double play during playback becomes a pause, then a third play resumes", async () => {
		const { queue, procs } = await makeFixture();
		queue.beginResponse("r1");
		queue.enqueue("r1", "x");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await queue.togglePlayPause();
		await flush();
		expect(queue.snapshot().state).toBe("playing");

		await queue.togglePlayPause();
		await flush();
		expect(queue.snapshot().state).toBe("paused");
		expect(nth(procs, 0).signals).toContain("SIGSTOP");

		await queue.togglePlayPause();
		await flush();
		expect(queue.snapshot().state).toBe("playing");
		expect(nth(procs, 0).signals).toContain("SIGCONT");
	});

	test("skip during playback kills the current process and starts the next", async () => {
		const { queue, procs } = await makeFixture({ autoplay: true });
		queue.beginResponse("r1");
		queue.enqueue("r1", "uno");
		queue.enqueue("r1", "due");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await queue.acceptAudio("r1:1", makeTtsAudio(1).pcm, 24_000);
		await flush();

		expect(queue.snapshot().activeBlockId).toBe("r1:0");
		expect(procs.length).toBe(1);

		await queue.selectBlock(1, { play: true });
		await flush();
		expect(nth(procs, 0).signals).toContain("SIGTERM");
		expect(queue.snapshot().activeBlockId).toBe("r1:1");
		expect(queue.snapshot().state).toBe("playing");
		expect(procs.length).toBe(2);
	});

	test("selecting a block whose audio has not landed waits, then starts on acceptAudio", async () => {
		const { queue, procs } = await makeFixture();
		queue.beginResponse("r1");
		queue.enqueue("r1", "uno");
		queue.enqueue("r1", "due");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);

		await queue.selectBlock(1, { play: true });
		await flush();
		expect(queue.snapshot().state).toBe("waiting");
		expect(queue.snapshot().activeBlockId).toBe("r1:1");
		expect(procs.length).toBe(0);

		await queue.acceptAudio("r1:1", makeTtsAudio(1).pcm, 24_000);
		await flush();
		expect(queue.snapshot().state).toBe("playing");
		expect(queue.snapshot().activeBlockId).toBe("r1:1");
		expect(procs.length).toBe(1);
	});

	test("speed restart replays the current block from the beginning at the new rate", async () => {
		const { queue, procs } = await makeFixture();
		queue.beginResponse("r1");
		queue.enqueue("r1", "blocco");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await queue.togglePlayPause();
		await flush();
		const first = nth(procs, 0);
		expect(first.speed).toBe(1);

		queue.stepSpeed(0.1);
		await flush();
		expect(queue.snapshot().speed).toBe(1.1);
		expect(first.signals).toContain("SIGTERM");
		expect(procs.length).toBe(2);
		expect(nth(procs, 1).speed).toBe(1.1);
		expect(queue.snapshot().activeBlockId).toBe("r1:0");
	});

	test("speed clamps at both bounds without restarting anything", async () => {
		const { queue, procs } = await makeFixture();
		for (let i = 0; i < 12; i += 1) queue.stepSpeed(0.1);
		expect(queue.snapshot().speed).toBe(2);
		for (let i = 0; i < 20; i += 1) queue.stepSpeed(-0.1);
		expect(queue.snapshot().speed).toBe(0.5);
		expect(procs.length).toBe(0);
	});

	test("new response does not interrupt the audible block; autoplay continues onto it", async () => {
		const { queue, procs } = await makeFixture({ autoplay: true });
		queue.beginResponse("r1");
		queue.enqueue("r1", "primo");
		queue.beginResponse("r2");
		queue.enqueue("r2", "secondo");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await flush();
		expect(queue.snapshot().activeBlockId).toBe("r1:0");

		await queue.acceptAudio("r2:0", makeTtsAudio(1).pcm, 24_000);
		await flush();
		expect(queue.snapshot().activeBlockId).toBe("r1:0"); // not interrupted
		expect(procs.length).toBe(1);

		await finish(nth(procs, 0));
		expect(queue.snapshot().activeBlockId).toBe("r2:0"); // autoplay moved on
		expect(procs.length).toBe(2);
	});

	test("stop halts autoplay: later audio does not resurrect the player", async () => {
		const { queue, procs } = await makeFixture({ autoplay: true });
		queue.beginResponse("r1");
		queue.enqueue("r1", "uno");
		queue.enqueue("r1", "due");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await flush();
		expect(queue.snapshot().state).toBe("playing");

		queue.stop();
		expect(queue.snapshot().state).toBe("idle");

		await queue.acceptAudio("r1:1", makeTtsAudio(1).pcm, 24_000);
		await flush();
		expect(queue.snapshot().state).toBe("idle");
		expect(procs.length).toBe(1);

		await queue.togglePlayPause();
		await flush();
		expect(queue.snapshot().state).toBe("playing");
	});

	test("a non-zero exit marks the block failed and surfaces the error", async () => {
		const { queue, procs } = await makeFixture();
		queue.beginResponse("r1");
		queue.enqueue("r1", "boom");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await queue.togglePlayPause();
		await flush();

		await finish(nth(procs, 0), 1);
		const snapshot = queue.snapshot();
		expect(snapshot.state).toBe("error");
		expect(snapshot.error).toContain("afplay exited 1");
		expect(nth(nth(snapshot.responses, 0).blocks, 0).state).toBe("failed");
	});

	test("a failed block is re-synthesized on the next play and then plays", async () => {
		let calls = 0;
		const { queue, procs } = await makeFixture({
			synthesize: async () => {
				calls += 1;
				return calls === 1 ? null : { kind: "pcm" as const, ...makeTtsAudio(1) };
			},
		});
		queue.beginResponse("r1");
		queue.enqueue("r1", "retry me");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await queue.togglePlayPause();
		await flush();

		// The player process dies: the block is failed, nothing is audible.
		await finish(nth(procs, 0), 1);
		expect(queue.snapshot().state).toBe("error");

		// First retry: synthesis returns nothing, only this block is marked. The
		// retry is not awaited by the caller, so wait for the outcome to land.
		await queue.togglePlayPause();
		await waitFor(queue, s => s.state === "error" && s.responses[0]?.blocks[0]?.state === "failed");
		expect(calls).toBe(1);

		// Second retry: synthesis succeeds and the block becomes audible again.
		await queue.togglePlayPause();
		await waitFor(queue, s => s.state === "playing");
		expect(calls).toBe(2);
		expect(procs.length).toBe(2);
	});

	test("clear stops audio but keeps history and cached WAVs navigable", async () => {
		const { queue, procs } = await makeFixture({ autoplay: true });
		queue.beginResponse("r1");
		queue.enqueue("r1", "uno");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await flush();
		expect(queue.snapshot().state).toBe("playing");

		queue.clear();
		expect(nth(procs, 0).signals).toContain("SIGTERM");
		const snapshot = queue.snapshot();
		expect(snapshot.state).toBe("idle");
		expect(snapshot.activeBlockId).toBeNull();
		expect(snapshot.responses.length).toBe(1);
		const block = nth(nth(snapshot.responses, 0).blocks, 0);
		expect(block.state).toBe("ready");
		expect(block.wavPath).toBeTruthy();
	});

	test("responses are capped at RESPONSE_CAP, newest first", async () => {
		const { queue } = await makeFixture();
		for (let i = 0; i < RESPONSE_CAP + 5; i += 1) queue.beginResponse(`r${i}`);
		const { responses } = queue.snapshot();
		expect(responses.length).toBe(RESPONSE_CAP);
		expect(nth(responses, 0).id).toBe(`r${RESPONSE_CAP + 4}`);
	});
});

describe("SpeechPlaybackQueue resuming from a chosen block", () => {
	/** Five ready blocks in one response, nothing playing yet. */
	async function seedFive(autoplay: boolean) {
		const fixture = await makeFixture({ autoplay });
		fixture.queue.beginResponse("r1");
		for (let i = 0; i < 5; i += 1) fixture.queue.enqueue("r1", `blocco ${i}`);
		for (let i = 0; i < 5; i += 1) await fixture.queue.acceptAudio(`r1:${i}`, makeTtsAudio(1).pcm, 24_000);
		await flush();
		return fixture;
	}

	test("playing an earlier block resumes reading from there, not from the end", async () => {
		const { queue, procs } = await seedFive(true);
		// Autoplay walked to the end: everything before the last is played.
		for (let i = 0; i < 4; i += 1) await finish(nth(procs, i));
		expect(queue.snapshot().activeBlockId).toBe("r1:4");

		// Jump back to block 1 and play it.
		await queue.selectBlock(1, { play: true });
		await flush();
		expect(queue.snapshot().activeBlockId).toBe("r1:1");

		// When it ends, reading continues with block 2 — the one after it —
		// instead of skipping to whatever had not been heard yet.
		await finish(nth(procs, procs.length - 1));
		expect(queue.snapshot().activeBlockId).toBe("r1:2");

		await finish(nth(procs, procs.length - 1));
		expect(queue.snapshot().activeBlockId).toBe("r1:3");
	});

	test("resuming from an earlier block works even when later ones were played", async () => {
		const { queue, procs } = await seedFive(true);
		for (let i = 0; i < 4; i += 1) await finish(nth(procs, i));
		// Blocks 0..3 played, 4 playing.
		const played = nth(queue.snapshot().responses, 0).blocks.filter(b => b.state === "played").length;
		expect(played).toBe(4);

		await queue.selectBlock(0, { play: true });
		await flush();
		await finish(nth(procs, procs.length - 1));
		// The already-played block 1 is spoken again: position wins over state.
		expect(queue.snapshot().activeBlockId).toBe("r1:1");
	});

	test("autoplay waits when the next block has no audio yet", async () => {
		const { queue, procs } = await makeFixture({ autoplay: true });
		queue.beginResponse("r1");
		queue.enqueue("r1", "primo");
		queue.enqueue("r1", "secondo");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await flush();
		expect(queue.snapshot().activeBlockId).toBe("r1:0");

		// The first block ends before the second has been synthesized.
		await finish(nth(procs, 0));
		expect(queue.snapshot().state).toBe("waiting");
		expect(queue.snapshot().activeBlockId).toBe("r1:1");

		// It starts by itself the moment the audio lands.
		await queue.acceptAudio("r1:1", makeTtsAudio(1).pcm, 24_000);
		await flush();
		expect(queue.snapshot().state).toBe("playing");
		expect(queue.snapshot().activeBlockId).toBe("r1:1");
	});

	test("exactly one block is ever in the playing state", async () => {
		const { queue } = await seedFive(true);
		const playing = () => nth(queue.snapshot().responses, 0).blocks.filter(b => b.state === "playing");

		expect(playing().length).toBe(1);

		// Interrupt mid-sentence, repeatedly, the way a user hitting next does.
		for (const index of [3, 1, 4, 2]) {
			await queue.selectBlock(index, { play: true });
			await flush();
			expect(playing().length).toBe(1);
			expect(nth(playing(), 0).id).toBe(`r1:${index}`);
		}

		// A speed change restarts the block: still exactly one.
		queue.stepSpeed(0.1);
		await flush();
		expect(playing().length).toBe(1);

		// And the interrupted blocks went back to `ready`, not stuck as playing.
		const stuck = nth(queue.snapshot().responses, 0).blocks.filter(
			b => b.state === "playing" && b.id !== queue.snapshot().activeBlockId,
		);
		expect(stuck).toEqual([]);
	});

	test("no block is shown as audible unless it is the active one", async () => {
		const { queue } = await makeFixture({ autoplay: true });
		queue.beginResponse("r1");
		for (let i = 0; i < 3; i += 1) queue.enqueue("r1", `blocco ${i}`);
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await flush();
		expect(queue.snapshot().activeBlockId).toBe("r1:0");

		// Jump to a block whose audio has not been synthesized yet: the player
		// waits on it, so nothing at all is audible right now.
		await queue.selectBlock(2, { play: true });
		await flush();
		expect(queue.snapshot().activeBlockId).toBe("r1:2");
		const audible = nth(queue.snapshot().responses, 0).blocks.filter(
			b => b.state === "playing" || b.state === "paused",
		);
		expect(audible).toEqual([]);
		// And the elapsed readout does not survive the block it belonged to.
		expect(queue.snapshot().elapsedMs).toBe(0);
	});

	test("an interrupted block keeps no stale timing", async () => {
		const { queue } = await seedFive(true);
		await queue.selectBlock(2, { play: true });
		await flush();
		// Block 0 was cut short: it must carry no startedAt, or the HUD would show
		// an elapsed time larger than its own duration.
		const first = nth(nth(queue.snapshot().responses, 0).blocks, 0);
		expect(first.state).toBe("ready");
		expect(first.startedAt).toBeUndefined();
		expect(first.pausedAt).toBeUndefined();
	});
});

describe("SpeechPlaybackQueue driving its own synthesis (Voicebox engine)", () => {
	/** A controllable engine: the test decides when each block finishes. */
	function makeEngine() {
		const asked: string[] = [];
		const pending: Array<(value: SynthesizedBlock | null) => void> = [];
		const synthesize = (text: string) => {
			asked.push(text);
			return new Promise<SynthesizedBlock | null>(resolve => pending.push(resolve));
		};
		const settle = (index: number, value: SynthesizedBlock | null) => {
			const resolve = pending[index];
			if (!resolve) throw new Error(`no pending synthesis at ${index}`);
			resolve(value);
		};
		return { asked, pending, synthesize, settle };
	}

	const wavBlock = (seconds: number): SynthesizedBlock => ({
		kind: "wav",
		wav: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]),
		durationSeconds: seconds,
	});

	test("synthesizes queued blocks one at a time, in queue order", async () => {
		const engine = makeEngine();
		const { queue } = await makeFixture({ autoplay: true, engine: engine.synthesize });
		queue.beginResponse("r1");
		queue.enqueue("r1", "primo");
		queue.enqueue("r1", "secondo");
		await flush();

		// Serial: the second block is not requested while the first is running.
		expect(engine.asked).toEqual(["primo"]);
		expect(nth(nth(queue.snapshot().responses, 0).blocks, 0).state).toBe("synthesizing");
		expect(nth(nth(queue.snapshot().responses, 0).blocks, 1).state).toBe("queued");

		engine.settle(0, wavBlock(2));
		await waitFor(queue, s => s.responses[0]?.blocks[1]?.state === "synthesizing");
		expect(engine.asked).toEqual(["primo", "secondo"]);
	});

	test("stores the WAV as it came, without a decode round trip", async () => {
		const engine = makeEngine();
		const { queue, dir } = await makeFixture({ engine: engine.synthesize });
		queue.beginResponse("r1");
		queue.enqueue("r1", "blocco");
		await flush();
		engine.settle(0, wavBlock(3.5));
		await waitFor(queue, s => s.responses[0]?.blocks[0]?.state === "ready");

		const block = nth(nth(queue.snapshot().responses, 0).blocks, 0);
		expect(block.state).toBe("ready");
		expect(block.durationSeconds).toBe(3.5);
		const files = await readdir(resolve(dir, ".omp", "tts-cache", "sess-test"));
		expect(files.filter(f => f.endsWith(".wav")).length).toBe(1);
		const stored = await readFile(join(resolve(dir, ".omp", "tts-cache", "sess-test"), nth(files, 0)));
		expect(Array.from(stored.slice(0, 4))).toEqual([82, 73, 70, 70]);
		await queue.dispose();
	});

	test("an engine failure marks only its block and lets the queue continue", async () => {
		const engine = makeEngine();
		const { queue } = await makeFixture({ engine: engine.synthesize });
		queue.beginResponse("r1");
		queue.enqueue("r1", "rotto");
		queue.enqueue("r1", "sano");
		await flush();

		engine.pending[0]?.(null);
		// Wait for the chain to reach the NEXT block, not just for the failure to
		// be recorded: the point of the test is that the queue keeps going.
		await waitFor(queue, s => s.responses[0]?.blocks[1]?.state === "synthesizing");
		const blocks = nth(queue.snapshot().responses, 0).blocks;
		expect(nth(blocks, 0).state).toBe("failed");
		// The next block is still picked up: one failure is not the end of the queue.
		expect(engine.asked).toEqual(["rotto", "sano"]);
	});

	test("nothing is synthesized while the engine is still warming up", async () => {
		const engine = makeEngine();
		const { queue } = await makeFixture({ engine: engine.synthesize });
		queue.setWarmProgress(undefined, true);
		queue.beginResponse("r1");
		queue.enqueue("r1", "atteso");
		await flush();
		expect(engine.asked).toEqual([]);

		queue.setWarmProgress(undefined, false);
		await flush();
		expect(engine.asked).toEqual(["atteso"]);
	});

	test("reportError puts the player in error with the reason visible", async () => {
		const { queue } = await makeFixture();
		queue.reportError("Voicebox non risponde");
		expect(queue.snapshot().state).toBe("error");
		expect(queue.snapshot().error).toBe("Voicebox non risponde");
	});
});

describe("SpeechPlaybackQueue autoplay switch", () => {
	async function seedThree(autoplay: boolean) {
		const fixture = await makeFixture({ autoplay });
		fixture.queue.beginResponse("r1");
		for (let i = 0; i < 3; i += 1) fixture.queue.enqueue("r1", `blocco ${i}`);
		for (let i = 0; i < 3; i += 1) await fixture.queue.acceptAudio(`r1:${i}`, makeTtsAudio(1).pcm, 24_000);
		await flush();
		return fixture;
	}

	test("with autoplay off a finished block does not move on", async () => {
		const { queue, procs } = await seedThree(false);
		expect(queue.snapshot().autoplay).toBe(false);

		await queue.togglePlayPause();
		await flush();
		expect(queue.snapshot().activeBlockId).toBe("r1:0");

		await finish(nth(procs, 0));
		// It stops here: idle, pointer kept, nothing new spawned.
		expect(queue.snapshot().state).toBe("idle");
		expect(procs.length).toBe(1);
	});

	test("turning autoplay on mid-block keeps reading when that block ends", async () => {
		const { queue, procs } = await seedThree(false);
		await queue.togglePlayPause();
		await flush();

		queue.setAutoplay(true);
		expect(queue.snapshot().autoplay).toBe(true);
		// Enabling it does not interrupt what is already audible.
		expect(queue.snapshot().activeBlockId).toBe("r1:0");
		expect(procs.length).toBe(1);

		await finish(nth(procs, 0));
		expect(queue.snapshot().activeBlockId).toBe("r1:1");
	});

	test("turning autoplay off never interrupts the block being spoken", async () => {
		const { queue, procs } = await seedThree(true);
		expect(queue.snapshot().activeBlockId).toBe("r1:0");

		queue.setAutoplay(false);
		// Still playing, same process, no signal sent.
		expect(queue.snapshot().state).toBe("playing");
		expect(nth(procs, 0).signals).toEqual([]);

		await finish(nth(procs, 0));
		expect(queue.snapshot().state).toBe("idle");
		expect(procs.length).toBe(1);
	});

	test("with autoplay off an explicit play still works, one block at a time", async () => {
		const { queue, procs } = await seedThree(false);
		await queue.selectBlock(1, { play: true });
		await flush();
		expect(queue.snapshot().activeBlockId).toBe("r1:1");

		await finish(nth(procs, 0));
		expect(queue.snapshot().state).toBe("idle");

		await queue.selectBlock(2, { play: true });
		await flush();
		expect(queue.snapshot().activeBlockId).toBe("r1:2");
		expect(procs.length).toBe(2);
	});
});

describe("SpeechPlaybackQueue reading a seeded backlog", () => {
	/** Engine the test settles by hand, one block at a time. */
	function makeEngine() {
		const asked: string[] = [];
		const pending: Array<(value: SynthesizedBlock | null) => void> = [];
		return {
			asked,
			pending,
			synthesize: (text: string) => {
				asked.push(text);
				return new Promise<SynthesizedBlock | null>(resolve => pending.push(resolve));
			},
			settleLast(durationSeconds = 1) {
				const resolve = pending[pending.length - 1];
				if (!resolve) throw new Error("no pending synthesis");
				resolve({ kind: "wav", wav: new Uint8Array([82, 73, 70, 70]), durationSeconds });
			},
		};
	}

	test("autoplay walks a seeded backlog without a manual play per line", async () => {
		const engine = makeEngine();
		const { queue, procs } = await makeFixture({ autoplay: true, engine: engine.synthesize });
		queue.seedResponse("h1", ["primo verso", "secondo verso", "terzo verso"]);
		await flush();

		// Nothing is rendered just by seeding.
		expect(engine.asked).toEqual([]);

		// Play the first line: it is synthesized on demand...
		await queue.selectBlock(0, { play: true });
		await waitFor(queue, s => s.responses[0]?.blocks[0]?.state === "synthesizing");
		expect(engine.asked).toEqual(["primo verso"]);
		engine.settleLast();
		await waitFor(queue, s => s.state === "playing");
		expect(queue.snapshot().activeBlockId).toBe("h1:0");

		// ...and the SECOND line is already being prepared while the first plays.
		expect(engine.asked).toEqual(["primo verso", "secondo verso"]);
		engine.settleLast();
		await waitFor(queue, s => s.responses[0]?.blocks[1]?.state === "ready");

		// When the first ends, the second starts by itself: no manual play.
		await finish(nth(procs, 0));
		expect(queue.snapshot().activeBlockId).toBe("h1:1");
		expect(queue.snapshot().state).toBe("playing");

		// And the third is queued up behind it, again without being asked.
		expect(engine.asked).toEqual(["primo verso", "secondo verso", "terzo verso"]);
	});

	test("a backlog line whose audio is not ready is requested, not silently awaited", async () => {
		const engine = makeEngine();
		const { queue, procs } = await makeFixture({ autoplay: true, engine: engine.synthesize });
		queue.seedResponse("h1", ["uno", "due"]);
		await flush();

		await queue.selectBlock(0, { play: true });
		await waitFor(queue, s => s.responses[0]?.blocks[0]?.state === "synthesizing");
		engine.settleLast();
		await waitFor(queue, s => s.state === "playing");

		// Drop the prefetched audio for the second line by finishing the first
		// before the engine settles it: the player must ASK for it.
		const askedBefore = engine.asked.length;
		await finish(nth(procs, 0));
		expect(queue.snapshot().state).toBe("waiting");
		expect(queue.snapshot().activeBlockId).toBe("h1:1");
		expect(engine.asked.length).toBeGreaterThanOrEqual(askedBefore);
		expect(engine.asked).toContain("due");

		// It starts on its own once the audio lands.
		engine.settleLast();
		await waitFor(queue, s => s.state === "playing");
		expect(queue.snapshot().activeBlockId).toBe("h1:1");
	});

	test("seeding alone still renders nothing, even with autoplay on", async () => {
		const engine = makeEngine();
		const { queue, procs } = await makeFixture({ autoplay: true, engine: engine.synthesize });
		queue.seedResponse("h1", ["a", "b", "c"]);
		queue.seedResponse("h2", ["d", "e"]);
		await flush();
		await flush();
		expect(engine.asked).toEqual([]);
		expect(procs.length).toBe(0);
	});
});

describe("SpeechPlaybackQueue cache containment", () => {
	test("writes the WAV under .omp/tts-cache with an internal .gitignore of `*`", async () => {
		const { queue, dir } = await makeFixture();
		queue.beginResponse("r1");
		queue.enqueue("r1", "cache me");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);

		const cacheRoot = resolve(dir, ".omp", "tts-cache");
		expect(await readFile(join(cacheRoot, ".gitignore"), "utf8")).toBe("*\n");
		const files = await readdir(join(cacheRoot, "sess-test"));
		expect(files.filter(f => f.endsWith(".wav")).length).toBe(1);
		// The atomic write leaves no partial behind.
		expect(files.filter(f => f.endsWith(".part")).length).toBe(0);
		await queue.dispose();
	});

	test("the cache is invisible to git thanks to the internal .gitignore", async () => {
		const { queue, dir } = await makeFixture();
		const init = Bun.spawnSync(["git", "init", "-q", dir]);
		expect(init.exitCode).toBe(0);
		queue.beginResponse("r1");
		queue.enqueue("r1", "invisible");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);

		const status = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"]);
		expect(status.exitCode).toBe(0);
		expect(status.stdout.toString().trim()).toBe("");
		await queue.dispose();
	});

	test("sweepExpired removes files past the TTL and keeps fresh, active and linked ones", async () => {
		const { queue, dir, procs } = await makeFixture();
		queue.beginResponse("r1");
		queue.enqueue("r1", "vecchio");
		queue.enqueue("r1", "fresco");
		queue.enqueue("r1", "attivo");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await queue.acceptAudio("r1:1", makeTtsAudio(1).pcm, 24_000);
		await queue.acceptAudio("r1:2", makeTtsAudio(1).pcm, 24_000);

		const sessionDir = resolve(dir, ".omp", "tts-cache", "sess-test");
		const blocks = nth(queue.snapshot().responses, 0).blocks;
		const oldWav = nth(blocks, 0).wavPath ?? "";
		const freshWav = nth(blocks, 1).wavPath ?? "";
		const activeWav = nth(blocks, 2).wavPath ?? "";

		// A stale .part left by a crashed write, and a symlink pointing outside.
		const stalePart = join(sessionDir, "crashed.part");
		await writeFile(stalePart, "partial");
		const outside = join(dir, "outside.wav");
		await writeFile(outside, "target must survive");
		const link = join(sessionDir, "linked.wav");
		await symlink(outside, link);

		const expired = new Date(Date.now() - CACHE_TTL_MS - 60_000);
		// The link and its target are stale too: a sweep using `stat` would follow
		// the link, see an expired regular file and unlink it. Only `lstat` refuses.
		for (const path of [oldWav, stalePart, outside]) await utimes(path, expired, expired);
		await lutimes(link, expired, expired);

		// Make the third block audible: the sweep must never delete it.
		await queue.selectBlock(2, { play: true });
		await flush();
		expect(queue.snapshot().activeBlockId).toBe("r1:2");
		await utimes(activeWav, expired, expired);

		await queue.sweepExpired();

		const remaining = await readdir(sessionDir);
		expect(remaining).not.toContain(oldWav.split("/").pop());
		expect(remaining).not.toContain("crashed.part");
		expect(remaining).toContain(freshWav.split("/").pop());
		expect(remaining).toContain(activeWav.split("/").pop());
		// lstat does not follow the link, so neither it nor its target is touched.
		expect(remaining).toContain("linked.wav");
		expect(await readFile(outside, "utf8")).toBe("target must survive");
		expect(procs.length).toBe(1);
		await queue.dispose();
	});

	test("dispose stops the process and timers and leaves valid WAVs in place", async () => {
		const { queue, dir, procs } = await makeFixture();
		queue.beginResponse("r1");
		queue.enqueue("r1", "resta");
		await queue.acceptAudio("r1:0", makeTtsAudio(1).pcm, 24_000);
		await queue.togglePlayPause();
		await flush();

		await queue.dispose();
		expect(nth(procs, 0).signals).toContain("SIGTERM");
		expect(queue.snapshot().state).toBe("idle");
		expect(queue.snapshot().activeBlockId).toBeNull();
		const files = await readdir(resolve(dir, ".omp", "tts-cache", "sess-test"));
		expect(files.filter(f => f.endsWith(".wav")).length).toBe(1);
		expect(files.filter(f => f.endsWith(".part")).length).toBe(0);
	});
});
