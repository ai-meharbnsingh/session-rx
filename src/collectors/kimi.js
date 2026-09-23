import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Collector,
  createDiagnostic,
  normalizeSession,
  normalizeTurn,
  resolveWindow,
  safeReadJsonl,
} from "./base.js";

/** BP-002.08: bound every parser at 50 MB rather than reading a runaway log. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Epoch seconds within [1970, 3238) — anything else is not a Kimi timestamp. */
const MAX_EPOCH_SECONDS = 4e10;

/**
 * SUB-AGENT STREAMS (F-006).  A dispatched Kimi sub-agent does not get its own
 * file: its COMPLETE wire stream is wrapped, event by event, inside the parent
 * log as
 *
 *   {type: "SubagentEvent", payload: {task_tool_call_id, event: {type, payload}}}
 *
 * where `event` is a whole nested wire message with its own type and payload.
 * Measured on this machine, `SubagentEvent` is 33,268 of 92,539 records (36%) —
 * the single most common record type — and every one of them carries the
 * `task_tool_call_id` that identifies which sub-agent it belongs to, so
 * intervals ARE recoverable.  Nothing was exposed before, so the analyzer
 * received dispatched = 0 and BP-003.06 could only report `unknown`.
 *
 * WHAT DOES NOT CHANGE.  A nested `StatusUpdate` is the SUB-AGENT's own gauge —
 * 1,868 of them carry their own `context_usage` — so it stays out of the parent
 * turn exactly as before.  Wave 2B's exclusion was correct and its test still
 * holds; what is added is a destination for that data, not a path into the
 * parent's totals.
 */
const SUBAGENT_EVENT_TYPE = "SubagentEvent";

/**
 * Events that carry no metric; valid protocol traffic, not a skipped line.
 * All of these were observed in real wire logs on this machine.  A type that is
 * neither handled nor listed here is counted as a skipped line so that protocol
 * drift shows up in the diagnostic instead of passing silently.
 */
const IGNORED_EVENTS = new Set([
  "StepBegin",
  "StepInterrupted",
  "ContentPart",
  "ToolCallPart",
  "ApprovalRequest",
  "ApprovalResponse",
  "QuestionRequest",
  "CompactionBegin",
  "CompactionEnd",
  // `SubagentEvent` is ROUTED, not ignored (see SUBAGENT_EVENT below); it stays
  // listed so that one arriving without a `task_tool_call_id` to route it by is
  // still recognised protocol traffic rather than an unreadable line.  Measured
  // on this machine, 0 of 33,268 real SubagentEvents lack that id.
  SUBAGENT_EVENT_TYPE,
]);

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/** Kimi writes float epoch seconds; the normalized contract is an ISO string. */
function isoFromEpochSeconds(value) {
  if (!Number.isFinite(value) || value <= 0 || value >= MAX_EPOCH_SECONDS) return null;
  return new Date(value * 1000).toISOString();
}

/** Sum only observed numbers, so an unobserved counter stays null, never 0. */
function addObserved(current, value) {
  return Number.isFinite(value) ? (current ?? 0) + value : current;
}

function emptyTurn(ts) {
  return {
    ts,
    inputTokens: null,
    fraction: null,
    cacheRead: null,
    cacheCreate: null,
    output: null,
    toolCalls: [],
    toolResultBytes: null,
  };
}

/**
 * @param {object} turn accumulated turn
 * @param {boolean|null} isSidechain `true` only for a turn accumulated from a
 *   nested sub-agent stream, where the wrapping `SubagentEvent` IS the marker.
 *   A parent turn stays `null`: the protocol still says nothing about whether
 *   the parent itself was somebody's sub-agent (DIS-004).
 */
function finalizeTurn(turn, isSidechain = null) {
  return normalizeTurn({
    ts: turn.ts,
    context: {
      inputTokens: turn.inputTokens,
      fraction: turn.fraction,
      // DIS-005: `context_usage` is Kimi's own figure, so the fraction is native.
      source: turn.fraction === null && turn.inputTokens === null ? "unknown" : "native",
    },
    cacheRead: turn.cacheRead,
    cacheCreate: turn.cacheCreate,
    output: turn.output,
    toolCalls: turn.toolCalls,
    toolResultBytes: turn.toolResultBytes,
    isSidechain,
  });
}

/**
 * One turn-accumulating stream: the parent session's, or one sub-agent's.
 *
 * The parent and a sub-agent speak the IDENTICAL wire protocol — the nested
 * `event` is a complete wire message — so both are accumulated by the same code
 * against separate sinks.  Separate sinks are the whole point: a sub-agent's
 * usage lands in the sub-agent's turns and can never reach the parent's,
 * because there is no shared accumulator for it to reach.
 */
