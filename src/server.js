/**
 * SessionRx local HTTP surface — BP-005.
 *
 * This process can rewrite a developer's `~/.claude/CLAUDE.md` and
 * `~/.claude/settings.json`. Loopback is NOT a security boundary: any page the
 * developer has open in any tab can `fetch('http://127.0.0.1:<port>/…')`. So
 * every mutating route is defended by three independent checks (BP-005.12..14,
 * DIS-002) and the socket itself is checked for loopback origin:
 *
 *   1. `X-CSRF-Token` equal to a per-process nonce that only the HTML this
 *      server served can know (compared in constant time),
 *   2. a `Host` header inside an exact loopback host:port allowlist built from
 *      the address we actually bound to,
 *   3. an `Origin` header exactly equal to `http://<that Host>` — so `null`,
 *      absent, and any foreign origin are all refused.
 *
 * There are deliberately NO CORS headers. A cross-origin caller is refused, not
 * negotiated with. Cookies are never read or set; there is no ambient
 * credential for an attacker to ride.
 *
 * ── DNS rebinding (the Host check is NOT only a CSRF check) ─────────────────
 * The three-part check above only runs on mutating methods — GET/HEAD/OPTIONS
 * carry no CSRF requirement, because they cannot change state through a
 * cross-site *form* or *fetch*. But DNS rebinding lets an attacker's page,
 * after first resolving its own hostname to this loopback port, read a GET
 * response too: `isLoopbackPeer` still passes (the browser really is talking
 * to 127.0.0.1 at the socket layer), and with no CORS headers set the browser
 * falls back to treating the response as same-origin with the page that
 * requested it — which is exactly the attacker's page. So the Host header is
 * ALSO checked as its own middleware, on every method, before the request
 * reaches anything else. `isAllowedHost` is the one function both that
 * middleware and the CSRF check below call, so the two can never drift apart.
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
 * The nonce is never logged, never written to disk, and never echoed back in a
 * rejection message.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Shipped frontend. Nothing outside this directory is ever served. */
export const DEFAULT_PUBLIC_DIR = path.resolve(HERE, "..", "public");

/** The only interface this server is allowed to bind. Never the wildcard one. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Loopback peer addresses, in the forms Node reports them. */
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Methods that cannot change state, and so carry no CSRF requirement. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Lazily imported dependencies. Overridable per-app for tests. */
export const DEFAULT_MODULES = Object.freeze({
  registry: "./collectors/registry.js",
  health: "./analyzer/health.js",
  trends: "./analyzer/trends.js",
  report: "./report/generator.js",
  fixBase: "./fixes/base.js",
});

/**
 * BP-004.01..05. `specifier` is resolved lazily: waves 4B/4C may not have
 * landed yet, and a fix whose module is absent is reported as `unavailable`
 * with a reason rather than silently dropped from the list.
 */
export const FIX_CATALOG = Object.freeze([
  { id: "claude-auto-compact", title: "Enable auto-compaction", cli: "claude", kind: "json-merge", blueprint: "BP-004.01", specifier: "./fixes/claude/auto-compact.js" },
  { id: "claude-output-hygiene", title: "Output hygiene instruction", cli: "claude", kind: "append-section", blueprint: "BP-004.02", specifier: "./fixes/claude/output-hygiene.js" },
  { id: "claude-batch-commands", title: "Batch commands instruction", cli: "claude", kind: "append-section", blueprint: "BP-004.03", specifier: "./fixes/claude/batch-commands.js" },
  { id: "claude-worker-cap", title: "Worker cap instruction", cli: "claude", kind: "append-section", blueprint: "BP-004.04", specifier: "./fixes/claude/worker-cap.js" },
  { id: "claude-compact-contract", title: "Compact contract instruction", cli: "claude", kind: "append-section", blueprint: "BP-004.05", specifier: "./fixes/claude/compact-contract.js" },
]);

