import { type AgyGroupUsage, agyQuotaKeyForGroup } from "./agy-usage.ts";
import { STALL_OR_TIMEOUT_PATTERN } from "./quota-errors.ts";

// In-memory availability per quota key ("antigravity/claude",
// "claude-bridge/claude", ...). A key is unavailable while an exhaustion
// window is open; it reopens on its own when the window passes.

export interface QuotaEntry {
	exhaustedUntil: number | undefined;
	reason: string | undefined;
	/** Last known remaining fraction, 0..1, when a usage report provided one. */
	remainingFraction: number | undefined;
	resetAt: number | undefined;
	/**
	 * Reset time the provider itself gave with its refusal. A usage reading with margin cannot lift
	 * the exhaustion before it: the provider's answer beats a different window's remaining fraction.
	 * Undefined when the cooldown was only our default guess.
	 */
	providerUntil: number | undefined;
	/** Number of consecutive stall/timeout failures without a successful response in between. */
	consecutiveStalls?: number;
}

export interface QuotaStateOptions {
	/** Window applied when a provider reports exhaustion without a reset time. */
	defaultCooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const SECOND_STALL_COOLDOWN_MS = 30 * 60_000;
const REPEATED_STALL_COOLDOWN_MS = 2 * 3_600_000;

export class QuotaState {
	readonly #entries = new Map<string, QuotaEntry>();
	readonly #defaultCooldownMs: number;

	constructor(options: QuotaStateOptions = {}) {
		this.#defaultCooldownMs = options.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
	}

	#entry(key: string): QuotaEntry {
		let entry = this.#entries.get(key);
		if (!entry) {
			entry = { exhaustedUntil: undefined, reason: undefined, remainingFraction: undefined, resetAt: undefined, providerUntil: undefined, consecutiveStalls: 0 };
			this.#entries.set(key, entry);
		}
		return entry;
	}

	markExhausted(key: string, until: number | undefined, reason: string, now: number = Date.now()): void {
		const entry = this.#entry(key);
		const isStall = STALL_OR_TIMEOUT_PATTERN.test(reason);
		const stalls = isStall ? (entry.consecutiveStalls ?? 0) + 1 : 0;
		entry.consecutiveStalls = stalls;
		let effectiveUntil = until;
		if (stalls === 2) {
			effectiveUntil = Math.max(until ?? 0, now + SECOND_STALL_COOLDOWN_MS);
		} else if (stalls >= 3) {
			effectiveUntil = Math.max(until ?? 0, now + REPEATED_STALL_COOLDOWN_MS);
		}
		entry.exhaustedUntil = effectiveUntil ?? now + this.#defaultCooldownMs;
		entry.providerUntil = effectiveUntil;
		entry.reason = reason;
		entry.remainingFraction = 0;
	}

	/** Clears stale exhaustion or stall lockouts when a model on `key` produces a real response. */
	recordSuccess(key: string, _now: number = Date.now()): void {
		const entry = this.#entries.get(key);
		if (!entry) return;
		entry.exhaustedUntil = undefined;
		entry.providerUntil = undefined;
		entry.reason = undefined;
		entry.consecutiveStalls = 0;
		if (entry.remainingFraction === 0) {
			entry.remainingFraction = undefined;
		}
	}

	/** Records a reading for `entry`: spent until `resetAt`, or free, unless the provider's own block is still open. */
	#applyReading(entry: QuotaEntry, fraction: number, resetAt: number | undefined, reason: string, now: number): void {
		entry.remainingFraction = fraction;
		entry.resetAt = resetAt;
		const blockedUntil = entry.providerUntil !== undefined && now <= entry.providerUntil ? entry.providerUntil : undefined;
		if (fraction <= 0) {
			entry.exhaustedUntil = Math.max(resetAt ?? now + this.#defaultCooldownMs, blockedUntil ?? 0);
			entry.reason = reason;
		} else if (blockedUntil === undefined) {
			entry.exhaustedUntil = undefined;
			entry.reason = undefined;
			entry.providerUntil = undefined;
		}
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
		this.#applyReading(this.#entry(key), fraction, resetAt, "quota spent", now);
	}

	applyAgyUsage(groups: Map<string, AgyGroupUsage>, now: number = Date.now()): void {
		for (const [group, usage] of groups) {
			const key = agyQuotaKeyForGroup(group);
			if (!key) continue;
			this.#applyReading(this.#entry(key), usage.remainingFraction, usage.resetAt, `${group} quota spent`, now);
		}
	}

	snapshot(): ReadonlyMap<string, Readonly<QuotaEntry>> {
		return new Map([...this.#entries].map(([key, entry]) => [key, { ...entry }]));
	}
}
