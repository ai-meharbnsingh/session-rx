import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { RULES, evaluateRule, EVIDENCE_STATUSES } from "../src/analyzer/rules.js";
import { analyzeSession, analyzeAll, buildReportInput } from "../src/analyzer/health.js";
import { generateReport, generateReportDocument } from "../src/report/generator.js";
import { FIX_CATALOG, annotateFixTitles } from "../src/server.js";
import {
  at,
  makeSession,
  call,
  contextHeavy,
  contextCalm,
  contextObservedFloor,
  contextObservedFloorTiny,
  nativeFractionHigh,
  nativeFractionLow,
  fractionAboveOne,
  contextNoWindowNoFraction,
  contextPromotedNoLadder,
  cacheLow,
  cacheHigh,
  cacheReadsOnly,
  cacheCreatesOnly,
  cacheAllZero,
  repeatFive,
  repeatFour,
  repeatPartialCoverage,
  toolCallsNoResultBytes,
  bigResults,
  smallResults,
  bigResultsPartialCoverage,
  noToolCalls,
  longRising,
  longFalling,
  shortRising,
  twoObservations,
  noTimestamps,
  concurrentChildren,
  sequentialChildren,
  childrenWithoutIntervals,
  childrenPartialIntervals,
  sidechainMarkedSession,
  makeCollected,
  promotionDiagnostic,
} from "./fixtures/analyzer/sessions.js";

const RULE_IDS = ["context-pressure", "cache-hit", "repeat-tool", "large-tool-result", "long-rising-context", "subagent-concurrency"];

test("the server catalogue publishes each fix target CLI name and null for unknown data", () => {
  assert.equal(FIX_CATALOG.length, 5);
  assert.ok(FIX_CATALOG.every((fix) => fix.cli === "claude"));

  const rules = FIX_CATALOG.map((fix) => ({ fix: fix.id }));
  rules.push({ fix: "not-a-real-fix" }, { fix: null });
  const sessions = [{ cli: "claude", rules }];
  annotateFixTitles(
    sessions,
    new Map(FIX_CATALOG.map((fix) => [fix.id, fix])),
    new Map([["claude", "Claude Code"]]),
  );

  for (let index = 0; index < FIX_CATALOG.length; index += 1) {
    assert.equal(sessions[0].rules[index].fixCli, "claude");
    assert.equal(sessions[0].rules[index].fixCliName, "Claude Code");
  }
  assert.equal(sessions[0].rules[5].fixCli, null);
  assert.equal(sessions[0].rules[5].fixCliName, null);
  assert.equal(sessions[0].rules[6].fixCli, null);
  assert.equal(sessions[0].rules[6].fixCliName, null);
  assert.equal(sessions[0].cliName, "Claude Code");

  const unknownSession = [{ cli: "not-a-cli", rules: [] }];
  annotateFixTitles(unknownSession, new Map(), new Map());
  assert.equal(unknownSession[0].cliName, null);
});

function ruleById(id) {
  const rule = RULES.find((entry) => entry.id === id);
  assert.ok(rule, `no rule declared with id ${id}`);
  return rule;
}

/** Evaluate one rule and return its RuleResult. */
function verdict(id, session, ctx = {}) {
  return evaluateRule(ruleById(id), session, ctx);
}

function status(id, session, ctx = {}) {
  return verdict(id, session, ctx).evidence.status;
}

function valueOf(result, labelFragment) {
  const found = result.evidence.values.find((value) => value.label.includes(labelFragment));
  assert.ok(found, `no evidence value whose label contains "${labelFragment}" in ${JSON.stringify(result.evidence.values.map((v) => v.label))}`);
  return found.value;
}

/** Every unknown must be able to explain itself. */
function assertUnknownWithReason(result, expectFragment) {
  assert.equal(result.evidence.status, "unknown");
  assert.equal(typeof result.evidence.reason, "string");
  assert.ok(result.evidence.reason.length > 40, `unknown reason too thin to be useful: ${result.evidence.reason}`);
  if (expectFragment) {
    assert.ok(
      result.evidence.reason.toLowerCase().includes(expectFragment.toLowerCase()),
      `unknown reason does not mention "${expectFragment}": ${result.evidence.reason}`,
    );
  }
}

// ===========================================================================
// the six rules as DATA
// ===========================================================================

test("exactly six rules are declared, with the BP-003 ids, in blueprint order", () => {
  assert.deepEqual(RULES.map((rule) => rule.id), RULE_IDS);
  assert.ok(Object.isFrozen(RULES));
});

test("every rule carries a name, a description, a severity, a fix id or null, and a threshold", () => {
  for (const rule of RULES) {
    assert.equal(typeof rule.name, "string", `${rule.id} name`);
    assert.ok(rule.name.length > 0, `${rule.id} name is empty`);
    assert.ok(rule.description.length > 30, `${rule.id} description is too thin to render`);
    assert.ok(["info", "warn", "critical"].includes(rule.severity), `${rule.id} severity ${rule.severity}`);
    assert.ok(rule.fix === null || typeof rule.fix === "string", `${rule.id} fix`);
    assert.ok(rule.threshold.value !== undefined && rule.threshold.value !== null, `${rule.id} threshold value`);
    assert.equal(typeof rule.evaluate, "function", `${rule.id} evaluate`);
  }
});

test("every threshold derivation explains the choice in words, not as a bare number", () => {
  for (const rule of RULES) {
    const derivation = rule.threshold.derivation;
    assert.equal(typeof derivation, "string", `${rule.id} derivation`);
    // The UI shows this to a user who is being told they have a problem: it has
    // to say WHY the line is where it is, not restate the number.
    assert.ok(derivation.split(/\s+/).length >= 40, `${rule.id} derivation is ${derivation.split(/\s+/).length} words, too short to explain anything: ${derivation}`);
    assert.ok(/because|rather than|so that|since|which is why|deliberately/i.test(derivation), `${rule.id} derivation gives no reasoning: ${derivation}`);
  }
});

test("every rule declares non-empty plain-language text, in ordinary English, beside its threshold", () => {
  // The health page's compact-cards wave (BP-001.24) renders THIS text instead
  // of keeping a second copy of the wording — so if it is thin, absent, or
  // full of the analyzer's own jargon, the plain-language rewrite the brief
  // asked for never actually reaches a reader. One catalogue, checked here.
  const jargon = [
    "tool_use", "toolresultbytes", "cacheread", "cachecreate", "sessionid",
    "isSidechain".toLowerCase(), "inputtokens",
  ];
  // A bare identifier-shaped snake_case token (two+ lowercase runs joined by
  // `_`), not an English contraction or a stray underscore in prose.
  const snakeCase = /\b[a-z]+_[a-z][a-z_]*\b/;
  for (const rule of RULES) {
    assert.ok(rule.plain && typeof rule.plain === "object", `${rule.id} has no plain field`);
    for (const field of ["problem", "why"]) {
      const text = rule.plain[field];
      assert.equal(typeof text, "string", `${rule.id}.plain.${field}`);
      assert.ok(text.length > 20, `${rule.id}.plain.${field} is too thin to read as a sentence: ${JSON.stringify(text)}`);
      const lower = text.toLowerCase();
      for (const term of jargon) {
        assert.ok(!lower.includes(term), `${rule.id}.plain.${field} leaks the identifier "${term}": ${text}`);
      }
      assert.ok(!snakeCase.test(text), `${rule.id}.plain.${field} looks like it names a raw field (snake_case): ${text}`);
    }
  }
});

test("repeat-tool's plain text hedges: a detected repetition, never an asserted waste", () => {
  // The product owner's explicit honesty point: repeated calls are NOT always
  // unnecessary, so this rule may never state waste as settled fact.
  const rule = ruleById("repeat-tool");
  const combined = `${rule.plain.problem} ${rule.plain.why}`;
  assert.match(combined, /may indicate/i, "the problem sentence must hedge, not assert");
  assert.match(combined, /detected repetition/i);
  assert.match(combined, /confirmed waste/i);
  assert.ok(
    !/\bis wasted work\b/i.test(combined) && !/\bwas wasted\b/i.test(combined),
    `repeat-tool's plain text asserts waste as fact rather than hedging it: ${combined}`,
  );
});

test("evaluateRule carries `plain` through to the RuleResult, unfilled — the template, not a rendering", () => {
  // Filling `{count}`/`{pct}` from the session's own magnitude is the
  // RENDERER's job (public/js/pages/health.js `fillPlainTemplate`), so the
  // analyzer must hand the template across untouched.
  const result = verdict("cache-hit", cacheLow);
  assert.ok(result.plain, "cache-hit RuleResult carries no plain field");
  assert.equal(result.plain.problem, ruleById("cache-hit").plain.problem);
  assert.equal(result.plain.why, ruleById("cache-hit").plain.why);
});

// ---------------------------------------------------------------------------
// plain.unmeasured — the COULD-NOT-BE-MEASURED sentence, one per CAUSE
// ---------------------------------------------------------------------------

/**
 * Every unmeasured branch a rule can actually reach, with the reason class it
 * emits. The point is not the mapping for its own sake: a class with no
 * sentence behind it renders as the engineering prose the product owner could
 * not read, so this table is what stops a branch shipping without one.
 *
 * @type {Array<[string, string, object, object]>} rule id, expected code, session, ctx
 */
const UNMEASURED_BRANCHES = [
  ["context-pressure", "no-turns", makeSession({ turns: [] }), {}],
  ["context-pressure", "no-context-readings", makeSession({ turns: [{ ts: at(1) }] }), {}],
  ["context-pressure", "native-fraction-out-of-range", fractionAboveOne, {}],
  ["context-pressure", "window-is-observed-peak", contextObservedFloor, {}],
  ["context-pressure", "window-above-known-tiers", contextPromotedNoLadder, { promotion: { ladder: "none" } }],
  ["context-pressure", "window-size-unknown", contextNoWindowNoFraction, {}],
  ["context-pressure", "window-source-unsupported", makeSession({ window: { tokens: 123456, source: "heuristic" }, turns: [{ ts: at(1), inputTokens: 100 }] }), {}],

  ["cache-hit", "no-turns", makeSession({ turns: [] }), {}],
  ["cache-hit", "no-cache-counters", makeSession({ turns: [{ ts: at(1) }] }), {}],
  ["cache-hit", "no-cache-creation-counter", cacheReadsOnly, {}],
  ["cache-hit", "no-cache-read-counter", cacheCreatesOnly, {}],
  ["cache-hit", "no-cache-traffic", cacheAllZero, {}],

  ["repeat-tool", "no-turns", makeSession({ turns: [] }), {}],
  ["repeat-tool", "no-tool-calls-anywhere", noToolCalls, {}],
  ["repeat-tool", "no-attributable-results", toolCallsNoResultBytes, {}],
  ["repeat-tool", "partial-result-coverage", repeatPartialCoverage, {}],

  ["large-tool-result", "no-turns", makeSession({ turns: [] }), {}],
  ["large-tool-result", "no-tool-calls-anywhere", noToolCalls, {}],
  ["large-tool-result", "no-result-sizes", toolCallsNoResultBytes, {}],
  ["large-tool-result", "partial-result-sizes", bigResultsPartialCoverage, {}],

  ["long-rising-context", "no-turns", makeSession({ turns: [] }), {}],
  ["long-rising-context", "no-elapsed-time", noTimestamps, {}],
  ["long-rising-context", "too-few-context-points", twoObservations, {}],
  // Three readings IS enough points, and five hours IS enough time — but every
  // reading carries the same instant, so no pair of them spans any time at all.
  ["long-rising-context", "context-times-identical", makeSession({
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T05:00:00Z",
    turns: [
      { ts: "2026-01-01T02:00:00Z", inputTokens: 50000 },
      { ts: "2026-01-01T02:00:00Z", inputTokens: 50000 },
      { ts: "2026-01-01T02:00:00Z", inputTokens: 50000 },
    ],
  }), {}],

  ["subagent-concurrency", "codex-records-no-subagents", makeSession({ cli: "codex" }), {}],
  ["subagent-concurrency", "cli-records-no-subagents", makeSession({ cli: "droid" }), {}],
  ["subagent-concurrency", "subagent-reading-off", makeSession({}), { sessionMeta: { subagentSessionIds: null } }],
  ["subagent-concurrency", "scan-bounded", makeSession({}), { sessionMeta: { subagentSessionIds: [] }, corpusComplete: false }],
  ["subagent-concurrency", "no-subagent-collected", makeSession({}), { sessionMeta: { subagentSessionIds: [] }, corpusComplete: true }],
  ["subagent-concurrency", "no-subagent-times", makeSession({}), { children: childrenWithoutIntervals }],
  ["subagent-concurrency", "partial-subagent-times", makeSession({}), { children: childrenPartialIntervals }],
];

