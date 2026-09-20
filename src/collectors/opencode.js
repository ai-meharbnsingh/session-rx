import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Collector,
  createDiagnostic,
  contextFraction,
  peakContextTokens,
  resolveWindow,
  normalizeSession,
  normalizeTurn,
} from "./base.js";

/**
 * BP-002.10 / INV-0.001.  `~/.local/share/opencode/opencode.db` also holds the
 * tables `account`, `control_account` and `credential`, which store PLAINTEXT
 * `access_token` / `refresh_token` values for the user's AI provider accounts.
 *
 * Three rules make a leak structurally impossible rather than merely unintended:
 *   1. every table this module reads is on the allowlist below, and nothing else
 *      is reachable - `sqlite_master` and `pragma_*` are deliberately NOT on it,
 *      so this collector cannot even enumerate the schema;
 *   2. every query names its columns explicitly.  `*` is rejected outright, so
 *      the day upstream adds a token column to `session` it cannot be selected;
 *   3. the database is opened read-only through a `mode=ro` URI, so the WAL
 *      write lock is never taken and a running OpenCode cannot be disturbed.
 *
 * `assertAllowedSql` is the single chokepoint: no SQL reaches SQLite without
 * passing it, and every statement issued is recorded in `sqlLog` so a test can
 * assert on the real strings rather than on intent.
 */
export const OPENCODE_TABLE_ALLOWLIST = Object.freeze([
  "session",
  "message",
  "part",
  "project",
  "workspace",
  "session_message",
]);

const ALLOWED = new Set(OPENCODE_TABLE_ALLOWLIST);

/** Named for clarity in the error message; the allowlist is what enforces it. */
const CREDENTIAL_TABLES = /\b(?:account|control_account|credential|permission|session_share|session_input)\b/i;

/** Bounds, not preferences: the live database is ~10 GB. */
const DEFAULT_SESSION_LIMIT = 100;
const MAX_MESSAGES_PER_SESSION = 2000;
const MAX_PARTS_PER_SESSION = 8000;

/**
 * Reject anything that is not a bounded, explicit-column SELECT over an
 * allowlisted table.  Throws rather than returning false: a query that cannot
 * be proven safe is never issued.
 */
export function assertAllowedSql(sql) {
  const text = String(sql);
  if (!/^\s*select\s/i.test(text)) {
    throw new Error("opencode: only SELECT statements may be issued");
  }
  if (text.includes("*")) {
    throw new Error("opencode: `*` is forbidden; every column must be named (BP-002.10)");
  }
  if (text.includes(";")) {
    throw new Error("opencode: a statement may not be chained");
  }
  const referenced = [...text.matchAll(/\b(?:from|join)\s+[`"[]?([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match) => match[1].toLowerCase());
  if (referenced.length === 0) {
    throw new Error("opencode: query names no table");
  }
  for (const table of referenced) {
    if (!ALLOWED.has(table)) {
      throw new Error(`opencode: table \`${table}\` is not on the allowlist (BP-002.10)`);
    }
  }
  if (CREDENTIAL_TABLES.test(text)) {
    // Unreachable while the allowlist holds; kept as a second, independent lock.
    throw new Error("opencode: query mentions a credential-bearing table");
  }
  if (!/\blimit\b/i.test(text)) {
    throw new Error("opencode: every query must be bounded by LIMIT");
  }
  return text;
}

/**
 * Every statement this module can issue, in one place.  `session` is the only
 * unindexed sort (the table has no `time_created` index - verified against the
 * real database) and holds a few hundred rows; the two heavy tables are always
 * entered through `message_session_time_created_id_idx` and `part_session_idx`.
 */
export const OPENCODE_QUERIES = Object.freeze({
  sessions: `select id, project_id, workspace_id, parent_id, slug, directory,
       cost, tokens_input, tokens_output, tokens_reasoning,
       tokens_cache_read, tokens_cache_write, agent, model,
       time_created, time_updated
  from session
 where time_created >= ?
 order by time_created desc
 limit ?`,
  messages: `select id, time_created, time_updated, data
  from message
 where session_id = ?
 order by time_created asc
 limit ?`,
  parts: `select id, message_id, time_created, data
  from part
 where session_id = ?
 order by time_created asc
 limit ?`,
});

function projectQuery(count) {
  const holes = Array.from({ length: count }, () => "?").join(", ");
  return `select id, name, worktree
  from project
 where id in (${holes})
 limit ${count}`;
}

