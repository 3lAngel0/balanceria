# Reading the HUD and the usage panel

[Versión en español](reading-the-hud.es.md)

Two screens answer two questions:

| Screen | Open with | Question it answers |
|---|---|---|
| Usage panel | `ctrl+alt+u` or `/balancer usage` | What did I spend, where, and when did a quota fill? |
| HUD | `/hud` | How full is each subscription right now, and will it last until its reset? |

Both read the same local history (`data/history/`). Nothing is sent anywhere.

## First: what a token number means

Every line that says `40.7M`, `950.6k` or `143.7M` is a count of **tokens**: `k` is thousands,
`M` is millions. That number is the sum of four kinds of tokens:

| Kind | What it is | Cost weight |
|---|---|---|
| `input` | New text sent to the model without cache | Full price |
| `cache write` | Text sent once and stored in the provider's cache | Same as input, or a bit more |
| `cache read` | Text the model already had cached, sent again | About 1/20 of input |
| `output` | What the model wrote back | The most expensive |

The key idea: **every request re-sends the whole conversation**. A session with 150k tokens of
context sends those 150k on every turn, even when you type one line. The cache makes that
cheaper, but it is still counted.

### Worked example: `tokens 5h 40.7M`

The `/hud` card for Claude Pro showed `tokens 5h 40.7M` while the 5-hour window was at 44%.
Broken down from the history:

| Kind | Tokens | Share |
|---|---|---|
| cache read | 39.6M | 97% |
| cache write | 0.9M | 2% |
| output | 0.2M | <1% |
| input | ~600 | 0% |

So 40.7M does **not** mean the models wrote 40 million tokens. They wrote about 215k. The rest is
the same conversation re-read on each turn. That is why long sessions drain a window: the
re-read grows with every message. `/compact` or a new session resets it.

### Tokens are not the percentage

The provider decides how each kind of token counts against a window and does not publish the
formula. The **percentage** (`44%`) is the provider's own reading and is the source of truth for
"how much is left". The token count explains **why** it moved.

## Colors

Both screens use the same three colors, and the HUD prints the legend on screen:

| Color | Meaning | What to do |
|---|---|---|
| Green | Under 70% and lasts until it refills | Nothing |
| Yellow | 70% to 89% | Watch it; prefer short sessions |
| Red | 90% or more, full, or the pace runs out before the refill | Slow down, `/compact`, or move work to another subscription |

A window is red as soon as its pace says it runs out before the refill, even at 55%. The
`1 now` tab and the HUD agree on that. The session context meter in `1 now` follows the status
line instead: green under 120k tokens, yellow from 120k, red from 200k. Dim text is secondary:
reset times, reading ages, and "nothing here yet" notes. Colors come from the active Pi theme.

## The usage panel (`ctrl+alt+u`)

Keys: `1`-`5` pick a tab, `tab` cycles, `pgup`/`pgdn`/`home`/`end` scroll when a view is taller than the terminal, `q` or `esc` closes. It refreshes automatically every 5 seconds.

### `1 now`

Every block is a card. Cards sit side by side when the panel is wide enough and stack one per row
when it is not.

```
╭─ This session · 01a155f0 ────────────────╮ ╭─ Last 24h · peak 15.3M/h ────────────╮
│ model claude-opus-5-5                    │ │ ············█··········▃                │
│ context  ▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱  15%           │ │ -24h                 now                │
│ 152.3k of 1.0M tokens                    │ │                                         │
│ requests 14   API $0.58                  │ │                                         │
│ input 28   output 9.8k                   │ │                                         │
│ cache read 900.4k   write 40.4k          │ │                                         │
│ total 950.6k                             │ │                                         │
╰──────────────────────────────────────────╯ ╰─────────────────────────────────────────╯

Subscriptions now
╭─ agy claude week ────────╮ ╭─ claude 5h ──────────────╮
│ ▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱  62%  │ │ ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  23%  │
│ resets in 1d 16h        │ │ resets in 4h 23m        │
│ read 7m ago             │ │ read 7m ago             │
╰─────────────────────────╯ ╰─────────────────────────╯
```

- `context`: how much this session re-sends on every request, against the model's limit. From
  120k the status line shows `ctx … ⚠ /compact`.
- The token lines split this session's tokens by kind. `API $0.58` is what the same tokens would
  cost through the paid API at list price (`prices.json`). You do not pay it on a subscription; it
  is a yardstick to compare plans.
- `Subscriptions now`: one card per quota window, titled in its fill color, with its meter, when it
  resets and how old the reading is.
- `Last 24h`: one bar per hour; the tallest bar is the peak shown in the title.
- `30 days by provider`: one card per provider with its total, its share (number and meter), its
  requests and API-equivalent cost, and the same token split.

