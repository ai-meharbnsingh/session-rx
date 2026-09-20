/**
 * Wave 4B — `claude-auto-compact` (BP-004.01, DIS-008): the settings.json fix.
 *
 * REAL-FILE SAFETY. Every fix in this suite is constructed with an env from the
 * 4B harness's `makeEnv()`, which REFUSES any home that is not inside this
 * process's `mkdtemp` root; the wave-4A engine derives every path it touches
 * from `env.home`, so a fix built here cannot name `~/.claude/settings.json`.
 * The suite never calls `createFixEnvironment()` without a home. Belt and
 * braces: the real `~/.claude/CLAUDE.md` and `~/.claude/settings.json` are
 * hashed when the harness loads and re-hashed in the last test, together with
 * the presence of `~/.session-rx`.
 */

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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
  AUTO_COMPACT_ID,
  AUTO_COMPACT_KEY,
  AUTO_COMPACT_MARKER,
  AUTO_COMPACT_MERGE,
  AUTO_COMPACT_RULE_ID,
  AUTO_COMPACT_SCHEMA_REASON,
  AUTO_COMPACT_TARGET,
  createAutoCompactFix,
} from "../src/fixes/claude/auto-compact.js";
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

/** THE MERGED FRAGMENT under review, written out as a literal (BP-004.01). */
const EXPECTED_FRAGMENT = "\"autoCompact\": true";

/** The pre-existing keys of `settings/rich.json`, in file order. */
const RICH_KEYS = [
  "theme",
  "model",
  "permissions",
  "env",
  "aKeyThisFixHasNeverHeardOf",
  "zzzLastKey",
];

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

test("the fix declares BP-004.01's id, key, marker, rule and reversibility", async () => {
  const { env, target } = await scaffold("meta", { settings: "rich.json" });
  const fix = createAutoCompactFix({ env });

  assert.equal(fix.id, AUTO_COMPACT_ID);
  assert.equal(fix.id, "claude-auto-compact");
  assert.equal(fix.kind, "json-merge");
  assert.equal(AUTO_COMPACT_TARGET, ".claude/settings.json");
  assert.equal(AUTO_COMPACT_KEY, "autoCompact");
  assert.deepEqual({ ...AUTO_COMPACT_MERGE }, { autoCompact: true });
  assert.deepEqual(fix.merge, { autoCompact: true });
  assert.deepEqual(fix.keys, ["autoCompact"]);
  // The STABLE idempotency marker, exactly as BP-004.01 states it.
  assert.equal(AUTO_COMPACT_MARKER, "autoCompact === true");
  assert.equal(fix.marker, AUTO_COMPACT_MARKER);
  assert.equal(fix.ruleId, AUTO_COMPACT_RULE_ID);
  assert.equal(fix.ruleId, "context-pressure");
  assert.equal(fix.reversible, true);
  assert.equal(fix.applyable, true);
  assert.equal(fix.indent, 2);
  assert.deepEqual(fix.filesAffected(), [target]);
  assert.equal(fix.display, path.join("~", ".claude", "settings.json"));

  assert.ok(fix.descriptionText.includes(EXPECTED_FRAGMENT));
  assert.ok(!fix.descriptionText.includes("\n"));
  assert.match(fix.rationale, /0\.70 of the window/);

  const preview = await fix.preview();
  assert.equal(preview.reversible, true);
  assert.equal(preview.applyable, true);
  assert.equal(preview.marker, AUTO_COMPACT_MARKER);
  assert.deepEqual(preview.files_affected, [target]);
  // A settings diff can carry a neighbouring key's value, so the payload must
  // reach wave 5A flagged for the BP-005.15 redaction gate.
  assert.equal(preview.sensitive, true);
  assert.deepEqual(preview.conflicts, []);
  assert.equal(preview.check.applied, false);
  assert.equal(preview.check.status, "not-applied");
});

// ---------------------------------------------------------------------------
// BP-004.09 — every pre-existing key survives, with its value and its position.
// ---------------------------------------------------------------------------

