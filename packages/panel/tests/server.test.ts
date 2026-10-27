import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBundle } from "../src/bundle.ts";
import { DEFAULT_LAYOUT, LAYOUT_FILE } from "../src/layout.ts";
import { createHash } from "node:crypto";
import { createDraft } from "../../../src/lab.ts";
import { startPanel } from "../src/server.ts";

test("the panel serves the projects overview and session detail behind the token", async () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-server-"));
	const root = join(dir, "sessions");
	mkdirSync(join(root, "--home-a-shop--"), { recursive: true });
	writeFileSync(join(root, "--home-a-shop--", "2026-10-21T10-00-00-000Z_01bbb.jsonl"), JSON.stringify({ type: "session", cwd: "/home/a/shop" }) + "\n");
	const tokenFile = join(dir, "web-token");
	const server = await startPanel({ port: 0, root, tokenFile, dataDir: dir, github: () => "https://github.com/a/shop" });
	const base = `http://127.0.0.1:${server.port}`;
	const auth = { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` };
	try {
		assert.equal((await fetch(`${base}/api/report`)).status, 401);
		const report = await (await fetch(`${base}/api/report`, { headers: auth })).json();
		assert.deepEqual(report.projects.map((p: { cwd: string; github: string }) => [p.cwd, p.github]), [["/home/a/shop", "https://github.com/a/shop"]]);
		assert.equal(typeof report.generatedAt, "number");
		assert.equal(report.usage.days.length, 30);
		assert.deepEqual([report.usage.tokens, report.usage.quota], [[], []]);
		assert.deepEqual(report.decisions, { total: 0, byRule: [], byRole: [], recent: [], omitted: 0 });
		const detail = await (await fetch(`${base}/api/sessions/01bbb`, { headers: auth })).json();
		assert.equal(detail.cwd, "/home/a/shop");
		assert.equal((await fetch(`${base}/api/sessions/01zzz`, { headers: auth })).status, 404);
		const open = await fetch(`${base}/api/sessions/01bbb/open`, { method: "POST", headers: { ...auth, origin: base } });
		assert.equal(open.status, 409);
		assert.deepEqual(await open.json(), { ok: false, message: "the panel cannot open sessions yet" });
		const page = await (await fetch(`${base}/`, { headers: auth })).text();
		assert.match(page, /<script src="\/app.js"/);
		const csp = (await fetch(`${base}/app.js`, { headers: auth })).headers.get("content-security-policy");
		assert.match(csp ?? "", /script-src 'self'/);
		const bundle = readBundle();
		assert.equal(await (await fetch(`${base}/app.js`, { headers: auth })).text(), bundle.script);
		assert.equal(await (await fetch(`${base}/app.css`, { headers: auth })).text(), bundle.style);
	} finally {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the panel reads and saves its layout in data/web-layout.json", async () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-server-"));
	const tokenFile = join(dir, "web-token");
	const server = await startPanel({ port: 0, root: join(dir, "sessions"), tokenFile, dataDir: dir, github: () => null });
	const base = `http://127.0.0.1:${server.port}`;
	const auth = { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` };
	try {
		assert.deepEqual(await (await fetch(`${base}/api/layout`, { headers: auth })).json(), { layout: DEFAULT_LAYOUT });
		const next = { ...DEFAULT_LAYOUT, mode: "advanced" };
		const saved = await fetch(`${base}/api/layout`, { method: "POST", headers: { ...auth, origin: base, "content-type": "application/json" }, body: JSON.stringify(next) });
		assert.equal(saved.status, 200);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, LAYOUT_FILE), "utf8")), next);
		assert.deepEqual(await (await fetch(`${base}/api/layout`, { headers: auth })).json(), { layout: next });
	} finally {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the panel reads and edits the lab draft's pools.json behind the token, same-origin only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-server-"));
	const tokenFile = join(dir, "web-token");
	const poolsPath = join(dir, "pools.json");
	const live = { pools: [{ id: "opus", candidates: ["agy/opus", "claude-bridge/opus"], strategy: "hybrid" }] };
	writeFileSync(poolsPath, JSON.stringify(live));
	const server = await startPanel({ port: 0, root: join(dir, "sessions"), tokenFile, dataDir: dir, poolsPath, github: () => null });
	const base = `http://127.0.0.1:${server.port}`;
	const auth = { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` };
	const post = (body: unknown, origin = base) => fetch(`${base}/api/lab/pools`, { method: "POST", headers: { ...auth, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
	try {
		assert.equal((await fetch(`${base}/api/lab`)).status, 401);
		assert.deepEqual(await (await fetch(`${base}/api/lab`, { headers: auth })).json(), { draft: null });
		const none = await post({ version: "x", pools: live });
		assert.deepEqual([none.status, await none.json()], [409, { ok: false, message: "start a draft with /balancer lab new in Pi" }]);

		createDraft({ labDir: join(dir, "lab"), poolsPath, profilesPath: join(dir, "profiles.json") }, 1000);
		const view = await (await fetch(`${base}/api/lab`, { headers: auth })).json();
		assert.equal(view.draft.version, createHash("sha256").update(JSON.stringify(live)).digest("hex"));
		const next = { pools: [{ ...live.pools[0], rules: [{ rule: "sticky" }, { rule: "pick", mode: "highest-quota" }] }] };
		const cross = await post({ version: view.draft.version, pools: next }, "http://evil.example");
		assert.equal(cross.status, 403);
		assert.equal(readFileSync(join(dir, "lab", "pools.json"), "utf8"), JSON.stringify(live));
		const saved = await post({ version: view.draft.version, pools: next });
		assert.equal(saved.status, 200);
		const body = await saved.json();
		assert.equal(body.ok, true);
		assert.deepEqual(body.draft.pools, next);
		assert.equal(readFileSync(poolsPath, "utf8"), JSON.stringify(live));
		const stale = await post({ version: view.draft.version, pools: live });
		assert.deepEqual([stale.status, await stale.json()], [409, { ok: false, message: "the draft changed; reload" }]);
	} finally {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the panel executes session actions (compact, cancel, delete to trash, restore) behind the token", async () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-server-actions-"));
	const root = join(dir, "sessions");
	const projDir = join(root, "my-proj");
	mkdirSync(projDir, { recursive: true });
	const sessionFile = join(projDir, "2026-10-25T10-00-00-000Z_sess1.jsonl");
	writeFileSync(sessionFile, JSON.stringify({ type: "session" }) + "\n");

	const tokenFile = join(dir, "web-token");
	let compactedPath = "";
	let cancelledId = "";
	const server = await startPanel({
		port: 0,
		root,
		tokenFile,
		dataDir: dir,
		poolsPath: join(dir, "pools.json"),
		github: () => null,
		rpcRunner: async path => {
			compactedPath = path;
			return { ok: true, message: "compacted ok" };
		},
		liveManager: {
			isLive: id => id === "sess1",
			cancel: async id => {
				cancelledId = id;
				return true;
			},
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	const auth = { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` };
	const post = (path: string, body: unknown = {}, origin = base) =>
		fetch(`${base}${path}`, {
			method: "POST",
			headers: { ...auth, origin, "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	try {
		// 1. Compact
		const compRes = await post("/api/sessions/sess1/compact");
		assert.equal(compRes.status, 200);
		assert.deepEqual(await compRes.json(), { ok: true, message: "compacted ok" });
		assert.equal(compactedPath, sessionFile);

		// 2. Cancel
		const cancelRes = await post("/api/sessions/sess1/cancel");
		assert.equal(cancelRes.status, 200);
		assert.deepEqual(await cancelRes.json(), { ok: true, message: "session cancelled" });
		assert.equal(cancelledId, "sess1");

		// 3. Delete to trash
		const delRes = await post("/api/sessions/sess1/delete");
		assert.equal(delRes.status, 200);
		const delJson = await delRes.json();
		assert.equal(delJson.ok, true);
		assert.match(delJson.relativePath, /my-proj\/2026-10-25T10-00-00-000Z_sess1\.jsonl$/);

		// 4. List trash
		const trashListRes = await fetch(`${base}/api/trash`, { headers: auth });
		assert.equal(trashListRes.status, 200);
		const trashList = await trashListRes.json();
		assert.equal(trashList.trash.length, 1);
		assert.equal(trashList.trash[0].sessionId, "sess1");

		// 5. Restore from trash
		const restoreRes = await post("/api/trash/restore", { relativePath: delJson.relativePath });
		assert.equal(restoreRes.status, 200);
		assert.deepEqual(await restoreRes.json(), { ok: true, restoredPath: sessionFile });

		// Verify file restored
		const trashListAfter = await (await fetch(`${base}/api/trash`, { headers: auth })).json();
		assert.equal(trashListAfter.trash.length, 0);
	} finally {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the panel reads and edits profiles.json behind the token, same-origin only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-server-profiles-"));
	const tokenFile = join(dir, "web-token");
	const profilesPath = join(dir, "profiles.json");
	const initial = {
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		active: "default",
		profiles: {
			default: {
				orchestrator: { model: "anthropic/claude-3-7-sonnet" },
			},
		},
	};
	writeFileSync(profilesPath, JSON.stringify(initial, null, 1) + "\n");

	const server = await startPanel({
		port: 0,
		root: join(dir, "sessions"),
		tokenFile,
		dataDir: dir,
		poolsPath: join(dir, "pools.json"),
		profilesPath,
		hasModel: (p, m) => `${p}/${m}` === "antigravity/gemini-3-8-flash" || `${p}/${m}` === "anthropic/claude-3-7-sonnet",
	});
	const base = `http://127.0.0.1:${server.port}`;
	const auth = { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` };
	const post = (body: unknown, origin = base) =>
		fetch(`${base}/api/profiles`, {
			method: "POST",
			headers: { ...auth, origin, "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	try {
		// Read profiles
		const getRes = await fetch(`${base}/api/profiles`, { headers: auth });
		assert.equal(getRes.status, 200);
		const view = await getRes.json();
		assert.deepEqual(view.profiles, initial);
		assert.equal(view.raw, JSON.stringify(initial, null, 1) + "\n");

		// Cross-origin rejected
		const next = {
			...initial,
			profiles: {
				default: {
					orchestrator: { model: "antigravity/gemini-3-8-flash" },
				},
			},
		};
		const cross = await post({ profiles: next, raw: view.raw }, "http://attacker.example");
		assert.equal(cross.status, 403);

		// Valid save
		const saveRes = await post({ profiles: next, raw: view.raw });
		assert.equal(saveRes.status, 200);
		const savedBody = await saveRes.json();
		assert.equal(savedBody.ok, true);
		assert.deepEqual(savedBody.profiles, next);

		// Stale save rejected
		const staleRes = await post({ profiles: next, raw: view.raw });
		assert.equal(staleRes.status, 409);
		assert.deepEqual(await staleRes.json(), { ok: false, message: "ai-balancer: refusing to write: profiles.json changed since it was read; nothing written, try again" });
	} finally {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the panel serves alerts via /api/report and /api/alerts, and dispatches desktop notifications", async () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-server-alerts-"));
	const tokenFile = join(dir, "web-token");
	const loansFile = join(dir, "loans.json");
	const validLoan = {
		id: "l-alert",
		profile: "default",
		role: "worker",
		pool: "sonnet",
		from: "pool/sonnet",
		to: "antigravity/gemini-3-8-flash",
		grantId: "g-1",
		why: "preferred is spent",
		status: "proposed",
		level: "suggest",
		alternatives: [],
		proposedAt: 1000,
		endsAt: 5000,
		advice: { advice: "switch" },
	};
	writeFileSync(loansFile, JSON.stringify({ version: 1, loans: [validLoan] }) + "\n");

	const notified: string[] = [];
	const server = await startPanel({
		port: 0,
		root: join(dir, "sessions"),
		tokenFile,
		dataDir: dir,
		desktopAlerts: true,
		alertRunner: async (cmd, args) => {
			notified.push(`${cmd} ${args.join(" ")}`);
		},
	});

	const base = `http://127.0.0.1:${server.port}`;
	const auth = { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` };

	try {
		// 1. Report includes alerts
		const reportRes = await fetch(`${base}/api/report`, { headers: auth });
		assert.equal(reportRes.status, 200);
		const report = await reportRes.json();
		assert.ok(Array.isArray(report.alerts));
		assert.ok(report.alerts.some((a: { id: string }) => a.id === "loan-l-alert"));

		// 2. GET /api/alerts returns alerts array
		const alertsRes = await fetch(`${base}/api/alerts`, { headers: auth });
		assert.equal(alertsRes.status, 200);
		const alertsBody = await alertsRes.json();
		assert.ok(Array.isArray(alertsBody.alerts));
		assert.ok(alertsBody.alerts.some((a: { id: string }) => a.id === "loan-l-alert"));

		// 3. Desktop notification was called
		assert.ok(notified.some(n => n.includes("notify-send") && n.includes("Pending model loan decision")));
	} finally {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
