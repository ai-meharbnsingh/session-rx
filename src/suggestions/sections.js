/**
 * The instruction-section texts a suggestion offers to add.
 *
 * Moved from the deleted `src/fixes/claude/*.js` — SessionRx no longer writes
 * these into a file itself, but the text a user is asked to add is exactly
 * what those fixes used to append, unchanged. Each section is written as
 * guidance an AGENT reads and acts on, not phrased for any one CLI, so the
 * same body works whether the target file is Claude Code's CLAUDE.md,
 * Codex's AGENTS.md, Cursor's AGENTS.md, or Antigravity's GEMINI.md.
 *
 * `marker` is the stable, versioned HTML comment SessionRx looks for to tell
 * whether a section has already been added (the idempotence gate — see
 * `src/suggestions/targets.js`). `renderSection()` is the exact byte shape a
 * request asks the target tool to append.
 */

export function renderSection({ marker, heading, body }) {
  return `<!-- ${marker} -->\n## ${heading}\n${body}\n<!-- /${marker} -->\n`;
}

export const OUTPUT_HYGIENE = {
  id: "claude-output-hygiene",
  ruleId: "large-tool-result",
  marker: "session-rx:output-hygiene:v1",
  heading: "SessionRx: output hygiene",
  title: "Bound large tool output in the instructions file",
  description: "Add a delimited \"SessionRx: output hygiene\" section telling the agent to bound tool "
    + "output at the source, redirect long output to a file and cite the path, and grep for a symbol "
    + "instead of reading a whole file.",
  rationale: "SessionRx flags a session once three or more tool results each exceed 10,240 bytes. Those "
    + "bytes do not cost one turn: every later turn re-reads them, so a handful of unbounded commands is "
    + "what pushes average per-turn context toward the window ceiling.",
  body: [
    "Bound every tool result before it enters the transcript. A result over 10 KiB is",
    "not paid for once: it is re-read as context on every later turn of the session.",
    "",
    "- Never run a command whose output length is unknown. Bound it at the source:",
    "  `<cmd> | head -50`, `<cmd> | tail -50`, `git diff --stat` before `git diff`,",
    "  `ls | head -30` before a recursive listing.",
    "- If the full output matters, redirect it to a file (`<cmd> > /tmp/out.log 2>&1`),",
    "  read back only the lines that answer the question, and cite that path for the rest.",
    "- Locate before reading: `grep -n '<symbol>' <file>` first, then read that window",
    "  with an offset and a limit. Do not read a whole file to find one definition.",
    "- State a large result's conclusion in one or two lines as soon as it arrives, then",
    "  work from that summary instead of quoting the result again.",
    "",
    "SessionRx suggested this section because a session produced three or more tool results",
    "over 10 KiB each, the point at which output size stops being one necessary answer",
    "and becomes the reason the context window fills.",
  ].join("\n"),
};

export const BATCH_COMMANDS = {
  id: "claude-batch-commands",
  ruleId: "repeat-tool",
  marker: "session-rx:batch-commands:v1",
  heading: "SessionRx: batch commands",
  title: "Batch the calls that answer one question",
  description: "Add a section that batches the commands needed to answer one question into a single "
    + "call, and forbids re-running a call whose answer is already in context.",
  rationale: "SessionRx flags a session when the same tool, the same input and the same result recur "
    + "five or more times — the session paid repeatedly for an answer it already had.",
  body: [
    "Batch independent read-only commands when safe; avoid repeating identical tool calls and reuse verified results.",
    "",
    "Trigger: you are about to make a tool call while a question you are already answering is still open.",
    "",
    "- One question, one call. Every command needed to answer a single question goes in that one call —",
    "  reading four files, or `git status` + `git log -5` + `git diff --stat`, is one call, not four.",
    "  Independent calls are issued together in the same message, not one per message.",
    "- Do not re-run a call whose answer is already in context. Before repeating any call, re-read the",
    "  result you already have and cite it.",
    "- Re-run an identical call only when you can name what changed since the last run — a file you",
    "  edited, a build you triggered, a service you restarted — and say what changed in the same message.",
    "- Search once, broadly: one `rg`/`grep` across the tree beats one per directory. Narrow with flags,",
    "  not with more calls.",
    "- Five identical calls returning the same result in one session means the earlier results were never",
    "  read. Stop, re-read them, and continue from there instead of calling a sixth time.",
  ].join("\n"),
};

