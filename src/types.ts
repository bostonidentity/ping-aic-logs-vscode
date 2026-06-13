// Webview ↔ extension host message protocol.
// Adding a new message: extend the discriminated union on BOTH directions.

export interface EnvironmentMeta {
  /** Display name (e.g. "UAT"). Unique per workspace. */
  name: string;
  /** Tenant base URL, no trailing slash. */
  url: string;
}

export interface EnvironmentSecret {
  /** PAIC log API key (X-API-Key header). */
  key: string;
  /** PAIC log API secret (X-API-Secret header). */
  secret: string;
}

export interface SearchRequest {
  env: string;
  /** Comma-joined source list (e.g. "idm-everything,am-everything"). */
  source: string;
  /** Free-text user query; will be passed to buildQueryFilter. */
  query: string;
  /** ISO 8601 UTC. */
  begin?: string;
  end?: string;
  /** Max rows total to fetch across pages. */
  limit?: number;
}

export interface LogEntry {
  timestamp?: string;
  source?: string;
  payload?: unknown;
  type?: string;
  [key: string]: unknown;
}

export interface SearchResultPage {
  sessionId: string;
  totalCount: number;
  page: number;
  pageSize: number;
  pages: number;
  entries: LogEntry[];
  truncated: boolean;
}

export interface TailRequest {
  env: string;
  source: string;
  query: string;
  /** Stream id (host-issued); webview keeps to stop the right stream. */
  streamId?: string;
}

export interface HistoryEntry {
  timestamp: number; // epoch ms
  env: string;
  source: string;
  query: string;
  begin?: string;
  end?: string;
  totalCount?: number;
}

/** Cloned-session payload — used to fork a search panel without re-querying
 *  PAIC. Includes the form fields (so the new panel's UI matches the
 *  source's) plus the full entry list and counts. */
export interface ClonedSession {
  formEntry: HistoryEntry;
  entries: LogEntry[];
  totalCount: number;
  truncated: boolean;
}

/** Subset of user-configurable settings forwarded to the webview at init. */
export interface PaicHighlightRule {
  pattern: string;
  color: string;
  fontWeight?: string | number;
}

export interface PaicConfig {
  largeQueryThresholdMinutes: number;
  defaultPageSize: number;
  highlightRules?: PaicHighlightRule[];
}

export interface TailFileMeta {
  /** Filename relative to globalStorage/tails/ (without path). */
  name: string;
  env: string;
  source: string;
  query: string;
  /** Epoch ms when stream started. */
  startTime: number;
  /** Epoch ms when stream ended (or last batch arrived). */
  endTime: number;
  /** Number of entries written. */
  count: number;
}

/* ───────── Webview → Host ───────── */

export type WebviewToHostMessage =
  | { type: 'getEnvironments' }
  | { type: 'listSources'; payload: { env: string } }
  | { type: 'search'; payload: SearchRequest }
  | { type: 'getPage'; payload: { sessionId: string; page: number; pageSize: number } }
  | { type: 'startTail'; payload: TailRequest }
  | { type: 'stopTail'; payload: { streamId: string } }
  | { type: 'getHistory' }
  | { type: 'addHistory'; payload: HistoryEntry }
  | { type: 'deleteHistory'; payload: { index: number } }
  | { type: 'clearHistory' }
  | { type: 'saveResults'; payload: { entries: LogEntry[]; format?: 'ndjson' | 'json' } }
  | { type: 'listTailFiles' }
  | { type: 'loadTailFile'; payload: { name: string } }
  | { type: 'deleteTailFile'; payload: { name: string } }
  | { type: 'setTitle'; payload: { env?: string; count?: number; tail?: boolean } }
  | { type: 'openPanelWithSearch'; payload: HistoryEntry }
  | { type: 'cloneCurrentToNewPanel'; payload: ClonedSession };

/* ───────── Host → Webview ───────── */

export type HostToWebviewMessage =
  | { type: 'environments'; payload: EnvironmentMeta[] }
  | { type: 'sourceList'; payload: string[] }
  | { type: 'searchResult'; payload: SearchResultPage }
  | { type: 'pageResult'; payload: SearchResultPage }
  | { type: 'tailBatch'; payload: { streamId: string; entries: LogEntry[] } }
  | { type: 'tailEnded'; payload: { streamId: string; reason?: string } }
  | { type: 'history'; payload: HistoryEntry[] }
  | { type: 'tailFiles'; payload: TailFileMeta[] }
  | { type: 'tailFileLoaded'; payload: { name: string; meta: TailFileMeta; entries: LogEntry[] } }
  | { type: 'tailFileDeleted'; payload: { name: string } }
  | { type: 'savedResults'; payload: { path: string; count: number } }
  | { type: 'setInitialEnv'; payload: { env: string } }
  | { type: 'restoreSearch'; payload: HistoryEntry }
  | { type: 'cloneSession'; payload: ClonedSession }
  | { type: 'triggerDuplicate' }
  | { type: 'config'; payload: PaicConfig }
  | { type: 'resetPreferences' }
  | { type: 'error'; payload: { message: string; context?: string } };
