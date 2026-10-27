import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { validatePoolsConfig } from "./config-schema.ts";
import { formatTokens } from "./panel.ts";
import type { HistoryEntry } from "./history.ts";
import { parseProfilesText, replaceFileSafely, saveProfilesStore, type ProfilesStore } from "./profiles.ts";
import { ORCHESTRATOR_ROLE } from "./roles.ts";

// Lab mode (design §9): a draft of pools.json and profiles.json kept in
// data/lab/, compared and simulated against the live files, and applied only
// on request. Nothing here changes routing until the draft is applied.

export const LAB_POOLS = "pools.json";
export const LAB_PROFILES = "profiles.json";
export const LAB_BASE = "base.json";
export const LAB_APPLIED = "applied.json";

export interface LabPaths {
	labDir: string;
	poolsPath: string;
	profilesPath: string;
}

/** The live texts when the draft was made; apply refuses when a live file no longer matches. */
export interface LabBase {
	createdAt: number;
	pools: string;
	/** Null when profiles.json was missing or unusable: the draft then holds pools only. */
	profiles: string | null;
}

export interface LabDraft {
	base: LabBase;
	pools: string;
	profiles: string | null;
}

export interface LabTexts {
	pools: string;
	profiles: string | null;
}

function writePrivate(file: string, text: string): void {
	writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
}

export function hasDraft(labDir: string): boolean {
	return existsSync(join(labDir, LAB_BASE));
}

/** Copies the live files into a new draft. Throws, writing nothing, when a draft exists (unless `replace`) or pools.json is unreadable. */
export function createDraft(paths: LabPaths, now: number, options: { replace?: boolean } = {}): LabBase {
	if (hasDraft(paths.labDir) && !options.replace) {
		throw new Error("ai-balancer: a lab draft already exists; discard it or replace it first");
	}
	let pools: string;
	try {
		pools = readFileSync(paths.poolsPath, "utf8");
	} catch (error) {
		throw new Error(`ai-balancer: cannot read pools.json: ${error instanceof Error ? error.message : String(error)}`);
	}
	let profiles: string | null = null;
	if (existsSync(paths.profilesPath)) {
		const raw = readFileSync(paths.profilesPath, "utf8");
		if ("store" in parseProfilesText(raw, LAB_PROFILES)) profiles = raw;
	}
	discardDraft(paths.labDir);
	mkdirSync(paths.labDir, { recursive: true, mode: 0o700 });
	writePrivate(join(paths.labDir, LAB_POOLS), pools);
	if (profiles !== null) writePrivate(join(paths.labDir, LAB_PROFILES), profiles);
	const base: LabBase = { createdAt: now, pools, profiles };
	// base.json last: a draft counts as present only once it is complete.
	writePrivate(join(paths.labDir, LAB_BASE), `${JSON.stringify(base)}\n`);
	return base;
}

export function readDraft(labDir: string): LabDraft | { error: string } {
	if (!hasDraft(labDir)) return { error: "ai-balancer: no lab draft; start one with /balancer lab new" };
	let base: LabBase;
	try {
		base = JSON.parse(readFileSync(join(labDir, LAB_BASE), "utf8")) as LabBase;
	} catch (error) {
		return { error: `ai-balancer: the lab draft's base.json is unreadable (${error instanceof Error ? error.message : String(error)}); discard the draft` };
	}
	const read = (name: string) => (existsSync(join(labDir, name)) ? readFileSync(join(labDir, name), "utf8") : null);
	return { base, pools: read(LAB_POOLS) ?? "", profiles: read(LAB_PROFILES) };
}

export function discardDraft(labDir: string): void {
	// base.json first: a half-removed draft never counts as present.
	for (const name of [LAB_BASE, LAB_POOLS, LAB_PROFILES]) rmSync(join(labDir, name), { force: true });
}

export interface LabDiff {
	changes: string[];
	/** Problems that make the draft unusable; apply refuses while any remain. */
	issues: string[];
	notes: string[];
}

