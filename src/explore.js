import fs from "node:fs";
import path from "node:path";
import { collectPage, finishAnimations, chartPoints, chartTooltip, viewportDataRects } from "./inpage/collect.js";
import { instrumentPage } from "./instrument.js";
import { loadPage, settle } from "./capture.js";
import { annotateElements, matchElements, relocate, digitless } from "./match.js";
import { compareLogs, failedRequests } from "./compare/page.js";
import { normalizeLines, suspiciousText } from "./compare/text.js";
import { diffImages } from "./compare/visual.js";
import { pairByName } from "./compare/grids.js";
import { tooltipShape } from "./compare/charts.js";
import { describeEl, elRef, CHROME } from "./compare/elements.js";
import { routePattern } from "./urls.js";
import { DEFAULT_DENY_TEXT, DEFAULT_DENY_PATHS } from "./config.js";
import { shortHash, compilePatterns, matchesAny, truncate, sleep } from "./util/misc.js";

/**
 * @typedef {import("./match.js").El} El
 * @typedef {{ a: El, b: El }} Step One action, as the same element on both sides.
 *
 * @typedef {object} Outcome What one action did in one environment.
 * @property {boolean} ok
 * @property {string} [error]
 * @property {boolean} navigated
 * @property {string|null} toKey Page key after the action (null = left the site).
 * @property {string} toUrl
 * @property {string[]} popups
 * @property {string[]} downloads
 * @property {{ type: string, message: string }[]} dialogs Native alert/confirm/prompt.
 * @property {string[]} opened Modal dialogs that appeared.
 * @property {boolean} domChanged Something other than the target itself changed.
 * @property {boolean} selfChanged The target's own state changed (checked, expanded, value).
 * @property {boolean} unstable The page also changes by itself, so DOM changes are weak evidence.
 * @property {string[]} textAdded
 * @property {string[]} textRemoved
 * @property {El[]} newControls
 * @property {{ key: string, status: number|null, failure: string|null, blocked: boolean, body?: string[] }[]} calls First-party API calls.
 * @property {Set<string>} [allKeys] Every request key this tab has ever made, this action included.
 * @property {boolean} effect Anything observable happened.
 * @property {import("./instrument.js").PageLog} log
 * @property {string} [screenshot]
 */

/**
 * @typedef {object} Interaction
 * @property {string} id
 * @property {string} page
 * @property {string} viewport
 * @property {string[]} path Human labels of each step.
 * @property {"click"|"select"|"hover"} action
 * @property {string} [option] For selects, the option chosen.
 * @property {ReturnType<typeof elRef>} element
 * @property {string} baseline Summary of what happened.
 * @property {string} candidate
 * @property {"same"|"different"|"unreachable"} verdict
 * @property {string[]} findings
 * @property {{ baseline?: string, candidate?: string, diff?: string }} screenshots
 * @property {number} [visualRatio]
 * @property {boolean} [flaky] It differed once but not when repeated.
 * @property {string[]} [flakyFindings] What differed the first time.
 */

/**
 * Decide which controls are safe and worth clicking.
 * @param {import("./config.js").Config} cfg
 */
