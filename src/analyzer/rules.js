/**
 * BP-001.12 / BP-003 — the six health rules, declared as DATA.
 *
 * Every rule is an object carrying its own threshold, the WORDS that explain
 * how that threshold was chosen (the UI displays the derivation, so a bare
 * `0.70` is not an answer), its severity, its fix id, a `plain` block in
 * ordinary English (BP-005.19-style: one catalogue, so the health page renders
 * this text rather than keeping a second copy of it), and an `evaluate`
 * function.  The `plain` block has three parts: `problem` and `why` for a
 * finding, and `unmeasured` — a MAP from reason class to sentence — for a check
 * that could not run.  It is a map, not one string, because a rule goes
 * unmeasured for several different causes and one sentence would be false for
 * the others; `evaluate` names the cause it hit as `reasonCode`, which travels
 * beside the prose `reason` and is what the page looks the sentence up by.  `evaluateRule` wraps a rule's raw verdict into the
 * `RuleResult` shape that `src/report/generator.js` consumes.
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

/**
 * `reason` is the prose evidence of record and is never reworded to suit a
 * renderer.  `reasonCode` travels BESIDE it as a stable class name for the
 * SAME cause, so the health page can look up a plain-English sentence for it
 * (`plain.unmeasured[reasonCode]`) without parsing the prose.  A cause with no
 * class of its own is `"default"`, which every rule's catalogue answers.
 */
function unknown(reason, values = [], reasonCode = "default", derivation = null) {
  return { status: "unknown", reason, reasonCode, values, derivation, magnitude: null };
}

/**
 * Unmeasured causes that belong to no single rule, spread into every rule's
 * `plain.unmeasured` so the lookup never falls through to a sentence about
 * something else.  `rule-threw` is raised by `evaluateRule`, not by a rule.
 */
