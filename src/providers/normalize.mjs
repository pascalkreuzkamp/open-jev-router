import { COMPLEXITY_MAX_SCORE, CONTEXT_WINDOW_TOKENS } from "../config.mjs";

/**
 * Shared shape between the direct TypeSafe `/v1/systemone` response and the OpenRouter
 * Decisions API response: both return `{ answers: { model, task_complexity, ... } }` because
 * OpenRouter proxies the same underlying Jev decision engine. Returns null when the answer
 * shape is missing or malformed, which callers turn into an `invalid_response` failure
 * rather than trusting a partially-shaped answer.
 */
export function normalizeAnswers(body, { contextTokens }) {
  const answers = body?.answers;
  const model = answers?.model;
  const { task_complexity, reasoning_required, tool_complexity } = answers ?? {};
  if (
    typeof model?.choice !== "string" ||
    typeof task_complexity?.score !== "number" ||
    typeof reasoning_required?.score !== "number" ||
    typeof tool_complexity?.score !== "number"
  ) {
    return null;
  }
  return {
    choice: model.choice,
    confidence: typeof model.confidence === "number" ? model.confidence : null,
    probabilities: model.probabilities && typeof model.probabilities === "object" ? model.probabilities : null,
    metrics: {
      taskComplexity: task_complexity.score / COMPLEXITY_MAX_SCORE,
      reasoningRequired: reasoning_required.score / COMPLEXITY_MAX_SCORE,
      toolComplexity: tool_complexity.score / COMPLEXITY_MAX_SCORE,
      contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
    },
  };
}

/** A typed failure a provider adapter returns; `askJev` logs it and fails open. */
export const fail = (category, message, ms) => ({ ok: false, category, message, ms });
