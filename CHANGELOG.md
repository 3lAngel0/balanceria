# Changelog

Pi shows the entries newer than your installed version after `pi update`.
Each release bumps `version` in `package.json` and adds a `## [x.y.z]` heading here.

## [Unreleased]

### Fixed

- When every candidate of a pool is spent and nothing can take over, the turn ends with a clear notice (English and Spanish) that names the pool and when the soonest candidate comes back, instead of the provider's raw quota text. It reaches subagents too, since it is the error they hand back. The session stays open and routes normally once a candidate reopens.

## [0.4.1] - 2026-11-12

### Fixed

- `/balancer lab apply` refuses a draft whose `lastResort` model is not in Pi's model registry.
- A failed install that wrote nothing no longer leaves `.bak-installer-*` copies behind or turns on Undo; a failure after writing keeps the copies so Undo restores the files.
- The installer leaves automatic loans untouched when `permissions.json` cannot be read (now covered by tests).

## [0.4.0] - 2026-11-11

### Added

- Last-resort model: set `lastResort` in `pools.json`, or pick it in `/installer` → **Backups** → **Last-resort model** (`l`), in the terminal and the web. When every candidate of a pool is spent, it answers automatically, in the main session and in subagents, with a warning notice.
- Automatic loans in the installer: **Backups** → **Automatic loans** (`a`) moves the tasks of a spent backup to another model until it resets. The installer only manages its own grants in `permissions.json`; undo restores the file.
- The "pool exhausted" menu also offers any model of your subscriptions with quota left, even if it is in no pool.
- Roles on a direct model are flagged as having no backup in the installer and in `/balancer` → Roles. The quota hint for them suggests the last-resort model.
- README FAQ (English and Spanish): who decides routing, direct-model roles, strategies, spent pools, backups across companies, loans.

### Changed

- "Mixed" (`hybrid`) is described as it routes today: like "Most room left". Routing is unchanged.
- The orchestrator is shown as "Main agent (orchestrator)" everywhere.
- The Backups step explains how to build a backup with models from another company.
- Terminal installer: key hints sit in a titled box as an aligned grid; action buttons and navigation buttons are on separate rows.

## [0.3.2] - 2026-11-11

### Fixed

- The console and web installers now list subscriptions signed in with Pi's `/login` (ChatGPT Plus/Pro as `openai-codex`, Claude Pro/Max, GitHub Copilot, Kimi…). They are read from the OAuth entries in the agent's `auth.json`, with models from Pi's registry.

## [0.3.1] - 2026-11-11

### Fixed

- `alt+u` now agrees with the `ctrl+alt+u` HUD: every weekly row first, then every 5h row, named like the HUD (`claude-bridge claude`, `antigravity gemini`).
- `alt+u` shows the percentages the provider reports. A router hold adds `· router waits 2h 5m` instead of a fake 100%.
- Windows agy disabled show as `disabled · weekly limit hit` (or `disabled`).
- The `alt+u` header reads `<pool> · now <provider/model> · claude <plan>`.
- `antigravity` sessions list the agy groups in `alt+u` instead of "no subscription usage for this provider".
- A newer agy `/usage` reading with margin lifts an earlier "quota reached" block, so the router uses that model again. Claude quota events and stall cooldowns still block.
- The `ctrl+alt+u` HUD drops windows the provider's latest reading no longer reports.

## [0.3.0] - 2026-11-11

### Added

- Interactive setup hub: `/balancer setup` runs a guided installer in the terminal and in the browser at `/installer`, with backups that never overwrite your files.

## [0.2.1] - 2026-11-02

### Fixed

- Proactive context compaction at 180k tokens before failing over to a smaller context window.
- Escalating stall cooldowns (6m, 30m, 2h) and recovery of stale quota blocks.
- Readable failover notices and exact `provider/model` in the status bar.
- Profile saving across Gentle Shell and standalone Pi setups.

## [0.2.0] - 2026-10-31

### Added

- Control Center with boxed tables, a Help box and mouse support.
- Four-step `/balancer setup` wizard with a preview and explicit Save/Discard.

### Changed

- `/balancer` opens the Control Center; the action list moved to `/balancer menu`.
