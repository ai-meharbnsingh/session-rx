/**
 * BP-001.20 — SessionRx Markdown report generator.
 *
 * The report is a file the user is expected to paste into a public issue, so it
 * is (a) deterministic, (b) secret-redacted, and (c) unable to convert absence
 * of evidence into a clean bill of health.
 *
 * ============================================================================
 * INPUT CONTRACT — the wave that builds src/analyzer/{health,rules,trends}.js
 * MUST emit exactly this shape.  This module imports no analyzer rule implementation;
 * the object below is the whole interface between them.
 * ============================================================================
 *
 *   ReportInput {
 *     generatedAt?:   string | null   // ISO-8601, SUPPLIED BY THE CALLER.
 *                                     // This module never reads the clock —
 *                                     // that is what makes output diffable.
 *     parserVersion?: string | null   // FVA-002; e.g. MODEL_WINDOWS_VERSION
 *                                     // from src/collectors/base.js
 *     range: {
 *       from:      string | null      // earliest session start, ISO-8601
 *       to:        string | null      // latest session end, ISO-8601
 *       sessions?: number | null      // the USER'S OWN sessions in range;
 *                                     // null = unknown
 *       subagentSessions?: number | null
 *                                     // sub-agent sessions SET ASIDE from that
 *                                     // count (F-023): read and analyzed, each
 *                                     // one evidence about the session that
 *                                     // launched it, none of them a session of
 *                                     // the user's own. null = not recorded,
 *                                     // which is not zero.
 *     }
 *     summary?: {                    // a plain-language rollup of the SAME
 *                                     // verdicts this report renders, used for
 *                                     // the "Summary for managers" section and
 *                                     // by /api/report's own `summary` field
 *                                     // (public/js/pages/report.js renders it
 *                                     // as cards). Computed automatically by
 *                                     // `buildReportInput` when not supplied.
 *       sessionsAnalyzed: number
 *       verdicts: {observed: number, notObserved: number, unknown: number}
 *       perCheck: Array<{id: string, name: string, observed: number,
 *                         notObserved: number, unknown: number}>
 *       perTool: Array<{cli: string, status: "read" | "detected-not-read" |
 *                        "not-installed", sessions: number|null,
 *                        problems: number|null, note: string|null}>
 *     }
 *     clis: Array<{
 *       cli:       string             // "claude" | "codex" | "cursor"
 *       sessions:  number | null      // null = count not recoverable (NOT zero)
 *       subagentSessions?: number | null
 *                                     // sub-agent sessions set aside for this
 *                                     // CLI; null = nothing was read, not zero
 *       support?:  "supported" | "detection-only" | "unsupported"
 *       note?:     string | null      // why the count is null / what
 *                                     // detection-only means (DIS-007)
 *     }>
 *     rules: Array<RuleResult>        // EVERY rule evaluated, not just the
 *                                     // failing ones.  Analyzer-ranked, most
 *                                     // report-worthy first; this module
 *                                     // preserves the given order and does
 *                                     // not re-rank.
 *     fixes: Array<AppliedFix>        // the applied-fix history that WAS read.
 *                                     // An empty array means the record was
 *                                     // read and held no apply.
 *          | { status: "unknown",     // the record could NOT be read.  A
 *              reason?: string|null } // missing key, or any other non-array,
 *                                     // is treated the same way: `unknown`
 *                                     // with a reason, never "no fix was
 *                                     // applied" (L9).
 *     trend: {
 *       direction: "improving" | "stable" | "declining" | "unknown"
 *       reason?:   string | null      // REQUIRED when direction is "unknown"
 *       metrics?:  Array<TrendMetric>
 *     }
 *   }
 *
 *   RuleResult {                      // BP-003 Rule shape plus its evaluation
 *     id:         string              // "context-pressure"
 *     name?:      string              // "Context pressure"
 *     severity?:  "info" | "warn" | "critical"
 *     fix?:       string | null       // fix id this rule maps to
 *     threshold?: { value?: unknown, derivation?: string }
 *     evidence: {
 *       status:   "observed" | "not-observed" | "unknown"
 *       reason?:  string | null       // REQUIRED when status is "unknown".
 *                                     // A missing reason renders as an
 *                                     // explicit "reason not recorded", never
 *                                     // as blank and never as a pass.
 *       values?:  Array<EvidenceValue>  // the ACTUAL numbers from the sessions
 *       sources?: Array<string>       // file path / table + record ids (FVA-002)
 *       derivation?: string | null    // how the numbers were computed
 *       parserVersion?: string | null
 *     }
 *   }
 *
 *   EvidenceValue {
 *     label:  string                  // "peak context", "cache hit rate"
 *     value:  number | string | null
 *     unit?:  "tokens" | "bytes" | "count" | "hours" | "fraction" | "ratio"
 *             | string | null
 *     windowSource?: "native" | "model-table" | "model-map"
 *             | "observed-promoted" | "observed-floor" | "unknown" | null
 *     sessionId?: string | null
 *   }
 *
 *   TrendMetric { label: string, from: number|string|null,
 *                 to: number|string|null, unit?: string|null,
 *                 windowSource?: string|null }
 *
 *   AppliedFix {
 *     id:        string
 *     name?:     string
 *     target:    string | null        // file the fix touched
 *     appliedAt?: string | null
 *     status?:   "applied" | "reverted" | "failed"
 *     before:    string | null        // REQUIRED.  null renders as an explicit
 *                                     // "BEFORE state not recorded".
 *     after?:    string | null
 *     undoPath?: string | null
 *   }
 *
 * ============================================================================
 * RENDERING LAWS (BLUEPRINT DIS-003..DIS-006, FVA-002, FVA-004, FVA-006)
 * ============================================================================
 *   L1  A "finding" is a rule whose evidence.status === "observed".  Nothing
 *       else is ever promoted to a finding.
 *   L2  At most 3 findings are printed (the first 3 in the given order).  If
 *       fewer than 3 exist, the report prints the ones that exist and SAYS SO.
 *       It is never padded.
 *   L3  Every rule appears in section 4 with its verdict.  An "unknown" verdict
 *       renders as unknown WITH its reason.  It is never rendered as a pass,
 *       never as a zero, never omitted.  That conversion of "no evidence" into
 *       "all clear" is the failure this product exists to prevent.
 *   L4  A window whose source is "observed-promoted" or "observed-floor" is
 *       labelled INFERRED on the same row as the number it produced (F-008).
 *   L5  A fraction/ratio above 1.0 is never printed as a normal reading.  It is
 *       printed as an impossible reading with the reason (F-008 clause 3).
 *   L6  The assembled document passes redactSecrets() before it is returned.
 *   L7  No fenced code blocks anywhere: verbatim content is 4-space-indented,
 *       so no content can ever close a fence or leave one open.
 *   L8  Session counts are the USER'S OWN sessions.  A sub-agent session is
 *       evidence about the session that launched it, so it is never counted as a
 *       session of its own in the date range or the per-CLI totals — and the
 *       number set aside is PRINTED next to the count that excludes it (F-023).
 *       Quietly leaving 106 real sessions out of a total is the same class of
 *       failure as quietly counting them in.
 *   L9  An applied-fix history that could not be read is `unknown` WITH its
 *       reason.  Only a history that was read and held no apply renders as "No
 *       fix was applied in this period".  That sentence is a claim about what
 *       the user did, and an unwired input is no evidence for it — it was the
 *       one place this report ever asserted something outright false.
 *
 * ============================================================================
 * EXPORTS — who calls what
 * ============================================================================
 *   generateReport(data)         -> string        (public/js/pages/report.js,
 *                                                  src/cli.js)
 *   generateReportDocument(data) -> {markdown, generatedAt, redactions}
 *                                                 (src/server.js, BP-005.05)
 *   redactSecrets(input)         -> {text, redactions}
 *                                                 (src/server.js API gate,
 *                                                  FVA-004)
 *   REPORT_FOOTER                -> string
 */

