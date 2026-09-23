// The page renders stored telemetry text, so the only safe sink is textContent. This scan fails
// the build if any markup-parsing or code-evaluating API reaches the shipped dashboard scripts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const DIR = new URL("../../../src/dashboard/public/", import.meta.url);
const BANNED = [
  /\binnerHTML\b/,
  /\bouterHTML\b/,
  /\binsertAdjacentHTML\b/,
  /\bdocument\.write/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bFunction\s*\(/,
  /setAttribute\(\s*["']style["']/,
  /setAttribute\(\s*["']on/i,
  /\bcreateContextualFragment\b/,
  /\bDOMParser\b/,
  /setTimeout\(\s*["'`]/,
  /\bsrcdoc\b/,
  /https?:\/\/(?!127\.0\.0\.1)/,
];

const scripts = readdirSync(DIR).filter((name) => name.endsWith(".js"));

test("dashboard scripts exist", () => {
  assert.deepEqual(scripts.sort(), ["app.js", "format.js"]);
});

for (const name of scripts) {
  test(`${name} uses no banned DOM or evaluation API`, () => {
    const source = readFileSync(new URL(name, DIR), "utf8");
    for (const pattern of BANNED) assert.doesNotMatch(source, pattern, `${name} matches ${pattern}`);
  });
}

test("index.html has no inline script, style or event handler", () => {
  const html = readFileSync(new URL("index.html", DIR), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /<style/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /https?:\/\//);
});
