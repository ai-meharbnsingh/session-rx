/**
 * Wave 4B — `claude-auto-compact` (BP-004.01, DIS-008), the fix the BP-003.01
 * `context-pressure` rule offers.
 *
 * BP-004.01 is explicit that NO APPEND IS PERMITTED here: the whole change is
 * one named key, `"autoCompact": true`, shallow-merged into
 * `~/.claude/settings.json` by the wave-4A `JsonMergeFix`. That class spreads
 * the parsed object first and only then assigns the named key, so every
 * pre-existing key keeps its value AND its position, and a key this version has
 * never heard of is copied rather than dropped — it is a key a future CLI
 * version needs (BP-004.09). Serialization is two-space, the file's own newline
 * style wins, and a settings file that does not parse is refused outright.
 *
 * WHY THE KEY IS WORTH SETTING, in the terms the rule measures.
 * `context-pressure` compares the session's AVERAGE per-turn input tokens with
 * the window it actually had and warns above 0.70 of it (BP-003.01). The three
 * tenths left over are a headroom budget, not slack: they are what absorbs the
 * next turn's tool output and still leaves room to compact deliberately. With
 * auto-compaction on, the CLI compacts while that headroom still exists, so the
 * summary is written from a complete picture. Without it the session runs to the
 * ceiling and is truncated mid-task, which is exactly where the active
 * requirement, the decision just made, and the exact file paths get lost.
 *
 * WHAT THIS FILE ADDS over a bare `JsonMergeFix` — the DIS-008 schema gate.
 * DIS-008 rules that `autoCompact` is applied only as a named merged key after
 * preview, and that a settings schema which rejects it must FAIL CLOSED with a
 * diagnostic and no partial write. A developer can already have that name in
 * their file under a shape this fix does not understand — `"autoCompact":
 * "always"`, an object of sub-options, or `null`. Overwriting it with a boolean
 * would be a silent downgrade of their configuration, so:
 *
 *   - `computeTargets()` runs AFTER `super.computeTargets()` has applied every
 *     wave-4A guard (symlink, size, UTF-8, parses, is an object) and then
 *     refuses a non-boolean `autoCompact`. `computeTargets()` writes nothing, so
 *     the refusal happens before any backup, journal entry or target write
 *     exists — no partial write is possible, and `preview()` refuses too,
 *     because it calls the same method.
 *   - `check()` reports that case as status `unknown` rather than
 *     `not-applied`, so FVA-006 holds: the UI does not offer an apply that is
 *     going to refuse, and "no evidence" does not read as "all clear".
 *
 * An explicit `"autoCompact": false` is a DIFFERENT case and is allowed. It is a
 * boolean — the schema this fix understands — and flipping it is the entire
 * point of the fix. It is not silent either: `JsonMergeFix` records it in
 * `preview().conflicts` with the old and new value, the diff shows the line
 * changing, and `undo()` restores `false` byte-identically.
 */

import { readFile } from "node:fs/promises";

import { FIX_ERROR_CODES, FixError, JsonMergeFix } from "../base.js";

/** BP-004.01 — the exact file, the exact key, the exact marker. */
export const AUTO_COMPACT_ID = "claude-auto-compact";
export const AUTO_COMPACT_TARGET = ".claude/settings.json";
export const AUTO_COMPACT_KEY = "autoCompact";
export const AUTO_COMPACT_VALUE = true;

/**
 * The stable idempotency marker. BP-004.01 states it as the JSON key
 * `autoCompact === true`, and it is passed explicitly rather than left to
 * `JsonMergeFix`'s derived default so that a change to that default cannot
 * silently re-offer an applied fix.
 */
export const AUTO_COMPACT_MARKER = "autoCompact === true";

/** The merged fragment, exactly as BP-004.01 writes it. */
export const AUTO_COMPACT_MERGE = Object.freeze({ [AUTO_COMPACT_KEY]: AUTO_COMPACT_VALUE });

/** The rule whose finding this fix answers (BP-003.01). */
export const AUTO_COMPACT_RULE_ID = "context-pressure";

/**
 * The `details.reason` carried by the DIS-008 refusal. The error CODE stays
 * `TARGET_UNPARSEABLE` — the code wave 4A already uses for "valid JSON whose
 * shape cannot be merged into", and the one the API layer already maps to a
 * message — while this reason lets the UI say which shape was the problem.
 */
export const AUTO_COMPACT_SCHEMA_REASON = "autocompact-not-boolean";

export const AUTO_COMPACT_TITLE = "Enable auto-compaction in settings.json";

export const AUTO_COMPACT_DESCRIPTION =
  "Merge the single key \"autoCompact\": true into ~/.claude/settings.json so the CLI compacts while "
  + "the window still has headroom instead of being truncated at the ceiling. Every other key keeps "
  + "its value and its position.";

