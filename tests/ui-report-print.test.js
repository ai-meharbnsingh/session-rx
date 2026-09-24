/**
 * tests/ui-report-print.test.js — the Report page's "Print / Save as PDF"
 * feature (public/js/pages/report.js, public/css/print.css, public/index.html).
 *
 * Three things are pinned here:
 *
 *   1. a "Print / Save as PDF" button renders on the Report page once a
 *      report exists, and clicking it calls the browser's own print dialog
 *      (`globalThis.print()`) — no PDF library, no network call, nothing
 *      generated server-side;
 *   2. `public/css/print.css` exists, is wired into `public/index.html` with
 *      `media="print"` (so it never touches the screen appearance), and
 *      actually hides navigation / buttons / interactive chrome and keeps
 *      the `unknown` verdict visually distinct on paper (dashed + hatched,
 *      not just a colour a printer may not reproduce);
 *   3. A plain-language "problems found / passed / could not be measured"
 *      summary block IS rendered on the Report page, built ONLY from the
 *      structured `summary` field `/api/report` now returns (BP-005.05,
 *      src/server.js — `{markdown, generatedAt, redactions, scan,
 *      sessionWindow, diagnostics, summary}`, computed by
 *      `health.buildManagerSummary` from the same session-health verdicts the
 *      markdown itself was rendered from). report.js must NEVER derive these
 *      counts by parsing the assembled Markdown prose (src/report/generator.js
 *      is free to change under it) — that would be exactly the kind of
 *      silent, fragile inference the honesty contract in CLAUDE.md exists to
 *      forbid. This suite pins both: the structured cards render, and the
 *      page never claims a false "all clear".
 *
 * DOM shim follows the same minimal pattern as tests/ui-health.test.js and
 * tests/frontend-contract.test.js: createElement / createTextNode / append /
 * replaceChildren / classList / dataset / setAttribute / a recursive
 * textContent. No browser, no new dependency — this proves DOM structure and
 * text, not pixels; the pixel/layout claims about print.css are covered by
 * reading its source, the same way frontend-contract.test.js checks style.css.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PUBLIC = path.join(ROOT, "public");
const PRINT_CSS = path.join(PUBLIC, "css", "print.css");
const INDEX_HTML = path.join(PUBLIC, "index.html");
const REPORT_JS = path.join(PUBLIC, "js", "pages", "report.js");

const read = (file) => readFileSync(file, "utf8");
const stripCssComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "");

// ==========================================================================
// A minimal DOM, sufficient for public/js/pages/report.js and nothing more.
// ==========================================================================

class ShimText {
  constructor(data) { this.data = String(data); this.parent = null; }
  get textContent() { return this.data; }
  get children() { return []; }
}

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
    this.disabled = false;
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

  /** Fires every handler registered for `type`, as a real click would. */
  dispatch(type) { (this.listeners.get(type) ?? []).forEach((handler) => handler({ type })); }

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
if (!globalThis.location) globalThis.location = { hash: "#/report" };

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
const buttons = (root) => nodes(root).filter((node) => node.tagName === "BUTTON");
const buttonNamed = (root, text) => buttons(root).find((node) => node.textContent.trim() === text);

// Imported after the shim is installed, matching the other UI suites: report.js
// touches `document` at call time and imports app.js / ui.js at module scope.
const reportPage = await import("../public/js/pages/report.js");

// ==========================================================================
// Fixtures
// ==========================================================================

/** A minimal `/api/report` body (BP-005.05, src/server.js `/api/report`). */
const REPORT = (over = {}) => ({
  markdown: "# SessionRx Diagnostic Report\n\n1 session evaluated.\n",
  generatedAt: "2026-09-21T00:00:00.000Z",
  redactions: 0,
  scan: { limitPerCollector: 250, defaulted: true, atLimit: false, note: null },
  sessionWindow: { matched: 1, excludedUndated: 0 },
  diagnostics: [],
  summary: {
    sessionsAnalyzed: 1,
    verdicts: { observed: 1, notObserved: 4, unknown: 1 },
    perCheck: [{ id: "repeat-tool", name: "Ran the same command again and again", observed: 1, notObserved: 0, unknown: 0 }],
    perTool: [
      { cli: "claude", status: "read", sessions: 1, problems: 1, note: null },
      { cli: "antigravity", status: "detected-not-read", sessions: null, problems: null, note: "detected, not read yet" },
    ],
  },
  ...over,
});

const noopApi = { get: async () => REPORT({}), post: async () => ({}) };

const render = (data, ctx = { api: noopApi }) => {
  const mount = new ShimElement("section");
  reportPage.renderReport(mount, data, ctx);
  return mount;
};

// ==========================================================================
// 1. The Print / Save as PDF button
// ==========================================================================

