/**
 * The scan cache — `src/server.js`.
 *
 * WHAT IS UNDER TEST, and why it is worth a file of its own: `/api/sessions`
 * pages twenty rows at a time, and every page used to re-read the entire
 * corpus (measured: 5,397ms / 5,538ms / 5,448ms for offsets 0 / 20 / 40 of the
 * same unchanged corpus). The scan now happens once per corpus. Three things
 * have to hold for that to be honest rather than merely fast:
 *
 *   1. it re-scans when the files change, and does not when they have not;
 *   2. a scan taken under one `since`/`limit` is never served under another —
 *      `limit` is what `corpusComplete` is derived from, and `corpusComplete`
 *      is what flips `subagent-concurrency` to `unknown`, so serving the wrong
 *      one would silently rewrite verdicts;
 *   3. nothing a request does to the corpus it was given can reach the corpus
 *      the NEXT request gets. `annotateFixTitles` mutates in place, and until
 *      this cache existed every request owned its corpus outright.
 *
 * Real-file safety: every collector double here points at an `mkdtemp`
 * directory, every app is created with `home:` inside one, and the registry is
 * always injected. Nothing in this file reads or writes the developer's home.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Collector, normalizeSession } from "../src/collectors/base.js";
import { collectMany, detectMany } from "../src/collectors/registry.js";
import { LOOPBACK_HOST, scanCacheKey, scanSourceSignature, startServer } from "../src/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(path.resolve(HERE, ".."), "public");

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const temps = [];
async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `session-rx-${prefix}-`));
  temps.push(dir);
  return dir;
}

/** A corpus root that really exists, so the cache has something to watch. */
async function corpusRoot(files = 3) {
  const root = await tempDir("corpus");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  for (let i = 0; i < files; i += 1) {
    await fs.writeFile(path.join(root, i % 2 === 0 ? "." : "nested", `session-${i}.jsonl`), `{"n":${i}}\n`, "utf8");
  }
  return root;
}

function madeUpSession(cli, index) {
  const started = new Date(Date.UTC(2026, 8, 1) + index * 3_600_000);
  const ended = new Date(started.getTime() + 600_000);
  return normalizeSession({
    cli,
    sessionId: `${cli}-${String(index).padStart(4, "0")}`,
    project: `-Users-demo-p${index % 3}`,
    cwd: `/Users/demo/p${index % 3}`,
    model: "claude-sonnet-4-5",
    window: { tokens: 200_000, source: "model-table" },
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    turns: [
      {
        ts: started.toISOString(),
        context: { inputTokens: 1_000 + index, source: "native" },
        cacheRead: 100,
        cacheCreate: 10,
        output: 20,
        toolCalls: [{ id: `t${index}`, name: "Bash", input: { command: "ls" } }],
        toolResultBytes: 100,
      },
    ],
  });
}

/**
 * A collector that counts every read, and whose `detect()` names a directory
 * that exists — which is what makes the cache engage at all.
 */
class CountingCollector extends Collector {
  constructor(id, root, sessions, { delayMs = 0 } = {}) {
    super({ id, displayName: `${id} (scan-cache double)`, cli: id });
    this.root = root;
    this.sessions = sessions;
    this.delayMs = delayMs;
    this.calls = [];
  }

  detect() {
    return { installed: true, paths: [this.root], status: "supported" };
  }

  async collect({ limit, since } = {}) {
    this.calls.push({ limit: limit ?? null, since: since ? new Date(since).toISOString() : null });
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const inRange = since
      ? this.sessions.filter((session) => Date.parse(session.startedAt) >= new Date(since).getTime())
      : this.sessions;
    return Number.isInteger(limit) && limit > 0 ? inRange.slice(0, limit) : inRange;
  }
}

