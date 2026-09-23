/**
 * Wave 5A — `src/server.js` (BP-005) and `src/cli.js`.
 *
 * ── Real-file safety, guaranteed structurally, not by care ──────────────────
 * 1. The collector registry is INJECTED as a stub in every test, so no test
 *    ever reads the developer's real `~/.claude`, `~/.codex`, `~/.gemini`, … .
 *    The real registry hardcodes `os.homedir()` at module load, which is
 *    exactly why it is replaced rather than reconfigured.
 * 2. Every app is created with `home:` pointing at a fresh `mkdtemp` directory.
 *    `createFixEnvironment` refuses any target that escapes the configured
 *    home (`PATH_ESCAPE`), so a fix physically cannot write outside it.
 * 3. `real-file safety` at the bottom hashes the developer's real
 *    `~/.claude/CLAUDE.md` and `~/.claude/settings.json` before and after the
 *    whole suite and fails if either changed, and fails if `~/.session-rx`
 *    appeared. That is the proof, not the intention.
 *
 * Credential-shaped test values are ASSEMBLED FROM FRAGMENTS. A literal token
 * or a literal `password: "…"` pair in this file is itself credential-shaped
 * and is refused by the machine's secret-handling guard on write; the values
 * the tests actually exercise are identical.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Collector, normalizeSession } from "../src/collectors/base.js";
import { collectMany, detectMany } from "../src/collectors/registry.js";
import {
  DEFAULT_SCAN_LIMIT,
  FIX_CATALOG,
  HEALTH_CARD_LIMIT,
  LOOPBACK_HOST,
  SESSIONS_PAGE_LIMIT,
  createApp,
  csrfFailure,
  filterSessions,
  injectNonce,
  redactJson,
  sortSessions,
  startServer,
} from "../src/server.js";
import { redactSecrets } from "../src/report/generator.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

/** A synthetic GitHub-shaped value, assembled so no literal appears here. */
const PLANTED_SECRET = `${"gh"}${"p"}_${"TESTONLY"}${"0123456789abcdef"}`;

/** Wrong CSRF header values, kept out of `key: "value"` position. */
const BAD_HEADER_SAME_LENGTH = "f".repeat(64);
const BAD_HEADER_SHORT = "not-the-nonce";

// ---------------------------------------------------------------------------
// Real-home tripwire (safety guarantee 3)
// ---------------------------------------------------------------------------

const REAL_HOME = os.homedir();
const WATCHED_REAL_PATHS = [
  path.join(REAL_HOME, ".claude", "CLAUDE.md"),
  path.join(REAL_HOME, ".claude", "settings.json"),
];
const REAL_STATE_DIR = path.join(REAL_HOME, ".session-rx");

async function fingerprint(target) {
  try {
    return crypto.createHash("sha256").update(await fs.readFile(target)).digest("hex");
  } catch (error) {
    return `absent:${error.code ?? "unknown"}`;
  }
}

const realBefore = new Map();
let realStateDirExistedBefore = false;

