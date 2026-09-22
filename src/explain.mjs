const WIDTH = 58;
const row = (text = "") => `│ ${text.slice(0, WIDTH - 2).padEnd(WIDTH - 2)} │`;
const metric = (value) => (Number.isFinite(value) ? value.toFixed(2) : "n/a");
const wrapped = (label, value) => {
  const words = `${label}${value}`.replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  for (const word of words) {
    if (!lines.length || `${lines.at(-1)} ${word}`.length > WIDTH - 2) lines.push(word);
    else lines[lines.length - 1] += ` ${word}`;
  }
  return lines.map(row);
};

const decision = (reason = "") => {
  if (reason.includes("override") || reason === "manual") return "prompt override";
  if (reason.includes("jev-unavailable")) return "Jev unavailable; held";
  if (reason.includes("low-confidence-no-downgrade")) return "low confidence; held";
  if (reason.includes("low-confidence-capped")) return "low confidence; capped";
  if (reason.includes("cache-rebuild")) return "cache rebuild avoided";
  if (reason.includes("cache_preservation")) return "cache rebuild avoided";
  if (reason.includes("low_confidence")) return "confidence policy applied";
  if (reason.includes("model_unavailable")) return "nearest available profile";
  if (reason.includes("unavailable")) return "nearest available tier";
  return "Jev recommendation";
};

export function formatExplanation(status) {
  if (!status) return "Jev Router: no routing decision has been recorded for this session.";
  if (status.manual) {
    return `Jev Router: routing is paused; manual model ${status.model ?? "unknown"} is active.`;
  }

  const m = status.metrics ?? {};
  const recommendation = status.recommendedTier ?? status.tier ?? "unknown";
  const promptLine =
    status.prompt ?? (status.promptPreview ? `${status.promptPreview} (preview)` : "not recorded (see JEV_STORE_PROMPTS)");
  return [
    `┌${"─".repeat(WIDTH)}┐`,
    row("Jev Router"),
    row(),
    row("Actor"),
    row(`Type: ${status.actorType ?? "unknown"}`),
    row(`Name: ${status.actorName ?? "unavailable"}`),
    row(`Actor ID: ${status.actorId ?? "unavailable"}`),
    row(`Parent: ${status.parentActorId ?? "unavailable"}`),
    row(),
    row("Request"),
    row(`Classification: ${status.requestClassification ?? "unknown"}`),
    ...wrapped("Prompt: ", promptLine),
    row(`Current tier: ${(status.currentModel ?? "unknown").toUpperCase()}`),
    row(`Context tokens: ${status.contextTokens ?? "unknown"}`),
    row(),
    row("Jev"),
    row(`Provider: ${status.provider ?? "unavailable"}`),
    row(`Model: ${status.resolvedModel ?? status.configuredModel ?? "unavailable"}`),
    row(`Decision ID: ${status.decisionId ?? "unavailable"}`),
    row(`Latency: ${status.latencyMs == null ? "unavailable" : `${status.latencyMs} ms`}`),
    row(`Cost: ${status.cost == null ? "unavailable" : `$${Number(status.cost).toFixed(6)}`}`),
    row(`Task complexity     ${metric(m.taskComplexity)}`),
    row(`Reasoning required  ${metric(m.reasoningRequired)}`),
    row(`Tool complexity     ${metric(m.toolComplexity)}`),
    row(`Context size        ${metric(m.contextSize)}`),
    row(),
    row("Recommendation"),
    row(`Profile: ${status.recommendedProfile ?? recommendation}`),
    row(`Recommended tier: ${recommendation.toUpperCase()}`),
    row(`Effort: ${(status.requestedEffort ?? "unavailable").toUpperCase()}`),
    row(),
    row("Effective route"),
    row(`Selected model: ${(status.model ?? status.tier ?? "unknown").toUpperCase()}`),
    row(`Effective effort: ${(status.effectiveEffort ?? "default").toUpperCase()}`),
    ...(status.normalizationNotes?.length
      ? wrapped("Normalized: ", status.normalizationNotes.join("; "))
      : []),
    row(),
    row(`Confidence: ${status.confidence == null ? "n/a" : `${Math.round(status.confidence * 100)}%`}`),
    row(`Decision: ${decision(status.reason)}`),
    row(`Decision source: ${status.source ?? decision(status.reason)}`),
    ...(status.fallbackReason ? wrapped("Fallback: ", status.fallbackReason) : []),
    row(),
    row("Upstream outcome"),
    row(`Status: ${status.upstreamOutcome == null ? "unavailable" : status.upstreamOutcome.success ? "succeeded" : "failed"}`),
    ...(status.upstreamOutcome?.httpStatus == null
      ? []
      : [row(`HTTP: ${status.upstreamOutcome.httpStatus}`)]),
    ...(status.upstreamOutcome?.model
      ? [row(`Observed model: ${status.upstreamOutcome.model}`)]
      : []),
    `└${"─".repeat(WIDTH)}┘`,
  ].join("\n");
}
