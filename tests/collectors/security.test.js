/**
 * GATE-SEC — dedicated security gate (BP-007).
 *
 * "query authorizer rejects `account`, `control_account`, `credential`;
 * response/report secret scan" was previously proven only incidentally, one
 * assertion at a time, inside tests/collectors/opencode.test.js and
 * tests/report.test.js. This file makes it a first-class gate: it drives the
 * real authorizer (`assertAllowedSql`) and the real redactor (`redactSecrets`)
 * directly, names every forbidden table individually, and adds a negative
 * control the other suites do not carry — proof that redaction does not
 * destroy the ordinary evidence (paths, UUIDs) the report exists to show.
 *
 * HARD RULE FOR THIS FILE: no literal credential-shaped string ever appears
 * in the source. Every secret-shaped value below is assembled from fragments
 * at runtime (string concatenation / `.repeat()`), matching the convention
 * already used in tests/fixtures/opencode/build-fixture.mjs and
 * tests/fixtures/report/secrets.js. None of these is a real credential.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDiagnostic } from "../../src/collectors/base.js";
import {
  assertAllowedSql,
  OPENCODE_TABLE_ALLOWLIST,
  OpenCodeCollector,
} from "../../src/collectors/opencode.js";
import { redactSecrets } from "../../src/report/generator.js";
import { buildFixtureDb, PLANTED_SECRETS } from "../fixtures/opencode/build-fixture.mjs";

/** BP-002.10's named credential-bearing tables — the ones this gate must keep out. */
const FORBIDDEN_TABLES = Object.freeze([
  "account", "control_account", "credential", "permission", "session_share", "session_input",
]);

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "session-rx-security-"));
}

// ============================================================================
// A. The table allowlist is exactly what BP-002.10 declares
// ============================================================================

test("A: OPENCODE_TABLE_ALLOWLIST contains exactly the six BP-002.10 tables, no more", () => {
  assert.deepEqual([...OPENCODE_TABLE_ALLOWLIST].sort(), [
    "message", "part", "project", "session", "session_message", "workspace",
  ]);
  assert.equal(OPENCODE_TABLE_ALLOWLIST.length, 6);
  // Not one of the forbidden tables is anywhere on it.
  for (const table of FORBIDDEN_TABLES) {
    assert.equal(OPENCODE_TABLE_ALLOWLIST.includes(table), false, table);
  }
});

test("A: the allowlist is frozen — a mutable allowlist is not an allowlist", () => {
  assert.equal(Object.isFrozen(OPENCODE_TABLE_ALLOWLIST), true);
  assert.throws(() => OPENCODE_TABLE_ALLOWLIST.push("account"), TypeError);
  assert.throws(() => { OPENCODE_TABLE_ALLOWLIST[0] = "account"; }, TypeError);
  // The mutation attempts above must not have altered the real allowlist.
  assert.deepEqual([...OPENCODE_TABLE_ALLOWLIST].sort(), [
    "message", "part", "project", "session", "session_message", "workspace",
  ]);
});

// ============================================================================
// B. The query authorizer refuses each forbidden table, individually.
//
// `assertAllowedSql` (src/collectors/opencode.js) is the real, directly
// exported chokepoint every OpenCode query passes through (see run() in the
// same file) — it is called here directly, not through a collector method,
// so a regression in the check itself cannot hide behind collector plumbing.
// One test per table, deliberately not collapsed into a loop-with-one-assert:
// a failure here names the exact table that stopped being rejected.
// ============================================================================

for (const table of FORBIDDEN_TABLES) {
  test(`B: assertAllowedSql rejects the forbidden table "${table}"`, () => {
    assert.throws(
      () => assertAllowedSql(`select id from ${table} limit 1`),
      (err) => err instanceof Error
        && /not on the allowlist/.test(err.message)
        && err.message.includes(table),
      `assertAllowedSql must reject and name "${table}"`,
    );
  });
}

test("B: assertAllowedSql still accepts a legitimate allowlisted table", () => {
  // Proves discrimination, not blanket refusal: an ordinary bounded, explicit-
  // column SELECT over an allowlisted table passes unchanged.
  const sql = "select id, time_created from session limit 5";
  assert.equal(assertAllowedSql(sql), sql);
});

