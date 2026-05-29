import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigStore } from './config';
import { HistoryStore, SearchSessionCache } from './history';
import { PaicClient } from './paicClient';
import {
  HistoryEntry,
  HostToWebviewMessage,
  LogEntry,
  PaicConfig,
  SearchResultPage,
  TailFileMeta,
  WebviewToHostMessage
} from './types';

const VIEW_TYPE = 'pingAicLogs.searchPanel';

/**
 * Read a value from the `paicLogSearch` configuration scope with a typed
 * fallback. Called at the use-site so live settings changes take effect on
 * the next operation without panel reload.
 */
function readSetting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('paicLogSearch').get<T>(key, fallback);
}

export class LogSearchPanel {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new SearchSessionCache();
  private readonly tails = new Map<string, AbortController>();

  /** Live registry of open panels — used by maintenance commands to broadcast. */
  private static readonly instances = new Set<LogSearchPanel>();

  static allInstances(): ReadonlySet<LogSearchPanel> {
    return LogSearchPanel.instances;
  }

  /** Currently selected env (updated whenever the webview sends `setTitle`).
   *  Falls back to the initial env passed at construction. */
  private currentEnv: string | undefined = undefined;
  get envName(): string | undefined {
    return this.currentEnv ?? this.initialEnv;
  }

  /** True when this is the currently focused webview panel. */
  get isActive(): boolean {
    return this.panel.active;
  }

  /** Bring this panel's tab to the foreground. */
  reveal(): void {
    this.panel.reveal();
  }

