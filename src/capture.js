import path from "node:path";
import { busyIndicator, collectPage, finishAnimations, msSinceChange, pageFingerprint, readPerf, scrollStep } from "./inpage/collect.js";
import { instrumentPage } from "./instrument.js";
import { sleep } from "./util/misc.js";

/** A loading indicator still up this long after everything else went quiet never goes away. */
const BUSY_GIVE_UP_MS = 6000;

/**
 * Wait until the page stops changing: no network activity, DOM mutations,
 * scrolling, client-side navigation or long main-thread tasks for `quietMs`,
 * and no loading indicator (a grid's "Loading…" overlay, a spinner) on
 * screen. Bounded by `timeout`; returns whether it settled.
 * @param {import("playwright").Page} page
 * @param {import("./instrument.js").Instrumented} inst
 * @param {{ timeout?: number, quietMs?: number }} [opts]
 */
export async function settle(page, inst, opts = {}) {
  const timeout = opts.timeout ?? 3000;
  const quietMs = opts.quietMs ?? 400;
  const deadline = Date.now() + timeout;
  const busy = inst.busySelectors ?? [];
  let busySince = 0;
  await page.waitForLoadState("load", { timeout: Math.max(1, timeout) }).catch(() => {});
  while (Date.now() < deadline) {
    let quietFor = 0;
    try {
      quietFor = await page.evaluate(msSinceChange);
    } catch {
      // Mid-navigation: the old document is gone and the new one isn't ready.
      await sleep(100);
      continue;
    }
    if (quietFor >= quietMs && inst.networkQuiet(quietMs) && inst.navigationQuiet(quietMs)) {
      const spinning = busy.length ? await page.evaluate(busyIndicator, busy).catch(() => "") : "";
      if (!spinning) return true;
      busySince ||= Date.now();
      if (Date.now() - busySince > BUSY_GIVE_UP_MS) return true;
    } else {
      busySince = 0;
    }
    await sleep(100);
  }
  return false;
}

/**
 * Scroll through the page so lazy and scroll-revealed content renders, noting
 * at each step which controls are on show (some pages show a section only
 * while it is on screen). Apps that finish booting seconds after load run
 * their router again and re-render, which hides that content again; go round
 * once more when that happens.
 * @param {import("playwright").Page} page
 * @param {import("./instrument.js").Instrumented} inst
 * @param {import("./config.js").Config} cfg
 */
export async function revealAll(page, inst, cfg) {
  const census = { census: true, ignoreSelectors: cfg.ignore.selectors };
  for (let pass = 0; pass < 3; pass++) {
    const navigations = inst.log.navigations.length;
    await page.evaluate(collectPage, census).catch(() => {});
    // Bounded, so infinite feeds don't scroll forever.
    for (let step = 0; step < 25; step++) {
      const moved = await page.evaluate(scrollStep).catch(() => false);
      if (!moved) break;
      await sleep(100);
      await page.evaluate(collectPage, census).catch(() => {});
    }
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" })).catch(() => {});
    await settle(page, inst, { timeout: 4000, quietMs: 300 });
    if (inst.log.navigations.length === navigations) return;
  }
}

/**
 * Back to the top, with scroll-driven effects (sticky headers, scrollspy,
 * reveal animations) caught up. Fixed elements are drawn where the viewport
 * is, so a page left scrolled to a section would show its header halfway down
 * a full-page screenshot.
 * @param {import("playwright").Page} page
 * @param {import("./instrument.js").Instrumented} inst
 */
export async function scrollToTop(page, inst) {
  const moved = await page
    .evaluate(() => {
      if (scrollX === 0 && scrollY === 0) return false;
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      return true;
    })
    .catch(() => false);
  if (moved) await settle(page, inst, { timeout: 2500, quietMs: 250 });
}

/**
 * Navigate and wait for the page to be screenshot-ready.
 * @param {import("playwright").Page} page
 * @param {import("./instrument.js").Instrumented} inst
 * @param {string} url
 * @param {import("./config.js").Config} cfg
 * @param {{ perf?: boolean }} [opts]
 */
