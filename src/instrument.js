import { normalizeRequestUrl, siteOf, isOpaqueUrl, THIRD_PARTY_NOISE } from "./urls.js";
import { shapeOf, bodyShape } from "./shape.js";
import { compilePatterns, matchesAny, normalizeMessage, withTimeout } from "./util/misc.js";

/**
 * Context-wide state shared between the mutation guard and page listeners.
 * @typedef {object} GuardState
 * @property {boolean} allowAll Temporarily let everything through (login, journeys that opt in).
 * @property {WeakSet<import("playwright").Request>} blocked
 * @property {WeakMap<import("playwright").Request, string[]>} bodies
 */

/**
 * Block state-changing requests unless explicitly allowed. Blocked requests are
 * remembered (with the shape of their body) so a click that *would have* sent
 * POST /api/cart {sku, qty} can still be compared across environments.
 *
 * Enabling routing turns off the browser HTTP cache. That costs some speed but
 * applies to both environments equally, so comparisons stay fair.
 *
 * The same route handler adds the environment's custom headers — but only to
 * requests for that environment's own origin (and any `headerHosts`). Context-
 * wide extraHTTPHeaders would send a bypass token or Authorization header to
 * every analytics and CDN host the page touches.
 *
 * @param {import("playwright").BrowserContext} context
 * @param {import("./config.js").Config} cfg
 * @param {{ origin: string, headers?: Record<string,string>, headerHosts?: string[] }} env
 * @returns {Promise<GuardState>}
 */
export async function installGuard(context, cfg, env) {
  /** @type {GuardState} */
  const state = { allowAll: false, blocked: new WeakSet(), bodies: new WeakMap() };
  const headers = env.headers ?? {};
  const hasHeaders = Object.keys(headers).length > 0;
  if (cfg.safety.allowMutations && !hasHeaders) return state;
  const allow = compilePatterns(cfg.safety.allowRequests);
  const headerHosts = compilePatterns(env.headerHosts);
  await context.route("**/*", async (route, request) => {
    const url = request.url();
    /** @type {Record<string,string> | undefined} */
    let override;
    if (hasHeaders && (url.startsWith(env.origin + "/") || url === env.origin || (headerHosts.length && matchesAny(headerHosts, hostOf(url))))) {
      override = { ...request.headers(), ...headers };
    }
    const proceed = () => route.continue(override ? { headers: override } : undefined);
    const method = request.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || state.allowAll || cfg.safety.allowMutations) return proceed();
    if (matchesAny(allow, url)) return proceed();
    let body = null;
    try {
      body = request.postData();
    } catch {
      // binary body
    }
    if (cfg.safety.graphql && body && isGraphQLRead(body)) return proceed();
    state.blocked.add(request);
    state.bodies.set(request, bodyShape(body, request.headers()["content-type"]));
    return route.abort("blockedbyclient");
  });
  return state;
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const WRITE_OPERATION =
  /^(create|update|delete|remove|add|set|submit|place|cancel|save|upsert|insert|edit|change|reset|send|post|put|patch|mark|toggle|archive|restore|publish|unpublish|approve|reject|assign|unassign|invite|join|leave|follow|unfollow|like|unlike|vote|subscribe|unsubscribe|register|signup|signin|signout|login|logout|checkout|pay|purchase|order|book|reserve|upload|import|generate|sync|revoke|grant|enable|disable|activate|deactivate|move|copy|duplicate|merge|attach|detach|connect|disconnect|apply|confirm|complete|transfer|withdraw|refund)/i;

/**
 * GraphQL sends reads over POST too; blocking them would break the app. Only
 * operations that are (or are named like) mutations are blocked.
 * @param {string} body
 */
export function isGraphQLRead(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }
  const ops = Array.isArray(payload) ? payload : [payload];
  if (!ops.length) return false;
  const looksGraphQL = (/** @type {any} */ o) =>
    o && typeof o === "object" && (typeof o.query === "string" || typeof o.operationName === "string" || o.extensions?.persistedQuery);
  if (!ops.every(looksGraphQL)) return false;
  return ops.every((o) => {
    if (typeof o.query === "string") {
      const doc = o.query.replace(/#[^\n]*/g, " ");
      return !/(^|[\s}])mutation\b/.test(doc);
    }
    // Persisted query without its text: judge by the operation name.
    return !(typeof o.operationName === "string" && WRITE_OPERATION.test(o.operationName));
  });
}