  postMessage(msg: HostToWebviewMessage): Thenable<boolean> {
    return this.panel.webview.postMessage(msg);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly configStore: ConfigStore,
    private readonly historyStore: HistoryStore,
    private readonly initialEnv?: string,
    private readonly initialTailFile?: string,
    private readonly initialSearchEntry?: HistoryEntry
  ) {
    LogSearchPanel.instances.add(this);
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToHostMessage) => this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  /**
   * Always opens a new panel — each tree click yields a new tab so users can
   * compare multiple environments / queries side by side.
   */
  static create(
    context: vscode.ExtensionContext,
    configStore: ConfigStore,
    historyStore: HistoryStore,
    envName?: string,
    initialTailFile?: string,
    initialSearchEntry?: HistoryEntry
  ): LogSearchPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const title = envName ? envName : 'Ping AIC Logs';
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    return new LogSearchPanel(panel, context, configStore, historyStore, envName, initialTailFile, initialSearchEntry);
  }

  private async handleMessage(msg: WebviewToHostMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'getEnvironments':
          await this.send({
            type: 'environments',
            payload: this.configStore.listEnvironments()
          });
          if (this.initialEnv) {
            await this.send({ type: 'setInitialEnv', payload: { env: this.initialEnv } });
          }
          await this.send({
            type: 'config',
            payload: {
              largeQueryThresholdMinutes: readSetting<number>('largeQueryThresholdMinutes', 30),
              defaultPageSize: readSetting<number>('defaultPageSize', 100),
              highlightRules: readSetting<unknown[]>('highlightRules', []) as PaicConfig['highlightRules']
            } as PaicConfig
          });
          // If the panel was opened from a "Recent Searches" sidebar entry,
          // restore the form state and auto-run that search.
          if (this.initialSearchEntry) {
            await this.send({ type: 'restoreSearch', payload: this.initialSearchEntry });
          }
          // If the panel was opened from the "Saved Tail Files" sidebar
          // entry, auto-load that tail file content right after init.
          if (this.initialTailFile) {
            const result = await this.loadTailFile(this.initialTailFile);
            if (result) await this.send({ type: 'tailFileLoaded', payload: result });
          }
          return;

        case 'setTitle': {
          const { env, count, tail } = msg.payload;
          this.currentEnv = env;
          this.panel.title = formatPanelTitle(env, count, tail);
          return;
        }

        case 'listSources': {
          const client = await this.clientFor(msg.payload.env);
          const sources = await client.listSources();
          await this.send({ type: 'sourceList', payload: sources });
          return;
        }

        case 'search': {
          const client = await this.clientFor(msg.payload.env);
          const cap = readSetting<number>('maxRowsPerSearch', 50000);
          const requested = msg.payload.limit ?? 50000;
          const result = await client.search({
            source: msg.payload.source,
            query: msg.payload.query,
            begin: msg.payload.begin,
            end: msg.payload.end,
            maxRows: Math.min(requested, cap)
          });
          const session = this.cache.put(result.entries, result.truncated);
          // Send the entire session up-front so the webview can do its own
          // pagination + filter/dedup on the full data set
          // (client-side equivalent of the original tool's /api/filter).
          const fullPayload: SearchResultPage = {
            sessionId: session.sessionId,
            totalCount: session.totalCount,
            page: 0,
            pageSize: session.totalCount || 1,
            pages: 1,
            entries: session.entries,
            truncated: session.truncated
          };
          await this.send({ type: 'searchResult', payload: fullPayload });

          // Persist to history (fire-and-forget; user-visible failure is the warning toast).
          this.historyStore
            .add({
              timestamp: Date.now(),
              env: msg.payload.env,
              source: msg.payload.source,
              query: msg.payload.query,
              begin: msg.payload.begin,
              end: msg.payload.end,
              totalCount: session.totalCount
            })
            .catch((e) => console.warn('[ping-aic-logs] history.add failed:', e));
          return;
        }

        case 'getPage': {
          const out = this.cache.page(
            msg.payload.sessionId,
            msg.payload.page,
            msg.payload.pageSize
          );
          if (!out) {
            await this.send({
              type: 'error',
              payload: {
                message: 'Search session expired. Run the search again.',
                context: 'getPage'
              }
            });
            return;
          }
          await this.send({
            type: 'pageResult',
            payload: { sessionId: msg.payload.sessionId, pageSize: msg.payload.pageSize, ...out }
          });
          return;
        }

        case 'startTail': {
          const streamId = msg.payload.streamId ?? `tail-${Date.now()}`;
          if (this.tails.has(streamId)) {
            await this.send({
              type: 'error',
              payload: { message: `Tail ${streamId} already running`, context: 'startTail' }
            });
            return;
          }
          const ctrl = new AbortController();
          this.tails.set(streamId, ctrl);
          this.runTail(streamId, msg.payload.env, msg.payload.source, msg.payload.query, ctrl);
          return;
        }

        case 'stopTail': {
          const ctrl = this.tails.get(msg.payload.streamId);
          if (ctrl) {
            ctrl.abort();
            this.tails.delete(msg.payload.streamId);
            await this.send({
              type: 'tailEnded',
              payload: { streamId: msg.payload.streamId, reason: 'user-stop' }
            });
          }
          return;
        }

        case 'getHistory':
          await this.send({ type: 'history', payload: this.historyStore.list() });
          return;

        case 'addHistory':
          await this.historyStore.add(msg.payload);
          await this.send({ type: 'history', payload: this.historyStore.list() });
          return;

        case 'deleteHistory':
          await this.historyStore.deleteAt(msg.payload.index);
          await this.send({ type: 'history', payload: this.historyStore.list() });
          return;

        case 'clearHistory':
          await this.historyStore.clear();
          await this.send({ type: 'history', payload: [] });
          return;

        case 'saveResults':
          await this.handleSaveResults(msg.payload.entries, msg.payload.format ?? 'ndjson');
          return;

        case 'listTailFiles': {
          const metas = await this.readTailIndex();
          await this.send({ type: 'tailFiles', payload: metas });
          return;
        }

        case 'loadTailFile': {
          const result = await this.loadTailFile(msg.payload.name);
          if (result) await this.send({ type: 'tailFileLoaded', payload: result });
          return;
        }

        case 'deleteTailFile': {
          await this.deleteTailFile(msg.payload.name);
          await this.send({ type: 'tailFileDeleted', payload: { name: msg.payload.name } });
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.send({ type: 'error', payload: { message, context: msg.type } });
      vscode.window.showErrorMessage(`Ping AIC Logs: ${message}`);
    }
  }

  private async runTail(
    streamId: string,
    env: string,
    source: string,
    query: string,
    ctrl: AbortController
  ): Promise<void> {
    const startTime = Date.now();
    const fileName = `tail-${env}-${startTime}.ndjson`;
    const autoSave = readSetting<boolean>('tailAutoSave', true);
    const pollIntervalMs = readSetting<number>('tailPollInterval', 1000);
    let filePath: string | undefined;
    let meta: TailFileMeta | undefined;
    try {
      if (autoSave) {
        const dir = await this.ensureTailDir();
        filePath = path.join(dir, fileName);
        meta = { name: fileName, env, source, query, startTime, endTime: startTime, count: 0 };
        await fs.writeFile(filePath, '');
        await this.upsertTailMeta(meta);
        await this.evictOldTails();
        // Notify sidebar at stream START (not mid-stream — would refresh per batch).
        notifySidebarRefresh();
      }

      const client = await this.clientFor(env);
      for await (const batch of client.tail({ source, query, signal: ctrl.signal, pollIntervalMs })) {
        if (ctrl.signal.aborted) break;
        await this.send({ type: 'tailBatch', payload: { streamId, entries: batch } });
        if (autoSave && filePath && meta && batch.length) {
          const lines = batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
          await fs.appendFile(filePath, lines);
          meta.count += batch.length;
          meta.endTime = Date.now();
          await this.upsertTailMeta(meta);
        }
      }
      await this.send({
        type: 'tailEnded',
        payload: { streamId, reason: ctrl.signal.aborted ? 'aborted' : 'eof' }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.send({ type: 'tailEnded', payload: { streamId, reason: message } });
    } finally {
      // Drop empty tail files (no entries written) so they don't clutter history.
      // Skipped entirely when tailAutoSave is off — nothing was written.
      if (autoSave && filePath && meta && meta.count === 0) {
        try { await fs.unlink(filePath); } catch { /* ignore */ }
        await this.removeTailMeta(fileName);
      }
      this.tails.delete(streamId);
      // Notify sidebar at stream END so the final count + endTime show up.
      if (autoSave) notifySidebarRefresh();
    }
  }

  // ── Tail file storage (globalStorage/tails/) ─────────────────────────
  private async ensureTailDir(): Promise<string> {
    const dir = path.join(this.context.globalStorageUri.fsPath, 'tails');
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async readTailIndex(): Promise<TailFileMeta[]> {
    try {
      const dir = await this.ensureTailDir();
      const indexPath = path.join(dir, 'index.json');
      const raw = await fs.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw) as TailFileMeta[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeTailIndex(metas: TailFileMeta[]): Promise<void> {
    const dir = await this.ensureTailDir();
    const indexPath = path.join(dir, 'index.json');
    await fs.writeFile(indexPath, JSON.stringify(metas, null, 2));
  }

  private async upsertTailMeta(meta: TailFileMeta): Promise<void> {
    const all = await this.readTailIndex();
    const idx = all.findIndex((m) => m.name === meta.name);
    if (idx >= 0) all[idx] = meta;
    else all.unshift(meta);
    await this.writeTailIndex(all);
  }

  private async removeTailMeta(name: string): Promise<void> {
    const all = (await this.readTailIndex()).filter((m) => m.name !== name);
    await this.writeTailIndex(all);
  }

  private async evictOldTails(): Promise<void> {
    const cap = readSetting<number>('tailFileCap', 20);
    const all = await this.readTailIndex();
    if (all.length <= cap) return;
    const sorted = all.slice().sort((a, b) => b.startTime - a.startTime);
    const keep = sorted.slice(0, cap);
    const evicted = sorted.slice(cap);
    const dir = await this.ensureTailDir();
    for (const m of evicted) {
      try { await fs.unlink(path.join(dir, m.name)); } catch { /* ignore */ }
    }
    await this.writeTailIndex(keep);
  }

  private async loadTailFile(
    name: string
  ): Promise<{ name: string; meta: TailFileMeta; entries: LogEntry[] } | undefined> {
    const all = await this.readTailIndex();
    const meta = all.find((m) => m.name === name);
    if (!meta) {
      await this.send({ type: 'error', payload: { message: `Tail file not found: ${name}`, context: 'loadTailFile' } });
      return undefined;
    }
    const dir = await this.ensureTailDir();
    const data = await fs.readFile(path.join(dir, name), 'utf8');
    const entries: LogEntry[] = [];
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { entries.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
    }
    return { name, meta, entries };
  }

  private async deleteTailFile(name: string): Promise<void> {
    const dir = await this.ensureTailDir();
    try { await fs.unlink(path.join(dir, name)); } catch { /* ignore */ }
    await this.removeTailMeta(name);
    notifySidebarRefresh();
  }

  // ── Save results to disk via showSaveDialog ──────────────────────────
  private async handleSaveResults(
    entries: LogEntry[],
    format: 'ndjson' | 'json'
  ): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `paic-logs-${stamp}.${format}`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultName),
      filters: format === 'ndjson'
        ? { 'NDJSON (one JSON per line)': ['ndjson'], 'JSON': ['json'] }
        : { 'JSON': ['json'], 'NDJSON': ['ndjson'] }
    });
    if (!target) return;
    const ext = path.extname(target.fsPath).toLowerCase();
    const finalFormat: 'ndjson' | 'json' = ext === '.json' ? 'json' : ext === '.ndjson' ? 'ndjson' : format;
    const body = finalFormat === 'ndjson'
      ? entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
      : JSON.stringify(entries, null, 2);
    await fs.writeFile(target.fsPath, body);
    await this.send({ type: 'savedResults', payload: { path: target.fsPath, count: entries.length } });
    vscode.window.showInformationMessage(`Saved ${entries.length} entries to ${target.fsPath}`);
  }

  private async clientFor(envName: string): Promise<PaicClient> {
    const meta = this.configStore.listEnvironments().find((e) => e.name === envName);
    if (!meta) throw new Error(`Unknown environment: ${envName}`);
    const secret = await this.configStore.getSecret(envName);
    if (!secret) throw new Error(`Missing credentials for: ${envName}`);
    return new PaicClient(meta, secret);
  }

  private send(msg: HostToWebviewMessage): Thenable<boolean> {
    return this.panel.webview.postMessage(msg);
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const cspSource = webview.cspSource;
    const main = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'main.js')
    );
    const styles = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'styles.css')
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${cspSource} data:; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};" />
<title>Ping AIC Logs</title>
<link rel="stylesheet" href="${styles}" />
</head>
<body>

