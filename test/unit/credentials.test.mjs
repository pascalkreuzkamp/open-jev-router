import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadCredentialFiles } from "../../src/credentials.mjs";

test("all entrypoints share project, user, then legacy credential-file precedence", () => {
  const seen = [];
  const loaded = loadCredentialFiles({
    cwd: join("", "project"),
    home: join("", "home"),
    load: (file) => seen.push(file),
  });

  assert.deepEqual(seen, [
    join("project", ".env"),
    join("home", ".jev-router.env"),
    join("home", ".jev-claude.env"),
  ]);
  assert.deepEqual(loaded, seen);
});

test("a missing credential file does not prevent later locations from loading", () => {
  const seen = [];
  const loaded = loadCredentialFiles({
    cwd: "project",
    home: "home",
    load: (file) => {
      seen.push(file);
      if (file === join("project", ".env")) throw new Error("missing");
    },
  });

  assert.equal(seen.length, 3);
  assert.deepEqual(loaded, [join("home", ".jev-router.env"), join("home", ".jev-claude.env")]);
});
