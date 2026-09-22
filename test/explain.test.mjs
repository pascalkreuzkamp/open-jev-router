import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatExplanation } from "../src/explain.mjs";

test("formats the last routing decision", () => {
  const output = formatExplanation({
    prompt: "Explain the router architecture",
    tier: "sonnet",
    confidence: 0.94,
    reason: "jev",
    recommendedTier: "sonnet",
    currentModel: "haiku",
    contextTokens: 6200,
    effectiveEffort: "medium",
    normalizationNotes: ["manual thinking normalized to adaptive thinking"],
    metrics: {
      taskComplexity: 0.82,
      reasoningRequired: 0.91,
      toolComplexity: 0.64,
      contextSize: 0.31,
    },
  });

  assert.match(output, /Task complexity     0\.82/);
  assert.match(output, /Prompt: Explain the router/);
  assert.match(output, /Current tier: HAIKU/);
  assert.match(output, /Context tokens: 6200/);
  assert.match(output, /Recommended tier: SONNET/);
  assert.match(output, /Selected model: SONNET/);
  assert.match(output, /Effective effort: MEDIUM/);
  assert.match(output, /Normalized: manual thinking/);
  assert.match(output, /Confidence: 94%/);
  assert.match(output, /Decision: Jev recommendation/);
});

test("shows a preview and a not-recorded note when the prompt was not stored", () => {
  const withPreview = formatExplanation({ promptPreview: "explain the router", tier: "sonnet" });
  assert.match(withPreview, /Prompt: explain the router/);
  assert.match(withPreview, /\(preview\)/);
  assert.match(
    formatExplanation({ tier: "sonnet" }),
    /Prompt: not recorded/,
  );
});

test("shows the concrete provider model when available", () => {
  assert.match(
    formatExplanation({ tier: "haiku", model: "gpt-5.6-luna", confidence: 0.99 }),
    /Selected model: GPT-5\.6-LUNA/,
  );
});

test("separates actor, recommendation, effective route, and upstream outcome", () => {
  const output = formatExplanation({
    actorType: "subagent",
    actorName: "Explore",
    actorId: "a_2f9",
    parentActorId: "main",
    requestClassification: "subagent_fresh",
    provider: "openrouter",
    resolvedModel: "typesafe/jev-1.13",
    decisionId: "dec_1",
    latencyMs: 41,
    cost: 0.000014,
    recommendedProfile: "haiku-default",
    requestedEffort: "default",
    model: "claude-haiku-4-5",
    effectiveEffort: "default",
    confidence: null,
    source: "fallback",
    fallbackReason: "provider_timeout",
    upstreamOutcome: { success: false, httpStatus: 502, model: "claude-haiku-4-5" },
  });
  assert.match(output, /Type: subagent/);
  assert.match(output, /Name: Explore/);
  assert.match(output, /Classification: subagent_fresh/);
  assert.match(output, /Provider: openrouter/);
  assert.match(output, /Profile: haiku-default/);
  assert.match(output, /Confidence: n\/a/);
  assert.match(output, /Decision source: fallback/);
  assert.match(output, /Fallback: provider_timeout/);
  assert.match(output, /Status: failed/);
  assert.match(output, /HTTP: 502/);
});

test("legacy and manual status records remain readable", () => {
  assert.doesNotThrow(() => formatExplanation({ tier: "sonnet", reason: "jev" }));
  assert.match(
    formatExplanation({ manual: true, model: "claude-opus-5" }),
    /manual model claude-opus-5/,
  );
});


test("Claude skill pre-approves its read-only explanation command", () => {
  const skill = readFileSync(new URL("../.claude/skills/jev-explain/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^allowed-tools: Bash\(node \*\)$/m);
});
