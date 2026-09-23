/**
 * Wave 4A — the fix engine foundation (BP-004, BP-004.06..10, FVA-007).
 *
 * REAL-FILE SAFETY, stated once because it is the whole reason this suite is
 * shaped the way it is:
 *
 *   Every fix in this file is constructed with an env from `makeEnv()`, which
 *   REFUSES any home that is not inside this run's `mkdtemp` root.  The fix
 *   engine derives every path it reads or writes from `env.home`, so a fix
 *   built here cannot name `~/.claude/CLAUDE.md` even by accident.
 *   `createFixEnvironment()` with no argument is the only code that reads
 *   `os.homedir()`, and the one test that calls it makes no IO at all.
 *   Belt and braces: the real `~/.claude/CLAUDE.md` and `~/.claude/settings.json`
 *   are hashed before the suite runs and re-hashed in the last test.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AppendSectionFix,
  FIX_CHECK_STATUSES,
  FIX_ERROR_CODES,
  FIX_KINDS,
  FixBase,
  FixError,
  HabitRecommendation,
  JsonMergeFix,
  MAX_TARGET_BYTES,
  WritableFix,
  buildDelimitedSection,
  createFixEnvironment,
  detectEol,
  endsWithNewline,
  listTransactions,
  readJournal,
  sha256Hex,
  undoTransaction,
  unifiedDiff,
} from "../src/fixes/base.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "fixes");

/** Hashed with node:crypto directly, not with the module under test. */
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- real-home guard ------------------------------------------------------
const REAL_HOME = os.homedir();
const REAL_GUARDED = [
  path.join(REAL_HOME, ".claude", "CLAUDE.md"),
  path.join(REAL_HOME, ".claude", "settings.json"),
];

async function snapshotRealFiles() {
  const out = {};
  for (const file of REAL_GUARDED) {
    try {
      out[file] = hash(await readFile(file));
    } catch (error) {
      out[file] = `absent:${error.code}`;
    }
  }
  return out;
}

const REAL_BEFORE = await snapshotRealFiles();

// --- temp homes -----------------------------------------------------------
const TMP_ROOT = await mkdtemp(path.join(os.tmpdir(), "session-rx-fixes-"));

/**
 * The single chokepoint for fix construction in this suite.  A home outside the
 * temp root is a bug in the test, and it fails here rather than on the
 * developer's real config file.
 */
function makeEnv(home, options = {}) {
  assert.ok(
    home.startsWith(TMP_ROOT + path.sep),
    `test bug: ${home} is not inside the temp root ${TMP_ROOT}`,
  );
  return createFixEnvironment({ home, ...options });
}

async function freshHome(label) {
  const home = path.join(TMP_ROOT, label);
  await mkdir(path.join(home, ".claude"), { recursive: true });
  return home;
}

async function installFixture(home, relFixture, relTarget) {
  const target = path.join(home, relTarget);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(FIXTURES, relFixture), target);
  return target;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// --- the fix specs under test --------------------------------------------
// BP-004.02 verbatim: this suite is the thing that pins waves 4B/4C to the
// blueprint's exact appended text.
const HYGIENE_SPEC = {
  id: "claude-output-hygiene",
  title: "Bound tool output",
  target: ".claude/CLAUDE.md",
  marker: "session-rx:output-hygiene:v1",
  heading: "SessionRx: output hygiene",
  body: "Keep tool output concise; request bounded, relevant output and summarize large results before continuing.",
  rationale: "Unbounded tool output is the single largest avoidable context cost.",
  ruleId: "BP-003.05",
};

const BP_004_02_TEXT = "\n<!-- session-rx:output-hygiene:v1 -->\n## SessionRx: output hygiene\n"
  + "Keep tool output concise; request bounded, relevant output and summarize large results before continuing.\n"
  + "<!-- /session-rx:output-hygiene:v1 -->\n";

function mdFix(env, overrides = {}) {
  return new AppendSectionFix({ ...HYGIENE_SPEC, env, ...overrides });
}

function jsonFix(env, overrides = {}) {
  return new JsonMergeFix({
    id: "claude-auto-compact",
    title: "Turn on auto-compaction",
    target: ".claude/settings.json",
    merge: { autoCompact: true },
    rationale: "A session that never compacts pays for its whole history every turn.",
    env,
    ...overrides,
  });
}

/** The diff a caller can recompute from the real bytes on disk. */
function diffOf(fix, beforeBytes, afterBytes) {
  return unifiedDiff(
    fix.display,
    beforeBytes.toString("utf8"),
    afterBytes.toString("utf8"),
    { context: fix.diffContext },
  );
}

// =========================================================================
// 0. The fixtures really are what the byte-level tests below assume.
// =========================================================================

test("fixtures are byte-exact: crlf, no-trailing-newline and non-ascii survived git", async () => {
  const crlf = await readFile(path.join(FIXTURES, "claude-md", "crlf.md"), "utf8");
  assert.match(crlf, /\r\n/, "crlf.md must contain CRLF");
  assert.equal(/(?<!\r)\n/.test(crlf), false, "crlf.md must contain no bare LF");
  assert.equal(detectEol(crlf), "\r\n");

  const bare = await readFile(path.join(FIXTURES, "claude-md", "no-trailing-newline.md"), "utf8");
  assert.equal(endsWithNewline(bare), false, "no-trailing-newline.md must not end with a newline");

  const nonAscii = await readFile(path.join(FIXTURES, "claude-md", "non-ascii.md"));
  assert.ok(
    nonAscii.length > nonAscii.toString("utf8").length,
    "non-ascii.md must contain multi-byte characters",
  );

  const torture = await readFile(path.join(FIXTURES, "claude-md", "torture.md"), "utf8");
  assert.match(torture, /\r\n/);
  assert.equal(endsWithNewline(torture), false);
  assert.ok(Buffer.from(torture, "utf8").length > torture.length);

  const crlfJson = await readFile(path.join(FIXTURES, "settings", "crlf-no-newline.json"), "utf8");
  assert.match(crlfJson, /\r\n/);
  assert.equal(endsWithNewline(crlfJson), false);
});

test("buildDelimitedSection reproduces the BP-004.02 appended text verbatim", () => {
  assert.equal(buildDelimitedSection(HYGIENE_SPEC), BP_004_02_TEXT);
  assert.throws(() => buildDelimitedSection({ marker: "m", heading: "h" }), { code: FIX_ERROR_CODES.SPEC_INVALID });
});

// =========================================================================
// 1. Happy paths: preview -> apply -> check -> undo, both writable kinds.
// =========================================================================

