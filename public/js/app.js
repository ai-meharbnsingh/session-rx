const ROUTES = new Set(['overview', 'health', 'trends', 'sessions', 'fixes', 'report']);
const pages = new Map();

export const store = {
  data: { overview: null, health: null, sessions: null, trends: null, fixes: null, report: null, collectors: null },
  loading: false,
  error: null,
};

const csrfToken = () => document.querySelector('meta[name="csrf-token"]')?.content
  || globalThis.__SESSION_RX_BOOTSTRAP__?.csrfToken || '';

const showStatus = (message = '', kind = '') => {
  const node = document.querySelector('#app-status');
  if (!node) return;
  node.textContent = message;
  node.className = `status-region ${kind}`.trim();
  node.hidden = !message;
};

const request = async (path, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('Content-Type', 'application/json');
    const token = csrfToken();
    if (token) headers.set('X-CSRF-Token', token);
  }
  let response;
  try {
    response = await fetch(path, { ...options, method, headers });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const host = globalThis.location?.host ? ` at ${globalThis.location.host}` : '';
    throw new Error(
      `The SessionRx server${host} is not responding — it is probably no longer running; restart it with npx session-rx and reload this page.`,
      { cause: error },
    );
  }
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    if (body?.reason === 'csrf_token_mismatch' || body?.reason === 'csrf_token_missing') {
      throw new Error(
        'This page was loaded from an earlier run of SessionRx — reload the page for this action to work.',
        { cause: body },
      );
    }
    const detail = typeof body?.error === 'string' ? body.error : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return body;
};

export const api = {
  get: request,
  post: (path, body = {}) => request(path, { method: 'POST', body: JSON.stringify(body) }),
};

const routeFromHash = () => {
  const candidate = globalThis.location.hash.replace(/^#\/?/, '').split('/')[0];
  if (!candidate) return 'overview';
  return ROUTES.has(candidate) ? candidate : 'health';
};

const renderCollectors = (payload) => {
  const list = document.querySelector('#detected-clis');
  const count = document.querySelector('#cli-count');
  if (!list || !count) return;
  const collectors = Array.isArray(payload?.collectors) ? payload.collectors : [];
  const installed = collectors.filter((item) => item?.installed === true).length;
  count.textContent = `${installed} detected`;
  count.className = `badge ${installed ? 'badge-ok' : 'badge-unknown'}`;
  list.replaceChildren();
  if (!collectors.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No collector data available.';
    list.append(empty);
    return;
  }
  collectors.forEach((collector) => {
    const row = document.createElement('div');
    row.className = 'cli-item';
    const name = document.createElement('span');
    name.className = 'cli-name';
    name.textContent = collector?.displayName || collector?.id || 'Unknown CLI';
    const status = document.createElement('span');
    status.className = `cli-status ${collector?.installed ? 'badge-ok' : 'badge-unknown'}`;
    status.textContent = collector?.installed ? (collector.status || 'detected') : 'not detected';
    row.append(name, status);
    list.append(row);
  });
};

const loadCollectors = async () => {
  try {
    store.data.collectors = await api.get('/api/collectors');
    renderCollectors(store.data.collectors);
  } catch (error) {
    const list = document.querySelector('#detected-clis');
    if (list) { list.replaceChildren(); const message = document.createElement('p'); message.className = 'empty-state'; message.textContent = 'Collector status unavailable.'; list.append(message); }
  }
};

const loadRouteData = async (route) => {
  const endpoint = { overview: null, health: '/api/health', trends: '/api/trends', sessions: '/api/sessions', fixes: null, report: '/api/report' }[route];
  if (!endpoint || store.data[route]) return store.data[route];
  store.loading = true;
  showStatus('Loading local session evidence…', 'loading');
  try {
    store.data[route] = await api.get(endpoint);
    store.error = null;
    return store.data[route];
  } catch (error) {
    store.error = error;
    throw error;
  } finally { store.loading = false; }
};

export const registerPage = (name, render) => {
  if (ROUTES.has(name) && typeof render === 'function') pages.set(name, render);
};

export const navigate = (route) => {
  const next = ROUTES.has(route) ? route : 'health';
  globalThis.location.hash = `#/${next}`;
};

/** Runtime contract guard: source scans cannot catch evidence text that is
 * legitimate in the rule catalogue but unsafe when it reaches a new page. */
export function assertRenderedDomPlainLanguage(root) {
  const text = root?.textContent || '';
  const forbidden = /DIS-\d|BP-\d|\bF-\d|sidechain|linkage|denominator|corpus|magnitude|\{count\}|\{pct\}|\[object (?:HTML|SVG)/i;
  const match = text.match(forbidden);
  if (match) {
    root.dataset.uiContractViolation = match[0];
    return false;
  }
  return true;
}

const renderRoute = async () => {
  const route = routeFromHash();
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.route === route));
  document.querySelectorAll('.page-mount').forEach((mount) => { mount.hidden = mount.dataset.page !== route; });
  try {
    const data = await loadRouteData(route);
    const render = pages.get(route);
    if (render) {
      const mount = document.querySelector(`#page-${route}`);
      await render(mount, data, { store, api, navigate });
      if (['overview', 'sessions', 'fixes'].includes(route)) assertRenderedDomPlainLanguage(mount);
    }
    showStatus('', '');
  } catch (error) { showStatus(error.message || 'Unable to load session evidence.', 'error'); }
};

globalThis.addEventListener('hashchange', renderRoute);
globalThis.addEventListener('DOMContentLoaded', () => { loadCollectors(); renderRoute(); });
