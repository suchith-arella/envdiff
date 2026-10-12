import { shortHash } from "./util/misc.js";
import { SEVERITIES, severityRank } from "./config.js";

/**
 * @typedef {import("./config.js").Severity} Severity
 *
 * @typedef {object} Finding
 * @property {string} id Stable across runs: use it in ignore.findings to accept a known difference.
 * @property {Severity} severity
 * @property {string} category availability | interaction | journey | errors | network | api | elements | forms | content | visual | layout | a11y | perf | seo | security | links
 * @property {string} type Dotted type, e.g. "interaction.no-effect".
 * @property {string} title One line, fit for a table cell.
 * @property {string} [detail] More context; may span lines.
 * @property {string} [page] Page key.
 * @property {string} [viewport]
 * @property {string} [interaction] Interaction id within the page.
 * @property {string} [journey]
 * @property {{ role: string, name: string, cssPath?: string, landmark?: string }} [element]
 * @property {any} [baseline] What the baseline showed.
 * @property {any} [candidate] What the candidate showed.
 * @property {{ baseline?: string, candidate?: string, diff?: string }} [evidence] Screenshot paths.
 * @property {string[]} [pages] Every page an error or failed call was seen on while loading.
 * @property {{ verdict: string, confidence: number, explanation: string }} [ai]
 */

/**
 * Problems whose cause doesn't depend on the page: the same exception or
 * failed call on every page load is one problem, reported once with the pages
 * it was seen on.
 */
const SITE_WIDE = new Set(["errors.uncaught", "errors.console", "network.failed", "network.failed-asset"]);

/** Glob on dotted types: "perf.*", "a11y.color-contrast", "*". */
function typeMatcher(/** @type {string} */ pattern) {
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return (/** @type {string} */ type) => re.test(type);
}

/**
 * Collects findings, applying the user's ignore rules and severity overrides.
 * @param {import("./config.js").Config} cfg
 */
export function createFindings(cfg) {
  /** @type {Finding[]} */
  const list = [];
  /** @type {Map<string, Finding>} */
  const byId = new Map();
  const ignoreIds = new Set(cfg.ignore.findings.filter((s) => /^[0-9a-f]{10}$/.test(s)));
  const ignoreTypes = cfg.ignore.findings.filter((s) => !ignoreIds.has(s)).map(typeMatcher);
  const overrides = Object.entries(/** @type {Record<string,string>} */ (/** @type {any} */ (cfg).severity ?? {})).map(
    ([pattern, sev]) => /** @type {const} */ ([typeMatcher(pattern), sev]),
  );
  let suppressed = 0;

  return {
    /**
     * @param {Omit<Finding, "id"> & { fp?: string }} f `fp` is what makes this finding
     *   unique (defaults to the title); keep volatile numbers out of it.
     */
    add(f) {
      const { fp, ...rest } = f;
      const siteWide = SITE_WIDE.has(f.type) && !!f.page && !f.interaction && !f.journey;
      const id = shortHash([f.type, siteWide ? "*" : f.page ?? "", siteWide ? "" : f.viewport ?? "", f.journey ?? "", fp ?? f.title].join("|"));
      if (ignoreIds.has(id) || ignoreTypes.some((m) => m(f.type))) {
        suppressed++;
        return null;
      }
      for (const [m, sev] of overrides) if (m(f.type) && SEVERITIES.includes(/** @type {Severity} */ (sev))) rest.severity = /** @type {Severity} */ (sev);
      const existing = byId.get(id);
      if (existing) {
        // Same finding reached twice (two paths to one interaction, one error
        // on many pages): keep the worse severity.
        if (severityRank(rest.severity) < severityRank(existing.severity)) existing.severity = rest.severity;
        if (siteWide && f.page && existing.pages && !existing.pages.includes(f.page)) existing.pages.push(f.page);
        return existing;
      }
      /** @type {Finding} */
      const finding = { id, ...rest };
      if (siteWide && f.page) finding.pages = [f.page];
      list.push(finding);
      byId.set(id, finding);
      return finding;
    },
    all() {
      return [...list].sort(
        (a, b) => severityRank(a.severity) - severityRank(b.severity) || (a.page ?? "").localeCompare(b.page ?? ""),
      );
    },
    /** @param {string} id */
    get(id) {
      return byId.get(id);
    },
    get suppressed() {
      return suppressed;
    },
  };
}

/** @typedef {ReturnType<typeof createFindings>} Findings */

/** @param {Finding[]} findings */
export function countBySeverity(findings) {
  /** @type {Record<Severity, number>} */
  const counts = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}
