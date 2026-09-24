/**
 * BP-001.25 — Trends page: G1 context efficiency, G2 token spend, G3 cache hit
 * rate with zones, G4 a 15x24 activity heatmap.
 *
 * THE ONE RULE THIS FILE EXISTS TO HOLD
 * -------------------------------------
 * `buildTrends` returns `null` for every day it could not measure, and `null`
 * is NOT zero.  A zero plotted through a gap invents a trend: a quiet line
 * across five unmeasured days reads as "context was low that week", when what
 * actually happened is that nothing was read.  So:
 *
 *   - every series is handed to Chart.js with its `null`s intact, never
 *     `?? 0`, and every line dataset sets `spanGaps: false`, so the line
 *     BREAKS at a gap instead of being drawn through it;
 *   - the legend names the break, so a reader knows a gap is a gap;
 *   - a heatmap row for a day with no data at all is `.is-null` (hatched),
 *     visually distinct from a measured hour of zero turns (`data-level="0"`);
 *   - the number of turns excluded from G1 for having no computable fraction is
 *     printed next to G1, so its denominator is visibly honest;
 *   - `trend.direction === 'unknown'` renders as its own third state with the
 *     analyzer's `reason`, never as "stable";
 *   - the verdict's plain-language lead is `trend.summary`, written once by
 *     `src/analyzer/trends.js` and rendered here VERBATIM — this file keeps
 *     no second copy of that wording (BP-005.19; F-021 is what happens when a
 *     page keeps its own catalogue of analyzer text instead).
 *
 * Charts are drawn by wave 5C's wrapper (BP-001.30), which owns the vendored
 * Chart.js instance.  Every chart ALSO ships a `<details>` data table built
 * from the same rows: it is the accessible view, and it is what the page falls
 * back to if the canvas cannot be drawn — a chart that failed must not become a
 * page that says nothing.
 *
 * SECURITY: no `innerHTML` in this file.  Every string reaches the DOM via
 * `textContent` (through `el`/`text`) or `setAttribute`.
 *
 * @module public/js/pages/trends
 */

import { registerPage } from '../app.js';
import { renderChart, destroyChart } from '../components/chart.js';
import { icon } from '../components/ui.js';

/** Canvases handed to the chart wrapper, destroyed before each re-render. */
const liveCanvases = new Set();

/** Zone thresholds are the analyzer's (`thresholds.cacheZones`); these are the words. */
const ZONE_WORDS = Object.freeze({
  green: 'green — above 95%',
  yellow: 'yellow — 85% to 95%',
  red: 'red — below 85%',
});

const DIRECTION_KIND = Object.freeze({
  improving: 'ok',
  declining: 'warn',
  stable: 'info',
  unknown: 'unknown',
});

function iconBadge(name) {
  const badge = el('span', 'rx-icon');
  badge.append(icon(name));
  return badge;
}

function sectionTitle(title, iconName, tone = 'accent') {
  const node = el('div', `rx-section-title tone-${tone}`);
  node.append(iconBadge(iconName), el('h2', '', title));
  return node;
}

// ---------------------------------------------------------------------------
// DOM helpers — the only path text takes into the document
// ---------------------------------------------------------------------------

/** Build an element. `textContent` is assigned, never parsed as HTML. */
function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined && textContent !== null) node.textContent = String(textContent);
  return node;
}

/** A text node: content, never markup. */
function text(value) {
  return document.createTextNode(value === undefined || value === null ? '' : String(value));
}

/** The rendering of an absent measurement. Never a 0. */
function notMeasured(why = 'this day carried no reading') {
  const node = el('span', 'not-measured');
  node.append(el('span', 'dash', '—'), text(' not measured'));
  node.setAttribute('title', why);
  node.setAttribute('aria-label', `not measured: ${why}`);
  return node;
}

function groupInt(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString('en-US') : null;
}

/** A number for a table cell, or `.not-measured`. `suffix` is appended only to a real number. */
function numberCell(value, suffix = '', why = undefined) {
  const cell = el('td', 'num');
  if (!Number.isFinite(value)) cell.append(notMeasured(why));
  else cell.append(text(`${groupInt(value)}${suffix}`));
  return cell;
}

/** Read a CSS custom property. Returns `null` when the token is not defined. */
function token(name) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || null;
  } catch {
    return null;
  }
}

