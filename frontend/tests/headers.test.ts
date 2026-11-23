// Security headers Netlify sends for the site (public/_headers). Checks the policy that blocks
// clickjacking, MIME sniffing and script injection, and that it allows everything the app loads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const file = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
const headers = new Map(
  file
    .split("\n")
    .filter((l) => /^\s+\S/.test(l) && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()] as const;
    }),
);
const cspHeader = headers.get("content-security-policy") ?? "";

test("the CSP is enforced, not report-only", () => {
  assert.ok(cspHeader, "Content-Security-Policy is set");
  assert.ok(!headers.has("content-security-policy-report-only"));
});
const csp = new Map(
  cspHeader
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .filter((p) => p[0])
    .map(([name, ...values]) => [name, values] as const),
);

test("the rules apply to every path", () => {
  assert.match(file, /^\/\*$/m);
});

test("the site can't be framed (clickjacking) or MIME-sniffed", () => {
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(csp.get("frame-ancestors"), ["'none'"]);
});

test("the CSP blocks injected scripts: no inline script, no eval, no plugins, no base-tag hijack", () => {
  const script = csp.get("script-src") ?? csp.get("default-src") ?? [];
  assert.ok(script.length, "script-src is set");
  assert.ok(!script.includes("'unsafe-inline'"), "inline scripts and on* handlers stay blocked");
  assert.ok(!script.includes("'unsafe-eval'"), "eval stays blocked");
  assert.ok(!script.includes("*") && !script.includes("https:") && !script.includes("data:"), "no wildcard script hosts");
  assert.deepEqual(csp.get("object-src"), ["'none'"]);
  assert.deepEqual(csp.get("base-uri"), ["'self'"]);
});

test("the CSP allows what the app needs: backend, voice, markets data, fonts, audio worklets", () => {
  const connect = csp.get("connect-src") ?? [];
  for (const host of [
    "https://allowance-backend-production.up.railway.app",
    "https://*.elevenlabs.io",
    "wss://*.elevenlabs.io",
    "https://gamma-api.polymarket.com",
    "https://api.coingecko.com",
  ]) {
    assert.ok(connect.includes(host), `connect-src allows ${host}`);
  }
  assert.ok(csp.get("script-src")?.includes("blob:"), "ElevenLabs worklets load from blob: URLs");
  assert.ok(csp.get("style-src")?.includes("https://fonts.googleapis.com"));
  assert.ok(csp.get("font-src")?.includes("https://fonts.gstatic.com"));
});

test("the microphone is allowed for this site only, and nothing else sensitive", () => {
  const pp = headers.get("permissions-policy") ?? "";
  assert.match(pp, /microphone=\(self\)/);
  assert.match(pp, /camera=\(\)/);
  assert.match(pp, /geolocation=\(\)/);
});

test("the backend URL in the CSP matches the app's default API URL", () => {
  const config = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  const apiUrl = config.match(/"(https:\/\/[^"]+railway\.app)"/)?.[1];
  assert.ok(apiUrl && csp.get("connect-src")?.includes(apiUrl), `connect-src has ${apiUrl}`);
});
