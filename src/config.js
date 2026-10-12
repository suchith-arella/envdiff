import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

/** Ordered from most to least severe. */
export const SEVERITIES = /** @type {const} */ (["critical", "major", "minor", "info"]);
/** @typedef {typeof SEVERITIES[number]} Severity */

/** Built-in viewports. Anything else can be given as `WIDTHxHEIGHT`. */
export const VIEWPORT_PRESETS = {
  desktop: { name: "desktop", width: 1366, height: 900 },
  laptop: { name: "laptop", width: 1280, height: 800 },
  tablet: { name: "tablet", width: 820, height: 1180, isMobile: true, hasTouch: true },
  mobile: { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true },
};

/**
 * Controls that are never clicked unless explicitly allowed. The mutation guard
 * (safety.allowMutations=false) already stops POST/PUT/PATCH/DELETE; this list
 * is the second layer, for apps that change state over GET or WebSockets — and
 * logging out mid-run would quietly invalidate everything after it.
 */
export const DEFAULT_DENY_TEXT = [
  "\\blog ?(out|off)\\b",
  "\\bsign ?(out|off)\\b",
  "\\bdelete\\b",
  "\\bremove (account|user|member|all)\\b",
  "\\bdestroy\\b",
  "\\berase\\b",
  "\\bpurge\\b",
  "\\bwipe\\b",
  "\\bdeactivate\\b",
  "\\bclose (my )?account\\b",
  "\\bterminate\\b",
  "\\bunsubscribe\\b",
  "\\bcancel (my )?(subscription|order|plan|membership|account|booking|reservation)\\b",
  "\\bpay( now)?\\b",
  "\\bpurchase\\b",
  "\\bbuy now\\b",
  "\\bplace (your )?order\\b",
  "\\b(confirm|submit|complete) (order|payment|purchase)\\b",
  "\\btransfer (funds|money)\\b",
  "\\bwithdraw\\b",
  "\\brefund\\b",
  "\\breset (password|account|data|all|everything)\\b",
  "\\brevoke\\b",
  "\\bban\\b",
];

/** Paths that are never visited or clicked: a GET to these ends the session. */
export const DEFAULT_DENY_PATHS = [
  "/(log|sign)[-_]?(out|off)\\b",
  "/session/(destroy|end)",
  "/auth/(logout|signout)",
];

