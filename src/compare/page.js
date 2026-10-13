import { compareElements, compareForms, compareImages } from "./elements.js";
import { compareText, suspiciousText } from "./text.js";
import { compareGrids } from "./grids.js";
import { compareCharts } from "./charts.js";
import { normalizeRequestUrl } from "../urls.js";
import { truncate } from "../util/misc.js";

/**
 * @typedef {import("../capture.js").Snapshot} Snapshot
 * @typedef {import("./elements.js").AddFinding} AddFinding
 */

const IMPACT_RANK = /** @type {Record<string, number>} */ ({ minor: 0, moderate: 1, serious: 2, critical: 3 });
const LOGINISH = /(log-?in|sign-?in|auth|sso|session|oauth|saml|cas\/|openid)/i;

/** A request is "failed" if it errored or returned 4xx/5xx — but not if we blocked or aborted it. */
export function failedRequests(/** @type {import("../instrument.js").RequestRecord[]} */ requests) {
  return requests.filter((r) => !r.noise && !r.blocked && r.failure !== "aborted" && (r.failure || (r.status != null && r.status >= 400)));
}

/**
 * Compare two snapshots of the same page. Returns extra data for the report
 * (text diff) alongside the findings it adds.
 * @param {Snapshot} b baseline
 * @param {Snapshot} c candidate
 * @param {{ add: AddFinding, cfg: import("../config.js").Config, scopes: { baseline: import("../urls.js").Scope, candidate: import("../urls.js").Scope }, tokens: { baseline: string[], candidate: string[] }, primary: boolean, seen?: Set<string> }} ctx
 *   `seen` is shared across pages: site-wide changes (header, footer) are reported on the first page only.
 */
