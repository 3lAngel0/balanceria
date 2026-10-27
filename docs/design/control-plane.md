# Design: explainable routing, model loans and the Pi control panel

Status: draft for discussion, with phases 1-6 implemented. Builds on the web report,
the `/balancer` menu and the LAN wizard (PR `feat/balancer-menu-lan`).

## 1. Goals

1. **Explain every decision.** For each request, show which role asked, which
   model the profile gave it, which provider the pool chose, and *why*: the
   rule that decided and the state of every candidate.
2. **Customizable rules.** Edit routing rules and role → model assignment in
   a web UI with drag and drop, see the advantages and risks before applying.
3. **Automatic, reversible model loans.** When a quota window is spent, the
   system may lend a role another model temporarily, tell the user in the
   console and the web, and let them keep it, revert it or wait for the reset.
4. **Balance by cost, not by rules alone.** Never switch a large context mid
   session when waiting or compacting is cheaper.
5. **One web, many projects.** A monitor of every Pi project and session, with
   alerts, the GitHub URL, actions (compact, cancel, delete), profiles and a
   lab mode, working with Pi open or closed.
6. **One renderer.** The static `report.html` and the web report become one.
7. **Encrypted transport.** TLS for the LAN, with a self-signed, local-CA or
   user-provided certificate.

## 2. Non-goals

- **No web shell or embedded SSH.** A browser terminal is a remote shell as
  the user; use `ssh` + `tmux` or a dedicated tool (`ttyd`) instead. The panel
  offers a *session console* scoped to Pi (§8.3).
- **No arbitrary code in rules.** Rules are blocks from a closed catalog.
- **No WAN exposure.** Loopback by default, private LAN on opt-in.
- **No quality measurement.** The simulator estimates quota and cost; it can
  only warn about quality.

## 3. Architecture

Two parts with one boundary: the balancer decides, the panel shows and edits.

```
┌──────────────── Pi process (per instance) ────────────────┐
│ ai-balancer extension                                       │
│  router ── rule pipeline ── switch-cost model               │
│  loan manager ── permission checks ── decision trace        │
│  writes: data/events.jsonl (traces), data/loans.json        │
│  connects to the panel over a local socket when it runs     │
└──────────────────────────────┬─────────────────────────────┘
                               │ unix socket (live actions, alerts)
┌──────────────────────────────┴─────────────────────────────┐
│ Pi control panel (separate package, systemd user service)   │
│  reads: session files, balancer data, profiles.json         │
│  serves: web UI (HTTP on loopback, HTTPS on the LAN)         │
│  offline actions: spawns `pi --mode rpc --session <file>`   │
└─────────────────────────────────────────────────────────────┘
```

- The **rule engine stays in the balancer**, because it runs inside Pi on
  every request. The panel never decides a route.
- The panel is **Node/TypeScript**, reusing the tested readers (sessions,
  events, quota, history). Go was considered and rejected: it would duplicate
  that layer, and Node is already present wherever Pi runs.
- With Pi closed, the panel reads files and runs offline actions through
  `pi --mode rpc --session <file>` (verified: Pi ships `--mode rpc` and
  `--session`). Live actions (cancel) need a running instance.

## 4. Two decision layers

| Layer | Example | Owner | File |
|---|---|---|---|
| Role → model | `apply` uses Opus | gentle-pi | `~/.gentle-shell/config/gentle-ai/profiles.json` (`kind: gentle-pi.agent_model_profiles`, `version: 1`, mode `0600`) |
| Model → provider | Opus goes through agy | ai-balancer | `pools.json` |

The UI shows them as one chain:
`role apply → profile "work": opus → pool opus (hybrid) → agy (62% left vs claude 30%)`.

## 5. Decision trace

The `route` event and history record store `pool`, `provider`, the input `reason`
(`user | continuation | retry | direct`), and why that candidate won.

`chooseCandidate` and `routeWithTrace` return the candidate **and** a trace:

```json
{
  "type": "route", "ts": 0, "pool": "claude-opus-5-5", "role": "apply",
  "chosen": "claude-bridge/claude-opus-5-5", "decidedBy": "highest-quota",
  "steps": [
    { "rule": "sticky", "result": "skipped", "why": "previous provider antigravity spent until 18:00" },
    { "rule": "available", "result": "2 of 3" },
    { "rule": "highest-quota", "result": "claude-bridge 0.62 > gemini-4-argon 0.30" }
  ],
  "context": 152300
}
```

Behavior records decisions when provider or deciding rule changes.

## 6. Rule pipeline

Each pool holds an ordered list of blocks; the default list reproduces today's
router exactly:

1. `sticky`: keep the provider of the turn while it can answer.
2. `available`: drop spent windows.
3. `pick`: `first` (waterfall), `highest-quota` (hybrid) or `lowest-cost` (cheapest `input + output` rate in `prices.json`, ties by quota; `highest-quota` when a candidate has no price).
4. `fallback`: the window that reopens first.

Catalog of additional blocks (closed, validated by a schema):

- `prefer-for-role`: role X prefers candidate Y.
- `prefer-for-context`: candidate Y when the context size is in `[minTokens, maxTokens)`; skipped when the size is unknown.
- `context-over`: above N tokens, prefer the largest-context candidate.
- `cost-cap`: skip API candidates past a daily USD cap.
- `time-window`: prefer a candidate during given hours.

Implemented: `pools.json` `rules` with `sticky`, `prefer-for-role`, `prefer-for-context` and `pick`
(exactly one, last); `available` and `fallback` are fixed guarantees, not blocks.
`context-over`, `cost-cap` and `time-window` are reserved for future phases.

Guarantees: schema validation on save; the simulator (§9) runs before apply;
if the pipeline returns no candidate the default list decides; removing
`sticky` shows a cache warning.

Interactive setup wizard (`/balancer setup`) features a multi-screen hub supporting:
1. Provider detection across packages, binaries (`agy`, `claude`, `opencode`, `ollama`), and env keys.
2. Bridge toggling (enable/disable specific bridges).
3. Pool candidate priority and candidate toggling/reordering (`↑`/`↓`).
4. Strategy toggling per pool (`hybrid` vs `waterfall`).
5. Agent role assignment customization for all 11 catalog roles with thinking levels (`low`, `medium`, `high`).
6. Heuristic and lightweight AI advisor integration (~350 tokens).
7. Interactive Control Center GUI modal launched directly from the wizard or `/balancer panel`.

## 7. Switch-cost model

Each turn re-sends the whole context. With the same provider most of it is a
cache read; a new provider re-sends it uncached, writes a new cache, and
invalidates thinking signatures.

```
switch cost   ≈ context tokens re-sent uncached + cache write + task-continuity risk
switch benefit ≈ work that no longer waits for the reset
switch only when benefit > cost
```

How cached tokens count against a *subscription* window is provider specific,
so the cost uses measured telemetry (`turn`, `new`, `ctx`), not list prices.

Where switching is cheap, and therefore where the system balances:

| Moment | Context | Policy |
|---|---|---|
| New subagent (role → model) | small, fresh | switch freely |
| New session | none | switch freely |
| Right after compaction | small | switch freely |
| Mid session, large context | large | propose: wait (reset soon) · compact then switch · continue from a summary on another model |

## 8. Model loans (temporary role → model)

### 8.1 Lifecycle

1. **Trigger**: a rule fires, e.g. "Opus window spent and `apply` uses Opus".
2. **Recommendation** from the switch-cost model, with alternatives.
3. **Notify**, non-blocking:
   - console: an alert with a key that opens the chooser (never a dialog that
     blocks a running turn; opened on demand or when Pi is idle);
   - web: an alert with the recommendation preselected, alternatives, their
     advantages and risks, and "keep as is".
   Choices: **apply recommendation** · **pick another model** · **cancel, wait
   for the quota reset**.
4. **Grace period**: with no answer after N minutes, or before the next
   subagent launches, the recommendation applies.
5. **Loan active**: recorded in `data/loans.json` with the original model.
6. **End** at the window reset, with a review popup backed by data:
   > While loaned, Sonnet ran 6 `apply` tasks and used 40% less quota.
   > **[Keep permanently]** · **[Back to Opus]**
7. **Audit**: who decided (rule or user), before, after, when.

