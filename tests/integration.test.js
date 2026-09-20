/**
 * tests/integration.test.js — the seam between the waves (wave 5D, F-022).
 *
 * WHY THIS FILE EXISTS. On 2026-09-20 this repo had 530 passing tests, a server
 * that started in 6 ms, and 125 real sessions diagnosed correctly — and every
 * tab rendered BLANK. The four page modules in public/js/pages/ self-register
 * with the router at import time, and nothing imported them: index.html loaded
 * only the stylesheet, the vendored chart library and /js/app.js. Every suite
 * passed because every suite tested one module at a time. Nobody owned the seam.
 *
 * So this file tests only the seam, and only in ways the other suites cannot:
 *
 *   A. WIRING, statically — index.html references every page module that exists;
 *      every import specifier reachable from index.html resolves on disk; no
 *      import points into _trash/ or at a retired module; nothing under public/
 *      reaches for a remote URL outside public/vendor/.
 *
 *   B. BOOT, in process — the modules index.html declares are imported IN THAT
 *      ORDER against a DOM shim, the DOMContentLoaded handler app.js registered
 *      is fired, `fetch` is answered with fixture payloads in the real endpoint
 *      shapes, and each of the four routes is then asserted to have rendered
 *      content into its own mount. A missing <script> tag, a page that stops
 *      calling registerPage, or a router that renders before registration all
 *      turn this red.
 *
 * LIMITS, STATED: the shim does no layout, no CSS cascade and no HTML parsing,
 * so this proves the modules load, register, fetch and produce DOM — not that
 * the pixels are right. The pixel claim is carried by
 * tests/frontend-contract.test.js (stylesheet + structure) and by the browser
 * screenshot in docs/.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PUBLIC = path.join(ROOT, "public");
const INDEX = path.join(PUBLIC, "index.html");

const read = (file) => readFileSync(file, "utf8");
const rel = (file) => path.relative(ROOT, file);
const INDEX_HTML = read(INDEX);

/** Every `src="…"` on a `<script>` in index.html, in document order. */
function scriptSources(html) {
  const out = [];
  const tag = /<script\b([^>]*)>/g;
  let match;
  while ((match = tag.exec(html)) !== null) {
    const attrs = match[1];
    const src = /\bsrc="([^"]+)"/.exec(attrs);
    if (!src) continue;
    out.push({ src: src[1], module: /\btype="module"/.test(attrs) });
  }
  return out;
}

/** A `/`-rooted URL in index.html back to the file it serves. */
const toFile = (src) => path.join(PUBLIC, src.replace(/^\//, ""));

const SCRIPTS = scriptSources(INDEX_HTML);
const PAGE_DIR = path.join(PUBLIC, "js", "pages");
const PAGE_FILES = readdirSync(PAGE_DIR).filter((name) => name.endsWith(".js")).sort();
const ROUTES = ["health", "trends", "sessions", "report"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Every import specifier in a module, static or dynamic. Comments are stripped
 * first so the prose in these files ("we do not import X") is not read as code.
 */
function importSpecifiers(source) {
  const src = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const out = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(src)) !== null) out.push(match[1]);
  }
  return out;
}

/** Transitive module graph from the module entry points index.html declares. */
function moduleGraph() {
  const entries = SCRIPTS.filter((script) => script.module).map((script) => toFile(script.src));
  const seen = new Set();
  const edges = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    for (const spec of importSpecifiers(read(file))) {
      const resolved = /^[./]/.test(spec) ? path.resolve(path.dirname(file), spec) : spec;
      edges.push({ from: file, spec, resolved, bare: !/^[./]/.test(spec) });
      if (!edges[edges.length - 1].bare) queue.push(resolved);
    }
  }
  return { entries, files: [...seen], edges };
}

const GRAPH = moduleGraph();

// ==========================================================================
// A. Wiring
// ==========================================================================

test("index.html loads every page module that exists (F-022)", () => {
  assert.ok(PAGE_FILES.length > 0, "public/js/pages must hold at least one page module");
  const loaded = SCRIPTS.filter((script) => script.module).map((script) => script.src);
  for (const name of PAGE_FILES) {
    const url = `/js/pages/${name}`;
    assert.ok(
      loaded.includes(url),
      `public/js/pages/${name} exists but index.html never loads it — `
      + "it self-registers at import time, so its tab renders blank. "
      + `index.html loads: ${loaded.join(", ")}`,
    );
  }
  // And a route per page module, so a page nobody can reach is caught too.
  for (const route of ROUTES) {
    assert.ok(PAGE_FILES.includes(`${route}.js`), `route "${route}" has no page module`);
    assert.match(INDEX_HTML, new RegExp(`id="page-${route}"`), `no mount for route "${route}"`);
    assert.match(INDEX_HTML, new RegExp(`data-route="${route}"`), `no tab for route "${route}"`);
  }
});