export function createPolicy(cfg) {
  const deny = compilePatterns([...(cfg.safety.useDefaultDenyList ? DEFAULT_DENY_TEXT : []), ...cfg.explore.skip.text]);
  const denyPaths = compilePatterns(DEFAULT_DENY_PATHS);
  const allow = compilePatterns(cfg.explore.allow.text);
  return {
    /** @param {El & { skip?: boolean, allow?: boolean }} e @returns {string | null} why it is skipped */
    skipReason(e) {
      if (e.disabled) return "disabled";
      if (e.kind === "input" || e.kind === "file") return "text input";
      if (e.allow) return null;
      if (e.skip) return "matches explore.skip.selectors";
      const haystack = [e.name, e.testId, e.id, e.nameAttr, e.hrefKey].filter(Boolean).join(" ");
      if (matchesAny(deny, haystack) && !matchesAny(allow, haystack)) return "looks destructive (deny list)";
      if (e.hrefKey && matchesAny(denyPaths, e.hrefKey)) return "logout link";
      if (e.kind === "link") {
        const href = e.href || "";
        if (/^(mailto|tel|sms|javascript:void)/i.test(href)) return "non-navigational link";
        if (e.hrefKey && !e.hrefKey.startsWith("/")) return "external link";
        const jsLink = /^javascript:/i.test(href) || /#$/.test(href) || href === "";
        if (!jsLink) {
          if (/#[^/!]/.test(href)) return "in-page anchor";
          if (!cfg.explore.includeLinks) return "plain link (crawled instead)";
        }
      }
      if (e.tag === "select" && !cfg.explore.selects) return "select (explore.selects=false)";
      return null;
    },
  };
}

/**
 * One environment's tab during exploration.
 */
class Tab {
  /**
   * @param {import("./session.js").EnvSession} session
   * @param {string} key
   */
  constructor(session, key) {
    this.session = session;
    this.key = key;
    this.cfg = session.cfg;
    /** @type {import("playwright").Page | null} */
    this.page = null;
    /** @type {ReturnType<typeof instrumentPage> | null} */
    this.inst = null;
    /** @type {any} */
    this.inv = null;
    /** Ids of state-changing actions applied since the last fresh load. */
    /** @type {string[]} */
    this.statePath = [];
    /** False when the tab's state is unknown and must be reloaded. */
    this.fresh = false;
    /** The page changes by itself (tickers, carousels): DOM changes alone prove nothing. */
    this.unstable = false;
    this.probed = false;
    /** Log positions when the page was last loaded. */
    /** @type {Record<string, number> | null} */
    this.loadMark = null;
  }

  async open() {
    this.page = await this.session.context.newPage();
    this.inst = instrumentPage(this.page, this.session);
  }

  async collect() {
    const page = /** @type {import("playwright").Page} */ (this.page);
    await page.evaluate(finishAnimations).catch(() => 0);
    const dom = await page.evaluate(collectPage, {
      maskSelectors: this.cfg.visual.mask,
      ignoreSelectors: this.cfg.ignore.selectors,
      skipSelectors: this.cfg.explore.skip.selectors,
      allowSelectors: this.cfg.explore.allow.selectors,
    });
    annotateElements(dom.actionables, (href) => this.session.scope.keyOf(href, { ignoreQuery: this.cfg.crawl.ignoreQuery }));
    return dom;
  }

  /**
   * Bring the tab to the state reached by `prefix` (steps with their ids),
   * reloading and replaying when it isn't already there.
   * @param {{ id: string, el: El, option?: string }[]} prefix
   */
  async reach(prefix) {
    const want = prefix.map((p) => p.id);
    if (this.fresh && sameList(this.statePath, want) && this.inv) return null;
    const page = /** @type {import("playwright").Page} */ (this.page);
    this.fresh = false;
    const url = this.session.scope.urlFor(this.key);
    // Start from a new document. In a hash-routed app, going to the page from
    // another of its routes is only a route change: the app keeps its state,
    // and may still be booting from the navigation the last click caused.
    if (stripHash(page.url()) === stripHash(url)) await page.goto("about:blank").catch(() => {});
    this.loadMark = /** @type {ReturnType<typeof instrumentPage>} */ (this.inst).mark();
    const load = await loadPage(page, /** @type {any} */ (this.inst), url, { ...this.cfg, stabilize: { ...this.cfg.stabilize, scroll: false } });
    if (load.error) return `page failed to load: ${load.error}`;
    this.statePath = [];
    this.inv = await this.collect();
    if (!this.probed) {
      // Does the page change with nobody touching it?
      this.probed = true;
      await page.waitForTimeout(800);
      const again = await this.collect();
      this.unstable = signature(again, this.cfg) !== signature(this.inv, this.cfg);
      this.inv = again;
    }
    for (const step of prefix) {
      const out = await this.act(step.el, step.option);
      if (!out.ok || out.navigated) return `could not repeat "${describeEl(step.el)}": ${out.error ?? "it navigated away"}`;
      this.statePath.push(step.id);
    }
    this.fresh = true;
    return null;
  }

  /**
   * Perform one action and describe what it did. Does not touch the tab's
   * state bookkeeping; the caller decides what the outcome means for it.
   * @param {El} target
   * @param {string} [option] Option text, for selects.
   * @returns {Promise<Outcome>}
   */
  async act(target, option) {
    const page = /** @type {import("playwright").Page} */ (this.page);
    const inst = /** @type {ReturnType<typeof instrumentPage>} */ (this.inst);
    const cfg = this.cfg;
    let before = this.inv;
    /** @type {Outcome} */
    const outcome = {
      ok: false,
      navigated: false,
      toKey: this.key,
      toUrl: page.url(),
      popups: [],
      downloads: [],
      dialogs: [],
      opened: [],
      domChanged: false,
      selfChanged: false,
      unstable: this.unstable,
      textAdded: [],
      textRemoved: [],
      newControls: [],
      calls: [],
      effect: false,
      log: inst.since(inst.mark()),
    };
    let el = before ? relocate(before.actionables, target) : null;
    // Content that renders only once scrolled into view isn't inventoried yet.
    if (!el && before) el = await this.scrollToFind(target);
    // Scroll it into view first and let the page react (sticky headers,
    // scrollspy, reveal animations), so that doesn't count as the action's effect.
    if (el && (await this.bringIntoView(el))) {
      before = this.inv;
      el = relocate(before.actionables, target);
    }
    if (!el) {
      outcome.error = "element not found in this state";
      return outcome;
    }
    const beforeUrl = page.url();
    // The target's own state (a select's value, a checkbox) is judged
    // separately: "the dropdown shows the new option" is not "the page responded".
    const beforeSig = signature(before, cfg, el.key);
    const mark = inst.mark();
    try {
      const handle = (await page.evaluateHandle((i) => /** @type {any} */ (window).__envdiff.els[i], el.idx)).asElement();
      if (!handle) throw new Error("element is no longer in the page");
      if (el.tag === "select") {
        const index = pickOption(el, option);
        if (index < 0) throw new Error(`option "${option}" is not available`);
        await handle.selectOption({ index }, { timeout: cfg.explore.actionTimeout });
      } else {
        await handle.click({ timeout: cfg.explore.actionTimeout });
      }
      outcome.ok = true;
    } catch (e) {
      outcome.error = clickError(e);
    }
    // Move the pointer off the target so :hover styles don't read as a change.
    await page.mouse.move(0, 0).catch(() => {});
    await settle(page, inst, { timeout: cfg.explore.settleTimeout, quietMs: 300 });
    await inst.flush(1500);
    const ctx = { before, beforeSig, beforeUrl, mark, el };
    Object.defineProperty(outcome, "_ctx", { value: ctx, enumerable: false });
    await this.observe(outcome, ctx);
    return outcome;
  }

  /**
   * Scroll down to where `target` sat in the page snapshot, a screen at a
   * time as a person would (some pages reveal a section only as it is
   * scrolled past, not when jumped to), and take a fresh inventory there.
   * @param {El} target
   */
  async scrollToFind(target) {
    const page = /** @type {import("playwright").Page} */ (this.page);
    const y = /** @type {any} */ (target).rect?.y;
    if (typeof y !== "number") return null;
    await page
      .evaluate((top) => {
        if (scrollY > Math.max(0, top - innerHeight / 2)) window.scrollTo({ top: 0, behavior: "instant" });
      }, y)
      .catch(() => {});
    for (let i = 0; i < 30; i++) {
      const more = await page
        .evaluate((top) => {
          const goal = Math.max(0, top - innerHeight / 2);
          const before = scrollY;
          window.scrollTo({ top: Math.min(goal, before + Math.max(200, Math.floor(innerHeight * 0.9))), behavior: "instant" });
          return scrollY !== before && scrollY < goal - 1;
        }, y)
        .catch(() => false);
      await sleep(100);
      if (!more) break;
    }
    await settle(page, /** @type {any} */ (this.inst), { timeout: 2500, quietMs: 250 });
    this.inv = await this.collect();
    return relocate(this.inv.actionables, target);
  }

  /**
   * Center an off-screen element and wait for the page to react to the
   * scroll. True, with a fresh inventory, if anything moved.
   * @param {El} el
   */
  async bringIntoView(el) {
    const page = /** @type {import("playwright").Page} */ (this.page);
    const moved = await page
      .evaluate((i) => {
        const e = /** @type {Element | undefined} */ (/** @type {any} */ (window).__envdiff.els[i]);
        if (!e || !e.isConnected) return false;
        const r = e.getBoundingClientRect();
        if (r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth) return false;
        e.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        const now = e.getBoundingClientRect();
        return Math.abs(now.top - r.top) > 1 || Math.abs(now.left - r.left) > 1;
      }, el.idx)
      .catch(() => false);
    if (!moved) return false;
    await settle(page, /** @type {any} */ (this.inst), { timeout: 2500, quietMs: 250 });
    this.inv = await this.collect();
    return true;
  }

  /**
   * Fill in what the page shows now, relative to before the action.
   * @param {Outcome} outcome
   * @param {{ before: any, beforeSig: string, beforeUrl: string, mark: any, el: El }} ctx
   */
  async observe(outcome, { before, beforeSig, beforeUrl, mark, el }) {
    const page = /** @type {import("playwright").Page} */ (this.page);
    const inst = /** @type {ReturnType<typeof instrumentPage>} */ (this.inst);
    const cfg = this.cfg;
    const afterUrl = page.url();
    const delta = inst.since(mark);
    outcome.toUrl = afterUrl;
    outcome.toKey = this.session.scope.keyOf(afterUrl, { ignoreQuery: cfg.crawl.ignoreQuery });
    const urlChanged = afterUrl !== beforeUrl && (stripHash(afterUrl) !== stripHash(beforeUrl) || /#!?\//.test(afterUrl));
    const reloaded = delta.requests.some((r) => r.type === "document" && !r.blocked && r.failure == null);
    outcome.navigated = urlChanged || reloaded;
    let after = null;
    try {
      after = await this.collect();
    } catch {
      // still navigating, or the page closed itself
    }
    outcome.log = delta;
    outcome.popups = delta.popups;
    outcome.downloads = delta.downloads;
    outcome.dialogs = delta.dialogs;
    outcome.calls = delta.requests
      .filter((r) => r.firstParty && !r.noise && ["xhr", "fetch", "document", "other"].includes(r.type) && r.failure !== "aborted")
      .map((r) => ({ key: r.key, status: r.status, failure: r.failure, blocked: r.blocked, body: r.body }));
    // Requests this page load already made before the action (loading,
    // polling) aren't a response to it: a poll landing inside one side's click
    // window must not read as "the click did something there and nothing here".
    const prior = new Set(inst.log.requests.slice(this.loadMark?.requests ?? 0, mark.requests).map((r) => r.key));
    const newCalls = outcome.calls.filter((c) => !prior.has(c.key));
    outcome.allKeys = new Set([...prior, ...delta.requests.map((r) => r.key)]);
    if (after && before) {
      outcome.domChanged = signature(after, cfg, el.key) !== beforeSig;
      const self = outcome.navigated ? null : after.actionables.find((/** @type {El} */ e) => e.key === el.key);
      outcome.selfChanged = !!self && el.tag !== "select" && stateOf(self) !== stateOf(el);
      const opts = { normalize: true, ignore: compilePatterns(cfg.ignore.text) };
      const tb = normalizeLines(before.text, opts);
      const ta = normalizeLines(after.text, opts);
      outcome.textAdded = multisetMinus(ta, tb).slice(0, 12);
      outcome.textRemoved = multisetMinus(tb, ta).slice(0, 12);
      const beforeKeys = new Set(before.actionables.map((/** @type {El} */ e) => e.key));
      outcome.newControls = outcome.navigated ? [] : after.actionables.filter((/** @type {El} */ e) => !beforeKeys.has(e.key));
      const beforeDialogs = new Set(before.dialogs);
      outcome.opened = after.dialogs.filter((/** @type {string} */ d) => !beforeDialogs.has(d));
    }
    outcome.effect =
      outcome.navigated ||
      // On a page that changes by itself, a DOM change only counts when it is
      // something a person would call a response: new controls or a dialog.
      (this.unstable ? outcome.newControls.length > 0 || outcome.opened.length > 0 : outcome.domChanged) ||
      outcome.selfChanged ||
      outcome.popups.length > 0 ||
      outcome.downloads.length > 0 ||
      outcome.dialogs.length > 0 ||
      newCalls.length > 0;
    if (after) this.inv = after;
  }

  /**
   * A second, longer look before concluding this side did less than the
   * other: non-production environments are often just slower.
   * @param {Outcome} outcome
   */
  async recheck(outcome) {
    const ctx = /** @type {any} */ (outcome)._ctx;
    if (!ctx || !outcome.ok || !this.page || this.page.isClosed()) return;
    await settle(this.page, /** @type {any} */ (this.inst), { timeout: this.cfg.explore.settleTimeout * 2, quietMs: 500 });
    await /** @type {any} */ (this.inst).flush(2000);
    await this.observe(outcome, ctx);
  }

  async close() {
    await this.page?.close().catch(() => {});
  }
}

/** @param {string[]} a @param {string[]} b */
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** @param {string} u */
const stripHash = (u) => u.split("#")[0];

/** Lines in `a` beyond those in `b`, by count. @param {string[]} a @param {string[]} b */
function multisetMinus(a, b) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const s of b) counts.set(s, (counts.get(s) ?? 0) + 1);
  /** @type {string[]} */
  const out = [];
  for (const s of a) {
    const n = counts.get(s) ?? 0;
    if (n > 0) counts.set(s, n - 1);
    else out.push(s);
  }
  return out;
}

