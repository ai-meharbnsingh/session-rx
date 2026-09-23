/**
 * tests/ui-sessions.test.js — the sessions table is a PAGE, and says so.
 *
 * `/api/sessions` served the whole matched corpus in one body — measured
 * 2026-09-21 on a heavy real corpus at 1,236 sessions / 45,948,574 bytes — for
 * a table that shows about twenty rows. The API now serves twenty at a time
 * (`SESSIONS_PAGE_LIMIT`, tests P1-P10 in tests/server.test.js) and this file
 * covers the other half: that public/js/pages/sessions.js asks for the next
 * twenty when the reader reaches the bottom, asks exactly once per page, stops
 * cleanly at the end, survives a failed page, and never prints a count that
 * claims more than it holds.
 *
 * Harness style follows tests/ui-health.test.js: the same minimal DOM shim
 * (createElement / createTextNode / createDocumentFragment / classList /
 * dataset / setAttribute / a recursive textContent), no browser, no new
 * dependency, plus two doubles this file needs and that one does not — an
 * `IntersectionObserver` whose callback the test fires by hand, and an `api`
 * double that records every URL asked for. Same stated limits: no layout, no
 * CSS cascade, no real scrolling — this proves REQUEST BEHAVIOUR, DOM STRUCTURE
 * and TEXT, not pixels.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ==========================================================================
// A minimal DOM, sufficient for public/js/pages/sessions.js and nothing more.
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
// The two doubles this file adds: IntersectionObserver, and the app.js api
// ==========================================================================

/**
 * Every observer the page has constructed, newest last.
 *
 * `draw()` rebuilds the whole subtree, so each redraw disconnects the previous
 * observer and constructs a new one against the new sentinel. `latest()` is
 * therefore the only one that can still fire, and `disconnected` on the others
 * is what proves the page is not leaking one observer per appended page.
 */
const observers = [];

class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = [];
    this.disconnected = false;
    observers.push(this);
  }

  observe(target) { this.targets.push(target); }
  disconnect() { this.disconnected = true; }

  /** What the browser does when the sentinel scrolls into view. */
  trigger() {
    this.callback(this.targets.map((target) => ({ target, isIntersecting: true })), this);
  }
}

globalThis.IntersectionObserver = FakeIntersectionObserver;

const latestObserver = () => observers[observers.length - 1] ?? null;

/**
 * An `app.js` request-helper double.
 *
 * It records every URL, so "no duplicate request for the same page" is an
 * assertion about a list and not about a spy count, and `failNext` makes the
 * NEXT call reject the way the real helper rejects — with a sentence a person
 * can act on, which is what the page is required to show verbatim.
 */
function makeApi(corpus, { pageSize = 20 } = {}) {
  const calls = [];
  return {
    calls,
    failNext: null,
    async get(path) {
      calls.push(path);
      if (this.failNext) {
        const message = this.failNext;
        this.failNext = null;
        throw new Error(message);
      }
      const url = new URL(path, "http://127.0.0.1");
      const limit = Number(url.searchParams.get("limit") ?? pageSize);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return page(corpus, offset, limit);
    },
  };
}

/** Page identity is the endpoint plus its pagination parameters, not the scan window. */
const sessionPage = (url) => {
  const parsed = new URL(url, "http://127.0.0.1");
  assert.equal(parsed.pathname, "/api/sessions", "pagination must use the sessions endpoint");
  assert.ok(parsed.searchParams.get("scan"), "pagination keeps the scan bound");
  assert.ok(parsed.searchParams.get("from"), "pagination keeps the range start");
  assert.ok(parsed.searchParams.get("to"), "pagination keeps the range end");
  return {
    pathname: parsed.pathname,
    limit: Number(parsed.searchParams.get("limit")),
    offset: Number(parsed.searchParams.get("offset")),
  };
};

/** The body `/api/sessions` publishes, built the way src/server.js builds it. */
function page(corpus, offset, limit) {
  const sessions = corpus.slice(offset, offset + limit);
  const consumed = offset + sessions.length;
  const hasMore = consumed < corpus.length;
  return {
    sessions,
    total: corpus.length,
    returned: sessions.length,
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? consumed : null,
    scan: { limitPerCollector: 250, defaulted: true, atLimit: false, note: null },
    diagnostics: [],
  };
}

