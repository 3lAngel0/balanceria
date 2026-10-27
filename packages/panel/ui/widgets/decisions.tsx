import { useState } from "preact/hooks";
import type { Decision, Decisions } from "../api.ts";
import { ALL, decisionFilters, filterDecisions, remainingText, switchCostText, type DecisionFilter } from "../decisions.ts";

// Routing decisions: which rule decided how often, where each role was sent,
// and the newest decisions with filters and their steps and candidates.

const FILTER_LABELS: Record<keyof DecisionFilter, string> = { pool: "Pool", role: "Role", rule: "Rule" };

export function DecisionsWidget({ decisions }: { decisions: Decisions }) {
	// Hooks first: the empty state below must not change the hook order.
	const [filter, setFilter] = useState<DecisionFilter>({ pool: ALL, role: ALL, rule: ALL });
	const [open, setOpen] = useState<string | null>(null);
	if (!decisions || decisions.total === 0) {
		return <p class="dim">No routing decisions yet.</p>;
	}
	const options = decisionFilters(decisions.recent);
	const shown = filterDecisions(decisions.recent, filter);
	const max = Math.max(...decisions.byRule.map(r => r.count));

	return (
		<div class="decisions">
			<p class="dim">{`${decisions.total} decisions in 30 days`}</p>
			<div class="decision-counts">
				<table>
					<caption>By rule</caption>
					<tbody>
						{decisions.byRule.map(r => (
							<tr key={r.rule}>
								<th scope="row">{r.rule}</th>
								<td>
									<span class="count-bar">
										<span class={`count-fill fill-${Math.max(1, Math.round((r.count / max) * 10))}`} />
									</span>
								</td>
								<td class="num">{r.count}</td>
							</tr>
						))}
					</tbody>
				</table>
				<table>
					<caption>Role → pool → chosen</caption>
					<thead>
						<tr>
							<th scope="col">Role</th>
							<th scope="col">Pool</th>
							<th scope="col">Chosen</th>
							<th scope="col" class="num">Count</th>
						</tr>
					</thead>
					<tbody>
						{decisions.byRole.map(r => (
							<tr key={`${r.role} ${r.pool} ${r.chosen}`}>
								<td>{r.role}</td>
								<td>{r.pool}</td>
								<td>{r.chosen}</td>
								<td class="num">{r.count}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div class="decision-filters" role="group" aria-label="Filter the newest decisions">
				{(Object.keys(FILTER_LABELS) as (keyof DecisionFilter)[]).map(key => (
					<label key={key}>
						{FILTER_LABELS[key]}{" "}
						<select value={filter[key]} onChange={e => setFilter({ ...filter, [key]: (e.target as HTMLSelectElement).value })}>
							<option value={ALL}>all</option>
							{options[key].map(value => (
								<option key={value} value={value}>
									{value}
								</option>
							))}
						</select>
					</label>
				))}
			</div>
			<p class="dim" aria-live="polite">
				{`Newest ${decisions.recent.length}${decisions.omitted > 0 ? ` (${decisions.omitted} older not shown)` : ""}: ${shown.length} match`}
			</p>
			<ul class="decision-list">
				{shown.map(d => {
					const id = `${d.ts}-${d.session}-${d.pool}`;
					return <DecisionRow key={id} decision={d} open={open === id} onToggle={() => setOpen(open === id ? null : id)} />;
				})}
			</ul>
		</div>
	);
}

function DecisionRow({ decision: d, open, onToggle }: { decision: Decision; open: boolean; onToggle: () => void }) {
	const detailId = `decision-${d.ts}-${d.session}-${d.pool}`.replace(/[^a-zA-Z0-9-]/g, "-");
	return (
		<li>
			<button type="button" class="decision-row" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
				<span>{new Date(d.ts).toLocaleString()}</span>
				<span>{d.role}</span>
				<span>{`${d.pool} → ${d.chosen}`}</span>
				<span class="rule-tag">{d.decidedBy}</span>
			</button>
			{open && (
				<div id={detailId} class="decision-detail">
					<p class="dim">{`Session ${d.session} · ${d.project} · reason ${d.reason}${d.contextTokens !== null ? ` · context ${d.contextTokens.toLocaleString()} tokens` : ""}`}</p>
					<ol class="decision-steps">
						{d.steps.map((s, i) => (
							<li key={i}>
								<span class="rule-tag">{s.rule}</span> {`${s.result}: ${s.why}`}
							</li>
						))}
					</ol>
					<table>
						<caption>Candidates</caption>
						<thead>
							<tr>
								<th scope="col">Provider</th>
								<th scope="col">Quota key</th>
								<th scope="col">Available</th>
								<th scope="col" class="num">Remaining</th>
								<th scope="col">Reopens</th>
							</tr>
						</thead>
						<tbody>
							{d.candidates.map(c => (
								<tr key={c.provider}>
									<td>{c.provider}</td>
									<td>{c.quotaKey}</td>
									<td>{c.available ? "yes" : "no"}</td>
									<td class="num">{remainingText(c.remaining)}</td>
									<td>{c.availableAt !== undefined ? new Date(c.availableAt).toLocaleString() : "–"}</td>
								</tr>
							))}
						</tbody>
					</table>
					{d.switchCost && <p class="dim">{switchCostText(d.switchCost)}</p>}
				</div>
			)}
		</li>
	);
}
