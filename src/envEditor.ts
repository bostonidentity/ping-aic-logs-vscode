import * as vscode from 'vscode';

/**
 * Webview-based environment add/edit form.
 *
 * Architectural exception: the search panel rule "credentials never cross
 * postMessage" does not apply to this module — this form *is* the input source
 * for credentials. Flow rules instead:
 *   - webview → host: full form payload (name, url, key, secret) — required
 *   - host → webview: name + url only; never the existing secret. Edit mode
 *     uses "leave blank to keep" semantics so secrets stay in the OS keychain.
 *   - panel disposes immediately on submit/cancel; form state never persists.
 */

const VIEW_TYPE = 'pingAicLogs.envEditor';

export interface EnvFormResult {
  name: string;
  url: string;
  /** Empty string means "keep existing" in edit mode; required in add mode. */
  key: string;
  /** Empty string means "keep existing" in edit mode; required in add mode. */
  secret: string;
}

type FromWebview = { type: 'submit'; payload: EnvFormResult } | { type: 'cancel' };

export class EnvEditorPanel {
  private static current: EnvEditorPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private resolveResult!: (result: EnvFormResult | undefined) => void;
  readonly result: Promise<EnvFormResult | undefined>;
  private settled = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly mode: 'add' | 'edit',
    private readonly initial: { name: string; url: string }
  ) {
    this.result = new Promise((res) => {
      this.resolveResult = res;
    });
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => this.handleDispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: FromWebview) => this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  static show(
    context: vscode.ExtensionContext,
    mode: 'add' | 'edit',
    initial: { name: string; url: string } = { name: '', url: '' }
  ): Promise<EnvFormResult | undefined> {
    if (EnvEditorPanel.current) {
      EnvEditorPanel.current.panel.reveal();
      return EnvEditorPanel.current.result;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      mode === 'add' ? 'Add Environment' : `Edit: ${initial.name}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    const editor = new EnvEditorPanel(panel, context, mode, initial);
    EnvEditorPanel.current = editor;
    return editor.result;
  }

  private handleMessage(msg: FromWebview): void {
    if (msg.type === 'submit') {
      this.settle(msg.payload);
      this.panel.dispose();
    } else if (msg.type === 'cancel') {
      this.settle(undefined);
      this.panel.dispose();
    }
  }

  private handleDispose(): void {
    this.settle(undefined);
    EnvEditorPanel.current = undefined;
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  private settle(value: EnvFormResult | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveResult(value);
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const cspSource = webview.cspSource;
    const main = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'envEditor', 'main.js')
    );
    const styles = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'envEditor', 'styles.css')
    );
    const initJson = JSON.stringify({
      mode: this.mode,
      name: this.initial.name,
      url: this.initial.url
    });

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};" />
  <link rel="stylesheet" href="${styles}" />
  <title>Environment</title>
</head>
<body>
<form id="form" autocomplete="off">
  <h2 id="title"></h2>
  <p id="hint" class="hint" hidden></p>

  <label>Environment name
    <input id="name" type="text" autocomplete="off" />
  </label>
  <label>Tenant base URL
    <input id="url" type="text" placeholder="https://your-tenant.forgeblocks.com" autocomplete="off" />
  </label>
  <label>Log API key
    <input id="key" type="password" autocomplete="new-password" />
  </label>
  <label>Log API secret
    <input id="secret" type="password" autocomplete="new-password" />
  </label>

  <p id="error" class="error" hidden></p>

  <div class="actions">
    <button type="submit" class="primary">Save</button>
    <button type="button" id="cancel">Cancel</button>
  </div>
</form>

<script nonce="${nonce}">window.__INIT__ = ${initJson};</script>
<script nonce="${nonce}" src="${main}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  let result = '';
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}
