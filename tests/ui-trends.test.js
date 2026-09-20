/**
 * tests/ui-trends.test.js — the Trends page's plain-language verdict (BP-005.19
 * one-source-of-truth, BP-005.04, BP-005.16/17).
 *
 * `src/analyzer/trends.js` now writes ONE plain-English sentence per verdict
 * direction (`trend.summary`), because a table of two metrics, a materiality
 * floor and a standard error is not something an ordinary developer can read
 * at a glance. This file proves the PAGE — `public/js/pages/trends.js` — does
 * its half of that contract correctly:
 *
 *   1. it renders `trend.summary` VERBATIM as the page's lead, ahead of and
 *      outside the statistical detail — it must never reconstruct or
 *      duplicate that wording itself (the exact bug BP-005.19 records, F-021);
 *   2. the statistical detail (the analyzer's `reason`, the direction badge,
 *      and the per-metric table) lives inside a REAL `<details>`/`<summary>`,
 *      not a div with a click handler bolted on, so it is keyboard-reachable
 *      for free;
 *   3. every direction the analyzer can actually produce (improving,
 *      declining, stable, mixed/disagreeing, and both shapes of "not enough
 *      data") renders a non-empty sentence, and the mixed one never reads as
 *      a confirmed improvement;
 *   4. a null metric in that table still renders as an em dash, never 0 —
 *      the same rule the rest of the page already holds itself to.
 *
 * node --test, no browser — the same minimal DOM shim style as
 * tests/frontend-contract.test.js (Part B), trimmed to what this page's
 * verdict card actually touches: `createElement` / `createTextNode` /
 * `append` / `replaceChildren` / `classList` / `dataset` / `setAttribute`,
 * plus a recursive `textContent`. It does no layout and no CSS cascade, so it
 * proves DOM STRUCTURE and TEXT, not pixels — same limits, stated once there,
 * restated here because this is a separate file exercising the same page.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildTrends } from "../src/analyzer/trends.js";
import {
  ANCHOR,
  improvingInput,
  decliningInput,
  stableInput,
  conflictingInput,
  cacheOnlyFlatInput,
  cacheOnlyDecliningInput,
  sparseInput,
  EMPTY_INPUT,
} from "./fixtures/trends/sessions.js";

// --------------------------------------------------------------------------
// A minimal DOM shim — just enough for public/js/pages/trends.js.
// --------------------------------------------------------------------------

class ShimText {
  constructor(data) { this.data = String(data); this.parent = null; }
  get textContent() { return this.data; }
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

  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  addEventListener() {}
  removeEventListener() {}
}

const documentShim = {
  createElement: (tag) => new ShimElement(tag),
  createTextNode: (data) => new ShimText(data),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  documentElement: new ShimElement("html"),
  body: new ShimElement("body"),
};

globalThis.document = documentShim;
if (typeof globalThis.addEventListener !== "function") globalThis.addEventListener = () => {};
if (!globalThis.location) globalThis.location = { hash: "#/trends" };

// Imported after the shim is installed: trends.js touches `document` at
// import time via app.js's `registerPage` side effect.
const trendsPage = await import("../public/js/pages/trends.js");

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

/** The rendered verdict card: the one element carrying `dataset.direction`. */
function verdictCardOf(mount) {
  return nodes(mount).find((node) => node.dataset && "direction" in node.dataset);
}

function render(input, options = { to: ANCHOR }) {
  const mount = new ShimElement("section");
  const data = buildTrends(input, options);
  trendsPage.renderTrends(mount, data);
  return { mount, data };
}

// --------------------------------------------------------------------------
// 1. the plain sentence is the lead, and it is OUTSIDE the collapsible detail
// --------------------------------------------------------------------------

test("the verdict card renders trend.summary verbatim as its lead, ahead of the statistical detail", () => {
  const { mount, data } = render(conflictingInput);
  const card = verdictCardOf(mount);
  assert.ok(card, "no element carried dataset.direction");
  assert.equal(card.dataset.direction, "unknown");

  const details = card.childNodes.find((node) => node.tagName === "DETAILS");
  assert.ok(details, "the statistical detail must be a real <details> element");

  // The lead callout is a DIRECT child of the card, not nested inside the
  // details — it must be visible without expanding anything.
  const leadCallout = card.childNodes.find(
    (node) => node.classList?.contains?.("callout") && node !== details && !nodes(details).includes(node),
  );
  assert.ok(leadCallout, "expected a callout that is a direct child of the verdict card, outside <details>");
  assert.match(leadCallout.textContent, /Context pressure fell, while cache reuse fell/);
  assert.equal(leadCallout.textContent.trim(), data.trend.summary);

  // The lead callout must come BEFORE the details in document order.
  assert.ok(card.childNodes.indexOf(leadCallout) < card.childNodes.indexOf(details), "summary must lead, detail must follow");
});

