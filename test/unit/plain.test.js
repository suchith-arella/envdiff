import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlainStep, parseJourneyScript, plainLabel } from "../../src/plain.js";
import { fillVars, secretsIn } from "../../src/smart.js";
import { journeysFrom } from "../../src/cli.js";
import { resolveConfig } from "../../src/config.js";

/** @param {string} text */
const read = (text) => {
  const s = parsePlainStep(text);
  if (!s) return null;
  const { text: _t, ...rest } = s;
  return rest;
};

test("steps are read the way testers write them", () => {
  const cases = /** @type {[string, any][]} */ ([
    ["Go to Orders", { action: "navigate", target: "Orders" }],
    ["Open the Reports page", { action: "navigate", target: "Reports" }],
    ["go to /#/orders", { action: "goto", url: "/#/orders" }],
    ["Navigate to Settings > Users", { action: "navigate", target: "Settings > Users" }],
    ["Click Apply", { action: "click", target: "Apply" }],
    ["Click the Export CSV button", { action: "click", target: "Export CSV", hint: "button" }],
    ["press Apply", { action: "click", target: "Apply" }],
    ["Press Enter", { action: "press", key: "Enter" }],
    ['Type "west" into Search orders', { action: "fill", value: "west", target: "Search orders" }],
    ["Enter west in the search box", { action: "fill", value: "west", target: "search" }],
    ["Fill Email with {{username}}", { action: "fill", target: "Email", value: "{{username}}" }],
    ["Set Date range to Last 30 days", { action: "fill", target: "Date range", value: "Last 30 days" }],
    ["Search for Acme", { action: "fill", value: "Acme", target: "search", submit: true }],
    ['Select "Last 30 days" from Date range', { action: "select", option: "Last 30 days", target: "Date range" }],
    ["Choose This year in the Date range dropdown", { action: "select", option: "This year", target: "Date range" }],
    ["Check Remember me", { action: "check", target: "Remember me" }],
    ["Uncheck 'Set this page as the default screen'", { action: "uncheck", target: "Set this page as the default screen" }],
    ["Hover over the Monthly revenue chart", { action: "hoverChart", target: "Monthly revenue", which: "first" }],
    ["Hover over the last point of the Sales by region chart", { action: "hoverChart", target: "Sales by region", which: "last" }],
    ["Sort by Amount descending", { action: "sort", target: "Amount", direction: "desc", hint: "column header" }],
    ["Next page", { action: "page", which: "next" }],
    ["Double-click the first row of the Top products grid", { action: "row", which: "1", target: "Top products", hint: "double" }],
    ["Open the last row", { action: "row", which: "last" }],
    ["Wait 2 seconds", { action: "wait", ms: 2000 }],
    ["Wait until Loading disappears", { action: "expect", target: "Loading", not: true }],
    ['Expect to see "Sales by region"', { action: "expect", target: "Sales by region" }],
    ["The Apply button should be visible", { action: "expect", target: "Apply" }],
    ["I should not see Something went wrong", { action: "expect", target: "Something went wrong", not: true }],
    ["Verify the URL contains /orders", { action: "expectUrl", url: "/orders" }],
    ["Make sure the Orders grid has rows", { action: "expectRows", target: "Orders", count: "some" }],
    ["Verify the Orders grid has no rows", { action: "expectRows", target: "Orders", count: "no" }],
    ["Check that the Monthly revenue chart shows Target", { action: "expectSeries", target: "Monthly revenue", value: "Target" }],
    ["Expect no errors", { action: "expectNoErrors" }],
    ["Take a screenshot 'West orders'", { action: "screenshot", name: "West orders" }],
    ["First, go to Orders", { action: "navigate", target: "Orders" }],
    ["Log in as admin", { action: "login", target: "admin" }],
    ["Add to wishlist", null],
  ]);
  for (const [text, want] of cases) assert.deepEqual(read(text), want, text);
});

test("a script holds journeys: headings or 'Journey:' lines, numbered or bulleted steps, or one line with semicolons", () => {
  assert.deepEqual(parseJourneyScript("## Filter orders\n1. Go to Orders\n2. Type \"west\" into Search orders.\n\n# Report\n- Open Reports\n* Click Apply"), [
    { name: "Filter orders", steps: ["Go to Orders", 'Type "west" into Search orders'] },
    { name: "Report", steps: ["Open Reports", "Click Apply"] },
  ]);
  assert.deepEqual(parseJourneyScript("Journey: A; Go to Orders; Type 'a;b' into Search; Journey: B; Click Apply"), [
    { name: "A", steps: ["Go to Orders", "Type 'a;b' into Search"] },
    { name: "B", steps: ["Click Apply"] },
  ]);
  assert.deepEqual(parseJourneyScript("Go to Orders; Don't click Delete", { name: "Smoke" }), [{ name: "Smoke", steps: ["Go to Orders", "Don't click Delete"] }]);
  // In a Markdown document with lists, paragraphs are prose, not steps; a
  // line of steps separated by semicolons still counts.
  assert.deepEqual(parseJourneyScript("# Our journeys\nRun these nightly.\n\n## Orders\nThe orders page.\n1. Go to Orders\n2. Click Apply\nJourney: Sort; Go to Orders; Sort by Amount"), [
    { name: "Orders", steps: ["Go to Orders", "Click Apply"] },
    { name: "Sort", steps: ["Go to Orders", "Sort by Amount"] },
  ]);
});

test("journeys from the command line and from files join the config's", () => {
  const list = journeysFrom(["Go to Orders; Click Apply"], []);
  assert.deepEqual(list, [{ name: "Journey", steps: ["Go to Orders", "Click Apply"] }]);
  const cfg = resolveConfig({ baseline: { url: "https://a.example.com" }, candidate: { url: "https://b.example.com" }, crawl: { enabled: false }, journeys: list }, {}, { env: {} });
  assert.equal(cfg.journeys[0].steps[0], "Go to Orders");
  assert.throws(() => resolveConfig({ baseline: { url: "https://a.example.com" }, candidate: { url: "https://b.example.com" }, crawl: { enabled: false } }, {}, { env: {} }), /nothing to compare/);
});

test("credentials and environment values fill steps, and stay out of reports", () => {
  process.env.ENVDIFF_TEST_COUPON = "SAVE-2026";
  const vars = { username: "qa@example.com", password: "s3cret-pw" };
  assert.equal(fillVars("{{username}}", vars), "qa@example.com");
  assert.equal(fillVars("code {{env.ENVDIFF_TEST_COUPON}}", vars), "code SAVE-2026");
  assert.throws(() => fillVars("{{env.ENVDIFF_NOT_SET_ANYWHERE}}", vars), /has no value/);
  const step = "Type {{password}} into Password; and {{env.ENVDIFF_TEST_COUPON}}";
  const secrets = secretsIn(step, vars);
  assert.deepEqual(secrets.sort(), ["SAVE-2026", "s3cret-pw"]);
  const label = plainLabel({ text: "Type s3cret-pw into Password", action: "fill" }, secrets);
  assert.equal(label, "Type •••• into Password");
  delete process.env.ENVDIFF_TEST_COUPON;
});
