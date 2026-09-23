/**
 * Wave 4B — `claude-output-hygiene` (BP-004.02): the CLAUDE.md instruction fix.
 *
 * REAL-FILE SAFETY. Every fix in this suite is constructed with an env from the
 * 4B harness's `makeEnv()`, which REFUSES any home that is not inside this
 * process's `mkdtemp` root; the wave-4A engine derives every path it touches
 * from `env.home`, so a fix built here cannot name `~/.claude/CLAUDE.md`. The
 * suite never calls `createFixEnvironment()` without a home. Belt and braces:
 * the real `~/.claude/CLAUDE.md` and `~/.claude/settings.json` are hashed when
 * the harness loads and re-hashed in the last test, together with the presence
 * of `~/.session-rx`.
 */

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FIX_ERROR_CODES,
  FixError,
  listTransactions,
  unifiedDiff,
} from "../src/fixes/base.js";
import {
  OUTPUT_HYGIENE_HEADING,
  OUTPUT_HYGIENE_ID,
  OUTPUT_HYGIENE_MARKER,
  OUTPUT_HYGIENE_RULE_ID,
  OUTPUT_HYGIENE_TARGET,
  createOutputHygieneFix,
} from "../src/fixes/claude/output-hygiene.js";
import {
  TMP_ROOT,
  assertRealFilesUnchanged,
  exists,
  hash,
  makeEnv,
  scaffold,
  scaffoldEmpty,
  stateDirExists,
} from "./fixtures/fixes/4b/harness.mjs";

function assertSymlinkTargetMentioned(message, link, real) {
  const normalizePath = (value) => {
    let candidate = value;
    try {
      candidate = realpathSync(candidate);
    } catch {
      // The value may be embedded in a diagnostic or may not exist yet.
    }
    const normalized = candidate.replaceAll("\\", "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };

  const resolvedLink = normalizePath(link);
  const expectedTarget = normalizePath(real);
  const mentionedTarget = message.match(/\bto ([^;\n]+);/)?.[1];
  const normalizedMessage = mentionedTarget === undefined
    ? message.replaceAll("\\", "/")
    : message.replace(mentionedTarget, normalizePath(mentionedTarget));

  assert.equal(resolvedLink, expectedTarget);
  const comparableMessage = process.platform === "win32" ? normalizedMessage.toLowerCase() : normalizedMessage;
  assert.ok(comparableMessage.includes(expectedTarget),
    `the diagnostic did not name the resolved symlink target: ${message}`);
}

/**
 * THE WORDING LOCK. This is the text a developer's CLAUDE.md receives, written
 * out here as a literal rather than imported from the module, so that changing
 * the guidance is a deliberate act that fails a test rather than a silent edit.
 */
const EXPECTED_SECTION = [
  "",
  "<!-- session-rx:output-hygiene:v1 -->",
  "## SessionRx: output hygiene",
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
  "<!-- /session-rx:output-hygiene:v1 -->",
  "",
].join("\n");

const OPEN = "<!-- session-rx:output-hygiene:v1 -->";
const CLOSE = "<!-- /session-rx:output-hygiene:v1 -->";

function countOf(haystack, needle) {
  let seen = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    seen += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return seen;
}

async function expectFixError(promise, code) {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error, `expected a FixError with code ${code}, got a resolved promise`);
  assert.ok(error instanceof FixError, `expected a FixError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  return error;
}

// ---------------------------------------------------------------------------
// The contract the catalogue renders.
// ---------------------------------------------------------------------------

test("the fix declares BP-004.02's id, marker, heading, rule and reversibility", async () => {
  const { env, target } = await scaffold("meta", { claudeMd: "lf.md" });
  const fix = createOutputHygieneFix({ env });

  assert.equal(fix.id, OUTPUT_HYGIENE_ID);
  assert.equal(fix.id, "claude-output-hygiene");
  assert.equal(fix.kind, "append-section");
  assert.equal(OUTPUT_HYGIENE_TARGET, ".claude/CLAUDE.md");
  assert.equal(OUTPUT_HYGIENE_MARKER, "session-rx:output-hygiene:v1");
  assert.equal(OUTPUT_HYGIENE_HEADING, "SessionRx: output hygiene");
  assert.equal(fix.marker, OUTPUT_HYGIENE_MARKER);
  assert.equal(fix.openMarker, OPEN);
  assert.equal(fix.closeMarker, CLOSE);
  assert.equal(fix.ruleId, OUTPUT_HYGIENE_RULE_ID);
  assert.equal(fix.ruleId, "large-tool-result");
  assert.equal(fix.reversible, true);
  assert.equal(fix.applyable, true);
  assert.deepEqual(fix.filesAffected(), [target]);
  assert.equal(fix.display, path.join("~", ".claude", "CLAUDE.md"));

  // A one-line human description, and a rationale that names the measurement.
  assert.equal(typeof fix.descriptionText, "string");
  assert.ok(fix.descriptionText.length > 40 && !fix.descriptionText.includes("\n"));
  assert.match(fix.rationale, /10,240 bytes/);

  const preview = await fix.preview();
  assert.equal(preview.reversible, true);
  assert.equal(preview.applyable, true);
  assert.equal(preview.marker, OUTPUT_HYGIENE_MARKER);
  assert.deepEqual(preview.files_affected, [target]);
  assert.equal(preview.check.applied, false);
  assert.equal(preview.check.status, "not-applied");
});

test("the appended text is exactly the wording under review (wording lock)", async () => {
  const { env } = await scaffold("wording", { claudeMd: "lf.md" });
  const fix = createOutputHygieneFix({ env });
  assert.equal(fix.section, EXPECTED_SECTION);

  // Concrete, actionable mechanisms — not adjectives. Each of these is a thing
  // the CLI reading CLAUDE.md can actually do.
  for (const mechanism of ["head -50", "tail -50", "git diff --stat", "grep -n", "/tmp/out.log", "offset and a limit"]) {
    assert.ok(fix.section.includes(mechanism), `the guidance no longer names \`${mechanism}\``);
  }
  // Grounded in the measurement the rule makes (BP-003.04).
  assert.ok(fix.section.includes("10 KiB"));
  assert.ok(fix.section.includes("three or more tool results"));
});

