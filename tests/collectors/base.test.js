import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import Collector, {
  BP002_WINDOW_SOURCES,
  Collector as NamedCollector,
  KNOWN_WINDOW_TIERS,
  KNOWN_WINDOW_TIERS_BY_VENDOR,
  MODEL_WINDOWS,
  MODEL_WINDOWS_VERSION,
  OBSERVED_WINDOW_SOURCES,
  VERSION,
  WINDOW_SOURCES,
  createDiagnostic,
  lookupWindow,
  matchWindowEntry,
  normalizeSession,
  normalizeTurn,
  peakContextTokens,
  readOnlyFileUri,
  resolveWindow,
  safeReadJsonl,
  safeReadLines,
  smallestKnownTierAtLeast,
  windowPromotions,
} from "../../src/collectors/base.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROBUST = path.join(here, "..", "fixtures", "claude", "robust", "-Users-demo-robust");
const CORRUPT = path.join(ROBUST, "corrupt.jsonl");   // 2 valid lines, 1 truncated line
const EMPTY = path.join(ROBUST, "empty.jsonl");       // 0 bytes
const WHITESPACE = path.join(ROBUST, "whitespace.jsonl"); // blank + tab-only lines
const BARE = path.join(ROBUST, "bare.jsonl");         // 6 valid lines
const MISSING = path.join(ROBUST, "does-not-exist.jsonl");
// 3 valid lines, each carrying a RAW U+2028 / U+2029 inside a JSON string (F-005)
const LINE_SEPARATOR = path.join(ROBUST, "line-separator.jsonl");

test("readOnlyFileUri uses the SQLite three-slash POSIX form", () => {
  assert.equal(readOnlyFileUri("/abs/path"), "file:///abs/path?mode=ro");
});

test("readOnlyFileUri normalizes a Windows-shaped path deterministically", () => {
  assert.equal(
    readOnlyFileUri("C:\\Users\\Asha\\x\\store.db"),
    "file:///C:/Users/Asha/x/store.db?mode=ro",
  );
});

test("readOnlyFileUri escapes percent, question-mark, and hash once", () => {
  const uri = readOnlyFileUri("/tmp/100%/store?part#1.db");
  assert.equal(uri, "file:///tmp/100%25/store%3fpart%231.db?mode=ro");
  assert.match(uri, /%25/);
  assert.doesNotMatch(uri, /%2525/);
});

test("readOnlyFileUri opens a real temporary database read-only", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "session-rx-uri-"));
  const file = path.join(dir, "store.db");
  const writable = new DatabaseSync(file);
  writable.exec("CREATE TABLE probe (value TEXT)");
  writable.close();

  const readOnly = new DatabaseSync(readOnlyFileUri(file), { readOnly: true });
  assert.equal(readOnly.prepare("SELECT COUNT(*) AS count FROM probe").get().count, 0);
  readOnly.close();
});

/** The entry `lookupWindow` must pick, computed from the exported table order. */
function winnerFor(modelId) {
  return MODEL_WINDOWS.find(({ pattern }) => pattern.test(modelId));
}

async function readAll(file, opts = {}) {
  const records = [];
  const diagnostic = await safeReadJsonl(file, (record) => records.push(record), { cli: "test", ...opts });
  return { records, diagnostic };
}

// ---------------------------------------------------------------------------
// MODEL_WINDOWS reachability — the F-001 regression guard
// ---------------------------------------------------------------------------

test("every MODEL_WINDOWS entry is the winning match for at least one model id", () => {
  const unreachable = [];
  const seen = new Set();

  for (const entry of MODEL_WINDOWS) {
    assert.ok(entry.examples.length > 0, `${entry.id} declares no example model id`);
    for (const example of entry.examples) {
      const winner = winnerFor(example);
      assert.ok(winner, `${entry.id}: no entry matches its own example ${example}`);
      if (winner.id !== entry.id) {
        unreachable.push(`${entry.id} loses ${example} to ${winner.id}`);
        continue;
      }
      seen.add(entry.id);
      // The public API must agree with the table order, not just the table.
      assert.deepEqual(
        lookupWindow(example),
        { tokens: entry.tokens, source: entry.source },
        `lookupWindow(${example}) disagrees with entry ${entry.id}`,
      );
    }
  }

  assert.deepEqual(unreachable, [], "these entries are unreachable dead code (INV-1)");
  assert.equal(seen.size, MODEL_WINDOWS.length, "an entry never won for any of its examples");
});

