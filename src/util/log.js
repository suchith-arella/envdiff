/**
 * Minimal leveled logger. Writes to stderr so stdout stays clean for `--json`.
 *
 * In GitHub Actions it can also emit workflow annotations, which show up on the
 * run summary page without anyone opening the log.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const color = {
  dim: paint(2),
  bold: paint(1),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  magenta: paint(35),
  cyan: paint(36),
};

export const inGitHubActions = process.env.GITHUB_ACTIONS === "true";

/**
 * @param {{ level?: keyof typeof LEVELS }} [opts]
 */
export function createLogger(opts = {}) {
  let level = LEVELS[opts.level ?? "info"] ?? LEVELS.info;
  const write = (/** @type {string} */ line) => process.stderr.write(line + "\n");
  return {
    /** @param {keyof typeof LEVELS} l */
    setLevel(l) {
      level = LEVELS[l] ?? level;
    },
    get verbose() {
      return level >= LEVELS.debug;
    },
    /** @param {...unknown} a */
    error: (...a) => level >= LEVELS.error && write(color.red("✖ ") + a.join(" ")),
    /** @param {...unknown} a */
    warn: (...a) => level >= LEVELS.warn && write(color.yellow("! ") + a.join(" ")),
    /** @param {...unknown} a */
    info: (...a) => level >= LEVELS.info && write(a.join(" ")),
    /** @param {...unknown} a */
    debug: (...a) => level >= LEVELS.debug && write(color.dim(a.join(" "))),
    /** @param {string} title */
    group(title) {
      if (inGitHubActions) write(`::group::${title}`);
      else if (level >= LEVELS.info) write(color.bold(title));
    },
    groupEnd() {
      if (inGitHubActions) write("::endgroup::");
    },
    /**
     * A GitHub annotation, or nothing outside Actions. Newlines must be
     * URL-encoded or the runner truncates the message at the first one.
     * @param {"error"|"warning"|"notice"} kind
     * @param {string} title
     * @param {string} message
     */
    annotate(kind, title, message) {
      if (!inGitHubActions) return;
      const esc = (/** @type {string} */ s) =>
        s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      const escProp = (/** @type {string} */ s) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
      write(`::${kind} title=${escProp(title)}::${esc(message)}`);
    },
  };
}

/** @typedef {ReturnType<typeof createLogger>} Logger */

/** @param {number} ms */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}
