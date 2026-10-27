import { test } from "node:test";
import assert from "node:assert/strict";
import { formatServeStart, isValidSessionId, sshTunnelHint } from "../src/web-serve.ts";

test("isValidSessionId: accepts valid identifiers and rejects malformed ones", () => {
	assert.equal(isValidSessionId("01a1510a"), true);
	assert.equal(isValidSessionId("session-123"), true);
	assert.equal(isValidSessionId("abc.def_ghi-123"), true);
	assert.equal(isValidSessionId("a"), true);
	assert.equal(isValidSessionId("a".repeat(128)), true);

	assert.equal(isValidSessionId(""), false);
	assert.equal(isValidSessionId("   "), false);
	assert.equal(isValidSessionId("a b"), false);
	assert.equal(isValidSessionId("a/b"), false);
	assert.equal(isValidSessionId("../etc/passwd"), false);
	assert.equal(isValidSessionId("session$1"), false);
	assert.equal(isValidSessionId("a".repeat(129)), false);
});

test("sshTunnelHint formats port, user, and host correctly", () => {
	assert.equal(sshTunnelHint(8787, "dev", "my-desktop"), "ssh -L 8787:127.0.0.1:8787 dev@my-desktop");
	assert.equal(sshTunnelHint(9000, "root", "server01"), "ssh -L 9000:127.0.0.1:9000 root@server01");
});

test("formatServeStart formats URL and SSH tunnel hint", () => {
	const message = formatServeStart("http://127.0.0.1:8787/?token=secret123", 8787, "dev", "my-desktop");
	assert.equal(message, "ai-balancer: web report at http://127.0.0.1:8787/?token=secret123 (remote: ssh -L 8787:127.0.0.1:8787 dev@my-desktop)");
});
