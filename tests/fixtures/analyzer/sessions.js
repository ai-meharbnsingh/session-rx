/**
 * Analyzer fixtures — hand-shaped `NormalizedSession`s, one per rule path.
 *
 * Every fixture is built through `normalizeSession` / `normalizeTurn` from
 * `src/collectors/base.js`, so a fixture cannot drift from the BP-002 shape the
 * collectors actually emit: if the contract changes, these change with it
 * instead of quietly testing a shape that no longer exists.
 *
 * Session ids are dashed UUIDs on purpose (report contract C-8: a continuous
 * 32-character hex id is redacted as credential-shaped).
 *
 * NOT a test file — `node --test` does not discover `tests/fixtures/**`.
 */

import { normalizeSession } from "../../../src/collectors/base.js";

const BASE = "2026-09-20T08:00:00.000Z";

/** A timestamp `minutes` after the fixed base instant. No clock is read. */
export function at(minutes) {
  return new Date(Date.parse(BASE) + minutes * 60000).toISOString();
}

let uuidCounter = 0;

/** A fresh dashed UUID, deterministic across runs. */
function nextSessionId() {
  uuidCounter += 1;
  const hex = uuidCounter.toString(16).padStart(12, "0");
  return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
}

/**
 * @param {object} fields session overrides; `turns` is an array of turn overrides
 */
export function makeSession(fields = {}) {
  return normalizeSession({
    cli: "claude",
    support: "supported",
    sessionId: fields.sessionId ?? nextSessionId(),
    project: "-Users-demo-app",
    cwd: "/Users/demo/app",
    model: "claude-opus-5",
    window: { tokens: 200000, source: "model-table" },
    startedAt: at(0),
    endedAt: at(30),
    ...fields,
    turns: (fields.turns ?? []).map((turn) => ({
      ts: turn.ts ?? null,
      context: { inputTokens: turn.inputTokens ?? null, fraction: turn.fraction ?? null, source: turn.contextSource ?? "native" },
      cacheRead: turn.cacheRead ?? null,
      cacheCreate: turn.cacheCreate ?? null,
      output: turn.output ?? null,
      toolCalls: turn.toolCalls ?? [],
      toolResultBytes: turn.toolResultBytes ?? null,
      isSidechain: turn.isSidechain ?? null,
    })),
  });
}

/** One tool call. */
export function call(name, input, id = null) {
  return { id, name, input };
}

// --- BP-003.01 context-pressure -------------------------------------------

/** avg 85,000 of a 100,000 model-table window = 0.85 > 0.70. */
export const contextHeavy = makeSession({
  window: { tokens: 100000, source: "model-table" },
  turns: [
    { ts: at(1), inputTokens: 80000 },
    { ts: at(2), inputTokens: 90000 },
  ],
});

/** avg 15,000 of 100,000 = 0.15. */
export const contextCalm = makeSession({
  window: { tokens: 100000, source: "model-table" },
  turns: [
    { ts: at(1), inputTokens: 10000 },
    { ts: at(2), inputTokens: 20000 },
  ],
});

/** F-014: the window IS the session's own peak, so no fraction exists. */
export const contextObservedFloor = makeSession({
  cli: "cursor",
  model: "nemotron-3.5-lightning-free",
  window: { tokens: 41344, source: "observed-floor" },
  turns: [
    { ts: at(1), inputTokens: 12000 },
    { ts: at(2), inputTokens: 41344 },
  ],
});

/** A trivial session that `observed-floor` would also report at 1.00. */
export const contextObservedFloorTiny = makeSession({
  cli: "cursor",
  model: "nemotron-3.5-lightning-free",
  window: { tokens: 5000, source: "observed-floor" },
  turns: [{ ts: at(1), inputTokens: 5000 }],
});

/** DIS-005: a native-fraction-reporting CLI, no absolute window. 0.9 avg. */
export const nativeFractionHigh = makeSession({
  cli: "cursor",
  model: "mystery-model-native-fraction",
  window: { tokens: null, source: "unknown" },
  turns: [
    { ts: at(1), fraction: 0.88, contextSource: "native" },
    { ts: at(2), fraction: 0.92, contextSource: "native" },
  ],
});

/** Same shape, healthy. */
export const nativeFractionLow = makeSession({
  cli: "cursor",
  model: "mystery-model-native-fraction",
  window: { tokens: null, source: "unknown" },
  turns: [
    { ts: at(1), fraction: 0.11, contextSource: "native" },
    { ts: at(2), fraction: 0.19, contextSource: "native" },
  ],
});

/** A native fraction above 1.0 is not rescaled and not clamped. */
export const fractionAboveOne = makeSession({
  cli: "cursor",
  window: { tokens: null, source: "unknown" },
  turns: [{ ts: at(1), fraction: 42, contextSource: "native" }],
});

