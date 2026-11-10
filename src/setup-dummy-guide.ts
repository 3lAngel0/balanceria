// Interactive pedagogical guide shown by /balancer setup: a mode selector, then
// Act 1 (the balance animation, slides 0..5) and Act 2 (the architecture, slides 6..8).
// Pure view and state machines: keyboard events map to state changes, renderers return lines.

import { t } from "./i18n/index.ts";
import { box, clip, wrap } from "./tui-box.ts";
import { marchingArrows, pixelText, renderSprite, scaleSprite, type ColorMode } from "./pixel.ts";

export type SetupMode = "guided" | "advanced";

export interface ModePromptState {
	selected: SetupMode;
	done: boolean;
	cancelled: boolean;
}

export interface KeyEvent {
	type: "key";
	data: string;
}

const isEnter = (raw: string) => raw === "\r" || raw === "\n" || raw === " " || raw === "\x1b[13u" || raw === "\x1b[32u";
const isEsc = (raw: string) => raw === "\x1b" || raw === "\x1b[27u" || raw === "q";
const isNext = (raw: string) => isEnter(raw) || raw === "\x1b[C" || raw === "\x1bOC" || raw === "l";
const isBack = (raw: string) => raw === "\x1b[D" || raw === "\x1bOD" || raw === "h" || raw === "\x7f" || raw === "\b";

export function initModePrompt(defaultMode: SetupMode = "guided"): ModePromptState {
	return { selected: defaultMode, done: false, cancelled: false };
}

export function modePromptInput(state: ModePromptState, event: KeyEvent): ModePromptState {
	if (state.done || state.cancelled) return state;
	const raw = event.data;
	const k = raw.toLowerCase();
	if (k === "1" || k === "g") return { ...state, selected: "guided" };
	if (k === "2" || k === "a") return { ...state, selected: "advanced" };
	if (["\x1b[A", "\x1bOA", "\x1b[B", "\x1bOB", "\t", "\x1b[Z", "j", "k"].includes(raw)) {
		return { ...state, selected: state.selected === "guided" ? "advanced" : "guided" };
	}
	if (isEnter(raw)) return { ...state, done: true };
	if (isEsc(raw)) return { ...state, cancelled: true };
	return state;
}

export function renderModePrompt(state: ModePromptState, width: number, mode: ColorMode = "none"): string[] {
	const inner = Math.max(40, width);
	const textWidth = inner - 8;
	const option = (selected: boolean, label: string): string[] => {
		const wrapped = wrap(label, textWidth);
		return wrapped.map((line, i) => `  ${i === 0 ? (selected ? "▸ " : "  ") : "  "}${selected ? pixelText("sky", line, mode) : line}`);
	};
	const guided = state.selected === "guided";
	const body = [
		t("setup.modePrompt.choose"),
		"",
		...option(guided, `[ 1 ] ${t("setup.modePrompt.opt.guided")}`),
		...option(!guided, `[ 2 ] ${t("setup.modePrompt.opt.advanced")}`),
		"",
		pixelText("gold", t("setup.modePrompt.hintEnter"), mode),
		pixelText("steel", t("setup.modePrompt.hintEsc"), mode),
	];
	return box(t("setup.modePrompt.title"), body.map(l => clip(l, inner - 4)), inner);
}

export const LAST_SLIDE = 8;

export interface DummyGuideState {
	/** 0..5 = Act 1, 6..8 = Act 2. */
	slide: number;
	providers: readonly string[];
	done: boolean;
	skipped: boolean;
	cancelled: boolean;
}

export function initDummyGuide(detectedProviders: readonly string[] = []): DummyGuideState {
	return { slide: 0, providers: [...detectedProviders], done: false, skipped: false, cancelled: false };
}

export function dummyGuideInput(state: DummyGuideState, event: KeyEvent): DummyGuideState {
	if (state.done || state.cancelled) return state;
	const raw = event.data;
	if (raw.toLowerCase() === "s") return { ...state, done: true, skipped: true };
	if (isEsc(raw)) return { ...state, cancelled: true };
	if (isNext(raw)) {
		return state.slide >= LAST_SLIDE ? { ...state, done: true } : { ...state, slide: state.slide + 1 };
	}
	if (isBack(raw)) return { ...state, slide: Math.max(0, state.slide - 1) };
	return state;
}

const POOL = "pool/claude-sonnet-5-5";
const GOOGLE = "Google AI Pro";
const CLAUDE = "Claude Pro";