function createSink(isSidechain = null) {
  return { turns: [], current: null, firstTs: null, lastTs: null, isSidechain };
}

function flushSink(sink) {
  if (sink.current) sink.turns.push(finalizeTurn(sink.current, sink.isSidechain));
  sink.current = null;
}

function noteTimestamp(sink, ts) {
  if (!ts) return;
  sink.firstTs ??= ts;
  sink.lastTs = ts;
}

/**
 * Real payload shape (EVIDENCE A4, probed): `{type:"function", id,
 * function:{name, arguments}}`.  A flatter `{id, name, args}` is accepted too
 * rather than dropping a call on a protocol revision.
 */
function toolCallOf(payload) {
  if (!payload || typeof payload !== "object") return null;
  const fn = payload.function && typeof payload.function === "object" ? payload.function : {};
  const rawArgs = fn.arguments ?? payload.arguments ?? payload.args;
  let input = rawArgs ?? null;
  if (typeof rawArgs === "string") {
    try {
      input = JSON.parse(rawArgs);
    } catch {
      input = rawArgs;
    }
  }
  return {
    id: typeof payload.id === "string" ? payload.id : typeof payload.tool_call_id === "string" ? payload.tool_call_id : null,
    name: typeof fn.name === "string" ? fn.name : typeof payload.name === "string" ? payload.name : null,
    input,
  };
}

/**
 * Apply one wire event to one sink.
 *
 * @returns {boolean} whether the event type was recognised. `false` is the
 *   caller's cue to count a skipped line, so protocol drift shows up in the
 *   diagnostic instead of passing silently.
 */
function applyEvent(sink, type, payload, ts) {
  switch (type) {
    case "TurnBegin":
      flushSink(sink);
      sink.current = emptyTurn(ts);
      return true;
    case "TurnEnd":
      if (!sink.current) sink.current = emptyTurn(ts);
      flushSink(sink);
      return true;
    case "StatusUpdate": {
      if (!sink.current) sink.current = emptyTurn(ts);
      const fraction = numberOrNull(payload.context_usage);
      if (fraction !== null) sink.current.fraction = fraction;
      const usage = payload.token_usage && typeof payload.token_usage === "object" ? payload.token_usage : {};
      sink.current.inputTokens = addObserved(sink.current.inputTokens, usage.input_other);
      sink.current.output = addObserved(sink.current.output, usage.output);
      sink.current.cacheRead = addObserved(sink.current.cacheRead, usage.input_cache_read);
      sink.current.cacheCreate = addObserved(sink.current.cacheCreate, usage.input_cache_creation);
      return true;
    }
    case "ToolCall": {
      if (!sink.current) sink.current = emptyTurn(ts);
      const call = toolCallOf(payload);
      if (call) sink.current.toolCalls.push(call);
      return true;
    }
    case "ToolResult": {
      if (!sink.current) sink.current = emptyTurn(ts);
      const output = payload.return_value && typeof payload.return_value === "object"
        ? payload.return_value.output
        : undefined;
      // A present-but-empty output is a measured 0; an absent one stays null.
      if (typeof output === "string") {
        sink.current.toolResultBytes = (sink.current.toolResultBytes ?? 0) + Buffer.byteLength(output, "utf8");
      }
      return true;
    }
    default:
      return IGNORED_EVENTS.has(type);
  }
}

/**
 * The id of a sub-agent session: its parent's id, a dot, and the tool call that
 * dispatched it.  Compound for the same reason as Claude's: a `task_tool_call_id`
 * identifies a sub-agent WITHIN one session's log and nothing guarantees it is
 * unique across sessions, while a session id plus that id is unique by
 * construction.  A dot is URL-safe, so the id survives
 * `GET /api/sessions/:sessionId`, which `/` would break.
 */
function subagentSessionId(parentSessionId, taskToolCallId) {
  return `${parentSessionId}.${taskToolCallId}`;
}

