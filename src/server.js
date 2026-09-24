/**
 * SessionRx local HTTP surface — BP-005.
 *
 * This process never writes a user's files (THE SUGGESTION CONTRACT). Every
 * route is GET: it reads local session logs and, read-only, whether a
 * suggestion's marker is already present in a target file it could resolve.
 * Nothing here has a request body to parse and nothing here mutates state, so
 * there is no CSRF surface — the per-process nonce and `X-CSRF-Token` machinery
 * earlier versions carried existed solely to protect the apply/undo routes
 * that no longer exist.
 *
 * Loopback is still NOT a security boundary on its own: any page the developer
 * has open in any tab can `fetch('http://127.0.0.1:<port>/…')` and DNS
 * rebinding can point an attacker's hostname at this same port, so the Host
 * header is checked on EVERY method (not only a CSRF concern — a GET response
 * is worth protecting too) against an exact loopback host:port allowlist built
 * from the address this process actually bound. There are deliberately NO CORS
 * headers: a cross-origin caller is refused, not negotiated with. Cookies are
 * never read or set; there is no ambient credential for an attacker to ride.
 *
 * ── Honest degradation ──────────────────────────────────────────────────────
 * Analysis modules are imported LAZILY inside try/catch. A route whose
 * dependency is absent answers `503` with a named missing dependency. It never
 * answers `200 {}` — in the UI an empty success renders as "everything is
 * fine, no data", which is the exact lie this product exists to stop.
 *
 * ── Secret handling (BP-005.15 / FVA-004) ───────────────────────────────────
 * Every JSON body is passed through the report generator's `redactSecrets`
 * before it leaves the process. No second pattern set is defined here; see
 * `redactJson` for how the same exported redactor is applied to a JSON tree.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { dayKeysEndingAt, localDayKey } from "./analyzer/trends.js";
import { buildSuggestions, listSuggestionIds, suggestionTitleFor, TOOL_IDS, toolLabel } from "./suggestions/index.js";
import { SUGGESTION_DEFS } from "./suggestions/sections.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Shipped frontend. Nothing outside this directory is ever served. */
export const DEFAULT_PUBLIC_DIR = path.resolve(HERE, "..", "public");

/** The only interface this server is allowed to bind. Never the wildcard one. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Loopback peer addresses, in the forms Node reports them. */
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Lazily imported dependencies. Overridable per-app for tests. */
export const DEFAULT_MODULES = Object.freeze({
  registry: "./collectors/registry.js",
  health: "./analyzer/health.js",
  trends: "./analyzer/trends.js",
  report: "./report/generator.js",
});

/**
 * Publish each rule's suggestion title and target tool next to its id, and
 * each session's display name, so no client keeps a second copy of either
 * catalogue.
 *
 * PRODUCT DECISION: a suggestion targets the SAME tool whose session showed
 * the problem — a Codex problem gets a Codex-targeted suggestion — so the
 * target tool here is simply `session.cli`, not a fixed CLI a catalogue
 * entry names. `rule.fix` is still the id `src/analyzer/rules.js` names
 * (unchanged); it now looks up `src/suggestions/sections.js` instead of a
 * fix class. A session whose CLI is not one of the four SessionRx knows how
 * to suggest a change for (`TOOL_IDS`) publishes `suggestionAvailable: false`
 * rather than a guessed target.
 *
 * Mutates in place: these objects are built fresh by `analyzeAll` per request.
 *
 * @param {Array<object>|undefined} sessions
 * @param {Map<string, string>} displayNames
 */
export function annotateSuggestions(sessions, displayNames = new Map()) {
  for (const session of Array.isArray(sessions) ? sessions : []) {
    session.cliName = typeof session?.cli === "string" ? displayNames.get(session.cli) ?? null : null;
    const toolId = typeof session?.cli === "string" && TOOL_IDS.includes(session.cli) ? session.cli : null;
    for (const rule of Array.isArray(session?.rules) ? session.rules : []) {
      if (!rule || typeof rule !== "object") continue;
      const hasFix = typeof rule.fix === "string" && rule.fix.length > 0;
      const title = hasFix && toolId ? suggestionTitleFor(rule.fix, toolId) : null;
      rule.suggestionAvailable = Boolean(title);
      rule.suggestionTitle = title;
      rule.suggestionTool = rule.suggestionAvailable ? toolId : null;
      rule.suggestionToolName = rule.suggestionAvailable ? (displayNames.get(toolId) ?? toolLabel(toolId)) : null;
      rule.suggestionUnavailableReason = !hasFix
        ? null
        : rule.suggestionAvailable
          ? null
          : toolId
            ? "sessionrx has no suggestion definition for this id"
            : "sessionrx does not offer a suggested change for this CLI";
    }
    // A sub-agent session carries the same six verdicts and the same offers.
    annotateSuggestions(session?.subagentSessions, displayNames);
  }
}

const REDACTED = "[REDACTED]";
const MAX_LIMIT = 5000;

/**
 * Newest sessions read PER COLLECTOR when the caller names no bound.
 *
 * Measured on a heavy real corpus (2026-09-20, this machine): 50/collector took
 * 0.79s, 250 took 3.4s, and an UNBOUNDED scan had not finished after 60s. An
 * API call that takes minutes is not a usable dashboard, so the scan is bounded
 * by default — and every response that was produced from a bounded scan says so
 * in its `scan` block, including whether the bound was actually reached. A
 * capped count is never presented as a corpus total.
 */
export const DEFAULT_SCAN_LIMIT = 250;

/**
 * Sessions actually SERIALIZED by `/api/health`, as opposed to analyzed.
 *
 * Mirrors `SESSION_LIMIT` in `public/js/pages/health.js`: the health page
 * only ever renders the newest 10 cards, so sending the full analyzed corpus
 * on the wire is pure waste — measured on a heavy real corpus (2026-09-20,
 * this machine) at 1,236 sessions / 18.2MB / 6.5s for a page that renders 10.
 * The SCAN behind the analysis is untouched by this constant (it is bounded
 * separately by `DEFAULT_SCAN_LIMIT`/`?limit=`, and `corpusComplete` in the
 * analyzer must keep depending on THAT bound, never on this one) — only how
 * many of the already-analyzed sessions get put in the response body.
 */
export const HEALTH_CARD_LIMIT = 10;

/**
 * Sessions actually SERIALIZED by `/api/sessions` in one page, when the caller
 * names no page size.
 *
 * The same fix as `HEALTH_CARD_LIMIT` above, for the same reason and with the
 * same boundary. Measured on a heavy real corpus (2026-09-21, this machine):
 * one `/api/sessions` call returned 1,236 sessions in 45,948,574 bytes — 43.8MB
 * of JSON, most of it absolute paths, for a table that shows about twenty rows
 * before the reader has to scroll. The page now asks for those twenty and
 * fetches the next twenty when the reader reaches the bottom.
 *
 * What this constant does NOT touch, and must never be made to touch: the SCAN.
 * The corpus is still read under `DEFAULT_SCAN_LIMIT`/`?scan=`, still analyzed
 * whole, and `corpusComplete` in `src/analyzer/health.js` still derives from
 * THAT bound — `subagent-concurrency` flips to `unknown` when the corpus is
 * incomplete, so narrowing the scan here would silently rewrite verdicts across
 * every session. Only the slice that reaches the wire is narrowed, and `total`
 * keeps reporting the whole match so the page can say how many it is not
 * showing.
 */
export const SESSIONS_PAGE_LIMIT = 20;
const BODY_LIMIT = "256kb";
const SORT_FIELDS = new Set(["startedAt", "endedAt", "score", "turnCount", "cli", "project", "sessionId"]);

// ---------------------------------------------------------------------------
// Lazy module loading
// ---------------------------------------------------------------------------

/**
 * Import cache. Successes are cached for the life of the process; FAILURES are
 * not, so a server started while another wave is still writing its module picks
 * the module up on the next request instead of needing a restart.
 */
function createLoader(specifiers) {
  const cache = new Map();
  return async function load(name) {
    if (cache.has(name)) return cache.get(name);
    const specifier = specifiers[name];
    if (!specifier) {
      return { ok: false, name, specifier: null, error: new Error(`no module registered for "${name}"`) };
    }
    if (typeof specifier === "object") {
      // Pre-supplied module object (tests inject stubs this way).
      const result = { ok: true, name, specifier: "(injected)", module: specifier };
      cache.set(name, result);
      return result;
    }
    try {
      const module = await import(specifier);
      const result = { ok: true, name, specifier, module };
      cache.set(name, result);
      return result;
    } catch (error) {
      return { ok: false, name, specifier, error };
    }
  };
}