test("the merge adds one key and preserves every other key, value and position", async () => {
  const { env, target, bytes: before } = await scaffold("preserve", { settings: "rich.json" });
  const original = JSON.parse(before.toString("utf8"));
  assert.deepEqual(Object.keys(original), RICH_KEYS);
  // A key this fix has never heard of is present on purpose.
  assert.ok(Object.hasOwn(original, "aKeyThisFixHasNeverHeardOf"));

  await createAutoCompactFix({ env }).apply();

  const afterText = (await readFile(target)).toString("utf8");
  const merged = JSON.parse(afterText);

  // Order: the original keys in the original order, then the one new key.
  assert.deepEqual(Object.keys(merged), [...RICH_KEYS, "autoCompact"]);
  assert.equal(merged.autoCompact, true);
  for (const key of RICH_KEYS) {
    assert.deepEqual(merged[key], original[key], `the value of "${key}" changed`);
  }
  // Nested structures are copied, not flattened or reordered.
  assert.deepEqual(merged.aKeyThisFixHasNeverHeardOf, { nested: [1, 2, 3], flag: false });
  assert.deepEqual(Object.keys(merged.permissions), ["allow", "deny"]);

  // BP-004.09 — stable two-space indentation, and the fragment as written.
  assert.ok(afterText.includes("\n  \"theme\": \"dark\","));
  assert.ok(afterText.includes(`\n  ${EXPECTED_FRAGMENT}`));
  assert.ok(afterText.includes("\n    \"nested\": ["));
});

// ---------------------------------------------------------------------------
// BP-004.06 — the previewed diff is the delta apply() writes.
// ---------------------------------------------------------------------------

for (const fixture of ["rich.json", "crlf-no-newline.json", "opted-out.json"]) {
  test(`preview's diff equals the on-disk delta apply() produces — ${fixture}`, async () => {
    const { env, target, bytes: before, beforeHash } = await scaffold(`delta-${fixture}`, { settings: fixture });
    const fix = createAutoCompactFix({ env });

    const preview = await fix.preview();
    assert.equal(preview.targets[0].beforeHash, `sha256:${beforeHash}`);

    const applied = await fix.apply();
    const after = await readFile(target);
    const recomputed = unifiedDiff(
      fix.display,
      before.toString("utf8"),
      after.toString("utf8"),
      { context: fix.diffContext },
    );
    assert.equal(preview.diff, recomputed);
    assert.equal(applied.diff, recomputed);
    assert.ok(recomputed.length > 0);
    assert.equal(`sha256:${hash(after)}`, preview.targets[0].afterHash);
    assert.equal(after.length, preview.targets[0].bytesAfter);
  });
}

test("a CRLF settings.json with no trailing newline keeps both properties", async () => {
  const { env, target } = await scaffold("crlf-json", { settings: "crlf-no-newline.json" });
  const preview = await createAutoCompactFix({ env }).preview();
  assert.equal(preview.targets[0].eol, "crlf");

  await createAutoCompactFix({ env }).apply();
  const after = (await readFile(target)).toString("utf8");
  assert.equal(/(?<!\r)\n/.test(after), false, "a bare LF was written into a CRLF file");
  assert.equal(/(\r\n)$/.test(after), false, "a trailing newline was added");
  assert.equal(JSON.parse(after).autoCompact, true);
  assert.deepEqual(Object.keys(JSON.parse(after)), ["theme", "model", "autoCompact"]);
});

// ---------------------------------------------------------------------------
// BP-004.10 — undo restores byte-identical bytes.
// ---------------------------------------------------------------------------

