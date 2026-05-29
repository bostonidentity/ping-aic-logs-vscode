# Architecture

## Two processes, one channel

VS Code extensions run in **two separate JavaScript contexts**:

```
┌──── Extension host (Node.js, full file/network/VSCode API) ─────┐
│  src/extension.ts        Activation + command registration       │
│  src/panel.ts            Search-panel webview lifecycle,         │
│                          message router, tail polling,           │
│                          tail file storage, save dialog          │
│  src/envEditor.ts        Dedicated env add/edit webview          │
│  src/paicClient.ts       HTTPS calls to PAIC Logs API            │
│  src/config.ts           Settings + SecretStorage                │
│  src/history.ts          globalState + in-memory session cache   │
│  src/treeView.ts         Activity-bar tree (env list)            │
│  src/types.ts            Discriminated-union message protocol    │
└────────────────┬────────────────────────────────────────────────┘
                 │ postMessage (typed; see types.ts)
┌────────────────▼────────────────────────────────────────────────┐
│  Two webviews (sandboxed iframes, no Node, strict CSP)           │
│  ┌─ Search panel ────────────────────────────────────────────┐  │
│  │  media/webview/main.js  + styles.css                       │  │
│  │  Bridge to host, no direct fetch                           │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌─ Env editor ──────────────────────────────────────────────┐   │
│  │  media/envEditor/main.js + styles.css                      │   │
│  │  Add/edit form; only place credentials cross postMessage   │   │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Why this split?

- The webview cannot access `node:fs`, `node:net`, environment variables, or the user's keychain. Anything sensitive (API secrets) or system-level (HTTP requests, secret storage) **must** live in the extension host.
- The webview gets a stable HTML/CSS/JS environment where UI logic can iterate without touching VS Code-specific API.

## Multi-tab model

The search panel is **not a singleton**. `LogSearchPanel.create()` always news up a fresh `vscode.window.createWebviewPanel`. Each tab is its own VS Code panel with its own webview iframe.

Per-tab state (independent across tabs):
- All entries of the current session
- `SearchSessionCache` (LRU 20 sessions for that panel)
- Active filters / dedup / customCode toggles
- Modal index, search nav stack
- Active tail streams (`AbortController` map)

Shared across tabs (same webview origin / same VS Code installation):
- `localStorage` UI preferences (`paic_*` keys)
- `globalStorage/tails/` archive (any tab can browse and load)
- `globalState` search history
- OS keychain credentials

Closing a tab disposes its panel, which:
- Aborts any active tail streams
- Drops the in-memory `SearchSessionCache`
- Disposes registered subscriptions

See [DATA_STORAGE.md](DATA_STORAGE.md) for a full per-layer table.

## Webview-side full-set pagination

Key architectural choice. After `search`, the host sends the **entire** session's entries in a single `searchResult` message (sized up to the 50k row cap). The webview then:

- Slices for the current page (default 100 rows, configurable from the page-size dropdown)
- Applies all local filters / dedup / customCode / level filter on the **full set**, not the slice
- Computes pagination off the post-filter total

This eliminates the "filter only sees the current page" pitfall the original tool used to have. Memory budget: 50k entries × ~1 KB ≈ 50 MB worst case per panel — acceptable for the target tenant sizes; tunable via the `maxRows` parameter in `paicClient.search()`.

`getPage` / `pageResult` exist for protocol completeness but are rarely fired with this design.

## Message protocol

All cross-context communication goes through `postMessage` with discriminated-union types defined in [`src/types.ts`](../src/types.ts). The full list lives in [API.md](API.md). Sketch:

| Direction | Type             | Purpose                              |
|-----------|------------------|--------------------------------------|
| W → H     | `getEnvironments`/`listSources` | Initial handshake / dropdown |
| W → H     | `search` / `getPage`            | Fetch / paginate              |
| W → H     | `startTail` / `stopTail`        | Live polling lifecycle        |
| W → H     | `saveResults` / `listTailFiles` / `loadTailFile` / `deleteTailFile` | File ops |
| W → H     | `getHistory` / `addHistory` / `deleteHistory` / `clearHistory`     | History       |
| W → H     | `setTitle`        | Update tab title                    |
| H → W     | `environments`/`sourceList`      | Reply to handshake / dropdown |
| H → W     | `searchResult` / `pageResult`    | Result data                   |
| H → W     | `tailBatch` / `tailEnded`        | Streaming events              |
| H → W     | `tailFiles`/`tailFileLoaded`/`tailFileDeleted`/`savedResults` | File-op replies |
| H → W     | `history` / `setInitialEnv` / `error` | History / startup / errors |

## Credential flow

```
User clicks "Add Environment"
        ↓