// Imported after the shim is installed: sessions.js touches `document` at call
// time and imports app.js / health.js at module scope.
const sessionsPage = await import("../public/js/pages/sessions.js");

// ==========================================================================
// Fixtures
// ==========================================================================

/**
 * Strictly descending, one hour apart, with no wrap.
 *
 * The page sorts its rows by date descending, so a fixture whose timestamps tie
 * or repeat would have the sort — not the paging — decide the row order, and
 * every "page 2 was appended below page 1" assertion below would be testing the
 * comparator instead.
 */
const NEWEST = Date.UTC(2026, 8, 21, 9, 0, 0);
const ISO = (index) => new Date(NEWEST - index * 3_600_000).toISOString();

/** `count` sessions, newest first, each carrying the shape the table reads. */
function corpusOf(count, { cli = "claude" } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    cli,
    sessionId: `s-${String(index).padStart(4, "0")}`,
    project: `project-${index}`,
    cwd: `/Users/demo/project-${index}`,
    model: "claude-opus-5",
    startedAt: ISO(index),
    endedAt: ISO(index),
    turnCount: 10 + index,
    subagentTurns: null,
    window: { tokens: 200000, source: "model-table" },
    score: { total: 6, passed: 4, observed: 1, unknown: 1, label: "" },
    rules: [],
  }));
}

const mountNode = () => new ShimElement("section");

/** First paint: seed the page with page 1 exactly as app.js does. */
function paint(corpus, api, { pageSize = 20 } = {}) {
  const mount = mountNode();
  sessionsPage.renderSessions(mount, page(corpus, 0, pageSize), { api });
  return mount;
}

/** Data rows only — the diagnosis row and the header row are not sessions. */
const dataRows = (mount) => withTag(mount, "tr").filter((row) => typeof row.dataset.sessionId === "string"
  && row.dataset.sessionId !== ""
  && !row.classList.contains("session-diagnosis"));

const pagerStrip = (mount) => withClass(mount, "sessions-pager")[0] ?? null;

// ==========================================================================
// Tests
// ==========================================================================

test("first paint renders exactly the first page, and nothing more", async () => {
  const corpus = corpusOf(45);
  const api = makeApi(corpus);
  const mount = paint(corpus, api);

  assert.equal(dataRows(mount).length, 20, "the first paint shows the 20 newest, not the whole corpus");
  assert.deepEqual(
    dataRows(mount).map((row) => row.dataset.sessionId),
    corpus.slice(0, 20).map((session) => session.sessionId),
    "and shows them in the order the server sent them",
  );
  assert.deepEqual(api.calls, [], "the first page is already in hand; painting it must not re-fetch it");
});

test("the sentinel appends the next page rather than replacing the first", async () => {
  const corpus = corpusOf(45);
  const api = makeApi(corpus);
  const mount = paint(corpus, api);
  const firstIds = dataRows(mount).map((row) => row.dataset.sessionId);

  latestObserver().trigger();
  await settle();

  assert.deepEqual(
    api.calls.map(sessionPage),
    [{ pathname: "/api/sessions", limit: 20, offset: 20 }],
    "the sentinel asks for the page after the one it holds",
  );
  const afterIds = dataRows(mount).map((row) => row.dataset.sessionId);
  assert.equal(afterIds.length, 40, "20 + 20; a replacing page would still read 20");
  assert.deepEqual(afterIds.slice(0, 20), firstIds, "page 1 stays, in its original order, above page 2");
  assert.deepEqual(afterIds.slice(20), corpus.slice(20, 40).map((session) => session.sessionId));
});

