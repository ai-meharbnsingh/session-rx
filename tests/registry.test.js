import test from "node:test";
import assert from "node:assert/strict";

import {
  collectAll,
  collectMany,
  collectorDefinitions,
  collectors,
  detectAll,
  detectMany,
  discoverAll,
} from "../src/collectors/registry.js";
import { createDiagnostic } from "../src/collectors/base.js";

const STATUSES = new Set(["supported", "detection-only", "absent"]);

/** A collector that reports exactly what the test tells it to. */
function fake({
  id,
  status = "supported",
  sessions = [],
  sessionMeta,
  detectThrows = false,
  collectThrows = false,
  diagnosticProperty = null,
  fillPassedDiagnostic = null,
  returnsNonArray = false,
}) {
  const collector = {
    id,
    displayName: `${id} display`,
    cli: id,
    detect() {
      if (detectThrows) throw new Error(`${id} detect exploded`);
      return { installed: status !== "absent", paths: [`/fake/${id}`], status };
    },
    async collect({ diagnostic } = {}) {
      if (fillPassedDiagnostic && diagnostic) fillPassedDiagnostic(diagnostic);
      if (collectThrows) throw new Error(`${id} collect exploded`);
      return returnsNonArray ? "not an array" : sessions;
    },
  };
  if (sessionMeta !== undefined) collector.sessionMeta = sessionMeta;
  if (diagnosticProperty) Object.assign(collector, diagnosticProperty);
  return collector;
}

// ---------------------------------------------------------------- the split

test("detectAll splits the real registry into supported / detection-only / absent", async () => {
  const result = await detectAll();

  assert.deepEqual(Object.keys(result).sort(), ["absent", "detectionOnly", "diagnostics", "supported"]);
  for (const bucket of ["supported", "detectionOnly", "absent"]) {
    assert.ok(Array.isArray(result[bucket]), `${bucket} is an array`);
  }

  const entries = [...result.supported, ...result.detectionOnly, ...result.absent];
  const ids = entries.map((entry) => entry.id);
  const expected = [...collectorDefinitions.map(([id]) => id), "grok-amp"];

  // Every registered slot is classified exactly once, whatever is installed here.
  assert.deepEqual(ids.slice().sort(), expected.slice().sort());
  assert.equal(new Set(ids).size, ids.length, "no collector appears in two buckets");

  for (const entry of entries) {
    assert.ok(STATUSES.has(entry.status), `${entry.id} status ${entry.status} is a contract value`);
    assert.equal(typeof entry.displayName, "string");
    assert.ok(Array.isArray(entry.paths));
    assert.equal(typeof entry.installed, "boolean");
    assert.equal(entry.diagnostic.cli, entry.id);
  }

  // BP-002.06 / BP-002.07: these two have no parser and can never be "supported".
  for (const id of ["copilot", "grok-amp"]) {
    assert.ok(!result.supported.some((entry) => entry.id === id), `${id} is never supported`);
  }
});

test("detectMany classifies each status into its own bucket", async () => {
  const result = await detectMany([
    fake({ id: "yes", status: "supported" }),
    fake({ id: "probe", status: "detection-only" }),
    fake({ id: "no", status: "absent" }),
  ]);

  assert.deepEqual(result.supported.map((entry) => entry.id), ["yes"]);
  assert.deepEqual(result.detectionOnly.map((entry) => entry.id), ["probe"]);
  assert.deepEqual(result.absent.map((entry) => entry.id), ["no"]);
});

test("collectAll returns the same four keys over the real registry", async () => {
  const result = await collectAll({ limit: 1 });
  assert.deepEqual(Object.keys(result).sort(), ["absent", "detectionOnly", "diagnostics", "supported"]);
  for (const entry of result.supported) {
    assert.ok(Array.isArray(entry.sessions), `${entry.id} carries a sessions array`);
  }
});

test("discoverAll is the detectAll alias, and collectors() returns every registered slot", async () => {
  assert.equal(discoverAll, detectAll);
  const found = await collectors();
  assert.deepEqual(
    found.map((collector) => collector.id).sort(),
    [...collectorDefinitions.map(([id]) => id), "grok-amp"].sort(),
  );
});

// -------------------------------------------------- per-collector isolation

