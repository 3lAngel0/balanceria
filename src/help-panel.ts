// The contextual "Help" box shown beside the Control Center and the setup stepper:
// a short plain-language summary of what the current view is for.

import { t } from "./i18n/index.ts";
import type { ControlCenterTab } from "./panel.ts";
import type { SetupStep } from "./setup-stepper.ts";
import { plain } from "./style.ts";
import { box, sideBySide, wrap } from "./tui-box.ts";

export type HelpContext =
	| { kind: "tab"; tab: ControlCenterTab; strategy?: string }
	| { kind: "step"; step: SetupStep; strategy?: string };

export interface HelpContent {
	title: string;
	paragraphs: string[];
}

const STRATEGIES = new Set(["hybrid", "waterfall", "highest-quota"]);

/** Plain-language paragraphs for the current view, plus the selected pool strategy when there is one. */
export function helpFor(context: HelpContext): HelpContent {
	const paragraphs = [t(context.kind === "tab" ? `setup.help.tab.${context.tab}` : `setup.help.step.${context.step}`)];
	if (context.kind === "tab" && context.tab === "overview") paragraphs.push(t("setup.help.quota"));
	if (context.strategy && STRATEGIES.has(context.strategy)) paragraphs.push(t(`setup.help.strategy.${context.strategy}`));
	paragraphs.push(t("setup.help.footer"));
	return { title: t("setup.help.title"), paragraphs };
}

/** The Help box at `width` cells: paragraphs wrapped to the inner width, separated by a blank row. */
export function helpBox(context: HelpContext, width: number, edge?: (text: string) => string): string[] {
	const { title, paragraphs } = helpFor(context);
	const inner = Math.max(4, width - 4);
	const lines = paragraphs.flatMap((paragraph, i) => [...(i > 0 ? [""] : []), ...wrap(paragraph, inner)]);
	return box(title, lines, width, edge);
}

/** Inner overlay width from which the Help box sits on the right; narrower overlays stack it below. */
export const HELP_MIN_WIDTH = 96;
export const HELP_WIDTH = 34;

/** Shown automatically on wide overlays; an explicit toggle (`?`) always wins. */
export function helpVisible(explicit: boolean | undefined, inner: number): boolean {
	return explicit ?? inner >= HELP_MIN_WIDTH;
}

/** Width left for the main content once the right-hand Help box is drawn. */
export function helpMainWidth(inner: number, visible: boolean): number {
	return visible && inner >= HELP_MIN_WIDTH ? inner - HELP_WIDTH - 1 : inner;
}

/**
 * Add the Help box to rendered overlay lines. The lines before the first box (the tab header and notices)
 * stay full width; the body is joined side by side on wide overlays and followed by a full-width box on narrow ones.
 */
export function withHelp(rendered: readonly string[], context: HelpContext, inner: number, visible: boolean, edge?: (text: string) => string): string[] {
	if (!visible) return [...rendered];
	if (inner < HELP_MIN_WIDTH) return [...rendered, "", ...helpBox(context, inner, edge)];
	const start = rendered.findIndex(line => plain(line).startsWith("╭"));
	const split = start < 0 ? rendered.length : start;
	return [...rendered.slice(0, split), ...sideBySide(rendered.slice(split), helpBox(context, HELP_WIDTH, edge), helpMainWidth(inner, true), HELP_WIDTH, 1)];
}
