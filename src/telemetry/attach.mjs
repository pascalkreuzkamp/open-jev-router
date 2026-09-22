import { createRecorder } from "./recorder.mjs";
import { storePromptPreview, storePrompts } from "./config.mjs";

/**
 * Translates what the proxy already knows into telemetry rows.
 *
 * Identity here is namespaced by session: an actor key such as `wire:main` is only unique
 * within the session that produced it, so the stored id carries both. Nothing in this module
 * throws; a caller treats every function as a side effect it does not depend on.
 */
export function createTelemetry({
  recorder = null,
  env = process.env,
  routerVersion = "unknown",
} = {}) {
  const sink = recorder ?? createRecorder({ env });
  const sessions = new Set();
  const actors = new Set();
  const counters = { unattributedRequests: 0 };

  const actorRowId = (sessionId, actorKey) =>
    actorKey ? `${sessionId}::${actorKey}` : null;

  function noteSession(sessionId, details = {}) {
    if (!sink.enabled || !sessionId || sessions.has(sessionId)) return sessionId;
    sessions.add(sessionId);
    sink.session({
      id: sessionId,
      claudeSessionId: details.claudeSessionId ?? null,
      projectPath: details.projectPath ?? null,
      startedAt: details.startedAt ?? Date.now(),
      endedAt: null,
      routerVersion,
      claudeVersion: details.claudeVersion ?? null,
      launchMode: details.launchMode ?? null,
      jevProvider: details.jevProvider ?? null,
    });
    return sessionId;
  }

  /** Record (or refresh) the actor a request belongs to. Returns its stored id, or null. */
  function noteActor(sessionId, detection) {
    if (!sink.enabled || !sessionId || !detection?.actorKey) return null;
    const id = actorRowId(sessionId, detection.actorKey);
    const now = Date.now();
    const parentKey = detection.parentActorKey;
    // A parent is linked only when it is an actor we have actually seen. An unobserved parent
    // stays null -- unknown, rather than a guessed link.
    const parentId = parentKey && actors.has(actorRowId(sessionId, parentKey))
      ? actorRowId(sessionId, parentKey)
      : null;
    actors.add(id);
    sink.actor({
      id,
      sessionId,
      parentActorId: parentId,
      actorType: detection.actorType,
      agentName: detection.actor?.agentName ?? null,
      createdAt: detection.actor?.createdAt ?? now,
      lastSeenAt: now,
    });
    return id;
  }

  /**
   * Record one fresh effective decision. Continuations must never call this: a route row is a
   * decision, and counting continuations here would inflate every per-route figure.
   */
  function noteRoute({ sessionId, actorId, logicalTurnId, classification, route, jev, decision }) {
    if (!sink.enabled || !sessionId || !actorId || !route) return null;
    const id = route.telemetryRouteId ?? sink.newId();
    sink.route({
      id,
      sessionId,
      actorId,
      logicalTurnId: logicalTurnId ?? "unknown",
      timestamp: decision?.at ?? Date.now(),
      classification,
      source: route.source ?? "unknown",
      provider: route.provider ?? jev?.provider ?? null,
      jevDecisionId: route.jevDecisionId ?? jev?.decisionId ?? null,
      recommendedProfile: jev?.choice ?? null,
      effectiveProfile: route.profileId ?? route.model,
      model: route.model,
      tier: route.tier ?? null,
      requestedEffort: route.requestedEffort ?? null,
      effectiveEffort: route.effectiveEffort ?? null,
      confidence: route.confidence ?? jev?.confidence ?? null,
      fallbackReason: route.fallbackReason ?? null,
      normalizationJson: route.normalizationNotes?.length
        ? JSON.stringify(route.normalizationNotes)
        : null,
      jevLatencyMs: jev?.ms ?? null,
      jevInputTokens: jev?.usage?.inputTokens ?? jev?.usage?.input_tokens ?? null,
      jevOutputTokens: jev?.usage?.outputTokens ?? jev?.usage?.output_tokens ?? null,
      jevCostUsd: jev?.cost ?? null,
      requestHash: decision?.promptHash ?? null,
      // The prompt itself is stored only under the same explicit opt-ins that govern the
      // decision files; the column is NULL by default.
      promptPreview: promptPreviewFor(decision),
    });
    return id;
  }

  function promptPreviewFor(decision) {
    if (storePrompts(env)) return decision?.prompt ?? null;
    if (storePromptPreview(env)) return decision?.promptPreview ?? null;
    return null;
  }

  function noteRequest(row) {
    if (!sink.enabled) return;
    if (!row.sessionId || !row.actorId) {
      // Auxiliary, manual, and unidentified traffic has no actor to attribute it to. It is
      // counted so a report can say how much was left out rather than implying it never ran.
      counters.unattributedRequests += 1;
      return;
    }
    sink.request(row);
  }

  function noteUsage(requestId, usage) {
    if (!sink.enabled || !requestId || !usage?.sawUsage) return;
    sink.usage({
      requestId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      rawUsageJson: JSON.stringify({
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cacheReadInputTokens,
        cache_creation_input_tokens: usage.cacheCreationInputTokens,
        complete: usage.complete,
        notes: usage.notes,
      }),
    });
  }

  function endSession(sessionId) {
    if (!sink.enabled || !sessions.has(sessionId)) return;
    sink.session({
      id: sessionId,
      claudeSessionId: null,
      projectPath: null,
      startedAt: Date.now(),
      endedAt: Date.now(),
      routerVersion,
      claudeVersion: null,
      launchMode: null,
      jevProvider: null,
    });
  }

  return {
    enabled: sink.enabled,
    recorder: sink,
    newId: () => sink.newId(),
    noteSession,
    noteActor,
    noteRoute,
    noteRequest,
    noteUsage,
    endSession,
    stats: () => ({ ...sink.stats(), ...counters }),
    flush: (options) => sink.flush(options),
    prune: (options) => sink.prune(options),
    close: (options) => sink.close(options),
  };
}
