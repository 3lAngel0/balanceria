import { type AgyGroupUsage, agyQuotaKeyForGroup } from "./agy-usage.ts";

// In-memory availability per quota key ("antigravity/claude",
// "claude-bridge/claude", ...). A key is unavailable while an exhaustion
// window is open; it reopens on its own when the window passes.

export interface QuotaEntry {
	exhaustedUntil: number | undefined;
	reason: string | undefined;
	/** Last known remaining fraction, 0..1, when a usage report provided one. */
	remainingFraction: number | undefined;
	resetAt: number | undefined;
}

export interface QuotaStateOptions {
	/** Window applied when a provider reports exhaustion without a reset time. */
	defaultCooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 30 * 60_000;

export class QuotaState {
	readonly #entries = new Map<string, QuotaEntry>();
	readonly #defaultCooldownMs: number;

	constructor(options: QuotaStateOptions = {}) {
		this.#defaultCooldownMs = options.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
	}

	#entry(key: string): QuotaEntry {
		let entry = this.#entries.get(key);
		if (!entry) {
			entry = { exhaustedUntil: undefined, reason: undefined, remainingFraction: undefined, resetAt: undefined };
			this.#entries.set(key, entry);
		}
		return entry;
	}

	markExhausted(key: string, until: number | undefined, reason: string, now: number = Date.now()): void {
		const entry = this.#entry(key);
		entry.exhaustedUntil = until ?? now + this.#defaultCooldownMs;
		entry.reason = reason;
		entry.remainingFraction = 0;
	}

	isAvailable(key: string, now: number = Date.now()): boolean {
		const until = this.#entries.get(key)?.exhaustedUntil;
		return until === undefined || now > until;
	}

	/** Epoch ms when the key becomes available again; undefined when it already is. */
	availableAt(key: string, now: number = Date.now()): number | undefined {
		return this.isAvailable(key, now) ? undefined : this.#entries.get(key)?.exhaustedUntil;
	}

	/** Last known remaining fraction (0..1) if recorded. */
	remainingFraction(key: string): number | undefined {
		return this.#entries.get(key)?.remainingFraction;
	}

	/** Set or update quota fraction for a key. */
	setQuotaFraction(key: string, fraction: number, resetAt?: number, now: number = Date.now()): void {
		const entry = this.#entry(key);
		entry.remainingFraction = fraction;
		entry.resetAt = resetAt;
		if (fraction <= 0) {
			entry.exhaustedUntil = resetAt ?? now + this.#defaultCooldownMs;
			entry.reason = "quota spent";
		} else {
			entry.exhaustedUntil = undefined;
			entry.reason = undefined;
		}
	}

	applyAgyUsage(groups: Map<string, AgyGroupUsage>, now: number = Date.now()): void {
		for (const [group, usage] of groups) {
			const key = agyQuotaKeyForGroup(group);
			if (!key) continue;
			const entry = this.#entry(key);
			entry.remainingFraction = usage.remainingFraction;
			entry.resetAt = usage.resetAt;
			if (usage.remainingFraction <= 0) {
				entry.exhaustedUntil = usage.resetAt ?? now + this.#defaultCooldownMs;
				entry.reason = `${group} quota spent`;
			} else {
				entry.exhaustedUntil = undefined;
				entry.reason = undefined;
			}
		}
	}

	snapshot(): ReadonlyMap<string, Readonly<QuotaEntry>> {
		return new Map([...this.#entries].map(([key, entry]) => [key, { ...entry }]));
	}
}