export const WORKER_CAP = {
  id: "claude-worker-cap",
  ruleId: "subagent-concurrency",
  marker: "session-rx:worker-cap:v1",
  heading: "SessionRx: worker cap",
  title: "Cap sub-agent fan-out and brief size",
  description: "Add a rule capping how many sub-agents run at once and how much context each one is "
    + "handed, with an explicit batch discipline and brief limit.",
  rationale: "SessionRx flags a session whose peak simultaneous sub-agents exceeded half of what it "
    + "dispatched. Fan-out multiplies context: each worker pays for its own brief on every turn it takes.",
  body: [
    "Keep concurrent sub-agents at or below half of the dispatched worker count unless a deliberate exception is documented.",
    "",
    "Trigger: you are about to dispatch a sub-agent, or a second one.",
    "",
    "How many at once",
    "- At most 3 sub-agents run at the same time, and never more than half of what the task dispatches in",
    "  total. Dispatch in batches, and wait for a batch to return before starting the next — twelve workers",
    "  is four batches, not twelve at once.",
    "- Two workers never own the same file. Each brief states the paths that worker owns and the paths it",
    "  must not touch.",
    "",
    "What each worker receives",
    "- A brief, not a transcript: the task, the paths it owns, the paths it must not touch, and the exact",
    "  command that proves it is done. Keep it under 6,000 characters.",
    "- A sub-agent inherits no context. A decision, a path or a constraint it needs is restated in its",
    "  brief, or it does not exist for that worker.",
    "- Bound the worker: it returns after roughly 60 tool calls with what it has. Work that needs more is",
    "  split into a second worker with a disjoint scope, not given a larger budget.",
    "",
    "What comes back",
    "- One written report, read once. No mid-task conversation. A worker that needs a decision writes the",
    "  question in its report and stops.",
    "- Every worker is stopped before the parent reports the task finished. An idle worker still holds its context.",
  ].join("\n"),
};

export const COMPACT_CONTRACT = {
  id: "claude-compact-contract",
  ruleId: "long-rising-context",
  marker: "session-rx:compact-contract:v1",
  heading: "SessionRx: compact contract",
  title: "State what must survive a compaction",
  description: "Add a contract naming the facts a compaction must carry forward verbatim and the bulky "
    + "output it may drop, so a long session does not lose the commands, paths and open questions the "
    + "work depends on.",
  rationale: "SessionRx flags a session that ran over four hours with its context slope still rising — "
    + "it is accumulating, not compacting. Compacting only helps if the facts the work depends on "
    + "survive it, so this section enumerates them.",
  body: [
    "When context pressure rises, compact deliberately: preserve active requirements, decisions, unresolved risks, and exact file paths before continuing.",
    "",
    "Trigger: context is being compacted or summarized, or the session is being handed to another session.",
    "",
    "PRESERVE, verbatim. A summary missing any of these has failed, however short it is:",
    "- the exact command that runs the tests or the build, and its last exit code",
    "- every file path created or modified in this session",
    "- the task being worked on, and which declared steps are already finished",
    "- every question waiting on the user, in the words it was asked",
    "- identifiers that cannot be re-derived by reading the repo: branch name, commit SHAs, ticket or issue ids, URLs, ports, environment and service names",
    "",
    "DROP, keeping one line each:",
    "- tool output bodies — logs, diffs, file contents, test transcripts, directory listings. Keep the one-line conclusion and the path to the full output.",
    "- superseded plans and abandoned approaches. Keep the decision that was reached, not the deliberation that reached it.",
    "",
    "- A dropped fact is recovered by reading the file again, never by recalling it from memory.",
    "- If a PRESERVE item is missing after a compaction, say which one is missing and re-read it. Do not continue on a guess, and do not re-derive a decision the user already made.",
  ].join("\n"),
};

/** Every instruction section, keyed by the same id `rule.fix` already names. */
export const INSTRUCTION_SECTIONS = {
  [OUTPUT_HYGIENE.id]: OUTPUT_HYGIENE,
  [BATCH_COMMANDS.id]: BATCH_COMMANDS,
  [WORKER_CAP.id]: WORKER_CAP,
  [COMPACT_CONTRACT.id]: COMPACT_CONTRACT,
};

/**
 * The one settings-file suggestion. Claude Code is the only tool with a
 * confirmed setting for this: the key `"autoCompact": true`, the exact
 * key/value `src/fixes/claude/auto-compact.js` used to write.
 */
export const AUTO_COMPACT = {
  id: "claude-auto-compact",
  ruleId: "context-pressure",
  key: "autoCompact",
  value: true,
  title: "Enable auto-compaction in settings",
  description: "Add the single key \"autoCompact\": true to the settings file so the CLI compacts while "
    + "the window still has headroom instead of being truncated at the ceiling.",
  rationale: "SessionRx warns when a session's average per-turn context passes 0.70 of the window it "
    + "actually had. The remaining three tenths are the budget that absorbs the next turn's tool output "
    + "and leaves room to compact on purpose; auto-compaction spends it that way.",
  // No settings target for another tool is confirmed, so a non-Claude session
  // is offered this instruction section instead — the same "compact
  // deliberately" contract, phrased for an agent rather than for a setting.
  fallbackSection: COMPACT_CONTRACT,
};

export const SUGGESTION_DEFS = { ...INSTRUCTION_SECTIONS, [AUTO_COMPACT.id]: AUTO_COMPACT };
