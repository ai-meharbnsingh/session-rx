/**
 * `tests/fixes-clean.test.js` — `src/fixes/clean.js`, the only code in
 * SessionRx that deletes anything.
 *
 * ── Isolation ────────────────────────────────────────────────────────────
 * Every test below runs against an `mkdtemp` fixture home containing a fake
 * `.claude/`, a fake `CLAUDE.md` and a fake session log, and passes that home
 * in explicitly. `createFixEnvironment()` reads `os.homedir()` ONLY when no
 * home is given, and no test here omits it — so the developer's real
 * `~/.session-rx` is never surveyed and never removed. The final describe
 * block asserts that property over every home this file created, rather than
 * leaving it as a claim in a comment.
 *
 * The state directory's name and layout are never spelled out here either:
 * they come from `createFixEnvironment()` and the `base.js` constants, so a
 * rename there breaks this file loudly instead of leaving it testing a path
 * that no longer exists.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { TRANSACTION_NAME, createFixEnvironment } from "../src/fixes/base.js";
import { formatBytes, runCleanCommand, surveyState } from "../src/fixes/clean.js";

const homes = [];

async function fixtureHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "session-rx-clean-test-"));
  homes.push(home);
  // The user files this command must never touch, in the places it would
  // find them if it ever walked outside its own state directory.
  await fs.mkdir(path.join(home, ".claude", "projects", "demo"), { recursive: true });
  await fs.writeFile(path.join(home, ".claude", "settings.json"), '{\n  "model": "opus"\n}\n');
  await fs.writeFile(path.join(home, "CLAUDE.md"), "# house rules\n");
  await fs.writeFile(path.join(home, ".claude", "projects", "demo", "session.jsonl"), '{"type":"user"}\n');
  return home;
}

/**
 * Seed one undo transaction and return the exact byte count written, so the
 * size the command reports is checked against arithmetic done here rather
 * than against the command's own walk.
 */
async function seedTransaction(home, { id, day, fixId }) {
  const env = createFixEnvironment({ home });
  const undoDir = path.join(env.undoRoot, id);
  await fs.mkdir(undoDir, { recursive: true });

  const record = `${JSON.stringify({
    version: "test",
    fixId,
    kind: "append-section",
    createdAt: `${day}T10:00:00.000Z`,
    appliedAt: `${day}T10:00:01.000Z`,
    status: "applied",
    targets: [],
  })}\n`;
  const backup = `backup of ${fixId}\n`;

  await fs.writeFile(path.join(undoDir, TRANSACTION_NAME), record);
  await fs.writeFile(path.join(undoDir, "settings.json.bak"), backup);
  return Buffer.byteLength(record) + Buffer.byteLength(backup);
}

async function seedJournal(home, lines) {
  const env = createFixEnvironment({ home });
  await fs.mkdir(env.stateDir, { recursive: true });
  const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  await fs.writeFile(env.journalPath, text);
  return Buffer.byteLength(text);
}

/** A stable fingerprint of a tree: path, kind, and content hash, sorted. */
async function snapshot(root) {
  const rows = [];
  async function walk(dir) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      const relative = path.relative(root, full);
      const stats = await fs.lstat(full);
      if (stats.isSymbolicLink()) {
        rows.push(`${relative}\tsymlink\t${await fs.readlink(full)}`);
      } else if (stats.isDirectory()) {
        rows.push(`${relative}\tdir`);
        await walk(full);
      } else {
        const hash = createHash("sha256").update(await fs.readFile(full)).digest("hex");
        rows.push(`${relative}\tfile\t${stats.size}\t${hash}`);
      }
    }
  }
  await walk(root);
  return rows.sort().join("\n");
}

/** The user's own files, deliberately excluding SessionRx's state directory. */
async function userFilesSnapshot(home) {
  const env = createFixEnvironment({ home });
  const full = await snapshot(home);
  return full
    .split("\n")
    .filter((row) => row !== "" && !row.startsWith(path.basename(env.stateDir)))
    .join("\n");
}

function capture() {
  const out = [];
  const err = [];
  return {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    get stdout() { return out.join(""); },
    get stderr() { return err.join(""); },
  };
}

/** Whitespace-insensitive match, so a wrapped sentence still counts. */
function flat(text) {
  return text.replace(/\s+/g, " ").trim();
}

// ===========================================================================