export const DEFAULT_CONFIG = {
  /** @type {EnvConfig} */
  baseline: {},
  /** @type {EnvConfig} */
  candidate: {},

  /** How to turn a branch name into something we can load. */
  branches: {
    /** e.g. "https://{branch}.preview.example.com" — {branch} is slugified, {branch_raw} is not. */
    urlTemplate: /** @type {string|null} */ (null),
    /** Build and serve each branch locally from a git worktree. */
    serve: /** @type {ServeConfig|null} */ (null),
  },

  crawl: {
    /** Pages to start from, relative to each environment's base URL. */
    startPaths: ["/"],
    maxPages: 25,
    /** Link hops from a start page. */
    maxDepth: 3,
    /** Pages sharing a route shape (/products/:id) beyond this many are skipped. */
    samplesPerPattern: 2,
    /** Only crawl paths matching one of these (regex). Empty = everything. */
    include: /** @type {string[]} */ ([]),
    /** Never crawl paths matching these (regex). */
    exclude: /** @type {string[]} */ ([]),
    /** Seed the crawl from /sitemap.xml. */
    sitemap: false,
    /** Treat ?a=1 and ?a=2 as the same page. */
    ignoreQuery: false,
    /** Check status of discovered links that were not crawled. */
    checkLinks: true,
    maxLinkChecks: 150,
  },

  explore: {
    /** Click every actionable element and compare what happens. */
    enabled: true,
    maxActionsPerPage: 25,
    /** Identical controls (e.g. 40 "Add to cart" buttons) explored at most this many times. */
    maxPerName: 2,
    /** 1 = clicks from the page as loaded; 2+ also clicks what those clicks reveal (menus, modals). */
    depth: 1,
    /** Also click plain same-origin links (they are crawled anyway). */
    includeLinks: false,
    /** Exercise <select> elements by picking another option. */
    selects: true,
    actionTimeout: 4000,
    settleTimeout: 2500,
    /** Which viewports get interaction exploration: "first" or "all". */
    viewports: "first",
    /** Never click elements matching these. */
    skip: {
      text: /** @type {string[]} */ ([]),
      selectors: /** @type {string[]} */ ([]),
    },
    /** Always allow these even if they match the deny list. */
    allow: {
      text: /** @type {string[]} */ ([]),
      selectors: /** @type {string[]} */ ([]),
    },
  },

  safety: {
    /** Let the app send POST/PUT/PATCH/DELETE. Only for disposable data. */
    allowMutations: false,
    /** Requests matching these are allowed through the mutation guard (regex on URL). */
    allowRequests: /** @type {string[]} */ ([]),
    /** GraphQL operations that are queries are always allowed; mutations are blocked. */
    graphql: true,
    useDefaultDenyList: true,
  },

  /** @type {(string | ViewportConfig)[]} */
  viewports: ["desktop"],

  browser: {
    name: "chromium",
    /** e.g. "chrome" or "msedge" to use an installed browser. */
    channel: /** @type {string|null} */ (null),
    executablePath: /** @type {string|null} */ (null),
    headless: true,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    userAgent: /** @type {string|null} */ (null),
    ignoreHTTPSErrors: false,
    /** Extra args passed to the browser. */
    args: /** @type {string[]} */ ([]),
    /** Route the browser through a proxy: { server: "http://proxy:3128", bypass?, username?, password? }. */
    proxy: /** @type {{ server: string, bypass?: string, username?: string, password?: string } | null} */ (null),
  },

  /** Run before anything else in each environment, e.g. a login form. */
  auth: /** @type {AuthConfig|null} */ (null),

  stabilize: {
    /** Mutations inside these (carousels, tickers) don't count as "still changing". */
    ignoreMutations: /** @type {string[]} */ ([]),
    quietMs: 400,
    maxWaitMs: 10000,
    /** Scroll the page to trigger lazy loading before full-page screenshots. */
    scroll: true,
    /** Click "Accept" on common cookie-consent banners (OneTrust, Cookiebot, …). */
    dismissConsent: true,
  },

  visual: {
    enabled: true,
    /** Per-pixel colour tolerance, 0-1 (pixelmatch). */
    threshold: 0.1,
    /** Diff ratios below this are noise. */
    minRatio: 0.002,
    /** Above this, the page is reported as major (likely structural breakage). */
    majorRatio: 0.3,
    /** Painted over before screenshots: dates, ads, avatars... */
    mask: /** @type {string[]} */ ([]),
    /** Hidden entirely (visibility: hidden) before screenshots, e.g. cookie banners. */
    hide: /** @type {string[]} */ ([]),
    fullPage: true,
    maxHeight: 10000,
    /** Freeze Date.now() for both environments, e.g. "2025-01-01T10:00:00Z". */
    freezeTime: /** @type {string|null} */ (null),
  },

  text: {
    enabled: true,
    /** Collapse timestamps, relative times and UUIDs before comparing. */
    normalize: true,
    severity: /** @type {Severity} */ ("minor"),
  },

  layout: {
    enabled: true,
    /** Pixel movement tolerated before an element counts as moved. */
    tolerance: 6,
  },

  ignore: {
    /** Text matching these is ignored in text comparisons. */
    text: /** @type {string[]} */ ([]),
    console: /** @type {string[]} */ ([]),
    /** Network requests matching these are ignored (analytics, ads). */
    requests: /** @type {string[]} */ ([]),
    /** Finding ids or types ("perf.*") to drop. */
    findings: /** @type {string[]} */ ([]),
    /** Elements matching these are ignored everywhere (matching, text, layout). */
    selectors: /** @type {string[]} */ ([]),
  },

  /** Re-grade finding types: { "perf.*": "info", "a11y.color-contrast": "major" }. */
  severity: /** @type {Record<string, Severity>} */ ({}),

  a11y: {
    enabled: true,
    /** Only report rules at or above this impact: minor | moderate | serious | critical. */
    minImpact: "moderate",
    tags: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
  },

  perf: {
    enabled: true,
    /** Relative slowdown tolerated (0.5 = 50%). */
    tolerance: 0.5,
    /** And the absolute difference must exceed this. */
    minDeltaMs: 750,
  },

  api: {
    /** Compare JSON response shapes of XHR/fetch calls. */
    enabled: true,
    maxBodyBytes: 1_000_000,
  },

  /** @type {JourneyConfig[]} */
  journeys: [],

  report: {
    outDir: "envdiff-report",
    /** Exit non-zero when a finding at or above this severity exists: critical | major | minor | never. */
    failOn: "critical",
    /** Interaction screenshots to keep: "changes" (only where the two sides behaved differently) or "all". */
    screenshots: "changes",
    title: /** @type {string|null} */ (null),
  },

  ai: {
    enabled: false,
    model: "claude-opus-5-5",
    effort: "medium",
    /** Pages and interactions sent for triage, worst first. */
    maxItems: 25,
    minSeverity: /** @type {Severity} */ ("minor"),
  },

  /** Page pairs processed in parallel. Each uses two browser tabs. */
  concurrency: 2,

  timeouts: {
    navigation: 30000,
    /** Stop starting new work after this long and write what we have. */
    total: 45 * 60 * 1000,
  },
};