test("a collector that throws in collect() does not break the other collectors", async () => {
  const result = await collectMany([
    fake({ id: "healthy", sessions: [{ sessionId: "s1" }] }),
    fake({ id: "broken", collectThrows: true }),
    fake({ id: "alsoHealthy", sessions: [{ sessionId: "s2" }] }),
  ]);

  assert.deepEqual(result.supported.map((entry) => entry.id), ["healthy", "broken", "alsoHealthy"]);
  assert.deepEqual(result.supported[0].sessions, [{ sessionId: "s1" }]);
  // The failure is contained: the slot is still reported, with no sessions.
  assert.deepEqual(result.supported[1].sessions, []);
  assert.deepEqual(result.supported[2].sessions, [{ sessionId: "s2" }]);

  const broken = result.diagnostics.find((diagnostic) => diagnostic.cli === "broken");
  assert.deepEqual(broken.errors, ["broken collect exploded"]);
  // A healthy collector with nothing to report contributes no diagnostic noise.
  assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.cli === "healthy"));
});

test("a collector that throws in detect() is reported absent, not fatal", async () => {
  const result = await detectMany([
    fake({ id: "explodes", detectThrows: true }),
    fake({ id: "fine", status: "supported" }),
  ]);

  const entry = result.absent.find((candidate) => candidate.id === "explodes");
  assert.equal(entry.status, "absent");
  assert.deepEqual(entry.paths, []);
  assert.equal(entry.installed, false);
  assert.deepEqual(entry.diagnostic.errors, ["explodes detect exploded"]);
  assert.deepEqual(result.supported.map((candidate) => candidate.id), ["fine"]);
});

test("collectMany never lets a non-array collect() result reach the caller", async () => {
  const result = await collectMany([fake({ id: "sloppy", returnsNonArray: true })]);
  assert.deepEqual(result.supported[0].sessions, []);
});

// ------------------------------------------------- diagnostic aggregation

test("diagnostics are aggregated from the diagnostic passed into collect()", async () => {
  const result = await collectMany([
    fake({
      id: "scanner",
      fillPassedDiagnostic(diagnostic) {
        diagnostic.filesScanned += 3;
        diagnostic.linesSkipped += 7;
        diagnostic.truncated.push("/big.jsonl");
      },
    }),
  ]);

  const diagnostic = result.diagnostics.find((candidate) => candidate.cli === "scanner");
  assert.equal(diagnostic.filesScanned, 3);
  assert.equal(diagnostic.linesSkipped, 7);
  assert.deepEqual(diagnostic.truncated, ["/big.jsonl"]);
});

test("a diagnostic a collector publishes on itself is folded in, not lost", async () => {
  const published = createDiagnostic("publisher");
  published.filesScanned = 2;
  published.filesSkipped = 1;
  published.errors.push("one bad file");
  published.windowPromotions = [{ modelId: "claude-opus-5", observedFloor: 416200 }];

  const result = await collectMany([
    fake({ id: "publisher", diagnosticProperty: { diagnostic: published } }),
  ]);

  const diagnostic = result.diagnostics.find((candidate) => candidate.cli === "publisher");
  assert.equal(diagnostic.filesScanned, 2);
  assert.equal(diagnostic.filesSkipped, 1);
  assert.deepEqual(diagnostic.errors, ["one bad file"]);
  // A promotion is how a stale MODEL_WINDOWS entry stays visible: it must survive.
  assert.deepEqual(diagnostic.windowPromotions, [{ modelId: "claude-opus-5", observedFloor: 416200 }]);
});

test("`lastDiagnostic` is folded in too, and a collector that filled the passed diagnostic is not double-counted", async () => {
  const late = createDiagnostic("legacy");
  late.filesScanned = 4;

  const byProperty = await collectMany([
    fake({ id: "legacy", diagnosticProperty: { lastDiagnostic: late } }),
  ]);
  assert.equal(byProperty.diagnostics.find((d) => d.cli === "legacy").filesScanned, 4);

  // The collector honoured the `diagnostic` option AND re-published the very
  // same object; the merge must recognise it by identity and count it once.
  const echo = fake({
    id: "echo",
    fillPassedDiagnostic(diagnostic) {
      diagnostic.filesScanned += 5;
      diagnostic.errors.push("boom");
      echo.diagnostic = diagnostic;
    },
  });
  const byIdentity = await collectMany([echo]);
  const diagnostic = byIdentity.diagnostics.find((candidate) => candidate.cli === "echo");
  assert.equal(diagnostic.filesScanned, 5);
  assert.deepEqual(diagnostic.errors, ["boom"]);
});

