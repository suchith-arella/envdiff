import { test } from "node:test";
import assert from "node:assert/strict";
import { createFindings } from "../../src/findings.js";
import { resolveConfig } from "../../src/config.js";

const cfg = (/** @type {any} */ extra = {}) => resolveConfig({ baseline: { url: "https://a.example.com" }, candidate: { url: "https://b.example.com" }, ...extra });

test("the same failed call on many page loads is one finding that lists its pages", () => {
  const findings = createFindings(cfg());
  const failed = (/** @type {string} */ page, /** @type {string} */ viewport) => ({
    page,
    viewport,
    severity: /** @type {const} */ ("major"),
    category: "network",
    type: "network.failed",
    title: "GET api.example.com/status fails (net::ERR_FAILED) on candidate",
    fp: "req:GET api.example.com/status",
  });
  const first = findings.add(failed("/", "desktop"));
  const again = findings.add(failed("/about", "desktop"));
  findings.add(failed("/about", "mobile"));
  findings.add(failed("/contact", "desktop"));
  assert.ok(first && again);
  assert.equal(first.id, again.id);
  assert.deepEqual(first.pages, ["/", "/about", "/contact"]);
  assert.equal(findings.all().length, 1);

  // Ignoring it by id ignores it everywhere.
  const quiet = createFindings(cfg({ ignore: { findings: [first.id] } }));
  assert.equal(quiet.add(failed("/pricing", "desktop")), null);

  // The same call failing after a click stays tied to that interaction.
  const onClick = findings.add({ ...failed("/about", "desktop"), interaction: "abc", title: `${failed("", "").title} after clicking "Save"` });
  assert.notEqual(onClick?.id, first.id);
  assert.equal(onClick?.pages, undefined);
});

test("page-specific findings keep one finding per page", () => {
  const findings = createFindings(cfg());
  const missing = (/** @type {string} */ page) => ({ page, viewport: "desktop", severity: /** @type {const} */ ("major"), category: "elements", type: "elements.missing", title: 'Missing on candidate: button "Save"', fp: "button|save" });
  const a = findings.add(missing("/a"));
  const b = findings.add(missing("/b"));
  assert.notEqual(a?.id, b?.id);
  assert.equal(findings.all().length, 2);
});