/**
 * @typedef {object} EnvConfig
 * @property {string} [url]
 * @property {string} [ref] A branch, tag or commit.
 * @property {string} [label] Display name, e.g. "UAT".
 * @property {string} [basePath] Override the path prefix both sides are compared under.
 * @property {Record<string,string>} [headers] Sent only to this environment's origin (and headerHosts).
 * @property {string[]} [headerHosts] Other hosts (regex on host:port) that should also get the headers, e.g. the API host.
 * @property {{username: string, password: string}} [httpCredentials]
 * @property {string} [storageState] Playwright storage state file (cookies + localStorage).
 * @property {{name: string, value: string, domain?: string, path?: string}[]} [cookies]
 * @property {AuthConfig} [auth]
 */

/**
 * @typedef {object} ServeConfig
 * @property {string} [repo] The git repository to check branches out of (default: current directory).
 * @property {string} [cwd] App directory inside the repo.
 * @property {string} [install] e.g. "npm ci"
 * @property {string} [build] e.g. "npm run build"
 * @property {string} start e.g. "npm start"
 * @property {number} [port] Baseline port; candidate uses port + 1.
 * @property {string} [portEnv] Env var the app reads its port from.
 * @property {string} [readyPath]
 * @property {number} [readyTimeout] Seconds.
 * @property {Record<string,string>} [env]
 */

/**
 * @typedef {object} AuthConfig
 * @property {string} [loginUrl] Path or URL of the login page.
 * @property {StepConfig[]} steps
 * @property {string} [successUrl] Glob the URL must match afterwards.
 * @property {string} [successSelector] Element that must be visible afterwards.
 */

/**
 * @typedef {object} JourneyConfig
 * @property {string} name
 * @property {StepConfig[]} steps
 * @property {boolean} [allowMutations]
 * @property {boolean} [screenshotEveryStep]
 */

/** @typedef {Record<string, any>} StepConfig */

/**
 * @typedef {object} ViewportConfig
 * @property {string} name
 * @property {number} width
 * @property {number} height
 * @property {boolean} [isMobile]
 * @property {boolean} [hasTouch]
 * @property {number} [deviceScaleFactor]
 * @property {string} [userAgent]
 */

