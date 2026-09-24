import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

/** Build SQLite's read-only URI form for POSIX and Windows file paths. */
export function readOnlyFileUri(filePath) {
  let p = path.resolve(filePath);
  // A Windows-shaped input must remain a drive-letter path on POSIX too.
  if (/^[A-Za-z]:[\\/]/.test(filePath)) p = filePath;
  p = p.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  // Escape % first so the escapes for ? and # are not re-escaped.
  p = p.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23");
  return `file://${p}?mode=ro`;
}

/**
 * Open SQLite read-only even on runtimes that reject a URI filename.
 * `{ readOnly: true }` is the real SQLITE_OPEN_READONLY flag on both attempts;
 * the URI's `mode=ro` applies the same guarantee through another route.
 */
export function openReadOnlySqlite(DatabaseSync, filePath) {
  try {
    return { db: new DatabaseSync(readOnlyFileUri(filePath), { readOnly: true }), uriSupported: true };
  } catch {
    return { db: new DatabaseSync(path.resolve(filePath), { readOnly: true }), uriSupported: false };
  }
}

// Bumped on every change to MODEL_WINDOW_ENTRIES *or* to how they are
// resolved.  `.3` demotes the table from authority to PRIOR: `resolveWindow`
// lets a session's own observed peak context override it (F-008).
export const MODEL_WINDOWS_VERSION = "2026-09-20.3";
export const VERSION = MODEL_WINDOWS_VERSION;

/** The `window.source` values BP-002 names for a table/map/native reading. */
export const BP002_WINDOW_SOURCES = Object.freeze(["native", "model-table", "model-map", "unknown"]);

/**
 * The sources `resolveWindow` adds when OBSERVATION outranks the table (F-008):
 *   observed-floor    — no table entry; the observed peak is all the evidence
 *                       there is, and it is a valid lower bound on the window.
 *   observed-promoted — a table entry EXISTS and is provably too small for what
 *                       this session actually held.  The reading is the session's,
 *                       and the stale entry is recorded as a promotion.
 */
export const OBSERVED_WINDOW_SOURCES = Object.freeze(["observed-floor", "observed-promoted"]);

/** Every `window.source` value SessionRx may emit; BP-002's four come first. */
export const WINDOW_SOURCES = Object.freeze([...BP002_WINDOW_SOURCES, ...OBSERVED_WINDOW_SOURCES]);

// Values are deliberately approximate where the vendor exposes a family-sized
// context window.  Unknown model IDs must remain unknown rather than guessing.
//
// RESOLUTION ORDER IS DECLARED, NOT POSITIONAL.  `specificity` decides which
// entry wins and declaration order only breaks ties, so an entry cannot be
// smothered by where it happens to sit in the list.  That was the F-001 bug: a
// family fallback such as /claude-...sonnet/ also matches the long-context id
// `claude-sonnet-4-5-1m`, so with a plain top-down scan the 1M entry could
// never win and was unreachable dead code (INV-1).  A 1M session scored
// against a 200k window trips the BP-003.01 context alarm at 140k instead of
// 700k, i.e. it mis-diagnoses exactly the heaviest sessions.
//
//   specificity 30 = a named long-context / variant window (most specific)
//   specificity 10 = a vendor family fallback (least specific)
//
// `vendor` groups entries that ship the same window SIZES.  A context window is
// a vendor property, so when observation proves the table wrong (F-008) the
// promotion ladder is that vendor's own tiers and ONLY those: a Claude session's
// window is a Claude window, never OpenAI's 400,000 — and a session past the
// largest window its own vendor ships has an unknown window, not a borrowed one.
//
// `source` is per entry because BP-002 names the mechanism per CLI: Claude
// (BP-002.01) and the Codex fallback read a versioned model-id TABLE, while a
// CLI whose sessions can run on someone else's model — Cursor, which reports
// whatever underlying model the session actually used — reads a model-id MAP.
// Callers that know better may override it with lookupWindow(id, { source }).
//
// `examples` are load-bearing, not documentation: tests/collectors/base.test.js
// asserts that every entry is the winning match for each of its own examples.
// A new entry with no example, or one that another entry already swallows,
// fails that test — which is what stops F-001 recurring.
const MODEL_WINDOW_ENTRIES = [
  {
    id: "claude-1m-long-context",
    vendor: "anthropic",
    pattern: /claude-(?:opus|sonnet|haiku)[^ ]*1m|1m[^ ]*claude/i,
    tokens: 1000000,
    source: "model-table",
    specificity: 30,
    examples: ["claude-sonnet-4-5-1m", "claude-sonnet-4-5[1m]", "1m-claude-opus-4-1"],
  },
  {
    id: "claude-family",
    vendor: "anthropic",
    pattern: /claude-(?:3[. -]?7|3[. -]?5|3|4|opus|sonnet|haiku)/i,
    tokens: 200000,
    source: "model-table",
    specificity: 10,
    examples: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  },
  {
    // Model name, not CLI: Cursor sessions can run on Gemini models, so this
    // entry stays even though the Gemini CLI reader is gone.
    id: "gemini-family",
    vendor: "google",
    pattern: /gemini-(?:2|3)(?:[. -]?\d+)?/i,
    tokens: 1000000,
    source: "model-map",
    specificity: 10,
    examples: ["gemini-3.5-flash", "gemini-3-pro", "gemini-2.5-flash"],
  },
  {
    id: "gpt-5-family",
    vendor: "openai",
    pattern: /gpt-5(?:[.-]?\w*)?/i,
    tokens: 400000,
    source: "model-table",
    specificity: 10,
    examples: ["gpt-5", "gpt-5-codex"],
  },
  {
    // Model name, not CLI: Cursor can run a Kimi model.
    id: "kimi-k2-family",
    vendor: "moonshot",
    pattern: /kimi[-_ ]?k2/i,
    tokens: 262144,
    source: "model-map",
    specificity: 10,
    examples: ["kimi-k2", "kimi_k2-turbo"],
  },
];

