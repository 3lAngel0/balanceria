import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { sessionId as validateSessionId } from "../../../src/web-server.ts";

export const TRASH_MAX_AGE_DAYS = 10;
const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrashedSession {
	sessionId: string;
	project: string;
	date: string;
	filename: string;
	relativePath: string;
	path: string;
}

export interface SessionLocation {
	project: string;
	filename: string;
	path: string;
}

/** Finds `<root>/<project>/<date>_<sessionId>.jsonl` across all projects in the sessions root. */
export function findSessionLocation(root: string, id: string): SessionLocation | null {
	const safeId = validateSessionId(id);
	if (!safeId || !existsSync(root)) return null;
	const suffix = `_${safeId}.jsonl`;
	for (const project of readdirSync(root)) {
		const projectDir = join(root, project);
		try {
			if (!statSync(projectDir).isDirectory()) continue;
			for (const file of readdirSync(projectDir)) {
				if (file.endsWith(suffix)) {
					return { project, filename: file, path: join(projectDir, file) };
				}
			}
		} catch {
			continue;
		}
	}
	return null;
}

function formatDate(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export interface DeleteSessionOptions {
	root: string;
	dataDir: string;
	sessionId: string;
	now?: number;
}

export interface DeleteSessionResult {
	ok: boolean;
	message?: string;
	trashedPath?: string;
	relativePath?: string;
}

/**
 * Moves a session file to `data/trash/<YYYY-MM-DD>/<project>/<session>.jsonl`
 * and prunes trash entries older than 10 days.
 */
export function deleteSessionToTrash(options: DeleteSessionOptions): DeleteSessionResult {
	const loc = findSessionLocation(options.root, options.sessionId);
	if (!loc) return { ok: false, message: `session "${options.sessionId}" not found` };

	const now = options.now ?? Date.now();
	const dateStr = formatDate(now);
	const destDir = join(options.dataDir, "trash", dateStr, loc.project);
	mkdirSync(destDir, { recursive: true });

	const destFile = join(destDir, loc.filename);
	try {
		renameSync(loc.path, destFile);
	} catch (error) {
		return { ok: false, message: `failed to move session to trash: ${error instanceof Error ? error.message : String(error)}` };
	}

	pruneTrash(options.dataDir, now, TRASH_MAX_AGE_DAYS);

	const relativePath = `${dateStr}/${loc.project}/${loc.filename}`;
	return { ok: true, trashedPath: destFile, relativePath };
}

/**
 * Removes trash date folders older than `maxAgeDays`. Returns the pruned folder names.
 */
export function pruneTrash(dataDir: string, now = Date.now(), maxAgeDays = TRASH_MAX_AGE_DAYS): string[] {
	const trashRoot = join(dataDir, "trash");
	if (!existsSync(trashRoot)) return [];

	const pruned: string[] = [];
	for (const entry of readdirSync(trashRoot)) {
		if (!DATE_FOLDER_RE.test(entry)) continue;
		const folderDate = new Date(`${entry}T00:00:00Z`).getTime();
		if (Number.isNaN(folderDate)) continue;

		const ageDays = (now - folderDate) / DAY_MS;
		if (ageDays > maxAgeDays) {
			const folderPath = join(trashRoot, entry);
			try {
				rmSync(folderPath, { recursive: true, force: true });
				pruned.push(entry);
			} catch {
				// Retain on error
			}
		}
	}
	return pruned;
}

/**
 * Lists all trashed sessions, sorted newest date first.
 */
export function listTrash(dataDir: string): TrashedSession[] {
	const trashRoot = join(dataDir, "trash");
	if (!existsSync(trashRoot)) return [];

	const items: TrashedSession[] = [];
	const dateFolders = readdirSync(trashRoot)
		.filter(d => DATE_FOLDER_RE.test(d))
		.sort()
		.reverse();

	for (const date of dateFolders) {
		const datePath = join(trashRoot, date);
		try {
			if (!statSync(datePath).isDirectory()) continue;
			for (const project of readdirSync(datePath)) {
				const projectPath = join(datePath, project);
				if (!statSync(projectPath).isDirectory()) continue;
				for (const filename of readdirSync(projectPath)) {
					if (!filename.endsWith(".jsonl")) continue;
					const match = /_([^.]+)\.jsonl$/.exec(filename);
					const sessionId = match ? match[1]! : filename;
					const relativePath = `${date}/${project}/${filename}`;
					items.push({
						sessionId,
						project,
						date,
						filename,
						relativePath,
						path: join(projectPath, filename),
					});
				}
			}
		} catch {
			continue;
		}
	}
	return items;
}

export interface RestoreSessionOptions {
	root: string;
	dataDir: string;
	trashRelativePath: string;
}

/**
 * Restores a session from trash back into the project's folder under `root`.
 */
export function restoreSessionFromTrash(options: RestoreSessionOptions): { ok: boolean; message?: string; restoredPath?: string } {
	const safeRel = normalize(options.trashRelativePath).replace(/^[/\\]+/, "");
	if (safeRel.includes("..")) return { ok: false, message: "invalid path traversal" };

	const parts = safeRel.split(/[/\\]/);
	if (parts.length !== 3) return { ok: false, message: "invalid trash relative path structure" };

	const [_date, project, filename] = parts as [string, string, string];
	const trashPath = join(options.dataDir, "trash", safeRel);
	if (!existsSync(trashPath)) return { ok: false, message: "trash file does not exist" };

	const targetDir = join(options.root, project);
	mkdirSync(targetDir, { recursive: true });
	const targetPath = join(targetDir, filename);

	try {
		renameSync(trashPath, targetPath);
		// Clean up empty project directory in trash
		try {
			const projectTrashDir = dirname(trashPath);
			if (readdirSync(projectTrashDir).length === 0) {
				rmSync(projectTrashDir, { recursive: true, force: true });
			}
		} catch {
			// Non-critical cleanup
		}
		return { ok: true, restoredPath: targetPath };
	} catch (error) {
		return { ok: false, message: `restore failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export interface CompactSessionOptions {
	sessionPath: string;
	rpcRunner?: (sessionPath: string) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Compacts a session. If no custom rpcRunner is provided, spawns `pi --mode rpc --session <path>`
 * and sends `{"type":"compact"}` to execute compaction offline.
 */
export function compactSession(options: CompactSessionOptions): Promise<{ ok: boolean; message: string }> {
	if (options.rpcRunner) {
		return options.rpcRunner(options.sessionPath).then(res => ({
			ok: res.ok,
			message: res.message ?? (res.ok ? "compacted successfully" : "compact failed"),
		}));
	}

	return new Promise(resolve => {
		const child = execFile(
			"pi",
			["--mode", "rpc", "--session", options.sessionPath],
			{ timeout: 60_000, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error) {
					resolve({ ok: false, message: `compaction process failed: ${error.message}${stderr ? ` (${stderr.trim()})` : ""}` });
					return;
				}
				resolve({ ok: true, message: "compaction completed" });
			},
		);

		// Send compact command and exit
		child.stdin?.write(JSON.stringify({ id: "compact-1", type: "compact" }) + "\n");
		child.stdin?.end();
	});
}

export interface LiveSessionManager {
	isLive(sessionId: string): boolean;
	cancel(sessionId: string): Promise<boolean>;
}

/**
 * Cancels a running session. Live sessions are cancelled via the live manager;
 * offline sessions cannot be cancelled.
 */
export async function cancelSession(sessionId: string, liveManager?: LiveSessionManager): Promise<{ ok: boolean; message: string }> {
	if (!liveManager || !liveManager.isLive(sessionId)) {
		return { ok: false, message: "session is not running" };
	}
	const cancelled = await liveManager.cancel(sessionId);
	return {
		ok: cancelled,
		message: cancelled ? "session cancelled" : "failed to cancel session",
	};
}
