/**
 * tests/ui-health.test.js — the health-page UX wave (BP-001.24, BP-003).
 *
 * Covers the three things the product owner's brief asked for that
 * tests/frontend-contract.test.js does not pin:
 *
 *   1. a compact summary — sessions analyzed / problems found / fixes
 *      available / checks not measured — before any session card, with an
 *      absent count rendered as an em dash and never as 0;
 *   2. a plain-English sentence leading an OBSERVED finding, filled in from
 *      the rule's own measured number, with the raw jargon line kept intact
 *      below it;
 *   3. that compacting the cards did not cost the product its honesty
 *      surface: all three verdict states stay visually distinct, every
 *      finding still offers [Preview] [Apply] [Skip], and the scan-limit /
 *      sub-agent set-aside disclosures are still in the rendered output.
 *
 * Harness style follows tests/frontend-contract.test.js: a minimal DOM shim
 * (createElement / createTextNode / createDocumentFragment / classList /
 * dataset / setAttribute / a recursive textContent), no browser, no new
 * dependency. Same stated limits: no layout, no CSS cascade, no real event
 * dispatch — this proves DOM STRUCTURE and TEXT, not pixels.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ==========================================================================
// A minimal DOM, sufficient for public/js/pages/health.js and nothing more.
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

  removeEventListener() {}
  focus() {}
  scrollIntoView() {}
}

const registry = new Map();

const documentShim = {
  createElement: (tag) => new ShimElement(tag),
  createTextNode: (data) => new ShimText(data),
  createDocumentFragment: () => new ShimFragment(),
  getElementById: (id) => registry.get(id) ?? null,
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

/** Depth-first walk of a shim tree, registering every `id` it carries so
 * `getElementById` (used by the "Review fixes" jump) can find it. */
function nodes(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    out.push(node);
    if (typeof node?.id === "string" && node.id) registry.set(node.id, node);
    (node.childNodes ?? []).forEach((child) => stack.push(child));
  }
  return out;
}

const withClass = (root, name) => nodes(root).filter((node) => node.classList?.contains?.(name));
const withTag = (root, tag) => nodes(root).filter((node) => node.tagName === tag.toUpperCase());

/** Is `node` a descendant of `ancestor`? Used to tell the card FACE from the fold. */
const isInside = (node, ancestor) => {
  for (let cursor = node?.parent; cursor; cursor = cursor.parent) if (cursor === ancestor) return true;
  return false;
};

// Imported after the shim is installed, matching frontend-contract.test.js:
// health.js touches `document` at call time and imports app.js / fix-modal.js
// at module scope.
const healthPage = await import("../public/js/pages/health.js");

// ==========================================================================
// Fixtures
// ==========================================================================

