/**
 * TUI surfaces of the `/tts` streaming player.
 *
 * {@link TtsHudComponent} is the persistent, non-modal strip above the
 * composer: it never takes focus and never wraps, degrading from two lines to
 * one as the terminal narrows. {@link TtsChaptersOverlay} is the on-demand
 * chapter list, opened through `ui.custom(..., { overlay: true })`.
 *
 * Both read a {@link SpeechPlaybackSnapshot} and own no playback state: the
 * queue is the single source of truth, and every key maps to one queue call.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager } from "../../config/keybindings";
import type { SpeechBlock, SpeechPlaybackQueue, SpeechPlaybackSnapshot } from "../../tts/playback-queue";
import type { Theme, ThemeColor } from "../theme/theme";
import { bottomBorder, divider, fit, topBorder } from "./overlay-box";

/** Below this width the HUD collapses to a single line. */
const ONE_LINE_MAX_WIDTH = 40;
/** Below this width the HUD drops the labels but keeps two lines. */
const COMPACT_MAX_WIDTH = 60;
/** Progress bar cells at full width; shrinks with the terminal. */
const BAR_CELLS = 12;
/**
 * Overlay geometry. The component needs these to know how many rows it may
 * paint, and the controller passes the same values to `showHookCustom`, so the
 * viewport it scrolls inside is exactly the box the host draws.
 */
export const TTS_OVERLAY_HEIGHT_RATIO = 0.8;
export const TTS_OVERLAY_MARGIN = 1;
/** Rows kept for border, divider and the controls line. */
const OVERLAY_CHROME_ROWS = 4;
/** Fallback when the terminal size is unknown. */
const FALLBACK_TERMINAL_ROWS = 40;
/** Never shrink the scrollable area below this. */
const MIN_BODY_ROWS = 3;
/** Progressively shorter control lines, for boxes that cannot fit the full one. */
const SHORT_CONTROLS = "Space play · ↑↓ scegli · n/p blocco · h aiuto · Esc chiude";
const MINIMAL_CONTROLS = "Space play · h aiuto · Esc chiude";

/** CSI sequences for Page Up / Page Down. */
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

/**
 * Per-state glyph and colour. Marked with a shape as well as a colour so the
 * HUD stays readable in monochrome, per the project's TUI lessons.
 */
const BLOCK_GLYPHS: Record<SpeechBlock["state"], { glyph: string; color: ThemeColor }> = {
	queued: { glyph: "○", color: "muted" },
	synthesizing: { glyph: "◐", color: "muted" },
	ready: { glyph: "●", color: "text" },
	playing: { glyph: "▶", color: "accent" },
	paused: { glyph: "Ⅱ", color: "warning" },
	played: { glyph: "·", color: "muted" },
	failed: { glyph: "!", color: "error" },
};

const STATE_GLYPHS: Record<SpeechPlaybackSnapshot["state"], string> = {
	warming: "◌",
	idle: "■",
	waiting: "◐",
	playing: "▶",
	paused: "Ⅱ",
	error: "!",
};

