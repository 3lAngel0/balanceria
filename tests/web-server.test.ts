import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrivateAddress, loadOrCreateToken, privateIPv4Addresses, probeReport, startWebServer, type WebServer, type WebServerOptions } from "../src/web-server.ts";

const TOKEN = "t".repeat(43);

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "web-server-"));
}

interface Calls {
	report: number;
	opened: string[];
}

async function start(overrides: Partial<WebServerOptions> = {}): Promise<{ server: WebServer; calls: Calls }> {
	const dir = scratch();
	const tokenFile = join(dir, "web-token");
	writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
	const calls: Calls = { report: 0, opened: [] };
	const server = await startWebServer({
		port: 0,
		tokenFile,
		page: () => "<!DOCTYPE html><title>page</title>",
		script: () => "console.log('app')",
		style: () => "body{}",
		getReport: () => {
			calls.report += 1;
			return { secret: "usage-data" };
		},
		getSession: id => (id === "known" ? { session: "known" } : undefined),
		openSession: async id => {
			calls.opened.push(id);
			return { ok: true, message: `opening ${id}` };
		},
		...overrides,
	});
	return { server, calls };
}

interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

function send(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...options.headers } }, res => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", chunk => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
		});
		req.on("error", reject);
		if (options.body) req.write(options.body);
		req.end();
	});
}

const cookie = { cookie: `balancer_token=${TOKEN}` };

test("binds to 127.0.0.1 only and reports the bound port", async () => {
	const { server } = await start();
	try {
		assert.equal(server.host, "127.0.0.1");
		assert.ok(server.port > 0);
		assert.equal(server.url, `http://127.0.0.1:${server.port}/?token=${TOKEN}`);
	} finally {
		await server.close();
	}
});

test("a request without the token gets 401 and no data", async () => {
	const { server, calls } = await start();
	try {
		for (const path of ["/", "/api/report", "/api/sessions/known", "/app.js"]) {
			const reply = await send(server.port, path);
			assert.equal(reply.status, 401, path);
			assert.doesNotMatch(reply.body, /usage-data|<title>page/);
		}
		assert.equal(calls.report, 0);
	} finally {
		await server.close();
	}
});

test("a wrong token, in the query, cookie or bearer header, gets 401", async () => {
	const { server, calls } = await start();
	try {
		const wrong = "x".repeat(43);
		assert.equal((await send(server.port, `/?token=${wrong}`)).status, 401);
		assert.equal((await send(server.port, "/api/report", { headers: { cookie: `balancer_token=${wrong}` } })).status, 401);
		assert.equal((await send(server.port, "/api/report", { headers: { authorization: `Bearer ${wrong}` } })).status, 401);
		assert.equal((await send(server.port, "/api/report", { headers: { cookie: "balancer_token=short" } })).status, 401);
		assert.equal(calls.report, 0);
	} finally {
		await server.close();
	}
});

