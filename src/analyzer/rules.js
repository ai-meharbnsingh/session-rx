/**
 * BP-001.12 / BP-003 — the six health rules, declared as DATA.
 *
 * Every rule is an object carrying its own threshold, the WORDS that explain
 * how that threshold was chosen (the UI displays the derivation, so a bare
 * `0.70` is not an answer), its severity, its fix id, and an `evaluate`
 * function.  `evaluateRule` wraps a rule's raw verdict into the `RuleResult`
 * shape that `src/report/generator.js` consumes.
 *
 * THE HONESTY CONTRACT — the reason this module exists
 * ----------------------------------------------------
 * Every evaluation returns exactly one of:
 *   "observed"      the condition was measured and met
 *   "not-observed"  the condition was measured and NOT met
 *   "unknown"       the condition COULD NOT BE MEASURED from this CLI's data
 * `unknown` always carries a human-readable `reason`.  A rule that cannot be
 * computed is NEVER `not-observed` and NEVER a zero that renders as a pass:
 * turning "no evidence" into "all clear" is the single failure this product
 * exists to prevent.  Bindings that follow from that, each traceable:
 *   BP-002.18 / F-014  `window.source === "observed-floor"` ⇒ the context
 *                      fraction is unknown; floor/floor is 1.0 by construction
 *                      and would warn on every such session, including a
 *                      trivial one.
 *   BP-002.14          an `observed-promoted` window whose `promotion.ladder`
 *                      is `none` has the observed floor as its denominator, so
 *                      it falls under BP-002.18 too.
 *   DIS-005            `window.tokens` null (Kimi) ⇒ use the CLI's own native
 *                      fraction if it reported one, else unknown.  Never invent
 *                      absolute tokens from a fraction.
 *   DIS-003            no recoverable tool RESULT signature ⇒ unknown.  Never
 *                      fall back to same-input-only; that manufactures false
 *                      positives out of commands legitimately re-run.
 *   DIS-006            `toolResultBytes` null ⇒ that observation is unknown,
 *                      never counted as small.
 *   DIS-004 / F-006    sub-agent intervals are not uniformly recoverable; see
 *                      `subagentReason` for the per-CLI reasons.
 *
 * A second asymmetry runs through the file and is deliberate: a POSITIVE
 * finding stands on the observations that produced it, but a NEGATIVE verdict
 * requires FULL coverage.  Where part of a session could not be measured and
 * nothing crossed the threshold, the rule is `unknown` rather than
 * `not-observed`, because the unmeasured part is exactly where the evidence
 * would have been.
 */

import { createHash } from "node:crypto";
import { MODEL_WINDOWS_VERSION } from "../collectors/base.js";

/** The BP-003 evidence triad. Anything else is coerced to `unknown`. */
export const EVIDENCE_STATUSES = Object.freeze(["observed", "not-observed", "unknown"]);
const STATUS_SET = new Set(EVIDENCE_STATUSES);

/** Window sources whose token count is a real denominator (BP-002.11-.14). */
const MEASURED_WINDOW_SOURCES = new Set(["native", "model-table", "model-map", "observed-promoted"]);

const HOUR_MS = 3600000;

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

/** Finite number or null. A non-number never becomes a 0. */
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value) {
  return typeof value === "string" ? value : "";
}

function turnsOf(session) {
  return Array.isArray(session?.turns) ? session.turns : [];
}

