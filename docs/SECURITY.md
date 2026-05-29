# Security model

## Threat model

This extension runs **inside VS Code** on a developer's workstation. The threat surface is small but worth being explicit about.

### Trust boundaries

```
┌─ Developer workstation (trusted) ──────────────────────┐
│                                                        │
│  ┌─ Extension host (Node.js) ──────────────────────┐   │
│  │  Reads SecretStorage                            │   │
│  │  Makes outbound HTTPS to PAIC tenant            │   │
│  │  Owns: globalState, globalStorage/tails/, cache │   │
│  └────────────────────┬────────────────────────────┘   │
│                       │ postMessage                     │
│  ┌─ Search-panel webview (sandboxed iframe) ──────┐    │
│  │  Strict CSP — no inline scripts, no external   │    │
│  │  fetch. Never receives credentials.            │    │
│  │  Owns: localStorage UI prefs, sessionStorage   │    │
│  │        nav stack                               │    │
│  └────────────────────────────────────────────────┘    │
│  ┌─ Env-editor webview (sandboxed iframe) ────────┐    │
│  │  Same CSP. The ONLY place credentials cross    │    │
│  │  postMessage — webview→host, on submit only.   │    │
│  │  Disposes immediately on submit/cancel.        │    │
│  └────────────────────────────────────────────────┘    │
│                                                        │
└────────────────────────────────────────────────────────┘
                        │ HTTPS (TLS)
                        ▼
            ┌────────────────────────────┐
            │   PingOne AIC tenant       │
            │   (your-tenant.forgeblocks)│
            └────────────────────────────┘
```

## Two-webview model

The extension runs **two distinct webviews**, with different credential rules:

| Webview            | Receives credentials? | Sends credentials?           | Lifetime      |
|--------------------|-----------------------|------------------------------|---------------|
| Search panel       | No (never)            | No (never)                   | Until tab close |
| Env editor         | No                    | **Yes** — on submit only     | Disposes immediately on submit/cancel |

The search panel never sees `EnvironmentSecret` in any direction. The env-editor IS the credential input source — that's why it's a separate webview with one-way (webview→host) credential flow. Form state never persists; the panel disposes the moment the user clicks Save or Cancel, taking webview-process memory with it.

## How credentials are handled

| Item              | Where stored                             | When read                              |
|-------------------|------------------------------------------|----------------------------------------|
| Environment name  | Workspace `settings.json`                | On every search                        |
| Environment URL   | Workspace `settings.json`                | On every search                        |
| **API key**       | **OS keychain via SecretStorage**        | Lazily, only inside the host           |
| **API secret**    | **OS keychain via SecretStorage**        | Lazily, only inside the host           |
| Search history    | VS Code `globalState`                    | When user opens history panel          |

**Search-panel rule:** credentials never cross the postMessage boundary. The webview can only ask the host *"please run search X for environment Y"*; the host fetches credentials and uses them for the outbound TLS request.

**Edit semantics:** when the env-editor opens in edit mode, the host pre-fills `{ name, url }` only — the existing key/secret are never sent to the webview. Blank-to-keep semantics let users rotate credentials without exposing the current values.

Detailed per-OS storage paths: [DATA_STORAGE.md](DATA_STORAGE.md).

## Multi-tab implications

Each panel tab is an isolated webview (separate iframe + separate host-side `LogSearchPanel` instance).

- **Independent per tab**: search state (entries, filters, modal index, search-nav stack), in-memory `SearchSessionCache`, active tail streams.
- **Shared across tabs** (same webview origin / same VS Code installation):
  - `localStorage` UI preferences (`paic_*` keys) — toggle states, column widths, ETA samples, Related-window prefs.
  - `globalStorage/tails/` archive (any tab can browse and load).
  - `globalState` search history.
  - OS keychain credentials.

Closing a tab drops its in-memory session cache and aborts its tails — no persistence of search results across panel close.

