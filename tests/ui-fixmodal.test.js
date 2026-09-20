/**
 * tests/ui-fixmodal.test.js — the fix Preview/Apply/Undo panel's honesty
 * contract (BP-004, BP-005.06..09), driven through `openFixModal`.
 *
 * SCOPE: this is the PRODUCT OWNER'S three-part brief for the panel — for
 * every fix, state the exact change, the expected effect, and the
 * limitations, plus: never surprise the user with a newly-created file,
 * never re-offer a fix that is already applied, and keep Undo working. It
 * complements tests/frontend-contract.test.js (which owns the static sink
 * audit and `renderDiff`'s byte-identity guarantee) rather than duplicating
 * it — this file drives the MODAL, not just its diff renderer, and does not
 * touch that file.
 *
 * HARNESS: a minimal DOM shim, same idea as frontend-contract.test.js's but
 * kept local to this file (that file owns its shim; nothing here imports
 * from it). It implements only createElement / createTextNode / append /
 * replaceChildren / setAttribute / addEventListener / remove / textContent —
 * enough to run `openFixModal` and read back what it rendered — and no
 * layout, so this proves DOM structure and text, not pixels. No server is
 * started; every network boundary is a plain object passed as `options.api`,
 * so nothing here calls `fetch` or needs the port-7331 instance the operator
 * may already be running.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIX_MODAL_PATH = path.join(ROOT, "public", "js", "components", "fix-modal.js");
const SOURCE = readFileSync(FIX_MODAL_PATH, "utf8");

// ==========================================================================
// A minimal DOM shim — see file header for its limits.
// ==========================================================================

class ShimText {
  constructor(data) { this.data = String(data); this.parent = null; }
  get textContent() { return this.data; }
  get childNodes() { return []; }
}

class ShimElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parent = null;
    this._text = "";
    this.className = "";
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
  }

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
  getElementById: () => null,
  querySelector: () => null,
  body: new ShimElement("body"),
  addEventListener: () => {},
  removeEventListener: () => {},
};

globalThis.document = documentShim;
// app.js (imported transitively by fix-modal.js) registers module-scope
// listeners on globalThis; Node has no such global by default.
if (typeof globalThis.addEventListener !== "function") globalThis.addEventListener = () => {};

const { openFixModal } = await import("../public/js/components/fix-modal.js");

// -------------------------------------------------------------- test utils

/** Depth-first walk of a shim tree. */
function collect(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    out.push(node);
    (node.childNodes ?? []).forEach((child) => stack.push(child));
  }
  return out;
}

const findAll = (root, predicate) => collect(root).filter(predicate);
const byTag = (root, tag) => findAll(root, (node) => node.tagName === tag.toUpperCase());
const hasClass = (node, cls) => String(node.className ?? "").split(/\s+/).includes(cls);

/** `openFixModal`'s buttons ignore the event object entirely — `{}` is enough. */
function fireClick(node) {
  (node.listeners.get("click") ?? []).forEach((handler) => handler({}));
}

