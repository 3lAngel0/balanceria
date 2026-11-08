import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applySuggestionToProfile,
  createProfileBackup,
  defaultModelsPath,
  defaultProfilesPath,
  defaultSubagentsPath,
  loadProfilesStore,
  ORCHESTRATOR_MODES,
  isOrchestratorMode,
  getProfileWorkflow,
  setProfileWorkflow,
  PROFILE_BACKUPS_KEPT,
  qualifyModel,
  readProfiles,
  resolveAgentHome,
  resolveConfigHome,
  saveProfilesStore,
  syncLiveSessionProfile,
  syncModelsJson,
  syncSubagentsJson,
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

test("resolveConfigHome respects GENTLE_SHELL_PREFIX, env vars, and fallbacks", () => {
  const dir = mkdtempSync(join(tmpdir(), "res-cfg-"));
  try {
    assert.equal(
      resolveConfigHome({ GENTLE_SHELL_PREFIX: "/custom/prefix" }, dir),
      "/custom/prefix/config/gentle-ai",
    );
    assert.equal(
      resolveConfigHome({ GENTLE_PI_CONFIG_HOME: "/custom/config/home" }, dir),
      "/custom/config/home",
    );
    assert.equal(
      resolveConfigHome({ GENTLE_SHELL_CONFIG_HOME: "/custom/shell/config" }, dir),
      "/custom/shell/config",
    );
    assert.equal(
      resolveConfigHome({}, dir),
      join(dir, ".pi", "gentle-ai"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("syncSubagentsJson updates model_profiles without touching orchestrator or unrelated fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-test-"));
  const subagentsPath = join(dir, "subagents.json");
  try {
    const initial = {
      default_model: "claude-bridge/claude-sonnet-5-5",
      model_profiles: {
        "gentle-ai-worker": { model: "claude-bridge/claude-sonnet-5-5", effort: "medium" },
        "gentle-ai-explore": { model: "antigravity/gemini-3-8-flash", effort: "low" },
      },
    };
    writeFileSync(subagentsPath, JSON.stringify(initial, null, 2));

    syncSubagentsJson(
      {
        orchestrator: { model: "pool/orchestrator", thinking: "medium" },
        "gentle-ai-worker": { model: "antigravity/gemini-3-8-flash", thinking: "high" },
        "review-reliability": { model: "antigravity/gemini-4-argon", thinking: "medium" },
      },
      subagentsPath,
    );

    const updated = JSON.parse(readFileSync(subagentsPath, "utf8"));
    assert.equal(updated.default_model, "claude-bridge/claude-sonnet-5-5");
    assert.deepEqual(updated.model_profiles["gentle-ai-worker"], {
      model: "antigravity/gemini-3-8-flash",
      effort: "high",
    });
    assert.deepEqual(updated.model_profiles["gentle-ai-explore"], {
      model: "antigravity/gemini-3-8-flash",
      effort: "low",
    });
    assert.deepEqual(updated.model_profiles["review-reliability"], {
      model: "antigravity/gemini-4-argon",
      effort: "medium",
    });
    assert.equal(updated.model_profiles.orchestrator, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveProfilesStore synchronizes subagents.json when syncSubagents is enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "prof-sub-sync-"));
  const file = join(dir, "profiles.json");
  const subagentsPath = join(dir, "subagents.json");
  try {
    writeFileSync(file, JSON.stringify(SAMPLE_STORE, null, 2));
    writeFileSync(
      subagentsPath,
      JSON.stringify({
        model_profiles: {
          "gentle-ai-worker": { model: "claude-bridge/claude-sonnet-5-5", effort: "medium" },
        },
      }),
    );

    const updated = withRole(SAMPLE_STORE, "balanced", "gentle-ai-worker", "antigravity/gemini-3-8-flash");
    saveProfilesStore(updated, readOk(file), { path: file, subagentsPath, now: NOW, hasModel });

    const synced = JSON.parse(readFileSync(subagentsPath, "utf8"));
    assert.equal(synced.model_profiles["gentle-ai-worker"].model, "antigravity/gemini-3-8-flash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncModelsJson updates models.json without touching orchestrator or unrelated roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "models-test-"));
  const modelsPath = join(dir, "models.json");
  try {
    const initial = {
      "gentle-ai-worker": { model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" },
      "gentle-ai-explore": { model: "antigravity/gemini-3-8-flash", thinking: "low" },
    };
    writeFileSync(modelsPath, JSON.stringify(initial, null, 2));

    syncModelsJson(
      {
        orchestrator: { model: "pool/orchestrator", thinking: "medium" },
        "gentle-ai-worker": { model: "pool/gemini-3-8-flash", thinking: "high" },
        "review-reliability": { model: "antigravity/gemini-4-argon", thinking: "medium" },
      },
      modelsPath,
    );

    const updated = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.deepEqual(updated["gentle-ai-worker"], {
      model: "pool/gemini-3-8-flash",
      thinking: "high",
    });
    assert.deepEqual(updated["gentle-ai-explore"], {
      model: "antigravity/gemini-3-8-flash",
      thinking: "low",
    });
    assert.deepEqual(updated["review-reliability"], {
      model: "antigravity/gemini-4-argon",
      thinking: "medium",
    });
    assert.equal(updated.orchestrator, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveProfilesStore synchronizes models.json when syncModels is enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "prof-mod-sync-"));
  const file = join(dir, "profiles.json");
  const modelsPath = join(dir, "models.json");
  try {
    writeFileSync(file, JSON.stringify(SAMPLE_STORE, null, 2));
    writeFileSync(
      modelsPath,
      JSON.stringify({
        "gentle-ai-worker": { model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" },
      }),
    );

    const updated = withRole(SAMPLE_STORE, "balanced", "gentle-ai-worker", "antigravity/gemini-3-8-flash");
    saveProfilesStore(updated, readOk(file), { path: file, modelsPath, now: NOW, hasModel });

    const synced = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(synced["gentle-ai-worker"].model, "antigravity/gemini-3-8-flash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncLiveSessionProfile updates Gentle Shell 4.6.0 in-memory session freeze and bindings on saveProfilesStore", () => {
  const freezeKey = Symbol.for("gentle-pi:session-profile-freeze");
  const bindingsKey = Symbol.for("gentle-pi:session-profile-bindings");
  const holder = globalThis as Record<symbol, unknown>;
  const prevFreeze = holder[freezeKey];
  const prevBindings = holder[bindingsKey];

  const dir = mkdtempSync(join(tmpdir(), "prof-live-sync-"));
  const file = join(dir, "profiles.json");
  const subagentsPath = join(dir, "subagents.json");
  const modelsPath = join(dir, "models.json");
  try {
    const frozenMap = new Map<string, unknown>([
      [
        "sess-1",
        {
          profile: {
            name: "balanced",
            origin: "global",
            modelProfiles: {
              "gentle-ai-worker": { model: "pool/claude-sonnet-5-5", thinking: "medium" },
            },
          },
        },
      ],
    ]);
    const definitionsMap = new Map<string, unknown>();
    holder[freezeKey] = {
      frozen: frozenMap,
      definitions: definitionsMap,
      ownStart: new Set(["sess-1"]),
      orchestrators: new Map(),
      notified: new Map(),
    };

    const bindingsMap = new Map<string, unknown>([
      [
        "sess-2",
        {
          name: "balanced",
          origin: "user",
          modelProfiles: {
            orchestrator: { model: "pool/orchestrator", thinking: "medium" },
            "gentle-ai-worker": { model: "pool/claude-sonnet-5-5", thinking: "medium" },
          },
        },
      ],
    ]);
    holder[bindingsKey] = bindingsMap;

    writeFileSync(file, JSON.stringify(SAMPLE_STORE, null, 2));
    const updated = withRole(SAMPLE_STORE, "balanced", "gentle-ai-worker", "antigravity/gemini-3-8-flash");
    saveProfilesStore(updated, readOk(file), { path: file, subagentsPath, modelsPath, now: NOW, hasModel });

    const frozenAfter = frozenMap.get("sess-1") as { profile: { name: string; origin: string; modelProfiles: Record<string, { model: string }> } };
    assert.equal(frozenAfter.profile.name, "balanced");
    assert.equal(frozenAfter.profile.modelProfiles["gentle-ai-worker"].model, "antigravity/gemini-3-8-flash");
    assert.equal(frozenAfter.profile.modelProfiles.orchestrator, undefined);

    const defAfter = definitionsMap.get("sess-1") as Record<string, { model: string }>;
    assert.equal(defAfter["gentle-ai-worker"].model, "antigravity/gemini-3-8-flash");
    assert.equal(defAfter.orchestrator.model, "pool/orchestrator");

    const boundAfter = bindingsMap.get("sess-2") as { name: string; modelProfiles: Record<string, { model: string }> };
    assert.equal(boundAfter.modelProfiles["gentle-ai-worker"].model, "antigravity/gemini-3-8-flash");
  } finally {
    if (prevFreeze === undefined) delete holder[freezeKey];
    else holder[freezeKey] = prevFreeze;
    if (prevBindings === undefined) delete holder[bindingsKey];
    else holder[bindingsKey] = prevBindings;
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

test("isOrchestratorMode and get/setProfileWorkflow support Gentle Shell 4.7.0 workflow mode", () => {
  assert.equal(isOrchestratorMode("organic"), true);
  assert.equal(isOrchestratorMode("full-delegation"), true);
  assert.equal(isOrchestratorMode("unknown"), false);
  assert.equal(isOrchestratorMode(null), false);

  assert.deepEqual([...ORCHESTRATOR_MODES], ["organic", "full-delegation"]);

  const storeWithoutWorkflow = SAMPLE_STORE;
  assert.deepEqual(getProfileWorkflow(storeWithoutWorkflow, "balanced"), { orchestratorMode: "organic" });

  const updated = setProfileWorkflow(storeWithoutWorkflow, "balanced", { orchestratorMode: "full-delegation" });
  assert.deepEqual(getProfileWorkflow(updated, "balanced"), { orchestratorMode: "full-delegation" });
  assert.equal(updated.workflow?.["balanced"]?.orchestratorMode, "full-delegation");
});
