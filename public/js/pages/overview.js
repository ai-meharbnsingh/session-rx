import { rangeQuery, registerPage } from '../app.js';
import { openFixModal } from '../components/fix-modal.js';
import { button, cliIcon, dateText, duration, el, healthNode, icon, metricDelta, number, observedRules, plainText, ruleLabel, severity, sparkline } from '../components/ui.js';

// Each summary card carries its own colour, matched to what the number means:
// blue for a plain count, amber for problems, green for available fixes, grey
// for what could not be measured. Grey is deliberate — "not measured" must read
// as its own state, not as a dimmer kind of pass.
const iconBadge = (name) => { const badge = el('span', 'rx-icon'); badge.append(icon(name)); return badge; };
const card = (title, iconName, value, subtitle, values, delta, tone = 'accent') => {
  const box = el('article', `rx-card summary-card tone-${tone}`);
  const titleRow = el('div', 'rx-card-title'); titleRow.append(iconBadge(iconName), el('h3', '', title));
  box.append(titleRow, el('strong', 'rx-number', value), el('span', 'rx-label', subtitle));
  if (delta) box.append(el('span', 'rx-delta', delta));
  box.append(sparkline(values, `tone-${tone}`)); return box;
};

const svgNs = ['http:', String.fromCharCode(47, 47), 'www.w3.org/2000/svg'].join('');

function largestRemainderPercentages(values, total) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const raw = values.map((value) => value / total * 100);
  const percentages = raw.map(Math.floor);
  let remainder = 100 - percentages.reduce((sum, value) => sum + value, 0);
  [...raw.keys()].sort((a, b) => raw[b] - Math.floor(raw[b]) - (raw[a] - Math.floor(raw[a])) || a - b).slice(0, remainder).forEach((index) => { percentages[index] += 1; });
  return percentages;
}

