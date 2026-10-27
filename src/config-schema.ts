import type { Integration, IntegrationKind } from "./integrations.ts";
import type { Pool } from "./pools.ts";
import { parsePools, ruleIssues } from "./pools.ts";

export interface ValidationIssue {
	path: string;
	message: string;
}

export interface ValidationResult<T> {
	valid: boolean;
	issues: ValidationIssue[];
	data?: T;
}

export function validateIntegrationsConfig(raw: unknown): ValidationResult<Integration[]> {
	const issues: ValidationIssue[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		issues.push({ path: "$", message: "Root configuration must be an object with an 'integrations' array" });
		return { valid: false, issues };
	}

	const root = raw as Record<string, unknown>;
	if (!Array.isArray(root.integrations)) {
		issues.push({ path: "integrations", message: "Field 'integrations' must be an array" });
		return { valid: false, issues };
	}

	const validIntegrations: Integration[] = [];
	const seenProviders = new Set<string>();

	root.integrations.forEach((item, index) => {
		const path = `integrations[${index}]`;
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			issues.push({ path, message: "Integration entry must be an object" });
			return;
		}

		const entry = item as Record<string, unknown>;
		if (typeof entry.provider !== "string" || entry.provider.trim() === "") {
			issues.push({ path: `${path}.provider`, message: "Field 'provider' must be a non-empty string" });
		}
		if (typeof entry.label !== "string" || entry.label.trim() === "") {
			issues.push({ path: `${path}.label`, message: "Field 'label' must be a non-empty string" });
		}
		if (entry.kind !== "subscription" && entry.kind !== "api" && entry.kind !== "local") {
			issues.push({
				path: `${path}.kind`,
				message: `Field 'kind' must be 'subscription', 'api', or 'local' (got: '${String(entry.kind)}')`,
			});
		}

		if (typeof entry.provider === "string" && entry.provider.trim() !== "" && typeof entry.label === "string" && entry.label.trim() !== "" && (entry.kind === "subscription" || entry.kind === "api")) {
			if (seenProviders.has(entry.provider)) {
				issues.push({ path: `${path}.provider`, message: `Duplicate provider '${entry.provider}' found; earlier entry takes precedence` });
			} else {
				seenProviders.add(entry.provider);
				validIntegrations.push({
					provider: entry.provider,
					kind: entry.kind as IntegrationKind,
					label: entry.label,
				});
			}
		}
	});

	return {
		valid: issues.length === 0,
		issues,
		data: validIntegrations,
	};
}

export function validatePoolsConfig(raw: unknown): ValidationResult<Pool[]> {
	const issues: ValidationIssue[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		issues.push({ path: "$", message: "Root configuration must be an object with a 'pools' array" });
		return { valid: false, issues };
	}

	const root = raw as Record<string, unknown>;
	if (!Array.isArray(root.pools)) {
		issues.push({ path: "pools", message: "Field 'pools' must be an array" });
		return { valid: false, issues };
	}

	const seenPoolIds = new Set<string>();

	root.pools.forEach((item, index) => {
		const path = `pools[${index}]`;
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			issues.push({ path, message: "Pool entry must be an object" });
			return;
		}

		const pool = item as Record<string, unknown>;
		if (typeof pool.id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(pool.id)) {
			issues.push({
				path: `${path}.id`,
				message: "Field 'id' must be a lowercase alphanumeric string matching /^[a-z0-9][a-z0-9.-]*$/",
			});
		} else if (seenPoolIds.has(pool.id)) {
			issues.push({ path: `${path}.id`, message: `Duplicate pool id '${pool.id}'` });
		} else {
			seenPoolIds.add(pool.id);
		}

		if (pool.name !== undefined && (typeof pool.name !== "string" || pool.name.trim() === "")) {
			issues.push({ path: `${path}.name`, message: "Field 'name' if provided must be a non-empty string" });
		}

		if (pool.strategy !== undefined && !["hybrid", "waterfall", "highest-quota"].includes(pool.strategy as string)) {
			issues.push({ path: `${path}.strategy`, message: "Field 'strategy' if provided must be 'hybrid', 'waterfall' or 'highest-quota'" });
		}

		if (!Array.isArray(pool.candidates) || pool.candidates.length === 0) {
			issues.push({ path: `${path}.candidates`, message: "Field 'candidates' must be a non-empty array of candidate references" });
		} else {
			pool.candidates.forEach((cand, candIndex) => {
				const candPath = `${path}.candidates[${candIndex}]`;
				if (typeof cand !== "string") {
					issues.push({ path: candPath, message: "Candidate must be a string in format 'provider/model'" });
					return;
				}
				const slash = cand.indexOf("/");
				if (slash <= 0 || slash === cand.length - 1) {
					issues.push({ path: candPath, message: `Candidate '${cand}' must follow 'provider/model' format` });
				}
			});
		}

		if (pool.rules !== undefined) issues.push(...ruleIssues(pool.rules, pool.candidates, pool.strategy, `${path}.rules`));
	});

	const parsed = parsePools(raw);
	return {
		valid: issues.length === 0,
		issues,
		data: parsed,
	};
}
