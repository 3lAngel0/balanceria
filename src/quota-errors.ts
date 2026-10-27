// Recognizes provider errors that mean "this subscription window is spent",
// as opposed to transient failures that Pi already retries on its own.
//
// Known wordings:
// - agy (Antigravity) stream error, observed 2026-10-16:
//   "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 154h55m28s."
// - agy /usage bucket description: "You have hit your weekly limit, it refreshes in ..."
// - pi-claude-bridge: "Claude quota exceeded — rate limit (<type>) — resets ...: ..."
// - Claude Code: "You're out of extra usage · resets 6:30pm"
const QUOTA_EXHAUSTED_PATTERN = new RegExp(
	[
		"quota reached",
		"hit your (?:weekly |5-hour |five hour |daily )?limit",
		"(?:weekly|5-hour|five hour) limit",
		"quota (?:exceeded|exhausted)",
		"resource_exhausted",
		"out of extra usage",
		"usage limit (?:reached|exceeded)",
	].join("|"),
	"i",
);

const RESET_DELAY_PATTERN = /resets in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i;

const STALL_OR_TIMEOUT_PATTERN = new RegExp(
	[
		"stalled (?:for \\d+[msh]? )?with no output",
		"antigravity stalled",
		"bridge (?:tool )?call timed out",
		"escalated bridge call timed out",
		"timed out after \\d+",
	].join("|"),
	"i",
);

export const DEFAULT_STALL_COOLDOWN_MS = 3 * 60_000;

export interface QuotaErrorClassification {
	exhausted: true;
	/** Delay until the window reopens, when the provider states it ("Resets in 154h55m28s") or stall cooldown. */
	resetInMs?: number;
	/** True when the failure was caused by a process/bridge stall or timeout rather than quota. */
	isStall?: boolean;
}

function parseResetDelay(errorMessage: string): number | undefined {
	const match = RESET_DELAY_PATTERN.exec(errorMessage);
	if (!match || (!match[1] && !match[2] && !match[3])) return undefined;
	const [hours, minutes, seconds] = [match[1], match[2], match[3]].map(part => Number(part ?? 0));
	return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

export function classifyQuotaError(errorMessage: string | undefined): QuotaErrorClassification | undefined {
	if (!errorMessage || errorMessage.includes("ai-balancer failover")) return undefined;
	if (STALL_OR_TIMEOUT_PATTERN.test(errorMessage)) {
		return { exhausted: true, resetInMs: DEFAULT_STALL_COOLDOWN_MS, isStall: true };
	}
	if (!QUOTA_EXHAUSTED_PATTERN.test(errorMessage)) return undefined;
	const resetInMs = parseResetDelay(errorMessage);
	return resetInMs === undefined ? { exhausted: true } : { exhausted: true, resetInMs };
}

/**
 * Text Pi's retry classifier accepts as retryable (it matches "rate limit" and
 * "429") while avoiding every word on pi-ai's non-retryable list ("quota
 * exceeded", "billing", "insufficient_quota", ...). The original provider text
 * is deliberately left out because it may contain those words.
 */
export function failoverErrorMessage(provider: string, isStall?: boolean): string {
	const reason = isStall ? "stalled with no output" : "subscription window is spent";
	return `429 rate limit: ai-balancer failover, ${provider} ${reason}`;
}