### 8.2 Correctness

- **Several Pi instances**: every instance shows the alert; each decision has
  an id and the first answer wins under a lock; the others close.
- **When it takes effect**: at the next subagent request, through the
  balancer's routing layer (R2: open sessions freeze their profile, so a
  `profiles.json` edit would not reach them). A running turn keeps its
  model; the alert says so.
- **Anti-flapping**: a cooldown between switches of the same role.
- **Crash during a loan**: `loans.json` is the journal; on start the balancer
  restores originals for expired loans.

### 8.3 Session console

The panel attaches to a Pi session through rpc: live transcript, send a
prompt, compact, cancel. Scoped to Pi, never a system shell.

## 9. Lab mode (draft, simulate, apply)

- Edit a **draft** of rules and profiles; nothing live changes until *Apply*.
- **Simulate** the draft on the last 30 days of history: tokens per model,
  window fills, API cost, and quality warnings per role.
- Side-by-side current vs draft, apply with backup, one-click undo, backup
  rotation (today `profiles.json.bak-*` files accumulate without pruning).

## 10. Permissions and profile safety

### 10.1 Levels

| Level | Effect |
|---|---|
| off | show only |
| suggest | every change needs a confirmation |
| auto | loans apply on their own within the granted scope (§8) |

- **Granted from Pi, never from the web.** The web may *request*; the
  terminal confirms. A stolen LAN token cannot raise its own permissions.
- **Scoped and expiring**: which profiles, which roles, which models are
  interchangeable, until when. Revocable in one step.

### 10.2 Risks shown before granting

1. Silent quality loss when a critical role moves to a cheaper model.
2. Global effect: every new session of every project.
3. The file belongs to gentle-pi: writes refuse an unknown `kind`/`version`.
4. Unknown model: validated against Pi's model registry before saving.
5. Concurrent writers: compare mtime/content before writing, write atomically.

## 11. Panel features

- Multi-project monitor from `~/.gentle-shell/agent/sessions/<project>/`.
- Alerts: window near full, context over 120k, circuit breaker open, stuck
  session, pending loan decision.
- GitHub URL from the session cwd's `git remote`.
- Actions: compact (live or rpc), cancel (live only), delete to a trash with
  confirmation and retention, never immediate deletion. Enabled only over
  loopback or HTTPS.
- Profiles editor, rule editor (drag and drop), decision explorer.
- Pixel-art UI, **simple** and **advanced** modes of one app; configurable
  panels stored server side (`data/web-layout.json`).
- Strict CSP kept: no CDN, no third-party scripts.

## 12. Unified report and TLS

- The web page is the only renderer. `/balancer report` writes a snapshot of
  the same page with the data inlined, or is removed.
- TLS options in the LAN wizard: self-signed (browser warning), local CA via
  `mkcert` (trusted after installing the CA on each device), or a user cert
  and key. HTTPS adds `Secure` to the cookie. Node `https` needs no
  dependency.

## 13. Phases (one PR each)

| # | Phase | Status | Changes behavior? |
|---|---|---|---|
| 1 | Decision trace + decision explorer in the current web | Complete | no |
| 2 | Unified report + TLS in the wizard | Complete | report only |
| 3 | Rule pipeline as data (default = today) + simulator | Complete | no, until edited |
| 4 | Permissions + profile safety + lab mode | Complete | only on apply |
| 5 | Switch-cost model + model loans + console/web alerts | Complete | yes, when auto is granted |
| 6 | Separate panel package: multi-project monitor, actions, session console, pixel UI | Complete | new service |

## 14. Open questions

Each one gets an answer logged here before its phase starts.

### Research (facts to establish, may change the design)

