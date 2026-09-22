/**
 * Explicit boolean parsing for env flags. `Boolean(process.env.X)` treats "0" as truthy,
 * which silently defeats an opt-out; only "1" and "true" (case-insensitive) turn a flag on.
 */
export function boolEnv(name, env = process.env) {
  const value = env[name];
  if (value == null) return false;
  return value === "1" || value.toLowerCase() === "true";
}
