import test, { after } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  COULD_NOT_READ,
  collectAll,
  collectMany,
  collectorDefinitions,
  collectors,
  detectAll,
  detectMany,
  discoverAll,
  loadCollector,
} from "../src/collectors/registry.js";
import { createDiagnostic } from "../src/collectors/base.js";
import { analyzeAll } from "../src/analyzer/health.js";

const STATUSES = new Set(["supported", "detection-only", "absent", COULD_NOT_READ]);

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

test("detectAll splits the real registry into supported / detection-only / absent / unreadable", async () => {
  const result = await detectAll();

  assert.deepEqual(
    Object.keys(result).sort(),
    ["absent", "detectionOnly", "diagnostics", "supported", "unreadable"],
  );
  for (const bucket of ["supported", "detectionOnly", "absent", "unreadable"]) {
    assert.ok(Array.isArray(result[bucket]), `${bucket} is an array`);
  }

  // Every reader in this repo loads on a Node that meets `engines.node`, so
  // this bucket is empty here. It is exercised against deliberately broken
  // definitions further down.
  assert.deepEqual(result.unreadable, []);

  const entries = [...result.supported, ...result.detectionOnly, ...result.absent, ...result.unreadable];
  const ids = entries.map((entry) => entry.id);
  const expected = collectorDefinitions.map(([id]) => id);

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

test("the collector registry exposes exactly claude, codex, and cursor", () => {
  assert.deepEqual(collectorDefinitions.map(([id]) => id), ["claude", "codex", "cursor"]);
});

test("collectAll returns the same five keys over the real registry", async () => {
  const result = await collectAll({ limit: 1 });
  assert.deepEqual(
    Object.keys(result).sort(),
    ["absent", "detectionOnly", "diagnostics", "supported", "unreadable"],
  );
  for (const entry of result.supported) {
    assert.ok(Array.isArray(entry.sessions), `${entry.id} carries a sessions array`);
  }
});

test("discoverAll is the detectAll alias, and collectors() returns every registered slot", async () => {
  assert.equal(discoverAll, detectAll);
  const found = await collectors();
  assert.deepEqual(
    found.map((collector) => collector.id).sort(),
    collectorDefinitions.map(([id]) => id).sort(),
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
      id: "widget",
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
    fake({ id: "gadget", sessions: [], sessionMeta: undefined }),
  ]);

  for (const entry of result.supported) {
    assert.equal("sessionMeta" in entry, false, `${entry.id} has no sessionMeta key`);
  }
});

test("an empty sessionMeta is still forwarded: the channel exists, it just has nothing to say", async () => {
  const result = await collectMany([fake({ id: "widget", sessionMeta: new Map() })]);
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
      id: "widget",
      collectThrows: true,
      sessionMeta: new Map([["ses_partial", { sessionId: "ses_partial", parentSessionId: null }]]),
    }),
  ]);

  const entry = result.supported[0];
  assert.deepEqual(entry.sessions, []);
  assert.deepEqual(Object.keys(entry.sessionMeta), ["ses_partial"]);
  assert.deepEqual(result.diagnostics.find((d) => d.cli === "widget").errors, ["widget collect exploded"]);
});

test("detectAll never emits sessionMeta: detect() does not collect", async () => {
  const result = await detectMany([
    fake({ id: "widget", status: "supported", sessionMeta: new Map([["s", {}]]) }),
  ]);
  assert.equal("sessionMeta" in result.supported[0], false);
});

// ==========================================================================
// A FAILED READ IS NOT AN EMPTY ONE
//
// `collectMany` contains a throwing collector and files the failure under
// `diagnostics[].errors`, which is right — but the entry it pushes into
// `supported` carries `sessions: []`, which is byte-identical to a healthy CLI
// with nothing in range.  `analyzeAll` published that as a measured 0 with a
// note asserting "this CLI is installed and was read", while the diagnostic
// beside it said `filesScanned: 0` and carried the crash.  Both cannot be true.
// These tests run the real relay, not a hand-built `collected` object, so the
// two halves cannot drift: whatever `collectMany` does with a crash is what
// `analyzeAll` is judged against.
// ==========================================================================