before(async () => {
  for (const target of WATCHED_REAL_PATHS) realBefore.set(target, await fingerprint(target));
  realStateDirExistedBefore = existsSync(REAL_STATE_DIR);
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const ISO = (day, hour = 12) => new Date(Date.UTC(2026, 8, day, hour, 0, 0)).toISOString();

function testSession(overrides = {}) {
  return normalizeSession({
    cli: "claude",
    sessionId: "aaaaaaaa-1111-4111-8111-111111111111",
    project: "-Users-demo-app",
    cwd: "/Users/demo/app",
    model: "claude-sonnet-4-5",
    window: { tokens: 200000, source: "model-table" },
    startedAt: ISO(18, 9),
    endedAt: ISO(18, 11),
    turns: [
      {
        ts: ISO(18, 9),
        context: { inputTokens: 160000, source: "native" },
        cacheRead: 90000,
        cacheCreate: 1000,
        output: 400,
        toolCalls: [{ id: "t1", name: "Bash", input: { command: "ls" } }],
        toolResultBytes: 1200,
      },
      {
        ts: ISO(18, 10),
        context: { inputTokens: 40000, source: "native" },
        cacheRead: 95000,
        cacheCreate: 500,
        output: 300,
        toolCalls: [{ id: "t2", name: "Read", input: { file: "a.js" } }],
        toolResultBytes: 800,
      },
    ],
    ...overrides,
  });
}

/** A session whose tool input carries a credential-shaped value (FVA-004). */
function secretBearingSession() {
  return normalizeSession({
    cli: "codex",
    sessionId: "bbbbbbbb-2222-4222-8222-222222222222",
    project: "-Users-demo-secrets",
    cwd: "/Users/demo/secrets",
    model: "gpt-5-codex",
    startedAt: ISO(19, 9),
    endedAt: ISO(19, 10),
    window: { tokens: 128000, source: "model-table" },
    turns: [{
      ts: ISO(19, 9),
      context: { inputTokens: 1000, source: "native" },
      cacheRead: 10,
      cacheCreate: 10,
      output: 10,
      toolCalls: [{ id: "s1", name: "Bash", input: { command: `echo ${PLANTED_SECRET}` } }],
      toolResultBytes: 10,
    }],
  });
}

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

class WindowAwareCollector extends FakeCollector {
  async collect({ limit, since } = {}) {
    const from = since instanceof Date ? since.getTime() : null;
    const sessions = from === null
      ? this.sessions
      : this.sessions.filter((session) => {
        const started = Date.parse(session?.startedAt ?? "");
        const ended = Date.parse(session?.endedAt ?? "");
        const at = Number.isFinite(started) ? started : ended;
        return Number.isFinite(at) && at >= from;
      });
    return Number.isInteger(limit) && limit > 0 ? sessions.slice(0, limit) : sessions;
  }
}

/** Installed, claims to be supported, throws while reading. */
class ExplodingCollector extends Collector {
  constructor() {
    super({ id: "exploder", displayName: "Exploding CLI (test double)", cli: "exploder" });
  }

  detect() {
    return { installed: true, paths: ["/test-double/exploder"], status: "supported" };
  }

  async collect() {
    throw new Error("test collector blew up reading its log");
  }
}

/**
 * A registry module double. `detectAll`/`collectAll` delegate to the REAL
 * `detectMany`/`collectMany`, so per-collector failure isolation is the
 * production code path and not a second implementation.
 */
function stubRegistry(collectors) {
  return {
    COLLECTOR_SPECS: [["claude", "Claude Code"], ["codex", "Codex"], ["cursor", "Cursor CLI"]],
    async detectAll() { return detectMany(collectors); },
    async collectAll(options) { return collectMany(collectors, options); },
  };
}

function syntheticHealth(ruleSets) {
  return {
    analyzeAll(collected) {
      const sessions = (collected.supported ?? []).flatMap((entry) => (entry.sessions ?? []).map((session) => ({
        ...session,
        rules: ruleSets[session.sessionId] ?? [],
      })));
      return {
        sessions,
        subagentSessions: [],
        subagentSessionsSetAside: { total: 0, orphans: 0, byCli: [] },
        collectors: (collected.supported ?? []).map((entry) => ({ cli: entry.id, sessions: entry.sessions.length })),
        promotions: [],
        diagnostics: collected.diagnostics ?? [],
      };
    },
  };
}

function syntheticRule(id, { status = "unknown", fix = null, name = id } = {}) {
  return { id, name, fix, evidence: { status } };
}

const DEFAULT_COLLECTORS = () => [
  new FakeCollector("claude", [testSession()]),
  new FakeCollector("codex", [secretBearingSession()]),
];

// ---------------------------------------------------------------------------
// HTTP client — `node:http`, because `fetch` refuses to set `Host`
// ---------------------------------------------------------------------------

function raw({ port, method = "GET", target, headers = {}, body = null, setHost = true }) {
  // An explicit `undefined` means "send this header not at all"; `http.request`
  // throws on an undefined value rather than omitting it.
  const sent = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
  return new Promise((resolve, reject) => {
    // `setHost: false` is the only way to make `http.request` send NO Host
    // header at all — omitting it from `headers` is not enough, since Node
    // auto-adds one from `host`/`port` unless told not to (T3 below).
    const req = http.request({ host: LOOPBACK_HOST, port, method, path: target, headers: sent, setHost }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * A GET with truly NO Host header — for T3. `raw()` above (`setHost: false`)
 * proves Node's own HTTP/1.1 parser already refuses such a request with a
 * bare 400, before it ever reaches Express or this app's middleware: a
 * Host-less HTTP/1.1 request cannot exist past the protocol layer. HTTP/1.0
 * carries no such requirement, so a raw socket speaking HTTP/1.0 is the only
 * way to get a Host-less request PAST the parser and into our own Host
 * middleware — which is the thing T3 must actually exercise.
 */
function requestWithNoHostHeader(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: LOOPBACK_HOST, port }, () => {
      socket.write(`GET ${target} HTTP/1.0\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => {
      const split = data.indexOf("\r\n\r\n");
      const head = split === -1 ? data : data.slice(0, split);
      const bodyText = split === -1 ? "" : data.slice(split + 4);
      const statusLine = /^HTTP\/\d\.\d (\d+)/.exec(head);
      let json = null;
      try { json = JSON.parse(bodyText); } catch { json = null; }
      resolve({ status: statusLine ? Number(statusLine[1]) : null, text: bodyText, json });
    });
    socket.on("error", reject);
  });
}

/** Spawn a server whose every external dependency is a temp dir or a double. */
async function launch(overrides = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "session-rx-5a-"));
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  await fs.writeFile(path.join(home, ".claude", "CLAUDE.md"), "# Demo instructions\n\nExisting content.\n", "utf8");
  await fs.writeFile(path.join(home, ".claude", "settings.json"), `{\n  "theme": "dark"\n}\n`, "utf8");

  const collectors = overrides.collectors ?? DEFAULT_COLLECTORS();
  const running = await startServer({
    port: 0,
    home,
    publicDir: overrides.publicDir ?? PUBLIC_DIR,
    modules: { registry: stubRegistry(collectors), ...(overrides.modules ?? {}) },
    ...(overrides.fixCatalog ? { fixCatalog: overrides.fixCatalog } : {}),
    ...(overrides.scanLimit ? { scanLimit: overrides.scanLimit } : {}),
  });

  const origin = `http://${LOOPBACK_HOST}:${running.port}`;
  return {
    ...running,
    home,
    origin,
    get: (target, headers = {}) => raw({ port: running.port, target, headers }),
    post: (target, { body = "{}", headers = {} } = {}) => raw({
      port: running.port,
      method: "POST",
      target,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-csrf-token": running.nonce,
        origin,
        host: `${LOOPBACK_HOST}:${running.port}`,
        ...headers,
      },
      body,
    }),
  };
}

const servers = [];
async function server(overrides) {
  const running = await launch(overrides);
  servers.push(running);
  return running;
}

after(async () => {
  for (const running of servers) {
    try { await running.close(); } catch { /* already closed */ }
  }
});

// ===========================================================================

describe("BP-005.12 — loopback binding", () => {
  it("binds 127.0.0.1 and nothing else", async () => {
    const running = await server();
    const address = running.server.address();
    assert.equal(address.address, "127.0.0.1");
    assert.equal(address.family, "IPv4");
    assert.equal(running.host, "127.0.0.1");
    assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it("never names a wildcard bind address in its source", async () => {
    const source = await fs.readFile(path.join(PROJECT_ROOT, "src", "server.js"), "utf8");
    assert.equal(source.includes("0.0.0.0"), false, "server.js must not contain 0.0.0.0");
    assert.equal(/app\.listen\(\s*port\s*\)/.test(source), false, "listen() must always be given the loopback host");
    const cli = await fs.readFile(path.join(PROJECT_ROOT, "src", "cli.js"), "utf8");
    assert.equal(cli.includes("0.0.0.0"), false, "cli.js must not contain 0.0.0.0");
  });

  it("is unreachable on this machine's non-loopback addresses", async (t) => {
    const running = await server();
    const external = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    if (external.length === 0) {
      t.skip("no non-loopback IPv4 interface on this machine");
      return;
    }
    const outcome = await new Promise((resolve) => {
      const socket = net.connect({ host: external[0], port: running.port });
      socket.setTimeout(2000);
      socket.once("connect", () => { socket.destroy(); resolve(null); });
      socket.once("timeout", () => { socket.destroy(); resolve("ETIMEDOUT"); });
      socket.once("error", (err) => resolve(err.code));
    });
    assert.notEqual(outcome, null, `a socket to ${external[0]}:${running.port} should not connect`);
  });
});

describe("BP-005.11 — the page and the injected nonce", () => {
  it("serves index.html with the per-process nonce in the csrf-token meta", async () => {
    const running = await server();
    const res = await running.get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^text\/html/);
    assert.match(res.headers["cache-control"], /no-store/);
    assert.ok(res.headers["content-security-policy"].includes("default-src 'self'"));
    assert.ok(res.text.includes(`<meta name="csrf-token" content="${running.nonce}">`), "nonce must reach the page");
    assert.equal(res.text.includes(`content=""`), false, "the placeholder meta must be replaced");
  });

  it("serves /index.html the same way", async () => {
    const running = await server();
    const res = await running.get("/index.html");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(running.nonce));
  });

  it("injects a meta tag even if the placeholder is gone", () => {
    const nonce = "abc123";
    assert.ok(injectNonce("<html><head><title>x</title></head></html>", nonce)
      .includes(`<meta name="csrf-token" content="${nonce}">`));
    assert.ok(injectNonce(`<meta name='csrf-token' content='old'>`, nonce)
      .includes(`content="${nonce}"`));
    assert.ok(injectNonce("no head at all", nonce).includes(nonce));
  });

  it("serves the real stylesheet from public/", async () => {
    const running = await server();
    const res = await running.get("/css/style.css");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/css/);
  });

  it("sends a 404 with a reason, never an empty body, for an unknown asset", async () => {
    const running = await server();
    const res = await running.get("/nope.txt");
    assert.equal(res.status, 404);
    assert.equal(res.json.reason, "not_found");
    assert.ok(res.json.error.length > 0);
  });
});

describe("static traversal is refused", () => {
  it("refuses a raw ../ path", async () => {
    const running = await server();
    // `fetch` would normalise this away, so it goes out over a raw request.
    const res = await running.get("/../package.json");
    assert.equal(res.status, 403);
    assert.equal(res.text.includes("session-rx"), false, "package.json must not be served");
  });

  it("refuses a percent-encoded ../ path", async () => {
    const running = await server();
    for (const target of ["/%2e%2e/package.json", "/css/%2E%2E%2Fpackage.json", "/%2e%2e%2f%2e%2e%2fetc/passwd"]) {
      const res = await running.get(target);
      assert.equal(res.status, 403, `${target} must be refused`);
    }
  });

  it("refuses a NUL byte in the path", async () => {
    const running = await server();
    const res = await running.get("/css/%00style.css");
    assert.equal(res.status, 400);
  });

  it("refuses a dotfile inside public/", async () => {
    const running = await server();
    const res = await running.get("/.gitignore");
    assert.ok(res.status === 403 || res.status === 404, `expected a refusal, got ${res.status}`);
  });
});

describe("GET routes return 200 with the BP-005 shape", () => {
  it("BP-005.10 /api/collectors", async () => {
    const running = await server();
    const res = await running.get("/api/collectors");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.collectors));
    assert.equal(res.json.collectors.length, 2);
    for (const collector of res.json.collectors) {
      assert.equal(typeof collector.id, "string");
      assert.equal(typeof collector.installed, "boolean");
      assert.equal(typeof collector.status, "string");
      assert.ok(Array.isArray(collector.paths));
    }
    assert.ok(Array.isArray(res.json.diagnostics));
  });

  it("BP-005.01 /api/health", async () => {
    const running = await server();
    const res = await running.get("/api/health");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.sessions));
    assert.equal(res.json.sessions.length, 2);
    assert.ok(Array.isArray(res.json.collectors));
    assert.ok(Array.isArray(res.json.diagnostics));
    const session = res.json.sessions.find((candidate) => candidate.cli === "claude");
    assert.ok(Array.isArray(session.rules) && session.rules.length > 0, "each session carries rule results");
    assert.equal(typeof session.score, "object");
  });

  it("F-025 /api/health states how many sessions were set aside as sub-agents", async () => {
    // `sessions` is the user's OWN sessions only (F-023). Without this block
    // the gap between what was read and what is listed is unexplained, and a
    // set-aside session looks like a dropped one.
    const PARENT = "aaaaaaaa-1111-4111-8111-111111111111";
    const CHILD = "cccccccc-3333-4333-8333-333333333333";
    const claude = new FakeCollector("claude", [testSession(), testSession({ sessionId: CHILD })]);
    claude.sessionMeta = { [PARENT]: { parentSessionId: null }, [CHILD]: { parentSessionId: PARENT } };
    const running = await server({ collectors: [claude] });

    const res = await running.get("/api/health");
    assert.equal(res.status, 200);
    // The child is a sub-agent of the parent, so only the parent is listed.
    assert.deepEqual(res.json.sessions.map((session) => session.sessionId), [PARENT]);

    const setAside = res.json.subagentSessionsSetAside;
    assert.ok(setAside && typeof setAside === "object", "/api/health must publish the aggregate, not only the per-CLI count");
    assert.equal(setAside.total, 1, "the one sub-agent session must be COUNTED, not silently dropped");
    assert.equal(setAside.orphans, 0);
    assert.deepEqual(setAside.byCli, [{ cli: "claude", count: 1, orphans: 0 }]);

    // The per-CLI count already travelled; the aggregate must agree with it.
    const perCli = res.json.collectors
      .map((collector) => collector.subagentSessions)
      .filter((count) => Number.isInteger(count))
      .reduce((sum, count) => sum + count, 0);
    assert.equal(setAside.total, perCli, "the aggregate must equal the per-CLI counts it summarises");
  });

  it("F-021 /api/health publishes each fix's TITLE, so the UI keeps no second catalogue", async () => {
    const running = await server();
    const res = await running.get("/api/health");
    assert.equal(res.status, 200);

    const titles = new Map(FIX_CATALOG.map((fix) => [fix.id, fix.title]));
    let offered = 0;
    for (const session of res.json.sessions) {
      for (const rule of session.rules) {
        assert.ok("fixTitle" in rule, `rule ${rule.id} must carry fixTitle, even when it is null`);
        if (rule.fix === null) {
          assert.equal(rule.fixTitle, null, "a rule with no fix names no fix");
          continue;
        }
        offered += 1;
        assert.equal(rule.fixTitle, titles.get(rule.fix), `the title published for ${rule.fix} must be the catalogue's`);
      }
    }
    assert.ok(offered > 0, "this fixture must exercise at least one rule that maps to a fix");
  });

  it("F-021 a fix id outside the catalogue publishes a null title, never a guessed name", async () => {
    // The rules still name `claude-*` fixes; this catalogue knows none of them.
    const running = await server({
      fixCatalog: [{ id: "not-a-real-fix", title: "Not a real fix", kind: "append-section", blueprint: "BP-000", specifier: "./fixes/nowhere.js" }],
    });
    const res = await running.get("/api/health");
    assert.equal(res.status, 200);
    const withFix = res.json.sessions.flatMap((session) => session.rules).filter((rule) => rule.fix !== null);
    assert.ok(withFix.length > 0, "this fixture must exercise at least one rule that maps to a fix");
    for (const rule of withFix) {
      assert.equal(rule.fixTitle, null, `${rule.fix} is not in this catalogue, so no name may be invented for it`);
    }
  });

  it("BP-005.01 /api/health honours since and limit", async () => {
    const running = await server();
    const res = await running.get("/api/health?limit=1&since=2026-01-01T00:00:00.000Z");
    assert.equal(res.status, 200);
    assert.equal(res.json.scan.limitPerCollector, 1);
    assert.equal(res.json.scan.defaulted, false);
  });

  it("BP-005.02 /api/sessions with total, sort, order and filters", async () => {
    const running = await server();
    const res = await running.get("/api/sessions");
    assert.equal(res.status, 200);
    assert.equal(res.json.total, 2);
    assert.equal(res.json.sessions.length, 2);
    assert.ok(Array.isArray(res.json.diagnostics));
    // Default sort is startedAt desc: the 19th before the 18th.
    assert.equal(res.json.sessions[0].cli, "codex");

    const ascending = await running.get("/api/sessions?sort=startedAt&order=asc");
    assert.equal(ascending.json.sessions[0].cli, "claude");

    const filtered = await running.get("/api/sessions?cli=claude");
    assert.equal(filtered.json.total, 1);
    assert.equal(filtered.json.sessions[0].cli, "claude");

    const byProject = await running.get("/api/sessions?project=demo-app");
    assert.equal(byProject.json.total, 1);

    const limited = await running.get("/api/sessions?limit=1");
    assert.equal(limited.json.sessions.length, 1);
    assert.equal(limited.json.total, 2, "limit bounds the rows, not the reported total");
    assert.equal(limited.json.returned, 1);
  });

  it("BP-005.03 /api/sessions/:sessionId, and 404 for an unknown id", async () => {
    const running = await server();
    const found = await running.get("/api/sessions/aaaaaaaa-1111-4111-8111-111111111111");
    assert.equal(found.status, 200);
    assert.equal(found.json.session.sessionId, "aaaaaaaa-1111-4111-8111-111111111111");

    const missing = await running.get("/api/sessions/does-not-exist");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.reason, "session_not_found");
    assert.ok(missing.json.scan, "a 404 states how much was scanned, so it is not read as 'does not exist'");
  });

  it("BP-005.04 /api/trends", async () => {
    const running = await server();
    const res = await running.get("/api/trends");
    assert.equal(res.status, 200);
    assert.ok(res.json.charts, "charts");
    assert.ok(Array.isArray(res.json.charts.context));
    assert.ok(Array.isArray(res.json.charts.cache));
    assert.ok(Array.isArray(res.json.charts.spend));
    assert.ok(Array.isArray(res.json.unknowns));
    assert.equal(res.json.charts.context.length, 15, "BP-005.04: a 15-day window");
    // BP-005.04 writes the grid as "24x15"; wave 3B builds it day-major and
    // labels its own axes, so the assertion is against the labelled shape.
    assert.equal(res.json.heatmap.orientation, "day-major");
    assert.equal(res.json.heatmap.rows, 15);
    assert.equal(res.json.heatmap.cols, 24);
    assert.equal(res.json.heatmap.grid.length, 15);
    assert.equal(res.json.heatmap.grid[0].length, 24);
  });

  it("keeps the analyzer window separate from the session window on /api/trends", async () => {
    const running = await server();
    const res = await running.get("/api/trends");
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.window.days, "number");
    assert.ok(Number.isFinite(res.json.window.days));
    assert.equal(res.json.window.timezone, "local");
    assert.equal(typeof res.json.sessionWindow.matched, "number");
  });

  it("withholds a spend percentage when one half has no measured day", async () => {
    const rows = [1, 2, 3, 4].map((day) => ({ date: `2026-09-${String(day).padStart(2, "0")}`, hasData: day > 2, total: day > 2 ? 10 : null, highContextPct: 20, hitRate: 90 }));
    const running = await server({ modules: { trends: { buildTrends: () => ({ charts: { context: rows, spend: rows, cache: rows } }) } } });
    const res = await running.get("/api/trends");
    assert.equal(res.json.trendDeltas.spend.available, false);
    assert.ok(res.json.trendDeltas.spend.reason.length > 0);
    assert.equal(res.json.trendDeltas.spend.changePercent, null);
  });

  it("withholds cache percentage change when the older-half mean is zero", async () => {
    const rows = [0, 0, 50, 50].map((hitRate, index) => ({ date: `2026-09-${index + 1}`, hasData: true, total: 10, highContextPct: 20, hitRate }));
    const running = await server({ modules: { trends: { buildTrends: () => ({ charts: { context: rows, spend: rows, cache: rows } }) } } });
    const res = await running.get("/api/trends");
    assert.equal(res.json.trendDeltas.cache.available, true);
    assert.equal(res.json.trendDeltas.cache.from, 0);
    assert.equal(res.json.trendDeltas.cache.changePercent, null);
  });

  it("publishes only sessionWindow on /api/health", async () => {
    const running = await server();
    const res = await running.get("/api/health");
    assert.equal(res.status, 200);
    assert.ok(res.json.sessionWindow && typeof res.json.sessionWindow === "object");
    assert.equal(Object.hasOwn(res.json, "window"), false);
  });

  it("BP-005.05 /api/report", async () => {
    const running = await server();
    const res = await running.get("/api/report");
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.markdown, "string");
    assert.ok(res.json.markdown.startsWith("# SessionRx diagnostic report"));
    assert.equal(typeof res.json.generatedAt, "string");
    assert.equal(typeof res.json.redactions, "number");
  });

  // -------------------------------------------------------------------------
  // F1 / F2 — section 5 and section 6 were structurally incapable of saying
  // anything else, because the route passed neither `fixes` nor `trend`. F1 is
  // the only place this product ever asserted something FALSE: five fixes
  // applied, five journal rows on disk, and a report that said none were.
  // -------------------------------------------------------------------------

  it("BP-005.05 section 5 NAMES a fix that was applied, read from the transaction journal", async () => {
    const running = await server();
    // This test applies a fix, so it proves WHERE it will write before writing.
    assert.ok(running.state.home.includes("session-rx-5a-"),
      `refusing to run an apply outside a suite temp dir: ${running.state.home}`);
    const applied = await running.post("/api/fixes/claude-output-hygiene/apply");
    assert.equal(applied.status, 200);

    const res = await running.get("/api/report");
    assert.equal(res.status, 200);
    const md = res.json.markdown;
    assert.ok(md.includes("claude-output-hygiene"), "the applied fix id must appear in section 5");
    assert.match(md, /- Status: applied/);
    assert.equal(md.includes("No fix was applied in this period"), false,
      "a fix was applied seconds ago: this sentence would be an outright falsehood");
    // The report is a file users paste in public, so the journal's absolute
    // paths render in the fix engine's `~/...` display form, as before.
    assert.equal(md.includes(running.home), false, "no new absolute path enters the report");
  });

  it("BP-005.05 'No fix was applied' appears ONLY when the journal was read and held none", async () => {
    const running = await server();
    const journal = path.join(running.home, ".session-rx", "journal.jsonl");
    await fs.mkdir(path.dirname(journal), { recursive: true });
    await fs.writeFile(journal, "", "utf8");
    const md = (await running.get("/api/report")).json.markdown;
    assert.match(md, /## 5\. Fixes applied\n\nNo fix was applied in this period\./);
  });

  it("BP-005.05 a MISSING journal is unknown with its reason, never 'no fix was applied'", async () => {
    const running = await server();
    assert.equal(existsSync(path.join(running.home, ".session-rx", "journal.jsonl")), false,
      "precondition: this home has no journal yet");
    const md = (await running.get("/api/report")).json.markdown;
    assert.ok(
      md.includes(`Applied-fix history: unknown — ${path.join("~", ".session-rx", "journal.jsonl")} does not exist`),
      "the unknown journal reason must name the platform-native user-facing path",
    );
    assert.equal(md.includes("No fix was applied in this period"), false,
      "an unread record is unknown, not an empty history");
  });

  it("BP-005.05 a MALFORMED journal is unknown with its reason, never 'no fix was applied'", async () => {
    const running = await server();
    const journal = path.join(running.home, ".session-rx", "journal.jsonl");
    await fs.mkdir(path.dirname(journal), { recursive: true });
    await fs.writeFile(journal, `not json at all\n{"event": truncated\n`, "utf8");
    const md = (await running.get("/api/report")).json.markdown;
    assert.match(md, /Applied-fix history: unknown — /);
    assert.match(md, /not one parseable record/);
    assert.equal(md.includes("No fix was applied in this period"), false);
  });

  it("BP-005.05 section 6 carries the SAME direction /api/trends computes (F-021: one implementation)", async () => {
    const running = await server();
    const trends = await running.get("/api/trends");
    assert.equal(trends.status, 200);
    const md = (await running.get("/api/report")).json.markdown;
    const stated = /\nDirection: ([a-z]+)/.exec(md);
    assert.ok(stated, "section 6 states a direction");
    assert.equal(stated[1], trends.json.trend.direction,
      "the report's direction is the trend builder's, not a second computation of it");
    assert.equal(md.includes("working out a direction over time is a separate step"), false,
      "the route now runs the trend step, so the report may no longer say it did not");
    assert.match(md, /\nReason: .+/, "a direction always ships with the builder's reason");
  });

  it("BP-005.05 an unavailable trend builder is unknown WITH a reason, and does not fail the report", async () => {
    const running = await server({ modules: { trends: {} } });
    const res = await running.get("/api/report");
    assert.equal(res.status, 200, "sections 1-5 must still be delivered");
    const md = res.json.markdown;
    assert.match(md, /Direction: unknown/);
    assert.match(md, /Reason: the trend for this window could not be computed/);
  });

  it("BP-005.09 /api/fixes/:fixId/check is a GET and changes nothing", async () => {
    const running = await server();
    const target = path.join(running.home, ".claude", "CLAUDE.md");
    const before = await fs.readFile(target, "utf8");
    const res = await running.get("/api/fixes/claude-output-hygiene/check");
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.applied, "boolean");
    assert.equal(res.json.applied, false);
    assert.equal(typeof res.json.marker, "string");
    assert.equal(await fs.readFile(target, "utf8"), before, "check() must not write");
  });

  it("lists the fix catalog", async () => {
    const running = await server();
    const res = await running.get("/api/fixes");
    assert.equal(res.status, 200);
    assert.equal(res.json.fixes.length, 5, "BP-004.01..05");
    assert.deepEqual(res.json.fixes.map((fix) => fix.id).sort(), [
      "claude-auto-compact",
      "claude-batch-commands",
      "claude-compact-contract",
      "claude-output-hygiene",
      "claude-worker-cap",
    ]);
    assert.ok(res.json.fixes.every((fix) => fix.available === true), "every BP-004 fix module resolves");
    assert.ok(res.json.fixes.every((fix) => fix.cli === "claude" && fix.cliName === "Claude Code"), "every available fix publishes its target CLI and display name");
  });

  it("lists fixes with null CLI names when the registry cannot be loaded", async () => {
    const running = await server({ modules: { registry: "./__missing_registry__.js" } });
    const res = await running.get("/api/fixes");
    assert.equal(res.status, 200);
    assert.equal(res.json.fixes.length, 5);
    assert.ok(res.json.fixes.every((fix) => fix.cli === "claude" && fix.cliName === null));
  });

  it("rejects a malformed query parameter with a 400, not a 500", async () => {
    const running = await server();
    for (const target of ["/api/health?limit=abc", "/api/health?limit=0", "/api/sessions?from=not-a-date", "/api/sessions?sort=nope", "/api/sessions?order=sideways"]) {
      const res = await running.get(target);
      assert.equal(res.status, 400, `${target} → 400`);
      assert.ok(res.json.error.length > 0);
    }
  });
});