test("a sentinel that fires twice does not fetch the same page twice", async () => {
  const corpus = corpusOf(45);
  const api = makeApi(corpus);
  const mount = paint(corpus, api);

  const observer = latestObserver();
  // Two synchronous hits, before the first request has settled: the overlap
  // guard, not the already-requested guard.
  observer.trigger();
  observer.trigger();
  await settle();
  assert.deepEqual(
    api.calls.map(sessionPage),
    [{ pathname: "/api/sessions", limit: 20, offset: 20 }],
    "an in-flight page is not requested again",
  );

  // And once more AFTER it settled, against the redrawn sentinel — which is
  // what really happens, because appending rows pushes the sentinel back into
  // view. The offset has moved on, so this is a new page, not a repeat.
  latestObserver().trigger();
  await settle();
  assert.deepEqual(
    api.calls.map(sessionPage),
    [
      { pathname: "/api/sessions", limit: 20, offset: 20 },
      { pathname: "/api/sessions", limit: 20, offset: 40 },
    ],
    "each offset is asked for exactly once",
  );
  assert.equal(new Set(api.calls.map((url) => sessionPage(url).offset)).size, api.calls.length, "no offset is repeated");
  assert.equal(dataRows(mount).length, 45);
});

test("the count text is true at every stage, and never claims the corpus", async () => {
  const corpus = corpusOf(45);
  const api = makeApi(corpus);
  const mount = paint(corpus, api);

  const note = withClass(mount, "note")[0];
  assert.match(note.textContent, /Showing 20 of 45 sessions matched in this scan/);
  assert.match(note.textContent, /more load as you scroll/);

  const caption = withClass(mount, "chart-sub")[0];
  assert.match(caption.textContent, /20 shown of 20 loaded, of 45 matched/);
  const select = withTag(mount, "SELECT")[0];
  assert.match(select.textContent, /All CLIs \(20 of 45 loaded\)/, "the filter counts loaded rows, and says so");

  latestObserver().trigger();
  await settle();
  assert.match(withClass(mount, "note")[0].textContent, /Showing 40 of 45 sessions matched in this scan/);
  assert.match(withClass(mount, "chart-sub")[0].textContent, /40 shown of 40 loaded, of 45 matched/);

  latestObserver().trigger();
  await settle();
  const final = withClass(mount, "note")[0].textContent;
  assert.match(final, /45 sessions matched in this scan, all loaded/);
  assert.equal(/more load as you scroll/.test(final), false, "nothing more loads, so the page stops saying it will");
  assert.match(withClass(mount, "chart-sub")[0].textContent, /45 of 45 shown/);
});

test("CLI facet options include CLIs absent from the first page, and selecting one refetches page one", async () => {
  const codex = corpusOf(20, { cli: "codex" });
  const claude = corpusOf(3, { cli: "claude" });
  const all = [...codex, ...claude];
  const calls = [];
  const api = {
    async get(path) {
      calls.push(path);
      const url = new URL(path, "http://127.0.0.1");
      const selected = url.searchParams.get("cli");
      const filtered = selected ? all.filter((session) => session.cli === selected) : all;
      return {
        ...page(filtered, Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("limit") ?? 20)),
        cliCounts: [
          { cli: "claude", count: 3 },
          { cli: "codex", count: 20 },
          { cli: "gemini", count: 4 },
          { cli: "kimi", count: 2 },
          { cli: "opencode", count: 1 },
        ],
      };
    },
  };
  const mount = mountNode();
  sessionsPage.renderSessions(mount, {
    ...page(codex, 0, 20),
    cliCounts: [
      { cli: "claude", count: 3 },
      { cli: "codex", count: 20 },
      { cli: "gemini", count: 4 },
      { cli: "kimi", count: 2 },
      { cli: "opencode", count: 1 },
    ],
  }, { api });

  const select = withTag(mount, "SELECT")[0];
  assert.match(select.textContent, /claude \(3\)/);
  assert.match(select.textContent, /gemini \(4\)/);
  assert.match(select.textContent, /kimi \(2\)/);
  assert.match(select.textContent, /opencode \(1\)/);
  select.value = "claude";
  fire(select, "change");
  await settle();

  const request = new URL(calls.at(-1), "http://127.0.0.1");
  assert.equal(request.searchParams.get("cli"), "claude");
  assert.equal(request.searchParams.get("offset"), "0");
  assert.equal(dataRows(mount).length, 3);
});

