// `bin/jev-claude.mjs` is a top-level script, not a module, so the only honest way to test it
// is to run it: a stub `claude` on PATH records the argv and environment it was handed, and
// the assertions are made against that record. Everything is redirected into a temporary HOME
// and working directory, so a developer's real `~/.claude/settings.json`, `~/.jev-*.env` and
// project `.env` cannot reach the launcher or be modified by it.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../../bin/jev-claude.mjs", import.meta.url));
const windows = process.platform === "win32";
// The stub is a shell script, which Windows will not execute from PATH the same way.
const skipOnWindows = { skip: windows ? "POSIX stub executable" : false };

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "jev-launcher-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  const bin = join(root, "bin");
  for (const dir of [home, cwd, bin]) mkdirSync(dir, { recursive: true });
  const record = join(root, "claude-invocation.json");
  // Records what the launcher handed the real CLI, then exits like a clean session.
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}
require("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
process.exit(0);
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  return { root, home, cwd, bin, record };
}

async function run(t, { env = {}, args = [], withClaude = true } = {}) {
  const space = workspace(t);
  const child = spawn(process.execPath, [LAUNCHER, ...args], {
    cwd: space.cwd,
    env: {
      // A deliberately minimal environment: nothing of the developer's own leaks in.
      PATH: withClaude ? space.bin : join(space.root, "empty"),
      HOME: space.home,
      USERPROFILE: space.home,
      TMPDIR: space.root,
      NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? "",
      JEV_ENABLE_TELEMETRY: "0",
      JEV_NO_STATUSLINE: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  const invocation = existsSync(space.record) ? JSON.parse(readFileSync(space.record, "utf8")) : null;
  return { ...space, code, stderr, stdout, invocation };
}

/** A routing provider that answers the launcher's free health check and nothing else. */
async function jevStub(t) {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: { label: "test key", usage: 0 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const routing = async (t) => ({
  OPENROUTER_API_KEY: "sk-or-launcher-canary",
  OPENROUTER_BASE_URL: await jevStub(t),
});

test("a missing Claude Code install fails with setup guidance, not a shell error", async (t) => {
  const result = await run(t, { withClaude: false });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Claude Code is not installed/);
  assert.match(result.stderr, /code\.claude\.com\/docs/);
});

test("with no provider key Claude Code still starts, unrouted and unproxied", skipOnWindows, async (t) => {
  const result = await run(t);

  assert.equal(result.code, 0);
  assert.match(result.stderr, /no provider key found/);
  assert.match(result.stderr, /OPENROUTER_API_KEY, JEV_API_KEY, or TYPESAFE_API_KEY/);
  assert.ok(result.invocation, "Claude Code was launched anyway");
  assert.equal(result.invocation.env.ANTHROPIC_BASE_URL, undefined, "no proxy was interposed");
  assert.equal(result.invocation.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined, "no picker row was offered");
});

test("with a provider key the child is pointed at a loopback proxy and the picker row is registered", skipOnWindows, async (t) => {
  const result = await run(t, { env: await routing(t) });

  assert.equal(result.code, 0);
  const env = result.invocation.env;
  assert.match(
    env.ANTHROPIC_BASE_URL,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    "the proxy is bound to loopback only, never a routable interface",
  );
  assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION, "jev-router");
  assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, "Jev Router");
  assert.ok(env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION);
  assert.match(env.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES, /effort/);
  assert.equal(env.ANTHROPIC_MODEL, "jev-router", "the session starts on the routed row");
  assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.match(result.stderr, /routing via openrouter/);
  assert.match(result.stderr, /not full tool output or repository contents/, "the data sent for routing is disclosed");
});

test("a model the user set themselves survives; the router only supplies a default", skipOnWindows, async (t) => {
  const result = await run(t, { env: { ...(await routing(t)), ANTHROPIC_MODEL: "claude-opus-5" } });

  assert.equal(result.invocation.env.ANTHROPIC_MODEL, "claude-opus-5");
  assert.equal(result.invocation.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "jev-router", "the row is still offered");
});

test("session arguments pass through untouched, including --resume and print mode", skipOnWindows, async (t) => {
  const result = await run(t, {
    env: await routing(t),
    args: ["--resume", "6f1c2f2a-0000-4000-8000-abcdefabcdef", "-p", "summarise the diff", "--verbose"],
  });

  const argv = result.invocation.argv;
  assert.deepEqual(
    argv.slice(0, 5),
    ["--resume", "6f1c2f2a-0000-4000-8000-abcdefabcdef", "-p", "summarise the diff", "--verbose"],
    "user arguments keep their order and position",
  );
  assert.ok(argv.includes("--add-dir"), "the router's own directory is still added");
});

test("a statusline is installed by default and suppressed on request", skipOnWindows, async (t) => {
  const on = await run(t, { env: { ...(await routing(t)), JEV_NO_STATUSLINE: "" } });
  const settingsIndex = on.invocation.argv.indexOf("--settings");
  assert.notEqual(settingsIndex, -1, "a generated settings file is passed");
  const settings = JSON.parse(readFileSync(on.invocation.argv[settingsIndex + 1], "utf8"));
  assert.equal(settings.statusLine.type, "command");
  assert.match(settings.statusLine.command, /jev-statusline\.mjs/);

  const off = await run(t, { env: await routing(t) });
  assert.equal(off.invocation.argv.includes("--settings"), false, "JEV_NO_STATUSLINE leaves settings alone");
});

test("a statusline the user configured themselves is never overwritten", skipOnWindows, async (t) => {
  const space = workspace(t);
  mkdirSync(join(space.home, ".claude"), { recursive: true });
  writeFileSync(
    join(space.home, ".claude", "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command: "mine" } }),
  );
  const child = spawn(process.execPath, [LAUNCHER], {
    cwd: space.cwd,
    env: {
      PATH: space.bin,
      HOME: space.home,
      USERPROFILE: space.home,
      TMPDIR: space.root,
      JEV_ENABLE_TELEMETRY: "0",
      ...(await routing(t)),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise((resolve) => child.on("exit", resolve));

  const invocation = JSON.parse(readFileSync(space.record, "utf8"));
  assert.equal(invocation.argv.includes("--settings"), false);
  assert.equal(
    JSON.parse(readFileSync(join(space.home, ".claude", "settings.json"), "utf8")).statusLine.command,
    "mine",
  );
});

test("a sentinel left in the saved settings is restored to the previous model on exit", skipOnWindows, async (t) => {
  const space = workspace(t);
  mkdirSync(join(space.home, ".claude"), { recursive: true });
  const settings = join(space.home, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ model: "claude-sonnet-5", theme: "dark" }));
  // The stub stands in for Claude Code saving the picker row chosen with Enter.
  writeFileSync(
    join(space.bin, "claude"),
    `#!${process.execPath}
const fs = require("fs");
const file = ${JSON.stringify(settings)};
const current = JSON.parse(fs.readFileSync(file, "utf8"));
fs.writeFileSync(file, JSON.stringify({ ...current, model: "jev-router" }));
fs.writeFileSync(${JSON.stringify(space.record)}, JSON.stringify({ argv: [], env: {} }));
process.exit(0);
`,
  );
  chmodSync(join(space.bin, "claude"), 0o755);

  const child = spawn(process.execPath, [LAUNCHER], {
    cwd: space.cwd,
    env: {
      PATH: space.bin,
      HOME: space.home,
      USERPROFILE: space.home,
      TMPDIR: space.root,
      JEV_ENABLE_TELEMETRY: "0",
      JEV_NO_STATUSLINE: "1",
      ...(await routing(t)),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise((resolve) => child.on("exit", resolve));

  const after = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(after.model, "claude-sonnet-5", "plain `claude` is not left pointed at the sentinel");
  assert.equal(after.theme, "dark", "unrelated settings are preserved");
});

test("a provider-specific configuration file is read from the user's home directory", skipOnWindows, async (t) => {
  const space = workspace(t);
  writeFileSync(join(space.home, ".jev-router.env"), `OPENROUTER_API_KEY=sk-or-from-file\nOPENROUTER_BASE_URL=${await jevStub(t)}\n`);
  const child = spawn(process.execPath, [LAUNCHER], {
    cwd: space.cwd,
    env: {
      PATH: space.bin,
      HOME: space.home,
      USERPROFILE: space.home,
      TMPDIR: space.root,
      JEV_ENABLE_TELEMETRY: "0",
      JEV_NO_STATUSLINE: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  await new Promise((resolve) => child.on("exit", resolve));

  assert.match(stderr, /routing via openrouter/, "a key from ~/.jev-router.env enables routing");
  const invocation = JSON.parse(readFileSync(space.record, "utf8"));
  assert.match(invocation.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("an explicitly selected provider with no key disables routing instead of guessing", skipOnWindows, async (t) => {
  const result = await run(t, { env: { JEV_PROVIDER: "openrouter" } });

  assert.equal(result.code, 0);
  assert.ok(result.invocation, "Claude Code still starts");
  assert.match(result.stderr, /no provider key found|routing is unavailable/);
  assert.equal(result.invocation.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
});

test("the launcher exits with the child's exit code", skipOnWindows, async (t) => {
  const space = workspace(t);
  writeFileSync(join(space.bin, "claude"), `#!${process.execPath}\nprocess.exit(17);\n`);
  chmodSync(join(space.bin, "claude"), 0o755);
  const child = spawn(process.execPath, [LAUNCHER], {
    cwd: space.cwd,
    env: {
      PATH: space.bin,
      HOME: space.home,
      USERPROFILE: space.home,
      TMPDIR: space.root,
      JEV_ENABLE_TELEMETRY: "0",
      JEV_NO_STATUSLINE: "1",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));

  assert.equal(code, 17);
});
