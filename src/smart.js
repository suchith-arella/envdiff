import { locateTarget, locateOption } from "./inpage/locate.js";
import { collectPage, chartPoints, chartTooltip, finishAnimations } from "./inpage/collect.js";
import { suspiciousText } from "./compare/text.js";
import { loose } from "./match.js";
import { sleep, truncate } from "./util/misc.js";

/**
 * Carry out one plain-English step (see plain.js) on a page: find what it
 * names, the way a person would, and act on it.
 *
 * In a journey the baseline goes first; the candidate is then pointed at the
 * control the baseline used (`prefer`), so both sides do the same thing even
 * when the words could match more than one control.
 *
 * @typedef {{ role: string, name: string }} Chosen
 * @typedef {object} PlainCtx
 * @property {import("./urls.js").Scope} scope
 * @property {number} timeout For finding things and for expectations, ms.
 * @property {Chosen | null} [prefer] The control the other environment used.
 * @property {Record<string, string>} [vars] Values for {{name}} in the step.
 * @property {boolean} [loggedIn]
 * @property {string} [user] The user the run is logged in as.
 * @property {(step: import("./plain.js").PlainStep, page: import("playwright").Page, why: string) => Promise<import("./plain.js").PlainStep & { control?: number } | null>} [plan]
 *   Asks the AI what a step means on this page, when it can't be read or its target found.
 * @typedef {object} PlainResult
 * @property {Chosen | null} chosen The control acted on.
 * @property {string} [observed] What the step saw: a tooltip, the rows a grid shows.
 * @property {string} [note] How the step was carried out, when not as written.
 * @property {import("./plain.js").PlainStep} step The step as carried out (after AI help).
 */

/** Steps that change something on the page; the rest look or wait. */
export const ACTING = new Set(["click", "dblclick", "fill", "select", "check", "uncheck", "sort", "page", "navigate", "press", "row", "goto", "reload", "back", "hover"]);

/**
 * Fill in {{username}}, {{password}}, {{env.NAME}} and friends.
 * @param {string | undefined} s
 * @param {Record<string, string>} vars
 */
export function fillVars(s, vars) {
  if (s == null) return s;
  return String(s).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => {
    const key = String(k);
    if (key in vars) return vars[key];
    const env = /^(?:env|secret|secrets)\.(\w+)$/.exec(key);
    if (env && process.env[env[1]] !== undefined) return /** @type {string} */ (process.env[env[1]]);
    throw new Error(`the step uses ${m}, which has no value`);
  });
}

/**
 * Values a step would type that must not appear in reports: the user's
 * password and anything from {{env.…}}.
 * @param {string} text
 * @param {Record<string, string>} vars
 */
export function secretsIn(text, vars) {
  /** @type {string[]} */
  const out = [];
  for (const m of String(text).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const key = m[1];
    if (key === "password" || key === "totp") out.push(vars[key]);
    const env = /^(?:env|secret|secrets)\.(\w+)$/.exec(key);
    if (env && process.env[env[1]]) out.push(/** @type {string} */ (process.env[env[1]]));
  }
  return out.filter(Boolean);
}

/**
 * Find a control and return a handle on it, waiting for it to appear.
 * @param {import("playwright").Page} page
 * @param {{ kind: "click"|"fill"|"select"|"check"|"hover"|"any", phrase: string, hint?: string, prefer?: Chosen | null }} spec
 * @param {number} timeout
 * @param {number} [minScore]
 */
async function find(page, spec, timeout, minScore = 40) {
  const end = Date.now() + timeout;
  /** @type {{ i: number, role: string, name: string, tag: string, score: number }[]} */
  let found = [];
  for (;;) {
    found = await page.evaluate(locateTarget, spec).catch(() => []);
    if (found[0] && found[0].score >= minScore) {
      const handle = (await page.evaluateHandle((i) => /** @type {any} */ (window).__envdiff.found[i], found[0].i)).asElement();
      if (handle) return { handle, chosen: { role: found[0].role, name: found[0].name }, found };
    }
    if (Date.now() > end) break;
    await sleep(350);
  }
  return { handle: null, chosen: null, found };
}

