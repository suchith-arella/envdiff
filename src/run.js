import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DENY_PATHS, atLeast } from "./config.js";
import { resolveTargets } from "./targets.js";
import { deriveScopes, envTokens, looksLikeAsset, routePattern } from "./urls.js";
import { launchBrowser, createSession, authenticate } from "./session.js";
import { capturePage } from "./capture.js";
import { annotateElements } from "./match.js";
import { comparePages } from "./compare/page.js";
import { diffImages, describeRegion } from "./compare/visual.js";
import { createApiTracker } from "./compare/api.js";
import { explorePage, pruneShots } from "./explore.js";
import { runJourneys } from "./journeys.js";
import { createFindings, countBySeverity } from "./findings.js";
import { writeReports } from "./report/index.js";
import { createLogger, formatDuration, color } from "./util/log.js";
import { createQueue, compilePatterns, matchesAny, mapLimit, shortHash, slugify, truncate } from "./util/misc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version;

/** Files this tool writes; only these are removed when a report directory is reused. */
const OWN_FILES = ["index.html", "report.json", "summary.md", "junit.xml"];

/**
 * Run a full comparison.
 * @param {import("./config.js").ResolvedConfig} cfg Resolved config.
 * @param {{ log?: import("./util/log.js").Logger, signal?: AbortSignal }} [opts]
 *   `signal` stops the run early (Ctrl+C); what was compared so far is still reported.
 * @returns {Promise<{ report: any, exitCode: number }>}
 */
