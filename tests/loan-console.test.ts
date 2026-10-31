import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chooseLoanAction,
	formatKeepLoanConfirm,
	formatLoanSummary,
	keepLoanInProfile,
	loanNotices,
	loanWidget,
	reviewEndedLoan,
	type LoanUI,
} from "../src/loan-console.ts";
import type { Loan, LoanSummary } from "../src/loans.ts";
import { PROFILES_KIND, PROFILES_VERSION, type ProfilesRead, type ProfilesStore } from "../src/profiles.ts";
import { GRANT_RISKS } from "../src/permissions.ts";

const makeLoan = (overrides: Partial<Loan> = {}): Loan => ({
	id: "loan-202610221700-worker",
	status: "proposed",
	profile: "default",
	role: "worker",
	pool: "claude-sonnet-5-5",
	from: "pool/claude-sonnet-5-5",
	to: "antigravity/gemini-3-8-flash",
	alternatives: ["openai/gpt-4o"],
	level: "suggest",
	grantId: "g-test-1",
	why: "claude-sonnet-5-5: claude-sonnet-5-5 is spent; it reopens at 2026-10-22T18:00:00.000Z",
	advice: { action: "switch", why: "small context: switch is cheap" },
	proposedAt: 1000,
	endsAt: 2000,
	...overrides,
});

test("loanNotices notifies once per status and ignores closed loans", () => {
	const seen = new Set<string>();
	const loan = makeLoan();
	const now = 1000;

	// Proposed (suggest)
	const notices1 = loanNotices([loan], seen, now);
	assert.equal(notices1.length, 1);
	assert.ok(notices1[0].startsWith("ai-balancer: loan proposed (temporary fallback to another model) — "));
	assert.ok(notices1[0].includes("suggest: waits for you"));
	assert.ok(notices1[0].endsWith(". Run /balancer loans to review or keep it."));
	assert.ok(seen.has(`${loan.id}:proposed`));

	// Proposed (auto)
	const autoLoan = makeLoan({ id: "loan-auto", level: "auto" });
	const noticesAuto = loanNotices([autoLoan], seen, now);
	assert.equal(noticesAuto.length, 1);
	assert.ok(noticesAuto[0].includes("auto: applies at the next launch or in"));

	// Second pass: already seen
	const notices2 = loanNotices([loan, autoLoan], seen, now);
	assert.equal(notices2.length, 0);

	// Status transition to active
	const activeLoan: Loan = { ...loan, status: "active", decidedBy: "user", decidedAt: 1500 };
	const noticesActive = loanNotices([activeLoan], seen, now);
	assert.equal(noticesActive.length, 1);
	assert.ok(noticesActive[0].startsWith("ai-balancer: loan active (temporary fallback to another model) — "));
	assert.ok(noticesActive[0].endsWith(". Run /balancer loans to review or keep it."));
	assert.ok(seen.has(`${loan.id}:active`));

	// Status transition to ended
	const endedLoan: Loan = { ...loan, status: "ended", endedAt: 2000 };
	const noticesEnded = loanNotices([endedLoan], seen, now);
	assert.equal(noticesEnded.length, 1);
	assert.ok(noticesEnded[0].startsWith("ai-balancer: loan ended (temporary fallback to another model) — "));
	assert.ok(noticesEnded[0].endsWith(". Run /balancer loans to review or keep it."));
	assert.ok(seen.has(`${loan.id}:ended`));

	// Closed statuses produce no notice
	for (const status of ["declined", "kept", "reverted"] as const) {
		const closedLoan: Loan = { ...loan, id: `loan-${status}`, status };
		const noticesClosed = loanNotices([closedLoan], seen, now);
		assert.equal(noticesClosed.length, 0);
	}
});

test("loanWidget returns widget lines for open/ended loans and undefined when none", () => {
	const now = 1000;
	// No loans
	assert.equal(loanWidget([], now), undefined);
	// Only closed loans
	assert.equal(loanWidget([makeLoan({ status: "declined" }), makeLoan({ status: "kept" }), makeLoan({ status: "reverted" })], now), undefined);

	// Proposed
	const proposed = makeLoan({ status: "proposed" });
	const lines1 = loanWidget([proposed], now);
	assert.ok(Array.isArray(lines1));
	assert.equal(lines1?.length, 1);
	assert.ok(lines1[0].startsWith("loan proposed: "));
	assert.ok(lines1[0].endsWith(" · /balancer loans"));

	// Active
	const active = makeLoan({ status: "active" });
	const lines2 = loanWidget([active], now);
	assert.ok(Array.isArray(lines2));
	assert.ok(lines2[0].startsWith("loan active: "));

	// Ended (waiting for review)
	const ended = makeLoan({ status: "ended" });
	const lines3 = loanWidget([ended], now);
	assert.ok(Array.isArray(lines3));
	assert.ok(lines3[0].startsWith("loan ended (waiting for review): "));
});

