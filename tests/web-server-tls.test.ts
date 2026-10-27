import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTlsFiles, probeReport, startWebServer, type TlsMaterial, type WebServer, type WebServerOptions } from "../src/web-server.ts";

const TOKEN = "t".repeat(43);

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "web-tls-"));
}

/** A throwaway self-signed certificate for 127.0.0.1; paths and PEM contents. */
function certificate(): { certFile: string; keyFile: string; material: TlsMaterial } {
	const dir = scratch();
	const certFile = join(dir, "cert.pem");
	const keyFile = join(dir, "key.pem");
	execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=test", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
	return { certFile, keyFile, material: { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") } };
}

const OWN = certificate();
const OTHER = certificate();

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
		tls: OWN.material,
		page: () => "<!DOCTYPE html><title>page</title>",
		script: () => "",
		style: () => "",
		getReport: () => {
			calls.report += 1;
			return { secret: "usage-data" };
		},
		getSession: () => undefined,
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

function send(port: number, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = httpsRequest(
			{ host: "127.0.0.1", port, path, method: options.method ?? "GET", ca: OWN.material.cert, headers: { host: `127.0.0.1:${port}`, ...options.headers } },
			res => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", chunk => (body += chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

test("with TLS the server speaks HTTPS only and every address it prints is https", async () => {
	const { server } = await start({ lan: true, lanAddresses: () => ["192.168.1.20"] });
	try {
		assert.equal(server.tls, true);
		assert.equal(server.url, `https://127.0.0.1:${server.port}/?token=${TOKEN}`);
		assert.deepEqual(server.lanUrls, [`https://192.168.1.20:${server.port}/?token=${TOKEN}`]);
		const reply = await send(server.port, "/api/report", { headers: { authorization: `Bearer ${TOKEN}` } });
		assert.equal(reply.status, 200);
		assert.equal(reply.body, JSON.stringify({ secret: "usage-data" }));
		const plain = await new Promise<string>(resolve => {
			const req = httpRequest({ host: "127.0.0.1", port: server.port, path: "/api/report", headers: { authorization: `Bearer ${TOKEN}` } }, res => {
				res.resume();
				resolve(`status ${res.statusCode}`);
			});
			req.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
			req.end();
		});
		assert.doesNotMatch(plain, /^status 200/, "plain HTTP must never get the report");
	} finally {
		await server.close();
	}
});

test("without TLS the server stays plain HTTP, as before", async () => {
	const { server } = await start({ tls: undefined });
	try {
		assert.equal(server.tls, false);
		assert.equal(server.url, `http://127.0.0.1:${server.port}/?token=${TOKEN}`);
	} finally {
		await server.close();
	}
});

test("over HTTPS the token cookie is Secure, HttpOnly and SameSite=Strict", async () => {
	const { server } = await start();
	try {
		const reply = await send(server.port, `/?token=${TOKEN}`);
		assert.equal(reply.status, 303);
		assert.equal(String(reply.headers["set-cookie"]), `balancer_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Secure`);
	} finally {
		await server.close();
	}
});

test("over HTTPS an open is accepted only from the https origin of the same address", async () => {
	const { server, calls } = await start();
	try {
		const post = (origin: string) => send(server.port, "/api/sessions/abc/open", { method: "POST", headers: { cookie: `balancer_token=${TOKEN}`, origin } });
		assert.equal((await post(`http://127.0.0.1:${server.port}`)).status, 403);
		assert.deepEqual(calls.opened, []);
		assert.equal((await post(`https://127.0.0.1:${server.port}`)).status, 200);
		assert.deepEqual(calls.opened, ["abc"]);
	} finally {
		await server.close();
	}
});

test("probeReport over HTTPS sends the token only to the pinned certificate", async () => {
	const { server, calls } = await start();
	try {
		const url = `https://127.0.0.1:${server.port}/?token=${TOKEN}`;
		assert.equal(await probeReport(url, 3000, OWN.material.cert), 200);
		assert.equal(calls.report, 1);
		assert.equal(await probeReport(url, 3000, OTHER.material.cert), "ECERTMISMATCH");
		assert.equal(await probeReport(url), "ECERTMISMATCH", "an https probe without a pinned certificate never sends the token");
		assert.equal(await probeReport(url, 3000, "not a pem certificate"), "ECERTMISMATCH");
		assert.equal(calls.report, 1, "a mismatched certificate never receives the token");
	} finally {
		await server.close();
	}
});

test("loadTlsFiles reads a matching pair and explains a missing file or a key of another certificate", () => {
	assert.deepEqual(loadTlsFiles({ cert: OWN.certFile, key: OWN.keyFile }), OWN.material);
	assert.throws(() => loadTlsFiles({ cert: OWN.certFile, key: OTHER.keyFile }), /ai-balancer: the TLS key .* does not match the certificate/);
	assert.throws(() => loadTlsFiles({ cert: join(scratch(), "missing.pem"), key: OWN.keyFile }), /ai-balancer: cannot read the TLS certificate .*missing\.pem/);
	const junk = join(scratch(), "junk.pem");
	writeFileSync(junk, "not a certificate");
	assert.throws(() => loadTlsFiles({ cert: junk, key: OWN.keyFile }), /ai-balancer: .*junk\.pem is not a PEM certificate/);
});