export class KimiCollector extends Collector {
  constructor({ home, maxBytes = MAX_FILE_BYTES, subagents = true, env = process.env } = {}) {
    super({ id: "kimi", displayName: "Kimi", cli: "kimi" });
    this.home = home ?? os.homedir();
    // KIMI_CODE_HOME replaces the current data root; KIMI_SHARE_DIR replaces the legacy data root.
    const codeRoot = env.KIMI_CODE_HOME?.trim() || path.join(this.home, ".kimi-code");
    const legacyRoot = env.KIMI_SHARE_DIR?.trim() || path.join(this.home, ".kimi");
    // The new CLI migrates old sessions, so prefer .kimi-code when IDs overlap.
    this.roots = [path.join(codeRoot, "sessions"), path.join(legacyRoot, "sessions")];
    this.root = this.roots[0];
    this.maxBytes = maxBytes;
    this.diagnostic = createDiagnostic("kimi");
    /**
     * Whether nested sub-agent streams are accumulated at all.  Switchable so
     * the no-inflation property can be PROVEN: the same sessions are collected
     * twice and every parent figure must come out identical either way.
     */
    this.subagents = subagents !== false;
    /**
     * Per-session facts BP-002's NormalizedSession has no slot for, keyed by
     * session id and forwarded by `registry.js::collectMany` (F-013). Every
     * collected session gets a row, so `parentSessionId` is present — null on a
     * parent — and "dispatched none" is distinguishable from "cannot say".
     */
    this.sessionMeta = new Map();
    /**
     * Sub-agent sessions from the most recent `parseSessionFile`, which keeps
     * returning the PARENT session alone: its contract is pinned by the wave-2B
     * isolation test, and the sub-agents are a separate channel rather than a
     * change to what a parent parse means.
     */
    this.lastSubagentSessions = [];
  }

  detect() {
    const paths = this.roots.filter((root) => existsSync(root));
    const installed = paths.length > 0;
    return {
      installed,
      paths,
      status: installed ? "supported" : "absent",
    };
  }

  /** `~/.kimi/sessions/<workspace-hash>/<session-uuid>/wire.jsonl`, newest first. */
  sessionFiles() {
    const files = [];
    const seen = new Set();
    for (const root of this.roots) {
      let workspaces;
      try {
        workspaces = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const workspace of workspaces) {
        if (!workspace.isDirectory()) continue;
        const workspaceDir = path.join(root, workspace.name);
        let sessions;
        try {
          sessions = readdirSync(workspaceDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const session of sessions) {
          if (!session.isDirectory() || seen.has(session.name)) continue;
          const file = path.join(workspaceDir, session.name, "wire.jsonl");
          let mtimeMs;
          try {
            mtimeMs = statSync(file).mtimeMs;
          } catch {
            continue;
          }
          seen.add(session.name);
          files.push({ path: file, workspace: workspace.name, sessionId: session.name, mtimeMs });
        }
      }
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * A turn runs from `TurnBegin` to `TurnEnd`; a `StatusUpdate` inside it
   * carries that turn's usage.  `token_usage` is per model call (verified:
   * `input_other` rises and falls between updates), so per-turn totals are the
   * sum of the calls, while `context_usage` is the session's own gauge and the
   * last reading wins.
   */
  async parseSessionFile(file, meta, diagnostic, { subagents } = {}) {
    const readSubagents = subagents === undefined ? this.subagents : subagents !== false;
    const parent = createSink();
    /** One sink per `task_tool_call_id`, in the order the sub-agents first spoke. */
    const bySubagent = new Map();
    let protocolVersion = null;
    this.lastSubagentSessions = [];

    await safeReadJsonl(file, (record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        diagnostic.linesSkipped += 1;
        return;
      }
      if (record.type === "metadata") {
        protocolVersion = record.protocol_version ?? null;
        return;
      }
      const message = record.message;
      if (!message || typeof message !== "object" || typeof message.type !== "string") {
        // A valid JSON line with none of the expected fields.
        diagnostic.linesSkipped += 1;
        return;
      }
      const ts = isoFromEpochSeconds(record.timestamp);
      // The parent session was running while its sub-agents were: its span
      // covers every record in its own log, sub-agent traffic included.
      noteTimestamp(parent, ts);
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};

      // A nested sub-agent event NEVER reaches the parent sink. The sub-agent's
      // own sink is the only accumulator it touches, and the nested event's
      // timestamp is the OUTER record's, which is the only clock the log has.
      if (message.type === SUBAGENT_EVENT_TYPE) {
        const taskId = typeof payload.task_tool_call_id === "string" ? payload.task_tool_call_id : null;
        const nested = payload.event;
        if (!readSubagents || !taskId || !nested || typeof nested !== "object" || typeof nested.type !== "string") {
          // Known protocol traffic that carries no attributable sub-agent.
          return;
        }
        let sink = bySubagent.get(taskId);
        if (!sink) {
          // Every turn in this sink came wrapped in a `SubagentEvent`, which is
          // the marker DIS-004 said the protocol did not provide.
          sink = createSink(true);
          bySubagent.set(taskId, sink);
        }
        noteTimestamp(sink, ts);
        const nestedPayload = nested.payload && typeof nested.payload === "object" ? nested.payload : {};
        if (!applyEvent(sink, nested.type, nestedPayload, ts)) diagnostic.linesSkipped += 1;
        return;
      }

      if (!applyEvent(parent, message.type, payload, ts)) diagnostic.linesSkipped += 1;
    }, { diagnostic, maxBytes: this.maxBytes, cli: this.cli });

    // A session whose last turn was never closed still happened. Measured on
    // real logs, sub-agent streams show 57 TurnBegin against 50 TurnEnd, so this
    // is the normal case for them and not an edge.
    flushSink(parent);
    for (const sink of bySubagent.values()) flushSink(sink);

    const turns = parent.turns;
    const firstTs = parent.firstTs;
    const lastTs = parent.lastTs;

    if (turns.length === 0 && protocolVersion === null) {
      diagnostic.filesSkipped += 1;
      return null;
    }

    this.lastSubagentSessions = [...bySubagent].map(([taskId, sink]) => ({
      taskToolCallId: taskId,
      session: normalizeSession({
        cli: this.cli,
        support: "supported",
        sessionId: subagentSessionId(meta.sessionId, taskId),
        project: meta.workspace,
        cwd: null,
        // Same refusals as the parent below: the log names no model for a
        // sub-agent either, and its `token_usage.input_other` is a sum over
        // model calls, not a context gauge, so no observed floor is offered.
        model: null,
        window: resolveWindow(null),
        startedAt: sink.firstTs,
        endedAt: sink.lastTs,
        turns: sink.turns,
      }),
    }));

    return normalizeSession({
      cli: this.cli,
      support: "supported",
      sessionId: meta.sessionId,
      project: meta.workspace,
      // The wire log records no cwd; the workspace hash is not reversible.
      cwd: null,
      // Verified on this machine: no model id appears in wire.jsonl, context.jsonl
      // or state.json, so the model is unknown rather than guessed.
      model: null,
      // DIS-005: Kimi reports a fraction, not an absolute window.  Turning the
      // fraction into absolute tokens is forbidden, and a null token count with
      // an authoritative-sounding source would misread as a known window.
      //
      // F-008 IS ADOPTED HERE AS A REFUSAL, NOT AS A WINDOW.  Observation can
      // only outrank the table where a per-turn CONTEXT reading exists, and Kimi
      // publishes none: `token_usage.input_other` is summed over the model calls
      // inside a turn (see parseSessionFile), which is a workload total, not a
      // context gauge.  Passing that sum as an observed floor would invent a
      // window out of an inflated number - the F-010 trap that turned a
      // ~41,000-token session into a 402,568-token window elsewhere.  So NO
      // observedFloor is offered, and with no model id in the log either the
      // resolver correctly returns {tokens: null, source: "unknown"}.  The
      // native `context_usage` fraction on each turn is untouched and remains
      // the only context figure Kimi reports.
      window: resolveWindow(null),
      startedAt: firstTs,
      endedAt: lastTs,
      turns,
    });
  }

