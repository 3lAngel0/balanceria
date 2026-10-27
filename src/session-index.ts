import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";

// Finds a Pi session file by id and reads its first user message, so the HUD
// can name a session that has no name. Files live at
// <root>/<cwd-dir>/<iso>_<id>.jsonl. Locating is a readdir over the cwd dirs
// (no file is parsed); the first message is read from the head of the file only.
// Nothing here throws: unreadable or missing means no path / no message.

export const DEFAULT_SESSIONS_ROOT = join(homedir(), ".gentle-shell", "agent", "sessions");
const CHUNK_BYTES = 64 * 1024;
const MAX_BYTES = 512 * 1024;
const ALIAS_CHARS = 40;

export function findSessionFile(root: string, id: string): string | null {
	const suffix = `_${id}.jsonl`;
	try {
		for (const dir of readdirSync(root)) {
			try {
				const name = readdirSync(join(root, dir)).find(file => file.endsWith(suffix));
				if (name) return join(root, dir, name);
			} catch {
				// Not a directory or unreadable: keep looking.
			}
		}
	} catch {
		// No sessions root.
	}
	return null;
}

function messageText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts = content.flatMap(part => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
	return parts.length > 0 ? parts.join(" ") : null;
}

function userText(line: string): string | null {
	let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
	try {
		entry = JSON.parse(line);
	} catch {
		return null;
	}
	if (entry?.type !== "message" || entry.message?.role !== "user") return null;
	const text = messageText(entry.message.content);
	return text?.trim() ? text : null;
}

/**
 * The text of the first user message. The file is read 64 KB at a time and
 * only up to 512 KB: Pi writes its system prompt first, about 100 KB, so the
 * first user message sits just after it.
 */
export function readFirstUserMessage(path: string): string | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.alloc(CHUNK_BYTES);
		let pending = "";
		for (let offset = 0; offset < MAX_BYTES; ) {
			const read = readSync(fd, buffer, 0, CHUNK_BYTES, offset);
			if (read === 0) break;
			offset += read;
			const lines = (pending + decoder.write(buffer.subarray(0, read))).split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				const text = userText(line);
				if (text !== null) return text;
			}
		}
		return null;
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

/** The text on one line, clipped to `max` characters with a trailing "…". */
export function clip(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** One line, whitespace collapsed, at most 40 characters. */
export function clipAlias(text: string): string {
	return clip(text, ALIAS_CHARS);
}

export interface SessionLookup {
	path: string | null;
	firstMessage: string | null;
}

/** Lookups cached per session id: a found file and its first message never change. */
export function createSessionIndex(root: string = DEFAULT_SESSIONS_ROOT) {
	const found = new Map<string, SessionLookup>();
	return {
		/** `hintPath` is a known session file (a subagent task's) tried before scanning. */
		lookup(id: string, hintPath?: string | null): SessionLookup {
			const cached = found.get(id);
			if (cached) return cached;
			const path = hintPath && existsSync(hintPath) ? hintPath : findSessionFile(root, id);
			const result = { path, firstMessage: path ? readFirstUserMessage(path) : null };
			if (result.path) found.set(id, result);
			return result;
		},
	};
}
