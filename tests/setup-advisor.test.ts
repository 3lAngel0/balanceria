import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ROLE_CATALOG,
	recommendRolesHeuristic,
	recommendRolesWithAdvisor,
	buildAvailableModelTargets,
	resolveEffectiveRoleRoutes,
} from "../src/setup-advisor.ts";
import { toggleCandidateInList, moveCandidateInList } from "../src/setup.ts";
import { renderPanel, renderControlCenter } from "../src/panel.ts";
import { foldEvents, type BalancerEvent } from "../src/events.ts";
import type { DetectedProvider } from "../src/setup.ts";
import type { PoolConfig } from "../src/setup.ts";

const DETECTED: DetectedProvider[] = [
	{
		id: "antigravity",
		label: "Google AI Pro (agy)",
		kind: "subscription",
		detected: true,
		source: "CLI",
		availableModels: ["claude-opus-5-5", "claude-sonnet-5-5", "gemini-4-argon", "gemini-3-8-flash"],
	},
	{
		id: "claude-bridge",
		label: "Claude Pro (claude-bridge)",
		kind: "subscription",
		detected: true,
		source: "bridge",
		availableModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-3-7-sonnet"],
	},
];

const POOLS: PoolConfig[] = [
	{
		id: "claude-opus-5-5",
		name: "Opus 5.5 (pool)",
		candidates: ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5", "antigravity/gemini-4-argon"],
		strategy: "hybrid",
	},
	{
		id: "claude-sonnet-5-5",
		name: "Sonnet 5.5 (pool)",
		candidates: ["antigravity/claude-sonnet-5-5", "claude-bridge/claude-sonnet-5-5", "antigravity/gemini-3-8-flash"],
		strategy: "hybrid",
	},
	{
		id: "orchestrator",
		name: "Orchestrator (pool)",
		candidates: ["antigravity/gemini-4-argon", "antigravity/gemini-3-8-flash", "claude-bridge/claude-sonnet-5-5"],
		strategy: "hybrid",
	},
];

test("ROLE_CATALOG defines read, write, audit, and orchestrate categories for all core agents", () => {
	assert.ok(ROLE_CATALOG.length >= 10);
	const explore = ROLE_CATALOG.find(r => r.role === "gentle-ai-explore");
	assert.equal(explore?.category, "read");
	const worker = ROLE_CATALOG.find(r => r.role === "gentle-ai-worker");
	assert.equal(worker?.category, "write");
	const verify = ROLE_CATALOG.find(r => r.role === "gentle-ai-verify");
	assert.equal(verify?.category, "audit");
	const orch = ROLE_CATALOG.find(r => r.role === "orchestrator");
	assert.equal(orch?.category, "orchestrate");
});

test("recommendRolesHeuristic assigns fast AGY model to read roles, Sonnet pool to write roles, and Argon to audit roles", () => {
	const rec = recommendRolesHeuristic({
		providers: DETECTED,
		pools: POOLS,
		quotaByKey: {
			"antigravity/gemini": 0.9,
			"antigravity/claude": 0.7,
			"claude-bridge/claude": 0.8,
		},
	});

	assert.equal(rec.source, "heuristic");
	assert.equal(rec.estimatedTokens, 0);
	const explore = rec.recommendations.find(r => r.role === "gentle-ai-explore");
	assert.equal(explore?.recommendedModel, "antigravity/gemini-3-8-flash");
	assert.equal(explore?.thinking, "low");
	assert.match(explore?.reason ?? "", /read|explore|fast/i);

	const worker = rec.recommendations.find(r => r.role === "gentle-ai-worker");
	assert.equal(worker?.recommendedModel, "pool/claude-sonnet-5-5");
	assert.equal(worker?.thinking, "medium");

	const risk = rec.recommendations.find(r => r.role === "review-risk");
	assert.equal(risk?.recommendedModel, "antigravity/gemini-4-argon");
	assert.equal(risk?.thinking, "high");
});