<div class="sticky-header">
<div class="search-bar">
<div class="search-bar-inner">
  <div class="group">
    <select id="env" title="Environment" style="min-width:60px;"></select>
  </div>
  <div class="group">
    <div class="source-picker" id="source-picker">
      <button class="btn btn-sm" id="source-toggle" type="button">2 sources</button>
      <div class="source-menu" id="source-menu">
        <div class="source-cols">
          <div>
            <div class="source-group-label">IDM</div>
            <label class="source-opt"><input type="checkbox" value="idm-everything" checked /> idm-everything <span class="source-hint">(all)</span></label>
            <label class="source-opt"><input type="checkbox" value="idm-core" /> idm-core <span class="source-hint">(debug)</span></label>
            <label class="source-opt"><input type="checkbox" value="idm-access" /> idm-access</label>
            <label class="source-opt"><input type="checkbox" value="idm-activity" /> idm-activity</label>
            <label class="source-opt"><input type="checkbox" value="idm-authentication" /> idm-authentication</label>
            <label class="source-opt"><input type="checkbox" value="idm-config" /> idm-config</label>
            <label class="source-opt"><input type="checkbox" value="idm-recon" /> idm-recon</label>
            <label class="source-opt"><input type="checkbox" value="idm-sync" /> idm-sync</label>
          </div>
          <div>
            <div class="source-group-label">AM</div>
            <label class="source-opt"><input type="checkbox" value="am-everything" checked /> am-everything <span class="source-hint">(all)</span></label>
            <label class="source-opt"><input type="checkbox" value="am-core" /> am-core <span class="source-hint">(debug)</span></label>
            <label class="source-opt"><input type="checkbox" value="am-access" /> am-access</label>
            <label class="source-opt"><input type="checkbox" value="am-authentication" /> am-authentication</label>
            <label class="source-opt"><input type="checkbox" value="am-activity" /> am-activity</label>
            <label class="source-opt"><input type="checkbox" value="am-config" /> am-config</label>
            <div class="source-group-label" style="margin-top:6px;">Other</div>
            <label class="source-opt"><input type="checkbox" value="environment-access" /> environment-access</label>
            <label class="source-opt"><input type="checkbox" value="ws-everything" /> ws-everything <span class="source-hint">(WS-Fed)</span></label>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="group">
    <select id="log-level" title="Log Level">
      <option value="" selected>ALL</option>
      <option value="ERROR">ERROR</option>
      <option value="WARN">WARN</option>
      <option value="INFO">INFO</option>
      <option value="DEBUG">DEBUG</option>
    </select>
  </div>
  <div class="group">
    <span class="clearable"><input type="text" id="query" class="query-input" placeholder="Keyword" title="Leave empty to get all logs in time range" /><button class="clear-btn" tabindex="-1">&times;</button></span>
  </div>
  <div class="group">
    <div class="time-tabs">
      <button class="active" data-mode="recent">Recent</button>
      <button data-mode="range">Range</button>
      <button data-mode="around">Around</button>
    </div>
  </div>
  <div class="group">
    <div id="time-recent" class="time-fields active">
      <label>Last</label>
      <input type="number" id="recent-val" class="num-input" value="1" min="1" />
      <select id="recent-unit">
        <option value="s" selected>sec</option>
        <option value="m">min</option>
        <option value="h">hr</option>
      </select>
      <span class="quick-times">
        <button class="btn btn-sm" data-val="5" data-unit="m">5m</button>
        <button class="btn btn-sm" data-val="30" data-unit="m">30m</button>
        <button class="btn btn-sm" data-val="1" data-unit="h">1h</button>
        <button class="btn btn-sm" data-val="4" data-unit="h">4h</button>
        <button class="btn btn-sm" data-val="24" data-unit="h">24h</button>
      </span>
    </div>
    <div id="time-range" class="time-fields">
      <label>From (Local)</label>
      <input type="datetime-local" id="range-begin" step="0.001" title="Local time (ms optional, defaults to .000) — converted to UTC for query | Double-click: Now | Paste: auto-convert" />
      <label>To (Local)</label>
      <input type="datetime-local" id="range-end" step="0.001" title="Local time (ms optional, defaults to .000) — converted to UTC for query | Double-click: Now | Paste: auto-convert" />
    </div>
    <div id="time-around" class="time-fields">
      <label>Time (Local)</label>
      <input type="datetime-local" id="around-center" step="0.001" title="Local time (ms optional, defaults to .000) — converted to UTC for query | Double-click: Now | Paste: auto-convert" />
      <select id="around-dir">
        <option value="both">+/-</option>
        <option value="before">before</option>
        <option value="after">after</option>
      </select>
      <input type="number" id="around-window" class="num-input" value="1" min="1" />
      <select id="around-unit">
        <option value="s" selected>sec</option>
        <option value="m">min</option>
      </select>
    </div>
  </div>
  <span class="search-btn-wrap"><button class="btn btn-primary" id="searchBtn">Search</button><span class="eta-tooltip" id="eta-tooltip"></span></span>
  <button class="btn btn-sm" id="tailBtn" title="Tail: poll for new logs in real-time" style="background:#5cb85c;color:#fff;">Tail</button>
  <span class="cli-dropdown">
    <button class="btn btn-sm" id="copyCliBtn" title="Copy CLI command (click ▾ for more)">CLI</button><button class="btn btn-sm" id="cliMenuBtn" title="CLI options" style="padding:1px 5px;">▾</button>
    <div class="cli-menu" id="cli-menu">
      <div class="cli-mi" data-action="copy">Copy current search as CLI</div>
      <div class="cli-mi" data-action="paste">Paste CLI &rarr; fill form</div>
    </div>
  </span>
  <div class="history-dropdown" style="display:flex;gap:4px;align-items:center;">
    <button class="btn btn-sm" id="historyBtn" title="Search history &amp; Tail logs">History</button>
    <button class="btn btn-sm" id="helpBtn" title="Usage guide &amp; quick searches" style="font-size:13px;padding:1px 5px;">?</button>
    <div class="history-menu" id="history-menu"></div>
    <div class="history-menu" id="tail-hist-menu"></div>
  </div>
