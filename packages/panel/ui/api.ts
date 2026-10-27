import type { WebDecision, WebDecisions } from "../../../src/web-data.ts";
import type { Layout } from "../src/layout-model.ts";
import type { PoolsConfig } from "./rules.ts";

// Same-origin calls to the panel server; the token travels in its HttpOnly cookie.

export interface Project {
	dir: string;
	cwd: string | null;
	sessions: number;
	lastActivity: number;
	latest: { id: string; title: string | null };
	github: string | null;
}

export interface TokenSeries {
	provider: string;
	total: number;
	daily: number[];
}

export interface QuotaSeries {
	limit: string;
	window: string;
	peak: number | null;
	fills: number;
	daily: (number | null)[];
}

export interface Usage {
	days: string[];
	tokens: TokenSeries[];
	quota: QuotaSeries[];
}

/** One routing decision: the pool, the role, the chosen provider and why. */
export type Decision = WebDecision;
/** Counts over every decision in the history, detail for the newest 50. */
export type Decisions = WebDecisions;

export interface Alert {
	id: string;
	level: "info" | "warning" | "error";
	title: string;
	message: string;
	source: "quota" | "context" | "session" | "loan" | "circuit_breaker";
	timestamp: number;
}

export interface Report {
	generatedAt: number;
	projects: Project[];
	usage: Usage;
	decisions: Decisions;
	alerts?: Alert[];
}

async function json<T>(res: Response): Promise<T> {
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (await res.json()) as T;
}

export function fetchReport(): Promise<Report> {
	return fetch("/api/report", { credentials: "same-origin", cache: "no-store" }).then(res => json<Report>(res));
}

export function fetchLayout(): Promise<Layout> {
	return fetch("/api/layout", { credentials: "same-origin", cache: "no-store" }).then(res => json<{ layout: Layout }>(res)).then(body => body.layout);
}

/** Saves the layout; rejects with the server's message when it is refused. */
export async function saveLayout(layout: Layout): Promise<Layout> {
	const res = await fetch("/api/layout", {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(layout),
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; layout?: Layout };
	if (!res.ok || !body.ok || !body.layout) throw new Error(body.message ?? `HTTP ${res.status}`);
	return body.layout;
}

export interface LabDraft {
	createdAt: number;
	pools: PoolsConfig | null;
	issues: string[];
	changes: string[];
	version: string;
}

export function fetchLab(): Promise<LabDraft | null> {
	return fetch("/api/lab", { credentials: "same-origin", cache: "no-store" })
		.then(res => json<{ draft?: LabDraft | null; error?: string }>(res))
		.then(body => {
			if (body.error) throw new Error(body.error);
			return body.draft ?? null;
		});
}

/** Saves the draft pools; rejects with the server's message when it is refused. */
export async function saveLabDraftPools(version: string, pools: PoolsConfig): Promise<LabDraft> {
	const res = await fetch("/api/lab/pools", {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ version, pools }),
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; draft?: LabDraft };
	if (!res.ok || !body.ok || !body.draft) throw new Error(body.message ?? `HTTP ${res.status}`);
	return body.draft;
}

export interface TrashedItem {
	sessionId: string;
	project: string;
	date: string;
	filename: string;
	relativePath: string;
}

export async function compactSession(sessionId: string): Promise<{ ok: boolean; message: string }> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/compact`, {
		method: "POST",
		credentials: "same-origin",
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
	if (!res.ok || !body.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
	return { ok: true, message: body.message ?? "compacted" };
}

export async function cancelSession(sessionId: string): Promise<{ ok: boolean; message: string }> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {
		method: "POST",
		credentials: "same-origin",
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
	if (!res.ok || !body.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
	return { ok: true, message: body.message ?? "cancelled" };
}

export async function deleteSession(sessionId: string): Promise<{ ok: boolean; message?: string; relativePath?: string }> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/delete`, {
		method: "POST",
		credentials: "same-origin",
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; relativePath?: string };
	if (!res.ok || !body.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
	return body;
}

export async function fetchTrash(): Promise<TrashedItem[]> {
	const res = await fetch("/api/trash", { credentials: "same-origin", cache: "no-store" });
	const body = (await res.json().catch(() => ({}))) as { trash?: TrashedItem[] };
	if (!res.ok || !Array.isArray(body.trash)) throw new Error(`HTTP ${res.status}`);
	return body.trash;
}

export async function restoreTrash(relativePath: string): Promise<{ ok: boolean; message?: string }> {
	const res = await fetch("/api/trash/restore", {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ relativePath }),
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
	if (!res.ok || !body.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
	return body;
}

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

export interface ProfilesView {
	profiles: ProfilesStore | null;
	raw: string;
	error?: string;
}

export interface ProfilesSaveResult {
	ok: boolean;
	backup?: string;
	profiles: ProfilesStore;
	raw: string;
}

export async function fetchProfiles(): Promise<ProfilesView> {
	const res = await fetch("/api/profiles", { credentials: "same-origin", cache: "no-store" });
	const body = (await res.json().catch(() => ({}))) as ProfilesView;
	if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
	return body;
}

export async function saveProfiles(profiles: ProfilesStore, raw: string): Promise<ProfilesSaveResult> {
	const res = await fetch("/api/profiles", {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ profiles, raw }),
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; backup?: string; profiles?: ProfilesStore; raw?: string };
	if (!res.ok || !body.ok || !body.profiles || !body.raw) throw new Error(body.message ?? `HTTP ${res.status}`);
	return { ok: true, backup: body.backup, profiles: body.profiles, raw: body.raw };
}

export function fetchAlerts(): Promise<Alert[]> {
	return fetch("/api/alerts", { credentials: "same-origin", cache: "no-store" })
		.then(res => json<{ alerts: Alert[] }>(res))
		.then(body => body.alerts ?? []);
}

export interface DetectedProviderUi {
	id: string;
	label: string;
	kind: string;
	detected: boolean;
	source: string;
	availableModels: string[];
}

export interface PoolConfigUi {
	id: string;
	name: string;
	candidates: string[];
	strategy?: string;
}

export interface EffectiveRoleRowUi {
	role: string;
	shortName: string;
	category: "read" | "write" | "audit" | "orchestrate";
	purpose: string;
	configuredModel: string;
	thinking: string;
	effectiveTarget: string;
}

export interface AdvisorRecommendationUi {
	role: string;
	category: string;
	purpose: string;
	recommendedModel: string;
	thinking: string;
	reason: string;
}

export interface AdvisorReportUi {
	source: string;
	estimatedTokens: number;
	summary: string;
	recommendations: AdvisorRecommendationUi[];
}

export interface SetupViewUi {
	providers: DetectedProviderUi[];
	pools: PoolConfigUi[];
	activeProfile: string | null;
	roles: Record<string, { model: string; thinking?: string }>;
	roleRows: EffectiveRoleRowUi[];
	availableTargets: string[];
	advisor: AdvisorReportUi;
}

export async function fetchSetup(): Promise<SetupViewUi> {
	const res = await fetch("/api/setup", { credentials: "same-origin", cache: "no-store" });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (await res.json()) as SetupViewUi;
}

export async function saveSetupAction(action: unknown): Promise<{ ok: boolean; setup?: SetupViewUi; advisor?: AdvisorReportUi; message?: string }> {
	const res = await fetch("/api/setup", {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(action),
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; setup?: SetupViewUi; advisor?: AdvisorReportUi };
	if (!res.ok || !body.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
	return body;
}
