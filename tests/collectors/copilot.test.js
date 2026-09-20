import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CopilotCollector } from "../../src/collectors/copilot.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** config.json + ide/<uuid>.lock + logs/process-*.log, exactly as EVIDENCE B1 found. */
const FIXTURE_HOME = path.join(here, "..", "fixtures", "copilot", "home");

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "session-rx-copilot-"));
}

/** Tests never read the real home directory. */
function collector(home = FIXTURE_HOME) {
  return new CopilotCollector({ home });
}

test("identity matches the registry slot", () => {
  const instance = collector();
  assert.equal(instance.id, "copilot");
  assert.equal(instance.cli, "copilot");
  assert.equal(instance.displayName, "GitHub Copilot CLI");
});

test("detect reports detection-only when ~/.copilot exists", () => {
  const detection = collector().detect();
  assert.equal(detection.installed, true);
  // BP-002.06: never "supported" - there is no transcript to support.
  assert.equal(detection.status, "detection-only");
  assert.deepEqual(detection.paths, [
    path.join(FIXTURE_HOME, ".copilot"),
    path.join(FIXTURE_HOME, ".copilot", "config.json"),
    path.join(FIXTURE_HOME, ".copilot", "ide"),
    path.join(FIXTURE_HOME, ".copilot", "logs"),
  ]);
});

test("detect reports absent when ~/.copilot does not exist", () => {
  assert.deepEqual(collector(scratch()).detect(), {
    installed: false,
    paths: [],
    status: "absent",
  });
});

test("collect returns an empty array, never a zero-metric session", async () => {
  // A fabricated zero-metric session would render as a HEALTHY session in the UI,
  // reporting "all clear" about a CLI whose sessions cannot be read at all.
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