test("MODEL_WINDOWS entry ids are unique, so reachability names one entry each", () => {
  const ids = MODEL_WINDOWS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate entry id in ${ids.join(", ")}`);
});

test("MODEL_WINDOWS is ordered most-specific-first", () => {
  const specificities = MODEL_WINDOWS.map((entry) => entry.specificity);
  for (let i = 1; i < specificities.length; i += 1) {
    assert.ok(
      specificities[i - 1] >= specificities[i],
      `entry ${MODEL_WINDOWS[i].id} (${specificities[i]}) outranks ${MODEL_WINDOWS[i - 1].id} (${specificities[i - 1]}) but sits after it`,
    );
  }
  const long = MODEL_WINDOWS.findIndex((entry) => entry.id === "claude-1m-long-context");
  const family = MODEL_WINDOWS.findIndex((entry) => entry.id === "claude-family");
  assert.ok(long >= 0 && family >= 0, "the claude entries are missing");
  assert.ok(long < family, "the claude 1M entry must be tested before the family fallback");
});

test("a long-context claude id resolves to 1M, not the 200k family window (F-001)", () => {
  assert.deepEqual(lookupWindow("claude-sonnet-4-5-1m"), { tokens: 1000000, source: "model-table" });
  assert.deepEqual(lookupWindow("claude-sonnet-4-5[1m]"), { tokens: 1000000, source: "model-table" });
  // The family fallback still owns every ordinary id.
  assert.equal(lookupWindow("claude-sonnet-5").tokens, 200000);
});

test("MODEL_WINDOWS and its entries are frozen", () => {
  assert.ok(Object.isFrozen(MODEL_WINDOWS));
  for (const entry of MODEL_WINDOWS) {
    assert.ok(Object.isFrozen(entry), `${entry.id} is mutable`);
    assert.ok(Object.isFrozen(entry.examples), `${entry.id}.examples is mutable`);
  }
  assert.throws(() => { MODEL_WINDOWS[0].tokens = 1; }, TypeError);
});

test("the table version is bumped past the pre-fix table and mirrored by VERSION", () => {
  assert.match(MODEL_WINDOWS_VERSION, /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/);
  assert.ok(MODEL_WINDOWS_VERSION > "2026-09-20", `${MODEL_WINDOWS_VERSION} is not newer than the table it replaces`);
  assert.equal(VERSION, MODEL_WINDOWS_VERSION);
});

// ---------------------------------------------------------------------------
// lookupWindow — real model ids, honest unknowns, truthful source (F-002)
// ---------------------------------------------------------------------------

test("lookupWindow resolves the model ids SessionRx actually meets", () => {
  const expected = [
    ["claude-opus-5", { tokens: 200000, source: "model-table" }],
    ["claude-sonnet-5", { tokens: 200000, source: "model-table" }],
    ["claude-haiku-4-5-20251001", { tokens: 200000, source: "model-table" }],
    ["claude-sonnet-4-5-1m", { tokens: 1000000, source: "model-table" }],
    ["gemini-3.5-flash", { tokens: 1000000, source: "model-map" }],
    ["gemini-3-pro", { tokens: 1000000, source: "model-map" }],
    ["gpt-5", { tokens: 400000, source: "model-table" }],
    ["gpt-5-codex", { tokens: 400000, source: "model-table" }],
    ["kimi-k2", { tokens: 262144, source: "model-map" }],
  ];
  for (const [id, want] of expected) {
    assert.deepEqual(lookupWindow(id), want, id);
  }
});

test("an unrecognised or empty model id stays unknown and never guesses a window", () => {
  const unknown = { tokens: null, source: "unknown" };
  for (const id of ["nemotron-3.5-lightning-free", "totally-made-up", "", "   ", null, undefined, 42, {}, []]) {
    assert.deepEqual(lookupWindow(id), unknown, `${JSON.stringify(id)} must stay unknown`);
  }
});

test("every entry reports a source BP-002 allows, and never fakes native or unknown", () => {
  for (const entry of MODEL_WINDOWS) {
    // Stricter than before: a TABLE entry must carry a BP-002 source, so it can
    // never claim one of F-008's observation sources as its own.
    assert.ok(BP002_WINDOW_SOURCES.includes(entry.source), `${entry.id} source ${entry.source} is outside BP-002`);
    assert.ok(
      entry.source === "model-table" || entry.source === "model-map",
      `${entry.id} is a table lookup, so it cannot claim source ${entry.source}`,
    );
  }
  // BP-002's four are unchanged and remain the PREFIX; F-008's observation
  // sources are appended, never substituted for them.
  assert.deepEqual([...BP002_WINDOW_SOURCES], ["native", "model-table", "model-map", "unknown"]);
  assert.deepEqual([...OBSERVED_WINDOW_SOURCES], ["observed-floor", "observed-promoted"]);
  assert.deepEqual([...WINDOW_SOURCES], [...BP002_WINDOW_SOURCES, ...OBSERVED_WINDOW_SOURCES]);
});

test("lookupWindow reports the matching entry's own source, per CLI contract (F-002)", () => {
  // BP-002.03 Gemini and BP-002.05 OpenCode read a model MAP, not the table.
  assert.equal(lookupWindow("gemini-3.5-flash").source, "model-map");
  assert.equal(lookupWindow("kimi-k2").source, "model-map");
  // BP-002.01 Claude and the Codex fallback read the versioned table.
  assert.equal(lookupWindow("claude-opus-5").source, "model-table");
  assert.equal(lookupWindow("gpt-5").source, "model-table");
});

test("a caller may override the reported source; a miss is still unknown", () => {
  assert.deepEqual(lookupWindow("gpt-5", { source: "native" }), { tokens: 400000, source: "native" });
  assert.deepEqual(lookupWindow("nemotron-3.5-lightning-free", { source: "native" }), { tokens: null, source: "unknown" });
  // Omitted, empty, or non-string overrides fall back to the entry's own source.
  assert.equal(lookupWindow("gemini-3.5-flash", {}).source, "model-map");
  assert.equal(lookupWindow("gemini-3.5-flash", { source: "" }).source, "model-map");
  assert.equal(lookupWindow("gemini-3.5-flash", { source: 7 }).source, "model-map");
  assert.equal(lookupWindow("gemini-3.5-flash").source, "model-map");
});

// ---------------------------------------------------------------------------
// resolveWindow — OBSERVATION OUTRANKS THE TABLE (F-008)
//
// Measured over the 120 largest real Claude sessions on this machine: 83 (69%)
// had a peak context above the table's 200,000, the largest 999,767, the median
// 411,351, and 96 of them were the plain id `claude-opus-5`. A session cannot
// hold more context than its window, so those peaks prove the TABLE wrong.
// ---------------------------------------------------------------------------

/** Session 1ecace68 from the F-008 measurement — the control case. */
const F008_CONTROL = Object.freeze({ sessionId: "1ecace68", model: "claude-opus-5", peak: 416200 });
/** Real peaks from the same measurement: max, median, control. */
const F008_REAL_PEAKS = Object.freeze([999767, 411351, 416200]);
/**
 * Real session 82aef9a3 (20-largest real-data gate): the peak that a SINGLE
 * global tier ladder promotes to OpenAI's 400,000, reporting 0.92 of window and
 * firing BP-003.01 against a Claude session whose real window is 1,000,000.
 */
const F008_CROSS_VENDOR = Object.freeze({ sessionId: "82aef9a3", model: "claude-opus-5", peak: 368963 });

test("KNOWN_WINDOW_TIERS is derived from the table itself: sorted, deduped, frozen", () => {
  assert.ok(Object.isFrozen(KNOWN_WINDOW_TIERS));
  const fromTable = [...new Set(MODEL_WINDOWS.map((entry) => entry.tokens))].sort((a, b) => a - b);
  assert.deepEqual([...KNOWN_WINDOW_TIERS], fromTable, "the ladder must not be a second hand-written copy");
  for (let i = 1; i < KNOWN_WINDOW_TIERS.length; i += 1) {
    assert.ok(KNOWN_WINDOW_TIERS[i - 1] < KNOWN_WINDOW_TIERS[i], "tiers must be ascending and unique");
  }
  assert.ok(KNOWN_WINDOW_TIERS.every((tier) => Number.isFinite(tier) && tier > 0));
});

test("smallestKnownTierAtLeast picks the tightest tier that could have held the context", () => {
  assert.equal(smallestKnownTierAtLeast(1), 200000);
  assert.equal(smallestKnownTierAtLeast(200000), 200000);
  assert.equal(smallestKnownTierAtLeast(200001), 262144);
  assert.equal(smallestKnownTierAtLeast(416200), 1000000);
  assert.equal(smallestKnownTierAtLeast(1000000), 1000000);
  // Larger than every window we know of: say so instead of inventing a tier.
  assert.equal(smallestKnownTierAtLeast(1000001), null);
  for (const bogus of [0, -1, NaN, Infinity, null, undefined, "400000", {}]) {
    assert.equal(smallestKnownTierAtLeast(bogus), null, `${JSON.stringify(bogus)} is not an observation`);
  }
});

test("every table entry declares a vendor, and the per-vendor ladders are derived from it", () => {
  assert.ok(Object.isFrozen(KNOWN_WINDOW_TIERS_BY_VENDOR));
  for (const entry of MODEL_WINDOWS) {
    assert.equal(typeof entry.vendor, "string", `${entry.id} declares no vendor`);
    assert.ok(entry.vendor.length > 0, `${entry.id} has an empty vendor`);
    const tiers = KNOWN_WINDOW_TIERS_BY_VENDOR[entry.vendor];
    assert.ok(Array.isArray(tiers) && Object.isFrozen(tiers), `${entry.vendor} has no frozen ladder`);
    assert.ok(tiers.includes(entry.tokens), `${entry.vendor} ladder is missing ${entry.id}'s ${entry.tokens}`);
  }
  // Anthropic ships 200k and 1M; it does not ship OpenAI's 400k.
  assert.deepEqual([...KNOWN_WINDOW_TIERS_BY_VENDOR.anthropic], [200000, 1000000]);
  assert.deepEqual([...KNOWN_WINDOW_TIERS_BY_VENDOR.openai], [400000]);
  // Every vendor ladder is a subset of the global one.
  for (const [vendor, tiers] of Object.entries(KNOWN_WINDOW_TIERS_BY_VENDOR)) {
    for (const tier of tiers) assert.ok(KNOWN_WINDOW_TIERS.includes(tier), `${vendor} ${tier} is off the global ladder`);
  }
});

