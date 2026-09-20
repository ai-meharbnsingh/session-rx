import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Collector, createDiagnostic } from "./base.js";

const home = os.homedir();

class ExistenceProbeCollector extends Collector {
  constructor(id, displayName, candidates) {
    super({ id, displayName, cli: id });
    this.candidates = candidates;
  }

  detect() {
    const paths = this.candidates.map((candidate) => path.join(home, candidate));
    const installedPaths = paths.filter((candidate) => existsSync(candidate));
    return {
      installed: installedPaths.length > 0,
      paths: installedPaths,
      status: installedPaths.length > 0 ? "detection-only" : "absent",
    };
  }

  async collect() { return []; }
}

const definitions = [
  ["claude", "Claude Code", "./claude.js", "ClaudeCollector"],
  ["codex", "Codex", "./codex.js", "CodexCollector"],
  ["gemini", "Gemini CLI", "./gemini.js", "GeminiCollector"],
  ["kimi", "Kimi", "./kimi.js", "KimiCollector"],
  ["opencode", "OpenCode", "./opencode.js", "OpenCodeCollector"],
  ["copilot", "GitHub Copilot CLI", "./copilot.js", "CopilotCollector"],
];

const stubs = [
  new ExistenceProbeCollector("grok-amp", "Grok / Amp", [".grok", ".config/grok", ".amp", ".config/amp", ".cache/amp"]),
];

async function loadCollector([id, displayName, modulePath, exportName]) {
  try {
    const module = await import(modulePath);
    const Type = module[exportName] ?? module.default;
    if (typeof Type !== "function") throw new Error(`missing ${exportName} export`);
    return new Type();
  } catch {
    // Phase 1 is intentionally usable before parser modules land. The absent
    // parser is represented as an uninstalled supported-slot collector.
    return new Collector({ id, displayName, cli: id });
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
 * Per-session facts BP-002's NormalizedSession has no slot for — OpenCode's
 * `session`-row totals and the DIS-004 `parent_id` linkage — published by a
 * collector on `sessionMeta`, keyed by session id.
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
 * Detect over an explicit collector list. `detectAll` is this over the real
 * registry; taking the list as an argument is what lets the split, the
 * per-collector failure isolation, and the diagnostic aggregation be exercised
 * against deliberately broken collectors.
 */
export async function detectMany(found) {
  const supported = [];
  const detectionOnly = [];
  const absent = [];
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
    const entry = statusEntry(collector, detection, diagnostic);
    if (detection.status === "supported") supported.push(entry);
    else if (detection.status === "detection-only") detectionOnly.push(entry);
    else absent.push(entry);
    if (hasSignal(diagnostic)) diagnostics.push(diagnostic);
  }
  return { supported, detectionOnly, absent, diagnostics };
}

/** Collect over an explicit collector list; `collectAll` is this over the real registry. */
export async function collectMany(found, { since, limit } = {}) {
  const supported = [];
  const detectionOnly = [];
  const absent = [];
  const diagnostics = [];
  for (const collector of found) {
    const diagnostic = createDiagnostic(collector.cli ?? collector.id);
    let detection;
    try { detection = collector.detect(); } catch (error) {
      pushError(diagnostic, error);
      detection = { installed: false, paths: [], status: "absent" };
    }
    if (detection.status === "detection-only") {
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
  return { supported, detectionOnly, absent, diagnostics };
}

export async function detectAll() {
  return detectMany(await collectors());
}

export async function collectAll(options = {}) {
  return collectMany(await collectors(), options);
}

export const discoverAll = detectAll;
export { definitions as collectorDefinitions };
