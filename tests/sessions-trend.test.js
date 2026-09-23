/**
 * tests/sessions-trend.test.js — the Trend column, and the difference between
 * "nothing was measured" and "the measurement was dropped on the way out".
 *
 * Every cell of the Sessions table's Trend column rendered "— not measured",
 * on every row, always. The sentence was false. The collectors DO record a
 * per-turn `context.inputTokens` (src/collectors/claude.js `finalizeTurn`), but
 * `analyzeSession` in src/analyzer/health.js keeps only `turnCount` and
 * discards the array it counted, so the `session.turns` that
 * public/js/pages/sessions.js reads never existed in the payload. The column
 * was reporting the serializer's silence as the user's missing data.
 *
 * `/api/sessions` now joins the raw collected turns back onto the rows of THE
 * PAGE it is about to send and attaches `contextSeries: number[] | null` —
 * numbers only, never turn objects, cost bounded by `limit` and not by the
 * scan.
 *
 * WHAT THIS FILE IS REALLY GUARDING (.claude/CLAUDE.md, THE HONESTY CONTRACT)
 * is the other direction. Removing a FALSE "not measured" must not create a
 * false measurement:
 *   - turns that all report `inputTokens: null` must STILL read "not measured";
 *   - one finite reading is not a trend, and must STILL read "not measured";
 *   - a row whose raw turns never reached the endpoint is `null` (unknown),
 *     not `[]` (read, and empty) — the two are different claims;
 *   - a missing token count is never 0, never a flat line, never an empty
 *     sparkline.
 * Tests T2, T3, U2, U3 and U4 below exist only to fail if that line is crossed.
 *
 * Real-file safety: the collector registry is INJECTED as a stub, so no test
 * here reads the developer's real `~/.claude`; every server is created with
 * `home:` pointing at a fresh `mkdtemp` directory. The UI half runs against the
 * same minimal DOM shim tests/ui-sessions.test.js uses, no browser.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import test from "node:test";

import { Collector, normalizeSession } from "../src/collectors/base.js";
import { collectMany, detectMany } from "../src/collectors/registry.js";
import { LOOPBACK_HOST, startServer } from "../src/server.js";

// ===========================================================================
// PART 1 — the endpoint: `/api/sessions` carries the series it measured
// ===========================================================================

const ISO = (day, hour = 12) => new Date(Date.UTC(2026, 8, day, hour, 0, 0)).toISOString();

/**
 * One turn, with the context shape the collectors actually emit.
 *
 * `source` follows `inputTokens` exactly as src/collectors/claude.js sets it:
 * a null reading is `"unknown"`, never a zero with a `"native"` label.
 */
function turn(ts, inputTokens) {
  return {
    ts,
    context: {
      inputTokens,
      fraction: inputTokens === null ? null : inputTokens / 200000,
      source: inputTokens === null ? "unknown" : "native",
    },
    cacheRead: null,
    cacheCreate: null,
    output: null,
    toolCalls: [],
    toolResultBytes: null,
    isSidechain: false,
  };
}

/** A session whose per-turn readings are exactly `tokens`, in order. */
function fixtureSession({ sessionId, tokens, day = 18, cli = "claude" }) {
  return normalizeSession({
    cli,
    sessionId,
    project: "-Users-demo-app",
    cwd: "/Users/demo/app",
    model: "claude-sonnet-4-5",
    window: { tokens: 200000, source: "model-table" },
    startedAt: ISO(day, 9),
    endedAt: ISO(day, 9 + tokens.length),
    turns: tokens.map((value, index) => turn(ISO(day, 9 + index), value)),
  });
}

const MEASURED = "11111111-1111-4111-8111-111111111111";
const ALL_NULL = "22222222-2222-4222-8222-222222222222";
const SINGLE = "33333333-3333-4333-8333-333333333333";

const MEASURED_TOKENS = [160000, 120000, 90000];

class FakeCollector extends Collector {
  constructor(id, sessions) {
    super({ id, displayName: `${id} (test double)`, cli: id });
    this.sessions = sessions;
  }

