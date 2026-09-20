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

/** Sort, filter and expansion state survive a re-render; the data does not. */
const state = {
  sortKey: 'date',
  order: 'desc',
  cli: 'all',
  expanded: new Set(),
  mount: null,
  data: null,
  ctx: {},
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
    key: 'cacheRead',
    label: 'Cache read',
    type: 'number',
    num: true,
    // The analyzer's own evidence, not a recount: `cache-hit` reports the summed
    // cache reads whenever it could measure them at all.
    value: (session) => {
      const value = evidenceValueByLabel(ruleById(session, 'cache-hit'), 'cache reads');
      return Number.isFinite(value?.value) ? value.value : null;
    },
    cell: (session) => {
      const td = el('td', 'num');
      const rule = ruleById(session, 'cache-hit');
      const value = evidenceValueByLabel(rule, 'cache reads');
      if (value) td.append(evidenceValueNode(value));
      else td.append(notMeasured(rule?.evidence?.reason ?? 'no cache counter was recorded for this session'));
      return td;
    },
  },
  {
    key: 'avgContext',
    label: 'Avg context',
    type: 'number',
    num: true,
    // Two honest shapes: absolute tokens, or — for a CLI that reports only a
    // fraction (DIS-005) — the native fraction. They are not mixed on one
    // scale: the fraction sorts on its own 0..1 range and the cell says which
    // it is, because 0.42 and 42,000 are not comparable numbers.
    value: (session) => {
      const rule = ruleById(session, 'context-pressure');
      const tokens = evidenceValueByLabel(rule, 'average per-turn context');
      if (Number.isFinite(tokens?.value)) return tokens.value;
      const fraction = evidenceValueByLabel(rule, 'average native context fraction reported by the CLI');
      return Number.isFinite(fraction?.value) ? fraction.value : null;
    },
    cell: (session) => {
      const td = el('td', 'num');
      const rule = ruleById(session, 'context-pressure');
      const tokens = evidenceValueByLabel(rule, 'average per-turn context');
      if (tokens) {
        td.append(evidenceValueNode(tokens));
        return td;
      }
      const fraction = evidenceValueByLabel(rule, 'average native context fraction reported by the CLI');
      if (fraction) {
        td.append(evidenceValueNode(fraction));
        td.append(el('span', 'inferred-tag', 'share, not tokens'));
        return td;
      }
      td.append(notMeasured(rule?.evidence?.reason ?? 'no context reading was recorded for this session'));
      return td;
    },
  },
  {
    key: 'score',
    label: 'Health score',
    type: 'number',
    num: true,
    // Passed count is the sort key. An unknown is NOT counted as passed, so a
    // session with four passes and two unmeasurable checks never outranks a
    // session with six measured passes.
    value: (session) => (Number.isFinite(session?.score?.passed) ? session.score.passed : null),
    cell: (session) => {
      const td = el('td', 'num');
      const score = session?.score ?? {};
      const total = Number.isFinite(score?.total) ? score.total : 0;
      const passed = Number.isFinite(score?.passed) ? score.passed : null;
      const unknown = Number.isFinite(score?.unknown) ? score.unknown : 0;
      if (passed === null) {
        td.append(notMeasured('no rule was scored for this session'));
        return td;
      }
      td.append(el('strong', null, `${passed}/${total}`));
      if (unknown > 0) {
        const badge = el('span', 'badge badge-sm badge-unknown', `${unknown} unknown`);
        badge.setAttribute('title', `${unknown} check(s) could not be measured. They are not passes.`);
        td.append(badge);
      }
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

/** CLI filter and the sort reset, plus the honest row count. */
function toolbar(sessions, shown, redraw) {
  const bar = el('div', 'toolbar');

  const label = el('label', 'toolbar-filter');
  label.append(el('span', 'meta-label', 'CLI'));
  const select = el('select');
  select.setAttribute('aria-label', 'Filter sessions by CLI');
  const clis = [...new Set(sessions.map((session) => session?.cli).filter((cli) => typeof cli === 'string' && cli))].sort();
  const option = (value, caption) => {
    const node = el('option', null, caption);
    node.value = value;
    if (state.cli === value) node.selected = true;
    return node;
  };
  select.append(option('all', `All CLIs (${sessions.length})`));
  for (const cli of clis) {
    const count = sessions.filter((session) => session?.cli === cli).length;
    select.append(option(cli, `${cli} (${count})`));
  }
  select.addEventListener('change', () => {
    state.cli = select.value;
    redraw();
  });
  label.append(select);
  bar.append(label);

  bar.append(el('span', 'toolbar-spacer'));

  const column = COLUMN_BY_KEY.get(state.sortKey);
  bar.append(
    el(
      'span',
      'chart-sub',
      `${shown.length} of ${sessions.length} shown · sorted by ${column?.label ?? 'date'} ${state.order === 'asc' ? 'ascending' : 'descending'}`,
    ),
  );
  return bar;
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
  const all = Array.isArray(data?.sessions) ? data.sessions : [];
  const filtered = state.cli === 'all' ? all : all.filter((session) => session?.cli === state.cli);
  const sorted = sortRows(filtered);

  mount.replaceChildren();
  const stack = el('div', 'page-stack');
  const title = el('h1', null, 'Sessions');
  title.id = 'sessions-title';
  stack.append(title);

  const total = Number.isFinite(data?.total) ? data.total : all.length;
  stack.append(
    el(
      'p',
      'note',
      `${groupInt(all.length) ?? '0'} session${all.length === 1 ? '' : 's'} returned of ${groupInt(total) ?? '0'} matched in this scan. `
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
    return;
  }

  const card = el('section', 'card');
  const head = el('div', 'card-head');
  head.append(toolbar(all, sorted, draw));
  card.append(head);
  card.append(drawTable(sorted, api, draw));
  stack.append(card);

  if (!sorted.length) {
    stack.append(el('p', 'empty-state', `No session in this scan came from ${state.cli}.`));
  }
  mount.append(stack);
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
  draw();
}

registerPage('sessions', renderSessions);

export default renderSessions;
