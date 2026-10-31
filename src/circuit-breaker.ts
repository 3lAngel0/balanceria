import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Candidate } from "./router.ts";
import type { QuotaState } from "./state.ts";

export interface CircuitBreakerCheckpoint {
	poolId: string;
	trippedAt: number;
	session: string;
	project: string;
	soonestResetAt?: number;
	candidates: { provider: string; model: string; quotaKey: string; availableAt?: number }[];
	reason: string;
}

export interface CircuitBreakerStatus {
	tripped: boolean;
	poolId?: string;
	trippedAt?: number;
	soonestResetAt?: number;
	reason?: string;
}

export class CircuitBreaker {
	private tripped = false;
	private currentCheckpoint?: CircuitBreakerCheckpoint;
	private readonly dataDir: string;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
	}

	isTripped(): boolean {
		return this.tripped;
	}

	getStatus(): CircuitBreakerStatus {
		return {
			tripped: this.tripped,
			poolId: this.currentCheckpoint?.poolId,
			trippedAt: this.currentCheckpoint?.trippedAt,
			soonestResetAt: this.currentCheckpoint?.soonestResetAt,
			reason: this.currentCheckpoint?.reason,
		};
	}

	reset(): void {
		this.tripped = false;
		this.currentCheckpoint = undefined;
	}

	/**
	 * Clears a tripped breaker once a candidate of the tripped pool has quota again, so the alert
	 * follows the live quota instead of staying until the next quota error. Returns whether it cleared.
	 */
	reopenIfAvailable(candidates: readonly Candidate[], state: QuotaState, now: number = Date.now()): boolean {
		if (!this.tripped) return false;
		if (candidates.every(candidate => !state.isAvailable(candidate.quotaKey, now))) return false;
		this.reset();
		return true;
	}

	/**
	 * Evaluates if a pool is completely spent.
	 * If so, trips the breaker, saves an Engram-compatible checkpoint,
	 * and returns the checkpoint.
	 */
	checkAndTrip(options: {
		poolId: string;
		candidates: readonly Candidate[];
		state: QuotaState;
		session: string;
		project: string;
		now?: number;
	}): CircuitBreakerCheckpoint | null {
		const now = options.now ?? Date.now();
		const allSpent = options.candidates.every(c => !options.state.isAvailable(c.quotaKey, now));

		if (!allSpent) {
			if (this.tripped && this.currentCheckpoint?.poolId === options.poolId) {
				// At least one candidate reopened
				this.reset();
			}
			return null;
		}

		// Calculate soonest reset among exhausted candidates
		let soonestReset: number | undefined;
		const candidateDetails = options.candidates.map(c => {
			const availAt = options.state.availableAt(c.quotaKey, now);
			if (availAt !== undefined && (soonestReset === undefined || availAt < soonestReset)) {
				soonestReset = availAt;
			}
			return {
				provider: c.provider,
				model: c.model,
				quotaKey: c.quotaKey,
				availableAt: availAt,
			};
		});

		const checkpoint: CircuitBreakerCheckpoint = {
			poolId: options.poolId,
			trippedAt: now,
			session: options.session,
			project: options.project,
			soonestResetAt: soonestReset,
			candidates: candidateDetails,
			reason: `All ${options.candidates.length} candidates in pool '${options.poolId}' exhausted`,
		};

		this.tripped = true;
		this.currentCheckpoint = checkpoint;
		this.persistCheckpoint(checkpoint);

		return checkpoint;
	}

	private persistCheckpoint(checkpoint: CircuitBreakerCheckpoint): void {
		try {
			mkdirSync(this.dataDir, { recursive: true });
			const file = join(this.dataDir, "circuit-breaker-checkpoint.json");
			writeFileSync(file, JSON.stringify(checkpoint, null, 2), "utf8");
		} catch {
			// Checkpoint is in memory even if disk write fails
		}
	}
}