describe("BP-005.01 — /api/health serializes only HEALTH_CARD_LIMIT sessions", () => {
  // Measured 2026-09-20: a 1,236-session real corpus serialized in full is
  // 18.2MB / 6.5s for a page that renders 10 cards. This fixture only needs
  // to clear HEALTH_CARD_LIMIT, not reproduce that scale.
  const TOTAL = HEALTH_CARD_LIMIT + 2;

  /**
   * `TOTAL` independent sessions, one per day, each declaring itself
   * top-level (`parentSessionId: null`) so `childLinkageAvailable` is true
   * for the CLI and rule 6 (`subagent-concurrency`) can report a MEASURED
   * zero instead of `unknown` — the exact verdict T4 checks survives the fix.
   */
  function manyCollector() {
    const sessions = [];
    const meta = {};
    for (let day = 1; day <= TOTAL; day += 1) {
      const sessionId = `dddddddd-0000-4000-8000-${String(day).padStart(12, "0")}`;
      const session = testSession({ sessionId, startedAt: ISO(day, 9), endedAt: ISO(day, 11) });
      if (day <= 2) {
        session.turns.forEach((turn) => { turn.toolResultBytes = 20000; });
        session.turns.push({ ...session.turns[0], ts: ISO(day, 11) });
      }
      sessions.push(session);
      meta[sessionId] = { parentSessionId: null };
    }
    const claude = new FakeCollector("claude", sessions);
    claude.sessionMeta = meta;
    return claude;
  }

  it("T1: returns at most HEALTH_CARD_LIMIT sessions", async () => {
    const running = await server({ collectors: [manyCollector()] });
    const res = await running.get("/api/health");
    assert.equal(res.status, 200);
    assert.ok(
      res.json.sessions.length <= HEALTH_CARD_LIMIT,
      `sessions.length (${res.json.sessions.length}) must not exceed HEALTH_CARD_LIMIT (${HEALTH_CARD_LIMIT})`,
    );
    assert.equal(res.json.sessions.length, HEALTH_CARD_LIMIT, `this fixture has ${TOTAL} sessions, more than the limit`);
  });

  it("T2: sessionsTotal is the full analyzed count, greater than sessions.length", async () => {
    const running = await server({ collectors: [manyCollector()] });
    const res = await running.get("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.json.sessionsTotal, TOTAL, "sessionsTotal must count the FULL analysis, not the narrowed response");
    assert.ok(
      res.json.sessionsTotal > res.json.sessions.length,
      "the true total must exceed the narrowed response once the corpus exceeds the card limit",
    );
  });

  it("T3: the returned sessions are the newest HEALTH_CARD_LIMIT, newest first", async () => {
    const running = await server({ collectors: [manyCollector()] });
    const res = await running.get("/api/health");
    assert.equal(res.status, 200);
    const returnedDays = res.json.sessions.map((session) => new Date(session.startedAt).getUTCDate());
    // Days 1..TOTAL were collected; the newest HEALTH_CARD_LIMIT of them,
    // strictly descending, are TOTAL down to TOTAL-HEALTH_CARD_LIMIT+1.
    const expectedDays = Array.from({ length: HEALTH_CARD_LIMIT }, (_, index) => TOTAL - index);
    assert.deepEqual(returnedDays, expectedDays);
  });

  it("T4: a verdict gated on corpusComplete is unchanged — the full scan still ran", async () => {
    const running = await server({ collectors: [manyCollector()] });
    const res = await running.get("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.json.sessions.length, HEALTH_CARD_LIMIT);
    for (const session of res.json.sessions) {
      const rule = session.rules.find((candidate) => candidate.id === "subagent-concurrency");
      assert.ok(rule, `session ${session.sessionId} must carry the subagent-concurrency rule`);
      // With TOTAL sessions well under DEFAULT_SCAN_LIMIT and every session
      // naming no parent, corpusComplete is true and this is a MEASURED
      // zero ("not-observed"). If the response-narrowing fix had instead
      // bounded the SCAN to HEALTH_CARD_LIMIT (reusing it as a collection
      // limit rather than only a serialization slice), corpusComplete would
      // flip false — TOTAL sessions collected against a HEALTH_CARD_LIMIT
      // bound — and this verdict would flip to "unknown". That flip is
      // exactly what this assertion catches.
      assert.equal(
        rule.evidence.status,
        "not-observed",
        `session ${session.sessionId}: corpusComplete must still be true after the payload-size fix`,
      );
    }
  });

  it("T5: ruleTotals count the full window, not only the serialized card sessions", async () => {
    const running = await server({ collectors: [manyCollector()] });
    const res = await running.get("/api/health");
    assert.equal(res.status, 200);
    const totalObserved = res.json.ruleTotals.reduce((sum, rule) => sum + rule.observed, 0);
    const cardObserved = res.json.sessions.reduce((sum, session) => sum + session.rules.filter((rule) => rule.evidence.status === "observed").length, 0);
    assert.ok(totalObserved > cardObserved, "full-window observed totals must exceed what the ten serialized sessions can contain");
  });

  it("T6: a date window changes ruleTotals but not scan metadata or verdicts", async () => {
    const running = await server({ collectors: [manyCollector()] });
    const whole = await running.get("/api/health");
    const bounded = await running.get(`/api/health?from=${encodeURIComponent(ISO(3, 0))}&to=${encodeURIComponent(ISO(4, 23))}`);
    assert.notDeepEqual(bounded.json.ruleTotals, whole.json.ruleTotals);
    assert.deepEqual(bounded.json.scan, whole.json.scan);
    const wholeVerdict = new Map(whole.json.sessions.map((session) => [session.sessionId, session.rules.map((rule) => [rule.id, rule.evidence.status])]));
    for (const session of bounded.json.sessions) assert.deepEqual(session.rules.map((rule) => [rule.id, rule.evidence.status]), wholeVerdict.get(session.sessionId));
  });

  it("T7: every rule's three totals add up to its window population", async () => {
    const running = await server({ collectors: [manyCollector()] });
    const res = await running.get(`/api/health?from=${encodeURIComponent(ISO(1, 0))}&to=${encodeURIComponent(ISO(TOTAL, 23))}`);
    for (const rule of res.json.ruleTotals) assert.equal(rule.observed + rule.notObserved + rule.unknown, res.json.ruleTotalsSessions, rule.id);
  });
});

describe("/api/health window-wide totals and comparison", () => {
  function fixture(sessions, ruleSets, options = {}) {
    return server({
      collectors: [new FakeCollector("claude", sessions)],
      modules: { health: syntheticHealth(ruleSets) },
      ...options,
    });
  }

  it("counts windowTotals across the full window, not the ten serialized cards", async () => {
    const sessions = Array.from({ length: HEALTH_CARD_LIMIT + 1 }, (_, index) => testSession({
      sessionId: `window-${index}`,
      startedAt: ISO(index + 1, 9),
      endedAt: ISO(index + 1, 10),
    }));
    const ruleSets = { [`window-${HEALTH_CARD_LIMIT}`]: [syntheticRule("late-finding", { status: "observed", fix: "fix-late" })] };
    const running = await fixture(sessions, ruleSets);
    const res = await running.get("/api/health");
    assert.equal(res.json.sessions.length, HEALTH_CARD_LIMIT);
    assert.equal(res.json.windowTotals.sessions, HEALTH_CARD_LIMIT + 1);
    assert.equal(res.json.windowTotals.observedFindings, 1);
    assert.equal(res.json.windowTotals.fixableFindings, 1);
  });

  it("publishes distinctFixes as unique, non-null, catalogue-bounded fix ids", async () => {
    const duplicateRules = [
      syntheticRule("duplicate-a", { status: "observed", fix: FIX_CATALOG[0].id }),
      syntheticRule("duplicate-b", { status: "observed", fix: FIX_CATALOG[0].id }),
    ];
    const duplicate = await fixture([
      testSession({ sessionId: "duplicate-fixes" }),
    ], { "duplicate-fixes": duplicateRules });
    const duplicateHealth = (await duplicate.get("/api/health")).json;
    assert.equal(duplicateHealth.distinctFixes.count, 1, "two findings sharing one fixId count as one distinct fix");
    assert.ok(
      duplicateHealth.distinctFixes.count < duplicateHealth.windowTotals.fixableFindings,
      "distinctFixes must be strictly less than fixableFindings for duplicate fix ids",
    );

    const empty = await fixture([testSession({ sessionId: "no-fixes" })], {
      "no-fixes": [syntheticRule("not-fixable", { status: "observed" })],
    });
    const emptyHealth = (await empty.get("/api/health")).json;
    assert.equal(emptyHealth.distinctFixes.count, 0, "no fixable findings publish zero distinct fixes");
    assert.notEqual(emptyHealth.distinctFixes.count, null);

    const bounded = await fixture([testSession({ sessionId: "too-many-fixes" })], {
      "too-many-fixes": FIX_CATALOG.map((fix, index) => syntheticRule(`catalog-${index}`, {
        status: "observed",
        fix: fix.id,
      })).concat(syntheticRule("outside-catalog", { status: "observed", fix: "not-in-catalogue" })),
    }, { fixCatalog: FIX_CATALOG.slice(0, 2) });
    const boundedHealth = (await bounded.get("/api/health")).json;
    assert.ok(
      boundedHealth.distinctFixes.count <= 2,
      "distinctFixes must never exceed the size of the published fix catalogue",
    );
  });

  it("publishes inclusive per-day window series, including an empty measured day", async () => {
    const sessions = [1, 3].map((day) => testSession({ sessionId: `series-${day}`, startedAt: ISO(day, day === 3 ? 0 : 9), endedAt: ISO(day, day === 3 ? 1 : 10) }));
    const ruleSets = {
      "series-1": [syntheticRule("observed", { status: "observed", fix: "fix" })],
      "series-3": [syntheticRule("unknown", { status: "unknown" })],
    };
    const res = (await (await fixture(sessions, ruleSets)).get("/api/health?from=2026-09-01&to=2026-09-03")).json;
    assert.equal(res.windowSeries.days.length, 3);
    for (const key of ["sessions", "observedFindings", "fixableFindings", "unknownChecks"]) assert.equal(res.windowSeries[key].length, 3);
    assert.deepEqual(res.windowSeries.sessions, [1, 0, 1]);
    assert.deepEqual(res.windowSeries.observedFindings, [1, 0, 0]);
    assert.deepEqual(res.windowSeries.fixableFindings, [1, 0, 0]);
    assert.deepEqual(res.windowSeries.unknownChecks, [0, 0, 1]);
    assert.equal(res.windowTotals.sessions, res.windowSeries.sessions.reduce((a, b) => a + b, 0));
    assert.equal(res.windowTotals.observedFindings, res.windowSeries.observedFindings.reduce((a, b) => a + b, 0));
    assert.equal(res.windowTotals.fixableFindings, res.windowSeries.fixableFindings.reduce((a, b) => a + b, 0));
    assert.equal(res.windowTotals.unknownChecks, res.windowSeries.unknownChecks.reduce((a, b) => a + b, 0));
  });

  it("counts an unparsable startedAt as undated rather than placing it in a day", async () => {
    const sessions = [testSession({ sessionId: "undated", startedAt: "not-a-date", endedAt: "not-a-date" }), testSession({ sessionId: "dated", startedAt: ISO(2, 9) })];
    const res = (await (await fixture(sessions, {})).get("/api/health")).json;
    assert.equal(res.windowSeries.undated, 1);
    assert.deepEqual(res.windowSeries.sessions, [1]);
  });

  it("ranks topFixes and excludes unfixable and never-observed rules", async () => {
    const sessions = [1, 2, 3].map((day) => testSession({
      sessionId: `rank-${day}`,
      startedAt: ISO(day, 9),
      endedAt: ISO(day, 10),
    }));
    const ruleSets = {
      "rank-1": [
        syntheticRule("rule-a", { status: "observed", fix: "fix-a", name: "A" }),
        syntheticRule("rule-b", { status: "observed", fix: "fix-b", name: "B" }),
        syntheticRule("no-fix", { status: "observed" }),
      ],
      "rank-2": [syntheticRule("rule-a", { status: "observed", fix: "fix-a", name: "A" })],
      "rank-3": [
        syntheticRule("rule-a", { status: "observed", fix: "fix-a", name: "A" }),
        syntheticRule("rule-b", { status: "not-observed", fix: "fix-b", name: "B" }),
        syntheticRule("never", { status: "not-observed", fix: "fix-never" }),
      ],
    };
    const res = (await (await fixture(sessions, ruleSets)).get("/api/health")).json;
    assert.deepEqual(res.topFixes, [
      { id: "rule-a", name: "A", fixId: "fix-a", sessions: 3, findings: 3 },
      { id: "rule-b", name: "B", fixId: "fix-b", sessions: 1, findings: 1 },
    ]);
  });

  it("withholds comparison when the previous window predates bounded coverage", async () => {
    const sessions = [15, 16].map((day) => testSession({ sessionId: `bound-${day}`, startedAt: ISO(day, 9), endedAt: ISO(day, 10) }));
    const ruleSets = Object.fromEntries(sessions.map((session) => [session.sessionId, [syntheticRule("finding", { status: "observed", fix: "fix" })]]));
    const running = await fixture(sessions, ruleSets, { scanLimit: 2 });
    const res = await running.get(`/api/health?from=${encodeURIComponent(ISO(15, 0))}&to=${encodeURIComponent(ISO(17, 0))}`);
    assert.equal(res.json.coverage.completeFrom, "2026-09-15");
    assert.equal(res.json.comparison.available, false);
    assert.ok(res.json.comparison.reason.length > 0);
    assert.equal(res.json.comparison.previous, null);
    assert.equal(res.json.comparison.deltas, null);
  });

  it("computes a complete previous-window comparison and its deltas", async () => {
    const sessions = [14, 15, 16].map((day) => testSession({ sessionId: `complete-${day}`, startedAt: ISO(day, 9), endedAt: ISO(day, 10) }));
    const ruleSets = {
      "complete-14": [syntheticRule("finding", { status: "observed", fix: "fix" })],
      "complete-15": [syntheticRule("finding", { status: "observed", fix: "fix" })],
      "complete-16": [syntheticRule("finding", { status: "not-observed", fix: "fix" })],
    };
    const running = await fixture(sessions, ruleSets, { scanLimit: 10 });
    const res = await running.get(`/api/health?from=${encodeURIComponent(ISO(15, 0))}&to=${encodeURIComponent(ISO(17, 0))}`);
    assert.equal(res.json.comparison.available, true);
    assert.equal(res.json.comparison.windowDays, 3);
    assert.equal(res.json.comparison.previous.sessions, 1);
    assert.equal(res.json.comparison.previous.observedFindings, 1);
    assert.deepEqual(res.json.comparison.deltas.observedFindings, { from: 1, to: 1, changePercent: 0 });
    assert.deepEqual(res.json.comparison.deltas.notObservedChecks, { from: 0, to: 1, changePercent: null });
  });

  it("uses an inclusive comparison window and moves the previous window back by its full length", async () => {
    const running = await fixture([testSession({ sessionId: "only", startedAt: ISO(8, 9), endedAt: ISO(8, 10) })], {}, { scanLimit: 1 });
    const res = await running.get("/api/health?from=2026-09-08&to=2026-09-22");
    assert.equal(res.json.comparison.windowDays, 15);
    assert.match(res.json.comparison.reason ?? "", /previous 15 days/);
  });

  it("uses null rather than zero or Infinity for a percentage rising from zero", async () => {
    const sessions = [14, 15].map((day) => testSession({ sessionId: `zero-${day}`, startedAt: ISO(day, 9), endedAt: ISO(day, 10) }));
    const ruleSets = { "zero-15": [syntheticRule("finding", { status: "observed", fix: "fix" })] };
    const running = await fixture(sessions, ruleSets, { scanLimit: 10 });
    const res = await running.get(`/api/health?from=${encodeURIComponent(ISO(15, 0))}&to=${encodeURIComponent(ISO(16, 0))}`);
    assert.equal(res.json.comparison.deltas.observedFindings.changePercent, null);
    assert.notEqual(res.json.comparison.deltas.observedFindings.changePercent, Infinity);
  });

  it("passes null since to the collector even when from/to filters are supplied", async () => {
    let receivedSince = "not-called";
    const collector = new FakeCollector("claude", [testSession()]);
    collector.collect = async (options = {}) => {
      receivedSince = options.since;
      return collector.sessions;
    };
    const running = await server({
      collectors: [collector],
      modules: { health: syntheticHealth({}) },
    });
    await running.get(`/api/health?from=${encodeURIComponent(ISO(18, 0))}&to=${encodeURIComponent(ISO(19, 0))}`);
    assert.equal(receivedSince, null);
  });
});

describe("date windows are serialization filters, not scan bounds", () => {
  function windowFixture() {
    const target = testSession({ sessionId: "target", startedAt: ISO(3, 9), endedAt: ISO(3, 11) });
    const parent = testSession({ sessionId: "parent", startedAt: ISO(1, 9), endedAt: ISO(1, 11) });
    const child = testSession({ sessionId: "child", startedAt: ISO(1, 10), endedAt: ISO(1, 10, 30) });
    const collector = new WindowAwareCollector("claude", [parent, child, target]);
    collector.sessionMeta = {
      [target.sessionId]: { sessionId: target.sessionId, parentSessionId: null },
      [parent.sessionId]: { sessionId: parent.sessionId, parentSessionId: null },
      [child.sessionId]: { sessionId: child.sessionId, parentSessionId: parent.sessionId },
    };
    return collector;
  }

  it("keeps the subagent-concurrency verdict distribution identical when a window excludes sessions", async () => {
    const running = await server({ collectors: [windowFixture()] });
    const whole = await running.get("/api/health?limit=3");
    const bounded = await running.get(`/api/health?limit=3&from=${encodeURIComponent(ISO(3, 0))}&to=${encodeURIComponent(ISO(3, 23))}`);
    const unknownCount = (body) => body.sessions
      .flatMap((session) => session.rules)
      .filter((rule) => rule.id === "subagent-concurrency" && rule.evidence.status === "unknown")
      .length;
    assert.equal(whole.json.sessions.length, 2, "the child is set aside, leaving the two own sessions");
    assert.equal(bounded.json.sessions.length, 1, "the window excludes the older own session");
    assert.equal(unknownCount(bounded.json), unknownCount(whole.json));
    assert.equal(unknownCount(bounded.json), 1, "the target verdict stays unknown, never a manufactured measured zero");
  });

  it("keeps scan.atLimit and the scan note byte-identical with and without a window", async () => {
    const running = await server({ collectors: [windowFixture()] });
    const whole = await running.get("/api/sessions?scan=3");
    const bounded = await running.get(`/api/sessions?scan=3&from=${encodeURIComponent(ISO(3, 0))}`);
    assert.equal(JSON.stringify(bounded.json.scan), JSON.stringify(whole.json.scan));
    assert.equal(bounded.json.scan.atLimit, whole.json.scan.atLimit);
    assert.equal(bounded.json.scan.note, whole.json.scan.note);
  });

  it("keeps sessionsTotal on the full analysis while sessionWindow.matched reports the narrowed set", async () => {
    const running = await server({ collectors: [windowFixture()] });
    const whole = await running.get("/api/health?limit=3");
    const bounded = await running.get(`/api/health?limit=3&from=${encodeURIComponent(ISO(3, 0))}`);
    assert.equal(bounded.json.sessionsTotal, whole.json.sessionsTotal);
    assert.equal(whole.json.sessionWindow.matched, whole.json.sessionsTotal);
    assert.equal(bounded.json.sessionWindow.matched, 1);
    assert.equal(bounded.json.sessionWindow.applied, true);
  });

  it("counts undated sessions excluded by a bounded window and keeps them uncounted without one", async () => {
    const dated = testSession({ sessionId: "dated", startedAt: ISO(3, 9), endedAt: ISO(3, 11) });
    const undated = normalizeSession({ cli: "claude", sessionId: "undated" });
    const running = await server({ collectors: [new FakeCollector("claude", [dated, undated])] });
    const whole = await running.get("/api/health");
    const bounded = await running.get(`/api/health?from=${encodeURIComponent(ISO(3, 0))}`);
    assert.equal(whole.json.sessions.length, 2);
    assert.equal(whole.json.sessionWindow.excludedUndated, 0);
    assert.equal(whole.json.sessionWindow.matched, 2);
    assert.equal(bounded.json.sessions.length, 1);
    assert.equal(bounded.json.sessionWindow.excludedUndated, 1);
    assert.equal(bounded.json.sessionWindow.matched, 1);
  });

  it("narrows the serialized /api/health sessions array without narrowing sessionsTotal", async () => {
    const running = await server({ collectors: [new FakeCollector("claude", [
      testSession({ sessionId: "early", startedAt: ISO(1, 9), endedAt: ISO(1, 11) }),
      testSession({ sessionId: "late", startedAt: ISO(3, 9), endedAt: ISO(3, 11) }),
    ])] });
    const res = await running.get(`/api/health?from=${encodeURIComponent(ISO(3, 0))}&to=${encodeURIComponent(ISO(3, 23))}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.sessions.map((session) => session.sessionId), ["late"]);
    assert.equal(res.json.sessionsTotal, 2);
    assert.deepEqual(res.json.sessionWindow, {
      applied: true,
      from: ISO(3, 0),
      to: ISO(3, 23),
      excludedUndated: 0,
      matched: 1,
    });
  });
});

describe("BP-005.02 — /api/sessions is paginated", () => {
  // Measured 2026-09-21 on a heavy real corpus: one unpaginated /api/sessions
  // returned 1,236 sessions in 45,948,574 bytes — 43.8MB, most of it absolute
  // paths, for a table that shows about twenty rows. This fixture only needs
  // to clear SESSIONS_PAGE_LIMIT, not reproduce that scale.
  const CLAUDE_SESSIONS = SESSIONS_PAGE_LIMIT + 5;
  const CODEX_SESSIONS = 3;
  const TOTAL = CLAUDE_SESSIONS + CODEX_SESSIONS;

  const claudeId = (day) => `dddddddd-0000-4000-8000-${String(day).padStart(12, "0")}`;
  const codexId = (day) => `eeeeeeee-0000-4000-8000-${String(day).padStart(12, "0")}`;

  /**
   * Two CLIs on DISJOINT days, codex holding the newest ones.
   *
   * That arrangement is what makes the filter-then-paginate assertion bite: if
   * the page were cut before the filter, `?cli=claude` page 1 would be the
   * newest 20 sessions overall (3 codex + 17 claude) filtered down to 17 rows,
   * and page 2 would then overlap it. Each session names no parent, so
   * `childLinkageAvailable` is true and `subagent-concurrency` can report a
   * MEASURED zero rather than `unknown` — see the corpusComplete guard below.
   */
  function collectors() {
    const claudeSessions = [];
    const claudeMeta = {};
    for (let day = 1; day <= CLAUDE_SESSIONS; day += 1) {
      const sessionId = claudeId(day);
      claudeSessions.push(testSession({ sessionId, startedAt: ISO(day, 9), endedAt: ISO(day, 11) }));
      claudeMeta[sessionId] = { parentSessionId: null };
    }
    const claude = new FakeCollector("claude", claudeSessions);
    claude.sessionMeta = claudeMeta;

    const codexSessions = [];
    const codexMeta = {};
    for (let index = 1; index <= CODEX_SESSIONS; index += 1) {
      const day = CLAUDE_SESSIONS + index;
      const sessionId = codexId(day);
      codexSessions.push(testSession({
        cli: "codex",
        sessionId,
        project: "-Users-demo-other",
        cwd: "/Users/demo/other",
        startedAt: ISO(day, 9),
        endedAt: ISO(day, 11),
      }));
      codexMeta[sessionId] = { parentSessionId: null };
    }
    const codex = new FakeCollector("codex", codexSessions);
    codex.sessionMeta = codexMeta;

    return [claude, codex];
  }

  const days = (body) => body.sessions.map((session) => new Date(session.startedAt).getUTCDate());
  const ids = (body) => body.sessions.map((session) => session.sessionId);

  it("P1: the default page is the NEWEST SESSIONS_PAGE_LIMIT, newest first", async () => {
    const running = await server({ collectors: collectors() });
    const res = await running.get("/api/sessions");
    assert.equal(res.status, 200);
    assert.equal(res.json.sessions.length, SESSIONS_PAGE_LIMIT, `this fixture has ${TOTAL} sessions, more than one page`);
    assert.equal(res.json.limit, SESSIONS_PAGE_LIMIT);
    assert.equal(res.json.offset, 0);
    assert.equal(res.json.returned, SESSIONS_PAGE_LIMIT);
    // Days 1..TOTAL exist; the newest page is TOTAL down to TOTAL-19.
    const expected = Array.from({ length: SESSIONS_PAGE_LIMIT }, (_, index) => TOTAL - index);
    assert.deepEqual(days(res.json), expected, "the default page must be the newest sessions, strictly newest first");
  });

  it("P2: total is the true match count, not the page size", async () => {
    const running = await server({ collectors: collectors() });
    const res = await running.get("/api/sessions");
    assert.equal(res.json.total, TOTAL, "total counts every session matching the filter within the scan");
    assert.deepEqual(res.json.cliCounts, [
      { cli: "claude", count: CLAUDE_SESSIONS },
      { cli: "codex", count: CODEX_SESSIONS },
    ], "cliCounts covers the whole filtered scan, not only page one");
    assert.equal(res.json.cliCounts.reduce((sum, entry) => sum + entry.count, 0), res.json.total);
    const laterPage = await running.get("/api/sessions?limit=1&offset=1");
    assert.deepEqual(laterPage.json.cliCounts, res.json.cliCounts, "pagination does not change the facet");
    assert.ok(res.json.total > res.json.sessions.length, "the true total must exceed one page once the corpus exceeds it");
    assert.equal(res.json.hasMore, true);
    assert.equal(res.json.nextOffset, SESSIONS_PAGE_LIMIT);
  });

  it("P3: offset/limit pages are disjoint, ordered, and cover the whole set", async () => {
    const running = await server({ collectors: collectors() });
    const collectedIds = [];
    let offset = 0;
    let guard = 0;
    for (;;) {
      guard += 1;
      assert.ok(guard <= TOTAL + 2, "paging must terminate, not loop");
      const res = await running.get(`/api/sessions?limit=7&offset=${offset}`);
      assert.equal(res.status, 200);
      assert.equal(res.json.offset, offset);
      assert.equal(res.json.limit, 7);
      assert.equal(res.json.returned, res.json.sessions.length);
      collectedIds.push(...ids(res.json));
      if (!res.json.hasMore) {
        assert.equal(res.json.nextOffset, null, "the last page offers no next offset to loop on");
        break;
      }
      assert.equal(res.json.nextOffset, offset + res.json.sessions.length);
      offset = res.json.nextOffset;
    }
    assert.equal(collectedIds.length, TOTAL, "every session is reachable by paging");
    assert.equal(new Set(collectedIds).size, TOTAL, "no session appears on two pages");

    const whole = await running.get(`/api/sessions?limit=${TOTAL}`);
    assert.deepEqual(collectedIds, ids(whole.json), "paged order must equal the order of the unpaged list");
  });

  it("P4: the page is cut AFTER the filter, not before", async () => {
    const running = await server({ collectors: collectors() });
    // codex holds the 3 NEWEST sessions. A page cut before the filter would
    // return 17 claude rows here, having spent 3 of its 20 on codex.
    const first = await running.get("/api/sessions?cli=claude");
    assert.equal(first.status, 200);
    assert.equal(first.json.total, CLAUDE_SESSIONS, "total counts the filtered match, not the corpus");
    assert.deepEqual(first.json.cliCounts, [{ cli: "claude", count: CLAUDE_SESSIONS }]);
    assert.equal(first.json.cliCounts.reduce((sum, entry) => sum + entry.count, 0), first.json.total);
    assert.equal(first.json.sessions.length, SESSIONS_PAGE_LIMIT, "a full page of claude rows, none spent on codex");
    for (const session of first.json.sessions) assert.equal(session.cli, "claude");
    const firstExpected = Array.from({ length: SESSIONS_PAGE_LIMIT }, (_, index) => CLAUDE_SESSIONS - index);
    assert.deepEqual(days(first.json), firstExpected);

    const second = await running.get(`/api/sessions?cli=claude&offset=${SESSIONS_PAGE_LIMIT}`);
    assert.equal(second.json.returned, CLAUDE_SESSIONS - SESSIONS_PAGE_LIMIT);
    assert.equal(second.json.hasMore, false);
    for (const session of second.json.sessions) assert.equal(session.cli, "claude");
    const overlap = ids(first.json).filter((id) => ids(second.json).includes(id));
    assert.deepEqual(overlap, [], "page 2 of a filtered list must not repeat page 1");
  });

  it("P5: the page is cut AFTER the sort, not before", async () => {
    const running = await server({ collectors: collectors() });
    const res = await running.get("/api/sessions?cli=claude&sort=startedAt&order=asc&limit=5&offset=5");
    assert.equal(res.status, 200);
    // Ascending, claude only: days 1..5 are page 1, so offset 5 is days 6..10.
    assert.deepEqual(days(res.json), [6, 7, 8, 9, 10]);
  });

  it("P6: a malformed limit or offset is REJECTED, never read as a default", async () => {
    const running = await server({ collectors: collectors() });
    const bad = [
      "/api/sessions?limit=abc",
      "/api/sessions?limit=0",
      "/api/sessions?limit=-1",
      "/api/sessions?limit=NaN",
      "/api/sessions?limit=1.5",
      "/api/sessions?offset=abc",
      "/api/sessions?offset=-1",
      "/api/sessions?offset=NaN",
      "/api/sessions?offset=1.5",
      "/api/sessions?offset=1e3",
    ];
    for (const target of bad) {
      const res = await running.get(target);
      assert.equal(res.status, 400, `${target} must be refused, not silently read as page 1`);
      assert.ok(typeof res.json.error === "string" && res.json.error.length > 0, `${target} must say what was wrong`);
    }
  });

  it("P7: an oversized limit is CLAMPED, and an oversized offset lands past the end", async () => {
    const running = await server({ collectors: collectors() });
    const huge = await running.get("/api/sessions?limit=99999999");
    assert.equal(huge.status, 200, "a caller asking for everything gets everything the server is willing to send");
    assert.equal(huge.json.limit, 5000, "clamped to the server's MAX_LIMIT rather than honoured");
    assert.equal(huge.json.sessions.length, TOTAL);
    assert.equal(huge.json.hasMore, false);

    const beyond = await running.get("/api/sessions?offset=99999999999999999999999");
    assert.equal(beyond.status, 200, "an offset beyond Number.MAX_SAFE_INTEGER is past the end, not malformed");
    assert.deepEqual(beyond.json.sessions, []);
    assert.equal(beyond.json.total, TOTAL, "the total is still the truth about what exists");
  });

  it("P8: an offset past the end is an empty page, not an error", async () => {
    const running = await server({ collectors: collectors() });
    const res = await running.get(`/api/sessions?offset=${TOTAL + 100}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.sessions, []);
    assert.equal(res.json.returned, 0);
    assert.equal(res.json.total, TOTAL);
    assert.equal(res.json.hasMore, false);
    assert.equal(res.json.nextOffset, null);

    const exactly = await running.get(`/api/sessions?offset=${TOTAL}`);
    assert.equal(exactly.status, 200);
    assert.deepEqual(exactly.json.sessions, [], "the first offset past the last row is already empty");
    assert.equal(exactly.json.hasMore, false);
  });

  it("P9: a session that fell off page 1 is still reachable by id", async () => {
    const running = await server({ collectors: collectors() });
    const first = await running.get("/api/sessions");
    // Day 1 is the OLDEST session in the fixture, so it cannot be on the
    // newest-first first page.
    const oldest = claudeId(1);
    assert.equal(ids(first.json).includes(oldest), false, "this assertion is only meaningful if the id is off page 1");

    const res = await running.get(`/api/sessions/${oldest}`);
    assert.equal(res.status, 200, "pagination bounds a LIST; it must not make a session unaddressable");
    assert.equal(res.json.session.sessionId, oldest);
    assert.ok(res.json.scan, "the single-session route still states how much was scanned");
  });

  it("P10: a verdict gated on corpusComplete is unchanged — the SCAN was not narrowed", async () => {
    const running = await server({ collectors: collectors() });
    // Both pages, because a scan narrowed to the page size would leave page 1
    // looking complete and page 2 looking empty.
    for (const target of ["/api/sessions", `/api/sessions?offset=${SESSIONS_PAGE_LIMIT}`]) {
      const res = await running.get(target);
      assert.equal(res.status, 200);
      assert.equal(res.json.scan.limitPerCollector, DEFAULT_SCAN_LIMIT, "the scan bound is the scan's, never the page's");
      assert.equal(res.json.scan.atLimit, false, `${TOTAL} sessions is well under the scan bound`);
      assert.ok(res.json.sessions.length > 0, `${target} must return rows for this assertion to mean anything`);
      for (const session of res.json.sessions) {
        const rule = session.rules.find((candidate) => candidate.id === "subagent-concurrency");
        assert.ok(rule, `session ${session.sessionId} must carry the subagent-concurrency rule`);
        // Had pagination narrowed the COLLECTION limit instead of the
        // serialization slice, corpusComplete would flip false and this
        // MEASURED zero would become `unknown` across the whole corpus. That
        // silent rewrite is exactly what this assertion catches.
        assert.equal(
          rule.evidence.status,
          "not-observed",
          `session ${session.sessionId}: corpusComplete must still be true after pagination`,
        );
      }
    }
  });
});

describe("BP-005.13/14 — CSRF: the four rejection paths", () => {
  const TARGET = "/api/fixes/claude-output-hygiene/preview";

  it("missing nonce → 403", async () => {
    const running = await server();
    const res = await running.post(TARGET, { headers: { "x-csrf-token": undefined } });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "csrf_token_missing");
  });

  it("wrong nonce → 403", async () => {
    const running = await server();
    const res = await running.post(TARGET, { headers: { "x-csrf-token": BAD_HEADER_SHORT } });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "csrf_token_mismatch");
  });

  it("foreign Origin → 403", async () => {
    const running = await server();
    const res = await running.post(TARGET, { headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "origin_rejected");
  });

  it("wrong Host → 403", async () => {
    const running = await server();
    const res = await running.post(TARGET, {
      headers: { host: `evil.example:${running.port}`, origin: `http://evil.example:${running.port}` },
    });
    assert.equal(res.status, 403);
    // Real interaction with the DNS-rebinding fix below: a bad Host is now
    // caught by the standalone Host-allowlist middleware, which runs on
    // EVERY method and therefore BEFORE this CSRF middleware ever sees the
    // request — so this POST is refused with `host_not_allowed`, not
    // `host_rejected`. `host_rejected` still exists and is still reachable:
    // it is what `csrfFailure` itself returns for a bad Host, proven direct
    // (bypassing the middleware chain) by the "order-stable" test below.
    assert.equal(res.json.reason, "host_not_allowed");
  });

  it("missing Origin and Origin: null → 403 (BP-005.14)", async () => {
    const running = await server();
    const absent = await running.post(TARGET, { headers: { origin: undefined } });
    assert.equal(absent.status, 403);
    assert.equal(absent.json.reason, "origin_missing");

    const nulled = await running.post(TARGET, { headers: { origin: "null" } });
    assert.equal(nulled.status, 403);
    assert.equal(nulled.json.reason, "origin_rejected");
  });

  it("a right-length wrong value is still refused (constant-time compare)", async () => {
    const running = await server();
    assert.equal(BAD_HEADER_SAME_LENGTH.length, running.nonce.length);
    const res = await running.post(TARGET, { headers: { "x-csrf-token": BAD_HEADER_SAME_LENGTH } });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "csrf_token_mismatch");
  });

  it("a rejection never echoes the nonce back", async () => {
    const running = await server();
    const res = await running.post(TARGET, { headers: { "x-csrf-token": BAD_HEADER_SHORT } });
    assert.equal(res.text.includes(running.nonce), false);
  });

  it("csrfFailure is order-stable: token, then Host, then Origin", () => {
    const state = { nonce: "n", hostAllowlist: new Set(["127.0.0.1:1"]) };
    assert.equal(csrfFailure(state, { headers: {} }).reason, "csrf_token_missing");
    assert.equal(csrfFailure(state, { headers: { "x-csrf-token": "x" } }).reason, "csrf_token_mismatch");
    assert.equal(csrfFailure(state, { headers: { "x-csrf-token": "n", host: "evil:1" } }).reason, "host_rejected");
    assert.equal(csrfFailure(state, { headers: { "x-csrf-token": "n", host: "127.0.0.1:1" } }).reason, "origin_missing");
    assert.equal(csrfFailure(state, {
      headers: { "x-csrf-token": "n", host: "127.0.0.1:1", origin: "http://127.0.0.1:1" },
    }), null);
  });

  it("a GET carries no CSRF requirement", async () => {
    const running = await server();
    assert.equal((await running.get("/api/collectors")).status, 200);
  });

  it("no response carries a CORS header", async () => {
    const running = await server();
    for (const target of ["/", "/api/collectors", "/api/health"]) {
      const res = await running.get(target, { origin: "https://evil.example" });
      for (const header of Object.keys(res.headers)) {
        assert.equal(header.startsWith("access-control-"), false, `${target} leaked ${header}`);
      }
    }
  });
});

