import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDoctor, runDoctor } from "../../../src/vscode/doctor.mjs";
import { classify, compareVersions } from "../../../src/vscode/compatibility.mjs";
import { parseCodeVersion, parseExtensionVersion } from "../../../src/vscode/discover.mjs";

const RUNTIME = { host: "127.0.0.1", port: 47111, pid: 42, instance_id: "i", router_version: "t" };
const running = (traffic = { messages: 0, routed: 0, last_message_at: null }) => async () => ({
  state: "running",
  runtime: RUNTIME,
  health: { status: "ok", traffic },
});
const found = (overrides = {}) => async () => ({
  code: { file: "/usr/bin/code" },
  vscode: { version: "1.137.0", commit: "c", arch: "x64" },
  extension: "2.1.280",
  ...overrides,
});

function space(settings) {
  const home = mkdtempSync(join(tmpdir(), "jev-vscode-doctor-"));
  const path = join(home, "settings.json");
  if (settings !== undefined) writeFileSync(path, typeof settings === "string" ? settings : JSON.stringify(settings, null, 2));
  return { home, path, env: { JEV_VSCODE_SETTINGS: path, JEV_DATA_DIR: join(home, "data") } };
}

const statusOf = (report, id) => report.checks.find((c) => c.id === id)?.status;

test("version output from the code CLI is parsed, and absence is distinguished from unreadable", () => {
  assert.deepEqual(parseCodeVersion("1.137.0\nabc123\nx64\n"), { version: "1.137.0", commit: "abc123", arch: "x64" });
  assert.equal(parseCodeVersion("garbage"), null);
  assert.equal(parseExtensionVersion("ms-python.python@1.0.0\nAnthropic.claude-code@2.1.280\n"), "2.1.280");
  assert.equal(parseExtensionVersion("ms-python.python@1.0.0\n"), undefined);
});

test("compatibility never promotes an untested or undiscovered combination to supported", () => {
  assert.equal(compareVersions("1.94.0", "1.137.0"), -1);
  assert.equal(classify({ vscode: "1.93.1", extension: "2.1.280" }).status, "incompatible");
  assert.equal(classify({ vscode: "1.137.0", extension: "2.1.280" }).status, "experimental");
  assert.equal(classify({ vscode: null, extension: null }).status, "experimental");
  const tested = [{ vscode: "1.137.0", extension: "2.1.280", status: "supported", date: "2026-09-23", note: "live" }];
  assert.equal(classify({ vscode: "1.137.0", extension: "2.1.280", tested }).status, "supported");
});

test("an absent CLI and unlisted extensions are unknown, not success", async () => {
  const s = space();
  const report = await runDoctor({ env: s.env, home: s.home, discover: async () => ({ code: null, vscode: null, extension: null }), daemonStatus: async () => ({ state: "stopped" }) });
  assert.equal(statusOf(report, "vscode"), "unknown");
  assert.equal(statusOf(report, "extension"), "unknown");
  assert.equal(report.routing, "unverified");
});

test("an old editor or a missing extension fails the doctor", async () => {
  const s = space({});
  const old = await runDoctor({ env: s.env, home: s.home, discover: found({ vscode: { version: "1.90.0" } }), daemonStatus: running() });
  assert.equal(statusOf(old, "vscode"), "fail");
  assert.equal(old.compatibility.status, "incompatible");
  assert.equal(old.ok, false);
  const missing = await runDoctor({ env: s.env, home: s.home, discover: found({ extension: undefined }), daemonStatus: running() });
  assert.equal(statusOf(missing, "extension"), "fail");
});

test("a wrong port fails, and the suggestion names the running daemon", async () => {
  const s = space({ [`claudeCode.environmentVariables`]: [{ name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:1" }] });
  const report = await runDoctor({ env: s.env, home: s.home, discover: found(), daemonStatus: running() });
  assert.equal(statusOf(report, "settings"), "fail");
  assert.equal(report.suggestion.entries.find(({ name }) => name === "ANTHROPIC_BASE_URL").value, "http://127.0.0.1:47111");
});

test("an invalid settings shape fails without a crash", async () => {
  const s = space({ "claudeCode.environmentVariables": { ANTHROPIC_BASE_URL: "x" } });
  const report = await runDoctor({ env: s.env, home: s.home, discover: found(), daemonStatus: running() });
  assert.equal(statusOf(report, "settings"), "fail");
  const broken = space("{ not json");
  const parsed = await runDoctor({ env: broken.env, home: broken.home, discover: found(), daemonStatus: running() });
  assert.equal(statusOf(parsed, "settings"), "fail");
});

test("healthy settings alone leave routing unverified until the daemon has seen a request", async () => {
  const settings = {
    "claudeCode.environmentVariables": [
      { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:47111" },
      { name: "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", value: "1" },
      { name: "ANTHROPIC_CUSTOM_MODEL_OPTION", value: "jev-router" },
      { name: "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME", value: "Jev Router" },
      { name: "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION", value: "x" },
      { name: "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES", value: "x" },
      { name: "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT", value: "1" },
    ],
  };
  const s = space(settings);
  const quiet = await runDoctor({ env: s.env, home: s.home, discover: found(), daemonStatus: running() });
  assert.equal(statusOf(quiet, "settings"), "ok");
  assert.equal(quiet.suggestion, null);
  assert.equal(quiet.routing, "unverified");
  const busy = await runDoctor({
    env: s.env,
    home: s.home,
    discover: found(),
    daemonStatus: running({ messages: 3, routed: 2, last_message_at: "2026-09-23T10:00:00.000Z" }),
  });
  assert.equal(busy.routing, "observed");
  const keyless = await runDoctor({
    env: s.env,
    home: s.home,
    discover: found(),
    daemonStatus: async () => ({ ...(await running()()), health: { status: "ok", provider_key_available: false } }),
  });
  assert.equal(statusOf(keyless, "provider"), "warn");
  assert.equal(busy.ok, true);
});

test("the doctor leaves settings byte-identical and never prints other entries' values", async () => {
  const text = `{
  // user comment
  "claudeCode.environmentVariables": [{ "name": "MY_TOKEN", "value": "sk-secret-value" }],
  "claudeCode.claudeProcessWrapper": "/opt/wrap",
}
`;
  const s = space(text);
  mkdirSync(join(s.home, ".claude"));
  writeFileSync(join(s.home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_AUTH_TOKEN: "tok-secret" } }));
  const before = statSync(s.path).mtimeMs;
  const report = await runDoctor({ env: s.env, home: s.home, discover: found(), daemonStatus: running() });
  assert.equal(readFileSync(s.path, "utf8"), text);
  assert.equal(statSync(s.path).mtimeMs, before);
  const printed = `${JSON.stringify(report)}\n${formatDoctor(report)}`;
  assert.ok(!printed.includes("sk-secret-value"));
  assert.ok(!printed.includes("tok-secret"));
  assert.ok(printed.includes("MY_TOKEN"), "the entry is named so the user knows it is kept");
  assert.equal(statusOf(report, "wrapper"), "warn");
  assert.equal(statusOf(report, "claude_settings"), "warn");
});

test("the report explains running-window environment reuse and the terminal fallback", async () => {
  const s = space();
  const report = await runDoctor({ env: s.env, home: s.home, discover: found(), daemonStatus: async () => ({ state: "stopped" }) });
  const text = formatDoctor(report);
  assert.match(text, /already running keeps the environment/);
  assert.match(text, /jev-claude/);
});
