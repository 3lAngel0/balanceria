// Pure chart geometry for the panel's pixel SVG charts: stacked bars for tokens
// and stepped lines for quota windows. No DOM dependencies.

export interface Bar {
	day: number;
	series: number;
	value: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface StackedBarsOptions {
	width: number;
	height: number;
	gap: number;
}

export interface StackedBarsResult {
	bars: Bar[];
	max: number;
}

/** Stacks visible series per day on whole pixels, scaled to the tallest day. */
export function stackedBars(
	series: readonly (readonly number[])[],
	visible: readonly boolean[],
	options: StackedBarsOptions,
): StackedBarsResult {
	const days = series[0]?.length ?? 0;
	if (days === 0 || series.length === 0) return { bars: [], max: 0 };

	const daySums = new Array<number>(days).fill(0);
	for (let d = 0; d < days; d++) {
		for (let s = 0; s < series.length; s++) {
			if (visible[s]) daySums[d] += series[s]![d] ?? 0;
		}
	}

	const max = Math.max(0, ...daySums);
	if (max <= 0) return { bars: [], max: 0 };

	const slot = options.width / days;
	const barWidth = slot - options.gap;
	const scale = options.height / max;
	const bars: Bar[] = [];

	for (let d = 0; d < days; d++) {
		let cum = 0;
		let previousTop = options.height;
		const x = d * slot;
		for (let s = 0; s < series.length; s++) {
			if (!visible[s]) continue;
			const val = series[s]![d] ?? 0;
			if (val <= 0) continue;
			cum += val;
			const y = options.height - Math.round(cum * scale);
			const height = previousTop - y;
			previousTop = y;
			bars.push({ day: d, series: s, value: val, x, y, width: barWidth, height });
		}
	}

	return { bars, max };
}

export interface StepLinesOptions {
	width: number;
	height: number;
	max: number;
}

/** Stepped path strings, one per run of non-null days. */
export function stepLines(
	values: readonly (number | null)[],
	options: StepLinesOptions,
): string[] {
	const len = values.length;
	if (len === 0 || options.max <= 0) return [];
	const slot = options.width / len;
	const paths: string[] = [];
	let currentRun: { path: string; prevY: number } | null = null;

	for (let d = 0; d < len; d++) {
		const val = values[d];
		if (val === null || val === undefined) {
			if (currentRun) {
				paths.push(currentRun.path);
				currentRun = null;
			}
			continue;
		}
		const clamped = Math.max(0, Math.min(options.max, val));
		const y = options.height - Math.round((clamped / options.max) * options.height);
		const x = d * slot;
		const nextX = x + slot;

		if (!currentRun) {
			currentRun = { path: `M${x} ${y}H${nextX}`, prevY: y };
		} else {
			if (y === currentRun.prevY) {
				currentRun.path += `H${nextX}`;
			} else {
				currentRun.path += `V${y}H${nextX}`;
				currentRun.prevY = y;
			}
		}
	}

	if (currentRun) {
		paths.push(currentRun.path);
	}

	return paths;
}

/** Hidden series by name, so a series that appears on a later poll starts shown. */
export function toggleSeries(hidden: ReadonlySet<string>, name: string): ReadonlySet<string> {
	const next = new Set(hidden);
	if (!next.delete(name)) next.add(name);
	return next;
}

/** One flag per series name: shown unless hidden. */
export function shownSeries(names: readonly string[], hidden: ReadonlySet<string>): boolean[] {
	return names.map(name => !hidden.has(name));
}