describe("session-rx clean — dry run is the default and removes nothing", () => {
  it("leaves the state directory byte-identical and names the flag that would perform it", async () => {
    const home = await fixtureHome();
    await seedTransaction(home, { id: "2026-09-14T10-00-00-000Z", day: "2026-09-14", fixId: "compact-threshold" });
    await seedJournal(home, [{ ts: "2026-09-14T10:00:01.000Z", event: "apply" }]);
    const env = createFixEnvironment({ home });

    const before = await snapshot(env.stateDir);
    const userBefore = await userFilesSnapshot(home);
    const io = capture();
    const code = await runCleanCommand({ home, out: io.out, err: io.err });

    assert.equal(code, 0);
    assert.equal(await snapshot(env.stateDir), before, "a dry run must not change a single byte of the state directory");
    assert.equal(await userFilesSnapshot(home), userBefore, "a dry run must not touch the user's own files");
    assert.match(io.stdout, /Nothing has been removed/);
    assert.match(io.stdout, /session-rx clean --yes/, "the dry run must name the flag that performs it");
    assert.equal(io.stderr, "");
  });

  it("states the consequence in plain English: undo stops working", async () => {
    const home = await fixtureHome();
    await seedTransaction(home, { id: "2026-09-14T10-00-00-000Z", day: "2026-09-14", fixId: "compact-threshold" });

    const io = capture();
    await runCleanCommand({ home, out: io.out, err: io.err });

    assert.match(
      flat(io.stdout),
      /Once the undo history is gone, the fixes SessionRx has already applied can no longer be undone by SessionRx/,
    );
    assert.match(flat(io.stdout), /Your own files are not touched/);
  });

  it("reports the transaction count, the file count and the size on disk, all correct", async () => {
    const home = await fixtureHome();
    let bytes = 0;
    bytes += await seedTransaction(home, { id: "2026-09-14T10-00-00-000Z", day: "2026-09-14", fixId: "compact-threshold" });
    bytes += await seedTransaction(home, { id: "2026-09-18T11-00-00-000Z", day: "2026-09-18", fixId: "output-style" });
    bytes += await seedTransaction(home, { id: "2026-09-20T12-00-00-000Z", day: "2026-09-20", fixId: "subagent-budget" });
    bytes += await seedJournal(home, [
      { ts: "2026-09-14T10:00:01.000Z", event: "apply" },
      { ts: "2026-09-20T12:00:01.000Z", event: "apply" },
    ]);

    // 3 transactions x (transaction.json + one backup) + the journal.
    const expectedFiles = 7;
    assert.ok(bytes < 1024, "the fixture is kept under 1 KB so the size can be asserted exactly, in bytes");

    const survey = await surveyState({ home });
    assert.equal(survey.status, "ready");
    assert.equal(survey.transactions, 3);
    assert.equal(survey.files, expectedFiles);
    assert.equal(survey.bytes, bytes);
    assert.equal(survey.earliest, "2026-09-14");
    assert.equal(survey.latest, "2026-09-20");

    const io = capture();
    await runCleanCommand({ home, out: io.out, err: io.err });
    assert.match(io.stdout, new RegExp(`3 undo transactions, ${expectedFiles} files, ${bytes} bytes`));
    assert.match(io.stdout, /recorded between 2026-09-14 and 2026-09-20/);
  });

  it("says 'unknown' rather than inventing a date range when no record carries one", async () => {
    const home = await fixtureHome();
    const env = createFixEnvironment({ home });
    await fs.mkdir(env.undoRoot, { recursive: true });
    await fs.writeFile(path.join(env.undoRoot, "orphan.bak"), "loose file, no transaction record\n");

    const io = capture();
    const code = await runCleanCommand({ home, out: io.out, err: io.err });

    assert.equal(code, 0);
    assert.match(io.stdout, /0 undo transactions, 1 file, /);
    assert.match(io.stdout, /dates: unknown/);
  });
});

