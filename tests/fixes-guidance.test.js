/**
 * Wave 4C — the three Claude guidance fixes: `claude-batch-commands`
 * (BP-004.03), `claude-worker-cap` (BP-004.04) and `claude-compact-contract`
 * (BP-004.05).
 *
 * REAL-FILE SAFETY, stated once because it shapes the whole suite:
 *
 *   Every fix here is built through `makeEnv()`, which REFUSES any home that is
 *   not inside this run's `mkdtemp` root.  The engine derives every path it
 *   reads or writes from `env.home` (src/fixes/base.js `createFixEnvironment`),
 *   so a fix built here cannot name the developer's real `~/.claude/CLAUDE.md`
 *   even by accident — the default `target` is the RELATIVE
 *   `.claude/CLAUDE.md`, resolved against the injected home.  A test asserting
 *   `makeEnv(os.homedir())` throws proves the chokepoint is load-bearing.
 *   Belt and braces: the real `~/.claude/CLAUDE.md`, `~/.claude/settings.json`
 *   and the presence of `~/.session-rx` are captured before the suite runs and
 *   re-checked in the last test.
 *
 * The exact appended text is pinned against GOLDEN FILES
 * (`tests/fixtures/fixes/4c/expected/*.section.md`) rather than re-typed here:
 * a golden file is byte-exact AND readable, so a reviewer can judge the wording
 * a user's CLAUDE.md receives, and changing one word fails this suite until the
 * golden is deliberately updated.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIX_ERROR_CODES,
  FixError,
  HabitRecommendation,
  WritableFix,
  buildDelimitedSection,
  createFixEnvironment,
  listTransactions,
  unifiedDiff,
} from "../src/fixes/base.js";
import * as batchCommands from "../src/fixes/claude/batch-commands.js";
import * as compactContract from "../src/fixes/claude/compact-contract.js";
import * as workerCap from "../src/fixes/claude/worker-cap.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "fixes", "4c");
const GOLDEN = path.join(FIXTURES, "expected");

/** Hashed with node:crypto directly, never with the module under test. */
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function countOf(text, needle) {
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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
  out[path.join(REAL_HOME, ".session-rx")] = await exists(path.join(REAL_HOME, ".session-rx"))
    ? "present"
    : "absent";
  return out;
}

const REAL_BEFORE = await snapshotRealFiles();

// --- temp homes -----------------------------------------------------------
const TMP_ROOT = await mkdtemp(path.join(os.tmpdir(), "session-rx-4c-"));

/** The single chokepoint for fix construction in this suite. */
function makeEnv(home, options = {}) {
  assert.ok(
    home.startsWith(TMP_ROOT + path.sep),
    `test bug: ${home} is not inside the temp root ${TMP_ROOT}`,
  );
  return createFixEnvironment({ home, ...options });
}

let homeSeq = 0;
async function freshHome(label) {
  homeSeq += 1;
  const home = path.join(TMP_ROOT, `${String(homeSeq).padStart(3, "0")}-${label}`);
  await mkdir(path.join(home, ".claude"), { recursive: true });
  return home;
}

/** Fixtures are copied in; nothing in this suite writes into tests/fixtures. */
async function installClaudeMd(home, fixture) {
  const target = path.join(home, ".claude", "CLAUDE.md");
  await copyFile(path.join(FIXTURES, fixture), target);
  return target;
}

async function golden(slug) {
  return (await readFile(path.join(GOLDEN, `${slug}.section.md`))).toString("utf8");
}

