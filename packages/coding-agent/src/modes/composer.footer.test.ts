import { describe, expect, test } from "bun:test";
import { Container, Text, type RenderScheduler, type Terminal } from "@oh-my-pi/pi-tui";
import { Composer } from "./composer";

/** Byte-sink terminal that keeps what was painted, so a test can assert on the frame. */
class CaptureTerminal implements Terminal {
	painted = "";
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.painted += data;
	}
	get columns(): number {
		return 80;
	}
	get rows(): number {
		return 24;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
	refreshAppearance(): void {}
	get appearance(): undefined {
		return undefined;
	}
}

/** Queues paints instead of arming timers, so the test drains them synchronously. */
class DrainScheduler implements RenderScheduler {
	#time = 0;
	#immediate: (() => void)[] = [];
	#renders = new Map<number, () => void>();
	#nextId = 0;
	now(): number {
		this.#time += 20;
		return this.#time;
	}
	scheduleImmediate(callback: () => void): void {
		this.#immediate.push(callback);
	}
	scheduleRender(callback: () => void, _delayMs: number): { cancel(): void } {
		const id = this.#nextId++;
		this.#renders.set(id, callback);
		return { cancel: () => void this.#renders.delete(id) };
	}
	drain(): void {
		for (let rounds = 0; this.#immediate.length > 0 || this.#renders.size > 0; rounds++) {
			if (rounds > 100) throw new Error("render scheduler did not settle");
			const immediate = this.#immediate;
			this.#immediate = [];
			for (const callback of immediate) callback();
			if (this.#renders.size === 0) continue;
			const renders = [...this.#renders.values()];
			this.#renders.clear();
			for (const callback of renders) callback();
		}
	}
}

describe("Composer status host with a footer container", () => {
	test("paints the container's child, and repaints it after a footer swap", () => {
		const terminal = new CaptureTerminal();
		const scheduler = new DrainScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { quiet: true },
		});

		// InteractiveMode mounts the footer container — not the status line itself —
		// so an extension can swap the footer without touching the composer.
		const footerContainer = new Container();
		footerContainer.addChild(new Text("NATIVE-FOOTER", 0, 0));
		composer.setStatusComponent(footerContainer);
		composer.start();
		scheduler.drain();
		expect(terminal.painted).toContain("NATIVE-FOOTER");

		// What ExtensionUiController.setFooter does: clear and refill the container.
		terminal.painted = "";
		footerContainer.clear();
		footerContainer.addChild(new Text("CUSTOM-FOOTER", 0, 0));
		composer.ui.requestRender(true);
		scheduler.drain();
		expect(terminal.painted).toContain("CUSTOM-FOOTER");
		expect(terminal.painted).not.toContain("NATIVE-FOOTER");

		composer.stop();
	});
});
