import { registerPage } from '../app.js';
import { openFixModal } from '../components/fix-modal.js';
import { button, el, observedRules, plainText, ruleLabel, severity } from '../components/ui.js';

function diffView(diff) {
  const box = el('div', 'diff-box');
  const raw = typeof diff === 'string' ? diff : '';
  if (!raw) { box.append(el('p', 'not-measured', 'The fix did not return a preview.')); return box; }
  raw.split('\n').forEach((line, index) => {
    const kind = line.startsWith('+') ? 'ins' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
    const row = el('span', `diff-line ${kind}`);
    row.append(el('span', 'diff-number', String(index + 1).padStart(3, ' ')), document.createTextNode(line)); box.append(row);
  });
  return box;
}

function categoryCount(name, items) {
  if (name === 'All issues') return items.length;
  return items.filter(({ rule }) => {
    const words = `${rule?.name || ''} ${rule?.fix || ''}`.toLowerCase();
    if (name === 'Configuration') return words.includes('compact') || words.includes('config');
    if (name === 'Context & memory') return words.includes('context') || words.includes('worker') || words.includes('agent');
    if (name === 'Tool usage') return words.includes('tool') || words.includes('repeat') || words.includes('batch');
    return words.includes('long') || words.includes('cache') || words.includes('performance');
  }).length;
}

function issueNavigation(index, total) {
  const nav = el('div', 'issue-nav');
  const previous = button('‹ Previous', 'button button-sm'); previous.disabled = index <= 0;
  previous.addEventListener('click', () => { location.hash = `#/fixes?issue=${index - 1}`; });
  const next = button('Next ›', 'button button-sm'); next.disabled = index >= total - 1;
  next.addEventListener('click', () => { location.hash = `#/fixes?issue=${index + 1}`; });
  nav.append(previous, el('span', 'rx-label', total ? `Issue ${index + 1} of ${total}` : 'No observed fixable issues'), next);
  return nav;
}

