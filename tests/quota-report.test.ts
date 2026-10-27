import { test } from "node:test";
import assert from "node:assert/strict";
import type { HistoryEntry, QuotaError, QuotaSample } from "../src/history.ts";
import { summarizeQuota } from "../src/quota-report.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 18, 12).getTime();
const T0 = NOW - 20 * DAY;
const WEEK_S = 7 * 24 * 3600;

function sample(ts: number, usedPercent: number, resetAt: number | null, overrides: Partial<QuotaSample> = {}): QuotaSample {
	return { kind: "quota", ts, session: "observer", limit: "agy claude", key: "antigravity/claude", window: "week", windowSeconds: WEEK_S, usedPercent, resetAt, ...overrides };
}

function request(ts: number, session: string, tokens: number): HistoryEntry {
	return { ts, session, project: "balancingIa", provider: "antigravity", model: "claude-opus-5-5", input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: null, contextWindow: null };
}

function error(ts: number, key: string, until: number | null, session: string): QuotaError {
	return { kind: "quota-error", ts, session, project: "web", key, until };
}

const SAMPLES: QuotaSample[] = [
	sample(T0 + 1 * DAY, 30, T0 + 7 * DAY),
	sample(T0 + 2 * DAY, 80, T0 + 7 * DAY),
	sample(T0 + 3 * DAY, 100, T0 + 7 * DAY),
	sample(T0 + 3 * DAY + HOUR, 100, T0 + 7 * DAY),
	sample(T0 + 8 * DAY, 50, T0 + 14 * DAY),
	sample(T0 + 9 * DAY, 100, T0 + 14 * DAY),
	sample(NOW - HOUR, 12, NOW + 4 * HOUR, { limit: "agy gemini", key: "antigravity/gemini", window: "5h", windowSeconds: 18_000 }),
];
const REQUESTS = [
	request(T0 + 2 * DAY, "s-top", 1000),
	request(T0 + 8 * DAY, "s-top", 5000),
	request(T0 + 8 * DAY + 12 * HOUR, "s-err", 100),
	request(T0 - DAY, "s-old", 99_999),
];
const ERRORS = [
	error(T0 + 9 * DAY - 2 * HOUR, "antigravity/claude", T0 + 14 * DAY, "s-err"),
	error(NOW - HOUR, "claude-bridge/claude", NOW + 2 * HOUR, "s-hit"),
	error(NOW - 30 * 60_000, "claude-bridge/claude", NOW + 2 * HOUR, "s-hit2"),
];

test("summarizeQuota finds one fill per window cycle, merges quota errors and names the top session", () => {
	const report = summarizeQuota({ requests: REQUESTS, samples: SAMPLES, errors: ERRORS }, NOW);
	assert.deepEqual(
		report.fills.map(fill => [fill.limit, fill.window, fill.ts, fill.source, fill.hitSession, fill.top?.session, fill.top?.tokens]),
		[
			["claude", "", NOW - HOUR, "error", "s-hit", undefined, undefined],
			["agy claude", "week", T0 + 9 * DAY - 2 * HOUR, "error", "s-err", "s-top", 5000],
			["agy claude", "week", T0 + 3 * DAY, "usage", undefined, "s-top", 1000],
		],
		"newest first; the repeated 100% read and the second error of one cycle are not new fills",
	);
});

test("summarizeQuota reports how often each window fills, how fast and how long it stays blocked", () => {
	const report = summarizeQuota({ requests: REQUESTS, samples: SAMPLES, errors: ERRORS }, NOW);
	const week = report.series.find(series => series.limit === "agy claude" && series.window === "week");
	assert.ok(week);
	assert.equal(week.fills, 2);
	assert.equal(week.peak, 100);
	assert.equal(week.everyMs, 6 * DAY - 2 * HOUR);
	assert.equal(week.fillsInMs, 2.5 * DAY - HOUR);
	assert.equal(week.blockedMs, 4 * DAY + 5 * DAY + 2 * HOUR);
	assert.equal(week.daily.length, 30);
	assert.deepEqual([week.daily[29 - 19], week.daily[29 - 17], week.daily[29 - 11], week.daily[29]], [30, 100, 100, null]);
	assert.deepEqual(week.fillDays, [29 - 17, 29 - 11]);

	const claude = report.series.find(series => series.limit === "claude");
	assert.deepEqual([claude?.fills, claude?.everyMs, claude?.blockedMs], [1, undefined, HOUR], "blocked time stops at now");
});

test("summarizeQuota keeps the latest read of every window and flags one whose reset already passed", () => {
	const report = summarizeQuota({ requests: [], samples: SAMPLES, errors: [] }, NOW);
	assert.deepEqual(
		report.current.map(read => [read.limit, read.window, read.usedPercent, read.stale]),
		[
			["agy claude", "week", 100, true],
			["agy gemini", "5h", 12, false],
		],
	);
	assert.deepEqual(summarizeQuota({ requests: [], samples: [], errors: [] }, NOW), { current: [], series: [], fills: [] });
});
