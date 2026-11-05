import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Suggestion } from "./suggestions.ts";

/**
 * Resolves the configuration directory for gentle-pi / gentle-shell.
 * Checks in order of precedence:
 * 1. GENTLE_SHELL_PREFIX/config/gentle-ai (bundled installation)
 * 2. GENTLE_PI_CONFIG_HOME
 * 3. GENTLE_SHELL_CONFIG_HOME
 * 4. ~/.gentle-shell/config/gentle-ai (if exists)
 * 5. ~/.pi/gentle-ai
 */
export function resolveConfigHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.GENTLE_SHELL_PREFIX) {
    return join(env.GENTLE_SHELL_PREFIX, "config", "gentle-ai");
  }
  if (env.GENTLE_PI_CONFIG_HOME) {
    return env.GENTLE_PI_CONFIG_HOME;
  }
  if (env.GENTLE_SHELL_CONFIG_HOME) {
    return env.GENTLE_SHELL_CONFIG_HOME;
  }
  const gentleShellConfig = join(home, ".gentle-shell", "config", "gentle-ai");
  if (existsSync(gentleShellConfig)) {
    return gentleShellConfig;
  }
  return join(home, ".pi", "gentle-ai");
}

/**
 * Resolves the agent home directory for subagents.json.
 * Checks GENTLE_PI_AGENT_HOME, PI_CODING_AGENT_DIR, GENTLE_SHELL_PREFIX/agent, or ~/.pi/agent.
 */
export function resolveAgentHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.GENTLE_PI_AGENT_HOME) return env.GENTLE_PI_AGENT_HOME;
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  if (env.GENTLE_SHELL_PREFIX) return join(env.GENTLE_SHELL_PREFIX, "agent");
  const gentleShellAgent = join(home, ".gentle-shell", "agent");
  if (existsSync(gentleShellAgent)) return gentleShellAgent;
  return join(home, ".pi", "agent");
}

export function defaultProfilesPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(resolveConfigHome(env, home), "profiles.json");
}

export function defaultSubagentsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(resolveAgentHome(env, home), "subagents.json");
}

export function defaultModelsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(resolveConfigHome(env, home), "models.json");
}

export const DEFAULT_PROFILES_PATH = defaultProfilesPath();
export const DEFAULT_SUBAGENTS_PATH = defaultSubagentsPath();
export const DEFAULT_MODELS_PATH = defaultModelsPath();

export interface RoleRoute {
  model: string;
  thinking?: string;
  [key: string]: unknown;
}

export type ProfileConfig = Record<string, RoleRoute>;

export interface ProfilesStore {
  kind: string;
  version: number;
  profiles: Record<string, ProfileConfig>;
  active?: string;
  [key: string]: unknown;
}

// profiles.json belongs to gentle-pi: the balancer reads and writes only the
// kind and version it knows.
export const PROFILES_KIND = "gentle-pi.agent_model_profiles";
export const PROFILES_VERSION = 1;
/** Backups in the balancer's own format kept after each save; other backups are never touched. */
export const PROFILE_BACKUPS_KEPT = 10;

export interface ProfilesRead {
  store: ProfilesStore;
  /** The file text as read, compared again right before a save. */
  raw: string;
}

function kindIssue(value: { kind?: unknown; version?: unknown }): string | undefined {
  if (value.kind === PROFILES_KIND && value.version === PROFILES_VERSION) return undefined;
  return `profiles.json has kind ${JSON.stringify(value.kind)} version ${JSON.stringify(value.version)}; the balancer only handles ${PROFILES_KIND} version ${PROFILES_VERSION}`;
}

/** Parses profiles.json text; `label` names the file in errors. */
export function parseProfilesText(raw: string, label: string): { store: ProfilesStore } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: `${label} is not a JSON object` };
  const issue = kindIssue(parsed as ProfilesStore);
  if (issue) return { error: issue };
  const profiles = (parsed as ProfilesStore).profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return { error: `${label} has no profiles object` };
  return { store: parsed as ProfilesStore };
}

