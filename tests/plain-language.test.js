/**
 * tests/plain-language.test.js — the "no jargon a manager wouldn't know"
 * contract for user-visible labels and titles.
 *
 * Scope: the six health-rule names (src/analyzer/rules.js `RULES[].name`),
 * their plain problem/why sentences, and the suggestion titles
 * (src/suggestions/sections.js). These are the strings a non-technical reader
 * sees first on the Health page and in the Suggested change panel, so a
 * banned word creeping back into any of them is a regression this test
 * exists to catch. It does not attempt to scan every string in the app —
 * `evidence.reason` / `evidence.derivation` are engineering detail kept
 * behind a disclosure on purpose and are exempt.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RULES } from "../src/analyzer/rules.js";
import { SUGGESTION_DEFS } from "../src/suggestions/sections.js";

/** Case-insensitive. Each entry is a word/phrase a manager would not know. */
const BANNED_JARGON = [
  "sidechain",
  "context pressure",
  "cache hit",
  "concurrency",
  /\bBP-\d/,
  /\bDIS-\d/,
  /\bF-\d{2,}/,
];

function assertPlain(label, value) {
  if (typeof value !== "string" || !value) return;
  for (const pattern of BANNED_JARGON) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    assert.ok(!re.test(value), `${label} contains banned jargon (${pattern}): "${value}"`);
  }
}

test("every rule's user-facing name is plain language, with no banned jargon", () => {
  for (const rule of RULES) {
    assertPlain(`rule "${rule.id}".name`, rule.name);
  }
});

test("every rule's plain.problem / plain.why sentence carries no banned jargon", () => {
  for (const rule of RULES) {
    assertPlain(`rule "${rule.id}".plain.problem`, rule?.plain?.problem);
    assertPlain(`rule "${rule.id}".plain.why`, rule?.plain?.why);
  }
});

test("every suggestion's title carries no banned jargon", () => {
  for (const def of Object.values(SUGGESTION_DEFS)) {
    assertPlain(`suggestion "${def.id}".title`, def.title);
  }
});

test("the six health checks carry the expected plain names", () => {
  const names = Object.fromEntries(RULES.map((rule) => [rule.id, rule.name]));
  assert.equal(names["context-pressure"], "Conversation got too full");
  assert.equal(names["cache-hit"], "Re-read the same material instead of reusing it");
  assert.equal(names["repeat-tool"], "Ran the same command again and again");
  assert.equal(names["large-tool-result"], "Commands returned very long output");
  assert.equal(names["long-rising-context"], "Long session that kept growing");
  assert.equal(names["subagent-concurrency"], "Too many helper agents at once");
});
