/**
 * Everything about URLs: which pages belong to an environment, how a page on
 * one environment maps to the same page on the other, and how to normalize
 * request URLs so the same API call on two hosts compares equal.
 *
 * A "key" is a page's identity independent of environment: its path relative
 * to the environment's base path, plus a normalized query and any route-like
 * hash. https://dev.example.com/shop/cart?b=2&a=1 and
 * https://uat.example.com/shop/cart?a=1&b=2 both have the key /shop/cart?a=1&b=2.
 */

const TRACKING_PARAM = /^(utm_[a-z_]+|gclid|gbraid|wbraid|fbclid|msclkid|dclid|yclid|_ga|_gl|mc_cid|mc_eid|_hsenc|_hsmi|igshid|ref_src|_kx)$/i;
const CACHE_BUSTER_PARAM = /^(_|t|ts|cb|nocache|cachebust|timestamp|_t|v|ver|version|rnd|rand|random)$/i;

const NON_PAGE_EXT =
  /\.(pdf|zip|gz|tgz|rar|7z|png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|ogg|flac|docx?|xlsx?|pptx?|odt|csv|json|xml|txt|rss|atom|woff2?|ttf|otf|eot|css|js|mjs|map|wasm|apk|dmg|exe|msi|iso)$/i;

export class Scope {
  /**
   * @param {string} baseUrl Where this environment is loaded from.
   * @param {string} basePath Path prefix shared by every page ("" for the whole origin).
   */
  constructor(baseUrl, basePath = "") {
    const u = new URL(baseUrl);
    this.baseUrl = u.href;
    this.origin = u.origin;
    this.host = u.host;
    this.hostname = u.hostname;
    this.basePath = trimTrailingSlash(basePath);
  }

  /**
   * The environment-independent key for an absolute URL, or null when it is
   * outside this environment (another origin, or outside the base path).
   * @param {string} url
   * @param {{ ignoreQuery?: boolean }} [opts]
   */
  keyOf(url, opts = {}) {
    let u;
    try {
      u = new URL(url, this.baseUrl);
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.origin !== this.origin) return null;
    let p = u.pathname.replace(/\/{2,}/g, "/");
    if (this.basePath) {
      if (p === this.basePath || p === this.basePath + "/") p = "/";
      else if (p.startsWith(this.basePath + "/")) p = p.slice(this.basePath.length);
      else return null;
    }
    p = trimTrailingSlash(p) || "/";
    const q = opts.ignoreQuery ? "" : normalizeQuery(u.searchParams);
    const hash = /^#!?\//.test(u.hash) ? u.hash : "";
    return p + (q ? `?${q}` : "") + hash;
  }

