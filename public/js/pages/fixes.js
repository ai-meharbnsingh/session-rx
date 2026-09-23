import { rangeQuery, registerPage } from '../app.js';
import { openFixModal } from '../components/fix-modal.js';
import { button, el, icon, observedRules, plainText, ruleLabel, severity } from '../components/ui.js';

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

const CATEGORIES = ['All issues', 'Configuration', 'Context & memory', 'Tool usage', 'Performance'];

function inCategory(name, { rule }) {
  if (name === 'All issues') return true;
  const words = `${rule?.name || ''} ${rule?.fix || ''}`.toLowerCase();
  if (name === 'Configuration') return words.includes('compact') || words.includes('config');
  if (name === 'Context & memory') return words.includes('context') || words.includes('worker') || words.includes('agent');
  if (name === 'Tool usage') return words.includes('tool') || words.includes('repeat') || words.includes('batch');
  return words.includes('long') || words.includes('cache') || words.includes('performance');
}

/** The hash for one issue within one category; the category is kept across Previous/Next. */
function fixesHash(category, issue) {
  const query = new URLSearchParams();
  if (category && category !== 'All issues') query.set('cat', category);
  query.set('issue', String(issue));
  return `#/fixes?${query}`;
}

/**
 * Whether the fix changes the settings of the CLI the finding came from.
 * `rule.fixCli` is stamped by the server (annotateFixTitles); the /api/fixes
 * catalogue carries no CLI, so it cannot answer this.
 */
function fixScopeChip(session, rule) {
  if (!session || !rule?.fixCli) return el('span', 'rx-chip rx-chip-muted', 'Fix target not measured');
  if (session.cli === rule.fixCli) return el('span', 'rx-chip', 'Fix available for your CLI');
  return el('span', 'rx-chip rx-chip-muted', 'Recommendation only');
}

function issueNavigation(index, total, category) {
  const nav = el('div', 'issue-nav');
  const previous = button('‹ Previous', 'button button-sm'); previous.disabled = index <= 0;
  previous.addEventListener('click', () => { location.hash = fixesHash(category, index - 1); });
  const next = button('Next ›', 'button button-sm'); next.disabled = index >= total - 1;
  next.addEventListener('click', () => { location.hash = fixesHash(category, index + 1); });
  nav.append(previous, el('span', 'rx-label', total ? `Issue ${index + 1} of ${total}` : 'No observed fixable issues'), next);
  return nav;
}

