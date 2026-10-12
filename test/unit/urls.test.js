import { test } from "node:test";
import assert from "node:assert/strict";
import { Scope, deriveScopes, routePattern, segmentPattern, envTokens, normalizeRequestUrl, siteOf, looksLikeAsset, looksGenerated, isOpaqueUrl } from "../../src/urls.js";

test("keyOf normalizes queries, trailing slashes and hashes", () => {
  const s = new Scope("https://dev.example.com/");
  assert.equal(s.keyOf("https://dev.example.com/"), "/");
  assert.equal(s.keyOf("https://dev.example.com/cart/"), "/cart");
  assert.equal(s.keyOf("https://dev.example.com/p?b=2&a=1&utm_source=x"), "/p?a=1&b=2");
  assert.equal(s.keyOf("https://dev.example.com/p#section"), "/p");
  assert.equal(s.keyOf("https://dev.example.com/app#/settings"), "/app#/settings");
  assert.equal(s.keyOf("https://other.example.com/p"), null);
  assert.equal(s.keyOf("mailto:x@y.z"), null);
  assert.equal(s.keyOf("/relative/path", {}), "/relative/path");
  assert.equal(s.keyOf("https://dev.example.com/p?x=1", { ignoreQuery: true }), "/p");
});

test("keyOf respects a base path", () => {
  const s = new Scope("https://example.com/preview/pr-12/", "/preview/pr-12");
  assert.equal(s.keyOf("https://example.com/preview/pr-12/"), "/");
  assert.equal(s.keyOf("https://example.com/preview/pr-12/cart"), "/cart");
  assert.equal(s.keyOf("https://example.com/preview/pr-13/cart"), null);
  assert.equal(s.urlFor("/cart"), "https://example.com/preview/pr-12/cart");
});

test("deriveScopes: same path means whole-origin scope, different paths mean base paths", () => {
  const same = deriveScopes("https://dev.example.com/app/login", "https://uat.example.com/app/login");
  assert.equal(same.baseline.basePath, "");
  assert.equal(same.startKey, "/app/login");
  assert.equal(same.candidate.urlFor(same.startKey), "https://uat.example.com/app/login");

  const diff = deriveScopes("https://example.com/preview/pr-12/", "https://example.com/preview/pr-13");
  assert.equal(diff.baseline.basePath, "/preview/pr-12");
  assert.equal(diff.candidate.basePath, "/preview/pr-13");
  assert.equal(diff.startKey, "/");
});

test("route patterns collapse ids", () => {
  assert.equal(segmentPattern("123"), ":n");
  assert.equal(segmentPattern("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), ":uuid");
  assert.equal(segmentPattern("blue-shirt-1234"), ":slug");
  assert.equal(segmentPattern("about"), "about");
  assert.equal(segmentPattern("checkout"), "checkout");
  assert.equal(routePattern("/products/42?color=red&size=m"), "/products/:n?color=*&size=*");
  assert.equal(routePattern("/blog/hello-world", new Set(["/blog"])), "/blog/:var");
  assert.equal(routePattern("/about"), "/about");
});

test("envTokens finds the environment labels in hostnames", () => {
  assert.deepEqual(envTokens("dev.example.com", "uat.example.com"), { baseline: ["dev"], candidate: ["uat"] });
  const t = envTokens("shop-dev.example.com", "shop-uat.example.com");
  assert.ok(t.baseline.includes("dev") && t.candidate.includes("uat"));
  assert.deepEqual(envTokens("localhost:4101", "localhost:4102"), { baseline: [], candidate: [] });
  assert.deepEqual(envTokens("www.example.com", "example.com"), { baseline: ["www"], candidate: [] });
});

test("normalizeRequestUrl makes the same call on two environments compare equal", () => {
  const a = new Scope("https://dev.example.com/");
  const b = new Scope("https://example.com/");
  const tokens = envTokens(a.host, b.host);
  const ka = normalizeRequestUrl("https://api.dev.example.com/v1/items/123?page=2&_=999", a, tokens.baseline);
  const kb = normalizeRequestUrl("https://api.example.com/v1/items/456?page=9", b, tokens.candidate);
  assert.equal(ka, "api.example.com/v1/items/:n?page=*");
  assert.equal(ka, kb);
  assert.equal(normalizeRequestUrl("https://dev.example.com/api/cart", a, tokens.baseline), "{self}/api/cart");
});

test("siteOf and looksLikeAsset", () => {
  assert.equal(siteOf("app.dev.example.com"), "example.com");
  assert.equal(siteOf("shop.example.co.uk"), "example.co.uk");
  assert.equal(siteOf("localhost"), "localhost");
  assert.ok(looksLikeAsset("/files/report.pdf"));
  assert.ok(!looksLikeAsset("/products/1"));
});

test("generated path segments are told apart from hand-written names", () => {
  // Real bot-protection paths from two environments of one site, and a build id.
  for (const seg of ["k_yd21tBWxanHnm6fo7hD1ca", "xTsLSE6E5_URAqQHKRCmyyWZ", "OGDYrDtQr9JQbGiu", "UjJsPUo0", "ICVUweD2s", "MGstPDcC", "Y5dpSiPXdsRERpbKFAGTx"]) {
    assert.ok(looksGenerated(seg), seg);
  }
  for (const seg of ["getUserStatus", "restAuth", "getUserById", "MyAPIClient", "OAuth2Callback", "XMLHttpRequest", "toJSONString", "treasury-margin", "remoteEntry_122.js", "SecuritiesLending"]) {
    assert.ok(!looksGenerated(seg), seg);
  }
  assert.equal(segmentPattern("dQw4w9WgXcQ"), ":id");
  assert.equal(segmentPattern("getUserStatus"), "getUserStatus");
});

test("calls to per-environment generated paths compare equal and are recognisable as noise", () => {
  const a = new Scope("https://www.example.com/");
  const b = new Scope("https://uat.example.com/");
  const tokens = envTokens(a.host, b.host);
  const prod = "https://www.example.com/k_yd21tBWxanHnm6fo7hD1ca/OGDYrDtQr9JQbGiu/J3xHYExPAQ/UjJsPUo0/DB4";
  const uat = "https://uat.example.com/xTsLSE6E5_URAqQHKRCmyyWZ/Vua5tz8h3YVwrG/JGkkPDcC/By/ICVUweD2s";
  assert.equal(normalizeRequestUrl(prod, a, tokens.baseline), "{self}/:opaque");
  assert.equal(normalizeRequestUrl(uat, b, tokens.candidate), "{self}/:opaque");
  assert.ok(isOpaqueUrl(prod) && isOpaqueUrl(uat));
  assert.ok(!isOpaqueUrl("https://www.example.com/pbo/restAuth/getUserStatus?_=1"));
  assert.ok(!isOpaqueUrl("https://www.example.com/_next/data/Y5dpSiPXdsRERpbKFAGTx/index.json"));
  // A build id inside an otherwise ordinary path still matches across deployments.
  assert.equal(
    normalizeRequestUrl("https://www.example.com/_next/data/Y5dpSiPXdsRERpbKFAGTx/index.json", a, tokens.baseline),
    normalizeRequestUrl("https://uat.example.com/_next/data/Qm7xTqZ2kLpWvR9sNcYbD/index.json", b, tokens.candidate),
  );
});
