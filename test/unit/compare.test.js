import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { matchElements, annotateElements, relocate } from "../../src/match.js";
import { compareElements, compareForms, styleDiff } from "../../src/compare/elements.js";
import { createFindings } from "../../src/findings.js";
import { resolveConfig } from "../../src/config.js";
import { diffImages, clusterRegions, describeRegion, cropPng } from "../../src/compare/visual.js";
import { isGraphQLRead } from "../../src/instrument.js";

let idx = 0;
/** A minimal inventory element. */
function el(over) {
  return {
    idx: idx++,
    tag: "button",
    role: "button",
    kind: "button",
    name: "",
    type: "",
    href: "",
    testId: "",
    id: "",
    nameAttr: "",
    landmark: "main",
    heading: "",
    rect: { x: 10, y: 10, w: 80, h: 30 },
    disabled: false,
    inDialog: false,
    cssPath: "button",
    styles: { color: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)" },
    ...over,
  };
}

test("matching pairs by test id, then name, then fuzzy name", () => {
  const A = annotateElements([el({ testId: "data-testid=buy", name: "Buy now" }), el({ name: "Add to bag" }), el({ name: "Help" }), el({ name: "Gone" })]);
  const B = annotateElements([el({ testId: "data-testid=buy", name: "Purchase" }), el({ name: "Add to cart" }), el({ name: "Help" })]);
  const { pairs, onlyA, onlyB } = matchElements(A, B);
  const by = Object.fromEntries(pairs.map((p) => [p.a.name, `${p.b.name}|${p.how}`]));
  assert.equal(by["Buy now"], "Purchase|test-id");
  assert.equal(by["Help"], "Help|role+name+landmark");
  assert.equal(by["Add to bag"], "Add to cart|fuzzy");
  assert.deepEqual(onlyA.map((e) => e.name), ["Gone"]);
  assert.equal(onlyB.length, 0);
});

test("repeated controls pair in document order and relocate by key", () => {
  const A = annotateElements([el({ name: "Edit" }), el({ name: "Edit" })]);
  const B = annotateElements([el({ name: "Edit" }), el({ name: "Edit" })]);
  const { pairs } = matchElements(A, B);
  assert.equal(pairs[0].b, B[0]);
  assert.equal(pairs[1].b, B[1]);
  assert.equal(relocate(B, A[1]), B[1]);
});

function collect() {
  const cfg = resolveConfig({});
  const findings = createFindings(cfg);
  return { findings, add: (f) => findings.add(f) };
}

test("compareElements reports missing, disabled, restyled and relabelled controls", () => {
  const { findings, add } = collect();
  const A = annotateElements([
    el({ name: "Add to wishlist" }),
    el({ name: "Checkout" }),
    el({ name: "Subscribe", styles: { color: "rgb(255, 255, 255)", backgroundColor: "rgb(47, 111, 237)" } }),
    el({ name: "Add to bag" }),
  ]);
  const B = annotateElements([
    el({ name: "Checkout", disabled: true }),
    el({ name: "Subscribe", styles: { color: "rgb(255, 255, 255)", backgroundColor: "rgb(214, 51, 108)" } }),
    el({ name: "Add to cart" }),
  ]);
  compareElements({ actionables: A }, { actionables: B }, { add, where: { page: "/p", viewport: "desktop" }, tolerance: 6, layout: true });
  const types = findings.all().map((f) => f.type).sort();
  assert.deepEqual(types, ["elements.disabled", "elements.label", "elements.missing", "layout.style"]);
  assert.match(findings.all().find((f) => f.type === "elements.missing").title, /Add to wishlist/);
});

