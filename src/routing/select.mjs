import { detectOverride } from "../policy.mjs";
import { THRESHOLDS, tierOf } from "../config.mjs";
import { EFFORT_LEVELS, capabilitiesForModel } from "./capabilities.mjs";
import { PROFILE_TIERS, legacyTierOf, profileRank, profileTierOf } from "./profiles.mjs";

const effortRank = (effort) => EFFORT_LEVELS.indexOf(effort);

function thresholds(config = {}) {
  return {
    low: Number.isFinite(config.confidenceLow) ? config.confidenceLow : 0.45,
    high: Number.isFinite(config.confidenceHigh) ? config.confidenceHigh : 0.8,
    downgradeMaxContextTokens:
      config.downgradeMaxContextTokens ?? THRESHOLDS.downgradeMaxContextTokens,
    uncertainCeiling: config.uncertainCeiling ?? "balanced",
    followUpHoldChars: Number.isFinite(config.followUpHoldChars) ? config.followUpHoldChars : 200,
  };
}

function currentProfile(currentRoute, profiles) {
  if (!currentRoute) return null;
  return (
    profiles.find(({ id }) => id === currentRoute.profileId) ??
    profiles.find(
      ({ model, effort }) => model === currentRoute.model && (effort ?? null) === (currentRoute.effectiveEffort ?? null),
    ) ??
    null
  );
}

function signalsEffort(recommendation) {
  const value = recommendation?.metrics?.reasoningRequired;
  if (!Number.isFinite(value)) return null;
  // Provider adapters normalize the original SDK 0-9 score to 0-1.
  const score = Math.max(0, Math.min(9, Math.round(value * 9)));
  if (score <= 1) return "low";
  if (score === 2) return "medium";
  if (score === 3) return "high";
  if (score <= 7) return "xhigh";
  return "max";
}

function candidateFromRecommendation(recommendation, profiles, mode) {
  if (!recommendation) return null;
  if (mode === "profiles") {
    const direct = profiles.find(({ id }) => id === recommendation.choice);
    if (direct) return direct;
    // Compatibility with injected/older providers returning an exact model choice.
    if (!tierOf(recommendation.choice)) return null;
  }
  const recommendedTier = profileTierOf(tierOf(recommendation.choice));
  if (!recommendedTier) return null;
  const desiredEffort = signalsEffort(recommendation);
  const sameTier = profiles.filter(({ tier }) => tier === recommendedTier);
  const sameModel = sameTier.filter(({ model }) => model === recommendation.choice);
  const desiredRank = effortRank(desiredEffort);
  const nearest = (candidates) =>
    candidates
      .filter(({ effort }) => effortRank(effort) <= desiredRank)
      .sort((a, b) => effortRank(b.effort) - effortRank(a.effort))[0];
  return (
    sameModel.find(({ effort }) => effort === desiredEffort) ??
    sameTier.find(({ effort }) => effort === desiredEffort) ??
    (desiredEffort ? nearest(sameModel) : sameModel[0]) ??
    (desiredEffort ? nearest(sameTier) : null) ??
    sameTier[0] ??
    null
  );
}

function equalOrStronger(profiles, tier, effort) {
  const start = profileRank(tier);
  const candidates = profiles
    .filter((profile) => profileRank(profile.tier) >= start)
    .sort((a, b) => profileRank(a.tier) - profileRank(b.tier) || effortRank(a.effort) - effortRank(b.effort));
  return candidates.find((profile) => !effort || profile.effort === effort) ?? candidates[0] ?? null;
}

function routeFrom(
  profile,
  { source, recommendation, fallbackReason = null, notes = [], createdAt = 0 },
) {
  const requestedEffort = profile.effort ?? null;
  const effectiveEffort = requestedEffort;
  if (!profile.capabilityVersion) notes.push("unknown model capabilities; preserved current controls");
  return {
    routeId: `route-${createdAt}-${profile.id}`,
    profileId: profile.id,
    source,
    model: profile.model,
    tier: profile.tier,
    legacyTier: legacyTierOf(profile.tier),
    requestedEffort,
    effectiveEffort,
    thinkingPolicy: profile.thinking ?? "default",
    confidence: recommendation?.confidence ?? null,
    provider: recommendation?.provider ?? null,
    jevDecisionId: recommendation?.decisionId ?? null,
    fallbackReason,
    normalizationNotes: notes,
    createdAt,
  };
}