/** "couldn't find X (closest: …)". @param {string} phrase @param {{ role: string, name: string }[]} found */
function notFound(phrase, found) {
  const near = found
    .slice(0, 3)
    .map((f) => `${f.role} "${f.name.slice(0, 40)}"`)
    .join(", ");
  return new Error(`couldn't find "${phrase}"${near ? ` (closest: ${near})` : ""}`);
}

/** Collect the page's grids and charts. @param {import("playwright").Page} page */
async function dataOf(page) {
  await page.evaluate(finishAnimations).catch(() => 0);
  return page.evaluate(collectPage, {});
}

/** The best name match among items with a `name`. @template {{ name: string }} T @param {T[]} items @param {string} phrase */
function byName(items, phrase) {
  const p = loose(phrase);
  return items.find((x) => loose(x.name) === p) ?? items.find((x) => loose(x.name).includes(p) || p.includes(loose(x.name))) ?? (items.length === 1 ? items[0] : undefined);
}

/**
 * Run one step.
 * @param {import("playwright").Page} page
 * @param {import("./plain.js").PlainStep | null} parsed Null when the step couldn't be read.
 * @param {string} text The step as written.
 * @param {PlainCtx} ctx
 * @returns {Promise<PlainResult>}
 */
export async function runPlainStep(page, parsed, text, ctx) {
  const vars = ctx.vars ?? {};
  let step = parsed ?? /** @type {import("./plain.js").PlainStep} */ ({ text, action: "click", target: text.replace(/^["'“]|["'”]$/g, ""), guessed: true });
  try {
    return await perform(page, step, ctx, vars);
  } catch (e) {
    // Not understood, or not found: let the AI read the step against the page.
    const why = /** @type {Error} */ (e).message;
    const recoverable = !parsed || /^couldn't find/.test(why);
    const unread = () =>
      new Error(
        `didn't understand this step, and found no control called "${truncate(text, 60)}": start it with what to do (go to, click, type "…" into, select "…" from, expect to see…)${ctx.plan ? "" : ", or add --ai to have such steps worked out"}`,
      );
    if (!ctx.plan || !recoverable || ctx.prefer) throw parsed ? e : unread();
    const planned = await ctx.plan(step, page, why);
    if (!planned || planned.action === "none") throw parsed ? e : unread();
    const r = await perform(page, planned, ctx, vars);
    return { ...r, note: `read as: ${describePlan(planned, r.chosen)}` };
  }
}

/**
 * Run a step that has already been worked out (the baseline's), on the other
 * environment: pointed at the control the baseline used through `ctx.prefer`.
 * @param {import("playwright").Page} page
 * @param {import("./plain.js").PlainStep & { control?: number }} step
 * @param {PlainCtx} ctx
 */
export function performStep(page, step, ctx) {
  return perform(page, step, ctx, ctx.vars ?? {});
}

/** @param {any} p @param {Chosen | null} chosen */
function describePlan(p, chosen) {
  const what = chosen ? `${chosen.role} "${chosen.name.slice(0, 40)}"` : p.target ? `"${p.target}"` : "";
  return [p.action, what, p.value !== undefined && p.action === "fill" ? `with "${p.secret ? "••••" : String(p.value).slice(0, 30)}"` : "", p.option ? `"${p.option}"` : "", p.key ?? "", p.url ?? ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * @param {import("playwright").Page} page
 * @param {import("./plain.js").PlainStep & { control?: number }} step
 * @param {PlainCtx} ctx
 * @param {Record<string, string>} vars
 * @returns {Promise<PlainResult>}
 */
async function perform(page, step, ctx, vars) {
  const timeout = ctx.timeout;
  const prefer = ctx.prefer ?? null;
  /** @type {Chosen | null} */
  let chosen = null;
  /** Act on the control the AI picked from the inventory, or find one by its words. */
  const target = async (/** @type {"click"|"fill"|"select"|"check"|"hover"|"any"} */ kind, /** @type {string} */ phrase, hint = step.hint) => {
    if (typeof step.control === "number" && step.control >= 0 && !prefer) {
      const handle = (await page.evaluateHandle((i) => /** @type {any} */ (window).__envdiff.els?.[i], step.control)).asElement();
      if (handle) {
        const c = await handle.evaluate((el) => {
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute("type") || "").toLowerCase();
          const implicit =
            tag === "a" ? "link" : tag === "button" || ["submit", "button", "reset"].includes(type) ? "button" : tag === "select" ? "combobox" : tag === "textarea" || tag === "input" ? (type === "checkbox" ? "checkbox" : "textbox") : tag;
          const name = el.getAttribute("aria-label") || /** @type {HTMLElement} */ (el).innerText || el.getAttribute("placeholder") || "";
          return { role: el.getAttribute("role") || implicit, name: name.replace(/\s+/g, " ").trim().slice(0, 120) };
        });
        chosen = c;
        return handle;
      }
    }
    const r = await find(page, { kind, phrase: fillVars(phrase, vars) ?? "", hint, prefer }, timeout);
    if (!r.handle) throw notFound(phrase, r.found);
    chosen = r.chosen;
    return r.handle;
  };

  switch (step.action) {
    case "goto":
      await page.goto(ctx.scope.urlFor(fillVars(step.url, vars) ?? "/"), { waitUntil: "load", timeout: Math.max(timeout, 30000) });
      return { chosen: null, step };
    case "navigate": {
      // "Settings > Users": open each in turn.
      const parts = String(step.target).split(/\s*(?:>|›|»|→|->)\s*/).filter(Boolean);
      for (const [i, part] of parts.entries()) {
        const handle = await target("click", part, i === parts.length - 1 ? step.hint ?? "link" : "menu");
        await handle.click({ timeout });
        if (i < parts.length - 1) await sleep(400);
      }
      return { chosen, step };
    }
    case "click":
    case "dblclick": {
      const handle = await target("click", String(step.target));
      if (step.action === "dblclick") await handle.dblclick({ timeout });
      else await handle.click({ timeout });
      return { chosen, step };
    }
    case "fill": {
      const value = fillVars(step.value ?? "", vars) ?? "";
      let handle = null;
      try {
        handle = await target("fill", String(step.target));
      } catch (e) {
        // "Set Date range to Last 30 days" names a dropdown.
        if (!(/** @type {Error} */ (e).message.startsWith("couldn't find"))) throw e;
        return perform(page, { ...step, action: "select", option: step.value }, ctx, vars);
      }
      if ((await handle.evaluate((el) => el.tagName.toLowerCase())) === "select") return perform(page, { ...step, action: "select", option: step.value }, ctx, vars);
      await handle.fill(value, { timeout });
      if (step.submit) await handle.press("Enter");
      return { chosen, step };
    }
    case "select": {
      const option = fillVars(step.option ?? step.value ?? "", vars) ?? "";
      const handle = await target("select", String(step.target)).catch(() => target("click", String(step.target)));
      if ((await handle.evaluate((el) => el.tagName.toLowerCase())) === "select") {
        const labels = await handle.evaluate((el) => Array.from(/** @type {HTMLSelectElement} */ (el).options).map((o) => (o.textContent || "").trim()));
        const want = loose(option);
        const label = labels.find((l) => loose(l) === want) ?? labels.find((l) => loose(l).startsWith(want)) ?? labels.find((l) => loose(l).includes(want));
        if (!label) throw new Error(`"${option}" is not an option of "${step.target}" (options: ${labels.slice(0, 8).join(", ")})`);
        await handle.selectOption({ label }, { timeout });
        return { chosen, step };
      }
      // A custom dropdown: open it, then pick the option from the list it shows.
      await handle.click({ timeout });
      const end = Date.now() + timeout;
      for (;;) {
        const picked = await page.evaluate(locateOption, option).catch(() => null);
        if (picked) {
          const opt = (await page.evaluateHandle(() => /** @type {any} */ (window).__envdiff.option)).asElement();
          if (opt) {
            await opt.click({ timeout });
            return { chosen, step };
          }
        }
        if (Date.now() > end) throw new Error(`opened "${step.target}" but found no option "${option}"`);
        await sleep(250);
      }
    }
    case "check":
    case "uncheck": {
      const handle = await target("check", String(step.target));
      if (step.action === "check") await handle.check({ timeout });
      else await handle.uncheck({ timeout });
      return { chosen, step };
    }
    case "hover": {
      const handle = await target("hover", String(step.target));
      await handle.hover({ timeout });
      await sleep(400);
      return { chosen, step };
    }
    case "press":
      await page.keyboard.press(String(step.key));
      return { chosen: null, step };
    case "row": {
      const dom = await dataOf(page);
      const grid = step.target ? byName(dom.grids ?? [], step.target) : (dom.grids ?? [])[0];
      if (!grid) throw new Error(step.target ? `couldn't find the "${step.target}" grid` : "there is no grid on the page");
      const index = await page.evaluate(
        ({ rect, which }) => {
          const roots = Array.from(document.querySelectorAll(".ag-root-wrapper,[role=grid],[role=treegrid]"));
          const root = roots.find((r) => {
            const b = r.getBoundingClientRect();
            return Math.abs(b.top + scrollY - rect.y) < 3 && Math.abs(b.left + scrollX - rect.x) < 3;
          });
          if (!root) return -1;
          const rows = Array.from(root.querySelectorAll(".ag-row[row-index],[role=row]")).filter((r) => !r.closest(".ag-header,thead") && !r.querySelector("[role=columnheader]"));
          rows.sort((a, b) => Number(a.getAttribute("row-index") ?? a.getAttribute("aria-rowindex")) - Number(b.getAttribute("row-index") ?? b.getAttribute("aria-rowindex")));
          const n = which === "last" ? rows.length - 1 : Number(which) - 1;
          const row = rows[n];
          if (!row) return -1;
          const s = /** @type {any} */ (window).__envdiff || {};
          s.found = [row.querySelector(".ag-cell,[role=gridcell],[role=cell]") || row];
          /** @type {any} */ (window).__envdiff = s;
          return n;
        },
        { rect: grid.rect, which: step.which ?? "1" },
      );
      if (index < 0) throw new Error(`the "${grid.name}" grid has no row ${step.which}`);
      const cell = /** @type {import("playwright").ElementHandle} */ ((await page.evaluateHandle(() => /** @type {any} */ (window).__envdiff.found[0])).asElement());
      if (step.hint === "double") await cell.dblclick({ timeout });
      else await cell.click({ timeout });
      return { chosen: { role: "row", name: `${grid.name} row ${index + 1}` }, step };
    }
    case "sort": {
      const handle = await target("click", String(step.target), "column header");
      const want = step.direction === "desc" ? "descending" : "ascending";
      for (let i = 0; i < 3; i++) {
        await handle.click({ timeout });
        await sleep(300);
        const now = await handle.evaluate((el) => el.getAttribute("aria-sort"));
        if (now === want || now === null) break;
      }
      return { chosen, step };
    }
    case "page": {
      const handle = await target("click", `${step.which} page`, "button");
      await handle.click({ timeout });
      return { chosen, step };
    }
    case "hoverChart": {
      const dom = await dataOf(page);
      const chart = byName(dom.charts ?? [], String(step.target));
      if (!chart) throw new Error(`couldn't find the "${step.target}" chart (charts: ${(dom.charts ?? []).map((c) => c.name).join(", ") || "none"})`);
      const points = await page.evaluate(chartPoints, { domIndex: chart.domIndex, count: 3 });
      const p = step.which === "last" ? points[points.length - 1] : step.which === "middle" ? points[Math.floor(points.length / 2)] : points[0];
      if (!p) throw new Error(`the "${chart.name}" chart has no points to point at`);
      await page.mouse.move(p.x, p.y, { steps: 6 });
      await sleep(450);
      const tip = await page.evaluate(chartTooltip, { domIndex: chart.domIndex });
      return { chosen: { role: "chart", name: chart.name }, observed: tip ? `tooltip "${tip}"` : "no tooltip", step };
    }
    case "wait":
      await page.waitForTimeout(Math.min(Number(step.ms) || 0, 60000));
      return { chosen: null, step };
    case "expect": {
      const what = fillVars(step.target ?? "", vars) ?? "";
      const end = Date.now() + timeout;
      for (;;) {
        const shown = await visibleText(page, what);
        if (shown !== !!step.not) return { chosen: null, step };
        if (Date.now() > end) {
          throw new Error(step.not ? `"${what}" is still shown` : `expected to see "${what}"`);
        }
        await sleep(300);
      }
    }
    case "expectUrl": {
      const want = String(step.url);
      const end = Date.now() + timeout;
      while (!page.url().includes(want)) {
        if (Date.now() > end) throw new Error(`expected the address to contain "${want}", it is ${page.url()}`);
        await sleep(250);
      }
      return { chosen: null, step };
    }
    case "expectTitle": {
      const want = loose(step.target ?? "");
      const title = await page.title();
      if (!loose(title).includes(want)) throw new Error(`expected the title to contain "${step.target}", it is "${title}"`);
      return { chosen: null, step };
    }
    case "expectRows": {
      const end = Date.now() + timeout;
      let last = "";
      for (;;) {
        const dom = await dataOf(page);
        const grid = byName(dom.grids ?? [], String(step.target));
        if (grid) {
          const n = grid.overlay?.kind === "loading" ? -1 : grid.total ?? grid.rendered;
          last = n < 0 ? "still loading" : `${n} rows`;
          if (n >= 0 && countMatches(n, step.count ?? "some")) return { chosen: null, observed: last, step };
        } else last = "no such grid";
        if (Date.now() > end) throw new Error(`expected the "${step.target}" grid to have ${step.count ?? "some"} rows; it has ${last}`);
        await sleep(400);
      }
    }
    case "expectSeries": {
      const dom = await dataOf(page);
      const chart = byName(dom.charts ?? [], String(step.target));
      if (!chart) throw new Error(`couldn't find the "${step.target}" chart`);
      const names = chart.series.map((/** @type {any} */ s) => s.name);
      if (!names.some((/** @type {string} */ n) => loose(n) === loose(step.value ?? ""))) throw new Error(`the "${chart.name}" chart has no "${step.value}" series (it has ${names.join(", ")})`);
      return { chosen: null, step };
    }
    case "expectNoErrors": {
      const dom = await dataOf(page);
      const bad = suspiciousText([], dom.text);
      if (bad.length) throw new Error(`the page shows ${bad[0].name}: "${bad[0].samples[0] ?? ""}"`);
      return { chosen: null, step };
    }
    case "screenshot":
      return { chosen: null, step };
    case "scroll": {
      const where = String(step.target ?? "down");
      if (where === "bottom") await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      else if (where === "top") await page.evaluate(() => window.scrollTo(0, 0));
      else if (where === "down" || where === "up") await page.mouse.wheel(0, where === "down" ? 600 : -600);
      else (await target("any", where)).scrollIntoViewIfNeeded();
      await sleep(300);
      return { chosen, step };
    }
    case "reload":
      await page.reload({ waitUntil: "load" });
      return { chosen: null, step };
    case "back":
      await page.goBack({ waitUntil: "load" }).catch(() => {});
      return { chosen: null, step };
    case "login":
      if (ctx.loggedIn) {
        if (step.target && ctx.user && loose(step.target) !== loose(ctx.user)) {
          throw new Error(`journeys run as the user the comparison logs in as (${ctx.user}); for ${step.target}, run envdiff with --user ${step.target}`);
        }
        return { chosen: null, note: "already signed in", step };
      }
      return perform(page, { ...step, action: "click", target: "log in" }, ctx, vars);
    default:
      throw new Error(`can't do "${step.action}"`);
  }
}

/** "no", "some", "3", "at least 3", "more than 3", "fewer than 3". @param {number} n @param {string} want */
function countMatches(n, want) {
  const w = want.toLowerCase();
  if (w === "no") return n === 0;
  if (w === "some" || w === "any") return n > 0;
  const k = Number(/\d+/.exec(w)?.[0]);
  if (/at least/.test(w)) return n >= k;
  if (/more than/.test(w)) return n > k;
  if (/fewer than|less than/.test(w)) return n < k;
  return n === k;
}

/**
 * Is this text, or a control with this name, on screen?
 * @param {import("playwright").Page} page
 * @param {string} what
 */
async function visibleText(page, what) {
  const want = loose(what);
  if (!want) return true;
  const inText = await page
    .evaluate((w) => {
      const t = String(document.body ? document.body.innerText : "")
        .replace(/\s+/g, " ")
        .toLowerCase();
      return t.includes(w);
    }, want)
    .catch(() => false);
  if (inText) return true;
  const found = await page.evaluate(locateTarget, { kind: "any", phrase: what }).catch(() => []);
  return !!found[0] && found[0].score >= 80;
}