// RE-AIMED, and renamed to say what changed.  It used to be "...OWN vendor tiers
// BEFORE the global ladder", and asserted that an exhausted vendor ladder fell
// through to the all-vendor one: `{vendor: "moonshot"}` at 300,000 -> OpenAI's
// 400,000, `{vendor: "openai"}` at 500,000 -> Anthropic's/Google's 1,000,000.
// "Before" WAS the defect.  The fall-through borrowed exactly the foreign window
// the vendor ladder exists to refuse, and it did so silently: `ladder: "global"`
// still yields a normal context share, so a session that had outgrown every
// window its own vendor ships read as an all-clear instead of an unknown.  Those
// two assertions are not weakened here, they are inverted: null is the answer.
test("a promotion uses the model's own vendor tiers and NOTHING else", () => {
  const { peak } = F008_CROSS_VENDOR;
  // All-vendor ladder alone would borrow OpenAI's 400,000 for a Claude session.
  assert.equal(smallestKnownTierAtLeast(peak), 400000, "precondition: the all-vendor ladder really does pick 400k");
  assert.equal(smallestKnownTierAtLeast(peak, { vendor: "anthropic" }), 1000000);
  assert.equal(smallestKnownTierAtLeast(200001, { vendor: "anthropic" }), 1000000);
  // Vendor ladder exhausted IS the null case.  Moonshot ships no 400,000 window
  // and OpenAI ships no 1,000,000 one, so neither may stand in for the other.
  assert.equal(smallestKnownTierAtLeast(300000, { vendor: "moonshot" }), null);
  assert.equal(smallestKnownTierAtLeast(500000, { vendor: "openai" }), null);
  // A named vendor the table knows no tiers for is that same case: nothing is
  // known about what it ships, and another vendor's number is not evidence.
  assert.equal(smallestKnownTierAtLeast(peak, { vendor: "nobody" }), null);
  // No vendor CLAIMED — a non-string is not a claim, nor is an empty one — so
  // the all-vendor ladder is the only knowledge there is and it still answers.
  assert.equal(smallestKnownTierAtLeast(peak, { vendor: 7 }), 400000);
  assert.equal(smallestKnownTierAtLeast(peak, { vendor: "" }), 400000);
});

