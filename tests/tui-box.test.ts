import { test } from "node:test";
import assert from "node:assert/strict";
import { tone, plain } from "../src/style.ts";
import { box, cellWidth, clip, padRight, sideBySide, table, wrap } from "../src/tui-box.ts";

test("cellWidth ignores ANSI and tone marks and counts wide characters as two cells", () => {
	assert.equal(cellWidth("abc"), 3);
	assert.equal(cellWidth("\x1b[31mabc\x1b[0m"), 3);
	assert.equal(cellWidth(tone("accent", "abc")), 3);
	assert.equal(cellWidth("日本"), 4);
	assert.equal(cellWidth("▸ ✓"), 3);
});

test("clip keeps short text, shortens long text with an ellipsis and never leaves a span open", () => {
	assert.equal(clip("hello", 10), "hello");
	assert.equal(clip("hello world", 6), "hello…");
	assert.equal(cellWidth(clip("hello world", 6)), 6);
	const clipped = clip(tone("accent", "hello world"), 6);
	assert.equal(plain(clipped), "hello…");
	assert.match(clipped, /\uE001$/, "the tone span is closed after the ellipsis");
	assert.equal(clip("\x1b[1mhello world\x1b[0m", 6).endsWith("\x1b[0m"), true);
	assert.equal(clip("anything", 0), "");
});

test("padRight pads to the exact width and clips overflow", () => {
	assert.equal(cellWidth(padRight("ab", 6)), 6);
	assert.equal(cellWidth(padRight(tone("dim", "abcdefghij"), 6)), 6);
	assert.equal(cellWidth(padRight("日本", 6)), 6);
});

test("wrap breaks on words by cell width", () => {
	assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
	assert.deepEqual(wrap("", 10), []);
	assert.ok(wrap("supercalifragilistic", 8).every(line => cellWidth(line) <= 8));
});

test("box draws a titled rounded frame of the exact width", () => {
	const lines = box("Pools", ["alpha", tone("accent", "beta")], 20);
	assert.equal(lines.length, 4);
	for (const line of lines) assert.equal(cellWidth(line), 20);
	assert.match(plain(lines[0]!), /^╭─ Pools ─+╮$/);
	assert.match(plain(lines[1]!), /^│ alpha\s+│$/);
	assert.match(plain(lines[3]!), /^╰─+╯$/);
});

test("box clips a long title and long lines, and survives tiny widths", () => {
	const lines = box("A very long title that cannot fit", ["x".repeat(50)], 16);
	for (const line of lines) assert.equal(cellWidth(line), 16);
	assert.doesNotThrow(() => box("t", ["x"], 1));
	assert.doesNotThrow(() => box("", [], 0));
});

test("box applies the edge callback to its border only", () => {
	const lines = box("T", ["body"], 12, text => `<${text}>`);
	assert.match(lines[1]!, /^<│> body\s+<│>$/);
});

test("table aligns columns, draws a header rule and keeps the cursor prefix", () => {
	const lines = table(["Role", "Model"], [["coder", "pool/a"], ["reviewer", "pool/bb"]], 40, { prefixes: ["▸ ", "  "] });
	assert.equal(lines.length, 4);
	assert.match(plain(lines[0]!), /^ {2}Role\s+Model/);
	assert.match(plain(lines[1]!), /^ {2}─+/);
	assert.ok(plain(lines[2]!).startsWith("▸ coder"));
	assert.ok(plain(lines[3]!).startsWith("  reviewer"));
	const starts = lines.filter((_, i) => i !== 1).map(line => plain(line).indexOf("pool/") >= 0 ? plain(line).indexOf("pool/") : plain(line).indexOf("Model"));
	assert.equal(new Set(starts).size, 1, "the second column starts at the same cell on every row");
});

test("table shrinks its widest column to fit and never exceeds the width", () => {
	const lines = table(["A", "B"], [["short", "y".repeat(80)]], 30);
	for (const line of lines) assert.ok(cellWidth(line) <= 30, plain(line));
	assert.ok(plain(lines[2]!).includes("…"));
	assert.doesNotThrow(() => table([], [], 10));
});

test("sideBySide joins two blocks row by row and pads the shorter one", () => {
	const lines = sideBySide(["l1", "l2", "l3"], ["r1"], 6, 4, 2);
	assert.equal(lines.length, 3);
	assert.equal(plain(lines[0]!), "l1      r1");
	assert.equal(plain(lines[2]!).trimEnd(), "l3");
	for (const line of lines) assert.ok(cellWidth(line) <= 6 + 2 + 4);
});

import { wrapIndented } from "../src/tui-box.ts";

test("wrapIndented wraps long lines keeping their indentation and indents continuations", () => {
	assert.deepEqual(wrapIndented("  • pools.json: Unchanged", 40), ["  • pools.json: Unchanged"]);
	const out = wrapIndented("    drops the rule prefer-for-role coder because its candidate was removed", 30);
	assert.ok(out.length > 1);
	assert.ok(out[0]!.startsWith("    drops"));
	assert.ok(out.slice(1).every(line => line.startsWith("      ")), "continuations are indented two more cells");
	for (const line of out) assert.ok(cellWidth(line) <= 30, line);
	assert.deepEqual(wrapIndented("", 10), [""]);
});
