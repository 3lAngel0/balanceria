// The terminal drawing of the installer: paints `installerScreen(state)` and maps keys and clicks to `installerInput` actions.
// Pure: no I/O and no clock. Every line is exactly `width` cells; clicks resolve through the `hits` of the last render.

import { t } from "./i18n/index.ts";
import type { InstallerAction, InstallerControl, InstallerDiagram, InstallerScreen } from "./installer-model.ts";
import { MASCOT_WIDTH, mascotPoseFor, renderMascot } from "./installer-mascot.ts";
import { PALETTE, pixelBar, pixelSpinner, pixelText, type ColorMode } from "./pixel.ts";
import { box, cellWidth, clip, padRight, wrap } from "./tui-box.ts";

const SIDEBAR_WIDTH = 24;
const SEPARATOR = " │ ";
/** Below this width the sidebar collapses to a single "Step N of M" line. */
const WIDE_MIN = 70;
/** From this width the help panel is a fixed column on the right; below it the help goes under the content. */
const HELP_SIDE_MIN = 110;
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
	/** The animation frame and whether motion is on (false: every animated piece rests, whatever the frame). */
	frame?: number;
	animate?: boolean;
	/** The clock for the elapsed seconds of a running analysis (the renderer reads none); defaults to its start. */
	now?: number;
}