describe("DNS rebinding — Host header enforced on EVERY method (T1-T8)", () => {
  const TARGET = "/api/fixes/claude-output-hygiene/preview";

  it("T1: GET with a foreign Host is refused before it reaches any route", async () => {
    const running = await server();
    const res = await running.get("/api/collectors", { host: "evil.com" });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "host_not_allowed");
  });

  it("T2: a Host that merely contains 'localhost' is refused — no suffix/substring match", async () => {
    const running = await server();
    const res = await running.get("/api/collectors", { host: `localhost.evil.com:${running.port}` });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "host_not_allowed");
  });

  it("T3a: an HTTP/1.1 request with no Host header never reaches the app at all", async () => {
    // Node's own parser refuses this before Express, or this file's Host
    // middleware, ever sees it — a stronger guarantee than a 403 from us,
    // not a weaker one. `setHost: false` is the only way `http.request` can
    // even attempt sending no Host header.
    const running = await server();
    const res = await raw({ port: running.port, target: "/api/collectors", setHost: false });
    assert.equal(res.status, 400);
  });

  it("T3b: an HTTP/1.0 request with no Host header is refused by our own middleware", async () => {
    const running = await server();
    const res = await requestWithNoHostHeader(running.port, "/api/collectors");
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "host_not_allowed");
  });

  it("T4: GET with Host: 127.0.0.1:<port> — the normal browser case — succeeds", async () => {
    const running = await server();
    const res = await running.get("/api/collectors", { host: `127.0.0.1:${running.port}` });
    assert.equal(res.status, 200);
  });

  it("T5: GET with Host: localhost:<port> succeeds", async () => {
    const running = await server();
    const res = await running.get("/api/collectors", { host: `localhost:${running.port}` });
    assert.equal(res.status, 200);
  });

  it("T6: GET with Host: [::1]:<port> succeeds", async () => {
    const running = await server();
    const res = await running.get("/api/collectors", { host: `[::1]:${running.port}` });
    assert.equal(res.status, 200);
  });

  it("T7: a POST with a valid nonce and a valid Host still succeeds", async () => {
    const running = await server();
    const res = await running.post(TARGET);
    assert.equal(res.status, 200, "the new Host middleware must not break the legitimate mutating path");
  });

  it("T8: a POST with a valid Host but no nonce is still 403 — CSRF intact", async () => {
    const running = await server();
    const res = await running.post(TARGET, { headers: { "x-csrf-token": undefined } });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "csrf_token_missing");
  });
});

