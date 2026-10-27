import { readHistory, type HistoryData } from "../../../src/history.ts";
import { summarizeQuota } from "../../../src/quota-report.ts";
import { summarizeHistory } from "../../../src/usage-panel.ts";
import { buildDecisions } from "../../../src/web-data.ts";
import type { Decisions, QuotaSeries, TokenSeries, Usage } from "../ui/api.ts";

// Summarizes 30 days of balancer history for the panel: token and quota charts,
// and the routing decisions. Any read error yields empty views and never throws.

const EMPTY_HISTORY: HistoryData = { requests: [], samples: [], errors: [], routes: [] };

/** One history read for every widget that needs it. */
export function buildPanelHistory(dataDir: string, now: number): { usage: Usage; decisions: Decisions } {
	let history = EMPTY_HISTORY;
	try {
		history = readHistory(dataDir, now);
	} catch {
		// Missing or unreadable history: empty views.
	}
	return { usage: usageFrom(history, now), decisions: buildDecisions(history.routes) };
}

export function buildUsage(dataDir: string, now: number): Usage {
	return buildPanelHistory(dataDir, now).usage;
}

function usageFrom(history: HistoryData, now: number): Usage {
	try {
		const stats = summarizeHistory(history.requests, now);
		const quotaReport = summarizeQuota(history, now);
		const days = stats.daily.map(d => d.day);

		const providers = new Set<string>();
		for (const day of stats.daily) {
			for (const provider of Object.keys(day.byProvider)) {
				providers.add(provider);
			}
		}

		const tokens: TokenSeries[] = [...providers]
			.map(provider => {
				const daily = stats.daily.map(day => day.byProvider[provider] ?? 0);
				const total = daily.reduce((sum, v) => sum + v, 0);
				return { provider, total, daily };
			})
			.sort((a, b) => b.total - a.total || a.provider.localeCompare(b.provider));

		const quota: QuotaSeries[] = quotaReport.series.map(s => ({
			limit: s.limit,
			window: s.window,
			peak: s.peak,
			fills: s.fills,
			daily: s.daily,
		}));

		return { days, tokens, quota };
	} catch {
		return {
			days: summarizeHistory([], now).daily.map(d => d.day),
			tokens: [],
			quota: [],
		};
	}
}
