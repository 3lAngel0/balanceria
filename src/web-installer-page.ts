// Page layout, CSS and client script for the conversational web installer (Design 3).
// Served by `web-installer.ts`. CSP allows only same-origin style and script: no inline styles, no eval, no innerHTML.

import { t } from "./i18n/index.ts";

export function installerPageStyle(): string {
	return `:root{--bg:#181425;--surface:#262b44;--border:#3a4466;--shadow:#0e0b16;--light:#5a6988;--text:#e4e6ee;--dim:#8b9bb4;--accent:#feae34;--hp:#38b764;--mp:#3b5dc9;--xp:#a363d9;--bad:#e43b44}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
	background: var(--bg);
	color: var(--text);
	font: 14px/20px ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace;
	image-rendering: pixelated;
}
h1 { font-size: 16px; margin: 0 0 8px; }
h2 { font-size: 14px; margin: 0 0 8px; color: var(--accent); text-transform: uppercase; letter-spacing: 1px; }
h3 { font-size: 14px; margin: 0 0 4px; }
p { margin: 0 0 8px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.dim { color: var(--dim); }
.small { font-size: 0.85em; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.pixel-card {
	background: var(--surface);
	border: 4px solid var(--border);
	box-shadow: inset -4px -4px 0 0 var(--shadow), inset 4px 4px 0 0 var(--light);
	padding: 12px 16px;
}
button {
	font: inherit;
	color: var(--text);
	background: var(--border);
	border: 0;
	padding: 4px 12px;
	box-shadow: inset -4px -4px 0 0 var(--shadow), inset 4px 4px 0 0 var(--light);
	cursor: pointer;
}
button:hover:not(:disabled):not([aria-disabled="true"]) { background: var(--light); }
button:disabled, button[aria-disabled="true"] { opacity: 0.4; cursor: default; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
	outline: 4px solid var(--accent);
	outline-offset: 0;
}
.btn-primary {
	background: var(--accent);
	color: var(--bg);
	font-weight: 700;
	padding: 4px 16px;
}
.btn-primary:hover:not(:disabled):not([aria-disabled="true"]) { background: var(--text); }
.btn-small {
	background: transparent;
	border: 2px solid var(--border);
	box-shadow: none;
	font-size: 0.85em;
	padding: 2px 6px;
}
.btn-small:hover:not(:disabled) { background: var(--border); }
input[type="checkbox"], input[type="radio"] {
	accent-color: var(--accent);
	width: 16px;
	height: 16px;
	margin: 0;
	flex: none;
}
.close-note {
	border: 4px solid var(--bad);
	padding: 4px 12px;
	background: var(--bg);
	color: var(--text);
	font-size: 0.85em;
}
.step .mark { display: inline-block; width: 16px; text-align: center; }
.step[data-s="done"] .mark { color: var(--hp); }
.step[data-s="current"] { color: var(--accent); font-weight: 700; }
.step[data-s="current"] .mark { color: var(--accent); }
.step[data-s="todo"] { color: var(--dim); }
[hidden] { display: none !important; }

.defs { margin: 0; display: grid; gap: 8px; grid-template-columns: 1fr 1fr; }
.def { background: var(--surface); border: 2px solid var(--border); padding: 8px 12px; cursor: default; }
.def:hover, .def:focus-visible, .def:focus-within { border-color: var(--accent); }
.def dt { color: var(--accent); font-weight: 700; }
.def dd { margin: 0; }

.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.opt {
	display: flex;
	gap: 8px;
	align-items: flex-start;
	background: var(--surface);
	border: 4px solid var(--border);
	padding: 8px 12px;
	cursor: pointer;
}
.opt:hover, .opt:focus-within { border-color: var(--light); }
.opt.selected, .opt:has(input:checked) { border-color: var(--accent); }
.opt.cursor { outline: 2px dotted var(--accent); outline-offset: 2px; }
.opt .txt { flex: 1; min-width: 0; }
.opt .txt b { display: block; }
.opt .ord { display: flex; gap: 4px; align-items: center; }
.pos { color: var(--dim); font-size: 0.85em; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

.bar {
	display: block;
	height: 16px;
	background: var(--shadow);
	box-shadow: inset 4px 4px 0 0 #000;
	overflow: hidden;
	position: relative;
	margin: 8px 0;
}
.bar i {
	position: absolute;
	inset: 0 auto 0 0;
	width: 35%;
	background: repeating-linear-gradient(90deg, var(--accent) 0 8px, var(--shadow) 8px 12px);
	animation: slide 2.4s steps(24) infinite alternate;
}
@keyframes slide { from { left: 0; } to { left: 65%; } }
.progress { background: var(--bg); border: 4px solid var(--border); padding: 12px 16px; margin: 8px 0; }
.status { border: 4px solid var(--hp); background: var(--bg); padding: 8px 12px; margin: 8px 0; }
.alert { border: 4px solid var(--bad); background: var(--bg); padding: 8px 12px; margin: 8px 0; }
.alert h2 { color: var(--text); }
.steps-run { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 4px; }
.steps-run li { display: flex; gap: 8px; }
.steps-run .ok { color: var(--hp); }
.steps-run .ko { color: var(--text); font-weight: 700; }
.steps-run .ko span { color: var(--bad); }
.steps-run .wait { color: var(--dim); }

table.tasks { border-collapse: collapse; width: 100%; margin: 8px 0; }
table.tasks th { color: var(--accent); text-align: left; padding: 4px 8px; border-bottom: 4px solid var(--border); }
table.tasks td { padding: 6px 8px; border-bottom: 4px solid var(--bg); vertical-align: top; }
table.tasks tr:hover td, table.tasks tr:focus-within td { background: var(--surface); }

.narr p { margin: 0 0 8px; }
.review { margin: 0 0 8px; padding-left: 20px; }
.review li { margin: 0 0 2px; }
.closing { border-top: 4px solid var(--border); padding-top: 8px; color: var(--accent); font-weight: 700; }

.diagram { background: var(--bg); border: 4px solid var(--border); padding: 8px; margin: 8px 0; }
.diagram svg { display: block; width: 100%; max-width: 600px; height: auto; }
.dg-node { fill: var(--surface); stroke: var(--border); stroke-width: 4; }
.dg-use { stroke: var(--accent); }
.dg-off { opacity: 0.4; }
.dg-line { stroke: var(--light); stroke-width: 4; fill: none; }
.dg-t { fill: var(--text); font: 14px ui-monospace, Menlo, Consolas, monospace; }
.dg-d { fill: var(--dim); font: 12px ui-monospace, Menlo, Consolas, monospace; }

.cap { display: block; shape-rendering: crispEdges; image-rendering: pixelated; }
.cap .c-out { fill: #221612; }
	.cap .c-fur { fill: #e49958; }
	.cap .c-hi { fill: #f7bb7d; }
	.cap .c-sh { fill: #a55d2c; }
	.cap .c-deep { fill: #753818; }
	.cap .c-snout { fill: #80583e; }
	.cap .c-s-hi { fill: #9d6f50; }
	.cap .c-dark { fill: #1a0b06; }
	.cap .c-glint { fill: #ffffff; }
	.cap .c-s-base { fill: #2f69e6; }
	.cap .c-s-light { fill: #6ea4ff; }
	.cap .c-s-sh { fill: #1a429e; }
	.cap .c-r-neon { fill: #ff2d87; }
	.cap .c-r-light { fill: #ff79b0; }
	.cap .c-r-core { fill: #34071f; }
	.cap .c-r-crim { fill: #6d0d3c; }
	.cap .c-g-neon { fill: #00f5a0; }
	.cap .c-g-dark { fill: #1e5e3a; }
	.cap .c-k-deep { fill: #102d1c; }
.cap .c-dark { fill: #1a0b06; }
.cap .c-glint { fill: #ffffff; }
.cap .c-s-base { fill: #2f69e6; }
.cap .c-s-hi { fill: #6ea4ff; }
.cap .c-s-sh { fill: #1a429e; }
.cap .c-r-neon { fill: #ff2d87; }
.cap .c-r-light { fill: #ff79b0; }
.cap .c-r-core { fill: #34071f; }
.cap .c-r-crim { fill: #6d0d3c; }
.cap .c-g-neon { fill: #00f5a0; }
.cap .c-o { fill: var(--shadow); }
.cap .c-b { fill: var(--accent); }
.cap .c-w { fill: var(--text); }
.cap .c-l { fill: var(--light); }
.cap .c-h { fill: var(--hp); }
.cap .body { animation: breathe 3.2s steps(1) infinite; }
.cap .eye-blink { animation: blink 4.8s steps(1) infinite; }
.cap .sparkle { animation: spark 1.2s steps(2) infinite alternate; }
@keyframes breathe { 0% { transform: translateY(0); } 50% { transform: translateY(-0.5px); } }
@keyframes blink { 0%, 92% { opacity: 1; } 93%, 100% { opacity: 0; } }
@keyframes spark { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }

.star { display: inline-flex; gap: 8px; align-items: center; color: var(--accent); }
.star-row { margin: 12px 0 16px; }

.help h2 { margin-bottom: 4px; }
.help .focus { font-weight: 700; margin: 0 0 8px; color: var(--text); }
.help dl { margin: 0; display: grid; gap: 8px; }
.help dt { color: var(--accent); font-weight: 700; }
.help dd { margin: 0; }
.help .tech { margin: 12px 0 0; padding-top: 8px; border-top: 2px solid var(--border); color: var(--dim); font-size: 0.85em; }

@media (prefers-reduced-motion:reduce) {
	* { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
	.cap *, .bar i { animation: none !important; }
	.bar i { width: 40%; left: 0; }
}

.still .cap *, .still .bar i { animation: none !important; }
.still .bar i { width: 40%; left: 0; }

.app {
	display: grid;
	grid-template-columns: 232px 1fr 384px;
	gap: 16px;
	padding: 16px;
	height: 100vh;
	max-height: 100vh;
	overflow: hidden;
}
.rail { overflow-y: auto; display: flex; flex-direction: column; }
.rail ol { list-style: none; margin: 8px 0 0 8px; padding: 0 0 0 16px; border-left: 4px solid var(--border); display: grid; gap: 12px; }
.rail .step { position: relative; padding-left: 4px; }
.rail .step .mark { position: absolute; left: -30px; top: 0; width: 24px; background: var(--surface); color: var(--dim); }
.rail .step[data-s="done"] .mark { color: var(--hp); }
.rail .step[data-s="current"] .mark { color: var(--accent); }
.rail .stepn { margin-top: auto; padding-top: 16px; color: var(--dim); }

.talk { display: grid; grid-template-rows: auto 1fr auto; gap: 12px; min-width: 0; min-height: 0; }
.guide { display: flex; gap: 16px; align-items: flex-end; }
.guide .who { background: var(--bg); border: 4px solid var(--border); padding: 8px; flex: none; }
.bubble {
	position: relative;
	flex: 1;
	background: var(--text);
	color: var(--bg);
	border: 4px solid var(--shadow);
	padding: 12px 16px;
	margin-bottom: 8px;
	box-shadow: inset -4px -4px 0 0 var(--light);
}
.bubble::before {
	content: "";
	position: absolute;
	left: -12px;
	bottom: 12px;
	width: 12px;
	height: 12px;
	background: var(--text);
	border-left: 4px solid var(--shadow);
	border-bottom: 4px solid var(--shadow);
}
.bubble p { margin: 0; }
.bubble .who-name { font-weight: 700; font-size: 0.85em; margin-bottom: 4px; color: var(--bg); }

.stage { overflow: auto; min-height: 0; background: var(--bg); border: 4px solid var(--border); padding: 12px 16px; position: relative; }
.reply { display: flex; gap: 16px; align-items: center; }
.reply .close-note { flex: 1; }
.nav { display: flex; gap: 8px; flex-shrink: 0; }
.help { overflow-y: auto; }

.wl { display: block; }
.bk { display: grid; grid-template-columns: 1fr; gap: 12px; }
.strats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin: 8px 0; }

@media (max-width: 900px) {
	.app { grid-template-columns: 1fr; height: auto; max-height: none; overflow: visible; }
	.rail, .help { display: none; }
}
`;
}

