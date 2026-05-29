import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { HistoryEntry, LogEntry } from './types';

/**
 * Search history is persisted as a plain JSON file under the extension's
 * globalStorage directory: `<globalStorage>/search-history.json`. This makes
 * it inspectable / backup-able / portable, alongside the saved tail files.
 *
 * Legacy entries from v0.1.0's `globalState` storage are migrated on first
 * load (and the old key cleared) so users don't lose their prior history.
 */
const HISTORY_KEY_LEGACY = 'pingAicLogs.searchHistory';
const HISTORY_FILE = 'search-history.json';
const HISTORY_LIMIT_DEFAULT = 100;

/** Read the user-configurable history cap; cheap, called per add(). */
function historyLimit(): number {
  const cfg = vscode.workspace.getConfiguration('paicLogSearch');
  const v = cfg.get<number>('searchHistoryLimit', HISTORY_LIMIT_DEFAULT);
  return Number.isFinite(v) && v > 0 ? v : HISTORY_LIMIT_DEFAULT;
}

export class HistoryStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires after every mutation (add / deleteAt / clear) so listeners (sidebar
   *  Recent Searches view, in-panel history menu, etc.) can refresh. */
  readonly onDidChange = this._onDidChange.event;

  /** In-memory cache. Synced to disk after every mutation; populated from
   *  disk by ensureLoaded() at activation time. */
  private cache: HistoryEntry[] | null = null;

  /** Serializes concurrent writes (multiple tabs / rapid mutations) so
   *  read-modify-write doesn't tear the JSON file. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Path to the JSON file backing the history. */
  private filePath(): string {
    return path.join(this.context.globalStorageUri.fsPath, HISTORY_FILE);
  }

  /** Synchronous accessor — returns the cached list. ensureLoaded() MUST be
   *  awaited at activation before any list() / add() / etc. */
  list(): HistoryEntry[] {
    return this.cache ? this.cache.slice() : [];
  }

  /** First call loads from disk + auto-migrates legacy globalState entries.
   *  Idempotent: subsequent calls are no-ops. */
  async ensureLoaded(): Promise<void> {
    if (this.cache !== null) return;
    try {
      const raw = await fs.readFile(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = Array.isArray(parsed) ? parsed : [];
      return;
    } catch {
      // No file yet (or unreadable) — try migrating from old globalState.
    }
    const legacy = this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY_LEGACY);
    if (Array.isArray(legacy) && legacy.length > 0) {
      this.cache = legacy.slice();
      await this.flush();
      // Clear the old globalState entry so we don't re-migrate on next launch.
      try { await this.context.globalState.update(HISTORY_KEY_LEGACY, undefined); } catch { /* ignore */ }
    } else {
      this.cache = [];
    }
  }

  async add(entry: HistoryEntry): Promise<void> {
    await this.ensureLoaded();
    const list = (this.cache as HistoryEntry[]).slice();
    const top = list[0];
    // Replace top-of-list when env+source+query+range match: avoids history
    // bloating with near-duplicate entries from page navigation / re-runs.
    if (top
      && top.env === entry.env
      && top.source === entry.source
      && top.query === entry.query
      && top.begin === entry.begin
      && top.end === entry.end) {
      list[0] = entry;
    } else {
      list.unshift(entry);
    }
    const limit = historyLimit();
    while (list.length > limit) list.pop();
    this.cache = list;
    await this.flush();
    this._onDidChange.fire();
  }

  async deleteAt(index: number): Promise<void> {
    await this.ensureLoaded();
    const list = (this.cache as HistoryEntry[]).slice();
    if (index >= 0 && index < list.length) list.splice(index, 1);
    this.cache = list;
    await this.flush();
    this._onDidChange.fire();
  }

  async clear(): Promise<void> {
    this.cache = [];
    await this.flush();
    this._onDidChange.fire();
  }

  async clearZeroCount(): Promise<number> {
    await this.ensureLoaded();
    const before = (this.cache as HistoryEntry[]).length;
    this.cache = (this.cache as HistoryEntry[]).filter((e) => (e.totalCount ?? 0) > 0);
    const removed = before - this.cache.length;
    if (removed > 0) {
      await this.flush();
      this._onDidChange.fire();
    }
    return removed;
  }

  /** Serialize current cache to disk. Reads/writes serialized via promise
   *  chain so concurrent flushes don't interleave. */
  private flush(): Promise<void> {
    const snapshot = this.cache ? this.cache.slice() : [];
    this.writeChain = this.writeChain.then(async () => {
      try {
        const dir = path.dirname(this.filePath());
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(this.filePath(), JSON.stringify(snapshot, null, 2));
      } catch (e) {
        console.warn('[ping-aic-logs] history flush failed:', e);
      }
    });
    return this.writeChain;
  }
}

/**
 * In-memory cache for paged search results.
 * Each search produces a sessionId; webview can fetch arbitrary pages of that
 * session without re-querying PAIC. Cache is bounded by sessionLimit and
 * evicted LRU on overflow. Lives only for the panel's lifetime.
 */
export interface CachedSession {
  sessionId: string;
  entries: LogEntry[];
  totalCount: number;
  truncated: boolean;
  createdAt: number;
}

export class SearchSessionCache {
  private readonly sessions = new Map<string, CachedSession>();
  constructor(private readonly limit = 20) {}

  put(entries: LogEntry[], truncated: boolean): CachedSession {
    const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const session: CachedSession = {
      sessionId,
      entries,
      totalCount: entries.length,
      truncated,
      createdAt: Date.now()
    };
    this.sessions.set(sessionId, session);
    this.evictIfNeeded();
    return session;
  }

  get(sessionId: string): CachedSession | undefined {
    return this.sessions.get(sessionId);
  }

  page(sessionId: string, pageNum: number, pageSize: number): {
    entries: LogEntry[];
    page: number;
    pages: number;
    totalCount: number;
    truncated: boolean;
  } | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const pages = Math.max(1, Math.ceil(s.totalCount / pageSize));
    const safePage = Math.max(0, Math.min(pageNum, pages - 1));
    const start = safePage * pageSize;
    return {
      entries: s.entries.slice(start, start + pageSize),
      page: safePage,
      pages,
      totalCount: s.totalCount,
      truncated: s.truncated
    };
  }

  private evictIfNeeded(): void {
    while (this.sessions.size > this.limit) {
      const oldestKey = [...this.sessions.entries()].sort(
        ([, a], [, b]) => a.createdAt - b.createdAt
      )[0][0];
      this.sessions.delete(oldestKey);
    }
  }
}
