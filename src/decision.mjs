import { createHash } from "node:crypto";
import { boolEnv } from "./env.mjs";
import { redactText } from "./sanitize.mjs";

const PREVIEW_LENGTH = 80;

function previewOf(prompt) {
  const oneLine = redactText(prompt.replace(/\s+/g, " ").trim());
  return oneLine.length > PREVIEW_LENGTH ? `${oneLine.slice(0, PREVIEW_LENGTH)}…` : oneLine;
}

/**
 * Shapes a routing decision for persistence. The raw Jev request/response embed the full
 * prompt (`jev.request.state.request`) and are never stored; only the normalized fields
 * `/jev-explain` renders survive, plus a hash that lets an operator correlate decisions
 * without recovering prompt text. Full prompt storage and truncated previews are both
 * explicit opt-ins (JEV_STORE_PROMPTS / JEV_STORE_PROMPT_PREVIEW); previews are also scrubbed
 * for secret-shaped tokens, since a pasted key in the prompt would otherwise pass through.
 */
export function buildDecision({
  tier,
  model,
  reason,
  prompt,
  jev,
  recommendedTier = null,
  currentModel = null,
  contextTokens = null,
}) {
  const decision = {
    tier,
    model,
    reason,
    confidence: jev?.confidence ?? null,
    metrics: jev?.metrics ?? null,
    recommendedTier,
    currentModel,
    contextTokens,
    // Provider metadata only (FR-002/A13): never the raw request/response, which embed the
    // prompt (`jev.request.state.request`) and are not persisted at any storage tier.
    provider: jev?.provider ?? null,
    decisionId: jev?.decisionId ?? null,
    configuredModel: jev?.configuredModel ?? null,
    resolvedModel: jev?.resolvedModel ?? null,
    usage: jev?.usage ?? null,
    cost: jev?.cost ?? null,
    promptHash: createHash("sha256").update(prompt).digest("hex"),
    at: Date.now(),
  };
  if (boolEnv("JEV_STORE_PROMPTS")) decision.prompt = prompt;
  else if (boolEnv("JEV_STORE_PROMPT_PREVIEW")) decision.promptPreview = previewOf(prompt);
  return decision;
}
