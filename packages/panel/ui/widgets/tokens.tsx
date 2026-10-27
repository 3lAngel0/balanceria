import { useState } from "preact/hooks";
import type { Usage } from "../api.ts";
import { shownSeries, stackedBars, toggleSeries } from "../charts.ts";

// Tokens per day: stacked bars per provider over the 30-day retention window,
// with interactive series toggles and an accessible data table fallback.

const WIDTH = 300;
const HEIGHT = 120;
const GAP = 2;

export function TokensWidget({ usage }: { usage: Usage }) {
	// Hooks first: the empty state below must not change the hook order.
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
	const [table, setTable] = useState(false);
	if (!usage || usage.tokens.length === 0 || usage.days.length === 0) {
		return <p class="dim">No balancer history yet.</p>;
	}
	const names = usage.tokens.map(s => s.provider);
	const visible = shownSeries(names, hidden);
	const toggle = (index: number) => setHidden(prev => toggleSeries(prev, names[index]!));

	const rawSeries = usage.tokens.map(t => t.daily);
	const { bars } = stackedBars(rawSeries, visible, { width: WIDTH, height: HEIGHT, gap: GAP });

	return (
		<div class="chart-widget">
			<div class="chart-tools">
				<div class="legend" role="group" aria-label="Toggle series">
					{usage.tokens.map((s, i) => (
						<button
							key={s.provider}
							type="button"
							class={`legend-btn series-${i % 6}`}
							aria-pressed={visible[i]}
							onClick={() => toggle(i)}
						>
							{s.provider}
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
								{usage.tokens.map((s, i) => (
									<th key={s.provider} class={`series-${i % 6}`}>{s.provider}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{usage.days.map((day, d) => (
								<tr key={day}>
									<td>{day}</td>
									{usage.tokens.map(s => (
										<td key={s.provider}>{(s.daily[d] ?? 0).toLocaleString("en-US")}</td>
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
					aria-label="Tokens per day"
					class="chart-svg"
					shape-rendering="crispEdges"
				>
					{bars.map((b, i) => (
						<rect
							key={i}
							x={b.x}
							y={b.y}
							width={b.width}
							height={b.height}
							class={`series-${b.series % 6}`}
						>
							<title>{`${usage.days[b.day]} · ${usage.tokens[b.series]?.provider}: ${b.value.toLocaleString("en-US")} tokens`}</title>
						</rect>
					))}
				</svg>
			)}
		</div>
	);
}