test("the router loads before the pages, and every module script is a module", () => {
  const modules = SCRIPTS.filter((script) => script.module).map((script) => script.src);
  assert.ok(modules.includes("/js/app.js"), "index.html must load the router");
  assert.equal(modules[0], "/js/app.js", "the router is listed first, so a broken page cannot take it down");

  // The vendored chart library is a CLASSIC script: it must define `Chart`
  // before any deferred module runs. A `type="module"` here would defer it too.
  const vendor = SCRIPTS.find((script) => script.src.startsWith("/vendor/"));
  assert.ok(vendor, "the vendored chart library must be loaded");
  assert.equal(vendor.module, false, "the vendored UMD build must stay a classic script");
  assert.ok(
    SCRIPTS.indexOf(vendor) < SCRIPTS.findIndex((script) => script.module),
    "the vendored library is loaded before the modules that use it",
  );
});

test("every module reachable from index.html resolves on disk", () => {
  for (const file of GRAPH.entries) {
    assert.ok(existsSync(file), `index.html loads ${rel(file)}, which does not exist`);
  }
  assert.ok(GRAPH.edges.length > 0, "the page modules must import something — the router at least");
  for (const edge of GRAPH.edges) {
    assert.ok(
      !edge.bare,
      `${rel(edge.from)} imports the bare specifier "${edge.spec}" — the browser cannot resolve that`,
    );
    assert.ok(
      existsSync(edge.resolved),
      `${rel(edge.from)} imports "${edge.spec}", which resolves to a file that does not exist: ${rel(edge.resolved)}`,
    );
    assert.ok(
      edge.resolved.startsWith(PUBLIC + path.sep),
      `${rel(edge.from)} imports "${edge.spec}", which escapes public/ — the server cannot serve it`,
    );
  }
});

test("no import points at a retired module", () => {
  // F-021 retired public/js/components/health-card.js and chart.js's
  // `renderHeatmap` to _trash/. A dangling import would break the page at
  // runtime while every unit suite stayed green, which is exactly the class of
  // defect this file exists to catch.
  const retired = [/_trash/, /health-card\.js/];
  for (const edge of GRAPH.edges) {
    for (const pattern of retired) {
      assert.ok(
        !pattern.test(edge.spec) && !pattern.test(edge.resolved),
        `${rel(edge.from)} still imports the retired "${edge.spec}"`,
      );
    }
  }
  assert.ok(
    !existsSync(path.join(PUBLIC, "js", "components", "health-card.js")),
    "health-card.js was retired to _trash/ — a copy under public/ means two implementations again",
  );
  const chart = read(path.join(PUBLIC, "js", "components", "chart.js"));
  assert.ok(!/export function renderHeatmap/.test(chart), "renderHeatmap was retired with it");
  // And the two exports that DO have product callers are still there.
  for (const kept of ["renderChart", "destroyChart"]) {
    assert.match(chart, new RegExp(`export function ${kept}\\b`), `${kept} is called from pages/trends.js`);
  }
  assert.match(
    read(path.join(PUBLIC, "js", "components", "fix-modal.js")),
    /export function openFixModal\b/,
    "openFixModal is called from pages/health.js",
  );
  assert.ok(!/renderHeatmap|health-card/.test(INDEX_HTML), "index.html must not reference a retired module");
});