export function readProfiles(path?: string): ProfilesRead | { error: string } {
  const filePath = path ?? defaultProfilesPath();
  if (!existsSync(filePath)) return { error: `${filePath} not found` };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    return { error: `${filePath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseProfilesText(raw, filePath);
  return "store" in parsed ? { store: parsed.store, raw } : parsed;
}

export function loadProfilesStore(path?: string): ProfilesStore | null {
  const read = readProfiles(path);
  return "store" in read ? read.store : null;
}

function formatBackupStamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function createProfileBackup(path: string, now = Date.now()): string {
  const backup = `${path}.bak-${formatBackupStamp(now)}`;
  copyFileSync(path, backup);
  chmodSync(backup, 0o600);
  return backup;
}

/** Removes the oldest `<file>.bak-YYYYMMDDHHMMSS` backups past `keep`; returns the removed paths. */
export function rotateProfileBackups(path: string, keep = PROFILE_BACKUPS_KEPT): string[] {
  const prefix = `${basename(path)}.bak-`;
  const own = readdirSync(dirname(path))
    .filter(name => name.startsWith(prefix) && /^\d{14}$/.test(name.slice(prefix.length)))
    .sort();
  const removed = own.slice(0, Math.max(0, own.length - keep)).map(name => join(dirname(path), name));
  for (const file of removed) unlinkSync(file);
  return removed;
}

/** `provider/model` for a bare model id that exactly one provider serves; otherwise the id unchanged. */
export function qualifyModel(model: string, known: ReadonlyArray<{ provider: string; id: string }>): string {
  if (model.includes("/")) return model;
  const providers = known.filter(entry => entry.id === model);
  return providers.length === 1 ? `${providers[0].provider}/${model}` : model;
}

/** Roles whose model is new or differs from `before`, as `profile.role` → model. */
function changedRoutes(before: ProfilesStore, after: ProfilesStore): Array<{ where: string; model: unknown }> {
  const changed: Array<{ where: string; model: unknown }> = [];
  for (const [profile, routes] of Object.entries(after.profiles ?? {})) {
    for (const [role, route] of Object.entries(routes ?? {})) {
      const model = (route as RoleRoute | undefined)?.model;
      if (before.profiles?.[profile]?.[role]?.model !== model) changed.push({ where: `${profile}.${role}`, model });
    }
  }
  return changed;
}

/**
 * Safely replaces `path` with `text` after verifying its current content matches `expectedRaw`.
 * Creates a backup with mode 0600, writes to a temp file mode 0600 with flag "wx", renames atomically,
 * removes the temp file on failure, and rotates backups keeping 10 own-format backups.
 * Throws, writing nothing, when the file is missing or its current text !== expectedRaw.
 */
export function replaceFileSafely(
  path: string,
  text: string,
  expectedRaw: string,
  now = Date.now(),
): { backup: string; removed: string[] } {
  if (!existsSync(path)) {
    throw new Error(`ai-balancer: refusing to write: ${path} not found${basename(path) === "profiles.json" ? "; gentle-pi creates it" : ""}`);
  }
  if (readFileSync(path, "utf8") !== expectedRaw) {
    throw new Error(`ai-balancer: refusing to write: ${basename(path)} changed since it was read; nothing written, try again`);
  }
  const backup = createProfileBackup(path, now);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Already renamed or never created.
    }
    throw error;
  }
  return { backup, removed: rotateProfileBackups(path) };
}

export interface SaveProfilesOptions {
  path?: string;
  subagentsPath?: string;
  modelsPath?: string;
  syncSubagents?: boolean;
  syncModels?: boolean;
  now?: number;
  /** Pi's model registry lookup. */
  hasModel(provider: string, model: string): boolean;
}

/**
 * Syncs the active profile's subagent roles into subagents.json
 * so gentle-pi's loadAgentsConfig instantly reflects the configured models.
 */
export function syncSubagentsJson(activeConfig: ProfileConfig, subagentsPath?: string): void {
  const targetPath = subagentsPath ?? defaultSubagentsPath();
  if (!existsSync(targetPath)) return;
  let raw: string;
  try {
    raw = readFileSync(targetPath, "utf8");
  } catch {
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    parsed = data as Record<string, unknown>;
  } catch {
    return;
  }

  const existingProfiles = (parsed.model_profiles && typeof parsed.model_profiles === "object" && !Array.isArray(parsed.model_profiles))
    ? { ...(parsed.model_profiles as Record<string, unknown>) }
    : {};

  for (const [role, route] of Object.entries(activeConfig)) {
    if (role === "orchestrator" || !route || typeof route !== "object") continue;
    const model = (route as RoleRoute).model;
    const thinking = (route as RoleRoute).thinking;
    if (typeof model !== "string" || !model) continue;

    const currentEntry = (existingProfiles[role] && typeof existingProfiles[role] === "object")
      ? (existingProfiles[role] as Record<string, unknown>)
      : {};

    existingProfiles[role] = {
      ...currentEntry,
      model,
      ...(thinking ? { effort: thinking } : {}),
    };
  }

  parsed.model_profiles = existingProfiles;
  const temp = `${targetPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(parsed, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temp, targetPath);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Ignored
    }
  }
}

