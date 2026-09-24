/**
 * Suggestions page — every suggestion SessionRx can offer, grouped by tool.
 *
 * SessionRx never writes a user's files. For each observed finding that
 * names a suggestion, this page shows the plain-language summary, a
 * Global / Project switch, the target, the preview text, and a "Copy
 * request" button that copies a ready-to-paste message for the user's own
 * AI coding tool. Nothing here implies SessionRx changed anything itself.
 */

import { rangeQuery, registerPage } from '../app.js';
import { copyToClipboard } from '../components/suggestion-panel.js';
import { button, el, icon, observedRules, ruleLabel, severity } from '../components/ui.js';

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

function callout(kind, title, message) {
  const box = el('div', `callout callout-${kind}`);
  box.append(el('p', 'callout-title', title));
  if (message) box.append(el('p', '', message));
  return box;
}

function statusNote(suggestion) {
  const status = suggestion?.status;
  if (status === 'already-added') return callout('ok', 'Already added', `SessionRx found this marker in ${suggestion.targetLabel || 'the target'} already.`);
  if (status === 'not-added') return callout('info', 'Not added yet', null);
  const reason = suggestion?.statusReason;
  const why = reason === 'project-path-not-resolvable'
    ? 'SessionRx cannot resolve a project path from here.'
    : reason === 'no-local-file'
      ? 'This target is not a local file SessionRx can read.'
      : 'SessionRx could not determine whether this is already added.';
  return callout('unknown', 'Could not be checked', `${why} That is not the same as "not added".`);
}

/** One suggestion card: summary, scope switch, target, preview, copy button. */
function suggestionCard(suggestion, api, { id, toolId }) {
  const card = el('article', 'rx-card suggestion-card');
  card.dataset.suggestionId = id;
  card.dataset.tool = toolId;

  if (suggestion?.available === false) {
    card.append(el('h3', '', 'No suggested change for this tool'), el('p', 'not-measured', suggestion.message || ''));
    return card;
  }

  card.append(el('h3', '', suggestion.title || id));
  card.append(el('p', 'suggestion-summary', suggestion.plainSummary || ''));

  const scopeState = { scope: suggestion.scope || 'global' };
  const switcher = el('div', 'scope-switch');
  switcher.setAttribute('role', 'group');
  switcher.setAttribute('aria-label', 'Global or project');
  const body = el('div', 'suggestion-body');

  async function renderScope(scope) {
    body.replaceChildren(el('p', 'empty-state', 'Loading…'));
    let fetched = suggestion;
    if (scope !== suggestion.scope) {
      try {
        const payload = await api.get(`/api/suggestions?id=${encodeURIComponent(id)}&tool=${encodeURIComponent(toolId)}&scope=${encodeURIComponent(scope)}`);
        fetched = Array.isArray(payload?.suggestions) ? payload.suggestions[0] : null;
      } catch (error) {
        body.replaceChildren(callout('error', 'Could not load this suggestion', error?.message || ''));
        return;
      }
    }
    if (!fetched) {
      body.replaceChildren(callout('error', 'No suggestion found', ''));
      return;
    }
    body.replaceChildren();
    const target = el('p', 'suggestion-target');
    target.append(el('strong', '', 'Target: '), document.createTextNode(fetched.targetLabel || 'not resolved'));
    body.append(target);
    body.append(statusNote(fetched));
    const pre = el('pre', 'diff');
    pre.textContent = fetched.preview || '';
    body.append(el('h4', '', 'preview'), pre);

    const actions = el('div', 'toolbar');
    const copyBtn = button('Copy request', 'button button-primary button-sm');
    const status = el('span', 'copy-status', '');
    copyBtn.addEventListener('click', async () => {
      const ok = await copyToClipboard(fetched.request || '');
      status.textContent = ok ? 'Copied.' : 'Could not copy automatically — select the text below and copy it.';
    });
    actions.append(copyBtn, status);
    body.append(actions);

    const requestBox = el('pre', 'diff');
    requestBox.textContent = fetched.request || '';
    body.append(el('h4', '', 'request'), requestBox);
  }

  ['global', 'project'].forEach((scope) => {
    const scopeButton = button(scope === 'global' ? 'Global' : 'Project', `button button-sm${scope === scopeState.scope ? ' is-active' : ''}`);
    scopeButton.setAttribute('aria-pressed', scope === scopeState.scope ? 'true' : 'false');
    scopeButton.addEventListener('click', () => {
      if (scope === scopeState.scope) return;
      scopeState.scope = scope;
      switcher.querySelectorAll('button').forEach((btn) => btn.classList.remove('is-active'));
      scopeButton.classList.add('is-active');
      renderScope(scope);
    });
    switcher.append(scopeButton);
  });
  card.append(switcher, body);
  renderScope(scopeState.scope);
  return card;
}