// --- the three fixes under test ------------------------------------------
// Marker, heading, target, rule id and blueprint sentence are quoted from
// docs/BLUEPRINT.md BP-004.03/.04/.05 VERBATIM. A change in a fix module that
// drifts from the blueprint fails here rather than shipping.
const FIXES = [
  {
    slug: "batch-commands",
    mod: batchCommands,
    Fix: batchCommands.BatchCommandsFix,
    factory: (options) => batchCommands.createBatchCommandsFix(options),
    fixId: "claude-batch-commands",
    marker: "session-rx:batch-commands:v1",
    heading: "SessionRx: batch commands",
    ruleId: "repeat-tool",
    blueprintId: "BP-004.03",
    blueprintSentence:
      "Batch independent read-only commands when safe; avoid repeating identical tool calls and reuse verified results.",
    mustSay: [
      "One question, one call.",
      "Do not re-run a call whose answer is already in context.",
      "name what changed since the last run",
      "Five identical calls returning the same result in one session",
    ],
  },
  {
    slug: "worker-cap",
    mod: workerCap,
    Fix: workerCap.WorkerCapFix,
    factory: (options) => workerCap.createWorkerCapFix(options),
    fixId: "claude-worker-cap",
    marker: "session-rx:worker-cap:v1",
    heading: "SessionRx: worker cap",
    ruleId: "subagent-concurrency",
    blueprintId: "BP-004.04",
    blueprintSentence:
      "Keep concurrent sub-agents at or below half of the dispatched worker count unless a deliberate exception is documented.",
    mustSay: [
      "At most 3 sub-agents run at the same time",
      "never more than half of what the task dispatches in total",
      "Keep it under 6,000 characters.",
      "One written report, read once.",
    ],
  },
  {
    slug: "compact-contract",
    mod: compactContract,
    Fix: compactContract.CompactContractFix,
    factory: (options) => compactContract.createCompactContractFix(options),
    fixId: "claude-compact-contract",
    marker: "session-rx:compact-contract:v1",
    heading: "SessionRx: compact contract",
    ruleId: "long-rising-context",
    blueprintId: "BP-004.05",
    blueprintSentence:
      "When context pressure rises, compact deliberately: preserve active requirements, decisions, unresolved risks, and exact file paths before continuing.",
    mustSay: [
      "PRESERVE, verbatim.",
      "the exact command that runs the tests or the build, and its last exit code",
      "every file path created or modified in this session",
      "every question waiting on the user",
      "tool output bodies",
      "Do not continue on a guess",
    ],
  },
];

const openOf = (marker) => `<!-- ${marker} -->`;
const closeOf = (marker) => `<!-- /${marker} -->`;

// =========================================================================
// 1. The contract each fix declares, and the exact text it appends.
// =========================================================================

