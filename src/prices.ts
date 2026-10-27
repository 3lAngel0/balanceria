import { readFileSync } from "node:fs";

// API list prices, used to show what the logged tokens would cost per request
// and to compare that against the monthly subscription price.

export interface TokenRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** USD per million tokens. */
export interface ModelPrice extends TokenRates {
	/** Rates that replace the base ones once a request's prompt exceeds `threshold` tokens. */
	longContext?: TokenRates & { threshold: number };
}

export interface PriceTable {
	asOf?: string;
	models: Record<string, ModelPrice>;
	/** Monthly USD per provider; only the numbers the user filled in. */
	subscriptions: Record<string, number>;
}

export interface RequestTokens {
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRates(raw: unknown): TokenRates | undefined {
	if (!isRecord(raw)) return undefined;
	if (!RATE_KEYS.every(key => typeof raw[key] === "number" && Number.isFinite(raw[key]))) return undefined;
	return { input: raw.input as number, output: raw.output as number, cacheRead: raw.cacheRead as number, cacheWrite: raw.cacheWrite as number };
}

function parsePrice(raw: unknown): ModelPrice | undefined {
	const rates = parseRates(raw);
	if (!rates || !isRecord(raw)) return undefined;
	const price: ModelPrice = rates;
	const long = raw.longContext;
	const longRates = parseRates(long);
	if (longRates && isRecord(long) && typeof long.threshold === "number" && Number.isFinite(long.threshold)) {
		price.longContext = { ...longRates, threshold: long.threshold };
	}
	return price;
}

export function parsePrices(raw: unknown): PriceTable {
	const table: PriceTable = { models: {}, subscriptions: {} };
	if (!isRecord(raw)) return table;
	if (typeof raw.asOf === "string") table.asOf = raw.asOf;
	if (isRecord(raw.models)) {
		for (const [id, row] of Object.entries(raw.models)) {
			const price = parsePrice(row);
			if (price) table.models[id] = price;
		}
	}
	if (isRecord(raw.subscriptions)) {
		for (const [provider, monthly] of Object.entries(raw.subscriptions)) {
			if (typeof monthly === "number" && Number.isFinite(monthly)) table.subscriptions[provider] = monthly;
		}
	}
	return table;
}

function normalizeId(id: string): string {
	return id.toLowerCase().replaceAll(".", "-");
}

/** Exact id, else the longest table id the model id extends (`claude-opus-5-5-thinking`). */
export function priceFor(table: PriceTable, modelId: string): ModelPrice | undefined {
	const id = normalizeId(modelId);
	let best: { length: number; price: ModelPrice } | undefined;
	for (const [key, price] of Object.entries(table.models)) {
		const normalized = normalizeId(key);
		if (normalized !== id && !id.startsWith(`${normalized}-`)) continue;
		if (!best || normalized.length > best.length) best = { length: normalized.length, price };
	}
	return best?.price;
}

/** USD for one request, or undefined when the model has no price. */
export function requestCost(table: PriceTable, request: RequestTokens): number | undefined {
	const price = priceFor(table, request.model);
	if (!price) return undefined;
	const prompt = request.input + request.cacheRead + request.cacheWrite;
	const rates = price.longContext && prompt > price.longContext.threshold ? price.longContext : price;
	return (request.input * rates.input + request.output * rates.output + request.cacheRead * rates.cacheRead + request.cacheWrite * rates.cacheWrite) / 1e6;
}

export function loadPrices(path: string): PriceTable {
	try {
		return parsePrices(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return parsePrices(undefined);
	}
}