/** Every plain-language string a rule declares, labelled by where it lives. */
function plainStrings(rule) {
  const out = [];
  for (const field of ["problem", "why"]) {
    if (typeof rule?.plain?.[field] === "string") out.push([`plain.${field}`, rule.plain[field]]);
  }
  const unmeasured = rule?.plain?.unmeasured ?? {};
  for (const key of Object.keys(unmeasured)) out.push([`plain.unmeasured.${key}`, unmeasured[key]]);
  return out;
}

test("every rule declares a plain-English sentence for every cause it can go unmeasured for, and a default", () => {
  // `unknown` is the MAJORITY verdict on the real corpus, so this text is the
  // one a user reads most. A rule with no sentence for its own cause falls back
  // to the engineering `reason` on the card face — which is the thing the
  // product owner read and could not understand.
  for (const rule of RULES) {
    const unmeasured = rule.plain?.unmeasured;
    assert.ok(unmeasured && typeof unmeasured === "object", `${rule.id} has no plain.unmeasured catalogue`);
    assert.equal(typeof unmeasured.default, "string", `${rule.id}.plain.unmeasured.default`);
    for (const [where, textValue] of plainStrings(rule)) {
      assert.equal(typeof textValue, "string", `${rule.id}.${where}`);
      assert.ok(textValue.length > 60, `${rule.id}.${where} is too thin to explain anything: ${JSON.stringify(textValue)}`);
      assert.ok(/[.!]$/.test(textValue.trim()), `${rule.id}.${where} is not a finished sentence: ${textValue}`);
    }
    // An unmeasured sentence must never read as reassurance: this is the
    // fourth-state failure the honesty contract exists to prevent.
    for (const [where, textValue] of plainStrings(rule).filter(([key]) => key.startsWith("plain.unmeasured"))) {
      assert.ok(
        !/nothing to worry about|all clear|no cause for concern|looks fine|seems fine/i.test(textValue),
        `${rule.id}.${where} reads as reassurance, but an unmeasured check is NOT a pass: ${textValue}`,
      );
    }
  }
});

test("no plain-language string anywhere leaks an internal id or the analyzer's own vocabulary", () => {
  // Iterated over EVERY rule and EVERY plain.* value rather than asserted rule
  // by rule, so a rule or a cause added later cannot slip a DIS-00n or a
  // `sidechain` past this file by simply not being named in it.
  const leaks = [
    /DIS-\d/i, /BP-\d/i, /\bF-\d/i, /\bsidechain/i, /\blinkage/i,
    /\bcorpus/i, /\bdenominator/i, /\bnumerator/i, /\bmagnitude/i, /\bverdict/i,
  ];
  let checked = 0;
  for (const rule of RULES) {
    for (const [where, textValue] of plainStrings(rule)) {
      checked += 1;
      for (const leak of leaks) {
        assert.ok(!leak.test(textValue), `${rule.id}.${where} leaks ${leak} into user-facing text: ${textValue}`);
      }
    }
  }
  assert.ok(checked >= 40, `only ${checked} plain strings were checked — the sweep is not reaching the catalogues`);
});

test("every unmeasured branch a rule can reach names a cause that rule has a sentence for", () => {
  for (const [id, expectedCode, session, ctx] of UNMEASURED_BRANCHES) {
    const rule = ruleById(id);
    const result = evaluateRule(rule, session, ctx);
    assert.equal(result.evidence.status, "unknown", `${id}/${expectedCode} is no longer an unknown branch`);
    assert.equal(result.evidence.reasonCode, expectedCode, `${id} emitted ${result.evidence.reasonCode}`);
    assert.ok(
      expectedCode === "default" || Object.hasOwn(rule.plain.unmeasured, expectedCode),
      `${id} emits reason class "${expectedCode}" with no sentence declared for it`,
    );
    // The prose stays too: the class is an ADDITION beside the evidence of
    // record, never a replacement for it.
    assert.ok(result.evidence.reason.length > 40, `${id}/${expectedCode} lost its prose reason`);
  }
  // Every catalogue entry except the two raised outside a rule body is reachable.
  const raisedOutsideARule = new Set(["default", "rule-threw"]);
  const reached = new Set(UNMEASURED_BRANCHES.map(([id, code]) => `${id}::${code}`));
  for (const rule of RULES) {
    for (const key of Object.keys(rule.plain.unmeasured)) {
      if (raisedOutsideARule.has(key)) continue;
      assert.ok(reached.has(`${rule.id}::${key}`), `${rule.id}.plain.unmeasured.${key} is a sentence for a cause no branch above reaches`);
    }
  }
});

test("every reason class written into the analyzer's source has a sentence behind it", () => {
  // A static sweep, so a branch nobody wrote a test case for still cannot ship
  // without its sentence. It sees the codes passed to `unknown()` as literals;
  // the two computed ones (`windowDenominator`'s and `subagentReasonCode`'s)
  // are covered by UNMEASURED_BRANCHES above, which exercises them for real.
  const source = readFileSync(new URL("../src/analyzer/rules.js", import.meta.url), "utf8");
  const literals = new Set([
    ...[...source.matchAll(/^\s*"([a-z][a-z0-9-]*)",\s*$/gm)].map((m) => m[1]),
    ...[...source.matchAll(/,\s*"([a-z][a-z0-9-]*)"\s*\)/g)].map((m) => m[1]),
  ]);
  assert.ok(literals.size >= 16, `only ${literals.size} reason-class literals found — the sweep has stopped matching`);
  const known = new Set(RULES.flatMap((rule) => Object.keys(rule.plain.unmeasured)));
  for (const code of literals) {
    assert.ok(known.has(code), `the source passes reason class "${code}" that no rule has a sentence for`);
  }
});

test("a rule body that throws is unmeasured with a cause of its own, never a pass", () => {
  const thrower = { ...ruleById("cache-hit"), evaluate() { throw new Error("boom"); } };
  const result = evaluateRule(thrower, cacheLow, {});
  assert.equal(result.evidence.status, "unknown");
  assert.equal(result.evidence.reasonCode, "rule-threw");
  assert.ok(Object.hasOwn(result.plain.unmeasured, "rule-threw"), "a crash has no sentence to render");
});

test("an unrecognised or absent reason class falls back to `default`, which every rule answers", () => {
  const vague = { ...ruleById("cache-hit"), evaluate() { return { status: "unknown", reason: "x".repeat(60), values: [] }; } };
  assert.equal(evaluateRule(vague, cacheLow, {}).evidence.reasonCode, "default");
  for (const rule of RULES) assert.equal(typeof rule.plain.unmeasured.default, "string", `${rule.id} cannot answer the fallback`);
});

test("evaluateRule carries plain.unmeasured through to the RuleResult untouched", () => {
  const result = verdict("subagent-concurrency", makeSession({ cli: "codex" }), {});
  assert.equal(result.plain.unmeasured, ruleById("subagent-concurrency").plain.unmeasured);
  assert.equal(result.evidence.reasonCode, "codex-records-no-subagents");
  // A measured result carries no reason and no class, so nothing can look one
  // up and render a could-not-be-measured sentence over a real finding.
  const measured = verdict("cache-hit", cacheLow, {});
  assert.equal(measured.evidence.reason, null);
  assert.equal(measured.evidence.reasonCode, null);
});

test("the Codex sub-agent reason still makes the whole claim, in words a stranger can read", () => {
  // RE-AIMED, not relaxed. This pin was written to stop plain-language work
  // SWAPPING the evidence of record out, and it still does that: the string
  // is asserted whole. What moved is the wording it pins. `sidechain` and
  // `linkage` are the analyzer's vocabulary for its own internals, and this
  // reason reaches the shared Markdown report — which has no collapsed
  // <details> to keep them out of sight and no glossary to look them up in.
  // The claim is unchanged: no per-turn marker, no parent/child record, so no
  // interval to overlap, so unknown rather than a zero.
  const CODEX_REASON =
    "Nothing in Codex's rollout records establishes a sub-agent interval: no turn is marked as belonging to a sub-agent, and nothing ties a child session to the session that dispatched it, so there are no intervals to overlap (DIS-004).";
  const result = verdict("subagent-concurrency", makeSession({ cli: "codex" }), {});
  assert.equal(result.evidence.reason, CODEX_REASON);
  // Both halves of the claim, asserted as MEANING rather than as bytes, so the
  // next rewording has to keep saying both of them — and the result may not
  // quietly become a pass.
  assert.equal(result.evidence.status, "unknown");
  assert.match(result.evidence.reason, /no turn is marked as belonging to a sub-agent/);
  assert.match(result.evidence.reason, /nothing ties a child session to the session that dispatched it/);
});

test("the five BP-004 fix ids are the only ones any rule points at", () => {
  const known = new Set(["claude-auto-compact", "claude-output-hygiene", "claude-batch-commands", "claude-worker-cap", "claude-compact-contract"]);
  for (const rule of RULES) {
    if (rule.fix !== null) assert.ok(known.has(rule.fix), `${rule.id} points at unknown fix ${rule.fix}`);
  }
  assert.equal(ruleById("context-pressure").fix, "claude-auto-compact");
  assert.equal(ruleById("cache-hit").fix, "claude-output-hygiene");
  assert.equal(ruleById("repeat-tool").fix, "claude-batch-commands");
  assert.equal(ruleById("large-tool-result").fix, "claude-output-hygiene");
  assert.equal(ruleById("long-rising-context").fix, "claude-compact-contract");
  assert.equal(ruleById("subagent-concurrency").fix, "claude-worker-cap");
});

test("long-rising-context is the only critical rule; the rest warn", () => {
  assert.equal(ruleById("long-rising-context").severity, "critical");
  for (const rule of RULES) {
    if (rule.id !== "long-rising-context") assert.equal(rule.severity, "warn", `${rule.id}`);
  }
});