/** No window, no fraction: nothing to divide. */
export const contextNoWindowNoFraction = makeSession({
  cli: "cursor",
  model: "mystery-model-9",
  window: { tokens: null, source: "unknown" },
  turns: [{ ts: at(1), inputTokens: 9000 }],
});

/** BP-002.14: promoted, but past every known tier — denominator is the peak. */
export const contextPromotedNoLadder = makeSession({
  window: { tokens: 2400000, source: "observed-promoted" },
  turns: [{ ts: at(1), inputTokens: 2400000 }],
});

// --- BP-003.02 cache-hit ---------------------------------------------------

/** 10 / (10 + 90) = 0.10. */
export const cacheLow = makeSession({
  turns: Array.from({ length: 5 }, (_, index) => ({ ts: at(index + 1), cacheRead: 10, cacheCreate: 90 })),
});

/** 9,500 / 10,000 = 0.95. */
export const cacheHigh = makeSession({
  turns: Array.from({ length: 5 }, (_, index) => ({ ts: at(index + 1), cacheRead: 9500, cacheCreate: 500 })),
});

/** Reads recorded, creations never recorded: a rate here would be a fake 1.00. */
export const cacheReadsOnly = makeSession({
  turns: [{ ts: at(1), cacheRead: 5000 }, { ts: at(2), cacheRead: 6000 }],
});

/** Creations recorded, reads never recorded: a rate here would be a fake 0.00. */
export const cacheCreatesOnly = makeSession({
  turns: [{ ts: at(1), cacheCreate: 5000 }],
});

/** Both counters present, both zero: 0/0 is not a hit rate. */
export const cacheAllZero = makeSession({
  turns: [{ ts: at(1), cacheRead: 0, cacheCreate: 0 }],
});

// --- BP-003.03 repeat-tool / BP-003.04 large-tool-result -------------------

function repeatedTurns(count, { bytes = 4096, input = { command: "git status" } } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    ts: at(index + 1),
    toolCalls: [call("Bash", input)],
    toolResultBytes: bytes,
  }));
}

/** Five identical call + input + result triples. */
export const repeatFive = makeSession({ turns: repeatedTurns(5) });

/** Four: under the line, and every call's result is attributable. */
export const repeatFour = makeSession({ turns: repeatedTurns(4) });

/** Four identical, plus a turn whose two calls share ONE byte total. */
export const repeatPartialCoverage = makeSession({
  turns: [
    ...repeatedTurns(4),
    { ts: at(9), toolCalls: [call("Read", { file: "a" }), call("Read", { file: "b" })], toolResultBytes: 2048 },
  ],
});

/** DIS-006: a CLI proves the CALLS but records no result byte length. */
export const toolCallsNoResultBytes = makeSession({
  cli: "codex",
  model: "mystery-model-tool-calls",
  window: { tokens: 1000000, source: "model-map" },
  turns: [
    { ts: at(1), inputTokens: 5000, toolCalls: [call("read_file", { path: "a.txt" })], toolResultBytes: null },
    { ts: at(2), inputTokens: 6000, toolCalls: [call("read_file", { path: "a.txt" })], toolResultBytes: null },
    { ts: at(3), inputTokens: 7000, toolCalls: [call("read_file", { path: "a.txt" })], toolResultBytes: null },
  ],
});

/** Three turns over 10,240 bytes. */
export const bigResults = makeSession({
  turns: [
    { ts: at(1), toolCalls: [call("Read", { file: "one" })], toolResultBytes: 20000 },
    { ts: at(2), toolCalls: [call("Read", { file: "two" })], toolResultBytes: 31000 },
    { ts: at(3), toolCalls: [call("Read", { file: "three" })], toolResultBytes: 44000 },
  ],
});

/** Same shape, all small, full coverage. */
export const smallResults = makeSession({
  turns: [
    { ts: at(1), toolCalls: [call("Read", { file: "one" })], toolResultBytes: 400 },
    { ts: at(2), toolCalls: [call("Read", { file: "two" })], toolResultBytes: 900 },
    { ts: at(3), toolCalls: [call("Read", { file: "three" })], toolResultBytes: 120 },
  ],
});

/** Two oversized, plus one tool turn whose bytes were never recorded. */
export const bigResultsPartialCoverage = makeSession({
  turns: [
    { ts: at(1), toolCalls: [call("Read", { file: "one" })], toolResultBytes: 20000 },
    { ts: at(2), toolCalls: [call("Read", { file: "two" })], toolResultBytes: 31000 },
    { ts: at(3), toolCalls: [call("Read", { file: "three" })], toolResultBytes: null },
  ],
});

/** No tool call anywhere: a pass only with corpus evidence that this CLI records them. */
export const noToolCalls = makeSession({
  turns: [{ ts: at(1), inputTokens: 1000 }, { ts: at(2), inputTokens: 2000 }],
});

