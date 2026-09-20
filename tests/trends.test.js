import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTrends,
  cacheZone,
  dayKeysEndingAt,
  localDayKey,
  sessionsFrom,
  turnFraction,
  CACHE_ZONES,
  HEATMAP_HOURS,
  HIGH_CONTEXT_FRACTION,
  MIN_DAYS_PER_HALF,
  TREND_WINDOW_DAYS,
} from "../src/analyzer/trends.js";
import {
  ANCHOR,
  EMPTY_INPUT,
  cacheOnlyDecliningInput,
  cacheOnlyFlatInput,
  cacheSession,
  collectAllShape,
  conflictingInput,
  contextSession,
  dayKey,
  decliningInput,
  gapInput,
  impossibleFractionInput,
  improvingInput,
  kimiInput,
  localTs,
  measuredZeroInput,
  midnightInput,
  mixedFractionInput,
  observedFloorInput,
  partialCacheInput,
  session,
  sparseInput,
  stableInput,
  turn,
  unplaceableInput,
  zeroCacheInput,
} from "./fixtures/trends/sessions.js";

const OPTS = { to: ANCHOR };

function byDate(rows) {
  return new Map(rows.map((row) => [row.date, row]));
}

function trends(input, options = OPTS) {
  return buildTrends(input, options);
}

// --------------------------------------------------------------------------
// window shape
// --------------------------------------------------------------------------

test("the window is fifteen LOCAL days, oldest first, ending on the requested day", () => {
  const t = trends(gapInput);
  assert.equal(TREND_WINDOW_DAYS, 15);
  assert.equal(t.days.length, 15);
  assert.equal(t.days[0], dayKey(-14));
  assert.equal(t.days[14], dayKey(0));
  assert.deepEqual([...t.days].sort(), [...t.days], "days must run oldest -> newest");
  assert.equal(t.window.days, 15);
  assert.equal(t.window.from, dayKey(-14));
  assert.equal(t.window.to, dayKey(0));
  assert.equal(t.window.timezone, "local");
  assert.equal(t.window.timezoneOffsetMinutes, ANCHOR.getTimezoneOffset());
  for (const series of [t.charts.context, t.charts.spend, t.charts.cache]) {
    assert.equal(series.length, 15);
    assert.deepEqual(series.map((row) => row.date), t.days);
  }
});

test("localDayKey and dayKeysEndingAt work off local calendar fields, not UTC", () => {
  // 31 Dec 2026 at 23:30 LOCAL is 1 Jan in UTC for any positive offset, and a
  // toISOString().slice(0,10) implementation would report the wrong day here.
  const lateEvening = new Date(2026, 11, 31, 23, 30);
  assert.equal(localDayKey(lateEvening), "2026-12-31");
  const keys = dayKeysEndingAt(lateEvening, 3);
  assert.deepEqual(keys, ["2026-12-29", "2026-12-30", "2026-12-31"]);
});

test("the window length is caller-controllable by days or by from/to", () => {
  assert.equal(trends(gapInput, { to: ANCHOR, days: 7 }).days.length, 7);
  const span = trends(gapInput, { from: new Date(2026, 8, 18), to: ANCHOR });
  assert.deepEqual(span.days, [dayKey(-2), dayKey(-1), dayKey(0)]);
});

// --------------------------------------------------------------------------
// R1 — a day with no data is null, never zero
// --------------------------------------------------------------------------

test("a day with no data is null in every series, never zero", () => {
  const t = trends(gapInput);
  const context = byDate(t.charts.context);
  const spend = byDate(t.charts.spend);
  const cache = byDate(t.charts.cache);

  for (const empty of [dayKey(-13), dayKey(-10), dayKey(-1)]) {
    const c = context.get(empty);
    assert.equal(c.hasData, false, `${empty} should carry no data`);
    assert.equal(c.avgContextPerTurn, null);
    assert.equal(c.highContextPct, null);
    assert.equal(spend.get(empty).cacheRead, null);
    assert.equal(spend.get(empty).cacheCreation, null);
    assert.equal(spend.get(empty).total, null);
    assert.equal(cache.get(empty).hitRate, null);
    assert.equal(cache.get(empty).zone, null);
  }

  assert.equal(t.excluded.daysWithoutData, 12);
  const gapUnknown = t.unknowns.find((u) => u.code === "days-without-data");
  assert.equal(gapUnknown.count, 12);
  assert.equal(gapUnknown.dates.length, 12);

  // Not a single 0 may appear in a metric on a day that carried no data.
  for (const row of t.charts.context) {
    if (row.hasData) continue;
    assert.notEqual(row.avgContextPerTurn, 0);
    assert.notEqual(row.highContextPct, 0);
  }
});

