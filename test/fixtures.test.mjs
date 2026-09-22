import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { newTurnPrompt, conversationKey } from "../src/proxy.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wire");
const REQUIRED_FIELDS = ["category", "origin", "captureMethod", "expectedBehavior", "body"];

function loadFixtures() {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, fixture: JSON.parse(readFileSync(join(DIR, name), "utf8")) }));
}

test("every wire fixture follows the documented convention", () => {
  for (const { name, fixture } of loadFixtures()) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in fixture, `${name} is missing required field "${field}"`);
    }
    assert.match(fixture.origin, /^(synthetic|real)$/, `${name} has an unrecognised origin`);
    if (fixture.origin === "real") {
      assert.ok(fixture.claudeVersion, `${name} claims a real capture but has no version recorded`);
    }
  }
});

test("main/auxiliary/unknown-shape fixtures match newTurnPrompt's fresh-turn detection", () => {
  for (const { name, fixture } of loadFixtures()) {
    if (!["main-fresh", "main-continuation", "auxiliary", "unknown-shape", "subagent-return"].includes(
      fixture.category,
    )) {
      continue;
    }
    const prompt = newTurnPrompt(fixture.body);
    assert.equal(!!prompt, fixture.expectedBehavior.isFreshTurn, `${name}: isFreshTurn mismatch`);
    assert.equal(prompt, fixture.expectedBehavior.prompt, `${name}: prompt mismatch`);
  }
});

test("subagent-fresh/continuation fixtures are wire-identical to main at this layer (documents today's limit)", () => {
  for (const { name, fixture } of loadFixtures()) {
    if (!["subagent-fresh", "subagent-continuation"].includes(fixture.category)) continue;
    const prompt = newTurnPrompt(fixture.body);
    assert.equal(!!prompt, fixture.expectedBehavior.isFreshTurn, `${name}: isFreshTurn mismatch`);
    assert.equal(prompt, fixture.expectedBehavior.prompt, `${name}: prompt mismatch`);
  }
});

test("concurrent-actor fixtures produce distinct conversation keys despite sharing a session", () => {
  const a = JSON.parse(readFileSync(join(DIR, "concurrent-actor-a.json"), "utf8"));
  const b = JSON.parse(readFileSync(join(DIR, "concurrent-actor-b.json"), "utf8"));
  assert.notEqual(conversationKey(a.body), conversationKey(b.body));
});
