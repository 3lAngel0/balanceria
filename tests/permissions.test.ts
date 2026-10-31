import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUDIT_FILE,
	PERMISSIONS_FILE,
	addGrant,
	formatGrants,
	loadPermissions,
	permissionFor,
	pruneExpired,
	revokeGrants,
	runPermissionGrant,
	suggestModelGroups,
	type Grant,
	type PermissionUI,
} from "../src/permissions.ts";
import type { Pool } from "../src/pools.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const dataDir = () => mkdtempSync(join(tmpdir(), "permissions-"));

const draft = (over: Partial<Grant> = {}): Omit<Grant, "id" | "grantedAt"> => ({
	level: "auto",
	profiles: ["work"],
	roles: ["gentle-ai-worker"],
	models: ["pool/claude-sonnet-5-5", "antigravity/gemini-3-8-flash"],
	expiresAt: NOW + HOUR,
	...over,
});

const grant = (over: Partial<Grant> = {}): Grant => ({ id: "g1", grantedAt: NOW - HOUR, ...draft(), ...over });

const request = { profile: "work", role: "gentle-ai-worker", from: "pool/claude-sonnet-5-5", to: "antigravity/gemini-3-8-flash" };

const audit = (dir: string) =>
	existsSync(join(dir, AUDIT_FILE))
		? readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line))
		: [];

// permissionFor

test("permissionFor is off without grants", () => {
	assert.deepEqual(permissionFor([], request, NOW), { level: "off" });
});

test("permissionFor returns the level of a grant that covers profile, role and both models", () => {
	const g = grant();
	assert.deepEqual(permissionFor([g], request, NOW), { level: "auto", grant: g });
});

test("permissionFor is off when the profile, role, source or target model is outside the grant", () => {
	const g = grant();
	assert.equal(permissionFor([g], { ...request, profile: "other" }, NOW).level, "off");
	assert.equal(permissionFor([g], { ...request, role: "orchestrator" }, NOW).level, "off");
	assert.equal(permissionFor([g], { ...request, from: "pool/claude-opus-5-5" }, NOW).level, "off");
	assert.equal(permissionFor([g], { ...request, to: "pool/claude-opus-5-5" }, NOW).level, "off");
});

test("permissionFor is off when source and target are the same model", () => {
	assert.equal(permissionFor([grant()], { ...request, to: request.from }, NOW).level, "off");
});

test("permissionFor ignores a grant at or past its expiry", () => {
	assert.equal(permissionFor([grant({ expiresAt: NOW })], request, NOW).level, "off");
	assert.equal(permissionFor([grant({ expiresAt: NOW - 1 })], request, NOW).level, "off");
	assert.equal(permissionFor([grant({ expiresAt: NOW + 1 })], request, NOW).level, "auto");
});

test("permissionFor takes the highest level among matching grants", () => {
	const suggest = grant({ id: "s", level: "suggest" });
	const auto = grant({ id: "a", level: "auto" });
	assert.equal(permissionFor([suggest, auto], request, NOW).grant?.id, "a");
	assert.equal(permissionFor([auto, suggest], request, NOW).grant?.id, "a");
	assert.deepEqual(permissionFor([suggest], request, NOW), { level: "suggest", grant: suggest });
});

// store

test("loadPermissions: a missing file means no grants and no error", () => {
	assert.deepEqual(loadPermissions(dataDir()), { grants: [] });
});

test("loadPermissions: an unreadable or unknown file means no grants with an error", () => {
	for (const content of ["{not json", JSON.stringify({ version: 2, grants: [] }), JSON.stringify({ version: 1, grants: {} }), "[]"]) {
		const dir = dataDir();
		writeFileSync(join(dir, PERMISSIONS_FILE), content);
		const loaded = loadPermissions(dir);
		assert.deepEqual(loaded.grants, [], content);
		assert.match(loaded.error ?? "", /permissions\.json/, content);
	}
});

test("loadPermissions drops each malformed grant and keeps the valid ones", () => {
	const dir = dataDir();
	const valid = grant({ id: "ok" });
	const bad = [
		{ ...valid, id: "" },
		{ ...valid, id: "level", level: "root" },
		{ ...valid, id: "off", level: "off" },
		{ ...valid, id: "empty-roles", roles: [] },
		{ ...valid, id: "wild", roles: ["*"] },
		{ ...valid, id: "number-model", models: ["a", 3] },
		{ ...valid, id: "no-expiry", expiresAt: undefined },
		{ ...valid, id: "reversed", expiresAt: valid.grantedAt },
		null,
	];
	writeFileSync(join(dir, PERMISSIONS_FILE), JSON.stringify({ version: 1, grants: [valid, ...bad] }));
	assert.deepEqual(loadPermissions(dir), { grants: [valid] });
});