/** A control's own state: expanded, checked, selected, value, sort order, pressed. @param {El} e */
const stateOf = (e) => {
  const x = /** @type {any} */ (e);
  return `${e.expanded ?? ""}:${e.checked ?? ""}:${x.selected ?? ""}:${e.value ?? ""}:${x.sort ?? ""}:${x.pressed ?? ""}`;
};

/**
 * The page's inventory, as the explorer takes it.
 * @param {import("playwright").Page} page
 * @param {import("./config.js").Config} cfg
 */
export async function pageInventory(page, cfg) {
  await page.evaluate(finishAnimations).catch(() => 0);
  return page.evaluate(collectPage, {
    maskSelectors: cfg.visual.mask,
    ignoreSelectors: cfg.ignore.selectors,
    skipSelectors: cfg.explore.skip.selectors,
    allowSelectors: cfg.explore.allow.selectors,
  });
}

/**
 * A fingerprint of what the page shows: controls with their state, open
 * dialogs, (normalized) text and container colours. Equal fingerprints mean
 * nothing changed. `exclude` leaves one control's own state out.
 * @param {any} dom
 * @param {import("./config.js").Config} cfg
 * @param {string} [exclude]
 */
export function signature(dom, cfg, exclude) {
  const controls = dom.actionables.map((/** @type {El} */ e) => (e.key === exclude ? /** @type {string} */ (e.key) : `${e.key}:${stateOf(e)}`)).join(",");
  const text = normalizeLines(dom.text, { normalize: true, ignore: compilePatterns(cfg.ignore.text) }).join("\n");
  // Grids and charts aren't in the text; their own digests say when they change (sorted, paged, a series hidden).
  const data = [...(dom.grids ?? []), ...(dom.charts ?? [])].map((/** @type {any} */ x) => x.digest).join(",");
  return shortHash(`${controls}|${dom.dialogs.join(",")}|${dom.styleSig ?? ""}|${text}|${data}`);
}

/**
 * Index of the option to pick: the named one, or the first real option that
 * isn't selected.
 * @param {El} el
 * @param {string} [optionText]
 */
function pickOption(el, optionText) {
  const options = /** @type {{ text: string, value: string, disabled: boolean }[]} */ (el.options ?? []);
  if (optionText !== undefined) return options.findIndex((o) => o.text === optionText && !o.disabled);
  return options.findIndex((o) => !o.disabled && o.value !== "" && o.text !== el.value);
}

/** Short reason from Playwright's verbose actionability errors. @param {unknown} e */
function clickError(e) {
  const msg = /** @type {Error} */ (e)?.message ?? String(e);
  if (/intercepts pointer events/.test(msg)) {
    const by = /(<[^>]{1,80}>)[^<]*intercepts pointer events/.exec(msg);
    return `covered by another element${by ? ` ${by[1]}` : ""}`;
  }
  if (/not visible|outside of the viewport/.test(msg)) return "not visible";
  if (/not enabled|disabled/.test(msg)) return "disabled";
  if (/not attached|detached|no longer in the page/.test(msg)) return "element disappeared";
  if (/not stable/.test(msg)) return "kept moving (animation)";
  if (/Timeout/.test(msg)) return "timed out";
  return msg.split("\n")[0].slice(0, 160);
}

/**
 * One line describing an outcome, for tables.
 * @param {Outcome} o
 * @param {string} fromKey
 */
