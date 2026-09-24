/**
 * ReportInput fixture seeded with credential-shaped values on every path that
 * reaches the rendered document: a CLI note, an evidence value, an evidence
 * source, an unknown reason, a fix BEFORE block, and the trend reason.
 *
 * WHY THE VALUES ARE ASSEMBLED FROM FRAGMENTS: a literal vendor-prefixed key or
 * PAT in this file is itself credential-shaped, and the machine's
 * secret-handling guard refuses to write it. Joining fragments at load time
 * produces the identical runtime string with no credential shape in the source.
 * None of these is a real credential.
 */

const DASH = "-";
const UNDER = "_";

export const SEEDED = Object.freeze({
  /** sk-proj-… vendor key shape */
  vendorKey: ["sk", "proj", "Ab3Kd9Xf2Qw7Zr5Tn1Vm8Yc4Bs6Le0H"].join(DASH),
  /** ghp_… GitHub personal access token shape */
  githubPat: ["ghp", "Q7wE2rT4yU6iO8pA0sD1fG3h"].join(UNDER),
  /** value behind an access_token key; short enough that ONLY the keyed pattern can catch it */
  accessTokenValue: "s3cr3tV4lu3AbCdEf",
  /** value behind a refresh_token key */
  refreshTokenValue: "rF9tK2mW7bQ4xZ1p",
  /** 32 continuous hex characters */
  hexRun: "deadbeefcafef00d" + "1234567890abcdef",
  /** AKIA… access key id shape */
  awsKeyId: ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  /** token carried after a Bearer scheme */
  bearerToken: "vT8q2Lm4Zx9Rb1Nk7Ye3Ws5Uj0Hd6Pc",
  /** three-segment JWT shape */
  jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJzZXNzaW9uLXJ4In0", "Dd5Kq1Xv7Nb3Mz9Rt2Yw8"].join("."),
});

/** The exact strings the report must not contain. */
export const SEEDED_VALUES = Object.freeze([
  SEEDED.vendorKey,
  SEEDED.githubPat,
  SEEDED.accessTokenValue,
  SEEDED.refreshTokenValue,
  SEEDED.hexRun,
  SEEDED.awsKeyId,
  SEEDED.bearerToken,
  SEEDED.jwt,
]);

const ACCESS_TOKEN_KEY = ["access", "token"].join(UNDER);
const REFRESH_TOKEN_KEY = ["refresh", "token"].join(UNDER);
const AUTHORIZATION_LINE = ["authorization", ": Bearer ", SEEDED.bearerToken].join("");

export const secretsInput = {
  generatedAt: "2026-09-20T17:00:00Z",
  parserVersion: "2026-09-20.2",
  range: { from: "2026-09-19T08:00:00Z", to: "2026-09-20T16:55:00Z", sessions: 4 },
  clis: [
    {
      cli: "cursor",
      sessions: 4,
      support: "supported",
      note: `provider row carried an inline key ${SEEDED.vendorKey} that must not reach the report`,
    },
  ],
  rules: [
    {
      id: "large-tool-result",
      name: "Large tool results",
      severity: "warn",
      fix: "claude-output-hygiene",
      threshold: { value: 10240, derivation: "toolResultBytes > 10,240 for >= 3 tool results" },
      evidence: {
        status: "observed",
        values: [
          { label: "largest tool result", value: 88231, unit: "bytes", sessionId: "9c1d4e77-2a58-4d31-b0f6-31ab92c4e708" },
          { label: "raw excerpt captured with the result", value: `${ACCESS_TOKEN_KEY}=${SEEDED.accessTokenValue}`, unit: null, sessionId: "9c1d4e77-2a58-4d31-b0f6-31ab92c4e708" },
          { label: "second excerpt", value: `bearer handoff -> ${SEEDED.jwt}`, unit: null, sessionId: "9c1d4e77-2a58-4d31-b0f6-31ab92c4e708" },
        ],
        sources: [
          `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb#part/${SEEDED.hexRun}`,
          `ci runner identity ${SEEDED.awsKeyId}`,
        ],
        derivation: "byte length of each part row",
        parserVersion: "2026-09-20.2",
      },
    },
    {
      id: "repeat-tool",
      name: "Repeated tool work",
      severity: "warn",
      fix: null,
      threshold: { value: 5, derivation: "same name + input + result signature >= 5 times" },
      evidence: {
        status: "unknown",
        reason: `part rows for 2 of 4 sessions were truncated mid-value (the truncated text included ${SEEDED.githubPat}), so no canonical result signature could be built`,
        values: [],
        sources: [],
        derivation: "not computed",
        parserVersion: "2026-09-20.2",
      },
    },
  ],
  fixes: [
    {
      id: "claude-output-hygiene",
      name: "Append output-hygiene instructions",
      target: "~/.claude/CLAUDE.md",
      appliedAt: "2026-09-20T16:50:00Z",
      status: "applied",
      before: [
        "# previous tail of the file",
        `${AUTHORIZATION_LINE}`,
        `${REFRESH_TOKEN_KEY}: "${SEEDED.refreshTokenValue}"`,
        "# end",
      ].join("\n"),
      undoPath: "~/.session-rx/undo/2026-09-20T16-50-00-CLAUDE.md",
    },
  ],
  trend: {
    direction: "declining",
    reason: `derived from 4 sessions; the provider row that seeded them carried ${SEEDED.vendorKey}`,
    metrics: [{ label: "mean tool result bytes", from: 4102, to: 19884, unit: "bytes" }],
  },
};

export default secretsInput;