// ---------------------------------------------------------------------------
// Secret redaction (BP-005.15) — built ON the generator's exported redactor
// ---------------------------------------------------------------------------

/**
 * Apply the report generator's `redactSecrets` to a JSON tree.
 *
 * `redactSecrets` works on TEXT, and its strongest rule is keyed
 * (`token: <value>` → `token: [REDACTED]`). In a JSON tree the key and the
 * value are not adjacent characters, so that rule can never fire on a value
 * alone. Running the redactor over the serialized JSON instead is not an
 * option: the keyed replacement drops the surrounding quotes and would emit
 * invalid JSON.
 *
 * So each string leaf is redacted twice with the SAME imported redactor and no
 * new patterns: once on its own text, and once inside a `key=value` probe. If
 * the probe produced more matches than the value alone, the KEY is what made it
 * credential-shaped and the whole value is dropped. The generator stays the one
 * source of truth for what counts as a secret.
 *
 * @param {unknown} value
 * @param {(input: unknown) => {text: string, redactions: number}} redactSecrets
 * @returns {{value: unknown, redactions: number}}
 */
export function redactJson(value, redactSecrets) {
  let redactions = 0;

  const walkString = (key, text) => {
    const self = redactSecrets(text);
    const probe = `${key ?? ""}=${JSON.stringify(text)}`;
    const keyed = redactSecrets(probe);
    if (key && keyed.redactions > self.redactions) {
      redactions += keyed.redactions;
      return REDACTED;
    }
    redactions += self.redactions;
    return self.text;
  };

  const walk = (node, key, seen) => {
    if (typeof node === "string") return walkString(key, node);
    if (node === null || typeof node !== "object") return node;
    if (seen.has(node)) return "[circular]";
    seen.add(node);
    let out;
    if (Array.isArray(node)) {
      out = node.map((item) => walk(item, key, seen));
    } else {
      out = {};
      for (const [childKey, childValue] of Object.entries(node)) {
        out[childKey] = walk(childValue, childKey, seen);
      }
    }
    seen.delete(node);
    return out;
  };

  return { value: walk(value, null, new WeakSet()), redactions };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function isLoopbackPeer(address) {
  if (typeof address !== "string" || address.length === 0) return false;
  return LOOPBACK_PEERS.has(address);
}

/**
 * The ONE Host-header check. Exact match only (never a suffix/substring
 * match — `localhost.evil.com` must fail this) against the loopback
 * host:port allowlist built from the address this server actually bound.
 * Runs on every method, including a bare GET, because DNS rebinding can make
 * even a read leak once the browser treats the response as same-origin with
 * an attacker's page.
 */
function isAllowedHost(state, req) {
  const host = req.headers.host;
  return typeof host === "string" && state.hostAllowlist.has(host.toLowerCase());
}

function parseIsoDate(raw, label) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new HttpError(400, `${label} must be a single ISO-8601 timestamp`);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new HttpError(400, `${label} is not a valid ISO-8601 timestamp: ${raw}`);
  return new Date(ms);
}

function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new HttpError(400, "limit must be a single positive integer");
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `limit must be a positive integer: ${raw}`);
  const value = Number(raw);
  if (value < 1) throw new HttpError(400, "limit must be at least 1");
  return Math.min(value, MAX_LIMIT);
}

/**
 * `?offset=` — the row a page starts at, counted AFTER filter and sort.
 *
 * Malformed is REJECTED and oversized is CLAMPED, and the difference is
 * deliberate. `offset=abc`, `offset=-1`, `offset=1.5` and `offset=NaN` are
 * caller bugs: reading any of them as 0 would silently serve page 1 to a client
 * that believes it is on page 9, so they get a 400 that names the bad value.
 * An offset merely past the end of the corpus is not a bug — a list can shrink
 * between two requests — so it is answered with an empty page. Values beyond
 * `Number.MAX_SAFE_INTEGER` are clamped to it rather than rejected, because
 * past-the-end is past-the-end and the arithmetic below stays exact.
 */
function parseOffset(raw) {
  if (raw === undefined || raw === null || raw === "") return 0;
  if (typeof raw !== "string") throw new HttpError(400, "offset must be supplied at most once");
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `offset must be a non-negative integer: ${raw}`);
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

function parseCsvList(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : null;
}

function singleValue(raw, label) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new HttpError(400, `${label} must be supplied at most once`);
  return raw;
}

class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Session filtering / sorting (BP-005.02)
// ---------------------------------------------------------------------------

function sessionTime(session) {
  const started = Date.parse(session?.startedAt ?? "");
  if (Number.isFinite(started)) return started;
  const ended = Date.parse(session?.endedAt ?? "");
  return Number.isFinite(ended) ? ended : null;
}