function issueDistribution(ruleTotals, population) {
  const items = (Array.isArray(ruleTotals) ? ruleTotals : [])
    .filter((rule) => rule && typeof rule.id === 'string')
    .sort((a, b) => (Number.isFinite(b.observed) ? b.observed : -1) - (Number.isFinite(a.observed) ? a.observed : -1) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
  const observedTotal = items.reduce((sum, item) => sum + (Number.isFinite(item.observed) ? item.observed : 0), 0);
  const percentages = largestRemainderPercentages(items.map((item) => Number.isFinite(item.observed) ? item.observed : 0), observedTotal);
  return { items, observedTotal, population, percentages };
}

const distributionPalette = ['#6f9bf7', '#b58cf2', '#4fc3b3', '#ef8f6b', '#d16ba5', '#7e9bd6', '#56a8c7', '#c38bd8', '#e48b9d', '#63b89f', '#8d86d8', '#d49a78'];
const distributionColorsByRule = new Map([['long-rising-context', '#4fc3b3'], ['large-tool-result', '#7e9bd6'], ['repeat-tool', '#c38bd8'], ['context-pressure', '#6f9bf7'], ['cache-hit', '#b58cf2'], ['subagent-concurrency', '#ef8f6b']]);
function distributionColor(ruleId) {
  if (distributionColorsByRule.has(ruleId)) return distributionColorsByRule.get(ruleId);
  let hash = 2166136261;
  for (const character of String(ruleId)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return distributionPalette[(hash >>> 0) % distributionPalette.length];
}

function donut(health, trends) {
  const sessions = health?.sessions || [];
  let passed = 0, observed = 0, unknown = 0, total = 0;
  sessions.forEach((session) => { passed += session?.score?.passed || 0; observed += session?.score?.observed || 0; unknown += session?.score?.unknown || 0; total += session?.score?.total || 0; });
  const measured = Math.max(0, total - unknown), circumference = 2 * Math.PI * 58;
  const wrap = el('div', 'health-grid donut-wrap'); const donutColumn = el('div', 'donut-column');
  const svg = document.createElementNS(svgNs, 'svg'); svg.setAttribute('viewBox', '0 0 150 150'); svg.setAttribute('class', 'donut'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${passed} of ${measured} measured checks passed`);
  const track = document.createElementNS(svgNs, 'circle'); track.setAttribute('cx','75'); track.setAttribute('cy','75'); track.setAttribute('r','58'); track.setAttribute('class','donut-track'); svg.append(track);
  let offset = 0;
  for (const [value, cls] of [[observed, 'donut-observed'], [passed, 'donut-pass'], [unknown, 'donut-unknown']]) {
    if (!value || !total) continue;
    const ring = document.createElementNS(svgNs, 'circle');
    ring.setAttribute('cx', '75'); ring.setAttribute('cy', '75'); ring.setAttribute('r', '58');
    ring.setAttribute('class', cls); ring.setAttribute('pathLength', '100');
    ring.setAttribute('stroke-dasharray', `${value / total * 100} 100`);
    ring.setAttribute('stroke-dashoffset', String(-offset / circumference * 100));
    svg.append(ring); offset += value / total * circumference;
  }
  const label = document.createElementNS(svgNs, 'text');
  label.setAttribute('class', 'donut-label'); label.setAttribute('x', '75'); label.setAttribute('y', '75');
  label.textContent = measured ? `${passed}/${measured}` : '—'; svg.append(label);
  const sub = document.createElementNS(svgNs, 'text');
  sub.setAttribute('class', 'donut-sub'); sub.setAttribute('x', '75'); sub.setAttribute('y', '91');
  sub.textContent = 'measured'; svg.append(sub); donutColumn.append(svg, el('p', 'donut-coverage', `Covers ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`));
  const stateLine = el('p', 'health-states'); const percentages = largestRemainderPercentages([passed, observed, unknown], total); if (percentages) stateLine.append(el('span', 'state-pass', `${percentages[0]}% passed`), el('span', 'state-observed', `${percentages[1]}% problems found`), el('span', 'state-unknown', `${percentages[2]}% could not be measured`)); else stateLine.textContent = 'Nothing to summarise.'; donutColumn.append(stateLine);
  const distribution = issueDistribution(health?.ruleTotals, health?.ruleTotalsSessions); const distributionColumn = el('div', 'distribution-column'); distributionColumn.append(el('h3', '', 'Issue distribution'));
  const populationText = Number.isFinite(distribution.population) ? ` across ${distribution.population.toLocaleString('en-US')} sessions in this window` : ' in this window';
  distributionColumn.append(el('p', 'distribution-note', `Share of observed findings${populationText}`));
  if (!distribution.observedTotal) distributionColumn.append(el('p', 'not-measured', 'No observed findings were found in this window.'));
  else distribution.items.forEach((item, index) => { const observed = Number.isFinite(item.observed) ? item.observed : 0; const unknownForRule = Number.isFinite(item.unknown) ? item.unknown : null; const row = el('div', 'distribution-row'); row.style.setProperty('--distribution-color', distributionColor(item.id)); const label = el('div', 'distribution-label'); const dot = el('span', 'distribution-dot'); dot.setAttribute('aria-hidden', 'true'); const copy = el('span'); copy.append(el('span', '', item.name || item.id)); if (observed === 0) copy.append(el('span', 'distribution-status', ' — no problem was found')); if (unknownForRule !== null && unknownForRule > 0) copy.append(el('span', 'distribution-status', ` — could not be measured on ${unknownForRule.toLocaleString('en-US')} ${unknownForRule === 1 ? 'session' : 'sessions'}`)); label.append(dot, copy); row.append(label, el('strong', '', `${distribution.percentages[index]}%`)); const trackBar = el('div', 'bar-track'); const fill = el('div', 'bar-fill distribution-fill'); fill.style.width = `${distribution.percentages[index]}%`; trackBar.append(fill); row.append(trackBar); distributionColumn.append(row); });
  const callout = el('aside', 'trend-callout'); callout.append(el('h3', '', 'Trend')); if (trends?.trend?.direction === 'unknown') callout.append(el('p', 'trend-unknown', 'The trend could not be determined for this window.')); if (trends?.trend?.summary) callout.append(el('p', 'trend-summary', trends.trend.summary)); else callout.append(el('p', 'trend-summary', 'The trend could not be determined for this window.'));
  wrap.append(donutColumn, distributionColumn, callout); return wrap;
}

function lineChart(items, valueKey, tone) {
  const height = 120; const svg = document.createElementNS(svgNs, 'svg'); svg.setAttribute('viewBox', `0 0 280 ${height}`); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet'); svg.setAttribute('class', `trend-chart tone-${tone}`); svg.setAttribute('role', 'img');
  const values = items.map((item) => item?.hasData && Number.isFinite(item?.[valueKey]) ? item[valueKey] : null); const valid = values.filter((value) => value !== null); if (!valid.length) return svg;
  const min = Math.min(...valid); const max = Math.max(...valid); const span = max - min || 1; const top = 10; const baseline = height - 8; const range = baseline - top; let segment = [];
  values.forEach((value, index) => { if (value === null) { if (segment.length) { appendLine(svg, segment, baseline); segment = []; } return; } segment.push(`${12 + index / Math.max(1, values.length - 1) * 256},${baseline - ((value - min) / span) * range}`); }); if (segment.length) appendLine(svg, segment, baseline); return svg;
}

function appendLine(svg, points, baseline) { const firstX = points[0].split(',')[0]; const last = points[points.length - 1]; const lastX = last.split(',')[0]; const area = document.createElementNS(svgNs, 'polygon'); area.setAttribute('points', `${points.join(' ')} ${lastX},${baseline} ${firstX},${baseline}`); area.setAttribute('class', 'trend-area'); svg.append(area); const poly = document.createElementNS(svgNs, 'polyline'); poly.setAttribute('points', points.join(' ')); poly.setAttribute('fill', 'none'); poly.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(poly); }
function latestValue(items, valueKey, formatter) { const point = [...(items || [])].reverse().find((item) => item?.hasData && Number.isFinite(item?.[valueKey])); return point ? formatter(point[valueKey]) : null; }

function trendTone(metric, betterWhen) {
  if (!metric || !Number.isFinite(metric.from) || !Number.isFinite(metric.to)) return 'accent';
  const published = String(metric.direction || '').toLowerCase();
  if (published === 'improving') return 'pass';
  if (published === 'worsening' || published === 'declining') return 'warn';
  if (published === 'flat' || published === 'stable' || published === 'unknown') return 'accent';
  const delta = metric.to - metric.from;
  if (delta === 0) return 'accent';
  // The analyzer publishes these metric meanings: fewer turns above the 70% context window is better, while a higher cache hit rate is better.
  return (betterWhen === 'lower' ? delta < 0 : delta > 0) ? 'pass' : 'warn';
}

function trendsPreview(trends) {
  const section = el('section', 'rx-card'); const head = el('div','rx-card-head'); const title = el('div', 'rx-section-title tone-accent'); const windowDays = trends?.window?.days; const days = Number.isFinite(windowDays) ? windowDays : Array.isArray(trends?.days) ? trends.days.length : null; title.append(iconBadge('trends'), el('h2', '', days === null ? 'Trends' : `Trends (last ${days} days)`)); if (days === null) title.append(el('p', 'trend-window-unknown', 'Window length could not be determined.')); head.append(title, el('a','', 'View all')); head.lastChild.href = '#/trends'; section.append(head);
  const metrics = Array.isArray(trends?.trend?.metrics) ? trends.trend.metrics : []; const metricFor = (label) => metrics.find((metric) => metric?.label === label); const charts = trends?.charts || {};
  const definitions = [{ key: 'context', title: 'Context efficiency', valueKey: 'turnsAboveThreshold', metric: metricFor('turns above 70% of window'), betterWhen: 'lower', caption: 'Turns above 70% of window', format: (value) => `${value.toLocaleString('en-US')} turns` }, { key: 'spend', title: 'Token spend', valueKey: 'total', metric: null, caption: 'Total context read across all turns', format: (value) => value.toLocaleString('en-US') }, { key: 'cache', title: 'Cache hit rate', valueKey: 'hitRate', metric: metricFor('cache hit rate'), betterWhen: 'higher', caption: 'Cache hits (%)', format: (value) => `${value.toFixed(2)}%` }];
  const grid = el('div', 'trend-grid'); definitions.forEach((definition) => { const tone = definition.metric ? trendTone(definition.metric, definition.betterWhen) : 'accent'; const box = el('article', `trend-card tone-${tone}`); box.append(el('h3', '', definition.title)); const delta = metricDelta(definition.metric); const latest = latestValue(charts[definition.key], definition.valueKey, definition.format); box.append(el('strong', 'trend-value', delta || latest || 'not measured')); box.append(lineChart(charts[definition.key] || [], definition.valueKey, tone)); box.append(el('p', 'trend-note', definition.caption)); grid.append(box); }); section.append(grid); return section;
}

async function renderOverview(mount, data, ctx = {}) {
  if (!mount) return;
  const api = ctx.api; const health = data || await api.get(`/api/health${rangeQuery('/api/health')}`);
  const [trends, fixesPayload] = await Promise.all([api.get('/api/trends'), api.get('/api/fixes')]);
  const sessions = health?.sessions || []; const rules = observedRules(sessions); const unknown = sessions.reduce((sum, s) => sum + (s?.score?.unknown || 0), 0); const fixable = rules.filter((item) => item.rule?.fix).length;
  const root = el('div','rx-page'); const hero = el('header','rx-hero'); const intro = el('div'); intro.append(el('h1','', 'Make your AI sessions more effective.'), el('p','', 'SessionRx reads local session evidence, finds what is getting in the way, and helps you fix it.')); const chips = el('div','rx-cli-list'); const supported = (health?.collectors || []).filter((item) => item?.support === 'supported' && Number.isFinite(item.sessions)); chips.append(el('span','rx-chip',`${supported.length} CLIs detected`)); supported.forEach((item) => chips.append(el('span','rx-chip',item.cli))); hero.append(intro,chips); root.append(hero);
  const cumulativeSessions = sessions.map((_, index) => index + 1);
  const summaries = el('div','rx-grid rx-grid-four'); summaries.append(card('Sessions analyzed', 'sessions', number(health?.sessionsTotal), 'sessions in this scan', cumulativeSessions, null, 'accent'), card('Problems found', 'problems', number(rules.length), 'observed rule findings', sessions.map((s) => (s.rules || []).filter((r) => r?.evidence?.status === 'observed').length), null, 'warn'), card('Fixes available', 'fixes', number(fixable), 'observed findings with a fix', sessions.map((s) => (s.rules || []).filter((r) => r?.evidence?.status === 'observed' && r.fix).length), null, 'pass'), card('Not measured', 'unmeasured', number(unknown), 'checks that could not be measured', sessions.map((s) => s?.score?.unknown || 0), null, 'unknown')); root.append(summaries);
  const healthCard = el('section','rx-card'); const healthHead = el('div','rx-card-head'); const healthTitle = el('div', 'rx-section-title tone-pass'); healthTitle.append(iconBadge('health'), el('h2','', 'Health summary')); healthHead.append(healthTitle, el('span','rx-chip', `${unknown} could not be measured`)); healthCard.append(healthHead, donut(health, trends)); const calculation = document.createElement('details'); calculation.className = 'calculation-details'; calculation.append(el('summary', '', 'How is this calculated?'), el('p', '', `The donut counts passed, problem, and unknown checks across the ${sessions.length} sessions shown here. It shows passed checks out of checks that were measured; unknown checks are not a pass.`)); healthCard.append(calculation, el('p','local-note', health?.scan?.note || 'Health counts come from the analyzed sessions in this scan.'));
  const healthTrendRow = el('div', 'rx-grid rx-grid-two overview-health-row'); healthTrendRow.append(healthCard, trendsPreview(trends)); root.append(healthTrendRow);
  const lower = el('div','rx-grid rx-grid-two'); const fixes = el('section','rx-card'); fixes.append(el('h2','', 'Top fixes')); const distinct = new Map(); rules.forEach((item) => { const key = item.rule?.fix || ruleLabel(item.rule); if (!distinct.has(key)) distinct.set(key, item); }); const top = [...distinct.values()].slice(0,5); top.forEach((item,index) => { const row=el('div','fix-row'); row.append(el('span','rank',index+1)); const copy=el('div'); copy.append(el('span','fix-title',ruleLabel(item.rule))); const plain = plainText(item.rule); if (plain) copy.append(el('span','fix-sub',plain)); const actions=el('div'); const preview=button('Preview','button button-sm'); preview.addEventListener('click',()=>openFixModal({fixId:item.rule.fix,rule:item.rule,session:item.session,api})); const apply=button('Apply','button button-primary button-sm'); apply.addEventListener('click',()=>openFixModal({fixId:item.rule.fix,rule:item.rule,session:item.session,api})); actions.append(preview,apply); row.append(copy,actions); fixes.append(row); }); if (!top.length) fixes.append(el('p','not-measured','No observed fixable findings were measured.')); lower.append(fixes);
  const recent=el('section','rx-card'); recent.append(el('h2','', 'Recent sessions')); const table=el('div','rx-table-wrap'); const t=el('table','rx-table'); const headRow=el('tr'); ['CLI','Started','Duration','Turns','Health','Finding'].forEach((label)=>headRow.append(el('th','',label))); const thead=el('thead'); thead.append(headRow); t.append(thead); const body=el('tbody'); sessions.slice(0,8).forEach((session)=>{const row=el('tr'); row.addEventListener('click',()=>{location.hash=`#/sessions/${encodeURIComponent(session.sessionId || '')}`;}); const finding=(session.rules||[]).find((r)=>r?.evidence?.status==='observed'); const cliCell=el('td'); cliCell.append(cliIcon(session.cliName || session.cli), document.createTextNode(` ${session.cliName || session.cli || 'Unknown CLI'}`)); row.append(cliCell,el('td','',dateText(session.startedAt)),el('td','',duration(session.startedAt,session.endedAt)),el('td','',number(session.turnCount))); const healthCell=el('td'); healthCell.append(healthNode(session.score,true)); row.append(healthCell,el('td','',finding ? ruleLabel(finding) : 'No problem observed')); body.append(row);}); t.append(body); table.append(t); recent.append(table); lower.append(recent); root.append(lower); mount.replaceChildren(root);
}

registerPage('overview', renderOverview);
export default renderOverview;
