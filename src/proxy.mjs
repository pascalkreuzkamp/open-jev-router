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
import { writeDecision, writeStatus } from "./status.mjs";
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
  actorRegistry = new ActorRegistry(),
} = {}) {
  const catalog = new Map();

  const server = http.createServer((req, res) => {
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);

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
          const key = detection.actorKey ?? statusKey;
          dumpRequest(statusKey, body);
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));

          if (classification === "manual_passthrough") {
            debug(`passthrough, user selected ${body.model}`);
            if (detection.actor) {
              writeStatus(sessionOf(body), { manual: true, at: Date.now() });
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
                availableTiers().includes(model.tier),
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
            for (const field of Object.keys(body)) delete body[field];
            Object.assign(body, transformed.body);
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
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (up) => {
          const isModels = req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");
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
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        debug(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