export async function run(cfg, opts = {}) {
  const log = opts.log ?? createLogger();
  const started = Date.now();
  const deadline = started + cfg.timeouts.total;
  const stopped = () => Date.now() > deadline || !!opts.signal?.aborted;
  const outDir = path.resolve(cfg.report.outDir);
  await prepareOutDir(outDir);
  const assetPath = (/** @type {string} */ name) => `assets/${name}`;

  const findings = createFindings(cfg);
  const api = createApiTracker();
  /** @type {any[]} */
  const pages = [];
  /** @type {any[]} */
  const journeys = [];
  /** @type {any[]} */
  const linkChecks = [];
  /** @type {{ page?: string, message: string }[]} */
  const errors = [];
  let browserVersion = "";

  const targets = await resolveTargets(cfg, { log, outDir });
  /** @type {import("playwright").Browser | null} */
  let browser = null;
  /** @type {ReturnType<typeof createCrawler> | null} */
  let crawler = null;
  let aborted = /** @type {string | null} */ (null);
  try {
    const { baseline: scopeB, candidate: scopeC, startKey } = deriveScopes(targets.baseline.url, targets.candidate.url, {
      baseline: cfg.baseline.basePath,
      candidate: cfg.candidate.basePath,
    });
    const scopes = { baseline: scopeB, candidate: scopeC };
    const tokens = envTokens(scopeB.host, scopeC.host);
    log.info(`${color.bold("baseline ")} ${targets.baseline.label}  ${color.dim(targets.baseline.url)}`);
    log.info(`${color.bold("candidate")} ${targets.candidate.label}  ${color.dim(targets.candidate.url)}`);
    if (!cfg.safety.allowMutations) log.info(color.dim("safety: POST/PUT/PATCH/DELETE are blocked (use --allow-mutations for disposable environments)"));

    browser = await launchBrowser(cfg);
    browserVersion = `${cfg.browser.name} ${browser.version()}`;

    // One session per environment per viewport. Log in once per environment
    // and start the other viewports from that state.
    /** @type {Record<string, { baseline: import("./session.js").EnvSession, candidate: import("./session.js").EnvSession }>} */
    const sessions = {};
    /** @type {Record<string, any>} */
    const authState = {};
    for (const [i, vp] of cfg.viewports.entries()) {
      /** @type {any} */
      const pair = {};
      for (const side of /** @type {const} */ (["baseline", "candidate"])) {
        pair[side] = await createSession(browser, {
          side,
          label: targets[side].label,
          cfg,
          viewport: vp,
          scope: scopes[side],
          tokens: tokens[side],
          storageState: authState[side],
        });
        const auth = cfg[side].auth ?? cfg.auth;
        if (i === 0 && auth) {
          log.info(`Logging in to ${targets[side].label}…`);
          authState[side] = await authenticate(pair[side], auth, { outDir, log });
        }
      }
      sessions[vp.name] = pair;
    }
    const primary = sessions[cfg.viewports[0].name];

    await preflight(primary, startKey, log);

    const crawl = createCrawler(cfg);
    crawler = crawl;
    /** Site-wide controls already clicked on another page. */
    /** @type {Set<string>} */
    const globalSeen = new Set();
    /** Site-wide changes already reported on another page. */
    /** @type {Set<string>} */
    const seenChanges = new Set();
    /** Which pages link to which, per side — to spot links the candidate added that lead nowhere. */
    /** @type {Map<string, { baseline: Set<string>, candidate: Set<string>, names: Set<string> }>} */
    const linkSources = new Map();
    let done = 0;
    const queue = createQueue({
      concurrency: cfg.concurrency,
      shouldStop: stopped,
      /** @param {{ key: string, depth: number }} item */
      worker: async (item) => {
        const t0 = Date.now();
        /** @type {Set<string>} */
        let ids = new Set();
        try {
          const r = await processPage(item);
          ids = r.ids;
          for (const k of r.discovered) offer(k, item.depth + 1);
          queue.sort((a, b) => a.depth - b.depth);
        } catch (e) {
          errors.push({ page: item.key, message: /** @type {Error} */ (e).message.split("\n")[0] });
          log.warn(`${item.key}: ${/** @type {Error} */ (e).message.split("\n")[0]}`);
        }
        done++;
        const added = [...ids].map((id) => findings.get(id)).filter(Boolean);
        const crit = added.filter((f) => f?.severity === "critical").length;
        const major = added.filter((f) => f?.severity === "major").length;
        const mine = pages.filter((p) => p.key === item.key);
        const ixCount = mine.reduce((s, p) => s + p.interactions.length, 0);
        const flakyCount = mine.reduce((s, p) => s + p.flaky.length + p.interactions.filter((/** @type {any} */ i) => i.flaky).length, 0);
        log.info(
          `${color.dim(`[${done}/${Math.min(crawler?.size ?? 0, cfg.crawl.maxPages)}]`)} ${item.key}  ${
            crit ? color.red(`${crit} critical `) : ""
          }${major ? color.yellow(`${major} major `) : ""}${!crit && !major ? color.green("ok ") : ""}${color.dim(
            `· ${ixCount} interactions${flakyCount ? ` · ${flakyCount} flaky (not reported)` : ""} · ${formatDuration(Date.now() - t0)}`,
          )}`,
        );
      },
    });
    /** Queue a page if the crawl rules accept it. */
    const offer = (/** @type {string} */ k, /** @type {number} */ depth, seed = false) => {
      if (crawl.enqueue(k, depth, seed)) queue.push({ key: k, depth });
    };
    const seeds =
      cfg.crawl.startPaths.length === 1 && cfg.crawl.startPaths[0] === "/"
        ? [startKey]
        : cfg.crawl.startPaths.map((p) => scopeB.keyOf(p.startsWith("http") ? p : scopeB.urlFor(p)) ?? p);
    for (const k of seeds) offer(k, 0, true);
    if (cfg.crawl.sitemap) for (const k of await sitemapKeys(primary.baseline, log)) offer(k, 1);

    /** @param {{ key: string, depth: number }} item */
    async function processPage({ key, depth }) {
      /** @type {Set<string>} */
      const discovered = new Set();
      /** @type {Set<string>} */
      const pageIds = new Set();
      /** @type {Set<string>} */
      const primaryTitles = new Set();
      for (const [i, vp] of cfg.viewports.entries()) {
        const s = sessions[vp.name];
        const isPrimary = i === 0;
        const slug = `${slugify(key, 40)}-${shortHash(key, 6)}-${vp.name}`;
        const captureBoth = async () => {
          const snaps = await Promise.all(
            /** @type {const} */ (["baseline", "candidate"]).map((side) =>
              capturePage(s[side], key, {
                outDir,
                file: assetPath(`${slug}-${side}.png`),
                a11y: isPrimary && cfg.a11y.enabled,
                perf: isPrimary && cfg.perf.enabled,
              }),
            ),
          );
          for (const [snap, scope] of /** @type {const} */ ([
            [snaps[0], scopeB],
            [snaps[1], scopeC],
          ])) {
            if (snap.dom) annotateElements(/** @type {any} */ (snap.dom.actionables), (href) => scope.keyOf(href, { ignoreQuery: cfg.crawl.ignoreQuery }));
          }
          return snaps;
        };
        /**
         * Everything that differs between two snapshots, held back rather
         * than reported so a second look can confirm it.
         * @param {import("./capture.js").Snapshot} b
         * @param {import("./capture.js").Snapshot} c
         */
        const judge = (b, c) => {
          /** @type {any[]} */
          const found = [];
          const hold = (/** @type {any} */ f) => (found.push(f), f);
          const seen = new Set(seenChanges);
          const extra = comparePages(b, c, { add: hold, cfg: isPrimary ? cfg : secondaryCfg(cfg), scopes, tokens, primary: isPrimary, seen });
          return { found, seen, extra, visual: compareScreens(b, c, hold) };
        };
        /**
         * @param {import("./capture.js").Snapshot} b
         * @param {import("./capture.js").Snapshot} c
         * @param {(f: any) => any} add
         */
        const compareScreens = (b, c, add) => {
          if (!b.screenshot || !c.screenshot) return null;
          const diffRel = assetPath(`${slug}-diff.png`);
          // A diff left by the first look must not outlive a second look that has none.
          fs.rmSync(path.join(outDir, diffRel), { force: true });
          const d = diffImages(path.join(outDir, b.screenshot), path.join(outDir, c.screenshot), path.join(outDir, diffRel), { threshold: cfg.visual.threshold });
          const visual = {
            ratio: Math.round(d.ratio * 10000) / 10000,
            size: { baseline: d.sizeA, candidate: d.sizeB },
            regions: d.regions.map((r) => ({ ...r, label: describeRegion(r, c.dom) })),
            diff: d.diffPixels ? diffRel : null,
            skipped: d.skipped,
          };
          // An error page looking different from a real page is already reported.
          if (d.ratio >= cfg.visual.minRatio && loaded(b) && loaded(c)) {
            const where = visual.regions.slice(0, 3).map((/** @type {any} */ r) => r.label);
            add({
              page: key,
              viewport: vp.name,
              severity: d.ratio >= cfg.visual.majorRatio ? "major" : "minor",
              category: "visual",
              type: "visual.diff",
              title: `Looks different: ${(d.ratio * 100).toFixed(1)}% of the page changed${where.length ? ` (${where.join("; ")})` : ""}`,
              evidence: { baseline: b.screenshot, candidate: c.screenshot, diff: diffRel },
              fp: "visual",
            });
          }
          return visual;
        };
        const loaded = (/** @type {import("./capture.js").Snapshot} */ s) => !s.error && (s.status == null || s.status < 400);

        let [b, c] = await captureBoth();
        let judged = judge(b, c);
        /** @type {string[]} */
        let flaky = [];
        if (cfg.stabilize.confirm && judged.found.length && !stopped()) {
          // Timing makes one-off differences: an environment still booting, a
          // slow response, an animation caught mid-way. Look again and keep
          // only what shows up both times.
          const first = judged.found;
          [b, c] = await captureBoth();
          judged = judge(b, c);
          const identity = (/** @type {any} */ f) => `${f.type}|${f.fp ?? ""}`;
          const firstIds = new Set(first.map(identity));
          const againIds = new Set(judged.found.map(identity));
          flaky = first.filter((f) => !againIds.has(identity(f))).map((f) => truncate(f.title, 200));
          judged.found = judged.found.filter((f) => firstIds.has(identity(f)));
        }
        for (const sig of judged.seen) seenChanges.add(sig);

        /** @type {Set<string>} */
        const ids = new Set();
        const add = (/** @type {any} */ f) => {
          // A secondary viewport repeating exactly what the primary one found
          // (a 404, a console error) adds nothing; keep only what differs by viewport.
          const same = `${f.type}|${f.title}`;
          if (isPrimary) primaryTitles.add(same);
          else if (primaryTitles.has(same)) return null;
          const r = findings.add(f);
          if (r) {
            ids.add(r.id);
            pageIds.add(r.id);
          }
          return r;
        };
        for (const f of judged.found) add(f);
        const { extra, visual } = judged;

        if (isPrimary) {
          api.record("baseline", b.log.api, key);
          api.record("candidate", c.log.api, key);
          for (const snap of [b, c]) {
            const side = snap === b ? "baseline" : "candidate";
            const scope = scopes[side];
            for (const href of snap.dom?.links ?? []) {
              const k = scope.keyOf(href, { ignoreQuery: cfg.crawl.ignoreQuery });
              if (!k) continue;
              discovered.add(k);
              const src = linkSources.get(k) ?? { baseline: new Set(), candidate: new Set(), names: new Set() };
              src[side].add(key);
              linkSources.set(k, src);
            }
            for (const e of /** @type {any[]} */ (snap.dom?.actionables ?? [])) {
              if (side === "candidate" && e.kind === "link" && e.hrefKey && e.name) linkSources.get(e.hrefKey)?.names.add(e.name);
            }
            if (snap.finalKey && snap.finalKey !== key) discovered.add(snap.finalKey);
          }
        }

        /** @type {any[]} */
        let interactions = [];
        /** @type {any[]} */
        let skipped = [];
        const canExplore = cfg.explore.enabled && cfg.explore.maxActionsPerPage > 0 && (isPrimary || cfg.explore.viewports === "all");
        if (canExplore && b.dom && c.dom && !b.error && !c.error && b.finalKey === key && !stopped()) {
          const r = await explorePage({
            key,
            sessions: s,
            doms: { baseline: b.dom, candidate: c.dom },
            cfg,
            add,
            outDir,
            assetPath,
            globalSeen,
            stopped,
            pageVisualRatio: visual?.ratio ?? 0,
            log,
          });
          interactions = r.interactions;
          skipped = r.skipped;
          for (const k of r.discovered) discovered.add(k);
          if (cfg.report.screenshots !== "all") for (const ix of interactions) if (ix.verdict === "same") pruneShots(ix, outDir);
        }

        pages.push({
          key,
          viewport: vp.name,
          depth,
          baseline: snapSummary(b),
          candidate: snapSummary(c),
          visual,
          text: extra.text ?? null,
          interactions,
          skipped: skipped.slice(0, 100),
          findings: [...ids],
          flaky,
        });
      }
      return { discovered, ids: pageIds };
    }

    await queue.onIdle();
    if (opts.signal?.aborted) {
      aborted = "Stopped early by request; results are partial.";
      log.warn(aborted);
    } else if (Date.now() > deadline) {
      aborted = `Stopped after ${formatDuration(cfg.timeouts.total)} (timeouts.total); results are partial.`;
      log.warn(aborted);
    }

    if (cfg.crawl.checkLinks && crawler.overflow.size && !stopped()) {
      log.info(`Checking ${Math.min(crawler.overflow.size, cfg.crawl.maxLinkChecks)} links that were not crawled…`);
      linkChecks.push(...(await checkLinks([...crawler.overflow].slice(0, cfg.crawl.maxLinkChecks), primary, cfg, findings.add)));
    }

    reportBrokenNewLinks(linkSources, pages, linkChecks, cfg.viewports[0].name, findings.add);

    if (cfg.journeys.length && !stopped()) {
      log.info(`Running ${cfg.journeys.length} journey(s)…`);
      journeys.push(...(await runJourneys({ sessions: primary, cfg, add: findings.add, outDir, assetPath, log, stopped })));
    }

    api.compare(findings.add);
  } finally {
    await browser?.close().catch(() => {});
    await targets.stop();
  }

  // Pages finish in whatever order the workers get to them; report them in
  // crawl order so two runs of the same comparison read the same way.
  const vpOrder = new Map(cfg.viewports.map((v, i) => [v.name, i]));
  pages.sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key) || (vpOrder.get(a.viewport) ?? 0) - (vpOrder.get(b.viewport) ?? 0));
  const all = findings.all();
  const counts = countBySeverity(all);
  const failing = all.filter((f) => atLeast(f.severity, cfg.report.failOn));
  const report = {
    tool: { name: "envdiff", version: VERSION },
    meta: {
      title: cfg.report.title ?? `${targets.baseline.label} vs ${targets.candidate.label}`,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      baseline: { label: targets.baseline.label, url: targets.baseline.url, ref: targets.baseline.ref, sha: targets.baseline.sha },
      candidate: { label: targets.candidate.label, url: targets.candidate.url, ref: targets.candidate.ref, sha: targets.candidate.sha },
      viewports: cfg.viewports.map((v) => `${v.name} ${v.width}×${v.height}`),
      browser: browserVersion,
      settings: {
        maxPages: cfg.crawl.maxPages,
        maxDepth: cfg.crawl.maxDepth,
        explore: cfg.explore.enabled ? `${cfg.explore.maxActionsPerPage} actions/page, depth ${cfg.explore.depth}` : "off",
        mutations: cfg.safety.allowMutations ? "allowed" : "blocked",
        failOn: cfg.report.failOn,
      },
      aborted,
    },
    summary: {
      verdict: failing.length ? "fail" : "pass",
      failOn: cfg.report.failOn,
      counts,
      failing: failing.length,
      pages: new Set(pages.map((p) => p.key)).size,
      interactions: pages.reduce((s, p) => s + p.interactions.length, 0),
      interactionsDifferent: pages.reduce((s, p) => s + p.interactions.filter((/** @type {any} */ i) => i.verdict === "different").length, 0),
      /** Differences seen once that didn't happen again when repeated: timing, not reported. */
      flaky: pages.reduce((s, p) => s + p.flaky.length + p.interactions.filter((/** @type {any} */ i) => i.flaky).length, 0),
      journeys: journeys.length,
      suppressed: findings.suppressed,
      notCrawled: crawler ? crawler.overflow.size : 0,
    },
    findings: all,
    pages,
    journeys,
    api: api.summary(),
    linkChecks,
    crawl: crawler ? { skippedByPattern: crawler.skippedByPattern, notCrawled: [...crawler.overflow].slice(0, 300) } : null,
    errors,
  };

  if (cfg.ai.enabled) {
    try {
      const { triage } = await import("./ai/triage.js");
      await triage(report, { cfg, outDir, log });
    } catch (e) {
      log.warn(`AI triage skipped: ${/** @type {Error} */ (e).message}`);
      /** @type {any} */ (report).ai = { error: /** @type {Error} */ (e).message };
    }
  }

  await writeReports(outDir, report);
  for (const f of failing.slice(0, 10)) {
    log.annotate(f.severity === "critical" ? "error" : "warning", `envdiff ${f.severity}: ${f.page ?? f.journey ?? ""}`, f.title);
  }
  return { report, exitCode: failing.length ? 1 : 0 };
}

