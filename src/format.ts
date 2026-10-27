// Text helpers shared by the usage panel and the HUD.

export function formatDuration(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days >= 1) return `${days}d ${hours % 24}h`;
	if (hours >= 1) return `${hours}h ${minutes % 60}m`;
	return `${minutes}m`;
}

/** A bar of `cells` characters, filled in proportion to `fraction` (clamped to 0-1). */
export function meter(fraction: number, cells: number, full: string, empty: string): string {
	const filled = Math.round(Math.max(0, Math.min(1, fraction)) * cells);
	return full.repeat(filled) + empty.repeat(cells - filled);
}

/** "$0", "<$0.01", "$12.35", or whole dollars from $100. */
export function formatUsd(amount: number): string {
	if (amount <= 0) return "$0";
	if (amount < 0.01) return "<$0.01";
	if (amount < 100) return `$${amount.toFixed(2)}`;
	return `$${Math.round(amount)}`;
}
