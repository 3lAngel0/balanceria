// Pure hit-testing for the Control Center overlay: no TUI, no theme, so the
// geometry is testable on its own. Coordinates are overlay-local (the box the
// component rendered): column 0 is the left border, row 0 the top border.
//
// pi-tui only delivers pointer events to overlays under `TuiAltScreen`
// (`dispatchMouseToOverlay`); `TuiMainScreen` never captures the mouse, so the
// overlay stays keyboard-only there and nothing here runs.

/** Columns before the content (border + padding) and rows before the body (top border). */
export const CONTENT_X = 2;
export const CONTENT_Y = 1;

export interface TabArea<T extends string = string> {
	tab: T;
	start: number;
	end: number;
}

/** Header cells in content columns; each label is padded by one cell per side, cells are joined by two spaces. */
export function tabHitAreas<T extends string>(labels: readonly { tab: T; label: string }[]): TabArea<T>[] {
	let column = 0;
	return labels.map(({ tab, label }) => {
		const area = { tab, start: column, end: column + label.length + 2 };
		column = area.end + 2;
		return area;
	});
}

export interface HintButton {
	id: string;
	label: string;
	/** The raw key the button stands for; undefined for hints that are not a single key (arrows). */
	input?: string;
}

function keyForHint(token: string): string | undefined {
	const lower = token.toLowerCase();
	if (lower.includes("esc")) return "\x1b";
	if (lower === "enter") return "\r";
	if (lower.startsWith("1-4")) return "\t";
	if (lower === "?" || /^[a-z/]$/.test(lower)) return token;
	return undefined;
}

/** Split a ` · `-separated hint line into buttons; the first word of each segment names its key. */
export function parseHintButtons(hints: string): HintButton[] {
	return hints
		.split(" · ")
		.map(segment => segment.trim())
		.filter(Boolean)
		.map((label, index) => ({ id: `hint-${index}`, label, input: keyForHint(label.split(/\s+/)[0]) }));
}

export interface ButtonCell {
	button: HintButton;
	row: number;
	start: number;
	end: number;
	/** The text printed for this cell, brackets included. */
	text: string;
}

/** Wrap buttons onto rows no wider than `width`, one space apart. */
export function layoutButtons(buttons: readonly HintButton[], width: number): ButtonCell[] {
	const cells: ButtonCell[] = [];
	let row = 0;
	let column = 0;
	for (const button of buttons) {
		const text = `[ ${button.label} ]`;
		if (column > 0 && column + text.length > width) {
			row++;
			column = 0;
		}
		cells.push({ button, row, start: column, end: column + text.length, text });
		column += text.length + 1;
	}
	return cells;
}

export type MouseTarget =
	| { kind: "tab"; tab: string }
	| { kind: "row"; index: number }
	| { kind: "button"; id: string };

export function sameTarget(a: MouseTarget | undefined, b: MouseTarget | undefined): boolean {
	if (!a || !b) return a === b;
	if (a.kind !== b.kind) return false;
	if (a.kind === "tab") return a.tab === (b as typeof a).tab;
	if (a.kind === "row") return a.index === (b as typeof a).index;
	return a.id === (b as typeof a).id;
}

/** What the last rendered frame looked like; the mouse handler hit-tests against it. */
export interface HitLayout {
	tabAreas: readonly TabArea[];
	/** Content line (before scrolling) of each selectable row, in row order. */
	rowLines: readonly number[];
	/** First visible content line. */
	offset: number;
	/** Rows printed in the body viewport. */
	bodyRows: number;
	buttonCells: readonly ButtonCell[];
}

export function hitTest(layout: HitLayout, x: number, y: number): MouseTarget | undefined {
	const column = x - CONTENT_X;
	const bodyRow = y - CONTENT_Y;
	if (column < 0) return undefined;
	if (bodyRow >= 0 && bodyRow < layout.bodyRows) {
		const line = bodyRow + layout.offset;
		if (line === 0) {
			const area = layout.tabAreas.find(a => column >= a.start && column < a.end);
			return area ? { kind: "tab", tab: area.tab } : undefined;
		}
		const index = layout.rowLines.indexOf(line);
		return index >= 0 ? { kind: "row", index } : undefined;
	}
	// One blank row separates the body from the buttons.
	const buttonRow = bodyRow - layout.bodyRows - 1;
	const cell = layout.buttonCells.find(c => c.row === buttonRow && column >= c.start && column < c.end);
	return cell ? { kind: "button", id: cell.button.id } : undefined;
}

export const WHEEL_STEP = 3;

/** A wheel notch moves the viewport by `WHEEL_STEP` lines per unit of delta; the renderer clamps the top end. */
export function wheelOffset(offset: number, delta: number): number {
	return Math.max(0, offset + Math.sign(delta) * WHEEL_STEP * Math.max(1, Math.abs(delta)));
}

const UNDERLINE = ["\x1b[4m", "\x1b[24m"] as const;
const REVERSE = ["\x1b[7m", "\x1b[27m"] as const;

/** Hover underlines, a pressed cell is reversed for exactly one frame. */
export function emphasize(text: string, state: "hover" | "pressed" | undefined): string {
	if (!state) return text;
	const [on, off] = state === "pressed" ? REVERSE : UNDERLINE;
	return `${on}${text}${off}`;
}