test("nothing under public/ reaches for a remote URL outside public/vendor/", () => {
  const offenders = [];
  for (const file of walk(PUBLIC)) {
    if (path.relative(PUBLIC, file).split(path.sep)[0] === "vendor") continue;
    const source = read(file);
    for (const match of source.match(/https?:\/\/[^\s"'`)<>]*/g) ?? []) offenders.push(`${rel(file)} -> ${match}`);
  }
  assert.deepEqual(offenders, [], `the tool is local-only; these reach outward:\n${offenders.join("\n")}`);
});

// ==========================================================================
// B. Boot, in process
// ==========================================================================

class ShimText {
  constructor(data) { this.data = String(data); this.parent = null; }
  get textContent() { return this.data; }
}

class ShimFragment {
  constructor() { this.childNodes = []; this.isFragment = true; }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }
  append(...nodes) { ShimElement.prototype.append.call(this, ...nodes); }
}

class ShimElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parent = null;
    this.id = "";
    this.hidden = false;
    this.type = "";
    this._text = "";
    this._className = "";
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this._styles = new Map();
    this.style = {
      setProperty: (name, value) => this._styles.set(name, String(value)),
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
      if (child.isFragment) { this.append(...child.childNodes); return; }
      child.parent = this;
      if (this.childNodes.length === 0 && this._text) {
        this.childNodes.push(new ShimText(this._text));
        this._text = "";
      }
      this.childNodes.push(child);
    });
  }

  replaceChildren(...nodes) { this.childNodes = []; this._text = ""; this.append(...nodes); }

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
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

/** Depth-first walk of a shim tree. */
function nodesOf(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    out.push(node);
    (node.childNodes ?? []).forEach((child) => stack.push(child));
  }
  return out;
}

/**
 * The shell index.html declares, as shim nodes.
 *
 * Derived FROM index.html rather than hand-listed: the ids, the tabs and the
 * mounts are read out of the real file, so a mount that disappears from
 * index.html disappears from the boot too and the render assertions fail.
 */
function buildShell(html) {
  const byId = new Map();
  const all = [];
  const make = (tag, className, id) => {
    const node = new ShimElement(tag);
    if (className) node.className = className;
    if (id) { node.id = id; byId.set(id, node); }
    all.push(node);
    return node;
  };

  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
    if (/^page-/.test(id)) continue;
    make("div", "", id);
  }
  for (const [, route] of html.matchAll(/data-route="([^"]+)"/g)) {
    const tab = make("a", "tab", "");
    tab.dataset.route = route;
  }
  const mounts = new Map();
  for (const [, id, page] of html.matchAll(/id="(page-[^"]+)"[^>]*data-page="([^"]+)"/g)) {
    const mount = make("section", "page-mount", id);
    mount.dataset.page = page;
    mounts.set(page, mount);
  }

  const document_ = {
    createElement: (tag) => new ShimElement(tag),
    createTextNode: (data) => new ShimText(data),
    createDocumentFragment: () => new ShimFragment(),
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: (selector) => {
      if (selector.startsWith("#")) return byId.get(selector.slice(1)) ?? null;
      if (selector.startsWith(".")) return all.find((node) => node.classList.contains(selector.slice(1))) ?? null;
      return null;
    },
    querySelectorAll: (selector) => (selector.startsWith(".")
      ? all.filter((node) => node.classList.contains(selector.slice(1)))
      : []),
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: new ShimElement("html"),
    body: new ShimElement("body"),
  };
  return { document: document_, mounts, byId, all };
}

// --- fixture payloads, in the shapes the live endpoints return ---------------

const RULE_UNKNOWN = {
  id: "subagent-concurrency",
  name: "Sub-agent concurrency",
  severity: "warn",
  fix: null,
  threshold: { value: 3, derivation: "more than 3 concurrent sub-agents" },
  magnitude: null,
  evidence: {
    status: "unknown",
    reason: "this CLI exposes no sub-agent marker, so the count is unknown rather than zero (DIS-004)",
    values: [], sources: [], derivation: null, parserVersion: "t",
  },
};

const RULE_OBSERVED = {
  id: "output-hygiene",
  name: "Unbounded command output",
  severity: "warn",
  fix: "claude-output-hygiene",
  threshold: { value: 50, derivation: "more than 50 lines of tool output in one turn" },
  magnitude: 120,
  evidence: {
    status: "observed",
    reason: null,
    values: [{ label: "widest turn", value: 120, unit: "lines" }],
    sources: ["session transcript"],
    derivation: "the widest single tool result in this session",
    parserVersion: "t",
  },
};

