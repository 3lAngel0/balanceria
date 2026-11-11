import { test } from "node:test";
import assert from "node:assert/strict";
import {
	agyDisabledWindows,
	agyUsageLimits,
	claudeQuotaEvents,
	combinePoolUsage,
	createAntigravityUsageSource,
	createPoolUsageSource,
	throttledClaudeFetch,
	type CachedClaudeUsage,
	USAGE_SOURCE_SCHEMA,
	usageSourceFetch,
	type ProviderUsage,
} from "../src/usage-source.ts";
import { QuotaState } from "../src/state.ts";

const NOW = Date.parse("2026-10-18T06:00:00Z");

// Shape of `agy --print /usage --output-format json`, trimmed from a real report.
const AGY_REPORT = {
	command: {
		data: {
			groups: [
				{
					name: "Gemini Models",
					buckets: [
						{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.99, reset_time: "2026-10-25T03:57:06Z" },
						{ id: "gemini-5h", window: "5h", remaining_fraction: 0.75, reset_time: "2026-10-18T08:57:06Z" },
					],
				},
				{
					name: "Claude and GPT models",
					buckets: [
						{ id: "3p-weekly", window: "weekly", remaining_fraction: 0, reset_time: "2026-10-23T05:37:32Z" },
						{ id: "3p-5h", window: "5h", disabled: true, remaining_fraction: 1 },
					],
				},
				{
					name: "Gemini 4 Argon",
					buckets: [{ id: "gemini-argon-wtu-weekly", window: "weekly", remaining_fraction: 0.98, reset_time: "2026-10-25T04:25:59Z" }],
				},
			],
		},
	},
};

const CLAUDE_USAGE: ProviderUsage = {
	provider: "claude-bridge",
	plan: "max",
	fetchedAt: NOW - 1000,
	limits: [
		{
			name: "claude",
			limitReached: false,
			windows: [
				{ label: "5h", usedPercent: 43, windowSeconds: 18_000, resetAt: NOW + 3_600_000 },
				{ label: "week", usedPercent: 12, windowSeconds: 604_800, resetAt: NOW + 86_400_000 },
			],
		},
		{ name: "opus", limitReached: false, windows: [{ label: "week", usedPercent: 20, windowSeconds: 604_800, resetAt: null }] },
	],
};

test("agyUsageLimits keeps every enabled window per group with its used percent and reset", () => {
	const limits = agyUsageLimits(AGY_REPORT);
	assert.deepEqual(limits.map(limit => limit.name), ["agy gemini", "agy claude", "agy argon"]);

	const gemini = limits[0];
	assert.equal(gemini.limitReached, false);
	assert.deepEqual(
		gemini.windows.map(window => [window.label, Math.round(window.usedPercent), window.windowSeconds, window.resetAt]),
		[
			["5h", 25, 18_000, Date.parse("2026-10-18T08:57:06Z")],
			["week", 1, 604_800, Date.parse("2026-10-25T03:57:06Z")],
		],
	);

	const claude = limits[1];
	assert.equal(claude.limitReached, true, "a spent weekly bucket marks the limit reached");
	assert.deepEqual(claude.windows.map(window => [window.label, window.usedPercent]), [["week", 100]], "disabled buckets are skipped");
});

test("agyUsageLimits returns nothing for a report it does not understand", () => {
	assert.deepEqual(agyUsageLimits(undefined), []);
	assert.deepEqual(agyUsageLimits({ command: { data: { groups: "x" } } }), []);
});

const rows = (usage: ProviderUsage | undefined) =>
	(usage?.limits ?? []).map(limit => `${limit.name} ${limit.windows[0]?.label} ${Math.round(limit.windows[0]?.usedPercent ?? -1)}%`);
const DISABLED = agyDisabledWindows(AGY_REPORT);

test("agyDisabledWindows lists the buckets agy switched off, by limit and window", () => {
	assert.deepEqual(DISABLED, [{ name: "agy claude", label: "5h", windowSeconds: 18_000 }]);
	assert.deepEqual(agyDisabledWindows(undefined), []);
});

