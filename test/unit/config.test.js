import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDeep, interpolateEnv, resolveConfig, resolveViewport, ConfigError, atLeast } from "../../src/config.js";
import { classifyTarget, branchSlug, applyUrlTemplate, resolveTargets } from "../../src/targets.js";
import { parseHeaders, overridesFrom } from "../../src/cli.js";

test("mergeDeep merges objects and replaces arrays", () => {
  const out = mergeDeep({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] } });
  assert.deepEqual(out, { a: { b: 1, c: [3] }, d: 1 });
});

test("interpolateEnv substitutes, defaults, escapes and fails loudly", () => {
  const env = { USER_NAME: "qa", EMPTY: "" };
  assert.equal(interpolateEnv("${USER_NAME}", env), "qa");
  assert.equal(interpolateEnv("${MISSING:-fallback}", env), "fallback");
  assert.equal(interpolateEnv("${MISSING:-}", env), "");
  assert.equal(interpolateEnv("$${USER_NAME}", env), "${USER_NAME}");
  assert.deepEqual(interpolateEnv({ a: ["x-${USER_NAME}"] }, env), { a: ["x-qa"] });
  assert.throws(() => interpolateEnv("${MISSING}", env), ConfigError);
  assert.throws(() => interpolateEnv("${EMPTY}", env), /EMPTY is not set/);
});

test("resolveConfig validates and fills defaults", () => {
  const cfg = resolveConfig({ crawl: { maxPages: 5 } }, { viewports: ["desktop", "390x700"] });
  assert.equal(cfg.crawl.maxPages, 5);
  assert.equal(cfg.crawl.maxDepth, 3);
  assert.equal(cfg.viewports[1].width, 390);
  assert.throws(() => resolveConfig({ report: { failOn: "sometimes" } }), /failOn/);
  assert.throws(() => resolveConfig({ explore: { depth: 9 } }), /explore.depth/);
  assert.throws(() => resolveConfig({ viewports: ["huge"] }), /Unknown viewport/);
  const warnings = [];
  resolveConfig({ crawll: {} }, {}, { warn: (m) => warnings.push(m) });
  assert.match(warnings[0], /crawll/);
});

test("viewports", () => {
  assert.equal(resolveViewport("mobile").isMobile, true);
  assert.deepEqual(resolveViewport({ name: "wide", width: 1920, height: 1080 }).name, "wide");
});

test("severity thresholds", () => {
  assert.ok(atLeast("critical", "major"));
  assert.ok(!atLeast("minor", "major"));
  assert.ok(!atLeast("critical", "never"));
});

test("classifyTarget tells URLs from branches", () => {
  assert.deepEqual(classifyTarget("https://uat.example.com"), { kind: "url", url: "https://uat.example.com" });
  assert.deepEqual(classifyTarget("uat.example.com/shop"), { kind: "url", url: "https://uat.example.com/shop" });
  assert.deepEqual(classifyTarget("localhost:3000"), { kind: "url", url: "http://localhost:3000" });
  assert.deepEqual(classifyTarget("main"), { kind: "branch", ref: "main" });
  assert.deepEqual(classifyTarget("feature/login-page"), { kind: "branch", ref: "feature/login-page" });
  assert.deepEqual(classifyTarget("v1.2.3"), { kind: "branch", ref: "v1.2.3" });
  assert.deepEqual(classifyTarget("branch:release.candidate"), { kind: "branch", ref: "release.candidate" });
  assert.deepEqual(classifyTarget("url:staging.internal"), { kind: "url", url: "https://staging.internal" });
});

test("branch URL templates", () => {
  assert.equal(branchSlug("Feature/Login_Page"), "feature-login-page");
  assert.equal(applyUrlTemplate("https://{branch}--shop.netlify.app", "feature/x"), "https://feature-x--shop.netlify.app");
  assert.equal(applyUrlTemplate("https://preview.example.com/?b={branch_raw}", "a/b"), "https://preview.example.com/?b=a%2Fb");
  assert.throws(() => applyUrlTemplate("https://example.com", "main"), /placeholder/);
});

test("CLI flags and environment become config overrides", () => {
  assert.deepEqual(parseHeaders("X-A: 1\nX-B: two", "X-C: 3;;X-D: 4"), { "X-A": "1", "X-B": "two", "X-C": "3", "X-D": "4" });
  assert.throws(() => parseHeaders("nonsense"), ConfigError);
  const o = overridesFrom(
    { header: ["X-Both: 1"], "baseline-header": ["X-Base: 2"], "max-pages": "7", "no-explore": true, viewports: "desktop,mobile", "fail-on": "major" },
    ["https://a.example.com", "feature/x"],
    { ENVDIFF_CANDIDATE_AUTH: "user:p:ss" },
  );
  assert.equal(o.baseline.url, "https://a.example.com");
  assert.equal(o.candidate.ref, "feature/x");
  assert.deepEqual(o.baseline.headers, { "X-Both": "1", "X-Base": "2" });
  assert.deepEqual(o.candidate.headers, { "X-Both": "1" });
  assert.deepEqual(o.candidate.httpCredentials, { username: "user", password: "p:ss" });
  assert.equal(o.crawl.maxPages, 7);
  assert.equal(o.explore.enabled, false);
  assert.deepEqual(o.viewports, ["desktop", "mobile"]);
  assert.equal(o.report.failOn, "major");
  assert.equal(o.ai, undefined, "empty sections are dropped so they don't override the file config");
});

test("an environment's name with no address says which variable to set", async () => {
  const log = { info() {}, warn() {}, debug() {} };
  /** @param {string} ref */
  const run = (ref) => resolveTargets(/** @type {any} */ ({ baseline: { ref }, candidate: { url: "https://uat.example.com" }, branches: {} }), { log: /** @type {any} */ (log), outDir: "." });
  await assert.rejects(run("prod"), /No address for the environment "prod": set ENVDIFF_PROD_URL=/);
  await assert.rejects(run("feature/login"), /looks like a branch name/);
});