// ===========================================================================
// BP-003.01 context-pressure
// ===========================================================================

test("context-pressure: average above 0.70 of a real window is observed", () => {
  const result = verdict("context-pressure", contextHeavy);
  assert.equal(result.evidence.status, "observed");
  assert.equal(valueOf(result, "average per-turn context"), 85000);
  assert.equal(valueOf(result, "average context as a share"), 0.85);
  assert.equal(result.evidence.values.find((v) => v.label.includes("share of the window")).windowSource, "model-table");
});

test("context-pressure: average below 0.70 is not-observed, and the numbers are still reported", () => {
  const result = verdict("context-pressure", contextCalm);
  assert.equal(result.evidence.status, "not-observed");
  assert.equal(result.evidence.reason, null);
  assert.equal(valueOf(result, "average context as a share"), 0.15);
});

test("context-pressure: an observed-floor window yields unknown, NOT a warn (F-014 / BP-002.18)", () => {
  const result = verdict("context-pressure", contextObservedFloor);
  assertUnknownWithReason(result, "1.0");
  // The failure this guards: floor/floor is 1.0, which would clear 0.70.
  assert.notEqual(result.evidence.status, "observed");
  assert.ok(!result.evidence.values.some((value) => value.unit === "fraction"), "no fraction may be emitted from an observed-floor window");
  // The number itself is still shown, as the lower bound it is.
  assert.equal(valueOf(result, "lower bound on the window"), 41344);
});

test("context-pressure: a trivial observed-floor session is unknown too, not 100% of window", () => {
  const result = verdict("context-pressure", contextObservedFloorTiny);
  assert.equal(result.evidence.status, "unknown");
  assert.ok(result.evidence.reason.includes("BP-002.18") || result.evidence.reason.includes("F-014"));
});

test("context-pressure: a native-fraction-shaped session with a null window still evaluates (DIS-005)", () => {
  const high = verdict("context-pressure", nativeFractionHigh);
  assert.equal(high.evidence.status, "observed");
  assert.equal(valueOf(high, "average native context fraction"), 0.9);
  assert.equal(high.evidence.values.find((v) => v.label.includes("average native")).windowSource, "native");
  assert.ok(high.evidence.derivation.includes("DIS-005"));

  const low = verdict("context-pressure", nativeFractionLow);
  assert.equal(low.evidence.status, "not-observed");
  assert.equal(valueOf(low, "average native context fraction"), 0.15);

  // No absolute token count may be invented from a fraction.
  for (const result of [high, low]) {
    assert.ok(!result.evidence.values.some((value) => value.unit === "tokens"), "a fraction must not be converted into tokens");
  }
});

test("context-pressure: a native fraction above 1.0 is unknown, neither rescaled nor clamped", () => {
  const result = verdict("context-pressure", fractionAboveOne);
  assertUnknownWithReason(result, "above 1.0");
  assert.ok(!result.evidence.values.some((value) => value.value === 0.42 || value.value === 1));
});

test("context-pressure: no window and no fraction is unknown", () => {
  assertUnknownWithReason(verdict("context-pressure", contextNoWindowNoFraction), "no native context fraction");
});

test("context-pressure: a promotion with no known tier behind it is unknown (BP-002.14)", () => {
  const result = verdict("context-pressure", contextPromotedNoLadder, { promotion: { ladder: "none" } });
  assertUnknownWithReason(result, "BP-002.18");
  // With a real vendor tier behind the same window, the fraction IS a measurement.
  const promoted = verdict("context-pressure", contextPromotedNoLadder, { promotion: { ladder: "vendor" } });
  assert.equal(promoted.evidence.status, "observed");
});

test("context-pressure: a known window with no context reading anywhere is unknown, not 0.00", () => {
  const session = makeSession({ window: { tokens: 200000, source: "model-table" }, turns: [{ ts: at(1) }] });
  const result = verdict("context-pressure", session);
  assertUnknownWithReason(result, "nothing to express as a share of it");
});

test("context-pressure: no fraction this rule can emit ever exceeds 1.0", () => {
  for (const session of [contextHeavy, contextCalm, nativeFractionHigh, contextPromotedNoLadder]) {
    for (const value of verdict("context-pressure", session, { promotion: { ladder: "vendor" } }).evidence.values) {
      if (value.unit === "fraction") assert.ok(value.value <= 1, `${value.label} = ${value.value}`);
    }
  }
});

// ===========================================================================
// BP-003.02 cache-hit
// ===========================================================================

test("cache-hit: a rate below 0.85 is observed", () => {
  const result = verdict("cache-hit", cacheLow);
  assert.equal(result.evidence.status, "observed");
  assert.equal(valueOf(result, "cache hit rate"), 0.1);
});

test("cache-hit: a rate at or above 0.85 is not-observed", () => {
  const result = verdict("cache-hit", cacheHigh);
  assert.equal(result.evidence.status, "not-observed");
  assert.equal(valueOf(result, "cache hit rate"), 0.95);
});

test("cache-hit: reads with no cache-creation figure is unknown, NOT a perfect 1.00", () => {
  const result = verdict("cache-hit", cacheReadsOnly);
  assertUnknownWithReason(result, "1.00");
  assert.ok(!result.evidence.values.some((value) => value.value === 1 && value.unit === "ratio"));
});

test("cache-hit: creations with no read figure is unknown, NOT a damning 0.00", () => {
  assertUnknownWithReason(verdict("cache-hit", cacheCreatesOnly), "0.00");
});

test("cache-hit: both counters present and zero is unknown, because 0/0 is not a rate", () => {
  assertUnknownWithReason(verdict("cache-hit", cacheAllZero), "no cache traffic");
});

test("cache-hit: no cache counters at all is unknown", () => {
  assertUnknownWithReason(verdict("cache-hit", contextHeavy), "neither a cache-read nor a cache-creation");
});

// ===========================================================================
// BP-003.03 repeat-tool
// ===========================================================================

test("repeat-tool: five identical tool call + input + result triples is observed", () => {
  const result = verdict("repeat-tool", repeatFive);
  assert.equal(result.evidence.status, "observed");
  assert.equal(valueOf(result, "highest number of identical"), 5);
});

test("repeat-tool: four is not-observed when every result was attributable", () => {
  const result = verdict("repeat-tool", repeatFour);
  assert.equal(result.evidence.status, "not-observed");
  assert.equal(valueOf(result, "highest number of identical"), 4);
});

test("repeat-tool: a same INPUT run whose results differ is not a repeat", () => {
  const session = makeSession({
    turns: [4096, 5000, 6000, 7000, 8000, 9000].map((bytes, index) => ({
      ts: at(index + 1),
      toolCalls: [call("Bash", { command: "git status" })],
      toolResultBytes: bytes,
    })),
  });
  const result = verdict("repeat-tool", session);
  assert.equal(result.evidence.status, "not-observed", "six identical inputs with six different results must not fire");
  assert.equal(valueOf(result, "highest number of identical"), 1);
});

test("repeat-tool: a session with tool calls but no result bytes is unknown (DIS-003/DIS-006)", () => {
  const result = verdict("repeat-tool", toolCallsNoResultBytes);
  assertUnknownWithReason(result, "DIS-003");
  assert.equal(valueOf(result, "calls with an attributable result signature"), 0);
  // The trap: three identical INPUTS are present. Input-only matching is refused.
  assert.ok(result.evidence.reason.includes("input"), result.evidence.reason);
});

test("repeat-tool: partial coverage under the threshold is unknown, not a pass", () => {
  const result = verdict("repeat-tool", repeatPartialCoverage);
  assertUnknownWithReason(result, "cannot be separated");
});

test("repeat-tool: zero tool calls is unknown without corpus evidence, and a pass with it", () => {
  assertUnknownWithReason(verdict("repeat-tool", noToolCalls), "parser gap");
  assert.equal(status("repeat-tool", noToolCalls, { toolCallsRecorded: true }), "not-observed");
});

test("repeat-tool: identical input objects with differently ordered keys count as the same input", () => {
  const session = makeSession({
    turns: [
      { ts: at(1), toolCalls: [call("Bash", { command: "ls", cwd: "/a" })], toolResultBytes: 10 },
      { ts: at(2), toolCalls: [call("Bash", { cwd: "/a", command: "ls" })], toolResultBytes: 10 },
      { ts: at(3), toolCalls: [call("bash", { command: "ls", cwd: "/a" })], toolResultBytes: 10 },
      { ts: at(4), toolCalls: [call("BASH", { cwd: "/a", command: "ls" })], toolResultBytes: 10 },
      { ts: at(5), toolCalls: [call("Bash", { command: "ls", cwd: "/a" })], toolResultBytes: 10 },
    ],
  });
  assert.equal(status("repeat-tool", session), "observed");
});

test("repeat-tool: five equal-LENGTH results still fire, and nothing claims the results themselves were identical", () => {
  // The reproducing input: the same Read of the same path five times, each
  // result 4,096 bytes — one character swapped in the file between calls, so
  // the BODIES differ. The group key is tool name + input + the turn's result
  // byte length, so this is counted, and the algorithm is deliberately left
  // alone: the normalized turn does not retain result bodies to hash. What was
  // wrong is the WORDING, which promised the user "same result".
  const turns = Array.from({ length: 5 }, (_, index) => ({
    ts: at(index + 1),
    toolCalls: [call("Read", { file: "a.txt" })],
    toolResultBytes: 4096,
  }));
  const result = verdict("repeat-tool", makeSession({ turns }));
  assert.equal(result.evidence.status, "observed");
  assert.equal(result.magnitude, 5);
  assert.equal(valueOf(result, "highest number of identical"), 5);
  // The evidence row always disclosed the substitution; now the sentence the
  // user reads does too, instead of contradicting it.
  assert.match(result.evidence.derivation, /byte length stands in for the result body/i);
  assert.match(result.plain.problem, /same size/i);
  assert.ok(
    !/same result/i.test(result.plain.problem),
    `the plain sentence still tells the user the results were the same: ${result.plain.problem}`,
  );
});

test("repeat-tool's stated rationale matches what the group key actually measures", () => {
  // The derivation used to justify the rule with a guarantee it does not keep:
  // that same-input-alone is not enough "because a command re-run after an edit
  // legitimately returns something new" — while an edit that preserves the
  // length was counted as a repeat anyway. The rationale now says what is
  // matched, and states that cost rather than burying it.
  const rule = ruleById("repeat-tool");
  const claims = `${rule.description} ${rule.threshold.derivation} ${rule.plain.problem}`;
  assert.ok(!/same result/i.test(claims), `repeat-tool still promises the result itself was the same: ${claims}`);
  assert.match(rule.threshold.derivation, /size|length/i);
  assert.match(
    rule.threshold.derivation,
    /length unchanged|same size are grouped/i,
    "the derivation does not admit that a length-preserving edit is counted",
  );
  // The hedge that keeps this a DETECTED repetition, not confirmed waste, stays.
  assert.match(rule.plain.why, /detected repetition/i);
  assert.match(rule.plain.why, /confirmed waste/i);
});

// ===========================================================================
// BP-003.04 large-tool-result
// ===========================================================================

