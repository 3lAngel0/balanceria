import type { Candidate } from "./router.ts";
import type { QuotaState } from "./state.ts";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface ExhaustedMenuInput {
	poolId: string;
	/** Candidates of the pool that ran out. */
	poolCandidates: readonly Candidate[];
	/** Every other pool, in config order. */
	otherPools: readonly { id: string; candidates: readonly Candidate[] }[];
	/** Models of the subscriptions the user really has, whether or not any pool lists them. */
	activeModels: readonly { provider: string; model: string }[];
	state: Pick<QuotaState, "isAvailable" | "availableAt">;
	now: number;
	quotaKeyFor: (provider: string, model: string) => string;
	t: Translate;
}

export interface ExhaustedMenu {
	options: string[];
	candidates: Map<string, Candidate>;
	compactOption: string;
	cancelOption: string;
}

/**
 * Options of the "pool exhausted" menu: retry candidates of the pool, then available candidates of other pools,
 * then any other active model with quota left, then compact and cancel. A model is listed once.
 */
export function buildExhaustedMenu(input: ExhaustedMenuInput): ExhaustedMenu {
	const { state, now, t } = input;
	const options: string[] = [];
	const candidates = new Map<string, Candidate>();
	const listed = new Set<string>();
	const add = (label: string, candidate: Candidate): void => {
		options.push(label);
		candidates.set(label, candidate);
		listed.add(`${candidate.provider}/${candidate.model}`);
	};

	for (const c of input.poolCandidates) {
		const availAt = state.availableAt(c.quotaKey, now);
		const time = availAt ? new Date(availAt).toTimeString().slice(0, 8) : "unknown";
		add(`${c.provider}/${c.model} - ${t("ops.retryCandidate", { time })}`, c);
	}

	for (const other of input.otherPools) {
		for (const c of other.candidates) {
			if (!state.isAvailable(c.quotaKey, now)) continue;
			const label = `${c.provider}/${c.model} - ${t("ops.otherPoolCandidate", { pool: other.id })}`;
			if (!candidates.has(label)) add(label, c);
		}
	}

	for (const { provider, model } of input.activeModels) {
		const ref = `${provider}/${model}`;
		if (listed.has(ref)) continue;
		const quotaKey = input.quotaKeyFor(provider, model);
		if (!state.isAvailable(quotaKey, now)) continue;
		add(`${ref} - ${t("ops.activeModelCandidate")}`, { provider, model, quotaKey });
	}

	const compactOption = `[compact] ${t("ops.compactSession")}`;
	const cancelOption = `[cancel] ${t("ops.cancelRequest")}`;
	options.push(compactOption, cancelOption);
	return { options, candidates, compactOption, cancelOption };
}

/**
 * Model a direct (non-pool) session is told to switch to when its quota ends: the last-resort model when it has
 * quota, else the first pool candidate with quota, else undefined.
 */
export function directQuotaSuggestion(input: {
	exhaustedKey: string;
	lastResort?: Candidate;
	pools: readonly { candidates: readonly Candidate[] }[];
	state: Pick<QuotaState, "isAvailable">;
	now?: number;
}): string | undefined {
	const usable = (c: Candidate) => c.quotaKey !== input.exhaustedKey && input.state.isAvailable(c.quotaKey, input.now);
	const pick = (input.lastResort && usable(input.lastResort) ? input.lastResort : undefined)
		?? input.pools.flatMap(p => p.candidates).find(usable);
	return pick ? `${pick.provider}/${pick.model}` : undefined;
}
