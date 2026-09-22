import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_MATRIX,
  capabilityOverridesFromEnv,
  capabilitiesForCatalogModel,
  capabilitiesForModel,
  capabilitiesFor,
  nearestSupportedEffort,
} from "../../../src/routing/capabilities.mjs";

test("capability data is versioned and sourced", () => {
  assert.match(CAPABILITY_MATRIX.version, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(CAPABILITY_MATRIX.sources.every((source) => source.startsWith("https://platform.claude.com/")));
});

test("matches only documented model generations", () => {
  assert.deepEqual(capabilitiesFor("claude-haiku-4-5-20251001").supportedEfforts, []);
  assert.ok(capabilitiesFor("claude-sonnet-5").supportedEfforts.includes("xhigh"));
  assert.ok(capabilitiesFor("claude-opus-5").supportedEfforts.includes("max"));
  assert.equal(capabilitiesFor("claude-sonnet-6"), null);
});

test("nearest effort never exceeds the requested level", () => {
  assert.equal(nearestSupportedEffort("xhigh", ["low", "medium", "high", "max"]), "high");
  assert.equal(nearestSupportedEffort("low", ["medium", "high"]), null);
  assert.equal(nearestSupportedEffort("invented", ["low"]), null);
});

test("accepts validated exact-model capability overrides", () => {
  const env = {
    JEV_CAPABILITY_OVERRIDES: JSON.stringify({
      "claude-account-custom": {
        supportedEfforts: ["low", "high"],
        supportsAdaptiveThinking: true,
        supportsManualThinking: false,
        supportsDisabledThinking: true,
        thinkingAlwaysOn: false,
      },
    }),
  };
  const capability = capabilitiesForModel("claude-account-custom", env);
  assert.equal(capability.capabilityVersion, "local-override");
  assert.deepEqual(capability.supportedEfforts, ["low", "high"]);
});

test("rejects malformed capability overrides without weakening validation", () => {
  const env = {
    JEV_CAPABILITY_OVERRIDES: JSON.stringify({
      "claude-account-custom": { supportedEfforts: ["turbo"] },
    }),
  };
  const parsed = capabilityOverridesFromEnv(env);
  assert.equal(parsed.overrides.size, 0);
  assert.match(parsed.errors[0], /invalid capability override/);
  assert.equal(capabilitiesForModel("claude-account-custom", env), null);
});

test("runtime catalog effort facts override the versioned fallback", () => {
  const capability = capabilitiesForCatalogModel({
    id: "claude-sonnet-5",
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
  });
  assert.deepEqual(capability.supportedEfforts, ["low", "high"]);
  assert.equal(capability.supportsAdaptiveThinking, true);
  assert.equal(capability.capabilityVersion, "catalog-2026-09-22");
});
