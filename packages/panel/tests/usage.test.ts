import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory, dayKey, type HistoryEntry, type RouteDecision } from "../../../src/history.ts";
import { buildPanelHistory, buildUsage } from "../src/usage.ts";

const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;

function request(ts: number, provider: string, tokens: number): HistoryEntry {
	return { ts, session: "s1", project: "shop", provider, model: "m", input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: null, contextWindow: null };
}

test("buildUsage turns the balancer history into daily tokens per provider and quota peaks per window", () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-usage-"));
	try {
		appendHistory(dir, request(NOW - DAY, "agy", 100));
		appendHistory(dir, request(NOW - 60_000, "agy", 50));
		appendHistory(dir, request(NOW - 60_000, "claude-bridge", 400));
		appendHistory(dir, { kind: "quota", ts: NOW - DAY, session: "s1", limit: "claude", window: "5h", windowSeconds: 18_000, usedPercent: 40, resetAt: null });
		appendHistory(dir, { kind: "quota", ts: NOW - DAY + 60_000, session: "s1", limit: "claude", window: "5h", windowSeconds: 18_000, usedPercent: 70, resetAt: null });
		const usage = buildUsage(dir, NOW);
		assert.equal(usage.days.length, 30);
		assert.equal(usage.days.at(-1), dayKey(NOW));
		assert.equal(usage.days.at(-2), dayKey(NOW - DAY));
		assert.deepEqual(
			usage.tokens.map(s => [s.provider, s.total, s.daily.at(-2), s.daily.at(-1), s.daily.length]),
			[
				["claude-bridge", 400, 0, 400, 30],
				["agy", 150, 100, 50, 30],
			],
		);
		assert.equal(usage.quota.length, 1);
		const [series] = usage.quota;
		assert.deepEqual([series!.limit, series!.window, series!.peak, series!.fills, series!.daily.length], ["claude", "5h", 70, 0, 30]);
		assert.equal(series!.daily.at(-2), 70);
		assert.equal(series!.daily.at(-1), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildUsage with no history gives 30 days and no series", () => {
	const usage = buildUsage(join(tmpdir(), "panel-usage-missing-dir"), NOW);
	assert.equal(usage.days.length, 30);
	assert.deepEqual(usage.tokens, []);
	assert.deepEqual(usage.quota, []);
});

function route(ts: number, overrides: Partial<RouteDecision> = {}): RouteDecision {
	return {
		kind: "route", ts, session: "0123456789abcdef", project: "shop", pool: "opus", role: "gentle-ai-verify", roleSource: "argv",
		reason: "user", chosen: "claude-bridge/opus", decidedBy: "highest-quota",
		steps: [{ rule: "pick", result: "chosen", why: "claude-bridge/opus 0.62 > agy/opus 0.30" }],
		candidates: [{ provider: "claude-bridge", quotaKey: "claude-bridge/claude", available: true, remaining: 0.62 }],
		contextTokens: 1200,
		...overrides,
	};
}

test("buildPanelHistory reads the history once into the usage charts and the routing decisions", () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-usage-"));
	try {
		appendHistory(dir, request(NOW - 60_000, "agy", 50));
		appendHistory(dir, route(NOW - 120_000));
		appendHistory(dir, route(NOW - 60_000, { decidedBy: "sticky", reason: "continuation", role: "orchestrator", roleSource: "none" }));
		appendHistory(dir, route(NOW - 40 * DAY));
		const views = buildPanelHistory(dir, NOW);
		assert.deepEqual(views.usage, buildUsage(dir, NOW));
		assert.equal(views.decisions.total, 2);
		assert.deepEqual(views.decisions.byRule, [
			{ rule: "highest-quota", count: 1 },
			{ rule: "sticky", count: 1 },
		]);
		assert.deepEqual(views.decisions.recent.map(d => [d.ts, d.decidedBy, d.role, d.session]), [
			[NOW - 60_000, "sticky", "orchestrator", "01234567"],
			[NOW - 120_000, "highest-quota", "gentle-ai-verify", "01234567"],
		]);
		assert.equal(views.decisions.omitted, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildPanelHistory with no history gives empty decisions", () => {
	const views = buildPanelHistory(join(tmpdir(), "panel-usage-missing-dir"), NOW);
	assert.deepEqual(views.decisions, { total: 0, byRule: [], byRole: [], recent: [], omitted: 0 });
	assert.equal(views.usage.days.length, 30);
});
