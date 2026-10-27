// The panel layout model, pure: shared by the server (layout.ts) and the UI
// bundle, so it imports nothing from node.

export const COLUMNS = 12;
export const MAX_WIDGETS = 24;
export const WIDGET_KINDS = ["summary", "projects", "recent", "tokens", "quota", "decisions", "rules", "profiles", "setup"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];
export type Mode = "simple" | "advanced";

export interface Widget {
	id: string;
	kind: WidgetKind;
	x: number;
	y: number;
	w: number;
	h: number;
	hidden?: boolean;
}

export interface Layout {
	version: 1;
	mode: Mode;
	widgets: Widget[];
}

export const DEFAULT_LAYOUT: Layout = {
	version: 1,
	mode: "simple",
	widgets: [
		{ id: "summary", kind: "summary", x: 0, y: 0, w: 12, h: 2 },
		{ id: "projects", kind: "projects", x: 0, y: 2, w: 8, h: 6 },
		{ id: "recent", kind: "recent", x: 8, y: 2, w: 4, h: 6 },
		{ id: "tokens", kind: "tokens", x: 0, y: 8, w: 6, h: 6 },
		{ id: "quota", kind: "quota", x: 6, y: 8, w: 6, h: 6 },
		{ id: "decisions", kind: "decisions", x: 0, y: 14, w: 12, h: 8 },
		{ id: "rules", kind: "rules", x: 0, y: 22, w: 12, h: 8 },
		{ id: "profiles", kind: "profiles", x: 0, y: 30, w: 12, h: 8 },
		{ id: "setup", kind: "setup", x: 0, y: 38, w: 12, h: 8 },
	],
};

