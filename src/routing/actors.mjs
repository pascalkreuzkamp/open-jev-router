import { randomUUID } from "node:crypto";

const now = () => Date.now();

function newActor({ actorId, actorType, actorKey, parentActorKey = null, agentName = null, fingerprint }) {
  const at = now();
  return {
    actorId,
    actorType,
    actorKey,
    parentActorKey,
    agentName,
    fingerprint,
    activeLogicalTurnId: null,
    pinnedRoute: null,
    lastDecision: null,
    createdAt: at,
    lastSeenAt: at,
    requestCount: 0,
    continuationCount: 0,
    // Proof that the pinned turn is genuinely under way. Only a continuation establishes it;
    // a second opening request does not. See decideOnce.
    sawContinuationSinceDecision: false,
  };
}

// An actor is kept as long as its route could still be reused. Idle actors are dropped by
// age rather than by a global count, because a count evicts whichever pin is least recently
// touched, which is exactly the long-running main agent a burst of subagents pushes out.
export const ACTOR_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a pinned route absorbs a repeated opening request instead of treating it as a new
 * turn. Sized from the observed ~1s gap between Claude Code's two serializations of the same
 * opening, with headroom, and far below the pace of a human typing the next turn.
 */
export const RESEND_WINDOW_MS = 5000;

export class ActorRegistry {
  #sessions = new Map();
  #inFlight = new Map();
  #idleTtlMs;

  constructor({ idleTtlMs = ACTOR_IDLE_TTL_MS } = {}) {
    this.#idleTtlMs = idleTtlMs;
  }

  session(sessionId = "") {
    const key = sessionId || "local-process";
    let session = this.#sessions.get(key);
    if (!session) {
      session = { sessionId: key, actors: new Map(), mainActorKey: null, startedAt: now() };
      this.#sessions.set(key, session);
    }
    return session;
  }

