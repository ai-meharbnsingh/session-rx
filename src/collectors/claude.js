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

const JSONL = /\.jsonl$/i;

/**
 * SUB-AGENT TRANSCRIPTS (F-016).  A dispatched sub-agent does NOT appear in the
 * main transcript.  Its whole run is written to its own file:
 *
 *   <root>/<cwd-slug>/<session-uuid>/subagents/agent-<agentId>.jsonl
 *
 * Measured on this machine: 87 such directories holding 1,105 files, and
 * `isSidechain` is true on every record inside them while it is true on ZERO of
 * the 138,358 records in the main transcripts.  This collector listed that
 * directory level and never opened the files, so the analyzer received
 * dispatched = 0 for every Claude session and BP-003.06 read `unknown` on all
 * five CLIs — the sixth of six specified rules had never produced a verdict.
 */
const SUBAGENT_DIR = "subagents";
const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/i;

/**
 * The id of a sub-agent session: its parent's id, a dot, and its agent id.
 *
 * COMPOUND BY NECESSITY, NOT BY TASTE.  `agentId` alone is not unique: measured
 * over all 1,105 real sub-agent files, 20 agent ids appear under more than one
 * parent, so an `agentId` key would collapse two different sub-agents into one
 * and hand the analyzer a wrong interval.  A dot is the separator because no
 * real agent id contains one (checked across all 1,105) and a session uuid
 * cannot, and because it is URL-safe — these ids travel through
 * `GET /api/sessions/:sessionId`, which `/` would break and `#` would truncate.
 */
function subagentSessionId(parentSessionId, agentId) {
  return `${parentSessionId}.${agentId}`;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Sum only the components the log actually reported.  All components absent
 * stays `null`: a context we cannot read is never reported as zero
 * (DIS-003..DIS-006 — "no evidence" must not render as "all clear").
 */
function sumKnown(...values) {
  const known = values.map(numberOrNull).filter((value) => value !== null);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
}

/** Byte length of a `tool_result` payload; `null` when nothing was recorded. */
function measureBytes(content) {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      if (typeof block === "string") total += Buffer.byteLength(block, "utf8");
      else if (block && typeof block === "object" && typeof block.text === "string") {
        total += Buffer.byteLength(block.text, "utf8");
      } else total += Buffer.byteLength(JSON.stringify(block ?? null), "utf8");
    }
    return total;
  }
  if (typeof content === "object") return Buffer.byteLength(JSON.stringify(content), "utf8");
  return Buffer.byteLength(String(content), "utf8");
}

/**
 * Dedupe key for one `content[]` block.
 *
 * Blocks carrying a tool id are identified by that id.  A re-emitted block
 * with no id keeps its slot in `content[]`, so it is keyed on
 * (position, canonical JSON) instead — see BP-002.09.
 */
function blockKey(block, index) {
  if (block && typeof block.id === "string" && block.id) return `id:${block.id}`;
  return `pos:${index}:${JSON.stringify(block)}`;
}

function toolCallFrom(block) {
  return {
    id: typeof block.id === "string" && block.id ? block.id : null,
    name: typeof block.name === "string" && block.name ? block.name : null,
    input: Object.hasOwn(block, "input") ? block.input : null,
  };
}

/**
 * A `tool_use` block with neither an id nor a name is not evidence that a tool
 * ran, so it is dropped rather than counted as an unnamed call.
 */
function isIdentifiable(block) {
  return Boolean(
    (typeof block.id === "string" && block.id) || (typeof block.name === "string" && block.name),
  );
}

/**
 * PASS ONE: every per-turn figure that does NOT need the window.
 *
 * The context fraction is deliberately absent here.  The window is resolved
 * from the session's own peak context (F-008), which is not knowable until all
 * of these drafts exist, so the fraction belongs to pass two.
 */
function draftTurn(entry, resultBytes) {
  const usage = entry.usage;
  const inputTokens = usage
    ? sumKnown(usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens)
    : null;
  const toolCalls = [...entry.toolCalls.values()];

  // Only bytes we actually matched to a recorded result are counted; an
  // unmatched call leaves the total null rather than pretending it was empty.
  let bytes = null;
  const bytesByCall = [];
  for (const call of toolCalls) {
    const observed = call.id === null ? undefined : resultBytes.get(call.id);
    bytesByCall.push(observed === undefined ? null : observed);
    if (observed === undefined) continue;
    bytes = (bytes ?? 0) + observed;
  }

  return {
    ts: entry.ts,
    inputTokens,
    cacheRead: numberOrNull(usage?.cache_read_input_tokens),
    cacheCreate: numberOrNull(usage?.cache_creation_input_tokens),
    output: numberOrNull(usage?.output_tokens),
    toolCalls,
    toolResultBytes: bytes,
    toolResultBytesByCall: bytesByCall,
    isSidechain: entry.isSidechain,
  };
}