// ---------------------------------------------------------------------------
// BP-004.06 — the previewed diff is the delta apply() writes.
// ---------------------------------------------------------------------------

for (const fixture of ["lf.md", "crlf.md", "no-trailing-newline.md", "torture.md", "empty.md"]) {
  test(`preview's diff equals the on-disk delta apply() produces — ${fixture}`, async () => {
    const { env, target, bytes: before, beforeHash } = await scaffold(`delta-${fixture}`, { claudeMd: fixture });
    const fix = createOutputHygieneFix({ env });

    const preview = await fix.preview();
    assert.equal(preview.targets.length, 1);
    assert.equal(preview.targets[0].beforeHash, `sha256:${beforeHash}`);

    const applied = await fix.apply();
    assert.equal(applied.applied, true);
    assert.equal(applied.reversible, true);

    const after = await readFile(target);
    // Recomputed from the REAL before/after bytes, not from the returned string.
    const recomputed = unifiedDiff(
      fix.display,
      before.toString("utf8"),
      after.toString("utf8"),
      { context: fix.diffContext },
    );
    assert.equal(preview.diff, recomputed);
    assert.equal(applied.diff, recomputed);
    assert.ok(recomputed.length > 0);
    // And the hash apply() actually wrote is the hash preview() promised.
    assert.equal(`sha256:${hash(after)}`, preview.targets[0].afterHash);
    assert.equal(after.length, preview.targets[0].bytesAfter);
  });
}