export async function loadPage(page, inst, url, cfg, opts = {}) {
  const started = Date.now();
  /** @type {import("playwright").Response | null} */
  let mainResponse = null;
  const onResponse = (/** @type {import("playwright").Response} */ res) => {
    if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) mainResponse = res;
  };
  page.on("response", onResponse);
  /** @type {string | null} */
  let error = null;
  /** @type {ReturnType<typeof readPerf> | null} */
  let perf = null;
  let revealedAt = 0;
  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: cfg.timeouts.navigation });
    if (res) mainResponse = res;
  } catch (e) {
    const msg = /** @type {Error} */ (e).message;
    // A 'load' that never fires (a hung third-party script) still leaves a
    // usable page. Only a page that never committed is a load failure.
    if (!/Timeout/i.test(msg) || page.url() === "about:blank") error = msg.split("\n")[0].replace(/^page\.goto: /, "");
  } finally {
    page.off("response", onResponse);
  }
  if (!error) {
    await settle(page, inst, { timeout: cfg.stabilize.maxWaitMs, quietMs: cfg.stabilize.quietMs });
    // Before we touch anything: our scrolling reveals content that would
    // otherwise count as the page's largest paint, and clicks end LCP.
    if (opts.perf) perf = await page.evaluate(readPerf).catch(() => null);
    if (cfg.stabilize.dismissConsent && (await dismissConsent(page))) await settle(page, inst, { timeout: 2000, quietMs: 300 });
    await page
      .evaluate(() => Promise.race([document.fonts ? document.fonts.ready : null, new Promise((r) => setTimeout(r, 3000))]))
      .catch(() => {});
    if (cfg.stabilize.scroll) await revealAll(page, inst, cfg);
    revealedAt = inst.log.navigations.length;
    await waitForImages(page, 4000);
  }
  /** @type {import("playwright").Response | null} */
  const res = mainResponse;
  /** @type {string[]} */
  const redirects = [];
  if (res) {
    let req = /** @type {import("playwright").Response} */ (res).request().redirectedFrom();
    while (req) {
      redirects.unshift(req.url());
      req = req.redirectedFrom();
    }
  }
  return {
    error,
    perf,
    /** Client-side navigations seen by the time the page was scrolled through. */
    revealedAt,
    status: res ? /** @type {import("playwright").Response} */ (res).status() : null,
    headers: res ? await /** @type {import("playwright").Response} */ (res).allHeaders().catch(() => ({})) : {},
    redirects,
    ms: Date.now() - started,
  };
}

/**
 * "Accept" buttons of the common consent managers. A banner left up covers
 * controls (clicks fail with "intercepts pointer events") and differs between
 * environments; dismissing it is the same harmless click a person makes.
 */
const CONSENT_BUTTONS = [
  "#onetrust-accept-btn-handler",
  "#accept-recommended-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  "#truste-consent-button",
  "#didomi-notice-agree-button",
  '[data-testid="uc-accept-all-button"]',
  ".fc-cta-consent",
  "#hs-eu-confirmation-button",
  ".cc-allow",
  ".cc-accept-all",
  ".cc-dismiss",
  'button[aria-label="Accept all cookies"]',
  'button[aria-label="Accept cookies"]',
];

/** @param {import("playwright").Page} page */
async function dismissConsent(page) {
  for (const sel of CONSENT_BUTTONS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 2000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

/** @param {import("playwright").Page} page @param {number} ms */
async function waitForImages(page, ms) {
  await page
    .evaluate(async (timeout) => {
      const pending = Array.from(document.images).filter((i) => !i.complete && i.getAttribute("src"));
      await Promise.race([
        Promise.all(
          pending.map(
            (i) =>
              new Promise((r) => {
                i.addEventListener("load", r, { once: true });
                i.addEventListener("error", r, { once: true });
              }),
          ),
        ),
        new Promise((r) => setTimeout(r, timeout)),
      ]);
    }, ms)
    .catch(() => {});
}

/**
 * Full-page screenshot with masks and hidden elements applied. Width is the
 * viewport so both environments produce comparable images; height is capped.
 * @param {import("playwright").Page} page
 * @param {string} file
 * @param {import("./config.js").Config} cfg
 * @param {{ fullPage?: boolean, scrollHeight?: number }} [opts]
 */
export async function screenshot(page, file, cfg, opts = {}) {
  const fullPage = opts.fullPage ?? cfg.visual.fullPage;
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const mask = [...cfg.visual.mask].map((s) => page.locator(s));
  const style = cfg.visual.hide.map((s) => `${s}{visibility:hidden !important}`).join("\n");
  /** @type {import("playwright").PageScreenshotOptions} */
  const options = {
    path: file,
    animations: "disabled",
    caret: "hide",
    scale: "css",
    mask,
    maskColor: "#FF00FF",
    style: style || undefined,
    timeout: 20000,
  };
  if (fullPage) {
    const height = Math.min(Math.max(opts.scrollHeight ?? vp.height, vp.height), cfg.visual.maxHeight);
    options.fullPage = true;
    options.clip = { x: 0, y: 0, width: vp.width, height };
  }
  await page.screenshot(options);
  return file;
}

/**
 * Run axe-core and keep a compact summary per rule.
 * @param {import("playwright").Page} page
 * @param {import("./config.js").Config} cfg
 */
export async function runAxe(page, cfg) {
  // The ESM entry exports the class as default; the type declarations describe the CJS shape.
  const mod = /** @type {any} */ (await import("@axe-core/playwright"));
  const AxeBuilder = mod.default?.default ?? mod.default ?? mod.AxeBuilder;
  let builder = new AxeBuilder({ page }).withTags(cfg.a11y.tags);
  for (const sel of cfg.ignore.selectors) builder = builder.exclude(sel);
  const results = await builder.analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? "minor",
    help: v.help,
    helpUrl: v.helpUrl,
    count: v.nodes.length,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    html: v.nodes.slice(0, 2).map((n) => n.html.slice(0, 200)),
  }));
}