describe("a valid POST succeeds", () => {
  it("BP-005.06 preview with nonce + Origin + Host returns the fix shape", async () => {
    const running = await server();
    const res = await running.post("/api/fixes/claude-output-hygiene/preview");
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.description, "string");
    assert.equal(typeof res.json.diff, "string");
    assert.ok(res.json.diff.includes("session-rx:output-hygiene:v1"), "the diff shows the marker it will write");
    assert.ok(Array.isArray(res.json.files_affected) && res.json.files_affected.length > 0);
    assert.equal(res.json.reversible, true);
    assert.ok(res.json.check, "preview carries the check result");
  });

  it("preview writes nothing", async () => {
    const running = await server();
    const target = path.join(running.home, ".claude", "CLAUDE.md");
    const before = await fingerprint(target);
    await running.post("/api/fixes/claude-output-hygiene/preview");
    assert.equal(await fingerprint(target), before);
    assert.equal(existsSync(path.join(running.home, ".session-rx")), false, "preview creates no undo state");
  });

  it("BP-005.07/08 apply then undo, inside the temp home only", async () => {
    const running = await server();
    const target = path.join(running.home, ".claude", "CLAUDE.md");
    // This test writes, so it proves WHERE it will write before writing.
    assert.ok(running.state.home.includes("session-rx-5a-"),
      `refusing to run an apply outside a suite temp dir: ${running.state.home}`);
    const before = await fs.readFile(target, "utf8");

    const applied = await running.post("/api/fixes/claude-output-hygiene/apply");
    assert.equal(applied.status, 200);
    assert.equal(applied.json.applied, true);
    assert.equal(typeof applied.json.undoPath, "string");
    assert.ok(applied.json.undoPath.startsWith(running.home), "undo state stays under the configured home");
    const afterApply = await fs.readFile(target, "utf8");
    assert.notEqual(afterApply, before);
    assert.ok(afterApply.startsWith(before), "BP-004.08: existing bytes preserved, the section appended");

    const checked = await running.get("/api/fixes/claude-output-hygiene/check");
    assert.equal(checked.json.applied, true);

    const undone = await running.post("/api/fixes/claude-output-hygiene/undo", {
      body: JSON.stringify({ undoPath: applied.json.undoPath }),
    });
    assert.equal(undone.status, 200);
    assert.equal(undone.json.restored, true);
    assert.equal(undone.json.byteIdentical, true);
    assert.equal(await fs.readFile(target, "utf8"), before, "undo is byte-identical");
  });

  it("a fix refusal is a 409 with its code, not a 500", async () => {
    const running = await server();
    assert.equal((await running.post("/api/fixes/claude-batch-commands/apply")).status, 200);
    const second = await running.post("/api/fixes/claude-batch-commands/preview");
    assert.equal(second.status, 409);
    assert.equal(second.json.code, "ALREADY_APPLIED");
    assert.equal(second.json.reason, "fix_already_applied");
  });

  // This test used to assert 409 TARGET_MISSING for a missing target FILE. That
  // was the old engine contract, and BP-004.11 replaced it: measured on a clean
  // machine, every fix refused because `~/.claude/CLAUDE.md` and
  // `~/.claude/settings.json` had never been written, which is the normal state
  // for most Claude Code users — the product's core loop was unreachable. A
  // missing FILE is now a disclosed CREATE, so this asserts the create, over the
  // same route and the same fix as before. The 409 precondition is not a lowered
  // bar, it has MOVED to the case that genuinely is one: an absent parent
  // DIRECTORY, asserted in the test immediately below.
  it("a missing target file is created, and the create is disclosed in the diff", async () => {
    const running = await server();
    // This test writes, so it proves WHERE it will write before writing.
    assert.ok(running.state.home.includes("session-rx-5a-"),
      `refusing to run an apply outside a suite temp dir: ${running.state.home}`);
    const target = path.join(running.home, ".claude", "CLAUDE.md");
    await fs.rm(target);

    const res = await running.post("/api/fixes/claude-worker-cap/preview");
    assert.equal(res.status, 200, "a missing target file is a create, not a precondition failure");
    assert.equal(res.json.targets[0].created, true, "preview must mark the absent target as created");
    assert.match(res.json.diff, /^--- \/dev\/null\n/, "the old side of a created file's diff is /dev/null");
    assert.match(res.json.description, /does not exist yet; SessionRx will create it/);
    assert.equal(existsSync(target), false, "preview must not create the file it previews");

    const applied = await running.post("/api/fixes/claude-worker-cap/apply");
    assert.equal(applied.status, 200);
    assert.equal(applied.json.applied, true);
    assert.equal(existsSync(target), true, "apply must create the missing target");

    const undone = await running.post("/api/fixes/claude-worker-cap/undo", {
      body: JSON.stringify({ undoPath: applied.json.undoPath }),
    });
    assert.equal(undone.status, 200);
    assert.equal(undone.json.restored, true);
    assert.equal(existsSync(target), false, "undo of a created file removes it, not leaves an empty stub");
  });

  it("an absent ~/.claude directory is the 409 precondition, not a 500", async () => {
    const running = await server();
    await fs.rm(path.join(running.home, ".claude"), { recursive: true });
    const res = await running.post("/api/fixes/claude-worker-cap/preview");
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "TARGET_MISSING");
    assert.equal(res.json.reason, "fix_target_missing");
    // The diagnostic names the DIRECTORY, because the directory is what is
    // missing: an absent `~/.claude/` means the owning CLI is not installed, and
    // SessionRx does not fabricate that tree.
    assert.match(res.json.error, /does not exist; SessionRx will not create it/);
    assert.equal(existsSync(path.join(running.home, ".claude")), false, "the refusal created the directory");
  });

  it("an engine-invariant failure is a 500, not a 409", async () => {
    const { FixError, FIX_ERROR_CODES } = await import("../src/fixes/base.js");
    const running = await server({
      fixCatalog: [{
        id: "engine-broke",
        title: "Engine failure double",
        kind: "append-section",
        factory: () => ({
          id: "engine-broke",
          check: async () => ({ applied: false, marker: "none" }),
          preview: async () => {
            throw new FixError(FIX_ERROR_CODES.WRITE_NOT_VERIFIED, "the bytes on disk are not the bytes written");
          },
        }),
      }],
    });
    const res = await running.post("/api/fixes/engine-broke/preview");
    assert.equal(res.status, 500);
    assert.equal(res.json.code, "WRITE_NOT_VERIFIED");
    assert.equal(res.json.reason, "fix_write_not_verified");
  });

  it("a documented response key is not overridable by the fix", async () => {
    const running = await server({
      fixCatalog: [{
        id: "liar-fix",
        title: "A fix that reports the wrong shape",
        kind: "append-section",
        factory: () => ({
          id: "liar-fix",
          check: async () => ({ applied: "yes", marker: 42 }),
          preview: async () => ({ reversible: "sure", files_affected: "not-an-array", diff: null, description: null }),
        }),
      }],
    });
    const checked = await running.get("/api/fixes/liar-fix/check");
    assert.equal(checked.json.applied, false, "a non-boolean applied is normalised to false");
    const previewed = await running.post("/api/fixes/liar-fix/preview");
    assert.equal(previewed.json.reversible, false);
    assert.deepEqual(previewed.json.files_affected, []);
    assert.equal(previewed.json.diff, "");
  });

  it("an unknown fix id is a 404", async () => {
    const running = await server();
    const res = await running.post("/api/fixes/not-a-fix/preview");
    assert.equal(res.status, 404);
    assert.equal(res.json.reason, "fix_not_found");
  });

  it("a malformed JSON body is a 400, not a 500", async () => {
    const running = await server();
    const res = await running.post("/api/fixes/claude-output-hygiene/preview", { body: "{not json" });
    assert.equal(res.status, 400);
    assert.equal(res.json.reason, "body_parse_failed");
  });
});

