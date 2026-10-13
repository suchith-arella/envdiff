import { matchElements, loose, digitless } from "../match.js";
import { routePattern } from "../urls.js";
import { truncate } from "../util/misc.js";

/**
 * @typedef {import("../match.js").El} El
 * @typedef {(f: Omit<import("../findings.js").Finding, "id"> & { fp?: string }) => any} AddFinding
 */

/** 'button "Add to cart" (main › Product details)' */
export function describeEl(/** @type {El} */ e) {
  const name = e.name ? ` "${truncate(e.name, 60)}"` : e.testId ? ` [${e.testId}]` : "";
  const where = [e.landmark !== "body" ? e.landmark : "", e.heading ? `under "${truncate(e.heading, 40)}"` : ""].filter(Boolean).join(" › ");
  return `${e.role}${name}${where ? ` (${where})` : ""}`;
}

/** @param {El} e */
export function elRef(e) {
  return { role: e.role, name: e.name, cssPath: e.cssPath, landmark: e.landmark };
}

/** Landmarks that repeat on every page (site header, navigation, footer). */
export const CHROME = /^(banner|navigation|contentinfo)/;

/**
 * Compare the controls on two versions of a page.
 * @param {{ actionables: El[] }} domA
 * @param {{ actionables: El[] }} domB
 * @param {{ add: AddFinding, where: { page: string, viewport: string }, tolerance: number, layout: boolean, seen?: Set<string> }} ctx
 *   `seen` is shared across pages so a change to the site header is reported once, not on every page.
 */
