import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { ConfigError } from "./config.js";
import { slugify, sleep } from "./util/misc.js";

/**
 * @typedef {object} Target
 * @property {"baseline"|"candidate"} side
 * @property {string} url
 * @property {string} label
 * @property {string} [ref]
 * @property {string} [sha]
 */

/**
 * Is this input a URL, a named environment or a branch? An explicit `url:`,
 * `env:` or `branch:` prefix always wins. Bare hosts (uat.example.com,
 * localhost:3000) are URLs; names in `environments` (dev, uat, prod) are
 * environments; anything else is a branch.
 * @param {string} input
 * @param {Set<string>} [environments] Known environment names, lower-case.
 * @returns {{ kind: "url", url: string } | { kind: "branch", ref: string } | { kind: "env", name: string }}
 */
export function classifyTarget(input, environments = new Set()) {
  const s = String(input ?? "").trim();
  if (!s) throw new ConfigError("Empty baseline/candidate");
  const prefixed = /^(url|branch|ref|env):(.+)$/i.exec(s);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase();
    if (kind === "env") return { kind: "env", name: prefixed[2].trim() };
    return kind === "url" ? { kind: "url", url: withScheme(prefixed[2].trim()) } : { kind: "branch", ref: prefixed[2].trim() };
  }
  if (environments.has(s.toLowerCase())) return { kind: "env", name: s };
  if (/^https?:\/\//i.test(s)) return { kind: "url", url: s };
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(s)) return { kind: "url", url: `http://${s}` };
  // host.tld[:port][/path] with an alphabetic TLD — v1.2.3 and release-1.2 stay branches.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s) && !s.includes(" ")) {
    return { kind: "url", url: `https://${s}` };
  }
  return { kind: "branch", ref: s };
}

