// Parses `agy --print /usage --output-format json`. Each group (for example
// "Claude and GPT models") shares weekly and 5-hour buckets; a group is only as
// available as its lowest enabled bucket.

export const AGY_GROUP_CLAUDE = "Claude and GPT models";
export const AGY_GROUP_GEMINI = "Gemini Models";
export const AGY_GROUP_ARGON = "Gemini 4 Argon";

export interface AgyGroupUsage {
	/** Lowest remaining fraction across enabled buckets, 0..1. */
	remainingFraction: number;
	/** Reset of the bucket that limits the group, epoch ms, when reported. */
	resetAt: number | undefined;
}

export function agyGroupForModel(modelId: string): string {
	if (/^(?:claude|gpt)-/.test(modelId)) return AGY_GROUP_CLAUDE;
	if (/^gemini-4-argon/.test(modelId)) return AGY_GROUP_ARGON;
	return AGY_GROUP_GEMINI;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAgyUsage(report: unknown): Map<string, AgyGroupUsage> {
	const result = new Map<string, AgyGroupUsage>();
	const command = isRecord(report) && isRecord(report.command) ? report.command : undefined;
	const data = command && isRecord(command.data) ? command.data : undefined;
	if (!data || !Array.isArray(data.groups)) return result;

	for (const group of data.groups) {
		if (!isRecord(group) || typeof group.name !== "string" || !Array.isArray(group.buckets)) continue;
		let limiting: AgyGroupUsage | undefined;
		for (const bucket of group.buckets) {
			if (!isRecord(bucket) || bucket.disabled === true) continue;
			if (typeof bucket.remaining_fraction !== "number") continue;
			const resetAt = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : Number.NaN;
			const candidate = {
				remainingFraction: bucket.remaining_fraction,
				resetAt: Number.isNaN(resetAt) ? undefined : resetAt,
			};
			if (!limiting || candidate.remainingFraction < limiting.remainingFraction) limiting = candidate;
		}
		if (limiting) result.set(group.name, limiting);
	}
	return result;
}

/** Quota key the router uses for an Antigravity model. */
export function agyQuotaKey(modelId: string): string {
	const group = agyGroupForModel(modelId);
	if (group === AGY_GROUP_CLAUDE) return "antigravity/claude";
	if (group === AGY_GROUP_ARGON) return "antigravity/gemini-4-argon";
	return "antigravity/gemini";
}

export function agyQuotaKeyForGroup(group: string): string | undefined {
	if (group === AGY_GROUP_CLAUDE) return "antigravity/claude";
	if (group === AGY_GROUP_ARGON) return "antigravity/gemini-4-argon";
	if (group === AGY_GROUP_GEMINI) return "antigravity/gemini";
	return undefined;
}