/**
 * Syncs the active profile's subagent roles into models.json
 * so gentle-pi's applySavedModelConfig (Gentle Shell 4.6.0+) treats the
 * balancer's profile choices as authoritative instead of overwriting subagents.json.
 */
export function syncModelsJson(activeConfig: ProfileConfig, modelsPath?: string): void {
  const targetPath = modelsPath ?? defaultModelsPath();
  let existing: Record<string, { model: string; thinking?: string }> = {};
  if (existsSync(targetPath)) {
    try {
      const raw = readFileSync(targetPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, { model: string; thinking?: string }>;
      }
    } catch {
      // Ignore parse failure; overwrite with valid config
    }
  }

  for (const [role, route] of Object.entries(activeConfig)) {
    if (role === "orchestrator" || !route || typeof route !== "object") continue;
    const model = (route as RoleRoute).model;
    const thinking = (route as RoleRoute).thinking;
    if (typeof model !== "string" || !model) continue;

    existing[role] = {
      model,
      ...(thinking ? { thinking } : {}),
    };
  }

  const temp = `${targetPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(existing, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temp, targetPath);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Ignored
    }
  }
}

/**
 * Writes `next` over the file `read` came from, with a backup. Throws, writing
 * nothing, when the file changed or vanished since it was read, when `next`
 * has an unknown kind or version, or when a new or changed role names a model
 * Pi does not know.
 */
export function saveProfilesStore(next: ProfilesStore, read: ProfilesRead, options: SaveProfilesOptions): { backup: string; removed: string[] } {
  const path = options.path ?? defaultProfilesPath();
  const now = options.now ?? Date.now();
  const issue = kindIssue(next);
  if (issue) throw new Error(`ai-balancer: refusing to write: ${issue}`);
  const unknown = changedRoutes(read.store, next).flatMap(({ where, model }) => {
    const text = typeof model === "string" ? model : "";
    const slash = text.indexOf("/");
    if (slash <= 0 || slash === text.length - 1) return [`${where}: ${text} is not provider/model`];
    return options.hasModel(text.slice(0, slash), text.slice(slash + 1)) ? [] : [`${where}: ${text} is not in Pi's model registry`];
  });
  if (unknown.length) throw new Error(`ai-balancer: refusing to write profiles.json: ${unknown.join("; ")}`);
  const result = replaceFileSafely(path, JSON.stringify(next, null, 1) + "\n", read.raw, now);

  if (options.syncSubagents !== false) {
    const activeName = next.active;
    const activeConfig = activeName ? next.profiles[activeName] : undefined;
    if (activeConfig) {
      try {
        syncSubagentsJson(activeConfig, options.subagentsPath);
      } catch {
        // Non-fatal if subagents.json sync fails.
      }
      if (options.syncModels !== false) {
        try {
          syncModelsJson(activeConfig, options.modelsPath);
        } catch {
          // Non-fatal if models.json sync fails.
        }
      }
    }
  }

  return result;
}

export interface ProfileApplyResult {
  store: ProfilesStore;
  changed: boolean;
  description: string;
}

export function applySuggestionToProfile(
  store: ProfilesStore,
  baseProfile: string,
  newProfileName: string,
  suggestion: Suggestion,
): ProfileApplyResult {
  const base = store.profiles[baseProfile];
  if (!base) {
    return { store, changed: false, description: `Base profile "${baseProfile}" not found` };
  }

  if (suggestion.rule === "expensive-role" && suggestion.target.role && suggestion.target.cheaperModel) {
    const role = suggestion.target.role;
    const cheaper = suggestion.target.cheaperModel;
    const clonedProfile: ProfileConfig = JSON.parse(JSON.stringify(base));
    const currentRoute = clonedProfile[role] ?? { model: "", thinking: "medium" };
    clonedProfile[role] = { ...currentRoute, model: cheaper };

    const newProfiles = {
      ...store.profiles,
      [newProfileName]: clonedProfile,
    };

    return {
      store: { ...store, profiles: newProfiles },
      changed: true,
      description: `Created profile "${newProfileName}" from "${baseProfile}" with role ${role} -> ${cheaper}`,
    };
  }

  return { store, changed: false, description: "Suggestion is not directly applicable to a profile" };
}
