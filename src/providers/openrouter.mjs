import { QUESTIONS, questionForModels, questionForProfiles, jevTimeoutMs } from "../config.mjs";
import { redactText } from "../sanitize.mjs";
import { fail, normalizeAnswers } from "./normalize.mjs";

const DECISIONS_PATH = "/api/alpha/decisions";
const KEY_PATH = "/api/v1/key";

/**
 * Maps an OpenRouter Decisions API error status to one of FR-002's categories. Confirmed
 * against https://openrouter.ai/docs (2026-09-22): 429 rate limited, 402 insufficient
 * credits, 524 upstream timeout, 529 provider overloaded; 401/403 are ordinary bearer-token
 * auth failures. Every other 4xx/5xx is a provider-side rejection we cannot subdivide further
 * without guessing at an undocumented shape.
 */
function categoryForStatus(status) {
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limited";
  if (status === 524) return "timeout";
  if (status >= 400) return "provider_error";
  return "unknown_error";
}

/** Best-effort error message extraction; OpenRouter error bodies are not formally specified. */
function describeError(status, body) {
  const message =
    typeof body === "string"
      ? body
      : typeof body?.error === "string"
        ? body.error
        : typeof body?.error?.message === "string"
          ? body.error.message
          : typeof body?.message === "string"
            ? body.message
            : undefined;
  return redactText(`${status}${message ? ` ${message}` : ""}`);
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * OpenRouterJevProvider (FR-001, FR-002). Uses the alpha Decisions API directly via native
 * fetch rather than the chat-completions shape: POST /api/alpha/decisions with
 * { model, state, questions }, never a `messages` array, and never Claude's own headers.
 */
export function createOpenRouterProvider({
  apiKey,
  model,
  baseURL = "https://openrouter.ai",
  fetchImpl = fetch,
  timeoutMs,
} = {}) {
  const deadline = timeoutMs ?? jevTimeoutMs();

  async function route({ prompt, current, contextTokens, models, profiles = [], decisionMode = "signals" }) {
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deadline);
    const request = {
      model,
      state: {
        request: prompt,
        session: { current_model: current, context_tokens: contextTokens },
        environment: {
          available_models: models.map((m) => m.id),
          ...(profiles.length ? { available_profiles: profiles.map((profile) => profile.id) } : {}),
        },
      },
      questions: {
        ...QUESTIONS,
        model:
          decisionMode === "profiles" && profiles.length
            ? questionForProfiles(profiles)
            : questionForModels(models),
      },
    };
    try {
      const res = await fetchImpl(`${baseURL}${DECISIONS_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: abort.signal,
      });
      const ms = Date.now() - started;
      const body = await safeJson(res);
      if (!res.ok) return fail(categoryForStatus(res.status), describeError(res.status, body), ms);
      if (body === undefined) return fail("invalid_response", "OpenRouter response was not valid JSON", ms);
      const normalized = normalizeAnswers(body, { contextTokens });
      if (!normalized) return fail("invalid_response", "OpenRouter response is missing the expected answer fields", ms);
      return {
        ok: true,
        ...normalized,
        decisionId: typeof body.id === "string" ? body.id : null,
        configuredModel: model,
        resolvedModel: typeof body.model === "string" ? body.model : null,
        usage: {
          inputTokens: Number.isFinite(body.usage?.input_tokens) ? body.usage.input_tokens : null,
          outputTokens: Number.isFinite(body.usage?.output_tokens) ? body.usage.output_tokens : null,
        },
        cost: Number.isFinite(body.usage?.cost) ? body.usage.cost : null,
        ms,
        request,
        raw: body,
      };
    } catch (err) {
      const ms = Date.now() - started;
      if (err?.name === "AbortError") return fail("timeout", `OpenRouter decision exceeded ${deadline}ms`, ms);
      return fail("network_error", redactText(err?.message ?? String(err)), ms);
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /api/v1/key: confirms the bearer token is live without spending on a decision. */
  async function healthCheck() {
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deadline);
    try {
      const res = await fetchImpl(`${baseURL}${KEY_PATH}`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: abort.signal,
      });
      if (!res.ok) return { ok: false, message: describeError(res.status, await safeJson(res)) };
      return { ok: true, ms: Date.now() - started };
    } catch (err) {
      return { ok: false, message: redactText(err?.message ?? String(err)) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { name: "openrouter", route, healthCheck };
}
