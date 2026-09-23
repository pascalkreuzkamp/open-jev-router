#!/usr/bin/env node
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  openReader,
  projectSummary,
  routeHistory,
  sessionSummary,
} from "../src/telemetry/read.mjs";
import { resolveSession } from "../src/ui/session.mjs";
import {
  buildRoutesReport,
  buildStatsReport,
  formatRoutes,
  formatStats,
} from "../src/ui/reports.mjs";
import { daemonStatus, startDaemon, stopDaemon } from "../src/daemon/control.mjs";
import { loadCredentialFiles } from "../src/credentials.mjs";
import { formatDoctor, runDoctor } from "../src/vscode/doctor.mjs";
import { startDashboard } from "../src/dashboard/server.mjs";

const HELP = `Usage:
  jev stats [--session current|<id>] [--project <path>] [--json]
  jev routes [--session current|<id>] [--json]
  jev daemon start [--json]
  jev daemon status [--json]
  jev daemon stop [--json]
  jev vscode doctor [--json]
  jev dashboard [--port <n>]

Stats and routes read local telemetry only and never contact Jev or an upstream model.
Daemon mode runs the same routing engine as jev-claude on a private loopback port. The
VS Code doctor only reads settings and suggests entries; it never writes them. Claude
token counts describe subscription usage; routing cost is actual Jev-provider cost.
The dashboard serves a read-only view of the same telemetry on 127.0.0.1 until Ctrl+C;
it never shows prompt content and never changes routing.`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { help: true };
  }
  if (!new Set(["stats", "routes", "daemon", "vscode", "dashboard"]).has(command)) {
    return { error: `unknown command: ${command}` };
  }
  if (command === "dashboard") {
    let port = 0;
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index];
      if (arg === "--help" || arg === "-h") return { help: true };
      if (arg !== "--port") return { error: `unknown option: ${arg}` };
      const value = rest[++index];
      if (!/^\d{1,5}$/.test(value ?? "") || Number(value) > 65535) {
        return { error: "--port requires a number from 0 to 65535" };
      }
      port = Number(value);
    }
    return { command, port };
  }
  if (command === "vscode") {
    const [action, ...options] = rest;
    if (action !== "doctor") return { error: "vscode requires doctor" };
    const unknown = options.find((option) => option !== "--json");
    if (unknown) return { error: `unknown option: ${unknown}` };
    return { command, action, json: options.includes("--json") };
  }
  if (command === "daemon") {
    const [action, ...options] = rest;
    if (!new Set(["start", "status", "stop"]).has(action)) {
      return { error: "daemon requires start, status, or stop" };
    }
    if (options.some((option) => option !== "--json")) {
      return { error: `unknown option: ${options.find((option) => option !== "--json")}` };
    }
    return { command, action, json: options.includes("--json") };
  }
  const options = { command, session: "current", project: null, json: false };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--session") options.session = rest[++index];
    else if (arg === "--project") options.project = rest[++index];
    else if (arg === "--help" || arg === "-h") return { help: true };
    else return { error: `unknown option: ${arg}` };
  }
  if (!options.session) return { error: "--session requires a value" };
  if (rest.includes("--project") && !options.project) return { error: "--project requires a value" };
  if (command === "routes" && options.project) return { error: "routes does not support --project" };
  if (options.project && options.session !== "current") {
    return { error: "choose either --project or --session" };
  }
  return options;
}

const failure = (code, message, details = {}) => ({
  ok: false,
  code,
  message,
  ...details,
});