/**
 * MODEL_WINDOW_ENTRIES in resolution order: most specific first, declaration
 * order breaking ties.  This array IS the order `lookupWindow` scans.
 */
export const MODEL_WINDOWS = Object.freeze(
  MODEL_WINDOW_ENTRIES
    .map((entry, declaredAt) => ({ entry, declaredAt }))
    .sort((a, b) => b.entry.specificity - a.entry.specificity || a.declaredAt - b.declaredAt)
    .map(({ entry }) => Object.freeze({ ...entry, examples: Object.freeze([...entry.examples]) })),
);

/**
 * Resolve a model id to its context window.
 *
 * @param {string} modelId
 * @param {{source?: string}} [options] reported source override; when omitted
 *   the matching entry's own source is used, falling back to "model-table".
 * @returns {{tokens: number|null, source: string}} an unrecognised or empty id
 *   returns {tokens: null, source: "unknown"} — never a guessed window.
 */
export function matchWindowEntry(modelId) {
  if (typeof modelId !== "string" || !modelId.trim()) return null;
  return MODEL_WINDOWS.find(({ pattern }) => pattern.test(modelId)) ?? null;
}

export function lookupWindow(modelId, options = {}) {
  const match = matchWindowEntry(modelId);
  if (!match) return { tokens: null, source: "unknown" };
  const override = options?.source;
  const source = typeof override === "string" && override ? override : match.source ?? "model-table";
  return { tokens: match.tokens, source };
}

// ---------------------------------------------------------------------------
// OBSERVATION OUTRANKS THE TABLE (F-008)
//
// A session cannot hold more context than its window.  So an observed peak
// context ABOVE the table's window does not mean the measurement is wrong — it
// proves the TABLE is wrong for that session.  Measured over the 120 largest
// real Claude sessions on this machine, 83 (69%) had a peak above the table's
// 200,000, the largest 999,767, and 96 of them were the plain model id
// `claude-opus-5`: that id plainly runs a 1,000,000 window and does not say so.
// No model-id table can ever say so, because the long-context tier is a
// request-time property, not a name.
//
// Left to the table alone, BP-003.01 (warn above 0.70 x window) would fire on
// 69% of real sessions and the UI would report "208% of window" — loudest
// against the heaviest, best-configured users.  Hence: the table is a PRIOR,
// the session's own peak is EVIDENCE, and evidence wins.  A fraction above 1.0
// is never emitted as a normal reading; it surfaces as the table defect it is.
// ---------------------------------------------------------------------------

