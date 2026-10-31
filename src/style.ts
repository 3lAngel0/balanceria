import { CONTEXT_ALERT_TOKENS, CONTEXT_WARN_TOKENS } from "./panel.ts";

// Semantic colors for the plain-text panels. A renderer marks a span with a
// tone; the TUI component maps tones to the active theme with `paint`, and
// tests read the text with `plain`. Marks are private-use characters that no
// real text contains. Spans do not nest.

export type Tone = "accent" | "success" | "warning" | "error" | "muted" | "dim";

const TONES: readonly Tone[] = ["accent", "success", "warning", "error", "muted", "dim"];
const OPEN = "\uE000";
const CLOSE = "\uE001";
const TONE_BASE = 0xe010;
const SPAN = /\uE000([\uE010-\uE01F])([^\uE001]*)\uE001/g;
const MARKS = /\uE000[\uE010-\uE01F]|\uE001/g;

export function tone(name: Tone, text: string): string {
	return `${OPEN}${String.fromCharCode(TONE_BASE + TONES.indexOf(name))}${text}${CLOSE}`;
}

const SGR = /\x1b\[[0-9;]*m/g;

/** The text without tone marks or color escapes. */
export function plain(line: string): string {
	return line.replace(MARKS, "").replace(SGR, "");
}

/** Replace every toned span with `style(tone, text)`; unmarked text is kept. */
export function paint(line: string, style: (name: Tone, text: string) => string): string {
	return line.replace(SPAN, (_, mark: string, text: string) => style(TONES[mark.charCodeAt(0) - TONE_BASE], text));
}

/** Green under 70%, yellow from 70%, red from 90% or when the window fills before its reset. */
export function fillTone(fraction: number, fillsBeforeReset = false): Tone {
	if (fillsBeforeReset || fraction >= 0.9) return "error";
	return fraction >= 0.7 ? "warning" : "success";
}

/** The status line thresholds: yellow from 120k tokens of context, red from 200k. */
export function contextTone(tokens: number): Tone {
	if (tokens >= CONTEXT_ALERT_TOKENS) return "error";
	return tokens >= CONTEXT_WARN_TOKENS ? "warning" : "success";
}

export const LEGEND = `${tone("success", "●")} ok   ${tone("warning", "●")} watch it   ${tone("error", "●")} full, or runs out before it refills`;
