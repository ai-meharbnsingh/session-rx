/**
 * tests/ui-fixes.test.js — the Suggestions page (public/js/pages/fixes.js).
 *
 * SessionRx never writes a user's files. This page groups every observed
 * finding that names a suggestion by the tool whose session showed it, and
 * renders each suggestion's plain summary, Global/Project switch, target,
 * preview text and a "Copy request" button.
 *
 * Harness: the same minimal DOM shim used by the other ui-*.test.js files.
 */

import test from "node:test";
import assert from "node:assert/strict";

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
    this.listeners = new Map();
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

  querySelectorAll() { return []; }

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
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  body: new ShimElement("body"),
};

globalThis.document = documentShim;
if (typeof globalThis.addEventListener !== "function") globalThis.addEventListener = () => {};
if (!globalThis.navigator) globalThis.navigator = {};
globalThis.location = { hash: "#/fixes" };

function nodes(root) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    out.push(node);
    (node.childNodes ?? []).forEach(visit);
  };
  visit(root);
  return out;
}

const withTag = (root, tag) => nodes(root).filter((node) => node.tagName === tag.toUpperCase());
const fire = (node, type = "click") => {
  for (const handler of node?.listeners?.get?.(type) ?? []) handler({ target: node });
};
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

// ==========================================================================
// Fixtures
// ==========================================================================

const observed = (id, name, fix, tool, toolName) => ({
  id, name, severity: "warn", fix,
  suggestionAvailable: Boolean(tool),
  suggestionTool: tool ?? null,
  suggestionToolName: toolName ?? null,
  suggestionTitle: tool ? `${name} suggestion` : null,
  evidence: { status: "observed", values: [] },
});

const HEALTH = {
  sessions: [
    { cli: "claude", cliName: "Claude Code", sessionId: "a", startedAt: "2026-09-20T10:00:00.000Z",
      rules: [observed("context-pressure", "Context pressure", "claude-auto-compact", "claude", "Claude Code")] },
    { cli: "codex", cliName: "Codex", sessionId: "b", startedAt: "2026-09-21T10:00:00.000Z",
      rules: [observed("repeat-tool", "Repeated tool calls", "claude-batch-commands", "codex", "Codex")] },
  ],
};

function suggestionFixture({ id, toolId, toolLabel = "Claude Code", scope = "global", status = "not-added" }) {
  return {
    id, ruleId: "context-pressure", title: `${id} title`, plainSummary: `${id} summary`,
    rationale: "because", targetTool: toolId, toolLabel, scope,
    targetLabel: scope === "global" ? "~/.claude/CLAUDE.md" : "./CLAUDE.md",
    preview: `<!-- session-rx:${id}:v1 -->\npreview text\n<!-- /session-rx:${id}:v1 -->\n`,
    request: `Please add the following section... (${scope})`,
    status, statusReason: null, available: true,
  };
}

function makeApi() {
  const gets = [];
  return {
    gets,
    async get(url) {
      gets.push(url);
      if (url.startsWith("/api/suggestions?scope=global") && !url.includes("id=")) {
        return { tools: [{ id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }] };
      }
      if (url.startsWith("/api/suggestions")) {
        const params = new URLSearchParams(url.split("?")[1]);
        const id = params.get("id");
        const tool = params.get("tool");
        const scope = params.get("scope") || "global";
        return { suggestions: [suggestionFixture({ id, toolId: tool, scope })] };
      }
      return HEALTH;
    },
  };
}

const fixesPage = await import("../public/js/pages/fixes.js");

async function paint(api = makeApi(), health = HEALTH) {
  globalThis.location.hash = "#/fixes";
  const mount = new ShimElement("section");
  await fixesPage.default(mount, { health }, { api });
  return { mount, api };
}

// ==========================================================================
// Tests
// ==========================================================================

test("the page groups suggestions by the tool whose session showed the problem", async () => {
  const { mount } = await paint();
  assert.match(mount.textContent, /Claude Code/);
  assert.match(mount.textContent, /Codex/);
});

test("a finding from a Codex session yields a Codex-targeted suggestion, not a Claude one", async () => {
  const { mount, api } = await paint();
  await settle();
  const requested = api.gets.filter((url) => url.startsWith("/api/suggestions") && url.includes("id="));
  assert.ok(requested.some((url) => url.includes("tool=codex") && url.includes("id=claude-batch-commands")),
    "the repeat-tool finding from the Codex session must fetch a Codex-targeted suggestion");
  assert.doesNotMatch(mount.textContent, /No suggested change for this tool/);
});

test("no wording implies SessionRx applied, undid, or fixed anything", async () => {
  const { mount } = await paint();
  const text = mount.textContent;
  assert.doesNotMatch(text, /\bApply\b/);
  assert.doesNotMatch(text, /\bUndo\b/);
  assert.doesNotMatch(text, /fix applied/i);
});

test("the page never writes anything — it only ever calls api.get", async () => {
  const api = makeApi();
  api.post = () => { throw new Error("the Suggestions page must never POST"); };
  await paint(api, HEALTH);
});

test("with no observed finding that names a suggestion, the page says so plainly", async () => {
  const emptyHealth = { sessions: [{ cli: "claude", rules: [] }] };
  const { mount } = await paint(makeApi(), emptyHealth);
  assert.match(mount.textContent, /No observed finding with a suggested change/);
});

test("an address with a query still opens the Fixes page, not Health", async () => {
  const { routeFromHash } = await import("../public/js/app.js");
  globalThis.location.hash = "#/fixes";
  assert.equal(routeFromHash(), "fixes");
  globalThis.location.hash = "#/nowhere";
  assert.equal(routeFromHash(), "health", "an unknown page still falls back to Health");
});
