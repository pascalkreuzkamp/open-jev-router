import { DEFAULT_OPENROUTER_MODEL, jevTimeoutMs } from "../config.mjs";
import { createOpenRouterProvider } from "./openrouter.mjs";
import { createTypeSafeProvider } from "./typesafe.mjs";

/**
 * Resolves which Jev provider to use (FR-001):
 *
 * 1. an explicit `JEV_PROVIDER` always wins, so a typo or a selected-but-unconfigured
 *    provider is a visible unavailable state, never a silent fall-through to whichever other
 *    key happens to be set;
 * 2. otherwise prefer OpenRouter if `OPENROUTER_API_KEY` is set;
 * 3. otherwise use direct TypeSafe if `JEV_API_KEY` or `TYPESAFE_API_KEY` is set;
 * 4. otherwise routing is unavailable and the caller fails open.
 *
 * @returns {{status: "ok", provider: object} | {status: "unavailable", reason: string, name?: string}}
 */
export function selectProvider(env = process.env) {
  const explicit = env.JEV_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (explicit !== "openrouter" && explicit !== "typesafe") {
      return { status: "unavailable", reason: "unknown_provider", name: explicit };
    }
    return fromName(explicit, env);
  }
  if (env.OPENROUTER_API_KEY) return fromName("openrouter", env);
  if (env.JEV_API_KEY || env.TYPESAFE_API_KEY) return fromName("typesafe", env);
  return { status: "unavailable", reason: "no_key" };
}

function fromName(name, env) {
  if (name === "openrouter") {
    if (!env.OPENROUTER_API_KEY) return { status: "unavailable", reason: "missing_key", name };
    return {
      status: "ok",
      provider: createOpenRouterProvider({
        apiKey: env.OPENROUTER_API_KEY,
        model: env.JEV_OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
        // Not a documented OpenRouter setting; mirrors the TypeSafe SDK's own
        // `TYPESAFE_BASE_URL` override so tests (and any self-hosted gateway) can redirect
        // requests without touching the real network.
        ...(env.OPENROUTER_BASE_URL ? { baseURL: env.OPENROUTER_BASE_URL } : {}),
        timeoutMs: jevTimeoutMs(env),
      }),
    };
  }
  const apiKey = env.JEV_API_KEY || env.TYPESAFE_API_KEY;
  if (!apiKey) return { status: "unavailable", reason: "missing_key", name };
  return { status: "ok", provider: createTypeSafeProvider({ apiKey, timeoutMs: jevTimeoutMs(env) }) };
}

/** Whether any provider key is configured at all, without resolving `JEV_PROVIDER` semantics. Used by the launchers to decide whether to start the proxy in the first place. */
export const hasAnyProviderKey = (env = process.env) =>
  Boolean(env.OPENROUTER_API_KEY || env.JEV_API_KEY || env.TYPESAFE_API_KEY);

/** Human-readable reason for an `{status: "unavailable"}` result, shared by every caller. */
export function unavailableMessage(selected) {
  if (selected.reason === "no_key") return "no provider key configured";
  if (selected.reason === "unknown_provider") return `unknown JEV_PROVIDER "${selected.name}"`;
  if (selected.reason === "missing_key") return `${selected.name} selected but its key is missing`;
  return selected.reason;
}