export const AUTO_COMPACT_RATIONALE =
  "BP-003.01 warns when a session's AVERAGE per-turn context passes 0.70 of the window it actually "
  + "had. The remaining three tenths are the budget that absorbs the next turn's tool output and "
  + "leaves room to compact on purpose; auto-compaction spends it that way. Without it the session "
  + "runs to the ceiling and is cut mid-task, which is where the active requirement, the decision "
  + "just made and the exact file paths are lost.";

/**
 * `JsonMergeFix` plus the DIS-008 schema gate. The merge itself, the ordering
 * guarantee, the backup, the diff and the journal are all wave 4A's; this class
 * adds a refusal and a status, and no write path of its own.
 */
export class AutoCompactFix extends JsonMergeFix {
  constructor({ env } = {}) {
    super({
      id: AUTO_COMPACT_ID,
      title: AUTO_COMPACT_TITLE,
      target: AUTO_COMPACT_TARGET,
      merge: { ...AUTO_COMPACT_MERGE },
      marker: AUTO_COMPACT_MARKER,
      description: AUTO_COMPACT_DESCRIPTION,
      rationale: AUTO_COMPACT_RATIONALE,
      ruleId: AUTO_COMPACT_RULE_ID,
      // BP-004.09 spells out two-space indentation; stated rather than inherited
      // so a change to the engine default cannot reformat a user's settings.
      indent: 2,
      env,
    });
    this.reversible = true;
  }

  /**
   * The value currently stored under `autoCompact`, or `undefined` if the key is
   * absent. Returns `{ known: false }` when the file cannot be re-read or
   * re-parsed, so the caller falls back to wave 4A's own verdict instead of
   * inventing one. This re-read is deliberately unguarded: it only ever runs
   * after `super.check()` has already taken the file through `readTarget`, and
   * it neither writes nor decides anything on its own.
   */
  async readStoredValue() {
    try {
      const parsed = JSON.parse(await readFile(this.target, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { known: false };
      }
      return { known: true, present: Object.hasOwn(parsed, AUTO_COMPACT_KEY), value: parsed[AUTO_COMPACT_KEY] };
    } catch {
      return { known: false };
    }
  }

  /** The DIS-008 refusal, shared by `check()` and `computeTargets()`. */
  schemaRejection(value) {
    return new FixError(
      FIX_ERROR_CODES.TARGET_UNPARSEABLE,
      `${this.display} already sets "${AUTO_COMPACT_KEY}" to ${JSON.stringify(value) ?? typeof value}, `
      + "which is not the boolean this fix understands. SessionRx will not overwrite a setting shape it "
      + "does not recognise, so nothing has been written. Set it to true by hand if that is what you want.",
      {
        path: this.target,
        display: this.display,
        key: AUTO_COMPACT_KEY,
        reason: AUTO_COMPACT_SCHEMA_REASON,
        foundType: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      },
    );
  }

  /**
   * FVA-006: a settings schema this fix cannot merge into is `unknown`, not
   * `not-applied`. `not-applied` would put an apply button on a fix that is
   * going to refuse.
   */
  async check() {
    const state = await super.check();
    if (state.status !== "not-applied") return state;
    const stored = await this.readStoredValue();
    if (!stored.known || !stored.present || typeof stored.value === "boolean") return state;
    const rejection = this.schemaRejection(stored.value);
    return {
      ...state,
      applied: false,
      drifted: false,
      status: "unknown",
      reason: AUTO_COMPACT_SCHEMA_REASON,
      message: rejection.message,
      foundType: rejection.details.foundType,
    };
  }

  /**
   * DIS-008 fail-closed gate. `super.computeTargets()` performs every wave-4A
   * read guard and produces the before/after bytes; it writes nothing, so
   * throwing here refuses before a backup, a journal entry or a target write can
   * exist. `preview()` calls the same method, so it refuses identically.
   */
  async computeTargets() {
    const targets = await super.computeTargets();
    const parsed = JSON.parse(targets[0].beforeText);
    if (Object.hasOwn(parsed, AUTO_COMPACT_KEY) && typeof parsed[AUTO_COMPACT_KEY] !== "boolean") {
      throw this.schemaRejection(parsed[AUTO_COMPACT_KEY]);
    }
    return targets;
  }
}

/**
 * The constructor the registry and the tests use. `env` is always injected in a
 * test; omitting it is the production path and is the only way this fix can
 * reach the developer's real `~/.claude/settings.json`.
 */
export function createAutoCompactFix({ env } = {}) {
  return new AutoCompactFix({ env });
}
