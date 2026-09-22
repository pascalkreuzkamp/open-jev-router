import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeStatus } from "../../../src/status.mjs";

const STATUSLINE = fileURLToPath(new URL("../../../bin/jev-statusline.mjs", import.meta.url));
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function render(sessionId, status, input = {}) {
  writeStatus(sessionId, status);
  return spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify({
      session_id: sessionId,
      cwd: "/work/demo",
      model: { display_name: "Opus 5" },
      context_window: { used_percentage: 55 },
      ...input,
    }),
    encoding: "utf8",
  });
}

test("statusline shows active subagent, effective effort, confidence, and route shares", () => {
  const result = render(`status-sub-${process.pid}`, {
    actorType: "subagent",
    actorName: "Explore",
    model: "claude-haiku-4-5",
    tier: "haiku",
    effectiveEffort: "default",
    confidence: 0.97,
    reason: "jev",
    history: [
      { tier: "opus", model: "claude-opus-5", effectiveEffort: "high", actorType: "main" },
      { tier: "haiku", actorType: "subagent" },
      { tier: "haiku", actorType: "subagent" },
    ],
  });
  assert.equal(result.status, 0, result.stderr);
  const output = plain(result.stdout);
  assert.match(output, /subagent:Explore/);
  assert.match(output, /claude-haiku-4-5\/default/);
  assert.match(output, /p=0\.97/);
  assert.match(output, /main claude-opus-5\/high/);
  assert.match(output, /O 33%\/H 67%/);
  assert.match(output, /55% context/);
});

test("statusline labels fallbacks and manual routing pauses", () => {
  const fallback = render(`status-fallback-${process.pid}`, {
    actorType: "main",
    model: "claude-opus-5",
    tier: "opus",
    effectiveEffort: "high",
    reason: "jev-unavailable",
    fallbackReason: "provider_timeout",
  });
  assert.match(plain(fallback.stdout), /main/);
  assert.match(plain(fallback.stdout), /provider_timeout/);

  const manual = render(`status-manual-${process.pid}`, { manual: true, model: "claude-sonnet-5" });
  assert.match(plain(manual.stdout), /manual/);
  assert.match(plain(manual.stdout), /Opus 5/);
});

test("legacy status records and malformed statusline input stay cosmetic", () => {
  const result = render(`status-legacy-${process.pid}`, { tier: "sonnet", reason: "jev" });
  assert.equal(result.status, 0);
  assert.match(plain(result.stdout), /main sonnet/);

  const malformed = spawnSync(process.execPath, [STATUSLINE], { input: "not-json", encoding: "utf8" });
  assert.equal(malformed.status, 0);
  assert.match(plain(malformed.stdout), /waiting for first prompt/);
});
