/**
 * SessionRx fix engine foundation — BP-004 fix contracts, BP-004.06..10 apply /
 * undo invariants, FVA-007 transaction journal.
 *
 * Every concrete fix (waves 4B/4C) is one of three kinds:
 *
 *   append-section  a DELIMITED block appended to a markdown file.  Existing
 *                   bytes are never rewritten or reflowed — the bytes written
 *                   are `Buffer.concat([before, section])`, so a hand-
 *                   maintained CLAUDE.md survives byte-for-byte (BP-004.08).
 *   json-merge      a shallow merge of NAMED keys into a JSON settings file.
 *                   Existing keys keep their value, their order, and their
 *                   presence; a key this version does not recognise is a key a
 *                   future CLI version needs (BP-004.09).
 *   recommendation  DISPLAY ONLY.  `HabitRecommendation` does not descend from
 *                   `WritableFix`, so there is no `apply` anywhere on its
 *                   prototype chain — it *cannot* write rather than choosing
 *                   not to.  Instance and prototype are frozen so one cannot be
 *                   bolted on either (BP-004).
 *
 * Three rules make this safe to point at a developer's real config:
 *
 *   1. preview() cannot lie (BP-004.06).  preview() and apply() call the same
 *      `computeTargets()` and render the same diff from the same bytes, and
 *      preview publishes `afterHash` — the sha256 of exactly what apply() will
 *      write.  The test asserts the post-apply on-disk hash equals it.
 *   2. Backup precedes every write (BP-004.07).  The backup is written from the
 *      same buffer the diff was computed from, then re-read and hashed, and the
 *      target is re-hashed too, before a single byte of it is replaced.
 *   3. undo() refuses rather than clobbers (FVA-007, BP-004.10).  The journal
 *      records the target hash before AND after apply; if the on-disk hash no
 *      longer matches `hashAfter` the file was edited after apply(), and undo()
 *      stops with a diagnostic instead of destroying that later edit.
 *
 * Nothing here writes outside `<stateDir>` (default `~/.session-rx/`) and the
 * declared target: `guardedWrite` re-checks every destination, and a target
 * that resolves outside the configured home is rejected at construction.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Bumped whenever the journal record shape or the write protocol changes. */
export const FIX_ENGINE_VERSION = "2026-09-20.2";

export const STATE_DIR_NAME = ".session-rx";
export const UNDO_DIR_NAME = "undo";
export const JOURNAL_NAME = "journal.jsonl";
export const TRANSACTION_NAME = "transaction.json";

/** BP-004 recognises exactly these three kinds; `recommendation` never writes. */
export const FIX_KINDS = Object.freeze(["append-section", "json-merge", "recommendation"]);

/** FVA-006 status triad, reused for `check()` so "no evidence" is never "clear". */
export const FIX_CHECK_STATUSES = Object.freeze(["applied", "not-applied", "unknown"]);

/**
 * A config file larger than this is not something SessionRx understands well
 * enough to rewrite, so it is refused rather than guessed at.
 */
export const MAX_TARGET_BYTES = 8 * 1024 * 1024;

/** Above this many LCS cells the diff degrades to a block replace, not a hang. */
const MAX_DIFF_CELLS = 4_000_000;

const DIFF_CONTEXT = 3;

export const FIX_ERROR_CODES = Object.freeze({
  SPEC_INVALID: "SPEC_INVALID",
  PATH_ESCAPE: "PATH_ESCAPE",
  TARGET_MISSING: "TARGET_MISSING",
  TARGET_NOT_FILE: "TARGET_NOT_FILE",
  TARGET_IS_SYMLINK: "TARGET_IS_SYMLINK",
  TARGET_UNREADABLE: "TARGET_UNREADABLE",
  TARGET_UNWRITABLE: "TARGET_UNWRITABLE",
  TARGET_TOO_LARGE: "TARGET_TOO_LARGE",
  TARGET_UNPARSEABLE: "TARGET_UNPARSEABLE",
  ALREADY_APPLIED: "ALREADY_APPLIED",
  MARKER_DRIFT: "MARKER_DRIFT",
  EXTERNAL_EDIT: "EXTERNAL_EDIT",
  UNDO_RECORD_MISSING: "UNDO_RECORD_MISSING",
  UNDO_RECORD_CORRUPT: "UNDO_RECORD_CORRUPT",
  ALREADY_UNDONE: "ALREADY_UNDONE",
  RESTORE_NOT_BYTE_IDENTICAL: "RESTORE_NOT_BYTE_IDENTICAL",
  WRITE_NOT_VERIFIED: "WRITE_NOT_VERIFIED",
  WRITE_OUT_OF_BOUNDS: "WRITE_OUT_OF_BOUNDS",
  NOT_APPLYABLE: "NOT_APPLYABLE",
});

/**
 * Every refusal in this module is a FixError with a stable `code`, because the
 * UI has to tell the user WHY a fix will not run — "something went wrong" on a
 * file this important is not an acceptable message.
 */
export class FixError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FixError";
    this.code = code;
    this.details = details;
  }

  /** Shape the API returns; `details` is path/hash metadata only, never content. */
  toJSON() {
    return { error: this.code, message: this.message, details: this.details };
  }
}

export function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

/**
 * The file's OWN newline style wins.  A CLAUDE.md written on Windows must not
 * acquire a lone LF section: mixed terminators are exactly the kind of silent
 * reformat BP-004.08 forbids.  CRLF wins on a tie because a CRLF file's `\n`
 * count can never exceed its `\r\n` count without truly mixed content.
 */
export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > 0 && crlf >= bareLf ? "\r\n" : "\n";
}

export function endsWithNewline(text) {
  return /(\r\n|\n|\r)$/.test(text);
}

/**
 * The exact BP-004 section shape.  Waves 4B/4C pass `marker`, `heading`, `body`
 * and get the blueprint's appended text verbatim — the leading `\n` is the
 * blank line that separates the block from whatever the user wrote above it.
 */
