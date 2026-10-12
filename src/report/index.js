import fs from "node:fs/promises";
import path from "node:path";
import { renderHtml } from "./html.js";
import { atLeast, SEVERITIES } from "../config.js";

const ICON = /** @type {Record<string,string>} */ ({ critical: "🔴", major: "🟠", minor: "🟡", info: "⚪" });

/**
 * Write every report format into `outDir`.
 * @param {string} outDir
 * @param {any} report
 */
export async function writeReports(outDir, report) {
  await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(outDir, "summary.md"), renderMarkdown(report));
  await fs.writeFile(path.join(outDir, "junit.xml"), renderJunit(report));
  await fs.writeFile(path.join(outDir, "index.html"), renderHtml(report));
}

/** @param {string} s */
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").replace(/</g, "&lt;");

/**
 * Markdown for a GitHub job summary or PR comment. Kept well under GitHub's
 * size limits by capping rows per severity.
 * @param {any} report
 * @param {{ reportUrl?: string, maxRows?: number }} [opts]
 */
export function renderMarkdown(report, opts = {}) {
  const { meta, summary } = report;
  const maxRows = opts.maxRows ?? 40;
  const verdict = summary.verdict === "fail" ? "❌ FAIL" : "✅ PASS";
  const lines = [];
  lines.push(`## envdiff — ${cell(meta.title)}: ${verdict}`);
  lines.push("");
  const env = (/** @type {any} */ e) => `[${cell(e.label)}](${e.url})${e.ref ? ` (\`${cell(e.ref)}\`${e.sha ? ` @ ${e.sha.slice(0, 7)}` : ""})` : ""}`;
  lines.push(`**Baseline:** ${env(meta.baseline)} · **Candidate:** ${env(meta.candidate)}`);
  lines.push(
    `${summary.pages} pages · ${summary.interactions} interactions (${summary.interactionsDifferent} behaved differently) · ${summary.journeys} journeys · ${fmtDuration(meta.durationMs)}` +
      (summary.notCrawled ? ` · ${summary.notCrawled} more pages not crawled (limit)` : "") +
      (summary.flaky ? ` · ${summary.flaky} one-off differences didn't reproduce and aren't reported` : ""),
  );
  if (meta.aborted) lines.push(`\n> ⚠️ ${meta.aborted}`);
  if (report.errors?.length) lines.push(`\n> ⚠️ ${report.errors.length} page(s) could not be processed; see the full report.`);
  lines.push("");
  lines.push("| 🔴 Critical | 🟠 Major | 🟡 Minor | ⚪ Info |");
  lines.push("|:-:|:-:|:-:|:-:|");
  lines.push(`| ${summary.counts.critical} | ${summary.counts.major} | ${summary.counts.minor} | ${summary.counts.info} |`);
  lines.push("");
  if (report.ai?.summary) {
    lines.push(`**AI triage:** ${cell(report.ai.summary)}`);
    lines.push("");
  }
  for (const sev of SEVERITIES) {
    if (sev === "info") continue;
    const items = report.findings.filter((/** @type {any} */ f) => f.severity === sev);
    if (!items.length) continue;
    const failing = atLeast(sev, summary.failOn);
    const header = `${ICON[sev]} ${sev[0].toUpperCase()}${sev.slice(1)} (${items.length})`;
    if (failing) lines.push(`### ${header}`, "");
    else lines.push(`<details><summary>${header}</summary>`, "");
    lines.push("| Where | Finding |", "|---|---|");
    for (const f of items.slice(0, maxRows)) {
      const where = f.journey
        ? `journey: ${f.journey}`
        : `${f.page ?? ""}${f.pages && f.pages.length > 1 ? ` +${f.pages.length - 1} more` : ""}${f.viewport && f.viewport !== "desktop" ? ` (${f.viewport})` : ""}`;
      const ai = f.ai ? ` _(AI: ${f.ai.verdict.replace(/_/g, " ")})_` : "";
      lines.push(`| \`${cell(where)}\` | ${cell(f.title)}${ai} |`);
    }
    if (items.length > maxRows) lines.push(`| … | ${items.length - maxRows} more in the full report |`);
    lines.push("");
    if (!failing) lines.push("</details>", "");
  }
  if (!report.findings.length) lines.push("No differences found. 🎉", "");
  lines.push(
    opts.reportUrl
      ? `[Open the full report](${opts.reportUrl}) — screenshots, visual diffs and every interaction.`
      : `_Open \`index.html\` from the report artifact for screenshots, visual diffs and every interaction._`,
  );
  return lines.join("\n") + "\n";
}

/** @param {string} s */
const xml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/**
 * JUnit XML: one test case per page/viewport and per journey. Findings at or
 * above failOn fail the case; the rest go to system-out.
 * @param {any} report
 */
export function renderJunit(report) {
  /** @type {Map<string, { suite: string, name: string, findings: any[] }>} */
  const cases = new Map();
  const caseFor = (/** @type {string} */ suite, /** @type {string} */ name) => {
    const k = `${suite}|${name}`;
    let c = cases.get(k);
    if (!c) {
      c = { suite, name, findings: [] };
      cases.set(k, c);
    }
    return c;
  };
  for (const p of report.pages) caseFor("pages", `${p.key} (${p.viewport})`);
  for (const j of report.journeys) caseFor("journeys", j.name);
  for (const f of report.findings) {
    if (f.journey) caseFor("journeys", f.journey).findings.push(f);
    else if (f.page) caseFor("pages", `${f.page} (${f.viewport ?? report.pages.find((/** @type {any} */ p) => p.key === f.page)?.viewport ?? "desktop"})`).findings.push(f);
    else caseFor("run", "run").findings.push(f);
  }
  /** @type {Map<string, typeof cases extends Map<any, infer V> ? V[] : never>} */
  const suites = new Map();
  for (const c of cases.values()) suites.set(c.suite, [...(suites.get(c.suite) ?? []), c]);
  const failOn = report.summary.failOn;
  let total = 0;
  let failures = 0;
  const body = [];
  for (const [suite, list] of suites) {
    const failed = list.filter((c) => c.findings.some((f) => atLeast(f.severity, failOn))).length;
    total += list.length;
    failures += failed;
    body.push(`  <testsuite name="envdiff.${xml(suite)}" tests="${list.length}" failures="${failed}">`);
    for (const c of list) {
      const bad = c.findings.filter((f) => atLeast(f.severity, failOn));
      const rest = c.findings.filter((f) => !atLeast(f.severity, failOn));
      body.push(`    <testcase classname="envdiff.${xml(suite)}" name="${xml(c.name)}">`);
      if (bad.length) {
        body.push(`      <failure message="${xml(`${bad.length} finding(s): ${bad[0].title}`)}" type="${xml(bad[0].severity)}">`);
        body.push(xml(bad.map((f) => `[${f.severity}] ${f.title}${f.detail ? `\n  ${f.detail.replace(/\n/g, "\n  ")}` : ""}`).join("\n")));
        body.push(`      </failure>`);
      }
      if (rest.length) body.push(`      <system-out>${xml(rest.map((f) => `[${f.severity}] ${f.title}`).join("\n"))}</system-out>`);
      body.push(`    </testcase>`);
    }
    body.push(`  </testsuite>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="envdiff" tests="${total}" failures="${failures}">\n${body.join("\n")}\n</testsuites>\n`;
}

/** @param {number} ms */
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
