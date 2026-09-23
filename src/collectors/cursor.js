import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Collector,
  createDiagnostic,
  lookupWindow,
  normalizeSession,
  normalizeTurn,
  safeReadJsonl,
} from "./base.js";

export const CURSOR_TABLE_ALLOWLIST = Object.freeze(["meta", "blobs"]);
const ALLOWED_TABLES = new Set(CURSOR_TABLE_ALLOWLIST);
const SESSION_LIMIT = 200;

export function assertAllowedSql(sql) {
  const text = String(sql);
  if (!/^\s*select\s/i.test(text)) throw new Error("cursor: only SELECT statements may be issued");
  if (text.includes("*")) throw new Error("cursor: `*` is forbidden");
  if (text.includes(";")) throw new Error("cursor: a statement may not be chained");
  const tables = [...text.matchAll(/\b(?:from|join)\s+[`"[]?([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match) => match[1].toLowerCase());
  if (tables.length === 0) throw new Error("cursor: query names no table");
  for (const table of tables) {
    if (!ALLOWED_TABLES.has(table)) throw new Error(`cursor: table \`${table}\` is not on the allowlist`);
  }
  if (!/\blimit\b/i.test(text)) throw new Error("cursor: every query must be bounded by LIMIT");
  return text;
}

const QUERIES = Object.freeze({
  meta: "SELECT value FROM meta WHERE key = '0' LIMIT 1",
  blob: "SELECT data FROM blobs WHERE id = ? LIMIT 1",
});

function isoFromMillis(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function readVarint(bytes, offset) {
  let value = 0n;
  let shift = 0n;
  for (let index = offset; index < bytes.length && index < offset + 10; index += 1) {
    const byte = bytes[index];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return {
        value: value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null,
        next: index + 1,
      };
    }
    shift += 7n;
  }
  return null;
}

function readLengthDelimited(bytes, offset) {
  const length = readVarint(bytes, offset);
  if (!length || length.value === null || length.value < 0) return null;
  const end = length.next + length.value;
  if (end > bytes.length) return null;
  return { value: bytes.subarray(length.next, end), next: end };
}

function skipField(bytes, offset, wireType) {
  if (wireType === 0) return readVarint(bytes, offset)?.next ?? null;
  if (wireType === 1) return offset + 8 <= bytes.length ? offset + 8 : null;
  if (wireType === 2) return readLengthDelimited(bytes, offset)?.next ?? null;
  if (wireType === 5) return offset + 4 <= bytes.length ? offset + 4 : null;
  return null;
}

function decodeNested(bytes, wanted) {
  const result = {};
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (!key || key.value === null) return null;
    offset = key.next;
    const field = key.value >>> 3;
    const wireType = key.value & 7;
    if (wanted.has(field)) {
      if (wanted.get(field) === "varint" && wireType === 0) {
        const parsed = readVarint(bytes, offset);
        if (!parsed) return null;
        result[field] = parsed.value;
        offset = parsed.next;
        continue;
      }
      if (wanted.get(field) === "message" && wireType === 2) {
        const parsed = readLengthDelimited(bytes, offset);
        if (!parsed) return null;
        result[field] = parsed.value;
        offset = parsed.next;
        continue;
      }
    }
    const next = skipField(bytes, offset, wireType);
    if (next === null) return null;
    offset = next;
  }
  return result;
}

function decodeConversationState(data) {
  if (!data) return null;
  const turns = [];
  const timings = [];
  let tokenDetails = null;
  let offset = 0;
  while (offset < data.length) {
    const key = readVarint(data, offset);
    if (!key || key.value === null) return null;
    offset = key.next;
    const field = key.value >>> 3;
    const wireType = key.value & 7;
    if (field === 8 && wireType === 2) {
      const value = readLengthDelimited(data, offset);
      if (!value) return null;
      turns.push(value.value);
      offset = value.next;
      continue;
    }
    if (field === 14 && wireType === 2) {
      const value = readLengthDelimited(data, offset);
      if (!value) return null;
      const timing = decodeNested(value.value, new Map([[1, "varint"], [2, "varint"]]));
      if (!timing) return null;
      timings.push({ durationMs: finiteNumber(timing[1]), timestampMs: finiteNumber(timing[2]) });
      offset = value.next;
      continue;
    }
    if (field === 5 && wireType === 2) {
      const value = readLengthDelimited(data, offset);
      if (!value) return null;
      const details = decodeNested(value.value, new Map([[1, "varint"], [2, "varint"]]));
      if (!details) return null;
      tokenDetails = {
        usedTokens: finiteNumber(details[1]),
        maxTokens: finiteNumber(details[2]),
      };
      offset = value.next;
      continue;
    }
    const next = skipField(data, offset, wireType);
    if (next === null) return null;
    offset = next;
  }
  return { turnCount: turns.length, timings, tokenDetails };
}