export async function run(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  if (args.help) return { exitCode: 0, stdout: `${HELP}\n` };
  if (args.error) return { exitCode: 2, stderr: `${args.error}\n\n${HELP}\n` };
  if (args.command === "daemon") return runDaemon(args, env);
  if (args.command === "dashboard") {
    try {
      const dashboard = await startDashboard({ env, cwd, port: args.port });
      return {
        exitCode: 0,
        stdout: `[jev] dashboard at ${dashboard.url} (read-only; Ctrl+C to stop)\n`,
        dashboard,
      };
    } catch (error) {
      return { exitCode: 1, stderr: `[jev] dashboard could not start: ${error.message}\n` };
    }
  }
  if (args.command === "vscode") {
    const report = await runDoctor({ env });
    const exitCode = report.ok ? 0 : 1;
    return args.json
      ? { exitCode, stdout: `${JSON.stringify(report)}\n` }
      : { exitCode, stdout: `${formatDoctor(report)}\n` };
  }

  const db = openReader({ env });
  if (!db) {
    const result = failure("telemetry_unavailable", "No readable telemetry database was found.");
    return args.json
      ? { exitCode: 1, stdout: `${JSON.stringify(result)}\n` }
      : { exitCode: 1, stderr: `${result.message}\n` };
  }
  try {
    if (args.command === "stats" && args.project) {
      const path = resolve(cwd, args.project);
      const summary = projectSummary(db, path);
      if (!summary) return renderFailure(args, failure("no_sessions", `No sessions found for ${path}.`));
      const report = buildStatsReport(summary);
      return renderSuccess(args, report, formatStats);
    }

    const selected = resolveSession(db, {
      requested: args.session,
      projectPath: cwd,
      env,
    });
    if (selected.error) {
      const ids = selected.candidates?.map(({ id }) => id) ?? [];
      const message = selected.error === "ambiguous"
        ? `Multiple active sessions match this project; use --session <id>: ${ids.join(", ")}`
        : selected.error === "not_found"
          ? `Session not found: ${selected.requested}`
          : `No sessions found for ${selected.projectPath}.`;
      return renderFailure(args, failure(selected.error, message, { candidates: ids }));
    }
    if (args.command === "stats") {
      const report = buildStatsReport(sessionSummary(db, selected.session.id), {
        selectionSource: selected.source,
      });
      return renderSuccess(args, report, formatStats);
    }
    const scope = {
      type: "session",
      id: selected.session.id,
      projectPath: selected.session.projectPath,
      selectionSource: selected.source,
    };
    return renderSuccess(
      args,
      buildRoutesReport(routeHistory(db, { sessionId: selected.session.id }), scope),
      formatRoutes,
    );
  } catch (error) {
    return renderFailure(
      args,
      failure("telemetry_read_failed", `Telemetry could not be read: ${error.message}`),
    );
  } finally {
    db.close();
  }
}

async function runDaemon(args, env) {
  if (args.action === "start") {
    loadCredentialFiles();
    const result = await startDaemon({ env });
    if (!result.ok) return daemonFailure(args, result);
    const output = {
      ok: true,
      state: "running",
      alreadyRunning: result.alreadyRunning,
      runtime: result.runtime,
      health: result.health,
    };
    return args.json
      ? { exitCode: 0, stdout: `${JSON.stringify(output)}\n` }
      : {
          exitCode: 0,
          stdout: `[jev] daemon ${result.alreadyRunning ? "already running" : "started"} at ${daemonURL(result.runtime)} (pid ${result.runtime.pid})\n`,
        };
  }
  if (args.action === "status") {
    const result = await daemonStatus({ env });
    if (args.json) {
      return { exitCode: result.state === "running" ? 0 : 1, stdout: `${JSON.stringify(result)}\n` };
    }
    if (result.state === "running") {
      return {
        exitCode: 0,
        stdout:
          `[jev] daemon running at ${daemonURL(result.runtime)} (pid ${result.runtime.pid})\n` +
          `[jev] provider ${result.health.provider}; key ${result.health.provider_key_available ? "available" : "unavailable"}; telemetry ${result.health.telemetry ? "enabled" : "disabled"}\n`,
      };
    }
    if (result.state === "stale") {
      return {
        exitCode: 1,
        stderr: `[jev] daemon runtime state is stale (${result.reason}); no process was signalled\n`,
      };
    }
    return { exitCode: 1, stderr: "[jev] daemon is not running\n" };
  }
  const result = await stopDaemon({ env });
  if (!result.ok) return daemonFailure(args, result);
  const output = { ok: true, state: "stopped", alreadyStopped: result.alreadyStopped };
  return args.json
    ? { exitCode: 0, stdout: `${JSON.stringify(output)}\n` }
    : {
        exitCode: 0,
        stdout: `[jev] daemon ${result.alreadyStopped ? "already stopped" : "stopped"}\n`,
      };
}

function daemonFailure(args, result) {
  const output = { ok: false, code: result.code, message: result.message };
  return args.json
    ? { exitCode: 1, stdout: `${JSON.stringify(output)}\n` }
    : { exitCode: 1, stderr: `[jev] ${result.message}\n` };
}

function daemonURL(runtime) {
  const host = runtime.host === "::1" ? "[::1]" : runtime.host;
  return `http://${host}:${runtime.port}`;
}

function renderSuccess(args, report, formatter) {
  return { exitCode: 0, stdout: `${args.json ? JSON.stringify(report) : formatter(report)}\n` };
}

function renderFailure(args, result) {
  return args.json
    ? { exitCode: 1, stdout: `${JSON.stringify(result)}\n` }
    : { exitCode: 1, stderr: `${result.message}\n` };
}

// npm installs a bin as a symlink into node_modules/.bin, so argv[1] is the link while
// import.meta.url is the file Node actually resolved. Comparing them unresolved made the
// installed `jev` command exit 0 having done nothing at all.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const result = await run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
  if (result.dashboard) {
    const stop = () => {
      result.dashboard.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
}