/** @typedef {typeof DEFAULT_CONFIG} Config */
/** @typedef {Omit<Config, "viewports"> & { viewports: ViewportConfig[] }} ResolvedConfig A config after resolveConfig(). */

const isPlainObject = (/** @type {unknown} */ v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof RegExp);

/**
 * Deep merge where objects merge and everything else (arrays included) replaces.
 * @param {any} base
 * @param {any} override
 */
export function mergeDeep(base, override) {
  if (override === undefined) return structuredCloneSafe(base);
  if (!isPlainObject(base) || !isPlainObject(override)) return structuredCloneSafe(override);
  /** @type {Record<string, any>} */
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? mergeDeep(base[k], v) : structuredCloneSafe(v);
  }
  return out;
}

/** @param {any} v */
function structuredCloneSafe(v) {
  if (typeof v === "function" || v instanceof RegExp) return v;
  if (Array.isArray(v)) return v.map(structuredCloneSafe);
  if (isPlainObject(v)) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = structuredCloneSafe(x);
    return out;
  }
  return v;
}

/**
 * Replace ${VAR} and ${VAR:-default} in every string. `$${VAR}` escapes.
 * Missing variables without a default are an error: a login step that types
 * an empty password fails far from its cause.
 * @param {any} value
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [where]
 * @returns {any}
 */
export function interpolateEnv(value, env = process.env, where = "config") {
  if (typeof value === "string") {
    return value.replace(/(\$?)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (m, escape, name, fallback) => {
      if (escape) return m.slice(1);
      const v = env[name];
      if (v !== undefined && v !== "") return v;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`${where} references \${${name}}, but ${name} is not set. Use \${${name}:-} if it is optional.`);
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolateEnv(v, env, `${where}[${i}]`));
  if (isPlainObject(value)) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v, env, `${where}.${k}`);
    return out;
  }
  return value;
}

export class ConfigError extends Error {
  name = "ConfigError";
}

/**
 * Load a config file. JS configs may export an object or a (possibly async)
 * function returning one; they read process.env themselves, so they are not
 * interpolated.
 * @param {string} file
 * @returns {Promise<Record<string, any>>}
 */
export async function loadConfigFile(file) {
  const abs = path.resolve(file);
  const ext = path.extname(abs).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) {
    const mod = await import(pathToFileURL(abs).href);
    const exported = mod.default ?? mod;
    const cfg = typeof exported === "function" ? await exported() : exported;
    if (!isPlainObject(cfg)) throw new ConfigError(`${file} must export a config object`);
    return cfg;
  }
  let raw;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch (e) {
    throw new ConfigError(`Cannot read config ${file}: ${/** @type {Error} */ (e).message}`);
  }
  let parsed;
  try {
    parsed = ext === ".json" ? JSON.parse(raw) : YAML.parse(raw);
  } catch (e) {
    throw new ConfigError(`Cannot parse ${file}: ${/** @type {Error} */ (e).message}`);
  }
  if (parsed == null) return {};
  if (!isPlainObject(parsed)) throw new ConfigError(`${file} must contain a mapping at the top level`);
  return interpolateEnv(parsed, process.env, path.basename(file));
}

/** @param {string | ViewportConfig} v */
export function resolveViewport(v) {
  if (typeof v !== "string") {
    if (!v || !v.width || !v.height) throw new ConfigError(`Viewport needs width and height: ${JSON.stringify(v)}`);
    return { deviceScaleFactor: 1, ...v, name: v.name || `${v.width}x${v.height}` };
  }
  const preset = /** @type {Record<string, ViewportConfig>} */ (VIEWPORT_PRESETS)[v.toLowerCase()];
  if (preset) return { deviceScaleFactor: 1, ...preset };
  const m = /^(\d{2,5})x(\d{2,5})$/i.exec(v.trim());
  if (m) return { name: v, width: Number(m[1]), height: Number(m[2]), deviceScaleFactor: 1 };
  throw new ConfigError(
    `Unknown viewport "${v}". Use ${Object.keys(VIEWPORT_PRESETS).join(", ")} or WIDTHxHEIGHT.`,
  );
}

