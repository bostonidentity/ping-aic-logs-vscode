# Troubleshooting

## Authentication failed (401 / 403) — "check API key/secret"

The Log API key/secret you configured is wrong, expired, or doesn't have read scope.

1. PAIC admin console → *Tenant Settings → Log API Keys*.
2. Either confirm the existing key/secret pair, or click **Generate** to mint a new one.
3. In VS Code: hover the env in the sidebar → pencil icon to **edit**, paste the new key + secret. Or trash → re-add.

## Rate limited (429)

PAIC enforces ~60 req/min for the Log API. If you trigger a search that pages many times (long time window × high-volume source), you can hit this.

- Reduce time range.
- Pick a narrower source than `*-everything`.
- Wait ~1 minute and retry.

## Search returns 0 entries when you know there should be matches

Most common causes, in order:

1. **Wrong source** — `idm-core` doesn't see `am-authentication` events. Re-run with `am-everything` or specifically the source you expect.
2. **Time range too narrow** — re-run with `last 4h` or `last 24h`.
3. **Case mismatch** — the keyword is case-sensitive on the PAIC server.
4. **Filter mismatch on JSON payloads** — JSON logs (most `am-*` and `idm-access`/`idm-activity`) are searchable only on specific JSON paths (eventName, userId, transactionId, trackingIds, …). Plain words inside the message body of a JSON log won't match unless the source explicitly lists `/payload/message` for that source.
5. **PAIC retention** — logs older than 30 days are unconditionally deleted by Ping.

## "Search session expired. Run the search again."

The in-memory `SearchSessionCache` is bounded (last 20 sessions, **per panel**). When you click *prev/next* on a search older than 20 searches ago, the cache no longer has it. Just re-run the search.

This also fires when you reopen a previously-closed tab — sessions live in panel memory only.

## Tail mode shows nothing

PAIC's `/monitoring/logs/tail` endpoint returns entries arrived *since the last poll*. If your tenant is quiet (no new logs), tail polls return empty and the table stays empty — that's correct behavior.

To verify it's working:
- Switch source to a high-traffic one (`am-everything` on a busy tenant).
- Or trigger a known event (e.g. log into the tenant in another browser tab).

## Where are my tail files?

They live under `globalStorage/tails/` in the VS Code user data dir. Per-OS paths:

- **macOS** — `~/Library/Application Support/Code/User/globalStorage/<publisher>.ping-aic-logs/tails/`
- **Linux** — `~/.config/Code/User/globalStorage/<publisher>.ping-aic-logs/tails/`
- **Windows** — `%APPDATA%\Code\User\globalStorage\<publisher>.ping-aic-logs\tails\`

Format: `tail-<env>-<startTs>.ndjson` files + an `index.json` metadata file. Browse from inside the extension: History menu ▸ **Tail Files** tab. Full reference: [DATA_STORAGE.md](DATA_STORAGE.md).

## Tail file disk usage growing

Tail files are FIFO-capped at **20** streams; older files are auto-evicted on new tail start. Empty streams (no entries written) are pruned on stop.

To wipe manually: History menu ▸ **Tail Files** tab ▸ **Clear All**, or delete the directory contents.

A future setting `paicLogSearch.tailFileCap` will let you change the cap; `paicLogSearch.tailAutoSave` will let you disable archiving entirely. See [ROADMAP.md](ROADMAP.md).

## How do I clear search history?

History menu ▸ **Searches** tab ▸ **Clear All**. Or delete individual rows via ×. History is capped at 100 entries with dedup-on-add.

## How do I wipe UI preferences (column widths, toggles, ETA samples)?

Currently no built-in command. Workaround: with the search panel focused, open **Help → Toggle Developer Tools**, go to **Application** ▸ **Local Storage**, and remove every key prefixed `paic_*`. Reload the panel.

A "Reset UI Preferences" command is on the short-term roadmap.

## Multi-tab confusion: changes in one tab don't affect another

Expected. Each tab has independent search state (entries, filters, modal, search nav). Only UI preferences and the tail file archive are shared. If you want a query repeated in two tabs, run it twice — there's no cross-tab broadcast.

## Secret missing when editing an env

If the keychain entry was deleted out-of-band (e.g. another machine, manual keychain cleanup), the edit command shows *"Stored secret missing for X"*. Resolution: delete the env in the sidebar (which clears the workspace setting) and re-add via **+**.

## Large query confirmation dialog

If you hit **Search** with no keyword **and** the time range is wider than 30 minutes, a confirm dialog appears warning about volume. Click **Cancel** to back out without firing; **Continue** to proceed. This dialog never blocks scripted use because there's no scripted-search path.

## Webview shows "Webview ready" but never any results

Either:
- The query returned 0 (see above).
- The host couldn't reach PAIC. Open *Help → Toggle Developer Tools → Console* in the dev host. Look for errors mentioning `fetch failed`, DNS, or CSP.

## CSP / "Refused to connect to ..." errors in webview console

The webview is sandboxed with strict CSP. **Network calls cannot originate from the webview** — they all go through the extension host via `postMessage`. If you see CSP errors, you likely have a stray `fetch(...)` or `<script src="https://...">` in `media/`. Fix: route through the message protocol.

## "Module not found: vscode" when running scripts directly

`vscode` is provided at runtime by the host. Don't try `node out/extension.js` standalone — only `extensionHost` launch type works. Use F5 in VS Code.

## Extension activates but commands don't show in palette

Restart the dev host (close + F5 again). VS Code caches `package.json` contributions on first activation; you might be running an outdated version of the contribution tree.

If commands still missing: check `package.json` *contributes.commands* registration matches the `vscode.commands.registerCommand` call exactly (string IDs are case-sensitive).

## Lots of `[ERR_INVALID_ARG_TYPE]` in dev host on startup

Check that `node --version` is ≥ 18. The extension uses native `fetch` (Node 18+ feature) and AbortController.

## How do I see what the extension is actually sending to PAIC?

Add a `console.log` in `src/paicClient.ts`'s `request()` method — output appears in the *outer* VS Code's *Debug Console* (not the dev host's). Or set a breakpoint at the `await fetch(...)` line.

## Where are my credentials stored?

| Item                     | Storage location                                        |
|--------------------------|---------------------------------------------------------|
| Environment name + URL   | Workspace settings (`settings.json`)                    |
| API key + secret         | OS keychain via VS Code SecretStorage                   |
| Search history           | VS Code globalState (per VS Code installation)          |
| Tail file archive        | `globalStorage/tails/` filesystem                       |
| UI preferences           | Webview `localStorage` (`paic_*`)                       |
| Cached search session    | In-memory only, cleared on panel close                  |

Full per-OS details: [DATA_STORAGE.md](DATA_STORAGE.md).

## How do I export search results to a file?

Click **Save** in the toolbar → native save dialog → pick `.ndjson` (default) or `.json`. Saves the full session, not just the current page.

## See also

- [USER_GUIDE.md](USER_GUIDE.md)
- [DATA_STORAGE.md](DATA_STORAGE.md)
- [SECURITY.md](SECURITY.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