/**
 * The window sizes this table has actually seen a vendor ship, smallest first.
 * DERIVED from MODEL_WINDOW_ENTRIES rather than written out a second time, so a
 * new entry extends the ladders automatically and the two can never drift apart.
 *
 * IT IS NOT THE PROMOTION LADDER.  Promotion goes by vendor
 * (`KNOWN_WINDOW_TIERS_BY_VENDOR`); this all-vendor list answers only a
 * `smallestKnownTierAtLeast` call that names no vendor, and it is what the
 * per-vendor ladders are checked to be subsets of.
 */
export const KNOWN_WINDOW_TIERS = Object.freeze(
  [...new Set(MODEL_WINDOWS.map((entry) => entry.tokens))]
    .filter((tokens) => Number.isFinite(tokens) && tokens > 0)
    .sort((a, b) => a - b),
);

/**
 * The same ladder split by vendor: the window sizes each vendor is KNOWN to
 * ship.  Also derived from the table, for the same reason.
 */
export const KNOWN_WINDOW_TIERS_BY_VENDOR = Object.freeze(
  Object.fromEntries(
    [...new Set(MODEL_WINDOWS.map((entry) => entry.vendor).filter(Boolean))].map((vendor) => [
      vendor,
      Object.freeze(
        [...new Set(MODEL_WINDOWS.filter((entry) => entry.vendor === vendor).map((entry) => entry.tokens))]
          .filter((tokens) => Number.isFinite(tokens) && tokens > 0)
          .sort((a, b) => a - b),
      ),
    ]),
  ),
);

