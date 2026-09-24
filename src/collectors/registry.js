import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Collector, createDiagnostic } from "./base.js";

/**
 * The `status` of a slot whose reader is installed with SessionRx but could not
 * be loaded on this machine. It is deliberately NOT "absent": absent is a
 * finding about the user's machine, and this is a finding about SessionRx.
 */
export const COULD_NOT_READ = "could-not-read";

const definitions = [
  ["claude", "Claude Code", "./claude.js", "ClaudeCollector"],
  ["codex", "Codex", "./codex.js", "CodexCollector"],
  ["cursor", "Cursor CLI", "./cursor.js", "CursorCollector"],
];

/** The registry-owned display names used by API annotations as well as detection. */
export const COLLECTOR_SPECS = definitions;

const stubs = [];

/** Why a reader that is shipped with SessionRx could not be loaded here. */
function loadFailureReason(displayName, error) {
  const detail = (error instanceof Error ? error.message : String(error)) || String(error);
  return (
    `SessionRx could not load the part of itself that reads ${displayName}, so it cannot say whether `
    + `${displayName} is installed and it read none of its sessions. Loading it failed with: ${detail}. `
    + `This is not a finding that ${displayName} is missing — it is a gap in SessionRx on this machine. `
    + "A reader that needs a newer Node than the one running SessionRx fails exactly this way, so the "
    + "first thing to check is the Node version this was started with against the one the README asks for."
  );
}

/**
 * A slot whose reader FILE IS PRESENT but could not be loaded — a Node too old
 * for a built-in the reader imports, a syntax error, or a throw while the
 * module ran.
 *
 * Calling that "absent" is the one thing this product exists not to do: it
 * tells a user who HAS the tool installed that they do not, confidently and
 * with no sign that anything went wrong. So this slot claims nothing about
 * installation — `installed` is null, not false — and carries the reason.
 */
class UnreadableCollector extends Collector {
  constructor({ id, displayName, error }) {
    super({ id, displayName, cli: id });
    this.reason = loadFailureReason(displayName ?? id, error);
  }

  detect() {
    return { installed: null, paths: [], status: COULD_NOT_READ, reason: this.reason };
  }

  /**
   * Refuses rather than returning `[]`. An empty array here would read as "the
   * tool was read and had no sessions", which is the same false all-clear one
   * layer down. `detectMany`/`collectMany` route this slot before they get
   * here, so this is the guard for any other caller.
   */
  async collect() {
    throw new Error(this.reason);
  }
}

/**
 * Whether the reader module is on disk at all.
 *
 * `import.meta.resolve` does NOT answer this — it returns a URL for a file that
 * does not exist (verified on Node v26.7.0) — so the check is explicit. A
 * specifier that is not a file URL (a bare or `node:` one) counts as present:
 * whether it loads is then the import's answer to give, not this function's.
 */
