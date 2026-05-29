# Message protocol reference

The webview ↔ extension host channel is a **discriminated-union typed bus**. The full schema lives in [`src/types.ts`](../src/types.ts) — that's the source of truth; this doc is the human-readable mirror.

## Direction conventions

- **W → H** : Webview sends to extension host.
- **H → W** : Host sends to webview.

All messages have shape `{ type: '<name>', payload?: <typed> }`. Payload is omitted when the type alone is sufficient (e.g. `getEnvironments`, `getHistory`).

## Adding a new message

Adding a new message requires updates in **3 places**:

1. **`src/types.ts`** — add the discriminant + payload to the appropriate union (`WebviewToHostMessage` or `HostToWebviewMessage`).
2. **`src/panel.ts`** — `handleMessage` switch statement (W→H types). TypeScript exhaustiveness checking will fail compile if you skip this.
3. **`media/webview/main.js`** — `window.addEventListener('message', …)` (H→W types).

Then update this doc.

---

## W → H messages

### `getEnvironments`

Webview wakeup ping. Host responds with `environments`. If the panel was opened with an initial env (sidebar click), host also sends `setInitialEnv`.

```ts
{ type: 'getEnvironments' }
```

### `listSources`

Ask host to fetch the source list for an environment from PAIC. Useful for dynamically populating the source dropdown rather than relying on the hard-coded list.

```ts
{ type: 'listSources', payload: { env: string } }
```

Host responds with `sourceList`.

### `search`

Run a fresh search. Host queries PAIC, paginates, caches the full result set under a session id, and replies with `searchResult` containing the **entire** session (the webview paginates client-side).

```ts
{
  type: 'search',
  payload: {
    env: string,
    source: string,    // comma-joined list, e.g. 'idm-everything,am-everything'
    query: string,
    begin?: string,    // ISO 8601 UTC
    end?: string,
    limit?: number     // max rows across pages, default 50000
  }
}
```

### `getPage`

Fetch a different page of an existing search session (cached in host memory). With current architecture (full session sent up-front), this is rarely used — the webview slices the in-memory entries directly. Kept for compatibility.

```ts
{
  type: 'getPage',
  payload: { sessionId: string, page: number, pageSize: number }
}
```

Host responds with `pageResult`. If the session has been evicted (cache holds last 20), host responds with `error` instead.

### `startTail`

Begin a tail-mode poll loop on the host. The host polls `/monitoring/logs/tail` every 5s and posts `tailBatch` for any new entries. Each batch is also appended to disk at `globalStorage/tails/tail-<env>-<startTs>.ndjson`.

```ts
{
  type: 'startTail',
  payload: {
    env: string,
    source: string,
    query?: string,
    streamId?: string  // host-issues if omitted
  }
}
```

### `stopTail`

End an active tail stream. Host aborts the underlying fetch and posts `tailEnded`.

```ts
{ type: 'stopTail', payload: { streamId: string } }
```

### `getHistory`

Read the persisted search-history list. Host responds with `history`.

```ts
{ type: 'getHistory' }
```

### `addHistory`

Manually push an entry into history. (Searches automatically history-add already; this is for re-importing or programmatic use.)

```ts
{ type: 'addHistory', payload: HistoryEntry }
```

### `deleteHistory`

Remove the entry at given index. Re-emits updated `history`.

```ts
{ type: 'deleteHistory', payload: { index: number } }
```

### `clearHistory`

Wipe all history. Re-emits empty `history`.

```ts
{ type: 'clearHistory' }
```

### `saveResults`

Trigger a host-side `showSaveDialog`, then write the supplied entries to the chosen file. The selected file extension determines format (`.ndjson` → one JSON per line, `.json` → pretty-printed array). The `format` field is the default if the user picks an unrelated extension.

```ts
{
  type: 'saveResults',
  payload: { entries: LogEntry[], format?: 'ndjson' | 'json' }
}
```

Host responds with `savedResults` on success or `error`.

### `listTailFiles`

List all archived tail streams. Host reads `globalStorage/tails/index.json` and responds with `tailFiles`.

```ts
{ type: 'listTailFiles' }
```

### `loadTailFile`

Load a previously archived tail stream into the panel.

```ts
{ type: 'loadTailFile', payload: { name: string } }
```

Host reads the NDJSON file, parses each line, and responds with `tailFileLoaded`.

### `deleteTailFile`

Delete a tail file from disk and from the index.

```ts
{ type: 'deleteTailFile', payload: { name: string } }
```

Host responds with `tailFileDeleted`.

### `setTitle`