test("a day that genuinely measured zero is distinguishable from a day with no data", () => {
  const t = trends(measuredZeroInput);
  const context = byDate(t.charts.context);
  const spend = byDate(t.charts.spend);

  const measured = context.get(dayKey(-1));
  assert.equal(measured.hasData, true);
  assert.equal(measured.avgContextPerTurn, 0, "0 tokens of context WAS measured");
  assert.equal(measured.highContextPct, 0, "0% of one computable turn was high");
  assert.equal(spend.get(dayKey(-1)).cacheRead, 0);
  assert.equal(spend.get(dayKey(-1)).cacheCreation, 0);
  assert.equal(spend.get(dayKey(-1)).total, 0);

  const absent = context.get(dayKey(0));
  assert.equal(absent.hasData, false);
  assert.equal(absent.avgContextPerTurn, null);
  assert.equal(absent.highContextPct, null);
  assert.equal(spend.get(dayKey(0)).cacheRead, null);
});

test("a day with turns but no cache figures has no hit rate and no spend total", () => {
  const t = trends(gapInput);
  const row = byDate(t.charts.cache).get(dayKey(-7));
  assert.equal(byDate(t.charts.context).get(dayKey(-7)).hasData, true);
  assert.equal(row.hitRate, null);
  assert.equal(row.zone, null);
  assert.equal(byDate(t.charts.spend).get(dayKey(-7)).total, null);
});

// --------------------------------------------------------------------------
// R2 — G1 counts only turns whose fraction is computable
// --------------------------------------------------------------------------

test("observed-floor turns leave G1's numerator AND denominator, and are counted", () => {
  const t = trends(observedFloorInput);
  const row = byDate(t.charts.context).get(dayKey(0));

  assert.equal(row.turns, 4);
  assert.equal(row.highContextPct, null, "no computable fraction means no percentage");
  assert.notEqual(row.highContextPct, 0);
  assert.notEqual(row.highContextPct, 100);
  assert.equal(row.turnsWithFraction, 0);
  assert.equal(row.turnsWithoutFraction, 4);
  assert.equal(row.turnsAboveThreshold, null);
  // The context reading itself is real and is still averaged.
  assert.equal(row.avgContextPerTurn, 13_636);

  assert.equal(t.excluded.turnsWithoutComputableFraction, 4);
  assert.deepEqual(t.excluded.byWindowSource, { "observed-floor": 4 });
  const unknown = t.unknowns.find((u) => u.code === "turns-without-computable-fraction");
  assert.equal(unknown.count, 4);
  assert.match(unknown.detail, /observed-floor/);
});

test("G1's denominator is the computable turns only, so three of five reads 66.67%", () => {
  const t = trends(mixedFractionInput);
  const row = byDate(t.charts.context).get(dayKey(0));

  assert.equal(row.turns, 5);
  assert.equal(row.turnsWithFraction, 3);
  assert.equal(row.turnsWithoutFraction, 2);
  assert.equal(row.turnsAboveThreshold, 2);
  assert.equal(row.highContextPct, 66.67);
  assert.notEqual(row.highContextPct, 40, "2/5 would mean the excluded turns counted as 0%");
  assert.notEqual(row.highContextPct, 80, "4/5 would mean they counted as 100%");
  assert.equal(t.excluded.turnsWithoutComputableFraction, 2);
});

test("a fraction above 1.0 is a window-table defect, excluded and counted as one", () => {
  const t = trends(impossibleFractionInput);
  const row = byDate(t.charts.context).get(dayKey(0));

  assert.equal(row.turns, 2);
  assert.equal(row.turnsWithFraction, 1);
  assert.equal(row.turnsWithoutFraction, 1);
  assert.equal(row.highContextPct, 0, "the one honest turn sat at 0.5 of window");
  assert.equal(t.excluded.turnsWithImpossibleFraction, 1);
  assert.equal(t.excluded.byWindowSource["impossible-above-1.0"], 1);
  assert.match(
    t.unknowns.find((u) => u.code === "turns-with-impossible-fraction").detail,
    /above 1\.0/,
  );
});

