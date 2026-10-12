import { mergeShapes, compareShapes } from "../shape.js";

/**
 * Accumulates JSON response shapes per endpoint over the whole run, so each
 * endpoint is compared once with everything both environments returned —
 * instead of once per page that happened to call it.
 */
export function createApiTracker() {
  /** @type {Map<string, { baseline?: any, candidate?: any, pages: Set<string>, statuses: { baseline: Set<number>, candidate: Set<number> } }>} */
  const endpoints = new Map();
  return {
    /**
     * @param {"baseline"|"candidate"} side
     * @param {{ key: string, status: number, shape: any }[]} entries
     * @param {string} page
     */
    record(side, entries, page) {
      for (const e of entries) {
        let ep = endpoints.get(e.key);
        if (!ep) {
          ep = { pages: new Set(), statuses: { baseline: new Set(), candidate: new Set() } };
          endpoints.set(e.key, ep);
        }
        ep.pages.add(page);
        ep.statuses[side].add(e.status);
        // Error bodies have their own shape; mixing them in would hide changes.
        if (e.status < 400) ep[side] = mergeShapes(ep[side], e.shape);
      }
    },
    /** @param {(f: any) => any} add */
    compare(add) {
      for (const [key, ep] of endpoints) {
        if (ep.baseline === undefined || ep.candidate === undefined) continue;
        const { missing, added, changed } = compareShapes(ep.baseline, ep.candidate);
        const page = [...ep.pages][0];
        const short = key.replace("{self}", "");
        if (missing.length) {
          add({
            page,
            severity: "major",
            category: "api",
            type: "api.field-missing",
            title: `${short}: candidate response lacks ${missing.length} field${missing.length === 1 ? "" : "s"} (${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""})`,
            detail: `Missing on candidate:\n${missing.slice(0, 50).join("\n")}\n\nSeen on: ${[...ep.pages].slice(0, 5).join(", ")}`,
            baseline: missing,
            fp: `missing:${key}`,
          });
        }
        if (changed.length) {
          add({
            page,
            severity: "major",
            category: "api",
            type: "api.type-changed",
            title: `${short}: field types changed (${changed
              .slice(0, 3)
              .map((c) => `${c.path} ${c.from} → ${c.to}`)
              .join(", ")})`,
            detail: changed.map((c) => `${c.path}: ${c.from} → ${c.to}`).join("\n"),
            baseline: changed.map((c) => `${c.path}: ${c.from}`),
            candidate: changed.map((c) => `${c.path}: ${c.to}`),
            fp: `changed:${key}`,
          });
        }
        if (added.length) {
          add({
            page,
            severity: "info",
            category: "api",
            type: "api.field-added",
            title: `${short}: candidate response has ${added.length} new field${added.length === 1 ? "" : "s"} (${added.slice(0, 4).join(", ")})`,
            fp: `added:${key}`,
          });
        }
      }
    },
    /** For the report: every endpoint seen and what each side returned. */
    summary() {
      return [...endpoints].map(([key, ep]) => ({
        key,
        pages: [...ep.pages].slice(0, 10),
        baseline: [...ep.statuses.baseline],
        candidate: [...ep.statuses.candidate],
      }));
    },
  };
}
