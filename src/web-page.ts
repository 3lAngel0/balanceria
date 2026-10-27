// The live web report page. The server's CSP allows only same-origin script
// and style, so the HTML carries no inline code: the script and the style are
// served as /app.js and /app.css. Session names are user text (first
// messages), so the script builds every node with textContent, never HTML.

export const WEB_REFRESH_MS = 5_000;

export function webPageHtml(): string {
	return pageHtml({
		title: "live report",
		head: `<link rel="stylesheet" href="/app.css">
	<script src="/app.js" defer></script>`,
		status: "connecting...",
		tail: "",
	});
}

export interface WebSnapshot {
	report: unknown;
	/** Session details by id; the overview links to these. */
	sessions: Record<string, unknown>;
}

/**
 * The same page as one file to keep or share: style and script inline, the
 * data as JSON the script reads. No server and no CSP header apply to a file,
 * so the JSON escapes `<`: nothing in it can close the tag or start markup.
 */
export function webSnapshotHtml(snapshot: WebSnapshot): string {
	const data = JSON.stringify(snapshot).replace(/</g, "\\u003c");
	return pageHtml({
		title: "snapshot",
		head: `<style>${webPageStyle()}</style>`,
		status: "snapshot",
		tail: `<script type="application/json" id="snapshot-data">${data}</script>
	<script>${webPageScript({ snapshot: true })}</script>
`,
	});
}

function pageHtml(parts: { title: string; head: string; status: string; tail: string }): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>ai-balancer // ${parts.title}</title>
	${parts.head}
</head>
<body>
	<header class="topbar">
		<a class="brand" href="#/">AI-BALANCER // ${parts.title.toUpperCase()}</a>
		<span id="status" class="status">${parts.status}</span>
	</header>
	<main id="app" aria-live="polite"></main>
	<noscript>This report needs JavaScript.</noscript>
	${parts.tail}</body>
