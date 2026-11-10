// The terminal drawing of the installer: paints `installerScreen(state)` and maps keys and clicks to `installerInput` actions.
// Pure: no I/O and no clock. Every line is exactly `width` cells; clicks resolve through the `hits` of the last render.

import { t } from "./i18n/index.ts";
import type { InstallerAction, InstallerControl, InstallerDiagram, InstallerScreen } from "./installer-model.ts";
import { PALETTE, pixelText, type ColorMode } from "./pixel.ts";
import { box, cellWidth, clip, padRight, wrap } from "./tui-box.ts";

const SIDEBAR_WIDTH = 24;
const SEPARATOR = " │ ";
/** Below this width the sidebar collapses to a single "Step N of M" line. */
const WIDE_MIN = 70;
const INDENT = "      ";

export interface InstallerHit {
	/** Row and columns in the rendered lines (not counting any frame the host adds around them). */
	y: number;
	start: number;
	end: number;
	action: InstallerAction;
}

export interface InstallerView {
	lines: string[];
	hits: InstallerHit[];
}

export interface InstallerRenderOptions {
	width: number;
	mode: ColorMode;
	/** Index in `screen.buttons` of the focused button (Tab), if any. */
	focus?: number;
	/** Available height; a long list scrolls to keep its cursor row visible. */
	rows?: number;
}

interface Row {
	text: string;
	/** The list item this row belongs to. */
	item?: number;
	hits?: { start: number; end: number; action: InstallerAction }[];
}

const plainRow = (text: string): Row => ({ text });

// ---------------------------------------------------------------------------------------------
// Diagram
// ---------------------------------------------------------------------------------------------

