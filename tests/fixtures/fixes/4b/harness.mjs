/**
 * Wave 4B test harness — the single chokepoint that keeps these suites away from
 * the developer's real `~/.claude`.
 *
 * It lives under `tests/fixtures/fixes/4b/` because that is wave 4B's owned
 * path, and it is named `.mjs` so it can never match `node --test`'s
 * `*.test.js` discovery pattern and be run as a suite.
 *
 * THE GUARANTEE, in one sentence: `makeEnv()` throws unless the home it is given
 * is inside this process's `mkdtemp` root, and the wave-4A engine derives every
 * path it reads or writes from `env.home`, so a fix built through this harness
 * cannot name a file under the real home even by accident. `createFixEnvironment()`
 * with no argument — the only code that reads `os.homedir()` — is never called by
 * either 4B suite.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFixEnvironment } from "../../../../src/fixes/base.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Every temp home this process creates lives under here, and nowhere else. */
export const TMP_ROOT = await mkdtemp(path.join(os.tmpdir(), "session-rx-4b-"));

export const REAL_HOME = os.homedir();

/** Hashed with node:crypto directly, never with the module under test. */
export function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fixturePath(...parts) {
  return path.join(here, ...parts);
}

/**
 * The chokepoint. A home outside `TMP_ROOT` is a bug in the test, not a case to
 * handle, so it throws rather than returning something usable.
 */
export function makeEnv(home, { now } = {}) {
  const resolved = path.resolve(home);
  if (resolved !== TMP_ROOT && !resolved.startsWith(TMP_ROOT + path.sep)) {
    throw new Error(
      `wave-4B tests refuse a home outside ${TMP_ROOT}: ${resolved}`,
    );
  }
  return createFixEnvironment({ home: resolved, now });
}

let serial = 0;

/**
 * A fresh temp home with one fixture copied into `<home>/.claude/`. Returns the
 * env, the absolute target, and the exact bytes on disk so a test can hash the
 * true "before" rather than trusting the fixture file it asked for.
 */
export async function scaffold(label, { claudeMd, settings } = {}) {
  serial += 1;
  const home = path.join(TMP_ROOT, `${String(serial).padStart(3, "0")}-${label}`);
  const claudeDir = path.join(home, ".claude");
  await mkdir(claudeDir, { recursive: true });
  let target = null;
  if (claudeMd) {
    target = path.join(claudeDir, "CLAUDE.md");
    await copyFile(fixturePath("claude-md", claudeMd), target);
  }
  if (settings) {
    target = path.join(claudeDir, "settings.json");
    await copyFile(fixturePath("settings", settings), target);
  }
  const bytes = target ? await readFile(target) : Buffer.alloc(0);
  return { home, claudeDir, env: makeEnv(home), target, bytes, beforeHash: hash(bytes) };
}

/** A temp home with a `.claude/` directory and nothing in it. */
export async function scaffoldEmpty(label) {
  serial += 1;
  const home = path.join(TMP_ROOT, `${String(serial).padStart(3, "0")}-${label}`);
  const claudeDir = path.join(home, ".claude");
  await mkdir(claudeDir, { recursive: true });
  return { home, claudeDir, env: makeEnv(home) };
}

export async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** True if the engine created any state at all under this temp home. */
export async function stateDirExists(home) {
  return exists(path.join(home, ".session-rx"));
}

const REAL_GUARDED = Object.freeze([
  path.join(REAL_HOME, ".claude", "CLAUDE.md"),
  path.join(REAL_HOME, ".claude", "settings.json"),
]);

export async function snapshotRealFiles() {
  const out = {};
  for (const file of REAL_GUARDED) {
    try {
      out[file] = hash(await readFile(file));
    } catch (error) {
      out[file] = `absent:${error.code}`;
    }
  }
  out[path.join(REAL_HOME, ".session-rx")] = (await exists(path.join(REAL_HOME, ".session-rx")))
    ? "present-before-this-suite"
    : "absent";
  return out;
}

/** Belt and braces: the real files are hashed at load and re-hashed at the end. */
export const REAL_SNAPSHOT = await snapshotRealFiles();

export async function assertRealFilesUnchanged() {
  const after = await snapshotRealFiles();
  for (const [file, before] of Object.entries(REAL_SNAPSHOT)) {
    assert.equal(
      after[file],
      before,
      `wave 4B modified a real file outside the temp home: ${file}`,
    );
  }
  // The suites never inject the real home, so the engine can never have created
  // its state directory there. Asserted rather than assumed.
  assert.equal(
    after[path.join(REAL_HOME, ".session-rx")],
    REAL_SNAPSHOT[path.join(REAL_HOME, ".session-rx")],
    "wave 4B created or removed ~/.session-rx",
  );
  return after;
}
