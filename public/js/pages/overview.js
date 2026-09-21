import { registerPage } from '../app.js';
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

function donut(health) {
  const sessions = health?.sessions || [];
  let passed = 0, observed = 0, unknown = 0, total = 0;
  sessions.forEach((session) => { passed += session?.score?.passed || 0; observed += session?.score?.observed || 0; unknown += session?.score?.unknown || 0; total += session?.score?.total || 0; });
  const measured = Math.max(0, total - unknown), circumference = 2 * Math.PI * 58;
  const wrap = el('div', 'donut-wrap');
  const svgNs = ['http:', String.fromCharCode(47, 47), 'www.w3.org/2000/svg'].join('');
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
  sub.textContent = 'measured'; svg.append(sub); wrap.append(svg);
  const legend = el('div'); legend.append(el('h3','', 'Issue distribution'));
  const parts = [['Problems found', observed, total, 'donut-observed'], ['Passed', passed, total, 'donut-pass'], ['Could not be measured', unknown, total, 'donut-unknown']];
  parts.forEach(([label, value, denominator, cls]) => { const row = el('div','bar-row'); row.append(el('span','',label), el('strong','', denominator ? `${Math.round(value / denominator * 100)}%` : 'not measured')); const trackBar = el('div','bar-track'); const fill = el('div',`bar-fill ${cls}`); fill.style.width = denominator ? `${value / denominator * 100}%` : '0%'; trackBar.append(fill); row.append(trackBar); legend.append(row); });
  wrap.append(legend); return wrap;
}

function trendsPreview(trends) {
  const section = el('section', 'rx-card'); const head = el('div','rx-card-head'); const title = el('div', 'rx-section-title tone-accent'); title.append(iconBadge('trends'), el('h2', '', 'Trends preview')); head.append(title, el('a','', 'View trends')); head.lastChild.href = '#/trends'; section.append(head);
  const metrics = Array.isArray(trends?.trend?.metrics) ? trends.trend.metrics : [];
  const charts = trends?.charts || {};
  const grid = el('div', 'trend-grid');
  metrics.forEach((metric, index) => { const box = el('article','trend-card'); box.append(el('h3','',metric.label)); const delta = metricDelta(metric); box.append(el('strong','trend-value', delta || 'not measured')); const series = Object.values(charts)[index] || []; const dir = Number.isFinite(metric.from) && Number.isFinite(metric.to) && metric.to !== metric.from
      ? (metric.to < metric.from ? 'pass' : 'warn') : 'accent';
    box.classList.add(`tone-${dir}`);
    box.append(sparkline(series.map((item) => item?.value ?? item?.highContextPct ?? item?.cacheHitPct).filter(Number.isFinite), `tone-${dir}`)); box.append(el('p','trend-note', `from ${metric.from} to ${metric.to} ${metric.unit || ''}`)); grid.append(box); });
  section.append(grid);
  if (!metrics.length) section.append(el('p','not-measured','No trend metric was measured for this window.'));
  return section;
}

