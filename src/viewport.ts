import { tone } from "./style.ts";

// Pure vertical viewport over plain/toned lines when a panel is taller than
// the terminal. When lines are clipped, the last visible row carries a dim
// scroll indicator so the user sees what is hidden above or below.

export interface ViewportSlice {
	lines: string[];
	offset: number;
	above: number;
	below: number;
}

export function scrollStep(height: number): number {
	return Math.max(1, height - 2);
}

function scrollNotice(above: number, below: number): string {
	if (above > 0 && below > 0) return tone("dim", `↑ ${above} above · ↓ ${below} more lines · pgup/pgdn`);
	if (above > 0) return tone("dim", `↑ ${above} above · pgup`);
	return tone("dim", `↓ ${below} more lines · pgdn`);
}

export function sliceViewport(lines: readonly string[], offset: number, height: number): ViewportSlice {
	if (lines.length <= height) {
		return { lines: [...lines], offset: 0, above: 0, below: 0 };
	}
	const contentHeight = Math.max(1, height - 1);
	const maxOffset = Math.max(0, lines.length - contentHeight);
	const clamped = Math.max(0, Math.min(maxOffset, offset));
	const above = clamped;
	const below = Math.max(0, lines.length - (clamped + contentHeight));
	return {
		lines: [...lines.slice(clamped, clamped + contentHeight), scrollNotice(above, below)],
		offset: clamped,
		above,
		below,
	};
}

export function keepRowVisible(offset: number, row: number, totalLines: number, height: number): number {
	if (totalLines <= height || row < 0) return 0;
	const contentHeight = Math.max(1, height - 1);
	const maxOffset = Math.max(0, totalLines - contentHeight);
	let next = offset;
	if (row < next) next = row;
	else if (row >= next + contentHeight) next = row - contentHeight + 1;
	return Math.max(0, Math.min(maxOffset, next));
}
