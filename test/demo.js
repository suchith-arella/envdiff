/**
 * npm run demo [-- envdiff options]
 *
 * Starts the fixture shop twice — a baseline and a candidate with planted
 * regressions — and compares them, so you can see a real report in a minute.
 */
import { startSite } from "./fixtures/site/server.js";
import { main } from "../src/cli.js";

const baseline = await startSite({ variant: "baseline" });
const candidate = await startSite({ variant: "candidate" });
const extra = process.argv.slice(2);
try {
  const code = await main([
    baseline.url,
    candidate.url,
    "--baseline-label",
    "Shop (baseline)",
    "--candidate-label",
    "Shop (candidate)",
    "--viewports",
    "desktop,mobile",
    "--click-depth",
    "2",
    "--mask",
    ".clock",
    "--mask",
    ".visitors",
    "--ignore-text",
    "Visitors online",
    ...(extra.includes("--out") || extra.includes("-o") ? [] : ["--out", "envdiff-demo"]),
    ...extra,
  ]);
  // Finding regressions is the point of the demo, not a failure.
  process.exitCode = code === 1 ? 0 : code;
} finally {
  await baseline.close();
  await candidate.close();
}