test("the end of the list stops cleanly: no sentinel, no observer, no further request", async () => {
  const corpus = corpusOf(45);
  const api = makeApi(corpus);
  const mount = paint(corpus, api);

  for (let i = 0; i < 6; i += 1) {
    const observer = latestObserver();
    if (!observer || observer.disconnected) break;
    observer.trigger();
    await settle();
  }

  assert.equal(dataRows(mount).length, 45, "every session is loaded");
  assert.equal(api.calls.length, 2, "45 sessions is page 1 plus exactly two more pages");

  const strip = pagerStrip(mount);
  assert.equal(strip.dataset.state, "end");
  assert.match(strip.textContent, /End of the list — all 45 sessions matched in this scan are loaded/);
  assert.deepEqual(
    withTag(strip, "BUTTON").map((node) => node.dataset.action),
    [],
    "no Load more and no Retry: there is nothing left to ask for",
  );
  assert.equal(latestObserver().disconnected, true, "the observer is released, not left watching a dead sentinel");

  // A stray trigger on the released observer must not restart anything.
  latestObserver().trigger();
  await settle();
  assert.equal(api.calls.length, 2, "a list that has ended stays ended");
});

test("a corpus that fits on one page shows no pager controls at all", async () => {
  const corpus = corpusOf(7);
  const api = makeApi(corpus);
  const mount = paint(corpus, api);

  assert.equal(dataRows(mount).length, 7);
  const strip = pagerStrip(mount);
  assert.equal(strip.dataset.state, "end");
  assert.match(withClass(mount, "note")[0].textContent, /7 sessions matched in this scan, all loaded/);
  assert.deepEqual(api.calls, []);
});

test("a failed page says so in the helper's own words, and offers a retry that works", async () => {
  const corpus = corpusOf(45);
  const api = makeApi(corpus);
  const mount = paint(corpus, api);

  const DEAD = "The SessionRx server at 127.0.0.1:7777 is not responding — it is probably no longer running; "
    + "restart it with npx session-rx and reload this page.";
  api.failNext = DEAD;
  latestObserver().trigger();
  await settle();

  assert.equal(dataRows(mount).length, 20, "a failed page adds no rows");
  const strip = pagerStrip(mount);
  assert.equal(strip.dataset.state, "error");
  assert.equal(strip.getAttribute("role"), "alert");
  assert.ok(strip.textContent.includes(DEAD), "the helper's translated message is shown verbatim, not swallowed");
  assert.equal(latestObserver().disconnected, true, "the sentinel is stood down so the failure does not retry in a loop");

  const retry = withTag(mount, "BUTTON").find((node) => node.dataset.action === "retry-page");
  assert.ok(retry, "a failed load must be retryable");
  fire(retry);
  await settle();

  assert.equal(dataRows(mount).length, 40, "the retry asks for the SAME page again and gets it");
  assert.deepEqual(
    api.calls.map(sessionPage),
    [
      { pathname: "/api/sessions", limit: 20, offset: 20 },
      { pathname: "/api/sessions", limit: 20, offset: 20 },
    ],
    "the failed offset is re-requested, not skipped",
  );
  assert.equal(pagerStrip(mount).dataset.state, "idle", "and the page is back to waiting for the reader");
});

test("without IntersectionObserver the same page still loads, by button", async () => {
  const corpus = corpusOf(45);
  const api = makeApi(corpus);
  const saved = globalThis.IntersectionObserver;
  delete globalThis.IntersectionObserver;
  try {
    const mount = paint(corpus, api);
    const strip = pagerStrip(mount);
    assert.equal(strip.dataset.state, "idle");
    assert.match(strip.textContent, /25 more sessions to load/);
    const more = withTag(mount, "BUTTON").find((node) => node.dataset.action === "load-more");
    assert.ok(more, "a browser with no IntersectionObserver must still be able to reach the rest of the list");
    fire(more);
    await settle();
    assert.equal(dataRows(mount).length, 40);
  } finally {
    globalThis.IntersectionObserver = saved;
  }
});