  detect() {
    return { installed: true, paths: [`/test-double/${this.id}`], status: "supported" };
  }

  async collect({ limit } = {}) {
    return Number.isInteger(limit) && limit > 0 ? this.sessions.slice(0, limit) : this.sessions;
  }
}

/** `detectAll`/`collectAll` delegate to the REAL registry helpers. */
function stubRegistry(collectors) {
  return {
    async detectAll() { return detectMany(collectors); },
    async collectAll(options) { return collectMany(collectors, options); },
  };
}

function get(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: LOOPBACK_HOST, port, method: "GET", path: target }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* left null; the test asserts on status */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const servers = [];

async function server(collectors) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "session-rx-trend-"));
  const running = await startServer({
    port: 0,
    home,
    publicDir: path.join(path.dirname(new URL(import.meta.url).pathname), "..", "public"),
    modules: { registry: stubRegistry(collectors) },
  });
  servers.push(running);
  return {
    ...running,
    get: (target) => get(running.port, target),
  };
}

after(async () => {
  for (const running of servers) {
    try { await running.close(); } catch { /* already closed */ }
  }
});

/** The three fixtures, on disjoint days so the default sort is deterministic. */
function trendCollectors() {
  const sessions = [
    fixtureSession({ sessionId: MEASURED, tokens: MEASURED_TOKENS, day: 18 }),
    fixtureSession({ sessionId: ALL_NULL, tokens: [null, null, null], day: 17 }),
    // Two turns, ONE of them measured: this proves the endpoint filters on the
    // READING and not on the turn count.
    fixtureSession({ sessionId: SINGLE, tokens: [42000, null], day: 16 }),
  ];
  const claude = new FakeCollector("claude", sessions);
  claude.sessionMeta = Object.fromEntries(sessions.map((session) => [session.sessionId, { parentSessionId: null }]));
  return [claude];
}

const byId = (body, sessionId) => body.sessions.find((session) => session.sessionId === sessionId) ?? null;