</div>
</div>

<div id="toolbar" class="toolbar">
  <div class="toolbar-row">
    <button class="btn btn-sm" id="searchBackBtn" title="Previous search" disabled style="padding:1px 6px;font-size:13px;">&larr;</button>
    <button class="btn btn-sm" id="searchFwdBtn" title="Next search" disabled style="padding:1px 6px;font-size:13px;">&rarr;</button>
    <span class="status-info" id="status-text"></span>
    <span style="color:#ddd;">|</span>
    <span class="info" id="result-count"></span>
    <span style="flex:1;"></span>
    <label>Filter:</label>
    <span class="clearable"><input type="text" id="local-filter" placeholder="Filter (≥3 chars)" title="Filter results by substring (live ≥3 chars; Enter promotes to chip)" /><button class="clear-btn" tabindex="-1">&times;</button></span>
    <span style="color:#ddd;">|</span>
    <label>Exclude:</label>
    <span class="clearable"><input type="text" id="exclude-input" placeholder="Exclude (Enter)" /><button class="clear-btn" tabindex="-1">&times;</button></span>
    <span style="color:#ddd;">|</span>
    <label>Per page:</label>
    <select id="page-size">
      <option value="100" selected>100</option>
      <option value="250">250</option>
      <option value="500">500</option>
      <option value="1000">1000</option>
    </select>
    <span style="color:#ddd;">|</span>
    <button class="btn btn-sm" id="localTimeBtn" title="Toggle result time display between UTC and Local. Time picker always uses local time, converted to UTC for API query.">UTC</button>
    <button class="btn btn-sm" id="rawJsonBtn" title="Show full JSON wrapped (off = single-line, ellipsis truncated)">Raw</button>
    <button class="btn btn-sm" id="dedupBtn" title="Group identical payloads">Dedup</button>
    <button class="btn btn-sm" id="saveBtn">Save</button>
  </div>
  <div id="toolbar-tags-row" style="display:none;padding:2px 12px;gap:4px;align-items:center;justify-content:center;flex-wrap:wrap;">
    <span id="filter-tags"></span>
    <span id="exclude-tags"></span>
    <span id="excluded-keys-tags"></span>
    <div class="toolbar-tags" id="active-filters"></div>
    <button class="btn btn-sm" id="clearFilterBtn" title="Clear all filters and excludes">Clear all</button>
  </div>
</div>
</div>

<table class="log-table">
  <thead>
    <tr>
      <th class="col-idx" id="th-idx">#</th>
      <th class="col-time" id="th-time" data-sort="time">Time (UTC) <span class="sort-arrow" id="sort-arrow">&#9650;</span><div class="col-resize" data-col="th-time"></div></th>
      <th class="col-source" id="th-source" title="Click to filter by source">Source <span style="opacity:0.6;font-size:9px;">&#9660;</span><div class="col-resize" data-col="th-source"></div></th>
      <th class="col-level" id="th-level" title="Click to filter by level">Level <span style="opacity:0.6;font-size:9px;">&#9660;</span><div class="col-resize" data-col="th-level"></div></th>
      <th id="th-payload">Payload<div class="col-resize" data-col="th-payload"></div></th>
    </tr>
  </thead>
  <tbody id="log-table"></tbody>
