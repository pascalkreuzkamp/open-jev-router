export const REDACTED = "[redacted]";

/**
 * Key names that never get serialized, wherever they appear: header objects, nested
 * diagnostic payloads, and provider error bodies all use some spelling of these.
 */
const SENSITIVE_KEY_RE =
  /^(?:x-)?(?:api[-_]?key|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|token|secret|password|bearer|client[-_]?secret)$/i;

/** Deep-redacts any object/array whose keys match a known secret shape. Strings pass through. */
export function redact(node) {
  if (Array.isArray(node)) return node.map(redact);
  if (!node || typeof node !== "object") return node;
  const copy = {};
  for (const [key, value] of Object.entries(node)) {
    copy[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redact(value);
  }
  return copy;
}

/**
 * Best-effort scrub of secret-shaped tokens embedded in free text, such as a pasted API key
 * inside a prompt preview. Structural redaction via `redact` cannot catch these because they
 * are not held under a recognizable key.
 */
const INLINE_SECRET_RE =
  /\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|xox[abps])-[A-Za-z0-9_-]{10,}\b|\bBearer\s+[A-Za-z0-9._-]{10,}\b|\b[A-Za-z0-9_-]{32,}\b/g;

export function redactText(text) {
  if (typeof text !== "string") return text;
  return text.replace(INLINE_SECRET_RE, REDACTED);
}

const CONTENT_KEYS = new Set(["content", "text", "system", "instructions"]);

/**
 * Replaces message/prompt text with a length-preserving placeholder so a wire-format dump
 * stays useful for diagnosing structural changes without carrying prompt content.
 */
export function omitContent(node) {
  if (Array.isArray(node)) return node.map(omitContent);
  if (!node || typeof node !== "object") return node;
  const copy = {};
  for (const [key, value] of Object.entries(node)) {
    if (CONTENT_KEYS.has(key) && typeof value === "string") {
      copy[key] = `[content omitted; ${value.length} chars]`;
    } else {
      copy[key] = omitContent(value);
    }
  }
  return copy;
}