test("CLAUDE.md append: preview, apply, check and undo round-trip", async () => {
  const home = await freshHome("md-happy");
  const target = await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  const before = await readFile(target);
  const env = makeEnv(home);
  const fix = mdFix(env);

  const initial = await fix.check();
  assert.equal(initial.applied, false);
  assert.equal(initial.status, "not-applied");
  assert.equal(initial.marker, "<!-- session-rx:output-hygiene:v1 -->");

  const preview = await fix.preview();
  assert.equal(preview.reversible, true);
  assert.equal(preview.applyable, true);
  assert.deepEqual(preview.files_affected, [target]);
  assert.equal(preview.targets.length, 1);
  const display = path.join("~", ".claude", "CLAUDE.md");
  assert.equal(preview.targets[0].display, display);
  assert.equal(preview.targets[0].beforeHash, `sha256:${hash(before)}`);
  const escapedDisplay = display.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(preview.diff, new RegExp(`^--- ${escapedDisplay}\\n`));
  assert.match(preview.diff, /^\+<!-- session-rx:output-hygiene:v1 -->$/m);
  assert.equal(preview.check.applied, false);
  assert.equal(preview.sensitive, true, "a CLAUDE.md diff shows the user's own lines as context");
  // Nothing has been written yet.
  assert.deepEqual(await readFile(target), before);
  assert.equal(await exists(path.join(home, ".session-rx")), false);

  const applied = await fix.apply();
  assert.equal(applied.applied, true);
  assert.equal(applied.reversible, true);
  assert.deepEqual(applied.files_affected, [target]);
  assert.ok(applied.undoPath.startsWith(path.join(home, ".session-rx", "undo") + path.sep));

  const after = await readFile(target);
  // BP-004.08: the prior bytes are a literal prefix — nothing above the new
  // section was rewritten, reordered or reflowed.
  assert.ok(after.subarray(0, before.length).equals(before), "existing bytes must be untouched");
  assert.equal(after.subarray(before.length).toString("utf8"), BP_004_02_TEXT);
  assert.equal(`sha256:${hash(after)}`, preview.targets[0].afterHash);

  const nowApplied = await fix.check();
  assert.equal(nowApplied.applied, true);
  assert.equal(nowApplied.drifted, false);
  assert.equal(nowApplied.status, "applied");

  const undone = await fix.undo();
  assert.equal(undone.restored, true);
  assert.equal(undone.byteIdentical, true);
  assert.equal(hash(await readFile(target)), hash(before));
  assert.equal((await fix.check()).applied, false);
});

test("settings.json merge: preview, apply, check and undo round-trip", async () => {
  const home = await freshHome("json-happy");
  const target = await installFixture(home, "settings/rich.json", ".claude/settings.json");
  const before = await readFile(target);
  const env = makeEnv(home);
  const fix = jsonFix(env);

  assert.equal((await fix.check()).applied, false);

  const preview = await fix.preview();
  assert.equal(preview.reversible, true);
  assert.equal(preview.sensitive, true, "a settings diff must be flagged for the BP-005.15 gate");
  assert.equal(preview.marker, "autoCompact === true");
  assert.deepEqual(preview.conflicts, []);
  assert.match(preview.diff, /^\+ {2}"autoCompact": true$/m);

  const applied = await fix.apply();
  assert.equal(applied.applied, true);
  const after = await readFile(target);
  assert.equal(`sha256:${hash(after)}`, preview.targets[0].afterHash);
  assert.equal(JSON.parse(after.toString("utf8")).autoCompact, true);

  const state = await fix.check();
  assert.equal(state.applied, true);
  assert.equal(state.marker, "autoCompact === true");

  const undone = await undoTransaction(applied.undoPath, { env });
  assert.equal(undone.byteIdentical, true);
  assert.equal(hash(await readFile(target)), hash(before));
  assert.equal((await fix.check()).applied, false);
});

// =========================================================================
// 2. BP-004.06 — preview() cannot lie.
// =========================================================================

test("preview().diff equals the delta apply() actually writes, and its hash", async () => {
  const cases = [
    ["preview-md", "claude-md/lf.md", ".claude/CLAUDE.md", mdFix],
    ["preview-md-crlf", "claude-md/crlf.md", ".claude/CLAUDE.md", mdFix],
    ["preview-md-torture", "claude-md/torture.md", ".claude/CLAUDE.md", mdFix],
    ["preview-json", "settings/rich.json", ".claude/settings.json", jsonFix],
    ["preview-json-crlf", "settings/crlf-no-newline.json", ".claude/settings.json", jsonFix],
    ["preview-json-conflict", "settings/conflict.json", ".claude/settings.json", jsonFix],
  ];
  for (const [label, fixture, relTarget, factory] of cases) {
    const home = await freshHome(label);
    const target = await installFixture(home, fixture, relTarget);
    const before = await readFile(target);
    const fix = factory(makeEnv(home));

    const preview = await fix.preview();
    const applied = await fix.apply();
    const after = await readFile(target);

    // The diff recomputed from the REAL before/after bytes on disk.
    assert.equal(diffOf(fix, before, after), preview.diff, `${label}: previewed diff != real delta`);
    assert.equal(applied.diff, preview.diff, `${label}: apply() reported a different diff`);
    assert.equal(
      `sha256:${hash(after)}`,
      preview.targets[0].afterHash,
      `${label}: bytes written != bytes previewed`,
    );
    assert.equal(preview.targets[0].bytesAfter, after.length, `${label}: previewed byte count`);
  }
});

// =========================================================================
// 3. BP-004.10 — byte-identical undo across the three cases that break naive
//    implementations, compared by hash.
// =========================================================================

test("undo restores byte-identical content for crlf, no-trailing-newline and non-ascii targets", async () => {
  const cases = [
    ["undo-crlf", "claude-md/crlf.md", "\r\n"],
    ["undo-bare", "claude-md/no-trailing-newline.md", "\n"],
    ["undo-nonascii", "claude-md/non-ascii.md", "\n"],
    ["undo-torture", "claude-md/torture.md", "\r\n"],
  ];
  for (const [label, fixture, expectedEol] of cases) {
    const home = await freshHome(label);
    const target = await installFixture(home, fixture, ".claude/CLAUDE.md");
    const before = await readFile(target);
    const beforeHash = hash(before);
    const fix = mdFix(makeEnv(home));

    const preview = await fix.preview();
    assert.equal(preview.targets[0].eol, expectedEol === "\r\n" ? "crlf" : "lf", `${label}: eol`);

    const applied = await fix.apply();
    const after = await readFile(target);
    assert.notEqual(hash(after), beforeHash, `${label}: apply must actually change the file`);
    // The appended section uses the file's OWN newline style — no mixed EOLs.
    const appended = after.subarray(before.length).toString("utf8");
    if (expectedEol === "\r\n") {
      assert.equal(/(?<!\r)\n/.test(appended), false, `${label}: appended a bare LF into a CRLF file`);
    } else {
      assert.equal(appended.includes("\r"), false, `${label}: appended a CR into an LF file`);
    }

    const undone = await fix.undo(applied.undoPath);
    assert.equal(undone.byteIdentical, true, `${label}: undo did not claim byte-identical`);
    assert.equal(hash(await readFile(target)), beforeHash, `${label}: undo was not byte-identical`);
  }
});

