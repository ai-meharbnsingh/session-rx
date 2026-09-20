/**
 * BP-001.13 — SessionRx trend aggregation: four visualisations over a 15-day
 * window, plus the single trend direction the Markdown report consumes.
 *
 * G1 "Context efficiency"  — per day: average context per turn, and the % of
 *                            turns above 70% of the resolved window.
 * G2 "Token spend"         — per day: cache_read and cache_creation, the two
 *                            stacked components.
 * G3 "Cache hit rate"      — per day: read / (read + creation) x 100, with the
 *                            green / yellow / red zone it falls in.
 * G4 "Activity heatmap"    — a 15 (days) x 24 (hours) grid of turn activity.
 *
 * ============================================================================
 * THE FIVE RULES THIS FILE EXISTS TO ENFORCE.  Each one is a measured failure
 * from this codebase's own history, not a style preference.
 * ============================================================================
 *
 * R1  A DAY WITH NO DATA IS NOT A ZERO.  Every series emits `null` for a day
 *     that carried no observation, and every row also carries `hasData`.  A
 *     zero plotted into a gap draws the line straight through it and invents a
 *     trend that was never measured.  Only the chart layer can break a line,
 *     and it can only do that if this layer hands it a null.
 *
 * R2  A CONTEXT FRACTION THAT DOES NOT EXIST IS NOT 0% AND NOT 100%.  Where
 *     `window.source === "observed-floor"` the window IS the session's own
 *     observed peak, so floor/floor = 1.0 by construction (ruling F-014;
 *     measured: every real OpenCode session on this machine lands there).
 *     `contextFraction` in src/collectors/base.js already returns null for that
 *     case and is the single authority here.  Such turns leave G1's numerator
 *     AND its denominator, and are counted in `excluded` so the denominator
 *     stays auditable.  A fraction above 1.0 is likewise not a reading but a
 *     window-table defect (F-008): excluded and counted separately.
 *
 * R3  A CACHE HIT RATE WITH NOTHING IN THE DENOMINATOR IS NULL.  0% reads as
 *     catastrophic and 100% reads as perfect; both are lies about a day that
 *     simply moved no cache tokens.
 *
 * R4  CONTEXT IS A GAUGE, NEVER SUMMED.  Per-turn context is averaged and
 *     peaked, never totalled.  Summing cumulative per-turn usage is the exact
 *     error that inflated a real measurement 1.97x in this codebase's history
 *     (see F-010 and the Claude dedupe lesson).  `cacheRead` and `cacheCreate`
 *     ARE flows and are summed.
 *
 * R5  DAYS AND HOURS ARE LOCAL, NOT UTC.  The user is reading their own
 *     working day: an evening session belongs to the evening they worked, and
 *     UTC bucketing would silently push every late session into tomorrow.
 *     Buckets are built from the process's local timezone via `getFullYear` /
 *     `getMonth` / `getDate` / `getHours`, and `window.timezoneOffsetMinutes`
 *     records the offset the numbers were computed under.
 *
 * Kimi (BLUEPRINT DIS-005) reports a NATIVE context fraction with
 * `window.tokens === null`.  It therefore contributes to G1's fraction series
 * and to nothing token-denominated.  Its fraction is never multiplied back
 * into invented tokens.
 */

import { contextFraction } from "../collectors/base.js";

/** The window the product ships: 15 local days, today last. */
export const TREND_WINDOW_DAYS = 15;
/** A day has 24 hour columns; the grid is day-major (rows = days). */
export const HEATMAP_HOURS = 24;
/** Defensive clamp so a caller-supplied range cannot allocate an unbounded grid. */
export const MAX_WINDOW_DAYS = 366;

/** BP-003.01's own alarm point: a turn above 0.70 of window is "high". */
export const HIGH_CONTEXT_FRACTION = 0.70;

/** G3 zone edges, in percent: green > 95, yellow 85..95 inclusive, red < 85. */
export const CACHE_ZONES = Object.freeze({ green: 95, yellow: 85 });

/**
 * Trend gates.  Both must pass before any direction other than `stable` is
 * reported; the reasoning is in `assessMetric`.
 */
export const MIN_DAYS_PER_HALF = 3;
export const MATERIALITY_POINTS = 1;