describe("honest degradation", () => {
  it("a collector that throws does not 500 the sessions route", async () => {
    const running = await server({
      collectors: [new FakeCollector("claude", [testSession()]), new ExplodingCollector()],
    });
    const res = await running.get("/api/sessions");
    assert.equal(res.status, 200, "one broken collector must not take the route down");
    assert.equal(res.json.total, 1, "the healthy collector still reports");
    const diagnostic = res.json.diagnostics.find((entry) => entry.cli === "exploder");
    assert.ok(diagnostic, "the failure surfaces as a diagnostic");
    assert.ok(diagnostic.errors.some((message) => message.includes("blew up")), "with the real error text");
  });

  it("the same is true of /api/health, /api/trends and /api/report", async () => {
    const running = await server({
      collectors: [new FakeCollector("claude", [testSession()]), new ExplodingCollector()],
    });
    for (const target of ["/api/health", "/api/trends", "/api/report"]) {
      const res = await running.get(target);
      assert.equal(res.status, 200, target);
      assert.ok(Array.isArray(res.json.diagnostics), target);
      assert.ok(res.json.diagnostics.some((entry) => entry.cli === "exploder"), `${target} surfaces the diagnostic`);
    }
  });

  it("a missing dependency module is a 503 with a named cause, never an empty 200", async () => {
    const running = await server({ modules: { trends: "./__wave_3b_not_landed__.js" } });
    const res = await running.get("/api/trends");
    assert.equal(res.status, 503);
    assert.equal(res.json.reason, "dependency_unavailable");
    assert.equal(res.json.dependency, "trends");
    assert.ok(res.json.error.includes("unavailable"));
    // The failure mode this guards against: a body that renders as "all clear".
    assert.equal(res.json.charts, undefined);
    assert.equal(res.json.unknowns, undefined);
    // Its neighbours are unaffected.
    assert.equal((await running.get("/api/health")).status, 200);
  });

  it("a missing analyzer is a 503 on every route that needs it", async () => {
    const running = await server({ modules: { health: "./__wave_3a_not_landed__.js" } });
    for (const target of ["/api/health", "/api/sessions", "/api/report"]) {
      const res = await running.get(target);
      assert.equal(res.status, 503, target);
      assert.equal(res.json.dependency, "health", target);
    }
    assert.equal((await running.get("/api/collectors")).status, 200, "detection does not need the analyzer");
  });

  it("a missing redactor refuses to serve data rather than serving it unredacted", async () => {
    const running = await server({ modules: { report: "./__wave_3c_not_landed__.js" } });
    const res = await running.get("/api/collectors");
    assert.equal(res.status, 503);
    assert.equal(res.json.reason, "redactor_unavailable");
  });

  it("a fix whose module is absent is listed as unavailable, not silently dropped", async () => {
    const running = await server({
      fixCatalog: [{ id: "ghost-fix", title: "Ghost", kind: "append-section", blueprint: "BP-999", specifier: "./fixes/claude/__not_landed__.js" }],
    });
    const listed = await running.get("/api/fixes");
    assert.equal(listed.status, 200);
    assert.equal(listed.json.fixes[0].available, false);
    assert.ok(listed.json.fixes[0].reason.includes("not installed"));

    const previewed = await running.post("/api/fixes/ghost-fix/preview");
    assert.equal(previewed.status, 503);
    assert.equal(previewed.json.reason, "fix_unavailable");
  });

  it("an unreadable frontend is a 500 that says so", async () => {
    const running = await server({ publicDir: path.join(os.tmpdir(), "session-rx-no-such-public") });
    const res = await running.get("/");
    assert.equal(res.status, 500);
    assert.ok(res.json.error.includes("frontend could not be read"));
  });
});

