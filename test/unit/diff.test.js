import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, summarizeDiff, similarity } from "../../src/util/textdiff.js";
import { shapeOf, compareShapes, bodyShape, mergeShapes } from "../../src/shape.js";
import { normalizeLines, suspiciousText, compareText } from "../../src/compare/text.js";
import { resolveConfig } from "../../src/config.js";
import { normalizeMessage } from "../../src/util/misc.js";

/** Rebuild both inputs from a diff: proves the diff is complete and ordered. */
function replay(ops) {
  return {
    a: ops.filter((o) => o.op !== "+").map((o) => o.text),
    b: ops.filter((o) => o.op !== "-").map((o) => o.text),
  };
}

test("diffLines produces a minimal, replayable diff", () => {
  const a = ["one", "two", "three", "four", "five"];
  const b = ["one", "2", "three", "five", "six"];
  const ops = diffLines(a, b);
  assert.deepEqual(replay(ops), { a, b });
  assert.equal(ops.filter((o) => o.op !== "=").length, 4);
});

test("diffLines handles random inputs", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 200; i++) {
    const a = Array.from({ length: Math.floor(rnd() * 20) }, () => String(Math.floor(rnd() * 6)));
    const b = Array.from({ length: Math.floor(rnd() * 20) }, () => String(Math.floor(rnd() * 6)));
    assert.deepEqual(replay(diffLines(a, b)), { a, b });
  }
});

test("diffLines falls back gracefully on huge inputs", () => {
  const a = Array.from({ length: 6000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 6000 }, (_, i) => `b${i}`);
  const ops = diffLines(a, b, { maxLines: 1000 });
  assert.equal(ops.filter((o) => o.op === "-").length, 6000);
  assert.equal(ops.filter((o) => o.op === "+").length, 6000);
});

test("summarizeDiff keeps context and counts", () => {
  const ops = diffLines(["a", "b", "c", "d", "e", "f"], ["a", "b", "X", "d", "e", "f"]);
  const s = summarizeDiff(ops, 1);
  assert.equal(s.removed, 1);
  assert.equal(s.added, 1);
  assert.deepEqual(
    s.lines.map((l) => l.op),
    ["=", "-", "+", "="],
  );
});

test("similarity", () => {
  assert.equal(similarity("add to cart", "add to cart"), 1);
  assert.ok(similarity("add to bag", "add to cart") > 0.6);
  assert.ok(similarity("checkout", "sign in") < 0.4);
});

test("JSON shapes ignore data but catch contract changes", () => {
  const base = { user: { id: 1, email: "a@b.c", age: 36 }, orders: [{ id: 1, total: 9.5 }], tags: null };
  const cand = { user: { id: 2, age: "36" }, orders: [], tags: ["x"] };
  const { missing, changed, added } = compareShapes(shapeOf(base), shapeOf(cand));
  assert.deepEqual(missing, ["user.email"]);
  assert.deepEqual(changed, [{ path: "user.age", from: "number", to: "string" }]);
  // orders is empty on the candidate: its items can't be judged. tags was null on the baseline.
  assert.ok(!missing.some((m) => m.startsWith("orders")));
  assert.ok(!added.includes("tags[]"));
});

test("JSON shapes collapse maps keyed by ids", () => {
  const a = shapeOf({ 123: { name: "x" }, 456: { name: "y" } });
  const b = shapeOf({ 789: { name: "z" } });
  assert.deepEqual(compareShapes(a, b), { missing: [], added: [], changed: [] });
  assert.deepEqual(mergeShapes("number", "string"), "number|string");
});

test("bodyShape describes request payloads", () => {
  assert.deepEqual(bodyShape('{"sku":1,"qty":2}', "application/json"), ["qty:number", "sku:number"]);
  assert.deepEqual(bodyShape("b=2&a=1", "application/x-www-form-urlencoded"), ["a", "b"]);
  assert.deepEqual(bodyShape(null), []);
});

test("normalizeLines removes volatile tokens", () => {
  const out = normalizeLines(["Updated 10:42:01", "Posted 3 minutes ago", "id 3f2504e0-4f89-11d3-9a0c-0305e82c3301", "Visitors: 12"], {
    normalize: true,
    ignore: [/Visitors: \d+/],
  });
  assert.deepEqual(out, ["Updated ‹time›", "Posted ‹ago›", "id ‹uuid›"]);
});

test("compareText reports only real changes", () => {
  const cfg = resolveConfig({});
  const same = compareText(["Updated 10:42:01", "Hello"], ["Updated 11:00:59", "Hello"], cfg);
  assert.equal(same.removed + same.added, 0);
  const changed = compareText(["We ship to 40 countries."], ["We ship to 12 countries."], cfg);
  assert.equal(changed.removed, 1);
  assert.equal(changed.added, 1);
});

test("suspiciousText flags broken renders new on the candidate only", () => {
  const found = suspiciousText(["Price: $20.00"], ["Price: $NaN", "Hello undefined", "checkout.button.label", "Something went wrong"]);
  const names = found.map((f) => f.name).sort();
  assert.deepEqual(names, ["NaN", "error message", "raw translation key", "undefined"]);
  assert.deepEqual(suspiciousText(["Price: $NaN"], ["Price: $NaN"]), [], "already present on the baseline");
  assert.deepEqual(suspiciousText([], ["Visit www.example.com", "Version 1.2.3"]), [], "hostnames and versions are fine");
});

test("normalizeMessage keeps status codes but drops volatile parts", () => {
  assert.equal(
    normalizeMessage("TypeError at https://dev.example.com/app.3f9a8b2c.js:12:34 (id 123456)"),
    normalizeMessage("TypeError at https://uat.example.com/app.77aa11bb.js:99:1 (id 654321)"),
  );
  assert.notEqual(normalizeMessage("status 404"), normalizeMessage("status 500"));
});
