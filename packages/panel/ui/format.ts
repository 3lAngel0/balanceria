/** "5 min ago", "3 h ago", "2 d ago". */
export function ago(ms: number, now: number = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - ms) / 60000));
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
	return `${Math.round(minutes / 1440)} d ago`;
}