Update the VS Code panel tab title. Used by the webview to reflect current state (env, result count, tailing flag).

```ts
{
  type: 'setTitle',
  payload: { env?: string, count?: number, tail?: boolean }
}
```

Title format: `EnvName | <N> results [(tailing)]`. Falls back to `Ping AIC Logs` if env is empty.

---

## H → W messages

### `environments`

Current list of configured environments (from `paicLogSearch.environments` setting).

```ts
{ type: 'environments', payload: EnvironmentMeta[] }   // { name, url }[]
```

### `sourceList`

Reply to `listSources`.

```ts
{ type: 'sourceList', payload: string[] }
```

### `searchResult`

The **full** result set of a fresh search. With current architecture the webview holds all entries and paginates client-side — `pageSize` is set to `totalCount` and `pages` is always `1` for this message.

```ts
{
  type: 'searchResult',
  payload: {
    sessionId: string,
    totalCount: number,
    page: 0,
    pageSize: number,
    pages: number,
    entries: LogEntry[],
    truncated: boolean   // true if maxRows hit before PAIC returned all
  }
}
```

### `pageResult`

A specific page slice of an existing search session, returned by `getPage`.

```ts
{ type: 'pageResult', payload: SearchResultPage }
```

### `tailBatch`

New entries from an active tail stream.

```ts
{
  type: 'tailBatch',
  payload: { streamId: string, entries: LogEntry[] }
}
```

### `tailEnded`

The tail loop ended (user stopped, network error, panel closed, etc.).

```ts
{
  type: 'tailEnded',
  payload: { streamId: string, reason?: string }
}
```

`reason` values: `'user-stop'`, `'aborted'`, `'eof'`, or an error string.

### `history`

Current persisted history list.

```ts
{ type: 'history', payload: HistoryEntry[] }
```

### `tailFiles`

Reply to `listTailFiles`. Metadata only — entries are loaded on demand.

```ts
{ type: 'tailFiles', payload: TailFileMeta[] }
```

### `tailFileLoaded`

Reply to `loadTailFile`. Includes both the metadata and the parsed entries.

```ts
{
  type: 'tailFileLoaded',
  payload: { name: string, meta: TailFileMeta, entries: LogEntry[] }
}
```

### `tailFileDeleted`

Reply to `deleteTailFile`. Webview removes the row from the Tail Files tab.

```ts
{ type: 'tailFileDeleted', payload: { name: string } }
```

### `savedResults`

Reply to `saveResults` after a successful write.

```ts
{
  type: 'savedResults',
  payload: { path: string, count: number }
}
```

### `setInitialEnv`

Sent immediately after `environments` if the panel was opened with a specific env (sidebar click). Webview pre-selects that env in the dropdown.

```ts
{ type: 'setInitialEnv', payload: { env: string } }
```

### `error`

Generic error from any host-side handler. Webview should display via UI banner.

```ts
{
  type: 'error',
  payload: { message: string, context?: string }
}
```

---

## Common shapes

```ts
interface LogEntry {
  timestamp?: string;
  source?: string;
  payload?: unknown;
  type?: string;
  [key: string]: unknown;
}

interface EnvironmentMeta {
  name: string;
  url: string;
}

interface HistoryEntry {
  timestamp: number;     // epoch ms when search ran
  env: string;
  source: string;
  query: string;
  begin?: string;
  end?: string;
  totalCount?: number;
}

interface SearchResultPage {
  sessionId: string;
  totalCount: number;
  page: number;
  pageSize: number;
  pages: number;
  entries: LogEntry[];
  truncated: boolean;
}

interface TailFileMeta {
  name: string;       // filename relative to globalStorage/tails/
  env: string;
  source: string;
  query: string;
  startTime: number;  // epoch ms
  endTime: number;    // epoch ms
  count: number;      // entries written
}
```

## Env editor protocol

The env-editor webview (`src/envEditor.ts` + `media/envEditor/main.js`) uses a **separate, much smaller** message protocol:

```ts
// webview → host
type FromWebview =
  | { type: 'submit'; payload: { name: string; url: string; key: string; secret: string } }
  | { type: 'cancel' };
```

Architectural exception: the search-panel "credentials never cross postMessage" rule does **not** apply here — this form *is* the credential input source. Flow is one-way (webview → host) and the panel disposes immediately on submit/cancel. See [SECURITY.md](SECURITY.md).

## See also

- [ARCHITECTURE.md](ARCHITECTURE.md) — why we have two processes
- [`src/types.ts`](../src/types.ts) — authoritative TypeScript schema
- [DATA_STORAGE.md](DATA_STORAGE.md) — where state lives