function stubRegistry(collectors) {
  return {
    async detectAll() { return detectMany(collectors); },
    async collectAll(options) { return collectMany(collectors, options); },
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function raw(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: LOOPBACK_HOST, port, method: "GET", path: target }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const servers = [];
async function server(overrides = {}) {
  const home = await tempDir("home");
  const running = await startServer({
    port: 0,
    home,
    publicDir: PUBLIC_DIR,
    now: () => new Date("2026-09-21T00:00:00.000Z"),
    ...overrides,
    modules: { registry: stubRegistry(overrides.collectors ?? []), ...(overrides.modules ?? {}) },
  });
  servers.push(running);
  return { ...running, get: (target) => raw(running.port, target) };
}

after(async () => {
  for (const running of servers) await running.close();
  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

describe("scanCacheKey", () => {
  it("separates every distinct scan, and nothing else", () => {
    const base = scanCacheKey({ since: undefined, limit: 250 });
    assert.equal(base, scanCacheKey({ since: null, limit: 250 }));
    assert.notEqual(base, scanCacheKey({ since: undefined, limit: 251 }));
    assert.notEqual(base, scanCacheKey({ since: new Date("2026-09-01T00:00:00.000Z"), limit: 250 }));
    assert.equal(
      scanCacheKey({ since: new Date("2026-09-01T00:00:00.000Z"), limit: 250 }),
      scanCacheKey({ since: new Date("2026-09-01T00:00:00.000Z"), limit: 250 }),
    );
  });
});

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

describe("scanSourceSignature", () => {
  it("refuses to fingerprint a source it cannot see, rather than calling it unchanged", async () => {
    const result = await scanSourceSignature({
      supported: [{ id: "ghost", paths: ["/no-such-root/does-not-exist"], status: "supported" }],
      detectionOnly: [],
      absent: [],
    });
    assert.equal(result.signature, null);
    assert.equal(result.reason, "no_source_root");
  });

  it("is stable while nothing changes, and moves when a file does", async () => {
    const root = await corpusRoot(4);
    const detected = { supported: [{ id: "x", paths: [root], status: "supported" }], detectionOnly: [], absent: [] };

    const first = await scanSourceSignature(detected);
    const again = await scanSourceSignature(detected);
    assert.equal(typeof first.signature, "string");
    assert.equal(first.reason, null);
    assert.equal(first.signature, again.signature, "an unchanged corpus must produce the same fingerprint");

    await fs.writeFile(path.join(root, "session-0.jsonl"), `{"n":0,"more":true}\n`, "utf8");
    const modified = await scanSourceSignature(detected);
    assert.notEqual(modified.signature, first.signature, "a modified file must move the fingerprint");

    await fs.writeFile(path.join(root, "session-99.jsonl"), `{"n":99}\n`, "utf8");
    const added = await scanSourceSignature(detected);
    assert.notEqual(added.signature, modified.signature, "a new file must move the fingerprint");

    await fs.rm(path.join(root, "session-99.jsonl"));
    const removed = await scanSourceSignature(detected);
    assert.notEqual(removed.signature, added.signature, "a removed file must move the fingerprint");
    assert.equal(removed.signature, modified.signature, "and removing it must land back where it was");
  });

  it("moves when a CLI appears, even with no file under a known root touched", async () => {
    const root = await corpusRoot(2);
    const before = await scanSourceSignature({
      supported: [{ id: "x", paths: [root], status: "supported" }],
      detectionOnly: [],
      absent: [{ id: "y", paths: [], status: "absent" }],
    });
    const after$ = await scanSourceSignature({
      supported: [{ id: "x", paths: [root], status: "supported" }],
      detectionOnly: [{ id: "y", paths: ["/somewhere/y"], status: "detection-only" }],
      absent: [],
    });
    assert.notEqual(before.signature, after$.signature);
  });

  it("gives up rather than becoming expensive, and says which", async () => {
    const root = await corpusRoot(6);
    const result = await scanSourceSignature(
      { supported: [{ id: "x", paths: [root], status: "supported" }], detectionOnly: [], absent: [] },
      { maxFiles: 2 },
    );
    assert.equal(result.signature, null);
    assert.equal(result.reason, "corpus_too_large");
  });

  it("costs a fraction of the scan it guards", async () => {
    const root = await corpusRoot(200);
    const detected = { supported: [{ id: "x", paths: [root], status: "supported" }], detectionOnly: [], absent: [] };
    await scanSourceSignature(detected);
    const measured = await scanSourceSignature(detected);
    assert.equal(measured.files, 200);
    // Not a benchmark — a floor under the claim. 200 files must not take a
    // second; if this ever fails, the check has stopped being the cheap one.
    assert.ok(measured.ms < 1_000, `signature over 200 files took ${measured.ms}ms`);
  });
});

// ---------------------------------------------------------------------------
// Paging off one scan
// ---------------------------------------------------------------------------

describe("the scan cache serves pages from one read", () => {
  it("reads the corpus once for page 1, 2 and 3", async () => {
    const root = await corpusRoot();
    const claude = new CountingCollector("claude", root, Array.from({ length: 50 }, (_, i) => madeUpSession("claude", i)));
    const app = await server({ collectors: [claude] });

    const first = await app.get("/api/sessions?offset=0");
    const second = await app.get("/api/sessions?offset=20");
    const third = await app.get("/api/sessions?offset=40");

    assert.equal(first.status, 200);
    assert.equal(claude.calls.length, 1, "pages 2 and 3 must not re-read the corpus");
    assert.equal(first.json.total, 50);
    assert.equal(second.json.returned, 20);
    assert.equal(third.json.returned, 10);
    assert.equal(third.json.hasMore, false);

    const stats = app.state.scanCache.stats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.hits, 2);
    assert.equal(stats.invalidations, 0, "an unchanged corpus must not invalidate");
  });

  it("pages off the cache exactly as it paged off a fresh scan", async () => {
    const root = await corpusRoot();
    const sessions = Array.from({ length: 50 }, (_, i) => madeUpSession("claude", i));
    const cached = await server({ collectors: [new CountingCollector("claude", root, sessions)] });
    const uncached = await server({ collectors: [new CountingCollector("claude", root, sessions)], scanCache: false });

    for (const target of ["/api/sessions?offset=0", "/api/sessions?offset=20", "/api/sessions?offset=40"]) {
      const a = await cached.get(target);
      const b = await uncached.get(target);
      assert.deepEqual(a.json, b.json, `${target} must be identical cached and uncached`);
    }
  });

  it("filters and sorts off the cache", async () => {
    const root = await corpusRoot();
    const claude = new CountingCollector("claude", root, Array.from({ length: 30 }, (_, i) => madeUpSession("claude", i)));
    const codex = new CountingCollector("codex", root, Array.from({ length: 30 }, (_, i) => madeUpSession("codex", i)));
    const app = await server({ collectors: [claude, codex] });

    await app.get("/api/sessions?offset=0");
    const filtered = await app.get("/api/sessions?cli=codex&sort=startedAt&order=asc&limit=5");
    const nextPage = await app.get("/api/sessions?cli=codex&sort=startedAt&order=asc&limit=5&offset=5");
    const byProject = await app.get("/api/sessions?project=-Users-demo-p1");

    assert.equal(claude.calls.length, 1, "filtering must not re-read the corpus");
    assert.equal(filtered.json.total, 30);
    assert.ok(filtered.json.sessions.every((session) => session.cli === "codex"));
    assert.deepEqual(
      filtered.json.sessions.map((session) => session.sessionId),
      ["codex-0000", "codex-0001", "codex-0002", "codex-0003", "codex-0004"],
    );
    assert.deepEqual(
      nextPage.json.sessions.map((session) => session.sessionId),
      ["codex-0005", "codex-0006", "codex-0007", "codex-0008", "codex-0009"],
    );
    assert.equal(byProject.json.total, 20);
    assert.ok(byProject.json.sessions.every((session) => session.project === "-Users-demo-p1"));
  });
});

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

describe("the scan cache re-reads when it must", () => {
  it("re-reads when a source file changes, and not when it does not", async () => {
    const root = await corpusRoot();
    const claude = new CountingCollector("claude", root, Array.from({ length: 5 }, (_, i) => madeUpSession("claude", i)));
    const app = await server({ collectors: [claude] });

    await app.get("/api/sessions");
    await app.get("/api/sessions");
    assert.equal(claude.calls.length, 1);

    claude.sessions = Array.from({ length: 7 }, (_, i) => madeUpSession("claude", i));
    await fs.writeFile(path.join(root, "session-0.jsonl"), `{"n":0,"grew":"yes"}\n`, "utf8");

    const after$ = await app.get("/api/sessions");
    assert.equal(claude.calls.length, 2, "a changed source file must force a fresh read");
    assert.equal(after$.json.total, 7, "and the response must show what changed");
    assert.equal(app.state.scanCache.stats().invalidations, 1);

    await app.get("/api/sessions");
    assert.equal(claude.calls.length, 2, "and then settle again");
  });

  it("never serves one scan bound under another", async () => {
    const root = await corpusRoot();
    const claude = new CountingCollector("claude", root, Array.from({ length: 12 }, (_, i) => madeUpSession("claude", i)));
    const app = await server({ collectors: [claude], scanLimit: 5 });

    const narrow = await app.get("/api/sessions");
    const wide = await app.get("/api/sessions?scan=50");
    const narrowAgain = await app.get("/api/sessions");

    assert.equal(claude.calls.length, 2, "a different scan bound is a different scan");
    assert.deepEqual(claude.calls.map((call) => call.limit), [5, 50]);
    assert.equal(narrow.json.scan.limitPerCollector, 5);
    assert.equal(narrow.json.scan.atLimit, true);
    assert.equal(wide.json.scan.limitPerCollector, 50);
    assert.equal(wide.json.scan.atLimit, false);
    assert.deepEqual(narrowAgain.json, narrow.json, "and the narrow scan is still the narrow scan");
  });

  it("never serves one health scan bound under another, but reuses the same one", async () => {
    const root = await corpusRoot();
    const claude = new CountingCollector("claude", root, Array.from({ length: 10 }, (_, i) => madeUpSession("claude", i)));
    const app = await server({ collectors: [claude] });

    await app.get("/api/health?since=2026-09-01T01:00:00.000Z");
    await app.get("/api/health?since=2026-09-01T05:00:00.000Z");
    await app.get("/api/health?since=2026-09-01T05:00:00.000Z");

    assert.equal(claude.calls.length, 2);
    assert.deepEqual(claude.calls.map((call) => call.since), [
      "2026-09-01T01:00:00.000Z",
      "2026-09-01T05:00:00.000Z",
    ]);
  });

  it("keeps `/api/sessions` date filters off the scan and still changes the listed window", async () => {
    const root = await corpusRoot();
    const claude = new CountingCollector("claude", root, Array.from({ length: 10 }, (_, i) => madeUpSession("claude", i)));
    const app = await server({ collectors: [claude] });

    const all = await app.get("/api/sessions");
    const windowed = await app.get("/api/sessions?from=2026-09-01T05:00:00.000Z");

    // `from` is a result filter, not a scan cutoff: keeping it out of `since`
    // prevents a narrowed scan from making `corpusComplete` look true and
    // fabricating a measured-zero pass for `subagent-concurrency`.
    assert.equal(claude.calls.length, 1, "a date filter must reuse the same scan");
    assert.ok(claude.calls.every((call) => call.since === null), "a date filter must never become a scan cutoff");
    assert.equal(all.json.total, 10);
    assert.equal(windowed.json.total, 5);
  });

  it("does not cache a scan whose source cannot be watched", async () => {
    // A collector that names a path which does not exist: nothing to observe,
    // so nothing may be reused. This is also what keeps every pre-existing
    // server test on a fresh scan per request.
    const claude = new CountingCollector("claude", "/no-such-root/does-not-exist", [madeUpSession("claude", 0)]);
    const app = await server({ collectors: [claude] });

    await app.get("/api/sessions");
    await app.get("/api/sessions");
    assert.equal(claude.calls.length, 2);
    const stats = app.state.scanCache.stats();
    assert.equal(stats.bypasses, 2);
    assert.equal(stats.reason, "no_source_root");
  });

  it("can be turned off outright", async () => {
    const root = await corpusRoot();
    const claude = new CountingCollector("claude", root, [madeUpSession("claude", 0)]);
    const app = await server({ collectors: [claude], scanCache: false });

    await app.get("/api/sessions");
    await app.get("/api/sessions");
    await app.get("/api/health");
    assert.equal(claude.calls.length, 3);
    assert.equal(app.state.scanCache.stats().enabled, false);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("the scan cache shares an in-flight scan", () => {
  it("reads once for requests that arrive together", async () => {
    const root = await corpusRoot();
    const claude = new CountingCollector(
      "claude",
      root,
      Array.from({ length: 30 }, (_, i) => madeUpSession("claude", i)),
      { delayMs: 120 },
    );
    const app = await server({ collectors: [claude] });

    const [a, b, c] = await Promise.all([
      app.get("/api/sessions?offset=0"),
      app.get("/api/sessions?offset=20"),
      app.get("/api/health"),
    ]);

    assert.equal(claude.calls.length, 1, "three concurrent requests must share one scan");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 200);
    assert.equal(a.json.total, 30);
    assert.equal(b.json.returned, 10);
    assert.equal(c.json.sessionsTotal, 30);
  });

  it("does not cache a scan that failed", async () => {
    const root = await corpusRoot();
    const claude = new CountingCollector("claude", root, [madeUpSession("claude", 0)]);
    let failures = 0;
    const registry = {
      async detectAll() { return detectMany([claude]); },
      async collectAll(options) {
        failures += 1;
        if (failures === 1) throw new Error("the scan blew up");
        return collectMany([claude], options);
      },
    };
    const app = await server({ collectors: [claude], modules: { registry } });

    const broken = await app.get("/api/sessions");
    assert.equal(broken.status, 500);
    const recovered = await app.get("/api/sessions");
    assert.equal(recovered.status, 200, "the next request must retry rather than replay the failure");
    assert.equal(recovered.json.total, 1);
  });
});

// ---------------------------------------------------------------------------
// The hazard: in-place mutation of a shared corpus
// ---------------------------------------------------------------------------

describe("the scan cache never hands out the object it holds", () => {
  it("survives a consumer that mutates the corpus it was given", async () => {
    const root = await corpusRoot();
    const claude = new CountingCollector("claude", root, Array.from({ length: 4 }, (_, i) => madeUpSession("claude", i)));
    const seen = [];
    // Stands in for `annotateFixTitles`, which mutates in place and is allowed
    // to: every consumer of a collect has always owned its corpus outright.
    const health = {
      analyzeAll(collected, options) {
        const sessions = collected.supported[0].sessions;
        seen.push({ count: sessions.length, cli: sessions[0].cli, turns: sessions[0].turns.length });
        sessions[0].cli = "MUTATED";
        sessions[0].turns.length = 0;
        sessions.length = 1;
        collected.diagnostics.push({ cli: "injected-by-a-mutating-consumer" });
        return { sessions: [], subagentSessions: [], collectors: [], diagnostics: [], generatedAt: options.generatedAt };
      },
      buildReportInput: (input) => ({ ...input }),
    };
    const app = await server({ collectors: [claude], modules: { health } });

    const responses = [
      await app.get("/api/sessions"),
      await app.get("/api/sessions"),
      await app.get("/api/sessions"),
    ];

    assert.equal(claude.calls.length, 1, "the corpus was read once");
    // Asserted BEFORE `seen`, and not merely for tidiness: the stored corpus is
    // deep-frozen, so a cache that handed it out instead of a copy would make
    // this same mutation THROW — and `seen` would record the pre-mutation
    // values either way. Without this line the test passes whether the copy is
    // there or not; it was written without it, and it did.
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
    assert.deepEqual(seen, [
      { count: 4, cli: "claude", turns: 1 },
      { count: 4, cli: "claude", turns: 1 },
      { count: 4, cli: "claude", turns: 1 },
    ], "and each request got it whole and unmodified, whatever the last one did to its own copy");
  });

  it("returns byte-identical pages for an unchanged corpus, request after request", async () => {
    // The compounding case, through the REAL analyzer and the real
    // `annotateFixTitles`: the damage a shared corpus would do does not look
    // like a cache bug, it looks like page 3 being wrong.
    const root = await corpusRoot();
    const claude = new CountingCollector("claude", root, Array.from({ length: 40 }, (_, i) => madeUpSession("claude", i)));
    const app = await server({ collectors: [claude] });

    const pages = ["/api/sessions?offset=0", "/api/sessions?offset=20", "/api/sessions?offset=0", "/api/sessions?offset=20"];
    const bodies = [];
    for (const target of pages) bodies.push((await app.get(target)).text);

    assert.equal(claude.calls.length, 1);
    assert.equal(bodies[0], bodies[2], "page 1 must be the same page the second time it is asked for");
    assert.equal(bodies[1], bodies[3], "and so must page 2");
    const first = JSON.parse(bodies[0]);
    assert.ok(first.sessions[0].rules.some((rule) => rule.fixTitle !== undefined), "fix titles are still annotated");
  });
});

// ---------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------

describe("the scan cache is bounded", () => {
  it("evicts the least recently used scan rather than growing", async () => {
    const root = await corpusRoot();
    const claude = new CountingCollector("claude", root, Array.from({ length: 60 }, (_, i) => madeUpSession("claude", i)));
    const app = await server({ collectors: [claude], scanCache: { maxEntries: 2 } });

    await app.get("/api/sessions?scan=10");
    await app.get("/api/sessions?scan=11");
    assert.equal(claude.calls.length, 2);
    assert.equal(app.state.scanCache.stats().entries, 2);

    await app.get("/api/sessions?scan=12");   // evicts scan=10
    assert.equal(claude.calls.length, 3);
    assert.equal(app.state.scanCache.stats().entries, 2, "the cache must not grow past its bound");
    assert.equal(app.state.scanCache.stats().evictions, 1);

    await app.get("/api/sessions?scan=11");   // still held
    assert.equal(claude.calls.length, 3);

    const evicted = await app.get("/api/sessions?scan=10");   // gone, so re-read
    assert.equal(claude.calls.length, 4);
    assert.equal(evicted.json.scan.limitPerCollector, 10);
    assert.equal(evicted.json.total, 10);
  });
});

// ---------------------------------------------------------------------------
// The invariant that must not move
// ---------------------------------------------------------------------------

describe("corpusComplete and the verdicts that hang off it", () => {
  it("is identical cached and uncached, at the cut-off and past it", async () => {
    const root = await corpusRoot();
    const sessions = Array.from({ length: 12 }, (_, i) => madeUpSession("claude", i));
    const collectors = () => [new CountingCollector("claude", root, sessions)];
    const cached = await server({ collectors: collectors(), scanLimit: 5 });
    const uncached = await server({ collectors: collectors(), scanLimit: 5, scanCache: false });

    // Twice each, so the CACHED second answer is compared too — a cache that
    // changed a verdict on the way back out would show up here.
    for (const target of ["/api/health", "/api/sessions?offset=0", "/api/health", "/api/sessions?offset=0"]) {
      const a = await cached.get(target);
      const b = await uncached.get(target);
      assert.equal(a.status, 200);
      assert.deepEqual(a.json, b.json, `${target} must be identical cached and uncached`);
    }

    const health = (await cached.get("/api/health")).json;
    assert.equal(health.scan.atLimit, true, "the corpus is deliberately cut off here");
    for (const session of health.sessions) {
      const rule = session.rules.find((candidate) => candidate.id === "subagent-concurrency");
      assert.equal(rule.evidence.status, "unknown", "an incomplete corpus makes this rule unmeasurable, cached or not");
    }

    const wide = await cached.get("/api/sessions?scan=50");
    assert.equal(wide.json.scan.atLimit, false, "and a wider scan is complete, from its own entry");
    assert.equal(wide.json.total, 12);
  });
});