/**
 * @typedef {object} RequestRecord
 * @property {string} method
 * @property {string} url
 * @property {string} key Normalized "METHOD url" for cross-environment comparison.
 * @property {string} type Resource type: document, script, xhr, fetch, image...
 * @property {number|null} status
 * @property {string|null} failure
 * @property {boolean} blocked
 * @property {string[]} [body] Shape of a blocked request's body.
 * @property {boolean} noise Third-party analytics/ads, or matched ignore.requests.
 * @property {boolean} sameOrigin
 * @property {boolean} firstParty Same site as the app (its own API hosts included).
 */

/**
 * @typedef {object} PageLog
 * @property {{ type: string, text: string, norm: string }[]} console
 * @property {{ message: string, norm: string }[]} errors
 * @property {RequestRecord[]} requests
 * @property {{ type: string, message: string }[]} dialogs
 * @property {string[]} popups
 * @property {string[]} downloads
 * @property {string[]} navigations
 * @property {{ key: string, status: number, shape: any }[]} api
 */

/**
 * Listen to everything a page does. `mark()` / `since()` slice the log around
 * a single action.
 * @param {import("playwright").Page} page
 * @param {object} env
 * @param {import("./urls.js").Scope} env.scope
 * @param {string[]} env.tokens
 * @param {GuardState} env.guard
 * @param {import("./config.js").Config} env.cfg
 */