/**
 * Both inputs are the validator's, verbatim.  Before the fix each one promoted
 * to a foreign tier and reported `ladder: "global"`, which `context-pressure`
 * treats as a real window: it only withholds a verdict on `ladder: "none"`.
 */
test("a session bigger than every window its OWN vendor ships has an UNKNOWN window, not a borrowed one", () => {
  const codex = resolveWindow("gpt-5-codex", { observedFloor: 500000 });
  assert.equal(codex.promotion.vendor, "openai");
  // 1,000,000 is an Anthropic/Google tier. OpenAI ships 400,000.
  assert.equal(codex.promotion.ladder, "none");
  assert.equal(codex.promotion.tier, null);
  assert.notEqual(codex.tokens, 1000000, "the tier this fix refuses");
  assert.equal(codex.tokens, 500000, "the window is the observed peak itself");
  assert.equal(codex.observedFloor, 500000, "so every share it could produce is 1.0 and none is emitted");
  assert.equal(codex.source, "observed-promoted");

  const kimi = resolveWindow("kimi-k2", { observedFloor: 300000 });
  assert.equal(kimi.promotion.vendor, "moonshot");
  // 400,000 is OpenAI's GPT-5 window, handed to a Moonshot model.
  assert.equal(kimi.promotion.ladder, "none");
  assert.equal(kimi.promotion.tier, null);
  assert.notEqual(kimi.tokens, 400000, "the tier this fix refuses");
  assert.equal(kimi.tokens, 300000);

  // The verdict this moves: a gpt-5-codex session averaging 476,667 read 0.48 of
  // a 1,000,000 window it does not have — a not-observed, i.e. an all-clear.
  // Against the 400,000 OpenAI really ships it is above 1.0, which is the
  // window-above-known-tiers case the context rule reports as unmeasurable.
  assert.ok(476667 / 1000000 < 0.7, "the borrowed window really did read as quiet");
  assert.ok(476667 / 400000 > 1, "its own vendor's largest window could not have held it");
});

test("the vendor-ladder promotion that already worked is untouched", () => {
  // Real session 82aef9a3: an Anthropic floor of 368,963 still promotes to the
  // Anthropic 1,000,000 tier. Removing the cross-vendor fall-through must not
  // cost the vendor-first behaviour anything.
  const resolved = resolveWindow(F008_CROSS_VENDOR.model, { observedFloor: F008_CROSS_VENDOR.peak });
  assert.equal(resolved.tokens, 1000000);
  assert.equal(resolved.promotion.ladder, "vendor");
  assert.equal(resolved.promotion.tier, 1000000);
});

test("matchWindowEntry names the winning entry, or nothing at all", () => {
  assert.equal(matchWindowEntry("claude-opus-5").id, "claude-family");
  assert.equal(matchWindowEntry("claude-sonnet-4-5-1m").id, "claude-1m-long-context");
  assert.equal(matchWindowEntry("claude-opus-5").vendor, "anthropic");
  for (const id of ["totally-made-up", "", "  ", null, undefined, 42, {}]) {
    assert.equal(matchWindowEntry(id), null, `${JSON.stringify(id)}`);
  }
});

test("a Claude session is never promoted to another vendor's window (real session 82aef9a3)", () => {
  const { model, peak, sessionId } = F008_CROSS_VENDOR;
  const resolved = resolveWindow(model, { observedFloor: peak, sessionId });
  assert.equal(resolved.tokens, 1000000, "an Anthropic session gets an Anthropic window");
  assert.notEqual(resolved.tokens, 400000, "400,000 is OpenAI's tier, not Anthropic's");
  assert.equal(resolved.promotion.vendor, "anthropic");
  assert.equal(resolved.promotion.tableEntry, "claude-family");
  assert.equal(resolved.promotion.ladder, "vendor");
  const fraction = peak / resolved.tokens;
  assert.ok(fraction < 0.7, `BP-003.01 must not fire for ${sessionId} at ${fraction}`);
  assert.equal(Number(fraction.toFixed(3)), 0.369);
  // Under the borrowed 400,000 tier this same session read 0.92 and warned.
  assert.ok(peak / 400000 > 0.7, "the tier this fix rejects really did trip the alarm");
});