const CONTEXT_METRIC = "turns above 70% of window";
const CACHE_METRIC = "cache hit rate";

// --------------------------------------------------------------------------
// small numeric helpers — every one of them treats absence as absence
// --------------------------------------------------------------------------

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value, places) {
  if (!finite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Sample variance (n-1). Fewer than two points have no spread to estimate. */
function variance(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  let acc = 0;
  for (const value of values) acc += (value - avg) ** 2;
  return acc / (values.length - 1);
}

// --------------------------------------------------------------------------
// LOCAL day / hour bucketing (R5)
// --------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD` in the LOCAL timezone — never `toISOString().slice(0,10)`. */
export function localDayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value.trim() !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * The `days` local day keys ending on `endDate`'s local day, oldest first.
 *
 * Built by calendar arithmetic (`new Date(y, m, d - n)`) rather than by
 * subtracting 86_400_000 ms, so a DST transition inside the window does not
 * drop or duplicate a day.
 */
export function dayKeysEndingAt(endDate, days = TREND_WINDOW_DAYS) {
  const year = endDate.getFullYear();
  const month = endDate.getMonth();
  const day = endDate.getDate();
  const keys = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    keys.push(localDayKey(new Date(year, month, day - offset)));
  }
  return keys;
}

/** Inclusive count of local days from `from` to `to`, at least 1. */
function localDaySpan(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  let count = 1;
  const cursor = new Date(a);
  while (cursor < b && count < MAX_WINDOW_DAYS) {
    cursor.setDate(cursor.getDate() + 1);
    count += 1;
  }
  return count;
}

// --------------------------------------------------------------------------
// input adaptation — the analyzer accepts what the registry actually returns
// --------------------------------------------------------------------------

function isSession(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalized sessions out of any shape the product hands this module:
 * `registry.collectAll()`'s `{supported:[{sessions}]}`, a bare `{sessions}`,
 * or a plain array.  Anything else yields no sessions rather than throwing —
 * a trends panel that crashes tells the user less than one that says "no data".
 */
export function sessionsFrom(input) {
  if (Array.isArray(input)) return input.filter(isSession);
  if (!isSession(input)) return [];
  if (Array.isArray(input.sessions)) return input.sessions.filter(isSession);
  if (Array.isArray(input.supported)) {
    const out = [];
    for (const entry of input.supported) {
      if (Array.isArray(entry?.sessions)) out.push(...entry.sessions.filter(isSession));
    }
    return out;
  }
  return [];
}

function cliFilter(cli) {
  if (cli === undefined || cli === null || cli === "") return null;
  const wanted = new Set((Array.isArray(cli) ? cli : [cli]).map((value) => String(value)));
  return (session) => wanted.has(String(session?.cli));
}

// --------------------------------------------------------------------------
// per-turn context fraction (R2)
// --------------------------------------------------------------------------

/**
 * The turn's honest context fraction, or null when none exists.
 *
 * A collector-supplied fraction wins, because only the collector knows whether
 * the CLI stated one natively (Kimi does; DIS-005).  Otherwise it is derived
 * through `contextFraction`, which is where the `observed-floor` rule (F-014)
 * lives — so this module cannot accidentally route around it.
 */
export function turnFraction(turn, session) {
  const native = turn?.context?.fraction;
  if (finite(native)) return native;
  return contextFraction(turn?.context?.inputTokens ?? null, session?.window ?? null);
}

// --------------------------------------------------------------------------
// accumulation
// --------------------------------------------------------------------------

function newBucket() {
  return {
    turns: 0,
    contextSum: 0,
    contextCount: 0,
    fractionTurns: 0,
    fractionHigh: 0,
    fractionMissing: 0,
    cacheRead: 0,
    cacheReadCount: 0,
    cacheCreate: 0,
    cacheCreateCount: 0,
    hours: new Array(HEATMAP_HOURS).fill(0),
  };
}

function bump(map, key) {
  const name = key === null || key === undefined ? "unknown" : String(key);
  map.set(name, (map.get(name) ?? 0) + 1);
}

function resolveWindowDays(options) {
  const to = toDate(options.to) ?? toDate(options.now) ?? new Date();
  const from = toDate(options.from);
  let days = finite(options.days) ? Math.trunc(options.days) : null;
  if (days === null && from) days = localDaySpan(from, to);
  if (days === null) days = TREND_WINDOW_DAYS;
  days = Math.min(Math.max(days, 1), MAX_WINDOW_DAYS);
  return { to, days };
}

/**
 * Build every trend series for the window.
 *
 * @param {object|Array} input `registry.collectAll()` result, `{sessions}`, or
 *   an array of normalized sessions.
 * @param {{to?, from?, now?, days?, cli?}} [options] `to` (default: now) is the
 *   LAST day of the window; `days` (default 15) its length; `cli` an optional
 *   id or array of ids to restrict to.
 */
export function buildTrends(input, options = {}) {
  const { to, days } = resolveWindowDays(options);
  const dayKeys = dayKeysEndingAt(to, days);
  const dayIndex = new Map(dayKeys.map((key, i) => [key, i]));
  const buckets = dayKeys.map(() => newBucket());

  const filter = cliFilter(options.cli);
  const all = sessionsFrom(input);
  const sessions = filter ? all.filter(filter) : all;

  const clis = new Set();
  const fractionWindowSources = new Set();
  const missingFractionBySource = new Map();
  const excluded = {
    turnsWithoutComputableFraction: 0,
    turnsWithoutContextReading: 0,
    turnsWithImpossibleFraction: 0,
    turnsWithoutTimestamp: 0,
    turnsOutsideWindow: 0,
    sessionsWithoutTurns: 0,
    sessionsOutsideWindow: 0,
  };

  for (const session of sessions) {
    const turns = Array.isArray(session.turns) ? session.turns : [];
    if (turns.length === 0) {
      excluded.sessionsWithoutTurns += 1;
      continue;
    }
    let placedAny = false;
    for (const turn of turns) {
      const at = toDate(turn?.ts);
      if (!at) {
        excluded.turnsWithoutTimestamp += 1;
        continue;
      }
      const index = dayIndex.get(localDayKey(at));
      if (index === undefined) {
        excluded.turnsOutsideWindow += 1;
        continue;
      }
      placedAny = true;
      const bucket = buckets[index];
      bucket.turns += 1;
      bucket.hours[at.getHours()] += 1;
      clis.add(String(session.cli ?? "unknown"));

      // R4: context is averaged, never accumulated into a "total context".
      const inputTokens = turn?.context?.inputTokens;
      if (finite(inputTokens)) {
        bucket.contextSum += inputTokens;
        bucket.contextCount += 1;
      }

      // R2: only a computable, possible fraction may enter G1's ratio.  The two
      // reasons a turn has no fraction are counted apart, because they mean
      // different things: a turn that measured no context at all says nothing
      // about the window, whereas a turn that measured context the window could
      // not divide is the F-014 case and belongs in the per-source breakdown.
      const fraction = turnFraction(turn, session);
      const measuredContext = finite(inputTokens) || finite(turn?.context?.fraction);
      if (!finite(fraction)) {
        bucket.fractionMissing += 1;
        if (measuredContext) {
          excluded.turnsWithoutComputableFraction += 1;
          bump(missingFractionBySource, session?.window?.source);
        } else {
          excluded.turnsWithoutContextReading += 1;
        }
      } else if (fraction > 1) {
        bucket.fractionMissing += 1;
        excluded.turnsWithoutComputableFraction += 1;
        excluded.turnsWithImpossibleFraction += 1;
        bump(missingFractionBySource, "impossible-above-1.0");
      } else {
        bucket.fractionTurns += 1;
        if (fraction > HIGH_CONTEXT_FRACTION) bucket.fractionHigh += 1;
        fractionWindowSources.add(String(session?.window?.source ?? "unknown"));
      }

      // Cache figures ARE flows (R4) and are summed; an absent reading is not 0.
      if (finite(turn?.cacheRead)) {
        bucket.cacheRead += turn.cacheRead;
        bucket.cacheReadCount += 1;
      }
      if (finite(turn?.cacheCreate)) {
        bucket.cacheCreate += turn.cacheCreate;
        bucket.cacheCreateCount += 1;
      }
    }
    if (!placedAny) excluded.sessionsOutsideWindow += 1;
  }

  const context = dayKeys.map((date, i) => contextRow(date, buckets[i]));
  const spend = dayKeys.map((date, i) => spendRow(date, buckets[i]));
  const cache = dayKeys.map((date, i) => cacheRow(date, buckets[i]));
  const heatmap = buildHeatmap(dayKeys, buckets);
  const trend = buildDirection({ context, cache, fractionWindowSources });

  return {
    window: {
      days,
      from: dayKeys[0],
      to: dayKeys[dayKeys.length - 1],
      // R5: stated, not implied — these numbers are local-day numbers.
      timezone: "local",
      timezoneOffsetMinutes: to.getTimezoneOffset(),
    },
    days: dayKeys,
    clis: [...clis].sort(),
    thresholds: {
      highContextFraction: HIGH_CONTEXT_FRACTION,
      cacheZones: { ...CACHE_ZONES },
    },
    charts: { context, spend, cache },
    heatmap,
    trend,
    excluded: {
      ...excluded,
      byWindowSource: Object.fromEntries([...missingFractionBySource].sort()),
      daysWithoutData: dayKeys.filter((_, i) => buckets[i].turns === 0).length,
    },
    unknowns: buildUnknowns(dayKeys, buckets, excluded, missingFractionBySource),
  };
}

// --------------------------------------------------------------------------
// G1 / G2 / G3 rows — null wherever a number would be a fabrication (R1..R3)
// --------------------------------------------------------------------------

function contextRow(date, bucket) {
  return {
    date,
    hasData: bucket.turns > 0,
    // Mean of a gauge (R4). Null when no turn on this day reported context —
    // distinct from a day whose turns genuinely measured 0 context.
    avgContextPerTurn: bucket.contextCount > 0 ? round(bucket.contextSum / bucket.contextCount, 0) : null,
    // R2: denominator counts ONLY turns with a computable fraction.
    highContextPct: bucket.fractionTurns > 0
      ? round((bucket.fractionHigh / bucket.fractionTurns) * 100, 2)
      : null,
    turns: bucket.turns,
    turnsWithContext: bucket.contextCount,
    turnsWithFraction: bucket.fractionTurns,
    turnsWithoutFraction: bucket.fractionMissing,
    turnsAboveThreshold: bucket.fractionTurns > 0 ? bucket.fractionHigh : null,
  };
}

function spendRow(date, bucket) {
  const cacheRead = bucket.cacheReadCount > 0 ? bucket.cacheRead : null;
  const cacheCreation = bucket.cacheCreateCount > 0 ? bucket.cacheCreate : null;
  return {
    date,
    hasData: bucket.turns > 0,
    cacheRead,
    cacheCreation,
    // A "total" built from one measured component and one absent one would be
    // an undercount presented as a total, so it stays null unless both sides
    // were actually read.
    total: cacheRead !== null && cacheCreation !== null ? cacheRead + cacheCreation : null,
    turnsWithCacheRead: bucket.cacheReadCount,
    turnsWithCacheCreation: bucket.cacheCreateCount,
  };
}

/** Green > 95, yellow 85..95, red < 85 — null rate has no zone. */
export function cacheZone(hitRate) {
  if (!finite(hitRate)) return null;
  if (hitRate > CACHE_ZONES.green) return "green";
  if (hitRate >= CACHE_ZONES.yellow) return "yellow";
  return "red";
}

function cacheRow(date, bucket) {
  const readMeasured = bucket.cacheReadCount > 0;
  const createMeasured = bucket.cacheCreateCount > 0;
  const read = bucket.cacheRead;
  const created = bucket.cacheCreate;
  const denominator = read + created;
  // R3: nothing in the denominator means there is no rate, not a rate of 0.
  // Both components must have been READ, too: an unmeasured creation figure is
  // not zero creation, and treating it as zero would report a flawless 100%.
  const hitRate = readMeasured && createMeasured && denominator > 0
    ? round((read / denominator) * 100, 2)
    : null;
  return {
    date,
    hasData: bucket.turns > 0,
    hitRate,
    zone: cacheZone(hitRate),
    cacheRead: readMeasured ? read : null,
    cacheCreation: createMeasured ? created : null,
  };
}

// --------------------------------------------------------------------------
// G4 heatmap
// --------------------------------------------------------------------------

/**
 * A 15 x 24 grid, ROW-MAJOR BY DAY: `grid[dayIndex][hour]`.  BP-001.13 calls
 * this "24x15" — the same 360 cells, named by its other axis.  The orientation
 * is stated in the payload (`rows`/`cols`/`orientation`) so the render layer
 * cannot transpose it by guesswork.
 *
 * A cell is the number of turns timestamped in that LOCAL day and hour.  Inside
 * a day that recorded activity, an empty hour is a measured zero and is 0.  A
 * day with no activity at all cannot be told apart from a day the collectors
 * never covered, so its whole row is null (R1) and the UI can grey it out
 * instead of drawing it as a quiet day.
 */
function buildHeatmap(dayKeys, buckets) {
  let nonZeroCells = 0;
  let maxCell = 0;
  let placedTurns = 0;
  const grid = buckets.map((bucket) => {
    if (bucket.turns === 0) return new Array(HEATMAP_HOURS).fill(null);
    return bucket.hours.map((count) => {
      if (count > 0) nonZeroCells += 1;
      if (count > maxCell) maxCell = count;
      placedTurns += count;
      return count;
    });
  });
  return {
    rows: dayKeys.length,
    cols: HEATMAP_HOURS,
    orientation: "day-major",
    days: [...dayKeys],
    hours: Array.from({ length: HEATMAP_HOURS }, (_, hour) => hour),
    grid,
    nonZeroCells,
    maxCell,
    placedTurns,
    daysWithoutData: buckets.filter((bucket) => bucket.turns === 0).length,
  };
}

// --------------------------------------------------------------------------
// trend direction — the one verdict the report prints
// --------------------------------------------------------------------------

/** First and last halves of a series' measured days; an odd middle day is dropped. */
function halves(values) {
  const half = Math.floor(values.length / 2);
  return { earlier: values.slice(0, half), later: values.slice(values.length - half) };
}

/**
 * Decide one metric's direction, or say why it cannot be decided.
 *
 * THE TWO GATES, and why each threshold is what it is rather than a round
 * number somebody liked:
 *
 *   NOISE GATE — the shift between the two halves must exceed the standard
 *     error of that shift, computed from the very days it is made of
 *     (`sqrt(var_earlier/n + var_later/n)`).  The bar therefore comes out of
 *     the data's own day-to-day scatter: a window that bounces around demands a
 *     bigger move than a steady one.  This is deliberately a ~1-sigma bar, not
 *     a 95% test: at 3..7 daily points a 2-sigma bar almost never fires, which
 *     would make `stable` a default that quietly hides real deterioration. A
 *     1-sigma bar on a single metric would call noise a trend too often, so the
 *     verdict additionally requires the two independent metrics not to
 *     disagree (see `buildDirection`) — agreement of two 1-sigma signals is a
 *     materially stricter bar than either signal alone.
 *
 *   MATERIALITY GATE — the shift must also reach MATERIALITY_POINTS (1
 *     percentage point).  Both metrics are percentages on the same 0..100
 *     scale, and the report renders them to whole-ish precision, so a shift
 *     below one point cannot change any displayed number or any threshold
 *     verdict.  This gate is what stops a window with near-zero variance (where
 *     the standard error collapses toward 0) from promoting a rounding-level
 *     difference into a trend.
 *
 *   MINIMUM DATA — each half needs MIN_DAYS_PER_HALF (3) measured days, so 6
 *     in all.  Three is the smallest n whose sample variance has more than one
 *     degree of freedom; below that the standard error above is not an estimate
 *     of anything.  Too little data returns undecidable, never "stable" —
 *     "nothing changed" and "we could not tell" are different statements.
 */
function assessMetric({ label, values, betterWhen, unit, windowSource }) {
  const measured = values.length;
  const base = { label, unit: unit ?? null, windowSource: windowSource ?? null, measuredDays: measured };
  if (measured < MIN_DAYS_PER_HALF * 2) {
    return {
      ...base,
      decidable: false,
      direction: "unknown",
      from: null,
      to: null,
      detail: `${label}: ${measured} day(s) carried a value, and ${MIN_DAYS_PER_HALF * 2} are needed to compare two halves of at least ${MIN_DAYS_PER_HALF} days`,
    };
  }
  const { earlier, later } = halves(values);
  const from = mean(earlier);
  const to = mean(later);
  const diff = to - from;
  const magnitude = Math.abs(diff);
  const standardError = Math.sqrt(variance(earlier) / earlier.length + variance(later) / later.length);
  const material = magnitude >= MATERIALITY_POINTS;
  const aboveNoise = magnitude > standardError;
  const moved = material && aboveNoise;
  const better = betterWhen === "lower" ? diff < 0 : diff > 0;
  const direction = moved ? (better ? "improving" : "declining") : "flat";
  const movement = `${round(from, 2)} -> ${round(to, 2)} ${unit ?? ""}`.trim();
  const detail = moved
    ? `${label} moved ${movement} across the window's two halves (${earlier.length} measured days each; the ${round(magnitude, 2)}-point shift clears both the ${MATERIALITY_POINTS}-point materiality floor and the ${round(standardError, 2)}-point day-to-day standard error)`
    : `${label} held steady (${movement}; the ${round(magnitude, 2)}-point shift does not clear ${!material ? `the ${MATERIALITY_POINTS}-point materiality floor` : `the ${round(standardError, 2)}-point day-to-day standard error`})`;
  return {
    ...base,
    decidable: true,
    direction,
    from: round(from, 2),
    to: round(to, 2),
    earlierDays: earlier.length,
    laterDays: later.length,
    diff: round(diff, 2),
    standardError: round(standardError, 2),
    material,
    aboveNoise,
    detail,
  };
}

function seriesValues(rows, key) {
  return rows.map((row) => row[key]).filter(finite);
}

/**
 * The report's `trend` object: `{direction, reason, metrics}` exactly per the
 * INPUT CONTRACT at the top of src/report/generator.js, plus `assessments` for
 * the UI and the tests.
 *
 * Two metrics vote: G1's "% of turns above 70% of window" (lower is better —
 * it is BP-003.01's own alarm metric, and therefore the PRIMARY one) and G3's
 * cache hit rate (higher is better).  Average context per turn deliberately
 * does NOT vote: it is an absolute token count whose meaning differs per CLI
 * and per window, so a change in which CLI the user favoured would masquerade
 * as a change in behaviour.  It stays visible in `charts.context`.
 *
 * Disagreement between the two resolves to `unknown` with the conflict named,
 * never to `stable`: "one improved while the other worsened" is not "nothing
 * changed".
 *
 * THE ASYMMETRY, which is deliberate.  `stable` is an all-clear, so it requires
 * the PRIMARY metric to have been measurable: measured on real sessions, a
 * window can easily carry 15 days of cache figures and only 5 days of
 * computable context fractions (every observed-floor turn has none, F-014), and
 * announcing "stable" off the cache alone would issue a clean bill of health
 * for a metric that was never read.  A measured MOVE is different: it is never
 * a false all-clear, so a material move in the secondary metric is reported
 * even when the primary could not be decided, with the reason saying what it
 * rests on.  Absence of evidence never becomes reassurance; evidence of
 * deterioration is never suppressed for want of a second opinion.
 */
function buildDirection({ context, cache, fractionWindowSources }) {
  const sources = [...fractionWindowSources];
  const assessments = [
    assessMetric({
      label: CONTEXT_METRIC,
      values: seriesValues(context, "highContextPct"),
      betterWhen: "lower",
      unit: "percent",
      // Only claimed when every contributing session agreed, so the report
      // never attributes one window source to a mixed measurement.
      windowSource: sources.length === 1 ? sources[0] : null,
    }),
    assessMetric({
      label: CACHE_METRIC,
      values: seriesValues(cache, "hitRate"),
      betterWhen: "higher",
      unit: "percent",
      windowSource: null,
    }),
  ];

  const metrics = assessments.map((a) => ({
    label: a.label,
    from: a.from,
    to: a.to,
    unit: a.unit,
    windowSource: a.windowSource,
  }));

  // The primary metric is the one BP-003.01 alarms on; it is listed first.
  const primary = assessments[0];
  const decidable = assessments.filter((a) => a.decidable);
  const moving = decidable.filter((a) => a.direction !== "flat");
  const flat = decidable.filter((a) => a.direction === "flat");
  const undecided = assessments.filter((a) => !a.decidable);
  const directions = new Set(moving.map((a) => a.direction));

  let direction;
  const parts = [];
  if (decidable.length === 0) {
    direction = "unknown";
    parts.push("not enough measured days to compare either metric");
  } else if (directions.size > 1) {
    direction = "unknown";
    parts.push("the metrics disagree, so no single direction is honest");
    parts.push(...moving.map((a) => a.detail));
  } else if (directions.size === 1) {
    direction = [...directions][0];
    parts.push(...moving.map((a) => a.detail), ...flat.map((a) => a.detail));
    if (!primary.decidable) {
      parts.push(`this direction rests on ${moving.map((a) => a.label).join(" and ")} alone, because the primary metric could not be decided`);
    }
  } else if (primary.decidable) {
    direction = "stable";
    parts.push(...flat.map((a) => a.detail));
  } else {
    direction = "unknown";
    parts.push(`"stable" would be an all-clear this window cannot support: nothing moved among the metrics that could be measured, but ${primary.label} — the metric the health rules alarm on — was not among them`);
    parts.push(...flat.map((a) => a.detail));
  }
  parts.push(...undecided.map((a) => a.detail));
  return { direction, reason: parts.join("; "), metrics, assessments };
}

// --------------------------------------------------------------------------
// unknowns — everything the window could NOT measure, counted (BP-005.04)
// --------------------------------------------------------------------------

function buildUnknowns(dayKeys, buckets, excluded, missingFractionBySource) {
  const unknowns = [];
  const emptyDays = dayKeys.filter((_, i) => buckets[i].turns === 0);
  if (emptyDays.length > 0) {
    unknowns.push({
      code: "days-without-data",
      count: emptyDays.length,
      detail: `no session activity was recorded on ${emptyDays.join(", ")}; those days are null in every series, not zero`,
      dates: emptyDays,
    });
  }
  if (excluded.turnsWithoutComputableFraction > 0) {
    const breakdown = [...missingFractionBySource]
      .sort()
      .map(([source, count]) => `${source}: ${count}`)
      .join(", ");
    unknowns.push({
      code: "turns-without-computable-fraction",
      count: excluded.turnsWithoutComputableFraction,
      detail: `excluded from the "% of turns above 70% of window" numerator AND denominator because no honest fraction exists for them (${breakdown}); an observed-floor window yields floor/floor = 1.0 by construction, which is an artifact and not a measurement (F-014)`,
    });
  }
  if (excluded.turnsWithoutContextReading > 0) {
    unknowns.push({
      code: "turns-without-context-reading",
      count: excluded.turnsWithoutContextReading,
      detail: "reported no context figure at all, neither absolute tokens nor a native fraction, so they are absent from the context series rather than counted as 0 tokens",
    });
  }
  if (excluded.turnsWithImpossibleFraction > 0) {
    unknowns.push({
      code: "turns-with-impossible-fraction",
      count: excluded.turnsWithImpossibleFraction,
      detail: "reported a context fraction above 1.0, which is a window-table defect and not a reading (F-008); excluded rather than counted as high context",
    });
  }
  if (excluded.turnsWithoutTimestamp > 0) {
    unknowns.push({
      code: "turns-without-timestamp",
      count: excluded.turnsWithoutTimestamp,
      detail: "carried no usable timestamp, so they cannot be placed in a local day or hour; guessing a day from the session start would attribute a whole session to one bucket",
    });
  }
  if (excluded.turnsOutsideWindow > 0) {
    unknowns.push({
      code: "turns-outside-window",
      count: excluded.turnsOutsideWindow,
      detail: `timestamped outside ${dayKeys[0]}..${dayKeys[dayKeys.length - 1]}`,
    });
  }
  if (excluded.sessionsWithoutTurns > 0) {
    unknowns.push({
      code: "sessions-without-turns",
      count: excluded.sessionsWithoutTurns,
      detail: "were collected but exposed no turns, so they contribute to no series",
    });
  }
  return unknowns;
}

export default buildTrends;
