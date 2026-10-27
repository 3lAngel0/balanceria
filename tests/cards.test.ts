import { test } from "node:test";
import assert from "node:assert/strict";
import { cardGrid, fitStyled, renderCard } from "../src/cards.ts";
import { paint, plain, tone } from "../src/style.ts";

test("renderCard draws a titled box whose every line is exactly the card width", () => {
	const lines = renderCard({ title: "claude 5h", body: ["62%", "resets in 2h"] }, 24).map(plain);
	assert.deepEqual(lines, [
		"╭─ claude 5h ──────────╮",
		"│ 62%                  │",
		"│ resets in 2h         │",
		"╰──────────────────────╯",
	]);
});

test("renderCard keeps toned body text colored, clips long lines with … and pads short bodies to the given height", () => {
	const lines = renderCard({ title: "t", body: [tone("success", "ok"), "a line that is far too long"] }, 16, 3);
	assert.equal(lines.length, 5);
	assert.ok(lines.every(line => plain(line).length === 16));
	assert.match(paint(lines[1], (name, text) => `<${name}>${text}</${name}>`), /<success>ok<\/success>/);
	assert.equal(plain(lines[2]), "│ a line that… │");
	assert.equal(plain(lines[3]), "│              │");
});

test("fitStyled pads to the width and only clips when the visible text is wider", () => {
	assert.equal(plain(fitStyled(tone("dim", "abc"), 5)), "abc  ");
	assert.equal(fitStyled("abcdef", 4), "abc…");
});

test("cardGrid puts as many cards per row as fit, fills the width and aligns heights per row", () => {
	const cards = [
		{ title: "a", body: ["1"] },
		{ title: "b", body: ["1", "2", "3"] },
		{ title: "c", body: ["1", "2"] },
	];
	const wide = cardGrid(cards, 92, 30).map(plain);
	assert.equal(wide.length, 5);
	assert.ok(wide.every(line => line.length === 92));
	assert.match(wide[0], /^╭─ a ─+╮ ╭─ b ─+╮ ╭─ c ─+╮$/);

	const narrow = cardGrid(cards, 62, 30).map(plain);
	assert.equal(narrow.length, 5 + 4);
	assert.match(narrow[0], /^╭─ a ─+╮ ╭─ b ─+╮$/);
	assert.match(narrow[5], /^╭─ c ─+╮$/);

	assert.equal(cardGrid(cards, 20, 30).filter(line => plain(line).startsWith("╭")).length, 3);
	assert.deepEqual(cardGrid([], 80, 30), []);
});
