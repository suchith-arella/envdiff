/**
 * JSON "shapes": the structure of a payload without its values. Comparing
 * shapes catches API contract breaks (a field dropped, a number that became a
 * string) while ignoring the data differences that are normal between
 * environments.
 */

const DYNAMIC_KEY = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z0-9_-]{20,})$/i;

/**
 * @param {unknown} v
 * @param {number} [depth]
 * @returns {any}
 */
export function shapeOf(v, depth = 0) {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (!v.length) return [];
    let merged = shapeOf(v[0], depth + 1);
    for (const item of v.slice(1, 8)) merged = mergeShapes(merged, shapeOf(item, depth + 1));
    return [merged];
  }
  if (typeof v === "object") {
    if (depth > 8) return "object";
    const keys = Object.keys(/** @type {object} */ (v));
    // Maps keyed by ids ({"123": {...}, "456": {...}}) differ per environment by
    // nature; collapse them to one representative entry.
    if (keys.length && keys.every((k) => DYNAMIC_KEY.test(k))) {
      let merged = shapeOf(/** @type {any} */ (v)[keys[0]], depth + 1);
      for (const k of keys.slice(1, 8)) merged = mergeShapes(merged, shapeOf(/** @type {any} */ (v)[k], depth + 1));
      return { "{id}": merged };
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of keys.sort().slice(0, 120)) out[k] = shapeOf(/** @type {any} */ (v)[k], depth + 1);
    return out;
  }
  return typeof v;
}

/**
 * Union of two shapes. Conflicting scalar types become "a|b"; null and empty
 * arrays yield to whatever the other side knows.
 * @param {any} a
 * @param {any} b
 * @returns {any}
 */
export function mergeShapes(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === "null") return b;
  if (b === "null") return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (!a.length) return b;
    if (!b.length) return a;
    return [mergeShapes(a[0], b[0])];
  }
  if (isObj(a) && isObj(b)) {
    /** @type {Record<string, any>} */
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeShapes(out[k], v) : v;
    return out;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return a;
    return [...new Set([...a.split("|"), ...b.split("|")])].sort().join("|");
  }
  // object vs scalar, array vs object...
  return `${describeKind(a)}|${describeKind(b)}`;
}

/** @param {any} s */
function describeKind(s) {
  if (Array.isArray(s)) return "array";
  if (isObj(s)) return "object";
  return String(s);
}

/** @param {any} v */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Flatten a shape into path -> type: { "items[].price": "number", ... }.
 * @param {any} shape
 * @returns {Map<string, string>}
 */
export function flattenShape(shape, prefix = "", out = new Map()) {
  const at = prefix || "$";
  if (typeof shape === "string") {
    out.set(at, shape);
  } else if (Array.isArray(shape)) {
    out.set(at, shape.length ? "array" : "array(empty)");
    if (shape.length) flattenShape(shape[0], `${prefix}[]`, out);
  } else if (isObj(shape)) {
    out.set(at, "object");
    for (const [k, v] of Object.entries(shape)) flattenShape(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/**
 * Compare two shapes. Paths under something the other side can't describe
 * (null, an empty array, a type union) are skipped: "no orders in UAT" is
 * data, not a contract change.
 * @param {any} baseline
 * @param {any} candidate
 */
export function compareShapes(baseline, candidate) {
  const a = flattenShape(baseline);
  const b = flattenShape(candidate);
  const unknowable = (/** @type {Map<string,string>} */ m, /** @type {string} */ path) => {
    // Walk up the ancestors of `path`; if any is opaque on this side, the path is unknowable.
    let p = path;
    while (p && p !== "$") {
      const cut = Math.max(p.lastIndexOf("."), p.lastIndexOf("[]"));
      p = cut > 0 ? p.slice(0, cut) : "$";
      if (p.endsWith("[]")) p = p.slice(0, -2) || "$";
      const t = m.get(p);
      if (t === "null" || t === "array(empty)" || (t && t.includes("|"))) return true;
    }
    return false;
  };
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const added = [];
  /** @type {{ path: string, from: string, to: string }[]} */
  const changed = [];
  for (const [path, type] of a) {
    const other = b.get(path);
    if (other === undefined) {
      if (!unknowable(b, path) && !isUnder(missing, path)) missing.push(path);
      continue;
    }
    const opaque = (/** @type {string} */ t) => t === "null" || t === "array(empty)";
    if (other !== type && !opaque(type) && !opaque(other)) {
      // A union on either side that includes the other's type is not a change.
      const ta = type.split("|");
      const tb = other.split("|");
      if (!ta.some((t) => tb.includes(t))) changed.push({ path, from: type, to: other });
    }
  }
  for (const path of b.keys()) {
    if (!a.has(path) && !unknowable(a, path) && !isUnder(added, path)) added.push(path);
  }
  return { missing, added, changed };
}

/** True if `path` is below something already listed (report the parent only). */
function isUnder(/** @type {string[]} */ list, /** @type {string} */ path) {
  return list.some((p) => path.startsWith(p + ".") || path.startsWith(p + "[]"));
}

/**
 * The shape of a request body, for comparing what a click sends.
 * @param {string | null} body
 * @param {string} [contentType]
 * @returns {string[]} sorted "path:type" entries, or field names
 */
export function bodyShape(body, contentType = "") {
  if (!body) return [];
  const ct = contentType.toLowerCase();
  if (ct.includes("json") || /^\s*[[{]/.test(body)) {
    try {
      return [...flattenShape(shapeOf(JSON.parse(body)))]
        .filter(([p, t]) => p !== "$" && t !== "object" && t !== "array")
        .map(([p, t]) => `${p}:${t}`)
        .sort();
    } catch {
      // not JSON after all
    }
  }
  if (ct.includes("x-www-form-urlencoded")) return [...new Set(new URLSearchParams(body).keys())].sort();
  if (ct.includes("multipart")) return [...new Set([...body.matchAll(/name="([^"]+)"/g)].map((m) => m[1]))].sort();
  return [`<${body.length} bytes>`];
}