for (const f of FIXES) {
  test(`${f.slug}: declares the BP-004 id, marker, heading, target and rule it answers`, async () => {
    const home = await freshHome(`${f.slug}-declares`);
    await installClaudeMd(home, "lf.md");
    const fix = f.factory({ env: makeEnv(home) });

    assert.equal(fix.id, f.fixId);
    assert.equal(f.mod.FIX_ID, f.fixId);
    assert.equal(fix.marker, f.marker, "the idempotency marker must be the blueprint's, verbatim");
    assert.equal(f.mod.MARKER, f.marker);
    assert.equal(fix.heading, f.heading);
    assert.equal(f.mod.HEADING, f.heading);
    assert.equal(f.mod.TARGET, ".claude/CLAUDE.md");
    assert.equal(fix.ruleId, f.ruleId, "the fix must carry the rule id it answers");
    assert.equal(fix.blueprintId, f.blueprintId);
    assert.equal(fix.kind, "append-section");

    // A stable marker carries no timestamp, pid, version-of-the-day or any
    // other per-construction value: `check()` on a LATER run has to recognise
    // a section written by an EARLIER one.
    const again = f.factory({ env: makeEnv(home) });
    assert.equal(again.marker, fix.marker, "the marker must be stable across constructions");
    assert.match(fix.marker, /^session-rx:[a-z-]+:v1$/);

    // One human-readable line, and the rationale names the measured rule.
    assert.ok(fix.descriptionText.length > 40, "the description must say what the fix does");
    assert.equal(fix.descriptionText.includes("\n"), false, "the description is one line");
    assert.ok(fix.rationale.includes(f.ruleId), "the rationale must cite the rule it answers");

    const described = fix.describe();
    assert.equal(described.id, f.fixId);
    assert.equal(described.ruleId, f.ruleId);
    assert.equal(described.applyable, true);
    assert.deepEqual(described.files_affected, [path.join(home, ".claude", "CLAUDE.md")]);
  });

  test(`${f.slug}: appends exactly the golden section, and carries BP-004's sentence verbatim`, async () => {
    const expected = await golden(f.slug);
    const built = buildDelimitedSection({
      marker: f.mod.MARKER,
      heading: f.mod.HEADING,
      body: f.mod.BODY,
    });
    assert.equal(built, expected, `${f.slug}.section.md no longer matches the fix module`);

    // Structure: a leading blank line, one open marker, the heading, one close.
    assert.ok(expected.startsWith(`\n${openOf(f.marker)}\n## ${f.heading}\n`));
    assert.ok(expected.endsWith(`\n${closeOf(f.marker)}\n`));
    assert.equal(countOf(expected, openOf(f.marker)), 1);
    assert.equal(countOf(expected, closeOf(f.marker)), 1);
    assert.equal(expected.includes("\r"), false, "the canonical section is LF; EOL is the file's own");

    // BP-004.03/.04/.05's appended text is the body's FIRST line, verbatim, so
    // the blueprint sentence is traceable in what the user actually receives.
    assert.equal(f.mod.BODY.split("\n")[0], f.blueprintSentence);

    // The wording that makes the rule followable. A vague rewrite fails here
    // even if the golden file were regenerated.
    for (const phrase of f.mustSay) {
      assert.ok(f.mod.BODY.includes(phrase), `${f.slug} body must say: ${phrase}`);
    }
    // Text that changes no behaviour is not allowed to creep in.
    for (const banned of ["be efficient", "use tokens wisely", "avoid redundancy", "as appropriate"]) {
      assert.equal(
        f.mod.BODY.toLowerCase().includes(banned),
        false,
        `${f.slug} body contains unactionable filler: ${banned}`,
      );
    }
  });
}

test("every wave-4C fix is a real write fix, and a display-only fix has no apply path at all", async () => {
  const home = await freshHome("kinds");
  await installClaudeMd(home, "lf.md");
  const env = makeEnv(home);
  for (const f of FIXES) {
    const fix = f.factory({ env });
    assert.ok(fix instanceof WritableFix, `${f.slug} must be a writable fix`);
    assert.equal(fix instanceof HabitRecommendation, false);
    assert.equal(fix.applyable, true);
    assert.equal(typeof fix.apply, "function");
    const preview = await fix.preview();
    assert.equal(preview.reversible, true, "BP-004: reversible is always true");
    assert.equal(preview.applyable, true);
    assert.equal(preview.kind, "append-section");
  }

  // None of the three is display-only (see R_4C §"HabitRecommendation"), but
  // the guarantee the brief asks about is a property of the KIND, so it is
  // asserted here: a recommendation cannot write, it does not merely decline to.
  const rec = new HabitRecommendation({
    id: "habit-probe",
    title: "probe",
    description: "a display-only fix used to prove there is no write path",
    steps: ["nothing to apply"],
  });
  assert.equal("apply" in rec, false);
  assert.equal("undo" in rec, false);
  assert.equal(rec.applyable, false);
  assert.equal(rec instanceof WritableFix, false);
  const recPreview = await rec.preview();
  assert.equal(recPreview.applyable, false);
  assert.equal(recPreview.diff, "");
  assert.deepEqual(recPreview.files_affected, []);
  assert.throws(() => {
    rec.apply = async () => ({ applied: true });
  }, TypeError);
});

// =========================================================================
// 2. preview() cannot lie, and the append is a literal suffix (BP-004.06/.08).
// =========================================================================

