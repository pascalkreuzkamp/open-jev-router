import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  CLAUDE_ADAPTER_VERSION,
  cleanPrompt,
  correlationOf,
  inspectClaudeRequest,
  metadataOf,
  sessionIdOf,
} from "../../../src/claude/adapter.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "wire");
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

test("cleanPrompt strips system reminders and surrounding whitespace", () => {
  assert.equal(cleanPrompt("  <system-reminder>hi</system-reminder> do it  "), "do it");
  assert.equal(cleanPrompt("<system-reminder>only this</system-reminder>"), "");
});

test("metadata and session id survive a missing or malformed envelope", () => {
  assert.deepEqual(metadataOf(undefined), {});
  assert.deepEqual(metadataOf({ metadata: { user_id: "not json" } }), {});
  assert.deepEqual(metadataOf({ metadata: { user_id: JSON.stringify(["a"]) } }), {});
  assert.equal(sessionIdOf({ metadata: { user_id: JSON.stringify({ session_id: "s1" }) } }), "s1");
  assert.equal(sessionIdOf({ metadata: { user_id: JSON.stringify({ session_id: 7 }) } }), "");
  assert.equal(sessionIdOf({}), "");
});

test("correlationOf reads only explicit fields and never infers them", () => {
  const empty = correlationOf({ messages: [{ role: "user", content: "anything at all" }] });
  assert.deepEqual(empty, {
    sessionId: null,
    actorId: null,
    parentActorId: null,
    actorType: null,
    logicalTurnId: null,
    requestId: null,
    agentName: null,
    modelSource: null,
  });

  const explicit = correlationOf({
    metadata: {
      user_id: JSON.stringify({
        session_id: "s1",
        agent_id: "a-9",
        parent_agent_id: "a-1",
        agent_type: "subagent",
        turn_id: "t-3",
        request_id: "r-4",
        subagent_type: "Explore",
        model_source: "user",
      }),
    },
  });
  assert.deepEqual(explicit, {
    sessionId: "s1",
    actorId: "a-9",
    parentActorId: "a-1",
    actorType: "subagent",
    logicalTurnId: "t-3",
    requestId: "r-4",
    agentName: "Explore",
    modelSource: "user",
  });
});

test("an unrecognised actor_type is dropped rather than trusted", () => {
  const { actorType } = correlationOf({
    metadata: { user_id: JSON.stringify({ actor_type: "orchestrator" }) },
  });
  assert.equal(actorType, null);
});

test("inspectClaudeRequest reports an unknown shape for a non-messages body", () => {
  const request = inspectClaudeRequest({ model: "jev-router" });
  assert.equal(request.shape, "unknown");
  assert.equal(request.prompt, null);
  assert.equal(request.firstMessageFingerprint, null);
  assert.equal(request.adapterVersion, CLAUDE_ADAPTER_VERSION);
  assert.deepEqual(request.evidence, ["messages array missing"]);
});

test("inspectClaudeRequest separates fresh, continuation and auxiliary shapes", () => {
  const tools = [{ name: "Bash" }];
  const fresh = inspectClaudeRequest({
    tools,
    messages: [{ role: "user", content: "fix the build" }],
  });
  assert.equal(fresh.shape, "fresh");
  assert.equal(fresh.prompt, "fix the build");

  const continuation = inspectClaudeRequest({
    tools,
    messages: [
      { role: "user", content: "fix the build" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
  });
  assert.equal(continuation.shape, "continuation");
  assert.equal(continuation.prompt, null);

  const auxiliary = inspectClaudeRequest({
    messages: [{ role: "user", content: "summarise this conversation title" }],
  });
  assert.equal(auxiliary.shape, "auxiliary");
  assert.deepEqual(auxiliary.evidence, ["no tools"]);

  const suggestion = inspectClaudeRequest({
    tools,
    messages: [{ role: "user", content: "[SUGGESTION MODE: complete this]" }],
  });
  assert.equal(suggestion.shape, "auxiliary");
  assert.deepEqual(suggestion.evidence, ["suggestion-mode prefix"]);
});

test("the first-message fingerprint identifies a transcript, not a turn", () => {
  const first = { role: "user", content: "root task" };
  const a = inspectClaudeRequest({ tools: [{ name: "Bash" }], messages: [first] });
  const b = inspectClaudeRequest({
    tools: [{ name: "Bash" }],
    messages: [first, { role: "assistant", content: "..." }, { role: "user", content: "next" }],
  });
  const other = inspectClaudeRequest({
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: "different root" }],
  });
  assert.equal(a.firstMessageFingerprint, b.firstMessageFingerprint);
  assert.notEqual(a.firstMessageFingerprint, other.firstMessageFingerprint);
});

test("every wire fixture's shape matches its recorded fresh-turn expectation", () => {
  const shapeByCategory = {
    "main-fresh": "fresh",
    "subagent-fresh": "fresh",
    "concurrent-actors": "fresh",
    "main-continuation": "continuation",
    "subagent-continuation": "continuation",
    "subagent-return": "continuation",
    auxiliary: "auxiliary",
    "unknown-shape": "unknown",
  };
  const seen = new Set();
  for (const name of readdirSync(FIXTURES).filter((file) => file.endsWith(".json"))) {
    const { category, body, expectedBehavior } = fixture(name);
    const expected = shapeByCategory[category];
    assert.ok(expected, `${name}: unmapped fixture category ${category}`);
    seen.add(category);
    const request = inspectClaudeRequest(body);
    assert.equal(request.shape, expected, `${name}: shape mismatch`);
    assert.equal(
      request.shape === "fresh",
      expectedBehavior.isFreshTurn,
      `${name}: fresh-turn mismatch`,
    );
  }
  assert.deepEqual([...seen].sort(), Object.keys(shapeByCategory).sort());
});

test("the synthetic wire fixtures carry no actor correlation at all", () => {
  // Recorded limitation (overview blocker B-002): no captured Claude request is known to
  // expose actor fields, so classification of these bodies can only ever be heuristic.
  for (const name of readdirSync(FIXTURES).filter((file) => file.endsWith(".json"))) {
    const { correlation } = inspectClaudeRequest(fixture(name).body);
    assert.equal(correlation.actorId, null, `${name} unexpectedly carries an actor id`);
    assert.equal(correlation.actorType, null, `${name} unexpectedly carries an actor type`);
  }
});
