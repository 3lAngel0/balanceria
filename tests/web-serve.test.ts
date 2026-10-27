import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindWebHandlers, formatServeStart, parseServeArgs, runningWebServer, startServing, stopServing, type WebHandlers } from "../src/web-serve.ts";

const tokenFile = () => join(mkdtempSync(join(tmpdir(), "web-serve-")), "web-token");

function handlers(name: string): WebHandlers {
	return {
		getReport: () => ({ from: name }),
		getSession: () => undefined,
		openSession: async id => ({ ok: true, message: `${name} opens ${id}` }),
	};
}

function get(port: number, path: string, token: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, headers: { authorization: `Bearer ${token}` } }, res => {
			let body = "";
			res.on("data", chunk => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

afterEach(async () => {
	await stopServing();
});

test("serving starts once per process; a second start returns the running server", async () => {
	const file = tokenFile();
	const first = await startServing({ port: 0, tokenFile: file, handlers: handlers("a") });
	assert.equal(first.started, true);
	const again = await startServing({ port: first.server.port, tokenFile: file, handlers: handlers("a") });
	assert.equal(again.started, false);
	assert.equal(again.server, first.server);
	assert.equal(runningWebServer(), first.server);
});

test("asking for another port while serving is refused with how to change it", async () => {
	const { server } = await startServing({ port: 0, tokenFile: tokenFile(), handlers: handlers("a") });
	const other = server.port === 65000 ? 65001 : 65000;
	await assert.rejects(startServing({ port: other, tokenFile: tokenFile(), handlers: handlers("a") }), new RegExp(`already serving on port ${server.port}; run /balancer serve stop first`));
});

test("after a session switch the new extension instance's handlers answer, on the same server", async () => {
	const { server } = await startServing({ port: 0, tokenFile: tokenFile(), handlers: handlers("old") });
	const token = tokenOf(server.url);
	assert.deepEqual(JSON.parse((await get(server.port, "/api/report", token)).body), { from: "old" });
	bindWebHandlers(handlers("new"));
	assert.deepEqual(JSON.parse((await get(server.port, "/api/report", token)).body), { from: "new" });
	assert.equal(runningWebServer(), server);
});

test("binding handlers with nothing served does nothing", async () => {
	bindWebHandlers(handlers("x"));
	assert.equal(runningWebServer(), undefined);
});

test("stopping closes the port and reports whether something was running", async () => {
	const { server } = await startServing({ port: 0, tokenFile: tokenFile(), handlers: handlers("a") });
	assert.equal(await stopServing(), true);
	assert.equal(runningWebServer(), undefined);
	await assert.rejects(get(server.port, "/api/report", "x"), /ECONNREFUSED/);
	assert.equal(await stopServing(), false);
});

test("serve arguments: start with the default or a given port, stop, status, and bad ports", () => {
	assert.deepEqual(parseServeArgs(""), { action: "start", port: 8787 });
	assert.deepEqual(parseServeArgs("9123"), { action: "start", port: 9123 });
	assert.deepEqual(parseServeArgs("stop"), { action: "stop" });
	assert.deepEqual(parseServeArgs("status"), { action: "status" });
	assert.deepEqual(parseServeArgs("setup"), { action: "setup" });
	assert.deepEqual(parseServeArgs("autostart off"), { action: "autostart-off" });
	for (const bad of ["0", "65536", "80a", "-1", "stop now", "1.5", "lan 0", "lan lan", "lan stop", "autostart", "autostart on", "setup now"]) {
		assert.deepEqual(parseServeArgs(bad), { action: "error", message: "ai-balancer: usage: /balancer serve [lan] [port] | setup | stop | status | autostart off, port 1-65535" }, bad);
	}
});

test("serve lan arguments: LAN on the default or a given port", () => {
	assert.deepEqual(parseServeArgs("lan"), { action: "start", port: 8787, lan: true });
	assert.deepEqual(parseServeArgs("lan 9000"), { action: "start", port: 9000, lan: true });
	assert.deepEqual(parseServeArgs("  lan   9000 "), { action: "start", port: 9000, lan: true });
});

test("switching between loopback and LAN while serving is refused with how to change it", async () => {
	await startServing({ port: 0, tokenFile: tokenFile(), handlers: handlers("a") });
	await assert.rejects(startServing({ port: 0, lan: true, tokenFile: tokenFile(), handlers: handlers("a") }), /already serving on localhost only; run \/balancer serve stop first/);
	await stopServing();
	await startServing({ port: 0, lan: true, tokenFile: tokenFile(), handlers: handlers("a") });
	await assert.rejects(startServing({ port: 0, tokenFile: tokenFile(), handlers: handlers("a") }), /already serving on the LAN; run \/balancer serve stop first/);
});

test("formatServeStart in LAN mode lists the LAN addresses instead of the SSH tunnel", () => {
	const message = formatServeStart("http://127.0.0.1:8787/?token=s", 8787, "dev", "my-desktop", ["http://192.168.1.20:8787/?token=s"]);
	assert.equal(message, "ai-balancer: web report at http://127.0.0.1:8787/?token=s (LAN: http://192.168.1.20:8787/?token=s)");
	const none = formatServeStart("http://127.0.0.1:8787/?token=s", 8787, "dev", "my-desktop", []);
	assert.equal(none, "ai-balancer: web report at http://127.0.0.1:8787/?token=s (LAN: no private IPv4 address found on this machine)");
});

test("switching between plain HTTP and HTTPS while serving is refused with how to change it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "web-serve-tls-"));
	execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=t", "-keyout", join(dir, "k"), "-out", join(dir, "c")], { stdio: "ignore" });
	const tls = { cert: readFileSync(join(dir, "c"), "utf8"), key: readFileSync(join(dir, "k"), "utf8") };
	await startServing({ port: 0, lan: true, tokenFile: tokenFile(), handlers: handlers("a") });
	await assert.rejects(startServing({ port: 0, lan: true, tls, tokenFile: tokenFile(), handlers: handlers("a") }), /already serving over plain HTTP; run \/balancer serve stop first/);
	await stopServing();
	const { server } = await startServing({ port: 0, lan: true, tls, tokenFile: tokenFile(), handlers: handlers("a") });
	assert.equal(server.tls, true);
	await assert.rejects(startServing({ port: 0, lan: true, tokenFile: tokenFile(), handlers: handlers("a") }), /already serving over HTTPS; run \/balancer serve stop first/);
});
