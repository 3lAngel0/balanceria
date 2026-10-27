import { plain, tone, type Tone } from "./style.ts";

// Box cards for the plain-text panels, and a grid that lays them side by side.
// Widths count visible characters only: tone marks are free, so toned lines
// keep their colors unless they have to be clipped.

export interface Card {
	title: string;
	body: readonly string[];
	/** Tone of the title; the border stays dim. */
	titleTone?: Tone;
}

/** Pad a (possibly toned) line to exactly `width` columns, clipping with … when it is wider. */
export function fitStyled(line: string, width: number): string {
	const text = plain(line);
	if (text.length <= width) return line + " ".repeat(width - text.length);
	return `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** One card exactly `width` columns wide: a titled top border, the body and a bottom border. */
export function renderCard(card: Card, width: number, height = card.body.length): string[] {
	const outer = Math.max(8, width);
	const inner = outer - 4;
	const title = fitStyled(card.title, Math.min(plain(card.title).length, outer - 5)).trimEnd();
	const rule = "─".repeat(Math.max(0, outer - 5 - plain(title).length));
	const top = `${tone("dim", "╭─")} ${card.titleTone ? tone(card.titleTone, title) : title} ${tone("dim", `${rule}╮`)}`;
	const rows = [...card.body];
	while (rows.length < height) rows.push("");
	const body = rows.map(line => `${tone("dim", "│")} ${fitStyled(line, inner)} ${tone("dim", "│")}`);
	return [top, ...body, tone("dim", `╰${"─".repeat(outer - 2)}╯`)];
}

/** How many cards fit per row and how wide each one is, so content can be sized before it is boxed. */
export function gridLayout(count: number, width: number, minWidth: number, gap = 1): { columns: number; cardWidth: number } {
	const columns = Math.max(1, Math.min(Math.max(1, count), Math.floor((width + gap) / (minWidth + gap))));
	return { columns, cardWidth: Math.floor((width - gap * (columns - 1)) / columns) };
}

/**
 * Cards in rows that fill `width`: as many columns as fit at `minWidth` each,
 * one column gap between them. Cards in the same row share the tallest body.
 */
export function cardGrid(cards: readonly Card[], width: number, minWidth: number, gap = 1): string[] {
	if (cards.length === 0) return [];
	const { columns, cardWidth } = gridLayout(cards.length, width, minWidth, gap);
	const lines: string[] = [];
	for (let start = 0; start < cards.length; start += columns) {
		const row = cards.slice(start, start + columns);
		const height = Math.max(...row.map(card => card.body.length));
		const rendered = row.map(card => renderCard(card, cardWidth, height));
		for (let index = 0; index < rendered[0].length; index++) {
			lines.push(rendered.map(card => card[index]).join(" ".repeat(gap)));
		}
	}
	return lines;
}
