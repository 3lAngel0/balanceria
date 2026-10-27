// Pure edit model for the rule editor widget: derives a pool's shown rule list
// from its strategy when `rules` is absent, reorders movable blocks while
// keeping `pick` last, adds/removes `prefer-for-role` and `sticky`, and saves
// `rules` only onto the edited pool.

export type PickMode = "first" | "highest-quota";
export type Strategy = "hybrid" | "waterfall" | "highest-quota";

export type RuleBlock =
	| { rule: "sticky" }
	| { rule: "prefer-for-role"; role: string; candidate: string }
	| { rule: "pick"; mode: PickMode };

export interface DraftPool {
	id: string;
	name?: string;
	candidates: string[];
	strategy?: Strategy;
	rules?: RuleBlock[];
	[key: string]: unknown;
}

export interface PoolsConfig {
	pools: DraftPool[];
	[key: string]: unknown;
}

const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The pool's explicit rules, or the default list derived from its strategy. */
export function effectiveRules(pool: Pick<DraftPool, "strategy" | "rules">): RuleBlock[] {
	if (Array.isArray(pool.rules) && pool.rules.length > 0) {
		return pool.rules.map(block => ({ ...block }));
	}
	return [
		{ rule: "sticky" },
		{ rule: "pick", mode: pool.strategy === "waterfall" ? "first" : "highest-quota" },
	];
}

/** Moves a movable rule (`sticky` or `prefer-for-role`) to `to`, keeping `pick` last. */
export function moveRule(rules: readonly RuleBlock[], from: number, to: number): RuleBlock[] {
	const lastMovable = rules[rules.length - 1]?.rule === "pick" ? rules.length - 2 : rules.length - 1;
	if (from === to || from < 0 || to < 0 || from > lastMovable || to > lastMovable) {
		return rules as RuleBlock[];
	}
	const next = [...rules];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved!);
	return next;
}

/** Inserts a `prefer-for-role` rule right before the trailing `pick` block when the role and candidate are valid. */
export function addPreferForRole(rules: readonly RuleBlock[], role: string, candidate: string): RuleBlock[] {
	const trimmedRole = role.trim();
	const trimmedCandidate = candidate.trim();
	if (!ROLE_NAME.test(trimmedRole) || !trimmedCandidate) return rules as RuleBlock[];
	const entry: RuleBlock = { rule: "prefer-for-role", role: trimmedRole, candidate: trimmedCandidate };
	const next = [...rules];
	const pickIndex = next.findIndex(r => r.rule === "pick");
	if (pickIndex >= 0) next.splice(pickIndex, 0, entry);
	else next.push(entry);
	return next;
}

/** Restores `sticky` at the top when the pool does not already have one. */
export function addSticky(rules: readonly RuleBlock[]): RuleBlock[] {
	if (rules.some(r => r.rule === "sticky")) return rules as RuleBlock[];
	return [{ rule: "sticky" }, ...rules];
}

/** Removes the rule at `index`, refusing to remove `pick`. */
export function removeRule(rules: readonly RuleBlock[], index: number): RuleBlock[] {
	if (index < 0 || index >= rules.length || rules[index]?.rule === "pick") {
		return rules as RuleBlock[];
	}
	return rules.filter((_, i) => i !== index);
}

/** Sets the trailing `pick` mode. */
export function setPickMode(rules: readonly RuleBlock[], mode: PickMode): RuleBlock[] {
	const last = rules[rules.length - 1];
	if (last?.rule === "pick" && last.mode === mode) return rules as RuleBlock[];
	const withoutPick = rules.filter(r => r.rule !== "pick");
	return [...withoutPick, { rule: "pick", mode }];
}

/** Writes `rules` onto `poolId` only and keeps `strategy` aligned with `pick.mode`. */
export function applyPoolRules(config: PoolsConfig, poolId: string, rules: readonly RuleBlock[]): PoolsConfig {
	const pick = rules.find((r): r is { rule: "pick"; mode: PickMode } => r.rule === "pick");
	return {
		...config,
		pools: config.pools.map(pool => {
			if (pool.id !== poolId) return pool;
			const next: DraftPool = { ...pool, rules: rules.map(r => ({ ...r })) };
			if (next.strategy !== undefined && pick) {
				if (pick.mode === "first") next.strategy = "waterfall";
				else if (next.strategy === "waterfall") next.strategy = "hybrid";
			}
			return next;
		}),
	};
}

/** Sorted unique role names from the routing decisions summary, skipping `unknown`. */
export function knownRoles(byRole: readonly { role: string }[]): string[] {
	const set = new Set<string>();
	for (const row of byRole) {
		if (row.role && row.role !== "unknown") set.add(row.role);
	}
	return [...set].sort();
}
