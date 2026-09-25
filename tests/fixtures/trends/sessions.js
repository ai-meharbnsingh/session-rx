/**
 * Fixtures for src/analyzer/trends.js.
 *
 * TIMEZONE: every timestamp is built with the `new Date(y, m, d, h, min)`
 * constructor, i.e. as a LOCAL wall-clock time, then serialized with
 * `toISOString()`.  That is deliberate: trends.js buckets by LOCAL day and
 * hour, so a fixture written as a literal `"...T23:30:00Z"` string would land
 * in a different day in every timezone and the suite would only pass in UTC.
 * Written this way, "day -1 at 23:30 local" is 23:30 local wherever the tests
 * run, and the midnight-crossing assertions hold everywhere.
 *
 * SHAPE: sessions go through `normalizeSession` from src/collectors/base.js, so
 * the fixtures cannot drift from the real NormalizedSession/NormalizedTurn
 * contract the collectors emit.
 */

import { normalizeSession } from "../../../src/collectors/base.js";

/** Local 2026-09-20, midday — the last day of every fixture window. */
export const ANCHOR = new Date(2026, 8, 20, 12, 0, 0);

/** ISO timestamp for a LOCAL wall-clock moment, `day` offset from the anchor. */
export function localTs(day, hour, minute = 0) {
  return new Date(2026, 8, 20 + day, hour, minute, 0).toISOString();
}