test("addGrant writes the store with mode 0600 and an audit row", () => {
	const dir = dataDir();
	const saved = addGrant(dir, draft(), NOW);
	assert.equal(saved.grantedAt, NOW);
	assert.match(saved.id, /^[A-Za-z0-9-]+$/);
	assert.deepEqual(loadPermissions(dir), { grants: [saved] });
	assert.equal(statSync(join(dir, PERMISSIONS_FILE)).mode & 0o777, 0o600);
	assert.equal(statSync(join(dir, AUDIT_FILE)).mode & 0o777, 0o600);
	assert.deepEqual(audit(dir), [{ ts: NOW, action: "grant", by: "pi", grant: saved }]);
	assert.deepEqual(readdirSync(dir).sort(), [AUDIT_FILE, PERMISSIONS_FILE].sort());
});

test("addGrant keeps earlier grants and gives each a distinct id", () => {
	const dir = dataDir();
	const first = addGrant(dir, draft(), NOW);
	const second = addGrant(dir, draft({ level: "suggest" }), NOW);
	assert.notEqual(first.id, second.id);
	assert.deepEqual(loadPermissions(dir).grants, [first, second]);
});

test("addGrant refuses a draft that would not load back, writing nothing", () => {
	const dir = dataDir();
	for (const bad of [draft({ roles: [] }), draft({ models: ["*"] }), draft({ expiresAt: NOW }), draft({ level: "off" as never })]) {
		assert.throws(() => addGrant(dir, bad, NOW), /invalid grant/);
	}
	assert.deepEqual(readdirSync(dir), []);
});

test("addGrant refuses to overwrite a permissions.json it cannot read", () => {
	const dir = dataDir();
	writeFileSync(join(dir, PERMISSIONS_FILE), "{broken");
	assert.throws(() => addGrant(dir, draft(), NOW), /permissions\.json/);
	assert.equal(readFileSync(join(dir, PERMISSIONS_FILE), "utf8"), "{broken");
	assert.deepEqual(audit(dir), []);
});

test("revokeGrants removes one grant by id, or all, with one audit row each", () => {
	const dir = dataDir();
	const a = addGrant(dir, draft(), NOW);
	const b = addGrant(dir, draft(), NOW);
	const c = addGrant(dir, draft(), NOW);
	assert.deepEqual(revokeGrants(dir, b.id, NOW + 1), [b]);
	assert.deepEqual(loadPermissions(dir).grants, [a, c]);
	assert.deepEqual(revokeGrants(dir, "all", NOW + 2), [a, c]);
	assert.deepEqual(loadPermissions(dir).grants, []);
	assert.deepEqual(
		audit(dir).slice(3).map(row => [row.action, row.grant.id, row.ts]),
		[["revoke", b.id, NOW + 1], ["revoke", a.id, NOW + 2], ["revoke", c.id, NOW + 2]],
	);
});

test("revokeGrants with an unknown id changes nothing", () => {
	const dir = dataDir();
	const a = addGrant(dir, draft(), NOW);
	const before = readFileSync(join(dir, PERMISSIONS_FILE), "utf8");
	assert.deepEqual(revokeGrants(dir, "nope", NOW), []);
	assert.equal(readFileSync(join(dir, PERMISSIONS_FILE), "utf8"), before);
	assert.equal(audit(dir).length, 1);
	assert.deepEqual(loadPermissions(dir).grants, [a]);
});

test("revokeGrants refuses a permissions.json it cannot read", () => {
	const dir = dataDir();
	writeFileSync(join(dir, PERMISSIONS_FILE), "{broken");
	assert.throws(() => revokeGrants(dir, "all", NOW), /permissions\.json/);
	assert.equal(readFileSync(join(dir, PERMISSIONS_FILE), "utf8"), "{broken");
});