/** The `collectors` entry `analyzeAll` publishes for one CLI, via the real relay. */
async function collectorsAfterAnalysis(collectorList) {
  const collected = await collectMany(collectorList);
  return analyzeAll(collected).collectors;
}

test("a collector that CRASHED and one that found nothing no longer report the same thing", async () => {
  const entries = await collectorsAfterAnalysis([
    fake({ id: "boom", collectThrows: true }),
    fake({ id: "quiet", sessions: [] }),
  ]);
  const crashed = entries.find((entry) => entry.cli === "boom");
  const empty = entries.find((entry) => entry.cli === "quiet");

  // The bug, stated as an assertion: these two differed only by their name.
  const withoutName = ({ cli, ...rest }) => rest;
  assert.notDeepEqual(withoutName(crashed), withoutName(empty), "a crash and an empty scan are not the same result");

  // The crash states no count: 0 would be a measurement nothing made.
  assert.equal(crashed.sessions, null, "a failed read has no session count");
  assert.equal(crashed.subagentSessions, null, "nor a sub-agent count");
  assert.equal(crashed.support, "supported");
  assert.match(crashed.note, /reading this CLI failed/);
  assert.match(crashed.note, /unknown rather than zero/);
  assert.ok(!/was read/.test(crashed.note), "it must not claim the CLI was read");
  assert.ok(!/no session fell inside/.test(crashed.note), "nor blame the requested range");

  // The healthy empty result is UNCHANGED, word for word: a genuine empty scan
  // must not be relabelled a failure by this fix.
  assert.equal(empty.sessions, 0);
  assert.equal(empty.subagentSessions, 0);
  assert.equal(
    empty.note,
    "this CLI is installed and was read, but no session fell inside the requested range, so there is nothing to analyze for it here.",
  );
});

test("the crashed collector's note and its diagnostic no longer contradict each other", async () => {
  const collected = await collectMany([fake({ id: "boom", collectThrows: true })]);
  const analysis = analyzeAll(collected);
  const diagnostic = analysis.diagnostics.find((entry) => entry.cli === "boom");
  const note = analysis.collectors.find((entry) => entry.cli === "boom").note;

  // The diagnostic says nothing was read...
  assert.equal(diagnostic.filesScanned, 0);
  assert.deepEqual(diagnostic.errors, ["boom collect exploded"]);
  // ...and now so does the note, which points at the diagnostic for the text
  // rather than repeating it.
  assert.match(note, /an error stopped the read and not one session was obtained/);
  assert.match(note, /collector diagnostics/);
});

test("a read that partly failed keeps its count and says the count may be low", async () => {
  const entries = await collectorsAfterAnalysis([
    fake({
      id: "half",
      sessions: [{ sessionId: "s1", cli: "half", startedAt: "2026-09-20T10:00:00.000Z", turns: [] }],
      fillPassedDiagnostic(diagnostic) {
        diagnostic.errors.push("one bad file");
      },
    }),
  ]);
  const entry = entries[0];

  // The transcript was read, but it contained no turns: it is excluded from
  // analyzed-session counts rather than represented by five unknown checks.
  assert.equal(entry.sessions, 0);
  assert.equal(entry.subagentSessions, 0);
  assert.match(entry.note, /one error/);
  assert.match(entry.note, /may be lower than the truth/);
  assert.match(entry.note, /contained no turns and were excluded/);
  assert.ok(!/reading this CLI failed/.test(entry.note), "a partial read did not fail outright");
});

// ============================================================ reader loading
//
// The registry loads each reader with a dynamic import. Until now every
// failure of that import — file not written yet, syntax error, a built-in the
// running Node does not have — came out of one bare `catch` as
// `{installed: false, status: "absent"}`. So a user running a Node too old for
// `node:sqlite` was told Cursor was not installed, confidently and silently,
// while their Cursor database sat there full. These tests hold the two cases
// apart: a reader that is NOT THERE, and a reader that IS there and BROKE.
// ===========================================================================

/** A one-off directory holding deliberately broken reader modules. */
const brokenDir = mkdtempSync(path.join(tmpdir(), "session-rx-readers-"));

after(async () => {
  try { await rm(brokenDir, { recursive: true, force: true }); } catch { /* already gone */ }
});