export function summarize(o, fromKey) {
  if (!o.ok) return `✖ ${o.error}`;
  /** @type {string[]} */
  const parts = [];
  if (o.navigated) parts.push(o.toKey === null ? `left the site → ${truncate(o.toUrl, 60)}` : o.toKey === fromKey ? "reloaded the page" : `went to ${o.toKey}`);
  for (const p of o.popups) parts.push(`opened a new tab → ${truncate(p, 60)}`);
  for (const d of o.downloads) parts.push(`downloaded ${d}`);
  for (const d of o.dialogs) parts.push(`${d.type}: "${truncate(d.message, 50)}"`);
  if (o.opened.length) parts.push(`opened ${o.opened.map((d) => `"${truncate(d, 30)}"`).join(", ")}`);
  if (o.domChanged && !o.navigated) {
    const bits = [];
    if (o.newControls.length) bits.push(`+${o.newControls.length} controls`);
    if (o.textAdded.length) bits.push(`+${o.textAdded.length} lines`);
    if (o.textRemoved.length) bits.push(`−${o.textRemoved.length} lines`);
    parts.push(`updated the page${bits.length ? ` (${bits.join(", ")})` : ""}`);
  }
  const calls = o.calls.filter((c) => !c.key.startsWith("GET {self}/") || c.status == null || c.status >= 400 || c.blocked);
  for (const c of calls.slice(0, 3)) parts.push(`${c.key.replace("{self}", "")} ${c.blocked ? "(blocked)" : c.failure ? `✖ ${c.failure}` : `→ ${c.status}`}`);
  if (o.log.errors.length) parts.push(`threw ${truncate(o.log.errors[0].message, 60)}`);
  return parts.length ? parts.join("; ") : "no visible effect";
}

/**
 * Click through a page in both environments.
 * @param {object} ctx
 * @param {string} ctx.key
 * @param {{ baseline: import("./session.js").EnvSession, candidate: import("./session.js").EnvSession }} ctx.sessions
 * @param {{ baseline: any, candidate: any }} ctx.doms Inventories from the page snapshots.
 * @param {import("./config.js").Config} ctx.cfg
 * @param {(f: any) => any} ctx.add
 * @param {string} ctx.outDir
 * @param {(name: string) => string} ctx.assetPath Relative path for a new asset file.
 * @param {Set<string>} ctx.globalSeen Chrome controls already explored on another page.
 * @param {() => boolean} ctx.stopped True once the run should wrap up.
 * @param {number} [ctx.pageVisualRatio]
 * @param {(side: "baseline"|"candidate") => Promise<boolean>} [ctx.relogin] Log a side in again whose session ended.
 * @param {import("./util/log.js").Logger} ctx.log
 * @returns {Promise<{ interactions: Interaction[], skipped: { element: string, reason: string }[], discovered: string[] }>}
 */
