/**
 * tests/ui-undo-reachability.test.js — an applied fix must stay reachable.
 *
 * THE REGRESSION THIS PINS: both surfaces that open the fix window were gated
 * on an *observed* finding, so applying a fix deleted its own entry point. The
 * window itself was always right — it reveals Undo whenever `check` reports the
 * fix applied — but nothing on either page opened it once the finding it came
 * from stopped being observed.
 *
 * THE HONESTY CONTRACT, applied to applied-state: `check` answers with exactly
 * one of applied | not-applied | unknown. A request that fails answers
 * `unknown`, never "not applied", and an `unknown` is shown with its reason
 * rather than dropped. There is no fourth state.
 *
 * Harness: the same minimal DOM shim as tests/ui-fixes.test.js (copied, as each
 * ui-*.test.js keeps its own), no browser, no new dependency, no read of the
 * developer's own ~/.claude or ~/.session-rx — every byte here is a fixture.
 */

import test from "node:test";
import assert from "node:assert/strict";

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

/**
 * Depth-first walk of a shim tree IN DOCUMENT ORDER, registering every `id` it
 * carries so `getElementById` can find it.
 *
 * ui-health.test.js walks with a stack, which visits siblings back to front.
 * That is harmless there and wrong here: half of what this file asserts is that
 * page 2 was appended BELOW page 1, so the order rows come back in has to be
 * the order they appear in.
 */
function nodes(root) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    out.push(node);
    if (typeof node.id === "string" && node.id) registry.set(node.id, node);
    (node.childNodes ?? []).forEach(visit);
  };
  visit(root);
  return out;
}

const withClass = (root, name) => nodes(root).filter((node) => node.classList?.contains?.(name));
const withTag = (root, tag) => nodes(root).filter((node) => node.tagName === tag.toUpperCase());

/** Fire every handler registered for `type` on `node`, the way a click would. */
const fire = (node, type = "click") => {
  for (const handler of node?.listeners?.get?.(type) ?? []) handler({ target: node });
};

/** Let pending microtasks and `await`ed promises drain before asserting. */
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

// ==========================================================================
// Fixtures — every one of them invented here; no real machine is read.
// ==========================================================================

globalThis.location = { hash: "#/fixes" };

/** One rule, in whichever verdict state the test needs. */
const rule = (id, name, fix, status) => ({
  id, name, severity: "warn", fix, fixCli: "claude", fixCliName: "Claude Code",
  threshold: { value: 1, derivation: null },
  evidence: { status, reason: null, values: [], sources: [], derivation: null, parserVersion: "t" },
});

/** The state AFTER the user applied the fix: the finding is no longer observed. */
const healthWith = (...rules) => ({
  sessions: [{
    cli: "claude", cliName: "Claude Code", sessionId: "s1", project: "session-rx",
    startedAt: "2026-09-20T10:00:00.000Z", endedAt: "2026-09-20T11:00:00.000Z",
    turnCount: 4, subagentTurns: null,
    window: { tokens: 200000, source: "model-table" },
    score: { total: rules.length, passed: rules.length, observed: 0, unknown: 0, label: "" },
    rules,
  }],
  sessionsTotal: 1,
  collectors: [],
  promotions: [],
  diagnostics: [],
  scan: { limitPerCollector: 250, defaulted: true, atLimit: false, note: null },
  generatedAt: "2026-09-21T00:00:00.000Z",
});

const catalogRow = (id, title) => ({ id, title, kind: "settings", available: true, applyable: true });

const APPLIED = { applied: true, status: "applied", reason: "marker-present", marker: "# session-rx" };
const NOT_APPLIED = { applied: false, status: "not-applied", reason: "marker-absent" };
const UNKNOWN = {
  applied: false, status: "unknown", reason: "target-missing",
  message: "the settings file for this fix does not exist",
};

/**
 * @param {object} checks fix id -> the `check` answer, or a function that
 *   throws, standing in for a request that fails.
 */
function makeApi(catalog, checks = {}) {
  const asked = [];
  return {
    asked,
    async get(path) {
      asked.push(path);
      const match = /^\/api\/fixes\/([^/]+)\/check$/.exec(path);
      if (match) {
        const answer = checks[decodeURIComponent(match[1])];
        if (typeof answer === "function") return answer();
        return answer === undefined ? NOT_APPLIED : answer;
      }
      if (path.startsWith("/api/fixes")) return { fixes: catalog };
      return healthWith();
    },
    async post(path) {
      if (path.endsWith("/preview")) return { diff: "+ one line", targets: [{ display: "~/.claude/settings.json" }] };
      return {};
    },
  };
}

