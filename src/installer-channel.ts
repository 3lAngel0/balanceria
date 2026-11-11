// "Where do you want to install?" prompt shown after the language prompt: terminal or web.
// Pure view and state machine, same shape as setup-lang-prompt.ts.

import { t } from "./i18n/index.ts";
import { box } from "./tui-box.ts";
import { pixelText, type ColorMode } from "./pixel.ts";

export type InstallChannel = "terminal" | "web";

export interface ChannelPromptState {
	selected: InstallChannel;
	done: boolean;
	cancelled: boolean;
}

export type ChannelPromptEvent = { type: "key"; data: string } | { type: "mouse"; kind: "click"; y: number; x: number };

/** Rows of the two options in the rendered lines, counting the box's top edge. */
export const CHANNEL_ROW_Y = { terminal: 3, web: 4 } as const;

export function initChannelPrompt(): ChannelPromptState {
	return { selected: "terminal", done: false, cancelled: false };
}

const TOGGLE = new Set(["\x1b[A", "\x1bOA", "k", "\x1b[B", "\x1bOB", "j", "\t", "\x1b[Z"]);
const CONFIRM = new Set(["\r", "\n", " ", "\x1b[13u", "\x1b[32u"]);

export function channelPromptInput(state: ChannelPromptState, event: ChannelPromptEvent): ChannelPromptState {
	if (state.done || state.cancelled) return state;
	if (event.type === "mouse") {
		const clicked = event.y === CHANNEL_ROW_Y.terminal ? "terminal" : event.y === CHANNEL_ROW_Y.web ? "web" : undefined;
		return clicked ? { ...state, selected: clicked, done: true } : state;
	}
	const raw = event.data;
	if (raw === "1") return { ...state, selected: "terminal" };
	if (raw === "2") return { ...state, selected: "web" };
	if (TOGGLE.has(raw)) return { ...state, selected: state.selected === "terminal" ? "web" : "terminal" };
	if (CONFIRM.has(raw)) return { ...state, done: true };
	if (raw === "\x1b" || raw === "\x1b[27u" || raw.toLowerCase() === "q") return { ...state, cancelled: true };
	return state;
}

export function renderChannelPrompt(state: ChannelPromptState, width: number, mode: ColorMode = "none"): string[] {
	const option = (channel: InstallChannel, n: number) => {
		const on = state.selected === channel;
		const label = `[ ${n} ] ${t(`installer.channel.opt.${channel}`)}`;
		return `  ${on ? "▸ " : "  "}${on ? pixelText("sky", label, mode) : label}`;
	};
	const body = [t("installer.channel.choose"), "", option("terminal", 1), option("web", 2), "", pixelText("gold", t("installer.channel.hintEnter"), mode), pixelText("steel", t("installer.channel.hintEsc"), mode)];
	return box(t("installer.channel.title"), body, Math.max(40, width));
}