test("pruneExpired removes expired grants with an expire row each and keeps the rest", () => {
	const dir = dataDir();
	const old = addGrant(dir, draft({ expiresAt: NOW + HOUR }), NOW);
	const live = addGrant(dir, draft({ expiresAt: NOW + 3 * HOUR }), NOW);
	assert.deepEqual(pruneExpired(dir, NOW + HOUR), [old]);
	assert.deepEqual(loadPermissions(dir).grants, [live]);
	assert.deepEqual(audit(dir).slice(2).map(row => [row.action, row.grant.id]), [["expire", old.id]]);
	const before = readFileSync(join(dir, PERMISSIONS_FILE), "utf8");
	assert.deepEqual(pruneExpired(dir, NOW + HOUR), []);
	assert.equal(readFileSync(join(dir, PERMISSIONS_FILE), "utf8"), before);
});

test("pruneExpired leaves an unreadable file and a missing file alone", () => {
	const dir = dataDir();
	assert.deepEqual(pruneExpired(dir, NOW), []);
	assert.deepEqual(readdirSync(dir), []);
	writeFileSync(join(dir, PERMISSIONS_FILE), "{broken");
	assert.deepEqual(pruneExpired(dir, NOW), []);
	assert.equal(readFileSync(join(dir, PERMISSIONS_FILE), "utf8"), "{broken");
});

// formatting and suggestions

test("formatGrants lists each grant with id, level, scope and expiry state", () => {
	assert.equal(formatGrants([], NOW), "ai-balancer: no grants yet. A grant is your permission for the balancer to use another model for a role (level off: show only). Create one with /balancer permissions grant");
	const live = grant({ id: "live" });
	const old = grant({ id: "old", level: "suggest", expiresAt: NOW - 1 });
	const text = formatGrants([live, old], NOW);
	assert.match(text, /live · auto · profiles work · roles gentle-ai-worker · models pool\/claude-sonnet-5-5, antigravity\/gemini-3-8-flash · expires 2026-10-22T13:00Z/);
	assert.match(text, /old · suggest · .* · expired 2026-10-22T11:59Z/);
});

test("suggestModelGroups gives one group per pool: the pool model and its candidates", () => {
	const pools: Pool[] = [
		{ id: "sonnet", name: "Sonnet", candidates: [{ provider: "a", model: "s" }, { provider: "b", model: "f" }] },
		{ id: "opus", name: "Opus", candidates: [{ provider: "a", model: "o" }] },
	];
	assert.deepEqual(suggestModelGroups(pools), [
		{ label: "sonnet: pool/sonnet, a/s, b/f", models: ["pool/sonnet", "a/s", "b/f"] },
		{ label: "opus: pool/opus, a/o", models: ["pool/opus", "a/o"] },
	]);
});

// grant wizard

const profiles = {
	kind: "gentle-pi.agent_model_profiles",
	version: 1,
	active: "work",
	profiles: {
		home: { orchestrator: { model: "pool/orchestrator" } },
		work: {
			"gentle-ai-worker": { model: "pool/claude-sonnet-5-5" },
			"gentle-ai-explore": { model: "antigravity/gemini-3-8-flash" },
			"review-risk": { model: "pool/claude-opus-5-5" },
		},
	},
};
const pools: Pool[] = [
	{ id: "claude-sonnet-5-5", name: "Sonnet", candidates: [{ provider: "antigravity", model: "gemini-3-8-flash" }] },
	{ id: "claude-opus-5-5", name: "Opus", candidates: [{ provider: "claude-bridge", model: "claude-opus-5-5" }] },
];

interface Script {
	selects: (string | undefined)[];
	confirms?: boolean[];
}

function scriptedUI(script: Script) {
	const calls: { kind: string; title: string; detail: string | string[] }[] = [];
	const ui: PermissionUI = {
		async select(title, options) {
			calls.push({ kind: "select", title, detail: options });
			const wanted = script.selects.shift();
			if (wanted === undefined) return undefined;
			const match = options.find(option => option.startsWith(wanted));
			assert.ok(match, `no option starting with "${wanted}" in ${JSON.stringify(options)}`);
			return match;
		},
		async confirm(title, message) {
			calls.push({ kind: "confirm", title, detail: message });
			return script.confirms?.shift() ?? false;
		},
		notify(message) {
			calls.push({ kind: "notify", title: message, detail: "" });
		},
	};
	return { ui, calls };
}

