import { EnvironmentMeta, EnvironmentSecret, LogEntry } from './types';

/**
 * Thin client for PingOne Advanced Identity Cloud's Logs API.
 *
 * Reference: https://docs.pingidentity.com/pingoneaic/latest/tenants/audit-debug-logs-pull.html
 *
 * Auth: two custom headers (NOT OAuth):
 *   x-api-key:    <log API key>
 *   x-api-secret: <log API secret>
 */

/**
 * Per-source `_queryFilter` field paths. Mirrors the heuristics from the
 * upstream Python tool. text/plain payloads (idm-core) match against /payload
 * directly; JSON payloads (am-* / idm-access / idm-activity) need explicit
 * field paths because PAIC won't `co` against object roots.
 */
const SOURCE_SEARCH_FIELDS: Record<string, string[]> = {
  'idm-core': ['/payload'],
  'am-core': ['/payload/message', '/payload/logger', '/payload/exception', '/payload/transactionId'],
  'am-authentication': [
    '/payload/eventName',
    '/payload/userId',
    '/payload/transactionId',
    '/payload/trackingIds',
    '/payload/component',
    '/payload/realm',
    '/payload/entries/info/treeName',
    '/payload/entries/info/displayName',
    '/payload/entries/info/nodeId',
    '/payload/response/status',
    '/payload/response/detail'
  ],
  'am-activity': [
    '/payload/eventName',
    '/payload/userId',
    '/payload/transactionId',
    '/payload/trackingIds',
    '/payload/component',
    '/payload/realm',
    '/payload/objectId',
    '/payload/operation',
    '/payload/response/status'
  ],
  'am-access': [
    '/payload/eventName',
    '/payload/userId',
    '/payload/transactionId',
    '/payload/trackingIds',
    '/payload/component',
    '/payload/realm',
    '/payload/http/request/path',
    '/payload/response/status',
    '/payload/response/statusCode'
  ],
  'idm-access': [
    '/payload/eventName',
    '/payload/userId',
    '/payload/transactionId',
    '/payload/trackingIds',
    '/payload/http/request/path',
    '/payload/resourceOperation/uri',
    '/payload/response/status',
    '/payload/response/statusCode'
  ],
  'idm-activity': [
    '/payload/eventName',
    '/payload/userId',
    '/payload/transactionId',
    '/payload/trackingIds',
    '/payload/message',
    '/payload/objectId',
    '/payload/operation',
    '/payload/response/status'
  ],
  'idm-authentication': [
    '/payload/eventName',
    '/payload/userId',
    '/payload/transactionId',
    '/payload/trackingIds',
    '/payload/response/status'
  ],
  'idm-sync': [
    '/payload/eventName',
    '/payload/userId',
    '/payload/transactionId',
    '/payload/trackingIds',
    '/payload/message',
    '/payload/mapping',
    '/payload/sourceObjectId',
    '/payload/targetObjectId',
    '/payload/situation',
    '/payload/action',
    '/payload/response/status'
  ]
};

const DEFAULT_FIELDS = ['/payload', '/payload/message', '/payload/transactionId'];

/** All known sources; used as fallback when /monitoring/logs/sources can't be reached. */
export const KNOWN_SOURCES = [
  'am-access',
  'am-activity',
  'am-authentication',
  'am-config',
  'am-core',
  'am-everything',
  'idm-access',
  'idm-activity',
  'idm-authentication',
  'idm-config',
  'idm-core',
  'idm-everything',
  'idm-recon',
  'idm-sync'
];

function getSearchFields(source: string): string[] {
  const sources = source.split(',').map((s) => s.trim()).filter(Boolean);
  const out = new Set<string>();
  for (const s of sources) {
    if (SOURCE_SEARCH_FIELDS[s]) {
      SOURCE_SEARCH_FIELDS[s].forEach((f) => out.add(f));
    } else if (s.endsWith('-everything')) {
      const prefix = s.replace('-everything', '-');
      for (const [key, vals] of Object.entries(SOURCE_SEARCH_FIELDS)) {
        if (key.startsWith(prefix)) vals.forEach((f) => out.add(f));
      }
    } else {
      DEFAULT_FIELDS.forEach((f) => out.add(f));
    }
  }
  return Array.from(out).sort();
}

