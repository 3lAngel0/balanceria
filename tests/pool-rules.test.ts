import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePoolsConfig } from "../src/config-schema.ts";
import { ignoredRuleWarnings, parsePools } from "../src/pools.ts";
import { runSetupWizard } from "../src/setup.ts";

const SONNET = ["antigravity/claude-sonnet-5-5", "claude-bridge/claude-sonnet-5-5", "antigravity/gemini-3-8-flash"];
const WORKER_TO_FLASH = [
	{ rule: "sticky" },
	{ rule: "prefer-for-role", role: "gentle-ai-worker", candidate: "antigravity/gemini-3-8-flash" },
	{ rule: "pick", mode: "highest-quota" },
];

function pools(rules: unknown, extra: Record<string, unknown> = {}) {
	return { pools: [{ id: "claude-sonnet-5-5", name: "Sonnet", candidates: SONNET, ...extra, rules }] };
}

test("parsePools reads valid rules and leaves pools without rules unchanged", () => {
	const [withRules] = parsePools(pools(WORKER_TO_FLASH, { strategy: "hybrid" }));
	assert.deepEqual(withRules.rules, WORKER_TO_FLASH);
	const [plain] = parsePools({ pools: [{ id: "claude-sonnet-5-5", name: "Sonnet", candidates: SONNET }] });
	assert.equal("rules" in plain, false);
});

test("validatePoolsConfig accepts valid rules", () => {
	const result = validatePoolsConfig(pools(WORKER_TO_FLASH, { strategy: "hybrid" }));
	assert.deepEqual(result.issues, []);
	assert.equal(result.valid, true);
});

const INVALID: [string, unknown, Record<string, unknown>, string, string][] = [
	["not an array", "sticky", {}, "pools[0].rules", "Field 'rules' if provided must be a non-empty array of rule blocks"],
	["empty", [], {}, "pools[0].rules", "Field 'rules' if provided must be a non-empty array of rule blocks"],
	["unknown block", [{ rule: "cost-cap" }, { rule: "pick", mode: "first" }], {}, "pools[0].rules[0].rule", "Unknown rule 'cost-cap'; expected 'sticky', 'prefer-for-role', 'prefer-for-context' or 'pick'"],
	["unknown field", [{ rule: "sticky", when: "always" }, { rule: "pick", mode: "first" }], {}, "pools[0].rules[0]", "Unknown field 'when' in rule 'sticky'"],
	["no pick", [{ rule: "sticky" }], {}, "pools[0].rules", "Rules must end with exactly one 'pick' block"],
	["pick not last", [{ rule: "pick", mode: "first" }, { rule: "sticky" }], {}, "pools[0].rules", "Rules must end with exactly one 'pick' block"],
	["two sticky", [{ rule: "sticky" }, { rule: "sticky" }, { rule: "pick", mode: "first" }], {}, "pools[0].rules[1]", "Rule 'sticky' may appear only once"],
	["bad pick mode", [{ rule: "pick", mode: "cheapest" }], {}, "pools[0].rules[0].mode", "Field 'mode' must be 'first', 'highest-quota' or 'lowest-cost'"],
	["empty role", [{ rule: "prefer-for-role", role: "", candidate: SONNET[2] }, { rule: "pick", mode: "first" }], {}, "pools[0].rules[0].role", "Field 'role' must be a non-empty agent name"],
	["foreign candidate", [{ rule: "prefer-for-role", role: "gentle-ai-worker", candidate: "openai/gpt-6" }, { rule: "pick", mode: "first" }], {}, "pools[0].rules[0].candidate", "Candidate 'openai/gpt-6' is not in this pool"],
	["strategy disagrees", [{ rule: "pick", mode: "first" }], { strategy: "hybrid" }, "pools[0].strategy", "Strategy 'hybrid' disagrees with the pick mode 'first' of the rules"],
];

for (const [name, rules, extra, path, message] of INVALID) {
	test(`validatePoolsConfig rejects rules: ${name}, and parsePools keeps the pool on its default list`, () => {
		const config = pools(rules, extra);
		const result = validatePoolsConfig(config);
		assert.equal(result.valid, false);
		assert.deepEqual(result.issues, [{ path, message }]);
		const [pool] = parsePools(config);
		assert.equal(pool.id, "claude-sonnet-5-5", "a bad rule list never drops the pool");
		assert.equal("rules" in pool, false);
	});
}

test("waterfall agrees with pick first and highest-quota with pick highest-quota", () => {
	assert.equal(validatePoolsConfig(pools([{ rule: "pick", mode: "first" }], { strategy: "waterfall" })).valid, true);
	assert.equal(validatePoolsConfig(pools([{ rule: "pick", mode: "highest-quota" }], { strategy: "highest-quota" })).valid, true);
});

test("runSetupWizard keeps the rules of an existing pool, aligns the pick to the new strategy and drops rules for removed candidates", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-rules-"));
	try {
		const rules = [
			{ rule: "prefer-for-role", role: "gentle-ai-worker", candidate: "claude-bridge/claude-opus-5-5" },
			{ rule: "prefer-for-role", role: "gentle-ai-verify", candidate: "antigravity/gemini-4-argon" },
			{ rule: "sticky" },
			{ rule: "pick", mode: "highest-quota" },
		];
		writeFileSync(join(dir, "pools.json"), JSON.stringify({ pools: [{ id: "claude-opus-5-5", name: "Opus", candidates: ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5", "antigravity/gemini-4-argon"], strategy: "hybrid", rules }] }), "utf8");
		writeFileSync(join(dir, "integrations.json"), JSON.stringify({ integrations: [] }), "utf8");
		const confirms: string[] = [];
		const ui = {
			confirm: async (_title: string, message: string) => { confirms.push(message); return true; },
			select: async (title: string, options: string[]) => (title === "Select Routing Strategy" ? options.find(option => option.startsWith("waterfall")) : options[0]),
			notify: () => {},
		};
		const known = new Set(["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"]);
		const completed = await runSetupWizard({ ui }, dir, {
			detectOptions: { settings: { packages: ["npm:pi-claude-bridge", "npm:@estebanforge/pi-antigravity-bridge"] }, execWhich: () => false, homeDir: dir, env: {} },
			hasModel: (provider, model) => known.has(`${provider}/${model}`),
		});
		assert.equal(completed, true);
		const [pool] = JSON.parse(readFileSync(join(dir, "pools.json"), "utf8")).pools;
		assert.equal(pool.strategy, "waterfall");
		assert.deepEqual(pool.rules, [
			{ rule: "prefer-for-role", role: "gentle-ai-worker", candidate: "claude-bridge/claude-opus-5-5" },
			{ rule: "sticky" },
			{ rule: "pick", mode: "first" },
		]);
		assert.match(confirms.at(-1) ?? "", /~ Pool 'claude-opus-5-5' drops rule prefer-for-role gentle-ai-verify → antigravity\/gemini-4-argon \(candidate removed\)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ignoredRuleWarnings names each pool whose rules are ignored and why", () => {
	const config = { pools: [
		{ id: "claude-sonnet-5-5", candidates: SONNET, rules: WORKER_TO_FLASH },
		{ id: "orchestrator", candidates: SONNET, rules: [{ rule: "sticky" }] },
		{ id: "plain", candidates: SONNET },
	] };
	assert.deepEqual(ignoredRuleWarnings(config), [
		"pool 'orchestrator' ignores its rules and routes on the default list: pools[1].rules: Rules must end with exactly one 'pick' block",
	]);
	assert.deepEqual(ignoredRuleWarnings({ pools: [{ id: "plain", candidates: SONNET }] }), []);
});
