import { getProviderAdapter } from "./providers/registry.ts";
import type { Candidate, RoutingStrategy, RuleBlock } from "./router.ts";

// A pool is one virtual model (`pool/<id>`) backed by an ordered list of
// physical models. The first candidate is spent before the next one is used.

export interface Pool {
	id: string;
	name: string;
	candidates: Candidate[];
	/** How a new turn picks its candidate; the router defaults to "hybrid". */
	strategy?: RoutingStrategy;
	/** Rule pipeline; absent means the default list of `strategy`. */
	rules?: RuleBlock[];
}

const STRATEGIES: readonly RoutingStrategy[] = ["hybrid", "waterfall", "highest-quota"];

export const POOL_PROVIDER = "pool";

/** Quota key shared by every model of one subscription window. */
export function quotaKeyFor(provider: string, model: string): string {
	return getProviderAdapter(provider).quotaKey(model);
}

function parseCandidate(ref: unknown): Candidate | undefined {
	if (typeof ref !== "string") return undefined;
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	const provider = ref.slice(0, slash);
	const model = ref.slice(slash + 1);
	return { provider, model, quotaKey: quotaKeyFor(provider, model) };
}

export function parsePools(config: unknown): Pool[] {
	if (!config || typeof config !== "object" || !Array.isArray((config as { pools?: unknown }).pools)) return [];
	const pools: Pool[] = [];
	for (const raw of (config as { pools: unknown[] }).pools) {
		if (!raw || typeof raw !== "object") continue;
		const { id, name, candidates, strategy, rules } = raw as { id?: unknown; name?: unknown; candidates?: unknown; strategy?: unknown; rules?: unknown };
		if (typeof id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(id) || !Array.isArray(candidates)) continue;
		const parsed = candidates.map(parseCandidate);
		if (parsed.length === 0 || parsed.some(candidate => candidate === undefined)) continue;
		const pool: Pool = { id, name: typeof name === "string" ? name : `${id} (pool)`, candidates: parsed as Candidate[] };
		if (STRATEGIES.includes(strategy as RoutingStrategy)) pool.strategy = strategy as RoutingStrategy;
		// A bad rule list never drops the pool: it routes on its default list.
		if (rules !== undefined && ruleIssues(rules, candidates, strategy, "rules").length === 0) pool.rules = rules as RuleBlock[];
		pools.push(pool);
	}
	return pools;
}

export interface RuleIssue {
	path: string;
	message: string;
}

const RULE_FIELDS: Record<string, readonly string[]> = {
	sticky: ["rule"],
	"prefer-for-role": ["rule", "role", "candidate"],
	"prefer-for-context": ["rule", "candidate", "minTokens", "maxTokens"],
	pick: ["rule", "mode"],
};

/** Why a pool's `rules` cannot run; empty when the list is valid. */
export function ruleIssues(rules: unknown, candidates: unknown, strategy: unknown, path: string): RuleIssue[] {
	if (!Array.isArray(rules) || rules.length === 0) return [{ path, message: "Field 'rules' if provided must be a non-empty array of rule blocks" }];
	const issues: RuleIssue[] = [];
	const refs = Array.isArray(candidates) ? candidates : [];
	let sticky = false;
	rules.forEach((block, index) => {
		const at = `${path}[${index}]`;
		if (!block || typeof block !== "object" || Array.isArray(block)) {
			issues.push({ path: at, message: "Rule block must be an object" });
			return;
		}
		const value = block as Record<string, unknown>;
		const fields = typeof value.rule === "string" ? RULE_FIELDS[value.rule] : undefined;
		if (!fields) {
			issues.push({ path: `${at}.rule`, message: `Unknown rule '${String(value.rule)}'; expected 'sticky', 'prefer-for-role', 'prefer-for-context' or 'pick'` });
			return;
		}
		const unknown = Object.keys(value).find(key => !fields.includes(key));
		if (unknown) issues.push({ path: at, message: `Unknown field '${unknown}' in rule '${value.rule}'` });
		if (value.rule === "sticky") {
			if (sticky) issues.push({ path: at, message: "Rule 'sticky' may appear only once" });
			sticky = true;
		}
		if (value.rule === "prefer-for-role") {
			if (typeof value.role !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.role)) issues.push({ path: `${at}.role`, message: "Field 'role' must be a non-empty agent name" });
			if (typeof value.candidate !== "string" || !refs.includes(value.candidate)) issues.push({ path: `${at}.candidate`, message: `Candidate '${String(value.candidate)}' is not in this pool` });
		}
		if (value.rule === "prefer-for-context") {
			if (typeof value.candidate !== "string" || !refs.includes(value.candidate)) issues.push({ path: `${at}.candidate`, message: `Candidate '${String(value.candidate)}' is not in this pool` });
			if (value.minTokens === undefined && value.maxTokens === undefined) issues.push({ path: at, message: "Rule 'prefer-for-context' needs minTokens or maxTokens" });
			for (const field of ["minTokens", "maxTokens"]) {
				const bound = value[field];
				if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound) || bound < 0)) issues.push({ path: `${at}.${field}`, message: `Field '${field}' must be a non-negative number` });
			}
			if (typeof value.minTokens === "number" && typeof value.maxTokens === "number" && value.minTokens >= value.maxTokens) issues.push({ path: at, message: "Field 'minTokens' must be less than maxTokens" });
		}
		if (value.rule === "pick" && value.mode !== "first" && value.mode !== "highest-quota" && value.mode !== "lowest-cost") issues.push({ path: `${at}.mode`, message: "Field 'mode' must be 'first', 'highest-quota' or 'lowest-cost'" });
	});
	const picks = rules.filter(block => (block as { rule?: unknown } | null)?.rule === "pick");
	const last = rules[rules.length - 1] as { rule?: unknown; mode?: unknown } | null;
	if (picks.length !== 1 || last?.rule !== "pick") {
		issues.push({ path, message: "Rules must end with exactly one 'pick' block" });
	} else if (strategy !== undefined && (last.mode === "first" || last.mode === "highest-quota")) {
		const agrees = last.mode === "first" ? strategy === "waterfall" : strategy === "hybrid" || strategy === "highest-quota";
		if (!agrees) issues.push({ path: path.replace(/rules$/, "strategy"), message: `Strategy '${String(strategy)}' disagrees with the pick mode '${last.mode}' of the rules` });
	}
	return issues;
}

/** One line per pool whose rules were ignored at load, for a startup warning. */
export function ignoredRuleWarnings(config: unknown): string[] {
	const list = (config as { pools?: unknown } | null)?.pools;
	if (!Array.isArray(list)) return [];
	return list.flatMap((raw, index) => {
		const pool = raw as { id?: unknown; candidates?: unknown; strategy?: unknown; rules?: unknown } | null;
		if (!pool || pool.rules === undefined) return [];
		const issues = ruleIssues(pool.rules, pool.candidates, pool.strategy, `pools[${index}].rules`);
		if (issues.length === 0) return [];
		return [`pool '${String(pool.id)}' ignores its rules and routes on the default list: ${issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`];
	});
}