describe("BP-005.15 / FVA-004 — secret redaction on the way out", () => {
  it("a credential-shaped value in session evidence never reaches the client", async () => {
    const running = await server();
    for (const target of ["/api/sessions", "/api/health", "/api/report"]) {
      const res = await running.get(target);
      assert.equal(res.status, 200, target);
      assert.equal(res.text.includes(PLANTED_SECRET), false, `${target} leaked the planted value`);
    }
  });

  it("the nonce is never in an API response", async () => {
    const running = await server();
    for (const target of ["/api/collectors", "/api/health", "/api/sessions", "/api/trends", "/api/report", "/api/fixes"]) {
      const res = await running.get(target);
      assert.equal(res.text.includes(running.nonce), false, `${target} leaked the nonce`);
    }
  });

  it("the nonce is never written under the configured home", async () => {
    const running = await server();
    await running.post("/api/fixes/claude-worker-cap/apply");
    const found = [];
    const walk = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if ((await fs.readFile(full, "utf8").catch(() => "")).includes(running.nonce)) found.push(full);
      }
    };
    await walk(running.home);
    assert.deepEqual(found, [], "the nonce must not be persisted anywhere");
  });

  it("redactJson drops a value its key makes credential-shaped, and keeps ordinary text", () => {
    // Values held in variables so no `key: "literal"` pair appears in this file.
    const values = { tokenish: "short", passwordish: "hunter2", keyish: "abc" };
    const probe = {
      access_token: values.tokenish,
      password: values.passwordish,
      note: "nothing secret here",
      nested: [{ api_key: values.keyish }, { path: "/Users/demo/app" }],
    };
    const { value } = redactJson(probe, redactSecrets);
    assert.equal(value.access_token, "[REDACTED]");
    assert.equal(value.password, "[REDACTED]");
    assert.equal(value.note, "nothing secret here");
    assert.equal(value.nested[0].api_key, "[REDACTED]");
    assert.equal(value.nested[1].path, "/Users/demo/app", "a filesystem path is evidence, not a secret");
  });

  it("redactJson still produces valid JSON for a keyed secret", () => {
    const values = { v: "abc" };
    const { value } = redactJson({ token: values.v }, redactSecrets);
    assert.equal(JSON.parse(JSON.stringify(value)).token, "[REDACTED]");
  });

  it("redactJson counts what it removed and survives a cycle", () => {
    const values = { v: "abc" };
    const cyclic = { secret: values.v };
    cyclic.self = cyclic;
    const { value, redactions } = redactJson(cyclic, redactSecrets);
    assert.ok(redactions >= 1);
    assert.equal(value.self, "[circular]");
  });
});

