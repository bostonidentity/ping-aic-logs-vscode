# Roadmap

This is **non-binding direction**, not a commitment. Open issues / PRs to push priorities.

## Shipped — v0.1.x

### Core search & tail
- ✅ Multi-environment management (add / **edit** / delete via sidebar; secrets in OS keychain)
- ✅ Search with per-source `_queryFilter` heuristics
- ✅ Multi-source picker (IDM / AM / Other groups, with `*-everything` ↔ individuals mutual exclusion)
- ✅ Log level dropdown
- ✅ Three time modes: **Recent** (with quick buttons + custom unit), **Range** (datetime to second precision), **Around** (±N around a center time, before/after/both)
- ✅ Datetime helpers: double-click = Now, paste auto-detects 6 formats (ISO / US / epoch ms/s)
- ✅ Tail mode (5s polling, smart auto-scroll pause/resume)
- ✅ Search history (last 100, dedup-on-add, persisted)

### Result rendering
- ✅ Per-source semantic single-line summary templates (11+ branches: AM-NODE-LOGIN-COMPLETED, AM-TREE-LOGIN-COMPLETED, AM-LOGIN, AM-LOGOUT, AM-SESSION*, AM-IDENTITY-CHANGE, AM-ACCESS-*, idm-access, idm-activity, idm-sync, am-core, generic fallback)
- ✅ Raw mode toggle (full entry JSON, multi-line, wrapped)
- ✅ Sortable Time column
- ✅ Resizable columns + width persistence
- ✅ Locate-highlight on selected row (survives sort / filter / pagination)
- ✅ Click time cell → copy timestamp; double-click row → copy payload
- ✅ Log keyword highlighting (8 default rules: SUCCESSFUL/FAILED/Exception/WARN/CRUD/4xx-5xx/true/false; `[LEVEL]` tag protection)
- ✅ UTC ↔ Local time toggle (with millisecond precision)

### Filtering
- ✅ Local filter chips (live single-term + Enter promotes to permanent chip; multi-term AND)
- ✅ Exclude word chips
- ✅ Field-level filter dialog (+Field button; auto-extracts fields & values by frequency)
- ✅ Dedup mode (clickable ×N badge excludes that payload group)
- ✅ Custom code mode (filter to scripts/endpoints; 30+ noise-pattern excludes)
- ✅ Filter chips row with × to remove individually; Clear All wipes everything

### Modal & navigation
- ✅ Modal entry detail: title shows `#idx/total ts [source]` with click-to-copy timestamp, copy button with feedback, prev/next + arrow keys
- ✅ Cross-page modal navigation (auto-flip table page when navigating across boundary)
- ✅ Format mode: deep-clone, `findBalancedJson` brace-counter expansion of embedded-JSON, iterative unescape for double-escaped, stack-trace `\n\tat` formatting
- ✅ `_json` block green highlight + search keyword yellow + filter words cyan + log keyword colors
- ✅ Wrap toggle for long-line content
- ✅ Related searches dropdown (15+ diagnostic templates: transactionId / trackingId / userActivity / treeNodes / errors / etc., grouped by Trace / Auth Tree / User / Object / Context / Diagnostics; per-template editable window in seconds, persisted)

### Productivity
- ✅ ETA tooltip on Search hover (sample-based prediction, color-coded: green <2s / orange <10s / red ≥30s)
- ✅ CLI button — copy equivalent `paic-logs search` command to clipboard
- ✅ Save export to file (NDJSON or JSON, host-side `showSaveDialog`)
- ✅ Quick-search links in Help dialog (`data-qs` JSON, auto-fill source/query/level/time/filter then run)
- ✅ Help dialog auto-tabified (h3 sections become tabs at runtime, fixed dialog size, sticky tab bar)
- ✅ Search navigation back/forward stack (browser-style, persisted to sessionStorage; max 50 entries)
- ✅ Cmd/Ctrl+K to focus query
- ✅ Esc handles modal / overlay / popups in priority order; Arrow keys navigate modal entries
- ✅ Float-nav buttons for top/bottom scroll

