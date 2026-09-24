import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AntigravityCollector } from "../../src/collectors/antigravity.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** `.gemini/antigravity-cli/.keep`, a tiny stand-in for the real, unconfirmed shape. */
const FIXTURE_HOME = path.join(here, "..", "fixtures", "antigravity", "home");

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "session-rx-antigravity-"));
}

/** Tests never read the real home directory. */
function collector(home = FIXTURE_HOME) {
  return new AntigravityCollector({ home });
}

test("identity matches the registry slot", () => {
  const instance = collector();
  assert.equal(instance.id, "antigravity");
  assert.equal(instance.cli, "antigravity");
  assert.equal(instance.displayName, "Antigravity CLI");
});

test("detect reports detection-only when ~/.gemini/antigravity-cli exists", () => {
  const detection = collector().detect();
  assert.equal(detection.installed, true);
  // No confirmed on-disk format - never "supported".
  assert.equal(detection.status, "detection-only");
  assert.deepEqual(detection.paths, [path.join(FIXTURE_HOME, ".gemini", "antigravity-cli")]);
});

test("detect also recognises the Antigravity IDE's ~/.gemini/antigravity path", () => {
  const home = scratch();
  mkdirSync(path.join(home, ".gemini", "antigravity"), { recursive: true });
  const detection = collector(home).detect();
  assert.equal(detection.installed, true);
  assert.equal(detection.status, "detection-only");
  assert.deepEqual(detection.paths, [path.join(home, ".gemini", "antigravity")]);
});

test("detect reports both candidate paths when both exist", () => {
  const home = scratch();
  mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
  mkdirSync(path.join(home, ".gemini", "antigravity"), { recursive: true });
  const detection = collector(home).detect();
  assert.deepEqual(detection.paths, [
    path.join(home, ".gemini", "antigravity-cli"),
    path.join(home, ".gemini", "antigravity"),
  ]);
});

test("detect reports absent when neither ~/.gemini/antigravity-cli nor ~/.gemini/antigravity exists", () => {
  assert.deepEqual(collector(scratch()).detect(), {
    installed: false,
    paths: [],
    status: "absent",
  });
});

test("collect returns an empty array, never a zero-metric session", async () => {
  // No on-disk format has been confirmed, so nothing is parsed. A fabricated
  // zero-metric session would render as a HEALTHY session in the UI, reporting
  // "all clear" about a CLI whose sessions cannot be read at all.
  for (const home of [FIXTURE_HOME, scratch()]) {
    const sessions = await collector(home).collect();
    assert.ok(Array.isArray(sessions));
    assert.equal(sessions.length, 0);
  }
});

test("collect stays empty whatever options it is given", async () => {
  const instance = collector();
  assert.deepEqual(await instance.collect({ limit: 10, since: new Date(0) }), []);
  assert.deepEqual(await instance.collect(), []);
});
