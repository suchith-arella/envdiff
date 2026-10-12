import fs from "node:fs/promises";
import path from "node:path";
import { installGuard } from "./instrument.js";
import { initScript } from "./inpage/collect.js";
import { runStep, describeStep, stepError } from "./steps.js";

/**
 * One environment in one viewport: a browser context plus everything needed
 * to load pages in it.
 * @typedef {object} EnvSession
 * @property {"baseline"|"candidate"} side
 * @property {string} label
 * @property {import("playwright").BrowserContext} context
 * @property {import("./instrument.js").GuardState} guard
 * @property {import("./urls.js").Scope} scope
 * @property {string[]} tokens Hostname labels that identify this environment.
 * @property {import("./config.js").Config} cfg
 * @property {import("./config.js").ViewportConfig} viewport
 */

/**
 * @param {import("./config.js").Config} cfg
 * @returns {Promise<import("playwright").Browser>}
 */
export async function launchBrowser(cfg) {
  const pw = await import("playwright");
  const type = pw[/** @type {"chromium"|"firefox"|"webkit"} */ (cfg.browser.name)];
  try {
    return await type.launch({
      headless: cfg.browser.headless,
      channel: cfg.browser.channel ?? undefined,
      executablePath: cfg.browser.executablePath ?? process.env.ENVDIFF_BROWSER_PATH ?? undefined,
      args: cfg.browser.args,
      proxy: cfg.browser.proxy ?? undefined,
      // envdiff handles Ctrl+C itself (finish in-flight pages, write a partial
      // report); Playwright still kills the browser if the process exits.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (e) {
    const msg = /** @type {Error} */ (e).message;
    if (/Executable doesn't exist|browserType\.launch: .*install/i.test(msg)) {
      throw new Error(
        `The ${cfg.browser.name} browser is not installed. Run:\n  npx playwright install --with-deps ${cfg.browser.name}\n` +
          `or use an installed browser with --channel chrome`,
      );
    }
    throw e;
  }
}

/**
 * Create a session for one environment and viewport.
 * @param {import("playwright").Browser} browser
 * @param {object} opts
 * @param {"baseline"|"candidate"} opts.side
 * @param {string} opts.label
 * @param {import("./config.js").Config} opts.cfg
 * @param {import("./config.js").ViewportConfig} opts.viewport
 * @param {import("./urls.js").Scope} opts.scope
 * @param {string[]} opts.tokens
 * @param {any} [opts.storageState] Logged-in state to start from.
 * @returns {Promise<EnvSession>}
 */
export async function createSession(browser, { side, label, cfg, viewport, scope, tokens, storageState }) {
  /** @type {import("./config.js").EnvConfig} */
  const env = cfg[side];
  const firefox = cfg.browser.name === "firefox";
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    isMobile: firefox ? undefined : viewport.isMobile,
    hasTouch: viewport.hasTouch,
    userAgent: viewport.userAgent ?? cfg.browser.userAgent ?? undefined,
    locale: cfg.browser.locale,
    timezoneId: cfg.browser.timezoneId,
    colorScheme: /** @type {"light"|"dark"|"no-preference"} */ (cfg.browser.colorScheme),
    reducedMotion: "reduce",
    ignoreHTTPSErrors: cfg.browser.ignoreHTTPSErrors,
    httpCredentials: env.httpCredentials ? { ...env.httpCredentials, origin: scope.origin } : undefined,
    storageState: storageState ?? env.storageState ?? undefined,
    // Requests from service workers bypass routing, which would let them
    // around the mutation guard.
    serviceWorkers: "block",
    acceptDownloads: true,
  });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(cfg.timeouts.navigation);
  if (env.cookies?.length) {
    await context.addCookies(
      env.cookies.map((c) => ({ path: "/", ...c, ...(c.domain ? {} : { url: scope.origin }) })),
    );
  }
  await context.addInitScript(initScript, { ignoreMutations: cfg.stabilize.ignoreMutations });
  if (cfg.visual.freezeTime) await context.clock.setFixedTime(new Date(cfg.visual.freezeTime));
  const guard = await installGuard(context, cfg, {
    origin: scope.origin,
    headers: env.headers,
    headerHosts: env.headerHosts,
  });
  return { side, label, context, guard, scope, tokens, cfg, viewport };
}

/**
 * Log in using the configured steps. Mutations are allowed for the duration —
 * a login form is a POST.
 * @param {EnvSession} session
 * @param {import("./config.js").AuthConfig} auth
 * @param {{ outDir: string, log: import("./util/log.js").Logger }} ctx
 */
export async function authenticate(session, auth, { outDir, log }) {
  const page = await session.context.newPage();
  session.guard.allowAll = true;
  let current = "open login page";
  try {
    const start = auth.loginUrl ? session.scope.urlFor(auth.loginUrl) : session.scope.baseUrl;
    await page.goto(start, { waitUntil: "load", timeout: session.cfg.timeouts.navigation });
    for (const step of auth.steps ?? []) {
      current = describeStep(step);
      log.debug(`  [${session.side}] login: ${current}`);
      await runStep(page, step, { scope: session.scope, timeout: 15000 });
    }
    current = "confirm login succeeded";
    if (auth.successUrl) await page.waitForURL(auth.successUrl, { timeout: 20000 });
    if (auth.successSelector) await page.locator(auth.successSelector).first().waitFor({ state: "visible", timeout: 20000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    return await session.context.storageState();
  } catch (e) {
    const shot = path.join(outDir, `login-failed-${session.side}.png`);
    await fs.mkdir(outDir, { recursive: true }).catch(() => {});
    await page.screenshot({ path: shot }).catch(() => {});
    throw new Error(`Login failed on ${session.label} at "${current}": ${stepError(e)} (screenshot: ${shot})`);
  } finally {
    session.guard.allowAll = false;
    await page.close().catch(() => {});
  }
}
