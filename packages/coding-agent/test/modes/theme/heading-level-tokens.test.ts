import { describe, expect, it } from "bun:test";
import { initThemeSync, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getMarkdownTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/tui-adapters";

/**
 * `mdHeading1`-`mdHeading6` are optional: a theme that predates them (every
 * built-in one) must render every heading depth exactly as it did before,
 * through `mdHeading`.
 */
describe("per-level markdown heading tokens", () => {
	it("falls back to mdHeading for every depth when the theme omits the tokens", () => {
		initThemeSync(undefined, false, "dark", "light");
		const md = getMarkdownTheme();
		expect(md.headingByLevel).toBeDefined();
		for (let level = 1; level <= 6; level++) {
			expect(md.headingByLevel?.(level, "x")).toBe(md.heading("x"));
		}
	});

	it("reports optional tokens as absent on a theme that omits them", () => {
		initThemeSync(undefined, false, "dark", "light");
		for (let level = 1; level <= 6; level++) {
			expect(theme.hasColor(`mdHeading${level}` as never)).toBe(false);
		}
		expect(theme.hasColor("mdHeading")).toBe(true);
	});

	it("clamps out-of-range depths onto the 1-6 token range", () => {
		initThemeSync(undefined, false, "dark", "light");
		const md = getMarkdownTheme();
		// marked never emits these, but the adapter must not build a bogus token.
		expect(md.headingByLevel?.(0, "x")).toBe(md.heading("x"));
		expect(md.headingByLevel?.(9, "x")).toBe(md.heading("x"));
	});
});
