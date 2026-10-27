import {
	AntigravityAdapter,
	ClaudeBridgeAdapter,
	ClaudeCodeAdapter,
	GenericApiAdapter,
	LocalAdapter,
	OpenCodeAdapter,
} from "./adapters.ts";
import type { ProviderAdapter } from "./types.ts";

export class ProviderRegistry {
	private readonly adapters = new Map<string, ProviderAdapter>();

	constructor() {
		this.registerBuiltins();
	}

	private registerBuiltins(): void {
		this.register(new AntigravityAdapter());
		this.register(new ClaudeBridgeAdapter());
		this.register(new ClaudeCodeAdapter());
		this.register(new OpenCodeAdapter());
		this.register(new LocalAdapter("ollama", "Ollama (Local)"));
		this.register(new LocalAdapter("local", "Local Runner"));
	}

	register(adapter: ProviderAdapter): void {
		this.adapters.set(adapter.id, adapter);
	}

	get(id: string): ProviderAdapter {
		const existing = this.adapters.get(id);
		if (existing) return existing;
		// Fallback for custom or unclassified API providers
		return new GenericApiAdapter(id);
	}

	has(id: string): boolean {
		return this.adapters.has(id);
	}

	list(): ProviderAdapter[] {
		return Array.from(this.adapters.values());
	}
}

export const defaultProviderRegistry = new ProviderRegistry();

export function getProviderAdapter(id: string): ProviderAdapter {
	return defaultProviderRegistry.get(id);
}

export function registerProviderAdapter(adapter: ProviderAdapter): void {
	defaultProviderRegistry.register(adapter);
}

export function listProviderAdapters(): ProviderAdapter[] {
	return defaultProviderRegistry.list();
}