</table>
<div class="pagination" id="pagination"></div>

<div class="float-nav">
  <button data-scroll="top" title="Top">&#9650;</button>
  <button data-scroll="bottom" title="Bottom">&#9660;</button>
</div>

<div class="modal-overlay" id="modal-overlay"></div>
<div class="modal" id="modal">
  <div class="modal-header" style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;">
    <h3 id="modal-title" style="margin:0;white-space:nowrap;">Entry Detail</h3>
    <span style="display:flex;gap:6px;align-items:center;">
      <button class="btn btn-sm" id="modal-prev-btn" title="Previous entry (&#x2191;)">&larr;</button>
      <button class="btn btn-sm" id="modal-copy-btn">Copy</button>
      <button class="btn btn-sm" id="modal-next-btn" title="Next entry (&#x2193;)">&rarr;</button>
    </span>
    <span style="display:flex;gap:6px;align-items:center;justify-content:flex-end;">
      <span class="related-dropdown"><button class="btn btn-sm" id="modal-related-btn" style="background:#5cb85c;color:#fff;" title="Related diagnostic searches">Related</button><div class="related-menu" id="related-menu"></div></span>
      <button class="btn btn-sm" id="modal-wrap-btn">Wrap</button>
      <button class="btn btn-sm" id="modal-format-btn" title="Format ON: expand embedded JSON + highlight. OFF: raw entry JSON.">Format</button>
      <span class="close" id="modal-close">&times;</span>
    </span>
  </div>
  <pre id="modal-content"></pre>
</div>

<div class="confirm-overlay" id="confirm-overlay">
  <div class="confirm-box">
    <div class="confirm-header"><span class="confirm-icon">&#9888;&#65039;</span><span class="confirm-title">Large Query Warning</span></div>
    <div class="confirm-msg" id="confirm-msg"></div>
    <div class="confirm-buttons">
      <button class="confirm-cancel" id="confirm-cancel">Cancel</button>
      <button class="confirm-ok" id="confirm-ok">Continue</button>
    </div>
  </div>
</div>

<div class="help-overlay" id="help-overlay">
<div class="help-dialog">
<div class="help-header">
<h2>PAIC Log Search &mdash; Usage Guide</h2>
<span class="help-close" id="help-close">&times;</span>
</div>
<div class="help-body">

<h3>Quick Searches</h3>
<p>Click <b>Run</b> to auto-fill and execute. Replace <code>@</code> or <code>UUID</code> with actual values before running.</p>
<table>
<tr><th>Scenario</th><th></th><th>Source</th><th>Keyword</th><th>Level</th><th>Time</th></tr>
<tr><td colspan="6" style="color:#4a90d9;font-weight:600;padding-top:8px;">Authentication &amp; Sessions</td></tr>
<tr><td>Tree results (who logged in?)</td><td><span class="qs-link" data-qs='{"source":"am-authentication","query":"AM-TREE-LOGIN-COMPLETED","last":"5m"}'>Run</span></td><td><code>am-authentication</code></td><td><code>AM-TREE-LOGIN-COMPLETED</code></td><td></td><td>Last 5min</td></tr>
<tr><td>Failed logins</td><td><span class="qs-link" data-qs='{"source":"am-authentication","query":"AM-TREE-LOGIN-COMPLETED","last":"30m","level":"","filter":"FAILED"}'>Run</span></td><td><code>am-authentication</code></td><td><code>AM-TREE-LOGIN-COMPLETED</code></td><td>filter: FAILED</td><td>Last 30min</td></tr>
<tr><td>User activity (by email)</td><td><span class="qs-link" data-qs='{"source":"idm-everything,am-everything","query":"user@example.com","last":"30m"}'>Run</span></td><td><code>idm-everything, am-everything</code></td><td><code>user@example.com</code> (replace)</td><td></td><td>Last 30min</td></tr>
<tr><td>All tree node executions</td><td><span class="qs-link" data-qs='{"source":"am-authentication","query":"AM-NODE-LOGIN-COMPLETED","last":"5m"}'>Run</span></td><td><code>am-authentication</code></td><td><code>AM-NODE-LOGIN-COMPLETED</code></td><td></td><td>Last 5min</td></tr>
<tr><td>Session created</td><td><span class="qs-link" data-qs='{"source":"am-activity","query":"AM-SESSION-CREATED","last":"30m"}'>Run</span></td><td><code>am-activity</code></td><td><code>AM-SESSION-CREATED</code></td><td></td><td>Last 30min</td></tr>
<tr><td>Session timeout / logout</td><td><span class="qs-link" data-qs='{"source":"am-activity","query":"AM-SESSION","last":"1h"}'>Run</span></td><td><code>am-activity</code></td><td><code>AM-SESSION</code></td><td></td><td>Last 1hr</td></tr>
<tr><td colspan="6" style="color:#4a90d9;font-weight:600;padding-top:8px;">Errors &amp; Diagnostics</td></tr>
<tr><td>Errors / Exceptions</td><td><span class="qs-link" data-qs='{"source":"idm-everything,am-everything","query":"Exception","last":"5m","level":"ERROR"}'>Run</span></td><td><code>idm-everything, am-everything</code></td><td><code>Exception</code></td><td>ERROR</td><td>Last 5min</td></tr>
<tr><td>AM script errors</td><td><span class="qs-link" data-qs='{"source":"am-core","query":"ERROR","last":"5m","level":"ERROR"}'>Run</span></td><td><code>am-core</code></td><td><code>ERROR</code></td><td>ERROR</td><td>Last 5min</td></tr>
<tr><td>IDM endpoint errors</td><td><span class="qs-link" data-qs='{"source":"idm-core","query":"SEVERE","last":"10m"}'>Run</span></td><td><code>idm-core</code></td><td><code>SEVERE</code></td><td></td><td>Last 10min</td></tr>
<tr><td colspan="6" style="color:#4a90d9;font-weight:600;padding-top:8px;">User &amp; Object Operations</td></tr>
<tr><td>User PATCH/UPDATE (by UUID)</td><td><span class="qs-link" data-qs='{"source":"idm-activity","query":"alpha_user","last":"5m"}'>Run</span></td><td><code>idm-activity</code></td><td><code>alpha_user</code> (add UUID)</td><td></td><td>Last 5min</td></tr>
<tr><td>Identity changes in AM</td><td><span class="qs-link" data-qs='{"source":"am-activity","query":"AM-IDENTITY-CHANGE","last":"30m"}'>Run</span></td><td><code>am-activity</code></td><td><code>AM-IDENTITY-CHANGE</code></td><td></td><td>Last 30min</td></tr>
<tr><td>Role / relationship changes</td><td><span class="qs-link" data-qs='{"source":"idm-activity","query":"relationship","last":"30m"}'>Run</span></td><td><code>idm-activity</code></td><td><code>relationship</code></td><td></td><td>Last 30min</td></tr>
<tr><td colspan="6" style="color:#4a90d9;font-weight:600;padding-top:8px;">API, Sync &amp; Scheduled Tasks</td></tr>
<tr><td>IDM REST API calls</td><td><span class="qs-link" data-qs='{"source":"idm-access","query":"","last":"5m"}'>Run</span></td><td><code>idm-access</code></td><td>(none)</td><td></td><td>Last 5min</td></tr>
<tr><td>Sync operations</td><td><span class="qs-link" data-qs='{"source":"idm-sync","query":"","last":"1h"}'>Run</span></td><td><code>idm-sync</code></td><td>(none)</td><td></td><td>Last 1hr</td></tr>
<tr><td>Scheduled tasks</td><td><span class="qs-link" data-qs='{"source":"idm-core","query":"Scheduled service","last":"5m"}'>Run</span></td><td><code>idm-core</code></td><td><code>Scheduled service</code></td><td></td><td>Last 5min</td></tr>
<tr><td colspan="6" style="color:#4a90d9;font-weight:600;padding-top:8px;">SAML &amp; OAuth2 / OIDC</td></tr>
<tr><td>SAML SSO requests</td><td><span class="qs-link" data-qs='{"source":"am-access","query":"SSOPOST","last":"30m"}'>Run</span></td><td><code>am-access</code></td><td><code>SSOPOST</code></td><td></td><td>Last 30min</td></tr>
<tr><td>OAuth2 token exchange</td><td><span class="qs-link" data-qs='{"source":"am-access","query":"access_token","last":"5m"}'>Run</span></td><td><code>am-access</code></td><td><code>access_token</code></td><td></td><td>Last 5min</td></tr>
<tr><td>OAuth2 errors</td><td><span class="qs-link" data-qs='{"source":"am-access","query":"FAILED","last":"30m"}'>Run</span></td><td><code>am-access</code></td><td><code>FAILED</code></td><td></td><td>Last 30min</td></tr>
</table>