/**
 * Merge defaults, file config and CLI overrides, then validate.
 * @param {Record<string, any>} [fileConfig]
 * @param {Record<string, any>} [overrides]
 * @param {{ warn?: (msg: string) => void }} [opts]
 * @returns {ResolvedConfig}
 */
export function resolveConfig(fileConfig = {}, overrides = {}, opts = {}) {
  const warn = opts.warn ?? (() => {});
  for (const key of Object.keys(fileConfig)) {
    if (!(key in DEFAULT_CONFIG)) warn(`Unknown config key "${key}" (ignored). Typo?`);
  }
  /** @type {any} */
  const cfg = mergeDeep(mergeDeep(DEFAULT_CONFIG, fileConfig), overrides);

  cfg.viewports = (cfg.viewports?.length ? cfg.viewports : ["desktop"]).map(resolveViewport);
  const names = new Set();
  for (const v of cfg.viewports) {
    if (names.has(v.name)) throw new ConfigError(`Duplicate viewport name "${v.name}"`);
    names.add(v.name);
  }

  const failOn = String(cfg.report.failOn).toLowerCase();
  if (![...SEVERITIES, "never"].includes(failOn)) {
    throw new ConfigError(`report.failOn must be one of ${SEVERITIES.join(", ")}, never — got "${cfg.report.failOn}"`);
  }
  cfg.report.failOn = failOn;

  for (const [key, min, max] of /** @type {[string, number, number][]} */ ([
    ["crawl.maxPages", 1, 10000],
    ["crawl.maxDepth", 0, 50],
    ["explore.maxActionsPerPage", 0, 1000],
    ["explore.depth", 1, 4],
    ["concurrency", 1, 16],
  ])) {
    const [a, b] = key.split(".");
    const holder = b ? cfg[a] : cfg;
    const field = b ?? a;
    const n = Number(holder[field]);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new ConfigError(`${key} must be a number between ${min} and ${max} — got ${holder[field]}`);
    }
    holder[field] = Math.floor(n);
  }

  if (!["chromium", "firefox", "webkit"].includes(cfg.browser.name)) {
    throw new ConfigError(`browser.name must be chromium, firefox or webkit — got "${cfg.browser.name}"`);
  }
  if (!["minor", "moderate", "serious", "critical"].includes(cfg.a11y.minImpact)) {
    throw new ConfigError(`a11y.minImpact must be minor, moderate, serious or critical`);
  }
  if (!SEVERITIES.includes(cfg.ai.minSeverity)) {
    throw new ConfigError(`ai.minSeverity must be one of ${SEVERITIES.join(", ")}`);
  }
  if (!Array.isArray(cfg.crawl.startPaths) || cfg.crawl.startPaths.length === 0) {
    cfg.crawl.startPaths = ["/"];
  }
  cfg.crawl.startPaths = cfg.crawl.startPaths.map((/** @type {string} */ p) =>
    /^https?:\/\//i.test(p) ? p : p.startsWith("/") ? p : `/${p}`,
  );
  for (const j of cfg.journeys) {
    if (!j || typeof j.name !== "string" || !Array.isArray(j.steps)) {
      throw new ConfigError(`Each journey needs a name and a steps list`);
    }
  }
  if (cfg.branches.serve && !cfg.branches.serve.start) {
    throw new ConfigError(`branches.serve needs a "start" command`);
  }
  return cfg;
}

/** @param {string} s */
export function severityRank(s) {
  const i = SEVERITIES.indexOf(/** @type {Severity} */ (s));
  return i < 0 ? SEVERITIES.length : i;
}

/** True when `s` is at least as severe as `threshold`. */
export function atLeast(/** @type {string} */ s, /** @type {string} */ threshold) {
  if (threshold === "never") return false;
  return severityRank(s) <= severityRank(threshold);
}
