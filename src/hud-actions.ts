import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "./panel.ts";

// What `/hud` does after its overlay closes: open a session, compact it, or
// continue it in a fresh session from a summary. Pi's session switch and
// fork are only safe from the command handler, never under the open overlay,
// and after a switch only the replacement context may be used.
//
// "fresh" forks the session at its leaf and compacts the fork, so the
// original session file is never changed. Pi keeps the last keepRecentTokens
// (20k by default) unsummarized in both cases.

export interface HudChoice {
	kind: "open" | "compact" | "fresh";
	/** The session file to act on. */
	path: string;
	label: string;
}

/** The part of Pi's command context these actions use. */
export interface HudActionContext {
	sessionManager: { getSessionFile(): string | undefined; getLeafId(): string | null };
	waitForIdle(): Promise<void>;
	switchSession(path: string, options?: { withSession?: (ctx: HudActionContext) => Promise<void> }): Promise<{ cancelled: boolean }>;
	fork(entryId: string, options?: { position?: "before" | "at"; withSession?: (ctx: HudActionContext) => Promise<void> }): Promise<{ cancelled: boolean }>;
	compact: ExtensionCommandContext["compact"];
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

async function compactNow(ctx: HudActionContext, label: string, done: (before: string, after: string) => string): Promise<void> {
	await ctx.waitForIdle();
	ctx.ui.notify(`compacting "${label}": one request summarizes its history`, "info");
	ctx.compact({
		onComplete: result => {
			const after = result.estimatedTokensAfter === undefined ? "a summary" : formatTokens(result.estimatedTokensAfter);
			ctx.ui.notify(done(formatTokens(result.tokensBefore), after), "info");
		},
		onError: error => ctx.ui.notify(`compacting "${label}" failed: ${error.message}`, "error"),
	});
}

async function act(ctx: HudActionContext, choice: HudChoice): Promise<void> {
	if (choice.kind === "compact") {
		await compactNow(ctx, choice.label, (before, after) => `"${choice.label}" compacted: ${before} → ${after} tokens of context per turn`);
		return;
	}
	const leaf = ctx.sessionManager.getLeafId();
	if (!leaf) {
		ctx.ui.notify(`"${choice.label}" has no messages to summarize yet`, "warning");
		return;
	}
	await ctx.fork(leaf, {
		position: "at",
		withSession: fresh =>
			compactNow(fresh, choice.label, (before, after) => `"${choice.label}" continues in a new session: ${before} → ${after} tokens of context per turn; the original session is untouched`),
	});
}

export async function runHudChoice(ctx: HudActionContext, choice: HudChoice): Promise<void> {
	if (choice.kind === "open") {
		await ctx.switchSession(choice.path);
		return;
	}
	await ctx.waitForIdle();
	if (ctx.sessionManager.getSessionFile() === choice.path) {
		await act(ctx, choice);
		return;
	}
	await ctx.switchSession(choice.path, { withSession: replaced => act(replaced, choice) });
}