const fixesPage = await import("../public/js/pages/fixes.js");
const healthPage = await import("../public/js/pages/health.js");

async function paintFixes({ health = healthWith(), catalog = [], checks = {} } = {}) {
  globalThis.location.hash = "#/fixes";
  const api = makeApi(catalog, checks);
  const mount = new ShimElement("section");
  await fixesPage.default(mount, { health, fixes: { fixes: catalog } }, { api });
  await settle();
  return { mount, api };
}

async function paintHealth({ health = healthWith(), catalog = [], checks = {} } = {}) {
  const api = makeApi(catalog, checks);
  const mount = new ShimElement("section");
  healthPage.renderHealth(mount, health, { api });
  await settle();
  return { mount, api };
}

const buttonsIn = (root) => withTag(root, "BUTTON");
const appliedGroup = (mount) => withClass(mount, "applied-fixes")[0] ?? null;
const uncheckedGroup = (mount) => withClass(mount, "unchecked-fixes")[0] ?? null;

// ==========================================================================
// 1. applied -> its own group, and the button says Undo
// ==========================================================================

test("a fix whose check reports applied is grouped as applied, under a button that says Undo", async () => {
  const { mount } = await paintFixes({
    catalog: [catalogRow("claude-auto-compact", "Compact earlier")],
    checks: { "claude-auto-compact": APPLIED },
  });

  const group = appliedGroup(mount);
  assert.ok(group, "an applied fix must have a group of its own, not be left among recommendations");
  assert.match(group.textContent, /Applied fixes/);
  assert.match(group.textContent, /Compact earlier/);

  const undo = buttonsIn(group).find((node) => node.dataset.fixId === "claude-auto-compact");
  assert.ok(undo, "the applied fix must carry its own action");
  assert.equal(undo.textContent, "Undo", "the button must name what it does, not 'Review fix'");
});

// ==========================================================================
// 2. the applied group is NOT capped
// ==========================================================================

test("every applied fix is reachable — the applied group is not capped at six", async () => {
  const ids = Array.from({ length: 8 }, (unused, index) => `fix-${index + 1}`);
  const { mount } = await paintFixes({
    catalog: ids.map((id) => catalogRow(id, `Fix number ${id}`)),
    checks: Object.fromEntries(ids.map((id) => [id, APPLIED])),
  });

  const group = appliedGroup(mount);
  assert.ok(group, "eight applied fixes must render a group");
  const undoButtons = buttonsIn(group).filter((node) => node.textContent === "Undo");
  assert.equal(undoButtons.length, 8, "a user must be able to undo every fix applied, not the first six");
  for (const id of ids) {
    assert.ok(undoButtons.some((node) => node.dataset.fixId === id), `${id} has no way back`);
  }
});

// ==========================================================================
// 3. unknown is a state of its own, shown with its reason
// ==========================================================================

test("a fix whose check answers unknown is shown as unknown, with the reason, not as a pass", async () => {
  const { mount } = await paintFixes({
    catalog: [catalogRow("claude-auto-compact", "Compact earlier")],
    checks: { "claude-auto-compact": UNKNOWN },
  });

  assert.equal(appliedGroup(mount), null, "an unknown is not an applied fix");
  const group = uncheckedGroup(mount);
  assert.ok(group, "an unknown applied-state needs its own group — it is neither applied nor not applied");
  assert.match(group.textContent, /Compact earlier/);
  assert.match(group.textContent, /the settings file for this fix does not exist/, "the reason must be on screen");
  assert.match(group.textContent, /target-missing/, "the machine-readable reason must be on screen too");
  assert.match(group.textContent, /not a pass/i, "an unknown must never read as all clear");
});

// ==========================================================================
// 4. a failed request is unknown, never "not applied"
// ==========================================================================

test("a check request that fails is unknown, not 'not applied'", async () => {
  const { mount } = await paintFixes({
    catalog: [catalogRow("claude-auto-compact", "Compact earlier")],
    checks: {
      "claude-auto-compact": () => { throw new Error("Request failed (503)"); },
    },
  });

  assert.equal(appliedGroup(mount), null);
  const group = uncheckedGroup(mount);
  assert.ok(group, "a request that did not answer leaves the state unknown, and that must be said");
  assert.match(group.textContent, /Compact earlier/);
  assert.match(group.textContent, /Request failed \(503\)/, "the failure itself is the reason");
});

