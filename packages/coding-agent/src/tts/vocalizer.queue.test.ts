import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../config/settings";
import { type PlaybackProcess, SpeechPlaybackQueue, type SpeechPlaybackSnapshot } from "./playback-queue";
import type { TtsAudioChunk, TtsStreamHandle } from "./tts-client";
import { Vocalizer } from "./vocalizer";

/**
 * Stand-in for a Kokoro streaming session. Records the pushed segments and
 * lets the test emit chunks with an explicit `index`, which is the whole point
 * of the mapping under test. The shape is copied from the real
 * {@link TtsStreamHandle}, not invented for the test.
 */
class FakeStream implements TtsStreamHandle {
	pushed: string[] = [];
	ended = false;
	#pending: TtsAudioChunk[] = [];
	#waiting: ((chunk: IteratorResult<TtsAudioChunk>) => void) | null = null;
	#closed = false;

	push(text: string): void {
		this.pushed.push(text);
	}

	end(): void {
		this.ended = true;
	}

	/** Test-only: deliver one synthesized chunk to the consumer. */
	emit(index: number, sampleRate = 24_000): void {
		const chunk: TtsAudioChunk = {
			index,
			text: this.pushed[index] ?? "",
			pcm: new Float32Array(sampleRate).fill(0.01),
			sampleRate,
		};
		const waiting = this.#waiting;
		if (waiting) {
			this.#waiting = null;
			waiting({ value: chunk, done: false });
			return;
		}
		this.#pending.push(chunk);
	}

	/** Test-only: close the stream so the consumer loop ends. */
	close(): void {
		this.#closed = true;
		const waiting = this.#waiting;
		if (waiting) {
			this.#waiting = null;
			waiting({ value: undefined, done: true });
		}
	}

	chunks: AsyncIterableIterator<TtsAudioChunk> = {
		[Symbol.asyncIterator]() {
			return this;
		},
		next: (): Promise<IteratorResult<TtsAudioChunk>> => {
			const ready = this.#pending.shift();
			if (ready) return Promise.resolve({ value: ready, done: false });
			if (this.#closed) return Promise.resolve({ value: undefined, done: true });
			return new Promise<IteratorResult<TtsAudioChunk>>(resolve => {
				this.#waiting = resolve;
			});
		},
	};
}

class FakeProcess implements PlaybackProcess {
	pid = 1;
	signals: (string | number)[] = [];
	exited = new Promise<number>(() => {});

