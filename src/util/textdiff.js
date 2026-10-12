/**
 * Line diffing and string similarity, with no dependencies.
 */

/**
 * @typedef {{ op: "=" | "-" | "+", text: string }} DiffOp
 */

/**
 * Myers O(ND) diff over two arrays of strings. Falls back to an unordered
 * multiset comparison when the inputs are huge or wildly different, because a
 * precise ordering is worthless when nothing lines up anyway.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @param {{ maxD?: number, maxLines?: number }} [opts]
 * @returns {DiffOp[]}
 */
export function diffLines(a, b, opts = {}) {
  const maxD = opts.maxD ?? 1500;
  const maxLines = opts.maxLines ?? 8000;

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  /** @type {DiffOp[]} */
  const head = a.slice(0, start).map((text) => ({ op: "=", text }));
  /** @type {DiffOp[]} */
  const tail = a.slice(endA).map((text) => ({ op: "=", text }));
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);

  /** @type {DiffOp[] | null} */
  let middle;
  if (A.length === 0) middle = B.map((text) => ({ op: "+", text }));
  else if (B.length === 0) middle = A.map((text) => ({ op: "-", text }));
  else if (A.length + B.length > maxLines) middle = null;
  else middle = myers(A, B, maxD);

  if (!middle) middle = multisetDiff(A, B);
  return [...head, ...middle, ...tail];
}

/**
 * @param {string[]} A
 * @param {string[]} B
 * @param {number} maxD
 * @returns {DiffOp[] | null}
 */
function myers(A, B, maxD) {
  const N = A.length;
  const M = B.length;
  const MAX = N + M;
  const offset = MAX + 1;
  const v = new Int32Array(2 * MAX + 3);
  /** @type {{ base: number, data: Int32Array }[]} */
  const trace = [];
  let found = -1;

  outer: for (let d = 0; d <= MAX; d++) {
    if (d > maxD) return null;
    // Only diagonals -d-1..d+1 can be read while backtracking from step d.
    trace.push({ base: offset - d - 1, data: v.slice(offset - d - 1, offset + d + 2) });
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;

  /** @type {DiffOp[]} */
  const ops = [];
  let x = N;
  let y = M;
  for (let d = found; d >= 0; d--) {
    const { base, data } = trace[d];
    const at = (/** @type {number} */ k) => data[offset + k - base];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: "=", text: A[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: "+", text: B[y - 1] });
      else ops.push({ op: "-", text: A[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/**
 * Order-insensitive fallback: what was removed and what was added, by count.
 * @param {string[]} A
 * @param {string[]} B
 * @returns {DiffOp[]}
 */
function multisetDiff(A, B) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const s of B) counts.set(s, (counts.get(s) ?? 0) + 1);
  /** @type {DiffOp[]} */
  const ops = [];
  for (const s of A) {
    const n = counts.get(s) ?? 0;
    if (n > 0) {
      counts.set(s, n - 1);
      ops.push({ op: "=", text: s });
    } else ops.push({ op: "-", text: s });
  }
  const remaining = new Map(counts);
  for (const s of B) {
    const n = remaining.get(s) ?? 0;
    if (n > 0) {
      remaining.set(s, n - 1);
      ops.push({ op: "+", text: s });
    }
  }
  return ops;
}

/**
 * Collapse a diff into hunks with a little context, for display.
 * @param {DiffOp[]} ops
 * @param {number} [context]
 * @param {number} [maxLines]
 * @returns {{ lines: (DiffOp | { op: "…", text: string })[], removed: number, added: number }}
 */
export function summarizeDiff(ops, context = 1, maxLines = 60) {
  const removed = ops.filter((o) => o.op === "-").length;
  const added = ops.filter((o) => o.op === "+").length;
  /** @type {Set<number>} */
  const keep = new Set();
  ops.forEach((o, i) => {
    if (o.op !== "=") for (let j = i - context; j <= i + context; j++) keep.add(j);
  });
  /** @type {(DiffOp | { op: "…", text: string })[]} */
  const lines = [];
  let gap = false;
  for (let i = 0; i < ops.length; i++) {
    if (!keep.has(i)) {
      gap = true;
      continue;
    }
    if (gap && lines.length) lines.push({ op: "…", text: "" });
    gap = false;
    lines.push(ops[i]);
    if (lines.length >= maxLines) {
      lines.push({ op: "…", text: `${ops.length - i - 1} more lines not shown` });
      break;
    }
  }
  return { lines, removed, added };
}

/** Levenshtein similarity in [0, 1]. */
export function similarity(/** @type {string} */ a, /** @type {string} */ b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  if (a.length > 200 || b.length > 200) {
    a = a.slice(0, 200);
    b = b.slice(0, 200);
  }
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
