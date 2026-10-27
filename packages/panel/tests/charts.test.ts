import test from "node:test";
import assert from "node:assert/strict";
import { shownSeries, stackedBars, stepLines, toggleSeries } from "../ui/charts.ts";

test("series visibility is kept by name: a series that appears on a later poll is shown", () => {
	const hidden = toggleSeries(new Set(), "agy");
	assert.deepEqual(shownSeries(["claude-bridge", "agy"], hidden), [true, false]);
	assert.deepEqual(shownSeries(["agy", "new-provider", "claude-bridge"], hidden), [false, true, true]);
	assert.deepEqual(shownSeries(["agy"], toggleSeries(hidden, "agy")), [true]);
	assert.deepEqual([...hidden], ["agy"]);
});

test("stackedBars stacks the visible series per day on whole pixels, scaled to the tallest day", () => {
	const { bars, max } = stackedBars(
		[
			[10, 0, 30],
			[10, 20, 10],
		],
		[true, true],
		{ width: 30, height: 40, gap: 2 },
	);
	assert.equal(max, 40);
	assert.deepEqual(bars, [
		{ day: 0, series: 0, value: 10, x: 0, y: 30, width: 8, height: 10 },
		{ day: 0, series: 1, value: 10, x: 0, y: 20, width: 8, height: 10 },
		{ day: 1, series: 1, value: 20, x: 10, y: 20, width: 8, height: 20 },
		{ day: 2, series: 0, value: 30, x: 20, y: 10, width: 8, height: 30 },
		{ day: 2, series: 1, value: 10, x: 20, y: 0, width: 8, height: 10 },
	]);
});

test("stackedBars leaves hidden series out of the bars and the scale", () => {
	const { bars, max } = stackedBars(
		[
			[10, 0, 30],
			[10, 20, 10],
		],
		[false, true],
		{ width: 30, height: 40, gap: 2 },
	);
	assert.equal(max, 20);
	assert.deepEqual(
		bars.map(b => [b.day, b.series, b.y, b.height]),
		[
			[0, 1, 20, 20],
			[1, 1, 0, 40],
			[2, 1, 20, 20],
		],
	);
});

test("stackedBars with nothing visible or only zeros draws no bars", () => {
	assert.deepEqual(stackedBars([[1, 2]], [false], { width: 20, height: 10, gap: 0 }), { bars: [], max: 0 });
	assert.deepEqual(stackedBars([[0, 0]], [true], { width: 20, height: 10, gap: 0 }), { bars: [], max: 0 });
});

test("stepLines draws one stepped path per run of days with a value; null days break the line", () => {
	assert.deepEqual(stepLines([50, 100, null, 0], { width: 40, height: 20, max: 100 }), ["M0 10H10V0H20", "M30 20H40"]);
	assert.deepEqual(stepLines([null, null], { width: 20, height: 20, max: 100 }), []);
	assert.deepEqual(stepLines([150], { width: 10, height: 20, max: 100 }), ["M0 0H10"]);
});
