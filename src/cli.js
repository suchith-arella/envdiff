import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfigFile, resolveConfig, ConfigError } from "./config.js";
import { classifyTarget } from "./targets.js";
import { run, VERSION } from "./run.js";
import { renderMarkdown } from "./report/index.js";
import { createLogger, color, formatDuration } from "./util/log.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const HELP = `
${color.bold("envdiff")} — deep-compare two environments or branches of a web app

${color.bold("Usage")}
  envdiff <baseline> <candidate> [options]
  envdiff init [file]                      write a commented starter config
  envdiff login <url> [--save auth.json]   log in by hand (SSO/MFA) and save the session

  baseline/candidate are URLs (https://uat.example.com, localhost:3000) or
  branch names (main, feature/login). Branches need --url-template or a
  branches.serve config. Prefix with url: or branch: to force either.

${color.bold("Common options")}
  -c, --config <file>          YAML/JSON/JS config (see examples/envdiff.config.yaml)
  -o, --out <dir>              Report directory (default: envdiff-report)
  -p, --paths </a,/b>          Start pages (default: the path of the baseline URL)
      --max-pages <n>          Pages to compare (default 25)
      --depth <n>              Link hops from the start pages (default 3)
      --actions <n>            Interactions per page; 0 disables clicking (default 25)
      --click-depth <n>        1 = click what's on the page; 2+ also what clicks reveal (default 1)
      --viewports <list>       desktop,mobile,tablet or WIDTHxHEIGHT (default desktop)
      --fail-on <level>        critical | major | minor | never (default critical)
      --url-template <tpl>     Branch → URL, e.g. https://{branch}.preview.example.com

${color.bold("Access")}
      --header <"Name: value">          Header for both (repeatable). Same-origin requests only.
      --baseline-header / --candidate-header <"Name: value">
      --auth <user:pass>                HTTP basic auth for both
      --baseline-auth / --candidate-auth <user:pass>
      --storage <file>                  Playwright storage state (from envdiff login) for both
      --baseline-storage / --candidate-storage <file>
      --baseline-label / --candidate-label <text>
  Secrets can come from the environment instead of argv:
      ENVDIFF_HEADERS, ENVDIFF_BASELINE_HEADERS, ENVDIFF_CANDIDATE_HEADERS  ("Name: value" per line)
      ENVDIFF_AUTH, ENVDIFF_BASELINE_AUTH, ENVDIFF_CANDIDATE_AUTH          ("user:pass")

${color.bold("Scope and noise")}
      --include <regex> / --exclude <regex>   Only / never crawl matching paths (repeatable)
      --mask <selector>        Paint over before screenshots, e.g. .clock (repeatable)
      --ignore-text <regex>    Ignore matching text in comparisons (repeatable)
      --freeze-time <iso>      Freeze Date.now() in both, e.g. 2025-01-01T10:00:00Z
      --no-explore --no-visual --no-text --no-a11y --no-perf

${color.bold("Safety")}
      --allow-mutations        Let the app send POST/PUT/PATCH/DELETE. ${color.red("Only for disposable data.")}
                               By default they are blocked, and destructive-looking
                               controls (delete, pay, log out…) are never clicked.

${color.bold("Runtime")}
      --concurrency <n>        Pages processed in parallel (default 2)
      --browser <name>         chromium | firefox | webkit
      --channel <name>         Use an installed browser: chrome, msedge
      --proxy <url>            Send the browser's traffic through a proxy, e.g. http://proxy.corp:3128
      --headed                 Show the browser
      --timeout <minutes>      Stop after this long and report what was done (default 45)
      --ai                     Claude triage of differences (needs ANTHROPIC_API_KEY;
                               sends screenshots and findings to the Anthropic API)
      --ai-model <id>          Default claude-opus-5-5
      --json                   Print the summary as JSON on stdout
  -v, --verbose / -q, --quiet
      --version, -h, --help

${color.bold("Exit codes")}  0 no findings at or above --fail-on · 1 regressions found · 2 could not run · 130 interrupted
              (Ctrl+C once: finish the pages in progress and write a partial report; twice: quit)

${color.bold("Examples")}
  envdiff https://uat.example.com https://dev.example.com
  envdiff https://www.example.com https://staging.example.com --viewports desktop,mobile --fail-on major
  envdiff main feature/checkout --url-template "https://{branch}--shop.netlify.app"
  envdiff -c envdiff.config.yaml
`;

const OPTIONS = /** @type {const} */ ({
  config: { type: "string", short: "c" },
  out: { type: "string", short: "o" },
  paths: { type: "string", short: "p" },
  "max-pages": { type: "string" },
  depth: { type: "string" },
  actions: { type: "string" },
  "click-depth": { type: "string" },
  viewports: { type: "string" },
  "fail-on": { type: "string" },
  "url-template": { type: "string" },
  header: { type: "string", multiple: true },
  "baseline-header": { type: "string", multiple: true },
  "candidate-header": { type: "string", multiple: true },
  auth: { type: "string" },
  "baseline-auth": { type: "string" },
  "candidate-auth": { type: "string" },
  storage: { type: "string" },
  "baseline-storage": { type: "string" },
  "candidate-storage": { type: "string" },
  "baseline-label": { type: "string" },
  "candidate-label": { type: "string" },
  include: { type: "string", multiple: true },
  exclude: { type: "string", multiple: true },
  mask: { type: "string", multiple: true },
  "ignore-text": { type: "string", multiple: true },
  "freeze-time": { type: "string" },
  "no-explore": { type: "boolean" },
  "no-visual": { type: "boolean" },
  "no-text": { type: "boolean" },
  "no-a11y": { type: "boolean" },
  "no-perf": { type: "boolean" },
  "allow-mutations": { type: "boolean" },
  concurrency: { type: "string" },
  browser: { type: "string" },
  channel: { type: "string" },
  proxy: { type: "string" },
  headed: { type: "boolean" },
  timeout: { type: "string" },
  ai: { type: "boolean" },
  "ai-model": { type: "string" },
  json: { type: "boolean" },
  save: { type: "string" },
  verbose: { type: "boolean", short: "v" },
  quiet: { type: "boolean", short: "q" },
  version: { type: "boolean" },
  help: { type: "boolean", short: "h" },
});

/**
 * "Name: value" lines into a header map.
 * @param {(string | undefined)[]} sources
 */
export function parseHeaders(...sources) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const src of sources) {
    if (!src) continue;
    for (const line of String(src).split(/\r?\n|;;/)) {
      const t = line.trim();
      if (!t) continue;
      const i = t.indexOf(":");
      if (i <= 0) throw new ConfigError(`Header must look like "Name: value", got "${t.replace(/:.*/, ":…")}"`);
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
  return out;
}

/** @param {string | undefined} s */
function parseCredentials(s) {
  if (!s) return undefined;
  const i = s.indexOf(":");
  if (i <= 0) throw new ConfigError(`Credentials must look like user:password`);
  return { username: s.slice(0, i), password: s.slice(i + 1) };
}

/**
 * @param {string | undefined} v
 * @param {string} name
 */
function num(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(`--${name} must be a number`);
  return n;
}

/** Build config overrides from parsed flags and environment variables. */
export function overridesFrom(/** @type {any} */ v, /** @type {string[]} */ positionals, env = process.env) {
  /** @type {any} */
  const o = { baseline: {}, candidate: {}, crawl: {}, explore: {}, report: {}, browser: {}, visual: {}, ignore: {}, ai: {}, timeouts: {} };
  const [b, c] = positionals;
  for (const [side, input] of /** @type {const} */ ([
    ["baseline", b],
    ["candidate", c],
  ])) {
    if (!input) continue;
    const t = classifyTarget(input);
    if (t.kind === "url") o[side].url = t.url;
    else o[side].ref = t.ref;
  }
  const both = parseHeaders(...(v.header ?? []), env.ENVDIFF_HEADERS);
  const hb = { ...both, ...parseHeaders(...(v["baseline-header"] ?? []), env.ENVDIFF_BASELINE_HEADERS) };
  const hc = { ...both, ...parseHeaders(...(v["candidate-header"] ?? []), env.ENVDIFF_CANDIDATE_HEADERS) };
  if (Object.keys(hb).length) o.baseline.headers = hb;
  if (Object.keys(hc).length) o.candidate.headers = hc;
  const ab = parseCredentials(v["baseline-auth"] ?? v.auth ?? env.ENVDIFF_BASELINE_AUTH ?? env.ENVDIFF_AUTH);
  const ac = parseCredentials(v["candidate-auth"] ?? v.auth ?? env.ENVDIFF_CANDIDATE_AUTH ?? env.ENVDIFF_AUTH);
  if (ab) o.baseline.httpCredentials = ab;
  if (ac) o.candidate.httpCredentials = ac;
  if (v["baseline-storage"] ?? v.storage) o.baseline.storageState = v["baseline-storage"] ?? v.storage;
  if (v["candidate-storage"] ?? v.storage) o.candidate.storageState = v["candidate-storage"] ?? v.storage;
  if (v["baseline-label"]) o.baseline.label = v["baseline-label"];
  if (v["candidate-label"]) o.candidate.label = v["candidate-label"];

  if (v.out) o.report.outDir = v.out;
  if (v["fail-on"]) o.report.failOn = v["fail-on"];
  if (v.paths) o.crawl.startPaths = v.paths.split(",").map((/** @type {string} */ s) => s.trim()).filter(Boolean);
  if (v["max-pages"] !== undefined) o.crawl.maxPages = num(v["max-pages"], "max-pages");
  if (v.depth !== undefined) o.crawl.maxDepth = num(v.depth, "depth");
  if (v.include) o.crawl.include = v.include;
  if (v.exclude) o.crawl.exclude = v.exclude;
  if (v.actions !== undefined) o.explore.maxActionsPerPage = num(v.actions, "actions");
  if (v["click-depth"] !== undefined) o.explore.depth = num(v["click-depth"], "click-depth");
  if (v["no-explore"]) o.explore.enabled = false;
  if (v.viewports) o.viewports = v.viewports.split(",").map((/** @type {string} */ s) => s.trim()).filter(Boolean);
  if (v["url-template"]) o.branches = { urlTemplate: v["url-template"] };
  if (v.mask) o.visual.mask = v.mask;
  if (v["freeze-time"]) o.visual.freezeTime = v["freeze-time"];
  if (v["no-visual"]) o.visual.enabled = false;
  if (v["ignore-text"]) o.ignore.text = v["ignore-text"];
  if (v["no-text"]) o.text = { enabled: false };
  if (v["no-a11y"]) o.a11y = { enabled: false };
  if (v["no-perf"]) o.perf = { enabled: false };
  if (v["allow-mutations"]) o.safety = { allowMutations: true };
  if (v.concurrency !== undefined) o.concurrency = num(v.concurrency, "concurrency");
  if (v.browser) o.browser.name = v.browser;
  if (v.channel) o.browser.channel = v.channel;
  if (v.proxy) o.browser.proxy = { server: v.proxy };
  if (v.headed) o.browser.headless = false;
  if (v.timeout !== undefined) o.timeouts.total = /** @type {number} */ (num(v.timeout, "timeout")) * 60_000;
  if (v.ai) o.ai.enabled = true;
  if (v["ai-model"]) o.ai.model = v["ai-model"];
  // Drop empty sections so they don't wipe config-file values.
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) && !Object.keys(o[k]).length) delete o[k];
  return o;
}

/**
 * Merge positional URLs with a config that may hold its own: a config with a
 * baseline.ref must not keep it when the command line gives a URL.
 * @param {any} fileCfg
 * @param {any} overrides
 */
function reconcileTargets(fileCfg, overrides) {
  for (const side of ["baseline", "candidate"]) {
    const o = overrides[side];
    if (!o || !fileCfg[side]) continue;
    if (o.url) delete fileCfg[side].ref;
    if (o.ref) delete fileCfg[side].url;
  }
}

/** @param {string[]} argv */
export async function main(argv) {
  const log = createLogger();
  /** @type {any} */
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    log.error(/** @type {Error} */ (e).message.replace(/\. To specify.*$/, ""));
    log.info("Run envdiff --help for usage.");
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (v.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (v.verbose) log.setLevel("debug");
  if (v.quiet) log.setLevel("warn");

  try {
    if (positionals[0] === "init") return await init(positionals[1], log);
    if (positionals[0] === "login") return await login(positionals[1], v.save, log);
    if (positionals.length > 2) throw new ConfigError(`Expected at most two arguments (baseline, candidate), got ${positionals.length}`);

    const fileCfg = v.config ? await loadConfigFile(v.config) : await autoConfig(log);
    const overrides = overridesFrom(v, positionals);
    reconcileTargets(fileCfg, overrides);
    const cfg = resolveConfig(fileCfg, overrides, { warn: (m) => log.warn(m) });

    // First Ctrl+C (or SIGTERM from a cancelled CI job): finish the pages in
    // flight and write a partial report. Second Ctrl+C: quit now.
    const stop = new AbortController();
    const onSignal = () => {
      if (stop.signal.aborted) process.exit(130);
      log.warn("Stopping after the pages in progress… (Ctrl+C again to quit immediately)");
      stop.abort();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const { report, exitCode } = await run(cfg, { log, signal: stop.signal }).finally(() => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    });
    const out = path.resolve(cfg.report.outDir);
    await publishToGitHub(report, out);

    const { counts } = report.summary;
    log.info("");
    log.info(
      `${report.summary.verdict === "fail" ? color.red(color.bold("FAIL")) : color.green(color.bold("PASS"))}  ` +
        `${color.red(`${counts.critical} critical`)} · ${color.yellow(`${counts.major} major`)} · ${counts.minor} minor · ${color.dim(`${counts.info} info`)}  ` +
        color.dim(`(${report.summary.pages} pages, ${report.summary.interactions} interactions, ${formatDuration(report.meta.durationMs)})`),
    );
    log.info(`Report: ${pathToFileURL(path.join(out, "index.html")).href}`);
    if (v.json) process.stdout.write(JSON.stringify({ ...report.summary, report: path.join(out, "report.json") }) + "\n");
    // An interrupted run is not a pass, whatever it found so far.
    if (stop.signal.aborted) return 130;
    return exitCode;
  } catch (e) {
    const err = /** @type {Error} */ (e);
    log.error(err instanceof ConfigError ? err.message : err.message || String(err));
    if (!(err instanceof ConfigError) && log.verbose && err.stack) log.debug(err.stack);
    return 2;
  }
}

/** Use ./envdiff.config.{yaml,yml,json,mjs,js} when present. */
async function autoConfig(/** @type {import("./util/log.js").Logger} */ log) {
  for (const name of ["envdiff.config.yaml", "envdiff.config.yml", "envdiff.config.json", "envdiff.config.mjs", "envdiff.config.js"]) {
    if (fs.existsSync(name)) {
      log.info(color.dim(`Using ${name}`));
      return loadConfigFile(name);
    }
  }
  return {};
}

/**
 * In GitHub Actions: append the summary to the job page and expose outputs.
 * @param {any} report
 * @param {string} outDir
 */
async function publishToGitHub(report, outDir) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile && process.env.ENVDIFF_STEP_SUMMARY !== "0") {
    const runUrl =
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined;
    await fsp.appendFile(summaryFile, renderMarkdown(report, { reportUrl: runUrl ? `${runUrl}#artifacts` : undefined }) + "\n").catch(() => {});
  }
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const { counts, verdict } = report.summary;
    const lines = [`verdict=${verdict}`, `critical=${counts.critical}`, `major=${counts.major}`, `minor=${counts.minor}`, `info=${counts.info}`, `report-dir=${outDir}`];
    await fsp.appendFile(outputFile, lines.join("\n") + "\n").catch(() => {});
  }
}