</html>
`;
}

export function webPageStyle(): string {
	return `:root {
	--bg-deep: #0e0c15;
	--bg-card: #181425;
	--bg-card-alt: #26213b;
	--border-dark: #3f3f74;
	--border-light: #5b6ee1;
	--text-main: #f4f4f4;
	--text-dim: #8b9bb4;
	--accent-hp: #38b764;
	--accent-hp-low: #f77622;
	--accent-hp-crit: #b13e53;
	--accent-mp: #3b5dc9;
	--accent-gold: #f4b41b;
}
* { box-sizing: border-box; }
body {
	margin: 0;
	background: var(--bg-deep);
	color: var(--text-main);
	font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace;
	font-size: 14px;
	line-height: 1.4;
}
a { color: var(--border-light); }
.topbar {
	position: sticky;
	top: 0;
	z-index: 2;
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 10px 24px;
	background: var(--bg-card);
	border-bottom: 4px solid var(--border-dark);
}
.brand { color: var(--accent-gold); font-weight: bold; text-decoration: none; letter-spacing: 1px; text-shadow: 2px 2px 0 #000; }
.status { color: var(--accent-hp); }
.status.offline { color: var(--accent-hp-crit); }
main { padding: 24px; max-width: 1400px; margin: 0 auto; }
.pixel-box {
	background: var(--bg-card);
	border: 4px solid var(--border-dark);
	box-shadow: inset -4px -4px 0 0 #0f0c1b, inset 4px 4px 0 0 var(--border-light);
	padding: 16px;
	margin-bottom: 24px;
	overflow-x: auto;
}
h1, h2, h3 { margin: 0 0 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--accent-gold); text-shadow: 2px 2px 0 #000; }
h1 { font-size: 20px; }
h2 { font-size: 16px; }
h3 { font-size: 14px; margin-top: 16px; }
.dim { color: var(--text-dim); }
.badges { display: flex; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
.badge { padding: 4px 8px; background: var(--bg-card-alt); border: 2px solid var(--border-dark); font-size: 12px; }
.badge.gold { border-color: var(--accent-gold); color: var(--accent-gold); }
.badge.alert { background: #7a1c2d; border-color: #e43b44; }
.decision { margin: 6px 0; padding: 6px 8px; background: var(--bg-card-alt); border: 2px solid var(--border-dark); }
.decision summary { cursor: pointer; }
.decision ol, .decision ul { margin: 6px 0 0 18px; padding: 0; }
.gauge-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.gauge { background: var(--bg-card-alt); border: 2px solid var(--border-dark); padding: 10px; }
.gauge-label { display: flex; justify-content: space-between; font-weight: bold; margin-bottom: 6px; }
.meter-track { height: 18px; background: #0b0914; border: 2px solid var(--border-dark); padding: 2px; }
.meter-fill { height: 100%; background: repeating-linear-gradient(90deg, var(--accent-hp) 0 8px, #268545 8px 10px); }
.meter-fill.warn { background: repeating-linear-gradient(90deg, var(--accent-hp-low) 0 8px, #ab4e10 8px 10px); }
.meter-fill.crit { background: repeating-linear-gradient(90deg, var(--accent-hp-crit) 0 8px, #751d2f 8px 10px); }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 2px solid var(--border-dark); white-space: nowrap; }
td.name { white-space: normal; min-width: 240px; }
th { background: var(--bg-card-alt); color: var(--accent-gold); }
td.num, th.num { text-align: right; }
tr.link { cursor: pointer; }
tr.link:hover td, tr.link:focus td { background: rgba(91, 110, 225, 0.18); outline: none; }
tr.current td:first-child { border-left: 4px solid var(--accent-hp); }
ul.suggestions { margin: 0; padding-left: 18px; }
ul.suggestions li { margin: 4px 0; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 12px 0; }
code.command { display: block; padding: 8px 10px; background: #0b0914; border: 2px solid var(--border-dark); white-space: pre-wrap; word-break: break-all; user-select: all; }
button {
	background: var(--bg-card-alt);
	color: var(--text-main);
	border: 2px solid var(--border-light);
	box-shadow: 2px 2px 0 0 #000;
	padding: 8px 14px;
	cursor: pointer;
	font-family: inherit;
	font-size: 13px;
}
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.danger { border-color: var(--accent-hp-low); }
.notice { padding: 8px 10px; border: 2px solid var(--accent-gold); margin-bottom: 16px; }
.notice.error { border-color: var(--accent-hp-crit); }
`;
}

/** The live page polls the server; a snapshot reads the data embedded in the file. */
export function webPageScript(options: { snapshot?: boolean } = {}): string {
	return `"use strict";
(function () {
	var REFRESH_MS = ${WEB_REFRESH_MS};
	var SNAPSHOT = ${options.snapshot ? 'JSON.parse(document.getElementById("snapshot-data").textContent)' : "null"};
	var OPTIONS = { credentials: "same-origin", cache: "no-store" };
	var app = document.getElementById("app");
	var statusEl = document.getElementById("status");
	var lastOk = 0;
	var offline = "";
	var notice = null;

	function h(tag, props, children) {
		var el = document.createElement(tag);
		var key;
		for (key in props || {}) {
			var value = props[key];
			if (value === undefined || value === null || value === false) continue;
			if (key === "className") el.className = value;
			else if (key === "text") el.textContent = value;
			else if (key.slice(0, 2) === "on") el.addEventListener(key.slice(2), value);
			else el.setAttribute(key, value === true ? "" : String(value));
		}
		(children || []).forEach(function (child) {
			if (child === null || child === undefined || child === false) return;
			el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
		});
		return el;
	}

	function tokens(n) {
		if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
		if (n >= 1000) return (n / 1000).toFixed(1) + "k";
		return String(n);
	}
	function usd(n) {
		if (n <= 0) return "$0";
		if (n < 0.01) return "<$0.01";
		if (n < 100) return "$" + n.toFixed(2);
		return "$" + Math.round(n);
	}
	function ago(ts) {
		var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
		if (s < 60) return s + "s ago";
		if (s < 3600) return Math.round(s / 60) + "m ago";
		if (s < 86400) return Math.round(s / 3600) + "h ago";
		return Math.round(s / 86400) + "d ago";
	}
	function when(ts) { return ts ? new Date(ts).toLocaleString() : "-"; }
	function label(s) { return s.alias || s.session.slice(0, 8); }
	function sessionHref(id) { return "#/session/" + encodeURIComponent(id); }
	function goSession(id) { location.hash = sessionHref(id); }

	function routeId() {
		var match = /^#\\/session\\/(.+)$/.exec(location.hash);
		return match ? decodeURIComponent(match[1]) : null;
	}

	function linkRow(cells, id, extraClass) {
		return h("tr", {
			className: "link" + (extraClass ? " " + extraClass : ""),
			tabindex: 0,
			onclick: function () { goSession(id); },
			onkeydown: function (event) { if (event.key === "Enter") goSession(id); },
		}, cells);
	}
	function td(value, className) { return h("td", { className: className, text: String(value) }); }
	function th(value, className) { return h("th", { className: className, text: value }); }

	function render(nodes) {
		while (app.firstChild) app.removeChild(app.firstChild);
		if (notice) app.appendChild(h("div", { className: "notice" + (notice.error ? " error" : ""), text: notice.text }));
		nodes.forEach(function (node) { if (node) app.appendChild(node); });
	}

	function updateStatus() {
		if (SNAPSHOT) {
			statusEl.textContent = "SNAPSHOT · taken " + when(Date.parse(SNAPSHOT.report.generatedAt)) + " · read-only";
			statusEl.className = "status";
		} else if (offline) {
			statusEl.textContent = "OFFLINE: " + offline;
			statusEl.className = "status offline";
		} else if (lastOk) {
			statusEl.textContent = "LIVE · updated " + ago(lastOk) + " · every " + REFRESH_MS / 1000 + "s";
			statusEl.className = "status";
		}
	}

	function meter(percent) {
		var fill = h("div", { className: "meter-fill" + (percent >= 90 ? " crit" : percent >= 70 ? " warn" : "") });
		fill.style.width = Math.max(0, Math.min(100, percent)) + "%";
		return h("div", { className: "meter-track" }, [fill]);
	}

	function overview(report) {
		var header = h("section", { className: "pixel-box" }, [
			h("h1", { text: "Consumption overview" }),
			h("div", { className: "badges" }, [
				h("span", { className: "badge gold", text: "30d tokens: " + tokens(report.totals.tokens) }),
				h("span", { className: "badge", text: "API value: " + usd(report.totals.cost) }),
				h("span", { className: "badge", text: "Requests: " + report.totals.requests }),
				report.current ? h("span", { className: "badge", text: "Current model: " + (report.current.model || "-") }) : null,
				report.current && report.current.contextTokens !== null ? h("span", { className: "badge", text: "Context: " + tokens(report.current.contextTokens) + " / " + tokens(report.current.contextWindow || 0) }) : null,
				report.circuit && report.circuit.tripped ? h("span", { className: "badge alert", text: "CIRCUIT OPEN: " + (report.circuit.reason || report.circuit.poolId || "all pools spent") }) : null,
			]),
			h("div", { className: "dim", text: "Generated " + when(Date.parse(report.generatedAt)) }),
		]);

		var quota = report.quota.length === 0 ? null : h("section", { className: "pixel-box" }, [
			h("h2", { text: "Subscription windows" }),
			h("div", { className: "gauge-grid" }, report.quota.map(function (q) {
				return h("div", { className: "gauge" }, [
					h("div", { className: "gauge-label" }, [h("span", { text: q.limit + " · " + q.window }), h("span", { text: Math.round(q.usedPercent) + "%" })]),
					meter(q.usedPercent),
					h("div", { className: "dim", text: (q.stale ? "reset since last read · " : "") + "read " + ago(q.ts) + (q.resetAt ? " · resets " + when(q.resetAt) : "") }),
				]);
			})),
		]);

		var suggestions = report.suggestions.length === 0 ? null : h("section", { className: "pixel-box" }, [
			h("h2", { text: "Suggestions" }),
			h("ul", { className: "suggestions" }, report.suggestions.map(function (s) {
				return h("li", {}, [s.session ? h("a", { href: sessionHref(s.session), text: s.title }) : s.title]);
			})),
		]);

		var decisions = decisionsSection(report.decisions);

		var sessions = h("section", { className: "pixel-box" }, [h("h2", { text: "Sessions by role // last 7 days" }), h("div", { className: "dim", text: "Click a session for its detail, the shell command to resume it, or to open it in Pi." })]);
		report.roles.forEach(function (role) {
			sessions.appendChild(h("h3", { text: role.role + " · " + tokens(role.total) + " tokens · " + role.requests + " requests" }));
			sessions.appendChild(h("table", {}, [
				h("thead", {}, [h("tr", {}, [th("Session"), th("Project"), th("Req", "num"), th("Context resend", "num"), th("New output", "num"), th("Total", "num"), th("Last")])]),
				h("tbody", {}, role.sessions.map(function (s) {
					var name = label(s) + (s.isCurrent ? "  [current]" : "") + (s.parentSession ? "  [subagent]" : "");
					return linkRow([td(name, "name"), td(s.project), td(s.requests, "num"), td(tokens(s.contextResend), "num"), td(tokens(s.newOutput), "num"), td(tokens(s.total), "num"), td(ago(s.lastTs))], s.session, s.isCurrent ? "current" : "");
				})),
			]));
		});

		var providers = h("section", { className: "pixel-box" }, [
			h("h2", { text: "Providers // 30 days" }),
			h("table", {}, [
				h("thead", {}, [h("tr", {}, [th("Provider"), th("Req", "num"), th("Input", "num"), th("Output", "num"), th("Cache read", "num"), th("Cache write", "num"), th("Total", "num"), th("API USD", "num")])]),
				h("tbody", {}, report.providers.map(function (p) {
					return h("tr", {}, [td(p.provider), td(p.requests, "num"), td(tokens(p.input), "num"), td(tokens(p.output), "num"), td(tokens(p.cacheRead), "num"), td(tokens(p.cacheWrite), "num"), td(tokens(p.total), "num"), td(usd(p.cost), "num")]);
				})),
			]),
		]);

		render([header, quota, suggestions, decisions, sessions, providers]);
	}

	// Why each pool chose its provider: rule counts, role to provider, and the
	// newest decisions, each expanding to its rule steps and candidates.
	function decisionsSection(d) {
		var box = h("section", { className: "pixel-box" }, [h("h2", { text: "Routing decisions // why each pool chose its provider" })]);
		if (!d || d.total === 0) {
			box.appendChild(h("div", { className: "dim", text: "No routing decisions yet. A row appears when a pool's provider or deciding rule changes in a session." }));
			return box;
		}
		box.appendChild(h("div", { className: "badges" }, d.byRule.map(function (r) {
			return h("span", { className: "badge", text: r.rule + ": " + r.count });
		})));
		box.appendChild(h("table", {}, [
			h("thead", {}, [h("tr", {}, [th("Role → pool → provider"), th("Decisions", "num")])]),
			h("tbody", {}, d.byRole.map(function (r) {
				return h("tr", {}, [td(r.role + " → " + r.pool + " → " + r.chosen, "name"), td(r.count, "num")]);
			})),
		]));
		box.appendChild(h("h3", { text: "Newest decisions" + (d.omitted ? " (" + d.omitted + " older not shown)" : "") }));
		d.recent.forEach(function (r) {
			var role = r.role === "subagent" ? "subagent (agent unknown)" : r.role;
			box.appendChild(h("details", { className: "decision" }, [
				h("summary", { text: when(r.ts) + " · " + role + " → " + r.pool + " → " + r.chosen + " · decided by " + r.decidedBy }),
				h("div", { className: "dim", text: r.project + " · session " + r.session + " · " + r.reason + (r.contextTokens !== null ? " · context " + tokens(r.contextTokens) : "") }),
				h("ol", {}, r.steps.map(function (s) {
					return h("li", { text: s.rule + ": " + s.result + " — " + s.why });
				})),
				r.switchCost ? h("div", { className: "dim", text: switchCostText(r.switchCost) }) : null,
				r.switchCost ? h("div", { text: "advice: " + r.switchCost.advice.action + " — " + r.switchCost.advice.why }) : null,
				h("ul", {}, r.candidates.map(function (c) {
					var state = c.available ? "available" : "spent until " + when(c.availableAt);
					var left = typeof c.remaining === "number" ? " · " + Math.round(c.remaining * 100) + "% left" : "";
					return h("li", { text: c.quotaKey + " · " + state + left });
				})),
			]));
		});
		return box;
	}

	// What the move cost: the context read from cache on the old provider
	// against the same context sent and cached again on the new one.
	function switchCostText(c) {
		function windows(list) {
			if (!list.length) return "";
			return " (" + list.map(function (w) {
				return w.key + " " + w.window + " " + (w.percent === null ? "not calibrated" : w.percent.toFixed(2) + "%");
			}).join(", ") + ")";
		}
		return "moved from " + c.from + ": staying " + tokens(c.stayTokens) + " weighted tokens" + windows(c.stay) + " · moving " + tokens(c.switchTokens) + windows(c.switch);
	}

	function copy(text) {
		navigator.clipboard.writeText(text).then(function () {
			notice = { text: "Command copied. Paste it in a terminal on this machine." };
			refresh();
		}, function () {
			notice = { text: "Copy was blocked by the browser: select the command and copy it by hand.", error: true };
			refresh();
		});
	}

	function openInPi(d, button) {
		var question = "Switch the running Pi to \\"" + label(d) + "\\"?\\n\\nPi waits until it is idle, so no turn is cut.";
		if (!confirm(question)) return;
		button.disabled = true;
		fetch("/api/sessions/" + encodeURIComponent(d.session) + "/open", { method: "POST", credentials: "same-origin", cache: "no-store" })
			.then(function (res) { return res.json().catch(function () { return { ok: false, message: "HTTP " + res.status }; }); })
			.then(function (body) { notice = { text: body.message, error: !body.ok }; refresh(); })
			.catch(function (error) { notice = { text: "Could not reach Pi: " + error.message, error: true }; refresh(); });
	}

	function detail(id, d) {
		var back = h("p", {}, [h("a", { href: "#/", text: "<- all sessions" })]);
		if (!d) {
			render([back, h("section", { className: "pixel-box" }, [h("h1", { text: "Unknown session" }), h("p", { className: "dim", text: id + " has no recorded requests and no session file." })])]);
			return;
		}
		var openButton = h("button", {
			className: "danger",
			disabled: SNAPSHOT || !d.canOpen || d.isCurrent,
			title: SNAPSHOT ? "A snapshot cannot switch Pi; use the live web report (/balancer serve)" : d.isCurrent ? "This is the session Pi has open" : d.canOpen ? "Switch the running Pi to this session" : "No session file found",
			text: d.isCurrent ? "Open in Pi (already open)" : "Open in Pi",
		});
		if (!SNAPSHOT) openButton.addEventListener("click", function () { openInPi(d, openButton); });

		var head = h("section", { className: "pixel-box" }, [
			h("h1", { text: label(d) }),
			h("div", { className: "badges" }, [
				h("span", { className: "badge gold", text: d.role }),
				d.project ? h("span", { className: "badge", text: "project: " + d.project }) : null,
				d.isCurrent ? h("span", { className: "badge", text: "open in Pi now" }) : null,
				h("span", { className: "badge", text: "id: " + d.session }),
			]),
			d.parentSession ? h("p", {}, ["Launched by ", h("a", { href: sessionHref(d.parentSession), text: d.parentSession.slice(0, 8) })]) : null,
			h("div", { className: "badges" }, [
				h("span", { className: "badge", text: "Requests: " + d.totals.requests }),
				h("span", { className: "badge", text: "Context resend: " + tokens(d.totals.contextResend) }),
				h("span", { className: "badge", text: "New output: " + tokens(d.totals.newOutput) }),
				h("span", { className: "badge gold", text: "Total: " + tokens(d.totals.total) }),
				h("span", { className: "badge", text: "First: " + when(d.firstTs) }),
				h("span", { className: "badge", text: "Last: " + when(d.lastTs) }),
			]),
		]);

		var actions = h("section", { className: "pixel-box" }, [
			h("h2", { text: "Go to this session" }),
			d.resume ? h("code", { className: "command", text: d.resume }) : h("p", { className: "dim", text: "No session file found, so it cannot be resumed." }),
			h("div", { className: "actions" }, [
				d.resume ? h("button", { text: "Copy shell command", onclick: function () { copy(d.resume); } }) : null,
				openButton,
			]),
			d.path ? h("div", { className: "dim", text: "File: " + d.path }) : null,
			d.cwd ? h("div", { className: "dim", text: "Directory: " + d.cwd }) : null,
		]);

		var models = d.models.length === 0 ? null : h("section", { className: "pixel-box" }, [
			h("h2", { text: "By model" }),
			h("table", {}, [
				h("thead", {}, [h("tr", {}, [th("Provider"), th("Model"), th("Req", "num"), th("Total", "num")])]),
				h("tbody", {}, d.models.map(function (m) { return h("tr", {}, [td(m.provider), td(m.model), td(m.requests, "num"), td(tokens(m.total), "num")]); })),
			]),
		]);

		var children = d.children.length === 0 ? null : h("section", { className: "pixel-box" }, [
			h("h2", { text: "Subagents it launched" }),
			h("table", {}, [
				h("thead", {}, [h("tr", {}, [th("Task"), th("Agent"), th("Req", "num"), th("Total", "num")])]),
				h("tbody", {}, d.children.map(function (c) { return linkRow([td(c.label || c.session.slice(0, 8), "name"), td(c.agent), td(c.requests, "num"), td(tokens(c.total), "num")], c.session); })),
			]),
		]);

		var requests = h("section", { className: "pixel-box" }, [
			h("h2", { text: "Requests, newest first" }),
			d.omittedRequests > 0 ? h("div", { className: "dim", text: d.omittedRequests + " older requests not shown." }) : null,
			h("table", {}, [
				h("thead", {}, [h("tr", {}, [th("Time"), th("Model"), th("Input", "num"), th("Cache read", "num"), th("Cache write", "num"), th("Output", "num"), th("Context", "num")])]),
				h("tbody", {}, d.requests.map(function (r) {
					var context = r.contextTokens === null ? "-" : tokens(r.contextTokens) + (r.contextWindow ? " / " + tokens(r.contextWindow) : "");
					return h("tr", {}, [td(when(r.ts)), td(r.provider + "/" + r.model), td(tokens(r.input), "num"), td(tokens(r.cacheRead), "num"), td(tokens(r.cacheWrite), "num"), td(tokens(r.output), "num"), td(context, "num")]);
				})),
			]),
		]);

		render([back, head, actions, models, children, requests]);
	}

	function unauthorized() {
		offline = "token missing or expired";
		render([h("section", { className: "pixel-box" }, [
			h("h1", { text: "Token required" }),
			h("p", { text: "In Pi, run /balancer serve status and open the address it prints." }),
		])]);
	}

	function read(response) {
		if (response.status === 401) throw new Error("unauthorized");
		if (response.status === 404) return null;
		if (!response.ok) throw new Error("HTTP " + response.status);
		return response.json();
	}

	function refresh() {
		if (document.hidden) return;
		var id = routeId();
		var request = SNAPSHOT ? Promise.resolve(id ? (Object.prototype.hasOwnProperty.call(SNAPSHOT.sessions, id) ? SNAPSHOT.sessions[id] : null) : SNAPSHOT.report)
			: (id ? fetch("/api/sessions/" + encodeURIComponent(id), OPTIONS) : fetch("/api/report", OPTIONS)).then(read);
		request.then(function (data) {
			offline = "";
			lastOk = Date.now();
			if (id) detail(id, data);
			else overview(data);
			updateStatus();
		}).catch(function (error) {
			if (error.message === "unauthorized") unauthorized();
			else offline = error.message === "Failed to fetch" ? "Pi is not serving (closed or /balancer serve stop)" : error.message;
			updateStatus();
		});
	}

	window.addEventListener("hashchange", function () { notice = null; window.scrollTo(0, 0); refresh(); });
	document.addEventListener("visibilitychange", refresh);
	if (!SNAPSHOT) setInterval(refresh, ${WEB_REFRESH_MS});
	setInterval(updateStatus, 1000);
	refresh();
})();
`;
}