test("re-rendering the same payload keeps the pages already loaded", async () => {
  const corpus = corpusOf(45);
  const api = makeApi(corpus);
  const first = page(corpus, 0, 20);
  const mount = mountNode();
  sessionsPage.renderSessions(mount, first, { api });

  latestObserver().trigger();
  await settle();
  assert.equal(dataRows(mount).length, 40);

  // app.js caches the first body and re-renders from that same object every
  // time the reader returns to this tab. Re-seeding there would silently throw
  // page 2 away and leave the count reading 20 of 45 again.
  sessionsPage.renderSessions(mount, first, { api });
  assert.equal(dataRows(mount).length, 40, "a re-render from the cached first page must not discard later pages");
  assert.equal(api.calls.length, 1, "and must not re-fetch them either");

  // A genuinely NEW body — a fresh scan — does start over.
  sessionsPage.renderSessions(mount, page(corpus, 0, 20), { api });
  assert.equal(dataRows(mount).length, 20, "a new first page is a new list");
});

// ==========================================================================
// Sidebar filters and the detail panel's tabs — every visible control acts.
// ==========================================================================

const rule = (id, name, status, extra = {}) => ({
  id,
  name,
  severity: "warn",
  threshold: { value: 0.5 },
  evidence: status === "unknown"
    ? { status, reason: "no-marker", values: [] }
    : { status, values: [{ label: "measured", value: 3 }] },
  ...extra,
});

/** Six sessions whose health and issues differ, so each filter has something to cut. */
function mixedCorpus() {
  const base = corpusOf(6);
  const pressure = rule("context-pressure", "Context pressure", "observed", { fix: "claude-auto-compact", fixCli: "claude", fixCliName: "Claude Code" });
  const repeats = rule("repeat-reads", "Repeated reads", "observed");
  const blind = rule("subagent-concurrency", "High sub-agent concurrency", "unknown");
  const clean = rule("cache-reuse", "Cache reuse", "not-observed");
  const shapes = [
    { rules: [pressure, clean], score: { total: 2, passed: 1, observed: 1, unknown: 0 } },
    { rules: [repeats, blind], score: { total: 2, passed: 0, observed: 1, unknown: 1 } },
    { rules: [pressure, repeats], score: { total: 2, passed: 0, observed: 2, unknown: 0 } },
    { rules: [blind, clean], score: { total: 2, passed: 1, observed: 0, unknown: 1 } },
    { rules: [clean], score: { total: 1, passed: 1, observed: 0, unknown: 0 } },
    { rules: [pressure], score: { total: 1, passed: 0, observed: 1, unknown: 0 }, cli: "codex", cliName: "Codex", model: null },
  ];
  return base.map((session, index) => ({ ...session, ...shapes[index] }));
}

const optionIn = (mount, group, label) => {
  const box = nodes(mount).find((node) => node.dataset?.filter === group);
  const row = withClass(box, "filter-option").find((node) => node.childNodes[1]?.textContent === label);
  return row ? { input: row.childNodes[0], count: Number(row.childNodes[2].textContent) } : null;
};

const shownIds = (mount) => dataRows(mount).map((row) => row.dataset.sessionId);

test("Health status filters narrow the table, and each count equals the rows it then shows", () => {
  const corpus = mixedCorpus();
  const mount = paint(corpus, makeApi(corpus));
  assert.equal(shownIds(mount).length, 6);

  const problems = optionIn(mount, "health", "Problems found");
  assert.equal(problems.count, 4);
  fire(problems.input, "change");
  assert.deepEqual(shownIds(mount), ["s-0000", "s-0001", "s-0002", "s-0005"]);
  assert.equal(shownIds(mount).length, problems.count, "the number beside the box is the number of rows it shows");
  assert.equal(optionIn(mount, "health", "Problems found").input.checked, true, "the box stays ticked after the redraw");

  // Two ticks in one group widen (either one), they do not narrow.
  fire(optionIn(mount, "health", "Could not be measured").input, "change");
  assert.deepEqual(shownIds(mount), ["s-0000", "s-0001", "s-0002", "s-0003", "s-0005"]);

  fire(optionIn(mount, "health", "Problems found").input, "change");
  const unknownOnly = optionIn(mount, "health", "Could not be measured");
  assert.deepEqual(shownIds(mount), ["s-0001", "s-0003"]);
  assert.equal(shownIds(mount).length, unknownOnly.count);

  fire(withClass(mount, "button").find((node) => node.dataset.action === "clear-filters"));
  assert.equal(shownIds(mount).length, 6, "Clear filters puts every row back");
});