/** @param {string} s */
function withScheme(s) {
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/**
 * The slug most preview hosts use for branch names: feature/Login_Page -> feature-login-page.
 * @param {string} ref
 */
export function branchSlug(ref) {
  return ref
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

/**
 * @param {string} template e.g. https://{branch}--mysite.netlify.app
 * @param {string} ref
 */
export function applyUrlTemplate(template, ref) {
  if (!/\{branch(_raw)?\}/.test(template)) {
    throw new ConfigError(`URL template "${template}" has no {branch} placeholder`);
  }
  return template.replace(/\{branch_raw\}/g, encodeURIComponent(ref)).replace(/\{branch\}/g, branchSlug(ref));
}

/**
 * Turn the configured baseline/candidate into loadable URLs, starting local
 * servers for branches when configured to. The returned `stop` must be called.
 * @param {import("./config.js").Config} cfg
 * @param {{ log: import("./util/log.js").Logger, outDir: string }} ctx
 */
export async function resolveTargets(cfg, { log, outDir }) {
  /** @type {(() => Promise<void>)[]} */
  const stoppers = [];
  const stop = async () => {
    await Promise.all(stoppers.splice(0).map((s) => s().catch(() => {})));
  };

  /** @param {"baseline"|"candidate"} side */
  const describe = (side) => {
    const env = cfg[side];
    if (env.url && env.ref) throw new ConfigError(`${side}: set either url or ref, not both`);
    if (env.url) return /** @type {const} */ ({ kind: "url", url: withScheme(env.url) });
    if (env.ref) return /** @type {const} */ ({ kind: "branch", ref: env.ref });
    throw new ConfigError(`No ${side} given. Pass it as an argument or set ${side}.url in the config.`);
  };

  const sides = /** @type {const} */ (["baseline", "candidate"]);
  const specs = sides.map(describe);
  /** @type {Target[]} */
  const targets = [];
  try {
    for (const [i, side] of sides.entries()) {
      const spec = specs[i];
      const label = cfg[side].label;
      if (spec.kind === "url") {
        targets.push({ side, url: new URL(spec.url).href, label: label || new URL(spec.url).host });
        continue;
      }
      if (cfg.branches.urlTemplate) {
        const url = applyUrlTemplate(cfg.branches.urlTemplate, spec.ref);
        log.info(`${side}: branch ${spec.ref} -> ${url}`);
        targets.push({ side, url, label: label || spec.ref, ref: spec.ref });
        continue;
      }
      if (cfg.branches.serve) {
        const serve = cfg.branches.serve;
        const port = (serve.port ?? 4100) + i;
        log.info(`${side}: building and serving branch ${spec.ref} on port ${port}…`);
        const served = await serveBranch({
          ref: spec.ref,
          port,
          serve,
          log,
          logFile: path.join(outDir, `serve-${side}.log`),
        });
        stoppers.push(served.stop);
        targets.push({ side, url: served.url, label: label || spec.ref, ref: spec.ref, sha: served.sha });
        continue;
      }
      throw new ConfigError(
        `"${spec.ref}" looks like a branch name, but there is no way to load a branch.\n` +
          `  Either pass a URL template:  --url-template "https://{branch}.preview.example.com"\n` +
          `  or configure branches.serve to build and serve it locally (see docs/configuration.md).\n` +
          `  If it is an environment, give its address: ENVDIFF_${spec.ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_URL=https://…\n` +
          `  If it is actually a host, prefix it: url:${spec.ref}`,
      );
    }
  } catch (e) {
    await stop();
    throw e;
  }
  return { baseline: targets[0], candidate: targets[1], stop };
}

/**
 * Check out `ref` into a temporary git worktree, install, build, start it on
 * `port`, and wait until it answers.
 * @param {object} opts
 * @param {string} opts.ref
 * @param {number} opts.port
 * @param {import("./config.js").ServeConfig} opts.serve
 * @param {import("./util/log.js").Logger} opts.log
 * @param {string} opts.logFile
 */
export async function serveBranch({ ref, port, serve, log, logFile }) {
  const repoRoot = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: path.resolve(serve.repo ?? ".") }).catch(() => {
    throw new ConfigError(`branches.serve needs a git repository: ${path.resolve(serve.repo ?? ".")} is not one (set branches.serve.repo)`);
  })).trim();
  const sha = await resolveRef(ref, repoRoot, log);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `envdiff-${slugify(ref, 30)}-`));
  await run("git", ["worktree", "add", "--detach", dir, sha], { cwd: repoRoot });
  log.debug(`  worktree ${dir} @ ${sha.slice(0, 10)}`);

  let child = /** @type {import("node:child_process").ChildProcess | null} */ (null);
  const stop = async () => {
    if (child) await stopTree(child);
    await run("git", ["worktree", "remove", "--force", dir], { cwd: repoRoot }).catch(() => {});
  };

  try {
    await fsp.mkdir(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, "a");
    const cwd = path.join(dir, serve.cwd ?? ".");
    const env = {
      ...process.env,
      ...(serve.env ?? {}),
      [serve.portEnv ?? "PORT"]: String(port),
      ENVDIFF_REF: ref,
    };
    for (const [step, cmd] of /** @type {[string, string|undefined][]} */ ([
      ["install", serve.install],
      ["build", serve.build],
    ])) {
      if (!cmd) continue;
      log.info(`  ${step}: ${cmd}`);
      fs.writeSync(out, `\n$ ${cmd}\n`);
      const code = await new Promise((resolve) => {
        const p = spawn(cmd, { shell: true, cwd, env, stdio: ["ignore", out, out] });
        p.on("exit", resolve);
        p.on("error", () => resolve(-1));
      });
      if (code !== 0) throw new Error(`${step} for ${ref} failed (exit ${code}). See ${logFile}`);
    }
    log.info(`  start: ${serve.start}`);
    fs.writeSync(out, `\n$ ${serve.start}\n`);
    child = spawn(serve.start, {
      shell: true,
      cwd,
      env,
      stdio: ["ignore", out, out],
      // Own process group, so stopping it also stops whatever the shell started.
      detached: process.platform !== "win32",
    });
    const readyUrl = `http://localhost:${port}${serve.readyPath ?? "/"}`;
    await waitForHttp(readyUrl, (serve.readyTimeout ?? 180) * 1000, child, logFile);
    return { url: `http://localhost:${port}/`, sha, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

/**
 * @param {string} ref
 * @param {string} cwd
 * @param {import("./util/log.js").Logger} log
 */
async function resolveRef(ref, cwd, log) {
  for (const candidate of [ref, `origin/${ref}`]) {
    try {
      return (await run("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { cwd })).trim();
    } catch {
      // try the next form
    }
  }
  log.info(`  fetching ${ref} from origin…`);
  try {
    await run("git", ["fetch", "--depth=1", "origin", ref], { cwd });
    return (await run("git", ["rev-parse", "FETCH_HEAD^{commit}"], { cwd })).trim();
  } catch {
    throw new ConfigError(`Cannot find branch or commit "${ref}" locally or on origin`);
  }
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @param {import("node:child_process").ChildProcess} child
 * @param {string} logFile
 */
async function waitForHttp(url, timeoutMs, child, logFile) {
  const deadline = Date.now() + timeoutMs;
  let exited = /** @type {number|null} */ (null);
  child.once("exit", (code) => (exited = code ?? -1));
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`Server exited (code ${exited}) before ${url} was ready. See ${logFile}`);
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`${url} was not ready after ${Math.round(timeoutMs / 1000)}s. See ${logFile}`);
}

/**
 * Stop a server and everything its shell started, waiting for it to exit
 * (SIGTERM, then SIGKILL after 5s) so the port is free when we return.
 * @param {import("node:child_process").ChildProcess} child
 */
async function stopTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const signal = (/** @type {NodeJS.Signals} */ sig) => {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else process.kill(-(/** @type {number} */ (child.pid)), sig);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!done) {
    signal("SIGKILL");
    await Promise.race([exited, sleep(2000)]);
  }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string }} opts
 * @returns {Promise<string>}
 */
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}
