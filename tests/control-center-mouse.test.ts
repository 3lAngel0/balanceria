import { test } from "node:test";
import assert from "node:assert/strict";
import {
	emphasize,
	hitTest,
	layoutButtons,
	parseHintButtons,
	sameTarget,
	tabHitAreas,
	wheelOffset,
	type HitLayout,
} from "../src/control-center-mouse.ts";
import { CONTROL_CENTER_TABS, controlCenterButtons, controlCenterTabLabels, renderControlCenter } from "../src/panel.ts";
import { plain } from "../src/style.ts";
import { setLang } from "../src/i18n/index.ts";
import type { FoldedEvents } from "../src/events.ts";

test("tab hit areas follow the labels renderControlCenter prints", () => {
	setLang("en");
	const labels = controlCenterTabLabels();
	const areas = tabHitAreas(labels);
	assert.deepEqual(areas.map(a => a.tab), [...CONTROL_CENTER_TABS]);
	const folded = { state: { snapshot: () => new Map(), isAvailable: () => true }, lastRoute: undefined, tokens: new Map() } as unknown as FoldedEvents;
	const header = renderControlCenter({ tab: "roles", width: 100, folded, now: 0, pools: [], providers: [] })[0];
	const text = plain(header);
	for (const area of areas) {
		const cell = text.slice(area.start, area.end);
		assert.ok(cell.includes(labels.find(l => l.tab === area.tab)!.label), `${area.tab}: "${cell}"`);
	}
	assert.equal(areas[1].start, areas[0].end + 2);
});

test("hint buttons name their key and skip arrow hints", () => {
	const buttons = parseHintButtons("1-4 or tab switch view · ↑↓ pick role · enter open · q/esc close · w wizard");
	assert.deepEqual(buttons.map(b => b.input), ["\t", undefined, "\r", "\x1b", "w"]);
	assert.equal(buttons[3].label, "q/esc close");
});

test("every Control Center tab offers help and the action list as buttons", () => {
	setLang("en");
	for (const tab of CONTROL_CENTER_TABS) {
		const inputs = controlCenterButtons(tab).map(b => b.input);
		assert.ok(inputs.includes("?"), tab);
		assert.ok(inputs.includes("/"), tab);
		assert.ok(inputs.includes("\x1b"), tab);
	}
});

test("buttons wrap onto rows no wider than the content", () => {
	const buttons = parseHintButtons("a alpha · b bravo · c charlie");
	const cells = layoutButtons(buttons, 24);
	assert.deepEqual(cells.map(c => [c.row, c.start, c.end]), [[0, 0, 11], [0, 12, 23], [1, 0, 13]]);
	assert.equal(cells[0].text, "[ a alpha ]");
});

const layout = (over: Partial<HitLayout> = {}): HitLayout => ({
	tabAreas: tabHitAreas([{ tab: "overview", label: "1 One" }, { tab: "roles", label: "2 Two" }]),
	rowLines: [4, 5],
	offset: 0,
	bodyRows: 10,
	buttonCells: layoutButtons(parseHintButtons("a alpha · b bravo"), 40),
	...over,
});

test("a pointer over a tab header, a list row or a button resolves to that target", () => {
	const l = layout();
	assert.deepEqual(hitTest(l, 2, 1), { kind: "tab", tab: "overview" });
	assert.deepEqual(hitTest(l, 2 + 9, 1), { kind: "tab", tab: "roles" });
	assert.equal(hitTest(l, 2 + 8, 1), undefined, "the gap between tabs");
	assert.deepEqual(hitTest(l, 10, 1 + 5), { kind: "row", index: 1 });
	assert.equal(hitTest(l, 10, 1 + 6), undefined);
	assert.deepEqual(hitTest(l, 2 + 12, 1 + 10 + 1), { kind: "button", id: "hint-1" });
	assert.equal(hitTest(l, 2 + 12, 1 + 10), undefined, "the blank row above the buttons");
	assert.equal(hitTest(l, 0, 1), undefined, "the border");
});

test("scrolling shifts the rows and hides the tab header", () => {
	const l = layout({ offset: 3 });
	assert.equal(hitTest(l, 3, 1), undefined, "content line 3 is no row");
	assert.deepEqual(hitTest(l, 3, 2), { kind: "row", index: 0 }, "content line 4 sits on body row 1");
	assert.deepEqual(hitTest(l, 3, 1 + 2), { kind: "row", index: 1 });
});

test("the wheel moves the viewport three lines per notch and never above the top", () => {
	assert.equal(wheelOffset(0, 1), 3);
	assert.equal(wheelOffset(6, -1), 3);
	assert.equal(wheelOffset(1, -1), 0);
	assert.equal(wheelOffset(0, 2), 6);
});

test("targets compare by kind and identity; emphasis wraps without changing the text", () => {
	assert.ok(sameTarget(undefined, undefined));
	assert.ok(!sameTarget(undefined, { kind: "row", index: 0 }));
	assert.ok(sameTarget({ kind: "row", index: 1 }, { kind: "row", index: 1 }));
	assert.ok(!sameTarget({ kind: "row", index: 1 }, { kind: "tab", tab: "roles" }));
	assert.equal(emphasize("x", undefined), "x");
	assert.equal(emphasize("x", "hover").replace(/\x1b\[[0-9;]*m/g, ""), "x");
	assert.notEqual(emphasize("x", "hover"), emphasize("x", "pressed"));
});