test("a detect() error and a collect() error on the same collector both survive", async () => {
  const result = await collectMany([fake({ id: "absentish", status: "absent", collectThrows: true })]);
  // Absent short-circuits before collect, so only the slot is reported.
  assert.deepEqual(result.absent.map((entry) => entry.id), ["absentish"]);
  assert.deepEqual(result.supported, []);
});

// --------------------------------------------------- F-013 sessionMeta relay

test("sessionMeta is forwarded when a collector provides a Map, keyed by session id", async () => {
  const meta = new Map([
    ["ses_child", { sessionId: "ses_child", parentSessionId: "ses_parent", totals: { input: 11 } }],
    ["ses_parent", { sessionId: "ses_parent", parentSessionId: null, totals: { input: 22 } }],
  ]);
  const result = await collectMany([
    fake({
      id: "opencode",
      sessions: [{ sessionId: "ses_child" }, { sessionId: "ses_parent" }],
      sessionMeta: meta,
    }),
  ]);

  const entry = result.supported[0];
  // A Map JSON-serializes to `{}`, so the relay must hand over a plain object.
  assert.equal(entry.sessionMeta instanceof Map, false);
  assert.deepEqual(Object.keys(entry.sessionMeta).sort(), ["ses_child", "ses_parent"]);
  assert.equal(entry.sessionMeta.ses_child.parentSessionId, "ses_parent");
  assert.equal(entry.sessionMeta.ses_parent.parentSessionId, null);
  assert.deepEqual(entry.sessionMeta.ses_child.totals, { input: 11 });
  assert.deepEqual(JSON.parse(JSON.stringify(entry.sessionMeta)), {
    ses_child: { sessionId: "ses_child", parentSessionId: "ses_parent", totals: { input: 11 } },
    ses_parent: { sessionId: "ses_parent", parentSessionId: null, totals: { input: 22 } },
  });

  // BP-003.06 needs the parent linkage joinable to a session by `sessionId`.
  for (const session of entry.sessions) {
    assert.ok(session.sessionId in entry.sessionMeta, `${session.sessionId} joins to its meta`);
  }
});

test("sessionMeta is absent from the entry when the collector does not provide it", async () => {
  const result = await collectMany([
    fake({ id: "claude", sessions: [{ sessionId: "s1" }] }),
    fake({ id: "kimi", sessions: [], sessionMeta: undefined }),
  ]);

  for (const entry of result.supported) {
    assert.equal("sessionMeta" in entry, false, `${entry.id} has no sessionMeta key`);
  }
});

test("an empty sessionMeta is still forwarded: the channel exists, it just has nothing to say", async () => {
  const result = await collectMany([fake({ id: "opencode", sessionMeta: new Map() })]);
  assert.deepEqual(result.supported[0].sessionMeta, {});
});

test("a plain-object sessionMeta is copied, not aliased", async () => {
  const meta = { ses_a: { sessionId: "ses_a", parentSessionId: null } };
  const collector = fake({ id: "future", sessionMeta: meta });
  const result = await collectMany([collector]);

  assert.deepEqual(result.supported[0].sessionMeta, meta);
  assert.notEqual(result.supported[0].sessionMeta, meta, "the relay hands over its own object");
});

test("a non-Map, non-object sessionMeta is ignored rather than relayed as garbage", async () => {
  for (const bad of [[], "meta", 7, null]) {
    const result = await collectMany([fake({ id: "bad", sessionMeta: bad })]);
    assert.equal("sessionMeta" in result.supported[0], false, `${JSON.stringify(bad)} is not relayed`);
  }
});

test("sessionMeta survives a collector whose collect() threw, so partial meta is not discarded", async () => {
  const result = await collectMany([
    fake({
      id: "opencode",
      collectThrows: true,
      sessionMeta: new Map([["ses_partial", { sessionId: "ses_partial", parentSessionId: null }]]),
    }),
  ]);

  const entry = result.supported[0];
  assert.deepEqual(entry.sessions, []);
  assert.deepEqual(Object.keys(entry.sessionMeta), ["ses_partial"]);
  assert.deepEqual(result.diagnostics.find((d) => d.cli === "opencode").errors, ["opencode collect exploded"]);
});

test("detectAll never emits sessionMeta: detect() does not collect", async () => {
  const result = await detectMany([
    fake({ id: "opencode", status: "supported", sessionMeta: new Map([["s", {}]]) }),
  ]);
  assert.equal("sessionMeta" in result.supported[0], false);
});