const RULE = (over) => ({
  id: "cache-hit",
  name: "Low cache hit",
  severity: "warn",
  fix: "claude-output-hygiene",
  suggestionTitle: "Output hygiene instruction",
  suggestionAvailable: true,
  suggestionTool: "claude",
  suggestionToolName: "Claude Code",
  threshold: { value: 0.85, derivation: "cacheRead / (cacheRead + cacheCreate) < 0.85" },
  magnitude: null,
  plain: null,
  evidence: { status: "not-observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
  ...over,
});

const SESSION = (over) => ({
  cli: "claude",
  cliName: "Claude Code",
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

/** A minimal `/api/health` body (BP-005.01). */
const PAYLOAD = (over) => ({
  sessions: [SESSION({})],
  sessionsTotal: 1,
  collectors: [],
  subagentSessionsSetAside: null,
  promotions: [],
  diagnostics: [],
  scan: { limitPerCollector: 250, defaulted: true, atLimit: false, note: null },
  generatedAt: "2026-09-21T00:00:00.000Z",
  ...over,
});

const render = (data, ctx = { api: {} }) => {
  const mount = new ShimElement("section");
  healthPage.renderHealth(mount, data, ctx);
  return mount;
};

// ==========================================================================
// 1. The compact summary
// ==========================================================================

/** label -> value node, from `.summary-stats .summary-stat`. */
function summaryMap(mount) {
  const out = new Map();
  for (const cell of withClass(mount, "summary-stat")) {
    const value = cell.childNodes.find((node) => node.classList?.contains?.("summary-stat-value"));
    const label = cell.childNodes.find((node) => node.classList?.contains?.("summary-stat-label"));
    if (label && value) out.set(label.textContent.trim(), value);
  }
  return out;
}

test("the health page renders a summary region, before any card, with all four real counts", () => {
  const observedWithFix = RULE({
    id: "repeat-tool", name: "Repeated tool work", fix: "claude-batch-commands",
    evidence: { status: "observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
  });
  const observedNoFix = RULE({
    id: "large-tool-result", name: "Large tool results", fix: null,
    evidence: { status: "observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
  });
  const unknownRule = RULE({
    id: "subagent-concurrency", name: "High sub-agent concurrency",
    evidence: { status: "unknown", reason: "no data", values: [], sources: [], derivation: null, parserVersion: "t" },
  });
  const passRule = RULE({ id: "cache-hit" });

  const data = PAYLOAD({
    sessions: [
      SESSION({ sessionId: "sess-1", rules: [observedWithFix, unknownRule, passRule] }),
      SESSION({ sessionId: "sess-2", rules: [observedNoFix] }),
    ],
    sessionsTotal: 2,
  });
  const mount = render(data);

  const summary = withClass(mount, "health-summary")[0];
  assert.ok(summary, "a .health-summary region must render");
  // Before any card: both are direct children of the same `.page-stack`, in
  // real append order (unlike `nodes()`'s DFS, which is not document order).
  const cards = withClass(mount, "health-card");
  assert.ok(cards.length >= 1, "sanity: session cards must still render");
  const stack = mount.childNodes[0];
  const order = stack.childNodes;
  assert.ok(order.includes(summary), "the summary must be a direct child of the page stack");
  const summaryIndex = order.indexOf(summary);
  const firstCardIndex = order.findIndex((node) => node.classList?.contains?.("health-card"));
  assert.ok(firstCardIndex !== -1, "a session card must be a direct child of the page stack");
  assert.ok(summaryIndex < firstCardIndex, "the summary must render before the first card");

  const stats = summaryMap(mount);
  assert.equal(stats.get("Sessions analyzed").textContent.trim(), "2");
  // Two OBSERVED rules total (one per session), one of which carries a fix.
  assert.equal(stats.get("Problems found").textContent.trim(), "2");
  // Renamed from "Fixes available": the Overview card of that name counts
  // DISTINCT fixes, this one counts fixable FINDINGS. Same count, honest label.
  assert.equal(stats.get("Fixable findings").textContent.trim(), "1");
  assert.equal(stats.get("Checks not measured").textContent.trim(), "1");

  const action = withClass(mount, "summary-action")[0];
  assert.ok(action, "a 'Review fixes' action must render");
  assert.equal(action.textContent.trim(), "Review fixes");
  assert.equal(action.tagName, "BUTTON");
});

test("the Health summary and the Overview cards never share a label for two different quantities", () => {
  // WHY: both surfaces rendered a figure called "Fixes available". The Health
  // one counted fixable FINDINGS (9 live), the Overview one counted DISTINCT
  // fixes (4 live). Each page stated its own scope a line below, so neither
  // number was false — but under one identical label the wider scan showing
  // the smaller figure reads as a contradiction. The label now names the
  // quantity. What is counted did not change.
  const observedWithFix = RULE({
    id: "repeat-tool", name: "Repeated tool work", fix: "claude-batch-commands",
    evidence: { status: "observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
  });
  const secondObservedSameFix = RULE({
    id: "large-tool-result", name: "Large tool results", fix: "claude-batch-commands",
    evidence: { status: "observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
  });
  const data = PAYLOAD({
    sessions: [SESSION({ sessionId: "sess-1", rules: [observedWithFix, secondObservedSameFix] })],
    sessionsTotal: 1,
  });
  const stats = summaryMap(render(data));
  const healthLabels = [...stats.keys()];

  // The Health stat names findings, and still counts findings: TWO observed
  // findings carrying a fix, even though they name ONE distinct fix between
  // them — which is exactly the divergence the shared label hid.
  assert.ok(stats.has("Fixable findings"), `the Health fixable stat must be labelled "Fixable findings"; got ${JSON.stringify(healthLabels)}`);
  assert.equal(stats.get("Fixable findings").textContent.trim(), "2", "the label changed, the counted quantity did not");
  assert.ok(!stats.has("Fixes available"), '"Fixes available" is the Overview card\'s name for the distinct-fix count, and must not also name this one');

  // The other half of the contract: the Overview card is still called
  // "Suggestions available" over `distinctFixes`. If it is ever renamed to
  // match the Health stat, the collision is back and this test must fail.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const overviewSrc = readFileSync(path.join(here, "..", "public", "js", "pages", "overview.js"), "utf8");
  assert.match(overviewSrc, /summaryCard\('Suggestions available',\s*'fixes'/, "the Overview card must keep its own distinct-fix label");
  assert.ok(!overviewSrc.includes("'Fixable findings'"), "the findings label belongs to the Health summary alone");

  // No Health summary label may collide with an Overview card label unless the
  // two genuinely count the same thing.
  const overviewLabels = [...overviewSrc.matchAll(/summaryCard\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(overviewLabels.length >= 4, `expected the Overview cards to be readable from source; got ${JSON.stringify(overviewLabels)}`);
  const sameQuantity = new Set(["Sessions analyzed", "Problems found"]);
  for (const label of healthLabels) {
    if (!overviewLabels.includes(label)) continue;
    assert.ok(sameQuantity.has(label), `"${label}" names one quantity on Health and another on Overview`);
  }
});

test("a genuinely unavailable count renders an em dash, never 0 — and a real zero still renders as 0", () => {
  // Neither session published a `rules` array at all: nothing was evaluated,
  // so the three derived counts are unmeasurable, not a clean zero.
  const data = PAYLOAD({
    sessions: [SESSION({ sessionId: "sess-1", rules: undefined }), SESSION({ sessionId: "sess-2", rules: undefined })],
    sessionsTotal: 2,
  });
  const mount = render(data);
  const stats = summaryMap(mount);

  // Sessions analyzed is a real, always-known count: 2 sessions really were
  // shown, so it renders the number, not a dash.
  assert.equal(stats.get("Sessions analyzed").textContent.trim(), "2");

  for (const label of ["Problems found", "Fixable findings", "Checks not measured"]) {
    const node = stats.get(label);
    assert.ok(node, `${label} must render`);
    assert.match(node.textContent, /—/, `${label} must render an em dash when nothing was evaluated`);
    assert.ok(!/\b0\b/.test(node.textContent), `${label} rendered "${node.textContent}" — must not be 0`);
  }

  // A corpus with real rule data and genuinely zero observed problems, by
  // contrast, must show the real 0 — an evidenced zero is not an absence.
  const clean = render(PAYLOAD({
    sessions: [SESSION({ rules: [RULE({ evidence: { status: "not-observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" } })] })],
  }));
  const cleanStats = summaryMap(clean);
  assert.equal(cleanStats.get("Problems found").textContent.trim(), "0");
  assert.ok(!/—/.test(cleanStats.get("Problems found").textContent), "a real zero must not also carry a dash");
});

// ==========================================================================
// 2. Plain-language leading text
// ==========================================================================

test("an observed finding leads with its plain-language sentence, filled in from its own magnitude", () => {
  const rule = RULE({
    id: "repeat-tool",
    name: "Repeated tool work",
    fix: "claude-batch-commands",
    magnitude: 6,
    plain: {
      problem: "Your AI repeated the exact same tool call — same tool, same input, same result — {count} times in this session.",
      why: "This may indicate wasted work, but repeated calls are not always unnecessary — this is a DETECTED REPETITION, not CONFIRMED WASTE.",
    },
    evidence: {
      status: "observed", reason: null,
      values: [{ label: "highest number of identical tool call + input + result occurrences", value: 6, unit: "count" }],
      sources: [], derivation: null, parserVersion: "t",
    },
  });
  const mount = render(PAYLOAD({ sessions: [SESSION({ rules: [rule] })] }));

  const plain = withClass(mount, "verdict-plain")[0];
  assert.ok(plain, "an observed finding must render a .verdict-plain lead sentence");
  assert.match(plain.textContent, /repeated the exact same tool call.*6 times/s, "the {count} token must be filled from the rule's own magnitude");
  assert.ok(!plain.textContent.includes("{count}"), "the raw token must never reach the page");
  assert.match(plain.textContent, /DETECTED REPETITION/, "the hedge language must survive to the DOM");

  // The technical line (name, id, raw metric, PROBLEM FOUND) is still there,
  // beneath the plain sentence — nothing was deleted to make room for it.
  const summary = withTag(mount, "summary")[0];
  assert.match(summary.textContent, /Repeated tool work/);
  assert.match(summary.textContent, /repeat-tool/);
  assert.match(summary.textContent, /PROBLEM FOUND/);
});

test("a rule with no plain-language catalogue entry falls back to today's behaviour, not a blank or a crash", () => {
  const rule = RULE({
    evidence: { status: "observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
  });
  // No `plain` field at all (mirrors every fixture in frontend-contract.test.js).
  delete rule.plain;
  const mount = render(PAYLOAD({ sessions: [SESSION({ rules: [rule] })] }));
  assert.equal(withClass(mount, "verdict-plain").length, 0, "no plain field means no plain paragraph, not an empty one");
  const summary = withTag(mount, "summary")[0];
  assert.match(summary.textContent, /PROBLEM FOUND/, "the rest of the row must render exactly as before");
});

// An unknown now leads with `plain.unmeasured`, which is a different sentence
// for a different thing; what must never appear is the PROBLEM sentence, which
// would describe a finding that was never made.
test("a not-observed or unknown rule never leads with a plain 'problem' sentence — there is no problem to describe", () => {
  const observedPlain = {
    problem: "Something happened {count} times.",
    why: "A hedge.",
  };
  const notObserved = RULE({ id: "cache-hit", plain: observedPlain, magnitude: 3 });
  const unknown = RULE({
    id: "context-pressure", plain: observedPlain, magnitude: 3,
    evidence: { status: "unknown", reason: "no data", values: [], sources: [], derivation: null, parserVersion: "t" },
  });
  const mount = render(PAYLOAD({ sessions: [SESSION({ rules: [notObserved, unknown] })] }));
  assert.equal(withClass(mount, "verdict-plain").length, 0, "plain text is only for OBSERVED findings");
});

// ==========================================================================
// 2b. The COULD-NOT-BE-MEASURED path, in plain English (the product owner
//     read the engineering `reason` on the card face and could not parse it)
// ==========================================================================

// The exact string the analyzer emits for a Codex session on rule 6 — the one
// the product owner quoted back. It is the evidence of record and must survive
// into the DOM; it just no longer LEADS.
const ENGINEERING_REASON =
  "Nothing in Codex's rollout records establishes a sub-agent interval: there is no sidechain marker "
  + "and no parent/child session linkage to overlap (DIS-004).";

const UNKNOWN_RULE = (over = {}) => RULE({
  id: "subagent-concurrency",
  name: "High sub-agent concurrency",
  fix: "claude-worker-cap",
  magnitude: null,
  plain: {
    problem: "At its busiest moment this session had {pct} of what it dispatched running at once.",
    why: "Fanning work out can be deliberate.",
    unmeasured: {
      default: "Whether this session had several sub-agents running at the same moment could not be worked out from what was recorded.",
      "codex-records-no-subagents":
        "Codex's logs don't record which turns belonged to a sub-agent or which parent started them, so there is no way to tell whether two were running at the same time. Claude Code does record it, so this check produces a real result on a Claude session.",
    },
  },
  evidence: {
    status: "unknown",
    reason: ENGINEERING_REASON,
    reasonCode: "codex-records-no-subagents",
    values: [],
    sources: [],
    derivation: null,
    parserVersion: "t",
  },
  ...over,
});

test("an unmeasured check leads with the plain sentence for its OWN cause, not with the engineering prose", () => {
  const mount = render(PAYLOAD({ sessions: [SESSION({ rules: [UNKNOWN_RULE()] })] }));
  const plain = withClass(mount, "verdict-plain")[0];
  assert.ok(plain, "an unmeasured check must render a .verdict-plain lead sentence");
  assert.match(plain.textContent, /Codex's logs don't record which turns belonged to a sub-agent/);
  assert.match(plain.textContent, /Claude Code does record it/, "the sentence must say what WOULD make it measurable");

  // It leads: on the card face, not behind the disclosure.
  const row = withClass(mount, "verdict")[0];
  const details = withTag(row, "details")[0];
  assert.ok(details, "the evidence fold must still be there");
  assert.ok(!isInside(plain, details), "the plain sentence must be on the card face, not one click away");

  // And it is the sentence for THIS cause, not the catch-all.
  assert.ok(!mount.textContent.includes("could not be worked out from what was recorded"), "the default sentence was rendered over a cause that has its own");
});

test("the plain sentence never softens an unmeasured check into a pass", () => {
  const mount = render(PAYLOAD({ sessions: [SESSION({ rules: [UNKNOWN_RULE()] })] }));
  const reason = withClass(mount, "verdict-reason")[0];
  assert.ok(reason, "the honesty line must still render");
  assert.match(reason.textContent, /Not measured\. This is NOT a pass — the check could not run here\./);
  assert.match(mount.textContent, /COULD NOT BE MEASURED/, "the three states must stay named apart");

  const row = withClass(mount, "verdict")[0];
  assert.equal(row.dataset.status, "unknown");
  assert.ok(row.classList.contains("verdict-unknown"));
  // Nothing is offered to fix: there is no finding.
  assert.equal(withClass(row, "verdict-offer").length, 0);
  // The honesty line is NOT behind the fold either.
  assert.ok(!isInside(reason, withTag(row, "details")[0]), "the not-a-pass line must never be one click away");
});

test("the verbatim engineering reason is kept in full, inside the fold rather than on the card face", () => {
  const mount = render(PAYLOAD({ sessions: [SESSION({ rules: [UNKNOWN_RULE()] })] }));
  const row = withClass(mount, "verdict")[0];
  const details = withTag(row, "details")[0];

  assert.ok(details.textContent.includes(ENGINEERING_REASON), "the engineering reason must not be deleted — it is the evidence of record");
  const carrier = nodes(details).find((node) => node.tagName === "P" && node.textContent.includes(ENGINEERING_REASON));
  assert.ok(carrier, "it must be a paragraph inside the fold, not a stray text node");
  assert.ok(isInside(carrier, details));

  // It is no longer what a reader hits first.
  const reason = withClass(row, "verdict-reason")[0];
  assert.ok(!reason.textContent.includes("rollout records"), "the engineering prose must no longer lead the row");
  const plain = withClass(row, "verdict-plain")[0];
  assert.ok(!plain.textContent.includes("DIS-004"), "no internal id may reach the lead sentence");
  assert.ok(!plain.textContent.includes("sidechain"));
});

test("an unmeasured check whose cause has no sentence falls back to the default sentence", () => {
  const rule = UNKNOWN_RULE({
    evidence: {
      status: "unknown", reason: ENGINEERING_REASON, reasonCode: "a-cause-added-later",
      values: [], sources: [], derivation: null, parserVersion: "t",
    },
  });
  const mount = render(PAYLOAD({ sessions: [SESSION({ rules: [rule] })] }));
  const plain = withClass(mount, "verdict-plain")[0];
  assert.ok(plain, "an unrecognised cause must still read as English, not as nothing");
  assert.match(plain.textContent, /could not be worked out from what was recorded/);
  assert.match(mount.textContent, /This is NOT a pass/);
});

test("a rule with NO plain.unmeasured renders without throwing, and keeps the engineering reason on the face", () => {
  // Every fixture in tests/frontend-contract.test.js is this shape. Dropping
  // the reason for such a rule would leave an unknown with no stated cause at
  // all — a worse honesty failure than a jargon-heavy one — so it stays put.
  const rule = RULE({
    id: "context-pressure",
    evidence: { status: "unknown", reason: ENGINEERING_REASON, values: [], sources: [], derivation: null, parserVersion: "t" },
  });
  delete rule.plain;
  const mount = render(PAYLOAD({ sessions: [SESSION({ rules: [rule] })] }));

  assert.equal(withClass(mount, "verdict-plain").length, 0, "no catalogue means no plain paragraph, not an empty one");
  const reason = withClass(mount, "verdict-reason")[0];
  assert.match(reason.textContent, /This is NOT a pass — the check could not run here/);
  assert.ok(reason.textContent.includes(ENGINEERING_REASON), "with nothing to replace it, the reason must stay where a reader sees it");
});

test("an unmeasured check with a catalogue but no recorded reason still says it is not a pass", () => {
  const rule = UNKNOWN_RULE({
    evidence: { status: "unknown", reason: null, reasonCode: "codex-records-no-subagents", values: [], sources: [], derivation: null, parserVersion: "t" },
  });
  const mount = render(PAYLOAD({ sessions: [SESSION({ rules: [rule] })] }));
  assert.match(withClass(mount, "verdict-reason")[0].textContent, /This is NOT a pass/);
  assert.match(withClass(mount, "verdict-plain")[0].textContent, /Codex's logs don't record/);
  // The absence of a reason is itself reported, inside the fold.
  const details = withTag(withClass(mount, "verdict")[0], "details")[0];
  assert.match(details.textContent, /the analyzer recorded no reason, which is itself unmeasured/);
});

// ==========================================================================
// 3. What must not have broken
// ==========================================================================

test("all three verdict states remain visually distinguishable after the compact-cards rewrite", () => {
  const observed = RULE({ id: "repeat-tool", evidence: { status: "observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" } });
  const notObserved = RULE({ id: "cache-hit", evidence: { status: "not-observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" } });
  const unknown = RULE({ id: "context-pressure", evidence: { status: "unknown", reason: "could not be measured", values: [], sources: [], derivation: null, parserVersion: "t" } });

  const mount = render(PAYLOAD({ sessions: [SESSION({ rules: [observed, notObserved, unknown] })] }));
  const rows = withClass(mount, "verdict");
  assert.equal(rows.length, 3);

  const byStatus = new Map(rows.map((row) => [row.dataset.status, row]));
  assert.ok(byStatus.get("observed").classList.contains("verdict-warn"));
  assert.ok(byStatus.get("not-observed").classList.contains("verdict-pass"));
  assert.ok(byStatus.get("unknown").classList.contains("verdict-unknown"));
  // No two of them share a row class.
  const rowClasses = rows.map((row) => row.className);
  assert.equal(new Set(rowClasses).size, 3, `each verdict must carry its own row class: ${rowClasses.join(" | ")}`);

  assert.match(mount.textContent, /PROBLEM FOUND/);
  assert.match(mount.textContent, /PASSED/);
  assert.match(mount.textContent, /COULD NOT BE MEASURED/);
});

test("every rule still offers exactly [View suggestion] when observed, and nothing when it is not", () => {
  const buttonText = (root) => nodes(root).filter((n) => n.tagName === "BUTTON").map((n) => n.textContent.trim());

  const observed = RULE({
    id: "large-tool-result",
    evidence: { status: "observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
  });
  const mount = render(PAYLOAD({ sessions: [SESSION({ rules: [observed] })] }), { api: {} });
  const actionButtons = buttonText(mount).filter((t) => !["Review fixes"].includes(t));
  assert.deepEqual([...actionButtons].sort(), ["View suggestion"]);

  const passOnly = render(PAYLOAD({ sessions: [SESSION({ rules: [RULE({})] })] }));
  const passButtons = buttonText(passOnly).filter((t) => t !== "Review fixes");
  assert.deepEqual(passButtons, [], "an unmeasured/passing check must offer no suggestion action");
});

test("a finding whose CLI SessionRx does not suggest for says so, and offers a disabled action", () => {
  const observed = RULE({
    evidence: { status: "observed", reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
  });
  const claude = render(PAYLOAD({ sessions: [SESSION({ cli: "claude", rules: [observed] })] }), { api: {} });
  assert.equal(withClass(claude, "verdict-fix-scope").length, 0, "a supported CLI carries no scope caveat");

  const unsupported = RULE({
    suggestionAvailable: false, suggestionTool: null, suggestionToolName: null,
    evidence: observed.evidence,
  });
  const missingTarget = render(PAYLOAD({ sessions: [SESSION({ cli: "gemini", cliName: "Gemini CLI", rules: [unsupported] })] }), { api: {} });
  const note = withClass(missingTarget, "verdict-fix-scope")[0];
  assert.ok(note, "an unsupported CLI must say plainly that no suggestion exists for it");
  assert.match(note.textContent, /no suggested change for this CLI/i);
});

test("the scan-limit disclosure and the sub-agent set-aside note both survive in the rendered output", () => {
  const scanNote = "at least one CLI returned the full 250 newest sessions, so older sessions exist that were not read; pass a larger limit to widen the scan";
  const cliNote = "12 sub-agent sessions were set aside for claude and analyzed separately (F-023/F-025)";
  const data = PAYLOAD({
    sessions: [SESSION({})],
    collectors: [{ cli: "claude", sessions: 1, support: "supported", note: cliNote }],
    scan: { limitPerCollector: 250, defaulted: true, atLimit: true, note: scanNote },
  });
  const mount = render(data);

  assert.ok(mount.textContent.includes(scanNote), "the scan-limit disclosure text must not be dropped");
  assert.ok(mount.textContent.includes(cliNote), "the sub-agent set-aside caveat must not be dropped, folded or not");
});

// ==========================================================================
// 4. No engineering prose in a tooltip or a screen-reader label
//
// WHY THIS GUARD IS AT THE DOM LEVEL AND THE OTHERS ARE NOT: every existing
// jargon guard scans SOURCE string literals, and not one of them could catch
// the defect this test was written for. The leaking sentence lives in
// `src/analyzer/rules.js`, where it legitimately belongs as the evidence of
// record; it became user-facing only at the moment `health.js` assigned it to
// a `title`. A guard that cannot see the rendered result cannot see an
// assignment. So this one renders the page and walks the DOM it produced.
//
// The unmeasured rule results below come from the REAL analyzer
// (`evaluateRule` over the real `RULES`), not from prose written for the test:
// a fixture that invented its own tooltip text would prove nothing about the
// strings the product actually ships.
// ==========================================================================

const { RULES, evaluateRule } = await import("../src/analyzer/rules.js");

/** Patterns that must never reach a hover tooltip or a screen reader. */
const ENGINEERING_PROSE = [
  ["an internal DIS- id", /DIS-\d/i],
  ["an internal BP- id", /BP-\d/i],
  ["an internal F- id", /\bF-\d/i],
  ["the jargon word 'sidechain'", /\bsidechain/i],
  ["the jargon word 'linkage'", /\blinkage/i],
  ["the jargon word 'denominator'", /\bdenominator/i],
  ["the jargon word 'corpus'", /\bcorpus/i],
  ["the jargon word 'magnitude'", /\bmagnitude/i],
];

/**
 * Every (element, attribute, value) triple in the tree that carries hover text
 * or an accessible name. Walks ALL elements — a hand-picked selector list is
 * how the leaking span was missed in the first place.
 */
function hoverAndLabelText(root) {
  const out = [];
  for (const node of nodes(root)) {
    if (!(node?.attributes instanceof Map)) continue;
    for (const name of ["title", "aria-label"]) {
      const value = node.attributes.get(name);
      if (typeof value === "string" && value.length > 0) out.push({ node, name, value });
    }
  }
  return out;
}

/** A realistic Codex session: every rule result is the real analyzer's. */
const codexRuleResults = () =>
  RULES.map((rule) => evaluateRule(rule, { cli: "codex", sessionId: "codex-sess-1" }, {}));

/** The real set-aside caveat's shape (src/analyzer/health.js), as a CLI note. */
const SET_ASIDE_NOTE =
  "2 of the 3 sessions read for this CLI are sub-agent transcripts dispatched by another session, "
  + "so they are set aside from the 1 counted here and attached to the parent that launched them "
  + "instead: a sub-agent is evidence about that session, not a session of the user's own.";

const SCAN_NOTE =
  "at least one CLI returned the full 250 newest sessions, so older sessions exist that were not "
  + "read; pass a larger limit to widen the scan";

/** The page, with an unmeasured check, an absent everything, and an inference. */
function jargonPayload() {
  const observed = RULE({
    id: "large-tool-result",
    name: "Large tool results",
    fix: "claude-output-hygiene",
    magnitude: 0.42,
    plain: { problem: "This session sent back {pct} of its tool results oversized.", why: null, unmeasured: null },
    evidence: {
      status: "observed",
      reason: null,
      reasonCode: null,
      values: [{ label: "share of tool results over the cap", value: 0.42, unit: "fraction", windowSource: "observed-floor" }],
      sources: ["codex/codex-sess-1"],
      derivation: null,
      parserVersion: "t",
    },
  });

  return PAYLOAD({
    sessions: [
      // Nothing recorded: exercises every `notMeasured` absence path at once.
      SESSION({
        cli: "codex",
        sessionId: "codex-sess-1",
        project: null,
        model: null,
        window: { tokens: null, source: "unknown" },
        startedAt: null,
        endedAt: null,
        turnCount: null,
        subagentTurns: null,
        score: { total: 6, passed: 0, observed: 0, unknown: 6, label: "" },
        rules: codexRuleResults(),
      }),
      // An inferred window and an observed finding on a floor source: the
      // `.inferred` tag and the suppressed-percentage note both carry titles.
      SESSION({
        cli: "claude",
        sessionId: "claude-sess-2",
        window: { tokens: 180000, source: "observed-floor" },
        score: { total: 6, passed: 5, observed: 1, unknown: 0, label: "" },
        rules: [observed],
      }),
    ],
    sessionsTotal: 2,
    subagentSessionsSetAside: 2,
    collectors: [
      { cli: "codex", sessions: 1, support: "supported", note: SET_ASIDE_NOTE },
      { cli: "claude", sessions: 1, support: "supported", note: null },
      { cli: "antigravity", sessions: 0, support: "detection-only", note: null },
    ],
    scan: { limitPerCollector: 250, defaulted: true, atLimit: true, note: SCAN_NOTE },
  });
}

test("the real analyzer output this guard renders really does carry engineering prose", () => {
  // Without this, the guard below could pass on toothless data.
  const unknowns = codexRuleResults().filter((rule) => rule.evidence.status === "unknown");
  assert.ok(unknowns.length >= 1, "a Codex session with no children must leave at least one check unmeasured");
  const leaky = unknowns.filter((rule) => ENGINEERING_PROSE.some(([, re]) => re.test(rule.evidence.reason ?? "")));
  assert.ok(
    leaky.length >= 1,
    "at least one real unmeasured reason must contain engineering prose, or this guard is guarding nothing",
  );
  const subagent = unknowns.find((rule) => rule.id === "subagent-concurrency");
  assert.ok(subagent, "subagent-concurrency must be unmeasured for a Codex session");
  assert.match(subagent.evidence.reason, /DIS-\d/, "the sub-agent reason of record must still name its DIS id");
});

test("no title and no aria-label anywhere in the rendered health page carries engineering prose", () => {
  const mount = render(jargonPayload());
  const carriers = hoverAndLabelText(mount);

  // A walker that inspects nothing must not pass green. This payload renders 50
  // title/aria-label attributes today; the floor is set below that so ordinary
  // UI change does not trip it, but a walker that stops seeing the tree does.
  assert.ok(
    carriers.length >= 40,
    `the walk must actually reach the page's hover text: only ${carriers.length} title/aria-label attributes were inspected`,
  );

  const offences = [];
  for (const { node, name, value } of carriers) {
    for (const [what, re] of ENGINEERING_PROSE) {
      const hit = value.match(re);
      if (!hit) continue;
      offences.push(
        `<${node.tagName.toLowerCase()} class="${node.className}"> ${name}="..." contains ${what} `
        + `(matched ${JSON.stringify(hit[0])})\n      full text: ${JSON.stringify(value)}`,
      );
    }
  }
  assert.deepEqual(
    offences,
    [],
    `hover text and screen-reader labels must be plain English, but ${offences.length} `
    + `of ${carriers.length} inspected attributes leak internal language:\n    ${offences.join("\n    ")}`,
  );
});

test("moving the engineering reason out of the tooltip did not delete it: it is still inside a <details>", () => {
  const mount = render(jargonPayload());
  const subagent = codexRuleResults().find((rule) => rule.id === "subagent-concurrency");
  const reason = subagent.evidence.reason;

  assert.ok(mount.textContent.includes(reason), "the engineering reason of record must still be rendered somewhere");

  const folds = withTag(mount, "details");
  assert.ok(folds.length >= 1, "sanity: the verdict disclosure must render as a <details>");
  const insideAFold = folds.some((fold) => fold.textContent.includes(reason));
  assert.ok(
    insideAFold,
    "the engineering reason must live inside a collapsed <details>, not be dropped to satisfy the tooltip guard",
  );

  // And the plain sentence it stood aside for must be on the card face.
  const plain = healthPage.plainUnmeasuredSentence(subagent);
  assert.ok(plain, "the rule must carry a plain sentence for this cause");
  assert.ok(
    withClass(mount, "verdict-plain").some((node) => node.textContent.includes(plain)),
    "the plain sentence must lead the verdict row",
  );
});

test("the sub-agent turn tooltip is the plain sentence for the cause, never the reason of record", () => {
  const subagent = codexRuleResults().find((rule) => rule.id === "subagent-concurrency");
  const mount = render(jargonPayload());

  const dashes = withClass(mount, "not-measured");
  const subagentDash = dashes.find((node) => (node.getAttribute("title") ?? "").includes("sub-agent"));
  assert.ok(subagentDash, "the sub-agent turns cell must render an honest absence");
  assert.equal(
    subagentDash.getAttribute("title"),
    healthPage.plainUnmeasuredSentence(subagent),
    "the tooltip must be the plain sentence looked up from the rule's own cause",
  );
  assert.equal(
    subagentDash.getAttribute("aria-label"),
    `not measured: ${healthPage.plainUnmeasuredSentence(subagent)}`,
    "the screen-reader label must carry the same plain sentence",
  );
  assert.notEqual(subagentDash.getAttribute("title"), subagent.evidence.reason);
});
