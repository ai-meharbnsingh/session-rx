import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Collector,
  contextFraction,
  createDiagnostic,
  normalizeSession,
  normalizeTurn,
  peakContextTokens,
  resolveWindow,
  safeReadJsonl,
} from "./base.js";

/** BP-002.08: parsers stay bounded regardless of transcript size. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl` */
const ROLLOUT = /^rollout-.*\.jsonl$/i;
const MAX_DEPTH = 3;

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Byte length of a tool output blob; `null` when nothing was recorded. */
function measureBytes(output) {
  if (output === null || output === undefined) return null;
  if (typeof output === "string") return Buffer.byteLength(output, "utf8");
  if (Array.isArray(output)) {
    let total = 0;
    for (const block of output) {
      if (typeof block === "string") total += Buffer.byteLength(block, "utf8");
      else if (block && typeof block === "object" && typeof block.text === "string") {
        total += Buffer.byteLength(block.text, "utf8");
      } else total += Buffer.byteLength(JSON.stringify(block ?? null), "utf8");
    }
    return total;
  }
  if (typeof output === "object") return Buffer.byteLength(JSON.stringify(output), "utf8");
  return Buffer.byteLength(String(output), "utf8");
}

/**
 * Parse one Codex rollout.
 *
 * `event_msg` / `payload.type === "token_count"` carries the accounting:
 *   - `info.model_context_window` IS in the log, so the window is native and
 *     no model table is consulted (BP-002.02).
 *   - `info.total_token_usage` is CUMULATIVE and is never summed across
 *     records; `info.last_token_usage` is the per-turn delta.
 * A `session_meta` with no `token_count` anywhere leaves every usage field
 * null — never zero.
 */
async function parseSession(file, { diagnostic, maxBytes }) {
  let sessionId = null;
  let cwd = null;
  let model = null;
  let windowTokens = null;
  let startedAt = null;
  let endedAt = null;

  const rows = [];
  const pendingCalls = new Map();
  const outputBytes = new Map();
  let anonymous = 0;

  const flushPending = () => {
    const calls = [...pendingCalls.values()];
    pendingCalls.clear();
    return calls;
  };

  await safeReadJsonl(file, (record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      diagnostic.linesSkipped += 1;
      return;
    }
    if (typeof record.type !== "string") {
      diagnostic.linesSkipped += 1;
      return;
    }

    const ts = typeof record.timestamp === "string" ? record.timestamp : null;
    if (ts) {
      if (startedAt === null || ts < startedAt) startedAt = ts;
      if (endedAt === null || ts > endedAt) endedAt = ts;
    }

    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      diagnostic.linesSkipped += 1;
      return;
    }

    // `model` is written by `turn_context` in older builds and by later
    // settings records; read it where it literally appears, never infer it.
    if (typeof payload.model === "string" && payload.model) model = payload.model;

    if (record.type === "session_meta") {
      if (typeof payload.session_id === "string" && payload.session_id) sessionId = payload.session_id;
      else if (!sessionId && typeof payload.id === "string" && payload.id) sessionId = payload.id;
      if (typeof payload.cwd === "string" && payload.cwd) cwd = payload.cwd;
      return;
    }

    if (record.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info;
      if (!info || typeof info !== "object") {
        diagnostic.linesSkipped += 1;
        return;
      }
      const native = numberOrNull(info.model_context_window);
      if (native !== null) windowTokens = native;

      const last = info.last_token_usage && typeof info.last_token_usage === "object"
        ? info.last_token_usage
        : null;
      rows.push({
        ts,
        inputTokens: last ? numberOrNull(last.input_tokens) : null,
        cacheRead: last ? numberOrNull(last.cached_input_tokens) : null,
        // Codex only distinguishes cache creation in builds that emit
        // `cache_write_input_tokens`; when the field is absent this stays
        // null rather than being reported as zero.
        cacheCreate: last ? numberOrNull(last.cache_write_input_tokens) : null,
        output: last ? numberOrNull(last.output_tokens) : null,
        calls: flushPending(),
      });
      return;
    }

    if (record.type === "response_item") {
      const kind = payload.type;
      // "message" and "reasoning" are model text, not tool calls.
      if (kind === "function_call" || kind === "custom_tool_call") {
        const id = typeof payload.call_id === "string" && payload.call_id
          ? payload.call_id
          : typeof payload.id === "string" && payload.id
            ? payload.id
            : null;
        const name = typeof payload.name === "string" && payload.name ? payload.name : null;
        // A call we can neither identify nor name is not evidence that a tool
        // ran: it is skipped rather than counted as an unnamed tool call.
        if (id === null && name === null) {
          diagnostic.linesSkipped += 1;
          return;
        }
        const key = id ?? `anon:${(anonymous += 1)}`;
        if (!pendingCalls.has(key)) {
          pendingCalls.set(key, {
            id,
            name,
            input: Object.hasOwn(payload, "arguments") ? payload.arguments
              : Object.hasOwn(payload, "input") ? payload.input
                : null,
          });
        }
        return;
      }
      if (kind === "function_call_output" || kind === "custom_tool_call_output") {
        const id = typeof payload.call_id === "string" && payload.call_id ? payload.call_id : null;
        if (id === null) return;
        const bytes = measureBytes(payload.output);
        if (bytes !== null) outputBytes.set(id, bytes);
      }
    }
  }, { diagnostic, cli: "codex", maxBytes });

  // Calls made after the final token_count still happened: they land in a
  // trailing turn whose usage stays null rather than being dropped.
  if (pendingCalls.size) {
    rows.push({
      ts: endedAt,
      inputTokens: null,
      cacheRead: null,
      cacheCreate: null,
      output: null,
      calls: flushPending(),
    });
  }

  // NATIVE EVIDENCE WINS.  `info.model_context_window` is the window the CLI
  // itself was running (BP-002.02), so it outranks both the model-id table and
  // observation, and the resolver is consulted ONLY when the log never reported
  // one.  In that case the session's own peak context is the best evidence
  // there is (F-008): `last_token_usage.input_tokens` is ONE request's prompt,
  // so a max over the rows is a per-turn context reading and never a sum
  // (F-010).  The rows are already built, so no reordering is needed here.
  const window = windowTokens !== null
    ? { tokens: windowTokens, source: "native" }
    : resolveWindow(model, {
      observedFloor: peakContextTokens(rows),
      diagnostic,
      sessionId: sessionId ?? path.basename(file, ".jsonl"),
    });

  const turns = rows.map((row) => {
    let bytes = null;
    for (const call of row.calls) {
      if (call.id === null) continue;
      const observed = outputBytes.get(call.id);
      if (observed === undefined) continue;
      bytes = (bytes ?? 0) + observed;
    }
    return normalizeTurn({
      ts: row.ts,
      context: {
        inputTokens: row.inputTokens,
        fraction: contextFraction(row.inputTokens, window),
        source: row.inputTokens === null ? "unknown" : "native",
      },
      cacheRead: row.cacheRead,
      cacheCreate: row.cacheCreate,
      output: row.output,
      toolCalls: row.calls,
      toolResultBytes: bytes,
      // Codex exposes no sidechain marker (DIS-004): unknown, never false.
      isSidechain: null,
    });
  });

  return normalizeSession({
    cli: "codex",
    support: "supported",
    sessionId: sessionId ?? path.basename(file, ".jsonl"),
    project: cwd ? path.basename(cwd) : null,
    cwd,
    model,
    window,
    startedAt,
    endedAt,
    turns,
  });
}

