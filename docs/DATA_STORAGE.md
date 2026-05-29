# Data storage reference

Where every piece of state the extension owns actually lives, per layer.

This is the canonical reference for "where is X stored" questions. Cross-linked from [USER_GUIDE.md](USER_GUIDE.md), [SECURITY.md](SECURITY.md), and [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Summary

| # | Layer                          | Scope                | Sensitive? |
|---|--------------------------------|----------------------|------------|
| 1 | Workspace settings             | Workspace            | No         |
| 2 | OS keychain (SecretStorage)    | VS Code installation | **Yes**    |
| 3 | `globalStorage/search-history.json` | VS Code installation | No    |
| 4 | `globalStorage/tails/` files   | VS Code installation | Possibly   |
| 5 | Webview `localStorage`         | Per-webview origin   | No         |
| 6 | Webview `sessionStorage`       | Per-tab              | No         |
| 7 | In-memory `SearchSessionCache` | Per-panel            | No         |

---

## 1. Workspace settings — `paicLogSearch.environments`

| | |
|---|---|
| **What** | Array of `{ name: string, url: string }` |
| **Where** | Workspace `.vscode/settings.json` (or user `settings.json` if no workspace open) |
| **Format** | JSON |
| **Lifetime** | Until edited / removed manually or via the sidebar |
| **Cleanup** | Sidebar trash icon, or edit `settings.json` directly |
| **Sensitive?** | No — only display names + tenant URLs |

Credentials are explicitly **not** stored here (see Layer 2). Only metadata.

## 2. OS keychain via SecretStorage

| | |
|---|---|
| **What** | `EnvironmentSecret` = `{ key: string, secret: string }` per env |
| **Key** | `pingAicLogs.secret.<envName>` |
| **Where (per OS)** | macOS: Keychain Access ▸ login keychain<br>Windows: Credential Manager ▸ Generic Credentials<br>Linux: libsecret (gnome-keyring / KWallet) |
| **Format** | JSON-encoded blob, OS-encrypted at rest |
| **Lifetime** | Until env is deleted via sidebar (deletion removes the keychain entry too) |
| **Cleanup** | Delete env in sidebar; or remove the keychain entry manually using your OS tools |
| **Sensitive?** | **Yes** — never logged, never serialized over postMessage in the search-panel direction |

The env-editor webview is the *only* place credentials cross postMessage (webview→host on submit; the editor disposes immediately). See [SECURITY.md](SECURITY.md).

## 3. `globalStorage/search-history.json` — search history

| | |
|---|---|
| **What** | `HistoryEntry[]` — env, source, query, begin, end, totalCount, timestamp; capped at `paicLogSearch.searchHistoryLimit` (default 100) |
| **Where (per OS)** | macOS: `~/Library/Application Support/Code/User/globalStorage/<publisher>.ping-aic-logs/search-history.json`<br>Linux: `~/.config/Code/User/globalStorage/<publisher>.ping-aic-logs/search-history.json`<br>Windows: `%APPDATA%\Code\User\globalStorage\<publisher>.ping-aic-logs\search-history.json` |
| **Format** | Pretty-printed JSON array (2-space indent), newest entry first |
| **Lifetime** | Bounded ring (oldest evicted at limit); dedup-on-add for identical (env, source, query, range) |
| **Cleanup** | History menu ▸ **Searches** tab ▸ **Clear All**; sidebar Recent Searches × to delete one row; or delete the file manually |
| **Sensitive?** | No — query strings only; no credentials |
| **Migration** | v0.1.0 stored history under `pingAicLogs.searchHistory` in `globalState` (SQLite). On first launch of v0.1.1+, those entries are migrated into `search-history.json` and the legacy globalState key is cleared. |

The same directory also holds `tails/` (saved tail streams — see §4) and the env-editor's small webview state. You can browse it via the **PAIC Log Search: Reveal Saved Tail Files Folder** command, then go up one level.

## 4. `globalStorage/tails/` — tail file archive

| | |
|---|---|
| **What** | One NDJSON file per tail stream + `index.json` metadata file |
| **Where (per OS)** | macOS: `~/Library/Application Support/Code/User/globalStorage/<publisher>.ping-aic-logs/tails/`<br>Linux: `~/.config/Code/User/globalStorage/<publisher>.ping-aic-logs/tails/`<br>Windows: `%APPDATA%\Code\User\globalStorage\<publisher>.ping-aic-logs\tails\` |
| **Files** | `tail-<env>-<startTs>.ndjson` (one JSON entry per line) + `index.json` (`TailFileMeta[]`) |
| **Lifetime** | FIFO 20 streams; empty streams pruned on stop |
| **Cleanup** | History menu ▸ **Tail Files** tab ▸ × to delete one, or **Clear All**; or delete the directory contents manually |
| **Sensitive?** | Possibly — raw log payloads can contain identifiers, IPs, transactionIds. Stored **unencrypted** with same OS-level access controls as the user data dir. |

> `<publisher>` is `BostonIdentity` (matches `package.json`).

A future setting `paicLogSearch.tailAutoSave` will allow disabling tail-to-disk archiving. See [ROADMAP.md](ROADMAP.md).

## 5. Webview `localStorage` — UI preferences (9 keys, all `paic_*`)

| Key                     | Purpose                                                |
|-------------------------|--------------------------------------------------------|
| `paic_local_time`       | UTC ↔ Local toggle in result table                     |
| `paic_modal_wrap`       | Modal Wrap toggle                                      |
| `paic_modal_format`     | Modal Format toggle (default ON)                       |
| `paic_dedup`            | Dedup mode toggle                                      |
| `paic_custom_code`      | Custom code mode toggle (gets reset on every search)   |
| `paic_raw`              | Raw JSON column toggle                                 |
| `paic_col_widths`       | JSON map of resized column widths                      |
| `paic_query_samples`    | Search-time samples per (env, sources, hasQuery, log10(rangeSec)) bucket; powers the ETA tooltip |
| `paic_related_windows`  | Per-template Related-search window seconds, persisted  |

| | |
|---|---|
| **Format** | One key per setting; values are JSON strings or scalars |
| **Lifetime** | Persists across panel close, VS Code restart |
| **Scope** | Per-webview origin — **shared across all panel tabs** |
| **Cleanup** | Until a "Reset UI Preferences" command lands, manually clear via DevTools (Help ▸ Toggle Developer Tools ▸ Application ▸ Local Storage ▸ remove `paic_*` keys) |
| **Sensitive?** | No — toggle states and column widths only |

## 6. Webview `sessionStorage` — search nav stack

| | |
|---|---|
| **Key** | `paic_search_stack` |
| **What** | Browser-style Back/Fwd entries (max 50): `{ env, source, query, begin, end }[]` plus current index |
| **Lifetime** | Per-tab; **cleared when the tab closes** |
| **Cleanup** | Closing the tab; or DevTools ▸ Application ▸ Session Storage |
| **Sensitive?** | No |

## 7. In-memory `SearchSessionCache`

| | |
|---|---|
| **What** | LRU of last 20 search sessions (full entry arrays) keyed by `sessionId` |
| **Where** | Extension-host process heap, scoped to the panel instance |
| **Lifetime** | Cleared when the panel disposes (close tab) |
| **Cleanup** | Closing the panel |
| **Sensitive?** | No (raw log payloads — same sensitivity as Layer 4 if you screen-shared) |

Each panel has its own cache. Closing a tab loses its session memory, which is why "session expired" can show after re-opening — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## How to inspect raw state

```bash
# macOS — open the tail-file folder
open ~/Library/Application\ Support/Code/User/globalStorage/<publisher>.ping-aic-logs/tails/

# Linux
xdg-open ~/.config/Code/User/globalStorage/<publisher>.ping-aic-logs/tails/

# Windows (PowerShell)
explorer "$env:APPDATA\Code\User\globalStorage\<publisher>.ping-aic-logs\tails\"

# View / edit history directly (it's plain JSON):
cat ~/Library/Application\ Support/Code/User/globalStorage/<publisher>.ping-aic-logs/search-history.json

# OS keychain (macOS) — find the per-env entry
security find-generic-password -s 'pingAicLogs.secret.<envName>' -w
# (do not print this in screen recordings — it's the raw API secret)
```

For webview-scoped storage (`localStorage` / `sessionStorage`), open the webview's DevTools: **Help → Toggle Developer Tools** while the panel is focused, then go to the **Application** tab.

## See also

- [USER_GUIDE.md](USER_GUIDE.md) — feature-level reference
- [SECURITY.md](SECURITY.md) — threat model and credential flow
- [ARCHITECTURE.md](ARCHITECTURE.md) — process boundaries
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — "where did my X go?" questions