test("data-driven links and fewer repeated controls are not 'missing'", () => {
  const { findings, add } = collect();
  const link = (name, href) => el({ role: "link", kind: "link", tag: "a", name, href: `https://x.test${href}`, hrefKey: href });
  const A = annotateElements([link("Blue shirt", "/products/1"), link("Red hat", "/products/2"), el({ name: "Add to cart" }), el({ name: "Add to cart" })]);
  const B = annotateElements([link("Green scarf", "/products/3"), el({ name: "Add to cart" })]);
  for (const e of [...A, ...B]) if (e.href) e.hrefKey = new URL(e.href).pathname;
  compareElements({ actionables: A }, { actionables: B }, { add, where: { page: "/", viewport: "desktop" }, tolerance: 6, layout: false });
  const all = findings.all();
  assert.ok(!all.some((f) => f.type === "elements.missing"), JSON.stringify(all.map((f) => f.title)));
  assert.ok(all.some((f) => f.type === "elements.data-links" && f.severity === "info"));
});

test("site-wide navigation changes are reported once across pages", () => {
  const { findings, add } = collect();
  const seen = new Set();
  const nav = (href) => annotateElements([el({ role: "link", kind: "link", tag: "a", name: "Contact", landmark: "navigation", href: `https://x.test${href}`, hrefKey: href })]);
  for (const page of ["/", "/about", "/help"]) {
    compareElements({ actionables: nav("/contact") }, { actionables: nav("/contact-us") }, { add, where: { page, viewport: "desktop" }, tolerance: 6, layout: false, seen });
  }
  assert.equal(findings.all().filter((f) => f.type === "elements.href").length, 1);
});

test("a page whose controls vanished is one critical finding", () => {
  const { findings, add } = collect();
  const A = annotateElements(Array.from({ length: 12 }, (_, i) => el({ name: `Button ${String.fromCharCode(65 + i)}` })));
  compareElements({ actionables: A }, { actionables: [] }, { add, where: { page: "/", viewport: "desktop" }, tolerance: 6, layout: false });
  assert.deepEqual(
    findings.all().map((f) => [f.type, f.severity]),
    [["elements.mostly-missing", "critical"]],
  );
});

test("forms: removed validation and fields", () => {
  const { findings, add } = collect();
  const field = (over) => ({ tag: "input", type: "text", name: "", id: "", label: "", required: false, disabled: false, visible: true, placeholder: "", autocomplete: "", pattern: "", maxLength: "", min: "", max: "", ...over });
  compareForms(
    [{ name: "signup", action: "", landmark: "main", visible: true, fields: [field({ name: "email", type: "email", required: true }), field({ name: "phone" })] }],
    [{ name: "signup", action: "", landmark: "main", visible: true, fields: [field({ name: "email", type: "text" })] }],
    { add, where: { page: "/signup", viewport: "desktop" } },
  );
  const types = findings.all().map((f) => f.type).sort();
  assert.deepEqual(types, ["forms.attribute", "forms.field-missing", "forms.validation"]);
});

test("styleDiff ignores border colour without a border", () => {
  assert.deepEqual(styleDiff({ borderTopWidth: "0px", borderTopColor: "red" }, { borderTopWidth: "0px", borderTopColor: "blue" }), []);
  assert.deepEqual(styleDiff({ fontSize: "16px" }, { fontSize: "14px" }), ["font size 16px → 14px"]);
});

test("findings: stable ids, ignores, severity overrides, de-duplication", () => {
  const cfg = resolveConfig({ ignore: { findings: ["perf.*"] }, severity: { "seo.*": "info" } });
  const f = createFindings(cfg);
  const a = f.add({ page: "/", severity: "minor", category: "seo", type: "seo.title", title: "Title changed", fp: "t" });
  assert.equal(a.severity, "info");
  assert.equal(f.add({ page: "/", severity: "minor", category: "perf", type: "perf.slower", title: "Slow" }), null);
  assert.equal(f.suppressed, 1);
  const again = f.add({ page: "/", severity: "major", category: "seo", type: "seo.title", title: "Other wording", fp: "t" });
  assert.equal(again, a, "same fingerprint is the same finding");
  const g = createFindings(resolveConfig({ ignore: { findings: [a.id] } }));
  assert.equal(g.add({ page: "/", severity: "minor", category: "seo", type: "seo.title", title: "x", fp: "t" }), null);
});