/** PASS TWO: the same turn, once the window it is measured against is known. */
function finalizeTurn(draft, window) {
  return normalizeTurn({
    ts: draft.ts,
    context: {
      inputTokens: draft.inputTokens,
      fraction: contextFraction(draft.inputTokens, window),
      source: draft.inputTokens === null ? "unknown" : "native",
    },
    cacheRead: draft.cacheRead,
    cacheCreate: draft.cacheCreate,
    output: draft.output,
    toolCalls: draft.toolCalls,
    toolResultBytes: draft.toolResultBytes,
    toolResultBytesByCall: draft.toolResultBytesByCall,
    isSidechain: draft.isSidechain,
  });
}

/**
 * Parse one Claude transcript.
 *
 * THE DEDUPE RULE (BP-002.09 / FVA-001).  One logical turn is written across
 * several lines sharing `message.id`:
 *   - `usage` is CUMULATIVE, so a turn's usage is the LAST line for that id.
 *     Summing the lines double-counts the whole turn.
 *   - `tool_use` blocks are NOT cumulative, so a turn's tool calls are the
 *     UNION over its lines, deduped by tool id.
 * Collapsing both the same way once dropped 917 real Bash calls to 560.
 */
async function parseSession(file, { project, diagnostic, maxBytes, sessionId: sessionIdOverride }) {
  const order = [];
  const byId = new Map();
  const resultBytes = new Map();

  let sessionId = null;
  let cwd = null;
  let anyModel = null;
  let mainModel = null;
  let startedAt = null;
  let endedAt = null;
  let synthetic = 0;

  await safeReadJsonl(file, (record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      diagnostic.linesSkipped += 1;
      return;
    }
    if (typeof record.type !== "string") {
      diagnostic.linesSkipped += 1;
      return;
    }

    if (!sessionId && typeof record.sessionId === "string" && record.sessionId) sessionId = record.sessionId;
    if (typeof record.cwd === "string" && record.cwd) cwd = record.cwd;

    const ts = typeof record.timestamp === "string" ? record.timestamp : null;
    if (ts) {
      if (startedAt === null || ts < startedAt) startedAt = ts;
      if (endedAt === null || ts > endedAt) endedAt = ts;
    }

    if (record.type === "assistant") {
      const message = record.message;
      if (!message || typeof message !== "object") {
        diagnostic.linesSkipped += 1;
        return;
      }

      const key = typeof message.id === "string" && message.id
        ? message.id
        : typeof record.uuid === "string" && record.uuid
          ? `uuid:${record.uuid}`
          : `line:${(synthetic += 1)}`;

      let entry = byId.get(key);
      if (!entry) {
        entry = { ts, usage: null, isSidechain: null, toolCalls: new Map() };
        byId.set(key, entry);
        order.push(key);
      }

      // Cumulative: last line for this message.id wins.
      if (message.usage && typeof message.usage === "object") entry.usage = message.usage;
      if (typeof record.isSidechain === "boolean") entry.isSidechain = record.isSidechain;
      if (typeof message.model === "string" && message.model) {
        anyModel = message.model;
        if (record.isSidechain !== true) mainModel = message.model;
      }

      // Not cumulative: union the tool_use blocks across the turn's lines.
      if (Array.isArray(message.content)) {
        message.content.forEach((block, index) => {
          if (!block || typeof block !== "object" || block.type !== "tool_use") return;
          if (!isIdentifiable(block)) return;
          const key2 = blockKey(block, index);
          if (entry.toolCalls.has(key2)) return;
          entry.toolCalls.set(key2, toolCallFrom(block));
        });
      }
      return;
    }

    if (record.type === "user") {
      const message = record.message;
      const content = message && typeof message === "object" ? message.content : null;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
        if (typeof block.tool_use_id !== "string") continue;
        const bytes = measureBytes(block.content);
        if (bytes !== null) resultBytes.set(block.tool_use_id, bytes);
      }
    }
  }, { diagnostic, cli: "claude", maxBytes });

  // WINDOW is not in the log (BP-002.01), and the model-id table is only a
  // PRIOR: a session cannot hold more context than its window, so the session's
  // own peak per-turn context is EVIDENCE that outranks the table (F-008).
  //
  // THE ORDER OF THESE THREE STEPS IS THE WHOLE FIX (F-009).  The peak is only
  // knowable once the turns exist, so turns are DRAFTED first, the window is
  // RESOLVED second, and the per-turn fractions are computed LAST against the
  // resolved window.  Resolving the window before the turns - the shape this
  // file had, with `lookupWindow` above the `order.map` - leaves every fraction
  // on the stale table reading while the test suite stays green: 132/132 passed
  // while real `claude-opus-5` sessions still reported a context fraction of
  // 2.08 against a 200,000 window they had plainly exceeded.
  const model = mainModel ?? anyModel;
  // A sub-agent transcript records its PARENT's id in `sessionId` on every
  // record, so the caller must name the sub-agent's own id; without the
  // override a sub-agent would be indistinguishable from the session that
  // dispatched it and the two would collide in every id-keyed map.
  const id = sessionIdOverride ?? sessionId ?? path.basename(file, ".jsonl");
  const drafts = order.map((key) => draftTurn(byId.get(key), resultBytes));

  // The peak is taken over EVERY turn, sidechain included, and is a max and
  // never a sum (F-010).  Every one of these turns divides by this one window,
  // so a sidechain turn left out of the floor could still be published as a
  // fraction above 1.0 - the exact defect this mechanism exists to remove.
  const window = resolveWindow(model, {
    observedFloor: peakContextTokens(drafts),
    diagnostic,
    sessionId: id,
  });

  return normalizeSession({
    cli: "claude",
    support: "supported",
    sessionId: id,
    project,
    cwd,
    model,
    window,
    startedAt,
    endedAt,
    turns: drafts.map((draft) => finalizeTurn(draft, window)),
  });
}