/**
 * Publish each rule's fix title and target CLI next to its id, and each session's
 * display name, so no client keeps a second copy of either catalogue.
 *
 * The offer line needs a human name; `rule.fix` is an id. The page used to hold
 * its own id -> title map with a drift test reading THIS file to keep the two
 * honest — which is two catalogues and a test standing between them, exactly
 * the shape F-021 recorded. The title is a server fact, so the server states
 * it. An id absent from the catalogue publishes `fixTitle: null` and
 * `fixCliName: null` rather than guessed values. An unknown session CLI gets
 * `cliName: null`; the client renders no cross-CLI note without both names.
 *
 * Mutates in place: these objects are built fresh by `analyzeAll` per request.
 *
 * @param {Array<object>|undefined} sessions
 * @param {Map<string, {title?: string, cli?: string}>} fixes
 * @param {Map<string, string>} displayNames
 */
export function annotateFixTitles(sessions, fixes, displayNames = new Map()) {
  for (const session of Array.isArray(sessions) ? sessions : []) {
    session.cliName = typeof session?.cli === "string" ? displayNames.get(session.cli) ?? null : null;
    for (const rule of Array.isArray(session?.rules) ? session.rules : []) {
      if (!rule || typeof rule !== "object") continue;
      const fix = typeof rule.fix === "string" ? fixes.get(rule.fix) : undefined;
      rule.fixTitle = typeof fix?.title === "string" ? fix.title : null;
      rule.fixCli = typeof fix?.cli === "string" ? fix.cli : null;
      rule.fixCliName = typeof fix?.cli === "string" ? displayNames.get(fix.cli) ?? null : null;
    }
    // A sub-agent session carries the same six verdicts and the same offers.
    annotateFixTitles(session?.subagentSessions, fixes, displayNames);
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
 * Called by the standalone Host middleware (every method) and by
 * `csrfFailure` (mutating methods only) so there is exactly one place that
 * knows what a legitimate Host header looks like.
 */
function isAllowedHost(state, req) {
  const host = req.headers.host;
  return typeof host === "string" && state.hostAllowlist.has(host.toLowerCase());
}

function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * The three-part mutating-route check. Returns `null` when the request may
 * proceed, otherwise `{status, error, reason}`. No rejection message contains
 * the nonce or echoes the attacker-supplied header value back.
 */
export function csrfFailure(state, req) {
  const supplied = req.headers["x-csrf-token"];
  if (typeof supplied !== "string" || supplied.length === 0) {
    return { reason: "csrf_token_missing", error: "X-CSRF-Token header is required on every mutating request" };
  }
  if (!constantTimeEquals(supplied, state.nonce)) {
    return { reason: "csrf_token_mismatch", error: "X-CSRF-Token does not match this server's startup nonce" };
  }
  if (!isAllowedHost(state, req)) {
    return { reason: "host_rejected", error: "Host header is not the loopback address this server is bound to" };
  }
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) {
    return { reason: "origin_missing", error: "Origin header is required on every mutating request" };
  }
  if (origin !== `http://${host.toLowerCase()}`) {
    return { reason: "origin_rejected", error: "Origin header is not this server's own origin" };
  }
  return null;
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
// Fix resolution
// ---------------------------------------------------------------------------

function looksLikeFix(value) {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.preview === "function"
    && typeof value.check === "function";
}

/**
 * Instantiate a catalog entry. Waves 4B/4C own the fix modules and their export
 * names are not fixed by the blueprint, so every exported binding is tried:
 * a fix instance, a factory returning one, or a class.
 */
async function instantiateFix(descriptor, env, load) {
  if (typeof descriptor.factory === "function") {
    const made = await descriptor.factory({ env, descriptor });
    if (!looksLikeFix(made)) {
      throw new HttpError(500, `fix "${descriptor.id}" factory did not return a fix`);
    }
    return made;
  }

  const loaded = await load(`fix:${descriptor.id}`);
  if (!loaded.ok) {
    return { unavailable: `fix module is not installed in this build (${descriptor.specifier})` };
  }

  const module = loaded.module;
  const ordered = ["createFix", "default", ...Object.keys(module)];
  const tried = new Set();
  for (const name of ordered) {
    if (tried.has(name)) continue;
    tried.add(name);
    const candidate = module[name];
    if (looksLikeFix(candidate)) return candidate;
    if (typeof candidate !== "function") continue;
    for (const build of [() => candidate({ env }), () => new candidate({ env })]) {
      try {
        const made = build();
        if (looksLikeFix(made)) return made;
      } catch {
        // Wrong calling convention for this binding; try the next one.
      }
    }
  }
  return { unavailable: `fix module exports no usable fix (${descriptor.specifier})` };
}

// ---------------------------------------------------------------------------
// HTML with the injected nonce (BP-005.13)
// ---------------------------------------------------------------------------

const CSRF_META = /<meta\s[^>]*name=(["'])csrf-token\1[^>]*>/i;
const HEAD_OPEN = /<head(\s[^>]*)?>/i;

export function injectNonce(html, nonce) {
  const tag = `<meta name="csrf-token" content="${nonce}">`;
  if (CSRF_META.test(html)) return html.replace(CSRF_META, tag);
  if (HEAD_OPEN.test(html)) return html.replace(HEAD_OPEN, (match) => `${match}\n    ${tag}`);
  return `${tag}\n${html}`;
}

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
 * THE HAZARD IT IS BUILT AROUND: `annotateFixTitles` mutates its input in
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
 * @param {string} [options.nonce] per-process CSRF nonce (generated when absent)
 * @param {string} [options.publicDir] static root; nothing outside it is served
 * @param {string} [options.home] home used to resolve fix targets and undo state
 * @param {object} [options.modules] specifier or module-object overrides
 * @param {Array}  [options.fixCatalog] fix descriptors (`factory` allowed)
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
    nonce: typeof options.nonce === "string" && options.nonce ? options.nonce : crypto.randomBytes(32).toString("hex"),
    publicDir: path.resolve(options.publicDir ?? DEFAULT_PUBLIC_DIR),
    home: path.resolve(options.home ?? process.env.SESSION_RX_HOME ?? os.homedir()),
    host: LOOPBACK_HOST,
    port: null,
    hostAllowlist: new Set(),
    fixCatalog: Array.isArray(options.fixCatalog) ? options.fixCatalog : FIX_CATALOG,
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
  for (const descriptor of state.fixCatalog) {
    if (descriptor.specifier) specifiers[`fix:${descriptor.id}`] = descriptor.specifier;
  }
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
  // §5 below only runs for mutating methods, so without this a bare GET —
  // including one served after DNS rebinding pointed the victim's browser at
  // this loopback port under an attacker-controlled hostname — was never
  // Host-checked. `isAllowedHost` is the SAME function §5's `csrfFailure`
  // calls; there is exactly one place that knows what a legitimate Host
  // header looks like.
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

  // ---- 5. CSRF on every mutating route, BEFORE the body is parsed ---------
  app.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const failure = csrfFailure(state, req);
    if (failure) {
      res.status(403).type("application/json").send(JSON.stringify({
        error: failure.error,
        reason: failure.reason,
      }));
      return;
    }
    next();
  });

  app.use(express.json({ limit: BODY_LIMIT, strict: true }));

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
   * `annotateFixTitles` and everything downstream keep the private object they
   * have always had. Nothing else in this function changed: the scan bound, the
   * `atLimit` derivation and the note are computed from the returned corpus
   * exactly as before, so `corpusComplete` and every verdict that depends on it
   * are untouched by whether this request read the disk or not.
   */
  async function collectFor(res, query) {
    const registry = await require$(res, "registry", "the collector registry");
    if (!registry) return null;
    const requested = query.limit ?? null;
    const limit = requested ?? state.scanLimit;
    const since = query.since ?? undefined;
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
   * `annotateFixTitles` below mutates the analysis in place, so a shared
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
      (Array.isArray(registry.COLLECTOR_SPECS) ? registry.COLLECTOR_SPECS : [])
        .filter((spec) => Array.isArray(spec) && typeof spec[0] === "string" && typeof spec[1] === "string")
        .map(([id, displayName]) => [id, displayName]),
    );
    const fixes = new Map(
      state.fixCatalog
        .filter((fix) => typeof fix?.id === "string")
        .map((fix) => [fix.id, { title: fix.title, cli: fix.cli }]),
    );
    annotateFixTitles(analysis.sessions, fixes, displayNames);
    annotateFixTitles(analysis.subagentSessions, fixes, displayNames);
    return { ...collectedFor, analysis };
  }

  // ---- 6. `/` and `/index.html` with the nonce injected -------------------

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
    // The nonce must never be cached, in this process or a later one.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Security-Policy", CSP);
    res.send(injectNonce(html, state.nonce));
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
    await sendJson(res, 200, {
      sessions: page,
      // `total` is the whole filtered match, not the page — it is what the UI
      // says it is not showing, so it may never shrink to the page size.
      total: matched.length,
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

  /**
   * The applied-fix history section 5 renders, read from the ONE record the fix
   * engine keeps: the FVA-007 transaction journal, through the engine's own
   * `readJournal()`.  No second parser, no second format.
   *
   * Every way of NOT reading it returns `{status: "unknown", reason}`.  "No fix
   * was applied in this period" is a claim about the user's own history, and an
   * unread journal is no evidence for it — that sentence printed under five
   * freshly applied fixes was the one outright falsehood in this product.
   */
  async function appliedFixHistory({ from, to }) {
    const unknown = (reason) => ({ status: "unknown", reason });
    const detail = (error) => (error?.code ? error.code : error instanceof Error ? error.message : String(error));

    const loaded = await load("fixBase");
    if (!loaded.ok) {
      return unknown(`the fix engine is unavailable in this build (${loaded.specifier ?? "no module registered"}), so the transaction journal could not be read`);
    }
    const base = loaded.module;
    let env;
    try {
      env = await fixEnvFor(base);
    } catch (error) {
      return unknown(`the fix environment could not be created (${detail(error)}), so the transaction journal could not be read`);
    }
    // `display()` keeps the journal and undo records in `~/...` form: the report
    // is a file the user is expected to paste in public.
    const shown = (value) => (typeof value === "string" && value !== "" ? env.display(value) : null);
    const journal = shown(env.journalPath) ?? "the transaction journal";

    let size;
    try {
      size = (await fs.stat(env.journalPath)).size;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return unknown(`${journal} does not exist, so no applied-fix history could be read: either no fix has ever been applied here or the record was removed, and SessionRx cannot tell those two apart`);
      }
      return unknown(`${journal} could not be opened (${detail(error)}), so no applied-fix history could be read`);
    }

    let rows;
    try {
      rows = await base.readJournal(env);
    } catch (error) {
      return unknown(`${journal} could not be read (${detail(error)})`);
    }
    // `readJournal` drops a line it cannot parse, so a file with bytes and no
    // record is a malformed journal, not an empty one.
    if (size > 0 && rows.length === 0) {
      return unknown(`${journal} holds ${size} byte(s) but not one parseable record, so the applied-fix history could not be reconstructed`);
    }
    const events = rows.filter((row) => typeof row?.event === "string" && typeof row?.fixId === "string" && row.fixId !== "");
    if (rows.length > 0 && events.length === 0) {
      return unknown(`${journal} holds ${rows.length} record(s), not one of which names both a fix and an event, so the applied-fix history could not be reconstructed`);
    }
    const applies = events.filter((row) => row.event === "apply");
    if (events.length > 0 && applies.length === 0) {
      return unknown(`${journal} holds ${events.length} record(s) but not one apply, so what was applied could not be reconstructed from it`);
    }

    const reverted = new Set(events.filter((row) => row.event === "undo").map((row) => row.undoPath));
    const titles = new Map(
      state.fixCatalog
        .filter((fix) => typeof fix?.id === "string" && typeof fix?.title === "string")
        .map((fix) => [fix.id, fix.title]),
    );
    const fromMs = from ? from.getTime() : null;
    const toMs = to ? to.getTime() : null;
    const inWindow = (ts) => {
      if (fromMs === null && toMs === null) return true;
      const at = Date.parse(typeof ts === "string" ? ts : "");
      // An apply with no usable timestamp is EXCLUDED from a bounded window
      // rather than assumed to be inside it, exactly as `filterSessions` does.
      if (!Number.isFinite(at)) return false;
      if (fromMs !== null && at < fromMs) return false;
      if (toMs !== null && at > toMs) return false;
      return true;
    };

    return applies.filter((row) => inWindow(row.ts)).map((row) => {
      const targets = (Array.isArray(row.targets) ? row.targets : [])
        .map((target) => shown(target?.path))
        .filter(Boolean);
      return {
        id: row.fixId,
        name: titles.get(row.fixId) ?? null,
        target: targets.length > 0 ? targets.join(", ") : null,
        appliedAt: typeof row.ts === "string" ? row.ts : null,
        status: reverted.has(row.undoPath) ? "reverted" : "applied",
        // The journal records each target's content HASH, never its bytes, so
        // the BEFORE text genuinely is not in it. The generator says it was not
        // recorded rather than implying the fix went unaudited.
        before: null,
        undoPath: shown(row.undoPath),
      };
    });
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
    // `buildReportInput` coerces a non-array `fixes` to `[]`, and `[]` is what
    // the generator renders as "No fix was applied in this period" — so an
    // unreadable journal passed through it would come out as that same
    // falsehood. The history is attached here instead, where `unknown` survives.
    reportInput.fixes = await appliedFixHistory({ from, to });
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
    });
  }));

  // Fix lifecycle -----------------------------------------------------------

  /** One fix env per app: all targets resolve under `state.home` and nowhere else. */
  let fixEnvPromise = null;
  function fixEnvFor(base) {
    fixEnvPromise ??= Promise.resolve(base.createFixEnvironment({ home: state.home, now: state.now }));
    return fixEnvPromise;
  }
  async function fixEnv(res) {
    const base = await require$(res, "fixBase", "the fix engine");
    if (!base) return null;
    return { base, env: await fixEnvFor(base) };
  }

  function findDescriptor(fixId) {
    const descriptor = state.fixCatalog.find((candidate) => candidate.id === fixId);
    if (!descriptor) {
      throw new HttpError(404, `no fix with id ${fixId} exists`, { reason: "fix_not_found" });
    }
    return descriptor;
  }

  /** Resolve a fix, or answer with the honest reason it is not available. */
  async function resolveFix(res, fixId) {
    const descriptor = findDescriptor(fixId);
    const loadedEnv = await fixEnv(res);
    if (!loadedEnv) return null;
    const fix = await instantiateFix(descriptor, loadedEnv.env, load);
    if (fix.unavailable) {
      await sendError(res, 503, fix.unavailable, {
        reason: "fix_unavailable",
        fixId: descriptor.id,
        blueprint: descriptor.blueprint ?? null,
      });
      return null;
    }
    return { descriptor, fix, base: loadedEnv.base, env: loadedEnv.env };
  }

  /** Not in BP-005; documented addition so the UI can list fixes before previewing one. */
  app.get("/api/fixes", route(async (req, res) => {
    const loadedEnv = await fixEnv(res);
    if (!loadedEnv) return;
    const fixes = [];
    for (const descriptor of state.fixCatalog) {
      const fix = await instantiateFix(descriptor, loadedEnv.env, load);
      if (fix.unavailable) {
        fixes.push({
          id: descriptor.id,
          title: descriptor.title ?? descriptor.id,
          kind: descriptor.kind ?? null,
          blueprint: descriptor.blueprint ?? null,
          available: false,
          reason: fix.unavailable,
        });
        continue;
      }
      fixes.push({
        id: fix.id ?? descriptor.id,
        title: fix.title ?? descriptor.title ?? descriptor.id,
        kind: fix.kind ?? descriptor.kind ?? null,
        blueprint: descriptor.blueprint ?? null,
        available: true,
        applyable: fix.applyable !== false,
        ruleId: fix.ruleId ?? null,
        rationale: fix.rationale ?? null,
      });
    }
    await sendJson(res, 200, { fixes, home: state.home });
  }));

  // BP-005.09 — GET, because `check` reads and changes nothing.
  app.get("/api/fixes/:fixId/check", route(async (req, res) => {
    const resolved = await resolveFix(res, String(req.params.fixId ?? ""));
    if (!resolved) return;
    const checked = await resolved.fix.check();
    // Spread FIRST: the documented keys are a guarantee, so they win over
    // whatever the fix returned under the same name.
    await sendJson(res, 200, {
      ...checked,
      applied: checked?.applied === true,
      marker: checked?.marker ?? null,
    });
  }));

  // BP-005.06
  app.post("/api/fixes/:fixId/preview", route(async (req, res) => {
    const resolved = await resolveFix(res, String(req.params.fixId ?? ""));
    if (!resolved) return;
    let preview;
    try {
      preview = await resolved.fix.preview();
    } catch (error) {
      await sendFixError(res, resolved.descriptor, error, "preview");
      return;
    }
    await sendJson(res, 200, {
      ...preview,
      description: preview?.description ?? null,
      diff: preview?.diff ?? "",
      files_affected: Array.isArray(preview?.files_affected) ? preview.files_affected : [],
      reversible: preview?.reversible === true,
      check: preview?.check ?? null,
    });
  }));

  // BP-005.07
  app.post("/api/fixes/:fixId/apply", route(async (req, res) => {
    const resolved = await resolveFix(res, String(req.params.fixId ?? ""));
    if (!resolved) return;
    if (typeof resolved.fix.apply !== "function") {
      await sendError(res, 409, `fix ${resolved.descriptor.id} is a recommendation and writes nothing`, {
        reason: "fix_not_applyable",
        fixId: resolved.descriptor.id,
      });
      return;
    }
    let applied;
    try {
      applied = await resolved.fix.apply();
    } catch (error) {
      await sendFixError(res, resolved.descriptor, error, "apply");
      return;
    }
    await sendJson(res, 200, {
      ...applied,
      applied: applied?.applied === true,
      undoPath: applied?.undoPath ?? null,
      files_affected: Array.isArray(applied?.files_affected) ? applied.files_affected : [],
      diff: applied?.diff ?? "",
    });
  }));

  // BP-005.08
  app.post("/api/fixes/:fixId/undo", route(async (req, res) => {
    const resolved = await resolveFix(res, String(req.params.fixId ?? ""));
    if (!resolved) return;
    const undoPath = typeof req.body?.undoPath === "string" && req.body.undoPath ? req.body.undoPath : null;
    if (typeof resolved.fix.undo !== "function") {
      await sendError(res, 409, `fix ${resolved.descriptor.id} writes nothing, so there is nothing to undo`, {
        reason: "fix_not_applyable",
        fixId: resolved.descriptor.id,
      });
      return;
    }
    let restored;
    try {
      restored = await resolved.fix.undo(undoPath ?? undefined);
    } catch (error) {
      await sendFixError(res, resolved.descriptor, error, "undo");
      return;
    }
    await sendJson(res, 200, {
      ...restored,
      restored: restored?.restored === true,
      byteIdentical: restored?.byteIdentical === true,
    });
  }));

  /**
   * Codes that mean the fix ENGINE broke a guarantee of its own rather than the
   * file on disk being in a state the fix refuses to touch. Those are a 500;
   * every other code in the engine's table is a precondition the user can act
   * on, so it is a 409 with the code attached. Classifying against the engine's
   * exported table rather than a list written here means a code added later is
   * mapped, not silently treated as an internal error.
   */
  const ENGINE_FAILURE_CODES = new Set([
    "SPEC_INVALID",
    "WRITE_NOT_VERIFIED",
    "WRITE_OUT_OF_BOUNDS",
    "RESTORE_NOT_BYTE_IDENTICAL",
  ]);

  /** A fix refusal is a real answer, not a crash. */
  async function sendFixError(res, descriptor, error, phase) {
    const code = error?.code ?? null;
    const base = (await load("fixBase")).module ?? null;
    const known = base?.FIX_ERROR_CODES ?? {};
    const isKnown = Boolean(code) && Object.hasOwn(known, code);
    const status = isKnown && !ENGINE_FAILURE_CODES.has(code) ? 409 : 500;
    await sendError(res, status, error instanceof Error ? error.message : String(error), {
      reason: code ? `fix_${String(code).toLowerCase()}` : "fix_failed",
      fixId: descriptor.id,
      phase,
      code,
    });
  }

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
 *   url: string, host: string, port: number, nonce: string, close: () => Promise<void>}>}
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
    // Returned for the caller that must inject it; never logged by this module.
    nonce: state.nonce,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

export default createApp;
