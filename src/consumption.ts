import { dayKey, type HistoryData, type HistoryEntry, type QuotaSample } from "./history.ts";
import { classifyProvider, type Integration } from "./integrations.ts";
import { requestCost, type PriceTable } from "./prices.ts";

// Consumption per integration for the HUD: tokens and quota windows (with a
// pace forecast) for subscriptions, requests and USD for API integrations,
// and the providers that integrations.json does not list.
//
// Pace rules, per quota window (same key + window):
// - Only samples of the current window count: the resetAt of the latest sample
//   must be in the future, and other samples must share it within 2 minutes
//   (the real value jitters by milliseconds between reads).
// - Of those, take the samples in the 60 minutes up to the latest one.
//   rate = (latest % - earliest %) / elapsed hours.
// - No pace (null) with fewer than 2 samples there, under 5 minutes between
//   them, or a rate <= 0: a forecast from that would be noise.
// - fullAt = latest sampledAt + (100 - latest %) / rate; it fills before the
//   reset when fullAt < resetAt.
// - At 100% or more the window is already full: fullAt is the first sample of
//   the current window that reached it, and it counts as filling before reset.

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SAME_RESET_MS = 2 * MIN_MS;
const PACE_SPAN_MS = HOUR_MS;
const PACE_MIN_ELAPSED_MS = 5 * MIN_MS;

export interface Pace {
	percentPerHour: number;
	fullAt: number;
	fillsBeforeReset: boolean;
}

export interface WindowConsumption {
	key: string;
	window: string;
	usedPercent: number;
	resetAt: number | null;
	sampledAt: number;
	windowSeconds: number;
	points: { ts: number; percent: number }[];
	pace: Pace | null;
}

export interface TokenTotals {
	last5h: number;
	today: number;
	last7d: number;
}

export interface SubscriptionConsumption {
	provider: string;
	label: string;
	tokens: TokenTotals;
	windows: WindowConsumption[];
}

export interface CostPeriod {
	requests: number;
	usd: number;
	/** Some requests had no price, so `usd` is a lower bound. */
	partial: boolean;
}

export interface ApiConsumption {
	provider: string;
	label: string;
	today: CostPeriod;
	last7d: CostPeriod;
	last30d: CostPeriod;
}

export interface UnclassifiedConsumption {
	provider: string;
	requests: number;
	tokens: number;
}

export interface ConsumptionSummary {
	subscriptions: SubscriptionConsumption[];
	apis: ApiConsumption[];
	unclassified: UnclassifiedConsumption[];
}

function tokensOf(request: HistoryEntry): number {
	return request.input + request.output + request.cacheRead + request.cacheWrite;
}

function computePace(current: QuotaSample[], now: number): Pace | null {
	const latest = current[current.length - 1];
	if (latest.resetAt === null) return null;
	const resetAt = latest.resetAt;
	if (resetAt <= now) return null;
	const span = current.filter(sample => sample.ts >= latest.ts - PACE_SPAN_MS);
	const elapsed = latest.ts - span[0].ts;
	const rate = span.length >= 2 && elapsed >= PACE_MIN_ELAPSED_MS ? (latest.usedPercent - span[0].usedPercent) / (elapsed / HOUR_MS) : 0;
	if (latest.usedPercent >= 100) {
		const first = current.find(sample => sample.usedPercent >= 100) ?? latest;
		return { percentPerHour: Math.max(rate, 0), fullAt: first.ts, fillsBeforeReset: true };
	}
	if (span.length < 2 || elapsed < PACE_MIN_ELAPSED_MS || rate <= 0) return null;
	const fullAt = latest.ts + ((100 - latest.usedPercent) / rate) * HOUR_MS;
	return { percentPerHour: rate, fullAt, fillsBeforeReset: fullAt < resetAt };
}

function windowsOf(provider: string, samples: readonly QuotaSample[], now: number): WindowConsumption[] {
	const groups = new Map<string, QuotaSample[]>();
	for (const sample of samples) {
		if (!sample.key?.startsWith(`${provider}/`)) continue;
		const id = `${sample.key}\u0000${sample.window}`;
		groups.set(id, [...(groups.get(id) ?? []), sample]);
	}
	const windows: WindowConsumption[] = [];
	for (const group of groups.values()) {
		const ordered = [...group].sort((a, b) => a.ts - b.ts);
		const latest = ordered[ordered.length - 1];
		const current = ordered.filter(sample =>
			latest.resetAt === null || sample.resetAt === null ? sample.resetAt === latest.resetAt : Math.abs(sample.resetAt - latest.resetAt) <= SAME_RESET_MS,
		);
		windows.push({
			key: latest.key!,
			window: latest.window,
			usedPercent: latest.usedPercent,
			resetAt: latest.resetAt,
			sampledAt: latest.ts,
			windowSeconds: latest.windowSeconds,
			points: current.map(sample => ({ ts: sample.ts, percent: sample.usedPercent })),
			pace: computePace(current, now),
		});
	}
	return windows.sort((a, b) => a.key.localeCompare(b.key) || a.window.localeCompare(b.window));
}

function costPeriod(requests: readonly HistoryEntry[], prices: PriceTable): CostPeriod {
	const period: CostPeriod = { requests: requests.length, usd: 0, partial: false };
	for (const request of requests) {
		const cost = requestCost(prices, request);
		if (cost === undefined) period.partial = true;
		else period.usd += cost;
	}
	return period;
}

export function summarizeConsumption(data: HistoryData, integrations: readonly Integration[], prices: PriceTable, now: number): ConsumptionSummary {
	const today = dayKey(now);
	const byProvider = new Map<string, HistoryEntry[]>();
	for (const request of data.requests) byProvider.set(request.provider, [...(byProvider.get(request.provider) ?? []), request]);
	const sum = (requests: readonly HistoryEntry[]) => requests.reduce((total, request) => total + tokensOf(request), 0);
	const since = (requests: readonly HistoryEntry[], ms: number) => requests.filter(request => request.ts >= now - ms);

	const subscriptions: SubscriptionConsumption[] = [];
	const apis: ApiConsumption[] = [];
	for (const integration of integrations) {
		const requests = byProvider.get(integration.provider) ?? [];
		if (integration.kind === "subscription") {
			subscriptions.push({
				provider: integration.provider,
				label: integration.label,
				tokens: {
					last5h: sum(since(requests, 5 * HOUR_MS)),
					today: sum(requests.filter(request => dayKey(request.ts) === today)),
					last7d: sum(since(requests, 7 * DAY_MS)),
				},
				windows: windowsOf(integration.provider, data.samples, now),
			});
		} else {
			apis.push({
				provider: integration.provider,
				label: integration.label,
				today: costPeriod(requests.filter(request => dayKey(request.ts) === today), prices),
				last7d: costPeriod(since(requests, 7 * DAY_MS), prices),
				last30d: costPeriod(since(requests, 30 * DAY_MS), prices),
			});
		}
	}

	const unclassified: UnclassifiedConsumption[] = [];
	for (const [provider, requests] of byProvider) {
		if (classifyProvider(provider, integrations).kind !== "unclassified") continue;
		unclassified.push({ provider, requests: requests.length, tokens: sum(requests) });
	}
	unclassified.sort((a, b) => b.tokens - a.tokens || a.provider.localeCompare(b.provider));
	return { subscriptions, apis, unclassified };
}
