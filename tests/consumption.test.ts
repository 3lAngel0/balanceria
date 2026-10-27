import { test } from "node:test";
import assert from "node:assert/strict";
import type { HistoryData, HistoryEntry, QuotaSample } from "../src/history.ts";
import type { Integration } from "../src/integrations.ts";
import type { PriceTable } from "../src/prices.ts";
import { summarizeConsumption } from "../src/consumption.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 18, 12).getTime();
const RESET = NOW + 3 * HOUR;

const INTEGRATIONS: Integration[] = [
	{ provider: "claude-bridge", kind: "subscription", label: "Claude Pro" },
	{ provider: "antigravity", kind: "subscription", label: "Google AI Pro" },
	{ provider: "anthropic", kind: "api", label: "Anthropic API" },
];

// 1 USD per million tokens on every rate, so cost equals total tokens / 1e6.
const PRICES: PriceTable = { models: { "claude-opus": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }, subscriptions: {} };

function request(ts: number, provider: string, tokens: number, model = "claude-opus"): HistoryEntry {
	return { ts, session: "s", project: "p", provider, model, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: null, contextWindow: null };
}

function sample(ts: number, usedPercent: number, resetAt: number | null = RESET, overrides: Partial<QuotaSample> = {}): QuotaSample {
	return { kind: "quota", ts, session: "o", limit: "claude", key: "claude-bridge/claude", window: "5h", windowSeconds: 18000, usedPercent, resetAt, ...overrides };
}

function data(requests: HistoryEntry[] = [], samples: QuotaSample[] = []): HistoryData {
	return { requests, samples, errors: [] };
}

function paceOf(samples: QuotaSample[]) {
	const result = summarizeConsumption(data([], samples), INTEGRATIONS, PRICES, NOW);
	const windows = result.subscriptions.find(item => item.provider === "claude-bridge")!.windows;
	return windows.find(window => window.window === "5h")!.pace;
}

test("groups integrations by kind and keeps a subscription without data", () => {
	const result = summarizeConsumption(data([request(NOW - MIN, "anthropic", 10), request(NOW - MIN, "mystery", 5)]), INTEGRATIONS, PRICES, NOW);
	assert.deepEqual(result.subscriptions.map(item => item.provider), ["claude-bridge", "antigravity"]);
	assert.equal(result.subscriptions[0].label, "Claude Pro");
	assert.deepEqual(result.subscriptions[0].tokens, { last5h: 0, today: 0, last7d: 0 });
	assert.deepEqual(result.subscriptions[0].windows, []);
	assert.deepEqual(result.apis.map(item => item.provider), ["anthropic"]);
	assert.deepEqual(result.unclassified, [{ provider: "mystery", requests: 1, tokens: 5 }]);
});

test("unclassified providers never appear in the other groups", () => {
	const result = summarizeConsumption(data([request(NOW - MIN, "mystery", 5)]), INTEGRATIONS, PRICES, NOW);
	assert.ok(!result.subscriptions.some(item => item.provider === "mystery"));
	assert.ok(!result.apis.some(item => item.provider === "mystery"));
	assert.ok(!result.unclassified.some(item => item.provider === "anthropic"));
});

test("subscription tokens use the 5h, local-day and 7d boundaries and sum all four counters", () => {
	const startOfToday = new Date(2026, 9, 18).getTime();
	const full: HistoryEntry = { ...request(NOW - HOUR, "claude-bridge", 1), output: 2, cacheRead: 3, cacheWrite: 4 };
	const requests = [
		full,
		request(NOW - 5 * HOUR, "claude-bridge", 10),
		request(NOW - 5 * HOUR - 1, "claude-bridge", 100),
		request(startOfToday, "claude-bridge", 1000),
		request(startOfToday - 1, "claude-bridge", 10000),
		request(NOW - 7 * DAY, "claude-bridge", 100000),
		request(NOW - 7 * DAY - 1, "claude-bridge", 1000000),
		request(NOW - HOUR, "antigravity", 7),
	];
	const [claude, agy] = summarizeConsumption(data(requests), INTEGRATIONS, PRICES, NOW).subscriptions;
	assert.deepEqual(claude.tokens, { last5h: 10 + 10, today: 10 + 10 + 1000 + 100, last7d: 10 + 10 + 100 + 1000 + 10000 + 100000 });
	assert.deepEqual(agy.tokens, { last5h: 7, today: 7, last7d: 7 });
});

test("quota windows are grouped by key and window with the latest read", () => {
	const samples = [
		sample(NOW - 2 * HOUR, 10),
		sample(NOW - HOUR, 20),
		sample(NOW - HOUR, 64, NOW + DAY, { window: "week", windowSeconds: 604800 }),
		sample(NOW - HOUR, 5, RESET, { key: "antigravity/gemini", limit: "agy" }),
	];
	const [claude, agy] = summarizeConsumption(data([], samples), INTEGRATIONS, PRICES, NOW).subscriptions;
	assert.deepEqual(claude.windows.map(window => window.window), ["5h", "week"]);
	const five = claude.windows[0];
	assert.equal(five.key, "claude-bridge/claude");
	assert.equal(five.usedPercent, 20);
	assert.equal(five.resetAt, RESET);
	assert.equal(five.sampledAt, NOW - HOUR);
	assert.equal(five.windowSeconds, 18000);
	assert.deepEqual(five.points, [
		{ ts: NOW - 2 * HOUR, percent: 10 },
		{ ts: NOW - HOUR, percent: 20 },
	]);
	assert.deepEqual(agy.windows.map(window => window.key), ["antigravity/gemini"]);
});

