/**
 * tests/frontend-contract.test.js — GATE-OFFLINE + the frontend's honesty
 * contract (BP-007, wave 5C).
 *
 * node --test, no browser, no new dependency. Two kinds of assertion:
 *
 *  A. STATIC — the file tree and its text: the vendored library is really there
 *     and really Chart.js; nothing under public/ reaches for a remote URL; the
 *     stylesheet defines the tokens the components use; no file touches
 *     innerHTML. Limits of the regex audit are stated at each test.
 *
 *  B. BEHAVIOURAL, under a minimal DOM shim — the three claims that matter most
 *     and that a grep cannot check: a null renders as "not measured" and never
 *     as 0, an `unknown` verdict carries its reason and is not styled as a pass
 *     or a warn, and the fix diff reaches the DOM character-identical to the
 *     bytes the API returned.
 *
 *     SHIM LIMITS, STATED: it implements only createElement / createTextNode /
 *     append / replaceChildren / classList / dataset / style.setProperty /
 *     setAttribute and a recursive textContent. It does no layout, no CSS
 *     cascade and no event dispatch, so it proves the DOM STRUCTURE and the TEXT
 *     these components produce — not that the rendered pixels differ. The pixel
 *     claim is carried by the stylesheet assertions in part A.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PUBLIC = path.join(ROOT, "public");
const COMPONENTS = path.join(PUBLIC, "js", "components");
const VENDOR_FILE = path.join(PUBLIC, "vendor", "chart.umd.min.js");

// health-card.js is NOT here: wave 5D retired it to _trash/ (F-021). The
// shipping session card is public/js/pages/health.js `sessionCard`, which part B
// below asserts directly. RETIRED_COMPONENTS is audited too — a retired file
// that came back would be a second implementation again.
const COMPONENT_FILES = ["suggestion-panel.js", "chart.js"]
  .map((name) => path.join(COMPONENTS, name));
const RETIRED_COMPONENTS = ["health-card.js", "fix-modal.js"].map((name) => path.join(COMPONENTS, name));
const PAGE_FILES = ["health.js", "trends.js", "sessions.js", "report.js"]
  .map((name) => path.join(PUBLIC, "js", "pages", name));

const read = (file) => readFileSync(file, "utf8");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const PUBLIC_FILES = walk(PUBLIC);
const rel = (file) => path.relative(ROOT, file);

/**
 * Strip JS comments, keeping string and template-literal contents intact.
 *
 * WHY: every file in this project DOCUMENTS the sinks it refuses to use ("no
 * innerHTML in this file"). A grep over raw text therefore fails on the
 * documentation rather than on the code. The audit must read the code, so the
 * prose is removed first — and `stripJsComments` is itself asserted below, since
 * a stripper that silently eats real code would turn this whole audit green for
 * the wrong reason.
 *
 * It tracks the three quote forms (including template `${}` depth) and both
 * comment forms. It does NOT track regex literals, so a regex containing a
 * slash-star sequence could confuse it; the self-test below covers every shape
 * that actually occurs in this codebase.
 */
function stripJsComments(src) {
  let out = "";
  let i = 0;
  let quote = "";
  let templateDepth = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      if (ch === "\\") { out += ch + (next ?? ""); i += 2; continue; }
      if (quote === "`" && ch === "$" && next === "{") { templateDepth += 1; out += "${"; i += 2; continue; }
      if (quote === "`" && templateDepth > 0 && ch === "}") { templateDepth -= 1; out += ch; i += 1; continue; }
      if (ch === quote && templateDepth === 0) { quote = ""; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch; i += 1;
  }
  return out;
}

/** Same idea for CSS, which only has the block form. */
const stripCssComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "");

// ==========================================================================
// A minimal DOM, sufficient for these components and nothing more.
// ==========================================================================

class ShimText {
  constructor(data) { this.data = String(data); this.parent = null; }
  get textContent() { return this.data; }
  get children() { return []; }
}

/**
 * A DocumentFragment: `public/js/pages/health.js` returns one from
 * `windowValueNode` / `evidenceValueNode`, and the real DOM splices its children
 * into the parent on append rather than inserting the fragment itself. The shim
 * does the same, so a structural assertion sees the same tree a browser builds.
 */
class ShimFragment {
  constructor() { this.childNodes = []; this.parent = null; this.isFragment = true; }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }
  append(...nodes) {
    nodes.forEach((node) => {
      if (node === null || node === undefined) return;
      const child = typeof node === "string" ? new ShimText(node) : node;
      if (child.isFragment) { this.append(...child.childNodes); return; }
      child.parent = this;
      this.childNodes.push(child);
    });
  }
}

class ShimElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parent = null;
    this._text = "";
    this._className = "";
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this._styles = new Map();
    this.style = {
      setProperty: (name, value) => { this._styles.set(name, String(value)); },
      getPropertyValue: (name) => this._styles.get(name) ?? "",
    };
    this.classList = {
      add: (...names) => {
        const set = new Set(this._className.split(/\s+/).filter(Boolean));
        names.forEach((name) => set.add(name));
        this._className = [...set].join(" ");
      },
      remove: (...names) => {
        const set = new Set(this._className.split(/\s+/).filter(Boolean));
        names.forEach((name) => set.delete(name));
        this._className = [...set].join(" ");
      },
      contains: (name) => this._className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        if (force === true) this.classList.add(name);
        else if (force === false) this.classList.remove(name);
        else if (this.classList.contains(name)) this.classList.remove(name);
        else this.classList.add(name);
      },
    };
  }

  get className() { return this._className; }
  set className(value) { this._className = String(value ?? ""); }

  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((node) => node.textContent).join("");
  }

  set textContent(value) {
    this.childNodes = [];
    this._text = value === null || value === undefined ? "" : String(value);
  }

  append(...nodes) {
    nodes.forEach((node) => {
      if (node === null || node === undefined) return;
      const child = typeof node === "string" ? new ShimText(node) : node;
      // A fragment contributes its children, never itself — as in the real DOM.
      if (child.isFragment) { this.append(...child.childNodes); return; }
      child.parent = this;
      // A node gaining children loses any directly-set text, as in the real DOM.
      if (this.childNodes.length === 0 && this._text) {
        this.childNodes.push(new ShimText(this._text));
        this._text = "";
      }
      this.childNodes.push(child);
    });
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this._text = "";
    this.append(...nodes);
  }

  remove() {
    if (!this.parent) return;
    this.parent.childNodes = this.parent.childNodes.filter((node) => node !== this);
    this.parent = null;
  }

  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener() {}
  focus() {}
}

const documentShim = {
  createElement: (tag) => new ShimElement(tag),
  createElementNS: (_namespace, tag) => new ShimElement(tag),
  createTextNode: (data) => new ShimText(data),
  createDocumentFragment: () => new ShimFragment(),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  documentElement: new ShimElement("html"),
  body: new ShimElement("body"),
};

globalThis.document = documentShim;
if (typeof globalThis.addEventListener !== "function") globalThis.addEventListener = () => {};
if (!globalThis.location) globalThis.location = { hash: "#/health" };

/**
 * Depth-first walk of a shim tree, in DOCUMENT ORDER.
 *
 * The children are pushed in reverse so `pop()` hands them back left-to-right.
 * Pushing them forwards reverses every sibling list, which makes
 * `withClass(root, name)[0]` the LAST match instead of the first — so a test
 * asking for "the Sessions-analyzed card" silently got the "Not measured" one
 * and asserted against the wrong node. Counts hid it; only `[0]` sees it.
 */
function nodes(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    out.push(node);
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return out;
}

const withClass = (root, name) => nodes(root).filter((node) => node.classList?.contains?.(name));

/** The session card's `.meta-grid` as label -> value node. */
function metaMap(card) {
  const grid = withClass(card, "meta-grid")[0];
  const out = new Map();
  for (const cell of grid?.childNodes ?? []) {
    const kids = cell.childNodes ?? [];
    const label = kids.find((node) => node.classList?.contains?.("meta-label"));
    const value = kids.find((node) => node.classList?.contains?.("meta-value"));
    if (label && value) out.set(label.textContent.trim(), value);
  }
  return out;
}

// Imported after the shim is installed: these modules touch `document` at call
// time, and app.js registers listeners on globalThis at module scope.
// The SHIPPING session card and activity grid live in wave 5B's page modules;
// wave 5C's duplicates were retired (F-021). Part B therefore drives
// `pages/health.js` and `pages/trends.js` — the code index.html actually loads —
// rather than a component with no product caller.
const healthPage = await import("../public/js/pages/health.js");
const trendsPage = await import("../public/js/pages/trends.js");
const suggestionPanel = await import("../public/js/components/suggestion-panel.js");
  const chart = await import("../public/js/components/chart.js");
const overviewPage = await import("../public/js/pages/overview.js");
const app = await import("../public/js/app.js");
const ui = await import("../public/js/components/ui.js");

/** The shipping card, under its real signature. */
const renderCard = (session, api = null, rerender = null) => healthPage.sessionCard(session, api, rerender);

// ==========================================================================
// A. Static contract
// ==========================================================================

test("overview issue distribution percentages sum to 100 with largest-remainder rounding", () => {
  const rounded = ui.largestRemainder([44.4, 44.4, 6.7, 4.8, 0.7, 0]);
  assert.equal(rounded.reduce((sum, value) => sum + value, 0), 100);
  assert.deepEqual(rounded, [44, 44, 7, 5, 0, 0]);
});

test("overview trend cards render the current level and its change", () => {
  const cards = [
    overviewPage.trendCard("Context efficiency", "context", {
      context: { available: true, to: 70.4, changePercent: -50.8, secondHalfDays: 6 },
    }, { context: [] }, "turnsAboveThreshold", "Turns above 70% of window", "pass"),
    overviewPage.trendCard("Token spend", "spend", {
      spend: { available: true, to: 330705511.71, changePercent: 3.06, secondHalfDays: 6 },
    }, { spend: [] }, "total", "Total tokens per day", "accent"),
    overviewPage.trendCard("Cache hit rate", "cache", {
      cache: { available: true, to: 98.3, changePercent: -0.1, secondHalfDays: 6 },
    }, { cache: [] }, "hitRate", "Cache hits (%)", "pass"),
  ];
  assert.match(cards[0].textContent, /70\.4%/);
  assert.match(cards[1].textContent, /330,705,512/);
  assert.doesNotMatch(cards[1].textContent, /330,705,512\.\d/);
  assert.match(cards[1].textContent, /3\.06%/);
  assert.match(cards[2].textContent, /98\.3%/);
  assert.match(cards[0].textContent, /↓ 50\.8% relative change/);
  assert.match(cards[1].textContent, /↑ \+3\.06%/);
  assert.match(cards[2].textContent, /↓ 0\.1% relative change/);
});

test("overview trend cards print the published reason when unavailable", () => {
  const reason = "one half has no measured days with data, so no percentage is published";
  const card = overviewPage.trendCard("Token spend", "spend", {
    spend: { available: false, to: null, reason },
  }, { spend: [] }, "total", "Total tokens per day", "accent");
  assert.match(card.textContent, new RegExp(reason));
  assert.match(card.textContent, /Not enough measured days in this window to compare\./);
  assert.doesNotMatch(card.textContent, /not comparable|—|\b0\b/);
});

const overviewApi = {
  async get(url) {
    if (url.startsWith("/api/trends")) return { trend: {}, trendDeltas: {}, charts: {} };
    if (url.startsWith("/api/sessions")) return { sessions: [] };
    if (url === "/api/fixes") return { fixes: [] };
    throw new Error(`unexpected Overview request: ${url}`);
  },
};

const overviewHealth = (over = {}) => ({
  sessionsTotal: 0,
  windowTotals: { sessions: 0 },
  windowSeries: {},
  comparison: {},
  collectors: [],
  topFixes: [],
  ...over,
});

