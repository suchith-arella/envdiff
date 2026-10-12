/**
 * Programmatic API.
 *
 *   import { compare } from "envdiff";
 *   const { report, exitCode } = await compare({
 *     baseline: { url: "https://uat.example.com" },
 *     candidate: { url: "https://dev.example.com" },
 *     crawl: { maxPages: 10 },
 *   });
 */
import { resolveConfig, loadConfigFile, DEFAULT_CONFIG, ConfigError } from "./config.js";
import { run, VERSION } from "./run.js";
import { createLogger } from "./util/log.js";

export { run, resolveConfig, loadConfigFile, DEFAULT_CONFIG, ConfigError, VERSION };
export { classifyTarget, applyUrlTemplate, branchSlug } from "./targets.js";

/**
 * Resolve a partial config and run a comparison.
 * @param {Record<string, any>} config
 * @param {{ log?: ReturnType<typeof createLogger>, quiet?: boolean }} [opts]
 */
export function compare(config, opts = {}) {
  const log = opts.log ?? createLogger({ level: opts.quiet ? "warn" : "info" });
  return run(resolveConfig(config, {}, { warn: (m) => log.warn(m) }), { log });
}
