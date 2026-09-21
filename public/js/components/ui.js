export function el(tag, className = '', value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined && value !== null) node.textContent = String(value);
  return node;
}

export const text = (value) => document.createTextNode(value == null ? '' : String(value));
export const number = (value) => Number.isFinite(value) ? value.toLocaleString('en-US') : '— not measured';
/** Convert shares into whole percentages without losing the total to rounding. */
export function largestRemainder(values, total = 100) {
  const exact = values.map((value) => Math.max(0, Number(value) || 0));
  const floors = exact.map((value) => Math.floor(value));
  let remainder = total - floors.reduce((sum, value) => sum + value, 0);
  [...exact.keys()]
    .sort((a, b) => (exact[b] - floors[b]) - (exact[a] - floors[a]) || a - b)
    .slice(0, Math.max(0, remainder))
    .forEach((index) => { floors[index] += 1; remainder -= 1; });
  return floors;
}
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

const svgNs = ['http:', String.fromCharCode(47, 47), 'www.w3.org/2000/svg'].join('');
const createSvg = (tag) => typeof document.createElementNS === 'function' ? document.createElementNS(svgNs, tag) : document.createElement(tag);

export function sparkline(values, className = '', options = {}) {
  const svg = createSvg('svg');
  svg.setAttribute('viewBox', '0 0 120 34'); svg.setAttribute('class', `sparkline ${className}`.trim()); svg.setAttribute('aria-hidden', 'true');
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return svg;
  const min = Math.min(...nums), max = Math.max(...nums), span = max - min || 1;
  if (options.bars) {
    nums.forEach((value, index) => {
      const rect = createSvg('rect');
      const width = Math.max(3, 92 / nums.length); const x = 2 + index / Math.max(1, nums.length) * 116;
      const height = Math.max(3, ((value - min) / span) * 25 + 5);
      rect.setAttribute('x', String(x)); rect.setAttribute('y', String(30 - height)); rect.setAttribute('width', String(width)); rect.setAttribute('height', String(height)); rect.setAttribute('rx', '1.5');
      svg.append(rect);
    });
    return svg;
  }
  const points = nums.map((value, index) => `${(index / Math.max(1, nums.length - 1)) * 116 + 2},${30 - ((value - min) / span) * 25}`).join(' ');
  const poly = createSvg('polyline');
  poly.setAttribute('points', points); poly.setAttribute('fill', 'none'); poly.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(poly); return svg;
}

export function icon(name) {
  const svg = createSvg('svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const shapes = {
    sessions: [['path', { d: 'M6 3.5h8l4 4V20.5H6z' }], ['path', { d: 'M14 3.5v4h4M9 11h6M9 14.5h6M9 18h4' }]],
    problems: [['path', { d: 'm12 4 9 16H3z' }], ['path', { d: 'M12 9v5M12 17.5h.01' }]],
    fixes: [['path', { d: 'M14.5 5.5a4 4 0 0 0-5.1 5.1L4.7 15.3a2.1 2.1 0 1 0 3 3l4.7-4.7a4 4 0 0 0 5.1-5.1l-2.2 2.2-2.8-2.8z' }]],
    unmeasured: [['path', { d: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.3A10.8 10.8 0 0 1 12 5c5 0 8.8 4.3 10 7a14.7 14.7 0 0 1-3.1 4.3M6.1 6.1C3.9 7.5 2.5 9.7 2 12c.5 2.3 2 4.6 4.3 6.1A10.8 10.8 0 0 0 12 19c1.1 0 2.2-.2 3.2-.5' }]],
    calendar: [['rect', { x: '5', y: '4.5', width: '14', height: '15', rx: '1.5' }], ['path', { d: 'M8 2.8v3.4M16 2.8v3.4M5 9h14' }]],
    health: [['polyline', { points: '3,12 7,12 9,6 13,18 15,12 21,12' }]],
    trends: [['polyline', { points: '3,17 9,11 13,14 21,6' }], ['polyline', { points: '16,6 21,6 21,11' }]]
  }[name] || [];
  shapes.forEach(([tag, attributes]) => { const shape = createSvg(tag); Object.entries(attributes).forEach(([key, value]) => shape.setAttribute(key, value)); svg.append(shape); });
  return svg;
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