export async function explorePage(ctx) {
  const { key, sessions, cfg, add, log } = ctx;
  const where = { page: key, viewport: sessions.baseline.viewport.name };
  const policy = createPolicy(cfg);
  /** @type {Interaction[]} */
  const interactions = [];
  /** @type {{ element: string, reason: string }[]} */
  const skipped = [];
  /** Pages reached by clicking (router.push, form GETs) — fed back to the crawler. */
  /** @type {Set<string>} */
  const discovered = new Set();

  const { pairs } = matchElements(ctx.doms.baseline.actionables, ctx.doms.candidate.actionables);
  /** @type {Map<string, number>} */
  const perName = new Map();
  /** @type {{ path: { id: string, pair: Step, option?: string }[] }[]} */
  const stack = [];
  for (const pair of pairs) {
    const reason = policy.skipReason(pair.a) ?? policy.skipReason(pair.b);
    if (reason) {
      if (!/plain link|in-page anchor|text input/.test(reason)) skipped.push({ element: describeEl(pair.a), reason });
      continue;
    }
    if (CHROME.test(pair.a.landmark)) {
      const g = `${pair.a.landmark}|${pair.a.role}|${digitless(pair.a.name)}`;
      if (ctx.globalSeen.has(g)) continue;
      ctx.globalSeen.add(g);
    }
    const nameKey = `${pair.a.role}|${digitless(pair.a.name)}`;
    const n = perName.get(nameKey) ?? 0;
    if (n >= cfg.explore.maxPerName) continue;
    perName.set(nameKey, n + 1);
    const option = pair.a.tag === "select" ? optionFor(pair.a, pair.b) : undefined;
    if (pair.a.tag === "select" && option === undefined) continue;
    stack.push({ path: [{ id: stepId(pair.a, option), pair, option }] });
  }
  const { pairs: chartPairs } = pairByName(ctx.doms.baseline.charts ?? [], ctx.doms.candidate.charts ?? []);
  const hovers = cfg.explore.hover.charts > 0 ? chartPairs.slice(0, cfg.explore.hover.charts) : [];
  if (!stack.length && !hovers.length) return { interactions, skipped, discovered: [] };
  stack.reverse(); // pop() takes document order

  const tabs = { baseline: new Tab(sessions.baseline, key), candidate: new Tab(sessions.candidate, key) };
  await Promise.all([tabs.baseline.open(), tabs.candidate.open()]);
  try {
    while (stack.length && interactions.length < cfg.explore.maxActionsPerPage && !ctx.stopped()) {
      const item = /** @type {(typeof stack)[number]} */ (stack.pop());
      const last = item.path[item.path.length - 1];
      const prefix = item.path.slice(0, -1);
      const labels = item.path.map((p) => (p.option !== undefined ? `"${truncate(p.option, 30)}" in ${describeEl(p.pair.a)}` : describeEl(p.pair.a)));
      const id = shortHash(`${key}|${where.viewport}|${item.path.map((p) => p.id).join(">")}`);
      const reach = () =>
        Promise.all([
          tabs.baseline.reach(prefix.map((p) => ({ id: p.id, el: p.pair.a, option: p.option }))),
          tabs.candidate.reach(prefix.map((p) => ({ id: p.id, el: p.pair.b, option: p.option }))),
        ]);
      /** The side showing its login form when the other isn't: its session ended. */
      const lostSession = () => {
        const b = !!tabs.baseline.inv?.loginForm;
        const c = !!tabs.candidate.inv?.loginForm;
        return b === c ? null : b ? /** @type {const} */ ("baseline") : /** @type {const} */ ("candidate");
      };
      let reloggedIn = false;
      /** Log the side back in once and start over from a fresh load. */
      const recover = async () => {
        const side = ctx.relogin && !reloggedIn ? lostSession() : null;
        if (!side || !(await /** @type {NonNullable<typeof ctx.relogin>} */ (ctx.relogin)(side))) return false;
        reloggedIn = true;
        tabs.baseline.fresh = tabs.candidate.fresh = false;
        return true;
      };
      /** @returns {Promise<any>} */
      const attempt = async () => {
        let [errB, errC] = await reach();
        if (await recover()) [errB, errC] = await reach();
        if (errB) return { errB };
        // A page that changes by itself on either side changes the rules for
        // both, or one side's DOM change would count and the other's wouldn't.
        if (tabs.baseline.unstable !== tabs.candidate.unstable) tabs.baseline.unstable = tabs.candidate.unstable = true;
        const [ob, oc] = await Promise.all([
          tabs.baseline.act(last.pair.a, last.option),
          errC ? Promise.resolve(failedOutcome(errC, tabs.candidate)) : tabs.candidate.act(last.pair.b, last.option),
        ]);
        // A session that ended during the action: log back in and do it again.
        if (await recover()) return attempt();
        // The candidate seems to have done less: give it a second, longer look
        // before calling it broken (it may just be slower).
        if (ob.ok && oc.ok && ((ob.effect && !oc.effect) || (ob.domChanged && !oc.domChanged) || (ob.navigated && !oc.navigated))) {
          await tabs.candidate.recheck(oc);
        }
        // Screenshots of the after-state, both sides, while the tabs are still there.
        const { shots, ignore } = await captureShots(tabs, ctx, id, ob, oc, last.pair);
        /** @type {any[]} */
        const found = [];
        const interaction = compareOutcomes(ob, oc, {
          id,
          key,
          where,
          labels,
          step: last.pair,
          option: last.option,
          add: (/** @type {any} */ f) => (found.push(f), f),
          shots,
          ignore,
          outDir: ctx.outDir,
          pageVisualRatio: ctx.pageVisualRatio ?? 0,
          cfg,
        });
        return { errB: null, ob, oc, interaction, found };
      };
      let run = await attempt();
      if (run.errB || !run.ob || !run.oc || !run.interaction || !run.found) {
        skipped.push({ element: labels.join(" → "), reason: `baseline: ${run.errB}` });
        continue;
      }
      if (cfg.stabilize.confirm && run.found.length && !ctx.stopped()) {
        // One-off differences come from timing: an environment still booting,
        // a slow response, an animation caught mid-way. Do it again from a
        // fresh load and keep only what happens both times.
        const first = run;
        tabs.baseline.fresh = tabs.candidate.fresh = false;
        const again = await attempt();
        if (again.ob && again.oc && again.interaction && again.found) {
          const identity = (/** @type {any} */ f) => `${f.type}|${f.fp ?? ""}`;
          const firstIds = new Set(first.found.map(identity));
          const againIds = new Set(again.found.map(identity));
          const gone = first.found.filter((f) => !againIds.has(identity(f)));
          again.interaction.flaky = gone.length > 0;
          if (gone.length) again.interaction.flakyFindings = gone.map((f) => truncate(f.title, 200));
          again.found = again.found.filter((f) => firstIds.has(identity(f)));
          for (const k of /** @type {const} */ (["baseline", "candidate", "diff"])) {
            const rel = first.interaction.screenshots[k];
            if (rel && rel !== again.interaction.screenshots[k]) fs.rmSync(path.join(ctx.outDir, rel), { force: true });
          }
          run = again;
        }
      }
      const { ob, oc, interaction } = /** @type {{ ob: Outcome, oc: Outcome, interaction: Interaction }} */ (run);
      interaction.findings = [];
      for (const f of /** @type {any[]} */ (run.found)) {
        const r = add(f);
        if (r) interaction.findings.push(r.id);
      }
      if (interaction.verdict !== "unreachable" && ob.ok) interaction.verdict = interaction.findings.length ? "different" : "same";
      interactions.push(interaction);
      // Track each tab's state: an error or navigation leaves it unknown; an
      // effect moves it one step along; no effect leaves it where it was.
      for (const [tab, o] of /** @type {const} */ ([
        [tabs.baseline, ob],
        [tabs.candidate, oc],
      ])) {
        if (!o.ok || o.navigated) tab.fresh = false;
        // A new option chosen in a select changes the page's state even when
        // nothing else shows it (a filter waiting for "Apply").
        else if (o.effect || o.domChanged || last.option !== undefined) tab.statePath.push(last.id);
        if (o.navigated && o.toKey && o.toKey !== key) discovered.add(o.toKey);
      }
      log.debug(`    ${interaction.verdict === "same" ? "=" : "≠"} ${labels.join(" → ")}: ${interaction.baseline} | ${interaction.candidate}`);

      // A filter changed with nothing to show for it yet waits for its
      // "Apply": press it next, with the filter set, as a person would.
      const settingOnly = (/** @type {Outcome} */ o) => o.ok && !o.navigated && !o.domChanged && !o.dialogs.length && !o.popups.length;
      if ((last.option !== undefined || last.pair.a.kind === "toggle") && item.path.length < Math.max(2, cfg.explore.depth) && settingOnly(ob) && settingOnly(oc)) {
        const apply = applyFor(last.pair, pairs, policy);
        if (apply && !item.path.some((p) => p.pair === apply)) stack.push({ path: [...item.path, { id: stepId(apply.a), pair: apply }] });
      }

      // Explore what this action revealed (menus, dialogs), depth permitting.
      if (item.path.length < cfg.explore.depth && ob.ok && oc.ok && !ob.navigated && !oc.navigated && ob.newControls.length) {
        const { pairs: kids } = matchElements(ob.newControls, oc.newControls);
        const children = kids.filter((k) => !policy.skipReason(k.a) && !policy.skipReason(k.b)).slice(0, 8);
        for (const kid of children.reverse()) {
          const option = kid.a.tag === "select" ? optionFor(kid.a, kid.b) : undefined;
          stack.push({ path: [...item.path, { id: stepId(kid.a, option), pair: kid, option }] });
        }
      }
    }
    for (const [cb, cc] of hovers) {
      if (ctx.stopped()) break;
      interactions.push(...(await hoverChart(tabs, cb, cc, { ...ctx, where })));
    }
  } finally {
    await Promise.all([tabs.baseline.close(), tabs.candidate.close()]);
  }
  return { interactions, skipped, discovered: [...discovered] };
}

/**
 * Point at a few points of a chart in both environments and compare the
 * tooltips: one that no longer shows, or reads differently once the data is
 * taken out ("Revenue: $12,400" against "Revenue: 12400").
 * @param {{ baseline: Tab, candidate: Tab }} tabs
 * @param {any} cb The chart on the baseline (from the page inventory).
 * @param {any} cc The same chart on the candidate.
 * @param {Parameters<typeof explorePage>[0] & { where: { page: string, viewport: string } }} ctx
 * @returns {Promise<Interaction[]>}
 */