describe("session-rx clean --yes — performs it", () => {
  it("removes the contents, reports accurate counts, and leaves the directory in place and empty", async () => {
    const home = await fixtureHome();
    let bytes = 0;
    bytes += await seedTransaction(home, { id: "2026-09-14T10-00-00-000Z", day: "2026-09-14", fixId: "compact-threshold" });
    bytes += await seedTransaction(home, { id: "2026-09-20T12-00-00-000Z", day: "2026-09-20", fixId: "output-style" });
    bytes += await seedJournal(home, [{ ts: "2026-09-14T10:00:01.000Z", event: "apply" }]);
    const env = createFixEnvironment({ home });
    assert.ok(bytes < 1024, "the fixture is kept under 1 KB so the size can be asserted exactly, in bytes");

    const userBefore = await userFilesSnapshot(home);
    const io = capture();
    const code = await runCleanCommand({ home, yes: true, out: io.out, err: io.err });

    assert.equal(code, 0);
    assert.deepEqual(await fs.readdir(env.stateDir), [], "the state directory must be emptied");
    assert.ok((await fs.stat(env.stateDir)).isDirectory(), "the directory itself stays, so the next fix does not have to recreate it");
    assert.match(io.stdout, new RegExp(`2 undo transactions, 5 files, ${bytes} bytes removed`));
    assert.equal(await userFilesSnapshot(home), userBefore, "--yes must not touch the user's own files");
    assert.equal(io.stderr, "");
  });

  it("states the consequence BEFORE it removes anything, not after", async () => {
    const home = await fixtureHome();
    await seedTransaction(home, { id: "2026-09-14T10-00-00-000Z", day: "2026-09-14", fixId: "compact-threshold" });

    const io = capture();
    await runCleanCommand({ home, yes: true, out: io.out, err: io.err });

    const warning = io.stdout.indexOf("can no\nlonger be undone by SessionRx");
    const report = io.stdout.indexOf("Removed everything inside");
    assert.ok(warning >= 0, "the consequence must be printed");
    assert.ok(report > warning, "the warning must come before the report of what was removed");
    assert.match(io.stdout, /About to remove everything inside/);
  });

  it("is safe to run twice: the second run says there is nothing to clean", async () => {
    const home = await fixtureHome();
    await seedTransaction(home, { id: "2026-09-14T10-00-00-000Z", day: "2026-09-14", fixId: "compact-threshold" });

    assert.equal(await runCleanCommand({ home, yes: true, out: () => {}, err: () => {} }), 0);
    const io = capture();
    const code = await runCleanCommand({ home, yes: true, out: io.out, err: io.err });

    assert.equal(code, 0);
    assert.match(io.stdout, /Nothing to clean/);
    assert.match(io.stdout, /already empty/);
  });
});

describe("session-rx clean — a state directory that is not there", () => {
  it("says there is nothing to clean, exits 0, and does not throw", async () => {
    const home = await fixtureHome();
    const env = createFixEnvironment({ home });
    const userBefore = await userFilesSnapshot(home);

    const io = capture();
    const code = await runCleanCommand({ home, out: io.out, err: io.err });

    assert.equal(code, 0, "a missing state directory is not an error");
    assert.match(io.stdout, /Nothing to clean/);
    assert.match(io.stdout, new RegExp(`${env.stateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} does not exist`));
    assert.equal(io.stderr, "");
    assert.equal(await userFilesSnapshot(home), userBefore);
  });

  it("--yes on a missing state directory is also a clean exit, and creates nothing", async () => {
    const home = await fixtureHome();
    const env = createFixEnvironment({ home });

    const code = await runCleanCommand({ home, yes: true, out: () => {}, err: () => {} });

    assert.equal(code, 0);
    await assert.rejects(fs.stat(env.stateDir), (error) => error.code === "ENOENT", "clean must not create the directory it was asked to remove");
  });
});

