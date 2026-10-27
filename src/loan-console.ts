import { GRANT_RISKS } from "./permissions.ts";
import { formatLoan, type Loan, type LoanChoice, type LoanSummary } from "./loans.ts";
import {
	DEFAULT_PROFILES_PATH,
	saveProfilesStore,
	type ProfilesRead,
	type ProfilesStore,
	type RoleRoute,
	type SaveProfilesOptions,
} from "./profiles.ts";

// Console alerts, TUI widget, `/balancer loans` chooser and end-of-loan review
// (docs/design/control-plane.md §8, specs S8 S9). Kept free of Pi imports so
// every flow is unit-testable against small UI mock interfaces.

export interface LoanUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

const NOTIFY_STATUSES = new Set(["proposed", "active", "ended"]);

/**
 * Returns notice messages for loans whose `${id}:${status}` has not yet been
 * notified in this process, and marks them in `seen`. Closed loans produce no notices.
 */
export function loanNotices(loans: readonly Loan[], seen: Set<string>, now: number): string[] {
	const notices: string[] = [];
	for (const loan of loans) {
		if (!NOTIFY_STATUSES.has(loan.status)) continue;
		const key = `${loan.id}:${loan.status}`;
		if (seen.has(key)) continue;
		seen.add(key);
		notices.push(`ai-balancer: loan ${loan.status} — ${formatLoan(loan, now)}. Run /balancer loans to choose.`);
	}
	return notices;
}

/**
 * Durable non-blocking alert lines for proposed, active and ended loans.
 * Returns undefined when there are no loans in those states.
 */
export function loanWidget(loans: readonly Loan[], now: number): string[] | undefined {
	const relevant = loans.filter(loan => NOTIFY_STATUSES.has(loan.status));
	if (relevant.length === 0) return undefined;
	return relevant.map(loan => {
		const state = loan.status === "ended" ? "ended (waiting for review)" : loan.status;
		return `loan ${state}: ${formatLoan(loan, now)} · /balancer loans`;
	});
}

/** Formats the requests and weighted tokens answered while a loan was active. */
export function formatLoanSummary(loan: Loan, summary: LoanSummary): string {
	if (summary.requests === 0) {
		return `While loaned, ${loan.to} answered no requests of ${loan.role}`;
	}
	const breakdown = summary.byModel.map(entry => `${entry.model} ${entry.requests}`).join(", ");
	const models = breakdown ? `: ${breakdown}` : "";
	return `While loaned, ${loan.to} answered ${summary.requests} requests of ${loan.role} (${summary.weightedTokens} weighted tokens)${models}`;
}

/**
 * The end-of-loan review popup: shows summary metrics and lets the user choose
 * between keeping the loan permanently in profiles.json or going back to the pool.
 */
export async function reviewEndedLoan(ui: LoanUI, loan: Loan, summary: LoanSummary): Promise<"keep" | "revert" | undefined> {
	const title = `Loan ended: ${loan.role} ${loan.from} → ${loan.to}`;
	const summaryLine = formatLoanSummary(loan, summary);
	const keepOption = `Keep permanently: ${loan.role} uses ${loan.to} in profile ${loan.profile}`;
	const revertOption = `Back to ${loan.from}`;
	while (true) {
		const choice = await ui.select(title, [summaryLine, keepOption, revertOption]);
		if (choice === undefined) return undefined;
		if (choice === keepOption) return "keep";
		if (choice === revertOption) return "revert";
	}
}

/**
 * Interactive chooser for `/balancer loans`. When loans exist, lets the user
 * choose a loan and then apply, pick an alternative model, cancel or end it.
 */
