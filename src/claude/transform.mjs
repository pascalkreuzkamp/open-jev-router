import { capabilitiesForModel, nearestSupportedEffort } from "../routing/capabilities.mjs";

const withoutThinkingEdits = (body, audit) => {
  const edits = body.context_management?.edits;
  if (!Array.isArray(edits)) return;
  const kept = edits.filter((edit) => !/thinking/i.test(edit?.type ?? ""));
  if (kept.length !== edits.length) audit.removedFields.push("context_management.edits[*thinking*]");
  if (kept.length) body.context_management.edits = kept;
  else delete body.context_management;
};

/** Apply an EffectiveRoute with minimum mutation and return an inspection audit. */
export function transformClaudeRequest(input, route, capabilityLookup = capabilitiesForModel) {
  const body = structuredClone(input);
  const capabilities = capabilityLookup(route?.model);
  const audit = {
    modelBefore: body.model ?? null,
    modelAfter: route?.model ?? body.model ?? null,
    effortBefore: body.output_config?.effort ?? null,
    effortAfter: null,
    removedFields: [],
    normalizationNotes: [...(route?.normalizationNotes ?? [])],
  };
  if (!route?.model) return { body, audit };
  body.model = route.model;

  if (!capabilities) {
    audit.normalizationNotes.push("unknown model capabilities; preserved effort and thinking");
    audit.effortAfter = body.output_config?.effort ?? null;
    return { body, audit };
  }

  const requested = route.effectiveEffort ?? null;
  const effort = requested
    ? nearestSupportedEffort(requested, capabilities.supportedEfforts)
    : null;
  if (effort) {
    body.output_config = { ...(body.output_config ?? {}), effort };
  } else if (body.output_config && "effort" in body.output_config) {
    const existing = body.output_config.effort;
    if (!requested && capabilities.supportedEfforts.includes(existing)) {
      // A model-only route does not erase a valid control already supplied upstream.
    } else {
      const normalized = !requested
        ? nearestSupportedEffort(existing, capabilities.supportedEfforts)
        : null;
      if (normalized) {
        body.output_config.effort = normalized;
        audit.normalizationNotes.push(`existing effort ${existing} normalized to ${normalized}`);
      } else {
        delete body.output_config.effort;
        audit.removedFields.push("output_config.effort");
        if (!Object.keys(body.output_config).length) delete body.output_config;
      }
    }
  }
  audit.effortAfter = body.output_config?.effort ?? null;
  if (requested && effort !== requested) {
    audit.normalizationNotes.push(`unsupported effort ${requested}; used ${effort ?? "default"}`);
  }

  const thinkingType = body.thinking?.type;
  if (thinkingType === "adaptive" && !capabilities.supportsAdaptiveThinking) {
    delete body.thinking;
    audit.removedFields.push("thinking");
    audit.normalizationNotes.push("target model does not support adaptive thinking");
    withoutThinkingEdits(body, audit);
  } else if (thinkingType === "enabled" && !capabilities.supportsManualThinking) {
    if (capabilities.supportsAdaptiveThinking) {
      body.thinking = { type: "adaptive" };
      audit.normalizationNotes.push("manual thinking normalized to adaptive thinking");
    } else {
      delete body.thinking;
      audit.removedFields.push("thinking");
      withoutThinkingEdits(body, audit);
    }
  } else if (thinkingType === "disabled") {
    const disabledAllowed =
      capabilities.supportsDisabledThinking &&
      (!effort || !capabilities.disabledThinkingEfforts || capabilities.disabledThinkingEfforts.includes(effort));
    if (!disabledAllowed) {
      if (capabilities.thinkingAlwaysOn) delete body.thinking;
      else body.thinking = { type: "adaptive" };
      audit.normalizationNotes.push(`thinking=disabled is incompatible with ${effort ?? route.model}`);
    }
  }

  if (!body.thinking) withoutThinkingEdits(body, audit);

  return { body, audit };
}