## Tail file disk persistence

Tail streams auto-archive to `globalStorage/tails/tail-<env>-<startTs>.ndjson` (one JSON entry per line) plus an `index.json` metadata file. Files are FIFO-capped at 20 streams; empty streams are pruned on stop.

> **Files are written unencrypted** with the same OS-level access controls as VS Code's user data dir. A logged-in user with filesystem access can read them. Log payloads can contain identifiers, IPs, transactionIds, sometimes user emails.

Recommendations:

- For sensitive workloads, do not enable tail mode, or use **Stop** + **Clear All** in the Tail Files tab to clean up promptly.
- Restrict access to the user data dir at OS level (e.g. macOS FileVault + per-user home permissions; Windows BitLocker; Linux LUKS + correct umask).
- A future setting `paicLogSearch.tailAutoSave` will let you disable archiving entirely. See [ROADMAP.md](ROADMAP.md).

## What the extension does NOT do

- Never sends credentials anywhere except the configured PAIC tenant URL.
- **Never logs** credentials at any verbosity level.
- **No telemetry**, no analytics, no usage data egress. Explicit project policy.
- Never executes user-supplied JavaScript (`eval`, `Function`, etc. are forbidden by CSP).
- Never loads external CDNs in the webview (CSP `connect-src` and `script-src` restrict it to the extension's own asset URIs).
- Never makes network calls outside the configured tenant URL.

## What it DOES do

- HTTPS-only to PAIC — non-HTTPS URLs are rejected at the input form.
- Local-only credential storage — secrets never leave the workstation except as request headers to PAIC.
- Strict CSP on every webview — defense in depth even if a future bug introduces an XSS vector.
- Discriminated-union typed message protocol — host validates message shape before processing.

## Webview Content Security Policy

Both webviews load with this CSP (see `panel.ts` and `envEditor.ts`):

```
default-src 'none';
img-src    <cspSource> data:;       (search panel only)
script-src 'nonce-<random-32-char>';
style-src  <cspSource> 'unsafe-inline';
font-src   <cspSource>;
```

- `default-src 'none'` — deny by default
- `script-src 'nonce-...'` — only scripts with the matching nonce attribute can run; no inline `<script>` content, no `eval`
- No `connect-src` — the webview cannot make any network requests
- No `unsafe-inline` for `script-src` — even if user input ends up inline, it cannot execute as JS

## Reporting a vulnerability

Please **do not** open public GitHub issues for security reports.

Email: **TODO-security@TODO-your-domain** (encrypt with PGP key at TODO-link if applicable).

We'll acknowledge within 5 business days, agree on a disclosure timeline, and credit reporters in the changelog.

## Dependency policy

- We avoid runtime dependencies aggressively. Currently the runtime bundle has **zero npm dependencies** (only `vscode` API + Node built-ins).
- Build-time deps (`esbuild`, `typescript`, `eslint`, types packages) are reviewed when added.
- Dependabot/Renovate is recommended for downstream forks.

## Open questions / known caveats

- **Webview sees the OS clipboard** when user clicks **Copy** — by design (`navigator.clipboard.writeText`). No way to make this read-only.
- **API secrets in memory** — once a secret is loaded for a search, it's in the host process heap until GC. Not different from any extension that handles secrets.
- **No biometric prompt** — VS Code's SecretStorage doesn't currently support per-access biometric. Storage is at-rest encrypted by the OS keychain but a logged-in user has access.
- **Tail files unencrypted on disk** — see "Tail file disk persistence" above.

## See also

- [ARCHITECTURE.md](ARCHITECTURE.md) — full design walkthrough
- [DATA_STORAGE.md](DATA_STORAGE.md) — every place state lives
- [VS Code SecretStorage docs](https://code.visualstudio.com/api/references/vscode-api#SecretStorage)
- [VS Code webview security](https://code.visualstudio.com/api/extension-guides/webview#content-security-policy)