test("combinePoolUsage lists every weekly row first, then every 5h row, with HUD provider names", () => {
	const agy = agyUsageLimits(AGY_REPORT);
	const viaClaude = combinePoolUsage(CLAUDE_USAGE, agy, "claude-bridge/claude", NOW, undefined, undefined, DISABLED);
	assert.equal(viaClaude?.provider, "pool");
	assert.equal(viaClaude?.plan, "claude max");
	assert.equal(viaClaude?.fetchedAt, NOW - 1000, "the panel's age is the oldest snapshot's");
	assert.deepEqual(rows(viaClaude), [
		"week · claude-bridge claude 12%",
		"week · claude-bridge opus 20%",
		"week · antigravity gemini 1%",
		"week · antigravity claude 100%",
		"week · antigravity gemini-4-argon 2%",
		"5h   · claude-bridge claude 43%",
		"5h   · antigravity gemini 25%",
		"5h   · antigravity claude · disabled · weekly limit hit 0%",
	]);
	const disabled = viaClaude?.limits.at(-1);
	assert.equal(disabled?.windows[0]?.resetAt, null, "a disabled window shows no reset");
	assert.equal(disabled?.limitReached, false);
	assert.equal(viaClaude?.limits[3]?.limitReached, true, "a full window marks its row reached");
});

test("combinePoolUsage puts the routed key's weekly row first, for the shell's bar, keeping the grouping", () => {
	const agy = agyUsageLimits(AGY_REPORT);
	const viaGemini = combinePoolUsage(CLAUDE_USAGE, agy, "antigravity/gemini", NOW, undefined, undefined, DISABLED);
	assert.deepEqual(rows(viaGemini).slice(0, 3), ["week · antigravity gemini 1%", "week · claude-bridge claude 12%", "week · claude-bridge opus 20%"]);
	assert.deepEqual(rows(viaGemini).slice(5, 6), ["5h   · claude-bridge claude 43%"]);
});

test("a disabled bucket without a full sibling window reads plain disabled", () => {
	const report = { command: { data: { groups: [{ name: "Gemini Models", buckets: [
		{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.5, reset_time: "2026-10-25T03:57:06Z" },
		{ id: "gemini-5h", window: "5h", disabled: true, remaining_fraction: 1 },
	] }] } } };
	const usage = combinePoolUsage(undefined, agyUsageLimits(report), undefined, NOW, undefined, undefined, agyDisabledWindows(report));
	assert.deepEqual(rows(usage), ["week · antigravity gemini 50%", "5h   · antigravity gemini · disabled 0%"]);
});

test("combinePoolUsage header names the pool and the model it uses now", () => {
	const agy = agyUsageLimits(AGY_REPORT);
	const info = { poolName: "orchestrator", activeRoute: "claude-bridge/claude-opus-5-5" };
	assert.equal(combinePoolUsage(CLAUDE_USAGE, agy, undefined, NOW, undefined, info)?.plan, "orchestrator · now claude-bridge/claude-opus-5-5 · claude max");
	assert.equal(combinePoolUsage(undefined, agy, undefined, NOW, undefined, info)?.plan, "orchestrator · now claude-bridge/claude-opus-5-5");
	assert.equal(combinePoolUsage(CLAUDE_USAGE, agy, undefined, NOW, undefined, { poolName: "orchestrator" })?.plan, "orchestrator · claude max");
});

test("combinePoolUsage shows the reported percent under a router block and says the router waits", () => {
	const agy = agyUsageLimits(AGY_REPORT);
	const state = new QuotaState();
	state.markExhausted("antigravity/gemini-4-argon", NOW + 2 * 3_600_000 + 5 * 60_000, "Individual quota reached", NOW);

	const combined = combinePoolUsage(CLAUDE_USAGE, agy, "antigravity/gemini-4-argon", NOW, state, undefined, DISABLED);
	const argon = combined?.limits[0];
	assert.equal(argon?.name, "week ·");
	assert.equal(argon?.windows[0]?.label, "antigravity gemini-4-argon · router waits 2h 5m");
	assert.equal(Math.round(argon?.windows[0]?.usedPercent ?? -1), 2, "never a fake 100%");
	assert.equal(argon?.windows[0]?.resetAt, Date.parse("2026-10-25T04:25:59Z"), "the window keeps its own reset");
	assert.equal(argon?.limitReached, false);
});

