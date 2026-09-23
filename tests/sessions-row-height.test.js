import test from 'node:test';
import assert from 'node:assert/strict';

class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.childNodes = []; this.attributes = new Map(); this.className = ''; this.dataset = {}; this.style = {}; this._text = ''; }
  append(...children) { for (const child of children) { if (child == null) continue; if (typeof child === 'string') { const text = new Node('#text'); text.textContent = child; this.childNodes.push(text); } else this.childNodes.push(child); } }
  get textContent() { return this.childNodes.length ? this.childNodes.map((child) => child.textContent).join('') : this._text; }
  set textContent(value) { this.childNodes = []; this._text = String(value ?? ''); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  get children() { return this.childNodes.filter((child) => child.tagName !== '#TEXT'); }
}
globalThis.document = { createElement: (tag) => new Node(tag), createTextNode: (text) => Object.assign(new Node('#text'), { textContent: String(text) }), createDocumentFragment: () => new Node('fragment'), querySelector: () => null };
globalThis.location = { hash: '#/sessions' };
globalThis.addEventListener = () => {};

const { findingCell, observedFindingCount, diagnosisRow } = await import('../public/js/pages/sessions.js');

const rule = (name) => ({ id: name.toLowerCase().replaceAll(' ', '-'), name, severity: 'warn', evidence: { status: 'observed', values: [] }, threshold: { value: 1 } });
const session = (names) => ({ sessionId: 'fixture-session', rules: names.map(rule), score: { total: names.length, passed: 0, observed: names.length, unknown: 0 } });
const descendants = (root) => [root, ...(root.childNodes ?? []).flatMap(descendants)];
const byClass = (root, name) => descendants(root).filter((node) => node.className?.split(' ').includes(name));

test('one finding renders one pill and no counter', () => {
  const cell = findingCell(session(['Context pressure']));
  assert.equal(byClass(cell, 'finding-pill').length, 1);
  assert.equal(byClass(cell, 'finding-counter').length, 0);
});

test('three findings render fitting pills plus an exact remainder counter', () => {
  const cell = findingCell(session(['Context pressure', 'Repeated reads', 'Cache misses']));
  assert.ok(byClass(cell, 'finding-pill').length >= 1);
  assert.equal(byClass(cell, 'finding-counter')[0]?.textContent, '+2 more');
});

test('the remainder counter names every hidden finding', () => {
  const cell = findingCell(session(['Context pressure', 'Repeated reads', 'Cache misses']));
  const counter = byClass(cell, 'finding-counter')[0];
  assert.match(counter.getAttribute('title'), /Repeated reads/);
  assert.match(counter.getAttribute('title'), /Cache misses/);
});

test('expanding the row exposes every finding, including hidden ones', () => {
  const expanded = diagnosisRow(session(['Context pressure', 'Repeated reads', 'Cache misses']), null, null);
  assert.equal(byClass(expanded, 'verdict').length, 3);
  assert.match(expanded.textContent, /Context pressure/);
  assert.match(expanded.textContent, /Repeated reads/);
  assert.match(expanded.textContent, /Cache misses/);
});

test('presentation does not change the analyzer finding count', () => {
  const fixture = session(['Context pressure', 'Repeated reads', 'Cache misses']);
  assert.equal(observedFindingCount(fixture), 3);
  findingCell(fixture);
  assert.equal(observedFindingCount(fixture), 3);
});
