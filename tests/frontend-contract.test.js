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
const COMPONENT_FILES = ["fix-modal.js", "chart.js"]
  .map((name) => path.join(COMPONENTS, name));
const RETIRED_COMPONENTS = ["health-card.js"].map((name) => path.join(COMPONENTS, name));
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

/** Depth-first walk of a shim tree. */
function nodes(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    out.push(node);
    (node.childNodes ?? []).forEach((child) => stack.push(child));
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
const fixModal = await import("../public/js/components/fix-modal.js");
const chart = await import("../public/js/components/chart.js");

/** The shipping card, under its real signature. */
const renderCard = (session, api = null, rerender = null) => healthPage.sessionCard(session, api, rerender);

// ==========================================================================
// A. Static contract
// ==========================================================================

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
  assert.match(html, /name="csrf-token"/, "must carry the CSRF meta the server rewrites (BP-005.13)");
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
    ".modal", ".diff", ".badge-unknown", ".verdict-unknown",
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
      assert.ok(!sink.test(src), `${rel(file)} must not use ${sink} — this origin can POST fix-apply`);
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
  // The API publishes the human name next to the id (server.js
  // `annotateFixTitles`); the page no longer keeps its own copy.
  fixTitle: "Output hygiene instruction",
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

test("the score line always states the unknown count, even when it is 0", () => {
  const withUnknown = renderCard(SESSION({}));
  assert.match(withUnknown.textContent, /4\/6 checks passed/);
  assert.match(withUnknown.textContent, /2 could not be measured/);
  // And spelled out once more, against the total, whenever anything is unknown.
  assert.match(withUnknown.textContent, /2 of 6 checks could not be measured on this session/);
  assert.match(withUnknown.textContent, /Those are not passes/);

  const clean = renderCard(SESSION({ score: { total: 6, passed: 6, observed: 0, unknown: 0, label: "" } }));
  assert.match(clean.textContent, /6\/6 checks passed/);
  assert.match(clean.textContent, /0 could not be measured/, "the phrase is unconditional");

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

test("an unknown verdict shows its reason and is styled as neither pass nor warn", () => {
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
  assert.match(card.textContent, new RegExp(reason.slice(0, 40)), "the reason must be visible");
  // In words, in the row — not in a tooltip, and not as a pass.
  assert.match(card.textContent, /This is NOT a pass — the check could not run here/);
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

test("an observed finding offers [Preview] [Apply] [Skip]; an unmeasured check offers nothing", () => {
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
    ["Apply", "Preview", "Skip"],
    "the brief specifies exactly these three actions",
  );
  // Apply is the only primary action; Preview must not be the one-click path.
  const apply = nodes(observed).find((node) => node.tagName === "BUTTON" && node.textContent.trim() === "Apply");
  assert.ok(apply.className.includes("button-primary"));
  assert.match(apply.getAttribute("aria-label") ?? "", /^Apply the fix for /);

  const unknown = renderCard(
    SESSION({ rules: [RULE({ evidence: { status: "unknown", reason: "no data", values: [], sources: [], derivation: null, parserVersion: "t" } })] }),
    api,
    rerender,
  );
  assert.deepEqual(buttonText(unknown), [], "an unmeasured check must not offer a fix");
  assert.equal(withClass(unknown, "verdict-actions").length, 0);

  // Nor does a PASSING check, which has nothing to fix either.
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
  assert.ok(!isInside(offer, details), "[Preview] [Apply] [Skip] must never be behind a click");
  assert.match(offer.textContent, /Output hygiene instruction/, "the offer names the fix, not just its id");
  // No button inside the summary: a click on Apply must apply, not toggle.
  assert.deepEqual(
    nodes(summary).filter((node) => node.tagName === "BUTTON").map((node) => node.textContent),
    [],
    "a button inside <summary> would toggle the disclosure instead of acting",
  );
});

test("an unknown's reason stays visible, outside the disclosure", () => {
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
  const reasonNode = withClass(row, "verdict-reason")[0];
  assert.ok(reasonNode, "an unknown must state why it could not run");
  assert.ok(!isInside(reasonNode, details), "that reason must not be behind a disclosure — it is the product's point");
  assert.match(reasonNode.textContent, /This is NOT a pass — the check could not run here/);
  assert.match(reasonNode.textContent, new RegExp(reason.slice(0, 40)));

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
  // BP-002.18: ladder `none` means the denominator IS the numerator, so the
  // card must say no share is derived rather than print a 100%.
  assert.match(noLadder.textContent, /no context share is derived from it \(BP-002\.18\)/);
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

test("the fix diff reaches the DOM character-identical to the bytes the API returned", () => {
  const diff = [
    "--- a/.claude/CLAUDE.md",
    "+++ b/.claude/CLAUDE.md",
    "@@ -1,3 +1,8 @@",
    " # existing heading",
    "-removed line with  double  spaces",
    "+<!-- session-rx:output-hygiene:v1 -->",
    "+## SessionRx: output hygiene",
    "+\tindented with a real tab",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const pre = fixModal.renderDiff(diff);
  assert.equal(pre.textContent, diff, "the rendered text must equal the diff byte for byte");
  assert.equal(pre.dataset.rendered, "verbatim");

  // Colour comes from wrapping, never from rewriting.
  const classes = pre.childNodes.filter((node) => node.className).map((node) => node.className);
  assert.ok(classes.some((cls) => cls.includes("ins")), "added lines are marked");
  assert.ok(classes.some((cls) => cls.includes("del")), "removed lines are marked");
  assert.ok(classes.some((cls) => cls.includes("hunk")), "hunk headers are marked");
  // `---`/`+++` are file headers, not a deletion and an addition.
  assert.equal(pre.childNodes[0].className, "diff-line meta");
  assert.equal(pre.childNodes[2].className, "diff-line meta");

  // Markup inside a diff is text, not markup.
  const hostile = '+<img src=x onerror="alert(1)">';
  const escaped = fixModal.renderDiff(hostile);
  assert.equal(escaped.textContent, hostile);
  assert.equal(escaped.childNodes.length, 1);
  assert.ok(!(escaped.childNodes[0] instanceof ShimElement) || escaped.childNodes[0].childNodes.length === 0);
});

test("an empty diff says the API returned none, rather than showing a blank box", () => {
  const pre = fixModal.renderDiff("");
  assert.match(pre.textContent, /no diff/i);
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
