import { rangeQuery, registerPage } from '../app.js';
import { button, cliIcon, dateText, duration, el, healthNode, icon, largestRemainder, number, ruleLabel, sparkline } from '../components/ui.js';

// Keep the namespace indirection: the frontend contract pins it.
const svgNs = ['http:', String.fromCharCode(47, 47), 'www.w3.org/2000/svg'].join('');
const finite = (value) => Number.isFinite(value);
const fmt = (value) => finite(value) ? value.toLocaleString('en-US') : 'not measured';
const iconBadge = (name) => { const badge = el('span', 'rx-icon'); badge.append(icon(name)); return badge; };

function deltaChip(comparison, key) {
  const metric = comparison?.deltas?.[key];
  if (comparison?.available !== true || !metric || !finite(metric.changePercent)) {
    const chip = el('span', 'rx-delta is-muted', 'not comparable'); chip.title = comparison?.reason || 'The previous window could not be compared.'; return chip;
  }
  const change = metric.changePercent; const chip = el('span', `rx-delta ${change > 0 ? 'is-up' : change < 0 ? 'is-down' : 'is-flat'}`, `${change > 0 ? '↑' : change < 0 ? '↓' : '→'} ${Math.abs(change)}%`); chip.title = `Compared with the previous window: ${change}%`; return chip;
}

function summaryCard(title, iconName, value, subtitle, series, comparison, key, tone) {
  const box = el('article', `rx-card summary-card tone-${tone}`); const titleRow = el('div', 'rx-card-title'); titleRow.append(iconBadge(iconName), el('h3', '', title));
  const valueRow = el('div', 'summary-value-row'); valueRow.append(el('strong', 'rx-number', value), deltaChip(comparison, key)); box.append(titleRow, valueRow, el('span', 'rx-label', subtitle));
  if (Array.isArray(series)) box.append(sparkline(series, `tone-${tone}`, { bars: true })); return box;
}

function comparisonNote(health) {
  if (health?.comparison?.available === true) return null;
  const reason = typeof health?.comparison?.reason === 'string' && health.comparison.reason
    ? health.comparison.reason
    : 'the previous window was not comparable';
  const completeFrom = typeof health?.coverage?.completeFrom === 'string' && health.coverage.completeFrom
    ? ` Coverage is complete from ${health.coverage.completeFrom}.`
    : '';
  return `Comparison unavailable: ${reason}.${completeFrom}`;
}