export function compareElements(domA, domB, ctx) {
  const { add, where } = ctx;
  const seen = ctx.seen ?? new Set();
  /** True the first time a change to a site-wide element is seen; always true elsewhere. */
  const once = (/** @type {El} */ e, /** @type {string} */ kind, change = "") => {
    if (!CHROME.test(e.landmark)) return true;
    const sig = `${where.viewport}|${kind}|${e.key}|${change}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  };
  // Grid headers and rows, chart legends: the grid and chart checks cover them.
  const A = domA.actionables.filter((e) => !(/** @type {any} */ (e).inData));
  const B = domB.actionables.filter((e) => !(/** @type {any} */ (e).inData));
  const { pairs, onlyA: allOnlyA, onlyB: allOnlyB } = matchElements(A, B);
  const onlyA = allOnlyA.filter((e) => once(e, "missing"));
  const onlyB = allOnlyB.filter((e) => once(e, "new"));

  // A page whose controls mostly vanished is broken, not "missing 37 buttons".
  const real = A.filter((e) => e.kind !== "input");
  if (real.length >= 8 && pairs.length < real.length * 0.3) {
    const onlyA = allOnlyA;
    add({
      ...where,
      severity: "critical",
      category: "elements",
      type: "elements.mostly-missing",
      title: `Page looks broken: only ${pairs.length} of ${A.length} controls from the baseline are present`,
      detail: `The candidate rendered ${B.length} controls. Missing include: ${onlyA.slice(0, 8).map(describeEl).join("; ")}`,
      baseline: A.length,
      candidate: B.length,
      fp: "mostly-missing",
    });
    return { pairs, onlyA, onlyB };
  }

  // Missing controls, minus what is data rather than code:
  // - links into a route family that still has members on the candidate
  //   (/products/12 gone but /products/34 there; or /p/blue-shirt among siblings)
  // - repeated controls that still exist, just fewer times (one "Add to cart"
  //   per product, and the candidate has fewer products)
  const candidatePatterns = new Set(B.filter((e) => e.hrefKey?.startsWith("/")).map((e) => routePattern(/** @type {string} */ (e.hrefKey))));
  const familyA = linkFamilies(A);
  const familyB = linkFamilies(B);
  const namesB = new Set(B.filter((e) => e.name).map((e) => `${e.role}|${digitless(e.name)}`));
  const isDataLink = (/** @type {El} */ e) => {
    if (e.kind !== "link" || !e.hrefKey?.startsWith("/")) return false;
    const pattern = routePattern(e.hrefKey);
    if (pattern !== e.hrefKey && candidatePatterns.has(pattern)) return true;
    const parent = parentPath(e.hrefKey);
    return !!parent && (familyA.get(parent) ?? 0) >= 2 && (familyB.get(parent) ?? 0) >= 1;
  };
  const dataLike = [];
  const missing = [];
  for (const e of onlyA) {
    if (isDataLink(e) || (e.name && namesB.has(`${e.role}|${digitless(e.name)}`))) dataLike.push(e);
    else missing.push(e);
  }
  for (const e of missing.slice(0, 12)) {
    add({
      ...where,
      severity: e.kind === "input" ? "minor" : "major",
      category: "elements",
      type: "elements.missing",
      title: `Missing on candidate: ${describeEl(e)}`,
      element: elRef(e),
      baseline: e.href ? `${e.name} → ${e.hrefKey}` : e.name,
      fp: /** @type {string} */ (e.key),
    });
  }
  if (missing.length > 12) {
    add({
      ...where,
      severity: "major",
      category: "elements",
      type: "elements.missing",
      title: `${missing.length - 12} more controls missing on candidate`,
      detail: missing.slice(12, 60).map(describeEl).join("\n"),
      fp: "missing-more",
    });
  }
  if (dataLike.length) {
    add({
      ...where,
      severity: "info",
      category: "elements",
      type: "elements.data-links",
      title: `${dataLike.length} data-driven control${dataLike.length === 1 ? "" : "s"} differ (e.g. ${describeEl(dataLike[0])}); expected when environments hold different data`,
      detail: dataLike.slice(0, 30).map(describeEl).join("\n"),
      fp: "data-links",
    });
  }
  if (onlyB.length) {
    add({
      ...where,
      severity: "info",
      category: "elements",
      type: "elements.new",
      title: `${onlyB.length} new control${onlyB.length === 1 ? "" : "s"} on candidate: ${onlyB.slice(0, 3).map(describeEl).join(", ")}${onlyB.length > 3 ? "…" : ""}`,
      detail: onlyB.slice(0, 40).map(describeEl).join("\n"),
      fp: "new",
    });
  }

  /** @type {string[]} */
  const labelChanges = [];
  /** @type {string[]} */
  const hrefChanges = [];
  /** @type {string[]} */
  const styleChanges = [];
  /** @type {{ e: El, dx: number, dy: number, dw: number, dh: number }[]} */
  const moved = [];
  for (const { a, b, how } of pairs) {
    if (digitless(a.name) !== digitless(b.name) && (a.name || b.name) && once(a, "label", b.name)) {
      labelChanges.push(`${a.role} "${truncate(a.name, 50)}" → "${truncate(b.name, 50)}"${how === "fuzzy" ? "" : ` (matched by ${how})`}`);
    }
    if (!a.disabled && b.disabled && once(a, "disabled")) {
      add({
        ...where,
        severity: "major",
        category: "elements",
        type: "elements.disabled",
        title: `Disabled on candidate: ${describeEl(a)}`,
        element: elRef(a),
        baseline: "enabled",
        candidate: "disabled",
        fp: /** @type {string} */ (a.key),
      });
    }
    if (a.kind === "link" && b.kind === "link" && a.hrefKey !== b.hrefKey && how !== "href" && once(a, "href", `${a.hrefKey}>${b.hrefKey}`)) {
      hrefChanges.push(`${describeEl(a)}: ${a.hrefKey} → ${b.hrefKey}`);
    }
    if (a.tag === "select" && b.tag === "select") {
      const oa = (a.options ?? []).map((/** @type {any} */ o) => loose(o.text));
      const ob = (b.options ?? []).map((/** @type {any} */ o) => loose(o.text));
      const gone = oa.filter((/** @type {string} */ o) => !ob.includes(o));
      if (gone.length && once(a, "options", gone.join(","))) {
        add({
          ...where,
          severity: "minor",
          category: "elements",
          type: "elements.options",
          title: `Dropdown ${describeEl(a)} lost ${gone.length} option${gone.length === 1 ? "" : "s"}: ${gone.slice(0, 4).join(", ")}`,
          element: elRef(a),
          baseline: oa,
          candidate: ob,
          fp: /** @type {string} */ (a.key),
        });
      }
    }
    const diffs = styleDiff(a.styles, b.styles);
    if (diffs.length && once(a, "style", diffs.join(";"))) styleChanges.push(`${describeEl(a)}: ${diffs.join("; ")}`);
    if (ctx.layout) {
      const dx = b.rect.x - a.rect.x;
      const dy = b.rect.y - a.rect.y;
      const dw = b.rect.w - a.rect.w;
      const dh = b.rect.h - a.rect.h;
      const tol = ctx.tolerance;
      const changed = Math.abs(dx) > tol || Math.abs(dy) > tol || Math.abs(dw) > Math.max(tol, a.rect.w * 0.1) || Math.abs(dh) > Math.max(tol, a.rect.h * 0.2);
      if (changed && once(a, "moved", `${dx},${dy},${dw},${dh}`)) moved.push({ e: a, dx, dy, dw, dh });
    }
  }

  if (labelChanges.length) {
    add({
      ...where,
      severity: "minor",
      category: "content",
      type: "elements.label",
      title: labelChanges.length === 1 ? `Label changed: ${labelChanges[0]}` : `${labelChanges.length} control labels changed`,
      detail: labelChanges.slice(0, 40).join("\n"),
      fp: "labels",
    });
  }
  if (hrefChanges.length) {
    add({
      ...where,
      severity: "minor",
      category: "links",
      type: "elements.href",
      title: hrefChanges.length === 1 ? `Link target changed: ${hrefChanges[0]}` : `${hrefChanges.length} links point somewhere else`,
      detail: hrefChanges.slice(0, 40).join("\n"),
      fp: "hrefs",
    });
  }
  if (styleChanges.length) {
    add({
      ...where,
      severity: "minor",
      category: "layout",
      type: "layout.style",
      title: styleChanges.length === 1 ? `Style changed: ${styleChanges[0]}` : `Style changed on ${styleChanges.length} controls`,
      detail: styleChanges.slice(0, 40).join("\n"),
      fp: "styles",
    });
  }
  if (moved.length) reportMoves(moved, ctx);
  return { pairs, onlyA, onlyB };
}

/** @param {string} key */
function parentPath(key) {
  const path = key.split(/[?#]/)[0];
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : null;
}

/** How many internal links share each parent path. @param {El[]} els */
function linkFamilies(els) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const e of els) {
    if (e.kind !== "link" || !e.hrefKey?.startsWith("/")) continue;
    const p = parentPath(e.hrefKey);
    if (p) m.set(p, (m.get(p) ?? 0) + 1);
  }
  return m;
}

const STYLE_LABELS = /** @type {Record<string,string>} */ ({
  color: "text colour",
  backgroundColor: "background",
  fontSize: "font size",
  fontWeight: "font weight",
  fontFamily: "font",
  textDecorationLine: "decoration",
  borderTopWidth: "border width",
  borderTopColor: "border colour",
  borderRadius: "corner radius",
});

/**
 * @param {Record<string,string> | undefined} a
 * @param {Record<string,string> | undefined} b
 */
export function styleDiff(a, b) {
  if (!a || !b) return [];
  /** @type {string[]} */
  const out = [];
  for (const [k, label] of Object.entries(STYLE_LABELS)) {
    const va = a[k];
    const vb = b[k];
    if (va === undefined || vb === undefined || va === vb) continue;
    // Border colour only matters when there is a border.
    if (k === "borderTopColor" && a.borderTopWidth === "0px" && b.borderTopWidth === "0px") continue;
    out.push(`${label} ${va} → ${vb}`);
  }
  return out;
}

/**
 * Report moved/resized elements. When most of them moved by the same offset,
 * that's one change (something above grew), not twenty.
 * @param {{ e: El, dx: number, dy: number, dw: number, dh: number }[]} moved
 * @param {{ add: AddFinding, where: { page: string, viewport: string } }} ctx
 */
function reportMoves(moved, { add, where }) {
  /** @type {Map<string, typeof moved>} */
  const groups = new Map();
  for (const m of moved) {
    if (Math.abs(m.dw) > 4 || Math.abs(m.dh) > 4) continue;
    const k = `${Math.round(m.dx / 4) * 4},${Math.round(m.dy / 4) * 4}`;
    const g = groups.get(k) ?? [];
    g.push(m);
    groups.set(k, g);
  }
  const biggest = [...groups.values()].sort((x, y) => y.length - x.length)[0];
  let rest = moved;
  if (biggest && biggest.length >= 3 && biggest.length >= moved.length * 0.5) {
    const { dx, dy } = biggest[0];
    const first = [...biggest].sort((p, q) => p.e.rect.y - q.e.rect.y)[0];
    add({
      ...where,
      severity: "minor",
      category: "layout",
      type: "layout.shift",
      title: `Content shifted ${dy ? `${dy > 0 ? "down" : "up"} ${Math.abs(dy)}px` : ""}${dx && dy ? " and " : ""}${dx ? `${dx > 0 ? "right" : "left"} ${Math.abs(dx)}px` : ""} from ${describeEl(first.e)} on (${biggest.length} controls)`,
      detail: "Usually something above this point changed height. See the visual diff.",
      fp: "shift",
    });
    const inGroup = new Set(biggest);
    rest = moved.filter((m) => !inGroup.has(m));
  }
  if (!rest.length) return;
  const lines = rest
    .slice(0, 30)
    .map(
      (m) =>
        `${describeEl(m.e)}: ${m.dx || m.dy ? `moved (${fmt(m.dx)}, ${fmt(m.dy)})` : ""}${(m.dx || m.dy) && (m.dw || m.dh) ? ", " : ""}${m.dw || m.dh ? `resized (${fmt(m.dw)}w, ${fmt(m.dh)}h)` : ""}`,
    );
  add({
    ...where,
    severity: "minor",
    category: "layout",
    type: "layout.moved",
    title: rest.length === 1 ? `Moved/resized: ${lines[0]}` : `${rest.length} controls moved or resized`,
    detail: lines.join("\n"),
    fp: "moved",
  });
}

const fmt = (/** @type {number} */ n) => (n > 0 ? `+${n}` : String(n));

/**
 * Forms: fields that disappeared, lost validation, or changed type.
 * @param {any[]} formsA
 * @param {any[]} formsB
 * @param {{ add: AddFinding, where: { page: string, viewport: string } }} ctx
 */
export function compareForms(formsA, formsB, { add, where }) {
  const used = new Set();
  for (const [i, fa] of formsA.entries()) {
    let fb =
      formsB.find((f) => !used.has(f) && fa.name && f.name === fa.name) ??
      formsB.find((f) => !used.has(f) && f.action && f.action === fa.action && f.landmark === fa.landmark) ??
      formsB.find((f) => !used.has(f) && formsB.indexOf(f) === i);
    const label = fa.name ? `form "${truncate(fa.name, 40)}"` : `form #${i + 1}`;
    if (!fb) {
      if (fa.visible) {
        add({ ...where, severity: "major", category: "forms", type: "forms.missing", title: `Missing on candidate: ${label}`, fp: `form:${fa.name || i}` });
      }
      continue;
    }
    used.add(fb);
    const fieldKey = (/** @type {any} */ f) => f.name || f.id || loose(f.label) || `${f.tag}:${f.type}`;
    const mb = new Map(fb.fields.map((/** @type {any} */ f) => [fieldKey(f), f]));
    for (const f of fa.fields) {
      const g = mb.get(fieldKey(f));
      const fieldLabel = `"${truncate(f.label || f.name || f.type, 40)}"`;
      if (!g) {
        if (f.visible && !["submit", "button", "reset"].includes(f.type)) {
          add({ ...where, severity: "major", category: "forms", type: "forms.field-missing", title: `${label}: field ${fieldLabel} is missing on candidate`, fp: `field:${fieldKey(f)}` });
        }
        continue;
      }
      if (f.required && !g.required) {
        add({
          ...where,
          severity: "major",
          category: "forms",
          type: "forms.validation",
          title: `${label}: field ${fieldLabel} is no longer required`,
          baseline: "required",
          candidate: "optional",
          fp: `req:${fieldKey(f)}`,
        });
      } else if (!f.required && g.required) {
        add({ ...where, severity: "minor", category: "forms", type: "forms.validation", title: `${label}: field ${fieldLabel} is now required`, fp: `req+:${fieldKey(f)}` });
      }
      for (const prop of ["type", "pattern", "maxLength", "min", "max", "autocomplete"]) {
        if ((f[prop] ?? "") !== (g[prop] ?? "")) {
          add({
            ...where,
            severity: prop === "type" ? "minor" : "info",
            category: "forms",
            type: "forms.attribute",
            title: `${label}: field ${fieldLabel} ${prop} changed: "${f[prop]}" → "${g[prop]}"`,
            fp: `${prop}:${fieldKey(f)}`,
          });
        }
      }
    }
  }
}

/**
 * Images that are broken on the candidate but fine on the baseline.
 * @param {any[]} imgsA
 * @param {any[]} imgsB
 * @param {(src: string) => string} norm Normalizes an image URL across environments.
 * @param {{ add: AddFinding, where: { page: string, viewport: string } }} ctx
 */
export function compareImages(imgsA, imgsB, norm, { add, where }) {
  const brokenA = new Set(imgsA.filter((i) => i.broken).map((i) => norm(i.src)));
  const broken = imgsB.filter((i) => i.broken && !brokenA.has(norm(i.src)));
  for (const img of broken.slice(0, 10)) {
    add({
      ...where,
      severity: "major",
      category: "network",
      type: "images.broken",
      title: `Broken image on candidate: ${img.alt ? `"${truncate(img.alt, 40)}" ` : ""}${truncate(img.src.replace("{self}", ""), 90)}`,
      candidate: img.src,
      fp: norm(img.src),
    });
  }
}