test("undo restores a CRLF settings.json with no trailing newline byte-identically", async () => {
  const home = await freshHome("undo-json-crlf");
  const target = await installFixture(home, "settings/crlf-no-newline.json", ".claude/settings.json");
  const before = await readFile(target);
  const fix = jsonFix(makeEnv(home));

  const applied = await fix.apply();
  const after = await readFile(target);
  assert.match(after.toString("utf8"), /\r\n/, "the rewritten JSON must keep CRLF");
  assert.equal(endsWithNewline(after.toString("utf8")), false, "and keep its missing final newline");
  assert.equal(JSON.parse(after.toString("utf8")).greeting, "café ☕", "non-ascii values survive");

  await fix.undo(applied.undoPath);
  assert.equal(hash(await readFile(target)), hash(before));
});

// =========================================================================
// 4. Idempotency — applying twice must not duplicate.
// =========================================================================

test("applying twice refuses, leaves exactly one section, and check() stays true", async () => {
  const home = await freshHome("idempotent");
  const target = await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  const env = makeEnv(home);
  const fix = mdFix(env);

  await fix.apply();
  const afterFirst = await readFile(target);

  await assert.rejects(() => fix.apply(), { code: FIX_ERROR_CODES.ALREADY_APPLIED });
  await assert.rejects(() => fix.preview(), { code: FIX_ERROR_CODES.ALREADY_APPLIED });

  assert.equal(hash(await readFile(target)), hash(afterFirst), "a refused apply must change nothing");
  const text = afterFirst.toString("utf8");
  assert.equal((text.match(/<!-- session-rx:output-hygiene:v1 -->/g) ?? []).length, 1);
  assert.equal((text.match(/<!-- \/session-rx:output-hygiene:v1 -->/g) ?? []).length, 1);
  assert.equal((await fix.check()).applied, true);
  // The refused apply did not open a second transaction either.
  assert.equal((await readdir(path.join(home, ".session-rx", "undo"))).length, 1);
});

test("a settings.json that already carries the key is reported applied and refused", async () => {
  const home = await freshHome("idempotent-json");
  const target = await installFixture(home, "settings/already.json", ".claude/settings.json");
  const before = await readFile(target);
  const fix = jsonFix(makeEnv(home));

  const state = await fix.check();
  assert.equal(state.applied, true);
  assert.equal(state.status, "applied");
  await assert.rejects(() => fix.apply(), { code: FIX_ERROR_CODES.ALREADY_APPLIED });
  assert.equal(hash(await readFile(target)), hash(before));
  assert.equal(await exists(path.join(home, ".session-rx")), false);
});

// =========================================================================
// 5. BP-004.09 — the merge preserves every pre-existing key, including the
//    ones this version has never heard of.
// =========================================================================

test("settings.json merge preserves every pre-existing key, its value and its position", async () => {
  const home = await freshHome("json-preserve");
  const target = await installFixture(home, "settings/rich.json", ".claude/settings.json");
  const original = JSON.parse(await readFile(target, "utf8"));
  const originalKeys = Object.keys(original);
  const fix = jsonFix(makeEnv(home));

  await fix.apply();
  const merged = JSON.parse(await readFile(target, "utf8"));

  for (const key of originalKeys) {
    assert.ok(Object.hasOwn(merged, key), `key ${key} was dropped`);
    assert.deepEqual(merged[key], original[key], `key ${key} was altered`);
  }
  // Order preserved, new key appended last — never reordered.
  assert.deepEqual(Object.keys(merged), [...originalKeys, "autoCompact"]);
  assert.deepEqual(
    merged.aKeyThisCliVersionHasNeverHeardOf,
    { nested: { deep: [1, 2, { x: null }] } },
    "an unrecognised key must survive untouched",
  );
  assert.equal(merged.autoCompact, true);
});

test("a key with a different existing value is reported as a conflict, and undo restores it", async () => {
  const home = await freshHome("json-conflict");
  const target = await installFixture(home, "settings/conflict.json", ".claude/settings.json");
  const before = await readFile(target);
  const fix = jsonFix(makeEnv(home));

  const preview = await fix.preview();
  assert.deepEqual(preview.conflicts, [{ key: "autoCompact", from: false, to: true }]);
  assert.match(preview.diff, /^-\s+"autoCompact": false,$/m);
  assert.match(preview.diff, /^\+\s+"autoCompact": true,$/m);

  const applied = await fix.apply();
  assert.equal(JSON.parse(await readFile(target, "utf8")).autoCompact, true);

  await fix.undo(applied.undoPath);
  assert.equal(hash(await readFile(target)), hash(before));
  assert.equal(JSON.parse(await readFile(target, "utf8")).autoCompact, false);
});

// =========================================================================
// 6. FAIL CLOSED — a half-written CLAUDE.md is the worst outcome in this
//    project, so every unexpected condition must produce NO write at all.
// =========================================================================

test("fail closed: an unparseable settings.json is refused, not rewritten", async () => {
  const home = await freshHome("fail-unparseable");
  const target = await installFixture(home, "settings/broken.json", ".claude/settings.json");
  const before = await readFile(target);
  const fix = jsonFix(makeEnv(home));

  const state = await fix.check();
  assert.equal(state.applied, false);
  assert.equal(state.status, "unknown");
  assert.equal(state.reason, FIX_ERROR_CODES.TARGET_UNPARSEABLE);

  await assert.rejects(() => fix.preview(), { code: FIX_ERROR_CODES.TARGET_UNPARSEABLE });
  await assert.rejects(() => fix.apply(), (error) => {
    assert.ok(error instanceof FixError);
    assert.equal(error.code, FIX_ERROR_CODES.TARGET_UNPARSEABLE);
    assert.match(error.message, /will not rewrite it/);
    return true;
  });
  assert.equal(hash(await readFile(target)), hash(before));
  assert.equal(await exists(path.join(home, ".session-rx")), false, "no transaction may be opened");
});

