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
 *    numbers are printed side by side.  CLI options come from the server's
 *    scan facet, while health and issue filters still run over loaded rows.
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

import { rangeQuery, registerPage, api as appApi } from '../app.js';
import { openSuggestionPanel } from '../components/suggestion-panel.js';
import { dateText, duration, el as uiEl, healthNode, cliIcon, icon, ruleLabel, scoreParts, severity, button as uiButton, sparkline as uiSparkline } from '../components/ui.js';
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

function iconBadge(name) {
  const badge = el('span', 'rx-icon');
  badge.append(icon(name));
  return badge;
}

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
  cliCounts: null,
  nextOffset: null,
  hasMore: false,
  requested: new Set(),
  loading: false,
  error: null,
  observer: null,
  selected: null,
  health: new Set(),
  issues: new Set(),
  detailTab: 'diagnosis',
};

/**
 * The sidebar's Health status choices.  Within one group a session matches if
 * ANY ticked choice matches; across groups (CLI, health, issue) it must match
 * ALL of them.  "Could not be measured" is its own choice, never folded into
 * "no problems", because an unmeasured check is not a pass.
 */
const HEALTH_CHOICES = [
  { key: 'observed', label: 'Problems found', test: (session) => (session?.score?.observed || 0) > 0 },
  { key: 'unknown', label: 'Could not be measured', test: (session) => (session?.score?.unknown || 0) > 0 },
];

/** Labels of the rules this session was OBSERVED to break. */
function observedLabels(session) {
  return (session?.rules || []).filter((rule) => rule?.evidence?.status === 'observed').map((rule) => ruleLabel(rule));
}

/** Apply the CLI, Health status and Issue type filters to the loaded rows. */
function filterRows(sessions) {
  return sessions.filter((session) => {
    if (state.health.size && !HEALTH_CHOICES.some((choice) => state.health.has(choice.key) && choice.test(session))) return false;
    if (state.issues.size && !observedLabels(session).some((label) => state.issues.has(label))) return false;
    return true;
  });
}