export function renderDummyGuide(
	state: DummyGuideState,
	width: number,
	mode: ColorMode = "none",
	frame = 0,
	animate = false,
): string[] {
	const inner = Math.max(40, width);
	const textWidth = inner - 6;
	const slide = Math.min(LAST_SLIDE, Math.max(0, state.slide));
	const agent = t("setup.dummy.agent");
	const bad = (s: string) => pixelText("bad", s, mode);
	const good = (s: string) => pixelText("hp", s, mode);
	const sky = (s: string) => pixelText("sky", s, mode);
	const gold = (s: string) => pixelText("gold", s, mode);
	const steel = (s: string) => pixelText("steel", s, mode);
	const para = (key: string) => wrap(t(key), textWidth);
	const sprite = () => renderSprite(scaleSprite(frame, animate), mode).map(l => `  ${l}`);

	let heading: string;
	let body: string[];

	switch (slide) {
		case 0:
			heading = t("setup.dummy.act1", { n: 1 });
			body = [...para("setup.dummy.s0.text"), "", `  ${sky(`[ ${agent} ]`)}  ${gold(t("setup.dummy.s0.request"))}`];
			break;
		case 1:
			heading = t("setup.dummy.act1", { n: 2 });
			body = [...para("setup.dummy.s1.text"), "", `  ${sky(`[ ${agent} ]`)} ──▶ ${gold(GOOGLE)}`];
			break;
		case 2:
			heading = t("setup.dummy.act1", { n: 3 });
			body = [
				...para("setup.dummy.s2.text"),
				"",
				`  ${sky(`[ ${agent} ]`)} ──✖ ${bad(GOOGLE)}`,
				`  ${bad(t("setup.dummy.s2.error"))}`,
			];
			break;
		case 3:
			heading = t("setup.dummy.act1", { n: 4 });
			body = [
				...para("setup.dummy.s3.text"),
				"",
				...sprite(),
				`  ${sky(POOL)}`,
				`    ├─ ${gold(GOOGLE)}`,
				`    └─ ${gold(CLAUDE)}`,
			];
			break;
		case 4:
			heading = t("setup.dummy.act1", { n: 5 });
			body = [
				...para("setup.dummy.s4.text"),
				"",
				`  ${sky(`[ ${agent} ]`)} ──▶ ${sky(`[ ${POOL} ]`)}`,
				`    ${marchingArrows(frame, 3, mode, animate)} ${good(GOOGLE)} ${steel(`(${t("setup.dummy.s4.quota")})`)}`,
				`    ${steel("·")} ${steel(CLAUDE)}`,
			];
			break;
		case 5:
			heading = t("setup.dummy.act1", { n: 6 });
			body = [
				...para("setup.dummy.s5.text"),
				"",
				...sprite(),
				`  ${sky(`[ ${agent} ]`)} ──▶ ${sky(`[ ${POOL} ]`)}`,
				`    ${bad(`${GOOGLE} ✖ ${t("setup.dummy.s5.error")}`)}`,
				`    ${marchingArrows(frame, 3, mode, animate)} ${good(`${CLAUDE} ✔`)}`,
			];
			break;
		case 6: {
			heading = t("setup.dummy.act2", { n: 1 });
			const list = state.providers.length > 0 ? t("setup.dummy.s6.detected", { list: state.providers.join(", ") }) : t("setup.dummy.s6.none");
			body = [
				gold(t("setup.dummy.s6.title")),
				...para("setup.dummy.s6.text"),
				"",
				`  ${sky(t("setup.dummy.s6.file"))}`,
				...wrap(list, textWidth).map(l => `  ${state.providers.length > 0 ? good(l) : steel(l)}`),
			];
			break;
		}
		case 7:
			heading = t("setup.dummy.act2", { n: 2 });
			body = [
				gold(t("setup.dummy.s7.title")),
				...para("setup.dummy.s7.text"),
				"",
				`  ${sky(t("setup.dummy.s7.file"))}`,
				`  ${sky(POOL)} ◀ ${GOOGLE} + ${CLAUDE}`,
			];
			break;
		default:
			heading = t("setup.dummy.act2", { n: 3 });
			body = [
				gold(t("setup.dummy.s8.title")),
				...para("setup.dummy.s8.text"),
				"",
				`  ${sky(t("setup.dummy.s8.file"))}`,
				`  ${good(t("setup.dummy.s8.example"))}`,
			];
	}

	const lines = [steel(heading), "", ...body, "", steel(t("setup.dummy.keys"))].flatMap(l => wrap(l, inner - 4));
	return box(t("setup.dummy.title"), lines.map(l => clip(l, inner - 4)), inner);
}
