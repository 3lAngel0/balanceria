import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BalancerEvent } from "../src/events.ts";
import { appendHistory, dayKey, HISTORY_DIR, legacyRecords, pruneHistory, readHistory, type HistoryEntry, type QuotaError, type QuotaSample, type RouteDecision } from "../src/history.ts";

const DAY = 24 * 3_600_000;

function localTime(year: number, month: number, day: number, hour = 12): number {
	return new Date(year, month - 1, day, hour).getTime();
}

const NOW = localTime(2026, 10, 18);

function entry(ts: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		ts,
		session: "s1",
		project: "balancingIa",
		provider: "claude-bridge",
		model: "claude-opus-5-5",
		input: 10,
		output: 20,
		cacheRead: 300,
		cacheWrite: 4,
		contextTokens: 50_000,
		contextWindow: 200_000,
		...overrides,
	};
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "balancer-history-"));
}

test("dayKey names the local calendar day", () => {
	assert.equal(dayKey(localTime(2026, 1, 5, 0)), "2026-01-05");
	assert.equal(dayKey(localTime(2026, 12, 31, 23)), "2026-12-31");
});

test("appendHistory writes one JSON line per entry into the file of its local day", () => {
	const dir = tempDir();
	appendHistory(dir, entry(NOW));
	appendHistory(dir, entry(NOW + 1000, { session: "s2" }));
	appendHistory(dir, entry(NOW - DAY));
	assert.deepEqual(readdirSync(join(dir, HISTORY_DIR)).sort(), ["2026-10-17.jsonl", "2026-10-18.jsonl"]);

	const entries = readHistory(dir, NOW).requests;
	assert.deepEqual(entries.map(item => [item.ts, item.session]), [[NOW - DAY, "s1"], [NOW, "s1"], [NOW + 1000, "s2"]]);
	assert.deepEqual(entries[1], entry(NOW));
});

test("readHistory reads only the last 30 local days and skips torn or invalid lines", () => {
	const dir = tempDir();
	appendHistory(dir, entry(localTime(2026, 9, 19)));
	appendHistory(dir, entry(localTime(2026, 9, 18)));
	appendFileSync(join(dir, HISTORY_DIR, "2026-10-18.jsonl"), "{\"ts\":1,\"sess\n[]\n{\"ts\":\"x\"}\n");
	appendHistory(dir, entry(NOW));
	assert.deepEqual(readHistory(dir, NOW).requests.map(item => item.ts), [localTime(2026, 9, 19), NOW]);
	assert.deepEqual(readHistory(tempDir(), NOW), { requests: [], samples: [], errors: [], routes: [] }, "no history yet is empty");
});

test("quota samples and quota errors round-trip into their own lists; unknown kinds and malformed samples are skipped", () => {
	const dir = tempDir();
	const sample: QuotaSample = { kind: "quota", ts: NOW, session: "s1", limit: "agy claude", key: "antigravity/claude", window: "week", windowSeconds: 604_800, usedPercent: 42, resetAt: null };
	const failure: QuotaError = { kind: "quota-error", ts: NOW - 1000, session: "s2", project: "web", key: "claude-bridge/claude", until: NOW + 5000 };
	appendHistory(dir, sample);
	appendHistory(dir, failure);
	appendHistory(dir, entry(NOW));
	appendFileSync(
		join(dir, HISTORY_DIR, "2026-10-18.jsonl"),
		`${JSON.stringify({ kind: "mystery", ts: NOW })}\n${JSON.stringify({ ...sample, usedPercent: "x" })}\n`,
	);
	const data = readHistory(dir, NOW);
	assert.deepEqual(data.samples, [sample]);
	assert.deepEqual(data.errors, [failure]);
	assert.deepEqual(data.requests, [entry(NOW)]);
});

test("pruneHistory deletes only day files older than 30 days and leaves everything else", () => {
	const dir = tempDir();
	const history = join(dir, HISTORY_DIR);
	mkdirSync(history, { recursive: true });
	for (const name of ["2026-09-17.jsonl", "2026-09-18.jsonl", "2026-09-19.jsonl", "2026-10-18.jsonl", "notes.txt", "2026-01-01.jsonl.bak"]) {
		writeFileSync(join(history, name), "x\n");
	}
	assert.deepEqual(pruneHistory(dir, NOW).sort(), ["2026-09-17.jsonl", "2026-09-18.jsonl"]);
	assert.deepEqual(readdirSync(history).sort(), ["2026-01-01.jsonl.bak", "2026-09-19.jsonl", "2026-10-18.jsonl", "notes.txt"]);
	assert.deepEqual(pruneHistory(dir, NOW), [], "a second prune removes nothing");
	assert.deepEqual(pruneHistory(tempDir(), NOW), [], "a missing directory prunes nothing");
});