- **R1 Role at routing time.** `src/roles.ts` notes that a subagent's Pi
  process is not told its agent name; the role is joined *after* the fact
  from Gentle's task store (`~/.gentle-shell/agent/gentle-agents/tasks`).
  `prefer-for-role` rules and the `role` field in the trace need it *at*
  routing time. Options: look up the task file by the child's session file
  when routing, or ask gentle-pi to pass the agent name to the child.

  ✅ Answered 2026-10-21 (gentle-pi 4.3.0 source, `lib/agents-runner.ts`,
  `extensions/gentle-agents.ts`, `lib/agents-protocol.ts`):
  - **The task file cannot be used at routing time.** The task store is in
    memory; `persist` writes `tasks/<id>.json` only once the task finishes.
    While the child runs there is no file, and its `sessionPath` is learned
    by the parent from an rpc `get_state` sent alongside the first prompt.
  - **The child's environment carries no agent name.** It gets the parent's
    environment plus `GENTLE_PI_AGENTS_CHILD=1` and an ipc marker.
  - **The agent name is in the child's argv.** Instructions over 1000 bytes
    (every bundled agent body is 2.3 KB or more) are passed as
    `--append-system-prompt <tmp>/gentle-pi-subagent-<name>-XXXXXX/instructions.md`,
    with `<name>` sanitized to `[A-Za-z0-9._-]`, at most 64 chars. The
    extension reads `process.argv` in process (the process title is `pi`,
    so `ps` shows nothing).
  - **Decision:** at routing time the role is `argv name` when present,
    else `subagent` for a child and `orchestrator` otherwise. The trace
    records the source (`argv` or `none`). The read-time join with the task
    store stays the source of truth for history. The argv path is a gentle-pi
    implementation detail, not a contract: one parser, tested, and a request
    upstream for an explicit `GENTLE_PI_AGENT_NAME` variable for the child.
    `prefer-for-role` rules apply only when the role is known.
- **R2 When gentle-pi reads `profiles.json`.** gentle-pi owns the format
  (`lib/agent-profiles.ts`: normalize, serialize, profiles, active profile).
  Confirm it is read at each subagent launch, not cached per Pi process;
  otherwise a loan does not take effect until Pi restarts.

  ✅ Answered 2026-10-21 (`lib/session-profile-freeze.ts`,
  `extensions/gentle-agents.ts` launch path): **cached per session.** A
  parent session resolves its profile once at startup, in the order
  explicit `/gentle:profiles` Enter → repository pin → repository
  declaration → global `active`, and freezes the name *and* the role → model
  map in memory. Every subagent launch reads that frozen snapshot and passes
  the model to the child with `--model`. Editing `profiles.json` reaches
  only new sessions; open ones show a drift notice. Exceptions:
  `GENTLE_PI_PROFILE_FOLLOW=1` (live resolution) and an explicit Enter in
  the session. A resumed session freezes again from the current file.

  **Consequence for loans (§8):** a `profiles.json` loan cannot help the
  session whose window just ran out. Two layers are needed:
  1. **Routing-layer loan (open sessions).** The balancer runs inside the
     child, knows its role (R1) and the requested model, and may route that
     role's requests to another pool for the loan. It applies at the next
     subagent request with no restart, and ends with the loan. This is the
     main mechanism.
  2. **Profile loan (new sessions, optional).** A `loan-<id>` profile (R3)
     for sessions started during the loan.
  T12 is designed around layer 1; layer 2 only if the user asks for it.
- **R3 Loan as a profile switch.** Instead of editing the user's profile, a
  loan could create `loan-<id>` (a copy of the active profile with one role
  changed), make it active, and restore the previous active profile at the
  end. It reuses gentle-pi's own semantics and never touches the user's
  profile. Check that gentle-pi's serializer accepts it and how the profile
  UI shows it.

  ✅ Answered 2026-10-21 (`lib/agent-profiles.ts`): **accepted, with
  limits.** Names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, so
  `loan-20261021-apply` is valid; the serializer keeps any valid profile and
  `active`, and gentle-pi writes the file atomically. `/gentle:profiles`
  lists it as `loan-… (active)` with its role count and no special mark, so
  the user can select, edit or delete it like any profile. Limits: it only
  reaches new sessions (R2), and repositories with a pin or a declaration
  ignore the global `active`. Hence it is the optional layer 2 above, never
  the main loan mechanism.
