import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CircuitBreaker } from "../src/circuit-breaker.ts";
import { QuotaState } from "../src/state.ts";
import type { Candidate } from "../src/router.ts";
import { statusLine, renderPanel } from "../src/panel.ts";
import type { FoldedEvents } from "../src/events.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const CANDIDATES: Candidate[] = [
	{ provider: "antigravity", model: "claude-opus-5-5", quotaKey: "antigravity/claude" },
	{ provider: "claude-bridge", model: "claude-opus-5-5", quotaKey: "claude-bridge/claude" },
];

test("CircuitBreaker stays untripped when candidates are available", () => {
	const dir = mkdtempSync(join(tmpdir(), "cb-test-"));
	try {
		const cb = new CircuitBreaker(dir);
		const state = new QuotaState();
		const result = cb.checkAndTrip({
			poolId: "claude-opus-5-5",
			candidates: CANDIDATES,
			state,
			session: "sess-1",
			project: "proj-1",
			now: NOW,
		});
		assert.equal(result, null);
		assert.equal(cb.isTripped(), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CircuitBreaker trips and writes checkpoint when all candidates in pool are exhausted", () => {
	const dir = mkdtempSync(join(tmpdir(), "cb-test-"));
	try {
		const cb = new CircuitBreaker(dir);
		const state = new QuotaState();
		state.markExhausted("antigravity/claude", NOW + 3_600_000, "weekly");
		state.markExhausted("claude-bridge/claude", NOW + 1_800_000, "5h");

		const checkpoint = cb.checkAndTrip({
			poolId: "claude-opus-5-5",
			candidates: CANDIDATES,
			state,
			session: "sess-1",
			project: "proj-1",
			now: NOW,
		});

		assert.ok(checkpoint);
		assert.equal(cb.isTripped(), true);
		assert.equal(checkpoint.poolId, "claude-opus-5-5");
		assert.equal(checkpoint.soonestResetAt, NOW + 1_800_000);
		assert.equal(checkpoint.candidates.length, 2);

		const status = cb.getStatus();
		assert.equal(status.tripped, true);
		assert.equal(status.poolId, "claude-opus-5-5");

		// statusLine displays alert
		const folded: FoldedEvents = {
			state,
			tokens: new Map(),
			lastRoute: undefined,
			lastAgyUsageAt: undefined,
		};
		const line = statusLine(folded, NOW, status);
		assert.match(line, /CIRCUIT BREAKER: All providers spent/);

		// renderPanel displays warning section
		const panel = renderPanel(folded, NOW, 40, status);
		assert.ok(panel.some(l => l.includes("CIRCUIT BREAKER")));
		assert.ok(panel.some(l => l.includes("ALL POOL CANDIDATES SPENT")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
