import { createHash } from "node:crypto";

export const CLAUDE_ADAPTER_VERSION = "messages-v2/2026-09-22";

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

/**
 * Claude Code prefixes its system prompt with a billing header of `key=value;` pairs, e.g.
 * `x-anthropic-billing-header: cc_version=2.1.278.d48; cc_entrypoint=claude-vscode;
 * cc_is_subagent=true;`. Captured from Claude Code 2.1.278 on 2026-09-22.
 *
 * This is the only place real Claude Code states what kind of actor is calling: the
 * `metadata.user_id` envelope carries session_id, device_id and account_uuid, and no actor
 * fields at all. Only the header prefix is read, never the prompt that follows it, and only
 * the three keys below are kept.
 *
 * It is an internal field and may disappear. If it does, `actorType` goes back to null and
 * subagents stop being routed independently — the behaviour before this was known. Nothing
 * breaks; routing simply narrows.
 */
export function billingHeaderOf(body) {
  const system = body?.system;
  const text =
    typeof system === "string"
      ? system
      : Array.isArray(system)
        ? system.map((block) => (typeof block?.text === "string" ? block.text : "")).join(" ")
        : "";
  const match = /x-anthropic-billing-header:\s*((?:[a-z0-9_]+=[^;]*;\s*)+)/i.exec(text);
  if (!match) return {};
  const fields = {};
  for (const pair of match[1].split(";")) {
    const [key, ...rest] = pair.split("=");
    const name = key.trim();
    if (name && rest.length) fields[name] = rest.join("=").trim();
  }
  return fields;
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
  const billing = billingHeaderOf(body);
  // The envelope wins when it carries an explicit type; the billing header is the fallback,
  // and on current Claude Code it is the only source. `cc_is_subagent` is only ever read as
  // a positive assertion: its absence means "not declared", not "this is the main agent",
  // which matters because auxiliary calls also lack it.
  const declaredSubagent = billing.cc_is_subagent === "true";
  const actorType =
    stringField(metadata, ["actor_type", "agent_type"]) ?? (declaredSubagent ? "subagent" : null);
  return {
    sessionId: stringField(metadata, ["session_id"]),
    actorId: stringField(metadata, ["actor_id", "agent_id"]),
    parentActorId: stringField(metadata, ["parent_actor_id", "parent_agent_id"]),
    actorType: actorType === "main" || actorType === "subagent" ? actorType : null,
    logicalTurnId: stringField(metadata, ["logical_turn_id", "turn_id"]),
    requestId: stringField(metadata, ["request_id"]),
    agentName: stringField(metadata, ["agent_name", "subagent_type"]),
    modelSource: stringField(metadata, ["model_source"]),
    declaredSubagent,
    clientVersion: typeof billing.cc_version === "string" ? billing.cc_version : null,
    clientEntrypoint: typeof billing.cc_entrypoint === "string" ? billing.cc_entrypoint : null,
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
  // Claude Code appends its system prompt as a trailing `role: "system"` message, after
  // the user's text, so the literal last element is not the conversational tail. Captured
  // live from Claude Code 2.1.278 on 2026-09-22: a genuine fresh turn arrived as
  // [user, system], which the previous "last message must be user" rule read as an
  // unrecognized boundary — so every real turn failed open and nothing was ever routed.
  // Every synthetic fixture put the user message last, which is why no test caught it.
  let tail = messages.length - 1;
  while (tail >= 0 && messages[tail]?.role === "system") tail -= 1;
  const last = messages[tail];
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