test("Issue type filters narrow the table, combine with health, and say when nothing matches", () => {
  const corpus = mixedCorpus();
  const mount = paint(corpus, makeApi(corpus));

  const repeats = optionIn(mount, "issue", "Repeated reads");
  assert.equal(repeats.count, 2);
  fire(repeats.input, "change");
  assert.deepEqual(shownIds(mount), ["s-0001", "s-0002"]);
  assert.match(mount.textContent, /2 of 6 shown/, "the toolbar count follows the filters");

  // Across groups a row must satisfy both.
  fire(optionIn(mount, "health", "Could not be measured").input, "change");
  assert.deepEqual(shownIds(mount), ["s-0001"]);

  fire(optionIn(mount, "issue", "Context pressure").input, "change");
  assert.deepEqual(shownIds(mount), ["s-0001"], "a second issue widens within its group only");

  fire(optionIn(mount, "issue", "Repeated reads").input, "change");
  assert.deepEqual(shownIds(mount), []);
  assert.match(mount.textContent, /No session loaded so far matches the filters you picked\./);

  fire(withClass(mount, "button").find((node) => node.dataset.action === "clear-filters"));
  assert.equal(shownIds(mount).length, 6);
});

test("the detail panel's four tabs each switch to their own real content", () => {
  const corpus = mixedCorpus();
  const mount = paint(corpus, makeApi(corpus));
  fire(dataRows(mount).find((row) => row.dataset.sessionId === "s-0005"));

  const panel = () => withClass(mount, "detail-panel")[0];
  const tab = (key) => withClass(panel(), "tab-button").find((node) => node.dataset.tab === key);
  const content = () => nodes(panel()).find((node) => node.getAttribute?.("role") === "tabpanel");
  assert.ok(panel(), "clicking a row opens its details");
  assert.equal(withClass(panel(), "tab-button").length, 4);
  assert.equal(content().dataset.tab, "diagnosis");
  assert.match(content().textContent, /Context pressure/);
  // A Codex finding whose only fix changes Claude Code's settings is not offered as a fix for Codex.
  assert.match(content().textContent, /Recommendation only/);
  assert.doesNotMatch(content().textContent, /Fix available for your CLI/);

  fire(tab("evidence"));
  assert.equal(content().dataset.tab, "evidence");
  assert.equal(tab("evidence").getAttribute("aria-selected"), "true");
  assert.equal(tab("diagnosis").getAttribute("aria-selected"), "false");
  assert.equal(withClass(content(), "verdict").length, 1, "every rule's verdict is listed");

  fire(tab("metrics"));
  assert.equal(content().dataset.tab, "metrics");
  assert.match(content().textContent, /turns15/);
  const modelRow = nodes(content()).find((node) => node.childNodes?.[0]?.textContent === "model");
  assert.equal(withClass(modelRow, "not-measured").length, 1, "a missing model is 'not measured', never blank");

  fire(tab("timeline"));
  assert.equal(content().dataset.tab, "timeline");
  assert.match(content().textContent, /Session started/);
  assert.match(content().textContent, /Session ended/);
  assert.match(content().textContent, /Turn-by-turn timeline: not measured/);

  fire(tab("diagnosis"));
  fire(withClass(panel(), "button").find((node) => node.textContent === "Close"));
  assert.equal(panel(), undefined);
});

test("a session whose fix targets its own CLI says the fix is available for it", () => {
  const corpus = mixedCorpus();
  const mount = paint(corpus, makeApi(corpus));
  fire(dataRows(mount).find((row) => row.dataset.sessionId === "s-0000"));
  const panel = withClass(mount, "detail-panel")[0];
  assert.match(panel.textContent, /Fix available for your CLI/);
  fire(withClass(panel, "button").find((node) => node.textContent === "Close"));
});
