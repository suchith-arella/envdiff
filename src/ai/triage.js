/**
 * Optional AI triage: label each finding as a likely regression, an intended
 * change, an environment/data difference, or noise — using the screenshots as
 * evidence — and write a short summary for the QA lead.
 *
 * Advisory only: labels never change severities or the pass/fail verdict.
 * Sends screenshots and finding text to the configured provider (Claude via
 * the Anthropic API, or GitHub Copilot); off by default.
 */
import path from "node:path";
import fs from "node:fs";
import { PNG } from "pngjs";
import { cropPng } from "../compare/visual.js";
import { atLeast, severityRank } from "../config.js";
import { mapLimit, truncate } from "../util/misc.js";
import { createProvider, AIUnavailableError } from "./provider.js";

const VERDICTS = ["regression", "intended_change", "environment_difference", "noise"];

const SYSTEM = `You are a senior QA engineer triaging the output of an automated comparison between two deployments of the same web application:
- BASELINE: the known-good version (for example production or UAT)
- CANDIDATE: the version with new code (for example a dev environment or a feature branch)

The tool loaded the same pages in both, clicked every safe control, and reported differences. For each finding, decide what it most likely is:
- regression: the candidate is broken or worse in a way a user would notice — errors, missing or dead controls, broken flows, wrong or unrendered data, layout breakage
- intended_change: a deliberate product or design change — new copy, restyled or moved elements, a new feature
- environment_difference: expected because the environments differ — different data or catalog, feature flags, configuration, missing third-party keys, slower non-production infrastructure
- noise: an artifact of the comparison — timing, animation, dynamic content such as clocks or counters

Use the screenshots as evidence where they help. When torn between regression and another label, choose regression with lower confidence: a missed bug costs more than a second look. Keep each explanation under 30 words and specific to what you see.`;

const SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: VERDICTS },
          confidence: { type: "number" },
          explanation: { type: "string" },
        },
        required: ["id", "verdict", "confidence", "explanation"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["findings", "summary"],
  additionalProperties: false,
};

/**
 * @param {any} report The report object, mutated in place: findings gain `ai`, report gains `ai`.
 * @param {{ cfg: import("../config.js").Config, outDir: string, log: import("../util/log.js").Logger, provider?: import("./provider.js").AIProvider, client?: any }} ctx
 *   `provider` replaces the configured one; `client` an Anthropic client (tests).
 */
