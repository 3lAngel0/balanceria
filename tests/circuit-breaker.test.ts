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

test("CircuitBreaker lets go on its own once a candidate of the tripped pool has quota again", () => {
	const dir = mkdtempSync(join(tmpdir(), "cb-test-"));
	try {
		const cb = new CircuitBreaker(dir);
		const state = new QuotaState();
		state.markExhausted("antigravity/claude", NOW + 3_600_000, "weekly");
		state.markExhausted("claude-bridge/claude", NOW + 1_800_000, "5h");
		cb.checkAndTrip({ poolId: "claude-opus-5-5", candidates: CANDIDATES, state, session: "sess-1", project: "proj-1", now: NOW });
		assert.equal(cb.isTripped(), true);

		// Still spent: nothing changes, and a tripped breaker is not cleared by a different pool's candidates.
		assert.equal(cb.reopenIfAvailable(CANDIDATES, state, NOW + 60_000), false);
		assert.equal(cb.isTripped(), true);

		// The 5h window of one candidate resets: the pool has margin again, so the alert must go away.
		assert.equal(cb.reopenIfAvailable(CANDIDATES, state, NOW + 1_800_001), true);
		assert.equal(cb.isTripped(), false);
		assert.equal(cb.getStatus().tripped, false);
		assert.equal(cb.getStatus().poolId, undefined);

		// Nothing to reopen when it is not tripped.
		assert.equal(cb.reopenIfAvailable(CANDIDATES, state, NOW + 1_800_001), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CircuitBreaker reopens when a fresh quota reading shows margin on a candidate that was only on a guessed cooldown", () => {
	const dir = mkdtempSync(join(tmpdir(), "cb-test-"));
	try {
		const cb = new CircuitBreaker(dir);
		const state = new QuotaState();
		state.markExhausted("antigravity/claude", NOW + 3_600_000, "weekly");
		// No reset time from the provider: the cooldown is our guess, so fresh data can lift it.
		state.markExhausted("claude-bridge/claude", undefined, "5h", NOW);
		cb.checkAndTrip({ poolId: "claude-opus-5-5", candidates: CANDIDATES, state, session: "sess-1", project: "proj-1", now: NOW });

		state.setQuotaFraction("claude-bridge/claude", 0.82, NOW + 7 * 86_400_000, NOW + 120_000);
		assert.equal(cb.reopenIfAvailable(CANDIDATES, state, NOW + 120_000), true);
		assert.equal(cb.isTripped(), false);

		// Whereas a provider-given reset time is not overridden by a reading with margin.
		const strict = new QuotaState();
		strict.markExhausted("antigravity/claude", NOW + 3_600_000, "weekly");
		strict.markExhausted("claude-bridge/claude", NOW + 1_800_000, "5h");
		const other = new CircuitBreaker(dir);
		other.checkAndTrip({ poolId: "claude-opus-5-5", candidates: CANDIDATES, state: strict, session: "s", project: "p", now: NOW });
		strict.setQuotaFraction("claude-bridge/claude", 0.82, NOW + 7 * 86_400_000, NOW + 120_000);
		assert.equal(other.reopenIfAvailable(CANDIDATES, strict, NOW + 120_000), false);
		assert.equal(other.isTripped(), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