test("fail closed: valid JSON that is not an object is refused", async () => {
  const home = await freshHome("fail-array");
  const target = await installFixture(home, "settings/array.json", ".claude/settings.json");
  const before = await readFile(target);
  const fix = jsonFix(makeEnv(home));

  assert.equal((await fix.check()).reason, FIX_ERROR_CODES.TARGET_UNPARSEABLE);
  await assert.rejects(() => fix.apply(), { code: FIX_ERROR_CODES.TARGET_UNPARSEABLE });
  assert.equal(hash(await readFile(target)), hash(before));
});

test("an absent target with an existing parent directory is created, not refused (BP-004.11)", async () => {
  // NOTE: this test used to assert the OPPOSITE — that a missing target was
  // always refused, never created. That was the defect: most Claude Code
  // installs have a `~/.claude/` directory (the CLI is installed) but no
  // hand-written CLAUDE.md or settings.json yet, and every fix refused
  // outright, unreachable exactly when it mattered. `freshHome()` below
  // creates `.claude/` but deliberately installs no fixture into it, so this
  // is exactly that case.
  const home = await freshHome("create-parent-exists");
  const env = makeEnv(home);
  const md = mdFix(env);
  const json = jsonFix(env);

  for (const fix of [md, json]) {
    assert.equal(await exists(fix.target), false, "test bug: the fixture must start absent");
    const state = await fix.check();
    assert.equal(state.applied, false);
    assert.equal(state.status, "unknown");
    assert.equal(state.reason, FIX_ERROR_CODES.TARGET_MISSING);

    const preview = await fix.preview();
    assert.equal(preview.targets[0].created, true, `${fix.id}: preview must mark an absent target as created`);

    const applied = await fix.apply();
    assert.equal(applied.applied, true);
    assert.equal(await exists(fix.target), true, `${fix.id}: apply() must create its own target`);
  }
});

test("fail closed: a read-only target is refused before anything is created", async () => {
  const home = await freshHome("fail-readonly");
  const target = await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  const before = await readFile(target);
  await chmod(target, 0o444);
  const fix = mdFix(makeEnv(home));

  // preview still works — the user can see what the fix WOULD do.
  const preview = await fix.preview();
  assert.match(preview.diff, /\+<!-- session-rx:output-hygiene:v1 -->/);

  await assert.rejects(() => fix.apply(), (error) => {
    assert.equal(error.code, FIX_ERROR_CODES.TARGET_UNWRITABLE);
    assert.match(error.message, /is not writable/);
    return true;
  });
  assert.equal(hash(await readFile(target)), hash(before));
  assert.equal(
    await exists(path.join(home, ".session-rx")),
    false,
    "writability must be proven before any undo directory exists",
  );
  await chmod(target, 0o644);
});

test("fail closed: a marker that is present but altered refuses rather than appending again", async () => {
  const home = await freshHome("fail-drift");
  const target = await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  const fix = mdFix(makeEnv(home));
  await fix.apply();

  // The user edits the body of the managed section.
  const edited = (await readFile(target, "utf8")).replace("Keep tool output concise;", "Keep output SHORT;");
  await writeFile(target, edited);
  const driftHash = hash(await readFile(target));

  const state = await fix.check();
  assert.equal(state.applied, true);
  assert.equal(state.drifted, true);
  assert.equal(state.reason, "section-modified");

  await assert.rejects(() => fix.apply(), (error) => {
    assert.equal(error.code, FIX_ERROR_CODES.MARKER_DRIFT);
    assert.match(error.message, /refusing to touch the file/);
    return true;
  });
  assert.equal(hash(await readFile(target)), driftHash, "the user's edit must survive");
});

test("fail closed: a duplicated marker is drift, not an invitation to append a third", async () => {
  const home = await freshHome("fail-duplicate");
  const target = await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  const fix = mdFix(makeEnv(home));
  await fix.apply();
  const doubled = (await readFile(target, "utf8")) + BP_004_02_TEXT;
  await writeFile(target, doubled);

  const state = await fix.check();
  assert.equal(state.drifted, true);
  assert.equal(state.reason, "marker-duplicated");
  assert.equal(state.occurrences, 2);
  await assert.rejects(() => fix.apply(), { code: FIX_ERROR_CODES.MARKER_DRIFT });
  assert.equal(hash(await readFile(target)), hash(Buffer.from(doubled, "utf8")));
});

test("fail closed: a symlinked target is refused so the link itself is never replaced", async () => {
  const home = await freshHome("fail-symlink");
  const outside = path.join(TMP_ROOT, "dotfiles-CLAUDE.md");
  await writeFile(outside, "# lives in a dotfiles repo\n");
  await symlink(outside, path.join(home, ".claude", "CLAUDE.md"));
  const fix = mdFix(makeEnv(home));

  assert.equal((await fix.check()).reason, FIX_ERROR_CODES.TARGET_IS_SYMLINK);
  await assert.rejects(() => fix.preview(), { code: FIX_ERROR_CODES.TARGET_IS_SYMLINK });
  await assert.rejects(() => fix.apply(), (error) => {
    assert.equal(error.code, FIX_ERROR_CODES.TARGET_IS_SYMLINK);
    assert.match(error.message, /will not write through one/);
    return true;
  });
  assert.equal(await readFile(outside, "utf8"), "# lives in a dotfiles repo\n");
});

test("fail closed: a target larger than the fix limit is refused", async () => {
  const home = await freshHome("fail-toobig");
  const target = path.join(home, ".claude", "CLAUDE.md");
  await writeFile(target, Buffer.alloc(MAX_TARGET_BYTES + 1, 0x41));
  const fix = mdFix(makeEnv(home));

  assert.equal((await fix.check()).reason, FIX_ERROR_CODES.TARGET_TOO_LARGE);
  await assert.rejects(() => fix.apply(), { code: FIX_ERROR_CODES.TARGET_TOO_LARGE });
  assert.equal((await readFile(target)).length, MAX_TARGET_BYTES + 1);
});

