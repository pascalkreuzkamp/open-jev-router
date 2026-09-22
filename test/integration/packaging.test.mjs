// What `npm publish` would actually ship. Git exclusions do not govern package contents, so
// the private handbook, the source specification and the development notes have to be proven
// absent from the tarball separately (spec §16; phase step 5). Also asserts that everything
// the installed CLIs need at runtime is present, since a missing skill or bin file only shows
// up after a user installs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

// One `npm pack` run shared by every case below; it is the slowest thing in the suite.
const packed = (() => {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(raw)[0];
})();
const files = packed.files.map((entry) => entry.path);

test("no private planning or specification file is published", () => {
  const forbidden = files.filter((path) =>
    /(^|\/)\.dev\//.test(path) ||
    /(^|\/)(CLAUDE|AGENTS)\.md$/.test(path) ||
    /jev_claude_code_router_fork_spec\.md$/.test(path) ||
    /(^|\/)\.env/.test(path),
  );
  assert.deepEqual(forbidden, [], `private paths in the package: ${forbidden.join(", ")}`);
});

test("no test, fixture or CI file is published", () => {
  const extra = files.filter((path) => /^(test|\.github|docs)\//.test(path));
  assert.deepEqual(extra, [], `development-only paths in the package: ${extra.join(", ")}`);
});

test("every declared bin entrypoint is in the package", () => {
  for (const [name, path] of Object.entries(manifest.bin)) {
    assert.ok(files.includes(path), `${name} -> ${path} is missing from the package`);
  }
});

test("every module the entrypoints import at runtime is in the package", () => {
  // `src/` is declared wholesale, so the check that matters is that the declaration held.
  const sources = files.filter((path) => path.startsWith("src/"));
  assert.ok(sources.length > 20, `only ${sources.length} source files were packed`);
  for (const required of [
    "src/proxy.mjs",
    "src/codex-proxy.mjs",
    "src/router.mjs",
    "src/policy.mjs",
    "src/status.mjs",
    "src/explain.mjs",
    "src/telemetry/worker.mjs",
    "src/ui/reports.mjs",
  ]) {
    assert.ok(files.includes(required), `${required} is missing from the package`);
  }
});

test("the runtime skill data both CLIs load is in the package", () => {
  assert.ok(files.includes(".claude/skills/jev-explain/SKILL.md"), "the Claude skill is missing");
  assert.ok(files.includes("skills/codex/jev-explain/SKILL.md"), "the Codex skill is missing");
});

test("the published README is the user documentation, not a stub", () => {
  assert.ok(files.includes("README.md"));
  const entry = packed.files.find((file) => file.path === "README.md");
  assert.ok(entry.size > 4000, `README.md is only ${entry.size} bytes`);
});

test("the package declares the supported runtime and its optional native dependency", () => {
  assert.equal(manifest.engines.node, ">=20.12");
  assert.ok(
    manifest.optionalDependencies?.["better-sqlite3"],
    "telemetry's driver must stay optional so an install without it still works",
  );
});

test("a bin invoked through a symlink still runs, as npm installs it", () => {
  // npm links every bin into node_modules/.bin rather than copying it, so a CLI that decides
  // whether it was run directly by comparing argv[1] to its own module URL sees two different
  // paths and does nothing. This once shipped: `jev` exited 0 with no output once installed.
  const workspace = mkdtempSync(join(tmpdir(), "jev-binlink-"));
  const link = join(workspace, "jev");
  symlinkSync(fileURLToPath(new URL("../../bin/jev.mjs", import.meta.url)), link);

  const out = execFileSync(process.execPath, [link, "--help"], { encoding: "utf8" });

  assert.match(out, /jev stats/);
  assert.match(out, /jev routes/);
});
