import test from "node:test";
import assert from "node:assert/strict";
import { transformClaudeRequest } from "../../../src/claude/transform.mjs";

test("merges effective effort while preserving unrelated request fields", () => {
  const input = {
    model: "jev-router",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    metadata: { user_id: "abc" },
    output_config: { format: { type: "json_schema" }, effort: "high" },
    thinking: { type: "adaptive" },
  };
  const { body, audit } = transformClaudeRequest(input, {
    model: "claude-sonnet-5",
    effectiveEffort: "low",
    normalizationNotes: [],
  });
  assert.equal(body.model, "claude-sonnet-5");
  assert.deepEqual(body.output_config, { format: { type: "json_schema" }, effort: "low" });
  assert.deepEqual(body.messages, input.messages);
  assert.deepEqual(body.tools, input.tools);
  assert.deepEqual(body.metadata, input.metadata);
  assert.equal(audit.effortAfter, "low");
  assert.equal(input.model, "jev-router", "input is not mutated");
});

test("removes only unsupported effort and adaptive-thinking fields for Haiku", () => {
  const { body, audit } = transformClaudeRequest(
    {
      model: "jev-router",
      output_config: { effort: "high", format: "json" },
      thinking: { type: "adaptive" },
      context_management: {
        edits: [{ type: "clear_thinking_20251015" }, { type: "clear_tool_uses_20250919" }],
      },
    },
    { model: "claude-haiku-4-5-20251001", effectiveEffort: null, normalizationNotes: [] },
  );
  assert.deepEqual(body.output_config, { format: "json" });
  assert.equal(body.thinking, undefined);
  assert.deepEqual(body.context_management.edits, [{ type: "clear_tool_uses_20250919" }]);
  assert.ok(audit.removedFields.includes("thinking"));
});

test("normalizes manual thinking to adaptive on newer models", () => {
  const { body } = transformClaudeRequest(
    { model: "jev-router", thinking: { type: "enabled", budget_tokens: 5000 } },
    { model: "claude-opus-5", effectiveEffort: "high", normalizationNotes: [] },
  );
  assert.deepEqual(body.thinking, { type: "adaptive" });
});

test("a model-only route preserves an existing supported effort", () => {
  const { body } = transformClaudeRequest(
    { model: "jev-router", output_config: { effort: "medium", other: true } },
    { model: "claude-sonnet-5", effectiveEffort: null, normalizationNotes: [] },
  );
  assert.deepEqual(body.output_config, { effort: "medium", other: true });
});

test("normalizes an impossible disabled-thinking high-effort combination", () => {
  const { body, audit } = transformClaudeRequest(
    { model: "jev-router", thinking: { type: "disabled" } },
    { model: "claude-opus-5", effectiveEffort: "xhigh", normalizationNotes: [] },
  );
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.match(audit.normalizationNotes.join(" "), /incompatible/);
});

test("unknown capability data changes only the model", () => {
  const input = {
    model: "jev-router",
    thinking: { type: "future" },
    output_config: { effort: "future", other: true },
  };
  const { body, audit } = transformClaudeRequest(input, {
    model: "claude-sonnet-6",
    effectiveEffort: "high",
    normalizationNotes: [],
  });
  assert.deepEqual(body, { ...input, model: "claude-sonnet-6" });
  assert.match(audit.normalizationNotes.join(" "), /unknown model capabilities/);
});
