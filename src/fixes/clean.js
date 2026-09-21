/**
 * `session-rx clean` — the ONLY code path in SessionRx that removes anything
 * from `~/.session-rx/`.
 *
 * Nothing else ever prunes that directory: not an undo, not an uninstall, not
 * a version upgrade. That is deliberate. The undo history is what makes
 * "Undo" a real promise rather than a word in the UI — a fix applied last
 * month is still undoable next month because its backup is still on disk. So
 * removing it is a decision only the user gets to make, out loud, with the
 * consequence stated first.
 *
 * Hence the shape of this module:
 *
 *   surveyState()  — read-only. Counts what is there and refuses on anything
 *                    that does not resolve inside the state directory.
 *   removeState()  — acts on a survey that already passed that check.
 *
 * They are separate so the CLI can print the survey, and the sentence about
 * what is about to be lost, BEFORE a single byte is unlinked.
 *
 * ── Why the deletion is allowed here at all ──────────────────────────────
 * Every other module in this project is read-only by contract, and the fix
 * engine only ever writes after an explicit click. This file deletes, on an
 * explicit `--yes`, and only inside a directory SessionRx created itself. The
 * containment check below is what keeps that narrow: a symlink, a `..`, or an
 * injected state directory that points anywhere else ABORTS the whole run and
 * removes nothing. Symlinks are resolved BEFORE the check, never after.
 */