test("the appended content is a literal suffix — the prior bytes are untouched", async () => {
  for (const fixture of ["lf.md", "crlf.md", "torture.md"]) {
    const { env, target, bytes: before } = await scaffold(`suffix-${fixture}`, { claudeMd: fixture });
    await createOutputHygieneFix({ env }).apply();
    const after = await readFile(target);
    assert.ok(
      after.subarray(0, before.length).equals(before),
      `${fixture}: the first ${before.length} bytes changed`,
    );
    assert.ok(after.length > before.length);
  }
});

test("a file with no trailing newline gets one, and keeps its own last line", async () => {
  const { env, target, bytes: before } = await scaffold("no-nl", { claudeMd: "no-trailing-newline.md" });
  assert.equal(before.at(-1) === 0x0a, false, "fixture must not end in a newline");

  await createOutputHygieneFix({ env }).apply();
  const after = (await readFile(target)).toString("utf8");
  assert.ok(after.startsWith(before.toString("utf8")));
  // The marker starts on its own line: the inserted newline closes the user's
  // last line, then the section's own leading blank line follows.
  assert.ok(after.includes("- Never commit secrets.\n\n<!-- session-rx"));
  assert.equal(countOf(after, OPEN), 1);
});

test("a CRLF CLAUDE.md gets a CRLF section, with no lone LF introduced", async () => {
  const { env, target, bytes: before } = await scaffold("crlf-eol", { claudeMd: "crlf.md" });
  const preview = await createOutputHygieneFix({ env }).preview();
  assert.equal(preview.targets[0].eol, "crlf");

  await createOutputHygieneFix({ env }).apply();
  const after = (await readFile(target)).toString("utf8");
  const appended = after.slice(before.toString("utf8").length);
  assert.ok(appended.includes("\r\n"));
  assert.equal(/(?<!\r)\n/.test(appended), false, "a bare LF was written into a CRLF file");
  assert.ok(appended.includes(`\r\n${OPEN}\r\n## ${OUTPUT_HYGIENE_HEADING}\r\n`));
});

// ---------------------------------------------------------------------------
// BP-004.10 — undo restores byte-identical bytes.
// ---------------------------------------------------------------------------

for (const fixture of ["lf.md", "crlf.md", "no-trailing-newline.md", "torture.md", "empty.md"]) {
  test(`undo restores byte-identical content — ${fixture}`, async () => {
    const { env, target, bytes: before, beforeHash } = await scaffold(`undo-${fixture}`, { claudeMd: fixture });
    const fix = createOutputHygieneFix({ env });
    const applied = await fix.apply();
    assert.notEqual(hash(await readFile(target)), beforeHash);

    const undone = await fix.undo(applied.undoPath);
    assert.equal(undone.restored, true);
    assert.equal(undone.byteIdentical, true);

    const restored = await readFile(target);
    assert.equal(hash(restored), beforeHash, `${fixture}: undo was not byte-identical`);
    assert.ok(restored.equals(before));
    assert.equal((await fix.check()).applied, false);
  });
}

// ---------------------------------------------------------------------------
// Idempotency: the UI must never offer an applied fix twice.
// ---------------------------------------------------------------------------

test("applying twice leaves exactly one section, and check() is true after the first", async () => {
  const { env, target } = await scaffold("twice", { claudeMd: "lf.md" });
  const fix = createOutputHygieneFix({ env });

  assert.equal((await fix.check()).applied, false);
  await fix.apply();

  const state = await fix.check();
  assert.equal(state.applied, true);
  assert.equal(state.drifted, false);
  assert.equal(state.status, "applied");
  assert.equal(state.reason, "marker-present");
  assert.equal(state.marker, OPEN);

  const afterFirst = await readFile(target);
  await expectFixError(fix.apply(), FIX_ERROR_CODES.ALREADY_APPLIED);
  await expectFixError(fix.preview(), FIX_ERROR_CODES.ALREADY_APPLIED);
  // A second, independently constructed instance refuses too — the marker is on
  // disk, not in the object.
  await expectFixError(createOutputHygieneFix({ env }).apply(), FIX_ERROR_CODES.ALREADY_APPLIED);

  const afterSecond = await readFile(target);
  assert.ok(afterSecond.equals(afterFirst), "the refused second apply changed the file");
  const text = afterSecond.toString("utf8");
  assert.equal(countOf(text, OPEN), 1);
  assert.equal(countOf(text, CLOSE), 1);
  assert.equal(countOf(text, `## ${OUTPUT_HYGIENE_HEADING}`), 1);

  const transactions = await listTransactions(env, { fixId: OUTPUT_HYGIENE_ID });
  assert.equal(transactions.length, 1, "a refused apply still created a transaction");
});

