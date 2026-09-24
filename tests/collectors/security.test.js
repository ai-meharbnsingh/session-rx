/**
 * GATE-SEC — dedicated security gate (BP-007).
 *
 * "response/report secret scan" was previously proven only incidentally, one
 * assertion at a time, inside tests/report.test.js. This file makes it a
 * first-class gate: it drives the real redactor (`redactSecrets`) directly,
 * and adds a negative control the other suites do not carry — proof that
 * redaction does not destroy the ordinary evidence (paths, UUIDs) the report
 * exists to show.
 *
 * HARD RULE FOR THIS FILE: no literal credential-shaped string ever appears
 * in the source. Every secret-shaped value below is assembled from fragments
 * at runtime (string concatenation / `.repeat()`), matching the convention
 * already used in tests/fixtures/report/secrets.js. None of these is a real
 * credential.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets } from "../../src/report/generator.js";

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
