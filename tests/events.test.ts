import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldEvents, appendEvent, readEvents, type BalancerEvent } from "../src/events.ts";
import { parsePools } from "../src/pools.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const HOUR = 3_600_000;

test("foldEvents rebuilds quota availability from exhaustion and agy usage events", () => {
	const events: BalancerEvent[] = [
		{ type: "exhausted", ts: NOW - HOUR, key: "claude-bridge/claude", until: NOW + HOUR, reason: "5h window" },
		{
			type: "agy-usage",
			ts: NOW - 60_000,
			groups: { "Claude and GPT models": { remainingFraction: 0, resetAt: NOW + 2 * HOUR } },
		},
	];
	const { state } = foldEvents(events, NOW);
	assert.equal(state.isAvailable("claude-bridge/claude", NOW), false);
	assert.equal(state.isAvailable("antigravity/claude", NOW), false);
	assert.equal(state.isAvailable("antigravity/claude", NOW + 2 * HOUR + 1), true);
});

test("foldEvents totals tokens per provider for the last 5 hours, today and the last 7 days", () => {
	const usage = (ts: number, provider: string, input: number, output: number): BalancerEvent => ({
		type: "usage", ts, provider, model: "claude-opus-5-5", input, output, cacheRead: 0, cacheWrite: 0,
	});
	const events: BalancerEvent[] = [
		usage(NOW - 30 * 60_000, "antigravity", 100, 10),
		usage(NOW - 6 * HOUR, "antigravity", 1000, 100),
		usage(NOW - 3 * 86_400_000, "claude-bridge", 5, 5),
		usage(NOW - 9 * 86_400_000, "claude-bridge", 999, 999),
	];
	const { tokens } = foldEvents(events, NOW);
	assert.deepEqual(tokens.get("antigravity"), { last5h: 110, today: 1210, last7d: 1210, requests: 2, lastModel: "claude-opus-5-5" });
	assert.deepEqual(tokens.get("claude-bridge"), { last5h: 0, today: 0, last7d: 10, requests: 1, lastModel: "claude-opus-5-5" });
});

test("foldEvents skips malformed events", () => {
	const { tokens } = foldEvents([{ type: "usage" } as unknown as BalancerEvent, null as unknown as BalancerEvent], NOW);
	assert.equal(tokens.size, 0);
});

test("appendEvent and readEvents round-trip through a JSONL file and ignore broken lines", () => {
	const dir = mkdtempSync(join(tmpdir(), "ai-balancer-"));
	appendEvent(dir, { type: "exhausted", ts: NOW, key: "antigravity/claude", until: NOW + HOUR, reason: "weekly" });
	appendEvent(dir, { type: "exhausted", ts: NOW, key: "claude-bridge/claude", until: undefined, reason: "5h" });
	const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
	assert.equal(raw.trim().split("\n").length, 2);
	const events = readEvents(dir);
	assert.equal(events.length, 2);
	assert.equal(events[0].type, "exhausted");
	assert.deepEqual(readEvents(join(dir, "missing")), []);
});