const populatedOverviewHealth = (over = {}) => overviewHealth({
  sessionsTotal: 1,
  windowTotals: { sessions: 1, observedFindings: 2, fixableFindings: 2, unknownChecks: 3 },
  windowSeries: { sessions: [1], observedFindings: [2], fixableFindings: [2], unknownChecks: [3] },
  comparison: { available: true, windowDays: 4 },
  distinctFixes: { count: 2, findings: 2 },
  ...over,
});

const populatedOverviewApi = {
  async get(url) {
    if (url.startsWith("/api/trends")) return { trend: {}, trendDeltas: {}, charts: {} };
    if (url.startsWith("/api/sessions")) return { sessions: [] };
    if (url === "/api/fixes") return { fixes: [] };
    throw new Error(`unexpected Overview request: ${url}`);
  },
};

test("Overview hero cards render their metric units in each card", async () => {
  const mount = new ShimElement("main");
  await overviewPage.default(mount, populatedOverviewHealth(), { api: populatedOverviewApi });
  const cards = withClass(mount, "summary-card");
  assert.equal(cards.length, 3);
  // The unit is asserted on the card's own subtitle line (`.rx-label`), not on
  // the whole card: `textContent` joins sibling nodes with no separator, so a
  // card-wide match reads across element boundaries ("...not comparablesessions
  // in the last 4 days") and then succeeds or fails for reasons that have
  // nothing to do with the unit word. The subtitle is where the unit belongs.
  for (const [card, unit] of cards.map((card, index) => [card, ["sessions", "findings", "findings"][index]])) {
    const label = withClass(card, "rx-label")[0];
    assert.ok(label, `card must carry a subtitle line to publish its ${unit} unit on`);
    assert.match(label.textContent, new RegExp(`\\b${unit}\\b`), `card must publish its ${unit} unit`);
  }
});

test("Overview spend trend states its per-day mean, measured days, and cache versus fresh input", () => {
  const card = overviewPage.trendCard("Token spend", "spend", {
    spend: { available: true, to: 200, changePercent: 5, firstHalfDays: 3, secondHalfDays: 5 },
  }, {
    spend: [
      { hasData: true, cacheRead: 100, cacheCreation: 10, total: 110 },
      { hasData: true, cacheRead: 200, cacheCreation: 20, total: 220 },
    ],
  }, "total", "Total tokens per day", "accent");
  assert.match(card.textContent, /Per-day mean/);
  assert.match(card.textContent, /5 measured days/);
  assert.match(card.textContent, /cache reads/);
  assert.match(card.textContent, /fresh input/);
  assert.doesNotMatch(card.textContent, /7 measured days/);
});

test("Overview marks the Sessions-analyzed card incomplete exactly at the scan limit", async () => {
  for (const atLimit of [true, false]) {
    const mount = new ShimElement("main");
    await overviewPage.default(mount, populatedOverviewHealth({ coverage: { atLimit } }), { api: populatedOverviewApi });
    const sessionsCard = withClass(mount, "summary-card")[0];
    if (atLimit) assert.match(sessionsCard.textContent, /floor \(scan at limit\)/);
    else assert.doesNotMatch(sessionsCard.textContent, /floor \(scan at limit\)/);
  }
});

test("Overview renders one shared comparison sentence only when comparison is unavailable", async () => {
  const reason = "the previous window was not read";
  const unavailableMount = new ShimElement("main");
  await overviewPage.default(unavailableMount, populatedOverviewHealth({ comparison: { available: false, reason } }), { api: populatedOverviewApi });
  const notes = withClass(unavailableMount, "comparison-note");
  assert.equal(notes.length, 1);
  assert.match(notes[0].textContent, new RegExp(reason));

  const availableMount = new ShimElement("main");
  await overviewPage.default(availableMount, populatedOverviewHealth({ comparison: { available: true, reason } }), { api: populatedOverviewApi });
  assert.equal(withClass(availableMount, "comparison-note").length, 0);
});

test("Overview Top-fixes rows contain no positional impact judgement", async () => {
  const mount = new ShimElement("main");
  await overviewPage.default(mount, populatedOverviewHealth({
    topFixes: [
      { id: "first", name: "First fix", fixId: "fix-a", sessions: 2, findings: 2 },
      { id: "second", name: "Second fix", fixId: "fix-b", sessions: 1, findings: 1 },
      { id: "third", name: "Third fix", fixId: "fix-c", sessions: 1, findings: 1 },
    ],
  }), { api: populatedOverviewApi });
  const rows = withClass(mount, "fix-row");
  assert.equal(rows.length, 3);
  for (const row of rows) assert.doesNotMatch(row.textContent, /High rank|Medium rank|Low rank/);
});

test("Overview replaces summary cards and Health/Trends with the first-run panel", async () => {
  const mount = new ShimElement("main");
  const note = "no installation was detected, so no file was read. The session count is not recorded rather than zero.";
  await overviewPage.default(mount, overviewHealth({ collectors: [
    { cli: "Claude Code", support: "supported", installed: false, note },
    { cli: "Codex", support: "detection-only", note: "detected, but its session records are not readable here" },
  ] }), { api: overviewApi });
  assert.match(mount.textContent, /SessionRx found no AI CLI sessions on this machine/);
  assert.match(mount.textContent, /Claude Code/);
  assert.match(mount.textContent, /not found/);
  assert.match(mount.textContent, new RegExp(note));
  assert.equal(withClass(mount, "summary-card").length, 0);
  assert.equal(withClass(mount, "overview-health-row").length, 0);
});

test("Overview counts only installed CLIs and renders no absent chips", async () => {
  const mount = new ShimElement("main");
  await overviewPage.default(mount, overviewHealth({ collectors: [
    { cli: "Claude Code", support: "supported", installed: false },
    { cli: "Codex", support: "supported", installed: false },
  ] }), { api: overviewApi });
  assert.match(mount.textContent, /0 CLIs detected/);
  assert.equal(withClass(mount, "rx-chip").length, 0);
});

test("Overview counts installed supported and detection-only CLIs, ignoring absent ones", async () => {
  const mount = new ShimElement("main");
  await overviewPage.default(mount, overviewHealth({ collectors: [
    { cli: "Claude Code", support: "supported", installed: true },
    { cli: "Cursor", support: "detection-only", installed: true },
    { cli: "Antigravity", support: "supported", installed: false },
  ] }), { api: overviewApi });
  assert.match(mount.textContent, /2 CLIs detected/);
  assert.match(mount.textContent, /Claude Code/);
  assert.match(mount.textContent, /Cursor/);
  assert.doesNotMatch(withClass(mount, "rx-chip").map((node) => node.textContent).join(" "), /Antigravity/);
  assert.equal(withClass(mount, "rx-chip").length, 2);
});

test("Overview marks an installed detection-only collector as not read yet without a zero", async () => {
  const mount = new ShimElement("main");
  await overviewPage.default(mount, populatedOverviewHealth({ collectors: [
    { cli: "Claude Code", support: "supported", installed: true, sessions: 3 },
    { cli: "Cursor", support: "detection-only", installed: true, sessions: null, note: "no Cursor CLI chat store was found" },
  ] }), { api: populatedOverviewApi });
  assert.match(mount.textContent, /2 CLIs detected/);
  const cursor = withClass(mount, "rx-chip").find((node) => /Cursor/.test(node.textContent));
  assert.ok(cursor);
  assert.match(cursor.textContent, /not read yet/);
  assert.doesNotMatch(cursor.textContent, /\b0\b/);
});

test("Overview falls back to support when installed data is absent", async () => {
  const mount = new ShimElement("main");
  await overviewPage.default(mount, overviewHealth({ collectors: [
    { cli: "Claude Code", support: "supported" },
    { cli: "Codex", support: "supported" },
    { cli: "Cursor", support: "detection-only" },
  ] }), { api: overviewApi });
  assert.match(mount.textContent, /2 CLIs detected/);
  assert.equal(withClass(mount, "rx-chip").length, 2);
});

test("Overview empty panel states the heading exactly once", async () => {
  const mount = new ShimElement("main");
  await overviewPage.default(mount, overviewHealth({ collectors: [
    { cli: "Claude Code", support: "supported", installed: false },
  ] }), { api: overviewApi });
  const heading = "SessionRx found no AI CLI sessions on this machine";
  assert.equal(mount.textContent.split(heading).length - 1, 1);
  assert.match(mount.textContent, /checked each CLI below and reports whether it was found on this machine/);
});

test("Overview uses a distinct range panel when sessions exist outside the window", async () => {
  const mount = new ShimElement("main");
  await overviewPage.default(mount, overviewHealth({ sessionsTotal: 7, windowTotals: { sessions: 0 } }), { api: overviewApi });
  assert.match(mount.textContent, /The scan found 7 sessions, but none fall inside this date range/);
  assert.match(mount.textContent, /Widen the range/);
  assert.doesNotMatch(mount.textContent, /no AI CLI sessions on this machine/);
  assert.doesNotMatch(mount.textContent, /supported CLIs/);
});

test("Overview never turns either empty state into an all-clear", async () => {
  for (const health of [overviewHealth(), overviewHealth({ sessionsTotal: 2, windowTotals: { sessions: 0 } })]) {
    const mount = new ShimElement("main");
    await overviewPage.default(mount, health, { api: overviewApi });
    assert.doesNotMatch(mount.textContent, /no problems|all clear|healthy|looks good/i);
  }
});

test("Overview keeps populated summary cards and unavailable trend evidence", async () => {
  const mount = new ShimElement("main");
  const reason = "the middle day was dropped; one half has no measured days with data, so no percentage is published";
  const health = overviewHealth({
    sessionsTotal: 1,
    windowTotals: { sessions: 1, observedFindings: 2, fixableFindings: 1, unknownChecks: 3 },
  });
  const api = { ...overviewApi, async get(url) {
    if (url.startsWith("/api/trends")) return { trend: {}, trendDeltas: { context: { available: false, reason } }, charts: {} };
    return overviewApi.get(url);
  }};
  await overviewPage.default(mount, health, { api });
  assert.equal(withClass(mount, "summary-card").length, 3);
  assert.equal(withClass(mount, "overview-health-row").length, 1);
  assert.match(mount.textContent, /Not enough measured days in this window to compare\./);
  assert.match(mount.textContent, new RegExp(reason));
});

