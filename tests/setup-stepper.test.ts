import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "../src/i18n/index.ts";
import type { DetectedProvider, PoolConfig } from "../src/setup.ts";
import {
	SETUP_STEPS,
	applyStepper,
	buildStepperDiff,
	discard,
	goBack,
	goNext,
	goTo,
	initStepper,
	moveCandidate,
	setPoolStrategy,
	setRole,
	stepDescription,
	toggleCandidate,
	toggleProvider,
	validateStep,
	type StepperDeps,
} from "../src/setup-stepper.ts";

const provider = (id: string, kind: DetectedProvider["kind"] = "subscription"): DetectedProvider => ({
	id,
	label: id,
	kind,
	detected: true,
	source: "test",
	availableModels: [],
});
const detected = [provider("claude-bridge"), provider("antigravity")];
const pools = (): PoolConfig[] => [
	{ id: "sonnet", name: "Sonnet", candidates: ["claude-bridge/s", "antigravity/s"], strategy: "hybrid" },
	{ id: "orch", name: "Orch", candidates: ["antigravity/o"], strategy: "hybrid" },
];
const fresh = () => initStepper(detected, pools(), { orchestrator: { model: "pool/orch", thinking: "high" } });

test("initStepper starts on providers, clean, with everything detected enabled", () => {
	const s = fresh();
	assert.deepEqual([...SETUP_STEPS], ["providers", "strategy", "roles", "confirm"]);
	assert.equal(s.step, "providers");
	assert.equal(s.dirty, false);
	assert.deepEqual(s.enabled, ["claude-bridge", "antigravity"]);
	assert.deepEqual(s.messages, {});
});

test("goNext and goBack walk the steps and stop at the ends", () => {
	let s = fresh();
	assert.equal(goBack(s).step, "providers");
	s = goNext(s);
	assert.equal(s.step, "strategy");
	s = goNext(goNext(s));
	assert.equal(s.step, "confirm");
	assert.equal(goNext(s).step, "confirm");
	assert.equal(goBack(s).step, "roles");
});

test("goNext refuses with messages when the current step is invalid", () => {
	let s = toggleProvider(toggleProvider(fresh(), "claude-bridge"), "antigravity");
	assert.deepEqual(validateStep(s, "providers"), [t("setup.stepper.err.noProvider")]);
	const next = goNext(s);
	assert.equal(next.step, "providers");
	assert.deepEqual(next.messages.providers, [t("setup.stepper.err.noProvider")]);
	assert.notEqual(next.messages.providers?.[0], "setup.stepper.err.noProvider");
	s = goNext(toggleProvider(next, "antigravity"));
	assert.equal(s.step, "strategy");
	assert.equal(s.messages.providers, undefined);
});

test("confirm requires the previous steps valid; strategy needs candidates in every pool", () => {
	const s = fresh();
	assert.deepEqual(validateStep(s, "roles"), []);
	assert.deepEqual(validateStep(s, "confirm"), []);
	const broken = { ...s, pools: [{ ...s.pools[0]!, candidates: [] }] };
	assert.equal(validateStep(broken, "strategy").length, 1);
	assert.match(validateStep(broken, "strategy")[0]!, /sonnet/);
	assert.ok(validateStep(broken, "confirm").length >= 1);
});

test("goTo only reaches steps already visited", () => {
	let s = fresh();
	assert.equal(goTo(s, "confirm"), s);
	s = goNext(goNext(s));
	assert.equal(goTo(s, "providers").step, "providers");
	assert.equal(goTo(goTo(s, "providers"), "roles").step, "roles");
	assert.equal(goTo(goTo(s, "providers"), "confirm").step, "providers");
});

test("edits go through the existing helpers and mark the draft dirty", () => {
	let s = fresh();
	s = toggleCandidate(s, "sonnet", "claude-bridge/s");
	assert.deepEqual(s.pools[0]!.candidates, ["antigravity/s"]);
	assert.equal(s.dirty, true);
	assert.equal(toggleCandidate(s, "sonnet", "antigravity/s").pools[0]!.candidates.length, 1);
	s = toggleCandidate(s, "sonnet", "claude-bridge/s");
	s = moveCandidate(s, "sonnet", 1, -1);
	assert.deepEqual(s.pools[0]!.candidates, ["claude-bridge/s", "antigravity/s"]);
	s = setPoolStrategy(s, "orch", "waterfall");
	assert.equal(s.pools[1]!.strategy, "waterfall");
	s = setRole(s, "gentle-ai-worker", "pool/sonnet", "low");
	assert.deepEqual(s.roles["gentle-ai-worker"], { model: "pool/sonnet", thinking: "low" });
	s = setRole(s, "gentle-ai-worker", "pool/orch");
	assert.deepEqual(s.roles["gentle-ai-worker"], { model: "pool/orch", thinking: "low" });
	assert.equal(fresh().pools[0]!.candidates.length, 2);
});