export async function chooseLoanAction(
	ui: LoanUI,
	loans: readonly Loan[],
	now: number,
	getSummary?: (loan: Loan) => LoanSummary | Promise<LoanSummary>,
): Promise<{ id: string; choice: LoanChoice } | undefined> {
	const candidates = loans.filter(loan => NOTIFY_STATUSES.has(loan.status));
	if (candidates.length === 0) {
		ui.notify(
			"ai-balancer: no loans. A loan is proposed when a pool's preferred model is spent and a permission grant covers the role (/balancer permissions grant).",
		);
		return undefined;
	}

	const loanLabels = candidates.map(loan => formatLoan(loan, now));
	const pickedLabel = await ui.select("Choose a loan (a running turn keeps its model)", loanLabels);
	if (pickedLabel === undefined) return undefined;

	const loan = candidates.find(candidate => formatLoan(candidate, now) === pickedLabel);
	if (!loan) return undefined;

	if (loan.status === "proposed") {
		const applyOption = `Apply recommendation (${loan.to})`;
		const pickOption = "Pick another model";
		const cancelOption = "Cancel, wait for the quota reset";
		const options = [applyOption, ...(loan.alternatives.length > 0 ? [pickOption] : []), cancelOption];
		const choice = await ui.select(`Loan proposed: ${loan.role} ${loan.from} → ${loan.to} (a running turn keeps its model)`, options);
		if (choice === undefined) return undefined;
		if (choice === applyOption) {
			return { id: loan.id, choice: { action: "apply", to: loan.to } };
		}
		if (choice === pickOption) {
			const pickedAlt = await ui.select("Pick another model (a running turn keeps its model)", loan.alternatives);
			if (pickedAlt === undefined) return undefined;
			return { id: loan.id, choice: { action: "apply", to: pickedAlt } };
		}
		if (choice === cancelOption) {
			return { id: loan.id, choice: { action: "cancel" } };
		}
		return undefined;
	}

	if (loan.status === "active") {
		const endOption = `End now, back to ${loan.from}`;
		const choice = await ui.select(`Loan active: ${loan.role} ${loan.from} → ${loan.to} (a running turn keeps its model)`, [endOption]);
		if (choice === undefined) return undefined;
		if (choice === endOption) {
			return { id: loan.id, choice: { action: "end" } };
		}
		return undefined;
	}

	if (loan.status === "ended") {
		const summary = getSummary ? await getSummary(loan) : { requests: 0, weightedTokens: 0, byModel: [] };
		const action = await reviewEndedLoan(ui, loan, summary);
		if (action === undefined) return undefined;
		return { id: loan.id, choice: { action } };
	}

	return undefined;
}

/** Confirmation text shown before writing a permanent model change to profiles.json. */
export function formatKeepLoanConfirm(loan: Loan, profilesPath = DEFAULT_PROFILES_PATH): { title: string; message: string } {
	const title = `Keep ${loan.to} permanently for ${loan.role}?`;
	const message = [
		`Sets ${loan.role} to ${loan.to} in profile ${loan.profile}.`,
		"",
		"Risks:",
		GRANT_RISKS[0],
		GRANT_RISKS[1],
		"",
		`A backup of ${profilesPath} is created before saving.`,
	].join("\n");
	return { title, message };
}

/**
 * Sets `profiles[loan.profile][loan.role].model = loan.to` in profiles.json
 * through `saveProfilesStore` (safely checks kind/version, registry and backups).
 */
export function keepLoanInProfile(
	loan: Loan,
	read: ProfilesRead,
	options: SaveProfilesOptions,
): { backup: string; removed: string[] } {
	const profile = read.store.profiles?.[loan.profile];
	if (!profile) {
		throw new Error(`ai-balancer: profile "${loan.profile}" not found in profiles.json`);
	}
	const existingRoute = profile[loan.role];
	const nextRoute: RoleRoute = existingRoute
		? { ...existingRoute, model: loan.to }
		: { model: loan.to, thinking: "medium" };

	const nextStore: ProfilesStore = {
		...read.store,
		profiles: {
			...read.store.profiles,
			[loan.profile]: {
				...profile,
				[loan.role]: nextRoute,
			},
		},
	};

	return saveProfilesStore(nextStore, read, options);
}
