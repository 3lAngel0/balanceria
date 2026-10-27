import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCertificate, inspectCertificate, mkcertArgs, selfSignedArgs } from "../src/tls-setup.ts";
import type { Runner } from "../src/lan-setup.ts";

const run: Runner = (command, args) =>
	new Promise((resolve, reject) => execFile(command, args, (error, stdout) => (error ? reject(error) : resolve({ stdout: String(stdout) }))));

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "tls-setup-"));
}

test("the self-signed certificate names every LAN address, loopback and localhost", () => {
	const args = selfSignedArgs("/d/cert.pem", "/d/key.pem", ["192.168.1.20", "10.0.0.5"]);
	assert.equal(args[0], "req");
	assert.ok(args.includes("-x509") && args.includes("-nodes"));
	assert.deepEqual(args.slice(args.indexOf("-keyout"), args.indexOf("-keyout") + 4), ["-keyout", "/d/key.pem", "-out", "/d/cert.pem"]);
	assert.ok(args.includes("subjectAltName=IP:192.168.1.20,IP:10.0.0.5,IP:127.0.0.1,DNS:localhost"));
	assert.equal(args[args.indexOf("-days") + 1], "825");
	assert.deepEqual(mkcertArgs("/d/cert.pem", "/d/key.pem", ["192.168.1.20"]), ["-cert-file", "/d/cert.pem", "-key-file", "/d/key.pem", "192.168.1.20", "127.0.0.1", "localhost"]);
});

test("a self-signed certificate is created with a 0600 key in a 0700 folder and passes inspection", async () => {
	const dir = join(scratch(), "tls");
	const { config, notes } = await createCertificate("self-signed", dir, ["192.168.1.20"], run);
	assert.deepEqual(config, { cert: join(dir, "self-signed", "cert.pem"), key: join(dir, "self-signed", "key.pem") });
	assert.equal(statSync(config.key).mode & 0o777, 0o600);
	assert.equal(statSync(join(dir, "self-signed")).mode & 0o777, 0o700);
	assert.deepEqual(notes, []);
	const result = inspectCertificate(config, "192.168.1.20");
	assert.equal(result.error, undefined);
	assert.deepEqual(result.warnings, []);
	assert.equal(result.fingerprint, new X509Certificate(readFileSync(config.cert)).fingerprint256);
});

test("a missing tool is explained with what to do instead", async () => {
	const missing: Runner = async () => {
		throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
	};
	await assert.rejects(createCertificate("self-signed", scratch(), ["192.168.1.20"], missing), /ai-balancer: openssl not found; install it or pick another option/);
	await assert.rejects(createCertificate("mkcert", scratch(), ["192.168.1.20"], missing), /ai-balancer: mkcert not found; install it \(https:\/\/github\.com\/FiloSottile\/mkcert\) or pick another option/);
});

test("mkcert runs with the LAN addresses and tells where its CA is, never installing it", async () => {
	const calls: string[][] = [];
	const fakeMkcert: Runner = async (command, args) => {
		calls.push([command, ...args]);
		if (args[0] === "-CAROOT") return { stdout: "/home/u/.local/share/mkcert\n" };
		writeFileSync(args[1]!, "cert");
		writeFileSync(args[3]!, "key");
		return { stdout: "" };
	};
	const dir = scratch();
	const { config, notes } = await createCertificate("mkcert", dir, ["192.168.1.20"], fakeMkcert);
	assert.deepEqual(calls, [
		["mkcert", "-cert-file", join(dir, "mkcert", "cert.pem"), "-key-file", join(dir, "mkcert", "key.pem"), "192.168.1.20", "127.0.0.1", "localhost"],
		["mkcert", "-CAROOT"],
	]);
	assert.ok(!calls.some(call => call.includes("-install")));
	assert.equal(statSync(config.key).mode & 0o777, 0o600);
	assert.deepEqual(notes, [
		"ai-balancer: install /home/u/.local/share/mkcert/rootCA.pem as a trusted CA on each device that opens the report (on this machine: mkcert -install). Never copy rootCA-key.pem.",
	]);
});

test("inspection refuses a bad pair and warns about an address the certificate does not name", async () => {
	const dir = scratch();
	const own = await createCertificate("self-signed", join(dir, "a"), ["192.168.1.20"], run);
	const other = await createCertificate("self-signed", join(dir, "b"), ["192.168.1.20"], run);
	assert.match(inspectCertificate({ cert: own.config.cert, key: other.config.key }, "192.168.1.20").error ?? "", /does not match the certificate/);
	assert.match(inspectCertificate({ cert: join(dir, "nope.pem"), key: own.config.key }, "192.168.1.20").error ?? "", /cannot read the TLS certificate/);
	assert.deepEqual(inspectCertificate(own.config, "10.9.9.9").warnings, ["the certificate does not name 10.9.9.9, so browsers reject it at that address"]);
	const expired = inspectCertificate(own.config, "192.168.1.20", Date.now() + 900 * 86_400_000);
	assert.match(expired.error ?? "", /^ai-balancer: the certificate expired on /);
	const soon = inspectCertificate(own.config, "192.168.1.20", Date.now() + 810 * 86_400_000);
	assert.match(soon.warnings.join(), /the certificate expires on .* \(in \d+ days\)/);
});
