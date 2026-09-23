import test from "node:test";
import assert from "node:assert/strict";
import {
  SECURITY_HEADERS,
  hostnameOf,
  isAllowedOrigin,
  isLoopbackHost,
} from "../../../src/dashboard/server.mjs";

test("only loopback Host headers are accepted, on any port", () => {
  for (const host of ["127.0.0.1", "127.0.0.1:8080", "localhost:1", "LOCALHOST", "[::1]", "[::1]:4000"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of [
    undefined,
    "",
    "example.com",
    "127.0.0.1.evil.test",
    "localhost.evil.test:80",
    "10.0.0.1:80",
    "0.0.0.0",
    "[::1]evil",
    "[::2]:80",
    "127.0.0.2",
    "localhost:abc",
  ]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
  assert.equal(hostnameOf("[::1]:80"), "[::1]");
});

test("an Origin must be absent or loopback http", () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:3000"), true);
  assert.equal(isAllowedOrigin("http://localhost"), true);
  assert.equal(isAllowedOrigin("http://[::1]:9"), true);
  for (const origin of ["null", "https://evil.test", "http://evil.test", "file://", "http://127.0.0.1.evil.test", "https://127.0.0.1"]) {
    assert.equal(isAllowedOrigin(origin), false, origin);
  }
});

test("security headers lock the page to its own origin", () => {
  const csp = SECURITY_HEADERS["Content-Security-Policy"];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-/);
  assert.equal(SECURITY_HEADERS["X-Frame-Options"], "DENY");
  assert.equal(SECURITY_HEADERS["Cache-Control"], "no-store");
  assert.ok(!Object.keys(SECURITY_HEADERS).some((key) => /^access-control-/i.test(key)));
});