export function comparePages(b, c, ctx) {
  const { add, cfg } = ctx;
  const seen = ctx.seen ?? new Set();
  const where = { page: b.key, viewport: b.viewport };
  /** @type {{ text?: ReturnType<typeof compareText> }} */
  const extra = {};

  // ---- can both be loaded at all? ------------------------------------------
  const okB = !b.error && (b.status == null || b.status < 400);
  const okC = !c.error && (c.status == null || c.status < 400);
  if (okB && !okC) {
    add({
      ...where,
      severity: "critical",
      category: "availability",
      type: "page.unavailable",
      title: c.error ? `Page fails to load on candidate: ${truncate(c.error, 140)}` : `Page returns HTTP ${c.status} on candidate (baseline: ${b.status ?? "OK"})`,
      baseline: b.status ?? "OK",
      candidate: c.error ?? c.status,
      fp: "unavailable",
    });
    return extra;
  }
  if (!okB || !okC) {
    add({
      ...where,
      severity: okC ? "info" : b.status !== c.status ? "minor" : "info",
      category: "availability",
      type: okC ? "page.fixed" : "page.broken-both",
      title: okC
        ? `Page works on candidate but fails on baseline (${b.error ? truncate(b.error, 80) : `HTTP ${b.status}`})`
        : `Page fails on both (baseline: ${b.error ? truncate(b.error, 60) : b.status}, candidate: ${c.error ? truncate(c.error, 60) : c.status})`,
      baseline: b.error ?? b.status,
      candidate: c.error ?? c.status,
      fp: "broken",
    });
    return extra;
  }

  // ---- where did we end up? -------------------------------------------------
  if (b.finalKey !== c.finalKey) {
    const leftSite = c.finalKey === null;
    const hint = LOGINISH.test(c.finalUrl) && !LOGINISH.test(b.finalUrl) ? " — looks like a login page; is the session/auth set up for this environment?" : "";
    const bothLeft = b.finalKey === null && leftSite;
    const sameHost = bothLeft && safeHost(b.finalUrl) === safeHost(c.finalUrl);
    if (!sameHost) {
      add({
        ...where,
        severity: "major",
        category: "availability",
        type: "page.redirect",
        title: leftSite
          ? `Candidate redirects off-site to ${truncate(c.finalUrl, 100)}${hint}`
          : `Candidate ends up at ${c.finalKey} (baseline: ${b.finalKey ?? truncate(b.finalUrl, 80)})${hint}`,
        baseline: b.finalUrl,
        candidate: c.finalUrl,
        fp: "redirect",
      });
    }
  }

  compareLogs(b, c, { add, where });

  if (!b.dom || !c.dom) return extra;
  const domB = b.dom;
  const domC = c.dom;

  // ---- controls, forms, images ---------------------------------------------
  compareElements(/** @type {any} */ (domB), /** @type {any} */ (domC), { add, where, tolerance: cfg.layout.tolerance, layout: cfg.layout.enabled, seen });
  if (ctx.primary) compareForms(domB.forms, domC.forms, { add, where });
  const imgNorm = (/** @type {string} */ side) => (/** @type {string} */ src) =>
    normalizeRequestUrl(src, ctx.scopes[/** @type {"baseline"|"candidate"} */ (side)], ctx.tokens[/** @type {"baseline"|"candidate"} */ (side)]);
  compareImages(
    domB.images.map((i) => ({ ...i, src: imgNorm("baseline")(i.src) })),
    domC.images.map((i) => ({ ...i, src: imgNorm("candidate")(i.src) })),
    (s) => s,
    { add, where },
  );

  // ---- grids and charts -------------------------------------------------------
  const sameData = cfg.data === "same";
  compareGrids(/** @type {any} */ (domB).grids ?? [], /** @type {any} */ (domC).grids ?? [], { add, where, sameData });
  compareCharts(/** @type {any} */ (domB).charts ?? [], /** @type {any} */ (domC).charts ?? [], { add, where, sameData });

  // ---- text -------------------------------------------------------------------
  if (cfg.text.enabled) {
    const text = compareText(domB.text, domC.text, cfg);
    if (text.removed || text.added) {
      extra.text = text;
      // Lines already reported on another page (a changed footer) aren't news here.
      const changed = text.lines.filter((l) => l.op === "-" || l.op === "+");
      const fresh = changed.filter((l) => !seen.has(`text|${l.op}|${l.text}`));
      for (const l of changed) seen.add(`text|${l.op}|${l.text}`);
      const removed = fresh.filter((l) => l.op === "-").length;
      const added = fresh.filter((l) => l.op === "+").length;
      if (fresh.length) {
        add({
          ...where,
          severity: cfg.text.severity,
          category: "content",
          type: "content.text",
          title: `Text changed: ${removed} line${removed === 1 ? "" : "s"} removed, ${added} added${fresh.length < changed.length ? " (plus changes already reported on other pages)" : ""}`,
          detail: fresh
            .slice(0, 12)
            .map((l) => `${l.op} ${truncate(l.text, 140)}`)
            .join("\n"),
          fp: "text",
        });
      }
    }
  }
  for (const s of suspiciousText(domB.text, domC.text)) {
    const samples = s.samples.filter((x) => !seen.has(`sus|${s.name}|${x}`));
    for (const x of s.samples) seen.add(`sus|${s.name}|${x}`);
    if (s.samples.length && !samples.length) continue;
    add({
      ...where,
      severity: "major",
      category: "content",
      type: "content.suspicious",
      title: `Candidate shows ${s.name}: "${truncate(s.samples[0] ?? "", 100)}"`,
      detail: `${s.candidate} line(s) on candidate vs ${s.baseline} on baseline.\n${s.samples.map((x) => `• ${truncate(x, 160)}`).join("\n")}`,
      baseline: s.baseline,
      candidate: s.candidate,
      fp: s.name,
    });
  }

  if (!ctx.primary) {
    checkOverflow(domB, domC, add, where);
    return extra;
  }

  // ---- metadata -----------------------------------------------------------
  if (normTitle(b.dom.title) !== normTitle(c.dom.title)) {
    add({
      ...where,
      severity: "minor",
      category: "seo",
      type: "seo.title",
      title: `Page title changed: "${truncate(b.dom.title, 60)}" → "${truncate(c.dom.title, 60)}"`,
      baseline: b.dom.title,
      candidate: c.dom.title,
      fp: "title",
    });
  }
  const noindex = (/** @type {Snapshot} */ s) => /noindex/i.test(`${s.dom?.meta.robots ?? ""} ${s.headers["x-robots-tag"] ?? ""}`);
  if (!noindex(b) && noindex(c)) {
    add({ ...where, severity: "major", category: "seo", type: "seo.noindex", title: "Candidate tells search engines not to index this page (noindex)", fp: "noindex" });
  }
  const canon = (/** @type {Snapshot} */ s, /** @type {"baseline"|"candidate"} */ side) =>
    s.dom?.meta.canonical ? ctx.scopes[side].keyOf(s.dom.meta.canonical) ?? s.dom.meta.canonical : "";
  if (canon(b, "baseline") !== canon(c, "candidate")) {
    add({
      ...where,
      severity: "minor",
      category: "seo",
      type: "seo.canonical",
      title: `Canonical URL changed: ${canon(b, "baseline") || "(none)"} → ${canon(c, "candidate") || "(none)"}`,
      fp: "canonical",
    });
  }
  if (b.dom.lang !== c.dom.lang) {
    add({ ...where, severity: "minor", category: "seo", type: "seo.lang", title: `Document language changed: "${b.dom.lang}" → "${c.dom.lang}"`, fp: "lang" });
  }

  // ---- security headers on the document -----------------------------------
  for (const h of ["strict-transport-security", "content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy"]) {
    if (b.headers[h] && !c.headers[h]) {
      add({
        ...where,
        severity: "minor",
        category: "security",
        type: "security.header",
        title: `Response header ${h} is missing on candidate`,
        baseline: b.headers[h],
        fp: h,
      });
    }
  }

  checkOverflow(domB, domC, add, where);

  // ---- accessibility --------------------------------------------------------
  if (b.a11y && c.a11y) {
    const min = IMPACT_RANK[cfg.a11y.minImpact] ?? 1;
    const before = new Map(b.a11y.map((v) => [v.id, v]));
    for (const v of c.a11y) {
      if ((IMPACT_RANK[v.impact] ?? 0) < min) continue;
      const was = before.get(v.id)?.count ?? 0;
      if (v.count <= was) continue;
      const serious = (IMPACT_RANK[v.impact] ?? 0) >= 2;
      add({
        ...where,
        severity: was === 0 ? (serious ? "major" : "minor") : serious ? "minor" : "info",
        category: "a11y",
        type: `a11y.${v.id}`,
        title: `Accessibility (${v.impact}): ${v.help} — ${v.count} element${v.count === 1 ? "" : "s"}${was ? `, was ${was}` : ", new"}`,
        detail: `${v.targets.join("\n")}\n${v.helpUrl}`,
        baseline: was,
        candidate: v.count,
        fp: v.id,
      });
    }
  }

  // ---- performance ------------------------------------------------------------
  const pb = domB.perf;
  const pc = domC.perf;
  if (cfg.perf.enabled && pb && pc) {
    /** @type {string[]} */
    const slower = [];
    for (const [k, label] of /** @type {[string, string][]} */ ([
      ["ttfb", "server response (TTFB)"],
      ["fcp", "first paint"],
      ["lcp", "largest paint (LCP)"],
      ["load", "load"],
    ])) {
      const x = pb[k];
      const y = pc[k];
      if (x == null || y == null) continue;
      if (y > x * (1 + cfg.perf.tolerance) && y - x > cfg.perf.minDeltaMs) slower.push(`${label} ${ms(x)} → ${ms(y)}`);
    }
    if (pc.cls - pb.cls > 0.1) slower.push(`layout shift (CLS) ${pb.cls} → ${pc.cls}`);
    if (pc.transferKB > pb.transferKB * 1.5 && pc.transferKB - pb.transferKB > 500) slower.push(`page weight ${pb.transferKB}KB → ${pc.transferKB}KB`);
    if (slower.length) {
      add({
        ...where,
        severity: "minor",
        category: "perf",
        type: "perf.slower",
        title: `Slower on candidate: ${slower.join(", ")}`,
        detail: "Environments often differ in hardware and caching; treat as a lead, not a verdict.",
        baseline: pb,
        candidate: pc,
        fp: "perf",
      });
    }
  }
  return extra;
}