function callout(kind, title, body, detail) {
  const box = el('div', `callout callout-${kind}`);
  if (title) box.append(el('p', 'callout-title', title));
  if (body) box.append(el('p', null, body));
  if (detail) box.append(el('p', 'callout-detail', detail));
  return box;
}

/** `MM-DD` from a `YYYY-MM-DD` day key, for a cramped axis. */
function shortDay(key) {
  return typeof key === 'string' && key.length >= 10 ? key.slice(5) : String(key ?? '');
}

// ---------------------------------------------------------------------------
// Chart shell
// ---------------------------------------------------------------------------

/**
 * A `.chart-container` with a head, a canvas handed to wave 5C's wrapper, a
 * legend, and a data table.
 *
 * The table is not a fallback bolted on: it is rendered unconditionally, so the
 * numbers are readable without a canvas, by a screen reader, and when the chart
 * wrapper throws.
 *
 * @param {{id: string, title: string, sub?: string, config: object,
 *   legend?: Array<{swatch: string, caption: string}>, table: HTMLElement,
 *   emptyReason?: string|null, note?: string|null}} spec
 * @returns {HTMLElement}
 */
function chartCard(spec) {
  const container = el('section', 'chart-container');
  container.dataset.chart = spec.id;

  const head = el('div', 'chart-head');
  head.append(sectionTitle(spec.title, 'trends'));
  if (spec.sub) head.append(el('span', 'chart-sub', spec.sub));
  container.append(head);

  if (spec.emptyReason) {
    // Nothing measurable at all: say so in the chart's own space rather than
    // drawing an empty axis that looks like a flat, healthy line.
    container.append(el('div', 'chart-empty', spec.emptyReason));
  } else {
    const wrap = el('div', 'chart-canvas-wrap');
    const canvas = el('canvas');
    canvas.id = `chart-${spec.id}`;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${spec.title}. The same numbers are in the table below this chart.`);
    wrap.append(canvas);
    container.append(wrap);
    try {
      renderChart(canvas, spec.config);
      liveCanvases.add(canvas);
    } catch (error) {
      wrap.replaceChildren(
        el(
          'div',
          'chart-empty',
          `This chart could not be drawn (${error instanceof Error ? error.message : String(error)}). The numbers are in the table below, unchanged.`,
        ),
      );
    }
  }

  if (Array.isArray(spec.legend) && spec.legend.length) {
    const legend = el('div', 'chart-legend');
    for (const entry of spec.legend) {
      const item = el('span');
      item.append(el('i', `legend-swatch ${entry.swatch}`.trim()), text(entry.caption));
      legend.append(item);
    }
    container.append(legend);
  }

  if (spec.note) container.append(el('p', 'note', spec.note));

  const details = el('details');
  details.append(el('summary', null, 'Show the numbers'));
  details.append(spec.table);
  container.append(details);
  return container;
}

/** A `.table-wrap` table from header labels and pre-built rows. */
function dataTable(headers, rows) {
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const header of headers) {
    const th = el('th', header.num ? 'num' : null, header.label);
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  const tbody = el('tbody');
  for (const row of rows) tbody.append(row);
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

// ---------------------------------------------------------------------------
// G1 — context efficiency
// ---------------------------------------------------------------------------

/**
 * Two series on two axes: average context per turn (tokens) and the share of
 * turns above 70% of the window (percent).
 *
 * Both arrays carry their `null`s straight through.  `spanGaps: false` is set
 * explicitly rather than relied on as a default, because this is the single
 * property that stops the line being drawn across an unmeasured day.
 */
function contextChart(trends) {
  const rows = Array.isArray(trends?.charts?.context) ? trends.charts.context : [];
  const days = rows.map((row) => shortDay(row?.date));
  const avg = rows.map((row) => (Number.isFinite(row?.avgContextPerTurn) ? row.avgContextPerTurn : null));
  const high = rows.map((row) => (Number.isFinite(row?.highContextPct) ? row.highContextPct : null));
  const measuredAvg = avg.filter((value) => value !== null).length;
  const measuredHigh = high.filter((value) => value !== null).length;
  const threshold = Number.isFinite(trends?.thresholds?.highContextFraction)
    ? Math.round(trends.thresholds.highContextFraction * 100)
    : 70;

  const excludedFraction = Number.isFinite(trends?.excluded?.turnsWithoutComputableFraction)
    ? trends.excluded.turnsWithoutComputableFraction
    : 0;
  const excludedNoContext = Number.isFinite(trends?.excluded?.turnsWithoutContextReading)
    ? trends.excluded.turnsWithoutContextReading
    : 0;

  const config = {
    type: 'line',
    data: {
      labels: days,
      datasets: [
        {
          label: 'Avg context per turn (tokens)',
          data: avg,
          yAxisID: 'y',
          spanGaps: false,
          tension: 0.25,
          pointRadius: 3,
        },
        {
          label: `Turns above ${threshold}% full (%)`,
          data: high,
          yAxisID: 'yPct',
          spanGaps: false,
          tension: 0.25,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'tokens' } },
        yPct: {
          position: 'right',
          beginAtZero: true,
          max: 100,
          grid: { drawOnChartArea: false },
          title: { display: true, text: `% of turns above ${threshold}%` },
        },
      },
    },
  };

  const tableRows = rows.map((row) => {
    const tr = el('tr');
    tr.append(el('td', null, row?.date ?? ''));
    tr.append(numberCell(row?.avgContextPerTurn, '', 'no turn on this day reported a context figure'));
    tr.append(
      numberCell(
        row?.highContextPct,
        '%',
        'no turn on this day had a computable context fraction, so there is no share to report',
      ),
    );
    tr.append(numberCell(row?.turns));
    tr.append(numberCell(row?.turnsWithFraction));
    tr.append(numberCell(row?.turnsWithoutFraction));
    return tr;
  });

  const note =
    `${groupInt(excludedFraction)} turn${excludedFraction === 1 ? '' : 's'} measured context the window could not divide, `
    + `and ${groupInt(excludedNoContext)} reported no context at all. `
    + `All of them are excluded from BOTH sides of the "above ${threshold}%" ratio — not counted as low — so the `
    + 'percentage is worked out only from the turns that did have a share we could compute.';

  return chartCard({
    id: 'g1-context',
    title: 'G1 · How full the conversation got',
    sub: `${measuredAvg}/${rows.length} days with a context reading · ${measuredHigh}/${rows.length} with a computable share`,
    config,
    legend: [{ swatch: 'legend-swatch-gap', caption: 'a break in the line is a day that was not measured, not a zero' }],
    note,
    emptyReason:
      measuredAvg === 0 && measuredHigh === 0
        ? 'No day in this window carried a context reading, so there is nothing to plot. That is an empty read, not low context.'
        : null,
    table: dataTable(
      [
        { label: 'Day' },
        { label: 'Avg context / turn', num: true },
        { label: `Turns > ${threshold}%`, num: true },
        { label: 'Turns', num: true },
        { label: 'With a fraction', num: true },
        { label: 'Without one', num: true },
      ],
      tableRows,
    ),
  });
}

// ---------------------------------------------------------------------------
// G2 — token spend
// ---------------------------------------------------------------------------

/**
 * Cache read and cache creation, stacked.  An unmeasured component stays
 * `null`, so its bar segment is absent rather than drawn as a zero-height
 * segment that reads as "no spend".
 */
function spendChart(trends) {
  const rows = Array.isArray(trends?.charts?.spend) ? trends.charts.spend : [];
  const days = rows.map((row) => shortDay(row?.date));
  const read = rows.map((row) => (Number.isFinite(row?.cacheRead) ? row.cacheRead : null));
  const created = rows.map((row) => (Number.isFinite(row?.cacheCreation) ? row.cacheCreation : null));
  const measured = rows.filter((row) => Number.isFinite(row?.cacheRead) || Number.isFinite(row?.cacheCreation)).length;

  const config = {
    type: 'bar',
    data: {
      labels: days,
      datasets: [
        { label: 'Cache read (tokens)', data: read, stack: 'spend' },
        { label: 'Cache creation (tokens)', data: created, stack: 'spend' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'tokens' } },
      },
    },
  };

  const tableRows = rows.map((row) => {
    const tr = el('tr');
    tr.append(el('td', null, row?.date ?? ''));
    tr.append(numberCell(row?.cacheRead, '', 'no turn on this day carried a cache-read count'));
    tr.append(numberCell(row?.cacheCreation, '', 'no turn on this day carried a cache-creation count'));
    tr.append(
      numberCell(
        row?.total,
        '',
        'only one side of the pair was read, so a total would be an undercount presented as a total',
      ),
    );
    return tr;
  });

  return chartCard({
    id: 'g2-spend',
    title: 'G2 · Text used (tokens)',
    sub: `${measured}/${rows.length} days with a cache reading`,
    config,
    legend: [{ swatch: 'legend-swatch-gap', caption: 'a missing bar is a day with no cache counter, not a day of no spend' }],
    note:
      'The daily total appears only where BOTH cache read and cache creation were read. One measured side plus one absent '
      + 'side would be an undercount presented as a total.',
    emptyReason:
      measured === 0
        ? 'No day in this window carried a cache counter, so there is nothing to plot. That is not zero spend.'
        : null,
    table: dataTable(
      [
        { label: 'Day' },
        { label: 'Cache read', num: true },
        { label: 'Cache creation', num: true },
        { label: 'Total', num: true },
      ],
      tableRows,
    ),
  });
}

// ---------------------------------------------------------------------------
// G3 — cache hit rate with zones
// ---------------------------------------------------------------------------

/**
 * Cache hit rate, with each measured point coloured by the analyzer's own zone
 * verdict (green above 95, yellow 85..95, red below 85).  A day with no rate
 * has no zone and no point, and the line breaks there.
 *
 * Point colours come from the `--zone-*` custom properties rather than literals;
 * if a token is not defined the option is omitted entirely rather than
 * substituted with a guess.
 */
function cacheChart(trends) {
  const rows = Array.isArray(trends?.charts?.cache) ? trends.charts.cache : [];
  const days = rows.map((row) => shortDay(row?.date));
  const rates = rows.map((row) => (Number.isFinite(row?.hitRate) ? row.hitRate : null));
  const measured = rates.filter((value) => value !== null).length;
  const zones = { green: 0, yellow: 0, red: 0 };
  for (const row of rows) if (row?.zone && zones[row.zone] !== undefined) zones[row.zone] += 1;
  const noZone = rows.length - (zones.green + zones.yellow + zones.red);

  const zoneColors = { green: token('--zone-green'), yellow: token('--zone-yellow'), red: token('--zone-red') };
  const pointColors = rows.map((row) => (row?.zone ? zoneColors[row.zone] : null));
  const colorsResolved = Object.values(zoneColors).every((value) => typeof value === 'string' && value);

  const dataset = {
    label: 'Reused content (%)',
    data: rates,
    spanGaps: false,
    tension: 0.2,
    pointRadius: 4,
  };
  if (colorsResolved) {
    dataset.pointBackgroundColor = pointColors;
    dataset.pointBorderColor = pointColors;
  }

  const config = {
    type: 'line',
    data: { labels: days, datasets: [dataset] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { y: { min: 0, max: 100, title: { display: true, text: '% of cache tokens read' } } },
    },
  };

  const tableRows = rows.map((row) => {
    const tr = el('tr');
    tr.append(el('td', null, row?.date ?? ''));
    tr.append(
      numberCell(
        row?.hitRate,
        '%',
        'both cache counters must be read for a rate to exist; treating an unread creation figure as zero would report a flawless 100%',
      ),
    );
    const zoneCell = el('td');
    if (row?.zone) {
      const badgeClass = row.zone === 'green' ? 'badge-ok' : row.zone === 'yellow' ? 'badge-warn' : 'badge-critical';
      zoneCell.append(el('span', `badge badge-sm ${badgeClass}`, row.zone));
    } else {
      zoneCell.append(notMeasured('no rate, so no zone'));
    }
    tr.append(zoneCell);
    tr.append(numberCell(row?.cacheRead, '', 'no cache-read count on this day'));
    tr.append(numberCell(row?.cacheCreation, '', 'no cache-creation count on this day'));
    return tr;
  });

  return chartCard({
    id: 'g3-cache',
    title: 'G3 · Reused vs rebuilt content',
    sub: `${measured}/${rows.length} days with a rate`,
    config,
    legend: [
      { swatch: 'legend-swatch-green', caption: `${ZONE_WORDS.green} (${zones.green} day${zones.green === 1 ? '' : 's'})` },
      { swatch: 'legend-swatch-yellow', caption: `${ZONE_WORDS.yellow} (${zones.yellow} day${zones.yellow === 1 ? '' : 's'})` },
      { swatch: 'legend-swatch-red', caption: `${ZONE_WORDS.red} (${zones.red} day${zones.red === 1 ? '' : 's'})` },
      { swatch: 'legend-swatch-gap', caption: `no rate, so no zone (${noZone} day${noZone === 1 ? '' : 's'})` },
    ],
    note:
      'A rate exists only where both cache counters were read and their sum is above zero. 0/0 is not a hit rate, and an '
      + 'unread creation figure treated as zero would report a flawless 100%.',
    emptyReason:
      measured === 0
        ? 'No day in this window had a reuse rate to measure, so there is nothing to plot and no zone to report.'
        : null,
    table: dataTable(
      [
        { label: 'Day' },
        { label: 'Hit rate', num: true },
        { label: 'Zone' },
        { label: 'Cache read', num: true },
        { label: 'Cache creation', num: true },
      ],
      tableRows,
    ),
  });
}

// ---------------------------------------------------------------------------
// G4 — activity heatmap
// ---------------------------------------------------------------------------

/**
 * The 15-day x 24-hour activity grid, laid out day-major to match
 * `heatmap.grid[dayIndex][hour]` and wave 5C's CSS (rows are days, columns are
 * hours, column count driven by `--heatmap-cols`).
 *
 * A cell is `null` only when the whole day carried no activity, and a day with
 * no activity cannot be told apart from a day the collectors never covered.
 * Those cells are `.is-null` (hatched) and carry no `data-level`, so they are
 * never the same pixel as a measured hour of zero turns (`data-level="0"`).
 */
function heatmapCard(trends) {
  const heatmap = trends?.heatmap ?? {};
  const grid = Array.isArray(heatmap?.grid) ? heatmap.grid : [];
  const days = Array.isArray(heatmap?.days) ? heatmap.days : [];
  const hours = Array.isArray(heatmap?.hours) ? heatmap.hours : [];
  const cols = Number.isFinite(heatmap?.cols) ? heatmap.cols : hours.length || 24;
  const maxCell = Number.isFinite(heatmap?.maxCell) ? heatmap.maxCell : 0;
  const daysWithoutData = Number.isFinite(heatmap?.daysWithoutData) ? heatmap.daysWithoutData : 0;

  const wrap = el('section', 'heatmap-wrap');
  wrap.dataset.chart = 'g4-activity';
  const head = el('div', 'chart-head');
  head.append(el('span', 'chart-title', 'G4 · Activity'));
  head.append(
    el(
      'span',
      'chart-sub',
      `${days.length} days × ${cols} local hours · ${groupInt(heatmap?.placedTurns) ?? '0'} turns placed`,
    ),
  );
  wrap.append(head);

  if (!grid.length) {
    wrap.append(el('div', 'chart-empty', 'No activity grid was built for this window.'));
    return wrap;
  }

  const layout = el('div', 'heatmap-layout');

  const dayLabels = el('div', 'heatmap-days');
  for (const day of days) dayLabels.append(el('span', null, shortDay(day)));
  layout.append(dayLabels);

  const scroll = el('div', 'heatmap-scroll');
  const cells = el('div', 'heatmap');
  cells.style.setProperty('--heatmap-cols', String(cols));
  cells.setAttribute('role', 'img');
  cells.setAttribute(
    'aria-label',
    `Turns per local hour across ${days.length} days. ${daysWithoutData} day(s) carried no data at all and are hatched rather than shown as quiet.`,
  );
  for (let dayIndex = 0; dayIndex < grid.length; dayIndex += 1) {
    const row = Array.isArray(grid[dayIndex]) ? grid[dayIndex] : [];
    const dayKey = days[dayIndex] ?? `day ${dayIndex + 1}`;
    for (let hour = 0; hour < cols; hour += 1) {
      const count = row[hour];
      const cell = el('div', 'heatmap-cell');
      const hourLabel = String(hours[hour] ?? hour).padStart(2, '0');
      if (count === null || count === undefined) {
        // Not zero: this day was never covered, so no hour of it is a reading.
        cell.classList.add('is-null');
        cell.setAttribute('title', `${dayKey} ${hourLabel}:00 — no data collected for this day (not zero turns)`);
      } else {
        const level = count <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((count / Math.max(1, maxCell)) * 4)));
        cell.dataset.level = String(level);
        cell.setAttribute('title', `${dayKey} ${hourLabel}:00 — ${count} turn${count === 1 ? '' : 's'}`);
      }
      cells.append(cell);
    }
  }
  scroll.append(cells);

  const axis = el('div', 'heatmap-axis');
  axis.style.setProperty('--heatmap-cols', String(cols));
  for (let hour = 0; hour < cols; hour += 1) {
    axis.append(el('span', null, hour % 3 === 0 ? String(hours[hour] ?? hour).padStart(2, '0') : ''));
  }
  scroll.append(axis);
  layout.append(scroll);
  wrap.append(layout);

  const scale = el('div', 'heatmap-scale');
  scale.append(text('fewer'));
  const steps = el('div', 'heatmap-scale-steps');
  for (let level = 0; level <= 4; level += 1) {
    const step = el('i', 'heatmap-cell');
    step.dataset.level = String(level);
    steps.append(step);
  }
  scale.append(steps);
  scale.append(text(`more (peak ${groupInt(maxCell) ?? '0'} turns in one hour)`));
  const gap = el('i', 'heatmap-cell is-null');
  gap.setAttribute('title', 'a day with no data at all');
  scale.append(text(' · '));
  scale.append(gap);
  scale.append(text(`no data (${daysWithoutData} day${daysWithoutData === 1 ? '' : 's'})`));
  wrap.append(scale);

  if (Number.isFinite(trends?.excluded?.turnsWithoutTimestamp) && trends.excluded.turnsWithoutTimestamp > 0) {
    wrap.append(
      el(
        'p',
        'note',
        `${groupInt(trends.excluded.turnsWithoutTimestamp)} turn(s) carried no usable timestamp and appear in no cell. `
          + 'Guessing their hour from the session start would pile a whole session into one bucket.',
      ),
    );
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Trend verdict and the unknowns ledger
// ---------------------------------------------------------------------------

/**
 * The one verdict the page states.  `unknown` is a third state here as much
 * as it is on a rule: it renders as `.callout-unknown`, it says it is not
 * "stable", and its statistical detail carries the analyzer's reason
 * verbatim.
 *
 * The lead is `trend.summary` — one plain-English sentence written by
 * `src/analyzer/trends.js`, next to the verdict it describes.  This page
 * renders it as-is and builds NO second copy of the wording: BP-005.19
 * records what happened the last time a page kept its own catalogue of
 * analyzer text (F-021), and the fix there is the rule here too. Everything
 * that follows — the direction badge, the analyzer's own `reason`, and the
 * per-metric table — is the statistical evidence FOR that sentence, kept
 * available but out of the way in a native `<details>`.
 */
function verdictCard(trends) {
  const trend = trends?.trend ?? {};
  const direction = typeof trend?.direction === 'string' ? trend.direction : 'unknown';
  const kind = DIRECTION_KIND[direction] ?? 'unknown';
  const summary =
    typeof trend?.summary === 'string' && trend.summary.trim()
      ? trend.summary.trim()
      : 'The analyzer recorded no plain-language summary for this window.';

  const card = el('section', 'card card-pad');
  card.dataset.direction = direction;
  card.append(sectionTitle('Verdict', 'trends'));
  card.append(callout(kind, summary));

  const details = el('details', 'verdict-statistical-detail');
  details.append(el('summary', null, 'Show the statistical detail'));

  const headline =
    direction === 'unknown'
      ? 'Direction could not be determined — this is NOT "stable"'
      : `Direction: ${direction}`;
  details.append(
    callout(
      kind,
      headline,
      direction === 'unknown'
        ? 'Nothing here says your sessions held steady. It says the window did not carry enough measured days to decide, or the two metrics disagreed.'
        : null,
      trend?.reason || 'the analyzer recorded no reason.',
    ),
  );

  const assessments = Array.isArray(trend?.assessments) ? trend.assessments : [];
  if (assessments.length) {
    const rows = assessments.map((assessment) => {
      const tr = el('tr');
      tr.append(el('td', null, assessment?.label ?? 'metric'));
      const verdict = el('td');
      const decidable = assessment?.decidable === true;
      const dir = typeof assessment?.direction === 'string' ? assessment.direction : 'unknown';
      const badgeClass = !decidable || dir === 'unknown'
        ? 'badge-unknown'
        : dir === 'declining'
          ? 'badge-warn'
          : dir === 'improving'
            ? 'badge-ok'
            : 'badge-info';
      verdict.append(el('span', `badge badge-sm ${badgeClass}`, decidable ? dir : 'not decidable'));
      tr.append(verdict);
      tr.append(numberCell(assessment?.from, assessment?.unit === 'percent' ? '%' : '', 'too few measured days to form a first half'));
      tr.append(numberCell(assessment?.to, assessment?.unit === 'percent' ? '%' : '', 'too few measured days to form a second half'));
      tr.append(numberCell(assessment?.measuredDays));
      const source = el('td');
      if (assessment?.windowSource) {
        source.append(el('span', 'badge badge-sm badge-unknown', assessment.windowSource));
      } else {
        source.append(notMeasured('the contributing sessions did not agree on one window source'));
      }
      tr.append(source);
      tr.append(el('td', null, assessment?.detail ?? ''));
      return tr;
    });
    details.append(
      dataTable(
        [
          { label: 'Metric' },
          { label: 'Verdict' },
          { label: 'First half', num: true },
          { label: 'Second half', num: true },
          { label: 'Measured days', num: true },
          { label: 'Window source' },
          { label: 'How it was decided' },
        ],
        rows,
      ),
    );
  }
  card.append(details);
  return card;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Render the trends page (BP-001.25).
 *
 * @param {HTMLElement} mount the `#page-trends` section
 * @param {object} data the `/api/trends` body (BP-005.04)
 * @returns {void}
 */
export function renderTrends(mount, data) {
  if (!mount) return;

  // Chart.js holds a reference per canvas; the previous render's canvases are
  // about to be discarded, so they are destroyed rather than leaked.
  for (const canvas of liveCanvases) {
    try {
      destroyChart(canvas);
    } catch {
      // A wrapper that cannot destroy a chart must not stop the page rendering.
    }
  }
  liveCanvases.clear();
  mount.replaceChildren();

  const stack = el('div', 'page-stack');
  const title = el('h1', null, 'Trends');
  title.id = 'trends-title';
  stack.append(title);

  const window_ = data?.window ?? {};
  const clis = Array.isArray(data?.clis) ? data.clis : [];
  stack.append(
    el(
      'p',
      'note',
      `${Number.isFinite(window_?.days) ? window_.days : '?'} local days, ${window_?.from ?? '?'} to ${window_?.to ?? '?'}`
        + ` · ${clis.length ? clis.join(', ') : 'no CLI contributed a turn'}`
        + ` · days are local days (UTC offset ${Number.isFinite(window_?.timezoneOffsetMinutes) ? -window_.timezoneOffsetMinutes : '?'} minutes).`
        + ' A gap in any series is a day that was not measured. It is never drawn as a zero.',
    ),
  );
  if (data?.scan?.note) stack.append(el('p', 'note', `Scan: ${data.scan.note}`));

  stack.append(verdictCard(data));

  const grid = el('div', 'chart-grid');
  grid.append(contextChart(data));
  grid.append(spendChart(data));
  grid.append(cacheChart(data));
  stack.append(grid);

  stack.append(heatmapCard(data));
  const excluded = data?.excluded ?? {};
  const unknownCount = [
    excluded.turnsWithoutComputableFraction,
    excluded.sessionsWithoutTurns,
    excluded.turnsWithoutContextReading,
  ].reduce((total, count) => total + (Number.isFinite(count) ? count : 0), 0);
  if (unknownCount > 0) {
    stack.append(el('p', 'note unmeasured-page-note', `${groupInt(unknownCount) ?? unknownCount} item${unknownCount === 1 ? '' : 's'} could not be measured from the trend logs; they were not treated as zero.`));
  }
  const outsideTurns = Number.isFinite(excluded.turnsOutsideWindow) ? excluded.turnsOutsideWindow : 0;
  const outsideSessions = Number.isFinite(excluded.sessionsOutsideWindow) ? excluded.sessionsOutsideWindow : 0;
  if (outsideTurns > 0 || outsideSessions > 0) {
    stack.append(el('p', 'note trend-window-note', `${groupInt(outsideTurns)} turn${outsideTurns === 1 ? '' : 's'} and ${groupInt(outsideSessions)} session${outsideSessions === 1 ? '' : 's'} fell outside the selected date window; they were excluded by the filter, not left unmeasured.`));
  }

  mount.append(stack);
}

registerPage('trends', renderTrends);

export default renderTrends;