<h3>Diagnostic Workflows</h3>
<table>
<tr><th>Goal</th><th>Steps</th></tr>
<tr><td style="white-space:nowrap;"><b>Trace a login flow</b></td><td>Search <code>am-authentication</code> with user email &rarr; find <code>AM-TREE-LOGIN-COMPLETED</code> (shows tree name + SUCCESSFUL/FAILED) &rarr; click entry &rarr; <b>Related</b> &rarr; "All nodes in tree" &rarr; see every node with <code>nodeOutcome</code> and <code>displayName</code></td></tr>
<tr><td style="white-space:nowrap;"><b>Debug a failed login</b></td><td>Search <code>am-authentication</code> keyword <code>FAILED</code> &rarr; find the failed tree &rarr; <b>Related</b> &rarr; "All nodes" to find which node failed &rarr; then "Same transactionId" to see AM script errors in <code>am-core</code></td></tr>
<tr><td style="white-space:nowrap;"><b>Trace a full request</b></td><td>Find any log entry &rarr; <b>Related</b> &rarr; "Same transactionId" &mdash; all log entries across IDM + AM for the same HTTP request share the same transactionId (from <code>x-forgerock-transactionid</code> header)</td></tr>
<tr><td style="white-space:nowrap;"><b>Track user changes</b></td><td>Search <code>idm-activity</code> with user UUID &rarr; see all PATCH/CREATE/DELETE operations with <code>before</code>/<code>after</code> state and <code>changedFields</code></td></tr>
<tr><td style="white-space:nowrap;"><b>Find root cause</b></td><td>See an error &rarr; <b>Related</b> &rarr; "Errors &plusmn;60s" for nearby errors &rarr; "Same source &plusmn;5s" for context &rarr; "Same transactionId" to trace back to the triggering request</td></tr>
<tr><td style="white-space:nowrap;"><b>Compare two queries</b></td><td>Click the env in the sidebar a second time &rarr; new tab opens with independent state &rarr; tail one source in tab A while searching another in tab B</td></tr>
<tr><td style="white-space:nowrap;"><b>Re-open an old tail</b></td><td>History menu &rarr; <b>Tail Files</b> tab &rarr; click a saved stream &rarr; entries load into the current tab as a non-tail result set</td></tr>
<tr><td style="white-space:nowrap;"><b>Export results</b></td><td><b>Save</b> in toolbar &rarr; native save dialog &rarr; pick <code>.ndjson</code> or <code>.json</code> &rarr; full session is written, not just the current page</td></tr>
<tr><td style="white-space:nowrap;"><b>Filter by field value</b></td><td><b>+Field</b> in toolbar &rarr; pick a field &rarr; pick a value (sorted by frequency in current data) &rarr; chip is added to the filter row, AND-combined with other chips</td></tr>
</table>

