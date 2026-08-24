import { describe, expect, it } from "bun:test";
import { initThemeSync } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getMarkdownTheme, setMarkdownCodeBlockFence } from "@oh-my-pi/pi-coding-agent/modes/theme/tui-adapters";
import { Markdown } from "@oh-my-pi/pi-tui";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const SOURCE = "```ts\nconst x = 1;\n```";

describe("tui.codeBlockFence", () => {
	it("draws the fence lines by default", () => {
		initThemeSync(undefined, false, "dark", "light");
		setMarkdownCodeBlockFence(true);
		const out = stripAnsi(new Markdown(SOURCE, 0, 0, getMarkdownTheme()).render(80).join("\n"));
		expect(out).toContain("```ts");
		expect(out).toContain("const x = 1;");
	});

	it("renders the body alone when disabled", () => {
		initThemeSync(undefined, false, "dark", "light");
		setMarkdownCodeBlockFence(false);
		const out = stripAnsi(new Markdown(SOURCE, 0, 0, getMarkdownTheme()).render(80).join("\n"));
		expect(out).not.toContain("```");
		expect(out).toContain("const x = 1;");
		setMarkdownCodeBlockFence(true);
	});
});