test("legacyRecords turns usage and exhausted events older than the cutoff into history records", () => {
	const usage = (ts: number, extra: Partial<Extract<BalancerEvent, { type: "usage" }>> = {}): BalancerEvent => ({
		type: "usage", ts, provider: "antigravity", model: "gemini-3-flash", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, ...extra,
	});
	const events: BalancerEvent[] = [
		usage(NOW - 10 * DAY),
		usage(NOW - 5 * DAY),
		usage(NOW - 40 * DAY),
		{ type: "exhausted", ts: NOW - 9 * DAY, key: "antigravity/claude", until: NOW - 8 * DAY, reason: "x" },
		{ type: "exhausted", ts: NOW - 2 * DAY, key: "antigravity/claude", until: undefined, reason: "x" },
		{ type: "route", ts: NOW - 9 * DAY, pool: "p", provider: "antigravity", reason: "r" },
	];
	const legacy = legacyRecords(events, NOW - 3 * DAY, NOW);
	assert.deepEqual(
		legacy.requests,
		[NOW - 10 * DAY, NOW - 5 * DAY].map(ts =>
			entry(ts, { session: "legacy", project: "(before history)", provider: "antigravity", model: "gemini-3-flash", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, contextTokens: null, contextWindow: null }),
		),
		"older than the cutoff and inside 30 days only",
	);
	assert.deepEqual(legacy.errors, [
		{ kind: "quota-error", ts: NOW - 9 * DAY, session: "legacy", project: "(before history)", key: "antigravity/claude", until: NOW - 8 * DAY },
	]);
	assert.equal(legacyRecords(events, Number.POSITIVE_INFINITY, NOW).requests.length, 3 - 1, "no history yet keeps every event inside 30 days");
	assert.deepEqual(legacyRecords([], NOW, NOW), { requests: [], errors: [] });
});

test("child and sessionName round-trip, rows without them stay valid, and wrong types are skipped", () => {
	const dir = tempDir();
	appendHistory(dir, entry(NOW, { child: true, sessionName: "fix login mu-web" }));
	appendHistory(dir, entry(NOW + 1, { child: false, sessionName: null }));
	appendHistory(dir, entry(NOW + 2));
	appendFileSync(join(dir, HISTORY_DIR, "2026-10-18.jsonl"), `${JSON.stringify({ ...entry(NOW + 3), child: "yes" })}\n${JSON.stringify({ ...entry(NOW + 4), sessionName: 5 })}\n`);
	const requests = readHistory(dir, NOW).requests;
	assert.deepEqual(requests.map(item => [item.ts - NOW, item.child, item.sessionName]), [[0, true, "fix login mu-web"], [1, false, null], [2, undefined, undefined]]);
});

test("route decisions round-trip into their own list, leave requests alone, and malformed ones are skipped", () => {
	const dir = tempDir();
	const decision: RouteDecision = {
		kind: "route", ts: NOW, session: "s1", project: "balancingIa", pool: "claude-opus-5-5",
		role: "gentle-ai-verify", roleSource: "argv", reason: "user", chosen: "claude-bridge/claude-opus-5-5", decidedBy: "highest-quota",
		steps: [{ rule: "available", result: "2 of 2", why: "no window is spent" }, { rule: "pick", result: "chosen", why: "claude-bridge/claude-opus-5-5 0.62 > antigravity/claude-opus-5-5 0.30" }],
		candidates: [{ provider: "antigravity", quotaKey: "antigravity/claude", available: true, remaining: 0.3 }, { provider: "claude-bridge", quotaKey: "claude-bridge/claude", available: true, remaining: 0.62 }],
		contextTokens: 152_300,
	};
	appendHistory(dir, decision);
	appendHistory(dir, entry(NOW));
	appendFileSync(join(dir, HISTORY_DIR, "2026-10-18.jsonl"), `${JSON.stringify({ ...decision, steps: "x" })}\n${JSON.stringify({ ...decision, pool: 3 })}\n`);
	const data = readHistory(dir, NOW);
	assert.deepEqual(data.routes, [decision]);
	assert.deepEqual(data.requests, [entry(NOW)]);
	assert.deepEqual(data.samples, []);
});
