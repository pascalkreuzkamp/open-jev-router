// Read-only inspection of VS Code's user settings for the Claude Code extension. Nothing here
// writes a settings file: the doctor suggests entries and the user applies them.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { proxyEnv } from "../launch.mjs";

export const ENV_SETTING = "claudeCode.environmentVariables";
export const WRAPPER_SETTING = "claudeCode.claudeProcessWrapper";

/** Where stable VS Code keeps user settings. `JEV_VSCODE_SETTINGS` covers Insiders and forks. */
export function userSettingsPath({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.JEV_VSCODE_SETTINGS) return env.JEV_VSCODE_SETTINGS;
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User", "settings.json");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "Code", "User", "settings.json");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Code", "User", "settings.json");
}

/**
 * VS Code settings are JSONC: comments and trailing commas are legal. Both are removed
 * outside string literals, then the rest is ordinary JSON.
 */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1") || "{}");
}

/** Reads and parses a settings file; `missing` and `invalid` are reported, never thrown. */
export function readSettingsFile(path, { readFile = readFileSync } = {}) {
  let text;
  try {
    text = readFile(path, "utf8");
  } catch (error) {
    return { state: error?.code === "ENOENT" ? "missing" : "unreadable", path };
  }
  try {
    const settings = parseJsonc(text);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return { state: "invalid", path, reason: "settings root is not an object" };
    }
    return { state: "ok", path, settings };
  } catch (error) {
    return { state: "invalid", path, reason: error.message };
  }
}

/** The entries the doctor recommends. The picker row is offered, never forced as a default. */
export const recommendedEntries = (baseURL) =>
  Object.entries(proxyEnv(baseURL, { defaultToRouter: false })).map(([name, value]) => ({ name, value }));

/**
 * Checks `claudeCode.environmentVariables` against the documented shape, an array of
 * `{ name, value }` string pairs, and against the daemon URL. Only entry names are returned
 * for anything the router did not write: other values may be credentials.
 */
export function inspectEnvironmentVariables(settings, baseURL) {
  const raw = settings?.[ENV_SETTING];
  if (raw === undefined) return { state: "unset", entries: [], otherNames: [] };
  if (!Array.isArray(raw)) return { state: "invalid", reason: `${ENV_SETTING} must be an array` };
  const bad = raw.findIndex(
    (entry) => !entry || typeof entry !== "object" || typeof entry.name !== "string" || typeof entry.value !== "string",
  );
  if (bad !== -1) {
    return { state: "invalid", reason: `entry ${bad} must be an object with string "name" and "value"` };
  }
  const ours = new Set(recommendedEntries(baseURL ?? "").map(({ name }) => name));
  const otherNames = raw.filter(({ name }) => !ours.has(name)).map(({ name }) => name);
  const configured = raw.findLast(({ name }) => name === "ANTHROPIC_BASE_URL");
  if (!configured) return { state: "no_base_url", otherNames };
  const baseURLState = !baseURL
    ? "unknown_daemon"
    : sameEndpoint(configured.value, baseURL)
      ? "match"
      : "mismatch";
  const missing = recommendedEntries(baseURL ?? "")
    .filter(({ name }) => name !== "ANTHROPIC_BASE_URL" && !raw.some((entry) => entry.name === name))
    .map(({ name }) => name);
  return {
    state: baseURLState,
    // Our own base URL is safe to echo; it is loopback and carries no credential.
    configuredBaseURL: isLoopback(configured.value) ? configured.value : "(non-loopback URL, not shown)",
    missing,
    otherNames,
  };
}

function sameEndpoint(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const host = (h) => (h === "localhost" ? "127.0.0.1" : h);
    return x.protocol === y.protocol && host(x.hostname) === host(y.hostname) && x.port === y.port;
  } catch {
    return false;
  }
}

function isLoopback(value) {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** `~/.claude/settings.json` is shared by the CLI and extension and may set its own base URL. */
export function sharedClaudeBaseURL({ home = homedir(), readFile = readFileSync } = {}) {
  const read = readSettingsFile(join(home, ".claude", "settings.json"), { readFile });
  if (read.state !== "ok") return null;
  const value = read.settings?.env?.ANTHROPIC_BASE_URL;
  return typeof value === "string" ? value : null;
}
