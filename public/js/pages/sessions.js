/**
 * BP-001.26 — Sessions page: a sortable, filterable table of every session in
 * the scan, each row expanding to its full diagnosis.
 *
 * THE TWO RULES THIS FILE EXISTS TO HOLD
 * --------------------------------------
 * 1. A `null` cell is `.not-measured`, never 0 and never blank.  "Cache read"
 *    and "Avg context" are evidence the analyzer either computed or explicitly
 *    could not; where the rule came back `unknown`, the cell says so and the
 *    expanded row says why.  A blank cell would read as zero, and a zero would
 *    be a fabricated measurement.
 *
 * 2. SORTING PUTS `null` LAST IN BOTH DIRECTIONS.  This is not a nicety: a
 *    comparator that treats `null` as 0 sorts every unmeasured session to the
 *    top of an ascending "lowest cache read" sort, which is precisely the list
 *    a user would read as "my worst sessions".  Unmeasured is not worst and it
 *    is not best; it is not on the scale at all, so it sits at the bottom
 *    whichever way the arrow points.  (`sortSessions` in src/server.js takes the
 *    same position for the server-side sort.)
 *
 * 3. THE TABLE IS A PAGE, AND IT SAYS SO.  `/api/sessions` returned the whole
 *    matched corpus in one body — 1,236 sessions / 43.8MB measured on a heavy
 *    real corpus — for a table showing about twenty rows.  It now serves twenty
 *    at a time and this page fetches the next twenty when the reader reaches
 *    the bottom.  Everything the toolbar and the header sentence count is
 *    therefore a count of what has been LOADED, never of what exists, and both
 *    numbers are printed side by side.  The CLI filter and the column sort run
 *    over the loaded rows only; saying "12 of 1,236" when 40 rows are in hand
 *    would be exactly the overstatement this product exists not to make.
 *
 * The verdict rendering — including the whole `unknown` treatment — is imported
 * from the health page rather than re-implemented, so the two pages cannot
 * drift apart on the one rule that matters.
 *
 * SECURITY: no `innerHTML` in this file.  Project paths, cwd and model ids come
 * off local disk and reach the DOM only through `textContent` or
 * `setAttribute`.
 *
 * @module public/js/pages/sessions
 */

import { registerPage, api as appApi } from '../app.js';
import { openFixModal } from '../components/fix-modal.js';
import { dateText, duration, el as uiEl, healthNode, cliIcon, ruleLabel, severity, button as uiButton, sparkline as uiSparkline } from '../components/ui.js';
import {
  callout,
  durationText,
  el,
  evidenceValueByLabel,
  evidenceValueNode,
  groupInt,
  notMeasured,
  ruleById,
  scoreNode,
  subagentTurnsNode,
  text,
  verdictList,
  whenText,
  windowValueNode,
} from './health.js';

/**
 * Rows per request, mirroring `SESSIONS_PAGE_LIMIT` in src/server.js.  Stated
 * explicitly rather than left to the server's default, so a page that has
 * fetched N times knows exactly which offset it has not yet asked for.
 */
const PAGE_SIZE = 20;

/**
 * Sort, filter, expansion AND paging state survive a re-render; only the rows
 * themselves arrive from outside.
 *
 * `requested` holds every offset already sent, so a sentinel that fires twice
 * — which it will, because appending rows moves it back into view — cannot
 * fetch the same page twice.  `error` holds the last failed page rather than
 * clearing it: a load that failed silently stops the list, and this list is
 * the product's evidence surface.
 */
const state = {
  sortKey: 'date',
  order: 'desc',
  cli: 'all',
  expanded: new Set(),
  mount: null,
  data: null,
  seeded: undefined,
  ctx: {},
  sessions: [],
  seen: new Set(),
  total: null,
  nextOffset: null,
  hasMore: false,
  requested: new Set(),
  loading: false,
  error: null,
  observer: null,
  selected: null,
};

/**
 * Column definitions.  `value` returns a sortable scalar or `null`; `cell`
 * renders the display form.  The two are kept apart deliberately: the sort key
 * for "Health score" is a number, its display is "4/6 passed · 2 unknown".
 */
