import fs from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const DIFF_COLOR = /** @type {[number, number, number]} */ ([255, 0, 72]);
const MAX_PIXELS = 40_000_000;

/**
 * @typedef {{ x: number, y: number, w: number, h: number, pixels: number }} Region
 * @typedef {object} VisualDiff
 * @property {number} ratio Share of pixels that differ, 0-1.
 * @property {number} diffPixels
 * @property {number} width
 * @property {number} height
 * @property {[number, number]} sizeA
 * @property {[number, number]} sizeB
 * @property {Region[]} regions Clusters of changed pixels, largest first.
 * @property {string} [skipped]
 */

/**
 * Pixel-diff two PNGs of possibly different sizes. The smaller is padded with
 * transparency, so extra height on one side counts as difference.
 * @param {string} fileA
 * @param {string} fileB
 * @param {string | null} outFile Where to write the diff image (only if there is a difference).
 * @param {{ threshold?: number, ignore?: Rect[] }} [opts]
 *   `ignore`: areas not compared (grids and charts showing different data);
 *   drawn hatched in the diff image.
 * @returns {VisualDiff}
 */
export function diffImages(fileA, fileB, outFile, opts = {}) {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  /** @type {VisualDiff} */
  const base = { ratio: 0, diffPixels: 0, width, height, sizeA: [a.width, a.height], sizeB: [b.width, b.height], regions: [] };
  if (width * height > MAX_PIXELS) return { ...base, skipped: `image too large (${width}x${height})` };

  const A = padTo(a, width, height);
  const B = padTo(b, width, height);
  const ignore = clipRects(opts.ignore ?? [], width, height);
  // Make ignored areas identical, so they can't differ.
  for (const r of ignore) {
    for (let y = r.y; y < r.y + r.h; y++) A.copy(B, (y * width + r.x) * 4, (y * width + r.x) * 4, (y * width + r.x + r.w) * 4);
  }
  const out = new PNG({ width, height });
  const n = pixelmatch(A, B, out.data, width, height, {
    threshold: opts.threshold ?? 0.1,
    includeAA: false,
    alpha: 0.12,
    diffColor: DIFF_COLOR,
    aaColor: [200, 200, 200],
  });
  if (n === 0) return base;
  const regions = clusterRegions(out.data, width, height);
  for (const r of ignore) hatch(out.data, width, r);
  if (outFile) fs.writeFileSync(outFile, PNG.sync.write(out));
  return { ...base, ratio: n / (width * height), diffPixels: n, regions };
}

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/** Rectangles cut to the image and rounded to whole pixels. @param {Rect[]} rects @param {number} width @param {number} height */
function clipRects(rects, width, height) {
  /** @type {Rect[]} */
  const out = [];
  for (const r of rects) {
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const x2 = Math.min(width, Math.ceil(r.x + r.w));
    const y2 = Math.min(height, Math.ceil(r.y + r.h));
    if (x2 > x && y2 > y) out.push({ x, y, w: x2 - x, h: y2 - y });
  }
  return out;
}

/** Diagonal grey stripes: "not compared". @param {Buffer | Uint8Array} data @param {number} width @param {Rect} r */
function hatch(data, width, r) {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if ((x + y) % 12 > 1) continue;
      const i = (y * width + x) * 4;
      data[i] = 150;
      data[i + 1] = 160;
      data[i + 2] = 175;
      data[i + 3] = 255;
    }
  }
}

/**
 * @param {PNG} img
 * @param {number} width
 * @param {number} height
 */
function padTo(img, width, height) {
  if (img.width === width && img.height === height) return Buffer.from(img.data);
  const out = Buffer.alloc(width * height * 4, 0);
  for (let y = 0; y < img.height; y++) {
    img.data.copy(out, y * width * 4, y * img.width * 4, (y + 1) * img.width * 4);
  }
  return out;
}

/**
 * Group changed pixels into rectangles: mark a coarse grid, close small gaps,
 * flood-fill connected cells.
 * @param {Buffer | Uint8Array} data RGBA diff image from pixelmatch.
 * @param {number} width
 * @param {number} height
 * @param {number} [cell] Grid cell size in px.
 * @returns {Region[]}
 */
