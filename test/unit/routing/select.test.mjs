import test from "node:test";
import assert from "node:assert/strict";
import { profilesForActor, resolveProfiles } from "../../../src/routing/profiles.mjs";
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
  assert.equal(xhigh.profileId, "sonnet-xhigh", "Sonnet 5 supports xhigh, so the signal maps to it directly");
  assert.equal(max.profileId, "opus-max");
});

test("confidence settings are parsed from environment", () => {
  assert.deepEqual(routingConfigFromEnv({ JEV_CONFIDENCE_LOW: "0.2", JEV_CONFIDENCE_HIGH: "0.7" }), {
    decisionMode: "profiles",
    confidenceLow: 0.2,
    confidenceHigh: 0.7,
    downgradeMaxContextTokens: 20000,
    followUpHoldChars: 200,
    subagentMinTier: null,
    subagentMaxTier: null,
    subagentMaxEffort: null,
    uncertainCeiling: "balanced",
  });
});

test("invalid confidence settings fall back to ordered probabilities", () => {
  const config = routingConfigFromEnv({ JEV_CONFIDENCE_LOW: "0.9", JEV_CONFIDENCE_HIGH: "0.2" });
  assert.equal(config.confidenceLow, 0.45);
  assert.equal(config.confidenceHigh, 0.8);
});

test("subagent minimum tier raises a subagent route but not the main agent", () => {
  const options = {
    recommendation: recommendation("haiku-default", 0.98),
    config: { decisionMode: "profiles", createdAt: 1, subagentMinTier: "balanced" },
  };
  const sub = select({ ...options, contextState: { estimatedTokens: 0, actorType: "subagent" } });
  assert.equal(sub.tier, "balanced");
  assert.equal(sub.source, "jev");
  assert.ok(sub.normalizationNotes.includes("raised to subagent minimum tier balanced"));
  const main = select({ ...options, contextState: { estimatedTokens: 0, actorType: "main" } });
  assert.equal(main.tier, "fast");
});

test("subagent minimum tier leaves stronger routes and manual overrides alone", () => {
  const config = { decisionMode: "profiles", createdAt: 1, subagentMinTier: "balanced" };
  const contextState = { estimatedTokens: 0, actorType: "subagent" };
  assert.equal(select({ config, contextState }).profileId, "opus-high");
  const manual = select({ config, contextState, manualState: { prompt: "use haiku for this" } });
  assert.equal(manual.tier, "fast");
});

test("subagent minimum tier accepts model and profile tier names from environment", () => {
  assert.equal(routingConfigFromEnv({ JEV_SUBAGENT_MIN_TIER: "sonnet" }).subagentMinTier, "balanced");
  assert.equal(routingConfigFromEnv({ JEV_SUBAGENT_MIN_TIER: "Strong" }).subagentMinTier, "strong");
  assert.equal(routingConfigFromEnv({ JEV_SUBAGENT_MIN_TIER: "bogus" }).subagentMinTier, null);
  assert.equal(routingConfigFromEnv({}).subagentMinTier, null);
});

const opusHeld = { model: "claude-opus-5", tier: "strong", effectiveEffort: null };

test("a new subagent with a low-confidence downgrade starts on balanced, not the strong model it arrived with", () => {
  const route = select({
    currentRoute: opusHeld,
    recommendation: recommendation("haiku-default", 0.17),
    contextState: { estimatedTokens: 0, actorType: "subagent", freshActor: true },
  });
  assert.equal(route.profileId, "sonnet-medium");
  assert.equal(route.fallbackReason, "low_confidence_subagent_start");
  const keepsEffort = select({
    currentRoute: opusHeld,
    recommendation: recommendation("sonnet-high", 0.22),
    contextState: { estimatedTokens: 0, actorType: "subagent", freshActor: true },
  });
  assert.equal(keepsEffort.profileId, "sonnet-high");
});

test("low confidence still never downgrades a pinned subagent or the main agent", () => {
  for (const contextState of [
    { estimatedTokens: 0, actorType: "subagent", freshActor: false },
    { estimatedTokens: 0, actorType: "main", freshActor: true },
  ]) {
    const route = select({ currentRoute: opusHeld, recommendation: recommendation("haiku-default", 0.17), contextState });
    assert.equal(route.tier, "strong");
    assert.equal(route.fallbackReason, "low_confidence_no_downgrade");
  }
});