for (const fixture of ["rich.json", "crlf-no-newline.json", "opted-out.json"]) {
  test(`undo restores byte-identical content — ${fixture}`, async () => {
    const { env, target, bytes: before, beforeHash } = await scaffold(`undo-${fixture}`, { settings: fixture });
    const fix = createAutoCompactFix({ env });
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
// Idempotency.
// ---------------------------------------------------------------------------

test("applying twice merges once, and check() is true after the first", async () => {
  const { env, target } = await scaffold("twice", { settings: "rich.json" });
  const fix = createAutoCompactFix({ env });

  assert.equal((await fix.check()).applied, false);
  await fix.apply();

  const state = await fix.check();
  assert.equal(state.applied, true);
  assert.equal(state.status, "applied");
  assert.equal(state.reason, "keys-present");
  assert.equal(state.marker, AUTO_COMPACT_MARKER);

  const afterFirst = await readFile(target);
  await expectFixError(fix.apply(), FIX_ERROR_CODES.ALREADY_APPLIED);
  await expectFixError(fix.preview(), FIX_ERROR_CODES.ALREADY_APPLIED);
  await expectFixError(createAutoCompactFix({ env }).apply(), FIX_ERROR_CODES.ALREADY_APPLIED);

  const afterSecond = await readFile(target);
  assert.ok(afterSecond.equals(afterFirst), "the refused second apply changed the file");
  const text = afterSecond.toString("utf8");
  let seen = 0;
  for (let at = text.indexOf(EXPECTED_FRAGMENT); at !== -1; at = text.indexOf(EXPECTED_FRAGMENT, at + 1)) seen += 1;
  assert.equal(seen, 1, "the key was merged more than once");

  assert.equal((await listTransactions(env, { fixId: AUTO_COMPACT_ID })).length, 1);
});

test("a settings.json that already has the key is detected without being touched", async () => {
  const { env, target, bytes: before } = await scaffold("already", { settings: "already.json" });
  const fix = createAutoCompactFix({ env });
  const state = await fix.check();
  assert.equal(state.applied, true);
  assert.equal(state.status, "applied");
  await expectFixError(fix.apply(), FIX_ERROR_CODES.ALREADY_APPLIED);
  assert.ok((await readFile(target)).equals(before));
});

// ---------------------------------------------------------------------------
// DIS-008 — an unrecognised settings schema fails closed with a diagnostic.
// ---------------------------------------------------------------------------

for (const [fixture, found] of [
  ["schema-string.json", "string"],
  ["schema-object.json", "object"],
  ["schema-null.json", "null"],
]) {
  test(`a non-boolean autoCompact fails closed with a diagnostic — ${fixture}`, async () => {
    const { env, home, target, bytes: before } = await scaffold(`schema-${fixture}`, { settings: fixture });
    const fix = createAutoCompactFix({ env });

    // FVA-006: unknown, not "not-applied" — the UI must not offer an apply that
    // is going to refuse.
    const state = await fix.check();
    assert.equal(state.status, "unknown");
    assert.equal(state.applied, false);
    assert.equal(state.reason, AUTO_COMPACT_SCHEMA_REASON);
    assert.equal(state.foundType, found);
    assert.match(state.message, /not the boolean this fix understands/);

    // preview() refuses through the same path as apply(), so the UI cannot even
    // render a diff for it.
    const previewError = await expectFixError(fix.preview(), FIX_ERROR_CODES.TARGET_UNPARSEABLE);
    assert.equal(previewError.details.reason, AUTO_COMPACT_SCHEMA_REASON);
    const applyError = await expectFixError(fix.apply(), FIX_ERROR_CODES.TARGET_UNPARSEABLE);
    assert.equal(applyError.details.reason, AUTO_COMPACT_SCHEMA_REASON);
    assert.equal(applyError.details.foundType, found);
    assert.match(applyError.message, /nothing has been written/);

    // No partial write, and no transaction, journal or backup either.
    assert.ok((await readFile(target)).equals(before), "a schema refusal wrote to the file");
    assert.equal(await stateDirExists(home), false, "a schema refusal created state");
  });
}

test("an explicit autoCompact:false is a conflict the preview shows, not a schema refusal", async () => {
  const { env, target, bytes: before } = await scaffold("opted-out-conflict", { settings: "opted-out.json" });
  const fix = createAutoCompactFix({ env });

  const state = await fix.check();
  assert.equal(state.status, "not-applied");
  assert.equal(state.reason, "keys-absent-or-different");

  const preview = await fix.preview();
  assert.deepEqual(preview.conflicts, [{ key: "autoCompact", from: false, to: true }]);
  assert.match(preview.targets[0].note, /replaces 1 existing value/);
  assert.ok(preview.diff.includes("\"autoCompact\": false"));
  assert.ok(preview.diff.includes(EXPECTED_FRAGMENT));

  const applied = await fix.apply();
  const merged = JSON.parse((await readFile(target)).toString("utf8"));
  assert.equal(merged.autoCompact, true);
  // Position is kept: a replaced key does not move to the end.
  assert.deepEqual(Object.keys(merged), ["theme", "autoCompact", "after"]);

  await fix.undo(applied.undoPath);
  assert.ok((await readFile(target)).equals(before), "undo did not restore the opt-out");
  assert.equal(JSON.parse((await readFile(target)).toString("utf8")).autoCompact, false);
});

// ---------------------------------------------------------------------------
// Fail closed: no partial write, and a diagnostic that names the problem.
// ---------------------------------------------------------------------------

test("an unparseable settings.json is refused and left byte-identical", async () => {
  const { env, home, target, bytes: before } = await scaffold("broken", { settings: "broken.json" });
  const fix = createAutoCompactFix({ env });

  const state = await fix.check();
  assert.equal(state.status, "unknown");
  assert.equal(state.reason, FIX_ERROR_CODES.TARGET_UNPARSEABLE);

  const error = await expectFixError(fix.apply(), FIX_ERROR_CODES.TARGET_UNPARSEABLE);
  assert.match(error.message, /is not valid JSON, so SessionRx will not rewrite it/);
  assert.ok((await readFile(target)).equals(before));
  assert.equal(await stateDirExists(home), false);
});

test("a settings.json that is valid JSON but not an object is refused", async () => {
  const { env, home, target, bytes: before } = await scaffold("array", { settings: "array.json" });
  const fix = createAutoCompactFix({ env });
  assert.equal((await fix.check()).status, "unknown");
  await expectFixError(fix.apply(), FIX_ERROR_CODES.TARGET_UNPARSEABLE);
  assert.ok((await readFile(target)).equals(before));
  assert.equal(await stateDirExists(home), false);
});

test("a missing settings.json is refused and is NOT created", async () => {
  const { env, home, claudeDir } = await scaffoldEmpty("missing");
  const fix = createAutoCompactFix({ env });
  const state = await fix.check();
  assert.equal(state.status, "unknown");
  assert.equal(state.reason, FIX_ERROR_CODES.TARGET_MISSING);
  const error = await expectFixError(fix.apply(), FIX_ERROR_CODES.TARGET_MISSING);
  assert.match(error.message, /will not create it/);
  assert.equal(await exists(path.join(claudeDir, "settings.json")), false);
  assert.equal(await stateDirExists(home), false);
});

test("a symlinked settings.json is refused, the link survives, nothing is written", async () => {
  const { env, home, claudeDir } = await scaffoldEmpty("symlink");
  const real = path.join(home, "dotfiles", "settings.json");
  await mkdir(path.dirname(real), { recursive: true });
  await writeFile(real, "{\n  \"theme\": \"dark\"\n}\n");
  const link = path.join(claudeDir, "settings.json");
  await symlink(real, link);
  const before = await readFile(real);

  const fix = createAutoCompactFix({ env });
  assert.equal((await fix.check()).reason, FIX_ERROR_CODES.TARGET_IS_SYMLINK);
  const error = await expectFixError(fix.apply(), FIX_ERROR_CODES.TARGET_IS_SYMLINK);
  assert.ok(error.message.includes(real));

  assert.ok((await readFile(real)).equals(before), "the symlink target was modified");
  assert.equal((await lstat(link)).isSymbolicLink(), true, "the symlink was replaced");
  assert.equal(await stateDirExists(home), false);
});

test("an unwritable settings.json is refused before any backup exists", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: file modes do not deny access");
    return;
  }
  const { env, home, target, bytes: before } = await scaffold("readonly", { settings: "rich.json" });
  await chmod(target, 0o400);
  try {
    await expectFixError(createAutoCompactFix({ env }).apply(), FIX_ERROR_CODES.TARGET_UNWRITABLE);
    assert.ok((await readFile(target)).equals(before));
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

test("the real ~/.claude/settings.json and ~/.claude/CLAUDE.md were never touched", async () => {
  await assertRealFilesUnchanged();
});