for (const f of FIXES) {
  for (const fixture of ["lf.md", "crlf.md", "no-trailing-newline.md"]) {
    test(`${f.slug} on ${fixture}: the on-disk delta equals the previewed diff, byte for byte`, async () => {
      const home = await freshHome(`${f.slug}-${fixture.replace(/\W+/g, "-")}`);
      const target = await installClaudeMd(home, fixture);
      const env = makeEnv(home);
      const fix = f.factory({ env });

      const before = await readFile(target);
      const preview = await fix.preview();
      assert.equal(preview.check.applied, false);
      assert.equal(preview.check.status, "not-applied");
      assert.deepEqual(preview.files_affected, [target]);
      assert.equal(preview.marker, f.marker);
      assert.equal(preview.check.marker, openOf(f.marker));

      const applied = await fix.apply();
      const after = await readFile(target);

      // Recomputed from the REAL before/after bytes — the returned diff string
      // is not trusted as evidence of itself.
      const recomputed = unifiedDiff(fix.display, before.toString("utf8"), after.toString("utf8"));
      assert.equal(preview.diff, recomputed, "preview().diff is not the delta apply() wrote");
      assert.equal(applied.diff, recomputed);
      assert.equal(preview.targets[0].afterHash, `sha256:${hash(after)}`);
      assert.equal(preview.targets[0].beforeHash, `sha256:${hash(before)}`);
      assert.equal(preview.targets[0].bytesAfter, after.length);
      assert.equal(applied.reversible, true);
      assert.deepEqual(applied.files_affected, [target]);

      // BP-004.08 — the prior bytes are a LITERAL prefix; nothing was reflowed.
      assert.ok(
        after.subarray(0, before.length).equals(before),
        "the original bytes are not a literal prefix of the result",
      );

      const section = await golden(f.slug);
      const eol = fixture === "crlf.md" ? "\r\n" : "\n";
      const lead = fixture === "no-trailing-newline.md" ? eol : "";
      const expectedAppend = lead + (eol === "\n" ? section : section.replace(/\n/g, eol));
      assert.equal(after.subarray(before.length).toString("utf8"), expectedAppend);

      // The file's own newline style wins: a CRLF CLAUDE.md gets no lone LF.
      const appendedText = after.subarray(before.length).toString("utf8");
      if (eol === "\r\n") {
        assert.equal(/(?<!\r)\n/.test(appendedText), false, "a lone LF was written into a CRLF file");
      } else {
        assert.equal(appendedText.includes("\r"), false, "a CR was written into an LF file");
      }
    });

    test(`${f.slug} on ${fixture}: undo restores byte-identical content`, async () => {
      const home = await freshHome(`${f.slug}-undo-${fixture.replace(/\W+/g, "-")}`);
      const target = await installClaudeMd(home, fixture);
      const env = makeEnv(home);
      const fix = f.factory({ env });

      const before = await readFile(target);
      const beforeHash = hash(before);
      await fix.apply();
      assert.notEqual(hash(await readFile(target)), beforeHash);

      const undone = await fix.undo();
      assert.equal(undone.restored, true);
      assert.equal(undone.byteIdentical, true);
      assert.equal(undone.fixId, f.fixId);

      const restored = await readFile(target);
      assert.equal(hash(restored), beforeHash, "undo did not restore the original bytes");
      assert.ok(restored.equals(before));
      assert.equal((await fix.check()).applied, false);
    });
  }
}

// =========================================================================
// 3. Idempotency — a stable marker, one section, no second offer.
// =========================================================================

