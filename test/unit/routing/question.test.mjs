import test from "node:test";
import assert from "node:assert/strict";
import { questionForProfiles } from "../../../src/config.mjs";
import { resolveProfiles } from "../../../src/routing/profiles.mjs";

const profiles = resolveProfiles({
  models: [
    { id: "claude-haiku-4-5-20251001", tier: "haiku" },
    { id: "claude-sonnet-5", tier: "sonnet" },
    { id: "claude-opus-5", tier: "opus" },
  ],
  env: {},
});

test("profile question carries per-tier guidance, not just model names", () => {
  const text = JSON.stringify(questionForProfiles(profiles));
  assert.match(text, /Design judgement or multi-file reasoning/);
  assert.match(text, /fix an understood local bug/);
  assert.match(text, /not how clearly the request is written/);
});