function compareStrength(profile, current) {
  const tierDelta = profileRank(profile.tier) - profileRank(current.tier);
  if (tierDelta) return tierDelta;
  return effortRank(profile.effort) - effortRank(current.effort);
}

export function routingConfigFromEnv(env = process.env) {
  const probability = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
  };
  let confidenceLow = probability("JEV_CONFIDENCE_LOW", 0.45);
  let confidenceHigh = probability("JEV_CONFIDENCE_HIGH", 0.8);
  if (confidenceLow >= confidenceHigh) {
    confidenceLow = 0.45;
    confidenceHigh = 0.8;
  }
  const holdChars = Number(env.JEV_FOLLOWUP_HOLD_CHARS);
  // JEV_SUBAGENT_MAX_TIER takes a tier ("sonnet") or a tier with an effort ("opus-low").
  const [maxTier, maxEffort = null] = String(env.JEV_SUBAGENT_MAX_TIER ?? "").trim().toLowerCase().split(/[-:]/);
  const maxSetting = EFFORT_LEVELS.includes(maxEffort) || maxEffort === null
    ? { tier: maxTier, effort: maxEffort }
    : { tier: "", effort: null };
  const tierOfSetting = (value) => (PROFILE_TIERS.includes(value) ? value : profileTierOf(value));
  return {
    followUpHoldChars: env.JEV_FOLLOWUP_HOLD_CHARS != null && Number.isInteger(holdChars) && holdChars >= 0 ? holdChars : 200,
    subagentMinTier: tierOfSetting(String(env.JEV_SUBAGENT_MIN_TIER ?? "").trim().toLowerCase()),
    subagentMaxTier: tierOfSetting(maxSetting.tier),
    subagentMaxEffort: tierOfSetting(maxSetting.tier) ? maxSetting.effort : null,
    decisionMode: env.JEV_DECISION_MODE === "signals" ? "signals" : "profiles",
    confidenceLow,
    confidenceHigh,
    downgradeMaxContextTokens: THRESHOLDS.downgradeMaxContextTokens,
    uncertainCeiling: "balanced",
  };
}

/** A profile outside the default effort ladder (e.g. opus-low), only if the model supports it. */
function withEffort(profile, effort) {
  if (!profile || !capabilitiesForModel(profile.model).supportedEfforts?.includes(effort)) return null;
  const suffix = profile.id.slice(`${legacyTierOf(profile.tier)}-${profile.effort ?? "default"}`.length);
  return { ...profile, id: `${legacyTierOf(profile.tier)}-${effort}${suffix}`, effort };
}

const reroute = (route, profile, note, recommendation) =>
  routeFrom(profile, {
    source: route.source,
    recommendation,
    fallbackReason: route.fallbackReason,
    notes: [...route.normalizationNotes, note],
    createdAt: route.createdAt,
  });

// A default (null) effort is the model's own choice; rank it like "high" when comparing.
const effortOrDefault = (effort) => effortRank(effort ?? "high");

/**
 * Keep a route inside the actor's allowed profiles. A held or inherited route can sit outside
 * them (a subagent arrives on its parent's model): prefer the same tier at the nearest effort,
 * then the strongest allowed profile below it, then the weakest allowed one.
 */
function clampToAllowed(route, enabled, recommendation) {
  if (!enabled.length || enabled.some(({ id }) => id === route.profileId)) return route;
  const sameTier = enabled
    .filter(({ tier }) => tier === route.tier)
    .sort(
      (a, b) =>
        Math.abs(effortOrDefault(a.effort) - effortOrDefault(route.requestedEffort)) -
        Math.abs(effortOrDefault(b.effort) - effortOrDefault(route.requestedEffort)),
    );
  const byStrength = [...enabled].sort(
    (a, b) => profileRank(a.tier) - profileRank(b.tier) || effortRank(a.effort) - effortRank(b.effort),
  );
  const below = byStrength.filter(({ tier }) => profileRank(tier) < profileRank(route.tier)).at(-1);
  const target = sameTier[0] ?? below ?? byStrength[0];
  return reroute(route, target, `kept within allowed profiles (${target.id})`, recommendation);
}

/**
 * An explicit xhigh/max request (e.g. Claude Code's ultracode mode) is the user's choice for
 * the main agent; routing must not quietly lower the effort that mode depends on.
 */