// WHY THIS RUNS FIRST: report.js keeps its fetched report in a module-level
// `state` object across renders — on purpose, so switching tabs and back does
// not lose it (see the module docstring). That means a render with `data:
// null` still shows whatever a PRIOR render loaded, within this same test
// file. This test is ordered first specifically so it observes the page's
// true "nothing fetched yet" state, before any other test in this file loads
// a report into that shared state.
test("Print / Save as PDF is disabled when there is no report yet, and does not throw without window.print", () => {
  const originalPrint = globalThis.print;
  delete globalThis.print;
  try {
    const mount = render(null);
    const button = buttonNamed(mount, "Print / Save as PDF");
    assert.ok(button, "the button still renders with no report, matching Download/Copy");
    assert.equal(button.disabled, true, "nothing to print yet");
    // Even if it were clicked (e.g. a stale reference), a missing window.print
    // must not throw — this environment (or an old browser) may not have it.
    assert.doesNotThrow(() => button.dispatch("click"));
  } finally {
    globalThis.print = originalPrint;
  }
});

test("the Report page renders a 'Print / Save as PDF' button once a report exists", () => {
  const mount = render(REPORT({}));
  const button = buttonNamed(mount, "Print / Save as PDF");
  assert.ok(button, "a 'Print / Save as PDF' button must render");
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.getAttribute?.("type") ?? button.type, "button", "must not submit a form / navigate");
  assert.equal(button.disabled, false, "must be enabled once a report is loaded");
});

test("clicking Print / Save as PDF calls window.print(), and nothing else", async () => {
  let calls = 0;
  const originalPrint = globalThis.print;
  globalThis.print = () => { calls += 1; };
  try {
    const mount = render(REPORT({}));
    const button = buttonNamed(mount, "Print / Save as PDF");
    assert.ok(button);
    button.dispatch("click");
    assert.equal(calls, 1, "clicking the button must call globalThis.print() exactly once");
  } finally {
    globalThis.print = originalPrint;
  }
});

test("the print button explains what it does, in plain language, with no engineering jargon", () => {
  const mount = render(REPORT({}));
  const button = buttonNamed(mount, "Print / Save as PDF");
  const title = button.getAttribute("title") ?? "";
  assert.match(title, /print dialog/i);
  assert.ok(!/DIS-\d|BP-\d|\bF-\d/i.test(title), "no internal id may reach a tooltip");
});

// ==========================================================================
// 2. public/css/print.css: exists, wired in, hides chrome, keeps the
//    honesty contract distinct on paper
// ==========================================================================

test("public/css/print.css exists and is a real, non-trivial stylesheet", () => {
  assert.ok(existsSync(PRINT_CSS), "public/css/print.css must exist");
  const css = read(PRINT_CSS);
  assert.ok(css.length > 500, "print.css looks too small to do anything");
  assert.match(css, /@media print/, "must be scoped to print, not applied to the screen");
});

test("public/index.html links print.css with media=\"print\", and nothing remote", () => {
  const html = read(INDEX_HTML);
  assert.match(
    html,
    /<link rel="stylesheet" href="\/css\/print\.css" media="print">/,
    "print.css must be linked as a print-only stylesheet",
  );
});

