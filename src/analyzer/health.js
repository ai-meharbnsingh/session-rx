/**
 * BP-001.11 — run the six BP-003 rules against normalized sessions and produce
 * evidence-qualified findings.
 *
 * Two outputs, one pass over the data:
 *   `analyzeSession` / `analyzeAll` — the per-session health objects behind
 *       BP-005.01-BP-005.03.
 *   `buildReportInput`            — the corpus-level `ReportInput` that
 *       `src/report/generator.js` renders (BP-005.05).
 *
 * WHAT THE SCORE MAY AND MAY NOT SAY
 * ----------------------------------
 * A session is scored N of 6 checks passed, where PASSED means the rule was
 * evaluated and the condition was NOT met.  An `unknown` rule is never counted
 * as passed, and every score states its unknown count, so "4 of 6 passed"
 * cannot hide two checks that could not be measured at all.  The same rule
 * governs the corpus-level aggregate: a rule observed in one session and
 * unmeasurable in ninety is reported as observed WITH the ninety, never as a
 * finding standing on its own.
 *
 * WINDOW PROMOTIONS ARE SURFACED, NOT ABSORBED
 * --------------------------------------------
 * `collectAll().diagnostics[].windowPromotions` records every session whose
 * model-id table window was provably too small for what the session held
 * (BP-002.17).  Those promotions are attached to the session they belong to and
 * summarised in the per-CLI note the report prints, so a stale `MODEL_WINDOWS`
 * entry stays visible to the user instead of being silently corrected.
 *
 * A SUB-AGENT IS EVIDENCE ABOUT ITS PARENT, NOT A PEER OF IT (F-023)
 * -----------------------------------------------------------------
 * Claude's sub-agent transcripts are collected as sibling sessions —
 * that is what lets BP-003.06 measure concurrency at all.  They are NOT
 * sessions the user started: on the real corpus a 10-per-CLI scan surfaces 50
 * of the user's own sessions and 106 sub-agent transcripts, so counting them as
 * peers answers a question nobody asked and buries the ten cards that were.
 * So a session whose `sessionMeta` names a parent is:
 *   - analyzed in FULL, exactly as before, and attached to its parent as
 *     `parent.subagentSessions` and to `analyzeAll().subagentSessions`;
 *   - still handed to rule 6 as `ctx.children`, so not one interval is lost;
 *   - excluded from the session count, the session list and every corpus
 *     aggregate, because those are about the user's own sessions.
 * Nothing is dropped and nothing is silent: the number set aside is published
 * per CLI as `collectors[].subagentSessions`, in total as
 * `subagentSessionsSetAside`, and in the report as
 * `range.subagentSessions` — dropping 106 real sessions without saying so
 * would be its own kind of dishonesty.
 */

import { MODEL_WINDOWS_VERSION, windowPromotions } from "../collectors/base.js";
import { COLLECTOR_SPECS } from "../collectors/registry.js";
import { RULES, evaluateRule } from "./rules.js";

const SEVERITY_RANK = Object.freeze({ critical: 0, warn: 1, info: 2 });
const STATUS_RANK = Object.freeze({ observed: 0, unknown: 1, "not-observed": 2 });
const RULE_ORDER = new Map(RULES.map((rule, index) => [rule.id, index]));
const PARSER_CLI_IDS = new Set(COLLECTOR_SPECS.map(([id]) => id));

const STRUCTURALLY_NOT_APPLICABLE = Object.freeze({
  "subagent-concurrency": Object.freeze({
    reasonCode: "cli-records-no-subagents",
    reason: "This CLI's log format has no sub-agent identity or parent-link field, so sub-agent concurrency can never be measured from its sessions.",
  }),
});

function notApplicableFor(cli, rule) {
  if (rule.id !== "subagent-concurrency" || cli === "claude") return null;
  return {
    ruleId: rule.id,
    name: rule.name,
    reasonCode: cli === "codex" ? "codex-records-no-subagents" : STRUCTURALLY_NOT_APPLICABLE[rule.id].reasonCode,
    reason: `${cli || "This CLI"}'s log format has no sub-agent identity or parent-link field, so sub-agent concurrency can never be measured from its sessions.`,
  };
}

/** Keys a collector may use for the parent-session linkage (BP-002.19). */
const PARENT_KEYS = Object.freeze(["parentSessionId", "parentId", "parentID", "parent_id"]);

const MAX_REPRESENTATIVE_SESSIONS = 3;
const MAX_VALUES_PER_REPRESENTATIVE = 4;
const MAX_SOURCES_PER_RULE = 6;

/**
 * At or above this share of turn-less sessions, the per-CLI note says so.
 *
 * A chat that was started and never used still parses as a session — a header
 * line and a clock bump can be the whole file for a CLI that writes one on
 * open — so a scan can return a run of empty shells for one CLI while another
 * CLI's real usage stays healthy: 14 of 656 for Claude and 3 of 250 for Codex
 * on the machine this was measured on. The gap between a CLI genuinely mostly
 * abandoned and one with ordinary noise is what the threshold is set to catch:
 * at 0.9 a real all-empty reading is disclosed and no CLI's healthy mix raises
 * a false alarm.
 */
const EMPTY_SESSION_NOTE_SHARE = 0.9;

