import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CONTENT_X, emphasize, hitTest, layoutButtons, sameTarget, tabHitAreas, wheelOffset, type ButtonCell, type HitLayout, type MouseTarget } from "./control-center-mouse.ts";
import { applyStepper, initStepper, type StepperCurrent } from "./setup-stepper.ts";
import { initScreen, renderStepper, stepperInput, type StepperEffect, type StepperEvent, type StepperTone, stepperThemeColor } from "./setup-stepper-view.ts";
import { BALANCER_MENU, balancerMenu, glossaryText, resolveBalancerArgs } from "./balancer-menu.ts";
import { initLang, getLang, setLang, saveLangSetting, t } from "./i18n/index.ts";
import { detectFirewall, privateIPv4Networks, readAutostart, readTls, runLanSetup, writeAutostart, writeTls, type Runner } from "./lan-setup.ts";
import { createCertificate, inspectCertificate, type TlsConfig } from "./tls-setup.ts";
import { parseAgyUsage } from "./agy-usage.ts";
import { summarizeConsumption } from "./consumption.ts";
import { appendEvent, foldEvents, readEvents, type FoldedEvents } from "./events.ts";
import { appendHistory, legacyRecords, pruneHistory, readHistory, type HistoryData, type HistoryEntry } from "./history.ts";
import { topConsumers, withAliases } from "./consumers.ts";
import { HUD_VIEWS, hudHints, moveCursor, pressRedKey, renderHud, selectedSessionTarget, suggestionEnter, SESSIONS_PER_ROLE, visibleSessions, type HudViewName, type PendingConfirm } from "./hud.ts";
import { runHudChoice, type HudChoice } from "./hud-actions.ts";
import { loadIntegrations } from "./integrations.ts";
import { renderPanel, statusLine, statusWithContext, turnTelemetry, renderControlCenter, controlCenterButtons, controlCenterTabLabels, CONTROL_CENTER_TABS, type ControlCenterTab, type TurnTelemetry } from "./panel.ts";
import { ROLE_CATALOG, buildAvailableModelTargets, recommendRolesHeuristic, recommendRolesWithAdvisor, createDefaultCliAiRunner, applyRecommendationsToProfile, type AdvisorReport } from "./setup-advisor.ts";
import { applySuggestionToProfile, DEFAULT_PROFILES_PATH, loadProfilesStore, qualifyModel, readProfiles, saveProfilesStore, type ProfilesStore } from "./profiles.ts";
import { loadPrices } from "./prices.ts";
import { clipAlias, createSessionIndex, DEFAULT_SESSIONS_ROOT, findSessionFile } from "./session-index.ts";
import { suggestOptimizations, type Suggestion } from "./suggestions.ts";
import { readAgentTasks, resolveRole, routingRole } from "./roles.ts";
import { validatePoolsConfig } from "./config-schema.ts";
import { formatSimulation, poolOfSelection, readPoolSelections, simulate } from "./simulator.ts";
import { activeRoutes, applyDraft, createDraft, diffLab, discardDraft, formatApplyConfirm, formatLabDiff, formatRoleMoves, hasDraft, hasUndo, LAB_POOLS, LAB_PROFILES, profilePoolOf, readDraft, roleMoves, undoApply, type LabTexts } from "./lab.ts";
import { addGrant, formatGrants, loadPermissions, pruneExpired, revokeGrants, runPermissionGrant } from "./permissions.ts";
import { summarizeQuota } from "./quota-report.ts";
import { paint, plain, tone } from "./style.ts";
import { helpMainWidth, helpVisible, withHelp } from "./help-panel.ts";
import { renderAdvancedUsage, summarizeHistory, USAGE_VIEWS, type CurrentSession, type UsageViewName } from "./usage-panel.ts";
import { keepRowVisible, scrollStep, sliceViewport } from "./viewport.ts";
import { ignoredRuleWarnings, parsePools, POOL_PROVIDER, quotaKeyFor, type Pool } from "./pools.ts";
import { classifyQuotaError, failoverErrorMessage } from "./quota-errors.ts";
import { routeWithLoans } from "./loan-routing.ts";
import {
	auditLoan,
	decideLoan,
	expireLoans,
	loanSummary,
	clock,
	commitLoanChanges,
	readLoans,
	withLoansLock,
	writeLoans,
	type Loan,
} from "./loans.ts";
import { chooseLoanAction, formatKeepLoanConfirm, keepLoanInProfile, loanNotices, loanWidget, reviewEndedLoan } from "./loan-console.ts";
import { failoverAlternative, routeWithTrace } from "./router.ts";
import { fitWindows, formatSwitchCostReport, routeSwitchCost, type WindowFit } from "./switch-cost.ts";
import { DecisionChanges, routeDecision } from "./route-log.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { runSetupWizard, detectSystemProviders, generateRecommendedConfig, saveProfileRoles, writeConfigSafely, toggleCandidateInList, moveCandidateInList, type DetectedProvider, type PoolConfig } from "./setup.ts";
import { buildSessionDetail, buildWebReport, readSessionCwd, snapshotSessionIds, type WebReport } from "./web-data.ts";
import { webSnapshotHtml } from "./web-page.ts";
import { bindWebHandlers, formatServeStart, isValidSessionId, parseServeArgs, runningWebServer, startServing, stopServing, type WebHandlers } from "./web-serve.ts";
import { loadTlsFiles, probeReport, type OpenResult, type TlsMaterial } from "./web-server.ts";
import {
	agyUsageLimits,
	CLAUDE_BRIDGE_PROVIDER,
	claudeLimitName,
	claudeQuotaEvents,
	createPoolUsageSource,
	quotaKeyForLimit,
	throttledClaudeFetch,
	USAGE_SOURCE_EVENT,
	type CachedClaudeUsage,
	usageSourceFetch,
	type UsageFetch,
	type UsageLimit,
} from "./usage-source.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.AI_BALANCER_DATA_DIR || join(ROOT, "data");
const WEB_TOKEN_FILE = join(DATA_DIR, "web-token");
const WEB_SERVE_FILE = join(DATA_DIR, "web-serve.json");
const WEB_TLS_DIR = join(DATA_DIR, "tls");
const LAB_DIR = join(DATA_DIR, "lab");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

/** The stored LAN certificate, read on every LAN start; a broken one fails the start, never falls back to HTTP. */
function lanTls(config: TlsConfig | undefined = readTls(WEB_SERVE_FILE)): TlsMaterial | undefined {
	return config ? loadTlsFiles(config) : undefined;
}

const runTool: Runner = (command, args) =>
	new Promise((resolve, reject) => execFile(command, args, { timeout: 30_000 }, (error, stdout) => (error ? reject(error) : resolve({ stdout: String(stdout) }))));
const AGY_BIN = process.env.AI_BALANCER_AGY_BIN || join(homedir(), ".local", "bin", "agy");
const AGY_POLL_MS = 5 * 60_000;
const AGY_TIMEOUT_MS = 30_000;
// Age past which an alt+u fetch also starts a background agy refresh.
const AGY_USAGE_SOURCE_MAX_AGE_MS = 2 * 60_000;
const AGY_REPORT_FILE = "agy-report.json";
// Anthropic's usage endpoint answers 429 when polled often; one try per
// interval, shared by every session through this file.
const CLAUDE_USAGE_MIN_INTERVAL_MS = 5 * 60_000;
const CLAUDE_USAGE_FILE = "claude-usage.json";
const PANEL_REFRESH_MS = 5_000;
const PANEL_WIDTH = 34;
const STATUS_KEY = "ai-balancer";

function loadPools(): { pools: Pool[]; warnings: string[] } {
	try {
		const config = JSON.parse(readFileSync(join(ROOT, "pools.json"), "utf8"));
		return { pools: parsePools(config), warnings: ignoredRuleWarnings(config) };
	} catch {
		return { pools: [], warnings: [] };
	}
}

function fold(): FoldedEvents {
	return foldEvents(readEvents(DATA_DIR), Date.now());
}

function record(event: Parameters<typeof appendEvent>[1]): void {
	try {
		appendEvent(DATA_DIR, event);
	} catch {
		// Losing one data point must never break a model request.
	}
}

interface CachedAgyReport {
	fetchedAt: number;
	report: unknown;
}

// The full agy report, kept for the usage source: the event log only holds the
// limiting bucket per group, and the shell needs every window.
// Atomic per-process write; a failure only costs an extra request later.
function writeDataFile(name: string, value: unknown): void {
	try {
		mkdirSync(DATA_DIR, { recursive: true });
		const temporary = join(DATA_DIR, `${name}.${process.pid}.tmp`);
		writeFileSync(temporary, JSON.stringify(value));
		renameSync(temporary, join(DATA_DIR, name));
	} catch {
		// The cache is a convenience; the next poll writes it again.
	}
}

function saveAgyReport(report: unknown): void {
	writeDataFile(AGY_REPORT_FILE, { fetchedAt: Date.now(), report } satisfies CachedAgyReport);
}

const claudeUsageStore = {
	load(): CachedClaudeUsage | undefined {
		try {
			const cached = JSON.parse(readFileSync(join(DATA_DIR, CLAUDE_USAGE_FILE), "utf8")) as Partial<CachedClaudeUsage>;
			return typeof cached.attemptedAt === "number" ? { attemptedAt: cached.attemptedAt, usage: cached.usage } : undefined;
		} catch {
			return undefined;
		}
	},
	save(cached: CachedClaudeUsage): void {
		writeDataFile(CLAUDE_USAGE_FILE, cached);
	},
};

function loadAgyReport(): CachedAgyReport | undefined {
	try {
		const cached = JSON.parse(readFileSync(join(DATA_DIR, AGY_REPORT_FILE), "utf8")) as Partial<CachedAgyReport>;
		return typeof cached.fetchedAt === "number" ? { fetchedAt: cached.fetchedAt, report: cached.report } : undefined;
	} catch {
		return undefined;
	}
}

/** Runs agy `/usage` (about 15 seconds), records and caches it; false on failure. */
function readAgyUsage(onReport: (report: unknown) => void): Promise<boolean> {
	return new Promise(resolve => {
		execFile(AGY_BIN, ["--print", "/usage", "--output-format", "json"], { timeout: AGY_TIMEOUT_MS }, (error, stdout) => {
			if (error) return resolve(false);
			try {
				const report: unknown = JSON.parse(stdout);
				const groups = parseAgyUsage(report);
				if (groups.size === 0) return resolve(false);
				record({ type: "agy-usage", ts: Date.now(), groups: Object.fromEntries(groups) });
				saveAgyReport(report);
				onReport(report);
				resolve(true);
			} catch {
				// agy printed something other than the JSON report; keep the last snapshot.
				resolve(false);
			}
		});
	});
}