export function clusterRegions(data, width, height, cell = 16) {
  const gw = Math.ceil(width / cell);
  const gh = Math.ceil(height / cell);
  const counts = new Uint32Array(gw * gh);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    const gy = ((y / cell) | 0) * gw;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      if (data[i] === DIFF_COLOR[0] && data[i + 1] === DIFF_COLOR[1] && data[i + 2] === DIFF_COLOR[2]) counts[gy + ((x / cell) | 0)]++;
    }
  }
  // Dilate by one cell so a changed word and its neighbour join one region.
  const marked = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!counts[gy * gw + gx]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          const y = gy + dy;
          if (x >= 0 && y >= 0 && x < gw && y < gh) marked[y * gw + x] = 1;
        }
      }
    }
  }
  /** @type {Region[]} */
  const regions = [];
  const seen = new Uint8Array(gw * gh);
  const stack = new Int32Array(gw * gh);
  for (let start = 0; start < marked.length; start++) {
    if (!marked[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = gw;
    let minY = gh;
    let maxX = 0;
    let maxY = 0;
    let pixels = 0;
    while (sp) {
      const c = stack[--sp];
      const cx = c % gw;
      const cy = (c / gw) | 0;
      // Bounds come from cells with real differences, not the dilation margin.
      if (counts[c]) {
        pixels += counts[c];
        if (cx < minX) minX = cx;
        if (cy < minY) minY = cy;
        if (cx > maxX) maxX = cx;
        if (cy > maxY) maxY = cy;
      }
      const neighbours = [c - 1, c + 1, c - gw, c + gw];
      for (let k = 0; k < 4; k++) {
        const nb = neighbours[k];
        if (nb < 0 || nb >= marked.length || seen[nb] || !marked[nb]) continue;
        if ((k === 0 && cx === 0) || (k === 1 && cx === gw - 1)) continue;
        seen[nb] = 1;
        stack[sp++] = nb;
      }
    }
    if (pixels === 0) continue;
    const x = minX * cell;
    const y = minY * cell;
    regions.push({
      x,
      y,
      w: Math.min(width, (maxX + 1) * cell) - x,
      h: Math.min(height, (maxY + 1) * cell) - y,
      pixels,
    });
  }
  regions.sort((p, q) => q.pixels - p.pixels);
  return regions.slice(0, 12);
}

/**
 * Name the element a changed region is about, so a finding can say "near the
 * 'Subscribe' button" instead of "at y=1180".
 * @param {Region} region
 * @param {any} dom Candidate inventory.
 */
export function describeRegion(region, dom) {
  if (!dom) return `area at y=${region.y}`;
  /** @type {[number, string][]} */
  const hits = [];
  const consider = (/** @type {{x:number,y:number,w:number,h:number}} */ r, /** @type {string} */ label) => {
    const ix = Math.max(0, Math.min(r.x + r.w, region.x + region.w) - Math.max(r.x, region.x));
    const iy = Math.max(0, Math.min(r.y + r.h, region.y + region.h) - Math.max(r.y, region.y));
    const overlap = ix * iy;
    if (overlap <= 0) return;
    // Prefer elements mostly covered by the region, then larger overlaps.
    const elArea = Math.max(1, r.w * r.h);
    hits.push([overlap / elArea + overlap / Math.max(1, region.w * region.h), label]);
  };
  for (const e of dom.actionables ?? []) consider(e.rect, `${e.role} "${trim(e.name)}"`);
  for (const h of dom.headings ?? []) consider(h.rect, `heading "${trim(h.text)}"`);
  for (const i of dom.images ?? []) consider(i.rect, `image ${i.alt ? `"${trim(i.alt)}"` : fileName(i.src)}`);
  hits.sort((p, q) => q[0] - p[0]);
  return hits.length ? `near ${hits[0][1]}` : `area at y=${region.y}`;
}

/** @param {string} s */
const trim = (s) => (String(s ?? "").length > 40 ? String(s).slice(0, 39) + "…" : String(s ?? ""));
/** @param {string} src */
const fileName = (src) => {
  try {
    return new URL(src).pathname.split("/").pop() || src;
  } catch {
    return src;
  }
};

/**
 * Crop and downscale a PNG, e.g. to send a region to a vision model.
 * @param {string} file
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {number} [maxSide]
 * @returns {Buffer}
 */
export function cropPng(file, rect, maxSide = 1200) {
  const src = PNG.sync.read(fs.readFileSync(file));
  const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(rect.x)));
  const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(rect.y)));
  const w = Math.max(1, Math.min(src.width - x0, Math.ceil(rect.w)));
  const h = Math.max(1, Math.min(src.height - y0, Math.ceil(rect.h)));
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const out = new PNG({ width: ow, height: oh });
  // Box filter: average the source pixels each output pixel covers.
  for (let oy = 0; oy < oh; oy++) {
    const sy0 = y0 + Math.floor(oy / scale);
    const sy1 = Math.min(y0 + h, y0 + Math.floor((oy + 1) / scale)) || sy0 + 1;
    for (let ox = 0; ox < ow; ox++) {
      const sx0 = x0 + Math.floor(ox / scale);
      const sx1 = Math.min(x0 + w, x0 + Math.floor((ox + 1) / scale)) || sx0 + 1;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < Math.max(sy1, sy0 + 1); sy++) {
        for (let sx = sx0; sx < Math.max(sx1, sx0 + 1); sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n++;
        }
      }
      const o = (oy * ow + ox) * 4;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = a / n;
    }
  }
  return PNG.sync.write(out);
}
