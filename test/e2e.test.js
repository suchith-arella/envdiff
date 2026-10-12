/**
 * End to end against the fixture shop: every planted regression must be
 * found, and two identical deployments must produce a clean report.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSite } from "./fixtures/site/server.js";
import { compare } from "../src/index.js";
import { createLogger } from "../src/util/log.js";

/** @type {{ url: string, close: () => Promise<void> }[]} */
const sites = [];
let baseline = "";
let baseline2 = "";
let candidate = "";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "envdiff-e2e-"));
const log = createLogger({ level: process.env.ENVDIFF_TEST_VERBOSE ? "info" : "silent" });

before(async () => {
  for (const variant of /** @type {const} */ (["baseline", "baseline", "candidate"])) sites.push(await startSite({ variant }));
  [baseline, baseline2, candidate] = sites.map((s) => s.url);
});
after(async () => {
  await Promise.all(sites.map((s) => s.close()));
  if (!process.env.ENVDIFF_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
});

/** @param {string} b @param {string} c @param {string} out */
const config = (b, c, out) => ({
  baseline: { url: b, label: "Baseline" },
  candidate: { url: c, label: "Candidate" },
  crawl: { maxPages: 14 },
  explore: { maxActionsPerPage: 15, depth: 2 },
  viewports: ["desktop", "mobile"],
  // The fixture has a live clock and a random visitor counter: the kind of
  // dynamic content real sites have and configs exist to tame.
  visual: { mask: [".clock", ".visitors"] },
  ignore: { text: ["Visitors online"] },
  stabilize: { ignoreMutations: [".clock"] },
  journeys: [
    {
      name: "Wishlist",
      steps: [
        { goto: "/products/1" },
        { click: { role: "button", name: "Add to wishlist" } },
        { expectText: { selector: "#msg", text: "Saved to wishlist" } },
        { screenshot: "Saved" },
      ],
    },
  ],
  report: { outDir: path.join(tmp, out) },
});

test("finds every planted regression", { timeout: 300_000 }, async () => {
  const { report, exitCode } = await compare(config(baseline, candidate, "regressions"), { log });
  const found = new Set(report.findings.map((/** @type {any} */ f) => `${f.journey ? `journey:${f.journey}` : f.page} ${f.type}`));
  const expected = [
    "/ errors.uncaught", // Load more throws
    "/ interaction.no-update", // ...and never shows the items
    "/products interaction.no-effect", // sort dropdown does nothing
    "/products errors.console",
    "/contact page.unavailable", // page removed
    "/legacy page.unavailable", // 500
    "/ links.broken-new", // nav link to /contact-us
    "/ elements.href",
    "/ layout.style", // CTA colour
    "/ layout.overflow", // promo banner too wide on mobile
    "/about images.broken",
    "/about a11y.image-alt",
    "/about perf.slower",
    "/about content.text",
    "/dashboard network.failed", // /api/stats 500 after clicking Refresh
    "/dashboard interaction.error-text",
    "/dashboard api.field-missing", // profile.email dropped
    "/dashboard api.type-changed", // profile.age number -> string
    "/products/1 elements.missing", // wishlist button
    "/products/1 content.suspicious", // $NaN
    "/products/1 interaction.payload", // POST /api/cart without qty
    "/support forms.validation",
    "/support forms.attribute",
    "/support security.header",
    "journey:Wishlist journey.step-failed",
  ];
  const missing = expected.filter((e) => !found.has(e));
  assert.deepEqual(missing, [], `not found:\n${missing.join("\n")}\n\nfound:\n${[...found].sort().join("\n")}`);

  // Slow is not broken: the candidate's /api/tips answers after 3s, and the
  // home page polls /api/notifications in the background on both sides.
  const falseAlarms = report.findings.filter((/** @type {any} */ f) => /Show tips|notifications/i.test(`${f.title} ${f.detail ?? ""}`));
  assert.deepEqual(falseAlarms.map((/** @type {any} */ f) => f.title), []);

  assert.equal(exitCode, 1);
  assert.equal(report.summary.verdict, "fail");
  assert.deepEqual(report.errors, []);
  // GraphQL reads go through the mutation guard; the cart POST does not.
  const products = report.pages.find((/** @type {any} */ p) => p.key === "/products" && p.viewport === "desktop");
  assert.equal(products.baseline.counts.blockedRequests, 0);
  // Mobile repeats nothing desktop already said.
  const titles = report.findings.map((/** @type {any} */ f) => `${f.page}|${f.type}|${f.title}`);
  assert.equal(new Set(titles).size, titles.length);
  const mobileContact = report.findings.filter((/** @type {any} */ f) => f.page === "/contact" && f.viewport === "mobile");
  assert.equal(mobileContact.length, 0);

  const dir = path.join(tmp, "regressions");
  for (const f of ["index.html", "report.json", "summary.md", "junit.xml"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  for (const f of report.findings) {
    for (const rel of Object.values(f.evidence ?? {})) if (rel) assert.ok(fs.existsSync(path.join(dir, /** @type {string} */ (rel))), `evidence ${rel}`);
  }
});

test("identical deployments produce a clean report", { timeout: 300_000 }, async () => {
  const { report, exitCode } = await compare(config(baseline, baseline2, "identical"), { log });
  const noise = report.findings.filter((/** @type {any} */ f) => f.severity !== "info");
  assert.deepEqual(
    noise.map((/** @type {any} */ f) => `${f.page ?? f.journey} ${f.type}: ${f.title}`),
    [],
  );
  assert.equal(exitCode, 0);
  assert.ok(report.summary.interactions >= 10, `explored ${report.summary.interactions} interactions`);
  assert.equal(report.pages.flatMap((/** @type {any} */ p) => p.interactions).filter((/** @type {any} */ i) => i.verdict === "different").length, 0);
  assert.equal(report.journeys[0].verdict, "same");
});

test("the HTML report runs without errors", { timeout: 120_000 }, async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const file = `file://${path.join(tmp, "regressions", "index.html")}`;
  for (const hash of ["", "#pages", "#pages/0", "#interactions", "#journeys", "#api", "#run"]) {
    await page.goto(file + hash);
    await page.waitForTimeout(150);
  }
  await page.goto(file + "#findings");
  await page.locator("tr.row").first().click();
  await page.goto(file + "#pages/0");
  for (const mode of ["Swipe", "Onion skin", "Diff"]) {
    const b = page.locator(".seg button", { hasText: mode }).first();
    if (await b.count()) await b.click();
  }
  assert.equal(await page.locator(".verdict").textContent(), "FAIL");
  await browser.close();
  assert.deepEqual(errors, []);
});