test("the high-context threshold is BP-003.01's own 0.70, exclusive", () => {
  assert.equal(HIGH_CONTEXT_FRACTION, 0.7);
  const at = session({
    sessionId: "boundary",
    turns: [
      turn({ ts: localTs(0, 9), inputTokens: 70 }),
      turn({ ts: localTs(0, 10), inputTokens: 71 }),
    ],
  });
  const row = byDate(trends([at]).charts.context).get(dayKey(0));
  assert.equal(row.turnsWithFraction, 2);
  assert.equal(row.turnsAboveThreshold, 1, "0.70 is not above 0.70; 0.71 is");
  assert.equal(row.highContextPct, 50);
});

test("turnFraction prefers the CLI's native fraction and honours the observed-floor rule", () => {
  const native = turn({ ts: localTs(0, 9), inputTokens: null, fraction: 0.82, source: "native" });
  assert.equal(turnFraction(native, { window: { tokens: null, source: "unknown" } }), 0.82);
  const derived = turn({ ts: localTs(0, 9), inputTokens: 50 });
  assert.equal(turnFraction(derived, { window: { tokens: 100, source: "model-table" } }), 0.5);
  assert.equal(turnFraction(derived, { window: { tokens: 50, source: "observed-floor" } }), null);
  assert.equal(turnFraction(turn({ ts: null }), { window: { tokens: 100, source: "model-table" } }), null);
});

// --------------------------------------------------------------------------
// Kimi — a native fraction with no absolute window (DIS-005)
// --------------------------------------------------------------------------

test("a Kimi session with a native fraction and a null window feeds G1 but no token series", () => {
  const t = trends(kimiInput);
  const context = byDate(t.charts.context).get(dayKey(0));
  const spend = byDate(t.charts.spend).get(dayKey(0));
  const cache = byDate(t.charts.cache).get(dayKey(0));

  assert.deepEqual(t.clis, ["kimi"]);
  assert.equal(context.turnsWithFraction, 2, "both native fractions count");
  assert.equal(context.turnsAboveThreshold, 1);
  assert.equal(context.highContextPct, 50);
  assert.equal(context.avgContextPerTurn, null, "no absolute tokens may be invented from a fraction");
  assert.equal(context.turnsWithContext, 0);
  assert.equal(spend.cacheRead, null);
  assert.equal(spend.cacheCreation, null);
  assert.equal(spend.total, null);
  assert.equal(cache.hitRate, null);
  assert.equal(t.excluded.turnsWithoutComputableFraction, 0);
});

// --------------------------------------------------------------------------
// R3 — cache hit rate
// --------------------------------------------------------------------------

test("a day whose cache figures are both zero has no hit rate at all", () => {
  const t = trends(zeroCacheInput);
  const zero = byDate(t.charts.cache).get(dayKey(0));
  assert.equal(zero.hasData, true);
  assert.equal(zero.cacheRead, 0);
  assert.equal(zero.cacheCreation, 0);
  assert.equal(zero.hitRate, null);
  assert.notEqual(zero.hitRate, 0, "0% reads as catastrophic");
  assert.notEqual(zero.hitRate, 100, "100% reads as perfect");
  assert.equal(zero.zone, null);

  const real = byDate(t.charts.cache).get(dayKey(-1));
  assert.equal(real.hitRate, 95);
  assert.equal(real.zone, "yellow", "95 is not ABOVE 95");
});

test("a day that read cache hits but never a creation figure has no hit rate", () => {
  const t = trends(partialCacheInput);
  const row = byDate(t.charts.cache).get(dayKey(0));
  assert.equal(row.cacheRead, 7_000);
  assert.equal(row.cacheCreation, null);
  assert.equal(row.hitRate, null, "an unmeasured creation figure is not zero creation");
  assert.equal(byDate(t.charts.spend).get(dayKey(0)).total, null);
});

test("cache zones are green > 95, yellow 85..95, red < 85", () => {
  assert.deepEqual({ ...CACHE_ZONES }, { green: 95, yellow: 85 });
  assert.equal(cacheZone(100), "green");
  assert.equal(cacheZone(95.01), "green");
  assert.equal(cacheZone(95), "yellow");
  assert.equal(cacheZone(85), "yellow");
  assert.equal(cacheZone(84.99), "red");
  assert.equal(cacheZone(0), "red");
  assert.equal(cacheZone(null), null);
  assert.equal(cacheZone(undefined), null);
});

