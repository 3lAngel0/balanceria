import { dayKey, RETENTION_DAYS, type HistoryData, type HistoryEntry, type QuotaSample } from "./history.ts";
import { quotaKeyFor } from "./pools.ts";
import { limitNameForKey } from "./usage-source.ts";

// Turns the quota reads and quota errors in the history into a report: when
// each subscription window filled, how often, how long it stayed blocked, and
// which session spent the most tokens before it did.

const FULL_PERCENT = 99.5;
const HOUR_MS = 3_600_000;
const SAME_ERROR_MS = 30 * 60_000;

export interface Fill {
	limit: string;
	/** Empty for a fill only known from a quota error. */
	window: string;
	key?: string;
	ts: number;
	resetAt: number | null;
	windowSeconds: number;
	source: "usage" | "error";
	hitSession?: string;
	hitProject?: string;
	top?: { session: string; project: string; tokens: number };
}

export interface QuotaSeries {
	limit: string;
	window: string;
	key?: string;
	fills: number;
	peak: number | null;
	/** Highest used percent per local day, oldest first; the last element is today. */
	daily: (number | null)[];
	/** Indexes into `daily` that hold a fill. */
	fillDays: number[];
	/** Mean time between consecutive fills. */
	everyMs?: number;
	/** Mean time from the window start to the fill. */
	fillsInMs?: number;
	/** Total time spent blocked, up to now. */
	blockedMs: number;
}

export interface CurrentRead {
	limit: string;
	window: string;
	usedPercent: number;
	resetAt: number | null;
	ts: number;
	/** The window already reset since this read, so the percent is out of date. */
	stale: boolean;
}

export interface QuotaReport {
	current: CurrentRead[];
	series: QuotaSeries[];
	fills: Fill[];
}

function seriesId(limit: string, window: string): string {
	return `${limit}\u0000${window}`;
}

function windowEnd(fill: Fill): number {
	return fill.resetAt ?? fill.ts + fill.windowSeconds * 1000;
}

function windowStart(fill: Fill): number {
	return windowEnd(fill) - fill.windowSeconds * 1000;
}

/** The last `RETENTION_DAYS` local day keys, oldest first. */
function recentDays(now: number): string[] {
	const days: string[] = [];
	for (let back = RETENTION_DAYS - 1; back >= 0; back--) {
		const date = new Date(now);
		date.setDate(date.getDate() - back);
		days.push(dayKey(date.getTime()));
	}
	return days;
}

function sameCycle(previous: QuotaSample, sample: QuotaSample): boolean {
	if (previous.resetAt !== null && sample.resetAt !== null) return Math.abs(previous.resetAt - sample.resetAt) < HOUR_MS;
	if (previous.resetAt === null && sample.resetAt === null) return sample.ts - previous.ts < sample.windowSeconds * 1000;
	return false;
}

function usageFills(samples: QuotaSample[]): Fill[] {
	const bySeries = new Map<string, QuotaSample[]>();
	for (const sample of samples) {
		const id = seriesId(sample.limit, sample.window);
		bySeries.set(id, [...(bySeries.get(id) ?? []), sample]);
	}
	const fills: Fill[] = [];
	for (const list of bySeries.values()) {
		let previous: QuotaSample | undefined;
		for (const sample of list) {
			const full = sample.usedPercent >= FULL_PERCENT;
			const continued = previous !== undefined && previous.usedPercent >= FULL_PERCENT && sameCycle(previous, sample);
			if (full && !continued) {
				fills.push({
					limit: sample.limit,
					window: sample.window,
					key: sample.key,
					ts: sample.ts,
					resetAt: sample.resetAt,
					windowSeconds: sample.windowSeconds,
					source: "usage",
				});
			}
			previous = sample;
		}
	}
	return fills;
}

function mergeErrors(fills: Fill[], data: HistoryData): void {
	const limitOfKey = new Map<string, string>();
	for (const sample of data.samples) if (sample.key) limitOfKey.set(sample.key, sample.limit);
	const errorOnly: Fill[] = [];
	for (const error of data.errors) {
		const limit = limitOfKey.get(error.key) ?? limitNameForKey(error.key);
		const usage = fills.find(
			fill => fill.source === "usage" && fill.limit === limit && windowStart(fill) <= error.ts && error.ts <= windowEnd(fill),
		);
		if (usage) {
			usage.ts = Math.min(usage.ts, error.ts);
			usage.source = "error";
			usage.hitSession = error.session;
			usage.hitProject = error.project;
			continue;
		}
		const repeated = errorOnly.some(
			fill => fill.limit === limit && (fill.resetAt !== null ? fill.resetAt > error.ts : error.ts - fill.ts < SAME_ERROR_MS),
		);
		if (repeated) continue;
		const fill: Fill = {
			limit,
			window: "",
			key: error.key,
			ts: error.ts,
			resetAt: error.until,
			windowSeconds: 0,
			source: "error",
			hitSession: error.session,
			hitProject: error.project,
		};
		errorOnly.push(fill);
		fills.push(fill);
	}
}

