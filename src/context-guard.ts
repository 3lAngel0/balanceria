/**
 * Proactive compaction guard.
 *
 * Antigravity resumes its own server-side conversation, so the usage it reports
 * covers only that conversation, not pi's full history. Pi decides when to
 * compact from that reported usage, and pool models register a 1M window, so a
 * session can grow to ~1M tokens without ever compacting. The first switch to
 * another provider then sends the whole history ("Prompt is too long") and the
 * recovery compaction of ~1M tokens takes minutes.
 *
 * The guard estimates the real history size itself and compacts early, while
 * the history is still small enough to summarize quickly and to fit any pool
 * candidate, including Claude at 200K.
 */

export const DEFAULT_PROACTIVE_COMPACT_TOKENS = 180_000;

/** Providers whose reported usage does not reflect pi's real history size. */
const GUARDED_PROVIDERS = new Set(["pool", "antigravity"]);

/** Same image weight pi uses in its own estimate. */
const ESTIMATED_IMAGE_CHARS = 4800;

type ContentBlock = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
type HistoryMessage = { role?: string; content?: unknown; command?: string; output?: string; summary?: string };

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content as ContentBlock[]) {
		if (block?.type === "text" && typeof block.text === "string") chars += block.text.length;
		else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
	}
	return chars;
}

function assistantChars(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content as ContentBlock[]) {
		if (block?.type === "text" && typeof block.text === "string") chars += block.text.length;
		else if (block?.type === "thinking" && typeof block.thinking === "string") chars += block.thinking.length;
		else if (block?.type === "toolCall") chars += (block.name ?? "").length + JSON.stringify(block.arguments ?? {}).length;
	}
	return chars;
}

function messageChars(message: HistoryMessage): number {
	switch (message.role) {
		case "user":
		case "custom":
		case "toolResult":
			return contentChars(message.content);
		case "assistant":
			return assistantChars(message.content);
		case "bashExecution":
			return (message.command ?? "").length + (message.output ?? "").length;
		case "branchSummary":
		case "compactionSummary":
			return (message.summary ?? "").length;
		default:
			return 0;
	}
}

type ContextEntry = { type?: string; message?: HistoryMessage; content?: unknown; summary?: string };

/** Turns pi's compaction-aware context entries into the messages it sends, mirroring sessionEntryToContextMessages. */
export function entriesToHistoryMessages(entries: readonly unknown[]): HistoryMessage[] {
	const messages: HistoryMessage[] = [];
	for (const raw of entries) {
		const entry = (raw ?? {}) as ContextEntry;
		if (entry.type === "message" && entry.message) messages.push(entry.message);
		else if (entry.type === "custom_message") messages.push({ role: "custom", content: entry.content ?? [] });
		else if (entry.type === "branch_summary" && entry.summary) messages.push({ role: "branchSummary", summary: entry.summary });
		else if (entry.type === "compaction") messages.push({ role: "compactionSummary", summary: entry.summary ?? "" });
	}
	return messages;
}

/** Estimates the tokens pi would send for this history, at four characters per token. */
export function estimateHistoryTokens(messages: readonly unknown[]): number {
	let tokens = 0;
	for (const message of messages) tokens += Math.ceil(messageChars((message ?? {}) as HistoryMessage) / 4);
	return tokens;
}

export function shouldCompactProactively(input: {
	provider: string | undefined;
	estimatedTokens: number;
	threshold: number;
	compacting: boolean;
}): boolean {
	if (input.compacting) return false;
	if (input.provider === undefined || !GUARDED_PROVIDERS.has(input.provider)) return false;
	return input.estimatedTokens >= input.threshold;
}