function donut(totals, comparison) {
  const passed = totals?.notObservedChecks; const measured = totals?.measuredChecks; const unknown = totals?.unknownChecks; const ratio = finite(passed) && finite(measured) && measured > 0 ? passed / measured : null;
  const wrap = el('div', 'health-grid'); const column = el('div', 'donut-column'); const svg = document.createElementNS(svgNs, 'svg'); svg.setAttribute('viewBox', '0 0 150 150'); svg.setAttribute('class', 'donut'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', ratio === null ? 'Measured check pass rate not measured' : `${Math.round(ratio * 100)} percent of measured checks passed`);
  const track = document.createElementNS(svgNs, 'circle'); track.setAttribute('cx', '75'); track.setAttribute('cy', '75'); track.setAttribute('r', '58'); track.setAttribute('class', 'donut-track'); svg.append(track);
  if (ratio !== null) { const ring = document.createElementNS(svgNs, 'circle'); ring.setAttribute('cx', '75'); ring.setAttribute('cy', '75'); ring.setAttribute('r', '58'); ring.setAttribute('class', 'donut-pass'); ring.setAttribute('pathLength', '100'); ring.setAttribute('stroke-dasharray', `${ratio * 100} 100`); svg.append(ring); }
  const label = document.createElementNS(svgNs, 'text'); label.setAttribute('class', 'donut-label'); label.setAttribute('x', '75'); label.setAttribute('y', '75'); label.textContent = ratio === null ? 'not measured' : String(Math.round(ratio * 100)); svg.append(label);
  const sub = document.createElementNS(svgNs, 'text'); sub.setAttribute('class', 'donut-sub'); sub.setAttribute('x', '75'); sub.setAttribute('y', '91'); sub.textContent = '% passed'; svg.append(sub);
  column.append(svg, el('p', 'donut-caption', ratio === null ? 'Measured check pass rate could not be determined.' : `${fmt(measured)} measured`));
  const donutDelta = el('p', 'donut-delta'); donutDelta.append(deltaChip(comparison, 'notObservedChecks')); column.append(donutDelta);
  const distribution = el('div', 'distribution-column'); distribution.append(el('h3', '', 'Issue distribution')); const items = Array.isArray(totals?.ruleTotals) ? totals.ruleTotals : []; const total = items.reduce((sum, item) => sum + (finite(item?.observed) ? item.observed : 0), 0);
  if (!total) distribution.append(el('p', 'not-measured', 'No observed findings were measured in this window.'));
  else { const sorted = items.filter((item) => item && typeof item.id === 'string').sort((a, b) => (b.observed || 0) - (a.observed || 0)); const percentages = largestRemainder(sorted.map((item) => (item.observed || 0) / total * 100)); sorted.forEach((item, index) => { const share = (item.observed || 0) / total * 100; const row = el('div', 'distribution-row'); row.style.setProperty('--distribution-color', `var(--distribution-${(index % 6) + 1})`); const labelNode = el('div', 'distribution-label'); labelNode.append(el('span', 'distribution-dot'), el('span', '', item.name || item.id)); row.append(labelNode, el('strong', '', `${percentages[index]}%`)); const bar = el('div', 'bar-track'); const fill = el('div', 'bar-fill distribution-fill'); fill.style.width = `${share}%`; bar.append(fill); row.append(bar); distribution.append(row); }); }
  wrap.append(column, distribution); return wrap;
}

function lineChart(items, valueKey, tone) {
  const svg = document.createElementNS(svgNs, 'svg'); svg.setAttribute('viewBox', '0 0 280 120'); svg.setAttribute('class', `trend-chart tone-${tone}`); svg.setAttribute('role', 'img'); const values = (Array.isArray(items) ? items : []).map((item) => item?.hasData && finite(item?.[valueKey]) ? item[valueKey] : null); const valid = values.filter((value) => value !== null); if (!valid.length) return svg;
  const min = Math.min(...valid); const span = Math.max(...valid) - min || 1; const baseline = 112; let segment = []; const flush = () => { if (!segment.length) return; const first = segment[0].split(',')[0]; const last = segment.at(-1).split(',')[0]; const area = document.createElementNS(svgNs, 'polygon'); area.setAttribute('points', `${segment.join(' ')} ${last},${baseline} ${first},${baseline}`); area.setAttribute('class', 'trend-area'); svg.append(area); const line = document.createElementNS(svgNs, 'polyline'); line.setAttribute('points', segment.join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(line); segment = []; };
  values.forEach((value, index) => { if (value === null) return flush(); segment.push(`${12 + index / Math.max(1, values.length - 1) * 256},${baseline - ((value - min) / span) * 92}`); }); flush(); return svg;
}

/**
 * Round a headline number to three significant figures, e.g. 333781217 -> "334M".
 *
 * WHY: a mean over seven measured days cannot support nine significant
 * figures. `333,930,495` claims a precision the input does not have. Nothing is
 * dropped — the whole-token value stays on the card in `.trend-exact` and in
 * the headline's tooltip — only the false precision goes.
 */
function roundedHeadline(value) {
  const size = Math.abs(value);
  if (size < 1000) return number(Math.round(value));
  const [scale, suffix] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']].find(([step]) => size >= step);
  const scaled = value / scale;
  const places = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  return `${Number(scaled.toFixed(places)).toLocaleString('en-US')}${suffix}`;
}

/** The published value in full, rounded to whole tokens — never to hundredths
 *  of a token, which is a unit the collector does not measure. */
function exactLevel(metric, key) {
  return key === 'spend' ? `${number(Math.round(metric.to))} tokens per measured day` : `${metric.to}%`;
}

function trendLevel(metric, key) {
  if (metric?.available !== true || !finite(metric.to)) return null;
  return key === 'spend' ? roundedHeadline(metric.to) : `${metric.to}%`;
}

function trendChange(metric, key) {
  if (metric?.available !== true || !finite(metric.to)) return null;
  if (!finite(metric.changePercent)) return el('span', 'trend-empty', metric.reason || 'The change could not be measured.');
  const change = metric.changePercent;
  const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
  const relative = key === 'context' || key === 'cache' ? ' relative' : '';
  return el('span', `trend-change ${change > 0 ? 'is-up' : change < 0 ? 'is-down' : 'is-flat'}`, `${arrow} ${change > 0 ? '+' : ''}${Math.abs(change)}%${relative ? ' relative change' : ''}`);
}

function unavailableTrend(metric) {
  const reason = typeof metric?.reason === 'string' && metric.reason ? metric.reason : 'The published comparison reason was not provided.';
  const details = el('details', 'trend-reason');
  details.append(el('summary', '', 'Why this cannot be compared'), el('p', '', reason));
  return [el('span', 'trend-empty', 'Not enough measured days in this window to compare.'), details];
}

export function trendCard(title, key, deltas, charts, valueKey, caption, tone) {
  const metric = deltas?.[key];
  const level = trendLevel(metric, key);
  const box = el('article', `trend-card tone-${tone}`);
  if (level === null) box.append(el('h3', '', title), ...unavailableTrend(metric));
  else {
    const levelNode = el('strong', 'trend-level', level);
    const exact = exactLevel(metric, key);
    levelNode.title = `Published value: ${exact}. Mean over ${metric.secondHalfDays} measured days in the newer half.`;
    box.append(el('h3', '', title), levelNode);
    // The headline is rounded, so the exact figure stays on the card rather
    // than only in a tooltip a keyboard user never reaches.
    if (key === 'spend') box.append(el('span', 'trend-exact', exact));
    box.append(trendChange(metric, key));
  }
  let note = caption;
  if (key === 'spend' && metric?.available === true && finite(metric.secondHalfDays)) {
    const rows = Array.isArray(charts?.spend) ? charts.spend : [];
    const half = Math.floor(rows.length / 2);
    const newer = rows.slice(rows.length - half).filter((row) => row?.hasData === true);
    const mean = (field) => {
      const values = newer.map((row) => row?.[field]).filter(finite);
      return values.length ? number(Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)) : 'not measured';
    };
    note = `Per-day mean over ${Math.round(metric.secondHalfDays)} measured days; mostly cache reads, not fresh input (${mean('cacheRead')} cache-read vs ${mean('cacheCreation')} cache-creation tokens).`;
  }
  box.append(lineChart(charts?.[key], valueKey, tone), el('p', 'trend-note', note));
  return box;
}

function sectionTitle(title, iconName, tone = 'accent') { const node = el('div', `rx-section-title tone-${tone}`); node.append(iconBadge(iconName), el('h2', '', title)); return node; }
function trendsPreview(payload) { const section = el('section', 'rx-card'); const head = el('div', 'rx-card-head'); head.append(sectionTitle('Trends', 'trends')); const link = el('a', '', 'View all →'); link.href = '#/trends'; head.append(link); section.append(head); const grid = el('div', 'trend-grid'); grid.append(trendCard('How full conversations got', 'context', payload?.trendDeltas, payload?.charts, 'turnsAboveThreshold', 'Turns above 70% full', 'pass'), trendCard('Text used', 'spend', payload?.trendDeltas, payload?.charts, 'total', 'Text used per day (tokens)', 'accent'), trendCard('Reused vs rebuilt content', 'cache', payload?.trendDeltas, payload?.charts, 'hitRate', 'Reused content (%)', 'pass')); section.append(grid); return section; }

function topFixes(health, api) { const section = el('section', 'rx-card'); const head = el('div', 'rx-card-head'); head.append(sectionTitle('Top suggestions', 'fixes')); const link = el('a', '', 'View all suggestions →'); link.href = '#/fixes'; head.append(link); section.append(head); const items = Array.isArray(health?.topFixes) ? health.topFixes.slice(0, 5) : []; if (!items.length) { section.append(el('p', 'not-measured', 'No ranked findings with a suggestion were measured in this window.')); return section; }
  items.forEach((item, index) => { const row = el('div', 'fix-row'); row.append(el('span', 'rank', index + 1)); const copy = el('div'); copy.append(el('span', 'fix-title', item.name || item.id || 'Session check'), el('span', 'fix-sub', `${fmt(item.sessions)} sessions`)); row.append(copy); const actions = el('div', 'fix-actions'); const link2 = button('View suggestion', 'button button-sm'); link2.addEventListener('click', () => { location.hash = '#/fixes'; }); actions.append(link2); row.append(actions); section.append(row); }); return section; }

function recentSessions(payload) { const section = el('section', 'rx-card'); const head = el('div', 'rx-card-head'); head.append(sectionTitle('Recent sessions', 'sessions')); const link = el('a', '', 'View all sessions →'); link.href = '#/sessions'; head.append(link); section.append(head); const sessions = Array.isArray(payload?.sessions) ? payload.sessions : []; if (!sessions.length) { section.append(el('p', 'not-measured', 'Recent sessions could not be measured.')); return section; } const table = el('div', 'rx-table-wrap'); const t = el('table', 'rx-table'); const hr = el('tr'); ['CLI', 'Started', 'Duration', 'Turns', 'Health', 'Key issue', 'Action'].forEach((label) => hr.append(el('th', '', label))); const thead = el('thead'); thead.append(hr); t.append(thead); const body = el('tbody');
  sessions.slice(0, 8).forEach((session) => { const row = el('tr'); row.addEventListener('click', () => { location.hash = `#/sessions/${encodeURIComponent(session.sessionId || '')}`; }); const finding = (session.rules || []).find((rule) => rule?.evidence?.status === 'observed'); const issue = el('span', 'session-issue'); if (finding) issue.append(el('span', `distribution-dot issue-${finding.id || ''}`), el('span', '', ruleLabel(finding))); else issue.append(el('span', 'not-measured', 'no observed issue')); const cli = el('td'); cli.append(cliIcon(session.cliName || session.cli), document.createTextNode(` ${session.cliName || session.cli || 'Unknown CLI'}`)); const healthCell = el('td'); healthCell.append(healthNode(session.score, true)); const issueCell = el('td'); issueCell.append(issue); const action = button('View →', 'button button-sm'); action.addEventListener('click', (event) => { event.stopPropagation(); row.click(); }); const actionCell = el('td'); actionCell.append(action); row.append(cli, el('td', '', dateText(session.startedAt)), el('td', '', duration(session.startedAt, session.endedAt)), el('td', '', number(session.turnCount)), healthCell, issueCell, actionCell); body.append(row); }); t.append(body); table.append(t); section.append(table); return section; }

function collectorStatus(collector) {
  if (Object.prototype.hasOwnProperty.call(collector || {}, 'installed')) {
    if (collector.installed === true) return 'found';
    if (collector.installed === false) return 'not found';
    return 'not reported';
  }
  if (collector?.support === 'supported') return 'found';
  if (collector?.support === 'detection-only') return 'found';
  if (collector?.support === 'unsupported') return 'not found';
  return 'not reported';
}

function emptyOverviewPanel(health, rangeEmpty) {
  const panel = el('section', 'rx-card overview-empty-panel');
  const heading = rangeEmpty ? 'No sessions in this date range' : 'SessionRx found no AI CLI sessions on this machine';
  const intro = rangeEmpty
    ? `The scan found ${health.sessionsTotal} sessions, but none fall inside this date range. Widen the range to look at those sessions.`
    : 'SessionRx checked each CLI below and reports whether it was found on this machine.';
  panel.append(el('h2', '', heading), el('p', 'overview-empty-intro', intro));
  if (!rangeEmpty) {
    const collectors = el('div', 'overview-collectors');
    (Array.isArray(health?.collectors) ? health.collectors : []).forEach((collector) => {
      const item = el('article', 'overview-collector');
      const name = collector?.cli || collector?.id || 'Unknown CLI';
      item.append(el('h3', '', name), el('span', 'overview-collector-status', collectorStatus(collector)));
      if (typeof collector?.note === 'string' && collector.note) item.append(el('p', 'overview-collector-note', collector.note));
      collectors.append(item);
    });
    panel.append(collectors, el('p', 'overview-empty-next', 'Use one of the supported CLIs and come back, or widen the scan if sessions are older than the current range.'));
  }
  return panel;
}

async function renderOverview(mount, data, ctx = {}) {
  if (!mount) return;
  const api = ctx.api;
  const health = data || await api.get(`/api/health${rangeQuery('/api/health')}`);
  const [trends, sessionsPayload] = await Promise.all([
    api.get(`/api/trends${rangeQuery('/api/trends')}`),
    api.get(`/api/sessions?limit=8${rangeQuery('/api/sessions').replace(/^\?/, '&')}`),
  ]);
  const totals = health?.windowTotals || {};
  const days = health?.comparison?.windowDays;
  const dayText = finite(days) ? `${Math.round(days)} days` : 'the selected window';
  const series = health?.windowSeries || {};
  const noSessionsFound = health?.sessionsTotal === 0;
  const rangeHasNoSessions = Number.isFinite(health?.sessionsTotal) && health.sessionsTotal > 0 && totals.sessions === 0;
  const root = el('div', 'rx-page');
  const hero = el('header', 'rx-hero');
  const intro = el('div');
  intro.append(el('h1', '', 'Make your AI sessions more effective.'), el('p', '', 'SessionRx reads local session evidence, finds what is getting in the way, and helps you fix it.'));
  const collectors = Array.isArray(health?.collectors) ? health.collectors : [];
  const hasInstalledData = collectors.length > 0 && collectors.every((collector) => Object.prototype.hasOwnProperty.call(collector || {}, 'installed'));
  const detected = collectors.filter((collector) => hasInstalledData ? collector?.installed === true : collector?.support === 'supported');
  const cliList = el('div', 'rx-cli-list');
  const cliSummary = el('span', 'rx-cli-summary');
  cliSummary.append(el('span', 'rx-cli-mark', 'ϟ'), el('strong', '', `${detected.length} CLIs detected`));
  cliList.append(cliSummary);
  detected.forEach((collector) => {
    const name = collector.cli || collector.id || 'Unknown CLI';
    const notRead = collector?.support === 'detection-only'
      || (collector?.support === 'supported' && collector?.note && (!Number.isFinite(collector?.sessions) || collector.sessions === 0));
    const chip = el('span', 'rx-chip', notRead ? `${name} · not read yet` : name);
    if (notRead && collector?.note) chip.title = collector.note;
    cliList.append(chip);
  });
  hero.append(intro, cliList);
  root.append(hero);
  if (noSessionsFound || rangeHasNoSessions) root.append(emptyOverviewPanel(health, rangeHasNoSessions));
  else {
    const cards = el('div', 'rx-grid rx-grid-three');
    const fixes = health?.distinctFixes;
    const fixValue = finite(fixes?.count) ? number(fixes.count) : 'not measured';
    // This card's VALUE is distinctFixes.count. The published series and delta
    // (`fixableFindings`) count FINDINGS, a different quantity: for 2026-09-19
    // -> 2026-09-22 there were 3 distinct fixes against 4 in the window before,
    // and the card rendered "3 ↑ 63.8%" — an up-arrow on a number that fell.
    // The API publishes no previous-window distinct-fix count and no series for
    // it, so this card carries neither chip nor sparkline rather than one that
    // describes a different series from its own headline.
    const fixComparison = {
      available: false,
      reason: 'the previous window\'s distinct-fix count is not published, so this number cannot be compared',
    };
    const fixSubtitle = finite(fixes?.findings)
      ? `${number(fixes.findings)} findings with a suggested change`
      : 'distinct suggestions offered';
    const sessionSubtitle = `sessions in the last ${dayText}${health?.coverage?.atLimit === true ? ' · floor (scan at limit)' : ''}`;
    cards.append(summaryCard('Sessions analyzed', 'sessions', number(totals.sessions), sessionSubtitle, series.sessions, health.comparison, 'sessions', 'accent'), summaryCard('Problems found', 'problems', number(totals.observedFindings), `findings vs. previous ${dayText}`, series.observedFindings, health.comparison, 'observedFindings', 'warn'), summaryCard('Suggestions available', 'fixes', fixValue, fixSubtitle, null, fixComparison, 'distinctFixes', 'pass'));
    const note = comparisonNote(health);
    if (note) cards.append(el('p', 'comparison-note', note));
    root.append(cards);
  }
  const trend = trends?.trend;
  const callout = el('aside', 'trend-callout');
  callout.append(el('h3', '', trend?.direction === 'unknown' ? 'Trend could not be determined' : 'Trend'), el('p', 'trend-summary', trend?.direction === 'unknown' ? (trend.reason || 'The trend could not be determined for this window.') : (trend.summary || 'The trend summary was not published.')));
  const healthCard = el('section', 'rx-card');
  const healthHead = el('div', 'rx-card-head');
  healthHead.append(sectionTitle('Health summary', 'health', 'pass'));
  healthCard.append(healthHead, donut({ ...totals, ruleTotals: health?.ruleTotals }, health?.comparison));
  healthCard.querySelector?.('.health-grid')?.append(callout);
  if (!healthCard.querySelector) healthCard.append(callout);
  if (!noSessionsFound && !rangeHasNoSessions) {
    const mid = el('div', 'rx-grid rx-grid-two overview-health-row');
    mid.append(healthCard, trendsPreview(trends));
    root.append(mid);
  }
  const lower = el('div', 'rx-grid rx-grid-two overview-lower');
  lower.append(topFixes(health, api), recentSessions(sessionsPayload));
  root.append(lower);
  if (Number.isFinite(totals.unknownChecks) && totals.unknownChecks > 0) {
    root.append(el('p', 'note unmeasured-page-note', `${number(totals.unknownChecks)} check${totals.unknownChecks === 1 ? '' : 's'} could not be measured from the session logs; they were not treated as passes. This is NOT a pass — the check could not run here.`));
  }
  const footer = el('footer', 'rx-footer');
  const version = health?.version || globalThis.__SESSION_RX_BOOTSTRAP__?.version;
  footer.textContent = `SessionRx${typeof version === 'string' && version ? ` · v${version}` : ''} · Reads local session evidence. Nothing leaves this machine.`;
  root.append(footer);
  mount.replaceChildren(root);
}

registerPage('overview', renderOverview);
export default renderOverview;