test("recommendRolesHeuristic never recommends Opus, even when Opus pools and models are available", () => {
	const rec = recommendRolesHeuristic({ providers: DETECTED, pools: POOLS });
	for (const row of rec.recommendations) assert.doesNotMatch(row.recommendedModel, /opus/i, row.role);
	for (const role of ["gentle-ai-verify", "review-risk", "jd-judge-a"]) {
		assert.equal(rec.recommendations.find(r => r.role === role)?.recommendedModel, "antigravity/gemini-4-argon", role);
	}
	assert.doesNotMatch(rec.summary, /opus/i);
});

test("the advisor prompt rule does not steer the model toward Opus", async () => {
	let rule = "";
	let prompt = "";
	await recommendRolesWithAdvisor(
		{ providers: DETECTED, pools: POOLS },
		{
			aiRunner: async sent => {
				prompt = sent;
				rule = sent.slice(prompt.indexOf("Rule:"));
				return { text: "{}", tokensUsed: 0 };
			},
		},
	);
	assert.match(rule, /^Rule:/);
	assert.doesNotMatch(rule, /opus/i);
	assert.doesNotMatch(prompt, /opus/i, "Opus targets are not offered to the advisor");
});

test("recommendRolesWithAdvisor uses lightweight AI runner when provided and falls back cleanly on invalid or failed output", async () => {
	const aiResult = await recommendRolesWithAdvisor(
		{ providers: DETECTED, pools: POOLS },
		{
			aiRunner: async prompt => {
				assert.ok(prompt.length < 2500, "Prompt must stay compact to use minimal tokens");
				return {
					tokensUsed: 340,
					text: JSON.stringify({
						summary: "For auditing use Claude Opus pool, for writing use Sonnet pool, and for reading/exploration use AGY Flash.",
						roles: {
							"gentle-ai-explore": { model: "antigravity/gemini-3-8-flash", thinking: "low", reason: "Fast reading via AGY Flash saves Claude quota" },
							"gentle-ai-worker": { model: "pool/claude-sonnet-5-5", thinking: "medium", reason: "Balanced coding across AGY and Claude Bridge" },
							"gentle-ai-verify": { model: "pool/claude-opus-5-5", thinking: "high", reason: "Deep verification and auditing with Claude Opus" },
						},
					}),
				};
			},
		},
	);

	assert.equal(aiResult.source, "ai+heuristic");
	assert.equal(aiResult.estimatedTokens, 340);
	// The AI asked for Opus: its model, reason and summary are dropped, the Opus-free baseline stays.
	assert.doesNotMatch(aiResult.summary, /opus/i);
	const verify = aiResult.recommendations.find(r => r.role === "gentle-ai-verify");
	assert.equal(verify?.recommendedModel, "antigravity/gemini-4-argon");
	assert.doesNotMatch(verify?.reason ?? "", /opus/i);
	// Other roles keep the AI's non-Opus advice.
	assert.equal(aiResult.recommendations.find(r => r.role === "gentle-ai-explore")?.reason, "Fast reading via AGY Flash saves Claude quota");

	// Fallback when runner throws
	const fallback = await recommendRolesWithAdvisor(
		{ providers: DETECTED, pools: POOLS },
		{
			aiRunner: async () => {
				throw new Error("CLI offline");
			},
		},
	);
	assert.equal(fallback.source, "heuristic");
	assert.equal(fallback.estimatedTokens, 0);
	assert.ok(fallback.recommendations.length >= 10);
});

test("buildAvailableModelTargets lists virtual pools first followed by detected provider/model pairs", () => {
	const targets = buildAvailableModelTargets(DETECTED, POOLS);
	assert.ok(targets.includes("pool/claude-opus-5-5"));
	assert.ok(targets.includes("pool/claude-sonnet-5-5"));
	assert.ok(targets.includes("pool/orchestrator"));
	assert.ok(targets.includes("antigravity/gemini-3-8-flash"));
	assert.ok(targets.includes("claude-bridge/claude-opus-5-5"));
});