function holdRequestedEffort(route, enabled, requested, recommendation) {
  if (!["xhigh", "max"].includes(requested)) return route;
  if (effortOrDefault(route.requestedEffort) >= effortRank(requested)) return route;
  const target =
    enabled
      .filter(({ tier, effort }) => effort === requested && profileRank(tier) >= profileRank(route.tier))
      .sort((a, b) => profileRank(a.tier) - profileRank(b.tier))[0] ??
    withEffort(enabled.find(({ model }) => model === route.model), requested);
  return target ? reroute(route, target, `kept requested ${requested} effort`, recommendation) : route;
}

function subagentBounds(route, enabled, config, recommendation) {
  const cap = config.subagentMaxTier;
  const capEffort = cap ? config.subagentMaxEffort ?? null : null;
  // A default (null) effort at the cap tier counts as above an explicit effort cap: the
  // model's own default is not known to be at or below it.
  const aboveCap =
    cap &&
    (profileRank(route.tier) > profileRank(cap) ||
      (capEffort && route.tier === cap && (route.requestedEffort == null || effortRank(route.requestedEffort) > effortRank(capEffort))));
  if (aboveCap) {
    const atCap = enabled.filter(({ tier }) => tier === cap);
    const lowered = capEffort
      ? atCap.find(({ effort }) => effort === capEffort) ?? withEffort(atCap[0], capEffort)
      : atCap.find(({ effort }) => effort === "high") ??
        atCap.sort((a, b) => effortRank(b.effort) - effortRank(a.effort))[0];
    if (lowered) {
      const label = capEffort ? `${legacyTierOf(cap)}-${capEffort}` : `tier ${cap}`;
      return reroute(route, lowered, `lowered to subagent maximum ${label}`, recommendation);
    }
  }
  const floor = config.subagentMinTier;
  if (!floor || profileRank(route.tier) >= profileRank(floor)) return route;
  const raised = equalOrStronger(enabled, floor, route.requestedEffort);
  return raised ? reroute(route, raised, `raised to subagent minimum tier ${floor}`, recommendation) : route;
}

/** Pure policy boundary: recommendation in, validated EffectiveRoute out. */
export function selectEffectiveRoute(input) {
  let route = selectUnfloored(input);
  if (!route || route.source === "manual") return route;
  const { profiles = [], contextState = {}, config = {}, recommendation } = input;
  const enabled = profiles.filter(({ enabled }) => enabled !== false);
  if (contextState.restrictedProfiles) route = clampToAllowed(route, enabled, recommendation);
  if (contextState.actorType === "main") {
    route = holdRequestedEffort(route, enabled, contextState.requestedEffort, recommendation);
  }
  if (contextState.actorType === "subagent") route = subagentBounds(route, enabled, config, recommendation);
  return route;
}

