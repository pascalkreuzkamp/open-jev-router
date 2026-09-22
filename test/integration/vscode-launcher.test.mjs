// jev-code end to end: the real launcher binary, a real daemon on a temporary data directory,
// and a fake `code` executable that records what it was given. The proxy's traffic counter,
// which the doctor treats as the only proof of routing, is checked against a mock upstream.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../../src/proxy.mjs";
import { launch } from "../../bin/jev-code.mjs";

const JEV_CODE = fileURLToPath(new URL("../../bin/jev-code.mjs", import.meta.url));
const JEV = fileURLToPath(new URL("../../bin/jev.mjs", import.meta.url));
const posix = process.platform !== "win32";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "jev-code-integration-"));
  const bin = join(root, "dir with spaces");
  mkdirSync(bin);
  const record = join(root, "code-invocation.json");
  const settings = join(root, "settings.json");
  writeFileSync(settings, '{\n  // untouched\n  "editor.fontSize": 14,\n}\n');
  writeFileSync(
    join(bin, "code"),
    `#!${process.execPath}\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`,
  );
  chmodSync(join(bin, "code"), 0o755);
  return {
    root,
    record,
    settings,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      USERPROFILE: root,
      TMPDIR: root,
      JEV_DATA_DIR: join(root, "data"),
      JEV_ENABLE_TELEMETRY: "0",
      JEV_VSCODE_SETTINGS: settings,
      UNRELATED_SETTING: "kept",
      NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? "",
    },
  };
}

function run(file, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("jev-code starts the daemon and opens VS Code pointed at it, arguments and env intact", { skip: !posix && "fake executable is POSIX-only" }, async (t) => {
  const space = workspace();
  t.after(() => run(JEV, ["daemon", "stop", "--json"], space.env));
  const settingsBefore = readFileSync(space.settings, "utf8");

  const result = await run(JEV_CODE, ["my project/", "--new-window"], space.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /daemon started at http:\/\/127\.0\.0\.1:\d+/);
  assert.match(result.stderr, /already open, it keeps its old environment/);

  const seen = JSON.parse(readFileSync(space.record, "utf8"));
  assert.deepEqual(seen.argv, ["my project/", "--new-window"], "workspace arguments pass through unchanged");
  const port = /127\.0\.0\.1:(\d+)/.exec(result.stderr)[1];
  assert.equal(seen.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`);
  assert.equal(seen.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "jev-router");
  assert.equal(seen.env.ANTHROPIC_MODEL, undefined, "the editor's default model is left alone");
  assert.equal(seen.env.UNRELATED_SETTING, "kept");
  assert.equal(readFileSync(space.settings, "utf8"), settingsBefore, "settings are never written");

  // A second launch reuses the same daemon rather than starting another.
  const again = await run(JEV_CODE, [], space.env);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stderr, new RegExp(`daemon reused at http://127\\.0\\.0\\.1:${port}`));

  const doctor = await run(JEV, ["vscode", "doctor", "--json"], { ...space.env, JEV_VSCODE_BIN: join(space.root, "dir with spaces", "code") });
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.checks.find(({ id }) => id === "daemon").status, "ok");
  assert.equal(report.routing, "unverified", "no request has reached the daemon yet");
  assert.equal(report.suggestion.entries.find(({ name }) => name === "ANTHROPIC_BASE_URL").value, `http://127.0.0.1:${port}`);
});

test("a missing code executable or daemon failure is diagnosed without opening anything", async () => {
  const lines = [];
  const write = (s) => lines.push(s);
  let spawned = false;
  const spawnProcess = () => {
    spawned = true;
  };
  assert.equal(await launch([], { env: { PATH: "" }, write, spawnProcess }), 1);
  assert.match(lines.join(""), /`code` command is not on your PATH/);

  lines.length = 0;
  const env = { PATH: "", JEV_VSCODE_BIN: process.execPath, SECRET_KEY: "sk-do-not-print" };
  const code = await launch([], {
    env,
    write,
    spawnProcess,
    startDaemon: async () => ({ ok: false, code: "start_timeout", message: "the daemon did not become healthy in time" }),
  });
  assert.equal(code, 1);
  assert.equal(spawned, false);
  assert.match(lines.join(""), /start_timeout/);
  assert.match(lines.join(""), /jev-claude/);
  assert.ok(!lines.join("").includes("sk-do-not-print"));
});

test("the proxy counts forwarded message requests, the evidence the doctor reports", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(req.url.startsWith("/v1/models") ? '{"data":[]}' : '{"id":"m","type":"message"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const proxy = await startProxy({ upstreamURL: `http://127.0.0.1:${upstream.address().port}`, route: async () => null });
  t.after(() => proxy.close());

  assert.deepEqual(proxy.traffic, { messages: 0, routed: 0, lastMessageAt: null });
  await fetch(`http://127.0.0.1:${proxy.port}/v1/models`).then((r) => r.text());
  assert.equal(proxy.traffic.messages, 0, "a models listing is not a routed request");
  await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
  }).then((r) => r.text());
  assert.equal(proxy.traffic.messages, 1);
  assert.equal(typeof proxy.traffic.lastMessageAt, "string");
});