const COLUMNS = [
  {
    key: 'cli',
    label: 'CLI',
    type: 'text',
    value: (session) => (typeof session?.cli === 'string' && session.cli ? session.cli : null),
    cell: (session) => {
      const td = el('td');
      if (session?.cli) td.append(el('span', 'health-cli', session.cli));
      else td.append(notMeasured('the collector did not name its CLI'));
      return td;
    },
  },
  {
    key: 'date',
    label: 'Date',
    type: 'number',
    value: (session) => {
      const ms = Date.parse(session?.startedAt ?? '');
      return Number.isFinite(ms) ? ms : null;
    },
    cell: (session) => {
      const td = el('td');
      const when = whenText(session?.startedAt);
      if (when === null) td.append(notMeasured('no start timestamp was recorded for this session'));
      else td.append(text(when));
      return td;
    },
  },
  {
    key: 'sessionId',
    label: 'Session',
    type: 'text',
    value: (session) => session?.sessionId || null,
    cell: (session) => { const td = el('td'); td.append(session?.sessionId ? text(session.sessionId) : notMeasured('no session id was recorded')); return td; },
  },
  {
    key: 'findings',
    label: 'Key findings',
    type: 'text',
    value: (session) => (session?.rules || []).filter((rule) => rule?.evidence?.status === 'observed').length,
    cell: (session) => { const td = el('td'); const findings = (session?.rules || []).filter((rule) => rule?.evidence?.status === 'observed'); if (!findings.length) td.append(el('span', 'finding-pill finding-clear', 'No problems')); else findings.slice(0, 3).forEach((rule) => td.append(el('span', `finding-pill finding-${severity(rule).toLowerCase()}`, ruleLabel(rule)))); return td; },
  },
  {
    key: 'trend',
    label: 'Trend',
    type: 'number',
    value: (session) => session?.turns?.length || session?.turnCount || null,
    cell: (session) => {
      const td = el('td');
      const values = (session?.turns || []).map((turn) => turn?.context?.inputTokens).filter(Number.isFinite);
      if (values.length >= 2) {
        // Colour the line by how the session scored, so the column reads at a
        // glance instead of being twenty identical strokes.
        const score = session?.score || {};
        const measured = Math.max(0, (score.total || 0) - (score.unknown || 0));
        const tone = measured === 0 ? 'unknown' : (score.observed || 0) >= 2 ? 'crit' : (score.observed || 0) === 1 ? 'warn' : 'pass';
        td.append(uiSparkline(values, `tone-${tone}`));
      } else {
        // An empty cell reads as a rendering failure. A dash says what is true:
        // fewer than two turns carried a context size, so there is no line to draw.
        td.append(notMeasured('fewer than two turns in this session recorded a context size, so there is no trend to draw'));
      }
      return td;
    },
  },
  {
    key: 'project',
    label: 'Project',
    type: 'text',
    value: (session) => (typeof session?.project === 'string' && session.project ? session.project : null),
    cell: (session) => {
      const td = el('td');
      if (session?.project) {
        const label = el('span', 'meta-value', session.project);
        label.setAttribute('title', session.cwd ?? session.project);
        td.append(label);
      } else {
        td.append(notMeasured('the collector recorded no project for this session'));
      }
      return td;
    },
  },
  {
    key: 'duration',
    label: 'Duration',
    type: 'number',
    num: true,
    value: (session) => {
      const from = Date.parse(session?.startedAt ?? '');
      const to = Date.parse(session?.endedAt ?? '');
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
      return to - from;
    },
    cell: (session) => {
      const td = el('td', 'num');
      const duration = durationText(session?.startedAt, session?.endedAt);
      if (duration === null) td.append(notMeasured('the session start or end was not recorded'));
      else td.append(text(duration));
      return td;
    },
  },
  {
    key: 'turns',
    label: 'Turns',
    type: 'number',
    num: true,
    value: (session) => (Number.isFinite(session?.turnCount) ? session.turnCount : null),
    cell: (session) => {
      const td = el('td', 'num');
      if (Number.isFinite(session?.turnCount)) td.append(text(groupInt(session.turnCount)));
      else td.append(notMeasured('no turn count was recorded'));
      return td;
    },
  },
  {
    key: 'score',
    label: 'Health',
    type: 'number',
    num: true,
    // Passed count is the sort key. An unknown is NOT counted as passed, so a
    // session with four passes and two unmeasurable checks never outranks a
    // session with six measured passes.
    value: (session) => (Number.isFinite(session?.score?.passed) ? session.score.passed : null),
    cell: (session) => {
      const td = el('td', 'num');
      td.append(healthNode(session?.score, true));
      return td;
    },
  },
];

