import { similarity } from "./util/textdiff.js";

/**
 * @typedef {object} El An actionable element from the in-page inventory, plus derived keys.
 * @property {number} idx
 * @property {string} tag
 * @property {string} role
 * @property {string} kind
 * @property {string} name
 * @property {string} type
 * @property {string} href
 * @property {string} [hrefKey]
 * @property {string} testId
 * @property {string} id
 * @property {string} nameAttr
 * @property {string} landmark
 * @property {string} heading
 * @property {{x:number,y:number,w:number,h:number}} rect
 * @property {boolean} disabled
 * @property {boolean} inDialog
 * @property {string} cssPath
 * @property {Record<string,string>} styles
 * @property {string} [key] Stable identity within a page: role|name|landmark#n
 * @property {any} [value]
 * @property {any[]} [options]
 * @property {any} [expanded]
 * @property {any} [checked]
 */

/** Lowercase, whitespace-collapsed, punctuation-trimmed. */
export function loose(/** @type {string} */ s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[​-‍﻿]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "")
    .trim();
}

/** loose() with numbers collapsed: "Cart (3)" and "Cart (0)" are the same control. */
export function digitless(/** @type {string} */ s) {
  return loose(s).replace(/\d+([.,]\d+)*/g, "#");
}

/**
 * Give every element a key that identifies it within its page across
 * environments: role, name and landmark, plus an occurrence index for
 * repeats. Also resolves link targets to page keys.
 * @param {El[]} els
 * @param {(href: string) => string | null} [keyOfHref]
 */
export function annotateElements(els, keyOfHref) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const e of els) {
    const base = `${e.role}|${digitless(e.name) || e.testId || e.nameAttr || e.cssPath}|${e.landmark}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    e.key = `${base}#${n}`;
    if (e.href && keyOfHref) {
      const k = keyOfHref(e.href);
      e.hrefKey = k ?? stripQuery(e.href);
    } else if (e.hrefKey === undefined) e.hrefKey = "";
  }
  return els;
}

/** @param {string} href */
function stripQuery(href) {
  try {
    const u = new URL(href);
    return u.protocol.startsWith("http") ? `${u.origin}${u.pathname}` : u.protocol;
  } catch {
    return href;
  }
}

/**
 * @template {El} T
 * @typedef {{ a: T, b: T, how: string, score: number }} Pair
 */

/**
 * Pair elements from two inventories, strongest evidence first. Within a key,
 * elements pair in document order, so the 2nd "Edit" matches the 2nd "Edit".
 * @template {El} T
 * @param {T[]} A baseline elements
 * @param {T[]} B candidate elements
 * @returns {{ pairs: Pair<T>[], onlyA: T[], onlyB: T[] }}
 */
export function matchElements(A, B) {
  /** @type {Set<T>} */
  const usedA = new Set();
  /** @type {Set<T>} */
  const usedB = new Set();
  /** @type {Pair<T>[]} */
  const pairs = [];

  /** @type {[string, (e: T) => string | null][]} */
  const passes = [
    ["test-id", (e) => (e.testId ? e.testId : null)],
    ["id", (e) => (e.id ? `${e.tag}#${e.id}` : null)],
    ["role+name+landmark", (e) => (e.name ? `${e.role}|${loose(e.name)}|${e.landmark}` : null)],
    ["role+name", (e) => (e.name ? `${e.role}|${loose(e.name)}` : null)],
    ["role+name~digits", (e) => (e.name ? `${e.role}|${digitless(e.name)}|${e.landmark}` : null)],
    ["href", (e) => (e.hrefKey ? `${e.role}|${e.hrefKey}` : null)],
    ["field-name", (e) => (e.nameAttr ? `${e.tag}|${e.type}|${e.nameAttr}` : null)],
  ];
  for (const [how, keyFn] of passes) {
    const ga = groupBy(A.filter((e) => !usedA.has(e)), keyFn);
    const gb = groupBy(B.filter((e) => !usedB.has(e)), keyFn);
    for (const [k, as] of ga) {
      const bs = gb.get(k);
      if (!bs) continue;
      for (let i = 0; i < Math.min(as.length, bs.length); i++) {
        usedA.add(as[i]);
        usedB.add(bs[i]);
        pairs.push({ a: as[i], b: bs[i], how, score: 1 });
      }
    }
  }

  // Fuzzy: same role, similar name; landmark and position break ties.
  const restA = A.filter((e) => !usedA.has(e)).slice(0, 250);
  const restB = B.filter((e) => !usedB.has(e)).slice(0, 250);
  /** @type {[number, T, T][]} */
  const scored = [];
  for (const a of restA) {
    for (const b of restB) {
      if (a.role !== b.role) continue;
      const na = loose(a.name);
      const nb = loose(b.name);
      let s;
      if (na || nb) {
        s = similarity(na, nb);
        if (s < 0.6) continue;
      } else {
        // Nameless (icon buttons): only by position, and only when close.
        const d = Math.hypot(a.rect.x - b.rect.x, a.rect.y - b.rect.y);
        if (a.landmark !== b.landmark || d > 60) continue;
        s = 0.7 - d / 200;
      }
      const dist = Math.hypot(a.rect.x - b.rect.x, a.rect.y - b.rect.y);
      const score = s + (a.landmark === b.landmark ? 0.15 : 0) - Math.min(0.2, dist / 5000);
      scored.push([score, a, b]);
    }
  }
  scored.sort((x, y) => y[0] - x[0]);
  for (const [score, a, b] of scored) {
    if (usedA.has(a) || usedB.has(b)) continue;
    usedA.add(a);
    usedB.add(b);
    pairs.push({ a, b, how: "fuzzy", score: Math.round(score * 100) / 100 });
  }

  pairs.sort((x, y) => x.a.idx - y.a.idx);
  return { pairs, onlyA: A.filter((e) => !usedA.has(e)), onlyB: B.filter((e) => !usedB.has(e)) };
}

/**
 * @template T
 * @param {T[]} list
 * @param {(e: T) => string | null} keyFn
 */
function groupBy(list, keyFn) {
  /** @type {Map<string, T[]>} */
  const m = new Map();
  for (const e of list) {
    const k = keyFn(e);
    if (k == null) continue;
    const g = m.get(k);
    if (g) g.push(e);
    else m.set(k, [e]);
  }
  return m;
}

/**
 * Find the element with a given key in a fresh inventory (after a reload the
 * indexes change, the keys don't). Falls back to matching against the
 * original element when keys drifted.
 * @template {El} T
 * @param {T[]} els
 * @param {T} wanted
 * @returns {T | null}
 */
export function relocate(els, wanted) {
  const exact = els.find((e) => e.key === wanted.key);
  if (exact) return exact;
  const { pairs } = matchElements([wanted], els);
  return pairs.length ? pairs[0].b : null;
}