async function renderFixes(mount, data, ctx = {}) {
  if (!mount) return;
  const api = ctx.api;
  const health = data?.health || await api.get(`/api/health${rangeQuery('/api/health')}`);
  const toolsPayload = await api.get('/api/suggestions?scope=global');
  const tools = Array.isArray(toolsPayload?.tools) ? toolsPayload.tools : [];

  const allItems = observedRules(health?.sessions || []).filter((item) => item.rule?.fix);
  // Group by (fix id, target tool) — one card per distinct suggestion a
  // finding actually offers, never duplicated per session.
  const byKey = new Map();
  allItems.forEach((item) => {
    const id = item.rule.fix;
    const toolId = item.rule.suggestionTool;
    if (!id || !toolId) return;
    const key = `${id}::${toolId}`;
    if (!byKey.has(key)) byKey.set(key, { id, toolId, title: item.rule.suggestionTitle || ruleLabel(item.rule), count: 0, sample: item });
    byKey.get(key).count += 1;
  });

  const root = el('div', 'rx-page');
  const head = el('div', 'rx-card-head');
  head.append(el('h1', '', 'Suggestions'));
  head.append(el('p', 'rx-label', 'SessionRx never changes your files. Each suggestion below is a preview and a '
    + 'ready-to-paste request for your own AI coding tool to act on.'));
  root.append(head);

  if (!byKey.size) {
    root.append(el('p', 'not-measured', 'No observed finding with a suggested change was found in the current scan.'));
    mount.replaceChildren(root);
    return;
  }

  // Group cards by tool, since a suggestion always targets the tool whose
  // session showed the problem.
  const byTool = new Map();
  for (const entry of byKey.values()) {
    if (!byTool.has(entry.toolId)) byTool.set(entry.toolId, []);
    byTool.get(entry.toolId).push(entry);
  }

  for (const [toolId, entries] of byTool) {
    const toolLabel = tools.find((t) => t.id === toolId)?.label || toolId;
    const section = el('section', 'rx-card');
    section.append(sectionTitle(`${toolLabel} (${entries.length})`, 'fixes'));
    const grid = el('div', 'rx-grid rx-grid-even');
    for (const entry of entries) {
      let suggestion = null;
      try {
        const payload = await api.get(`/api/suggestions?id=${encodeURIComponent(entry.id)}&tool=${encodeURIComponent(entry.toolId)}&scope=global`);
        suggestion = Array.isArray(payload?.suggestions) ? payload.suggestions[0] : null;
      } catch {
        suggestion = null;
      }
      if (!suggestion) {
        const card = el('article', 'rx-card');
        card.append(el('h3', '', entry.title), el('p', 'not-measured', 'This suggestion could not be loaded.'));
        grid.append(card);
        continue;
      }
      const card = suggestionCard(suggestion, api, { id: entry.id, toolId: entry.toolId });
      card.append(el('p', 'rx-label', `${entry.count} occurrence(s) in the loaded health view · ${severity(entry.sample.rule)}`));
      grid.append(card);
    }
    section.append(grid);
    root.append(section);
  }

  mount.replaceChildren(root);
}

registerPage('fixes', renderFixes);
export default renderFixes;