async function renderFixes(mount, data, ctx = {}) {
  if (!mount) return;
  const api = ctx.api;
  const health = data?.health || await api.get(`/api/health${rangeQuery('/api/health')}`);
  const fixesPayload = data?.fixes || await api.get('/api/fixes');
  const allItems = observedRules(health?.sessions || []).filter((item) => item.rule?.fix);
  const catalog = fixesPayload?.fixes || [];
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const category = CATEGORIES.includes(query.get('cat')) ? query.get('cat') : 'All issues';
  const items = allItems.filter((item) => inCategory(category, item));
  const requestedIndex = Number(query.get('issue') || 0);
  const selectedIndex = Math.min(Number.isFinite(requestedIndex) ? Math.max(0, requestedIndex) : 0, Math.max(0, items.length - 1));
  const selected = items[selectedIndex] || null;
  const fixId = selected?.rule?.fix || catalog[0]?.id;
  const descriptor = catalog.find((fix) => fix.id === fixId) || catalog[0];
  let preview = null;
  if (fixId) { try { preview = await api.post(`/api/fixes/${encodeURIComponent(fixId)}/preview`, {}); } catch (error) { preview = { error: error?.message || 'Preview unavailable' }; } }

  const root = el('div', 'rx-page');
  const top = el('div', 'rx-card-head'); const back = el('a', '', 'Back to issues'); back.href = '#/health';
  top.append(back, issueNavigation(selectedIndex, items.length, category)); root.append(top);
  const layout = el('div', 'fix-layout');
  const steps = el('aside', 'rx-card step-list'); steps.append(sectionTitle('Fix workflow', 'fixes'));
  [['Diagnose', 'Issues detected from your sessions', 'done'], ['Review & Fix', 'Apply a targeted change', 'active'], ['Verify', 'Continue with a healthier setup', '']].forEach(([name, copy, kind], index) => { const step = el('div', `step ${kind}`); step.append(el('strong', '', `${index + 1}. ${name}`), el('small', '', copy)); steps.append(step); });
  const categories = el('div', 'filter-group'); categories.append(el('h3', '', 'Issue categories'));
  CATEGORIES.forEach((name) => {
    const choice = button(`${name} (${allItems.filter((item) => inCategory(name, item)).length})`, `filter-option${name === category ? ' is-active' : ''}`);
    choice.dataset.category = name;
    choice.setAttribute('aria-pressed', name === category ? 'true' : 'false');
    choice.addEventListener('click', () => { location.hash = fixesHash(name, 0); });
    categories.append(choice);
  });
  steps.append(categories); layout.append(steps);

  const detail = el('main', 'rx-card');
  if (!selected) detail.append(el('h2', '', 'No observed fixable issue'), el('p', 'not-measured', category === 'All issues' ? 'No rule with an available fix was observed in the current scan.' : `No rule with an available fix was observed in the "${category}" category.`));
  else {
    detail.append(el('span', `severity ${severity(selected.rule).toLowerCase()}`, severity(selected.rule)), el('h1', 'issue-title', ruleLabel(selected.rule)));
    const problem = plainText(selected.rule, 'problem'); if (problem) detail.append(el('p', '', problem));
    const why = plainText(selected.rule, 'why'); if (why) { const section = el('section', 'rx-card'); section.append(el('h3', '', 'Why this happens'), el('p', '', why)); detail.append(section); }
    const benefit = plainText(selected.rule, 'benefit'); if (benefit) { const section = el('section', 'benefit'); section.append(el('h3', '', 'Expected benefit'), el('p', '', benefit)); detail.append(section); }
    const count = items.filter((item) => item.rule?.fix === selected.rule?.fix).length;
    detail.append(sectionTitle('Occurrences in recent sessions', 'trends'));
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

  const proposed = el('aside', 'rx-card fix-proposed'); proposed.append(sectionTitle('Proposed fix', 'fixes'), fixScopeChip(selected?.session, selected?.rule), el('p', '', descriptor?.title || 'The selected fix'));
  proposed.append(el('p', 'rx-label', preview?.targets?.[0]?.display || preview?.files_affected?.[0] || 'Target file not measured'));
  if (selected?.session && selected.rule?.fixCli && selected.session.cli !== selected.rule.fixCli) proposed.append(el('p', 'local-note', `This finding came from ${selected.session.cliName || selected.session.cli || 'one CLI'}; no automated fix exists for it. The proposed fix changes ${selected.rule.fixCliName || selected.rule.fixCli}'s settings instead.`));
  proposed.append(preview?.error ? el('p', 'not-measured', preview.error) : diffView(preview?.diff));
  // One button, one honest label. The modal is the whole workflow — it shows the
  // exact change, applies it only on a second click, and offers Undo once it is
  // applied — so three page buttons that all opened it were three promises of
  // different actions kept by the same one.
  const actions = el('div', 'toolbar');
  const review = button('Review fix', 'button button-primary');
  review.dataset.action = 'review-fix';
  review.disabled = !fixId;
  review.addEventListener('click', () => openFixModal({ fixId, rule: selected?.rule, session: selected?.session, api }));
  actions.append(review);
  actions.append(el('span', 'local-note', 'Opens the fix: check the exact change, apply it, and undo it from the same window. Only local files are changed. Nothing is sent anywhere.')); proposed.append(actions); layout.append(proposed); root.append(layout);

  const other = el('section', 'rx-card'); other.append(sectionTitle('Other recommended fixes', 'fixes')); const strip = el('div', 'rx-grid rx-grid-even');
  catalog.filter((fix) => fix.id !== fixId).slice(0, 6).forEach((fix) => { const item = el('article', 'rx-card'); item.append(el('h3', '', fix.title)); const review = button('Review'); const found = allItems.findIndex((candidate) => candidate.rule?.fix === fix.id);
    // A fix no session triggered has no issue page to jump to; open the fix itself rather than landing on an unrelated issue.
    review.addEventListener('click', () => { if (found >= 0) location.hash = fixesHash('All issues', found); else openFixModal({ fixId: fix.id, api }); }); item.append(review); strip.append(item); });
  other.append(strip); root.append(other); mount.replaceChildren(root);
}

registerPage('fixes', renderFixes);
export default renderFixes;