function readerFileExists(modulePath) {
  let url;
  try {
    url = import.meta.resolve(modulePath);
  } catch {
    return false;
  }
  if (!url.startsWith("file:")) return true;
  try {
    return existsSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

/**
 * Turn one row of `definitions` into a collector. Three outcomes, and the first
 * two are NOT the same thing:
 *
 *   reader file is not there       -> the Phase 1 slot, exactly as before
 *   reader file is there but broke -> an UnreadableCollector carrying why
 *   it loaded                      -> the real collector
 *
 * Exported for the same reason `detectMany` is: these outcomes can only be
 * exercised against deliberately broken definitions, which the real registry
 * cannot supply.
 */
export async function loadCollector([id, displayName, modulePath, exportName]) {
  if (!readerFileExists(modulePath)) {
    // Phase 1 is intentionally usable before parser modules land. The absent
    // parser is represented as an uninstalled supported-slot collector.
    return new Collector({ id, displayName, cli: id });
  }
  try {
    const module = await import(modulePath);
    const Type = module[exportName] ?? module.default;
    if (typeof Type !== "function") throw new Error(`it exports no ${exportName}`);
    return new Type();
  } catch (error) {
    // The file is there and it did not work. Containment is per slot: this
    // returns a collector like any other, so the other five still report.
    return new UnreadableCollector({ id, displayName, error });
  }
}

export async function collectors() {
  return [...(await Promise.all(definitions.map(loadCollector))), ...stubs];
}

function pushError(diagnostic, error) {
  diagnostic.errors.push(error instanceof Error ? error.message : String(error));
}

/**
 * Whether a diagnostic carries anything worth reporting. Counters, skipped
 * lines, truncations, errors and window promotions all count: a promotion is
 * how a stale MODEL_WINDOWS entry stays VISIBLE, so a diagnostic that holds
 * only promotions must still reach the caller.
 */
function hasSignal(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object") return false;
  for (const [key, value] of Object.entries(diagnostic)) {
    if (key === "cli") continue;
    if (typeof value === "number" && value !== 0) return true;
    if (Array.isArray(value) && value.length) return true;
  }
  return false;
}

/** A diagnostic-shaped object, by duck type rather than by class. */
function isDiagnostic(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof value.cli === "string" && Array.isArray(value.errors);
}

/**
 * Fold `source` into `target` additively: numbers sum, arrays concatenate,
 * anything else (notably `cli`) is the target's. Generic on purpose, so a
 * counter added to `createDiagnostic` later flows through without a change here.
 */
function mergeDiagnostic(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (key === "cli") continue;
    if (typeof value === "number") {
      target[key] = (typeof target[key] === "number" ? target[key] : 0) + value;
    } else if (Array.isArray(value)) {
      const existing = Array.isArray(target[key]) ? target[key] : [];
      if (existing !== value) target[key] = [...existing, ...value];
    } else if (!(key in target)) {
      target[key] = value;
    }
  }
}

/**
 * Collectors report their run two different ways: some take the caller's
 * diagnostic as a `collect` option and fill it in place, others publish their
 * own on `this.diagnostic` / `this.lastDiagnostic`. Fold in only the ones that
 * are a DIFFERENT object from the one already passed down, so a collector that
 * honoured the option is never counted twice.
 */
function mergeCollectorDiagnostics(target, collector) {
  for (const candidate of [collector?.diagnostic, collector?.lastDiagnostic]) {
    if (candidate === target || !isDiagnostic(candidate)) continue;
    mergeDiagnostic(target, candidate);
  }
}

/**
 * Per-session facts BP-002's NormalizedSession has no slot for — such as the
 * DIS-004 parent-session linkage a collector like Claude's publishes for its
 * sub-agent transcripts — published by a collector on `sessionMeta`, keyed by
 * session id.
 *
 * Returned as a plain object because a `Map` JSON-serializes to `{}`, and the
 * response crosses the HTTP boundary. Joins to a session on `sessionId`.
 * `null` means this collector does not expose the channel at all, which is
 * distinct from exposing it and having nothing to say.
 */
function plainSessionMeta(collector) {
  const meta = collector?.sessionMeta;
  if (meta instanceof Map) return Object.fromEntries(meta);
  if (meta && typeof meta === "object" && !Array.isArray(meta)) return { ...meta };
  return null;
}

function statusEntry(collector, detection, diagnostic) {
  return { id: collector.id, displayName: collector.displayName, ...detection, diagnostic };
}

/**
 * A slot whose reader could not be loaded, filed as an ERROR as well as put in
 * its own bucket.
 *
 * Both, on purpose. The bucket is the precise answer; the error is what a
 * caller that has not learned the bucket still shows, because the diagnostics
 * channel is already rendered. Between them there is no path on which the
 * failure is silent.
 *
 * @returns {boolean} whether this detection was a load failure
 */
function recordUnreadable(detection, diagnostic) {
  if (detection?.status !== COULD_NOT_READ) return false;
  pushError(diagnostic, detection.reason ?? "its reader could not be loaded");
  return true;
}

/**
 * Detect over an explicit collector list. `detectAll` is this over the real
 * registry; taking the list as an argument is what lets the split, the
 * per-collector failure isolation, and the diagnostic aggregation be exercised
 * against deliberately broken collectors.
 *
 * FOUR buckets, not three. `unreadable` holds the slots whose reader failed to
 * load, and it is separate from `absent` because the two mean opposite things:
 * `absent` says something about the user's machine, `unreadable` says something
 * about SessionRx's. A caller that folds the two together republishes the false
 * negative this bucket exists to end. Every `unreadable` entry also files its
 * reason under `diagnostics`, so a caller that has not been taught the bucket
 * still has the failure in hand.
 */
export async function detectMany(found) {
  const supported = [];
  const detectionOnly = [];
  const absent = [];
  const unreadable = [];
  const diagnostics = [];
  for (const collector of found) {
    const diagnostic = createDiagnostic(collector.cli ?? collector.id);
    let detection;
    try {
      detection = collector.detect();
    } catch (error) {
      detection = { installed: false, paths: [], status: "absent" };
      pushError(diagnostic, error);
    }
    const loadFailed = recordUnreadable(detection, diagnostic);
    const entry = statusEntry(collector, detection, diagnostic);
    if (loadFailed) unreadable.push(entry);
    else if (detection.status === "supported") supported.push(entry);
    else if (detection.status === "detection-only") detectionOnly.push(entry);
    else absent.push(entry);
    if (hasSignal(diagnostic)) diagnostics.push(diagnostic);
  }
  return { supported, detectionOnly, absent, unreadable, diagnostics };
}

/** Collect over an explicit collector list; `collectAll` is this over the real registry. */
export async function collectMany(found, { since, limit } = {}) {
  const supported = [];
  const detectionOnly = [];
  const absent = [];
  const unreadable = [];
  const diagnostics = [];
  for (const collector of found) {
    const diagnostic = createDiagnostic(collector.cli ?? collector.id);
    let detection;
    try { detection = collector.detect(); } catch (error) {
      pushError(diagnostic, error);
      detection = { installed: false, paths: [], status: "absent" };
    }
    if (recordUnreadable(detection, diagnostic)) {
      // No sessions key: nothing was read, and an empty array would say the
      // tool was read and had none.
      unreadable.push(statusEntry(collector, detection, diagnostic));
    } else if (detection.status === "detection-only") {
      detectionOnly.push(statusEntry(collector, detection, diagnostic));
    } else if (detection.status === "absent") {
      absent.push(statusEntry(collector, detection, diagnostic));
    } else {
      // One collector's failure is its own: every other collector still reports.
      let sessions = [];
      try {
        const collected = await collector.collect({ since, limit, diagnostic });
        if (Array.isArray(collected)) sessions = collected;
      } catch (error) {
        pushError(diagnostic, error);
      }
      mergeCollectorDiagnostics(diagnostic, collector);
      const entry = { id: collector.id, displayName: collector.displayName, sessions, ...detection };
      const sessionMeta = plainSessionMeta(collector);
      if (sessionMeta) entry.sessionMeta = sessionMeta;
      supported.push(entry);
    }
    if (hasSignal(diagnostic)) diagnostics.push(diagnostic);
  }
  return { supported, detectionOnly, absent, unreadable, diagnostics };
}

export async function detectAll() {
  return detectMany(await collectors());
}

export async function collectAll(options = {}) {
  return collectMany(await collectors(), options);
}

export const discoverAll = detectAll;
export { definitions as collectorDefinitions };
