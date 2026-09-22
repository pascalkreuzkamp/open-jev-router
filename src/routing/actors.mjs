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
  };
}

// An actor is kept as long as its route could still be reused. Idle actors are dropped by
// age rather than by a global count, because a count evicts whichever pin is least recently
// touched, which is exactly the long-running main agent a burst of subagents pushes out.
export const ACTOR_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

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
      if (request.shape === "continuation") actor.continuationCount += 1;
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
      if (request.shape === "continuation") main.continuationCount += 1;
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
