export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Versioned from Anthropic's public model/effort/thinking documentation, retrieved
 * 2026-09-22. Rules are intentionally exact by generation: an unknown future model must
 * not inherit capabilities merely because its name contains "sonnet" or "opus".
 */
export const CAPABILITY_MATRIX = Object.freeze({
  version: "2026-09-22",
  sources: [
    "https://platform.claude.com/docs/en/models/overview",
    "https://platform.claude.com/docs/en/build-with-claude/effort",
    "https://platform.claude.com/docs/en/build-with-claude/extended-thinking",
  ],
  rules: [
    {
      id: "haiku-4.5",
      pattern: /^claude-haiku-4-5(?:-\d{8})?(?:\[.*\])?$/,
      supportedEfforts: [],
      supportsAdaptiveThinking: false,
      supportsManualThinking: true,
      supportsDisabledThinking: true,
      thinkingAlwaysOn: false,
    },
    {
      id: "sonnet-4.6",
      pattern: /^claude-sonnet-4-6(?:\[.*\])?$/,
      supportedEfforts: ["low", "medium", "high", "max"],
      supportsAdaptiveThinking: true,
      supportsManualThinking: false,
      supportsDisabledThinking: true,
      thinkingAlwaysOn: false,
    },
    {
      id: "sonnet-5",
      pattern: /^claude-sonnet-5(?:\[.*\])?$/,
      supportedEfforts: EFFORT_LEVELS,
      supportsAdaptiveThinking: true,
      supportsManualThinking: false,
      supportsDisabledThinking: true,
      thinkingAlwaysOn: false,
    },
    {
      id: "opus-4.5",
      pattern: /^claude-opus-4-5(?:-\d{8})?(?:\[.*\])?$/,
      supportedEfforts: ["low", "medium", "high", "max"],
      supportsAdaptiveThinking: false,
      supportsManualThinking: true,
      supportsDisabledThinking: true,
      thinkingAlwaysOn: false,
    },
    {
      id: "opus-4.6",
      pattern: /^claude-opus-4-6(?:\[.*\])?$/,
      supportedEfforts: ["low", "medium", "high", "max"],
      supportsAdaptiveThinking: true,
      supportsManualThinking: false,
      supportsDisabledThinking: true,
      thinkingAlwaysOn: false,
    },
    {
      id: "opus-4.7-4.8",
      pattern: /^claude-opus-4-(?:7|8)(?:\[.*\])?$/,
      supportedEfforts: EFFORT_LEVELS,
      supportsAdaptiveThinking: true,
      supportsManualThinking: false,
      supportsDisabledThinking: true,
      thinkingAlwaysOn: false,
    },
    {
      id: "opus-5",
      pattern: /^claude-opus-5(?:\[.*\])?$/,
      supportedEfforts: EFFORT_LEVELS,
      supportsAdaptiveThinking: true,
      supportsManualThinking: false,
      supportsDisabledThinking: true,
      disabledThinkingEfforts: ["low", "medium", "high"],
      thinkingAlwaysOn: false,
    },
    {
      id: "fable-5-5.1",
      pattern: /^claude-fable-5(?:-1)?(?:\[.*\])?$/,
      supportedEfforts: EFFORT_LEVELS,
      supportsAdaptiveThinking: true,
      supportsManualThinking: false,
      supportsDisabledThinking: false,
      thinkingAlwaysOn: true,
    },
  ],
});

const cloneRule = (rule) => ({
  ...rule,
  supportedEfforts: [...rule.supportedEfforts],
  disabledThinkingEfforts: rule.disabledThinkingEfforts
    ? [...rule.disabledThinkingEfforts]
    : undefined,
  capabilityVersion: CAPABILITY_MATRIX.version,
});

/** Unknown models return null so callers preserve their request instead of guessing. */
export function capabilitiesFor(model, matrix = CAPABILITY_MATRIX) {
  if (typeof model !== "string") return null;
  const rule = matrix.rules.find(({ pattern }) => pattern.test(model));
  return rule ? cloneRule(rule) : null;
}

const BOOLEAN_FIELDS = [
  "supportsAdaptiveThinking",
  "supportsManualThinking",
  "supportsDisabledThinking",
  "thinkingAlwaysOn",
];