test("combinePoolUsage keeps whichever side answered and gives up only when both are empty", () => {
	const agyOnly = combinePoolUsage(undefined, agyUsageLimits(AGY_REPORT), undefined, NOW);
	assert.equal(agyOnly?.plan, undefined);
	assert.deepEqual(rows(agyOnly), [
		"week · antigravity gemini 1%",
		"week · antigravity claude 100%",
		"week · antigravity gemini-4-argon 2%",
		"5h   · antigravity gemini 25%",
	]);

	const claudeOnly = combinePoolUsage(CLAUDE_USAGE, [], undefined, NOW);
	assert.deepEqual(rows(claudeOnly), ["week · claude-bridge claude 12%", "week · claude-bridge opus 20%", "5h   · claude-bridge claude 43%"]);

	assert.equal(combinePoolUsage(undefined, [], undefined, NOW), undefined);
});

test("createPoolUsageSource registers the pool provider and fetches both sides in parallel", async () => {
	const calls: string[] = [];
	const fakeFetch = (async () => new Response("{}")) as typeof fetch;
	const source = createPoolUsageSource({
		claudeSource: () => ({
			fetch: async (_apiKey, fetchFn, now) => {
				calls.push(`claude:${fetchFn === fakeFetch}:${now}`);
				return CLAUDE_USAGE;
			},
		}),
		readAgyReport: async () => {
			calls.push("agy");
			return AGY_REPORT;
		},
		routedKey: () => "antigravity/claude",
		poolInfo: () => ({ poolName: "default", activeRoute: "antigravity/claude" }),
	});
	assert.equal(source.schema, USAGE_SOURCE_SCHEMA);
	assert.equal(source.provider, "pool");

	const usage = await source.fetch(undefined, fakeFetch, NOW);
	assert.deepEqual(calls.sort(), ["agy", `claude:true:${NOW}`]);
	assert.equal(usage?.plan, "default · now antigravity/claude · claude max");
	assert.equal(rows(usage)[0], "week · antigravity claude 100%");
	assert.equal(rows(usage).at(-1), "5h   · antigravity claude · disabled · weekly limit hit 0%");
	assert.equal(usage?.limits.length, 8);
});

test("createPoolUsageSource survives a failing side and an absent claude source", async () => {
	const failingClaude = createPoolUsageSource({
		claudeSource: () => ({ fetch: async () => { throw new Error("network down"); } }),
		readAgyReport: async () => AGY_REPORT,
		routedKey: () => undefined,
	});
	assert.equal((await failingClaude.fetch(undefined, fetch, NOW))?.limits.length, 5);

	const noClaude = createPoolUsageSource({
		claudeSource: () => undefined,
		readAgyReport: async () => { throw new Error("agy missing"); },
		routedKey: () => undefined,
	});
	assert.equal(await noClaude.fetch(undefined, fetch, NOW), undefined);
});

test("createAntigravityUsageSource answers alt+u for antigravity with only the agy rows", async () => {
	const state = new QuotaState();
	const source = createAntigravityUsageSource({ readAgyReport: async () => AGY_REPORT, routedKey: () => "antigravity/gemini", state: () => state });
	assert.equal(source.schema, USAGE_SOURCE_SCHEMA);
	assert.equal(source.provider, "antigravity");
	const usage = await source.fetch(undefined, fetch, NOW);
	assert.equal(usage?.provider, "antigravity");
	assert.equal(usage?.plan, undefined);
	assert.equal(usage?.fetchedAt, NOW);
	assert.deepEqual(rows(usage), [
		"week · antigravity gemini 1%",
		"week · antigravity claude 100%",
		"week · antigravity gemini-4-argon 2%",
		"5h   · antigravity gemini 25%",
		"5h   · antigravity claude · disabled · weekly limit hit 0%",
	]);

	const missing = createAntigravityUsageSource({ readAgyReport: async () => { throw new Error("agy missing"); }, routedKey: () => undefined });
	assert.equal(await missing.fetch(undefined, fetch, NOW), undefined);
});

function memoryStore(initial?: CachedClaudeUsage) {
	let cached = initial;
	return {
		load: () => cached,
		save: (next: CachedClaudeUsage) => {
			cached = next;
		},
		peek: () => cached,
	};
}