async function renderFixes(mount, data, ctx = {}) {
  if (!mount) return;
  const api = ctx.api;
  const health = data?.health || await api.get('/api/health');
  const fixesPayload = data?.fixes || await api.get('/api/fixes');
  const items = observedRules(health?.sessions || []).filter((item) => item.rule?.fix);
  const catalog = fixesPayload?.fixes || [];
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const requestedIndex = Number(query.get('issue') || 0);
  const selectedIndex = Math.min(Number.isFinite(requestedIndex) ? Math.max(0, requestedIndex) : 0, Math.max(0, items.length - 1));
  const selected = items[selectedIndex] || null;
  const fixId = selected?.rule?.fix || catalog[0]?.id;
  const descriptor = catalog.find((fix) => fix.id === fixId) || catalog[0];
  let preview = null;
  if (fixId) { try { preview = await api.post(`/api/fixes/${encodeURIComponent(fixId)}/preview`, {}); } catch (error) { preview = { error: error?.message || 'Preview unavailable' }; } }

  const root = el('div', 'rx-page');
  const top = el('div', 'rx-card-head'); const back = el('a', '', 'Back to issues'); back.href = '#/health';
  top.append(back, issueNavigation(selectedIndex, items.length)); root.append(top);
  const layout = el('div', 'fix-layout');
  const steps = el('aside', 'rx-card step-list'); steps.append(el('h2', '', 'Fix workflow'));
  [['Diagnose', 'Issues detected from your sessions', 'done'], ['Review & Fix', 'Apply a targeted change', 'active'], ['Verify', 'Continue with a healthier setup', '']].forEach(([name, copy, kind], index) => { const step = el('div', `step ${kind}`); step.append(el('strong', '', `${index + 1}. ${name}`), el('small', '', copy)); steps.append(step); });
  const categories = el('div', 'filter-group'); categories.append(el('h3', '', 'Issue categories'));
  ['All issues', 'Configuration', 'Context & memory', 'Tool usage', 'Performance'].forEach((name) => categories.append(el('div', 'filter-option', `${name} (${categoryCount(name, items)})`)));
  steps.append(categories); layout.append(steps);

  const detail = el('main', 'rx-card');
  if (!selected) detail.append(el('h2', '', 'No observed fixable issue'), el('p', 'not-measured', 'No rule with an available fix was observed in the current scan.'));
  else {
    detail.append(el('span', `severity ${severity(selected.rule).toLowerCase()}`, severity(selected.rule)), el('h1', 'issue-title', ruleLabel(selected.rule)));
    const problem = plainText(selected.rule, 'problem'); if (problem) detail.append(el('p', '', problem));
    const why = plainText(selected.rule, 'why'); if (why) { const section = el('section', 'rx-card'); section.append(el('h3', '', 'Why this happens'), el('p', '', why)); detail.append(section); }
    const benefit = plainText(selected.rule, 'benefit'); if (benefit) { const section = el('section', 'benefit'); section.append(el('h3', '', 'Expected benefit'), el('p', '', benefit)); detail.append(section); }
    const count = items.filter((item) => item.rule?.fix === selected.rule?.fix).length;
    detail.append(el('h3', '', 'Occurrences in recent sessions'));
    // Real per-day counts. The previous version invented bar heights from an
    // index, which drew a shape no data supported — on a tool whose whole claim
    // is that it never shows a number it cannot justify.
    const dayKey = (item) => { const raw = item?.session?.startedAt; const when = raw ? new Date(raw) : null; return when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 10) : null; };
    const dated = items.filter((item) => dayKey(item) !== null);
    if (!dated.length) {
      detail.append(el('p', 'not-measured', 'These findings carry no session start time, so they cannot be placed on a timeline. The total below is still exact.'));
    } else {
      const byDay = new Map();
      dated.forEach((item) => { const key = dayKey(item); const slot = byDay.get(key) || { mine: 0, other: 0 }; if (item.rule?.fix === selected.rule?.fix) slot.mine += 1; else slot.other += 1; byDay.set(key, slot); });
      const days = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-14);
      const peak = Math.max(1, ...days.map(([, slot]) => slot.mine + slot.other));
      const chart = el('div', 'occurrence-chart');
      days.forEach(([day, slot]) => {
        const column = el('span', 'occurrence-col');
        column.title = `${day}: ${slot.mine} of this issue, ${slot.other} other`;
        const mine = el('span', 'occurrence-bar occurrence-mine'); mine.style.height = `${slot.mine / peak * 100}%`;
        const other = el('span', 'occurrence-bar occurrence-other'); other.style.height = `${slot.other / peak * 100}%`;
        column.append(other, mine); chart.append(column);
      });
      const legend = el('p', 'occurrence-legend');
      legend.append(el('span', 'legend-key legend-mine', 'this issue'), el('span', 'legend-key legend-other', 'other issues'));
      detail.append(chart, legend);
    }
    detail.append(el('p', 'rx-label', `${count} observed finding(s) in the loaded health view`));
  }
  layout.append(detail);

  const proposed = el('aside', 'rx-card fix-proposed'); proposed.append(el('h2', '', 'Proposed fix'), el('span', 'rx-chip', 'Safe change'), el('p', '', descriptor?.title || 'The selected fix'));
  proposed.append(el('p', 'rx-label', preview?.targets?.[0]?.display || preview?.files_affected?.[0] || 'Target file not measured'));
  if (selected?.session && selected.session.cli !== descriptor?.cli) proposed.append(el('p', 'local-note', `This finding came from ${selected.session.cliName || selected.session.cli || 'one CLI'}; the proposed fix targets the configuration for another CLI.`));
  proposed.append(preview?.error ? el('p', 'not-measured', preview.error) : diffView(preview?.diff));
  const actions = el('div', 'toolbar'); [['Preview', 'button'], ['Apply fix', 'button button-primary'], ['Undo', 'button button-danger']].forEach(([label, className]) => { const action = button(label, className); action.addEventListener('click', () => openFixModal({ fixId, rule: selected?.rule, session: selected?.session, api })); actions.append(action); });
  actions.append(el('span', 'local-note', 'Only local files are changed. Nothing is sent anywhere.')); proposed.append(actions); layout.append(proposed); root.append(layout);

  const other = el('section', 'rx-card'); other.append(el('h2', '', 'Other recommended fixes')); const strip = el('div', 'rx-grid rx-grid-three');
  catalog.filter((fix) => fix.id !== fixId).slice(0, 6).forEach((fix) => { const item = el('article', 'rx-card'); item.append(el('h3', '', fix.title)); const review = button('Review'); review.addEventListener('click', () => { location.hash = `#/fixes?issue=${Math.max(0, items.findIndex((candidate) => candidate.rule?.fix === fix.id))}`; }); item.append(review); strip.append(item); });
  other.append(strip); root.append(other); mount.replaceChildren(root);
}

registerPage('fixes', renderFixes);
export default renderFixes;
