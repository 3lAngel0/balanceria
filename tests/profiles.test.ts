import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applySuggestionToProfile,
  createProfileBackup,
  loadProfilesStore,
  PROFILE_BACKUPS_KEPT,
  qualifyModel,
  readProfiles,
  saveProfilesStore,
  type ProfilesStore,
} from "../src/profiles.ts";
import type { Suggestion } from "../src/suggestions.ts";

const SAMPLE_STORE: ProfilesStore = {
  kind: "gentle-pi.agent_model_profiles",
  version: 1,
  profiles: {
    "balanced": {
      orchestrator: { model: "pool/orchestrator", thinking: "medium" },
      "gentle-ai-verify": { model: "claude-bridge/claude-opus-5-5", thinking: "medium" },
      "gentle-ai-worker": { model: "pool/claude-sonnet-5-5", thinking: "medium" },
    },
  },
  active: "balanced",
};

test("loadProfilesStore reads valid store and returns null for missing or invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "prof-test-"));
  try {
    const file = join(dir, "profiles.json");
    writeFileSync(file, JSON.stringify(SAMPLE_STORE, null, 2));
    const loaded = loadProfilesStore(file);
    assert.deepEqual(loaded, SAMPLE_STORE);

    assert.equal(loadProfilesStore(join(dir, "nonexistent.json")), null);
    writeFileSync(file, "not json");
    assert.equal(loadProfilesStore(file), null);
    writeFileSync(file, JSON.stringify({ ...SAMPLE_STORE, kind: "other" }));
    assert.equal(loadProfilesStore(file), null);
    writeFileSync(file, JSON.stringify({ ...SAMPLE_STORE, version: 2 }));
    assert.equal(loadProfilesStore(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = 1792440000000;
const KNOWN = new Set(["pool/orchestrator", "claude-bridge/claude-opus-5-5", "pool/claude-sonnet-5-5", "antigravity/gemini-3-8-flash"]);
const registry: Array<[string, string]> = [];
const hasModel = (provider: string, model: string) => {
  registry.push([provider, model]);
  return KNOWN.has(`${provider}/${model}`);
};

function profilesFile(content: string = JSON.stringify(SAMPLE_STORE, null, 2), mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), "prof-test-"));
  const file = join(dir, "profiles.json");
  writeFileSync(file, content);
  chmodSync(file, mode);
  return { dir, file };
}

const withRole = (store: ProfilesStore, profile: string, role: string, model: string): ProfilesStore => ({
  ...store,
  profiles: { ...store.profiles, [profile]: { ...(store.profiles[profile] ?? {}), [role]: { model, thinking: "medium" } } },
});

function readOk(file: string) {
  const read = readProfiles(file);
  assert.ok("store" in read, JSON.stringify(read));
  return read;
}

test("readProfiles returns the store and its raw text, or why it cannot be used", () => {
  const { dir, file } = profilesFile();
  const read = readOk(file);
  assert.deepEqual(read.store, SAMPLE_STORE);
  assert.equal(read.raw, readFileSync(file, "utf8"));
  const cases: Array<[string | undefined, RegExp]> = [
    [undefined, /not found/],
    ["not json", /not readable JSON/],
    [JSON.stringify({ ...SAMPLE_STORE, kind: "other" }), /kind "other".*version 1/],
    [JSON.stringify({ ...SAMPLE_STORE, version: 2 }), /version 2/],
    [JSON.stringify({ ...SAMPLE_STORE, profiles: [] }), /profiles/],
  ];
  for (const [index, [content, pattern]] of cases.entries()) {
    const path = join(dir, `case-${index}.json`);
    if (content !== undefined) writeFileSync(path, content);
    const result = readProfiles(path);
    assert.ok("error" in result, String(content));
    assert.match(result.error, pattern, String(content));
  }
  rmSync(dir, { recursive: true, force: true });
});

test("saveProfilesStore backs up the previous file, writes atomically with mode 0600 and leaves no temp file", () => {
  const { dir, file } = profilesFile(JSON.stringify(SAMPLE_STORE, null, 2), 0o644);
  try {
    const updated = withRole(SAMPLE_STORE, "test-new", "gentle-ai-worker", "antigravity/gemini-3-8-flash");
    const { backup, removed } = saveProfilesStore(updated, readOk(file), { path: file, now: NOW, hasModel });
    assert.ok(existsSync(backup));
    assert.match(backup, /profiles\.json\.bak-\d{14}$/);
    assert.equal(readFileSync(backup, "utf8"), JSON.stringify(SAMPLE_STORE, null, 2));
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), updated);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(removed, []);
    assert.deepEqual(readdirSync(dir).sort(), ["profiles.json", backup.split("/").pop()].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function assertRefused(file: string, dir: string, run: () => unknown, pattern: RegExp, expectedContent: string) {
  assert.throws(run, pattern);
  assert.equal(readFileSync(file, "utf8"), expectedContent);
  assert.deepEqual(readdirSync(dir).filter(name => name !== "profiles.json"), [], "no backup or temp file");
}

test("saveProfilesStore refuses, writing nothing, when the file changed since it was read", () => {
  const { dir, file } = profilesFile();
  try {
    const read = readOk(file);
    const other = JSON.stringify(withRole(SAMPLE_STORE, "balanced", "orchestrator", "claude-bridge/claude-opus-5-5"));
    writeFileSync(file, other);
    const next = withRole(read.store, "test-new", "orchestrator", "pool/orchestrator");
    assertRefused(file, dir, () => saveProfilesStore(next, read, { path: file, now: NOW, hasModel }), /changed since it was read/, other);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveProfilesStore refuses when the file is gone: gentle-pi creates it, never the balancer", () => {
  const { dir, file } = profilesFile();
  try {
    const read = readOk(file);
    rmSync(file);
    assert.throws(() => saveProfilesStore(read.store, read, { path: file, now: NOW, hasModel }), /not found/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveProfilesStore refuses a store with an unknown kind or version", () => {
  const { dir, file } = profilesFile();
  try {
    const read = readOk(file);
    const before = readFileSync(file, "utf8");
    for (const next of [{ ...read.store, kind: "other" }, { ...read.store, version: 2 }]) {
      assertRefused(file, dir, () => saveProfilesStore(next, read, { path: file, now: NOW, hasModel }), /kind|version/, before);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveProfilesStore checks only new or changed roles against Pi's model registry", () => {
  const legacy = withRole(SAMPLE_STORE, "balanced", "old-role", "retired/model");
  const { dir, file } = profilesFile(JSON.stringify(legacy));
  try {
    const read = readOk(file);
    const before = readFileSync(file, "utf8");
    for (const [model, pattern] of [
      ["nope/x", /test-new\.gentle-ai-worker: nope\/x is not in Pi's model registry/],
      ["no-slash", /test-new\.gentle-ai-worker: no-slash is not provider\/model/],
      ["", /test-new\.gentle-ai-worker:  is not provider\/model/],
    ] as const) {
      const next = withRole(read.store, "test-new", "gentle-ai-worker", model);
      assertRefused(file, dir, () => saveProfilesStore(next, read, { path: file, now: NOW, hasModel }), pattern, before);
    }
    registry.length = 0;
    const next = withRole(read.store, "test-new", "gentle-ai-worker", "pool/claude-sonnet-5-5");
    saveProfilesStore(next, read, { path: file, now: NOW, hasModel });
    assert.deepEqual(registry, [["pool", "claude-sonnet-5-5"]], "only the new role is looked up; retired/model is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveProfilesStore keeps the newest backups in its own format and never touches other backups", () => {
  const { dir, file } = profilesFile();
  try {
    const own = Array.from({ length: PROFILE_BACKUPS_KEPT + 2 }, (_, i) => `profiles.json.bak-202610010000${String(i).padStart(2, "0")}`);
    const foreign = ["profiles.json.bak-20261019", "profiles.json.bak-202610161338", "profiles.json.bak-manual"];
    for (const name of [...own, ...foreign]) writeFileSync(join(dir, name), "{}");
    const read = readOk(file);
    const { backup, removed } = saveProfilesStore(withRole(read.store, "test-new", "orchestrator", "pool/orchestrator"), read, { path: file, now: NOW, hasModel });
    assert.deepEqual(removed.map(path => path.split("/").pop()), own.slice(0, 3));
    const left = readdirSync(dir);
    for (const name of foreign) assert.ok(left.includes(name), name);
    assert.ok(left.includes(backup.split("/").pop()!));
    assert.equal(left.filter(name => /\.bak-\d{14}$/.test(name)).length, PROFILE_BACKUPS_KEPT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qualifyModel adds the provider only when Pi knows exactly one for a bare model id", () => {
  const known = [
    { provider: "antigravity", id: "gemini-3-8-flash" },
    { provider: "antigravity", id: "claude-sonnet-5-5" },
    { provider: "claude-bridge", id: "claude-sonnet-5-5" },
  ];
  assert.equal(qualifyModel("gemini-3-8-flash", known), "antigravity/gemini-3-8-flash");
  assert.equal(qualifyModel("claude-sonnet-5-5", known), "claude-sonnet-5-5");
  assert.equal(qualifyModel("unknown", known), "unknown");
  assert.equal(qualifyModel("claude-bridge/claude-sonnet-5-5", known), "claude-bridge/claude-sonnet-5-5");
});

test("createProfileBackup copies with mode 0600 whatever the source mode", () => {
  const { dir, file } = profilesFile(JSON.stringify(SAMPLE_STORE), 0o644);
  try {
    const backup = createProfileBackup(file, NOW);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(readFileSync(backup, "utf8"), JSON.stringify(SAMPLE_STORE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applySuggestionToProfile creates a new profile with the cheaper model for expensive-role", () => {
  const suggestion: Suggestion = {
    rule: "expensive-role",
    title: "Try small for gentle-ai-verify",
    target: { role: "gentle-ai-verify", model: "claude-bridge/claude-opus-5-5", cheaperModel: "antigravity/gemini-3-8-flash" },
    evidence: ["saving evidence"],
    saving: { usd: 0.18, tokens: null, quotaPercent: null },
    quality: "Quality note",
  };

  const result = applySuggestionToProfile(SAMPLE_STORE, "balanced", "balanced-optimized", suggestion);
  assert.equal(result.changed, true);
  assert.deepEqual(result.store.profiles["balanced-optimized"]["gentle-ai-verify"], {
    model: "antigravity/gemini-3-8-flash",
    thinking: "medium",
  });
  // Original untouched
  assert.equal(result.store.profiles["balanced"]["gentle-ai-verify"].model, "claude-bridge/claude-opus-5-5");
});