test("discard returns the initial state and writes nothing", () => {
	let calls = 0;
	const deps = { writeConfig: () => (calls++, undefined) } as unknown as StepperDeps;
	void deps;
	const s0 = fresh();
	let s = setRole(setPoolStrategy(toggleProvider(goNext(s0), "antigravity"), "orch", "waterfall"), "x", "pool/a");
	s = discard(s);
	assert.deepEqual(s, s0);
	assert.equal(calls, 0);
});

test("stepDescription gives a translated key per step using glossary words", () => {
	for (const step of SETUP_STEPS) {
		const key = stepDescription(step);
		assert.notEqual(t(key), key);
	}
	assert.match(t(stepDescription("strategy")), /pool/);
	assert.match(t(stepDescription("roles")), /role/);
});

const current = {
	pools: { pools: [{ id: "sonnet", name: "Sonnet", candidates: ["claude-bridge/s", "antigravity/s"], strategy: "hybrid" }, { id: "orch", name: "Orch", candidates: ["antigravity/o"] }] },
	integrations: { integrations: [] as unknown[] },
	profiles: { active: "balanceador_dev", profiles: { balanceador_dev: { orchestrator: { model: "pool/orch", thinking: "high" } } } },
};

test("buildStepperDiff reports a changed pool and a changed role", () => {
	const clean = buildStepperDiff(fresh(), current);
	assert.equal(clean.writes.pools, false);
	assert.equal(clean.writes.profiles, false);
	let s = toggleCandidate(fresh(), "sonnet", "antigravity/s");
	s = setRole(s, "orchestrator", "pool/sonnet", "high");
	const diff = buildStepperDiff(s, current);
	assert.equal(diff.writes.pools, true);
	assert.equal(diff.writes.profiles, true);
	const text = diff.lines.join("\n");
	assert.match(text, /Update pool 'sonnet'/);
	assert.match(text, /balanceador_dev/);
	assert.match(text, /orchestrator: pool\/orch \(high\) → pool\/sonnet \(high\)/);
});

function fakeDeps(opts: { failConfig?: boolean; failProfiles?: boolean; backup?: boolean } = {}) {
	const log: string[] = [];
	const deps: StepperDeps = {
		root: "/r",
		current,
		writeConfig: (root, configs) => {
			log.push(`config:${root}:${(configs.pools as { pools?: unknown[] } | unknown[]).constructor === Array ? "array" : "obj"}`);
			if (opts.failConfig) throw new Error("validation failed");
			return { success: true, integrationsPath: "/r/integrations.json", poolsPath: "/r/pools.json", backupCreated: opts.backup ?? false };
		},
		writeProfiles: (name, roles) => {
			log.push(`profiles:${name}:${Object.keys(roles).join(",")}`);
			if (opts.failProfiles) throw new Error("disk full");
		},
		profilesPath: "/p/profiles.json",
	};
	return { deps, log };
}

test("applyStepper writes pools and integrations, plus profiles only when roles changed", () => {
	const a = fakeDeps({ backup: true });
	const res = applyStepper(fresh(), a.deps);
	assert.equal(res.ok, true);
	assert.deepEqual(res.written, ["/r/pools.json", "/r/integrations.json"]);
	assert.deepEqual(res.backups, ["/r/pools.json.bak", "/r/integrations.json.bak"]);
	assert.equal(a.log.length, 1);

	const b = fakeDeps();
	const changed = applyStepper(setRole(fresh(), "gentle-ai-worker", "pool/sonnet"), b.deps);
	assert.deepEqual(changed.written, ["/r/pools.json", "/r/integrations.json", "/p/profiles.json"]);
	assert.deepEqual(changed.backups, []);
	assert.equal(b.log[1], "profiles:balanceador_dev:orchestrator,gentle-ai-worker");
});

test("applyStepper reports config errors without touching profiles, and profile errors without losing the config write", () => {
	const a = fakeDeps({ failConfig: true });
	const failed = applyStepper(setRole(fresh(), "w", "pool/a"), a.deps);
	assert.equal(failed.ok, false);
	assert.equal(failed.error, "validation failed");
	assert.deepEqual(failed.written, []);
	assert.equal(a.log.length, 1);

	const b = fakeDeps({ failProfiles: true });
	const partial = applyStepper(setRole(fresh(), "w", "pool/a"), b.deps);
	assert.equal(partial.ok, true);
	assert.equal(partial.profilesError, "disk full");
	assert.deepEqual(partial.written, ["/r/pools.json", "/r/integrations.json"]);
});

test("applyStepper refuses an invalid draft without writing", () => {
	const a = fakeDeps();
	const s = toggleProvider(toggleProvider(fresh(), "claude-bridge"), "antigravity");
	const res = applyStepper(s, a.deps);
	assert.equal(res.ok, false);
	assert.equal(a.log.length, 0);
});