const SHARED_UNMEASURED = Object.freeze({
  "rule-threw":
    "This check itself stopped part-way through and never reached an answer about this session. A check that failed to finish is reported as unmeasured, never as a pass.",
});

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
      code: "window-is-observed-peak",
      reason:
        `the window for this session is not a measured window: no model-id table entry matched ${str(session?.model) || "this model"}, ` +
        `so the only evidence available is the session's own observed peak (${tokens === null ? "unknown" : `at least ${tokens.toLocaleString("en-US")} tokens`}). ` +
        `Dividing that peak by itself gives 1.0 for every session by construction — a trivial session and a genuinely full one would both read "100% of window" — so no share of the window and no comparison against the threshold is derived from it (BP-002.18 / F-014). The peak itself is reported below as a lower bound, because that part is true.`,
    };
  }
  if (source === "observed-promoted" && promotionLadder === "none") {
    return {
      usable: false,
      source,
      tokens,
      code: "window-above-known-tiers",
      reason:
        "this session's observed peak exceeds every window tier known to the model table, so the window was set to the observed peak itself rather than to a real vendor tier " +
        "(promotion ladder `none`). The figure being divided and the figure it is divided by are therefore the same number again, and BP-002.18 applies exactly as it does to `observed-floor`.",
    };
  }
  if (tokens === null || tokens <= 0) {
    return {
      usable: false,
      source,
      tokens: null,
      code: "window-size-unknown",
      reason: `no absolute context window is known for this session (window.source "${source}", window.tokens ${tokens === null ? "null" : tokens}).`,
    };
  }
  if (!MEASURED_WINDOW_SOURCES.has(source)) {
    return {
      usable: false,
      source,
      tokens,
      code: "window-source-unsupported",
      reason: `window.source "${source}" is not one of the sources BP-002.11-BP-002.14 permit a threshold comparison from.`,
    };
  }
  return { usable: true, source, tokens, code: null };
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
      "Where the window itself is only a lower bound (window.source `observed-floor`, or a promotion with no known tier behind it), no fraction is computed at all: the session's own peak would be divided by itself, every such session would read 1.00, and the warning would fire on all of them regardless of size (BP-002.18).",
  },
  severity: "warn",
  fix: "claude-auto-compact",
  // BP-005.19-style single catalogue, now for wording: the plain-language text
  // lives HERE, not in public/js/pages/health.js, so there is one place that
  // knows what this rule means in words. `{pct}`/`{count}` are the only
  // tokens the page substitutes, filled from this RuleResult's own
  // `magnitude` — never a number invented on the client.
  plain: {
    problem:
      "Your AI's context has been averaging {pct} of its available window in this session. When context runs this high, older parts of the conversation are more likely to get pushed out, summarized, or dropped before they should be.",
    why:
      "This is a warning about headroom, not proof that anything went wrong — a big task can legitimately use a lot of context. It flags sessions where compacting the conversation, or splitting the task into smaller pieces, would likely help.",
    // One sentence per CAUSE, because this rule goes unmeasured for several
    // different reasons and a single sentence would be false for the others.
    // The renderer picks by `evidence.reasonCode` and falls back to `default`.
    unmeasured: {
      ...SHARED_UNMEASURED,
      default:
        "There was no honest way to express this session's context as a share of the window it had, so how close it ran to its limit is not known. That is an open question about this session, not a clean result.",
      "no-turns":
        "This tool saved no per-turn record for the session, so nothing says how much context any turn was carrying. The context question stays open — it is not answered in the session's favour.",
      "no-context-readings":
        "The size of this session's window is known, but not one of its turns recorded how much context it was actually holding, so there is no number to compare against that window. A tool that reports context usage turn by turn would make this measurable.",
      "native-fraction-out-of-range":
        "The only context figure this tool reported is not on a nought-to-one scale, so it cannot be read as a share of the window, and rescaling it would mean guessing what it counts. The reading is left alone rather than bent into an answer, which leaves the question of how full this session ran open.",
      "window-is-observed-peak":
        "No published window size was found for the model this session ran on, so the largest amount of context it was seen holding is all there is to go on. Comparing that peak against itself would say \"100% of the window\" for every session, large or small, so no share is worked out at all. Adding this model to the built-in table of window sizes would make it measurable.",
      "window-above-known-tiers":
        "This session held more context than any window size known for its model, so the largest amount it was seen holding had to stand in for the window itself. That makes the comparison a number divided by itself, which would read as completely full for every such session, so no share is worked out. An up-to-date window size for this model would make it measurable.",
      "window-size-unknown":
        "Nothing recorded for this session says how large its context window was, and the tool reported no share of its own either, so there is no way to say how full it ran. A recorded window size, or a share the tool reports itself, would make this measurable.",
      "window-source-unsupported":
        "The window size on record for this session came from a source that is not trusted to carry a threshold judgement, so it is not used as the basis for one. Until the window is read from the tool itself, or matched to a published size for the model, how full this session ran stays unknown.",
    },
  },
  evaluate(session, ctx) {
    const turns = turnsOf(session);
    if (!turns.length) return unknown(noTurnsReason(session), [], "no-turns");

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
          `the window is known (${denominator.tokens.toLocaleString("en-US")} tokens, source "${denominator.source}") but not one turn in this session carried a context reading, so there is nothing to express as a share of it.`,
          [{ label: "context window", value: denominator.tokens, unit: "tokens", windowSource: denominator.source, sessionId }],
          "no-context-readings",
        );
      }
      const avg = mean(tokenReadings);
      const peak = Math.max(...tokenReadings);
      const avgFraction = avg / denominator.tokens;
      const peakFraction = peak / denominator.tokens;
      const values = [
        { label: "average per-turn context", value: Math.round(avg), unit: "tokens", sessionId },
        { label: "peak per-turn context", value: peak, unit: "tokens", sessionId },
        { label: "context window the shares below are measured against", value: denominator.tokens, unit: "tokens", windowSource: denominator.source, sessionId },
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
          "native-fraction-out-of-range",
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
      denominator.code ?? "default",
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
      "The rate needs BOTH counters to exist: a CLI that reports reads but never reports creations would compute a flawless 1.00 out of a missing field, so a missing counter makes this rule unknown rather than a pass. Nothing to divide by is unknown for the same reason — no cache traffic is not a good cache rate.",
  },
  severity: "warn",
  fix: "claude-output-hygiene",
  plain: {
    problem:
      "About {pct} of this session's reusable prompt content had to be rebuilt from scratch instead of being read back from cache.",
    why:
      "A low cache hit rate usually means the reusable part of the prompt — system instructions, tool descriptions, file contents — kept changing between calls, or caching could not take advantage of a stable prefix. It is not a sign that the task itself was done wrong.",
    unmeasured: {
      ...SHARED_UNMEASURED,
      default:
        "How much of this session's reusable prompt content was reused rather than rebuilt could not be worked out from what the tool recorded, so whether it kept paying to rebuild the same content is still an open question.",
      "no-turns":
        "This tool saved no per-turn record for the session, so nothing says how much prompt content was read back from cache and how much was built again from scratch. The question stays open rather than answered.",
      "no-cache-counters":
        "This tool recorded neither how much prompt content was read back from cache nor how much was built fresh, so there is no reuse rate to work out. A figure that was never recorded is not a hit and not a miss. A tool that reports both cache numbers would make this measurable.",
      "no-cache-creation-counter":
        "This tool recorded how much prompt content was read back from cache but never how much was built fresh, so there is nothing to compare those reads against. Scoring reads against reads alone would report flawless reuse out of a number that was never recorded, so no rate is given.",
      "no-cache-read-counter":
        "This tool recorded how much prompt content was built fresh but never how much was read back from cache, so a reuse rate cannot be formed. Treating the missing reads as zero would flag this session on a number that was never recorded, so no rate is given.",
      "no-cache-traffic":
        "Both cache numbers were recorded for this session and both are zero on every turn, so there was no cache activity to rate at all. No cache traffic is not a good cache result and is not scored as one.",
    },
  },
  evaluate(session) {
    const turns = turnsOf(session);
    if (!turns.length) return unknown(noTurnsReason(session), [], "no-turns");
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
      return unknown(
        `${cli} recorded neither a cache-read nor a cache-creation count for any turn of this session, so a hit rate cannot be formed. An absent counter is not a cache miss and is not a cache hit.`,
        [],
        "no-cache-counters",
      );
    }
    if (!createTurns) {
      return unknown(
        `${cli} recorded cache READS (${readSum.toLocaleString("en-US")} tokens over ${readTurns} turns) but no cache-CREATION count for any turn. Rating reads against reads alone would report a perfect 1.00 hit rate out of a missing field, which is exactly the false all-clear this rule refuses to produce.`,
        [{ label: "cache reads", value: readSum, unit: "tokens", sessionId }],
        "no-cache-creation-counter",
      );
    }
    if (!readTurns) {
      return unknown(
        `${cli} recorded cache CREATIONS (${createSum.toLocaleString("en-US")} tokens over ${createTurns} turns) but no cache-read count for any turn. Treating the missing reads as zero would report a 0.00 hit rate and flag the session on a field that was never recorded.`,
        [{ label: "cache creations", value: createSum, unit: "tokens", sessionId }],
        "no-cache-read-counter",
      );
    }

    const denominator = readSum + createSum;
    if (denominator === 0) {
      return unknown(
        "both cache counters are present and both are zero for every turn, so there is no cache traffic to rate. 0/0 is not a hit rate, and no cache activity is not a cache problem.",
        [countValue("turns carrying cache counters", Math.max(readTurns, createTurns))],
        "no-cache-traffic",
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
    "The same tool, called with the same input, returning a result of the same size, five or more times in one session — the session paying again for an answer that shows no sign of having changed.",
  threshold: {
    value: 5,
    derivation:
      "Five occurrences of the same tool AND the same input AND a result of the same SIZE (BP-003.03). Four repeats of a cheap read can be ordinary re-checking during a change; a fifth call whose result is the same size again means nothing measurable changed across any of them. " +
      "Same input alone is deliberately not enough — a command re-run after an edit usually returns an answer of a different length, and counting input alone would manufacture a finding out of correct behaviour — so where no result size can be attributed to a single call this rule reports unknown instead of falling back to input-only matching (DIS-003). " +
      "What is matched is the result's LENGTH, not its body, because the normalized turn keeps only the length: two different results that happen to be the same size are grouped together, so an edit that leaves the length unchanged is counted as a repeat here. That is why the finding is stated as a detected repetition rather than as confirmed waste.",
  },
  severity: "warn",
  fix: "claude-batch-commands",
  plain: {
    problem:
      "Your AI made the same tool call — same tool, same input, and a result of the same size — {count} times in this session.",
    why:
      "This may indicate wasted work, but repeated calls are not always unnecessary — a command can legitimately return the same answer more than once. This is a DETECTED REPETITION, not CONFIRMED WASTE: it is worth checking whether anything should have changed between those calls before assuming time was lost.",
    unmeasured: {
      ...SHARED_UNMEASURED,
      default:
        "Whether this session kept redoing the same piece of work could not be worked out from what was recorded, so that question is still open about this session.",
      "no-turns":
        "This tool saved no per-turn record for the session, so there is no list of what it did and nothing that could be checked for repeats. That leaves the question open rather than settling it.",
      "no-tool-calls-anywhere":
        "No tool call was recorded on any turn of this session, and none was recorded for any other session read from this tool either — so a session that genuinely used no tools and a reader that cannot see tool calls look exactly the same from here. Reading more sessions from this tool settles which it is.",
      "no-attributable-results":
        "Tool calls were recorded for this session, but no result could be tied to one specific call: either the size of each result is missing, or several calls share a turn and the single figure recorded for that turn cannot be split between them. The same command with an unknown answer is not proof of a repeat, so nothing is counted rather than counting the commands alone.",
      "partial-result-coverage":
        "Nothing repeated often enough to flag among the calls whose results could be matched up, but some calls shared a turn with another and their results cannot be told apart. Those unchecked calls are exactly where a repeat would be hiding, so this is left open rather than reported as clean.",
    },
  },
  evaluate(session, ctx) {
    const turns = turnsOf(session);
    if (!turns.length) return unknown(noTurnsReason(session), [], "no-turns");
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
      if (ctx?.toolCallsRecorded !== true) return unknown(zeroToolCallsReason(cli), [], "no-tool-calls-anywhere");
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
        "no-attributable-results",
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
        "partial-result-coverage",
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
  plain: {
    problem:
      "This session pulled in an unusually large tool result {count} separate times, each one big enough on its own to crowd out other context.",
    why:
      "One large result answering one real question is normal. Several large results in one session usually means a whole file or a whole log was read in rather than just the part that was needed.",
    unmeasured: {
      ...SHARED_UNMEASURED,
      default:
        "How much this session pulled in from the things it read could not be worked out from what was recorded, so whether oversized results were a habit here is still an open question.",
      "no-turns":
        "This tool saved no per-turn record for the session, so nothing says how much anything it read returned. The size of what came back is unknown rather than counted as small.",
      "no-tool-calls-anywhere":
        "No tool call was recorded on any turn of this session, and none was recorded for any other session read from this tool either — so a session that genuinely used no tools and a reader that cannot see tool calls look exactly the same from here. Reading more sessions from this tool settles which it is.",
      "no-result-sizes":
        "This session did read things, but the size of what came back was never recorded for any of them, so oversized results cannot be counted. A result of unrecorded size is not treated as a small one and is not counted at all, which leaves this open.",
      "partial-result-sizes":
        "Too few oversized results were found to flag this session, but some of the things it read have no recorded result size at all, so the count is incomplete. An unmeasured result is the likeliest place for a large one to be hiding, so this is left open rather than reported as clean.",
    },
  },
  evaluate(session, ctx) {
    const turns = turnsOf(session);
    if (!turns.length) return unknown(noTurnsReason(session), [], "no-turns");
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
      if (ctx?.toolCallsRecorded !== true) return unknown(zeroToolCallsReason(cli), [], "no-tool-calls-anywhere");
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
        "no-result-sizes",
      );
    }
    if (oversized >= occurrencesNeeded) {
      return observed(values, derivation, oversized);
    }
    if (measured < turnsWithTools) {
      return unknown(
        `only ${oversized} turn${oversized === 1 ? "" : "s"} exceeded ${limit.toLocaleString("en-US")} bytes, short of the ${occurrencesNeeded} needed — but ${turnsWithTools - measured} of the ${turnsWithTools} turns that made tool calls carry no result byte length at all, so the count is incomplete. An unmeasured result is the most likely place for a large one to hide, so this is not reported as a clean result.`,
        values,
        "partial-result-sizes",
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
  plain: {
    problem:
      "This session has been running for more than four hours, and its context size keeps climbing rather than levelling off or shrinking.",
    why:
      "A long session is fine by itself if it periodically compacts its context. This only fires when BOTH the length and the upward trend hold together — a session that runs long but stays flat is not flagged, and a session that spikes briefly and then compacts is not flagged either.",
    unmeasured: {
      ...SHARED_UNMEASURED,
      default:
        "Whether this session both ran long AND kept piling up context could not be worked out from what was recorded, so that pairing is still an open question here.",
      "no-turns":
        "This tool saved no per-turn record for the session, so there is neither a timeline nor a series of context sizes to look at. Both halves of this check are missing, so it stays open.",
      "no-elapsed-time":
        "Nothing recorded for this session says when it began and ended, and too few of its turns carry a time for one to be worked out, so how long it ran is unknown. How long it ran is half of this check, so no result follows. Times on the turns, or a recorded start and finish, would make it measurable.",
      "too-few-context-points":
        "How long this session ran is known, but too few of its turns carry both a time and a context size for a trend to mean anything — a line drawn through one or two points is an assertion, not a measurement. Three or more turns carrying both would make the trend measurable.",
      "context-times-identical":
        "How long this session ran is known, and it saved enough context readings to draw a trend through, but every one of them carries the same time — so there is no gap between any two readings to measure a rise or a fall across. Readings taken at different times would make the trend measurable; readings that all share one time leave it open.",
    },
  },
  evaluate(session) {
    const turns = turnsOf(session);
    if (!turns.length) return unknown(noTurnsReason(session), [], "no-turns");
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
        `this session carries no usable elapsed time: startedAt is ${session?.startedAt === undefined ? "absent" : JSON.stringify(session?.startedAt ?? null)}, endedAt is ${JSON.stringify(session?.endedAt ?? null)}, and ${stamps.length} of ${turns.length} turns carry a timestamp — fewer than the two needed to span an interval. Duration is half of this rule, so this rule cannot be decided either way.`,
        points.length ? [countValue("context observations available", points.length)] : [],
        "no-elapsed-time",
      );
    }
    if (points.length < minimumPoints) {
      return unknown(
        `only ${points.length} turn${points.length === 1 ? "" : "s"} in this session ${points.length === 1 ? "carries" : "carry"} BOTH a timestamp and a context reading, fewer than the ${minimumPoints} needed for a slope that is not just a line through two points. Elapsed time is known (${round(elapsedHours, 2)} hours) but a trend over ${points.length} point${points.length === 1 ? "" : "s"} would be an assertion, not a measurement.`,
        [
          { label: "session elapsed", value: round(elapsedHours, 2), unit: "hours", sessionId },
          countValue("turns carrying both a timestamp and a context reading", points.length),
        ],
        "too-few-context-points",
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

    // A slope exists only where two observations are separated in time. When
    // every pair spans zero time, Theil-Sen takes the median of an EMPTY set
    // of slopes and returns null — which is not a flat trend, it is no trend
    // at all. Half of this rule was never measured, so it cannot pass.
    if (slope === null) {
      return unknown(
        `elapsed time is known (${round(elapsedHours, 2)} hours), but every one of the ${used} context observation${used === 1 ? "" : "s"} used for the trend carries the same time (${new Date(points[0].x).toISOString()}), so each pair of them spans zero time and no rate of change can be worked out from them. A trend that could not be computed is not a flat one, so no result follows.`,
        values,
        "context-times-identical",
      );
    }

    const rising = perHour > 0;
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
      "An unscanned child is not an absent child: widening the scan (`?scan=`) turns this into an answer, and until then this is not a claim that zero sub-agents were dispatched (F-026)."
    );
  }
  return (
    looked +
    "No record tying a sub-agent session back to the session that dispatched it reached the analyzer for this CLI in this run, so an empty child list cannot be read as a measured zero — that record is what would make it one. " +
    "This is not a claim that zero sub-agents were dispatched (F-026)."
  );
}

/**
 * The reason CLASS behind `scanWidthClause`, branch for branch.
 *
 * Kept as a separate function rather than folded into the clause builder so
 * that the prose above stays byte-identical: it is the evidence of record, and
 * this is only a lookup key for the plain-English sentence beside it.
 *
 * @returns {string} a key of `subagentConcurrency.plain.unmeasured`
 */
function scanWidthCode(ctx) {
  const meta = ctx?.sessionMeta;
  const ids = meta && typeof meta === "object" ? meta.subagentSessionIds : undefined;
  if (ids === null) return "subagent-reading-off";
  if (ctx?.corpusComplete !== true) return "scan-bounded";
  return "no-subagent-collected";
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
        `The \`isSidechain\` marker is not a substitute, which is why an empty child list is never read off it: the marker is never \`true\` in a main transcript (BP-003.07 measured true=0 against false=138,358), so the count of marked turns recorded here (${sidechainTurns}) is not a measurement of how many sub-agents ran, and a zero there would be a false all-clear rather than a finding. The marker also carries no sub-agent identity and no start or end, so even a turn that does carry it cannot be attributed to one sub-agent or overlapped with another (DIS-004). ` +
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
      return "Nothing in Codex's rollout records establishes a sub-agent interval: no turn is marked as belonging to a sub-agent, and nothing ties a child session to the session that dispatched it, so there are no intervals to overlap (DIS-004).";
    case "gemini":
      return "Nothing in Gemini's history records establishes a sub-agent interval: no turn is marked as belonging to a sub-agent, and nothing ties a child session to the session that dispatched it, so there are no intervals to overlap (DIS-004).";
    default:
      return `no turn marker and no record tying a child session to the session that dispatched it is available for ${cli || "this CLI"}, so sub-agent intervals cannot be established (DIS-004).`;
  }
}

/**
 * The reason CLASS behind `subagentReason`, branch for branch.
 *
 * Codex and Gemini get one each rather than sharing the structural class,
 * because the plain-English sentence names the tool and `plain.unmeasured` is
 * static data that cannot interpolate one.
 *
 * @returns {string} a key of `subagentConcurrency.plain.unmeasured`
 */
function subagentReasonCode(session, ctx) {
  switch (str(session?.cli)) {
    case "claude":
    case "kimi":
      return scanWidthCode(ctx);
    case "opencode":
      return "no-subagent-collected";
    case "codex":
      return "codex-records-no-subagents";
    case "gemini":
      return "gemini-records-no-subagents";
    default:
      return "cli-records-no-subagents";
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
      "The ratio is only consulted once at least TWO sub-agents were open at the same moment, because one sub-agent running alone is not concurrent with anything — yet one of one dispatched works out to the whole of it and would cross any ratio line ever drawn here. A peak of one is reported as nothing found, never as a burst. " +
      "This needs real intervals: a marker saying a turn belonged to some sub-agent, with no identity and no start or end, cannot establish what overlapped what — so where intervals are not recoverable this rule is unknown, never a zero.",
  },
  severity: "warn",
  fix: "claude-worker-cap",
  plain: {
    problem:
      "At its busiest moment, this session had sub-agents running at the same time equal to {pct} of everything it dispatched — a burst of parallel work rather than one thing at a time.",
    why:
      "Running several sub-agents at once can be a deliberate and efficient way to fan work out. This only flags it when at least two of them were genuinely running together AND more than half of what was dispatched was active at the same moment — one sub-agent working on its own is never flagged, whatever share of the session's dispatches it happens to be — so it is worth a quick check that the burst was intentional rather than accidental.",
    unmeasured: {
      ...SHARED_UNMEASURED,
      default:
        "Whether this session had several sub-agents running at the same moment could not be worked out from what was recorded, so that question is still open about this session.",
      "codex-records-no-subagents":
        "Codex's logs don't record which turns belonged to a sub-agent or which parent started them, so there is no way to tell whether two were running at the same time. Claude Code does record it, so this check produces a real result on a Claude session.",
      "gemini-records-no-subagents":
        "Gemini's history files don't record which turns belonged to a sub-agent or which parent started them, so there is no way to tell whether two were running at the same time. Claude Code does record it, so this check produces a real result on a Claude session.",
      "cli-records-no-subagents":
        "Nothing this tool records identifies a sub-agent, or says when one started and finished, so there is no way to tell whether two were running at the same time. Claude Code does record it, so this check produces a real result on a Claude session.",
      "subagent-reading-off":
        "Sub-agent records were not read on this run, so nothing was looked for alongside this session. Not having looked is a gap in what was collected, not a finding about the session, and it is not a statement that no sub-agents ran. Running again with sub-agent reading switched on settles it.",
      "scan-bounded":
        "Only part of this tool's sessions were read on this run, so a sub-agent belonging to this session may simply have fallen outside what was looked at. An unread sub-agent is not an absent one, so this is not a statement that none ran. Reading more sessions settles it.",
      "no-subagent-collected":
        "No sub-agent record was found alongside this session, and nothing in what was read ties a sub-agent back to it, so an empty list cannot be treated as a real zero. This is not a statement that no sub-agents ran.",
      "no-subagent-times":
        "Sub-agents are known to belong to this session, but not one of them recorded when it started and finished, so there is no way to work out which of them were running together. How many ran is known; how many ran at once is not. A start and finish time recorded for each sub-agent would make it measurable.",
      "partial-subagent-times":
        "The highest number of sub-agents seen running together came out under the line, but some of this session's sub-agents recorded no start or finish time, so the true peak can only be higher than the one measured. A peak worked out from part of the evidence is not a pass.",
    },
  },
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
          "this CLI records which session dispatched each sub-agent session, the scan was not cut short by the collection limit, and no session names this one as its parent. This is a measured zero, not a missing field.",
          0,
        );
      }
      return unknown(
        subagentReason(session, ctx),
        ctx?.sidechainTurns ? [countValue("turns marked as belonging to a sub-agent", ctx.sidechainTurns)] : [],
        subagentReasonCode(session, ctx),
      );
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
        "no-subagent-times",
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

    // Concurrency takes TWO things at once. A peak of one is a single sub-agent
    // running alone, which cannot overlap anything — and one of one dispatched
    // is a ratio of 1.0, which crosses every line this rule could draw. So the
    // ratio is consulted only once at least two were open at the same moment.
    if (peak >= 2 && ratio > this.threshold.value) return observed(values, derivation, ratio);
    if (withoutInterval > 0) {
      return unknown(
        `peak concurrency reached ${peak} of ${dispatched} dispatched (${round(ratio)}), below the ${this.threshold.value} line — but ${withoutInterval} of those ${dispatched} sub-agent sessions carry no usable start/end, so the real peak can only be higher than the ${peak} measured here. A ceiling computed from part of the evidence is not a pass.`,
        values,
        "partial-subagent-times",
      );
    }
    if (peak < 2) {
      return notObserved(
        values,
        `${derivation} The most open at any one moment was ${peak} of the ${dispatched} dispatched, and a single sub-agent running on its own overlaps nothing — so there was no simultaneous work here for a share to be taken of, whatever ${peak} of ${dispatched} comes to as a fraction. Every dispatched sub-agent carried a usable start and end, so this is a complete answer rather than a gap.`,
        ratio,
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
      reasonCode: "rule-threw",
      values: [],
      derivation: null,
      magnitude: null,
    };
  }

  const status = STATUS_SET.has(raw?.status) ? raw.status : "unknown";
  let reason = status === "unknown" ? str(raw?.reason).trim() : "";
  // The class of the cause, beside the prose rather than parsed out of it.
  // An unrecognised or absent class becomes `default`, which every rule's
  // `plain.unmeasured` catalogue answers, so the renderer always has a
  // sentence even for a cause added later and not yet written up.
  const reasonCode = status === "unknown" ? str(raw?.reasonCode).trim() || "default" : null;
  if (status === "unknown" && !reason) {
    reason = STATUS_SET.has(raw?.status)
      ? "this rule returned unknown without recording a reason; it could not be evaluated and is NOT a pass."
      : `this rule returned the unrecognised status ${JSON.stringify(raw?.status ?? null)}, which is not one of observed / not-observed / unknown, so it is treated as unmeasurable rather than trusted.`;
  }

  // `plain` is declared beside `name`/`threshold` on the rule itself (DATA,
  // never derived from the session), so it is the SAME text for every
  // session this rule ever evaluates. The `{count}`/`{pct}` tokens it may
  // carry are filled in by the renderer from THIS RuleResult's own
  // `magnitude`, never invented client-side — see health.js `fillPlainTemplate`.
  const plainProblem = str(rule?.plain?.problem);
  const plainWhy = str(rule?.plain?.why);
  // `unmeasured` is a MAP from reason class to sentence, not one string: a
  // rule goes unmeasured for several different causes and one sentence would
  // be false for the others. It travels whole, the same way `problem` and
  // `why` travel as templates, and the renderer looks up `evidence.reasonCode`.
  const plainUnmeasured =
    rule?.plain?.unmeasured && typeof rule.plain.unmeasured === "object" ? rule.plain.unmeasured : null;
  const plain =
    plainProblem || plainWhy || plainUnmeasured
      ? { problem: plainProblem || null, why: plainWhy || null, unmeasured: plainUnmeasured }
      : null;

  return {
    id: rule.id,
    name: rule.name,
    severity: rule.severity,
    fix: rule.fix ?? null,
    threshold: { value: rule.threshold.value, derivation: rule.threshold.derivation },
    magnitude: num(raw?.magnitude),
    plain,
    evidence: {
      status,
      reason: status === "unknown" ? reason : null,
      reasonCode,
      values: Array.isArray(raw?.values) ? raw.values : [],
      sources,
      derivation: str(raw?.derivation) || null,
      parserVersion,
    },
  };
}

export default RULES;
