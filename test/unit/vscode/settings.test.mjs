import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  ENV_SETTING,
  inspectEnvironmentVariables,
  parseJsonc,
  readSettingsFile,
  recommendedEntries,
  userSettingsPath,
} from "../../../src/vscode/settings.mjs";

const DAEMON = "http://127.0.0.1:47111";
const settingsWith = (entries) => ({ [ENV_SETTING]: entries });

test("VS Code settings parse as JSONC without touching comment-like text inside strings", () => {
  const parsed = parseJsonc(`{
    // a line comment
    "url": "http://127.0.0.1:1/*not a comment*/",
    /* a block
       comment */
    "list": [1, 2,],
    "escaped": "quote \\" // still a string",
  }`);
  assert.deepEqual(parsed, {
    url: "http://127.0.0.1:1/*not a comment*/",
    list: [1, 2],
    escaped: 'quote " // still a string',
  });
  assert.deepEqual(parseJsonc(""), {});
});

test("the settings path follows each platform's VS Code layout and honours an override", () => {
  const home = "/home/u";
  assert.equal(userSettingsPath({ env: {}, platform: "linux", home }), join(home, ".config", "Code", "User", "settings.json"));
  assert.equal(userSettingsPath({ env: { XDG_CONFIG_HOME: "/x" }, platform: "linux", home }), join("/x", "Code", "User", "settings.json"));
  assert.equal(userSettingsPath({ env: {}, platform: "darwin", home }), join(home, "Library", "Application Support", "Code", "User", "settings.json"));
  assert.equal(userSettingsPath({ env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, platform: "win32", home }), join("C:\\Users\\u\\AppData\\Roaming", "Code", "User", "settings.json"));
  assert.equal(userSettingsPath({ env: { JEV_VSCODE_SETTINGS: "/custom.json" }, platform: "linux", home }), "/custom.json");
});

test("a missing, unreadable, or malformed settings file is reported rather than thrown", () => {
  const missing = Object.assign(new Error("nope"), { code: "ENOENT" });
  assert.equal(readSettingsFile("/s", { readFile: () => { throw missing; } }).state, "missing");
  assert.equal(readSettingsFile("/s", { readFile: () => { throw new Error("EACCES"); } }).state, "unreadable");
  assert.equal(readSettingsFile("/s", { readFile: () => "{ broken" }).state, "invalid");
  assert.equal(readSettingsFile("/s", { readFile: () => "[]" }).state, "invalid");
});

test("an environmentVariables value outside the documented name/value array shape is invalid", () => {
  assert.equal(inspectEnvironmentVariables(settingsWith({ ANTHROPIC_BASE_URL: DAEMON }), DAEMON).state, "invalid");
  assert.equal(inspectEnvironmentVariables(settingsWith([{ name: "A" }]), DAEMON).state, "invalid");
  assert.equal(inspectEnvironmentVariables(settingsWith([null]), DAEMON).state, "invalid");
  assert.equal(inspectEnvironmentVariables({}, DAEMON).state, "unset");
});

test("other entries are reported by name only, because their values may be credentials", () => {
  const result = inspectEnvironmentVariables(
    settingsWith([{ name: "MY_TOKEN", value: "sk-secret-value" }]),
    DAEMON,
  );
  assert.equal(result.state, "no_base_url");
  assert.deepEqual(result.otherNames, ["MY_TOKEN"]);
  assert.ok(!JSON.stringify(result).includes("sk-secret-value"));
});

test("the configured base URL must name the daemon's port; localhost counts as loopback", () => {
  const wrong = inspectEnvironmentVariables(settingsWith([{ name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:1" }]), DAEMON);
  assert.equal(wrong.state, "mismatch");
  const all = recommendedEntries("http://localhost:47111");
  const right = inspectEnvironmentVariables(settingsWith(all), DAEMON);
  assert.equal(right.state, "match");
  assert.deepEqual(right.missing, []);
  const bare = inspectEnvironmentVariables(settingsWith([{ name: "ANTHROPIC_BASE_URL", value: DAEMON }]), DAEMON);
  assert.equal(bare.state, "match");
  assert.ok(bare.missing.includes("ANTHROPIC_CUSTOM_MODEL_OPTION"));
  const remote = inspectEnvironmentVariables(settingsWith([{ name: "ANTHROPIC_BASE_URL", value: "https://gateway.example/secret-path" }]), DAEMON);
  assert.equal(remote.configuredBaseURL, "(non-loopback URL, not shown)");
  assert.equal(inspectEnvironmentVariables(settingsWith([{ name: "ANTHROPIC_BASE_URL", value: DAEMON }]), null).state, "unknown_daemon");
});

test("recommended entries route through the daemon without forcing a default model or adding a key", () => {
  const entries = recommendedEntries(DAEMON);
  const names = entries.map(({ name }) => name);
  assert.deepEqual(entries.find(({ name }) => name === "ANTHROPIC_BASE_URL"), { name: "ANTHROPIC_BASE_URL", value: DAEMON });
  assert.ok(names.includes("ANTHROPIC_CUSTOM_MODEL_OPTION"));
  assert.ok(!names.includes("ANTHROPIC_MODEL"));
  assert.ok(!names.some((name) => /KEY|TOKEN/.test(name)));
});