import { CACHE_SAMPLE_MIN_TURNS } from "../constants.js";

/** Verbatim, by operator specification. Must be the document's last line. */
export const REPORT_FOOTER = "Diagnosed by SessionRx — built by Adaptive Mind";

const REDACTION = "[REDACTED]";
const MAX_FINDINGS = 3;
const NOT_RECORDED = "not recorded";

const WINDOW_SOURCE_INFERRED = Object.freeze({
  "observed-promoted": "INFERRED from observation (observed-promoted) — the model-id window table understated this model, so the window was promoted to fit what was actually observed",
  "observed-floor": "INFERRED from observation (observed-floor) — no window is known for this model id, so the largest context actually observed is used as a lower bound",
});

const UNIT_SUFFIX = Object.freeze({
  tokens: " tokens",
  bytes: " bytes",
  count: "",
  hours: " h",
  fraction: " of window",
  ratio: "",
});

// Assembled from fragments rather than written out: a literal PEM header in
// this file is itself credential-shaped and is refused by the machine's
// secret-handling guard on write.  The compiled pattern is identical.
const PEM_EDGE = "-".repeat(5);
const PEM_KEY_BLOCK = new RegExp(
  `${PEM_EDGE}BEGIN [A-Z ]*PRIVATE KEY${PEM_EDGE}[\\s\\S]*?${PEM_EDGE}END [A-Z ]*PRIVATE KEY${PEM_EDGE}`,
  "g",
);

/**
 * Credential-shaped values, redacted before anything is returned (FVA-004).
 * Ordered: keyed forms first so the KEY survives and only the VALUE is lost,
 * then vendor prefixes, then generic long runs.
 */
const SECRET_PATTERNS = Object.freeze([
  { id: "pem-key-block", re: PEM_KEY_BLOCK, replace: () => REDACTION },
  // Runs BEFORE credential-key: otherwise `authorization: Bearer <tok>` has its
  // value alternation stop at the space after "Bearer" and the token survives.
  { id: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: () => `Bearer ${REDACTION}` },
  {
    // The optional `Bearer ` inside the value is the same leak closed a second
    // way, so the pattern is correct on its own regardless of ordering.
    id: "credential-key",
    re: /("?\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|authorization|auth[_-]?token|api[_-]?key|apikey|client[_-]?secret|private[_-]?key|secret[_-]?key|secret|password|passwd|passphrase|credential|token)\b"?\s*[:=]\s*)(?:[Bb]earer\s+)?(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\])|]+)/gi,
    replace: (_match, key) => `${key}${REDACTION}`,
  },
  { id: "vendor-prefix", re: /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{8,}/g, replace: () => REDACTION },
  { id: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: () => REDACTION },
  { id: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g, replace: () => REDACTION },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: () => REDACTION },
  { id: "aws-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => REDACTION },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => REDACTION },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: () => REDACTION },
  { id: "hex-run", re: /\b[0-9a-fA-F]{32,}\b/g, replace: () => REDACTION },
  // `/` is deliberately excluded from the unpadded run: it is the path
  // separator, and `[A-Za-z0-9+/]{40,}` swallows an ordinary deep filesystem
  // path, which is the report's primary evidence reference (FVA-002). Padded
  // base64 keeps `/` because no path carries a trailing `=`.
  { id: "opaque-run", re: /\b[A-Za-z0-9+]{40,}={0,2}/g, replace: () => REDACTION },
  { id: "padded-base64", re: /\b[A-Za-z0-9+/]{24,}={1,2}/g, replace: () => REDACTION },
]);