test("toggleCandidateInList and moveCandidateInList customize pool candidate combinations safely", () => {
	const initial = ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"];
	const added = toggleCandidateInList(initial, "antigravity/gemini-4-argon");
	assert.deepEqual(added, ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5", "antigravity/gemini-4-argon"]);

	const removed = toggleCandidateInList(added, "claude-bridge/claude-opus-5-5");
	assert.deepEqual(removed, ["antigravity/claude-opus-5-5", "antigravity/gemini-4-argon"]);

	// Never removes the last remaining candidate from a pool
	const single = toggleCandidateInList(["antigravity/claude-opus-5-5"], "antigravity/claude-opus-5-5");
	assert.deepEqual(single, ["antigravity/claude-opus-5-5"]);

	const movedUp = moveCandidateInList(added, 2, -1);
	assert.deepEqual(movedUp, ["antigravity/claude-opus-5-5", "antigravity/gemini-4-argon", "claude-bridge/claude-opus-5-5"]);
});

test("resolveEffectiveRoleRoutes maps profile role routes to their category, pool candidates, and active provider", () => {
	const profile = {
		"gentle-ai-explore": { model: "antigravity/gemini-3-8-flash", thinking: "low" },
		"gentle-ai-worker": { model: "pool/claude-sonnet-5-5", thinking: "medium" },
	};
	const rows = resolveEffectiveRoleRoutes(profile, POOLS, { "claude-sonnet-5-5": "claude-bridge" });
	const explore = rows.find(r => r.role === "gentle-ai-explore");
	assert.equal(explore?.category, "read");
	assert.equal(explore?.configuredModel, "antigravity/gemini-3-8-flash");
	assert.equal(explore?.effectiveTarget, "antigravity/gemini-3-8-flash");

	const worker = rows.find(r => r.role === "gentle-ai-worker");
	assert.equal(worker?.category, "write");
	assert.equal(worker?.configuredModel, "pool/claude-sonnet-5-5");
	assert.match(worker?.effectiveTarget ?? "", /claude-bridge/);
});

test("renderPanel and renderControlCenter display active profile, pool assignments, and per-agent role mappings clearly", () => {
	const NOW = Date.parse("2026-10-25T12:00:00Z");
	const events: BalancerEvent[] = [
		{ type: "route", ts: NOW - 10_000, pool: "claude-sonnet-5-5", provider: "claude-bridge", reason: "user" },
	];
	const folded = foldEvents(events, NOW);
	const panelLines = renderPanel(folded, NOW, 50, undefined, {
		activeProfile: "nuevoPerfil",
		pools: POOLS,
		roles: {
			"gentle-ai-explore": { model: "antigravity/gemini-3-8-flash", thinking: "low" },
			"gentle-ai-worker": { model: "pool/claude-sonnet-5-5", thinking: "medium" },
		},
	});
	const panelText = panelLines.join("\n");
	assert.match(panelText, /nuevoPerfil/);
	assert.match(panelText, /explore.*gemini-3-8-flash/i);

	const centerLines = renderControlCenter({
		tab: "roles",
		width: 80,
		folded,
		now: NOW,
		activeProfile: "nuevoPerfil",
		pools: POOLS,
		roles: {
			"gentle-ai-explore": { model: "antigravity/gemini-3-8-flash", thinking: "low" },
			"gentle-ai-worker": { model: "pool/claude-sonnet-5-5", thinking: "medium" },
			"gentle-ai-verify": { model: "pool/claude-opus-5-5", thinking: "high" },
		},
		providers: DETECTED,
		cursor: 0,
	});
	const centerText = centerLines.join("\n");
	assert.match(centerText, /Roles & Agents/i);
	assert.match(centerText, /nuevoPerfil/);
	assert.match(centerText, /gentle-ai-explore/);
	assert.match(centerText, /read/i);
	assert.match(centerText, /gentle-ai-worker/);
	assert.match(centerText, /write/i);
});