test("chooseLoanAction notifies when there are no loans and returns undefined", async () => {
	let notified = "";
	const ui: LoanUI = {
		select: async () => undefined,
		confirm: async () => false,
		notify: msg => {
			notified = msg;
		},
	};

	const res = await chooseLoanAction(ui, [], 1000);
	assert.equal(res, undefined);
	assert.equal(
		notified,
		"ai-balancer: no loans. A loan is a temporary fallback to another model when a role's preferred model has no quota left. One is proposed once a grant (your permission to use another model for that role) covers the role: /balancer permissions grant.",
	);

	// Also with only closed loans
	const resClosed = await chooseLoanAction(ui, [makeLoan({ status: "declined" })], 1000);
	assert.equal(resClosed, undefined);
});

test("chooseLoanAction handles cancelled loan selection", async () => {
	const ui: LoanUI = {
		select: async () => undefined,
		confirm: async () => false,
		notify: () => {},
	};
	const res = await chooseLoanAction(ui, [makeLoan()], 1000);
	assert.equal(res, undefined);
});

test("chooseLoanAction for proposed loan: apply, pick alternative, cancel", async () => {
	const loan = makeLoan({ alternatives: ["openai/gpt-4o"] });

	// Apply recommendation
	{
		const calls: { title: string; options: string[] }[] = [];
		const ui: LoanUI = {
			select: async (title, options) => {
				calls.push({ title, options });
				return calls.length === 1 ? options[0] : "Apply recommendation (antigravity/gemini-3-8-flash)";
			},
			confirm: async () => false,
			notify: () => {},
		};
		const res = await chooseLoanAction(ui, [loan], 1000);
		assert.deepEqual(res, { id: loan.id, choice: { action: "apply", to: "antigravity/gemini-3-8-flash" } });
		assert.ok(calls[1].title.includes("a running turn keeps its model"));
		assert.deepEqual(calls[1].options, [
			"Apply recommendation (antigravity/gemini-3-8-flash)",
			"Pick another model",
			"Cancel, wait for the quota reset",
		]);
	}

	// Pick alternative
	{
		const calls: { title: string; options: string[] }[] = [];
		const ui: LoanUI = {
			select: async (title, options) => {
				calls.push({ title, options });
				if (calls.length === 1) return options[0];
				if (calls.length === 2) return "Pick another model";
				return "openai/gpt-4o";
			},
			confirm: async () => false,
			notify: () => {},
		};
		const res = await chooseLoanAction(ui, [loan], 1000);
		assert.deepEqual(res, { id: loan.id, choice: { action: "apply", to: "openai/gpt-4o" } });
		assert.equal(calls.length, 3);
		assert.deepEqual(calls[2].options, ["openai/gpt-4o"]);
	}

	// Cancel
	{
		const calls: { title: string; options: string[] }[] = [];
		const ui: LoanUI = {
			select: async (title, options) => {
				calls.push({ title, options });
				if (calls.length === 1) return options[0];
				return "Cancel, wait for the quota reset";
			},
			confirm: async () => false,
			notify: () => {},
		};
		const res = await chooseLoanAction(ui, [loan], 1000);
		assert.deepEqual(res, { id: loan.id, choice: { action: "cancel" } });
	}

	// Empty alternatives hides "Pick another model"
	{
		const noAlts = makeLoan({ alternatives: [] });
		const calls: string[][] = [];
		const ui: LoanUI = {
			select: async (_title, options) => {
				calls.push(options);
				return calls.length === 1 ? options[0] : undefined;
			},
			confirm: async () => false,
			notify: () => {},
		};
		assert.equal(await chooseLoanAction(ui, [noAlts], 1000), undefined, "cancelling the action select returns nothing");
		assert.deepEqual(calls[1], [
			"Apply recommendation (antigravity/gemini-3-8-flash)",
			"Cancel, wait for the quota reset",
		]);
	}
});