// --- BP-003.05 long-rising-context ----------------------------------------

/** Six hours, context climbing. */
export const longRising = makeSession({
  startedAt: at(0),
  endedAt: at(360),
  turns: [
    { ts: at(0), inputTokens: 20000 },
    { ts: at(90), inputTokens: 60000 },
    { ts: at(180), inputTokens: 110000 },
    { ts: at(360), inputTokens: 170000 },
  ],
});

/** Six hours, but compacting: the trend is down, so this is not the defect. */
export const longFalling = makeSession({
  startedAt: at(0),
  endedAt: at(360),
  turns: [
    { ts: at(0), inputTokens: 170000 },
    { ts: at(90), inputTokens: 110000 },
    { ts: at(180), inputTokens: 60000 },
    { ts: at(360), inputTokens: 20000 },
  ],
});

/** Rising hard, but over twenty minutes: duration is half the rule. */
export const shortRising = makeSession({
  startedAt: at(0),
  endedAt: at(20),
  turns: [
    { ts: at(0), inputTokens: 20000 },
    { ts: at(10), inputTokens: 90000 },
    { ts: at(20), inputTokens: 160000 },
  ],
});

/** Two points have a slope; two points are not a trend. */
export const twoObservations = makeSession({
  startedAt: at(0),
  endedAt: at(360),
  turns: [
    { ts: at(0), inputTokens: 20000 },
    { ts: at(360), inputTokens: 170000 },
  ],
});

/** Context readings, no timestamps anywhere: no elapsed time to test. */
export const noTimestamps = makeSession({
  startedAt: null,
  endedAt: null,
  turns: [{ inputTokens: 20000 }, { inputTokens: 60000 }, { inputTokens: 90000 }],
});

// --- BP-003.06 subagent-concurrency ---------------------------------------

/** Three of four children open at once. */
export const concurrentChildren = [
  { sessionId: "child-1", startedAt: at(0), endedAt: at(30), collected: true },
  { sessionId: "child-2", startedAt: at(5), endedAt: at(35), collected: true },
  { sessionId: "child-3", startedAt: at(10), endedAt: at(40), collected: true },
  { sessionId: "child-4", startedAt: at(90), endedAt: at(95), collected: true },
];

/** Four children, strictly one after another. One ends exactly as the next begins. */
export const sequentialChildren = [
  { sessionId: "child-1", startedAt: at(0), endedAt: at(10), collected: true },
  { sessionId: "child-2", startedAt: at(10), endedAt: at(20), collected: true },
  { sessionId: "child-3", startedAt: at(25), endedAt: at(30), collected: true },
  { sessionId: "child-4", startedAt: at(40), endedAt: at(50), collected: true },
];

/** Linked, but never collected, so no interval came with them. */
export const childrenWithoutIntervals = [
  { sessionId: "child-1", startedAt: null, endedAt: null, collected: false },
  { sessionId: "child-2", startedAt: null, endedAt: null, collected: false },
];

/** Two sequential children plus two whose interval is missing. */
export const childrenPartialIntervals = [
  { sessionId: "child-1", startedAt: at(0), endedAt: at(10), collected: true },
  { sessionId: "child-2", startedAt: at(20), endedAt: at(30), collected: true },
  { sessionId: "child-3", startedAt: null, endedAt: null, collected: false },
  { sessionId: "child-4", startedAt: null, endedAt: null, collected: false },
];

/** A session with sub-agent-marked turns but no identity on them. */
export const sidechainMarkedSession = makeSession({
  turns: [
    { ts: at(1), inputTokens: 1000, isSidechain: false },
    { ts: at(2), inputTokens: 2000, isSidechain: true },
    { ts: at(3), inputTokens: 3000, isSidechain: true },
  ],
});

// --- corpus shapes for analyzeAll -----------------------------------------

/** What `registry.collectAll()` returns, shaped by hand. */
export function makeCollected({ supported = [], detectionOnly = [], absent = [], diagnostics = [] } = {}) {
  return { supported, detectionOnly, absent, diagnostics };
}

/** A diagnostic carrying one window promotion (BP-002.17). */
export function promotionDiagnostic(cli, sessionId, { ladder = "vendor", tableTokens = 200000, tokens = 1000000, modelId = "claude-opus-5" } = {}) {
  return {
    cli,
    filesScanned: 1,
    filesSkipped: 0,
    linesSkipped: 0,
    truncated: [],
    errors: [],
    windowPromotions: [
      { modelId, sessionId, tableVersion: "test", tableEntry: "claude-family", vendor: "anthropic", tableTokens, tableSource: "model-table", observedFloor: 415223, tokens, tier: ladder === "none" ? null : tokens, ladder },
    ],
  };
}