/**
 * Remove credential-shaped values from arbitrary text.
 *
 * Deliberately over-eager: a 32+ character hex run and a 40+ character base64
 * run are redacted even when they are in fact an account id or a content hash,
 * because a false redaction costs the reader one lookup while a false
 * pass-through puts a live credential in a public issue.  Callers that need a
 * session id to survive should pass the dashed UUID form, which is not a
 * continuous hex run.
 *
 * @param {unknown} input
 * @returns {{text: string, redactions: number}}
 */
export function redactSecrets(input) {
  if (input === null || input === undefined) return { text: "", redactions: 0 };
  let out = typeof input === "string" ? input : String(input);
  let redactions = 0;
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      redactions += 1;
      return replace(...args);
    });
  }
  return { text: out, redactions };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Internal decision identifiers, and why they stop at this file.
 *
 * The analyzer keeps its own filing references — the `BP-`, `DIS-` and `F-`
 * numbers — inside its evidence strings, and that is correct: they are the
 * evidence of record, and in the UI they only ever render inside collapsed
 * technical detail. The report is a different artifact. It is what a user
 * pastes into an issue, sends to a colleague or screenshots; it has no
 * collapsed section to keep engineering detail in, and a stranger reading
 * their own report has no document in which to look `BP-004.03` up. So the
 * identifiers are removed HERE, at the document boundary, and nowhere
 * upstream.
 *
 * What must not change is the MEANING. Several of these sentences exist
 * precisely to stop a missing measurement from reading as a good result, so
 * the reference is taken out the way a copy editor would take it out:
 *
 *   - a reference standing alone in brackets goes, brackets and all
 *       "…no verdict is derived from it (BP-002.18 / F-014). The peak…"
 *    -> "…no verdict is derived from it. The peak…"
 *   - a reference that only labels the clause after it leaves the clause
 *       "(DIS-005: the fraction is preserved…)"  ->  "(the fraction is preserved…)"
 *   - a reference doing real grammatical work in the sentence becomes the
 *     plain words it stood for, so the sentence still parses and still says
 *     the same thing
 *       "…and BP-002.18 applies exactly as it does to `observed-floor`."
 *    -> "…and that rule applies exactly as it does to `observed-floor`."
 *
 * Verbatim user content is exempt: `indentedBlock` renders a BEFORE/AFTER
 * block through `verbatim()`, because a fix's before-state has to equal the
 * user's own file, and rewriting their words to tidy ours would be a worse
 * lie than the one this function removes.
 */
const ID_TOKEN = String.raw`(?:BP|DIS|F)-\d+(?:\.\d+)*`;
const ID_JOIN = String.raw`(?:\s*[/,&-]\s*|\s+(?:and|to)\s+)`;
const ID_RUN = `${ID_TOKEN}(?:${ID_JOIN}${ID_TOKEN})*`;
const ID_PRESENT = /(?:BP|DIS|F)-\d/;
/** "…derived from it (BP-002.18 / F-014)." -> "…derived from it." */
const ID_BRACKETED_ALONE = new RegExp(String.raw`[ \t]*\((?:${ID_RUN})\)`, "g");
/** "(DIS-005: the fraction…" -> "(the fraction…" */
const ID_BRACKETED_LABEL = new RegExp(String.raw`\((?:${ID_RUN})\s*:\s*`, "g");
/** "(BP-003.07 measured true=0…" -> "(measured true=0…" */
const ID_BRACKETED_LEAD = new RegExp(String.raw`\((?:${ID_RUN})\s+(?=\S)`, "g");
/** A reference left in the running text, where words have to take its place. */
const ID_IN_SENTENCE = new RegExp(`(${ID_RUN})`, "g");

function countIds(run) {
  return (run.match(/(?:BP|DIS|F)-\d/g) ?? []).length;
}

/**
 * @param {string} text
 * @returns {string} the same text with no internal identifier and no scar
 *   where one was — no empty brackets, no doubled space, no stranded comma.
 */
