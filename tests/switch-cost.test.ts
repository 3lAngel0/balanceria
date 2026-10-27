import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_WEIGHTS,
	SWITCH_DEFAULTS,
	fitWindows,
	formatSwitchCostReport,
	switchAdvice,
	switchCost,
	weightedTokens,
	type WindowFit,
} from "../src/switch-cost.ts";
import { resolveBalancerArgs, BALANCER_MENU } from "../src/balancer-menu.ts";
import type { HistoryEntry, QuotaSample } from "../src/history.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);
const RESET = T0 + 5 * 60 * MIN;

function sample(ts: number, usedPercent: number, overrides: Partial<QuotaSample> = {}): QuotaSample {
	return {
		kind: "quota",
		ts,
		session: "s",
		limit: "claude",
		key: "claude-bridge/claude",
		window: "5h",
		windowSeconds: 18_000,
		usedPercent,
		resetAt: RESET,
		...overrides,
	};
}

function request(ts: number, tokens: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		ts,
		session: "s",
		project: "p",
		provider: "claude-bridge",
		model: "claude-opus-5-5",
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		contextTokens: null,
		contextWindow: null,
		...tokens,
	};
}

// One million weighted tokens per interval: 100k input + 1M cache read (0.1)
// + 400k cache write (1.25) + 60k output (5) = 100k + 100k + 500k + 300k.
const MILLION = { input: 100_000, cacheRead: 1_000_000, cacheWrite: 400_000, output: 60_000 };

test("defaults are D3 and the R4 weights", () => {
	assert.deepEqual(SWITCH_DEFAULTS, { graceMs: 2 * MIN, cooldownMs: 15 * MIN, smallContext: 30_000, resetSoonMs: 30 * MIN });
	assert.deepEqual(DEFAULT_WEIGHTS, { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 });
	assert.equal(weightedTokens(MILLION), 1_000_000);
});

test("fitWindows: percent per million weighted tokens, through the origin", () => {
	const samples: QuotaSample[] = [];
	const requests: HistoryEntry[] = [];
	for (let i = 0; i <= 12; i++) {
		samples.push(sample(T0 + i * 10 * MIN, 2 * i));
		if (i > 0) requests.push(request(T0 + i * 10 * MIN - MIN, MILLION));
	}
	const fits = fitWindows({ requests, samples });
	assert.equal(fits.length, 1);
	const fit = fits[0];
	assert.equal(fit.key, "claude-bridge/claude");
	assert.equal(fit.window, "5h");
	assert.equal(fit.intervals, 12);
	assert.ok(Math.abs((fit.percentPerMillion ?? 0) - 2) < 1e-9);
	assert.ok(Math.abs((fit.r2 ?? 0) - 1) < 1e-9);
});

test("fitWindows: an interval needs the same reset, at most 30 min, under 100%, no decrease", () => {
	const samples = [
		sample(T0, 10),
		sample(T0 + 10 * MIN, 12), // ok: 1M tokens, +2
		sample(T0 + 20 * MIN, 14, { resetAt: RESET + 60 * MIN }), // other reset: no interval
		sample(T0 + 60 * MIN, 16, { resetAt: RESET + 60 * MIN }), // 40 min gap: no interval
		sample(T0 + 70 * MIN, 100, { resetAt: RESET + 60 * MIN }), // reaches 100%: no interval
		sample(T0 + 80 * MIN, 100, { resetAt: RESET + 60 * MIN }), // both 100%: no interval
		sample(T0 + 90 * MIN, 50, { resetAt: RESET + 60 * MIN }), // earlier at 100%: no interval
		sample(T0 + 100 * MIN, 40, { resetAt: RESET + 60 * MIN }), // decrease: no interval
		sample(T0 + 110 * MIN, 41, { resetAt: null }), // unknown reset: no interval
		sample(T0 + 120 * MIN, 42, { resetAt: null }),
		sample(T0 + 5 * MIN, 99, { key: undefined }), // no key: ignored
	];
	const requests = [
		request(T0 + 5 * MIN, MILLION),
		request(T0 + 5 * MIN, { ...MILLION, provider: "antigravity", model: "gemini-4-argon" }), // other window
	];
	const [fit] = fitWindows({ requests, samples });
	assert.equal(fit.intervals, 1);
	assert.equal(fit.percentPerMillion, null, "fewer than 10 intervals is not calibrated");
	assert.equal(fit.r2, null);
});