/** mm:ss for the elapsed/total readouts. */
export function formatClock(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The block that is audible, or the one the cursor sits on. */
function currentBlock(snapshot: SpeechPlaybackSnapshot): SpeechBlock | undefined {
	if (snapshot.activeBlockId) {
		for (const response of snapshot.responses) {
			const found = response.blocks.find(b => b.id === snapshot.activeBlockId);
			if (found) return found;
		}
	}
	return snapshot.responses[snapshot.selectedResponseIndex]?.blocks[snapshot.selectedBlockIndex];
}

/** Fraction of the current block already spoken, 0..1. */
function blockProgress(snapshot: SpeechPlaybackSnapshot, block: SpeechBlock | undefined): number {
	const total = (block?.durationSeconds ?? 0) * 1000;
	if (total <= 0) return 0;
	return Math.min(1, snapshot.elapsedMs / total);
}

function bar(fraction: number, cells: number): string {
	const filled = Math.max(0, Math.min(cells, Math.round(fraction * cells)));
	return `${"━".repeat(filled)}${"─".repeat(cells - filled)}`;
}

/**
 * Persistent player strip mounted above the composer. Renders at whatever
 * width it is given and never wraps: everything is truncated to fit, because a
 * wrapped HUD would push the editor around on every tick.
 */
export class TtsHudComponent implements Component {
	#snapshot: SpeechPlaybackSnapshot;
	#theme: Theme;
	#voiceLabel: string;

	constructor(snapshot: SpeechPlaybackSnapshot, theme: Theme, voiceLabel = "Sara IT") {
		this.#snapshot = snapshot;
		this.#theme = theme;
		this.#voiceLabel = voiceLabel;
	}

	/** Feed a new queue snapshot; the container re-renders on its own. */
	update(snapshot: SpeechPlaybackSnapshot): void {
		this.#snapshot = snapshot;
	}

	/** Name the voice once the engine has resolved which profile it speaks with. */
	setVoiceLabel(label: string): void {
		this.#voiceLabel = label;
	}

	render(width: number): readonly string[] {
		if (width <= 0) return [];
		const snapshot = this.#snapshot;
		const block = currentBlock(snapshot);
		const status = this.#statusSegment(snapshot);
		if (width < ONE_LINE_MAX_WIDTH) return [this.#clip(status, width)];

		const compact = width < COMPACT_MAX_WIDTH;
		const cells = compact ? Math.max(4, Math.floor(BAR_CELLS / 2)) : BAR_CELLS;
		const pieces = [
			status,
			this.#theme.fg("muted", bar(blockProgress(snapshot, block), cells)),
			this.#counters(snapshot),
		];
		pieces.push(this.#theme.fg("muted", `${snapshot.speed.toFixed(1)}×`));
		// Autoplay on is the default, so only its absence is worth a word.
		if (!snapshot.autoplay) pieces.push(this.#theme.fg("warning", "manuale"));
		if (!compact) pieces.push(this.#theme.fg("dim", this.#voiceLabel));
		const first = this.#clip(pieces.join("  "), width);
		const second = this.#clip(this.#theme.fg("dim", this.#detailLine(snapshot, block)), width);
		return [first, second];
	}

	#statusSegment(snapshot: SpeechPlaybackSnapshot): string {
		const glyph = STATE_GLYPHS[snapshot.state];
		if (snapshot.state === "error") {
			return this.#theme.fg("error", `${glyph} ${snapshot.error ?? "errore"}`);
		}
		if (snapshot.warming) {
			const pct = snapshot.warmProgress === undefined ? "" : ` ${Math.round(snapshot.warmProgress * 100)}%`;
			return this.#theme.fg("muted", `${glyph} warm-up${pct}`);
		}
		return this.#theme.fg("accent", `${glyph} ${snapshot.state}`);
	}

	/** `blocco 2/7 · risposta 1/3`, shortened to `2/7 · 1/3` when compact. */
	#counters(snapshot: SpeechPlaybackSnapshot): string {
		const response = snapshot.responses[snapshot.selectedResponseIndex];
		const blocks = response?.blocks.length ?? 0;
		const blockNo = blocks === 0 ? 0 : snapshot.selectedBlockIndex + 1;
		const responseNo = snapshot.responses.length === 0 ? 0 : snapshot.selectedResponseIndex + 1;
		return this.#theme.fg("muted", `${blockNo}/${blocks} · ${responseNo}/${snapshot.responses.length}`);
	}

	/** Second line: the text being spoken, or the elapsed/total readout. */
	#detailLine(snapshot: SpeechPlaybackSnapshot, block: SpeechBlock | undefined): string {
		if (!block) return "nessun blocco in coda — /tts per aprire i capitoli";
		const total = block.durationSeconds
			? ` ${formatClock(snapshot.elapsedMs)}/${formatClock(block.durationSeconds * 1000)}`
			: "";
		return `${block.text.replace(/\s+/g, " ").trim()}${total}`;
	}

	/** Truncate to the visible width; the HUD must never wrap. */
	#clip(text: string, width: number): string {
		return visibleWidth(text) <= width ? text : truncateToWidth(text, width);
	}
}

/**
 * On-demand chapter list. Every key maps to one queue call; nothing about the
 * playback lives here.
 *
 * Escape closes only the overlay, leaving the HUD and autoplay running — and
 * it is handled BEFORE `app.interrupt`, which also defaults to escape. Getting
 * that order wrong makes escape tear down the whole surface from any view.
 */
/**
 * The player's shortcuts as they are actually bound, so the help view shows the
 * user's own keys rather than the defaults. Supplied by the controller, which
 * is the only place that can read the real keybindings.
 */
export interface TtsGlobalKeys {
	playPause: string[];
	stop: string[];
	previous: string[];
	next: string[];
	speedDown: string[];
	speedUp: string[];
	overlay: string[];
	autoplay: string[];
}

export class TtsChaptersOverlay implements Component {
	readonly interactive = true;
	#snapshot: SpeechPlaybackSnapshot;
	#queue: SpeechPlaybackQueue;
	#theme: Theme;
	#keybindings: KeybindingsManager;
	#close: () => void;
	#requestRender: () => void;
	#unsubscribe: (() => void) | null = null;
	#globalKeys: TtsGlobalKeys | undefined;
	/** `list` is the chapter list, `help` the shortcut reference. */
	#view: "list" | "help" = "list";
	/** Terminal row count source, so the body can be windowed to what fits. */
	#terminalRows: () => number;
	/** First body row painted, per view: the help view scrolls on its own. */
	#helpScroll = 0;
	#listScroll = 0;

	constructor(options: {
		queue: SpeechPlaybackQueue;
		theme: Theme;
		keybindings: KeybindingsManager;
		close: () => void;
		requestRender: () => void;
		globalKeys?: TtsGlobalKeys;
		/** Rows available in the terminal; defaults to the process stdout. */
		terminalRows?: () => number;
	}) {
		this.#terminalRows = options.terminalRows ?? (() => process.stdout.rows || FALLBACK_TERMINAL_ROWS);
		this.#queue = options.queue;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#close = options.close;
		this.#requestRender = options.requestRender;
		this.#globalKeys = options.globalKeys;
		this.#snapshot = options.queue.snapshot();
		this.#unsubscribe = options.queue.subscribe(snapshot => {
			this.#snapshot = snapshot;
			this.#requestRender();
		});
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}

	render(width: number): readonly string[] {
		if (this.#view === "help") return this.#renderHelp(width);
		const snapshot = this.#snapshot;
		const response = snapshot.responses[snapshot.selectedResponseIndex];
		const responseNo = snapshot.responses.length === 0 ? 0 : snapshot.selectedResponseIndex + 1;
		// Every row is padded to the full inner width: an overlay paints over the
		// transcript, so a short line would let the text underneath show through.
		const inner = Math.max(0, width - 4);
		const body: string[] = [];
		let anchorRow = 0;
		const blocks = response?.blocks ?? [];
		if (blocks.length === 0) {
			body.push(this.#theme.fg("muted", "Nessun blocco in questa risposta."));
		} else {
			for (const [index, block] of blocks.entries()) {
				if (index === snapshot.selectedBlockIndex) anchorRow = body.length;
				body.push(...this.#row(block, index, snapshot, inner));
			}
		}

		// Fit the controls line to the room left: in a short box the long form
		// would push the body past the host's clamp, and the tail of the panel
		// would be unreachable again.
		const controls = this.#fitControls(inner);
		// top + divider + controls + bottom
		const chrome = 3 + controls.length;
		const windowed = this.#window(body, this.#listScroll, this.#bodyRows(chrome), anchorRow);
		this.#listScroll = windowed.offset;

		const lines: string[] = [topBorder(width, `Capitoli · risposta ${responseNo}/${snapshot.responses.length}`)];
		for (const line of windowed.rows) lines.push(this.#framedRow(line, inner));
		lines.push(divider(width));
		for (const line of controls) lines.push(this.#framedRow(this.#theme.fg("dim", line), inner));
		lines.push(bottomBorder(width));
		return lines;
	}

	/** One opaque content row, framed by the panel's side borders. */
	#framedRow(content: string, inner: number): string {
		const box = this.#theme.boxRound;
		const edge = this.#theme.fg("border", box.vertical);
		return `${edge} ${fit(this.#clip(content, inner), inner)} ${edge}`;
	}

	/**
	 * The shortcut reference. Explains what the player does in two sentences and
	 * then lists the keys, in-panel first because that is where the reader is.
	 */
	#renderHelp(width: number): readonly string[] {
		const inner = Math.max(0, width - 4);
		const body: string[] = [];
		const push = (text: string) => {
			for (const line of text ? wrapTextWithAnsi(text, inner) : [""]) body.push(line);
		};

		push(
			this.#theme.fg(
				"muted",
				"La risposta viene divisa in blocchi — un paragrafo o una frase — e ogni blocco è un capitolo: si sintetizza mentre il testo scorre e parte appena è pronto.",
			),
		);
		push("");
		push(
			this.#theme.fg(
				"muted",
				"Con l'autoplay la lettura continua da sola; senza, ogni blocco si riproduce su richiesta. Riprodurre un capitolo precedente riprende la lettura da lì. L'audio resta in cache un'ora.",
			),
		);
		push("");
		push(this.#theme.bold("Qui nel pannello"));
		for (const [keys, what] of [
			["Space", "play / pausa"],
			["↑ ↓", "scegli un capitolo"],
			["Enter", "riproduce quello scelto, e riprende da lì"],
			["← →", "risposta più vecchia / più recente"],
			["n p", "capitolo successivo / precedente"],
			["+ -", "velocità, da 0.5× a 2×"],
			["a", `autoplay (ora ${this.#snapshot.autoplay ? "on" : "off"})`],
			["s", "stop, mantenendo il punto"],
			["h", "questo aiuto"],
			["Esc", "torna alla lista, poi chiude"],
		] as const) {
			push(`  ${this.#theme.fg("accent", keys.padEnd(7))} ${this.#theme.fg("muted", what)}`);
		}

		const global = this.#globalKeys;
		if (global) {
			push("");
			push(this.#theme.bold("Fuori dal pannello, col solo HUD"));
			for (const [keys, what] of [
				[global.playPause, "play / pausa"],
				[global.next, "capitolo successivo"],
				[global.previous, "capitolo precedente"],
				[global.speedUp, "più veloce"],
				[global.speedDown, "più lento"],
				[global.autoplay, "autoplay"],
				[global.stop, "stop"],
				[global.overlay, "riapre questo pannello"],
			] as const) {
				if (keys.length === 0) continue;
				push(`  ${this.#theme.fg("accent", keys.join(" ").padEnd(11))} ${this.#theme.fg("muted", what)}`);
			}
			push("");
			push(this.#theme.fg("dim", "Gli stessi comandi esistono come /tts play, /tts next, /tts autoplay off …"));
		}

		const scrolls = body.length > this.#bodyRows(4);
		const footer = wrapTextWithAnsi(
			scrolls ? "↑↓ scorre · PgUp/PgDn pagina · Esc o h torna alla lista" : "Esc o h per tornare alla lista",
			inner,
		);
		const windowed = this.#window(body, this.#helpScroll, this.#bodyRows(3 + footer.length));
		this.#helpScroll = windowed.offset;

		const lines: string[] = [topBorder(width, "Lettore vocale · aiuto")];
		for (const line of windowed.rows) lines.push(this.#framedRow(line, inner));
		lines.push(divider(width));
		for (const line of footer) lines.push(this.#framedRow(this.#theme.fg("dim", line), inner));
		lines.push(bottomBorder(width));
		return lines;
	}

	/** Rows the host will actually paint for this overlay. */
	#overlayRows(): number {
		const terminal = Math.max(1, this.#terminalRows());
		return Math.max(MIN_BODY_ROWS + 2, Math.floor(terminal * TTS_OVERLAY_HEIGHT_RATIO) - 2 * TTS_OVERLAY_MARGIN);
	}

	/**
	 * How many body rows fit, given how many rows the chrome takes. The host
	 * clamps the overlay to a share of the terminal, so painting more than this
	 * makes the extra rows unreachable — which is what the scrolling prevents.
	 *
	 * The chrome is measured, not assumed: the controls line wraps to two or
	 * three rows at narrow widths, and a fixed guess overflowed the box.
	 */
	#bodyRows(chromeRows = OVERLAY_CHROME_ROWS): number {
		return Math.max(MIN_BODY_ROWS, this.#overlayRows() - chromeRows);
	}

	/**
	 * Window `rows` to what fits, keeping `anchor` visible, and say what is out
	 * of view. Returns the clamped offset too, so the caller can store it back
	 * and keep scrolling from a valid position after a resize.
	 */
	#window(rows: string[], offset: number, capacity: number, anchor?: number): { rows: string[]; offset: number } {
		if (rows.length <= capacity) return { rows, offset: 0 };
		// Two rows go to the indicators whenever there is something on both sides.
		const inner = Math.max(1, capacity - 2);
		let start = Math.max(0, Math.min(offset, rows.length - inner));
		if (anchor !== undefined) {
			if (anchor < start) start = anchor;
			else if (anchor >= start + inner) start = anchor - inner + 1;
			start = Math.max(0, Math.min(start, rows.length - inner));
		}
		const end = Math.min(rows.length, start + inner);
		const windowed: string[] = [];
		const hidden = (count: number, where: string) =>
			this.#theme.fg(
				"dim",
				`  ${where === "sopra" ? "▴" : "▾"} ${count} ${count === 1 ? "riga" : "righe"} ${where}`,
			);
		windowed.push(start > 0 ? hidden(start, "sopra") : this.#theme.fg("dim", "  ─"));
		for (let i = start; i < end; i += 1) windowed.push(rows[i] ?? "");
		windowed.push(end < rows.length ? hidden(rows.length - end, "sotto") : this.#theme.fg("dim", "  ─"));
		return { rows: windowed, offset: start };
	}

	/** Move a view's scroll offset by `delta` rows, clamped by the next render. */
	#scrollBy(delta: number): void {
		if (this.#view === "help") this.#helpScroll = Math.max(0, this.#helpScroll + delta);
		else this.#listScroll = Math.max(0, this.#listScroll + delta);
		this.#requestRender();
	}

	/** Rows around the selection, with a position indicator when it windows. */
	/**
	 * One block as one or more rows. The panel wraps: a spoken line is a whole
	 * sentence, and truncating it hides the very text the user is choosing
	 * between. Continuation rows are indented under the glyph.
	 */
	#row(block: SpeechBlock, index: number, snapshot: SpeechPlaybackSnapshot, width: number): string[] {
		// The cursor must not be another triangle: next to ▶ (playing) a ▸ reads as
		// a second play marker on the same row, which is what made the overlay
		// look like two blocks were sounding at once.
		const selected = index === snapshot.selectedBlockIndex;
		const { glyph, color } = BLOCK_GLYPHS[block.state];
		const clock =
			block.id === snapshot.activeBlockId && block.durationSeconds
				? ` ${formatClock(snapshot.elapsedMs)}/${formatClock(block.durationSeconds * 1000)}`
				: block.durationSeconds
					? ` ${formatClock(block.durationSeconds * 1000)}`
					: "";
		const gutter = `${selected ? "❯" : " "} ${glyph} `;
		const gutterWidth = visibleWidth(gutter);
		const room = Math.max(8, width - gutterWidth);
		const spoken = `${block.text.replace(/\s+/g, " ").trim()}${clock}`;
		const wrapped = wrapTextWithAnsi(spoken, room);
		const head = selected ? this.#theme.fg("accent", gutter) : this.#theme.fg(color, gutter);
		const indent = " ".repeat(gutterWidth);
		return wrapped.map((line, lineIndex) => {
			const body = selected ? this.#theme.bold(line) : this.#theme.fg("muted", line);
			return lineIndex === 0 ? `${head}${body}` : `${indent}${body}`;
		});
	}

	/**
	 * The controls line, wrapped, shortened until body and chrome both fit the
	 * rows the host will paint. `h` always survives, so the full reference is
	 * one key away even in the smallest box.
	 */
	#fitControls(inner: number): string[] {
		const budget = this.#overlayRows() - 3 - MIN_BODY_ROWS;
		const candidates = [this.#helpLine(inner), SHORT_CONTROLS, MINIMAL_CONTROLS];
		for (const candidate of candidates) {
			const wrapped = wrapTextWithAnsi(candidate, inner);
			if (wrapped.length <= Math.max(1, budget)) return wrapped;
		}
		return [truncateToWidth(MINIMAL_CONTROLS, inner)];
	}

	/** Wrapped by the caller, so nothing is dropped at narrow widths. */
	#helpLine(width: number): string {
		if (width < 24) return "Space play · h aiuto · Esc chiude";
		const autoplay = `a autoplay (${this.#queue.autoplay ? "on" : "off"})`;
		return `Space play/pausa · ↑↓ scegli · Enter riproduce · ←→ risposta · n/p blocco · +/- velocità · ${autoplay} · s stop · h aiuto · Esc chiude`;
	}

	handleInput(data: string): void {
		// The innermost view handles escape FIRST. `app.interrupt` also defaults
		// to escape, so checking it at the top would tear down the whole overlay
		// from the help view instead of popping one level — the multi-view bug
		// the project's TUI lessons describe.
		if (this.#view === "help") {
			if (
				data === "h" ||
				this.#keybindings.matches(data, "tui.select.cancel") ||
				this.#keybindings.matches(data, "app.interrupt")
			) {
				this.#view = "list";
				this.#helpScroll = 0;
				this.#requestRender();
				return;
			}
			// The reference is longer than the box: it scrolls instead of hiding
			// its tail out of reach.
			if (this.#keybindings.matches(data, "tui.select.up")) this.#scrollBy(-1);
			else if (this.#keybindings.matches(data, "tui.select.down")) this.#scrollBy(1);
			else if (data === PAGE_UP) this.#scrollBy(-this.#bodyRows());
			else if (data === PAGE_DOWN) this.#scrollBy(this.#bodyRows());
			return;
		}
		if (data === "h") {
			this.#view = "help";
			this.#requestRender();
			return;
		}
		// Escape belongs to the overlay, not to app.interrupt: it pops this one
		// level and leaves the HUD and autoplay alone.
		if (this.#keybindings.matches(data, "tui.select.cancel") || this.#keybindings.matches(data, "app.interrupt")) {
			this.#close();
			return;
		}
		const snapshot = this.#snapshot;
		if (data === PAGE_UP) {
			this.#scrollBy(-this.#bodyRows());
			return;
		}
		if (data === PAGE_DOWN) {
			this.#scrollBy(this.#bodyRows());
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.up")) {
			void this.#queue.selectBlock(snapshot.selectedBlockIndex - 1);
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.down")) {
			void this.#queue.selectBlock(snapshot.selectedBlockIndex + 1);
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.confirm")) {
			void this.#queue.selectBlock(snapshot.selectedBlockIndex, { play: true });
			return;
		}
		switch (data) {
			case " ":
				void this.#queue.togglePlayPause();
				return;
			case "n":
				void this.#queue.selectBlock(snapshot.selectedBlockIndex + 1, { play: true });
				return;
			case "p":
				void this.#queue.selectBlock(snapshot.selectedBlockIndex - 1, { play: true });
				return;
			case "+":
			case "=":
				this.#queue.stepSpeed(0.1);
				return;
			case "-":
			case "_":
				this.#queue.stepSpeed(-0.1);
				return;
			case "s":
				this.#queue.stop();
				return;
			case "a":
				this.#queue.setAutoplay(!this.#queue.autoplay);
				return;
			default:
				break;
		}
		// Left/right walk the response history: left is older, right is newer.
		if (data === "\x1b[D" || data === "\x1bOD") {
			this.#queue.selectResponse(snapshot.selectedResponseIndex + 1);
			return;
		}
		if (data === "\x1b[C" || data === "\x1bOC") {
			this.#queue.selectResponse(snapshot.selectedResponseIndex - 1);
		}
	}

	#clip(text: string, width: number): string {
		return visibleWidth(text) <= width ? text : truncateToWidth(text, width);
	}
}
