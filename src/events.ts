import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgyGroupUsage } from "./agy-usage.ts";
import { QuotaState } from "./state.ts";

// Every Pi process (the main session and each subagent child) appends to one
// JSONL log and folds it to get shared quota state and token totals. Small
// appends with O_APPEND do not interleave, so no lock is needed.

export const EVENTS_FILE = "events.jsonl";

export type BalancerEvent =
	| { type: "exhausted"; ts: number; key: string; until: number | undefined; reason: string }
	| { type: "agy-usage"; ts: number; groups: Record<string, AgyGroupUsage> }
	/** The remaining fraction (0..1) of one quota key, read from its usage endpoint. */
	| { type: "quota"; ts: number; key: string; remainingFraction: number; resetAt: number | undefined }
	| {
		type: "usage";
		ts: number;
		provider: string;
		model: string;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	}
	| { type: "route"; ts: number; pool: string; provider: string; reason: string };

export interface ProviderTokens {
	last5h: number;
	today: number;
	last7d: number;
	requests: number;
	lastModel: string | undefined;
}

export interface FoldedEvents {
	state: QuotaState;
	tokens: Map<string, ProviderTokens>;
	lastAgyUsageAt: number | undefined;
	lastRoute: Extract<BalancerEvent, { type: "route" }> | undefined;
}

const HOUR = 3_600_000;

function startOfLocalDay(now: number): number {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function foldEvents(events: readonly BalancerEvent[], now: number): FoldedEvents {
	const state = new QuotaState();
	const tokens = new Map<string, ProviderTokens>();
	const dayStart = startOfLocalDay(now);
	let lastAgyUsageAt: number | undefined;
	let lastRoute: FoldedEvents["lastRoute"];

	for (const event of events) {
		if (!event || typeof event !== "object" || !isFiniteNumber(event.ts)) continue;
		switch (event.type) {
			case "exhausted":
				if (typeof event.key === "string") state.markExhausted(event.key, event.until, event.reason, event.ts);
				break;
			case "agy-usage":
				if (event.groups && typeof event.groups === "object") {
					state.applyAgyUsage(new Map(Object.entries(event.groups)), event.ts);
					lastAgyUsageAt = event.ts;
				}
				break;
			case "quota":
				if (typeof event.key === "string" && isFiniteNumber(event.remainingFraction) && event.remainingFraction >= 0 && event.remainingFraction <= 1) {
					state.setQuotaFraction(event.key, event.remainingFraction, isFiniteNumber(event.resetAt) ? event.resetAt : undefined, event.ts);
				}
				break;
			case "usage": {
				if (typeof event.provider !== "string" || !isFiniteNumber(event.input) || !isFiniteNumber(event.output)) break;
				if (now - event.ts > 7 * 24 * HOUR) break;
				const total = event.input + event.output;
				const entry = tokens.get(event.provider) ?? { last5h: 0, today: 0, last7d: 0, requests: 0, lastModel: undefined };
				entry.last7d += total;
				entry.requests += 1;
				entry.lastModel = event.model;
				if (event.ts >= dayStart) entry.today += total;
				if (now - event.ts <= 5 * HOUR) entry.last5h += total;
				tokens.set(event.provider, entry);
				break;
			}
			case "route":
				lastRoute = event;
				break;
		}
	}
	return { state, tokens, lastAgyUsageAt, lastRoute };
}

export function appendEvent(dataDir: string, event: BalancerEvent): void {
	mkdirSync(dataDir, { recursive: true });
	appendFileSync(join(dataDir, EVENTS_FILE), `${JSON.stringify(event)}\n`);
}

export function readEvents(dataDir: string): BalancerEvent[] {
	let raw: string;
	try {
		raw = readFileSync(join(dataDir, EVENTS_FILE), "utf8");
	} catch {
		return [];
	}
	const events: BalancerEvent[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line) as BalancerEvent);
		} catch {
			// A torn line from a crash mid-write; skip it.
		}
	}
	return events;
}