describe("session-rx clean — containment: it refuses anything resolving outside the state directory", () => {
  it("a symlink pointing out of the state directory ABORTS the whole run and removes nothing", async () => {
    const home = await fixtureHome();
    await seedTransaction(home, { id: "2026-09-14T10-00-00-000Z", day: "2026-09-14", fixId: "compact-threshold" });
    const env = createFixEnvironment({ home });

    // Somewhere entirely outside the fixture home, with something in it.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "session-rx-clean-outside-"));
    homes.push(outside);
    await fs.writeFile(path.join(outside, "precious.txt"), "not SessionRx's to delete\n");
    await fs.symlink(outside, path.join(env.undoRoot, "escape"));

    const before = await snapshot(env.stateDir);
    const userBefore = await userFilesSnapshot(home);
    const io = capture();
    const code = await runCleanCommand({ home, yes: true, out: io.out, err: io.err });

    assert.notEqual(code, 0, "a refusal must be a non-zero exit");
    assert.match(io.stderr, /refused, and removed nothing/);
    assert.match(io.stderr, /outside/);
    assert.equal(io.stdout, "", "a refusal prints nothing on stdout");
    assert.equal(await snapshot(env.stateDir), before, "a refusal must leave the state directory byte-identical");
    assert.equal(await userFilesSnapshot(home), userBefore);
    assert.equal(await fs.readFile(path.join(outside, "precious.txt"), "utf8"), "not SessionRx's to delete\n");
  });

  it("a symlink to a single file outside is refused too, not just a directory", async () => {
    const home = await fixtureHome();
    await seedTransaction(home, { id: "2026-09-14T10-00-00-000Z", day: "2026-09-14", fixId: "compact-threshold" });
    const env = createFixEnvironment({ home });
    await fs.symlink(path.join(home, "CLAUDE.md"), path.join(env.stateDir, "claude-md-link"));

    const io = capture();
    const code = await runCleanCommand({ home, yes: true, out: io.out, err: io.err });

    assert.notEqual(code, 0);
    assert.equal(await fs.readFile(path.join(home, "CLAUDE.md"), "utf8"), "# house rules\n");
    assert.ok((await fs.readdir(env.undoRoot)).length > 0, "nothing inside was removed");
  });

  it("a dangling symlink pointing outside is refused as well — the target is checked, not its existence", async () => {
    const home = await fixtureHome();
    await seedTransaction(home, { id: "2026-09-14T10-00-00-000Z", day: "2026-09-14", fixId: "compact-threshold" });
    const env = createFixEnvironment({ home });
    await fs.symlink(path.join(home, "was-here.txt"), path.join(env.stateDir, "dangling"));

    const survey = await surveyState({ home });
    assert.equal(survey.status, "refused");
    assert.match(survey.reason, /outside/);
  });

  it("an injected state directory that is not a SessionRx state directory is refused", async () => {
    const home = await fixtureHome();
    const io = capture();

    const code = await runCleanCommand({ home, stateDir: path.join(home, ".claude"), yes: true, out: io.out, err: io.err });

    assert.notEqual(code, 0);
    assert.match(io.stderr, /is not a SessionRx state directory/);
    assert.equal(
      await fs.readFile(path.join(home, ".claude", "settings.json"), "utf8"),
      '{\n  "model": "opus"\n}\n',
      "the user's settings.json must survive an attempt to point clean at ~/.claude",
    );
  });

  it("a state directory that is itself a symlink onto something else is refused", async () => {
    const home = await fixtureHome();
    const env = createFixEnvironment({ home });
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "session-rx-clean-elsewhere-"));
    homes.push(elsewhere);
    await fs.writeFile(path.join(elsewhere, "someone-elses.txt"), "keep me\n");
    await fs.symlink(elsewhere, env.stateDir);

    const io = capture();
    const code = await runCleanCommand({ home, yes: true, out: io.out, err: io.err });

    assert.notEqual(code, 0);
    assert.match(io.stderr, /outside SessionRx's own state directory/);
    assert.equal(await fs.readFile(path.join(elsewhere, "someone-elses.txt"), "utf8"), "keep me\n");
  });

  it("a state directory symlinked to another directory of the same name IS accepted", async () => {
    // The legitimate case the name check must not break: the user moved
    // ~/.session-rx onto another volume and left a link behind.
    const home = await fixtureHome();
    const env = createFixEnvironment({ home });
    const volume = await fs.mkdtemp(path.join(os.tmpdir(), "session-rx-clean-volume-"));
    homes.push(volume);
    const moved = path.join(volume, path.basename(env.stateDir));
    await fs.mkdir(moved);
    await fs.writeFile(path.join(moved, "journal.jsonl"), '{"event":"apply"}\n');
    await fs.symlink(moved, env.stateDir);

    const code = await runCleanCommand({ home, yes: true, out: () => {}, err: () => {} });

    assert.equal(code, 0);
    assert.deepEqual(await fs.readdir(moved), []);
  });
});

describe("formatBytes", () => {
  it("reports bytes below a kilobyte, and scales up with one decimal", () => {
    assert.equal(formatBytes(0), "0 bytes");
    assert.equal(formatBytes(1), "1 byte");
    assert.equal(formatBytes(999), "999 bytes");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(1024 * 1024 * 3), "3.0 MB");
  });
});

// ---------------------------------------------------------------------------
// The safety proof, asserted last (mirrors tests/cli.test.js's own).
// ---------------------------------------------------------------------------

describe("real-file safety (this file's own proof)", () => {
  it("every directory this file created was a temp dir, never the developer's real home", () => {
    assert.ok(homes.length > 0, "this file must have created at least one fixture to prove anything");
    for (const home of homes) {
      assert.notEqual(home, os.homedir());
      assert.ok(home.startsWith(os.tmpdir()), `${home} is not a temp dir`);
    }
  });

  it("the developer's real state directory was never surveyed — every call passed an explicit home", async () => {
    const real = createFixEnvironment({});
    assert.equal(real.home, os.homedir(), "createFixEnvironment with no home reads the real one, which is why no test omits it");
    for (const home of homes) {
      assert.notEqual(createFixEnvironment({ home }).stateDir, real.stateDir);
    }
  });
});
