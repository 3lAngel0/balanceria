import assert from "node:assert/strict";
import test from "node:test";
import { plain } from "../src/style.ts";
import { keepRowVisible, scrollStep, sliceViewport } from "../src/viewport.ts";

const LINES = Array.from({ length: 10 }, (_, index) => `line ${index}`);

test("sliceViewport returns all lines unchanged when they fit the height", () => {
	const view = sliceViewport(LINES.slice(0, 4), 3, 6);
	assert.equal(view.offset, 0);
	assert.equal(view.above, 0);
	assert.equal(view.below, 0);
	assert.deepEqual(view.lines, ["line 0", "line 1", "line 2", "line 3"]);
});

test("sliceViewport clips to height, reserves one row for the scroll notice, and clamps offset", () => {
	const top = sliceViewport(LINES, -2, 5);
	assert.equal(top.offset, 0);
	assert.equal(top.above, 0);
	assert.equal(top.below, 6);
	assert.equal(top.lines.length, 5);
	assert.deepEqual(top.lines.map(plain), ["line 0", "line 1", "line 2", "line 3", "↓ 6 more lines · pgdn"]);

	const mid = sliceViewport(LINES, 3, 5);
	assert.equal(mid.offset, 3);
	assert.equal(mid.above, 3);
	assert.equal(mid.below, 3);
	assert.deepEqual(mid.lines.map(plain), ["line 3", "line 4", "line 5", "line 6", "↑ 3 above · ↓ 3 more lines · pgup/pgdn"]);

	const bottom = sliceViewport(LINES, 99, 5);
	assert.equal(bottom.offset, 6);
	assert.equal(bottom.above, 6);
	assert.equal(bottom.below, 0);
	assert.deepEqual(bottom.lines.map(plain), ["line 6", "line 7", "line 8", "line 9", "↑ 6 above · pgup"]);
});

test("keepRowVisible scrolls only when the selected row leaves the visible window", () => {
	assert.equal(keepRowVisible(0, 2, 10, 5), 0);
	assert.equal(keepRowVisible(0, 4, 10, 5), 1);
	assert.equal(keepRowVisible(4, 2, 10, 5), 2);
	assert.equal(keepRowVisible(3, 2, 4, 6), 0);
});

test("scrollStep moves by most of a page and at least one line", () => {
	assert.equal(scrollStep(10), 8);
	assert.equal(scrollStep(2), 1);
});