/**
 * @param {string | undefined} file
 * @param {import("./util/log.js").Logger} log
 */
async function init(file, log) {
  const target = file ?? "envdiff.config.yaml";
  if (fs.existsSync(target)) {
    log.error(`${target} already exists`);
    return 2;
  }
  await fsp.copyFile(path.join(here, "..", "examples", "envdiff.config.yaml"), target);
  log.info(`Wrote ${target}. Edit it, then run: envdiff -c ${target}`);
  return 0;
}

/**
 * Open a visible browser, let a person log in (SSO, MFA, captcha), save the session.
 * @param {string | undefined} url
 * @param {string | undefined} save
 * @param {import("./util/log.js").Logger} log
 */
async function login(url, save, log) {
  if (!url) throw new ConfigError("Usage: envdiff login <url> [--save auth.json]");
  const target = classifyTarget(url);
  if (target.kind !== "url") throw new ConfigError(`"${url}" is not a URL`);
  const file = save ?? "auth.json";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(target.url);
  log.info(`Log in in the browser window, then press Enter here to save the session to ${file}…`);
  await new Promise((resolve) => process.stdin.once("data", resolve));
  await context.storageState({ path: file });
  await browser.close();
  log.info(`Saved. Use it with --storage ${file} (or --baseline-storage / --candidate-storage).`);
  log.warn(`${file} holds live session cookies: keep it out of git.`);
  process.stdin.pause();
  return 0;
}
