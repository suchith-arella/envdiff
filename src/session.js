import fs from "node:fs/promises";
import path from "node:path";
import { installGuard } from "./instrument.js";
import { initScript } from "./inpage/collect.js";
import { runStep, describeStep, stepError } from "./steps.js";
import { autoLogin, afterLogin, totp } from "./login.js";

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
 * @param {AuthState} [opts.authState] Logged-in state to start from.
 * @returns {Promise<EnvSession>}
 */
export async function createSession(browser, { side, label, cfg, viewport, scope, tokens, authState }) {
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
    storageState: authState?.storageState ?? env.storageState ?? undefined,
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
  if (authState?.sessionStorage?.entries.length) await context.addInitScript(restoreSessionStorage, authState.sessionStorage);
  if (cfg.visual.freezeTime) await context.clock.setFixedTime(new Date(cfg.visual.freezeTime));
  const guard = await installGuard(context, cfg, {
    origin: scope.origin,
    headers: env.headers,
    headerHosts: env.headerHosts,
  });
  return { side, label, context, guard, scope, tokens, cfg, viewport };
}

/**
 * What a login leaves behind, to start other sessions from: cookies,
 * localStorage and IndexedDB (Playwright's storage state), plus
 * sessionStorage, which some apps keep their token in and which every new
 * tab would otherwise start without.
 * @typedef {object} AuthState
 * @property {any} storageState
 * @property {{ origin: string, entries: [string, string][], version: number }} sessionStorage
 * @property {string} landedUrl Where the app went after logging in.
 * @property {string | null} formUrl Where the login form was, when it was found automatically.
 */

/**
 * Runs in every new document of a logged-in context: put back the
 * sessionStorage the login left. Once per tab and login: after that the app's
 * own changes stand, until a newer login (one script per login, all of which
 * run, oldest first) brings its own.
 * @param {{ origin: string, entries: [string, string][], version: number }} saved
 */
function restoreSessionStorage(saved) {
  try {
    if (location.origin !== saved.origin) return;
    const MARK = "__envdiff_login";
    if (Number(sessionStorage.getItem(MARK) || 0) >= saved.version) return;
    for (const [k, v] of saved.entries) sessionStorage.setItem(k, v);
    sessionStorage.setItem(MARK, String(saved.version));
  } catch {
    // storage disabled
  }
}

/**
 * Replace {{username}}, {{password}} and {{totp}} in a scripted login step.
 * @param {any} value
 * @param {import("./config.js").AuthConfig} auth
 * @returns {any}
 */
function withCredentials(value, auth) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*(username|password|totp)\s*\}\}/g, (m, k) => {
      if (k === "totp") {
        if (!auth.totp) throw new Error("a login step uses {{totp}} but no authenticator secret is set (…_TOTP)");
        return totp(auth.totp);
      }
      const v = k === "username" ? auth.username : auth.password;
      if (v === undefined || v === "") throw new Error(`a login step uses {{${k}}} but no ${k} is set`);
      return String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => withCredentials(v, auth));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withCredentials(v, auth)]));
  return value;
}

/**
 * Log in: with the configured steps when there are some, otherwise by
 * finding and filling the login form. Mutations are allowed for the
 * duration; a login form is a POST.
 * @param {EnvSession} session
 * @param {import("./config.js").AuthConfig} auth
 * @param {{ outDir: string, log: import("./util/log.js").Logger, totpHint?: string }} ctx
 * @returns {Promise<AuthState>}
 */
export async function authenticate(session, auth, { outDir, log, totpHint }) {
  const page = await session.context.newPage();
  session.guard.allowAll = true;
  let current = "open the login page";
  /** @type {string | null} */
  let formUrl = null;
  try {
    const start = auth.loginUrl ? session.scope.urlFor(auth.loginUrl) : session.scope.baseUrl;
    await page.goto(start, { waitUntil: "load", timeout: session.cfg.timeouts.navigation });
    if (auth.steps?.length) {
      for (const step of auth.steps) {
        // Described before the credentials go in, so they never reach a log.
        current = describeStep(step);
        log.debug(`  [${session.side}] login: ${current}`);
        await runStep(page, withCredentials(step, auth), { scope: session.scope, timeout: 15000 });
      }
    } else {
      const r = await autoLogin(page, {
        username: String(auth.username ?? ""),
        password: String(auth.password ?? ""),
        totp: auth.totp,
        totpHint,
        selectors: { usernameSelector: auth.usernameSelector, passwordSelector: auth.passwordSelector, submitSelector: auth.submitSelector },
        onStage: (s) => {
          current = s;
          log.debug(`  [${session.side}] login: ${s}`);
        },
      });
      formUrl = r.formUrl;
    }
    current = "confirm the login succeeded";
    if (auth.successUrl) await page.waitForURL(auth.successUrl, { timeout: 20000 });
    if (auth.successSelector) await page.locator(auth.successSelector).first().waitFor({ state: "visible", timeout: 20000 });
    await afterLogin(page, 8000);
    const landedUrl = page.url();
    /** @type {[string, string][]} */
    const entries = await page.evaluate(() => Object.entries(sessionStorage).filter(([k]) => k !== "__envdiff_login")).catch(() => []);
    const saved = { origin: new URL(landedUrl).origin, entries, version: Date.now() };
    // This context's other tabs need it too.
    if (entries.length) await session.context.addInitScript(restoreSessionStorage, saved);
    return { storageState: await session.context.storageState({ indexedDB: true }), sessionStorage: saved, landedUrl, formUrl };
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
