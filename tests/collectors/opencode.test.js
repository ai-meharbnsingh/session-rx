import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createDiagnostic } from "../../src/collectors/base.js";
import {
  assertAllowedSql,
  OPENCODE_QUERIES,
  OPENCODE_TABLE_ALLOWLIST,
  OpenCodeCollector,
} from "../../src/collectors/opencode.js";
import { buildFixtureDb, buildTablelessDb, PLANTED_SECRETS } from "../fixtures/opencode/build-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
/** A plain-text file sitting where the database belongs. */
const TEXT_DB_HOME = path.join(here, "..", "fixtures", "opencode", "textdb");

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "session-rx-opencode-"));
}

/** Tests never read the real home directory or the real 10 GB database. */
const FIXTURE_HOME = scratch();
const FIXTURE_DB = buildFixtureDb(FIXTURE_HOME);

function collector(home = FIXTURE_HOME, options = {}) {
  return new OpenCodeCollector({ home, ...options });
}

async function sessionsById() {
  const found = await collector().collect();
  return new Map(found.map((session) => [session.sessionId, session]));
}

test("detect reports supported only when the OpenCode database exists", () => {
  assert.deepEqual(collector().detect(), {
    installed: true,
    paths: [FIXTURE_DB],
    status: "supported",
  });
  assert.deepEqual(collector(scratch()).detect(), {
    installed: false,
    paths: [],
    status: "absent",
  });
});

test("the read-only URI is a mode=ro file URI, never rw", () => {
  const uri = collector().readOnlyUri();
  assert.ok(uri.startsWith("file:"), uri);
  assert.ok(uri.endsWith("?mode=ro"), uri);
  assert.ok(!/mode=rw/.test(uri), uri);
});

test("collect returns sessions newest first", async () => {
  const sessions = await collector().collect();
  assert.deepEqual(sessions.map((session) => session.sessionId), [
    "ses_child", "ses_mapped", "ses_unmapped", "ses_nulls", "ses_nomsg",
  ]);
  for (const session of sessions) {
    assert.equal(session.cli, "opencode");
    assert.equal(session.support, "supported");
  }
});

test("session row fields become project, cwd, model, window and ISO timestamps", async () => {
  const session = (await sessionsById()).get("ses_mapped");
  assert.equal(session.project, "alpha-app");
  assert.equal(session.cwd, "/Users/demo/alpha");
  assert.equal(session.model, "claude-sonnet-4-5");
  // BP-002.05: the window comes from a model-id map, not the database.
  assert.deepEqual(session.window, { tokens: 200000, source: "model-map" });
  assert.equal(session.startedAt, new Date(1700000300000).toISOString());
  assert.equal(session.endedAt, new Date(1700000400000).toISOString());
});

test("a project without a name falls back to its worktree basename", async () => {
  assert.equal((await sessionsById()).get("ses_unmapped").project, "beta");
});

test("F-008/F-014: an unmapped model id falls back to the observed floor, with no fraction", async () => {
  const session = (await sessionsById()).get("ses_unmapped");
  assert.equal(session.model, "nemotron-3.5-lightning-free");

  // CONTRACT CHANGE (orchestrator ruling F-008): this read
  // {tokens: null, source: "unknown"}. Every model id in the real OpenCode
  // database is a free-tier id that maps to nothing - 401 of 401 sessions - so
  // the map alone leaves every OpenCode context rule blind. The session itself
  // is evidence: it held 402,568 tokens of context in one message, so its window
  // is AT LEAST that. Guessing is still forbidden; measuring is not.
  assert.deepEqual(session.window, { tokens: 402568, source: "observed-floor" });

  // F-014: unchanged and now load-bearing - at a floor the fraction is 1.0 by
  // construction, so it is never published.
  assert.equal(session.turns[0].context.fraction, null);
});

test("turns come from assistant messages only; a user message adds no turn", async () => {
  const session = (await sessionsById()).get("ses_mapped");
  assert.equal(session.turns.length, 3);
});