const WIDGET_ID = /^[a-z0-9-]{1,32}$/;
const LAYOUT_FIELDS = new Set(["version", "mode", "widgets"]);
const WIDGET_FIELDS = new Set(["id", "kind", "x", "y", "w", "h", "hidden"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inRange(value: unknown, min: number, max: number): value is number {
	return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** The layout when valid, else every issue found. */
export function validateLayout(value: unknown): { layout: Layout } | { issues: string[] } {
	if (!isObject(value)) return { issues: ["the layout must be an object"] };
	const issues: string[] = [];
	if (value.version !== 1) issues.push("version must be 1");
	if (value.mode !== "simple" && value.mode !== "advanced") issues.push("mode must be simple or advanced");
	for (const key of Object.keys(value)) if (!LAYOUT_FIELDS.has(key)) issues.push(`unknown field ${key}`);
	if (!Array.isArray(value.widgets)) return { issues: [...issues, "widgets must be a list"] };
	if (value.widgets.length > MAX_WIDGETS) return { issues: [...issues, `at most ${MAX_WIDGETS} widgets`] };
	const seen = new Set<string>();
	value.widgets.forEach((widget: unknown, index) => {
		const at = `widget ${index + 1}`;
		if (!isObject(widget)) {
			issues.push(`${at}: must be an object`);
			return;
		}
		if (typeof widget.id !== "string" || !WIDGET_ID.test(widget.id)) issues.push(`${at}: id must match ${WIDGET_ID.source}`);
		else if (seen.has(widget.id)) issues.push(`${at}: id ${widget.id} is used twice`);
		else seen.add(widget.id);
		if (!WIDGET_KINDS.includes(widget.kind as WidgetKind)) issues.push(`${at}: kind must be one of ${WIDGET_KINDS.join(", ")}`);
		const x = inRange(widget.x, 0, COLUMNS - 1);
		const w = inRange(widget.w, 1, COLUMNS);
		if (!x) issues.push(`${at}: x must be an integer from 0 to ${COLUMNS - 1}`);
		if (!inRange(widget.y, 0, 200)) issues.push(`${at}: y must be an integer from 0 to 200`);
		if (!w) issues.push(`${at}: w must be an integer from 1 to ${COLUMNS}`);
		if (x && w && (widget.x as number) + (widget.w as number) > COLUMNS) issues.push(`${at}: x + w must be at most ${COLUMNS}`);
		if (!inRange(widget.h, 1, 24)) issues.push(`${at}: h must be an integer from 1 to 24`);
		if (widget.hidden !== undefined && typeof widget.hidden !== "boolean") issues.push(`${at}: hidden must be true or false`);
		for (const key of Object.keys(widget)) if (!WIDGET_FIELDS.has(key)) issues.push(`${at}: unknown field ${key}`);
	});
	return issues.length > 0 ? { issues } : { layout: value as unknown as Layout };
}

/** Appends any missing widget kind hidden below the board, up to MAX_WIDGETS; returns the same layout when complete. */
export function withAllKinds(layout: Layout): Layout {
	const present = new Set(layout.widgets.map(w => w.kind));
	const missing = WIDGET_KINDS.filter(k => !present.has(k));
	if (missing.length === 0 || layout.widgets.length >= MAX_WIDGETS) return layout;

	const bottom = Math.min(200, layout.widgets.filter(w => !w.hidden).reduce((max, w) => Math.max(max, w.y + w.h), 0));
	const taken = new Set(layout.widgets.map(w => w.id));
	const appended: Widget[] = [];

	for (const kind of missing) {
		if (layout.widgets.length + appended.length >= MAX_WIDGETS) break;
		let id: string = kind;
		if (taken.has(id)) {
			let counter = 2;
			while (taken.has(`${kind}-${counter}`)) counter++;
			id = `${kind}-${counter}`;
		}
		taken.add(id);

		const def = DEFAULT_LAYOUT.widgets.find(w => w.kind === kind);
		const x = def?.x ?? 0;
		const w = def?.w ?? 12;
		const h = def?.h ?? 2;

		appended.push({ id, kind, x, y: bottom, w, h, hidden: true });
	}

	return appended.length > 0 ? { ...layout, widgets: [...layout.widgets, ...appended] } : layout;
}

/** The same layout in another mode. */
export function setMode(layout: Layout, mode: Mode): Layout {
	return { ...layout, mode };
}

/** Hides a shown widget or shows a hidden one; unknown ids change nothing. */
export function toggleHidden(layout: Layout, id: string): Layout {
	if (!layout.widgets.some(w => w.id === id)) return layout;
	return {
		...layout,
		widgets: layout.widgets.map(w => {
			if (w.id !== id) return w;
			if (w.hidden) {
				const { hidden: _hidden, ...shown } = w;
				return shown;
			}
			return { ...w, hidden: true };
		}),
	};
}

/** Moves a widget one place up (-1) or down (1) in the simple-mode order. */
export function moveWidget(layout: Layout, id: string, step: -1 | 1): Layout {
	const from = layout.widgets.findIndex(w => w.id === id);
	const to = from + step;
	if (from < 0 || to < 0 || to >= layout.widgets.length) return layout;
	const widgets = [...layout.widgets];
	[widgets[from], widgets[to]] = [widgets[to]!, widgets[from]!];
	return { ...layout, widgets };
}

export interface Position {
	id: string;
	x?: number;
	y?: number;
	w?: number;
	h?: number;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/** The board's positions applied to known widgets, kept inside 12 columns; the same layout when nothing moved. */
export function applyPositions(layout: Layout, positions: readonly Position[]): Layout {
	const byId = new Map(positions.map(p => [p.id, p]));
	let changed = false;
	const widgets = layout.widgets.map(widget => {
		const p = byId.get(widget.id);
		if (!p) return widget;
		const w = clampInt(p.w, 1, COLUMNS, widget.w);
		const x = Math.min(clampInt(p.x, 0, COLUMNS - 1, widget.x), COLUMNS - w);
		const y = clampInt(p.y, 0, 200, widget.y);
		const h = clampInt(p.h, 1, 24, widget.h);
		if (x === widget.x && y === widget.y && w === widget.w && h === widget.h) return widget;
		changed = true;
		return { ...widget, x, y, w, h };
	});
	return changed ? { ...layout, widgets } : layout;
}

/** Shows a hidden widget again, placed below every shown one; shown or unknown ids change nothing. */
export function showOnBoard(layout: Layout, id: string): Layout {
	const target = layout.widgets.find(w => w.id === id);
	if (!target?.hidden) return layout;
	const bottom = layout.widgets.filter(w => !w.hidden).reduce((max, w) => Math.max(max, w.y + w.h), 0);
	return {
		...layout,
		widgets: layout.widgets.map(w => {
			if (w.id !== id) return w;
			const { hidden: _hidden, ...shown } = w;
			return { ...shown, y: Math.min(bottom, 200) };
		}),
	};
}
