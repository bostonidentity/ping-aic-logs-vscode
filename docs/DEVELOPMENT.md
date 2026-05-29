# Development

## Prerequisites

- Node.js ≥ 18 (project uses native `fetch`)
- VS Code ≥ 1.85 (uses recent SecretStorage / TreeView APIs)

## First-time setup

```bash
npm install
```

## Day-to-day

| Task                              | Command                       | Notes                                  |
|-----------------------------------|-------------------------------|----------------------------------------|
| One-shot build                    | `npm run compile`             | esbuild → `out/extension.js`           |
| Watch mode                        | `npm run watch`               | Recompile on save                      |
| Launch dev host                   | F5 in VS Code                 | Uses `.vscode/launch.json`             |
| Type-check only                   | `tsc --noEmit`                | Catches issues esbuild ignores         |
| Lint                              | `npm run lint`                | eslint over `src/`                     |
| Production build                  | `npm run package`             | Minified bundle for `.vsix`            |
| Package `.vsix`                   | `npx @vscode/vsce package`    | Output: `ping-aic-logs-X.Y.Z.vsix`     |

## Project-specific conventions

### Strict typing

`tsconfig.json` enables `strict: true` and `noImplicitAny`. Webview ↔ host messages are discriminated unions in [`src/types.ts`](../src/types.ts) — when adding a new message type, update both ends.

### CSP & nonces

The webview HTML in `panel.ts` sets a strict CSP and injects a per-load nonce on the `<script>` tag. **Do not** add inline event handlers (`onclick="..."`) — bind via `addEventListener` in `media/webview/main.js`. This matches VS Code's webview security model and avoids future breakage.

### Secrets never cross postMessage

The webview is sandboxed but still untrusted from a "what gets serialized to disk via the host's storage" perspective. **Never** include `EnvironmentSecret` (`key`, `secret`) in any `Host → Webview` message payload. The host fetches them from SecretStorage on demand and uses them in `PaicClient` only.

## Debugging

### Extension host

- Set breakpoints in `src/*.ts`. F5 attaches the VS Code debugger.
- Use `console.log(...)` — output appears in the `Debug Console` of the **outer** VS Code window.

### Webview

- Inside the dev host: **Help → Toggle Developer Tools** opens the webview's Chromium devtools.
- `console.log(...)` from `media/webview/main.js` shows there.
- Network calls from the webview are blocked by CSP except to `connect-src ${cspSource}` — all fetching must go through `postMessage` to the host.

## Adding a new command

1. Add it to `package.json` under `contributes.commands`.
2. Register it in `src/extension.ts` via `vscode.commands.registerCommand`.
3. Push the disposable into `context.subscriptions` so VS Code cleans it up on deactivation.

## Adding a new postMessage type

Updates required in **3 places** (the protocol is a discriminated union; TypeScript exhaustiveness checks catch missing handlers at compile time):

1. `src/types.ts` — extend `WebviewToHostMessage` (or `HostToWebviewMessage`) union.
2. `src/panel.ts` `handleMessage` — add the new `case`.
3. `media/webview/main.js` — add the new branch in `window.addEventListener('message', ...)`.

If the message originates from the env-editor webview, the equivalent files are `src/envEditor.ts` and `media/envEditor/main.js`.

## Adding a new user-configurable setting

1. Declare under `package.json` ▸ `contributes.configuration.properties.paicLogSearch.*` (with `type`, `default`, `description`, optional `minimum`/`maximum`).
2. Read at use-site via the `readSetting` helper in `src/panel.ts` (or `vscode.workspace.getConfiguration('paicLogSearch')` directly).
3. If the webview needs the value, add it to `PaicConfig` in `src/types.ts` and ship via the `config` postMessage on panel init (host already does this in the `getEnvironments` handler).

## Publishing

```bash
npx @vscode/vsce login <publisher>
npx @vscode/vsce publish
```

You'll need a Personal Access Token from <https://dev.azure.com/> with Marketplace (Publish) scope. See [VS Code Marketplace docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
