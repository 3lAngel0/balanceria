import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLang } from "../src/i18n/index.ts";
import { startWebServer, type WebServer } from "../src/web-server.ts";
import {
	createInstallerSession,
	installerPageHtml,
	installerPageScript,
	installerPageStyle,
	parseInstallerAction,
	setInstallerSession,
	type InstallerHostDeps,
	type InstallerOutcome,
	type InstallerSession,
} from "../src/web-installer.ts";
import { applyStepper, type StepperCurrent } from "../src/setup-stepper.ts";
import { writeConfigSafely, type DetectedProvider } from "../src/setup.ts";

setLang("en");

const TOKEN = "t".repeat(43);
const provider = (id: string, availableModels: string[]): DetectedProvider => ({ id, label: id, kind: "subscription", detected: true, source: "test", availableModels });
const both = [provider("claude-bridge", ["claude-opus-5-5", "claude-sonnet-5-5"]), provider("antigravity", ["claude-sonnet-5-5", "gemini-3-8-flash"])];

interface Harness {
	server: WebServer;
	session: InstallerSession;
	root: string;
	outcomes: InstallerOutcome[];
	notices: string[];
	cleanup(): Promise<void>;
}

async function harness(options: { active?: boolean; detect?: () => DetectedProvider[]; deepAnalysis?: InstallerHostDeps["deepAnalysis"]; install?: InstallerHostDeps["install"]; current?: StepperCurrent } = {}): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "web-installer-"));
	const tokenFile = join(root, "web-token");
	writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
	const outcomes: InstallerOutcome[] = [];
	const notices: string[] = [];
	const deps: InstallerHostDeps = {
		detect: options.detect ?? (() => both),
		install:
			options.install ??
			((draft, current) =>
			applyStepper(draft, { root, current, profilesPath: join(root, "profiles.json"), writeConfig: writeConfigSafely, writeProfiles: () => {} })),
		undo: backups => backups.forEach(() => {}),
		deepAnalysis: options.deepAnalysis ?? (async () => ({ recommendations: [] }) as never),
		notify: message => notices.push(message),
	};
	const session = createInstallerSession({ detected: both, current: options.current, installed: options.current ? false : undefined }, deps);
	session.onEnd(outcome => outcomes.push(outcome));
	if (options.active !== false) setInstallerSession(session);
	const server = await startWebServer({
		port: 0,
		tokenFile,
		page: () => "<!DOCTYPE html><title>page</title>",
		script: () => "",
		style: () => "",
		getReport: () => ({}),
		getSession: () => undefined,
		openSession: async () => ({ ok: true, message: "" }),
	});
	return {
		server,
		session,
		root,
		outcomes,
		notices,
		async cleanup() {
			session.close();
			setInstallerSession(undefined);
			await server.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
	json(): any;
}

function send(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...options.headers } }, res => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", chunk => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
		});
		req.on("error", reject);
		req.end(options.body);
	});
}