export function filterSessions(sessions, { cli, project, from, to } = {}) {
  const clis = cli ? new Set(cli.map((item) => item.toLowerCase())) : null;
  const needle = typeof project === "string" && project !== "" ? project.toLowerCase() : null;
  const fromMs = from ? from.getTime() : null;
  const toMs = to ? to.getTime() : null;

  return sessions.filter((session) => {
    if (clis && !clis.has(String(session?.cli ?? "").toLowerCase())) return false;
    if (needle) {
      const haystack = `${session?.project ?? ""}\n${session?.cwd ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (fromMs !== null || toMs !== null) {
      const at = sessionTime(session);
      // A session with no recoverable timestamp is EXCLUDED from a bounded
      // window rather than assumed to be inside it.
      if (at === null) return false;
      if (fromMs !== null && at < fromMs) return false;
      if (toMs !== null && at > toMs) return false;
    }
    return true;
  });
}

function sessionWindow(sessions, { cli, project, from, to } = {}) {
  const applied = from !== null && from !== undefined || to !== null && to !== undefined;
  if (!Array.isArray(sessions)) {
    return {
      applied,
      from: applied && from ? from.toISOString() : null,
      to: applied && to ? to.toISOString() : null,
      excludedUndated: applied ? null : 0,
      matched: null,
    };
  }
  const base = filterSessions(sessions, { cli, project });
  const matchedSessions = filterSessions(base, { from, to });
  return {
    applied,
    from: applied && from ? from.toISOString() : null,
    to: applied && to ? to.toISOString() : null,
    excludedUndated: applied ? base.filter((session) => sessionTime(session) === null).length : 0,
    matched: matchedSessions.length,
  };
}

function calculateWindowTotals(sessions) {
  const totals = {
    sessions: sessions.length,
    observedFindings: 0,
    fixableFindings: 0,
    unknownChecks: 0,
    notObservedChecks: 0,
    measuredChecks: 0,
  };
  for (const session of sessions) {
    for (const rule of Array.isArray(session?.rules) ? session.rules : []) {
      const status = rule?.evidence?.status;
      if (status === "observed") {
        totals.observedFindings += 1;
        if (rule.fix) totals.fixableFindings += 1;
      } else if (status === "not-observed") {
        totals.notObservedChecks += 1;
      } else {
        totals.unknownChecks += 1;
      }
    }
  }
  totals.measuredChecks = totals.observedFindings + totals.notObservedChecks;
  return totals;
}

function calculateTopFixes(sessions) {
  const byRule = new Map();
  for (const session of sessions) {
    const observedRules = new Set();
    for (const rule of Array.isArray(session?.rules) ? session.rules : []) {
      if (!rule?.fix || rule?.evidence?.status !== "observed") continue;
      const current = byRule.get(rule.id) ?? {
        id: rule.id,
        name: rule.name ?? null,
        fixId: rule.fix,
        sessions: 0,
        findings: 0,
      };
      current.findings += 1;
      byRule.set(rule.id, current);
      observedRules.add(rule.id);
    }
    for (const ruleId of observedRules) byRule.get(ruleId).sessions += 1;
  }
  return [...byRule.values()].sort(
    (a, b) => b.sessions - a.sessions || b.findings - a.findings || a.id.localeCompare(b.id),
  );
}

/**
 * "Suggestions available" is a promise the product has to be able to keep, so
 * it is counted against the suggestion catalogue this build actually carries
 * (`listSuggestionIds()`), never a second list of ids kept here. A rule is
 * free to name any id; an id with no suggestion definition behind it has
 * nothing `/api/suggestions` can generate, so offering it would send the
 * user to a remedy that does not exist.
 *
 * A finding whose fix id is unknown does NOT disappear: it stays an observed
 * finding in `windowTotals.observedFindings`, and is published here as
 * `unknownFixFindings` / `unknownFixIds` so the gap between "a problem was
 * found" and "a suggestion exists for it" is visible instead of silent. Only
 * the availability claim is withdrawn.
 *
 * `windowTotals.fixableFindings` is a different measurement on purpose — it
 * counts findings that NAME a fix id, catalogue or not — and is left alone.
 */
export function calculateDistinctFixes(sessions, suggestionIds = listSuggestionIds()) {
  const catalogIds = new Set(suggestionIds);
  const fixIds = new Set();
  const clis = new Set();
  const unknownFixIds = new Set();
  let findings = 0;
  let unknownFixFindings = 0;
  for (const session of Array.isArray(sessions) ? sessions : []) {
    for (const rule of Array.isArray(session?.rules) ? session.rules : []) {
      if (rule?.evidence?.status !== "observed" || typeof rule?.fix !== "string" || !rule.fix) continue;
      if (!catalogIds.has(rule.fix)) {
        unknownFixIds.add(rule.fix);
        unknownFixFindings += 1;
        continue;
      }
      fixIds.add(rule.fix);
      findings += 1;
      if (typeof session?.cli === "string" && session.cli) clis.add(session.cli);
    }
  }
  // The tools a suggestion could actually target: every SUPPORTED session CLI
  // among the findings counted above, not a fixed "Claude Code only" list —
  // a suggestion now targets whichever tool the finding came from.
  const fixClis = new Set([...clis].filter((cli) => TOOL_IDS.includes(cli)));
  return {
    count: fixIds.size,
    findings,
    clis: [...clis].sort(),
    fixClis: [...fixClis].sort(),
    unknownFixFindings,
    unknownFixIds: [...unknownFixIds].sort(),
  };
}

function localCalendarDayCount(from, to) {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  let count = 1;
  while (start < end) {
    start.setDate(start.getDate() + 1);
    count += 1;
  }
  return count;
}

function calculateWindowSeries(sessions, query) {
  const dated = sessions
    .map((session) => {
      const started = Date.parse(session?.startedAt ?? "");
      return Number.isFinite(started) ? new Date(started) : null;
    })
    .filter(Boolean);
  let days = [];
  if (query.from instanceof Date && query.to instanceof Date) {
    days = dayKeysEndingAt(query.to, localCalendarDayCount(query.from, query.to));
  } else if (dated.length > 0) {
    const keys = dated.map(localDayKey).sort();
    const first = new Date(`${keys[0]}T12:00:00`);
    const last = new Date(`${keys[keys.length - 1]}T12:00:00`);
    days = dayKeysEndingAt(last, localCalendarDayCount(first, last));
  }
  const index = new Map(days.map((day, i) => [day, i]));
  const series = {
    days,
    sessions: new Array(days.length).fill(0),
    observedFindings: new Array(days.length).fill(0),
    fixableFindings: new Array(days.length).fill(0),
    unknownChecks: new Array(days.length).fill(0),
    undated: 0,
  };
  for (const session of sessions) {
    const started = Date.parse(session?.startedAt ?? "");
    if (!Number.isFinite(started)) {
      series.undated += 1;
      continue;
    }
    const day = index.get(localDayKey(new Date(started)));
    if (day === undefined) continue;
    series.sessions[day] += 1;
    for (const rule of Array.isArray(session?.rules) ? session.rules : []) {
      const status = rule?.evidence?.status;
      if (status === "observed") {
        series.observedFindings[day] += 1;
        if (rule.fix) series.fixableFindings[day] += 1;
      } else if (status !== "not-observed") {
        series.unknownChecks[day] += 1;
      }
    }
  }
  return series;
}

function calculateCoverage(result) {
  const limit = result.scan.limitPerCollector;
  const boundedClis = new Set(
    (Array.isArray(result.analysis?.collectors) ? result.analysis.collectors : [])
      .filter((collector) => Number.isInteger(collector?.sessions) && collector.sessions >= limit)
      .map((collector) => collector.cli),
  );
  const oldestByCli = new Map();
  for (const session of Array.isArray(result.analysis?.sessions) ? result.analysis.sessions : []) {
    if (!boundedClis.has(session?.cli)) continue;
    const startedAt = Date.parse(session?.startedAt ?? "");
    if (!Number.isFinite(startedAt)) continue;
    const existing = oldestByCli.get(session.cli);
    if (existing === undefined || startedAt < existing) oldestByCli.set(session.cli, startedAt);
  }
  const oldest = [...oldestByCli.values()];
  const completeFrom = oldest.length
    ? new Date(Math.max(...oldest)).toISOString().slice(0, 10)
    : null;
  return {
    atLimit: result.scan.atLimit,
    completeFrom,
    reason: completeFrom === null
      ? null
      : `the scan reached its ${limit}-per-CLI bound and did not read back before ${completeFrom}`,
  };
}

function calculateComparison(query, coverage, scan, allSessions, windowTotals) {
  const explicitWindow = query.from instanceof Date && query.to instanceof Date;
  const windowDays = explicitWindow ? localCalendarDayCount(query.from, query.to) : null;
  const windowMs = explicitWindow ? windowDays * 86400000 : null;
  const previousFrom = explicitWindow ? new Date(query.from) : null;
  if (previousFrom) previousFrom.setDate(previousFrom.getDate() - windowDays);
  const previousTo = explicitWindow ? query.from : null;
  const previousStart = previousFrom ? previousFrom.toISOString().slice(0, 10) : null;
  const blockedByCoverage = coverage.completeFrom !== null
    && previousStart < coverage.completeFrom;
  const available = explicitWindow && !blockedByCoverage;
  if (!available) {
    const reason = !explicitWindow
      ? "an explicit from and to window were not supplied, so the previous window cannot be compared"
      : `the scan reached its ${scan.limitPerCollector}-per-CLI bound and did not read back to ${previousStart}, so the previous ${windowDays} days cannot be compared`;
    return { available: false, reason, windowDays, previous: null, deltas: null };
  }
  const previous = calculateWindowTotals(filterSessions(allSessions, { from: previousFrom, to: new Date(previousTo.getTime() - 1) }));
  const deltas = {};
  for (const key of Object.keys(windowTotals)) {
    const from = previous[key];
    const to = windowTotals[key];
    deltas[key] = {
      from,
      to,
      changePercent: from === 0 ? null : Math.round(((to - from) / from) * 1000) / 10,
    };
  }
  return { available: true, reason: null, windowDays, previous, deltas };
}

function calculateTrendDelta(rows, metric) {
  const half = Math.floor(rows.length / 2);
  const olderRows = rows.slice(0, half);
  const newerRows = rows.slice(rows.length - half);
  const older = olderRows.filter((row) => row?.hasData === true && Number.isFinite(row?.[metric])).map((row) => row[metric]);
  const newer = newerRows.filter((row) => row?.hasData === true && Number.isFinite(row?.[metric])).map((row) => row[metric]);
  const reasonPrefix = rows.length % 2 === 1 ? "the middle day was dropped; " : "";
  const reason = (suffix) => `${reasonPrefix}${suffix}`;
  if (older.length === 0 || newer.length === 0) {
    return {
      metric,
      from: null,
      to: null,
      changePercent: null,
      firstHalfDays: older.length,
      secondHalfDays: newer.length,
      available: false,
      reason: reason("one half has no measured days with data, so no percentage is published"),
    };
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const from = Math.round(mean(older) * 100) / 100;
  const to = Math.round(mean(newer) * 100) / 100;
  return {
    metric,
    from,
    to,
    changePercent: from === 0 ? null : Math.round(((to - from) / from) * 1000) / 10,
    firstHalfDays: older.length,
    secondHalfDays: newer.length,
    available: true,
    reason: from === 0
      ? reason("the older-half mean is 0, so a percentage change is undefined")
      : reason("arithmetic over measured days only"),
  };
}

function calculateTrendDeltas(charts) {
  return {
    context: calculateTrendDelta(charts.context ?? [], "highContextPct"),
    spend: calculateTrendDelta(charts.spend ?? [], "total"),
    cache: calculateTrendDelta(charts.cache ?? [], "hitRate"),
  };
}

function collectedSessions(collected) {
  if (!Array.isArray(collected?.supported)) return null;
  return collected.supported.flatMap((entry) => Array.isArray(entry?.sessions) ? entry.sessions : []);
}

export function sortSessions(sessions, field = "startedAt", order = "desc") {
  const key = SORT_FIELDS.has(field) ? field : "startedAt";
  const direction = order === "asc" ? 1 : -1;
  const value = (session) => {
    if (key === "startedAt" || key === "endedAt") {
      const ms = Date.parse(session?.[key] ?? "");
      return Number.isFinite(ms) ? ms : null;
    }
    const raw = session?.[key];
    return raw === undefined ? null : raw;
  };
  return [...sessions].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    // Nulls sort last in BOTH directions: "not recorded" is never the top row.
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
    return String(left).localeCompare(String(right)) * direction;
  });
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Relaxed for style ONLY: the page modules are still same-origin-script-only,
  // and blocking a teammate's inline style would break the UI silently.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

// ---------------------------------------------------------------------------
// Scan cache — read the corpus once, serve many pages from it
// ---------------------------------------------------------------------------

/**
 * Collected corpora held in memory at once.
 *
 * Deliberately tiny, and bounded by MEMORY rather than by hit rate: one entry
 * is a whole collected corpus, measured on a heavy real corpus (2026-09-21,
 * this machine) at 1,236 sessions / 82.4MB serialized / 120MB of retained heap
 * (heapUsed with the corpus held, after `--expose-gc`, minus the same reading
 * without it). Three covers what the four pages actually ask for — the unfiltered
 * scan every page shares, plus two date-windowed or explicitly-widened
 * variants — and a fourth distinct scan evicts the least recently used one
 * rather than adding to the pile. The bound is a constant: it does not grow
 * with the size of the corpus, with uptime, or with the number of requests.
 */
export const SCAN_CACHE_MAX_ENTRIES = 3;

/**
 * Files the invalidation walk will stat before it refuses to answer.
 *
 * The walk exists to be cheap. Measured at ~14µs per file on this machine, so
 * 100,000 files is ~1.4s — already at the edge of what may be spent checking
 * whether a 4.7s scan is still true. Past it the check is no longer cheap, and
 * a check that is not cheap is the wrong check: the signature comes back
 * `null`, the cache disengages, and every request re-scans exactly as it did
 * before this cache existed.
 */
export const SCAN_SIGNATURE_MAX_FILES = 100_000;

/** Parallel `stat` calls in the invalidation walk (measured: 221ms serial -> 82ms). */
const SIGNATURE_STAT_CONCURRENCY = 64;

/** `stat` many paths at a bounded concurrency, in input order. */
async function statMany(paths, concurrency) {
  const out = new Array(paths.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= paths.length) return;
      try {
        const stat = await fs.stat(paths[index]);
        out[index] = [stat.mtimeMs, stat.size];
      } catch {
        // A file that vanished between listing and stat is itself a change.
        out[index] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, paths.length)) }, worker));
  return out;
}

/**
 * A cheap fingerprint of the session files a scan would read.
 *
 * The scan PARSES those files, which is what costs seconds. This walks the same
 * roots and reads only what the filesystem already knows — which files exist,
 * how big they are, when they last changed — so the check that decides whether
 * a cached scan is still true costs a fraction of the scan it guards. Measured
 * on a heavy real corpus (2026-09-21, this machine): 20,218 files under 6,608
 * directories across five collector roots, ~280ms warm, against 4,701ms for the
 * `collectAll` it lets us skip.
 *
 * It never re-parses anything, and it is deliberately CONSERVATIVE: a touched
 * file outside the newest-N window a collector would actually read still
 * invalidates. Re-scanning when nothing that mattered changed costs time; not
 * re-scanning when something did costs the truth.
 *
 * Two outcomes mean "do not cache", and neither of them means "nothing
 * changed" — both return `signature: null` with a machine-readable `reason`:
 *
 *   - `no_source_root`: not one supported root could be read, so there is
 *     nothing to observe. A scan whose source cannot be watched must never be
 *     reused, because we could not tell when it stopped being true. (This is
 *     also why a test double whose `detect()` names a path that does not exist
 *     keeps getting a fresh scan per request without asking for one.)
 *   - `corpus_too_large`: see `SCAN_SIGNATURE_MAX_FILES`.
 *
 * The detection SHAPE is hashed too — every collector's id, status and declared
 * paths — so installing or removing a CLI invalidates even when no file under
 * an already-known root moved.
 *
 * @param {object} detected the result of `registry.detectAll()`
 * @returns {Promise<{signature: string|null, reason: string|null, files: number,
 *   roots: string[], ms: number}>}
 */
export async function scanSourceSignature(detected, options = {}) {
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : SCAN_SIGNATURE_MAX_FILES;
  const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0 ? options.concurrency : SIGNATURE_STAT_CONCURRENCY;
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;

  const shape = [];
  const roots = [];
  for (const [status, list] of [
    ["supported", detected?.supported],
    ["detection-only", detected?.detectionOnly],
    ["absent", detected?.absent],
  ]) {
    for (const entry of Array.isArray(list) ? list : []) {
      const paths = (Array.isArray(entry?.paths) ? entry.paths : []).map((value) => String(value)).sort();
      shape.push([status, String(entry?.id ?? ""), paths]);
      // Only a SUPPORTED root holds sessions that a scan reads. A detected CLI
      // with nothing readable contributes its status and no file walk.
      if (status === "supported") roots.push(...paths);
    }
  }
  shape.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(shape));

  let files = 0;
  let observedRoots = 0;
  for (const root of [...new Set(roots)].sort()) {
    let stat;
    try {
      stat = await fs.stat(root);
    } catch {
      hash.update(JSON.stringify([root, "absent"]));
      continue;
    }
    observedRoots += 1;
    if (!stat.isDirectory()) {
      files += 1;
      hash.update(JSON.stringify([root, stat.mtimeMs, stat.size]));
      continue;
    }
    let dirents;
    try {
      dirents = await fs.readdir(root, { recursive: true, withFileTypes: true });
    } catch {
      // A root we cannot enumerate is a root we cannot watch.
      return { signature: null, reason: "root_unreadable", files, roots, ms: elapsed() };
    }
    const paths = [];
    for (const dirent of dirents) {
      if (!dirent.isFile()) continue;
      paths.push(path.join(dirent.parentPath ?? dirent.path ?? root, dirent.name));
    }
    files += paths.length;
    if (files > maxFiles) {
      return { signature: null, reason: "corpus_too_large", files, roots, ms: elapsed() };
    }
    paths.sort();
    const stamps = await statMany(paths, concurrency);
    hash.update(JSON.stringify([root, paths, stamps]));
  }

  if (observedRoots === 0) {
    return { signature: null, reason: "no_source_root", files, roots, ms: elapsed() };
  }
  return { signature: hash.digest("hex"), reason: null, files, roots, ms: elapsed() };
}

/**
 * Freeze a whole object graph, in place.
 *
 * The cache never hands out the object it holds — every caller gets a copy —
 * so nothing downstream ever meets a frozen corpus. This is the backstop that
 * turns a mistake in THIS file into a loud `TypeError` at the moment of the
 * write, instead of a page-3 response quietly disagreeing with page 2.
 */
function deepFreeze(node, seen) {
  if (node === null || typeof node !== "object" || seen.has(node)) return node;
  seen.add(node);
  Object.freeze(node);
  for (const value of Array.isArray(node) ? node : Object.values(node)) deepFreeze(value, seen);
  return node;
}

/** The cache key: everything that changes WHAT a scan reads, and nothing else. */
export function scanCacheKey({ since, limit }) {
  const at = since instanceof Date ? since.toISOString() : since === undefined || since === null ? "" : String(since);
  // `limit` is the RESOLVED per-collector bound, never the requested one: it is
  // what `corpusComplete` — and therefore `subagent-concurrency` — is derived
  // from, so a scan taken under one limit may never be served to another.
  return JSON.stringify([at, limit ?? null]);
}

/**
 * A bounded, in-process, ephemeral cache of collected corpora.
 *
 * WHY: `/api/sessions` pages twenty rows at a time, and every page used to
 * re-read the whole corpus — measured at 5,397ms / 5,538ms / 5,448ms for
 * offsets 0 / 20 / 40 of the same unchanged 1,236-session corpus. The scan is
 * the cost; the paging is free. So the scan happens once.
 *
 * WHAT IT IS NOT: a second source of truth. Nothing is written to disk, there
 * is no state directory entry, and a restart starts cold — which is correct.
 * The files on disk remain the only record; this only avoids reading them again
 * while they demonstrably have not changed.
 *
 * THE HAZARD IT IS BUILT AROUND: `annotateSuggestions` mutates its input in
 * place, and it is not alone in being allowed to — every consumer of a collect
 * has until now been handed a private object that no one else would ever see
 * again. Sharing one changes that contract silently, and the damage would not
 * look like a cache bug: it would look like page 3 having wrong data. So the
 * cache NEVER hands out the object it holds. Every caller, on a hit and on a
 * miss alike, gets a `structuredClone`, and the stored master is deep-frozen so
 * that a write to it would throw here rather than surface as wrong data there.
 */
function createScanCache({ maxEntries = SCAN_CACHE_MAX_ENTRIES, enabled = true, signature = scanSourceSignature } = {}) {
  const bound = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : SCAN_CACHE_MAX_ENTRIES;
  /** key -> Promise<{master, copy}>. Insertion order is LRU order. */
  const entries = new Map();
  /** The signature every stored entry was taken under. */
  let taken = null;
  /** An in-flight walk, shared by whoever arrives during it. */
  let walking = null;
  /** Turned off for good the first time a corpus refuses to be copied. */
  let copyable = true;
  const stats = { hits: 0, misses: 0, invalidations: 0, evictions: 0, bypasses: 0, reason: null, signatureMs: null, files: null };

  /**
   * The current signature, computed at most once concurrently.
   *
   * Sharing a walk that is in flight RIGHT NOW adds no staleness that the walk
   * did not already have: it is not atomic, and its answer already describes
   * some moment inside its own duration. What it does avoid is two requests
   * arriving together and paying for the same 280ms walk twice.
   */
  function fingerprint(detect) {
    walking ??= Promise.resolve()
      .then(() => detect())
      .then((detected) => signature(detected))
      .catch((error) => ({
        signature: null,
        reason: `signature_failed: ${error instanceof Error ? error.message : String(error)}`,
        files: 0,
        roots: [],
        ms: 0,
      }))
      .finally(() => { walking = null; });
    return walking;
  }

  function evict() {
    while (entries.size > bound) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
      stats.evictions += 1;
    }
  }

  return {
    /** Read-only counters, for tests and for anyone asking what it did. */
    stats: () => ({ ...stats, entries: entries.size, enabled: enabled && copyable, bound }),
    clear() {
      entries.clear();
      taken = null;
    },
    /**
     * @param {string} key from `scanCacheKey`
     * @param {() => Promise<object>} detect `registry.detectAll`, for the signature
     * @param {() => Promise<object>} produce the expensive scan
     */
    async read(key, detect, produce) {
      if (!enabled || !copyable) {
        stats.bypasses += 1;
        return produce();
      }

      const current = await fingerprint(detect);
      stats.signatureMs = current?.ms ?? null;
      stats.files = current?.files ?? null;
      if (!current?.signature) {
        // Unwatchable source: serve a fresh scan and hold nothing.
        stats.bypasses += 1;
        stats.reason = current?.reason ?? "no_signature";
        entries.clear();
        taken = null;
        return produce();
      }
      stats.reason = null;
      if (taken !== current.signature) {
        if (taken !== null && entries.size > 0) stats.invalidations += 1;
        entries.clear();
        taken = current.signature;
      }

      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        stats.hits += 1;
        const settled = await hit;
        if (settled.copy === null) return settled.master;
        return structuredClone(settled.master);
      }

      stats.misses += 1;
      const pending = (async () => {
        const master = await produce();
        let copy = null;
        try {
          // Prove the corpus copies BEFORE anything is shared. A corpus that
          // cannot be copied cannot be reused: handing the same object to a
          // second request is exactly the corruption this cache exists to
          // avoid, so the cache turns itself off and says why.
          copy = structuredClone(master);
        } catch (error) {
          copyable = false;
          stats.reason = `uncopyable: ${error instanceof Error ? error.message : String(error)}`;
          return { master, copy: null };
        }
        deepFreeze(master, new WeakSet());
        return { master, copy };
      })();
      entries.set(key, pending);
      // A failed scan is never cached: the next request retries it, the same
      // way `createLoader` refuses to cache a failed import.
      pending.catch(() => { if (entries.get(key) === pending) entries.delete(key); });
      evict();

      const settled = await pending;
      if (settled.copy === null) {
        entries.delete(key);
        return settled.master;
      }
      return settled.copy;
    },
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {string} [options.publicDir] static root; nothing outside it is served
 * @param {string} [options.home] home used to resolve suggestion targets, read-only
 * @param {object} [options.modules] specifier or module-object overrides
 * @param {() => Date} [options.now]
 * @param {false|object} [options.scanCache] `false` turns the scan cache off
 *   entirely, so every request re-reads the corpus; an object overrides
 *   `maxEntries` / `signature`. On by default. A caller that needs a
 *   guaranteed-fresh scan per request asks for it here rather than relying on
 *   the cache happening not to fire.
 * @returns {{app: import('express').Express, state: object}}
 */
export function createApp(options = {}) {
  const state = {
    publicDir: path.resolve(options.publicDir ?? DEFAULT_PUBLIC_DIR),
    home: path.resolve(options.home ?? process.env.SESSION_RX_HOME ?? os.homedir()),
    host: LOOPBACK_HOST,
    port: null,
    hostAllowlist: new Set(),
    scanLimit: Number.isInteger(options.scanLimit) && options.scanLimit > 0 ? options.scanLimit : DEFAULT_SCAN_LIMIT,
    scanCache: createScanCache(
      options.scanCache === false
        ? { enabled: false }
        : options.scanCache && typeof options.scanCache === "object"
          ? options.scanCache
          : {},
    ),
    now: typeof options.now === "function" ? options.now : () => new Date(),
    load: null,
    setAddress(port, host = LOOPBACK_HOST) {
      state.port = port;
      state.host = host;
      // All three loopback aliases, always — never only the literal address
      // this process happened to bind. `isLoopbackPeer` already tolerates a
      // peer address reported as `::1`, so the Host allowlist must tolerate
      // a browser writing the Host header the same way.
      const names = [LOOPBACK_HOST, "localhost", "[::1]"];
      state.hostAllowlist = new Set(names.map((name) => `${name}:${port}`.toLowerCase()));
    },
  };

  const specifiers = { ...DEFAULT_MODULES, ...(options.modules ?? {}) };
  const load = createLoader(specifiers);
  state.load = load;

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  // ---- 1. socket must be loopback (BP-005.12) -----------------------------
  app.use((req, res, next) => {
    if (!isLoopbackPeer(req.socket?.remoteAddress)) {
      res.status(403).type("application/json").send(JSON.stringify({
        error: "SessionRx serves the loopback interface only",
        reason: "peer_not_loopback",
      }));
      return;
    }
    next();
  });

  // ---- 2. headers: no CORS, nothing sniffable, no referrer leak -----------
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    next();
  });

  // ---- 3. Host allowlist, on EVERY method (defeats DNS rebinding) --------
  //
  // Every route here is a GET, so this is the whole defense: a bare GET —
  // including one served after DNS rebinding pointed the victim's browser at
  // this loopback port under an attacker-controlled hostname — is refused
  // unless the Host header names the loopback address this server actually
  // bound.
  app.use((req, res, next) => {
    if (!isAllowedHost(state, req)) {
      res.status(403).type("application/json").send(JSON.stringify({
        error: "Host header is not the loopback address this server is bound to",
        reason: "host_not_allowed",
      }));
      return;
    }
    next();
  });

  // ---- 4. path traversal, before anything touches the filesystem ----------
  app.use((req, res, next) => {
    let decoded;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      next(new HttpError(400, "request path is not valid percent-encoding"));
      return;
    }
    if (decoded.includes("\0")) {
      next(new HttpError(400, "request path may not contain a NUL byte"));
      return;
    }
    if (decoded.split(/[\\/]/).includes("..")) {
      next(new HttpError(403, "request path may not traverse outside the served directory"));
      return;
    }
    next();
  });

  // Every route below is GET: SessionRx never writes a user's files (THE
  // SUGGESTION CONTRACT), so there is no mutating route left to defend and no
  // request body to parse.

  // ---- helpers bound to this app ------------------------------------------

  /** Serialize, redact with the generator's redactor, send. */
  async function sendJson(res, status, payload) {
    const loaded = await load("report");
    if (!loaded.ok) {
      // Without the redactor we cannot prove the body is credential-free, so
      // we send a FIXED message rather than unredacted data (FVA-004).
      res.status(503).type("application/json").send(JSON.stringify({
        error: "secret redaction is unavailable, so no session data can be served",
        reason: "redactor_unavailable",
        missing: "src/report/generator.js",
      }));
      return;
    }
    const { value } = redactJson(payload, loaded.module.redactSecrets);
    res.status(status).type("application/json").send(JSON.stringify(value));
  }

  async function sendError(res, status, error, extra = {}) {
    await sendJson(res, status, { error, ...extra });
  }

  /** Require a lazily imported module, or answer 503 honestly. */
  async function require$(res, name, humanName) {
    const loaded = await load(name);
    if (loaded.ok) return loaded.module;
    await sendError(res, 503, `${humanName} is unavailable in this build, so this route has no data to report`, {
      reason: "dependency_unavailable",
      dependency: name,
      missing: loaded.specifier,
      detail: loaded.error instanceof Error ? loaded.error.message : String(loaded.error),
    });
    return null;
  }

  const route = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };

  /**
   * Collect once for a request, surfacing per-collector diagnostics and the
   * scan bound that produced the numbers.
   *
   * "Once" now means once per CORPUS, not once per request: the scan behind it
   * goes through `state.scanCache`, which re-reads the files only when the
   * files themselves have changed. What comes back is always this request's own
   * copy — the cache never hands out the object it holds — so `analyzeAll`,
   * `annotateSuggestions` and everything downstream keep the private object they
   * have always had. Nothing else in this function changed: the scan bound, the
   * `atLimit` derivation and the note are computed from the returned corpus
   * exactly as before, so `corpusComplete` and every verdict that depends on it
   * are untouched by whether this request read the disk or not.
   */
  async function collectFor(res, query) {
    const loadedRegistry = await load("registry");
    const registry = loadedRegistry.ok ? loadedRegistry.module : null;
    if (!registry) return null;
    const requested = query.limit ?? null;
    const limit = requested ?? state.scanLimit;
    const since = query.since ?? null;
    const collected = await state.scanCache.read(
      scanCacheKey({ since, limit }),
      () => (typeof registry.detectAll === "function" ? registry.detectAll() : null),
      () => registry.collectAll({ since, limit }),
    );
    const supported = Array.isArray(collected?.supported) ? collected.supported : [];
    const atLimit = supported.some((entry) => (entry?.sessions?.length ?? 0) >= limit);
    return {
      collected,
      limit,
      scan: {
        limitPerCollector: limit,
        defaulted: requested === null,
        atLimit,
        note: atLimit
          ? `at least one CLI returned the full ${limit} newest sessions, so older sessions exist that were not read; pass a larger limit to widen the scan`
          : `every CLI returned fewer than ${limit} sessions, so this scan reached the end of each corpus`,
      },
    };
  }

  /**
   * The ANALYSIS is deliberately not cached, and this is the note saying why so
   * that it is a decision rather than an oversight.
   *
   * Measured on a heavy real corpus (2026-09-21, this machine): the collect it
   * sits on top of is 4,701ms, `analyzeAll` over its output is 599ms. Caching
   * the collect removes the 4,701ms. Caching the analysis as well would remove
   * most of the 599ms and buy two hazards for it: `analyzeAll` publishes the
   * `generatedAt` it is handed (`src/analyzer/health.js`), which is THIS
   * request's clock and would be served stale to the next one; and
   * `annotateSuggestions` below mutates the analysis in place, so a shared
   * analysis would need its own defensive copy — the cost the caching was
   * meant to avoid, on the tree where a wrong verdict would actually show.
   * Not worth it for 12% of a request that is already fixed.
   */
  async function analyzeFor(res, query) {
    const collectedFor = await collectFor(res, query);
    if (!collectedFor) return null;
    const health = await require$(res, "health", "the session health analyzer");
    if (!health) return null;
    const analysis = health.analyzeAll(collectedFor.collected, {
      generatedAt: state.now().toISOString(),
      limit: collectedFor.limit,
    });
    const registry = await require$(res, "registry", "the collector registry");
    if (!registry) return null;
    const displayNames = new Map(
      (Array.isArray(registry?.COLLECTOR_SPECS) ? registry.COLLECTOR_SPECS : [])
        .filter((spec) => Array.isArray(spec) && typeof spec[0] === "string" && typeof spec[1] === "string")
        .map(([id, displayName]) => [id, displayName]),
    );
    annotateSuggestions(analysis.sessions, displayNames);
    annotateSuggestions(analysis.subagentSessions, displayNames);
    return { ...collectedFor, analysis };
  }

  // ---- 6. `/` and `/index.html` ------------------------------------------

  const serveIndex = route(async (req, res) => {
    const indexPath = path.join(state.publicDir, "index.html");
    let html;
    try {
      html = await fs.readFile(indexPath, "utf8");
    } catch (error) {
      throw new HttpError(500, `the SessionRx frontend could not be read from ${indexPath}`, {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Security-Policy", CSP);
    res.send(html);
  });

  app.get("/", serveIndex);
  app.get("/index.html", serveIndex);

  // ---- 7. API ------------------------------------------------------------

  // BP-005.10
  app.get("/api/collectors", route(async (req, res) => {
    const registry = await require$(res, "registry", "the collector registry");
    if (!registry) return;
    const detected = await registry.detectAll();
    const collectors = [...detected.supported, ...detected.detectionOnly, ...detected.absent]
      .map((entry) => ({
        id: entry.id,
        displayName: entry.displayName ?? entry.id,
        installed: entry.installed === true,
        status: entry.status ?? "absent",
        paths: Array.isArray(entry.paths) ? entry.paths : [],
        diagnostic: entry.diagnostic ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    await sendJson(res, 200, { collectors, diagnostics: detected.diagnostics ?? [] });
  }));

  // BP-005.01
  app.get("/api/health", route(async (req, res) => {
    const query = {
      since: parseIsoDate(singleValue(req.query.since, "since"), "since"),
      limit: parseLimit(singleValue(req.query.limit, "limit")),
      from: parseIsoDate(singleValue(req.query.from, "from"), "from"),
      to: parseIsoDate(singleValue(req.query.to, "to"), "to"),
    };
    const result = await analyzeFor(res, query);
    if (!result) return;
    // The scan and analysis above are untouched by what follows — every
    // verdict, `corpusComplete` included, is computed over the FULL analyzed
    // corpus. Only the SERIALIZED `sessions` array is narrowed, to the same
    // newest-first slice the health page renders (`HEALTH_CARD_LIMIT`, which
    // mirrors the page's own `SESSION_LIMIT`) — so the payload shrinks
    // without the scan shrinking with it.
    const allSessions = Array.isArray(result.analysis.sessions) ? result.analysis.sessions : [];
    const sessionWindowValue = sessionWindow(allSessions, query);
    const windowedSessions = filterSessions(allSessions, { from: query.from, to: query.to });
    const cardSessions = sortSessions(windowedSessions, "startedAt", "desc").slice(0, HEALTH_CARD_LIMIT);
    const windowTotals = calculateWindowTotals(windowedSessions);
    const windowSeries = calculateWindowSeries(windowedSessions, query);
    const coverage = calculateCoverage(result);
    const comparison = calculateComparison(query, coverage, result.scan, allSessions, windowTotals);
    const ruleTotalsById = new Map();
    for (const session of windowedSessions) {
      const rules = Array.isArray(session?.rules) ? session.rules : [];
      const rulesById = new Map(rules.filter((rule) => typeof rule?.id === "string").map((rule) => [rule.id, rule]));
      for (const rule of rules) {
        if (!rule || typeof rule.id !== "string") continue;
        if (!ruleTotalsById.has(rule.id)) {
          ruleTotalsById.set(rule.id, { id: rule.id, name: rule.name ?? null, observed: 0, notObserved: 0, unknown: 0 });
        }
      }
      for (const [id, total] of ruleTotalsById) {
        const status = rulesById.get(id)?.evidence?.status;
        if (status === "observed") total.observed += 1;
        else if (status === "not-observed") total.notObserved += 1;
        else total.unknown += 1;
      }
    }
    const ruleTotals = [...ruleTotalsById.values()];
    await sendJson(res, 200, {
      sessions: cardSessions,
      // The true count over the FULL analysis, so the health page's "N of
      // TOTAL sessions" sentence never misreports a narrowed response as the
      // whole corpus. `null`, not 0, when the analyzer published no sessions
      // array — an absent count is not a measured zero.
      sessionsTotal: Array.isArray(result.analysis.sessions) ? result.analysis.sessions.length : null,
      ruleTotals,
      ruleTotalsSessions: Array.isArray(result.analysis.sessions) ? windowedSessions.length : null,
      windowTotals,
      windowSeries,
      topFixes: calculateTopFixes(windowedSessions),
      distinctFixes: calculateDistinctFixes(windowedSessions),
      coverage,
      comparison,
      collectors: result.analysis.collectors,
      // F-023/F-025: how many sessions were set aside as sub-agents of another
      // session. `sessions` above is the user's OWN sessions only, so without
      // this the difference between what was read and what is listed is
      // unexplained. `null` when the analyzer published no count — an absent
      // count is not a measured zero.
      subagentSessionsSetAside: result.analysis.subagentSessionsSetAside ?? null,
      promotions: result.analysis.promotions ?? [],
      diagnostics: result.analysis.diagnostics ?? [],
      scan: result.scan,
      sessionWindow: sessionWindowValue,
      generatedAt: state.now().toISOString(),
    });
  }));

  // BP-005.02
  app.get("/api/sessions", route(async (req, res) => {
    const from = parseIsoDate(singleValue(req.query.from, "from"), "from");
    const to = parseIsoDate(singleValue(req.query.to, "to"), "to");
    // `limit` now bounds ONE PAGE and defaults to `SESSIONS_PAGE_LIMIT` rather
    // than to "everything matched". `parseLimit` keeps its own split: a
    // malformed limit is a 400, an oversized one is clamped to `MAX_LIMIT`.
    const limit = parseLimit(singleValue(req.query.limit, "limit")) ?? SESSIONS_PAGE_LIMIT;
    const offset = parseOffset(singleValue(req.query.offset, "offset"));
    // Documented addition: BP-005.02 is silent on how much of the corpus is read.
    const scan = parseLimit(singleValue(req.query.scan, "scan"));
    const sortRaw = singleValue(req.query.sort, "sort");
    const orderRaw = singleValue(req.query.order, "order");
    if (sortRaw && !SORT_FIELDS.has(sortRaw)) {
      throw new HttpError(400, `sort must be one of: ${[...SORT_FIELDS].join(", ")}`);
    }
    if (orderRaw && orderRaw !== "asc" && orderRaw !== "desc") {
      throw new HttpError(400, "order must be asc or desc");
    }

    // Three separate bounds, because conflating them is how a UI ends up
    // paginating against a lie: `limit`/`offset` bound ONE PAGE of response
    // rows, `scan` bounds how much of each corpus was read. `total` is the
    // number of sessions matching the filter WITHIN THE SCAN, and
    // `scan.atLimit` says whether older unread sessions exist. A page is a
    // window onto `total`; `total` is a window onto the scan; neither is ever
    // published as the size of the corpus.
    const result = await analyzeFor(res, { since: null, limit: scan });
    if (!result) return;

    const matched = filterSessions(result.analysis.sessions, {
      cli: parseCsvList(singleValue(req.query.cli, "cli")),
      project: singleValue(req.query.project, "project"),
      from,
      to,
    });
    const cliCounts = [...matched.reduce((counts, session) => {
      const cli = typeof session?.cli === "string" && session.cli ? session.cli : "unknown";
      counts.set(cli, (counts.get(cli) ?? 0) + 1);
      return counts;
    }, new Map())]
      .map(([cli, count]) => ({ cli, count }))
      .sort((left, right) => left.cli.localeCompare(right.cli));
    const sessionWindowValue = sessionWindow(result.analysis.sessions, {
      cli: parseCsvList(singleValue(req.query.cli, "cli")),
      project: singleValue(req.query.project, "project"),
      from,
      to,
    });
    const sorted = sortSessions(matched, sortRaw ?? "startedAt", orderRaw ?? "desc");
    // PAGINATION IS THE LAST STEP. Filter, then sort, THEN cut the page: the
    // second page of a `cli=claude`, `sort=score` list has to be the second
    // twenty of THAT list. Slicing before either would make page 2 the second
    // twenty of the raw corpus, filtered afterwards into a page that is short,
    // out of order, and overlaps page 1.
    const page = sorted.slice(offset, offset + limit);
    const consumed = offset + page.length;
    const hasMore = consumed < matched.length;

    // THE TREND COLUMN'S DATA, JOINED BACK ON.
    //
    // `analyzeSession` counts the turns it was given and then drops the array
    // (`turnCount: turns.length`, src/analyzer/health.js), so an analyzed
    // session carries no per-turn context reading at all. The Sessions table
    // draws one — and, reading a field that was never sent, printed "not
    // measured" on every row of every page since the column shipped. The
    // readings exist: the collectors record `turn.context.inputTokens`, and
    // `/api/report` below already joins them back the same way.
    //
    // Two properties this must keep:
    //   1. NUMBERS ONLY. A turn object carries tool calls and their inputs —
    //      that is how this endpoint measured 43.8MB before it was paginated.
    //      A flat list of readings is a few dozen bytes a row.
    //   2. COST IS THE PAGE. The join runs over `page`, never over `matched`
    //      or the scan, so widening `?scan=` cannot widen this body.
    const rawById = new Map();
    for (const entry of Array.isArray(result.collected?.supported) ? result.collected.supported : []) {
      for (const raw of Array.isArray(entry?.sessions) ? entry.sessions : []) {
        if (raw?.sessionId !== null && raw?.sessionId !== undefined) rawById.set(String(raw.sessionId), raw);
      }
    }
    const pageWithSeries = page.map((session) => {
      const raw = rawById.get(String(session?.sessionId ?? ""));
      // `null` and `[]` are DIFFERENT STATEMENTS and the page renders them
      // differently. `[]` says the turns were read and none recorded a context
      // size; `null` says this row's turns never reached this endpoint, so
      // nothing is known either way. Sending `[]` for a join miss would be the
      // same class of lie this whole change exists to remove.
      const contextSeries = raw
        ? (Array.isArray(raw.turns) ? raw.turns : [])
          .map((turn) => turn?.context?.inputTokens)
          // A null reading is ABSENT, not zero. It is dropped from the series;
          // it is never coerced, and the series is never padded to turn count.
          .filter((value) => typeof value === "number" && Number.isFinite(value))
        : null;
      return { ...session, contextSeries };
    });

    await sendJson(res, 200, {
      sessions: pageWithSeries,
      // `total` is the whole filtered match, not the page — it is what the UI
      // says it is not showing, so it may never shrink to the page size.
      total: matched.length,
      cliCounts,
      returned: page.length,
      // Echoed so a client can tell a short page (end of list) from a page it
      // asked to be short, without re-deriving either from its own request.
      offset,
      limit,
      hasMore,
      // `null`, not `total`, at the end of the list: an absent next page is not
      // a next page that happens to be empty, and a client that loops on
      // `nextOffset` must be able to stop on falsiness alone.
      nextOffset: hasMore ? consumed : null,
      scan: result.scan,
      sessionWindow: sessionWindowValue,
      diagnostics: result.analysis.diagnostics ?? [],
    });
  }));

  // BP-005.03
  app.get("/api/sessions/:sessionId", route(async (req, res) => {
    const wanted = String(req.params.sessionId ?? "");
    const scan = parseLimit(singleValue(req.query.scan, "scan"));
    const result = await analyzeFor(res, { since: null, limit: scan });
    if (!result) return;
    const session = result.analysis.sessions.find((candidate) => String(candidate?.sessionId ?? "") === wanted);
    if (!session) {
      // 404 says "not in the scanned window", not "does not exist" — `scan`
      // carries the difference so the caller can widen and retry.
      await sendError(res, 404, `no session with id ${wanted} was found in the scanned window`, {
        reason: "session_not_found",
        scanned: result.analysis.sessions.length,
        scan: result.scan,
      });
      return;
    }
    await sendJson(res, 200, { session, scan: result.scan, diagnostics: result.analysis.diagnostics ?? [] });
  }));

  // BP-005.04
  app.get("/api/trends", route(async (req, res) => {
    const from = parseIsoDate(singleValue(req.query.from, "from"), "from");
    const to = parseIsoDate(singleValue(req.query.to, "to"), "to");
    const cli = parseCsvList(singleValue(req.query.cli, "cli"));
    const scan = parseLimit(singleValue(req.query.scan, "scan"));
    const collectedFor = await collectFor(res, { since: null, limit: scan });
    if (!collectedFor) return;
    const trends = await require$(res, "trends", "the trend builder");
    if (!trends) return;
    const built = trends.buildTrends(collectedFor.collected, {
      from: from ?? undefined,
      to: to ?? undefined,
      cli: cli ?? undefined,
      now: state.now(),
    });
    // `charts` is passed through exactly as wave 3B builds it:
    // `{context, spend, cache}`. BP-005.04 named the third series `tools`; the
    // trend builder measures cache spend instead, and emitting an empty
    // `tools: []` to satisfy the table would be a fabricated series.
    await sendJson(res, 200, {
      ...built,
      trendDeltas: calculateTrendDeltas(built.charts ?? {}),
      scan: collectedFor.scan,
      sessionWindow: sessionWindow(collectedSessions(collectedFor.collected), { cli, from, to }),
      diagnostics: collectedFor.collected.diagnostics ?? [],
    });
  }));

  /**
   * Section 6's direction, computed by the SAME builder `/api/trends` uses, on
   * the same collected corpus with the same window options — one trend
   * implementation, not a second copy of it (F-021).  A builder that is absent
   * or that throws yields `unknown` WITH the reason; it never manufactures a
   * direction, and it never fails the whole report.
   */
  async function reportTrend(collected, { from, to, cli }) {
    const loaded = await load("trends");
    if (!loaded.ok) {
      return {
        direction: "unknown",
        reason: `the trend builder is unavailable in this build (${loaded.specifier ?? "no module registered"}), so no direction over time was computed; "stable" would be a claim about history nothing here looked at`,
      };
    }
    try {
      const built = loaded.module.buildTrends(collected, {
        from: from ?? undefined,
        to: to ?? undefined,
        cli: cli ?? undefined,
        now: state.now(),
      });
      const trend = built?.trend;
      if (!trend || typeof trend.direction !== "string") {
        return { direction: "unknown", reason: "the trend builder returned no direction for this window, so none is reported" };
      }
      return trend;
    } catch (error) {
      return {
        direction: "unknown",
        reason: `the trend for this window could not be computed (${error instanceof Error ? error.message : String(error)}), so no direction is reported`,
      };
    }
  }

  // BP-005.05
  app.get("/api/report", route(async (req, res) => {
    const from = parseIsoDate(singleValue(req.query.from, "from"), "from");
    const to = parseIsoDate(singleValue(req.query.to, "to"), "to");
    const cli = parseCsvList(singleValue(req.query.cli, "cli"));
    const scan = parseLimit(singleValue(req.query.scan, "scan"));
    const result = await analyzeFor(res, { since: null, limit: scan });
    if (!result) return;
    const reportModule = await require$(res, "report", "the report generator");
    if (!reportModule) return;

    const sessions = filterSessions(result.analysis.sessions, { cli, from, to });
    const health = await require$(res, "health", "the session health analyzer");
    if (!health) return;
    const rawById = new Map();
    for (const entry of Array.isArray(result.collected?.supported) ? result.collected.supported : []) {
      for (const raw of Array.isArray(entry?.sessions) ? entry.sessions : []) {
        if (raw?.sessionId !== null && raw?.sessionId !== undefined) rawById.set(String(raw.sessionId), raw);
      }
    }
    let totalContextReadTokens = 0;
    let contextSessionsMeasured = 0;
    let contextSessionsExcluded = 0;
    for (const session of sessions) {
      const raw = rawById.get(String(session?.sessionId)) ?? null;
      const readings = (Array.isArray(raw?.turns) ? raw.turns : [])
        .map((turn) => turn?.context?.inputTokens)
        .filter((value) => typeof value === "number" && Number.isFinite(value));
      if (readings.length === 0) {
        contextSessionsExcluded += 1;
        continue;
      }
      contextSessionsMeasured += 1;
      totalContextReadTokens += readings.reduce((sum, value) => sum + value, 0);
    }
    const reportInput = health.buildReportInput({
      sessions,
      clis: result.analysis.collectors,
      generatedAt: state.now().toISOString(),
      contextMeasurement: { totalContextReadTokens, contextSessionsMeasured, contextSessionsExcluded },
      trend: await reportTrend(result.collected, { from, to, cli }),
    });
    // SessionRx never applies a fix itself any more (THE SUGGESTION CONTRACT),
    // so there is no applied-fix journal to read. `[]` is what the generator
    // renders as "No fix was applied in this period" — which is now simply
    // true, always, rather than a claim this route has to go verify.
    reportInput.fixes = [];
    const document = reportModule.generateReportDocument(reportInput);
    await sendJson(res, 200, {
      markdown: document.markdown,
      generatedAt: document.generatedAt,
      redactions: document.redactions,
      scan: result.scan,
      sessionWindow: sessionWindow(result.analysis.sessions, { cli, from, to }),
      // Not in BP-005.05, and required anyway: a report assembled from a corpus
      // where a collector failed must say so, or it reads as a complete picture.
      diagnostics: result.analysis.diagnostics ?? [],
      // A plain-language rollup of the SAME verdicts the markdown above was
      // built from (reportInput.summary, health.buildManagerSummary) — never
      // parsed back out of the assembled Markdown text, which is free to
      // change under it. public/js/pages/report.js renders this as cards.
      summary: reportInput.summary ?? null,
    });
  }));

  // Suggestions --------------------------------------------------------------
  //
  // Read-only. `id` narrows to one `rule.fix`/suggestion id, `tool` to one of
  // `TOOL_IDS`, `scope` to "global" or "project"; any of the three may be
  // omitted, in which case every matching combination is returned. A marker
  // (or, for the settings suggestion, a key) already present in a resolvable
  // GLOBAL target is reported as `status: "already-added"`; a project target
  // is never resolvable from this process, so it is always `"unknown"`
  // (never claimed either way) — see `src/suggestions/targets.js`.

  function parseScope(raw) {
    if (raw === undefined || raw === null || raw === "") return null;
    if (raw !== "global" && raw !== "project") {
      throw new HttpError(400, `scope must be "global" or "project": ${raw}`);
    }
    return raw;
  }

  function parseTool(raw) {
    if (raw === undefined || raw === null || raw === "") return null;
    if (!TOOL_IDS.includes(raw)) {
      throw new HttpError(400, `tool must be one of: ${TOOL_IDS.join(", ")}`);
    }
    return raw;
  }

  app.get("/api/suggestions", route(async (req, res) => {
    const id = singleValue(req.query.id, "id");
    const tool = parseTool(singleValue(req.query.tool, "tool"));
    const scope = parseScope(singleValue(req.query.scope, "scope"));
    if (id && !Object.hasOwn(SUGGESTION_DEFS, id)) {
      await sendError(res, 404, `no suggestion with id ${id} exists`, { reason: "suggestion_not_found" });
      return;
    }
    const suggestions = await buildSuggestions({ id: id || null, toolId: tool, scope, home: state.home });
    await sendJson(res, 200, { suggestions, tools: TOOL_IDS.map((t) => ({ id: t, label: toolLabel(t) })) });
  }));

  // ---- 8. static assets, then honest 404s --------------------------------

  app.use(express.static(state.publicDir, {
    index: false,
    dotfiles: "deny",
    redirect: false,
    fallthrough: true,
    etag: false,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache");
    },
  }));

  app.use(route(async (req, res) => {
    await sendError(res, 404, `no SessionRx route or asset matches ${req.method} ${req.path}`, {
      reason: "not_found",
    });
  }));

  // ---- 9. error handler --------------------------------------------------

  app.use(async (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof HttpError) {
      await sendError(res, error.status, error.message, { reason: "bad_request", ...error.details });
      return;
    }
    if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
      await sendError(res, 400, "request body is not valid JSON", { reason: "body_parse_failed" });
      return;
    }
    if (error?.type === "entity.too.large") {
      await sendError(res, 413, `request body exceeds the ${BODY_LIMIT} limit`, { reason: "body_too_large" });
      return;
    }
    // Never an empty 200: an internal failure says so, with its message.
    await sendError(res, 500, error instanceof Error ? error.message : String(error), {
      reason: "internal_error",
    });
  });

  return { app, state };
}

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------

/**
 * Bind the app to loopback.
 *
 * @param {object} [options] everything `createApp` takes, plus:
 * @param {number} [options.port] `0` (the default) asks the OS for a free port
 * @returns {Promise<{server: import('node:http').Server, app: object, state: object,
 *   url: string, host: string, port: number, close: () => Promise<void>}>}
 */
export async function startServer(options = {}) {
  const { app, state } = options.app && options.state ? options : createApp(options);
  const port = Number.isInteger(options.port) ? options.port : 0;

  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(port, LOOPBACK_HOST);
    candidate.once("listening", () => resolve(candidate));
    candidate.once("error", reject);
  });

  const address = server.address();
  state.setAddress(address.port, LOOPBACK_HOST);

  return {
    server,
    app,
    state,
    host: LOOPBACK_HOST,
    port: address.port,
    url: `http://${LOOPBACK_HOST}:${address.port}/`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

export default createApp;