test("fitWindows: a reset that jitters by under a minute is the same reset", () => {
	const samples: QuotaSample[] = [];
	const requests: HistoryEntry[] = [];
	for (let i = 0; i <= 10; i++) {
		samples.push(sample(T0 + i * 10 * MIN, 2 * i, { resetAt: RESET + (i % 2 === 0 ? 400 : -500) }));
		if (i > 0) requests.push(request(T0 + i * 10 * MIN - MIN, MILLION));
	}
	samples.push(sample(T0 + 110 * MIN, 22, { resetAt: RESET + 61_000 })); // over a minute: a new reset
	requests.push(request(T0 + 109 * MIN, MILLION));
	const [fit] = fitWindows({ requests, samples });
	assert.equal(fit.intervals, 10);
	assert.ok(Math.abs((fit.percentPerMillion ?? 0) - 2) < 1e-9);
});

test("fitWindows: a window that moves without Pi traffic is not calibrated", () => {
	const samples: QuotaSample[] = [];
	const requests: HistoryEntry[] = [];
	for (let i = 0; i <= 12; i++) {
		// Odd intervals grow 6 with no requests; even ones grow 0 with 1M tokens.
		samples.push(sample(T0 + i * 10 * MIN, 6 * Math.ceil(i / 2)));
		if (i > 0 && i % 2 === 0) requests.push(request(T0 + i * 10 * MIN - MIN, MILLION));
	}
	const [fit] = fitWindows({ requests, samples });
	assert.equal(fit.intervals, 12);
	assert.equal(fit.percentPerMillion, null);
	assert.ok(fit.r2 !== null && fit.r2 < 0.3, `r2 ${fit.r2}`);
});

test("switchCost: stay reads the context from cache, a switch writes it again", () => {
	const claude: WindowFit = { key: "claude-bridge/claude", window: "5h", intervals: 107, percentPerMillion: 15.7, r2: 0.64 };
	const argon: WindowFit = { key: "antigravity/gemini-4-argon", window: "week", intervals: 36, percentPerMillion: 11.8, r2: 0.82 };
	const cost = switchCost(150_000, [claude], [argon]);
	assert.equal(cost.stayTokens, 15_000);
	assert.equal(cost.switchTokens, 187_500);
	assert.deepEqual(cost.stay, [{ key: "claude-bridge/claude", window: "5h", percent: 0.2355 }]);
	assert.deepEqual(cost.switch, [{ key: "antigravity/gemini-4-argon", window: "week", percent: 2.2125 }]);

	const uncalibrated = switchCost(150_000, [], [{ ...argon, percentPerMillion: null, r2: 0.1 }]);
	assert.deepEqual(uncalibrated.stay, []);
	assert.deepEqual(uncalibrated.switch, [{ key: "antigravity/gemini-4-argon", window: "week", percent: null }]);
	assert.equal(switchCost(null, [claude], [argon]).switchTokens, 0);
});

test("switchAdvice follows the policy table of the design", () => {
	const now = T0;
	const advice = (contextTokens: number | null, resetAt: number | null) => switchAdvice({ contextTokens, resetAt, now });
	assert.deepEqual(advice(null, null), { action: "switch", why: "no context yet (new session or right after compaction): switching is cheap" });
	assert.deepEqual(advice(29_999, now + 10 * MIN), { action: "switch", why: "context 30k is under 30k: re-sending it costs about one ordinary turn" });
	assert.deepEqual(advice(30_000, now + 30 * MIN), {
		action: "wait",
		why: "context 30k and the window resets in 30 min: waiting beats re-sending it uncached",
	});
	assert.deepEqual(advice(152_300, now + 31 * MIN), {
		action: "propose",
		why: "context 152k and the window resets in 31 min: compact then switch, or continue from a summary on another model",
	});
	assert.deepEqual(advice(152_300, null), {
		action: "propose",
		why: "context 152k and the reset time is unknown: compact then switch, or continue from a summary on another model",
	});
	assert.equal(switchAdvice({ contextTokens: 50_000, resetAt: now + 50 * MIN, now }, { ...SWITCH_DEFAULTS, resetSoonMs: 60 * MIN }).action, "wait");
});

