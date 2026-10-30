import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveBalancerArgs } from "../src/balancer-menu.ts";
import type { HistoryEntry } from "../src/history.ts";
import {
	activeRoutes,
	createDraft,
	diffLab,
	discardDraft,
	formatLabDiff,
	formatRoleMoves,
	profilePoolOf,
	readDraft,
	roleMoves,
} from "../src/lab.ts";
import { parsePools } from "../src/pools.ts";
import { simulate } from "../src/simulator.ts";

const POOLS = {
	pools: [
		{ id: "sonnet", name: "Sonnet", candidates: ["agy/sonnet", "bridge/sonnet", "agy/flash"], strategy: "hybrid" },
		{ id: "opus", name: "Opus", candidates: ["agy/opus", "bridge/opus"] },
	],
};

const PROFILES = {
	kind: "gentle-pi.agent_model_profiles",
	version: 1,
	profiles: {
		main: {
			orchestrator: { model: "pool/opus", thinking: "medium" },
			"gentle-ai-worker": { model: "pool/sonnet", thinking: "medium" },
			"gentle-ai-verify": { model: "pool/opus", thinking: "high" },
		},
		other: { "gentle-ai-worker": { model: "bridge/sonnet" } },
	},
	active: "main",
};

function text(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function setup(profiles: string | null = text(PROFILES)) {
	const dir = mkdtempSync(join(tmpdir(), "lab-test-"));
	const paths = { labDir: join(dir, "data", "lab"), poolsPath: join(dir, "pools.json"), profilesPath: join(dir, "profiles.json") };
	writeFileSync(paths.poolsPath, text(POOLS));
	if (profiles !== null) writeFileSync(paths.profilesPath, profiles);
	return { dir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function entry(partial: Partial<HistoryEntry>): HistoryEntry {
	return {
		ts: 0,
		session: "s1",
		provider: "agy",
		model: "sonnet",
		input: 100,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		contextTokens: 1000,
		...partial,
	} as HistoryEntry;
}

test("createDraft copies the live files with mode 0600 and records their texts as the base", () => {
	const { paths, cleanup } = setup();
	try {
		const base = createDraft(paths, 1_000);
		assert.deepEqual(base, { createdAt: 1_000, pools: text(POOLS), profiles: text(PROFILES) });
		for (const name of ["pools.json", "profiles.json", "base.json"]) {
			assert.equal(statSync(join(paths.labDir, name)).mode & 0o777, 0o600, name);
		}
		assert.equal(readFileSync(join(paths.labDir, "pools.json"), "utf8"), text(POOLS));
		assert.equal(readFileSync(join(paths.labDir, "profiles.json"), "utf8"), text(PROFILES));
		assert.deepEqual(readDraft(paths.labDir), { base, pools: text(POOLS), profiles: text(PROFILES) });
	} finally {
		cleanup();
	}
});

test("createDraft refuses to replace an existing draft unless asked, keeping the edited draft", () => {
	const { paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		writeFileSync(join(paths.labDir, "pools.json"), "edited");
		assert.throws(() => createDraft(paths, 2_000), /a lab draft already exists/);
		assert.equal(readFileSync(join(paths.labDir, "pools.json"), "utf8"), "edited");
		const base = createDraft(paths, 2_000, { replace: true });
		assert.equal(base.createdAt, 2_000);
		assert.equal(readFileSync(join(paths.labDir, "pools.json"), "utf8"), text(POOLS));
	} finally {
		cleanup();
	}
});

test("createDraft holds pools only when profiles.json is missing or unusable, and needs pools.json", () => {
	for (const profiles of [null, "not json", text({ ...PROFILES, kind: "other" })]) {
		const { paths, cleanup } = setup(profiles);
		try {
			const base = createDraft(paths, 1_000);
			assert.equal(base.profiles, null);
			assert.equal(existsSync(join(paths.labDir, "profiles.json")), false);
			assert.equal(readDraft(paths.labDir).profiles, null);
		} finally {
			cleanup();
		}
	}
	const { paths, cleanup } = setup();
	try {
		rmSync(paths.poolsPath);
		assert.throws(() => createDraft(paths, 1_000), /pools\.json/);
		assert.equal(existsSync(join(paths.labDir, "base.json")), false);
	} finally {
		cleanup();
	}
});

test("readDraft reports a missing draft; discardDraft removes it", () => {
	const { paths, cleanup } = setup();
	try {
		assert.match((readDraft(paths.labDir) as { error: string }).error, /no lab draft/);
		createDraft(paths, 1_000);
		discardDraft(paths.labDir);
		for (const name of ["pools.json", "profiles.json", "base.json"]) assert.equal(existsSync(join(paths.labDir, name)), false);
		assert.match((readDraft(paths.labDir) as { error: string }).error, /no lab draft/);
	} finally {
		cleanup();
	}
});

test("diffLab finds no change in an untouched draft", () => {
	const diff = diffLab({ pools: text(POOLS), profiles: text(PROFILES) }, { pools: text(POOLS), profiles: text(PROFILES) });
	assert.deepEqual(diff, { changes: [], issues: [], notes: [] });
	assert.equal(formatLabDiff(diff), "No changes: the draft equals the live files.");
});

test("diffLab lists every pool change structurally", () => {
	const draft = {
		pools: [
			{
				id: "sonnet",
				name: "Sonnet 2",
				candidates: ["bridge/sonnet", "agy/sonnet", "agy/flash"],
				strategy: "waterfall",
				rules: [{ rule: "prefer-for-role", role: "gentle-ai-worker", candidate: "agy/flash" }, { rule: "pick", mode: "first" }],
			},
			{ id: "flash", candidates: ["agy/flash"] },
		],
	};
	const diff = diffLab({ pools: text(POOLS), profiles: null }, { pools: text(draft), profiles: null });
	assert.deepEqual(diff.issues, []);
	assert.deepEqual(diff.changes, [
		"pool flash: added (agy/flash)",
		"pool opus: removed (agy/opus, bridge/opus)",
		"pool sonnet: name Sonnet → Sonnet 2",
		"pool sonnet: strategy hybrid → waterfall",
		"pool sonnet: candidates reordered agy/sonnet, bridge/sonnet, agy/flash → bridge/sonnet, agy/sonnet, agy/flash",
		'pool sonnet: rules (default) → [{"rule":"prefer-for-role","role":"gentle-ai-worker","candidate":"agy/flash"},{"rule":"pick","mode":"first"}]',
	]);
	const swapped = { pools: [{ ...POOLS.pools[0], candidates: ["agy/sonnet", "agy/haiku"] }, POOLS.pools[1]] };
	assert.deepEqual(diffLab({ pools: text(POOLS), profiles: null }, { pools: text(swapped), profiles: null }).changes, [
		"pool sonnet: candidates + agy/haiku; − bridge/sonnet, agy/flash",
	]);
});

test("diffLab lists every profile change, and notes the orchestrator entry", () => {
	const draft = structuredClone(PROFILES) as typeof PROFILES & { profiles: Record<string, Record<string, { model: string; thinking?: string }>> };
	draft.active = "other";
	draft.profiles.main["gentle-ai-worker"] = { model: "agy/flash", thinking: "medium" };
	draft.profiles.main["gentle-ai-verify"] = { model: "pool/opus", thinking: "medium" };
	draft.profiles.main.orchestrator = { model: "pool/sonnet", thinking: "medium" };
	draft.profiles.main["review-risk"] = { model: "pool/opus" };
	delete (draft.profiles as Record<string, unknown>).other;
	draft.profiles.fresh = { "gentle-ai-worker": { model: "agy/flash" } };
	draft.active = "fresh";
	const diff = diffLab({ pools: text(POOLS), profiles: text(PROFILES) }, { pools: text(POOLS), profiles: text(draft) });
	assert.deepEqual(diff.issues, []);
	assert.deepEqual(diff.changes, [
		"profiles: active main → fresh",
		"profile fresh: added (1 role)",
		"profile other: removed (1 role)",
		"profile main: gentle-ai-verify thinking high → medium",
		"profile main: gentle-ai-worker pool/sonnet → agy/flash",
		"profile main: orchestrator pool/opus → pool/sonnet",
		"profile main: review-risk added pool/opus",
	]);
	assert.deepEqual(diff.notes, [
		"profile main: the orchestrator entry reaches Pi's settings.json only when the profile is used in this session from /gentle:profiles (Use in this session); the lab does not simulate it",
	]);
	const removed = structuredClone(PROFILES) as { profiles: { main: Record<string, unknown> } };
	delete removed.profiles.main["gentle-ai-verify"];
	assert.deepEqual(diffLab({ pools: text(POOLS), profiles: text(PROFILES) }, { pools: text(POOLS), profiles: text(removed) }).changes, [
		"profile main: gentle-ai-verify removed (was pool/opus)",
	]);
});

test("diffLab reports draft issues instead of changes it cannot trust", () => {
	const badPools = diffLab({ pools: text(POOLS), profiles: null }, { pools: text({ pools: [{ id: "Bad", candidates: [] }] }), profiles: null });
	assert.deepEqual(badPools.issues, [
		"pools.json pools[0].id: Field 'id' must be a lowercase alphanumeric string matching /^[a-z0-9][a-z0-9.-]*$/",
		"pools.json pools[0].candidates: Field 'candidates' must be a non-empty array of candidate references",
	]);
	const notJson = diffLab({ pools: text(POOLS), profiles: null }, { pools: "{", profiles: null });
	assert.equal(notJson.issues.length, 1);
	assert.match(notJson.issues[0], /^pools\.json: not readable JSON/);
	const badKind = diffLab({ pools: text(POOLS), profiles: text(PROFILES) }, { pools: text(POOLS), profiles: text({ ...PROFILES, version: 2 }) });
	assert.deepEqual(badKind.changes, []);
	assert.match(badKind.issues[0], /^profiles\.json: .*only handles gentle-pi\.agent_model_profiles version 1/);
	const missing = diffLab({ pools: text(POOLS), profiles: text(PROFILES) }, { pools: text(POOLS), profiles: null });
	assert.deepEqual(missing.issues, ["profiles.json: the draft file is missing; run /balancer lab new to start again"]);
	assert.match(formatLabDiff(badPools), /^Draft issues \(fix them before applying\):\n- pools\.json pools\[0\]\.id/);
});

test("activeRoutes maps the active profile's roles to their models", () => {
	assert.deepEqual(activeRoutes(PROFILES), { orchestrator: "pool/opus", "gentle-ai-worker": "pool/sonnet", "gentle-ai-verify": "pool/opus" });
	assert.deepEqual(activeRoutes({ ...PROFILES, active: "gone" }), {});
	assert.deepEqual(activeRoutes(null), {});
});

test("profilePoolOf follows the draft route only for roles the draft moves, never the orchestrator", () => {
	const current = { orchestrator: "pool/opus", worker: "pool/sonnet", verify: "pool/opus", explore: "agy/flash" };
	const draft = { orchestrator: "pool/sonnet", worker: "agy/flash", verify: "pool/sonnet", explore: "pool/sonnet" };
	const lookup = profilePoolOf(() => "recorded", (request: HistoryEntry) => request.session, current, draft);
	assert.equal(lookup(entry({ session: "orchestrator" })), "recorded");
	assert.equal(lookup(entry({ session: "worker" })), null);
	assert.equal(lookup(entry({ session: "verify" })), "sonnet");
	assert.equal(lookup(entry({ session: "explore" })), "sonnet");
	assert.equal(lookup(entry({ session: "unknown-role" })), "recorded");
	const unchanged = profilePoolOf(() => "recorded", () => "worker", current, { ...current });
	assert.equal(unchanged(entry({})), "recorded");
	const dropped = profilePoolOf(() => "recorded", () => "worker", current, {});
	assert.equal(dropped(entry({})), "recorded");
});

test("roleMoves totals the requests and tokens of every moved role", () => {
	const requests = [
		entry({ session: "worker", input: 100, output: 10, cacheRead: 5, cacheWrite: 1 }),
		entry({ session: "worker", input: 200, output: 0, cacheRead: 0, cacheWrite: 0 }),
		entry({ session: "verify" }),
		entry({ session: "orchestrator" }),
	];
	const moves = roleMoves(requests, request => request.session, { orchestrator: "pool/opus", worker: "pool/sonnet", verify: "pool/opus" }, { orchestrator: "pool/sonnet", worker: "agy/flash", verify: "pool/opus", review: "pool/opus" });
	assert.deepEqual(moves, [
		{ role: "review", from: "(none)", to: "pool/opus", requests: 0, tokens: 0 },
		{ role: "worker", from: "pool/sonnet", to: "agy/flash", requests: 2, tokens: 316 },
	]);
	assert.equal(
		formatRoleMoves(moves),
		[
			"Roles moved by the draft's active profile (last 30 days):",
			"  review: (none) → pool/opus · 0 requests, 0 tokens",
			"  worker: pool/sonnet → agy/flash · 2 requests, 316 tokens",
		].join("\n"),
	);
	assert.equal(formatRoleMoves([]), "Roles moved by the draft's active profile: none");
});

test("simulate compares a role moved to another pool with the baseline lookup", () => {
	const pools = parsePools(POOLS);
	const requests = [entry({ ts: 1, session: "w", provider: "agy", model: "sonnet" }), entry({ ts: 2, session: "o", provider: "agy", model: "opus" })];
	const poolOf = (request: HistoryEntry) => (request.session === "w" ? "sonnet" : "opus");
	const report = simulate({
		pools,
		baseline: pools,
		history: { requests },
		poolOf: () => "opus",
		baselinePoolOf: poolOf,
		roleOf: () => "worker",
	});
	assert.equal(report.pools.opus.requests, 2);
	assert.equal(report.pools.opus.changed, 1);
	assert.equal(report.pools.sonnet.requests, 0);
	// Without baselinePoolOf the baseline uses the draft lookup, as before.
	const same = simulate({ pools, baseline: pools, history: { requests }, poolOf: () => "opus", roleOf: () => "worker" });
	assert.equal(same.pools.opus.changed, 0);
});

test("resolveBalancerArgs accepts the lab subcommands only", () => {
	for (const command of ["lab", "lab new", "lab diff", "lab simulate", "lab apply", "lab undo", "lab discard"]) {
		assert.deepEqual(resolveBalancerArgs(command), { kind: "command", command });
	}
	for (const command of ["lab foo", "lab new extra", "labs"]) assert.equal(resolveBalancerArgs(command).kind, "unknown");
	assert.match((resolveBalancerArgs("nope") as { message: string }).message, /lab \[new \| diff \| simulate \| apply \| undo \| discard\]/);
});

test("the web server, data and page never import the lab", () => {
	for (const file of ["web-server.ts", "web-data.ts", "web-page.ts"]) {
		const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
		assert.doesNotMatch(source, /lab\.ts/, file);
	}
});
