/**
 * tests/ui-fixes.test.js — every control on the Fixes page does what it says.
 *
 * Three things this file holds the page to:
 *  1. The issue-category list is navigation, not labels: a click narrows the
 *     issue list, the count beside each category is the number of issues it
 *     then holds, and Previous/Next stay inside the chosen category.
 *  2. There is ONE page-level action, "Review fix", and it opens the fix
 *     window for the selected fix. Three buttons (Preview, Apply, Undo) that
 *     all opened the same window promised three different actions.
 *  3. A fix is labelled "Fix available for your CLI" only when it changes the
 *     settings of the CLI the finding came from; otherwise "Recommendation only".
 *
 * Harness: the same minimal DOM shim as tests/ui-sessions.test.js (copied, as
 * each ui-*.test.js keeps its own), no browser, no new dependency.
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
// Fixtures
// ==========================================================================

globalThis.location = { hash: "#/fixes" };

// `fixCli` is what the server stamps on each rule; the catalogue also carries
// the target CLI for recommendations without an observed finding.
const observed = (id, name, fix) => ({ id, name, severity: "warn", fix, fixCli: "claude", fixCliName: "Claude Code", evidence: { status: "observed", values: [] } });

const HEALTH = {
  sessions: [
    { cli: "claude", cliName: "Claude Code", sessionId: "a", startedAt: "2026-09-20T10:00:00.000Z",
      rules: [observed("context-pressure", "Context pressure", "claude-auto-compact")] },
    { cli: "codex", cliName: "Codex", sessionId: "b", startedAt: "2026-09-21T10:00:00.000Z",
      rules: [observed("context-pressure", "Context pressure", "claude-auto-compact")] },
    { cli: "claude", cliName: "Claude Code", sessionId: "c", startedAt: "2026-09-21T11:00:00.000Z",
      rules: [observed("tool-repeat", "Repeated tool calls", "claude-tool-guidance")] },
  ],
};

const FIXES = {
  fixes: [
    { id: "claude-auto-compact", title: "Compact earlier", cli: "claude" },
    { id: "claude-tool-guidance", title: "Batch tool calls", cli: "claude" },
    { id: "claude-worker-cap", title: "Cap workers", cli: "claude" },
  ],
};

function makeApi() {
  const posts = [];
  return {
    posts,
    async get(path) {
      if (path.startsWith("/api/fixes")) return FIXES;
      return HEALTH;
    },
    async post(path) {
      posts.push(path);
      if (path.endsWith("/preview")) return { diff: "+ added line", targets: [{ display: "~/.claude/settings.json" }] };
      if (path.endsWith("/check")) return { applied: false };
      return {};
    },
  };
}

const fixesPage = await import("../public/js/pages/fixes.js");

async function paint(hash, api = makeApi(), payload = { health: HEALTH, fixes: FIXES }) {
  globalThis.location.hash = hash;
  const mount = new ShimElement("section");
  await fixesPage.default(mount, payload, { api });
  return { mount, api };
}

const buttonsIn = (root) => withTag(root, "button");
const category = (mount, name) => buttonsIn(mount).find((node) => node.dataset.category === name);
const issueTitle = (mount) => withClass(mount, "issue-title")[0]?.textContent ?? null;

// ==========================================================================
// Tests
// ==========================================================================

test("issue categories are buttons that navigate, and their counts match what they show", async () => {
  const { mount } = await paint("#/fixes");
  const tool = category(mount, "Tool usage");
  assert.ok(tool, "each category is a real button");
  assert.match(tool.textContent, /\(1\)/);
  assert.equal(category(mount, "All issues").getAttribute("aria-pressed"), "true");

  fire(tool);
  assert.equal(globalThis.location.hash, "#/fixes?cat=Tool+usage&issue=0");

  const narrowed = await paint(globalThis.location.hash);
  assert.equal(issueTitle(narrowed.mount), "Repeated tool calls");
  assert.match(narrowed.mount.textContent, /Issue 1 of 1/, "the count beside the category is the number of issues it holds");
  assert.equal(category(narrowed.mount, "Tool usage").getAttribute("aria-pressed"), "true");
});

test("Previous and Next stay inside the chosen category", async () => {
  const { mount } = await paint("#/fixes?cat=Context+%26+memory&issue=0");
  assert.match(mount.textContent, /Issue 1 of 2/);
  fire(buttonsIn(mount).find((node) => node.textContent === "Next ›"));
  assert.equal(globalThis.location.hash, "#/fixes?cat=Context+%26+memory&issue=1");
});

test("one Review fix button replaces the three buttons that all did the same thing", async () => {
  const { mount, api } = await paint("#/fixes");
  const labels = buttonsIn(mount).map((node) => node.textContent);
  assert.ok(!labels.includes("Preview") && !labels.includes("Apply fix") && !labels.includes("Undo"),
    "no page-level button may promise an action it does not start");
  const review = buttonsIn(mount).find((node) => node.dataset.action === "review-fix");
  assert.equal(review.textContent, "Review fix");

  const before = document.body.childNodes.length;
  fire(review);
  await settle();
  assert.equal(document.body.childNodes.length, before + 1, "the click opens the fix window");
  assert.match(document.body.textContent, /claude-auto-compact/, "for the selected fix");
  assert.ok(api.posts.some((path) => path.includes("claude-auto-compact")), "and the window asks the server about that fix");
  document.body.replaceChildren();
});

test("the fix is labelled by whether it changes the finding's own CLI", async () => {
  const own = await paint("#/fixes?issue=0");
  assert.match(own.mount.textContent, /Fix available for your CLI/);

  assert.doesNotMatch(own.mount.textContent, /no automated fix exists/);

  const other = await paint("#/fixes?issue=1");
  assert.match(other.mount.textContent, /Recommendation only/);
  assert.match(other.mount.textContent, /came from Codex; no automated fix exists for it/);
  assert.doesNotMatch(other.mount.textContent, /Fix available for your CLI/);
});

test("a Cursor-only unknown scan proposes no fix and no Claude recommendation", async () => {
  const cursorHealth = {
    clis: [{ cli: "cursor", installed: true, support: "supported", sessions: null }],
    sessions: [{ cli: "cursor", rules: [
      { id: "context-pressure", name: "Context pressure", fix: "claude-auto-compact", evidence: { status: "unknown" } },
    ] }],
  };
  const cursorFixes = { fixes: [{ id: "claude-auto-compact", title: "Compact earlier", cli: "claude" }] };
  const api = makeApi();
  const { mount, api: usedApi } = await paint("#/fixes", api, { health: cursorHealth, fixes: cursorFixes });
  assert.match(mount.textContent, /No observed fixable issue/);
  const recommendations = withClass(mount, "rx-grid").at(-1);
  assert.doesNotMatch(recommendations.textContent, /Compact earlier/);
  assert.equal(usedApi.posts.some((path) => path.endsWith("/preview")), false, "no preview is posted without an observed finding");
});

test("the real collectors inventory prevents Claude fixes from being recommended for Cursor-only health", async () => {
  const cursorHealth = {
    collectors: [
      { cli: "cursor", installed: true, support: "supported" },
      { cli: "claude", installed: false, support: "supported" },
    ],
    sessions: [{ cli: "cursor", rules: [
      { id: "context-pressure", name: "Context pressure", fix: "claude-auto-compact", evidence: { status: "observed" } },
    ] }],
  };
  const cursorFixes = { fixes: [
    { id: "claude-auto-compact", title: "Compact earlier", cli: "claude" },
    { id: "claude-worker-cap", title: "Cap workers", cli: "claude" },
  ] };
  const { mount } = await paint("#/fixes", makeApi(), { health: cursorHealth, fixes: cursorFixes });
  const recommendations = withClass(mount, "rx-grid").at(-1);
  assert.doesNotMatch(recommendations.textContent, /Compact earlier|Cap workers/);
});

test("missing CLI inventory fails closed and explains that recommendations were not measured", async () => {
  const healthWithoutInventory = {
    sessions: [{ cli: "cursor", rules: [
      { id: "context-pressure", name: "Context pressure", fix: "claude-auto-compact", evidence: { status: "observed" } },
    ] }],
  };
  const { mount } = await paint("#/fixes", makeApi(), { health: healthWithoutInventory, fixes: FIXES });
  assert.match(mount.textContent, /Installed CLI inventory was not measured/);
  const recommendations = withClass(mount, "rx-grid").at(-1);
  assert.equal(recommendations.textContent, "");
});

test("an address with a query still opens the Fixes page, not Health", async () => {
  const { routeFromHash } = await import("../public/js/app.js");
  for (const hash of ["#/fixes", "#/fixes?issue=1", "#/fixes?cat=Tool+usage&issue=0"]) {
    globalThis.location.hash = hash;
    assert.equal(routeFromHash(), "fixes", hash);
  }
  globalThis.location.hash = "#/nowhere";
  assert.equal(routeFromHash(), "health", "an unknown page still falls back to Health");
});