<h3>Log Sources <span style="font-weight:normal;font-size:11px;color:#999;">(from <a href="https://docs.pingidentity.com/pingoneaic/tenants/audit-debug-log-sources.html" target="_blank" style="color:#4a90d9;">official docs</a>)</span></h3>
<table>
<tr><th>Source</th><th>Type</th><th>Content</th><th>Key Fields</th></tr>
<tr><td colspan="4" style="color:#666;font-weight:600;padding-top:6px;">AM (Access Management)</td></tr>
<tr><td><code>am-everything</code></td><td>All</td><td>All AM audit + debug logs combined</td><td></td></tr>
<tr><td><code>am-authentication</code></td><td>Audit</td><td>Journey trees, node executions, login/logout, sessions</td><td>eventName, principal, result, treeName, nodeOutcome, trackingIds</td></tr>
<tr><td><code>am-core</code></td><td>Debug</td><td>AM scripts (ScriptedDecision, IDPAttributeMapper), internal logs. DEV/SB: DEBUG level; STAGING/PROD: WARNING+</td><td>logger, message, level, transactionId</td></tr>
<tr><td><code>am-access</code></td><td>Audit</td><td>Incoming REST API calls (OAuth, OIDC, SAML endpoints)</td><td>eventName, http.request, response, userId, component</td></tr>
<tr><td><code>am-activity</code></td><td>Audit</td><td>State changes to objects created/updated/deleted by end users</td><td>eventName, objectId, operation</td></tr>
<tr><td><code>am-config</code></td><td>Audit</td><td>AM configuration changes with timestamp and who made them</td><td>eventName, objectId, operation</td></tr>
<tr><td colspan="4" style="color:#666;font-weight:600;padding-top:6px;">IDM (Identity Management)</td></tr>
<tr><td><code>idm-everything</code></td><td>All</td><td>All IDM audit + debug logs combined</td><td></td></tr>
<tr><td><code>idm-core</code></td><td>Debug</td><td>IDM scripts, endpoints, scheduler (plain text format)</td><td>(search by keyword &mdash; no structured fields)</td></tr>
<tr><td><code>idm-activity</code></td><td>Audit</td><td>Object CRUD: PATCH, CREATE, DELETE on managed objects</td><td>objectId, operation, changedFields, before/after, userId</td></tr>
<tr><td><code>idm-access</code></td><td>Audit</td><td>Incoming IDM REST API calls, scheduled task invocations</td><td>request, response, userId, roles</td></tr>
<tr><td><code>idm-authentication</code></td><td>Audit</td><td>IDM authentication events</td><td>principal, result, transactionId</td></tr>
<tr><td><code>idm-config</code></td><td>Audit</td><td>IDM configuration modifications</td><td>eventName, objectId, operation</td></tr>
<tr><td><code>idm-recon</code></td><td>Audit</td><td>Reconciliation operations and results</td><td>mapping, situation, action, sourceObjectId</td></tr>
<tr><td><code>idm-sync</code></td><td>Audit</td><td>Synchronization activity: mapping results, actions, situations</td><td>mapping, action, situation, sourceObjectId, targetObjectId</td></tr>
<tr><td colspan="4" style="color:#666;font-weight:600;padding-top:6px;">Other</td></tr>
<tr><td><code>environment-access</code></td><td>Audit</td><td>Environment configuration changes</td><td></td></tr>
<tr><td><code>ws-everything</code></td><td>All</td><td>All WS-Federation audit + debug logs</td><td></td></tr>
<tr><td><code>ws-activity</code></td><td>Audit</td><td>WS-Federation activity events</td><td></td></tr>
<tr><td><code>ws-config</code></td><td>Audit</td><td>WS-Federation configuration changes</td><td></td></tr>
<tr><td><code>ws-core</code></td><td>Debug</td><td>WS-Federation debug logging</td><td></td></tr>
</table>

<h3>Key Concepts: transactionId vs trackingIds</h3>
<table>
<tr><th></th><th>transactionId</th><th>trackingIds</th></tr>
<tr><td style="white-space:nowrap;"><b>Scope</b></td><td>One HTTP request</td><td>One authentication session (login attempt)</td></tr>
<tr><td style="white-space:nowrap;"><b>Origin</b></td><td><code>x-forgerock-transactionid</code> response header, assigned per request</td><td>Generated when a journey starts, shared across all nodes</td></tr>
<tr><td style="white-space:nowrap;"><b>Spans</b></td><td>AM &rarr; IDM call chain for a single request. Sub-calls append <code>/0</code>, <code>/0/10</code>, etc.</td><td>Entire login process across multiple HTTP requests (each node callback = separate request with different transactionId)</td></tr>
<tr><td style="white-space:nowrap;"><b>Found in</b></td><td>All sources (am-*, idm-*)</td><td>am-authentication, am-access</td></tr>
<tr><td style="white-space:nowrap;"><b>Use case</b></td><td>"What happened during this one API call?" &mdash; trace a single operation across AM + IDM</td><td>"What happened during this entire login?" &mdash; see all nodes executed in a journey tree</td></tr>
<tr><td style="white-space:nowrap;"><b>Example</b></td><td><code>00-a3808c8d...dbae-2bf5ec...07-01/0</code></td><td><code>ce6499fb-32df-40f4-8bfd-c01c80bbcf92-329166</code></td></tr>
</table>
<p style="font-size:11px;color:#666;">In <b>Related</b> menu: "Same transactionId" traces one request; "All nodes in tree" uses trackingId to trace the full login.</p>

