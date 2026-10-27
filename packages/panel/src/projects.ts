import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findSessionFile, readFirstUserMessage, clipAlias } from "../../../src/session-index.ts";
import { readSessionCwd, resumeCommand } from "../../../src/web-data.ts";

// The panel's view of every project Pi has worked in. Pi keeps one directory
// per working directory under the sessions root, one <iso>_<id>.jsonl per
// session. Only file names, mtimes and the head of the newest file are read;
// anything unreadable is skipped, never fatal.

export const REMOTE_TTL_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 2000;

export interface PanelProject {
	/** The directory under the sessions root. */
	dir: string;
	/** The working directory from the newest session's header; null when unreadable. */
	cwd: string | null;
	sessions: number;
	/** Newest session file mtime, ms. */
	lastActivity: number;
	latest: { id: string; title: string | null };
	/** `https://github.com/<owner>/<repo>` from the cwd's origin remote, or null. */
	github: string | null;
}

export interface PanelSession {
	id: string;
	cwd: string | null;
	title: string | null;
	file: string;
	resume: string | null;
}

const NAME = /^[A-Za-z0-9._-]+$/;

/** A GitHub origin remote as its https page; null for anything else. Credentials are dropped. */
export function githubUrl(remote: string): string | null {
	const text = remote.trim();
	const scp = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(text);
	let parts: [string, string] | undefined = scp ? [scp[1]!, scp[2]!] : undefined;
	if (!parts) {
		try {
			const url = new URL(text);
			const path = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
			if (["https:", "ssh:", "git:"].includes(url.protocol) && url.hostname === "github.com" && path) parts = [path[1]!, path[2]!];
		} catch {
			return null;
		}
	}
	if (!parts || !parts.every(part => NAME.test(part) && part !== "." && part !== "..")) return null;
	return `https://github.com/${parts[0]}/${parts[1]}`;
}

/** The cwd's `origin` remote, raw; null when there is none or git is missing. */
export function gitOrigin(cwd: string): string | null {
	if (!existsSync(cwd)) return null;
	try {
		return execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return null;
	}
}

/** GitHub URL per cwd, asking git at most once per cwd every 5 minutes. */
export function cachedGithub(origin: (cwd: string) => string | null = gitOrigin, now: () => number = Date.now): (cwd: string) => string | null {
	const cache = new Map<string, { at: number; url: string | null }>();
	return cwd => {
		const hit = cache.get(cwd);
		if (hit && now() - hit.at < REMOTE_TTL_MS) return hit.url;
		const remote = origin(cwd);
		const url = remote === null ? null : githubUrl(remote);
		cache.set(cwd, { at: now(), url });
		return url;
	};
}

const sessionId = (file: string) => file.slice(file.lastIndexOf("_") + 1, -".jsonl".length);
const title = (path: string) => {
	const text = readFirstUserMessage(path);
	return text === null ? null : clipAlias(text);
};

export function listProjects(root: string, github: (cwd: string) => string | null): PanelProject[] {
	let dirs: string[];
	try {
		dirs = readdirSync(root);
	} catch {
		return [];
	}
	const projects: PanelProject[] = [];
	for (const dir of dirs) {
		let newest: { file: string; mtime: number } | undefined;
		let count = 0;
		try {
			for (const file of readdirSync(join(root, dir))) {
				if (!file.endsWith(".jsonl") || !file.includes("_")) continue;
				const mtime = statSync(join(root, dir, file)).mtimeMs;
				count++;
				if (!newest || mtime > newest.mtime) newest = { file, mtime };
			}
		} catch {
			continue;
		}
		if (!newest) continue;
		const path = join(root, dir, newest.file);
		const cwd = readSessionCwd(path);
		projects.push({
			dir,
			cwd,
			sessions: count,
			lastActivity: newest.mtime,
			latest: { id: sessionId(newest.file), title: title(path) },
			github: cwd === null ? null : github(cwd),
		});
	}
	return projects.sort((a, b) => b.lastActivity - a.lastActivity);
}

export function sessionDetail(root: string, id: string): PanelSession | undefined {
	const file = findSessionFile(root, id);
	if (!file) return undefined;
	const cwd = readSessionCwd(file);
	return { id, cwd, title: title(file), file, resume: resumeCommand(cwd, file) };
}
