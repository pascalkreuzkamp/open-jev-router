import {
  AuthenticationError,
  RateLimitError,
  APITimeoutError,
  APIUserAbortError,
  APIConnectionError,
  APIError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import { QUESTIONS, questionForModels, THRESHOLDS, jevTimeoutMs } from "../config.mjs";
import { redactText } from "../sanitize.mjs";
import { fail, normalizeAnswers } from "./normalize.mjs";

function categoryForError(err) {
  if (err instanceof AuthenticationError) return "auth_error";
  if (err instanceof RateLimitError) return "rate_limited";
  if (err instanceof APITimeoutError) return "timeout";
  // Our own outer AbortController; from the caller's perspective this is still a timeout.
  if (err instanceof APIUserAbortError) return "timeout";
  if (err instanceof APIConnectionError) return "network_error";
  if (err instanceof APIError) return "provider_error";
  return "unknown_error";
}

/**
 * TypeSafeJevProvider (FR-001): the pre-existing direct-API adapter, now behind the same
 * `JevProvider` contract as OpenRouter. `baseURL`/`fetchImpl` exist only so tests can point
 * the SDK at a mock server without touching the network.
 */
export function createTypeSafeProvider({ apiKey, defaultModel, baseURL, fetchImpl, timeoutMs } = {}) {
  const deadline = timeoutMs ?? jevTimeoutMs();
  // The SDK's own defaults (10s per attempt, 2 retries, no total budget) are far too slow for
  // a per-prompt hot path, so both the per-attempt timeout and the retry count are pinned; the
  // outer AbortController below is the actual hard deadline across every attempt.
  const client = new TypeSafeClient({
    apiKey,
    ...(defaultModel ? { defaultModel } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    timeout: deadline,
    retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn", // never "debug": request bodies contain the user's prompt
  });

  async function route({ prompt, current, contextTokens, models }) {
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deadline);
    const request = {
      state: {
        request: prompt,
        session: { current_model: current, context_tokens: contextTokens },
        environment: { available_models: models.map((m) => m.id) },
      },
      questions: { ...QUESTIONS, model: questionForModels(models) },
    };
    try {
      const { data: body, response } = await client.systemOne(request, { signal: abort.signal }).withResponse();
      const ms = Date.now() - started;
      const normalized = normalizeAnswers(body, { contextTokens });
      if (!normalized) return fail("invalid_response", "TypeSafe response is missing the expected answer fields", ms);
      return {
        ok: true,
        ...normalized,
        decisionId: response.headers.get("x-typesafe-request-id"),
        configuredModel: client.defaultModel,
        resolvedModel: typeof body?.model === "string" ? body.model : null,
        usage: {
          inputTokens: Number.isFinite(body?.usage?.input_tokens) ? body.usage.input_tokens : null,
          outputTokens: Number.isFinite(body?.usage?.output_tokens) ? body.usage.output_tokens : null,
        },
        cost: Number.isFinite(body?.usage?.cost) ? body.usage.cost : null,
        ms,
        request,
        raw: body,
      };
    } catch (err) {
      const ms = Date.now() - started;
      // A provider error may echo the request or a header back in its message.
      return fail(categoryForError(err), redactText(err?.message ?? String(err)), ms);
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /v1/models: an account/catalog listing, not a billed decision. */
  async function healthCheck() {
    const started = Date.now();
    try {
      await client.models.list();
      return { ok: true, ms: Date.now() - started };
    } catch (err) {
      return { ok: false, message: redactText(err?.message ?? String(err)) };
    }
  }

  return { name: "typesafe", route, healthCheck };
}