describe("/api/sessions carries the per-turn context series the Trend column draws", () => {
  it("T1: a session with two or more finite readings carries them as numbers", async () => {
    const running = await server(trendCollectors());
    const res = await running.get("/api/sessions");
    assert.equal(res.status, 200);

    const session = byId(res.json, MEASURED);
    assert.ok(session, "the measured fixture must be in the page");
    assert.ok(
      Array.isArray(session.contextSeries),
      "the Trend column cannot draw what the endpoint does not send: `contextSeries` must be an array",
    );
    assert.deepEqual(
      session.contextSeries,
      MEASURED_TOKENS,
      "the series is the per-turn inputTokens, in turn order, unaltered",
    );
    for (const value of session.contextSeries) {
      assert.equal(typeof value, "number");
      assert.ok(Number.isFinite(value));
    }
  });

  it("T2: turns that all report inputTokens: null carry an EMPTY series, never zeros", async () => {
    const running = await server(trendCollectors());
    const res = await running.get("/api/sessions");
    const session = byId(res.json, ALL_NULL);
    assert.ok(session, "the unmeasured fixture must still be a row");
    assert.ok(Array.isArray(session.contextSeries), "its turns WERE read, so the series is [] and not null");
    assert.deepEqual(
      session.contextSeries,
      [],
      "a null token count is absent, not zero: it must be dropped, never substituted with 0",
    );
    assert.equal(session.turnCount, 3, "the turns are still counted — only the READINGS are missing");
  });

  it("T3: one finite reading is carried, and is still not a trend", async () => {
    const running = await server(trendCollectors());
    const res = await running.get("/api/sessions");
    const session = byId(res.json, SINGLE);
    assert.ok(session);
    assert.deepEqual(session.contextSeries, [42000], "the single reading is neither padded nor discarded");
    assert.ok(session.contextSeries.length < 2, "and the page must read it as 'no trend to draw'");
  });

  it("T4: the series carries numbers only — no turn objects, no undefined holes", async () => {
    const running = await server(trendCollectors());
    const res = await running.get("/api/sessions");
    for (const session of res.json.sessions) {
      assert.ok(Array.isArray(session.contextSeries) || session.contextSeries === null);
      assert.equal(session.turns, undefined, "whole turn objects must never reach the wire");
      for (const value of session.contextSeries ?? []) {
        assert.equal(typeof value, "number", `contextSeries leaked a ${typeof value}`);
        assert.ok(Number.isFinite(value), "a non-finite reading is not a reading");
      }
    }
    // The JSON itself is the proof that no turn body travelled: a turn object
    // carries these keys and a number cannot.
    const serialized = JSON.stringify(res.json.sessions.map((session) => session.contextSeries));
    assert.doesNotMatch(serialized, /toolCalls|inputTokens|cacheRead|\{/, "the series is a flat list of numbers");
  });

  it("T5: a page of N rows carries at most N series — the cost is the page, not the scan", async () => {
    const many = [];
    for (let day = 1; day <= 12; day += 1) {
      many.push(fixtureSession({
        sessionId: `44444444-0000-4000-8000-${String(day).padStart(12, "0")}`,
        tokens: MEASURED_TOKENS,
        day,
      }));
    }
    const claude = new FakeCollector("claude", many);
    claude.sessionMeta = Object.fromEntries(many.map((session) => [session.sessionId, { parentSessionId: null }]));
    const running = await server([claude]);

    const limit = 4;
    const res = await running.get(`/api/sessions?limit=${limit}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.sessions.length, limit);
    assert.equal(res.json.total, many.length, "the scan still sees every session");

    const carried = res.json.sessions.filter((session) => Array.isArray(session.contextSeries));
    assert.ok(
      carried.length <= res.json.sessions.length,
      `a page of ${res.json.sessions.length} rows carried ${carried.length} series`,
    );
    assert.equal(carried.length, limit, "each of the four page rows — and only those four — carries its series");
  });
});

// ===========================================================================
// PART 2 — the cell: what the Trend column renders for each of those payloads
// ===========================================================================

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
if (!globalThis.location) globalThis.location = { hash: "#/sessions" };
if (typeof globalThis.IntersectionObserver !== "function") {
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
}

/** Depth-first, in document order. */
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

// Imported after the shim is installed: sessions.js touches `document` at call
// time and imports app.js / ui.js at module scope.
const sessionsPage = await import("../public/js/pages/sessions.js");

/** A row the sessions table can render, with only the Trend inputs varying. */
function uiSession(sessionId, extra) {
  return {
    cli: "claude",
    sessionId,
    project: "demo",
    cwd: "/Users/demo/app",
    model: "claude-opus-5",
    startedAt: ISO(18, 9),
    endedAt: ISO(18, 11),
    turnCount: 3,
    subagentTurns: null,
    window: { tokens: 200000, source: "model-table" },
    score: { total: 6, passed: 4, observed: 1, unknown: 1, label: "" },
    rules: [],
    ...extra,
  };
}

function paint(sessions) {
  const mount = new ShimElement("section");
  sessionsPage.renderSessions(mount, {
    sessions,
    total: sessions.length,
    returned: sessions.length,
    offset: 0,
    limit: 20,
    hasMore: false,
    nextOffset: null,
    scan: { limitPerCollector: 250, defaulted: true, atLimit: false, note: null },
    diagnostics: [],
  }, { api: { async get() { throw new Error("the Trend tests never page"); } } });
  return mount;
}

/**
 * The Trend cell of the first data row.
 *
 * The index is READ OFF THE HEADER (`th[data-column="trend"]`) rather than
 * hardcoded, because the header and the row are built from the same COLUMNS
 * list with the same leading expand cell — so a column inserted before Trend
 * moves both, and a hardcoded index would quietly start asserting about
 * "Findings" instead.
 */
function trendCell(mount) {
  const headers = withTag(mount, "th");
  const index = headers.findIndex((th) => th.dataset.column === "trend");
  assert.ok(index >= 0, "the table must still have a Trend column");
  const row = withTag(mount, "tr").find((tr) => typeof tr.dataset.sessionId === "string" && tr.dataset.sessionId !== "");
  assert.ok(row, "there must be a data row to read");
  const cells = (row.childNodes ?? []).filter((node) => node.tagName === "TD");
  const cell = cells[index];
  assert.ok(cell, "the Trend cell must exist");
  return cell;
}

const sparklineIn = (cell) => nodes(cell).find((node) => (node.getAttribute?.("class") ?? "").split(/\s+/).includes("sparkline")) ?? null;
const notMeasuredIn = (cell) => nodes(cell).find((node) => node.classList?.contains?.("not-measured")) ?? null;

test("U1: two or more readings draw a line, and no longer claim 'not measured'", () => {
  const mount = paint([uiSession(MEASURED, { contextSeries: MEASURED_TOKENS })]);
  const cell = trendCell(mount);

  assert.equal(notMeasuredIn(cell), null, "data exists, so the cell must not say the data does not");
  const spark = sparklineIn(cell);
  assert.ok(spark, "the Trend cell must contain a sparkline");
  const poly = nodes(spark).find((node) => node.tagName === "POLYLINE");
  assert.ok(poly, "a line, not an empty frame");
  const points = (poly.getAttribute("points") ?? "").trim().split(/\s+/).filter(Boolean);
  assert.equal(points.length, MEASURED_TOKENS.length, "every reading is plotted — no padding, no truncation");
});

test("U2: turns that recorded no context size still read 'not measured'", () => {
  const mount = paint([uiSession(ALL_NULL, { contextSeries: [] })]);
  const cell = trendCell(mount);

  assert.equal(sparklineIn(cell), null, "an empty sparkline would read as a measured flat session");
  const dash = notMeasuredIn(cell);
  assert.ok(dash, "the honest verdict survives the fix");
  assert.match(dash.textContent, /not measured/);
  assert.match(
    dash.getAttribute("title"),
    /fewer than two turns/,
    "and it still says WHY, machine-readably, instead of rendering a bare dash",
  );
  assert.doesNotMatch(cell.textContent, /\b0\b/, "a null token count is never rendered as 0");
});

test("U3: exactly one reading is not a trend, and does not draw one", () => {
  const mount = paint([uiSession(SINGLE, { contextSeries: [42000] })]);
  const cell = trendCell(mount);

  assert.equal(sparklineIn(cell), null, "one point is a dot, not a trend");
  const dash = notMeasuredIn(cell);
  assert.ok(dash);
  assert.match(dash.getAttribute("title"), /fewer than two turns/);
});

test("U4: a row whose series never arrived says THAT, not that nothing was measured", () => {
  // `null` is the join miss — the endpoint could not find this row's raw turns.
  // It is a different statement from `[]` (the turns were read and none carried
  // a size), and the cell must not upgrade the first into the second.
  const mount = paint([uiSession(MEASURED, { contextSeries: null })]);
  const cell = trendCell(mount);

  assert.equal(sparklineIn(cell), null);
  const dash = notMeasuredIn(cell);
  assert.ok(dash);
  assert.match(
    dash.getAttribute("title"),
    /did not reach this page/,
    "an unavailable series is 'unknown', not a claim about the session's turns",
  );
});

test("U5: a non-numeric series entry is refused, not plotted", () => {
  // Defence in depth for T4: even if something upstream put an object or an
  // undefined in the array, the cell plots only finite numbers — and with one
  // survivor, that is not a trend.
  const mount = paint([uiSession(MEASURED, { contextSeries: [160000, null, undefined, { inputTokens: 120000 }, "90000"] })]);
  const cell = trendCell(mount);

  assert.equal(sparklineIn(cell), null, "one finite value among the junk is still one value");
  assert.ok(notMeasuredIn(cell));
});
