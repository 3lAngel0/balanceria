import { agyQuotaKey } from "../agy-usage.ts";
import { classifyQuotaError } from "../quota-errors.ts";
import type { ProviderAdapter, ProviderKind, ProviderQuotaStatus, QuotaErrorMatch } from "./types.ts";

export class AntigravityAdapter implements ProviderAdapter {
	readonly id = "antigravity";
	readonly label = "Antigravity";
	readonly kind: ProviderKind = "subscription";

	quotaKey(model: string): string {
		return agyQuotaKey(model);
	}

	matchQuotaError(errorMessage: string): QuotaErrorMatch | null {
		const classification = classifyQuotaError(errorMessage);
		if (!classification) return null;
		return {
			isQuotaExceeded: true,
			resetsInMs: classification.resetInMs,
			window: "antigravity",
		};
	}
}

export class ClaudeBridgeAdapter implements ProviderAdapter {
	readonly id = "claude-bridge";
	readonly label = "Claude Bridge";
	readonly kind: ProviderKind = "subscription";

	quotaKey(_model: string): string {
		return "claude-bridge/claude";
	}

	matchQuotaError(errorMessage: string): QuotaErrorMatch | null {
		const classification = classifyQuotaError(errorMessage);
		if (!classification) return null;
		return {
			isQuotaExceeded: true,
			resetsInMs: classification.resetInMs,
			window: "claude-bridge/claude",
		};
	}
}

export class ClaudeCodeAdapter implements ProviderAdapter {
	readonly id = "claude-code";
	readonly label = "Claude Code";
	readonly kind: ProviderKind = "subscription";

	quotaKey(_model: string): string {
		return "claude-code/main";
	}

	matchQuotaError(errorMessage: string): QuotaErrorMatch | null {
		const classification = classifyQuotaError(errorMessage);
		if (!classification) return null;
		return {
			isQuotaExceeded: true,
			resetsInMs: classification.resetInMs,
			window: "claude-code/main",
		};
	}
}

export class OpenCodeAdapter implements ProviderAdapter {
	readonly id: string;
	readonly label: string;
	readonly kind: ProviderKind;

	constructor(id = "opencode", label = "OpenCode", kind: ProviderKind = "subscription") {
		this.id = id;
		this.label = label;
		this.kind = kind;
	}

	quotaKey(model: string): string {
		return `${this.id}/${model}`;
	}

	matchQuotaError(errorMessage: string): QuotaErrorMatch | null {
		const classification = classifyQuotaError(errorMessage);
		if (!classification) return null;
		return {
			isQuotaExceeded: true,
			resetsInMs: classification.resetInMs,
			window: `${this.id}/quota`,
		};
	}
}

export class GenericApiAdapter implements ProviderAdapter {
	readonly id: string;
	readonly label: string;
	readonly kind: ProviderKind = "api";

	constructor(id: string, label?: string) {
		this.id = id;
		this.label = label ?? `${id} (API)`;
	}

	quotaKey(model: string): string {
		return `${this.id}/${model}`;
	}

	matchQuotaError(errorMessage: string): QuotaErrorMatch | null {
		const classification = classifyQuotaError(errorMessage);
		if (!classification) return null;
		return {
			isQuotaExceeded: true,
			resetsInMs: classification.resetInMs,
			window: `${this.id}/rate-limit`,
		};
	}
}

export class LocalAdapter implements ProviderAdapter {
	readonly id: string;
	readonly label: string;
	readonly kind: ProviderKind = "local";

	constructor(id = "ollama", label = "Ollama (Local)") {
		this.id = id;
		this.label = label;
	}

	quotaKey(model: string): string {
		return `${this.id}/${model}`;
	}

	matchQuotaError(_errorMessage: string): QuotaErrorMatch | null {
		// Local models do not have billing/subscription quota limits
		return null;
	}
}