test("a short main-agent follow-up holds the current route instead of downgrading", () => {
  const base = {
    currentRoute: opusHeld,
    recommendation: recommendation("haiku-default", 0.96),
    contextState: { estimatedTokens: 0, actorType: "main", followUp: true },
  };
  const held = select({ ...base, manualState: { prompt: "ok do that." } });
  assert.equal(held.tier, "strong");
  assert.equal(held.fallbackReason, "short_followup_hold");
  assert.equal(select({ ...base, manualState: { prompt: "x".repeat(201) } }).tier, "fast");
  assert.equal(select({ ...base, contextState: { ...base.contextState, followUp: false }, manualState: { prompt: "ok" } }).tier, "fast");
  assert.equal(select({ ...base, manualState: { prompt: "ok" }, config: { decisionMode: "profiles", createdAt: 1, followUpHoldChars: 0 } }).tier, "fast");
});

test("a short follow-up may still upgrade", () => {
  const route = select({
    recommendation: recommendation("opus-high", 0.9),
    contextState: { estimatedTokens: 0, actorType: "main", followUp: true },
    manualState: { prompt: "now fix the race" },
  });
  assert.equal(route.profileId, "opus-high");
});

test("follow-up hold length is parsed from environment", () => {
  assert.equal(routingConfigFromEnv({ JEV_FOLLOWUP_HOLD_CHARS: "80" }).followUpHoldChars, 80);
  assert.equal(routingConfigFromEnv({ JEV_FOLLOWUP_HOLD_CHARS: "0" }).followUpHoldChars, 0);
  assert.equal(routingConfigFromEnv({ JEV_FOLLOWUP_HOLD_CHARS: "-3" }).followUpHoldChars, 200);
});

test("a new subagent with a low-confidence strong pick starts on balanced high, not strong", () => {
  const route = select({
    currentRoute: opusHeld,
    recommendation: recommendation("opus-medium", 0.33),
    contextState: { estimatedTokens: 0, actorType: "subagent", freshActor: true },
  });
  assert.equal(route.profileId, "sonnet-high");
  assert.equal(route.fallbackReason, "low_confidence_subagent_start");
});

test("a confident strong pick for a new subagent is kept", () => {
  const route = select({
    currentRoute: opusHeld,
    recommendation: recommendation("opus-medium", 0.9),
    contextState: { estimatedTokens: 0, actorType: "subagent", freshActor: true },
  });
  assert.equal(route.profileId, "opus-medium");
});

test("subagent maximum tier lowers confident subagent picks but not the main agent or overrides", () => {
  const config = { decisionMode: "profiles", createdAt: 1, subagentMaxTier: "balanced" };
  const sub = { estimatedTokens: 0, actorType: "subagent", freshActor: true };
  const lowered = select({ config, contextState: sub, recommendation: recommendation("opus-medium", 0.9) });
  assert.equal(lowered.profileId, "sonnet-high");
  assert.ok(lowered.normalizationNotes.includes("lowered to subagent maximum tier balanced"));
  const main = select({ config, contextState: { ...sub, actorType: "main" }, recommendation: recommendation("opus-medium", 0.9) });
  assert.equal(main.profileId, "opus-medium");
  const manual = select({ config, contextState: sub, manualState: { prompt: "use opus for this" } });
  assert.equal(manual.tier, "strong");
  assert.equal(routingConfigFromEnv({ JEV_SUBAGENT_MAX_TIER: "sonnet" }).subagentMaxTier, "balanced");
});

test("subagent maximum accepts a tier with an effort and synthesizes that profile when supported", () => {
  const env = routingConfigFromEnv({ JEV_SUBAGENT_MAX_TIER: "opus-low" });
  assert.equal(env.subagentMaxTier, "strong");
  assert.equal(env.subagentMaxEffort, "low");
  assert.equal(routingConfigFromEnv({ JEV_SUBAGENT_MAX_TIER: "opus:turbo" }).subagentMaxTier, null);
  const opus55 = resolveProfiles({
    models: [
      { id: "claude-sonnet-5", tier: "sonnet" },
      { id: "claude-opus-5-5", tier: "opus" },
    ],
    env: {},
  });
  const config = { decisionMode: "profiles", createdAt: 1, subagentMaxTier: "strong", subagentMaxEffort: "low" };
  const sub = { estimatedTokens: 0, actorType: "subagent", freshActor: true };
  const opts = { profiles: opus55, config, contextState: sub, currentRoute: { model: "claude-opus-5-5", tier: "strong" } };
  const lowered = select({ ...opts, recommendation: recommendation("opus-medium", 0.9) });
  assert.equal(lowered.profileId, "opus-low");
  assert.equal(lowered.model, "claude-opus-5-5");
  assert.equal(lowered.requestedEffort, "low");
  assert.ok(lowered.normalizationNotes.includes("lowered to subagent maximum opus-low"));
  assert.equal(select({ ...opts, recommendation: recommendation("sonnet-high", 0.9) }).profileId, "sonnet-high");
});

