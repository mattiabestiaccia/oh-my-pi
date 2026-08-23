import { runPauseScreen } from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "force",
		icon: "hammer",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? "Force: no active tools" : `Force: ${count} active tools`;
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		icon: "voice",
		description: "Start Codex-backed realtime voice mode",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "tts",
		icon: "voice",
		description: "Spoken-reply player: /tts opens the chapter list",
		inlineHint: "[on|off|status|play|pause|stop|next|previous|older|newer|speed <0.5..2>|autoplay [on|off]]",
		allowArgs: true,
		subcommands: [
			{ name: "on", description: "Enable the player with HUD and autoplay, without the overlay" },
			{ name: "off", description: "Stop audio and synthesis and hide the HUD" },
			{ name: "status", description: "Show state, block, response, speed and voice" },
			{ name: "play", description: "Play, or pause if already speaking" },
			{ name: "pause", description: "Pause in place" },
			{ name: "stop", description: "Stop, keeping the pointer on the block" },
			{ name: "next", description: "Speak the next block" },
			{ name: "previous", description: "Speak the previous block" },
			{ name: "older", description: "Move to the previous response" },
			{ name: "newer", description: "Move to the next response" },
			{ name: "speed", description: "Set the rate", usage: "speed <0.5..2>" },
			{
				name: "autoplay",
				description: "Toggle reading on by itself after each block",
				usage: "autoplay [on|off]",
			},
		],
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const message = await runtime.ctx.handleTtsCommand(command.args);
			if (message) runtime.ctx.showWarning(message);
		},
	},
	{
		name: "pause",
		icon: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		icon: "power",
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
];
