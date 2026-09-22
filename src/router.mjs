import { selectProvider, unavailableMessage } from "./providers/select.mjs";
import { log } from "./log.mjs";
import { redactText } from "./sanitize.mjs";

/**
 * Asks Jev which tier fits this prompt, through whichever provider `JEV_PROVIDER`/the
 * available keys select (FR-001). Returns null on any failure — no provider configured, an
 * explicit misconfiguration, a timeout, or a provider error — which the policy layer reads as
 * "keep the current model". Routing must never block a prompt (FR-020).
 *
 * This is a thin compatibility facade over `providers/select.mjs`: callers (`proxy.mjs`,
 * `codex-proxy.mjs`) keep injecting a `route` function with this exact signature, so neither
 * needs to know a provider abstraction exists underneath.
 *
 * @returns {Promise<?{
 *   choice: string, confidence: ?number, probabilities: ?object, metrics: object,
 *   decisionId: ?string, configuredModel: ?string, resolvedModel: ?string,
 *   usage: {inputTokens: ?number, outputTokens: ?number}, cost: ?number,
 *   provider: string, request: object, raw: object, ms: number,
 * }>}
 */
export async function askJev({ prompt, current, contextTokens, models, env = process.env }) {
  if (!models?.length) return null;
  const selected = selectProvider(env);
  if (selected.status !== "ok") {
    log(`routing unavailable (${unavailableMessage(selected)}), keeping ${current}`);
    return null;
  }
  const result = await selected.provider.route({ prompt, current, contextTokens, models });
  if (!result.ok) {
    // A provider error may echo the request or a header back in its message.
    log(`routing failed (${result.category}), keeping ${current}: ${redactText(result.message)}`);
    return null;
  }
  const { ok, ...normalized } = result;
  return { ...normalized, provider: selected.provider.name };
}
