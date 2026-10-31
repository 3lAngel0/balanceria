// Box-drawing helpers for the plain-text panels: titled boxes, aligned tables and
// side-by-side blocks. Pure and free of any TUI import, so widths are testable.
// Text may carry ANSI escapes and the tone marks of src/style.ts (the private-use
// characters below must stay in sync with it); neither counts as visible width and
// clipping never leaves a tone span or an ANSI style open.

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const MARKS = /\uE000[\uE010-\uE01F]|\uE001/g;
const TOKEN = /\x1b\[[0-9;?]*[A-Za-z]|\uE000[\uE010-\uE01F]|\uE001|[\s\S]/gu;
const CLOSE = "\uE001";
const ELLIPSIS = "…";

function charWidth(cp: number): number {
	if (cp === 0 || cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
	const wide =
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff);
	return wide ? 2 : 1;
}

/** Terminal cells the text occupies once escapes and tone marks are removed. */
export function cellWidth(text: string): number {
	let width = 0;
	for (const ch of text.replace(ANSI, "").replace(MARKS, "")) width += charWidth(ch.codePointAt(0)!);
	return width;
}

/** Shorten to `width` cells with an ellipsis, closing any tone span or ANSI style left open. */
export function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (cellWidth(text) <= width) return text;
	const limit = width - 1;
	let out = "";
	let used = 0;
	let open = false;
	let styled = false;
	for (const [token] of text.matchAll(TOKEN)) {
		if (token.startsWith("\x1b[")) {
			out += token;
			styled = true;
		} else if (token[0] === "\uE000") {
			out += token;
			open = true;
		} else if (token === CLOSE) {
			out += token;
			open = false;
		} else {
			const cells = charWidth(token.codePointAt(0)!);
			if (used + cells > limit) break;
			out += token;
			used += cells;
		}
	}
	return `${out}${ELLIPSIS}${open ? CLOSE : ""}${styled ? "\x1b[0m" : ""}`;
}

/** Clip to `width`, then pad with spaces to exactly `width` cells. */
export function padRight(text: string, width: number): string {
	const clipped = clip(text, width);
	return clipped + " ".repeat(Math.max(0, width - cellWidth(clipped)));
}

/** Word-wrap plain text to `width` cells; a word longer than the width is clipped. */
export function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const piece = clip(word, Math.max(1, width));
		if (line && cellWidth(line) + 1 + cellWidth(piece) > width) {
			lines.push(line);
			line = piece;
		} else line = line ? `${line} ${piece}` : piece;
	}
	return line ? [...lines, line] : lines;
}

/** Like `wrap`, but a line keeps its leading indentation and its continuations are indented two cells more. An empty line stays empty. */
export function wrapIndented(line: string, width: number): string[] {
	const indent = line.match(/^\s*/)![0];
	const parts = wrap(line.slice(indent.length), Math.max(1, width - indent.length - 2));
	if (parts.length === 0) return [indent ? "" : line];
	return parts.map((part, i) => (i === 0 ? indent : `${indent}  `) + part);
}

/** A rounded frame of exactly `width` cells with the title set into the top edge. `edge` styles the border only. */
export function box(title: string, lines: readonly string[], width: number, edge: (text: string) => string = text => text): string[] {
	const total = Math.max(8, width);
	const inner = total - 4;
	const label = title ? ` ${clip(title, total - 6)} ` : "";
	const top = `${edge("╭─")}${label}${edge(`${"─".repeat(Math.max(0, total - 3 - cellWidth(label)))}╮`)}`;
	const body = lines.map(line => `${edge("│")} ${padRight(line, inner)} ${edge("│")}`);
	return [top, ...body, edge(`╰${"─".repeat(total - 2)}╯`)];
}

export interface TableOptions {
	/** One cursor prefix per row (two cells wide, e.g. "▸ " or "  "); omitted keeps every row unprefixed. */
	prefixes?: readonly string[];
	/** Styles the header cells. */
	head?: (text: string) => string;
}

const COLUMN_GAP = 2;
const MIN_COLUMN = 4;

/** Header, a rule and aligned rows; the widest column shrinks first so the table never exceeds `width`. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[], width: number, options: TableOptions = {}): string[] {
	const prefixWidth = options.prefixes ? 2 : 0;
	const widths = headers.map((header, col) => Math.max(cellWidth(header), ...rows.map(row => cellWidth(row[col] ?? ""))));
	const available = Math.max(headers.length, width - prefixWidth - COLUMN_GAP * Math.max(0, headers.length - 1));
	while (widths.reduce((sum, w) => sum + w, 0) > available) {
		const widest = widths.indexOf(Math.max(...widths));
		if (widths[widest]! <= MIN_COLUMN) break;
		widths[widest]!--;
	}
	const gap = " ".repeat(COLUMN_GAP);
	const head = options.head ?? ((text: string) => text);
	const cells = (values: readonly string[], style: (text: string) => string = text => text) =>
		values.map((value, col) => style(padRight(value, widths[col]!))).join(gap);
	const blank = " ".repeat(prefixWidth);
	return [
		`${blank}${cells(headers, head)}`,
		`${blank}${widths.map(w => "─".repeat(w)).join("─".repeat(COLUMN_GAP))}`,
		...rows.map((row, i) => `${options.prefixes ? (options.prefixes[i] ?? "  ") : ""}${cells(row)}`),
	];
}

/** Two blocks joined row by row; the left one is padded to `leftWidth`, the right one clipped to `rightWidth`. */
export function sideBySide(left: readonly string[], right: readonly string[], leftWidth: number, rightWidth: number, gap = 1): string[] {
	const count = Math.max(left.length, right.length);
	return Array.from({ length: count }, (_unused, i) => {
		const l = padRight(left[i] ?? "", leftWidth);
		const r = right[i] === undefined ? "" : clip(right[i]!, rightWidth);
		return `${l}${r ? " ".repeat(gap) + r : ""}`;
	});
}
