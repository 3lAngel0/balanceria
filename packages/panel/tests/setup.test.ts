import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILES_KIND, PROFILES_VERSION, type ProfilesStore } from "../../../src/profiles.ts";
import { readSetupView, saveSetupView } from "../src/setup.ts";

const VALID_STORE: ProfilesStore = {
	kind: PROFILES_KIND,
	version: PROFILES_VERSION,
	active: "default",
	profiles: {
		default: {
			orchestrator: { model: "pool/orchestrator", thinking: "medium" },
			"gentle-ai-worker": { model: "pool/claude-sonnet-5-5", thinking: "medium" },
		},
	},
};

const VALID_POOLS = {
	pools: [
		{
			id: "orchestrator",
			name: "Orchestrator pool",
			candidates: ["antigravity/gemini-4-argon", "claude-bridge/claude-sonnet-5-5"],
			strategy: "hybrid",
		},
		{
			id: "claude-sonnet-5-5",
			name: "Sonnet pool",
			candidates: ["antigravity/claude-sonnet-5-5", "claude-bridge/claude-sonnet-5-5"],
			strategy: "hybrid",
		},
	],
};

const VALID_INTEGRATIONS = {
	integrations: [
		{ provider: "antigravity", kind: "subscription", label: "Google AI Pro (agy)" },
		{ provider: "claude-bridge", kind: "subscription", label: "Claude Pro (claude-bridge)" },
	],
};

test("readSetupView reads pools, profiles, and generates role catalog and advisor recommendations", () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-setup-"));
	const profilesFile = join(dir, "profiles.json");
	const poolsFile = join(dir, "pools.json");
	writeFileSync(profilesFile, JSON.stringify(VALID_STORE, null, 1) + "\n");
	writeFileSync(poolsFile, JSON.stringify(VALID_POOLS, null, 1) + "\n");

	try {
		const view = readSetupView({ root: dir, poolsPath: poolsFile, profilesPath: profilesFile });
		assert.equal(view.activeProfile, "default");
		assert.equal(view.pools.length, 2);
		assert.ok(view.roleRows.length >= 10);
		const orchRow = view.roleRows.find(r => r.role === "orchestrator");
		assert.equal(orchRow?.configuredModel, "pool/orchestrator");
		assert.ok(view.availableTargets.includes("pool/orchestrator"));
		assert.ok(view.advisor.recommendations.length >= 10);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveSetupView updates role assignment and thinking in profiles.json", async () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-setup-"));
	const profilesFile = join(dir, "profiles.json");
	const poolsFile = join(dir, "pools.json");
	writeFileSync(profilesFile, JSON.stringify(VALID_STORE, null, 1) + "\n");
	writeFileSync(poolsFile, JSON.stringify(VALID_POOLS, null, 1) + "\n");

	try {
		const res = await saveSetupView(
			{ root: dir, poolsPath: poolsFile, profilesPath: profilesFile, hasModel: () => true },
			{ type: "set-role", role: "gentle-ai-explore", model: "antigravity/gemini-3-8-flash", thinking: "low" },
		);
		assert.equal(res.status, 200);
		const saved = JSON.parse(readFileSync(profilesFile, "utf8")) as ProfilesStore;
		assert.deepEqual(saved.profiles.default?.["gentle-ai-explore"], {
			model: "antigravity/gemini-3-8-flash",
			thinking: "low",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveSetupView toggles pool strategy and applies advisor recommendations", async () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-setup-"));
	const profilesFile = join(dir, "profiles.json");
	const poolsFile = join(dir, "pools.json");
	const intFile = join(dir, "integrations.json");
	writeFileSync(profilesFile, JSON.stringify(VALID_STORE, null, 1) + "\n");
	writeFileSync(poolsFile, JSON.stringify(VALID_POOLS, null, 1) + "\n");
	writeFileSync(intFile, JSON.stringify(VALID_INTEGRATIONS, null, 1) + "\n");

	try {
		// Toggle strategy
		const toggleRes = await saveSetupView(
			{ root: dir, poolsPath: poolsFile, profilesPath: profilesFile },
			{ type: "toggle-strategy", poolId: "orchestrator" },
		);
		assert.equal(toggleRes.status, 200);
		const savedPools = JSON.parse(readFileSync(poolsFile, "utf8")) as typeof VALID_POOLS;
		const orchPool = savedPools.pools.find(p => p.id === "orchestrator");
		assert.equal(orchPool?.strategy, "waterfall");

		// Apply advisor
		const applyRes = await saveSetupView(
			{ root: dir, poolsPath: poolsFile, profilesPath: profilesFile, hasModel: () => true },
			{ type: "apply-advisor" },
		);
		assert.equal(applyRes.status, 200);
		const storeAfter = JSON.parse(readFileSync(profilesFile, "utf8")) as ProfilesStore;
		assert.ok(Object.keys(storeAfter.profiles.default ?? {}).length >= 10);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
