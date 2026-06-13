# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

(empty)

## [0.1.6] — 2026-06-13

### Added
- Click any row's `T` badge (shown when the entry has a `payload.transactionId`) to open a new tab searching that transactionId across idm/am everything, ±60s around the entry's timestamp. Hover shows the full id.
- Tab right-click → `Duplicate (clone results, no re-search)` — forks the current panel into a new tab with the same entries already loaded so you can filter independently without hitting PAIC again.
- Real-time warning when the configured time range exceeds 24 hours — input fields get an orange border the moment the span crosses the threshold. A confirm dialog still appears at Search time.
- Time inputs default to "now" on panel open; end-time auto-seeds from begin-time when first focused empty; changing the begin date updates end's date portion (preserving time-of-day).

### Changed
- `History` button hidden from the search bar (functionality retained internally; can be re-enabled if needed).

### Added
- Saved Tail Files sidebar: inline `Reveal in File Explorer` button (uses VS Code's `revealFileInOS` — Finder on macOS, Explorer on Windows).
- Search form datetime inputs now support millisecond precision (`step="0.001"`). Unspecified ms defaults to `.000`; pasting a ms-bearing string (e.g. `2026-05-28 21:32:35.053`) preserves the ms.

### Changed
- Default sort order is now **ascending** (oldest first) to match natural log reading order.
- Datetime paste no longer force-adds `Z` to bare timestamps — `2026-05-28 21:32:35` is now treated as local time (only explicit `Z` / offset means UTC).
- Datetime input box widened from 175px to 215px to fit the ms field.
- Calendar picker icon is inverted in dark / high-contrast themes so it's visible.

## [0.1.4] — 2026-05-23

### Added
- Click `Source` / `Level` column headers to open an inline popup listing all distinct values in current results with counts; pick one to filter (chip appears in toolbar). Headers also have hover affordance + cursor.

### Changed
- "Clear all" filters button moved from the filter-input row to the chip row, only shown when chips exist.
- Time cell click shows "Copied!" inline (instead of relying on status text) and copies a full timestamp matching the displayed timezone (UTC ISO or local with year).
- Sort arrows follow convention: `▼` descending (default), `▲` ascending. First click on Time header now sorts immediately (search results are sorted on arrival to match the arrow direction).
- Modal width reduced (15% / 70% / 15%).
- Format mode now correctly expands embedded JSON when the payload contains non-JSON brackets earlier in the string (e.g. `Attempting[0:5] trigger update: {…}`).

### Removed
- `+Field` button (Enter on the local filter input already creates a chip).
- `Custom` button and the entire custom-code rule machinery (`paicLogSearch.customCodeRules` setting, `PaicCustomCodeRules` type, related state and storage). The include/exclude rules were too project-specific to maintain as a built-in.

## [0.1.3] — 2026-05-12

### Added
- CLI button ▾ dropdown: `Paste CLI → fill form` reverses the copy direction — paste a `paic-logs search …` command and the form is populated (env / source / time / query / level). Warns if env name doesn't match an existing environment.

## [0.1.2] — 2026-05-12

### Added
- Recent Searches sidebar: new title-bar action to clear zero-result entries in one click (`$(circle-slash)` icon).
- Saved Tail Files sidebar: per-row delete (inline trash) and Clear All title-bar action.

### Changed
- Tail polling default lowered from 5000ms to 1000ms; high-traffic tenants now see new logs much sooner.
- Pagination: added `«` first / `»` last buttons and a Page input box for jump-to.
- Tail auto-jumps to the last page on each batch (still respects user scroll-up pause).
- On Tail start: filter chips, exclude chips, field filters, dedup / customCode / raw modes are reset (Local time toggle preserved).

## [0.1.1] — 2026-05-09

### Fixed
- Keyword clear button (×) now appears for programmatically-set query values (Recent Searches, Help quick links, Related templates).
- Tail status updates correctly on stop — was stuck on "Tailing…".

### Changed
- Tail button turns red `■ Stop` while active.

## [0.1.0] — 2026-05-07

Initial public release.

### Search & query
- Multi-environment management — add / edit / delete envs via sidebar tree; secrets in OS keychain (`SecretStorage`).
- Multi-tab — each sidebar env click opens an independent search panel; tab title shows live count + tail status.
- Multi-source picker with IDM / AM / Other groups; `*-everything` ↔ individual mutual exclusion.
- Three time modes: Recent (with quick buttons), Range (second precision), Around (±N around a center).
- Datetime helpers: double-click = Now, paste auto-detects 6 formats.
- Per-source `_queryFilter` heuristics in `paicClient.ts`.
- Large-query confirmation prompt for keyword-less searches over a threshold.
- Search navigation back/forward stack (browser-style, 50-entry cap, sessionStorage).

### Result rendering
- Per-source semantic single-line summaries (11+ branches: AM-NODE-LOGIN-COMPLETED / AM-TREE-LOGIN-COMPLETED / AM-LOGOUT / AM-SESSION* / AM-IDENTITY-CHANGE / AM-ACCESS-* / idm-access / idm-activity / idm-sync / am-core / generic).
- Raw mode toggle: full entry JSON, multi-line wrapped.
- Sortable Time column; resizable columns with width persistence.
- Locate-highlight on selected row, surviving sort/filter/pagination.
- Log keyword highlighting (8 built-in rules: SUCCESS/FAILED/Exception/WARN/CRUD/4xx-5xx/true/false; configurable).
- `[LEVEL]` tag protection so `[ERROR]` doesn't double-highlight its inner keyword.
- UTC ↔ Local time toggle with millisecond precision.

### Filtering
- Local filter chips (live single-term + Enter promotes to permanent chip; AND across chips).
- Exclude word chips.
- +Field dialog (auto-extracts fields and values from current data, sorted by frequency).
- Dedup mode with clickable ×N badges to exclude that payload group.
- Custom-code mode (subtractive: 30+ built-in IDM noise excludes; configurable).
- Auto-reset Custom mode on every new search (avoids "I searched and got nothing" confusion).

### Modal
- Full entry JSON view; title shows `#idx/total ts [source]` with click-to-copy timestamp.
- Cross-page navigation via ↑↓←→ + buttons.
- Format mode: deep-clone, brace-counter embedded-JSON expansion, iterative unescape, stack-trace `\n\tat` formatting, `_json` block green highlight, search keyword yellow + filter cyan.
- Wrap toggle for long-line content.
- Copy button with "Copied!" feedback.
- Related searches dropdown — 15+ diagnostic templates grouped by Trace / Auth Tree / User / Object / Context / Diagnostics, with per-template editable window seconds (persisted).

### Productivity
- ETA tooltip on Search hover — sample-based prediction, color-coded.
- Live elapsed counter in status bar during a search (with optional ETA comparison).
- CLI button — copy equivalent `paic-logs search …` command to clipboard.
- Save export to NDJSON / JSON via `showSaveDialog`.
- Help dialog with auto-tabified sections + `data-qs` quick-search links (preset diagnostic queries).
- Keyboard shortcuts: Cmd/Ctrl+K (focus query), Esc priority chain (modal → overlay → popup → clear filter), Arrow keys (modal nav).

### Tail
- Smart auto-scroll pause/resume.
- Auto-save every stream to `globalStorage/tails/*.ndjson` (FIFO-capped, empty streams pruned).
- Tail Files tab in History menu — list / load / delete.
- Configurable poll interval; auto-save can be disabled.

### Settings & maintenance commands
- 10 user settings under `paicLogSearch.*` (page size, tail cap / interval / autosave, search row cap, history limit, large-query threshold, custom-code rules, highlight rules, environments).
- `PAIC Log Search: Reveal Saved Tail Files Folder` command.
- `PAIC Log Search: Reset UI Preferences` command (clears webview localStorage).

### Security
- Strict CSP — no inline event handlers, no CDN scripts.
- Credentials only flow webview→host (one-way), via dedicated env-editor webview; search panel never receives credentials.
- No telemetry, no analytics, no third-party connections.

[Unreleased]: https://github.com/bostonidentity/ping-aic-logs-vscode/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/bostonidentity/ping-aic-logs-vscode/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/bostonidentity/ping-aic-logs-vscode/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/bostonidentity/ping-aic-logs-vscode/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/bostonidentity/ping-aic-logs-vscode/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/bostonidentity/ping-aic-logs-vscode/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/bostonidentity/ping-aic-logs-vscode/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bostonidentity/ping-aic-logs-vscode/releases/tag/v0.1.0