test("the token in the URL becomes an HttpOnly SameSite=Strict cookie and is stripped from the address", async () => {
	const { server } = await start();
	try {
		const reply = await send(server.port, `/?token=${TOKEN}&view=sessions`);
		assert.equal(reply.status, 303);
		assert.equal(reply.headers.location, "/?view=sessions");
		const setCookie = String(reply.headers["set-cookie"]);
		assert.match(setCookie, new RegExp(`^balancer_token=${TOKEN};`));
		assert.match(setCookie, /HttpOnly/);
		assert.match(setCookie, /SameSite=Strict/);
		assert.match(setCookie, /Path=\//);
	} finally {
		await server.close();
	}
});

test("with the cookie or bearer token the page, assets and report are served with locked-down headers", async () => {
	const { server, calls } = await start();
	try {
		const page = await send(server.port, "/", { headers: cookie });
		assert.equal(page.status, 200);
		assert.match(String(page.headers["content-type"]), /^text\/html/);
		assert.match(page.body, /<title>page/);
		const csp = String(page.headers["content-security-policy"]);
		assert.match(csp, /default-src 'none'/);
		assert.match(csp, /script-src 'self'/);
		assert.match(csp, /frame-ancestors 'none'/);
		assert.equal(page.headers["cache-control"], "no-store");
		assert.equal(page.headers["x-content-type-options"], "nosniff");
		assert.equal(page.headers["referrer-policy"], "no-referrer");

		assert.match(String((await send(server.port, "/app.js", { headers: cookie })).headers["content-type"]), /^text\/javascript/);
		assert.match(String((await send(server.port, "/app.css", { headers: cookie })).headers["content-type"]), /^text\/css/);

		const report = await send(server.port, "/api/report", { headers: { authorization: `Bearer ${TOKEN}` } });
		assert.equal(report.status, 200);
		assert.deepEqual(JSON.parse(report.body), { secret: "usage-data" });
		assert.equal(calls.report, 1);
	} finally {
		await server.close();
	}
});

test("a Host header that is not loopback is refused even with the token (DNS rebinding)", async () => {
	const { server, calls } = await start();
	try {
		const reply = await send(server.port, "/api/report", { headers: { ...cookie, host: "evil.example:8787" } });
		assert.equal(reply.status, 403);
		assert.doesNotMatch(reply.body, /usage-data/);
		assert.equal(calls.report, 0);
		// A tunnel may forward a different local port: any loopback name and port is fine.
		assert.equal((await send(server.port, "/api/report", { headers: { ...cookie, host: "localhost:9000" } })).status, 200);
	} finally {
		await server.close();
	}
});

test("session detail answers known sessions, 404 for unknown and 400 for malformed ids", async () => {
	const { server } = await start();
	try {
		const known = await send(server.port, "/api/sessions/known", { headers: cookie });
		assert.equal(known.status, 200);
		assert.deepEqual(JSON.parse(known.body), { session: "known" });
		assert.equal((await send(server.port, "/api/sessions/unknown", { headers: cookie })).status, 404);
		assert.equal((await send(server.port, "/api/sessions/..%2Fetc", { headers: cookie })).status, 400);
	} finally {
		await server.close();
	}
});

test("opening a session needs POST from the same origin and a valid id", async () => {
	const { server, calls } = await start();
	try {
		const path = "/api/sessions/known/open";
		const origin = `http://127.0.0.1:${server.port}`;
		assert.equal((await send(server.port, path, { headers: cookie })).status, 405);
		assert.equal((await send(server.port, path, { method: "POST", headers: { ...cookie, origin: "https://evil.example" } })).status, 403);
		assert.equal((await send(server.port, path, { method: "POST", headers: { origin } })).status, 401);
		assert.equal((await send(server.port, "/api/sessions/bad%20id/open", { method: "POST", headers: { ...cookie, origin } })).status, 400);
		assert.deepEqual(calls.opened, []);

		const reply = await send(server.port, path, { method: "POST", headers: { ...cookie, origin } });
		assert.equal(reply.status, 200);
		assert.deepEqual(JSON.parse(reply.body), { ok: true, message: "opening known" });
		assert.deepEqual(calls.opened, ["known"]);
	} finally {
		await server.close();
	}
});

test("an open the extension refuses answers 409 with its message", async () => {
	const { server } = await start({ openSession: async () => ({ ok: false, message: "no session file" }) });
	try {
		const reply = await send(server.port, "/api/sessions/known/open", { method: "POST", headers: { ...cookie, origin: `http://localhost:${server.port}` } });
		assert.equal(reply.status, 409);
		assert.deepEqual(JSON.parse(reply.body), { ok: false, message: "no session file" });
	} finally {
		await server.close();
	}
});

test("unknown paths are 404 once authenticated", async () => {
	const { server } = await start();
	try {
		assert.equal((await send(server.port, "/etc/passwd", { headers: cookie })).status, 404);
	} finally {
		await server.close();
	}
});

test("a port already in use rejects with a message naming the port", async () => {
	const blocker = createServer();
	await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
	const port = (blocker.address() as { port: number }).port;
	try {
		await assert.rejects(start({ port }), new RegExp(`port ${port} is already in use`));
	} finally {
		blocker.close();
	}
});

test("the token file is created with mode 0600, reused, and tightened when too open", () => {
	const dir = scratch();
	const file = join(dir, "nested", "web-token");
	const first = loadOrCreateToken(file);
	assert.match(first, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(readFileSync(file, "utf8"), first);
	assert.equal(loadOrCreateToken(file), first);

	chmodSync(file, 0o644);
	assert.equal(loadOrCreateToken(file), first);
	assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a token file that is empty or too short is replaced by a fresh token", () => {
	const dir = scratch();
	const file = join(dir, "web-token");
	writeFileSync(file, "abc", { mode: 0o600 });
	const token = loadOrCreateToken(file);
	assert.match(token, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(readFileSync(file, "utf8"), token);
});

test("private addresses: loopback, RFC 1918, link-local and IPv6 ULA pass; public ones do not", () => {
	for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.20", "::ffff:192.168.1.20", "169.254.10.1", "fe80::1", "fd12:3456::1", "fc00::1"]) {
		assert.equal(isPrivateAddress(ip), true, ip);
	}
	for (const ip of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "11.0.0.1", "::ffff:8.8.8.8", "2001:4860::8888", "fe8::1", "fc::1", "fec0::1", "", undefined, "evil.example", "192.168.1"]) {
		assert.equal(isPrivateAddress(ip), false, String(ip));
	}
});

test("privateIPv4Addresses lists the machine's private IPv4 addresses only", () => {
	const ifaces = {
		lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
		eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
		wan0: [{ address: "8.8.8.8", family: "IPv4", internal: false }],
	};
	assert.deepEqual(privateIPv4Addresses(ifaces as never), ["192.168.1.20"]);
});

test("LAN mode binds every interface and gives a LAN URL per private address", async () => {
	const { server } = await start({ lan: true, lanAddresses: () => ["192.168.1.20"] });
	try {
		assert.equal(server.host, "0.0.0.0");
		assert.equal(server.lan, true);
		assert.equal(server.url, `http://127.0.0.1:${server.port}/?token=${TOKEN}`);
		assert.deepEqual(server.lanUrls, [`http://192.168.1.20:${server.port}/?token=${TOKEN}`]);
	} finally {
		await server.close();
	}
});

test("loopback mode stays on 127.0.0.1 with no LAN URLs", async () => {
	const { server } = await start();
	try {
		assert.equal(server.lan, false);
		assert.deepEqual(server.lanUrls, []);
	} finally {
		await server.close();
	}
});

test("LAN mode answers a private IP Host but still refuses domain names (DNS rebinding)", async () => {
	const { server, calls } = await start({ lan: true, lanAddresses: () => [] });
	try {
		assert.equal((await send(server.port, "/api/report", { headers: { ...cookie, host: `192.168.1.20:${server.port}` } })).status, 200);
		assert.equal((await send(server.port, "/api/report", { headers: { ...cookie, host: "localhost:9000" } })).status, 200);
		for (const host of ["evil.example:8787", "8.8.8.8:8787", "my-desktop.local:8787"]) {
			const reply = await send(server.port, "/api/report", { headers: { ...cookie, host } });
			assert.equal(reply.status, 403, host);
			assert.doesNotMatch(reply.body, /usage-data/);
		}
		assert.equal(calls.report, 2);
		// Without the token a LAN host gets nothing either.
		assert.equal((await send(server.port, "/api/report", { headers: { host: `192.168.1.20:${server.port}` } })).status, 401);
	} finally {
		await server.close();
	}
});

test("loopback mode keeps refusing a private IP Host", async () => {
	const { server, calls } = await start();
	try {
		assert.equal((await send(server.port, "/api/report", { headers: { ...cookie, host: `192.168.1.20:${server.port}` } })).status, 403);
		assert.equal(calls.report, 0);
	} finally {
		await server.close();
	}
});

test("LAN mode opens a session only from the same private origin it was asked on", async () => {
	const { server, calls } = await start({ lan: true, lanAddresses: () => [] });
	try {
		const path = "/api/sessions/known/open";
		const host = `192.168.1.20:${server.port}`;
		assert.equal((await send(server.port, path, { method: "POST", headers: { ...cookie, host, origin: `http://192.168.1.99:${server.port}` } })).status, 403);
		assert.equal((await send(server.port, path, { method: "POST", headers: { ...cookie, host, origin: "http://evil.example" } })).status, 403);
		assert.deepEqual(calls.opened, []);
		assert.equal((await send(server.port, path, { method: "POST", headers: { ...cookie, host, origin: `http://${host}` } })).status, 200);
		assert.deepEqual(calls.opened, ["known"]);
	} finally {
		await server.close();
	}
});

function layoutStore(): { saved: unknown[]; layout: NonNullable<WebServerOptions["layout"]> } {
	const saved: unknown[] = [];
	return {
		saved,
		layout: {
			get: () => ({ mode: "simple" }),
			save: value => {
				if ((value as { mode?: unknown }).mode !== "advanced") return { ok: false, message: "mode must be simple or advanced" };
				saved.push(value);
				return { ok: true, layout: value };
			},
		},
	};
}

const json = { "content-type": "application/json" };

test("with a layout store, GET /api/layout answers it and a same-origin JSON POST saves it", async () => {
	const store = layoutStore();
	const { server } = await start({ layout: store.layout });
	try {
		const origin = { origin: `http://127.0.0.1:${server.port}` };
		assert.equal((await send(server.port, "/api/layout")).status, 401);
		const got = await send(server.port, "/api/layout", { headers: cookie });
		assert.equal(got.status, 200);
		assert.deepEqual(JSON.parse(got.body), { layout: { mode: "simple" } });
		const saved = await send(server.port, "/api/layout", { method: "POST", headers: { ...cookie, ...origin, ...json }, body: '{"mode":"advanced"}' });
		assert.equal(saved.status, 200);
		assert.deepEqual(JSON.parse(saved.body), { ok: true, layout: { mode: "advanced" } });
		const refused = await send(server.port, "/api/layout", { method: "POST", headers: { ...cookie, ...origin, ...json }, body: '{"mode":"x"}' });
		assert.equal(refused.status, 400);
		assert.deepEqual(JSON.parse(refused.body), { ok: false, message: "mode must be simple or advanced" });
		assert.deepEqual(store.saved, [{ mode: "advanced" }]);
	} finally {
		await server.close();
	}
});

test("a layout POST that is cross-origin, not JSON, malformed or over 64 KiB writes nothing", async () => {
	const store = layoutStore();
	const { server } = await start({ layout: store.layout });
	try {
		const origin = { origin: `http://127.0.0.1:${server.port}` };
		const post = (headers: Record<string, string>, body: string) => send(server.port, "/api/layout", { method: "POST", headers: { ...cookie, ...headers }, body });
		const cross = await post({ origin: "http://evil.example", ...json }, '{"mode":"advanced"}');
		assert.deepEqual([cross.status, cross.body], [403, "ai-balancer: cross-origin request refused.\n"]);
		const plain = await post({ ...origin, "content-type": "text/plain" }, '{"mode":"advanced"}');
		assert.deepEqual([plain.status, JSON.parse(plain.body)], [415, { ok: false, message: "send the layout as application/json" }]);
		const bad = await post({ ...origin, ...json }, "{nope");
		assert.deepEqual([bad.status, JSON.parse(bad.body)], [400, { ok: false, message: "the layout is not valid JSON" }]);
		const big = await post({ ...origin, ...json }, JSON.stringify({ mode: "advanced", pad: "x".repeat(65 * 1024) }));
		assert.deepEqual([big.status, JSON.parse(big.body)], [413, { ok: false, message: "the layout is larger than 64 KiB" }]);
		assert.deepEqual(store.saved, []);
	} finally {
		await server.close();
	}
});

test("without a layout store (/balancer serve) /api/layout stays unknown: GET 404, POST 405", async () => {
	const { server } = await start();
	try {
		const got = await send(server.port, "/api/layout", { headers: cookie });
		assert.deepEqual([got.status, got.body], [404, "ai-balancer: not found.\n"]);
		const posted = await send(server.port, "/api/layout", { method: "POST", headers: { ...cookie, origin: `http://127.0.0.1:${server.port}`, ...json }, body: "{}" });
		assert.deepEqual([posted.status, posted.body], [405, "ai-balancer: use GET.\n"]);
	} finally {
		await server.close();
	}
});

function labStore(): { saved: unknown[]; lab: NonNullable<WebServerOptions["lab"]> } {
	const saved: unknown[] = [];
	return {
		saved,
		lab: {
			get: () => ({ draft: null }),
			save: value => {
				saved.push(value);
				return { status: 409, body: { ok: false, message: "start a draft with /balancer lab new in Pi" } };
			},
		},
	};
}

test("with a lab store, GET /api/lab answers it and a same-origin JSON POST /api/lab/pools passes the store's status through", async () => {
	const store = labStore();
	const { server } = await start({ lab: store.lab });
	try {
		const origin = { origin: `http://127.0.0.1:${server.port}` };
		assert.equal((await send(server.port, "/api/lab")).status, 401);
		const got = await send(server.port, "/api/lab", { headers: cookie });
		assert.deepEqual([got.status, JSON.parse(got.body)], [200, { draft: null }]);
		const posted = await send(server.port, "/api/lab/pools", { method: "POST", headers: { ...cookie, ...origin, ...json }, body: '{"version":"v","pools":{}}' });
		assert.deepEqual([posted.status, JSON.parse(posted.body)], [409, { ok: false, message: "start a draft with /balancer lab new in Pi" }]);
		assert.deepEqual(store.saved, [{ version: "v", pools: {} }]);
	} finally {
		await server.close();
	}
});

test("a lab POST that is cross-origin, not JSON, malformed or over 64 KiB reaches no store", async () => {
	const store = labStore();
	const { server } = await start({ lab: store.lab });
	try {
		const origin = { origin: `http://127.0.0.1:${server.port}` };
		const post = (headers: Record<string, string>, body: string) => send(server.port, "/api/lab/pools", { method: "POST", headers: { ...cookie, ...headers }, body });
		const cross = await post({ origin: "http://evil.example", ...json }, "{}");
		assert.deepEqual([cross.status, cross.body], [403, "ai-balancer: cross-origin request refused.\n"]);
		const plain = await post({ ...origin, "content-type": "text/plain" }, "{}");
		assert.deepEqual([plain.status, JSON.parse(plain.body)], [415, { ok: false, message: "send the pools as application/json" }]);
		const bad = await post({ ...origin, ...json }, "{nope");
		assert.deepEqual([bad.status, JSON.parse(bad.body)], [400, { ok: false, message: "the pools are not valid JSON" }]);
		const big = await post({ ...origin, ...json }, JSON.stringify({ pad: "x".repeat(65 * 1024) }));
		assert.deepEqual([big.status, JSON.parse(big.body)], [413, { ok: false, message: "the pools are larger than 64 KiB" }]);
		assert.deepEqual(store.saved, []);
	} finally {
		await server.close();
	}
});

test("without a lab store (/balancer serve) the lab paths stay unknown: GET 404, POST 405", async () => {
	const { server } = await start();
	try {
		const got = await send(server.port, "/api/lab", { headers: cookie });
		assert.deepEqual([got.status, got.body], [404, "ai-balancer: not found.\n"]);
		const posted = await send(server.port, "/api/lab/pools", { method: "POST", headers: { ...cookie, origin: `http://127.0.0.1:${server.port}`, ...json }, body: "{}" });
		assert.deepEqual([posted.status, posted.body], [405, "ai-balancer: use GET.\n"]);
	} finally {
		await server.close();
	}
});

test("probeReport returns the status with the token, 401 without it, and the error code when nothing listens", async () => {
	const { server } = await start();
	try {
		assert.equal(await probeReport(`http://127.0.0.1:${server.port}/?token=${TOKEN}`), 200);
		assert.equal(await probeReport(`http://127.0.0.1:${server.port}/?token=wrong`), 401);
	} finally {
		await server.close();
	}
	assert.equal(await probeReport(`http://127.0.0.1:${server.port}/?token=${TOKEN}`), "ECONNREFUSED");
});

test("session actions (compact, cancel, delete) and trash (list, restore) route behind the token and reject LAN HTTP", async () => {
	let compacted = "";
	let cancelled = "";
	let deleted = "";
	let restored = "";
	const { server } = await start({
		lan: true,
		sessionActions: {
			compact: async id => {
				compacted = id;
				return { ok: true, message: "compacted" };
			},
			cancel: async id => {
				cancelled = id;
				return { ok: true, message: "cancelled" };
			},
			delete: async id => {
				deleted = id;
				return { ok: true };
			},
		},
		trash: {
			list: () => [{ id: "trashed-1" }],
			restore: rel => {
				restored = rel;
				return { ok: true };
			},
		},
	});

	try {
		const origin = `http://127.0.0.1:${server.port}`;
		// Loopback HTTP: allowed
		const comp = await send(server.port, "/api/sessions/s1/compact", { method: "POST", headers: { ...cookie, origin } });
		assert.equal(comp.status, 200);
		assert.equal(compacted, "s1");

		const canc = await send(server.port, "/api/sessions/s1/cancel", { method: "POST", headers: { ...cookie, origin } });
		assert.equal(canc.status, 200);
		assert.equal(cancelled, "s1");

		const del = await send(server.port, "/api/sessions/s1/delete", { method: "POST", headers: { ...cookie, origin } });
		assert.equal(del.status, 200);
		assert.equal(deleted, "s1");

		const list = await send(server.port, "/api/trash", { headers: cookie });
		assert.equal(list.status, 200);
		assert.deepEqual(JSON.parse(list.body), { trash: [{ id: "trashed-1" }] });

		const rest = await send(server.port, "/api/trash/restore", { method: "POST", headers: { ...cookie, origin, ...json }, body: JSON.stringify({ relativePath: "date/proj/s1.jsonl" }) });
		assert.equal(rest.status, 200);
		assert.equal(restored, "date/proj/s1.jsonl");

		// Over LAN HTTP (Host: 192.168.1.50): refused with 403
		const lanHeaders = { ...cookie, host: `192.168.1.50:${server.port}`, origin: `http://192.168.1.50:${server.port}` };
		const lanComp = await send(server.port, "/api/sessions/s1/compact", { method: "POST", headers: lanHeaders });
		assert.equal(lanComp.status, 403);
		assert.deepEqual(JSON.parse(lanComp.body), { ok: false, message: "actions are permitted only over loopback or HTTPS" });

		const lanTrash = await send(server.port, "/api/trash", { headers: lanHeaders });
		assert.equal(lanTrash.status, 403);
	} finally {
		await server.close();
	}
});

test("web server serves profiles and guards save against cross-origin and unencrypted LAN HTTP", async () => {
	const cookie = { cookie: `balancer_token=${TOKEN}` };
	const json = { "content-type": "application/json" };
	let savedData: unknown;
	const { server } = await start({
		lan: true,
		profiles: {
			get: () => ({ status: 200, body: { ok: true, active: "default" } }),
			save: value => {
				savedData = value;
				return { status: 200, body: { ok: true } };
			},
		},
	});

	try {
		const origin = `http://127.0.0.1:${server.port}`;
		// GET /api/profiles
		const getRes = await send(server.port, "/api/profiles", { headers: cookie });
		assert.equal(getRes.status, 200);
		assert.deepEqual(JSON.parse(getRes.body), { ok: true, active: "default" });

		// POST /api/profiles over loopback: allowed
		const saveRes = await send(server.port, "/api/profiles", {
			method: "POST",
			headers: { ...cookie, origin, ...json },
			body: JSON.stringify({ profiles: { active: "default" }, raw: "{}" }),
		});
		assert.equal(saveRes.status, 200);
		assert.deepEqual(savedData, { profiles: { active: "default" }, raw: "{}" });

		// POST /api/profiles cross-origin: 403
		const crossRes = await send(server.port, "/api/profiles", {
			method: "POST",
			headers: { ...cookie, origin: "http://evil.example", ...json },
			body: JSON.stringify({}),
		});
		assert.equal(crossRes.status, 403);

		// POST /api/profiles over unencrypted LAN HTTP: 403
		const lanHeaders = { ...cookie, host: `192.168.1.50:${server.port}`, origin: `http://192.168.1.50:${server.port}`, ...json };
		const lanPost = await send(server.port, "/api/profiles", { method: "POST", headers: lanHeaders, body: JSON.stringify({}) });
		assert.equal(lanPost.status, 403);
		assert.deepEqual(JSON.parse(lanPost.body), { ok: false, message: "actions are permitted only over loopback or HTTPS" });
	} finally {
		await server.close();
	}
});

test("web server serves alerts via GET /api/alerts", async () => {
	const cookie = { cookie: `balancer_token=${TOKEN}` };
	const { server } = await start({
		getAlerts: () => [{ id: "test-alert", title: "Test Alert" }],
	});

	try {
		const res = await send(server.port, "/api/alerts", { headers: cookie });
		assert.equal(res.status, 200);
		assert.deepEqual(JSON.parse(res.body), { alerts: [{ id: "test-alert", title: "Test Alert" }] });
	} finally {
		await server.close();
	}
});