function tokensOf(request: HistoryEntry): number {
	return request.input + request.output + request.cacheRead + request.cacheWrite;
}

function attachTop(fill: Fill, requests: HistoryEntry[]): void {
	if (fill.windowSeconds <= 0 || !fill.key) return;
	const start = windowStart(fill);
	const totals = new Map<string, { project: string; tokens: number }>();
	for (const request of requests) {
		if (request.ts < start || request.ts > fill.ts || quotaKeyFor(request.provider, request.model) !== fill.key) continue;
		const total = totals.get(request.session) ?? { project: request.project, tokens: 0 };
		total.tokens += tokensOf(request);
		totals.set(request.session, total);
	}
	for (const [session, total] of totals) {
		if (!fill.top || total.tokens > fill.top.tokens) fill.top = { session, project: total.project, tokens: total.tokens };
	}
}

function mean(values: number[]): number | undefined {
	return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildSeries(samples: QuotaSample[], fills: Fill[], days: string[], now: number): QuotaSeries[] {
	const byId = new Map<string, QuotaSeries>();
	const ensure = (limit: string, window: string, key: string | undefined): QuotaSeries => {
		const id = seriesId(limit, window);
		let series = byId.get(id);
		if (!series) {
			series = { limit, window, fills: 0, peak: null, daily: days.map(() => null), fillDays: [], blockedMs: 0 };
			byId.set(id, series);
		}
		series.key ??= key;
		return series;
	};
	for (const sample of samples) {
		const series = ensure(sample.limit, sample.window, sample.key);
		series.peak = Math.max(series.peak ?? sample.usedPercent, sample.usedPercent);
		const index = days.indexOf(dayKey(sample.ts));
		if (index >= 0) series.daily[index] = Math.max(series.daily[index] ?? sample.usedPercent, sample.usedPercent);
	}
	const fillsOf = new Map<QuotaSeries, Fill[]>();
	for (const fill of fills) {
		const series = ensure(fill.limit, fill.window, fill.key);
		fillsOf.set(series, [...(fillsOf.get(series) ?? []), fill]);
	}
	for (const [series, list] of fillsOf) {
		const ascending = [...list].sort((a, b) => a.ts - b.ts);
		series.fills = ascending.length;
		series.fillDays = [...new Set(ascending.map(fill => days.indexOf(dayKey(fill.ts))).filter(index => index >= 0))].sort((a, b) => a - b);
		series.everyMs = mean(ascending.slice(1).map((fill, index) => fill.ts - ascending[index].ts));
		series.fillsInMs = mean(ascending.filter(fill => fill.resetAt !== null && fill.windowSeconds > 0).map(fill => fill.ts - windowStart(fill)));
		series.blockedMs = ascending.reduce((sum, fill) => (fill.resetAt === null ? sum : sum + Math.max(0, Math.min(fill.resetAt, now) - fill.ts)), 0);
	}
	return [...byId.values()].sort((a, b) => a.limit.localeCompare(b.limit) || a.window.localeCompare(b.window));
}

function currentReads(samples: QuotaSample[], now: number): CurrentRead[] {
	const latest = new Map<string, QuotaSample>();
	for (const sample of samples) {
		const previous = latest.get(seriesId(sample.limit, sample.window));
		if (!previous || sample.ts >= previous.ts) latest.set(seriesId(sample.limit, sample.window), sample);
	}
	return [...latest.values()]
		.map(sample => ({
			limit: sample.limit,
			window: sample.window,
			usedPercent: sample.usedPercent,
			resetAt: sample.resetAt,
			ts: sample.ts,
			stale: sample.resetAt !== null && sample.resetAt <= now,
		}))
		.sort((a, b) => a.limit.localeCompare(b.limit) || a.window.localeCompare(b.window));
}

export function summarizeQuota(data: HistoryData, now: number): QuotaReport {
	const days = recentDays(now);
	const oldest = days[0];
	const recent = {
		requests: data.requests,
		samples: data.samples.filter(sample => dayKey(sample.ts) >= oldest).sort((a, b) => a.ts - b.ts),
		errors: data.errors.filter(error => dayKey(error.ts) >= oldest).sort((a, b) => a.ts - b.ts),
	};
	const fills = usageFills(recent.samples);
	mergeErrors(fills, recent);
	for (const fill of fills) attachTop(fill, recent.requests);
	fills.sort((a, b) => b.ts - a.ts);
	return {
		current: currentReads(recent.samples, now),
		series: buildSeries(recent.samples, fills, days, now),
		fills,
	};
}