const FIXTURES = {
  "/api/collectors": {
    collectors: [
      { id: "claude", displayName: "Claude Code", installed: true, status: "supported", paths: ["~/.claude/projects"] },
      { id: "kimi", displayName: "Kimi CLI", installed: false, status: "not detected", paths: [] },
    ],
    diagnostics: [],
  },
  "/api/health": {
    sessions: [{
      cli: "claude",
      sessionId: "boot-session-1",
      project: "session-rx",
      cwd: "/tmp/session-rx",
      model: "claude-opus-5",
      window: { tokens: 1000000, source: "observed-promoted" },
      windowPromotion: { ladder: "vendor", modelId: "claude-opus-5", tableTokens: 200000, tokens: 1000000 },
      startedAt: "2026-09-20T10:00:00.000Z",
      endedAt: "2026-09-20T12:14:00.000Z",
      turnCount: 42,
      subagentTurns: null,
      score: { total: 6, passed: 4, observed: 1, unknown: 1, label: "" },
      rules: [RULE_OBSERVED, RULE_UNKNOWN],
    }],
    collectors: [{ cli: "claude", sessions: 1, support: "supported", note: null }],
    promotions: [],
    diagnostics: [],
    scan: { note: null },
    generatedAt: "2026-09-20T12:20:00.000Z",
  },
  "/api/trends": {
    window: { days: 2, from: "2026-09-19", to: "2026-09-20", timezone: "local", timezoneOffsetMinutes: -330 },
    days: [], clis: ["claude"], thresholds: {}, charts: {}, trend: {}, excluded: [], unknowns: [],
    scan: { note: null }, diagnostics: [],
    heatmap: {
      rows: 2, cols: 24, orientation: "day-major",
      days: ["2026-09-19", "2026-09-20"],
      hours: Array.from({ length: 24 }, (_, hour) => hour),
      grid: [new Array(24).fill(0).map((_, hour) => (hour === 9 ? 7 : 0)), new Array(24).fill(null)],
      nonZeroCells: 1, maxCell: 7, placedTurns: 7, daysWithoutData: 1,
    },
  },
  "/api/sessions": {
    sessions: [{
      cli: "claude",
      sessionId: "boot-session-1",
      project: "session-rx",
      model: "claude-opus-5",
      startedAt: "2026-09-20T10:00:00.000Z",
      endedAt: "2026-09-20T12:14:00.000Z",
      turnCount: 42,
      subagentTurns: null,
      window: { tokens: 1000000, source: "observed-promoted" },
      score: { total: 6, passed: 4, observed: 1, unknown: 1, label: "" },
      rules: [RULE_OBSERVED, RULE_UNKNOWN],
    }],
    total: 1, returned: 1, scan: { note: null }, diagnostics: [],
  },
  "/api/report": {
    markdown: "# SessionRx report\n\nOne session read.\n",
    generatedAt: "2026-09-20T12:20:00.000Z",
    redactions: [], scan: { note: null }, diagnostics: [],
  },
};

/**
 * Boot the app the way the browser does: install the shell, answer `fetch` with
 * the fixtures, import the module scripts index.html declares IN ORDER, then
 * fire the DOMContentLoaded handler app.js registered.
 *
 * ONCE PER PROCESS, and that is not a shortcut. ES modules are evaluated once
 * per specifier, so a second boot would re-import cached modules: no module body
 * would run, app.js would register no new listener, and its `store` cache would
 * already be warm. A second `boot()` would therefore assert against the first
 * boot's state while looking independent. The three assertions below are
 * subtests of one boot instead, which is also what a browser does — one load,
 * then navigation.
 */
async function boot() {
  const shell = buildShell(INDEX_HTML);
  const requested = [];
  const captured = new Map();

  const saved = {
    document: globalThis.document,
    location: globalThis.location,
    fetch: globalThis.fetch,
    addEventListener: globalThis.addEventListener,
    Chart: globalThis.Chart,
  };

  globalThis.document = shell.document;
  globalThis.location = { hash: "#/health" };
  globalThis.addEventListener = (type, handler) => {
    if (!captured.has(type)) captured.set(type, []);
    captured.get(type).push(handler);
  };
  // index.html loads the vendored UMD build as a classic script, so `Chart` is
  // defined before any module runs. A stand-in keeps that true here.
  globalThis.Chart = class FakeChart {
    constructor(canvas, config) { this.canvas = canvas; this.config = config; }
    destroy() {}
  };
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const body = FIXTURES[String(url)];
    if (!body) return { ok: false, status: 404, json: async () => ({ error: `no fixture for ${url}` }) };
    return { ok: true, status: 200, json: async () => body };
  };

  for (const script of SCRIPTS.filter((entry) => entry.module)) {
    await import(pathToFileURL(toFile(script.src)).href);
  }

  const settle = async () => { for (let i = 0; i < 25; i += 1) await new Promise((r) => setTimeout(r, 0)); };
  const fire = async (type) => {
    for (const handler of captured.get(type) ?? []) await handler();
    await settle();
  };
  const go = async (route) => { globalThis.location.hash = `#/${route}`; await fire("hashchange"); };

  await fire("DOMContentLoaded");
  const restore = () => Object.assign(globalThis, saved);
  return { shell, requested, captured, fire, go, restore };
}