function str(value) {
  return typeof value === "string" ? value : "";
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ms(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function groupInt(value) {
  return num(value) === null ? String(value) : value.toLocaleString("en-US");
}

/** The parent session id a metadata row points at, or null. */
function parentOf(meta) {
  if (!meta || typeof meta !== "object") return null;
  for (const key of PARENT_KEYS) {
    const value = meta[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** Whether this CLI publishes a parent linkage AT ALL (the key may be null). */
function hasParentLinkage(metaRows) {
  for (const meta of metaRows) {
    if (!meta || typeof meta !== "object") continue;
    for (const key of PARENT_KEYS) if (Object.hasOwn(meta, key)) return true;
  }
  return false;
}

/** Rank most report-worthy first: observed, then severity, then blueprint order. */
function compareRuleResults(a, b) {
  return (
    (STATUS_RANK[a.evidence.status] ?? 3) - (STATUS_RANK[b.evidence.status] ?? 3) ||
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
    (RULE_ORDER.get(a.id) ?? 99) - (RULE_ORDER.get(b.id) ?? 99)
  );
}

/**
 * Score a set of `RuleResult`s.  `unknown` is its own column and is never
 * folded into either of the other two.
 */
function scoreRules(results) {
  let passed = 0;
  let observed = 0;
  let unknown = 0;
  for (const result of results) {
    if (result.evidence.status === "not-observed") passed += 1;
    else if (result.evidence.status === "observed") observed += 1;
    else unknown += 1;
  }
  const total = results.length;
  const label =
    `${passed} of ${total} checks passed` +
    `, ${observed} problem${observed === 1 ? "" : "s"} observed` +
    `, ${unknown} could not be measured`;
  return { total, passed, observed, unknown, label };
}

/**
 * Analyze one normalized session against all six rules.
 *
 * Every rule is evaluated and every rule appears in the output, whatever its
 * verdict: a rule missing from `rules` would be invisible to the report, which
 * is the same failure as reporting it as a pass.
 *
 * @param {object} session a `NormalizedSession` (BP-002)
 * `ctx.toolCallsRecorded` is CORPUS-level evidence that this CLI's collector
 * does surface tool calls, which is what lets a zero tool-call count be read as
 * this session's own rather than as a parser gap.  Called without it, it is
 * derived from this session alone — so a lone session with no tool calls is
 * unmeasurable rather than a pass, which is the conservative direction.
 *
 * @param {{parserVersion?: string, promotion?: object|null,
 *   children?: Array<object>, childLinkageAvailable?: boolean,
 *   corpusComplete?: boolean, sessionMeta?: object|null,
 *   toolCallsRecorded?: boolean}} [ctx]
 * @returns {object} session health: identity, window, score, and all six
 *   `RuleResult`s.  `parentSessionId` / `isSubagentSession` come from
 *   `ctx.sessionMeta`, so the object says for itself whether it is one of the
 *   user's sessions or a sub-agent of one (F-023).  `subagentSessions` is the
 *   list of sub-agent sessions COLLECTED under this one; `analyzeAll` fills it.
 *   An empty list means none was collected — never a claim that none ran, which
 *   is rule 6's statement to make and not this field's.
 */
export function analyzeSession(session, ctx = {}) {
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  let sidechainTurns = 0;
  let ownToolCalls = 0;
  for (const turn of turns) {
    if (turn?.isSidechain === true) sidechainTurns += 1;
    if (Array.isArray(turn?.toolCalls) && turn.toolCalls.length) ownToolCalls += 1;
  }

  const ruleCtx = {
    parserVersion: str(ctx?.parserVersion) || MODEL_WINDOWS_VERSION,
    promotion: ctx?.promotion ?? null,
    children: Array.isArray(ctx?.children) ? ctx.children : [],
    childLinkageAvailable: ctx?.childLinkageAvailable === true,
    corpusComplete: ctx?.corpusComplete === true,
    sessionMeta: ctx?.sessionMeta ?? null,
    sidechainTurns,
    toolCallsRecorded: ctx?.toolCallsRecorded === true || ownToolCalls > 0,
  };

  const cli = str(session?.cli);
  const notApplicable = RULES.map((rule) => notApplicableFor(cli, rule)).filter(Boolean);
  const results = RULES
    .filter((rule) => !notApplicableFor(cli, rule))
    .map((rule) => evaluateRule(rule, session, ruleCtx))
    .sort(compareRuleResults);
  const parentSessionId = parentOf(ruleCtx.sessionMeta);

  return {
    cli: session?.cli ?? null,
    sessionId: session?.sessionId ?? null,
    parentSessionId,
    isSubagentSession: parentSessionId !== null,
    subagentSessions: [],
    project: session?.project ?? null,
    cwd: session?.cwd ?? null,
    model: session?.model ?? null,
    window: { tokens: session?.window?.tokens ?? null, source: session?.window?.source ?? "unknown" },
    windowPromotion: ruleCtx.promotion,
    startedAt: session?.startedAt ?? null,
    endedAt: session?.endedAt ?? null,
    turnCount: turns.length,
    subagentTurns: sidechainTurns,
    score: scoreRules(results),
    rules: results,
    notApplicable,
  };
}

/** Per-CLI index of window promotions, keyed by session id. */
function indexPromotions(diagnostics) {
  const bySession = new Map();
  const byCli = new Map();
  const all = [];
  for (const diagnostic of Array.isArray(diagnostics) ? diagnostics : []) {
    const cli = str(diagnostic?.cli) || "unknown";
    for (const promotion of windowPromotions(diagnostic)) {
      all.push({ cli, ...promotion });
      if (!byCli.has(cli)) byCli.set(cli, []);
      byCli.get(cli).push(promotion);
      const sessionId = str(promotion?.sessionId);
      if (sessionId && !bySession.has(sessionId)) bySession.set(sessionId, promotion);
    }
  }
  return { bySession, byCli, all };
}

/**
 * The read errors each CLI's collector hit, keyed by CLI.
 *
 * A COLLECTOR THAT FAILED IS NOT A COLLECTOR THAT FOUND NOTHING.  The registry
 * contains a throwing `collect()` so one broken CLI cannot take the scan down,
 * and files the failure under `diagnostics[].errors` — but the entry it pushes
 * still carries `sessions: []`, which is indistinguishable from a healthy CLI
 * with nothing in range.  Reported as such, the note claimed the CLI "was read"
 * while its own diagnostic said nothing was read at all, and the session count
 * was published as a measured 0.  Whether a read failed is therefore answered
 * from the diagnostic, not from the length of the session list.
 *
 * @param {Array<object>} diagnostics
 * @returns {Map<string, Array<string>>} only CLIs that recorded at least one error
 */
function indexReadErrors(diagnostics) {
  const byCli = new Map();
  for (const diagnostic of Array.isArray(diagnostics) ? diagnostics : []) {
    const errors = (Array.isArray(diagnostic?.errors) ? diagnostic.errors : [])
      .map((error) => str(error))
      .filter(Boolean);
    if (!errors.length) continue;
    const cli = str(diagnostic?.cli) || "unknown";
    byCli.set(cli, [...(byCli.get(cli) ?? []), ...errors]);
  }
  return byCli;
}

/**
 * One sentence per CLI, stating what was promoted and why, so a stale
 * `MODEL_WINDOWS` entry is visible in the report rather than silently fixed.
 */
function promotionNote(promotions, sessionCount) {
  if (!promotions?.length) return null;
  const shapes = new Map();
  for (const promotion of promotions) {
    const key = `${promotion.modelId}|${promotion.tableTokens}|${promotion.tokens}|${promotion.ladder}`;
    if (!shapes.has(key)) shapes.set(key, { ...promotion, count: 0 });
    shapes.get(key).count += 1;
  }
  const listed = [...shapes.values()].sort((a, b) => b.count - a.count).slice(0, 3);
  const described = listed
    .map((shape) =>
      `${shape.modelId ?? "an unnamed model"}: table says ${groupInt(shape.tableTokens)}, session held more, window taken as ${groupInt(shape.tokens)}` +
      `${shape.ladder === "none" ? " (the observed peak itself — larger than every tier known, so no context fraction is derived from it)" : ` (a known ${shape.ladder} tier)`}` +
      ` x${shape.count}`)
    .join("; ");
  const more = shapes.size > listed.length ? ` and ${shapes.size - listed.length} other model/window combination${shapes.size - listed.length === 1 ? "" : "s"}` : "";
  return (
    `${promotions.length} of ${sessionCount} collected session${sessionCount === 1 ? "" : "s"} held more context than the model-id table allows for their model, so the window was worked out from what was observed instead: ` +
    `${described}${more}. The table entry is stale for these models; the promotion is reported rather than applied silently.`
  );
}

/**
 * Say so when all, or nearly all, of a CLI's sessions hold no turns.
 *
 * DISCLOSURE, NOT A VERDICT.  A started-and-abandoned chat is a real file and
 * parses as a real session, so the count beside the CLI is a true count of what
 * was read and, on its own, a misleading picture of what was used.  Neither the
 * limit note nor the count says which; this sentence does.  Nothing here changes
 * which sessions are read or how the limit is counted.
 *
 * @param {number} empty  sessions read that recorded no turn at all
 * @param {number} total  sessions read for this CLI
 * @param {number|null} limit  the collection limit, but only when it was reached:
 *   only then can a session holding turns be sitting outside what was read.
 */
function emptySessionsNote(empty, total, limit) {
  const outside = limit === null
    ? ""
    : ` Sessions that do hold turns may sit outside the newest ${limit} read here; raise the limit to reach them.`;
  if (empty >= total) {
    return (total === 1
      ? "the one session read for this CLI recorded no turns at all: it is a chat that was started and then left unused, so there is nothing in it to measure."
      : `not one of the ${total} sessions read for this CLI recorded a single turn: every one of them is a chat that was started and then left unused, so there is nothing in any of them to measure.`)
      + outside;
  }
  const measurable = total - empty;
  return (
    `${empty} of the ${total} sessions read for this CLI recorded no turns at all — they are chats that were started and then left unused — `
    + `so only ${measurable} of them ${measurable === 1 ? "has" : "have"} anything in it to measure.`
    + outside
  );
}

/**
 * How many sub-agent sessions were set aside from `sessions`.
 *
 * A caller that knows the number states it.  A caller that assembles its own
 * `ReportInput` from a filtered session list — `/api/report` does exactly that —
 * states nothing, so the number is derived from the sessions themselves,
 * recursively, because a sub-agent of a sub-agent was set aside too.  What is
 * NOT derivable is reported as null, not as zero: a session list whose objects
 * never carried the channel is silent on the question, and silence is not a
 * zero (F-023).
 */
function setAsideCount(sessions, explicit) {
  const stated = num(explicit);
  if (stated !== null) return stated;
  let derived = 0;
  let channelSeen = false;
  const walk = (list) => {
    for (const session of list) {
      if (!Array.isArray(session?.subagentSessions)) continue;
      channelSeen = true;
      derived += session.subagentSessions.length;
      walk(session.subagentSessions);
    }
  };
  walk(sessions);
  return channelSeen ? derived : null;
}

/** Registry order is the one source of truth for manager-facing tools. */
function summaryTools(clis) {
  const registered = COLLECTOR_SPECS.map(([id]) => id);
  const supplied = clis.map((row) => str(row?.cli)).filter(Boolean);
  return [...new Set([...registered, ...supplied])];
}

/**
 * A plain-language, manager-readable rollup of the same verdicts the report
 * renders — sessions analysed, how many checks came back observed /
 * not-observed / unknown, a per-check breakdown, and a per-tool breakdown.
 *
 * @param {{sessions?: Array<object>, clis?: Array<object>}} input
 *   `sessions` are analyzed session-health objects (`analyzeSession` output,
 *   each carrying `.rules`); `clis` is `analyzeAll().collectors`.
 * @returns {{sessionsAnalyzed: number, verdicts: {observed: number,
 *   notObserved: number, unknown: number}, perCheck: Array<{id: string,
 *   name: string, observed: number, notObserved: number, unknown: number}>,
 *   perTool: Array<{cli: string, status: string, sessions: number|null,
 *   problems: number|null, note: string|null}>}}
 */
export function buildManagerSummary(input = {}) {
  const sessions = Array.isArray(input?.sessions) ? input.sessions : [];
  const clis = Array.isArray(input?.clis) ? input.clis : [];

  let observed = 0;
  let notObserved = 0;
  let unknown = 0;
  const perCheck = RULES.map((rule) => ({ id: rule.id, name: rule.name, observed: 0, notObserved: 0, unknown: 0, notApplicable: 0 }));
  const perCheckById = new Map(perCheck.map((row) => [row.id, row]));

  for (const session of sessions) {
    for (const item of Array.isArray(session?.notApplicable) ? session.notApplicable : []) {
      const bucket = perCheckById.get(str(item?.ruleId));
      if (bucket) bucket.notApplicable += 1;
    }
    for (const rule of Array.isArray(session?.rules) ? session.rules : []) {
      const status = rule?.evidence?.status;
      const bucket = perCheckById.get(str(rule?.id));
      if (status === "observed") {
        observed += 1;
        if (bucket) bucket.observed += 1;
      } else if (status === "not-observed") {
        notObserved += 1;
        if (bucket) bucket.notObserved += 1;
      } else {
        unknown += 1;
        if (bucket) bucket.unknown += 1;
      }
    }
  }

  const cliByName = new Map(clis.map((row) => [str(row?.cli), row]));
  const perTool = summaryTools(clis).map((cli) => {
    const row = cliByName.get(cli) ?? null;
    const detectionOnly = row?.support === "detection-only";
    if (detectionOnly) {
      return {
        cli,
        status: "detected-not-read",
        sessions: null,
        problems: null,
        note: str(row?.note) || "detected on this machine, but SessionRx cannot read its sessions yet, so nothing about its usage is measured here — that is not the same as zero problems.",
      };
    }
    const toolSessions = sessions.filter((session) => str(session?.cli) === cli);
    let problems = null;
    if (toolSessions.length) {
      problems = 0;
      for (const session of toolSessions) {
        for (const rule of Array.isArray(session?.rules) ? session.rules : []) {
          if (rule?.evidence?.status === "observed") problems += 1;
        }
      }
    }
    const sessionCount = num(row?.sessions) ?? (toolSessions.length || null);
    return {
      cli,
      status: row ? "read" : "not-installed",
      sessions: sessionCount,
      problems,
      note: str(row?.note) || null,
    };
  });

  return {
    sessionsAnalyzed: sessions.length,
    verdicts: { observed, notObserved, unknown },
    perCheck,
    perTool,
  };
}

/**
 * Build the corpus-level `ReportInput` consumed by `generateReport`.
 *
 * `generatedAt` is the CALLER's to supply: this module never reads the clock,
 * so the same corpus renders byte-identically twice.
 *
 * `sessions` is the user's OWN sessions: a sub-agent session informs its
 * parent's verdict and is never counted as a session of its own here (F-023).
 * `subagentSessions` is how many were set aside, carried into
 * `range.subagentSessions` so the report states the number rather than leaving
 * the reader to wonder where they went.  Not supplied, it is derived from the
 * sessions themselves (`setAsideCount`); derivable from nothing, it stays null
 * and renders as "not recorded" — never as zero.
 *
 * @param {{sessions: Array<object>, clis?: Array<object>, generatedAt?: string|null,
 *   parserVersion?: string, fixes?: Array<object>, trend?: object,
 *   subagentSessions?: number|null, ruleApplicability?: Array<object>}} input
 * @returns {object} `ReportInput`
 */
export function buildReportInput(input = {}) {
  const sessions = Array.isArray(input?.sessions) ? input.sessions : [];
  const parserVersion = str(input?.parserVersion) || MODEL_WINDOWS_VERSION;

  let from = null;
  let to = null;
  for (const session of sessions) {
    const started = ms(session?.startedAt) ?? ms(session?.endedAt);
    const ended = ms(session?.endedAt) ?? ms(session?.startedAt);
    if (started !== null && (from === null || started < from)) from = started;
    if (ended !== null && (to === null || ended > to)) to = ended;
  }

  const range = {
    from: from === null ? null : new Date(from).toISOString(),
    to: to === null ? null : new Date(to).toISOString(),
    sessions: sessions.length,
    subagentSessions: setAsideCount(sessions, input?.subagentSessions),
  };
  if (input?.contextMeasurement && typeof input.contextMeasurement === "object") {
    Object.assign(range, input.contextMeasurement);
  }

  const clis = Array.isArray(input?.clis) ? input.clis : [];
  const notApplicable = [];
  const seenNotApplicable = new Set();
  for (const session of sessions) {
    for (const item of Array.isArray(session?.notApplicable) ? session.notApplicable : []) {
      const cli = str(session?.cli) || "unknown";
      const key = `${cli}:${str(item?.ruleId)}`;
      if (seenNotApplicable.has(key)) continue;
      seenNotApplicable.add(key);
      notApplicable.push({ cli, ...item });
    }
  }

  for (const entry of Array.isArray(input?.ruleApplicability) ? input.ruleApplicability : []) {
    const cli = str(entry?.cli) || "unknown";
    for (const item of Array.isArray(entry?.notApplicable) ? entry.notApplicable : []) {
      const key = `${cli}:${str(item?.ruleId)}`;
      if (seenNotApplicable.has(key)) continue;
      seenNotApplicable.add(key);
      notApplicable.push({ cli, ...item });
    }
  }

  return {
    generatedAt: str(input?.generatedAt) || null,
    parserVersion,
    range,
    clis,
    notApplicable,
    rules: aggregateRules(sessions, parserVersion, input?.ruleApplicability),
    // Computed from the SAME session-health objects (and the same verdicts)
    // the rest of this report renders — never re-derived from the assembled
    // Markdown prose, which is free to change under it (see generator.js).
    summary: input?.summary && typeof input.summary === "object" ? input.summary : buildManagerSummary({ sessions, clis }),
    fixes: Array.isArray(input?.fixes) ? input.fixes : [],
    trend: input?.trend ?? {
      direction: "unknown",
      reason:
        "no trend was computed here: working out a direction over time is a separate step, and it did not run. " +
        "An unknown direction is reported rather than a stable-looking default, because 'stable' would be a claim about history nothing here looked at.",
    },
  };
}

/** The unknown reasons across sessions, most common first. */
function summariseUnknownReasons(unknownResults, unknownCount, total) {
  const counts = new Map();
  for (const result of unknownResults) {
    const reason = str(result.evidence.reason).trim() || "no reason recorded";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topReason, topCount] = ranked[0] ?? ["no reason recorded", unknownCount];
  const others = ranked.length - 1;
  return (
    `${unknownCount} of ${total} session${total === 1 ? "" : "s"} could not be measured for this rule, so it is reported as unmeasurable rather than as a pass. ` +
    `Most common reason (${topCount} of ${unknownCount}): ${topReason}` +
    (others > 0
      ? ` A further ${others} distinct reason${others === 1 ? "" : "s"} appear across the remaining sessions; each session carries its own in the per-session health output.`
      : "")
  );
}

/**
 * Collapse per-session results into ONE `RuleResult` per rule for the report.
 *
 * Status rules, in order:
 *   any session observed it  -> observed   (a positive finding stands on the
 *                                           sessions that produced it)
 *   otherwise any unknown    -> unknown    (nothing was observed, and part of
 *                                           the corpus could not be measured,
 *                                           so "not observed" would be a claim)
 *   otherwise                -> not-observed
 * The observed / unmeasurable / checked counts are ALWAYS emitted as the first
 * three evidence rows, including when they are zero, so an observed verdict can
 * never hide how much of the corpus was unmeasurable.
 */
function aggregateRules(sessions, parserVersion, ruleApplicability = []) {
  const aggregates = [];

  const suppliedNotApplicable = new Map();
  for (const entry of Array.isArray(ruleApplicability) ? ruleApplicability : []) {
    const cli = str(entry?.cli) || "unknown";
    for (const item of Array.isArray(entry?.notApplicable) ? entry.notApplicable : []) {
      const key = `${cli}:${str(item?.ruleId)}`;
      suppliedNotApplicable.set(key, item);
    }
  }

  for (const rule of RULES) {
    const results = [];
    let notApplicableCount = 0;
    for (const session of sessions) {
      const cli = str(session?.cli) || "unknown";
      const sessionNotApplicable = Array.isArray(session?.notApplicable) ? session.notApplicable : [];
      const explicitlyNotApplicable = sessionNotApplicable.some((item) => item?.ruleId === rule.id)
        || suppliedNotApplicable.has(`${cli}:${rule.id}`);
      if (explicitlyNotApplicable) {
        notApplicableCount += 1;
        continue;
      }
      const match = (Array.isArray(session?.rules) ? session.rules : []).find((entry) => entry.id === rule.id);
      if (match) results.push(match);
    }
    const total = results.length;
    // A rule with no applicable sessions has no verdict to aggregate. It is
    // listed by `notApplicable`, but must not become unknown, zero, or pass.
    if (total === 0 && notApplicableCount > 0) continue;
    const observedResults = results.filter((result) => result.evidence.status === "observed");
    const unknownResults = results.filter((result) => result.evidence.status === "unknown");
    const notObservedCount = total - observedResults.length - unknownResults.length;

    let status;
    let reason = null;
    if (total === 0) {
      status = "unknown";
      reason =
        "no session was analyzed for this rule, so there is no evidence either way. Having nothing to check is not the same as finding nothing wrong.";
    } else if (observedResults.length) {
      status = "observed";
    } else if (unknownResults.length) {
      status = "unknown";
      reason = summariseUnknownReasons(unknownResults, unknownResults.length, total);
    } else {
      status = "not-observed";
    }

    const values = [
      { label: "sessions where this was observed", value: observedResults.length, unit: "count" },
      { label: "sessions where this could NOT be measured (not counted as passing)", value: unknownResults.length, unit: "count" },
      { label: "sessions checked", value: total, unit: "count" },
    ];
    values.push({ label: "sessions where this was not applicable", value: notApplicableCount, unit: "count" });

    const representatives = (status === "observed" ? observedResults : status === "unknown" ? unknownResults : results)
      .slice()
      .sort((a, b) => (b.magnitude ?? -Infinity) - (a.magnitude ?? -Infinity))
      .slice(0, MAX_REPRESENTATIVE_SESSIONS);

    const sources = [];
    for (const representative of representatives) {
      for (const value of representative.evidence.values.slice(0, MAX_VALUES_PER_REPRESENTATIVE)) values.push(value);
      for (const source of representative.evidence.sources) {
        if (sources.length < MAX_SOURCES_PER_RULE && !sources.includes(source)) sources.push(source);
      }
    }

    const derivation =
      `aggregated over ${total} session${total === 1 ? "" : "s"}: ${observedResults.length} observed, ${notObservedCount} measured and not met, ${unknownResults.length} not measurable. ` +
      `The rule is reported as observed when at least one session observed it, and the unmeasurable count travels with the verdict so it cannot be hidden by it. ` +
      `The rows below the counts come from the ${representatives.length} worst-affected session${representatives.length === 1 ? "" : "s"} of that group` +
      `${representatives[0]?.evidence?.derivation ? `, computed as follows — ${representatives[0].evidence.derivation}` : ""}`;

    aggregates.push({
      counts: { observed: observedResults.length, unknown: unknownResults.length, total },
      result: {
        id: rule.id,
        name: rule.name,
        severity: rule.severity,
        fix: rule.fix ?? null,
        threshold: { value: rule.threshold.value, derivation: rule.threshold.derivation },
        evidence: { status, reason, values, sources, derivation, parserVersion },
      },
    });
  }

  // C-4: the generator does not re-rank, it takes the first three observed.
  aggregates.sort(
    (a, b) =>
      (STATUS_RANK[a.result.evidence.status] ?? 3) - (STATUS_RANK[b.result.evidence.status] ?? 3) ||
      (SEVERITY_RANK[a.result.severity] ?? 9) - (SEVERITY_RANK[b.result.severity] ?? 9) ||
      b.counts.observed - a.counts.observed ||
      (RULE_ORDER.get(a.result.id) ?? 99) - (RULE_ORDER.get(b.result.id) ?? 99),
  );
  return aggregates.map((aggregate) => aggregate.result);
}

/**
 * Analyze everything `registry.collectAll()` returned.
 *
 * @param {{supported?: Array<object>, detectionOnly?: Array<object>,
 *   absent?: Array<object>, unreadable?: Array<object>, diagnostics?: Array<object>}} collected
 * @param {{generatedAt?: string|null, limit?: number|null, parserVersion?: string,
 *   fixes?: Array<object>, trend?: object}} [options]
 *   `limit` is the limit that was passed to `collectAll`, if any. It matters:
 *   with a limit in force, an empty sub-agent child list may simply mean the
 *   child session was not collected, so no measured zero is claimed from it.
 * @returns {{sessions: Array<object>, subagentSessions: Array<object>,
 *   subagentSessionsSetAside: {total: number, orphans: number,
 *     byCli: Array<{cli: string, count: number, orphans: number}>},
 *   collectors: Array<object>, promotions: Array<object>,
 *   diagnostics: Array<object>, reportInput: object}}
 *   `sessions` is the user's own sessions only; the sub-agent sessions are in
 *   `subagentSessions` and under `sessions[].subagentSessions`, and how many
 *   were set aside is stated in `subagentSessionsSetAside` and per CLI in
 *   `collectors[].subagentSessions` (F-023).
 *   A supported CLI whose collector FAILED publishes `sessions: null` and
 *   `subagentSessions: null` with a note saying the read failed: a read that
 *   produced nothing has no count, and 0 would be a measurement nothing made
 *   (see `indexReadErrors`).
 */
export function analyzeAll(collected = {}, options = {}) {
  const parserVersion = str(options?.parserVersion) || MODEL_WINDOWS_VERSION;
  const limit = num(options?.limit);
  const diagnostics = Array.isArray(collected?.diagnostics) ? collected.diagnostics : [];
  const promotions = indexPromotions(diagnostics);
  const readErrorsByCli = indexReadErrors(diagnostics);

  const analyzed = [];
  const setAsideSubagents = [];
  const setAsideByCli = [];
  let orphanSubagents = 0;
  const clis = [];

  for (const entry of Array.isArray(collected?.supported) ? collected.supported : []) {
    const sessions = Array.isArray(entry?.sessions) ? entry.sessions : [];
    const cli = str(entry?.id) || str(sessions[0]?.cli) || "unknown";
    const sessionMeta = entry?.sessionMeta && typeof entry.sessionMeta === "object" ? entry.sessionMeta : null;
    const metaRows = sessionMeta ? Object.values(sessionMeta) : [];
    const childLinkageAvailable = hasParentLinkage(metaRows);

    // Children are resolved against the COLLECTED sessions, because the
    // interval comes from the child session itself, not from the linkage row.
    const sessionById = new Map(sessions.map((session) => [str(session?.sessionId), session]));
    const childrenByParent = new Map();
    for (const meta of metaRows) {
      const parent = parentOf(meta);
      if (!parent) continue;
      const childId = str(meta?.sessionId);
      const child = sessionById.get(childId) ?? null;
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push({
        sessionId: childId || null,
        startedAt: child?.startedAt ?? null,
        endedAt: child?.endedAt ?? null,
        collected: Boolean(child),
      });
    }

    // With no limit, or with fewer sessions than the limit, nothing was cut off.
    // Counted over EVERY collected session, sub-agents included: the partition
    // below changes what is reported, never what was read, so no verdict may
    // move because of it.
    const corpusComplete = limit === null || sessions.length < limit;

    // How many of those sessions hold no turn at all.  Counted over the same
    // set as the notes above (every session read for this CLI, sub-agents
    // included) so one paragraph cannot quote two different totals.  Read-only:
    // it feeds a note and nothing else, so no verdict can move because of it.
    const emptySessions = sessions.filter(
      (session) => !(Array.isArray(session?.turns) && session.turns.length > 0),
    ).length;

    // Does this CLI's collector surface tool calls at all?  Answered from the
    // whole collected set, because one session cannot tell "used no tools"
    // apart from "tool calls not parsed" — and one of those is a parser gap.
    let toolCallsRecorded = false;
    for (const session of sessions) {
      for (const turn of Array.isArray(session?.turns) ? session.turns : []) {
        if (Array.isArray(turn?.toolCalls) && turn.toolCalls.length) { toolCallsRecorded = true; break; }
      }
      if (toolCallsRecorded) break;
    }

    // A transcript with no turns is an empty shell, not a session for which five
    // health checks failed to find evidence. Keep it in the collector coverage
    // note, but exclude it from rule analysis and the analyzed-session count.
    // Non-empty sub-agents continue to be analyzed and attached as before.
    const ownHealth = [];
    const subagentHealth = [];
    let emptyOwnSessions = 0;
    let emptySubagentSessions = 0;
    for (const session of sessions) {
      const hasTurns = Array.isArray(session?.turns) && session.turns.length > 0;
      const metadata = sessionMeta?.[str(session?.sessionId)] ?? null;
      if (!hasTurns) {
        if (parentOf(metadata)) emptySubagentSessions += 1;
        else emptyOwnSessions += 1;
        continue;
      }
      const health = analyzeSession(session, {
        parserVersion,
        promotion: promotions.bySession.get(str(session?.sessionId)) ?? null,
        children: childrenByParent.get(str(session?.sessionId)) ?? [],
        childLinkageAvailable,
        corpusComplete,
        toolCallsRecorded,
        sessionMeta: metadata,
      });
      (health.isSubagentSession ? subagentHealth : ownHealth).push(health);
    }

    // Re-home each sub-agent under the session that launched it, so expanding a
    // parent card reaches it.  Nesting is resolved against ALL of this CLI's
    // health objects, so a sub-agent of a sub-agent lands under its real parent
    // rather than at the top.
    const healthById = new Map();
    for (const health of [...ownHealth, ...subagentHealth]) {
      const id = str(health.sessionId);
      if (id && !healthById.has(id)) healthById.set(id, health);
    }
    let orphansHere = 0;
    for (const child of subagentHealth) {
      const parent = healthById.get(str(child.parentSessionId));
      // A session cannot be its own parent; such a row is malformed linkage and
      // is left unattached rather than made to point at itself.
      if (parent && parent !== child) parent.subagentSessions.push(child);
      else orphansHere += 1;
    }
    orphanSubagents += orphansHere;
    analyzed.push(...ownHealth);
    setAsideSubagents.push(...subagentHealth);
    if (subagentHealth.length) setAsideByCli.push({ cli, count: subagentHealth.length, orphans: orphansHere });

    // The read either failed and produced nothing, or partly failed, or worked.
    // Only the first case may not state a count: 0 there is not a measurement.
    const readErrors = readErrorsByCli.get(cli) ?? [];
    const readFailed = readErrors.length > 0 && sessions.length === 0;

    const notes = [];
    const promotionSummary = promotionNote(promotions.byCli.get(cli), sessions.length);
    if (promotionSummary) notes.push(promotionSummary);
    if (readFailed) {
      notes.push(
        `reading this CLI failed: ${readErrors.length === 1 ? "an error" : `${readErrors.length} errors`} stopped the read and not one session was obtained. ` +
        "So the session count is unknown rather than zero, and none of this says the CLI went unused — nothing here was measured. " +
        "The error itself is shown with the collector diagnostics.",
      );
    } else if (!ownHealth.length) {
      notes.push(
        subagentHealth.length
          ? `every one of the ${subagentHealth.length} session${subagentHealth.length === 1 ? "" : "s"} read for this CLI is a sub-agent transcript dispatched by another session, so none of them is counted here as a session of the user's own.`
          : "this CLI is installed and was read, but no session fell inside the requested range, so there is nothing to analyze for it here.",
      );
    }
    if (readErrors.length && !readFailed) {
      notes.push(
        `${readErrors.length === 1 ? "one error" : `${readErrors.length} errors`} were hit while reading this CLI, so the count beside it is what could be read and may be lower than the truth. ` +
        `The ${readErrors.length === 1 ? "error is" : "errors are"} shown with the collector diagnostics.`,
      );
    }
    if (subagentHealth.length) {
      notes.push(
        `${subagentHealth.length} of the ${sessions.length} session${sessions.length === 1 ? "" : "s"} read for this CLI ${subagentHealth.length === 1 ? "is a sub-agent transcript" : "are sub-agent transcripts"} dispatched by another session, so ${subagentHealth.length === 1 ? "it is" : "they are"} set aside from the ${ownHealth.length} counted here and attached to the parent that launched ${subagentHealth.length === 1 ? "it" : "them"} instead: a sub-agent is evidence about that session, not a session of the user's own. ` +
        `Every turn, token and verdict of ${subagentHealth.length === 1 ? "it" : "theirs"} is unchanged and still reachable under that parent, and ${subagentHealth.length === 1 ? "its interval" : "their intervals"} still feed the sub-agent concurrency rule.` +
        (orphansHere ? ` ${orphansHere} of them name${orphansHere === 1 ? "s" : ""} a parent that this scan did not read, so ${orphansHere === 1 ? "it has" : "they have"} no parent card to sit under and ${orphansHere === 1 ? "is" : "are"} set aside without one.` : ""),
      );
    }
    if (emptyOwnSessions || emptySubagentSessions) {
      const parts = [];
      if (emptyOwnSessions) parts.push(`${emptyOwnSessions} user session${emptyOwnSessions === 1 ? "" : "s"}`);
      if (emptySubagentSessions) parts.push(`${emptySubagentSessions} sub-agent session${emptySubagentSessions === 1 ? "" : "s"}`);
      notes.push(`${parts.join(" and ")} contained no turns and were excluded from health checks; they are not counted as analyzed sessions rather than being reported as five unknown checks.`);
    }
    if (!corpusComplete) {
      notes.push(`the collection limit of ${limit} was reached for this CLI, so this is the newest ${ownHealth.length} session${ownHealth.length === 1 ? "" : "s"}, not all of them.`);
    }
    // Last, because it reads as a qualifier on the count and the limit above it.
    // A failed read states no count at all, and 0 of 0 is not a finding.
    if (!readFailed && sessions.length > 0 && emptySessions >= sessions.length * EMPTY_SESSION_NOTE_SHARE) {
      notes.push(emptySessionsNote(emptySessions, sessions.length, corpusComplete ? null : limit));
    }
    clis.push({
      cli,
      // A failed read states no count at all: null is "not recorded", which the
      // report and the UI already render as such, and 0 would be a measurement
      // nothing here made.
      sessions: readFailed ? null : ownHealth.length,
      subagentSessions: readFailed ? null : subagentHealth.length,
      support: "supported",
      installed: true,
      note: notes.length ? notes.join(" ") : null,
    });
  }

  for (const entry of Array.isArray(collected?.detectionOnly) ? collected.detectionOnly : []) {
    clis.push({
      cli: str(entry?.id) || "unknown",
      sessions: null,
      subagentSessions: null,
      support: "detection-only",
      installed: true,
      note:
        str(entry?.reason) ||
        ("detected on this machine, but it exposes no session transcript to read, so nothing about its usage is measured here. " +
        "No sessions were read, which is not the same as no usage."),
    });
  }

  for (const entry of Array.isArray(collected?.unreadable) ? collected.unreadable : []) {
    clis.push({
      cli: str(entry?.id) || "unknown",
      sessions: null,
      subagentSessions: null,
      support: "unreadable",
      installed: null,
      note: str(entry?.reason) || "SessionRx could not load the reader for this CLI, so installation could not be determined and no session was read.",
    });
  }

  for (const entry of Array.isArray(collected?.absent) ? collected.absent : []) {
    const cli = str(entry?.id) || "unknown";
    const parserExists = PARSER_CLI_IDS.has(cli);
    clis.push({
      cli,
      sessions: null,
      subagentSessions: null,
      support: parserExists ? "supported" : "detection-only",
      installed: false,
      note: parserExists
        ? "SessionRx can read this CLI, but no installation was found. The session count is not recorded rather than zero."
        : "SessionRx can detect this CLI, but no installation was found. The session count is not recorded rather than zero.",
    });
  }

  return {
    // The user's own sessions. A sub-agent session is not one of them (F-023).
    sessions: analyzed,
    // The sub-agent sessions set aside — analyzed in full, reachable both here
    // and as `parent.subagentSessions`, counted nowhere as a session of the
    // user's own.
    subagentSessions: setAsideSubagents,
    subagentSessionsSetAside: {
      total: setAsideSubagents.length,
      orphans: orphanSubagents,
      byCli: setAsideByCli,
    },
    collectors: clis,
    ruleApplicability: clis.map((entry) => {
      const cli = str(entry?.cli) || "unknown";
      const excluded = RULES.map((rule) => notApplicableFor(cli, rule)).filter(Boolean);
      return {
        cli,
        applicable: RULES.filter((rule) => !notApplicableFor(cli, rule)).map((rule) => rule.id),
        notApplicable: excluded,
      };
    }),
    promotions: promotions.all,
    diagnostics,
    reportInput: buildReportInput({
      sessions: analyzed,
      clis,
      subagentSessions: setAsideSubagents.length,
      generatedAt: options?.generatedAt ?? null,
      parserVersion,
      fixes: options?.fixes,
      trend: options?.trend,
      ruleApplicability: clis.map((entry) => {
        const cli = str(entry?.cli) || "unknown";
        return {
          cli,
          applicable: RULES.filter((rule) => !notApplicableFor(cli, rule)).map((rule) => rule.id),
          notApplicable: RULES.map((rule) => notApplicableFor(cli, rule)).filter(Boolean),
        };
      }),
    }),
  };
}

export default analyzeAll;