test("parsePools reads ordered candidates and rejects invalid entries", () => {
	const pools = parsePools({
		pools: [
			{ id: "claude-opus-5-5", name: "Opus 5.5 (pool)", candidates: ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"] },
			{ id: "bad", candidates: [] },
			{ id: "bad-ref", candidates: ["no-slash"] },
		],
	});
	assert.equal(pools.length, 1);
	assert.deepEqual(pools[0].candidates, [
		{ provider: "antigravity", model: "claude-opus-5-5", quotaKey: "antigravity/claude" },
		{ provider: "claude-bridge", model: "claude-opus-5-5", quotaKey: "claude-bridge/claude" },
	]);
	assert.equal(pools[0].name, "Opus 5.5 (pool)");
});

test("pools.json routes the orchestrator through argon, then agy claude, then claude-bridge, each on its own quota window", () => {
	const pools = parsePools(JSON.parse(readFileSync(new URL("../pools.json", import.meta.url), "utf8")));
	assert.deepEqual(pools.map(pool => pool.id), ["claude-opus-5-5", "claude-sonnet-5-5", "orchestrator"]);
	const orchestrator = pools.find(pool => pool.id === "orchestrator");
	assert.deepEqual(orchestrator?.candidates, [
		{ provider: "antigravity", model: "gemini-4-argon", quotaKey: "antigravity/gemini-4-argon" },
		{ provider: "antigravity", model: "claude-sonnet-5-5", quotaKey: "antigravity/claude" },
		{ provider: "antigravity", model: "claude-opus-5-5", quotaKey: "antigravity/claude" },
		{ provider: "claude-bridge", model: "claude-opus-5-5", quotaKey: "claude-bridge/claude" },
		{ provider: "claude-bridge", model: "claude-sonnet-5-5", quotaKey: "claude-bridge/claude" },
	]);
});

test("pools.json pairs agy and claude-bridge for sonnet without flash fallback", () => {
	const pools = parsePools(JSON.parse(readFileSync(new URL("../pools.json", import.meta.url), "utf8")));
	const sonnet = pools.find(pool => pool.id === "claude-sonnet-5-5");
	assert.deepEqual(sonnet?.candidates.map(c => `${c.provider}/${c.model}`), ["antigravity/claude-sonnet-5-5", "claude-bridge/claude-sonnet-5-5"]);
});

test("a quota event sets the remaining fraction and lifts an expired exhaustion, so highest-quota sees it", () => {
	const events: BalancerEvent[] = [
		{ type: "exhausted", ts: NOW - 3 * HOUR, key: "claude-bridge/claude", until: NOW - HOUR, reason: "all candidates exhausted" },
		{ type: "quota", ts: NOW - 60_000, key: "claude-bridge/claude", remainingFraction: 0.54, resetAt: NOW + 4 * HOUR },
	];
	const { state } = foldEvents(events, NOW);
	assert.equal(state.remainingFraction("claude-bridge/claude"), 0.54);
	assert.equal(state.isAvailable("claude-bridge/claude", NOW), true);
});

test("a spent quota event marks the key exhausted until its reset; a later 429 still wins", () => {
	const spent = foldEvents([{ type: "quota", ts: NOW - 60_000, key: "claude-bridge/claude", remainingFraction: 0, resetAt: NOW + HOUR }], NOW).state;
	assert.equal(spent.availableAt("claude-bridge/claude", NOW), NOW + HOUR);
	const later = foldEvents([
		{ type: "quota", ts: NOW - 60_000, key: "claude-bridge/claude", remainingFraction: 0.5, resetAt: NOW + HOUR },
		{ type: "exhausted", ts: NOW - 30_000, key: "claude-bridge/claude", until: NOW + 2 * HOUR, reason: "429" },
	], NOW).state;
	assert.equal(later.availableAt("claude-bridge/claude", NOW), NOW + 2 * HOUR);
	assert.equal(later.remainingFraction("claude-bridge/claude"), 0);
});

test("a malformed quota event changes nothing", () => {
	const events = [
		{ type: "quota", ts: NOW, key: "claude-bridge/claude", remainingFraction: "half" },
		{ type: "quota", ts: NOW, key: 7, remainingFraction: 0.5 },
		{ type: "quota", ts: NOW, key: "claude-bridge/claude", remainingFraction: 1.5 },
	] as unknown as BalancerEvent[];
	assert.equal(foldEvents(events, NOW).state.remainingFraction("claude-bridge/claude"), undefined);
});

test("foldEvents clears a false exhaustion when a later usage event produces output and preserves route model", () => {
	const events: BalancerEvent[] = [
		{ type: "exhausted", ts: NOW - 2 * HOUR, key: "antigravity/gemini", until: NOW + 20 * HOUR, reason: "Individual quota reached" },
		{ type: "usage", ts: NOW - HOUR, provider: "antigravity", model: "gemini-3-8-flash", input: 500, output: 120, cacheRead: 0, cacheWrite: 0 },
		{ type: "route", ts: NOW - 10_000, pool: "orchestrator", provider: "antigravity", model: "gemini-3-8-flash", reason: "user" },
	];
	const folded = foldEvents(events, NOW);
	assert.equal(folded.state.isAvailable("antigravity/gemini", NOW), true);
	assert.equal(folded.lastRoute?.model, "gemini-3-8-flash");
});

test("R2 (fold): a short-cooldown exhaustion survives replay and a later usage reading with margin; old events stay readable", () => {
	const key = "antigravity/gemini-4-argon";
	const reading = (ts: number): BalancerEvent => ({ type: "agy-usage", ts, groups: { "Gemini 4 Argon": { remainingFraction: 0.97, resetAt: NOW + 150 * HOUR } } });
	const events: BalancerEvent[] = [
		reading(NOW - 60_000),
		{ type: "exhausted", ts: NOW, key, until: undefined, shortCooldown: true, reason: "RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota)." },
		reading(NOW + 20_000),
	];
	const { state } = foldEvents(events, NOW + 30_000);
	assert.equal(state.availableAt(key, NOW + 30_000), NOW + 6 * 60_000);
	assert.equal(state.isAvailable(key, NOW + 6 * 60_000 + 1), true);

	// the same event after a JSONL round trip, and an old event without the field
	const roundTrip = JSON.parse(JSON.stringify(events)) as BalancerEvent[];
	assert.equal(foldEvents(roundTrip, NOW + 30_000).state.availableAt(key, NOW + 30_000), NOW + 6 * 60_000);
	const old = foldEvents([{ type: "exhausted", ts: NOW, key, until: NOW + 150 * HOUR, reason: "x" }, reading(NOW + 20_000)], NOW + 30_000);
	assert.equal(old.state.isAvailable(key, NOW + 30_000), true, "old events keep the lifted-by-reading behavior");
});
