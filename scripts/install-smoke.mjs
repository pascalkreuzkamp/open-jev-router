#!/usr/bin/env node
// Packs the real tarball, installs it into a throwaway directory and runs every published
// entrypoint from that install (phase step 5). Kept out of `npm test` and CI because a real
// `npm install` reaches the registry for dependencies; `test/integration/packaging.test.mjs`
// covers the offline half of the same question.
//
// Run: npm run test:pack
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const checks = [];
const check = (description, run) => {
  try {
    const detail = run();
    checks.push({ description, ok: true, detail });
    process.stdout.write(`ok    ${description}${detail ? ` (${detail})` : ""}\n`);
  } catch (error) {
    checks.push({ description, ok: false, detail: error.message });
    process.stdout.write(`FAIL  ${description}\n      ${error.message.split("\n")[0]}\n`);
  }
};

const workspace = mkdtempSync(join(tmpdir(), "jev-install-smoke-"));
process.stdout.write(`[pack] workspace ${workspace}\n`);

const tarball = join(
  ROOT,
  JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", ROOT], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  )[0].filename,
);
process.stdout.write(`[pack] ${tarball}\n`);

try {
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "jev-install-smoke", private: true }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: workspace,
    stdio: "inherit",
  });

  const bin = join(workspace, "node_modules", ".bin");
  const run = (command, args, env = {}) =>
    execFileSync(join(bin, command), args, {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

  check("jev prints its usage", () => {
    const out = run("jev", ["--help"]);
    if (!/jev stats/.test(out) || !/jev routes/.test(out) || !/jev daemon start/.test(out)) {
      throw new Error(`unexpected help output:\n${out}`);
    }
    return "stats, routes, and daemon documented";
  });

  check("jev stats reports no telemetry as structured data, not a crash", () => {
    // With no database this exits 1 by design and prints a machine-readable reason; the
    // smoke test is that the installed CLI reaches that path rather than failing to load.
    let out;
    try {
      out = run("jev", ["stats", "--json"], { JEV_DATA_DIR: join(workspace, "data") });
    } catch (error) {
      out = error.stdout ?? "";
    }
    const parsed = JSON.parse(out);
    if (parsed.ok !== false || !parsed.code) throw new Error(`unexpected payload: ${out}`);
    return parsed.code;
  });

  check("jev-explain runs without contacting a provider", () => {
    const out = run("jev-explain", []);
    return `${out.trim().split("\n").length} lines`;
  });

  check("installed daemon starts, reports healthy, and stops", () => {
    const env = {
      JEV_DATA_DIR: join(workspace, "daemon-data"),
      JEV_ENABLE_TELEMETRY: "0",
      HOME: workspace,
      USERPROFILE: workspace,
    };
    let started = false;
    try {
      const start = JSON.parse(run("jev", ["daemon", "start", "--json"], env));
      started = start.ok === true;
      const status = JSON.parse(run("jev", ["daemon", "status", "--json"], env));
      if (!started || status.state !== "running" || status.health?.status !== "ok") {
        throw new Error(`unexpected lifecycle payload: ${JSON.stringify({ start, status })}`);
      }
      return `loopback port ${status.runtime.port}`;
    } finally {
      if (started) run("jev", ["daemon", "stop", "--json"], env);
    }
  });

  // A PATH holding node and nothing else: the launcher can still run, but cannot find the
  // CLI it wraps. Dropping node from PATH would only prove the shebang cannot resolve.
  const nodeOnlyPath = dirname(process.execPath);

  check("jev-claude reports a missing Claude Code install rather than crashing", () => {
    try {
      run("jev-claude", [], { PATH: nodeOnlyPath });
      throw new Error("expected a nonzero exit");
    } catch (error) {
      const text = `${error.stderr ?? ""}${error.stdout ?? ""}`;
      if (!/Claude Code is not installed/.test(text)) throw new Error(`unexpected output:\n${text}`);
      return "actionable message";
    }
  });

  check("jev-codex reports a missing Codex install rather than crashing", () => {
    try {
      run("jev-codex", ["exec", "hello"], { PATH: nodeOnlyPath });
      throw new Error("expected a nonzero exit");
    } catch (error) {
      const text = `${error.stderr ?? ""}${error.stdout ?? ""}`;
      if (!text.trim()) throw new Error("no diagnostic output at all");
      return "actionable message";
    }
  });

  check("jev-code reports a missing VS Code CLI rather than crashing", () => {
    try {
      run("jev-code", [], { PATH: nodeOnlyPath });
      throw new Error("expected a nonzero exit");
    } catch (error) {
      const text = `${error.stderr ?? ""}${error.stdout ?? ""}`;
      if (!/`code` command is not on your PATH/.test(text)) throw new Error(`unexpected output: ${text.trim()}`);
      return "actionable message";
    }
  });

  check("jev vscode doctor runs from the installed package", () => {
    // Exits 1 when a check fails (no extension here), so the report is read either way.
    const env = { PATH: nodeOnlyPath, HOME: workspace, USERPROFILE: workspace, JEV_DATA_DIR: join(workspace, "data") };
    let out;
    try {
      out = run("jev", ["vscode", "doctor", "--json"], env);
    } catch (error) {
      out = error.stdout;
    }
    const report = JSON.parse(out || "{}");
    if (!Array.isArray(report.checks)) throw new Error("no checks in the report");
    return `${report.checks.length} checks, routing ${report.routing}`;
  });
} finally {
  rmSync(tarball, { force: true });
  rmSync(workspace, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok).length;
process.stdout.write(`[pack] ${checks.length - failed} passed, ${failed} failed on node ${process.version}\n`);
process.exit(failed ? 1 : 0);