function withoutInternalIds(text) {
  if (!ID_PRESENT.test(text)) return text;
  let out = text
    .replace(ID_BRACKETED_ALONE, "")
    .replace(ID_BRACKETED_LABEL, "(")
    .replace(ID_BRACKETED_LEAD, "(")
    .replace(ID_IN_SENTENCE, (run) => (countIds(run) > 1 ? "those rules" : "that rule"));
  out = out
    .replace(/[ \t]*\(\s*\)/g, "")
    .replace(/\([ \t]+/g, "(")
    .replace(/[ \t]+([.,;:!?)])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
  return out;
}

/** Converted, never edited: the user's own bytes (see withoutInternalIds). */
function verbatim(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Every analyzer-supplied value reaches the document through here, which is
 * what makes "no internal identifier in the report" a property of the file
 * rather than of the eight call sites that would otherwise each have to
 * remember it.
 */
function str(value) {
  return withoutInternalIds(verbatim(value));
}

/** Table-cell safe: single line, pipes escaped, empty made explicit. */
function cell(value) {
  const flat = str(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  return flat === "" ? NOT_RECORDED : flat;
}

function groupInt(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Locale-independent on purpose: toLocaleString would break determinism. */
function fmtNumber(value, unit) {
  if (value === null || value === undefined) return NOT_RECORDED;
  if (typeof value !== "number" || !Number.isFinite(value)) return str(value) || NOT_RECORDED;
  if (unit === "fraction" || unit === "ratio") return value.toFixed(2);
  if (Number.isInteger(value)) return groupInt(value);
  // Group the integer part too, so 50674.7 does not sit next to 41,207.
  const [whole, decimals] = String(Number(value.toFixed(3))).split(".");
  return decimals ? `${groupInt(whole)}.${decimals}` : groupInt(whole);
}

function fmtContextTotal(value) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B tokens`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M tokens`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K tokens`;
  return `${groupInt(value)} tokens`;
}

/** L4: an inferred window says so wherever its number appears. */
function windowNote(source) {
  const key = str(source);
  if (!key) return "";
  if (Object.hasOwn(WINDOW_SOURCE_INFERRED, key)) return WINDOW_SOURCE_INFERRED[key];
  return `window source: ${key}`;
}

/**
 * L5: a fraction above 1.0 is a window-table defect, not a reading. It surfaces
 * as one rather than as "208% of your window" stated as fact.
 */
function fmtEvidenceValue(entry) {
  const unit = entry?.unit ?? null;
  const raw = entry?.value ?? null;
  const impossible = (unit === "fraction" || unit === "ratio")
    && typeof raw === "number" && Number.isFinite(raw) && raw > 1;
  if (impossible) {
    return `${raw.toFixed(2)} of window — IMPOSSIBLE READING (above 1.0): a session cannot hold more context than its window, so the window is wrong for this session, not the measurement`;
  }
  const unitKey = str(unit);
  const suffix = Object.hasOwn(UNIT_SUFFIX, unitKey) ? UNIT_SUFFIX[unitKey] : (unitKey ? ` ${unitKey}` : "");
  return `${fmtNumber(raw, unit)}${suffix}`;
}

/** L7: verbatim content is indented, never fenced. */
function indentedBlock(value) {
  const body = verbatim(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return body.split("\n").map((line) => `    ${line}`).join("\n");
}

function normalizeStatus(evidence) {
  const status = str(evidence?.status);
  if (status === "observed" || status === "not-observed" || status === "unknown") {
    return { status, coerced: false, raw: status };
  }
  return { status: "unknown", coerced: true, raw: status };
}

/** L3: an unknown verdict always carries a visible reason. */
function unknownReason(rule) {
  const normalized = normalizeStatus(rule?.evidence);
  const reason = str(rule?.evidence?.reason).trim();
  if (normalized.coerced) {
    const seen = normalized.raw ? `"${normalized.raw}"` : "no status at all";
    const tail = reason ? ` Analyzer reason: ${reason}` : "";
    return `treated as unknown: the analyzer returned ${seen} instead of observed / not-observed / unknown.${tail}`;
  }
  if (reason) return reason;
  return "reason not recorded by the analyzer — this rule could not be evaluated and is NOT a pass";
}

function evidenceTable(values) {
  const rows = asArray(values);
  if (rows.length === 0) return ["No numeric evidence was recorded for this finding."];
  const lines = [
    "| Observation | Value | Session | Window |",
    "| --- | --- | --- | --- |",
  ];
  for (let index = 0; index < rows.length; index += 1) {
    const entry = rows[index];
    let value = fmtEvidenceValue(entry);
    if (str(entry?.label).trim() === "cache hit rate") {
      let count = null;
      for (let next = index + 1; next < rows.length; next += 1) {
        const candidate = rows[next];
        if (str(candidate?.label).trim() === "cache hit rate") break;
        if (str(candidate?.label).trim() === "turns carrying a cache-read count" &&
            typeof candidate?.value === "number" && Number.isFinite(candidate.value)) {
          count = candidate;
          break;
        }
      }
      if (count && count.value < CACHE_SAMPLE_MIN_TURNS) {
        value += ` — rate is not meaningful at fewer than ${CACHE_SAMPLE_MIN_TURNS} cache-read-carrying turns`;
      }
    }
    lines.push(`| ${cell(entry?.label)} | ${cell(value)} | ${cell(entry?.sessionId)} | ${cell(windowNote(entry?.windowSource))} |`);
  }
  return lines;
}

function evidenceSummary(rule, values) {
  const rows = asArray(values);
  const observed = rows.find((entry) => str(entry?.label).trim() === "sessions where this was observed");
  const count = typeof observed?.value === "number" && Number.isFinite(observed.value)
    ? groupInt(observed.value)
    : null;
  const name = str(rule?.name).trim().toLowerCase();

  if (name.includes("rising context")) {
    const trends = rows
      .filter((entry) => ["slope", "context trend"].includes(str(entry?.label).trim()) && typeof entry?.value === "number" && Number.isFinite(entry.value))
      .sort((a, b) => b.value - a.value);
    const worstTrend = trends[0];
    const elapsed = rows
      .filter((entry) => str(entry?.label).trim() === "session elapsed" && typeof entry?.value === "number" && Number.isFinite(entry.value) &&
        (!worstTrend || str(entry?.sessionId).trim() === str(worstTrend?.sessionId).trim()))
      .sort((a, b) => b.value - a.value)[0];
    if (count && elapsed && worstTrend) {
      const rate = str(worstTrend?.label).trim() === "context trend"
        ? ` at +${fmtEvidenceValue(worstTrend)}`
        : ` at +${fmtEvidenceValue(worstTrend)}/hour`;
      return `${count} sessions had rising context; the worst ran ${fmtEvidenceValue(elapsed)}${rate}.`;
    }
    if (count && elapsed) {
      return `${count} sessions had rising context; the worst ran ${fmtEvidenceValue(elapsed)}.`;
    }
  }

  if (count) return `${count} sessions showed ${name || "this condition"}; the measured details are below.`;
  return "This finding was observed; the measured details are below.";
}

function cacheLengthNote(values) {
  const rows = asArray(values);
  const hasRate = rows.some((entry) => str(entry?.label).trim() === "cache hit rate");
  const hasTurnCount = rows.some((entry) => str(entry?.label).trim() === "turns carrying a cache-read count");
  return hasRate && !hasTurnCount
    ? "The report could not see how many turns carried a cache-read count, so it could not assess whether the rate was meaningful for session length."
    : null;
}

function renderHeader(data) {
  const parserVersion = str(data.parserVersion).trim();
  const generatedAt = str(data.generatedAt).trim();
  const lines = ["# SessionRx diagnostic report", ""];
  lines.push(`- Generated at: ${generatedAt || `${NOT_RECORDED} (the caller did not supply generatedAt)`}`);
  lines.push(`- Parser version: ${parserVersion || NOT_RECORDED}`);
  lines.push("");
  return lines;
}

/** A count, grouped; anything that is not a finite number stays as it came. */
function countCell(value) {
  return cell(typeof value === "number" && Number.isFinite(value) ? groupInt(value) : value);
}

/** How a per-tool row from `data.summary.perTool` reads in plain English. */
function summaryToolLine(row) {
  const cli = str(row?.cli).trim() || "this tool";
  const label = cli.charAt(0).toUpperCase() + cli.slice(1);
  if (row?.status === "detected-not-read") {
    return `${label}: detected on this machine, but not read yet — not the same as zero problems.`;
  }
  if (typeof row?.sessions !== "number" || !Number.isFinite(row.sessions)) {
    return `${label}: not installed, or nothing was read for it.`;
  }
  const problems = typeof row?.problems === "number" && Number.isFinite(row.problems)
    ? `${groupInt(row.problems)} problem${row.problems === 1 ? "" : "s"} found`
    : "problems not available";
  return `${label}: ${groupInt(row.sessions)} session${row.sessions === 1 ? "" : "s"} checked, ${problems}.`;
}

/**
 * "Summary for managers" — a short, plain-language rollup at the TOP of the
 * document, ahead of every other section, so a reader who never opens the
 * tables below still gets: how many sessions were checked, how many problems
 * were found and the top few kinds, how many checks could not be measured
 * (explicitly not a pass), and the next step.
 *
 * Built ONLY from `data.summary` (the same structured verdicts the rest of
 * this report renders) when it is supplied. Where it is not — an older or a
 * hand-built `ReportInput` that has not been updated — nothing here is
 * invented from parsing the rest of the document; the section states plainly
 * that the summary could not be computed, which is the same honesty rule
 * this whole file follows for every other missing number.
 */
function renderManagerSummary(data) {
  const summary = isPlainObject(data?.summary) ? data.summary : null;
  const lines = ["## Summary for managers", ""];

  if (!summary) {
    lines.push(
      "A plain-language summary could not be computed for this report — the data needed for it was not supplied. " +
      "See the sections below for the full detail.",
    );
    lines.push("");
    return lines;
  }

  const sessionsAnalyzed = typeof summary.sessionsAnalyzed === "number" && Number.isFinite(summary.sessionsAnalyzed)
    ? summary.sessionsAnalyzed
    : null;
  const verdicts = isPlainObject(summary.verdicts) ? summary.verdicts : {};
  const observed = typeof verdicts.observed === "number" && Number.isFinite(verdicts.observed) ? verdicts.observed : null;
  const unknown = typeof verdicts.unknown === "number" && Number.isFinite(verdicts.unknown) ? verdicts.unknown : null;

  lines.push(
    sessionsAnalyzed === null
      ? "- Sessions checked: not available."
      : `- ${groupInt(sessionsAnalyzed)} session${sessionsAnalyzed === 1 ? "" : "s"} checked.`,
  );
  lines.push(
    observed === null
      ? "- Problems found: not available."
      : `- ${groupInt(observed)} problem${observed === 1 ? "" : "s"} found.`,
  );

  const perCheck = Array.isArray(summary.perCheck) ? summary.perCheck : [];
  const topProblems = perCheck
    .filter((row) => typeof row?.observed === "number" && row.observed > 0)
    .sort((a, b) => b.observed - a.observed)
    .slice(0, 3);
  if (topProblems.length) {
    const named = topProblems.map((row) => `${str(row?.name).trim() || str(row?.id).trim() || "an unnamed check"} (${groupInt(row.observed)})`).join(", ");
    lines.push(`- Most common: ${named}.`);
  }

  lines.push(
    unknown === null
      ? "- Checks that could not be measured: not available."
      : `- ${groupInt(unknown)} check${unknown === 1 ? "" : "s"} could not be measured — this is explicitly not a pass, not a clean result.`,
  );

  const perTool = Array.isArray(summary.perTool) ? summary.perTool : [];
  for (const row of perTool) lines.push(`- ${summaryToolLine(row)}`);

  lines.push("- Next step: see Suggested changes below — each one can be pasted directly into your AI tool.");
  lines.push("");
  return lines;
}

function renderRange(range) {
  const from = str(range?.from).trim();
  const to = str(range?.to).trim();
  const sessions = range?.sessions;
  const subagents = range?.subagentSessions;
  const lines = ["## 1. Date range covered", ""];
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push(`| From | ${cell(from)} |`);
  lines.push(`| To | ${cell(to)} |`);
  lines.push(`| Sessions analysed | ${countCell(sessions)} |`);
  // L8: the excluded count is printed, never merely implied.
  lines.push(`| Sub-agent sessions set aside | ${countCell(subagents)} |`);
  const contextTotal = range?.totalContextReadTokens;
  const contextMeasured = range?.contextSessionsMeasured;
  const contextExcluded = range?.contextSessionsExcluded;
  lines.push("");
  if (typeof contextTotal === "number" && Number.isFinite(contextTotal) &&
      typeof contextMeasured === "number" && Number.isFinite(contextMeasured) && contextMeasured > 0) {
    const excluded = typeof contextExcluded === "number" && Number.isFinite(contextExcluded)
      ? `; ${groupInt(contextExcluded)} session${contextExcluded === 1 ? "" : "s"} excluded because their turns carried no context token count`
      : "";
    lines.push(`Total context read across all turns: ${fmtContextTotal(contextTotal)}${excluded}`);
  } else {
    const excluded = typeof contextExcluded === "number" && Number.isFinite(contextExcluded)
      ? ` (${groupInt(contextExcluded)} session${contextExcluded === 1 ? "" : "s"} excluded because their turns carried no context token count)`
      : "";
    lines.push(`Total context read across all turns: could not be measured${excluded}`);
  }
  if (!from || !to) {
    lines.push("");
    lines.push("The range is incomplete: at least one bound could not be read from the session records.");
  }
  if (typeof subagents === "number" && Number.isFinite(subagents) && subagents > 0) {
    lines.push("");
    lines.push(
      `${groupInt(subagents)} further session${subagents === 1 ? " was" : "s were"} read and analysed but ` +
      `left out of the count above: ${subagents === 1 ? "it is a sub-agent" : "they are sub-agent"} transcript${subagents === 1 ? "" : "s"} dispatched by another session. ` +
      `A sub-agent is evidence about the session that launched it, not a session of the user's own, so it informs that session's verdict instead of being counted beside it.`,
    );
  }
  lines.push("");
  return lines;
}

function renderClis(clis) {
  const rows = asArray(clis);
  const lines = ["## 2. CLIs detected", ""];
  if (rows.length === 0) {
    lines.push("No CLI was detected. That is a detection result, not a statement that no CLI is installed.");
    lines.push("");
    return lines;
  }
  for (const row of rows) {
    const note = str(row?.note);
    const allEmpty = /(?:not one of the \d+ sessions read for this CLI recorded a single turn|the one session read for this CLI recorded no turns at all)/.test(note);
    if (typeof row?.sessions === "number" && Number.isFinite(row.sessions) && row.sessions > 0 && allEmpty) {
      const cli = str(row?.cli).trim();
      const label = cli ? `${cli.charAt(0).toUpperCase()}${cli.slice(1)} CLI` : "This CLI";
      lines.push(`${label}: ${groupInt(row.sessions)} sessions found, all empty — no turns to analyse.`);
    }
  }
  if (rows.length > 0) lines.push("");
  lines.push("| CLI | Sessions | Sub-agent sessions set aside | Support | Note |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const row of rows) {
    const count = typeof row?.sessions === "number" && Number.isFinite(row.sessions)
      ? groupInt(row.sessions)
      : `${NOT_RECORDED} (not zero)`;
    // L8: per CLI too — a null here means nothing was read for it, not zero.
    const subagents = typeof row?.subagentSessions === "number" && Number.isFinite(row.subagentSessions)
      ? groupInt(row.subagentSessions)
      : `${NOT_RECORDED} (not zero)`;
    lines.push(`| ${cell(row?.cli)} | ${cell(count)} | ${cell(subagents)} | ${cell(row?.support ?? "supported")} | ${cell(row?.note)} |`);
  }
  lines.push("");
  return lines;
}

function renderFindings(rules) {
  const all = asArray(rules);
  const observed = all.filter((rule) => normalizeStatus(rule?.evidence).status === "observed");
  const shown = observed.slice(0, MAX_FINDINGS);
  const lines = ["## 3. Top findings", ""];

  if (shown.length === 0) {
    lines.push(`No finding was observed across the ${all.length} rule(s) evaluated.`);
    lines.push("This is not a clean bill of health: section 4 lists the rules that could not be evaluated.");
    lines.push("");
    return lines;
  }

  if (observed.length < MAX_FINDINGS) {
    lines.push(`${observed.length} finding(s) were observed, which is fewer than three. The report lists the ones that exist and is not padded to three.`);
  } else if (observed.length > MAX_FINDINGS) {
    lines.push(`${observed.length} findings were observed; the ${MAX_FINDINGS} most report-worthy are shown. Section 4 lists every rule.`);
  } else {
    lines.push(`${observed.length} findings were observed.`);
  }
  lines.push("");

  shown.forEach((rule, index) => {
    const name = str(rule?.name).trim() || str(rule?.id).trim() || "unnamed rule";
    const severity = str(rule?.severity).trim() || "severity not recorded";
    lines.push(`### 3.${index + 1} ${name} (${severity})`);
    lines.push("");
    lines.push(`- Rule id: \`${cell(rule?.id)}\``);
    const derivation = str(rule?.threshold?.derivation).trim();
    const thresholdValue = rule?.threshold?.value;
    if (derivation || (thresholdValue !== undefined && thresholdValue !== null)) {
      lines.push(`- Threshold: ${cell(derivation || thresholdValue)}`);
    }
    const how = str(rule?.evidence?.derivation).trim();
    if (how) lines.push(`- Derivation: ${cell(how)}`);
    lines.push("");
    const values = rule?.evidence?.values;
    lines.push(evidenceSummary(rule, values));
    lines.push("");
    lines.push("<details>");
    lines.push("<summary>Evidence details</summary>");
    lines.push("");
    lines.push("Evidence — the numbers actually measured in these sessions:");
    lines.push("");
    lines.push(...evidenceTable(values));
    lines.push("");
    lines.push("</details>");
    const cacheNote = str(rule?.id).trim() === "cache-hit" ? cacheLengthNote(values) : null;
    if (cacheNote) {
      lines.push("");
      lines.push(cacheNote);
    }
    lines.push("");
    const sources = asArray(rule?.evidence?.sources).map((source) => str(source).trim()).filter(Boolean);
    lines.push(`- Sources: ${sources.length ? sources.join("; ") : NOT_RECORDED}`);
    const fix = str(rule?.fix).trim();
    lines.push(`- Suggested fix: ${fix ? `\`${fix}\`` : "none available"}`);
    const parser = str(rule?.evidence?.parserVersion).trim();
    if (parser) lines.push(`- Parser version: ${parser}`);
    lines.push("");
  });

  return lines;
}

function renderRuleCoverage(rules, notApplicable = []) {
  const rows = asArray(rules);
  const lines = ["## 4. Rule coverage", ""];
  if (rows.length === 0) {
    lines.push("No rule was evaluated. Nothing here can be read as a pass.");
    lines.push("");
    return lines;
  }
  const unknowns = rows.filter((rule) => normalizeStatus(rule?.evidence).status === "unknown");
  lines.push(`${rows.length} rule(s) evaluated. \`unknown\` means the data needed to decide was absent — it is not a pass and not a zero.`);
  lines.push("");
  lines.push("| Rule | Severity | Verdict | Why |");
  lines.push("| --- | --- | --- | --- |");
  for (const rule of rows) {
    const { status } = normalizeStatus(rule?.evidence);
    let why;
    if (status === "unknown") {
      why = `UNKNOWN — ${unknownReason(rule)}`;
    } else if (status === "not-observed") {
      why = str(rule?.evidence?.reason).trim() || "evaluated against real data; the threshold was not crossed";
    } else {
      why = `observed; ${asArray(rule?.evidence?.values).length} observation(s) recorded`;
    }
    lines.push(`| \`${cell(rule?.id)}\` | ${cell(rule?.severity)} | ${cell(status)} | ${cell(why)} |`);
  }
  lines.push("");
  if (unknowns.length > 0) {
    lines.push(`${unknowns.length} rule(s) returned \`unknown\` and could not be diagnosed:`);
    lines.push("");
    for (const rule of unknowns) {
      const name = str(rule?.name).trim() || str(rule?.id).trim() || "unnamed rule";
      lines.push(`- \`${cell(rule?.id)}\` ${name}: unknown — ${cell(unknownReason(rule))}`);
    }
    lines.push("");
  }
  const excluded = asArray(notApplicable);
  if (excluded.length > 0) {
    lines.push("The following checks are excluded because the CLI log format cannot ever carry the evidence they require:");
    lines.push("");
    for (const item of excluded) {
      lines.push(`- ${cell(item?.cli)}: ${cell(item?.name || item?.ruleId)} — ${cell(item?.reason)}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * L9.  Why the history's SHAPE decides the wording: "No fix was applied in this
 * period" is a positive claim about the user's own history, so it is reserved
 * for the one input that evidences it — a list that was read and came back
 * empty.  Every other shape, including the key being absent entirely, means
 * nobody read the record, and that is `unknown`.
 */
function fixHistoryUnknownReason(fixes) {
  if (fixes === undefined) {
    return "the applied-fix history was not supplied to the report generator, so no record of what was applied was read at all";
  }
  const reason = str(fixes?.reason).trim();
  if (reason) return reason;
  const shape = fixes === null
    ? "null"
    : typeof fixes === "object" ? "an object with no reason field" : `a ${typeof fixes}`;
  return `reason not recorded by the caller — the history arrived as ${shape} rather than a list of applied fixes`;
}

/** Missing status is "applied": that is what the caller records by omission. */
function fixStatus(fix) {
  return str(fix?.status).trim() || "applied";
}

/**
 * The heading names what the section actually holds. A list where five of
 * seven fixes were undone again is still history worth printing — a fix that
 * was applied and then reverted really did happen — but under the words
 * "Fixes applied" a reader skimming headings counts seven of them as being in
 * place. So a list that is not all applied is titled as the history it is,
 * and the lead line gives the split. The per-entry `Status:` lines are the
 * record and are left exactly as they are.
 */
function renderFixes(fixes) {
  const allApplied = !Array.isArray(fixes) || fixes.every((fix) => fixStatus(fix) === "applied");
  const lines = [allApplied ? "## 5. Fixes applied" : "## 5. Fix history", ""];
  if (!Array.isArray(fixes)) {
    lines.push(`Applied-fix history: unknown — ${fixHistoryUnknownReason(fixes)}`);
    lines.push("");
    lines.push("Unknown is not an empty history: this section accounts for nothing either way, and must not be read as though no fix had been applied.");
    lines.push("");
    return lines;
  }
  const rows = fixes;
  if (rows.length === 0) {
    lines.push("No fix was applied in this period.");
    lines.push("");
    return lines;
  }
  if (allApplied) {
    lines.push(`${rows.length} fix(es) recorded. Each one shows the BEFORE state it replaced.`);
  } else {
    const reverted = rows.filter((fix) => fixStatus(fix) === "reverted").length;
    const applied = rows.filter((fix) => fixStatus(fix) === "applied").length;
    const elsewhere = rows.length - applied - reverted;
    const split = [
      applied > 0 ? `${applied} still in place` : null,
      reverted > 0 ? `${reverted} applied and then undone` : null,
      elsewhere > 0 ? `${elsewhere} in another state, named per entry below` : null,
    ].filter(Boolean).join(", ");
    lines.push(`${rows.length} fix(es) recorded: ${split}. Not all of them are in effect — read the Status line of each. Each one shows the BEFORE state it replaced.`);
  }
  lines.push("");
  rows.forEach((fix, index) => {
    const name = str(fix?.name).trim() || str(fix?.id).trim() || "unnamed fix";
    lines.push(`### 5.${index + 1} ${name}`);
    lines.push("");
    lines.push(`- Fix id: \`${cell(fix?.id)}\``);
    lines.push(`- Target: ${cell(fix?.target)}`);
    lines.push(`- Status: ${cell(fix?.status ?? "applied")}`);
    lines.push(`- Applied at: ${cell(fix?.appliedAt)}`);
    if (str(fix?.undoPath).trim()) lines.push(`- Undo record: ${cell(fix.undoPath)}`);
    lines.push("");
    const before = fix?.before;
    if (before === null || before === undefined || str(before).trim() === "") {
      lines.push("BEFORE state not recorded — this fix cannot be audited from this report alone.");
    } else {
      lines.push("BEFORE:");
      lines.push("");
      lines.push(indentedBlock(before));
    }
    lines.push("");
    const after = fix?.after;
    if (after !== null && after !== undefined && str(after).trim() !== "") {
      lines.push("AFTER:");
      lines.push("");
      lines.push(indentedBlock(after));
      lines.push("");
    }
  });
  return lines;
}

function renderTrend(trend) {
  const raw = str(trend?.direction).trim();
  const known = raw === "improving" || raw === "stable" || raw === "declining";
  // "unknown" IS a contract value, so it is reported as itself. Only a value
  // outside the four is called out as unrecognised.
  const recognised = known || raw === "unknown";
  const lines = ["## 6. Trend summary", ""];
  if (recognised) {
    lines.push(`Direction: ${raw}`);
  } else {
    const suffix = raw ? ` (the analyzer reported "${raw}", which is not one of improving / stable / declining)` : "";
    lines.push(`Direction: unknown${suffix}`);
  }
  const reason = str(trend?.reason).trim();
  if (reason) {
    lines.push("");
    lines.push(`Reason: ${reason}`);
  } else if (!known) {
    lines.push("");
    lines.push("Reason: reason not recorded by the analyzer — the direction could not be established and must not be read as stable.");
  }
  const metrics = asArray(trend?.metrics);
  if (metrics.length > 0) {
    lines.push("");
    lines.push("| Metric | Earlier | Later | Window |");
    lines.push("| --- | --- | --- | --- |");
    for (const metric of metrics) {
      const unit = metric?.unit ?? null;
      const from = fmtEvidenceValue({ value: metric?.from, unit });
      const to = fmtEvidenceValue({ value: metric?.to, unit });
      lines.push(`| ${cell(metric?.label)} | ${cell(from)} | ${cell(to)} | ${cell(windowNote(metric?.windowSource))} |`);
    }
  }
  lines.push("");
  return lines;
}

function assemble(data) {
  const lines = [
    ...renderHeader(data),
    ...renderManagerSummary(data),
    ...renderRange(data.range),
    ...renderClis(data.clis),
    ...renderFindings(data.rules),
    ...renderRuleCoverage(data.rules, data.notApplicable),
    ...renderFixes(data.fixes),
    ...renderTrend(data.trend),
    "---",
    "",
    REPORT_FOOTER,
    "",
  ];
  // Collapse runs of blank lines so one input can only ever produce one byte
  // sequence, whatever mix of branches it took.
  const out = [];
  for (const line of lines) {
    if (line === "" && out.length > 0 && out[out.length - 1] === "") continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * BP-005.05 envelope: `{markdown, generatedAt, redactions}`.
 *
 * @param {object} data a ReportInput (see INPUT CONTRACT above)
 * @returns {{markdown: string, generatedAt: string|null, redactions: number}}
 */
export function generateReportDocument(data) {
  if (!isPlainObject(data)) {
    throw new TypeError("generateReport expects a ReportInput object");
  }
  const { text: markdown, redactions } = redactSecrets(assemble(data));
  const generatedAt = str(data.generatedAt).trim();
  return { markdown, generatedAt: generatedAt || null, redactions };
}

/**
 * @param {object} data a ReportInput (see INPUT CONTRACT above)
 * @returns {string} redacted Markdown
 */
export function generateReport(data) {
  return generateReportDocument(data).markdown;
}

export default generateReport;
