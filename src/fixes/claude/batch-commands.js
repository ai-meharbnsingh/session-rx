/**
 * BP-001.17 / BP-004.03 — `claude-batch-commands`.
 *
 * Answers health rule `repeat-tool` (BP-003.03): the same tool, the same input
 * and the same RESULT, five or more times in one session.  That is a session
 * paying again for an answer it already had, and it is measurable rather than
 * suspected — which is why the appended text is a rule with a trigger and a
 * test, not an exhortation to be efficient.
 *
 * The write path, the backup, the journal and the diff all live in
 * `AppendSectionFix` (src/fixes/base.js).  This module contributes exactly
 * three things: a STABLE marker, a heading, and the text a developer's
 * `~/.claude/CLAUDE.md` receives.
 */

import { AppendSectionFix } from "../base.js";

export const FIX_ID = "claude-batch-commands";
/** Stable across releases: `check()` finds an already-applied section by this. */
export const MARKER = "session-rx:batch-commands:v1";
export const HEADING = "SessionRx: batch commands";
export const RULE_ID = "repeat-tool";
export const BLUEPRINT_ID = "BP-004.03";
export const TARGET = ".claude/CLAUDE.md";

/**
 * Line 1 is BP-004.03's appended text verbatim, so the blueprint sentence is
 * traceable in the file a user actually gets; the rules under it are what make
 * the sentence followable.  Every bullet names a concrete action an agent can
 * take at a decision point, because a line an agent cannot act on moves no
 * number.
 */
export const BODY = `Batch independent read-only commands when safe; avoid repeating identical tool calls and reuse verified results.

Trigger: you are about to make a tool call while a question you are already answering is still open.

- One question, one call. Every command needed to answer a single question goes in that one call — reading four files, or \`git status\` + \`git log -5\` + \`git diff --stat\`, is one call, not four. Independent calls are issued together in the same message, not one per message.
- Do not re-run a call whose answer is already in context. Before repeating any call, re-read the result you already have and cite it.
- Re-run an identical call only when you can name what changed since the last run — a file you edited, a build you triggered, a service you restarted — and say what changed in the same message.
- Search once, broadly: one \`rg\`/\`grep\` across the tree beats one per directory. Narrow with flags, not with more calls.
- Five identical calls returning the same result in one session means the earlier results were never read. Stop, re-read them, and continue from there instead of calling a sixth time.`;

export const TITLE = "Batch the calls that answer one question";

export const DESCRIPTION = "Append a CLAUDE.md rule that batches the commands needed to answer one "
  + "question into a single call, and forbids re-running a call whose answer is already in context.";

export const RATIONALE = "SessionRx flags a session when the same tool, the same input and the same "
  + "result recur five or more times (rule `repeat-tool`) — the session paid repeatedly for an "
  + "answer it already had. This section is the rule that stops it.";

/** BP-001.17. One delimited section appended to `~/.claude/CLAUDE.md`. */
export class BatchCommandsFix extends AppendSectionFix {
  constructor({ env, target = TARGET } = {}) {
    super({
      id: FIX_ID,
      title: TITLE,
      target,
      marker: MARKER,
      heading: HEADING,
      body: BODY,
      description: DESCRIPTION,
      rationale: RATIONALE,
      ruleId: RULE_ID,
      env,
    });
    this.blueprintId = BLUEPRINT_ID;
  }
}

export function createBatchCommandsFix(options = {}) {
  return new BatchCommandsFix(options);
}
