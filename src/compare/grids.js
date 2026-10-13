import { loose } from "../match.js";
import { truncate } from "../util/misc.js";

/**
 * Data grids (AG Grid, and grids that follow the ARIA grid pattern) compared
 * for what makes them work: which columns there are, in what order, how each
 * column's values are formatted, whether rows arrive at all, whether cells
 * show NaN or undefined. Values themselves are only compared when both
 * environments hold the same data (`data: same`).
 *
 * @typedef {{ id: string, name: string, sort: string | null, sortable: boolean, filtered: boolean, numeric: boolean }} GridColumn
 * @typedef {object} Grid
 * @property {"ag-grid"|"aria-grid"} kind
 * @property {string} name
 * @property {GridColumn[]} columns
 * @property {number} rendered Rows on screen.
 * @property {number | null} total Rows in the grid, all pages.
 * @property {{ current: string, of: string, summary: string } | null} page
 * @property {{ kind: string, text: string } | null} overlay
 * @property {Record<string, string>[]} rows
 * @property {{x:number,y:number,w:number,h:number}} rect
 * @property {string} digest
 */

const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const CURRENCY = /^[-+(]?\s*[$€£¥₹₩₽₺]\s?-?\d[\d,.\s']*\)?$|^[-+(]?\d[\d,.\s']*\s?[$€£¥₹₩₽₺]\)?$|^(USD|EUR|GBP|INR|JPY|AUD|CAD|CHF|CNY)\s?-?\d[\d,.\s']*$|^-?\d[\d,.\s']*\s?(USD|EUR|GBP|INR|JPY|AUD|CAD|CHF|CNY)$/;
const PERCENT = /^[-+(]?\d[\d,.]*\s?%\)?$/;
const NUMBER = /^[-+(]?\d[\d,.\s']*\)?$|^[-+]?\d[\d,.]*\s?[KMBkmb]$/;
const DATE = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2}(:\\d{2})?)?|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}( \\d{1,2}:\\d{2}(:\\d{2})?( ?[AP]M)?)?|${MONTH} \\d{1,2},? \\d{4}|\\d{1,2} ${MONTH},? \\d{4}|${MONTH} \\d{4}|${MONTH}-\\d{2,4})$`,
  "i",
);
/** A cell showing what a broken render shows. */
const ERROR_CELL = /^(NaN|undefined|null|Invalid Date|\[object Object\]|#VALUE!|#N\/A|#REF!|#DIV\/0!|#NAME\?|Infinity|-Infinity|NaN%|\$NaN)$|\bNaN\b|\bundefined\b|\[object Object\]|Invalid Date/;
const BLANK = /^(|-|–|—|n\/a)$/i;

/**
 * What kind of value a cell shows.
 * @param {string} value
 * @returns {"blank"|"error"|"currency"|"percent"|"number"|"date"|"boolean"|"text"}
 */
export function classifyCell(value) {
  const t = String(value ?? "").trim();
  if (BLANK.test(t)) return "blank";
  if (ERROR_CELL.test(t)) return "error";
  if (CURRENCY.test(t)) return "currency";
  if (PERCENT.test(t)) return "percent";
  if (NUMBER.test(t)) return "number";
  if (DATE.test(t)) return "date";
  if (/^(true|false|yes|no)$/i.test(t)) return "boolean";
  return "text";
}

/**
 * Digits after the decimal point, for a number as shown (en-US reading when
 * ambiguous: "1,234" is a thousand, "1.5" one and a half).
 * @param {string} t
 */
export function decimalsOf(t) {
  const d = t.replace(/[^\d.,]/g, "");
  const lastDot = d.lastIndexOf(".");
  const lastComma = d.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) return d.length - Math.max(lastDot, lastComma) - 1;
  const sep = lastDot >= 0 ? "." : lastComma >= 0 ? "," : "";
  if (!sep) return 0;
  if (d.split(sep).length > 2) return 0; // 1,234,567
  const after = d.length - d.lastIndexOf(sep) - 1;
  return sep === "," && after === 3 ? 0 : after;
}

/** @param {string} t */
function magnitude(t) {
  const n = Number(t.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/**
 * How a column's values look, taken over the rows on screen.
 * @param {string[]} values
 */
export function profileColumn(values) {
  /** @type {Record<string, number>} */
  const kinds = {};
  /** @type {Record<string, number>} */
  const decimals = {};
  const errors = [];
  let filled = 0;
  let big = 0;
  let grouped = 0;
  let sample = "";
  for (const v of values) {
    const k = classifyCell(v);
    if (k === "blank") continue;
    filled++;
    kinds[k] = (kinds[k] ?? 0) + 1;
    if (k === "error") errors.push(v);
    if (k === "currency" || k === "percent" || k === "number") {
      sample ||= v;
      const d = decimalsOf(v);
      decimals[d] = (decimals[d] ?? 0) + 1;
      if (magnitude(v) >= 1000) {
        big++;
        if (/\d[,.\s']\d{3}(\D|$)/.test(v)) grouped++;
      }
    } else if (!sample && k !== "error") sample = v;
  }
  const dominant = (/** @type {Record<string, number>} */ counts, /** @type {number} */ of) => {
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top && top[1] / of >= 0.6 ? top[0] : "mixed";
  };
  const numeric = (kinds.currency ?? 0) + (kinds.percent ?? 0) + (kinds.number ?? 0);
  return {
    total: values.length,
    filled,
    kind: filled ? dominant(kinds, filled - (kinds.error ?? 0) || 1) : "blank",
    decimals: numeric ? dominant(decimals, numeric) : null,
    grouped: big ? grouped / big >= 0.5 : null,
    errors: errors.slice(0, 5),
    sample: truncate(sample, 30),
  };
}

const KIND_LABEL = /** @type {Record<string, string>} */ ({
  currency: "amounts",
  percent: "percentages",
  number: "plain numbers",
  date: "dates",
  boolean: "yes/no values",
  text: "text",
  mixed: "mixed values",
});

/**
 * Pair up grids (or charts) across environments: by name first, then by
 * position among those left.
 * @template {{ name: string }} T
 * @param {T[]} a
 * @param {T[]} b
 * @returns {{ pairs: [T, T][], onlyA: T[], onlyB: T[] }}
 */
export function pairByName(a, b) {
  /** @type {[T, T][]} */
  const pairs = [];
  const restB = [...b];
  const restA = [];
  for (const x of a) {
    const i = restB.findIndex((y) => loose(y.name) === loose(x.name));
    if (i >= 0) pairs.push([x, restB.splice(i, 1)[0]]);
    else restA.push(x);
  }
  const onlyA = [];
  for (const x of restA) {
    // Unnamed ("grid 2") or renamed: pair with the next one left on the other side.
    if (restB.length && (/^(grid|chart) \d+$/.test(x.name) || /^(grid|chart) \d+$/.test(restB[0].name))) pairs.push([x, /** @type {T} */ (restB.shift())]);
    else onlyA.push(x);
  }
  return { pairs, onlyA, onlyB: restB };
}

/**
 * @param {Grid[]} gridsB
 * @param {Grid[]} gridsC
 * @param {{ add: (f: any) => any, where: Record<string, any>, sameData: boolean, seen?: Set<string> }} ctx
 */
export function compareGrids(gridsB, gridsC, ctx) {
  const { add, where, sameData } = ctx;
  const { pairs, onlyA, onlyB } = pairByName(gridsB, gridsC);
  for (const g of onlyA) {
    add({
      ...where,
      severity: "major",
      category: "data",
      type: "grid.missing",
      title: `The "${g.name}" grid is missing on candidate`,
      baseline: `${g.columns.length} columns, ${g.total ?? g.rendered} rows`,
      fp: `grid-missing:${loose(g.name)}`,
    });
  }
  for (const g of onlyB) {
    add({ ...where, severity: "info", category: "data", type: "grid.added", title: `Candidate shows a new grid "${g.name}"`, fp: `grid-added:${loose(g.name)}` });
  }
  for (const [b, c] of pairs) compareGrid(b, c, { add, where, sameData });
}

/**
 * @param {Grid} b
 * @param {Grid} c
 * @param {{ add: (f: any) => any, where: Record<string, any>, sameData: boolean }} ctx
 */
function compareGrid(b, c, { add, where, sameData }) {
  const g = `"${b.name}" grid`;
  const fpBase = `grid:${loose(b.name)}`;
  const record = (/** @type {any} */ f) => add({ ...where, category: "data", ...f, fp: `${fpBase}|${f.fp}` });

  // ---- still loading, or no rows --------------------------------------------
  if (c.overlay?.kind === "loading" && b.overlay?.kind !== "loading") {
    record({
      severity: "major",
      type: "grid.loading",
      title: `The ${g} never finishes loading on candidate (still shows "${truncate(c.overlay.text || "Loading", 40)}")`,
      fp: "loading",
    });
    return;
  }
  const rowsB = b.total ?? b.rendered;
  const rowsC = c.total ?? c.rendered;
  if (rowsB > 0 && rowsC === 0 && c.rendered === 0) {
    record({
      severity: sameData ? "major" : "minor",
      type: "grid.empty",
      title: `The ${g} shows no rows on candidate (baseline: ${rowsB})${sameData ? "" : "; the environments hold different data, so check whether the candidate has any"}`,
      baseline: rowsB,
      candidate: c.overlay?.text || 0,
      fp: "empty",
    });
  } else if (sameData && b.total != null && c.total != null && b.total !== c.total) {
    record({ severity: "minor", type: "grid.row-count", title: `The ${g} has ${c.total} rows on candidate, ${b.total} on baseline`, baseline: b.total, candidate: c.total, fp: "rows" });
  }

  // ---- columns -----------------------------------------------------------------
  const key = (/** @type {GridColumn} */ col) => col.id || loose(col.name);
  const byKeyC = new Map(c.columns.map((col) => [key(col), col]));
  const byNameC = new Map(c.columns.map((col) => [loose(col.name), col]));
  /** @type {[GridColumn, GridColumn][]} */
  const common = [];
  const missing = [];
  for (const col of b.columns) {
    const other = byKeyC.get(key(col)) ?? (col.name ? byNameC.get(loose(col.name)) : undefined);
    if (other) common.push([col, other]);
    else missing.push(col);
  }
  const matchedC = new Set(common.map(([, o]) => o));
  const added = c.columns.filter((col) => !matchedC.has(col));
  for (const col of missing) {
    record({
      severity: "major",
      type: "grid.column-missing",
      title: `Column "${col.name || col.id}" is missing from the ${g} on candidate`,
      baseline: b.columns.map((x) => x.name || x.id),
      candidate: c.columns.map((x) => x.name || x.id),
      fp: `missing:${key(col)}`,
    });
  }
  for (const col of added) {
    record({ severity: "info", type: "grid.column-added", title: `Candidate adds column "${col.name || col.id}" to the ${g}`, fp: `added:${key(col)}` });
  }
  for (const [x, y] of common) {
    if (x.name && y.name && loose(x.name) !== loose(y.name)) {
      record({ severity: "minor", type: "grid.column-renamed", title: `Column "${x.name}" is called "${y.name}" on candidate (${g})`, baseline: x.name, candidate: y.name, fp: `renamed:${key(x)}` });
    }
  }
  const orderB = common.map(([x]) => key(x));
  const orderC = c.columns.filter((col) => matchedC.has(col)).map((col) => key(common.find(([, o]) => o === col)?.[0] ?? col));
  if (orderB.join("|") !== orderC.join("|")) {
    record({
      severity: "minor",
      type: "grid.column-order",
      title: `Columns of the ${g} are in a different order on candidate`,
      baseline: common.map(([x]) => x.name || x.id),
      candidate: c.columns.filter((col) => matchedC.has(col)).map((col) => col.name || col.id),
      fp: "order",
    });
  }
  for (const [x, y] of common) {
    if (x.sort && !y.sort) {
      record({ severity: "minor", type: "grid.sort", title: `The ${g} is no longer sorted by "${x.name}" (${x.sort}) on candidate`, fp: `sort:${key(x)}` });
    }
  }
  if (b.page && !c.page && rowsC > c.rendered) {
    record({ severity: "minor", type: "grid.paging", title: `The ${g} lost its paging controls on candidate`, fp: "paging" });
  }

  // ---- how each column's values look ---------------------------------------------
  if (!b.rows.length || !c.rows.length) return;
  for (const [x, y] of common) {
    const pb = profileColumn(b.rows.map((r) => r[x.id] ?? ""));
    const pc = profileColumn(c.rows.map((r) => r[y.id] ?? ""));
    const name = `"${x.name || x.id}"`;
    if (pc.errors.length && !pb.errors.length) {
      record({
        severity: "major",
        type: "grid.cell-errors",
        title: `${name} column of the ${g} shows ${truncate(pc.errors[0], 30)} on candidate (${pc.errors.length} of ${pc.total} cells on screen)`,
        candidate: pc.errors,
        fp: `errors:${key(x)}`,
      });
      continue;
    }
    if (pb.filled >= Math.max(2, pb.total * 0.5) && pc.filled === 0 && pc.total > 0) {
      record({
        severity: "major",
        type: "grid.column-empty",
        title: `${name} column of the ${g} is empty on candidate (baseline shows values such as ${pb.sample})`,
        fp: `empty:${key(x)}`,
      });
      continue;
    }
    if (pb.filled < 2 || pc.filled < 2) continue;
    if (pb.kind !== pc.kind && pb.kind !== "mixed" && pc.kind !== "mixed") {
      const lostSpecial = ["currency", "percent", "date"].includes(pb.kind);
      record({
        severity: lostSpecial ? "major" : "minor",
        type: "grid.format",
        title: `${name} column of the ${g} shows ${KIND_LABEL[pc.kind] ?? pc.kind} on candidate instead of ${KIND_LABEL[pb.kind] ?? pb.kind} (${pc.sample} vs ${pb.sample})`,
        baseline: pb.sample,
        candidate: pc.sample,
        fp: `format:${key(x)}`,
      });
      continue;
    }
    if (pb.kind === pc.kind && pb.decimals != null && pc.decimals != null && pb.decimals !== "mixed" && pc.decimals !== "mixed" && pb.decimals !== pc.decimals) {
      record({
        severity: "minor",
        type: "grid.format",
        title: `${name} column of the ${g} shows ${pc.decimals} decimal place${pc.decimals === "1" ? "" : "s"} on candidate, ${pb.decimals} on baseline (${pc.sample} vs ${pb.sample})`,
        baseline: pb.sample,
        candidate: pc.sample,
        fp: `decimals:${key(x)}`,
      });
    } else if (pb.grouped != null && pc.grouped != null && pb.grouped !== pc.grouped) {
      record({
        severity: "minor",
        type: "grid.format",
        title: `${name} column of the ${g} ${pc.grouped ? "now groups" : "no longer groups"} thousands on candidate (${pc.sample} vs ${pb.sample})`,
        baseline: pb.sample,
        candidate: pc.sample,
        fp: `grouping:${key(x)}`,
      });
    }
  }

  // ---- the values themselves, when both sides hold the same data -------------------
  if (sameData) {
    const diffs = [];
    const n = Math.min(b.rows.length, c.rows.length, 20);
    for (let i = 0; i < n; i++) {
      for (const [x, y] of common) {
        const vb = b.rows[i][x.id] ?? "";
        const vc = c.rows[i][y.id] ?? "";
        if (vb !== vc) diffs.push(`row ${i + 1} ${x.name || x.id}: "${truncate(vb, 30)}" → "${truncate(vc, 30)}"`);
      }
    }
    if (diffs.length) {
      record({
        severity: "minor",
        type: "grid.values",
        title: `${diffs.length} cell${diffs.length === 1 ? "" : "s"} of the ${g} differ on candidate (${diffs[0]})`,
        detail: diffs.slice(0, 10).join("\n"),
        fp: "values",
      });
    }
  }
}