export function instrumentPage(page, { scope, tokens, guard, cfg }) {
  /** @type {PageLog} */
  const log = { console: [], errors: [], requests: [], dialogs: [], popups: [], downloads: [], navigations: [], api: [] };
  const ignoreRequests = compilePatterns(cfg.ignore.requests);
  const ignoreConsole = compilePatterns(cfg.ignore.console);
  /** @type {Map<import("playwright").Request, { start: number, record: RequestRecord }>} */
  const inflight = new Map();
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set();
  let lastActivity = Date.now();
  let lastNavigation = 0;
  const ownSite = siteOf(scope.hostname);
  /** Analytics, ads, bot protection: requests that say nothing about the app. */
  const isNoise = (/** @type {string} */ url) => THIRD_PARTY_NOISE.test(url) || isOpaqueUrl(url) || matchesAny(ignoreRequests, url);
  const isFirstParty = (/** @type {string} */ url) => {
    try {
      const u = new URL(url);
      if (u.origin === scope.origin) return true;
      const host = u.hostname.toLowerCase();
      return siteOf(host) === ownSite || host.split(/[.-]/).some((label) => tokens.includes(label));
    } catch {
      return false;
    }
  };

  /** "METHOD url", plus the operation name for GraphQL so each operation is its own endpoint. */
  const requestKey = (/** @type {import("playwright").Request} */ request) => {
    const method = request.method();
    let key = `${method} ${normalizeRequestUrl(request.url(), scope, tokens)}`;
    if (method === "POST") {
      try {
        const op = JSON.parse(request.postData() ?? "")?.operationName;
        if (typeof op === "string" && op) key += `#${op}`;
      } catch {
        // not JSON
      }
    }
    return key;
  };

  const track = (/** @type {Promise<unknown>} */ p) => {
    pending.add(p);
    p.finally(() => pending.delete(p)).catch(() => {});
  };

  page.on("console", (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning" && type !== "assert") return;
    const text = msg.text();
    if (matchesAny(ignoreConsole, text)) return;
    // "Failed to load resource" duplicates what the network log already says.
    if (/^Failed to load resource/i.test(text)) return;
    log.console.push({ type, text: text.slice(0, 1000), norm: normalizeMessage(text) });
  });
  page.on("pageerror", (err) => {
    const message = `${err.name && !String(err.message).startsWith(err.name) ? err.name + ": " : ""}${err.message}`;
    if (matchesAny(ignoreConsole, message)) return;
    log.errors.push({ message: message.slice(0, 1000), norm: normalizeMessage(message) });
  });

  page.on("request", (request) => {
    lastActivity = Date.now();
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const method = request.method();
    /** @type {RequestRecord} */
    const record = {
      method,
      url,
      key: requestKey(request),
      type: request.resourceType(),
      status: null,
      failure: null,
      blocked: false,
      noise: isNoise(url),
      sameOrigin: safeOrigin(url) === scope.origin,
      firstParty: isFirstParty(url),
    };
    log.requests.push(record);
    inflight.set(request, { start: Date.now(), record });
  });
  page.on("requestfinished", (request) => {
    lastActivity = Date.now();
    const entry = inflight.get(request);
    inflight.delete(request);
    if (!entry) return;
    track(
      request
        .response()
        .then((res) => {
          entry.record.status = res ? res.status() : null;
        })
        .catch(() => {}),
    );
  });
  page.on("requestfailed", (request) => {
    lastActivity = Date.now();
    const entry = inflight.get(request);
    inflight.delete(request);
    if (!entry) return;
    if (guard.blocked.has(request)) {
      entry.record.blocked = true;
      entry.record.body = guard.bodies.get(request) ?? [];
    } else {
      const failure = request.failure()?.errorText ?? "failed";
      // Navigations we triggered ourselves abort in-flight requests; not the app's fault.
      if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure)) entry.record.failure = "aborted";
      else entry.record.failure = failure;
    }
  });

  if (cfg.api.enabled) {
    page.on("response", (res) => {
      const req = res.request();
      const type = req.resourceType();
      if (type !== "xhr" && type !== "fetch") return;
      const ct = res.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      const url = req.url();
      if (isNoise(url)) return;
      const len = Number(res.headers()["content-length"] || 0);
      if (len > cfg.api.maxBodyBytes) return;
      track(
        res
          .body()
          .then((buf) => {
            if (buf.length > cfg.api.maxBodyBytes) return;
            const json = JSON.parse(buf.toString("utf8"));
            log.api.push({
              key: requestKey(req),
              status: res.status(),
              shape: shapeOf(json),
            });
          })
          .catch(() => {}),
      );
    });
  }

  page.on("dialog", (dialog) => {
    log.dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 300) });
    // Dismiss = "Cancel" on confirm(), the safe answer. beforeunload must be
    // accepted or our own navigations would be blocked.
    const answer = dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss();
    answer.catch(() => {});
  });
  page.on("popup", (popup) => {
    track(
      (async () => {
        await popup.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
        let url = popup.url();
        if (url === "about:blank") {
          await popup.waitForURL((u) => u.href !== "about:blank", { timeout: 3000 }).catch(() => {});
          url = popup.url();
        }
        log.popups.push(url);
        await popup.close().catch(() => {});
      })(),
    );
  });
  page.on("download", (download) => {
    log.downloads.push(download.suggestedFilename());
    download.cancel().catch(() => {});
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    // Includes same-document navigations (pushState, replaceState, hash
    // changes): a client-side router running again re-renders the page.
    lastNavigation = Date.now();
    log.navigations.push(frame.url());
  });

  return {
    log,
    /** Positions in each log, to slice out what one action caused. */
    mark() {
      return /** @type {Record<keyof PageLog, number>} */ (
        Object.fromEntries(Object.entries(log).map(([k, v]) => [k, v.length]))
      );
    },
    /**
     * @param {Record<keyof PageLog, number>} m
     * @returns {PageLog}
     */
    since(m) {
      return /** @type {PageLog} */ (Object.fromEntries(Object.entries(log).map(([k, v]) => [k, v.slice(m[/** @type {keyof PageLog} */ (k)])])));
    },
    /**
     * Quiet = nothing new for `quietMs`, ignoring requests open longer than
     * `longPollMs` (long-polling, streaming, analytics keep-alives).
     */
    networkQuiet(quietMs = 400, longPollMs = 5000) {
      const now = Date.now();
      for (const { start } of inflight.values()) if (now - start < longPollMs) return false;
      return now - lastActivity >= quietMs;
    },
    /** No navigation, full or client-side, for `quietMs`. */
    navigationQuiet(quietMs = 400) {
      return Date.now() - lastNavigation >= quietMs;
    },
    /** Wait for async listeners (response bodies, popups) to finish. */
    async flush(ms = 3000) {
      if (pending.size) await withTimeout(Promise.allSettled([...pending]), ms, "flush").catch(() => {});
    },
  };
}

/** @typedef {ReturnType<typeof instrumentPage>} Instrumented */

/** @param {string} url */
function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
