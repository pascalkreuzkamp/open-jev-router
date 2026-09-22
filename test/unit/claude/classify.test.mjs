import test from "node:test";
import assert from "node:assert/strict";
import { inspectClaudeRequest } from "../../../src/claude/adapter.mjs";
import {
  REQUEST_CLASSIFICATIONS,
  auxiliaryPolicy,
  classifyClaudeRequest,
  mayRouteSubagent,
  subagentModelPolicy,
} from "../../../src/claude/classify.mjs";
import { AUTO_MODEL } from "../../../src/config.mjs";

const TOOLS = [{ name: "Bash" }];

const bodyWith = (metadata = {}, overrides = {}) => ({
  model: AUTO_MODEL,
  tools: TOOLS,
  metadata: { user_id: JSON.stringify(metadata) },
  messages: [{ role: "user", content: "do the task" }],
  ...overrides,
});

const detectionOf = (actorType) => ({ actorType, actorKey: `k:${actorType}`, confidence: "high" });

const classify = (body, detection, env = {}) =>
  classifyClaudeRequest(body, inspectClaudeRequest(body), detection, env);

test("policy readers fall back to the documented defaults", () => {
  assert.equal(auxiliaryPolicy({}), "passthrough");
  assert.equal(auxiliaryPolicy({ JEV_AUXILIARY_POLICY: "nonsense" }), "passthrough");
  assert.equal(auxiliaryPolicy({ JEV_AUXILIARY_POLICY: "fast" }), "fast");
  assert.equal(subagentModelPolicy({}), "route");
  assert.equal(subagentModelPolicy({ JEV_SUBAGENT_MODEL_POLICY: "nonsense" }), "route");
  assert.equal(subagentModelPolicy({ JEV_SUBAGENT_MODEL_POLICY: "inherit" }), "inherit");
});

test("the classification set is exactly the seven specified values", () => {
  assert.deepEqual(REQUEST_CLASSIFICATIONS, [
    "main_fresh",
    "main_continuation",
    "subagent_fresh",
    "subagent_continuation",
    "auxiliary",
    "manual_passthrough",
    "unknown",
  ]);
});

test("main actors classify by shape when the sentinel is selected", () => {
  assert.equal(classify(bodyWith(), detectionOf("main")), "main_fresh");
  const continuation = bodyWith({}, {
    messages: [
      { role: "user", content: "do the task" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
  });
  assert.equal(classify(continuation, detectionOf("main")), "main_continuation");
});

test("a user-selected model is a manual passthrough, never a routed turn", () => {
  const body = bodyWith({}, { model: "claude-opus-5" });
  assert.equal(classify(body, detectionOf("main")), "manual_passthrough");
});

test("auxiliary and unknown shapes are classified before actor identity matters", () => {
  const auxiliary = { model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "title" }] };
  assert.equal(classify(auxiliary, detectionOf("unknown")), "auxiliary");
  const malformed = { model: AUTO_MODEL, tools: TOOLS, messages: "not an array" };
  assert.equal(classify(malformed, detectionOf("main")), "unknown");
});

test("an unidentified actor is unknown rather than assumed to be the main agent", () => {
  assert.equal(classify(bodyWith(), detectionOf("unknown")), "unknown");
});

test("subagent policy route: the sentinel and inherited defaults are routable", () => {
  const detection = detectionOf("subagent");
  assert.equal(classify(bodyWith(), detection), "subagent_fresh");

  const defaulted = bodyWith({ model_source: "default" }, { model: "claude-sonnet-5" });
  assert.equal(classify(defaulted, detection), "subagent_fresh");

  const builtIn = bodyWith({ model_source: "built-in" }, { model: "claude-sonnet-5" });
  assert.equal(classify(builtIn, detection), "subagent_fresh");
});

test("subagent policy route: a user hard lock wins over routing", () => {
  const detection = detectionOf("subagent");
  for (const source of ["user", "hard-lock"]) {
    const body = bodyWith({ model_source: source }, { model: "claude-opus-5" });
    assert.equal(classify(body, detection), "manual_passthrough", `model_source=${source}`);
  }
});

test("subagent policy route: unknown lock provenance preserves the requested model", () => {
  const body = bodyWith({}, { model: "claude-opus-5" });
  assert.equal(classify(body, detectionOf("subagent")), "manual_passthrough");
});

test("subagent policy respect-explicit: only the sentinel is routed", () => {
  const env = { JEV_SUBAGENT_MODEL_POLICY: "respect-explicit" };
  const detection = detectionOf("subagent");
  assert.equal(classify(bodyWith(), detection, env), "subagent_fresh");
  const defaulted = bodyWith({ model_source: "default" }, { model: "claude-sonnet-5" });
  assert.equal(classify(defaulted, detection, env), "manual_passthrough");
});

test("mayRouteSubagent is independent of the caller's ambient environment", () => {
  const body = bodyWith({ model_source: "default" }, { model: "claude-sonnet-5" });
  const request = inspectClaudeRequest(body);
  assert.equal(mayRouteSubagent(body, request, "route"), true);
  assert.equal(mayRouteSubagent(body, request, "respect-explicit"), false);
  const locked = bodyWith({ model_source: "user" }, { model: "claude-opus-5" });
  assert.equal(mayRouteSubagent(locked, inspectClaudeRequest(locked), "route"), false);
});

test("every classification a body can produce is one of the declared values", () => {
  const bodies = [
    bodyWith(),
    bodyWith({}, { model: "claude-opus-5" }),
    { model: AUTO_MODEL, messages: [{ role: "user", content: "aux" }] },
    { model: AUTO_MODEL, tools: TOOLS, messages: null },
  ];
  for (const actorType of ["main", "subagent", "unknown"]) {
    for (const body of bodies) {
      assert.ok(REQUEST_CLASSIFICATIONS.includes(classify(body, detectionOf(actorType))));
    }
  }
});
