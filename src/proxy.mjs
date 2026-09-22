import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import {
  TIERS,
  tierOf,
  idOf,
  availableTiers,
  tierSpec,
  isAuto,
} from "./config.mjs";
import { askJev } from "./router.mjs";
import { debug } from "./log.mjs";
import { boolEnv } from "./env.mjs";
import { writeDecision, writeDecisionOutcome, writeStatus } from "./status.mjs";
import { dumpRequest } from "./dump.mjs";
import { buildDecision } from "./decision.mjs";
import { redactText } from "./sanitize.mjs";
import { resolveProfiles, decisionMode, profileTierOf } from "./routing/profiles.mjs";
import { selectEffectiveRoute, routingConfigFromEnv } from "./routing/select.mjs";
import { transformClaudeRequest } from "./claude/transform.mjs";
import { capabilitiesForCatalogModel } from "./routing/capabilities.mjs";
import {
  inspectClaudeRequest,
  sessionIdOf,
} from "./claude/adapter.mjs";
import {
  auxiliaryPolicy,
  classifyClaudeRequest,
  subagentModelPolicy,
} from "./claude/classify.mjs";
import { ActorRegistry } from "./routing/actors.mjs";
import { createTelemetry } from "./telemetry/attach.mjs";
import { createUsageObserver } from "./telemetry/usage.mjs";
import { ROUTER_VERSION } from "./version.mjs";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-ask
 * Jev on every tool call and let the model flip mid-task, so only the opening request of a
 * turn counts. Claude Code also injects `<system-reminder>` blocks into the user message,
 * which are noise to a router and measurably blunt Jev's confidence, so they are removed.
 */
export function newTurnPrompt(body) {
  const request = inspectClaudeRequest(body);
  return request.shape === "fresh" ? request.prompt : null;
}

/**
 * Points a request at a tier, removing request fields that tier cannot accept. Claude Code
 * composes the body for whatever model it thinks it is talking to, so downgrading to Haiku
 * while leaving `thinking: {type:"adaptive"}` in place is a hard 400.
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  const { body: transformed } = transformClaudeRequest(body, {
    model,
    effectiveEffort: tier.effort ? body.output_config?.effort ?? null : null,
    normalizationNotes: [],
  });
  for (const key of Object.keys(body)) delete body[key];
  Object.assign(body, transformed);
  return body;
}

/** Exact Claude models reported by the account, newest first; static ids are the cold-start fallback. */
const configuredTierOf = (model, env = process.env) => {
  const configured = [
    ["haiku", env.JEV_CLAUDE_FAST_MODEL],
    ["sonnet", env.JEV_CLAUDE_BALANCED_MODEL],
    ["opus", env.JEV_CLAUDE_STRONG_MODEL],
    ["fable", env.JEV_CLAUDE_LONG_MODEL],
  ];
  return tierOf(model) ?? configured.find(([, id]) => id === model)?.[0] ?? null;
};

/**
 * Statuses the API uses when an account cannot run a model: no extra usage credit (402, or a
 * 400/429 billing error), or the model not being enabled for it (403/404).
 */
const FABLE_REFUSAL_STATUS = new Set([400, 402, 403, 404, 429]);

/** Whether an error body says the account lacks access or credit, rather than a bad request. */
export function isFableRefusal(data) {
  let message = "";
  try {
    const parsed = JSON.parse(data.toString());
    message = `${parsed?.error?.type ?? ""} ${parsed?.error?.message ?? ""}`;
  } catch {
    return false;
  }
  return /credit|billing|extra usage|usage limit|quota|not_found_error|permission_error|not (?:available|enabled)|does not have access/i.test(message);
}

export function claudeModels(catalog = [], env = process.env) {
  const models = catalog
    .filter((model) => configuredTierOf(model?.id, env))
    .map((model) => ({
      id: model.id,
      tier: configuredTierOf(model.id, env),
      description: [
        model.display_name,
        model.created_at && `released ${model.created_at.slice(0, 10)}`,
        model.max_input_tokens && `${model.max_input_tokens} input tokens`,
      ].filter(Boolean).join("; "),
      capabilities: model.capabilities ?? null,
    }));
  return models.length
    ? models
    : TIERS.map((tier) => ({ id: tier.id, tier: tier.name, description: tier.id }));
}