// ============================================================================
// C. Secret redaction, adversarially (response/report scan).
//
// Every value below is credential-SHAPED but assembled from fragments at
// runtime, per the hard rule at the top of this file.
// ============================================================================

test("C: an Anthropic-style API key is redacted", () => {
  const secret = "sk" + "-ant-api03-" + "A".repeat(38);
  const { text, redactions } = redactSecrets(`ANTHROPIC_API_KEY=${secret}`);
  assert.equal(text.includes(secret), false);
  assert.ok(redactions > 0);
});

test("C: an OpenAI-style API key is redacted", () => {
  const secret = "sk" + "-" + "B".repeat(48);
  const { text, redactions } = redactSecrets(`OPENAI_API_KEY=${secret}`);
  assert.equal(text.includes(secret), false);
  assert.ok(redactions > 0);
});

test("C: a GitHub personal access token is redacted", () => {
  const secret = "ghp" + "_" + "C".repeat(36);
  const { text, redactions } = redactSecrets(`token: ${secret}`);
  assert.equal(text.includes(secret), false);
  assert.ok(redactions > 0);
});

test("C: an AWS access key id is redacted", () => {
  const secret = "AKIA" + "D".repeat(16);
  const { text, redactions } = redactSecrets(`aws_access_key_id = ${secret}`);
  assert.equal(text.includes(secret), false);
  assert.ok(redactions > 0);
});

test("C: a Google API key is redacted", () => {
  const secret = "AIza" + "E".repeat(35);
  const { text, redactions } = redactSecrets(`key=${secret}`);
  assert.equal(text.includes(secret), false);
  assert.ok(redactions > 0);
});

test("C: an Authorization: Bearer header is redacted", () => {
  const value = "F".repeat(40);
  const header = "Authorization" + ": Bearer " + value;
  const { text, redactions } = redactSecrets(header);
  assert.equal(text.includes(value), false);
  assert.ok(redactions > 0);
});

// --------------------------------------------------------------------------
// NEGATIVE CONTROL: an over-eager redactor would destroy the report's
// usefulness by scrubbing ordinary evidence references. Pin that it does not.
// --------------------------------------------------------------------------

test("C (negative control): a UUID survives redaction unchanged and contributes zero redactions", () => {
  const uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  const { text, redactions } = redactSecrets(uuid);
  assert.equal(text, uuid);
  assert.equal(redactions, 0);
});

test("C (negative control): a long absolute filesystem path survives redaction unchanged and contributes zero redactions", () => {
  const longPath = "/Users/demo/Projects/AutonomousFactory/multiLLMorchestrator/caseStudies/projectSixty/reports/session-health-2026-09-20.md";
  const { text, redactions } = redactSecrets(longPath);
  assert.equal(text, longPath);
  assert.equal(redactions, 0);
});

// ============================================================================
// D. No credential data escapes via the collector.
//
// Reuses the OpenCode SQLite fixture from tests/fixtures/opencode/, whose
// `account` / `control_account` / `credential` tables already carry planted,
// token-shaped values (PLANTED_SECRETS) — this proves the allowlist keeps a
// real credential row out of collector output, not merely that there was
// nothing present to leak.
// ============================================================================

test("D: normalized collector output contains no forbidden table name and no planted credential value", async () => {
  const home = scratch();
  buildFixtureDb(home);
  const collector = new OpenCodeCollector({ home });
  const diagnostic = createDiagnostic("opencode");
  const sessions = await collector.collect({ diagnostic });

  assert.ok(sessions.length > 0, "the fixture must actually produce sessions for this assertion to mean anything");

  const emitted = JSON.stringify({
    sessions,
    sessionMeta: [...collector.sessionMeta],
    diagnostic,
    sqlLog: collector.sqlLog,
  });

  assert.equal(PLANTED_SECRETS.length, 4);
  for (const secret of PLANTED_SECRETS) {
    assert.ok(!emitted.includes(secret), `planted credential value leaked into collector output: ${secret.slice(0, 6)}…`);
  }
  for (const table of FORBIDDEN_TABLES) {
    assert.ok(!emitted.includes(table), `forbidden table name "${table}" leaked into collector output`);
  }
});