export function buildDelimitedSection({ marker, heading, body }) {
  if (!marker || !heading || typeof body !== "string") {
    throw new FixError(
      FIX_ERROR_CODES.SPEC_INVALID,
      "a delimited section needs marker, heading and body",
      { marker, heading },
    );
  }
  return `\n<!-- ${marker} -->\n## ${heading}\n${body}\n<!-- /${marker} -->\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function openMarkerOf(marker) {
  return `<!-- ${marker} -->`;
}

function closeMarkerOf(marker) {
  return `<!-- /${marker} -->`;
}

// ---------------------------------------------------------------------------
// Unified diff.  The diff is what the user CONSENTS to, so it is rendered from
// the same before/after buffers apply() writes — never from a description of
// the change.  `afterHash` in preview() is the machine-checkable half of that
// promise; this is the human-readable half.
// ---------------------------------------------------------------------------

/** Split into lines that KEEP their terminator, so EOL changes are visible. */
function tokenizeLines(text) {
  const tokens = [];
  const re = /\r\n|\n|\r/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    tokens.push(text.slice(last, match.index + match[0].length));
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push(text.slice(last));
  return tokens;
}

function lcsOps(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j]
        ? table[(i + 1) * cols + (j + 1)] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", token: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
      ops.push({ type: "-", token: a[i] });
      i += 1;
    } else {
      ops.push({ type: "+", token: b[j] });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ type: "-", token: a[i++] });
  while (j < b.length) ops.push({ type: "+", token: b[j++] });
  return ops;
}

function diffOps(beforeText, afterText) {
  const a = tokenizeLines(beforeText);
  const b = tokenizeLines(afterText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head
    && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail += 1;
  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);
  const middle = aMid.length * bMid.length > MAX_DIFF_CELLS
    ? [
      ...aMid.map((token) => ({ type: "-", token })),
      ...bMid.map((token) => ({ type: "+", token })),
    ]
    : lcsOps(aMid, bMid);
  return [
    ...a.slice(0, head).map((token) => ({ type: " ", token })),
    ...middle,
    ...b.slice(b.length - tail).map((token) => ({ type: " ", token })),
  ];
}

function renderToken(op) {
  const stripped = op.token.replace(/(\r\n|\n|\r)$/, "");
  const line = `${op.type}${stripped}`;
  // Terminators are not rendered (git renders content only), but a line that
  // HAS no terminator gets the standard marker — otherwise a fix that appends
  // the missing final newline would render as a change with nothing visible in
  // it.  Only the last line of either side can lack one.
  return stripped === op.token ? `${line}\n\\ No newline at end of file` : line;
}

/**
 * A git-style unified diff for one file.  Hunk counts are always written out
 * (`,1` included) so the rendered string is deterministic and comparable.
 *
 * `created: true` renders the old side as `/dev/null` — the git convention for
 * "this file did not exist" — so a fix that is about to CREATE a file cannot
 * be mistaken, on sight, for one merely appending to it (see computeTargets()
 * on `AppendSectionFix`/`JsonMergeFix`: preview() must disclose creation).
 */
export function unifiedDiff(displayPath, beforeText, afterText, { context = DIFF_CONTEXT, created = false } = {}) {
  if (beforeText === afterText) return "";
  const ops = diffOps(beforeText, afterText);
  const oldNos = [];
  const newNos = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    oldNos.push(op.type === "+" ? null : oldLine);
    newNos.push(op.type === "-" ? null : newLine);
    if (op.type !== "+") oldLine += 1;
    if (op.type !== "-") newLine += 1;
  }
  const changed = ops.map((op) => op.type !== " ");
  const ranges = [];
  let cursor = 0;
  while (cursor < ops.length) {
    if (!changed[cursor]) {
      cursor += 1;
      continue;
    }
    const from = Math.max(0, cursor - context);
    let last = cursor;
    let scan = cursor;
    while (scan < ops.length) {
      if (changed[scan]) {
        last = scan;
        scan += 1;
        continue;
      }
      let gap = 0;
      let ahead = scan;
      while (ahead < ops.length && !changed[ahead]) {
        gap += 1;
        ahead += 1;
      }
      if (ahead < ops.length && gap <= context * 2) {
        scan = ahead;
        continue;
      }
      break;
    }
    const to = Math.min(ops.length - 1, last + context);
    ranges.push([from, to]);
    cursor = to + 1;
  }
  const lines = [`--- ${created ? "/dev/null" : displayPath}`, `+++ ${displayPath}`];
  for (const [from, to] of ranges) {
    const slice = ops.slice(from, to + 1);
    const oldLen = slice.filter((op) => op.type !== "+").length;
    const newLen = slice.filter((op) => op.type !== "-").length;
    const firstOld = oldNos.slice(from, to + 1).find((n) => n !== null);
    const firstNew = newNos.slice(from, to + 1).find((n) => n !== null);
    const oldStart = oldLen === 0 ? 0 : firstOld ?? 1;
    const newStart = newLen === 0 ? 0 : firstNew ?? 1;
    lines.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const op of slice) lines.push(renderToken(op));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Environment.  EVERY path this module touches is derived from an injected
// `home`, which is why the tests can run against a temp dir and never come near
// the developer's real ~/.claude.  `createFixEnvironment()` with no argument is
// the only place `os.homedir()` is read.
// ---------------------------------------------------------------------------

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function createFixEnvironment({ home = os.homedir(), stateDir, now } = {}) {
  const resolvedHome = path.resolve(home);
  const resolvedState = stateDir ? path.resolve(stateDir) : path.join(resolvedHome, STATE_DIR_NAME);
  const env = {
    home: resolvedHome,
    stateDir: resolvedState,
    undoRoot: path.join(resolvedState, UNDO_DIR_NAME),
    journalPath: path.join(resolvedState, JOURNAL_NAME),
    now: typeof now === "function" ? now : () => new Date(),

    /**
     * Resolve a fix target against the configured home and REFUSE anything that
     * escapes it.  This runs on a developer's machine with their permissions,
     * so `../../.ssh/config` is rejected rather than trusted (path traversal).
     */
    resolveTarget(relative) {
      if (typeof relative !== "string" || relative.length === 0) {
        throw new FixError(FIX_ERROR_CODES.SPEC_INVALID, "a fix target must be a non-empty path", {
          target: relative,
        });
      }
      if (relative.includes("\0")) {
        throw new FixError(FIX_ERROR_CODES.PATH_ESCAPE, "a fix target may not contain a NUL byte", {
          target: JSON.stringify(relative),
        });
      }
      const resolved = path.resolve(resolvedHome, relative);
      if (!isInside(resolvedHome, resolved) || resolved === resolvedHome) {
        throw new FixError(
          FIX_ERROR_CODES.PATH_ESCAPE,
          `fix target escapes the configured home: ${relative}`,
          { target: relative, resolved, home: resolvedHome },
        );
      }
      return resolved;
    },

    /** `~/.claude/CLAUDE.md` rather than the full path, for diffs and the UI. */
    display(absolute) {
      return isInside(resolvedHome, absolute)
        ? path.join("~", path.relative(resolvedHome, absolute))
        : absolute;
    },
  };
  return env;
}

// ---------------------------------------------------------------------------
// Bounded, fail-closed IO.
// ---------------------------------------------------------------------------

/**
 * Read a target with every unexpected condition turned into a refusal instead
 * of a guess.  A symlinked path whose real location leaves `home` is treated as
 * traversal — the check at construction sees only the literal path.
 */
async function readTarget(env, absolute, display) {
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, bytes: Buffer.alloc(0), text: "", mode: 0o644, display, path: absolute };
    }
    throw new FixError(FIX_ERROR_CODES.TARGET_UNREADABLE, `cannot stat ${display}: ${error.code}`, {
      path: absolute,
      cause: error.code,
    });
  }
  // A symlinked target is refused outright, and not because of traversal: the
  // atomic write is temp-file-plus-rename, and renaming ONTO a symlink replaces
  // the link with a regular file.  A developer who symlinks ~/.claude/CLAUDE.md
  // into a dotfiles repo would lose the link, which is the kind of "help" this
  // project exists not to do.  The diagnostic names the real file so they can
  // point the fix at it or apply the section by hand.
  if (info.isSymbolicLink()) {
    let real = null;
    try {
      real = await realpath(absolute);
    } catch {
      // A broken link is still a link; the refusal below does not need its target.
    }
    throw new FixError(
      FIX_ERROR_CODES.TARGET_IS_SYMLINK,
      `${display} is a symlink${real ? ` to ${real}` : ""}; SessionRx will not write through one, `
      + "because the atomic rename would replace the link itself"
      + `${real ? `. Point the fix at ${real}, or apply the section by hand.` : "."}`,
      { path: absolute, resolved: real, home: env.home },
    );
  }
  if (!info.isFile()) {
    throw new FixError(FIX_ERROR_CODES.TARGET_NOT_FILE, `${display} is not a regular file`, {
      path: absolute,
    });
  }
  if (info.size > MAX_TARGET_BYTES) {
    throw new FixError(
      FIX_ERROR_CODES.TARGET_TOO_LARGE,
      `${display} is ${info.size} bytes, above the ${MAX_TARGET_BYTES}-byte fix limit`,
      { path: absolute, size: info.size, limit: MAX_TARGET_BYTES },
    );
  }
  let bytes;
  try {
    bytes = await readFile(absolute);
  } catch (error) {
    throw new FixError(FIX_ERROR_CODES.TARGET_UNREADABLE, `cannot read ${display}: ${error.code}`, {
      path: absolute,
      cause: error.code,
    });
  }
  const text = bytes.toString("utf8");
  // A file that does not round-trip through UTF-8 would be corrupted the moment
  // we rendered a diff of it or re-serialized it, so it is refused instead.
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new FixError(
      FIX_ERROR_CODES.TARGET_UNREADABLE,
      `${display} is not valid UTF-8; SessionRx will not rewrite it`,
      { path: absolute, reason: "not-utf8" },
    );
  }
  return { exists: true, bytes, text, mode: info.mode & 0o7777, display, path: absolute };
}

/**
 * A fix target that does not exist is CREATED, but only inside a directory
 * that already exists.  An absent parent (e.g. no `~/.claude/` at all) means
 * the owning CLI is not installed, and fabricating that tree is not this
 * project's job — the refusal names the DIRECTORY, not the file, because the
 * directory is what is actually missing.
 */
async function assertParentDirExists(env, absolute, display) {
  const dir = path.dirname(absolute);
  const dirDisplay = env.display(dir);
  let info;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new FixError(
        FIX_ERROR_CODES.TARGET_MISSING,
        `${dirDisplay} does not exist; SessionRx will not create it, so it cannot create ${display} either`,
        { path: absolute, dir, home: env.home },
      );
    }
    throw new FixError(
      FIX_ERROR_CODES.TARGET_UNREADABLE,
      `cannot stat ${dirDisplay}: ${error.code}`,
      { path: absolute, dir, cause: error.code },
    );
  }
  if (!info.isDirectory()) {
    throw new FixError(
      FIX_ERROR_CODES.TARGET_MISSING,
      `${dirDisplay} is not a directory; SessionRx will not create ${display} under it`,
      { path: absolute, dir },
    );
  }
}

async function assertWritable(env, absolute, display) {
  const dir = path.dirname(absolute);
  try {
    await access(dir, FS_CONSTANTS.W_OK | FS_CONSTANTS.X_OK);
  } catch (error) {
    throw new FixError(
      FIX_ERROR_CODES.TARGET_UNWRITABLE,
      `the directory holding ${display} is not writable: ${error.code}`,
      { path: absolute, dir, cause: error.code },
    );
  }
  try {
    await access(absolute, FS_CONSTANTS.W_OK);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new FixError(FIX_ERROR_CODES.TARGET_UNWRITABLE, `${display} is not writable: ${error.code}`, {
      path: absolute,
      cause: error.code,
    });
  }
}

/** Temp file, fsync, rename, retained mode (BP-004.07). */
async function writeFileAtomic(absolute, bytes, mode) {
  const dir = path.dirname(absolute);
  const tmp = path.join(dir, `.session-rx.tmp.${process.pid}.${randomUUID()}`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (typeof mode === "number") await chmod(tmp, mode);
  await rename(tmp, absolute);
  try {
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is a durability nicety; not every platform allows it and
    // the rename itself has already happened.
  }
}

/**
 * The only write path in this module.  A destination that is neither inside the
 * state dir nor one of the transaction's declared targets is a bug, and it is
 * refused at the last possible moment rather than trusted.
 */
async function guardedWrite(env, absolute, bytes, allowedTargets, mode) {
  const permitted = isInside(env.stateDir, absolute) || allowedTargets.includes(absolute);
  if (!permitted) {
    throw new FixError(
      FIX_ERROR_CODES.WRITE_OUT_OF_BOUNDS,
      `refusing to write outside ${env.stateDir} and the declared targets: ${absolute}`,
      { path: absolute, stateDir: env.stateDir, allowed: allowedTargets },
    );
  }
  await writeFileAtomic(absolute, bytes, mode);
}

/**
 * The delete-side counterpart to `guardedWrite`, used only by undo() for a
 * target SessionRx itself created (BP-004.11): restoring "absent" means
 * removing the file, not overwriting it, but the same out-of-bounds guard
 * applies — this never runs against a path outside the state dir or the
 * declared targets.
 */
async function guardedUnlink(env, absolute, allowedTargets) {
  const permitted = isInside(env.stateDir, absolute) || allowedTargets.includes(absolute);
  if (!permitted) {
    throw new FixError(
      FIX_ERROR_CODES.WRITE_OUT_OF_BOUNDS,
      `refusing to delete outside ${env.stateDir} and the declared targets: ${absolute}`,
      { path: absolute, stateDir: env.stateDir, allowed: allowedTargets },
    );
  }
  await unlink(absolute);
}

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** One directory per transaction; a same-millisecond collision gets a suffix. */
async function createUndoDir(env) {
  const base = stamp(env.now());
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = path.join(env.undoRoot, attempt === 0 ? base : `${base}-${attempt + 1}`);
    try {
      await mkdir(candidate, { recursive: false, mode: 0o700 });
      await mkdir(path.join(candidate, "files"), { recursive: false, mode: 0o700 });
      return candidate;
    } catch (error) {
      if (error.code !== "EEXIST") {
        if (error.code === "ENOENT") {
          await mkdir(env.undoRoot, { recursive: true, mode: 0o700 });
          attempt -= 1;
          continue;
        }
        throw error;
      }
    }
  }
  throw new FixError(
    FIX_ERROR_CODES.WRITE_OUT_OF_BOUNDS,
    `could not create an undo directory under ${env.undoRoot}`,
    { undoRoot: env.undoRoot },
  );
}

/**
 * The backup path mirrors the target's location under the home root, so a
 * record is restorable unambiguously even by hand: the transaction names the
 * absolute target, and `files/<relative-path>` holds its exact prior bytes.
 */
function backupPathFor(undoDir, env, absolute) {
  const relative = isInside(env.home, absolute)
    ? path.relative(env.home, absolute)
    : path.join("_absolute", absolute.replace(/^[/\\]+/, ""));
  return path.join(undoDir, "files", relative);
}

async function writeTransaction(env, undoDir, record) {
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  await guardedWrite(env, path.join(undoDir, TRANSACTION_NAME), bytes, [], 0o600);
}

async function appendJournal(env, entry) {
  await mkdir(env.stateDir, { recursive: true, mode: 0o700 });
  if (!isInside(env.stateDir, env.journalPath)) {
    throw new FixError(FIX_ERROR_CODES.WRITE_OUT_OF_BOUNDS, "the journal must live in the state dir", {
      journalPath: env.journalPath,
      stateDir: env.stateDir,
    });
  }
  await appendFile(env.journalPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** FVA-007: the append-only record of every apply and every undo. */
export async function readJournal(env) {
  let text;
  try {
    text = await readFile(env.journalPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Transactions newest-first, optionally for one fix id. */
export async function listTransactions(env, { fixId } = {}) {
  let names;
  try {
    names = await readdir(env.undoRoot);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const name of names.sort().reverse()) {
    const undoPath = path.join(env.undoRoot, name);
    let record;
    try {
      record = JSON.parse(await readFile(path.join(undoPath, TRANSACTION_NAME), "utf8"));
    } catch {
      continue;
    }
    if (fixId && record.fixId !== fixId) continue;
    records.push({ ...record, undoPath });
  }
  return records;
}

// ---------------------------------------------------------------------------
// undo.  BP-004.10 + FVA-007: restore byte-identical bytes, and REFUSE a
// missing, corrupt, or externally-edited record.  Verification of every target
// completes before any target is written, so a refusal leaves nothing half
// restored.
// ---------------------------------------------------------------------------

export async function undoTransaction(undoPath, { env = createFixEnvironment(), expectFixId } = {}) {
  const resolved = path.resolve(undoPath ?? "");
  if (!isInside(env.undoRoot, resolved) || resolved === env.undoRoot) {
    throw new FixError(
      FIX_ERROR_CODES.PATH_ESCAPE,
      `an undo path must live under ${env.undoRoot}: ${undoPath}`,
      { undoPath, resolved, undoRoot: env.undoRoot },
    );
  }
  const recordPath = path.join(resolved, TRANSACTION_NAME);
  let raw;
  try {
    raw = await readFile(recordPath, "utf8");
  } catch (error) {
    throw new FixError(
      FIX_ERROR_CODES.UNDO_RECORD_MISSING,
      `no fix transaction at ${recordPath} (${error.code})`,
      { undoPath: resolved, cause: error.code },
    );
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    throw new FixError(
      FIX_ERROR_CODES.UNDO_RECORD_CORRUPT,
      `the fix transaction at ${recordPath} is not valid JSON`,
      { undoPath: resolved, cause: error.message },
    );
  }
  if (!Array.isArray(record.targets) || record.targets.length === 0) {
    throw new FixError(
      FIX_ERROR_CODES.UNDO_RECORD_CORRUPT,
      `the fix transaction at ${recordPath} records no targets`,
      { undoPath: resolved },
    );
  }
  if (expectFixId && record.fixId !== expectFixId) {
    throw new FixError(
      FIX_ERROR_CODES.UNDO_RECORD_CORRUPT,
      `${recordPath} belongs to fix ${record.fixId}, not ${expectFixId}`,
      { undoPath: resolved, fixId: record.fixId, expected: expectFixId },
    );
  }
  if (record.status === "undone") {
    throw new FixError(
      FIX_ERROR_CODES.ALREADY_UNDONE,
      `the fix transaction at ${recordPath} was already undone at ${record.undoneAt}`,
      { undoPath: resolved, undoneAt: record.undoneAt },
    );
  }

  // PHASE 1 — verify every target and every backup.  Nothing is written here.
  const plans = [];
  for (const target of record.targets) {
    const display = target.display ?? env.display(target.path);
    const current = await readTarget(env, target.path, display);
    const currentHash = current.exists ? sha256Hex(current.bytes) : null;
    if (currentHash !== target.hashAfter) {
      throw new FixError(
        FIX_ERROR_CODES.EXTERNAL_EDIT,
        `${display} changed after the fix was applied `
        + `(journal recorded ${target.hashAfter}, on disk ${currentHash ?? "the file is gone"}). `
        + "Refusing to undo, because restoring the backup would destroy that later edit. "
        + `The prior content is kept at ${target.backup} if you want to merge it by hand.`,
        {
          path: target.path,
          display,
          expectedHash: target.hashAfter,
          actualHash: currentHash,
          backup: target.backup,
          reason: current.exists ? "content-changed" : "target-missing",
        },
      );
    }
    let backupBytes;
    try {
      backupBytes = await readFile(target.backup);
    } catch (error) {
      throw new FixError(
        FIX_ERROR_CODES.UNDO_RECORD_CORRUPT,
        `the backup for ${display} is missing at ${target.backup} (${error.code})`,
        { path: target.path, backup: target.backup, cause: error.code },
      );
    }
    const backupHash = sha256Hex(backupBytes);
    if (backupHash !== target.hashBefore) {
      throw new FixError(
        FIX_ERROR_CODES.UNDO_RECORD_CORRUPT,
        `the backup for ${display} hashes ${backupHash}, not the recorded ${target.hashBefore}`,
        { path: target.path, backup: target.backup, expectedHash: target.hashBefore, actualHash: backupHash },
      );
    }
    plans.push({ target, display, bytes: backupBytes });
  }

  // PHASE 2 — restore, then prove each restoration byte-identical.  A target
  // SessionRx CREATED (BP-004.11) has no prior bytes to restore — "restoring
  // absent" means removing the file, never leaving an empty stub behind — so
  // that one target is deleted instead of overwritten, and proven gone rather
  // than proven byte-identical.
  const restored = [];
  for (const plan of plans) {
    if (plan.target.created) {
      await guardedUnlink(env, plan.target.path, [plan.target.path]);
      let stillPresent = true;
      try {
        await lstat(plan.target.path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        stillPresent = false;
      }
      if (stillPresent) {
        throw new FixError(
          FIX_ERROR_CODES.RESTORE_NOT_BYTE_IDENTICAL,
          `${plan.display} still exists after undo tried to remove the file SessionRx created`,
          { path: plan.target.path },
        );
      }
    } else {
      await guardedWrite(env, plan.target.path, plan.bytes, [plan.target.path], plan.target.mode);
      const after = await readFile(plan.target.path);
      const afterHash = sha256Hex(after);
      if (afterHash !== plan.target.hashBefore) {
        throw new FixError(
          FIX_ERROR_CODES.RESTORE_NOT_BYTE_IDENTICAL,
          `${plan.display} restored to ${afterHash}, not the recorded ${plan.target.hashBefore}`,
          { path: plan.target.path, expectedHash: plan.target.hashBefore, actualHash: afterHash },
        );
      }
    }
    restored.push(plan.target.path);
  }

  const undoneAt = env.now().toISOString();
  await writeTransaction(env, resolved, { ...record, status: "undone", undoneAt });
  await appendJournal(env, {
    ts: undoneAt,
    event: "undo",
    version: FIX_ENGINE_VERSION,
    fixId: record.fixId,
    undoPath: resolved,
    targets: record.targets.map((t) => ({
      path: t.path,
      hashBefore: t.hashBefore,
      hashAfter: t.hashAfter,
      restoredHash: t.hashBefore,
    })),
  });

  return {
    restored: true,
    byteIdentical: true,
    fixId: record.fixId,
    undoPath: resolved,
    files_affected: restored,
  };
}

// ---------------------------------------------------------------------------
// The fix contract.
// ---------------------------------------------------------------------------

/**
 * What every fix has, writable or not.  There is deliberately no `apply` here:
 * a display-only recommendation extends this class and nothing else, so it has
 * no write path to disable.
 */
export class FixBase {
  constructor({ id, title, kind, rationale = "", ruleId = null, description, env } = {}) {
    if (typeof id !== "string" || id.length === 0) {
      throw new FixError(FIX_ERROR_CODES.SPEC_INVALID, "a fix needs a non-empty id", { id });
    }
    if (!FIX_KINDS.includes(kind)) {
      throw new FixError(FIX_ERROR_CODES.SPEC_INVALID, `unknown fix kind: ${kind}`, { id, kind, FIX_KINDS });
    }
    this.id = id;
    this.kind = kind;
    this.title = typeof title === "string" && title.length > 0 ? title : id;
    this.rationale = rationale;
    this.ruleId = ruleId;
    this.descriptionText = typeof description === "string" && description.length > 0
      ? description
      : this.title;
    this.env = env ?? createFixEnvironment();
  }

  /** The UI enables an apply button on this and nothing else. */
  get applyable() {
    return false;
  }

  filesAffected() {
    return [];
  }

  /** The catalogue entry: enough to render a card without reading any file. */
  describe() {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      description: this.descriptionText,
      rationale: this.rationale,
      ruleId: this.ruleId,
      applyable: this.applyable,
      files_affected: this.filesAffected(),
    };
  }
}
// Frozen so no later module can bolt an `apply` onto the shared prototype and
// give a display-only recommendation a write path it was built without.
Object.freeze(FixBase.prototype);

/**
 * A fix that writes.  `preview()`, `apply()` and `undo()` all run through the
 * same `computeTargets()`, which is what makes preview honest: there is no
 * second code path that could produce different bytes than the diff described.
 */
export class WritableFix extends FixBase {
  constructor(spec) {
    super(spec);
    // Traversal is refused HERE, at construction, so a bad spec cannot reach a
    // write path at all — not merely be caught on the way to one.
    this.target = this.env.resolveTarget(spec.target);
    this.display = this.env.display(this.target);
    this.diffContext = Number.isInteger(spec.diffContext) ? spec.diffContext : DIFF_CONTEXT;
    // Default TRUE: every write-fix diff embeds the user's own config content —
    // context lines above an append, neighbouring keys around a merge — so the
    // BP-005.15 redaction gate must see this payload before a browser does.
    this.sensitive = spec.sensitive !== false;
  }

  get applyable() {
    return true;
  }

  filesAffected() {
    return [this.target];
  }

  /**
   * Returns the target descriptors for this fix: the exact before and after
   * bytes, hashed.  Implemented per kind; a guard rather than dead code,
   * because `preview()`/`apply()` call it on `this`.
   */
  async computeTargets() {
    throw new FixError(
      FIX_ERROR_CODES.SPEC_INVALID,
      `${this.id}: computeTargets() must be implemented by a fix kind`,
      { id: this.id, kind: this.kind },
    );
  }

  renderDiffFor(targets) {
    return targets
      .map((target) => unifiedDiff(target.display, target.beforeText, target.afterText, {
        context: this.diffContext,
        created: Boolean(target.created),
      }))
      .filter(Boolean)
      .join("");
  }

  /** BP-004: `{description, diff, files_affected, reversible}` plus the proof. */
  async preview() {
    const targets = await this.computeTargets();
    // BP-004.11 — preview MUST disclose creation, not merely allow it: a
    // target that does not exist yet reads, unmistakably, as about to be
    // created, in both the description and the diff (created: true above
    // renders `--- /dev/null` rather than an ordinary append/merge header).
    const createdTargets = targets.filter((t) => t.created);
    const description = createdTargets.length > 0
      ? `${this.descriptionText} ${createdTargets.map((t) => t.display).join(", ")} `
        + "does not exist yet; SessionRx will create it."
      : this.descriptionText;
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      description,
      diff: this.renderDiffFor(targets),
      files_affected: targets.map((t) => t.path),
      reversible: true,
      applyable: true,
      // `sensitive` tells the API layer this payload must pass the BP-005.15
      // redaction gate before it reaches the browser: a settings.json diff can
      // carry a neighbouring key's value as context.
      sensitive: this.sensitive,
      marker: this.marker ?? null,
      targets: targets.map((t) => ({
        path: t.path,
        display: t.display,
        beforeHash: t.beforeHash,
        // The machine-checkable half of BP-004.06: apply() writes exactly the
        // bytes that hash to this.
        afterHash: t.afterHash,
        bytesBefore: t.bytesBefore,
        bytesAfter: t.bytesAfter,
        eol: t.eol === "\r\n" ? "crlf" : "lf",
        created: Boolean(t.created),
        note: t.note,
      })),
      conflicts: targets.flatMap((t) => t.conflicts ?? []),
      check: await this.check(),
    };
  }

  async apply() {
    const targets = await this.computeTargets();
    const paths = targets.map((t) => t.path);
    // Writability is proven BEFORE any directory or backup is created, so a
    // read-only target leaves no trace behind and certainly no partial write.
    for (const target of targets) {
      await assertWritable(this.env, target.path, target.display);
    }
    const diff = this.renderDiffFor(targets);
    const undoPath = await createUndoDir(this.env);

    // BP-004.07 — BACK UP EVERY TARGET FIRST, from the same buffer the diff was
    // computed from, and prove the backup byte-identical before going further.
    const records = [];
    for (const target of targets) {
      const backup = backupPathFor(undoPath, this.env, target.path);
      await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
      await guardedWrite(this.env, backup, target.beforeBytes, [], 0o600);
      const written = await readFile(backup);
      const writtenHash = sha256Hex(written);
      if (writtenHash !== target.beforeHash) {
        throw new FixError(
          FIX_ERROR_CODES.WRITE_NOT_VERIFIED,
          `the backup of ${target.display} hashes ${writtenHash}, not ${target.beforeHash}; `
          + "nothing has been modified",
          { path: target.path, backup, expectedHash: target.beforeHash, actualHash: writtenHash },
        );
      }
      records.push({
        path: target.path,
        display: target.display,
        backup,
        mode: target.mode,
        // BP-004.11 — carried into the persisted transaction so undo() can
        // tell "restore the backup" apart from "this target did not exist;
        // restoring absent means deleting the file, not writing one".
        created: Boolean(target.created),
        hashBefore: target.beforeHash,
        hashAfter: target.afterHash, // promised now, re-proven from disk below
        bytesBefore: target.bytesBefore,
        bytesAfter: target.bytesAfter,
      });
    }

    const createdAt = this.env.now().toISOString();
    let record = {
      version: FIX_ENGINE_VERSION,
      fixId: this.id,
      kind: this.kind,
      marker: this.marker ?? null,
      createdAt,
      status: "pending",
      undoPath,
      diff,
      targets: records,
    };
    // The journal is written before the target is touched, so an interrupted
    // apply still leaves a record pointing at a verified backup.
    await writeTransaction(this.env, undoPath, record);

    // The file must still be exactly what the diff was computed from; anything
    // else means it changed between preview and apply.  A target this fix is
    // about to CREATE has no prior bytes to compare — its "unchanged since
    // preview" is "still absent", so the guard is that nothing appeared where
    // preview found nothing, not a hash match against an empty buffer.
    for (const target of targets) {
      const current = await readTarget(this.env, target.path, target.display);
      if (target.created) {
        if (current.exists) {
          throw new FixError(
            FIX_ERROR_CODES.EXTERNAL_EDIT,
            `${target.display} was created by something else while this fix was being prepared; nothing written`,
            { path: target.path, expectedHash: null, actualHash: sha256Hex(current.bytes) },
          );
        }
        continue;
      }
      const currentHash = current.exists ? sha256Hex(current.bytes) : null;
      if (currentHash !== target.beforeHash) {
        throw new FixError(
          FIX_ERROR_CODES.EXTERNAL_EDIT,
          `${target.display} changed while the fix was being prepared `
          + `(expected ${target.beforeHash}, found ${currentHash ?? "the file is gone"}); nothing written`,
          { path: target.path, expectedHash: target.beforeHash, actualHash: currentHash },
        );
      }
    }

    for (const target of targets) {
      await guardedWrite(this.env, target.path, target.afterBytes, paths, target.mode);
    }

    const verified = [];
    for (const target of targets) {
      const written = await readFile(target.path);
      const writtenHash = sha256Hex(written);
      if (writtenHash !== target.afterHash) {
        throw new FixError(
          FIX_ERROR_CODES.WRITE_NOT_VERIFIED,
          `${target.display} hashes ${writtenHash} after the write, not the previewed ${target.afterHash}; `
          + `restore it with undo(${undoPath})`,
          { path: target.path, expectedHash: target.afterHash, actualHash: writtenHash, undoPath },
        );
      }
      verified.push({ path: target.path, hashBefore: target.beforeHash, hashAfter: writtenHash });
    }

    const appliedAt = this.env.now().toISOString();
    record = {
      ...record,
      status: "applied",
      appliedAt,
      targets: records.map((entry, index) => ({ ...entry, hashAfter: verified[index].hashAfter })),
    };
    await writeTransaction(this.env, undoPath, record);
    await appendJournal(this.env, {
      ts: appliedAt,
      event: "apply",
      version: FIX_ENGINE_VERSION,
      fixId: this.id,
      kind: this.kind,
      marker: this.marker ?? null,
      undoPath,
      targets: verified,
    });

    return {
      applied: true,
      id: this.id,
      description: this.descriptionText,
      diff,
      files_affected: paths,
      undoPath,
      marker: this.marker ?? null,
      reversible: true,
      targets: record.targets.map(({ path: p, display, hashBefore, hashAfter }) => ({
        path: p,
        display,
        hashBefore,
        hashAfter,
      })),
    };
  }

  /** The newest applied transaction for this fix, or null. */
  async latestUndoPath() {
    const applied = (await listTransactions(this.env, { fixId: this.id }))
      .filter((record) => record.status === "applied");
    return applied.length > 0 ? applied[0].undoPath : null;
  }

  async undo(undoPath) {
    const resolved = undoPath ?? await this.latestUndoPath();
    if (!resolved) {
      throw new FixError(
        FIX_ERROR_CODES.UNDO_RECORD_MISSING,
        `no applied transaction recorded for ${this.id} under ${this.env.undoRoot}`,
        { id: this.id, undoRoot: this.env.undoRoot },
      );
    }
    return undoTransaction(resolved, { env: this.env, expectFixId: this.id });
  }
}

/**
 * BP-004.02..05 — append one delimited section to a markdown file.  The prior
 * bytes are carried over by `Buffer.concat`, never re-serialized, so a
 * hand-formatted CLAUDE.md keeps every space, tab and CRLF it had (BP-004.08).
 */
export class AppendSectionFix extends WritableFix {
  constructor(spec) {
    super({ ...spec, kind: "append-section" });
    this.marker = spec.marker;
    this.heading = spec.heading;
    this.body = spec.body;
    this.section = buildDelimitedSection(spec);
    // The section without its surrounding blank line: what `check()` compares
    // against, so a stripped final newline is not mistaken for tampering while
    // any change to the body still is.
    this.block = this.section.slice(1, -1);
    this.openMarker = openMarkerOf(this.marker);
    this.closeMarker = closeMarkerOf(this.marker);
    if (!spec.description) {
      this.descriptionText = `Append the delimited "${this.heading}" section to ${this.display}. `
        + "Existing content is not modified, reordered or reformatted.";
    }
  }

  /** BP-004: `{applied, marker}`, plus the FVA-006 status and a visible reason. */
  async check() {
    let file;
    try {
      file = await readTarget(this.env, this.target, this.display);
    } catch (error) {
      if (!(error instanceof FixError)) throw error;
      return {
        applied: false,
        drifted: false,
        status: "unknown",
        reason: error.code,
        message: error.message,
        marker: this.openMarker,
        path: this.target,
      };
    }
    const base = { marker: this.openMarker, path: this.target, display: this.display };
    if (!file.exists) {
      return {
        ...base,
        applied: false,
        drifted: false,
        status: "unknown",
        reason: FIX_ERROR_CODES.TARGET_MISSING,
        message: `${this.display} does not exist`,
      };
    }
    const occurrences = (file.text.match(new RegExp(escapeRegExp(this.openMarker), "g")) ?? []).length;
    if (occurrences === 0) {
      return { ...base, applied: false, drifted: false, status: "not-applied", reason: "marker-absent" };
    }
    if (occurrences > 1) {
      return {
        ...base,
        applied: true,
        drifted: true,
        status: "applied",
        reason: "marker-duplicated",
        occurrences,
        message: `${this.display} contains ${occurrences} copies of ${this.openMarker}`,
      };
    }
    const start = file.text.indexOf(this.openMarker);
    const closeAt = file.text.indexOf(this.closeMarker, start);
    if (closeAt < 0) {
      return {
        ...base,
        applied: true,
        drifted: true,
        status: "applied",
        reason: "close-marker-missing",
        message: `${this.display} opens ${this.openMarker} but never closes it`,
      };
    }
    const found = file.text.slice(start, closeAt + this.closeMarker.length).replace(/\r\n/g, "\n");
    if (found !== this.block) {
      return {
        ...base,
        applied: true,
        drifted: true,
        status: "applied",
        reason: "section-modified",
        message: `the ${this.openMarker} section in ${this.display} was edited after it was applied`,
      };
    }
    return { ...base, applied: true, drifted: false, status: "applied", reason: "marker-present" };
  }

  async computeTargets() {
    const file = await readTarget(this.env, this.target, this.display);
    if (!file.exists) {
      // BP-004.11 — absent is not automatically a refusal: SessionRx creates
      // the file when its parent directory exists (the owning CLI IS
      // installed; it simply has no CLAUDE.md yet), and keeps refusing only
      // when even the directory is missing (the CLI is not installed at all).
      await assertParentDirExists(this.env, this.target, this.display);
    } else {
      const state = await this.check();
      if (state.drifted) {
        throw new FixError(
          FIX_ERROR_CODES.MARKER_DRIFT,
          `${this.display} already carries ${this.openMarker} but it was changed `
          + `(${state.reason}); refusing to touch the file`,
          { path: this.target, marker: this.openMarker, reason: state.reason },
        );
      }
      if (state.applied) {
        throw new FixError(
          FIX_ERROR_CODES.ALREADY_APPLIED,
          `${this.display} already carries ${this.openMarker}; applying again would duplicate it`,
          { path: this.target, marker: this.openMarker },
        );
      }
    }
    const eol = detectEol(file.text);
    const section = eol === "\n" ? this.section : this.section.replace(/\n/g, eol);
    // A file that does not end in a newline gets one, so the marker starts on
    // its own line; the user's last line is still byte-for-byte intact. A
    // file that does not exist yet (file.text === "") takes this same "no
    // lead" branch, so the created file holds EXACTLY `this.section` — no
    // invented header, title, or other content.
    const lead = file.text.length === 0 || endsWithNewline(file.text) ? "" : eol;
    const appended = Buffer.from(lead + section, "utf8");
    const afterBytes = Buffer.concat([file.bytes, appended]);
    return [{
      path: this.target,
      display: this.display,
      mode: file.mode,
      eol,
      created: !file.exists,
      beforeBytes: file.bytes,
      beforeText: file.text,
      beforeHash: sha256Hex(file.bytes),
      afterBytes,
      afterText: afterBytes.toString("utf8"),
      afterHash: sha256Hex(afterBytes),
      bytesBefore: file.bytes.length,
      bytesAfter: afterBytes.length,
      note: file.exists
        ? `appended ${appended.length} bytes (${eol === "\r\n" ? "crlf" : "lf"})`
        : `created a ${afterBytes.length}-byte file (${eol === "\r\n" ? "crlf" : "lf"})`,
    }];
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length
      && aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * BP-004.01/.09 — shallow-merge NAMED keys into a JSON settings file.  Every
 * pre-existing key survives with its value and its position: a key this version
 * has never heard of is a key a future CLI version needs, so it is copied, not
 * dropped.  A settings file that does not parse is refused outright rather than
 * rewritten from a partial understanding.
 */
export class JsonMergeFix extends WritableFix {
  constructor(spec) {
    // A settings diff can carry a neighbouring key's value as context, so the
    // payload is flagged sensitive and the diff is rendered with no context
    // lines at all unless the caller asks for more.
    super({ diffContext: 0, ...spec, kind: "json-merge" });
    if (!isPlainObject(spec.merge) || Object.keys(spec.merge).length === 0) {
      throw new FixError(
        FIX_ERROR_CODES.SPEC_INVALID,
        `${spec.id}: a json-merge fix needs a non-empty \`merge\` object`,
        { id: spec.id },
      );
    }
    this.merge = { ...spec.merge };
    this.keys = Object.keys(this.merge);
    this.indent = Number.isInteger(spec.indent) ? spec.indent : 2;
    this.marker = spec.marker
      ?? this.keys.map((key) => `${key} === ${JSON.stringify(this.merge[key])}`).join(" && ");
    if (!spec.description) {
      this.descriptionText = `Merge ${this.keys.map((k) => JSON.stringify(k)).join(", ")} into `
        + `${this.display}. Every other key keeps its value and its position.`;
    }
  }

  async check() {
    let file;
    try {
      file = await readTarget(this.env, this.target, this.display);
    } catch (error) {
      if (!(error instanceof FixError)) throw error;
      return {
        applied: false,
        drifted: false,
        status: "unknown",
        reason: error.code,
        message: error.message,
        marker: this.marker,
        path: this.target,
      };
    }
    const base = { marker: this.marker, path: this.target, display: this.display, keys: this.keys };
    if (!file.exists) {
      return {
        ...base,
        applied: false,
        drifted: false,
        status: "unknown",
        reason: FIX_ERROR_CODES.TARGET_MISSING,
        message: `${this.display} does not exist`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(file.text);
    } catch (error) {
      return {
        ...base,
        applied: false,
        drifted: false,
        status: "unknown",
        reason: FIX_ERROR_CODES.TARGET_UNPARSEABLE,
        message: `${this.display} is not valid JSON: ${error.message}`,
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        ...base,
        applied: false,
        drifted: false,
        status: "unknown",
        reason: FIX_ERROR_CODES.TARGET_UNPARSEABLE,
        message: `${this.display} is valid JSON but not an object`,
      };
    }
    const applied = this.keys.every((key) => Object.hasOwn(parsed, key)
      && deepEqual(parsed[key], this.merge[key]));
    return {
      ...base,
      applied,
      drifted: false,
      status: applied ? "applied" : "not-applied",
      reason: applied ? "keys-present" : "keys-absent-or-different",
    };
  }

  async computeTargets() {
    const file = await readTarget(this.env, this.target, this.display);
    let parsed;
    if (!file.exists) {
      // BP-004.11 — same rule as AppendSectionFix: absent is created when its
      // directory exists, refused only when the directory itself is missing.
      // There is nothing to merge INTO, so the starting object is empty.
      await assertParentDirExists(this.env, this.target, this.display);
      parsed = {};
    } else {
      try {
        parsed = JSON.parse(file.text);
      } catch (error) {
        throw new FixError(
          FIX_ERROR_CODES.TARGET_UNPARSEABLE,
          `${this.display} is not valid JSON, so SessionRx will not rewrite it: ${error.message}`,
          { path: this.target, cause: error.message },
        );
      }
      if (!isPlainObject(parsed)) {
        throw new FixError(
          FIX_ERROR_CODES.TARGET_UNPARSEABLE,
          `${this.display} is valid JSON but not an object; refusing to merge into it`,
          { path: this.target },
        );
      }
      const state = await this.check();
      if (state.applied) {
        throw new FixError(
          FIX_ERROR_CODES.ALREADY_APPLIED,
          `${this.display} already has ${this.marker}`,
          { path: this.target, marker: this.marker },
        );
      }
    }
    // Spread first: insertion order is preserved, so existing keys stay exactly
    // where they were and only genuinely new keys land at the end.
    const next = { ...parsed };
    const conflicts = [];
    for (const key of this.keys) {
      if (Object.hasOwn(parsed, key) && !deepEqual(parsed[key], this.merge[key])) {
        conflicts.push({ key, from: parsed[key], to: this.merge[key] });
      }
      next[key] = this.merge[key];
    }
    const eol = file.exists ? detectEol(file.text) : "\n";
    let json = JSON.stringify(next, null, this.indent);
    if (eol !== "\n") json = json.replace(/\n/g, eol);
    // A created file gets the trailing newline a hand-written or tool-written
    // settings.json conventionally ends with; an EXISTING file keeps whatever
    // it already had, trailing newline or not (BP-004.09 — never reformatted).
    const afterText = !file.exists || endsWithNewline(file.text) ? json + eol : json;
    const afterBytes = Buffer.from(afterText, "utf8");
    return [{
      path: this.target,
      display: this.display,
      mode: file.mode,
      eol,
      created: !file.exists,
      beforeBytes: file.bytes,
      beforeText: file.text,
      beforeHash: sha256Hex(file.bytes),
      afterBytes,
      afterText,
      afterHash: sha256Hex(afterBytes),
      bytesBefore: file.bytes.length,
      bytesAfter: afterBytes.length,
      conflicts,
      note: !file.exists
        ? `created the file with ${this.keys.length} key(s)`
        : conflicts.length > 0
          ? `replaces ${conflicts.length} existing value(s); undo restores them`
          : `adds ${this.keys.length} key(s)`,
    }];
  }
}

/**
 * BP-004 — a habit recommendation.  DISPLAY ONLY: this class extends `FixBase`,
 * not `WritableFix`, so `apply` and `undo` do not exist anywhere on its
 * prototype chain.  The instance and both prototypes are frozen, so one cannot
 * be added later either.  There is no write path to get wrong.
 */
export class HabitRecommendation extends FixBase {
  constructor(spec) {
    super({ ...spec, kind: "recommendation" });
    this.steps = Object.freeze([...(Array.isArray(spec.steps) ? spec.steps : [])]);
    Object.freeze(this);
  }

  get applyable() {
    return false;
  }

  async check() {
    return {
      applied: false,
      drifted: false,
      status: "unknown",
      reason: "display-only",
      message: `${this.id} is a habit recommendation; there is nothing on disk to check`,
      marker: null,
      path: null,
    };
  }

  async preview() {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      description: this.descriptionText,
      rationale: this.rationale,
      steps: this.steps,
      diff: "",
      files_affected: [],
      reversible: false,
      applyable: false,
      sensitive: false,
      marker: null,
      targets: [],
      conflicts: [],
      check: await this.check(),
    };
  }
}
Object.freeze(HabitRecommendation.prototype);
