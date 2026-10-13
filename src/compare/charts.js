import { loose } from "../match.js";
import { pairByName } from "./grids.js";
import { truncate } from "../util/misc.js";

/**
 * Charts (Highcharts) compared for what they are made of: the series and
 * their types, the legend, axis titles, a "no data" message. The values
 * plotted are data; they are compared only when both environments hold the
 * same data (`data: same`). What hovering shows is compared by the explorer.
 *
 * @typedef {object} Chart
 * @property {string} name
 * @property {string} title
 * @property {string} subtitle
 * @property {{ name: string, type: string, visible: boolean, points: number }[]} series
 * @property {{ name: string, hidden: boolean, index: number }[]} legend
 * @property {string} xTitle
 * @property {string} yTitle
 * @property {string[]} xLabels
 * @property {number} yLabelCount
 * @property {string} noData
 * @property {boolean} exporting
 * @property {number} domIndex
 */

/**
 * @param {Chart[]} chartsB
 * @param {Chart[]} chartsC
 * @param {{ add: (f: any) => any, where: Record<string, any>, sameData: boolean }} ctx
 */
export function compareCharts(chartsB, chartsC, ctx) {
  const { add, where, sameData } = ctx;
  const { pairs, onlyA, onlyB } = pairByName(chartsB, chartsC);
  for (const ch of onlyA) {
    add({
      ...where,
      severity: "major",
      category: "data",
      type: "chart.missing",
      title: `The "${ch.name}" chart is missing on candidate`,
      baseline: ch.series.map((s) => s.name),
      fp: `chart-missing:${loose(ch.name)}`,
    });
  }
  for (const ch of onlyB) {
    add({ ...where, severity: "info", category: "data", type: "chart.added", title: `Candidate shows a new chart "${ch.name}"`, fp: `chart-added:${loose(ch.name)}` });
  }
  for (const [b, c] of pairs) compareChart(b, c, { add, where, sameData });
}

/**
 * @param {Chart} b
 * @param {Chart} c
 * @param {{ add: (f: any) => any, where: Record<string, any>, sameData: boolean }} ctx
 */
function compareChart(b, c, { add, where, sameData }) {
  const ch = `"${b.name}" chart`;
  const record = (/** @type {any} */ f) => add({ ...where, category: "data", ...f, fp: `chart:${loose(b.name)}|${f.fp}` });

  if (c.noData && !b.noData) {
    record({
      severity: sameData ? "major" : "minor",
      type: "chart.no-data",
      title: `The ${ch} shows "${truncate(c.noData, 40)}" on candidate${sameData ? "" : "; the environments hold different data, so check whether the candidate has any"}`,
      fp: "no-data",
    });
    return;
  }
  if (b.title && c.title && b.title !== c.title && loose(b.title) === loose(c.title)) {
    record({ severity: "minor", type: "chart.title", title: `The ${ch} is titled "${c.title}" on candidate`, fp: "title" });
  }
  const seriesC = new Map(c.series.map((s) => [loose(s.name), s]));
  const missing = [];
  for (const s of b.series) {
    const o = seriesC.get(loose(s.name));
    if (!o) {
      missing.push(s);
      continue;
    }
    seriesC.delete(loose(s.name));
    if (s.type && o.type && s.type !== o.type) {
      record({ severity: "minor", type: "chart.series-type", title: `"${s.name}" is drawn as ${o.type} on candidate, ${s.type} on baseline (${ch})`, fp: `type:${loose(s.name)}` });
    }
    if (s.visible && !o.visible) {
      record({ severity: "minor", type: "chart.series-hidden", title: `"${s.name}" starts hidden on candidate (${ch})`, fp: `hidden:${loose(s.name)}` });
    }
    if (s.points > 0 && o.points === 0 && o.visible) {
      record({
        severity: sameData ? "major" : "minor",
        type: "chart.series-empty",
        title: `"${s.name}" has no points on candidate (baseline: ${s.points}) in the ${ch}`,
        fp: `empty:${loose(s.name)}`,
      });
    } else if (sameData && s.points !== o.points) {
      record({ severity: "minor", type: "chart.points", title: `"${s.name}" has ${o.points} points on candidate, ${s.points} on baseline (${ch})`, fp: `points:${loose(s.name)}` });
    }
  }
  for (const s of missing) {
    record({
      severity: "major",
      type: "chart.series-missing",
      title: `The ${ch} lost its "${s.name}" series on candidate`,
      baseline: b.series.map((x) => x.name),
      candidate: c.series.map((x) => x.name),
      fp: `missing:${loose(s.name)}`,
    });
  }
  for (const s of seriesC.values()) {
    record({ severity: "info", type: "chart.series-added", title: `The ${ch} has a new series "${s.name}" on candidate`, fp: `added:${loose(s.name)}` });
  }
  for (const [axis, x, y] of /** @type {const} */ ([
    ["x", b.xTitle, c.xTitle],
    ["y", b.yTitle, c.yTitle],
  ])) {
    if (x !== y) {
      record({
        severity: "minor",
        type: "chart.axis",
        title: y ? `The ${ch}'s ${axis} axis is titled "${y}" on candidate (baseline: "${x || "none"}")` : `The ${ch}'s ${axis} axis lost its title "${x}" on candidate`,
        fp: `axis:${axis}`,
      });
    }
  }
  if (sameData && b.xLabels.length && c.xLabels.length && b.xLabels.join("|") !== c.xLabels.join("|")) {
    record({
      severity: "minor",
      type: "chart.categories",
      title: `The ${ch} shows different ${"x"}-axis labels on candidate (${truncate(c.xLabels.slice(0, 4).join(", "), 60)} vs ${truncate(b.xLabels.slice(0, 4).join(", "), 60)})`,
      fp: "categories",
    });
  }
  if (b.exporting && !c.exporting) {
    record({ severity: "minor", type: "chart.menu", title: `The ${ch} lost its export menu on candidate`, fp: "menu" });
  }
}

/**
 * What a tooltip says, with the data taken out: numbers become #, so
 * "Jan · Revenue: $12,400" and "Jan · Revenue: $9,870" read the same and
 * "Revenue: 12400" doesn't.
 * @param {string} text
 */
export function tooltipShape(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\d+(?:[.,\s']\d+)*/g, "#");
}