test("a turn carries native token counts, tool calls and result bytes", async () => {
  const [turn] = (await sessionsById()).get("ses_mapped").turns;
  assert.equal(turn.ts, new Date(1700000300200).toISOString());
  // 100 input + 5000 cache read + 300 cache write.
  assert.deepEqual(turn.context, {
    inputTokens: 5400,
    fraction: 5400 / 200000,
    source: "native",
  });
  assert.equal(turn.cacheRead, 5000);
  assert.equal(turn.cacheCreate, 300);
  assert.equal(turn.output, 20);
  assert.deepEqual(turn.toolCalls, [
    { id: "call-1", name: "bash", input: { command: "echo hello world" } },
    { id: "call-2", name: "read", input: { path: "/tmp/x" } },
  ]);
  // Only the completed call has output: "hello world" is 11 bytes.
  assert.equal(turn.toolResultBytes, 11);
  // DIS-004: OpenCode marks no per-turn sidechain, so this is never fabricated.
  assert.equal(turn.isSidechain, null);
});

test("a recorded zero stays zero; an absent tokens object stays null", async () => {
  const turns = (await sessionsById()).get("ses_mapped").turns;
  const aborted = turns[1];
  assert.deepEqual(aborted.context, { inputTokens: 0, fraction: 0, source: "native" });
  assert.equal(aborted.output, 0);

  const untokened = turns[2];
  assert.deepEqual(untokened.context, { inputTokens: null, fraction: null, source: "unknown" });
  assert.equal(untokened.cacheRead, null);
  assert.equal(untokened.cacheCreate, null);
  assert.equal(untokened.output, null);
});

test("an unrecognised tool part yields a call but null result bytes, never 0", async () => {
  const turn = (await sessionsById()).get("ses_mapped").turns[2];
  assert.deepEqual(turn.toolCalls, [{ id: null, name: "grep", input: null }]);
  assert.equal(turn.toolResultBytes, null);
});

test("NULL session columns stay null rather than becoming 0 or a guess", async () => {
  const session = (await sessionsById()).get("ses_nulls");
  assert.equal(session.model, null);
  assert.equal(session.cwd, null);
  assert.equal(session.project, null);
  assert.equal(session.endedAt, null);
  // CONTRACT CHANGE (F-008): the session row carries no model and no totals, but
  // its one message reports 5 tokens of context, so the window is at least 5.
  // An absent measurement still yields nothing - see the no-message session.
  assert.deepEqual(session.window, { tokens: 5, source: "observed-floor" });
  assert.equal(session.turns[0].context.fraction, null, "F-014: a floor is not a percentage");
});

test("a session with no messages has zero turns and no fabricated metrics", async () => {
  const session = (await sessionsById()).get("ses_nomsg");
  assert.deepEqual(session.turns, []);
});

test("sessionMeta exposes the DIS-004 parent linkage and the session row totals", async () => {
  const instance = collector();
  await instance.collect();
  assert.equal(instance.sessionMeta.get("ses_child").parentSessionId, "ses_mapped");
  assert.equal(instance.sessionMeta.get("ses_mapped").parentSessionId, null);
  assert.deepEqual(instance.sessionMeta.get("ses_mapped").totals, {
    cost: 0.5, input: 100, output: 20, reasoning: 7, cacheRead: 5000, cacheWrite: 300,
  });
  assert.deepEqual(instance.sessionMeta.get("ses_nulls").totals, {
    cost: null, input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null,
  });
});

test("limit bounds the query and reports the truncation", async () => {
  const diagnostic = createDiagnostic("opencode");
  const sessions = await collector().collect({ limit: 2, diagnostic });
  assert.deepEqual(sessions.map((session) => session.sessionId), ["ses_child", "ses_mapped"]);
  assert.ok(diagnostic.truncated.some((entry) => entry.includes("#session>2")), JSON.stringify(diagnostic.truncated));
});