interface Row {
	text: string;
	/** The list item this row belongs to. */
	item?: number;
	hits?: { start: number; end: number; action: InstallerAction }[];
	/** A URL on this row that becomes an OSC 8 hyperlink when color is on (applied after padding, so widths stay exact). */
	link?: string;
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

function controlRows(control: InstallerControl, cursor: number, width: number, mode: ColorMode, running: string): Row[] {
	const rows: Row[] = [];
	const pointer = (on: boolean) => (on ? pixelText("sky", "▸", mode) : " ");
	const dim = (text: string) => pixelText("steel", text, mode);
	const details = (item: number, lines: string[], hit: InstallerAction, color?: "gold" | "bad") => {
		for (const line of lines) rows.push({ item, text: INDENT + (color ? pixelText(color, line, mode) : dim(line)), hits: [{ start: 0, end: width, action: hit }] });
	};
	switch (control.kind) {
		case "choice":
			control.items.forEach((item, i) => {
				const on = i === control.selected;
				const label = on ? pixelText("sky", item.label, mode) : item.label;
				const tag = item.recommended && item.label !== t("installer.tui.recommended") ? `  ${pixelText("gold", `[${t("installer.tui.recommended")}]`, mode)}` : "";
				const hit: InstallerAction = { type: "select", index: i };
				rows.push({ item: i, text: `${pointer(i === cursor)} ${on ? "(●)" : "( )"} ${label}${tag}`, hits: [{ start: 0, end: width, action: hit }] });
				details(i, wrap(item.description, Math.max(10, width - INDENT.length)), hit);
				if (item.dangerWarning) details(i, wrap(`⚠ ${item.dangerWarning}`, Math.max(10, width - INDENT.length)), hit, "bad");
			});
			break;
		case "checklist":
			control.items.forEach((item, i) => {
				const hit: InstallerAction = { type: "toggle", index: i };
				const detailHit: InstallerAction = control.openable ? { type: "open", index: i } : hit;
				const assigned = item.assigned ? `  ${pixelText("sky", `→ ${item.assigned}`, mode)}` : "";
				rows.push({ item: i, text: `${pointer(i === cursor)} ${item.checked ? "[x]" : "[ ]"} ${item.label}${assigned}`, hits: [{ start: 0, end: width, action: hit }] });
				if (item.detail) details(i, wrap(item.detail, Math.max(10, width - INDENT.length)), detailHit);
				if (item.warning) details(i, wrap(`⚠ ${item.warning}`, Math.max(10, width - INDENT.length)), detailHit, "gold");
				if (item.dangerWarning) details(i, wrap(`⚠ ${item.dangerWarning}`, Math.max(10, width - INDENT.length)), detailHit, "bad");
			});
			break;
		case "progress":
			for (const item of control.items) rows.push(plainRow(`  ${pixelText(PROGRESS_COLOR[item.status], item.status === "running" ? running : PROGRESS_ICON[item.status], mode)} ${item.label}`));
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

/** Only the focused button is highlighted; at rest every enabled button, the primary one included, is plain. */
function buttonBody(label: string, focused: boolean, enabled: boolean, mode: ColorMode): string {
	if (!enabled) return pixelText("steel", `( ${label} )`, mode);
	if (!focused) return `[ ${label} ]`;
	if (mode === "truecolor") return `[\x1b[48;2;${PALETTE.sky.join(";")};38;2;${PALETTE.ink.join(";")}m ${label} \x1b[39;49m]`;
	return pixelText("sky", `[*${label}*]`, mode);
}

const decorate = (id: string, label: string) => (id === "back" ? `◀ ${label}` : id === "next" ? `${label} ▶` : label);

const NAV_BUTTONS = ["back", "next", "cancel"];

/** Action buttons on their own row(s), then the navigation row (back, next, cancel). `focus` indexes screen.buttons. */
function buttonRows(screen: InstallerScreen, width: number, mode: ColorMode, focus: number | undefined): Row[] {
	const rows: Row[] = [];
	const group = (indexes: number[]) => {
		let row: Row = { text: "", hits: [] };
		let used = 0;
		for (const i of indexes) {
			const b = screen.buttons[i]!;
			const body = buttonBody(decorate(b.id, b.label), i === focus, b.enabled, mode);
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
		}
		rows.push(row);
	};
	const all = screen.buttons.map((_b, i) => i);
	const actions = all.filter(i => !NAV_BUTTONS.includes(screen.buttons[i]!.id));
	if (actions.length > 0) group(actions);
	group(all.filter(i => NAV_BUTTONS.includes(screen.buttons[i]!.id)));
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

const hyperlink = (url: string) => `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;

/** "Technical name:" then the value on the same row, or on its own row when the panel is too narrow to keep it whole. */
function labelled(label: string, value: string, width: number): string[] {
	const line = `${label} ${value}`;
	return cellWidth(line) <= width ? [line] : [label, ...wrap(value, Math.max(4, width - 2)).map(part => `  ${part}`)];
}

/** The help panel: the step in plain words plus the option under the cursor (what it is, what it is for, what happens, technical name and file). */
function helpBox(screen: InstallerScreen, width: number, mode: ColorMode): string[] {
	const inner = Math.max(4, width - 4);
	const dim = (text: string) => pixelText("steel", text, mode);
	const head = (text: string) => pixelText("gold", text, mode);
	const lines: string[] = [...wrap(screen.help.text, inner), "", ...wrap(screen.help.purpose, inner)];
	const focus = screen.help.focus;
	const technical = (name: string, file: string) => {
		const label = (key: string, value: string) => t(key, { name: value, file: value }).replace(value, "").trim();
		lines.push("", ...labelled(label("installer.tui.helpName", name), name, inner).map(dim), ...labelled(label("installer.tui.helpFile", file), file, inner).map(dim));
	};
	if (focus) {
		lines.push("", pixelText("sky", clip(focus.label, inner), mode));
		for (const [title, body] of [["what", focus.what], ["purpose", focus.purpose], ["if", focus.ifPicked]] as const) lines.push(head(t(`installer.tui.help.${title}`)), ...wrap(body, inner));
		technical(focus.technicalName, focus.file);
	} else technical(screen.help.technicalName, screen.help.file);
	return box(t("installer.tui.helpTitle"), lines, width);
}

/** Key hints as an aligned grid inside a rounded box titled with the prefix: keys padded to the widest, equal-width columns, filled column-major. */
function shortcutRows(screen: InstallerScreen, width: number, mode: ColorMode, compact = false): Row[] {
	if (screen.shortcuts.length === 0) return [];
	const name = (key: string) => (key === " " ? t("installer.tui.key.space") : key === "enter" ? t("installer.tui.key.enter") : key);
	const inner = compact ? width : Math.max(4, width - 4);
	const keyWidth = Math.max(...screen.shortcuts.map(h => cellWidth(name(h.key))));
	const items = screen.shortcuts.map(h => {
		const key = name(h.key);
		const label = clip(h.label, Math.max(1, inner - keyWidth - 1));
		const pad = " ".repeat(keyWidth - cellWidth(key));
		const plain = `${key}${pad} ${label}`;
		return { width: cellWidth(plain), text: h.enabled ? `${pixelText("sky", key, mode)}${pad} ${label}` : pixelText("steel", plain, mode) };
	});
	const GAP = 3;
	const column = Math.max(...items.map(i => i.width));
	const fit = Math.max(1, Math.min(items.length, Math.floor((inner + GAP) / (column + GAP))));
	const count = Math.ceil(items.length / fit);
	const cols = Math.ceil(items.length / count);
	const grid: string[] = [];
	for (let r = 0; r < count; r++) {
		let line = "";
		for (let c = 0; c < cols; c++) {
			const item = items[c * count + r];
			if (!item) break;
			const last = (c + 1) * count + r >= items.length;
			line += last ? item.text : item.text + " ".repeat(column - item.width + GAP);
		}
		grid.push(line);
	}
	// When the height is short (`compact`) the frame is dropped; the grid itself stays.
	if (compact) return grid.map(plainRow);
	const title = t("installer.tui.shortcuts").replace(/\s*:\s*$/, "");
	return box(title, grid, width, edge => pixelText("steel", edge, mode)).map(plainRow);
}

/** The ways of choosing which subscription goes first, for the focused backup; only the current one is explained. */
function methodRows(screen: InstallerScreen, width: number, mode: ColorMode): Row[] {
	const detail = screen.backupDetail;
	if (!detail) return [];
	const rows: Row[] = [plainRow(pixelText("sky", clip(t("installer.tui.method.title", { name: detail.name }), width), mode))];
	for (const m of detail.methods) {
		rows.push(plainRow(`  ${m.selected ? pixelText("sky", `(●) ${m.label}`, mode) : `( ) ${m.label}`}`));
		if (m.selected) for (const line of wrap(m.description, Math.max(10, width - INDENT.length))) rows.push(plainRow(INDENT + pixelText("steel", line, mode)));
	}
	return rows;
}

/** Spinner, elapsed seconds and an indeterminate bar while the deep analysis runs; then the confirmation line. */
function activityRows(screen: InstallerScreen, width: number, mode: ColorMode, frame: number, animate: boolean, now: number | undefined): Row[] {
	const rows: Row[] = [];
	if (screen.pending) {
		const seconds = Math.max(0, Math.floor(((now ?? screen.pending.startedAt) - screen.pending.startedAt) / 1000));
		const spinner = pixelSpinner(animate ? frame : 0);
		wrap(screen.pending.label, Math.max(10, width - 2)).forEach((line, i) => rows.push(plainRow(`${i === 0 ? pixelText("sky", spinner, mode) : " "} ${pixelText("gold", line, mode)}`)));
		const elapsed = t("installer.tui.pending.elapsed", { seconds });
		const size = Math.max(6, Math.min(24, width - cellWidth(elapsed) - 4));
		rows.push(plainRow(`  ${elapsed}  ${indeterminateBar(size, frame, animate, mode)}`));
	}
	if (screen.confirmation) wrap(`✓ ${screen.confirmation}`, width).forEach((line, i) => rows.push(plainRow(pixelText("hp", i === 0 ? line : `  ${line}`, mode))));
	return rows;
}

const BAR_WINDOW = 6;

/** A fixed-size bar with a lit window that bounces along it; with motion off, a half-filled resting bar. */
function indeterminateBar(size: number, frame: number, animate: boolean, mode: ColorMode): string {
	if (!animate) return pixelBar(0.35, size, { mode });
	const span = Math.max(1, size - BAR_WINDOW);
	const at = Math.max(0, Math.floor(frame)) % (span * 2);
	const start = at <= span ? at : span * 2 - at;
	return Array.from({ length: size }, (_unused, i) => (i >= start && i < start + BAR_WINDOW ? pixelText("sky", "▰", mode) : pixelText("slate", "▱", mode))).join("");
}

/** The welcome glossary and what the installer will do; `compact` keeps only the star link. */
function welcomeRows(welcome: NonNullable<InstallerScreen["welcome"]>, width: number, mode: ColorMode, compact: boolean): Row[] {
	const rows: Row[] = [];
	const dim = (text: string) => pixelText("steel", text, mode);
	if (!compact) {
		rows.push(plainRow(pixelText("sky", welcome.definitionsTitle, mode)));
		for (const d of welcome.definitions) {
			wrap(`${d.term}: ${d.text}`, Math.max(10, width - 4)).forEach((line, i) => {
				const coloured = i === 0 ? line.replace(d.term, pixelText("gold", d.term, mode)) : line;
				rows.push(plainRow(`${i === 0 ? "  " : "    "}${coloured}`));
			});
		}
		rows.push(plainRow(""), plainRow(pixelText("sky", welcome.willDoTitle, mode)));
		welcome.willDo.forEach(item => wrap(item, Math.max(10, width - 4)).forEach((line, i) => rows.push(plainRow(`  ${i === 0 ? "•" : " "} ${line}`))));
		rows.push(plainRow(""));
	}
	const text = welcome.star.text.replace(welcome.star.url, "").replace(/\s*:\s*$/, ":").trim();
	wrap(text, Math.max(10, width - 2)).forEach((line, i) => rows.push(plainRow(`${i === 0 ? pixelText("gold", "★", mode) : " "} ${line}`)));
	rows.push({ text: `  ${pixelText("sky", welcome.star.url, mode)}`, link: welcome.star.url });
	rows.push(plainRow(""));
	return rows;
}

/** The human summary: what the balancer will do, the review sentence, the detail indented and the closing line; blocked warnings in gold. */
function summaryRows(screen: InstallerScreen, width: number, mode: ColorMode): Row[] {
	const summary = screen.summary;
	if (!summary) return [];
	const warnings = new Set(screen.body.slice(2));
	const rows: Row[] = [];
	for (const line of wrap(summary.narrative, width)) rows.push(plainRow(line));
	rows.push(plainRow(""));
	for (const line of wrap(summary.review, width)) rows.push(plainRow(pixelText("sky", line, mode)));
	for (const item of summary.detail) {
		const warn = warnings.has(item);
		wrap(item, Math.max(10, width - 4)).forEach((line, i) => rows.push(plainRow(`  ${i === 0 ? (warn ? "⚠" : "•") : " "} ${warn ? pixelText("gold", line, mode) : line}`)));
	}
	rows.push(plainRow(""));
	for (const line of wrap(summary.closing, width)) rows.push(plainRow(pixelText("sky", line, mode)));
	return rows;
}

export function renderInstaller(screen: InstallerScreen, options: InstallerRenderOptions): InstallerView {
	const { mode } = options;
	const frame = options.frame ?? 0;
	const animate = options.animate ?? false;
	const width = Math.max(20, options.width);
	const wide = width >= WIDE_MIN;
	const panel = width >= HELP_SIDE_MIN && !screen.helpOpen;
	const helpWidth = panel ? Math.min(48, Math.max(36, Math.floor(width * 0.3))) : 0;
	const mainWidth = wide ? width - SIDEBAR_WIDTH - SEPARATOR.length : width;
	const contentWidth = panel ? mainWidth - SEPARATOR.length - helpWidth : mainWidth;
	const dim = (text: string) => pixelText("steel", text, mode);
	const pose = mascotPoseFor(screen.step, Boolean(screen.pending));
	const footer = wrap(t("installer.tui.keys"), width).map(line => dim(line));
	const stepLine = wide ? [] : [plainRow(pixelText("steel", t("installer.tui.stepOf", { n: screen.stepNumber, total: screen.stepCount }), mode)), plainRow("")];
	const innerBox = Math.max(4, contentWidth - 4);

	/** What is drawn above and below the control; `tier` drops the optional blocks (mascot, glossary, help under the content) when the height is short. */
	const around = (tier: number) => {
		const head: Row[] = [];
		if (pose && tier < 1 && contentWidth >= MASCOT_WIDTH) head.push(...renderMascot(pose, frame, animate, mode).map(plainRow), plainRow(""));
		if (screen.error) {
			const edge = (text: string) => pixelText("bad", text, mode);
			head.push(plainRow(dim("─".repeat(contentWidth))), ...box(screen.error.title, [...wrap(screen.error.what, innerBox), "", ...wrap(screen.error.todo, innerBox)], contentWidth, edge).map(plainRow), plainRow(""));
		} else {
			head.push(plainRow(pixelText("sky", screen.title, mode)), plainRow(dim("─".repeat(contentWidth))));
			screen.body.forEach((paragraph, i) => {
				const warn = screen.summary !== undefined && i >= 2;
				for (const line of wrap(paragraph, contentWidth - (warn ? 2 : 0))) head.push(plainRow(warn ? `${pixelText("gold", "⚠", mode)} ${pixelText("gold", line, mode)}` : line));
			});
			head.push(plainRow(""));
			if (screen.welcome) head.push(...welcomeRows(screen.welcome, contentWidth, mode, tier >= 2));
			head.push(...summaryRows(screen, contentWidth, mode));
		}
		const tail: Row[] = [];
		if (screen.diagram) tail.push(plainRow(""), ...renderDiagram(screen.diagram, contentWidth, mode).map(plainRow));
		const method = methodRows(screen, contentWidth, mode);
		if (method.length > 0) tail.push(plainRow(""), ...method);
		const activity = activityRows(screen, contentWidth, mode, frame, animate, options.now);
		if (activity.length > 0) tail.push(plainRow(""), ...activity);
		const hints = shortcutRows(screen, contentWidth, mode, tier >= 3);
		if (hints.length > 0) tail.push(plainRow(""), ...hints, ...(screen.notice && tier < 3 ? [plainRow("")] : []));
		if (screen.notice) wrap(screen.notice, Math.max(10, contentWidth - 2)).forEach((line, i) => tail.push(plainRow(`${i === 0 ? pixelText("gold", "ℹ", mode) : " "} ${pixelText("gold", line, mode)}`)));
		tail.push(plainRow(""), ...buttonRows(screen, contentWidth, mode, options.focus));
		if (!panel && !screen.helpOpen && tier < 3) tail.push(plainRow(""), ...helpBox(screen, contentWidth, mode).map(plainRow));
		return { head, tail };
	};
	const showsControl = !(screen.error && screen.control.kind === "message") && !(screen.summary && screen.control.kind === "summary");
	const running = animate ? pixelSpinner(frame) : "◐";
	let tier = 0;
	let layout = around(tier);
	const fixed = () => stepLine.length + layout.head.length + layout.tail.length + footer.length + 1;
	while (options.rows !== undefined && tier < 3 && fixed() + 3 > options.rows) layout = around(++tier);
	const budget = options.rows === undefined ? Infinity : Math.max(3, options.rows - fixed());
	const control = showsControl ? windowRows(controlRows(screen.control, screen.cursor, contentWidth, mode, running), screen.cursor, budget) : [];

	const column = [...stepLine, ...layout.head, ...control, ...layout.tail];
	const left = wide ? sidebar(screen, mode) : [];
	const right = panel ? helpBox(screen, helpWidth, mode) : [];
	const offset = wide ? SIDEBAR_WIDTH + SEPARATOR.length : 0;
	const count = Math.max(column.length, left.length, right.length);
	const lines: string[] = [];
	const hits: InstallerHit[] = [];
	for (let y = 0; y < count; y++) {
		const row = column[y];
		let text = padRight(row?.text ?? "", contentWidth);
		if (row?.link && mode !== "none") text = text.replace(row.link, hyperlink(row.link));
		const side = panel ? `${dim(SEPARATOR)}${padRight(right[y] ?? "", helpWidth)}` : "";
		lines.push(`${wide ? `${padRight(left[y] ?? "", SIDEBAR_WIDTH)}${dim(SEPARATOR)}` : ""}${text}${side}`);
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

// ---------------------------------------------------------------------------------------------
// Raw key data -> the legacy sequences the mapping below works on
// ---------------------------------------------------------------------------------------------

const CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::\d*)?(?:;(\d*)(?::(\d+))?)?(?:;[\d:]*)?u$/;
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;
const CSI_ARROW = /^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/;
const SHIFT = 1;
const LOCKS = 64 | 128;
const RELEASE = 3;
const KEYPAD_ENTER = 57414;
const FUNCTIONAL_FIRST = 57344;

/** A decoded key: the legacy bytes for it, "" for a key release, or undefined when it is not a plain or shifted key. */
function decodeKey(code: number, shifted: number | undefined, modifiers: number, event: number): string | undefined {
	if (event === RELEASE) return "";
	const mods = modifiers & ~LOCKS;
	if (mods & ~SHIFT) return undefined;
	const shift = (mods & SHIFT) !== 0;
	if (code === 13 || code === KEYPAD_ENTER) return "\r";
	if (code === 27) return "\x1b";
	if (code === 9) return shift ? "\x1b[Z" : "\t";
	if (code === 127 || code === 8) return "\x7f";
	if (code === 32) return " ";
	if (code < 33 || code >= FUNCTIONAL_FIRST) return undefined;
	const char = String.fromCodePoint(shift && shifted ? shifted : code);
	return shift && !shifted ? char.toUpperCase() : char;
}

/**
 * Pi hands overlays raw input in either terminal protocol (legacy bytes, kitty CSI-u, xterm modifyOtherKeys). This turns the
 * enhanced encodings of Space, Enter, Tab, Esc, Backspace, arrows and printable keys into the legacy bytes the mapping below
 * knows, ignores the lock modifiers (Caps/Num Lock) and drops key releases (""), so one press acts once. Anything else is
 * returned unchanged.
 */
export function canonicalKey(data: string): string {
	const arrow = CSI_ARROW.exec(data);
	if (arrow) {
		if (Number(arrow[2] ?? 1) === RELEASE) return "";
		return (Number(arrow[1]) - 1) & ~LOCKS ? data : `\x1b[${arrow[3]}`;
	}
	const other = MODIFY_OTHER_KEYS.exec(data);
	if (other) return decodeKey(Number(other[2]), undefined, Number(other[1]) - 1, 1) ?? data;
	const kitty = CSI_U.exec(data);
	if (kitty) return decodeKey(Number(kitty[1]), kitty[2] ? Number(kitty[2]) : undefined, Number(kitty[3] || 1) - 1, Number(kitty[4] ?? 1)) ?? data;
	return data;
}

const UP = new Set(["\x1b[A", "\x1bOA", "k"]);
const DOWN = new Set(["\x1b[B", "\x1bOB", "j"]);
const ENTER = new Set(["\r", "\n", "\x1b[13u"]);
const SPACE = new Set([" ", "\x1b[32u"]);
const LEFT = new Set(["\x1b[D", "\x1bOD", "\x7f", "\b"]);
const RIGHT = new Set(["\x1b[C", "\x1bOC"]);
const ESCAPE = new Set(["\x1b", "\x1b[27u"]);

/** Keys -> installer actions. `focus` is the focused button, if any (Tab); moving through the list drops it. */
export function installerKey(screen: InstallerScreen, focus: number | undefined, raw: string): InstallerKeyResult {
	const data = canonicalKey(raw);
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
	// The step's own letters (u/j order, s how to choose, c new backup, a / d on tasks) come before plain movement, only while they apply.
	const letter = data.length === 1 && data !== " " ? data.toLowerCase() : "";
	const hint = letter ? screen.shortcuts.find(h => h.enabled && h.key === letter) : undefined;
	if (hint) return { actions: [hint.action], focus: undefined };
	if (data === "") return stay();
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