test("peakContextTokens returns the session peak, and null when nothing was measured", () => {
  const turns = [
    normalizeTurn({ context: { inputTokens: 120000 } }),
    normalizeTurn({ context: { inputTokens: 416200 } }),
    normalizeTurn({ context: { inputTokens: 90000 } }),
    normalizeTurn(),
  ];
  assert.equal(peakContextTokens(turns), 416200);
  // Bare shapes and plain counts are accepted too, so a collector can pass its
  // own pre-normalized numbers.
  assert.equal(peakContextTokens([{ inputTokens: 5 }, { inputTokens: 9 }]), 9);
  assert.equal(peakContextTokens([5, 9, 7]), 9);
  // An unmeasured session is null, never a window of zero.
  assert.equal(peakContextTokens([normalizeTurn(), normalizeTurn()]), null);
  assert.equal(peakContextTokens([{ context: { inputTokens: 0 } }, null, "x", {}]), null);
  assert.equal(peakContextTokens([]), null);
  assert.equal(peakContextTokens("not an array"), null);
  assert.equal(peakContextTokens(), null);
});

test("resolveWindow keeps the table when the session never exceeded it", () => {
  // Below the table window.
  assert.deepEqual(resolveWindow("claude-opus-5", { observedFloor: 150000 }), {
    tokens: 200000, source: "model-table", observedFloor: 150000, promotion: null,
  });
  // Exactly at it — consistent, so still the table's reading.
  assert.deepEqual(resolveWindow("claude-opus-5", { observedFloor: 200000 }), {
    tokens: 200000, source: "model-table", observedFloor: 200000, promotion: null,
  });
  // No observation at all: unchanged pre-F-008 behaviour.
  assert.deepEqual(resolveWindow("claude-opus-5"), {
    tokens: 200000, source: "model-table", observedFloor: null, promotion: null,
  });
  // Each CLI keeps its own source, and an explicit override still applies.
  assert.equal(resolveWindow("gemini-3.5-flash", { observedFloor: 10 }).source, "model-map");
  assert.equal(resolveWindow("kimi-k2", { observedFloor: 10 }).source, "model-map");
  assert.equal(resolveWindow("gpt-5", { observedFloor: 10, source: "native" }).source, "native");
  // A bogus floor is not an observation and cannot promote anything.
  for (const bogus of [0, -1, NaN, "999999999", null, undefined]) {
    assert.deepEqual(resolveWindow("claude-opus-5", { observedFloor: bogus }).tokens, 200000, `${JSON.stringify(bogus)}`);
  }
});

test("an observed peak above the table promotes to the next known tier (F-008)", () => {
  const resolved = resolveWindow(F008_CONTROL.model, {
    observedFloor: F008_CONTROL.peak,
    sessionId: F008_CONTROL.sessionId,
  });
  assert.equal(resolved.tokens, 1000000, "416,200 cannot fit a 200,000 window");
  assert.equal(resolved.source, "observed-promoted");
  assert.equal(resolved.observedFloor, F008_CONTROL.peak);
  // The stale entry is VISIBLE in the promotion, not silently papered over.
  assert.equal(resolved.promotion.tableTokens, 200000);
  assert.equal(resolved.promotion.tableSource, "model-table");
  assert.equal(resolved.promotion.modelId, "claude-opus-5");
  assert.equal(resolved.promotion.sessionId, "1ecace68");
  assert.equal(resolved.promotion.observedFloor, F008_CONTROL.peak);
  assert.equal(resolved.promotion.tier, 1000000);
  assert.equal(resolved.promotion.tokens, 1000000);
  assert.equal(resolved.promotion.tableVersion, MODEL_WINDOWS_VERSION);
  assert.equal(resolved.promotion.tableEntry, "claude-family");
  assert.equal(resolved.promotion.vendor, "anthropic");
  assert.equal(resolved.promotion.ladder, "vendor");
});

test("a session larger than every known tier resolves to its own observed floor", () => {
  const beyond = 1500000;
  assert.equal(smallestKnownTierAtLeast(beyond), null, "precondition: no tier fits");
  // A table entry exists and is provably wrong, so this is still a promotion —
  // the reading is the floor because inventing a rounder window would be a guess.
  const promoted = resolveWindow("claude-opus-5", { observedFloor: beyond });
  assert.equal(promoted.tokens, beyond);
  assert.equal(promoted.source, "observed-promoted");
  assert.equal(promoted.promotion.tier, null);
  assert.equal(promoted.promotion.ladder, "none");
  assert.equal(promoted.promotion.tableTokens, 200000);
});

test("with no table entry, the observed peak is the window and says so", () => {
  assert.deepEqual(resolveWindow("nemotron-3.5-lightning-free", { observedFloor: 300000 }), {
    tokens: 300000, source: "observed-floor", observedFloor: 300000, promotion: null,
  });
  // Nothing was promoted, because there was no table claim to correct.
  const diagnostic = createDiagnostic("test");
  resolveWindow("totally-made-up", { observedFloor: 12345678, diagnostic });
  assert.deepEqual(windowPromotions(diagnostic), []);
  assert.equal(resolveWindow("totally-made-up", { observedFloor: 12345678 }).tokens, 12345678);
});

