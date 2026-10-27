import { test } from "node:test";
import assert from "node:assert/strict";
import { contextTone, fillTone, LEGEND, paint, plain, tone } from "../src/style.ts";

const brackets = (line: string) => paint(line, (name, text) => `<${name}>${text}</${name}>`);

test("a toned span keeps its text and plain() strips the marks", () => {
	const line = `  ${tone("error", "▰▰▰")}  100%  ${tone("dim", "resets in 2h")}`;
	assert.equal(plain(line), "  ▰▰▰  100%  resets in 2h");
	assert.equal(brackets(line), "  <error>▰▰▰</error>  100%  <dim>resets in 2h</dim>");
});

test("text without marks paints unchanged", () => {
	assert.equal(brackets("plain line"), "plain line");
	assert.equal(plain("plain line"), "plain line");
});

test("window fill: green under 70%, yellow from 70%, red from 90% or when it fills before the reset", () => {
	assert.deepEqual([0, 0.69, 0.7, 0.89, 0.9, 1].map(fraction => fillTone(fraction)), ["success", "success", "warning", "warning", "error", "error"]);
	assert.equal(fillTone(0.2, true), "error");
});

test("context size: green under 120k, yellow from 120k, red from 200k, like the status line", () => {
	assert.deepEqual([119_999, 120_000, 199_999, 200_000].map(contextTone), ["success", "warning", "warning", "error"]);
});

test("the legend names the three colors in plain words", () => {
	assert.equal(plain(LEGEND), "● ok   ● watch it   ● full, or runs out before it refills");
	assert.equal(brackets(LEGEND), "<success>●</success> ok   <warning>●</warning> watch it   <error>●</error> full, or runs out before it refills");
});
