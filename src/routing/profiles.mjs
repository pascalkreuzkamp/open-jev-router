import { boolEnv } from "../env.mjs";
import { TIERS, tierOf } from "../config.mjs";
import { capabilitiesForCatalogModel } from "./capabilities.mjs";

export const PROFILE_TIERS = ["fast", "balanced", "strong", "long"];

const ROUTER_TIER = {
  haiku: "fast",
  sonnet: "balanced",
  opus: "strong",
  fable: "long",
};

const LEGACY_TIER = Object.fromEntries(Object.entries(ROUTER_TIER).map(([legacy, profile]) => [profile, legacy]));

const MODEL_ENV = {
  fast: "JEV_CLAUDE_FAST_MODEL",
  balanced: "JEV_CLAUDE_BALANCED_MODEL",
  strong: "JEV_CLAUDE_STRONG_MODEL",
  long: "JEV_CLAUDE_LONG_MODEL",
};

const DEFAULT_EFFORTS = {
  fast: [null],
  balanced: ["low", "medium", "high"],
  strong: ["medium", "high", "xhigh", "max"],
  long: ["high", "xhigh", "max"],
};

export const profileTierOf = (legacyTier) => ROUTER_TIER[legacyTier] ?? null;
export const legacyTierOf = (profileTier) => LEGACY_TIER[profileTier] ?? null;
export const profileRank = (tier) => PROFILE_TIERS.indexOf(tier);

export function decisionMode(env = process.env) {
  return env.JEV_DECISION_MODE === "signals" ? "signals" : "profiles";
}

export function longTierEnabled(env = process.env) {
  return boolEnv("JEV_ALLOW_LONG_TIER", env) || boolEnv("JEV_ALLOW_FABLE", env);
}

export function effortRoutingEnabled(env = process.env) {
  const value = env.JEV_ENABLE_EFFORT_ROUTING;
  return value == null || (value !== "0" && value.toLowerCase() !== "false");
}

function catalogModels(models) {
  return models.filter(({ id, tier }) => tier || tierOf(id));
}

function selectedModels(tier, models, env) {
  const override = env[MODEL_ENV[tier]];
  if (override) {
    const selected = models.find(({ id }) => id === override);
    return selected ? [selected] : [];
  }
  const legacy = legacyTierOf(tier);
  return models
    .filter(({ tier: modelTier, id }) => (modelTier ?? tierOf(id)) === legacy);
}

/**
 * Resolve the signed-in account catalog into enabled, capability-valid routing profiles.
 * An override absent from the catalog disables that tier rather than inventing availability.
 */
export function resolveProfiles({ models = [], env = process.env, capabilityLookup } = {}) {
  const lookup = capabilityLookup ?? ((model, modelInfo) => capabilitiesForCatalogModel(modelInfo, env));
  const catalog = catalogModels(models.length ? models : TIERS.map(({ id, name }) => ({ id, tier: name })));
  const profiles = [];
  for (const tier of PROFILE_TIERS) {
    if (tier === "long" && !longTierEnabled(env)) continue;
    const modelsForTier = selectedModels(tier, catalog, env);
    for (const [modelIndex, modelInfo] of modelsForTier.entries()) {
      const model = modelInfo.id;
      const capabilities = lookup(model, modelInfo);
      if (!capabilities) continue;
      const suffix = modelIndex ? `-${model.replace(/^claude-/, "")}` : "";
      const efforts = effortRoutingEnabled(env) ? DEFAULT_EFFORTS[tier] : [null];
      for (const effort of efforts) {
        if (effort && !capabilities.supportedEfforts.includes(effort)) continue;
        profiles.push({
          id: `${legacyTierOf(tier)}-${effort ?? "default"}${suffix}`,
          model,
          tier,
          effort,
          thinking: "default",
          enabled: true,
          capabilityVersion: capabilities.capabilityVersion,
        });
      }
    }
  }
  return profiles;
}

export function profileDescription(profile) {
  return `${profile.tier} route using ${profile.model}${profile.effort ? ` at ${profile.effort} effort` : ""}`;
}
