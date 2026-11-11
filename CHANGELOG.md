# Changelog

Pi shows the entries newer than your installed version after `pi update`.
Each release bumps `version` in `package.json` and adds a `## [x.y.z]` heading here.

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
