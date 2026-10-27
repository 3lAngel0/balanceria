import type { Project } from "./api.ts";

const HOUR_MS = 60 * 60_000;

export interface Summary {
	projects: number;
	sessions: number;
	activeLastHour: number;
}

/** Projects, sessions, and projects with activity in the last hour. */
export function summarize(projects: readonly Project[], now: number = Date.now()): Summary {
	return {
		projects: projects.length,
		sessions: projects.reduce((sum, p) => sum + p.sessions, 0),
		activeLastHour: projects.filter(p => now - p.lastActivity <= HOUR_MS).length,
	};
}

export interface RecentSession {
	id: string;
	title: string | null;
	cwd: string;
	lastActivity: number;
}

/** Each project's newest session, newest first, at most `limit`. */
export function recentSessions(projects: readonly Project[], limit: number): RecentSession[] {
	return [...projects]
		.sort((a, b) => b.lastActivity - a.lastActivity)
		.slice(0, limit)
		.map(p => ({ id: p.latest.id, title: p.latest.title, cwd: p.cwd ?? p.dir, lastActivity: p.lastActivity }));
}
