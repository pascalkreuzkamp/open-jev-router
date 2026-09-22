import { isAuto } from "../config.mjs";

export const REQUEST_CLASSIFICATIONS = [
  "main_fresh",
  "main_continuation",
  "subagent_fresh",
  "subagent_continuation",
  "auxiliary",
  "manual_passthrough",
  "unknown",
];

export const auxiliaryPolicy = (env = process.env) =>
  ["passthrough", "inherit", "fast"].includes(env.JEV_AUXILIARY_POLICY)
    ? env.JEV_AUXILIARY_POLICY
    : "passthrough";

export const subagentModelPolicy = (env = process.env) =>
  ["route", "respect-explicit", "inherit"].includes(env.JEV_SUBAGENT_MODEL_POLICY)
    ? env.JEV_SUBAGENT_MODEL_POLICY
    : "route";

export function mayRouteSubagent(body, request, policy = subagentModelPolicy()) {
  if (isAuto(body?.model)) return true;
  const source = request.correlation.modelSource;
  if (source === "user" || source === "hard-lock") return false;
  if (policy === "respect-explicit") return false;
  return source === "default" || source === "built-in";
}

export function classifyClaudeRequest(body, request, detection, env = process.env) {
  if (request.shape === "auxiliary") return "auxiliary";
  if (request.shape === "unknown") return "unknown";

  const subagentPolicy = subagentModelPolicy(env);
  const routable =
    detection.actorType === "subagent"
      ? mayRouteSubagent(body, request, subagentPolicy)
      : isAuto(body?.model);
  if (!routable) return "manual_passthrough";
  if (detection.actorType === "unknown") return "unknown";
  return `${detection.actorType}_${request.shape}`;
}