### `2 quotas`

- One card per window, side by side (as many per row as the panel fits), titled with its peak and
  fill count. Each holds a 0–100% column chart across the active day range (leading days before
  the first recorded reading are skipped with `no data before MM-DD`). Each column shows that
  day's peak percentage in eighths of a row, `·` when there was no reading that day, a red `▲` on
  the 0% axis when the window reached 100% that day, and dates (`MM-DD`) below the axis. Windows
  with no reading in those days get no card; they are listed on one line under the cards.
- `Report`: a table with one row per window that filled: how many times (`fills`), how often
  (`every 17h 14m`), how long it took to fill (`fills in`) and how long it stayed blocked. `-`
  means not known yet.
- `Fills`: a table, newest first, with each time a window hit 100%, the session that spent the
  most tokens before it (`top session`, `tokens`) and the session whose request was rejected
  (`hit in`).

```
  window           fills  every   fills in  blocked
  claude 5h        5      11h 8m  4h 2m     4h 47m
```

### `3 days`

One card per provider with its 30-day tokens, API-equivalent cost and, when `prices.json` has its
plan price, how many plans' worth that is (`vs plan $20 → 2.5x`). Below, a table with one row per
day (from the first day with data to today; empty days inside that range stay visible as real
gaps):

```
  day   tokens per day         total  claude-bridge  antigravity    API $
  10-20 █▓▓▓▓▓░░░░░░░░░░░░░░   43.6M          10.2M        33.5M    $9.09
  10-17 ░░░░░░░░░░░░░░░░░░░░       0              -            -        -
```

The bar is scaled to the busiest day (`0 … peak` header above it) and split by provider (`█` first
provider, `▓` second, `▒` third+, `░` unused); each provider then has its own column, and `-` means
nothing that day. `month pace` projects the API cost of a whole month at the current rate; compare
it with what the plan costs.

### `4 sessions`

Newest first: project, session id, model (`+1` means it also used another model), requests,
tokens, the largest context it reached (`peak ctx`) and its API-equivalent cost. A high `peak ctx`
with many requests is the typical window drainer.

### `5 hud`

