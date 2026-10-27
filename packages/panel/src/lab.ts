import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validatePoolsConfig } from "../../../src/config-schema.ts";
import { diffLab, hasDraft, LAB_POOLS, readDraft } from "../../../src/lab.ts";

// The lab draft's pools.json as the panel's rule editor sees it. The panel
// reads the draft and rewrites its pools.json only; starting, applying, undoing
// and discarding a draft stay in Pi (/balancer lab), so the live pools.json is
// never written here. Reading never throws.

export interface LabPanelPaths {
	labDir: string;
	/** The live pools.json, for the diff. */
	poolsPath: string;
}

export interface LabView {
	createdAt: number;
	/** The draft pools, or null when its text is not JSON. */
	pools: unknown;
	/** Why apply would refuse the draft pools; empty when they are valid. */
	issues: string[];
	/** What the draft changes against the live pools.json. */
	changes: string[];
	/** sha256 of the draft pools text; a save must send it back. */
	version: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function readLabView(paths: LabPanelPaths): { draft: LabView | null } | { error: string } {
	try {
		if (!hasDraft(paths.labDir)) return { draft: null };
		const draft = readDraft(paths.labDir);
		if ("error" in draft) return { error: draft.error };
		let live: string;
		try {
			live = readFileSync(paths.poolsPath, "utf8");
		} catch (error) {
			return { error: `cannot read pools.json: ${(error as NodeJS.ErrnoException).code ?? String(error)}` };
		}
		let pools: unknown = null;
		try {
			pools = JSON.parse(draft.pools);
		} catch {
			// diffLab reports the unreadable text as an issue.
		}
		const diff = diffLab({ pools: live, profiles: null }, { pools: draft.pools, profiles: null });
		return { draft: { createdAt: draft.base.createdAt, pools, issues: diff.issues, changes: diff.changes, version: sha256(draft.pools) } };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Rewrites the draft pools.json (0600, temp + rename) when the draft is unchanged since `version` and the pools are valid; else writes nothing. */
export function saveLabPools(paths: LabPanelPaths, body: unknown): { status: number; body: unknown } {
	const request = body as { version?: unknown; pools?: unknown } | null;
	if (typeof request !== "object" || request === null || Array.isArray(request) || typeof request.version !== "string" || !("pools" in request)) {
		return { status: 400, body: { ok: false, message: "send {version, pools}" } };
	}
	if (!hasDraft(paths.labDir)) return { status: 409, body: { ok: false, message: "start a draft with /balancer lab new in Pi" } };
	const draft = readDraft(paths.labDir);
	if ("error" in draft) return { status: 409, body: { ok: false, message: draft.error } };
	if (sha256(draft.pools) !== request.version) return { status: 409, body: { ok: false, message: "the draft changed; reload" } };
	const validated = validatePoolsConfig(request.pools);
	if (!validated.valid) return { status: 400, body: { ok: false, message: validated.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ") } };

	const file = join(paths.labDir, LAB_POOLS);
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(request.pools, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, file);
	const view = readLabView(paths);
	return "error" in view ? { status: 500, body: { ok: false, message: view.error } } : { status: 200, body: { ok: true, draft: view.draft } };
}
