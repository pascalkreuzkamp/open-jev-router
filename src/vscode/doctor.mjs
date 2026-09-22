// `jev vscode doctor`: diagnoses the path from the official Claude Code extension to the local
// daemon. It reads and reports; it never writes settings, starts processes, or adds keys.
import { homedir } from "node:os";
import { daemonStatus as readDaemonStatus } from "../daemon/control.mjs";
import { configuredPort, readLastPort } from "../daemon/runtime.mjs";
import { discover as discoverVersions, EXTENSION_ID } from "./discover.mjs";
import { classify, MIN_VSCODE, compareVersions } from "./compatibility.mjs";
import {
  ENV_SETTING,
  WRAPPER_SETTING,
  inspectEnvironmentVariables,
  readSettingsFile,
  recommendedEntries,
  sharedClaudeBaseURL,
  userSettingsPath,
} from "./settings.mjs";

const check = (id, status, message) => ({ id, status, message });

export function daemonBaseURL(runtime) {
  if (!runtime) return null;
  const host = runtime.host === "::1" ? "[::1]" : runtime.host;
  return `http://${host}:${runtime.port}`;
}

/** The URL the settings should name: the live daemon's, else the port it will come back on. */
function expectedBaseURL(daemon, env) {
  if (daemon.state === "running") return daemonBaseURL(daemon.runtime);
  let port = null;
  try {
    port = configuredPort(env) ?? readLastPort(env);
  } catch {
    port = null;
  }
  return port ? `http://127.0.0.1:${port}` : null;
}

