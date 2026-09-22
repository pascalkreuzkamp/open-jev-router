import { homedir } from "node:os";
import { join } from "node:path";

/** Load the same credential files, in the same precedence order, for every entrypoint. */
export function loadCredentialFiles({
  cwd = process.cwd(),
  home = homedir(),
  load = (file) => process.loadEnvFile(file),
} = {}) {
  const loaded = [];
  for (const file of [
    join(cwd, ".env"),
    join(home, ".jev-router.env"),
    join(home, ".jev-claude.env"),
  ]) {
    try {
      load(file);
      loaded.push(file);
    } catch {
      // Missing or unreadable; credentials may still come from the real environment.
    }
  }
  return loaded;
}