test("fail closed: a target that is not valid UTF-8 is refused", async () => {
  const home = await freshHome("fail-binary");
  const target = path.join(home, ".claude", "CLAUDE.md");
  await writeFile(target, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  const before = await readFile(target);
  const fix = mdFix(makeEnv(home));

  const state = await fix.check();
  assert.equal(state.reason, FIX_ERROR_CODES.TARGET_UNREADABLE);
  await assert.rejects(() => fix.apply(), { code: FIX_ERROR_CODES.TARGET_UNREADABLE });
  assert.equal(hash(await readFile(target)), hash(before));
});

// =========================================================================
// 7. FVA-007 — the journal, and undo refusing to clobber a later edit.
// =========================================================================

test("undo refuses when the file changed after apply, and the later edit survives", async () => {
  const home = await freshHome("journal-mismatch");
  const target = await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  const env = makeEnv(home);
  const fix = mdFix(env);
  const applied = await fix.apply();

  // The user edits the file themselves after the fix landed.
  const external = `${await readFile(target, "utf8")}\n## a later note of the user's own\n`;
  await writeFile(target, external);
  const externalHash = hash(Buffer.from(external, "utf8"));

  await assert.rejects(() => fix.undo(applied.undoPath), (error) => {
    assert.ok(error instanceof FixError);
    assert.equal(error.code, FIX_ERROR_CODES.EXTERNAL_EDIT);
    assert.match(error.message, /changed after the fix was applied/);
    assert.match(error.message, /Refusing to undo/);
    assert.equal(error.details.expectedHash, applied.targets[0].hashAfter);
    assert.equal(error.details.actualHash, `sha256:${externalHash}`);
    assert.equal(error.details.reason, "content-changed");
    assert.ok(error.details.backup.startsWith(applied.undoPath));
    return true;
  });

  assert.equal(hash(await readFile(target)), externalHash, "the user's later edit must survive undo");
  const [transaction] = await listTransactions(env, { fixId: fix.id });
  assert.equal(transaction.status, "applied", "a refused undo must not mark the record undone");
  // The refusal named a backup that really does hold the prior bytes.
  assert.equal(
    hash(await readFile(transaction.targets[0].backup)),
    hash(await readFile(path.join(FIXTURES, "claude-md", "lf.md"))),
  );
});

test("undo refuses when the target has been moved away since apply", async () => {
  const home = await freshHome("journal-moved");
  const target = await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  const env = makeEnv(home);
  const fix = mdFix(env);
  const applied = await fix.apply();
  await rename(target, path.join(home, "CLAUDE.md.moved"));

  await assert.rejects(() => fix.undo(applied.undoPath), (error) => {
    assert.equal(error.code, FIX_ERROR_CODES.EXTERNAL_EDIT);
    assert.equal(error.details.reason, "target-missing");
    return true;
  });
  assert.equal(await exists(target), false, "a refused undo must not recreate the file");
});

test("the journal records a hash before and after for every apply and undo", async () => {
  const home = await freshHome("journal-records");
  const target = await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  const beforeHash = hash(await readFile(target));
  const env = makeEnv(home);
  const fix = mdFix(env);

  const applied = await fix.apply();
  const afterHash = hash(await readFile(target));
  await fix.undo(applied.undoPath);

  const journal = await readJournal(env);
  assert.equal(journal.length, 2);
  assert.equal(journal[0].event, "apply");
  assert.equal(journal[0].fixId, fix.id);
  assert.equal(journal[0].targets[0].hashBefore, `sha256:${beforeHash}`);
  assert.equal(journal[0].targets[0].hashAfter, `sha256:${afterHash}`);
  assert.equal(journal[1].event, "undo");
  assert.equal(journal[1].targets[0].restoredHash, `sha256:${beforeHash}`);

  const [transaction] = await listTransactions(env, { fixId: fix.id });
  assert.equal(transaction.status, "undone");
  assert.ok(transaction.undoneAt);
  assert.equal(transaction.targets[0].hashBefore, `sha256:${beforeHash}`);
  assert.equal(transaction.targets[0].hashAfter, `sha256:${afterHash}`);

  // BP-004.07: the backup really is a byte-for-byte copy of the prior file.
  assert.equal(hash(await readFile(transaction.targets[0].backup)), beforeHash);
  await assert.rejects(() => fix.undo(applied.undoPath), { code: FIX_ERROR_CODES.ALREADY_UNDONE });
});

test("undoTransaction refuses a missing, corrupt, foreign or out-of-tree record", async () => {
  const home = await freshHome("undo-records");
  const target = await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  const env = makeEnv(home);
  const fix = mdFix(env);
  const applied = await fix.apply();

  await assert.rejects(
    () => undoTransaction(path.join(env.undoRoot, "1999-01-01T00-00-00-000Z"), { env }),
    { code: FIX_ERROR_CODES.UNDO_RECORD_MISSING },
  );
  await assert.rejects(
    () => undoTransaction(path.join(home, ".claude"), { env }),
    { code: FIX_ERROR_CODES.PATH_ESCAPE },
  );
  await assert.rejects(
    () => undoTransaction(env.undoRoot, { env }),
    { code: FIX_ERROR_CODES.PATH_ESCAPE },
  );
  await assert.rejects(
    () => undoTransaction(applied.undoPath, { env, expectFixId: "some-other-fix" }),
    { code: FIX_ERROR_CODES.UNDO_RECORD_CORRUPT },
  );

  // A corrupt record is refused rather than half-read.
  const corruptHome = await freshHome("undo-corrupt");
  await installFixture(corruptHome, "claude-md/lf.md", ".claude/CLAUDE.md");
  const corruptEnv = makeEnv(corruptHome);
  const corruptFix = mdFix(corruptEnv);
  const corruptApplied = await corruptFix.apply();
  await writeFile(path.join(corruptApplied.undoPath, "transaction.json"), "{ not json");
  await assert.rejects(
    () => corruptFix.undo(corruptApplied.undoPath),
    { code: FIX_ERROR_CODES.UNDO_RECORD_CORRUPT },
  );

  // A backup that no longer matches its recorded hash is refused too.
  const tamperHome = await freshHome("undo-tampered");
  await installFixture(tamperHome, "claude-md/lf.md", ".claude/CLAUDE.md");
  const tamperEnv = makeEnv(tamperHome);
  const tamperFix = mdFix(tamperEnv);
  const tamperApplied = await tamperFix.apply();
  const [record] = await listTransactions(tamperEnv, { fixId: tamperFix.id });
  await writeFile(record.targets[0].backup, "# tampered backup\n");
  await assert.rejects(
    () => tamperFix.undo(tamperApplied.undoPath),
    (error) => {
      assert.equal(error.code, FIX_ERROR_CODES.UNDO_RECORD_CORRUPT);
      assert.match(error.message, /hashes sha256:/);
      return true;
    },
  );
  assert.equal((await tamperFix.check()).applied, true, "the target is left as apply() left it");

  // undo() with no argument finds the newest applied transaction for the fix.
  const restored = await fix.undo();
  assert.equal(restored.undoPath, applied.undoPath);
  await assert.rejects(() => fix.undo(), { code: FIX_ERROR_CODES.UNDO_RECORD_MISSING });
  assert.equal(await exists(target), true);
});

// =========================================================================
// 8. A habit recommendation is structurally unable to write (BP-004).
// =========================================================================

test("a display-only habit recommendation exposes no apply path at all", async () => {
  const recommendation = new HabitRecommendation({
    id: "habit-ask-for-a-plan",
    title: "Ask for a plan before a long task",
    description: "Sessions that state the plan first spend less on re-derivation.",
    rationale: "Observed across the sessions in this report.",
    steps: ["Say what done looks like", "Ask for the file list before the edit"],
  });

  assert.equal(recommendation.applyable, false);
  assert.equal(recommendation.kind, "recommendation");
  assert.equal("apply" in recommendation, false, "no apply anywhere on the prototype chain");
  assert.equal("undo" in recommendation, false, "no undo anywhere on the prototype chain");
  assert.equal("computeTargets" in recommendation, false);
  assert.equal(recommendation instanceof WritableFix, false);
  assert.ok(recommendation instanceof FixBase);

  const preview = await recommendation.preview();
  assert.equal(preview.diff, "");
  assert.deepEqual(preview.files_affected, []);
  assert.equal(preview.applyable, false);
  assert.equal(preview.reversible, false);
  assert.deepEqual(preview.steps, ["Say what done looks like", "Ask for the file list before the edit"]);
  assert.equal((await recommendation.check()).status, "unknown");
  assert.equal((await recommendation.check()).reason, "display-only");
  assert.deepEqual(recommendation.describe().files_affected, []);

  // And one cannot be bolted on: instance and both prototypes are frozen.
  assert.ok(Object.isFrozen(recommendation));
  assert.ok(Object.isFrozen(HabitRecommendation.prototype));
  assert.ok(Object.isFrozen(FixBase.prototype));
  assert.throws(() => {
    recommendation.apply = async () => ({ applied: true });
  }, TypeError);
  assert.throws(() => {
    HabitRecommendation.prototype.apply = async () => ({ applied: true });
  }, TypeError);
  assert.throws(() => {
    FixBase.prototype.apply = async () => ({ applied: true });
  }, TypeError);
  assert.equal("apply" in recommendation, false);
});

// =========================================================================
// 9. Path traversal and spec validation.
// =========================================================================

test("a target that escapes the configured home is rejected at construction", async () => {
  const home = await freshHome("traversal");
  const env = makeEnv(home);
  const escapes = [
    "../escape/CLAUDE.md",
    "../../CLAUDE.md",
    ".claude/../../outside.md",
    "/etc/hosts",
    path.join(home, "..", "outside.md"),
    ".",
    "./",
  ];
  for (const target of escapes) {
    assert.throws(
      () => mdFix(env, { target }),
      (error) => {
        assert.ok(error instanceof FixError, `${target} threw ${error}`);
        assert.equal(error.code, FIX_ERROR_CODES.PATH_ESCAPE, `${target} was not refused as traversal`);
        return true;
      },
      `target ${target} must be refused`,
    );
  }
  assert.throws(() => mdFix(env, { target: ".claude/CLA UDE.md" }), { code: FIX_ERROR_CODES.PATH_ESCAPE });
  assert.throws(() => mdFix(env, { target: "" }), { code: FIX_ERROR_CODES.SPEC_INVALID });
  assert.throws(() => mdFix(env, { target: undefined }), { code: FIX_ERROR_CODES.SPEC_INVALID });

  // A path that merely LOOKS like traversal but resolves inside home is fine.
  const inside = mdFix(env, { target: ".claude/../.claude/CLAUDE.md" });
  assert.equal(inside.target, path.join(home, ".claude", "CLAUDE.md"));
  const absolute = mdFix(env, { target: path.join(home, ".claude", "CLAUDE.md") });
  assert.equal(absolute.target, inside.target);
  assert.equal(absolute.display, path.join("~", ".claude", "CLAUDE.md"));
});

test("spec validation rejects a fix that could not work", async () => {
  const home = await freshHome("spec");
  const env = makeEnv(home);
  assert.deepEqual(FIX_KINDS, ["append-section", "json-merge", "recommendation"]);
  assert.throws(() => new FixBase({ id: "x", kind: "invented", env }), { code: FIX_ERROR_CODES.SPEC_INVALID });
  assert.throws(() => new FixBase({ kind: "recommendation", env }), { code: FIX_ERROR_CODES.SPEC_INVALID });
  assert.throws(() => jsonFix(env, { merge: {} }), { code: FIX_ERROR_CODES.SPEC_INVALID });
  assert.throws(() => jsonFix(env, { merge: ["autoCompact"] }), { code: FIX_ERROR_CODES.SPEC_INVALID });

  // WritableFix itself is a base: it refuses to act without a kind's planner.
  const bare = new WritableFix({ id: "bare", kind: "append-section", target: ".claude/CLAUDE.md", env });
  await assert.rejects(() => bare.preview(), (error) => {
    assert.equal(error.code, FIX_ERROR_CODES.SPEC_INVALID);
    assert.match(error.message, /computeTargets\(\) must be implemented/);
    return true;
  });
  await assert.rejects(() => bare.apply(), { code: FIX_ERROR_CODES.SPEC_INVALID });
});

// =========================================================================
// 10. Helpers and defaults.
// =========================================================================

test("helpers behave as the fix kinds assume", () => {
  assert.equal(sha256Hex(Buffer.from("abc")), `sha256:${hash(Buffer.from("abc"))}`);
  assert.equal(sha256Hex("abc"), `sha256:${hash(Buffer.from("abc"))}`);
  assert.equal(detectEol("a\r\nb\r\n"), "\r\n");
  assert.equal(detectEol("a\nb\n"), "\n");
  assert.equal(detectEol(""), "\n");
  assert.equal(detectEol("a\r\nb\nc\n"), "\n", "mixed with more LF than CRLF stays LF");
  assert.equal(endsWithNewline("a\n"), true);
  assert.equal(endsWithNewline("a\r\n"), true);
  assert.equal(endsWithNewline("a"), false);
  assert.equal(unifiedDiff("~/x", "same\n", "same\n"), "");
  const diff = unifiedDiff("~/x", "a\n", "a\nb");
  assert.match(diff, /^\+b\n\\ No newline at end of file$/m);
});

test("the default environment points at the real home but is never used for IO here", () => {
  const fallback = createFixEnvironment();
  assert.equal(fallback.home, path.resolve(os.homedir()));
  assert.equal(fallback.stateDir, path.join(path.resolve(os.homedir()), ".session-rx"));
  assert.equal(fallback.undoRoot, path.join(fallback.stateDir, "undo"));
  assert.equal(fallback.journalPath, path.join(fallback.stateDir, "journal.jsonl"));
  assert.equal(fallback.display(path.join(os.homedir(), ".claude", "CLAUDE.md")), "~/.claude/CLAUDE.md");
  assert.equal(fallback.display("/elsewhere/file"), "/elsewhere/file");
  // Every fix in this suite goes through makeEnv, which refuses a home outside
  // the temp root, so nothing above this line can reach the real file.
  assert.throws(
    () => makeEnv(os.homedir()),
    /not inside the temp root/,
    "makeEnv must refuse the real home",
  );
});

test("a fix catalogue entry can be rendered without reading any file", () => {
  const env = createFixEnvironment({ home: path.join(TMP_ROOT, "describe") });
  const fix = mdFix(env);
  assert.deepEqual(fix.describe(), {
    id: "claude-output-hygiene",
    kind: "append-section",
    title: "Bound tool output",
    description: `Append the delimited "SessionRx: output hygiene" section to ${path.join("~", ".claude", "CLAUDE.md")}. `
      + "Existing content is not modified, reordered or reformatted.",
    rationale: "Unbounded tool output is the single largest avoidable context cost.",
    ruleId: "BP-003.05",
    applyable: true,
    files_affected: [path.join(TMP_ROOT, "describe", ".claude", "CLAUDE.md")],
  });
  assert.equal(jsonFix(env).describe().applyable, true);
  assert.match(jsonFix(env).describe().description, /^Merge "autoCompact" into/);
});

// =========================================================================
// 12. Contracts wave 5A depends on, and the branches nothing above reaches.
// =========================================================================

test("every check() status is one of the FVA-006 triad, with a reason", async () => {
  const home = await freshHome("statuses");
  const env = makeEnv(home);
  const md = mdFix(env);
  const json = jsonFix(env);
  const recommendation = new HabitRecommendation({ id: "habit-x", title: "x" });

  // missing target -> unknown; then applied; then not-applied after undo.
  const seen = [];
  seen.push(await md.check());
  seen.push(await json.check());
  seen.push(await recommendation.check());
  await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  seen.push(await md.check());
  const applied = await md.apply();
  seen.push(await md.check());
  await md.undo(applied.undoPath);
  seen.push(await md.check());

  assert.deepEqual(FIX_CHECK_STATUSES, ["applied", "not-applied", "unknown"]);
  for (const state of seen) {
    assert.ok(FIX_CHECK_STATUSES.includes(state.status), `unknown status ${state.status}`);
    assert.equal(typeof state.reason, "string", "every status carries a visible reason");
    assert.equal(typeof state.applied, "boolean");
  }
  assert.deepEqual(seen.map((s) => s.status), [
    "unknown", "unknown", "unknown", "not-applied", "applied", "not-applied",
  ]);
});

test("a FixError serializes for the API without leaking file content", async () => {
  const home = await freshHome("error-json");
  await installFixture(home, "settings/broken.json", ".claude/settings.json");
  const fix = jsonFix(makeEnv(home));

  const error = await fix.apply().then(() => null, (caught) => caught);
  assert.ok(error instanceof FixError);
  const payload = JSON.parse(JSON.stringify(error));
  assert.equal(payload.error, FIX_ERROR_CODES.TARGET_UNPARSEABLE);
  assert.equal(typeof payload.message, "string");
  assert.equal(payload.details.path, path.join(home, ".claude", "settings.json"));
  assert.deepEqual(Object.keys(payload).sort(), ["details", "error", "message"]);
});

test("two applies in the same millisecond get distinct undo directories", async () => {
  const home = await freshHome("clock");
  await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  await installFixture(home, "settings/rich.json", ".claude/settings.json");
  const frozen = new Date("2026-09-20T12:34:56.789Z");
  const env = makeEnv(home, { now: () => frozen });

  const first = await mdFix(env).apply();
  const second = await jsonFix(env).apply();
  assert.equal(path.basename(first.undoPath), "2026-09-20T12-34-56-789Z");
  assert.equal(path.basename(second.undoPath), "2026-09-20T12-34-56-789Z-2");
  assert.notEqual(first.undoPath, second.undoPath);

  const journal = await readJournal(env);
  assert.deepEqual(journal.map((entry) => entry.ts), [frozen.toISOString(), frozen.toISOString()]);
  assert.deepEqual(
    (await listTransactions(env)).map((record) => record.fixId),
    ["claude-auto-compact", "claude-output-hygiene"],
    "transactions list newest first",
  );
});

test("unifiedDiff degrades to a block replace instead of hanging on huge inputs", () => {
  const before = `${Array.from({ length: 2100 }, (_, i) => `left ${i}`).join("\n")}\n`;
  const after = `${Array.from({ length: 2100 }, (_, i) => `right ${i}`).join("\n")}\n`;
  const diff = unifiedDiff("~/big.md", before, after);
  const lines = diff.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("-left ")).length, 2100);
  assert.equal(lines.filter((l) => l.startsWith("+right ")).length, 2100);
  assert.equal(lines.filter((l) => l.startsWith("@@")).length, 1);
});