function mean(values) {
  if (!values.length) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Epoch ms for an ISO-ish timestamp, or null. */
function ms(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, places = 4) {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Stable JSON with sorted object keys, so two structurally equal tool inputs
 * hash alike whatever order the parser produced their keys in.
 */
function canonicalJson(value, depth = 0) {
  if (depth > 12) return '"[depth-limit]"';
  if (value === null || typeof value !== "object") {
    return value === undefined ? "null" : JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
}

/** Bounded signature of an arbitrary value. Hashing keeps memory flat. */
function signature(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}

/** Raw-verdict builders. `magnitude` ranks sessions inside one rule; higher is worse. */
function observed(values, derivation, magnitude = null) {
  return { status: "observed", reason: null, values, derivation, magnitude };
}

function notObserved(values, derivation, magnitude = null) {
  return { status: "not-observed", reason: null, values, derivation, magnitude };
}

function unknown(reason, values = [], derivation = null) {
  return { status: "unknown", reason, values, derivation, magnitude: null };
}

/** `count` sessions/turns/whatever as an evidence row. */
function countValue(label, value) {
  return { label, value, unit: "count" };
}

function noTurnsReason(session) {
  const cli = str(session?.cli) || "this CLI";
  return `${cli} recorded no per-turn data for this session, so there is nothing to measure. An empty turn list is an absence of evidence, not a clean session.`;
}

/**
 * A session with zero tool calls, from a collector that produced no tool call
 * anywhere in this run.
 *
 * The two cases — "this session used no tools" and "this collector does not
 * surface tool calls" — are indistinguishable from inside one session, and one
 * of them is a parser gap.  Reporting a pass would be the false all-clear this
 * product exists to prevent, so corpus-level evidence decides it: `ctx`
 * carries whether ANY session collected from this CLI in this run recorded a
 * tool call (`toolCallsRecorded`).  Absent that evidence the verdict is
 * unknown.  This does make the verdict depend on how much was collected, which
 * is correct — it depends on how much was OBSERVED — and the reason says so.
 */
function zeroToolCallsReason(cli) {
  return (
    `${cli} recorded no tool call on any turn of this session, and no session collected from ${cli} in this run carried one either. ` +
    "From inside one session, a session that used no tools and a collector that does not surface tool calls look identical, and one of those is a parser gap — so this is reported as unmeasurable rather than as a clean result. " +
    "Collecting more sessions from this CLI resolves it either way."
  );
}

// ---------------------------------------------------------------------------
// BP-003.01 context-pressure
// ---------------------------------------------------------------------------

/**
 * Which denominator, if any, this session's window can honestly provide.
 *
 * @returns {{usable: boolean, reason?: string, tokens?: number, source: string}}
 */
function windowDenominator(session, ctx) {
  const window = session?.window ?? {};
  const source = str(window.source) || "unknown";
  const tokens = num(window.tokens);
  const promotionLadder = str(ctx?.promotion?.ladder) || null;

  if (source === "observed-floor") {
    return {
      usable: false,
      source,
      tokens,
      reason:
        `the window for this session is not a measured window: no model-id table entry matched ${str(session?.model) || "this model"}, ` +
        `so the only evidence available is the session's own observed peak (${tokens === null ? "unknown" : `at least ${tokens.toLocaleString("en-US")} tokens`}). ` +
        `Dividing that peak by itself gives 1.0 for every session by construction — a trivial session and a genuinely full one would both read "100% of window" — so no fraction and no threshold verdict is derived from it (BP-002.18 / F-014). The peak itself is reported below as a lower bound, because that part is true.`,
    };
  }
  if (source === "observed-promoted" && promotionLadder === "none") {
    return {
      usable: false,
      source,
      tokens,
      reason:
        "this session's observed peak exceeds every window tier known to the model table, so the window was set to the observed peak itself rather than to a real vendor tier " +
        "(promotion ladder `none`). The denominator is therefore the numerator again and BP-002.18 applies exactly as it does to `observed-floor`.",
    };
  }
  if (tokens === null || tokens <= 0) {
    return {
      usable: false,
      source,
      tokens: null,
      reason: `no absolute context window is known for this session (window.source "${source}", window.tokens ${tokens === null ? "null" : tokens}).`,
    };
  }
  if (!MEASURED_WINDOW_SOURCES.has(source)) {
    return {
      usable: false,
      source,
      tokens,
      reason: `window.source "${source}" is not one of the sources BP-002.11-BP-002.14 permit a threshold verdict from.`,
    };
  }
  return { usable: true, source, tokens };
}

const contextPressure = {
  id: "context-pressure",
  name: "Context pressure",
  description:
    "The session's average per-turn context, as a share of the window it actually had. High average context means every later turn is paying to carry the whole history.",
  threshold: {
    value: 0.7,
    derivation:
      "Warn above 0.70 — seven tenths — of the window (BP-003.01). It is a headroom budget, not a vendor-published limit: the three tenths left over have to absorb the next turn's tool output and still leave room to compact deliberately instead of being truncated mid-task. " +
      "The test is the session AVERAGE rather than the peak, because one spike near the ceiling is recoverable while a session that simply sits up there is not; the peak is reported alongside it. " +
      "Where the window itself is only a lower bound (window.source `observed-floor`, or a promotion with no known tier behind it), no fraction is computed at all: the denominator would be the numerator, every such session would read 1.00, and the warning would fire on all of them regardless of size (BP-002.18).",
  },
  severity: "warn",
  fix: "claude-auto-compact",
  evaluate(session, ctx) {
    const turns = turnsOf(session);
    if (!turns.length) return unknown(noTurnsReason(session));

    const sessionId = str(session?.sessionId) || null;
    const tokenReadings = [];
    const nativeFractions = [];
    for (const turn of turns) {
      const inputTokens = num(turn?.context?.inputTokens);
      if (inputTokens !== null) tokenReadings.push(inputTokens);
      const fraction = num(turn?.context?.fraction);
      if (fraction !== null) nativeFractions.push(fraction);
    }

    const denominator = windowDenominator(session, ctx);

    // --- absolute-window path (Claude, Codex, OpenCode with a real tier) ----
    if (denominator.usable) {
      if (!tokenReadings.length) {
        return unknown(
          `the window is known (${denominator.tokens.toLocaleString("en-US")} tokens, source "${denominator.source}") but not one turn in this session carried a context reading, so there is no numerator.`,
          [{ label: "context window", value: denominator.tokens, unit: "tokens", windowSource: denominator.source, sessionId }],
        );
      }
      const avg = mean(tokenReadings);
      const peak = Math.max(...tokenReadings);
      const avgFraction = avg / denominator.tokens;
      const peakFraction = peak / denominator.tokens;
      const values = [
        { label: "average per-turn context", value: Math.round(avg), unit: "tokens", sessionId },
        { label: "peak per-turn context", value: peak, unit: "tokens", sessionId },
        { label: "context window used as the denominator", value: denominator.tokens, unit: "tokens", windowSource: denominator.source, sessionId },
        { label: "average context as a share of the window", value: round(avgFraction), unit: "fraction", windowSource: denominator.source, sessionId },
        { label: "peak context as a share of the window", value: round(peakFraction), unit: "fraction", windowSource: denominator.source, sessionId },
        countValue("turns carrying a context reading", tokenReadings.length),
      ];
      const derivation =
        `mean and max of per-turn context.inputTokens over ${tokenReadings.length} of ${turns.length} turns, divided by the window resolved for this session ` +
        `(${denominator.tokens.toLocaleString("en-US")} tokens, source "${denominator.source}"). Turns with no context reading are excluded from the mean rather than counted as zero.`;
      return avgFraction > this.threshold.value
        ? observed(values, derivation, avgFraction)
        : notObserved(values, derivation, avgFraction);
    }

    // --- native-fraction path (DIS-005: Kimi reports a fraction, no tokens) -
    if (nativeFractions.length) {
      const avg = mean(nativeFractions);
      const peak = Math.max(...nativeFractions);
      if (peak > 1) {
        return unknown(
          `this CLI's own context fraction reads ${round(peak)} — above 1.0 — so it is not a share of the window on the 0-1 scale this rule compares against. It is neither rescaled nor clamped, because guessing its units would invent the reading. ${denominator.reason}`,
          [{ label: "highest native context fraction reported by the CLI", value: round(peak), unit: "fraction", windowSource: "native", sessionId }],
        );
      }
      const values = [
        { label: "average native context fraction reported by the CLI", value: round(avg), unit: "fraction", windowSource: "native", sessionId },
        { label: "peak native context fraction reported by the CLI", value: round(peak), unit: "fraction", windowSource: "native", sessionId },
        countValue("turns carrying a native fraction", nativeFractions.length),
      ];
      const derivation =
        `no absolute window is available for this session, so the CLI's OWN context fraction is used directly over ${nativeFractions.length} of ${turns.length} turns ` +
        "(DIS-005: the fraction is preserved and never converted into invented absolute tokens).";
      return avg > this.threshold.value
        ? observed(values, derivation, avg)
        : notObserved(values, derivation, avg);
    }

    // --- neither ------------------------------------------------------------
    const values = [];
    if (tokenReadings.length) {
      values.push({
        label: "peak per-turn context observed (a lower bound on the window, not a window)",
        value: Math.max(...tokenReadings),
        unit: "tokens",
        windowSource: denominator.source,
        sessionId,
      });
      values.push(countValue("turns carrying a context reading", tokenReadings.length));
    }
    return unknown(
      `${denominator.reason} This CLI also reported no native context fraction for the session, so there is no honest way to express context as a share of the window.`,
      values,
    );
  },
};

// ---------------------------------------------------------------------------
// BP-003.02 cache-hit
// ---------------------------------------------------------------------------

const cacheHit = {
  id: "cache-hit",
  name: "Low cache hit",
  description:
    "How much of the cacheable prompt prefix was READ back from cache rather than re-created. A low rate means the session keeps paying to rebuild a prefix it already had.",
  threshold: {
    value: 0.85,
    derivation:
      "Flag below 0.85 (BP-003.02): at least around six of every seven cacheable prefix tokens should be cache READS, not cache CREATIONS. Below that line more than one prefix token in seven is being paid for twice, which points at cache configuration or a prefix that keeps changing rather than at the size of the work. " +
      "The rate needs BOTH counters to exist: a CLI that reports reads but never reports creations would compute a flawless 1.00 out of a missing field, so a missing counter makes this rule unknown rather than a pass. A denominator of zero is unknown for the same reason — no cache traffic is not a good cache rate.",
  },
  severity: "warn",
  fix: "claude-output-hygiene",
  evaluate(session) {
    const turns = turnsOf(session);
    if (!turns.length) return unknown(noTurnsReason(session));
    const sessionId = str(session?.sessionId) || null;

    let readSum = 0;
    let createSum = 0;
    let readTurns = 0;
    let createTurns = 0;
    for (const turn of turns) {
      const read = num(turn?.cacheRead);
      const create = num(turn?.cacheCreate);
      if (read !== null) { readSum += read; readTurns += 1; }
      if (create !== null) { createSum += create; createTurns += 1; }
    }

    const cli = str(session?.cli) || "this CLI";
    if (!readTurns && !createTurns) {
      return unknown(`${cli} recorded neither a cache-read nor a cache-creation count for any turn of this session, so a hit rate cannot be formed. An absent counter is not a cache miss and is not a cache hit.`);
    }
    if (!createTurns) {
      return unknown(
        `${cli} recorded cache READS (${readSum.toLocaleString("en-US")} tokens over ${readTurns} turns) but no cache-CREATION count for any turn. Rating reads against reads alone would report a perfect 1.00 hit rate out of a missing field, which is exactly the false all-clear this rule refuses to produce.`,
        [{ label: "cache reads", value: readSum, unit: "tokens", sessionId }],
      );
    }
    if (!readTurns) {
      return unknown(
        `${cli} recorded cache CREATIONS (${createSum.toLocaleString("en-US")} tokens over ${createTurns} turns) but no cache-read count for any turn. Treating the missing reads as zero would report a 0.00 hit rate and flag the session on a field that was never recorded.`,
        [{ label: "cache creations", value: createSum, unit: "tokens", sessionId }],
      );
    }

    const denominator = readSum + createSum;
    if (denominator === 0) {
      return unknown(
        "both cache counters are present and both are zero for every turn, so there is no cache traffic to rate. 0/0 is not a hit rate, and no cache activity is not a cache problem.",
        [countValue("turns carrying cache counters", Math.max(readTurns, createTurns))],
      );
    }

    const rate = readSum / denominator;
    const values = [
      { label: "cache hit rate", value: round(rate), unit: "ratio", sessionId },
      { label: "cache reads", value: readSum, unit: "tokens", sessionId },
      { label: "cache creations", value: createSum, unit: "tokens", sessionId },
      countValue("turns carrying a cache-read count", readTurns),
      countValue("turns carrying a cache-creation count", createTurns),
    ];
    const derivation =
      `cacheRead / (cacheRead + cacheCreate) summed over the session: ${readSum.toLocaleString("en-US")} / ${denominator.toLocaleString("en-US")}. ` +
      "Turns missing a counter contribute nothing to either side rather than contributing a zero.";
    return rate < this.threshold.value
      ? observed(values, derivation, 1 - rate)
      : notObserved(values, derivation, 1 - rate);
  },
};

// ---------------------------------------------------------------------------
// BP-003.03 repeat-tool
// ---------------------------------------------------------------------------

const repeatTool = {
  id: "repeat-tool",
  name: "Repeated tool work",
  description:
    "The same tool, called with the same input, returning the same result, five or more times in one session — the session paying repeatedly for an answer it already had.",
  threshold: {
    value: 5,
    derivation:
      "Five occurrences of the same tool AND the same input AND the same result (BP-003.03). Four repeats of a cheap read can be ordinary re-checking during a change; the fifth identical ANSWER means nothing was learned from the previous four. " +
      "Same input alone is deliberately not enough — a command re-run after an edit legitimately returns something new, and counting that would manufacture a finding out of correct behaviour — so where a result signature cannot be recovered this rule reports unknown instead of falling back to input-only matching (DIS-003).",
  },
  severity: "warn",
  fix: "claude-batch-commands",
  evaluate(session, ctx) {
    const turns = turnsOf(session);
    if (!turns.length) return unknown(noTurnsReason(session));
    const sessionId = str(session?.sessionId) || null;
    const cli = str(session?.cli) || "this CLI";

    // A result signature is only attributable to ONE call: `toolResultBytes`
    // is recorded per TURN, so a turn making two calls cannot say which of
    // them produced those bytes.  Attributing it anyway would invent the
    // pairing, so those calls are counted as UNMEASURED, not as non-repeats.
    let totalCalls = 0;
    let attributableCalls = 0;
    const groups = new Map();
    for (const turn of turns) {
      const calls = Array.isArray(turn?.toolCalls) ? turn.toolCalls : [];
      totalCalls += calls.length;
      const bytes = num(turn?.toolResultBytes);
      if (calls.length !== 1 || bytes === null) continue;
      const call = calls[0];
      const name = str(call?.name).trim().toLowerCase() || "(unnamed tool)";
      const key = `${name}|${signature(call?.input ?? null)}|${bytes}`;
      attributableCalls += 1;
      const existing = groups.get(key);
      if (existing) existing.count += 1;
      else groups.set(key, { count: 1, name, bytes });
    }

    if (totalCalls === 0) {
      if (ctx?.toolCallsRecorded !== true) return unknown(zeroToolCallsReason(cli));
      return notObserved(
        [countValue("tool calls recorded in this session", 0), countValue("turns", turns.length)],
        `${cli} recorded no tool call across ${turns.length} turns of this session, while other sessions collected from ${cli} in this run did carry tool calls — so the zero is this session's own and not a gap in the parser. No tool work can repeat when none happened.`,
        0,
      );
    }
    if (attributableCalls === 0) {
      return unknown(
        `${cli} recorded ${totalCalls} tool call${totalCalls === 1 ? "" : "s"} for this session but no result signature that can be attributed to any single one of them — either the per-turn result byte length is absent (DIS-006) or every turn made more than one call, so its one byte total cannot be split between them. Same input with an unknown result is not a repeat, so this rule reports unknown rather than counting inputs alone (DIS-003).`,
        [countValue("tool calls recorded", totalCalls), countValue("calls with an attributable result signature", 0)],
      );
    }

    let worst = { count: 0, name: null, bytes: null };
    for (const group of groups.values()) if (group.count > worst.count) worst = group;

    const values = [
      countValue("highest number of identical tool call + input + result occurrences", worst.count),
      { label: "the repeated tool", value: worst.name, unit: null, sessionId },
      { label: "result size shared by those occurrences", value: worst.bytes, unit: "bytes", sessionId },
      countValue("distinct tool call + input + result combinations", groups.size),
      countValue("tool calls with an attributable result signature", attributableCalls),
      countValue("tool calls recorded in this session", totalCalls),
    ];
    const derivation =
      `grouped by normalized tool name + a sha-256 signature of the canonical tool input + the turn's result byte length, over the ${attributableCalls} of ${totalCalls} calls whose result could be attributed to exactly one call. ` +
      "The byte length stands in for the result body, which the normalized turn does not retain.";

    if (worst.count >= this.threshold.value) {
      // A positive finding stands on the calls that produced it, whatever
      // share of the session could not be measured.
      return observed(values, derivation, worst.count);
    }
    if (attributableCalls < totalCalls) {
      return unknown(
        `no group of identical tool call + input + result reached ${this.threshold.value} among the ${attributableCalls} of ${totalCalls} calls whose result could be attributed to a single call (the highest was ${worst.count}). The remaining ${totalCalls - attributableCalls} call${totalCalls - attributableCalls === 1 ? "" : "s"} shared a turn with another call, so their results cannot be separated — and unmeasured calls are exactly where a repeat would hide, so this is not reported as a clean result.`,
        values,
      );
    }
    return notObserved(values, derivation, worst.count);
  },
};

// ---------------------------------------------------------------------------
// BP-003.04 large-tool-result
// ---------------------------------------------------------------------------

const largeToolResult = {
  id: "large-tool-result",
  name: "Large tool results",
  description:
    "Tool results large enough that they dominate the context they land in, happening often enough in one session to be a habit rather than one necessary answer.",
  threshold: {
    value: 10240,
    derivation:
      "More than 10,240 bytes (10 KiB) of tool result, occurring at least 3 times in one session (BP-003.04). One large result is often the correct answer to one question; three or more is a pattern of pulling whole files and whole logs into context instead of the part that was needed. " +
      "The 3 is an OBSERVED COUNT, never a rate projected from a sample. A result whose byte length was not recorded is not counted as small (DIS-006) — it makes the rule unknown, because an unmeasured result is the most likely place for a large one to hide.",
  },
  severity: "warn",
  fix: "claude-output-hygiene",
  evaluate(session, ctx) {
    const turns = turnsOf(session);
    if (!turns.length) return unknown(noTurnsReason(session));
    const sessionId = str(session?.sessionId) || null;
    const cli = str(session?.cli) || "this CLI";
    const limit = this.threshold.value;
    const occurrencesNeeded = 3;

    let turnsWithTools = 0;
    let measured = 0;
    let oversized = 0;
    let largest = null;
    let oversizedBytes = 0;
    for (const turn of turns) {
      const calls = Array.isArray(turn?.toolCalls) ? turn.toolCalls : [];
      const bytes = num(turn?.toolResultBytes);
      if (calls.length) turnsWithTools += 1;
      if (bytes === null) continue;
      measured += 1;
      if (largest === null || bytes > largest) largest = bytes;
      if (bytes > limit) { oversized += 1; oversizedBytes += bytes; }
    }

    // The normalized turn carries ONE byte total per turn, not one per result,
    // so an "occurrence" here is a turn whose tool results together exceeded
    // the threshold.  Where a turn made a single call the two are identical.
    const values = [
      countValue(`turns whose tool results totalled more than ${limit.toLocaleString("en-US")} bytes`, oversized),
      { label: "largest tool result total in one turn", value: largest, unit: "bytes", sessionId },
      { label: "bytes in the oversized turns", value: oversizedBytes, unit: "bytes", sessionId },
      countValue("turns with a recorded result byte length", measured),
      countValue("turns that made at least one tool call", turnsWithTools),
    ];
    const derivation =
      `counted turns whose toolResultBytes exceeded ${limit.toLocaleString("en-US")}, over the ${measured} of ${turns.length} turns that carried a byte length. ` +
      "The normalized turn records one byte total per turn rather than one per tool result, so an occurrence is a turn, not a single result; for a turn with one call the two are the same.";

    if (turnsWithTools === 0 && measured === 0) {
      if (ctx?.toolCallsRecorded !== true) return unknown(zeroToolCallsReason(cli));
      return notObserved(
        [countValue("turns that made at least one tool call", 0), countValue("turns", turns.length)],
        `${cli} recorded no tool call and no result bytes across ${turns.length} turns of this session, while other sessions collected from ${cli} in this run did carry tool calls — so the zero is this session's own and not a gap in the parser. No tool result exists to be large.`,
        0,
      );
    }
    if (measured === 0) {
      return unknown(
        `${cli} recorded ${turnsWithTools} turn${turnsWithTools === 1 ? "" : "s"} with tool calls for this session but no result byte length for any of them, so result size cannot be measured. A missing byte count is not a small result (DIS-006); it is not counted at all.`,
        [countValue("turns that made at least one tool call", turnsWithTools), countValue("turns with a recorded result byte length", 0)],
      );
    }
    if (oversized >= occurrencesNeeded) {
      return observed(values, derivation, oversized);
    }
    if (measured < turnsWithTools) {
      return unknown(
        `only ${oversized} turn${oversized === 1 ? "" : "s"} exceeded ${limit.toLocaleString("en-US")} bytes, short of the ${occurrencesNeeded} needed — but ${turnsWithTools - measured} of the ${turnsWithTools} turns that made tool calls carry no result byte length at all, so the count is incomplete. An unmeasured result is the most likely place for a large one to hide, so this is not reported as a clean result.`,
        values,
      );
    }
    return notObserved(values, derivation, oversized);
  },
};

// ---------------------------------------------------------------------------
// BP-003.05 long-rising-context
// ---------------------------------------------------------------------------

/**
 * Theil-Sen slope: the MEDIAN of all pairwise slopes.
 *
 * Least squares would let one compaction cliff or one outlier turn set the
 * trend of a whole session; the median of pairwise slopes cannot be moved by a
 * minority of points.  Pairs grow with the square of the point count, so a
 * long session is evenly subsampled first and the subsampling is disclosed in
 * the derivation rather than hidden.
 *
 * @param {Array<{x: number, y: number}>} points sorted by x
 * @param {number} cap maximum points to consider
 * @returns {{slope: number|null, used: number, subsampled: boolean, pairs: number}}
 */
function theilSenSlope(points, cap = 300) {
  let used = points;
  let subsampled = false;
  if (points.length > cap) {
    const step = (points.length - 1) / (cap - 1);
    used = [];
    for (let i = 0; i < cap; i += 1) used.push(points[Math.round(i * step)]);
    subsampled = true;
  }
  const slopes = [];
  for (let i = 0; i < used.length; i += 1) {
    for (let j = i + 1; j < used.length; j += 1) {
      const dx = used[j].x - used[i].x;
      if (dx === 0) continue;
      slopes.push((used[j].y - used[i].y) / dx);
    }
  }
  return { slope: median(slopes), used: used.length, subsampled, pairs: slopes.length };
}

const longRisingContext = {
  id: "long-rising-context",
  name: "Long rising context",
  description:
    "A session that has run for hours AND whose context is still trending upward — it is not compacting, it is accumulating.",
  threshold: {
    value: "more than 4 hours elapsed AND a positive context slope over at least 3 observations",
    derivation:
      "Both conditions must hold at once (BP-003.05), because neither alone is a defect: a long session that compacts repeatedly stays flat and is healthy, and every session rises at the start. Four hours is where a session stops being one sitting. " +
      "The slope is Theil-Sen — the median of all pairwise slopes — rather than least squares, so a single compaction cliff or one outlier turn cannot set the trend of the whole session. At least 3 observations are required because any two points have a slope, which would make a two-turn session 'rising'.",
  },
  severity: "critical",
  fix: "claude-compact-contract",
  evaluate(session) {
    const turns = turnsOf(session);
    if (!turns.length) return unknown(noTurnsReason(session));
    const sessionId = str(session?.sessionId) || null;
    const minimumPoints = 3;
    const hoursNeeded = 4;

    const points = [];
    const stamps = [];
    for (const turn of turns) {
      const at = ms(turn?.ts);
      if (at !== null) stamps.push(at);
      const tokens = num(turn?.context?.inputTokens);
      if (at !== null && tokens !== null) points.push({ x: at, y: tokens });
    }
    points.sort((a, b) => a.x - b.x);

    const startedAt = ms(session?.startedAt);
    const endedAt = ms(session?.endedAt);
    let elapsedHours = null;
    let elapsedFrom = null;
    if (startedAt !== null && endedAt !== null && endedAt >= startedAt) {
      elapsedHours = (endedAt - startedAt) / HOUR_MS;
      elapsedFrom = "the session's own startedAt and endedAt";
    } else if (stamps.length >= 2) {
      elapsedHours = (Math.max(...stamps) - Math.min(...stamps)) / HOUR_MS;
      elapsedFrom = "the span between the first and last timestamped turn";
    }

    if (elapsedHours === null) {
      return unknown(
        `this session carries no usable elapsed time: startedAt is ${session?.startedAt === undefined ? "absent" : JSON.stringify(session?.startedAt ?? null)}, endedAt is ${JSON.stringify(session?.endedAt ?? null)}, and ${stamps.length} of ${turns.length} turns carry a timestamp — fewer than the two needed to span an interval. Duration is half of this rule, so no verdict follows.`,
        points.length ? [countValue("context observations available", points.length)] : [],
      );
    }
    if (points.length < minimumPoints) {
      return unknown(
        `only ${points.length} turn${points.length === 1 ? "" : "s"} in this session ${points.length === 1 ? "carries" : "carry"} BOTH a timestamp and a context reading, fewer than the ${minimumPoints} needed for a slope that is not just a line through two points. Elapsed time is known (${round(elapsedHours, 2)} hours) but a trend over ${points.length} point${points.length === 1 ? "" : "s"} would be an assertion, not a measurement.`,
        [
          { label: "session elapsed", value: round(elapsedHours, 2), unit: "hours", sessionId },
          countValue("turns carrying both a timestamp and a context reading", points.length),
        ],
      );
    }

    const { slope, used, subsampled, pairs } = theilSenSlope(points);
    const perHour = slope === null ? null : slope * HOUR_MS;
    const values = [
      { label: "session elapsed", value: round(elapsedHours, 2), unit: "hours", sessionId },
      { label: "context trend", value: perHour === null ? null : round(perHour, 1), unit: "tokens per hour", sessionId },
      countValue("context observations used for the slope", used),
      { label: "context at the first observation", value: points[0].y, unit: "tokens", sessionId },
      { label: "context at the last observation", value: points[points.length - 1].y, unit: "tokens", sessionId },
    ];
    const derivation =
      `elapsed time from ${elapsedFrom}; Theil-Sen (median of ${pairs.toLocaleString("en-US")} pairwise slopes) over (timestamp, context.inputTokens) pairs from ${used} of ${points.length} usable observations` +
      `${subsampled ? ", evenly subsampled from the full set to bound the pair count" : ""}. Both conditions are reported whether or not either is met.`;

    const rising = perHour !== null && perHour > 0;
    const long = elapsedHours > hoursNeeded;
    if (long && rising) return observed(values, derivation, perHour);
    return notObserved(values, derivation, perHour);
  },
};

// ---------------------------------------------------------------------------
// BP-003.06 subagent-concurrency
// ---------------------------------------------------------------------------

/**
 * Why an empty child list is not a zero, for a CLI whose sub-agent evidence IS
 * read.  Names the condition that actually stopped this scan from settling it
 * (F-026) and stops short of claiming that no sub-agent ran: an unscanned child
 * is not an absent child.
 *
 * The two conditions are the two halves of the measured-zero gate above, so the
 * clause states whichever one held rather than a generic "not enough data".
 */
function scanWidthClause(ctx) {
  const meta = ctx?.sessionMeta;
  const ids = meta && typeof meta === "object" ? meta.subagentSessionIds : undefined;
  if (ids === null) {
    return (
      "Sub-agent reading was switched OFF for this run, so no sub-agent transcript was looked for beside this session at all. " +
      "\"Not looked for\" is a gap in what was collected, not a finding about the session, so it is reported as unmeasurable rather than as a zero — and it is not a claim that zero sub-agents were dispatched."
    );
  }
  const looked = Array.isArray(ids)
    ? "This run did look beside this session and collected no sub-agent transcript for it. "
    : "No sub-agent session was collected for this session in this run. ";
  if (ctx?.corpusComplete !== true) {
    return (
      looked +
      "The scan was bounded rather than complete for this CLI — only part of its sessions were read — so a parent whose sub-agent transcripts fall outside that window reports an empty child list. " +
      "An unscanned child is not an absent child: widening the scan (`?scan=`) turns this into a verdict, and until then this is not a claim that zero sub-agents were dispatched (F-026)."
    );
  }
  return (
    looked +
    "No parent/child linkage row reached the analyzer for this CLI in this run, so an empty child list cannot be read as a measured zero — the linkage is what would make it one. " +
    "This is not a claim that zero sub-agents were dispatched (F-026)."
  );
}

/**
 * Why this CLI cannot establish sub-agent intervals for this session.
 *
 * Each reason names the specific missing thing, because "unknown" without a
 * reason is indistinguishable from a shrug.  Claude, Kimi and OpenCode all DO
 * read sub-agent evidence now (BP-003.07 - BP-003.09), so for them the missing
 * thing is never the parser: it is that no sub-agent was collected for THIS
 * session inside the scanned window, which is `scanWidthClause` above.  Codex
 * and Gemini publish no such evidence at all, which is structural (DIS-004).
 *
 * These strings are the product's honesty surface, so a claim here that has
 * gone stale is a defect: it sends a reader to fix something already fixed.
 */
function subagentReason(session, ctx) {
  const cli = str(session?.cli);
  const sidechainTurns = ctx?.sidechainTurns ?? 0;
  switch (cli) {
    case "claude":
      return (
        "Claude's sub-agent transcripts ARE read: `src/collectors/claude.js` reads `<project-slug>/<session-id>/subagents/agent-*.jsonl` and turns each one it collects into a child session carrying its own start and end, which is what lets this rule return a figure at all (BP-003.07). " +
        `The \`isSidechain\` marker is not a substitute, which is why an empty child list is never read off it: the marker is never \`true\` in a main transcript (BP-003.07 measured true=0 against false=138,358), so the sidechain-marked turn count recorded here (${sidechainTurns}) is not a measurement of how many sub-agents ran, and a zero there would be a false all-clear rather than a finding. The marker also carries no sub-agent identity and no start or end, so even a turn that does carry it cannot be attributed to one sub-agent or overlapped with another (DIS-004). ` +
        scanWidthClause(ctx)
      );
    case "opencode":
      return (
        "OpenCode does link a child session to its parent (`sessionMeta.parentSessionId`), and no child session in the collected set names this session as its parent. " +
        "The collected set is bounded by the collection limit and by the time window, so an empty child list here is not proof that no sub-agent was dispatched — only that none was collected."
      );
    case "kimi":
      return (
        "Kimi's sub-agent records ARE read: `SubagentEvent`, keyed by `task_tool_call_id` and a large share of all its records, nests a complete sub-agent wire stream, and `src/collectors/kimi.js` unwraps each one into a child session carrying its own start and end (BP-003.08). " +
        "So an empty child list here is not the parser gap F-006 once described — that gap is closed, and this rule now produces real concurrency figures for Kimi. " +
        scanWidthClause(ctx)
      );
    case "codex":
      return "Nothing in Codex's rollout records establishes a sub-agent interval: there is no sidechain marker and no parent/child session linkage to overlap (DIS-004).";
    case "gemini":
      return "Nothing in Gemini's history records establishes a sub-agent interval: there is no sidechain marker and no parent/child session linkage to overlap (DIS-004).";
    default:
      return `no sidechain marker and no parent/child session linkage is available for ${cli || "this CLI"}, so sub-agent intervals cannot be established (DIS-004).`;
  }
}

/** Peak simultaneous intervals, by sweeping starts and ends in time order. */
function peakOverlap(intervals) {
  const events = [];
  for (const interval of intervals) {
    events.push({ at: interval.start, delta: 1 });
    events.push({ at: interval.end, delta: -1 });
  }
  // An end at exactly the same instant as a start is processed FIRST: a
  // sub-agent that finished as the next one began was never concurrent with it.
  events.sort((a, b) => (a.at - b.at) || (a.delta - b.delta));
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

const subagentConcurrency = {
  id: "subagent-concurrency",
  name: "High sub-agent concurrency",
  description:
    "How many sub-agents were running at the same moment, against how many the session dispatched in total — a burst of parallel workers rather than staged work.",
  threshold: {
    value: 0.5,
    derivation:
      "Warn when the peak number of simultaneous sub-agents exceeds 0.50 of the number that session dispatched (BP-003.06). The ratio is against the session's OWN dispatched count rather than a fixed worker cap, because 3 running out of 4 dispatched is a deliberate fan-out while 3 out of 12 is an orderly queue. Half is the line where the work stops being staged and becomes a burst. " +
      "This needs real intervals: a marker saying a turn belonged to some sub-agent, with no identity and no start or end, cannot establish what overlapped what — so where intervals are not recoverable this rule is unknown, never a zero.",
  },
  severity: "warn",
  fix: "claude-worker-cap",
  evaluate(session, ctx) {
    const sessionId = str(session?.sessionId) || null;
    const children = Array.isArray(ctx?.children) ? ctx.children : [];
    const dispatched = children.length;

    if (dispatched === 0) {
      // A measured zero is only honest when the whole corpus was scanned: with
      // a collection limit in force, a child session may simply not have been
      // collected.
      if (ctx?.childLinkageAvailable === true && ctx?.corpusComplete === true) {
        return notObserved(
          [countValue("sub-agent sessions linked to this session", 0)],
          "this CLI publishes a parent/child session linkage, the scan was not cut short by the collection limit, and no session names this one as its parent. This is a measured zero, not a missing field.",
          0,
        );
      }
      return unknown(subagentReason(session, ctx), ctx?.sidechainTurns ? [countValue("turns marked as belonging to a sub-agent", ctx.sidechainTurns)] : []);
    }

    const intervals = [];
    let withoutInterval = 0;
    for (const child of children) {
      const start = ms(child?.startedAt);
      const end = ms(child?.endedAt);
      if (start === null || end === null || end < start) { withoutInterval += 1; continue; }
      intervals.push({ start, end });
    }

    if (!intervals.length) {
      return unknown(
        `${dispatched} sub-agent session${dispatched === 1 ? " is" : "s are"} linked to this session, but not one of them carries both a start and an end time, so nothing can be overlapped. The dispatched count alone says how many ran, never how many ran at once.`,
        [countValue("sub-agent sessions linked to this session", dispatched), countValue("linked sub-agent sessions with a usable interval", 0)],
      );
    }

    const peak = peakOverlap(intervals);
    const ratio = peak / dispatched;
    const values = [
      countValue("peak sub-agents running at the same time", peak),
      countValue("sub-agent sessions dispatched by this session", dispatched),
      { label: "peak concurrency as a share of dispatched", value: round(ratio), unit: "fraction", sessionId },
      countValue("linked sub-agent sessions with a usable interval", intervals.length),
    ];
    const derivation =
      `swept the start and end times of the ${intervals.length} of ${dispatched} linked sub-agent sessions that carry a usable interval, taking the highest number open at once; ` +
      "an end at the same instant as a start is treated as NOT concurrent. The dispatched count is this session's own, not a global default.";

    if (ratio > this.threshold.value) return observed(values, derivation, ratio);
    if (withoutInterval > 0) {
      return unknown(
        `peak concurrency reached ${peak} of ${dispatched} dispatched (${round(ratio)}), below the ${this.threshold.value} line — but ${withoutInterval} of those ${dispatched} sub-agent sessions carry no usable start/end, so the real peak can only be higher than the ${peak} measured here. A ceiling computed from part of the evidence is not a pass.`,
        values,
      );
    }
    return notObserved(values, derivation, ratio);
  },
};

/** BP-003.01 - BP-003.06, in blueprint order. */
export const RULES = Object.freeze([
  contextPressure,
  cacheHit,
  repeatTool,
  largeToolResult,
  longRisingContext,
  subagentConcurrency,
]);

/**
 * Evidence references for a session. The normalized session carries no source
 * FILE path (BP-002 has no slot for one), so the reference is the CLI and
 * session id, plus the project and cwd when the collector recorded them.
 */
function sessionSources(session) {
  const sources = [`${str(session?.cli) || "unknown-cli"} session ${str(session?.sessionId) || "(no session id)"}`];
  const project = str(session?.project);
  if (project) sources.push(`project ${project}`);
  const cwd = str(session?.cwd);
  if (cwd && cwd !== project) sources.push(cwd);
  return sources;
}

/**
 * Evaluate one rule against one session and return its `RuleResult`.
 *
 * The envelope is built HERE rather than inside each rule, so that every rule
 * is guaranteed to emit the same shape, a valid status, and a reason whenever
 * the status is `unknown` — including when a rule body throws, which becomes
 * `unknown` carrying the error text.  A rule that crashes must never look like
 * a rule that passed.
 *
 * @param {object} rule one of `RULES`
 * @param {object} session a `NormalizedSession`
 * @param {{parserVersion?: string, sources?: string[], promotion?: object|null,
 *   children?: Array<object>|null, childLinkageAvailable?: boolean,
 *   corpusComplete?: boolean, sidechainTurns?: number,
 *   toolCallsRecorded?: boolean}} [ctx]
 * @returns {object} `RuleResult` per the report generator's input contract,
 *   plus `magnitude` — an analyzer-internal "how bad" number used to rank
 *   sessions within one rule, which the generator ignores.
 */
export function evaluateRule(rule, session, ctx = {}) {
  const parserVersion = str(ctx?.parserVersion) || MODEL_WINDOWS_VERSION;
  const sources = Array.isArray(ctx?.sources) ? ctx.sources : sessionSources(session);

  let raw;
  try {
    raw = rule.evaluate(session ?? {}, ctx ?? {});
  } catch (error) {
    raw = {
      status: "unknown",
      reason: `evaluating this rule threw: ${error instanceof Error ? error.message : String(error)}. A rule that could not finish is reported as unmeasurable, never as a pass.`,
      values: [],
      derivation: null,
      magnitude: null,
    };
  }

  const status = STATUS_SET.has(raw?.status) ? raw.status : "unknown";
  let reason = status === "unknown" ? str(raw?.reason).trim() : "";
  if (status === "unknown" && !reason) {
    reason = STATUS_SET.has(raw?.status)
      ? "this rule returned unknown without recording a reason; it could not be evaluated and is NOT a pass."
      : `this rule returned the unrecognised status ${JSON.stringify(raw?.status ?? null)}, which is not one of observed / not-observed / unknown, so it is treated as unmeasurable rather than trusted.`;
  }

  return {
    id: rule.id,
    name: rule.name,
    severity: rule.severity,
    fix: rule.fix ?? null,
    threshold: { value: rule.threshold.value, derivation: rule.threshold.derivation },
    magnitude: num(raw?.magnitude),
    evidence: {
      status,
      reason: status === "unknown" ? reason : null,
      values: Array.isArray(raw?.values) ? raw.values : [],
      sources,
      derivation: str(raw?.derivation) || null,
      parserVersion,
    },
  };
}

export default RULES;