const auth = { cookie: `balancer_token=${TOKEN}` };
const get = (h: Harness, path = "/api/installer", headers: Record<string, string> = auth) => send(h.server.port, path, { headers });
const post = (h: Harness, body: unknown, headers: Record<string, string> = {}) =>
	send(h.server.port, "/api/installer", {
		method: "POST",
		headers: { ...auth, "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

async function settle(h: Harness): Promise<any> {
	for (let i = 0; i < 100; i++) {
		const reply = await get(h);
		const view = reply.json();
		if (!view.pending) return view;
		await new Promise(r => setTimeout(r, 20));
	}
	throw new Error("installer stayed pending");
}

test("the installer routes need the token", async () => {
	const h = await harness();
	try {
		for (const path of ["/installer", "/installer.js", "/installer.css", "/api/installer"]) {
			assert.equal((await send(h.server.port, path)).status, 401, path);
		}
		const bare = await send(h.server.port, "/api/installer", { method: "POST", headers: { "content-type": "application/json" }, body: '{"type":"next"}' });
		assert.equal(bare.status, 401);
		assert.equal(h.session.screen().step, "welcome");
	} finally {
		await h.cleanup();
	}
});

test("the Host header must still be loopback", async () => {
	const h = await harness();
	try {
		const reply = await send(h.server.port, "/api/installer", { headers: { ...auth, host: "evil.example.com" } });
		assert.equal(reply.status, 403);
	} finally {
		await h.cleanup();
	}
});

test("without an active session no installer route exists", async () => {
	const h = await harness({ active: false });
	try {
		for (const path of ["/installer", "/installer.js", "/installer.css", "/api/installer"]) {
			assert.equal((await get(h, path)).status, 404, path);
		}
		assert.equal((await post(h, { type: "next" })).status, 404);
	} finally {
		await h.cleanup();
	}
});

test("GET returns the screen of the shared model", async () => {
	const h = await harness();
	try {
		const reply = await get(h);
		assert.equal(reply.status, 200);
		assert.match(String(reply.headers["content-type"]), /^application\/json/);
		const view = reply.json();
		assert.equal(view.screen.step, "welcome");
		assert.equal(view.screen.title, h.session.screen().title);
		assert.equal(view.pending, false);
		assert.equal(view.finished, false);
		assert.equal(view.text.stepOf, "Step 1 of 7");
		assert.ok(view.text.help.length > 0);
	} finally {
		await h.cleanup();
	}
});

test("POST next, back, select, toggle and button change the state", async () => {
	const h = await harness();
	try {
		let view = (await post(h, { type: "next" })).json();
		assert.equal(view.screen.step, "type");
		view = (await post(h, { type: "back" })).json();
		assert.equal(view.screen.step, "welcome");
		await post(h, { type: "next" });
		view = (await post(h, { type: "select", index: 1 })).json();
		assert.equal(view.screen.control.selected, 1);
		view = (await post(h, { type: "help" })).json();
		assert.equal(view.screen.helpOpen, true);
		await post(h, { type: "help" });
		await post(h, { type: "next" });
		view = await settle(h);
		assert.equal(view.screen.step, "scan");
		view = (await post(h, { type: "next" })).json();
		assert.equal(view.screen.step, "subscriptions");
		const first = view.screen.control.items[0].checked;
		view = (await post(h, { type: "toggle", index: 0 })).json();
		assert.equal(view.screen.control.items[0].checked, !first);
		view = (await post(h, { type: "button", id: "back" })).json();
		assert.equal(view.screen.step, "scan");
		assert.equal(view.screen.step, h.session.screen().step);
	} finally {
		await h.cleanup();
	}
});

test("rejected requests leave the state unchanged", async () => {
	const h = await harness();
	try {
		await post(h, { type: "next" });
		const before = JSON.stringify(h.session.screen());
		const bad: [string, Reply][] = [
			["unknown action", await post(h, { type: "format-disk" })],
			["extra field", await post(h, { type: "next", sudo: true })],
			["missing index", await post(h, { type: "toggle" })],
			["negative index", await post(h, { type: "toggle", index: -1 })],
			["fractional index", await post(h, { type: "select", index: 1.5 })],
			["unknown button", await post(h, { type: "button", id: "rm-rf" })],
			["huge move", await post(h, { type: "move", delta: 1000000 })],
			["not an object", await post(h, "[1,2]")],
			["not json", await post(h, "{nope")],
		];
		for (const [name, reply] of bad) assert.equal(reply.status, 400, name);
		const type = await post(h, { type: "next" }, { "content-type": "text/plain" });
		assert.equal(type.status, 415);
		const big = await post(h, JSON.stringify({ type: "next", pad: "x".repeat(70 * 1024) }));
		assert.equal(big.status, 413);
		const cross = await post(h, { type: "next" }, { origin: "http://evil.example.com" });
		assert.equal(cross.status, 403);
		assert.equal(JSON.stringify(h.session.screen()), before);
	} finally {
		await h.cleanup();
	}
});

test("only GET and POST reach the installer API", async () => {
	const h = await harness();
	try {
		const reply = await send(h.server.port, "/api/installer", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: '{"type":"next"}' });
		assert.equal(reply.status, 405);
		assert.equal(h.session.screen().step, "welcome");
	} finally {
		await h.cleanup();
	}
});

test("cancelling in web installer finishes session gracefully and does not throw 409", async () => {
	const h = await harness();
	try {
		const reply1 = await post(h, { type: "button", id: "cancel" });
		assert.equal(reply1.status, 200);
		const data1 = reply1.json();
		assert.equal(data1.finished, true);
		assert.equal(data1.outcome, "exit");
		assert.ok(data1.text.cancelled);
		assert.ok(data1.text.cancelledHint);

		// Second click/post returns 409 with finished state
		const reply2 = await post(h, { type: "button", id: "cancel" });
		assert.equal(reply2.status, 409);
		const data2 = reply2.json();
		assert.equal(data2.finished, true);
		assert.equal(data2.outcome, "exit");
	} finally {
		await h.cleanup();
	}
});

test("a recommended install writes through the injected deps and finishes with the terminal callback", async () => {
	const h = await harness();
	try {
		await post(h, { type: "next" });
		await post(h, { type: "next" });
		let view = await settle(h);
		assert.equal(view.screen.step, "scan");
		assert.equal(view.screen.control.kind, "progress");
		await post(h, { type: "next" });
		view = (await get(h)).json();
		assert.equal(view.screen.step, "subscriptions");
		await post(h, { type: "next" });
		view = (await get(h)).json();
		assert.equal(view.screen.step, "summary");
		assert.equal(existsSync(join(h.root, "pools.json")), false);
		await post(h, { type: "button", id: "install" });
		view = await settle(h);
		assert.equal(view.screen.step, "done");
		assert.equal(existsSync(join(h.root, "pools.json")), true);
		assert.ok(JSON.parse(readFileSync(join(h.root, "pools.json"), "utf8")));
		assert.equal(view.finished, false);
		assert.deepEqual(h.outcomes, []);
		view = (await post(h, { type: "button", id: "exit" })).json();
		assert.equal(view.finished, true);
		assert.equal(view.outcome, "exit");
		assert.deepEqual(h.outcomes, ["exit"]);
		const after = await post(h, { type: "back" });
		assert.equal(after.status, 409);
		assert.deepEqual(h.outcomes, ["exit"]);
	} finally {
		await h.cleanup();
	}
});

test("deep analysis returns at once with pending set while it runs", async () => {
	const h = await harness();
	try {
		let release: () => void = () => {};
		const gate = new Promise<void>(resolve => (release = resolve));
		const session = createInstallerSession(
			{ detected: both },
			{
				detect: () => both,
				install: () => ({ ok: true, written: [], backups: [] }),
				undo: () => {},
				deepAnalysis: async () => {
					await gate;
					return { recommendations: [] } as never;
				},
				notify: () => {},
			},
		);
		setInstallerSession(session);
		const step = async (a: unknown) => (await post(h, a)).json();
		await step({ type: "next" });
		await step({ type: "select", index: 1 });
		await step({ type: "next" });
		await settle(h);
		for (let i = 0; i < 3; i++) await step({ type: "next" });
		let view = (await get(h)).json();
		assert.equal(view.screen.step, "tasks");
		view = await step({ type: "button", id: "deep-analysis" });
		assert.equal(view.screen.control.kind, "choice");
		view = await step({ type: "select", index: 0 });
		view = await step({ type: "button", id: "deep-analysis" });
		assert.equal(view.pending, true);
		release();
		view = await settle(h);
		assert.equal(view.pending, false);
		session.close();
	} finally {
		await h.cleanup();
	}
});

test("parseInstallerAction accepts exactly the model actions", () => {
	assert.deepEqual(parseInstallerAction({ type: "move", delta: -1 }), { type: "move", delta: -1 });
	assert.deepEqual(parseInstallerAction({ type: "open", index: 2 }), { type: "open", index: 2 });
	assert.equal(parseInstallerAction({ type: "button", id: "undo" })?.type, "button");
	assert.equal(parseInstallerAction({ type: "button", id: "toString" }), undefined);
	assert.equal(parseInstallerAction({ type: "__proto__" }), undefined);
	assert.equal(parseInstallerAction(null), undefined);
});

test("the page is self-contained and fits the server CSP", async () => {
	const h = await harness();
	try {
		const page = await get(h, "/installer");
		assert.equal(page.status, 200);
		assert.match(String(page.headers["content-type"]), /^text\/html/);
		const csp = String(page.headers["content-security-policy"]);
		assert.match(csp, /script-src 'self'/);
		assert.match(csp, /style-src 'self'/);
		assert.equal(page.body, installerPageHtml());
		const html = installerPageHtml();
		assert.doesNotMatch(html, /<script(?![^>]*\bsrc="\/installer\.js")[^>]*>[\s\S]*?<\/script>/);
		assert.doesNotMatch(html, /<script[^>]*>(?!\s*<\/script>)/);
		assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=|<style/i);
		assert.doesNotMatch(html + installerPageScript() + installerPageStyle(), /https?:\/\/(?!www\.w3\.org)|@import|url\(|\beval\(|innerHTML|document\.write/);
		assert.match(html, /\/installer\.css/);
		assert.match(html, /\/installer\.js/);
		assert.match(String((await get(h, "/installer.js")).headers["content-type"]), /^text\/javascript/);
		assert.match(String((await get(h, "/installer.css")).headers["content-type"]), /^text\/css/);
	} finally {
		await h.cleanup();
	}
});

// ---------------------------------------------------------------------------------------------
// T5: deep-analysis guard, timing and error propagation
// ---------------------------------------------------------------------------------------------

async function toDeepPicker(h: Harness): Promise<any> {
	await post(h, { type: "next" });
	await post(h, { type: "select", index: 1 });
	await post(h, { type: "next" });
	await settle(h);
	let view: any;
	for (let i = 0; i < 3; i++) view = (await post(h, { type: "next" })).json(); // subscriptions, backups, tasks
	assert.equal(view.screen.step, "tasks");
	view = (await post(h, { type: "button", id: "deep-analysis" })).json();
	assert.equal(view.screen.control.kind, "choice");
	return (await post(h, { type: "select", index: 0 })).json();
}

const REPORT = { source: "ai+heuristic", estimatedTokens: 900, tokensExact: true, summary: "ok", recommendations: [] } as never;

test("two deep-analysis requests in a row call the runner once, show progress, then the confirmation", async () => {
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>(resolve => (release = resolve));
	const h = await harness({
		deepAnalysis: async () => {
			calls += 1;
			await gate;
			return REPORT;
		},
	});
	try {
		await toDeepPicker(h);
		const replies = await Promise.all([post(h, { type: "button", id: "deep-analysis" }), post(h, { type: "button", id: "deep-analysis" }), post(h, { type: "button", id: "deep-analysis" })]);
		assert.ok(replies.every(r => r.status === 200));
		const view = (await get(h)).json();
		assert.equal(view.pending, true);
		assert.equal(view.screen.pending.kind, "deep-analysis");
		assert.equal(view.screen.buttons.find((b: any) => b.id === "deep-analysis").enabled, false);
		release();
		const done = await settle(h);
		assert.equal(calls, 1);
		assert.equal(done.screen.pending, undefined);
		assert.equal(done.screen.analysis.tokens, 900);
		assert.equal(done.screen.analysis.exact, true);
		assert.ok(done.screen.analysis.durationMs >= 0);
		assert.match(done.screen.confirmation, /^Consulted in \d+\.\d s, used 900 tokens of subscription claude-bridge$/);
		// and a new analysis is possible once it finished
		await post(h, { type: "button", id: "deep-analysis" });
		assert.equal((await get(h)).json().screen.control.kind, "choice");
	} finally {
		release();
		await h.cleanup();
	}
});

test("a deep analysis that fails or times out ends in an error screen, frees the button and never breaks the session", async () => {
	let calls = 0;
	const h = await harness({
		deepAnalysis: async () => {
			calls += 1;
			if (calls === 1) return { ...(REPORT as object), source: "heuristic", error: "timed out after 180 s" } as never;
			if (calls === 2) throw new Error("agy exploded");
			return REPORT;
		},
	});
	try {
		await toDeepPicker(h);
		await post(h, { type: "button", id: "deep-analysis" });
		let view = await settle(h);
		assert.match(view.screen.error.what, /timed out after 180 s/);
		assert.deepEqual(view.screen.buttons.map((b: any) => b.id), ["retry", "back"]);
		assert.equal(view.screen.pending, undefined);
		await post(h, { type: "button", id: "retry" });
		view = await settle(h);
		assert.match(view.screen.error.what, /agy exploded/);
		await post(h, { type: "button", id: "retry" });
		view = await settle(h);
		assert.equal(view.screen.error, undefined);
		assert.equal(calls, 3);
		assert.ok(view.screen.confirmation);
	} finally {
		await h.cleanup();
	}
});

test("an install that throws shows the install error with retry / back instead of hanging", async () => {
	const h = await harness({
		install: () => {
			throw new Error("EACCES: cannot write pools.json");
		},
	});
	try {
		await post(h, { type: "next" });
		await post(h, { type: "next" });
		await settle(h);
		await post(h, { type: "next" }); // subscriptions
		await post(h, { type: "next" }); // summary
		await post(h, { type: "button", id: "install" });
		const view = await settle(h);
		assert.equal(view.screen.step, "installing");
		assert.match(view.screen.error.what, /EACCES/);
		assert.ok(view.screen.buttons.some((b: any) => b.id === "retry" && b.enabled));
		assert.ok(view.screen.buttons.some((b: any) => b.id === "back" && b.enabled));
		const back = (await post(h, { type: "button", id: "back" })).json();
		assert.equal(back.screen.step, "summary");
	} finally {
		await h.cleanup();
	}
});

test("the page may send the new backup actions and nothing else", () => {
	for (const id of ["move-up", "move-down", "cycle-method"]) assert.deepEqual(parseInstallerAction({ type: "button", id }), { type: "button", id });
	assert.equal(parseInstallerAction({ type: "button", id: "cycle-strategy" }), undefined);
});

test("T7 (S11, S14, S15, S17, S19): /installer serves Design 3 conversational guide, capybara mascot, right-hand help, closing notice and welcome", async () => {
	const h = await harness();
	try {
		const style = installerPageStyle();
		for (const token of ["--bg:#181425", "--surface:#262b44", "--accent:#feae34", ".rail", ".talk", ".guide", ".bubble", ".stage", ".reply", ".close-note", ".help", ".cap", "prefers-reduced-motion:reduce"]) {
			assert.ok(style.includes(token), `missing style token: ${token}`);
		}
		const script = installerPageScript();
		for (const part of ["0 0 22 24", "close-note", "bubble", "guide", "rail", "stage", "help", "defs", "narr", "steps-run"]) {
			assert.ok(script.includes(part), `missing script part: ${part}`);
		}
		const view = (await get(h)).json();
		assert.equal(view.pose, "idle");
		assert.equal(typeof view.reduceMotion, "boolean");
		assert.ok(view.text.guideName.length > 0);
		assert.ok(view.text.helpWhat.length > 0);
		assert.ok(view.text.helpPurpose.length > 0);
		assert.ok(view.text.helpIf.length > 0);
		assert.match(view.screen.notice, /nothing is applied/i);
		assert.equal(view.screen.welcome.star.url, "https://github.com/3lAngel0/balanceria");
		assert.equal(view.screen.welcome.definitions.length, 5);
		assert.equal(view.screen.welcome.willDo.length, 4);
	} finally {
		await h.cleanup();
	}
});

test("T7 (S13, S14, S18, S20, S21): web view exposes focused help, backup pipeline actions, deep analysis pose/progress/confirmation, and human summary", async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => (release = resolve));
	const h = await harness({
		deepAnalysis: async () => {
			await gate;
			return REPORT;
		},
	});
	try {
		await post(h, { type: "next" }); // type
		let view = (await post(h, { type: "select", index: 1 })).json(); // custom
		assert.equal(view.screen.help.focus.technicalName, "guided setup");
		assert.match(view.text.helpName, /guided setup/);
		await post(h, { type: "next" }); // scan
		await settle(h);
		view = (await post(h, { type: "next" })).json(); // subscriptions
		assert.equal(view.screen.step, "subscriptions");
		assert.ok(view.screen.help.focus.ifPicked.length > 0);
		view = (await post(h, { type: "next" })).json(); // backups
		assert.equal(view.screen.step, "backups");
		assert.equal(view.screen.backupDetail.method, "hybrid");
		view = (await post(h, { type: "button", id: "cycle-method" })).json();
		assert.equal(view.screen.backupDetail.method, "waterfall");
		await post(h, { type: "next" }); // tasks
		await post(h, { type: "button", id: "deep-analysis" });
		await post(h, { type: "select", index: 0 });
		await post(h, { type: "button", id: "deep-analysis" });
		view = (await get(h)).json();
		assert.equal(view.pose, "working");
		assert.equal(view.screen.pending.kind, "deep-analysis");
		release();
		view = await settle(h);
		assert.equal(view.pose, "idle");
		assert.match(view.screen.confirmation, /Consulted in .*900 tokens of subscription claude-bridge/);
		await post(h, { type: "next" }); // main-agent
		view = (await post(h, { type: "next" })).json(); // summary
		assert.equal(view.screen.step, "summary");
		assert.match(view.screen.summary.narrative, /balance the load/i);
		assert.ok(view.screen.summary.detail.length >= 4);
		assert.match(view.screen.summary.closing, /Enter/i);
		assert.ok(view.screen.notice);
		await post(h, { type: "button", id: "install" });
		view = await settle(h);
		assert.equal(view.screen.step, "done");
		assert.equal(view.pose, "happy");
		assert.equal(view.screen.notice, undefined);
	} finally {
		release();
		await h.cleanup();
	}
});

test("the install effect receives the draft with the backups saved profiles still use", async () => {
	let received: string[] = [];
	const current = {
		pools: { pools: [{ id: "orchestrator", name: "orchestrator", candidates: ["claude-bridge/claude-sonnet-5-5"], strategy: "hybrid" }] },
		profiles: { active: "p", profiles: { p: { "legacy-role": { model: "pool/orchestrator" } } } },
	};
	const h = await harness({
		current,
		install: draft => {
			received = draft.pools.map(pool => pool.id);
			return { ok: true, written: [], backups: [] };
		},
	});
	try {
		await post(h, { type: "next" });
		await post(h, { type: "next" });
		await settle(h);
		await post(h, { type: "next" }); // subscriptions
		await post(h, { type: "next" }); // summary
		await post(h, { type: "button", id: "install" });
		await settle(h);
		assert.ok(received.includes("orchestrator"), `pools written: ${received.join(",")}`);
	} finally {
		await h.cleanup();
	}
});
