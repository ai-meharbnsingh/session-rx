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

test("no fixes renders an explicit statement, not an empty section", () => {
  const md = generateReport(zeroFindingsInput);
  assert.match(md, /## 5\. Fixes applied\n\nNo fix was applied in this period\./);
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