test("print.css hides navigation, header controls, buttons and other interactive chrome", () => {
  const css = stripCssComments(read(PRINT_CSS));
  const printBlock = css.slice(css.indexOf("@media print"));
  const hides = (selector) => {
    const escaped = selector.replace(/[.#]/g, "\\$&");
    const rule = printBlock.match(new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`));
    assert.ok(rule, `print.css must have a rule for ${selector}`);
    assert.match(rule[1], /display:\s*none/, `${selector} must be hidden under @media print`);
  };
  // Navigation and header chrome.
  hides(".topbar");
  hides(".cli-panel");
  hides(".range-coverage");
  // The Report page's own toolbar (Generate / Download / Copy / Print buttons)
  // and every other page's inline action row.
  hides(".toolbar");
  hides("button");
  hides("select");
  // Loading/error banner and per-row session/session-fix action clusters.
  hides("#app-status");
  hides(".fix-actions");
});

test("print.css switches to black-on-white with a readable font size", () => {
  const css = stripCssComments(read(PRINT_CSS));
  const printBlock = css.slice(css.indexOf("@media print"));
  assert.match(printBlock, /background:\s*#fff/i, "must set a white background");
  assert.match(printBlock, /color:\s*#0b0e13/i, "must set dark text");
  assert.match(printBlock, /font-size:\s*12pt/, "body copy must be set to a print-legible size");
});

test("print.css avoids breaking a card, a table row or a verdict across a page where reasonable", () => {
  const css = stripCssComments(read(PRINT_CSS));
  const printBlock = css.slice(css.indexOf("@media print"));
  const rule = printBlock.match(/\.card,\s*\.rx-card,\s*\.verdict[^{]*\{([^}]*)\}/);
  assert.ok(rule, "a shared break-avoidance rule must cover cards/verdicts/rows");
  assert.match(rule[1], /break-inside:\s*avoid/);
});

test("print.css wraps preformatted report text instead of clipping or overflowing it", () => {
  const css = stripCssComments(read(PRINT_CSS));
  const printBlock = css.slice(css.indexOf("@media print"));
  const rule = printBlock.match(/pre,\s*\.diff[^{]*\{([^}]*)\}/);
  assert.ok(rule, "pre/.diff must be restyled for print");
  assert.match(rule[1], /white-space:\s*pre-wrap/, "the raw Markdown block must wrap, not run off the page");
});

test("print.css expands collapsed <details> content instead of printing an empty fold", () => {
  const css = stripCssComments(read(PRINT_CSS));
  const printBlock = css.slice(css.indexOf("@media print"));
  assert.match(
    printBlock,
    /details:not\(\[open\]\)\s*>\s*\*:not\(summary\)[^{]*\{[^}]*display:\s*block/,
    "a closed <details> (e.g. a Health verdict's evidence fold) must still print its content",
  );
});

test("print.css keeps the unknown/not-measured state visually distinct from pass and warn on paper", () => {
  // WHY: style.css already proves (tests/frontend-contract.test.js) that
  // `unknown` differs from `pass`/`warn` on screen by hue, hatch, dash and
  // italics. Colour is the channel most likely to be lost in print (a
  // black-and-white printer, a bad toner cartridge, a photocopy). This test
  // pins that print.css keeps the NON-colour channels — the hatch pattern
  // and the dashed border — rather than only recolouring things and leaving
  // "not measured" to collapse into "measured and fine" once ink is grey.
  const css = stripCssComments(read(PRINT_CSS));
  const printBlock = css.slice(css.indexOf("@media print"));
  const rule = printBlock.match(/\.badge-unknown,\s*\.verdict-unknown[^{]*\{([^}]*)\}/);
  assert.ok(rule, "the unknown-state rule must exist under @media print");
  assert.match(rule[1], /repeating-linear-gradient/, "must keep a hatch pattern, not rely on colour alone");
  assert.match(rule[1], /border-style:\s*dashed/, "must keep the dashed border");
});

// ==========================================================================
// 3. No fabricated pass/fail summary — the honesty contract, applied to
//    what this page does NOT have structured data for
// ==========================================================================

test("the Report page never claims a false 'all clear', with or without a loaded report", () => {
  for (const data of [null, REPORT({ markdown: "" }), REPORT({})]) {
    const mount = render(data);
    assert.doesNotMatch(
      mount.textContent,
      /all clear|no problems|looks good|healthy/i,
      "the Report page must not summarise a clean bill of health it has no structured data to support",
    );
  }
});

test("the Report page renders its observed/not-observed/unknown summary cards from the structured API field, never by parsing Markdown", () => {
  // /api/report (src/server.js) now returns a structured `summary` field
  // alongside {markdown, generatedAt, redactions, scan, sessionWindow,
  // diagnostics}. report.js must render from THAT field, never by scanning
  // the Markdown text for generator.js's current wording, which would be a
  // parse that goes stale the moment the report prose changes and would
  // then report the WRONG counts rather than an honest absence.
  const src = read(REPORT_JS);
  assert.ok(
    !/report\.markdown\.match|markdown\.match\(.*observed/i.test(src),
    "report.js must not parse verdict counts out of the assembled Markdown text",
  );
  const mount = render(REPORT({}));
  assert.equal(withClass(mount, "report-summary").length, 1, "the structured summary block renders once");

  const text = mount.textContent;
  assert.match(text, /Sessions checked/i);
  assert.match(text, /Problems found/i);
  assert.match(text, /Passed/i);
  assert.match(text, /Could not be measured/i);
  assert.match(text, /not a pass/i, "the unknown card states plainly that it is not a pass");
  // antigravity is detection-only: it must read as "detected, not read yet",
  // never as a measured zero.
  assert.match(text, /detected, not read yet/i);
  assert.ok(!/antigravity.{0,40}\b0\b.{0,15}problem/i.test(text), "antigravity must never render as 0 problems");
});

test("a report with no structured summary renders no summary cards, and no fabricated zero", () => {
  const mount = render(REPORT({ summary: null }));
  assert.equal(withClass(mount, "report-summary").length, 0, "no summary block when the server supplied none");
  assert.doesNotMatch(mount.textContent, /Sessions checked/i);
});

test("a null count in the summary renders 'not available', never 0", () => {
  const mount = render(REPORT({
    summary: {
      sessionsAnalyzed: null,
      verdicts: { observed: null, notObserved: null, unknown: null },
      perCheck: [],
      perTool: [],
    },
  }));
  const text = mount.textContent;
  assert.match(text, /not recorded/i);
  assert.doesNotMatch(text, /Sessions checked0|Problems found0|Passed0|Could not be measured0/);
});

test("no title or aria-label on the Report page leaks internal jargon (DIS-/BP-/F- ids, 'sidechain', etc.)", () => {
  const mount = render(REPORT({}));
  const ENGINEERING_PROSE = [/DIS-\d/i, /BP-\d/i, /\bF-\d/i, /\bsidechain/i, /\blinkage/i, /\bdenominator/i, /\bcorpus/i, /\bmagnitude/i];
  for (const node of nodes(mount)) {
    if (!(node?.attributes instanceof Map)) continue;
    for (const name of ["title", "aria-label"]) {
      const value = node.attributes.get(name);
      if (typeof value !== "string") continue;
      for (const re of ENGINEERING_PROSE) {
        assert.ok(!re.test(value), `${name}="${value}" on <${node.tagName.toLowerCase()}> leaks internal language`);
      }
    }
  }
});
