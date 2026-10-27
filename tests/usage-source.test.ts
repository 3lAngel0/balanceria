import { test } from "node:test";
import assert from "node:assert/strict";
import {
	agyUsageLimits,
	claudeQuotaEvents,
	combinePoolUsage,
	createPoolUsageSource,
	throttledClaudeFetch,
	type CachedClaudeUsage,
	USAGE_SOURCE_SCHEMA,
	usageSourceFetch,
	type ProviderUsage,
} from "../src/usage-source.ts";

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

test("combinePoolUsage merges both subscriptions under the pool provider, routed key first", () => {
	const agy = agyUsageLimits(AGY_REPORT);
	const viaClaude = combinePoolUsage(CLAUDE_USAGE, agy, "claude-bridge/claude", NOW);
	assert.equal(viaClaude?.provider, "pool");
	assert.equal(viaClaude?.plan, "claude max");
	assert.equal(viaClaude?.fetchedAt, NOW - 1000, "the panel's age is the oldest snapshot's");
	assert.deepEqual(viaClaude?.limits.map(limit => limit.name), ["claude", "claude opus", "agy gemini", "agy claude", "agy argon"]);

	const viaAgy = combinePoolUsage(CLAUDE_USAGE, agy, "antigravity/claude", NOW);
	assert.deepEqual(viaAgy?.limits.map(limit => limit.name), ["agy claude", "claude", "claude opus", "agy gemini", "agy argon"]);
});

test("combinePoolUsage keeps whichever side answered and gives up only when both are empty", () => {
	const agyOnly = combinePoolUsage(undefined, agyUsageLimits(AGY_REPORT), undefined, NOW);
	assert.equal(agyOnly?.plan, undefined);
	assert.deepEqual(agyOnly?.limits.map(limit => limit.name), ["agy gemini", "agy claude", "agy argon"]);

	const claudeOnly = combinePoolUsage(CLAUDE_USAGE, [], undefined, NOW);
	assert.deepEqual(claudeOnly?.limits.map(limit => limit.name), ["claude", "claude opus"]);

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
	});
	assert.equal(source.schema, USAGE_SOURCE_SCHEMA);
	assert.equal(source.provider, "pool");

	const usage = await source.fetch(undefined, fakeFetch, NOW);
	assert.deepEqual(calls.sort(), ["agy", `claude:true:${NOW}`]);
	assert.equal(usage?.limits[0].name, "agy claude");
	assert.equal(usage?.limits.length, 5);
});

test("createPoolUsageSource survives a failing side and an absent claude source", async () => {
	const failingClaude = createPoolUsageSource({
		claudeSource: () => ({ fetch: async () => { throw new Error("network down"); } }),
		readAgyReport: async () => AGY_REPORT,
		routedKey: () => undefined,
	});
	assert.deepEqual((await failingClaude.fetch(undefined, fetch, NOW))?.limits.map(limit => limit.name), ["agy gemini", "agy claude", "agy argon"]);

	const noClaude = createPoolUsageSource({
		claudeSource: () => undefined,
		readAgyReport: async () => { throw new Error("agy missing"); },
		routedKey: () => undefined,
	});
	assert.equal(await noClaude.fetch(undefined, fetch, NOW), undefined);
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