test("G2 sums the two cache components and keeps them separable for stacking", () => {
  const t = trends([cacheSession([{ day: 0, read: 9_000, create: 1_000 }, { day: 0, read: 500, create: 500 }])]);
  const spend = byDate(t.charts.spend).get(dayKey(0));
  assert.equal(spend.cacheRead, 9_500);
  assert.equal(spend.cacheCreation, 1_500);
  assert.equal(spend.total, 11_000);
  assert.equal(spend.turnsWithCacheRead, 2);
  assert.equal(byDate(t.charts.cache).get(dayKey(0)).hitRate, 86.36);
});

// --------------------------------------------------------------------------
// R4 — context is never summed
// --------------------------------------------------------------------------

test("the context series exposes no summed context total, only an average", () => {
  const t = trends(gapInput);
  assert.deepEqual(Object.keys(t.charts.context[0]).sort(), [
    "avgContextPerTurn",
    "date",
    "hasData",
    "highContextPct",
    "turns",
    "turnsAboveThreshold",
    "turnsWithContext",
    "turnsWithFraction",
    "turnsWithoutFraction",
  ]);
  for (const key of Object.keys(t.charts.context[0])) {
    assert.equal(/total|sum/i.test(key), false, `context rows must not expose ${key}`);
  }
});

// --------------------------------------------------------------------------
// R5 — local midnight
// --------------------------------------------------------------------------

test("a session spanning local midnight splits across the two local days and hours", () => {
  const t = trends(midnightInput);
  const context = byDate(t.charts.context);

  const before = context.get(dayKey(-1));
  const after = context.get(dayKey(0));
  assert.equal(before.turns, 2);
  assert.equal(after.turns, 2);
  assert.equal(before.highContextPct, 100, "both late-evening turns were above threshold");
  assert.equal(after.highContextPct, 0, "both after-midnight turns were below it");

  const rowFor = (key) => t.heatmap.grid[t.heatmap.days.indexOf(key)];
  assert.equal(rowFor(dayKey(-1))[22], 1);
  assert.equal(rowFor(dayKey(-1))[23], 1);
  assert.equal(rowFor(dayKey(-1))[0], 0, "nothing happened at 00:00 on the earlier day");
  assert.equal(rowFor(dayKey(0))[0], 2);
  assert.equal(rowFor(dayKey(0))[23], 0);
});

// --------------------------------------------------------------------------
// G4 heatmap
// --------------------------------------------------------------------------

test("the heatmap is exactly 15 days x 24 hours, day-major", () => {
  const t = trends(midnightInput);
  assert.equal(HEATMAP_HOURS, 24);
  assert.equal(t.heatmap.rows, 15);
  assert.equal(t.heatmap.cols, 24);
  assert.equal(t.heatmap.orientation, "day-major");
  assert.equal(t.heatmap.grid.length, 15);
  assert.deepEqual(t.heatmap.days, t.days);
  assert.deepEqual(t.heatmap.hours, Array.from({ length: 24 }, (_, h) => h));
  for (const row of t.heatmap.grid) assert.equal(row.length, 24);
  assert.equal(t.heatmap.grid.flat().length, 360);

  assert.equal(t.heatmap.nonZeroCells, 3);
  assert.equal(t.heatmap.maxCell, 2);
  assert.equal(t.heatmap.placedTurns, 4);
  assert.equal(t.heatmap.daysWithoutData, 13);
});

test("a heatmap row for a day with no data is null, not a row of quiet zeroes", () => {
  const t = trends(midnightInput);
  const emptyRow = t.heatmap.grid[t.heatmap.days.indexOf(dayKey(-5))];
  assert.equal(emptyRow.length, 24);
  assert.deepEqual(emptyRow, new Array(24).fill(null));
  // Inside a day that DID record activity, an empty hour is a measured zero.
  const activeRow = t.heatmap.grid[t.heatmap.days.indexOf(dayKey(0))];
  assert.equal(activeRow[5], 0);
});

// --------------------------------------------------------------------------
// unplaceable turns
// --------------------------------------------------------------------------