### Tail file management
- ✅ Auto-save every tail stream to `globalStorage/tails/*.ndjson` + `index.json`
- ✅ FIFO eviction at 20 files; empty streams auto-pruned
- ✅ Tail Files tab in History menu — list / load / delete

### Multi-tab
- ✅ Each sidebar env click opens a new tab (multiple tabs per env allowed)
- ✅ Per-panel state isolation; new tab opens with default form (no cross-tab leakage)
- ✅ Tab title updates dynamically: `DEV2 | 3359 results (tailing)`

### Safety / quality
- ✅ Large-query confirmation dialog (no keyword + range > 30 minutes)
- ✅ Custom mode auto-resets at start of every search
- ✅ History dedup-on-add (top entry replaced if env+source+query+range identical)
- ✅ Strict CSP (no inline handlers, no CDN deps); credentials only flow webview → host

### Technical posture
- ✅ Type-checks clean (`tsc --noEmit`)
- ✅ Lint clean (0 warn, 0 err)
- ✅ Bundle ≈ 60 kb (under 100 kb budget)
- ✅ ~22 message types, fully discriminated-union typed

---

## v0.2.x — short-term backlog

| Feature | Why |
|---|---|
| Configurable highlight rules (`paicLogSearch.highlightRules`) | Teams have different signal/noise priorities |
| Configurable custom-code rules | IDM platform noise patterns vary by deployment |
| `paicLogSearch.tailFileCap` (default 20) | Disk-conscious users want lower; long-incident users want higher |
| `paicLogSearch.tailPollInterval` (default 5s) | Network-conscious deployments |
| Tests (unit for paicClient + integration for protocol) | Currently zero coverage |
| `idm-everything` smart split | Auto-add per-sub-source filters for granular results |

## v0.3.x — power features

| Feature | Why |
|---|---|
| Search by raw `_queryFilter` directly | Power users want to bypass heuristic translator |
| Saved searches (named templates) | Per-team reusable diagnostic queries |
| Field filter operators (contains / not / exists) | Currently only `equals` |
| Per-tab `vscode.setState` for restore on reload | Currently localStorage is shared across tabs |
| Cache-check before re-running search | Skip refetch when session still in memory |
| Highlight match indicator in row count | "12/100 with keyword 'ERROR'" |

## v1.0 — stable

- Full keyboard navigation
- Accessibility audit
- i18n (currently en-only)
- Stable schema + semver guarantee for all `paicLogSearch.*` settings
- Marketplace publish (set publisher id)
- Telemetry-free promise documented
- CHANGELOG.md from v0.1 onward

## Explicitly NOT planned

- ❌ **Journey / Auth-Tree visualization** — depends on local frodo exports, unclear value to open-source users. Use [frodo-cli](https://github.com/rockcarver/frodo-cli) directly.
- ❌ **Embedded script editor** — VS Code itself is a perfectly good editor.
- ❌ **Full-text indexing on client** — that's what PAIC server-side `_queryFilter` is for.
- ❌ **Cross-tenant aggregation** — one tab = one tenant. Open multiple tabs if you need to compare.
- ❌ **Telemetry of any kind** — explicit project policy.

## Performance budgets

| Metric | Target | Current |
|---|---|---|
| Cold-start activation | < 50 ms | ✅ |
| First-paint of search results | < (PAIC API time + 100 ms render) | ✅ |
| Memory (steady state) | < 50 MB | ⚠️ may exceed when session has many tens of thousands of entries — webview holds full set for client-side pagination |
| Bundle size (out/extension.js) | < 100 kb minified | ✅ ≈ 60 kb |

## Backward compatibility

Once v0.2 ships:
- `paicLogSearch.environments` setting schema is stable; additions only.
- SecretStorage keys (`pingAicLogs.secret.<name>`) — stable.
- Webview ↔ host message protocol — additions only; no field removal.
- `globalStorage/tails/index.json` schema — additions only.

Breaking changes will follow semver and be documented in [CHANGELOG.md](../CHANGELOG.md).

## See also

- [USER_GUIDE.md](USER_GUIDE.md) — end-user feature reference
- [API.md](API.md) — webview ↔ host message protocol
- [ARCHITECTURE.md](ARCHITECTURE.md) — design overview
