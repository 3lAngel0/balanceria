import { test } from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../src/i18n/index.ts";
import { helpBox, helpFor, type HelpContext } from "../src/help-panel.ts";
import { SETUP_STEPS } from "../src/setup-stepper.ts";
import { cellWidth } from "../src/tui-box.ts";

const TABS = ["overview", "roles", "pools", "advisor"] as const;
const contexts: HelpContext[] = [
	...TABS.map(tab => ({ kind: "tab", tab }) as const),
	...SETUP_STEPS.map(step => ({ kind: "step", step }) as const),
];

test("every Control Center tab and every setup step has a short help summary in both languages", () => {
	for (const lang of ["en", "es"] as const) {
		setLang(lang);
		const seen = new Set<string>();
		for (const context of contexts) {
			const { title, paragraphs } = helpFor(context);
			assert.ok(title.length > 0);
			assert.ok(paragraphs.length >= 2 && paragraphs.length <= 4, `${lang} ${JSON.stringify(context)}`);
			assert.ok(paragraphs.every(p => !p.startsWith("setup.help.")), "no untranslated key leaks");
			seen.add(paragraphs[0]!);
		}
		assert.equal(seen.size, contexts.length, "each context has its own first paragraph");
	}
	setLang("en");
});

test("the selected pool strategy adds its explanation, unknown strategies add nothing", () => {
	setLang("en");
	const base = helpFor({ kind: "tab", tab: "pools" }).paragraphs.length;
	assert.equal(helpFor({ kind: "tab", tab: "pools", strategy: "waterfall" }).paragraphs.length, base + 1);
	assert.match(helpFor({ kind: "step", step: "strategy", strategy: "hybrid" }).paragraphs.join(" "), /most free quota/);
	assert.equal(helpFor({ kind: "tab", tab: "pools", strategy: "bogus" }).paragraphs.length, base);
});

test("the overview help also explains the quota bar and every help ends with the glossary pointer", () => {
	setLang("en");
	assert.match(helpFor({ kind: "tab", tab: "overview" }).paragraphs.join(" "), /70%/);
	for (const context of contexts) assert.match(helpFor(context).paragraphs.at(-1)!, /\/balancer help/);
});

test("helpBox is exactly as wide as asked and wraps inside the frame", () => {
	setLang("en");
	for (const width of [24, 34, 38]) {
		const lines = helpBox({ kind: "tab", tab: "roles" }, width);
		for (const line of lines) assert.equal(cellWidth(line), width);
		assert.match(lines[0]!, /Help/);
		assert.ok(lines.length > 4);
	}
});

import { HELP_MIN_WIDTH, HELP_WIDTH, helpMainWidth, helpVisible, withHelp } from "../src/help-panel.ts";
import { plain } from "../src/style.ts";

const body = (width: number) => [" 1 Overview   [2 Roles]", "", ...Array.from({ length: 3 }, (_v, i) => `${i ? "│" : "╭"} row ${i}`.padEnd(width))];

test("help is automatic from the minimum width and an explicit choice always wins", () => {
	assert.equal(helpVisible(undefined, HELP_MIN_WIDTH), true);
	assert.equal(helpVisible(undefined, HELP_MIN_WIDTH - 1), false);
	assert.equal(helpVisible(false, 200), false);
	assert.equal(helpVisible(true, 60), true);
	assert.equal(helpMainWidth(110, true), 110 - HELP_WIDTH - 1);
	assert.equal(helpMainWidth(110, false), 110);
	assert.equal(helpMainWidth(HELP_MIN_WIDTH - 1, true), HELP_MIN_WIDTH - 1, "narrow terminals keep the full width for the content");
});

test("wide layout puts the Help box on the right of the body and keeps the tab header full width", () => {
	setLang("en");
	const inner = 110;
	const main = helpMainWidth(inner, true);
	const out = withHelp(body(main), { kind: "tab", tab: "roles" }, inner, true);
	assert.equal(out[0], body(main)[0], "header untouched");
	const text = out.map(plain);
	assert.ok(text.some(line => /╭─ Help ─+╮$/.test(line)), "Help box top border sits on the right edge");
	assert.ok(text.some(line => line.startsWith("╭ row 0")));
	for (const line of out) assert.ok(cellWidth(line) <= inner, plain(line));
	assert.ok(out.length >= body(main).length);
});

test("narrow layout stacks a full-width Help box under the content and hidden help changes nothing", () => {
	setLang("en");
	const inner = 80;
	const lines = body(inner);
	const stacked = withHelp(lines, { kind: "tab", tab: "pools" }, inner, true);
	assert.deepEqual(stacked.slice(0, lines.length), lines);
	assert.ok(stacked.slice(lines.length).map(plain).some(line => /^╭─ Help ─+╮$/.test(line) && cellWidth(line) === inner));
	assert.deepEqual(withHelp(lines, { kind: "tab", tab: "pools" }, inner, false), lines);
});