/**
 * Responsive breakage: the candidate scrolls sideways where the baseline didn't.
 * @param {any} domB
 * @param {any} domC
 * @param {AddFinding} add
 * @param {{ page: string, viewport: string }} where
 */
function checkOverflow(domB, domC, add, where) {
  const overflow = (/** @type {any} */ d) => d.doc.scrollWidth > d.doc.clientWidth + 2;
  if (!overflow(domB) && overflow(domC)) {
    add({
      ...where,
      severity: "major",
      category: "layout",
      type: "layout.overflow",
      title: `Page scrolls sideways on candidate (content ${domC.doc.scrollWidth}px wide in a ${domC.doc.clientWidth}px viewport)`,
      baseline: domB.doc.scrollWidth,
      candidate: domC.doc.scrollWidth,
      fp: "overflow",
    });
  }
}

/**
 * Errors and failed requests that the candidate has and the baseline doesn't.
 * Shared by page loads and interactions.
 * @param {{ log: import("../instrument.js").PageLog }} b
 * @param {{ log: import("../instrument.js").PageLog }} c
 * @param {{ add: AddFinding, where: Record<string, any>, context?: string }} ctx
 */
export function compareLogs(b, c, { add, where, context = "" }) {
  const suffix = context ? ` ${context}` : "";
  const seenErr = new Set(b.log.errors.map((e) => e.norm));
  const newErrors = uniqueBy(c.log.errors.filter((e) => !seenErr.has(e.norm)), (e) => e.norm);
  for (const e of newErrors.slice(0, 5)) {
    add({
      ...where,
      severity: "critical",
      category: "errors",
      type: "errors.uncaught",
      title: `Uncaught exception on candidate${suffix}: ${truncate(e.message, 160)}`,
      candidate: e.message,
      fp: `err:${e.norm}`,
    });
  }
  const consoleErrors = (/** @type {typeof b.log.console} */ list) => list.filter((m) => m.type === "error" || m.type === "assert");
  const seenConsole = new Set(consoleErrors(b.log.console).map((m) => m.norm));
  const newConsole = uniqueBy(consoleErrors(c.log.console).filter((m) => !seenConsole.has(m.norm)), (m) => m.norm);
  for (const m of newConsole.slice(0, 5)) {
    add({
      ...where,
      severity: "major",
      category: "errors",
      type: "errors.console",
      title: `Console error on candidate${suffix}: ${truncate(m.text, 160)}`,
      candidate: m.text,
      fp: `console:${m.norm}`,
    });
  }
  if (newConsole.length > 5) {
    add({
      ...where,
      severity: "major",
      category: "errors",
      type: "errors.console",
      title: `${newConsole.length - 5} more new console errors on candidate${suffix}`,
      detail: newConsole.slice(5, 30).map((m) => truncate(m.text, 200)).join("\n"),
      fp: "console:more",
    });
  }

  const okB = new Map();
  for (const r of b.log.requests) if (!r.noise && !r.blocked && r.status != null && r.status < 400) okB.set(r.key, r.status);
  const failB = new Set(failedRequests(b.log.requests).map((r) => r.key));
  const newFailures = uniqueBy(failedRequests(c.log.requests).filter((r) => !failB.has(r.key)), (r) => r.key);
  for (const r of newFailures.slice(0, 10)) {
    const important = r.firstParty && ["document", "script", "stylesheet", "xhr", "fetch"].includes(r.type);
    const was = okB.get(r.key);
    add({
      ...where,
      severity: important ? "major" : "minor",
      category: "network",
      type: important ? "network.failed" : "network.failed-asset",
      title: `${r.method} ${truncate(r.sameOrigin ? pathOf(r.url) : shortUrl(r.url), 90)} ${r.failure ? `fails (${r.failure})` : `returns ${r.status}`} on candidate${suffix}${was ? ` (baseline: ${was})` : ""}`,
      baseline: was ?? null,
      candidate: r.failure ?? r.status,
      fp: `req:${r.key}`,
    });
  }
}

/**
 * @template T
 * @param {T[]} list
 * @param {(x: T) => string} key
 */
function uniqueBy(list, key) {
  const seen = new Set();
  return list.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Path and query of a URL: same-origin requests read better without the host. @param {string} url */
function pathOf(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return url;
  }
}

/** @param {string} url */
export function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return url;
  }
}

/** @param {string} url */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Titles often carry the environment name ("Shop [UAT]"); compare without it. */
const normTitle = (/** @type {string} */ t) =>
  String(t ?? "")
    .replace(/[[(]?\b(dev|development|qa|test|uat|stage|staging|preprod|pre-prod|sandbox|local|localhost|preview)\b[\])]?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** @param {number} n */
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