/** Local day key (`YYYY-MM-DD`) for an offset from the anchor. */
export function dayKey(day) {
  const date = new Date(2026, 8, 20 + day);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function turn({ ts, inputTokens = null, fraction = null, source = "derived", cacheRead = null, cacheCreate = null, output = null, isSidechain = null }) {
  return {
    ts,
    context: { inputTokens, fraction, source },
    cacheRead,
    cacheCreate,
    output,
    toolCalls: [],
    toolResultBytes: null,
    isSidechain,
  };
}

export function session({ cli = "claude", sessionId = "s-1", windowTokens = 100, windowSource = "model-table", turns = [] }) {
  return normalizeSession({
    cli,
    support: "supported",
    sessionId,
    project: "demo",
    cwd: "/Users/demo/demo",
    model: "demo-model",
    window: { tokens: windowTokens, source: windowSource },
    startedAt: turns[0]?.ts ?? null,
    endedAt: turns[turns.length - 1]?.ts ?? null,
    turns,
  });
}

/** Wrap sessions in the `registry.collectAll()` envelope the product passes in. */
export function collectAllShape(sessions, { id = "claude" } = {}) {
  return {
    supported: [{ id, displayName: id, installed: true, status: "supported", paths: [], sessions }],
    detectionOnly: [],
    absent: [],
    diagnostics: [],
  };
}

// --------------------------------------------------------------------------
// G1 / G3 control fixtures
//
// A context turn leaves both cache fields null and a cache turn leaves
// inputTokens null, so the two can share one input without perturbing each
// other's series.  Against a 100-token window, an 80-token turn is above the
// 0.70 threshold and a 10-token turn is below it, which makes each day's
// "% of turns above 70% of window" exact rather than approximate.
// --------------------------------------------------------------------------

const HIGH_TOKENS = 80;
const LOW_TOKENS = 10;

/** One session whose turns give each listed day an exact high/low split. */
export function contextSession(plan, { cli = "claude", sessionId = "ctx", windowSource = "model-table" } = {}) {
  const turns = [];
  for (const { day, high = 0, low = 0 } of plan) {
    for (let i = 0; i < high; i += 1) turns.push(turn({ ts: localTs(day, 10, i), inputTokens: HIGH_TOKENS }));
    for (let i = 0; i < low; i += 1) turns.push(turn({ ts: localTs(day, 11, i), inputTokens: LOW_TOKENS }));
  }
  return session({ cli, sessionId, windowTokens: 100, windowSource, turns });
}

/** One session contributing only cache figures, one turn per listed day. */
export function cacheSession(plan, { cli = "claude", sessionId = "cache" } = {}) {
  const turns = plan.map(({ day, read, create }) =>
    turn({ ts: localTs(day, 14), cacheRead: read, cacheCreate: create }));
  return session({ cli, sessionId, windowTokens: 100, windowSource: "model-table", turns });
}

/** Cache days at a fixed hit rate: `read` share of a 10,000-token day. */
function flatCachePlan(days, hitRatePercent) {
  const total = 10_000;
  const read = Math.round((hitRatePercent / 100) * total);
  return days.map((day) => ({ day, read, create: total - read }));
}

const EIGHT_DAYS = [-7, -6, -5, -4, -3, -2, -1, 0];

// --------------------------------------------------------------------------
// gap handling (R1)
// --------------------------------------------------------------------------

/** Activity on three days only, so twelve of the fifteen days are gaps. */
export const gapInput = [
  contextSession([{ day: -14, high: 1, low: 1 }, { day: -7, high: 1, low: 0 }, { day: 0, high: 0, low: 2 }]),
  cacheSession([{ day: -14, read: 9_000, create: 1_000 }, { day: 0, read: 8_000, create: 2_000 }]),
];

/**
 * A day that genuinely MEASURED zero next to a day with no data at all:
 *   day -1 — one turn reporting 0 context tokens and 0 cache tokens
 *   day  0 — no turns whatsoever
 */
export const measuredZeroInput = [
  session({
    sessionId: "zeroes",
    turns: [turn({ ts: localTs(-1, 9), inputTokens: 0, cacheRead: 0, cacheCreate: 0 })],
  }),
];

// --------------------------------------------------------------------------
// G1 exclusions (R2)
// --------------------------------------------------------------------------

/**
 * Cursor-shaped: the window IS the session's observed peak, so every
 * fraction it could produce is 1.0 by construction (F-014).  Four turns, no
 * honest fraction among them.
 */
export const observedFloorInput = [
  session({
    cli: "cursor",
    sessionId: "floor",
    windowTokens: 41_344,
    windowSource: "observed-floor",
    turns: [
      turn({ ts: localTs(0, 9), inputTokens: 41_344, cacheRead: 5_000, cacheCreate: 100 }),
      turn({ ts: localTs(0, 9, 30), inputTokens: 12_000, cacheRead: 5_000, cacheCreate: 100 }),
      turn({ ts: localTs(0, 10), inputTokens: 300, cacheRead: 5_000, cacheCreate: 100 }),
      turn({ ts: localTs(0, 11), inputTokens: 900, cacheRead: 5_000, cacheCreate: 100 }),
    ],
  }),
];

/**
 * One day, five turns: three with an honest fraction (two of them high), two
 * with none.  The only defensible answer is 2/3 = 66.67% — not 2/5 = 40% and
 * not 100%.
 */
export const mixedFractionInput = [
  session({
    sessionId: "mixed",
    turns: [
      turn({ ts: localTs(0, 9), inputTokens: 80 }),
      turn({ ts: localTs(0, 10), inputTokens: 90 }),
      turn({ ts: localTs(0, 11), inputTokens: 10 }),
    ],
  }),
  session({
    cli: "cursor",
    sessionId: "mixed-floor",
    windowTokens: 5_000,
    windowSource: "observed-floor",
    turns: [
      turn({ ts: localTs(0, 12), inputTokens: 5_000 }),
      turn({ ts: localTs(0, 13), inputTokens: 4_000 }),
    ],
  }),
];

/**
 * A stale window table can yield a fraction above 1.0 (F-008: measured at 2.08
 * on real `claude-opus-5` sessions).  That is a table defect, not a reading.
 */
export const impossibleFractionInput = [
  session({
    sessionId: "impossible",
    windowTokens: 200_000,
    windowSource: "model-table",
    turns: [
      turn({ ts: localTs(0, 9), inputTokens: 415_223 }),
      turn({ ts: localTs(0, 10), inputTokens: 100_000 }),
    ],
  }),
];

// --------------------------------------------------------------------------
// A native-fraction-reporting CLI: a fraction with no absolute window (DIS-005)
// --------------------------------------------------------------------------

export const nativeFractionInput = [
  session({
    cli: "cursor",
    sessionId: "native-fraction-1",
    windowTokens: null,
    windowSource: "unknown",
    turns: [
      turn({ ts: localTs(0, 9), inputTokens: null, fraction: 0.82, source: "native" }),
      turn({ ts: localTs(0, 10), inputTokens: null, fraction: 0.30, source: "native" }),
    ],
  }),
];

// --------------------------------------------------------------------------
// G3 zero-cache day (R3)
// --------------------------------------------------------------------------

export const zeroCacheInput = [
  cacheSession([{ day: 0, read: 0, create: 0 }, { day: -1, read: 9_500, create: 500 }]),
];

/** A day whose turns report cache reads but never a creation figure. */
export const partialCacheInput = [
  session({
    sessionId: "partial-cache",
    turns: [turn({ ts: localTs(0, 9), cacheRead: 7_000, cacheCreate: null })],
  }),
];

// --------------------------------------------------------------------------
// local-midnight crossing (R5)
// --------------------------------------------------------------------------

/** One session, four turns, straddling local midnight between day -1 and day 0. */
export const midnightInput = [
  session({
    sessionId: "midnight",
    turns: [
      turn({ ts: localTs(-1, 22, 15), inputTokens: 80 }),
      turn({ ts: localTs(-1, 23, 55), inputTokens: 80 }),
      turn({ ts: localTs(0, 0, 5), inputTokens: 10 }),
      turn({ ts: localTs(0, 0, 45), inputTokens: 10 }),
    ],
  }),
];

// --------------------------------------------------------------------------
// turns that cannot be placed
// --------------------------------------------------------------------------

export const unplaceableInput = [
  session({
    sessionId: "unplaceable",
    turns: [
      turn({ ts: null, inputTokens: 80 }),
      turn({ ts: "not-a-timestamp", inputTokens: 80 }),
      turn({ ts: localTs(-40, 10), inputTokens: 80 }),
      turn({ ts: localTs(0, 10), inputTokens: 80 }),
    ],
  }),
  session({ sessionId: "no-turns", turns: [] }),
];

// --------------------------------------------------------------------------
// trend-direction fixtures
// --------------------------------------------------------------------------

/** Context pressure falls from ~94% of turns to ~13%; cache steady at 98%. */
export const improvingInput = [
  contextSession([
    { day: -7, high: 4, low: 0 },
    { day: -6, high: 4, low: 0 },
    { day: -5, high: 3, low: 1 },
    { day: -4, high: 4, low: 0 },
    { day: -3, high: 1, low: 3 },
    { day: -2, high: 0, low: 4 },
    { day: -1, high: 1, low: 3 },
    { day: 0, high: 0, low: 4 },
  ]),
  cacheSession(flatCachePlan(EIGHT_DAYS, 98)),
];

/** The same window read backwards: context pressure rises. */
export const decliningInput = [
  contextSession([
    { day: -7, high: 0, low: 4 },
    { day: -6, high: 1, low: 3 },
    { day: -5, high: 0, low: 4 },
    { day: -4, high: 1, low: 3 },
    { day: -3, high: 4, low: 0 },
    { day: -2, high: 3, low: 1 },
    { day: -1, high: 4, low: 0 },
    { day: 0, high: 4, low: 0 },
  ]),
  cacheSession(flatCachePlan(EIGHT_DAYS, 98)),
];

/** Eight measured days, nothing moving beyond the materiality floor. */
export const stableInput = [
  contextSession(EIGHT_DAYS.map((day) => ({ day, high: 2, low: 2 }))),
  cacheSession(flatCachePlan(EIGHT_DAYS, 98)),
];

/** Context pressure improves while the cache hit rate collapses. */
export const conflictingInput = [
  contextSession([
    { day: -7, high: 4, low: 0 },
    { day: -6, high: 4, low: 0 },
    { day: -5, high: 4, low: 0 },
    { day: -4, high: 4, low: 0 },
    { day: -3, high: 0, low: 4 },
    { day: -2, high: 0, low: 4 },
    { day: -1, high: 0, low: 4 },
    { day: 0, high: 0, low: 4 },
  ]),
  cacheSession([
    ...flatCachePlan([-7, -6, -5, -4], 98),
    ...flatCachePlan([-3, -2, -1, 0], 70),
  ]),
];

/**
 * Cache figures for eight days and no computable context fraction anywhere —
 * the real shape of an observed-floor-heavy window (F-014).  Nothing moves, so the
 * only tempting verdict is the one that must not be issued: "stable".
 */
export const cacheOnlyFlatInput = [
  cacheSession(flatCachePlan(EIGHT_DAYS, 98)),
  session({
    cli: "cursor",
    sessionId: "floor-only",
    windowTokens: 41_344,
    windowSource: "observed-floor",
    turns: EIGHT_DAYS.map((day) => turn({ ts: localTs(day, 10), inputTokens: 41_344 })),
  }),
];

/** The same window, but the cache hit rate really does collapse. */
export const cacheOnlyDecliningInput = [
  cacheSession([
    ...flatCachePlan([-7, -6, -5, -4], 98),
    ...flatCachePlan([-3, -2, -1, 0], 80),
  ]),
  session({
    cli: "cursor",
    sessionId: "floor-only",
    windowTokens: 41_344,
    windowSource: "observed-floor",
    turns: EIGHT_DAYS.map((day) => turn({ ts: localTs(day, 10), inputTokens: 41_344 })),
  }),
];

/** Four measured days: too little to compare two halves of three. */
export const sparseInput = [
  contextSession([
    { day: -3, high: 4, low: 0 },
    { day: -2, high: 0, low: 4 },
    { day: -1, high: 4, low: 0 },
    { day: 0, high: 0, low: 4 },
  ]),
  cacheSession(flatCachePlan([-3, -2, -1, 0], 98)),
];

export const EMPTY_INPUT = [];
