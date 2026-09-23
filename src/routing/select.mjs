import { detectOverride } from "../policy.mjs";
import { THRESHOLDS, tierOf } from "../config.mjs";
import { EFFORT_LEVELS } from "./capabilities.mjs";
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
  const floor = String(env.JEV_SUBAGENT_MIN_TIER ?? "").trim().toLowerCase();
  return {
    followUpHoldChars: env.JEV_FOLLOWUP_HOLD_CHARS != null && Number.isInteger(holdChars) && holdChars >= 0 ? holdChars : 200,
    subagentMinTier: PROFILE_TIERS.includes(floor) ? floor : profileTierOf(floor),
    decisionMode: env.JEV_DECISION_MODE === "signals" ? "signals" : "profiles",
    confidenceLow,
    confidenceHigh,
    downgradeMaxContextTokens: THRESHOLDS.downgradeMaxContextTokens,
    uncertainCeiling: "balanced",
  };
}

/** Pure policy boundary: recommendation in, validated EffectiveRoute out. */
export function selectEffectiveRoute(input) {
  const route = selectUnfloored(input);
  const { profiles = [], contextState = {}, config = {} } = input;
  const floor = contextState.actorType === "subagent" ? config.subagentMinTier : null;
  if (!route || !floor || route.source === "manual") return route;
  if (profileRank(route.tier) >= profileRank(floor)) return route;
  const enabled = profiles.filter(({ enabled }) => enabled !== false);
  const raised = equalOrStronger(enabled, floor, route.requestedEffort);
  if (!raised) return route;
  return routeFrom(raised, {
    source: route.source,
    recommendation: input.recommendation,
    fallbackReason: route.fallbackReason,
    notes: [...route.normalizationNotes, `raised to subagent minimum tier ${floor}`],
    createdAt: route.createdAt,
  });
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
    if (strength < 0 && contextState.actorType === "subagent" && contextState.freshActor) {
      // A new subagent has no earlier route to protect: "never downgrade" would leave it on
      // whatever strong model it arrived with. Start it at the uncertain ceiling instead.
      const ceilingTier = configured.uncertainCeiling;
      if (profileRank(held.tier) > profileRank(ceilingTier)) {
        const effort = selected.tier === ceilingTier ? selected.effort : "medium";
        const start =
          enabled.find(({ tier, effort: e }) => tier === ceilingTier && e === effort) ??
          equalOrStronger(enabled, ceilingTier);
        if (start && profileRank(start.tier) < profileRank(held.tier)) {
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
