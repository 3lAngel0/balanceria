import test from "node:test";
import assert from "node:assert/strict";
import { validatePoolsConfig } from "../../../src/config-schema.ts";
import {
	addPreferForRole,
	addSticky,
	applyPoolRules,
	effectiveRules,
	knownRoles,
	moveRule,
	removeRule,
	setPickMode,
	type PoolsConfig,
	type RuleBlock,
} from "../ui/rules.ts";

test("effectiveRules derives default rules from strategy when a pool has no rules, and keeps explicit rules", () => {
	assert.deepEqual(effectiveRules({ strategy: "hybrid" }), [
		{ rule: "sticky" },
		{ rule: "pick", mode: "highest-quota" },
	]);
	assert.deepEqual(effectiveRules({ strategy: "waterfall" }), [
		{ rule: "sticky" },
		{ rule: "pick", mode: "first" },
	]);
	const custom: RuleBlock[] = [
		{ rule: "prefer-for-role", role: "gentle-ai-worker", candidate: "agy/flash" },
		{ rule: "pick", mode: "highest-quota" },
	];
	assert.deepEqual(effectiveRules({ strategy: "hybrid", rules: custom }), custom);
});

test("moveRule reorders sticky and prefer-for-role blocks while keeping pick last", () => {
	const rules: RuleBlock[] = [
		{ rule: "sticky" },
		{ rule: "prefer-for-role", role: "worker", candidate: "agy/flash" },
		{ rule: "prefer-for-role", role: "verify", candidate: "claude/opus" },
		{ rule: "pick", mode: "highest-quota" },
	];
	const movedDown = moveRule(rules, 0, 1);
	assert.deepEqual(movedDown.map(r => r.rule), ["prefer-for-role", "sticky", "prefer-for-role", "pick"]);
	const movedToLastMovable = moveRule(rules, 0, 2);
	assert.deepEqual(movedToLastMovable.map(r => (r.rule === "prefer-for-role" ? r.role : r.rule)), ["worker", "verify", "sticky", "pick"]);
	// pick stays last: moving pick or moving past pick is a no-op.
	assert.equal(moveRule(rules, 3, 0), rules);
	assert.equal(moveRule(rules, 0, 3), rules);
	assert.equal(moveRule(rules, 0, -1), rules);
	assert.equal(moveRule(rules, 1, 1), rules);
});

test("addPreferForRole inserts before pick and refuses invalid role names or empty candidates", () => {
	const base: RuleBlock[] = [{ rule: "sticky" }, { rule: "pick", mode: "highest-quota" }];
	const next = addPreferForRole(base, " gentle-ai-worker ", "agy/flash");
	assert.deepEqual(next, [
		{ rule: "sticky" },
		{ rule: "prefer-for-role", role: "gentle-ai-worker", candidate: "agy/flash" },
		{ rule: "pick", mode: "highest-quota" },
	]);
	assert.equal(addPreferForRole(base, "", "agy/flash"), base);
	assert.equal(addPreferForRole(base, "bad role!", "agy/flash"), base);
	assert.equal(addPreferForRole(base, "worker", ""), base);
});

test("removeRule removes sticky or prefer-for-role and never removes pick; addSticky restores sticky once", () => {
	const rules: RuleBlock[] = [
		{ rule: "sticky" },
		{ rule: "prefer-for-role", role: "worker", candidate: "agy/flash" },
		{ rule: "pick", mode: "highest-quota" },
	];
	const withoutSticky = removeRule(rules, 0);
	assert.deepEqual(withoutSticky, [
		{ rule: "prefer-for-role", role: "worker", candidate: "agy/flash" },
		{ rule: "pick", mode: "highest-quota" },
	]);
	assert.equal(removeRule(withoutSticky, 1), withoutSticky);
	assert.equal(addSticky(rules), rules);
	assert.deepEqual(addSticky(withoutSticky), rules);
});

test("setPickMode updates the trailing pick mode and applyPoolRules touches only the edited pool while keeping strategy valid", () => {
	const config: PoolsConfig = {
		pools: [
			{ id: "opus", name: "Opus", candidates: ["agy/opus", "claude/opus"], strategy: "hybrid" },
			{ id: "sonnet", name: "Sonnet", candidates: ["agy/sonnet", "agy/flash"], strategy: "hybrid" },
		],
	};
	const rules = setPickMode(effectiveRules(config.pools[1]!), "first");
	const updated = applyPoolRules(config, "sonnet", rules);
	// Unedited pool keeps no `rules` field.
	assert.equal("rules" in updated.pools[0]!, false);
	assert.deepEqual(updated.pools[1]!.rules, [
		{ rule: "sticky" },
		{ rule: "pick", mode: "first" },
	]);
	assert.equal(updated.pools[1]!.strategy, "waterfall");
	assert.equal(validatePoolsConfig(updated).valid, true);

	const backToQuota = applyPoolRules(updated, "sonnet", setPickMode(rules, "highest-quota"));
	assert.equal(backToQuota.pools[1]!.strategy, "hybrid");
	assert.equal(validatePoolsConfig(backToQuota).valid, true);
});

test("knownRoles deduplicates and sorts roles from decisions, skipping unknown", () => {
	assert.deepEqual(
		knownRoles([
			{ role: "gentle-ai-worker" },
			{ role: "unknown" },
			{ role: "gentle-ai-explore" },
			{ role: "gentle-ai-worker" },
		]),
		["gentle-ai-explore", "gentle-ai-worker"],
	);
});