// =========================================================================
// 13. BP-004.11 — an absent target is CREATED when its parent directory
//    exists, and undo of a created target DELETES it rather than leaving an
//    empty stub. This is the fix for the "SessionRx refuses on a fresh
//    machine because ~/.claude/CLAUDE.md was never hand-written" defect.
// =========================================================================

test("T1: AppendSectionFix preview on an absent target discloses creation with a /dev/null diff", async () => {
  const home = await freshHome("create-md-preview");
  const env = makeEnv(home);
  const fix = mdFix(env);

  assert.equal(await exists(fix.target), false);
  const preview = await fix.preview();
  assert.equal(preview.targets.length, 1);
  assert.equal(preview.targets[0].created, true);
  assert.equal(preview.targets[0].bytesBefore, 0);
  assert.match(preview.description, /does not exist yet/, "the description must say the file is absent");
  assert.match(preview.description, /will create it/, "the description must say SessionRx will create it");
  assert.match(preview.diff, /^--- \/dev\/null\n/, "an absent target must render a creation diff");
  assert.match(preview.diff, /^\+<!-- session-rx:output-hygiene:v1 -->$/m);
  // preview() alone must write nothing.
  assert.equal(await exists(fix.target), false);
  assert.equal(await exists(path.join(home, ".session-rx")), false);
});