const COLUMN_BY_KEY = new Map(COLUMNS.map((column) => [column.key, column]));

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Compare two sort values.  `null` sorts last whichever direction is asked
 * for — see the header comment for why this is load-bearing rather than tidy.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @param {1|-1} direction
 * @param {'text'|'number'} type
 * @returns {number}
 */
export function compareValues(left, right, direction, type) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (type === 'number') return (Number(left) - Number(right)) * direction;
  return String(left).localeCompare(String(right)) * direction;
}

/** Sort rows by the active column, breaking ties on start time then session id. */
function sortRows(sessions) {
  const column = COLUMN_BY_KEY.get(state.sortKey) ?? COLUMN_BY_KEY.get('date');
  const direction = state.order === 'asc' ? 1 : -1;
  return [...sessions].sort((a, b) => {
    const primary = compareValues(column.value(a), column.value(b), direction, column.type);
    if (primary !== 0) return primary;
    const tie = compareValues(
      COLUMN_BY_KEY.get('date').value(a),
      COLUMN_BY_KEY.get('date').value(b),
      -1,
      'number',
    );
    if (tie !== 0) return tie;
    return String(a?.sessionId ?? '').localeCompare(String(b?.sessionId ?? ''));
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The expanded diagnosis row: metadata, score, then every rule verdict. */
function diagnosisRow(session, api, redraw) {
  const tr = el('tr', 'session-diagnosis');
  tr.dataset.sessionId = session?.sessionId ?? '';
  const cell = el('td');
  cell.colSpan = COLUMNS.length + 1;

  const body = el('div', 'card-body');
  const grid = el('div', 'meta-grid');
  const metaCell = (label, value, why) => {
    const wrap = el('div');
    wrap.append(el('span', 'meta-label', label));
    const slot = el('span', 'meta-value');
    if (value === null || value === undefined) slot.append(notMeasured(why));
    else if (typeof value === 'string' || typeof value === 'number') slot.append(text(String(value)));
    else slot.append(value);
    wrap.append(slot);
    return wrap;
  };
  grid.append(metaCell('session id', session?.sessionId ?? null, 'the collector recorded no session id'));
  grid.append(metaCell('model', session?.model ?? null, 'no model id was recorded'));
  grid.append(metaCell('context window', windowValueNode(session?.window)));
  grid.append(metaCell('cwd', session?.cwd ?? null, 'no working directory was recorded'));
  grid.append(metaCell('ended', whenText(session?.endedAt), 'no end timestamp was recorded'));
  grid.append(metaCell('sub-agent turns', subagentTurnsNode(session)));
  body.append(grid);
  body.append(scoreNode(session?.score, session?.rules));
  body.append(verdictList(session, api, redraw));

  cell.append(body);
  tr.append(cell);
  return tr;
}

/** One data row, plus its diagnosis row when expanded. */
function sessionRows(session, api, redraw) {
  const id = String(session?.sessionId ?? '');
  const expanded = state.expanded.has(id);
  const rows = [];

  const tr = el('tr');
  tr.dataset.sessionId = id;
  tr.dataset.cli = session?.cli ?? 'unknown';
  tr.addEventListener('click', () => { state.selected = session; redraw(); });

  const toggleCell = el('td');
  const toggle = el('button', 'button button-quiet button-sm', expanded ? '−' : '+');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  toggle.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} the diagnosis for session ${id || '(no id)'}`);
  toggle.addEventListener('click', () => {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    redraw();
  });
  toggleCell.append(toggle);
  tr.append(toggleCell);

  for (const column of COLUMNS) tr.append(column.cell(session));
  rows.push(tr);

  if (expanded) rows.push(diagnosisRow(session, api, redraw));
  return rows;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

/**
 * CLI filter and the sort reset, plus the honest row count.
 *
 * Every number here counts LOADED rows.  While more pages remain, each one says
 * so in the caption — `claude (18 loaded)`, not `claude (18)` — because the
 * filter cannot see a session this page has not fetched, and a bare count reads
 * as a corpus total.  Once the last page is in, the qualifier drops, since the
 * count is then the whole match.
 */
function toolbar(loaded, shown, total, redraw) {
  const bar = el('div', 'toolbar');
  const partial = state.hasMore;

  const label = el('label', 'toolbar-filter');
  label.append(el('span', 'meta-label', 'CLI'));
  const select = el('select');
  select.setAttribute(
    'aria-label',
    partial
      ? 'Filter the sessions loaded so far by CLI. Sessions not yet loaded are not counted.'
      : 'Filter sessions by CLI',
  );
  const clis = [...new Set(loaded.map((session) => session?.cli).filter((cli) => typeof cli === 'string' && cli))].sort();
  const option = (value, caption) => {
    const node = el('option', null, caption);
    node.value = value;
    if (state.cli === value) node.selected = true;
    return node;
  };
  select.append(option('all', partial
    ? `All CLIs (${groupInt(loaded.length) ?? '0'} of ${groupInt(total) ?? '0'} loaded)`
    : `All CLIs (${groupInt(loaded.length) ?? '0'})`));
  for (const cli of clis) {
    const count = loaded.filter((session) => session?.cli === cli).length;
    select.append(option(cli, partial ? `${cli} (${groupInt(count) ?? '0'} loaded)` : `${cli} (${groupInt(count) ?? '0'})`));
  }
  select.addEventListener('change', () => {
    state.cli = select.value;
    redraw();
  });
  label.append(select);
  bar.append(label);

  bar.append(el('span', 'toolbar-spacer'));

  const column = COLUMN_BY_KEY.get(state.sortKey);
  const counted = partial
    ? `${groupInt(shown.length) ?? '0'} shown of ${groupInt(loaded.length) ?? '0'} loaded, of ${groupInt(total) ?? '0'} matched`
    : `${groupInt(shown.length) ?? '0'} of ${groupInt(loaded.length) ?? '0'} shown`;
  bar.append(
    el(
      'span',
      'chart-sub',
      `${counted} · sorted by ${column?.label ?? 'date'} ${state.order === 'asc' ? 'ascending' : 'descending'}`,
    ),
  );
  return bar;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * Take one page of rows into `state`, ignoring any session already held.
 *
 * The de-duplication is not decoration: each request re-scans the corpus, so a
 * session written between two requests shifts every later row by one and page 2
 * would otherwise repeat page 1's last entry.  A repeated row is a lie about
 * how many sessions exist, which is the one thing this table may not tell.
 *
 * @param {object} payload a `/api/sessions` body
 * @param {boolean} reset true for the first page, replacing whatever was held
 * @returns {void}
 */
function absorb(payload, reset) {
  const rows = Array.isArray(payload?.sessions) ? payload.sessions : [];
  if (reset) {
    state.sessions = [];
    state.seen = new Set();
    state.requested = new Set([0]);
  }
  for (const session of rows) {
    const id = String(session?.sessionId ?? '');
    // A row with no id cannot be de-duplicated, so it is kept as-is rather than
    // dropped — an unidentifiable session is still a session that was read.
    if (id && state.seen.has(id)) continue;
    if (id) state.seen.add(id);
    state.sessions.push(session);
  }
  state.total = Number.isFinite(payload?.total) ? payload.total : state.sessions.length;
  state.hasMore = payload?.hasMore === true;
  state.nextOffset = Number.isFinite(payload?.nextOffset) ? payload.nextOffset : null;
  if (!state.hasMore) state.nextOffset = null;
}

/**
 * Fetch the next page, at most once per offset and at most one at a time.
 *
 * Three guards, each closing a different failure: `loading` stops two in-flight
 * requests from appending out of order; `requested` stops the same offset being
 * fetched twice when the sentinel re-enters view after rows are appended; and
 * `hasMore` / a null `nextOffset` stops the list requesting past its end
 * forever.  A failure leaves the offset UNrequested so Retry can ask again.
 *
 * @param {{get: Function}} api the request helper from app.js
 * @param {Function} redraw
 * @returns {Promise<void>}
 */
async function loadNextPage(api, redraw) {
  if (state.loading || state.error) return;
  if (!state.hasMore) return;
  const offset = state.nextOffset;
  if (!Number.isFinite(offset) || state.requested.has(offset)) return;

  state.requested.add(offset);
  state.loading = true;
  redraw();
  try {
    const payload = await api.get(`/api/sessions?limit=${PAGE_SIZE}&offset=${offset}`);
    absorb(payload, false);
    state.error = null;
  } catch (error) {
    // app.js's request helper has already turned a dead server or a stale CSRF
    // nonce into a sentence a person can act on; it is shown verbatim.
    state.error = error?.message || 'The next page of sessions could not be loaded.';
    state.requested.delete(offset);
  } finally {
    state.loading = false;
    redraw();
  }
}

/**
 * The strip below the table: sentinel, spinner text, failure, or end-of-list.
 *
 * The sentinel is an `IntersectionObserver` target rather than a scroll
 * handler, so nothing runs per scroll event.  Where `IntersectionObserver` does
 * not exist — an old browser, or a test DOM — the same strip renders an
 * explicit button instead, because a list that silently stops at twenty rows
 * while claiming 1,236 exist is worse than a list with a button in it.
 *
 * @param {{get: Function}} api
 * @param {Function} redraw
 * @returns {HTMLElement|null}
 */
function pager(api, redraw) {
  if (state.error) {
    const strip = el('div', 'sessions-pager');
    strip.dataset.state = 'error';
    strip.setAttribute('role', 'alert');
    strip.append(el('span', null, state.error));
    const retry = el('button', 'button button-sm', 'Retry');
    retry.type = 'button';
    retry.dataset.action = 'retry-page';
    retry.addEventListener('click', () => {
      state.error = null;
      loadNextPage(api, redraw);
    });
    strip.append(retry);
    return strip;
  }

  if (!state.hasMore) {
    const strip = el('div', 'sessions-pager');
    strip.dataset.state = 'end';
    strip.append(el(
      'span',
      null,
      `End of the list — all ${groupInt(state.sessions.length) ?? '0'} session${state.sessions.length === 1 ? '' : 's'} matched in this scan are loaded.`,
    ));
    return strip;
  }

  const strip = el('div', 'sessions-pager');
  strip.dataset.state = state.loading ? 'loading' : 'idle';
  strip.dataset.nextOffset = String(state.nextOffset ?? '');
  strip.setAttribute('aria-live', 'polite');
  const remaining = Number.isFinite(state.total) ? state.total - state.sessions.length : null;
  strip.append(el(
    'span',
    null,
    state.loading
      ? 'Loading the next 20 sessions…'
      : `${groupInt(remaining) ?? 'More'} more session${remaining === 1 ? '' : 's'} to load.`,
  ));

  const manual = el('button', 'button button-sm', 'Load more');
  manual.type = 'button';
  manual.dataset.action = 'load-more';
  manual.disabled = state.loading === true;
  manual.addEventListener('click', () => loadNextPage(api, redraw));
  strip.append(manual);
  return strip;
}

/**
 * Point the observer at the current strip, replacing any earlier one.
 *
 * `draw()` rebuilds the whole subtree, so the previous target is detached DOM
 * and the previous observer must be disconnected with it or it leaks one
 * observer per redraw — and a leaked observer on a detached node never fires,
 * which would look exactly like the list quietly ending.
 *
 * @param {HTMLElement|null} target
 * @param {{get: Function}} api
 * @param {Function} redraw
 * @returns {void}
 */
function observe(target, api, redraw) {
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }
  const Observer = globalThis.IntersectionObserver;
  if (typeof Observer !== 'function' || !target || !state.hasMore || state.error) return;
  state.observer = new Observer((entries) => {
    if (entries.some((entry) => entry?.isIntersecting)) loadNextPage(api, redraw);
  }, { rootMargin: '200px' });
  state.observer.observe(target);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function drawTable(sessions, api, redraw) {
  const wrap = el('div', 'table-wrap');
  const table = el('table');

  const thead = el('thead');
  const headRow = el('tr');
  const spacer = el('th');
  spacer.append(el('span', 'visually-hidden', 'Expand row'));
  headRow.append(spacer);
  for (const column of COLUMNS) {
    const th = el('th', `sortable${column.num ? ' num' : ''}`);
    const active = state.sortKey === column.key;
    th.setAttribute('aria-sort', active ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none');
    th.setAttribute('scope', 'col');
    th.dataset.column = column.key;
    const button = el('button', 'button-quiet', column.label);
    button.type = 'button';
    button.setAttribute(
      'aria-label',
      `Sort by ${column.label}${active ? `, currently ${state.order === 'asc' ? 'ascending' : 'descending'}` : ''}. Sessions with no value for this column always sort last.`,
    );
    button.addEventListener('click', () => {
      if (state.sortKey === column.key) state.order = state.order === 'asc' ? 'desc' : 'asc';
      else {
        state.sortKey = column.key;
        state.order = column.type === 'number' ? 'desc' : 'asc';
      }
      redraw();
    });
    th.append(button);
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = el('tbody');
  for (const session of sessions) for (const row of sessionRows(session, api, redraw)) tbody.append(row);
  table.append(tbody);

  wrap.append(table);
  return wrap;
}

/** Render from the stored state. Every control calls this, never the DOM directly. */
function draw() {
  const mount = state.mount;
  if (!mount) return;
  const api = state.ctx?.api ?? appApi;
  const data = state.data ?? {};
  const all = state.sessions;
  const filtered = state.cli === 'all' ? all : all.filter((session) => session?.cli === state.cli);
  const sorted = sortRows(filtered);

  mount.replaceChildren();
  const stack = el('div', 'page-stack');
  const title = el('h1', null, 'Sessions');
  title.id = 'sessions-title';
  stack.append(title);

  const total = Number.isFinite(state.total) ? state.total : all.length;
  // Two counts, never one: what is on this page, and what the scan matched.
  // The first sentence is the whole reason the page is allowed to paginate —
  // collapsing it to "1,236 sessions" over a 20-row table, or to "20 sessions"
  // over a 1,236-session corpus, would each be a different false claim.
  stack.append(
    el(
      'p',
      'note',
      (state.hasMore
        ? `Showing ${groupInt(all.length) ?? '0'} of ${groupInt(total) ?? '0'} session${total === 1 ? '' : 's'} matched in this scan — more load as you scroll. `
          + 'The CLI filter and the column sort below apply to the rows loaded so far, not to the whole scan. '
        : `${groupInt(all.length) ?? '0'} session${all.length === 1 ? '' : 's'} matched in this scan, all loaded. `)
        + 'A dash in any column means the value was not recorded — it is not a zero. '
        + 'Sorting always places those rows last, in both directions, because "not measured" is neither the best nor the worst value.',
    ),
  );
  if (data?.scan?.note) stack.append(el('p', 'note', `Scan: ${data.scan.note}`));

  if (!all.length) {
    stack.append(
      callout(
        'unknown',
        'Nothing read',
        'No session fell inside this scan, so there is nothing to list. An empty read is not a clean bill of health.',
      ),
    );
    mount.append(stack);
    observe(null, api, draw);
    return;
  }

  const card = el('section', 'card');
  const head = el('div', 'card-head legacy-toolbar');
  head.append(toolbar(all, sorted, total, draw));
  card.append(head);
  card.append(drawTable(sorted, api, draw));
  const layout = el('div', 'session-layout');
  const filters = el('aside', 'rx-card filter-panel');
  filters.append(el('h2', '', 'Filters'));
  filters.append(el('p', 'filter-note', 'Counts describe loaded rows only.'));
  const cliGroup = el('div', 'filter-group'); cliGroup.append(el('h3', '', 'CLI'));
  const cliCounts = new Map(); all.forEach((session) => cliCounts.set(session?.cli, (cliCounts.get(session?.cli) || 0) + 1));
  cliGroup.append(filterChoice('All sessions', all.length, state.cli === 'all', () => { state.cli = 'all'; draw(); }));
  [...cliCounts.entries()].filter(([cli]) => cli).forEach(([cli,count]) => cliGroup.append(filterChoice(cli, count, state.cli === cli, () => { state.cli = cli; draw(); })));
  filters.append(cliGroup);
  const healthGroup = el('div','filter-group'); healthGroup.append(el('h3','','Health status')); healthGroup.append(filterChoice('Problems found', all.filter((s)=>(s?.score?.observed||0)>0).length, false, null), filterChoice('Could not be measured', all.filter((s)=>(s?.score?.unknown||0)>0).length, false, null)); filters.append(healthGroup);
  const issueGroup = el('div','filter-group'); issueGroup.append(el('h3','','Issue type')); const issueNames = new Map(); all.forEach((s)=>(s.rules||[]).filter((r)=>r?.evidence?.status==='observed').forEach((r)=>issueNames.set(ruleLabel(r),(issueNames.get(ruleLabel(r))||0)+1))); [...issueNames.entries()].slice(0,5).forEach(([name,count])=>issueGroup.append(filterChoice(name,count,false,null))); filters.append(issueGroup); layout.append(filters);
  layout.append(card);
  if (state.selected) layout.append(detailPanel(state.selected, api, draw));
  stack.append(layout);

  if (!sorted.length) {
    stack.append(el('p', 'empty-state', `No session loaded so far came from ${state.cli}.`));
  }

  const strip = pager(api, draw);
  if (strip) stack.append(strip);
  mount.append(stack);
  observe(strip, api, draw);
}

function filterChoice(label, count, checked, onChange) {
  const row = el('label','filter-option'); const input = el('input'); input.type='checkbox'; input.checked=checked; input.setAttribute('aria-label', label); if (onChange) input.addEventListener('change', onChange); row.append(input, el('span','',label), el('strong','',String(count))); return row;
}

function detailPanel(session, api, redraw) {
  const panel = el('aside','rx-card detail-panel'); const close=uiButton('Close','button button-quiet'); close.addEventListener('click',()=>{state.selected=null; redraw();}); const head=el('div','rx-card-head'); head.append(el('h2','', 'Session details'),close); panel.append(head); const identity=el('div'); identity.append(cliIcon(session?.cliName || session?.cli),el('strong','',` ${session?.cliName || session?.cli || 'Unknown CLI'}`)); panel.append(identity,el('p','rx-label',dateText(session?.startedAt)),el('p','rx-label',`${duration(session?.startedAt,session?.endedAt)} · ${Number.isFinite(session?.turnCount) ? session.turnCount : 'not measured'} turns`),healthNode(session?.score)); const tabs=el('div','tab-strip'); ['Diagnosis','Evidence','Metrics','Timeline'].forEach((name,index)=>{const tab=uiButton(name,'tab-button'); if(index===0) tab.classList.add('is-active'); tabs.append(tab);}); panel.append(tabs); const observed=(session?.rules||[]).filter((r)=>r?.evidence?.status==='observed'); const unknown=(session?.rules||[]).filter((r)=>r?.evidence?.status==='unknown'); panel.append(el('h3','', 'Findings')); observed.forEach((rule)=>{const row=el('div','fix-row'); row.append(el('span','rank','!'),el('span','fix-title',ruleLabel(rule)),el('span','severity',rule?.severity==='error'?'High':'Medium')); panel.append(row);}); if (unknown.length) panel.append(el('p','not-measured',`${unknown.length} checks could not be measured. They are not passes.`)); const suggested=observed.filter((r)=>r.fix); if(suggested.length){panel.append(el('h3','', 'Suggested fixes')); suggested.forEach((rule)=>{const apply=uiButton('Review'); apply.addEventListener('click',()=>openFixModal({fixId:rule.fix,rule,session,api})); const row=el('div','fix-row'); row.append(el('span','fix-title',ruleLabel(rule)),apply); panel.append(row);});} return panel;
}

/**
 * Render the sessions page (BP-001.26).
 *
 * @param {HTMLElement} mount the `#page-sessions` section
 * @param {object} data the `/api/sessions` body (BP-005.02)
 * @param {{store?: object, api?: object, navigate?: Function}} [ctx]
 * @returns {void}
 */
export function renderSessions(mount, data, ctx = {}) {
  if (!mount) return;
  state.mount = mount;
  state.data = data;
  state.ctx = ctx;
  // app.js caches the first page and re-renders from that same object on every
  // return to this tab, so a re-render must not re-seed from it and throw away
  // pages 2..n. The payload identity is the test: a NEW body is a new first
  // page, the same body is the same first page.
  if (state.data !== state.seeded) {
    state.seeded = state.data;
    state.error = null;
    absorb(data ?? {}, true);
  }
  draw();
}

registerPage('sessions', renderSessions);

export default renderSessions;