  /**
   * `limit` bounds the number of SESSIONS THE USER RAN. A sub-agent is evidence
   * about one of those, not another one of them, so it does not consume the
   * limit: a parent admitted by the cap brings its own sub-agents with it.
   * Counting them against the cap would drop a sub-agent whose parent was kept,
   * and a `dispatched` count short by one silently moves the concurrency ratio
   * BP-003.06 is measured against.
   */
  async collect({ since, limit, diagnostic, subagents } = {}) {
    const report = diagnostic ?? createDiagnostic(this.cli);
    this.diagnostic = report;
    this.sessionMeta = new Map();
    const readSubagents = subagents === undefined ? this.subagents : subagents !== false;
    const sinceMs = since instanceof Date ? since.getTime() : Number.isFinite(since) ? since : null;
    const cap = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
    const sessions = [];
    let parents = 0;
    for (const file of this.sessionFiles()) {
      if (parents >= cap) break;
      if (sinceMs !== null && file.mtimeMs < sinceMs) continue;
      const session = await this.parseSessionFile(file.path, file, report, { subagents: readSubagents });
      if (!session) continue;
      parents += 1;
      sessions.push(session);

      const children = this.lastSubagentSessions;
      for (const child of children) sessions.push(child.session);
      this.sessionMeta.set(session.sessionId, {
        sessionId: session.sessionId,
        parentSessionId: null,
        taskToolCallId: null,
        // `null` means sub-agent reading was off, which is not the same claim as
        // an empty list: "not looked for" against "looked for and found none".
        subagentSessionIds: readSubagents ? children.map((child) => child.session.sessionId) : null,
      });
      for (const child of children) {
        this.sessionMeta.set(child.session.sessionId, {
          sessionId: child.session.sessionId,
          parentSessionId: session.sessionId,
          taskToolCallId: child.taskToolCallId,
          subagentSessionIds: [],
        });
      }
    }
    return sessions;
  }
}

export default KimiCollector;