test("turns with no usable timestamp are counted, never guessed into a bucket", () => {
  const t = trends(unplaceableInput);
  assert.equal(t.excluded.turnsWithoutTimestamp, 2);
  assert.equal(t.excluded.turnsOutsideWindow, 1);
  assert.equal(t.excluded.sessionsWithoutTurns, 1);
  assert.equal(t.heatmap.placedTurns, 1);
  assert.equal(byDate(t.charts.context).get(dayKey(0)).turns, 1);
  const codes = t.unknowns.map((u) => u.code);
  for (const code of ["turns-without-timestamp", "turns-outside-window", "sessions-without-turns"]) {
    assert.ok(codes.includes(code), `expected an unknowns entry for ${code}`);
  }
});

// --------------------------------------------------------------------------
// trend direction
// --------------------------------------------------------------------------

test("trend direction reports improving when context pressure falls beyond the noise", () => {
  const t = trends(improvingInput);
  assert.equal(t.trend.direction, "improving");
  assert.match(t.trend.reason, /turns above 70% of window moved 93\.75 -> 12\.5 percent/);
  assert.match(t.trend.reason, /materiality floor/);
  assert.match(t.trend.reason, /standard error/);
  const context = t.trend.assessments.find((a) => a.label === "turns above 70% of window");
  assert.equal(context.decidable, true);
  assert.equal(context.measuredDays, 8);
  assert.equal(context.earlierDays, 4);
  assert.equal(context.laterDays, 4);
  assert.equal(context.direction, "improving");
  assert.equal(context.material, true);
  assert.equal(context.aboveNoise, true);
  assert.equal(t.trend.assessments.find((a) => a.label === "cache hit rate").direction, "flat");
});

test("trend direction reports declining when context pressure rises", () => {
  const t = trends(decliningInput);
  assert.equal(t.trend.direction, "declining");
  assert.match(t.trend.reason, /turns above 70% of window moved 12\.5 -> 93\.75 percent/);
});

test("trend direction reports stable only when measured days moved less than the floor", () => {
  const t = trends(stableInput);
  assert.equal(t.trend.direction, "stable");
  assert.match(t.trend.reason, /held steady/);
  assert.match(t.trend.reason, /materiality floor/);
  for (const assessment of t.trend.assessments) {
    assert.equal(assessment.decidable, true);
    assert.equal(assessment.direction, "flat");
  }
});

test("two metrics pointing opposite ways is unknown with the conflict named, never stable", () => {
  const t = trends(conflictingInput);
  assert.equal(t.trend.direction, "unknown");
  assert.notEqual(t.trend.direction, "stable");
  assert.match(t.trend.reason, /disagree/);
  assert.match(t.trend.reason, /turns above 70% of window/);
  assert.match(t.trend.reason, /cache hit rate/);
  const directions = t.trend.assessments.map((a) => a.direction).sort();
  assert.deepEqual(directions, ["declining", "improving"]);
});

test("stable is never announced off the secondary metric when the primary was unmeasurable", () => {
  const t = trends(cacheOnlyFlatInput);
  const context = t.trend.assessments.find((a) => a.label === "turns above 70% of window");
  const cache = t.trend.assessments.find((a) => a.label === "cache hit rate");

  assert.equal(context.decidable, false, "every turn here is observed-floor, so no fraction exists");
  assert.equal(cache.decidable, true);
  assert.equal(cache.direction, "flat");
  assert.equal(t.trend.direction, "unknown");
  assert.notEqual(t.trend.direction, "stable", "a clean bill of health off half the evidence");
  assert.match(t.trend.reason, /all-clear this window cannot support/);
  assert.match(t.trend.reason, /cache hit rate held steady/);
  // The two absences are counted apart: eight turns measured context the
  // observed-floor window cannot divide, eight measured no context at all.
  assert.equal(t.excluded.turnsWithoutComputableFraction, 8);
  assert.deepEqual(t.excluded.byWindowSource, { "observed-floor": 8 });
  assert.equal(t.excluded.turnsWithoutContextReading, 8);
  assert.match(
    t.unknowns.find((u) => u.code === "turns-without-context-reading").detail,
    /neither absolute tokens nor a native fraction/,
  );
});

test("a measured collapse in the secondary metric is still reported, and says what it rests on", () => {
  const t = trends(cacheOnlyDecliningInput);
  assert.equal(t.trend.direction, "declining");
  assert.match(t.trend.reason, /cache hit rate moved 98 -> 80 percent/);
  assert.match(t.trend.reason, /rests on cache hit rate alone/);
  assert.match(t.trend.reason, /turns above 70% of window: 0 day\(s\) carried a value/);
});