extension.ts opens EnvEditorPanel (dedicated webview form)
        ↓
User fills name/url/key/secret → submit
        ↓
Webview posts { type: 'submit', payload: { name, url, key, secret } } to host
        ↓
EnvEditorPanel resolves its Promise with the form value, disposes immediately
        ↓
extension.ts splits the input:
  - {name, url}   → workspace settings (paicLogSearch.environments)
  - {key, secret} → SecretStorage under "pingAicLogs.secret.<name>"
```

After that:
- The **search panel** never receives credentials. To run a search, panel.ts loads the secret from SecretStorage on demand and passes it to `PaicClient`. The webview only knows the env name.
- For **edits**, the host pre-fills the editor with `{ name, url }` only. The existing keychain key/secret are not displayed. "Blank-to-keep" semantics let users rotate by entering new values, or preserve by leaving fields empty.

This means there are **two CSP rules**:
- Search panel: standard (no `connect-src`); credentials never cross postMessage in either direction.
- Env editor: same CSP, but allows credential text in the **webview→host** direction only — host→webview never includes secrets.

## Tail flow

```
Webview → startTail
        ↓
panel.ts:
  - generates streamId, creates AbortController
  - allocates filePath = globalStorage/tails/tail-<env>-<startTs>.ndjson
  - upserts TailFileMeta in index.json, evicts oldest if > 20
  - starts: for await (batch of paicClient.tail({ source, query, signal }))
        ↓
For each batch:
  - postMessage tailBatch to webview
  - append batch entries (one JSON per line) to filePath
  - update meta.count + meta.endTime, persist index.json
        ↓
Webview shows entries (smart auto-scroll)
        ↓
On stop / panel dispose / error:
  - AbortController.abort()
  - postMessage tailEnded with reason
  - if count == 0, delete the file + remove from index (prune empty streams)
```

Polling cadence is 5s (hard-coded; configurable setting on roadmap).

## PAIC API client

`paicClient.ts` wraps three endpoints:

| Endpoint                                     | Method | Purpose                |
|----------------------------------------------|--------|------------------------|
| `GET /monitoring/logs/sources`               | GET    | List available sources |
| `GET /monitoring/logs?source=...&...`        | GET    | Query / paginate logs  |
| `GET /monitoring/logs/tail?source=...&...`   | GET    | Tail polling endpoint  |

Authentication: two custom headers, `X-API-Key` and `X-API-Secret`. No OAuth, no token refresh.

The `_queryFilter` builder lives in `paicClient.buildQueryFilter()` with per-source field heuristics in `SOURCE_SEARCH_FIELDS` — different sources have different searchable fields (e.g. `idm-core` searches `/payload`, `am-authentication` searches a list of journey/event fields).

## Activation events

```jsonc
"activationEvents": [
  "onView:paicLogSearch.environments"
]
```

The extension activates when the user opens the activity-bar tree, not at VS Code startup. Cold-start cost is negligible.

## See also

- [API.md](API.md) — full message protocol reference
- [DATA_STORAGE.md](DATA_STORAGE.md) — where state lives
- [SECURITY.md](SECURITY.md) — credential / threat model
- [`src/types.ts`](../src/types.ts) — authoritative protocol schema
