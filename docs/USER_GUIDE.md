# User Guide

End-user documentation for the **Ping AIC Logs** VS Code extension.

## Table of contents

- [Adding / editing an environment](#adding--editing-an-environment)
- [Multi-tab](#multi-tab)
- [Running a search](#running-a-search)
  - [Sources](#sources)
  - [Search syntax](#search-syntax)
  - [Time range](#time-range)
  - [ETA tooltip](#eta-tooltip)
  - [CLI button](#cli-button)
- [Tail mode](#tail-mode)
- [Tail file management](#tail-file-management)
- [Search history](#search-history)
- [Search navigation (Back / Forward)](#search-navigation-back--forward)
- [Filtering](#filtering)
  - [Local filter chips](#local-filter-chips)
  - [Exclude chips](#exclude-chips)
  - [+Field filter dialog](#field-filter-dialog)
  - [Dedup mode](#dedup-mode)
  - [Custom code mode](#custom-code-mode)
- [Entry detail modal](#entry-detail-modal)
  - [Format toggle](#format-toggle)
  - [Wrap toggle](#wrap-toggle)
  - [Related searches](#related-searches)
- [Save / export](#save--export)
- [Quick searches (Help dialog)](#quick-searches-help-dialog)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings reference](#settings-reference)
- [Storage layers](DATA_STORAGE.md)
- [Troubleshooting](TROUBLESHOOTING.md)

---

## Adding / editing an environment

1. Click the **search** icon in the activity bar (left edge of VS Code) → **Ping AIC Logs** view appears.
2. Click the **+** icon at the top right of the **Environments** view.
3. The **Environment Editor** opens as a dedicated webview form (not a single-line InputBox). Fields:
   - **Name** — display label (e.g. `UAT`, `PROD`).
   - **URL** — tenant base URL, e.g. `https://your-tenant.forgeblocks.com`. **No trailing slash.**
   - **Log API key** — from PAIC admin → *Tenant Settings → Log API Keys*. Header `x-api-key`.
   - **Log API secret** — paired with the above. Header `x-api-secret`.

The **name + URL** are persisted to workspace settings (visible in `settings.json` under `paicLogSearch.environments`). The **key + secret** are stored in the OS keychain (VS Code SecretStorage). See [DATA_STORAGE.md](DATA_STORAGE.md) for layer-by-layer detail.

### Editing

Hover the env in the sidebar → click the pencil icon. The editor opens pre-filled with name + URL only — the existing key/secret are not displayed. **Blank-to-keep semantics:** leave key or secret empty to preserve the existing keychain value, or fill them in to rotate.

### Deleting

Hover → trash-can icon. Confirms via modal then removes both the workspace-settings entry and the keychain secret.

---

## Multi-tab

Every click on an environment in the sidebar opens a **new panel tab**. There is no singleton — opening the same env twice gives you two independent tabs.

- **Per-tab state**: each tab has its own search query, results, filters, modal index, search nav stack. State changes in one tab do not affect another.
- **Shared across tabs** (per-webview origin scope): UI preferences in `localStorage` (UTC toggle, column widths, format/wrap toggles), search-time samples for the ETA tooltip, Related-search window prefs.
- **Tab title** updates live: `EnvName | <N> results` (or `EnvName | <N> results (tailing)` while a tail is active). Empty result count shows just the env name.

Use multi-tab to compare different queries side by side, or to keep a tail running in one tab while searching in another.

---

## Running a search

1. Click an environment in the sidebar **or** open the panel via *Command Palette → `PAIC Log Search: Open Search Panel`*.
2. Pick one or more **sources** from the source picker (default `idm-everything` + `am-everything`). Choosing `*-everything` mutually-excludes the corresponding individual sources, and vice versa.
3. (Optional) pick a **log level** (default ALL).
4. (Optional) type a **keyword**.
5. Pick a **time range**.
6. Click **Search** (or press `Enter` while focus is in the keyword box, or `Cmd/Ctrl+K` then `Enter`).

If the time range exceeds 30 minutes **and** the keyword is empty, a confirm dialog asks you to confirm the broad query. Cancel returns without firing.

### Sources

PAIC partitions logs by *source*. The most useful ones:

| Source              | What it captures                                             |
|---------------------|--------------------------------------------------------------|
| `idm-everything`    | All IDM logs (combines `idm-core`, `idm-access`, etc.)       |
| `am-everything`     | All AM logs (auth journeys, OAuth, SAML, sessions, …)        |
| `idm-core`          | IDM script logs (`logger.error/warn/info/debug` from JS)     |
| `idm-access`        | IDM endpoint requests (HTTP method, path, status, latency)   |
| `am-authentication` | Journey-tree node outcomes, login successes/failures         |
| `am-access`         | All AM HTTP requests (login pages, OAuth endpoints, …)       |
| `am-core`           | AM platform logs                                             |

Sources without `-everything` are narrower and faster.

### Search syntax

The keyword field does a substring search. Internally the extension constructs a CREST `_queryFilter` that matches against the **right field for the source you chose**:

- `idm-core` — matches against `/payload` (the raw text/plain log line)
- `am-authentication` — matches against `eventName`, `userId`, `transactionId`, `trackingIds`, `treeName`, `nodeId`, …
- See [`paicClient.ts`](../src/paicClient.ts) `SOURCE_SEARCH_FIELDS` for the full table

Notes:
- The query is **case-sensitive** on the PAIC side.
- Quotes inside the query are escaped automatically (`"` → `\"`).
- Empty query = match-all within the time range.
- Multi-word queries are sent **as one substring**, not tokenized.

### Time range

Three modes (tabs at the top of the time block):

| Mode    | Use                                                                |
|---------|--------------------------------------------------------------------|
| Recent  | now − N units (s/m/h) → now. Quick buttons: `5m`, `30m`, `1h`, `4h`, `24h` |
| Range   | Two `datetime-local` pickers, second precision                     |
| Around  | A center timestamp ± window (before / after / both)                |

Helpers on every datetime input:
- **Double-click** → set to Now.
- **Paste** auto-detects ISO 8601, `YYYY-MM-DD HH:MM[:SS]`, US-style, epoch ms, epoch s — and converts on the fly.

PAIC retains logs **30 days**. Searches older than that return empty.

### ETA tooltip

Hover the **Search** button to see a predicted query time, color-coded green/orange/red. The prediction comes from local samples bucketed by (env, sources, hasQuery, log10 of range seconds), stored in `localStorage` under `paic_query_samples`. It improves as you use the extension more.

### CLI button

The **CLI** button copies the equivalent `paic-logs search …` shell command (with the same env/source/query/range) to the clipboard. Useful for reproducing a query in scripts or sharing in a ticket.

---

## Tail mode

Click **Tail** to switch to live-polling mode. The extension polls `/monitoring/logs/tail` every 5 seconds and appends any new entries to the table.

- Active tail is indicated by the **Tail** button changing to **Stop** (highlighted), and `(tailing)` in the tab title.
- The query and source you set apply.
- **Smart auto-scroll**: while you're at the bottom of the table, new entries auto-scroll into view; if you scroll up to read older entries, auto-scroll pauses until you return to the bottom.
- Click **Stop** to end the stream. The session is automatically stopped if you close the panel.

Every tail stream is **auto-saved to disk** as it runs — see the next section.

> **Note:** PAIC's `/tail` endpoint returns a `pagedResultsCookie` after the first call which the extension uses to ask only for entries arrived since last poll. Initial poll usually returns zero entries — wait a few seconds for the system to produce new logs.

---

## Tail file management

Every tail stream auto-archives to `globalStorage/tails/tail-<env>-<startTs>.ndjson` (one JSON entry per line). The archive is FIFO with a cap of **20** streams; empty streams (no entries) are pruned on stop.

**Browse** archived tails: History menu → **Tail Files** tab. Each row shows env, source, query, time range, count.

- Click a row → loads the saved entries into the current tab as a non-tail result set.
- Click × on a row → deletes that file and removes its index entry.
- **Clear All** wipes every tail file at once.

For exact paths per OS see [DATA_STORAGE.md](DATA_STORAGE.md).

---

## Search history

History menu → **Searches** tab. Each entry stores env, source, query, time range, total count, and timestamp.

- Click an entry to **re-run** that search.
- Click × to delete that entry.
- **Clear All** wipes the entire history.
- The result count appears after the entry text (`— N entries`); zero-count rows are kept (a "no results" answer is itself diagnostic information) but visually de-emphasized.

History is stored in VS Code's `globalState` (cross-workspace, per VS Code installation). Capped at 100 entries with dedup-on-add for identical (env, source, query, range) tuples.

---

## Sidebar views

The PAIC Log Search activity-bar container shows three stackable views:

### Environments
Tree of configured tenants. **Click** to open a search tab for that env (each click opens a new tab — multi-tab is supported). Inline icons let you edit / delete an env. **Drag** an env to reorder the list (order persists into `paicLogSearch.environments`).

### Recent Searches
Last 20 entries from your search history, across all envs. Each row shows `EnvName  Query` with `count · relativeTime` in the muted description (`12 · 3m ago`). Click a row to open a panel for that env. Zero-result searches use a different icon (`circle-slash`) so they're visible but easy to skip.

Auto-refreshes when:
- A search completes (history `add`)
- An entry is deleted from any panel's history menu
- The view section is collapsed and re-opened

### Saved Tail Files
Every tail stream (when `paicLogSearch.tailAutoSave` is on, default true) is auto-saved to disk. This view lists them, newest first, with `EnvName  N entries  duration` and a relative-time description. Click a row to open a new panel and **auto-load** that tail file's content for replay/inspection. FIFO-capped at `paicLogSearch.tailFileCap` (default 20).

Auto-refreshes when:
- A tail starts or ends
- A tail file is deleted (from this view, the panel's Tail Files tab, or the eviction policy)
- The view section is collapsed and re-opened

The toolbar `🔄` button on either list manually refreshes both.

---

## Search navigation (Back / Forward)

The toolbar's `←` / `→` arrows step through your in-tab search stack — like a browser history.

- Stack lives in `sessionStorage` (per-tab), max 50 entries.
- Persists across page refresh of the same tab; **does not** survive closing the tab.
- Each successful search pushes; arrow clicks move without pushing.

---

## Filtering

All filters operate on the **full session set**, not just the current page. Pagination is purely a display slice.

### Local filter chips

The toolbar **Filter** input does a live substring filter (min 3 chars) across the result set. Press `Enter` to **promote** the current term to a permanent chip — multiple chips are AND-combined. Click × on a chip to remove it.

### Exclude chips

The **Exclude** input adds a word that hides any entry matching it. Press `Enter` to add. Removable via × on the chip.

### +Field filter dialog

Click **+Field** in the toolbar. The extension scans the current session and presents the most-frequent field paths and values, ordered by occurrence count. Pick a field → pick a value → adds a chip.

- Chips are AND-combined.
- Remove individual chips via ×.

### Dedup mode

Toggle **Dedup** to group identical payloads. Each group's first row gets a `×N` badge showing how many times that payload appears. **Click the badge** to add an exclude filter for that exact payload — quick way to suppress repeating noise.

### Custom code mode

Toggle **Custom**. Hides platform/framework log lines (30+ noise patterns) and shows only what looks like custom scripts/endpoints (e.g. ScriptedDecision, IDPAttributeMapper, custom IDM scripts).

> Custom mode **auto-resets at the start of every new search** so a stale toggle never silently hides results in a new query.

---

## Entry detail modal

Click any row to open the entry as a JSON-pretty modal.

- **Title bar**: `#idx/total ts [source]`. Click the timestamp to copy it. **Copy** button copies the full raw entry; **×** or `Esc` closes.
- **Prev / Next** (or `↑` / `↓` / `←` / `→`) — step through entries; auto-flips the table page at boundaries.

### Format toggle

Default ON. When ON, the modal does:

- Deep-clone the entry to avoid mutating the table data.
- `findBalancedJson` brace-counter expansion: any string that *is* a JSON object/array (even with embedded escapes) becomes a real nested structure rather than a `"..."` string. Brace counter tracks string state so `{` / `}` inside string values don't break depth.
- Iterative unescape for double-escaped strings.
- Stack-trace formatting (`\n\tat …`).
- Highlight passes (in order): `_json` blocks green, search keyword yellow, filter chips cyan, log-level keywords (8 default rules: SUCCESSFUL/FAILED/Exception/WARN/CRUD/4xx-5xx/true/false; `[LEVEL]` tag protected from misclassification).

When OFF, the modal shows the raw entry JSON with no transformation.

### Wrap toggle

Default OFF. Wraps long single-line content (e.g. base64 blobs, long URLs).

### Related searches

The **Related** dropdown in the modal header offers 15+ diagnostic templates grouped by:

- **Trace** — same transactionId, same trackingIds (one HTTP call vs. one journey)
- **Auth Tree** — all nodes in this tree, same treeName
- **User** — same userId, same principal
- **Object** — same objectId
- **Context** — same source ±N seconds, errors ±N seconds
- **Diagnostics** — exceptions ±N, warnings ±N

Each template has an editable **window seconds** input next to it. The chosen window is **persisted** under `paic_related_windows` in `localStorage` and applies to future opens of the same template.

Selecting a template runs a Range search ±N seconds around the entry's timestamp using the matched field/value.

---

## Save / export

Click **Save** in the toolbar. A native **Save File** dialog opens.

- Pick `.ndjson` (one JSON per line — recommended for streaming/jq) or `.json` (single pretty-printed array).
- The exported file contains every entry in the **current session**, regardless of pagination.
- The selected extension wins if you change it in the dialog.

---

## Quick searches (Help dialog)

Click **?** to open the Help dialog. The dialog auto-tabifies (`<h3>` headings become tabs).

The **Quick Searches** tab has rows with a **Run** link (powered by inline `data-qs` JSON). Click **Run** to auto-fill source / keyword / level / time / filter and immediately execute the search.

---

## Keyboard shortcuts

| Key                                    | Effect                                                |
|----------------------------------------|-------------------------------------------------------|
| `Cmd/Ctrl+K`                           | Focus the keyword input                               |
| `Enter` (in keyword)                   | Run search                                            |
| `Enter` (in local filter)              | Promote current term to a chip                        |
| `Enter` (in exclude)                   | Add an exclude word chip                              |
| `Esc`                                  | Priority chain: close modal → close overlay → close popup → clear filter |
| `↑` / `↓` / `←` / `→` (in modal)      | Prev / Next entry (cross-page)                        |
| Double-click datetime                  | Set to Now                                            |
| Double-click row                       | Copy that entry's payload                             |
| Click time cell                        | Copy that timestamp                                   |

---

## Settings reference

User/workspace settings under `paicLogSearch.*` (edit via `settings.json` or the Settings UI):

```jsonc
{
  // Environments. Sensitive credentials are NOT stored here — they live in
  // VS Code's SecretStorage. Adding/removing environments is best done via
  // the sidebar (+ button) which prompts for credentials too.
  "paicLogSearch.environments": [
    { "name": "UAT",  "url": "https://uat-tenant.forgeblocks.com" },
    { "name": "PROD", "url": "https://prod-tenant.forgeblocks.com" }
  ]
}
```

Planned settings (see [ROADMAP.md](ROADMAP.md)):

- `paicLogSearch.tailFileCap` — change the FIFO cap (default 20)
- `paicLogSearch.tailPollInterval` — change the 5s poll cadence
- `paicLogSearch.tailAutoSave` — disable tail-to-disk archiving
- `paicLogSearch.highlightRules` — custom log-level highlight rules
- Reset UI Preferences command — wipe `paic_*` localStorage keys

---

## See also

- [DATA_STORAGE.md](DATA_STORAGE.md) — where every piece of state lives
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — common errors
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the extension is built (for contributors)
- [SECURITY.md](SECURITY.md) — credential handling, threat model
