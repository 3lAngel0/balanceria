export type ProviderKind = "subscription" | "api" | "local";

export interface QuotaErrorMatch {
	isQuotaExceeded: boolean;
	resetsInMs?: number;
	window?: string;
}

export interface ProviderQuotaStatus {
	available: boolean;
	/** Remaining quota fraction from 0.0 (empty) to 1.0 (full). */
	remainingFraction?: number;
	/** Timestamp in epoch ms when the quota window resets. */
	resetsAt?: number;
	window?: string;
	updatedAt?: number;
}

export interface ProviderAdapter {
	readonly id: string;
	readonly label: string;
	readonly kind: ProviderKind;

	/**
	 * Returns the quota key shared by models that draw from the same
	 * subscription window or rate-limit bucket.
	 */
	quotaKey(model: string): string;

	/**
	 * Matches provider-specific error messages to determine if a subscription
	 * window is spent and when it will reopen.
	 */
	matchQuotaError(errorMessage: string): QuotaErrorMatch | null;

	/**
	 * Retrieves cached or known quota status for a quota key if available.
	 */
	getRemainingQuota?(quotaKey: string, now: number): ProviderQuotaStatus | undefined;

	/**
	 * Detects whether the provider CLI, binary, or plugin is installed and usable
	 * in the current environment (used by onboarding wizards).
	 */
	detectInstalled?(): Promise<boolean> | boolean;
}
