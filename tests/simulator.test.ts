import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatSimulation,
	poolOfSelection,
	readPoolSelections,
	simulate,
} from "../src/simulator.ts";
import { resolveBalancerArgs } from "../src/balancer-menu.ts";
import type { Pool } from "../src/pools.ts";
import type { HistoryEntry, QuotaError, QuotaSample } from "../src/history.ts";

test("pool attribution from model_change (including null pool and pool missing from draft)", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "sim-test-"));
	const sessionFile = join(tempDir, "session_test.jsonl");

	try {
		const lines = [
			JSON.stringify({ type: "session_start", timestamp: "2026-10-21T09:00:00.000Z" }),
			JSON.stringify({ type: "model_change", timestamp: "2026-10-21T10:00:00.000Z", provider: "pool", modelId: "pool-a" }),
			JSON.stringify({ type: "model_change", timestamp: "2026-10-21T11:00:00.000Z", provider: "anthropic", modelId: "claude-3-opus" }),
			JSON.stringify({ type: "model_change", timestamp: "2026-10-21T12:00:00.000Z", provider: "pool", modelId: "pool-missing" }),
		];
		writeFileSync(sessionFile, lines.join("\n") + "\n");

		const selections = readPoolSelections(sessionFile);
		assert.equal(selections.length, 3);
		assert.deepEqual(selections, [
			{ ts: new Date("2026-10-21T10:00:00.000Z").getTime(), pool: "pool-a" },
			{ ts: new Date("2026-10-21T11:00:00.000Z").getTime(), pool: null },
			{ ts: new Date("2026-10-21T12:00:00.000Z").getTime(), pool: "pool-missing" },
		]);

		// Selection before any model_change takes the first selection
		assert.equal(poolOfSelection(selections, new Date("2026-10-21T09:30:00.000Z").getTime()), "pool-a");
		// Selection between first and second
		assert.equal(poolOfSelection(selections, new Date("2026-10-21T10:30:00.000Z").getTime()), "pool-a");
		// Selection after second (non-pool)
		assert.equal(poolOfSelection(selections, new Date("2026-10-21T11:30:00.000Z").getTime()), null);
		// Selection after third
		assert.equal(poolOfSelection(selections, new Date("2026-10-21T12:30:00.000Z").getTime()), "pool-missing");

		// Simulate with only pool-a in draft
		const pools: Pool[] = [
			{
				id: "pool-a",
				name: "Pool A",
				candidates: [{ provider: "claude-bridge", model: "sonnet", quotaKey: "claude-bridge/claude" }],
			},
		];

		const requests: HistoryEntry[] = [
			{
				ts: new Date("2026-10-21T10:30:00.000Z").getTime(),
				session: "s1",
				project: "proj",
				provider: "claude-bridge",
				model: "sonnet",
				input: 100,
				output: 50,
				cacheRead: 10,
				cacheWrite: 0,
				contextTokens: 1000,
				contextWindow: null,
			},
			{
				ts: new Date("2026-10-21T11:30:00.000Z").getTime(),
				session: "s1",
				project: "proj",
				provider: "anthropic",
				model: "claude-3-opus",
				input: 200,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				contextTokens: 2000,
				contextWindow: null,
			},
			{
				ts: new Date("2026-10-21T12:30:00.000Z").getTime(),
				session: "s1",
				project: "proj",
				provider: "other",
				model: "m",
				input: 300,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				contextTokens: 3000,
				contextWindow: null,
			},
		];

		const report = simulate({
			pools,
			history: { requests, samples: [], errors: [] },
			poolOf: req => poolOfSelection(selections, req.ts),
			roleOf: () => "orchestrator",
		});

		assert.equal(report.overall.requests, 3);
		assert.equal(report.overall.outsidePools, 2);
		assert.equal(report.pools["pool-a"].requests, 1);
		assert.equal(report.pools["pool-a"].changed, 0);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("prefer-for-role draft moves worker session to candidate while orchestrator stays", () => {
	const pools: Pool[] = [
		{
			id: "claude-sonnet-5-5",
			name: "Sonnet Hybrid",
			candidates: [
				{ provider: "claude-bridge", model: "claude-sonnet-5-5", quotaKey: "claude-bridge/claude" },
				{ provider: "antigravity", model: "gemini-3-8-flash", quotaKey: "antigravity/gemini" },
			],
			rules: [
				{ rule: "prefer-for-role", role: "gentle-ai-worker", candidate: "antigravity/gemini-3-8-flash" },
				{ rule: "pick", mode: "first" },
			],
		},
	];

	const requests: HistoryEntry[] = [
		{
			ts: 1000,
			session: "worker-session",
			project: "proj",
			provider: "claude-bridge",
			model: "claude-sonnet-5-5",
			input: 500,
			output: 200,
			cacheRead: 100,
			cacheWrite: 50,
			contextTokens: 5000,
			contextWindow: null,
		},
		{
			ts: 2000,
			session: "orchestrator-session",
			project: "proj",
			provider: "claude-bridge",
			model: "claude-sonnet-5-5",
			input: 800,
			output: 300,
			cacheRead: 200,
			cacheWrite: 100,
			contextTokens: 10000,
			contextWindow: null,
		},
	];

	const report = simulate({
		pools,
		history: { requests, samples: [], errors: [] },
		poolOf: () => "claude-sonnet-5-5",
		roleOf: req => (req.session === "worker-session" ? "gentle-ai-worker" : "orchestrator"),
	});

	const poolReport = report.pools["claude-sonnet-5-5"];
	assert.equal(poolReport.requests, 2);
	assert.equal(poolReport.changed, 1);

	// Worker was moved
	assert.deepEqual(poolReport.roles["gentle-ai-worker"], { requests: 1, changed: 1 });
	// Orchestrator stayed
	assert.deepEqual(poolReport.roles["orchestrator"], { requests: 1, changed: 0 });

	// Candidate actual vs simulated
	assert.equal(poolReport.candidates["claude-bridge/claude-sonnet-5-5"].requests.actual, 2);
	assert.equal(poolReport.candidates["claude-bridge/claude-sonnet-5-5"].requests.simulated, 1);
	assert.equal(poolReport.candidates["antigravity/gemini-3-8-flash"].requests.actual, 0);
	assert.equal(poolReport.candidates["antigravity/gemini-3-8-flash"].requests.simulated, 1);
});

test("quota replay: quota-error makes preferred candidate unavailable so pick decides", () => {
	const pools: Pool[] = [
		{
			id: "claude-sonnet-5-5",
			name: "Sonnet Hybrid",
			candidates: [
				{ provider: "claude-bridge", model: "claude-sonnet-5-5", quotaKey: "claude-bridge/claude" },
				{ provider: "antigravity", model: "gemini-3-8-flash", quotaKey: "antigravity/gemini" },
			],
			rules: [
				{ rule: "prefer-for-role", role: "gentle-ai-worker", candidate: "antigravity/gemini-3-8-flash" },
				{ rule: "pick", mode: "first" },
			],
		},
	];

	const errors: QuotaError[] = [
		{
			kind: "quota-error",
			ts: 1000,
			session: "s0",
			project: "proj",
			key: "antigravity/gemini",
			until: 3000,
		},
	];

	const requests: HistoryEntry[] = [
		// Request at 2000 is during exhaustion window (1000 - 3000)
		{
			ts: 2000,
			session: "worker-s1",
			project: "proj",
			provider: "claude-bridge",
			model: "claude-sonnet-5-5",
			input: 500,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			contextTokens: 1000,
			contextWindow: null,
		},
		// Request at 4000 is after exhaustion window reopens
		{
			ts: 4000,
			session: "worker-s2",
			project: "proj",
			provider: "claude-bridge",
			model: "claude-sonnet-5-5",
			input: 500,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			contextTokens: 1000,
			contextWindow: null,
		},
	];

	const report = simulate({
		pools,
		history: { requests, samples: [], errors },
		poolOf: () => "claude-sonnet-5-5",
		roleOf: () => "gentle-ai-worker",
	});

	const poolReport = report.pools["claude-sonnet-5-5"];
	// req at 2000 fell back to claude-bridge (no change vs actual)
	// req at 4000 went to antigravity (changed vs actual)
	assert.equal(poolReport.requests, 2);
	assert.equal(poolReport.changed, 1);
	assert.equal(poolReport.candidates["claude-bridge/claude-sonnet-5-5"].requests.simulated, 1);
	assert.equal(poolReport.candidates["antigravity/gemini-3-8-flash"].requests.simulated, 1);
});

test("switch counting with re-sent tokens", () => {
	const pools: Pool[] = [
		{
			id: "pool-p",
			name: "Pool P",
			candidates: [
				{ provider: "provider-a", model: "model-a", quotaKey: "key-a" },
				{ provider: "provider-b", model: "model-b", quotaKey: "key-b" },
			],
			rules: [{ rule: "sticky" }, { rule: "pick", mode: "first" }],
		},
	];

	// Session S1 has 3 requests:
	// Turn 1 (t=1000): contextTokens 12000. Actual = provider-a, simulated = provider-a.
	// Turn 2 (t=2000): contextTokens 25000. Actual = provider-b (switch from a!). Simulated = provider-a (sticky!).
	// Quota error on key-a at t=2500 until 5000.
	// Turn 3 (t=3000): contextTokens 40000. Actual = provider-b. Simulated = provider-b (switch from a due to exhaustion!).
	const requests: HistoryEntry[] = [
		{
			ts: 1000,
			session: "s1",
			project: "proj",
			provider: "provider-a",
			model: "model-a",
			input: 1000,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			contextTokens: 12000,
			contextWindow: null,
		},
		{
			ts: 2000,
			session: "s1",
			project: "proj",
			provider: "provider-b",
			model: "model-b",
			input: 1000,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			contextTokens: 25000,
			contextWindow: null,
		},
		{
			ts: 3000,
			session: "s1",
			project: "proj",
			provider: "provider-b",
			model: "model-b",
			input: 1000,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			contextTokens: 40000,
			contextWindow: null,
		},
	];

	const errors: QuotaError[] = [
		{
			kind: "quota-error",
			ts: 2500,
			session: "s1",
			project: "proj",
			key: "key-a",
			until: 5000,
		},
	];

	const report = simulate({
		pools,
		history: { requests, samples: [], errors },
		poolOf: () => "pool-p",
		roleOf: () => "orchestrator",
	});

	const poolReport = report.pools["pool-p"];
	// Actual switched on turn 2: re-sent turn 1's contextTokens (12000). Turn 3 stayed on provider-b.
	assert.equal(poolReport.switches.actual.count, 1);
	assert.equal(poolReport.switches.actual.resentTokens, 12000);

	// Simulated stayed on provider-a on turn 2 (sticky). Switched on turn 3 to provider-b:
	// re-sent turn 2's contextTokens (25000).
	assert.equal(poolReport.switches.simulated.count, 1);
	assert.equal(poolReport.switches.simulated.resentTokens, 25000);
});

const SONNET: Pool = {
	id: "claude-sonnet-5-5",
	name: "Sonnet",
	candidates: [
		{ provider: "claude-bridge", model: "claude-sonnet-5-5", quotaKey: "claude-bridge/claude" },
		{ provider: "antigravity", model: "gemini-3-8-flash", quotaKey: "antigravity/gemini" },
	],
	strategy: "waterfall",
};
const DRAFT: Pool = { ...SONNET, rules: [{ rule: "sticky" }, { rule: "prefer-for-role", role: "gentle-ai-worker", candidate: "antigravity/gemini-3-8-flash" }, { rule: "pick", mode: "first" }] };

function request(ts: number, session: string, provider: string, model: string): HistoryEntry {
	return { ts, session, project: "proj", provider, model, input: 1000, output: 500, cacheRead: 8000, cacheWrite: 500, contextTokens: 10000, contextWindow: null };
}

// The orchestrator really ran on Flash (a quota state the replay cannot see),
// so the current rules replayed put it on claude-bridge: that is replay noise,
// not something the draft changes.
const NOISY: HistoryEntry[] = [
	request(Date.parse("2026-10-21T12:00:00Z"), "orch", "antigravity", "gemini-3-8-flash"),
	request(Date.parse("2026-10-21T12:01:00Z"), "worker", "claude-bridge", "claude-sonnet-5-5"),
	request(Date.parse("2026-10-21T12:02:00Z"), "worker", "claude-bridge", "claude-sonnet-5-5"),
];
const roleOf = (req: HistoryEntry) => (req.session === "worker" ? "gentle-ai-worker" : "orchestrator");

test("with a baseline, a draft equal to the current rules changes nothing even when the replay differs from what happened", () => {
	const report = simulate({ pools: [SONNET], baseline: [SONNET], history: { requests: NOISY }, poolOf: () => SONNET.id, roleOf });
	assert.equal(report.hasBaseline, true);
	assert.equal(report.pools[SONNET.id].changed, 0);
	assert.deepEqual(report.pools[SONNET.id].roles, { "gentle-ai-worker": { requests: 2, changed: 0 }, orchestrator: { requests: 1, changed: 0 } });
});

test("with a baseline, changed counts only the requests the draft moves", () => {
	const report = simulate({ pools: [DRAFT], baseline: [SONNET], history: { requests: NOISY }, poolOf: () => SONNET.id, roleOf });
	const pool = report.pools[SONNET.id];
	assert.equal(pool.changed, 2);
	assert.deepEqual(pool.roles, { "gentle-ai-worker": { requests: 2, changed: 2 }, orchestrator: { requests: 1, changed: 0 } });
	assert.deepEqual(pool.candidates["claude-bridge/claude-sonnet-5-5"].requests, { actual: 2, baseline: 3, simulated: 1 });
	assert.deepEqual(pool.candidates["antigravity/gemini-3-8-flash"].requests, { actual: 1, baseline: 0, simulated: 2 });
});

test("formatSimulation prints actual, current rules and draft side by side", () => {
	const report = simulate({ pools: [DRAFT], baseline: [SONNET], history: { requests: NOISY }, poolOf: req => (req.session === "orch" ? null : SONNET.id), roleOf });
	assert.equal(
		formatSimulation(report, "pools.draft.json"),
		[
			"=== Simulation: pools.draft.json ===",
			"Period: 2026-10-21 to 2026-10-21",
			"Requests: 3 total (1 outside pools)",
			"Columns: actual · current rules → draft",
			"",
			"Pool: claude-sonnet-5-5",
			"  Requests: 2 (2 changed by the draft)",
			"  Switches: 0 (0 re-sent) · 0 (0 re-sent) → 0 (0 re-sent)",
			"  Candidates (requests, tokens):",
			"    claude-bridge/claude-sonnet-5-5: 2 20.0k · 2 20.0k → 0 0",
			"    antigravity/gemini-3-8-flash: 0 0 · 0 0 → 2 20.0k",
			"  Roles:",
			"    gentle-ai-worker: 2 requests (2 changed)",
			"",
			"Assumptions:",
			"- \"changed\" compares the draft with the current rules replayed the same way, not with what happened",
			"- Same tokens on the new candidate",
			"- Recorded quota windows, not re-simulated fills",
			"- Turns after a session's first count as continuations",
		].join("\n"),
	);
});

test("without a baseline formatSimulation prints actual against the draft", () => {
	const report = simulate({ pools: [DRAFT], history: { requests: NOISY.slice(1) }, poolOf: () => SONNET.id, roleOf });
	const text = formatSimulation(report, "pools.json");
	assert.match(text, /^Columns: actual → draft$/m);
	assert.match(text, /^ {4}antigravity\/gemini-3-8-flash: 0 0 → 2 20\.0k$/m);
	assert.doesNotMatch(text, /current rules replayed/);
});

test("resolveBalancerArgs handles simulate and existing subcommands", () => {
	assert.deepEqual(resolveBalancerArgs("simulate"), { kind: "command", command: "simulate" });
	assert.deepEqual(resolveBalancerArgs("simulate pools.draft.json"), { kind: "command", command: "simulate pools.draft.json" });
	assert.deepEqual(resolveBalancerArgs("  simulate my-pools.json  "), { kind: "command", command: "simulate my-pools.json" });
	// Existing subcommand still resolves as before
	assert.deepEqual(resolveBalancerArgs("report"), { kind: "command", command: "report" });
	assert.deepEqual(resolveBalancerArgs("panel"), { kind: "command", command: "panel" });
});
