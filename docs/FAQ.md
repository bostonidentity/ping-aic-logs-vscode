# FAQ

## Why a VS Code extension instead of a web app?

- Devs already have VS Code open while debugging — zero context switch.
- Per-workstation credentials stored via OS keychain (no shared web app secrets).
- Side-by-side with code, scripts, and `frodo` exports.
- Easier private deployment than running another web service.

## Why not just use frodo-cli's `frodo log` commands?

[frodo-cli](https://github.com/rockcarver/frodo-cli) is the swiss army knife — great for scripting, exports, and one-shot CLI use. This extension targets the **interactive search/triage workflow**: type a query, see paginated results, click into an entry, follow trackingIds across sources. Different ergonomics for different tasks.

## Why two tabs for the same env?

Multi-tab is intentional. Open the same env twice to compare two queries side by side (e.g. one tab tailing `am-authentication` while another searches `idm-core` for the same user). No state crosses tabs — each has its own results, filters, modal, and search nav. UI preferences are shared. See [USER_GUIDE.md](USER_GUIDE.md#multi-tab).

## Where are my tail files?

`globalStorage/tails/` under VS Code's user data dir. Per-OS paths and full schema: [DATA_STORAGE.md](DATA_STORAGE.md). Browse from inside the extension via History menu ▸ **Tail Files** tab.

## How do I clear search history?

History menu ▸ **Searches** tab ▸ **Clear All**. Or × on individual rows.

## Why is Custom mode reset on every search?

A forgotten Custom-on toggle would silently hide all results in a brand-new query — confusing and a known foot-gun in earlier internal versions. Auto-reset on each search prevents that. Same toggle, fresh state per query.

## Why does Raw show different content than the table summary?

The default summary cell is a **per-source semantic projection** (e.g. `LoginTree → SUCCESSFUL user@example.com` for `am-authentication`, or the request method+path for `idm-access`). Raw mode shows the **full entry JSON** — useful when you want every field, or when the summary template doesn't cover your source.

## Does it work offline?

The extension itself activates and the UI loads offline. But searches require network connectivity to your PAIC tenant — the host makes outbound HTTPS to `your-tenant.forgeblocks.com`. If you're offline, searches will fail with a network error. Cached sessions and archived tail files remain readable.

## Can I use it for self-hosted ForgeRock Identity Cloud (not PingOne)?

Theoretically yes — the API surface (`/monitoring/logs`, `/monitoring/logs/sources`, `/monitoring/logs/tail`) and the `x-api-key` / `x-api-secret` headers are identical between PingOne AIC and self-hosted ForgeRock Identity Cloud as long as the Logging Service is enabled. URL ends with the tenant FQDN — point it there and it should work.

## Why doesn't the search support quoted phrases / boolean operators?

PAIC's `_queryFilter` is CREST-style, not Lucene/ELK-style. Substring (`co`) is the simplest cross-source query that works with both text/plain payloads (idm-core) and JSON payloads. More complex syntax (AND/OR/NOT, regex) is on the roadmap (see [ROADMAP.md](ROADMAP.md) v0.3 — "Search by `_queryFilter` directly").

For local AND-filtering after the result lands, use the toolbar **Filter** chips — they AND together.

## How is this different from upstream / other internal log-search tools?

This is a standalone VS Code extension with the same diagnostic philosophy (semantic per-source summaries, `_queryFilter` heuristics, transactionId/trackingId-aware Related searches) but recreated from scratch with an extension's CSP/sandboxing constraints in mind. Auth-tree / SAML-flow visualization and the script viewer are intentionally **out of scope** — they depended on local frodo exports and added significant CSP / vendoring complexity. For journey introspection, use [frodo-cli](https://github.com/rockcarver/frodo-cli) directly.

## Can I share searches with my team?

Search history is local. To share, copy the URL+query+time range, or click **CLI** to copy an equivalent `paic-logs search …` command, and paste into chat / ticket. Saved-search templates are on the roadmap.

## Why is tail mode "polling" not real-time push?

PAIC's `/monitoring/logs/tail` is itself polling-based (returns whatever's arrived since the last `pagedResultsCookie`). There's no streaming push API exposed. We default to 5s poll interval — short enough to feel live, long enough not to spam the API. Configurable interval is on the roadmap.

## Can I disable tail auto-save?

Yes — set `paicLogSearch.tailAutoSave` to `false` in VS Code settings. Tails will then run fully ephemeral (no `globalStorage/tails/*.ndjson` written). You can also adjust the FIFO cap with `paicLogSearch.tailFileCap` (default 20). Already-saved files can be deleted from History ▸ **Tail Files** tab or via the `PAIC Log Search: Reveal Saved Tail Files Folder` command.

## Can I change the tail file location?

Not currently. Tails are pinned to `globalStorage/tails/` (per-extension VS Code-managed folder). VS Code controls the parent path; we just create the `tails/` subdirectory inside it. See [DATA_STORAGE.md](DATA_STORAGE.md) for paths per OS.

## How does it handle huge result sets?

- Per-page request to PAIC: 1000 entries (the API default).
- Per-search cap (host-side): 50,000 entries (~50 pages × 1s rate-limit pause = ~50s upper bound).
- Webview pagination: 100 entries per page (configurable from the page-size dropdown).
- The full session is held in webview memory so filter / dedup / customCode operate on the complete set, not just the current page. Memory budget: ~50 MB worst case at the 50k cap.

If you actually need >50k rows — narrow your search.

## Why TypeScript and not JavaScript / Rust / Go?

VS Code Extension API is TypeScript-first. Source code in TS, esbuild bundling, Node.js runtime. Other languages are technically possible (e.g. via `child_process` to a sidecar binary) but ergonomics worse.

## Does the extension call any third-party services?

No. The only external network connection is to **your** configured PAIC tenant URL. No telemetry, no analytics, no CDN fetches.

## Can I publish my own fork to the marketplace?

Yes — MIT license. Change `name`, `displayName`, `publisher`, `repository` in `package.json` and follow [VS Code's publishing docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## See also

- [USER_GUIDE.md](USER_GUIDE.md)
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- [DATA_STORAGE.md](DATA_STORAGE.md)
- [ROADMAP.md](ROADMAP.md)
