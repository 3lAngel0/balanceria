import { plain, tone, type Tone } from "./style.ts";

// Text charts on a fixed 0-100% scale: a y axis with labeled ticks, columns
// drawn in eighths of a row, a dot where there was no reading, and marks on
// the x axis. Lines carry style tones and no trailing spaces.

const LEVELS = "▁▂▃▄▅▆▇█";
const NO_READING = "·";
const PROJECTION = "•";
const HOUR_MS = 3_600_000;

/** A run of cells, each a character with an optional tone. */
type Cell = [char: string, color: Tone | null];

/** Join cells, one tone span per run of the same tone. */
function joinCells(cells: readonly Cell[]): string {
	let line = "";
	let run = "";
	let color: Tone | null = null;
	const flush = () => {
		if (run) line += color ? tone(color, run) : run;
		run = "";
	};
	for (const [char, cellTone] of cells) {
		if (cellTone !== color) {
			flush();
			color = cellTone;
		}
		run += char;
	}
	flush();
	return line.trimEnd();
}

/** The y-axis prefix of a row, `rows` rows tall and counted from the top: 100% on top, 50% halfway. */
function axisLabel(row: number, rows: number): string {
	const label = row === 0 ? "100%" : rows % 2 === 0 && row === rows / 2 ? "50%" : "";
	return `${label.padStart(4)} ${label ? "┤" : "│"}`;
}

const ZERO_AXIS = "  0% ┼";

/** Height of a percent in eighths of a row. */
function eighths(percent: number, rows: number): number {
	return Math.round((Math.max(0, Math.min(100, percent)) / 100) * rows * 8);
}

/** The block of a column of `height` eighths in the row `row` from the top. */
function block(height: number, row: number, rows: number): string {
	const fill = height - (rows - 1 - row) * 8;
	if (fill <= 0) return " ";
	return LEVELS[Math.min(8, fill) - 1];
}

/** The row from the top where a value sits as a single dot. */
function dotRow(percent: number, rows: number): number {
	const fromBottom = Math.min(rows - 1, Math.max(0, Math.ceil((Math.min(100, percent) / 100) * rows) - 1));
	return rows - 1 - fromBottom;
}

export interface PercentColumn {
	/** null: no reading that day. */
	percent: number | null;
	tone: Tone;
	/** Mark the column on the x axis with a red ▲. */
	mark?: boolean;
}

/** Columns `cell` characters wide (the bar, then one space when wider than 1) on a 0-100% axis. */
export function percentColumns(columns: readonly PercentColumn[], options: { rows: number; cell: number }): string[] {
	const { rows, cell } = options;
	const bar = cell > 1 ? cell - 1 : 1;
	const gap = cell - bar;
	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		const cells: Cell[] = [];
		for (const column of columns) {
			if (column.percent === null) {
				cells.push(row === rows - 1 ? [NO_READING, "dim"] : [" ", null], ...pad(bar - 1 + gap));
				continue;
			}
			// A day with a reading of 0% keeps a sliver, so it does not read as "no reading".
			const height = Math.max(1, eighths(column.percent, rows));
			const char = block(height, row, rows);
			const color = column.percent === 0 ? "dim" : column.tone;
			for (let index = 0; index < bar; index++) cells.push(char === " " ? [" ", null] : [char, color]);
			cells.push(...pad(gap));
		}
		lines.push(tone("dim", axisLabel(row, rows)) + joinCells(cells));
	}
	const axis: Cell[] = columns.flatMap(column => [
		column.mark ? ["▲", "error"] : ["─", "dim"],
		...new Array<Cell>(cell - 1).fill(["─", "dim"]),
	] as Cell[]);
	lines.push(tone("dim", ZERO_AXIS) + joinCells(axis));
	return lines;
}

function pad(count: number): Cell[] {
	return new Array<Cell>(Math.max(0, count)).fill([" ", null]);
}

export interface ChartLabel {
	/** Chart column (0 = first cell after the axis). */
	at: number;
	text: string;
	align: "left" | "center" | "right";
	tone?: Tone;
}

/**
 * Labels under a chart, placed in the given order (most important first); a
 * label that would touch one already placed is dropped.
 */