export async function runDoctor({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  discover = discoverVersions,
  daemonStatus = readDaemonStatus,
  readFile,
} = {}) {
  const checks = [];
  const [found, daemon] = await Promise.all([discover({ env, platform }), daemonStatus({ env })]);

  // VS Code itself.
  if (!found.code) {
    checks.push(check("vscode", "unknown", "`code` is not on PATH; VS Code version unknown (set JEV_VSCODE_BIN to its CLI)"));
  } else if (!found.vscode) {
    checks.push(check("vscode", "unknown", "`code --version` gave no readable version"));
  } else if (compareVersions(found.vscode.version, MIN_VSCODE) < 0) {
    checks.push(check("vscode", "fail", `VS Code ${found.vscode.version} is older than ${MIN_VSCODE}, which the extension requires`));
  } else {
    checks.push(check("vscode", "ok", `VS Code ${found.vscode.version}`));
  }

  // The extension.
  if (found.extension === undefined) {
    checks.push(check("extension", "fail", `${EXTENSION_ID} is not installed`));
  } else if (found.extension === null) {
    checks.push(check("extension", "unknown", "installed extensions could not be listed"));
  } else {
    checks.push(check("extension", "ok", `${EXTENSION_ID} ${found.extension}`));
  }

  // The daemon.
  if (daemon.state === "running") {
    checks.push(check("daemon", "ok", `daemon healthy at ${daemonBaseURL(daemon.runtime)} (pid ${daemon.runtime.pid})`));
    if (daemon.health?.provider_key_available === false) {
      checks.push(check("provider", "warn", "the daemon has no routing provider key, so requests pass through unrouted"));
    }
  } else if (daemon.state === "stale") {
    checks.push(check("daemon", "fail", `daemon runtime state is stale (${daemon.reason}); run \`jev daemon start\``));
  } else {
    checks.push(check("daemon", "warn", "daemon is not running; run `jev daemon start` (or launch with `jev-code`)"));
  }
  const baseURL = expectedBaseURL(daemon, env);

  // The extension settings.
  const settingsPath = userSettingsPath({ env, platform, home });
  const read = readSettingsFile(settingsPath, readFile ? { readFile } : {});
  let settingsState = null;
  if (read.state === "missing") {
    checks.push(check("settings", "warn", `no VS Code user settings at ${settingsPath}; ${ENV_SETTING} is unset`));
  } else if (read.state !== "ok") {
    checks.push(check("settings", read.state === "invalid" ? "fail" : "unknown", `${settingsPath} could not be ${read.state === "invalid" ? `parsed: ${read.reason}` : "read"}`));
  } else {
    settingsState = inspectEnvironmentVariables(read.settings, baseURL);
    const others = settingsState.otherNames?.length ? `; keeps your other entries: ${settingsState.otherNames.join(", ")}` : "";
    const messages = {
      unset: ["warn", `${ENV_SETTING} is unset`],
      invalid: ["fail", `${ENV_SETTING} has an unsupported shape: ${settingsState.reason}`],
      no_base_url: ["warn", `${ENV_SETTING} has no ANTHROPIC_BASE_URL entry${others}`],
      unknown_daemon: ["unknown", `ANTHROPIC_BASE_URL is ${settingsState.configuredBaseURL}, but the daemon port is not known yet`],
      mismatch: ["fail", `ANTHROPIC_BASE_URL is ${settingsState.configuredBaseURL}, but the daemon is at ${baseURL}`],
      match: settingsState.missing?.length
        ? ["warn", `ANTHROPIC_BASE_URL points at the daemon; missing ${settingsState.missing.join(", ")} (no Jev Router picker row)`]
        : ["ok", "ANTHROPIC_BASE_URL points at the daemon"],
    };
    const [status, message] = messages[settingsState.state];
    checks.push(check("settings", status, message));
    if (typeof read.settings[WRAPPER_SETTING] === "string") {
      checks.push(check("wrapper", "warn", `${WRAPPER_SETTING} is set; the wrapper must not replace ANTHROPIC_BASE_URL`));
    }
  }
  const shared = sharedClaudeBaseURL({ home, ...(readFile ? { readFile } : {}) });
  if (shared) {
    checks.push(check("claude_settings", "warn", "~/.claude/settings.json sets env.ANTHROPIC_BASE_URL too; the two must agree"));
  }

  // Observed traffic is the only evidence that requests actually reach the router.
  const traffic = daemon.state === "running" ? daemon.health?.traffic : null;
  if (!traffic) {
    checks.push(check("traffic", "unknown", "routing unverified: no running daemon reports traffic"));
  } else if (traffic.messages > 0) {
    checks.push(check("traffic", "ok", `daemon has forwarded ${traffic.messages} message request(s), ${traffic.routed} routed; last at ${traffic.last_message_at} (daemon-wide, from any client)`));
  } else {
    checks.push(check("traffic", "unknown", "routing unverified: the daemon has not seen a request yet; send one from the extension and rerun"));
  }

  const compatibility = classify({ vscode: found.vscode?.version, extension: found.extension || null });
  checks.push(check("compatibility", compatibility.status === "supported" ? "ok" : compatibility.status === "incompatible" ? "fail" : "warn", `${compatibility.status}: ${compatibility.note}`));

  const needsSettings = settingsState?.state !== "match" || settingsState.missing.length > 0;
  return {
    ok: !checks.some(({ status }) => status === "fail"),
    routing: checks.find(({ id }) => id === "traffic").status === "ok" ? "observed" : "unverified",
    compatibility,
    versions: { vscode: found.vscode?.version ?? null, extension: found.extension || null },
    settingsPath,
    checks,
    suggestion: needsSettings && baseURL ? { setting: ENV_SETTING, entries: recommendedEntries(baseURL) } : null,
    notes: [
      "A VS Code window that is already running keeps the environment it started with; reload the window after changing settings.",
      "Fallback: run `jev-claude` in the VS Code integrated terminal.",
    ],
  };
}

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL", unknown: " ?  " };

export function formatDoctor(report) {
  const lines = ["Jev VS Code doctor", ""];
  for (const { status, message } of report.checks) lines.push(`  [${MARK[status]}] ${message}`);
  lines.push("", `Routing: ${report.routing}. GUI support: ${report.compatibility.status}.`);
  if (report.suggestion) {
    lines.push(
      "",
      `Add or update these entries in "${report.suggestion.setting}" (${report.settingsPath}),`,
      "keeping any other entries you already have. Nothing was written:",
      "",
      JSON.stringify(report.suggestion.entries, null, 2).replace(/^/gm, "  "),
    );
  } else if (!report.checks.some(({ id, status }) => id === "settings" && status === "ok")) {
    lines.push("", "Start the daemon (`jev daemon start`) so the doctor can suggest settings for its port.");
  }
  lines.push("", ...report.notes);
  return lines.join("\n");
}