test("api cost and request counts per period, with the partial flag", () => {
	const startOfToday = new Date(2026, 9, 18).getTime();
	const requests = [
		request(NOW - MIN, "anthropic", 1_000_000),
		request(startOfToday - 1, "anthropic", 2_000_000),
		request(NOW - 7 * DAY, "anthropic", 4_000_000),
		request(NOW - 30 * DAY, "anthropic", 8_000_000),
		request(NOW - 30 * DAY - 1, "anthropic", 16_000_000),
		request(NOW - MIN, "anthropic", 3_000_000, "unpriced-model"),
	];
	const [api] = summarizeConsumption(data(requests), INTEGRATIONS, PRICES, NOW).apis;
	assert.equal(api.label, "Anthropic API");
	assert.deepEqual(api.today, { requests: 2, usd: 1, partial: true });
	assert.deepEqual(api.last7d, { requests: 4, usd: 7, partial: true });
	assert.deepEqual(api.last30d, { requests: 5, usd: 15, partial: true });
});

test("api periods without unpriced requests are not partial", () => {
	const [api] = summarizeConsumption(data([request(NOW - MIN, "anthropic", 1_000_000), request(NOW - 3 * DAY, "anthropic", 1_000_000, "unpriced")]), INTEGRATIONS, PRICES, NOW).apis;
	assert.deepEqual(api.today, { requests: 1, usd: 1, partial: false });
	assert.equal(api.last7d.partial, true);
});

test("pace forecasts a fill before the reset", () => {
	// 20% -> 40% in 1h = 20%/h; 60% left takes 3h, reset is in 3h + 1 min.
	const reset = NOW + 3 * HOUR + 2 * MIN;
	const pace = paceOf([sample(NOW - HOUR, 20, reset), sample(NOW, 40, reset)]);
	assert.equal(pace!.percentPerHour, 20);
	assert.equal(pace!.fullAt, NOW + 3 * HOUR);
	assert.equal(pace!.fillsBeforeReset, true);
});

test("pace says the window will not fill when the reset comes first", () => {
	const pace = paceOf([sample(NOW - HOUR, 20, RESET), sample(NOW, 21, RESET)]);
	assert.equal(pace!.percentPerHour, 1);
	assert.equal(pace!.fullAt, NOW + 79 * HOUR);
	assert.equal(pace!.fillsBeforeReset, false);
});

test("pace only looks at the last 60 minutes before the latest sample", () => {
	const pace = paceOf([sample(NOW - 3 * HOUR, 0), sample(NOW - HOUR, 30), sample(NOW, 40)]);
	assert.equal(pace!.percentPerHour, 10);
});

test("pace is null with fewer than 2 samples in the span", () => {
	assert.equal(paceOf([sample(NOW, 40)]), null);
	assert.equal(paceOf([sample(NOW - 2 * HOUR, 10), sample(NOW, 40)]), null);
});

test("pace is null when the samples span under 5 minutes", () => {
	assert.equal(paceOf([sample(NOW - 4 * MIN, 10), sample(NOW, 40)]), null);
	assert.notEqual(paceOf([sample(NOW - 5 * MIN, 10), sample(NOW, 40)]), null);
});

test("pace is null for a flat or decreasing rate", () => {
	assert.equal(paceOf([sample(NOW - HOUR, 40), sample(NOW, 40)]), null);
	assert.equal(paceOf([sample(NOW - HOUR, 50), sample(NOW, 40)]), null);
});

test("pace ignores samples from a previous window with an older resetAt", () => {
	const old = NOW - 2 * HOUR;
	assert.equal(paceOf([sample(NOW - 30 * MIN, 90, old), sample(NOW, 5)]), null);
	const pace = paceOf([sample(NOW - 30 * MIN, 90, old), sample(NOW - 20 * MIN, 0), sample(NOW, 10)]);
	assert.equal(pace!.percentPerHour, 30);
});

test("pace treats resetAt jitter within 2 minutes as one window", () => {
	const pace = paceOf([sample(NOW - HOUR, 20, RESET), sample(NOW, 40, RESET + 329)]);
	assert.equal(pace!.percentPerHour, 20);
	const apart = paceOf([sample(NOW - HOUR, 20, RESET), sample(NOW, 40, RESET + 3 * MIN)]);
	assert.equal(apart, null);
});

test("pace is null when the latest window already reset", () => {
	assert.equal(paceOf([sample(NOW - HOUR, 20, NOW - MIN), sample(NOW - 10 * MIN, 40, NOW - MIN)]), null);
	assert.equal(paceOf([sample(NOW - HOUR, 20, null), sample(NOW, 40, null)]), null);
});

test("a window at 100% is full since the first sample that reached it", () => {
	const pace = paceOf([sample(NOW - 3 * HOUR, 80), sample(NOW - 2 * HOUR, 100), sample(NOW - HOUR, 100), sample(NOW, 100)]);
	assert.equal(pace!.fullAt, NOW - 2 * HOUR);
	assert.equal(pace!.fillsBeforeReset, true);
});

test("providers and windows from other keys do not leak into a subscription", () => {
	const samples = [sample(NOW - HOUR, 20, RESET, { key: "claude-bridge-extra/x" }), sample(NOW, 40, RESET, { key: "claude-bridge-extra/x" })];
	const [claude] = summarizeConsumption(data([], samples), INTEGRATIONS, PRICES, NOW).subscriptions;
	assert.deepEqual(claude.windows, []);
});
