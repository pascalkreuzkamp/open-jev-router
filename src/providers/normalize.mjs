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
  // Jev reports a score as the probability-weighted position on the 0-9 legend, so a real
  // answer is usually fractional (0.64, not 1). Requiring an integer here rejected every
  // genuine decision as `invalid_response` — verified live on 2026-09-22 — while every
  // synthetic fixture, which used whole numbers, passed. Out of range is still refused.
  const validScore = (value) =>
    Number.isFinite(value) && value >= 0 && value <= COMPLEXITY_MAX_SCORE;
  if (
    typeof model?.choice !== "string" ||
    !validScore(task_complexity?.score) ||
    !validScore(reasoning_required?.score) ||
    !validScore(tool_complexity?.score)
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
