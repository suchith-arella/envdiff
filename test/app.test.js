/**
 * End to end against "Insights", the fixture analytics app: a login, AG Grid
 * grids, charts and a filter-then-apply report. Every planted regression must
 * be found; the same app holding different data (UAT against production) must
 * produce a clean report.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApp, USERS } from "./fixtures/app/server.js";
import { compare } from "../src/index.js";
import { autoLogin } from "../src/login.js";
import { parseJourneyScript } from "../src/plain.js";
import { runPlainStep } from "../src/smart.js";
import { planStep } from "../src/ai/planner.js";
import { deriveScopes } from "../src/urls.js";
import { createLogger } from "../src/util/log.js";

/** @type {Awaited<ReturnType<typeof startApp>>[]} */
const apps = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "envdiff-app-"));
const log = createLogger({ level: process.env.ENVDIFF_TEST_VERBOSE ? "info" : "silent" });
const QA = "qa@example.com";

before(async () => {
  apps.push(
    await startApp({ variant: "baseline", dataSeed: 1 }),
    await startApp({ variant: "candidate", dataSeed: 2 }),
    // The same build again with its own data, and sessions that end after a few seconds.
    await startApp({ variant: "baseline", dataSeed: 3, sessionTtlMs: 20_000 }),
  );
});
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
  if (!process.env.ENVDIFF_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
});

/** Credentials as CI passes them: one set of variables per environment. */
const envFor = (/** @type {Record<string, string>} */ urls) => {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [name, url] of Object.entries(urls)) {
    const K = name.toUpperCase();
    env[`ENVDIFF_${K}_URL`] = url;
    env[`ENVDIFF_${K}_USERNAME`] = QA;
    env[`ENVDIFF_${K}_PASSWORD`] = USERS[QA].password;
    env[`ENVDIFF_${K}_ADMIN_USERNAME`] = "admin@example.com";
    env[`ENVDIFF_${K}_ADMIN_PASSWORD`] = USERS["admin@example.com"].password;
  }
  return env;
};

test("logs in and finds every planted regression in grids, charts and filters", { timeout: 600_000 }, async () => {
  const env = envFor({ prod: apps[0].url, uat: apps[1].url });
  const { report, exitCode } = await compare(
    { baseline: { env: "prod" }, candidate: { env: "uat" }, crawl: { maxPages: 8 }, report: { outDir: path.join(tmp, "regressions") } },
    { log, env },
  );
  const found = new Set(report.findings.map((/** @type {any} */ f) => `${f.page} ${f.type}`));
  const expected = [
    "/#/orders interaction.no-effect", // the Customer column no longer sorts
    "/#/orders grid.column-missing", // Region column gone
    "/#/orders grid.format", // amounts lost their currency format
    "/#/dashboard chart.series-missing", // the Target series is gone
    "/#/dashboard chart.tooltip", // the tooltip lost its currency format
    "/#/reports network.failed", // "Last 30 days" → Apply: the report call fails
    "/#/reports interaction.error-text", // …and the page says so
  ];
  const missing = expected.filter((e) => !found.has(e));
  assert.deepEqual(missing, [], `not found:\n${missing.join("\n")}\n\nfound:\n${[...found].sort().join("\n")}`);
  // Different data on each side is not a difference: no text, value or pixel findings from it.
  const unexpected = report.findings.filter((/** @type {any} */ f) => f.severity !== "info" && !expected.includes(`${f.page} ${f.type}`));
  assert.deepEqual(unexpected.map((/** @type {any} */ f) => `${f.page} ${f.type}: ${f.title}`), []);
  assert.equal(exitCode, 1);
  assert.deepEqual(report.meta.candidate.login, { user: "default", username: "q…@example.com" });
  // Logged in: the login page isn't compared, and the landing page is.
  const keys = report.pages.map((/** @type {any} */ p) => p.key);
  assert.ok(keys.includes("/#/dashboard"), keys.join(", "));
  assert.ok(!keys.includes("/#/login"), keys.join(", "));
  // Grid rows are sampled, not all clicked; chart points are hovered.
  const orders = report.pages.find((/** @type {any} */ p) => p.key === "/#/orders");
  const rowClicks = orders.interactions.filter((/** @type {any} */ i) => /^row /.test(i.path[0]));
  assert.ok(rowClicks.length <= 2, rowClicks.map((/** @type {any} */ i) => i.path[0]).join("\n"));
  const dashboard = report.pages.find((/** @type {any} */ p) => p.key === "/#/dashboard");
  const hover = dashboard.interactions.find((/** @type {any} */ i) => i.action === "hover");
  assert.match(hover.baseline, /Revenue: \$[\d,]+/);
  assert.ok(hover.screenshots.baseline && hover.screenshots.candidate, "the differing tooltip is photographed");
  // Each regression is reported once, not again for "/" (which opens the dashboard).
  assert.equal(report.findings.filter((/** @type {any} */ f) => f.type === "chart.series-missing").length, 1);
  // No password, and no unmasked username, anywhere in the report.
  const json = fs.readFileSync(path.join(tmp, "regressions", "report.json"), "utf8");
  assert.ok(!json.includes(USERS[QA].password) && !json.includes(QA));
});