export async function triage(report, { cfg, outDir, log, provider: given, client }) {
  const groups = buildGroups(report, cfg);
  if (!groups.length) {
    report.ai = { model: cfg.ai.model, summary: "Nothing at or above the triage threshold.", counts: {} };
    return;
  }
  const provider =
    given ?? (await createProvider(client ? { ...cfg, ai: { ...cfg.ai, provider: "anthropic" } } : cfg, { log, outDir, anthropicClient: client }));
  const where = provider.name === "copilot" ? "GitHub Copilot" : "the Anthropic API";
  log.info(`AI triage: ${groups.length} page(s)/journey(s) → ${provider.model} (sends screenshots and findings to ${where})…`);

  /** @type {{ key: string, summary: string }[]} */
  const pageSummaries = [];
  let failures = 0;
  /** @type {Error | null} */
  let fatal = null;
  try {
    await mapLimit(groups, 3, async (g) => {
      if (fatal) return;
      try {
        const res = await provider.ask({
          system: SYSTEM,
          parts: [
            { type: "text", text: describeGroup(g, report) },
            ...evidenceFor(g, report, outDir),
            { type: "text", text: "Classify every finding id listed above, then summarize this page in one sentence." },
          ],
          schema: SCHEMA,
          effort: cfg.ai.effort,
          maxTokens: 16000,
        });
        if (res.refused) {
          log.debug(`AI triage declined ${g.label}`);
          failures++;
          return;
        }
        const parsed = res.json ?? {};
        for (const r of parsed.findings ?? []) {
          const f = report.findings.find((/** @type {any} */ x) => x.id === r.id);
          if (!f || !VERDICTS.includes(r.verdict)) continue;
          f.ai = { verdict: r.verdict, confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)), explanation: String(r.explanation).slice(0, 300) };
        }
        if (parsed.summary) pageSummaries.push({ key: g.label, summary: String(parsed.summary).slice(0, 400) });
      } catch (e) {
        failures++;
        if (e instanceof AIUnavailableError) fatal = e;
        else log.debug(`AI triage failed for ${g.label}: ${/** @type {Error} */ (e).message}`);
      }
    });
    if (fatal) throw fatal;

    /** @type {Record<string, number>} */
    const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
    for (const f of report.findings) if (f.ai) counts[f.ai.verdict]++;

    let summary = "";
    try {
      const regressions = report.findings
        .filter((/** @type {any} */ f) => f.ai?.verdict === "regression")
        .slice(0, 25)
        .map((/** @type {any} */ f) => `- [${f.severity}] ${f.page ?? f.journey ?? ""}: ${f.title}`);
      const res = await provider.ask({
        system:
          "You write the summary at the top of a QA comparison report. Plain sentences, no headings or bullet points, at most 4 sentences. Lead with whether the candidate looks safe to promote and the most important regressions, naming pages.",
        parts: [
          {
            type: "text",
            text: `Baseline: ${report.meta.baseline.label} (${report.meta.baseline.url})\nCandidate: ${report.meta.candidate.label} (${report.meta.candidate.url})\nDeterministic verdict: ${report.summary.verdict} (${JSON.stringify(report.summary.counts)})\nAI labels: ${JSON.stringify(counts)}\n\nLikely regressions:\n${regressions.join("\n") || "(none)"}\n\nPer-page notes:\n${pageSummaries.map((p) => `- ${p.key}: ${p.summary}`).join("\n")}`,
          },
        ],
        effort: "low",
        maxTokens: 4000,
      });
      if (!res.refused) summary = res.text.trim();
    } catch (e) {
      log.debug(`AI summary failed: ${/** @type {Error} */ (e).message}`);
    }

    report.ai = {
      provider: provider.name,
      model: provider.model,
      summary: summary || (pageSummaries.length ? pageSummaries.map((p) => `${p.key}: ${p.summary}`).join(" ") : ""),
      counts,
      pages: pageSummaries,
      usage: provider.usage,
      failures,
    };
    log.info(
      `AI triage: ${counts.regression} likely regression(s), ${counts.intended_change} intended, ${counts.environment_difference} environment, ${counts.noise} noise` +
        (failures ? ` (${failures} group(s) not triaged)` : ""),
    );
  } finally {
    if (!given) await provider.close();
  }
}

/**
 * Findings worth a look, grouped by page/viewport or journey, worst first.
 * @param {any} report
 * @param {import("../config.js").Config} cfg
 */
function buildGroups(report, cfg) {
  /** @type {Map<string, { label: string, page?: string, viewport?: string, journey?: string, findings: any[] }>} */
  const groups = new Map();
  for (const f of report.findings) {
    if (!atLeast(f.severity, cfg.ai.minSeverity)) continue;
    const k = f.journey ? `journey:${f.journey}` : `page:${f.page ?? ""}|${f.viewport ?? ""}`;
    let g = groups.get(k);
    if (!g) {
      g = f.journey
        ? { label: `journey "${f.journey}"`, journey: f.journey, findings: [] }
        : { label: `${f.page ?? "(site)"}${f.viewport ? ` (${f.viewport})` : ""}`, page: f.page, viewport: f.viewport, findings: [] };
      groups.set(k, g);
    }
    if (g.findings.length < 25) g.findings.push(f);
  }
  const worst = (/** @type {{ findings: any[] }} */ g) => Math.min(...g.findings.map((f) => severityRank(f.severity)));
  return [...groups.values()].sort((a, b) => worst(a) - worst(b) || b.findings.length - a.findings.length).slice(0, cfg.ai.maxItems);
}