test("an edited section is drift, not a second append", async () => {
  const { env, target } = await scaffold("drift", { claudeMd: "lf.md" });
  const fix = createOutputHygieneFix({ env });
  await fix.apply();

  const text = (await readFile(target)).toString("utf8");
  await writeFile(target, text.replace("head -50", "head -5000"));

  const state = await fix.check();
  assert.equal(state.applied, true);
  assert.equal(state.drifted, true);
  assert.equal(state.reason, "section-modified");
  const before = await readFile(target);
  await expectFixError(fix.apply(), FIX_ERROR_CODES.MARKER_DRIFT);
  assert.ok((await readFile(target)).equals(before), "a drift refusal changed the file");
});

// ---------------------------------------------------------------------------
// Fail closed: no partial write, and a diagnostic that names the problem.
// ---------------------------------------------------------------------------

// Previously this asserted REFUSAL: apply() rejected with TARGET_MISSING and
// the file was never created. BP-004.11 changed the contract — measured on a
// clean machine, all five fixes refused because ~/.claude/CLAUDE.md did not
// exist, and most Claude Code users have never hand-written that file, so the
// product's core loop was unreachable for them. SessionRx now CREATES an
// absent target whenever its parent directory (`~/.claude/`) already exists.
// This is the strictly stronger replacement, not a lowered bar: creation
// succeeds, the created file holds EXACTLY the wording-locked section (no
// invented header or title), and undo removes the file it created rather
// than leaving an empty stub behind.
test("a missing CLAUDE.md is created by apply, holds exactly the section, and undo removes it", async () => {
  const { env, home, claudeDir } = await scaffoldEmpty("missing");
  const fix = createOutputHygieneFix({ env });
  const target = path.join(claudeDir, "CLAUDE.md");

  const state = await fix.check();
  assert.equal(state.status, "unknown");
  assert.equal(state.reason, FIX_ERROR_CODES.TARGET_MISSING);

  const preview = await fix.preview();
  assert.equal(preview.targets.length, 1);
  assert.equal(preview.targets[0].created, true, "preview must mark an absent target as created");
  assert.match(preview.diff, /^--- \/dev\/null\n/, "a created target's diff must render the old side as /dev/null");
  assert.match(preview.description, /does not exist yet; SessionRx will create it/);

  const applied = await fix.apply();
  assert.equal(applied.applied, true);

  const after = await readFile(target);
  assert.equal(
    after.toString("utf8"),
    EXPECTED_SECTION,
    "the created file must hold exactly the section under the wording lock, nothing invented",
  );
  assert.equal(`sha256:${hash(after)}`, preview.targets[0].afterHash);
  assert.equal((await fix.check()).applied, true);

  const undone = await fix.undo(applied.undoPath);
  assert.equal(undone.restored, true);
  assert.equal(undone.byteIdentical, true);
  assert.equal(await exists(target), false, "undo of a created file must remove it, not leave an empty stub");
  assert.equal((await fix.check()).status, "unknown");
});