/** "Your agent ──▶ [ Backup ] ┬─▶ 1. Google AI Pro  ✓ in use" and one row per standby member; stacked when it does not fit. */
export function renderDiagram(diagram: InstallerDiagram, width: number, mode: ColorMode = "none"): string[] {
	const agent = pixelText("steel", diagram.agent, mode);
	const backup = pixelText("gold", `[ ${diagram.backup} ]`, mode);
	const members = diagram.members;
	const names = members.map(m => `${m.order}. ${m.label}`);
	const column = Math.max(0, ...names.map(cellWidth));
	const state = (m: InstallerDiagram["members"][number]) =>
		m.state === "active" ? pixelText("hp", `✓ ${t("installer.tui.diagram.active")}`, mode) : pixelText("steel", t("installer.tui.diagram.standby", { n: m.order - 1 }), mode);
	const member = (m: InstallerDiagram["members"][number], i: number) => `${names[i]}${" ".repeat(column - cellWidth(names[i]!))}  ${state(m)}`;
	const finish = (lines: string[]) => lines.map(line => clip(line, width));
	if (members.length === 0) return finish([`${agent} ──▶ ${backup}`]);
	const head = `${agent} ──▶ ${backup} `;
	const indent = " ".repeat(cellWidth(head));
	const wide = members.map((m, i) => (i === 0 ? `${head}${members.length > 1 ? "┬─▶" : "──▶"} ${member(m, i)}` : `${indent}${i === members.length - 1 ? "└" : "├"}─▶ ${member(m, i)}`));
	if (wide.every(line => cellWidth(line) <= width)) return wide;
	return finish([`${agent} ──▶ ${backup}`, ...members.map((m, i) => `  ${i === members.length - 1 ? "└" : "├"}─▶ ${member(m, i)}`)]);
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

const PROGRESS_ICON = { done: "✓", running: "◐", pending: "○", error: "✗" } as const;
const PROGRESS_COLOR = { done: "hp", running: "sky", pending: "steel", error: "bad" } as const;

function controlRows(control: InstallerControl, cursor: number, width: number, mode: ColorMode): Row[] {
	const rows: Row[] = [];
	const pointer = (on: boolean) => (on ? pixelText("sky", "▸", mode) : " ");
	const dim = (text: string) => pixelText("steel", text, mode);
	const details = (item: number, lines: string[], hit: InstallerAction, color?: "gold") => {
		for (const line of lines) rows.push({ item, text: INDENT + (color ? pixelText(color, line, mode) : dim(line)), hits: [{ start: 0, end: width, action: hit }] });
	};
	switch (control.kind) {
		case "choice":
			control.items.forEach((item, i) => {
				const on = i === control.selected;
				const label = on ? pixelText("sky", item.label, mode) : item.label;
				const tag = item.recommended ? `  ${pixelText("gold", `[${t("installer.tui.recommended")}]`, mode)}` : "";
				const hit: InstallerAction = { type: "select", index: i };
				rows.push({ item: i, text: `${pointer(i === cursor)} ${on ? "(●)" : "( )"} ${label}${tag}`, hits: [{ start: 0, end: width, action: hit }] });
				details(i, wrap(item.description, Math.max(10, width - INDENT.length)), hit);
			});
			break;
		case "checklist":
			control.items.forEach((item, i) => {
				const hit: InstallerAction = { type: "toggle", index: i };
				const detailHit: InstallerAction = control.openable ? { type: "open", index: i } : hit;
				rows.push({ item: i, text: `${pointer(i === cursor)} ${item.checked ? "[x]" : "[ ]"} ${item.label}`, hits: [{ start: 0, end: width, action: hit }] });
				if (item.detail) details(i, wrap(item.detail, Math.max(10, width - INDENT.length)), detailHit);
				if (item.warning) details(i, wrap(`⚠ ${item.warning}`, Math.max(10, width - INDENT.length)), detailHit, "gold");
			});
			break;
		case "progress":
			for (const item of control.items) rows.push(plainRow(`  ${pixelText(PROGRESS_COLOR[item.status], PROGRESS_ICON[item.status], mode)} ${item.label}`));
			break;
		case "summary":
			control.groups.forEach((group, g) => {
				if (g > 0) rows.push(plainRow(""));
				rows.push(plainRow(pixelText("sky", group.file, mode)));
				for (const line of group.lines) wrap(line, Math.max(10, width - 4)).forEach((part, i) => rows.push(plainRow(`  ${i === 0 ? "•" : " "} ${part}`)));
			});
			break;
		case "message": {
			const color = control.tone === "error" ? "bad" : "snow";
			for (const line of wrap(control.text, width)) rows.push(plainRow(pixelText(color, line, mode)));
			if (control.hint) for (const line of wrap(control.hint, width)) rows.push(plainRow(dim(line)));
			break;
		}
	}
	return rows;
}

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------

function buttonBody(label: string, primary: boolean, enabled: boolean, mode: ColorMode): string {
	if (!enabled) return pixelText("steel", `( ${label} )`, mode);
	if (!primary) return `[ ${label} ]`;
	if (mode === "truecolor") return `[\x1b[48;2;${PALETTE.sky.join(";")};38;2;${PALETTE.ink.join(";")}m ${label} \x1b[39;49m]`;
	return pixelText("sky", `[*${label}*]`, mode);
}

const decorate = (id: string, label: string) => (id === "back" ? `◀ ${label}` : id === "next" ? `${label} ▶` : label);

function buttonRows(screen: InstallerScreen, width: number, mode: ColorMode, focus: number | undefined): Row[] {
	const rows: Row[] = [];
	let row: Row = { text: "", hits: [] };
	let used = 0;
	screen.buttons.forEach((b, i) => {
		const body = buttonBody(decorate(b.id, b.label), Boolean(b.primary), b.enabled, mode);
		const cell = `${i === focus ? pixelText("sky", "▸", mode) : " "}${body}`;
		const cells = cellWidth(cell);
		if (used > 0 && used + cells > width) {
			rows.push(row);
			row = { text: "", hits: [] };
			used = 0;
		}
		if (b.enabled) row.hits!.push({ start: used + 1, end: used + cells, action: { type: "button", id: b.id } });
		row.text += cell;
		used += cells;
	});
	rows.push(row);
	return rows;
}

// ---------------------------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------------------------

function sidebar(screen: InstallerScreen, mode: ColorMode): string[] {
	return screen.sidebar.map(item => {
		const icon = item.status === "done" ? pixelText("hp", "✓", mode) : item.status === "current" ? pixelText("sky", "●", mode) : pixelText("steel", "○", mode);
		const label = item.status === "current" ? pixelText("sky", item.label, mode) : item.status === "pending" ? pixelText("steel", item.label, mode) : item.label;
		return padRight(`${icon} ${label}`, SIDEBAR_WIDTH);
	});
}

/** Scroll `rows` to `budget` lines, keeping the cursor item in view. */
function windowRows(rows: Row[], cursor: number, budget: number): Row[] {
	if (rows.length <= budget) return rows;
	const at = Math.max(0, rows.findIndex(r => r.item === cursor));
	const start = Math.max(0, Math.min(rows.length - budget, at - Math.floor(budget / 3)));
	return rows.slice(start, start + budget);
}

export function renderInstaller(screen: InstallerScreen, options: InstallerRenderOptions): InstallerView {
	const { mode } = options;
	const width = Math.max(20, options.width);
	const wide = width >= WIDE_MIN;
	const contentWidth = wide ? width - SIDEBAR_WIDTH - SEPARATOR.length : width;
	const dim = (text: string) => pixelText("steel", text, mode);

	const head: Row[] = [plainRow(pixelText("sky", screen.title, mode)), plainRow(dim("─".repeat(contentWidth)))];
	for (const paragraph of screen.body) for (const line of wrap(paragraph, contentWidth)) head.push(plainRow(line));
	head.push(plainRow(""));

	const tail: Row[] = [];
	if (screen.diagram) tail.push(plainRow(""), ...renderDiagram(screen.diagram, contentWidth, mode).map(plainRow));
	if (screen.helpOpen) {
		const lines = [...wrap(screen.help.text, contentWidth - 4), dim(t("installer.tui.helpName", { name: screen.help.technicalName })), dim(t("installer.tui.helpFile", { file: screen.help.file }))];
		tail.push(plainRow(""), ...box(t("installer.tui.helpTitle"), lines, contentWidth).map(plainRow));
	}
	const buttons = buttonRows(screen, contentWidth, mode, options.focus);
	tail.push(plainRow(""), ...buttons);

	const footer = wrap(t("installer.tui.keys"), width).map(line => dim(line));
	const stepLine = wide ? [] : [plainRow(pixelText("steel", t("installer.tui.stepOf", { n: screen.stepNumber, total: screen.stepCount }), mode)), plainRow("")];
	const fixed = stepLine.length + head.length + tail.length + footer.length + 1;
	const budget = options.rows === undefined ? Infinity : Math.max(3, options.rows - fixed);
	const control = windowRows(controlRows(screen.control, screen.cursor, contentWidth, mode), screen.cursor, budget);

	const column = [...stepLine, ...head, ...control, ...tail];
	const left = wide ? sidebar(screen, mode) : [];
	const offset = wide ? SIDEBAR_WIDTH + SEPARATOR.length : 0;
	const count = Math.max(column.length, left.length);
	const lines: string[] = [];
	const hits: InstallerHit[] = [];
	for (let y = 0; y < count; y++) {
		const row = column[y];
		const right = padRight(row?.text ?? "", contentWidth);
		lines.push(wide ? `${padRight(left[y] ?? "", SIDEBAR_WIDTH)}${dim(SEPARATOR)}${right}` : right);
		for (const hit of row?.hits ?? []) hits.push({ y, start: offset + hit.start, end: offset + Math.min(hit.end, contentWidth), action: hit.action });
	}
	lines.push(padRight("", width), ...footer.map(line => padRight(line, width)));
	return { lines, hits };
}

/** The action under a click, in the coordinates of `InstallerView.lines`. */
export function hitInstaller(hits: readonly InstallerHit[], x: number, y: number): InstallerAction | undefined {
	return hits.find(h => h.y === y && x >= h.start && x < h.end)?.action;
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

export interface InstallerKeyResult {
	actions: InstallerAction[];
	/** The button focus after the key. */
	focus: number | undefined;
}

const UP = new Set(["\x1b[A", "\x1bOA", "k"]);
const DOWN = new Set(["\x1b[B", "\x1bOB", "j"]);
const ENTER = new Set(["\r", "\n", "\x1b[13u"]);
const SPACE = new Set([" ", "\x1b[32u"]);
const LEFT = new Set(["\x1b[D", "\x1bOD", "\x7f", "\b"]);
const RIGHT = new Set(["\x1b[C", "\x1bOC"]);
const ESCAPE = new Set(["\x1b", "\x1b[27u"]);

/** Keys -> installer actions. `focus` is the focused button, if any (Tab); moving through the list drops it. */
export function installerKey(screen: InstallerScreen, focus: number | undefined, data: string): InstallerKeyResult {
	const enabled = screen.buttons.flatMap((b, i) => (b.enabled ? [i] : []));
	const focused = focus !== undefined && enabled.includes(focus) ? screen.buttons[focus] : undefined;
	const pressed = (id: string): InstallerAction => ({ type: "button", id: id as never });
	const stay = (actions: InstallerAction[] = []): InstallerKeyResult => ({ actions, focus });
	const control = screen.control;

	if (data === "\t" || data === "\x1b[Z") {
		if (enabled.length === 0) return stay();
		const at = focus === undefined ? -1 : enabled.indexOf(focus);
		const step = data === "\t" ? 1 : -1;
		const to = at < 0 ? (step > 0 ? 0 : enabled.length - 1) : (at + step + enabled.length) % enabled.length;
		return { actions: [], focus: enabled[to] };
	}
	if (UP.has(data) || DOWN.has(data)) return { actions: [{ type: "move", delta: UP.has(data) ? -1 : 1 }], focus: undefined };
	if (ENTER.has(data) || SPACE.has(data)) {
		if (focused) return { actions: [pressed(focused.id)], focus: undefined };
		const choose: InstallerAction[] = control.kind === "choice" ? [{ type: "select", index: screen.cursor }] : [];
		if (SPACE.has(data)) return stay(control.kind === "checklist" ? [{ type: "toggle", index: screen.cursor }] : choose);
		if (control.kind === "checklist" && control.openable && ENTER.has(data)) return stay([{ type: "open", index: screen.cursor }]);
		const primary = screen.buttons.find(b => b.primary && b.enabled);
		return stay(primary ? [...choose, pressed(primary.id)] : choose);
	}
	if (LEFT.has(data)) return { actions: [{ type: "back" }], focus: undefined };
	if (RIGHT.has(data)) return { actions: [{ type: "next" }], focus: undefined };
	if (data === "?") return stay([{ type: "help" }]);
	if (ESCAPE.has(data)) return stay([{ type: "cancel" }]);
	return stay();
}
