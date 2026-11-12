import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExhaustedMenu, directQuotaSuggestion } from "../src/exhausted-menu.ts";
import { QuotaState } from "../src/state.ts";
import { setLang, t } from "../src/i18n/index.ts";

setLang("en");
const NOW = 1_000_000;
const cand = (provider: string, model: string) => ({ provider, model, quotaKey: `${provider}:${model}` });
const keyFor = (provider: string, model: string) => `${provider}:${model}`;
const spent = (state: QuotaState, ...keys: string[]) => {
	for (const key of keys) state.markExhausted(key, NOW + 60_000, "test", NOW);
};

function menu(state: QuotaState, activeModels: { provider: string; model: string }[]) {
	return buildExhaustedMenu({
		poolId: "main",
		poolCandidates: [cand("claude", "opus")],
		otherPools: [{ id: "cheap", candidates: [cand("agy", "flash")] }],
		activeModels,
		state,
		now: NOW,
		quotaKeyFor: keyFor,
		t,
	});
}

test("exhausted menu: retry, other pools, other active models with quota, then compact and cancel", () => {
	const state = new QuotaState();
	spent(state, "claude:opus");
	const { options } = menu(state, [
		{ provider: "claude", model: "opus" },
		{ provider: "agy", model: "flash" },
		{ provider: "openai-codex", model: "gpt-5" },
	]);
	assert.equal(options.length, 5);
	assert.match(options[0]!, /^claude\/opus - Retry candidate/);
	assert.match(options[1]!, /^agy\/flash - Available candidate from pool\/cheap/);
	assert.equal(options[2], "openai-codex/gpt-5 - Available in your subscriptions");
	assert.match(options[3]!, /^\[compact\]/);
	assert.match(options[4]!, /^\[cancel\]/);
});

test("exhausted menu: picking an active model outside every pool yields its candidate", () => {
	const state = new QuotaState();
	spent(state, "claude:opus");
	const { candidates } = menu(state, [{ provider: "openai-codex", model: "gpt-5" }]);
	assert.deepEqual(candidates.get("openai-codex/gpt-5 - Available in your subscriptions"), cand("openai-codex", "gpt-5"));
});

test("exhausted menu: spent active models are left out and nothing is listed twice", () => {
	const state = new QuotaState();
	spent(state, "claude:opus", "openai-codex:gpt-5");
	const { options } = menu(state, [
		{ provider: "openai-codex", model: "gpt-5" },
		{ provider: "agy", model: "flash" },
		{ provider: "agy", model: "flash" },
	]);
	assert.equal(options.filter(o => o.includes("gpt-5")).length, 0);
	assert.equal(options.filter(o => o.startsWith("agy/flash")).length, 1);
	assert.equal(options.length, 4);
});

test("exhausted menu: labels exist in Spanish too", () => {
	setLang("es");
	try {
		const { options } = menu(new QuotaState(), [{ provider: "openai-codex", model: "gpt-5" }]);
		assert.ok(options.some(o => o === "openai-codex/gpt-5 - Disponible en tus suscripciones"));
	} finally {
		setLang("en");
	}
});

test("direct quota hint: last-resort first, then the first pool candidate, else nothing", () => {
	const state = new QuotaState();
	const pools = [{ candidates: [cand("claude", "opus"), cand("agy", "flash")] }];
	const lastResort = cand("agy", "lite");
	assert.equal(directQuotaSuggestion({ exhaustedKey: "claude:opus", lastResort, pools, state, now: NOW }), "agy/lite");
	assert.equal(directQuotaSuggestion({ exhaustedKey: "claude:opus", pools, state, now: NOW }), "agy/flash");
	spent(state, "agy:lite");
	assert.equal(directQuotaSuggestion({ exhaustedKey: "claude:opus", lastResort, pools, state, now: NOW }), "agy/flash");
	spent(state, "agy:flash");
	assert.equal(directQuotaSuggestion({ exhaustedKey: "claude:opus", lastResort, pools, state, now: NOW }), undefined);
	assert.equal(directQuotaSuggestion({ exhaustedKey: "agy:lite", lastResort: cand("agy", "lite"), pools: [], state: new QuotaState(), now: NOW }), undefined);
});