export function labelRow(labels: readonly ChartLabel[]): string {
	const placed: { start: number; end: number; label: ChartLabel }[] = [];
	for (const label of labels) {
		const length = label.text.length;
		const wanted = label.align === "left" ? label.at : label.align === "right" ? label.at - length + 1 : label.at - Math.floor(length / 2);
		const start = Math.max(0, wanted);
		const end = start + length - 1;
		if (placed.some(other => start <= other.end + 1 && end >= other.start - 1)) continue;
		placed.push({ start, end, label });
	}
	placed.sort((a, b) => a.start - b.start);
	let line = " ".repeat(ZERO_AXIS.length);
	let column = 0;
	for (const { start, label } of placed) {
		line += " ".repeat(start - column) + tone(label.tone ?? "dim", label.text);
		column = start + label.text.length;
	}
	return plain(line).trim() ? line : "";
}

export interface WindowChartInput {
	/** Readings of this window, oldest first. */
	points: readonly { ts: number; percent: number }[];
	start: number;
	reset: number;
	now: number;
	/** Current pace; null or 0 draws no projection unless the window is already full. */
	percentPerHour: number | null;
	tone: Tone;
	/** Chart columns, each the same slice of time. */
	width: number;
	rows: number;
	clock: (ts: number) => string;
}

/** The used percent at `ts`, linear between readings; null before the first one. */
function usedAt(points: WindowChartInput["points"], ts: number): number | null {
	if (points.length === 0 || ts < points[0].ts) return null;
	for (let index = 1; index < points.length; index++) {
		const before = points[index - 1];
		const after = points[index];
		if (ts <= after.ts) {
			const span = after.ts - before.ts;
			return span <= 0 ? after.percent : before.percent + ((after.percent - before.percent) * (ts - before.ts)) / span;
		}
	}
	return points[points.length - 1].percent;
}

/**
 * One window from its start to its reset: the used area up to now, then dots
 * at the current pace until the reset (capped at 100%), with `now` (┴), the
 * time it fills (▲) and the reset (┤) on the axis and labeled under it.
 */
export function windowChart(input: WindowChartInput): string[] {
	const { points, start, reset, now, rows, width } = input;
	const slice = (reset - start) / width;
	const latest = points.length > 0 ? points[points.length - 1].percent : null;
	const rate = input.percentPerHour ?? 0;
	const projects = latest !== null && (latest >= 100 || rate > 0);
	const fullAt = latest === null ? null : latest >= 100 ? null : rate > 0 ? now + ((100 - latest) / rate) * HOUR_MS : null;
	const fills = fullAt !== null && fullAt < reset;
	const columnOf = (ts: number) => Math.max(0, Math.min(width - 1, Math.floor((ts - start) / slice)));

	const grid: Cell[][] = Array.from({ length: rows }, () => new Array<Cell>(width).fill([" ", null]));
	for (let column = 0; column < width; column++) {
		const ts = start + (column + 0.5) * slice;
		if (ts <= now) {
			const used = usedAt(points, ts);
			if (used === null) {
				grid[rows - 1][column] = [NO_READING, "dim"];
				continue;
			}
			const height = Math.max(1, eighths(used, rows));
			for (let row = 0; row < rows; row++) {
				const char = block(height, row, rows);
				if (char !== " ") grid[row][column] = [char, input.tone];
			}
		} else if (projects) {
			const projected = Math.min(100, latest! + (rate * (ts - now)) / HOUR_MS);
			grid[dotRow(projected, rows)][column] = [PROJECTION, input.tone];
		}
	}

	const lines = grid.map((cells, row) => tone("dim", axisLabel(row, rows)) + joinCells(cells));
	const axis: Cell[] = new Array<Cell>(width).fill(["─", "dim"]);
	const nowColumn = now > start && now < reset ? columnOf(now) : null;
	if (nowColumn !== null) axis[nowColumn] = ["┴", "dim"];
	if (fills) axis[columnOf(fullAt!)] = ["▲", "error"];
	lines.push(tone("dim", ZERO_AXIS) + joinCells([...axis, ["┤", "dim"]]));

	const labels: ChartLabel[] = [{ at: width, text: `reset ${input.clock(reset)}`, align: "right" }];
	if (nowColumn !== null) labels.push({ at: nowColumn, text: `now ${input.clock(now)}`, align: "center" });
	if (fills) labels.push({ at: columnOf(fullAt!), text: `full ${input.clock(fullAt!)}`, align: "center", tone: "error" });
	labels.push({ at: 0, text: input.clock(start), align: "left" });
	const row = labelRow(labels);
	if (row) lines.push(row);
	return lines;
}