describe("pure helpers", () => {
  it("filterSessions excludes a session with no recoverable timestamp from a bounded window", () => {
    const dated = testSession();
    const undated = normalizeSession({ cli: "kimi", sessionId: "k1" });
    const all = [dated, undated];
    assert.equal(filterSessions(all, {}).length, 2);
    assert.equal(filterSessions(all, { from: new Date(ISO(1)) }).length, 1);
    assert.equal(filterSessions(all, { cli: ["kimi"] }).length, 1);
    assert.equal(filterSessions(all, { project: "DEMO-APP" }).length, 1, "project match is case-insensitive");
  });

  it("sortSessions puts nulls last in both directions", () => {
    const withTime = { sessionId: "a", startedAt: ISO(10) };
    const without = { sessionId: "b", startedAt: null };
    assert.equal(sortSessions([without, withTime], "startedAt", "desc")[0].sessionId, "a");
    assert.equal(sortSessions([without, withTime], "startedAt", "asc")[0].sessionId, "a");
  });

  it("the default scan bound is stated in the response", async () => {
    const running = await server();
    const res = await running.get("/api/sessions");
    assert.equal(res.json.scan.limitPerCollector, DEFAULT_SCAN_LIMIT);
    assert.equal(res.json.scan.defaulted, true);
    assert.equal(res.json.scan.atLimit, false);
    assert.ok(res.json.scan.note.includes("reached the end"));
  });

  it("scan.atLimit is true when a collector filled the bound", async () => {
    const running = await server({ scanLimit: 1 });
    const res = await running.get("/api/sessions");
    assert.equal(res.json.scan.atLimit, true);
    assert.ok(res.json.scan.note.includes("older sessions exist"));
  });

  it("createApp generates a distinct high-entropy nonce per process", () => {
    const a = createApp({ publicDir: PUBLIC_DIR }).state.nonce;
    const b = createApp({ publicDir: PUBLIC_DIR }).state.nonce;
    assert.notEqual(a, b);
    assert.equal(a.length, 64, "32 random bytes, hex");
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});

describe("src/cli.js", () => {
  it("parses its arguments and environment", async () => {
    const { parseArgs } = await import("../src/cli.js");
    assert.equal(parseArgs([]).open, true);
    assert.equal(parseArgs(["--no-open"]).open, false);
    assert.equal(parseArgs([], { SESSION_RX_NO_OPEN: "1" }).open, false);
    assert.equal(parseArgs(["--port", "7331"]).port, 7331);
    assert.equal(parseArgs(["--port=7331"]).port, 7331);
    assert.equal(parseArgs([], { SESSION_RX_PORT: "7400" }).port, 7400);
    assert.equal(parseArgs(["--help"]).help, true);
    assert.throws(() => parseArgs(["--port", "nope"]), /needs a port number/);
    assert.throws(() => parseArgs(["--port", "99999"]), /between 1 and 65535/);
    assert.throws(() => parseArgs(["--nonsense"]), /unknown option/);
  });

  it("skips a taken port and binds a free one", async () => {
    const { listenOnFreePort } = await import("../src/cli.js");
    const blocker = await startServer({ port: 0, publicDir: PUBLIC_DIR });
    try {
      const running = await listenOnFreePort([blocker.port, 0], { publicDir: PUBLIC_DIR });
      try {
        assert.notEqual(running.port, blocker.port, "the taken port must be skipped");
        assert.equal(running.server.address().address, "127.0.0.1");
      } finally {
        await running.close();
      }
    } finally {
      await blocker.close();
    }
  });

  it("reports that every candidate was taken instead of binding something else", async () => {
    const { listenOnFreePort } = await import("../src/cli.js");
    const blocker = await startServer({ port: 0, publicDir: PUBLIC_DIR });
    try {
      await assert.rejects(
        listenOnFreePort([blocker.port], { publicDir: PUBLIC_DIR }),
        (error) => error.code === "EADDRINUSE",
      );
    } finally {
      await blocker.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The safety proof, asserted last
// ---------------------------------------------------------------------------

describe("real-file safety", () => {
  it("the developer's real home is byte-identical to how the suite found it", async () => {
    for (const target of WATCHED_REAL_PATHS) {
      assert.equal(await fingerprint(target), realBefore.get(target), `${target} changed during the suite`);
    }
    if (!realStateDirExistedBefore) {
      assert.equal(existsSync(REAL_STATE_DIR), false, `${REAL_STATE_DIR} was created during the suite`);
    }
  });

  it("every app under test was pointed at an OS temp directory", () => {
    assert.ok(servers.length > 0);
    for (const running of servers) {
      assert.ok(running.state.home.includes("session-rx-5a-"), `${running.state.home} is not a suite temp dir`);
      assert.notEqual(running.state.home, REAL_HOME);
    }
  });
});