async function hoverChart(tabs, cb, cc, ctx) {
  const { cfg, key, where } = ctx;
  const [errB, errC] = await Promise.all([tabs.baseline.reach([]), tabs.candidate.reach([])]);
  if (errB || errC) return [];
  // The inventory from this load: the chart's position among the page's charts may have moved.
  const find = (/** @type {Tab} */ t, /** @type {any} */ ch) => (t.inv?.charts ?? []).find((/** @type {any} */ x) => x.name === ch.name) ?? ch;
  const chB = find(tabs.baseline, cb);
  const chC = find(tabs.candidate, cc);
  const count = cfg.explore.hover.points;
  const [ptsB, ptsC] = await Promise.all([
    /** @type {import("playwright").Page} */ (tabs.baseline.page).evaluate(chartPoints, { domIndex: chB.domIndex, count }).catch(() => []),
    /** @type {import("playwright").Page} */ (tabs.candidate.page).evaluate(chartPoints, { domIndex: chC.domIndex, count }).catch(() => []),
  ]);
  /** @param {Tab} t @param {any} ch @param {{ x: number, y: number }} p */
  const hover = async (t, ch, p) => {
    const page = /** @type {import("playwright").Page} */ (t.page);
    await page.mouse.move(p.x, p.y, { steps: 6 }).catch(() => {});
    // Tooltips fade in; give it the time a person would.
    await page.waitForTimeout(450);
    return /** @type {string} */ (await page.evaluate(chartTooltip, { domIndex: ch.domIndex }).catch(() => ""));
  };
  const away = () => Promise.all([tabs.baseline, tabs.candidate].map((t) => t.page?.mouse.move(0, 0).catch(() => {})));
  // The x-axis label is data too (dates, regions): take it out before comparing.
  const shape = (/** @type {string} */ text, /** @type {string} */ label) =>
    tooltipShape(label && label.length > 1 ? text.split(label).join("‹x›") : text).replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, "‹month›");

  /** @type {{ label: string, b: string, c: string }[]} */
  const seen = [];
  for (let i = 0; i < Math.min(ptsB.length, ptsC.length); i++) {
    let [tb, tc] = await Promise.all([hover(tabs.baseline, chB, ptsB[i]), hover(tabs.candidate, chC, ptsC[i])]);
    if (tb && (!tc || shape(tb, ptsB[i].label) !== shape(tc, ptsC[i].label)) && cfg.stabilize.confirm) {
      // Once more, in case a tooltip was still fading in.
      await away();
      await sleep(300);
      [tb, tc] = await Promise.all([hover(tabs.baseline, chB, ptsB[i]), hover(tabs.candidate, chC, ptsC[i])]);
    }
    seen.push({ label: ptsB[i].label, b: tb, c: tc });
    await away();
  }
  if (!seen.length) return [];

  const label = `"${cb.name}" chart`;
  const id = shortHash(`${key}|${where.viewport}|hover|${cb.name}`);
  /** @type {Interaction} */
  const interaction = {
    id,
    page: key,
    viewport: where.viewport,
    path: [`hover the ${label}`],
    action: "hover",
    element: { role: "chart", name: cb.name, landmark: "", cssPath: `.highcharts-container >> nth=${cb.domIndex}` },
    baseline: seen.map((x) => (x.b ? `"${truncate(x.b, 60)}"` : "no tooltip")).join("; "),
    candidate: seen.map((x) => (x.c ? `"${truncate(x.c, 60)}"` : "no tooltip")).join("; "),
    verdict: "same",
    findings: [],
    screenshots: {},
  };
  const record = (/** @type {any} */ f) => {
    const r = ctx.add({ ...where, interaction: id, element: interaction.element, category: "interaction", ...f, fp: `${id}|${f.fp}` });
    if (r) interaction.findings.push(r.id);
  };
  const lost = seen.filter((x) => x.b && !x.c);
  const shapesB = new Set(seen.filter((x) => x.b).map((x) => shape(x.b, x.label)));
  const differing = seen.filter((x, i) => x.b && x.c && !shapesB.has(shape(x.c, ptsC[i]?.label ?? "")));
  if (lost.length === seen.filter((x) => x.b).length && lost.length) {
    record({
      severity: "major",
      type: "chart.tooltip-missing",
      title: `Hovering the ${label} shows no tooltip on candidate (baseline: "${truncate(lost[0].b, 60)}")`,
      baseline: lost[0].b,
      fp: "tooltip-missing",
    });
  } else if (differing.length && differing.length === seen.filter((x) => x.b && x.c).length) {
    record({
      severity: "minor",
      type: "chart.tooltip",
      title: `The ${label}'s tooltip reads differently on candidate: "${truncate(differing[0].c, 60)}" (baseline: "${truncate(differing[0].b, 60)}")`,
      baseline: differing.map((x) => x.b),
      candidate: differing.map((x) => x.c),
      fp: "tooltip",
    });
  } else if (!seen.some((x) => x.b) && seen.some((x) => x.c)) {
    record({ severity: "info", type: "chart.tooltip-new", title: `Hovering the ${label} now shows a tooltip on candidate`, fp: "tooltip-new" });
  }
  if (interaction.findings.length) {
    interaction.verdict = "different";
    // Show it: hover the first differing point again and photograph the chart on both sides.
    const i = seen.indexOf(lost[0] ?? differing[0]);
    if (i >= 0) {
      await Promise.all([hover(tabs.baseline, chB, ptsB[i]), hover(tabs.candidate, chC, ptsC[i])]);
      await Promise.all(
        /** @type {const} */ (["baseline", "candidate"]).map(async (side) => {
          const t = tabs[side];
          const ch = side === "baseline" ? chB : chC;
          const rel = ctx.assetPath(`ix-${id}-${side}.png`);
          try {
            await /** @type {import("playwright").Page} */ (t.page).locator(".highcharts-container").nth(ch.domIndex).screenshot({ path: path.join(ctx.outDir, rel), animations: "allow", timeout: 5000 });
            interaction.screenshots[side] = rel;
          } catch {
            // the chart went away
          }
        }),
      );
      await away();
    }
  }
  return [interaction];
}

/** @param {El} e @param {string} [option] */
const stepId = (e, option) => shortHash(`${e.key}|${option ?? ""}`, 8);

const APPLY = /^(apply( filters?)?|go|search|filter|update|run( report)?|refresh|show( results)?|view( report)?|load|generate( report)?|submit|ok)$/i;

/**
 * The "Apply" button that goes with a filter control: an apply-like button in
 * the same part of the page (landmark and section heading), safe to click.
 * @param {Step} filter
 * @param {Step[]} pairs Every control on the page, paired across environments.
 * @param {ReturnType<typeof createPolicy>} policy
 */
function applyFor(filter, pairs, policy) {
  const near = pairs.filter(
    (p) => p !== filter && p.a.kind === "button" && APPLY.test(p.a.name.trim()) && p.a.landmark === filter.a.landmark && p.a.heading === filter.a.heading && !policy.skipReason(p.a) && !policy.skipReason(p.b),
  );
  // The closest one below or beside the filter.
  const dist = (/** @type {Step} */ p) => Math.abs(p.a.rect.y - filter.a.rect.y) * 2 + Math.abs(p.a.rect.x - filter.a.rect.x);
  return near.sort((x, y) => dist(x) - dist(y))[0] ?? null;
}

/** An option that exists on both sides and isn't already selected. @param {El} a @param {El} b */
function optionFor(a, b) {
  const textsB = new Set((b.options ?? []).filter((/** @type {any} */ o) => !o.disabled).map((/** @type {any} */ o) => o.text));
  const pick = (a.options ?? []).find((/** @type {any} */ o) => !o.disabled && o.value !== "" && o.text !== a.value && textsB.has(o.text));
  return pick?.text;
}

