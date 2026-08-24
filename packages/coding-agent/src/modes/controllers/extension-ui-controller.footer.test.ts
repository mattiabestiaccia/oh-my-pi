import { describe, expect, test } from "bun:test";
import { type Component, Container } from "@oh-my-pi/pi-tui";
import { ExtensionUiController } from "./extension-ui-controller";

function textComponent(text: string, onDispose?: () => void): Component {
	return {
		render: () => [text],
		dispose: onDispose,
	};
}

describe("ExtensionUiController custom footer", () => {
	test("replaces the native footer and restores it when cleared", () => {
		const footerContainer = new Container();
		const statusLine = textComponent("native footer");
		footerContainer.addChild(statusLine);
		let renderRequests = 0;
		let customDisposed = false;
		const ui = {
			requestRender: () => {
				renderRequests += 1;
			},
		};
		const controller = new ExtensionUiController({ footerContainer, statusLine, ui } as never);

		controller.setFooter(() => textComponent("custom row 1\ncustom row 2", () => (customDisposed = true)));
		expect(footerContainer.render(80)).toEqual(["custom row 1\ncustom row 2"]);
		expect(renderRequests).toBe(1);

		controller.setFooter(undefined);
		expect(customDisposed).toBe(true);
		expect(footerContainer.render(80)).toEqual(["native footer"]);
		expect(renderRequests).toBe(2);
	});
});
