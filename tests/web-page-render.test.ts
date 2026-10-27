import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { webPageScript } from "../src/web-page.ts";

// Runs the real page script against a minimal DOM: enough to prove that the
// overview and the detail render, that clicks route and post, and that user
// text never becomes markup.

class FakeNode {
	tag: string;
	children: FakeNode[] = [];
	attributes: Record<string, string> = {};
	listeners: Record<string, ((event: unknown) => void)[]> = {};
	style: Record<string, string> = {};
	className = "";
	disabled = false;
	private ownText = "";
	constructor(tag: string, text = "") {
		this.tag = tag;
		this.ownText = text;
	}
	get firstChild(): FakeNode | null {
		return this.children[0] ?? null;
	}
	appendChild(child: FakeNode): FakeNode {
		this.children.push(child);
		return child;
	}
	removeChild(child: FakeNode): FakeNode {
		this.children = this.children.filter(node => node !== child);
		return child;
	}
	setAttribute(name: string, value: string): void {
		this.attributes[name] = value;
		if (name === "disabled") this.disabled = true;
	}
	addEventListener(type: string, listener: (event: unknown) => void): void {
		(this.listeners[type] ??= []).push(listener);
	}
	set textContent(value: string) {
		this.children = [];
		this.ownText = value;
	}
	get textContent(): string {
		return this.ownText + this.children.map(child => child.textContent).join("");
	}
	all(): FakeNode[] {
		return [this, ...this.children.flatMap(child => child.all())];
	}
	click(): void {
		for (const listener of this.listeners.click ?? []) listener({});
	}
}

const report = {
	generatedAt: "2026-10-21T12:00:00.000Z",
	current: { session: "s1", model: "opus", contextTokens: 1200, contextWindow: 200000 },
	circuit: { tripped: false },
	totals: { tokens: 420, cost: 1.75, requests: 4 },
	providers: [{ provider: "claude", requests: 4, input: 10, output: 5, cacheRead: 100, cacheWrite: 20, total: 135, cost: 1.75, unpriced: 0 }],
	daily: [],
	quota: [{ limit: "claude", window: "5h", usedPercent: 93, resetAt: null, ts: Date.now(), stale: false }],
	roles: [
		{
			role: "orchestrator",
			requests: 4,
			contextResend: 130,
			newOutput: 5,
			total: 135,
			sessions: [
				{ session: "s1", alias: "<img src=x onerror=alert(1)>", project: "proj", parentSession: null, providers: ["claude"], firstTs: 1, lastTs: Date.now(), requests: 4, contextResend: 130, newOutput: 5, total: 135, canOpen: true, isCurrent: false },
			],
		},
	],
	suggestions: [{ rule: "large-context", title: "Compact it", session: "s1", alias: null }],
	decisions: {
		total: 1,
		byRule: [{ rule: "highest-quota", count: 1 }],
		byRole: [{ role: "gentle-ai-verify", pool: "opus", chosen: "claude-bridge/opus", count: 1 }],
		recent: [
			{
				ts: Date.now(), project: "<b>proj</b>", session: "01234567", role: "gentle-ai-verify", roleSource: "argv", reason: "user", pool: "opus",
				chosen: "claude-bridge/opus", decidedBy: "highest-quota", contextTokens: 1200,
				steps: [{ rule: "available", result: "2 of 2", why: "no window is spent" }, { rule: "pick", result: "chosen", why: "<script>x</script> 0.62 > agy/opus 0.30" }],
				candidates: [{ provider: "claude-bridge", quotaKey: "claude-bridge/claude", available: true, remaining: 0.62 }, { provider: "agy", quotaKey: "agy/claude", available: false, remaining: 0, availableAt: Date.now() + 3600000 }],
			},
		],
		omitted: 0,
	},
};

const detail = {
	session: "s1",
	alias: "<img src=x onerror=alert(1)>",
	project: "proj",
	role: "orchestrator",
	parentSession: null,
	path: "/s/s1.jsonl",
	cwd: "/p",
	canOpen: true,
	isCurrent: false,
	totals: { requests: 1, input: 10, output: 5, cacheRead: 100, cacheWrite: 20, contextResend: 130, newOutput: 5, total: 135 },
	firstTs: 1,
	lastTs: 2,
	models: [{ provider: "claude", model: "opus", requests: 1, total: 135 }],
	children: [{ session: "c1", agent: "worker", label: "write tests", requests: 1, total: 10 }],
	requests: [{ ts: 2, provider: "claude", model: "opus", input: 10, output: 5, cacheRead: 100, cacheWrite: 20, contextTokens: null, contextWindow: null }],
	omittedRequests: 0,
	resume: "cd '/p' && gentle-shell --session '/s/s1.jsonl'",
};

