import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "./pools.ts";
import type { ProfilesStore } from "./profiles.ts";

// Permission levels for changes the balancer may make on its own (design
// §10). A grant is given from Pi only, never from the web: it names the
// profiles, roles and interchangeable models it covers, and it expires.
// Without a matching, unexpired grant the level is "off" (show only).

export const PERMISSIONS_FILE = "permissions.json";
export const AUDIT_FILE = "audit.jsonl";

export type PermissionLevel = "off" | "suggest" | "auto";

export interface Grant {
	id: string;
	level: "suggest" | "auto";
	profiles: string[];
	roles: string[];
	/** Models the grant treats as interchangeable, as `provider/model` or `pool/<id>`. */
	models: string[];
	grantedAt: number;
	expiresAt: number;
}

export interface PermissionRequest {
	profile: string;
	role: string;
	from: string;
	to: string;
}

export interface Permission {
	level: PermissionLevel;
	grant?: Grant;
}

const RANK: Record<PermissionLevel, number> = { off: 0, suggest: 1, auto: 2 };

/** The highest level among unexpired grants that cover the request; "off" otherwise. */
export function permissionFor(grants: readonly Grant[], request: PermissionRequest, now: number): Permission {
	let best: Permission = { level: "off" };
	if (request.from === request.to) return best;
	for (const grant of grants) {
		if (grant.expiresAt <= now) continue;
		if (!grant.profiles.includes(request.profile) || !grant.roles.includes(request.role)) continue;
		if (!grant.models.includes(request.from) || !grant.models.includes(request.to)) continue;
		if (RANK[grant.level] > RANK[best.level]) best = { level: grant.level, grant };
	}
	return best;
}

function names(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	if (!value.every(item => typeof item === "string" && item.length > 0 && !item.includes("*"))) return undefined;
	return [...value] as string[];
}

function parseGrant(value: unknown): Grant | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const profiles = names(raw.profiles);
	const roles = names(raw.roles);
	const models = names(raw.models);
	const { id, level, grantedAt, expiresAt } = raw;
	if (typeof id !== "string" || id.length === 0) return undefined;
	if (level !== "suggest" && level !== "auto") return undefined;
	if (!profiles || !roles || !models) return undefined;
	if (typeof grantedAt !== "number" || !Number.isFinite(grantedAt)) return undefined;
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= grantedAt) return undefined;
	return { id, level, profiles, roles, models, grantedAt, expiresAt };
}

export interface LoadedPermissions {
	grants: Grant[];
	/** Set when the file exists but cannot be used; its grants then count as none. */
	error?: string;
}