const opus55Profiles = resolveProfiles({
  models: [
    { id: "claude-haiku-4-5-20251001", tier: "haiku" },
    { id: "claude-sonnet-5", tier: "sonnet" },
    { id: "claude-opus-5-5", tier: "opus" },
  ],
  env: {},
});

test("the default effort ladder offers sonnet-xhigh and opus-low", () => {
  const ids = opus55Profiles.map(({ id }) => id);
  assert.ok(ids.includes("sonnet-xhigh"));
  assert.ok(ids.includes("opus-low"));
});

test("per-actor profile lists filter by wildcard and bare tier, and fail open when nothing matches", () => {
  const ids = (actor, value) =>
    profilesForActor(opus55Profiles, actor, { JEV_MAIN_PROFILES: value, JEV_SUBAGENT_PROFILES: value }).profiles.map(({ id }) => id);
  assert.deepEqual(ids("main", "opus-*"), ["opus-low", "opus-medium", "opus-high", "opus-xhigh", "opus-max"]);
  assert.deepEqual(ids("subagent", "sonnet, opus-low"), ["sonnet-low", "sonnet-medium", "sonnet-high", "sonnet-xhigh", "opus-low"]);
  assert.equal(profilesForActor(opus55Profiles, "main", { JEV_MAIN_PROFILES: "gpt-*" }).restricted, false);
  assert.equal(profilesForActor(opus55Profiles, "main", {}).profiles.length, opus55Profiles.length);
  assert.equal(profilesForActor(opus55Profiles, "unknown", { JEV_MAIN_PROFILES: "opus-*" }).restricted, false);
});

test("a held route outside the allowed profiles is moved to the nearest allowed one", () => {
  const { profiles } = profilesForActor(opus55Profiles, "subagent", { JEV_SUBAGENT_PROFILES: "sonnet-*,opus-low" });
  const route = selectEffectiveRoute({
    recommendation: null,
    currentRoute: { model: "claude-opus-5-5", tier: "strong", effectiveEffort: "high" },
    profiles,
    contextState: { estimatedTokens: 0, actorType: "subagent", freshActor: true, restrictedProfiles: true },
    manualState: {},
    config: { decisionMode: "profiles", createdAt: 1 },
  });
  assert.equal(route.profileId, "opus-low");
  assert.equal(route.fallbackReason, "jev_unavailable");
});

test("the main agent keeps an explicit xhigh or max request, e.g. ultracode", () => {
  const { profiles } = profilesForActor(opus55Profiles, "main", { JEV_MAIN_PROFILES: "opus-*" });
  const base = {
    currentRoute: { model: "claude-opus-5-5", tier: "strong", effectiveEffort: "xhigh" },
    profiles,
    manualState: {},
    config: { decisionMode: "profiles", createdAt: 1 },
  };
  const main = { estimatedTokens: 0, actorType: "main", restrictedProfiles: true, requestedEffort: "xhigh" };
  const kept = selectEffectiveRoute({ ...base, recommendation: recommendation("opus-medium", 0.95), contextState: main });
  assert.equal(kept.profileId, "opus-xhigh");
  assert.ok(kept.normalizationNotes.includes("kept requested xhigh effort"));
  const higher = selectEffectiveRoute({ ...base, recommendation: recommendation("opus-max", 0.95), contextState: main });
  assert.equal(higher.profileId, "opus-max");
  const plain = selectEffectiveRoute({
    ...base,
    recommendation: recommendation("opus-medium", 0.95),
    contextState: { ...main, requestedEffort: "high" },
  });
  assert.equal(plain.profileId, "opus-medium");
  const sub = selectEffectiveRoute({
    ...base,
    recommendation: recommendation("opus-medium", 0.95),
    contextState: { ...main, actorType: "subagent" },
  });
  assert.equal(sub.profileId, "opus-medium");
});