The compact HUD, described below. It ends with **Top consumers · last 7 days**: the three roles
that spent the most, one line each (see [Sessions](#sessions-what-spends-the-most) below).

## The HUD (`/hud`)

Keys: `1` subscriptions, `2` apis, `3` sessions, `4` suggestions, `tab` cycles,
`pgup`/`pgdn`/`home`/`end` scroll (when lines are clipped, the bottom row shows
`↓ N more lines · pgdn`), `q` or `esc` closes. The footer lists only the keys that work in the
current view:

- sessions: `↑↓ select · enter open · x compact · f fresh · 1-4/tab view · pgup/pgdn scroll · q close`
- suggestions: `↑↓ select · enter act · c profile · x compact · f fresh · 1-4/tab view · pgup/pgdn scroll · q close`

What each key does:

- `enter` in sessions switches Pi to the selected session. In suggestions it acts on the selected
  one: it opens its session, creates the tuned profile on "Try <model> for <role>" (same as `c`,
  after a timestamped backup of `profiles.json`), and on quota suggestions only explains what to do.
- `x` compacts the selected session: Pi switches to it and runs compaction there.
- `f` continues the selected session in a new one: the original is forked at its last message and
  only the fork is compacted, so the original stays untouched.
- `x` and `f` ask first. The selected row shows
  `‼ x again: compact it, one large request summarizes "<name>" · any other key cancels` or
  `‼ f again: new session from a summary of "<name>", the original stays · any other key cancels`.
  Press the same key again to run it; any other key cancels. Both work in the sessions and
  suggestions views, and say so when the selected item has no session.

#### Why compacting saves tokens

Every turn re-sends the whole conversation, so a long session pays for its full history on every
request. Compaction replaces the old history with a summary, and each later turn re-sends the
short version. It costs one large request (the model reads the whole history to summarize it), so
it pays back after a few turns. Pi keeps the last ~20k tokens (`keepRecentTokens`) unsummarized,
so very recent work stays verbatim. Deleting history or files saves no tokens: what counts is the
context a session re-sends, and neither key deletes anything.

### Subscriptions: bridges and plugins

A subscription (Claude Pro through `claude-bridge`, Google AI Pro through `agy`) has **windows**:
a share of use that refills at a fixed time. `5h` refills five hours after it starts; `week`
refills once a week.

```
Claude Pro (claude-bridge)
  tokens  5h 40.7M · today 75.3M · 7d 143.0M
  claude 5h            ▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱   44%  resets 20:30 (in 2h 34m)
                       +21.1%/h → full at 20:30, after the reset
  claude week          ▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱   66%  resets 10-20 11:00 (in 17h 4m)
                       +2.3%/h → full at 10-20 08:21, before the reset ⚠
```

Read it top to bottom:

1. `tokens`: tokens served by this subscription in the last 5 hours, today and the last 7 days
   (see the worked example above).
2. One meter per window: how full it is, and when it refills.
3. The pace line under it: how fast it filled during the last hour (`+21.1%/h`) and when it
   reaches 100% at that speed.
   - `after the reset`: it refills first. Fine.
   - `before the reset ⚠`: at this speed you run out before it refills. Slow down, `/compact`, or
     move work to another subscription.
   - `full since 10-18 04:09`: already at 100%; requests go to the next provider in the pool.
   - `no pace yet`: it needs two readings at least 5 minutes apart within the last hour.
4. The window chart under it: the whole window from its start to its reset on a 0–100% axis.
   - Solid blocks (`█`) are the used percentage recorded so far (`·` before the first reading).
   - Dots (`•`) project the current pace from `┴ now` to `┤ reset` (or to `▲ full` when it hits
     100% before the reset).
   - Start, `now`, `full` and `reset` times are labeled below the axis when they fit without
     touching.

The compact version (`5 hud` in `ctrl+alt+u`) puts each window on one line:
`+2.3%/h · full in 14h 25m ⚠` means the same as the pace line above.

### APIs: billed per token

An API integration (Anthropic API, Gemini API) has no window: you pay per token. The view shows
requests and USD today, in 7 days and in 30 days, at the list prices in `prices.json`.

```
Anthropic API
  period  requests  USD
  today          3  $1.20
  7d            10  $4.00*
```

- `*`: some requests used a model with no price in `prices.json`, so the amount is a lower bound.
  Add the model's price to fix it.
- `no requests in 30 days`: the API is configured but nothing used it. That is the normal state
  until you connect an API key.

### Sessions: what spends the most

Every request re-sends the whole conversation to the model, so the tokens of a session are two
different things:

- **context re-sent**: input + cache read + cache write, the history sent again on every turn.
  It grows with the conversation.
- **new output**: what the model wrote.

```
orchestrator  230.3M tokens · 100% context re-sent
▸ bueno vamos a empezar a fixear cosas, t…  mu-web           98.5M  100% re-sent  00:53
  legacy                                    (before histo…   53.8M   99% re-sent  10-18 03:49
gentle-ai-verify  10.3M tokens · 99% context re-sent
  verify login token (credentials)          mu-web            5.0M   99% re-sent  00:51
```

- Roles come biggest first (the orchestrator and each subagent type), with up to 5 of their
  sessions, over the last 7 days. The last column is the last time the session was used.
- **The name of a session** is, in order: the name you gave it, the label of the subagent task, the
  first thing you wrote in it (cut at 40 characters), and only then the first 8 characters of its id.
- **`% re-sent` in yellow** means 90% or more is old context, not new work: the session is long and
  a good candidate for `/compact` or for splitting the work.
- `▸` is the selected row. `enter` closes the panel and switches Pi to that session. If its file no
  longer exists the panel stays open and says so under the list.
- The ctrl+alt+u panel cannot open sessions (Pi only allows switching from a command), so its
  `5 hud` tab shows the top roles without selection.

### Suggestions: evidence-based tuning hints

The suggestions view analyzes real usage against four optimization rules (ranked by estimated saving):
- **Large context**: sessions sending >=120k tokens of context for >=5 turns. Shows estimated
  saving if compacted or split.
- **Provider switch**: sessions where model/provider flips caused large cache rewrites.
- **Expensive role**: subagent roles with small outputs running on expensive models where a cheaper
  model already tested in history costs less than half. Pressing `c` or `enter` on an expensive role suggestion
  automatically creates a new profile in `profiles.json` (e.g. `mu-privado-opt-gentle-ai-verify`)
  after making a timestamped backup (`profiles.json.bak-YYYYMMDDHHMMSS`).
- **Idle quota**: subscription windows projecting >=50% unused at reset while another window fills.

Each suggestion names its session by the same alias as the sessions view (never a bare id when an
alias exists), starts with one plain `why:` line, and only the selected one expands its evidence and
the `→` line with what to do. Every suggestion states that quality is not measured, so you can test
before adopting.

## Which providers appear where

`integrations.json` decides it: `"kind": "subscription"` goes to the subscriptions view,
`"kind": "api"` to the APIs view. A provider that is not listed is never guessed as one or the
other. Pools (`pool/claude-opus-5-5`) are routers, not integrations: each request is recorded
under the real provider that answered it.