export class ClaudeCollector extends Collector {
  constructor({ root, home, maxBytes, subagents = true, env = process.env } = {}) {
    super({ id: "claude", displayName: "Claude Code", cli: "claude" });
    this.home = home ?? (env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"));
    this.root = root ?? path.join(this.home, "projects");
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_FILE_BYTES;
    /**
     * Whether sub-agent transcripts are read at all.  Switchable so the
     * no-inflation property can be PROVEN rather than asserted: the same
     * sessions are collected twice, and every parent figure must be identical
     * with sub-agent reading on and off.
     */
    this.subagents = subagents !== false;
    this.lastDiagnostic = createDiagnostic("claude");
    /**
     * Per-session facts BP-002's NormalizedSession has no slot for, keyed by
     * session id and forwarded by `registry.js::collectMany` (F-013).  Every
     * collected session gets a row, so `parentSessionId` is present — as null
     * on a parent — and the analyzer can tell "this CLI publishes a parent
     * linkage and this session dispatched none" apart from "this CLI cannot
     * say".  The first is a measured zero; the second is unknown.
     */
    this.sessionMeta = new Map();
  }

  detect() {
    if (existsSync(this.root)) return { installed: true, paths: [this.root], status: "supported" };
    if (existsSync(this.home)) return { installed: true, paths: [this.home], status: "detection-only" };
    return { installed: false, paths: [], status: "absent" };
  }

  /**
   * `limit` bounds the number of SESSIONS THE USER RAN, and a sub-agent is not
   * one of those — it is evidence about the session that dispatched it.  So the
   * limit is applied to parent transcripts and each selected parent brings its
   * own sub-agents with it.  Slicing the combined list instead would drop a
   * sub-agent whose parent was kept, and a `dispatched` count short by one
   * silently changes the concurrency ratio BP-003.06 is measured against.
   */
  async collect({ since, limit, subagents } = {}) {
    const diagnostic = createDiagnostic("claude");
    this.lastDiagnostic = diagnostic;
    this.sessionMeta = new Map();
    if (this.detect().status !== "supported") return [];

    const readSubagents = subagents === undefined ? this.subagents : subagents !== false;
    const files = await this.#discover(since, diagnostic);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const selected = Number.isInteger(limit) && limit > 0 ? files.slice(0, limit) : files;

    const sessions = [];
    for (const entry of selected) {
      let parent;
      try {
        parent = await parseSession(entry.file, {
          project: entry.project,
          diagnostic,
          maxBytes: this.maxBytes,
        });
      } catch (error) {
        diagnostic.filesSkipped += 1;
        diagnostic.errors.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      sessions.push(parent);

      const childRead = readSubagents
        ? await this.#collectSubagents(entry, parent, diagnostic)
        : { children: [], error: null };
      const children = childRead.children;
      for (const child of children) sessions.push(child.session);

      this.sessionMeta.set(parent.sessionId, {
        sessionId: parent.sessionId,
        parentSessionId: null,
        agentId: null,
        // Read straight off this row, `dispatched` needs no join. `null` means
        // sub-agent reading was off for this run, which is not the same claim
        // as an empty list: the difference is "not looked for" vs "none found".
        subagentSessionIds: readSubagents ? children.map((child) => child.session.sessionId) : null,
        ...(childRead.error ? { subagentReadError: childRead.error } : {}),
      });
      for (const child of children) {
        this.sessionMeta.set(child.session.sessionId, {
          sessionId: child.session.sessionId,
          parentSessionId: parent.sessionId,
          agentId: child.agentId,
          subagentSessionIds: [],
        });
      }
    }
    return sessions;
  }

  /**
   * Every sub-agent this parent dispatched, as its OWN session.
   *
   * NOTHING IS FOLDED INTO THE PARENT.  A sub-agent's turns, context, cache and
   * tool calls are its own gauge; adding them to the session that dispatched it
   * inflates that session's figures, which is the exact error class that once
   * cost this codebase a 1.97x context inflation.  So a sub-agent becomes a
   * sibling session and the link is published on `sessionMeta`, the general
   * shape a collector uses to link a child session to its parent.  The parent
   * object returned by `parseSession` is not touched here.
   */
  async #collectSubagents(entry, parent, diagnostic) {
    const dir = path.join(path.dirname(entry.file), path.basename(entry.file, ".jsonl"), SUBAGENT_DIR);
    let found;
    try {
      found = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // No sub-agent directory is the normal case and is a MEASURED zero, not a
      // failure: this session dispatched none. It is not counted as a skipped
      // file, which would read as data we could not parse.
      if (error?.code === "ENOENT") return { children: [], error: null };
      const reason = error instanceof Error ? error.message : String(error);
      return { children: [], error: `could not read sub-agent directory ${dir}: ${reason}` };
    }

    const children = [];
    let readError = null;
    for (const file of found) {
      if (!file.isFile()) continue;
      const matched = SUBAGENT_FILE.exec(file.name);
      if (!matched) continue;
      const agentId = matched[1];
      const child = path.join(dir, file.name);
      const skippedBefore = diagnostic.linesSkipped;
      const truncatedBefore = diagnostic.truncated.length;
      const errorsBefore = diagnostic.errors.length;
      try {
        const session = await parseSession(child, {
          project: entry.project,
          diagnostic,
          maxBytes: this.maxBytes,
          sessionId: subagentSessionId(parent.sessionId, agentId),
        });
        const incomplete = diagnostic.truncated.length > truncatedBefore
          || diagnostic.linesSkipped > skippedBefore
          || diagnostic.errors.length > errorsBefore;
        if (incomplete) {
          const details = [];
          if (diagnostic.truncated.length > truncatedBefore) details.push("truncated");
          if (diagnostic.linesSkipped > skippedBefore) details.push("malformed or skipped lines");
          if (diagnostic.errors.length > errorsBefore) details.push("read errors");
          readError = readError || `sub-agent file ${child} was incomplete (${details.join(", ")})`;
        }
        children.push({
          agentId,
          session,
        });
      } catch (error) {
        diagnostic.filesSkipped += 1;
        const reason = error instanceof Error ? error.message : String(error);
        diagnostic.errors.push(reason);
        readError = readError || `could not read sub-agent file ${child}: ${reason}`;
      }
    }
    return { children, error: readError };
  }

  /** `<root>/<cwd-slug>/<session-uuid>.jsonl`, newest first. */
  async #discover(since, diagnostic) {
    const sinceMs = since === undefined || since === null ? null : new Date(since).getTime();
    const cutoff = Number.isFinite(sinceMs) ? sinceMs : null;
    const found = [];

    let slugs;
    try {
      slugs = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      diagnostic.errors.push(error instanceof Error ? error.message : String(error));
      return found;
    }

    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const dir = path.join(this.root, slug.name);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        diagnostic.filesSkipped += 1;
        diagnostic.errors.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !JSONL.test(entry.name)) continue;
        const file = path.join(dir, entry.name);
        try {
          const info = await stat(file);
          if (cutoff !== null && info.mtimeMs < cutoff) continue;
          found.push({ file, project: slug.name, mtimeMs: info.mtimeMs });
        } catch (error) {
          diagnostic.filesSkipped += 1;
          diagnostic.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    return found;
  }
}