/** @param {string} error @param {Tab} tab @returns {Outcome} */
function failedOutcome(error, tab) {
  return {
    ok: false,
    error,
    navigated: false,
    toKey: tab.key,
    toUrl: tab.page?.url() ?? "",
    popups: [],
    downloads: [],
    dialogs: [],
    opened: [],
    domChanged: false,
    selfChanged: false,
    unstable: tab.unstable,
    textAdded: [],
    textRemoved: [],
    newControls: [],
    calls: [],
    effect: false,
    log: { console: [], errors: [], requests: [], dialogs: [], popups: [], downloads: [], navigations: [], api: [] },
  };
}

/**
 * @param {{ baseline: Tab, candidate: Tab }} tabs
 * @param {{ outDir: string, assetPath: (name: string) => string }} ctx
 * @param {string} id
 * @param {Outcome} ob
 * @param {Outcome} oc
 * @param {Step} step The control that was acted on, on each side.
 */
async function captureShots(tabs, ctx, id, ob, oc, step) {
  /** @type {{ x: number, y: number, w: number, h: number }[]} Grids and charts in the shots, by position. */
  const ignore = [];
  if (!ob.effect && !oc.effect && ob.ok === oc.ok) return { shots: {}, ignore };
  // Both opened a dialog: compare the dialogs. The page behind them may sit
  // at a different scroll position, which says nothing about the dialog.
  const dialogs = ob.opened.length > 0 && oc.opened.length > 0;
  /** @type {{ baseline?: string, candidate?: string }} */
  const shots = {};
  await Promise.all(
    /** @type {const} */ (["baseline", "candidate"]).map(async (side) => {
      const tab = tabs[side];
      const page = tab.page;
      if (!page || page.isClosed()) return;
      const rel = ctx.assetPath(`ix-${id}-${side}.png`);
      const outcome = side === "baseline" ? ob : oc;
      // Frame both screenshots the same way: the control that was clicked,
      // centred, with what it opened or changed around it. Apps scroll on
      // their own after an expand, and not always to the same pixel.
      if (!dialogs && outcome.ok && !outcome.navigated && tab.inv) {
        const el = relocate(tab.inv.actionables, side === "baseline" ? step.a : step.b);
        if (el) {
          const moved = await page
            .evaluate((i) => {
              const e = /** @type {Element | undefined} */ (/** @type {any} */ (window).__envdiff.els[i]);
              if (!e || !e.isConnected) return false;
              const before = e.getBoundingClientRect().top;
              e.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
              return Math.abs(e.getBoundingClientRect().top - before) > 1;
            }, el.idx)
            .catch(() => false);
          if (moved) await settle(page, /** @type {any} */ (tab.inst), { timeout: 2000, quietMs: 250 });
        }
      }
      const options = {
        path: path.join(ctx.outDir, rel),
        animations: /** @type {const} */ ("disabled"),
        caret: /** @type {const} */ ("hide"),
        scale: /** @type {const} */ ("css"),
        mask: tabs[side].cfg.visual.mask.map((s) => page.locator(s)),
        maskColor: "#FF00FF",
        timeout: 10000,
      };
      try {
        const dialog = page.locator("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]").filter({ visible: true }).last();
        if (dialogs && (await dialog.count())) {
          const box = await dialog.boundingBox();
          await dialog.screenshot(options);
          if (box) ignore.push(...(await page.evaluate(viewportDataRects, { x: box.x, y: box.y }).catch(() => [])));
        } else {
          await page.screenshot(options);
          ignore.push(...(await page.evaluate(viewportDataRects, undefined).catch(() => [])));
        }
        shots[side] = rel;
      } catch {
        // page navigated away mid-shot; leave it out
      }
    }),
  );
  return { shots, ignore };
}

/**
 * Compare what one action did on each side, record findings, and describe it.
 * @param {Outcome} b
 * @param {Outcome} c
 * @param {object} ctx
 * @param {string} ctx.id
 * @param {string} ctx.key
 * @param {{ page: string, viewport: string }} ctx.where
 * @param {string[]} ctx.labels
 * @param {Step} ctx.step
 * @param {string} [ctx.option]
 * @param {(f: any) => any} ctx.add
 * @param {{ baseline?: string, candidate?: string }} ctx.shots
 * @param {{ x: number, y: number, w: number, h: number }[]} [ctx.ignore] Where grids and charts are in the shots.
 * @param {string} ctx.outDir
 * @param {number} ctx.pageVisualRatio
 * @param {import("./config.js").Config} ctx.cfg
 * @returns {Interaction}
 */
export function compareOutcomes(b, c, ctx) {
  const { add, key } = ctx;
  const el = ctx.step.a;
  const what =
    ctx.labels.length > 1
      ? `using ${ctx.labels.join(" → ")}`
      : `${ctx.option !== undefined ? `choosing "${truncate(ctx.option, 30)}" in` : "clicking"} ${describeEl(el)}`;
  const where = { ...ctx.where, interaction: ctx.id, element: elRef(el) };
  /** @type {string[]} */
  const ids = [];
  const evidence = { baseline: ctx.shots.baseline, candidate: ctx.shots.candidate };
  const record = (/** @type {any} */ f) => {
    const found = add({ ...where, evidence, ...f, fp: `${ctx.id}|${f.fp ?? f.type}` });
    if (found) ids.push(found.id);
  };

  /** @type {Interaction} */
  const interaction = {
    id: ctx.id,
    page: key,
    viewport: ctx.where.viewport,
    path: ctx.labels,
    action: ctx.option !== undefined ? "select" : "click",
    option: ctx.option,
    element: elRef(el),
    baseline: summarize(b, key),
    candidate: summarize(c, key),
    verdict: "same",
    findings: ids,
    screenshots: { ...ctx.shots },
  };

  if (!b.ok && !c.ok) {
    interaction.verdict = "unreachable";
    return interaction;
  }
  if (b.ok && !c.ok) {
    record({
      severity: "critical",
      category: "interaction",
      type: "interaction.failed",
      title: `Can't complete ${what} on candidate: ${c.error}`,
      baseline: interaction.baseline,
      candidate: interaction.candidate,
    });
  } else if (!b.ok && c.ok) {
    interaction.verdict = "different";
    return interaction;
  }

  compareLogs(b, c, { add: record, where: {}, context: `after ${what}` });

  if (b.ok && c.ok) {
    if (b.effect && !c.effect) {
      record({
        severity: "critical",
        category: "interaction",
        type: "interaction.no-effect",
        title: `${capitalize(what)} does nothing on candidate (baseline: ${interaction.baseline})`,
        baseline: interaction.baseline,
        candidate: interaction.candidate,
      });
    } else if (!b.effect && c.effect) {
      record({
        severity: "info",
        category: "interaction",
        type: "interaction.new-effect",
        title: `${capitalize(what)} now does something on candidate: ${interaction.candidate}`,
        candidate: interaction.candidate,
      });
    } else if (b.effect && c.effect) {
      compareEffects(b, c, { what, record, key });
    }
  }

  // Visual difference of the after-state beyond what the page already had.
  if (ctx.shots.baseline && ctx.shots.candidate && b.ok && c.ok && (b.domChanged || c.domChanged) && !b.navigated && !c.navigated) {
    try {
      const diffRel = ctx.shots.baseline.replace(/-baseline\.png$/, "-diff.png");
      const base = ctx.outDir;
      const d = diffImages(path.join(base, ctx.shots.baseline), path.join(base, ctx.shots.candidate), path.join(base, diffRel), {
        threshold: ctx.cfg.visual.threshold,
        ignore: ctx.cfg.data === "same" ? [] : ctx.ignore,
      });
      interaction.visualRatio = Math.round(d.ratio * 10000) / 10000;
      if (d.diffPixels) interaction.screenshots.diff = diffRel;
      if (d.ratio > Math.max(0.03, ctx.pageVisualRatio + 0.05)) {
        record({
          severity: "minor",
          category: "visual",
          type: "interaction.visual",
          title: `Looks different after ${what} (${(d.ratio * 100).toFixed(1)}% of the screen)`,
          evidence: { ...evidence, diff: diffRel },
        });
      }
    } catch {
      // screenshot missing; skip the visual part
    }
  }

  interaction.verdict = ids.length ? "different" : "same";
  return interaction;
}