for (const f of FIXES) {
  test(`${f.slug}: applying twice leaves exactly one section, and check() is true after the first`, async () => {
    const home = await freshHome(`${f.slug}-idempotent`);
    const target = await installClaudeMd(home, "lf.md");
    const env = makeEnv(home);

    const first = f.factory({ env });
    assert.equal((await first.check()).applied, false);
    await first.apply();
    const afterFirst = await readFile(target);
    assert.equal((await first.check()).applied, true);
    assert.equal((await first.check()).drifted, false);
    assert.equal((await first.check()).status, "applied");

    // A FRESH instance — the second run of the CLI, which is where an unstable
    // marker duplicates the section.
    const second = f.factory({ env });
    const state = await second.check();
    assert.equal(state.applied, true, "check() must recognise a section applied by an earlier run");
    assert.equal(state.reason, "marker-present");

    await assert.rejects(
      async () => second.apply(),
      (error) => error instanceof FixError && error.code === FIX_ERROR_CODES.ALREADY_APPLIED,
      "a second apply must refuse rather than duplicate the section",
    );
    // preview() refuses too, so the UI never offers an applied fix.
    await assert.rejects(
      async () => second.preview(),
      (error) => error instanceof FixError && error.code === FIX_ERROR_CODES.ALREADY_APPLIED,
    );

    const afterSecond = await readFile(target);
    assert.ok(afterSecond.equals(afterFirst), "the refused apply changed the file");
    const text = afterSecond.toString("utf8");
    assert.equal(countOf(text, openOf(f.marker)), 1, "the section was duplicated");
    assert.equal(countOf(text, closeOf(f.marker)), 1);
    assert.equal((await listTransactions(env, { fixId: f.fixId })).length, 1);
  });

  test(`${f.slug}: a hand-edited section is drift, not a re-apply`, async () => {
    const home = await freshHome(`${f.slug}-drift`);
    const target = await installClaudeMd(home, "lf.md");
    const env = makeEnv(home);
    await f.factory({ env }).apply();

    const applied = (await readFile(target)).toString("utf8");
    const edited = applied.replace(openOf(f.marker), `${openOf(f.marker)}\nA line a user added.`);
    await writeFile(target, Buffer.from(edited, "utf8"));
    const beforeHash = hash(await readFile(target));

    const fresh = f.factory({ env });
    const state = await fresh.check();
    assert.equal(state.applied, true);
    assert.equal(state.drifted, true);
    assert.equal(state.reason, "section-modified");
    await assert.rejects(
      async () => fresh.apply(),
      (error) => error instanceof FixError && error.code === FIX_ERROR_CODES.MARKER_DRIFT,
    );
    assert.equal(hash(await readFile(target)), beforeHash, "a drifted file must not be touched");
  });
}

// =========================================================================
// 4. All three in ONE CLAUDE.md — the case a real user hits.
// =========================================================================

test("all three sections coexist in one CLAUDE.md, each recognised independently", async () => {
  const home = await freshHome("coexist");
  const target = await installClaudeMd(home, "lf.md");
  const env = makeEnv(home);
  const original = await readFile(target);

  for (const f of FIXES) await f.factory({ env }).apply();

  const after = await readFile(target);
  const text = after.toString("utf8");
  assert.ok(after.subarray(0, original.length).equals(original), "the user's bytes were disturbed");

  const positions = [];
  for (const f of FIXES) {
    assert.equal(countOf(text, openOf(f.marker)), 1, `${f.slug} is not present exactly once`);
    assert.equal(countOf(text, closeOf(f.marker)), 1);
    positions.push(text.indexOf(openOf(f.marker)));
    // Each fix recognises its OWN section and is not confused by its neighbours.
    const state = await f.factory({ env }).check();
    assert.equal(state.applied, true, `${f.slug} does not see itself`);
    assert.equal(state.drifted, false, `${f.slug} reports drift with neighbours present`);
  }
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "sections are out of apply order");

  // Each section is byte-exact where it landed: no neighbour ran into another.
  for (const f of FIXES) {
    const section = (await golden(f.slug)).slice(1);
    assert.ok(text.includes(section), `${f.slug}'s section is not intact in the combined file`);
  }
  assert.equal((await listTransactions(env)).length, 3);
});

