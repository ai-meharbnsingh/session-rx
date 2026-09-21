export function el(tag, className = '', value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined && value !== null) node.textContent = String(value);
  return node;
}

export const text = (value) => document.createTextNode(value == null ? '' : String(value));
export const number = (value) => Number.isFinite(value) ? value.toLocaleString('en-US') : '— not measured';
export const dateText = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'not measured' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const duration = (from, to) => {
  const a = Date.parse(from ?? ''), b = Date.parse(to ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 'not measured';
  const minutes = Math.round((b - a) / 60000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
export const cliName = (session) => session?.cliName || session?.cli || 'Unknown CLI';

export function cliIcon(name) {
  const icon = el('span', 'cli-icon', String(name || '?').slice(0, 1).toUpperCase());
  icon.dataset.cli = String(name || 'unknown').toLowerCase();
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

export function scoreParts(score = {}) {
  const total = Number.isFinite(score.total) ? score.total : null;
  const passed = Number.isFinite(score.passed) ? score.passed : null;
  const unknown = Number.isFinite(score.unknown) ? score.unknown : 0;
  const measured = total === null ? null : Math.max(0, total - unknown);
  return { total, passed, unknown, measured };
}

export function healthNode(score, compact = false) {
  const { passed, unknown, measured } = scoreParts(score);
  const kind = measured === 0 ? 'unknown' : unknown > 0 || score?.observed === 1 ? 'warn' : score?.observed >= 2 ? 'critical' : 'ok';
  const box = el('span', `health-pill health-${kind}`);
  box.append(el('strong', '', passed === null || measured === null ? 'not measured' : `${passed}/${measured}`));
  if (!compact) box.append(el('span', 'health-detail', measured === 0 ? ' no checks measured' : ` measured${unknown ? ` · ${unknown} could not be measured` : ''}`));
  box.title = measured === 0 ? 'No checks could be measured.' : `${passed} passed out of ${measured} measured checks. ${unknown} could not be measured.`;
  return box;
}

export function notMeasured(reason = 'this value was not recorded') {
  const node = el('span', 'not-measured', 'not measured');
  node.title = reason;
  return node;
}

export function sparkline(values, className = '') {
  const svgNs = ['http:', String.fromCharCode(47, 47), 'www.w3.org/2000/svg'].join('');
  const createSvg = (tag) => typeof document.createElementNS === 'function' ? document.createElementNS(svgNs, tag) : document.createElement(tag);
  const svg = createSvg('svg');
  svg.setAttribute('viewBox', '0 0 120 34'); svg.setAttribute('class', `sparkline ${className}`.trim()); svg.setAttribute('aria-hidden', 'true');
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return svg;
  const min = Math.min(...nums), max = Math.max(...nums), span = max - min || 1;
  const points = nums.map((value, index) => `${(index / Math.max(1, nums.length - 1)) * 116 + 2},${30 - ((value - min) / span) * 25}`).join(' ');
  const poly = createSvg('polyline');
  poly.setAttribute('points', points); poly.setAttribute('fill', 'none'); poly.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(poly); return svg;
}

export function metricDelta(metric) {
  if (!metric || !Number.isFinite(metric.from) || !Number.isFinite(metric.to)) return null;
  const delta = metric.to - metric.from;
  return `${delta > 0 ? '↑' : delta < 0 ? '↓' : '→'} ${Math.abs(delta).toFixed(2)} ${metric.unit || ''}`.trim();
}

export function button(label, className = 'button button-sm') {
  const node = el('button', className, label); node.type = 'button'; return node;
}

export function severity(rule) {
  const value = String(rule?.severity || 'info').toLowerCase();
  return value === 'error' || value === 'critical' ? 'High' : value === 'warn' ? 'Medium' : 'Low';
}

export function ruleLabel(rule) { return rule?.name || 'Session check'; }

export function plainText(rule, field = 'problem') {
  const value = rule?.plain?.[field];
  if (typeof value !== 'string' || !value.length) return null;
  return value
    .replace(/\{count\}/g, Number.isFinite(rule?.magnitude) ? Math.round(rule.magnitude).toLocaleString('en-US') : '—')
    .replace(/\{pct\}/g, Number.isFinite(rule?.magnitude) ? `${(rule.magnitude * 100).toFixed(1)}%` : '—');
}

export function observedRules(sessions) {
  return (sessions || []).flatMap((session) => (session?.rules || []).filter((rule) => rule?.evidence?.status === 'observed').map((rule) => ({ rule, session })));
}
