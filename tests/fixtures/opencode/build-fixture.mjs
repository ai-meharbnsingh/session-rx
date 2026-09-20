/**
 * Builds the OpenCode fixture databases.
 *
 * The fixture is GENERATED rather than committed as a binary so the schema it
 * asserts against is readable in review.  Tests build into a temp directory, so
 * no test ever opens the user's real `~/.local/share/opencode/opencode.db`.
 *
 * The fixture deliberately contains the `account`, `control_account` and
 * `credential` tables with token-shaped values, so the security test proves the
 * allowlist keeps real credential rows out of collector output instead of
 * proving it against a database where there was nothing to leak.  The planted
 * values are invented for this test and assembled from fragments so no
 * token-shaped literal appears in this source file.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The exact planted values, so a test can assert on them rather than a regex. */
export const PLANTED_SECRETS = Object.freeze([
  `sk-${"ant"}-${"A".repeat(48)}`,
  `gho_${"B".repeat(36)}`,
  `ya29.${"C".repeat(40)}`,
  `${"eyJhbGciOiJIUzI1NiJ9"}.${"D".repeat(30)}.${"E".repeat(22)}`,
]);

const SCHEMA = [
  `create table session (
    id text primary key, project_id text, workspace_id text, parent_id text,
    slug text, directory text, path text, title text, version text, share_url text,
    summary_additions integer, summary_deletions integer, summary_files integer,
    summary_diffs text, metadata text, cost real,
    tokens_input integer, tokens_output integer, tokens_reasoning integer,
    tokens_cache_read integer, tokens_cache_write integer,
    revert text, permission text, agent text, model text,
    time_created integer, time_updated integer, time_compacting integer, time_archived integer
  )`,
  `create table message (
    id text primary key, session_id text, time_created integer, time_updated integer, data text
  )`,
  `create table part (
    id text primary key, message_id text, session_id text,
    time_created integer, time_updated integer, data text
  )`,
  `create table session_message (
    id text primary key, session_id text, type text, seq integer,
    time_created integer, time_updated integer, data text
  )`,
  `create table project (
    id text primary key, worktree text, vcs text, name text,
    time_created integer, time_updated integer
  )`,
  `create table workspace (
    id text primary key, type text, name text, branch text, directory text,
    extra text, project_id text, time_used integer
  )`,
  // Present precisely so the security test has something real to keep out.
  `create table account (id text primary key, provider text, access_token text, refresh_token text)`,
  `create table control_account (id text primary key, email text, access_token text)`,
  `create table credential (id text primary key, name text, value text)`,
  `create index message_session_time_created_id_idx on message (session_id, time_created, id)`,
  `create index part_session_idx on part (session_id)`,
  `create index part_message_id_id_idx on part (message_id, id)`,
];

const T = 1700000000000;

/** Sessions, newest first once ordered by `time_created desc`. */
const SESSIONS = [
  {
    id: "ses_child", project_id: "proj_alpha", workspace_id: "ws_1", parent_id: "ses_mapped",
    slug: "child-slug", directory: "/Users/demo/alpha", cost: 0.02,
    tokens_input: 11, tokens_output: 2, tokens_reasoning: 0,
    tokens_cache_read: 90, tokens_cache_write: 3,
    agent: "general", model: JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic" }),
    time_created: T + 350000, time_updated: T + 360000,
  },
  {
    id: "ses_mapped", project_id: "proj_alpha", workspace_id: "ws_1", parent_id: null,
    slug: "alpha-slug", directory: "/Users/demo/alpha", cost: 0.5,
    tokens_input: 100, tokens_output: 20, tokens_reasoning: 7,
    tokens_cache_read: 5000, tokens_cache_write: 300,
    agent: "build", model: JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic" }),
    time_created: T + 300000, time_updated: T + 400000,
  },
  {
    id: "ses_unmapped", project_id: "proj_beta", workspace_id: "ws_1", parent_id: null,
    slug: "beta-slug", directory: "/Users/demo/beta", cost: 0,
    tokens_input: 402568, tokens_output: 12, tokens_reasoning: 0,
    tokens_cache_read: 0, tokens_cache_write: 0,
    agent: "build", model: JSON.stringify({ id: "nemotron-3.5-lightning-free", providerID: "opencode" }),
    time_created: T + 200000, time_updated: T + 210000,
  },
  {
    // Every numeric column NULL: an absent measurement must stay null, never 0.
    id: "ses_nulls", project_id: null, workspace_id: null, parent_id: null,
    slug: null, directory: null, cost: null,
    tokens_input: null, tokens_output: null, tokens_reasoning: null,
    tokens_cache_read: null, tokens_cache_write: null,
    agent: null, model: null,
    time_created: T + 100000, time_updated: null,
  },
  {
    // A session with no message rows at all: zero turns, no fabricated metrics.
    id: "ses_nomsg", project_id: "proj_alpha", workspace_id: "ws_1", parent_id: null,
    slug: "empty-slug", directory: "/Users/demo/alpha", cost: 0,
    tokens_input: null, tokens_output: null, tokens_reasoning: null,
    tokens_cache_read: null, tokens_cache_write: null,
    agent: "build", model: JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic" }),
    time_created: T + 50000, time_updated: T + 60000,
  },
];