/** Missing file: no grants. Unreadable or unknown file: no grants and an error. Malformed grants are dropped. */
export function loadPermissions(dataDir: string): LoadedPermissions {
	const file = join(dataDir, PERMISSIONS_FILE);
	if (!existsSync(file)) return { grants: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { grants: [], error: `${PERMISSIONS_FILE} is not readable JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	const store = parsed as { version?: unknown; grants?: unknown } | null;
	if (!store || typeof store !== "object" || store.version !== 1 || !Array.isArray(store.grants)) {
		return { grants: [], error: `${PERMISSIONS_FILE} is not a version 1 permissions file` };
	}
	return { grants: store.grants.map(parseGrant).filter((grant): grant is Grant => grant !== undefined) };
}

function writeGrants(dataDir: string, grants: readonly Grant[]): void {
	mkdirSync(dataDir, { recursive: true });
	const temporary = join(dataDir, `${PERMISSIONS_FILE}.${process.pid}.tmp`);
	writeFileSync(temporary, `${JSON.stringify({ version: 1, grants }, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, join(dataDir, PERMISSIONS_FILE));
}

function appendAudit(dataDir: string, ts: number, action: "grant" | "revoke" | "expire", grants: readonly Grant[]): void {
	if (grants.length === 0) return;
	const lines = grants.map(grant => JSON.stringify({ ts, action, by: "pi", grant })).join("\n");
	appendFileSync(join(dataDir, AUDIT_FILE), `${lines}\n`, { encoding: "utf8", mode: 0o600 });
}

function loadForWrite(dataDir: string): Grant[] {
	const loaded = loadPermissions(dataDir);
	if (loaded.error) throw new Error(`ai-balancer: ${loaded.error}; fix or remove ${join(dataDir, PERMISSIONS_FILE)} first`);
	return loaded.grants;
}

/** Stores a new grant and audits it. Throws, writing nothing, on an invalid draft or an unusable file. */
export function addGrant(dataDir: string, draft: Omit<Grant, "id" | "grantedAt">, now: number): Grant {
	const grant = parseGrant({ ...draft, id: `g-${now.toString(36)}-${randomBytes(3).toString("hex")}`, grantedAt: now });
	if (!grant) throw new Error("ai-balancer: invalid grant: level suggest|auto, nonempty explicit profiles, roles and models, expiry in the future");
	const grants = loadForWrite(dataDir);
	writeGrants(dataDir, [...grants, grant]);
	appendAudit(dataDir, now, "grant", [grant]);
	return grant;
}

/** Removes the grant with `id`, or every grant with "all"; returns what it removed. */
export function revokeGrants(dataDir: string, id: string, now: number): Grant[] {
	const grants = loadForWrite(dataDir);
	const removed = grants.filter(grant => id === "all" || grant.id === id);
	if (removed.length === 0) return [];
	writeGrants(dataDir, grants.filter(grant => !removed.includes(grant)));
	appendAudit(dataDir, now, "revoke", removed);
	return removed;
}

/** Removes grants at or past their expiry; an unusable file is left as it is. */
export function pruneExpired(dataDir: string, now: number): Grant[] {
	const loaded = loadPermissions(dataDir);
	if (loaded.error) return [];
	const expired = loaded.grants.filter(grant => grant.expiresAt <= now);
	if (expired.length === 0) return [];
	writeGrants(dataDir, loaded.grants.filter(grant => grant.expiresAt > now));
	appendAudit(dataDir, now, "expire", expired);
	return expired;
}

const minute = (ts: number) => `${new Date(ts).toISOString().slice(0, 16)}Z`;

export function formatGrants(grants: readonly Grant[], now: number): string {
	if (grants.length === 0) return "ai-balancer: no grants yet. A grant is your permission for the balancer to use another model for a role (level off: show only). Create one with /balancer permissions grant";
	const lines = grants.map(grant => {
		const expiry = grant.expiresAt > now ? `expires ${minute(grant.expiresAt)}` : `expired ${minute(grant.expiresAt)}`;
		return `  ${grant.id} · ${grant.level} · profiles ${grant.profiles.join(", ")} · roles ${grant.roles.join(", ")} · models ${grant.models.join(", ")} · ${expiry}`;
	});
	return ["ai-balancer grants, your permissions for using another model in a role (revoke with /balancer permissions revoke <id>|all):", ...lines].join("\n");
}

export interface ModelGroup {
	label: string;
	models: string[];
}

/** One suggested interchangeable group per pool: the pool model and its candidates (D4). */
export function suggestModelGroups(pools: readonly Pool[]): ModelGroup[] {
	return pools.map(pool => {
		const models = [`pool/${pool.id}`, ...pool.candidates.map(candidate => `${candidate.provider}/${candidate.model}`)];
		return { label: `${pool.id}: ${models.join(", ")}`, models };
	});
}

export interface PermissionUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface PermissionGrantDeps {
	ui: PermissionUI;
	profiles: ProfilesStore | null;
	pools: readonly Pool[];
	now: number;
}

const LEVELS = [
	{ level: "suggest", label: "suggest — every change needs your confirmation" },
	{ level: "auto", label: "auto — loans apply on their own within this scope" },
] as const;

const EXPIRIES = [
	{ label: "1 hour", ms: 3_600_000 },
	{ label: "8 hours", ms: 8 * 3_600_000 },
	{ label: "24 hours", ms: 24 * 3_600_000 },
	{ label: "7 days", ms: 7 * 24 * 3_600_000 },
];

export const GRANT_RISKS = [
	"1. Quality: a critical role moved to a cheaper model can lose quality silently. Run /balancer simulate first.",
	"2. Global effect: a profile change reaches every new session of every project that uses the profile.",
	"3. profiles.json belongs to gentle-pi: the balancer refuses to write a file with an unknown kind or version.",
	"4. Unknown model: a model is checked against Pi's model registry before it is saved.",
	"5. Concurrent writers: a write is refused when another writer changed the file since it was read, and every write is atomic.",
];

/** Picks several items one at a time; "done" appears once one is chosen. Undefined when cancelled. */
async function pickSeveral(ui: PermissionUI, title: string, options: readonly string[]): Promise<string[] | undefined> {
	const chosen: string[] = [];
	for (;;) {
		const remaining = options.filter(option => !chosen.includes(option));
		if (remaining.length === 0) return chosen;
		const picked = await ui.select(`${title}${chosen.length ? ` (chosen: ${chosen.length})` : ""}`, chosen.length ? ["done", ...remaining] : [...remaining]);
		if (picked === undefined) return undefined;
		if (picked === "done") return chosen;
		chosen.push(picked);
	}
}

/** The `/balancer permissions grant` wizard. Returns the confirmed draft, or undefined when cancelled. */
export async function runPermissionGrant(deps: PermissionGrantDeps): Promise<Omit<Grant, "id" | "grantedAt"> | undefined> {
	const { ui, profiles, pools, now } = deps;
	const profileNames = Object.keys(profiles?.profiles ?? {}).sort();
	if (profileNames.length === 0) {
		ui.notify("ai-balancer: no profiles in profiles.json; create one with /gentle:profiles first", "error");
		return undefined;
	}
	const groups = suggestModelGroups(pools);
	if (groups.length === 0) {
		ui.notify("ai-balancer: no pools in pools.json; run /balancer setup first", "error");
		return undefined;
	}

	const levelLabel = await ui.select("Permission level (1/5): who decides when a role falls back to another model", LEVELS.map(entry => entry.label));
	const level = LEVELS.find(entry => entry.label === levelLabel)?.level;
	if (!level) return undefined;

	const profileOptions = profileNames.map(name => (name === profiles?.active ? `${name} (active)` : name));
	const profileLabel = await ui.select("Profile the grant covers (2/5)", profileOptions);
	const profile = profileNames[profileOptions.indexOf(profileLabel ?? "")];
	if (!profile) return undefined;
	const routes = profiles?.profiles[profile] ?? {};

	const roles = await pickSeveral(ui, `Roles of ${profile} (3/5)`, Object.keys(routes).sort());
	if (!roles || roles.length === 0) return undefined;

	const groupLabels = await pickSeveral(ui, "Interchangeable models (4/5): the models a role may fall back to", groups.map(group => group.label));
	if (!groupLabels || groupLabels.length === 0) return undefined;
	const models = [...new Set(groupLabels.flatMap(label => groups.find(group => group.label === label)?.models ?? []))];

	const expiryLabel = await ui.select("Expires after (5/5)", EXPIRIES.map(entry => entry.label));
	const expiry = EXPIRIES.find(entry => entry.label === expiryLabel);
	if (!expiry) return undefined;
	const expiresAt = now + expiry.ms;

	const outside = roles
		.filter(role => !models.includes(routes[role]?.model ?? ""))
		.map(role => `  ${role} uses ${routes[role]?.model ?? "no model"}, outside the selected models: this grant never moves it.`);
	const message = [
		`Level ${level} · profile ${profile} · roles ${roles.join(", ")}`,
		`Models ${models.join(", ")}`,
		`Expires ${minute(expiresAt)} (${expiry.label}); revoke any time with /balancer permissions revoke`,
		...(outside.length ? ["", "Note:", ...outside] : []),
		"",
		"Risks:",
		...GRANT_RISKS,
	].join("\n");
	if (!(await ui.confirm(`Grant ${level} permission?`, message))) return undefined;
	return { level, profiles: [profile], roles, models, expiresAt };
}