test("large-tool-result: three results over 10,240 bytes is observed", () => {
  const result = verdict("large-tool-result", bigResults);
  assert.equal(result.evidence.status, "observed");
  assert.equal(valueOf(result, "totalled more than"), 3);
  assert.equal(valueOf(result, "largest tool result"), 44000);
});

test("large-tool-result: small results with full coverage is not-observed", () => {
  const result = verdict("large-tool-result", smallResults);
  assert.equal(result.evidence.status, "not-observed");
  assert.equal(valueOf(result, "totalled more than"), 0);
});

test("large-tool-result: a session with no result byte lengths yields unknown, never a zero (DIS-006)", () => {
  const result = verdict("large-tool-result", toolCallsNoResultBytes);
  assertUnknownWithReason(result, "DIS-006");
  assert.equal(valueOf(result, "turns with a recorded result byte length"), 0);
  assert.ok(!result.evidence.values.some((value) => value.label.includes("totalled more than")), "no oversized count may be reported when nothing was measured");
});

test("large-tool-result: two oversized plus one unmeasured turn is unknown, not a pass", () => {
  const result = verdict("large-tool-result", bigResultsPartialCoverage);
  assertUnknownWithReason(result, "incomplete");
});

test("large-tool-result: zero tool calls is unknown without corpus evidence, and a pass with it", () => {
  assertUnknownWithReason(verdict("large-tool-result", noToolCalls), "parser gap");
  assert.equal(status("large-tool-result", noToolCalls, { toolCallsRecorded: true }), "not-observed");
});

// ===========================================================================
// BP-003.05 long-rising-context
// ===========================================================================

test("long-rising-context: over 4h AND rising is observed", () => {
  const result = verdict("long-rising-context", longRising);
  assert.equal(result.evidence.status, "observed");
  assert.equal(valueOf(result, "session elapsed"), 6);
  assert.ok(valueOf(result, "context trend") > 0);
  assert.ok(result.evidence.derivation.includes("Theil-Sen"));
});

test("long-rising-context: long but compacting is not-observed", () => {
  const result = verdict("long-rising-context", longFalling);
  assert.equal(result.evidence.status, "not-observed");
  assert.ok(valueOf(result, "context trend") < 0);
});

test("long-rising-context: rising but short is not-observed, and both conditions are still reported", () => {
  const result = verdict("long-rising-context", shortRising);
  assert.equal(result.evidence.status, "not-observed");
  assert.ok(valueOf(result, "session elapsed") < 4);
  assert.ok(valueOf(result, "context trend") > 0, "the slope is reported even when duration is what failed");
});

test("long-rising-context: two observations is unknown — two points are not a trend", () => {
  assertUnknownWithReason(verdict("long-rising-context", twoObservations), "fewer than the 3");
});

test("long-rising-context: no timestamps is unknown even though context readings exist", () => {
  assertUnknownWithReason(verdict("long-rising-context", noTimestamps), "elapsed");
});

test("long-rising-context: one outlier turn cannot set the trend (Theil-Sen, not least squares)", () => {
  // Flat at 50,000 for twelve hours, with one 900,000 spike. Least squares
  // would read that as a steep rise; the median of pairwise slopes does not.
  const session = makeSession({
    startedAt: at(0),
    endedAt: at(720),
    turns: [
      { ts: at(0), inputTokens: 50000 },
      { ts: at(120), inputTokens: 50000 },
      { ts: at(240), inputTokens: 50000 },
      { ts: at(360), inputTokens: 900000 },
      { ts: at(480), inputTokens: 50000 },
      { ts: at(600), inputTokens: 50000 },
      { ts: at(720), inputTokens: 50000 },
    ],
  });
  const result = verdict("long-rising-context", session);
  assert.equal(result.evidence.status, "not-observed");
  assert.equal(valueOf(result, "context trend"), 0);
});

test("long-rising-context: a slope that cannot exist is unknown, never a pass", () => {
  // The reproducing input: five hours elapsed, three context readings, every
  // one of them stamped at the same instant. Theil-Sen skips pairs spanning
  // zero time, so it takes the median of an EMPTY set and returns null — which
  // used to fall straight through to not-observed, a PASS on the half of this
  // rule that was never measured.
  const session = makeSession({
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T05:00:00Z",
    turns: [
      { ts: "2026-01-01T02:00:00Z", inputTokens: 50000 },
      { ts: "2026-01-01T02:00:00Z", inputTokens: 50000 },
      { ts: "2026-01-01T02:00:00Z", inputTokens: 50000 },
    ],
  });
  const result = verdict("long-rising-context", session);
  assertUnknownWithReason(result, "the same time");
  assert.equal(result.evidence.reasonCode, "context-times-identical");
  // The trend row stays null. An unmeasurable slope is never rendered as a 0.
  assert.equal(valueOf(result, "context trend"), null);
  assert.equal(result.magnitude, null);
  // The half that WAS measured is still reported, and the reason says so.
  assert.equal(valueOf(result, "session elapsed"), 5);
  assert.match(result.evidence.reason, /elapsed time is known/i);
  assert.equal(typeof result.plain.unmeasured["context-times-identical"], "string");
});

test("long-rising-context: three readings at three DIFFERENT times still produce a slope", () => {
  // The neighbouring behaviour the unknown above must not swallow: the minimum
  // three points, spread in time, are still measured.
  const session = makeSession({
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T05:00:00Z",
    turns: [
      { ts: "2026-01-01T01:00:00Z", inputTokens: 40000 },
      { ts: "2026-01-01T02:00:00Z", inputTokens: 60000 },
      { ts: "2026-01-01T03:00:00Z", inputTokens: 90000 },
    ],
  });
  const result = verdict("long-rising-context", session);
  assert.equal(result.evidence.status, "observed");
  assert.ok(valueOf(result, "context trend") > 0, "a real slope over three distinct times");
});

test("long-rising-context: the published rate is whole tokens per hour, and an uncomputable one is still null", () => {
  // WHY: the trend row shipped `round(perHour, 1)` and rendered live as
  // "975,275.1 tokens per hour". A rate worked out from a token count and an
  // elapsed duration has no tenth-of-a-token to give; that digit was noise
  // wearing the clothes of a measurement. The contract is now whole tokens.
  //
  // These three readings are chosen so the RAW Theil-Sen median is genuinely
  // fractional — 20,001 / 25,001.5 / 30,002 tokens per hour, median 25,001.5 —
  // so a test that passed only because the arithmetic happened to land whole
  // would not pass here.
  const session = makeSession({
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T09:00:00Z",
    turns: [
      { ts: "2026-01-01T01:00:00Z", inputTokens: 40000 },
      { ts: "2026-01-01T02:00:00Z", inputTokens: 60001 },
      { ts: "2026-01-01T03:00:00Z", inputTokens: 90003 },
    ],
  });
  const result = verdict("long-rising-context", session);
  assert.equal(result.evidence.status, "observed");

  const trend = valueOf(result, "context trend");
  assert.equal(typeof trend, "number");
  assert.ok(Number.isInteger(trend), `context trend published ${trend} — a rate of tokens per hour carries no fractional part`);
  assert.equal(trend, 25002, "the whole-token rate is the raw 25,001.5 rounded, not truncated and not re-scaled");

  // The rendered form is what the reader sees, and it is where the stray
  // ".1" was visible. Guard it with the comma-aware pattern the earlier
  // sweep's `\d{4,}\.\d` could not match, because commas break the digit run.
  const rendered = trend.toLocaleString("en-US");
  assert.doesNotMatch(rendered, /(\d{1,3}(,\d{3})+|\d{4,})\.\d/, `"${rendered}" still renders a fractional token`);

  // Neighbouring behaviour this must not have swallowed: a rate that could
  // NOT be computed stays null. Rounding never turns an absence into a 0.
  const unmeasurable = verdict("long-rising-context", makeSession({
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T05:00:00Z",
    turns: [
      { ts: "2026-01-01T02:00:00Z", inputTokens: 50000 },
      { ts: "2026-01-01T02:00:00Z", inputTokens: 50000 },
      { ts: "2026-01-01T02:00:00Z", inputTokens: 50000 },
    ],
  }));
  assert.equal(unmeasurable.evidence.status, "unknown");
  assert.equal(valueOf(unmeasurable, "context trend"), null, "an unmeasurable rate is null, never 0");
  assert.notEqual(valueOf(unmeasurable, "context trend"), 0);
});

// ===========================================================================
// BP-003.06 subagent-concurrency
// ===========================================================================

test("subagent-concurrency: peak above half of dispatched is observed", () => {
  const result = verdict("subagent-concurrency", contextHeavy, { children: concurrentChildren });
  assert.equal(result.evidence.status, "observed");
  assert.equal(valueOf(result, "peak sub-agents"), 3);
  assert.equal(valueOf(result, "dispatched by this session"), 4);
  assert.equal(valueOf(result, "share of dispatched"), 0.75);
});

test("subagent-concurrency: sequential children are not concurrent, including one ending as the next begins", () => {
  const result = verdict("subagent-concurrency", contextHeavy, { children: sequentialChildren });
  assert.equal(result.evidence.status, "not-observed");
  assert.equal(valueOf(result, "peak sub-agents"), 1);
});

