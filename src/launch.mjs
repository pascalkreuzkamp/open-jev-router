// What every launcher shares: finding an upstream executable, and the environment that points
// a Claude client at a Jev proxy.
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { AUTO_MODEL } from "./config.mjs";

/**
 * Finds an executable on PATH. Resolving it here rather than leaning on the shell means
 * arguments are passed as an array (no quoting hazard, no DEP0190 warning) and a missing
 * install produces a useful message instead of a shell error. npm-style installs on Windows
 * are a `.cmd` shim, which Node still refuses to run without a shell.
 */
export function resolveExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const win = platform === "win32";
  const exts = win ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), `${name}${ext}`);
      try {
        accessSync(file, constants.X_OK);
        return { file, shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

/** Arguments for `spawn`; a `.cmd` shim runs through a shell, so spaced ones are quoted. */
export const spawnArgs = (resolved, args) =>
  resolved.shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;

/**
 * Registers "Jev Router" as an extra row in Claude Code's /model picker. Claude Code sends
 * the id verbatim because it does not validate model names behind a custom base URL, which
 * is what lets the proxy tell "route this" from "the user picked a model". Capabilities are
 * declared so Claude Code still composes thinking and effort for the tiers that support
 * them; the proxy strips what the routed model cannot accept.
 */
export function autoModelEnv({ env = process.env, defaultToRouter = true } = {}) {
  const out = {
    ANTHROPIC_CUSTOM_MODEL_OPTION: AUTO_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Jev Router",
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Route each turn to the cheapest model that can do it",
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
      "thinking,adaptive_thinking,interleaved_thinking,effort,max_effort",
    // Some Claude Code versions validate the model client-side before it reaches the proxy;
    // this defers to the API so "jev-router" can pass through for rewriting.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  };
  // ANTHROPIC_MODEL applies to the launched process only and is never written to settings,
  // so the default costs the user nothing permanent. A model they set themselves still wins.
  if (defaultToRouter && !env.ANTHROPIC_MODEL) out.ANTHROPIC_MODEL = AUTO_MODEL;
  return out;
}

/** Everything a Claude client needs to send its API traffic through the proxy at `baseURL`. */
export const proxyEnv = (baseURL, options) => ({
  ANTHROPIC_BASE_URL: baseURL,
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  ...autoModelEnv(options),
});
