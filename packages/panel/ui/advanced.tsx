import { GridStack, type GridItemHTMLElement, type GridStackNode } from "gridstack";
import { render } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { applyPositions, COLUMNS, showOnBoard, toggleHidden, type Layout, type Widget } from "../src/layout-model.ts";
import type { Report } from "./api.ts";
import { WIDGET_TITLES, WidgetBody } from "./widgets/index.tsx";

// Advanced mode: a gridstack board. gridstack owns the item elements and their
// positions; each item's content is a Preact tree rendered through renderCB.
// Hidden widgets stay off the board and are listed under "Add".

const SAVE_DELAY_MS = 500;
const CELL_HEIGHT = 48;
/** Under this width the board stacks in one column; positions are not saved then. */
const ONE_COLUMN_BELOW = 768;

interface Props {
	layout: Layout;
	report: Report;
	onChange(next: Layout): void;
}

function Item({ widget, report, onHide }: { widget: Widget; report: Report; onHide(): void }) {
	const title = WIDGET_TITLES[widget.kind];
	return (
		<section class="pixel-card board-item" aria-label={title}>
			<header class="layer-head drag-handle" title="Drag to move; drag the corner to resize">
				<h2>{title}</h2>
				<button type="button" aria-label={`Remove ${title} from the board`} onClick={onHide}>
					✕
				</button>
			</header>
			<div class="board-body">
				<WidgetBody kind={widget.kind} report={report} />
			</div>
		</section>
	);
}

export function AdvancedBoard({ layout, report, onChange }: Props) {
	const host = useRef<HTMLDivElement>(null);
	const grid = useRef<GridStack | null>(null);
	const latest = useRef({ layout, report, onChange });
	latest.current = { layout, report, onChange };
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	function paint(el: HTMLElement, id: string): void {
		const { layout: current, report: currentReport, onChange: change } = latest.current;
		const widget = current.widgets.find(w => w.id === id);
		if (widget) render(<Item widget={widget} report={currentReport} onHide={() => change(toggleHidden(latest.current.layout, id))} />, el);
	}

	// Created before the sync effect below runs, which needs the board.
	useLayoutEffect(() => {
		GridStack.renderCB = (el, w) => {
			if (w.id) paint(el, String(w.id));
		};
		const board = GridStack.init(
			{
				column: COLUMNS,
				cellHeight: CELL_HEIGHT,
				margin: 4,
				float: false,
				animate: !matchMedia("(prefers-reduced-motion: reduce)").matches,
				handle: ".drag-handle",
				columnOpts: { breakpoints: [{ w: ONE_COLUMN_BELOW, c: 1 }] },
			},
			host.current!,
		)!;
		grid.current = board;
		board.on("removed", (_event, items: GridStackNode[]) => {
			for (const item of items) {
				const content = item.el?.querySelector<HTMLElement>(".grid-stack-item-content");
				if (content) render(null, content);
			}
		});
		board.on("change", () => {
			if (board.getColumn() !== COLUMNS) return;
			clearTimeout(timer.current);
			timer.current = setTimeout(() => {
				const positions = (board.save(false) as GridStackNode[]).map(n => ({ id: String(n.id), x: n.x, y: n.y, w: n.w, h: n.h }));
				const next = applyPositions(latest.current.layout, positions);
				if (next !== latest.current.layout) latest.current.onChange(next);
			}, SAVE_DELAY_MS);
		});
		return () => {
			clearTimeout(timer.current);
			for (const el of board.getGridItems()) {
				const content = el.querySelector<HTMLElement>(".grid-stack-item-content");
				if (content) render(null, content);
			}
			board.destroy(false);
			grid.current = null;
		};
	}, []);

	// Sync the board with the layout: load() adds, removes and moves by id.
	useLayoutEffect(() => {
		const board = grid.current;
		if (!board) return;
		const shown = layout.widgets.filter(w => !w.hidden);
		board.load(shown.map(w => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h })));
		for (const el of board.getGridItems() as GridItemHTMLElement[]) {
			const id = el.gridstackNode?.id;
			const content = el.querySelector<HTMLElement>(".grid-stack-item-content");
			if (id !== undefined && content) paint(content, String(id));
		}
	}, [layout, report]);

	const hidden = layout.widgets.filter(w => w.hidden);
	return (
		<>
			<div class="board-tools">
				<span class="dim">Drag a title to move, the corner to resize. Saved automatically.</span>
				{hidden.length > 0 ? (
					<div class="add" role="group" aria-label="Add to the board">
						<span>Add:</span>
						{hidden.map(w => (
							<button key={w.id} type="button" onClick={() => onChange(showOnBoard(layout, w.id))}>
								+ {WIDGET_TITLES[w.kind]}
							</button>
						))}
					</div>
				) : null}
			</div>
			<div ref={host} class="grid-stack" />
		</>
	);
}