async function renderOverview(mount, data, ctx = {}) {
  if (!mount) return;
  const api = ctx.api; const health = data || await api.get('/api/health');
  const [trends, fixesPayload] = await Promise.all([api.get('/api/trends'), api.get('/api/fixes')]);
  const sessions = health?.sessions || []; const rules = observedRules(sessions); const unknown = sessions.reduce((sum, s) => sum + (s?.score?.unknown || 0), 0); const fixable = rules.filter((item) => item.rule?.fix).length;
  const root = el('div','rx-page'); const hero = el('header','rx-hero'); const intro = el('div'); intro.append(el('h1','', 'Make your AI sessions more effective.'), el('p','', 'SessionRx reads local session evidence, finds what is getting in the way, and helps you fix it.')); const chips = el('div','rx-cli-list'); const supported = (health?.collectors || []).filter((item) => item?.support === 'supported' && Number.isFinite(item.sessions)); chips.append(el('span','rx-chip',`${supported.length} CLIs detected`)); supported.forEach((item) => chips.append(el('span','rx-chip',item.cli))); hero.append(intro,chips); root.append(hero);
  const cumulativeSessions = sessions.map((_, index) => index + 1);
  const summaries = el('div','rx-grid rx-grid-four'); summaries.append(card('Sessions analyzed', 'sessions', number(health?.sessionsTotal), 'sessions in this scan', cumulativeSessions, null, 'accent'), card('Problems found', 'problems', number(rules.length), 'observed rule findings', sessions.map((s) => (s.rules || []).filter((r) => r?.evidence?.status === 'observed').length), null, 'warn'), card('Fixes available', 'fixes', number(fixable), 'observed findings with a fix', sessions.map((s) => (s.rules || []).filter((r) => r?.evidence?.status === 'observed' && r.fix).length), null, 'pass'), card('Not measured', 'unmeasured', number(unknown), 'checks that could not be measured', sessions.map((s) => s?.score?.unknown || 0), null, 'unknown')); root.append(summaries);
  const healthCard = el('section','rx-card'); const healthHead = el('div','rx-card-head'); const healthTitle = el('div', 'rx-section-title tone-pass'); healthTitle.append(iconBadge('health'), el('h2','', 'Health summary')); healthHead.append(healthTitle, el('span','rx-chip', `${unknown} could not be measured`)); healthCard.append(healthHead, donut(health), el('p','local-note', health?.scan?.note || 'Health counts come from the analyzed sessions in this scan.')); root.append(healthCard, trendsPreview(trends));
  const lower = el('div','rx-grid rx-grid-two'); const fixes = el('section','rx-card'); fixes.append(el('h2','', 'Top fixes')); const distinct = new Map(); rules.forEach((item) => { const key = item.rule?.fix || ruleLabel(item.rule); if (!distinct.has(key)) distinct.set(key, item); }); const top = [...distinct.values()].slice(0,5); top.forEach((item,index) => { const row=el('div','fix-row'); row.append(el('span','rank',index+1)); const copy=el('div'); copy.append(el('span','fix-title',ruleLabel(item.rule))); const plain = plainText(item.rule); if (plain) copy.append(el('span','fix-sub',plain)); const actions=el('div'); const preview=button('Preview','button button-sm'); preview.addEventListener('click',()=>openFixModal({fixId:item.rule.fix,rule:item.rule,session:item.session,api})); const apply=button('Apply','button button-primary button-sm'); apply.addEventListener('click',()=>openFixModal({fixId:item.rule.fix,rule:item.rule,session:item.session,api})); actions.append(preview,apply); row.append(copy,actions); fixes.append(row); }); if (!top.length) fixes.append(el('p','not-measured','No observed fixable findings were measured.')); lower.append(fixes);
  const recent=el('section','rx-card'); recent.append(el('h2','', 'Recent sessions')); const table=el('div','rx-table-wrap'); const t=el('table','rx-table'); const headRow=el('tr'); ['CLI','Started','Duration','Turns','Health','Finding'].forEach((label)=>headRow.append(el('th','',label))); const thead=el('thead'); thead.append(headRow); t.append(thead); const body=el('tbody'); sessions.slice(0,8).forEach((session)=>{const row=el('tr'); row.addEventListener('click',()=>{location.hash=`#/sessions/${encodeURIComponent(session.sessionId || '')}`;}); const finding=(session.rules||[]).find((r)=>r?.evidence?.status==='observed'); const cliCell=el('td'); cliCell.append(cliIcon(session.cliName || session.cli), document.createTextNode(` ${session.cliName || session.cli || 'Unknown CLI'}`)); row.append(cliCell,el('td','',dateText(session.startedAt)),el('td','',duration(session.startedAt,session.endedAt)),el('td','',number(session.turnCount))); const healthCell=el('td'); healthCell.append(healthNode(session.score,true)); row.append(healthCell,el('td','',finding ? ruleLabel(finding) : 'No problem observed')); body.append(row);}); t.append(body); table.append(t); recent.append(table); lower.append(recent); root.append(lower); mount.replaceChildren(root);
}

registerPage('overview', renderOverview);
export default renderOverview;
