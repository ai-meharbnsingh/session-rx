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
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});
const { openSuggestionPanel } = await import("../public/js/components/suggestion-panel.js");

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

const withClass = (root, name) => nodes(root).filter((node) => node.classList?.contains?.(name));
const withTag = (root, tag) => nodes(root).filter((node) => node.tagName === tag.toUpperCase());
const fire = (node, type = "click") => {
  for (const handler of node?.listeners?.get?.(type) ?? []) handler({ target: node });
};
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

const fixture = (overrides = {}) => ({
  id: "claude-auto-compact",
  toolId: "claude",
  targetLabel: "~/.claude/settings.json",
  plainSummary: "Keep context compact automatically.",
  preview: '"autoCompact": true\n',
  request: "Please add auto-compaction.",
  rationale: "Long sessions benefit from automatic compaction.",
  status: "not-added",
  statusReason: null,
  available: true,
  ...overrides,
});

const render = async (suggestion) => {
  const mount = new ShimElement("div");
  openSuggestionPanel({
    id: suggestion.id,
    toolId: suggestion.toolId,
    scope: "global",
    title: "Suggested change",
    api: { get: async () => ({ suggestions: [suggestion] }) },
    mount,
  });
  await settle();
  return mount;
};

const calloutTitle = (box) => withClass(box, "callout-title")[0]?.textContent;

test("already-added renders an ok callout with the target label", async () => {
  const mount = await render(fixture({ status: "already-added", targetLabel: "~/.claude/CLAUDE.md" }));
  const callout = withClass(mount, "callout-ok")[0];
  assert.ok(callout);
  assert.equal(calloutTitle(callout), "Already added");
  assert.match(callout.textContent, /~\/\.claude\/CLAUDE\.md/);
});

test("not-added without a reason renders only the base message", async () => {
  const mount = await render(fixture({ status: "not-added", statusReason: null }));
  const callout = withClass(mount, "callout-info").find((node) => calloutTitle(node) === "Not added yet");
  assert.equal(callout.textContent, "Not added yetSessionRx did not find this section in the target file.");
});

test("not-added with a reason uses the exact reason separator", async () => {
  const reason = "Not found in settings.json or shell rc files. If you set --autocompact via a CLI flag or alias, this check can't see it — only settings.json and shell rc files are read.";
  const mount = await render(fixture({ status: "not-added", statusReason: reason }));
  const callout = withClass(mount, "callout-info").find((node) => calloutTitle(node) === "Not added yet");
  assert.equal(callout.textContent, `Not added yetSessionRx did not find this section in the target file. ${reason}`);
});

test("possibly-already-satisfied supports evidence, apply, and dismiss actions", async () => {
  const calls = [];
  globalThis.navigator.clipboard.writeText = async (text) => { calls.push(text); };
  const mount = await render(fixture({
    status: "possibly-already-satisfied",
    evidenceLine: 42,
    evidenceSnippet: "some snippet",
    evidenceSourceLabel: "~/.claude/CLAUDE.md",
    request: "REQUEST TEXT",
  }));
  const callout = withClass(mount, "callout-maybe")[0];
  assert.ok(callout);
  assert.match(callout.textContent, /42/);
  assert.match(callout.textContent, /some snippet/);
  assert.match(callout.textContent, /~\/\.claude\/CLAUDE\.md/);

  const details = withTag(callout, "details")[0];
  assert.ok(details);
  assert.equal(details.open, undefined);
  const show = withTag(callout, "button").find((button) => button.textContent === "Show me");
  fire(show);
  assert.equal(details.open, true);
  fire(show);
  assert.equal(details.open, false);

  const apply = withTag(callout, "button").find((button) => button.textContent === "Apply anyway");
  fire(apply);
  await settle();
  assert.deepEqual(calls, ["REQUEST TEXT"]);
  assert.equal(withClass(callout, "copy-status")[0].textContent, "Copied.");

  const dismiss = withTag(callout, "button").find((button) => button.textContent === "Dismiss");
  fire(dismiss);
  assert.equal(callout.textContent, "Dismissed — treating as not confirmed either way.");
});

test("possibly-already-satisfied reports clipboard failure", async () => {
  globalThis.navigator.clipboard.writeText = async () => { throw new Error("clipboard unavailable"); };
  const mount = await render(fixture({ status: "possibly-already-satisfied", request: "REQUEST TEXT" }));
  const callout = withClass(mount, "callout-maybe")[0];
  const apply = withTag(callout, "button").find((button) => button.textContent === "Apply anyway");
  fire(apply);
  await settle();
  assert.equal(withClass(callout, "copy-status")[0].textContent, "Could not copy automatically — select the text below and copy it yourself.");
});

test("unknown status explains each reason without calling it not added", async () => {
  const cases = [
    ["project-path-not-resolvable", "SessionRx cannot resolve a project path from here"],
    ["no-local-file", "This target is not a local file SessionRx can read."],
    ["something-else", "SessionRx could not determine whether this is already added."],
  ];
  for (const [statusReason, beginning] of cases) {
    const mount = await render(fixture({ status: "unknown", statusReason }));
    const callout = withClass(mount, "callout-unknown")[0];
    assert.match(callout.textContent, new RegExp(`^Could not be checked${beginning}`));
    assert.match(callout.textContent, /That is not the same as "not added" — it is not a pass either way\./);
  }
});

test("unavailable suggestions render the supplied remedy message", async () => {
  const mount = await render(fixture({ available: false, message: "No known remedy." }));
  const callout = withClass(mount, "callout-info")[0];
  assert.equal(calloutTitle(callout), "No suggested change for this tool");
  assert.equal(callout.textContent, "No suggested change for this toolNo known remedy.");
});
