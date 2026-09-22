import { rangeQuery, registerPage } from '../app.js';
import { openFixModal } from '../components/fix-modal.js';
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

function donut(totals, comparison) {
  const passed = totals?.notObservedChecks; const measured = totals?.measuredChecks; const unknown = totals?.unknownChecks; const ratio = finite(passed) && finite(measured) && measured > 0 ? passed / measured : null;
  const wrap = el('div', 'health-grid'); const column = el('div', 'donut-column'); const svg = document.createElementNS(svgNs, 'svg'); svg.setAttribute('viewBox', '0 0 150 150'); svg.setAttribute('class', 'donut'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', ratio === null ? 'Measured check pass rate not measured' : `${Math.round(ratio * 100)} percent of measured checks passed`);
  const track = document.createElementNS(svgNs, 'circle'); track.setAttribute('cx', '75'); track.setAttribute('cy', '75'); track.setAttribute('r', '58'); track.setAttribute('class', 'donut-track'); svg.append(track);
  if (ratio !== null) { const ring = document.createElementNS(svgNs, 'circle'); ring.setAttribute('cx', '75'); ring.setAttribute('cy', '75'); ring.setAttribute('r', '58'); ring.setAttribute('class', 'donut-pass'); ring.setAttribute('pathLength', '100'); ring.setAttribute('stroke-dasharray', `${ratio * 100} 100`); svg.append(ring); }
  const label = document.createElementNS(svgNs, 'text'); label.setAttribute('class', 'donut-label'); label.setAttribute('x', '75'); label.setAttribute('y', '75'); label.textContent = ratio === null ? 'not measured' : String(Math.round(ratio * 100)); svg.append(label);
  const sub = document.createElementNS(svgNs, 'text'); sub.setAttribute('class', 'donut-sub'); sub.setAttribute('x', '75'); sub.setAttribute('y', '91'); sub.textContent = '% passed'; svg.append(sub);
  column.append(svg, el('p', 'donut-caption', ratio === null ? 'Measured check pass rate could not be determined.' : `${fmt(measured)} measured · ${fmt(unknown)} could not be measured`));
  const donutDelta = el('p', 'donut-delta'); donutDelta.append(deltaChip(comparison, 'notObservedChecks')); column.append(donutDelta);
  const distribution = el('div', 'distribution-column'); distribution.append(el('h3', '', 'Issue distribution')); const items = Array.isArray(totals?.ruleTotals) ? totals.ruleTotals : []; const total = items.reduce((sum, item) => sum + (finite(item?.observed) ? item.observed : 0), 0);
  if (!total) distribution.append(el('p', 'not-measured', 'No observed findings were measured in this window.'));
  else { const sorted = items.filter((item) => item && typeof item.id === 'string').sort((a, b) => (b.observed || 0) - (a.observed || 0)); const percentages = largestRemainder(sorted.map((item) => (item.observed || 0) / total * 100)); sorted.forEach((item, index) => { const share = (item.observed || 0) / total * 100; const row = el('div', 'distribution-row'); row.style.setProperty('--distribution-color', `var(--distribution-${(index % 6) + 1})`); const labelNode = el('div', 'distribution-label'); labelNode.append(el('span', 'distribution-dot'), el('span', '', item.name || item.id)); row.append(labelNode, el('strong', '', `${percentages[index]}%`)); const bar = el('div', 'bar-track'); const fill = el('div', 'bar-fill distribution-fill'); fill.style.width = `${share}%`; bar.append(fill); row.append(bar); if (finite(item.unknown) && item.unknown > 0) row.append(el('small', 'distribution-status', `could not be measured on ${fmt(item.unknown)} ${item.unknown === 1 ? 'session' : 'sessions'}`)); distribution.append(row); }); }
  wrap.append(column, distribution); return wrap;
}

function lineChart(items, valueKey, tone) {
  const svg = document.createElementNS(svgNs, 'svg'); svg.setAttribute('viewBox', '0 0 280 120'); svg.setAttribute('class', `trend-chart tone-${tone}`); svg.setAttribute('role', 'img'); const values = (Array.isArray(items) ? items : []).map((item) => item?.hasData && finite(item?.[valueKey]) ? item[valueKey] : null); const valid = values.filter((value) => value !== null); if (!valid.length) return svg;
  const min = Math.min(...valid); const span = Math.max(...valid) - min || 1; const baseline = 112; let segment = []; const flush = () => { if (!segment.length) return; const first = segment[0].split(',')[0]; const last = segment.at(-1).split(',')[0]; const area = document.createElementNS(svgNs, 'polygon'); area.setAttribute('points', `${segment.join(' ')} ${last},${baseline} ${first},${baseline}`); area.setAttribute('class', 'trend-area'); svg.append(area); const line = document.createElementNS(svgNs, 'polyline'); line.setAttribute('points', segment.join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(line); segment = []; };
  values.forEach((value, index) => { if (value === null) return flush(); segment.push(`${12 + index / Math.max(1, values.length - 1) * 256},${baseline - ((value - min) / span) * 92}`); }); flush(); return svg;
}

function trendLevel(metric, key) {
  if (metric?.available !== true || !finite(metric.to)) return null;
  return key === 'spend' ? number(metric.to) : `${metric.to}%`;
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
    levelNode.title = `Mean over ${metric.secondHalfDays} measured days in the newer half.`;
    box.append(el('h3', '', title), levelNode, trendChange(metric, key));
  }
  box.append(lineChart(charts?.[key], valueKey, tone), el('p', 'trend-note', caption));
  return box;
}

function sectionTitle(title, iconName, tone = 'accent') { const node = el('div', `rx-section-title tone-${tone}`); node.append(iconBadge(iconName), el('h2', '', title)); return node; }
function trendsPreview(payload) { const section = el('section', 'rx-card'); const head = el('div', 'rx-card-head'); head.append(sectionTitle('Trends', 'trends')); const link = el('a', '', 'View all →'); link.href = '#/trends'; head.append(link); section.append(head); const grid = el('div', 'trend-grid'); grid.append(trendCard('Context efficiency', 'context', payload?.trendDeltas, payload?.charts, 'turnsAboveThreshold', 'Turns above 70% of window', 'pass'), trendCard('Token spend', 'spend', payload?.trendDeltas, payload?.charts, 'total', 'Total tokens per day', 'accent'), trendCard('Cache hit rate', 'cache', payload?.trendDeltas, payload?.charts, 'hitRate', 'Cache hits (%)', 'pass')); section.append(grid); return section; }

function topFixes(health, api, fixesPayload) { const section = el('section', 'rx-card'); const head = el('div', 'rx-card-head'); head.append(sectionTitle('Top fixes', 'fixes')); const link = el('a', '', 'View all fixes →'); link.href = '#/fixes'; head.append(link); section.append(head); const items = Array.isArray(health?.topFixes) ? health.topFixes.slice(0, 5) : []; if (!items.length) { section.append(el('p', 'not-measured', 'No ranked fixable findings were measured in this window.')); return section; }
  items.forEach((item, index) => { const rule = { id: item.id, name: item.name, fix: item.fixId }; const row = el('div', 'fix-row'); row.append(el('span', 'rank', index + 1)); const copy = el('div'); copy.append(el('span', 'fix-title', item.name || item.id || 'Session check'), el('span', 'fix-sub', `${fmt(item.sessions)} sessions`)); row.append(copy); const rank = index < 2 ? 'High' : index < 4 ? 'Medium' : 'Low'; row.append(el('span', `impact-rank impact-${rank.toLowerCase()}`, `${rank} rank`)); const actions = el('div', 'fix-actions'); const preview = button('Preview', 'button button-sm'); const apply = button('Apply', 'button button-primary button-sm'); const skip = button('Skip', 'button button-sm'); const open = () => openFixModal({ fixId: item.fixId, rule, session: null, api, catalog: fixesPayload?.fixes }); preview.addEventListener('click', open); apply.addEventListener('click', open); skip.addEventListener('click', () => row.classList.add('is-skipped')); actions.append(preview, apply, skip); row.append(actions); section.append(row); }); return section; }

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
  const [trends, sessionsPayload, fixesPayload] = await Promise.all([
    api.get(`/api/trends${rangeQuery('/api/trends')}`),
    api.get(`/api/sessions?limit=8${rangeQuery('/api/sessions').replace(/^\?/, '&')}`),
    api.get('/api/fixes'),
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
  detected.forEach((collector) => cliList.append(el('span', 'rx-chip', collector.cli || collector.id || 'Unknown CLI')));
  hero.append(intro, cliList);
  root.append(hero);
  if (noSessionsFound || rangeHasNoSessions) root.append(emptyOverviewPanel(health, rangeHasNoSessions));
  else {
    const cards = el('div', 'rx-grid rx-grid-four');
    cards.append(summaryCard('Sessions analyzed', 'sessions', number(totals.sessions), `in the last ${dayText}`, series.sessions, health.comparison, 'sessions', 'accent'), summaryCard('Problems found', 'problems', number(totals.observedFindings), `vs. previous ${dayText}`, series.observedFindings, health.comparison, 'observedFindings', 'warn'), summaryCard('Fixes available', 'fixes', number(totals.fixableFindings), 'actionable improvements', series.fixableFindings, health.comparison, 'fixableFindings', 'pass'), summaryCard('Not measured', 'unmeasured', number(totals.unknownChecks), 'could not be analyzed', series.unknownChecks, health.comparison, 'unknownChecks', 'unknown'));
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
  lower.append(topFixes(health, api, fixesPayload), recentSessions(sessionsPayload));
  root.append(lower);
  const footer = el('footer', 'rx-footer');
  const version = health?.version || globalThis.__SESSION_RX_BOOTSTRAP__?.version;
  footer.textContent = `SessionRx${typeof version === 'string' && version ? ` · v${version}` : ''} · Reads local session evidence. Nothing leaves this machine.`;
  root.append(footer);
  mount.replaceChildren(root);
}

registerPage('overview', renderOverview);
export default renderOverview;