/**
 * Pages in secondary viewports only need what can differ by viewport.
 * @param {import("./config.js").Config} cfg
 */
function secondaryCfg(cfg) {
  return { ...cfg, text: { ...cfg.text, enabled: false }, perf: { ...cfg.perf, enabled: false } };
}

/** @param {import("./capture.js").Snapshot} s */
function snapSummary(s) {
  return {
    url: s.url,
    finalUrl: s.finalUrl,
    status: s.status,
    error: s.error,
    loadMs: s.loadMs,
    redirects: s.redirects,
    unstable: s.unstable ?? false,
    title: s.dom?.title ?? null,
    screenshot: s.screenshot,
    counts: s.dom
      ? {
          controls: s.dom.actionables.length,
          links: s.dom.links.length,
          images: s.dom.images.length,
          forms: s.dom.forms.length,
          textLines: s.dom.text.length,
          consoleErrors: s.log.console.filter((m) => m.type === "error").length,
          pageErrors: s.log.errors.length,
          failedRequests: s.log.requests.filter((r) => !r.noise && !r.blocked && r.failure !== "aborted" && (r.failure || (r.status ?? 0) >= 400)).length,
          blockedRequests: s.log.requests.filter((r) => r.blocked).length,
        }
      : null,
    perf: s.dom?.perf ?? null,
    a11y: s.a11y ? s.a11y.map((v) => ({ id: v.id, impact: v.impact, count: v.count, help: v.help })) : null,
  };
}

