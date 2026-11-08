// Language selection dialog shown before /balancer setup starts.
// Pure view and state machine: maps keyboard and pointer events to state changes.

import { t, type Lang } from "./i18n/index.ts";
import { box } from "./tui-box.ts";
import { pixelText, type ColorMode } from "./pixel.ts";

export interface LangPromptState {
	selected: Lang;
	persist: boolean;
	done: boolean;
	cancelled: boolean;
}

export type LangPromptEvent =
	| { type: "key"; data: string }
	| { type: "mouse"; kind: "click"; y: number; x: number };

export function initLangPrompt(currentLang: Lang = "es"): LangPromptState {
	return {
		selected: currentLang === "es" ? "es" : "en",
		persist: false,
		done: false,
		cancelled: false,
	};
}

export function langPromptInput(state: LangPromptState, event: LangPromptEvent): LangPromptState {
	if (state.done || state.cancelled) return state;

	if (event.type === "key") {
		const raw = event.data;
		const k = raw.toLowerCase();
		if (k === "1" || k === "e" || k === "s") {
			return { ...state, selected: "es" };
		}
		if (k === "2" || k === "i") {
			return { ...state, selected: "en" };
		}
		if (
			raw === "\x1b[A" ||
			raw === "\x1bOA" ||
			raw === "k" ||
			raw === "\x1b[B" ||
			raw === "\x1bOB" ||
			raw === "j" ||
			raw === "\t" ||
			raw === "\x1b[Z"
		) {
			return { ...state, selected: state.selected === "es" ? "en" : "es" };
		}
		if (k === "p") {
			return { ...state, persist: true, done: true };
		}
		if (raw === "\r" || raw === "\n" || raw === " " || raw === "\x1b[13u" || raw === "\x1b[32u") {
			return { ...state, persist: false, done: true };
		}
		if (raw === "\x1b" || raw === "\x1b[27u" || k === "q") {
			return { ...state, cancelled: true };
		}
	} else if (event.type === "mouse" && event.kind === "click") {
		// Allow click toggling
		return { ...state, selected: state.selected === "es" ? "en" : "es" };
	}

	return state;
}

export function renderLangPrompt(state: LangPromptState, width: number, mode: ColorMode = "none"): string[] {
	const inner = Math.max(40, width);

	const title = t("setup.langPrompt.title");
	const isEs = state.selected === "es";

	const esMarker = isEs ? "▸ " : "  ";
	const enMarker = !isEs ? "▸ " : "  ";

	const esLabel = `[ 1 ] ${t("setup.langPrompt.opt.es")}`;
	const enLabel = `[ 2 ] ${t("setup.langPrompt.opt.en")}`;

	const esLine = `${esMarker}${isEs ? pixelText("sky", esLabel, mode) : esLabel}`;
	const enLine = `${enMarker}${!isEs ? pixelText("sky", enLabel, mode) : enLabel}`;

	const body: string[] = [
		t("setup.langPrompt.choose"),
		"",
		`  ${esLine}`,
		`  ${enLine}`,
		"",
		pixelText("gold", t("setup.langPrompt.hintEnter"), mode),
		pixelText("hp", t("setup.langPrompt.hintPersist"), mode),
		pixelText("steel", t("setup.langPrompt.hintEsc"), mode),
	];

	return box(title, body, inner);
}
