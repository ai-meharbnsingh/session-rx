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

/**
 * Whether one catalogue fix is in place on this machine, as exactly one of
 * three answers: applied | not-applied | unknown. There is no fourth.
 *
 * WHY THE PAGE HAS TO ASK: the health verdicts cannot answer this. A fix that
 * worked makes its own finding stop being observed, so a page that reads only
 * the verdicts loses sight of every fix the user applied — which is the one
 * list they need to undo anything.
 *
 * `unknown` is not "not applied" and is never a pass: a check that could not
 * run, a fix that could not be loaded, and a request that failed all land here
 * carrying the reason they gave, which the UI then puts on screen.
 *
 * @returns {Promise<{id: string, title: string, state: string, detail: ?string}>}
 */
async function fixApplyState(api, fix) {
  const id = String(fix?.id ?? '');
  const title = fix?.title || id;
  const firstText = (...values) => values.find((value) => typeof value === 'string' && value.length) || null;
  if (fix?.available === false) {
    return { id, title, state: 'unknown', detail: firstText(fix?.reason) || 'this fix could not be loaded on this machine' };
  }
  let checked;
  try {
    checked = await api.get(`/api/fixes/${encodeURIComponent(id)}/check`);
  } catch (error) {
    return { id, title, state: 'unknown', detail: firstText(error?.message) || 'the check could not be reached' };
  }
  const status = typeof checked?.status === 'string' ? checked.status : null;
  const said = firstText(checked?.message, checked?.reason);
  const detail = said && checked?.reason && checked.message ? `${checked.message} (${checked.reason})` : said;
  if (status === 'unknown') return { id, title, state: 'unknown', detail: detail || 'the check did not say why' };
  if (status === 'applied' || checked?.applied === true) {
    // A drifted-but-applied fix keeps its reason visible: the file moved under it.
    return { id, title, state: 'applied', detail: checked?.drifted === true ? detail : null };
  }
  if (status === 'not-applied' || checked?.applied === false) return { id, title, state: 'not-applied', detail: null };
  return { id, title, state: 'unknown', detail: 'the check did not report whether this fix is in place' };
}

/**
 * Ask about every catalogue fix that can be applied at all.
 *
 * Returns `null` — not an empty list — when there is no client to ask with, so
 * a caller renders nothing rather than an empty list that would read as "you
 * have applied none of these".
 */
async function fixApplyStates(api, catalog) {
  if (!api || typeof api.get !== 'function') return null;
  const rows = (catalog || []).filter((fix) => fix?.id && fix?.applyable !== false);
  if (!rows.length) return [];
  return Promise.all(rows.map((fix) => fixApplyState(api, fix)));
}

/** The fixes already in place, each under the one action that reverses it. */
function appliedFixesSection(states, api) {
  const applied = states.filter((row) => row.state === 'applied');
  if (!applied.length) return null;
  const section = el('section', 'rx-card applied-fixes');
  section.append(sectionTitle('Applied fixes', 'fixes'));
  section.append(el('p', 'rx-label', applied.length === 1
    ? 'One fix is in place on this machine. Undo restores the file it changed.'
    : `${applied.length} fixes are in place on this machine. Undo restores the file each one changed.`));
  const strip = el('div', 'rx-grid rx-grid-even');
  // No slice: a user must be able to reach every fix they applied, not the first few.
  applied.forEach((row) => {
    const item = el('article', 'rx-card applied-fix');
    item.dataset.fixId = row.id;
    item.append(el('h3', '', row.title));
    if (row.detail) item.append(el('p', 'not-measured', row.detail));
    const undo = button('Undo', 'button button-sm');
    undo.dataset.action = 'undo-fix';
    undo.dataset.fixId = row.id;
    undo.setAttribute('aria-label', `Undo ${row.title}`);
    undo.addEventListener('click', () => openFixModal({ fixId: row.id, api }));
    item.append(undo);
    strip.append(item);
  });
  section.append(strip);
  return section;
}

/** The third state, on screen with its reason — never folded into either of the other two. */
function uncheckedFixesSection(states, api) {
  const unknown = states.filter((row) => row.state === 'unknown');
  if (!unknown.length) return null;
  const section = el('section', 'rx-card unchecked-fixes');
  section.append(sectionTitle('Fixes that could not be checked', 'fixes'));
  section.append(el('p', 'not-measured', 'Whether these are already in place could not be worked out. That is not the same as "not applied", and it is not a pass.'));
  const strip = el('div', 'rx-grid rx-grid-even');
  unknown.forEach((row) => {
    const item = el('article', 'rx-card unchecked-fix');
    item.dataset.fixId = row.id;
    item.append(el('h3', '', row.title));
    item.append(el('p', 'not-measured', row.detail || 'no reason was recorded'));
    const open = button('Open fix', 'button button-sm');
    open.dataset.action = 'open-fix';
    open.dataset.fixId = row.id;
    open.setAttribute('aria-label', `Open ${row.title}`);
    open.addEventListener('click', () => openFixModal({ fixId: row.id, api }));
    item.append(open);
    strip.append(item);
  });
  section.append(strip);
  return section;
}

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
  // Which fixes are already in place. Asked of the server, because the health
  // verdicts cannot say: a fix that worked stops its own finding being observed.
  const states = await fixApplyStates(api, catalog) || [];
  const stateById = new Map(states.map((row) => [row.id, row.state]));

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

  // Applied and could-not-check come FIRST, and are named for what they are.
  // Until this existed, a fix the user had applied survived only as an
  // unlabelled card in the recommendation strip below, six deep and capped.
  const applied = appliedFixesSection(states, api);
  if (applied) root.append(applied);
  const unchecked = uncheckedFixesSection(states, api);
  if (unchecked) root.append(unchecked);

  const other = el('section', 'rx-card'); other.append(sectionTitle('Other recommended fixes', 'fixes')); const strip = el('div', 'rx-grid rx-grid-even');
  // A fix already in place, or one whose state could not be read, is shown in
  // its own group above; recommending it here as well would say two things.
  catalog.filter((fix) => fix.id !== fixId && stateById.get(fix.id) !== 'applied' && stateById.get(fix.id) !== 'unknown').slice(0, 6).forEach((fix) => { const item = el('article', 'rx-card'); item.append(el('h3', '', fix.title)); const review = button('Review'); const found = allItems.findIndex((candidate) => candidate.rule?.fix === fix.id);
    // A fix no session triggered has no issue page to jump to; open the fix itself rather than landing on an unrelated issue.
    review.addEventListener('click', () => { if (found >= 0) location.hash = fixesHash('All issues', found); else openFixModal({ fixId: fix.id, api }); }); item.append(review); strip.append(item); });
  other.append(strip); root.append(other); mount.replaceChildren(root);
}

registerPage('fixes', renderFixes);
export default renderFixes;