export class CodexCollector extends Collector {
  constructor({ root, home, maxBytes, env = process.env } = {}) {
    super({ id: "codex", displayName: "Codex", cli: "codex" });
    this.home = home ?? (env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"));
    this.root = root ?? path.join(this.home, "sessions");
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_FILE_BYTES;
    this.lastDiagnostic = createDiagnostic("codex");
  }

  detect() {
    if (existsSync(this.root)) return { installed: true, paths: [this.root], status: "supported" };
    if (existsSync(this.home)) return { installed: true, paths: [this.home], status: "detection-only" };
    return { installed: false, paths: [], status: "absent" };
  }

  async collect({ since, limit } = {}) {
    const diagnostic = createDiagnostic("codex");
    this.lastDiagnostic = diagnostic;
    if (this.detect().status !== "supported") return [];

    const files = [];
    await this.#walk(this.root, 0, since, diagnostic, files);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const selected = Number.isInteger(limit) && limit > 0 ? files.slice(0, limit) : files;

    const sessions = [];
    for (const entry of selected) {
      try {
        sessions.push(await parseSession(entry.file, { diagnostic, maxBytes: this.maxBytes }));
      } catch (error) {
        diagnostic.filesSkipped += 1;
        diagnostic.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return sessions;
  }

  /** Bounded walk over the YYYY/MM/DD layout. */
  async #walk(dir, depth, since, diagnostic, found) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      diagnostic.errors.push(error instanceof Error ? error.message : String(error));
      return;
    }
    const sinceMs = since === undefined || since === null ? null : new Date(since).getTime();
    const cutoff = Number.isFinite(sinceMs) ? sinceMs : null;

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.#walk(full, depth + 1, since, diagnostic, found);
        continue;
      }
      if (!entry.isFile() || !ROLLOUT.test(entry.name)) continue;
      try {
        const info = await stat(full);
        if (cutoff !== null && info.mtimeMs < cutoff) continue;
        found.push({ file: full, mtimeMs: info.mtimeMs });
      } catch (error) {
        diagnostic.filesSkipped += 1;
        diagnostic.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
}