interface RawPool {
	id: string;
	name?: unknown;
	strategy?: unknown;
	candidates: string[];
	rules?: unknown;
}

function rawPools(value: unknown): Map<string, RawPool> {
	const pools = new Map<string, RawPool>();
	for (const item of (value as { pools?: unknown[] } | null)?.pools ?? []) {
		const pool = item as RawPool;
		if (pool && typeof pool.id === "string" && Array.isArray(pool.candidates)) pools.set(pool.id, pool);
	}
	return pools;
}

function shown(value: unknown): string {
	return value === undefined ? "(default)" : typeof value === "string" ? value : JSON.stringify(value);
}

function diffPools(current: unknown, draft: unknown): string[] {
	const before = rawPools(current);
	const after = rawPools(draft);
	const changes: string[] = [];
	for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		const a = before.get(id);
		const b = after.get(id);
		if (!a && b) changes.push(`pool ${id}: added (${b.candidates.join(", ")})`);
		else if (a && !b) changes.push(`pool ${id}: removed (${a.candidates.join(", ")})`);
	}
	for (const [id, b] of after) {
		const a = before.get(id);
		if (!a) continue;
		for (const field of ["name", "strategy"] as const) {
			if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) changes.push(`pool ${id}: ${field} ${shown(a[field])} → ${shown(b[field])}`);
		}
		if (a.candidates.join("\n") !== b.candidates.join("\n")) {
			const added = b.candidates.filter(candidate => !a.candidates.includes(candidate));
			const removed = a.candidates.filter(candidate => !b.candidates.includes(candidate));
			if (added.length === 0 && removed.length === 0) {
				changes.push(`pool ${id}: candidates reordered ${a.candidates.join(", ")} → ${b.candidates.join(", ")}`);
			} else {
				const parts = [added.length ? `+ ${added.join(", ")}` : "", removed.length ? `− ${removed.join(", ")}` : ""].filter(Boolean);
				changes.push(`pool ${id}: candidates ${parts.join("; ")}`);
			}
		}
		if (JSON.stringify(a.rules) !== JSON.stringify(b.rules)) changes.push(`pool ${id}: rules ${shown(a.rules)} → ${shown(b.rules)}`);
	}
	return changes;
}

function diffProfiles(current: ProfilesStore, draft: ProfilesStore): { changes: string[]; notes: string[] } {
	const changes: string[] = [];
	const notes: string[] = [];
	if (current.active !== draft.active) changes.push(`profiles: active ${shown(current.active)} → ${shown(draft.active)}`);
	const roleCount = (routes: object) => {
		const count = Object.keys(routes).length;
		return `${count} role${count === 1 ? "" : "s"}`;
	};
	const names = [...new Set([...Object.keys(current.profiles), ...Object.keys(draft.profiles)])].sort();
	for (const name of names) {
		const a = current.profiles[name];
		const b = draft.profiles[name];
		if (!a && b) changes.push(`profile ${name}: added (${roleCount(b)})`);
		else if (a && !b) changes.push(`profile ${name}: removed (${roleCount(a)})`);
	}
	for (const name of names) {
		const a = current.profiles[name];
		const b = draft.profiles[name];
		if (!a || !b) continue;
		let orchestratorChanged = false;
		for (const role of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
			const before = a[role];
			const after = b[role];
			const where = `profile ${name}: ${role}`;
			if (!before && after) changes.push(`${where} added ${after.model}`);
			else if (before && !after) changes.push(`${where} removed (was ${before.model})`);
			else if (before && after) {
				if (before.model !== after.model) changes.push(`${where} ${before.model} → ${after.model}`);
				if (before.thinking !== after.thinking) changes.push(`${where} thinking ${shown(before.thinking)} → ${shown(after.thinking)}`);
				const rest = (route: object) => JSON.stringify(Object.entries(route).filter(([key]) => key !== "model" && key !== "thinking").sort());
				if (rest(before) !== rest(after)) changes.push(`${where} other settings ${rest(before)} → ${rest(after)}`);
			}
			if (role === ORCHESTRATOR_ROLE && JSON.stringify(before) !== JSON.stringify(after)) orchestratorChanged = true;
		}
		if (orchestratorChanged) {
			notes.push(`profile ${name}: the orchestrator entry reaches Pi's settings.json only when the profile is selected in /gentle:profiles; the lab does not simulate it`);
		}
	}
	return { changes, notes };
}