/** A usable observed floor, or null. Zero and negatives are not observations. */
function asObservedFloor(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Peak per-turn context in a session — the hard lower bound on its true window.
 *
 * @param {Array<{context?: {inputTokens?: number|null}}|{inputTokens?: number|null}|number>} turns
 *   normalized turns, bare `{inputTokens}` shapes, or plain token counts.
 * @returns {number|null} null when no turn carried a usable context reading,
 *   so an absent measurement never masquerades as a window of zero.
 */
export function peakContextTokens(turns) {
  if (!Array.isArray(turns)) return null;
  let peak = null;
  for (const turn of turns) {
    let raw;
    if (typeof turn === "number") {
      raw = turn;
    } else if (turn && typeof turn === "object") {
      const context = turn.context && typeof turn.context === "object" ? turn.context : turn;
      raw = context.inputTokens;
    }
    const tokens = asObservedFloor(raw);
    if (tokens !== null && (peak === null || tokens > peak)) peak = tokens;
  }
  return peak;
}

/**
 * Smallest KNOWN window tier that could have held `tokens`, or null if none can.
 *
 * With a `vendor`, ONLY that vendor's own tiers may answer.  This is not a
 * nicety: measured on real data, a `claude-opus-5` session peaking at 368,963
 * promotes to OpenAI's 400,000 under a single all-vendor ladder, reporting 0.92
 * of window and tripping the BP-003.01 context alarm — a false alarm of exactly
 * the kind F-008 exists to remove.  Anthropic ships 200,000 and 1,000,000
 * windows, not 400,000, so its own ladder gives 1,000,000 and a truthful 0.37.
 *
 * EXHAUSTING THE VENDOR'S OWN LADDER IS `null`, NOT A FALL-THROUGH.  The
 * all-vendor ladder used to answer when the vendor's own tiers ran out, which
 * borrowed the very window this function exists to refuse: `gpt-5-codex` at an
 * observed 500,000 was handed Anthropic's 1,000,000.  That is worse than
 * refusing, because a foreign tier is a plausible-looking number: a gpt-5-codex session averaging
 * 476,667 measured 0.48 of a 1,000,000 window it does not have, i.e. an
 * all-clear, where its own 400,000 ladder says it exceeded every window OpenAI
 * is known to ship.  A session bigger than every tier its OWN vendor ships has
 * an unknown window, and `resolveWindow` reports exactly that (`ladder:
 * "none"`), so no context share is derived from another vendor's number.
 *
 * A named vendor the table knows no tiers for is the same case: nothing is
 * known about what it ships, and another vendor's window is not evidence about
 * it.  WITHOUT a vendor no claim is made about whose window it is, so the
 * all-vendor ladder is the only knowledge there is and it still answers.
 *
 * @param {number|null} tokens observed floor
 * @param {{vendor?: string}} [options]
 */
export function smallestKnownTierAtLeast(tokens, options = {}) {
  const floor = asObservedFloor(tokens);
  if (floor === null) return null;
  const vendor = typeof options?.vendor === "string" && options.vendor ? options.vendor : null;
  if (vendor !== null) {
    const own = KNOWN_WINDOW_TIERS_BY_VENDOR[vendor] ?? [];
    return own.find((tier) => tier >= floor) ?? null;
  }
  return KNOWN_WINDOW_TIERS.find((tier) => tier >= floor) ?? null;
}

/** Append a promotion to a collector diagnostic, if one was supplied. */
function recordWindowPromotion(diagnostic, promotion) {
  if (!diagnostic || typeof diagnostic !== "object") return;
  if (!Array.isArray(diagnostic.windowPromotions)) diagnostic.windowPromotions = [];
  diagnostic.windowPromotions.push(promotion);
}

/**
 * Promotions recorded on a diagnostic. Absent array reads as none, so callers
 * never have to know that `createDiagnostic` leaves the key off until needed.
 */
export function windowPromotions(diagnostic) {
  return Array.isArray(diagnostic?.windowPromotions) ? diagnostic.windowPromotions : [];
}

/**
 * Resolve a session's context window from the table AND what the session held.
 *
 * `{tokens, source}` is a superset of the BP-002 `window` shape, so the result
 * drops straight into `normalizeSession({window})`; the extra keys are for the
 * caller and are not carried into the normalized session.
 *
 * @param {string} modelId
 * @param {{observedFloor?: number|null, source?: string, diagnostic?: object, sessionId?: string}} [options]
 *   `observedFloor` is `peakContextTokens(turns)` — the collector's own peak.
 *   `source` overrides the reported source of the TABLE reading only.
 *   `diagnostic` collects promotions so a stale entry stays VISIBLE.
 * @returns {{tokens: number|null, source: string, observedFloor: number|null,
 *   promotion: object|null}} `tokens` is always >= `observedFloor`, so no
 *   caller can derive a context fraction above 1.0 from it.
 */
export function resolveWindow(modelId, options = {}) {
  const observedFloor = asObservedFloor(options?.observedFloor);
  const entry = matchWindowEntry(modelId);
  const table = lookupWindow(modelId, options);

  // No table entry: observation is the only evidence there is.
  if (table.tokens === null) {
    if (observedFloor === null) {
      return { tokens: null, source: "unknown", observedFloor: null, promotion: null };
    }
    return { tokens: observedFloor, source: "observed-floor", observedFloor, promotion: null };
  }

  // The table is consistent with what the session actually held: keep it, and
  // keep reporting it as the table reading it is.
  if (observedFloor === null || observedFloor <= table.tokens) {
    const result = { tokens: table.tokens, source: table.source, observedFloor, promotion: null };
    // A plain model id can match more than one vendor tier. Keep the existing
    // table number for compatibility, but mark it when the log cannot say
    // which of the vendor's tiers applied.
    const vendorTiers = entry?.vendor ? KNOWN_WINDOW_TIERS_BY_VENDOR[entry.vendor] ?? [] : [];
    if (vendorTiers.some((tier) => tier > table.tokens)) {
      Object.defineProperty(result, "ambiguous", { value: true, enumerable: false });
      Object.defineProperty(result, "candidateTiers", {
        value: Object.freeze([table.tokens, ...vendorTiers.filter((tier) => tier > table.tokens)]),
        enumerable: false,
      });
    }
    return result;
  }

  // observedFloor > table window: the table is WRONG for this session. Promote
  // to the smallest known tier that could have held it, or to the observed
  // floor itself when the session is larger than every window we know of.
  const vendor = entry?.vendor ?? null;
  const tier = smallestKnownTierAtLeast(observedFloor, { vendor });
  const tokens = tier ?? observedFloor;
  const ownTiers = vendor ? KNOWN_WINDOW_TIERS_BY_VENDOR[vendor] ?? [] : [];
  const promotion = Object.freeze({
    modelId: typeof modelId === "string" ? modelId : null,
    sessionId: typeof options?.sessionId === "string" ? options.sessionId : null,
    tableVersion: MODEL_WINDOWS_VERSION,
    tableEntry: entry?.id ?? null,
    vendor,
    tableTokens: table.tokens,
    tableSource: table.source,
    observedFloor,
    tokens,
    tier: tier ?? null,
    // Which ladder supplied the tier.  With a vendor known, only that vendor's
    // own tiers can answer, so "global" is reachable only for a table entry
    // that declares no vendor — every entry declares one today, which
    // tests/collectors/base.test.js asserts.  "none" means the session held
    // more than every window its vendor is known to ship: the window is
    // unknown, and no context share is derived from it.
    ladder: tier === null ? "none" : ownTiers.includes(tier) ? "vendor" : "global",
  });
  recordWindowPromotion(options?.diagnostic, promotion);
  return { tokens, source: "observed-promoted", observedFloor, promotion };
}

/**
 * Per-turn context fraction against a RESOLVED window, or null when no honest
 * fraction exists.  A measured 0 stays 0; an unmeasured context stays null.
 *
 * F-014, THE `observed-floor` RULE.  Where `window.source === "observed-floor"`
 * the window IS the session's own peak, so every fraction it can produce is
 * floor/floor = 1.0 BY CONSTRUCTION - an artifact of having no upper bound, not
 * a measurement.  Measured on this machine, hundreds of real sessions running
 * on an unrecognised model landed there, so a naive division would report
 * every one of them, including a trivial 5,000-token session, at "100% of
 * window".  The window NUMBER is still
 * true and worth displaying as a lower bound ("at least 41,344"); turning a
 * lower bound into a percentage is what is forbidden, so the fraction is null
 * and no threshold verdict may be derived from it.
 *
 * `observed-promoted` is NOT affected: its denominator is a real known vendor
 * tier, so its fraction is a genuine measurement.
 *
 * @param {number|null} inputTokens per-turn context reading
 * @param {{tokens?: number|null, source?: string}} window resolved window
 * @returns {number|null}
 */
export function contextFraction(inputTokens, window) {
  if (!Number.isFinite(inputTokens)) return null;
  const tokens = window?.tokens;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  if (window?.source === "observed-floor") return null;
  return inputTokens / tokens;
}

export function normalizeTurn(fields = {}) {
  const context = fields.context ?? {};
  return {
    ts: fields.ts ?? null,
    context: {
      inputTokens: context.inputTokens ?? null,
      fraction: context.fraction ?? null,
      source: context.source ?? "unknown",
    },
    cacheRead: fields.cacheRead ?? null,
    cacheCreate: fields.cacheCreate ?? null,
    output: fields.output ?? null,
    toolCalls: Array.isArray(fields.toolCalls) ? fields.toolCalls.map((tool) => ({
      id: tool?.id ?? null,
      name: tool?.name ?? null,
      input: tool && Object.hasOwn(tool, "input") ? tool.input : null,
    })) : [],
    toolResultBytes: fields.toolResultBytes ?? null,
    isSidechain: fields.isSidechain ?? null,
    ...(Array.isArray(fields.toolResultBytesByCall)
      ? { toolResultBytesByCall: fields.toolResultBytesByCall.map((value) => value ?? null) }
      : {}),
  };
}

export function normalizeSession(fields = {}) {
  const window = fields.window ?? {};
  const normalizedWindow = {
    tokens: window.tokens ?? null,
    source: window.source ?? "unknown",
  };
  if (window.ambiguous === true) Object.defineProperty(normalizedWindow, "ambiguous", { value: true, enumerable: false });
  if (Array.isArray(window.candidateTiers)) {
    Object.defineProperty(normalizedWindow, "candidateTiers", {
      value: Object.freeze([...window.candidateTiers]),
      enumerable: false,
    });
  }
  return {
    cli: fields.cli ?? null,
    support: fields.support ?? "supported",
    sessionId: fields.sessionId ?? null,
    project: fields.project ?? null,
    cwd: fields.cwd ?? null,
    model: fields.model ?? null,
    window: normalizedWindow,
    startedAt: fields.startedAt ?? null,
    endedAt: fields.endedAt ?? null,
    turns: Array.isArray(fields.turns) ? fields.turns.map(normalizeTurn) : [],
  };
}

export function createDiagnostic(cli = "unknown") {
  return { cli, filesScanned: 0, filesSkipped: 0, linesSkipped: 0, truncated: [], errors: [], notes: [] };
}

function recordError(diagnostic, error) {
  diagnostic.errors.push(error instanceof Error ? error.message : String(error));
}

/** A trailing CR, so a CRLF file yields the same line as an LF one. */
function withoutCarriageReturn(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Stream a JSONL file without retaining its contents in memory.
 *
 * LINES END AT \n AND NOWHERE ELSE (F-005).  This reader used `node:readline`,
 * which also terminates a line on U+2028 (LINE SEPARATOR) and U+2029
 * (PARAGRAPH SEPARATOR).  JSON permits both of those RAW inside a string, so a
 * record quoting scraped web text was split into two fragments and BOTH were
 * unparseable: one legal record in, zero records out.  Measured on this
 * machine, 6 records across 2 of 5,736 real transcript files were destroyed
 * that way.  It failed SAFE — the fragments landed in `linesSkipped`, so no
 * metric was ever corrupted — but a real record was silently DROPPED, and the
 * blast radius is every collector, because all four JSONL parsers share this
 * one reader.  Splitting on /\r?\n/ is therefore not a style preference; it is
 * the only split that matches what a JSONL writer actually emits.
 *
 * MEMORY STAYS BOUNDED.  A 42 MB session file is normal here and one real file
 * exceeds 50 MB, so the file is never read in whole: chunks are appended to a
 * carry string, every COMPLETE line is handed to `onRecord` and dropped, and
 * only the unfinished tail is retained.  The carry is sliced ONCE per chunk
 * rather than once per line — slicing per line is O(n^2) in the chunk and cost
 * ~6 GB of string copying on a 42 MB file.
 */
export async function safeReadJsonl(path, onRecord, opts = {}) {
  const diagnostic = opts.diagnostic ?? createDiagnostic(opts.cli ?? "unknown");
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : 64 * 1024 * 1024;
  diagnostic.filesScanned += 1;

  let size = 0;
  let stopped = false;
  let stream;

  /** One complete line: blank lines are not records, bad JSON is tolerated. */
  const handleLine = async (raw) => {
    const line = withoutCarriageReturn(raw);
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      diagnostic.linesSkipped += 1;
      return;
    }
    try {
      await onRecord(record);
    } catch (error) {
      recordError(diagnostic, error);
    }
  };

  try {
    const info = await stat(path);
    if (!info.isFile()) {
      diagnostic.filesSkipped += 1;
      return diagnostic;
    }
    if (info.size > maxBytes) {
      diagnostic.truncated.push(path);
    }
    stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
    let carry = "";
    try {
      for await (const chunk of stream) {
        size += Buffer.byteLength(chunk, "utf8");
        if (size > maxBytes) {
          // The chunk that crosses the cap is not parsed and the carried tail
          // is dropped, exactly as before: a line cut off by the cap is not a
          // record, and half a record must never be handed to `onRecord`.
          stopped = true;
          diagnostic.truncated.push(path);
          break;
        }
        carry += chunk;
        let start = 0;
        let at;
        while ((at = carry.indexOf("\n", start)) !== -1) {
          await handleLine(carry.slice(start, at));
          start = at + 1;
        }
        if (start > 0) carry = carry.slice(start);
      }
    } finally {
      stream.destroy();
    }
    // A final line with no trailing newline is still a record.
    if (!stopped && carry) await handleLine(carry);
  } catch (error) {
    diagnostic.filesSkipped += 1;
    recordError(diagnostic, error);
  }
  return diagnostic;
}

export const safeReadLines = safeReadJsonl;

export class Collector {
  constructor({ id, displayName, cli = id } = {}) {
    this.id = id ?? "unknown";
    this.displayName = displayName ?? this.id;
    this.cli = cli;
  }

  detect() {
    return { installed: false, paths: [], status: "absent" };
  }

  async collect() {
    return [];
  }
}

export default Collector;