/** @param {any} g @param {any} report */
function describeGroup(g, report) {
  const { baseline, candidate } = report.meta;
  const lines = [
    `Baseline: ${baseline.label} — ${baseline.url}`,
    `Candidate: ${candidate.label} — ${candidate.url}`,
    g.journey ? `Journey: ${g.journey}` : `Page: ${g.page ?? "(site-wide)"}${g.viewport ? `, viewport ${g.viewport}` : ""}`,
    "",
    "Findings:",
  ];
  for (const f of g.findings) {
    lines.push(`- id=${f.id} [${f.severity}] (${f.type}) ${f.title}`);
    if (f.detail) lines.push(`  details: ${truncate(f.detail.replace(/\n/g, " | "), 500)}`);
  }
  return lines.join("\n");
}

/**
 * Screenshot evidence for a group: the page's two screenshots, cropped to the
 * changed regions, plus up to two interaction after-states.
 * @param {any} g
 * @param {any} report
 * @param {string} outDir
 */
function evidenceFor(g, report, outDir) {
  /** @type {import("./provider.js").AIPart[]} */
  const blocks = [];
  /** @param {string} label @param {string} rel @param {{x:number,y:number,w:number,h:number}} [rect] */
  const image = (label, rel, rect) => {
    const file = path.join(outDir, rel);
    if (!fs.existsSync(file)) return;
    try {
      const size = pngSize(file);
      const r = rect ?? { x: 0, y: 0, w: size.width, h: Math.min(size.height, 1400) };
      const data = cropPng(file, r, 1200).toString("base64");
      blocks.push({ type: "text", text: label });
      blocks.push({ type: "image", mediaType: "image/png", data });
    } catch {
      // unreadable image; skip it
    }
  };
  const page = g.page ? report.pages.find((/** @type {any} */ p) => p.key === g.page && (!g.viewport || p.viewport === g.viewport)) : null;
  if (page?.baseline.screenshot && page?.candidate.screenshot) {
    const rect = focusRect(page.visual?.regions ?? []);
    const where = rect ? `around the changed area (y=${rect.y}-${rect.y + rect.h})` : "top of the page";
    image(`BASELINE page, ${where}:`, page.baseline.screenshot, rect);
    image(`CANDIDATE page, ${where}:`, page.candidate.screenshot, rect);
  }
  let shots = 0;
  for (const f of g.findings) {
    if (shots >= 2) break;
    const ev = f.evidence;
    if (!ev?.baseline || !ev?.candidate || ev.baseline === page?.baseline.screenshot) continue;
    image(`BASELINE after the action in finding ${f.id}:`, ev.baseline);
    image(`CANDIDATE after the action in finding ${f.id}:`, ev.candidate);
    shots++;
  }
  return blocks;
}

/** One rectangle covering the biggest changed regions, padded, at most 1600px tall. @param {any[]} regions */
function focusRect(regions) {
  if (!regions.length) return null;
  const top = regions.slice(0, 3);
  const x0 = Math.min(...top.map((r) => r.x));
  const y0 = Math.min(...top.map((r) => r.y));
  const x1 = Math.max(...top.map((r) => r.x + r.w));
  const y1 = Math.max(...top.map((r) => r.y + r.h));
  const pad = 120;
  const y = Math.max(0, y0 - pad);
  return { x: Math.max(0, x0 - pad * 4), y, w: x1 - x0 + pad * 8, h: Math.min(1600, y1 - y + pad) };
}

/** @param {string} file */
function pngSize(file) {
  // Width and height live in the IHDR chunk; no need to decode the image.
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  if (buf.readUInt32BE(12) !== 0x49484452) {
    const png = PNG.sync.read(fs.readFileSync(file));
    return { width: png.width, height: png.height };
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
