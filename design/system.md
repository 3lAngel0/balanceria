# Design system

Synced from the only design source in the project: `packages/panel/ui/style.css` (read only). Every value below was found there; nothing is invented. This is not a proposed starter: it is the panel's real pixel style.

Source path for every entry: `packages/panel/ui/style.css`.

## Colors

Tokens declared in `:root` (`style.css:2-15`).

| Token | Value | Usage |
| --- | --- | --- |
| `--bg` | `#181425` | page background, inputs, inner wells |
| `--surface` | `#262b44` | cards, rows, table headers |
| `--border` | `#3a4466` | 4 px borders, default button face |
| `--shadow` | `#0e0b16` | bevel dark side, meter track |
| `--light` | `#5a6988` | bevel light side, button hover, series 5 |
| `--text` | `#e4e6ee` | body text |
| `--dim` | `#8b9bb4` | secondary text (`.dim`) |
| `--accent` | `#feae34` | headings (h2), links, focus ring, selected state, primary button, series 3 |
| `--hp` | `#38b764` | health meter, series 0 |
| `--mp` | `#3b5dc9` | mana meter, series 1 |
| `--xp` | `#a363d9` | experience meter, series 2 |
| `--bad` | `#e43b44` | `.notice` border, guide line, series 4 |

Literal colors used by components (not tokens, found in the same file):

| Value | Where | Usage |
| --- | --- | --- |
| `#22c55e` | `.text-ok`, `.pill-active`, `.btn-accent`, `.info-notice` | success |
| `#ef4444` | `.btn-danger`, `.text-error`, `.alert-item.is-error` | error text and border |
| `#eab308` | `.alert-item.is-warning` | warning |
| `#3b82f6` | `.alert-item.is-info` | info |
| `#38bdf8`, `#a855f7`, `#f59e0b`, `#10b981` | `.badge-read`, `.badge-write`, `.badge-audit`, `.badge-orch` | role badges |
| `#000` | `.meter-track` | inset shadow |

Series palette (`style.css:100-106`): `series-0..5` = `--hp`, `--mp`, `--xp`, `--accent`, `--bad`, `--light` (color, fill and stroke).

Contrast notes (measured from these values): `--text` and `--dim` pass AA on `--bg` and `--surface`; `--accent` passes on both; `--bg` text on an `--accent` face passes; `--bad` and `--mp` are borders and fills, not body text.

## Typography

| Entry | Value | Source |
| --- | --- | --- |
| Font family | `ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace` (system stack, nothing to load) | `body` |
| Body | `14px/20px` | `body` |
| `h1` | `16px`, margin 0 | `h1` |
| `h2` | `14px`, `--accent`, uppercase, letter-spacing `1px` | `h2` |
| Small | `0.85em` (also `0.8em`, `0.9em`) | `.alert-actions`, `.badge`, `.rec-card` |
| Rendering | `image-rendering: pixelated` | `body` |

## Spacing

4 px grid (`style.css:1` comment). Values in use: `4px`, `8px`, `12px`, `16px`, `24px` (list indent). Body padding `16px`. Card padding `12px 16px`. Layout gaps `4px`, `8px`, `16px`.

## Radius

None. Every corner is square (`border-radius: 0` on the meter; no other radius is declared). Pixel look comes from stepped borders.

## Borders and shadows

| Entry | Value | Source |
| --- | --- | --- |
| Border (card) | `4px solid var(--border)` | `.pixel-card` |
| Border (thin) | `2px solid var(--border)` | `.alert-item`, `.rec-card` |
| Dashed | `4px dashed var(--border)` | `.trash-section`, `.profile-clone-box` |
| Bevel | `inset -4px -4px 0 0 var(--shadow), inset 4px 4px 0 0 var(--light)` | `.pixel-card`, `button` |
| Meter well | `inset 4px 4px 0 0 #000` | `.meter-track` |
| Focus | `outline: 4px solid var(--accent); outline-offset: 0` | `button:focus-visible`, `a:focus-visible` |

## Motion

`@media (prefers-reduced-motion: reduce) { * { animation-duration: .001ms !important; transition-duration: .001ms !important; } }` (`style.css:159-161`). Every animation must respect it.

## Components

| Component | Rule | Source |
| --- | --- | --- |
| `.pixel-card` | `--surface` face, 4 px `--border`, bevel, padding `12px 16px` | `.pixel-card` |
| `button` | inherits font, `--text` on `--border` face, no border, padding `4px 12px`, bevel; hover `--light`; disabled opacity `.4`; selected (`aria-checked="true"` / `aria-pressed="false"`) `--accent` face with `--bg` text | `button` |
| `.btn-primary` | `--accent` face, `--bg` text, bold, padding `4px 10px` | `.btn-primary` |
| `.btn-small` | transparent, 2 px border, `0.85em` | `.btn-small` |
| `.notice` | 4 px `--bad` border, padding `8px 12px` | `.notice` |
| `.pill` | 2 px border, bold, `0.85em`, padding `2px 8px`; `.pill-active` green | `.pill` |
| `.badge` | 1 px currentColor border, bold, `0.8em` | `.badge` |
| Inputs (`select`, `input`) | `--bg` face, inherits color, 4 px `--border`, padding `2px 4px` | `.rule-add input`, `.profile-model-input` |
| `table` | collapsed, th `--accent`, rows separated by `4px solid var(--bg)` | `table`, `.roles-table` |
| `.meter-track` | 16 px tall, `--shadow` well, stepped fill `repeating-linear-gradient(90deg, color 0 8px, --shadow 8px 12px)` | `.meter-track` |
| `.count-bar` / `.count-fill` | 12 px bar, 2 px `--border`, fill `--accent` | `.count-bar` |
| `.alerts-banner`, `.alert-item` | `--surface` banner, 4 px border; item 2 px border, error `#ef4444`, warning `#eab308`, info `#3b82f6` | `.alerts-banner` |
| `.pool-card` | `--surface`, 4 px `--border`, padding `8px 10px` | `.pool-card` |
| `.advisor-section` | 4 px `--border`, padding `10px`, `--surface` | `.advisor-section` |