const MESSAGES = [
  // A user message carries no tokens and must not become a turn.
  { id: "msg_u1", session_id: "ses_mapped", time_created: T + 300100, data: { role: "user", time: { created: T + 300100 }, agent: "build" } },
  {
    id: "msg_a1", session_id: "ses_mapped", time_created: T + 300200,
    data: {
      parentID: "msg_u1", role: "assistant", mode: "build", agent: "build",
      path: { cwd: "/Users/demo/alpha", root: "/Users/demo/alpha" }, cost: 0.4,
      tokens: { input: 100, output: 20, reasoning: 7, cache: { read: 5000, write: 300 } },
      modelID: "claude-sonnet-4-5", providerID: "anthropic",
      time: { created: T + 300200, completed: T + 300900 },
    },
  },
  {
    // An aborted turn: the error is detectable, the recorded zeros are real.
    id: "msg_a2", session_id: "ses_mapped", time_created: T + 301000,
    data: {
      parentID: "msg_a1", role: "assistant", agent: "build",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "claude-sonnet-4-5", providerID: "anthropic",
      time: { created: T + 301000, completed: T + 301100 },
      error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    },
  },
  {
    // No `tokens` object at all: context, cache and output stay null.
    id: "msg_a3", session_id: "ses_mapped", time_created: T + 302000,
    data: {
      parentID: "msg_a2", role: "assistant", agent: "build",
      modelID: "claude-sonnet-4-5", providerID: "anthropic",
      time: { created: T + 302000 },
    },
  },
  // A `data` column that is not valid JSON.
  { id: "msg_bad", session_id: "ses_mapped", time_created: T + 303000, raw: "{not json" },
  {
    id: "msg_un1", session_id: "ses_unmapped", time_created: T + 200100,
    data: {
      role: "assistant", agent: "build",
      tokens: { input: 402568, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "nemotron-3.5-lightning-free", providerID: "opencode",
      time: { created: T + 200100, completed: T + 200500 },
    },
  },
  {
    id: "msg_null1", session_id: "ses_nulls", time_created: T + 100100,
    data: {
      role: "assistant", agent: "build",
      tokens: { input: 5, output: 1, cache: { read: 0, write: 0 } },
      time: { created: T + 100100 },
    },
  },
  {
    id: "msg_ch1", session_id: "ses_child", time_created: T + 350100,
    data: {
      role: "assistant", agent: "general",
      tokens: { input: 11, output: 2, cache: { read: 90, write: 3 } },
      modelID: "claude-sonnet-4-5", providerID: "anthropic",
      time: { created: T + 350100, completed: T + 350200 },
    },
  },
];

const PARTS = [
  { id: "prt_1", message_id: "msg_a1", session_id: "ses_mapped", time_created: T + 300300, data: { type: "step-start" } },
  { id: "prt_2", message_id: "msg_a1", session_id: "ses_mapped", time_created: T + 300400, data: { type: "reasoning", text: "thinking" } },
  {
    id: "prt_3", message_id: "msg_a1", session_id: "ses_mapped", time_created: T + 300500,
    data: {
      type: "tool", tool: "bash", callID: "call-1",
      // 11 bytes of output: "hello world".
      state: { status: "completed", input: { command: "echo hello world" }, output: "hello world" },
    },
  },
  {
    // A call still running: a real call with no observable result bytes.
    id: "prt_4", message_id: "msg_a1", session_id: "ses_mapped", time_created: T + 300600,
    data: { type: "tool", tool: "read", callID: "call-2", state: { status: "pending", input: { path: "/tmp/x" } } },
  },
  { id: "prt_5", message_id: "msg_a1", session_id: "ses_mapped", time_created: T + 300700, data: { type: "text", text: "done" } },
  // An unrecognised tool part: no state at all.  toolResultBytes must stay null.
  { id: "prt_6", message_id: "msg_a3", session_id: "ses_mapped", time_created: T + 302100, data: { type: "tool", tool: "grep" } },
  // A `data` column that is not valid JSON.
  { id: "prt_bad", message_id: "msg_a2", session_id: "ses_mapped", time_created: T + 301200, raw: "{oops" },
  {
    id: "prt_7", message_id: "msg_un1", session_id: "ses_unmapped", time_created: T + 200200,
    data: { type: "tool", tool: "bash", callID: "call-3", state: { status: "completed", input: {}, output: "abc" } },
  },
];

function insertSession(db, row) {
  const columns = [
    "id", "project_id", "workspace_id", "parent_id", "slug", "directory", "cost",
    "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read",
    "tokens_cache_write", "agent", "model", "time_created", "time_updated",
  ];
  const holes = columns.map(() => "?").join(", ");
  db.prepare(`insert into session (${columns.join(", ")}) values (${holes})`)
    .run(...columns.map((column) => row[column] ?? null));
}

/** A full OpenCode-shaped database at `<home>/.local/share/opencode/opencode.db`. */
export function buildFixtureDb(home) {
  const dir = path.join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "opencode.db");
  rmSync(dbPath, { force: true });

  const db = new DatabaseSync(dbPath);
  for (const statement of SCHEMA) db.exec(statement);

  for (const row of SESSIONS) insertSession(db, row);

  const message = db.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)");
  for (const row of MESSAGES) {
    message.run(row.id, row.session_id, row.time_created, row.time_created, row.raw ?? JSON.stringify(row.data));
  }

  const part = db.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)");
  for (const row of PARTS) {
    part.run(row.id, row.message_id, row.session_id, row.time_created, row.time_created, row.raw ?? JSON.stringify(row.data));
  }

  db.prepare("insert into project (id, worktree, vcs, name, time_created, time_updated) values (?, ?, ?, ?, ?, ?)")
    .run("proj_alpha", "/Users/demo/alpha", "git", "alpha-app", T, T);
  // No `name`: the collector must fall back to the worktree basename.
  db.prepare("insert into project (id, worktree, vcs, name, time_created, time_updated) values (?, ?, ?, ?, ?, ?)")
    .run("proj_beta", "/Users/demo/beta", "git", null, T, T);
  db.prepare("insert into workspace (id, type, name, branch, directory, project_id, time_used) values (?, ?, ?, ?, ?, ?, ?)")
    .run("ws_1", "local", "alpha", "main", "/Users/demo/alpha", "proj_alpha", T);

  db.prepare("insert into account (id, provider, access_token, refresh_token) values (?, ?, ?, ?)")
    .run("acc_1", "anthropic", PLANTED_SECRETS[0], PLANTED_SECRETS[1]);
  db.prepare("insert into control_account (id, email, access_token) values (?, ?, ?)")
    .run("ctl_1", "demo@example.com", PLANTED_SECRETS[2]);
  db.prepare("insert into credential (id, name, value) values (?, ?, ?)")
    .run("cred_1", "OPENAI_API_KEY", PLANTED_SECRETS[3]);

  db.close();
  return dbPath;
}

/** A valid SQLite database that has none of the tables the collector expects. */
export function buildTablelessDb(home) {
  const dir = path.join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "opencode.db");
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec("create table unrelated (id text)");
  db.close();
  return dbPath;
}
