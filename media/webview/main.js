// Webview controller for the Ping AIC Logs panel.
// All I/O goes through vscode.postMessage(); host owns network and credentials.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const send = (msg) => vscode.postMessage(msg);

  // ── Element refs ─────────────────────────────────────────────────────────
  const envSel = $('env');
  const sourceToggle = $('source-toggle');
  const sourceMenu = $('source-menu');
  const logLevel = $('log-level');
  const queryInp = $('query');
  const recentVal = $('recent-val');
  const recentUnit = $('recent-unit');
  const rangeBegin = $('range-begin');
  const rangeEnd = $('range-end');
  const aroundCenter = $('around-center');
  const aroundDir = $('around-dir');
  const aroundWindow = $('around-window');
  const aroundUnit = $('around-unit');
  const searchBtn = $('searchBtn');
  const tailBtn = $('tailBtn');
  const cliBtn = $('copyCliBtn');
  const historyBtn = $('historyBtn');
  const helpBtn = $('helpBtn');
  const historyMenu = $('history-menu');
  const helpOverlay = $('help-overlay');
  const helpClose = $('help-close');
  const toolbar = $('toolbar');
  const statusText = $('status-text');
  const resultCount = $('result-count');
  const localFilter = $('local-filter');
  const excludeInput = $('exclude-input');
  const clearFilterBtn = $('clearFilterBtn');
  const pageSizeSel = $('page-size');
  const localTimeBtn = $('localTimeBtn');
  const rawJsonBtn = $('rawJsonBtn');
  const dedupBtn = $('dedupBtn');
  const saveBtn = $('saveBtn');
  const logTable = $('log-table');
  const pagination = $('pagination');
  const searchBackBtn = $('searchBackBtn');
  const searchFwdBtn = $('searchFwdBtn');
  const etaTooltip = $('eta-tooltip');
  const tagsRow = $('toolbar-tags-row');
  const filterTagsContainer = $('filter-tags');
  const excludeTagsContainer = $('exclude-tags');
  const activeFiltersContainer = $('active-filters');
  const modal = $('modal');
  const modalOverlay = $('modal-overlay');
  const modalContent = $('modal-content');
  const modalTitle = $('modal-title');
  const modalClose = $('modal-close');
  const modalPrev = $('modal-prev-btn');
  const modalNext = $('modal-next-btn');
  const modalCopy = $('modal-copy-btn');
  const modalWrap = $('modal-wrap-btn');
  const modalFormat = $('modal-format-btn');
  const modalRelated = $('modal-related-btn');
  const relatedMenu = $('related-menu');
  const confirmOverlay = $('confirm-overlay');
  const confirmMsg = $('confirm-msg');
  const confirmOk = $('confirm-ok');
  const confirmCancel = $('confirm-cancel');
  const helpBody = document.querySelector('.help-body');

  // ── State ────────────────────────────────────────────────────────────────
  const state = {
    sessionId: null,
    page: 0,
    pageSize: 100,
    pages: 1,
    totalCount: 0,
    truncated: false,
    allEntries: [],
    displayEntries: [],
    activeTail: null,
    timeMode: 'recent',
    useLocalTime: localStorage.getItem('paic_local_time') === 'true',
    modalWrap: localStorage.getItem('paic_modal_wrap') === 'true',
    modalFormat: localStorage.getItem('paic_modal_format') !== 'false', // default ON
    rawJsonMode: localStorage.getItem('paic_raw') === 'true',            // default OFF
    currentModalIdx: -1,
    dedupMode: localStorage.getItem('paic_dedup') === 'true',
    history: [],
    filterWords: [],
    excludeWords: [],
    fieldFilters: [],         // [{ field: 'eventName', value: 'AM-LOGIN' }]
    excludedDedupKeys: new Map(), // dedup key (JSON.stringify(payload)) → human label
    tailAutoScroll: true,
    searchStartedAt: 0,
    historyTab: 'searches',   // 'searches' | 'tails'
    tailFiles: [],            // TailFileMeta[]
    lastSearchRange: null,    // { begin, end } captured at sendSearch time
    lastSearchTime: null,     // { begin, end, elapsed, count, truncated } for status-bar redraw
    locateTimestamp: null,    // entry.timestamp of last-clicked row (for re-marking across renders)
    largeQueryThresholdMinutes: 30  // overridden by host `config` message; 0 disables the gate
  };

  // ── Helpers ──────────────────────────────────────────────────────────────
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function pad3(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; }
  function toLocalDT(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
         + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function toLocalDTms(d) {
    return toLocalDT(d) + '.' + pad3(d.getMilliseconds());
  }
  function localDTtoUTC(val) {
    if (!val) return '';
    return new Date(val).toISOString();
  }
  function setStatus(text) { statusText.textContent = text || ''; }
  function renderStatusBar() {
    if (!state.lastSearchTime) return;
    const { begin, end, elapsed, count, truncated } = state.lastSearchTime;
    const b = state.useLocalTime ? toLocalDT(new Date(begin)) : begin.replace('Z', '');
    const e2 = state.useLocalTime ? toLocalDT(new Date(end)) : end.replace('Z', '');
    let timeRange;
    if (b.substring(0, 10) === e2.substring(0, 10)) {
      timeRange = b.substring(5, 10) + ' ' + b.substring(11, 19) + '~' + e2.substring(11, 19);
    } else if (b.substring(0, 7) === e2.substring(0, 7)) {
      timeRange = b.substring(5, 16) + '~' + e2.substring(8, 16);
    } else {
      timeRange = b.substring(0, 16) + '~' + e2.substring(0, 16);
    }
    const durationSec = Math.round((new Date(end).getTime() - new Date(begin).getTime()) / 1000);
    const durParts = [];
    if (durationSec >= 3600) durParts.push(Math.floor(durationSec / 3600) + 'h');
    if (durationSec % 3600 >= 60) durParts.push(Math.floor((durationSec % 3600) / 60) + 'm');
    if (durationSec % 60 > 0 || durParts.length === 0) durParts.push((durationSec % 60) + 's');
    setStatus(count + ' entries (' + timeRange + ', ' + durParts.join('') + ') · ' + elapsed.toFixed(1) + 's' + (truncated ? ' (truncated)' : ''));
  }
  function showToolbar(show) { toolbar.classList.toggle('visible', show !== false); }
  function getValueAtPath(obj, path) {
    if (!obj || !path) return undefined;
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  // ── Time tabs ────────────────────────────────────────────────────────────
  $$('.time-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.time-tabs button').forEach((b) => b.classList.remove('active'));
      $$('.time-fields').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.getAttribute('data-mode');
      $('time-' + mode).classList.add('active');
      state.timeMode = mode;
    });
  });

  $$('.quick-times button').forEach((btn) => {
    btn.addEventListener('click', () => {
      recentVal.value = btn.getAttribute('data-val');
      recentUnit.value = btn.getAttribute('data-unit');
    });
  });

  // ── Datetime helpers: dblclick=Now, paste=auto-convert ───────────────────
  $$('input[type="datetime-local"]').forEach((input) => {
    input.addEventListener('dblclick', () => {
      input.value = toLocalDT(new Date());
      syncClearables();
    });
    input.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text').trim();
      let d = null;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text)) d = new Date(text);
      else if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(text)) d = new Date(text.replace(' ', 'T'));
      else if (/^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/.test(text)) d = new Date(text);
      else if (/^\d{13}$/.test(text)) d = new Date(parseInt(text, 10));
      else if (/^\d{10}$/.test(text)) d = new Date(parseInt(text, 10) * 1000);
      if (d && !isNaN(d.getTime())) {
        e.preventDefault();
        input.value = d.getMilliseconds() ? toLocalDTms(d) : toLocalDT(d);
      }
    });
  });

  // ── Source picker ────────────────────────────────────────────────────────
  sourceToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    sourceMenu.classList.toggle('open');
  });
  sourceMenu.addEventListener('click', (e) => e.stopPropagation());
  sourceMenu.addEventListener('change', (e) => {
    // Mutual exclusion: *-everything vs individuals in same group prefix.
    const target = e.target;
    if (target && target.type === 'checkbox' && target.checked) {
      const v = target.value;
      const prefix = v.split('-')[0];
      const isEverything = v === prefix + '-everything';
      $$('input[type="checkbox"]', sourceMenu).forEach((c) => {
        if (c === target) return;
        if (!c.value.startsWith(prefix + '-')) return;
        const cIsEverything = c.value === prefix + '-everything';
        if (isEverything && !cIsEverything) c.checked = false;       // unchecking individuals
        else if (!isEverything && cIsEverything) c.checked = false;  // unchecking *-everything
      });
    }
    updateSourceLabel();
  });
  function getSelectedSources() {
    return $$('input[type="checkbox"]', sourceMenu).filter((c) => c.checked).map((c) => c.value);
  }
  function setSelectedSources(list) {
    const wanted = (list || []).slice();
    $$('input[type="checkbox"]', sourceMenu).forEach((c) => { c.checked = wanted.includes(c.value); });
    updateSourceLabel();
  }
  function updateSourceLabel() {
    const sel = getSelectedSources();
    sourceToggle.textContent = sel.length === 1 ? sel[0]
                              : sel.length === 0 ? 'pick source…'
                              : sel.length + ' sources';
  }

  // ── Clearable inputs ─────────────────────────────────────────────────────
  function syncClearables() {
    $$('.clearable').forEach((wrap) => {
      const inp = wrap.querySelector('input');
      wrap.classList.toggle('has-value', !!(inp && inp.value));
    });
  }
  $$('.clearable').forEach((wrap) => {
    const inp = wrap.querySelector('input');
    const btn = wrap.querySelector('.clear-btn');
    if (!inp || !btn) return;
    inp.addEventListener('input', syncClearables);
    inp.addEventListener('change', syncClearables);
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.focus();
    });
  });
  syncClearables();

  // ── Time range ──────────────────────────────────────────────────────────
  function getTimeRange() {
    const now = new Date();
    if (state.timeMode === 'recent') {
      const v = parseInt(recentVal.value, 10) || 1;
      const unit = recentUnit.value;
      const ms = unit === 'h' ? v * 3600000 : unit === 'm' ? v * 60000 : v * 1000;
      return { begin: new Date(now.getTime() - ms).toISOString(), end: now.toISOString() };
    }
    if (state.timeMode === 'range') {
      if (!rangeBegin.value || !rangeEnd.value) return null;
      return { begin: localDTtoUTC(rangeBegin.value), end: localDTtoUTC(rangeEnd.value) };
    }
    if (state.timeMode === 'around') {
      if (!aroundCenter.value) return null;
      const center = new Date(aroundCenter.value).getTime();
      const w = parseInt(aroundWindow.value, 10) || 1;
      const ms = aroundUnit.value === 'm' ? w * 60000 : w * 1000;
      const dir = aroundDir.value;
      const begin = dir === 'after' ? center : center - ms;
      const end = dir === 'before' ? center : center + ms;
      return { begin: new Date(begin).toISOString(), end: new Date(end).toISOString() };
    }
    return null;
  }

  // ── Form state capture/restore ──────────────────────────────────────────
  function captureFormState() {
    return {
      env: envSel.value,
      sources: getSelectedSources(),
      query: queryInp.value,
      logLevel: logLevel ? logLevel.value : '',
      timeMode: state.timeMode,
      recentVal: recentVal.value,
      recentUnit: recentUnit.value,
      rangeBegin: rangeBegin.value,
      rangeEnd: rangeEnd.value,
      aroundCenter: aroundCenter.value,
      aroundDir: aroundDir.value,
      aroundWindow: aroundWindow.value,
      aroundUnit: aroundUnit.value,
      pageSize: state.pageSize,
      filterWords: state.filterWords.slice(),
      excludeWords: state.excludeWords.slice(),
      fieldFilters: state.fieldFilters.slice()
    };
  }
  function restoreFormState(s) {
    if (!s) return;
    if (s.env) envSel.value = s.env;
    setSelectedSources(s.sources || []);
    queryInp.value = s.query || '';
    if (logLevel && typeof s.logLevel === 'string') logLevel.value = s.logLevel;
    state.timeMode = s.timeMode || 'recent';
    $$('.time-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.timeMode));
    $$('.time-fields').forEach((f) => f.classList.toggle('active', f.id === 'time-' + state.timeMode));
    if (s.recentVal) recentVal.value = s.recentVal;
    if (s.recentUnit) recentUnit.value = s.recentUnit;
    if (s.rangeBegin) rangeBegin.value = s.rangeBegin;
    if (s.rangeEnd) rangeEnd.value = s.rangeEnd;
    if (s.aroundCenter) aroundCenter.value = s.aroundCenter;
    if (s.aroundDir) aroundDir.value = s.aroundDir;
    if (s.aroundWindow) aroundWindow.value = s.aroundWindow;
    if (s.aroundUnit) aroundUnit.value = s.aroundUnit;
    if (s.pageSize) { state.pageSize = s.pageSize; pageSizeSel.value = String(s.pageSize); }
    state.filterWords = (s.filterWords || []).slice();
    state.excludeWords = (s.excludeWords || []).slice();
    state.fieldFilters = (s.fieldFilters || []).slice();
    if (state.filterWords.length === 1) localFilter.value = state.filterWords[0];
    syncClearables();
    renderFilterChips();
  }

  // ── Search nav stack ────────────────────────────────────────────────────
  let searchStack = [];
  let searchStackIdx = -1;
  try {
    const raw = sessionStorage.getItem('paic_search_stack');
    if (raw) {
      const parsed = JSON.parse(raw);
      searchStack = parsed.stack || [];
      searchStackIdx = typeof parsed.idx === 'number' ? parsed.idx : searchStack.length - 1;
    }
  } catch (e) { /* ignore */ }

  function persistStack() {
    try { sessionStorage.setItem('paic_search_stack', JSON.stringify({ stack: searchStack, idx: searchStackIdx })); }
    catch (e) { /* ignore */ }
  }
  function pushSearchState() {
    const s = captureFormState();
    if (searchStackIdx < searchStack.length - 1) searchStack = searchStack.slice(0, searchStackIdx + 1);
    searchStack.push(s);
    if (searchStack.length > 50) searchStack.shift();
    searchStackIdx = searchStack.length - 1;
    persistStack();
    updateNavButtons();
  }
  function updateNavButtons() {
    searchBackBtn.disabled = searchStackIdx <= 0;
    searchFwdBtn.disabled = searchStackIdx >= searchStack.length - 1;
  }
  searchBackBtn.addEventListener('click', () => {
    if (searchStackIdx > 0) {
      searchStackIdx--;
      restoreFormState(searchStack[searchStackIdx]);
      persistStack();
      updateNavButtons();
      sendSearch();
    }
  });
  searchFwdBtn.addEventListener('click', () => {
    if (searchStackIdx < searchStack.length - 1) {
      searchStackIdx++;
      restoreFormState(searchStack[searchStackIdx]);
      persistStack();
      updateNavButtons();
      sendSearch();
    }
  });


  // ── Search ──────────────────────────────────────────────────────────────
  // ── Live elapsed counter while waiting for searchResult ──
  let searchTickTimer = null;
  function startSearchTick() {
    stopSearchTick();
    const key = predictionKey();
    const pred = key ? predict(key) : null;
    searchTickTimer = setInterval(() => {
      if (!state.searchStartedAt) { stopSearchTick(); return; }
      const elapsed = ((Date.now() - state.searchStartedAt) / 1000).toFixed(1);
      let txt = 'Searching… ' + elapsed + 's';
      if (pred) txt += ' (est ~' + pred.est + 's)';
      setStatus(txt);
    }, 100);
  }
  function stopSearchTick() {
    if (searchTickTimer) { clearInterval(searchTickTimer); searchTickTimer = null; }
  }

  function sendSearch() {
    setStatus('Searching…');
    showToolbar(true);
    state.allEntries = [];
    state.displayEntries = [];
    state.locateTimestamp = null;
    renderTable();
    state.searchStartedAt = Date.now();
    const range = getTimeRange();
    if (!range) { stopSearchTick(); return; }
    state.lastSearchRange = { begin: range.begin, end: range.end };
    startSearchTick();
    send({
      type: 'search',
      payload: {
        env: envSel.value,
        source: getSelectedSources().join(','),
        query: queryInp.value.trim(),
        begin: range.begin,
        end: range.end,
        limit: 50000
      }
    });
  }
  async function doSearch() {
    if (!envSel.value) { setStatus('Pick an environment in the sidebar first.'); return; }
    if (!getSelectedSources().length) { setStatus('Pick at least one source.'); return; }
    const range = getTimeRange();
    if (!range) { setStatus('Pick a valid time range.'); return; }

    // Large-query guard: no keyword + range > N minutes — confirm before firing.
    // N is `paicLogSearch.largeQueryThresholdMinutes` (default 30, 0 disables).
    const thresholdMin = (typeof state.largeQueryThresholdMinutes === 'number')
      ? state.largeQueryThresholdMinutes : 30;
    const rangeSec = (new Date(range.end).getTime() - new Date(range.begin).getTime()) / 1000;
    if (thresholdMin > 0 && !queryInp.value.trim() && rangeSec > thresholdMin * 60) {
      const minutes = Math.round(rangeSec / 60);
      const ok = await showConfirm(
        'Searching ' + minutes + ' minutes without a keyword can return many results and may take a while. Continue?'
      );
      if (!ok) { setStatus('Search cancelled.'); return; }
    }

    // Clear any per-dedup-key exclusions from previous searches too.
    if (state.excludedDedupKeys && state.excludedDedupKeys.size) {
      state.excludedDedupKeys.clear();
    }

    sendSearch();
    pushSearchState();
  }
  searchBtn.addEventListener('click', () => doSearch());
  queryInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // ── Tail ────────────────────────────────────────────────────────────────
  function setTailButtonState(active) {
    if (active) {
      tailBtn.textContent = '■ Stop';
      tailBtn.style.background = '#d9534f';
    } else {
      tailBtn.textContent = 'Tail';
      tailBtn.style.background = '#5cb85c';
    }
  }
  tailBtn.addEventListener('click', () => {
    if (state.activeTail) {
      send({ type: 'stopTail', payload: { streamId: state.activeTail } });
      return;
    }
    if (!envSel.value) { setStatus('Pick an environment first.'); return; }
    const sources = getSelectedSources();
    if (!sources.length) { setStatus('Pick at least one source.'); return; }
    state.filterWords = [];
    state.excludeWords = [];
    state.fieldFilters = [];
    if (state.excludedDedupKeys) state.excludedDedupKeys.clear();
    localFilter.value = '';
    excludeInput.value = '';
    state.dedupMode = false; localStorage.setItem('paic_dedup', 'false'); dedupBtn.classList.remove('active');
    state.rawJsonMode = false; localStorage.setItem('paic_raw', 'false'); rawJsonBtn.classList.remove('active');
    syncClearables();
    renderFilterChips();
    const sid = 'tail-' + Date.now();
    state.activeTail = sid;
    state.allEntries = [];
    state.displayEntries = [];
    state.tailAutoScroll = true;
    renderTable();
    showToolbar(true);
    setStatus('Tailing… (click again to stop)');
    setTailButtonState(true);
    send({
      type: 'startTail',
      payload: { env: envSel.value, source: sources.join(','), query: queryInp.value.trim(), streamId: sid }
    });
    sendTitle();
  });

  window.addEventListener('scroll', () => {
    if (!state.activeTail) return;
    const atBottom = (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 50);
    state.tailAutoScroll = atBottom;
  });

  // ── CLI button ──────────────────────────────────────────────────────────
  async function copyCliToClipboard() {
    const range = getTimeRange();
    const sources = getSelectedSources();
    if (!envSel.value || !sources.length || !range) { setStatus('Fill the search form first.'); return; }
    const parts = ['paic-logs', 'search',
      '--env=' + envSel.value, '--source=' + sources.join(','),
      '--begin=' + range.begin, '--end=' + range.end];
    const q = queryInp.value.trim();
    if (q) parts.push('--query=' + JSON.stringify(q));
    if (logLevel && logLevel.value) parts.push('--level=' + logLevel.value);
    const cli = parts.join(' ');
    try { await navigator.clipboard.writeText(cli); setStatus('CLI copied to clipboard.'); }
    catch (e) { setStatus('CLI: ' + cli); }
  }

  function tokenizeShell(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      let tok = '';
      while (i < s.length && !/\s/.test(s[i])) {
        const c = s[i];
        if (c === '"' || c === "'") {
          const q = c; i++;
          while (i < s.length && s[i] !== q) {
            if (s[i] === '\\' && i + 1 < s.length) { i++; tok += s[i++]; }
            else tok += s[i++];
          }
          if (s[i] === q) i++;
        } else {
          tok += s[i++];
        }
      }
      out.push(tok);
    }
    return out;
  }

  function parseCliArgs(text) {
    const tokens = tokenizeShell(text);
    while (tokens.length && !tokens[0].startsWith('--')) tokens.shift();
    const opts = {};
    for (const tok of tokens) {
      const m = tok.match(/^--([a-z][a-z0-9-]*)(?:=(.*))?$/i);
      if (m) opts[m[1]] = m[2] !== undefined ? m[2] : '';
    }
    return opts;
  }

  async function pasteCliFromClipboard() {
    let text = '';
    try { text = await navigator.clipboard.readText(); }
    catch (e) { setStatus('Clipboard read failed (browser permission?).'); return; }
    if (!text || !text.trim()) { setStatus('Clipboard is empty.'); return; }
    const opts = parseCliArgs(text);
    if (!Object.keys(opts).length) { setStatus('No recognizable --flags in clipboard.'); return; }
    const warns = [];
    if (opts.env) {
      const found = Array.from(envSel.options).some((o) => o.value === opts.env);
      if (found) envSel.value = opts.env;
      else warns.push(`env "${opts.env}" not in your environments`);
    }
    if (opts.source) setSelectedSources(opts.source.split(','));
    if (opts.query !== undefined) { queryInp.value = opts.query; syncClearables(); }
    if (opts.level && logLevel) logLevel.value = opts.level;
    if (opts.begin && opts.end) {
      state.timeMode = 'range';
      $$('.time-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'range'));
      $$('.time-fields').forEach((f) => f.classList.toggle('active', f.id === 'time-range'));
      try {
        rangeBegin.value = toLocalDT(new Date(opts.begin));
        rangeEnd.value = toLocalDT(new Date(opts.end));
      } catch (e) {
        warns.push('invalid begin/end timestamp');
      }
    }
    setStatus(warns.length ? `CLI applied (warning: ${warns.join('; ')})` : 'CLI applied — review and Search.');
  }

  cliBtn.addEventListener('click', () => { copyCliToClipboard(); });

  const cliMenuBtn = $('cliMenuBtn');
  const cliMenu = $('cli-menu');
  if (cliMenuBtn && cliMenu) {
    cliMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cliMenu.classList.toggle('open');
    });
    cliMenu.addEventListener('click', (e) => {
      const el = e.target.closest('.cli-mi');
      if (!el) return;
      cliMenu.classList.remove('open');
      const action = el.getAttribute('data-action');
      if (action === 'copy') copyCliToClipboard();
      else if (action === 'paste') pasteCliFromClipboard();
    });
    document.addEventListener('click', (e) => {
      if (!cliMenu.contains(e.target) && e.target !== cliMenuBtn) cliMenu.classList.remove('open');
    });
  }

  // ── Save button → ask host to write file ────────────────────────────────
  saveBtn.addEventListener('click', () => {
    const rows = state.allEntries;
    if (!rows.length) { setStatus('Nothing to save.'); return; }
    setStatus('Save dialog opening…');
    send({ type: 'saveResults', payload: { entries: rows, format: 'ndjson' } });
  });

  // ── Column-header click → filter popup ──────────────────────────────────
  let columnPopup = null;
  let columnPopupField = null;
  function closeColumnFilterPopup() {
    if (columnPopup) { columnPopup.remove(); columnPopup = null; columnPopupField = null; return true; }
    return false;
  }
  function showColumnFilterPopup(opts) {
    const { field, valueOf, anchor } = opts;
    // Toggle: same column clicked while popup is open → close.
    if (columnPopup && columnPopupField === field) { closeColumnFilterPopup(); return; }
    closeColumnFilterPopup();
    if (!state.allEntries.length) { setStatus('Run a search first.'); return; }
    const counts = new Map();
    state.allEntries.forEach((e) => {
      const v = valueOf(e);
      if (!v) return;
      counts.set(v, (counts.get(v) || 0) + 1);
    });
    if (!counts.size) { setStatus(`No ${field} values in current results.`); return; }
    const items = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const active = new Set(state.fieldFilters.filter((f) => f.field === field).map((f) => f.value));

    const popup = document.createElement('div');
    popup.style.cssText = 'position:absolute; background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius); box-shadow:0 8px 24px rgba(0,0,0,0.18); padding:6px 0; z-index:50; font-size:11px; min-width:240px; max-height:360px; overflow-y:auto;';
    popup.addEventListener('click', (ev) => ev.stopPropagation());

    const header = document.createElement('div');
    header.textContent = `Filter by ${field}`;
    header.style.cssText = 'font-weight:600; color:var(--text); padding:4px 12px 6px; font-family:var(--sans); border-bottom:1px solid var(--border); margin-bottom:4px;';
    popup.appendChild(header);

    items.forEach(([val, n]) => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:5px 12px; cursor:pointer; display:flex; justify-content:space-between; gap:12px; color:var(--text);';
      const checked = active.has(val);
      const label = document.createElement('span');
      label.textContent = (checked ? '✓ ' : '  ') + val;
      const count = document.createElement('span');
      count.textContent = n;
      count.style.cssText = 'color:var(--text-tertiary); font-variant-numeric:tabular-nums;';
      row.append(label, count);
      row.addEventListener('mouseover', () => row.style.background = 'var(--vscode-list-hoverBackground)');
      row.addEventListener('mouseout', () => row.style.background = '');
      row.addEventListener('click', () => {
        state.fieldFilters = state.fieldFilters.filter((f) => f.field !== field);
        if (!checked) state.fieldFilters.push({ field, value: val });
        applyLocalFilters();
        closeColumnFilterPopup();
      });
      popup.appendChild(row);
    });

    if (active.size > 0) {
      const clearRow = document.createElement('div');
      clearRow.textContent = `× Clear ${field} filter`;
      clearRow.style.cssText = 'padding:5px 12px; cursor:pointer; color:var(--accent); border-top:1px solid var(--border); margin-top:4px;';
      clearRow.addEventListener('mouseover', () => clearRow.style.background = 'var(--vscode-list-hoverBackground)');
      clearRow.addEventListener('mouseout', () => clearRow.style.background = '');
      clearRow.addEventListener('click', () => {
        state.fieldFilters = state.fieldFilters.filter((f) => f.field !== field);
        applyLocalFilters();
        closeColumnFilterPopup();
      });
      popup.appendChild(clearRow);
    }

    document.body.appendChild(popup);
    const r = anchor.getBoundingClientRect();
    popup.style.left = Math.min(window.innerWidth - 260, r.left) + 'px';
    popup.style.top = (r.bottom + window.scrollY + 4) + 'px';
    columnPopup = popup;
    columnPopupField = field;
  }
  document.addEventListener('click', () => closeColumnFilterPopup());

  const thSource = $('th-source');
  if (thSource) thSource.addEventListener('click', (e) => {
    e.stopPropagation();
    showColumnFilterPopup({ field: 'source', valueOf: (en) => en.source || '', anchor: thSource });
  });

  const thLevel = $('th-level');
  if (thLevel) thLevel.addEventListener('click', (e) => {
    e.stopPropagation();
    showColumnFilterPopup({ field: 'level', valueOf: levelOf, anchor: thLevel });
  });

  // ── Dedup mode ──────────────────────────────────────────────────────────
  // Dedup key = what the user actually SEES in the row (summary text with
  // whitespace collapsed to match CSS `white-space: nowrap` rendering).
  // Additional normalizations are applied so events that are logically the
  // SAME but happen for different entities still merge:
  //   - `Nms` — elapsed-time variance (50ms vs 69ms is "same task, two runs")
  //   - `UUID` — RFC-format UUIDs (different user/transaction IDs of the
  //     same operation: `Read alpha_user id=<uuid>` x N → 1 row)
  //   - `HEX` — 16+ char hex sequences (W3C TransactionIds, padded quartz
  //     timestamps, span IDs). Excludes the inner segments of a UUID since
  //     UUIDs are normalized first; only standalone long hex runs match.
  // Skipped on purpose: bare digit normalization (would collapse status
  // codes 404 vs 500, retry counts, etc., breaking real distinctions).
  // Stable across raw/non-raw mode toggles so excluded-keys survive.
  function dedupKeyFor(entry) {
    return summarize(entry)
      .replace(/\s+/g, ' ')
      .replace(/\b\d+ms\b/g, 'Nms')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
      .replace(/\b[0-9a-f]{16,}\b/gi, 'HEX')
      .trim();
  }
  function applyDedup(entries) {
    if (!state.dedupMode) return entries.map((e) => ({ entry: e, count: 1, key: dedupKeyFor(e) }));
    const map = new Map();
    const order = [];
    entries.forEach((e) => {
      const key = dedupKeyFor(e);
      if (map.has(key)) { map.get(key).count += 1; }
      else { const wrapper = { entry: e, count: 1, key }; map.set(key, wrapper); order.push(wrapper); }
    });
    return order;
  }
  dedupBtn.addEventListener('click', () => {
    state.dedupMode = !state.dedupMode;
    localStorage.setItem('paic_dedup', String(state.dedupMode));
    dedupBtn.classList.toggle('active', state.dedupMode);
    renderTable();
  });
  dedupBtn.classList.toggle('active', state.dedupMode);

  // ── Local filter / Exclude ──────────────────────────────────────────────
  // local-filter behaves like a chip producer: typing live-filters (>=3 chars),
  // pressing Enter promotes the term to a permanent chip and clears the input.
  localFilter.addEventListener('input', applyLocalFilters);
  localFilter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && localFilter.value.trim()) {
      const term = localFilter.value.trim().toLowerCase();
      if (!state.filterWords.includes(term)) state.filterWords.push(term);
      localFilter.value = '';
      syncClearables();
      applyLocalFilters();
    }
  });
  excludeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && excludeInput.value.trim()) {
      state.excludeWords.push(excludeInput.value.trim().toLowerCase());
      excludeInput.value = '';
      syncClearables();
      applyLocalFilters();
    }
  });
  clearFilterBtn.addEventListener('click', () => {
    state.filterWords = [];
    state.excludeWords = [];
    state.fieldFilters = [];
    if (state.excludedDedupKeys) state.excludedDedupKeys.clear();
    localFilter.value = '';
    excludeInput.value = '';
    syncClearables();
    applyLocalFilters();
  });
  function applyLocalFilters() {
    // Live term from the input (≥3 chars) is AND-ed with chip terms.
    const inc = state.filterWords.slice();
    const live = localFilter.value.trim().toLowerCase();
    if (live.length >= 3 && !inc.includes(live)) inc.push(live);

    const exc = state.excludeWords;
    const ff = state.fieldFilters;
    const exDedup = state.excludedDedupKeys;
    const hasFilter = inc.length || exc.length || ff.length || (exDedup && exDedup.size);

    if (!hasFilter) {
      state.displayEntries = [];
    } else {
      state.displayEntries = state.allEntries.filter((entry) => {
        const blob = JSON.stringify(entry).toLowerCase();
        if (inc.length && !inc.every((w) => blob.includes(w))) return false;
        if (exc.length && exc.some((w) => blob.includes(w))) return false;
        if (ff.length) {
          for (const f of ff) {
            const v = f.field === 'source' ? entry.source
                    : f.field === 'level' ? levelOf(entry)
                    : getValueAtPath(entry.payload, f.field);
            const got = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
            if (got !== f.value) return false;
          }
        }
        if (exDedup && exDedup.size) {
          if (exDedup.has(dedupKeyFor(entry))) return false;
        }
        return true;
      });
    }
    renderFilterChips();
    renderTable();
  }

  // ── Filter chip rendering ───────────────────────────────────────────────
  function renderFilterChips() {
    if (!tagsRow) return;
    const dedupCount = state.excludedDedupKeys ? state.excludedDedupKeys.size : 0;
    const has = state.filterWords.length || state.excludeWords.length || state.fieldFilters.length || dedupCount;
    filterTagsContainer.replaceChildren();
    excludeTagsContainer.replaceChildren();
    activeFiltersContainer.replaceChildren();
    const excludedKeysContainer = $('excluded-keys-tags');
    if (excludedKeysContainer) excludedKeysContainer.replaceChildren();

    state.filterWords.forEach((w) => filterTagsContainer.appendChild(makeChip('filter', w, () => {
      state.filterWords = state.filterWords.filter((x) => x !== w);
      applyLocalFilters();
    })));
    state.excludeWords.forEach((w) => excludeTagsContainer.appendChild(makeChip('exclude', w, () => {
      state.excludeWords = state.excludeWords.filter((x) => x !== w);
      applyLocalFilters();
    })));
    state.fieldFilters.forEach((f, i) => activeFiltersContainer.appendChild(makeChip('field', f.field + ' = ' + f.value, () => {
      state.fieldFilters.splice(i, 1);
      applyLocalFilters();
    })));
    if (excludedKeysContainer && state.excludedDedupKeys) {
      state.excludedDedupKeys.forEach((label, key) => {
        excludedKeysContainer.appendChild(makeChip('exclude', '×N: ' + label, () => {
          state.excludedDedupKeys.delete(key);
          applyLocalFilters();
        }));
      });
    }
    tagsRow.style.display = has ? 'flex' : 'none';
    tagsRow.classList.toggle('has-tags', !!has);
    activeFiltersContainer.classList.toggle('has-tags', state.fieldFilters.length > 0);
  }
  function makeChip(kind, label, onRemove) {
    const span = document.createElement('span');
    span.className = 'filter-tag' + (kind === 'exclude' ? ' exclude' : '');
    span.appendChild(document.createTextNode(label));
    const x = document.createElement('span');
    x.className = 'tag-del';
    x.textContent = '×';
    x.addEventListener('click', onRemove);
    span.appendChild(x);
    return span;
  }

  // ── UTC ↔ Local toggle ──────────────────────────────────────────────────
  function syncLocalTimeBtn() {
    localTimeBtn.textContent = state.useLocalTime ? 'Local' : 'UTC';
    localTimeBtn.classList.toggle('active', state.useLocalTime);
    const th = $('th-time');
    if (th && th.firstChild) th.firstChild.textContent = state.useLocalTime ? 'Time (Local) ' : 'Time (UTC) ';
  }
  localTimeBtn.addEventListener('click', () => {
    state.useLocalTime = !state.useLocalTime;
    localStorage.setItem('paic_local_time', String(state.useLocalTime));
    syncLocalTimeBtn();
    renderTable();
    if (state.lastSearchTime) renderStatusBar();
  });
  syncLocalTimeBtn();

  // ── Raw toggle (full JSON wrapped vs single-line truncated) ─────────────
  function applyRawClass() {
    const tbl = document.querySelector('.log-table');
    if (tbl) tbl.classList.toggle('raw', state.rawJsonMode);
    rawJsonBtn.classList.toggle('active', state.rawJsonMode);
  }
  rawJsonBtn.addEventListener('click', () => {
    state.rawJsonMode = !state.rawJsonMode;
    localStorage.setItem('paic_raw', String(state.rawJsonMode));
    applyRawClass();
    renderTable();
  });
  applyRawClass();


  // ── Time column sort ────────────────────────────────────────────────────
  let sortDir = 'asc';
  const thTime = $('th-time');
  const sortArrow = $('sort-arrow');
  function applyTimeSort() {
    const sign = sortDir === 'desc' ? -1 : 1;
    const sortFn = (a, b) => sign * String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
    state.allEntries.sort(sortFn);
    state.displayEntries.sort(sortFn);
  }
  if (thTime) {
    thTime.addEventListener('click', (e) => {
      if (e.target.classList.contains('col-resize')) return;
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      sortArrow.textContent = sortDir === 'desc' ? '▼' : '▲';
      applyTimeSort();
      renderTable();
    });
  }

  // ── Page size (client-side; no host round-trip) ─────────────────────────
  pageSizeSel.addEventListener('change', () => {
    state.pageSize = parseInt(pageSizeSel.value, 10);
    state.page = 0;
    renderTable();
  });

  // ── Pagination ──────────────────────────────────────────────────────────
  function renderPagination() {
    pagination.replaceChildren();
    if (state.pages <= 1) return;
    const atFirst = state.page === 0;
    const atLast = state.page + 1 >= state.pages;

    const first = document.createElement('button');
    first.textContent = '«';
    first.title = 'First page';
    first.disabled = atFirst;
    first.addEventListener('click', () => gotoPage(0));

    const prev = document.createElement('button');
    prev.textContent = '←';
    prev.title = 'Previous page';
    prev.disabled = atFirst;
    prev.addEventListener('click', () => gotoPage(state.page - 1));

    const wrap = document.createElement('span');
    wrap.style.padding = '0 8px';
    wrap.append(document.createTextNode('Page '));
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'page-jump';
    inp.value = String(state.page + 1);
    inp.title = 'Type a page number and press Enter';
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = parseInt(inp.value, 10);
        if (!isNaN(v)) gotoPage(v - 1);
        else inp.value = String(state.page + 1);
      }
    });
    inp.addEventListener('blur', () => { inp.value = String(state.page + 1); });
    wrap.append(inp, document.createTextNode(' / ' + state.pages));

    const next = document.createElement('button');
    next.textContent = '→';
    next.title = 'Next page';
    next.disabled = atLast;
    next.addEventListener('click', () => gotoPage(state.page + 1));

    const last = document.createElement('button');
    last.textContent = '»';
    last.title = 'Last page';
    last.disabled = atLast;
    last.addEventListener('click', () => gotoPage(state.pages - 1));

    pagination.append(first, prev, wrap, next, last);
  }
  function gotoPage(p) {
    p = Math.max(0, Math.min(state.pages - 1, p));
    if (p === state.page) return;
    state.page = p;
    renderTable();
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function timestampForCopy(ts) {
    if (!ts) return '';
    if (!state.useLocalTime) return ts;
    try {
      const d = new Date(ts);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' '
           + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
           + '.' + pad3(d.getMilliseconds());
    } catch (e) { return ts; }
  }
  function formatTime(ts) {
    if (!ts) return '';
    if (state.useLocalTime) {
      try {
        const d = new Date(ts);
        return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' '
             + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
             + '.' + pad3(d.getMilliseconds());
      } catch (e) { return ts; }
    }
    // UTC: drop year + drop trailing Z + replace T with space → "05-07 18:23:45.678"
    return ts.substring(5).replace('T', ' ').replace('Z', '').slice(0, 18);
  }
  function levelOf(entry) {
    const p = entry.payload;
    if (p && typeof p === 'object' && p.level) return String(p.level);
    if (typeof p === 'string') {
      const m = p.match(/^(SEVERE|ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FINE)/);
      if (m) return m[1];
    }
    return '';
  }
  // Per-source / per-eventName semantic single-line summary (~500-char cap).
  function summarize(entry) {
    let p = entry.payload;
    if (p == null) return JSON.stringify(entry);
    // PAIC string payloads are sometimes JSON-as-string. Try to upgrade to object so
    // the per-source templates can run instead of dumping escaped JSON text.
    if (typeof p === 'string') {
      const t = p.trim();
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { p = JSON.parse(t); } catch (e) { /* keep as string */ }
      }
    }
    if (typeof p === 'string') {
      const stripped = p
        .replace(/^(SEVERE|ERROR|WARN(?:ING)?|INFO|CONFIG|FINE|FINER|FINEST|DEBUG|TRACE):\s*/, '')
        .replace(/^\[\d+\]\s+\w+ \d+, \d{4} [\d:.]+ [AP]M\s+/, '');
      return stripped.length > 500 ? stripped.substring(0, 500) + '...' : stripped;
    }
    if (typeof p !== 'object') return String(p).slice(0, 500);

    const parts = [];
    const nodeInfo = p.entries && p.entries[0] && p.entries[0].info;

    if (p.eventName === 'AM-NODE-LOGIN-COMPLETED' && nodeInfo) {
      parts.push(nodeInfo.treeName || '');
      parts.push('> ' + (nodeInfo.displayName || '?'));
      parts.push('→ ' + (nodeInfo.nodeOutcome || '?'));
      if (nodeInfo.nodeType && nodeInfo.nodeType !== 'ScriptedDecisionNode') parts.push('(' + nodeInfo.nodeType.replace('product-', '') + ')');
      if (p.principal && p.principal[0]) parts.push(p.principal[0]);
    } else if (p.eventName === 'AM-TREE-LOGIN-COMPLETED' && nodeInfo) {
      parts.push(nodeInfo.treeName || '');
      parts.push('→ ' + (p.result || '?'));
      if (p.principal && p.principal[0]) parts.push(p.principal[0]);
    } else if (p.eventName === 'AM-LOGIN-COMPLETED' || p.eventName === 'AM-LOGIN-MODULE-COMPLETED') {
      parts.push(p.eventName);
      parts.push('→ ' + (p.result || '?'));
      if (p.principal && p.principal[0]) parts.push(p.principal[0]);
    } else if (p.eventName === 'AM-LOGOUT') {
      parts.push('AM-LOGOUT');
      if (p.principal && p.principal[0]) parts.push(p.principal[0]);
      if (p.result) parts.push('→ ' + p.result);
    } else if (p.eventName && p.eventName.indexOf('AM-SESSION') === 0) {
      parts.push(p.eventName);
      if (p.userId) parts.push(String(p.userId).replace(/id=([^,]+).*/, '$1'));
      if (p.principal && p.principal[0]) parts.push(p.principal[0]);
    } else if (p.eventName === 'AM-IDENTITY-CHANGE') {
      parts.push('AM-IDENTITY-CHANGE');
      if (p.operation) parts.push(p.operation);
      if (p.component) parts.push(p.component);
      if (p.objectId) parts.push(String(p.objectId).replace(/.*uuid=([^,]+).*/, '$1'));
    } else if (p.eventName === 'AM-ACCESS-ATTEMPT' || p.eventName === 'AM-ACCESS-OUTCOME') {
      parts.push(p.eventName);
      const http = p.http && p.http.request;
      if (http) {
        if (http.method) parts.push(http.method);
        if (http.path) parts.push(String(http.path).replace(/.*\/am\//, 'am/'));
      }
      const resp = p.response;
      if (resp) {
        parts.push('→ ' + (resp.status || resp.statusCode || ''));
        if (resp.elapsedTime) parts.push(resp.elapsedTime + 'ms');
      }
      if (p.component) parts.push(p.component);
    } else if (entry.source === 'idm-access') {
      const req = p.request || {};
      const reqDetail = req.detail || {};
      if (reqDetail.taskName) {
        parts.push('ScheduledTask');
        parts.push(reqDetail.taskName);
      } else {
        parts.push(req.operation || p.eventName || 'access');
        if (req.protocol) parts.push(req.protocol);
      }
      const resp3 = p.response || {};
      if (resp3.status) parts.push('→ ' + resp3.status);
      if (resp3.elapsedTime) parts.push(resp3.elapsedTime + 'ms');
      if (p.userId && p.userId !== 'system') parts.push('by:' + p.userId);
    } else if (entry.source === 'idm-activity') {
      parts.push(p.operation || p.eventName || 'activity');
      if (p.objectId) parts.push(String(p.objectId).replace('managed/alpha_', ''));
      if (p.status) parts.push('→ ' + p.status);
      if (Array.isArray(p.changedFields) && p.changedFields.length) parts.push('[' + p.changedFields.slice(0, 3).join(',') + ']');
      if (p.message) parts.push(String(p.message).substring(0, 80));
      if (p.runAs) parts.push('by:' + p.runAs);
    } else if (entry.source === 'idm-sync') {
      parts.push(p.eventName || 'sync');
      if (p.mapping) parts.push(p.mapping);
      if (p.situation) parts.push(p.situation);
      if (p.action) parts.push('→ ' + p.action);
      if (p.status) parts.push(p.status);
    } else if (entry.source === 'am-core' && p.logger) {
      parts.push(String(p.logger)
        .replace(/^scripts\.AUTHENTICATION_TREE_DECISION_NODE\.[^.]+\./, '')
        .replace(/^scripts\.SAML2_IDP_ATTRIBUTE_MAPPER\.[^.]+\./, 'SAML:')
        .replace(/^scripts\./, '')
        .replace(/^com\.sun\.identity\./, ''));
      if (p.message) parts.push(String(p.message).substring(0, 200));
    } else {
      if (p.eventName) parts.push(p.eventName);
      if (p.component) parts.push(p.component);
      if (p.logger) parts.push(String(p.logger).split('.').pop());
      if (p.message) parts.push(String(p.message).substring(0, 200));
      const http2 = p.http && p.http.request;
      if (http2) {
        if (http2.method) parts.push(http2.method);
        if (http2.path) parts.push(String(http2.path).replace(/.*\/openidm\//, '').replace(/.*\/am\//, 'am/'));
      }
      const resp2 = p.response;
      if (resp2) {
        parts.push('→ ' + (resp2.statusCode || resp2.status || ''));
        if (resp2.elapsedTime) parts.push(resp2.elapsedTime + 'ms');
      }
    }
    let out = parts.filter(Boolean).join(' ');
    if (!out) out = JSON.stringify(p);
    return out.length > 500 ? out.substring(0, 500) + '...' : out;
  }

  // Raw mode: the full entry JSON exactly as the API returned it — all fields,
  // 2-space indent, no unescape (escape sequences kept verbatim).
  function summarizeRaw(entry) {
    return JSON.stringify(entry, null, 2);
  }

  // ── Log keyword highlight rules (apply to row payload + modal) ──────────
  // `let` so applyConfig() can replace from `paicLogSearch.highlightRules`.
  let LOG_HL_RULES = [
    { re: /\b(SUCCESSFUL|SUCCESS|PASSED)\b/g, cls: 'log-hl-good' },
    { re: /\b(FAILED|FAILURE|ERROR|SEVERE)\b/g, cls: 'log-hl-bad' },
    { re: /\b(\w*Exception)\b/g, cls: 'log-hl-bad' },
    { re: /\b(WARNING|WARN)\b/g, cls: 'log-hl-warn' },
    { re: /\b(CREATE|UPDATE|DELETE|PATCH|ACTION)\b/g, cls: 'log-hl-action' },
    { re: /\b([45]\d{2})\b/g, cls: 'log-hl-bad' },
    { re: /\b(true)\b/g, cls: 'log-hl-good' },
    { re: /\b(false|null)\b/g, cls: 'log-hl-bad' }
  ];
  function applyLogHighlight(container) {
    LOG_HL_RULES.forEach((rule) => {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach((node) => {
        const parent = node.parentNode;
        if (!parent) return;
        if (/log-hl-|hl-search-kw|hl-filter|modal-json-block/.test(parent.className || '')) return;
        const text = node.nodeValue;
        // Protected regions: [LEVEL] tags should not get their inner keyword
        // re-highlighted (e.g. avoid coloring "ERROR" inside "[ERROR]" twice).
        const protectedRegions = Array.from(text.matchAll(/\[[A-Z]+\]/g))
          .map((m) => ({ start: m.index, end: m.index + m[0].length }));
        const inProtected = (idx) => {
          for (const r of protectedRegions) {
            if (idx >= r.start && idx < r.end) return true;
          }
          return false;
        };
        const matches = Array.from(text.matchAll(rule.re)).filter((m) => !inProtected(m.index));
        if (!matches.length) return;
        const frag = document.createDocumentFragment();
        let last = 0;
        matches.forEach((match) => {
          if (match.index > last) frag.appendChild(document.createTextNode(text.substring(last, match.index)));
          const span = document.createElement('span');
          if (rule.cls) span.className = rule.cls;
          if (rule.color) span.style.color = rule.color;
          if (rule.fontWeight !== undefined && rule.fontWeight !== null && rule.fontWeight !== '') {
            span.style.fontWeight = String(rule.fontWeight);
          }
          span.textContent = match[0];
          frag.appendChild(span);
          last = match.index + match[0].length;
        });
        if (last < text.length) frag.appendChild(document.createTextNode(text.substring(last)));
        parent.replaceChild(frag, node);
      });
    });
  }
  function effectiveRows() {
    // Live filter input (≥3 chars in the toolbar Filter box) is also a filter
    // even though it's not yet promoted to a chip. Without this check the
    // user types "err" and sees zero visual change.
    const hasLiveFilter = localFilter.value.trim().length >= 3;
    const hasDedupExcludes = state.excludedDedupKeys && state.excludedDedupKeys.size > 0;
    const filterActive = state.filterWords.length || state.excludeWords.length
      || state.fieldFilters.length || hasLiveFilter || hasDedupExcludes;
    let rows = filterActive ? state.displayEntries : state.allEntries;
    return rows;
  }
  function renderTable() {
    logTable.replaceChildren();
    const rows = effectiveRows();
    const grouped = applyDedup(rows);
    state.pages = Math.max(1, Math.ceil(grouped.length / state.pageSize));
    if (state.page >= state.pages) state.page = Math.max(0, state.pages - 1);
    if (state.page < 0) state.page = 0;
    const start = state.page * state.pageSize;
    const end = Math.min(start + state.pageSize, grouped.length);
    for (let li = start; li < end; li++) {
      const g = grouped[li];
      const entry = g.entry;
      const globalIdx = li;
      const tr = document.createElement('tr');
      tr.className = 'copy-row';
      const c0 = document.createElement('td'); c0.className = 'col-idx'; c0.textContent = String(globalIdx + 1);
      const c1 = document.createElement('td'); c1.className = 'col-time'; c1.textContent = formatTime(entry.timestamp);
      c1.title = (entry.timestamp || '') + ' (click to copy)';
      c1.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!entry.timestamp) return;
        const origText = c1.textContent;
        copyToClipboard(timestampForCopy(entry.timestamp), c1);
        c1.textContent = 'Copied!';
        setTimeout(() => { c1.textContent = origText; }, 700);
      });
      const c2 = document.createElement('td'); c2.className = 'col-source'; c2.textContent = entry.source || '';
      const lvl = levelOf(entry);
      const c3 = document.createElement('td'); c3.className = 'col-level lvl-' + (lvl ? lvl.toLowerCase() : 'none'); c3.textContent = lvl;
      const c4 = document.createElement('td');
      c4.className = 'col-payload';
      if (g.count > 1) {
        const badge = document.createElement('span');
        badge.className = 'dedup-count';
        badge.textContent = '×' + g.count;
        badge.title = 'Click to exclude this group (' + g.count + ' identical entries)';
        const dedupKey = g.key;
        const labelEntry = entry;
        badge.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (!dedupKey) return;
          const label = summarize(labelEntry).slice(0, 60);
          state.excludedDedupKeys.set(dedupKey, label);
          applyLocalFilters();
        });
        c4.appendChild(badge);
      }
      const payloadSpan = document.createElement('span');
      payloadSpan.textContent = state.rawJsonMode ? summarizeRaw(entry) : summarize(entry);
      c4.appendChild(payloadSpan);
      applyLogHighlight(payloadSpan);
      applySearchAndFilterHighlight(payloadSpan);
      tr.append(c0, c1, c2, c3, c4);
      if (state.locateTimestamp && entry.timestamp === state.locateTimestamp) {
        tr.classList.add('locate-highlight');
      }
      tr.addEventListener('click', () => {
        if (window.getSelection().toString().length > 0) return;
        openModal(globalIdx);
      });
      tr.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        const text = typeof entry.payload === 'object' ? JSON.stringify(entry.payload, null, 2) : String(entry.payload);
        copyToClipboard(text, tr);
      });
      logTable.appendChild(tr);
    }
    resultCount.textContent = grouped.length + (grouped.length === state.totalCount ? '' : '/' + state.totalCount)
      + (state.truncated ? ' (truncated)' : '');
    renderPagination();
    restoreColumnWidths();
  }
  async function copyToClipboard(text, flashEl) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { /* blocked */ }
    if (flashEl) {
      const orig = flashEl.style.background;
      flashEl.style.background = 'var(--vscode-list-activeSelectionBackground, #2a4)';
      setTimeout(() => { flashEl.style.background = orig; }, 500);
    }
    if (!ok) setStatus('Copy failed (clipboard blocked).');
  }

  // ── Modal ───────────────────────────────────────────────────────────────
  function currentRows() {
    const rows = effectiveRows();
    const grouped = applyDedup(rows);
    return grouped.map((g) => g.entry);
  }
  function openModal(globalIdx, scrollBlock) {
    const rows = currentRows();
    const entry = rows[globalIdx];
    if (!entry) return;
    state.currentModalIdx = globalIdx;
    state.locateTimestamp = entry.timestamp || null;
    // Clear any prior mark; defer the new mark+scroll to the next frame so
    // that a just-completed renderTable() (cross-page nav) has settled
    // layout before scrollIntoView fires.
    $$('#log-table tr.locate-highlight').forEach((r) => r.classList.remove('locate-highlight'));
    const localIdx = globalIdx - (state.page * state.pageSize);
    const block = scrollBlock || 'nearest';
    requestAnimationFrame(() => {
      const allRows = $$('#log-table tr');
      if (allRows[localIdx]) {
        allRows[localIdx].classList.add('locate-highlight');
        allRows[localIdx].scrollIntoView({ block, behavior: 'auto' });
      }
    });
    renderModalTitle(entry, globalIdx, rows.length);
    renderModal(entry);
    modalPrev.disabled = globalIdx <= 0;
    modalNext.disabled = globalIdx >= rows.length - 1;
    modal.classList.add('open');
    modalOverlay.classList.add('open');
  }
  function renderModalTitle(entry, idx, total) {
    modalTitle.replaceChildren();
    modalTitle.appendChild(document.createTextNode('#' + (idx + 1) + '/' + total + '  '));
    if (entry.timestamp) {
      const ts = document.createElement('span');
      ts.textContent = timestampForCopy(entry.timestamp);
      ts.className = 'modal-ts';
      ts.title = 'Click to copy';
      ts.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(timestampForCopy(entry.timestamp)); } catch (e) { /* blocked */ }
        const orig = ts.textContent;
        ts.textContent = 'Copied!';
        ts.classList.add('copied');
        setTimeout(() => { ts.textContent = orig; ts.classList.remove('copied'); }, 1000);
      });
      modalTitle.appendChild(ts);
    }
    if (entry.source) {
      const src = document.createElement('span');
      src.className = 'modal-src';
      src.textContent = '  [' + entry.source + ']';
      modalTitle.appendChild(src);
    }
  }
  function closeModal() {
    modal.classList.remove('open');
    modalOverlay.classList.remove('open');
    state.currentModalIdx = -1;
    if (relatedMenu) relatedMenu.classList.remove('open');
  }
  function renderModal(entry) {
    modalContent.replaceChildren();

    if (!state.modalFormat) {
      // Format OFF: raw entry JSON, escapes intact, no expansion. Log keywords still highlighted.
      modalContent.appendChild(document.createTextNode(JSON.stringify(entry, null, 2)));
      modalContent.classList.toggle('wrap', state.modalWrap);
      applyLogHighlight(modalContent);
      return;
    }

    // Format ON: deep-clone, expand embedded JSON, unescape, highlight _json blocks.
    let clone;
    try { clone = JSON.parse(JSON.stringify(entry)); }
    catch (e) { clone = entry; }
    expandStrings(clone);
    let formatted = JSON.stringify(clone, null, 2);
    formatted = formatted.replace(/\\\\n/g, '\n').replace(/\\\\t/g, '\t');
    formatted = formatted.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

    const jsonMatches = Array.from(formatted.matchAll(/"_json":\s*/g));
    let lastIdx = 0;
    for (const m of jsonMatches) {
      if (m.index < lastIdx) continue;
      modalContent.appendChild(document.createTextNode(formatted.substring(lastIdx, m.index)));
      const start = m.index + m[0].length;
      let braces = 0, end = start;
      for (let ci = start; ci < formatted.length; ci++) {
        const ch = formatted[ci];
        if (ch === '{' || ch === '[') braces++;
        else if (ch === '}' || ch === ']') {
          braces--;
          if (braces === 0) { end = ci + 1; break; }
        }
      }
      const hl = document.createElement('span');
      hl.className = 'modal-json-block';
      hl.textContent = m[0] + formatted.substring(start, end);
      modalContent.appendChild(hl);
      lastIdx = end;
    }
    modalContent.appendChild(document.createTextNode(formatted.substring(lastIdx)));
    modalContent.classList.toggle('wrap', state.modalWrap);

    applyLogHighlight(modalContent);
    applySearchAndFilterHighlight(modalContent);
  }

  // Highlight current search keyword (yellow) + active filter terms (cyan).
  // Filter terms include both promoted chips AND the live input value
  // (≥3 chars) — same threshold as the row-filtering logic, so the user
  // sees what's matching in real time without pressing Enter.
  function applySearchAndFilterHighlight(container) {
    const kw = queryInp.value.trim();
    if (kw) highlightInPre(container, [kw], 'hl-search-kw');
    const filterTerms = state.filterWords.slice();
    const live = localFilter.value.trim();
    if (live.length >= 3 && !filterTerms.some((t) => t.toLowerCase() === live.toLowerCase())) {
      filterTerms.push(live);
    }
    if (filterTerms.length) highlightInPre(container, filterTerms, 'hl-filter');
  }

  // ── expand embedded JSON inside string fields (PAIC's nested payload) ──
  // Tries every `{`/`[` position as a candidate JSON start. Returns the first
  // candidate whose brace-balanced substring parses to a non-empty object or
  // array of objects — so e.g. `Attempting[0:5] trigger update: {…}` skips
  // the `[0:5]` (parses to `[0:5]` which is invalid JSON) and finds the
  // real `{…}` block.
  function findBalancedJson(s) {
    for (let i = 0; i < s.length; i++) {
      const openCh = s[i];
      if (openCh !== '{' && openCh !== '[') continue;
      const closeCh = openCh === '{' ? '}' : ']';
      let depth = 0, inStr = false, esc = false, endIdx = -1;
      for (let j = i; j < s.length; j++) {
        const c = s[j];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === openCh) depth++;
        else if (c === closeCh) { depth--; if (depth === 0) { endIdx = j + 1; break; } }
      }
      if (endIdx < 0) continue;
      try {
        const parsed = JSON.parse(s.substring(i, endIdx));
        let worthy;
        if (Array.isArray(parsed)) worthy = parsed.some((e) => e && typeof e === 'object');
        else if (parsed && typeof parsed === 'object') worthy = Object.keys(parsed).length > 0;
        else worthy = false;
        if (!worthy) continue;
        return { prefix: s.substring(0, i), json: parsed, suffix: s.substring(endIdx) };
      } catch (e) { /* try next candidate */ }
    }
    return null;
  }

  function expandStrings(obj) {
    if (!obj || typeof obj !== 'object') return;
    const keys = Object.keys(obj);
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string') {
        let s = v;
        // 1. Direct JSON parse
        if (s[0] === '{' || s[0] === '[') {
          try {
            const parsed = JSON.parse(s);
            expandStrings(parsed);
            obj[k] = parsed;
            continue;
          } catch (e) { /* fall through */ }
        }
        // 2. Brace-counter extraction (JSON embedded in middle of string)
        const fb = findBalancedJson(s);
        if (fb) {
          const pre = fb.prefix.replace(/[\s:=\->]+$/, '');
          const suf = fb.suffix.trim();
          const r = { _prefix: pre, _json: fb.json };
          if (suf) r._suffix = suf;
          expandStrings(r._json);
          obj[k] = r;
          continue;
        }
        // 3. Iterative unescape for double-escaped JSON
        if (s.indexOf('\\"') !== -1) {
          let unesc = s;
          for (let attempt = 0; attempt < 3 && unesc.indexOf('\\"') !== -1; attempt++) {
            unesc = unesc.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          }
          if (unesc[0] === '{' || unesc[0] === '[') {
            try {
              const parsed = JSON.parse(unesc);
              expandStrings(parsed);
              obj[k] = parsed;
              continue;
            } catch (e) { /* fall through */ }
          }
          const fb2 = findBalancedJson(unesc);
          if (fb2) {
            const r = { _prefix: fb2.prefix, _json: fb2.json };
            if (fb2.suffix.trim()) r._suffix = fb2.suffix;
            expandStrings(r._json);
            obj[k] = r;
            continue;
          }
        }
        // 4. Stack trace formatting: \n\tat -> real newlines
        if (s.indexOf('\\n\\tat ') !== -1 || s.indexOf('\\n\tat ') !== -1 || s.indexOf('\n\tat ') !== -1) {
          obj[k] = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        }
      } else if (v && typeof v === 'object') {
        expandStrings(v);
      }
    }
  }

  function highlightInPre(container, terms, className) {
    const escaped = terms
      .filter((t) => t && t.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!escaped.length) return;
    const re = new RegExp('(' + escaped.join('|') + ')', 'gi');
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => {
      const text = node.nodeValue;
      const matches = Array.from(text.matchAll(re));
      if (!matches.length) return;
      const frag = document.createDocumentFragment();
      let last = 0;
      matches.forEach((match) => {
        if (match.index > last) frag.appendChild(document.createTextNode(text.substring(last, match.index)));
        const mark = document.createElement('mark');
        mark.className = className;
        mark.textContent = match[0];
        frag.appendChild(mark);
        last = match.index + match[0].length;
      });
      if (last < text.length) frag.appendChild(document.createTextNode(text.substring(last)));
      node.parentNode.replaceChild(frag, node);
    });
  }
  function modalNav(dir) {
    const rows = currentRows();
    const ni = state.currentModalIdx + dir;
    if (ni < 0 || ni >= rows.length) return;
    // If new entry is on a different page, switch the table to that page first
    // so the row marking + scrollIntoView in openModal lands correctly.
    const targetPage = Math.floor(ni / state.pageSize);
    const crossedPage = targetPage !== state.page;
    if (crossedPage) {
      state.page = targetPage;
      renderTable();
    }
    // Cross-page navs use `center` so the new row is unmistakably positioned
    // (post-renderTable scroll position can be anywhere). Same-page navs use
    // `nearest` so we don't disrupt the user's existing scroll position when
    // the row is already visible.
    openModal(ni, crossedPage ? 'center' : 'nearest');
  }
  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', closeModal);
  modalPrev.addEventListener('click', () => modalNav(-1));
  modalNext.addEventListener('click', () => modalNav(1));
  modalCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(modalContent.textContent); } catch (e) { /* blocked */ }
    const orig = modalCopy.textContent;
    modalCopy.textContent = 'Copied!';
    modalCopy.classList.add('copied');
    setTimeout(() => { modalCopy.textContent = orig; modalCopy.classList.remove('copied'); }, 1000);
  });
  modalWrap.addEventListener('click', () => {
    state.modalWrap = !state.modalWrap;
    localStorage.setItem('paic_modal_wrap', String(state.modalWrap));
    modalWrap.classList.toggle('active', state.modalWrap);
    modalContent.classList.toggle('wrap', state.modalWrap);
  });
  modalWrap.classList.toggle('active', state.modalWrap);
  modalFormat.addEventListener('click', () => {
    state.modalFormat = !state.modalFormat;
    localStorage.setItem('paic_modal_format', String(state.modalFormat));
    modalFormat.classList.toggle('active', state.modalFormat);
    if (state.currentModalIdx >= 0) {
      const rows = currentRows();
      renderModal(rows[state.currentModalIdx]);
    }
  });
  modalFormat.classList.toggle('active', state.modalFormat);

  // ── Related searches dropdown ───────────────────────────────────────────
  if (modalRelated) modalRelated.addEventListener('click', (e) => {
    e.stopPropagation();
    const rows = currentRows();
    const entry = rows[state.currentModalIdx];
    if (!entry) return;
    showRelatedMenu(entry);
  });
  if (relatedMenu) relatedMenu.addEventListener('click', (e) => e.stopPropagation());

  // Per-related-type default windows in seconds.
  const RELATED_WINDOW_DEFAULTS = {
    transactionId: 60, trackingId: 120,
    userActivity: 300, userLogs: 300, userById: 300, principal: 300,
    sameSource: 5, allSources: 5,
    errors: 60, eventType: 300, logger: 60, failedErrors: 60,
    treeNodes: 120, treeFailed: 300, objectChanges: 300, syncMapping: 300
  };
  const relatedWindows = Object.assign({}, RELATED_WINDOW_DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem('paic_related_windows'));
    if (saved && typeof saved === 'object') Object.assign(relatedWindows, saved);
  } catch (e) { /* ignore */ }
  function saveRelatedWindows() {
    try { localStorage.setItem('paic_related_windows', JSON.stringify(relatedWindows)); }
    catch (e) { /* ignore */ }
  }
  const fmtWindow = (sec) => '±' + sec + 's';

  function buildRelatedSearches(entry) {
    if (!entry) return [];
    const p = entry.payload || {};
    const ts = entry.timestamp || '';
    const src = entry.source || '';
    const items = [];
    const w = relatedWindows;

    // ── Trace ──
    const txId = p.transactionId;
    if (txId) {
      const baseTxId = String(txId).split('/')[0];
      items.push({ key: 'transactionId', group: 'Trace', label: 'Same transactionId', value: baseTxId, query: baseTxId, sources: 'idm-everything,am-everything', window: w.transactionId });
    }
    const trackingIds = p.trackingIds;
    if (Array.isArray(trackingIds) && trackingIds.length) {
      trackingIds.forEach((tid, idx) => {
        const label = trackingIds.length === 1 ? 'trackingId' : 'trackingId[' + idx + ']';
        items.push({ key: 'trackingId', group: 'Trace', label, value: tid, query: tid, sources: 'idm-everything,am-everything', window: w.trackingId });
      });
    }

    // ── Auth Tree ──
    const nodeInfo = p.entries && p.entries[0] && p.entries[0].info;
    const treeName = nodeInfo && nodeInfo.treeName;
    if (treeName && Array.isArray(trackingIds) && trackingIds.length) {
      trackingIds.forEach((tid, idx) => {
        items.push({ key: 'treeNodes', group: 'Auth Tree', label: 'All nodes in "' + treeName + '" (trackingId[' + idx + '])', value: tid, query: tid, sources: 'am-authentication', window: w.treeNodes });
      });
      items.push({ key: 'treeFailed', group: 'Auth Tree', label: 'Failed nodes/trees', value: 'FAILED', query: 'FAILED', sources: 'am-authentication', window: w.treeFailed });
    }
    if (p.eventName === 'AM-TREE-LOGIN-COMPLETED' && Array.isArray(trackingIds) && trackingIds.length) {
      trackingIds.forEach((tid, idx) => {
        items.push({ key: 'treeNodes', group: 'Auth Tree', label: 'All nodes in this tree (trackingId[' + idx + '])', value: tid, query: tid, sources: 'am-authentication', window: w.treeNodes });
      });
    }
    if (p.result === 'FAILED' && txId) {
      const baseTx = String(txId).split('/')[0];
      items.push({ key: 'failedErrors', group: 'Auth Tree', label: 'Errors for this login', value: baseTx.substring(0, 24), query: baseTx, sources: 'am-core', window: w.failedErrors, level: 'ERROR' });
    }

    // ── User ──
    const userId = p.userId;
    if (userId) {
      const m = String(userId).match(/id=([^,]+)/);
      const uid = m ? m[1] : String(userId);
      items.push({ key: 'userActivity', group: 'User', label: 'User activity (idm-activity)', value: uid.substring(0, 20), query: uid, sources: 'idm-activity', window: w.userActivity });
      items.push({ key: 'userLogs', group: 'User', label: 'User logs', value: uid.substring(0, 20), query: uid, sources: 'idm-everything,am-everything', window: w.userLogs });
    }
    const principal = p.principal;
    if (Array.isArray(principal) && principal.length && String(principal[0]).indexOf('@') !== -1) {
      items.push({ key: 'principal', group: 'User', label: 'User auth events', value: principal[0], query: principal[0], sources: 'am-authentication', window: w.principal });
    }
    const payloadText = typeof p === 'string' ? p : (p.message || '');
    const userIdMatch = String(payloadText).match(/alpha_user\/([0-9a-f]{8}-[0-9a-f-]{27})/);
    if (userIdMatch && (!userId || String(userId).indexOf(userIdMatch[1]) === -1)) {
      items.push({ key: 'userById', group: 'User', label: 'User by ID', value: userIdMatch[1].substring(0, 20), query: userIdMatch[1], sources: 'idm-everything,am-everything', window: w.userById });
    }

    // ── Object ──
    const objectId = p.objectId;
    if (objectId) {
      const oid = String(objectId).split('/').pop();
      items.push({ key: 'objectChanges', group: 'Object', label: 'Object changes (idm-activity)', value: oid.substring(0, 20), query: oid, sources: 'idm-activity', window: w.objectChanges });
    }
    if (p.mapping) {
      items.push({ key: 'syncMapping', group: 'Object', label: 'Sync mapping', value: p.mapping, query: p.mapping, sources: 'idm-sync', window: w.syncMapping });
    }

    // ── Context ──
    if (ts) {
      items.push({ key: 'sameSource', group: 'Context', label: 'Same source', value: src, query: '', sources: src, window: w.sameSource });
      items.push({ key: 'allSources', group: 'Context', label: 'All sources', value: '', query: '', sources: 'idm-everything,am-everything', window: w.allSources });
    }

    // ── Diagnostics ──
    if (ts) {
      items.push({ key: 'errors', group: 'Diagnostics', label: 'Errors', value: 'Exception', query: 'Exception', sources: 'idm-everything,am-everything', window: w.errors, level: 'ERROR' });
    }
    if (p.eventName) {
      items.push({ key: 'eventType', group: 'Diagnostics', label: 'Same event type', value: p.eventName, query: p.eventName, sources: src, window: w.eventType });
    }
    if (p.logger) {
      const loggerMatch = String(p.logger).match(/\(([^)]+)\)/);
      const shortLogger = loggerMatch ? loggerMatch[1]
        : String(p.logger).replace(/^scripts\.AUTHENTICATION_TREE_DECISION_NODE\.[^.]+\./, '').replace(/^scripts\./, '');
      items.push({ key: 'logger', group: 'Diagnostics', label: 'Same logger', value: shortLogger, query: shortLogger, sources: src, window: w.logger });
    }

    return items;
  }

  function executeRelatedSearch(entry, item) {
    const ts = entry.timestamp;
    if (!ts) { setStatus('Entry has no timestamp.'); return; }
    const center = new Date(ts);
    if (isNaN(center.getTime())) { setStatus('Invalid timestamp on entry.'); return; }
    const begin = new Date(center.getTime() - item.window * 1000);
    const end = new Date(center.getTime() + item.window * 1000);

    if (item.query !== undefined) { queryInp.value = item.query; syncClearables(); }
    if (item.sources) setSelectedSources(item.sources.split(','));
    if (item.level && logLevel) logLevel.value = item.level;

    // Switch to Range mode + apply explicit begin/end (not "now ± N")
    state.timeMode = 'range';
    $$('.time-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'range'));
    $$('.time-fields').forEach((f) => f.classList.toggle('active', f.id === 'time-range'));
    rangeBegin.value = toLocalDT(begin);
    rangeEnd.value = toLocalDT(end);

    relatedMenu.classList.remove('open');
    closeModal();
    doSearch();
  }

  function showRelatedMenu(entry) {
    if (!relatedMenu) return;
    const items = buildRelatedSearches(entry);
    relatedMenu.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'rm-empty';
      empty.textContent = 'No related searches available';
      relatedMenu.appendChild(empty);
      relatedMenu.classList.add('open');
      return;
    }
    let lastGroup = '';
    items.forEach((item) => {
      if (item.group !== lastGroup) {
        const g = document.createElement('div');
        g.className = 'rm-group';
        g.textContent = item.group;
        relatedMenu.appendChild(g);
        lastGroup = item.group;
      }
      const row = document.createElement('div');
      row.className = 'rm-item';

      const winInput = document.createElement('input');
      winInput.type = 'number';
      winInput.value = item.window;
      winInput.min = '1';
      winInput.className = 'rm-win';
      winInput.title = 'Window in seconds (±N around entry timestamp)';
      winInput.addEventListener('click', (e) => { e.stopPropagation(); winInput.select(); });
      winInput.addEventListener('change', () => {
        let v = parseInt(winInput.value, 10) || item.window;
        if (v < 1) v = 1;
        winInput.value = v;
        relatedWindows[item.key] = v;
        item.window = v;
        saveRelatedWindows();
        winLabel.textContent = fmtWindow(v);
      });
      row.appendChild(winInput);

      const winLabel = document.createElement('span');
      winLabel.className = 'rm-wlabel';
      winLabel.textContent = fmtWindow(item.window);
      row.appendChild(winLabel);

      const lbl = document.createElement('span');
      lbl.className = 'rm-label';
      lbl.textContent = item.label;
      row.appendChild(lbl);

      if (item.value) {
        const val = document.createElement('span');
        val.className = 'rm-value';
        val.textContent = item.value;
        val.title = item.value;
        row.appendChild(val);
      }

      row.addEventListener('click', (e) => {
        if (e.target === winInput) return;
        executeRelatedSearch(entry, item);
      });
      relatedMenu.appendChild(row);
    });
    relatedMenu.classList.add('open');
  }

  // ── History menu (tabbed: Searches / Tail Files) ────────────────────────
  historyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = historyMenu.classList.toggle('open');
    if (open) {
      send({ type: 'getHistory' });
      send({ type: 'listTailFiles' });
    }
  });
  historyMenu.addEventListener('click', (e) => e.stopPropagation());

  function renderHistoryMenu() {
    historyMenu.replaceChildren();

    // Tabs header
    const tabs = document.createElement('div');
    tabs.className = 'history-tabs';
    tabs.style.cssText = 'display:flex; padding:6px 8px 0; gap:4px; border-bottom:1px solid var(--border);';
    const mkTab = (key, label, count) => {
      const b = document.createElement('button');
      b.textContent = label + (count != null ? ' (' + count + ')' : '');
      b.style.cssText = 'background:transparent; border:none; padding:4px 10px; cursor:pointer; font-size:11px; color:var(--text-secondary); border-bottom:2px solid transparent; font-family:inherit;';
      if (state.historyTab === key) {
        b.style.color = 'var(--text)';
        b.style.borderBottomColor = 'var(--accent)';
        b.style.fontWeight = '600';
      }
      b.addEventListener('click', () => { state.historyTab = key; renderHistoryMenu(); });
      return b;
    };
    tabs.appendChild(mkTab('searches', 'Searches', state.history.length));
    tabs.appendChild(mkTab('tails', 'Tail Files', state.tailFiles.length));

    // "Clear All" button on the right edge of the tab strip, contextual to active tab.
    const clearAll = document.createElement('button');
    clearAll.textContent = 'Clear All';
    clearAll.title = state.historyTab === 'searches'
      ? 'Clear all search history'
      : 'Clear all saved tail files';
    clearAll.style.cssText = 'margin-left:auto; background:transparent; border:1px solid var(--border); padding:2px 8px; cursor:pointer; font-size:10px; color:var(--text-secondary); border-radius:var(--radius-sm); font-family:inherit;';
    clearAll.disabled = state.historyTab === 'searches'
      ? state.history.length === 0
      : state.tailFiles.length === 0;
    if (clearAll.disabled) { clearAll.style.opacity = '0.4'; clearAll.style.cursor = 'not-allowed'; }
    clearAll.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (clearAll.disabled) return;
      const ok = await showConfirm(
        state.historyTab === 'searches'
          ? 'Clear all ' + state.history.length + ' search history entries?'
          : 'Delete all ' + state.tailFiles.length + ' saved tail files?'
      );
      if (!ok) return;
      if (state.historyTab === 'searches') {
        send({ type: 'clearHistory' });
      } else {
        // No bulk delete message; loop one-by-one. Host responds with tailFileDeleted each time.
        state.tailFiles.slice().forEach((m) => send({ type: 'deleteTailFile', payload: { name: m.name } }));
      }
    });
    tabs.appendChild(clearAll);
    historyMenu.appendChild(tabs);

    const body = document.createElement('div');
    historyMenu.appendChild(body);

    if (state.historyTab === 'searches') renderSearchHistoryInto(body);
    else renderTailFilesInto(body);
  }
  function renderSearchHistoryInto(container) {
    if (!state.history.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:8px 12px; color:var(--text-tertiary);';
      empty.textContent = '(no searches yet)';
      container.appendChild(empty);
      return;
    }
    state.history.forEach((entry, i) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const left = document.createElement('span');
      left.appendChild(document.createTextNode(
        entry.env + ' · ' + entry.source + ' · "' + (entry.query || '(empty)') + '"'
      ));
      // Show entry count if captured. Zero-count rows are kept (diagnostic
      // "no results" is itself a valid answer) but visually muted via .dim.
      if (typeof entry.totalCount === 'number') {
        const cnt = document.createElement('span');
        cnt.className = 'history-count' + (entry.totalCount === 0 ? ' dim' : '');
        cnt.textContent = ' — ' + entry.totalCount + ' entries';
        left.appendChild(cnt);
      }
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'Delete';
      del.addEventListener('click', (ev) => { ev.stopPropagation(); send({ type: 'deleteHistory', payload: { index: i } }); });
      item.append(left, del);
      item.addEventListener('click', () => {
        applyHistoryEntry(entry);
        historyMenu.classList.remove('open');
        doSearch();
      });
      container.appendChild(item);
    });
  }

  // Restore form state from a HistoryEntry. Used by the panel-internal
  // History menu click and by the host's `restoreSearch` message (sent
  // when a new tab is opened from the sidebar Recent Searches view).
  function applyHistoryEntry(entry) {
    if (!entry) return;
    if (entry.env) envSel.value = entry.env;
    setSelectedSources((entry.source || '').split(',').filter(Boolean));
    queryInp.value = entry.query || '';
    syncClearables();
    if (entry.begin && entry.end) {
      $$('.time-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'range'));
      $$('.time-fields').forEach((s) => s.classList.toggle('active', s.id === 'time-range'));
      state.timeMode = 'range';
      rangeBegin.value = toLocalDT(new Date(entry.begin));
      rangeEnd.value = toLocalDT(new Date(entry.end));
    }
  }
  function renderTailFilesInto(container) {
    if (!state.tailFiles.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:8px 12px; color:var(--text-tertiary);';
      empty.textContent = '(no saved tail sessions)';
      container.appendChild(empty);
      return;
    }
    state.tailFiles
      .slice()
      .sort((a, b) => b.startTime - a.startTime)
      .forEach((meta) => {
        const item = document.createElement('div');
        item.className = 'history-item';
        const dt = new Date(meta.startTime).toLocaleString();
        const dur = Math.round((meta.endTime - meta.startTime) / 1000);
        const left = document.createElement('span');
        left.textContent = meta.env + ' · ' + meta.source + ' · ' + meta.count + ' entries · ' + dt + ' (' + dur + 's)';
        const del = document.createElement('button');
        del.textContent = '×';
        del.title = 'Delete';
        del.addEventListener('click', (ev) => { ev.stopPropagation(); send({ type: 'deleteTailFile', payload: { name: meta.name } }); });
        item.append(left, del);
        item.addEventListener('click', () => {
          historyMenu.classList.remove('open');
          setStatus('Loading tail file…');
          send({ type: 'loadTailFile', payload: { name: meta.name } });
        });
        container.appendChild(item);
      });
  }

  // ── Help overlay + tabs + qs-link ───────────────────────────────────────
  let helpTabsInited = false;
  helpBtn.addEventListener('click', () => {
    helpOverlay.classList.add('open');
    if (!helpTabsInited) { initHelpTabs(); helpTabsInited = true; }
  });
  helpClose.addEventListener('click', () => helpOverlay.classList.remove('open'));
  helpOverlay.addEventListener('click', (e) => {
    const el = e.target.closest('.qs-link');
    if (!el) return;
    let cfg;
    try { cfg = JSON.parse(el.getAttribute('data-qs') || '{}'); } catch (err) { return; }
    if (cfg.source) setSelectedSources(String(cfg.source).split(','));
    if (typeof cfg.query === 'string') { queryInp.value = cfg.query; syncClearables(); }
    if (cfg.level && logLevel) logLevel.value = cfg.level;
    if (cfg.last) {
      const m = String(cfg.last).match(/^(\d+)([smh])$/);
      if (m) {
        recentVal.value = m[1];
        recentUnit.value = m[2];
        $$('.time-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'recent'));
        $$('.time-fields').forEach((f) => f.classList.toggle('active', f.id === 'time-recent'));
        state.timeMode = 'recent';
      }
    }
    if (typeof cfg.filter === 'string') {
      localFilter.value = cfg.filter;
      state.filterWords = [cfg.filter.toLowerCase()];
      syncClearables();
    }
    helpOverlay.classList.remove('open');
    doSearch();
  });
  function initHelpTabs() {
    if (!helpBody) return;
    const sections = [];
    let buf = null;
    Array.from(helpBody.children).forEach((child) => {
      if (child.tagName === 'H3') {
        if (buf) sections.push(buf);
        buf = { title: child.textContent, nodes: [child] };
      } else if (buf) {
        buf.nodes.push(child);
      }
    });
    if (buf) sections.push(buf);
    if (sections.length < 2) return;

    const tabBar = document.createElement('div');
    tabBar.className = 'help-tabs';
    tabBar.style.cssText = 'display:flex; gap:4px; padding:8px 0; border-bottom:1px solid var(--border); margin-bottom:12px; position:sticky; top:0; background:var(--bg-elevated); z-index:5;';
    const wrappers = sections.map((sec, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'help-section';
      wrap.style.display = i === 0 ? 'block' : 'none';
      sec.nodes.forEach((n) => wrap.appendChild(n));
      return wrap;
    });
    sections.forEach((sec, i) => {
      const btn = document.createElement('button');
      btn.textContent = sec.title;
      btn.style.cssText = 'background:transparent; border:none; padding:6px 12px; cursor:pointer; font-size:12px; color:var(--text-secondary); border-bottom:2px solid transparent; font-family:inherit;';
      if (i === 0) {
        btn.style.color = 'var(--text)';
        btn.style.borderBottomColor = 'var(--accent)';
        btn.style.fontWeight = '600';
      }
      btn.addEventListener('click', () => {
        Array.from(tabBar.children).forEach((b) => {
          b.style.color = 'var(--text-secondary)';
          b.style.borderBottomColor = 'transparent';
          b.style.fontWeight = '';
        });
        btn.style.color = 'var(--text)';
        btn.style.borderBottomColor = 'var(--accent)';
        btn.style.fontWeight = '600';
        wrappers.forEach((w, j) => { w.style.display = i === j ? 'block' : 'none'; });
        helpBody.scrollTop = 0;
      });
      tabBar.appendChild(btn);
    });
    helpBody.replaceChildren(tabBar, ...wrappers);
  }

  // ── Confirm overlay (exposed for future callers) ────────────────────────
  function showConfirm(message) {
    return new Promise((resolve) => {
      confirmMsg.textContent = message;
      confirmOverlay.classList.add('open');
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      function cleanup() {
        confirmOk.removeEventListener('click', onOk);
        confirmCancel.removeEventListener('click', onCancel);
        confirmOverlay.classList.remove('open');
      }
      confirmOk.addEventListener('click', onOk);
      confirmCancel.addEventListener('click', onCancel);
    });
  }
  window.__confirm = showConfirm;

  // ── Float-nav buttons ───────────────────────────────────────────────────
  $$('.float-nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dir = btn.getAttribute('data-scroll');
      window.scrollTo(0, dir === 'top' ? 0 : document.body.scrollHeight);
    });
  });

  // ── Outside-click closes menus ──────────────────────────────────────────
  document.addEventListener('click', () => {
    sourceMenu.classList.remove('open');
    historyMenu.classList.remove('open');
    if (relatedMenu) relatedMenu.classList.remove('open');
    closeFieldFilterPopup();
  });

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (modal.classList.contains('open')) { closeModal(); return; }
      if (helpOverlay.classList.contains('open')) { helpOverlay.classList.remove('open'); return; }
      if (confirmOverlay.classList.contains('open')) { confirmCancel.click(); return; }
      if (closeFieldFilterPopup()) return;
      if (localFilter.value) { localFilter.value = ''; clearFilterBtn.click(); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      queryInp.focus();
      queryInp.select();
    }
    if (modal.classList.contains('open')) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); modalNav(-1); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); modalNav(1); }
    }
  });

  // ── Column resize ───────────────────────────────────────────────────────
  (function () {
    let dragCol = null, startX = 0, startW = 0;
    $$('.col-resize').forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        dragCol = $(handle.getAttribute('data-col'));
        if (!dragCol) return;
        startX = e.clientX;
        startW = dragCol.offsetWidth;
        handle.classList.add('dragging');
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', onDragEnd);
      });
    });
    function onDrag(e) {
      if (!dragCol) return;
      const w = Math.max(40, startW + (e.clientX - startX));
      dragCol.style.width = w + 'px';
    }
    function onDragEnd() {
      if (dragCol) {
        const dragging = document.querySelector('.col-resize.dragging');
        if (dragging) dragging.classList.remove('dragging');
        saveColumnWidths();
        dragCol = null;
      }
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', onDragEnd);
    }
    function saveColumnWidths() {
      const widths = {};
      $$('.col-resize').forEach((h) => {
        const id = h.getAttribute('data-col');
        const el = $(id);
        if (el && el.style.width) widths[id] = el.style.width;
      });
      try { localStorage.setItem('paic_col_widths', JSON.stringify(widths)); } catch (e) { /* ignore */ }
    }
  })();
  function restoreColumnWidths() {
    try {
      const raw = localStorage.getItem('paic_col_widths');
      if (!raw) return;
      const widths = JSON.parse(raw);
      Object.keys(widths).forEach((id) => { const el = $(id); if (el) el.style.width = widths[id]; });
    } catch (e) { /* ignore */ }
  }

  // ── ETA tooltip ─────────────────────────────────────────────────────────
  function predictionKey() {
    const range = getTimeRange();
    if (!range) return null;
    const sources = getSelectedSources().slice().sort().join(',');
    const rangeSec = (new Date(range.end).getTime() - new Date(range.begin).getTime()) / 1000;
    const bucket = Math.max(0, Math.round(Math.log10(Math.max(rangeSec, 1))));
    return [envSel.value, sources, queryInp.value.trim() ? '1' : '0', String(bucket)].join('|');
  }
  function loadSamples() {
    try { return JSON.parse(localStorage.getItem('paic_query_samples') || '{}'); } catch (e) { return {}; }
  }
  function recordSample(key, ms) {
    if (!key) return;
    const all = loadSamples();
    const arr = all[key] || [];
    arr.push(ms);
    // 10-sample sliding window: enough to dampen one-off outliers but small
    // enough that estimates adapt to current tenant load (not weeks-old).
    if (arr.length > 10) arr.shift();
    all[key] = arr;
    try { localStorage.setItem('paic_query_samples', JSON.stringify(all)); } catch (e) { /* ignore */ }
  }
  function predict(key) {
    const all = loadSamples();
    const arr = all[key];
    if (!arr || !arr.length) return null;
    // Median is robust to single-shot network blips; mean would let one
    // 30s outlier poison every subsequent prediction in the bucket.
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return { est: (med / 1000).toFixed(1), samples: arr.length };
  }
  function etaColor(sec) {
    if (sec < 2) return 'var(--success, #5cb85c)';
    if (sec < 10) return 'var(--warn, #d97706)';
    if (sec < 30) return 'var(--vscode-charts-orange, #d97706)';
    return 'var(--vscode-errorForeground, #c0392b)';
  }
  searchBtn.addEventListener('mouseenter', () => {
    if (searchBtn.disabled) return;
    const key = predictionKey();
    if (!key) { etaTooltip.classList.remove('visible'); return; }
    const pred = predict(key);
    if (!pred) { etaTooltip.classList.remove('visible'); return; }
    etaTooltip.replaceChildren();
    const est = document.createElement('span');
    est.textContent = '~' + pred.est + 's';
    est.style.color = etaColor(parseFloat(pred.est));
    est.style.fontWeight = '600';
    etaTooltip.appendChild(est);
    etaTooltip.appendChild(document.createTextNode(' (' + pred.samples + ' samples)'));
    etaTooltip.classList.add('visible');
  });
  searchBtn.addEventListener('mouseleave', () => etaTooltip.classList.remove('visible'));

  // ── Field filter popup ──────────────────────────────────────────────────
  let fieldPopup = null;
  function closeFieldFilterPopup() {
    if (fieldPopup) { fieldPopup.remove(); fieldPopup = null; return true; }
    return false;
  }
  function showFieldFilterPopup(anchor) {
    closeFieldFilterPopup();
    if (!state.allEntries.length) { setStatus('Run a search first.'); return; }

    const fields = extractFields(state.allEntries);
    if (!fields.length) { setStatus('No fields detected in current results.'); return; }

    const popup = document.createElement('div');
    popup.className = 'field-filter-popup';
    popup.style.cssText = 'position:absolute; background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius); box-shadow:0 8px 24px rgba(0,0,0,0.18); padding:10px; z-index:50; font-size:11px; min-width:280px;';
    popup.addEventListener('click', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.textContent = 'Add field filter';
    title.style.cssText = 'font-weight:600; color:var(--text); margin-bottom:8px; font-family:var(--sans);';
    popup.appendChild(title);

    const fLabel = document.createElement('div');
    fLabel.textContent = 'Field';
    fLabel.style.cssText = 'color:var(--text-secondary); margin-bottom:3px;';
    popup.appendChild(fLabel);

    const fieldSel = document.createElement('select');
    fieldSel.style.cssText = 'width:100%; height:24px; font-family:var(--mono); background:var(--vscode-input-background); color:var(--text); border:1px solid var(--border); border-radius:var(--radius-sm); padding:0 4px; margin-bottom:8px;';
    fields.forEach((f) => {
      const opt = document.createElement('option'); opt.value = f.path; opt.textContent = f.path + '  (' + f.count + ')'; fieldSel.appendChild(opt);
    });
    popup.appendChild(fieldSel);

    const vLabel = document.createElement('div');
    vLabel.textContent = 'Value';
    vLabel.style.cssText = 'color:var(--text-secondary); margin-bottom:3px;';
    popup.appendChild(vLabel);

    const valueSel = document.createElement('select');
    valueSel.style.cssText = 'width:100%; height:24px; font-family:var(--mono); background:var(--vscode-input-background); color:var(--text); border:1px solid var(--border); border-radius:var(--radius-sm); padding:0 4px; margin-bottom:8px;';
    popup.appendChild(valueSel);

    function refreshValues() {
      const values = extractValues(state.allEntries, fieldSel.value);
      valueSel.replaceChildren();
      values.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.value;
        opt.textContent = v.value.slice(0, 60) + '  (' + v.count + ')';
        valueSel.appendChild(opt);
      });
    }
    fieldSel.addEventListener('change', refreshValues);
    refreshValues();

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:6px; justify-content:flex-end;';
    const cancelB = document.createElement('button');
    cancelB.textContent = 'Cancel';
    cancelB.style.cssText = 'padding:3px 10px; border:1px solid var(--border); background:var(--bg); color:var(--text); cursor:pointer; border-radius:var(--radius-sm);';
    cancelB.addEventListener('click', closeFieldFilterPopup);
    const okB = document.createElement('button');
    okB.textContent = 'Add';
    okB.style.cssText = 'padding:3px 10px; border:1px solid var(--accent); background:var(--accent); color:var(--vscode-button-foreground); cursor:pointer; border-radius:var(--radius-sm);';
    okB.addEventListener('click', () => {
      if (fieldSel.value && valueSel.value) {
        state.fieldFilters.push({ field: fieldSel.value, value: valueSel.value });
        applyLocalFilters();
      }
      closeFieldFilterPopup();
    });
    btnRow.append(cancelB, okB);
    popup.appendChild(btnRow);

    document.body.appendChild(popup);
    const r = anchor.getBoundingClientRect();
    popup.style.left = Math.min(window.innerWidth - 300, r.left) + 'px';
    popup.style.top = (r.bottom + window.scrollY + 4) + 'px';
    fieldPopup = popup;
  }
  function extractFields(entries, max) {
    const counts = new Map();
    function walk(obj, prefix) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      Object.keys(obj).forEach((k) => {
        const path = prefix ? prefix + '.' + k : k;
        counts.set(path, (counts.get(path) || 0) + 1);
        const v = obj[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
      });
    }
    entries.forEach((e) => walk(e.payload, ''));
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, max || 50)
      .map(([path, count]) => ({ path, count }));
  }
  function extractValues(entries, fieldPath, max) {
    const counts = new Map();
    entries.forEach((e) => {
      const v = getValueAtPath(e.payload, fieldPath);
      if (v == null) return;
      const key = typeof v === 'object' ? JSON.stringify(v) : String(v);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, max || 30)
      .map(([value, count]) => ({ value, count }));
  }

  // ── Settings push from host (paicLogSearch.* configuration) ─────────────
  // Compiles user-supplied regex sources; on failure logs a warning and
  // skips the rule rather than crashing the webview.
  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;

    if (typeof cfg.largeQueryThresholdMinutes === 'number'
        && Number.isFinite(cfg.largeQueryThresholdMinutes)
        && cfg.largeQueryThresholdMinutes >= 0) {
      state.largeQueryThresholdMinutes = cfg.largeQueryThresholdMinutes;
    }

    if (typeof cfg.defaultPageSize === 'number'
        && Number.isFinite(cfg.defaultPageSize)
        && cfg.defaultPageSize > 0) {
      state.pageSize = cfg.defaultPageSize;
      // Ensure the dropdown shows this value: if it's not already an option,
      // insert it in sorted position so the dropdown can still be used.
      const existing = Array.from(pageSizeSel.options).find((o) => parseInt(o.value, 10) === cfg.defaultPageSize);
      if (!existing) {
        const opt = document.createElement('option');
        opt.value = String(cfg.defaultPageSize);
        opt.textContent = String(cfg.defaultPageSize);
        const values = Array.from(pageSizeSel.options).map((o) => parseInt(o.value, 10));
        let inserted = false;
        for (let i = 0; i < values.length; i++) {
          if (cfg.defaultPageSize < values[i]) {
            pageSizeSel.insertBefore(opt, pageSizeSel.options[i]);
            inserted = true;
            break;
          }
        }
        if (!inserted) pageSizeSel.appendChild(opt);
      }
      pageSizeSel.value = String(cfg.defaultPageSize);
      // Re-render with new page size (no host round-trip, full set is in webview).
      if (state.allEntries && state.allEntries.length) renderTable();
    }

    if (Array.isArray(cfg.highlightRules) && cfg.highlightRules.length) {
      const compiled = [];
      for (const r of cfg.highlightRules) {
        if (!r || typeof r.pattern !== 'string') continue;
        try {
          compiled.push({
            re: new RegExp(r.pattern, 'g'),
            color: typeof r.color === 'string' ? r.color : undefined,
            fontWeight: r.fontWeight
          });
        } catch (e) {
          console.warn('[paic-logs] bad highlightRules pattern:', r.pattern, e);
        }
      }
      if (compiled.length) LOG_HL_RULES = compiled;
    }
  }

  // ── Host → webview ──────────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'environments': renderEnvironments(msg.payload); break;
      case 'config': applyConfig(msg.payload); break;
      case 'resetPreferences': {
        // Clear all paic_* keys then reload — host triggers this from the
        // "Reset UI Preferences" command.
        try {
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.indexOf('paic_') === 0) keys.push(k);
          }
          keys.forEach((k) => localStorage.removeItem(k));
        } catch (e) { /* ignore */ }
        location.reload();
        break;
      }
      case 'setInitialEnv':
        if (envSel.options.length > 0) {
          envSel.value = msg.payload.env;
          sendTitle();
        } else {
          pendingInitialEnv = msg.payload.env; // applied by next renderEnvironments
        }
        break;
      case 'restoreSearch':
        // Sidebar Recent Searches click: restore form fields and auto-fire
        // the search. setInitialEnv has likely already set envSel.value; this
        // overwrites with the entry's env defensively, then runs the search.
        applyHistoryEntry(msg.payload);
        doSearch();
        break;
      case 'sourceList': /* HTML hardcoded for now */ break;
      case 'searchResult':
      case 'pageResult': {
        stopSearchTick();
        const p = msg.payload;
        state.sessionId = p.sessionId;
        state.totalCount = p.totalCount;
        state.truncated = p.truncated;
        state.allEntries = p.entries || [];
        // pageSize / page / pages are owned by the webview now (host sends the
        // full session in one go). Reset to first page; renderTable computes
        // the page count based on user's pageSize choice.
        state.page = 0;
        applyLocalFilters();
        applyTimeSort();
        renderTable();
        if (msg.type === 'searchResult' && state.searchStartedAt) {
          const elapsedMs = Date.now() - state.searchStartedAt;
          recordSample(predictionKey(), elapsedMs);
          if (state.lastSearchRange) {
            state.lastSearchTime = {
              begin: state.lastSearchRange.begin,
              end: state.lastSearchRange.end,
              elapsed: elapsedMs / 1000,
              count: state.totalCount,
              truncated: state.truncated
            };
          }
          state.searchStartedAt = 0;
        }
        if (state.lastSearchTime) renderStatusBar();
        else setStatus(state.totalCount + ' entries' + (state.truncated ? ' (truncated)' : ''));
        sendTitle();
        break;
      }
      case 'tailBatch':
        if (msg.payload.streamId === state.activeTail) {
          state.allEntries.push.apply(state.allEntries, msg.payload.entries || []);
          state.totalCount = state.allEntries.length;
          applyLocalFilters();
          if (state.tailAutoScroll) state.page = Number.MAX_SAFE_INTEGER;
          renderTable();
          if (state.tailAutoScroll) window.scrollTo(0, document.body.scrollHeight);
          sendTitle();
        }
        break;
      case 'tailEnded':
        if (msg.payload.streamId === state.activeTail) {
          setTailButtonState(false);
          state.activeTail = null;
          const reason = msg.payload.reason;
          const label = reason === 'user-stop' ? 'stopped'
                      : reason === 'eof' ? 'ended'
                      : reason ? ('ended: ' + reason) : 'ended';
          setStatus('Tail ' + label + ' — ' + state.allEntries.length + ' entries captured');
          sendTitle();
        }
        break;
      case 'history':
        state.history = msg.payload || [];
        if (historyMenu.classList.contains('open')) renderHistoryMenu();
        break;
      case 'tailFiles':
        state.tailFiles = msg.payload || [];
        if (historyMenu.classList.contains('open')) renderHistoryMenu();
        break;
      case 'tailFileLoaded': {
        const p = msg.payload;
        state.sessionId = null;
        state.page = 0;
        state.pageSize = state.pageSize;
        state.pages = 1;
        state.totalCount = p.entries.length;
        state.truncated = false;
        state.allEntries = p.entries;
        applyLocalFilters();
        renderTable();
        showToolbar(true);
        setStatus('Loaded tail ' + p.name + ' — ' + p.entries.length + ' entries');
        break;
      }
      case 'tailFileDeleted':
        state.tailFiles = state.tailFiles.filter((m) => m.name !== msg.payload.name);
        if (historyMenu.classList.contains('open')) renderHistoryMenu();
        break;
      case 'savedResults':
        setStatus('Saved ' + msg.payload.count + ' entries → ' + msg.payload.path);
        break;
      case 'error':
        stopSearchTick();
        setStatus('Error: ' + msg.payload.message);
        state.searchStartedAt = 0;
        break;
    }
  });

  let pendingInitialEnv = null; // set by setInitialEnv before environments arrive
  function renderEnvironments(list) {
    envSel.replaceChildren();
    if (!list || !list.length) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = '— add an environment in the sidebar —';
      opt.disabled = true; opt.selected = true;
      envSel.appendChild(opt);
      return;
    }
    list.forEach((e) => {
      const opt = document.createElement('option');
      opt.value = e.name; opt.textContent = e.name; opt.title = e.url;
      envSel.appendChild(opt);
    });
    if (pendingInitialEnv) {
      envSel.value = pendingInitialEnv;
      pendingInitialEnv = null;
    }
    updateNavButtons();
    sendTitle();
  }
  function sendTitle() {
    send({
      type: 'setTitle',
      payload: { env: envSel.value || undefined, count: state.totalCount, tail: !!state.activeTail }
    });
  }
  envSel.addEventListener('change', sendTitle);

  // ── Init ────────────────────────────────────────────────────────────────
  try { localStorage.removeItem('paic_last_search'); } catch (e) { /* ignore */ }
  updateSourceLabel();
  syncClearables();
  restoreColumnWidths();
  updateNavButtons();
  renderFilterChips();
  send({ type: 'getEnvironments' });
})();