test("three sections applied: undoing the middle one refuses, and leaves the other two byte-intact", async () => {
  const home = await freshHome("undo-middle");
  const target = await installClaudeMd(home, "lf.md");
  const env = makeEnv(home);
  const original = await readFile(target);

  const [first, middle, last] = FIXES.map((f) => f.factory({ env }));
  for (const fix of [first, middle, last]) await fix.apply();
  const allThree = await readFile(target);
  const allThreeHash = hash(allThree);

  // The engine's only undo is a whole-file restore guarded by the hash recorded
  // after apply (src/fixes/base.js `undoTransaction`, PHASE 1).  The middle
  // fix's backup predates the LAST fix, so restoring it would silently delete
  // that later section — so it REFUSES, names the backup, and touches nothing.
  // This is the case naive marker handling corrupts.
  await assert.rejects(
    async () => middle.undo(),
    (error) => {
      assert.ok(error instanceof FixError);
      assert.equal(error.code, FIX_ERROR_CODES.EXTERNAL_EDIT);
      assert.ok(error.details.backup, "the refusal must name the backup that holds the prior content");
      assert.match(error.message, /Refusing to undo/);
      return true;
    },
  );
  assert.equal(hash(await readFile(target)), allThreeHash, "a refused undo modified the file");
  const stillThere = (await readFile(target)).toString("utf8");
  for (const f of FIXES) {
    assert.equal(countOf(stillThere, openOf(f.marker)), 1, `${f.slug} was disturbed by the refusal`);
  }

  // Undone newest-first, each fix is independently reversible and each step
  // leaves its neighbours byte-exact.
  await last.undo();
  let text = (await readFile(target)).toString("utf8");
  assert.equal(countOf(text, openOf(FIXES[2].marker)), 0);
  assert.ok(text.includes((await golden(FIXES[0].slug)).slice(1)));
  assert.ok(text.includes((await golden(FIXES[1].slug)).slice(1)));

  await middle.undo();
  text = (await readFile(target)).toString("utf8");
  assert.equal(countOf(text, openOf(FIXES[1].marker)), 0);
  assert.ok(text.includes((await golden(FIXES[0].slug)).slice(1)), "undoing the middle broke the first");

  await first.undo();
  const finalBytes = await readFile(target);
  assert.ok(finalBytes.equals(original), "the file did not return to its original bytes");
  assert.equal(hash(finalBytes), hash(original));
});

test("a fix applied after another's undo does not resurrect or duplicate anything", async () => {
  const home = await freshHome("reapply");
  const target = await installClaudeMd(home, "crlf.md");
  const env = makeEnv(home);

  const a = FIXES[0].factory({ env });
  await a.apply();
  await a.undo();
  const b = FIXES[1].factory({ env });
  await b.apply();
  const again = FIXES[0].factory({ env });
  await again.apply();

  const text = (await readFile(target)).toString("utf8");
  for (const f of [FIXES[0], FIXES[1]]) {
    assert.equal(countOf(text, openOf(f.marker)), 1);
  }
  assert.equal(countOf(text, openOf(FIXES[2].marker)), 0);
  assert.equal(/(?<!\r)\n/.test(text), false, "a lone LF reached a CRLF file");
});

// =========================================================================
// 5. Fail closed — nothing partial, always a coded reason.
// =========================================================================

for (const f of FIXES) {
  test(`${f.slug}: a missing CLAUDE.md is refused, not created`, async () => {
    const home = await freshHome(`${f.slug}-missing`);
    const env = makeEnv(home);
    const fix = f.factory({ env });
    const target = path.join(home, ".claude", "CLAUDE.md");

    const state = await fix.check();
    assert.equal(state.applied, false);
    assert.equal(state.status, "unknown");
    assert.equal(state.reason, FIX_ERROR_CODES.TARGET_MISSING);

    for (const call of [() => fix.preview(), () => fix.apply()]) {
      await assert.rejects(
        async () => call(),
        (error) => error instanceof FixError
          && error.code === FIX_ERROR_CODES.TARGET_MISSING
          && /does not exist/.test(error.message),
      );
    }
    assert.equal(await exists(target), false, "the fix created the file it was meant to refuse");
    assert.equal(await exists(env.stateDir), false, "a refused fix left state behind");
    assert.deepEqual(await listTransactions(env), []);
  });
}