/**
 * @typedef {object} Snapshot
 * @property {"baseline"|"candidate"} side
 * @property {string} key
 * @property {string} viewport
 * @property {string} url
 * @property {string} finalUrl
 * @property {string|null} finalKey Null when the page ended up outside the environment (SSO, another site).
 * @property {number|null} status
 * @property {string[]} redirects
 * @property {Record<string,string>} headers
 * @property {string|null} error
 * @property {number} loadMs
 * @property {Awaited<ReturnType<typeof collectPage>> | null} dom
 * @property {string|null} screenshot Path relative to the report directory.
 * @property {Awaited<ReturnType<typeof runAxe>> | null} a11y
 * @property {import("./instrument.js").PageLog} log
 * @property {boolean} [unstable] The page kept changing while we captured it.
 */

/**
 * Load one page in one environment and record everything about it.
 * @param {import("./session.js").EnvSession} env
 * @param {string} key
 * @param {{ outDir: string, file: string, a11y: boolean, perf: boolean }} opts
 * @returns {Promise<Snapshot>}
 */
export async function capturePage(env, key, opts) {
  const { cfg } = env;
  const page = await env.context.newPage();
  const inst = instrumentPage(page, env);
  const url = env.scope.urlFor(key);
  /** @type {Snapshot} */
  const snap = {
    side: env.side,
    key,
    viewport: env.viewport.name,
    url,
    finalUrl: url,
    finalKey: key,
    status: null,
    redirects: [],
    headers: {},
    error: null,
    loadMs: 0,
    dom: null,
    screenshot: null,
    a11y: null,
    log: inst.log,
  };
  try {
    const load = await loadPage(page, inst, url, cfg, { perf: opts.perf });
    Object.assign(snap, {
      status: load.status,
      redirects: load.redirects,
      headers: pickHeaders(load.headers),
      error: load.error,
      loadMs: load.ms,
      finalUrl: page.url(),
      finalKey: env.scope.keyOf(page.url(), { ignoreQuery: cfg.crawl.ignoreQuery }),
    });
    if (!load.error) {
      snap.unstable = !(await captureStill(page, inst, cfg, async () => {
        snap.dom = await page.evaluate(collectPage, {
          maskSelectors: cfg.visual.mask,
          ignoreSelectors: cfg.ignore.selectors,
          skipSelectors: cfg.explore.skip.selectors,
          allowSelectors: cfg.explore.allow.selectors,
        });
        if (cfg.visual.enabled) {
          await screenshot(page, path.join(opts.outDir, opts.file), cfg, { scrollHeight: snap.dom.doc.scrollHeight });
          snap.screenshot = opts.file;
        }
      }, load.revealedAt));
      if (snap.dom) snap.dom.perf = load.perf;
      if (opts.a11y) snap.a11y = await runAxe(page, cfg).catch(() => null);
      // Late client-side redirects (a login wall after the app boots) land here.
      snap.finalUrl = page.url();
      snap.finalKey = env.scope.keyOf(page.url(), { ignoreQuery: cfg.crawl.ignoreQuery });
    }
  } catch (e) {
    snap.error = snap.error ?? `Capture failed: ${/** @type {Error} */ (e).message.split("\n")[0]}`;
  } finally {
    await inst.flush();
    await page.close().catch(() => {});
  }
  return snap;
}

/**
 * Run `capture` from the top of the page and check the page held still while
 * it ran: same scroll position, size, address and text before and after, and
 * no client-side navigation. Apps that finish booting late re-render and
 * scroll to a section seconds after "load"; capture again once that's over.
 * @param {import("playwright").Page} page
 * @param {import("./instrument.js").Instrumented} inst
 * @param {import("./config.js").Config} cfg
 * @param {() => Promise<void>} capture
 * @param {number} revealed Client-side navigations seen when the page was last scrolled through.
 * @returns {Promise<boolean>} False if the page never held still.
 */
async function captureStill(page, inst, cfg, capture, revealed) {
  for (let attempt = 0; ; attempt++) {
    if (inst.log.navigations.length !== revealed) {
      // The router ran again since we scrolled through: what we revealed may
      // be hidden again.
      await settle(page, inst, { timeout: cfg.stabilize.maxWaitMs, quietMs: cfg.stabilize.quietMs });
      if (cfg.stabilize.scroll) await revealAll(page, inst, cfg);
      revealed = inst.log.navigations.length;
    }
    await scrollToTop(page, inst);
    await page.evaluate(finishAnimations).catch(() => 0);
    const before = await page.evaluate(pageFingerprint).catch(() => null);
    await capture();
    const after = await page.evaluate(pageFingerprint).catch(() => null);
    if (before !== null && before === after && inst.log.navigations.length === revealed) return true;
    if (attempt >= 2) return false;
    await settle(page, inst, { timeout: cfg.stabilize.maxWaitMs, quietMs: cfg.stabilize.quietMs });
  }
}

const KEPT_HEADERS = [
  "content-type",
  "cache-control",
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "x-robots-tag",
];

/** @param {Record<string,string>} headers */
function pickHeaders(headers) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const h of KEPT_HEADERS) if (headers[h]) out[h] = headers[h].slice(0, 300);
  return out;
}
