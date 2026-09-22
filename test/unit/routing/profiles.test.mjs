import test from "node:test";
import assert from "node:assert/strict";
import {
  decisionMode,
  effortRoutingEnabled,
  resolveProfiles,
} from "../../../src/routing/profiles.mjs";

const models = [
  { id: "claude-haiku-4-5-20251001", tier: "haiku" },
  { id: "claude-sonnet-5", tier: "sonnet" },
  { id: "claude-opus-5", tier: "opus" },
  { id: "claude-fable-5-1", tier: "fable" },
];

test("profiles mode and effort routing are defaults", () => {
  assert.equal(decisionMode({}), "profiles");
  assert.equal(effortRoutingEnabled({}), true);
});

test("resolves capability-valid profiles from the account catalog", () => {
  const profiles = resolveProfiles({ models, env: {} });
  assert.ok(profiles.some(({ id, model }) => id === "haiku-default" && model.includes("haiku")));
  assert.ok(profiles.some(({ id }) => id === "sonnet-low"));
  assert.ok(profiles.some(({ id }) => id === "opus-xhigh"));
  assert.equal(profiles.some(({ tier }) => tier === "long"), false);
});

test("long tier remains opt-in through new and legacy flags", () => {
  assert.ok(resolveProfiles({ models, env: { JEV_ALLOW_LONG_TIER: "1" } }).some(({ tier }) => tier === "long"));
  assert.ok(resolveProfiles({ models, env: { JEV_ALLOW_FABLE: "1" } }).some(({ tier }) => tier === "long"));
});

test("invalid model override disables that tier instead of inventing availability", () => {
  const profiles = resolveProfiles({ models, env: { JEV_CLAUDE_BALANCED_MODEL: "claude-sonnet-6" } });
  assert.equal(profiles.some(({ tier }) => tier === "balanced"), false);
});

test("effort opt-out creates model-only profiles", () => {
  const profiles = resolveProfiles({ models, env: { JEV_ENABLE_EFFORT_ROUTING: "0" } });
  assert.ok(profiles.some(({ id }) => id === "sonnet-default"));
  assert.equal(profiles.some(({ effort }) => effort), false);
});

test("catalog versions remain independently selectable", () => {
  const profiles = resolveProfiles({
    models: [
      { id: "claude-opus-5", tier: "opus" },
      { id: "claude-opus-4-8", tier: "opus" },
    ],
    env: {},
  });
  assert.ok(profiles.some(({ model, id }) => model === "claude-opus-4-8" && id.includes("opus-4-8")));
});

test("validated capability overrides enable account-specific models", () => {
  const env = {
    JEV_CLAUDE_BALANCED_MODEL: "claude-account-custom",
    JEV_CAPABILITY_OVERRIDES: JSON.stringify({
      "claude-account-custom": {
        supportedEfforts: ["low", "medium"],
        supportsAdaptiveThinking: true,
        supportsManualThinking: false,
        supportsDisabledThinking: true,
        thinkingAlwaysOn: false,
      },
    }),
  };
  const profiles = resolveProfiles({
    models: [{ id: "claude-account-custom", tier: "sonnet" }],
    env,
  });
  assert.deepEqual(profiles.map(({ id }) => id), ["sonnet-low", "sonnet-medium"]);
});

test("catalog capabilities constrain generated effort profiles", () => {
  const profiles = resolveProfiles({
    models: [{
      id: "claude-sonnet-5",
      tier: "sonnet",
      capabilities: {
        effort: {
          supported: true,
          low: { supported: true },
          medium: { supported: false },
          high: { supported: true },
          xhigh: { supported: false },
          max: { supported: false },
        },
        thinking: { types: { adaptive: { supported: true }, enabled: { supported: false } } },
      },
    }],
    env: {},
  });
  assert.deepEqual(profiles.map(({ id }) => id), ["sonnet-low", "sonnet-high"]);
});
