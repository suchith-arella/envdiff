import { createHash } from "node:crypto";

/** Short, stable id for anything that needs to survive across runs. */
export function shortHash(/** @type {string} */ input, length = 10) {
  return createHash("sha1").update(input).digest("hex").slice(0, length);
}

/** Filesystem- and URL-safe slug. Keeps it readable; uniqueness comes from a hash suffix. */
export function slugify(/** @type {string} */ s, max = 60) {
  const slug = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "root";
}

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Race a promise against a timer. The losing promise keeps running; callers
 * must not depend on it being cancelled.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [what]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, what = "operation") {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return /** @type {Promise<T>} */ (Promise.race([promise, timeout]).finally(() => clearTimeout(timer)));
}

/**
 * A work queue that items can be added to while it drains — the crawler finds
 * new pages while processing old ones. Resolves when the queue is empty and no
 * worker is busy.
 * @template T
 * @param {object} opts
 * @param {number} opts.concurrency
 * @param {(item: T) => Promise<void>} opts.worker
 * @param {() => boolean} [opts.shouldStop]
 */
export function createQueue({ concurrency, worker, shouldStop = () => false }) {
  /** @type {T[]} */
  const items = [];
  let active = 0;
  /** @type {() => void} */
  let resolveIdle = () => {};
  /** @type {Promise<void>} */
  let idle = Promise.resolve();
  let draining = false;

  function pump() {
    while (active < concurrency && items.length && !shouldStop()) {
      const item = /** @type {T} */ (items.shift());
      active++;
      worker(item)
        .catch(() => {}) // workers own their error handling; a throw must not stall the queue
        .finally(() => {
          active--;
          pump();
        });
    }
    if (active === 0 && (items.length === 0 || shouldStop()) && draining) {
      draining = false;
      resolveIdle();
    }
  }

  return {
    /** @param {T} item */
    push(item) {
      items.push(item);
      if (!draining) {
        draining = true;
        idle = new Promise((r) => (resolveIdle = r));
      }
      queueMicrotask(pump);
    },
    /** Sort pending items, e.g. to keep the crawl breadth-first. */
    sort(/** @type {(a: T, b: T) => number} */ cmp) {
      items.sort(cmp);
    },
    get pending() {
      return items.length;
    },
    get active() {
      return active;
    },
    onIdle() {
      return draining ? idle : Promise.resolve();
    },
  };
}

/**
 * Run `fn` over `list` with bounded concurrency, preserving result order.
 * @template T, R
 * @param {T[]} list
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(list, concurrency, fn) {
  /** @type {R[]} */
  const results = new Array(list.length);
  let next = 0;
  async function lane() {
    while (next < list.length) {
      const i = next++;
      results[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, lane));
  return results;
}

/** Compile a user-supplied pattern list. Strings are regexes, case-insensitive. */
export function compilePatterns(/** @type {(string|RegExp)[] | undefined} */ list) {
  return (list ?? []).map((p) => {
    if (p instanceof RegExp) return p;
    try {
      return new RegExp(p, "i");
    } catch {
      // Not a valid regex: treat it as a literal substring.
      return new RegExp(String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  });
}

export const matchesAny = (/** @type {RegExp[]} */ patterns, /** @type {string} */ s) =>
  patterns.some((p) => p.test(s));

/** Truncate for display without cutting a surrogate pair. */
export function truncate(/** @type {string} */ s, max = 120) {
  const chars = Array.from(String(s ?? ""));
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("");
}

/**
 * Normalize an error message so the same failure on two hosts compares equal:
 * strips URLs, line/column numbers and hashed bundle names.
 */
export function normalizeMessage(/** @type {string} */ msg) {
  return String(msg ?? "")
    .replace(/https?:\/\/[^\s)'"]+/g, "<url>")
    .replace(/\b[\w-]+\.[0-9a-f]{6,}\.(js|css|mjs)\b/gi, "<bundle>")
    .replace(/:\d+:\d+/g, ":<l>:<c>")
    // Four or more digits: ids and timestamps. Three-digit numbers are left
    // alone because they are usually HTTP statuses, and 404 vs 500 matters.
    .replace(/\b\d{4,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