<h3>Common eventName Values</h3>
<table>
<tr><th>eventName</th><th>Source</th><th>Meaning</th></tr>
<tr><td><code>AM-TREE-LOGIN-COMPLETED</code></td><td>am-authentication</td><td>Journey tree finished (check <code>result</code>: SUCCESSFUL/FAILED)</td></tr>
<tr><td><code>AM-NODE-LOGIN-COMPLETED</code></td><td>am-authentication</td><td>Single node in tree finished (check <code>nodeOutcome</code>, <code>displayName</code>)</td></tr>
<tr><td><code>AM-LOGIN-COMPLETED</code></td><td>am-authentication</td><td>Overall login completed (module-based)</td></tr>
<tr><td><code>AM-SESSION-CREATED</code></td><td>am-activity</td><td>New session established</td></tr>
<tr><td><code>AM-SESSION-IDLE_TIMED_OUT</code></td><td>am-activity</td><td>Session expired due to inactivity</td></tr>
<tr><td><code>AM-SESSION-MAX_TIMED_OUT</code></td><td>am-activity</td><td>Session hit max lifetime</td></tr>
<tr><td><code>AM-SESSION-LOGGED_OUT</code></td><td>am-activity</td><td>User explicitly logged out</td></tr>
<tr><td><code>AM-ACCESS-ATTEMPT/OUTCOME</code></td><td>am-access</td><td>REST API request start/finish (OAuth, SAML, etc.)</td></tr>
<tr><td><code>AM-IDENTITY-CHANGE</code></td><td>am-activity</td><td>User profile changed via AM</td></tr>
<tr><td><code>AM-LOGOUT</code></td><td>am-authentication</td><td>Logout event</td></tr>
<tr><td><code>activity</code></td><td>idm-activity</td><td>IDM object operation (PATCH, CREATE, DELETE)</td></tr>
<tr><td><code>sync</code></td><td>idm-sync</td><td>Sync/recon operation result</td></tr>
<tr><td><code>access</code></td><td>idm-access</td><td>IDM REST API call or scheduled task</td></tr>
</table>

<h3>Tips</h3>
<ul>
<li><b>Multi-tab</b>: every click on an env in the sidebar opens a new tab with independent state. UI preferences (column widths, toggles, ETA samples) are shared; results / filters / modal index are per-tab.</li>
<li><b>Tail Files</b>: every tail stream auto-saves to disk (FIFO 20). Browse from History menu &rarr; <b>Tail Files</b> tab &rarr; click to load, &times; to delete.</li>
<li><b>Save / export</b>: <b>Save</b> button in toolbar &rarr; NDJSON or JSON &rarr; full session, not just current page.</li>
<li><b>+Field filter</b>: extracts fields and values by frequency from the current result set; click chip &times; to remove individually.</li>
<li><b>Dedup</b> &rarr; collapse duplicate log entries; click the &times;N badge to exclude that group entirely.</li>
<li><b>Custom</b> &rarr; show only scripts/endpoints; auto-resets at the start of every search.</li>
<li><b>Related</b> in detail view &rarr; 15+ diagnostic templates grouped by Trace / Auth Tree / User / Object / Context / Diagnostics, each with its own editable window seconds (saved per template).</li>
<li><kbd>Double-click</kbd> time input &rarr; set to Now. <kbd>Paste</kbd> any time format (ISO, epoch ms/s, "2026-03-26 11:48") &rarr; auto-converted.</li>
<li><b>&larr; &rarr;</b> toolbar buttons &rarr; navigate between previous searches in this tab (sessionStorage; doesn't survive tab close).</li>
<li>Hover <b>Search</b> button &rarr; see estimated query time based on local samples.</li>
<li><b>CLI</b> button &rarr; copy the equivalent <code>paic-logs search &hellip;</code> shell command to clipboard.</li>
<li>Modal <b>Format</b> ON &rarr; deep-clone, embedded-JSON expansion, unescape, log/keyword highlights. OFF &rarr; raw entry JSON.</li>
<li>Modal <b>Wrap</b> &rarr; wrap long single-line content (base64 blobs, URLs).</li>
<li>Tip: use <code>X-ForgeRock-TransactionId</code> header with a custom UUID in REST calls, then search that UUID to find all related logs.</li>
</ul>

<h3>Keyboard Shortcuts</h3>
<table>
<tr><td><kbd>Cmd/Ctrl+K</kbd></td><td>Focus the keyword input</td></tr>
<tr><td><kbd>Enter</kbd> (in keyword)</td><td>Run search</td></tr>
<tr><td><kbd>Enter</kbd> (in filter)</td><td>Promote current term to a chip</td></tr>
<tr><td><kbd>Enter</kbd> (in exclude)</td><td>Add an exclude word chip</td></tr>
<tr><td><kbd>Esc</kbd></td><td>Priority chain: close modal &rarr; overlay &rarr; popup &rarr; clear filter</td></tr>
<tr><td><kbd>&uarr;</kbd> <kbd>&darr;</kbd> <kbd>&larr;</kbd> <kbd>&rarr;</kbd> (in modal)</td><td>Prev / Next entry (auto-flips page at boundaries)</td></tr>
<tr><td>Double-click datetime</td><td>Set to Now</td></tr>
<tr><td>Double-click row</td><td>Copy that entry's payload</td></tr>
<tr><td>Click time cell</td><td>Copy that timestamp</td></tr>
</table>
</div>
</div>
</div>

<script nonce="${nonce}" src="${main}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    LogSearchPanel.instances.delete(this);
    for (const ctrl of this.tails.values()) ctrl.abort();
    this.tails.clear();
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try { d?.dispose(); } catch { /* ignore */ }
    }
  }
}

function makeNonce(): string {
  let result = '';
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function formatPanelTitle(env?: string, count?: number, tail?: boolean): string {
  if (!env) return 'Ping AIC Logs';
  if (typeof count !== 'number' || count <= 0) return env;
  const suffix = tail ? ' (tailing)' : '';
  return `${env} | ${count} results${suffix}`;
}

/** Fire-and-forget tell the sidebar's TailFiles + RecentSearches views to
 *  refresh. Goes via the command bus to keep panel.ts decoupled from the
 *  view providers (which live in extension.ts). */
function notifySidebarRefresh(): void {
  vscode.commands.executeCommand('paicLogSearch.refreshSidebar').then(undefined, () => { /* command not registered yet — ignore */ });
}