// ==========================================================================
// 5. THE REGRESSION: applied, but the rule is no longer observed
// ==========================================================================

test("an applied fix stays reachable after its finding stops being observed", async () => {
  // Nothing is observed any more — precisely because the fix was applied.
  const health = healthWith(rule("context-pressure", "Context pressure", "claude-auto-compact", "not-observed"));
  // The applied fix is deliberately NOT the catalogue's first row, so the
  // page's own "Review fix" button points at something else.
  const { mount, api } = await paintFixes({
    health,
    catalog: [catalogRow("claude-tool-guidance", "Batch tool calls"), catalogRow("claude-auto-compact", "Compact earlier")],
    checks: { "claude-auto-compact": APPLIED, "claude-tool-guidance": NOT_APPLIED },
  });

  assert.ok(
    api.asked.some((path) => path === "/api/fixes/claude-auto-compact/check"),
    "the page must ask whether each fix is applied; it cannot know from the health verdicts alone",
  );
  const undo = buttonsIn(mount).find((node) => node.textContent === "Undo" && node.dataset.fixId === "claude-auto-compact");
  assert.ok(undo, "applying a fix must not delete the only way back to it");

  const before = document.body.childNodes.length;
  fire(undo);
  await settle();
  assert.equal(document.body.childNodes.length, before + 1, "the click opens the fix window");
  assert.match(document.body.textContent, /claude-auto-compact/, "and it opens on the fix that was applied");
  document.body.replaceChildren();
});

// ==========================================================================
// 6. the same on the Health page
// ==========================================================================

test("the health page lists a fix applied there, even though its rule now passes", async () => {
  const health = healthWith(rule("context-pressure", "Context pressure", "claude-auto-compact", "not-observed"));
  const { mount } = await paintHealth({
    health,
    catalog: [catalogRow("claude-auto-compact", "Compact earlier")],
    checks: { "claude-auto-compact": APPLIED },
  });

  const group = appliedGroup(mount);
  assert.ok(group, "the health page must list what is already applied, or applying a fix hides it for good");
  assert.match(group.textContent, /Compact earlier/);
  const undo = buttonsIn(group).find((node) => node.dataset.fixId === "claude-auto-compact");
  assert.ok(undo, "the applied fix needs its action on this page too");
  assert.equal(undo.textContent, "Undo");
});

// ============================================================================
// 6. applied-state discovery is independent of recommendation inventory
// ============================================================================

test("an applied fix is still rendered with Undo when CLI inventory is absent, without recommendation duplication", async () => {
  const health = healthWith();
  delete health.collectors;
  const { mount } = await paintFixes({
    health,
    catalog: [catalogRow("claude-auto-compact", "Compact earlier")],
    checks: { "claude-auto-compact": APPLIED },
  });

  const group = appliedGroup(mount);
  assert.ok(group, "applied-state discovery must use the full catalog when inventory is absent");
  assert.ok(buttonsIn(group).some((node) => node.textContent === "Undo" && node.dataset.fixId === "claude-auto-compact"));
  const recommendations = withClass(mount, "rx-grid").at(-1);
  assert.equal(recommendations.textContent, "", "fail-closed recommendations must stay empty without CLI inventory");
});

test("the health page shows an unknown applied-state with its reason, and never as applied", async () => {
  const { mount } = await paintHealth({
    catalog: [catalogRow("claude-auto-compact", "Compact earlier")],
    checks: { "claude-auto-compact": UNKNOWN },
  });

  assert.equal(appliedGroup(mount), null, "an unknown must not be counted as applied");
  const group = uncheckedGroup(mount);
  assert.ok(group, "the third state must be rendered, not dropped");
  assert.match(group.textContent, /the settings file for this fix does not exist/);
  assert.match(group.textContent, /not a pass/i);
});

test("with no API client the health page claims nothing about applied fixes", async () => {
  const mount = new ShimElement("section");
  healthPage.renderHealth(mount, healthWith(rule("context-pressure", "Context pressure", "claude-auto-compact", "not-observed")), { api: {} });
  await settle();
  assert.equal(appliedGroup(mount)?.textContent ?? "", "", "no client, no reading — and so no claim either way");
  assert.equal(uncheckedGroup(mount)?.textContent ?? "", "");
});