/** Every change of the draft against the live texts; issues instead when the draft cannot be read. */
export function diffLab(current: LabTexts, draft: LabTexts): LabDiff {
	const diff: LabDiff = { changes: [], issues: [], notes: [] };
	let draftPools: unknown;
	try {
		draftPools = JSON.parse(draft.pools);
	} catch (error) {
		diff.issues.push(`pools.json: not readable JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (draftPools !== undefined) {
		const validated = validatePoolsConfig(draftPools);
		for (const issue of validated.issues) diff.issues.push(`pools.json ${issue.path}: ${issue.message}`);
		if (validated.valid) {
			let currentPools: unknown = null;
			try {
				currentPools = JSON.parse(current.pools);
			} catch {
				// An unreadable live file: every draft pool shows as added.
			}
			diff.changes.push(...diffPools(currentPools, draftPools));
		}
	}
	if (current.profiles !== null) {
		const before = parseProfilesText(current.profiles, LAB_PROFILES);
		if (draft.profiles === null) {
			diff.issues.push("profiles.json: the draft file is missing; run /balancer lab new to start again");
		} else {
			const after = parseProfilesText(draft.profiles, LAB_PROFILES);
			if ("error" in after) diff.issues.push(`profiles.json: ${after.error}`);
			else if ("store" in before) {
				const profiles = diffProfiles(before.store, after.store);
				diff.changes.push(...profiles.changes);
				diff.notes.push(...profiles.notes);
			}
		}
	}
	return diff;
}

export function formatLabDiff(diff: LabDiff): string {
	const lines: string[] = [];
	if (diff.issues.length) lines.push("Draft issues (fix them before applying):", ...diff.issues.map(issue => `- ${issue}`));
	if (diff.changes.length) lines.push(`Changes (${diff.changes.length}):`, ...diff.changes.map(change => `- ${change}`));
	else if (!diff.issues.length) lines.push("No changes: the draft equals the live files.");
	if (diff.notes.length) lines.push("Notes:", ...diff.notes.map(note => `- ${note}`));
	return lines.join("\n");
}

/** Role → model of the active profile; empty without one. */
export function activeRoutes(store: ProfilesStore | null): Record<string, string> {
	const routes = store && typeof store.active === "string" ? store.profiles[store.active] : undefined;
	if (!routes) return {};
	return Object.fromEntries(Object.entries(routes).flatMap(([role, route]) => (typeof route?.model === "string" ? [[role, route.model]] : [])));
}

function movedRoles(current: Record<string, string>, draft: Record<string, string>): string[] {
	return [...new Set([...Object.keys(current), ...Object.keys(draft)])]
		.filter(role => role !== ORCHESTRATOR_ROLE && draft[role] !== undefined && current[role] !== draft[role])
		.sort();
}

/**
 * The draft's pool lookup: a request whose role the draft's active profile
 * routes elsewhere follows the draft route (`pool/<id>` → that pool, a direct
 * model → outside pools); every other request keeps `poolOf`. The orchestrator
 * entry is never followed (gentle-pi applies it only on selection).
 */
export function profilePoolOf(
	poolOf: (request: HistoryEntry) => string | null,
	roleOf: (request: HistoryEntry) => string,
	current: Record<string, string>,
	draft: Record<string, string>,
): (request: HistoryEntry) => string | null {
	const moved = new Set(movedRoles(current, draft));
	return request => {
		const role = roleOf(request);
		if (!moved.has(role)) return poolOf(request);
		const route = draft[role];
		return route.startsWith("pool/") ? route.slice("pool/".length) : null;
	};
}

export interface RoleMove {
	role: string;
	from: string;
	to: string;
	requests: number;
	tokens: number;
}

export function roleMoves(
	requests: readonly HistoryEntry[],
	roleOf: (request: HistoryEntry) => string,
	current: Record<string, string>,
	draft: Record<string, string>,
): RoleMove[] {
	const moves = new Map(movedRoles(current, draft).map(role => [role, { role, from: current[role] ?? "(none)", to: draft[role], requests: 0, tokens: 0 }]));
	for (const request of requests) {
		const move = moves.get(roleOf(request));
		if (!move) continue;
		move.requests++;
		move.tokens += request.input + request.output + request.cacheRead + request.cacheWrite;
	}
	return [...moves.values()];
}

export function formatRoleMoves(moves: readonly RoleMove[]): string {
	if (moves.length === 0) return "Roles moved by the draft's active profile: none";
	return [
		"Roles moved by the draft's active profile (last 30 days):",
		...moves.map(move => `  ${move.role}: ${move.from} → ${move.to} · ${move.requests} requests, ${formatTokens(move.tokens)} tokens`),
	].join("\n");
}

/** Puts a backup's bytes back over `path` through a temp file and a rename. */
function restoreFromBackup(path: string, backup: string): void {
	const temp = `${path}.${process.pid}.restore.tmp`;
	try {
		writeFileSync(temp, readFileSync(backup), { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export function hasUndo(labDir: string): boolean {
	return existsSync(join(labDir, LAB_APPLIED));
}

export function formatApplyConfirm(diff: LabDiff): string {
	const lines: string[] = [];
	if (diff.changes.length) {
		lines.push(`Changes (${diff.changes.length}):`, ...diff.changes.map(change => `- ${change}`));
	}
	lines.push(
		"",
		"Risks and effects:",
		"1. Silent quality loss when a role moves to a cheaper model.",
		"2. Global effect: every new session of every project.",
		"3. pools.json takes effect from the next Pi start or /reload; profiles.json from new sessions only (open sessions keep their frozen profile).",
		"4. The orchestrator entry only takes effect when the profile is selected in /gentle:profiles.",
		"5. A backup of each file is kept and /balancer lab undo restores it.",
	);
	return lines.join("\n");
}

export interface ApplyDraftOptions {
	paths: LabPaths;
	dataDir: string;
	now?: number;
	hasModel(provider: string, model: string): boolean;
}

export interface AppliedFile {
	path: string;
	backup: string;
	written: string;
}

export interface ApplyDraftResult {
	files: AppliedFile[];
}

export function applyDraft(options: ApplyDraftOptions): ApplyDraftResult {
	const now = options.now ?? Date.now();
	const { paths, dataDir, hasModel } = options;

	const draft = readDraft(paths.labDir);
	if ("error" in draft) {
		throw new Error(draft.error);
	}

	let livePools: string;
	try {
		livePools = readFileSync(paths.poolsPath, "utf8");
	} catch (error) {
		throw new Error(`ai-balancer: cannot read pools.json: ${error instanceof Error ? error.message : String(error)}`);
	}

	// A draft made without a usable profiles.json holds pools only and never touches it.
	const liveProfiles = draft.base.profiles === null || !existsSync(paths.profilesPath) ? null : readFileSync(paths.profilesPath, "utf8");
	const liveTexts: LabTexts = { pools: livePools, profiles: liveProfiles };

	if (livePools !== draft.base.pools) {
		throw new Error("ai-balancer: refusing to apply: pools.json changed since the draft was created; run /balancer lab new again");
	}
	if (liveProfiles !== draft.base.profiles) {
		throw new Error("ai-balancer: refusing to apply: profiles.json changed since the draft was created; run /balancer lab new again");
	}

	const diff = diffLab(liveTexts, draft);
	if (diff.issues.length > 0) {
		throw new Error(`ai-balancer: refusing to apply: the draft has issues (${diff.issues.join("; ")})`);
	}
	if (diff.changes.length === 0) {
		throw new Error("ai-balancer: refusing to apply: the draft has no changes");
	}

	const currentCandidates = new Set<string>();
	try {
		const parsedCurrent = JSON.parse(livePools);
		for (const pool of parsedCurrent?.pools ?? []) {
			if (Array.isArray(pool?.candidates)) {
				for (const cand of pool.candidates) {
					if (typeof cand === "string") currentCandidates.add(cand);
				}
			}
		}
	} catch {
		// Ignore parse errors on live pools
	}

	const parsedDraftPools = JSON.parse(draft.pools);
	const unknownPoolCandidates: string[] = [];
	for (const pool of parsedDraftPools?.pools ?? []) {
		if (Array.isArray(pool?.candidates)) {
			for (const cand of pool.candidates) {
				if (typeof cand === "string" && !currentCandidates.has(cand)) {
					const slash = cand.indexOf("/");
					if (slash <= 0 || slash === cand.length - 1) {
						unknownPoolCandidates.push(`${cand} is not provider/model`);
					} else {
						const provider = cand.slice(0, slash);
						const model = cand.slice(slash + 1);
						if (!hasModel(provider, model)) {
							unknownPoolCandidates.push(`${cand} is not in Pi's model registry`);
						}
					}
				}
			}
		}
	}
	if (unknownPoolCandidates.length > 0) {
		throw new Error(`ai-balancer: refusing to apply pools.json: ${[...new Set(unknownPoolCandidates)].join("; ")}`);
	}

	// Structural comparison: a whitespace-only edit writes nothing.
	const sameJson = (a: string, b: string) => JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
	const poolsChanged = !sameJson(draft.pools, draft.base.pools);
	const profilesChanged = draft.profiles !== null && draft.base.profiles !== null && !sameJson(draft.profiles, draft.base.profiles);

	let draftStore: ProfilesStore | null = null;
	let baseStore: ProfilesStore | null = null;
	if (profilesChanged) {
		const parsedDraft = parseProfilesText(draft.profiles!, LAB_PROFILES);
		if ("error" in parsedDraft) {
			throw new Error(`ai-balancer: refusing to apply: ${parsedDraft.error}`);
		}
		draftStore = parsedDraft.store;
		const parsedBase = parseProfilesText(draft.base.profiles!, LAB_PROFILES);
		if ("error" in parsedBase) {
			throw new Error(`ai-balancer: refusing to apply: ${parsedBase.error}`);
		}
		baseStore = parsedBase.store;

		const unknownRoutes: string[] = [];
		for (const [profile, routes] of Object.entries(draftStore.profiles ?? {})) {
			for (const [role, route] of Object.entries(routes ?? {})) {
				const model = (route as { model?: unknown } | undefined)?.model;
				if (baseStore.profiles?.[profile]?.[role]?.model !== model) {
					const text = typeof model === "string" ? model : "";
					const slash = text.indexOf("/");
					if (slash <= 0 || slash === text.length - 1) {
						unknownRoutes.push(`${profile}.${role}: ${text} is not provider/model`);
					} else if (!hasModel(text.slice(0, slash), text.slice(slash + 1))) {
						unknownRoutes.push(`${profile}.${role}: ${text} is not in Pi's model registry`);
					}
				}
			}
		}
		if (unknownRoutes.length > 0) {
			throw new Error(`ai-balancer: refusing to write profiles.json: ${unknownRoutes.join("; ")}`);
		}
	}

	const writes: Array<{ path: string; write: () => { backup: string } }> = [];
	if (profilesChanged) {
		writes.push({
			path: paths.profilesPath,
			write: () => saveProfilesStore(draftStore!, { store: baseStore!, raw: draft.base.profiles! }, { path: paths.profilesPath, now, hasModel }),
		});
	}
	if (poolsChanged) writes.push({ path: paths.poolsPath, write: () => replaceFileSafely(paths.poolsPath, draft.pools, draft.base.pools, now) });

	const writtenFiles: AppliedFile[] = [];
	for (const { path, write } of writes) {
		try {
			const { backup } = write();
			writtenFiles.push({ path, backup, written: readFileSync(path, "utf8") });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (writtenFiles.length === 0) throw error;
			const restored: string[] = [];
			const failed: string[] = [];
			for (const done of writtenFiles) {
				try {
					restoreFromBackup(done.path, done.backup);
					restored.push(basename(done.path));
				} catch (restoreError) {
					failed.push(`${basename(done.path)} (restore it from ${done.backup}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)})`);
				}
			}
			const outcome = [restored.length ? `restored ${restored.join(", ")} from its backup` : "", failed.length ? `could NOT restore ${failed.join(", ")}` : ""].filter(Boolean).join("; ");
			throw new Error(`ai-balancer: apply failed writing ${basename(path)} (${reason}); ${outcome}`);
		}
	}

	mkdirSync(paths.labDir, { recursive: true, mode: 0o700 });
	const appliedPath = join(paths.labDir, LAB_APPLIED);
	writeFileSync(appliedPath, `${JSON.stringify({ ts: now, files: writtenFiles }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(appliedPath, 0o600);

	const auditPath = join(dataDir, "audit.jsonl");
	const auditRow = JSON.stringify({
		ts: now,
		action: "lab-apply",
		by: "pi",
		files: writtenFiles.map(f => ({ path: f.path, backup: f.backup })),
	});
	appendFileSync(auditPath, `${auditRow}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(auditPath, 0o600);

	discardDraft(paths.labDir);

	return { files: writtenFiles };
}

