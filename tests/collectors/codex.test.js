import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CodexCollector } from "../../src/collectors/codex.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "fixtures", "codex");
const HOME = path.join(fixtures, "home");
const ROBUST = path.join(fixtures, "robust");
const MISSING = path.join(fixtures, "does-not-exist");

// Byte lengths of the exact tool-output blobs written into the fixtures.
const BLOB_A_BYTES = 55; // "Command: ls\nOriginal token count: 15\nOutput:\nREADME.md\n"
const BLOB_B_BYTES = 46; // "Command: true\nOriginal token count: 3\nOutput:\n"
const CTCO_BYTES = 33;   // "Script completed\n" + "/Users/demo/app\n"

function byId(sessions) {
  return new Map(sessions.map((session) => [session.sessionId, session]));
}

async function collectFrom(root, options = {}, ctor = {}) {
  const collector = new CodexCollector({ root, home: root, ...ctor });
  const sessions = await collector.collect(options);
  return { collector, sessions, diagnostic: collector.lastDiagnostic };
}

test("detect() reports supported, detection-only, and absent honestly", () => {
  assert.deepEqual(new CodexCollector({ root: HOME, home: HOME }).detect(),
    { installed: true, paths: [HOME], status: "supported" });

  // Installed CLI, no rollout directory: detected, not a data source.
  assert.deepEqual(new CodexCollector({ root: MISSING, home: HOME }).detect(),
    { installed: true, paths: [HOME], status: "detection-only" });

  assert.deepEqual(new CodexCollector({ root: MISSING, home: MISSING }).detect(),
    { installed: false, paths: [], status: "absent" });
});

test("collect() returns nothing and does not throw when the root is absent", async () => {
  const { sessions } = await collectFrom(MISSING);
  assert.deepEqual(sessions, []);
});

test("the context window is native: read from model_context_window, no model table", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("codex-sess-a");
  assert.ok(session, "codex-sess-a fixture was parsed");
  assert.deepEqual(session.window, { tokens: 258400, source: "native" });
  assert.equal(session.cli, "codex");
  assert.equal(session.support, "supported");
  assert.equal(session.cwd, "/Users/demo/app");
  assert.equal(session.project, "app");
  assert.equal(session.model, "gpt-5.2");
  assert.equal(session.startedAt, "2026-09-20T10:00:00.000Z");
  assert.equal(session.endedAt, "2026-09-20T10:00:10.000Z");
});

test("last_token_usage is the per-turn delta; total_token_usage is never summed", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("codex-sess-a");

  // One turn per token_count record.
  assert.equal(session.turns.length, 3);

  const inputs = session.turns.map((turn) => turn.context.inputTokens);
  assert.deepEqual(inputs, [15141, 17642, 21517], "per-turn deltas, not running totals");
  assert.notDeepEqual(inputs, [15141, 32783, 54300], "the cumulative totals must not be reported per turn");

  // Summing the cumulative column would report 102224 for the session.
  const summed = inputs.reduce((total, value) => total + value, 0);
  assert.equal(summed, 54300, "the deltas sum to the final cumulative total, proving they are deltas");

  assert.deepEqual(session.turns.map((turn) => turn.cacheRead), [9984, 14080, 17152]);
  assert.deepEqual(session.turns.map((turn) => turn.output), [201, 142, 238]);
  assert.equal(session.turns[0].context.source, "native");
  assert.equal(session.turns[0].context.fraction, 15141 / 258400);
  assert.deepEqual(session.turns.map((turn) => turn.ts),
    ["2026-09-20T10:00:05.000Z", "2026-09-20T10:00:08.000Z", "2026-09-20T10:00:10.000Z"]);
});

test("HONEST NULLS: cache creation is null when the log omits it, zero when it reports zero", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("codex-sess-a");

  // The first two records carry cache_write_input_tokens: 0 - a real zero.
  assert.equal(session.turns[0].cacheCreate, 0);
  assert.equal(session.turns[1].cacheCreate, 0);
  // The third omits the field entirely: unknown, never substituted with zero.
  assert.equal(session.turns[2].cacheCreate, null);
});

test("function_call and custom_tool_call are tool calls; message and reasoning are not", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("codex-sess-a");

  // The fixture also contains one reasoning and one message response_item.
  const allCalls = session.turns.flatMap((turn) => turn.toolCalls);
  assert.equal(allCalls.length, 2, "reasoning and message records are not tool calls");
  assert.deepEqual(allCalls.map((call) => call.id), ["call_1", "call_2"]);
  assert.deepEqual(allCalls.map((call) => call.name), ["exec_command", "exec"]);
  assert.equal(allCalls[0].input, '{"cmd":"ls"}');

  assert.equal(session.turns[0].toolCalls.length, 1);
  assert.equal(session.turns[1].toolCalls.length, 1);
  assert.equal(session.turns[2].toolCalls.length, 0);
});

test("toolResultBytes comes from the output blob and follows the call, not the log order", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("codex-sess-a");

  // Both outputs are logged AFTER the token_count of the turn that made the
  // call, so byte counts are attributed by call_id rather than by position.
  assert.equal(session.turns[0].toolResultBytes, BLOB_A_BYTES, "string blob form");
  assert.equal(session.turns[1].toolResultBytes, CTCO_BYTES, "input_text array form");
  assert.equal(session.turns[2].toolResultBytes, null, "no result observed stays null");
});