/** True when any filter narrows the list, so the page can offer "Clear filters". */
function filtering() {
  return state.cli !== 'all' || state.health.size > 0 || state.issues.size > 0;
}

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
      else td.append(el('span', 'session-date', when));
      return td;
    },
  },
  {
    key: 'sessionId',
    label: 'Session',
    type: 'text',
    value: (session) => session?.sessionId || null,
    cell: (session) => {
      const td = el('td');
      if (!session?.sessionId) td.append(notMeasured('no session id was recorded'));
      else {
        const value = el('span', 'session-id', session.sessionId);
        value.title = session.sessionId;
        td.append(value);
      }
      return td;
    },
  },
  {
    key: 'findings',
    label: 'Key findings',
    type: 'text',
    value: (session) => (session?.rules || []).filter((rule) => rule?.evidence?.status === 'observed').length,
    cell: (session) => findingCell(session),
  },
  {
    key: 'trend',
    label: 'Trend',
    type: 'number',
    value: (session) => session?.turns?.length || session?.turnCount || null,
    cell: (session) => {
      const td = el('td');
      // `contextSeries` is the per-turn context reading, sent by /api/sessions
      // as a flat list of numbers. It is read in preference to `session.turns`
      // because `turns` is not in the payload and never was: the analyzer keeps
      // the turn COUNT and discards the array, so this cell read an absent
      // field and printed "not measured" over data that had been collected.
      // The `turns` read is kept as a fallback for any caller that does hold a
      // raw session (the single-session endpoint's shape).
      const seriesSent = Array.isArray(session?.contextSeries);
      const readings = seriesSent ? session.contextSeries : (session?.turns || []).map((turn) => turn?.context?.inputTokens);
      // Still filtered, and still on the READING: a turn that recorded no
      // context size contributes nothing rather than a zero.
      const values = readings.filter(Number.isFinite);
      if (values.length >= 2) {
        // Colour the line by how the session scored, so the column reads at a
        // glance instead of being twenty identical strokes.
        const score = session?.score || {};
        const measured = Math.max(0, (score.total || 0) - (score.unknown || 0));
        const tone = measured === 0 ? 'unknown' : (score.observed || 0) >= 2 ? 'crit' : (score.observed || 0) === 1 ? 'warn' : 'pass';
        td.append(uiSparkline(values, `tone-${tone}`));
      } else {
        // An empty cell reads as a rendering failure. A dash says what is true —
        // and WHICH true thing, because "we read the turns and none carried a
        // context size" and "this row's readings never reached the page" are
        // different statements and only the first is a fact about the session.
        td.append(notMeasured(seriesSent || Array.isArray(session?.turns)
          ? 'fewer than two turns in this session recorded a context size, so there is no trend to draw'
          : 'the per-turn context readings for this session did not reach this page, so no trend could be measured'));
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

/** Keep the findings presentation compact; the expanded diagnosis stays complete. */
export function findingCell(session) {
  const td = el('td', 'session-findings');
  const findings = (session?.rules || []).filter((rule) => rule?.evidence?.status === 'observed');
  const { total, unknown } = scoreParts(session?.score);
  if (findings.length) {
    const list = el('span', 'finding-list');
    const visible = findings.slice(0, 1);
    visible.forEach((rule) => {
      const label = ruleLabel(rule);
      const pill = el('span', `finding-pill finding-${severity(rule).toLowerCase()}`, label);
      pill.setAttribute('title', label);
      list.append(pill);
    });
    const hidden = findings.slice(visible.length);
    if (hidden.length) {
      const counter = el('span', 'finding-counter', `+${hidden.length} more`);
      counter.setAttribute('title', `Hidden findings: ${hidden.map((rule) => ruleLabel(rule)).join(', ')}`);
      list.append(counter);
    }
    td.append(list);
  } else if (unknown > 0) {
    const denominator = Number.isFinite(total) ? total : unknown;
    const list = el('span', 'finding-list');
    const label = `${unknown} of ${denominator} checks could not be measured`;
    const pill = el('span', 'finding-pill finding-unknown', label);
    pill.setAttribute('title', label);
    list.append(pill);
    td.append(list);
  } else {
    const list = el('span', 'finding-list');
    const label = 'Checks ran; no problems observed';
    const pill = el('span', 'finding-pill finding-clear', label);
    pill.setAttribute('title', label);
    list.append(pill);
    td.append(list);
  }
  return td;
}

export function observedFindingCount(session) {
  return (session?.rules || []).filter((rule) => rule?.evidence?.status === 'observed').length;
}

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
export function diagnosisRow(session, api, redraw) {
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
 * CLI facet counts are counts of sessions matching in the bounded scan, not
 * counts of rows currently loaded. Health and issue counts remain loaded-row
 * counts because those filters are still client-side.
 */
function toolbar(loaded, shown, total, api, redraw) {
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
  const cliCounts = Array.isArray(state.cliCounts)
    ? state.cliCounts
    : [...new Set(loaded.map((session) => session?.cli).filter((cli) => typeof cli === 'string' && cli))]
      .sort()
      .map((cli) => ({ cli, count: loaded.filter((session) => session?.cli === cli).length }));
  const option = (value, caption) => {
    const node = el('option', null, caption);
    node.value = value;
    if (state.cli === value) node.selected = true;
    return node;
  };
  select.append(option('all', Array.isArray(state.cliCounts)
    ? `All CLIs (${groupInt(total) ?? '0'})`
    : partial
      ? `All CLIs (${groupInt(loaded.length) ?? '0'} of ${groupInt(total) ?? '0'} loaded)`
      : `All CLIs (${groupInt(loaded.length) ?? '0'})`));
  for (const entry of cliCounts) {
    if (typeof entry?.cli !== 'string' || !entry.cli) continue;
    select.append(option(entry.cli, Array.isArray(state.cliCounts)
      ? `${entry.cli} (${groupInt(entry.count) ?? '0'})`
      : partial
        ? `${entry.cli} (${groupInt(entry.count) ?? '0'} loaded)`
        : `${entry.cli} (${groupInt(entry.count) ?? '0'})`));
  }
  select.addEventListener('change', () => {
    changeCli(select.value, api, redraw);
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
    state.cliCounts = Array.isArray(payload?.cliCounts) ? payload.cliCounts : null;
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

function sessionsUrl(offset) {
  const cli = state.cli !== 'all' ? `&cli=${encodeURIComponent(state.cli)}` : '';
  return `/api/sessions?limit=${PAGE_SIZE}&offset=${offset}${cli}${rangeQuery('/api/sessions').replace(/^\?/, '&')}`;
}

/** Start a new server-side CLI list at page one, preserving the paging guards. */
async function loadFirstPage(api, redraw) {
  if (state.loading) return;
  const requestId = (state.requestId ?? 0) + 1;
  state.requestId = requestId;
  state.sessions = [];
  state.seen = new Set();
  state.requested = new Set([0]);
  state.total = null;
  state.nextOffset = null;
  state.hasMore = false;
  state.error = null;
  state.loading = true;
  redraw();
  try {
    const payload = await api.get(sessionsUrl(0));
    if (requestId !== state.requestId) return;
    absorb(payload, true);
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.error = error?.message || 'The sessions could not be loaded.';
    state.requested.delete(0);
  } finally {
    if (requestId === state.requestId) {
      state.loading = false;
      redraw();
    }
  }
}

function changeCli(cli, api, redraw) {
  if (state.loading || state.cli === cli) return;
  state.cli = cli;
  loadFirstPage(api, redraw);
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
    const requestId = state.requestId ?? 0;
    const payload = await api.get(sessionsUrl(offset));
    if (requestId !== (state.requestId ?? 0)) return;
    absorb(payload, false);
    state.error = null;
  } catch (error) {
    // app.js's request helper has already turned a dead server into a
    // sentence a person can act on; it is shown verbatim.
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
  const filtered = filterRows(all);
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
          + 'The filters and the column sort below apply to the rows loaded so far, not to the whole scan. '
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
  head.append(toolbar(all, sorted, total, api, draw));
  card.append(head);
  card.append(drawTable(sorted, api, draw));
  const layout = el('div', 'session-layout');
  layout.append(filterPanel(all, api, draw));
  layout.append(card);
  if (state.selected) layout.append(detailPanel(state.selected, api, draw));
  stack.append(layout);

  if (!sorted.length) {
    stack.append(el('p', 'empty-state', 'No session loaded so far matches the filters you picked.'));
  }

  const strip = pager(api, draw);
  if (strip) stack.append(strip);
  mount.append(stack);
  observe(strip, api, draw);
}

/**
 * The Filters sidebar.  Every checkbox here changes the table; a control that
 * looks clickable and does nothing is a broken promise.  Counts next to each
 * choice are counts of LOADED rows carrying that property, so they describe
 * what ticking the box would match among the rows in hand.
 */
function filterPanel(all, api, redraw) {
  const filters = el('aside', 'rx-card filter-panel');
  const filterTitle = el('div', 'rx-section-title tone-accent');
  filterTitle.append(iconBadge('sessions'), el('h2', '', 'Filters'));
  filters.append(filterTitle);
  filters.append(el('p', 'filter-note', 'CLI counts describe the sessions matching in this scan.'));

  const cliGroup = el('div', 'filter-group');
  cliGroup.dataset.filter = 'cli';
  cliGroup.append(el('h3', '', 'CLI'));
  const facetCounts = Array.isArray(state.cliCounts)
    ? state.cliCounts
    : [...new Set(all.map((session) => session?.cli).filter((cli) => typeof cli === 'string' && cli))]
      .sort()
      .map((cli) => ({ cli, count: all.filter((session) => session?.cli === cli).length }));
  cliGroup.append(filterChoice('All sessions', Array.isArray(state.cliCounts) ? state.total ?? all.length : all.length, state.cli === 'all', () => {
    if (state.cli === 'all') redraw();
    else changeCli('all', api, redraw);
  }));
  facetCounts.filter((entry) => typeof entry?.cli === 'string' && entry.cli).forEach(({ cli, count }) => cliGroup.append(
    filterChoice(cli, count, state.cli === cli, () => changeCli(state.cli === cli ? 'all' : cli, api, redraw)),
  ));
  filters.append(cliGroup);

  const toggle = (set, key) => () => {
    if (set.has(key)) set.delete(key);
    else set.add(key);
    redraw();
  };

  const healthGroup = el('div', 'filter-group');
  healthGroup.dataset.filter = 'health';
  healthGroup.append(el('h3', '', 'Health status'));
  for (const choice of HEALTH_CHOICES) {
    healthGroup.append(filterChoice(choice.label, all.filter(choice.test).length, state.health.has(choice.key), toggle(state.health, choice.key)));
  }
  filters.append(healthGroup);

  const issueGroup = el('div', 'filter-group');
  issueGroup.dataset.filter = 'issue';
  issueGroup.append(el('h3', '', 'Issue type'));
  const issueCounts = new Map();
  all.forEach((session) => new Set(observedLabels(session)).forEach((label) => issueCounts.set(label, (issueCounts.get(label) || 0) + 1)));
  // A ticked issue stays listed even if no loaded row carries it any more, so
  // it can always be unticked.
  state.issues.forEach((label) => { if (!issueCounts.has(label)) issueCounts.set(label, 0); });
  const issues = [...issueCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!issues.length) issueGroup.append(el('p', 'filter-note', 'No problem was observed in the loaded rows.'));
  issues.forEach(([label, count]) => issueGroup.append(filterChoice(label, count, state.issues.has(label), toggle(state.issues, label))));
  filters.append(issueGroup);

  if (filtering()) {
    const clear = uiButton('Clear filters', 'button button-sm');
    clear.dataset.action = 'clear-filters';
    clear.addEventListener('click', () => {
      state.health.clear();
      state.issues.clear();
      if (state.cli === 'all') redraw();
      else changeCli('all', api, redraw);
    });
    filters.append(clear);
  }
  return filters;
}

function filterChoice(label, count, checked, onChange) {
  const row = el('label', 'filter-option');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', label);
  input.addEventListener('change', onChange);
  row.append(input, el('span', '', label), el('strong', '', String(count)));
  return row;
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

const DETAIL_TABS = [
  { key: 'diagnosis', label: 'Diagnosis' },
  { key: 'evidence', label: 'Evidence' },
  { key: 'metrics', label: 'Metrics' },
  { key: 'timeline', label: 'Timeline' },
];

/** A label/value row; a missing value is the explicit "Not measured" dash. */
function factRow(label, value, why) {
  const wrap = el('div');
  wrap.append(el('span', 'meta-label', label));
  const slot = el('span', 'meta-value');
  if (value === null || value === undefined) slot.append(notMeasured(why));
  else if (typeof value === 'string' || typeof value === 'number') slot.append(text(String(value)));
  else slot.append(value);
  wrap.append(slot);
  return wrap;
}

/** Whether SessionRx can offer a suggestion for the tool this session used. */
function fixScopeChip(session, rule) {
  if (rule?.suggestionAvailable) return el('span', 'rx-chip', `Suggested change for ${rule.suggestionToolName || rule.suggestionTool || 'this CLI'}`);
  const source = session?.cliName || session?.cli || 'this CLI';
  const chip = el('span', 'rx-chip rx-chip-muted', 'No suggested change');
  chip.title = `SessionRx has no suggested change for ${source}.`;
  return chip;
}

function diagnosisTab(session, api) {
  const box = el('div', 'tab-panel');
  const observed = (session?.rules || []).filter((rule) => rule?.evidence?.status === 'observed');
  const unknown = (session?.rules || []).filter((rule) => rule?.evidence?.status === 'unknown');
  box.append(el('h3', '', 'Findings'));
  if (!observed.length) {
    box.append(el('p', 'note', unknown.length
      ? 'No problem was observed among the checks that could run.'
      : 'Checks ran; no problems observed.'));
  }
  observed.forEach((rule) => {
    const row = el('div', 'fix-row');
    const level = severity(rule);
    row.append(el('span', 'rank', '!'), el('span', 'fix-title', ruleLabel(rule)), el('span', `severity ${level.toLowerCase()}`, level));
    box.append(row);
  });
  if (unknown.length) box.append(el('p', 'not-measured', `${unknown.length} check${unknown.length === 1 ? '' : 's'} could not be measured. They are not passes.`));
  const suggested = observed.filter((rule) => rule.fix);
  if (suggested.length) {
    box.append(el('h3', '', 'Suggested changes'));
    suggested.forEach((rule) => {
      const review = uiButton('View suggestion');
      review.disabled = !rule.suggestionAvailable;
      review.addEventListener('click', () => openSuggestionPanel({ id: rule.fix, toolId: rule.suggestionTool, title: rule.suggestionTitle || ruleLabel(rule), api }));
      const row = el('div', 'fix-row');
      row.append(el('span', 'fix-title', ruleLabel(rule)), fixScopeChip(session, rule), review);
      box.append(row);
    });
  }
  return box;
}

/** Every rule with its numbers, threshold and — for an unknown — its reason. */
function evidenceTab(session, api, redraw) {
  const box = el('div', 'tab-panel');
  box.append(el('p', 'note', 'Every check, with the numbers it measured. Open a check to see its threshold and where the numbers came from.'));
  box.append(verdictList(session, api, redraw));
  return box;
}

function metricsTab(session) {
  const box = el('div', 'tab-panel');
  const grid = el('div', 'meta-grid');
  const turns = Number.isFinite(session?.turnCount) ? groupInt(session.turnCount) : null;
  const subSessions = Array.isArray(session?.subagentSessions) ? session.subagentSessions.length : null;
  grid.append(
    factRow('turns', turns, 'no turn count was recorded'),
    factRow('duration', durationText(session?.startedAt, session?.endedAt), 'the session start or end was not recorded'),
    factRow('model', session?.model ?? null, 'no model id was recorded'),
    factRow('context window', windowValueNode(session?.window)),
    factRow('sub-agent turns', subagentTurnsNode(session)),
    factRow('sub-agent sessions', subSessions === null ? null : groupInt(subSessions), 'the collector did not report sub-agent sessions'),
  );
  box.append(grid);
  box.append(scoreNode(session?.score, session?.rules));
  return box;
}

/**
 * What happened when.  The sessions API carries start/end times for the
 * session and each sub-agent session, not per-turn records, so that is what is
 * drawn — and the page says the turn-by-turn view is not measured rather than
 * leaving the gap unexplained.
 */
function timelineTab(session) {
  const box = el('div', 'tab-panel');
  const events = [];
  const add = (iso, label) => {
    const ms = Date.parse(iso ?? '');
    if (Number.isFinite(ms)) events.push({ ms, iso, label });
  };
  add(session?.startedAt, 'Session started');
  (Array.isArray(session?.subagentSessions) ? session.subagentSessions : []).forEach((sub, index) => {
    const name = `Sub-agent ${index + 1}${Number.isFinite(sub?.turnCount) ? ` (${groupInt(sub.turnCount)} turns)` : ''}`;
    add(sub?.startedAt, `${name} started`);
    add(sub?.endedAt, `${name} finished`);
  });
  add(session?.endedAt, 'Session ended');
  events.sort((a, b) => a.ms - b.ms);

  if (!events.length) box.append(el('p', 'not-measured', 'Not measured — this session recorded no start or end time.'));
  else {
    const list = el('ol', 'timeline-list');
    events.forEach((event) => {
      const item = el('li');
      item.append(el('span', 'session-date', whenText(event.iso) ?? event.iso), text(` — ${event.label}`));
      list.append(item);
    });
    box.append(list);
    if (!session?.endedAt) box.append(el('p', 'not-measured', 'Session end: not measured.'));
  }
  box.append(el('p', 'note', 'Turn-by-turn timeline: not measured. This page receives session and sub-agent times, not the individual turns.'));
  return box;
}

function detailPanel(session, api, redraw) {
  const panel = el('aside', 'rx-card detail-panel');
  const close = uiButton('Close', 'button button-quiet');
  close.addEventListener('click', () => { state.selected = null; redraw(); });
  const head = el('div', 'rx-card-head');
  const title = el('div', 'rx-section-title tone-accent');
  title.append(iconBadge('sessions'), el('h2', '', 'Session details'));
  head.append(title, close);
  panel.append(head);
  const identity = el('div');
  identity.append(cliIcon(session?.cliName || session?.cli), el('strong', '', ` ${session?.cliName || session?.cli || 'Unknown CLI'}`));
  panel.append(
    identity,
    el('p', 'rx-label', dateText(session?.startedAt)),
    el('p', 'rx-label', `${duration(session?.startedAt, session?.endedAt)} · ${Number.isFinite(session?.turnCount) ? session.turnCount : 'not measured'} turns`),
    healthNode(session?.score),
  );

  const active = DETAIL_TABS.some((tab) => tab.key === state.detailTab) ? state.detailTab : 'diagnosis';
  const tabs = el('div', 'tab-strip');
  tabs.setAttribute('role', 'tablist');
  DETAIL_TABS.forEach(({ key, label }) => {
    const tab = uiButton(label, 'tab-button');
    tab.dataset.tab = key;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', key === active ? 'true' : 'false');
    if (key === active) tab.classList.add('is-active');
    tab.addEventListener('click', () => { state.detailTab = key; redraw(); });
    tabs.append(tab);
  });
  panel.append(tabs);

  const content = active === 'evidence' ? evidenceTab(session, api, redraw)
    : active === 'metrics' ? metricsTab(session)
      : active === 'timeline' ? timelineTab(session)
        : diagnosisTab(session, api);
  content.dataset.tab = active;
  content.setAttribute('role', 'tabpanel');
  panel.append(content);
  return panel;
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
    state.cli = 'all';
    state.health.clear();
    state.issues.clear();
    state.error = null;
    absorb(data ?? {}, true);
  }
  draw();
}

registerPage('sessions', renderSessions);

export default renderSessions;