function decodeMeta(raw) {
  if (typeof raw !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(raw)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "hex").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // Security boundary: do this before reading any surviving metadata.
    delete parsed.blobEncryptionKey;
    return parsed;
  } catch {
    return null;
  }
}

function safeEntries(directory) {
  try { return readdirSync(directory, { withFileTypes: true }); } catch { return []; }
}

function sanitizeProjectPath(value) {
  return String(value).replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

export function transcriptPaths(dataDir, cwd, agentId) {
  const projects = path.join(dataDir, "projects");
  const simpleProject = path.join(projects, sanitizeProjectPath(cwd));
  let boundedProject = simpleProject;
  if (boundedProject.length > 92) {
    const prefix = `${projects}${path.sep}`;
    const clamp = Math.max(prefix.length + 1, Math.min(84, boundedProject.length));
    boundedProject = `${boundedProject.slice(0, clamp)}-${createHash("sha256")
      .update(boundedProject).digest("hex").slice(0, 7)}`;
  }
  return [
    path.join(boundedProject, "agent-transcripts", agentId, `${agentId}.jsonl`),
    path.join(simpleProject, "agent-transcripts", agentId, `${agentId}.jsonl`),
    path.join(simpleProject, "agent-transcripts", `${agentId}.jsonl`),
  ];
}

async function readTranscript(filePath, diagnostic) {
  const turns = [];
  let currentTurn = null;
  const beforeSkipped = diagnostic.linesSkipped;
  await safeReadJsonl(filePath, (record) => {
    if (!record || typeof record !== "object" || !Object.hasOwn(record, "role")) return;
    if (record.role === "user") {
      currentTurn = [];
      turns.push(currentTurn);
    }
    const parts = record.message?.content;
    if (!Array.isArray(parts) || !currentTurn) return;
    for (const part of parts) {
      if (part?.type === "tool_use" && typeof part.name === "string") {
        currentTurn.push({ id: null, name: part.name, input: part.input ?? null });
      }
    }
  }, { diagnostic, cli: "cursor" });
  if (diagnostic.linesSkipped > beforeSkipped) {
    diagnostic.errors.push(`${filePath}: malformed transcript line(s) skipped`);
  }
  return turns;
}

async function transcriptToolCalls(dataDir, cwd, agentId, diagnostic) {
  if (typeof cwd !== "string" || !cwd || typeof agentId !== "string" || !agentId) return null;
  const candidates = transcriptPaths(dataDir, cwd, agentId);
  const filePath = candidates.find((candidate) => existsSync(candidate));
  if (!filePath) {
    diagnostic.filesSkipped += 1;
    diagnostic.errors.push(`${candidates[0]}: Cursor transcript not found`);
    return [];
  }
  return readTranscript(filePath, diagnostic);
}

function storePaths(configDir) {
  const found = [];
  const chats = path.join(configDir, "chats");
  for (const cwdEntry of safeEntries(chats)) {
    if (!cwdEntry.isDirectory()) continue;
    const cwdDir = path.join(chats, cwdEntry.name);
    for (const idEntry of safeEntries(cwdDir)) {
      if (!idEntry.isDirectory()) continue;
      const candidate = path.join(cwdDir, idEntry.name, "store.db");
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  const acp = path.join(configDir, "acp-sessions");
  for (const idEntry of safeEntries(acp)) {
    if (!idEntry.isDirectory()) continue;
    const candidate = path.join(acp, idEntry.name, "store.db");
    if (existsSync(candidate)) found.push(candidate);
  }
  return found;
}

export class CursorCollector extends Collector {
  constructor({ home = os.homedir(), env = process.env } = {}) {
    super({ id: "cursor", displayName: "Cursor CLI", cli: "cursor" });
    this.home = home;
    this.env = env;
    const configRoot = env.CURSOR_CONFIG_DIR?.trim();
    const xdgRoot = env.XDG_CONFIG_HOME?.trim();
    this.configDir = configRoot || (xdgRoot ? path.join(xdgRoot, "cursor") : path.join(home, ".cursor"));
    this.dataDir = env.CURSOR_DATA_DIR?.trim() || path.join(home, ".cursor");
    this.sqlLog = [];
  }

  readOnlyUri(filePath) {
    const escaped = filePath.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23");
    return `file:${escaped}?mode=ro`;
  }

  detect() {
    const paths = storePaths(this.configDir);
    const installed = existsSync(this.configDir);
    return {
      installed,
      paths,
      status: paths.length > 0 ? "supported" : installed ? "detection-only" : "absent",
    };
  }

  run(db, sql, params = []) {
    const checked = assertAllowedSql(sql);
    if (!this.sqlLog.includes(checked)) this.sqlLog.push(checked);
    return db.prepare(checked).all(...params);
  }

  readSidecar(filePath) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  async collect({ limit, diagnostic } = {}) {
    const report = diagnostic ?? createDiagnostic(this.cli);
    this.diagnostic = report;
    const allPaths = storePaths(this.configDir);
    const paths = allPaths.slice(0, Number.isFinite(limit) && limit > 0
      ? Math.min(SESSION_LIMIT, Math.trunc(limit)) : SESSION_LIMIT);
    if (allPaths.length > paths.length) report.truncated.push(`${this.configDir}#sessions>${paths.length}`);
    const sessions = [];
    for (const dbPath of paths) {
      let db;
      try {
        db = new DatabaseSync(this.readOnlyUri(dbPath), { readOnly: true });
        report.filesScanned += 1;
        const metaRows = this.run(db, QUERIES.meta);
        const metadata = decodeMeta(metaRows[0]?.value);
        if (!metadata || typeof metadata.agentId !== "string" || !metadata.agentId) {
          report.linesSkipped += 1;
          continue;
        }
        const sidecar = this.readSidecar(path.join(path.dirname(dbPath), "meta.json"));
        const rootId = typeof metadata.latestRootBlobId === "string" && /^[0-9a-f]+$/i.test(metadata.latestRootBlobId)
          ? metadata.latestRootBlobId : null;
        let state = null;
        if (rootId) {
          const blobRows = this.run(db, QUERIES.blob, [rootId]);
          state = decodeConversationState(blobRows[0]?.data);
        }
        if (rootId && !state) report.linesSkipped += 1;
        const timings = state?.timings ?? [];
        const transcriptTurns = await transcriptToolCalls(this.dataDir, sidecar.cwd, metadata.agentId, report);
        const count = timings.length > 0
          ? timings.length
          : (transcriptTurns?.length > 0 ? transcriptTurns.length : (state?.turnCount ?? 0));
        const alignedToolCalls = Array.from({ length: count }, () => []);
        if (transcriptTurns !== null && transcriptTurns.length > 0) {
          for (let index = 0; index < transcriptTurns.length && index < count; index += 1) {
            alignedToolCalls[index].push(...transcriptTurns[index]);
          }
          if (transcriptTurns.length > count && count > 0) {
            alignedToolCalls[count - 1].push(...transcriptTurns.slice(count).flat());
          }
        }
        const model = typeof metadata.lastUsedModel === "string" && metadata.lastUsedModel ? metadata.lastUsedModel : null;
        const nativeMax = state?.tokenDetails?.maxTokens;
        const window = Number.isFinite(nativeMax) && nativeMax > 0
          ? { tokens: nativeMax, source: "native" }
          : lookupWindow(model);
        const turns = Array.from({ length: count }, (_, index) => normalizeTurn({
          ts: isoFromMillis(timings[index]?.timestampMs),
          context: { inputTokens: null, fraction: null, source: "unknown" },
          cacheRead: null,
          cacheCreate: null,
          output: null,
          toolCalls: alignedToolCalls[index] ?? [],
          toolResultBytes: null,
        }));
        sessions.push(normalizeSession({
          cli: this.cli,
          support: "supported",
          sessionId: metadata.agentId,
          project: typeof sidecar.cwd === "string" ? path.basename(sidecar.cwd) : null,
          cwd: typeof sidecar.cwd === "string" ? sidecar.cwd : null,
          model,
          window,
          startedAt: isoFromMillis(finiteNumber(metadata.createdAt)),
          endedAt: isoFromMillis(finiteNumber(sidecar.updatedAtMs)),
          turns,
        }));
      } catch (error) {
        report.filesSkipped += 1;
        report.errors.push(error instanceof Error ? error.message : String(error));
      } finally {
        try { db?.close(); } catch { /* best effort */ }
      }
    }
    return sessions;
  }
}

export default CursorCollector;
