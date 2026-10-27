import { useState } from "preact/hooks";
import type { Usage } from "../api.ts";
import { shownSeries, stepLines, toggleSeries } from "../charts.ts";

// Quota windows: daily peak usage per window over 0-100% with a 100% limit guide,
// interactive series toggles, and an accessible data table fallback.

const WIDTH = 300;
const HEIGHT = 120;

export function QuotaWidget({ usage }: { usage: Usage }) {
	// Hooks first: the empty state below must not change the hook order.
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
	const [table, setTable] = useState(false);
	if (!usage || usage.quota.length === 0 || usage.days.length === 0) {
		return <p class="dim">No balancer history yet.</p>;
	}
	const names = usage.quota.map(s => `${s.limit} ${s.window}`);
	const visible = shownSeries(names, hidden);
	const toggle = (index: number) => setHidden(prev => toggleSeries(prev, names[index]!));

	return (
		<div class="chart-widget">
			<div class="chart-tools">
				<div class="legend" role="group" aria-label="Toggle series">
					{usage.quota.map((s, i) => (
						<button
							key={`${s.limit}-${s.window}`}
							type="button"
							class={`legend-btn series-${i % 6}`}
							aria-pressed={visible[i]}
							onClick={() => toggle(i)}
						>
							{`${s.limit} ${s.window}`}
						</button>
					))}
				</div>
				<button type="button" aria-pressed={table} onClick={() => setTable(!table)}>
					Table
				</button>
			</div>
			{table ? (
				<div class="chart-table-wrap">
					<table>
						<thead>
							<tr>
								<th>Day</th>
								{usage.quota.map((s, i) => (
									<th key={`${s.limit}-${s.window}`} class={`series-${i % 6}`}>{`${s.limit} ${s.window}`}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{usage.days.map((day, d) => (
								<tr key={day}>
									<td>{day}</td>
									{usage.quota.map(s => (
										<td key={`${s.limit}-${s.window}`}>
											{s.daily[d] !== null && s.daily[d] !== undefined ? `${s.daily[d]}%` : "–"}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<svg
					viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
					role="img"
					aria-label="Quota windows"
					class="chart-svg"
					shape-rendering="crispEdges"
				>
					<line x1="0" y1="0" x2={WIDTH} y2="0" class="guide-100">
						<title>100% guide</title>
					</line>
					{usage.quota.map((s, i) => {
						if (!visible[i]) return null;
						const paths = stepLines(s.daily, { width: WIDTH, height: HEIGHT, max: 100 });
						return paths.map((p, pIdx) => (
							<path
								key={`${i}-${pIdx}`}
								d={p}
								class={`series-${i % 6} chart-line`}
							>
								<title>{`${s.limit} ${s.window}${s.peak !== null ? ` · peak ${s.peak}%` : ""}`}</title>
							</path>
						));
					})}
				</svg>
			)}
		</div>
	);
}