test("a symlinked CLAUDE.md is refused with a clear error, and the link and its target survive", async () => {
  const home = await freshHome("symlink");
  const env = makeEnv(home);
  const real = path.join(home, "dotfiles", "CLAUDE.md");
  await mkdir(path.dirname(real), { recursive: true });
  await copyFile(path.join(FIXTURES, "lf.md"), real);
  const link = path.join(home, ".claude", "CLAUDE.md");
  await symlink(real, link);

  const realBefore = await readFile(real);
  const fix = FIXES[0].factory({ env });

  const state = await fix.check();
  assert.equal(state.status, "unknown");
  assert.equal(state.reason, FIX_ERROR_CODES.TARGET_IS_SYMLINK);

  await assert.rejects(
    async () => fix.apply(),
    (error) => {
      assert.ok(error instanceof FixError);
      assert.equal(error.code, FIX_ERROR_CODES.TARGET_IS_SYMLINK);
      assert.match(error.message, /symlink/);
      assert.match(error.message, /apply the section by hand/);
      return true;
    },
  );

  assert.ok((await lstat(link)).isSymbolicLink(), "the symlink was replaced");
  assert.ok((await readFile(real)).equals(realBefore), "the symlink's target was written through");
  assert.equal(await exists(env.stateDir), false, "a refused fix left state behind");
});

test("a target outside the configured home is refused at construction", async () => {
  const home = await freshHome("escape");
  const env = makeEnv(home);
  for (const bad of ["../../.ssh/config", "/etc/hosts", path.join("..", "..", ".claude", "CLAUDE.md")]) {
    assert.throws(
      () => new FIXES[0].Fix({ env, target: bad }),
      (error) => error instanceof FixError && error.code === FIX_ERROR_CODES.PATH_ESCAPE,
      `target ${bad} was not refused`,
    );
  }
});

test("an appended section survives unrelated later edits to the file", async () => {
  const home = await freshHome("later-edit");
  const target = await installClaudeMd(home, "no-trailing-newline.md");
  const env = makeEnv(home);
  const fix = FIXES[2].factory({ env });
  await fix.apply();

  // A user adds their own rule AFTER the section. `check()` still finds the
  // section, and undo refuses because the later edit would be destroyed.
  await appendFile(target, "\n## My own rule\nkeep this line\n");
  const state = await fix.check();
  assert.equal(state.applied, true);
  assert.equal(state.drifted, false);
  await assert.rejects(
    async () => fix.undo(),
    (error) => error instanceof FixError && error.code === FIX_ERROR_CODES.EXTERNAL_EDIT,
  );
  assert.ok((await readFile(target)).toString("utf8").includes("keep this line"));
});

// =========================================================================
// 6. The real config files were never in reach.
// =========================================================================

test("the temp-home chokepoint refuses the real home", () => {
  assert.throws(() => makeEnv(REAL_HOME), /not inside the temp root/);
  assert.throws(() => makeEnv(path.join(REAL_HOME, ".claude")), /not inside the temp root/);
  // And the default target is relative, so it can only ever resolve under an
  // injected home — never at an absolute ~/.claude path.
  for (const f of FIXES) assert.equal(path.isAbsolute(f.mod.TARGET), false);
});

test("the real ~/.claude/CLAUDE.md, ~/.claude/settings.json and ~/.session-rx were never touched", async () => {
  assert.deepEqual(await snapshotRealFiles(), REAL_BEFORE);
});
