const ROUTES = new Set(['health', 'trends', 'sessions', 'report']);
const pages = new Map();

export const store = {
  data: { health: null, sessions: null, trends: null, report: null, collectors: null },
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
  const response = await fetch(path, { ...options, method, headers });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
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
  const endpoint = { health: '/api/health', trends: '/api/trends', sessions: '/api/sessions', report: '/api/report' }[route];
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

const renderRoute = async () => {
  const route = routeFromHash();
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.route === route));
  document.querySelectorAll('.page-mount').forEach((mount) => { mount.hidden = mount.dataset.page !== route; });
  try {
    const data = await loadRouteData(route);
    const render = pages.get(route);
    if (render) await render(document.querySelector(`#page-${route}`), data, { store, api, navigate });
    showStatus('', '');
  } catch (error) { showStatus(error.message || 'Unable to load session evidence.', 'error'); }
};

globalThis.addEventListener('hashchange', renderRoute);
globalThis.addEventListener('DOMContentLoaded', () => { loadCollectors(); renderRoute(); });

