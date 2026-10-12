import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { renderMarkdown, renderJunit } from "../../src/report/index.js";
import { renderHtml } from "../../src/report/html.js";
import { triage } from "../../src/ai/triage.js";
import { resolveConfig } from "../../src/config.js";
import { createLogger } from "../../src/util/log.js";

function sampleReport() {
  return {
    tool: { name: "envdiff", version: "0.0.0" },
    meta: {
      title: "UAT vs DEV",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(60000).toISOString(),
      durationMs: 61000,
      baseline: { label: "UAT", url: "https://uat.example.com/" },
      candidate: { label: "DEV", url: "https://dev.example.com/", ref: "feature/x", sha: "abcdef1234567" },
      viewports: ["desktop 1366×900"],
      browser: "chromium",
      settings: { maxPages: 25, maxDepth: 3, explore: "25 actions/page, depth 1", mutations: "blocked", failOn: "critical" },
      aborted: null,
    },
    summary: { verdict: "fail", failOn: "critical", counts: { critical: 1, major: 1, minor: 1, info: 0 }, failing: 1, pages: 1, interactions: 2, interactionsDifferent: 1, journeys: 0, suppressed: 0, notCrawled: 0 },
    findings: [
      { id: "aaaaaaaaaa", severity: "critical", category: "interaction", type: "interaction.no-effect", title: 'Clicking button "Pay | now" does nothing <script>', page: "/cart", viewport: "desktop", evidence: { baseline: "assets/b.png", candidate: "assets/c.png" } },
      { id: "bbbbbbbbbb", severity: "major", category: "api", type: "api.field-missing", title: "GET /api/me lacks email", page: "/cart", viewport: "desktop", detail: "Missing:\nemail" },
      { id: "cccccccccc", severity: "minor", category: "content", type: "content.text", title: "Text changed", page: "/cart", viewport: "desktop" },
    ],
    pages: [
      {
        key: "/cart",
        viewport: "desktop",
        depth: 0,
        baseline: { url: "https://uat.example.com/cart", finalUrl: "https://uat.example.com/cart", status: 200, error: null, loadMs: 500, title: "Cart", screenshot: "assets/b.png", counts: null, perf: null, a11y: null },
        candidate: { url: "https://dev.example.com/cart", finalUrl: "https://dev.example.com/cart", status: 200, error: null, loadMs: 700, title: "Cart", screenshot: "assets/c.png", counts: null, perf: null, a11y: null },
        visual: { ratio: 0.05, regions: [{ x: 10, y: 10, w: 50, h: 20, pixels: 300, label: 'near button "Pay"' }], diff: null },
        text: null,
        interactions: [],
        skipped: [],
        findings: ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"],
      },
    ],
    journeys: [],
    api: [],
    linkChecks: [],
    crawl: { skippedByPattern: 0, notCrawled: [] },
    errors: [],
  };
}

test("markdown summary escapes table cells and folds non-failing severities", () => {
  const md = renderMarkdown(sampleReport(), { reportUrl: "https://example.com/run" });
  assert.match(md, /❌ FAIL/);
  assert.match(md, /### 🔴 Critical \(1\)/);
  assert.match(md, /<summary>🟠 Major \(1\)<\/summary>/);
  assert.match(md, /Pay \\\| now/);
  assert.match(md, /&lt;script>/);
  assert.match(md, /\[Open the full report\]\(https:\/\/example.com\/run\)/);
  assert.match(md, /`feature\/x` @ abcdef1/);
});

test("junit: one failing case per page, XML-escaped", () => {
  const xml = renderJunit(sampleReport());
  assert.match(xml, /<testsuites name="envdiff" tests="1" failures="1">/);
  assert.match(xml, /<testcase classname="envdiff.pages" name="\/cart \(desktop\)">/);
  assert.match(xml, /&lt;script&gt;/);
  assert.match(xml, /<system-out>\[major\] GET \/api\/me lacks email/);
});

test("html embeds the data safely", () => {
  const html = renderHtml(sampleReport());
  assert.match(html, /<title>FAIL · UAT vs DEV · envdiff<\/title>/);
  assert.ok(!html.includes("<script>'"), "no raw script tag from the data");
  const json = html.split('<script id="envdiff-data" type="application/json">')[1].split("</script>")[0];
  assert.equal(JSON.parse(json).findings[0].title, 'Clicking button "Pay | now" does nothing <script>');
});

test("AI triage labels findings using a (fake) Claude client", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envdiff-ai-"));
  fs.mkdirSync(path.join(dir, "assets"));
  for (const f of ["b.png", "c.png"]) {
    const img = new PNG({ width: 300, height: 200 });
    img.data.fill(255);
    fs.writeFileSync(path.join(dir, "assets", f), PNG.sync.write(img));
  }
  const report = sampleReport();
  const calls = [];
  const client = {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          if (params.output_config?.format) {
            const ids = [...params.messages[0].content[0].text.matchAll(/id=(\w+)/g)].map((m) => m[1]);
            return {
              stop_reason: "end_turn",
              usage: { input_tokens: 1000, output_tokens: 100 },
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    findings: ids.map((id, i) => ({ id, verdict: i === 0 ? "regression" : "environment_difference", confidence: 0.8, explanation: "because" })),
                    summary: "Pay button is dead.",
                  }),
                },
              ],
            };
          }
          return { stop_reason: "end_turn", usage: { input_tokens: 200, output_tokens: 50 }, content: [{ type: "text", text: "Not safe to promote: the Pay button does nothing." }] };
        },
      },
    },
  };
  const cfg = resolveConfig({ ai: { enabled: true } });
  await triage(report, { cfg, outDir: dir, log: createLogger({ level: "silent" }), client });

  const first = calls[0];
  assert.equal(first.model, "claude-opus-5-5");
  assert.deepEqual(first.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(first.fallbacks, "default");
  assert.equal(first.output_config.format.type, "json_schema");
  assert.equal(first.thinking, undefined, "Opus 5.5 thinking is adaptive by default; no thinking param");
  const images = first.messages[0].content.filter((b) => b.type === "image");
  assert.equal(images.length, 2, "baseline and candidate screenshots are attached");
  assert.equal(images[0].source.media_type, "image/png");

  assert.equal(report.findings[0].ai.verdict, "regression");
  assert.equal(report.findings[1].ai.verdict, "environment_difference");
  assert.equal(report.findings[2].ai.verdict, "environment_difference");
  assert.equal(report.ai.summary, "Not safe to promote: the Pay button does nothing.");
  assert.deepEqual(report.ai.usage, { input: 1200, output: 150 });
  assert.equal(report.summary.verdict, "fail", "AI labels never change the verdict");
  fs.rmSync(dir, { recursive: true, force: true });
});
