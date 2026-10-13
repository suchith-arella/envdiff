import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, ConfigError } from "../../src/config.js";
import { knownEnvironments, maskUsername, envKey } from "../../src/environments.js";
import { classifyTarget } from "../../src/targets.js";
import { overridesFrom } from "../../src/cli.js";
import { totp } from "../../src/login.js";

const URLS = { ENVDIFF_PROD_URL: "https://www.example.com", ENVDIFF_UAT_URL: "https://uat.example.com" };

test("environment names come from the config and from ENVDIFF_<ENV>_URL", () => {
  const names = knownEnvironments({ Dev: { url: "https://dev.example.com" } }, { ...URLS, ENVDIFF_BASELINE_URL: "x", ENVDIFF_QA_EU_URL: "y", ENVDIFF_EMPTY_URL: "" });
  assert.deepEqual([...names].sort(), ["dev", "prod", "qa_eu", "uat"]);
  assert.deepEqual(classifyTarget("uat", names), { kind: "env", name: "uat" });
  assert.deepEqual(classifyTarget("UAT", names), { kind: "env", name: "UAT" });
  assert.deepEqual(classifyTarget("feature/uat", names), { kind: "branch", ref: "feature/uat" });
  assert.deepEqual(classifyTarget("env:stage", names), { kind: "env", name: "stage" });
  assert.deepEqual(classifyTarget("uat.example.com", names), { kind: "url", url: "https://uat.example.com" });
});

test("the command line picks environments by name and a user for both", () => {
  const o = overridesFrom({ user: "admin" }, ["prod", "uat"], URLS);
  assert.deepEqual(o.baseline, { env: "prod" });
  assert.deepEqual(o.candidate, { env: "uat" });
  assert.equal(o.user, "admin");
});

test("a named environment gets its address and default user from variables", () => {
  const env = { ...URLS, ENVDIFF_UAT_USERNAME: "qa.lead@example.com", ENVDIFF_UAT_PASSWORD: "pw-uat", ENVDIFF_PROD_USERNAME: "qa.lead@example.com", ENVDIFF_PROD_PASSWORD: "pw-prod" };
  const cfg = resolveConfig({}, { baseline: { env: "prod" }, candidate: { env: "uat" } }, { env });
  assert.equal(cfg.baseline.url, "https://www.example.com");
  assert.equal(cfg.baseline.label, "prod");
  assert.equal(cfg.candidate.auth?.password, "pw-uat");
  assert.equal(cfg.baseline.auth?.password, "pw-prod");
  assert.deepEqual(cfg.candidate.login, { user: "default", username: "q…d@example.com", source: "ENVDIFF_UAT_*", totpVar: "ENVDIFF_UAT_TOTP" });
});

test("--user picks ENVDIFF_<ENV>_<USER>_*, and says which variables are missing", () => {
  const env = {
    ...URLS,
    ENVDIFF_UAT_USERNAME: "qa@example.com",
    ENVDIFF_UAT_PASSWORD: "pw",
    ENVDIFF_UAT_QA_ADMIN_USERNAME: "admin@example.com",
    ENVDIFF_UAT_QA_ADMIN_PASSWORD: "pw-admin",
    ENVDIFF_UAT_QA_ADMIN_TOTP: "JBSWY3DPEHPK3PXP",
  };
  const cfg = resolveConfig({}, { user: "qa-admin", baseline: { env: "uat" }, candidate: { env: "uat", url: "https://uat2.example.com" } }, { env });
  assert.equal(cfg.baseline.auth?.username, "admin@example.com");
  assert.equal(cfg.baseline.auth?.totp, "JBSWY3DPEHPK3PXP");
  assert.equal(cfg.baseline.login?.user, "qa-admin");
  assert.equal(cfg.candidate.url, "https://uat2.example.com", "an explicit address wins over the variable");
  assert.throws(
    () => resolveConfig({}, { user: "viewer", baseline: { env: "prod" }, candidate: { env: "uat" } }, { env }),
    (e) => e instanceof ConfigError && /ENVDIFF_PROD_VIEWER_USERNAME and ENVDIFF_PROD_VIEWER_PASSWORD/.test(e.message),
  );
  assert.throws(() => resolveConfig({}, { baseline: { env: "prod" }, candidate: { env: "uat" } }, { env: { ...env, ENVDIFF_PROD_USERNAME: "a@b.c" } }), /ENVDIFF_PROD_USERNAME is set but ENVDIFF_PROD_PASSWORD is not/);
  assert.throws(() => resolveConfig({}, { baseline: { env: "stage" }, candidate: { env: "uat" } }, { env }), /set ENVDIFF_STAGE_URL/);
});

test("per-side variables override the environment's, and user none skips the login", () => {
  const env = { ...URLS, ENVDIFF_UAT_USERNAME: "qa@example.com", ENVDIFF_UAT_PASSWORD: "pw", ENVDIFF_CANDIDATE_USERNAME: "ci@example.com", ENVDIFF_CANDIDATE_PASSWORD: "pw-ci" };
  const cfg = resolveConfig({}, { baseline: { env: "prod" }, candidate: { env: "uat" } }, { env, warn: () => {} });
  assert.equal(cfg.candidate.auth?.username, "ci@example.com");
  assert.equal(cfg.baseline.auth, undefined, "prod has no login");
  /** @type {string[]} */
  const warnings = [];
  resolveConfig({}, { baseline: { env: "prod" }, candidate: { env: "uat" } }, { env, warn: (m) => warnings.push(m) });
  assert.match(warnings.join("\n"), /Logging in to the candidate \(uat\) but not to the baseline \(prod\)/);
  const none = resolveConfig({}, { user: "none", baseline: { env: "prod" }, candidate: { env: "uat" } }, { env });
  assert.equal(none.candidate.auth, undefined);
  assert.equal(none.candidate.login, null);
});

test("credentials can live in the config, for steps or the automatic login", () => {
  const cfg = resolveConfig(
    {
      environments: { uat: { url: "https://uat.example.com", users: { admin: { username: "admin@example.com", password: "pw" } } } },
      auth: { loginUrl: "/#/login" },
    },
    { user: "admin", baseline: { env: "uat" }, candidate: { env: "uat" } },
    { env: {} },
  );
  assert.equal(cfg.baseline.auth?.loginUrl, "/#/login");
  assert.equal(cfg.baseline.auth?.username, "admin@example.com");
  assert.throws(() => resolveConfig({ auth: { loginUrl: "/login" } }, { baseline: { url: "https://a.example.com" }, candidate: { url: "https://b.example.com" } }, { env: {} }), /no credentials were given/);
});

test("usernames are masked for reports; names become variable names", () => {
  assert.equal(maskUsername("qa.lead@example.com"), "q…d@example.com");
  assert.equal(maskUsername("qa@example.com"), "q…@example.com");
  assert.equal(maskUsername("svc_reporting"), "s…g");
  assert.equal(envKey("qa-admin"), "QA_ADMIN");
  assert.equal(envKey(" UAT.eu "), "UAT_EU");
});

test("one-time codes match RFC 6238", () => {
  // The RFC's SHA-1 key "12345678901234567890", in base32.
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totp(secret, { time: 59_000, digits: 8 }), "94287082");
  assert.equal(totp(secret, { time: 1_111_111_109_000, digits: 8 }), "07081804");
  assert.equal(totp(secret, { time: 1_234_567_890_000 }), "005924");
  assert.equal(totp(`otpauth://totp/Example:qa?secret=${secret}&issuer=Example`, { time: 59_000 }), "287082");
  assert.throws(() => totp("not base32!"), /not base32/);
});
