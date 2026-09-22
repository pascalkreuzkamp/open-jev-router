#!/usr/bin/env node
import { resolve } from "node:path";
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

const HELP = `Usage:
  jev stats [--session current|<id>] [--project <path>] [--json]
  jev routes [--session current|<id>] [--json]

Read local telemetry only. These commands never contact Jev or an upstream model.
Claude token counts describe subscription usage; routing cost is actual Jev-provider cost.`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { help: true };
  }
  if (!new Set(["stats", "routes"]).has(command)) {
    return { error: `unknown command: ${command}` };
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

export function run(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  if (args.help) return { exitCode: 0, stdout: `${HELP}\n` };
  if (args.error) return { exitCode: 2, stderr: `${args.error}\n\n${HELP}\n` };

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

function renderSuccess(args, report, formatter) {
  return { exitCode: 0, stdout: `${args.json ? JSON.stringify(report) : formatter(report)}\n` };
}

function renderFailure(args, result) {
  return args.json
    ? { exitCode: 1, stdout: `${JSON.stringify(result)}\n` }
    : { exitCode: 1, stderr: `${result.message}\n` };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
