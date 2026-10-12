import path from "node:path";
import { instrumentPage } from "./instrument.js";
import { settle, screenshot } from "./capture.js";
import { runStep, describeStep, parseStep, stepError } from "./steps.js";
import { compareLogs } from "./compare/page.js";
import { diffImages } from "./compare/visual.js";
import { slugify, shortHash, truncate } from "./util/misc.js";

/**
 * @typedef {object} JourneyStepResult
 * @property {string} label
 * @property {{ ok: boolean, error?: string, key: string|null }} baseline
 * @property {{ ok: boolean, error?: string, key: string|null }} candidate
 * @property {"same"|"different"|"skipped"} verdict
 * @property {{ baseline?: string, candidate?: string, diff?: string }} screenshots
 * @property {number} [visualRatio]
 */

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
    // Journeys start from the first start path unless their first step navigates.
    const first = journey.steps[0] ? parseStep(journey.steps[0]).action : null;
    if (first !== "goto") {
      await Promise.all(tabs.map((t) => t.page.goto(t.session.scope.urlFor(cfg.crawl.startPaths[0]), { waitUntil: "load" }).catch(() => {})));
    }
    for (const [i, step] of journey.steps.entries()) {
      const label = describeStep(step);
      if (stopped) {
        steps.push({ label, baseline: { ok: false, key: null }, candidate: { ok: false, key: null }, verdict: "skipped", screenshots: {} });
        continue;
      }
      const outcomes = await Promise.all(
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
      const [b, c] = outcomes;
      /** @type {JourneyStepResult} */
      const result = {
        label,
        baseline: { ok: b.ok, error: b.error, key: b.key },
        candidate: { ok: c.ok, error: c.error, key: c.key },
        verdict: "same",
        screenshots: {},
      };
      const before = findingIds.length;
      const stepName = `step ${i + 1} (${label})`;
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
      }
      compareLogs({ log: b.log }, { log: c.log }, { add: (f) => record({ ...f, fp: `${i}|${f.fp}` }), where: {}, context: `in journey "${journey.name}" ${stepName}` });

      const wantShot = parseStep(step).action === "screenshot" || journey.screenshotEveryStep || (findingIds.length > before && !stopped) || stopped;
      if (wantShot) {
        const base = `journey-${slugify(journey.name, 30)}-${shortHash(journey.name, 4)}-${i + 1}`;
        await Promise.all(
          tabs.map(async (t) => {
            const rel = ctx.assetPath(`${base}-${t.side}.png`);
            try {
              const height = await t.page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
              await screenshot(t.page, path.join(ctx.outDir, rel), cfg, { scrollHeight: height });
              result.screenshots[t.side] = rel;
            } catch {
              // closed or navigating
            }
          }),
        );
        if (result.screenshots.baseline && result.screenshots.candidate) {
          const diffRel = ctx.assetPath(`${base}-diff.png`);
          const d = diffImages(path.join(ctx.outDir, result.screenshots.baseline), path.join(ctx.outDir, result.screenshots.candidate), path.join(ctx.outDir, diffRel), {
            threshold: cfg.visual.threshold,
          });
          result.visualRatio = Math.round(d.ratio * 10000) / 10000;
          if (d.diffPixels) result.screenshots.diff = diffRel;
          if (d.ratio >= cfg.visual.minRatio && parseStep(step).action === "screenshot") {
            record({
              severity: d.ratio >= cfg.visual.majorRatio ? "major" : "minor",
              category: "visual",
              type: "journey.visual",
              title: `Journey "${journey.name}" checkpoint "${truncate(String(parseStep(step).arg), 40)}" looks different (${(d.ratio * 100).toFixed(1)}% changed)`,
              evidence: { ...result.screenshots },
              fp: `shot:${i}`,
            });
          }
        }
      }
      if (findingIds.length > before) result.verdict = "different";
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