- **R4 Cache accounting per provider.** How cached tokens count against each
  subscription window (agy, claude-bridge), to calibrate the switch cost.

  ✅ Answered 2026-10-21, **estimate**: `data/history` 2026-10-18..21
  (5631 rows). For each pair of consecutive quota samples of one window
  (same reset, under 30 min apart, under 100%) the growth of `usedPercent`
  was fitted against the tokens of that provider's requests in between,
  as `k × (input + w_r·cacheRead + w_w·cacheWrite + w_o·output)`:

  | Window | Intervals | cacheRead = 1 | cacheRead = 0.1 | 0.1 + write 1.25 + output 5 |
  |---|---|---|---|---|
  | claude-bridge 5h | 107 | R² 0.37 | 0.57 | **0.64** (15.7 %/M weighted tokens) |
  | agy argon week | 36 | 0.42 | **0.82** (11.8 %/M) | 0.82 |
  | agy gemini flash 5h | 80 | no fit (R² < 0) | — | — |

  - Both measurable windows count a cache read at about a tenth of an
    uncached token. A switch therefore costs about ten times the turn it
    replaces: re-sending 150k of context uncached is ≈ 2.9% of the claude
    5h window (vs ≈ 0.24% as a cache read) and ≈ 1.8% of the argon week
    (vs ≈ 0.18%).
  - The agy gemini 5h window moves without Pi traffic (46 idle intervals
    added 123%): other clients share it, so it cannot be calibrated from
    Pi data. Same caveat, smaller, for claude-bridge (2 idle intervals,
    15%).
  - **Decision for T11:** default weights `cacheRead 0.1, cacheWrite 1.25,
    output 5`, one `%/M` factor per window refitted from history (and from
    traces once phase 1 runs); a window without a fit uses the defaults and
    says so in the trace. The defaults of D3 stand.

### Decisions (for the user)

- **D1 Panel home:** ✅ decided 2026-10-21: a package inside this repository
  (`packages/panel/`, its own `package.json`). The root stays the Pi
  extension, so `settings.json` keeps loading only `src/extension.ts`; the
  panel imports the shared readers from `src/` directly, with no publishing
  step in between.
- **D2 Panel authentication:** ✅ decided: keep the token. Actions that
  change something (compact, cancel, delete, profiles, rules) are enabled
  only over loopback or HTTPS, never plain HTTP on the LAN.
- **D3 Defaults:** proposed, every value editable in the UI; the user left it
  to the design:

  | Setting | Default | Why |
  |---|---|---|
  | Grace period before a loan applies | 2 min, or the next subagent launch, whichever comes first | time to react without blocking work |
  | Cooldown between switches of one role | 15 min | stops flapping when a window spends and reopens |
  | "Small context" (switch is cheap) | under 30k tokens | re-sending it uncached costs about one ordinary turn |
  | "Reset is soon" (waiting wins) | under 30 min, with context over 30k | a short wait beats re-sending a large context |

  Revisit after phase 1 with real traces.
- **D4 Interchangeable models:** ✅ decided: the system suggests groups
  (from pool membership and model tier); the user selects which ones apply.
  Nothing is interchangeable until the user selects it.
- **D5 Delete semantics:** ✅ decided: a trash folder
  (`data/trash/<date>/<project>/<session>.jsonl`) kept at most 10 days, then
  pruned; restore from the panel within that time.
- **D6 Frontend stack:** ✅ decided (recommended, user accepted):
  Preact + TypeScript bundled by esbuild into static files the panel serves
  itself, so the CSP stays `'self'` and there is no CDN. Panel layout drag
  and drop with gridstack.js; rule blocks reordered by pointer *and*
  keyboard. Charts are own SVG components (canvas for large series):
  pixel-art histograms, sparklines and timelines with selectable series,
  legend toggles, tooltips and a data-table fallback for readability.
  Animations are short CSS transitions that honor
  `prefers-reduced-motion`. Follows the repo skill
  `.agents/skills/pixel-dashboard-design` (system monospace fonts, stepped
  pixel borders, accessible RPG meters, WCAG 2.1 AA). Dependencies kept to
  preact, gridstack and the esbuild dev tool, pinned with a lockfile.
- **D7 Alert channels:** ✅ decided: all of them. Console (non-blocking
  alert), web (in page), browser notifications (Notification API, which
  needs a secure context: loopback or HTTPS) and desktop notifications
  from the panel service (`notify-send` on Linux when present).
