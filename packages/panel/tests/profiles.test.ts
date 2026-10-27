import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILES_KIND, PROFILES_VERSION, type ProfilesStore } from "../../../src/profiles.ts";
import { readProfilesView, saveProfilesView } from "../src/profiles.ts";

const VALID_STORE: ProfilesStore = {
	kind: PROFILES_KIND,
	version: PROFILES_VERSION,
	active: "default",
	profiles: {
		default: {
			orchestrator: { model: "anthropic/claude-3-7-sonnet", thinking: "adaptive" },
			worker: { model: "antigravity/gemini-3-8-flash" },
		},
	},
};

test("readProfilesView reads valid profiles.json and returns store and raw", () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-profiles-"));
	const file = join(dir, "profiles.json");
	const raw = JSON.stringify(VALID_STORE, null, 2) + "\n";
	writeFileSync(file, raw);

	try {
		const view = readProfilesView(file);
		assert.equal(view.raw, raw);
		assert.deepEqual(view.profiles, VALID_STORE);
		assert.equal(view.error, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readProfilesView returns error when file is missing or unreadable", () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-profiles-"));
	const file = join(dir, "missing.json");

	try {
		const view = readProfilesView(file);
		assert.equal(view.profiles, null);
		assert.match(view.error ?? "", /not found/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveProfilesView saves valid profiles atomically and creates 0600 backup", () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-profiles-"));
	const file = join(dir, "profiles.json");
	const raw = JSON.stringify(VALID_STORE, null, 1) + "\n";
	writeFileSync(file, raw);

	const updated: ProfilesStore = {
		...VALID_STORE,
		profiles: {
			...VALID_STORE.profiles,
			default: {
				...VALID_STORE.profiles.default,
				worker: { model: "anthropic/claude-3-5-haiku" },
			},
		},
	};

	try {
		const res = saveProfilesView(
			{ path: file, hasModel: (p, m) => `${p}/${m}` === "anthropic/claude-3-5-haiku" },
			{ profiles: updated, raw },
		);

		assert.equal(res.status, 200);
		assert.equal(res.body.ok, true);
		assert.ok(res.body.backup);
		assert.deepEqual(res.body.profiles, updated);
		assert.equal(readFileSync(file, "utf8"), JSON.stringify(updated, null, 1) + "\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveProfilesView refuses save when raw text has changed since read (409)", () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-profiles-"));
	const file = join(dir, "profiles.json");
	const initial = JSON.stringify(VALID_STORE, null, 1) + "\n";
	writeFileSync(file, initial);

	try {
		const res = saveProfilesView(
			{ path: file },
			{ profiles: VALID_STORE, raw: initial + " " },
		);
		assert.equal(res.status, 409);
		assert.equal(res.body.ok, false);
		assert.match(res.body.message ?? "", /changed since it was read/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveProfilesView refuses save when kind/version or model is invalid (400)", () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-profiles-"));
	const file = join(dir, "profiles.json");
	const raw = JSON.stringify(VALID_STORE, null, 1) + "\n";
	writeFileSync(file, raw);

	try {
		// Bad kind
		const badKind = { ...VALID_STORE, kind: "other-kind" };
		const res1 = saveProfilesView({ path: file }, { profiles: badKind, raw });
		assert.equal(res1.status, 400);
		assert.match(res1.body.message ?? "", /kind/);

		// Unknown model
		const unknownModel: ProfilesStore = {
			...VALID_STORE,
			profiles: {
				default: {
					...VALID_STORE.profiles.default,
					worker: { model: "unknown/unknown-model" },
				},
			},
		};
		const res2 = saveProfilesView(
			{ path: file, hasModel: () => false },
			{ profiles: unknownModel, raw },
		);
		assert.equal(res2.status, 400);
		assert.match(res2.body.message ?? "", /is not in Pi's model registry/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