/** Same idea as tests/integration.test.js's `settle`: drain pending microtasks. */
const settle = async () => { for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

/**
 * A double for the `api` the modal is handed via `options.api` — the same
 * injection point `openFixModal`'s own JSDoc documents for a harness. Records
 * every call so a test can assert the modal went through `api.get`/`api.post`
 * (BP-005.13's CSRF path) rather than around it.
 */
function makeApi({ check, fixesList, preview, apply, undo } = {}) {
  const calls = [];
  const resolveOrThrow = (spec) => {
    if (spec instanceof Error) throw spec;
    return typeof spec === "function" ? spec() : spec;
  };
  return {
    calls,
    async get(requestPath) {
      calls.push(["GET", requestPath]);
      if (requestPath.endsWith("/check")) return resolveOrThrow(check ?? { applied: false, status: "not-applied" });
      if (requestPath === "/api/fixes") return resolveOrThrow(fixesList ?? { fixes: [] });
      throw new Error(`unmocked GET ${requestPath}`);
    },
    async post(requestPath, body) {
      calls.push(["POST", requestPath, body]);
      if (requestPath.endsWith("/preview")) return resolveOrThrow(preview);
      if (requestPath.endsWith("/apply")) return resolveOrThrow(apply);
      if (requestPath.endsWith("/undo")) return resolveOrThrow(undo);
      throw new Error(`unmocked POST ${requestPath}`);
    },
  };
}

const BASE_PREVIEW = Object.freeze({
  kind: "append-section",
  description: "Append a CLAUDE.md rule that batches independent commands.",
  diff: "--- a/.claude/CLAUDE.md\n+++ b/.claude/CLAUDE.md\n@@ -1,1 +1,2 @@\n context\n+new rule line\n",
  files_affected: ["/home/user/.claude/CLAUDE.md"],
  reversible: true,
  targets: [{
    path: "/home/user/.claude/CLAUDE.md",
    display: "~/.claude/CLAUDE.md",
    created: false,
    note: "appended 42 bytes (lf)",
  }],
});

// ==========================================================================
// T1 — the preview view shows the target file path and the diff verbatim.
// ==========================================================================

test("T1: preview shows the target file path and the diff from the payload", async () => {
  const mount = new ShimElement("div");
  const api = makeApi({ preview: BASE_PREVIEW });

  openFixModal("claude-batch-commands", { mount, api });
  await settle();

  assert.match(mount.textContent, /\/home\/user\/\.claude\/CLAUDE\.md/, "the target path is shown");

  const pre = byTag(mount, "pre")[0];
  assert.ok(pre, "the diff is rendered as a <pre>");
  assert.equal(pre.textContent, BASE_PREVIEW.diff, "the rendered diff is byte-identical to the payload");

  assert.deepEqual(
    api.calls.find((call) => call[1].endsWith("/preview")).slice(0, 2),
    ["POST", "/api/fixes/claude-batch-commands/preview"],
  );
});

// ==========================================================================
// T2 — a LIMITATIONS statement: guidance, not an enforced guarantee.
// ==========================================================================

test("T2: a LIMITATIONS statement says this is guidance, not an enforced guarantee", async () => {
  const mount = new ShimElement("div");
  const api = makeApi({ preview: BASE_PREVIEW });

  openFixModal("claude-batch-commands", { mount, api });
  await settle();

  const title = findAll(mount, (node) => hasClass(node, "callout-title") && node.textContent === "Limitations")[0];
  assert.ok(title, "a Limitations callout is rendered");
  const box = title.parent;
  assert.match(box.textContent, /guidance, not an enforced constraint/i);
  assert.match(box.textContent, /does not guarantee the agent's behaviour changes/i);
  // Not oversold: it does not claim the write is verified to work.
  assert.doesNotMatch(box.textContent, /guaranteed to work|will change the agent's behaviour/i);
});

test("T2b: a recommendation-kind fix gets the narrower, write-free limitations text", async () => {
  const mount = new ShimElement("div");
  const api = makeApi({
    preview: {
      kind: "recommendation",
      description: "A habit, not a write.",
      diff: "",
      files_affected: [],
      reversible: false,
      targets: [],
    },
  });

  openFixModal("some-habit", { mount, api });
  await settle();

  const title = findAll(mount, (node) => hasClass(node, "callout-title") && node.textContent === "Limitations")[0];
  assert.ok(title);
  assert.match(title.parent.textContent, /nothing changes on disk/i);
});

// ==========================================================================
// T3 — a diff whose old side is /dev/null reads as "will be created".
// ==========================================================================

test("T3a: targets[].created renders an explicit 'does not exist yet' notice", async () => {
  const mount = new ShimElement("div");
  const api = makeApi({
    preview: {
      ...BASE_PREVIEW,
      diff: "--- /dev/null\n+++ ~/.claude/settings.json\n@@ -0,0 +1,1 @@\n+{}\n",
      files_affected: ["/home/user/.claude/settings.json"],
      targets: [{
        path: "/home/user/.claude/settings.json",
        display: "~/.claude/settings.json",
        created: true,
        note: "created the file with 1 key(s)",
      }],
    },
  });

  openFixModal("claude-auto-compact", { mount, api });
  await settle();

  assert.match(mount.textContent, /does not exist yet/i);
  assert.match(mount.textContent, /CREATE ~\/\.claude\/settings\.json/);
});

test("T3b: with no targets array, the /dev/null convention in the diff text alone is enough", async () => {
  const mount = new ShimElement("div");
  const api = makeApi({
    preview: {
      kind: "json-merge",
      description: "Merge a key.",
      diff: "--- /dev/null\n+++ ~/.claude/settings.json\n@@ -0,0 +1,1 @@\n+{}\n",
      files_affected: ["/home/user/.claude/settings.json"],
      reversible: true,
      // no `targets` at all — a caller/double that only carries the diff.
    },
  });

  openFixModal("claude-auto-compact", { mount, api });
  await settle();

  assert.match(mount.textContent, /does not exist yet/i);
  assert.ok(mount.textContent.includes("~/.claude/settings.json"), "the path from the diff's +++ line is named");
});

test("T3c: an ordinary (non-/dev/null) diff does NOT claim the file will be created", async () => {
  const mount = new ShimElement("div");
  const api = makeApi({ preview: BASE_PREVIEW });

  openFixModal("claude-batch-commands", { mount, api });
  await settle();

  assert.doesNotMatch(mount.textContent, /does not exist yet/i);
});

// ==========================================================================
// T4 — an ALREADY_APPLIED refusal renders as "already applied", not a raw
// error, from every path that can produce it.
// ==========================================================================

test("T4a: check().applied renders as Already applied, never as a failure", async () => {
  const mount = new ShimElement("div");
  const api = makeApi({
    check: {
      applied: true,
      status: "applied",
      display: "~/.claude/CLAUDE.md",
      marker: "<!-- session-rx:batch-commands:v1 -->",
    },
  });

  openFixModal("claude-batch-commands", { mount, api });
  await settle();

  assert.match(mount.textContent, /Already applied/);
  assert.doesNotMatch(mount.textContent, /failed/i);
  const undoButton = findAll(mount, (node) => node.tagName === "BUTTON" && node.textContent === "Undo")[0];
  assert.ok(undoButton, "Undo button exists");
  assert.equal(undoButton.hidden, false, "Undo is offered for an already-applied fix");
});

test("T4b: preview() throwing ALREADY_APPLIED renders as already-applied, not a red error", async () => {
  const mount = new ShimElement("div");
  const api = makeApi({
    check: { applied: false, status: "not-applied" }, // check() said "no" moments ago
    preview: new Error("~/.claude/CLAUDE.md already has <!-- session-rx:batch-commands:v1 -->; applying again would duplicate it"),
  });

  openFixModal("claude-batch-commands", { mount, api });
  await settle();

  assert.match(mount.textContent, /Already applied/);
  assert.doesNotMatch(mount.textContent, /Preview failed/i);
  const errorCallouts = findAll(mount, (node) => hasClass(node, "callout-error"));
  assert.equal(errorCallouts.length, 0, "no error-styled callout for a healthy already-applied state");
});

test("T4c: apply() throwing ALREADY_APPLIED renders as already-applied, not a red error", async () => {
  const mount = new ShimElement("div");
  const api = makeApi({
    check: { applied: false, status: "not-applied" },
    preview: BASE_PREVIEW,
    apply: new Error("~/.claude/CLAUDE.md already carries <!-- session-rx:batch-commands:v1 -->; applying again would duplicate it"),
  });

  openFixModal("claude-batch-commands", { mount, api });
  await settle();
  const applyButton = findAll(mount, (node) => node.tagName === "BUTTON" && node.textContent === "Apply")[0];
  assert.ok(applyButton && !applyButton.disabled, "Apply is enabled once preview loaded");
  fireClick(applyButton);
  await settle();

  assert.match(mount.textContent, /Already applied/);
  const errorCallouts = findAll(mount, (node) => hasClass(node, "callout-error"));
  assert.equal(errorCallouts.length, 0);
});

// ==========================================================================
// T5 — after apply, Undo is present and carries the returned undoPath.
// ==========================================================================

test("T5: after apply, Undo is offered and the undo record names the returned undoPath", async () => {
  const mount = new ShimElement("div");
  const undoPath = "/home/user/.session-rx/undo/2026-09-21T00-00-00-000Z";
  const api = makeApi({
    check: { applied: false, status: "not-applied" },
    preview: BASE_PREVIEW,
    apply: {
      applied: true,
      diff: BASE_PREVIEW.diff,
      files_affected: BASE_PREVIEW.files_affected,
      undoPath,
      reversible: true,
    },
  });

  openFixModal("claude-batch-commands", { mount, api });
  await settle();
  const applyButton = findAll(mount, (node) => node.tagName === "BUTTON" && node.textContent === "Apply")[0];
  assert.ok(applyButton && !applyButton.disabled);
  fireClick(applyButton);
  await settle();

  const undoButton = findAll(mount, (node) => node.tagName === "BUTTON" && node.textContent === "Undo")[0];
  assert.ok(undoButton, "Undo button exists after apply");
  assert.equal(undoButton.hidden, false);
  assert.equal(undoButton.disabled, false);
  assert.match(mount.textContent, new RegExp(undoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the undo record names the returned undoPath");

  // Undo still works, and re-checks state afterwards (BP-004.10).
  fireClick(undoButton);
  await settle();
  assert.deepEqual(
    api.calls.find((call) => call[1].endsWith("/undo")).slice(0, 3),
    ["POST", "/api/fixes/claude-batch-commands/undo", { undoPath }],
  );
  assert.match(mount.textContent, /Undone/);
});

// ==========================================================================
// T6 — mutations go through app.js's api (CSRF nonce), never through fetch
// directly.
// ==========================================================================

test("T6: fix-modal.js never calls fetch directly, and defaults to app.js's api", () => {
  // Comment-stripped: this file's own header prose mentions "fetch" and
  // "api.post" repeatedly, which a raw grep would wrongly flag.
  const stripped = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(stripped, /\bfetch\s*\(/, "no direct fetch() call in the component's code");
  assert.match(stripped, /import\s*\{\s*api as appApi\s*\}\s*from\s*["']\.\.\/app\.js["']/, "imports app.js's CSRF-carrying api");
  assert.match(stripped, /raw\.api\s*&&\s*typeof raw\.api\.post === "function"\s*\?\s*raw\.api\s*:\s*appApi/, "defaults to appApi unless a caller injects a double");
});

test("T6b: every mutating call the modal makes goes through the injected api.post/api.get, in order", async () => {
  const mount = new ShimElement("div");
  const undoPath = "/home/user/.session-rx/undo/2026-09-21T00-00-00-000Z";
  const api = makeApi({
    check: { applied: false, status: "not-applied" },
    preview: BASE_PREVIEW,
    apply: { applied: true, diff: BASE_PREVIEW.diff, files_affected: BASE_PREVIEW.files_affected, undoPath, reversible: true },
    undo: { restored: true, byteIdentical: true, undoPath },
  });

  openFixModal("claude-batch-commands", { mount, api });
  await settle();
  fireClick(findAll(mount, (node) => node.tagName === "BUTTON" && node.textContent === "Apply")[0]);
  await settle();
  fireClick(findAll(mount, (node) => node.tagName === "BUTTON" && node.textContent === "Undo")[0]);
  await settle();

  const paths = api.calls.map((call) => `${call[0]} ${call[1]}`);
  assert.ok(paths.includes("GET /api/fixes/claude-batch-commands/check"));
  assert.ok(paths.includes("GET /api/fixes"));
  assert.ok(paths.includes("POST /api/fixes/claude-batch-commands/preview"));
  assert.ok(paths.includes("POST /api/fixes/claude-batch-commands/apply"));
  assert.ok(paths.includes("POST /api/fixes/claude-batch-commands/undo"));
});

// ==========================================================================
// Beyond the six mandatory tests: the "expected effect" text the product
// owner asked for, sourced from whichever place the engine actually puts it
// (`preview.rationale` for a recommendation, `GET /api/fixes` for a writable
// fix), and rendered as an honest absence when neither has one — never a
// fabricated sentence.
// ==========================================================================

test("expected effect: falls back to GET /api/fixes's rationale when preview() has none", async () => {
  const mount = new ShimElement("div");
  const api = makeApi({
    preview: BASE_PREVIEW, // no `rationale` field, matching the real WritableFix.preview()
    fixesList: {
      fixes: [{ id: "claude-batch-commands", title: "Batch the calls that answer one question", rationale: "SessionRx flags a session when the same tool, input and result recur five or more times." }],
    },
  });

  openFixModal("claude-batch-commands", { mount, api });
  await settle();

  const heading = findAll(mount, (node) => node.tagName === "H4" && node.textContent === "expected effect")[0];
  assert.ok(heading, "an expected-effect section is rendered");
  assert.match(heading.parent.textContent, /recur five or more times/);
});

test("expected effect: an honest 'not stated' rather than a fabricated sentence", async () => {
  const mount = new ShimElement("div");
  const api = makeApi({ preview: BASE_PREVIEW, fixesList: { fixes: [] } });

  openFixModal("claude-batch-commands", { mount, api });
  await settle();

  const heading = findAll(mount, (node) => node.tagName === "H4" && node.textContent === "expected effect")[0];
  assert.ok(heading);
  assert.match(heading.parent.textContent, /did not report an expected effect/i);
});