test("the app boots in process, registers all four routes, and renders real DOM", async (t) => {
  const app = await boot();
  try {
    await t.test("the health page renders on first load (F-022 regression)", () => {
      assert.ok(
        app.captured.has("DOMContentLoaded"),
        "app.js must register a DOMContentLoaded handler — module scripts run before that event fires",
      );
      assert.ok(app.requested.includes("/api/health"), `the health route must fetch /api/health; got ${app.requested}`);
      assert.ok(app.requested.includes("/api/collectors"), "the shell must fetch the collector list");

      const mount = app.shell.mounts.get("health");
      assert.ok(mount, "index.html must declare a #page-health mount");
      const rendered = mount.textContent;
      assert.ok(
        rendered.length > 200,
        "the health mount is empty or near-empty: nothing rendered into it. "
        + "This is F-022 — index.html is not loading the page modules.",
      );

      // The score headline, in the form the brief specifies.
      assert.match(
        rendered,
        /\d+\/\d+ checks passed · \d+ problems? observed · \d+ could not be measured/,
        "the score headline must state passed, observed AND unmeasured",
      );
      // An unknown verdict, with its reason, is visible on a real boot.
      assert.match(rendered, /This is NOT a pass — the check could not run here/);
      assert.match(rendered, /no sub-agent marker/);
      // And the observed finding offers the three actions.
      const buttons = nodesOf(mount)
        .filter((node) => node.tagName === "BUTTON")
        .map((node) => node.textContent.trim());
      assert.deepEqual([...buttons].sort(), ["Apply", "Preview", "Skip"]);

      // The shell's own regions were filled by app.js, not left on their
      // placeholder text.
      assert.match(app.shell.byId.get("cli-count").textContent, /1 detected/);
      assert.match(app.shell.byId.get("detected-clis").textContent, /Claude Code/);
      assert.ok(!/Loading local sources/.test(app.shell.byId.get("detected-clis").textContent));
      assert.equal(app.shell.byId.get("app-status").textContent, "", "no error banner on a clean boot");
    });

    await t.test("every route registered a renderer and renders into its own mount", async () => {
      for (const route of ROUTES) {
        await app.go(route);
        const mount = app.shell.mounts.get(route);
        assert.ok(mount, `index.html must declare a #page-${route} mount`);
        assert.ok(
          mount.textContent.length > 40,
          `route "${route}" rendered nothing — its module registered no renderer, `
          + `or index.html never loaded public/js/pages/${route}.js`,
        );
        assert.equal(mount.hidden, false, `the active route's mount must be visible; #page-${route} is hidden`);
        for (const other of ROUTES.filter((name) => name !== route)) {
          assert.equal(app.shell.mounts.get(other).hidden, true, `#page-${other} must be hidden while on ${route}`);
        }
        assert.equal(app.shell.byId.get("app-status").textContent, "", `route "${route}" reported an error`);
        assert.ok(app.requested.includes(`/api/${route}`), `route "${route}" never called /api/${route}`);
      }
      // Each page put its own heading in, so no two routes share one renderer.
      assert.match(app.shell.mounts.get("health").textContent, /Session health/);
      assert.match(app.shell.mounts.get("trends").textContent, /Trends/);
      assert.match(app.shell.mounts.get("sessions").textContent, /Sessions/);
      assert.match(app.shell.mounts.get("report").textContent, /[Rr]eport/);
    });

    await t.test("an unknown hash falls back to health rather than rendering nothing", async () => {
      await app.go("no-such-route");
      assert.ok(
        app.shell.mounts.get("health").textContent.length > 200,
        "an unrecognised route must fall back to the health page, not to a blank shell",
      );
      assert.equal(app.shell.mounts.get("health").hidden, false);
    });
  } finally {
    app.restore();
  }
});