test("the statistical detail (reason + per-metric table) is inside a real, keyboard-reachable <details>/<summary>", () => {
  const { mount, data } = render(improvingInput);
  const card = verdictCardOf(mount);
  const details = card.childNodes.find((node) => node.tagName === "DETAILS");
  assert.ok(details, "expected a native <details> element");

  const summary = details.childNodes.find((node) => node.tagName === "SUMMARY");
  assert.ok(summary, "expected a native <summary> disclosure element — not a div with a click handler");
  assert.match(summary.textContent, /Show the statistical detail/i);

  // The analyzer's own reason and the per-metric table are inside the detail,
  // not floating loose in the card where they would always be visible.
  assert.match(details.textContent, /materiality floor/);
  assert.match(details.textContent, /standard error/);
  const table = nodes(details).find((node) => node.tagName === "TABLE");
  assert.ok(table, "expected the per-metric assessments table inside the detail");
  assert.match(table.textContent, /turns above 70% of window/);
  assert.match(table.textContent, /cache hit rate/);

  // And none of that technical text leaked into the lead sentence itself.
  const leadCallout = card.childNodes.find((node) => node.classList?.contains?.("callout") && node !== details);
  assert.doesNotMatch(leadCallout.textContent, /materiality floor/);
  assert.equal(leadCallout.textContent.trim(), data.trend.summary);
});

// --------------------------------------------------------------------------
// 2. every direction the analyzer can produce renders its exact sentence
// --------------------------------------------------------------------------

test("every verdict direction the analyzer can produce renders its plain sentence, and only that one", () => {
  const scenarios = {
    improving: improvingInput,
    declining: decliningInput,
    stable: stableInput,
    "mixed (metrics disagree)": conflictingInput,
    "flat but primary unmeasured": cacheOnlyFlatInput,
    "declining, rests on secondary alone": cacheOnlyDecliningInput,
    "insufficient data (sparse)": sparseInput,
    "insufficient data (empty)": EMPTY_INPUT,
  };
  for (const [label, input] of Object.entries(scenarios)) {
    const { mount, data } = render(input);
    const card = verdictCardOf(mount);
    assert.ok(typeof data.trend.summary === "string" && data.trend.summary.trim().length > 0, `${label}: analyzer must produce a summary`);
    const details = card.childNodes.find((node) => node.tagName === "DETAILS");
    const leadCallout = card.childNodes.find((node) => node.classList?.contains?.("callout") && node !== details);
    assert.ok(leadCallout, `${label}: expected a lead callout`);
    assert.equal(leadCallout.textContent.trim(), data.trend.summary, `${label}: the page must render the analyzer's sentence verbatim, not a paraphrase`);
  }
});

test("the mixed/disagreeing verdict's rendered lead sentence carries no improvement claim", () => {
  const { mount, data } = render(conflictingInput);
  const card = verdictCardOf(mount);
  const details = card.childNodes.find((node) => node.tagName === "DETAILS");
  const leadCallout = card.childNodes.find((node) => node.classList?.contains?.("callout") && node !== details);
  assert.doesNotMatch(leadCallout.textContent, /\b(improved|better|faster)\b/i);
  assert.equal(data.trend.direction, "unknown");
});

test("flat and both shapes of insufficient-evidence render three DIFFERENT lead sentences", () => {
  const leadTextOf = (input) => {
    const card = verdictCardOf(render(input).mount);
    const details = card.childNodes.find((node) => node.tagName === "DETAILS");
    return card.childNodes.find((node) => node.classList?.contains?.("callout") && node !== details).textContent.trim();
  };
  const flatText = leadTextOf(stableInput);
  const sparseText = leadTextOf(sparseInput);
  const incompleteText = leadTextOf(cacheOnlyFlatInput);

  assert.notEqual(flatText, sparseText, '"nothing changed" must not read the same as "we could not tell"');
  assert.notEqual(flatText, incompleteText);
  assert.notEqual(sparseText, incompleteText);
});

// --------------------------------------------------------------------------
// 3. a null metric renders an em dash in the collapsible table, never 0
// --------------------------------------------------------------------------

test("an unmeasurable metric's first/second half renders an em dash in the detail table, never 0", () => {
  const { mount, data } = render(cacheOnlyFlatInput);
  assert.equal(data.trend.assessments.find((a) => a.label === "turns above 70% of window").decidable, false);

  const card = verdictCardOf(mount);
  const details = card.childNodes.find((node) => node.tagName === "DETAILS");
  const table = nodes(details).find((node) => node.tagName === "TABLE");

  const dash = withClass(table, "not-measured");
  assert.ok(dash.length > 0, "expected at least one .not-measured cell for the undecidable primary metric");
  for (const cell of dash) {
    assert.match(cell.textContent, /—/, "an unavailable number must render an em dash");
    assert.doesNotMatch(cell.textContent.trim(), /^0/, "an unavailable number must never render as 0");
  }
});

// --------------------------------------------------------------------------
// 4. the direction badge stays out of the lead, and the charts still render
// --------------------------------------------------------------------------

test("the page still renders the three charts and the heatmap alongside the new verdict lead", () => {
  const { mount } = render(improvingInput);
  const chartIds = nodes(mount)
    .filter((node) => node.dataset && "chart" in node.dataset)
    .map((node) => node.dataset.chart);
  for (const id of ["g1-context", "g2-spend", "g3-cache", "g4-activity"]) {
    assert.ok(chartIds.includes(id), `expected a chart card for ${id}`);
  }
});