test("the same app holding different data, with sessions that expire, is a clean report", { timeout: 600_000 }, async () => {
  const env = envFor({ prod: apps[0].url, uat: apps[2].url });
  const before = apps[2].app.logins[QA] ?? 0;
  const { report, exitCode } = await compare(
    { baseline: { env: "prod" }, candidate: { env: "uat" }, crawl: { maxPages: 6 }, report: { outDir: path.join(tmp, "identical") } },
    { log, env },
  );
  const noise = report.findings.filter((/** @type {any} */ f) => f.severity !== "info");
  assert.deepEqual(noise.map((/** @type {any} */ f) => `${f.page} ${f.type}: ${f.title}`), []);
  assert.equal(exitCode, 0);
  assert.ok(report.summary.interactions >= 15, `explored ${report.summary.interactions} interactions`);
  // Its sessions ended every few seconds; envdiff logged back in each time.
  assert.ok((apps[2].app.logins[QA] ?? 0) - before >= 2, `logged in ${(apps[2].app.logins[QA] ?? 0) - before} times`);
});

test("--user logs in as another user in both environments", { timeout: 300_000 }, async () => {
  const env = envFor({ prod: apps[0].url, uat: apps[2].url });
  const { report } = await compare(
    { user: "admin", baseline: { env: "prod" }, candidate: { env: "uat" }, crawl: { maxPages: 6 }, explore: { enabled: false }, report: { outDir: path.join(tmp, "admin") } },
    { log, env },
  );
  assert.equal(report.meta.baseline.login.user, "admin");
  const keys = report.pages.map((/** @type {any} */ p) => p.key);
  assert.ok(keys.includes("/#/admin"), `admins see the Admin page: ${keys.join(", ")}`);
});

test("the automatic login handles one-time codes and reports refusals", { timeout: 120_000 }, async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const login = async (/** @type {any} */ o) => {
      const page = await browser.newPage();
      await page.goto(apps[0].url);
      try {
        return await autoLogin(page, { timeout: 20000, ...o });
      } finally {
        await page.close();
      }
    };
    const otp = USERS["otp@example.com"];
    const ok = await login({ username: "otp@example.com", password: otp.password, totp: otp.totp });
    assert.match(ok.landedUrl, /#\/dashboard$/);
    assert.match(ok.formUrl, /#\/login$/);
    await assert.rejects(login({ username: "otp@example.com", password: otp.password, totpHint: "ENVDIFF_UAT_TOTP" }), /one-time code; set ENVDIFF_UAT_TOTP/);
    await assert.rejects(login({ username: QA, password: "wrong" }), /refused: "Invalid email or password"/);
  } finally {
    await browser.close();
  }
});

test("journeys written in plain English find the broken flows", { timeout: 600_000 }, async () => {
  const env = envFor({ prod: apps[0].url, uat: apps[1].url });
  const journeys = parseJourneyScript(`
Journey: Filter orders
1. Go to Orders
2. Type "west" into Search orders
3. Make sure the Orders grid has rows

Journey: Sales report
- Open Reports
- Select "Last 30 days" from Date range
- Click Apply
- Expect to see "Showing last 30 days"

Journey: Revenue tooltip
- Go to Dashboard
- Hover over the Monthly revenue chart

Journey: Sort customers; Go to Orders; Sort by Customer descending
`);
  assert.equal(journeys.length, 4);
  const { report } = await compare(
    { baseline: { env: "prod" }, candidate: { env: "uat" }, crawl: { enabled: false }, journeys, report: { outDir: path.join(tmp, "journeys") } },
    { log, env },
  );
  const found = report.findings.map((/** @type {any} */ f) => `${f.journey} ${f.type}`).sort();
  assert.deepEqual(found, [
    "Filter orders journey.no-effect", // the search box filters nothing
    "Revenue tooltip journey.tooltip", // the tooltip lost its currency format
    "Sales report journey.step-failed", // Apply fails for 30 days, so the expected text never shows
    "Sales report network.failed", // …because the report call returns 500
    "Sort customers journey.no-effect", // the Customer column doesn't sort
  ]);
  const filter = report.journeys.find((/** @type {any} */ j) => j.name === "Filter orders");
  assert.match(filter.steps[2].baseline.observed, /^\d+ rows$/);
  assert.equal(report.summary.pages, 0, "--no-crawl compares no pages");
});

test("a step envdiff can't read is worked out by the AI provider, on the page as it is", { timeout: 120_000 }, async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(apps[0].url);
    await autoLogin(page, { username: QA, password: USERS[QA].password });
    /** @type {string[]} */
    const prompts = [];
    // A provider that does what a model would: picks the Orders link from the list it is given.
    const provider = /** @type {any} */ ({
      name: "fake",
      model: "fake",
      usage: { input: 0, output: 0 },
      close: async () => {},
      ask: async (/** @type {any} */ req) => {
        const text = req.parts[0].text;
        prompts.push(text);
        const line = text.split("\n").find((/** @type {string} */ l) => /^\d+\. link "Orders"/.test(l));
        return { text: "", json: { action: "click", control: Number(line?.split(".")[0] ?? -1), value: "", explanation: "the Orders link" } };
      },
    });
    const scope = deriveScopes(apps[0].url, apps[0].url, {}).baseline;
    const r = await runPlainStep(page, null, "Have a look at what people ordered", {
      scope,
      timeout: 3000,
      plan: (step, p, why) => planStep(provider, { step, page: p, why, history: [] }),
    });
    await page.waitForURL(/#\/orders$/);
    assert.equal(r.chosen?.name, "Orders");
    assert.match(r.note ?? "", /read as: click link "Orders"/);
    assert.match(prompts[0], /Step: Have a look at what people ordered/);
    assert.match(prompts[0], /Grids: "Top products"/);
  } finally {
    await browser.close();
  }
});
