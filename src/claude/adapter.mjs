import { createHash } from "node:crypto";

export const CLAUDE_ADAPTER_VERSION = "messages-v1/2026-09-22";

const SUGGESTION_PREFIX = /^\s*\[SUGGESTION MODE:/i;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function cleanPrompt(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

export function metadataOf(body) {
  const raw = body?.metadata?.user_id;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function sessionIdOf(body) {
  const value = metadataOf(body).session_id;
  return typeof value === "string" ? value : "";
}

function stringField(object, names) {
  for (const name of names) {
    if (typeof object?.[name] === "string" && object[name]) return object[name];
  }
  return null;
}

/**
 * Read only explicit correlation fields. Claude Code currently documents `session_id` in
 * this envelope, but not actor fields; the aliases below are adapter inputs for captured
 * versions that expose them and for synthetic compatibility fixtures. Their presence is
 * evidence. Their absence is never filled in from task text.
 */
export function correlationOf(body) {
  const metadata = metadataOf(body);
  const actorType = stringField(metadata, ["actor_type", "agent_type"]);
  return {
    sessionId: stringField(metadata, ["session_id"]),
    actorId: stringField(metadata, ["actor_id", "agent_id"]),
    parentActorId: stringField(metadata, ["parent_actor_id", "parent_agent_id"]),
    actorType: actorType === "main" || actorType === "subagent" ? actorType : null,
    logicalTurnId: stringField(metadata, ["logical_turn_id", "turn_id"]),
    requestId: stringField(metadata, ["request_id"]),
    agentName: stringField(metadata, ["agent_name", "subagent_type"]),
    modelSource: stringField(metadata, ["model_source"]),
  };
}

export function inspectClaudeRequest(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    return {
      adapterVersion: CLAUDE_ADAPTER_VERSION,
      shape: "unknown",
      prompt: null,
      firstMessageFingerprint: null,
      correlation: correlationOf(body),
      evidence: ["messages array missing"],
    };
  }

  const messages = body.messages;
  const firstText = cleanPrompt(textOf(messages[0]?.content));
  const firstMessageFingerprint = firstText
    ? createHash("sha256").update(firstText).digest("hex")
    : null;
  const last = messages.at(-1);
  const lastBlocks = Array.isArray(last?.content) ? last.content : [];
  const prompt = last?.role === "user" ? cleanPrompt(textOf(last.content)) || null : null;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const suggestion = SUGGESTION_PREFIX.test(prompt ?? firstText);

  let shape = "unknown";
  const evidence = [];
  if (suggestion || !hasTools) {
    shape = "auxiliary";
    evidence.push(suggestion ? "suggestion-mode prefix" : "no tools");
  } else if (last?.role === "user" && lastBlocks.some((block) => block?.type === "tool_result")) {
    shape = "continuation";
    evidence.push("last user message contains tool_result");
  } else if (last?.role === "user" && prompt) {
    shape = "fresh";
    evidence.push("tools present", "last message is user text");
  } else {
    evidence.push("unrecognized message boundary");
  }

  return {
    adapterVersion: CLAUDE_ADAPTER_VERSION,
    shape,
    prompt,
    firstMessageFingerprint,
    correlation: correlationOf(body),
    evidence,
  };
}
