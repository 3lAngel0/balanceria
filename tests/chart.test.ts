import assert from "node:assert/strict";
import test from "node:test";
import { labelRow, percentColumns, windowChart } from "../src/chart.ts";
import { paint, plain } from "../src/style.ts";

const tones = (lines: string[]) => lines.map(line => paint(line, (name, text) => `<${name}>${text}</${name}>`));
const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 18, 12).getTime();

test("percent columns: a 0-100% axis, sub-row heights, a dot for no reading and a fill marker on the axis", () => {
	const lines = percentColumns(
		[
			{ percent: 100, tone: "error", mark: true },
			{ percent: 50, tone: "success" },
			{ percent: null, tone: "success" },
			{ percent: 0, tone: "success" },
		],
		{ rows: 4, cell: 3 },
	);
	assert.deepEqual(lines.map(plain), [
		"100% ┤██",
		"     │██",
		" 50% ┤██ ██",
		"     │██ ██ ·  ▁▁",
		"  0% ┼▲───────────",
	]);
	const toned = tones(lines);
	assert.match(toned[0], /<error>██<\/error>/);
	assert.match(toned[3], /<success>██<\/success> <dim>·<\/dim>/);
	assert.match(toned[4], /<error>▲<\/error>/);
});

test("percent columns use eighths of a row, so 60% is not drawn like 50%", () => {
	const lines = percentColumns([{ percent: 60, tone: "success" }], { rows: 4, cell: 1 }).map(plain);
	// 60% of 32 eighths is 19: two full rows and 3/8 of the third.
	assert.deepEqual(lines.slice(0, 4), ["100% ┤", "     │▃", " 50% ┤█", "     │█"]);
});

test("label row: labels in priority order, a later label that would touch an earlier one is dropped", () => {
	const row = labelRow([
		{ at: 24, text: "reset 13:00", align: "right" },
		{ at: 10, text: "now", align: "center" },
		{ at: 0, text: "08:00", align: "left" },
		{ at: 12, text: "full 12:30", align: "left" },
	]);
	assert.equal(plain(row), "      08:00    now  reset 13:00");
});

test("window chart: the used area so far, the projection as dots, now and full marks on the axis", () => {
	const lines = windowChart({
		points: [
			{ ts: NOW - 3 * HOUR, percent: 10 },
			{ ts: NOW - HOUR, percent: 40 },
			{ ts: NOW, percent: 60 },
		],
		start: NOW - 4 * HOUR,
		reset: NOW + HOUR,
		now: NOW,
		percentPerHour: 80,
		tone: "error",
		width: 10,
		rows: 4,
		clock: ts => `${(ts - NOW) / HOUR}h`,
	});
	const text = lines.map(plain);
	assert.deepEqual(text.slice(0, 5), [
		"100% ┤        ••",
		"     │       ▂",
		" 50% ┤    ▁▄▆█",
		"     │··▄▇████",
		"  0% ┼────────┴▲┤",
	]);
	const toned = tones(lines);
	assert.match(toned[0], /<error>••<\/error>/);
	assert.match(toned[3], /<dim>··<\/dim><error>▄▇████<\/error>/);
	assert.match(toned[4], /<error>▲<\/error>/);
});

test("window chart labels the start, now, the full time and the reset under the axis when they fit", () => {
	const lines = windowChart({
		points: [{ ts: NOW - 2 * HOUR, percent: 10 }, { ts: NOW, percent: 50 }],
		start: NOW - 5 * HOUR,
		reset: NOW + 5 * HOUR,
		now: NOW,
		percentPerHour: 20,
		tone: "warning",
		width: 60,
		rows: 4,
		clock: ts => `${(ts - NOW) / HOUR}h`,
	});
	const labels = plain(lines[5]);
	assert.match(labels, /^ {6}-5h\b/);
	assert.match(labels, /\bnow 0h\b/);
	assert.match(labels, /\bfull 2\.5h\b/);
	assert.match(labels, /\breset 5h$/);
	assert.equal(lines.length, 6);
});

test("window chart without a pace draws no projection and no full mark; a projection stops at the reset", () => {
	const flat = windowChart({
		points: [{ ts: NOW - HOUR, percent: 20 }, { ts: NOW, percent: 20 }],
		start: NOW - 4 * HOUR, reset: NOW + HOUR, now: NOW, percentPerHour: null, tone: "success", width: 10, rows: 4,
		clock: () => "x",
	}).map(plain);
	assert.ok(flat.every(line => !line.includes("•") && !line.includes("▲")));
	const slow = windowChart({
		points: [{ ts: NOW - HOUR, percent: 20 }, { ts: NOW, percent: 30 }],
		start: NOW - 4 * HOUR, reset: NOW + HOUR, now: NOW, percentPerHour: 10, tone: "success", width: 10, rows: 4,
		clock: () => "x",
	}).map(plain);
	assert.ok(slow.every(line => !line.includes("▲")), "40% at the reset never fills");
	assert.equal(slow.filter(line => line.includes("•")).length, 1, "the dots stay on one row near 35%");
});

test("a full window stays drawn at the top until the reset", () => {
	const lines = windowChart({
		points: [{ ts: NOW - 2 * HOUR, percent: 80 }, { ts: NOW - HOUR, percent: 100 }, { ts: NOW, percent: 100 }],
		start: NOW - 4 * HOUR, reset: NOW + HOUR, now: NOW, percentPerHour: 0, tone: "error", width: 10, rows: 4,
		clock: () => "x",
	}).map(plain);
	assert.equal(lines[0], "100% ┤    ▃▆██••");
});