test("no table entry and no observation stays honestly unknown", () => {
  for (const id of ["nemotron-3.5-lightning-free", "", "   ", null, undefined, 42]) {
    assert.deepEqual(resolveWindow(id), {
      tokens: null, source: "unknown", observedFloor: null, promotion: null,
    }, `${JSON.stringify(id)}`);
  }
  assert.deepEqual(resolveWindow("totally-made-up", { observedFloor: 0 }), {
    tokens: null, source: "unknown", observedFloor: null, promotion: null,
  });
  // An unknown model with an override is still unknown — never a guessed window.
  assert.equal(resolveWindow("totally-made-up", { source: "native" }).tokens, null);
});

test("every promotion lands in the collector diagnostic; a good table adds none", () => {
  const diagnostic = createDiagnostic("claude");
  assert.deepEqual(windowPromotions(diagnostic), [], "an untouched diagnostic reads as no promotions");

  resolveWindow("claude-opus-5", { observedFloor: 150000, diagnostic, sessionId: "fits" });
  resolveWindow("claude-sonnet-4-5-1m", { observedFloor: 900000, diagnostic, sessionId: "fits-1m" });
  assert.deepEqual(windowPromotions(diagnostic), [], "a table window that holds must not be recorded");

  resolveWindow("claude-opus-5", { observedFloor: 416200, diagnostic, sessionId: "a" });
  resolveWindow("claude-haiku-4-5-20251001", { observedFloor: 999767, diagnostic, sessionId: "b" });
  const recorded = windowPromotions(diagnostic);
  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded.map((p) => p.sessionId), ["a", "b"]);
  assert.deepEqual(recorded.map((p) => p.tokens), [1000000, 1000000]);
  assert.ok(recorded.every((p) => p.tableTokens === 200000 && Object.isFrozen(p)));
  // The diagnostic's own shape is untouched until a promotion happens, so
  // createDiagnostic's BP-002.08 contract is unchanged.
  assert.ok(!Object.hasOwn(createDiagnostic("claude"), "windowPromotions"));
  // A missing or non-object diagnostic is not an error.
  assert.equal(resolveWindow("claude-opus-5", { observedFloor: 416200 }).tokens, 1000000);
  assert.equal(resolveWindow("claude-opus-5", { observedFloor: 416200, diagnostic: null }).tokens, 1000000);
});

test("resolveWindow can never emit a context fraction above 1.0 (F-008 regression)", () => {
  // The pre-fix reading really was broken: this is the number the UI showed.
  const tableOnly = lookupWindow(F008_CONTROL.model);
  assert.equal(tableOnly.tokens, 200000);
  assert.equal(Number((F008_CONTROL.peak / tableOnly.tokens).toFixed(2)), 2.08, "the 208%-of-window reading");

  for (const peak of F008_REAL_PEAKS) {
    const resolved = resolveWindow(F008_CONTROL.model, { observedFloor: peak });
    const fraction = peak / resolved.tokens;
    assert.ok(fraction <= 1, `peak ${peak} against window ${resolved.tokens} gives fraction ${fraction}`);
    assert.equal(resolved.source, "observed-promoted");
  }

  // The control session must not trip BP-003.01 (warn above 0.70 x window).
  const control = resolveWindow(F008_CONTROL.model, { observedFloor: F008_CONTROL.peak });
  const fraction = F008_CONTROL.peak / control.tokens;
  assert.equal(control.tokens, 1000000);
  assert.ok(fraction < 0.7, `BP-003.01 must not fire for session ${F008_CONTROL.sessionId} at ${fraction}`);
  assert.equal(Number(fraction.toFixed(4)), 0.4162);

  // ...but a session genuinely near its window must STILL warn. The fix removes
  // false alarms; it does not silence real context pressure.
  const heavy = resolveWindow(F008_CONTROL.model, { observedFloor: 999767 });
  assert.equal(heavy.tokens, 1000000);
  assert.ok(999767 / heavy.tokens > 0.7, "a session at ~100% of a 1M window must still trip BP-003.01");

  // Whatever resolveWindow reports, its window holds the observation.
  for (const [model, peak] of [["claude-opus-5", 500], ["gpt-5", 450000], ["kimi-k2", 262145],
    ["totally-made-up", 777000], ["gemini-3-pro", 1000001]]) {
    const resolved = resolveWindow(model, { observedFloor: peak });
    assert.ok(resolved.tokens >= peak, `${model} window ${resolved.tokens} < observed ${peak}`);
    assert.ok(WINDOW_SOURCES.includes(resolved.source), `${model} source ${resolved.source} is undeclared`);
  }
});

test("a resolved window drops straight into normalizeSession as a BP-002 window", () => {
  const turns = [{ context: { inputTokens: 200000 } }, { context: { inputTokens: 416200 } }];
  const observedFloor = peakContextTokens(turns);
  const resolved = resolveWindow("claude-opus-5", { observedFloor, sessionId: "1ecace68" });
  const session = normalizeSession({ cli: "claude", model: "claude-opus-5", window: resolved, turns });
  // The session carries exactly BP-002's two window keys — the promotion detail
  // stays on the diagnostic, not smuggled into the normalized shape.
  assert.deepEqual(session.window, { tokens: 1000000, source: "observed-promoted" });
  assert.equal(session.turns.length, 2);
  for (const turn of session.turns) {
    assert.ok(turn.context.inputTokens / session.window.tokens <= 1);
  }
});