export function installerPageScript(): string {
	return `(function() {
	var app = document.getElementById("app");
	var view = null;
	var busy = false;
	var timer = null;

	function el(tag, attrs) {
		var n = document.createElement(tag);
		if (attrs) {
			for (var k in attrs) {
				if (k === "class") {
					if (attrs[k]) n.className = attrs[k];
				} else if (k === "text") {
					n.textContent = attrs[k];
				} else if (k === "hidden") {
					if (attrs[k]) n.hidden = true;
				} else if (k === "disabled") {
					if (attrs[k]) n.disabled = true;
				} else if (attrs[k] !== false && attrs[k] !== undefined && attrs[k] !== null) {
					n.setAttribute(k, attrs[k]);
				}
			}
		}
		for (var i = 2; i < arguments.length; i++) {
			var child = arguments[i];
			if (child === null || child === undefined || child === false) continue;
			if (typeof child === "string" || typeof child === "number") {
				n.appendChild(document.createTextNode(String(child)));
			} else if (child.nodeType) {
				n.appendChild(child);
			}
		}
		return n;
	}

	function svg(tag, attrs) {
		var n = document.createElementNS("http://www.w3.org/2000/svg", tag);
		if (attrs) {
			for (var k in attrs) {
				if (k === "class") {
					if (attrs[k]) n.setAttribute("class", attrs[k]);
				} else if (attrs[k] !== false && attrs[k] !== undefined && attrs[k] !== null) {
					n.setAttribute(k, attrs[k]);
				}
			}
		}
		for (var i = 2; i < arguments.length; i++) {
			var child = arguments[i];
			if (child === null || child === undefined || child === false) continue;
			if (typeof child === "string" || typeof child === "number") {
				n.appendChild(document.createTextNode(String(child)));
			} else if (child.nodeType) {
				n.appendChild(child);
			}
		}
		return n;
	}

	function rect(cls, x, y, w, h) {
		return svg("rect", { class: cls, x: x, y: y, width: w, height: h });
	}

	function renderCapybara(pose) {
		var root = svg("svg", {
			class: "cap",
			viewBox: "0 0 32 32",
			width: "160",
			height: "160",
			role: "img",
			"aria-label": view.text.mascot
		});

		var SPRITE = [
					"....G...........#PP#PP#.....G...",
					"...............#PRRPRRP#........",
					"..G...........#PRdDDdRRP#....G..",
					"..............#RdDdRRDdRP#......",
					"..........##..#RdDRPPdDdR###....",
					".........#GG#.#PdDDDDDdRP##GG#..",
					".........#Ggg#.#dRddddRd##gG#...",
					"..........###Ss##dRRRRd###......",
					"...........#sSs#SMdddddSHH#.....",
					".........##sSMMMMMMMMMHHHHH#....",
					"........#sSMMHMMMMMHHHMH#####...",
					".......#sSMMMMMMMMME*MMM#nnnN#..",
					"......#sSMMMHMMMMMMEEMMS#nNNE#..",
					"......#sSMMMMMMMMMMSMMSS#NNNE#..",
					".....#sSMMHMMMMMMMMMSSSs#NNNN#..",
					".....#sSMMMMMMMMMMMMMMsS#ENN#...",
					"....#sSMMHMMMMMLLLBBBBBBZ####...",
					"....#sSMMMMMHMLBBBBWWBBBZSM#....",
					"...#sSMMMHMMMZBBBZWWZZZSMHM#....",
					"...#sSMMMMMMZBLBZ#ZZsSMMHMS#....",
					"..#sSMMHMMMZBBZ#SsSSs#MMHMS#....",
					"..#sSMMMMMHHZZ#SssSss#SMHMS#....",
					"..#sMMHMHHHHHMSsHHMMs#SMHMS#....",
					"..#sSMMHHHMHHMSssHMMM#SMHMS#....",
					"..#sSMMHMHHHMSSssHMMS#SMMMS#....",
					"..#ssSMMMMMMSSssSHMMS#SMMSs#....",
					"g..#ssSSMMMSSsssSHMMS#SMHMS#..g.",
					"gG.#sssSSSSsss#SHMMHM#SMMMSS#Gg.",
					"gG.#ssssssss#EsEsEsEs#EsEsEsE#Gg",
					"Kgg##########################gGK",
					"KKgGgKKgKKKgKKGKKKgKKgKKKgGgKKgK",
					"KKKgKKKKKgKKKKKKKKKKgKKKKKKKKKKK"
		];

		var CLASS_MAP = {
			"#": "c-out",
			"M": "c-fur",
			"O": "c-fur",
			"H": "c-hi",
			"S": "c-sh",
			"s": "c-deep",
			"N": "c-snout",
			"n": "c-s-hi",
			"E": "c-dark",
			"*": "c-glint",
			"b": "c-r-light",
			"B": "c-s-base",
			"L": "c-s-light",
			"Z": "c-s-sh",
			"W": "c-glint",
			"R": "c-r-neon",
			"P": "c-r-light",
			"D": "c-r-core",
			"d": "c-r-crim",
			"G": "c-g-neon",
			"g": "c-g-dark",
			"K": "c-k-deep"
		};

		var body = svg("g", { class: "body" });

		for (var y = 0; y < SPRITE.length; y++) {
			var row = SPRITE[y];
			var x = 0;
			while (x < row.length) {
				var ch = row[x];
				if (ch === "." || !CLASS_MAP[ch]) {
					x++;
					continue;
				}
				var len = 1;
				while (x + len < row.length && row[x + len] === ch) len++;
				body.appendChild(rect(CLASS_MAP[ch], x, y, len, 1));
				x += len;
			}
		}

		var eye = svg("g", { class: "eye" });
		if (pose === "happy") {
			eye.appendChild(rect("c-dark", 19, 11, 2, 1));
			eye.appendChild(rect("c-fur", 19, 12, 2, 1));
			eye.appendChild(rect("c-r-light", 17, 13, 3, 1));
			eye.appendChild(rect("c-g-neon sparkle", 28, 3, 2, 2));
			eye.appendChild(rect("c-r-neon sparkle", 5, 2, 1, 1));
		} else if (pose === "working") {
			eye.appendChild(rect("c-sh", 19, 10, 2, 1));
			eye.appendChild(rect("c-dark", 19, 11, 1, 2));
			eye.appendChild(rect("c-glint", 20, 11, 1, 1));
			eye.appendChild(rect("c-g-neon sparkle", 29, 5, 1, 1));
		} else {
			eye.appendChild(rect("c-dark eye-blink", 19, 11, 1, 1));
			eye.appendChild(rect("c-glint eye-blink", 20, 11, 1, 1));
			eye.appendChild(rect("c-dark", 19, 12, 2, 1));
		}
		body.appendChild(eye);
		root.appendChild(body);

		return root;
	}

	function request(method, action) {
		if (busy && action) return;
		busy = true;
		var options = { method: method };
		if (action) {
			options.headers = { "Content-Type": "application/json" };
			options.body = JSON.stringify(action);
		}
		fetch("/api/installer", options)
			.then(function(res) {
				if (res.status === 409) {
					return res.json().then(function(data) {
						busy = false;
						view = data;
						render();
					});
				}
				if (!res.ok) throw new Error("HTTP " + res.status);
				return res.json().then(function(data) {
					busy = false;
					view = data;
					render();
					schedulePoll();
				});
			})
			.catch(function(err) {
				busy = false;
				renderError(err.message);
			});
	}

	function post(action) {
		request("POST", action);
	}

	function schedulePoll() {
		if (timer) clearTimeout(timer);
		if (view && view.pending) {
			timer = setTimeout(function() { request("GET"); }, 500);
		}
	}

	function renderError(msg) {
		while (app.firstChild) app.removeChild(app.firstChild);
		var card = el("div", { class: "pixel-card alert" },
			el("h2", { text: "Error" }),
			el("p", { text: (view && view.text && view.text.error ? view.text.error.replace("{error}", msg) : msg) }),
			el("div", { class: "row" },
				el("button", { type: "button", class: "btn-primary", text: "Reintentar" }, function() { request("GET"); })
			)
		);
		app.appendChild(card);
	}

	function render() {
		while (app.firstChild) app.removeChild(app.firstChild);
		if (!view) return;

		if (view.finished) {
			if (timer) clearTimeout(timer);
			var isExit = view.outcome === "exit";
			var title = isExit ? (view.text.cancelled || "Instalación cancelada") : (view.text.closed || "Instalación terminada");
			var msg = isExit ? (view.text.cancelledHint || view.text.closed) : (view.outcome === "panel" ? view.text.panel : view.outcome === "advanced" ? view.text.advanced : view.text.closed);

			var container = el("div", { class: "app" + (view.reduceMotion ? " still" : "") },
				el("div", { class: "talk", style: "max-width: 600px; margin: 40px auto; text-align: center;" },
					el("div", { class: "who", style: "margin: 0 auto 16px auto;" }, renderCapybara(isExit ? "idle" : "happy")),
					el("div", { class: "pixel-card", style: "padding: 24px;" },
						el("h2", { text: title, style: "margin-bottom: 12px;" }),
						el("p", { text: msg, style: "color: var(--muted); margin-bottom: 8px;" })
					)
				)
			);
			app.appendChild(container);
			return;
		}

		var screen = view.screen;
		var container = el("div", { class: "app" + (view.reduceMotion ? " still" : "") });

		// 1. LEFT RAIL
		var rail = el("nav", { class: "rail pixel-card", "aria-label": view.text.steps });
		rail.appendChild(el("h2", { text: view.text.steps }));
		var stepList = el("ol");
		(screen.sidebar || []).forEach(function(s, i) {
			var mark = s.status === "done" ? "✓" : s.status === "current" ? "●" : "○";
			var item = el("li", { class: "step", "data-i": i, "data-s": s.status },
				el("span", { class: "mark", "aria-hidden": "true", text: mark }),
				el("span", { text: s.label })
			);
			stepList.appendChild(item);
		});
		rail.appendChild(stepList);
		rail.appendChild(el("p", { class: "stepn", "aria-hidden": "true", text: view.text.stepOf }));
		container.appendChild(rail);

		// 2. MIDDLE TALK AREA
		var talk = el("div", { class: "talk" });

		// Guide mascot & bubble
		var guideSec = el("section", { class: "guide", "aria-label": view.text.guideName });
		var who = el("div", { class: "who" });
		who.appendChild(renderCapybara(view.pose));
		guideSec.appendChild(who);

		var speechText = "";
		if (screen.error) {
			speechText = screen.error.summary || screen.error.what || "";
		} else if (screen.pending) {
			speechText = screen.pending.label || "";
		} else if (screen.confirmation) {
			speechText = screen.confirmation;
		} else if (screen.body && screen.body.length > 0) {
			speechText = screen.body[0];
		} else {
			speechText = screen.title;
		}

		var bubble = el("div", { class: "bubble", role: "status", "aria-live": "polite" },
			el("div", { class: "who-name", text: view.text.guideName }),
			el("p", { id: "bubble", text: speechText })
		);
		guideSec.appendChild(bubble);
		talk.appendChild(guideSec);

		// Main stage
		var stage = el("main", { class: "stage", tabindex: "0", "aria-label": screen.title });

		// Pending progress indicator
		if (screen.pending) {
			var prog = el("div", { class: "progress" },
				el("p", { text: screen.pending.label }),
				el("div", { class: "bar" }, el("i")),
				el("p", { class: "dim small", text: view.text.elapsed.replace("{seconds}", Math.max(1, Math.round((Date.now() - screen.pending.startedAt) / 1000))) })
			);
			stage.appendChild(prog);
		}

		// Confirmation status box
		if (screen.confirmation) {
			var conf = el("div", { class: "status" },
				el("p", { text: screen.confirmation })
			);
			stage.appendChild(conf);
		}

		// Welcome stage
		if (screen.welcome) {
			var wl = el("div", { class: "wl" });
			var wlMain = el("div", { class: "wl-main" });
			(screen.body || []).forEach(function(b) {
				wlMain.appendChild(el("p", { text: b }));
			});
			if (screen.welcome.willDo && screen.welcome.willDo.length > 0) {
				wlMain.appendChild(el("h2", { text: screen.welcome.willDoTitle }));
				var willDoList = el("ol", { class: "review" });
				screen.welcome.willDo.forEach(function(item) {
					willDoList.appendChild(el("li", { text: item }));
				});
				wlMain.appendChild(willDoList);
			}
			wl.appendChild(wlMain);

			if (screen.welcome.star) {
				var starLink = el("a", { class: "star", href: screen.welcome.star.url, target: "_blank", rel: "noopener" },
					el("span", { text: "★ " + screen.welcome.star.text })
				);
				wl.appendChild(el("p", { class: "star-row" }, starLink));
			}

			if (screen.welcome.definitions && screen.welcome.definitions.length > 0) {
				wl.appendChild(el("h2", { text: screen.welcome.definitionsTitle }));
				var defs = el("dl", { class: "defs" });
				screen.welcome.definitions.forEach(function(d) {
					var defItem = el("div", { class: "def", tabindex: "0" },
						el("dt", { text: d.term }),
						el("dd", { text: d.text })
					);
					defs.appendChild(defItem);
				});
				wl.appendChild(defs);
			}
			stage.appendChild(wl);
		}

		// Backups detail & strategy
		if (screen.backupDetail) {
			var bkBox = el("div", { class: "bk" });
			var stratBox = el("div", { class: "strats", role: "radiogroup", "aria-label": "Estrategia" });
			(screen.backupDetail.methods || []).forEach(function(m) {
				var opt = el("label", { class: "opt" + (m.selected ? " selected" : "") });
				var radio = el("input", { type: "radio", name: "backup-method", value: m.id });
				if (m.selected) radio.checked = true;
				radio.addEventListener("change", function() {
					post({ type: "button", id: "cycle-method" });
				});
				opt.appendChild(radio);
				opt.appendChild(el("span", { class: "txt" },
					el("b", { text: m.label }),
					el("span", { class: "small dim", text: m.description })
				));
				stratBox.appendChild(opt);
			});
			bkBox.appendChild(stratBox);
			stage.appendChild(bkBox);
		}

		// Diagram
		if (screen.diagram) {
			var diag = el("div", { class: "diagram" });
			var rows = Math.max(1, screen.diagram.members.length);
			var diagHeight = 20 + rows * 54;
			var middle = diagHeight / 2;
			var rootSvg = svg("svg", {
				class: "diagram",
				viewBox: "0 0 800 " + diagHeight,
				width: "800",
				height: String(diagHeight),
				role: "img",
				"aria-label": view.text.diagram
			});
			rootSvg.appendChild(svg("title", {}, view.text.diagram));

			var addNode = function(x, y, w, cls, label, sub) {
				rootSvg.appendChild(svg("rect", { class: "dg-node " + cls, x: x, y: y - 22, width: w, height: 44, rx: 4 }));
				rootSvg.appendChild(svg("text", { class: "dg-t", x: x + 10, y: sub ? y - 2 : y + 5 }, label));
				if (sub) rootSvg.appendChild(svg("text", { class: "dg-d", x: x + 10, y: y + 14 }, sub));
			};

			addNode(8, middle, 130, "dg-use", screen.diagram.agent);
			addNode(190, middle, 150, "dg-use", screen.diagram.backup);
			rootSvg.appendChild(svg("path", { class: "dg-line", d: "M138 " + middle + " H190" }));

			screen.diagram.members.forEach(function(m, i) {
				var y = 10 + 27 + i * 54;
				rootSvg.appendChild(svg("path", { class: "dg-line", d: "M340 " + middle + " H365 V" + y + " H390" }));
				addNode(390, y, 402, m.state === "active" ? "dg-use" : "dg-off", m.order + ". " + m.label, view.text.members[i]);
			});
			diag.appendChild(rootSvg);
			stage.appendChild(diag);
		}

		// Controls
		if (screen.control) {
			var ctrl = screen.control;
			if (ctrl.kind === "choice" || ctrl.kind === "checklist") {
				var list = el("div", { class: "list" });
				(ctrl.items || []).forEach(function(c, i) {
					var isChecked = ctrl.kind === "checklist" ? c.checked : i === ctrl.selected;
					var isCursor = i === screen.cursor;
					var optClass = "opt" + (isChecked ? " selected" : "") + (isCursor ? " cursor" : "");
					var opt = el("div", { class: optClass, tabindex: "0" });

					var input = el("input", {
						type: ctrl.kind === "checklist" ? "checkbox" : "radio",
						name: "installer-control"
					});
					if (isChecked) input.checked = true;
					opt.appendChild(input);

					var txt = el("span", { class: "txt" });
					txt.appendChild(el("b", { text: c.label }));
					if (c.description) {
						txt.appendChild(el("span", { class: "small dim", text: c.description }));
					}
					opt.appendChild(txt);

					if (ctrl.kind === "checklist" && typeof c.order === "number") {
						var ord = el("span", { class: "ord" },
							el("span", { class: "pos", text: "#" + c.order })
						);
						opt.appendChild(ord);
					}

					if (c.openable) {
						var openBtn = el("button", { type: "button", class: "btn-small", text: view.text.change });
						openBtn.addEventListener("click", function(ev) {
							ev.stopPropagation();
							post({ type: "open", index: i });
						});
						opt.appendChild(openBtn);
					}

					opt.addEventListener("click", function() {
						if (ctrl.kind === "checklist") {
							post({ type: "toggle", index: i });
						} else {
							post({ type: "select", index: i });
						}
					});

					list.appendChild(opt);
				});
				stage.appendChild(list);
			} else if (ctrl.kind === "progress") {
				var progList = el("ul", { class: "steps-run" });
				(ctrl.items || []).forEach(function(item) {
					var cls = item.status === "done" ? "ok" : item.status === "error" ? "ko" : "wait";
					var icon = item.status === "done" ? "✓" : item.status === "error" ? "✗" : "○";
					var li = el("li", { class: cls },
						el("span", { text: icon }),
						el("span", { text: item.label })
					);
					progList.appendChild(li);
				});
				stage.appendChild(progList);
			}
		}

		// Summary narrative & detail
		if (screen.summary) {
			var narr = el("div", { class: "narr" });
			narr.appendChild(el("p", { text: screen.summary.narrative }));
			if (screen.summary.review) {
				narr.appendChild(el("p", { class: "dim small", text: screen.summary.review }));
			}
			if (screen.summary.detail && screen.summary.detail.length > 0) {
				var revList = el("ul", { class: "review" });
				screen.summary.detail.forEach(function(d) {
					revList.appendChild(el("li", { text: d }));
				});
				narr.appendChild(revList);
			}
			if (screen.summary.closing) {
				narr.appendChild(el("p", { class: "closing", text: screen.summary.closing }));
			}
			stage.appendChild(narr);
		}

		// Stage error / message
		if (screen.error) {
			var alertBox = el("div", { class: "alert", role: "alert" },
				el("h2", { text: screen.error.summary || "Error" }),
				el("p", { text: screen.error.what || "" })
			);
			if (screen.error.why) alertBox.appendChild(el("p", { class: "dim small", text: screen.error.why }));
			stage.appendChild(alertBox);
		}

		talk.appendChild(stage);

		// Reply bar: close-note + buttons
		var reply = el("div", { class: "reply" });
		if (screen.notice) {
			reply.appendChild(el("div", { class: "close-note", role: "note", text: screen.notice }));
		} else {
			reply.appendChild(el("div", { class: "close-note", role: "note", hidden: true }));
		}

		var nav = el("nav", { class: "nav", "aria-label": "Acciones del paso" });
		var helpBtn = el("button", {
			type: "button",
			"aria-expanded": screen.helpOpen ? "true" : "false",
			text: "? " + view.text.help
		});
		helpBtn.addEventListener("click", function() { post({ type: "help" }); });
		nav.appendChild(helpBtn);

		(screen.buttons || []).forEach(function(b) {
			var btnClass = b.primary ? "btn-primary" : "";
			var label = b.id === "back" ? "◀ " + b.label : b.id === "next" ? b.label + " ▶" : b.label;
			var btn = el("button", {
				type: "button",
				class: btnClass,
				text: label,
				disabled: !b.enabled
			});
			btn.addEventListener("click", function() {
				post({ type: "button", id: b.id });
			});
			nav.appendChild(btn);
		});
		reply.appendChild(nav);
		talk.appendChild(reply);

		container.appendChild(talk);

		// 3. RIGHT HELP RAIL
		var helpAside = el("aside", { class: "help pixel-card", "aria-label": view.text.help });
		helpAside.appendChild(el("h2", { text: view.text.help }));

		var focusTechName = (screen.help && screen.help.focus && screen.help.focus.technicalName) || (screen.help && screen.help.technicalName) || "";
		helpAside.appendChild(el("div", { class: "focus", text: focusTechName }));

		var helpDl = el("dl");
		var whatText = (screen.help && screen.help.focus && screen.help.focus.what) || (screen.help && screen.help.text) || "";
		var purposeText = (screen.help && screen.help.focus && screen.help.focus.purpose) || (screen.help && screen.help.purpose) || "";
		var ifPickedText = (screen.help && screen.help.focus && screen.help.focus.ifPicked) || (screen.help && screen.help.ifPicked) || "";

		if (whatText) {
			helpDl.appendChild(el("dt", { text: view.text.helpWhat }));
			helpDl.appendChild(el("dd", { text: whatText }));
		}
		if (purposeText) {
			helpDl.appendChild(el("dt", { text: view.text.helpPurpose }));
			helpDl.appendChild(el("dd", { text: purposeText }));
		}
		if (ifPickedText) {
			helpDl.appendChild(el("dt", { text: view.text.helpIf }));
			helpDl.appendChild(el("dd", { text: ifPickedText }));
		}
		helpAside.appendChild(helpDl);

		var techBox = el("div", { class: "tech" });
		techBox.appendChild(el("p", { text: view.text.helpName }));
		techBox.appendChild(el("p", { text: view.text.helpFile }));
		helpAside.appendChild(techBox);

		container.appendChild(helpAside);

		app.appendChild(container);
	}

	// Keyboard controls matching terminal installer
	document.addEventListener("keydown", function(press) {
		if (!view || view.finished || press.ctrlKey || press.metaKey || press.altKey) return;
		var tag = press.target && press.target.tagName;
		var screen = view.screen;
		var primary = (screen.buttons || []).find(function(b) { return b.primary && b.enabled; });
		var kind = screen.control ? screen.control.kind : null;
		var stop = function() { press.preventDefault(); };

		switch (press.key) {
			case "ArrowUp":
			case "ArrowDown":
				stop();
				post({ type: "move", delta: press.key === "ArrowUp" ? -1 : 1 });
				break;
			case "ArrowLeft":
				stop();
				post({ type: "back" });
				break;
			case "ArrowRight":
				stop();
				post({ type: "next" });
				break;
			case "?":
				post({ type: "help" });
				break;
			case "Escape":
				post({ type: "cancel" });
				break;
			case " ":
				if (tag === "BUTTON" || tag === "INPUT") break;
				stop();
				if (kind === "checklist") post({ type: "toggle", index: screen.cursor });
				else if (kind === "choice") post({ type: "select", index: screen.cursor });
				break;
			case "Enter":
				if (tag === "BUTTON") break;
				stop();
				if (kind === "choice") post({ type: "select", index: screen.cursor });
				else if (kind === "checklist" && screen.control.openable) post({ type: "open", index: screen.cursor });
				else if (primary) post({ type: "button", id: primary.id });
				break;
		}
	});

	request("GET");
})();
`;
}