test("too little data returns unknown WITH a reason, never a guessed stable", () => {
  const t = trends(sparseInput);
  assert.equal(t.trend.direction, "unknown");
  assert.notEqual(t.trend.direction, "stable");
  assert.match(t.trend.reason, /not enough measured days/);
  assert.match(t.trend.reason, /4 day\(s\) carried a value/);
  assert.match(t.trend.reason, new RegExp(`${MIN_DAYS_PER_HALF * 2} are needed`));
  for (const assessment of t.trend.assessments) {
    assert.equal(assessment.decidable, false);
    assert.equal(assessment.from, null);
    assert.equal(assessment.to, null);
  }
});

test("an empty window is unknown with a reason, and every series is null", () => {
  const t = trends(EMPTY_INPUT);
  assert.equal(t.trend.direction, "unknown");
  assert.ok(t.trend.reason.length > 0);
  assert.match(t.trend.reason, /0 day\(s\) carried a value/);
  assert.equal(t.charts.context.filter((row) => row.avgContextPerTurn === null).length, 15);
  assert.equal(t.charts.cache.filter((row) => row.hitRate === null).length, 15);
  assert.equal(t.heatmap.nonZeroCells, 0);
  assert.deepEqual(t.heatmap.grid[0], new Array(24).fill(null));
  assert.deepEqual(t.clis, []);
});

test("five days either side is enough to decide; five in one half is not", () => {
  // MIN_DAYS_PER_HALF is a stated floor, so the boundary is worth pinning:
  // six measured days decide, five do not.
  const sixDays = [-5, -4, -3, -2, -1, 0];
  const decided = trends([
    contextSession([
      { day: -5, high: 4, low: 0 },
      { day: -4, high: 4, low: 0 },
      { day: -3, high: 3, low: 1 },
      { day: -2, high: 0, low: 4 },
      { day: -1, high: 0, low: 4 },
      { day: 0, high: 1, low: 3 },
    ]),
  ]);
  assert.equal(decided.trend.assessments[0].measuredDays, 6);
  assert.equal(decided.trend.assessments[0].decidable, true);
  assert.equal(decided.trend.direction, "improving");

  const undecided = trends([contextSession(sixDays.slice(1).map((day) => ({ day, high: 1, low: 1 })))]);
  assert.equal(undecided.trend.assessments[0].measuredDays, 5);
  assert.equal(undecided.trend.assessments[0].decidable, false);
  assert.equal(undecided.trend.direction, "unknown");
});

test("trend.metrics matches the report generator's TrendMetric contract exactly", () => {
  const t = trends(improvingInput);
  assert.equal(t.trend.metrics.length, 2);
  for (const metric of t.trend.metrics) {
    assert.deepEqual(Object.keys(metric).sort(), ["from", "label", "to", "unit", "windowSource"]);
    assert.equal(typeof metric.label, "string");
    assert.equal(metric.unit, "percent");
  }
  assert.equal(t.trend.metrics[0].windowSource, "model-table", "one contributing source may be named");
  assert.equal(t.trend.metrics[1].windowSource, null, "a hit rate does not depend on a window");
  const mixedSources = trends([...improvingInput, ...kimiInput]);
  assert.equal(mixedSources.trend.metrics[0].windowSource, null, "a mixed measurement names no source");
});

// --------------------------------------------------------------------------
// trend.summary — the plain-language sentence the UI renders as its lead.
// One source of truth (BP-005.19): this file computes the wording, the page
// only displays `trend.summary` verbatim.
// --------------------------------------------------------------------------

test("every direction the analyzer can produce carries a non-empty plain-language summary", () => {
  const scenarios = {
    improving: improvingInput,
    declining: decliningInput,
    stable: stableInput,
    "mixed (metrics disagree)": conflictingInput,
    "flat but primary unmeasured": cacheOnlyFlatInput,
    "declining, rests on secondary alone": cacheOnlyDecliningInput,
    "insufficient data (sparse)": sparseInput,
    "insufficient data (empty)": EMPTY_INPUT,
  };
  for (const [label, input] of Object.entries(scenarios)) {
    const t = trends(input);
    assert.equal(typeof t.trend.summary, "string", `${label}: summary must be a string`);
    assert.ok(t.trend.summary.trim().length > 0, `${label}: summary must not be empty`);
  }
});

