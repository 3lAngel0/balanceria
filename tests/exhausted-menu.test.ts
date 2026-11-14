import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExhaustedMenu, directQuotaSuggestion, exhaustedDirectOutcome, exhaustedPoolNotice, exhaustedPoolOutcome } from "../src/exhausted-menu.ts";
import { classifyQuotaError, failoverErrorMessage } from "../src/quota-errors.ts";
import { failoverAlternative } from "../src/router.ts";
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

// ---- Pool spent with no way out: the turn ends with a clear notice instead of the provider's text ----

const clock = (ms: number) => {
	const d = new Date(ms);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const RAW_PROVIDER_TEXT = "Claude quota exceeded — rate limit (five_hour) — resets 1:50:00 AM: You've hit your 5-hour limit";

test("exhausted pool notice names the pool and when the soonest candidate comes back", () => {
	const state = new QuotaState();
	state.markExhausted("agy:claude", NOW + 3 * 60_000, "test", NOW);
	state.markExhausted("claude:sonnet", NOW + 90 * 60_000, "test", NOW);
	const notice = exhaustedPoolNotice({
		poolId: "claude-sonnet-5-5",
		candidates: [cand("agy", "claude"), cand("claude", "sonnet")],
		state,
		now: NOW,
		t,
	});
	assert.match(notice, /pool\/claude-sonnet-5-5/);
	assert.ok(notice.includes(clock(NOW + 3 * 60_000)), notice);
	assert.ok(!notice.includes(clock(NOW + 90 * 60_000)), notice);
	assert.ok(!notice.includes("quota exceeded"), notice);
});

test("exhausted pool notice stays clear when no candidate has a known reset time", () => {
	const notice = exhaustedPoolNotice({
		poolId: "main",
		candidates: [cand("agy", "claude")],
		state: new QuotaState(),
		now: NOW,
		t,
	});
	assert.match(notice, /pool\/main/);
	assert.doesNotMatch(notice, /undefined|NaN|Invalid/);
});

test("exhausted pool notice is Spanish when the language is Spanish", () => {
	setLang("es");
	try {
		const state = new QuotaState();
		state.markExhausted("agy:claude", NOW + 60_000, "test", NOW);
		const notice = exhaustedPoolNotice({ poolId: "main", candidates: [cand("agy", "claude")], state, now: NOW, t });
		assert.match(notice, /pool\/main/);
		assert.ok(notice.includes(clock(NOW + 60_000)), notice);
		assert.match(notice, /agot|cupo/i);
	} finally {
		setLang("en");
	}
});

test("exhausted pool notice is not a retryable error and is not read as a new quota error", () => {
	const state = new QuotaState();
	state.markExhausted("agy:claude", NOW + 60_000, "test", NOW);
	const notice = exhaustedPoolNotice({ poolId: "main", candidates: [cand("agy", "claude")], state, now: NOW, t });
	// Pi retries on these words, which would loop on a spent pool.
	assert.doesNotMatch(notice, /rate.?limit|too many requests|\b429\b|overloaded|timed? ?out|timeout|unavailable|terminated|server.?error/i);
	assert.equal(classifyQuotaError(notice), undefined);
});

test("a spent pool's turn ends with the notice, replacing the provider's text", () => {
	const state = new QuotaState();
	state.markExhausted("agy:claude", NOW + 60_000, "test", NOW);
	const outcome = exhaustedPoolOutcome({ poolId: "main", candidates: [cand("agy", "claude")], state, now: NOW, t });
	assert.equal(outcome.errorMessage, outcome.notice);
	assert.notEqual(outcome.errorMessage, RAW_PROVIDER_TEXT);
	assert.match(outcome.errorMessage, /pool\/main/);
});

test("pool candidates keep failing over to an available alternative: nothing is spent so there is no notice", () => {
	const state = new QuotaState();
	state.markExhausted("agy:claude", NOW + 60_000, "test", NOW);
	assert.equal(failoverAlternative([cand("agy", "claude"), cand("claude", "sonnet")], "agy:claude", state, NOW)?.provider, "claude");
	assert.equal(failoverErrorMessage("antigravity"), "429 rate limit: ai-balancer failover, antigravity subscription window is spent");
});

// ---- Direct model spent: the turn ends with a clear notice and a real way out ----

const DAY = 24 * 3_600_000;
const POOL_WITH_QUOTA = { id: "fast", candidates: [cand("agy", "flash")] };
const directInput = (over: Record<string, unknown> = {}) => ({
	model: "claude-bridge/claude-fable-5-2",
	exhaustedKey: "claude:fable",
	until: NOW + 3 * 60_000,
	pools: [] as { id: string; candidates: ReturnType<typeof cand>[] }[],
	state: new QuotaState(),
	now: NOW,
	t,
	...over,
});

test("R1 direct notice: names the model, when it comes back, and that the session is open", () => {
	const { notice, errorMessage } = exhaustedDirectOutcome(directInput({ stalled: false }));
	assert.equal(
		notice,
		`ai-balancer: claude-bridge/claude-fable-5-2 is out of usage. It is back at ${clock(NOW + 3 * 60_000)}. Your session is still open: send your message again then, or pick another model with /model or /balancer.`,
	);
	assert.equal(errorMessage, notice);
	assert.notEqual(errorMessage, RAW_PROVIDER_TEXT);
});

test("R1 direct notice: adds the date when the model comes back on another day", () => {
	const at = NOW + 2 * DAY;
	const d = new Date(at);
	const two = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${clock(at)}`;
	const { notice } = exhaustedDirectOutcome(directInput({ until: at }));
	assert.ok(notice.includes(`It is back at ${stamp}.`), notice);
});

test("R1 direct notice: says so when no return time is known", () => {
	const { notice } = exhaustedDirectOutcome(directInput({ until: undefined }));
	assert.equal(
		notice,
		"ai-balancer: claude-bridge/claude-fable-5-2 is out of usage and no return time is known. Your session is still open: send your message again later, or pick another model with /model or /balancer.",
	);
});

test("R1 direct notice: Spanish uses voseo", () => {
	setLang("es");
	try {
		const known = exhaustedDirectOutcome(directInput()).notice;
		assert.equal(
			known,
			`ai-balancer: claude-bridge/claude-fable-5-2 agotó su cupo. Vuelve a estar disponible: ${clock(NOW + 3 * 60_000)}. Tu sesión sigue abierta: volvé a enviar el mensaje entonces, o elegí otro modelo con /model o /balancer.`,
		);
		const unknown = exhaustedDirectOutcome(directInput({ until: undefined })).notice;
		assert.equal(
			unknown,
			"ai-balancer: claude-bridge/claude-fable-5-2 agotó su cupo y no se sabe cuándo vuelve. Tu sesión sigue abierta: volvé a enviar el mensaje más tarde, o elegí otro modelo con /model o /balancer.",
		);
	} finally {
		setLang("en");
	}
});

test("R2 direct suggestion: an available alternative model is offered", () => {
	const state = new QuotaState();
	const out = exhaustedDirectOutcome(directInput({ lastResort: cand("agy", "lite"), state }));
	assert.equal(out.suggestion, "agy/lite");
	assert.ok(out.notice.endsWith("send your message again then, or switch to agy/lite with /model."), out.notice);
	assert.ok(!out.notice.includes("pool/orchestrator"));
});

test("R2 direct suggestion: a pool is named only when it exists and has something to serve", () => {
	const state = new QuotaState();
	const withPool = exhaustedDirectOutcome(directInput({ pools: [POOL_WITH_QUOTA], state }));
	assert.equal(withPool.suggestion, "agy/flash");
	assert.ok(withPool.notice.endsWith("or switch to agy/flash or pool/fast with /model."), withPool.notice);
	// The pool exists but every candidate is spent: not a way out.
	spent(state, "agy:flash");
	const spentPool = exhaustedDirectOutcome(directInput({ pools: [POOL_WITH_QUOTA], state }));
	assert.equal(spentPool.suggestion, undefined);
	assert.doesNotMatch(spentPool.notice, /pool\//);
});

test("R2 direct suggestion: with no alternative and no pool, it points to /model and /balancer", () => {
	const out = exhaustedDirectOutcome(directInput());
	assert.equal(out.suggestion, undefined);
	assert.ok(out.notice.endsWith("or pick another model with /model or /balancer."), out.notice);
	assert.doesNotMatch(out.notice, /pool\/orchestrator|undefined/);
});

test("R3 direct notice is not retryable and is not read as a new quota error, in both languages", () => {
	const variants = () => [
		exhaustedDirectOutcome(directInput()).notice,
		exhaustedDirectOutcome(directInput({ until: undefined })).notice,
		exhaustedDirectOutcome(directInput({ lastResort: cand("agy", "lite"), pools: [POOL_WITH_QUOTA] })).notice,
		exhaustedDirectOutcome(directInput({ stalled: true })).notice,
	];
	for (const lang of ["en", "es"] as const) {
		setLang(lang);
		try {
			for (const notice of variants()) {
				assert.doesNotMatch(notice, /rate.?limit|too many requests|\b429\b|overloaded|timed? ?out|timeout|unavailable|terminated|server.?error/i, notice);
				assert.equal(classifyQuotaError(notice), undefined, notice);
			}
		} finally {
			setLang("en");
		}
	}
});

test("R4 a stalled direct model shows a notice but keeps the provider's error so Pi can still retry it", () => {
	const { notice, errorMessage } = exhaustedDirectOutcome(directInput({ stalled: true, until: undefined }));
	assert.equal(
		notice,
		"ai-balancer: claude-bridge/claude-fable-5-2 stopped responding. Your session is still open: send your message again, or pick another model with /model or /balancer.",
	);
	assert.equal(errorMessage, undefined);
	assert.equal(Object.hasOwn(exhaustedDirectOutcome(directInput({ stalled: true })), "errorMessage"), false);
});