export default function aiBalancer(pi: ExtensionAPI) {
	initLang(SETTINGS_FILE);
	const processStartedAt = Date.now() - process.uptime() * 1000;
	const { pools, warnings: poolWarnings } = loadPools();
	const lastRouted = new Map<string, string>();
	// History rows for decision changes; the role is fixed for the life of the process.
	const decisionChanges = new DecisionChanges();
	// API list prices for `pick: lowest-cost`, read at the first routed request.
	let routePrices: ReturnType<typeof loadPrices> | undefined;
	// Window fits for switch costs: 30 days of history, read at the first provider change only.
	let switchFits: WindowFit[] | undefined;
	const ROUTING_ROLE = routingRole(process.argv, process.env.GENTLE_PI_AGENTS_CHILD === "1");
	let agyPolling: Promise<boolean> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let loanTimer: ReturnType<typeof setInterval> | undefined;
	const seenLoanNotices = new Set<string>();
	const promptedEndedLoans = new Set<string>();
	let closePanel: (() => void) | undefined;
	let claudeRawFetch: UsageFetch | undefined;
	let claudeUsageFetch: UsageFetch | undefined;
	let sessionContext: ExtensionContext | undefined;
	const circuitBreaker = new CircuitBreaker(DATA_DIR);
	let lastTurnTelemetry: TurnTelemetry | undefined;
	// Context after the previous response, so the badge can say how much a turn grew it.
	let lastContextTokens: number | null | undefined;

	// Samples and quota errors carry the session that was open when they were seen.
	const sessionIdentity = (): { session: string; project: string } => {
		try {
			if (sessionContext) return { session: sessionContext.sessionManager.getSessionId(), project: basename(sessionContext.sessionManager.getCwd()) };
		} catch {
			// The context went stale after a session switch.
		}
		return { session: "unknown", project: "unknown" };
	};

	// One sample per window of every limit that has a known quota key.
	function recordQuotaSamples(limits: readonly UsageLimit[]): void {
		try {
			const { session } = sessionIdentity();
			const ts = Date.now();
			for (const limit of limits) {
				const key = quotaKeyForLimit(limit.name);
				for (const window of limit.windows) {
					appendHistory(DATA_DIR, {
						kind: "quota",
						ts,
						session,
						limit: limit.name,
						key,
						window: window.label,
						windowSeconds: window.windowSeconds,
						usedPercent: window.usedPercent,
						resetAt: window.resetAt,
					});
				}
			}
		} catch {
			// Quota history is for later analysis; it never breaks a fetch.
		}
	}

	// One agy run at a time per process. A fresh report re-registers the usage
	// source, which makes the shell refetch `pool` with it.
	const pollAgy = (): Promise<boolean> => {
		agyPolling ??= readAgyUsage(report => recordQuotaSamples(agyUsageLimits(report)))
			.then(fresh => {
				if (fresh) registerPoolUsage();
				return fresh;
			})
			.finally(() => {
				agyPolling = undefined;
			});
		return agyPolling;
	};

	const pollAgyIfStale = () => {
		const last = fold().lastAgyUsageAt;
		if (last !== undefined && Date.now() - last < AGY_POLL_MS) return;
		void pollAgy();
	};

	// alt+u (Gentle Shell usage) meters the session's provider, `pool` here.
	// The Claude side reuses the claude-bridge source pi-claude-usage publishes.
	// agy takes longer than the shell's 10-second fetch window, so the source
	// answers with the cached report and refreshes it in the background.
	const poolUsageSource = createPoolUsageSource({
		claudeSource: () => (claudeUsageFetch ? { fetch: claudeUsageFetch } : undefined),
		readAgyReport: async () => {
			const cached = loadAgyReport();
			if (!cached || Date.now() - cached.fetchedAt > AGY_USAGE_SOURCE_MAX_AGE_MS) void pollAgy();
			return cached?.report;
		},
		routedKey: () => {
			const route = fold().lastRoute;
			const pool = route && pools.find(candidatePool => candidatePool.id === route.pool);
			return pool?.candidates.find(candidate => candidate.provider === route?.provider)?.quotaKey;
		},
	});
	function registerPoolUsage(): void {
		pi.events.emit(USAGE_SOURCE_EVENT, poolUsageSource);
	}
	pi.events.on(USAGE_SOURCE_EVENT, payload => {
		const fetchClaude = usageSourceFetch(payload, CLAUDE_BRIDGE_PROVIDER);
		if (!fetchClaude || fetchClaude === claudeRawFetch) return;
		claudeRawFetch = fetchClaude;
		// The throttle only calls the wrapped fetch for a fresh request, so cached answers are never re-recorded.
		const recordingFetch: UsageFetch = async (apiKey, fetchFn, now) => {
			const usage = await fetchClaude(apiKey, fetchFn, now);
			if (usage) {
				recordQuotaSamples(usage.limits.map(limit => ({ ...limit, name: claudeLimitName(limit.name) })));
				// Every Pi process folds this, so subagents route on the live Claude quota too.
				for (const event of claudeQuotaEvents(usage)) record(event);
			}
			return usage;
		};
		claudeUsageFetch = throttledClaudeFetch(recordingFetch, claudeUsageStore, CLAUDE_USAGE_MIN_INTERVAL_MS);
		// Re-registering makes the shell refetch `pool` now that Claude can answer.
		registerPoolUsage();
	});

	const refreshStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const status = statusLine(fold(), Date.now(), circuitBreaker.getStatus(), lastTurnTelemetry);
		const paint = (level: string, text: string) => ctx.ui.theme.fg(level === "alert" ? "error" : "warning", text);
		ctx.ui.setStatus(STATUS_KEY, statusWithContext(status, currentSession(ctx).contextTokens, paint));
	};

	const refreshLoans = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try {
			const { loans } = readLoans(DATA_DIR);
			const now = Date.now();
			const notices = loanNotices(loans, seenLoanNotices, now);
			for (const notice of notices) ctx.ui.notify(notice, "warning");
			ctx.ui.setWidget("ai-balancer-loans", loanWidget(loans, now));
		} catch {
			// Loans file error is reported by readLoans if needed.
		}
	};

	for (const pool of pools) {
		pi.registerVirtualModel({
			provider: POOL_PROVIDER,
			id: pool.id,
			name: pool.name,
			thinkingLevels: ["low", "medium", "high"],
			// Shown before the first response; the smallest limits among the candidates.
			contextWindow: 1_000_000,
			maxTokens: 65_536,
			route(request, ctx) {
				const now = Date.now();
				// A stale context or an unreadable journal never blocks the request.
				let current: ReturnType<typeof currentSession> | undefined;
				try {
					current = currentSession(ctx);
				} catch {
					current = undefined;
				}
				const { loans } = readLoans(DATA_DIR);
				routePrices ??= loadPrices(join(ROOT, "prices.json"));
				const { candidate: choice, trace, changes } = routeWithLoans({
					pool,
					pools,
					reason: request.reason,
					previousProvider: request.previous?.model.provider,
					previousModel: request.previous?.model.id,
					failedProvider: request.failed?.model.provider,
					failedModel: request.failed?.model.id,
					role: ROUTING_ROLE.role,
					prices: routePrices,
					state: fold().state,
					now,
					processStartedAt,
					loans,
					contextTokens: current?.contextTokens ?? null,
					permissions: () => ({
						grants: loadPermissions(DATA_DIR).grants,
						profile: loadProfilesStore()?.active,
					}),
				});
				if (changes.length > 0) {
					try {
						commitLoanChanges(DATA_DIR, now, changes);
					} catch {
						// A journal failure never blocks the request.
					}
				}
				const model = ctx.modelRegistry.find(choice.provider, choice.model);
				if (!model) throw new Error(`ai-balancer: ${choice.provider}/${choice.model} is not in the model catalog`);
				if (decisionChanges.changed(pool.id, `${choice.provider}/${choice.model}`, trace.decidedBy)) {
					try {
						if (!current) throw new Error("no session");
						const previousProvider = request.previous?.model.provider;
						const failedProvider = request.failed?.model.provider;
						const left = request.reason === "retry" ? failedProvider : previousProvider;
						const switchCost = left && left !== choice.provider
							? routeSwitchCost({
								reason: request.reason,
								previousProvider,
								failedProvider,
								candidates: pool.candidates,
								chosen: choice,
								contextTokens: current.contextTokens,
								state: fold().state,
								now,
								fits: (switchFits ??= fitWindows(readHistory(DATA_DIR, now))),
							})
							: undefined;
						appendHistory(DATA_DIR, routeDecision({
							ts: now,
							session: current.session,
							project: basename(ctx.sessionManager.getCwd()),
							pool: pool.id,
							reason: request.reason,
							role: ROUTING_ROLE,
							contextTokens: current.contextTokens,
							candidate: choice,
							trace,
							switchCost,
						}));
					} catch {
						// The trace explains a decision; losing it never blocks the request.
					}
				}
				if (lastRouted.get(pool.id) !== choice.provider) {
					const previous = lastRouted.get(pool.id);
					lastRouted.set(pool.id, choice.provider);
					record({ type: "route", ts: Date.now(), pool: pool.id, provider: choice.provider, reason: request.reason });
					if (previous && ctx.hasUI) ctx.ui.notify(`ai-balancer: pool/${pool.id} ${previous} → ${choice.provider}`, "info");
					refreshStatus(ctx);
				}
				return { model, thinkingLevel: request.thinkingLevel };
			},
		});
	}

	pi.on("message_end", (event, ctx) => {
		const message = event.message as {
			role?: string;
			provider?: string;
			model?: string;
			stopReason?: string;
			errorMessage?: string;
			usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		};
		if (message.role !== "assistant" || !message.provider || !message.model) return;

		if (message.stopReason !== "error") {
			const usage = message.usage;
			if (usage && (usage.input || usage.output)) {
				const contextTokens = currentSession(ctx).contextTokens;
				lastTurnTelemetry = turnTelemetry(usage, contextTokens, lastContextTokens);
				lastContextTokens = contextTokens;
				record({
					type: "usage",
					ts: Date.now(),
					provider: message.provider,
					model: message.model,
					input: usage.input ?? 0,
					output: usage.output ?? 0,
					cacheRead: usage.cacheRead ?? 0,
					cacheWrite: usage.cacheWrite ?? 0,
				});
				recordHistory(ctx, message.provider, message.model, usage);
				refreshStatus(ctx);
			}
			return;
		}

		const quota = classifyQuotaError(message.errorMessage);
		if (!quota) return;
		const key = quotaKeyFor(message.provider, message.model);
		const knownReset = fold().state.snapshot().get(key)?.resetAt;
		const until =
			quota.resetInMs !== undefined ? Date.now() + quota.resetInMs :
			knownReset !== undefined && knownReset > Date.now() ? knownReset :
			undefined;
		record({ type: "exhausted", ts: Date.now(), key, until, reason: (message.errorMessage ?? "").slice(0, 200) });
		try {
			appendHistory(DATA_DIR, {
				kind: "quota-error",
				ts: Date.now(),
				session: currentSession(ctx).session,
				project: basename(ctx.sessionManager.getCwd()),
				key,
				until: until ?? null,
			});
		} catch {
			// The event log above already has it.
		}
		if (message.provider === "antigravity" && !quota.isStall) pollAgyIfStale();
		refreshStatus(ctx);

		// Only sessions on a pool model are rewritten: elsewhere a retry would
		// hit the same spent subscription again.
		if (ctx.model?.provider !== POOL_PROVIDER) return;
		const pool = pools.find(candidatePool => candidatePool.id === ctx.model?.id);
		if (!pool) return;
		const state = fold().state;
		const alternative = failoverAlternative(pool.candidates, key, state);
		if (!alternative) {
			circuitBreaker.checkAndTrip({
				poolId: pool.id,
				candidates: pool.candidates,
				state,
				session: currentSession(ctx).session,
				project: basename(ctx.sessionManager.getCwd()),
				now: Date.now(),
			});
			if (ctx.hasUI) {
				ctx.ui.notify(`ai-balancer: ALL CANDIDATES in pool/${pool.id} are exhausted! Circuit breaker tripped, session checkpointed.`, "error");
			}
			refreshStatus(ctx);
			return;
		}
		if (ctx.hasUI) {
			const reason = quota.isStall ? "stalled with no output" : "is spent";
			ctx.ui.notify(`ai-balancer: ${message.provider} ${reason}, retrying on ${alternative.provider}`, "warning");
		}
		return { message: { ...event.message, errorMessage: failoverErrorMessage(message.provider, quota.isStall) } as typeof event.message };
	});

	const currentSession = (ctx: ExtensionContext): CurrentSession => {
		let context: ReturnType<ExtensionContext["getContextUsage"]>;
		try {
			context = ctx.getContextUsage();
		} catch {
			context = undefined;
		}
		return {
			session: ctx.sessionManager.getSessionId(),
			model: ctx.model?.id,
			contextTokens: context?.tokens ?? null,
			contextWindow: context?.contextWindow ?? null,
		};
	};

	// Every response, pool or not, so the history can compare subscriptions.
	const recordHistory = (
		ctx: ExtensionContext,
		provider: string,
		model: string,
		usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
	) => {
		try {
			const current = currentSession(ctx);
			appendHistory(DATA_DIR, {
				ts: Date.now(),
				session: current.session,
				project: basename(ctx.sessionManager.getCwd()),
				provider,
				model,
				input: usage.input ?? 0,
				output: usage.output ?? 0,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				contextTokens: current.contextTokens,
				contextWindow: current.contextWindow,
				// Gentle marks subagent processes; the agent name is joined from its task store when read.
				child: process.env.GENTLE_PI_AGENTS_CHILD === "1",
				sessionName: ctx.sessionManager.getSessionName() ?? null,
			});
		} catch {
			// History is for later analysis; it never blocks a response.
		}
	};

	const sessionIndex = createSessionIndex();
	const CONSUMER_WINDOW_MS = 7 * 86_400_000;

	/** Roles of the last 7 days; sessions without a name get their subagent label or first message, and a file path when one exists. */
	const loadConsumers = (requests: HistoryData["requests"], tasks: ReturnType<typeof readAgentTasks>, now: number) => {
		const sessionPaths = new Map<string, string>();
		const roles = withAliases(topConsumers(requests.filter(request => request.ts >= now - CONSUMER_WINDOW_MS), tasks), SESSIONS_PER_ROLE, id => {
			const found = sessionIndex.lookup(id, tasks.get(id)?.sessionPath);
			if (found.path) sessionPaths.set(id, found.path);
			return found.firstMessage ? clipAlias(found.firstMessage) : null;
		});
		// Named sessions skip the alias lookup above, but still need a path to jump to.
		for (const session of visibleSessions(roles)) {
			if (!sessionPaths.has(session.session)) {
				const found = sessionIndex.lookup(session.session, tasks.get(session.session)?.sessionPath);
				if (found.path) sessionPaths.set(session.session, found.path);
			}
		}
		return { roles, sessionPaths };
	};

	// History plus the event-log rows that predate it, so the first 30 days are not empty.
	const loadRequests = (now: number): HistoryData => {
		const history = readHistory(DATA_DIR, now);
		const earliest = Math.min(
			history.requests[0]?.ts ?? Number.POSITIVE_INFINITY,
			history.samples[0]?.ts ?? Number.POSITIVE_INFINITY,
			history.errors[0]?.ts ?? Number.POSITIVE_INFINITY,
		);
		const legacy = legacyRecords(readEvents(DATA_DIR), earliest, now);
		return {
			requests: [...legacy.requests, ...history.requests],
			samples: history.samples,
			errors: [...legacy.errors, ...history.errors],
			routes: history.routes,
		};
	};

	const loadUsageData = (now: number) => {
		const data = loadRequests(now);
		const prices = loadPrices(join(ROOT, "prices.json"));
		const tasks = readAgentTasks();
		const { roles, sessionPaths } = loadConsumers(data.requests, tasks, now);
		const consumption = summarizeConsumption(data, loadIntegrations(join(ROOT, "integrations.json")), prices, now);
		const suggestions = suggestOptimizations({
			requests: data.requests,
			tasks,
			windows: consumption.subscriptions.flatMap(s => s.windows),
			prices,
			now,
			errors: data.errors,
			pools,
			resolveAlias: id => {
				const found = sessionIndex.lookup(id, tasks.get(id)?.sessionPath);
				return found.firstMessage ? clipAlias(found.firstMessage) : null;
			},
		});
		// Suggested sessions outside the top 5 per role still need a path for enter and the red keys.
		for (const item of suggestions) {
			const id = item.target.session;
			if (id && !sessionPaths.has(id)) {
				const found = sessionIndex.lookup(id, tasks.get(id)?.sessionPath);
				if (found.path) sessionPaths.set(id, found.path);
			}
		}
		return {
			stats: summarizeHistory(data.requests, now, prices),
			quota: summarizeQuota(data, now),
			consumption,
			consumers: roles,
			sessionPaths,
			suggestions,
			routes: data.routes,
		};
	};

	const webHandlers = (): WebHandlers => ({
		getReport() {
			const now = Date.now();
			const { stats, quota, consumers, suggestions, sessionPaths, routes } = loadUsageData(now);
			let current: CurrentSession | undefined;
			try {
				if (sessionContext) current = currentSession(sessionContext);
			} catch {
				// The context went stale or is unavailable.
			}
			return buildWebReport({
				now,
				stats,
				quota,
				consumers,
				suggestions,
				sessionPaths,
				current,
				circuit: circuitBreaker.getStatus(),
				routes,
			});
		},
		getSession(id: string) {
			const now = Date.now();
			const tasks = readAgentTasks();
			const found = sessionIndex.lookup(id, tasks.get(id)?.sessionPath);
			const path = found.path;
			const cwd = path ? readSessionCwd(path) : null;
			const alias = found.firstMessage ? clipAlias(found.firstMessage) : null;
			return buildSessionDetail({
				id,
				requests: loadRequests(now).requests,
				tasks,
				path,
				cwd,
				alias,
				currentSession: sessionIdentity().session,
			});
		},
		async openSession(id: string): Promise<OpenResult> {
			const tasks = readAgentTasks();
			const found = sessionIndex.lookup(id, tasks.get(id)?.sessionPath);
			if (!found.path) {
				return { ok: false, message: "no session file found for this session; it may have been deleted" };
			}
			if (id === sessionIdentity().session) {
				return { ok: false, message: "Pi already has this session open" };
			}
			const label = found.firstMessage ? clipAlias(found.firstMessage) : (tasks.get(id)?.label ?? id.slice(0, 8));
			// Dispatched as a command so it runs with a command context, which alone can switch sessions.
			Promise.resolve(pi.sendUserMessage(`/balancer open ${id}`, { expandPromptTemplates: true })).catch(error => {
				sessionContext?.ui.notify(`ai-balancer: opening "${label}" failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
			return { ok: true, message: `Pi opens "${label}" as soon as it is idle` };
		},
	});

	/**
	 * A centered, framed overlay over the usage data, re-read on a timer and
	 * never per keypress. `onKey` returns true when the key changed the view.
	 */
	const openDataPanel = <T = void>(
		ctx: ExtensionContext,
		title: string,
		hints: string | (() => string),
		body: (data: ReturnType<typeof loadUsageData>, inner: number) => string[],
		onKey: (input: string, data: ReturnType<typeof loadUsageData>, done: (value?: T) => void) => boolean | "reset" | "follow",
	): Promise<T | undefined> => {
		if (!ctx.hasUI) return Promise.resolve(undefined);
		return ctx.ui.custom<T | undefined>(
			(tui, theme, _keybindings, done) => {
				let data = loadUsageData(Date.now());
				let offset = 0;
				let followSelected = false;
				const bodyHeight = () => Math.max(6, ((tui as { terminal?: { rows?: number } }).terminal?.rows ?? 40) - 6);
				const interval = setInterval(() => {
					data = loadUsageData(Date.now());
					tui.requestRender();
				}, PANEL_REFRESH_MS);
				interval.unref?.();
				const border = (text: string) => theme.fg("border", text);
				return {
					handleInput(input: string) {
						if (matchesKey(input, Key.escape) || input === "q") {
							done();
							return;
						}
						const height = bodyHeight();
						if (matchesKey(input, Key.pageDown)) {
							offset += scrollStep(height);
							tui.requestRender();
							return;
						}
						if (matchesKey(input, Key.pageUp)) {
							offset = Math.max(0, offset - scrollStep(height));
							tui.requestRender();
							return;
						}
						if (matchesKey(input, Key.home)) {
							offset = 0;
							tui.requestRender();
							return;
						}
						if (matchesKey(input, Key.end)) {
							offset = Number.MAX_SAFE_INTEGER;
							tui.requestRender();
							return;
						}
						const action = onKey(input, data, done);
						if (action === "reset") offset = 0;
						else if (action === "follow") followSelected = true;
						if (action) tui.requestRender();
					},
					render(width: number): string[] {
						const inner = Math.max(20, width - 4);
						const height = bodyHeight();
						const allLines = body(data, inner);
						if (followSelected) {
							followSelected = false;
							const selectedRow = allLines.findIndex(line => plain(line).startsWith("▸ "));
							// Three lines below the cursor too: a suggestion's why, action and note sit there.
							if (selectedRow >= 0) {
								offset = keepRowVisible(offset, Math.min(selectedRow + 3, allLines.length - 1), allLines.length, height);
								offset = keepRowVisible(offset, selectedRow, allLines.length, height);
							}
						}
						const sliced = sliceViewport(allLines, offset, height);
						offset = sliced.offset;
						const top = border("╭─") + theme.bold(theme.fg("accent", title)) + border(`${"─".repeat(Math.max(0, inner + 1 - visibleWidth(title)))}╮`);
						const row = (styled: string) =>
							`${border("│")} ${styled}${" ".repeat(Math.max(0, inner - visibleWidth(styled)))} ${border("│")}`;
						const rows = sliced.lines.map(line => {
							// Toned spans take the theme's colors; an unmarked line that
							// starts like a title (capital, digit or tab bracket) is accent.
							const styled =
								line !== plain(line) ? paint(line, (tone, text) => theme.fg(tone, text)) :
								/^[A-Z0-9\[]/.test(line) ? theme.fg("accent", line) :
								line;
							return row(truncateToWidth(styled, inner));
						});
						return [top, ...rows, row(""), row(theme.fg("dim", truncateToWidth(typeof hints === "string" ? hints : hints(), inner))), border(`╰${"─".repeat(inner + 2)}╯`)];
					},
					invalidate() {},
					dispose() {
						clearInterval(interval);
					},
				};
			},
			{ overlay: true, overlayOptions: { width: "80%", minWidth: 70, anchor: "center" } },
		);
	};

	const openUsagePanel = (ctx: ExtensionContext) => {
		let view: UsageViewName = "now";
		void openDataPanel(
			ctx,
			" ai-balancer · usage ",
			"1-5 or tab switch view · pgup/pgdn scroll · q/esc close",
			(data, inner) => renderAdvancedUsage(data.stats, view, currentSession(ctx), Date.now(), inner, data.quota, data.consumption, data.consumers),
			input => {
				const index = ["1", "2", "3", "4", "5"].indexOf(input);
				if (index >= 0) view = USAGE_VIEWS[index];
				else if (matchesKey(input, Key.tab)) view = USAGE_VIEWS[(USAGE_VIEWS.indexOf(view) + 1) % USAGE_VIEWS.length];
				else return false;
				return "reset";
			},
		);
	};

	/** Clones the active profile with the suggested cheaper model for the role; returns what happened. */
	const createProfileFrom = (selected: Suggestion, ctx: ExtensionContext): string => {
		const read = readProfiles();
		if ("error" in read) return `could not use profiles.json: ${read.error}`;
		const store = read.store;
		const base = store.active || Object.keys(store.profiles)[0] || "default";
		const newProfileName = `${base}-opt-${selected.target.role || "role"}`;
		// Suggestions name a bare model id; the profile needs provider/model, which Pi's registry settles when it is unique.
		const cheaper = selected.target.cheaperModel && qualifyModel(selected.target.cheaperModel, ctx.modelRegistry.getAll());
		const result = applySuggestionToProfile(store, base, newProfileName, { ...selected, target: { ...selected.target, cheaperModel: cheaper } });
		if (!result.changed) return result.description;
		try {
			const { backup } = saveProfilesStore(result.store, read, { hasModel: (provider, model) => Boolean(ctx.modelRegistry.find(provider, model)) });
			return `profile "${newProfileName}" created (backup: ${basename(backup)})`;
		} catch (err) {
			return `failed to save profile: ${err instanceof Error ? err.message : String(err)}`;
		}
	};

	/** Resolves with what the user chose to do with a session (enter, or a confirmed x / f), if anything. */
	const openHud = (ctx: ExtensionContext): Promise<HudChoice | undefined> => {
		let view: HudViewName = HUD_VIEWS[0];
		let cursor = 0;
		let suggestionsCursor = 0;
		let note: string | undefined;
		let pending: PendingConfirm | undefined;
		return openDataPanel<HudChoice>(
			ctx,
			" gentle-hud ",
			() => hudHints(view),
			(data, inner) =>
				renderHud(
					view,
					data.consumption,
					Date.now(),
					{ consumers: data.consumers, cursor: moveCursor(cursor, 0, visibleSessions(data.consumers).length), note, confirm: pending?.kind },
					inner,
					{ suggestions: data.suggestions, cursor: moveCursor(suggestionsCursor, 0, data.suggestions.length), note, confirm: pending?.kind },
				),
			(input, data, done) => {
				const index = HUD_VIEWS.findIndex((_, position) => input === String(position + 1));
				const rows = visibleSessions(data.consumers);
				note = undefined;
				// Any key other than the confirming one cancels a pending red key.
				const asked = pending;
				pending = undefined;
				if (input === "x" || input === "f") {
					const target = selectedSessionTarget(view, { consumers: data.consumers, cursor }, { suggestions: data.suggestions, cursor: suggestionsCursor });
					if (!target) {
						note = view === "sessions" || view === "suggestions" ? "this one has no session to act on" : undefined;
						return Boolean(note) && "follow";
					}
					const press = pressRedKey(asked, input === "x" ? "compact" : "fresh", target);
					if (!press.confirmed) {
						pending = press.pending;
						return "follow";
					}
					const path = data.sessionPaths.get(target.session);
					if (path) {
						done({ kind: input === "x" ? "compact" : "fresh", path, label: target.label });
						return false;
					}
					note = "no session file found for this one, it may have been deleted";
					return "follow";
				}
				if (index >= 0) {
					view = HUD_VIEWS[index];
					return "reset";
				}
				if (matchesKey(input, Key.tab)) {
					view = HUD_VIEWS[(HUD_VIEWS.indexOf(view) + 1) % HUD_VIEWS.length];
					return "reset";
				}
				if (view === "sessions" && matchesKey(input, Key.down)) {
					cursor = moveCursor(cursor, 1, rows.length);
					return "follow";
				}
				if (view === "sessions" && matchesKey(input, Key.up)) {
					cursor = moveCursor(cursor, -1, rows.length);
					return "follow";
				}
				if (view === "suggestions" && matchesKey(input, Key.down)) {
					suggestionsCursor = moveCursor(suggestionsCursor, 1, data.suggestions.length);
					return "follow";
				}
				if (view === "suggestions" && matchesKey(input, Key.up)) {
					suggestionsCursor = moveCursor(suggestionsCursor, -1, data.suggestions.length);
					return "follow";
				}
				const selected = data.suggestions[moveCursor(suggestionsCursor, 0, data.suggestions.length)];
				if (view === "suggestions" && input === "c" && selected) {
					note = selected.rule === "expensive-role" ? createProfileFrom(selected, ctx) : "'c' only creates profiles for \"Try <model> for <role>\" suggestions; this one is up to you (see → above)";
					return "follow";
				}
				if (view === "suggestions" && matchesKey(input, Key.enter) && selected) {
					const action = suggestionEnter(selected);
					if (action === "profile") note = createProfileFrom(selected, ctx);
					else if (action === "explain") note = "nothing to open for this one: it is about a quota, not a session";
					else {
						const path = data.sessionPaths.get(selected.target.session!);
						if (path) {
							done({ kind: "open", path, label: selected.target.alias ?? selected.target.session!.slice(0, 8) });
							return false;
						}
						note = "no session file found for this one, it may have been deleted";
					}
					return "follow";
				}
				if (view === "sessions" && matchesKey(input, Key.enter)) {
					const row = rows[moveCursor(cursor, 0, rows.length)];
					const path = row ? data.sessionPaths.get(row.session) : undefined;
					if (path) {
						done({ kind: "open", path, label: row.alias ?? row.session.slice(0, 8) });
						return false;
					}
					note = "no session file found for this one, it may have been deleted";
					return true;
				}
				return false;
			},
		);
	};

	/**
	 * The Control Center overlay. With `canPickAction` (the slash command, which can run what is picked) `/` closes it
	 * and resolves with "menu"; the shortcut has no command context, so there `/` only leaves a hint.
	 */
	const showControlCenter = (ctx: ExtensionContext, initialTab: ControlCenterTab, canPickAction: boolean): Promise<string | undefined> => {
		let tab: ControlCenterTab = initialTab;
		let pickedAction: string | undefined;
		let helpShown: boolean | undefined;
		let lastInner = 0;
		let hover: MouseTarget | undefined;
		let pressed: MouseTarget | undefined;
		let hitLayout: HitLayout | undefined;
		let sendKey: (input: string) => void = () => {};
		let cursor = 0;
		let poolCursor = 0;
		let rolePickerOpen = false;
		let rolePickerCursor = 0;
		let poolEditOpen = false;
		let poolCandidateCursor = 0;
		let note: string | undefined;
		let advisor: AdvisorReport | null = null;
		let advisorLoading = false;
		let offset = 0;
		let followSelected = false;

		const cachedProviders = detectSystemProviders();
		const allCandidateOptions = [
			...new Set(
				cachedProviders
					.filter(p => p.detected)
					.flatMap(p => p.availableModels.map(m => `${p.id}/${m}`)),
			),
		];

		const getPools = () => {
			try {
				const config = JSON.parse(readFileSync(join(ROOT, "pools.json"), "utf8"));
				return parsePools(config);
			} catch {
				return pools;
			}
		};

		return ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				closePanel = () => done();
				const bodyHeight = () => Math.max(8, ((tui as { terminal?: { rows?: number } }).terminal?.rows ?? 40) - 7);
				const interval = setInterval(() => {
					tui.requestRender();
				}, PANEL_REFRESH_MS);
				interval.unref?.();

				const currentPoolConfigs: PoolConfig[] = getPools().map(p => ({
					id: p.id,
					name: p.name,
					candidates: p.candidates.map(c => `${c.provider}/${c.model}`),
					strategy: p.strategy,
				}));

				advisor = recommendRolesHeuristic({
					providers: cachedProviders,
					pools: currentPoolConfigs,
					quotaByKey: Object.fromEntries(
						[...fold().state.snapshot().entries()].map(([k, v]) => [k, v.remainingFraction ?? 1]),
					),
				});

				const border = (text: string) => theme.fg("border", text);
				const component = {
					handleInput(input: string) {
						if (input === "?") {
							helpShown = !helpVisible(helpShown, lastInner);
							tui.requestRender();
							return;
						}
						if (input === "/") {
							// The action list is a separate picker: close the overlay, the caller runs the choice.
							if (!canPickAction) {
								note = "Run /balancer menu for the full action list.";
								tui.requestRender();
								return;
							}
							pickedAction = "menu";
							done();
							return;
						}
						if (matchesKey(input, Key.escape)) {
							if (rolePickerOpen) {
								rolePickerOpen = false;
								tui.requestRender();
								return;
							}
							if (poolEditOpen) {
								poolEditOpen = false;
								tui.requestRender();
								return;
							}
							done();
							return;
						}
						if (input === "q") {
							done();
							return;
						}
						note = undefined;
						const height = bodyHeight();

						if (matchesKey(input, Key.pageDown)) {
							offset += scrollStep(height);
							tui.requestRender();
							return;
						}
						if (matchesKey(input, Key.pageUp)) {
							offset = Math.max(0, offset - scrollStep(height));
							tui.requestRender();
							return;
						}

						if (input === "1" || input === "o") { tab = "overview"; rolePickerOpen = false; poolEditOpen = false; offset = 0; tui.requestRender(); return; }
						if (input === "2" || input === "roles") { tab = "roles"; poolEditOpen = false; offset = 0; tui.requestRender(); return; }
						if (input === "3" || input === "p") { tab = "pools"; rolePickerOpen = false; offset = 0; tui.requestRender(); return; }
						if (input === "4" || input === "advisor") { tab = "advisor"; rolePickerOpen = false; poolEditOpen = false; offset = 0; tui.requestRender(); return; }

						if (matchesKey(input, Key.tab)) {
							const nextIndex = (CONTROL_CENTER_TABS.indexOf(tab) + 1) % CONTROL_CENTER_TABS.length;
							tab = CONTROL_CENTER_TABS[nextIndex];
							rolePickerOpen = false;
							poolEditOpen = false;
							offset = 0;
							tui.requestRender();
							return;
						}

						if (input === "r") {
							note = "Refreshing AGY usage in background…";
							void pollAgy().then(fresh => {
								note = fresh ? "AGY usage refreshed!" : "AGY poll failed, kept cache.";
								tui.requestRender();
							});
							tui.requestRender();
							return;
						}

						if (input === "w") {
							done();
							setTimeout(() => {
								void runSetup(ctx);
							}, 50);
							return;
						}

						if (tab === "roles") {
							const availableTargets = buildAvailableModelTargets(cachedProviders, currentPoolConfigs);
							const rowCount = ROLE_CATALOG.length;
							const currentRole = ROLE_CATALOG[cursor];
							const store = loadProfilesStore();
							const activeProfileName = store?.active;

							if (rolePickerOpen) {
								if (matchesKey(input, Key.down)) {
									rolePickerCursor = (rolePickerCursor + 1) % Math.max(1, availableTargets.length);
									tui.requestRender();
									return;
								}
								if (matchesKey(input, Key.up)) {
									rolePickerCursor = (rolePickerCursor - 1 + availableTargets.length) % Math.max(1, availableTargets.length);
									tui.requestRender();
									return;
								}
								if (matchesKey(input, Key.enter) && activeProfileName && store) {
									const chosenModel = availableTargets[rolePickerCursor] ?? "pool/orchestrator";
									const currentProfile = store.profiles[activeProfileName] ?? {};
									currentProfile[currentRole.role] = {
										...(currentProfile[currentRole.role] ?? {}),
										model: chosenModel,
										thinking: currentProfile[currentRole.role]?.thinking ?? currentRole.defaultThinking,
									};
									store.profiles[activeProfileName] = currentProfile;
									try {
										const read = readProfiles();
										saveProfilesStore(store, read, { hasModel: (p, m) => Boolean(ctx.modelRegistry.find(p, m)) });
										note = `Assigned ${currentRole.role} → ${chosenModel}`;
									} catch (err) {
										note = `Failed to assign model: ${err instanceof Error ? err.message : String(err)}`;
									}
									rolePickerOpen = false;
									tui.requestRender();
									return;
								}
								return;
							}

							if (matchesKey(input, Key.down)) {
								cursor = (cursor + 1) % rowCount;
								followSelected = true;
								tui.requestRender();
								return;
							}
							if (matchesKey(input, Key.up)) {
								cursor = (cursor - 1 + rowCount) % rowCount;
								followSelected = true;
								tui.requestRender();
								return;
							}

							if (input === "t" && activeProfileName && store) {
								const currentProfile = store.profiles[activeProfileName] ?? {};
								const currentThinking = currentProfile[currentRole.role]?.thinking ?? currentRole.defaultThinking;
								const nextThinking = currentThinking === "low" ? "medium" : currentThinking === "medium" ? "high" : "low";
								currentProfile[currentRole.role] = {
									...(currentProfile[currentRole.role] ?? {}),
									model: currentProfile[currentRole.role]?.model ?? "pool/orchestrator",
									thinking: nextThinking,
								};
								store.profiles[activeProfileName] = currentProfile;
								try {
									const read = readProfiles();
									saveProfilesStore(store, read, { hasModel: (p, m) => Boolean(ctx.modelRegistry.find(p, m)) });
									note = `Set ${currentRole.role} thinking to ${nextThinking}`;
								} catch (err) {
									note = `Failed to save thinking: ${err instanceof Error ? err.message : String(err)}`;
								}
								tui.requestRender();
								return;
							}

							if (matchesKey(input, Key.enter)) {
								const currentProfile = activeProfileName && store ? store.profiles[activeProfileName] ?? {} : {};
								const currentModel = currentProfile[currentRole.role]?.model ?? "pool/orchestrator";
								const idx = availableTargets.indexOf(currentModel);
								rolePickerCursor = idx >= 0 ? idx : 0;
								rolePickerOpen = true;
								tui.requestRender();
								return;
							}

							if (input === "m" && activeProfileName && store) {
								const currentProfile = store.profiles[activeProfileName] ?? {};
								const currentModel = currentProfile[currentRole.role]?.model;
								const idx = currentModel ? availableTargets.indexOf(currentModel) : -1;
								const nextModel = availableTargets[(idx + 1) % availableTargets.length] ?? "pool/orchestrator";
								currentProfile[currentRole.role] = {
									...(currentProfile[currentRole.role] ?? {}),
									model: nextModel,
									thinking: currentProfile[currentRole.role]?.thinking ?? currentRole.defaultThinking,
								};
								store.profiles[activeProfileName] = currentProfile;
								try {
									const read = readProfiles();
									saveProfilesStore(store, read, { hasModel: (p, m) => Boolean(ctx.modelRegistry.find(p, m)) });
									note = `Assigned ${currentRole.role} → ${nextModel}`;
								} catch (err) {
									note = `Failed to assign model: ${err instanceof Error ? err.message : String(err)}`;
								}
								tui.requestRender();
								return;
							}

							if (input === "a" && activeProfileName && store && advisor) {
								const rec = advisor.recommendations.find(r => r.role === currentRole.role);
								if (rec) {
									const currentProfile = store.profiles[activeProfileName] ?? {};
									currentProfile[rec.role] = {
										model: rec.recommendedModel,
										thinking: rec.thinking,
									};
									store.profiles[activeProfileName] = currentProfile;
									try {
										const read = readProfiles();
										saveProfilesStore(store, read, { hasModel: (p, m) => Boolean(ctx.modelRegistry.find(p, m)) });
										note = `Applied recommendation to ${rec.role} → ${rec.recommendedModel} (${rec.thinking})`;
									} catch (err) {
										note = `Failed to apply: ${err instanceof Error ? err.message : String(err)}`;
									}
								}
								tui.requestRender();
								return;
							}
						}

						if (tab === "pools") {
							const activePoolCfg = currentPoolConfigs[poolCursor];
							const poolCandidateOptions = activePoolCfg
								? [...new Set([...activePoolCfg.candidates, ...allCandidateOptions])]
								: allCandidateOptions;

							if (poolEditOpen && activePoolCfg) {
								if (matchesKey(input, Key.down)) {
									poolCandidateCursor = (poolCandidateCursor + 1) % Math.max(1, poolCandidateOptions.length);
									tui.requestRender();
									return;
								}
								if (matchesKey(input, Key.up)) {
									poolCandidateCursor = (poolCandidateCursor - 1 + poolCandidateOptions.length) % Math.max(1, poolCandidateOptions.length);
									tui.requestRender();
									return;
								}
								if (matchesKey(input, Key.enter) || input === " ") {
									const cand = poolCandidateOptions[poolCandidateCursor];
									if (cand) {
										const nextCands = toggleCandidateInList(activePoolCfg.candidates, cand);
										if (nextCands.length === activePoolCfg.candidates.length && activePoolCfg.candidates.length === 1) {
											note = `pool/${activePoolCfg.id} must keep at least 1 candidate.`;
										} else {
											activePoolCfg.candidates = nextCands;
											try {
												const raw = JSON.parse(readFileSync(join(ROOT, "pools.json"), "utf8"));
												const updated = (raw.pools as { id: string; candidates: string[] }[]).map(entry =>
													entry.id === activePoolCfg.id ? { ...entry, candidates: nextCands } : entry,
												);
												writeConfigSafely(ROOT, { pools: updated });
												note = `Updated candidates for pool/${activePoolCfg.id}: ${nextCands.join(" → ")}`;
											} catch (err) {
												note = `Failed to save candidates: ${err instanceof Error ? err.message : String(err)}`;
											}
										}
									}
									tui.requestRender();
									return;
								}
								if (input === "u" || input === "d") {
									const cand = poolCandidateOptions[poolCandidateCursor];
									const idx = cand ? activePoolCfg.candidates.indexOf(cand) : -1;
									if (idx >= 0) {
										const delta = input === "u" ? -1 : 1;
										const nextCands = moveCandidateInList(activePoolCfg.candidates, idx, delta);
										activePoolCfg.candidates = nextCands;
										try {
											const raw = JSON.parse(readFileSync(join(ROOT, "pools.json"), "utf8"));
											const updated = (raw.pools as { id: string; candidates: string[] }[]).map(entry =>
												entry.id === activePoolCfg.id ? { ...entry, candidates: nextCands } : entry,
											);
											writeConfigSafely(ROOT, { pools: updated });
											note = `Reordered ${cand} in pool/${activePoolCfg.id}`;
										} catch (err) {
											note = `Failed to reorder: ${err instanceof Error ? err.message : String(err)}`;
										}
									} else {
										note = "Enable the candidate with Enter first before reordering.";
									}
									tui.requestRender();
									return;
								}
							}

							if (matchesKey(input, Key.down)) {
								poolCursor = (poolCursor + 1) % Math.max(1, currentPoolConfigs.length);
								tui.requestRender();
								return;
							}
							if (matchesKey(input, Key.up)) {
								poolCursor = (poolCursor - 1 + currentPoolConfigs.length) % Math.max(1, currentPoolConfigs.length);
								tui.requestRender();
								return;
							}
							if (matchesKey(input, Key.enter) && activePoolCfg) {
								poolEditOpen = !poolEditOpen;
								poolCandidateCursor = 0;
								tui.requestRender();
								return;
							}
							if (input === "s" && activePoolCfg) {
								const nextStrategy = activePoolCfg.strategy === "waterfall" ? "hybrid" : "waterfall";
								activePoolCfg.strategy = nextStrategy;
								try {
									const raw = JSON.parse(readFileSync(join(ROOT, "pools.json"), "utf8"));
									const updated = (raw.pools as { id: string; strategy?: string }[]).map(entry =>
										entry.id === activePoolCfg.id ? { ...entry, strategy: nextStrategy } : entry,
									);
									writeConfigSafely(ROOT, { pools: updated });
									note = `Switched pool/${activePoolCfg.id} strategy to ${nextStrategy}`;
								} catch (err) {
									note = `Failed to update strategy: ${err instanceof Error ? err.message : String(err)}`;
								}
								tui.requestRender();
								return;
							}
						}

						if (tab === "advisor") {
							if (matchesKey(input, Key.down) && advisor) {
								cursor = (cursor + 1) % advisor.recommendations.length;
								followSelected = true;
								tui.requestRender();
								return;
							}
							if (matchesKey(input, Key.up) && advisor) {
								cursor = (cursor - 1 + advisor.recommendations.length) % advisor.recommendations.length;
								followSelected = true;
								tui.requestRender();
								return;
							}
							if (input === "g" && !advisorLoading) {
								advisorLoading = true;
								note = "Querying lightweight AI advisor (~350 tokens)…";
								tui.requestRender();
								void recommendRolesWithAdvisor(
									{
										providers: cachedProviders,
										pools: currentPoolConfigs,
										quotaByKey: Object.fromEntries(
											[...fold().state.snapshot().entries()].map(([k, v]) => [k, v.remainingFraction ?? 1]),
										),
									},
									{ aiRunner: createDefaultCliAiRunner(AGY_BIN) },
								).then(report => {
									advisor = report;
									advisorLoading = false;
									note = `AI Advisor updated: ${report.summary} (~${report.estimatedTokens} tokens used)`;
									tui.requestRender();
								}).catch(err => {
									advisorLoading = false;
									note = `AI query failed: ${err instanceof Error ? err.message : String(err)}; using heuristic`;
									tui.requestRender();
								});
								return;
							}

							if (input === "a" && advisor) {
								const store = loadProfilesStore();
								const activeProfileName = store?.active;
								if (activeProfileName && store) {
									store.profiles[activeProfileName] = applyRecommendationsToProfile(
										store.profiles[activeProfileName],
										advisor.recommendations,
									);
									try {
										const read = readProfiles();
										saveProfilesStore(store, read, { hasModel: (p, m) => Boolean(ctx.modelRegistry.find(p, m)) });
										note = `Applied all ${advisor.recommendations.length} recommendations to profile "${activeProfileName}"!`;
									} catch (err) {
										note = `Failed to apply recommendations: ${err instanceof Error ? err.message : String(err)}`;
									}
								} else {
									note = "No active profile in profiles.json to apply to.";
								}
								tui.requestRender();
								return;
							}
						}
					},
					render(width: number): string[] {
						const inner = Math.max(40, width - 4);
						lastInner = inner;
						const showHelp = helpVisible(helpShown, inner);
						const height = bodyHeight();
						const store = loadProfilesStore();
						const activeProfileName = store?.active;
						const activeProfileRoles = activeProfileName ? store?.profiles?.[activeProfileName] : undefined;

						const availableTargets = buildAvailableModelTargets(cachedProviders, currentPoolConfigs);
						const activePoolCfg = currentPoolConfigs[poolCursor];
						const poolCandidateOptions = activePoolCfg
							? [...new Set([...activePoolCfg.candidates, ...allCandidateOptions])]
							: allCandidateOptions;

						const rowLines: number[] = [];
						const rendered = renderControlCenter({
							hover,
							pressed,
							rowLines,
							tab,
							width: helpMainWidth(inner, showHelp),
							folded: fold(),
							now: Date.now(),
							circuitStatus: circuitBreaker.getStatus(),
							activeProfile: activeProfileName,
							pools: currentPoolConfigs,
							roles: activeProfileRoles,
							providers: cachedProviders,
							advisor,
							advisorLoading,
							cursor,
							poolCursor,
							note,
							lastRoutedByPool: Object.fromEntries(lastRouted),
							rolePickerOpen,
							rolePickerTargets: availableTargets,
							rolePickerCursor,
							poolEditOpen,
							poolCandidateOptions,
							poolCandidateCursor,
						});
						const allLines = withHelp(rendered, { kind: "tab", tab, strategy: tab === "pools" ? currentPoolConfigs[poolCursor]?.strategy : undefined }, inner, showHelp, text => tone("dim", text));

						if (followSelected) {
							followSelected = false;
							const selectedRow = allLines.findIndex(line => /^│ ▸ /.test(plain(line)));
							if (selectedRow >= 0) {
								offset = keepRowVisible(offset, Math.min(selectedRow + 2, allLines.length - 1), allLines.length, height);
								offset = keepRowVisible(offset, selectedRow, allLines.length, height);
							}
						}

						const sliced = sliceViewport(allLines, offset, height);
						offset = sliced.offset;
						const title = " ai-balancer · control center ";
						const top = border("╭─") + theme.bold(theme.fg("accent", title)) + border(`${"─".repeat(Math.max(0, inner + 1 - visibleWidth(title)))}╮`);
						const row = (styled: string) =>
							`${border("│")} ${styled}${" ".repeat(Math.max(0, inner - visibleWidth(styled)))} ${border("│")}`;
						const rows = sliced.lines.map((line, i) => {
							const styled =
								line !== plain(line) ? paint(line, (tone, text) => theme.fg(tone, text)) :
								/^[A-Z0-9\[]/.test(line) ? theme.fg("accent", line) :
								line;
							const rowIndex = rowLines.indexOf(sliced.offset + i);
							const state = rowIndex < 0 ? undefined : pressed?.kind === "row" && pressed.index === rowIndex ? "pressed" : hover?.kind === "row" && hover.index === rowIndex ? "hover" : undefined;
							return row(truncateToWidth(emphasize(styled, state), inner));
						});
						const cells = layoutButtons(controlCenterButtons(tab), inner);
						const buttonRows = cells.length === 0 ? 0 : cells[cells.length - 1].row + 1;
						const footer = Array.from({ length: buttonRows }, (_unused, r) => {
							const inRow = cells.filter(c => c.row === r);
							const text = inRow
								.map((c: ButtonCell, i) => {
									const gap = i === 0 ? "" : " ".repeat(c.start - inRow[i - 1].end);
									const state = pressed?.kind === "button" && pressed.id === c.button.id ? "pressed" : hover?.kind === "button" && hover.id === c.button.id ? "hover" : undefined;
									return gap + emphasize(theme.fg(c.button.input ? "accent" : "dim", c.text), state);
								})
								.join("");
							return row(text);
						});
						hitLayout = { tabAreas: tabHitAreas(controlCenterTabLabels()), rowLines, offset: sliced.offset, bodyRows: rows.length, buttonCells: cells };
						pressed = undefined;
						return [top, ...rows, row(border("─".repeat(inner))), ...footer, border(`╰${"─".repeat(inner + 2)}╯`)];
					},
					// Pointer events only reach overlays under TuiAltScreen; in the main screen this is never called and the keys still work.
					handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
						if (!hitLayout) return undefined;
						if (event.type === "wheel") {
							if (!event.wheelDelta) return undefined;
							offset = wheelOffset(offset, event.wheelDelta);
							return { handled: true, render: true };
						}
						const target = hitTest(hitLayout, event.x, event.y);
						if (event.type === "move") {
							if (sameTarget(target, hover)) return { handled: true, render: false };
							hover = target;
							return { handled: true, render: true };
						}
						if (event.type !== "click" || event.button !== "left" || !target) return undefined;
						pressed = target;
						if (target.kind === "tab") {
							sendKey(String(CONTROL_CENTER_TABS.indexOf(target.tab as ControlCenterTab) + 1));
						} else if (target.kind === "button") {
							const input = controlCenterButtons(tab).find(b => b.id === target.id)?.input;
							if (input) sendKey(input);
						} else if (!rolePickerOpen && !poolEditOpen) {
							const selected = tab === "pools" ? poolCursor : cursor;
							if (target.index === selected) {
								sendKey("\r");
							} else {
								if (tab === "pools") poolCursor = target.index;
								else cursor = target.index;
								followSelected = true;
							}
						}
						return { handled: true, render: true };
					},
					invalidate() {},
					dispose() {
						clearInterval(interval);
						closePanel = undefined;
					},
				};
				sendKey = input => component.handleInput(input);
				return component;
			},
			{ overlay: true, overlayOptions: { width: "90%", minWidth: 72, anchor: "center" } },
		).then(() => pickedAction);
	};

	const openControlCenter = async (ctx: ExtensionContext, initialTab: ControlCenterTab = "overview"): Promise<void> => {
		await showControlCenter(ctx, initialTab, false);
	};

	const runClassicSetup = (ctx: ExtensionContext): Promise<boolean> =>
		runSetupWizard(ctx, ROOT, {
			hasModel: (provider, model) => Boolean(ctx.modelRegistry.find(provider, model)),
			agyBin: AGY_BIN,
			onOpenControlCenter: () => openControlCenter(ctx),
		});

	/** `/balancer setup`: the stepper overlay, or the classic prompts when there is no UI or no custom overlay. */
	const runSetup = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") {
			await runClassicSetup(ctx);
			return;
		}
		await openSetupStepper(ctx);
	};

	/** Pi hands overlays raw input in either terminal protocol; the view works on the legacy sequences. */
	const canonicalKey = (data: string): string => {
		if (matchesKey(data, Key.escape)) return "\x1b";
		if (matchesKey(data, Key.enter)) return "\r";
		if (matchesKey(data, Key.space)) return " ";
		if (matchesKey(data, "shift+tab")) return "\x1b[Z";
		if (matchesKey(data, Key.tab)) return "\t";
		for (const [name, seq] of [["up", "\x1b[A"], ["down", "\x1b[B"], ["right", "\x1b[C"], ["left", "\x1b[D"]] as const) if (matchesKey(data, name)) return seq;
		return data;
	};

	const openSetupStepper = async (ctx: ExtensionContext): Promise<void> => {
		const detected = detectSystemProviders();
		if (!detected.some(p => p.detected && p.kind === "subscription")) {
			ctx.ui.notify(`ai-balancer: ${t("setup.stepper.noProviders")}`, "warning");
			return;
		}
		const readJson = (file: string): unknown => {
			try {
				return JSON.parse(readFileSync(join(ROOT, file), "utf8"));
			} catch {
				return null;
			}
		};
		const store = loadProfilesStore();
		const current: StepperCurrent = { pools: readJson("pools.json"), integrations: readJson("integrations.json"), profiles: store };
		const recommended = generateRecommendedConfig(detected.filter(p => p.detected), { hasModel: (provider, model) => Boolean(ctx.modelRegistry.find(provider, model)) }).pools;
		let screen = initScreen(initStepper(detected, recommended, store?.profiles?.[store.active ?? ""] ?? {}), current);

		const effect = await ctx.ui.custom<StepperEffect>(
			(tui, theme, _keybindings, done) => {
				const bodyRows = () => Math.max(8, ((tui as { terminal?: { rows?: number } }).terminal?.rows ?? 40) - 14);
				const paint = (tone: StepperTone, text: string) => theme.fg(stepperThemeColor(tone), text);
				const apply = (event: StepperEvent) => {
					const result = stepperInput(screen, event);
					const changed = result.state !== screen;
					screen = result.state;
					if (result.effect !== "none") done(result.effect);
					else if (changed) tui.requestRender();
				};
				return {
					render(width: number): string[] {
						const inner = Math.max(20, width - 4);
						const view = renderStepper(screen, { width, bodyRows: bodyRows(), paint });
						screen = { ...screen, hits: view.hits, offset: view.offset, helpOn: view.helpOn, follow: false };
						const border = (text: string) => theme.fg("border", text);
						const row = (text: string) => `${border("│")} ${truncateToWidth(text, inner, "…", true)} ${border("│")}`;
						return [border(`╭${"─".repeat(inner + 2)}╮`), ...view.lines.map(row), border(`╰${"─".repeat(inner + 2)}╯`)];
					},
					handleInput(data: string) {
						apply({ type: "key", data: canonicalKey(data) });
					},
					// Pointer events only reach overlays under TuiAltScreen; in the main screen this is never called and the keys still work.
					handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
						if (event.type === "wheel") apply({ type: "mouse", kind: "wheel", x: event.x, y: event.y, wheelDelta: event.wheelDelta });
						else if (event.type === "move" || (event.type === "click" && event.button === "left")) apply({ type: "mouse", kind: event.type, x: event.x, y: event.y });
						else return undefined;
						// `apply` requests the render itself, and only when something changed.
						return { handled: true, render: false };
					},
					invalidate() {},
				};
			},
			{ overlay: true, overlayOptions: { width: "90%", minWidth: 72, anchor: "center" } },
		);

		if (effect !== "save") {
			ctx.ui.notify(`ai-balancer: ${t("setup.stepper.cancelled")}`, "info");
			return;
		}
		const result = applyStepper(screen.stepper, {
			root: ROOT,
			current,
			profilesPath: DEFAULT_PROFILES_PATH,
			writeConfig: writeConfigSafely,
			writeProfiles: (name, roles) => saveProfileRoles(DEFAULT_PROFILES_PATH, name, roles, (provider, model) => Boolean(ctx.modelRegistry.find(provider, model))),
		});
		if (!result.ok) {
			ctx.ui.notify(`ai-balancer: ${t("setup.stepper.saveFailed", { error: result.error ?? "" })}`, "error");
			return;
		}
		if (result.profilesError) ctx.ui.notify(`ai-balancer: ${t("setup.stepper.profilesFailed", { error: result.profilesError })}`, "warning");
		ctx.ui.notify(`ai-balancer: ${t("setup.stepper.saved", { files: result.written.join(", ") })}${result.backups.length ? ` (backups: ${result.backups.join(", ")})` : ""}`, "info");
		refreshStatus(ctx);
	};

	const togglePanel = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (closePanel) {
			closePanel();
			return;
		}
		void openControlCenter(ctx);
	};

	/** `/balancer` with no arguments: pick an action with the arrows, Enter runs it, Esc cancels. */
	const pickBalancerAction = (ctx: ExtensionCommandContext): Promise<string | undefined> =>
		ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
			const menuItems = balancerMenu();
			const list = new SelectList(menuItems, menuItems.length, {
				selectedPrefix: text => theme.fg("accent", text),
				selectedText: text => theme.fg("accent", text),
				description: text => theme.fg("muted", text),
				scrollInfo: text => theme.fg("muted", text),
				noMatch: text => theme.fg("muted", text),
			});
			list.onSelect = item => done(item.value);
			list.onCancel = () => done(undefined);
			return {
				render(width: number): string[] {
					return [theme.bold(theme.fg("accent", "ai-balancer")), ...list.render(width), theme.fg("muted", "↑↓ move · enter run · esc cancel")];
				},
				handleInput(data: string) {
					list.handleInput(data);
					tui.requestRender();
				},
				invalidate() {
					list.invalidate();
				},
			};
		});

	// Permissions are granted and revoked here, in Pi, never from the web (design §10.1).
	const runPermissionsCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const now = Date.now();
		const loaded = loadPermissions(DATA_DIR);
		if (loaded.error) ctx.ui.notify(`ai-balancer: ${loaded.error}; every grant counts as off`, "warning");
		try {
			if (args === "") {
				ctx.ui.notify(formatGrants(loaded.grants, now), "info");
				return;
			}
			if (args === "grant") {
				const draft = await runPermissionGrant({ ui: ctx.ui, profiles: loadProfilesStore(), pools: loadPools().pools, now });
				if (!draft) {
					ctx.ui.notify("ai-balancer: nothing granted", "info");
					return;
				}
				const grant = addGrant(DATA_DIR, draft, Date.now());
				ctx.ui.notify(`ai-balancer: grant ${grant.id} saved (${grant.level}): the balancer may use the covered models for those roles until ${new Date(grant.expiresAt).toISOString().slice(0, 16)}Z`, "info");
				return;
			}
			let id = args.slice(7).trim();
			if (id === "") {
				const active = loaded.grants.filter(grant => grant.expiresAt > now);
				if (active.length === 0) {
					ctx.ui.notify("ai-balancer: no active grants to revoke", "info");
					return;
				}
				const options = [...active.map(grant => `${grant.id} · ${grant.level} · roles ${grant.roles.join(", ")}`), "all"];
				const picked = await ctx.ui.select("Revoke which grant?", options);
				if (!picked) return;
				id = picked === "all" ? "all" : picked.split(" · ")[0];
			}
			if (id !== "all" && !loaded.grants.some(grant => grant.id === id)) {
				ctx.ui.notify(`ai-balancer: no grant ${id}; list them with /balancer permissions`, "warning");
				return;
			}
			if (!(await ctx.ui.confirm("Revoke permission?", id === "all" ? "Revoke every grant; the level goes back to off." : `Revoke ${id}.`))) return;
			const removed = revokeGrants(DATA_DIR, id, Date.now());
			ctx.ui.notify(`ai-balancer: revoked ${removed.length} grant${removed.length === 1 ? "" : "s"}`, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	// 30 days of history with each request's recorded pool and role, for the simulator.
	const replayInputs = (now: number) => {
		const history = loadRequests(now);
		const tasks = readAgentTasks();
		const sessionSelections = new Map<string, Array<{ ts: number; pool: string | null }>>();
		const getSelections = (sessionId: string) => {
			let selections = sessionSelections.get(sessionId);
			if (selections === undefined) {
				const path = sessionIndex.lookup(sessionId, tasks.get(sessionId)?.sessionPath).path ?? findSessionFile(DEFAULT_SESSIONS_ROOT, sessionId);
				selections = path ? readPoolSelections(path) : [];
				sessionSelections.set(sessionId, selections);
			}
			return selections;
		};
		return {
			history,
			poolOf: (request: HistoryEntry) => poolOfSelection(getSelections(request.session), request.ts),
			roleOf: (request: HistoryEntry) => resolveRole(request, tasks),
		};
	};

	// Lab mode (design §9): a draft of pools.json and profiles.json, applied only from Pi.
	const runLabCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const paths = { labDir: LAB_DIR, poolsPath: join(ROOT, "pools.json"), profilesPath: DEFAULT_PROFILES_PATH };
		const liveTexts = (): LabTexts => {
			const read = readProfiles(paths.profilesPath);
			return { pools: readFileSync(paths.poolsPath, "utf8"), profiles: "store" in read ? read.raw : null };
		};
		try {
			if (args === "new") {
				if (hasDraft(LAB_DIR) && !(await ctx.ui.confirm("Replace the lab draft?", "A draft already exists; its edits are lost."))) return;
				const base = createDraft(paths, Date.now(), { replace: true });
				const files = [join(LAB_DIR, LAB_POOLS), ...(base.profiles !== null ? [join(LAB_DIR, LAB_PROFILES)] : [])];
				ctx.ui.notify(
					`ai-balancer: lab draft created. Edit ${files.join(" and ")}, then /balancer lab diff and lab simulate.${base.profiles === null ? " profiles.json is missing or unusable: the draft holds pools only." : ""}`,
					"info",
				);
				return;
			}
			if (args === "discard") {
				if (!hasDraft(LAB_DIR)) {
					ctx.ui.notify("ai-balancer: no lab draft to discard", "info");
					return;
				}
				if (!(await ctx.ui.confirm("Discard the lab draft?", "Its edits are lost; the live files stay as they are."))) return;
				discardDraft(LAB_DIR);
				ctx.ui.notify("ai-balancer: lab draft discarded", "info");
				return;
			}
			if (args === "undo") {
				if (!hasUndo(LAB_DIR)) {
					ctx.ui.notify("ai-balancer: nothing to undo", "info");
					return;
				}
				if (!(await ctx.ui.confirm("Undo the last lab apply?", "The files the last apply wrote go back to their backups, if nobody changed them since; the current text is backed up first."))) return;
				const result = undoApply({ labDir: LAB_DIR, dataDir: DATA_DIR });
				const filesDesc = result.files.map(f => `${basename(f.path)} from ${basename(f.restoredFrom)} (the applied text is kept in ${basename(f.backup)})`).join(", ");
				ctx.ui.notify(`ai-balancer: lab undo restored ${filesDesc}`, "info");
				return;
			}
			const draft = readDraft(LAB_DIR);
			if ("error" in draft) {
				ctx.ui.notify(`${draft.error}${args === "" && hasUndo(LAB_DIR) ? ". /balancer lab undo can restore the files the last apply replaced." : ""}`, "info");
				return;
			}
			const diff = diffLab(liveTexts(), draft);
			if (args === "") {
				const age = Math.round((Date.now() - draft.base.createdAt) / 60_000);
				const undoNote = hasUndo(LAB_DIR) ? " /balancer lab undo is available." : "";
				ctx.ui.notify(
					`ai-balancer: lab draft from ${age} min ago in ${LAB_DIR}: ${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"}, ${diff.issues.length} issue${diff.issues.length === 1 ? "" : "s"}. Next: lab diff, lab simulate, lab apply, lab discard.${undoNote}`,
					"info",
				);
				return;
			}
			if (args === "diff") {
				ctx.ui.notify(formatLabDiff(diff), diff.issues.length ? "warning" : "info");
				return;
			}
			if (args === "apply") {
				if (diff.issues.length) {
					ctx.ui.notify(formatLabDiff(diff), "warning");
					return;
				}
				if (diff.changes.length === 0) {
					ctx.ui.notify("ai-balancer: draft has no changes to apply", "info");
					return;
				}
				if (!(await ctx.ui.confirm("Apply the lab draft?", formatApplyConfirm(diff)))) {
					ctx.ui.notify("ai-balancer: nothing applied", "info");
					return;
				}
				const result = applyDraft({
					paths,
					dataDir: DATA_DIR,
					hasModel: (p, m) => Boolean(ctx.modelRegistry.find(p, m)),
				});
				const filesDesc = result.files.map(f => `${basename(f.path)} (backup ${basename(f.backup)})`).join(", ");
				const poolsNote = result.files.some(f => f.path === paths.poolsPath) ? " pools.json takes effect after /reload or a Pi restart." : "";
				const profilesNote = result.files.some(f => f.path === paths.profilesPath) ? " profiles.json reaches new sessions only." : "";
				ctx.ui.notify(`ai-balancer: applied the lab draft: ${filesDesc}.${poolsNote}${profilesNote} Undo with /balancer lab undo.`, "info");
				return;
			}
			if (args === "simulate") {
				if (diff.issues.length) {
					ctx.ui.notify(formatLabDiff(diff), "warning");
					return;
				}
				const live = liveTexts();
				const current = activeRoutes(live.profiles === null ? null : loadProfilesStore(paths.profilesPath));
				const drafted = draft.profiles === null ? current : activeRoutes(JSON.parse(draft.profiles) as ProfilesStore);
				const { history, poolOf, roleOf } = replayInputs(Date.now());
				const report = simulate({
					pools: parsePools(JSON.parse(draft.pools)),
					baseline: loadPools().pools,
					history,
					poolOf: profilePoolOf(poolOf, roleOf, current, drafted),
					baselinePoolOf: poolOf,
					roleOf,
				});
				const text = [
					formatSimulation(report, "lab draft"),
					"- Requests of a role follow the active profile's route (a repository pin or declaration can choose another profile)",
					"",
					formatRoleMoves(roleMoves(history.requests, roleOf, current, drafted)),
					...diff.notes.map(note => `Note: ${note}`),
				].join("\n");
				ctx.ui.notify(text, "info");
				return;
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	const formatAlreadyDecided = (loan: Loan) => {
		const at = loan.decidedAt ?? loan.endedAt;
		return `ai-balancer: loan ${loan.id} already decided by ${loan.decidedBy ?? loan.status}${at === undefined ? "" : ` at ${clock(at)}`}`;
	};

	// The end-of-loan choice. The journal is re-read first: when another Pi
	// already decided, nothing is written, profiles.json included.
	const handleEndedLoanDecision = async (
		loan: Loan,
		action: "keep" | "revert",
		ctx: ExtensionCommandContext | ExtensionContext,
	): Promise<void> => {
		if (action === "keep") {
			const confirmInfo = formatKeepLoanConfirm(loan, DEFAULT_PROFILES_PATH);
			if (!(await ctx.ui.confirm(confirmInfo.title, confirmInfo.message))) return;
		}
		try {
			withLoansLock(DATA_DIR, () => {
				const fresh = readLoans(DATA_DIR).loans;
				const target = fresh.find(l => l.id === loan.id);
				if (!target || target.status !== "ended") {
					ctx.ui.notify(target ? formatAlreadyDecided(target) : `ai-balancer: no loan ${loan.id}`, "warning");
					return;
				}
				const now = Date.now();
				const { loans: nextLoans, loan: decided } = decideLoan(fresh, loan.id, { action }, now);
				if (action === "keep") {
					const read = readProfiles(DEFAULT_PROFILES_PATH);
					if (!("store" in read)) {
						ctx.ui.notify(`ai-balancer: cannot save profile: ${read.error}`, "error");
						return;
					}
					// A pool target is one of this balancer's virtual models.
					const hasModel = (p: string, m: string) =>
						p === POOL_PROVIDER ? pools.some(pool => pool.id === m) : ctx.modelRegistry.find(p, m) !== undefined;
					keepLoanInProfile(loan, read, { path: DEFAULT_PROFILES_PATH, now, hasModel });
				}
				writeLoans(DATA_DIR, nextLoans);
				auditLoan(DATA_DIR, now, decided);
				ctx.ui.notify(
					action === "keep"
						? `ai-balancer: kept ${decided.to} for ${decided.role} in profile ${decided.profile}`
						: `ai-balancer: reverted ${decided.role} back to ${decided.from}`,
					"info",
				);
				ctx.ui.setWidget("ai-balancer-loans", loanWidget(nextLoans, now));
			});
		} catch (error) {
			ctx.ui.notify(`ai-balancer: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	const runBalancerCommand = async (command: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (command === "lang" || command.startsWith("lang ")) {
				const arg = command.split(/\s+/)[1];
				const describe = (res: { lang: "en" | "es"; source: string }) => ({
					lang: t(`menu.langName.${res.lang}`),
					source: t(`menu.langSource.${res.source}`),
				});
				if (!arg) {
					ctx.ui.notify(t("menu.langActive", describe(initLang(SETTINGS_FILE))), "info");
					return;
				}
				if (arg === "es" || arg === "en") {
					saveLangSetting(SETTINGS_FILE, arg);
					setLang(arg);
					ctx.ui.notify(t("menu.langChanged", { lang: t(`menu.langName.${arg}`) }), "info");
					return;
				}
				// "auto": forget the saved choice and follow the system language again.
				saveLangSetting(SETTINGS_FILE, undefined);
				ctx.ui.notify(t("menu.langAuto", describe(initLang(SETTINGS_FILE))), "info");
				return;
			}
			if (command === "help") {
				ctx.ui.notify(glossaryText(), "info");
				return;
			}
			if (command === "panel") {
				togglePanel(ctx);
				return;
			}
			if (command === "usage") {
				openUsagePanel(ctx);
				return;
			}
			if (command === "refresh") {
				const fresh = await pollAgy();
				refreshStatus(ctx);
				ctx.ui.notify(fresh ? "ai-balancer: agy quota refreshed" : "ai-balancer: agy /usage failed, keeping the last snapshot", fresh ? "info" : "warning");
				return;
			}
			if (command === "setup") {
				await runSetup(ctx);
				return;
			}
			if (command === "setup classic") {
				await runClassicSetup(ctx);
				return;
			}
			if (command === "report") {
				// A snapshot of the live web page: same renderer, data inlined, read-only.
				const handlers = webHandlers();
				const report = handlers.getReport() as WebReport;
				const sessions: Record<string, unknown> = {};
				for (const id of snapshotSessionIds(report)) {
					const detail = handlers.getSession(id);
					if (detail !== undefined) sessions[id] = detail;
				}
				const reportPath = join(ctx.sessionManager.getCwd(), "report.html");
				writeFileSync(reportPath, webSnapshotHtml({ report, sessions }), { encoding: "utf8", mode: 0o600 });
				ctx.ui.notify(`ai-balancer: web report snapshot written to ${reportPath}`, "info");
				return;
			}
			if (command === "switch-cost") {
				ctx.ui.notify(formatSwitchCostReport(fitWindows(readHistory(DATA_DIR, Date.now()))), "info");
				return;
			}
			if (command === "loans") {
				const { loans } = readLoans(DATA_DIR);
				const now = Date.now();
				const tasks = readAgentTasks();
				const getSummary = (l: Loan) => {
					const { requests } = loadRequests(Date.now());
					const roleRequests = requests.map(r => ({ ...r, role: resolveRole(r, tasks) }));
					return loanSummary(l, roleRequests);
				};
				const res = await chooseLoanAction(ctx.ui, loans, now, getSummary);
				if (!res) return;

				try {
					const fresh = readLoans(DATA_DIR).loans;
					const target = fresh.find(l => l.id === res.id);
					if (!target) {
						ctx.ui.notify(`ai-balancer: no loan ${res.id}`, "error");
						return;
					}

					if (res.choice.action === "keep" || res.choice.action === "revert") {
						await handleEndedLoanDecision(target, res.choice.action, ctx);
						return;
					}

					withLoansLock(DATA_DIR, () => {
						const fresh = readLoans(DATA_DIR).loans;
						const target = fresh.find(l => l.id === res.id);
						if (!target) {
							ctx.ui.notify(`ai-balancer: no loan ${res.id}`, "error");
							return;
						}

						if (res.choice.action === "apply" || res.choice.action === "cancel") {
							if (target.status !== "proposed") {
								ctx.ui.notify(formatAlreadyDecided(target), "warning");
								return;
							}
							const now = Date.now();
							const { loans: nextLoans, loan: decided } = decideLoan(fresh, res.id, res.choice, now);
							writeLoans(DATA_DIR, nextLoans);
							auditLoan(DATA_DIR, now, decided);
							const msg =
								res.choice.action === "cancel"
									? `ai-balancer: cancelled loan ${decided.id}`
									: `ai-balancer: applied loan ${decided.id}: ${decided.role} ${decided.from} → ${decided.to}`;
							ctx.ui.notify(msg, "info");
							ctx.ui.setWidget("ai-balancer-loans", loanWidget(nextLoans, now));
							return;
						}

						if (res.choice.action === "end") {
							if (target.status !== "active") {
								ctx.ui.notify(formatAlreadyDecided(target), "warning");
								return;
							}
							const now = Date.now();
							const { loans: nextLoans, loan: decided } = decideLoan(fresh, res.id, res.choice, now);
							writeLoans(DATA_DIR, nextLoans);
							auditLoan(DATA_DIR, now, decided);
							ctx.ui.notify(`ai-balancer: ended loan ${decided.id}: ${decided.role} back to ${decided.from}`, "info");
							ctx.ui.setWidget("ai-balancer-loans", loanWidget(nextLoans, now));
							return;
						}
					});
				} catch (error) {
					ctx.ui.notify(`ai-balancer: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (command === "simulate" || command.startsWith("simulate ")) {
				const poolsFile = command === "simulate" ? "pools.json" : command.slice(8).trim() || "pools.json";
				const filePath = join(ROOT, poolsFile);
				let raw: unknown;
				try {
					raw = JSON.parse(readFileSync(filePath, "utf8"));
				} catch (err) {
					ctx.ui.notify(`ai-balancer: cannot read ${poolsFile}: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
				const validated = validatePoolsConfig(raw);
				if (!validated.valid) {
					for (const issue of validated.issues) {
						ctx.ui.notify(`ai-balancer: ${issue.path}: ${issue.message}`, "warning");
					}
					return;
				}
				const { history, poolOf, roleOf } = replayInputs(Date.now());
				// The current pools.json replayed the same way is the baseline the draft is compared with.
				const report = simulate({
					pools: validated.data ?? [],
					baseline: loadPools().pools,
					history,
					poolOf,
					roleOf,
				});

				const text = formatSimulation(report, poolsFile);
				ctx.ui.notify(text, "info");
				return;
			}
			if (command === "lab" || command.startsWith("lab ")) {
				await runLabCommand(command.slice(3).trim(), ctx);
				return;
			}
			if (command === "permissions" || command.startsWith("permissions ")) {
				await runPermissionsCommand(command.slice(11).trim(), ctx);
				return;
			}
			if (command === "serve" || command.startsWith("serve ")) {
				const serveArgs = command === "serve" ? "" : command.slice(5).trim();
				const parsed = parseServeArgs(serveArgs);
				if (parsed.action === "error") {
					ctx.ui.notify(parsed.message, "error");
					return;
				}
				if (parsed.action === "stop") {
					const stopped = await stopServing();
					ctx.ui.notify(stopped ? "ai-balancer: stopped" : "ai-balancer: not serving", "info");
					return;
				}
				if (parsed.action === "setup") {
					await runLanSetup({
						ui: ctx.ui,
						networks: () => privateIPv4Networks(),
						firewall: () => detectFirewall((command, args) => new Promise((resolve, reject) => execFile(command, args, { timeout: 3000 }, (error, stdout) => (error && !stdout ? reject(error) : resolve({ stdout: String(stdout) }))))),
						running: () => runningWebServer(),
						stop: () => stopServing(),
						start: async (port, tls) => (await startServing({ port, lan: true, tls: lanTls(tls), tokenFile: WEB_TOKEN_FILE, handlers: webHandlers() })).server,
						probe: async (url, tls) => {
							let pinned: string | undefined;
							try {
								pinned = tls ? readFileSync(tls.cert, "utf8") : undefined;
							} catch (error) {
								return (error as NodeJS.ErrnoException).code ?? String(error);
							}
							return probeReport(url, 3000, pinned);
						},
						saveAutostart: config => writeAutostart(WEB_SERVE_FILE, config),
						tls: {
							current: () => readTls(WEB_SERVE_FILE),
							create: (kind, addresses) => createCertificate(kind, WEB_TLS_DIR, addresses, runTool),
							inspect: (config, address) => inspectCertificate(config, address),
							save: config => writeTls(WEB_SERVE_FILE, config),
						},
					});
					return;
				}
				if (parsed.action === "autostart-off") {
					const was = readAutostart(WEB_SERVE_FILE);
					writeAutostart(WEB_SERVE_FILE, undefined);
					ctx.ui.notify(was ? "ai-balancer: web report autostart off; it keeps running until /balancer serve stop" : "ai-balancer: web report autostart was already off", "info");
					return;
				}
				if (parsed.action === "status") {
					const server = runningWebServer();
					const lan = server?.lan ? ` (LAN: ${server.lanUrls.join(", ") || "no private IPv4 address found on this machine"})` : "";
					ctx.ui.notify(server ? `ai-balancer: ${server.url}${lan}` : "ai-balancer: not serving", "info");
					return;
				}
				if (parsed.action === "start") {
					try {
						const { server } = await startServing({
							port: parsed.port,
							lan: parsed.lan === true,
							tls: parsed.lan === true ? lanTls() : undefined,
							tokenFile: WEB_TOKEN_FILE,
							handlers: webHandlers(),
						});
						ctx.ui.notify(formatServeStart(server.url, server.port, undefined, undefined, server.lan ? server.lanUrls : undefined), "info");
					} catch (err) {
						ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
					}
					return;
				}
			}
			if (command === "open" || command.startsWith("open ")) {
				const id = command === "open" ? "" : command.slice(4).trim();
				if (!isValidSessionId(id)) {
					ctx.ui.notify("ai-balancer: invalid session id", "warning");
					return;
				}
				const tasks = readAgentTasks();
				const found = sessionIndex.lookup(id, tasks.get(id)?.sessionPath);
				if (!found.path) {
					ctx.ui.notify("ai-balancer: no session file found for this session; it may have been deleted", "warning");
					return;
				}
				const label = found.firstMessage ? clipAlias(found.firstMessage) : (tasks.get(id)?.label ?? id.slice(0, 8));
				await ctx.waitForIdle();
				await runHudChoice(ctx, { kind: "open", path: found.path, label });
				return;
			}
	};

	pi.registerCommand("balancer", {
		description: "ai-balancer: `/balancer` opens the Control Center (`/balancer roles|pools|advisor` jumps to a tab, `/balancer menu` lists every action); or run one directly: `/balancer panel|usage|refresh|setup [classic]|report|simulate|switch-cost|loans|lab|permissions`, `/balancer serve [lan] [port|stop|status]`, `/balancer open <id>`, `/balancer lang [es|en|auto]`",
		handler: async (args, ctx) => {
			const resolved = resolveBalancerArgs(args);
			if (resolved.kind === "unknown") {
				ctx.ui.notify(resolved.message, "warning");
				return;
			}
			if (resolved.kind === "command") {
				await runBalancerCommand(resolved.command, ctx);
				return;
			}
			if (!ctx.hasUI) return;
			if (resolved.kind === "overlay") {
				// `/` inside the overlay asks for the flat action list; it runs after the overlay closes.
				if (closePanel) closePanel();
				if ((await showControlCenter(ctx, resolved.tab ?? "overview", true)) !== "menu") return;
			}
			const choice = await pickBalancerAction(ctx);
			if (choice) await runBalancerCommand(choice, ctx);
		},
	});
	pi.registerCommand("hud", {
		description: "gentle-hud: subscription windows and pace, API cost, the sessions that spend the most (enter opens, x compacts, f continues fresh) and suggestions",
		// The panel is awaited first: switchSession, fork and compact run from the command context, never under the open overlay.
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const choice = await openHud(ctx);
			if (choice) await runHudChoice(ctx, choice);
		},
	});
	pi.registerShortcut("ctrl+alt+b", { description: "Toggle the ai-balancer panel", handler: togglePanel });
	pi.registerShortcut("ctrl+alt+u", { description: "Open the ai-balancer advanced usage panel", handler: openUsagePanel });

	pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
		bindWebHandlers(webHandlers());
		const autostart = readAutostart(WEB_SERVE_FILE);
		if (autostart && !runningWebServer()) {
			Promise.resolve()
				.then(() => startServing({ port: autostart.port, lan: true, tls: lanTls(), tokenFile: WEB_TOKEN_FILE, handlers: webHandlers() }))
				.catch(error => {
					if (ctx.hasUI) ctx.ui.notify(`ai-balancer: web report autostart failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				});
		}
		lastTurnTelemetry = undefined;
		lastContextTokens = undefined;
		registerPoolUsage();
		try {
			pruneHistory(DATA_DIR, Date.now());
		} catch {
			// Retention retries on the next session start.
		}
		try {
			pruneExpired(DATA_DIR, Date.now());
		} catch {
			// Expired grants already count as off; pruning retries on the next start.
		}
		try {
			const now = Date.now();
			const { loans } = readLoans(DATA_DIR);
			const { ended } = expireLoans(loans, now);
			commitLoanChanges(
				DATA_DIR,
				now,
				ended.map(loan => ({ from: loans.find(l => l.id === loan.id)?.status ?? "active", loan })),
			);
		} catch {
			// Crash recovery retries on the next session start.
		}
		if (!ctx.hasUI) return;
		for (const warning of poolWarnings) ctx.ui.notify(`ai-balancer: pools.json ${warning}`, "warning");
		pollAgyIfStale();
		refreshStatus(ctx);
		timer = setInterval(() => {
			pollAgyIfStale();
			refreshStatus(ctx);
		}, AGY_POLL_MS);
		timer.unref?.();
		refreshLoans(ctx);
		loanTimer = setInterval(() => {
			refreshLoans(ctx);
		}, 15_000);
		loanTimer.unref?.();
	});

	// The context notice must clear right after a compaction, not on the next response.
	pi.on("session_compact", (_event, ctx) => refreshStatus(ctx));

	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.hasUI || !ctx.isIdle()) return;
		try {
			const { loans } = readLoans(DATA_DIR);
			const loan = loans.find(l => l.status === "ended" && !promptedEndedLoans.has(l.id));
			if (!loan) return;
			promptedEndedLoans.add(loan.id);

			const now = Date.now();
			const { requests } = loadRequests(now);
			const tasks = readAgentTasks();
			const roleRequests = requests.map(r => ({ ...r, role: resolveRole(r, tasks) }));
			const summary = loanSummary(loan, roleRequests);

			const action = await reviewEndedLoan(ctx.ui, loan, summary);
			if (!action) return;

			await handleEndedLoanDecision(loan, action, ctx);
		} catch (error) {
			ctx.ui.notify(`ai-balancer: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async event => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (loanTimer) clearInterval(loanTimer);
		loanTimer = undefined;
		closePanel?.();
		// A session switch reloads the extension; the web server outlives it and stops only when Pi quits.
		if (event.reason === "quit") await stopServing();
	});
}