  /** @param {string} key */
  urlFor(key) {
    if (/^https?:\/\//i.test(key)) return key;
    return this.origin + this.basePath + (key.startsWith("/") ? key : `/${key}`);
  }
}

/** @param {string} p */
function trimTrailingSlash(p) {
  if (!p || p === "/") return "";
  return p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

/** @param {URLSearchParams} params */
function normalizeQuery(params) {
  /** @type {[string, string][]} */
  const kept = [];
  for (const [k, v] of params) if (!TRACKING_PARAM.test(k)) kept.push([k, v]);
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return new URLSearchParams(kept).toString();
}

/**
 * Decide the base path of each environment from the two URLs the user gave.
 *
 * Same path on both sides (dev.example.com/app vs uat.example.com/app): the
 * scope is the whole origin and the crawl starts at that path. Different paths
 * (example.com/preview/pr-12 vs example.com/preview/pr-13): each path is that
 * environment's root, so /preview/pr-12/cart maps to /preview/pr-13/cart.
 *
 * @param {string} baselineUrl
 * @param {string} candidateUrl
 * @param {{ baseline?: string, candidate?: string }} [basePaths] Explicit overrides.
 */
export function deriveScopes(baselineUrl, candidateUrl, basePaths = {}) {
  const a = new URL(baselineUrl);
  const b = new URL(candidateUrl);
  const pa = trimTrailingSlash(a.pathname);
  const pb = trimTrailingSlash(b.pathname);
  let baseA = basePaths.baseline;
  let baseB = basePaths.candidate;
  if (baseA === undefined && baseB === undefined && pa !== pb) {
    baseA = pa;
    baseB = pb;
  }
  const baseline = new Scope(a.href, baseA ?? "");
  const candidate = new Scope(b.href, baseB ?? "");
  // The page the user pointed at, as a key. Querystrings on the base URL
  // (?tenant=acme) are kept: they often select what the app shows.
  const startKey = baseline.keyOf(a.href) ?? "/";
  return { baseline, candidate, startKey };
}

/** True for URLs that are files rather than pages. */
export function looksLikeAsset(/** @type {string} */ key) {
  const path = key.split(/[?#]/)[0];
  return NON_PAGE_EXT.test(path);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Classify one path segment: literal, or a placeholder for an id. */
export function segmentPattern(/** @type {string} */ seg) {
  if (!seg) return seg;
  if (/^\d+$/.test(seg)) return ":n";
  if (UUID.test(seg)) return ":uuid";
  if (/^[0-9a-f]{12,}$/i.test(seg)) return ":hex";
  // A readable slug ending in an id: blue-shirt-1234.
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*-\d{2,}$/i.test(seg)) return ":slug";
  // A long token mixing letters and digits (but not "release-2" or "v10").
  if (/^(?=[a-z0-9_-]*\d)(?=[a-z0-9_-]*[a-z])[a-z0-9_-]{10,}$/i.test(seg) && !/^[a-z]+(?:-[a-z]+)*-?v?\d{1,2}$/i.test(seg)) return ":id";
  if (looksGenerated(seg)) return ":id";
  return seg;
}

/** Two-letter words that show up in hand-written camelCase names (getUserById). */
const SHORT_WORDS = /^(by|id|of|to|in|on|at|or|as|is|if|no|up|ok|my|me|we|do|go|be|an|ui|io|os|db|ip|qa|pr|js|ts|ux|v)$/i;

/**
 * A path segment a program generated rather than a person named: build ids,
 * base64 tokens, and the per-deployment paths bot-protection scripts load from
 * and post to (/q_Rb83nWfxeJtPm2ka9vL0dZ/TzKqWe4Vb8NmPaXo/...). Told apart by
 * shape: mixed case that breaks into fragments too short to be words, where
 * getUserStatus breaks into get, User, Status.
 * @param {string} seg
 */
export function looksGenerated(seg) {
  if (seg.length < 8 || !/^[A-Za-z0-9_-]+$/.test(seg)) return false;
  if (!/[a-z]/.test(seg) || !/[A-Z]/.test(seg)) return false;
  const words = seg
    .split(/[_-]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)
    .filter((w) => /[A-Za-z]/.test(w));
  const fragments = words.filter((w) => w.length <= 2 && !SHORT_WORDS.test(w)).length;
  return words.length >= 3 && fragments >= 2 && fragments / words.length >= 0.5;
}

/**
 * A URL whose path starts with a generated segment. Bot-protection and
 * telemetry scripts served from the site's own origin use these; the path
 * differs per environment (and often per request), so their calls can't be
 * matched across environments and say nothing about the app.
 * @param {string} url
 */
export function isOpaqueUrl(url) {
  try {
    const first = new URL(url).pathname.split("/").find(Boolean);
    return !!first && looksGenerated(first);
  } catch {
    return false;
  }
}

/**
 * The shape of a page key, used to avoid crawling 500 product pages that all
 * render the same template. /products/123?color=red -> /products/:n?color=*
 * @param {string} key
 * @param {Set<string>} [variablePrefixes] Path prefixes whose next segment is known to vary.
 */
export function routePattern(key, variablePrefixes) {
  const [pathAndQuery, hash = ""] = key.split("#");
  const [path, query = ""] = pathAndQuery.split("?");
  const segs = path.split("/");
  const out = segs.map((s, i) => {
    if (i > 0 && variablePrefixes?.size) {
      const prefix = segs.slice(0, i).join("/") || "/";
      if (variablePrefixes.has(prefix)) return ":var";
    }
    return segmentPattern(s);
  });
  const keys = query
    ? [...new Set(query.split("&").map((kv) => decodeSafe(kv.split("=")[0])))].sort().map((k) => `${k}=*`)
    : [];
  return out.join("/") + (keys.length ? `?${keys.join("&")}` : "") + (hash ? `#${routePattern(hash.replace(/^!?/, ""))}` : "");
}

/** @param {string} s */
function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Labels that identify each environment inside hostnames, so requests to
 * api.dev.example.com and api.uat.example.com normalize to the same thing.
 * dev.example.com vs uat.example.com -> { baseline: ["dev"], candidate: ["uat"] }
 * shop-dev.example.com vs shop-uat.example.com -> same, from the dash-split.
 * @param {string} hostA
 * @param {string} hostB
 * @returns {{ baseline: string[], candidate: string[] }}
 */
export function envTokens(hostA, hostB) {
  const a = hostA.toLowerCase().replace(/:\d+$/, "").split(".");
  const b = hostB.toLowerCase().replace(/:\d+$/, "").split(".");
  /** @type {Set<string>} */
  const ta = new Set();
  /** @type {Set<string>} */
  const tb = new Set();
  // Align from the right: the registrable domain is at the end.
  for (let i = 1; i <= Math.min(a.length, b.length); i++) {
    const la = a[a.length - i];
    const lb = b[b.length - i];
    if (la === lb) continue;
    ta.add(la);
    tb.add(lb);
    const pa = la.split("-");
    const pb = lb.split("-");
    if (pa.length === pb.length && pa.length > 1) {
      pa.forEach((part, j) => {
        if (part !== pb[j]) {
          ta.add(part);
          tb.add(pb[j]);
        }
      });
    }
  }
  // Extra leading labels (www.example.com vs example.com) are environment noise too.
  for (let i = 0; i < a.length - b.length; i++) ta.add(a[i]);
  for (let i = 0; i < b.length - a.length; i++) tb.add(b[i]);
  // Never treat a token as environment-specific if both sides use it.
  for (const t of [...ta]) if (tb.has(t)) (ta.delete(t), tb.delete(t));
  return { baseline: [...ta].filter((t) => t.length > 1), candidate: [...tb].filter((t) => t.length > 1) };
}

/**
 * Normalize a request URL for comparison across environments:
 * same-origin -> {self}, environment labels in other hosts dropped, id-like
 * path segments -> placeholders, query values dropped (keys kept).
 * @param {string} url
 * @param {Scope} scope
 * @param {string[]} tokens This environment's host tokens from envTokens().
 */
export function normalizeRequestUrl(url, scope, tokens) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol === "data:" || u.protocol === "blob:") return `${u.protocol}…`;
  let host;
  let path = u.pathname;
  if (u.origin === scope.origin) {
    host = "{self}";
    if (scope.basePath && (path === scope.basePath || path.startsWith(scope.basePath + "/"))) {
      path = path.slice(scope.basePath.length) || "/";
    }
  } else {
    // Environment labels are dropped rather than replaced, so api.dev.example.com,
    // api.uat.example.com and a production api.example.com all become api.example.com.
    host = u.hostname
      .toLowerCase()
      .split(".")
      .map((label) => {
        if (tokens.includes(label)) return "";
        const parts = label.split("-");
        return parts.some((p) => tokens.includes(p)) ? parts.filter((p) => !tokens.includes(p)).join("-") : label;
      })
      .filter(Boolean)
      .join(".");
    if (u.port) host += `:${u.port}`;
  }
  if (isOpaqueUrl(url)) return `${host}/:opaque`;
  const segs = path.split("/").map(segmentPattern).join("/");
  const keys = [...new Set([...u.searchParams.keys()])]
    .filter((k) => !TRACKING_PARAM.test(k) && !CACHE_BUSTER_PARAM.test(k))
    .sort();
  return host + segs + (keys.length ? `?${keys.map((k) => `${k}=*`).join("&")}` : "");
}

/**
 * Approximate registrable domain ("site"): app.dev.example.com -> example.com,
 * shop.example.co.uk -> example.co.uk. Good enough to tell the app's own API
 * hosts from third parties without shipping the public suffix list.
 * @param {string} hostname
 */
export function siteOf(hostname) {
  const labels = hostname.toLowerCase().replace(/:\d+$/, "").split(".");
  if (labels.length <= 2 || /^\d+$/.test(labels[labels.length - 1])) return labels.join(".");
  const sld = labels[labels.length - 2];
  const tld = labels[labels.length - 1];
  const take = tld.length === 2 && /^(co|com|org|net|gov|ac|edu|ltd|plc|ne|or|go)$/.test(sld) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * Hosts that serve ads, analytics and session replay. Their failures and
 * timing say nothing about the app under test.
 */
export const THIRD_PARTY_NOISE =
  /(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|google\.com\/(ads|pagead)|facebook\.(com|net)\/(tr|signals)|connect\.facebook\.net|hotjar\.(com|io)|clarity\.ms|segment\.(io|com)|mixpanel\.com|amplitude\.com|fullstory\.com|newrelic\.com|nr-data\.net|sentry\.io|datadoghq\.(com|eu)|browser-intake|intercom\.io|hubspot\.com|hs-scripts\.com|optimizely\.com|launchdarkly\.com|bugsnag\.com|cookielaw\.org|onetrust\.com|cookiebot\.com|trustarc\.com|adservice|adsystem|tiktok\.com\/i18n\/pixel|snap\.licdn\.com|linkedin\.com\/px|bat\.bing\.com)/i;