function selectUnfloored({
  recommendation,
  currentRoute,
  profiles = [],
  contextState = {},
  manualState = {},
  config = {},
}) {
  const enabled = profiles.filter(({ enabled }) => enabled !== false);
  const current = currentProfile(currentRoute, enabled);
  const held =
    current ??
    (currentRoute?.model
      ? {
          id: currentRoute.profileId ?? "current",
          model: currentRoute.model,
          tier: currentRoute.tier ?? profileTierOf(tierOf(currentRoute.model)) ?? "unknown",
          effort: currentRoute.effectiveEffort ?? null,
          thinking: currentRoute.thinkingPolicy ?? "default",
          capabilityVersion:
            currentRoute.capabilityVersion ??
            profiles.find(({ model }) => model === currentRoute.model)?.capabilityVersion,
          enabled: true,
        }
      : null) ??
    enabled.find(({ tier }) => tier === "strong") ??
    enabled[0] ??
    null;
  if (!held) return null;
  const routeOptions = { createdAt: config.createdAt ?? 0 };

  if (manualState.lockedRoute) {
    const locked =
      enabled.find(({ id }) => id === manualState.lockedRoute.profileId) ??
      enabled.find(({ model }) => model === manualState.lockedRoute.model);
    if (locked) return routeFrom(locked, { ...routeOptions, source: "manual", recommendation, notes: ["manual routing lock"] });
    return routeFrom(held, {
      ...routeOptions,
      source: "fallback",
      recommendation,
      fallbackReason: "manual_lock_unavailable",
      notes: ["manual routing lock could not be applied"],
    });
  }

  const promptOverride = detectOverride(manualState.prompt);
  if (promptOverride) {
    const tier = profileTierOf(promptOverride);
    const selected = enabled.find(({ tier: candidateTier }) => candidateTier === tier);
    if (selected) return routeFrom(selected, { ...routeOptions, source: "manual", recommendation, notes: ["recognized prompt override"] });
    return routeFrom(held, {
      ...routeOptions,
      source: "fallback",
      recommendation,
      fallbackReason: "manual_override_unavailable",
      notes: [`recognized ${promptOverride} override could not be applied`],
    });
  }

  const mode = config.decisionMode === "signals" ? "signals" : "profiles";
  let selected = candidateFromRecommendation(recommendation, profiles, mode);
  if (!selected) {
    return routeFrom(held, {
      ...routeOptions,
      source: "fallback",
      recommendation,
      fallbackReason: recommendation ? "unknown_recommendation" : "jev_unavailable",
    });
  }
  if (!enabled.includes(selected)) {
    const fallback = equalOrStronger(enabled, selected.tier, selected.effort);
    return routeFrom(fallback ?? held, {
      ...routeOptions,
      source: "fallback",
      recommendation,
      fallbackReason: "model_unavailable",
    });
  }

  const configured = thresholds(config);
  const confidence = recommendation?.confidence;
  const strength = compareStrength(selected, held);
  if (!Number.isFinite(confidence) || confidence < configured.low) {
    if (contextState.actorType === "subagent" && contextState.freshActor) {
      // A new subagent has no earlier route to protect, so the model it arrived with (the
      // parent's) is not a baseline: an unsure answer in either direction starts at the
      // uncertain ceiling instead of holding, or "upgrading" within, that strong model.
      const ceilingTier = configured.uncertainCeiling;
      const above = profileRank(selected.tier) > profileRank(ceilingTier);
      if (above || (strength < 0 && profileRank(held.tier) > profileRank(ceilingTier))) {
        const effort = selected.tier === ceilingTier ? selected.effort : above ? "high" : "medium";
        const start =
          enabled.find(({ tier, effort: e }) => tier === ceilingTier && e === effort) ??
          equalOrStronger(enabled, ceilingTier);
        if (start && profileRank(start.tier) <= profileRank(ceilingTier)) {
          return routeFrom(start, {
            ...routeOptions,
            source: "fallback",
            recommendation,
            fallbackReason: "low_confidence_subagent_start",
          });
        }
      }
    }
    if (strength < 0) {
      return routeFrom(held, {
        ...routeOptions,
        source: "fallback",
        recommendation,
        fallbackReason: "low_confidence_no_downgrade",
      });
    }
    const ceiling = Math.max(profileRank(held.tier), profileRank(configured.uncertainCeiling));
    if (profileRank(selected.tier) > ceiling) {
      const ceilingTier = PROFILE_TIERS[ceiling];
      selected =
        enabled.find(({ tier, effort }) => tier === ceilingTier && effort === selected.effort) ??
        enabled.find(({ tier }) => tier === ceilingTier) ??
        held;
      return routeFrom(selected, {
        ...routeOptions,
        source: "compatibility-normalization",
        recommendation,
        fallbackReason: "low_confidence_capped",
      });
    }
  }

  const confidenceNotes =
    Number.isFinite(confidence) && confidence < configured.high
      ? ["medium-confidence recommendation"]
      : [];

  // A short follow-up ("ok do that", "continue") in an ongoing main conversation carries its
  // meaning in the context Jev never sees, so it must not read as a new trivial task.
  if (
    strength < 0 &&
    contextState.actorType === "main" &&
    contextState.followUp &&
    configured.followUpHoldChars > 0 &&
    (manualState.prompt ?? "").trim().length <= configured.followUpHoldChars
  ) {
    return routeFrom(held, {
      ...routeOptions,
      source: "fallback",
      recommendation,
      fallbackReason: "short_followup_hold",
      notes: confidenceNotes,
    });
  }

  if (
    strength < 0 &&
    (contextState.estimatedTokens ?? 0) > configured.downgradeMaxContextTokens
  ) {
    return routeFrom(held, {
      ...routeOptions,
      source: "fallback",
      recommendation,
      fallbackReason: "cache_preservation",
      notes: confidenceNotes,
    });
  }

  return routeFrom(selected, {
    ...routeOptions,
    source: "jev",
    recommendation,
    notes: confidenceNotes,
  });
}
