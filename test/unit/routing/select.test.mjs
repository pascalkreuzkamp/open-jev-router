import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfiles } from "../../../src/routing/profiles.mjs";
import { routingConfigFromEnv, selectEffectiveRoute } from "../../../src/routing/select.mjs";

const profiles = resolveProfiles({
  models: [
    { id: "claude-haiku-4-5-20251001", tier: "haiku" },
    { id: "claude-sonnet-5", tier: "sonnet" },
    { id: "claude-opus-5", tier: "opus" },
  ],
  env: {},
});
const currentRoute = {
  profileId: "sonnet-medium",
  model: "claude-sonnet-5",
  effectiveEffort: "medium",
};
const recommendation = (choice, confidence = 0.9, extra = {}) => ({ choice, confidence, ...extra });
const select = (options = {}) => selectEffectiveRoute({
  recommendation: recommendation("opus-high"),
  currentRoute,
  profiles,
  contextState: { estimatedTokens: 0 },
  manualState: {},
  config: { decisionMode: "profiles", createdAt: 1 },
  ...options,
});

test("selects a validated profile and returns the EffectiveRoute schema", () => {
  const route = select();
  assert.equal(route.profileId, "opus-high");
  assert.equal(route.model, "claude-opus-5");
  assert.equal(route.tier, "strong");
  assert.equal(route.requestedEffort, "high");
  assert.equal(route.effectiveEffort, "high");
  assert.equal(route.source, "jev");
  assert.ok(route.routeId);
  assert.ok(route.createdAt);
});

test("low confidence does not downgrade", () => {
  const route = select({ recommendation: recommendation("haiku-default", 0.44) });
  assert.equal(route.profileId, "sonnet-medium");
  assert.equal(route.fallbackReason, "low_confidence_no_downgrade");
});

test("low confidence caps an upgrade at balanced", () => {
  const route = select({
    currentRoute: { profileId: "haiku-default", model: "claude-haiku-4-5-20251001" },
    recommendation: recommendation("opus-high", 0.44),
  });
  assert.equal(route.tier, "balanced");
  assert.equal(route.fallbackReason, "low_confidence_capped");
});

test("low confidence never caps below the current tier", () => {
  const route = select({
    currentRoute: { profileId: "opus-medium", model: "claude-opus-5", effectiveEffort: "medium" },
    recommendation: recommendation("opus-high", 0.44),
  });
  assert.equal(route.tier, "strong");
});

test("confidence boundaries distinguish medium from high recommendations", () => {
  const medium = select({ recommendation: recommendation("opus-high", 0.45) });
  const high = select({ recommendation: recommendation("opus-high", 0.8) });
  assert.match(medium.normalizationNotes.join(" "), /medium-confidence/);
  assert.doesNotMatch(high.normalizationNotes.join(" "), /medium-confidence/);
});

test("large context preserves the current route on downgrade", () => {
  const route = select({
    currentRoute: { profileId: "opus-high", model: "claude-opus-5", effectiveEffort: "high" },
    recommendation: recommendation("haiku-default"),
    contextState: { estimatedTokens: 20_001 },
  });
  assert.equal(route.profileId, "opus-high");
  assert.equal(route.fallbackReason, "cache_preservation");
});

test("unknown recommendation fails open to the current route", () => {
  const route = select({ recommendation: recommendation("future-profile") });
  assert.equal(route.profileId, "sonnet-medium");
  assert.equal(route.source, "fallback");
  assert.equal(route.fallbackReason, "unknown_recommendation");
});

test("an unknown current model is preserved without speculative capability rewriting", () => {
  const route = select({
    recommendation: null,
    currentRoute: { model: "claude-custom-account-model", effectiveEffort: "future" },
  });
  assert.equal(route.model, "claude-custom-account-model");
  assert.equal(route.effectiveEffort, "future");
  assert.match(route.normalizationNotes.join(" "), /unknown model capabilities/);
});

test("a disabled recommendation falls upward to an enabled route", () => {
  const unavailable = profiles.map((profile) =>
    profile.id === "sonnet-medium" ? { ...profile, enabled: false } : profile,
  );
  const route = select({
    profiles: unavailable,
    recommendation: recommendation("sonnet-medium"),
  });
  assert.equal(route.fallbackReason, "model_unavailable");
  assert.ok(["balanced", "strong"].includes(route.tier));
});

test("selection is deterministic when the caller supplies the decision timestamp", () => {
  const options = { config: { decisionMode: "profiles", createdAt: 123 } };
  assert.deepEqual(select(options), select(options));
});

test("recognized prompt override beats Jev", () => {
  const route = select({ manualState: { prompt: "use haiku for this typo" } });
  assert.equal(route.tier, "fast");
  assert.equal(route.source, "manual");
});

test("an explicit manual routing lock beats Jev", () => {
  const route = select({ manualState: { lockedRoute: { profileId: "sonnet-low" } } });
  assert.equal(route.profileId, "sonnet-low");
  assert.equal(route.source, "manual");
});

test("an unavailable prompt override is reported and preserves the current route", () => {
  const route = select({ manualState: { prompt: "use fable for this" } });
  assert.equal(route.profileId, "sonnet-medium");
  assert.equal(route.fallbackReason, "manual_override_unavailable");
});

test("signals mode maps normalized 0-9 reasoning scores to effort", () => {
  const route = select({
    recommendation: recommendation("claude-sonnet-5", 0.9, { metrics: { reasoningRequired: 2 / 9 } }),
    config: { decisionMode: "signals" },
  });
  assert.equal(route.profileId, "sonnet-medium");
});

test("signals mode selects the nearest supported effort without exceeding the signal", () => {
  const xhigh = select({
    recommendation: recommendation("claude-sonnet-5", 0.9, { metrics: { reasoningRequired: 6 / 9 } }),
    config: { decisionMode: "signals", createdAt: 1 },
  });
  const max = select({
    recommendation: recommendation("claude-opus-5", 0.9, { metrics: { reasoningRequired: 9 / 9 } }),
    config: { decisionMode: "signals", createdAt: 1 },
  });
  assert.equal(xhigh.profileId, "sonnet-high", "Sonnet has no xhigh profile, so it steps down to high");
  assert.equal(max.profileId, "opus-max");
});

test("confidence settings are parsed from environment", () => {
  assert.deepEqual(routingConfigFromEnv({ JEV_CONFIDENCE_LOW: "0.2", JEV_CONFIDENCE_HIGH: "0.7" }), {
    decisionMode: "profiles",
    confidenceLow: 0.2,
    confidenceHigh: 0.7,
    downgradeMaxContextTokens: 20000,
    uncertainCeiling: "balanced",
  });
});

test("invalid confidence settings fall back to ordered probabilities", () => {
  const config = routingConfigFromEnv({ JEV_CONFIDENCE_LOW: "0.9", JEV_CONFIDENCE_HIGH: "0.2" });
  assert.equal(config.confidenceLow, 0.45);
  assert.equal(config.confidenceHigh, 0.8);
});