function harness(options: { status?: number; confirm?: boolean; report?: unknown; snapshot?: unknown } = {}) {
	const app = new FakeNode("main");
	const status = new FakeNode("span");
	const calls: { url: string; init?: { method?: string } }[] = [];
	const copied: string[] = [];
	const location = { hash: "" };
	const windowListeners: Record<string, (() => void)[]> = {};
	const intervals: number[] = [];
	const snapshotData = new FakeNode("script", JSON.stringify(options.snapshot ?? null));
	const context = {
		document: {
			hidden: false,
			getElementById: (id: string) => (id === "app" ? app : id === "snapshot-data" ? snapshotData : status),
			createElement: (tag: string) => new FakeNode(tag),
			createTextNode: (text: string) => new FakeNode("#text", text),
			addEventListener: () => {},
		},
		window: { addEventListener: (type: string, fn: () => void) => (windowListeners[type] ??= []).push(fn), scrollTo: () => {} },
		location,
		navigator: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
		confirm: () => options.confirm ?? true,
		setInterval: (_fn: () => void, ms: number) => void intervals.push(ms),
		fetch: async (url: string, init?: { method?: string }) => {
			calls.push({ url, init });
			const body = url === "/api/report" ? (options.report ?? report) : url.endsWith("/open") ? { ok: true, message: "Pi switches to it when idle" } : detail;
			return { status: options.status ?? 200, ok: (options.status ?? 200) < 400, json: async () => body };
		},
		Date,
		Math,
		String,
		JSON,
		encodeURIComponent,
		decodeURIComponent,
	};
	runInNewContext(webPageScript({ snapshot: options.snapshot !== undefined }), context);
	const settle = () => new Promise(resolve => setImmediate(resolve));
	const navigate = async (hash: string) => {
		location.hash = hash;
		for (const fn of windowListeners.hashchange ?? []) fn();
		await settle();
		await settle();
	};
	return { app, status, calls, copied, intervals, navigate, settle };
}

test("the overview renders totals, quota, sessions and providers, with user text kept as text", async () => {
	const page = harness();
	await page.settle();
	await page.settle();
	const text = page.app.textContent;
	assert.match(text, /30d tokens: 420/);
	assert.match(text, /claude · 5h/);
	assert.match(text, /93%/);
	assert.match(text, /<img src=x onerror=alert\(1\)>/);
	assert.match(text, /Compact it/);
	assert.ok(!page.app.all().some(node => node.tag === "img"), "an alias must never become an element");
	const fill = page.app.all().find(node => node.className.startsWith("meter-fill"));
	assert.equal(fill?.className, "meter-fill crit");
	assert.equal(fill?.style.width, "93%");
	assert.match(page.status.textContent, /^LIVE · updated/);
	assert.deepEqual(page.calls.map(call => call.url), ["/api/report"]);
});

test("clicking a session row routes to its detail with the resume command and both actions", async () => {
	const page = harness();
	await page.settle();
	await page.settle();
	const row = page.app.all().find(node => node.tag === "tr" && node.className.includes("link"));
	assert.ok(row);
	const listeners = row.listeners.click ?? [];
	assert.equal(listeners.length, 1);

	await page.navigate("#/session/s1");
	assert.equal(page.calls.at(-1)?.url, "/api/sessions/s1");
	const text = page.app.textContent;
	assert.match(text, /cd '\/p' && gentle-shell --session '\/s\/s1\.jsonl'/);
	assert.match(text, /Subagents it launched/);
	assert.match(text, /write tests/);

	const buttons = page.app.all().filter(node => node.tag === "button");
	const copyButton = buttons.find(node => node.textContent === "Copy shell command");
	const openButton = buttons.find(node => node.textContent === "Open in Pi");
	assert.ok(copyButton && openButton);
	copyButton.click();
	await page.settle();
	assert.deepEqual(page.copied, [detail.resume]);

	openButton.click();
	await page.settle();
	await page.settle();
	const post = page.calls.find(call => call.url === "/api/sessions/s1/open");
	assert.equal(post?.init?.method, "POST");
	await page.settle();
	assert.match(page.app.textContent, /Pi switches to it when idle/);
});