import { lstat, readdir, readlink, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { STATE_DIR_NAME, createFixEnvironment, listTransactions } from "./base.js";

/** Same containment test the fix engine uses on its own targets. */
function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Where a directory entry really points. A symlink is resolved to its TARGET,
 * so a link out of the state directory is caught as an escape instead of
 * being followed or silently unlinked. A broken link still gets a resolved
 * path to check — a dangling link to `/etc` is refused the same as a live one.
 */
async function resolveEntry(entryPath, stats) {
  if (stats.isSymbolicLink()) {
    return resolveEvenIfAbsent(path.resolve(path.dirname(entryPath), await readlink(entryPath)));
  }
  return realpath(entryPath);
}

/**
 * `realpath` of a path that may not exist. Walks up to the nearest ancestor
 * that does, resolves that, and re-appends the rest — so a dangling link is
 * still compared against a symlink-free prefix rather than against a raw
 * string that `/tmp` -> `/private/tmp` alone would make look like an escape.
 */
async function resolveEvenIfAbsent(target) {
  let current = target;
  const trailing = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...trailing);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Bytes in the units a person reads, without pretending to more precision. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function countPhrase(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** YYYY-MM-DD, or null when the record does not carry a usable date. */
function dayOf(value) {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function dateRangeOf(transactions) {
  const days = [];
  for (const record of transactions) {
    const day = dayOf(record.appliedAt) ?? dayOf(record.createdAt);
    if (day) days.push(day);
  }
  if (days.length === 0) return { earliest: null, latest: null };
  days.sort();
  return { earliest: days[0], latest: days[days.length - 1] };
}

/**
 * Walk the state directory, breadth-first, without following anything out of
 * it. Returns every entry found plus every entry that resolved outside — the
 * caller refuses the whole run if that second list is not empty, rather than
 * cleaning "the safe part" of a directory that has already been tampered with.
 */
async function walkState(root) {
  const files = [];
  const directories = [];
  const symlinks = [];
  const escapes = [];
  const queue = [root];

  while (queue.length > 0) {
    const dir = queue.shift();
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const entryPath = path.join(dir, dirent.name);
      const stats = await lstat(entryPath);
      const resolved = await resolveEntry(entryPath, stats);
      if (!isInside(root, resolved)) {
        escapes.push({ path: entryPath, resolved });
        continue;
      }
      if (stats.isSymbolicLink()) {
        symlinks.push({ path: entryPath, size: stats.size });
      } else if (stats.isDirectory()) {
        directories.push(entryPath);
        queue.push(entryPath);
      } else {
        files.push({ path: entryPath, size: stats.size });
      }
    }
  }
  return { files, directories, symlinks, escapes };
}

/**
 * Read-only survey of the state directory.
 *
 * Statuses: `missing` (nothing on disk), `empty` (there but nothing in it),
 * `ready` (counted, safe to remove), `refused` (something resolves outside —
 * remove nothing and say why).
 */
export async function surveyState({ home, stateDir } = {}) {
  const env = createFixEnvironment({ home, stateDir });
  const requested = env.stateDir;

  // An override whose own name is not the state directory's name is not a
  // SessionRx state directory, and this command will not delete it.
  if (path.basename(requested) !== STATE_DIR_NAME) {
    return {
      status: "refused",
      stateDir: requested,
      reason: `${requested} is not a SessionRx state directory (it is not named ${STATE_DIR_NAME}), so nothing was removed.`,
    };
  }

  let root;
  try {
    root = await realpath(requested);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing", stateDir: requested };
    throw error;
  }

  // `~/.session-rx` itself being a link to somewhere else would make every
  // entry inside it "contained" while still deleting another directory.
  if (path.basename(root) !== STATE_DIR_NAME) {
    return {
      status: "refused",
      stateDir: requested,
      resolved: root,
      reason: `${requested} resolves to ${root}, which is outside SessionRx's own state directory, so nothing was removed.`,
    };
  }

  const { files, directories, symlinks, escapes } = await walkState(root);
  if (escapes.length > 0) {
    const first = escapes[0];
    return {
      status: "refused",
      stateDir: requested,
      resolved: root,
      escapes,
      reason: `${first.path} points to ${first.resolved}, which is outside ${root}. SessionRx removed nothing — clean only ever deletes inside its own state directory.`,
    };
  }

  const transactions = await listTransactions(env);
  const bytes = files.reduce((total, entry) => total + entry.size, 0);
  const { earliest, latest } = dateRangeOf(transactions);
  const entries = [
    ...files.map((entry) => entry.path),
    ...symlinks.map((entry) => entry.path),
    ...directories,
  ];

  if (entries.length === 0) {
    return { status: "empty", stateDir: requested, resolved: root, root, transactions: 0, files: 0, bytes: 0, earliest, latest, entries: [] };
  }

  return {
    status: "ready",
    stateDir: requested,
    resolved: root,
    root,
    transactions: transactions.length,
    files: files.length + symlinks.length,
    bytes,
    earliest,
    latest,
    entries,
  };
}

/**
 * Remove the CONTENTS of a surveyed state directory. The directory itself is
 * left in place and empty: the next fix that needs it does not have to
 * recreate it, and a state directory the user deliberately symlinked onto
 * another volume keeps working.
 */
export async function removeState(survey) {
  if (!survey || survey.status !== "ready") {
    throw new Error("removeState() needs a survey with status 'ready'");
  }
  const top = await readdir(survey.root);
  for (const name of top) {
    await rm(path.join(survey.root, name), { recursive: true, force: true });
  }
  return {
    status: "removed",
    stateDir: survey.stateDir,
    root: survey.root,
    transactions: survey.transactions,
    files: survey.files,
    bytes: survey.bytes,
    earliest: survey.earliest,
    latest: survey.latest,
  };
}

/** "4 undo transactions, 13 files, 48.2 KB" — the one line both modes share. */
function countsLine(survey) {
  return `${countPhrase(survey.transactions, "undo transaction", "undo transactions")}, ${countPhrase(survey.files, "file", "files")}, ${formatBytes(survey.bytes)}`;
}

function datesLine(survey) {
  if (!survey.earliest) return "  dates: unknown — no transaction record on disk carries a usable date\n";
  if (survey.earliest === survey.latest) return `  all recorded on ${survey.earliest}\n`;
  return `  recorded between ${survey.earliest} and ${survey.latest}\n`;
}

/** The sentence this whole command exists to make the user read. */
const CONSEQUENCE =
  "Once the undo history is gone, the fixes SessionRx has already applied can no\n" +
  "longer be undone by SessionRx. Your own files are not touched either way —\n" +
  "what is removed is the saved copy needed to put them back.\n";

export function formatSurvey(survey) {
  if (survey.status === "missing") {
    return `Nothing to clean — ${survey.stateDir} does not exist.\n`;
  }
  if (survey.status === "empty") {
    return `Nothing to clean — ${survey.stateDir} is already empty.\n`;
  }
  return (
    `session-rx clean — dry run. Nothing has been removed.\n\n` +
    `This would remove everything inside ${survey.stateDir}:\n` +
    `  ${countsLine(survey)}\n` +
    datesLine(survey) +
    `\n${CONSEQUENCE}` +
    `\nTo go ahead, run: session-rx clean --yes\n`
  );
}

export function formatRemoval(result) {
  return (
    `Removed everything inside ${result.stateDir}:\n` +
    `  ${countsLine(result)} removed\n` +
    datesLine(result) +
    `\nThe directory is left in place, empty. Your own files were not touched.\n`
  );
}

/**
 * The command itself. Returns a process exit code: 0 for a dry run, a real
 * removal, and for nothing-to-do; non-zero only for a refusal.
 */
export async function runCleanCommand({
  home,
  stateDir,
  yes = false,
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
} = {}) {
  const survey = await surveyState({ home, stateDir });

  if (survey.status === "refused") {
    err(`session-rx clean refused, and removed nothing.\n${survey.reason}\n`);
    return 1;
  }
  if (survey.status === "missing" || survey.status === "empty") {
    out(formatSurvey(survey));
    return 0;
  }
  if (!yes) {
    out(formatSurvey(survey));
    return 0;
  }

  // Stated BEFORE the first unlink, not after it.
  out(`About to remove everything inside ${survey.stateDir}:\n  ${countsLine(survey)}\n${datesLine(survey)}\n${CONSEQUENCE}\n`);
  const result = await removeState(survey);
  out(formatRemoval(result));
  return 0;
}