test("the five secondary pages use the Overview icon-badge language", () => {
  const pages = ["health.js", "trends.js", "sessions.js", "fixes.js", "report.js"];
  for (const name of pages) {
    const src = read(path.join(PUBLIC, "js", "pages", name));
    assert.match(src, /icon\(/, `${name} must use the shared icon helper`);
    assert.match(src, /rx-icon/, `${name} must render an Overview-style icon badge`);
  }
  const css = read(path.join(PUBLIC, "css", "style.css"));
  assert.match(css, /\.rx-icon\s*\{/, "the shared badge style must remain available");
});

test("sessions keep IDs selectable while constraining display and dates to one line", () => {
  const sessions = read(path.join(PUBLIC, "js", "pages", "sessions.js"));
  const css = read(path.join(PUBLIC, "css", "style.css"));
  assert.match(sessions, /el\('span', 'session-id'/);
  assert.match(sessions, /value\.title = session\.sessionId/);
  assert.match(css, /\.session-id, \.session-date[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.session-id\s*\{[^}]*font-family:\s*var\(--mono\)[^}]*user-select:\s*text/);
  assert.match(css, /text-overflow:\s*ellipsis/);
});

test("fixes columns start-align and recommendations use an even wrapping grid", () => {
  const fixes = read(path.join(PUBLIC, "js", "pages", "fixes.js"));
  const css = read(path.join(PUBLIC, "css", "style.css"));
  assert.match(fixes, /rx-grid-even/);
  assert.match(css, /\.fix-layout[^}]*align-items:\s*start/);
  assert.match(css, /\.fix-layout > main[^}]*height:\s*fit-content/);
  assert.match(css, /\.rx-grid-even[^}]*repeat\(auto-fit,\s*minmax\(/);
});

test("the comment stripper keeps code and strings, and drops only comments", () => {
  assert.equal(stripJsComments('a // innerHTML\nb'), "a \nb");
  assert.equal(stripJsComments('a /* innerHTML */ b'), "a  b");
  assert.equal(stripJsComments('const s = "// not a comment";'), 'const s = "// not a comment";');
  assert.equal(stripJsComments('const s = "/* nor this */";'), 'const s = "/* nor this */";');
  assert.equal(stripJsComments('`t ${x} // in template`'), '`t ${x} // in template`');
  // The sink must survive stripping when it is real code.
  assert.match(stripJsComments('/* no innerHTML */ node.innerHTML = x;'), /node\.innerHTML = x;/);
  // And must not survive when it is only prose.
  assert.ok(!/innerHTML/.test(stripJsComments('/* SECURITY: no innerHTML here */ node.textContent = x;')));
  assert.equal(stripCssComments('/* @import */ a{b:c}'), " a{b:c}");
});

test("every component module parses under node --check", () => {
  for (const file of COMPONENT_FILES) {
    assert.ok(existsSync(file), `${rel(file)} must exist`);
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `${rel(file)} failed node --check:\n${result.stderr}`);
  }
});

test("app.js parses, and only app.js calls fetch (it is what carries the CSRF nonce)", () => {
  const appFile = path.join(PUBLIC, "js", "app.js");
  assert.equal(spawnSync(process.execPath, ["--check", appFile], { encoding: "utf8" }).status, 0);

  const app = read(appFile);
  assert.match(app, /X-CSRF-Token/, "app.js must set the X-CSRF-Token header (BP-005.13)");

  // A component calling fetch itself would bypass the nonce, so the mutating
  // path would 403 — or, worse, a future wrapper change would silently skip it.
  for (const file of COMPONENT_FILES) {
    const src = read(file);
    assert.ok(
      !/\bfetch\s*\(/.test(src),
      `${rel(file)} must POST through app.js's wrapper, not call fetch directly`,
    );
    assert.ok(
      !/XMLHttpRequest|navigator\.sendBeacon|EventSource|new\s+WebSocket/.test(src),
      `${rel(file)} must not open its own transport`,
    );
  }
});

test("the vendored Chart.js is present, non-trivial, and really Chart.js", () => {
  assert.ok(existsSync(VENDOR_FILE), "public/vendor/chart.umd.min.js must exist (DIS-001)");
  const bytes = readFileSync(VENDOR_FILE);
  assert.ok(
    bytes.length > 150_000,
    `vendored bundle is ${bytes.length} bytes — too small to be Chart.js; a stub that `
    + "renders nothing is worse than a stated gap",
  );
  const src = bytes.toString("utf8");
  assert.match(src, /Chart\.js v4\.\d+\.\d+/, "banner must name a Chart.js v4 release");
  assert.match(src, /typeof exports|typeof define/, "must be the UMD build (index.html loads it as a classic script)");
  assert.match(src, /Chart/, "must define Chart");
  // Recorded so a swapped bundle is visible in the diff of this file.
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    digest,
    "48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a",
    "vendored Chart.js sha256 changed — confirm the new bundle's provenance, then update this hash",
  );
});

test("the vendored bundle makes no network call and its only URLs are banner comments", () => {
  const src = read(VENDOR_FILE);
  const urls = [...new Set(src.match(/https?:\/\/[^\s"'`)]+/g) ?? [])].sort();
  assert.deepEqual(
    urls,
    ["https://github.com/kurkle/color#readme", "https://www.chartjs.org"],
    "unexpected URL inside the vendored bundle",
  );
  for (const url of urls) {
    const index = src.indexOf(url);
    const bannerStart = src.lastIndexOf("/*", index);
    const bannerEnd = src.lastIndexOf("*/", index);
    assert.ok(
      bannerStart !== -1 && bannerStart > bannerEnd,
      `${url} is not inside a /* */ banner comment`,
    );
  }
  assert.ok(!/\bfetch\s*\(\s*["'`]https?:/.test(src), "bundle must not fetch a remote URL");
  assert.ok(!/importScripts|XMLHttpRequest\s*\(/.test(src), "bundle must not load remote code");
});

test("no remote asset anywhere under public/ outside the vendored bundle (GATE-OFFLINE)", () => {
  const offenders = [];
  for (const file of PUBLIC_FILES) {
    if (rel(file).startsWith(path.join("public", "vendor") + path.sep)) continue;
    // Comments are stripped: a file DOCUMENTING that it uses no remote asset
    // must not be reported as using one.
    const raw = read(file);
    const src = file.endsWith(".css") ? stripCssComments(raw) : stripJsComments(raw);
    const remote = src.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    const protocolRelative = src.match(/["'(]\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
    const imports = src.match(/@import[^;]*/g) ?? [];
    if (remote.length || protocolRelative.length || imports.length) {
      offenders.push(`${rel(file)}: ${[...remote, ...protocolRelative, ...imports].join(", ")}`);
    }
  }
  assert.deepEqual(offenders, [], `remote reference found under public/:\n${offenders.join("\n")}`);
});

test("index.html loads the vendored chart and nothing remote", () => {
  const html = read(path.join(PUBLIC, "index.html"));
  assert.match(html, /src="\/vendor\/chart\.umd\.min\.js"/, "must load the vendored chart");
  assert.match(html, /href="\/css\/style\.css"/, "must load the local stylesheet");
  // No CSRF meta any more: SessionRx has no mutating route left to defend
  // (THE SUGGESTION CONTRACT), so the server injects no nonce into the page.
  assert.doesNotMatch(html, /name="csrf-token"/);
  const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  const PNG = "data:image/png;base64,";
  for (const value of srcs) {
    if (value.startsWith("data:")) {
      // An inlined asset is provably not a network request. Only one shape is
      // allowed through, though: an image. `data:text/html` or `data:` with a
      // script payload would also be "not remote" and is not what this page
      // inlines, so the allowance is narrowed to the exact thing that ships.
      assert.ok(value.startsWith(PNG), `${value.slice(0, 32)}… is an inline asset of a kind this page does not inline`);
      const bytes = Buffer.from(value.slice(PNG.length), "base64");
      assert.deepEqual(
        [...bytes.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "the inline icon must really be a PNG, not a declared type over other bytes",
      );
      continue;
    }
    assert.ok(
      value.startsWith("/") || value.startsWith("#") || value.startsWith("./"),
      `${value} is not a local path`,
    );
  }
  // Declared so the browser stops asking for /favicon.ico, which this server
  // does not serve and which logged a 404 on every single page load.
  assert.match(html, /<link rel="icon"/, "a favicon must be declared, or every page load logs a 404");
});

test("style.css defines every token the components use, with no remote font", () => {
  const css = stripCssComments(read(path.join(PUBLIC, "css", "style.css")));
  const required = [
    "--bg", "--surface", "--surface-raised", "--surface-soft", "--surface-inset",
    "--border", "--border-strong", "--text", "--muted", "--subtle",
    "--accent", "--accent-strong",
    "--pass", "--warn", "--crit", "--unknown", "--unknown-hatch", "--unknown-bg", "--unknown-line",
    "--diff-ins", "--diff-del",
    "--heat-0", "--heat-4",
    "--zone-green", "--zone-yellow", "--zone-red",
    "--radius", "--mono", "--sans", "--heatmap-cols",
  ];
  for (const token of required) {
    assert.match(css, new RegExp(`^\\s*${token}\\s*:`, "m"), `style.css must define ${token} on :root`);
  }
  assert.ok(!/@import/.test(css), "no @import — it would be a remote or extra fetch");
  assert.ok(!/url\(\s*['"]?https?:/i.test(css), "no remote url() asset");
  assert.ok(!/fonts\.(googleapis|gstatic)/.test(css), "no remote font");
  assert.match(css, /ui-monospace/, "numbers use a monospace stack");

  // The surface the blueprint names must all be styled, not just tokenised.
  for (const selector of [
    ".card", ".score-bar", ".table-wrap", ".chart-container", ".heatmap",
    ".modal", ".diff", ".badge-unknown", ".verdict-unknown", ".verdict-fix-scope",
  ]) {
    assert.ok(css.includes(selector), `style.css must style ${selector}`);
  }
  assert.match(css, /max-width:\s*900px/, "must be responsive at 900px");
});

test("the unknown state is visually distinct from BOTH pass and warn, on more than hue", () => {
  const css = stripCssComments(read(path.join(PUBLIC, "css", "style.css")));
  const token = (name) => {
    const match = css.match(new RegExp(`^\\s*${name}\\s*:\\s*([^;]+);`, "m"));
    assert.ok(match, `${name} must be defined`);
    return match[1].trim();
  };
  const unknown = token("--unknown");
  assert.notEqual(unknown, token("--pass"), "--unknown must not equal --pass");
  assert.notEqual(unknown, token("--warn"), "--unknown must not equal --warn");
  assert.notEqual(unknown, token("--crit"), "--unknown must not equal --crit");

  const block = (selector) => {
    const index = css.indexOf(selector);
    assert.ok(index !== -1, `${selector} must exist`);
    const open = css.indexOf("{", index);
    return css.slice(open, css.indexOf("}", open));
  };

  // Channel 2: a hatch fill no other state uses. Channel 3: a dashed border.
  assert.match(token("--unknown-hatch"), /repeating-linear-gradient/, "hatch must be a real pattern");
  const badge = block(".badge-unknown");
  assert.match(badge, /border-style:\s*dashed/, "unknown badge must be dashed, not just tinted");
  assert.match(badge, /--unknown-hatch/, "unknown badge must be hatched");
  assert.match(badge, /font-style:\s*italic/, "unknown badge must differ in type, not only colour");
  for (const solid of [".badge-ok, .badge-pass", ".badge-warn"]) {
    assert.ok(!/dashed/.test(block(solid)), `${solid} must stay solid so dashed means unknown`);
  }
  const verdict = block(".verdict-unknown");
  assert.match(verdict, /dashed/);
  assert.match(verdict, /--unknown-hatch/);

  // A day nobody collected must not look like a measured quiet hour.
  assert.match(block(".heatmap-cell.is-null"), /--unknown-hatch/);
  assert.match(block(".score-seg-unknown"), /--unknown-hatch/);
});

test("no component builds DOM from an HTML string (XSS audit; regex, limits stated)", () => {
  /* LIMIT: this is a textual audit. It proves no occurrence of the HTML-parsing
   * sinks below appears in these files; it cannot prove a sink reached through a
   * computed property name (node["inner" + "HTML"]) or through a helper in
   * another module. The positive guarantee comes from part B, which asserts the
   * rendered nodes carry their values as text. */
  const sinks = [
    /\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/,
    /\beval\s*\(/, /new\s+Function\s*\(/, /\bsetHTML\b/, /createContextualFragment/,
    /\[\s*["'`]innerHTML/,
  ];
  const audited = [...COMPONENT_FILES, ...PAGE_FILES.filter((file) => existsSync(file)),
    path.join(PUBLIC, "js", "app.js")];
  for (const file of audited) {
    const src = stripJsComments(read(file));
    for (const sink of sinks) {
      assert.ok(!sink.test(src), `${rel(file)} must not use ${sink} — a suggestion's preview and request text render here`);
    }
  }
  assert.ok(audited.length >= COMPONENT_FILES.length);
});

test("the four page modules parse and stay local", (t) => {
  const present = PAGE_FILES.filter((file) => existsSync(file));
  if (present.length !== PAGE_FILES.length) {
    t.skip(
      `wave 5B owns public/js/pages/*; ${present.length} of ${PAGE_FILES.length} present. `
      + "This is a real gap, reported as skipped rather than passed.",
    );
    return;
  }
  for (const file of PAGE_FILES) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `${rel(file)} failed node --check:\n${result.stderr}`);
    assert.ok(!/https?:\/\//.test(read(file)), `${rel(file)} must not reference a remote URL`);
  }
});

test("a retired component does not come back", () => {
  // F-021: wave 5C's health card was a SECOND implementation of wave 5B's, and
  // the shipping one is 5B's `pages/health.js`. The file was moved to _trash/
  // (INV-0: never deleted). A copy reappearing under public/js/components is
  // the duplicate-implementation defect returning, so it fails here rather
  // than drifting quietly out of sync with the page that ships.
  for (const file of RETIRED_COMPONENTS) {
    assert.ok(!existsSync(file), `${rel(file)} was retired to _trash/ — it must not come back`);
  }
  // Its `renderHeatmap` sibling went with it; the exports with real callers stayed.
  const chartSource = read(path.join(COMPONENTS, "chart.js"));
  assert.ok(!/export function renderHeatmap/.test(chartSource), "renderHeatmap was retired too");
  assert.match(chartSource, /export function renderChart\b/, "renderChart IS called from pages/trends.js");
  assert.match(chartSource, /export function destroyChart\b/, "destroyChart IS called from pages/trends.js");
});

// ==========================================================================
// B. Behavioural contract, under the DOM shim
// ==========================================================================

const RULE = (over) => ({
  id: "cache-hit",
  name: "Low cache hit",
  severity: "warn",
  fix: "claude-output-hygiene",
  // The API publishes the human name and target tool next to the id
  // (server.js `annotateSuggestions`); the page no longer keeps its own copy.
  suggestionTitle: "Output hygiene instruction",
  suggestionAvailable: true,
  suggestionTool: "claude",
  suggestionToolName: "Claude Code",
  threshold: { value: 0.85, derivation: "cacheRead / (cacheRead + cacheCreate) < 0.85" },
  magnitude: null,
  evidence: { status: "not-observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
  ...over,
});

const SESSION = (over) => ({
  cli: "claude",
  sessionId: "sess-1",
  project: null,
  cwd: null,
  model: "claude-opus-4-5",
  window: { tokens: 200000, source: "model-table" },
  windowPromotion: null,
  startedAt: "2026-09-20T10:00:00.000Z",
  endedAt: "2026-09-20T12:14:00.000Z",
  turnCount: 42,
  subagentTurns: null,
  score: { total: 6, passed: 4, observed: 0, unknown: 2, label: "" },
  rules: [RULE({})],
  ...over,
});

test("a null metric renders '— not measured', never 0", () => {
  const card = renderCard(SESSION({ subagentTurns: null, model: null }));
  assert.match(card.textContent, /not measured/, "an absent metric must say so in words");

  // Field by field, so a single absent field elsewhere cannot carry this test.
  const meta = metaMap(card);
  for (const field of ["sub-agent turns", "model", "project"]) {
    const value = meta.get(field);
    assert.ok(value, `the card must show a "${field}" row`);
    assert.match(value.textContent, /not measured/, `${field} was null and must say "not measured"`);
    assert.ok(
      !/\d/.test(value.textContent),
      `${field} was null but rendered the number "${value.textContent}"`,
    );
  }
  for (const node of withClass(card, "not-measured")) {
    assert.ok(!/\b0\b/.test(node.textContent), `a null rendered as "${node.textContent}" — must not show 0`);
    // The reason travels with the dash, for a reader who cannot see a tooltip.
    assert.match(
      node.getAttribute("aria-label") ?? "",
      /^not measured: .+/,
      "an absent value must carry WHY it is absent, not just a dash",
    );
  }
});

test("a measured zero still renders as 0, so absent and zero are not the same pixel", () => {
  const value = metaMap(renderCard(SESSION({ subagentTurns: 0 }))).get("sub-agent turns");
  assert.equal(value.textContent.trim(), "0", "a measured zero is the number 0");
  assert.ok(!/not measured/.test(value.textContent), "and it is not labelled absent");
});

test("the score line states unknowns only when present", () => {
  const withUnknown = renderCard(SESSION({}));
  assert.match(withUnknown.textContent, /4\/6 checks passed/);
  assert.match(withUnknown.textContent, /2 could not be measured/);
  // And spelled out once more, against the total, whenever anything is unknown.
  assert.match(withUnknown.textContent, /2 of 6 checks could not be measured on this session/);
  assert.match(withUnknown.textContent, /Those are not passes/);

  const clean = renderCard(SESSION({ score: { total: 6, passed: 6, observed: 0, unknown: 0, label: "" } }));
  assert.match(clean.textContent, /6\/6 checks passed/);
  assert.doesNotMatch(clean.textContent, /0 could not be measured/);
  assert.doesNotMatch(clean.textContent, /0 problems? observed/);

  // The bar carries a segment per state, and the unknown one is its own segment.
  const bar = withClass(withUnknown, "score-bar")[0];
  assert.ok(bar, "score bar must render");
  const segs = bar.childNodes.map((node) => node.className);
  assert.ok(segs.some((cls) => cls.includes("score-seg-passed")));
  assert.ok(segs.some((cls) => cls.includes("score-seg-unknown")), "unknown is a segment, not empty space");
  assert.ok(!segs.some((cls) => cls.includes("score-seg-observed")), "no observed problems here");

  // The bar's own description is the headline, so a screen reader hears the
  // unknown count too rather than a bare percentage.
  assert.match(bar.getAttribute("aria-label") ?? "", /could not be measured/);
});

test("a clean session header omits zero problem and unknown clauses", () => {
  const card = renderCard(SESSION({ score: { total: 5, passed: 5, observed: 0, unknown: 0, label: "" } }));
  const headline = withClass(card, "score-headline")[0].textContent;
  assert.equal(headline, "5/5 checks passed");
  assert.doesNotMatch(headline, /problems? observed|could not be measured/);
});

test("a session with two unmeasured checks keeps the unknown header clause", () => {
  const card = renderCard(SESSION({ score: { total: 5, passed: 3, observed: 0, unknown: 2, label: "" } }));
  const headline = withClass(card, "score-headline")[0].textContent;
  assert.equal(headline, "3/5 checks passed · 2 could not be measured");
});

test("shared health verdict never turns unknown checks into a pass", () => {
  const unknown = ui.healthNode({ total: 6, passed: 0, observed: 0, unknown: 6, label: "0 of 6 checks passed, 0 problems observed, 6 could not be measured" });
  assert.ok(withClass(unknown, "health-unknown").length);
  assert.doesNotMatch(unknown.textContent, /No problems/i);
  assert.match(unknown.textContent, /6 could not be measured/);
  assert.doesNotMatch(unknown.textContent, /6\/6/);

  const clean = ui.healthNode({ total: 6, passed: 6, observed: 0, unknown: 0, label: "6 of 6 checks passed, 0 problems observed, 0 could not be measured" });
  assert.ok(withClass(clean, "health-ok").length);
  assert.match(clean.textContent, /6\/6 checks passed/);
});

test("shared health verdict keeps the total denominator and unknown signal in compact mode", () => {
  const score = { total: 6, passed: 4, observed: 1, unknown: 1, label: "4 of 6 checks passed, 1 problem observed, 1 could not be measured" };
  const full = ui.healthNode(score, false);
  const compact = ui.healthNode(score, true);
  assert.equal(full.textContent, compact.textContent);
  assert.match(full.textContent, /4\/6 checks passed/);
  assert.doesNotMatch(full.textContent, /4\/5/);
  assert.match(compact.textContent, /1 could not be measured/);
  assert.match(compact.className, /health-warn/);
});

test("shared health pill omits zero problem and unknown clauses", () => {
  const pill = ui.healthNode({ total: 5, passed: 5, observed: 0, unknown: 0, label: "5 of 5 checks passed, 0 problems observed, 0 could not be measured" });
  assert.equal(pill.textContent, "5/5 checks passed");
  assert.equal(pill.title, "5 of 5 checks passed");
});

test("shared health pill keeps an observed-problem clause without zero unknown noise", () => {
  const pill = ui.healthNode({ total: 5, passed: 4, observed: 1, unknown: 0, label: "4 of 5 checks passed, 1 problem observed, 0 could not be measured" });
  assert.equal(pill.textContent, "4/5 checks passed · 1 problem observed");
  assert.equal(pill.title, "4 of 5 checks passed, 1 problem observed");
});

test("shared health pill never omits non-zero unknown checks", () => {
  const pill = ui.healthNode({ total: 5, passed: 3, observed: 0, unknown: 2, label: "3 of 5 checks passed, 0 problems observed, 2 could not be measured" });
  assert.equal(pill.textContent, "3/5 checks passed · 2 could not be measured");
  assert.equal(pill.title, "3 of 5 checks passed, 2 could not be measured");
});

test("shared health pill keeps the not measured state when no checks were measured", () => {
  const pill = ui.healthNode({ total: 0, passed: 0, observed: 0, unknown: 0, label: "0 of 0 checks passed" });
  assert.equal(pill.childNodes[0].textContent, "not measured");
});

/**
 * Every string a viewer can actually read out of a rendered shim tree: the text,
 * plus the `title` and `aria-label` a browser surfaces on hover or to a screen
 * reader. A tooltip is rendered output too — the false precision this suite
 * failed to catch lived in one.
 */
function renderedStrings(root) {
  const out = [];
  for (const node of nodes(root)) {
    if (typeof node.textContent === "string") out.push(node.textContent);
    if (typeof node.title === "string") out.push(node.title);
    for (const value of node.attributes?.values() ?? []) out.push(String(value));
  }
  return out;
}

test("the Sessions health column is sized for the sentence it renders, and the pill never breaks mid-word", () => {
  // WHY A CSS TEST: the honest ~60-character verdict shipped into a column
  // pinned at 78px. Under `table-layout: fixed` that width is absolute, the
  // unsized expander column took the 372px surplus, and `overflow-wrap:
  // anywhere` shattered the sentence into a 1-2 character ribbon 357px tall.
  // Every assertion in this suite was on TEXT, so all of them stayed green.
  const css = stripCssComments(read(path.join(PUBLIC, "css", "style.css")));
  const width = (column) => {
    const rule = css.match(new RegExp(`\\.session-layout > \\.card th:nth-child\\(${column}\\)[^{]*\\{([^}]*)\\}`));
    assert.ok(rule, `Sessions column ${column} must carry an explicit width under table-layout: fixed`);
    const px = rule[1].match(/width:\s*(\d+)px/);
    assert.ok(px, `Sessions column ${column} must state its width in px`);
    return Number(px[1]);
  };

  assert.match(css, /\.session-layout > \.card table \{[^}]*table-layout:\s*fixed/, "the widths below only bind under fixed layout");
  // Column 1 is the EMPTY expander. Left unsized it swallowed the surplus.
  for (let column = 1; column <= 10; column += 1) assert.ok(width(column) > 0, `column ${column} must be sized`);
  assert.ok(width(1) <= 60, `the empty expander column is ${width(1)}px — it must not absorb the table's surplus`);

  // Column 10 is Health. 78px left 50px of content for a ~60-character sentence.
  assert.ok(width(10) >= 200, `Health is ${width(10)}px; a ~60-character verdict needs far more`);
  assert.ok(width(10) > width(8) && width(10) > width(9), "Health must not be sized like the two-digit number columns beside it");

  const open = css.indexOf(".health-pill {");
  assert.ok(open !== -1, ".health-pill must be styled");
  const pill = css.slice(open, css.indexOf("}", open));
  assert.doesNotMatch(pill, /overflow-wrap:\s*anywhere/, "break-anywhere is what shattered the sentence mid-word");
  assert.doesNotMatch(pill, /word-break:\s*break-all/, "break-all shatters words the same way");
  assert.match(pill, /overflow-wrap:\s*break-word/, "only a word that cannot fit on a line of its own may be broken");
});

test("the date-range select's focus ring is not cancelled by a higher-specificity rule", () => {
  // WHY A CSS TEST: `.range-picker select { outline: 0 }` is specificity
  // (0,1,1) and quietly beat the global `:focus-visible { outline: 2px ... }`
  // at (0,1,0). Verified live under real Tab navigation: the element matched
  // :focus-visible with a computed outline of `none 0px` and no box-shadow.
  // It is the one control that changes every number on every page, so a
  // keyboard user had no way to see where they were. No text assertion in
  // this suite could see that, because nothing about the markup was wrong.
  const css = stripCssComments(read(path.join(PUBLIC, "css", "style.css")));

  const globalRing = css.match(/(^|\})\s*:focus-visible\s*\{([^}]*)\}/);
  assert.ok(globalRing, "the global :focus-visible ring must exist for anything to be cancelled");
  assert.match(globalRing[2], /outline:\s*2px\s+solid/, "the global ring is what the select must not lose");

  // The resting rule may still clear the browser default, but only if a
  // focus-visible rule of HIGHER specificity puts an indicator back.
  const resting = css.match(/\.range-picker select\s*\{([^}]*)\}/);
  assert.ok(resting, ".range-picker select must still be styled");
  const clearsOutline = /outline:\s*(0|none)\b/.test(resting[1]);

  const focusRule = css.match(/\.range-picker select:focus-visible\s*\{([^}]*)\}/);
  assert.ok(
    focusRule,
    clearsOutline
      ? ".range-picker select clears its outline, so .range-picker select:focus-visible must restore one"
      : ".range-picker select:focus-visible must state the ring explicitly rather than rely on the cascade",
  );
  const body = focusRule[1];
  assert.doesNotMatch(body, /outline:\s*(0|none)\b/, "the focus rule must not itself cancel the ring it exists to restore");
  assert.ok(
    /outline:\s*\d+px\s+\w+\s+var\(--[\w-]+\)/.test(body) || /box-shadow:\s*[^;]*var\(--[\w-]+\)/.test(body),
    `the focus indicator must be visible and use an existing token; got "${body.trim()}"`,
  );

  // Specificity, stated as the thing that actually decides it: the focus rule
  // carries every selector part of the resting rule plus the pseudo-class, so
  // it wins whatever order the two appear in.
  const restingAt = css.indexOf(".range-picker select {");
  const focusAt = css.indexOf(".range-picker select:focus-visible");
  assert.ok(restingAt !== -1 && focusAt !== -1);
  assert.ok(focusAt > restingAt, "a same-or-higher-specificity focus rule must not be overridden by a later resting rule");
});

test("the Fixes card's chip and sparkline never describe a different series from its own value", () => {
  // Reproduced live for 2026-09-19 -> 2026-09-22: 3 distinct fixes against 4 in
  // the window before (down 25%), rendered as "3 ↑ 63.8%" — because the value
  // was distinctFixes.count while the chip and sparkline were fed
  // fixableFindings. The old fixture hid it by setting the two equal.
  const health = populatedOverviewHealth({
    windowTotals: { sessions: 179, observedFindings: 113, fixableFindings: 113, unknownChecks: 236 },
    windowSeries: { sessions: [110, 179], observedFindings: [49, 39, 20, 5], fixableFindings: [49, 39, 20, 5], unknownChecks: [236] },
    distinctFixes: { count: 3, findings: 113 },
    comparison: {
      available: true,
      windowDays: 4,
      deltas: {
        sessions: { from: 110, to: 179, changePercent: 62.7 },
        observedFindings: { from: 69, to: 113, changePercent: 63.8 },
        fixableFindings: { from: 69, to: 113, changePercent: 63.8 },
      },
    },
  });
  const mount = new ShimElement("main");
  return overviewPage.default(mount, health, { api: populatedOverviewApi }).then(() => {
    const cards = withClass(mount, "summary-card");
    const fixesCard = cards.find((card) => /Suggestions available/.test(card.textContent));
    assert.ok(fixesCard, "the Suggestions card must render");
    assert.equal(withClass(fixesCard, "rx-number")[0].textContent, "3", "the value is the distinct-fix count");

    const chip = withClass(fixesCard, "rx-delta")[0];
    assert.ok(chip, "a card without a comparable delta still says so rather than going blank");
    assert.doesNotMatch(chip.textContent, /63\.8/, "63.8% is the findings change, not the distinct-fix change");
    assert.doesNotMatch(chip.textContent, /[↑↓]/, "no direction may be drawn from a series this card does not show");
    assert.match(chip.textContent, /not comparable/);
    assert.equal(withClass(fixesCard, "sparkline").length, 0, "a sparkline of fixableFindings does not belong under a distinct-fix count");

    // And this is not "every chip was removed": the Sessions card keeps its own.
    const sessionsCard = cards.find((card) => /Sessions analyzed/.test(card.textContent));
    assert.match(withClass(sessionsCard, "rx-delta")[0].textContent, /↑ 62\.7%/, "a card whose own series IS published keeps its delta");
    const problemsCard = cards.find((card) => /Problems found/.test(card.textContent));
    assert.match(withClass(problemsCard, "rx-delta")[0].textContent, /↑ 63\.8%/, "observedFindings is the Problems card's own series");
  });
});

test("a seven-day mean renders a rounded headline, and no rendered string states a fraction of a token", () => {
  const card = overviewPage.trendCard("Token spend", "spend", {
    spend: { available: true, to: 333071747.43, changePercent: -61.4, firstHalfDays: 7, secondHalfDays: 7 },
  }, { spend: [] }, "total", "Total tokens per day", "accent");

  const level = withClass(card, "trend-level")[0];
  assert.ok(level, "the headline must render");
  assert.match(level.textContent, /^\d{1,3}(\.\d{1,2})?[KMB]$/, `a 7-day mean cannot support "${level.textContent}"`);
  assert.equal(level.textContent, "333M");

  // Rounded is not the same as hidden: the whole-token figure stays on the card.
  assert.match(card.textContent, /333,071,747/, "the exact published value must stay reachable");

  for (const value of renderedStrings(card)) {
    assert.doesNotMatch(value, /\d{4,}\.\d/, `a fraction of a token is not a measured unit: ${JSON.stringify(value)}`);
    assert.ok(!value.includes("333071747"), `the published value must be grouped, not raw: ${JSON.stringify(value)}`);
  }

  // A percentage headline is untouched — this rounding is about token counts.
  const cache = overviewPage.trendCard("Cache hit rate", "cache", {
    cache: { available: true, to: 98.12, changePercent: -0.1, secondHalfDays: 7 },
  }, { cache: [] }, "hitRate", "Cache hits (%)", "pass");
  assert.match(withClass(cache, "trend-level")[0].textContent, /^98\.12%$/);
});

test("one rule, one severity: the Sessions page reads the shared helper in both places", () => {
  // `long-rising-context` is declared `critical`. A second mapping in
  // sessions.js (`severity === 'error' ? 'High' : 'Medium'`) rendered it High in
  // Key findings and Medium in the detail panel of the same page.
  const sessions = stripJsComments(read(path.join(PUBLIC, "js", "pages", "sessions.js")));
  assert.doesNotMatch(sessions, /severity\s*===\s*['"]error['"]/, "sessions.js must not map severity itself");
  for (const label of ["'High'", '"High"', "'Medium'", '"Medium"', "'Low'", '"Low"']) {
    assert.ok(!sessions.includes(label), `the severity label ${label} must live only in components/ui.js`);
  }
  assert.match(sessions, /finding-\$\{severity\(rule\)\.toLowerCase\(\)\}/, "Key findings must read the shared helper");
  assert.match(sessions, /const level = severity\(rule\)/, "the detail panel must read the same shared helper");

  const rule = { id: "long-rising-context", name: "Context keeps rising", severity: "critical" };
  assert.equal(ui.severity(rule), "High", "a critical rule is High wherever it is rendered");
  for (const [declared, label] of [["critical", "High"], ["error", "High"], ["warn", "Medium"], ["info", "Low"], [undefined, "Low"]]) {
    assert.equal(ui.severity({ severity: declared }), label, `severity ${String(declared)} must map to ${label} once`);
  }
});

test("Sessions and Health use shared verdict styling with conditional header clauses", () => {
  const sessions = read(path.join(PUBLIC, "js", "pages", "sessions.js"));
  const health = read(path.join(PUBLIC, "js", "pages", "health.js"));
  assert.match(sessions, /sessionHealthNode\(session\?\.score, true\)/);
  assert.match(health, /healthNode\(score, false\)/);
  const score = { total: 6, passed: 4, observed: 1, unknown: 1, label: "4 of 6 checks passed, 1 problem observed, 1 could not be measured" };
  assert.equal(ui.healthNode(score, true).textContent, ui.healthNode(score, false).textContent);
});

test("Overview has no per-rule unknown lines and exactly one bottom disclosure", async () => {
  const mount = new ShimElement("main");
  await overviewPage.default(mount, populatedOverviewHealth({
    windowTotals: { sessions: 1, observedFindings: 2, unknownChecks: 6 },
    ruleTotals: [
      { id: "one", name: "One", observed: 2, unknown: 4 },
      { id: "two", name: "Two", observed: 1, unknown: 2 },
    ],
  }), { api: populatedOverviewApi });
  assert.equal(withClass(mount, "summary-card").length, 3);
  assert.equal(withClass(mount, "unmeasured-page-note").length, 1);
  assert.match(mount.textContent, /6 checks could not be measured from the session logs/);
  assert.doesNotMatch(mount.textContent, /could not be measured on \d+ sessions?/);
  assert.doesNotMatch(mount.textContent, /Checks not measured/);
});

test("Report keeps its explicit unknown and not-a-pass wording", () => {
  const report = read(path.join(PUBLIC, "js", "pages", "report.js"));
  assert.match(report, /could not be measured/i);
  assert.match(report, /not a pass/);
});

test("the passed segment is passed/total and never passed+unknown", () => {
  // The guard that matters most: an unmeasurable check must not widen the green
  // bar. 4 passed of 6 is 66.66%, not the 100% that 4 passed + 2 unknown would
  // give if unknown were folded into passed.
  const bar = withClass(renderCard(SESSION({})), "score-bar")[0];
  const passed = bar.childNodes.find((node) => node.className.includes("score-seg-passed"));
  assert.ok(passed, "a passed segment must exist");
  assert.equal(passed.style.width, `${(4 / 6) * 100}%`);

  // With nothing measurable at all the passed segment does not exist, rather
  // than filling the bar.
  const allUnknown = withClass(
    renderCard(SESSION({ score: { total: 6, passed: 0, observed: 0, unknown: 6, label: "" } })),
    "score-bar",
  )[0];
  assert.ok(
    !allUnknown.childNodes.some((node) => node.className.includes("score-seg-passed")),
    "0 passed draws no passed segment",
  );
  assert.ok(allUnknown.childNodes.some((node) => node.className.includes("score-seg-unknown")));
});

test("an unknown verdict is styled as neither pass nor warn, with its reason in evidence details", () => {
  const reason = "the cache counters were absent, so this could not be measured";
  const card = renderCard(SESSION({
    rules: [RULE({ evidence: { status: "unknown", reason, values: [], sources: [], derivation: null, parserVersion: "t" } })],
  }));
  const verdict = withClass(card, "verdict")[0];
  assert.ok(verdict.classList.contains("verdict-unknown"));
  assert.ok(!verdict.classList.contains("verdict-pass"));
  assert.ok(!verdict.classList.contains("verdict-warn"));
  assert.ok(!verdict.classList.contains("verdict-critical"));
  assert.equal(verdict.dataset.status, "unknown");
  assert.match(withClass(card, "verdict-more")[0].textContent, new RegExp(reason.slice(0, 40)), "the reason remains in evidence details");
  assert.equal(withClass(card, "verdict-reason").length, 0, "unknown reasons are not rendered as inline rows");
  assert.match(card.textContent, /COULD NOT BE MEASURED/);

  // Four states, four different row classes.
  const pass = withClass(renderCard(SESSION({})), "verdict")[0];
  assert.ok(pass.classList.contains("verdict-pass"));
  const warn = withClass(
    renderCard(SESSION({
      rules: [RULE({
        evidence: { status: "observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
      })],
    })),
    "verdict",
  )[0];
  assert.ok(warn.classList.contains("verdict-warn"));
  const crit = withClass(
    renderCard(SESSION({
      rules: [RULE({
        severity: "critical",
        evidence: { status: "observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
      })],
    })),
    "verdict",
  )[0];
  assert.ok(crit.classList.contains("verdict-critical"));
});

test("an observed finding offers [View suggestion]; an unmeasured check offers nothing", () => {
  const api = {};
  const rerender = () => {};
  const buttonText = (root) => nodes(root)
    .filter((node) => node.tagName === "BUTTON")
    .map((node) => node.textContent.trim());

  const observed = renderCard(
    SESSION({ rules: [RULE({ evidence: { status: "observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" } })] }),
    api,
    rerender,
  );
  assert.deepEqual(
    [...buttonText(observed)].sort(),
    ["View suggestion"],
    "SessionRx never applies or undoes anything, so the offer is a single view action",
  );
  const view = nodes(observed).find((node) => node.tagName === "BUTTON" && node.textContent.trim() === "View suggestion");
  assert.match(view.getAttribute("aria-label") ?? "", /^View the suggested change for /);

  const unknown = renderCard(
    SESSION({ rules: [RULE({ evidence: { status: "unknown", reason: "no data", values: [], sources: [], derivation: null, parserVersion: "t" } })] }),
    api,
    rerender,
  );
  assert.deepEqual(buttonText(unknown), [], "an unmeasured check must not offer a suggestion");
  assert.equal(withClass(unknown, "verdict-actions").length, 0);

  // Nor does a PASSING check, which has nothing to suggest either.
  assert.deepEqual(buttonText(renderCard(SESSION({}), api, rerender)), []);
});

/** True when `node` is a descendant of `ancestor` in the shim tree. */
function isInside(node, ancestor) {
  for (let cursor = node?.parent; cursor; cursor = cursor.parent) if (cursor === ancestor) return true;
  return false;
}

test("a rule's default state is ONE line, and the honesty surface is not behind the click", () => {
  // F-024: what ships must be the shape the brief specified — one line per
  // rule, the derivation and the evidence one keystroke away. This test pins
  // BOTH halves: that the substance is still in the DOM (it was not deleted),
  // and that the four things a user must never have to click for are outside
  // the disclosure.
  const api = {};
  const rerender = () => {};
  const observed = RULE({
    evidence: {
      status: "observed",
      reason: null,
      values: [{ label: "cache hit rate", value: 0.42, unit: "fraction" }],
      sources: ["claude session sess-1 · project session-rx"],
      derivation: "cacheRead / (cacheRead + cacheCreate) summed over 96 of 96 turns",
      parserVersion: "t",
    },
  });
  const row = withClass(renderCard(SESSION({ rules: [observed] }), api, rerender), "verdict")[0];

  // The collapsed line IS the <summary>, so the disclosure costs no extra row.
  const details = nodes(row).find((node) => node.tagName === "DETAILS");
  assert.ok(details, "the disclosure must be a native <details> — keyboard-operable without script");
  const summary = details.childNodes.find((node) => node.tagName === "SUMMARY");
  assert.ok(summary, "the collapsed line must BE the summary, not a row above it");
  assert.ok(summary.classList.contains("verdict-line"));

  // On the line: the rule, its headline number, and the verdict in words.
  assert.match(summary.textContent, /Low cache hit/);
  assert.match(summary.textContent, /cache hit rate: 42\.0%/, "the number the rule turns on stays on the line");
  assert.match(summary.textContent, /PROBLEM FOUND/);
  // And a label saying what is behind the fold, not a bare triangle.
  const toggle = withClass(summary, "verdict-toggle")[0];
  assert.ok(toggle, "the disclosure must be labelled");
  assert.match(toggle.textContent, /why|evidence|details/);

  // Behind the fold: the threshold derivation, the numbers and the citation —
  // kept in full. This is the half that proves nothing was deleted.
  const more = withClass(row, "verdict-more")[0];
  assert.ok(more, "the detail must exist, not have been dropped");
  assert.match(more.textContent, /Threshold 0\.85/);
  assert.match(more.textContent, /cacheRead \/ \(cacheRead \+ cacheCreate\) < 0\.85/, "the threshold's derivation");
  assert.match(more.textContent, /summed over 96 of 96 turns/, "the computation note");
  assert.match(more.textContent, /Evidence: claude session sess-1/, "the evidence citation");
  assert.ok(!/Threshold/.test(summary.textContent), "the derivation is NOT on the collapsed line");

  // The fix offer is a sibling of the disclosure, never a child of it.
  const offer = withClass(row, "verdict-offer")[0];
  assert.ok(offer, "an observed finding offers its fix on its own line");
  assert.ok(!isInside(offer, details), "[View suggestion] must never be behind a click");
  assert.match(offer.textContent, /Output hygiene instruction/, "the offer names the suggestion, not just its id");
  // No button inside the summary: a click on View suggestion must open the panel, not toggle.
  assert.deepEqual(
    nodes(summary).filter((node) => node.tagName === "BUTTON").map((node) => node.textContent),
    [],
    "a button inside <summary> would toggle the disclosure instead of acting",
  );
});

test("an unknown's reason stays in the evidence disclosure, not as an inline row", () => {
  const reason = "Nothing in Codex's rollout records establishes a sub-agent interval (DIS-004)";
  const row = withClass(
    renderCard(SESSION({
      rules: [RULE({
        evidence: { status: "unknown", reason, values: [], sources: [], derivation: null, parserVersion: "t" },
      })],
    })),
    "verdict",
  )[0];

  const details = nodes(row).find((node) => node.tagName === "DETAILS");
  assert.equal(withClass(row, "verdict-reason").length, 0, "an unknown has no inline reason row");
  assert.match(details.textContent, new RegExp(reason.slice(0, 40)));

  // The score sentence and the bar are card-level and likewise never folded.
  const card = renderCard(SESSION({}));
  const cardDetails = nodes(card).filter((node) => node.tagName === "DETAILS");
  for (const name of ["score-bar", "score-headline", "score-unknown-callout", "meta-grid"]) {
    const node = withClass(card, name)[0];
    assert.ok(node, `${name} must render`);
    for (const fold of cardDetails) {
      assert.ok(!isInside(node, fold), `${name} must not be inside a <details>`);
    }
  }
});

test("the headline number is the first one that can honestly be printed", () => {
  // A share on an observed-floor window may not be printed at all (BP-002.18),
  // so it cannot be the headline; the next real reading is.
  const rule = RULE({
    evidence: {
      status: "observed",
      reason: null,
      values: [
        { label: "context share", value: 1, unit: "fraction", windowSource: "observed-floor" },
        { label: "peak context", value: 41344, unit: "tokens" },
      ],
      sources: [], derivation: null, parserVersion: "t",
    },
  });
  assert.equal(healthPage.headlineValue(rule).label, "peak context");

  // With nothing printable, the first value is used and says it is absent —
  // "— not measured" is an honest headline; 0 would not be.
  const empty = RULE({
    evidence: {
      status: "observed", reason: null,
      values: [{ label: "turns", value: null, unit: "count" }],
      sources: [], derivation: null, parserVersion: "t",
    },
  });
  const row = withClass(renderCard(SESSION({ rules: [empty] })), "verdict")[0];
  const line = nodes(row).find((node) => node.tagName === "SUMMARY");
  assert.match(line.textContent, /turns: — not measured/);
  assert.ok(!/turns: 0/.test(line.textContent));
});

test("observed-floor renders as a lower bound and carries no percentage", () => {
  const card = renderCard(SESSION({ window: { tokens: 41344, source: "observed-floor" } }));
  const shown = card.textContent;
  assert.match(shown, /at least/, "a lower bound must say 'at least'");
  assert.match(shown, /41,344/, "the observed peak is still shown");
  assert.match(shown, /lower bound/, "and it is tagged as a bound, not a reading");
  assert.ok(!/%/.test(shown), `no percentage may appear for an observed floor: ${shown}`);
  assert.equal(withClass(card, "lower-bound").length, 1);

  const tag = withClass(card, "inferred-tag")[0];
  assert.ok(tag, "the bound must carry a tag");
  assert.match(tag.getAttribute("title") ?? "", /not a measured window/i);
});

test("observed-promoted is labelled inferred, and a `none` ladder derives no share (BP-002.18)", () => {
  const promoted = renderCard(SESSION({
    window: { tokens: 300000, source: "observed-promoted" },
    windowPromotion: { ladder: "vendor", modelId: "claude-opus-5", tableTokens: 200000, tokens: 300000 },
  }));
  assert.match(promoted.textContent, /inferred/);
  assert.match(promoted.textContent, /300,000/);
  assert.ok(!/at least/.test(promoted.textContent), "a real vendor tier is not a lower bound");
  assert.equal(withClass(promoted, "lower-bound").length, 0);
  assert.match(promoted.textContent, /known vendor tier, so shares derived from it are permitted/);

  const noLadder = renderCard(SESSION({
    window: { tokens: 512345, source: "observed-promoted" },
    windowPromotion: { ladder: "none", modelId: "some-model", tableTokens: 200000, tokens: 512345 },
  }));
  assert.match(noLadder.textContent, /512,345/);
  assert.match(noLadder.textContent, /inferred/);
  // BP-002.18: ladder `none` means there is nothing honest to divide by, so the
  // card must say no share is derived rather than print a 100%. RE-AIMED (wave
  // WJARG): the sentence no longer quotes the id at the user, so the id lives in
  // this comment and the assertion checks the plain wording AND its absence.
  assert.match(noLadder.textContent, /only the peak this session was seen holding/);
  assert.match(noLadder.textContent, /no context share is derived from it/);
  assert.ok(!/BP-002/.test(noLadder.textContent), "the card must not quote an internal id at the user");
  assert.ok(!/%/.test(noLadder.textContent), "and it prints no percentage at all");
});

test("an unknown window renders as not measured, not as 0 tokens", () => {
  const card = renderCard(SESSION({ window: { tokens: null, source: "unknown" } }));
  const value = metaMap(card).get("context window");
  assert.ok(value, "the card must show a context window row");
  assert.match(value.textContent, /not measured/);
  assert.ok(!/0/.test(value.textContent), "an unresolved window is not 0 tokens");
  assert.ok(!/0 tok/.test(card.textContent));

  const absent = withClass(value, "not-measured")[0];
  assert.match(
    absent.getAttribute("aria-label") ?? "",
    /no window could be resolved for this session/,
    "the row must say why the window is missing",
  );
});

test("the header carries CLI, session, duration and turn count", () => {
  const card = renderCard(SESSION({}));
  const head = withClass(card, "card-head")[0];
  assert.match(head.textContent, /claude/);
  assert.match(head.textContent, /sess-1/);
  assert.match(head.textContent, /2h 14m/);
  assert.match(head.textContent, /42 turns/);

  const noTimes = renderCard(SESSION({ startedAt: null, endedAt: null }));
  const noTimesHead = withClass(noTimes, "card-head")[0];
  assert.match(noTimesHead.textContent, /not measured/);
  assert.ok(!/0s|0m/.test(noTimesHead.textContent), "an unrecorded duration is not a zero duration");
  assert.match(
    withClass(noTimesHead, "not-measured")[0].getAttribute("aria-label") ?? "",
    /the session start or end was not recorded/,
  );
});

test("copyToClipboard falls back to the textarea path and never throws when navigator.clipboard is absent", async () => {
  // The DOM shim gives no `navigator.clipboard` and no real `execCommand`, so
  // this exercises the exact fallback path a browser without Clipboard API
  // access takes — and proves it resolves `false` rather than throwing.
  const ok = await suggestionPanel.copyToClipboard("some request text");
  assert.equal(typeof ok, "boolean");
});

test("a null data point breaks the line: spanGaps is false and the null survives", () => {
  const config = chart.buildChartConfig({
    kind: "line",
    labels: ["d1", "d2", "d3", "d4"],
    datasets: [{ label: "avg context", data: [1000, null, undefined, 4000] }],
  });
  assert.equal(config.type, "line");
  const dataset = config.data.datasets[0];
  assert.equal(dataset.spanGaps, false, "spanGaps must be false or Chart.js draws through the gap");
  assert.deepEqual(
    dataset.data,
    [1000, null, null, 4000],
    "a gap stays null — 0 would invent a trend that never happened",
  );
  assert.ok(!dataset.data.includes(0), "no null became 0");
});

test("toNullable maps every non-number to null, never to 0", () => {
  for (const input of [null, undefined, NaN, Infinity, -Infinity, "5", "", {}, [], true]) {
    assert.equal(chart.toNullable(input), null, `${String(input)} must become null`);
  }
  assert.equal(chart.toNullable(0), 0, "a measured zero is kept");
  assert.equal(chart.toNullable(-3.5), -3.5);
});

test("the stacked bar keeps nulls and stacks both axes", () => {
  const config = chart.buildChartConfig({
    kind: "stacked-bar",
    labels: ["d1", "d2"],
    datasets: [
      { label: "cache read", data: [10, null] },
      { label: "cache creation", data: [null, 20] },
    ],
  });
  assert.equal(config.type, "bar");
  assert.equal(config.options.scales.x.stacked, true);
  assert.equal(config.options.scales.y.stacked, true);
  assert.deepEqual(config.data.datasets[0].data, [10, null]);
  assert.deepEqual(config.data.datasets[1].data, [null, 20]);
});

test("G3 cache zones colour green >95, yellow 85..95, red <85, and a gap is neither", () => {
  const config = chart.buildChartConfig({
    kind: "zone-line",
    labels: ["a", "b", "c", "d", "e", "f"],
    datasets: [{ label: "hit rate", data: [99, 95, 85, 84.9, null, 100] }],
  });
  const dataset = config.data.datasets[0];
  assert.equal(dataset.spanGaps, false);
  assert.deepEqual(dataset.data, [99, 95, 85, 84.9, null, 100]);

  const colors = dataset.pointBackgroundColor;
  assert.equal(colors[0], colors[5], "99 and 100 are both green");
  assert.equal(colors[1], colors[2], "95 and 85 are both yellow (inclusive band)");
  assert.notEqual(colors[0], colors[1], "green and yellow differ");
  assert.notEqual(colors[1], colors[3], "yellow and red differ");
  assert.notEqual(colors[4], colors[0], "a gap is not coloured as a zone");
  assert.notEqual(colors[4], colors[1]);
  assert.notEqual(colors[4], colors[3]);
  assert.deepEqual({ ...chart.CACHE_ZONES }, { green: 95, yellow: 85 });
});

test("renderChart says the library is missing instead of drawing an empty box", () => {
  const container = new ShimElement("div");
  const saved = globalThis.Chart;
  delete globalThis.Chart;
  try {
    const result = chart.renderChart(container, { kind: "line", labels: ["a"], datasets: [{ data: [1] }] });
    assert.equal(result, null);
    assert.match(container.textContent, /chart library did not load/);
    assert.match(container.textContent, /absence of data/);
  } finally {
    if (saved !== undefined) globalThis.Chart = saved;
  }
});

test("renderChart draws through the injected constructor, and destroyChart tears it down", () => {
  const container = new ShimElement("div");
  const built = [];
  let destroyed = 0;
  class FakeChart {
    constructor(canvas, config) { built.push({ canvas, config }); }
    destroy() { destroyed += 1; }
  }
  const instance = chart.renderChart(
    container,
    { kind: "line", labels: ["a", "b"], datasets: [{ data: [1, null] }] },
    { ChartCtor: FakeChart },
  );
  assert.ok(instance instanceof FakeChart);
  assert.equal(built.length, 1);
  assert.equal(built[0].config.data.datasets[0].spanGaps, false);
  assert.equal(built[0].canvas.tagName, "CANVAS");
  assert.equal(chart.destroyChart(container), true);
  assert.equal(destroyed, 1);
  assert.equal(chart.destroyChart(container), false, "a second destroy is a no-op");
});

test("a caller-supplied Chart.js config is hardened at this boundary (the trends.js path)", () => {
  // public/js/pages/trends.js builds its own config and calls
  // renderChart(canvas, config). The null rule has to hold there too, so this
  // module forces it rather than trusting the caller.
  const canvas = new ShimElement("canvas");
  const wrap = new ShimElement("div");
  wrap.append(canvas);
  canvas.parentNode = wrap;
  let seen = null;
  class FakeChart {
    constructor(node, config) { seen = { node, config }; }
    destroy() {}
  }
  const instance = chart.renderChart(canvas, {
    type: "line",
    data: {
      labels: ["a", "b", "c", "d"],
      datasets: [
        { label: "careless", spanGaps: true, data: [1, undefined, NaN, 4] },
        { label: "points", data: [{ x: 1, y: 2 }, null] },
      ],
    },
    options: { responsive: true },
  }, { ChartCtor: FakeChart });

  assert.ok(instance instanceof FakeChart);
  assert.equal(seen.node, canvas, "a canvas target is drawn on directly, not wrapped again");
  assert.equal(seen.config.type, "line", "the caller's config is used, not replaced");
  assert.equal(seen.config.options.responsive, true, "the caller's options survive");
  assert.equal(seen.config.data.datasets[0].spanGaps, false, "spanGaps is forced false even when the caller set true");
  assert.deepEqual(
    seen.config.data.datasets[0].data,
    [1, null, null, 4],
    "undefined and NaN became explicit gaps, never 0",
  );
  assert.deepEqual(
    seen.config.data.datasets[1].data,
    [{ x: 1, y: 2 }, null],
    "point objects pass through untouched",
  );
  assert.equal(chart.destroyChart(canvas), true, "the chart is keyed on whatever renderChart was given");
});

test("a canvas whose library is missing explains itself in the canvas's parent", () => {
  const canvas = new ShimElement("canvas");
  const wrap = new ShimElement("div");
  wrap.append(canvas);
  canvas.parentNode = wrap;
  const saved = globalThis.Chart;
  delete globalThis.Chart;
  try {
    assert.equal(chart.renderChart(canvas, { type: "line", data: { labels: ["a"], datasets: [{ data: [1] }] } }), null);
    assert.match(wrap.textContent, /chart library did not load/);
  } finally {
    if (saved !== undefined) globalThis.Chart = saved;
  }
});

test("a series with no measurement at all says so rather than plotting a run of zeros", () => {
  const container = new ShimElement("div");
  class FakeChart { destroy() {} }
  const result = chart.renderChart(
    container,
    { kind: "line", labels: ["a", "b"], datasets: [{ data: [null, null] }] },
    { ChartCtor: FakeChart },
  );
  assert.equal(result, null);
  assert.match(container.textContent, /nothing to plot/);
  assert.match(container.textContent, /not a run of zeros/);
});

/**
 * A `/api/trends` payload, in the shape the real endpoint returns (verified
 * against a live response: window / days / clis / thresholds / charts / heatmap /
 * trend / excluded / unknowns / scan / diagnostics).
 */
const TRENDS = (over = {}) => ({
  window: { days: 2, from: "2026-09-19", to: "2026-09-20", timezone: "local", timezoneOffsetMinutes: -330 },
  days: [],
  clis: ["claude"],
  thresholds: {},
  charts: {},
  trend: {},
  excluded: [],
  unknowns: [],
  scan: { note: null },
  diagnostics: [],
  heatmap: {
    rows: 2,
    cols: 24,
    orientation: "day-major",
    days: ["2026-09-19", "2026-09-20"],
    hours: Array.from({ length: 24 }, (_, hour) => hour),
    grid: [
      new Array(24).fill(0).map((_, hour) => (hour === 9 ? 12 : 0)),
      new Array(24).fill(null),
    ],
    nonZeroCells: 1,
    maxCell: 12,
    placedTurns: 12,
    daysWithoutData: 1,
  },
  ...over,
});

test("the heatmap tells a measured zero apart from a day nobody collected", () => {
  const mount = new ShimElement("section");
  trendsPage.renderTrends(mount, TRENDS());

  const cells = withClass(mount, "heatmap-cell").filter((node) => node.tagName === "DIV");
  assert.equal(cells.length, 48, "two days x 24 hours of data cells");

  const measured = cells.filter((node) => !node.classList.contains("is-null"));
  const nulls = cells.filter((node) => node.classList.contains("is-null"));
  assert.equal(measured.length, 24, "the collected day contributes 24 measured cells");
  assert.equal(nulls.length, 24, "the uncollected day contributes 24 hatched cells");
  assert.ok(measured.some((node) => node.dataset.level === "4"), "the peak hour is the top level");
  assert.ok(measured.some((node) => node.dataset.level === "0"), "a measured quiet hour is level 0");

  // A measured zero says zero; an uncollected hour says nobody looked. The two
  // must not be the same cell, and the hatched one must carry no level at all.
  const quiet = measured.find((node) => node.dataset.level === "0");
  assert.match(quiet.getAttribute("title") ?? "", /— 0 turns$/);
  for (const node of nulls) {
    assert.equal(node.dataset.level, undefined, "an uncollected cell has NO level — it is not a zero");
    assert.match(
      node.getAttribute("title") ?? "",
      /no data collected for this day \(not zero turns\)/,
      "and it says so on hover, in those words",
    );
  }

  // The legend carries both scales, so the hatch is explained rather than guessed.
  const swatches = withClass(mount, "heatmap-cell").filter((node) => node.tagName === "I");
  assert.equal(swatches.length, 6, "five levels plus the no-data key");
  const key = swatches.filter((node) => node.classList.contains("is-null"));
  assert.equal(key.length, 1);
  assert.equal(key[0].getAttribute("title"), "a day with no data at all");
  // The count of hatched days is stated in words beside the key, so the reader
  // does not have to count tiles.
  assert.match(mount.textContent, /no data \(1 day\)/);

  const heat = withClass(mount, "heatmap")[0];
  assert.equal(heat.style.getPropertyValue("--heatmap-cols"), "24");
  // The grid's own description names the hatched days, for a reader who cannot
  // see the hatching.
  assert.match(
    heat.getAttribute("aria-label") ?? "",
    /1 day\(s\) carried no data at all and are hatched rather than shown as quiet/,
  );
});

test("the heatmap reports an absent grid instead of rendering an empty frame", () => {
  const mount = new ShimElement("section");
  trendsPage.renderTrends(mount, TRENDS({ heatmap: {} }));
  const wrap = nodes(mount).find((node) => node.dataset?.chart === "g4-activity");
  assert.ok(wrap, "the G4 card must still be there, saying what is missing");
  assert.match(wrap.textContent, /No activity grid was built for this window/);
  assert.equal(withClass(wrap, "heatmap-cell").length, 0, "no cells are drawn for an absent grid");
});

// ==========================================================================
// C. The server-not-running contract (app.js `request()`)
//
// SessionRx is local-only: `npx session-rx` serves 127.0.0.1:7331 and the tab
// talks to it. Its most likely failure is that the server process is gone
// (closed terminal, Ctrl+C, sleep) while the tab is still open — at which
// point `fetch()` rejects with a bare TypeError("Failed to fetch") that told
// a real user nothing. These tests drive `app.js`'s `api` through a
// substitute `globalThis.fetch`, restored in a `finally` so no test leaks its
// mock into the next one.
// ==========================================================================

test("a network-level fetch rejection is reported as the server not responding, not the raw browser string", async () => {
  const saved = globalThis.fetch;
  const networkError = new TypeError("Failed to fetch");
  globalThis.fetch = () => Promise.reject(networkError);
  try {
    await assert.rejects(app.api.get("/api/health"), (error) => {
      assert.notEqual(error.message, "Failed to fetch", "the bare TypeError message must not reach the user verbatim");
      assert.match(error.message, /server/i, "must name the server as the subject");
      assert.match(error.message, /not responding|no longer running/i, "must say the server looks down");
      assert.match(error.message, /npx session-rx/, "must give the concrete next step: restart it");
      assert.ok(!/[!]/.test(error.message), "no exclamation marks");
      return true;
    });
  } finally {
    globalThis.fetch = saved;
  }
});

test("an HTTP error response keeps its server-supplied message unchanged (not conflated with 'server down')", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(
    new Response(JSON.stringify({ error: "Session store is corrupted" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    await assert.rejects(app.api.get("/api/health"), (error) => {
      assert.equal(
        error.message,
        "Session store is corrupted",
        "a real HTTP error (the request DID reach the server) must surface the server's own message, unchanged",
      );
      assert.ok(
        !/not responding|no longer running/i.test(error.message),
        "a 503 that reached the server must not be reported as the server being down",
      );
      return true;
    });
  } finally {
    globalThis.fetch = saved;
  }
});

test("the original network error is kept as `cause`, so nothing is lost", async () => {
  const saved = globalThis.fetch;
  const networkError = new TypeError("Failed to fetch");
  globalThis.fetch = () => Promise.reject(networkError);
  try {
    await assert.rejects(app.api.get("/api/trends"), (error) => {
      assert.equal(error.cause, networkError, "the rewritten error must carry the original as `cause`");
      return true;
    });
  } finally {
    globalThis.fetch = saved;
  }
});

test("an aborted request is not rewritten as 'server not running'", async () => {
  const saved = globalThis.fetch;
  const abortError = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  globalThis.fetch = () => Promise.reject(abortError);
  try {
    await assert.rejects(app.api.get("/api/report"), (error) => {
      assert.equal(error, abortError, "an AbortError must pass through unchanged, not be rewrapped");
      assert.ok(!/not responding|no longer running/i.test(error.message));
      return true;
    });
  } finally {
    globalThis.fetch = saved;
  }
});

// ==========================================================================
// D. The stale-nonce contract (app.js `request()`)
//
// The server mints a fresh CSRF nonce on every start (`crypto.randomBytes`)
// and injects it into the served HTML. GET requests skip CSRF, so a tab left
// open through a server restart keeps rendering — until the user clicks
// Preview/Apply/Undo, whose mutating request still carries the previous
// process's nonce and gets a 403 with the raw "does not match this server's
// startup nonce" string. That is accurate and useless: the actionable fact is
// "reload the page". These tests key ONLY off `body.reason`, never off the
// 403 status, because 403 is also returned for host/origin rejections that
// mean something else entirely and must keep their own message.
// ==========================================================================

const csrfResponse = (reason, error) => new Response(JSON.stringify({ error, reason }), {
  status: 403,
  headers: { "Content-Type": "application/json" },
});

test("a stale csrf_token_mismatch is reported as a page that needs reloading, not the raw nonce string", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(
    csrfResponse("csrf_token_mismatch", "X-CSRF-Token does not match this server's startup nonce"),
  );
  try {
    await assert.rejects(app.api.post("/api/fixes/1/apply"), (error) => {
      assert.notEqual(
        error.message,
        "X-CSRF-Token does not match this server's startup nonce",
        "the raw nonce-mismatch string must not reach the user verbatim",
      );
      assert.match(error.message, /reload/i, "must tell the user to reload the page");
      assert.match(error.message, /SessionRx/, "must name what the page is stale from");
      assert.ok(!/[!]/.test(error.message), "no exclamation marks");
      return true;
    });
  } finally {
    globalThis.fetch = saved;
  }
});

test("a stale csrf_token_missing gets the same reload message", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(
    csrfResponse("csrf_token_missing", "X-CSRF-Token header is required on every mutating request"),
  );
  try {
    await assert.rejects(app.api.post("/api/fixes/1/apply"), (error) => {
      assert.match(error.message, /reload/i, "must tell the user to reload the page");
      assert.match(error.message, /SessionRx/, "must name what the page is stale from");
      assert.notEqual(
        error.message,
        "X-CSRF-Token header is required on every mutating request",
        "the raw missing-token string must not reach the user verbatim",
      );
      return true;
    });
  } finally {
    globalThis.fetch = saved;
  }
});

test("a host_not_allowed 403 keeps its own server-supplied message, not the reload message", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(
    csrfResponse("host_not_allowed", "Host header is not the loopback address this server is bound to"),
  );
  try {
    await assert.rejects(app.api.post("/api/fixes/1/apply"), (error) => {
      assert.equal(
        error.message,
        "Host header is not the loopback address this server is bound to",
        "host_not_allowed is not a stale-page condition and must not be rewritten as one",
      );
      assert.ok(!/reload/i.test(error.message), "must not tell the user to reload — that is the wrong fix here");
      return true;
    });
  } finally {
    globalThis.fetch = saved;
  }
});

test("an origin_rejected 403 keeps its own server-supplied message, not the reload message", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(
    csrfResponse("origin_rejected", "Origin header is not this server's own origin"),
  );
  try {
    await assert.rejects(app.api.post("/api/fixes/1/apply"), (error) => {
      assert.equal(
        error.message,
        "Origin header is not this server's own origin",
        "origin_rejected is not a stale-page condition and must not be rewritten as one",
      );
      assert.ok(!/reload/i.test(error.message), "must not tell the user to reload — that is the wrong fix here");
      return true;
    });
  } finally {
    globalThis.fetch = saved;
  }
});

test("the stale-nonce error carries the server body as `cause`, so nothing is lost", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(
    csrfResponse("csrf_token_mismatch", "X-CSRF-Token does not match this server's startup nonce"),
  );
  try {
    await assert.rejects(app.api.post("/api/fixes/1/apply"), (error) => {
      assert.equal(
        error.cause?.reason,
        "csrf_token_mismatch",
        "the rewritten error must carry the server's `reason` via `cause`",
      );
      assert.equal(
        error.cause?.error,
        "X-CSRF-Token does not match this server's startup nonce",
        "the original server message must still be reachable via `cause`, even though the user is shown the reload message instead",
      );
      return true;
    });
  } finally {
    globalThis.fetch = saved;
  }
});

// ==========================================================================
// C. The plain-language guard over every page and component.
//
// WHY IT READS FILES: the sibling sweep in tests/analyzer.test.js iterates the
// rule catalogues (`plain.*`) in memory. It therefore could not see a sentence
// assembled anywhere else, and 22 user-facing strings across five files kept
// their internal ids long after those catalogues were clean. A guard that
// covers part of a surface is how this class of defect persists, so this one
// reads the shipped SOURCE of every page and component — a page added later is
// covered without being named here.
// ==========================================================================

/** Internal ids and analyzer vocabulary that must never reach a user. */
const USER_TEXT_LEAKS = [
  /DIS-\d/i, /BP-\d/i, /\bF-\d/i, /\bsidechain/i, /\blinkage/i,
  /\bdenominator/i, /\bcorpus/i, /\bmagnitude/i,
];

/**
 * Every user-facing string literal in one JS source, as `[line, text]` pairs.
 *
 * LINE RULE: a line is a candidate only when it carries a quote character and is
 * not itself a comment (it does not begin with `*`, `//` or a slash-star). Prose
 * ABOUT a banned word — the comment you are reading — must not fail the guard.
 *
 * LITERAL RULE: within a candidate line, the CONTENTS of each '', "" and
 * backtick literal, with `${...}` interpolations dropped. What an interpolation
 * holds is code, not text: `${round(shiftPoints, 2)}` is an identifier no user
 * ever sees, while the prose around it is text every user does see. That is why
 * a finding names the STRING rather than the whole line.
 *
 * LIMITS, STATED: it reads one line at a time, so a literal split across lines
 * is scanned per line rather than as a whole sentence — enough to catch a banned
 * word, not enough to judge the sentence. An identifier is never a finding, so a
 * variable named after a contract field (`rule.magnitude`) does not trip it.
 */
function userFacingStrings(source) {
  const found = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
    if (!/['"`]/.test(line)) return;
    let i = 0;
    let quote = "";
    let buf = "";
    let depth = 0;
    const keep = () => { if (buf.trim()) found.push([index + 1, buf]); };
    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];
      if (!quote) {
        if (ch === "'" || ch === '"' || ch === "`") { quote = ch; buf = ""; }
        i += 1;
        continue;
      }
      if (ch === "\\") { buf += next ?? ""; i += 2; continue; }
      if (quote === "`" && ch === "$" && next === "{") { depth += 1; i += 2; continue; }
      if (depth > 0) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        i += 1;
        continue;
      }
      if (ch === quote) { keep(); quote = ""; buf = ""; i += 1; continue; }
      buf += ch;
      i += 1;
    }
    keep();
  });
  return found;
}

/** `userFacingStrings` itself, so a parser that quietly reads nothing cannot turn this green. */
test("userFacingStrings reads literal text, skips comments, and drops interpolations", () => {
  const sample = [
    "// a comment naming BP-002.18 is not a finding",
    " * nor is a jsdoc line naming DIS-004",
    "const a = 'plain text';",
    "const b = `a ${round(magnitude, 2)}-point shift`;",
    "const c = \"leaks BP-002.18 at the user\";",
    "const d = notMeasured('it is unknown \\u2014 not zero');",
  ].join("\n");
  const got = userFacingStrings(sample);
  const texts = got.map(([, textValue]) => textValue);
  assert.ok(texts.includes("plain text"), `literal text must be read: ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("a -point shift"), `an interpolation must be dropped, keeping its prose: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.includes("leaks BP-002.18")), "a literal carrying an id must be read");
  assert.ok(!texts.some((t) => t.includes("a comment naming")), "a line comment is not user-facing text");
  assert.ok(!texts.some((t) => t.includes("nor is a jsdoc")), "a jsdoc line is not user-facing text");
  // The interpolation is dropped, so the identifier inside it is invisible here.
  assert.ok(!texts.some((t) => /\bmagnitude/.test(t)), "an identifier inside `${}` must not reach the scan");
  assert.equal(userFacingStrings("const x = 1;").length, 0, "a line with no quote yields nothing");
});

test("no user-facing string in a page or component leaks an internal id or the analyzer's own vocabulary", () => {
  // Read from disk, and from the DIRECTORY rather than a hand-kept list, so a
  // page or component added later is swept without being named here.
  const dirs = [path.join(PUBLIC, "js", "pages"), COMPONENTS];
  const files = dirs.flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith(".js")).map((name) => path.join(dir, name)));
  assert.ok(files.length >= 5, `only ${files.length} page/component files found — the sweep is not reaching public/js`);

  const findings = [];
  let checked = 0;
  for (const file of files) {
    for (const [line, textValue] of userFacingStrings(read(file))) {
      checked += 1;
      for (const leak of USER_TEXT_LEAKS) {
        if (leak.test(textValue)) findings.push(`${rel(file)}:${line} leaks ${leak} -> ${JSON.stringify(textValue)}`);
      }
    }
  }
  assert.ok(checked >= 800, `only ${checked} string literals were scanned — the sweep is not reaching the page modules`);
  assert.deepEqual(
    findings,
    [],
    `user-facing text must name the thing, not the ticket:\n  ${findings.join("\n  ")}\n`
    + "Rewrite the sentence in plain English. Do NOT shrink USER_TEXT_LEAKS to get green.",
  );
});