	kill(signal?: string | number): void {
		this.signals.push(signal ?? "SIGTERM");
	}
}

const flush = async () => {
	for (let i = 0; i < 8; i += 1) await new Promise<void>(resolve => queueMicrotask(resolve));
};

/**
 * Wait until the queue reports the expected shape. The audio path crosses a
 * real `writeFile`, so microtask flushing is not enough — but a timer would be
 * arbitrary synchronization. Subscribing resolves on the actual state change.
 */
function waitFor(queue: SpeechPlaybackQueue, predicate: (snapshot: SpeechPlaybackSnapshot) => boolean): Promise<void> {
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

const blocksOf = (snapshot: SpeechPlaybackSnapshot) => snapshot.responses[0]?.blocks ?? [];
const isAudible = (state: string | undefined) => state === "ready" || state === "playing";

async function makeHarness() {
	const dir = await mkdtemp(join(tmpdir(), "omp-vocalizer-"));
	const procs: FakeProcess[] = [];
	const queue = new SpeechPlaybackQueue(
		{
			cwd: dir,
			sessionId: "sess-vocalizer",
			autoplay: true,
			spawnPlayback: () => {
				const proc = new FakeProcess();
				procs.push(proc);
				return proc;
			},
			synthesizeBlock: async () => ({ kind: "pcm" as const, pcm: new Float32Array(24_000), sampleRate: 24_000 }),
		},
		() => {},
	);
	const streams: FakeStream[] = [];
	const vocalizer = new Vocalizer(
		() => {
			throw new Error("no StreamingAudioPlayer must be created while a queue is attached");
		},
		() => {
			const stream = new FakeStream();
			streams.push(stream);
			return stream;
		},
	);
	vocalizer.attachPlaybackQueue(queue);
	vocalizer.configureRuntime({ enabled: true, mode: "assistant", voice: "if_sara", enhanced: false });
	return { vocalizer, queue, streams, procs, dir };
}

describe("Vocalizer wired to the playback queue", () => {
	// `#openSession` reads `tts.localModel` from the settings singleton; the
	// in-memory mode exists for exactly this and touches no config on disk.
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	test("the runtime config wins over the persisted settings", async () => {
		const { vocalizer, queue, streams } = await makeHarness();
		expect(vocalizer.isRuntimeEnabled()).toBe(true);
		expect(vocalizer.runtimeMode()).toBe("assistant");
		expect(vocalizer.runtimeVoice()).toBe("if_sara");
		expect(vocalizer.runtimeEnhanced()).toBe(false);

		vocalizer.configureRuntime({ enabled: false, mode: "assistant", voice: "if_sara", enhanced: false });
		expect(vocalizer.isRuntimeEnabled()).toBe(false);
		// A disabled runtime swallows deltas: no session opens, no block is born.
		vocalizer.beginResponse("r1");
		vocalizer.pushDelta("Questo non deve essere parlato.\n\n");
		await flush();
		expect(streams.length).toBe(0);
		expect(queue.snapshot().responses[0]?.blocks.length).toBe(0);
	});

	test("each segment becomes one block, and chunk.index resolves to it", async () => {
		const { vocalizer, queue, streams } = await makeHarness();
		vocalizer.beginResponse("r1");
		vocalizer.pushDelta("Primo paragrafo breve.\n\nSecondo paragrafo breve.\n\n");
		await flush();

		const stream = streams[0];
		if (!stream) throw new Error("expected a synthesis session to be opened");
		expect(stream.pushed.length).toBeGreaterThanOrEqual(2);
		const blocks = queue.snapshot().responses[0]?.blocks ?? [];
		expect(blocks.length).toBe(stream.pushed.length);
		// Enqueue and push share one loop, so the two orders agree.
		expect(blocks.map(b => b.text)).toEqual(stream.pushed);

		// Audio for the second segment arrives first: the index, not the arrival
		// order, decides which block it belongs to.
		stream.emit(1);
		await waitFor(queue, s => isAudible(blocksOf(s)[1]?.state));
		expect(blocksOf(queue.snapshot())[0]?.state).toBe("queued");

		stream.emit(0);
		await waitFor(queue, s => isAudible(blocksOf(s)[0]?.state));
		stream.close();
	});

	test("a missing or repeated index fails only its own block, never shifting the rest", async () => {
		const { vocalizer, queue, streams } = await makeHarness();
		vocalizer.beginResponse("r1");
		vocalizer.pushDelta("Uno breve.\n\nDue breve.\n\n");
		await flush();
		const stream = streams[0];
		if (!stream) throw new Error("expected a synthesis session to be opened");
		const segments = stream.pushed.length;

		// An index past the end has no block. Emitting a valid index right after
		// gives a point to synchronize on: if the bad chunk had been applied to
		// the next block in line, block 0 would be audible for the wrong reason
		// and block 1 would have moved.
		stream.emit(segments + 5);
		stream.emit(0);
		await waitFor(queue, s => isAudible(blocksOf(s)[0]?.state));
		const firstWav = blocksOf(queue.snapshot())[0]?.wavPath;
		expect(firstWav).toBeTruthy();
		expect(blocksOf(queue.snapshot())[1]?.state).toBe("queued");

		// A duplicate of an index already consumed is ignored too: the WAV of
		// block 0 is not rewritten and block 1 stays untouched.
		stream.emit(0);
		await flush();
		expect(blocksOf(queue.snapshot())[0]?.wavPath).toBe(firstWav);
		expect(blocksOf(queue.snapshot())[1]?.state).toBe("queued");
		stream.close();
	});

	test("clear stops the audio but leaves the response and its WAVs in history", async () => {
		const { vocalizer, queue, streams } = await makeHarness();
		vocalizer.beginResponse("r1");
		vocalizer.pushDelta("Un paragrafo.\n\n");
		await flush();
		const stream = streams[0];
		if (!stream) throw new Error("expected a synthesis session to be opened");
		stream.emit(0);
		await waitFor(queue, s => s.state === "playing");

		vocalizer.clear();
		const snapshot = queue.snapshot();
		expect(snapshot.state).toBe("idle");
		expect(snapshot.activeBlockId).toBeNull();
		expect(snapshot.responses.length).toBe(1);
		expect(snapshot.responses[0]?.blocks[0]?.wavPath).toBeTruthy();
		stream.close();
	});

	test("finalizeResponse closes the response opened for the prompt", async () => {
		const { vocalizer, queue, streams } = await makeHarness();
		vocalizer.beginResponse("r1");
		vocalizer.pushDelta("Testo.\n\n");
		await flush();
		expect(queue.snapshot().responses[0]?.finalized).toBe(false);
		vocalizer.finalizeResponse("r1");
		expect(queue.snapshot().responses[0]?.finalized).toBe(true);
		streams[0]?.close();
	});

	test("without a queue the plain streaming player is used again", async () => {
		let created = 0;
		const streams: FakeStream[] = [];
		const vocalizer = new Vocalizer(
			() => {
				created += 1;
				return { start: () => {}, write: () => {}, setGain: () => {}, end: async () => {}, stop: () => {} };
			},
			() => {
				const stream = new FakeStream();
				streams.push(stream);
				return stream;
			},
		);
		vocalizer.configureRuntime({ enabled: true, mode: "assistant", voice: "if_sara", enhanced: false });
		vocalizer.pushDelta("Un paragrafo senza coda.\n\n");
		await flush();
		expect(created).toBe(1);
		streams[0]?.close();
	});
});
