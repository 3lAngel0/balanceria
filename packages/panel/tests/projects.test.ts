import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedGithub, githubUrl, listProjects, REMOTE_TTL_MS, sessionDetail } from "../src/projects.ts";

test("githubUrl normalizes GitHub remotes and rejects everything else", () => {
	assert.equal(githubUrl("git@github.com:3lAngel0/balanceria.git"), "https://github.com/3lAngel0/balanceria");
	assert.equal(githubUrl("https://github.com/3lAngel0/balanceria.git\n"), "https://github.com/3lAngel0/balanceria");
	assert.equal(githubUrl("https://github.com/owner/repo"), "https://github.com/owner/repo");
	assert.equal(githubUrl("ssh://git@github.com/owner/repo.git"), "https://github.com/owner/repo");
	assert.equal(githubUrl("https://user:secret@github.com/owner/repo.git"), "https://github.com/owner/repo", "credentials never reach the page");
	assert.equal(githubUrl("https://gitlab.com/owner/repo"), null);
	assert.equal(githubUrl("https://github.com/owner"), null);
	assert.equal(githubUrl('https://github.com/owner/repo"><script>'), null);
	assert.equal(githubUrl(""), null);
});

function session(root: string, dir: string, name: string, lines: unknown[], mtimeSec: number): void {
	mkdirSync(join(root, dir), { recursive: true });
	const file = join(root, dir, name);
	writeFileSync(file, lines.map(line => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
	utimesSync(file, mtimeSec, mtimeSec);
}

const header = (cwd: string) => ({ type: "session", version: 3, id: "x", timestamp: "2026-10-22T10:00:00.000Z", cwd });
const ask = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "panel-sessions-"));
	session(root, "--home-a-shop--", "2026-10-20T10-00-00-000Z_01aaa.jsonl", [header("/home/a/shop"), ask("old question")], 1_000);
	session(root, "--home-a-shop--", "2026-10-21T10-00-00-000Z_01bbb.jsonl", [header("/home/a/shop"), ask("fix the cart")], 3_000);
	session(root, "--home-a-blog--", "2026-10-21T09-00-00-000Z_01ccc.jsonl", [header("/home/a/blog")], 2_000);
	session(root, "--home-a-broken--", "2026-10-21T09-00-00-000Z_01ddd.jsonl", ["not json"], 500);
	mkdirSync(join(root, "--home-a-empty--"));
	writeFileSync(join(root, "stray.txt"), "not a project");
	return root;
}

test("listProjects lists one project per directory, newest activity first, and skips what it cannot read", () => {
	const root = fixture();
	try {
		const remotes: Record<string, string> = { "/home/a/shop": "git@github.com:a/shop.git" };
		const asked: string[] = [];
		const projects = listProjects(root, cwd => {
			asked.push(cwd);
			return githubUrl(remotes[cwd] ?? "");
		});
		assert.deepEqual(projects, [
			{ dir: "--home-a-shop--", cwd: "/home/a/shop", sessions: 2, lastActivity: 3_000_000, latest: { id: "01bbb", title: "fix the cart" }, github: "https://github.com/a/shop" },
			{ dir: "--home-a-blog--", cwd: "/home/a/blog", sessions: 1, lastActivity: 2_000_000, latest: { id: "01ccc", title: null }, github: null },
			{ dir: "--home-a-broken--", cwd: null, sessions: 1, lastActivity: 500_000, latest: { id: "01ddd", title: null }, github: null },
		]);
		assert.deepEqual(asked.sort(), ["/home/a/blog", "/home/a/shop"], "no git lookup without a cwd");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listProjects with no sessions root is an empty list", () => {
	assert.deepEqual(listProjects(join(tmpdir(), "panel-missing-root-xyz"), () => null), []);
});

test("sessionDetail returns cwd, title and the resume command, or undefined", () => {
	const root = fixture();
	try {
		assert.deepEqual(sessionDetail(root, "01bbb"), {
			id: "01bbb",
			cwd: "/home/a/shop",
			title: "fix the cart",
			file: join(root, "--home-a-shop--", "2026-10-21T10-00-00-000Z_01bbb.jsonl"),
			resume: `cd '/home/a/shop' && gentle-shell --session '${join(root, "--home-a-shop--", "2026-10-21T10-00-00-000Z_01bbb.jsonl")}'`,
		});
		assert.equal(sessionDetail(root, "01zzz"), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cachedGithub asks git once per cwd within 5 minutes, and again after", () => {
	let now = 0;
	const calls: string[] = [];
	const github = cachedGithub(cwd => {
		calls.push(cwd);
		return "git@github.com:a/shop.git";
	}, () => now);
	assert.equal(github("/home/a/shop"), "https://github.com/a/shop");
	now = REMOTE_TTL_MS - 1;
	assert.equal(github("/home/a/shop"), "https://github.com/a/shop");
	assert.deepEqual(calls, ["/home/a/shop"]);
	now = REMOTE_TTL_MS;
	github("/home/a/shop");
	assert.deepEqual(calls, ["/home/a/shop", "/home/a/shop"]);
});
