import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RETENTION_DAYS,
  dataDir,
  databasePath,
  retentionCutoff,
  retentionDays,
  storePromptPreview,
  storePrompts,
  telemetryEnabled,
} from "../../../src/telemetry/config.mjs";

test("the default data directory and database path follow the documented layout", () => {
  assert.equal(dataDir({}), join(homedir(), ".jev-router"));
  assert.equal(databasePath({}), join(homedir(), ".jev-router", "telemetry.sqlite3"));
});

test("JEV_DATA_DIR accepts absolute, relative, and tilde paths", () => {
  assert.equal(dataDir({ JEV_DATA_DIR: "/srv/jev" }), "/srv/jev");
  assert.equal(dataDir({ JEV_DATA_DIR: "~/somewhere" }), join(homedir(), "somewhere"));
  assert.equal(dataDir({ JEV_DATA_DIR: "relative/dir" }), join(process.cwd(), "relative", "dir"));
});

test("telemetry is opt-in and only explicit truth enables it", () => {
  assert.equal(telemetryEnabled({}), false);
  assert.equal(telemetryEnabled({ JEV_ENABLE_TELEMETRY: "0" }), false);
  assert.equal(telemetryEnabled({ JEV_ENABLE_TELEMETRY: "false" }), false);
  assert.equal(telemetryEnabled({ JEV_ENABLE_TELEMETRY: "yes" }), false);
  assert.equal(telemetryEnabled({ JEV_ENABLE_TELEMETRY: "1" }), true);
  assert.equal(telemetryEnabled({ JEV_ENABLE_TELEMETRY: "TRUE" }), true);
});

test("retention defaults to 90 days and rejects nonsense rather than disabling itself", () => {
  assert.equal(retentionDays({}), DEFAULT_RETENTION_DAYS);
  assert.equal(retentionDays({ JEV_TELEMETRY_RETENTION_DAYS: "7" }), 7);
  assert.equal(retentionDays({ JEV_TELEMETRY_RETENTION_DAYS: "7.9" }), 7);
  for (const bad of ["0", "-5", "", "soon", "NaN"]) {
    assert.equal(
      retentionDays({ JEV_TELEMETRY_RETENTION_DAYS: bad }),
      DEFAULT_RETENTION_DAYS,
      `${JSON.stringify(bad)} should fall back to the default`,
    );
  }
});

test("the retention cutoff is the configured number of days before now", () => {
  const now = 1_700_000_000_000;
  assert.equal(retentionCutoff({ JEV_TELEMETRY_RETENTION_DAYS: "1" }, now), now - 86_400_000);
  assert.equal(retentionCutoff({}, now), now - DEFAULT_RETENTION_DAYS * 86_400_000);
});

test("prompt storage stays off unless it is explicitly turned on", () => {
  assert.equal(storePrompts({}), false);
  assert.equal(storePromptPreview({}), false);
  assert.equal(storePrompts({ JEV_STORE_PROMPTS: "1" }), true);
  assert.equal(storePromptPreview({ JEV_STORE_PROMPT_PREVIEW: "true" }), true);
});