/** Only a finite number is a measurement; everything else is an honest null. */
function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/** OpenCode stores epoch MILLISECONDS (EVIDENCE A5). */
function isoFromMillis(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sumKnown(...values) {
  let total = null;
  for (const value of values) {
    const number = numberOrNull(value);
    if (number === null) continue;
    total = (total ?? 0) + number;
  }
  return total;
}

/**
 * `session.model` is a JSON string `{"id","providerID"}`.  A bare string is
 * accepted as the model id itself; anything else is an unparsed value, counted
 * as skipped rather than guessed at.
 */
function modelIdFrom(raw, diagnostic) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.trim();
  if (!text.startsWith("{") && !text.startsWith("\"")) return text;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    if (parsed && typeof parsed.id === "string" && parsed.id.trim()) return parsed.id.trim();
    return null;
  } catch {
    diagnostic.linesSkipped += 1;
    return null;
  }
}

function parseJsonColumn(raw, diagnostic) {
  if (typeof raw !== "string" || !raw) {
    diagnostic.linesSkipped += 1;
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostic.linesSkipped += 1;
      return null;
    }
    return parsed;
  } catch {
    diagnostic.linesSkipped += 1;
    return null;
  }
}

/**
 * A `part` row with `type:"tool"` carries `{tool, callID, state:{input, output}}`
 * (EVIDENCE A5, confirmed against the real database).  Any other shape yields no
 * call and no byte count - an unrecognised part leaves `toolResultBytes` null
 * rather than asserting an empty result.
 */
function toolCallFromPart(part) {
  if (!part || part.type !== "tool") return null;
  const state = part.state && typeof part.state === "object" ? part.state : null;
  const call = {
    id: typeof part.callID === "string" && part.callID ? part.callID : null,
    name: typeof part.tool === "string" && part.tool ? part.tool : null,
  };
  if (state && Object.hasOwn(state, "input")) call.input = state.input;
  const output = state && typeof state.output === "string" ? state.output : null;
  return { call, bytes: output === null ? null : Buffer.byteLength(output, "utf8") };
}

/**
 * PASS ONE: every per-message figure that does NOT need the window.
 *
 * `inputTokens` is ONE message's prompt - its own `tokens.input` plus the cache
 * it read and wrote.  It is a per-turn CONTEXT reading, which is what makes it
 * usable as an observed floor (F-010); the `session` row's `tokens_input` is a
 * per-session TOTAL and is not.
 */
function draftTurn(row, data, parts) {
  const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens : null;
  const cache = tokens?.cache && typeof tokens.cache === "object" ? tokens.cache : null;
  const cacheRead = numberOrNull(cache?.read);
  const cacheCreate = numberOrNull(cache?.write);
  const inputTokens = tokens === null
    ? null
    : sumKnown(tokens.input, cache?.read, cache?.write);

  const toolCalls = [];
  let toolResultBytes = null;
  for (const part of parts) {
    const found = toolCallFromPart(part);
    if (!found) continue;
    toolCalls.push(found.call);
    if (found.bytes !== null) toolResultBytes = (toolResultBytes ?? 0) + found.bytes;
  }

  const created = numberOrNull(data.time?.created) ?? numberOrNull(row.time_created);
  return {
    ts: isoFromMillis(created),
    inputTokens,
    cacheRead,
    cacheCreate,
    output: numberOrNull(tokens?.output),
    toolCalls,
    toolResultBytes,
  };
}

/** PASS TWO: the same turn, once the window it is measured against is known. */
function finalizeTurn(draft, window) {
  return normalizeTurn({
    ts: draft.ts,
    context: {
      inputTokens: draft.inputTokens,
      fraction: contextFraction(draft.inputTokens, window),
      // OpenCode records its own per-message token counts; nothing is derived.
      source: draft.inputTokens === null ? "unknown" : "native",
    },
    cacheRead: draft.cacheRead,
    cacheCreate: draft.cacheCreate,
    output: draft.output,
    toolCalls: draft.toolCalls,
    toolResultBytes: draft.toolResultBytes,
    // DIS-004: OpenCode links sessions through `session.parent_id` but marks no
    // per-turn sidechain.  A fabricated flag here would let a health rule report
    // a sub-agent concurrency figure the evidence does not support.  The parent
    // linkage is exposed through `sessionMeta` instead.
    isSidechain: null,
  });
}