test("T2: AppendSectionFix apply creates the file with exactly the section, and check() reports applied", async () => {
  const home = await freshHome("create-md-apply");
  const env = makeEnv(home);
  const fix = mdFix(env);

  const applied = await fix.apply();
  assert.equal(applied.applied, true);
  const bytes = await readFile(fix.target);
  assert.equal(
    bytes.toString("utf8"),
    BP_004_02_TEXT,
    "a created file must hold exactly the delimited section — no invented header or title",
  );

  const state = await fix.check();
  assert.equal(state.applied, true);
  assert.equal(state.status, "applied");
  assert.equal(state.drifted, false);
});

test("T3: undo of a created AppendSectionFix target removes the file entirely", async () => {
  const home = await freshHome("create-md-undo");
  const env = makeEnv(home);
  const fix = mdFix(env);

  const applied = await fix.apply();
  assert.equal(await exists(fix.target), true);

  const undone = await fix.undo(applied.undoPath);
  assert.equal(undone.restored, true);
  assert.equal(await exists(fix.target), false, "undo of a created file must remove it, not leave an empty stub");
  const state = await fix.check();
  assert.equal(state.status, "unknown");
  assert.equal(state.reason, FIX_ERROR_CODES.TARGET_MISSING);
});

test("T4: undoing a created target twice is refused", async () => {
  const home = await freshHome("create-md-undo-twice");
  const env = makeEnv(home);
  const fix = mdFix(env);
  const applied = await fix.apply();

  await fix.undo(applied.undoPath);
  assert.equal(await exists(fix.target), false);
  await assert.rejects(() => fix.undo(applied.undoPath), { code: FIX_ERROR_CODES.ALREADY_UNDONE });
  assert.equal(await exists(fix.target), false, "a refused second undo must not recreate the file");
});