test("Codex exposes no sidechain marker, so isSidechain is unknown rather than false", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("codex-sess-a");
  for (const turn of session.turns) assert.equal(turn.isSidechain, null);
});

test("session_meta with no token_count anywhere leaves every usage field null", async () => {
  const { sessions } = await collectFrom(HOME);
  const session = byId(sessions).get("codex-sess-b");
  assert.ok(session);
  assert.deepEqual(session.window, { tokens: null, source: "unknown" },
    "no token record means no window - never a guessed one");

  // The tool call still happened and is not dropped.
  assert.equal(session.turns.length, 1);
  const turn = session.turns[0];
  assert.equal(turn.context.inputTokens, null);
  assert.equal(turn.context.fraction, null);
  assert.equal(turn.context.source, "unknown");
  assert.equal(turn.cacheRead, null);
  assert.equal(turn.cacheCreate, null);
  assert.equal(turn.output, null);
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].name, "shell");
  assert.equal(turn.toolResultBytes, BLOB_B_BYTES);
});

test("ROBUSTNESS: an empty file yields a session with no turns and no error", async () => {
  const { sessions, diagnostic } = await collectFrom(ROBUST);
  const session = byId(sessions).get("rollout-empty");
  assert.ok(session);
  assert.deepEqual(session.turns, []);
  assert.deepEqual(session.window, { tokens: null, source: "unknown" });
  assert.deepEqual(diagnostic.errors, []);
});

test("ROBUSTNESS: a whitespace-only file yields no turns", async () => {
  const { sessions } = await collectFrom(ROBUST);
  const session = byId(sessions).get("rollout-whitespace");
  assert.ok(session);
  assert.deepEqual(session.turns, []);
});

test("ROBUSTNESS: a truncated JSON line mid-file is skipped and counted", async () => {
  const { sessions, diagnostic } = await collectFrom(ROBUST);
  const session = byId(sessions).get("codex-corrupt");
  assert.ok(session, "records either side of the corrupt line still parse");
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].context.inputTokens, 10);
  assert.equal(session.turns[0].cacheCreate, 1);
  assert.ok(diagnostic.linesSkipped >= 1, "the bad line is counted, not silently dropped");
});

test("ROBUSTNESS: valid JSON with no expected fields is skipped, never crashes", async () => {
  const { sessions, diagnostic } = await collectFrom(ROBUST);
  const session = byId(sessions).get("rollout-bare");
  assert.ok(session);
  assert.deepEqual(session.turns, [],
    "a token_count with no info, and a function_call with no id or name, produce no turn");
  assert.ok(diagnostic.linesSkipped >= 6);
  assert.deepEqual(diagnostic.errors, []);
});

test("ROBUSTNESS: the byte cap keeps partial results and records truncation", async () => {
  assert.equal(new CodexCollector().maxBytes, 50 * 1024 * 1024, "default cap is 50MB (BP-002.08)");

  // The committed fixtures are deliberately small, so the oversized case is
  // built in the OS temp dir - never in the real home dir.
  const root = path.join(os.tmpdir(), "session-rx-codex-cap");
  const dir = path.join(root, "2026", "09", "20");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "rollout-oversized.jsonl");

  const lines = [JSON.stringify({
    timestamp: "2026-09-20T04:00:00.000Z",
    type: "session_meta",
    payload: { session_id: "codex-oversized", cwd: "/tmp/oversized" },
  })];
  for (let index = 0; index < 300; index += 1) {
    lines.push(JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 8, 20, 4, 0, index)).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 100 * (index + 1), cached_input_tokens: 0, output_tokens: 1 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 },
          model_context_window: 258400,
        },
        padding: "p".repeat(320),
      },
    }));
  }
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");

  const collector = new CodexCollector({ root, home: root, maxBytes: 70 * 1024 });
  const sessions = await collector.collect();
  assert.equal(sessions.length, 1, "a capped file still yields a session");
  assert.ok(sessions[0].turns.length > 0, "the records read before the cap survive");
  assert.ok(sessions[0].turns.length < 300, "the read stopped before the end of the file");
  assert.ok(collector.lastDiagnostic.truncated.some((entry) => entry.endsWith("rollout-oversized.jsonl")),
    "truncation is reported in the diagnostic");
});

test("limit and since bound the scan", async () => {
  const all = await collectFrom(HOME);
  assert.equal(all.sessions.length, 2);

  const limited = await collectFrom(HOME, { limit: 1 });
  assert.equal(limited.sessions.length, 1);

  const future = await collectFrom(HOME, { since: new Date("2999-01-01T00:00:00.000Z") });
  assert.deepEqual(future.sessions, []);

  const epoch = await collectFrom(HOME, { since: new Date(0) });
  assert.equal(epoch.sessions.length, 2);
});

test("every collected session matches the normalized contract", async () => {
  const { sessions } = await collectFrom(HOME);
  for (const session of sessions) {
    assert.deepEqual(Object.keys(session).sort(), [
      "cli", "cwd", "endedAt", "model", "project", "sessionId",
      "startedAt", "support", "turns", "window",
    ]);
    for (const turn of session.turns) {
      assert.deepEqual(Object.keys(turn).sort(), [
        "cacheCreate", "cacheRead", "context", "isSidechain",
        "output", "toolCalls", "toolResultBytes", "ts",
      ]);
      assert.ok(["native", "derived", "unknown"].includes(turn.context.source));
    }
  }
});