const MIN_INTERVAL = 5 * 60_000;

test("throttledClaudeFetch caches a good answer and serves it instead of refetching inside the interval", async () => {
	let calls = 0;
	const store = memoryStore();
	const fetchClaude = throttledClaudeFetch(async () => {
		calls++;
		return CLAUDE_USAGE;
	}, store, MIN_INTERVAL);

	assert.deepEqual(await fetchClaude(undefined, fetch, NOW), CLAUDE_USAGE);
	assert.deepEqual(store.peek(), { attemptedAt: NOW, usage: CLAUDE_USAGE });
	assert.deepEqual(await fetchClaude(undefined, fetch, NOW + MIN_INTERVAL - 1), CLAUDE_USAGE);
	assert.equal(calls, 1, "no second request inside the interval");

	await fetchClaude(undefined, fetch, NOW + MIN_INTERVAL);
	assert.equal(calls, 2, "refetches once the interval passed");
});

test("throttledClaudeFetch keeps the last good usage when Anthropic rate-limits or fails", async () => {
	const store = memoryStore({ attemptedAt: NOW - MIN_INTERVAL, usage: CLAUDE_USAGE });
	const rateLimited = throttledClaudeFetch(async () => undefined, store, MIN_INTERVAL);
	assert.deepEqual(await rateLimited(undefined, fetch, NOW), CLAUDE_USAGE);
	assert.deepEqual(store.peek(), { attemptedAt: NOW, usage: CLAUDE_USAGE }, "the failed attempt still counts against the interval");

	const throwing = throttledClaudeFetch(async () => { throw new Error("network down"); }, memoryStore({ attemptedAt: 0, usage: CLAUDE_USAGE }), MIN_INTERVAL);
	assert.deepEqual(await throwing(undefined, fetch, NOW), CLAUDE_USAGE);

	const empty = throttledClaudeFetch(async () => undefined, memoryStore(), MIN_INTERVAL);
	assert.equal(await empty(undefined, fetch, NOW), undefined);
});

test("usageSourceFetch picks the fetch of a registration for the named provider only", () => {
	const fetchFn = async () => undefined;
	assert.equal(usageSourceFetch({ schema: USAGE_SOURCE_SCHEMA, provider: "claude-bridge", fetch: fetchFn }, "claude-bridge"), fetchFn);
	assert.equal(usageSourceFetch({ schema: USAGE_SOURCE_SCHEMA, provider: "pool", fetch: fetchFn }, "claude-bridge"), undefined);
	assert.equal(usageSourceFetch({ schema: "other", provider: "claude-bridge", fetch: fetchFn }, "claude-bridge"), undefined);
	assert.equal(usageSourceFetch({ schema: USAGE_SOURCE_SCHEMA, provider: "claude-bridge" }, "claude-bridge"), undefined);
});

test("claudeQuotaEvents turns the fullest Claude window into a remaining fraction for the router", () => {
	const at = 1_000_000;
	const usage: ProviderUsage = {
		provider: "claude-bridge",
		plan: "pro",
		fetchedAt: at,
		limits: [
			{ name: "claude", limitReached: false, windows: [
				{ label: "5h", usedPercent: 46, windowSeconds: 18_000, resetAt: at + 5_000 },
				{ label: "week", usedPercent: 51, windowSeconds: 604_800, resetAt: at + 90_000 },
			] },
			{ name: "opus", limitReached: false, windows: [{ label: "week", usedPercent: 10, windowSeconds: 604_800, resetAt: null }] },
		],
	};
	assert.deepEqual(claudeQuotaEvents(usage), [{ type: "quota", ts: at, key: "claude-bridge/claude", remainingFraction: 0.49, resetAt: at + 90_000 }]);
	const reached = { ...usage, limits: [{ ...usage.limits[0]!, limitReached: true }] };
	assert.deepEqual(claudeQuotaEvents(reached), [{ type: "quota", ts: at, key: "claude-bridge/claude", remainingFraction: 0, resetAt: at + 90_000 }]);
	assert.deepEqual(claudeQuotaEvents({ ...usage, limits: [{ name: "claude", limitReached: false, windows: [] }] }), []);
});
