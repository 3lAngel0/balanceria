import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPanelAlerts,
	collectAlerts,
	dispatchDesktopAlerts,
	type Alert,
	type AlertContext,
} from "../src/alerts.ts";

test("collectAlerts detects quota window near full when peak is >= 90%", () => {
	const context: AlertContext = {
		now: 1000,
		quotaSeries: [
			{ limit: "claude-bridge", window: "5h", peak: 0.92, fills: 1, daily: [0.92] },
			{ limit: "claude-bridge", window: "week", peak: 0.45, fills: 0, daily: [0.45] },
		],
		sessions: [],
		loans: [],
	};

	const alerts = collectAlerts(context);
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].source, "quota");
	assert.equal(alerts[0].level, "warning");
	assert.match(alerts[0].message, /92%/);
});

test("collectAlerts detects context over 120k", () => {
	const context: AlertContext = {
		now: 1000,
		quotaSeries: [],
		sessions: [
			{ id: "s-large", cwd: "/test", totalTokens: 135_000, lastActivity: 900 },
			{ id: "s-normal", cwd: "/test", totalTokens: 40_000, lastActivity: 950 },
		],
		loans: [],
	};

	const alerts = collectAlerts(context);
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].source, "context");
	assert.equal(alerts[0].level, "warning");
	assert.match(alerts[0].message, /135k/);
});

test("collectAlerts detects pending loan decisions", () => {
	const context: AlertContext = {
		now: 1000,
		quotaSeries: [],
		sessions: [],
		loans: [
			{ id: "loan-1", role: "worker", from: "pool/sonnet", to: "gemini", status: "proposed", profile: "default" },
			{ id: "loan-2", role: "worker", from: "pool/sonnet", to: "gemini", status: "closed", profile: "default" },
		],
	};

	const alerts = collectAlerts(context);
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].source, "loan");
	assert.equal(alerts[0].id, "loan-loan-1");
	assert.match(alerts[0].message, /proposed/);
});

test("collectAlerts detects stuck sessions active > 10m without activity", () => {
	const now = 1_000_000;
	const context: AlertContext = {
		now,
		quotaSeries: [],
		sessions: [
			{ id: "s-stuck", cwd: "/test", totalTokens: 10_000, lastActivity: now - 12 * 60 * 1000, isLive: true },
			{ id: "s-active", cwd: "/test", totalTokens: 10_000, lastActivity: now - 2 * 60 * 1000, isLive: true },
		],
		loans: [],
	};

	const alerts = collectAlerts(context);
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].source, "session");
	assert.equal(alerts[0].level, "warning");
	assert.match(alerts[0].message, /s-stuck/);
});

test("dispatchDesktopAlerts runs notify-send with urgency and dedupes within cooldown", async () => {
	const calls: { cmd: string; args: string[] }[] = [];
	const mockRunner = (cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		return Promise.resolve();
	};

	const seen = new Map<string, number>();
	const alert: Alert = {
		id: "alert-1",
		level: "warning",
		title: "Quota Full",
		message: "Window at 95%",
		source: "quota",
		timestamp: 1000,
	};

	// First call sends notification
	const sent1 = await dispatchDesktopAlerts([alert], {
		now: 1000,
		cooldownMs: 60_000,
		seen,
		runner: mockRunner,
	});
	assert.deepEqual(sent1, ["alert-1"]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cmd, "notify-send");
	assert.deepEqual(calls[0].args, ["-u", "normal", "-a", "ai-balancer", "Quota Full", "Window at 95%"]);

	// Immediate second call is deduped
	const sent2 = await dispatchDesktopAlerts([alert], {
		now: 10_000,
		cooldownMs: 60_000,
		seen,
		runner: mockRunner,
	});
	assert.deepEqual(sent2, []);
	assert.equal(calls.length, 1);

	// After cooldown, sends again
	const sent3 = await dispatchDesktopAlerts([alert], {
		now: 70_000,
		cooldownMs: 60_000,
		seen,
		runner: mockRunner,
	});
	assert.deepEqual(sent3, ["alert-1"]);
	assert.equal(calls.length, 2);
});

test("buildPanelAlerts reads data directory loans and quota series", () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-alerts-"));
	const loansFile = join(dir, "loans.json");
	const validLoan = {
		id: "l-1",
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
	writeFileSync(
		loansFile,
		JSON.stringify({
			version: 1,
			loans: [validLoan],
		}) + "\n",
	);

	try {
		const alerts = buildPanelAlerts({
			dataDir: dir,
			root: dir,
			projects: [],
			quotaSeries: [{ limit: "c1", window: "5h", peak: 0.94, fills: 1, daily: [0.94] }],
			now: 5000,
		});

		assert.equal(alerts.length, 2);
		assert.ok(alerts.some(a => a.source === "quota" && a.id.includes("c1")));
		assert.ok(alerts.some(a => a.source === "loan" && a.id === "loan-l-1"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
