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
  { id: "claude-auto-compact", title: "Enable auto-compaction", kind: "json-merge", blueprint: "BP-004.01", specifier: "./fixes/claude/auto-compact.js" },
  { id: "claude-output-hygiene", title: "Output hygiene instruction", kind: "append-section", blueprint: "BP-004.02", specifier: "./fixes/claude/output-hygiene.js" },
  { id: "claude-batch-commands", title: "Batch commands instruction", kind: "append-section", blueprint: "BP-004.03", specifier: "./fixes/claude/batch-commands.js" },
  { id: "claude-worker-cap", title: "Worker cap instruction", kind: "append-section", blueprint: "BP-004.04", specifier: "./fixes/claude/worker-cap.js" },
  { id: "claude-compact-contract", title: "Compact contract instruction", kind: "append-section", blueprint: "BP-004.05", specifier: "./fixes/claude/compact-contract.js" },
]);

/**
 * Publish each rule's fix TITLE next to its id, so no client keeps a second
 * copy of this catalogue.
 *
 * The offer line needs a human name; `rule.fix` is an id. The page used to hold
 * its own id -> title map with a drift test reading THIS file to keep the two
 * honest — which is two catalogues and a test standing between them, exactly
 * the shape F-021 recorded. The title is a server fact, so the server states
 * it. An id absent from the catalogue publishes `fixTitle: null` rather than a
 * guessed name, and the client falls back to the id itself.
 *
 * Mutates in place: these objects are built fresh by `analyzeAll` per request.
 *
 * @param {Array<object>|undefined} sessions
 * @param {Map<string, string>} titles
 */
function annotateFixTitles(sessions, titles) {
  for (const session of Array.isArray(sessions) ? sessions : []) {
    for (const rule of Array.isArray(session?.rules) ? session.rules : []) {
      if (!rule || typeof rule !== "object") continue;
      rule.fixTitle = typeof rule.fix === "string" ? titles.get(rule.fix) ?? null : null;
    }
    // A sub-agent session carries the same six verdicts and the same offers.
    annotateFixTitles(session?.subagentSessions, titles);
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
  const host = req.headers.host;
  if (typeof host !== "string" || !state.hostAllowlist.has(host.toLowerCase())) {
    return { reason: "host_rejected", error: "Host header is not the loopback address this server is bound to" };
  }
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
    now: typeof options.now === "function" ? options.now : () => new Date(),
    load: null,
    setAddress(port, host = LOOPBACK_HOST) {
      state.port = port;
      state.host = host;
      const names = host === "::1" ? [`[::1]`] : [host, "localhost"];
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

  // ---- 3. path traversal, before anything touches the filesystem ----------
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

  // ---- 4. CSRF on every mutating route, BEFORE the body is parsed ---------
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
   */
  async function collectFor(res, query) {
    const registry = await require$(res, "registry", "the collector registry");
    if (!registry) return null;
    const requested = query.limit ?? null;
    const limit = requested ?? state.scanLimit;
    const collected = await registry.collectAll({ since: query.since ?? undefined, limit });
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

  async function analyzeFor(res, query) {
    const collectedFor = await collectFor(res, query);
    if (!collectedFor) return null;
    const health = await require$(res, "health", "the session health analyzer");
    if (!health) return null;
    const analysis = health.analyzeAll(collectedFor.collected, {
      generatedAt: state.now().toISOString(),
      limit: collectedFor.limit,
    });
    const titles = new Map(
      state.fixCatalog
        .filter((fix) => typeof fix?.id === "string" && typeof fix?.title === "string")
        .map((fix) => [fix.id, fix.title]),
    );
    annotateFixTitles(analysis.sessions, titles);
    annotateFixTitles(analysis.subagentSessions, titles);
    return { ...collectedFor, analysis };
  }

  // ---- 5. `/` and `/index.html` with the nonce injected -------------------

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

  // ---- 6. API ------------------------------------------------------------

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
    };
    const result = await analyzeFor(res, query);
    if (!result) return;
    await sendJson(res, 200, {
      sessions: result.analysis.sessions,
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
      generatedAt: state.now().toISOString(),
    });
  }));

  // BP-005.02
  app.get("/api/sessions", route(async (req, res) => {
    const from = parseIsoDate(singleValue(req.query.from, "from"), "from");
    const to = parseIsoDate(singleValue(req.query.to, "to"), "to");
    const limit = parseLimit(singleValue(req.query.limit, "limit"));
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

    // Two separate bounds, because conflating them is how a UI ends up
    // paginating against a lie: `limit` bounds the RESPONSE ROWS, `scan`
    // bounds how much of each corpus was read. `total` is the number of
    // sessions matching the filter WITHIN THE SCAN, and `scan.atLimit` says
    // whether older unread sessions exist.
    const result = await analyzeFor(res, { since: from, limit: scan });
    if (!result) return;

    const matched = filterSessions(result.analysis.sessions, {
      cli: parseCsvList(singleValue(req.query.cli, "cli")),
      project: singleValue(req.query.project, "project"),
      from,
      to,
    });
    const sorted = sortSessions(matched, sortRaw ?? "startedAt", orderRaw ?? "desc");
    await sendJson(res, 200, {
      sessions: limit === null ? sorted : sorted.slice(0, limit),
      total: matched.length,
      returned: limit === null ? sorted.length : Math.min(limit, sorted.length),
      scan: result.scan,
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
    const collectedFor = await collectFor(res, { since: from, limit: scan });
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
    await sendJson(res, 200, { ...built, scan: collectedFor.scan, diagnostics: collectedFor.collected.diagnostics ?? [] });
  }));

  // BP-005.05
  app.get("/api/report", route(async (req, res) => {
    const from = parseIsoDate(singleValue(req.query.from, "from"), "from");
    const to = parseIsoDate(singleValue(req.query.to, "to"), "to");
    const cli = parseCsvList(singleValue(req.query.cli, "cli"));
    const scan = parseLimit(singleValue(req.query.scan, "scan"));
    const result = await analyzeFor(res, { since: from, limit: scan });
    if (!result) return;
    const reportModule = await require$(res, "report", "the report generator");
    if (!reportModule) return;

    const sessions = filterSessions(result.analysis.sessions, { cli, from, to });
    const health = await require$(res, "health", "the session health analyzer");
    if (!health) return;
    const reportInput = health.buildReportInput({
      sessions,
      clis: result.analysis.collectors,
      generatedAt: state.now().toISOString(),
    });
    const document = reportModule.generateReportDocument(reportInput);
    await sendJson(res, 200, {
      markdown: document.markdown,
      generatedAt: document.generatedAt,
      redactions: document.redactions,
      scan: result.scan,
      // Not in BP-005.05, and required anyway: a report assembled from a corpus
      // where a collector failed must say so, or it reads as a complete picture.
      diagnostics: result.analysis.diagnostics ?? [],
    });
  }));

  // Fix lifecycle -----------------------------------------------------------

  /** One fix env per app: all targets resolve under `state.home` and nowhere else. */
  let fixEnvPromise = null;
  async function fixEnv(res) {
    const base = await require$(res, "fixBase", "the fix engine");
    if (!base) return null;
    fixEnvPromise ??= Promise.resolve(base.createFixEnvironment({ home: state.home, now: state.now }));
    return { base, env: await fixEnvPromise };
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

  // ---- 7. static assets, then honest 404s --------------------------------

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

  // ---- 8. error handler --------------------------------------------------

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