test("T5: JsonMergeFix on an absent target creates valid JSON holding exactly the merged key", async () => {
  const home = await freshHome("create-json-apply");
  const env = makeEnv(home);
  const fix = jsonFix(env);

  assert.equal(await exists(fix.target), false);
  const preview = await fix.preview();
  assert.equal(preview.targets[0].created, true);
  assert.match(preview.diff, /^--- \/dev\/null\n/);
  assert.match(preview.diff, /^\+ {2}"autoCompact": true$/m);

  const applied = await fix.apply();
  assert.equal(applied.applied, true);
  const text = await readFile(fix.target, "utf8");
  assert.equal(
    text,
    `${JSON.stringify({ autoCompact: true }, null, 2)}\n`,
    "a created settings file holds exactly the merged key, two-space indented, with a trailing newline",
  );
  assert.deepEqual(JSON.parse(text), { autoCompact: true });
  assert.equal((await fix.check()).applied, true);
});

test("T6: undo of a created JsonMergeFix target removes the file entirely", async () => {
  const home = await freshHome("create-json-undo");
  const env = makeEnv(home);
  const fix = jsonFix(env);

  const applied = await fix.apply();
  assert.equal(await exists(fix.target), true);

  const undone = await fix.undo(applied.undoPath);
  assert.equal(undone.restored, true);
  assert.equal(await exists(fix.target), false, "undo of a created settings file must remove it");
  assert.equal((await fix.check()).status, "unknown");
});

test("T7: an absent parent directory is still refused, naming the missing directory", async () => {
  // Deliberately NOT freshHome() — that helper pre-creates `.claude/`, which
  // is exactly the case T1-T6 cover. Here `.claude/` itself does not exist,
  // as if the CLI it belongs to were never installed.
  const home = path.join(TMP_ROOT, "no-parent-dir");
  assert.ok(home.startsWith(TMP_ROOT + path.sep), "test bug: home must be inside the temp root");
  await mkdir(home, { recursive: true });
  const env = makeEnv(home);
  const claudeDir = path.join(home, ".claude");
  assert.equal(await exists(claudeDir), false, "test bug: .claude must not exist for this case");

  for (const fix of [mdFix(env), jsonFix(env)]) {
    const state = await fix.check();
    assert.equal(state.status, "unknown");
    assert.equal(state.reason, FIX_ERROR_CODES.TARGET_MISSING);

    await assert.rejects(() => fix.preview(), (error) => {
      assert.equal(error.code, FIX_ERROR_CODES.TARGET_MISSING);
      assert.match(error.message, /\.claude/, "the error must name the missing directory");
      assert.match(error.message, /does not exist/);
      return true;
    });
    await assert.rejects(() => fix.apply(), { code: FIX_ERROR_CODES.TARGET_MISSING });
    assert.equal(await exists(fix.target), false, "no file may be created without its parent directory");
    assert.equal(await exists(claudeDir), false, "SessionRx must not fabricate the parent directory either");
  }
  assert.equal(await exists(path.join(home, ".session-rx")), false);
});

test("T8 REGRESSION: an existing target is still appended to, prior bytes preserved, undo byte-identical", async () => {
  const home = await freshHome("regression-existing-md");
  const target = await installFixture(home, "claude-md/lf.md", ".claude/CLAUDE.md");
  const before = await readFile(target);
  const env = makeEnv(home);
  const fix = mdFix(env);

  const preview = await fix.preview();
  assert.equal(preview.targets[0].created, false, "an existing file must never be reported as created");
  assert.equal(
    preview.diff.startsWith("--- /dev/null"),
    false,
    "an existing file's diff must not be rendered as a creation",
  );

  const applied = await fix.apply();
  const after = await readFile(target);
  assert.ok(after.subarray(0, before.length).equals(before), "prior bytes must be an exact prefix, byte-for-byte");
  assert.equal(after.subarray(before.length).toString("utf8"), BP_004_02_TEXT);

  await fix.undo(applied.undoPath);
  assert.equal(hash(await readFile(target)), hash(before), "undo must restore the existing file byte-identically");
  assert.equal(await exists(target), true, "undo of an EXISTING file's fix must never delete the file");
});

test("T9 REGRESSION: an existing settings.json keeps its other keys after merge, never reported as created", async () => {
  const home = await freshHome("regression-existing-json");
  const target = await installFixture(home, "settings/rich.json", ".claude/settings.json");
  const original = JSON.parse(await readFile(target, "utf8"));
  const fix = jsonFix(makeEnv(home));

  const preview = await fix.preview();
  assert.equal(preview.targets[0].created, false);

  await fix.apply();
  const merged = JSON.parse(await readFile(target, "utf8"));
  for (const key of Object.keys(original)) {
    assert.ok(Object.hasOwn(merged, key), `key ${key} was dropped`);
    assert.deepEqual(merged[key], original[key], `key ${key} was altered`);
  }
  assert.equal(merged.autoCompact, true);
});

// =========================================================================
// 11. The real files this whole suite exists to protect.
// =========================================================================

test("the real ~/.claude/CLAUDE.md and ~/.claude/settings.json were never touched", async () => {
  const after = await snapshotRealFiles();
  assert.deepEqual(
    after,
    REAL_BEFORE,
    "A real config file changed during this run. Every fix here is built with an injected "
    + `temp home under ${TMP_ROOT}, so the suite has no path to these files; if this fails, `
    + "either the injection was bypassed or something outside the test suite wrote them.",
  );
});
