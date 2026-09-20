import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Collector,
  createDiagnostic,
  peakContextTokens,
  resolveWindow,
  normalizeSession,
  normalizeTurn,
  safeReadJsonl,
} from "./base.js";

/** BP-002.08: bound every parser at 50 MB rather than reading a runaway log. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const SESSION_FILE = /^session-.+\.jsonl$/;

/** Only a finite number is a measurement; everything else is an honest null. */
function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function isoOrNull(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * `~/.gemini/antigravity-cli/history.jsonl` records are UI command history
 * ({display, timestamp, workspace, conversationId, type}) with no tokens.  They
 * are not chat messages and must never be mistaken for session turns.
 */
function isCommandHistoryRecord(record) {
  return typeof record?.display === "string"
    && typeof record?.workspace === "string"
    && record.content === undefined
    && record.tokens === undefined;
}

function isHeaderRecord(record) {
  return typeof record?.sessionId === "string"
    && (record.projectHash !== undefined || record.startTime !== undefined || record.kind !== undefined);
}

/**
 * A message becomes a normalized turn when it is a model reply or carries
 * measurable work.  `user` / `info` records carry no usage and would only add
 * empty turns that dilute every per-turn average.
 */
function isTurnRecord(message) {
  if (!message || typeof message !== "object") return false;
  if (message.type === "gemini") return true;
  if (message.tokens && typeof message.tokens === "object") return true;
  return Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
}

function toolCallsOf(message) {
  if (!Array.isArray(message.toolCalls)) return [];
  return message.toolCalls
    .filter((call) => call && typeof call === "object")
    .map((call) => ({
      id: typeof call.id === "string" ? call.id : null,
      name: typeof call.name === "string" ? call.name : null,
      // Gemini names the argument bag `args`; the normalized contract is `input`.
      input: Object.hasOwn(call, "args") ? call.args : null,
    }));
}

function turnOf(message) {
  const tokens = message.tokens && typeof message.tokens === "object" ? message.tokens : {};
  const inputTokens = numberOrNull(tokens.input);
  return normalizeTurn({
    ts: isoOrNull(message.timestamp),
    context: {
      inputTokens,
      // DIS-005 style honesty in reverse: Gemini reports absolute tokens and no
      // fraction.  The fraction is the analyzer's derivation, not the parser's.
      fraction: null,
      source: inputTokens === null ? "unknown" : "native",
    },
    cacheRead: numberOrNull(tokens.cached),
    // Gemini reports no cache-creation figure at all.  BP-002.03: null, not 0.
    cacheCreate: null,
    output: numberOrNull(tokens.output),
    toolCalls: toolCallsOf(message),
    // DIS-006: Gemini records carry no recoverable tool-result byte length.
    // Never infer bytes from token counts; the large-result rule stays unknown.
    toolResultBytes: null,
    // DIS-004: Gemini evidence establishes no sub-agent interval marker.
    isSidechain: null,
  });
}

export class GeminiCollector extends Collector {
  constructor({ home = os.homedir(), maxBytes = MAX_FILE_BYTES } = {}) {
    super({ id: "gemini", displayName: "Gemini CLI", cli: "gemini" });
    this.home = home;
    this.root = path.join(home, ".gemini", "tmp");
    this.maxBytes = maxBytes;
    this.diagnostic = createDiagnostic("gemini");
  }

  detect() {
    const installed = existsSync(this.root);
    return {
      installed,
      paths: installed ? [this.root] : [],
      status: installed ? "supported" : "absent",
    };
  }

  /** `~/.gemini/tmp/<project-slug>/chats/session-<ISO>-<id>.jsonl`, newest first. */
  sessionFiles() {
    let projects;
    try {
      projects = readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = [];
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const chats = path.join(this.root, project.name, "chats");
      let entries;
      try {
        entries = readdirSync(chats, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
        const file = path.join(chats, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        files.push({ path: file, project: project.name, mtimeMs });
      }
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * One file holds two record forms (EVIDENCE A3): a mongo-style
   * `{"$set":{"messages":[...]}}` full snapshot, and bare message records.
   * Messages are unioned by id with last-wins, so a snapshot that re-states
   * messages already seen cannot double-count turns.
   * Returns null when the file is not a session log at all.
   */
  async parseSessionFile(file, diagnostic) {
    const messages = new Map();
    const endStamps = [];
    let header = null;
    let recordIndex = 0;
    let positional = 0;

    const addMessage = (message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        diagnostic.linesSkipped += 1;
        return;
      }
      if (isCommandHistoryRecord(message)) {
        diagnostic.linesSkipped += 1;
        return;
      }
      if (message.content === undefined && message.tokens === undefined
        && message.toolCalls === undefined && message.type === undefined) {
        // A valid JSON line with none of the expected fields.
        diagnostic.linesSkipped += 1;
        return;
      }
      // An id-less record keeps its own slot rather than colliding with others.
      const key = typeof message.id === "string" && message.id
        ? `id:${message.id}`
        : `pos:${positional++}`;
      messages.set(key, message);
    };

    await safeReadJsonl(file, (record) => {
      recordIndex += 1;
      if (isHeaderRecord(record)) {
        // A header is re-written mid-file when the CLI resumes a chat; the first
        // one identifies the session and the later ones only move the clock.
        header ??= record;
        endStamps.push(isoOrNull(record.lastUpdated));
        return;
      }
      const snapshot = record && typeof record === "object" ? record.$set : undefined;
      if (snapshot && typeof snapshot === "object") {
        let understood = false;
        if (Array.isArray(snapshot.messages)) {
          // An empty snapshot adds nothing; it never erases what was seen.
          for (const message of snapshot.messages) addMessage(message);
          understood = true;
        }
        if (typeof snapshot.lastUpdated === "string") {
          // The commonest delta op in a real log: a clock bump, not lost data.
          endStamps.push(isoOrNull(snapshot.lastUpdated));
          understood = true;
        }
        if (!understood) diagnostic.linesSkipped += 1;
        return;
      }
      addMessage(record);
    }, { diagnostic, maxBytes: this.maxBytes, cli: this.cli });

    const ordered = [...messages.values()];
    const turnRecords = ordered.filter(isTurnRecord);
    if (!header?.sessionId && turnRecords.length === 0) {
      // Not a session log (for example the antigravity-cli command history).
      diagnostic.filesSkipped += 1;
      return null;
    }
    // A file WITH a header and no turn record still becomes a session, and
    // deliberately so: the chat existed, its start time is real evidence, and a
    // parser that dropped it would be deciding for the reader what counts as
    // use.  It is also the common case here — Gemini writes the header and a
    // session_context user message the moment a chat opens, which is why 250 of
    // the newest 250 real session files on this machine hold no turn at all.
    // A count of 250 that means "250 chats opened, none of them used" is
    // misleading unless something says so, so the per-CLI note in
    // `src/analyzer/health.js` publishes the turn-less share (see
    // `emptySessionsNote`).  The disclosure lives there; the scan is unchanged.

    const stamps = ordered.map((message) => isoOrNull(message.timestamp)).filter(Boolean).sort();
    // Normalized ISO strings compare correctly as strings.
    const lastSeen = [...stamps, ...endStamps.filter(Boolean)].sort().pop() ?? null;
    const model = [...turnRecords].reverse().find((message) => typeof message.model === "string" && message.model)?.model ?? null;

    // The window is not in a Gemini log, so the model-id MAP (BP-002.03) is a
    // PRIOR and the session's own peak per-turn context is evidence that
    // outranks it (F-008).  `message.tokens.input` is one request's prompt, so
    // the peak is a max over per-turn readings and never a sum (F-010).  The
    // turn records are already parsed, so the ordering trap does not arise.
    const window = resolveWindow(model, {
      source: "model-map",
      observedFloor: peakContextTokens(
        turnRecords.map((message) => ({ inputTokens: numberOrNull(message.tokens?.input) })),
      ),
      diagnostic,
      sessionId: header?.sessionId ?? path.basename(file, ".jsonl"),
    });
    return normalizeSession({
      cli: this.cli,
      support: "supported",
      sessionId: header?.sessionId ?? path.basename(file, ".jsonl"),
      project: path.basename(path.dirname(path.dirname(file))),
      // The log stores a project hash and a prose workspace listing, not a cwd.
      cwd: null,
      model,
      window,
      startedAt: isoOrNull(header?.startTime) ?? stamps[0] ?? null,
      endedAt: lastSeen,
      turns: turnRecords.map(turnOf),
    });
  }

  async collect({ since, limit, diagnostic } = {}) {
    const report = diagnostic ?? createDiagnostic(this.cli);
    this.diagnostic = report;
    const sinceMs = since instanceof Date ? since.getTime() : Number.isFinite(since) ? since : null;
    const cap = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
    const sessions = [];
    for (const file of this.sessionFiles()) {
      if (sessions.length >= cap) break;
      if (sinceMs !== null && file.mtimeMs < sinceMs) continue;
      const session = await this.parseSessionFile(file.path, report);
      if (session) sessions.push(session);
    }
    return sessions;
  }
}

export default GeminiCollector;