/**
 * Which pages to visit: breadth-first, deduplicated by route shape, bounded.
 * @param {import("./config.js").Config} cfg
 */
function createCrawler(cfg) {
  const include = compilePatterns(cfg.crawl.include);
  const exclude = compilePatterns([...cfg.crawl.exclude, ...DEFAULT_DENY_PATHS]);
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {Map<string, number>} */
  const patterns = new Map();
  /** @type {Map<string, Set<string>>} */
  const siblings = new Map();
  /** @type {Set<string>} */
  const variablePrefixes = new Set();
  /** @type {Set<string>} */
  const overflow = new Set();
  let skippedByPattern = 0;

  /** @param {string} key */
  const allowed = (key) => {
    if (looksLikeAsset(key)) return false;
    const path = key.split(/[?#]/)[0];
    if (include.length && !matchesAny(include, key)) return false;
    if (matchesAny(exclude, path) || matchesAny(exclude, key)) return false;
    return true;
  };

  return {
    /**
     * @param {string} key
     * @param {number} depth
     * @param {boolean} [seed] Start pages bypass the per-pattern limit.
     * @returns {boolean} whether the page should be queued
     */
    enqueue(key, depth, seed = false) {
      if (seen.has(key) || !allowed(key)) return false;
      if (depth > cfg.crawl.maxDepth) return false;
      // Many siblings under one parent (/blog/a, /blog/b, …) means the last
      // segment is data, even without digits in it.
      const pathOnly = key.split(/[?#]/)[0];
      const cut = pathOnly.lastIndexOf("/");
      if (cut > 0) {
        const parent = pathOnly.slice(0, cut);
        const set = siblings.get(parent) ?? new Set();
        set.add(pathOnly.slice(cut + 1));
        siblings.set(parent, set);
        if (set.size > 10) variablePrefixes.add(parent);
      }
      const pattern = routePattern(key, variablePrefixes);
      const n = patterns.get(pattern) ?? 0;
      if (!seed && n >= cfg.crawl.samplesPerPattern) {
        skippedByPattern++;
        return false;
      }
      if (seen.size >= cfg.crawl.maxPages) {
        if (overflow.size < 1000) overflow.add(key);
        return false;
      }
      patterns.set(pattern, n + 1);
      seen.set(key, depth);
      return true;
    },
    get size() {
      return seen.size;
    },
    overflow,
    get skippedByPattern() {
      return skippedByPattern;
    },
  };
}

/**
 * Make sure both environments answer before spending minutes on them.
 * @param {{ baseline: import("./session.js").EnvSession, candidate: import("./session.js").EnvSession }} sessions
 * @param {string} startKey
 * @param {import("./util/log.js").Logger} log
 */
async function preflight(sessions, startKey, log) {
  const results = await Promise.all(
    /** @type {const} */ (["baseline", "candidate"]).map(async (side) => {
      const s = sessions[side];
      const page = await s.context.newPage();
      try {
        const res = await page.goto(s.scope.urlFor(startKey), { waitUntil: "domcontentloaded", timeout: s.cfg.timeouts.navigation });
        return { side, ok: true, status: res?.status() ?? null };
      } catch (e) {
        return { side, ok: false, error: /** @type {Error} */ (e).message.split("\n")[0].replace(/^page\.goto: /, "") };
      } finally {
        await page.close().catch(() => {});
      }
    }),
  );
  const dead = results.filter((r) => !r.ok);
  if (dead.length) {
    throw new Error(
      dead.map((r) => `${sessions[/** @type {"baseline"|"candidate"} */ (r.side)].label} is unreachable: ${r.error}`).join("\n") +
        "\nNothing to compare. Check the URL, VPN/network access, and HTTP auth.",
    );
  }
  for (const r of results) if (r.status && r.status >= 400) log.warn(`${sessions[r.side].label} answers ${startKey} with HTTP ${r.status}`);
}

/**
 * @param {import("./session.js").EnvSession} session
 * @param {import("./util/log.js").Logger} log
 */
async function sitemapKeys(session, log) {
  try {
    const res = await session.context.request.get(session.scope.urlFor("/sitemap.xml"), { timeout: 15000 });
    if (!res.ok()) return [];
    let xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    // A sitemap index points at more sitemaps; follow a few.
    if (/<sitemapindex/i.test(xml)) {
      const nested = [];
      for (const loc of locs.slice(0, 5)) {
        const r = await session.context.request.get(loc, { timeout: 15000 }).catch(() => null);
        if (r?.ok()) nested.push(...[...(await r.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]));
      }
      xml = "";
      locs.splice(0, locs.length, ...nested);
    }
    const keys = locs.map((l) => session.scope.keyOf(l)).filter((k) => k !== null);
    log.info(`sitemap: ${keys.length} pages`);
    return /** @type {string[]} */ (keys);
  } catch {
    return [];
  }
}

/**
 * Links that only the candidate has, pointing at pages that fail on the
 * candidate: a page that "fails on both" is still a regression when only the
 * new code links to it.
 * @param {Map<string, { baseline: Set<string>, candidate: Set<string>, names: Set<string> }>} sources
 * @param {any[]} pages
 * @param {any[]} linkChecks
 * @param {string} viewport Primary viewport name.
 * @param {(f: any) => any} add
 */
function reportBrokenNewLinks(sources, pages, linkChecks, viewport, add) {
  /** @type {Map<string, any>} */
  const status = new Map();
  for (const p of pages) if (p.viewport === viewport) status.set(p.key, p.candidate.error ?? p.candidate.status);
  for (const l of linkChecks) if (!status.has(l.key)) status.set(l.key, l.candidate);
  for (const [key, src] of sources) {
    if (src.baseline.size || !src.candidate.size) continue;
    const s = status.get(key);
    const broken = typeof s === "number" ? s >= 400 : typeof s === "string" && s.length > 0;
    if (!broken) continue;
    const from = [...src.candidate].slice(0, 3);
    const names = [...src.names].slice(0, 2).map((n) => `"${truncate(n, 30)}"`).join(", ");
    add({
      page: from[0],
      viewport,
      severity: "major",
      category: "links",
      type: "links.broken-new",
      title: `Candidate links${names ? ` (${names})` : ""} to ${truncate(key, 60)}, which ${typeof s === "number" ? `returns ${s}` : `fails (${truncate(s, 60)})`}`,
      detail: `Linked from ${from.join(", ")}${src.candidate.size > 3 ? ` and ${src.candidate.size - 3} more` : ""}. The baseline has no link to this page.`,
      fp: key,
    });
  }
}

/**
 * Status of links that were found but not crawled (over the page budget).
 * @param {string[]} keys
 * @param {{ baseline: import("./session.js").EnvSession, candidate: import("./session.js").EnvSession }} sessions
 * @param {import("./config.js").Config} cfg
 * @param {(f: any) => any} add
 */
async function checkLinks(keys, sessions, cfg, add) {
  /** @param {import("./session.js").EnvSession} s @param {string} key */
  const status = async (s, key) => {
    try {
      const res = await s.context.request.get(s.scope.urlFor(key), {
        timeout: 15000,
        maxRedirects: 5,
        headers: cfg[s.side].headers ?? {},
        failOnStatusCode: false,
      });
      return res.status();
    } catch (e) {
      return /** @type {Error} */ (e).message.split("\n")[0].slice(0, 80);
    }
  };
  const results = await mapLimit(keys, 6, async (key) => {
    const [b, c] = await Promise.all([status(sessions.baseline, key), status(sessions.candidate, key)]);
    const ok = (/** @type {any} */ x) => typeof x === "number" && x < 400;
    if (ok(b) && !ok(c)) {
      add({
        page: key,
        severity: "major",
        category: "links",
        type: "links.broken",
        title: `Link ${truncate(key, 80)} ${typeof c === "number" ? `returns ${c}` : `fails (${c})`} on candidate (baseline: ${b})`,
        fp: "link",
      });
    }
    return { key, baseline: b, candidate: c };
  });
  return results;
}

/** @param {string} outDir */
async function prepareOutDir(outDir) {
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.rm(path.join(outDir, "assets"), { recursive: true, force: true });
  for (const f of OWN_FILES) await fsp.rm(path.join(outDir, f), { force: true });
  for (const f of await fsp.readdir(outDir)) {
    if (/^(serve-(baseline|candidate)\.log|login-failed-(baseline|candidate)\.png)$/.test(f)) await fsp.rm(path.join(outDir, f), { force: true });
  }
  await fsp.mkdir(path.join(outDir, "assets"), { recursive: true });
}