test("declining the confirmation posts nothing", async () => {
	const page = harness({ confirm: false });
	await page.navigate("#/session/s1");
	const openButton = page.app.all().find(node => node.tag === "button" && node.textContent === "Open in Pi");
	assert.ok(openButton, "the detail offers Open in Pi");
	openButton.click();
	await page.settle();
	assert.ok(!page.calls.some(call => call.url.endsWith("/open")));
});

test("a 401 shows how to get the address with the token", async () => {
	const page = harness({ status: 401 });
	await page.settle();
	await page.settle();
	assert.match(page.app.textContent, /run \/balancer serve status/);
	assert.match(page.status.textContent, /OFFLINE: token missing or expired/);
});

test("the overview explains routing decisions as role, pool and provider with every rule step", async () => {
	const page = harness();
	await page.settle();
	await page.settle();
	const text = page.app.textContent;
	assert.match(text, /Routing decisions/);
	assert.match(text, /highest-quota: 1/);
	assert.match(text, /gentle-ai-verify → opus → claude-bridge\/opus/);
	assert.match(text, /pick: chosen — <script>x<\/script> 0\.62 > agy\/opus 0\.30/);
	assert.match(text, /available: 2 of 2 — no window is spent/);
	assert.match(text, /<b>proj<\/b>/);
	assert.match(text, /agy\/claude · spent until/);
	assert.ok(page.app.all().some(node => node.tag === "details"), "each decision expands");
	assert.ok(!page.app.all().some(node => node.tag === "script" || node.tag === "b"), "trace text must never become an element");
});

test("a decision that moved a session shows its switch cost and advice", async () => {
	const moved = {
		...report.decisions.recent[0],
		reason: "continuation",
		switchCost: {
			from: "agy/opus", to: "claude-bridge/opus", contextTokens: 152_300, stayTokens: 15_230, switchTokens: 190_375,
			stay: [{ key: "agy/claude", window: "week", percent: 0.0244 }],
			switch: [{ key: "claude-bridge/claude", window: "5h", percent: 3.046 }, { key: "claude-bridge/claude", window: "week", percent: null }],
			advice: { action: "wait", why: "<i>context 152k</i> and the window resets in 20 min" },
		},
	};
	const page = harness({ report: { ...report, decisions: { ...report.decisions, recent: [moved] } } });
	await page.settle();
	await page.settle();
	const text = page.app.textContent;
	assert.match(text, /moved from agy\/opus: staying 15\.2k weighted tokens \(agy\/claude week 0\.02%\) · moving 190\.4k \(claude-bridge\/claude 5h 3\.05%, claude-bridge\/claude week not calibrated\)/);
	assert.match(text, /advice: wait — <i>context 152k<\/i> and the window resets in 20 min/);
	assert.ok(!page.app.all().some(node => node.tag === "i"), "advice text must never become an element");
});

test("without decisions the overview says when they appear", async () => {
	const page = harness({ report: { ...report, decisions: { total: 0, byRule: [], byRole: [], recent: [], omitted: 0 } } });
	await page.settle();
	await page.settle();
	assert.match(page.app.textContent, /No routing decisions yet/);
});

test("a snapshot renders the overview and the embedded session detail without any request", async () => {
	const page = harness({ snapshot: { report, sessions: { s1: detail } } });
	await page.settle();
	await page.settle();
	assert.match(page.app.textContent, /30d tokens: 420/);
	assert.match(page.status.textContent, /^SNAPSHOT · taken /);
	assert.match(page.status.textContent, /read-only/);
	assert.deepEqual(page.intervals, [1000], "a snapshot never polls for data");

	await page.navigate("#/session/s1");
	const text = page.app.textContent;
	assert.match(text, /cd '\/p' && gentle-shell --session '\/s\/s1\.jsonl'/);
	const openButton = page.app.all().find(node => node.tag === "button" && node.textContent.startsWith("Open in Pi"));
	assert.ok(openButton?.disabled, "a snapshot cannot switch the running Pi");
	assert.match(openButton?.attributes.title ?? "", /live web report/);
	openButton?.click();
	await page.settle();
	assert.deepEqual(page.calls, []);
});

test("a snapshot says when a session detail was not captured", async () => {
	const page = harness({ snapshot: { report, sessions: {} } });
	await page.settle();
	await page.navigate("#/session/zz");
	assert.match(page.app.textContent, /Unknown session/);
	assert.deepEqual(page.calls, []);
});