export class OpenCodeCollector extends Collector {
  constructor({ home = os.homedir(), dbPath, sessionLimit = DEFAULT_SESSION_LIMIT } = {}) {
    super({ id: "opencode", displayName: "OpenCode", cli: "opencode" });
    this.home = home;
    this.dbPath = dbPath ?? path.join(home, ".local", "share", "opencode", "opencode.db");
    this.sessionLimit = sessionLimit;
    this.diagnostic = createDiagnostic("opencode");
    /** Every distinct SQL string issued, for the security assertion in tests. */
    this.sqlLog = [];
    /**
     * Per-session facts that BP-002's NormalizedSession has no slot for: the
     * `session` row's own totals (cheaper and more complete than re-summing a
     * capped message window) and the DIS-004 parent linkage.  Keyed by session id.
     */
    this.sessionMeta = new Map();
  }

  /** `file:<path>?mode=ro` - never rw, so the WAL write lock is never taken. */
  readOnlyUri() {
    const escaped = this.dbPath
      .replace(/%/g, "%25")
      .replace(/\?/g, "%3f")
      .replace(/#/g, "%23");
    return `file:${escaped}?mode=ro`;
  }

  detect() {
    const installed = existsSync(this.dbPath);
    return {
      installed,
      paths: installed ? [this.dbPath] : [],
      status: installed ? "supported" : "absent",
    };
  }

  /** The only way SQL reaches SQLite in this module. */
  run(db, sql, params) {
    const checked = assertAllowedSql(sql);
    if (!this.sqlLog.includes(checked)) this.sqlLog.push(checked);
    return db.prepare(checked).all(...params);
  }

  async collect({ since, limit, diagnostic } = {}) {
    const report = diagnostic ?? createDiagnostic(this.cli);
    this.diagnostic = report;
    this.sessionMeta = new Map();

    if (!existsSync(this.dbPath)) {
      report.filesSkipped += 1;
      return [];
    }

    const sinceMs = since instanceof Date
      ? since.getTime()
      : Number.isFinite(since) ? Number(since) : 0;
    const cap = Number.isFinite(limit) && limit > 0
      ? Math.trunc(limit)
      : this.sessionLimit;

    let db;
    try {
      db = new DatabaseSync(this.readOnlyUri(), { readOnly: true });
    } catch (error) {
      // Missing file, unreadable file, or a stale WAL that read-only recovery
      // cannot open.  Never fatal: the server keeps its other collectors.
      report.filesSkipped += 1;
      report.errors.push(error instanceof Error ? error.message : String(error));
      return [];
    }

    report.filesScanned += 1;
    try {
      return this.readSessions(db, report, sinceMs, cap);
    } catch (error) {
      // "file is not a database", "no such table: session", a corrupt page - all
      // become a diagnostic, never a throw (BP-002.08).
      report.filesSkipped += 1;
      report.errors.push(error instanceof Error ? error.message : String(error));
      return [];
    } finally {
      try { db.close(); } catch { /* already closed or never opened cleanly */ }
    }
  }

  readSessions(db, report, sinceMs, cap) {
    const rows = this.run(db, OPENCODE_QUERIES.sessions, [sinceMs, cap]);
    if (rows.length >= cap) {
      // More sessions exist than were returned; say so rather than imply totality.
      report.truncated.push(`${this.dbPath}#session>${cap}`);
    }
    const names = this.projectNames(db, rows, report);
    const sessions = [];
    for (const row of rows) {
      const session = this.buildSession(db, row, names, report);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  /** One bounded lookup for every project id in the window, not one per session. */
  projectNames(db, rows, report) {
    const ids = [...new Set(rows.map((row) => row.project_id).filter((id) => typeof id === "string" && id))];
    const names = new Map();
    if (ids.length === 0) return names;
    try {
      for (const project of this.run(db, projectQuery(ids.length), ids)) {
        const name = typeof project.name === "string" && project.name
          ? project.name
          : typeof project.worktree === "string" && project.worktree
            ? path.basename(project.worktree)
            : null;
        names.set(project.id, name);
      }
    } catch (error) {
      // A missing `project` table costs a name, not the collection.
      report.errors.push(error instanceof Error ? error.message : String(error));
    }
    return names;
  }

  buildSession(db, row, projectNames, report) {
    if (typeof row.id !== "string" || !row.id) {
      report.linesSkipped += 1;
      return null;
    }

    const messages = this.run(db, OPENCODE_QUERIES.messages, [row.id, MAX_MESSAGES_PER_SESSION]);
    if (messages.length >= MAX_MESSAGES_PER_SESSION) {
      report.truncated.push(`${this.dbPath}#message:${row.id}`);
    }
    const partsByMessage = this.partsByMessage(db, row.id, report);

    let model = modelIdFrom(row.model, report);
    const turnRows = [];
    for (const message of messages) {
      const data = parseJsonColumn(message.data, report);
      if (!data) continue;
      if (data.role !== "assistant") continue;
      // Only an assistant message carries tokens, modelID and timing; a user
      // message would add an empty turn and dilute every per-turn average.
      turnRows.push({ row: message, data });
      if (!model && typeof data.modelID === "string" && data.modelID.trim()) {
        model = data.modelID.trim();
      }
    }

    // TWO PASSES, in this order (F-008/F-009): draft the turns, THEN resolve the
    // window from the model-id map (BP-002.05) AND the session's own peak
    // context, THEN divide.  Real ids such as `nemotron-3.5-lightning-free` map
    // to nothing - 401 of 401 real sessions on this machine - so without the
    // observed floor every OpenCode context reading is simply `unknown`.
    const drafts = turnRows.map(({ row: messageRow, data }) =>
      draftTurn(messageRow, data, partsByMessage.get(messageRow.id) ?? []));

    // F-010, THE TRAP THIS COLLECTOR IS MOST EXPOSED TO: the observed floor is
    // the MAX of the per-turn readings and never a sum.  `row.tokens_input`
    // just above is a per-session TOTAL - 402,568 across 18 turns in a real
    // database - so feeding it in would invent a 402,568-token window for a
    // session whose true per-turn peak is ~41,000, the same inflation as summing
    // cumulative usage.  Only `drafts` are observed, and only with a max.
    const window = resolveWindow(model, {
      source: "model-map",
      observedFloor: peakContextTokens(drafts),
      diagnostic: report,
      sessionId: row.id,
    });

    const turns = drafts.map((draft) => finalizeTurn(draft, window));

    const directory = typeof row.directory === "string" && row.directory ? row.directory : null;
    const project = projectNames.get(row.project_id)
      ?? (directory ? path.basename(directory) : null)
      ?? (typeof row.slug === "string" && row.slug ? row.slug : null);

    this.sessionMeta.set(row.id, {
      sessionId: row.id,
      // DIS-004: the linkage is reported; no concurrency figure is derived from it.
      parentSessionId: typeof row.parent_id === "string" && row.parent_id ? row.parent_id : null,
      projectId: typeof row.project_id === "string" && row.project_id ? row.project_id : null,
      workspaceId: typeof row.workspace_id === "string" && row.workspace_id ? row.workspace_id : null,
      slug: typeof row.slug === "string" && row.slug ? row.slug : null,
      agent: typeof row.agent === "string" && row.agent ? row.agent : null,
      // The `session` row's own totals: one row instead of a message scan.
      totals: {
        cost: numberOrNull(row.cost),
        input: numberOrNull(row.tokens_input),
        output: numberOrNull(row.tokens_output),
        reasoning: numberOrNull(row.tokens_reasoning),
        cacheRead: numberOrNull(row.tokens_cache_read),
        cacheWrite: numberOrNull(row.tokens_cache_write),
      },
    });

    return normalizeSession({
      cli: this.cli,
      support: "supported",
      sessionId: row.id,
      project,
      cwd: directory,
      model,
      window,
      startedAt: isoFromMillis(numberOrNull(row.time_created)),
      endedAt: isoFromMillis(numberOrNull(row.time_updated)),
      turns,
    });
  }

  /** Entered through `part_session_idx`: one bounded query per session. */
  partsByMessage(db, sessionId, report) {
    const grouped = new Map();
    let rows;
    try {
      rows = this.run(db, OPENCODE_QUERIES.parts, [sessionId, MAX_PARTS_PER_SESSION]);
    } catch (error) {
      // A missing `part` table costs tool calls, not the session.
      report.errors.push(error instanceof Error ? error.message : String(error));
      return grouped;
    }
    if (rows.length >= MAX_PARTS_PER_SESSION) {
      report.truncated.push(`${this.dbPath}#part:${sessionId}`);
    }
    for (const row of rows) {
      const data = parseJsonColumn(row.data, report);
      if (!data) continue;
      const key = typeof row.message_id === "string" ? row.message_id : "";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(data);
    }
    return grouped;
  }
}

export default OpenCodeCollector;