// Coverage kept from the old contract, restated more precisely: SessionRx
// creates a missing FILE but never fabricates a missing PARENT DIRECTORY — an
// absent `~/.claude/` means the owning CLI is not installed at all, which is
// not this project's job to fix. The refusal must name the directory, because
// the directory, not the file, is what is actually missing.
test("an absent ~/.claude directory is refused, and the error names the directory", async () => {
  const home = path.join(TMP_ROOT, `no-claude-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = makeEnv(home);
  const fix = createOutputHygieneFix({ env });
  const target = path.join(home, ".claude", "CLAUDE.md");

  const state = await fix.check();
  assert.equal(state.status, "unknown");
  assert.equal(state.reason, FIX_ERROR_CODES.TARGET_MISSING);

  const error = await expectFixError(fix.apply(), FIX_ERROR_CODES.TARGET_MISSING);
  assert.match(error.message, /\.claude does not exist; SessionRx will not create it/);
  assert.equal(await exists(target), false);
  assert.equal(await stateDirExists(home), false);
});

test("a symlinked CLAUDE.md is refused, the link survives, nothing is written", async (t) => {
  const { env, home, claudeDir } = await scaffoldEmpty("symlink");
  const real = path.join(home, "dotfiles", "CLAUDE.md");
  await mkdir(path.dirname(real), { recursive: true });
  await writeFile(real, "# dotfiles-managed\n");
  const link = path.join(claudeDir, "CLAUDE.md");
  try {
    await symlink(real, link);
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error.code)) {
      t.skip(`symlink creation requires privilege on this runner (${error.code})`);
      return;
    }
    throw error;
  }
  const before = await readFile(real);

  const fix = createOutputHygieneFix({ env });
  const state = await fix.check();
  assert.equal(state.status, "unknown");
  assert.equal(state.reason, FIX_ERROR_CODES.TARGET_IS_SYMLINK);

  const error = await expectFixError(fix.apply(), FIX_ERROR_CODES.TARGET_IS_SYMLINK);
  assert.match(error.message, /atomic rename would replace the link/);
  assertSymlinkTargetMentioned(error.message, link, real);

  assert.ok((await readFile(real)).equals(before), "the symlink target was modified");
  const { lstat } = await import("node:fs/promises");
  assert.equal((await lstat(link)).isSymbolicLink(), true, "the symlink was replaced");
  assert.equal(await stateDirExists(home), false);
});

test("a CLAUDE.md that is a directory is refused", async () => {
  const { env, home, claudeDir } = await scaffoldEmpty("isdir");
  await mkdir(path.join(claudeDir, "CLAUDE.md"));
  const fix = createOutputHygieneFix({ env });
  assert.equal((await fix.check()).reason, FIX_ERROR_CODES.TARGET_NOT_FILE);
  await expectFixError(fix.apply(), FIX_ERROR_CODES.TARGET_NOT_FILE);
  assert.equal(await stateDirExists(home), false);
});

test("an unwritable CLAUDE.md is refused before any backup exists", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: file modes do not deny access");
    return;
  }
  const { env, home, target } = await scaffold("readonly", { claudeMd: "lf.md" });
  const { chmod } = await import("node:fs/promises");
  await chmod(target, 0o400);
  try {
    await expectFixError(createOutputHygieneFix({ env }).apply(), FIX_ERROR_CODES.TARGET_UNWRITABLE);
    assert.equal(await stateDirExists(home), false, "the undo dir was created before writability was proven");
  } finally {
    await chmod(target, 0o644);
  }
});

// ---------------------------------------------------------------------------
// The safety property the whole suite rests on.
// ---------------------------------------------------------------------------

test("the harness refuses the real home, so no fix here can name it", () => {
  assert.throws(() => makeEnv(os.homedir()), /refuse a home outside/);
  assert.throws(() => makeEnv(path.join(os.homedir(), ".claude")), /refuse a home outside/);
  assert.throws(() => makeEnv(path.dirname(TMP_ROOT)), /refuse a home outside/);
});

test("the real ~/.claude/CLAUDE.md and ~/.claude/settings.json were never touched", async () => {
  await assertRealFilesUnchanged();
});
