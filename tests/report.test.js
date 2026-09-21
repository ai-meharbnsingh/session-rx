import test from "node:test";
import assert from "node:assert/strict";

import {
  generateReport,
  generateReportDocument,
  redactSecrets,
  REPORT_FOOTER,
} from "../src/report/generator.js";
import { happyInput } from "./fixtures/report/happy.js";
import { zeroFindingsInput, twoFindingsInput } from "./fixtures/report/sparse.js";
import { secretsInput, SEEDED, SEEDED_VALUES } from "./fixtures/report/secrets.js";
import { RULES, evaluateRule } from "../src/analyzer/rules.js";

const HEADING = /^(#{1,6}) (.+)$/;

function headings(markdown) {
  return markdown.split("\n")
    .map((line) => HEADING.exec(line))
    .filter(Boolean)
    .map((match) => ({ level: match[1].length, title: match[2] }));
}

function sectionTitles(markdown, level) {
  return headings(markdown).filter((h) => h.level === level).map((h) => h.title);
}

function lineContaining(markdown, needle) {
  const found = markdown.split("\n").filter((line) => line.includes(needle));
  assert.equal(found.length >= 1, true, `expected a line containing ${JSON.stringify(needle)}`);
  return found;
}

// --------------------------------------------------------------------------
// happy path: every required section, in order, with the exact footer
// --------------------------------------------------------------------------

test("happy path renders every required section in order", () => {
  const md = generateReport(happyInput);

  assert.deepEqual(sectionTitles(md, 1), ["SessionRx diagnostic report"]);
  assert.deepEqual(sectionTitles(md, 2), [
    "1. Date range covered",
    "2. CLIs detected",
    "3. Top findings",
    "4. Rule coverage",
    "5. Fixes applied",
    "6. Trend summary",
  ]);
  assert.equal(headings(md)[0].level, 1, "the document opens with the h1");
});

test("date range, per-CLI session counts and trend direction all appear", () => {
  const md = generateReport(happyInput);

  assert.match(md, /\| From \| 2026-09-13T08:14:02Z \|/);
  assert.match(md, /\| To \| 2026-09-20T15:31:55Z \|/);
  assert.match(md, /\| Sessions analysed \| 120 \|/);

  assert.match(md, /\| claude \| 96 \|/);
  assert.match(md, /\| codex \| 14 \|/);
  assert.match(md, /\| gemini \| 8 \|/);
  assert.match(md, /\| kimi \| 2 \|/);
  // detection-only: a missing count is stated as missing, never as zero (DIS-007).
  // The set-aside sub-agent count is missing for the same reason: nothing was read.
  assert.match(md, /\| copilot \| not recorded \(not zero\) \| not recorded \(not zero\) \| detection-only \|/);

  assert.match(md, /^Direction: declining$/m);
  assert.match(md, /Reason: mean session context rose/);
});

test("cache-length annotation pairs each rate with the next count in its row group", () => {
  const md = reportOf({
    rules: [{
      id: "cache-hit",
      name: "Low cache hit",
      severity: "warn",
      evidence: {
        status: "observed",
        values: [
          { label: "cache hit rate", value: 0, unit: "ratio", sessionId: "session-a" },
          { label: "cache reads", value: 0, unit: "tokens" },
          { label: "turns carrying a cache-read count", value: 1, unit: "count" },
          { label: "cache hit rate", value: 0.2, unit: "ratio", sessionId: "session-b" },
          { label: "cache reads", value: 10, unit: "tokens" },
          { label: "turns carrying a cache-read count", value: 8, unit: "count" },
        ],
      },
    }],
  });

  assert.equal((md.match(/rate is not meaningful at fewer than 5 cache-read-carrying turns/g) ?? []).length, 1);
  assert.match(md, /\| cache hit rate \| 0\.00 — rate is not meaningful at fewer than 5 cache-read-carrying turns \| session-a \|/);
  assert.match(md, /\| cache hit rate \| 0\.20 \| session-b \|/);
});

test("cache-length fallback remains when no turn-count row exists", () => {
  const md = reportOf({
    rules: [{
      id: "cache-hit",
      name: "Low cache hit",
      severity: "warn",
      evidence: {
        status: "observed",
        values: [{ label: "cache hit rate", value: 0.2, unit: "ratio", sessionId: "session-a" }],
      },
    }],
  });

  assert.match(md, /The report could not see how many turns carried a cache-read count/);
});

// --------------------------------------------------------------------------
// L8 / F-023: the sessions counted are the user's own, and the number left out
// is printed rather than implied
// --------------------------------------------------------------------------

test("L8: sub-agent sessions set aside are printed next to the count that excludes them", () => {
  const md = generateReport({
    generatedAt: "2026-09-20T18:00:00Z",
    range: { from: "2026-09-13T08:14:02Z", to: "2026-09-20T15:31:55Z", sessions: 50, subagentSessions: 106 },
    clis: [
      { cli: "claude", sessions: 10, subagentSessions: 106, support: "supported", note: null },
      { cli: "codex", sessions: 10, subagentSessions: 0, support: "supported", note: null },
      { cli: "copilot", sessions: null, subagentSessions: null, support: "detection-only", note: "no transcript" },
    ],
    rules: [],
    fixes: [],
    trend: { direction: "unknown", reason: "not computed here" },
  });

  assert.match(md, /\| Sessions analysed \| 50 \|/);
  assert.match(md, /\| Sub-agent sessions set aside \| 106 \|/);
  assert.match(md, /106 further sessions were read and analysed but left out of the count above/);
  assert.match(md, /evidence about the session that launched it, not a session of the user's own/);
  assert.match(md, /\| claude \| 10 \| 106 \| supported \|/);
  assert.match(md, /\| codex \| 10 \| 0 \| supported \|/);
  // nothing read for this CLI: not recorded, and specifically not zero
  assert.match(md, /\| copilot \| not recorded \(not zero\) \| not recorded \(not zero\) \| detection-only \|/);
});

test("L8: an input that does not record the set-aside count says so, rather than printing zero", () => {
  const md = generateReport({
    range: { from: null, to: null, sessions: 4 },
    clis: [{ cli: "claude", sessions: 4, support: "supported", note: null }],
    rules: [],
    fixes: [],
    trend: { direction: "unknown", reason: "none" },
  });
  assert.match(md, /\| Sub-agent sessions set aside \| not recorded \|/);
  assert.equal(md.includes("further sessions were read"), false, "nothing is claimed about sessions the input never counted");
});

test("the footer is exactly the specified line and is the last line", () => {
  const md = generateReport(happyInput);
  assert.equal(REPORT_FOOTER, "Diagnosed by SessionRx — built by Adaptive Mind");
  assert.equal(md.endsWith(`${REPORT_FOOTER}\n`), true);
  const nonEmpty = md.split("\n").filter((line) => line.trim() !== "");
  assert.equal(nonEmpty[nonEmpty.length - 1], "Diagnosed by SessionRx — built by Adaptive Mind");
});

test("each finding carries the measured numbers, not a restatement of the rule", () => {
  const md = generateReport(happyInput);

  // real numbers from the fixture sessions, formatted for a reader
  assert.match(md, /\| session elapsed \| 7\.4 h \|/);
  assert.match(md, /\| context at last observation \| 416,200 tokens \|/);
  assert.match(md, /\| slope \| 50,674\.7 tokens \|/);
  assert.match(md, /\| largest tool result \| 1,842,311 bytes \|/);
  assert.match(md, /- Sources: ~\/\.claude\/projects\/-Users-demo-app\/1ecace68-4f31-4a0e-9a2d-88b1c0f4e512\.jsonl/);
  assert.match(md, /- Suggested fix: `claude-compact-contract`/);
  assert.match(md, /- Parser version: 2026-09-20\.2/);
  assert.match(md, /Evidence — the numbers actually measured in these sessions:/);
});

// --------------------------------------------------------------------------
// the product's core promise: unknown never becomes a pass
// --------------------------------------------------------------------------

test("an unknown verdict renders visibly as unknown WITH its reason", () => {
  const md = generateReport(happyInput);

  assert.match(md, /\| `repeat-tool` \| warn \| unknown \|/);
  assert.match(md, /UNKNOWN — the 8 Gemini sessions in this range record tool calls but no stable tool-result contract/);
  // and again in the explicit unknown list, so it cannot be missed
  assert.match(md, /- `repeat-tool` Repeated tool work: unknown — the 8 Gemini sessions/);
  assert.match(md, /1 rule\(s\) returned `unknown` and could not be diagnosed/);
});

test("an unknown rule is never rendered as observed, as a zero, or omitted", () => {
  const md = generateReport(happyInput);
  const coverage = md.slice(md.indexOf("## 4. Rule coverage"), md.indexOf("## 5. Fixes applied"));

  // all six rules present in coverage
  for (const id of ["context-pressure", "cache-hit", "repeat-tool", "large-tool-result", "long-rising-context", "subagent-concurrency"]) {
    assert.match(coverage, new RegExp("`" + id + "`"), `${id} missing from rule coverage`);
  }
  // repeat-tool is unknown, so it must not be one of the printed findings
  const findings = md.slice(md.indexOf("## 3. Top findings"), md.indexOf("## 4. Rule coverage"));
  assert.equal(findings.includes("Rule id: `repeat-tool`"), false);
  assert.match(coverage, /`unknown` means the data needed to decide was absent — it is not a pass and not a zero/);
});

test("an unknown with no reason still renders an explicit reason, never a blank", () => {
  const md = generateReport({
    generatedAt: "2026-09-20T18:00:00Z",
    range: { from: null, to: null, sessions: null },
    clis: [],
    rules: [{ id: "cache-hit", name: "Low cache hit", severity: "warn", evidence: { status: "unknown" } }],
    fixes: [],
    trend: { direction: "unknown" },
  });
  assert.match(md, /reason not recorded by the analyzer — this rule could not be evaluated and is NOT a pass/);
  assert.match(md, /\| `cache-hit` \| warn \| unknown \|/);
});

test("an unrecognised status is coerced to unknown and says so", () => {
  const md = generateReport({
    range: { from: null, to: null },
    clis: [],
    rules: [{ id: "repeat-tool", severity: "warn", evidence: { status: "pass", values: [] } }],
    fixes: [],
    trend: { direction: "stable" },
  });
  assert.match(md, /\| `repeat-tool` \| warn \| unknown \|/);
  assert.match(md, /the analyzer returned "pass" instead of observed \/ not-observed \/ unknown/);
});

// --------------------------------------------------------------------------
// no padding
// --------------------------------------------------------------------------

test("zero findings prints zero findings and refuses to imply all-clear", () => {
  const md = generateReport(zeroFindingsInput);

  assert.equal(sectionTitles(md, 3).filter((t) => t.startsWith("3.")).length, 0);
  assert.match(md, /No finding was observed across the 6 rule\(s\) evaluated\./);
  assert.match(md, /This is not a clean bill of health/);
  assert.match(md, /3 rule\(s\) returned `unknown` and could not be diagnosed/);
  // every unknown reason is present verbatim
  assert.match(md, /Codex rollout records carry no cache counters in this range/);
  assert.match(md, /same-input\/same-result cannot be established without a false positive/);
  assert.match(md, /Codex records establish no parent\/child intervals/);
});

test("two findings prints two, says it is fewer than three, and pads nothing", () => {
  const md = generateReport(twoFindingsInput);

  const findingHeadings = sectionTitles(md, 3).filter((t) => /^3\./.test(t));
  assert.equal(findingHeadings.length, 2);
  assert.match(findingHeadings[0], /^3\.1 Context pressure \(warn\)$/);
  assert.match(findingHeadings[1], /^3\.2 Large tool results \(warn\)$/);
  assert.equal(md.includes("### 3.3"), false);
  assert.match(md, /2 finding\(s\) were observed, which is fewer than three\. The report lists the ones that exist and is not padded to three\./);
});

test("more than three observed findings are capped at three and the rest are still visible", () => {
  const md = generateReport(happyInput);

  const findingHeadings = sectionTitles(md, 3).filter((t) => /^3\./.test(t));
  assert.equal(findingHeadings.length, 3);
  assert.match(md, /4 findings were observed; the 3 most report-worthy are shown\. Section 4 lists every rule\./);
  // the 4th observed rule is absent from findings but present, as observed, in coverage
  assert.equal(md.slice(md.indexOf("## 3."), md.indexOf("## 4.")).includes("Rule id: `cache-hit`"), false);
  assert.match(md, /\| `cache-hit` \| warn \| observed \|/);
});

// --------------------------------------------------------------------------
// F-008: an inferred window says so; a fraction above 1.0 is never normal
// --------------------------------------------------------------------------

test("an observed-promoted window is labelled as inferred where the number appears", () => {
  const md = generateReport(happyInput);

  const rows = lineContaining(md, "| peak context |");
  assert.equal(rows.length, 1);
  assert.match(rows[0], /416,200 tokens/);
  assert.match(rows[0], /INFERRED from observation \(observed-promoted\)/);
  assert.match(rows[0], /the model-id window table understated this model/);
});

test("observed-floor is labelled as inferred too", () => {
  const md = generateReport({
    range: { from: null, to: null },
    clis: [],
    rules: [{
      id: "context-pressure",
      severity: "warn",
      evidence: {
        status: "observed",
        values: [{ label: "peak context", value: 512000, unit: "tokens", windowSource: "observed-floor" }],
      },
    }],
    fixes: [],
    trend: { direction: "stable" },
  });
  assert.match(md, /INFERRED from observation \(observed-floor\)/);
  assert.match(md, /no window is known for this model id/);
});

test("a context fraction above 1.0 never renders as a normal reading", () => {
  const md = generateReport(happyInput);

  const rows = lineContaining(md, "2.08");
  for (const row of rows) {
    assert.match(row, /IMPOSSIBLE READING \(above 1\.0\)/, `bare above-1.0 fraction rendered: ${row}`);
    assert.match(row, /the window is wrong for this session, not the measurement/);
  }
  // and no line prints an above-1.0 fraction of the window without the marker
  for (const line of md.split("\n")) {
    const match = /(\d+\.\d\d) of window/.exec(line);
    if (match && Number(match[1]) > 1) {
      assert.match(line, /IMPOSSIBLE READING/, `unmarked above-1.0 reading: ${line}`);
    }
  }
  // the honest reading against the promoted window is present and normal
  assert.match(md, /0\.42 of window/);
});

// --------------------------------------------------------------------------
// fixes carry their BEFORE state
// --------------------------------------------------------------------------

test("each applied fix shows its BEFORE state", () => {
  const md = generateReport(happyInput);

  assert.deepEqual(sectionTitles(md, 3).filter((t) => /^5\./.test(t)), [
    "5.1 Enable Claude auto-compact",
    "5.2 Append output-hygiene instructions",
  ]);
  assert.match(md, /- Target: ~\/\.claude\/settings\.json/);
  assert.match(md, /^BEFORE:$/m);
  // 4 spaces of indented-block prefix plus the JSON's own 2 spaces
  assert.match(md, /^ {6}"autoCompact": false$/m);
  assert.match(md, /^AFTER:$/m);
  assert.match(md, /^ {6}"autoCompact": true$/m);
  assert.match(md, /^ {4}\{$/m, "every BEFORE line is indented, not fenced");
  assert.match(md, /- Undo record: ~\/\.session-rx\/undo\//);
});

test("a fix with no recorded BEFORE state says so rather than showing nothing", () => {
  const md = generateReport(twoFindingsInput);
  assert.match(md, /BEFORE state not recorded — this fix cannot be audited from this report alone\./);
});

// RE-AIMED (F1). This test used to be the whole of section 5's coverage, and
// the sentence it asserts was reachable two ways: a history that was READ and
// held no apply, and a caller that never passed one at all. The second is the
// falsehood — the report said "no fix was applied" while five had just been
// applied — so the test now names the input that earns the sentence, and the
// three tests below pin the shapes that must NOT produce it.
test("a history that was read and held no apply renders the explicit sentence", () => {
  assert.deepEqual(zeroFindingsInput.fixes, [], "precondition: the history was read and came back empty");
  const md = generateReport(zeroFindingsInput);
  assert.match(md, /## 5\. Fixes applied\n\nNo fix was applied in this period\./);
});

test("an applied fix is LISTED by id, so section 5 can say something other than 'none'", () => {
  const md = generateReport({
    range: { from: null, to: null },
    clis: [],
    rules: [],
    fixes: [{
      id: "claude-auto-compact",
      name: "Enable auto-compaction",
      target: "~/.claude/settings.json",
      appliedAt: "2026-09-21T10:00:00.000Z",
      status: "applied",
      before: null,
      undoPath: "~/.session-rx/undo/20260921T100000Z",
    }],
    trend: { direction: "stable" },
  });
  assert.match(md, /- Fix id: `claude-auto-compact`/);
  assert.match(md, /- Applied at: 2026-09-21T10:00:00\.000Z/);
  assert.equal(md.includes("No fix was applied in this period"), false);
});

test("L9: an ABSENT fixes key is unknown with its reason, never 'no fix was applied'", () => {
  const md = generateReport({ range: { from: null, to: null }, clis: [], rules: [], trend: {} });
  assert.match(md, /Applied-fix history: unknown — the applied-fix history was not supplied to the report generator/);
  assert.match(md, /Unknown is not an empty history/);
  assert.equal(md.includes("No fix was applied in this period"), false,
    "an unwired input must never render as a claim about what the user applied");
});

test("L9: an unreadable history renders unknown WITH the caller's reason", () => {
  const md = generateReport({
    range: { from: null, to: null },
    clis: [],
    rules: [],
    fixes: { status: "unknown", reason: "~/.session-rx/journal.jsonl holds 42 byte(s) but not one parseable record" },
    trend: {},
  });
  assert.match(md, /Applied-fix history: unknown — ~\/\.session-rx\/journal\.jsonl holds 42 byte\(s\) but not one parseable record/);
  assert.equal(md.includes("No fix was applied in this period"), false);
});

test("L9: a non-array history with no reason still says unknown, and says the reason is missing", () => {
  const md = generateReport({
    range: { from: null, to: null },
    clis: [],
    rules: [],
    fixes: { status: "unknown" },
    trend: {},
  });
  assert.match(md, /Applied-fix history: unknown — reason not recorded by the caller/);
  assert.equal(md.includes("No fix was applied in this period"), false);
});

// --------------------------------------------------------------------------
// trend
// --------------------------------------------------------------------------

test("an unknown trend direction renders as unknown with its reason", () => {
  const md = generateReport(zeroFindingsInput);
  assert.match(md, /^Direction: unknown$/m);
  assert.match(md, /Reason: 3 sessions over 6 hours is too short a baseline to establish a direction/);
});

test("a trend direction outside the three allowed values is not laundered into one", () => {
  const md = generateReport({
    range: { from: null, to: null },
    clis: [],
    rules: [],
    fixes: [],
    trend: { direction: "excellent" },
  });
  assert.match(md, /Direction: unknown \(the analyzer reported "excellent", which is not one of improving \/ stable \/ declining\)/);
  assert.match(md, /must not be read as stable/);
});

// --------------------------------------------------------------------------
// SECURITY: nothing credential-shaped reaches the document
// --------------------------------------------------------------------------

test("a fixture seeded with credential-shaped values emits none of them", () => {
  const doc = generateReportDocument(secretsInput);

  assert.equal(SEEDED_VALUES.length, 8);
  for (const value of SEEDED_VALUES) {
    assert.equal(value.length > 0, true);
    assert.equal(
      doc.markdown.includes(value),
      false,
      `seeded credential-shaped value leaked into the report: ${value.slice(0, 4)}…`,
    );
  }
  assert.equal(doc.redactions > 0, true, "redactions must be counted for BP-005.05");
  assert.match(doc.markdown, /\[REDACTED\]/);
});

// Section 5's unknown branch prints a REASON string that the server builds
// from a file path and an errno. It is new text in the shareable artifact, so
// it goes through the same redactor as every other line.
test("the unknown-history reason is redacted like every other line of the report", () => {
  const doc = generateReportDocument({
    range: { from: null, to: null },
    clis: [],
    rules: [],
    fixes: { status: "unknown", reason: `the journal could not be read (${SEEDED.githubPat})` },
    trend: { direction: "unknown", reason: `the trend could not be computed (${SEEDED.awsKeyId})` },
  });
  assert.equal(doc.markdown.includes(SEEDED.githubPat), false, "a credential-shaped value in a fix reason must not reach the report");
  assert.equal(doc.markdown.includes(SEEDED.awsKeyId), false, "a credential-shaped value in a trend reason must not reach the report");
  assert.equal(doc.redactions >= 2, true);
  assert.match(doc.markdown, /Applied-fix history: unknown — the journal could not be read \(\[REDACTED\]\)/);
});

test("redaction keeps the KEY and loses only the VALUE", () => {
  const md = generateReport(secretsInput);
  assert.match(md, /access_token=\[REDACTED\]/);
  assert.match(md, /refresh_token: \[REDACTED\]/);
  assert.match(md, /authorization: \[REDACTED\]/);
});

test("redaction does not destroy the evidence references the report exists to carry", () => {
  const md = generateReport(secretsInput);
  // dashed UUID session ids survive; a continuous hex run does not
  assert.match(md, /9c1d4e77-2a58-4d31-b0f6-31ab92c4e708/);
  assert.match(md, /~\/\.local\/share\/opencode\/opencode\.db#part\/\[REDACTED\]/);
  assert.match(md, /88,231 bytes/);
});

test("redactSecrets handles each shape and counts what it removed", () => {
  const cases = [
    SEEDED.vendorKey,
    SEEDED.githubPat,
    SEEDED.hexRun,
    SEEDED.awsKeyId,
    SEEDED.jwt,
    `Bearer ${SEEDED.bearerToken}`,
    ["x-api", "key: ", SEEDED.accessTokenValue].join(""),
    ["client", "secret", '="', SEEDED.refreshTokenValue, '"'].join(""),
  ];
  for (const input of cases) {
    const { text, redactions } = redactSecrets(input);
    assert.equal(redactions >= 1, true, `nothing redacted from ${input.slice(0, 6)}…`);
    assert.match(text, /\[REDACTED\]/);
  }
  const pem = `${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)}\nQUJDREVGR0g=\n${"-".repeat(5)}END RSA PRIVATE KEY${"-".repeat(5)}`;
  const redactedPem = redactSecrets(pem);
  assert.equal(redactedPem.text.includes("QUJDREVGR0g="), false);
  assert.equal(redactedPem.redactions >= 1, true);
});

test("redaction leaves an ordinary deep filesystem path intact", () => {
  // a plain path is [A-Za-z0-9/] and would be eaten by a naive base64 run
  const path = "/Users/demo/Projects/AutonomousFactory/multiLLMorchestrator/caseStudies/projectSixty/src";
  const { text, redactions } = redactSecrets(path);
  assert.equal(text, path);
  assert.equal(redactions, 0);
});

test("redactSecrets is total: null, undefined and non-strings do not throw", () => {
  assert.deepEqual(redactSecrets(null), { text: "", redactions: 0 });
  assert.deepEqual(redactSecrets(undefined), { text: "", redactions: 0 });
  assert.deepEqual(redactSecrets(42), { text: "42", redactions: 0 });
});

// --------------------------------------------------------------------------
// determinism: the report is diffable
// --------------------------------------------------------------------------

test("the same input twice yields byte-identical markdown", () => {
  for (const input of [happyInput, zeroFindingsInput, twoFindingsInput, secretsInput]) {
    const first = generateReport(input);
    const second = generateReport(input);
    assert.equal(Buffer.compare(Buffer.from(first, "utf8"), Buffer.from(second, "utf8")), 0);
  }
});

test("no timestamp-of-now is embedded: an absent generatedAt stays absent", () => {
  const { generatedAt: omitted, ...withoutTimestamp } = happyInput;
  assert.equal(typeof omitted, "string");
  const md = generateReport(withoutTimestamp);
  assert.match(md, /- Generated at: not recorded \(the caller did not supply generatedAt\)/);
  // nothing in the document looks like a clock reading the generator invented
  const isoRuns = md.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g) ?? [];
  for (const iso of isoRuns) {
    assert.equal(
      JSON.stringify(withoutTimestamp).includes(iso),
      true,
      `report contains an ISO timestamp that was not in the input: ${iso}`,
    );
  }
});

test("generateReportDocument returns the BP-005.05 envelope", () => {
  const doc = generateReportDocument(happyInput);
  assert.deepEqual(Object.keys(doc).sort(), ["generatedAt", "markdown", "redactions"]);
  assert.equal(doc.generatedAt, "2026-09-20T15:42:07Z");
  assert.equal(typeof doc.redactions, "number");
  assert.equal(doc.markdown, generateReport(happyInput));
  assert.equal(generateReportDocument({ range: {}, clis: [], rules: [], fixes: [], trend: {} }).generatedAt, null);
});

test("a non-object input is rejected rather than silently rendering an empty report", () => {
  for (const bad of [null, undefined, "x", 7, []]) {
    assert.throws(() => generateReport(bad), TypeError);
  }
});

// --------------------------------------------------------------------------
// the output is valid markdown
// --------------------------------------------------------------------------

test("headings nest sanely and there is no fence to leave unclosed", () => {
  for (const input of [happyInput, zeroFindingsInput, twoFindingsInput, secretsInput]) {
    const md = generateReport(input);

    // L7: verbatim content is indented, so the document contains no fence at all
    assert.equal(md.includes("```"), false, "the report must contain no code fence");
    assert.equal(md.includes("~~~"), false, "the report must contain no tilde fence");

    const levels = headings(md).map((h) => h.level);
    assert.equal(levels[0], 1);
    for (let i = 1; i < levels.length; i += 1) {
      assert.equal(levels[i] - levels[i - 1] <= 1, true, `heading level jumped from h${levels[i - 1]} to h${levels[i]}`);
    }
    assert.equal(levels.filter((level) => level === 1).length, 1, "exactly one h1");
  }
});

test("every table row has the same cell count as its header", () => {
  for (const input of [happyInput, zeroFindingsInput, twoFindingsInput, secretsInput]) {
    const lines = generateReport(input).split("\n");
    let expected = null;
    for (const line of lines) {
      if (!line.startsWith("|")) { expected = null; continue; }
      const cells = line.split("|").length;
      if (expected === null) { expected = cells; continue; }
      assert.equal(cells, expected, `ragged table row: ${line}`);
    }
  }
});

test("no blank line is ever doubled, so one input has one byte form", () => {
  for (const input of [happyInput, zeroFindingsInput, twoFindingsInput, secretsInput]) {
    assert.equal(generateReport(input).includes("\n\n\n"), false);
  }
});

test("the report carries no marketing adjective", () => {
  const md = generateReport(happyInput).toLowerCase();
  for (const word of ["blazing", "seamless", "effortless", "world-class", "cutting-edge", "revolutionary", "powerful", "amazing", "best-in-class"]) {
    assert.equal(md.includes(word), false, `marketing language in the report: ${word}`);
  }
});

// --------------------------------------------------------------------------
// THE SHARED ARTIFACT CARRIES NO INTERNAL IDENTIFIER
//
// The analyzer keeps its own filing references inside its evidence strings on
// purpose — that is the evidence of record — and the UI only ever shows them
// inside collapsed technical detail. The report is the artifact users SHARE:
// pasted into issues, sent to colleagues, screenshotted. It has no collapsed
// detail, and a stranger reading their own report has no document in which to
// look one of those references up. These tests pin the removal, and — more
// importantly — the sentences the removal must not damage, several of which
// exist precisely to stop a missing measurement reading as a good result.
//
// No pre-existing test asserted an identifier in the rendered report, so
// nothing here re-aims one: the five that mention a reference do so only in a
// comment or a test name, describing which decision a case came from.
// --------------------------------------------------------------------------

const INTERNAL_ID = /DIS-\d|BP-\d|\bF-\d/g;

/**
 * Verbatim from src/analyzer/rules.js — the text the analyzer really emits.
 * A frozen copy, so a reworded rule must be copied here deliberately; the
 * guard at the end of this file reads the LIVE rules instead, which is what
 * catches a sentence this list has fallen behind.
 */
const ANALYZER_SENTENCES = Object.freeze([
  `Dividing that peak by itself gives 1.0 for every session by construction — a trivial session and a genuinely full one would both read "100% of window" — so no share of the window and no comparison against the threshold is derived from it (BP-002.18 / F-014). The peak itself is reported below as a lower bound, because that part is true.`,
  "(promotion ladder `none`). The figure being divided and the figure it is divided by are therefore the same number again, and BP-002.18 applies exactly as it does to `observed-floor`.",
  `window.source "model-id-table" is not one of the sources BP-002.11-BP-002.14 permit a threshold comparison from.`,
  "codex recorded 41 tool calls for this session but no result signature that can be attributed to any single one of them — either the per-turn result byte length is absent (DIS-006) or every turn made more than one call, so its one byte total cannot be split between them. Same input with an unknown result is not a repeat, so this rule reports unknown rather than counting inputs alone (DIS-003).",
  "gemini recorded 12 turns with tool calls for this session but no result byte length for any of them, so result size cannot be measured. A missing byte count is not a small result (DIS-006); it is not counted at all.",
  "The `isSidechain` marker is not a substitute, which is why an empty child list is never read off it: the marker is never `true` in a main transcript (BP-003.07 measured true=0 against false=138,358), so the count of marked turns recorded here (4) is not a measurement of how many sub-agents ran, and a zero there would be a false all-clear rather than a finding. The marker also carries no sub-agent identity and no start or end (DIS-004).",
  "Nothing in Codex's rollout records establishes a sub-agent interval: no turn is marked as belonging to a sub-agent, and nothing ties a child session to the session that dispatched it, so there are no intervals to overlap (DIS-004).",
  "(DIS-005: the fraction is preserved and never converted into invented absolute tokens).",
]);

function reportOf(overrides = {}) {
  return generateReport({
    range: { from: null, to: null },
    clis: [],
    rules: [],
    fixes: [],
    trend: { direction: "unknown", reason: "no trend was computed here" },
    ...overrides,
  });
}

/** Every analyzer sentence above, rendered where the document really puts it. */
function analyzerProseReport() {
  return reportOf({
    rules: ANALYZER_SENTENCES.map((sentence, index) => ({
      id: `rule-${index}`,
      name: `Rule ${index}`,
      severity: "warn",
      threshold: { value: null, derivation: sentence },
      evidence: { status: "unknown", reason: sentence, derivation: sentence, values: [] },
    })),
  });
}

test("no internal identifier reaches the shared report, anywhere in the document", () => {
  const documents = [
    ["happy path", generateReport(happyInput)],
    ["zero findings", generateReport(zeroFindingsInput)],
    ["two findings", generateReport(twoFindingsInput)],
    ["seeded secrets", generateReport(secretsInput)],
    ["analyzer prose", analyzerProseReport()],
  ];
  for (const [name, md] of documents) {
    assert.deepEqual(md.match(INTERNAL_ID) ?? [], [], `${name}: an internal identifier reached the report`);
  }
});

test("each real rule's own threshold text renders into the report without an identifier", () => {
  for (const rule of RULES) {
    const md = reportOf({
      rules: [{
        id: rule.id,
        name: rule.name,
        severity: rule.severity,
        threshold: rule.threshold,
        evidence: { status: "observed", values: [{ label: "peak context", value: 0.91, unit: "fraction" }] },
      }],
    });
    assert.match(md, /- Threshold: /, `${rule.id}: the threshold line vanished`);
    assert.deepEqual(md.match(INTERNAL_ID) ?? [], [], `${rule.id}: identifier in the rendered threshold`);
  }
});

test("the sentences that stop an absence reading as a pass still say so after the identifier goes", () => {
  const md = analyzerProseReport();

  // 1. a peak divided by itself is not a measurement of pressure
  assert.match(md, /so no share of the window and no comparison against the threshold is derived from it\. The peak itself is reported below as a lower bound/);
  // 2. the identifier was the SUBJECT of this sentence; plain words take its place
  assert.match(md, /The figure being divided and the figure it is divided by are therefore the same number again, and that rule applies exactly as it does to `observed-floor`\./);
  // 3. a window source outside the permitted set is compared against nothing
  assert.match(md, /is not one of the sources those rules permit a threshold comparison from\./);
  // 4. an unknown result is not a repeat, and unknown is not a pass
  assert.match(md, /Same input with an unknown result is not a repeat, so this rule reports unknown rather than counting inputs alone\./);
  // 5. a missing byte count is not a small result
  assert.match(md, /A missing byte count is not a small result; it is not counted at all\./);
  // 6. the zero that would have been a false all-clear
  assert.match(md, /is not a measurement of how many sub-agents ran, and a zero there would be a false all-clear rather than a finding/);
  // 7. a structural absence stays an absence
  assert.match(md, /nothing ties a child session to the session that dispatched it, so there are no intervals to overlap\./);
  // 8. a labelling reference goes; the clause it labelled stays
  assert.match(md, /\(the fraction is preserved and never converted into invented absolute tokens\)/);
});

test("removing an identifier leaves no scar", () => {
  const documents = [
    generateReport(happyInput),
    generateReport(zeroFindingsInput),
    generateReport(twoFindingsInput),
    generateReport(secretsInput),
    analyzerProseReport(),
  ];
  for (const md of documents) {
    assert.equal(/\(\s*\)/.test(md), false, "empty parentheses left where an identifier was");
    for (const line of md.split("\n")) {
      // A four-space indent is a verbatim BEFORE/AFTER block: the user's own
      // bytes, which this file never rewrites.
      if (line.startsWith("    ")) continue;
      assert.equal(/\S {2,}\S/.test(line), false, `doubled space: ${line}`);
      assert.equal(/\S[ \t]+[.,;:]/.test(line), false, `space before punctuation: ${line}`);
      assert.equal(/\([ \t]/.test(line), false, `stranded opening bracket: ${line}`);
    }
  }
});

test("redaction still runs over the text an identifier was removed from", () => {
  const reason = `the log line carrying ${SEEDED.githubPat} could not be parsed, so nothing was measured (DIS-006).`;
  const doc = generateReportDocument({
    range: { from: null, to: null },
    clis: [],
    rules: [{ id: "repeat-tool", name: "Repeated tool work", severity: "warn", evidence: { status: "unknown", reason, values: [] } }],
    fixes: [],
    trend: { direction: "unknown", reason },
  });
  assert.equal(doc.markdown.includes(SEEDED.githubPat), false, "a secret survived inside reshaped text");
  assert.match(doc.markdown, /\[REDACTED\]/);
  assert.equal(doc.redactions > 0, true, "the redaction was not counted");
  assert.deepEqual(doc.markdown.match(INTERNAL_ID) ?? [], []);
  assert.match(doc.markdown, /could not be parsed, so nothing was measured\./);
});

test("a user's own BEFORE text is copied, not copy-edited", () => {
  // The exemption, stated as a test: a fix's BEFORE block is the user's file.
  // Tidying our wording out of their bytes would be a worse falsehood than the
  // one the stripping removes, so verbatim content is rendered untouched.
  const before = "# notes\nkeep ref BP-9001 for my own filing  (mine)\n";
  const md = reportOf({
    fixes: [{ id: "claude-output-hygiene", name: "Output hygiene instruction", target: "~/.claude/CLAUDE.md", appliedAt: "2026-09-21T10:00:00.000Z", status: "applied", before }],
  });
  assert.match(md, /^ {4}keep ref BP-9001 for my own filing {2}\(mine\)$/m);
});

// --------------------------------------------------------------------------
// SECTION 5 NAMES WHAT IT HOLDS
// --------------------------------------------------------------------------

const REVERTED_HISTORY = Object.freeze([
  { id: "claude-auto-compact", name: "Enable auto-compaction", target: "~/.claude/settings.json", appliedAt: "2026-09-19T09:00:00.000Z", status: "reverted", before: null, undoPath: "~/.session-rx/undo/20260919T090000Z" },
  { id: "claude-output-hygiene", name: "Output hygiene instruction", target: "~/.claude/CLAUDE.md", appliedAt: "2026-09-19T09:05:00.000Z", status: "reverted", before: null, undoPath: "~/.session-rx/undo/20260919T090500Z" },
  { id: "claude-batch-commands", name: "Batch commands instruction", target: "~/.claude/CLAUDE.md", appliedAt: "2026-09-19T09:10:00.000Z", status: "reverted", before: null, undoPath: "~/.session-rx/undo/20260919T091000Z" },
  { id: "claude-worker-cap", name: "Worker cap instruction", target: "~/.claude/CLAUDE.md", appliedAt: "2026-09-19T09:15:00.000Z", status: "reverted", before: null, undoPath: "~/.session-rx/undo/20260919T091500Z" },
  { id: "claude-compact-contract", name: "Compact contract instruction", target: "~/.claude/CLAUDE.md", appliedAt: "2026-09-19T09:20:00.000Z", status: "reverted", before: null, undoPath: "~/.session-rx/undo/20260919T092000Z" },
  { id: "claude-auto-compact", name: "Enable auto-compaction", target: "~/.claude/settings.json", appliedAt: "2026-09-20T11:00:00.000Z", status: "applied", before: null, undoPath: "~/.session-rx/undo/20260920T110000Z" },
  { id: "claude-output-hygiene", name: "Output hygiene instruction", target: "~/.claude/CLAUDE.md", appliedAt: "2026-09-20T11:05:00.000Z", status: "applied", before: null, undoPath: "~/.session-rx/undo/20260920T110500Z" },
]);

test("a history where five of seven were undone does not read as seven fixes applied", () => {
  const md = reportOf({ fixes: REVERTED_HISTORY });

  assert.equal(sectionTitles(md, 2).includes("5. Fixes applied"), false, "the heading still claims every entry was applied");
  assert.equal(sectionTitles(md, 2).includes("5. Fix history"), true);
  assert.match(md, /7 fix\(es\) recorded: 2 still in place, 5 applied and then undone\. Not all of them are in effect/);
});

test("every per-entry status is left exactly as the caller recorded it", () => {
  const md = reportOf({ fixes: REVERTED_HISTORY });

  assert.equal((md.match(/^- Status: reverted$/gm) ?? []).length, 5);
  assert.equal((md.match(/^- Status: applied$/gm) ?? []).length, 2);
  // and the reverted entries are still listed: an undone fix is real history
  for (let index = 1; index <= REVERTED_HISTORY.length; index += 1) {
    assert.match(md, new RegExp(`^### 5\\.${index} `, "m"), `entry ${index} was dropped`);
  }
});

test("a history where every entry is applied still says so", () => {
  assert.equal(happyInput.fixes.every((fix) => fix.status === "applied"), true, "precondition");
  assert.match(generateReport(happyInput), /## 5\. Fixes applied\n/);
  assert.match(generateReport(happyInput), /fix\(es\) recorded\. Each one shows the BEFORE state it replaced\./);
});

// --------------------------------------------------------------------------
// The analyzer's own vocabulary, guarded on the REPORT path.
//
// tests/analyzer.test.js sweeps every file in src/analyzer/ for this same
// vocabulary and carves exactly one file out: rules.js, whose `reason` and
// `derivation` strings are the evidence of record and which the UI renders
// only inside a collapsed <details>. That carve-out is sound for the UI and
// stays where it is. It does not hold here. A report has no collapsed detail,
// and it is the artifact people paste into issues and send to colleagues —
// which is how "A denominator of zero is unknown for the same reason" reached
// a shared document unnoticed. The carve-out never anticipated Markdown.
//
// So this guard reads no file. It RENDERS: every rule is evaluated over a
// matrix of sessions and contexts, each result goes through the real
// generator, and the Markdown that comes out is what gets searched. A word
// fails here whichever field carried it — `threshold.derivation`,
// `evidence.reason`, `evidence.derivation`, an evidence row's `label` — and a
// field the generator starts rendering later is covered without being named.
//
// Both halves assert a FLOOR on how much they inspected, and the document
// half asserts a sentence it must have found, so a guard that quietly
// examines nothing cannot pass green.
// --------------------------------------------------------------------------

/**
 * The analyzer's words for its own internals. A reader of their own report has
 * no glossary, so none of these may reach one.
 *
 * `\b` is deliberate: a field identifier is not a finding. `isSidechain` is the
 * real on-disk field whose absence one rule exists to explain, and a rule that
 * names it is being traceable, not jargon-y.
 */
const SHARED_VOCABULARY = Object.freeze([
  /\bsidechain/i, /\blinkage/i, /\bdenominator/i, /\bnumerator/i, /\bcorpus\b/i, /\bmagnitude\b/i,
]);

/**
 * `verdict` is guarded at the SOURCE that would leak it, not in the rendered
 * document, and that is not a loophole: the generator prints its own
 * `| Rule | Severity | Verdict | Why |` heading. That is the document's word
 * for the honesty contract's three states, written by the report for its
 * reader — not analyzer vocabulary arriving through a rule. Banning it in the
 * output would only ever fail on the generator's own heading; banning it in
 * rule text stops the thing that actually leaks.
 */
const RULE_TEXT_VOCABULARY = Object.freeze([...SHARED_VOCABULARY, /\bverdict/i]);

const INTERNAL_ID_IN_REPORT = /DIS-\d|BP-\d|\bF-\d/;

/** Session shapes chosen so that every unmeasured branch a rule has is reached. */
const VOCABULARY_SESSIONS = Object.freeze([
  // One per CLI: the sub-agent and tool-result rules branch on this alone.
  { cli: "claude", sessionId: "v-claude" },
  { cli: "codex", sessionId: "v-codex" },
  { cli: "gemini", sessionId: "v-gemini" },
  { cli: "kimi", sessionId: "v-kimi" },
  { cli: "opencode", sessionId: "v-opencode" },
  { cli: "some-other-cli", sessionId: "v-other" },
  // One per window shape: each is a different reason from `windowDenominator`.
  { cli: "claude", sessionId: "v-floor", model: "an-unlisted-model", window: { tokens: 91000, source: "observed-floor" }, turns: [{ ts: 1, context: { inputTokens: 80000 } }] },
  { cli: "claude", sessionId: "v-promoted", window: { tokens: 300000, source: "observed-promoted" }, turns: [{ ts: 1, context: { inputTokens: 250000 } }] },
  { cli: "claude", sessionId: "v-unsupported", window: { tokens: 200000, source: "model-id-table" }, turns: [{ ts: 1, context: { inputTokens: 10000 } }] },
  { cli: "claude", sessionId: "v-no-window", turns: [{ ts: 1, context: { inputTokens: 10000 } }] },
  { cli: "claude", sessionId: "v-no-readings", window: { tokens: 200000, source: "model-table" }, turns: [{ ts: 1 }, { ts: 2 }] },
  { cli: "kimi", sessionId: "v-native-over-one", turns: [{ ts: 1, context: { fraction: 1.4 } }] },
  // Cache counters, one branch each: reads only, creations only, both at zero.
  { cli: "claude", sessionId: "v-reads-only", turns: [{ ts: 1, cacheRead: 900 }] },
  { cli: "claude", sessionId: "v-creates-only", turns: [{ ts: 1, cacheCreate: 900 }] },
  { cli: "claude", sessionId: "v-cache-zero", turns: [{ ts: 1, cacheRead: 0, cacheCreate: 0 }] },
  // A measured session, so the observed/not-observed derivations and every
  // evidence row label are rendered too, not only the unknown reasons.
  {
    cli: "claude",
    sessionId: "v-measured",
    window: { tokens: 200000, source: "model-table" },
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T02:00:00.000Z",
    turns: [
      { ts: 1, context: { inputTokens: 180000 }, cacheRead: 100, cacheCreate: 900 },
      { ts: 2, context: { inputTokens: 190000 }, cacheRead: 200, cacheCreate: 800 },
    ],
  },
]);

/** Analyzer contexts, chosen the same way: one per branch a rule reads from ctx. */
const VOCABULARY_CONTEXTS = Object.freeze([
  {},
  { corpusComplete: true, childLinkageAvailable: true },
  { corpusComplete: false, sidechainTurns: 4, sessionMeta: { subagentSessionIds: [] } },
  { corpusComplete: true, sessionMeta: { subagentSessionIds: null } },
  { corpusComplete: true, childLinkageAvailable: false, sessionMeta: { subagentSessionIds: [] } },
  { promotion: { ladder: "none" } },
  { promotion: { ladder: "vendor" }, corpusComplete: true },
]);

/** Every RuleResult the analyzer can produce over the matrix above. */
function everyRuleResult() {
  const out = [];
  for (const session of VOCABULARY_SESSIONS) {
    for (const ctx of VOCABULARY_CONTEXTS) {
      for (const rule of RULES) out.push(evaluateRule(rule, session, ctx));
    }
  }
  return out;
}

/** The strings a rule SUPPLIES that the report renders, as `[where, text]`. */
function renderedRuleStrings(result) {
  const out = [];
  const push = (where, value) => {
    if (typeof value === "string" && value.trim()) out.push([where, value]);
  };
  push("name", result?.name);
  push("threshold.derivation", result?.threshold?.derivation);
  push("evidence.reason", result?.evidence?.reason);
  push("evidence.derivation", result?.evidence?.derivation);
  (result?.evidence?.values ?? []).forEach((value, index) => push(`evidence.values[${index}].label`, value?.label));
  return out;
}

test("no rule text the shared report renders uses the analyzer's own vocabulary", () => {
  const findings = new Set();
  let checked = 0;
  for (const result of everyRuleResult()) {
    for (const [where, text] of renderedRuleStrings(result)) {
      checked += 1;
      for (const word of RULE_TEXT_VOCABULARY) {
        if (word.test(text)) findings.add(`${result.id}.${where} leaks ${word} -> ${JSON.stringify(text)}`);
      }
    }
  }
  assert.ok(checked >= 300, `only ${checked} rendered rule strings were read — the matrix is not reaching the rules`);
  assert.deepEqual(
    [...findings],
    [],
    `a rule sends the analyzer's own vocabulary into the report:\n  ${[...findings].join("\n  ")}\n`
    + "Reword the sentence in plain English, keeping what it claims. Do NOT shrink the list to get green.",
  );
});

test("the rendered Markdown report carries none of it either — the path the file sweep exempts", () => {
  const documents = [];
  const shapes = new Set();
  for (const result of everyRuleResult()) {
    const shape = JSON.stringify(renderedRuleStrings(result));
    if (shapes.has(shape)) continue;
    shapes.add(shape);
    // As the analyzer produced it: section 4's Why column renders the reason.
    documents.push(reportOf({ rules: [result] }));
    // Forced to a finding: section 3 renders the threshold, the derivation and
    // every evidence row — fields the unknown path never reaches.
    documents.push(reportOf({ rules: [{ ...result, evidence: { ...result.evidence, status: "observed" } }] }));
  }
  const rendered = documents.join("\n");

  // Floors first: a guard that inspected nothing must not read as a pass.
  assert.ok(shapes.size >= 20, `only ${shapes.size} distinct rule shapes were rendered`);
  assert.ok(documents.length >= 40, `only ${documents.length} documents were rendered`);
  assert.ok(rendered.length >= 50000, `only ${rendered.length} characters of report were searched`);
  assert.ok(rendered.includes("- Threshold: "), "no threshold line was rendered — section 3 never ran");
  assert.ok(
    rendered.includes("no cache traffic is not a good cache rate"),
    "the sentence this guard was written for is not in the rendered text — the matrix stopped reaching it",
  );

  for (const word of SHARED_VOCABULARY) {
    const hits = rendered.match(new RegExp(word.source, "gi")) ?? [];
    assert.deepEqual([...new Set(hits)], [], `${word} reached the rendered report ${hits.length} time(s)`);
  }
  assert.equal(INTERNAL_ID_IN_REPORT.test(rendered), false, "an internal identifier reached the rendered report");
});