  /** Drop actors no request has touched within the idle window; never drop one mid-decision. */
  prune(at = now()) {
    let removed = 0;
    for (const [sessionKey, session] of this.#sessions) {
      for (const [actorKey, actor] of session.actors) {
        if (at - actor.lastSeenAt < this.#idleTtlMs) continue;
        if ([...this.#inFlight.keys()].some((key) => key.startsWith(`${actorKey}:`))) continue;
        session.actors.delete(actorKey);
        if (session.mainActorKey === actorKey) session.mainActorKey = null;
        removed += 1;
      }
      if (session.actors.size === 0) this.#sessions.delete(sessionKey);
    }
    return removed;
  }

  detect(request) {
    this.prune();
    const correlation = request.correlation;
    const session = this.session(correlation.sessionId);

    if (correlation.actorId && correlation.actorType) {
      const actorKey = `wire:${correlation.actorId}`;
      const parentActorKey = correlation.parentActorId ? `wire:${correlation.parentActorId}` : null;
      let actor = session.actors.get(actorKey);
      if (!actor) {
        actor = newActor({
          actorId: correlation.actorId,
          actorType: correlation.actorType,
          actorKey,
          parentActorKey,
          agentName: correlation.agentName,
          fingerprint: request.firstMessageFingerprint,
        });
        session.actors.set(actorKey, actor);
      }
      if (actor.actorType === "main") session.mainActorKey ??= actorKey;
      actor.lastSeenAt = now();
      actor.requestCount += 1;
      if (request.shape === "continuation") {
        actor.continuationCount += 1;
        actor.sawContinuationSinceDecision = true;
      }
      return {
        actorType: actor.actorType,
        actorKey,
        parentActorKey: actor.parentActorKey,
        isFresh: request.shape === "fresh",
        confidence: "high",
        evidence: ["explicit actor id", "explicit actor type"],
        actor,
        session,
      };
    }

    // Claude Code declares subagent calls in its billing header (`cc_is_subagent=true`) but
    // gives them no id, so identity has to come from the task text. Splitting on task text is
    // safe *here* in a way it is not for uncorrelated roots generally: a declared subagent can
    // only ever create or match a subagent actor, so it cannot reach the main agent's pin no
    // matter what its prompt says. That was the hazard the rule below guards against.
    //
    // Two subagents running different tasks get different keys and route independently. Two
    // running the identical task share a key and therefore a route, which is the right answer
    // rather than a collision: the same task deserves the same model.
    if (correlation.declaredSubagent && request.firstMessageFingerprint) {
      const actorKey = `sub:${request.firstMessageFingerprint}`;
      let actor = session.actors.get(actorKey);
      if (!actor) {
        actor = newActor({
          actorId: actorKey,
          actorType: "subagent",
          actorKey,
          parentActorKey: session.mainActorKey,
          agentName: correlation.agentName,
          fingerprint: request.firstMessageFingerprint,
        });
        session.actors.set(actorKey, actor);
      }
      actor.lastSeenAt = now();
      actor.requestCount += 1;
      if (request.shape === "continuation") {
        actor.continuationCount += 1;
        actor.sawContinuationSinceDecision = true;
      }
      return {
        actorType: "subagent",
        actorKey,
        parentActorKey: actor.parentActorKey,
        isFresh: request.shape === "fresh",
        confidence: "medium",
        evidence: ["client declared subagent", "identity from task fingerprint"],
        actor,
        session,
      };
    }

    // A session's first observed inference root can safely establish its main actor. Later
    // roots without explicit correlation are not split by prompt text: two identical
    // concurrent subagents would otherwise collide and overwrite each other's pins.
    if (!session.mainActorKey && request.shape === "fresh") {
      const actorKey = `local:${randomUUID()}`;
      const actor = newActor({
        actorId: actorKey,
        actorType: "main",
        actorKey,
        fingerprint: request.firstMessageFingerprint,
      });
      actor.requestCount = 1;
      session.actors.set(actorKey, actor);
      session.mainActorKey = actorKey;
      return {
        actorType: "main",
        actorKey,
        parentActorKey: null,
        isFresh: true,
        confidence: "medium",
        evidence: ["first observed inference root in session", "no explicit actor correlation"],
        actor,
        session,
      };
    }

    const main = session.actors.get(session.mainActorKey);
    if (
      main &&
      request.firstMessageFingerprint &&
      request.firstMessageFingerprint === main.fingerprint
    ) {
      main.lastSeenAt = now();
      main.requestCount += 1;
      if (request.shape === "continuation") {
        main.continuationCount += 1;
        main.sawContinuationSinceDecision = true;
      }
      return {
        actorType: "main",
        actorKey: main.actorKey,
        parentActorKey: null,
        isFresh: request.shape === "fresh",
        confidence: "medium",
        evidence: ["matches established main transcript root", "no explicit actor correlation"],
        actor: main,
        session,
      };
    }

    return {
      actorType: "unknown",
      actorKey: null,
      parentActorKey: null,
      isFresh: request.shape === "fresh",
      confidence: "low",
      evidence: ["no explicit actor correlation", "not the established main transcript"],
      actor: null,
      session,
    };
  }

  actor(session, actorKey) {
    return actorKey ? session?.actors.get(actorKey) ?? null : null;
  }

  parentOf(detection) {
    return this.actor(detection.session, detection.parentActorKey);
  }

  async decideOnce(actor, logicalTurnId, factory) {
    // Claude Code sends the opening request of a turn twice: once as [user, system] and again
    // as a fuller single user message. Verified live against 2.1.278 on 2026-09-22, roughly a
    // second apart. Both classify as fresh, and with no turn id on the wire each minted its
    // own local turn key, so one user turn bought two routing decisions and the model could
    // change between them.
    //
    // A pinned route therefore survives a second opening, because the only evidence that a
    // turn is genuinely under way is a continuation. The time bound keeps this from swallowing
    // a real next turn: the re-send arrives within about a second, while a human turn in an
    // interactive session takes far longer, and each scripted `claude -p` run is its own
    // session with its own actors.
    if (
      !logicalTurnId &&
      actor.pinnedRoute &&
      !actor.sawContinuationSinceDecision &&
      now() - (actor.lastDecisionAt ?? 0) < RESEND_WINDOW_MS
    ) {
      return {
        route: actor.pinnedRoute,
        decision: actor.lastDecision,
        logicalTurnId: actor.activeLogicalTurnId,
        reused: true,
      };
    }
    const turnId = logicalTurnId || `local-turn:${randomUUID()}`;
    if (actor.activeLogicalTurnId === turnId && actor.pinnedRoute) {
      return {
        route: actor.pinnedRoute,
        decision: actor.lastDecision,
        logicalTurnId: turnId,
        reused: true,
      };
    }
    const key = `${actor.actorKey}:${turnId}`;
    if (this.#inFlight.has(key)) return this.#inFlight.get(key);
    const promise = Promise.resolve()
      .then(factory)
      .then((value) => {
        actor.activeLogicalTurnId = turnId;
        actor.pinnedRoute = value.route;
        actor.lastDecision = value.decision ?? null;
        actor.lastDecisionAt = now();
        actor.sawContinuationSinceDecision = false;
        actor.lastSeenAt = now();
        return { ...value, logicalTurnId: turnId, reused: false };
      })
      .finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, promise);
    return promise;
  }

  snapshot() {
    return [...this.#sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      mainActorKey: session.mainActorKey,
      actors: [...session.actors.values()].map((actor) => ({ ...actor })),
    }));
  }
}