test("since bounds the query by session time_created", async () => {
  const sessions = await collector().collect({ since: new Date(1700000250000) });
  assert.deepEqual(sessions.map((session) => session.sessionId), ["ses_child", "ses_mapped"]);
});

test("every session and turn matches the BP-002 shape exactly", async () => {
  for (const session of await collector().collect()) {
    assert.deepEqual(Object.keys(session).sort(), [
      "cli", "cwd", "endedAt", "model", "project", "sessionId",
      "startedAt", "support", "turns", "window",
    ]);
    for (const turn of session.turns) {
      assert.deepEqual(Object.keys(turn).sort(), [
        "cacheCreate", "cacheRead", "context", "isSidechain",
        "output", "toolCalls", "toolResultBytes", "ts",
      ]);
    }
  }
});

// ---------------------------------------------------------------- BP-002.08

test("a missing database file is a diagnostic, not a crash", async () => {
  const instance = collector(scratch());
  const diagnostic = createDiagnostic("opencode");
  assert.deepEqual(await instance.collect({ diagnostic }), []);
  assert.equal(diagnostic.filesSkipped, 1);
  assert.equal(diagnostic.errors.length, 0);
});

test("a file that is not a SQLite database is a diagnostic, not a crash", async () => {
  const instance = collector(TEXT_DB_HOME);
  const diagnostic = createDiagnostic("opencode");
  assert.equal(instance.detect().status, "supported");
  assert.deepEqual(await instance.collect({ diagnostic }), []);
  assert.equal(diagnostic.filesSkipped, 1);
  assert.match(diagnostic.errors.join(" "), /not a database/i);
});

test("a valid database missing the expected tables is a diagnostic, not a crash", async () => {
  const home = scratch();
  buildTablelessDb(home);
  const diagnostic = createDiagnostic("opencode");
  assert.deepEqual(await collector(home).collect({ diagnostic }), []);
  assert.equal(diagnostic.filesSkipped, 1);
  assert.match(diagnostic.errors.join(" "), /no such table: session/i);
});

test("a data column that fails to parse is counted and skipped", async () => {
  const diagnostic = createDiagnostic("opencode");
  const sessions = await collector().collect({ diagnostic });
  // One unparseable `message.data` and one unparseable `part.data`.
  assert.ok(diagnostic.linesSkipped >= 2, `linesSkipped=${diagnostic.linesSkipped}`);
  assert.equal(diagnostic.filesSkipped, 0);
  assert.equal(sessions.length, 5);
});

test("collect never writes: the database file and its WAL are untouched", async () => {
  const before = statSync(FIXTURE_DB);
  const walBefore = existsSync(`${FIXTURE_DB}-wal`);
  await collector().collect();
  const after = statSync(FIXTURE_DB);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(existsSync(`${FIXTURE_DB}-wal`), walBefore);
});

// ------------------------------------------------------- INV-0.001 / BP-002.10

test("the table allowlist is exactly the six safe tables", () => {
  assert.deepEqual([...OPENCODE_TABLE_ALLOWLIST].sort(), [
    "message", "part", "project", "session", "session_message", "workspace",
  ]);
});

test("assertAllowedSql rejects credential tables, SELECT *, writes and unbounded reads", () => {
  for (const table of ["account", "control_account", "credential"]) {
    assert.throws(
      () => assertAllowedSql(`select id, access_token from ${table} limit 1`),
      /not on the allowlist/,
      table,
    );
  }
  assert.throws(() => assertAllowedSql("select * from session limit 1"), /is forbidden; every column must be named/);
  assert.throws(() => assertAllowedSql("select id from session s join credential c on 1 limit 1"), /not on the allowlist/);
  assert.throws(() => assertAllowedSql("delete from session"), /only SELECT/);
  assert.throws(() => assertAllowedSql("select name from sqlite_master limit 1"), /not on the allowlist/);
  assert.throws(() => assertAllowedSql("select name from pragma_table_info('session') limit 1"), /not on the allowlist/);
  assert.throws(() => assertAllowedSql("select id from session"), /bounded by LIMIT/);
  assert.throws(() => assertAllowedSql("select id from session limit 1; select id from credential limit 1"), /may not be chained/);
  // The statements the module actually ships all pass.
  for (const sql of Object.values(OPENCODE_QUERIES)) assert.equal(assertAllowedSql(sql), sql);
});

