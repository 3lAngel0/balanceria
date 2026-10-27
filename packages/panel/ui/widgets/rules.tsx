import { useEffect, useState } from "preact/hooks";
import { fetchLab, saveLabDraftPools, type Decisions, type LabDraft } from "../api.ts";
import {
	addPreferForRole,
	addSticky,
	applyPoolRules,
	effectiveRules,
	knownRoles,
	moveRule,
	removeRule,
	setPickMode,
	type DraftPool,
	type PickMode,
	type RuleBlock,
} from "../rules.ts";

// Rule editor widget: edits only the lab draft's pools.json via /api/lab/pools.
// Applying, undoing, starting or discarding a draft stays in Pi (/balancer lab).

function errText(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

export function RulesWidget({ decisions }: { decisions: Decisions }) {
	const [draft, setDraft] = useState<LabDraft | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const load = () => {
		setError(null);
		fetchLab().then(
			next => setDraft(next),
			reason => setError(errText(reason)),
		);
	};

	useEffect(load, []);

	function savePool(poolId: string, nextRules: readonly RuleBlock[]): void {
		if (!draft?.pools) return;
		const nextConfig = applyPoolRules(draft.pools, poolId, nextRules);
		setSaving(true);
		setError(null);
		saveLabDraftPools(draft.version, nextConfig).then(
			saved => {
				setDraft(saved);
				setSaving(false);
			},
			reason => {
				setError(errText(reason));
				setSaving(false);
			},
		);
	}

	if (draft === undefined && !error) return <p class="dim">Loading lab draft…</p>;
	if (draft === null) {
		return (
			<div class="rules-widget">
				<p class="dim">No active lab draft. Start one in Pi: <code>/balancer lab new</code></p>
				<div>
					<button type="button" onClick={load}>Reload draft</button>
				</div>
			</div>
		);
	}

	const roles = knownRoles(decisions?.byRole ?? []);
	const pools = Array.isArray(draft?.pools?.pools) ? draft.pools.pools : [];

	return (
		<div class="rules-widget">
			<div class="rules-toolbar">
				<span class="dim">
					{draft ? `Draft from ${new Date(draft.createdAt).toLocaleString()} · Apply from Pi: /balancer lab diff · simulate · apply` : "Lab draft"}
				</span>
				<button type="button" onClick={load} disabled={saving}>Reload</button>
			</div>
			{error && (
				<p class="notice" role="alert">
					{error}
				</p>
			)}
			{draft && draft.issues.length > 0 && (
				<div class="notice" role="alert">
					<strong>Validation issues:</strong>
					<ul class="rules-issues">
						{draft.issues.map((issue, idx) => (
							<li key={idx}>{issue}</li>
						))}
					</ul>
				</div>
			)}
			{draft && (
				<div class="rules-diff" aria-live="polite">
					<span class="dim">{draft.changes.length === 0 ? "No pool changes against live pools.json." : `${draft.changes.length} change(s) vs live pools.json:`}</span>
					{draft.changes.length > 0 && (
						<ul class="rules-changes">
							{draft.changes.map((c, idx) => (
								<li key={idx}>{c}</li>
							))}
						</ul>
					)}
				</div>
			)}
			<datalist id="known-routing-roles">
				{roles.map(r => (
					<option key={r} value={r} />
				))}
			</datalist>
			<div class="pool-cards">
				{pools.map(pool => (
					<PoolRuleCard
						key={pool.id}
						pool={pool}
						roles={roles}
						disabled={saving}
						onSave={next => savePool(pool.id, next)}
					/>
				))}
			</div>
		</div>
	);
}

function PoolRuleCard({
	pool,
	roles,
	disabled,
	onSave,
}: {
	pool: DraftPool;
	roles: readonly string[];
	disabled: boolean;
	onSave: (rules: RuleBlock[]) => void;
}) {
	const rules = effectiveRules(pool);
	const hasExplicitRules = Array.isArray(pool.rules) && pool.rules.length > 0;
	const hasSticky = rules.some(r => r.rule === "sticky");
	const lastMovable = rules[rules.length - 1]?.rule === "pick" ? rules.length - 2 : rules.length - 1;
	const [dragFrom, setDragFrom] = useState<number | null>(null);
	const [roleInput, setRoleInput] = useState(roles[0] ?? "gentle-ai-worker");
	const [candidateInput, setCandidateInput] = useState(pool.candidates[0] ?? "");

	return (
		<section class="pool-card" aria-label={`Pool ${pool.id}`}>
			<div class="pool-head">
				<strong>{pool.name ? `${pool.name} (${pool.id})` : pool.id}</strong>
				<span class="dim">{hasExplicitRules ? "custom rules" : `default (${pool.strategy ?? "hybrid"})`}</span>
			</div>
			<p class="dim">{`Candidates: ${pool.candidates.join(" → ")}`}</p>
			<ol class="rule-list" aria-label={`Rules for ${pool.id}`}>
				{rules.map((block, index) => {
					const isPick = block.rule === "pick";
					return (
						<li
							key={`${index}-${block.rule}`}
							class={`rule-row${dragFrom === index ? " is-dragging" : ""}`}
							draggable={!isPick && !disabled}
							onDragStart={e => {
								if (isPick || disabled) return;
								setDragFrom(index);
								if (e.dataTransfer) {
									e.dataTransfer.effectAllowed = "move";
									e.dataTransfer.setData("text/plain", String(index));
								}
							}}
							onDragOver={e => {
								if (isPick || dragFrom === null || dragFrom === index) return;
								e.preventDefault();
							}}
							onDrop={e => {
								e.preventDefault();
								if (isPick || dragFrom === null || dragFrom === index) return;
								const from = dragFrom;
								setDragFrom(null);
								onSave(moveRule(rules, from, index));
							}}
							onDragEnd={() => setDragFrom(null)}
						>
							<span class="rule-tag">{block.rule}</span>
							{block.rule === "sticky" && <span class="rule-desc">keep the session's previous provider while available</span>}
							{block.rule === "prefer-for-role" && (
								<span class="rule-desc">{`role ${block.role} → ${block.candidate}`}</span>
							)}
							{block.rule === "pick" && (
								<label class="rule-desc">
									mode{" "}
									<select
										aria-label={`Pick mode for ${pool.id}`}
										value={block.mode}
										disabled={disabled}
										onChange={e => onSave(setPickMode(rules, (e.target as HTMLSelectElement).value as PickMode))}
									>
										<option value="highest-quota">highest-quota</option>
										<option value="first">first</option>
									</select>
								</label>
							)}
							{!isPick && (
								<div class="rule-actions">
									<button
										type="button"
										aria-label={`Move rule ${index + 1} up in ${pool.id}`}
										disabled={disabled || index === 0}
										onClick={() => onSave(moveRule(rules, index, index - 1))}
									>
										▲
									</button>
									<button
										type="button"
										aria-label={`Move rule ${index + 1} down in ${pool.id}`}
										disabled={disabled || index >= lastMovable}
										onClick={() => onSave(moveRule(rules, index, index + 1))}
									>
										▼
									</button>
									<button
										type="button"
										aria-label={`Remove rule ${index + 1} from ${pool.id}`}
										disabled={disabled}
										onClick={() => onSave(removeRule(rules, index))}
									>
										✕
									</button>
								</div>
							)}
						</li>
					);
				})}
			</ol>
			<div class="rule-add">
				<label>
					Role{" "}
					<input
						type="text"
						list="known-routing-roles"
						aria-label={`Role for ${pool.id}`}
						value={roleInput}
						disabled={disabled}
						onInput={e => setRoleInput((e.target as HTMLInputElement).value)}
					/>
				</label>
				<label>
					Candidate{" "}
					<select
						aria-label={`Candidate for ${pool.id}`}
						value={candidateInput}
						disabled={disabled}
						onChange={e => setCandidateInput((e.target as HTMLSelectElement).value)}
					>
						{pool.candidates.map(cand => (
							<option key={cand} value={cand}>
								{cand}
							</option>
						))}
					</select>
				</label>
				<button
					type="button"
					disabled={disabled || !roleInput.trim() || !candidateInput}
					onClick={() => {
						const next = addPreferForRole(rules, roleInput, candidateInput);
						if (next !== rules) onSave(next);
					}}
				>
					+ prefer-for-role
				</button>
				{!hasSticky && (
					<button type="button" disabled={disabled} onClick={() => onSave(addSticky(rules))}>
						+ sticky
					</button>
				)}
			</div>
		</section>
	);
}
