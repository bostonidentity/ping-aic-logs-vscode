# Ping AIC Logs

VS Code extension for searching and tailing logs from a **PingOne Advanced Identity Cloud** (PAIC) tenant — directly inside the editor.

[Features](#features) · [Install](#install) · [Use](#use) · [Configuration](#configuration) · [Documentation](docs/) · [License](LICENSE)

## Features

- **Multi-environment** — manage multiple PAIC tenants from a sidebar tree; credentials in OS keychain (`SecretStorage`).
- **Multi-tab** — each sidebar env click opens an independent search tab; live tab title shows result count + tail status.
- **Search** with per-source `_queryFilter` heuristics; multi-source picker (IDM / AM / Other groups, with `*-everything` ↔ individual mutual exclusion); three time modes (Recent / Range / Around).
- **Tail** mode with smart auto-scroll pause/resume and automatic disk persistence (FIFO-capped, configurable).
- **Diagnostic templates** — Related searches dropdown derives 15+ pre-configured queries (transactionId / trackingId / userActivity / errors) around the entry's timestamp.
- **Filtering** — local filter chips (Enter to promote), exclude chips, +Field dialog (auto-extracts fields/values), Dedup with click-to-exclude, Custom-code mode (filter to scripts/endpoints).
- **Modal Format** — expands embedded JSON strings, formats stack traces, highlights `_json` blocks + search keyword + filter words + log keywords (SUCCESS / FAILED / Exception / 4xx / 5xx, …).
- **Productivity** — Cmd/Ctrl+K to focus search, ETA tooltip predicts query time from history, CLI button copies equivalent command, Save export to NDJSON / JSON.
- **Safety** — strict CSP, large-query confirmation, no telemetry, no CDN dependencies.

## Install

```bash
git clone https://github.com/bostonidentity/ping-aic-logs-vscode.git
cd ping-aic-logs-vscode
npm install
npm run compile
```

Open the folder in VS Code and press <kbd>F5</kbd> to launch a development host with the extension active. A `.vsix` will be available once the extension ships to the marketplace; the publisher ID in `package.json` is currently a placeholder.

## Use

1. **Add an environment** — click the PAIC sidebar (search icon), then "+ Add Environment". Enter name, tenant URL, log API key + secret. Credentials go into your OS keychain.
2. **Open a search panel** — click the env in the sidebar tree (each click opens a new tab; multi-tab is supported).
3. **Search** — pick sources / time range, type a keyword, hit Enter.
4. **Drill in** — click any row to open the entry detail modal; click the timestamp to copy; press ↑/↓/←/→ to walk through entries; click "Related" for derived diagnostic searches.

Full feature reference: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## Configuration

User-configurable settings (`File ▸ Preferences ▸ Settings ▸ PAIC Log Search`):

| Setting | Default | Purpose |
|---|---|---|
| `paicLogSearch.environments` | `[]` | List of `{name, url}`; secrets in keychain |
| `paicLogSearch.defaultPageSize` | `100` | Initial result page size |
| `paicLogSearch.tailFileCap` | `20` | Max saved tail-stream files |
| `paicLogSearch.tailPollInterval` | `1000` | Tail polling interval (ms). Also bounds per-batch size on high-traffic tenants. |
| `paicLogSearch.tailAutoSave` | `true` | Persist tail streams to disk |
| `paicLogSearch.maxRowsPerSearch` | `50000` | Per-search row cap |
| `paicLogSearch.searchHistoryLimit` | `100` | Max history entries kept |
| `paicLogSearch.largeQueryThresholdMinutes` | `30` | Confirm before keyword-less search exceeds this; `0` disables |
| `paicLogSearch.customCodeRules` | `{}` | Override built-in custom-code filter rules |
| `paicLogSearch.highlightRules` | `[]` | Override built-in log keyword highlight rules |

Plus 6 commands available via Command Palette (`PAIC Log Search: …`).

## Documentation

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — features, keyboard shortcuts, workflows
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design + storage model
- [docs/API.md](docs/API.md) — webview ↔ host postMessage protocol
- [docs/DATA_STORAGE.md](docs/DATA_STORAGE.md) — every storage layer mapped
- [docs/SECURITY.md](docs/SECURITY.md) — threat model
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — common issues
- [docs/ROADMAP.md](docs/ROADMAP.md) — direction
- [docs/FAQ.md](docs/FAQ.md) — why-this-not-that
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — build, debug, contribute

## Contributing

PRs welcome. Before opening:

1. `npx tsc --noEmit && npm run lint && npm run compile` clean (project policy: 0 warn / 0 err)
2. F5 dev host smoke test of any UI change
3. Update [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]`

For larger changes, open an issue first to discuss. Code conventions, project layout, debugging, and publishing notes are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE).
