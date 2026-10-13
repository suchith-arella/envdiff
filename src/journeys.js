import path from "node:path";
import { instrumentPage } from "./instrument.js";
import { settle, screenshot } from "./capture.js";
import { runStep, describeStep, parseStep, stepError } from "./steps.js";
import { parsePlainStep, plainLabel } from "./plain.js";
import { runPlainStep, performStep, ACTING, secretsIn } from "./smart.js";
import { pageInventory, signature } from "./explore.js";
import { tooltipShape } from "./compare/charts.js";
import { compareLogs } from "./compare/page.js";
import { diffImages } from "./compare/visual.js";
import { viewportDataRects } from "./inpage/collect.js";
import { totp } from "./login.js";
import { slugify, shortHash, truncate } from "./util/misc.js";

/**
 * @typedef {{ ok: boolean, error?: string, key: string|null, observed?: string }} SideResult
 * @typedef {object} JourneyStepResult
 * @property {string} label
 * @property {SideResult} baseline
 * @property {SideResult} candidate
 * @property {"same"|"different"|"skipped"} verdict
 * @property {{ baseline?: string, candidate?: string, diff?: string }} screenshots
 * @property {number} [visualRatio]
 * @property {string} [note] How a plain-English step was carried out, when not as written.
 */

/** Structured steps that change something; the rest look or wait. */
const STRUCTURED_ACTING = new Set(["goto", "click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "hover"]);

/**
 * {{username}}, {{password}} and {{totp}} for one side's journey steps.
 * @param {import("./config.js").AuthConfig | undefined} auth
 */
function varsFor(auth) {
  /** @type {Record<string, string>} */
  const vars = {};
  if (auth?.username) vars.username = String(auth.username);
  if (auth?.password) vars.password = String(auth.password);
  if (auth?.totp) Object.defineProperty(vars, "totp", { get: () => totp(String(auth.totp)), enumerable: true });
  return vars;
}

/**
 * Run every configured journey in both environments, step by step, and
 * compare where each step leaves them.
 * @param {object} ctx
 * @param {{ baseline: import("./session.js").EnvSession, candidate: import("./session.js").EnvSession }} ctx.sessions
 * @param {import("./config.js").Config} ctx.cfg
 * @param {(f: any) => any} ctx.add
 * @param {string} ctx.outDir
 * @param {(name: string) => string} ctx.assetPath
 * @param {import("./util/log.js").Logger} ctx.log
 * @param {() => boolean} ctx.stopped
 * @param {(() => Promise<import("./ai/provider.js").AIProvider | null>) | null} [ctx.ai]
 *   The AI provider, for plain-English steps envdiff can't read or find on its own.
 * @param {(e: Error) => void} [ctx.onAiError] Told when the provider refuses to work at all.
 */
export async function runJourneys(ctx) {
  const results = [];
  for (const journey of ctx.cfg.journeys) {
    if (ctx.stopped()) break;
    ctx.log.info(`  journey: ${journey.name}`);
    results.push(await runJourney(journey, ctx));
  }
  return results;
}

/**
 * @param {import("./config.js").JourneyConfig} journey
 * @param {Parameters<typeof runJourneys>[0]} ctx
 */
async function runJourney(journey, ctx) {
  const { sessions, cfg, add } = ctx;
  const sides = /** @type {const} */ (["baseline", "candidate"]);
  const tabs = await Promise.all(
    sides.map(async (side) => {
      const session = sessions[side];
      const page = await session.context.newPage();
      return { side, session, page, inst: instrumentPage(page, session) };
    }),
  );
  const allowMutations = journey.allowMutations ?? cfg.safety.allowMutations;
  for (const t of tabs) if (allowMutations) t.session.guard.allowAll = true;
  const where = { journey: journey.name, viewport: sessions.baseline.viewport.name };
  /** @type {string[]} */
  const findingIds = [];
  const record = (/** @type {any} */ f) => {
    const r = add({ ...where, ...f });
    if (r) findingIds.push(r.id);
  };
  /** @type {JourneyStepResult[]} */
  const steps = [];
  let stopped = false;
  try {
    // Journeys start from the first start path unless their first step opens an address.
    const opening = journey.steps[0];
    const first = opening === undefined ? null : typeof opening === "string" ? parsePlainStep(opening)?.action ?? null : parseStep(opening).action;
    if (first !== "goto") {
      await Promise.all(tabs.map((t) => t.page.goto(t.session.scope.urlFor(cfg.crawl.startPaths[0]), { waitUntil: "load" }).catch(() => {})));
    }
    const vars = tabs.map((t) => varsFor(cfg[t.side].auth));
    const loggedIn = tabs.map((t) => !!cfg[t.side].auth);
    /** @type {string[]} */
    const history = [];
    /** @type {((step: any, page: import("playwright").Page, why: string) => Promise<any>) | undefined} */
    const plan = ctx.ai
      ? async (step, page, why) => {
          const provider = await /** @type {NonNullable<typeof ctx.ai>} */ (ctx.ai)();
          if (!provider) return null;
          const { planStep } = await import("./ai/planner.js");
          try {
            return await planStep(provider, { step, page, why, history });
          } catch (e) {
            const { AIUnavailableError } = await import("./ai/provider.js");
            if (e instanceof AIUnavailableError) ctx.onAiError?.(e);
            else ctx.log.debug(`AI couldn't read "${step.text}": ${/** @type {Error} */ (e).message}`);
            return null;
          }
        }
      : undefined;
    const sigOf = async (/** @type {(typeof tabs)[number]} */ t) => {
      try {
        return signature(await pageInventory(t.page, cfg), cfg);
      } catch {
        return null; // navigating
      }
    };
    for (const [i, step] of journey.steps.entries()) {
      const plain = typeof step === "string";
      const parsed = plain ? parsePlainStep(step) : null;
      const secrets = plain ? [...secretsIn(step, vars[0]), ...secretsIn(step, vars[1])] : [];
      const label = plain ? plainLabel(parsed ?? { text: step, action: "click" }, secrets) : describeStep(step);
      if (stopped) {
        steps.push({ label, baseline: { ok: false, key: null }, candidate: { ok: false, key: null }, verdict: "skipped", screenshots: {} });
        continue;
      }
      const acting = plain ? ACTING.has(parsed?.action ?? "click") : STRUCTURED_ACTING.has(parseStep(step).action);
      const before = acting ? await Promise.all(tabs.map(sigOf)) : [null, null];
      const keysBefore = tabs.map((t) => t.session.scope.keyOf(t.page.url(), { ignoreQuery: cfg.crawl.ignoreQuery }));
      /** @type {string | undefined} */
      let note;
      /** @type {{ ok: boolean, error?: string, key: string|null, log: import("./instrument.js").PageLog, observed?: string }[]} */
      let outcomes;
      if (plain) {
        // The baseline works out what the step means and which control it
        // names; the candidate then does the same thing to the same control.
        /** @type {import("./smart.js").PlainResult | null} */
        let first = null;
        outcomes = [];
        for (const [k, t] of tabs.entries()) {
          const mark = t.inst.mark();
          /** @type {string | undefined} */
          let error;
          /** @type {string | undefined} */
          let observed;
          try {
            const base = { scope: t.session.scope, timeout: 10000, vars: vars[k], loggedIn: loggedIn[k], user: cfg[t.side].login?.user };
            const r =
              k === 0 || !first
                ? await runPlainStep(t.page, parsed, step, { ...base, plan: k === 0 ? plan : undefined })
                : await performStep(t.page, first.step, { ...base, prefer: first.chosen });
            if (k === 0) {
              first = r;
              note = r.note;
            }
            observed = r.observed;
          } catch (e) {
            // An error can quote what the step typed or looked for: keep secrets out of it.
            error = plainLabel({ text: stepError(e), action: "error" }, secrets);
          }
          await settle(t.page, t.inst, { timeout: cfg.explore.settleTimeout + 1500, quietMs: 300 });
          await t.inst.flush(1500);
          outcomes.push({ ok: !error, error, observed, key: t.session.scope.keyOf(t.page.url(), { ignoreQuery: cfg.crawl.ignoreQuery }), log: t.inst.since(mark) });
        }
      } else {
        outcomes = await Promise.all(
          tabs.map(async (t) => {
            const mark = t.inst.mark();
            /** @type {string | undefined} */
            let error;
            try {
              await runStep(t.page, step, { scope: t.session.scope, timeout: 10000 });
            } catch (e) {
              error = stepError(e);
            }
            await settle(t.page, t.inst, { timeout: cfg.explore.settleTimeout + 1500, quietMs: 300 });
            await t.inst.flush(1500);
            return {
              ok: !error,
              error,
              key: t.session.scope.keyOf(t.page.url(), { ignoreQuery: cfg.crawl.ignoreQuery }),
              log: t.inst.since(mark),
            };
          }),
        );
      }
      history.push(label);
      const [b, c] = outcomes;
      /** @type {JourneyStepResult} */
      const result = {
        label,
        baseline: { ok: b.ok, error: b.error, key: b.key, observed: b.observed },
        candidate: { ok: c.ok, error: c.error, key: c.key, observed: c.observed },
        verdict: "same",
        screenshots: {},
        ...(note ? { note } : {}),
      };
      const before0 = findingIds.length;
      const stepName = `step ${i + 1} (${truncate(label, 80)})`;
      if (b.ok && !c.ok) {
        record({
          severity: "critical",
          category: "journey",
          type: "journey.step-failed",
          title: `Journey "${journey.name}" breaks on candidate at ${stepName}: ${c.error}`,
          fp: `step:${i}`,
        });
        stopped = true;
      } else if (!b.ok) {
        record({
          severity: c.ok ? "info" : "minor",
          category: "journey",
          type: "journey.baseline-failed",
          title: `Journey "${journey.name}" fails on ${c.ok ? "baseline only" : "both environments"} at ${stepName}: ${b.error}`,
          detail: "If the baseline fails too, the journey definition may be out of date.",
          fp: `baseline-step:${i}`,
        });
        stopped = true;
      } else if (b.key !== c.key) {
        record({
          severity: "major",
          category: "journey",
          type: "journey.diverged",
          title: `Journey "${journey.name}" diverges at ${stepName}: candidate is at ${c.key ?? "another site"}, baseline at ${b.key ?? "another site"}`,
          fp: `diverge:${i}`,
        });
      } else if (acting) {
        // Did the step do something on each side? Typing into a search box
        // that filters the grid on the baseline and nothing on the candidate.
        const after = await Promise.all(tabs.map(sigOf));
        const did = (/** @type {number} */ k) =>
          (before[k] !== null && after[k] !== null && before[k] !== after[k]) ||
          outcomes[k].key !== keysBefore[k] ||
          outcomes[k].log.requests.some((r) => r.firstParty && !r.noise && ["xhr", "fetch", "document"].includes(r.type) && r.failure !== "aborted");
        if (did(0) && !did(1)) {
          record({
            severity: "major",
            category: "journey",
            type: "journey.no-effect",
            title: `Journey "${journey.name}" ${stepName} changes the page on baseline but does nothing on candidate`,
            fp: `no-effect:${i}`,
          });
        }
      }
      if (b.ok && c.ok && b.observed && c.observed && b.observed !== c.observed && /tooltip/.test(b.observed)) {
        const lost = /^tooltip/.test(b.observed) && c.observed === "no tooltip";
        if (lost || tooltipShape(b.observed) !== tooltipShape(c.observed)) {
          record({
            severity: lost ? "major" : "minor",
            category: "journey",
            type: lost ? "journey.tooltip-missing" : "journey.tooltip",
            title: `Journey "${journey.name}" ${stepName}: ${lost ? `no tooltip on candidate (baseline: ${truncate(b.observed, 80)})` : `candidate shows ${truncate(c.observed, 80)}, baseline ${truncate(b.observed, 80)}`}`,
            fp: `tooltip:${i}`,
          });
        }
      }
      compareLogs({ log: b.log }, { log: c.log }, { add: (f) => record({ ...f, fp: `${i}|${f.fp}` }), where: {}, context: `in journey "${journey.name}" ${stepName}` });

      const isShotStep = plain ? parsed?.action === "screenshot" : parseStep(step).action === "screenshot";
      const wantShot = isShotStep || journey.screenshotEveryStep || (findingIds.length > before0 && !stopped) || stopped;
      if (wantShot) {
        const base = `journey-${slugify(journey.name, 30)}-${shortHash(journey.name, 4)}-${i + 1}`;
        /** @type {{ x: number, y: number, w: number, h: number }[]} Grids and charts, in page coordinates. */
        const ignore = [];
        await Promise.all(
          tabs.map(async (t) => {
            const rel = ctx.assetPath(`${base}-${t.side}.png`);
            try {
              const height = await t.page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
              await screenshot(t.page, path.join(ctx.outDir, rel), cfg, { scrollHeight: height });
              result.screenshots[t.side] = rel;
              if (cfg.data !== "same") {
                const scroll = await t.page.evaluate(() => ({ x: -scrollX, y: -scrollY })).catch(() => ({ x: 0, y: 0 }));
                ignore.push(...(await t.page.evaluate(viewportDataRects, scroll).catch(() => [])));
              }
            } catch {
              // closed or navigating
            }
          }),
        );
        if (result.screenshots.baseline && result.screenshots.candidate) {
          const diffRel = ctx.assetPath(`${base}-diff.png`);
          const d = diffImages(path.join(ctx.outDir, result.screenshots.baseline), path.join(ctx.outDir, result.screenshots.candidate), path.join(ctx.outDir, diffRel), {
            threshold: cfg.visual.threshold,
            ignore,
          });
          result.visualRatio = Math.round(d.ratio * 10000) / 10000;
          if (d.diffPixels) result.screenshots.diff = diffRel;
          if (d.ratio >= cfg.visual.minRatio && isShotStep) {
            const shotName = plain ? String(parsed?.name ?? label) : String(parseStep(step).arg);
            record({
              severity: d.ratio >= cfg.visual.majorRatio ? "major" : "minor",
              category: "visual",
              type: "journey.visual",
              title: `Journey "${journey.name}" checkpoint "${truncate(shotName, 40)}" looks different (${(d.ratio * 100).toFixed(1)}% changed)`,
              evidence: { ...result.screenshots },
              fp: `shot:${i}`,
            });
          }
        }
      }
      if (findingIds.length > before0) result.verdict = "different";
      steps.push(result);
    }
  } finally {
    for (const t of tabs) {
      t.session.guard.allowAll = false;
      await t.page.close().catch(() => {});
    }
  }
  return {
    name: journey.name,
    verdict: findingIds.length ? "different" : "same",
    steps,
    findings: findingIds,
  };
}