test("runPermissionGrant walks level, profile, roles, models and expiry, then confirms with the risks", async () => {
	const { ui, calls } = scriptedUI({
		selects: ["auto", "work", "gentle-ai-worker", "done", "claude-sonnet-5-5", "done", "8 hours"],
		confirms: [true],
	});
	const result = await runPermissionGrant({ ui, profiles, pools, now: NOW });
	assert.deepEqual(result, {
		level: "auto",
		profiles: ["work"],
		roles: ["gentle-ai-worker"],
		models: ["pool/claude-sonnet-5-5", "antigravity/gemini-3-8-flash"],
		expiresAt: NOW + 8 * HOUR,
	});
	const selects = calls.filter(call => call.kind === "select");
	assert.deepEqual(selects[1].detail, ["home", "work (active)"]);
	assert.deepEqual(selects[2].detail, ["gentle-ai-explore", "gentle-ai-worker", "review-risk"]);
	assert.deepEqual(selects[3].detail, ["done", "gentle-ai-explore", "review-risk"]);
	assert.deepEqual(selects[6].detail, ["1 hour", "8 hours", "24 hours", "7 days"]);
	const confirm = calls.find(call => call.kind === "confirm");
	assert.ok(confirm);
	for (const risk of [/quality/i, /every new session/i, /gentle-pi/i, /model registry|unknown model/i, /concurrent|another writer/i]) {
		assert.match(String(confirm.detail), risk);
	}
	assert.match(String(confirm.detail), /gentle-ai-worker/);
	assert.match(String(confirm.detail), /2026-10-22T20:00Z/);
});

test("runPermissionGrant allows several roles and several model groups", async () => {
	const { ui } = scriptedUI({
		selects: ["suggest", "work", "review-risk", "gentle-ai-worker", "done", "claude-sonnet-5-5", "claude-opus-5-5", "1 hour"],
		confirms: [true],
	});
	const result = await runPermissionGrant({ ui, profiles, pools, now: NOW });
	assert.deepEqual(result?.roles, ["review-risk", "gentle-ai-worker"]);
	assert.deepEqual(result?.models, ["pool/claude-sonnet-5-5", "antigravity/gemini-3-8-flash", "pool/claude-opus-5-5", "claude-bridge/claude-opus-5-5"]);
	assert.equal(result?.level, "suggest");
	assert.equal(result?.expiresAt, NOW + HOUR);
});

test("runPermissionGrant warns in the summary when a role's current model is outside the set", async () => {
	const { ui, calls } = scriptedUI({
		selects: ["auto", "work", "review-risk", "done", "claude-sonnet-5-5", "done", "1 hour"],
		confirms: [false],
	});
	await runPermissionGrant({ ui, profiles, pools, now: NOW });
	assert.match(String(calls.find(call => call.kind === "confirm")?.detail), /review-risk uses pool\/claude-opus-5-5, outside the selected models/);
});

test("runPermissionGrant returns nothing when the user cancels at any step or declines", async () => {
	const full = ["auto", "work", "gentle-ai-worker", "done", "claude-sonnet-5-5", "done", "1 hour"];
	for (let cut = 0; cut < full.length; cut++) {
		const { ui } = scriptedUI({ selects: [...full.slice(0, cut), undefined], confirms: [true] });
		assert.equal(await runPermissionGrant({ ui, profiles, pools, now: NOW }), undefined, `cancel at step ${cut}`);
	}
	const { ui } = scriptedUI({ selects: full, confirms: [false] });
	assert.equal(await runPermissionGrant({ ui, profiles, pools, now: NOW }), undefined);
});

test("runPermissionGrant stops with an error when there are no profiles or no pools", async () => {
	for (const [store, poolList, pattern] of [
		[null, pools, /profiles\.json/],
		[{ ...profiles, profiles: {} }, pools, /profiles\.json/],
		[profiles, [], /pools\.json/],
	] as const) {
		const { ui, calls } = scriptedUI({ selects: [] });
		assert.equal(await runPermissionGrant({ ui, profiles: store, pools: poolList, now: NOW }), undefined);
		assert.deepEqual(calls.map(call => call.kind), ["notify"]);
		assert.match(calls[0].title, pattern);
	}
});

// boundary: the web never grants

test("the web server, its data and its page never import permissions", () => {
	for (const file of ["web-server.ts", "web-serve.ts", "web-data.ts", "web-page.ts"]) {
		const source = readFileSync(join(import.meta.dirname, "..", "src", file), "utf8");
		assert.doesNotMatch(source, /permissions/, file);
	}
});
