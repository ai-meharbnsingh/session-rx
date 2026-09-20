/**
 * BP-001.19 / BP-004.05 — `claude-compact-contract`.
 *
 * Answers health rule `long-rising-context` (BP-003.05): more than four hours
 * elapsed AND a context slope still rising — a session accumulating rather than
 * compacting.  Context pressure is not hypothetical here: sessions on this
 * machine average 237,666 tokens of context per turn across 360 turns, so a
 * compaction is going to happen whether or not it is planned for.
 *
 * Which is the whole point of this section.  Compaction is not the risk; a
 * compaction that silently drops the exact test command, the list of modified
 * files, or the question the user is waiting on IS the risk — the session then
 * continues confidently on a guess.  So the appended text is an explicit
 * PRESERVE list and an explicit DROP list.  "Keep the important context" names
 * nothing and therefore protects nothing.
 *
 * The write path, backup, journal and diff belong to `AppendSectionFix`
 * (src/fixes/base.js).  This module contributes a stable marker, a heading and
 * the appended text.
 */

import { AppendSectionFix } from "../base.js";

export const FIX_ID = "claude-compact-contract";
/** Stable across releases: `check()` finds an already-applied section by this. */
export const MARKER = "session-rx:compact-contract:v1";
export const HEADING = "SessionRx: compact contract";
export const RULE_ID = "long-rising-context";
export const BLUEPRINT_ID = "BP-004.05";
export const TARGET = ".claude/CLAUDE.md";

/**
 * Line 1 is BP-004.05's appended text verbatim.  Everything under it exists
 * because that sentence, on its own, does not say WHICH facts must survive —
 * and a preserve rule that does not enumerate is not checkable by the agent
 * applying it or by the user reading the summary afterwards.
 */
export const BODY = `When context pressure rises, compact deliberately: preserve active requirements, decisions, unresolved risks, and exact file paths before continuing.

Trigger: context is being compacted or summarized, or the session is being handed to another session.

PRESERVE, verbatim. A summary missing any of these has failed, however short it is:
- the exact command that runs the tests or the build, and its last exit code
- every file path created or modified in this session
- the task being worked on, and which declared steps are already finished
- every question waiting on the user, in the words it was asked
- identifiers that cannot be re-derived by reading the repo: branch name, commit SHAs, ticket or issue ids, URLs, ports, environment and service names

DROP, keeping one line each:
- tool output bodies — logs, diffs, file contents, test transcripts, directory listings. Keep the one-line conclusion and the path to the full output.
- superseded plans and abandoned approaches. Keep the decision that was reached, not the deliberation that reached it.

- A dropped fact is recovered by reading the file again, never by recalling it from memory.
- If a PRESERVE item is missing after a compaction, say which one is missing and re-read it. Do not continue on a guess, and do not re-derive a decision the user already made.`;

export const TITLE = "State what must survive a compaction";

export const DESCRIPTION = "Append a CLAUDE.md contract naming the facts a compaction must carry "
  + "forward verbatim and the bulky output it may drop, so a long session does not lose the "
  + "commands, paths and open questions the work depends on.";

export const RATIONALE = "SessionRx flags a session that ran over four hours with its context slope "
  + "still rising (rule `long-rising-context`) — it is accumulating, not compacting. Compacting only "
  + "helps if the facts the work depends on survive it, so this section enumerates them.";

/** BP-001.19. One delimited section appended to `~/.claude/CLAUDE.md`. */
export class CompactContractFix extends AppendSectionFix {
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

export function createCompactContractFix(options = {}) {
  return new CompactContractFix(options);
}