// ---------------------------------------------------------------------------
// normalizers — missing data stays null, zero is never substituted
// ---------------------------------------------------------------------------

test("normalizeTurn fills every absent field with null, not zero", () => {
  assert.deepEqual(normalizeTurn(), {
    ts: null,
    context: { inputTokens: null, fraction: null, source: "unknown" },
    cacheRead: null,
    cacheCreate: null,
    output: null,
    toolCalls: [],
    toolResultBytes: null,
    isSidechain: null,
  });
});

test("normalizeTurn keeps a real zero and a real false", () => {
  const turn = normalizeTurn({
    ts: "2026-09-20T10:00:00.000Z",
    context: { inputTokens: 0, fraction: 0, source: "native" },
    cacheRead: 0,
    cacheCreate: 0,
    output: 0,
    toolResultBytes: 0,
    isSidechain: false,
  });
  assert.equal(turn.context.inputTokens, 0);
  assert.equal(turn.context.fraction, 0);
  assert.equal(turn.cacheRead, 0);
  assert.equal(turn.cacheCreate, 0);
  assert.equal(turn.output, 0);
  assert.equal(turn.toolResultBytes, 0);
  assert.equal(turn.isSidechain, false);
  assert.equal(turn.context.source, "native");
});

test("normalizeTurn normalizes tool calls and drops a non-array toolCalls", () => {
  const turn = normalizeTurn({
    toolCalls: [
      { id: "toolu_1", name: "Bash", input: { command: "ls" } },
      { id: null, name: "Read", input: 0 },
      {},
      null,
    ],
  });
  assert.deepEqual(turn.toolCalls, [
    { id: "toolu_1", name: "Bash", input: { command: "ls" } },
    { id: null, name: "Read", input: 0 },
    { id: null, name: null, input: null },
    { id: null, name: null, input: null },
  ]);
  assert.deepEqual(normalizeTurn({ toolCalls: "nope" }).toolCalls, []);
});

test("normalizeSession fills an absent window with unknown and normalizes its turns", () => {
  assert.deepEqual(normalizeSession(), {
    cli: null,
    support: "supported",
    sessionId: null,
    project: null,
    cwd: null,
    model: null,
    window: { tokens: null, source: "unknown" },
    startedAt: null,
    endedAt: null,
    turns: [],
  });

  const session = normalizeSession({
    cli: "claude",
    window: lookupWindow("claude-sonnet-4-5-1m"),
    turns: [{ ts: "2026-09-20T10:00:00.000Z" }],
  });
  assert.deepEqual(session.window, { tokens: 1000000, source: "model-table" });
  assert.equal(session.turns.length, 1);
  assert.deepEqual(session.turns[0].context, { inputTokens: null, fraction: null, source: "unknown" });
  assert.deepEqual(normalizeSession({ turns: { not: "an array" } }).turns, []);
});

// ---------------------------------------------------------------------------
// diagnostics and safeReadJsonl — BP-002.08 robustness
// ---------------------------------------------------------------------------

test("createDiagnostic starts empty and carries the cli", () => {
  assert.deepEqual(createDiagnostic("claude"), {
    cli: "claude",
    filesScanned: 0,
    filesSkipped: 0,
    linesSkipped: 0,
    truncated: [],
    errors: [],
  });
  assert.equal(createDiagnostic().cli, "unknown");
});

test("safeReadJsonl skips a malformed line and keeps the valid records", async () => {
  const { records, diagnostic } = await readAll(CORRUPT);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.message.id), ["msg_ok", "msg_ok2"]);
  assert.equal(diagnostic.linesSkipped, 1);
  assert.equal(diagnostic.filesScanned, 1);
  assert.equal(diagnostic.filesSkipped, 0);
  assert.deepEqual(diagnostic.errors, []);
});

test("safeReadJsonl reads an empty or whitespace-only file without complaint", async () => {
  for (const file of [EMPTY, WHITESPACE]) {
    const { records, diagnostic } = await readAll(file);
    assert.deepEqual(records, [], file);
    assert.equal(diagnostic.linesSkipped, 0, file);
    assert.equal(diagnostic.filesSkipped, 0, file);
    assert.deepEqual(diagnostic.errors, [], file);
  }
});

test("safeReadJsonl records a missing file or a directory as skipped instead of throwing", async () => {
  const missing = await readAll(MISSING);
  assert.deepEqual(missing.records, []);
  assert.equal(missing.diagnostic.filesSkipped, 1);
  assert.equal(missing.diagnostic.errors.length, 1);

  const dir = await readAll(ROBUST);
  assert.deepEqual(dir.records, []);
  assert.equal(dir.diagnostic.filesSkipped, 1);
  assert.deepEqual(dir.diagnostic.errors, []);
});

test("safeReadJsonl flags a file over maxBytes as truncated", async () => {
  const { diagnostic } = await readAll(BARE, { maxBytes: 1 });
  assert.ok(diagnostic.truncated.includes(BARE), "an oversized file must be reported truncated");
});

test("safeReadJsonl records an onRecord failure and keeps reading", async () => {
  const seen = [];
  const diagnostic = await safeReadJsonl(CORRUPT, (record) => {
    seen.push(record.message.id);
    throw new Error(`boom ${record.message.id}`);
  }, { cli: "test" });
  assert.deepEqual(seen, ["msg_ok", "msg_ok2"]);
  assert.deepEqual(diagnostic.errors, ["boom msg_ok", "boom msg_ok2"]);
  assert.equal(diagnostic.linesSkipped, 1);
});