/** Write a solid PNG with an optional coloured box. */
function png(file, w, h, box) {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inBox = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      img.data[i] = inBox ? 220 : 255;
      img.data[i + 1] = inBox ? 30 : 255;
      img.data[i + 2] = inBox ? 30 : 255;
      img.data[i + 3] = 255;
    }
  }
  fs.writeFileSync(file, PNG.sync.write(img));
}

test("visual diff finds and locates the changed region", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envdiff-vis-"));
  const a = path.join(dir, "a.png");
  const b = path.join(dir, "b.png");
  const d = path.join(dir, "d.png");
  png(a, 400, 300);
  png(b, 400, 300, { x: 100, y: 120, w: 60, h: 40 });
  const res = diffImages(a, b, d);
  assert.ok(res.ratio > 0.015 && res.ratio < 0.03, String(res.ratio));
  assert.equal(res.regions.length, 1);
  const r = res.regions[0];
  assert.ok(r.x <= 100 && r.x + r.w >= 160 && r.y <= 120 && r.y + r.h >= 160, JSON.stringify(r));
  assert.ok(fs.existsSync(d));
  const label = describeRegion(r, { actionables: [{ role: "button", name: "Subscribe", rect: { x: 100, y: 120, w: 60, h: 40 } }], headings: [], images: [] });
  assert.equal(label, 'near button "Subscribe"');
  // identical images: no diff file, ratio 0
  const same = diffImages(a, a, path.join(dir, "same.png"));
  assert.equal(same.ratio, 0);
  assert.ok(!fs.existsSync(path.join(dir, "same.png")));
  // different heights count the extra area
  png(path.join(dir, "tall.png"), 400, 400);
  assert.ok(diffImages(a, path.join(dir, "tall.png"), null).ratio > 0.2);
  // cropping keeps aspect and caps size
  const crop = PNG.sync.read(cropPng(b, { x: 0, y: 0, w: 400, h: 300 }, 200));
  assert.deepEqual([crop.width, crop.height], [200, 150]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("clusterRegions merges nearby pixels and separates distant ones", () => {
  const w = 200;
  const h = 200;
  const data = new Uint8Array(w * h * 4);
  const mark = (x, y) => data.set([255, 0, 72, 255], (y * w + x) * 4);
  mark(10, 10);
  mark(20, 12);
  mark(180, 190);
  const regions = clusterRegions(data, w, h, 16);
  assert.equal(regions.length, 2);
});

test("GraphQL reads pass the mutation guard, mutations don't", () => {
  assert.ok(isGraphQLRead(JSON.stringify({ query: "query Recs { recs { id } }" })));
  assert.ok(isGraphQLRead(JSON.stringify({ query: "{ me { id } }" })));
  assert.ok(isGraphQLRead(JSON.stringify([{ query: "query A { a }" }, { query: "query B { b }" }])));
  assert.ok(!isGraphQLRead(JSON.stringify({ query: "mutation AddToCart($id: ID!) { add(id: $id) { ok } }" })));
  assert.ok(!isGraphQLRead(JSON.stringify([{ query: "query A { a }" }, { query: "# comment\nmutation B { b }" }])));
  assert.ok(isGraphQLRead(JSON.stringify({ operationName: "GetProducts", extensions: { persistedQuery: { sha256Hash: "x" } } })));
  assert.ok(!isGraphQLRead(JSON.stringify({ operationName: "DeleteAccount", extensions: { persistedQuery: { sha256Hash: "x" } } })));
  assert.ok(!isGraphQLRead(JSON.stringify({ sku: 1, qty: 2 })), "ordinary JSON POSTs are not GraphQL");
  assert.ok(!isGraphQLRead("not json"));
});