test("every SQL string the collector issues is safe and explicit", async () => {
  const instance = collector();
  await instance.collect();
  assert.ok(instance.sqlLog.length >= 4, `sqlLog=${instance.sqlLog.length}`);
  for (const sql of instance.sqlLog) {
    // The captured strings, not our intent, are what is asserted.
    assert.doesNotMatch(sql, /account|credential/i, sql);
    assert.ok(!sql.includes("*"), sql);
    assert.match(sql, /^\s*select\s/i, sql);
    assert.match(sql, /\blimit\b/i, sql);
    const tables = [...sql.matchAll(/\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]);
    assert.ok(tables.length > 0, sql);
    for (const table of tables) assert.ok(OPENCODE_TABLE_ALLOWLIST.includes(table), `${table} in ${sql}`);
  }
});

test("no planted credential value reaches collector output", async () => {
  const instance = collector();
  const diagnostic = createDiagnostic("opencode");
  const sessions = await instance.collect({ diagnostic });
  const emitted = JSON.stringify({
    sessions,
    sessionMeta: [...instance.sessionMeta],
    diagnostic,
    sqlLog: instance.sqlLog,
  });
  // The fixture database really does hold these values in account / credential.
  assert.equal(PLANTED_SECRETS.length, 4);
  for (const secret of PLANTED_SECRETS) {
    assert.ok(!emitted.includes(secret), "a planted credential value reached the output");
  }
  const tokenShaped = /(?:sk|pk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{16,}|ya29\.[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:access|refresh)_token/i;
  const match = emitted.match(tokenShaped);
  assert.equal(match, null, `token-shaped value in output: ${match?.[0]?.slice(0, 12)}`);
});

/**
 * A database holding ONE session whose row total and per-turn peak differ.
 * Built inline rather than added to the shared fixture builder so this test owns
 * exactly the numbers it asserts on.  Only the columns the collector reads are
 * created; nothing is written anywhere near a real OpenCode database.
 */
function floorTrapDb() {
  const home = scratch();
  const dir = path.join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec(`create table session (
    id text primary key, project_id text, workspace_id text, parent_id text,
    slug text, directory text, cost real,
    tokens_input integer, tokens_output integer, tokens_reasoning integer,
    tokens_cache_read integer, tokens_cache_write integer,
    agent text, model text, time_created integer, time_updated integer)`);
  db.exec("create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text)");
  db.exec("create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)");
  db.exec("create table project (id text primary key, worktree text, vcs text, name text, time_created integer, time_updated integer)");

  // THE TRAP: `tokens_input` is the per-session TOTAL across all three turns.
  db.prepare(`insert into session (id, project_id, slug, directory, cost, tokens_input,
      tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model,
      time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("ses_floor", null, "floor", "/Users/demo/floor", 0, 402568, 30, 0, 0, 0, "build",
      JSON.stringify({ id: "nemotron-3.5-lightning-free", providerID: "opencode" }), 1700000900000, 1700000910000);

  const insert = db.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)");
  // Per-turn contexts: 30,000 / 41,344 / 12,000. Sum 83,344; the row says 402,568.
  const contexts = [30000, 41344, 12000];
  contexts.forEach((input, index) => {
    const created = 1700000900000 + index * 100;
    insert.run(`msg_floor_${index}`, "ses_floor", created, created, JSON.stringify({
      role: "assistant", agent: "build",
      tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "nemotron-3.5-lightning-free", providerID: "opencode",
      time: { created },
    }));
  });
  db.close();
  return home;
}

test("F-010: the observed floor is the MAX per-turn context, never a session total or a sum", async () => {
  const [session] = await collector(floorTrapDb()).collect();
  assert.equal(session.sessionId, "ses_floor");
  assert.equal(session.turns.length, 3);

  // The window is the largest single context the session is PROVED to have held.
  assert.deepEqual(session.window, { tokens: 41344, source: "observed-floor" });

  // `session.tokens_input` is a per-session TOTAL, not a context measurement.
  // Feeding it in would invent a 402,568-token window for a session whose real
  // peak context was 41,344 - the same inflation as summing cumulative usage.
  assert.notEqual(session.window.tokens, 402568, "a session total is not a context reading");
  assert.notEqual(session.window.tokens, 83344, "nor is the sum of the turns");
  assert.equal(session.sessionMeta === undefined, true, "the row total stays on the collector, not the session");

  // F-014: and none of it becomes a percentage.
  for (const turn of session.turns) {
    assert.equal(turn.context.fraction, null);
  }
});

test("no session from the fixture database publishes a context fraction above 1.0", async () => {
  for (const session of await collector().collect()) {
    for (const turn of session.turns) {
      assert.ok(turn.context.fraction === null || turn.context.fraction <= 1,
        `${session.sessionId}: fraction ${turn.context.fraction}`);
    }
  }
});

// ==========================================================================
// WHAT MUST NOT MOVE WHEN A NOTE IS ADDED
//
// `src/analyzer/health.js` derives "was anything cut off?" from whether the
// number of sessions the collector returned reached the limit, and the sub-agent
// concurrency rule reads that: cut off -> `unknown`, complete -> `not-observed`.
// So a change to WHICH sessions a collector returns, or to HOW the limit is
// counted, silently rewrites verdicts across every session read. This test pins
// both halves through the real collector, with the real fixture database, at the
// exact boundary — the limit reached, and the same scan without one.
// ==========================================================================

const { collectMany: collectManyCollectors } = await import("../../src/collectors/registry.js");
const { analyzeAll: analyzeAllSessions } = await import("../../src/analyzer/health.js");

async function opencodeReading(options = {}) {
  const collected = await collectManyCollectors([collector()], options);
  const out = analyzeAllSessions(collected, options);
  return {
    read: collected.supported[0].sessions.length,
    entry: out.collectors.find((cli) => cli.cli === "opencode"),
    subagentStatuses: out.sessions
      .filter((session) => session.cli === "opencode")
      .map((session) => session.rules.find((rule) => rule.id === "subagent-concurrency").evidence.status),
  };
}

test("a scan that reaches the limit still returns the same sessions and the same cut-off verdicts", async () => {
  // The fixture holds 5 sessions, one of them a sub-agent of another.
  const complete = await opencodeReading();
  assert.equal(complete.read, 5);
  assert.equal(complete.entry.sessions, 4);
  assert.equal(complete.entry.subagentSessions, 1);
  // Nothing was cut off, so the rule may say it did not see the problem.
  assert.deepEqual(complete.subagentStatuses, ["not-observed", "not-observed", "not-observed", "not-observed"]);
  assert.ok(!complete.entry.note.includes("collection limit"), complete.entry.note);

  // The boundary: 5 returned against a limit of 5 means more may exist.
  const capped = await opencodeReading({ limit: 5 });
  assert.equal(capped.read, 5);
  assert.equal(capped.entry.sessions, 4);
  assert.equal(capped.entry.subagentSessions, 1);
  // One session HAS a collected child, so it is still measured; the other three
  // cannot be told apart from a session whose children were cut off.
  assert.deepEqual(capped.subagentStatuses, ["not-observed", "unknown", "unknown", "unknown"]);
  assert.ok(capped.entry.note.includes("the collection limit of 5 was reached"), capped.entry.note);

  // And a limit BELOW the fixture size cuts the oldest, never a different set.
  const cut = await opencodeReading({ limit: 4 });
  assert.equal(cut.read, 4);
  assert.equal(cut.entry.sessions, 3);
  assert.deepEqual(cut.subagentStatuses, ["not-observed", "unknown", "unknown"]);
});

// ==========================================================================
// AN UNREADABLE DATABASE IS AN ERROR, NOT A MEASURED ZERO
//
// A `mode=ro` open of a WAL database rebuilds the `-shm` sidecar, which is a
// WRITE into the directory holding the database. On a locked-down home, a
// read-only mount or a restored backup that directory refuses it, and the open
// fails outright rather than degrading. What must not happen is the failure being
// swallowed: "0 OpenCode sessions" would be a measurement nothing made.
//
// FOUND, at the time this test was written: the failure is already honest. The
// collector records the error in its diagnostic, counts the file as skipped and
// returns no session, and `health.js` publishes the count as null with a note
// saying the read failed. This test exists to keep it that way.
// ==========================================================================

test("a WAL database whose sidecar cannot be written reports the error and publishes no count", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    // Root ignores the directory mode, and Windows does not have one to ignore.
    t.skip("this platform cannot make a directory unwritable for the current user");
    return;
  }

  // A live WAL left un-checkpointed: what a copied or backed-up OpenCode
  // directory looks like when the CLI was running at the time. The `-shm` is
  // deliberately absent, because rebuilding it is the write that gets refused.
  const source = scratch();
  const sourceDb = buildFixtureDb(source);
  const live = new DatabaseSync(sourceDb);
  live.exec("pragma journal_mode=wal");
  live.exec("pragma wal_autocheckpoint=0");
  live.exec("insert into project (id, name, worktree) values ('p-wal', 'wal', '/tmp/wal')");
  assert.ok(existsSync(`${sourceDb}-wal`), "the fixture must have a live WAL, or this tests nothing");

  const home = scratch();
  const dir = path.join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  const db = path.join(dir, "opencode.db");
  copyFileSync(sourceDb, db);
  copyFileSync(`${sourceDb}-wal`, `${db}-wal`);
  live.close();

  chmodSync(dir, 0o555);
  try {
    const report = createDiagnostic("opencode");
    let sessions;
    // Never fatal: one unreadable database must not take the scan down with it.
    await assert.doesNotReject(async () => { sessions = await collector(home).collect({ diagnostic: report }); });

    if (report.errors.length === 0) {
      // Some builds of SQLite open an un-recovered WAL read-only anyway. Then
      // there is no failure to be honest about, and asserting one would be a
      // test of this machine rather than of the product.
      t.skip("this platform opened the read-only WAL database, so there is no failure to pin");
      return;
    }

    assert.deepEqual(sessions, [], "an unreadable database yields no session, never a partial one");
    assert.equal(report.errors.length, 1, JSON.stringify(report.errors));
    assert.match(report.errors[0], /open|readonly|read-only/i, report.errors[0]);
    assert.equal(report.filesSkipped, 1, "the file must be counted as skipped, not as read");

    // The honest end of it: a count of 0 is never published for a failed read.
    const collected = await collectManyCollectors([collector(home)], {});
    const out = analyzeAllSessions(collected, {});
    const entry = out.collectors.find((cli) => cli.cli === "opencode");
    assert.equal(entry.sessions, null, "a failed read states no count at all");
    assert.equal(entry.subagentSessions, null);
    assert.ok(entry.note.includes("reading this CLI failed"), entry.note);
    assert.ok(entry.note.includes("unknown rather than zero"), entry.note);
    assert.ok(collected.diagnostics.some((diagnostic) => diagnostic.cli === "opencode" && diagnostic.errors.length > 0),
      "the error must travel to the collector diagnostics the note points the reader at");
  } finally {
    // Never leave an unreadable directory behind, even on a failed assertion.
    chmodSync(dir, 0o755);
  }
});