test("formatSwitchCostReport lists the defaults and every window fit", () => {
	const text = formatSwitchCostReport([
		{ key: "claude-bridge/claude", window: "5h", intervals: 107, percentPerMillion: 15.7, r2: 0.64 },
		{ key: "antigravity/gemini", window: "5h", intervals: 80, percentPerMillion: null, r2: -0.2 },
		{ key: "antigravity/claude", window: "week", intervals: 3, percentPerMillion: null, r2: null },
	]);
	assert.equal(
		text,
		[
			"ai-balancer switch cost (30 days of history)",
			"Defaults: grace 2 min · cooldown 15 min · small context under 30k · reset soon under 30 min",
			"Weights per token: input 1 · cache read 0.1 · cache write 1.25 · output 5",
			"A switch re-sends the context uncached (× 1.25); staying reads it from cache (× 0.1).",
			"Windows (% of the window per million weighted tokens):",
			"  claude-bridge/claude 5h: 15.70 %/M · R² 0.64 · 107 intervals",
			"  antigravity/gemini 5h: not calibrated · R² -0.20 · 80 intervals (needs R² ≥ 0.3)",
			"  antigravity/claude week: not calibrated · 3 intervals (needs 10)",
		].join("\n"),
	);
	assert.match(formatSwitchCostReport([]), /Windows: none with quota samples yet\.$/);
});

test("/balancer switch-cost is a command and a menu entry", () => {
	assert.deepEqual(resolveBalancerArgs("switch-cost"), { kind: "command", command: "switch-cost" });
	assert.ok(BALANCER_MENU.some(entry => entry.value === "switch-cost"));
	assert.equal(resolveBalancerArgs("switch-cost now").kind, "unknown");
});

test("routeSwitchCost: a continuation that changes provider records its cost and advice", async () => {
	const { routeSwitchCost } = await import("../src/switch-cost.ts");
	const { QuotaState } = await import("../src/state.ts");
	const candidates = [
		{ provider: "antigravity", model: "claude-opus-5-5", quotaKey: "antigravity/claude" },
		{ provider: "claude-bridge", model: "claude-opus-5-5", quotaKey: "claude-bridge/claude" },
	];
	const state = new QuotaState();
	state.markExhausted("antigravity/claude", T0 + 20 * MIN, "quota-error", T0);
	const fits: WindowFit[] = [
		{ key: "antigravity/claude", window: "week", intervals: 12, percentPerMillion: 1.6, r2: 0.5 },
		{ key: "claude-bridge/claude", window: "5h", intervals: 107, percentPerMillion: 16, r2: 0.8 },
		{ key: "claude-bridge/claude", window: "week", intervals: 3, percentPerMillion: null, r2: null },
	];
	const base = { candidates, chosen: candidates[1], contextTokens: 152_300, state, now: T0, fits };
	assert.deepEqual(routeSwitchCost({ ...base, reason: "continuation", previousProvider: "antigravity" }), {
		from: "antigravity/claude-opus-5-5",
		to: "claude-bridge/claude-opus-5-5",
		contextTokens: 152_300,
		stayTokens: 15_230,
		switchTokens: 190_375,
		stay: [{ key: "antigravity/claude", window: "week", percent: 0.0244 }],
		switch: [
			{ key: "claude-bridge/claude", window: "5h", percent: 3.046 },
			{ key: "claude-bridge/claude", window: "week", percent: null },
		],
		advice: { action: "wait", why: "context 152k and the window resets in 20 min: waiting beats re-sending it uncached" },
	});
	assert.equal(routeSwitchCost({ ...base, reason: "retry", failedProvider: "antigravity" })?.from, "antigravity/claude-opus-5-5");
	const outside = routeSwitchCost({ ...base, reason: "continuation", previousProvider: "openai" });
	assert.equal(outside?.from, "openai");
	assert.deepEqual(outside?.stay, []);
	assert.equal(outside?.advice.action, "propose", "unknown reset: propose");
	assert.equal(routeSwitchCost({ ...base, reason: "user", previousProvider: "antigravity" }), undefined, "a first turn has nothing to move");
	assert.equal(routeSwitchCost({ ...base, reason: "continuation", previousProvider: "claude-bridge" }), undefined, "same provider");
	assert.equal(routeSwitchCost({ ...base, reason: "continuation" }), undefined, "no previous provider");
});