/**
 * Both sides did something. Did they do the same thing?
 * @param {Outcome} b
 * @param {Outcome} c
 * @param {{ what: string, record: (f: any) => void, key: string }} ctx
 */
function compareEffects(b, c, { what, record, key }) {
  const W = capitalize(what);
  if (b.navigated && c.navigated) {
    if (b.toKey !== c.toKey) {
      const samePattern = b.toKey && c.toKey && routePattern(b.toKey) === routePattern(c.toKey);
      record({
        severity: samePattern ? "info" : c.toKey === null ? "major" : "major",
        category: "interaction",
        type: samePattern ? "interaction.nav-data" : "interaction.nav-target",
        title: samePattern
          ? `${W} goes to ${c.toKey} on candidate, ${b.toKey} on baseline (same route; likely data)`
          : `${W} goes to ${c.toKey ?? truncate(c.toUrl, 80)} on candidate instead of ${b.toKey ?? truncate(b.toUrl, 80)}`,
        baseline: b.toKey ?? b.toUrl,
        candidate: c.toKey ?? c.toUrl,
      });
    }
  } else if (b.navigated && !c.navigated) {
    record({
      severity: "major",
      category: "interaction",
      type: "interaction.no-navigation",
      title: `${W} no longer navigates on candidate (baseline went to ${b.toKey ?? truncate(b.toUrl, 60)}; candidate: ${summarize(c, key)})`,
      baseline: b.toKey ?? b.toUrl,
      candidate: summarize(c, key),
    });
  } else if (!b.navigated && c.navigated) {
    record({
      severity: "major",
      category: "interaction",
      type: "interaction.unexpected-navigation",
      title: `${W} navigates away on candidate (to ${c.toKey ?? truncate(c.toUrl, 60)}) instead of updating the page`,
      baseline: summarize(b, key),
      candidate: c.toKey ?? c.toUrl,
    });
  }

  if (b.popups.length && !c.popups.length) {
    record({ severity: "major", category: "interaction", type: "interaction.popup", title: `${W} no longer opens a new tab on candidate (baseline: ${truncate(b.popups[0], 80)})` });
  }
  if (b.downloads.length && !c.downloads.length) {
    record({ severity: "major", category: "interaction", type: "interaction.download", title: `${W} no longer downloads a file on candidate (baseline: ${b.downloads[0]})` });
  }
  if (b.dialogs.length && !c.dialogs.length) {
    record({ severity: "major", category: "interaction", type: "interaction.alert", title: `${W} no longer shows the ${b.dialogs[0].type} "${truncate(b.dialogs[0].message, 60)}" on candidate` });
  } else if (b.dialogs.length && c.dialogs.length && b.dialogs[0].message !== c.dialogs[0].message) {
    record({
      severity: "minor",
      category: "interaction",
      type: "interaction.alert-text",
      title: `${W} shows a different ${c.dialogs[0].type} on candidate: "${truncate(c.dialogs[0].message, 60)}" (baseline: "${truncate(b.dialogs[0].message, 60)}")`,
    });
  }
  if (!b.navigated && !c.navigated && b.opened.length && !c.opened.length) {
    record({
      severity: "major",
      category: "interaction",
      type: "interaction.dialog",
      title: `${W} no longer opens ${b.opened.map((d) => `"${truncate(d, 40)}"`).join(", ")} on candidate`,
    });
  } else if (!b.navigated && !c.navigated && b.domChanged && !c.domChanged && !b.unstable && !c.unstable) {
    // It did *something* (an API call, say) but the page never showed the result.
    record({
      severity: "major",
      category: "interaction",
      type: "interaction.no-update",
      title: `${W} no longer updates the page on candidate (baseline: ${summarize(b, key)}; candidate: ${summarize(c, key)})`,
      baseline: summarize(b, key),
      candidate: summarize(c, key),
    });
  }
  if (b.selfChanged && !c.selfChanged && !c.navigated) {
    record({
      severity: "major",
      category: "interaction",
      type: "interaction.no-toggle",
      title: `${W} doesn't change its state on candidate (checked/expanded/selected stays the same)`,
    });
  }

  // API calls the baseline made that the candidate didn't, or made differently.
  const callsC = new Map(c.calls.map((x) => [x.key, x]));
  for (const call of b.calls) {
    const other = callsC.get(call.key);
    if (!other) {
      if (call.key.startsWith("GET ") && !call.blocked && b.navigated) continue; // page-load fetches belong to the page
      if (c.allKeys?.has(call.key)) continue; // made at another moment (polling, page load): timing, not a missing call
      record({
        severity: "major",
        category: "interaction",
        type: "interaction.missing-call",
        title: `${W} no longer calls ${call.key.replace("{self}", "")} on candidate`,
        baseline: call.key,
        fp: `call:${call.key}`,
      });
      continue;
    }
    const missingFields = (call.body ?? []).filter((f) => !(other.body ?? []).includes(f) && !(other.body ?? []).some((g) => g.split(":")[0] === f.split(":")[0]));
    if (missingFields.length) {
      record({
        severity: "major",
        category: "api",
        type: "interaction.payload",
        title: `${W} sends ${call.key.replace("{self}", "")} without ${missingFields.map((f) => f.split(":")[0]).join(", ")} on candidate`,
        baseline: call.body,
        candidate: other.body,
        fp: `payload:${call.key}`,
      });
    }
  }

  // Error-looking text that appeared only on the candidate ("Something went wrong").
  for (const s of suspiciousText(b.textAdded, c.textAdded)) {
    record({
      severity: "major",
      category: "interaction",
      type: "interaction.error-text",
      title: `${W} shows ${s.name} on candidate: "${truncate(s.samples[0] ?? "", 80)}"`,
      candidate: s.samples,
      fp: `text:${s.name}`,
    });
  }
}

/** @param {string} s */
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Remove an interaction's screenshots when they aren't wanted in the report. */
export function pruneShots(/** @type {Interaction} */ ix, /** @type {string} */ outDir) {
  for (const k of /** @type {const} */ (["baseline", "candidate", "diff"])) {
    const rel = ix.screenshots[k];
    if (rel) fs.rmSync(path.join(outDir, rel), { force: true });
  }
  ix.screenshots = {};
}

export { failedRequests };