export function buildQueryFilter(source: string, query: string): string {
  if (!query || !query.trim()) return 'true';
  const fields = getSearchFields(source);
  const escaped = query.replace(/"/g, '\\"');
  const clauses = fields.map((f) => `${f} co "${escaped}"`);
  return '(' + clauses.join(' or ') + ')';
}

export interface FetchOptions {
  source: string;
  query: string;
  begin?: string;
  end?: string;
  pageSize?: number;
  /** Cap total rows across pages (PAIC has no hard limit). */
  maxRows?: number;
  /** Optional cancellation. */
  signal?: AbortSignal;
  /** Called per page so the caller can stream incrementally. */
  onPage?: (page: LogEntry[], soFar: number) => void;
}

export interface FetchResult {
  entries: LogEntry[];
  truncated: boolean;
}

const PAGE_DELAY_MS = 1000; // mirrors frodo-cli rate-limit pause

export class PaicClient {
  constructor(
    private readonly env: EnvironmentMeta,
    private readonly secret: EnvironmentSecret
  ) {}

  /** List available log sources for this tenant. */
  async listSources(): Promise<string[]> {
    try {
      const url = `${this.env.url}/monitoring/logs/sources`;
      const resp = await this.request(url);
      const json = (await resp.json()) as { result?: Array<{ source?: string } | string> };
      const list = (json.result ?? [])
        .map((r) => (typeof r === 'string' ? r : r?.source ?? ''))
        .filter(Boolean);
      return list.length ? list : KNOWN_SOURCES;
    } catch {
      // Fall back to the static list — tenants sometimes don't expose /sources to log-only API keys.
      return KNOWN_SOURCES;
    }
  }

  /** Run a search, paginating internally until no more rows or maxRows hit. */
  async search(opts: FetchOptions): Promise<FetchResult> {
    const filter = buildQueryFilter(opts.source, opts.query);
    const pageSize = opts.pageSize ?? 1000;
    const maxRows = opts.maxRows ?? 50000;

    const all: LogEntry[] = [];
    let cookie: string | undefined;
    let truncated = false;

    for (;;) {
      if (opts.signal?.aborted) {
        truncated = true;
        break;
      }

      const params = new URLSearchParams();
      params.set('source', opts.source);
      if (opts.begin) params.set('beginTime', opts.begin);
      if (opts.end) params.set('endTime', opts.end);
      params.set('_queryFilter', filter);
      params.set('pageSize', String(pageSize));
      if (cookie) params.set('_pagedResultsCookie', cookie);

      const url = `${this.env.url}/monitoring/logs?${params.toString()}`;
      const resp = await this.request(url, opts.signal);
      const json = (await resp.json()) as {
        result?: LogEntry[];
        pagedResultsCookie?: string | null;
      };

      const page = json.result ?? [];
      all.push(...page);
      opts.onPage?.(page, all.length);

      cookie = json.pagedResultsCookie ?? undefined;
      if (!cookie || page.length < pageSize) break;
      if (all.length >= maxRows) {
        truncated = true;
        break;
      }
      // rate limit
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }

    return { entries: all, truncated };
  }

  /** Tail mode: poll /monitoring/logs/tail and yield batches. Cancel via signal. */
  async *tail(opts: {
    source: string;
    query?: string;
    signal: AbortSignal;
    /** Polling interval in ms (host reads from settings; default 1000). */
    pollIntervalMs?: number;
  }): AsyncGenerator<LogEntry[]> {
    let cookie: string | undefined;
    const filter = opts.query ? buildQueryFilter(opts.source, opts.query) : undefined;
    const pollMs = opts.pollIntervalMs ?? 1000;

    while (!opts.signal.aborted) {
      const params = new URLSearchParams();
      params.set('source', opts.source);
      if (filter && filter !== 'true') params.set('_queryFilter', filter);
      if (cookie) params.set('_pagedResultsCookie', cookie);

      const url = `${this.env.url}/monitoring/logs/tail?${params.toString()}`;
      try {
        const resp = await this.request(url, opts.signal);
        const json = (await resp.json()) as {
          result?: LogEntry[];
          pagedResultsCookie?: string | null;
        };
        cookie = json.pagedResultsCookie ?? undefined;
        const batch = json.result ?? [];
        if (batch.length > 0) yield batch;
      } catch (err) {
        if (opts.signal.aborted) break;
      }
      await sleep(pollMs, opts.signal);
    }
  }

  private async request(url: string, signal?: AbortSignal): Promise<Response> {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': this.secret.key,
        'x-api-secret': this.secret.secret,
        Accept: 'application/json'
      },
      signal
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      let hint = '';
      if (resp.status === 401 || resp.status === 403) hint = ' — check API key/secret';
      else if (resp.status === 429) hint = ' — rate limited, wait & retry';
      throw new Error(`PAIC ${resp.status} ${resp.statusText}${hint}: ${body.slice(0, 300)}`);
    }
    return resp;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