/** Parse exact-model local overrides; malformed entries are rejected as a unit. */
export function capabilityOverridesFromEnv(env = process.env) {
  if (!env.JEV_CAPABILITY_OVERRIDES) return { overrides: new Map(), errors: [] };
  let parsed;
  try {
    parsed = JSON.parse(env.JEV_CAPABILITY_OVERRIDES);
  } catch {
    return { overrides: new Map(), errors: ["JEV_CAPABILITY_OVERRIDES is not valid JSON"] };
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return { overrides: new Map(), errors: ["JEV_CAPABILITY_OVERRIDES must be an object"] };
  }
  const overrides = new Map();
  const errors = [];
  for (const [model, value] of Object.entries(parsed)) {
    const efforts = value?.supportedEfforts;
    const valid =
      model.startsWith("claude-") &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray(efforts) &&
      efforts.every((effort) => EFFORT_LEVELS.includes(effort)) &&
      BOOLEAN_FIELDS.every((field) => typeof value[field] === "boolean") &&
      (!value.thinkingAlwaysOn || !value.supportsDisabledThinking) &&
      (value.disabledThinkingEfforts === undefined ||
        (Array.isArray(value.disabledThinkingEfforts) &&
          value.supportsDisabledThinking &&
          value.disabledThinkingEfforts.every(
            (effort) => EFFORT_LEVELS.includes(effort) && efforts.includes(effort),
          )));
    if (!valid) {
      errors.push(`invalid capability override for ${model}`);
      continue;
    }
    overrides.set(model, {
      id: `local:${model}`,
      ...value,
      supportedEfforts: [...new Set(efforts)],
      disabledThinkingEfforts: value.disabledThinkingEfforts
        ? [...new Set(value.disabledThinkingEfforts)]
        : undefined,
      capabilityVersion: "local-override",
    });
  }
  return { overrides, errors };
}

export function capabilitiesForModel(model, env = process.env) {
  const { overrides } = capabilityOverridesFromEnv(env);
  const override = overrides.get(model);
  return override ? { ...override, supportedEfforts: [...override.supportedEfforts] } : capabilitiesFor(model);
}

/** Prefer capability facts returned by the signed-in account's Models API. */
export function capabilitiesForCatalogModel(modelInfo, env = process.env) {
  const local = capabilityOverridesFromEnv(env).overrides.get(modelInfo?.id);
  if (local) return { ...local, supportedEfforts: [...local.supportedEfforts] };
  const documented = capabilitiesFor(modelInfo?.id);
  const runtime = modelInfo?.capabilities;
  if (!runtime || typeof runtime !== "object") return documented;
  const runtimeEffort = runtime.effort;
  const supportedEfforts = runtimeEffort?.supported === false
    ? []
    : runtimeEffort?.supported === true
      ? EFFORT_LEVELS.filter((effort) => runtimeEffort[effort]?.supported === true)
      : documented?.supportedEfforts;
  const thinkingTypes = runtime.thinking?.types;
  if (!supportedEfforts || (!thinkingTypes && !documented)) return documented;
  return {
    id: `catalog:${modelInfo.id}`,
    supportedEfforts: [...supportedEfforts],
    supportsAdaptiveThinking:
      thinkingTypes?.adaptive?.supported ?? documented?.supportsAdaptiveThinking ?? false,
    // The public Models API example labels `enabled` as supported for Opus 5 while the
    // thinking guide says manual budget_tokens returns 400 there. Retain the versioned
    // thinking rule until that wire field has an unambiguous contract; use the catalog's
    // explicit effort levels and adaptive support, which are documented consistently.
    supportsManualThinking: documented?.supportsManualThinking ?? false,
    supportsDisabledThinking: documented?.supportsDisabledThinking ?? false,
    disabledThinkingEfforts: documented?.disabledThinkingEfforts
      ? [...documented.disabledThinkingEfforts]
      : undefined,
    thinkingAlwaysOn: documented?.thinkingAlwaysOn ?? false,
    capabilityVersion: `catalog-${CAPABILITY_MATRIX.version}`,
  };
}

export function nearestSupportedEffort(requested, supported = []) {
  const requestedRank = EFFORT_LEVELS.indexOf(requested);
  if (requestedRank < 0) return null;
  for (let rank = requestedRank; rank >= 0; rank--) {
    if (supported.includes(EFFORT_LEVELS[rank])) return EFFORT_LEVELS[rank];
  }
  return null;
}
