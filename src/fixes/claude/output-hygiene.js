/**
 * Wave 4B — `claude-output-hygiene` (BP-004.02), the fix the BP-003.04
 * `large-tool-result` rule offers.
 *
 * This is an INSTRUCTION fix: one delimited section appended to
 * `~/.claude/CLAUDE.md` by the wave-4A `AppendSectionFix`, which carries the
 * prior bytes over with `Buffer.concat` and therefore cannot reformat a
 * hand-maintained file (BP-004.08).  Nothing here opens a file, writes a
 * backup, renders a diff or touches the journal — that is all `WritableFix`,
 * on purpose: a second write path is how a preview stops matching an apply.
 *
 * WHAT THE TEXT SAYS, and why it says it that way.  `large-tool-result` fires
 * on an OBSERVED count — three or more tool results over 10,240 bytes in one
 * session (`src/analyzer/rules.js`, BP-003.04).  A rule that answered it with
 * "keep output concise" would change no behaviour, because the CLI reading
 * CLAUDE.md cannot act on an adjective.  So the body names the mechanisms that
 * actually reduce that byte count and are available in every session: bound the
 * command at the source, redirect the long form to a file and cite the path,
 * locate with grep before reading a window, and state a big result's conclusion
 * once instead of carrying it forward.  Each line is a thing to do, checkable
 * after the fact against the next session's `toolResultBytes`.
 *
 * The marker is STABLE and versioned (`…:v1`).  `check()` finds an
 * already-applied section by it, `computeTargets()` refuses a second apply with
 * `ALREADY_APPLIED`, and the UI therefore never offers the fix twice.  Bumping
 * the body without bumping the marker is a drift the engine reports
 * (`section-modified`) rather than silently re-appending; bumping the marker is
 * a deliberate new section, which is why the version is in the marker at all.
 */

import { AppendSectionFix } from "../base.js";

/** BP-004.02 — the exact file, marker and heading. Do not change in place. */
export const OUTPUT_HYGIENE_ID = "claude-output-hygiene";
export const OUTPUT_HYGIENE_TARGET = ".claude/CLAUDE.md";
export const OUTPUT_HYGIENE_MARKER = "session-rx:output-hygiene:v1";
export const OUTPUT_HYGIENE_HEADING = "SessionRx: output hygiene";

/** The rule whose finding this fix answers (BP-003.04). */
export const OUTPUT_HYGIENE_RULE_ID = "large-tool-result";

/**
 * BP-003.04 also links `cache-hit` to this fix, because a prefix that keeps
 * growing by 10 KiB blocks is a prefix that keeps missing cache. The primary
 * rule id stays `large-tool-result`; this is the secondary caller.
 */
export const OUTPUT_HYGIENE_ALSO_RULE_IDS = Object.freeze(["cache-hit"]);

/**
 * Built from lines rather than one template literal so that every backtick in
 * the guidance is a literal backtick in the file, with nothing to escape and
 * nothing to get wrong. The joined string is the body verbatim; it carries no
 * trailing newline because `buildDelimitedSection` adds the one before the
 * closing marker.
 */
const OUTPUT_HYGIENE_BODY_LINES = Object.freeze([
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
  "SessionRx appends this section when a session produced three or more tool results",
  "over 10 KiB each, the point at which output size stops being one necessary answer",
  "and becomes the reason the context window fills.",
]);

export const OUTPUT_HYGIENE_BODY = OUTPUT_HYGIENE_BODY_LINES.join("\n");

export const OUTPUT_HYGIENE_TITLE = "Bound large tool output in CLAUDE.md";

/** One line, because the fix card shows one line. */
export const OUTPUT_HYGIENE_DESCRIPTION =
  "Append a delimited \"SessionRx: output hygiene\" section to ~/.claude/CLAUDE.md telling the CLI "
  + "to bound tool output at the source, redirect long output to a file and cite the path, and grep "
  + "for a symbol instead of reading a whole file. Existing content is not modified or reformatted.";

export const OUTPUT_HYGIENE_RATIONALE =
  "BP-003.04 flags a session once three or more tool results each exceed 10,240 bytes. Those bytes do "
  + "not cost one turn: every later turn re-reads them, so a handful of unbounded commands is what "
  + "pushes average per-turn context toward the window ceiling. The instruction is written as "
  + "mechanisms the CLI can act on in the next session, not as a preference.";

/**
 * `AppendSectionFix` plus the one thing BP-004 asks a concrete fix to publish
 * without doing IO first: `reversible`. `preview()` already returns it, but the
 * catalogue renders a card before any file is read.
 */
export class OutputHygieneFix extends AppendSectionFix {
  constructor({ env } = {}) {
    super({
      id: OUTPUT_HYGIENE_ID,
      title: OUTPUT_HYGIENE_TITLE,
      target: OUTPUT_HYGIENE_TARGET,
      marker: OUTPUT_HYGIENE_MARKER,
      heading: OUTPUT_HYGIENE_HEADING,
      body: OUTPUT_HYGIENE_BODY,
      description: OUTPUT_HYGIENE_DESCRIPTION,
      rationale: OUTPUT_HYGIENE_RATIONALE,
      ruleId: OUTPUT_HYGIENE_RULE_ID,
      env,
    });
    this.reversible = true;
    this.alsoRuleIds = OUTPUT_HYGIENE_ALSO_RULE_IDS;
  }
}

/**
 * The constructor the registry and the tests use. `env` is always injected in a
 * test; omitting it is the production path and is the only way this fix can
 * reach the developer's real `~/.claude/CLAUDE.md`.
 */
export function createOutputHygieneFix({ env } = {}) {
  return new OutputHygieneFix({ env });
}
