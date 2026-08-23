import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, AssistantMessage, completeSimple, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { InspectImageTool } from "./inspect-image";
import type { ToolSession } from "./index";

// 1×1 PNG (the fixture used by the upstream inspect_image tests); a valid PNG so
// the content-sniffing loader reports image/png.
const ONE_BY_ONE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const STUB_DESCRIPTION = "stub vision description";

function visionTestModel(): Model<Api> {
	return {
		id: "gpt-5.6-terra",
		provider: "openai-codex",
		api: "openai-codex-responses",
		input: ["text", "image"],
		cost: { input: 0, output: 0 },
		contextWindow: 200_000,
		compat: {},
	} as Model<Api>;
}

interface CapturedRequest {
	model: Model;
	ctx: Context;
}

type CompleteStub = typeof completeSimple;

function makeCompleteImageStub(): {
	stub: CompleteStub;
	captured: () => CapturedRequest | undefined;
	calls: () => number;
} {
	let captured: CapturedRequest | undefined;
	let calls = 0;
	return {
		stub: (async <TApi extends Api>(
			model: Model<TApi>,
			ctx: Context,
			_options?: SimpleStreamOptions,
		): Promise<AssistantMessage> => {
			calls += 1;
			captured = { model, ctx };
			return {
				role: "assistant",
				content: [{ type: "text", text: STUB_DESCRIPTION }],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: model.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				stopReason: "stop",
			} as unknown as AssistantMessage;
		}) as CompleteStub,
		captured: () => captured,
		calls: () => calls,
	};
}

interface Harness {
	artifactsDir: string;
	localRoot: string;
	session: ToolSession;
}

async function makeHarness(): Promise<Harness> {
	const artifactsDir = (await TempDir.create("inspect-image-local-url-")).absolute();
	const localRoot = path.join(artifactsDir, "local");
	await fs.mkdir(localRoot, { recursive: true });

	const settings = Settings.isolated({
		"images.autoResize": false,
		"inspect_image.timeoutMs": 0,
	});
	const modelRegistry = {
		getAvailable: () => [visionTestModel()],
		getApiKey: async () => "test-api-key",
		resolver: () => "test-api-key",
	} as unknown as ModelRegistry;

	const session: ToolSession = {
		cwd: artifactsDir,
		settings,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => "inspect-image-local-url-test",
		localProtocolOptions: {
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "inspect-image-local-url-test",
		},
		modelRegistry,
	};

	return { artifactsDir, localRoot, session };
}

describe("inspect_image local:// session images", () => {
	test("resolves a session local:// image and sends it to the vision model", async () => {
		const harness = await makeHarness();
		try {
			const pngBytes = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
			const imagePath = path.join(harness.localRoot, "image-test.png");
			await fs.writeFile(imagePath, pngBytes);

			const { stub, captured, calls } = makeCompleteImageStub();
			const tool = new InspectImageTool(harness.session, stub);

			const result = await tool.execute("call-1", {
				path: "local://image-test.png",
				question: "Describe the image.",
			});

			expect(calls()).toBe(1);
			const request = captured();
			expect(request).toBeDefined();
			expect(request!.ctx.messages.length).toBe(1);
			const userContent = request!.ctx.messages[0].content;
			expect(userContent[0]).toMatchObject({ type: "image", mimeType: "image/png" });
			const imageBlock = userContent[0];
			if (!imageBlock || typeof imageBlock !== "object" || !("data" in imageBlock) || typeof imageBlock.data !== "string") {
				throw new Error("expected an image block with base64 data");
			}
			expect(imageBlock.data.length).toBeGreaterThan(0);
			expect(userContent[1]).toMatchObject({ type: "text", text: "Describe the image." });

			expect(result.content[0]).toMatchObject({ type: "text", text: STUB_DESCRIPTION });
			expect(result.details?.mimeType).toBe("image/png");
			expect(result.details?.imagePath).toBe(await fs.realpath(imagePath));
		} finally {
			await fs.rm(harness.artifactsDir, { recursive: true, force: true });
		}
	});

	test("rejects a local:// symlink escaping the session root", async () => {
		const harness = await makeHarness();
		try {
			// Real file OUTSIDE the local root; a symlink inside the root points at it.
			const hostagePath = path.join(harness.localRoot, "..", "secret.png");
			await fs.writeFile(hostagePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
			await fs.symlink(hostagePath, path.join(harness.localRoot, "escape.png"));

			const { stub } = makeCompleteImageStub();
			const tool = new InspectImageTool(harness.session, stub);

			await expect(
				tool.execute("call-1", { path: "local://escape.png", question: "Describe." }),
			).rejects.toThrow(/escapes local root/);
		} finally {
			await fs.rm(harness.artifactsDir, { recursive: true, force: true });
		}
	});
});