/** Writes a reader module and returns the specifier `loadCollector` takes. */
function reader(name, source) {
  const file = path.join(brokenDir, name);
  writeFileSync(file, source, "utf8");
  return pathToFileURL(file).href;
}

/** A reader that never got written. Its file really is not on disk. */
const MISSING_READER = pathToFileURL(path.join(brokenDir, "never-written.mjs")).href;

/**
 * The real Node-too-old failure: importing a built-in this Node does not have.
 * `node:sqlite` is absent before v22.5.0 and behind a flag until v22.13.0, and
 * it fails exactly like this — verified against `node:sqlite_not_a_module`,
 * which throws ERR_UNKNOWN_BUILTIN_MODULE on every Node there is.
 */
const MISSING_BUILTIN_READER = reader(
  "missing-builtin.mjs",
  'import { DatabaseSync } from "node:sqlite_not_a_module";\nexport class CursorCollector {}\nexport { DatabaseSync };\n',
);

/** A reader that is there, loads, and throws while it runs. */
const THROWING_READER = reader("throws.mjs", 'throw new Error("boom while loading");\n');

/** A reader that is there and loads, but never landed its export. */
const NO_EXPORT_READER = reader("no-export.mjs", "export const somethingElse = 1;\n");

test("a reader whose FILE IS NOT THERE is still the Phase 1 slot, unchanged", async () => {
  const collector = await loadCollector(["cursor", "Cursor CLI", MISSING_READER, "CursorCollector"]);

  // This is the documented Phase 1 case: the parser has not landed, so the
  // slot is registered and reports nothing. It is NOT what changed.
  assert.deepEqual(collector.detect(), { installed: false, paths: [], status: "absent" });
  assert.deepEqual(await collector.collect(), []);
  assert.equal(collector.id, "cursor");
  assert.equal(collector.cli, "cursor");
});

test("a reader that needs a built-in this Node lacks is NOT reported absent", async () => {
  const collector = await loadCollector(["cursor", "Cursor CLI", MISSING_BUILTIN_READER, "CursorCollector"]);
  const detection = collector.detect();

  assert.equal(detection.status, COULD_NOT_READ);
  assert.notEqual(detection.status, "absent");
  // Not `false`. Whether Cursor is installed was never established, and
  // `false` there is the false negative this whole change is about.
  assert.equal(detection.installed, null);
  assert.equal(typeof detection.reason, "string");
  assert.match(detection.reason, /could not load the part of itself that reads Cursor CLI/);
  // The reason carries the real cause, not a shrug.
  assert.match(detection.reason, /No such built-in module: node:sqlite_not_a_module/);
  assert.match(detection.reason, /not a finding that Cursor CLI is missing/);
  assert.match(detection.reason, /Node version/);
});

test("a reader that throws while loading, and one that never landed its export, both say so", async () => {
  const threw = await loadCollector(["cursor", "Cursor CLI", THROWING_READER, "CursorCollector"]);
  assert.equal(threw.detect().status, COULD_NOT_READ);
  assert.match(threw.detect().reason, /boom while loading/);

  // The file IS on disk: a half-landed reader is a broken reader, not an
  // unwritten one, and saying "absent" about it would be the same false claim.
  const noExport = await loadCollector(["cursor", "Cursor CLI", NO_EXPORT_READER, "CursorCollector"]);
  assert.equal(noExport.detect().status, COULD_NOT_READ);
  assert.match(noExport.detect().reason, /exports no CursorCollector/);
});

test("a reader that could not be loaded refuses to collect rather than returning nothing", async () => {
  const collector = await loadCollector(["cursor", "Cursor CLI", MISSING_BUILTIN_READER, "CursorCollector"]);

  // `[]` here would read as "Cursor was read and had no sessions", which is
  // the same false all-clear one layer down.
  await assert.rejects(() => collector.collect(), /could not load the part of itself that reads Cursor CLI/);
});