test("chooseLoanAction for active loan: end now", async () => {
	const activeLoan = makeLoan({ status: "active", from: "pool/claude-sonnet-5-5" });
	const calls: { title: string; options: string[] }[] = [];
	const ui: LoanUI = {
		select: async (title, options) => {
			calls.push({ title, options });
			if (calls.length === 1) return options[0];
			return options[0];
		},
		confirm: async () => false,
		notify: () => {},
	};
	const res = await chooseLoanAction(ui, [activeLoan], 1000);
	assert.deepEqual(res, { id: activeLoan.id, choice: { action: "end" } });
	assert.ok(calls[1].title.includes("a running turn keeps its model"));
	assert.deepEqual(calls[1].options, ["End now, back to pool/claude-sonnet-5-5"]);
});

test("reviewEndedLoan summary text with and without requests", async () => {
	const endedLoan = makeLoan({ status: "ended", to: "antigravity/gemini-3-8-flash", from: "pool/claude-sonnet-5-5", role: "worker", profile: "default" });

	// With requests
	{
		const summary: LoanSummary = {
			requests: 5,
			weightedTokens: 12500,
			byModel: [{ model: "antigravity/gemini-3-8-flash", requests: 5, weightedTokens: 12500 }],
		};
		const formatted = formatLoanSummary(endedLoan, summary);
		assert.equal(
			formatted,
			"While loaned, antigravity/gemini-3-8-flash answered 5 requests of worker (12500 weighted tokens): antigravity/gemini-3-8-flash 5",
		);

		let selectTitle = "";
		let selectOptions: string[] = [];
		const ui: LoanUI = {
			select: async (title, options) => {
				selectTitle = title;
				selectOptions = options;
				return options[1]; // keep
			},
			confirm: async () => true,
			notify: () => {},
		};
		const choice = await reviewEndedLoan(ui, endedLoan, summary);
		assert.equal(choice, "keep");
		assert.equal(selectTitle, "Loan ended: worker pool/claude-sonnet-5-5 → antigravity/gemini-3-8-flash");
		assert.equal(selectOptions[0], formatted);
		assert.equal(selectOptions[1], "Keep permanently: worker uses antigravity/gemini-3-8-flash in profile default");
		assert.equal(selectOptions[2], "Back to pool/claude-sonnet-5-5");
	}

	// Without requests
	{
		const summary: LoanSummary = { requests: 0, weightedTokens: 0, byModel: [] };
		const formatted = formatLoanSummary(endedLoan, summary);
		assert.ok(formatted.includes("no requests"));

		const ui: LoanUI = {
			select: async (_title, options) => options[2], // revert
			confirm: async () => true,
			notify: () => {},
		};
		const choice = await reviewEndedLoan(ui, endedLoan, summary);
		assert.equal(choice, "revert");
	}

	// Cancelled review
	{
		const ui: LoanUI = {
			select: async () => undefined,
			confirm: async () => true,
			notify: () => {},
		};
		const choice = await reviewEndedLoan(ui, endedLoan, { requests: 0, weightedTokens: 0, byModel: [] });
		assert.equal(choice, undefined);
	}
});

test("formatKeepLoanConfirm includes GRANT_RISKS and backup note", () => {
	const loan = makeLoan();
	const confirm = formatKeepLoanConfirm(loan, "/path/to/profiles.json");
	assert.ok(confirm.title.includes(loan.role));
	assert.ok(confirm.message.includes(GRANT_RISKS[0]));
	assert.ok(confirm.message.includes(GRANT_RISKS[1]));
	assert.ok(confirm.message.includes("/path/to/profiles.json"));
});

