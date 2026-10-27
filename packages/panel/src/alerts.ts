import { execFile } from "node:child_process";
import { readHistory } from "../../../src/history.ts";
import { readLoans } from "../../../src/loans.ts";
import type { LiveSessionManager } from "./actions.ts";
import type { PanelProject } from "./projects.ts";
import type { QuotaSeries } from "../ui/api.ts";

export type AlertLevel = "info" | "warning" | "error";
export type AlertSource = "quota" | "context" | "session" | "loan" | "circuit_breaker";

export interface Alert {
	id: string;
	level: AlertLevel;
	title: string;
	message: string;
	source: AlertSource;
	timestamp: number;
}

export interface SessionSummaryAlert {
	id: string;
	cwd?: string | null;
	totalTokens?: number;
	lastActivity: number;
	isLive?: boolean;
}

export interface LoanAlertData {
	id: string;
	role: string;
	from: string;
	to: string;
	status: string;
	profile: string;
}

export interface AlertContext {
	now: number;
	quotaSeries: readonly QuotaSeries[];
	sessions: readonly SessionSummaryAlert[];
	loans: readonly LoanAlertData[];
	errors?: ReadonlyArray<{ key: string; ts: number }>;
}

export const CONTEXT_LIMIT_ALERT = 120_000;
export const STUCK_SESSION_MS = 10 * 60 * 1000; // 10 minutes
export const RECENT_ERROR_MS = 15 * 60 * 1000; // 15 minutes

/** Evaluates telemetry state and returns active alert notifications. */
export function collectAlerts(context: AlertContext): Alert[] {
	const alerts: Alert[] = [];
	const { now, quotaSeries, sessions, loans, errors } = context;

	// 1. Quota window near full (>= 90%)
	for (const q of quotaSeries) {
		if (q.peak !== null && q.peak >= 0.9) {
			const pct = Math.round(q.peak * 100);
			const level: AlertLevel = q.peak >= 0.95 ? "error" : "warning";
			alerts.push({
				id: `quota-near-full-${q.limit}-${q.window}`,
				level,
				title: "Quota window near full",
				message: `${q.limit} (${q.window}) is at ${pct}% peak capacity`,
				source: "quota",
				timestamp: now,
			});
		}
	}

	// 2. High context sessions (> 120k tokens)
	for (const s of sessions) {
		if (s.totalTokens && s.totalTokens > CONTEXT_LIMIT_ALERT) {
			const kTokens = Math.round(s.totalTokens / 1000);
			alerts.push({
				id: `context-over-120k-${s.id}`,
				level: "warning",
				title: "High context session",
				message: `Session "${s.id}" exceeded 120k context tokens (${kTokens}k)`,
				source: "context",
				timestamp: now,
			});
		}
	}

	// 3. Pending loan decisions (status proposed or ended)
	for (const loan of loans) {
		if (loan.status === "proposed" || loan.status === "ended") {
			alerts.push({
				id: `loan-${loan.id}`,
				level: "info",
				title: "Pending model loan decision",
				message: `Loan for ${loan.role} (${loan.from} → ${loan.to}) is ${loan.status}. Run /balancer loans to choose.`,
				source: "loan",
				timestamp: now,
			});
		}
	}

	// 4. Stuck sessions (live turn with no activity for > 10m)
	for (const s of sessions) {
		if (s.isLive && now - s.lastActivity > STUCK_SESSION_MS) {
			alerts.push({
				id: `stuck-session-${s.id}`,
				level: "warning",
				title: "Stuck session detected",
				message: `Session "${s.id}" has been running with no output for over 10 minutes`,
				source: "session",
				timestamp: now,
			});
		}
	}

	// 5. Circuit breaker / recent provider errors (within 15 min)
	if (errors && errors.length > 0) {
		const recentKeys = new Set<string>();
		for (const err of errors) {
			if (now - err.ts <= RECENT_ERROR_MS) {
				recentKeys.add(err.key);
			}
		}
		for (const key of recentKeys) {
			alerts.push({
				id: `circuit-breaker-${key}`,
				level: "error",
				title: "Circuit breaker / Provider failure",
				message: `Recent exhaustion or rate limits on provider "${key}"`,
				source: "circuit_breaker",
				timestamp: now,
			});
		}
	}

	return alerts;
}

export interface BuildPanelAlertsOptions {
	dataDir: string;
	root: string;
	projects: readonly PanelProject[];
	quotaSeries: readonly QuotaSeries[];
	now?: number;
	liveManager?: LiveSessionManager;
}

/** Reads history, loans and sessions to generate comprehensive panel alerts. */
export function buildPanelAlerts(options: BuildPanelAlertsOptions): Alert[] {
	const now = options.now ?? Date.now();
	let loans: LoanAlertData[] = [];
	try {
		loans = readLoans(options.dataDir).loans;
	} catch {
		// loans missing or unreadable
	}

	let recentErrors: Array<{ key: string; ts: number }> = [];
	const sessionTokens = new Map<string, number>();

	try {
		const history = readHistory(options.dataDir, now);
		recentErrors = history.errors.map(e => ({ key: e.key, ts: e.ts }));
		for (const req of history.requests) {
			if (req.contextTokens) {
				const prev = sessionTokens.get(req.session) ?? 0;
				if (req.contextTokens > prev) {
					sessionTokens.set(req.session, req.contextTokens);
				}
			}
		}
	} catch {
		// history unreadable
	}

	const sessions: SessionSummaryAlert[] = options.projects.flatMap(p => {
		if (!p.latest) return [];
		const isLive = Boolean(options.liveManager?.isLive(p.latest.id));
		const totalTokens = sessionTokens.get(p.latest.id) ?? 0;
		return [{
			id: p.latest.id,
			cwd: p.cwd,
			totalTokens,
			lastActivity: p.lastActivity,
			isLive,
		}];
	});

	return collectAlerts({
		now,
		quotaSeries: options.quotaSeries,
		sessions,
		loans,
		errors: recentErrors,
	});
}

export type CommandRunner = (cmd: string, args: string[]) => Promise<void>;

export interface DispatchDesktopOptions {
	now?: number;
	cooldownMs?: number;
	seen?: Map<string, number>;
	runner?: CommandRunner;
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function defaultExecRunner(cmd: string, args: string[]): Promise<void> {
	return new Promise(resolve => {
		try {
			execFile(cmd, args, () => resolve());
		} catch {
			resolve();
		}
	});
}

/** Dispatches desktop alerts via notify-send on Linux, deduped per alert ID within a cooldown window. */
export async function dispatchDesktopAlerts(
	alerts: readonly Alert[],
	options: DispatchDesktopOptions = {},
): Promise<string[]> {
	if (typeof process !== "undefined" && process.platform !== "linux" && !options.runner) {
		return [];
	}

	const now = options.now ?? Date.now();
	const cooldown = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	const seen = options.seen ?? new Map<string, number>();
	const runner = options.runner ?? defaultExecRunner;
	const sent: string[] = [];

	for (const alert of alerts) {
		const lastSent = seen.get(alert.id);
		if (lastSent !== undefined && now - lastSent < cooldown) {
			continue;
		}

		seen.set(alert.id, now);
		const urgency = alert.level === "error" ? "critical" : alert.level === "warning" ? "normal" : "low";
		try {
			await runner("notify-send", ["-u", urgency, "-a", "ai-balancer", alert.title, alert.message]);
			sent.push(alert.id);
		} catch {
			// notify-send missing or failed; silently ignore.
		}
	}

	return sent;
}