test("detectMany files a load failure under `unreadable`, never under `absent`", async () => {
  const collector = await loadCollector(["cursor", "Cursor CLI", MISSING_BUILTIN_READER, "CursorCollector"]);
  const result = await detectMany([collector]);

  assert.deepEqual(result.absent, []);
  assert.deepEqual(result.unreadable.map((entry) => entry.id), ["cursor"]);
  const entry = result.unreadable[0];
  assert.equal(entry.status, COULD_NOT_READ);
  assert.equal(entry.installed, null);
  assert.match(entry.reason, /could not load the part of itself that reads Cursor CLI/);

  // Filed as an error too, so a caller that has not learned the new bucket
  // still shows the failure instead of nothing.
  const diagnostic = result.diagnostics.find((candidate) => candidate.cli === "cursor");
  assert.equal(diagnostic.errors.length, 1);
  assert.match(diagnostic.errors[0], /could not load the part of itself that reads Cursor CLI/);
});

test("collectMany does the same, and never lands a failed reader in `supported`", async () => {
  const collector = await loadCollector(["cursor", "Cursor CLI", MISSING_BUILTIN_READER, "CursorCollector"]);
  const result = await collectMany([collector]);

  assert.deepEqual(result.supported, []);
  assert.deepEqual(result.absent, []);
  assert.deepEqual(result.detectionOnly, []);
  assert.deepEqual(result.unreadable.map((entry) => entry.id), ["cursor"]);
  // No sessions key at all: an empty array would be a count nothing measured.
  assert.ok(!("sessions" in result.unreadable[0]));
  assert.match(result.diagnostics[0].errors[0], /could not load the part of itself that reads Cursor CLI/);
});

test("one reader failing to load suppresses neither the readers that work nor the ones absent", async () => {
  const found = await Promise.all([
    ["claude", "Claude Code", "./claude.js", "ClaudeCollector"],
    ["cursor", "Cursor CLI", MISSING_BUILTIN_READER, "CursorCollector"],
    ["codex", "Codex", "./codex.js", "CodexCollector"],
  ].map(loadCollector));

  const result = await detectMany(found);
  const seen = [...result.supported, ...result.detectionOnly, ...result.absent, ...result.unreadable];

  // All three registered slots survive, each classified once and on its own merits.
  assert.deepEqual(seen.map((entry) => entry.id).sort(), ["claude", "codex", "cursor"]);
  assert.equal(new Set(seen.map((entry) => entry.id)).size, 3);
  assert.deepEqual(result.unreadable.map((entry) => entry.id), ["cursor"]);
  // Claude and Codex are real host probes, so their absent status depends on
  // which AI CLIs happen to be installed.

  // The real readers loaded: neither is a bare fallback slot, whatever this
  // machine has installed.
  for (const id of ["claude", "codex"]) {
    const entry = seen.find((candidate) => candidate.id === id);
    assert.equal(seen.filter((candidate) => candidate.id === id).length, 1);
    assert.ok(STATUSES.has(entry.status));
    assert.equal(typeof entry.installed, "boolean");
    assert.notEqual(entry.status, COULD_NOT_READ);
  }

  // Exactly one failure is reported, and it names the reader that failed.
  const errors = result.diagnostics.flatMap((diagnostic) => diagnostic.errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /reads Cursor CLI/);
});

// ============================================================== declared Node
//
// `engines.node` is the only place a user is told what SessionRx needs, and
// npm's default `engine-strict=false` means a wrong value is a WARNING at
// install and a crash later. `node:sqlite`, which `src/collectors/cursor.js`
// imports at module scope, landed in v22.5.0 and stayed behind
// `--experimental-sqlite` until v22.13.0; `npx session-rx` passes no flag. So
// v22.13.0 is the floor, and it is pinned here so the manifest and the code
// cannot drift apart unnoticed.
// ===========================================================================

test("engines.node and the README state the floor the code actually needs", async () => {
  const root = path.join(import.meta.dirname, "..");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

  assert.equal(manifest.engines.node, ">=22.13.0");

  // The README is the other place the floor is stated. Two statements of one
  // fact drift; this is what catches it.
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme, /Requires Node\.js 22\.13 or newer/);

  // The reason the floor is what it is, held to the code rather than to a
  // comment: move this import and the floor is free to move with it.
  const cursor = await readFile(path.join(root, "src", "collectors", "cursor.js"), "utf8");
  assert.match(cursor, /^import \{ DatabaseSync \} from "node:sqlite";$/m);
});