const modelForTier = (models, tier) => models.find((model) => model.tier === tier)?.id ?? null;

/**
 * Identifies the conversation a request belongs to. Claude Code runs sub-agents through the
 * same endpoint, so a single pinned model would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used. Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is built from the session id plus the
 * text of the first message, which is fixed once a conversation starts and differs between
 * the main agent and each sub-agent.
 */
/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 * `metadata.user_id` is a JSON string, not a plain id.
 */
export function sessionOf(body) {
  return sessionIdOf(body);
}

export function conversationKey(body) {
  const session = sessionOf(body);
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(`${session}|${text}`).digest("hex").slice(0, 12);
}

/**
 * Records the tier Claude Code is asking for and reports whether the user has taken manual
 * control. The first tier seen in a conversation is the baseline; any later change means the
 * user picked a model with /model, and an explicit choice must beat the router. Compared by
 * tier rather than exact model id, because Claude Code varies the id within a tier.
 */
export function observeModel(state, current) {
  state.baseline ??= current;
  if (current !== state.baseline) state.manual = true;
  return state.manual;
}


export async function startProxy({
  upstreamURL = ANTHROPIC_BASE_URL,
  route = askJev,
  shared = false,
  actorRegistry = new ActorRegistry({ requireSessionIdentity: shared }),
  telemetry = createTelemetry({ routerVersion: ROUTER_VERSION }),
  host = "127.0.0.1",
  port = 0,
  launchMode = shared ? "daemon" : "cli",
  projectPath = shared ? null : process.cwd(),
  health = null,
  instanceId = null,
  onShutdown = null,
} = {}) {
  const catalog = new Map();
  // Set once the account refuses a routed Fable request (no extra usage credit, or the model
  // is not enabled). From then on this proxy stops offering Fable and routes to Opus instead.
  let fableRefused = false;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`proxy host must be loopback, received ${host}`);
  }

  const server = http.createServer((req, res) => {
    if (health && req.method === "GET" && req.url === "/health") {
      const payload = typeof health === "function" ? health() : health;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({
        status: "ok",
        router_version: ROUTER_VERSION,
        instance_id: instanceId,
        pid: process.pid,
        provider: typeof payload?.provider === "string" ? payload.provider : "unavailable",
        provider_key_available: Boolean(payload?.provider_key_available),
        telemetry: Boolean(payload?.telemetry),
      }));
    }
    if (onShutdown && req.method === "POST" && req.url === "/shutdown") {
      if (!instanceId || req.headers["x-jev-instance-id"] !== instanceId) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ status: "forbidden" }));
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "stopping", instance_id: instanceId }));
      setImmediate(onShutdown);
      return;
    }
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      // A routed request that went out as Fable, kept so a refusal can be retried on Opus.
      let fableAttempt = null;
      // What telemetry knows about this request. Filled in below when the request is one we
      // can attribute; left empty for anything else, which is then counted but not stored.
      const observed = {
        requestId: telemetry.enabled ? telemetry.newId() : null,
        sessionId: null,
        actorId: null,
        routeId: null,
        classification: null,
        statusKey: null,
        isContinuation: false,
        model: null,
        effort: null,
        startedAt: Date.now(),
      };
      const observesMessages = /^\/v1\/messages/.test(req.url ?? "");
      const recordsTelemetry = telemetry.enabled && observesMessages;
      let telemetryFinished = false;

      async function recordOutcome({ observer = null, responseBytes = 0, httpStatus = null }) {
        if (!observesMessages || telemetryFinished) return;
        telemetryFinished = true;
        // The stored explanation describes the fresh decision and the request on which it was
        // enforced. Continuations and auxiliary traffic must not rewrite that decision view.
        if (!observed.isContinuation && observed.classification?.endsWith("_fresh")) {
          writeDecisionOutcome(observed.statusKey, observed.routeId, {
            success: httpStatus >= 200 && httpStatus < 400,
            httpStatus,
            model: observed.model,
            effort: observed.effort,
            latencyMs: Date.now() - observed.startedAt,
            responseBytes,
          });
        }
        try {
          const usage = observer ? await observer.end() : null;
          if (recordsTelemetry) {
            telemetry.noteRequest({
              id: observed.requestId,
              sessionId: observed.sessionId,
              actorId: observed.actorId,
              routeId: observed.routeId,
              timestamp: observed.startedAt,
              classification: observed.classification ?? "unknown",
              isContinuation: observed.isContinuation ? 1 : 0,
              model: observed.model,
              effort: observed.effort,
              requestBytes: out.length,
              responseBytes,
              latencyMs: Date.now() - observed.startedAt,
              httpStatus,
              success: httpStatus >= 200 && httpStatus < 400 ? 1 : 0,
            });
            telemetry.noteUsage(observed.requestId, usage);
          }
        } catch (err) {
          debug(`telemetry could not record this request: ${redactText(err.message)}`);
        }
      }

      if (/^\/v1\/messages/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          // Claude Code's request shape is undocumented and moves; JEV_DUMP captures it.
          const request = inspectClaudeRequest(body);
          const detection = actorRegistry.detect(request);
          const classification = classifyClaudeRequest(body, request, detection);
          // Where a decision is filed and where a dump lands must stay stable for the user:
          // `claude -p` sends no session id, and `jev-explain` is given the conversation key.
          // The actor key is internal, so it only ever labels debug output.
          const statusKey = sessionOf(body) || conversationKey(body);
          observed.statusKey = statusKey;
          const key = detection.actorKey ?? statusKey;
          dumpRequest(statusKey, body);
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));

          observed.classification = classification;
          observed.isContinuation = request.shape === "continuation";
          if (detection.actorKey) {
            observed.sessionId = telemetry.noteSession(statusKey, {
              claudeSessionId: sessionOf(body) || null,
              projectPath,
              launchMode,
            });
            observed.actorId = telemetry.noteActor(observed.sessionId, detection);
          }

          if (classification === "manual_passthrough") {
            debug(`passthrough, user selected ${body.model}`);
            if (detection.actor) {
              writeStatus(sessionOf(body), {
                manual: true,
                model: body.model,
                actorType: detection.actorType,
                actorName: detection.actor?.agentName ?? null,
                requestClassification: classification,
                at: Date.now(),
              });
            }
          } else if (classification === "auxiliary") {
            const policy = auxiliaryPolicy();
            let inherited = detection.actor?.pinnedRoute ?? actorRegistry.parentOf(detection)?.pinnedRoute;
            let auxiliaryRoute = null;
            if (policy === "inherit") auxiliaryRoute = inherited;
            if (policy === "fast") {
              const models = claudeModels([...catalog.values()]);
              auxiliaryRoute = resolveProfiles({ models }).find(({ tier }) => tier === "fast") ?? null;
            }
            // The sentinel cannot reach Anthropic. Passthrough therefore falls back to a
            // safe real model only when the incoming model is not already valid.
            if (!auxiliaryRoute && isAuto(body.model)) {
              auxiliaryRoute = inherited ?? { model: idOf("haiku"), effectiveEffort: null };
            }
            if (auxiliaryRoute?.model) {
              const transformed = transformClaudeRequest(body, auxiliaryRoute, (selectedModel) =>
                capabilitiesForCatalogModel(catalog.get(selectedModel) ?? { id: selectedModel }),
              );
              for (const field of Object.keys(body)) delete body[field];
              Object.assign(body, transformed.body);
            }
            debug(`${key} auxiliary/${policy}, no Jev decision`);
          } else if (classification === "unknown") {
            // Unknown identity or shape must not overwrite any actor state. Resolve only the
            // invalid sentinel so the request can still reach Anthropic.
            if (isAuto(body.model)) body.model = idOf("opus");
            debug(`${key} unknown request, preserved without routing`);
          } else {
            const actor = detection.actor;
            // What the prompt cache was built on, which is what a downgrade would discard.
            const current = actor.pinnedRoute?.legacyTier ?? "opus";
            const prompt = request.prompt;
            const explaining = prompt?.includes("<jev-explain>");
            let fresh = null;
            if (classification.endsWith("_fresh") && prompt && !explaining) {
              const models = claudeModels([...catalog.values()]).filter((model) =>
                availableTiers().includes(model.tier) && !(fableRefused && model.tier === "fable"),
              );
              const contextTokens = Math.round(JSON.stringify(body.messages).length / 4);
              const profiles = resolveProfiles({ models });
              const currentModel =
                actor.pinnedRoute?.model ??
                modelForTier(models, current) ??
                profiles.find(({ tier }) => tier === "strong")?.model ??
                profiles.find(({ tier }) => tier === "balanced")?.model ??
                profiles[0]?.model ??
                idOf(current);
              const inherited =
                detection.actorType === "subagent" && subagentModelPolicy() === "inherit"
                  ? actorRegistry.parentOf(detection)?.pinnedRoute ?? null
                  : null;
              const routed = await actorRegistry.decideOnce(
                actor,
                request.correlation.logicalTurnId ?? request.correlation.requestId,
                async () => {
                  const jev = inherited
                    ? null
                    : await route({
                        prompt,
                        current: currentModel,
                        contextTokens,
                        models,
                        profiles,
                        decisionMode: decisionMode(),
                      });
                  const effectiveRoute = inherited
                    ? { ...inherited, source: "inherited", fallbackReason: null, createdAt: Date.now() }
                    : selectEffectiveRoute({
                        recommendation: jev,
                        currentRoute:
                          actor.pinnedRoute ?? {
                            model: currentModel,
                            tier: profileTierOf(current),
                            effectiveEffort: body.output_config?.effort ?? null,
                          },
                        profiles,
                        contextState: { estimatedTokens: contextTokens },
                        manualState: { prompt },
                        config: { ...routingConfigFromEnv(), createdAt: Date.now() },
                      });
                  const tier = effectiveRoute?.legacyTier ?? tierOf(effectiveRoute?.model) ?? current;
                  const model = effectiveRoute?.model ?? currentModel;
                  const reason = inherited
                    ? "inherited"
                    : effectiveRoute?.source === "jev"
                      ? "jev"
                      : effectiveRoute?.fallbackReason === "unknown_recommendation"
                        ? "jev-unavailable+unknown-recommendation"
                        : effectiveRoute?.fallbackReason ?? effectiveRoute?.source ?? "jev-unavailable";
                  return {
                    route: effectiveRoute,
                    jev,
                    decision: buildDecision({
                      tier,
                      model,
                      reason,
                      prompt,
                      jev,
                      route: effectiveRoute,
                      recommendedTier:
                        profiles.find(({ id }) => id === jev?.choice)?.tier ??
                        profileTierOf(tierOf(jev?.choice)) ??
                        null,
                      currentModel,
                      contextTokens,
                      actor: detection,
                      classification,
                    }),
                  };
                },
              );
              fresh = routed.reused ? null : routed.decision;
              // A route row is one fresh effective decision. A reused pin is not a decision,
              // so recording it here would inflate every per-route figure downstream.
              if (!routed.reused && routed.route) {
                routed.route.telemetryRouteId ??= telemetry.newId();
                routed.decision.routeId = routed.route.telemetryRouteId;
                telemetry.noteRoute({
                  sessionId: observed.sessionId,
                  actorId: observed.actorId,
                  logicalTurnId: routed.logicalTurnId,
                  classification,
                  route: routed.route,
                  jev: routed.jev,
                  decision: routed.decision,
                });
              }
              debug(
                `${key} ${routed.jev ? `${routed.jev.ms}ms p=${routed.jev.confidence == null ? "n/a" : routed.jev.confidence.toFixed(2)}` : "no-jev"} ` +
                  `${current} -> ${routed.route?.legacyTier ?? tierOf(routed.route?.model) ?? current} (${routed.decision.reason}) ctx~${contextTokens} | prompt ${routed.decision.promptHash.slice(0, 12)}`,
              );
            }
            // The sentinel is not a real model, so every routed request must be rewritten,
            // including follow-ups that reuse the tier chosen for the turn.
            const tier = actor.pinnedRoute?.legacyTier ?? current;
            const model = actor.pinnedRoute?.model ?? idOf(tier);
            debug(`${key} rewrite ${body.model} -> ${model}`);
            const effectiveRoute = actor.pinnedRoute ?? {
              model,
              effectiveEffort: body.output_config?.effort ?? null,
              normalizationNotes: [],
            };
            const transformed = transformClaudeRequest(
              body,
              effectiveRoute,
              (selectedModel) =>
                capabilitiesForCatalogModel(catalog.get(selectedModel) ?? { id: selectedModel }),
            );
            if (actor.pinnedRoute) {
              const transformNotes = [
                ...transformed.audit.normalizationNotes,
                ...(transformed.audit.removedFields.length
                  ? [`removed ${transformed.audit.removedFields.join(", ")}`]
                  : []),
              ];
              actor.pinnedRoute = {
                ...actor.pinnedRoute,
                effectiveEffort: transformed.audit.effortAfter,
                thinkingPolicy: transformed.body.thinking?.type ?? actor.pinnedRoute.thinkingPolicy,
                normalizationNotes: [...new Set(transformNotes)],
              };
              if (fresh) {
                fresh.effectiveEffort = actor.pinnedRoute.effectiveEffort;
                fresh.thinkingPolicy = actor.pinnedRoute.thinkingPolicy;
                fresh.normalizationNotes = actor.pinnedRoute.normalizationNotes;
              }
            }
            observed.routeId = actor.pinnedRoute?.telemetryRouteId ?? null;
            for (const field of Object.keys(body)) delete body[field];
            Object.assign(body, transformed.body);
            observed.model = body.model ?? null;
            if (configuredTierOf(body.model) === "fable") fableAttempt = { actor, fresh, statusKey, explaining };
            observed.effort = body.output_config?.effort ?? null;
            // Publish what went out. Claude Code's UI shows the row you picked, not the tier
            // it resolved to, so the status line is the only place this is visible.
            // `claude -p` omits metadata on the first request of a session, so there is no
            // session id to file the decision under and it would be dropped. The conversation
            // key is stable for the same conversation and is already what `debug` prints, so
            // it is the identifier a user can pass to `jev-explain` for a print-mode run.
            if (fresh && !explaining) {
              writeDecision(statusKey, fresh);
            }
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${redactText(err.message)}`);
        }
      }

      const target = new URL(upstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      if (req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "")) {
        delete headers["accept-encoding"];
      }
      // Under JEV_DEBUG, ask for an uncompressed stream so the model the API reports can be
      // read back out of it. Not worth the bandwidth cost in normal operation.
      if (boolEnv("JEV_DEBUG")) delete headers["accept-encoding"];
      const send = (payload, retried = false) => {
        const upstream = transport.request(
          {
            hostname: target.hostname,
            port: target.port || undefined,
            path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
            method: req.method,
            headers,
          },
          (up) => {
            if (fableAttempt && !retried && FABLE_REFUSAL_STATUS.has(up.statusCode)) {
              const errorChunks = [];
              up.on("data", (chunk) => errorChunks.push(chunk));
              up.on("end", () => {
                const errorData = Buffer.concat(errorChunks);
                if (!isFableRefusal(errorData)) {
                  res.writeHead(up.statusCode, up.headers);
                  res.end(errorData);
                  recordOutcome({ responseBytes: errorData.length, httpStatus: up.statusCode ?? null });
                  return;
                }
                send(fallBackToOpus(), true);
              });
              return;
            }
            const isModels = req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");
            const isMessages = observesMessages;
            if (isModels) {
              const chunks = [];
              up.on("data", (chunk) => chunks.push(chunk));
              up.on("end", () => {
                const data = Buffer.concat(chunks);
                try {
                  for (const model of JSON.parse(data.toString()).data ?? []) {
                    if (configuredTierOf(model?.id)) catalog.set(model.id, model);
                  }
                } catch (err) {
                  debug(`could not read Claude model catalog: ${redactText(err.message)}`);
                }
                const headers = { ...up.headers };
                delete headers["content-length"];
                res.writeHead(up.statusCode, headers);
                res.end(data);
              });
              return;
            }
            res.writeHead(up.statusCode, up.headers);
            // Report the model the API itself says it used, so the routing can be confirmed
            // from the wire rather than trusted from our own decision log. Claude Code's UI
            // always shows the model it asked for, never the one we rewrote to.
            if (boolEnv("JEV_DEBUG")) {
              let seen = false;
              up.on("data", (c) => {
                if (seen) return;
                const m = /"model"\s*:\s*"([^"]+)"/.exec(c.toString("utf8"));
                if (!m) return;
                seen = true;
                debug(`${up.statusCode} served by ${m[1]}`);
              });
            }

            // Usage is read from a copy of the bytes, never from the bytes themselves: the
            // response is piped through untouched, so nothing here can change what Claude Code
            // receives, and an observer failure cannot interrupt the stream.
            const observer = recordsTelemetry
              ? createUsageObserver({
                  contentType: up.headers["content-type"] ?? "",
                  contentEncoding: up.headers["content-encoding"] ?? null,
                })
              : null;
            if (isMessages) {
              let responseBytes = 0;
              up.on("data", (chunk) => {
                responseBytes += chunk.length;
                if (!observer) return;
                try {
                  observer.write(chunk);
                } catch {
                  // Observation is best effort; forwarding continues regardless.
                }
              });
              // A response ends normally, is aborted mid-stream, or errors. Whichever happens,
              // the partial usage seen so far is recorded once, marked incomplete by the parser.
              let finished = false;
              const finishOnce = () => {
                if (finished) return;
                finished = true;
                recordOutcome({ observer, responseBytes, httpStatus: up.statusCode ?? null });
              };
              up.on("end", finishOnce);
              up.on("aborted", finishOnce);
              up.on("error", finishOnce);
              up.on("close", finishOnce);
            }
            // `pipe` only ends the downstream response on a clean `end`. If upstream drops the
            // connection mid-stream, the client would otherwise wait forever, so the truncation
            // is propagated instead of being papered over with a clean end that would look like
            // a complete response.
            const abort = () => {
              if (!res.writableEnded) res.destroy();
            };
            up.on("aborted", abort);
            up.on("error", (err) => {
              debug(`upstream stream ended early: ${redactText(err.message)}`);
              abort();
            });
            up.pipe(res);
          },
        );
        upstream.on("error", (e) => {
          debug(`upstream error: ${e.message}`);
          if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
          const errorBody = JSON.stringify({ type: "error", error: { message: e.message } });
          res.end(errorBody);
          recordOutcome({ responseBytes: Buffer.byteLength(errorBody), httpStatus: 502 });
        });
        if (payload.length) upstream.write(payload);
        upstream.end();
      };
      // The account cannot run Fable: retry this same request once on Opus, repin the actor
      // there, and stop offering Fable, so the user never sees a credit error for a tier they
      // did not pick themselves.
      const fallBackToOpus = () => {
        fableRefused = true;
        const { actor, fresh, statusKey, explaining } = fableAttempt;
        const opus = modelForTier(claudeModels([...catalog.values()]), "opus") ?? idOf("opus");
        debug(`fable refused upstream, retrying on ${opus}`);
        const note = "fable refused upstream; fell back to opus";
        if (actor.pinnedRoute) {
          actor.pinnedRoute = {
            ...actor.pinnedRoute,
            model: opus,
            legacyTier: "opus",
            normalizationNotes: [...(actor.pinnedRoute.normalizationNotes ?? []), note],
          };
        }
        if (fresh && !explaining) {
          writeDecision(statusKey, { ...fresh, tier: "opus", model: opus, reason: `${fresh.reason}+fable-refused` });
        }
        const body = JSON.parse(out.toString());
        body.model = opus;
        observed.model = opus;
        return Buffer.from(JSON.stringify(body));
      };
      send(out);
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  let closePromise = null;
  return {
    port: server.address().port,
    host,
    telemetry,
    close: ({ timeoutMs = 2000 } = {}) => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await new Promise((resolve) => {
          let done = false;
          let timer = null;
          let idleCloser = null;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearInterval(idleCloser);
            resolve();
          };
          timer = setTimeout(() => {
            server.closeAllConnections?.();
            finish();
          }, timeoutMs);
          timer.unref?.();
          server.close(finish);
          // A connection can become idle after close() begins. Reap it promptly so an HTTP
          // client's keep-alive pool does not consume the entire graceful-drain budget.
          server.closeIdleConnections?.();
          idleCloser = setInterval(() => server.closeIdleConnections?.(), 25);
          idleCloser.unref?.();
        });
        // Bounded internally: a stuck writer must not delay process exit indefinitely.
        await telemetry.close().catch(() => {});
      })();
      return closePromise;
    },
  };
}
