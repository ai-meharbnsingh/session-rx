/**
 * BP-001.18 / BP-004.04 — `claude-worker-cap`.
 *
 * Answers health rule `subagent-concurrency` (BP-003.06): peak simultaneous
 * sub-agents above half of what the session dispatched.  Fan-out is real and
 * large — 1,093 sub-agent transcripts across 87 sessions on one machine — and
 * it is where context multiplies: every worker is charged its own brief, and an
 * unbounded brief is charged again on every turn that worker takes.
 *
 * So the section caps BOTH halves of the cost: how many workers run at once,
 * and how much each one is handed.  A cap with a number in it is enforceable;
 * "delegate carefully" is not.
 *
 * The write path, backup, journal and diff belong to `AppendSectionFix`
 * (src/fixes/base.js).  This module contributes a stable marker, a heading and
 * the appended text.
 */

import { AppendSectionFix } from "../base.js";

export const FIX_ID = "claude-worker-cap";
/** Stable across releases: `check()` finds an already-applied section by this. */
export const MARKER = "session-rx:worker-cap:v1";
export const HEADING = "SessionRx: worker cap";
export const RULE_ID = "subagent-concurrency";
export const BLUEPRINT_ID = "BP-004.04";
export const TARGET = ".claude/CLAUDE.md";

/**
 * Line 1 is BP-004.04's appended text verbatim — it carries BP-003.06's actual
 * threshold, so the rule the user reads is the rule SessionRx measures.  The
 * rest turns that ratio into instructions that can be followed at dispatch
 * time, including the brief cap, which is the other half of the same cost.
 */
export const BODY = `Keep concurrent sub-agents at or below half of the dispatched worker count unless a deliberate exception is documented.

Trigger: you are about to dispatch a sub-agent, or a second one.

How many at once
- At most 3 sub-agents run at the same time, and never more than half of what the task dispatches in total. Dispatch in batches, and wait for a batch to return before starting the next — twelve workers is four batches, not twelve at once.
- Two workers never own the same file. Each brief states the paths that worker owns and the paths it must not touch.

What each worker receives
- A brief, not a transcript: the task, the paths it owns, the paths it must not touch, and the exact command that proves it is done. Keep it under 6,000 characters.
- A sub-agent inherits no context. A decision, a path or a constraint it needs is restated in its brief, or it does not exist for that worker.
- Bound the worker: it returns after roughly 60 tool calls with what it has. Work that needs more is split into a second worker with a disjoint scope, not given a larger budget.

What comes back
- One written report, read once. No mid-task conversation. A worker that needs a decision writes the question in its report and stops.
- Every worker is stopped before the parent reports the task finished. An idle worker still holds its context.`;

export const TITLE = "Cap sub-agent fan-out and brief size";

export const DESCRIPTION = "Append a CLAUDE.md rule capping how many sub-agents run at once and how "
  + "much context each one is handed, with an explicit batch discipline and brief limit.";

export const RATIONALE = "SessionRx flags a session whose peak simultaneous sub-agents exceeded half "
  + "of what it dispatched (rule `subagent-concurrency`). Fan-out multiplies context: each worker "
  + "pays for its own brief on every turn it takes, so both the count and the brief need a ceiling.";

/** BP-001.18. One delimited section appended to `~/.claude/CLAUDE.md`. */
export class WorkerCapFix extends AppendSectionFix {
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

export function createWorkerCapFix(options = {}) {
  return new WorkerCapFix(options);
}