export interface UndoApplyOptions {
	labDir: string;
	dataDir: string;
	now?: number;
}

export interface UndoApplyResult {
	/** `restoredFrom`: the apply backup put back; `backup`: the new backup of the applied text. */
	files: Array<{ path: string; restoredFrom: string; backup: string }>;
}

export function undoApply(options: UndoApplyOptions): UndoApplyResult {
	const now = options.now ?? Date.now();
	const { labDir, dataDir } = options;
	const appliedPath = join(labDir, LAB_APPLIED);

	if (!existsSync(appliedPath)) {
		throw new Error("ai-balancer: nothing to undo");
	}

	let applied: { ts: number; files: AppliedFile[] };
	try {
		applied = JSON.parse(readFileSync(appliedPath, "utf8"));
	} catch (error) {
		throw new Error(`ai-balancer: cannot read ${LAB_APPLIED}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!Array.isArray(applied.files) || applied.files.length === 0) {
		throw new Error("ai-balancer: nothing to undo");
	}

	for (const file of applied.files) {
		if (!existsSync(file.path)) {
			throw new Error(`ai-balancer: refusing to undo: ${file.path} not found; nothing undone`);
		}
		const currentText = readFileSync(file.path, "utf8");
		if (currentText !== file.written) {
			throw new Error(`ai-balancer: refusing to undo: ${file.path} changed since it was applied; nothing undone`);
		}
		if (!existsSync(file.backup)) {
			throw new Error(`ai-balancer: refusing to undo: backup ${file.backup} not found; nothing undone`);
		}
	}

	const restored: UndoApplyResult["files"] = [];
	for (const file of applied.files) {
		const backupText = readFileSync(file.backup, "utf8");
		const result = replaceFileSafely(file.path, backupText, file.written, now);
		restored.push({ path: file.path, restoredFrom: file.backup, backup: result.backup });
	}

	rmSync(appliedPath, { force: true });

	const auditPath = join(dataDir, "audit.jsonl");
	const auditRow = JSON.stringify({
		ts: now,
		action: "lab-undo",
		by: "pi",
		files: restored,
	});
	appendFileSync(auditPath, `${auditRow}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(auditPath, 0o600);

	return { files: restored };
}