test("the mixed/disagreeing summary never claims an overall improvement", () => {
  const t = trends(conflictingInput);
  assert.equal(t.trend.direction, "unknown");
  assert.doesNotMatch(t.trend.summary, /\b(improved|better|faster)\b/i);
  assert.match(t.trend.summary, /disagree/);
  // Both metrics named, described by their own raw movement, not a verdict.
  assert.match(t.trend.summary, /context pressure/i);
  assert.match(t.trend.summary, /cache reuse/i);
});

test("flat and both kinds of insufficient-evidence summary are distinguishable, never each other", () => {
  const flatSummary = trends(stableInput).trend.summary;
  const sparseSummary = trends(sparseInput).trend.summary;
  const emptySummary = trends(EMPTY_INPUT).trend.summary;
  const incompleteSummary = trends(cacheOnlyFlatInput).trend.summary;

  // "nothing changed" (flat) is never the same sentence as "we could not
  // tell" (insufficient data), even though both may be reachable from a
  // trend.direction of "stable"/"unknown" respectively.
  assert.notEqual(flatSummary, sparseSummary);
  assert.notEqual(flatSummary, incompleteSummary);
  // The two ways of having "not enough data" read the same when NOTHING at
  // all could be measured (sparse vs. empty), but both differ from the case
  // where the SECONDARY metric was measured and flat while the primary was
  // the only thing missing.
  assert.equal(sparseSummary, emptySummary);
  assert.notEqual(sparseSummary, incompleteSummary);
  assert.match(flatSummary, /held steady/);
  assert.match(sparseSummary, /not enough measured days/i);
  assert.match(incompleteSummary, /held steady/);
  assert.match(incompleteSummary, /not enough data/i);
});

test("a single-direction summary that rests on one metric alone says so", () => {
  const t = trends(cacheOnlyDecliningInput);
  assert.equal(t.trend.direction, "declining");
  assert.match(t.trend.summary, /cache reuse/i);
  assert.match(t.trend.summary, /declined/i);
  assert.match(t.trend.summary, /not enough data on context pressure/i);
});

// --------------------------------------------------------------------------
// input shapes, filtering, determinism
// --------------------------------------------------------------------------

test("the registry envelope, a bare sessions object, and an array all agree", () => {
  const fromArray = trends(gapInput);
  assert.deepEqual(trends(collectAllShape(gapInput)), fromArray);
  assert.deepEqual(trends({ sessions: gapInput }), fromArray);
});

test("sessionsFrom is total: junk in yields no sessions rather than a throw", () => {
  assert.deepEqual(sessionsFrom(null), []);
  assert.deepEqual(sessionsFrom(undefined), []);
  assert.deepEqual(sessionsFrom(42), []);
  assert.deepEqual(sessionsFrom("sessions"), []);
  assert.deepEqual(sessionsFrom({}), []);
  assert.deepEqual(sessionsFrom({ supported: [{ sessions: null }] }), []);
  assert.equal(sessionsFrom(gapInput).length, gapInput.length);
  assert.equal(trends(null).days.length, 15);
});

test("the cli option restricts the window to one CLI's sessions", () => {
  const all = trends(mixedFractionInput);
  assert.deepEqual(all.clis, ["claude", "opencode"]);
  const onlyOpenCode = trends(mixedFractionInput, { to: ANCHOR, cli: "opencode" });
  assert.deepEqual(onlyOpenCode.clis, ["opencode"]);
  assert.equal(byDate(onlyOpenCode.charts.context).get(dayKey(0)).turnsWithFraction, 0);
  const onlyClaude = trends(mixedFractionInput, { to: ANCHOR, cli: ["claude"] });
  assert.deepEqual(onlyClaude.clis, ["claude"]);
  assert.equal(byDate(onlyClaude.charts.context).get(dayKey(0)).highContextPct, 66.67);
});

test("the same input twice yields a deep-equal result", () => {
  assert.deepEqual(trends(improvingInput), trends(improvingInput));
});

test("thresholds travel with the payload so the chart layer draws the same lines", () => {
  const t = trends(gapInput);
  assert.deepEqual(t.thresholds, { highContextFraction: 0.7, cacheZones: { green: 95, yellow: 85 } });
});