test("keepLoanInProfile writes the changed role into profiles.json with a backup and preserves other fields", () => {
	const dir = mkdtempSync(join(tmpdir(), "loan-console-test-"));
	const profilesPath = join(dir, "profiles.json");
	try {
		const initialStore: ProfilesStore = {
			kind: PROFILES_KIND,
			version: PROFILES_VERSION,
			profiles: {
				default: {
					worker: { model: "pool/claude-sonnet-5-5", thinking: "high", custom: 123 },
					orchestrator: { model: "anthropic/claude-3-7-sonnet" },
				},
			},
		};
		const raw = JSON.stringify(initialStore, null, 1) + "\n";
		writeFileSync(profilesPath, raw, "utf8");

		const read: ProfilesRead = { store: initialStore, raw };
		const loan = makeLoan({ profile: "default", role: "worker", to: "antigravity/gemini-3-8-flash" });

		const result = keepLoanInProfile(loan, read, {
			path: profilesPath,
			hasModel: (p, m) => `${p}/${m}` === "antigravity/gemini-3-8-flash",
		});

		assert.ok(result.backup);
		const saved = JSON.parse(readFileSync(profilesPath, "utf8")) as ProfilesStore;
		// worker updated with new model, preserving thinking and custom
		assert.equal(saved.profiles.default.worker.model, "antigravity/gemini-3-8-flash");
		assert.equal(saved.profiles.default.worker.thinking, "high");
		assert.equal(saved.profiles.default.worker.custom, 123);
		// orchestrator untouched
		assert.equal(saved.profiles.default.orchestrator.model, "anthropic/claude-3-7-sonnet");

		// Test creating route when role had no previous route
		const newRoleLoan = makeLoan({ profile: "default", role: "builder", to: "antigravity/gemini-3-8-flash" });
		const read2: ProfilesRead = { store: saved, raw: readFileSync(profilesPath, "utf8") };
		keepLoanInProfile(newRoleLoan, read2, {
			path: profilesPath,
			hasModel: () => true,
		});
		const saved2 = JSON.parse(readFileSync(profilesPath, "utf8")) as ProfilesStore;
		assert.deepEqual(saved2.profiles.default.builder, { model: "antigravity/gemini-3-8-flash", thinking: "medium" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("keepLoanInProfile refuses unknown model and leaves file unchanged", () => {
	const dir = mkdtempSync(join(tmpdir(), "loan-console-test-"));
	const profilesPath = join(dir, "profiles.json");
	try {
		const initialStore: ProfilesStore = {
			kind: PROFILES_KIND,
			version: PROFILES_VERSION,
			profiles: {
				default: {
					worker: { model: "pool/claude-sonnet-5-5" },
				},
			},
		};
		const raw = JSON.stringify(initialStore, null, 1) + "\n";
		writeFileSync(profilesPath, raw, "utf8");

		const read: ProfilesRead = { store: initialStore, raw };
		const loan = makeLoan({ profile: "default", role: "worker", to: "unknown/model" });

		assert.throws(
			() =>
				keepLoanInProfile(loan, read, {
					path: profilesPath,
					hasModel: () => false,
				}),
			/not in Pi's model registry/,
		);
		assert.equal(readFileSync(profilesPath, "utf8"), raw);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("keepLoanInProfile refuses missing profile and leaves file unchanged", () => {
	const dir = mkdtempSync(join(tmpdir(), "loan-console-test-"));
	const profilesPath = join(dir, "profiles.json");
	try {
		const initialStore: ProfilesStore = {
			kind: PROFILES_KIND,
			version: PROFILES_VERSION,
			profiles: {
				default: {
					worker: { model: "pool/claude-sonnet-5-5" },
				},
			},
		};
		const raw = JSON.stringify(initialStore, null, 1) + "\n";
		writeFileSync(profilesPath, raw, "utf8");

		const read: ProfilesRead = { store: initialStore, raw };
		const loan = makeLoan({ profile: "nonexistent", role: "worker", to: "antigravity/gemini-3-8-flash" });

		assert.throws(
			() =>
				keepLoanInProfile(loan, read, {
					path: profilesPath,
					hasModel: () => true,
				}),
			/profile "nonexistent" not found in profiles\.json/,
		);
		assert.equal(readFileSync(profilesPath, "utf8"), raw);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("keepLoanInProfile refuses file changed since read and leaves file unchanged", () => {
	const dir = mkdtempSync(join(tmpdir(), "loan-console-test-"));
	const profilesPath = join(dir, "profiles.json");
	try {
		const initialStore: ProfilesStore = {
			kind: PROFILES_KIND,
			version: PROFILES_VERSION,
			profiles: {
				default: {
					worker: { model: "pool/claude-sonnet-5-5" },
				},
			},
		};
		const raw = JSON.stringify(initialStore, null, 1) + "\n";
		writeFileSync(profilesPath, raw, "utf8");

		const read: ProfilesRead = { store: initialStore, raw };
		const loan = makeLoan({ profile: "default", role: "worker", to: "antigravity/gemini-3-8-flash" });

		// External change before save
		const concurrentlyChangedRaw = JSON.stringify({ ...initialStore, active: "default" }, null, 1) + "\n";
		writeFileSync(profilesPath, concurrentlyChangedRaw, "utf8");

		assert.throws(
			() =>
				keepLoanInProfile(loan, read, {
					path: profilesPath,
					hasModel: () => true,
				}),
			/changed since it was read/,
		);
		assert.equal(readFileSync(profilesPath, "utf8"), concurrentlyChangedRaw);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