test("subagent-concurrency: ONE sub-agent running alone is not concurrent with anything", () => {
  // The reproducing input. One child with one interval: a peak of 1 out of 1
  // dispatched is a ratio of 1.0, which crossed the 0.5 line and told the user
  // that "100.0% of everything it dispatched" ran at the same moment. On the
  // real machine half of this rule's positives were exactly this shape. One
  // interval cannot overlap anything, so the ratio is not consulted at all.
  const oneChild = [
    { sessionId: "a", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T01:00:00Z", collected: true },
  ];
  const result = verdict("subagent-concurrency", contextHeavy, { children: oneChild });
  assert.equal(result.evidence.status, "not-observed");
  assert.equal(valueOf(result, "peak sub-agents"), 1);
  assert.equal(valueOf(result, "dispatched by this session"), 1);
  // The ratio is still REPORTED — it is the verdict that ignores it.
  assert.equal(valueOf(result, "share of dispatched"), 1);
  // And the evidence says plainly why 1 of 1 is not a finding, rather than
  // leaving a reader to wonder why a ratio of 1.0 passed.
  assert.match(result.evidence.derivation, /overlaps nothing/i);
  assert.match(result.evidence.derivation, /complete answer/i);
});

test("subagent-concurrency: two open together, above half of dispatched, is STILL observed", () => {
  // The neighbouring behaviour: the floor is a floor of TWO, and it does not
  // quietly raise the 0.5 threshold that was verified sound.
  const twoOfThree = [
    { sessionId: "a", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:30:00Z", collected: true },
    { sessionId: "b", startedAt: "2026-01-01T00:10:00Z", endedAt: "2026-01-01T00:40:00Z", collected: true },
    { sessionId: "c", startedAt: "2026-01-01T02:00:00Z", endedAt: "2026-01-01T02:10:00Z", collected: true },
  ];
  const result = verdict("subagent-concurrency", contextHeavy, { children: twoOfThree });
  assert.equal(result.evidence.status, "observed");
  assert.equal(valueOf(result, "peak sub-agents"), 2);
  assert.ok(valueOf(result, "share of dispatched") > 0.5);
});

test("subagent-concurrency: a peak under two still yields to the missing-interval unknown", () => {
  // Branch ORDER, not just branch presence: the new not-observed claims to be a
  // complete measurement, so it may only be reached when every dispatched
  // sub-agent carried an interval. An incomplete one stays unknown.
  const result = verdict("subagent-concurrency", contextHeavy, { children: childrenPartialIntervals });
  assert.equal(result.evidence.status, "unknown");
  assert.equal(result.evidence.reasonCode, "partial-subagent-times");
});

test("subagent-concurrency: children with no intervals is unknown — a count is not a concurrency", () => {
  const result = verdict("subagent-concurrency", contextHeavy, { children: childrenWithoutIntervals });
  assertUnknownWithReason(result, "how many ran at once");
});

test("subagent-concurrency: a below-threshold peak measured from only some intervals is unknown", () => {
  const result = verdict("subagent-concurrency", contextHeavy, { children: childrenPartialIntervals });
  assertUnknownWithReason(result, "can only be higher");
});

// A reason string is the product's honesty surface, so these pin the CLAIM, not
// just the presence of prose.  The claim changed when the collectors started
// reading sub-agent evidence (BP-003.07 / BP-003.08): what was a parser gap is
// now a scan-width limit (F-026), and the old text would send a reader to fix
// something already fixed.

/** Claims that were true before the collectors read sub-agent evidence, and are not now. */
const CLOSED_PARSER_GAP_CLAIMS = [
  "does not read",
  "does not expose",
  "not one sub-agent interval reaches the analyzer",
  "gap is in the parser",
];

/** An unknown may never be dressed up as a zero, however it is worded. */
const NOT_A_ZERO_DISCLAIMERS = [
  "not a claim that zero sub-agents were dispatched",
  "not proof that no sub-agent was dispatched",
];

function assertNoClosedParserGapClaim(reason, label) {
  for (const claim of CLOSED_PARSER_GAP_CLAIMS) {
    assert.ok(
      !reason.toLowerCase().includes(claim),
      `${label} reason still blames a parser gap that is closed ("${claim}"): ${reason}`,
    );
  }
}

function assertDoesNotClaimZeroDispatched(reason, label) {
  assert.ok(
    NOT_A_ZERO_DISCLAIMERS.some((phrase) => reason.toLowerCase().includes(phrase)),
    `${label} reason does not say that an empty child list is not a zero: ${reason}`,
  );
}

test("subagent-concurrency: Claude is unknown on scan width, not on an unread subagents directory", () => {
  const result = verdict("subagent-concurrency", sidechainMarkedSession, { sidechainTurns: 2 });
  // The directory is still named — it is where the evidence comes FROM now.
  assertUnknownWithReason(result, "subagents");
  assert.ok(result.evidence.reason.includes("isSidechain"));
  // The real cause today: the scan, not the parser (F-026).
  assert.ok(result.evidence.reason.includes("F-026"), `Claude reason does not name F-026: ${result.evidence.reason}`);
  assert.ok(result.evidence.reason.includes("ARE read"), `Claude reason does not say the transcripts are read: ${result.evidence.reason}`);
  assertNoClosedParserGapClaim(result.evidence.reason, "Claude");
  assertDoesNotClaimZeroDispatched(result.evidence.reason, "Claude");
  assert.equal(valueOf(result, "marked as belonging to a sub-agent"), 2);
});

test("subagent-concurrency: an unknown from a CLI whose sub-agent evidence IS read names the scan, never a parser gap", () => {
  // Claude reads sub-agent evidence (BP-003.07); any other CLI falls to the
  // generic structural reason instead.
  for (const cli of ["claude"]) {
    const session = makeSession({ cli, turns: [{ ts: at(1) }] });
    // Every shape of "nothing collected" this rule can be handed: no linkage
    // row at all, a bounded scan, a complete scan, and sub-agent reading off.
    const contexts = [
      {},
      { childLinkageAvailable: true, corpusComplete: false, sessionMeta: { subagentSessionIds: [] } },
      { childLinkageAvailable: false, corpusComplete: true, sessionMeta: { subagentSessionIds: [] } },
      { childLinkageAvailable: true, corpusComplete: false, sessionMeta: { subagentSessionIds: null } },
    ];
    for (const ctx of contexts) {
      const result = verdict("subagent-concurrency", session, ctx);
      const label = `${cli} with ctx ${JSON.stringify(ctx)}`;
      assert.equal(result.evidence.status, "unknown", label);
      assert.ok(result.evidence.reason.length > 40, `${label} reason too thin: ${result.evidence.reason}`);
      assertNoClosedParserGapClaim(result.evidence.reason, label);
      assertDoesNotClaimZeroDispatched(result.evidence.reason, label);
    }
  }
});

test("subagent-concurrency: the Codex reason is untouched — its gap is structural, not a parser gap (DIS-004)", () => {
  for (const cli of ["codex"]) {
    const result = verdict("subagent-concurrency", makeSession({ cli, turns: [{ ts: at(1) }] }));
    assertUnknownWithReason(result, "DIS-004");
    assert.ok(result.evidence.reason.includes("establishes a sub-agent interval"), `${cli}: ${result.evidence.reason}`);
    assert.ok(!result.evidence.reason.includes("F-026"), `${cli} must not blame scan width: ${result.evidence.reason}`);
    assertNoClosedParserGapClaim(result.evidence.reason, cli);
  }
});

test("subagent-concurrency: Claude with no children is unknown while a limit could have cut them off, and not-observed once the whole corpus was scanned", () => {
  const session = makeSession({ cli: "claude", turns: [{ ts: at(1) }] });
  assertUnknownWithReason(verdict("subagent-concurrency", session, { childLinkageAvailable: true, corpusComplete: false }), "bounded rather than complete");
  const complete = verdict("subagent-concurrency", session, { childLinkageAvailable: true, corpusComplete: true });
  assert.equal(complete.evidence.status, "not-observed");
  assert.equal(valueOf(complete, "linked to this session"), 0);
});

// ===========================================================================
// the honesty contract, across all rules
// ===========================================================================

test("every rule returns a status from the triad and nothing else", () => {
  const sessions = [contextHeavy, contextObservedFloor, nativeFractionHigh, toolCallsNoResultBytes, cacheReadsOnly, longRising, noToolCalls, makeSession({ turns: [] })];
  for (const session of sessions) {
    for (const rule of RULES) {
      const result = evaluateRule(rule, session);
      assert.ok(EVIDENCE_STATUSES.includes(result.evidence.status), `${rule.id} returned ${result.evidence.status}`);
    }
  }
});

test("every unknown carries a reason, in every rule, on every fixture", () => {
  const sessions = [contextHeavy, contextObservedFloor, contextObservedFloorTiny, nativeFractionHigh, fractionAboveOne, toolCallsNoResultBytes, cacheReadsOnly, cacheAllZero, longRising, twoObservations, noTimestamps, noToolCalls, repeatPartialCoverage, bigResultsPartialCoverage, makeSession({ turns: [] })];
  let unknowns = 0;
  for (const session of sessions) {
    for (const rule of RULES) {
      const result = evaluateRule(rule, session);
      if (result.evidence.status !== "unknown") { assert.equal(result.evidence.reason, null, `${rule.id} set a reason on a ${result.evidence.status} verdict`); continue; }
      unknowns += 1;
      assert.equal(typeof result.evidence.reason, "string", `${rule.id} unknown with no reason`);
      assert.ok(result.evidence.reason.trim().length > 40, `${rule.id} reason too thin: ${result.evidence.reason}`);
    }
  }
  assert.ok(unknowns > 20, `expected the fixtures to exercise many unknown paths, got ${unknowns}`);
});

test("a rule that throws becomes unknown with the error in the reason, never a pass", () => {
  const exploding = { ...ruleById("cache-hit"), evaluate() { throw new Error("boom"); } };
  const result = evaluateRule(exploding, contextHeavy);
  assertUnknownWithReason(result, "boom");
  assert.ok(result.evidence.reason.includes("never as a pass"));
});

test("a rule returning an unrecognised status is coerced to unknown and says so", () => {
  const liar = { ...ruleById("cache-hit"), evaluate() { return { status: "fine", values: [], derivation: null }; } };
  const result = evaluateRule(liar, contextHeavy);
  assertUnknownWithReason(result, "not one of observed");
});

test("a rule returning unknown with no reason still gets an explicit reason", () => {
  const terse = { ...ruleById("cache-hit"), evaluate() { return { status: "unknown", values: [] }; } };
  const result = evaluateRule(terse, contextHeavy);
  assertUnknownWithReason(result, "NOT a pass");
});

test("no rule ever emits a zero as the evidence for an unmeasurable check", () => {
  // The specific failure: a count of 0 that a reader takes for "none happened".
  const unmeasurable = [
    verdict("large-tool-result", toolCallsNoResultBytes),
    verdict("repeat-tool", toolCallsNoResultBytes),
    verdict("cache-hit", cacheReadsOnly),
    verdict("context-pressure", contextObservedFloor),
  ];
  for (const result of unmeasurable) {
    assert.equal(result.evidence.status, "unknown");
    for (const value of result.evidence.values) {
      if (value.value !== 0) continue;
      // A zero is allowed only where its label says it counts what WAS measured.
      assert.ok(/attributable|recorded result byte length/i.test(value.label), `an unexplained zero survives on an unknown verdict: ${value.label}`);
    }
  }
});

// ===========================================================================
// analyzeSession: all six rules, always, and a score that cannot hide unknowns
// ===========================================================================

test("analyzeSession emits all six rules for every session, whatever the verdicts", () => {
  for (const session of [contextHeavy, contextObservedFloor, nativeFractionHigh, toolCallsNoResultBytes, makeSession({ turns: [] })]) {
    const health = analyzeSession(session);
    assert.equal(health.rules.length, 6);
    assert.deepEqual([...health.rules.map((rule) => rule.id)].sort(), [...RULE_IDS].sort());
  }
});

test("analyzeSession ranks observed rules first, then unmeasurable, then passes", () => {
  const health = analyzeSession(bigResults, { toolCallsRecorded: true });
  const order = health.rules.map((rule) => rule.evidence.status);
  const rank = { observed: 0, unknown: 1, "not-observed": 2 };
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(rank[order[index - 1]] <= rank[order[index]], `out of order: ${order.join(" ")}`);
  }
});

test("an unknown never counts toward the score, and the score always states how many there were", () => {
  const health = analyzeSession(toolCallsNoResultBytes);
  const { score } = health;
  assert.equal(score.total, 6);
  assert.equal(score.passed + score.observed + score.unknown, 6);
  const unknownRules = health.rules.filter((rule) => rule.evidence.status === "unknown").length;
  assert.equal(score.unknown, unknownRules);
  assert.ok(score.unknown > 0, "this fixture exists to produce unknowns");
  assert.equal(score.passed, health.rules.filter((rule) => rule.evidence.status === "not-observed").length);
  assert.ok(score.label.includes(`${score.unknown} could not be measured`), score.label);
});

test("a session where nothing could be measured scores 0 of 6 passed, not 6 of 6", () => {
  const health = analyzeSession(makeSession({ turns: [] }));
  assert.equal(health.score.passed, 0);
  assert.equal(health.score.unknown, 6);
  assert.equal(health.score.label, "0 of 6 checks passed, 0 problems observed, 6 could not be measured");
});

test("analyzeSession carries the window promotion through, so a stale table entry stays visible", () => {
  const promotion = { modelId: "claude-opus-5", tableTokens: 200000, tokens: 1000000, ladder: "vendor" };
  const health = analyzeSession(contextHeavy, { promotion });
  assert.deepEqual(health.windowPromotion, promotion);
});

// ===========================================================================
// analyzeAll over a collected corpus
// ===========================================================================

function corpus() {
  const claudeSessions = [contextHeavy, longRising, bigResults];
  const codexSessions = [toolCallsNoResultBytes];
  const cursorSessions = [contextObservedFloor];
  return makeCollected({
    supported: [
      { id: "claude", displayName: "Claude Code", sessions: claudeSessions, installed: true, paths: [], status: "supported" },
      { id: "codex", displayName: "Codex", sessions: codexSessions, installed: true, paths: [], status: "supported" },
      {
        id: "cursor",
        displayName: "Cursor CLI",
        sessions: cursorSessions,
        installed: true,
        paths: [],
        status: "supported",
        sessionMeta: {
          [cursorSessions[0].sessionId]: { sessionId: cursorSessions[0].sessionId, parentSessionId: null },
        },
      },
    ],
    detectionOnly: [{ id: "antigravity", displayName: "Antigravity CLI", installed: true, paths: [], status: "detection-only" }],
    absent: [{ id: "widget", displayName: "Widget", installed: false, paths: [], status: "absent" }],
    diagnostics: [promotionDiagnostic("claude", contextHeavy.sessionId)],
  });
}

test("analyzeAll analyzes every supported session and reports every collector", () => {
  const out = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  assert.equal(out.sessions.length, 5);
  assert.deepEqual(out.collectors.map((entry) => entry.cli), ["claude", "codex", "cursor", "antigravity", "widget"]);
  assert.equal(out.collectors.find((entry) => entry.cli === "antigravity").sessions, null, "a detection-only CLI has no session count, and null is not zero");
  assert.equal(out.collectors.find((entry) => entry.cli === "widget").support, "detection-only");
  assert.equal(out.collectors.find((entry) => entry.cli === "widget").installed, false);
});

test("a detection-only collector reason reaches the health note unchanged", () => {
  const reason = "Cursor's configuration directory is here, but no Cursor CLI chat store was found under it. SessionRx reads the Cursor CLI (cursor-agent); the Cursor desktop editor keeps its chat history separately and is not read here. No sessions were read, which is not the same as no usage.";
  const out = analyzeAll({ detectionOnly: [{ id: "cursor", reason }] });
  assert.equal(out.collectors.find((entry) => entry.cli === "cursor").note, reason);
});

test("collector support is identical whether the CLI is installed or absent", () => {
  const cliSet = ["claude", "codex", "antigravity", "cursor", "widget"];
  const installed = analyzeAll({
    supported: [{ id: "claude", sessions: [contextHeavy] }],
    detectionOnly: [{ id: "antigravity" }],
    absent: [{ id: "codex" }, { id: "cursor" }, { id: "widget" }],
  });

  const absent = analyzeAll({
    absent: cliSet.map((id) => ({ id, status: "absent" })),
  });
  const installedByCli = new Map(installed.collectors.map((entry) => [entry.cli, entry]));
  const absentByCli = new Map(absent.collectors.map((entry) => [entry.cli, entry]));

  assert.deepEqual([...installedByCli.keys()].sort(), cliSet.slice().sort());
  assert.deepEqual([...absentByCli.keys()].sort(), cliSet.slice().sort());
  for (const cli of cliSet) {
    assert.equal(absentByCli.get(cli).support, installedByCli.get(cli).support, `${cli} support changed with installation state`);
  }
  assert.equal(installedByCli.get("claude").installed, true);
  assert.equal(installedByCli.get("antigravity").installed, true);
  for (const cli of cliSet) assert.equal(absentByCli.get(cli).installed, false, `${cli} absent state changed`);
  assert.equal(absentByCli.get("antigravity").support, "detection-only");
  assert.equal(absentByCli.get("codex").support, "supported");
  assert.equal(absentByCli.get("cursor").support, "supported");
  assert.equal(absentByCli.get("widget").support, "detection-only");
});

test("an absent installation never carries a session count", () => {
  const out = analyzeAll(corpus());
  for (const entry of out.collectors) {
    if (entry.installed === false) assert.equal(entry.sessions, null, `${entry.cli} has an absent installation and a session count`);
  }
});

test("analyzeAll surfaces windowPromotions in the per-CLI note, rather than silently correcting the table", () => {
  const out = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  const claude = out.collectors.find((entry) => entry.cli === "claude");
  // RE-AIMED (wave WJARG): the note no longer quotes the id at the user, so the
  // claim under test is the same one in plain words — the promotion is SURFACED.
  assert.ok(claude.note.includes("worked out from what was observed instead"), claude.note);
  assert.ok(!/BP-\d/.test(claude.note), `the note must not quote an internal id at the user: ${claude.note}`);
  assert.ok(claude.note.includes("200,000"), claude.note);
  assert.ok(claude.note.includes("1,000,000"), claude.note);
  assert.ok(claude.note.includes("stale"), claude.note);
  assert.equal(out.promotions.length, 1);
  assert.equal(out.promotions[0].cli, "claude");
  const promoted = out.sessions.find((session) => session.sessionId === contextHeavy.sessionId);
  assert.equal(promoted.windowPromotion.tokens, 1000000);
});

test("analyzeAll only claims a measured zero for sub-agents when the corpus was not cut off by a limit", () => {
  const withLimit = analyzeAll(corpus(), { limit: 1 });
  const withoutLimit = analyzeAll(corpus());
  const cursorOf = (out) => out.sessions.find((session) => session.cli === "cursor")
    .rules.find((rule) => rule.id === "subagent-concurrency").evidence.status;
  assert.equal(withLimit.sessions.length, 5);
  assert.equal(cursorOf(withLimit), "unknown");
  assert.equal(cursorOf(withoutLimit), "not-observed");
});

test("analyzeAll counts a limited collection in the note, so a partial corpus is visible", () => {
  const out = analyzeAll(corpus(), { limit: 1 });
  assert.ok(out.collectors.find((entry) => entry.cli === "claude").note.includes("collection limit of 1"));
});

test("the aggregate reports a rule as observed while still stating how many sessions were unmeasurable", () => {
  const out = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  const aggregate = out.reportInput.rules.find((rule) => rule.id === "large-tool-result");
  assert.equal(aggregate.evidence.status, "observed");
  const unmeasurable = aggregate.evidence.values.find((value) => value.label.includes("could NOT be measured"));
  assert.ok(unmeasurable, "the unmeasurable count must travel with an observed verdict");
  assert.ok(unmeasurable.value >= 1, `expected unmeasurable sessions, got ${unmeasurable.value}`);
  assert.ok(aggregate.evidence.values.some((value) => value.label === "sessions checked" && value.value === 5));
});

test("the aggregate is unknown, with a counted reason, when nothing was observed and something was unmeasurable", () => {
  const out = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  const aggregate = out.reportInput.rules.find((rule) => rule.id === "subagent-concurrency");
  assert.equal(aggregate.evidence.status, "unknown");
  assert.ok(/\d+ of \d+ sessions could not be measured/.test(aggregate.evidence.reason), aggregate.evidence.reason);
  assert.ok(aggregate.evidence.reason.includes("Most common reason"), aggregate.evidence.reason);
});

test("all six rules reach the report input, ranked observed-first, even when four of them are unknown", () => {
  const out = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  assert.equal(out.reportInput.rules.length, 6);
  assert.deepEqual([...out.reportInput.rules.map((rule) => rule.id)].sort(), [...RULE_IDS].sort());
  const rank = { observed: 0, unknown: 1, "not-observed": 2 };
  const statuses = out.reportInput.rules.map((rule) => rule.evidence.status);
  for (let index = 1; index < statuses.length; index += 1) {
    assert.ok(rank[statuses[index - 1]] <= rank[statuses[index]], statuses.join(" "));
  }
  // Within observed, critical outranks warn (the generator does not re-rank).
  const observed = out.reportInput.rules.filter((rule) => rule.evidence.status === "observed");
  if (observed.length > 1 && observed.some((rule) => rule.severity === "critical")) {
    assert.equal(observed[0].severity, "critical");
  }
});

test("an empty corpus is unknown on all six rules, never six passes", () => {
  const out = analyzeAll(makeCollected(), { generatedAt: "2026-09-20T16:00:00Z" });
  assert.equal(out.sessions.length, 0);
  assert.equal(out.reportInput.rules.length, 6);
  for (const rule of out.reportInput.rules) {
    assert.equal(rule.evidence.status, "unknown", rule.id);
    // RE-AIMED (wave WJARG): "an empty corpus is not a clean corpus" said this in
    // the analyzer's own vocabulary. The rewrite must still refuse to read as a
    // pass, so that refusal is what is asserted — in the new wording, and by
    // rejecting the reassurance an empty run must never offer.
    assert.ok(
      rule.evidence.reason.includes("not the same as finding nothing wrong"),
      rule.evidence.reason,
    );
    assert.ok(
      !/all clear|nothing to worry about|looks fine|no problems found/i.test(rule.evidence.reason),
      `an empty run must not read as a pass: ${rule.evidence.reason}`,
    );
  }
});

// ===========================================================================
// F-023 — a sub-agent session is evidence ABOUT its parent, not a peer OF it
// ===========================================================================

/**
 * Two sessions the user started and six sub-agent sessions, shaped like the
 * real corpus: `sessionMeta` names the parent, and the sub-agent's interval
 * lives on the sub-agent SESSION, which is why it has to be collected.
 *
 *   parent-1  <- child-a, child-b, child-c   (three overlapping: observed)
 *                child-a <- grandchild       (a sub-agent of a sub-agent)
 *   parent-2  <- child-d, child-e            (two sequential: not-observed)
 *   (nothing) <- orphan                      (names a parent this scan did not read)
 */
function subagentCorpus() {
  const parentOne = makeSession({ sessionId: "parent-1", startedAt: at(0), endedAt: at(60), turns: [{ ts: at(1), inputTokens: 1000, toolCalls: [call("Task", { a: 1 })] }] });
  const parentTwo = makeSession({ sessionId: "parent-2", startedAt: at(0), endedAt: at(60), turns: [{ ts: at(1), inputTokens: 1000, toolCalls: [call("Task", { b: 2 })] }] });
  const childA = makeSession({ sessionId: "child-a", startedAt: at(0), endedAt: at(30), turns: [{ ts: at(2), inputTokens: 500 }] });
  const childB = makeSession({ sessionId: "child-b", startedAt: at(5), endedAt: at(35), turns: [{ ts: at(6), inputTokens: 500 }] });
  const childC = makeSession({ sessionId: "child-c", startedAt: at(10), endedAt: at(40), turns: [{ ts: at(11), inputTokens: 500 }] });
  const childD = makeSession({ sessionId: "child-d", startedAt: at(0), endedAt: at(10), turns: [{ ts: at(2), inputTokens: 500 }] });
  const childE = makeSession({ sessionId: "child-e", startedAt: at(20), endedAt: at(30), turns: [{ ts: at(22), inputTokens: 500 }] });
  const grandchild = makeSession({ sessionId: "grandchild", startedAt: at(1), endedAt: at(9), turns: [{ ts: at(2), inputTokens: 250 }] });
  const orphan = makeSession({ sessionId: "orphan", startedAt: at(0), endedAt: at(5), turns: [{ ts: at(1), inputTokens: 250 }] });

  const sessions = [parentOne, parentTwo, childA, childB, childC, childD, childE, grandchild, orphan];
  const parentOf = {
    "parent-1": null,
    "parent-2": null,
    "child-a": "parent-1",
    "child-b": "parent-1",
    "child-c": "parent-1",
    "child-d": "parent-2",
    "child-e": "parent-2",
    grandchild: "child-a",
    orphan: "parent-never-collected",
  };
  const sessionMeta = {};
  for (const session of sessions) {
    sessionMeta[session.sessionId] = { sessionId: session.sessionId, parentSessionId: parentOf[session.sessionId] };
  }
  return makeCollected({
    supported: [{ id: "claude", displayName: "Claude Code", sessions, installed: true, paths: [], status: "supported", sessionMeta }],
  });
}

const ownIds = (out) => out.sessions.map((session) => session.sessionId).sort();
const rule6 = (session) => session.rules.find((rule) => rule.id === "subagent-concurrency");

test("F-023: sub-agent sessions are kept out of the session list and the session count", () => {
  const out = analyzeAll(subagentCorpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  assert.deepEqual(ownIds(out), ["parent-1", "parent-2"], "only the sessions the user started are listed");
  assert.equal(out.sessions.length, 2);
  assert.equal(out.reportInput.range.sessions, 2, "the headline count is the user's own sessions");
  assert.equal(out.collectors.find((entry) => entry.cli === "claude").sessions, 2);
  for (const session of out.sessions) {
    assert.equal(session.isSubagentSession, false);
    assert.equal(session.parentSessionId, null);
  }
});

test("F-023: every sub-agent session set aside is still analyzed, counted and reachable", () => {
  const out = analyzeAll(subagentCorpus(), { generatedAt: "2026-09-20T16:00:00Z" });

  // counted — 6 real sessions may not vanish quietly
  assert.equal(out.subagentSessions.length, 7);
  assert.equal(out.subagentSessionsSetAside.total, 7);
  assert.equal(out.subagentSessionsSetAside.orphans, 1);
  assert.deepEqual(out.subagentSessionsSetAside.byCli, [{ cli: "claude", count: 7, orphans: 1 }]);
  assert.equal(out.collectors.find((entry) => entry.cli === "claude").subagentSessions, 7);
  assert.equal(out.reportInput.range.subagentSessions, 7);
  assert.equal(out.reportInput.clis.find((entry) => entry.cli === "claude").subagentSessions, 7);

  // reachable — under the parent that launched it, nesting included
  const byId = new Map(out.sessions.map((session) => [session.sessionId, session]));
  assert.deepEqual(byId.get("parent-1").subagentSessions.map((s) => s.sessionId), ["child-a", "child-b", "child-c"]);
  assert.deepEqual(byId.get("parent-2").subagentSessions.map((s) => s.sessionId), ["child-d", "child-e"]);
  const childA = byId.get("parent-1").subagentSessions.find((s) => s.sessionId === "child-a");
  assert.deepEqual(childA.subagentSessions.map((s) => s.sessionId), ["grandchild"], "a sub-agent of a sub-agent sits under its real parent, not at the top");

  // analyzed in full — set aside is not the same as degraded
  for (const child of out.subagentSessions) {
    assert.equal(child.isSubagentSession, true);
    assert.equal(typeof child.parentSessionId, "string");
    assert.deepEqual(child.rules.map((rule) => rule.id).sort(), [...RULE_IDS].sort());
    assert.equal(child.score.total, 6);
  }

  // the orphan is set aside WITH the rest, never dropped for having no parent card
  const orphan = out.subagentSessions.find((session) => session.sessionId === "orphan");
  assert.ok(orphan, "a sub-agent whose parent was not scanned is still in the payload");
  assert.equal(ownIds(out).includes("orphan"), false, "and it is still not a session of the user's own");
});

test("F-023: rule 6 keeps every sub-agent interval — the verdict is identical to when children were peers", () => {
  const out = analyzeAll(subagentCorpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  const byId = new Map(out.sessions.map((session) => [session.sessionId, session]));

  const one = rule6(byId.get("parent-1"));
  assert.equal(one.evidence.status, "observed", "three overlapping sub-agents out of three dispatched is still observed");
  assert.equal(valueOf(one, "peak sub-agents running at the same time"), 3);
  assert.equal(valueOf(one, "sub-agent sessions dispatched by this session"), 3);
  assert.equal(valueOf(one, "linked sub-agent sessions with a usable interval"), 3, "excluding a child from the list must not exclude its interval");

  const two = rule6(byId.get("parent-2"));
  assert.equal(two.evidence.status, "not-observed", "two sequential sub-agents is a measured pass, not unknown");
  assert.equal(valueOf(two, "peak sub-agents running at the same time"), 1);

  // and the rule reaches a verdict for every session, own or set aside
  for (const session of [...out.sessions, ...out.subagentSessions]) {
    assert.notEqual(rule6(session).evidence.status, "unknown", `${session.sessionId} lost its rule 6 verdict`);
  }
});

test("F-023: corpus aggregates and top findings are about the user's own sessions", () => {
  const out = analyzeAll(subagentCorpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  const aggregate = out.reportInput.rules.find((rule) => rule.id === "subagent-concurrency");
  assert.equal(aggregate.evidence.status, "observed");
  assert.equal(aggregate.evidence.values.find((value) => value.label === "sessions checked").value, 2, "8 sessions were analyzed; 2 of them are the user's");
  assert.equal(aggregate.evidence.values.find((value) => value.label.includes("was observed")).value, 1);
  assert.equal(aggregate.evidence.values.find((value) => value.label.includes("could NOT be measured")).value, 0);
});

test("F-023: the per-CLI note states how many sessions were set aside and why, and names the orphan", () => {
  const out = analyzeAll(subagentCorpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  const note = out.collectors.find((entry) => entry.cli === "claude").note;
  assert.ok(note.includes("7 of the 9 sessions"), note);
  assert.ok(note.includes("set aside"), note);
  assert.ok(note.includes("evidence about that session"), note);
  assert.ok(/1 of them names a parent that this scan did not read/.test(note), note);
});

test("F-023: a CLI whose only sessions are sub-agents reports zero of its own, and says so", () => {
  const child = makeSession({ sessionId: "lonely-child", turns: [{ ts: at(1), inputTokens: 100 }] });
  const out = analyzeAll(
    makeCollected({
      supported: [{
        id: "claude", displayName: "Claude Code", sessions: [child], installed: true, paths: [], status: "supported",
        sessionMeta: { "lonely-child": { sessionId: "lonely-child", parentSessionId: "parent-elsewhere" } },
      }],
    }),
    { generatedAt: "2026-09-20T16:00:00Z" },
  );
  assert.equal(out.sessions.length, 0);
  assert.equal(out.subagentSessionsSetAside.total, 1);
  const note = out.collectors[0].note;
  assert.ok(note.includes("every one of the 1 session"), note);
  assert.ok(note.includes("sub-agent transcript"), note);
});

test("F-023: a corpus with no parent linkage at all is untouched — every session stays the user's own", () => {
  const out = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  assert.equal(out.sessions.length, 5);
  assert.equal(out.subagentSessions.length, 0);
  assert.equal(out.subagentSessionsSetAside.total, 0);
  assert.equal(out.reportInput.range.subagentSessions, 0);
  for (const session of out.sessions) assert.deepEqual(session.subagentSessions, []);
});

test("F-023: a caller that builds its own ReportInput still gets the set-aside count, derived from the sessions", () => {
  // This is /api/report's path: it filters `analysis.sessions` and calls
  // buildReportInput itself, so it cannot state the corpus total.
  const out = analyzeAll(subagentCorpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  const derived = buildReportInput({ sessions: out.sessions, clis: out.collectors });
  assert.equal(derived.range.sessions, 2);
  assert.equal(derived.range.subagentSessions, 6, "3 + 2 attached children plus the 1 grandchild beneath them; the orphan hangs off no counted session");

  // A session list that never carried the channel says nothing rather than zero.
  const silent = buildReportInput({ sessions: [{ startedAt: at(0), endedAt: at(30), rules: [] }] });
  assert.equal(silent.range.subagentSessions, null);
});

test("F-023: the set-aside count reaches the rendered report, next to the count that excludes it", () => {
  const out = analyzeAll(subagentCorpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  const markdown = generateReport(out.reportInput);
  assert.match(markdown, /\| Sessions analysed \| 2 \|/);
  assert.match(markdown, /\| Sub-agent sessions set aside \| 7 \|/);
  assert.match(markdown, /\| claude \| 2 \| 7 \|/);
  assert.ok(markdown.includes("left out of the count above"), "the report explains the exclusion rather than leaving a gap");
});

// ===========================================================================
// the report contract (R_3C)
// ===========================================================================

const REPORT_INPUT_KEYS = ["generatedAt", "parserVersion", "range", "clis", "rules", "fixes", "trend"];
const RULE_RESULT_KEYS = ["id", "name", "severity", "fix", "threshold", "evidence"];
const EVIDENCE_KEYS = ["status", "reason", "values", "sources", "derivation", "parserVersion"];
const VALUE_KEYS = ["label", "value", "unit", "windowSource", "sessionId"];

test("buildReportInput emits exactly the ReportInput contract shape", () => {
  const out = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  const input = out.reportInput;
  assert.deepEqual(Object.keys(input).sort(), [...REPORT_INPUT_KEYS].sort());
  assert.deepEqual(Object.keys(input.range).sort(), ["from", "sessions", "subagentSessions", "to"]);
  assert.equal(input.parserVersion, out.sessions[0].rules[0].evidence.parserVersion);
  assert.ok(Array.isArray(input.fixes));
  assert.ok(["improving", "stable", "declining", "unknown"].includes(input.trend.direction));

  for (const cli of input.clis) {
    assert.deepEqual(Object.keys(cli).sort(), ["cli", "installed", "note", "sessions", "subagentSessions", "support"]);
    assert.ok(["supported", "detection-only", "unreadable"].includes(cli.support));
    assert.ok([true, false, null].includes(cli.installed));
    assert.ok(cli.sessions === null || Number.isInteger(cli.sessions));
    assert.ok(cli.subagentSessions === null || Number.isInteger(cli.subagentSessions));
    if (cli.sessions === null) assert.equal(cli.subagentSessions, null, "nothing read means the set-aside count is not recorded, not zero");
  }

  for (const rule of input.rules) {
    assert.deepEqual(Object.keys(rule).sort(), [...RULE_RESULT_KEYS].sort(), `${rule.id} keys`);
    assert.deepEqual(Object.keys(rule.evidence).sort(), [...EVIDENCE_KEYS].sort(), `${rule.id} evidence keys`);
    assert.deepEqual(Object.keys(rule.threshold).sort(), ["derivation", "value"]);
    assert.ok(Array.isArray(rule.evidence.sources));
    if (rule.evidence.status === "unknown") assert.equal(typeof rule.evidence.reason, "string", `${rule.id} needs a reason`);
    else assert.equal(rule.evidence.reason, null);
    for (const value of rule.evidence.values) {
      for (const key of Object.keys(value)) assert.ok(VALUE_KEYS.includes(key), `${rule.id} evidence value has non-contract key ${key}`);
      assert.equal(typeof value.label, "string");
      assert.ok(value.value === null || ["number", "string"].includes(typeof value.value), `${rule.id} ${value.label} is ${typeof value.value}`);
      if (value.windowSource !== undefined && value.windowSource !== null) {
        assert.ok(["native", "model-table", "model-map", "observed-promoted", "observed-floor", "unknown"].includes(value.windowSource), `${value.windowSource}`);
      }
    }
  }
});

test("the aggregated rules carry no analyzer-internal key into the report contract", () => {
  const out = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  for (const rule of out.reportInput.rules) assert.ok(!Object.hasOwn(rule, "magnitude"), `${rule.id} leaked magnitude`);
  // It stays on the per-session results, where the ranking uses it.
  assert.ok(out.sessions[0].rules.every((rule) => Object.hasOwn(rule, "magnitude")));
});

test("C-7: buildReportInput never reads the clock, so the same corpus renders twice identically", () => {
  const first = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" }).reportInput;
  const second = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" }).reportInput;
  assert.deepEqual(first, second);
  assert.equal(buildReportInput({ sessions: [] }).generatedAt, null, "no generatedAt supplied means null, not now()");
  assert.equal(generateReport(first), generateReport(second));
});

test("the report input renders through the real generator, and the unknowns survive into the document", () => {
  const out = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  const markdown = generateReport(out.reportInput);
  for (const rule of RULES) assert.ok(markdown.includes(rule.name), `${rule.name} missing from the report`);
  const unknownRules = out.reportInput.rules.filter((rule) => rule.evidence.status === "unknown");
  assert.ok(unknownRules.length >= 2, "this corpus exists to leave unknowns in the report");
  for (const rule of unknownRules) {
    assert.ok(markdown.includes(rule.name), `${rule.id} vanished from the report`);
  }
  assert.ok(/unknown|could not be measured|not measurable/i.test(markdown));
  const document = generateReportDocument(out.reportInput);
  assert.equal(typeof document.markdown, "string");
  assert.equal(typeof document.redactions, "number");
  assert.equal(document.generatedAt, "2026-09-20T16:00:00Z");
});

test("no rendered line reports a context share above 1.00", () => {
  const out = analyzeAll(corpus(), { generatedAt: "2026-09-20T16:00:00Z" });
  const markdown = generateReport(out.reportInput);
  for (const line of markdown.split("\n")) {
    const match = /(\d+\.\d+) of window/.exec(line);
    if (match) assert.ok(Number(match[1]) <= 1, `impossible reading rendered: ${line}`);
  }
});

test("the range comes from the sessions themselves and is null when they carry no timestamps", () => {
  const dated = buildReportInput({ sessions: [{ startedAt: at(0), endedAt: at(60), rules: [] }, { startedAt: at(120), endedAt: at(300), rules: [] }] });
  assert.equal(dated.range.from, at(0));
  assert.equal(dated.range.to, at(300));
  assert.equal(dated.range.sessions, 2);
  const undated = buildReportInput({ sessions: [{ startedAt: null, endedAt: null, rules: [] }] });
  assert.equal(undated.range.from, null);
  assert.equal(undated.range.to, null);
});

// ==========================================================================
// The plain-language guard, widened from the catalogues to the FILES.
//
// The `plain.*` sweep above reads the rule catalogues in memory. It could not
// see a sentence assembled anywhere else, and that is exactly how 22 user-facing
// strings across five files kept their internal ids long after the catalogues
// were clean. A guard that covers part of a surface is how this class of defect
// persists, so this one reads the analyzer's SOURCE: a module added later is
// swept without being named here. Its twin over public/js lives in
// tests/frontend-contract.test.js.
// ==========================================================================

/** Internal ids and analyzer vocabulary that must never reach a user. */
const USER_TEXT_LEAKS = [
  /DIS-\d/i, /BP-\d/i, /\bF-\d/i, /\bsidechain/i, /\blinkage/i,
  /\bdenominator/i, /\bcorpus/i, /\bmagnitude/i,
];

/**
 * Every user-facing string literal in one JS source, as `[line, text]` pairs.
 *
 * LINE RULE: a line is a candidate only when it carries a quote character and is
 * not itself a comment (it does not begin with `*`, `//` or a slash-star). Prose
 * ABOUT a banned word — the comment you are reading — must not fail the guard.
 *
 * LITERAL RULE: within a candidate line, the CONTENTS of each '', "" and
 * backtick literal, with `${...}` interpolations dropped. What an interpolation
 * holds is code, not text: `${round(shiftPoints, 2)}` is an identifier no user
 * ever sees, while the prose around it is text every user does see. That is why
 * a finding names the STRING rather than the whole line.
 *
 * LIMITS, STATED: it reads one line at a time, so a literal split across lines
 * is scanned per line rather than as a whole sentence — enough to catch a banned
 * word, not enough to judge the sentence. An identifier is never a finding, so
 * `fillPlainTemplate(template, magnitude)` — a parameter named after the
 * `rule.magnitude` contract field — does not trip it.
 */
function userFacingStrings(source) {
  const found = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
    if (!/['"`]/.test(line)) return;
    let i = 0;
    let quote = "";
    let buf = "";
    let depth = 0;
    const keep = () => { if (buf.trim()) found.push([index + 1, buf]); };
    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];
      if (!quote) {
        if (ch === "'" || ch === '"' || ch === "`") { quote = ch; buf = ""; }
        i += 1;
        continue;
      }
      if (ch === "\\") { buf += next ?? ""; i += 2; continue; }
      if (quote === "`" && ch === "$" && next === "{") { depth += 1; i += 2; continue; }
      if (depth > 0) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        i += 1;
        continue;
      }
      if (ch === quote) { keep(); quote = ""; buf = ""; i += 1; continue; }
      buf += ch;
      i += 1;
    }
    keep();
  });
  return found;
}

/**
 * The one file the FILE sweep does not read, and why.
 *
 * `rules.js` holds two different kinds of text. Its user-facing kind — `name`
 * and the `plain.*` catalogues — is swept in memory by the two tests below, over
 * every rule, so nothing there is unguarded. Its other kind is `reason` and
 * `derivation`: the evidence OF RECORD, which the honesty contract requires to
 * be traceable, which the product renders only inside collapsed evidence, and
 * which sibling tests in this file assert by id (`assertUnknownWithReason(result,
 * "DIS-004")`). Those two demands cannot both be met by one file-wide sweep, so
 * the split is by ROLE and is stated here rather than hidden in a regex.
 *
 * This is deliberately ONE file, asserted below, so the carve-out cannot quietly
 * grow into the hole this guard exists to close.
 */
const EVIDENCE_OF_RECORD_FILES = new Set(["rules.js"]);

/** `userFacingStrings` itself, so a parser that quietly reads nothing cannot turn this green. */
test("userFacingStrings reads literal text, skips comments, and drops interpolations", () => {
  const sample = [
    "// a comment naming BP-002.18 is not a finding",
    " * nor is a jsdoc line naming DIS-004",
    'const a = "plain text";',
    "const b = `a ${round(magnitude, 2)}-point shift`;",
    'const c = "leaks BP-002.18 at the user";',
  ].join("\n");
  const texts = userFacingStrings(sample).map(([, textValue]) => textValue);
  assert.ok(texts.includes("plain text"), `literal text must be read: ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("a -point shift"), `an interpolation must be dropped, keeping its prose: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.includes("leaks BP-002.18")), "a literal carrying an id must be read");
  assert.ok(!texts.some((t) => t.includes("a comment naming")), "a line comment is not user-facing text");
  assert.ok(!texts.some((t) => t.includes("nor is a jsdoc")), "a jsdoc line is not user-facing text");
  assert.ok(!texts.some((t) => /\bmagnitude/.test(t)), "an identifier inside `${}` must not reach the scan");
  assert.equal(userFacingStrings("const x = 1;").length, 0, "a line with no quote yields nothing");
});

test("no user-facing string in an analyzer module leaks an internal id or the analyzer's own vocabulary", () => {
  // Read from the DIRECTORY rather than a hand-kept list, so a module added later
  // is swept without being named here.
  const dir = new URL("../src/analyzer/", import.meta.url);
  const names = readdirSync(dir).filter((name) => name.endsWith(".js"));
  assert.ok(names.includes("rules.js"), "the analyzer directory is not where this guard thinks it is");
  assert.deepEqual(
    [...EVIDENCE_OF_RECORD_FILES].filter((name) => !names.includes(name)),
    [],
    "EVIDENCE_OF_RECORD_FILES names a file that no longer exists — re-read the carve-out before trusting it",
  );
  assert.equal(EVIDENCE_OF_RECORD_FILES.size, 1, "the carve-out is one file by design; widening it reopens the hole this guard closes");

  const swept = names.filter((name) => !EVIDENCE_OF_RECORD_FILES.has(name));
  assert.ok(swept.length >= 2, `only ${swept.length} analyzer modules are swept — the sweep is not reaching src/analyzer`);

  const findings = [];
  let checked = 0;
  for (const name of swept) {
    const source = readFileSync(new URL(`../src/analyzer/${name}`, import.meta.url), "utf8");
    for (const [line, textValue] of userFacingStrings(source)) {
      checked += 1;
      for (const leak of USER_TEXT_LEAKS) {
        if (leak.test(textValue)) findings.push(`src/analyzer/${name}:${line} leaks ${leak} -> ${JSON.stringify(textValue)}`);
      }
    }
  }
  assert.ok(checked >= 100, `only ${checked} string literals were scanned — the sweep is not reaching the analyzer modules`);
  assert.deepEqual(
    findings,
    [],
    `user-facing text must name the thing, not the ticket:\n  ${findings.join("\n  ")}\n`
    + "Rewrite the sentence in plain English. Do NOT shrink USER_TEXT_LEAKS to get green.",
  );
});

test("rules.js is carved out of the file sweep only because its user-facing fields are swept in memory", () => {
  // The other half of the carve-out above: `name` joins `plain.*` under the same
  // leak list, so every field of rules.js that reaches a card face IS guarded.
  // Without this test the carve-out would be an unguarded file.
  let checked = 0;
  for (const rule of RULES) {
    const fields = [["name", rule.name], ...plainStrings(rule)];
    for (const [where, textValue] of fields) {
      if (typeof textValue !== "string") continue;
      checked += 1;
      for (const leak of USER_TEXT_LEAKS) {
        assert.ok(!leak.test(textValue), `${rule.id}.${where} leaks ${leak} into user-facing text: ${textValue}`);
      }
    }
  }
  assert.ok(checked >= RULES.length * 2, `only ${checked} user-facing rule fields were checked across ${RULES.length} rules`);
});