test("safeReadJsonl accumulates into a caller-supplied diagnostic across files", async () => {
  const diagnostic = createDiagnostic("claude");
  await safeReadJsonl(BARE, () => {}, { diagnostic });
  await safeReadJsonl(CORRUPT, () => {}, { diagnostic });
  assert.equal(diagnostic.cli, "claude");
  assert.equal(diagnostic.filesScanned, 2);
  assert.equal(diagnostic.linesSkipped, 1);
});

test("safeReadLines is the same reader under its legacy name", () => {
  assert.equal(safeReadLines, safeReadJsonl);
});

// ---------------------------------------------------------------------------
// F-005: a line ends at \n and nowhere else
//
// `node:readline` also terminates a line on U+2028 and U+2029, which JSON
// permits RAW inside a string.  One legal record in, zero records out — and
// every collector shares this reader.  These tests fail if the reader ever goes
// back to a line splitter that treats those characters as terminators.
// ---------------------------------------------------------------------------

/** A JSONL file in a fresh temp dir; `lines` is written verbatim. */
function tempJsonl(text, name = "records.jsonl") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "session-rx-base-"));
  const file = path.join(dir, name);
  writeFileSync(file, text, "utf8");
  return file;
}

test("one record holding a raw U+2028 parses as exactly 1 record, 0 skipped (F-005)", async () => {
  // JSON.stringify does NOT escape U+2028, so the character reaches the file raw.
  const record = { type: "assistant", message: { id: "m1", text: `quote: second visual line` } };
  const serialized = JSON.stringify(record);
  assert.ok(serialized.includes(" "), "the fixture must carry a RAW U+2028, not an escape");

  const { records, diagnostic } = await readAll(tempJsonl(`${serialized}\n`));
  assert.equal(records.length, 1, "one line in, one record out");
  assert.equal(diagnostic.linesSkipped, 0, "nothing was unparseable, so nothing may be skipped");
  assert.deepEqual(records[0], record, "the record survives byte for byte, separator included");
});

test("U+2028 and U+2029 survive in a committed fixture, in strings and in pairs", async () => {
  const { records, diagnostic } = await readAll(LINE_SEPARATOR);
  assert.equal(records.length, 3);
  assert.equal(diagnostic.linesSkipped, 0);
  assert.deepEqual(records.map((r) => r.message.id), ["msg_ls", "msg_ps", "msg_both"]);
  assert.ok(records[0].message.content[0].text.includes(" "));
  assert.ok(records[1].message.content[0].text.includes(" "));
  assert.equal(records[2].message.content[0].text, "  both, twice:  ");
});

test("a record straddling a read-chunk boundary is stitched back together", async () => {
  // The stream reads 64 KB at a time, so a 300 KB file guarantees records split
  // across chunks — including one single record far larger than one chunk.
  const filler = "x".repeat(90 * 1024);
  const rows = [
    { id: "first", pad: "a".repeat(70 * 1024) },
    { id: "huge", pad: filler, tail: `${filler} end` },
    { id: "last", pad: "z".repeat(70 * 1024) },
  ];
  const { records, diagnostic } = await readAll(tempJsonl(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`));
  assert.deepEqual(records.map((r) => r.id), ["first", "huge", "last"]);
  assert.equal(diagnostic.linesSkipped, 0);
  assert.ok(records[1].tail.endsWith(" end"), "the separator inside a straddling record is preserved");
});

test("a final line with no trailing newline is still a record", async () => {
  const { records, diagnostic } = await readAll(tempJsonl('{"id":"a"}\n{"id":"b"}'));
  assert.deepEqual(records.map((r) => r.id), ["a", "b"]);
  assert.equal(diagnostic.linesSkipped, 0);
});

test("CRLF line endings yield the same records as LF", async () => {
  const { records, diagnostic } = await readAll(tempJsonl('{"id":"a"}\r\n{"id":"b"}\r\n'));
  assert.deepEqual(records.map((r) => r.id), ["a", "b"]);
  assert.equal(diagnostic.linesSkipped, 0);
});

test("a line cut off by the byte cap is never handed over as a record", async () => {
  const file = tempJsonl('{"id":"a"}\n{"id":"b"}\n');
  const { records, diagnostic } = await readAll(file, { maxBytes: 12 });
  assert.deepEqual(records, [], "half a record is not a record");
  assert.ok(diagnostic.truncated.includes(file));
  assert.equal(diagnostic.linesSkipped, 0, "a capped read is truncation, not unreadable data");
});

// ---------------------------------------------------------------------------
// Collector base class
// ---------------------------------------------------------------------------

test("Collector defaults to an absent, empty collector", async () => {
  assert.equal(Collector, NamedCollector);
  const bare = new Collector();
  assert.equal(bare.id, "unknown");
  assert.equal(bare.displayName, "unknown");
  assert.deepEqual(bare.detect(), { installed: false, paths: [], status: "absent" });
  assert.deepEqual(await bare.collect(), []);

  const named = new Collector({ id: "claude", displayName: "Claude Code" });
  assert.equal(named.cli, "claude");
  assert.equal(named.displayName, "Claude Code");
  assert.equal(new Collector({ id: "kimi", cli: "kimi-cli" }).cli, "kimi-cli");
});
