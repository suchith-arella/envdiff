/* global window, document, performance, getComputedStyle, PerformanceObserver, CSS, Node, scrollX, scrollY, innerWidth, innerHeight */
/**
 * Code that runs inside the page. Every function here is serialized by
 * Playwright and evaluated in the browser, so each must be self-contained:
 * no imports, no references to anything outside its own body.
 */

/**
 * Installed with addInitScript before any page script runs. Tracks when the
 * DOM last changed and when the page last scrolled, so we can tell when a
 * page has stopped rendering.
 * @param {{ ignoreMutations: string[] }} opts
 */
export function initScript(opts) {
  const w = /** @type {any} */ (window);
  if (w.__envdiffInit) return;
  w.__envdiffInit = true;
  /** @type {any} */
  const state = (w.__envdiff = w.__envdiff || {});
  state.lastMutation = performance.now();
  state.lastScroll = -1e9;
  state.lastBusy = -1e9;
  // Long tasks: the page is still computing (an app booting after its
  // network calls finished) even though nothing visible is happening yet.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) state.lastBusy = Math.max(state.lastBusy, e.startTime + e.duration);
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // not supported (Firefox, WebKit)
  }
  // Vertical scrolling of the window or of a pane that fills much of it (apps
  // that scroll a main container). Smooth scrolls to a section take a while,
  // and sticky headers, scrollspy and reveal animations follow along.
  // Sideways carousels don't count.
  /** @type {WeakMap<object, number>} */
  const tops = new WeakMap();
  addEventListener(
    "scroll",
    (e) => {
      const t = /** @type {any} */ (e.target);
      const isDoc = t === document || t === document.documentElement || t === document.body;
      if (!isDoc && !(t && t.clientHeight >= innerHeight * 0.5)) return;
      const top = isDoc ? scrollY : t.scrollTop;
      if (tops.get(t) === top) return;
      tops.set(t, top);
      state.lastScroll = performance.now();
    },
    { capture: true, passive: true },
  );
  const ignore = (opts && opts.ignoreMutations) || [];
  const ignored = (/** @type {Node} */ node) => {
    const el = node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement;
    if (!el || !ignore.length) return false;
    return ignore.some((/** @type {string} */ s) => {
      try {
        return !!el.closest(s);
      } catch {
        return false;
      }
    });
  };
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (ignored(r.target)) continue;
      state.lastMutation = performance.now();
      return;
    }
  });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}

/** Milliseconds since the DOM last changed, the page last scrolled or its main thread was last busy. */
export function msSinceChange() {
  const s = /** @type {any} */ (window).__envdiff;
  if (!s) return 1e9;
  const now = performance.now();
  return Math.min(now - (s.lastMutation ?? -1e9), now - (s.lastScroll ?? -1e9), now - (s.lastBusy ?? -1e9));
}

/**
 * A loading indicator on screen: a grid's "Loading…" overlay, a chart's
 * loading label, a spinner, an element marked aria-busy. Apps often finish
 * their requests and then take a moment more to fill a grid; the page is
 * still busy until the indicator goes.
 * @param {string[]} selectors
 * @returns {string} The first visible one, or "".
 */
export function busyIndicator(selectors) {
  for (const sel of selectors) {
    let found;
    try {
      found = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of Array.from(found).slice(0, 50)) {
      if (el.closest(".ag-hidden,[hidden]")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const anyEl = /** @type {any} */ (el);
      if (typeof anyEl.checkVisibility === "function" && !anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      return sel;
    }
  }
  return "";
}

/**
 * What the page shows, cheaply: scroll position, height, address and a hash
 * of the text with digits blanked (clocks and counters tick). Equal before and
 * after a capture means the page held still while we captured it.
 */
export function pageFingerprint() {
  const de = document.documentElement;
  const body = document.body;
  const text = (body ? body.innerText : "").replace(/\d+/g, "#");
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  const height = Math.max(de.scrollHeight, body ? body.scrollHeight : 0);
  return `${Math.round(scrollX)},${Math.round(scrollY)}|${height}|${location.href}|${text.length}:${h}`;
}

/**
 * Jump running CSS transitions and animations to their end, as screenshots do
 * (animations: "disabled"). Otherwise a section caught fading in reads as
 * invisible, or a card mid-slide as moved, in the inventory while the
 * screenshot shows it finished. Endless animations are left alone.
 */
export function finishAnimations() {
  if (typeof document.getAnimations !== "function") return 0;
  let finished = 0;
  for (const a of document.getAnimations()) {
    try {
      if (a.playState !== "running" || !a.effect || a.effect.getComputedTiming().endTime === Infinity) continue;
      a.finish();
      finished++;
    } catch {
      // detached or already done
    }
  }
  return finished;
}

/** Load timing as the browser recorded it. */
export function readPerf() {
  const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType("navigation")[0]);
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const buffered = (/** @type {string} */ type) => {
    try {
      const po = new PerformanceObserver(() => {});
      po.observe({ type, buffered: true });
      const entries = po.takeRecords();
      po.disconnect();
      return entries;
    } catch {
      return [];
    }
  };
  const lcpEntries = buffered("largest-contentful-paint");
  const shifts = buffered("layout-shift");
  const resources = /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByType("resource"));
  return {
    ttfb: nav ? Math.round(nav.responseStart - nav.startTime) : null,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
    load: nav && nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd - nav.startTime) : null,
    fcp: fcp ? Math.round(fcp.startTime) : null,
    lcp: lcpEntries.length ? Math.round(lcpEntries[lcpEntries.length - 1].startTime) : null,
    cls: Math.round(shifts.reduce((sum, e) => sum + (/** @type {any} */ (e).hadRecentInput ? 0 : /** @type {any} */ (e).value), 0) * 1000) / 1000,
    requests: resources.length + 1,
    transferKB: Math.round((resources.reduce((s, r) => s + (r.transferSize || 0), 0) + (nav ? nav.transferSize || 0 : 0)) / 1024),
  };
}

/**
 * Inventory the page: actionable elements, headings, images, forms, links,
 * visible text, metadata and timing. Element references are kept in
 * window.__envdiff.els so the explorer can click them by index later.
 *
 * @param {{
 *   maskSelectors?: string[],
 *   ignoreSelectors?: string[],
 *   skipSelectors?: string[],
 *   allowSelectors?: string[],
 *   maxActionables?: number,
 *   maxTextLines?: number,
 *   census?: boolean,
 * }} opts `census`: only note which controls are visible right now, for pages
 *   that show a section only while it is on screen. A control noted while
 *   scrolling through counts as visible later, wherever the page is scrolled.
 */
export async function collectPage(opts) {
  const w = /** @type {any} */ (window);
  /** @type {any} */
  const state = (w.__envdiff = w.__envdiff || {});
  /** @type {Element[]} */
  const els = [];
  if (!opts.census) state.els = els;

  const maskSelectors = opts.maskSelectors || [];
  const ignoreSelectors = opts.ignoreSelectors || [];
  const skipSelectors = opts.skipSelectors || [];
  const allowSelectors = opts.allowSelectors || [];
  const maxActionables = opts.maxActionables || 600;
  const maxTextLines = opts.maxTextLines || 4000;

  const norm = (/** @type {any} */ s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const cut = (/** @type {string} */ s, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const closestAny = (/** @type {Element} */ el, /** @type {string[]} */ sels) =>
    sels.some((s) => {
      try {
        return !!el.closest(s);
      } catch {
        return false;
      }
    });

  const docW = Math.max(document.documentElement.scrollWidth, innerWidth);
  const isVisible = (/** @type {Element} */ el) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const anyEl = /** @type {any} */ (el);
    if (typeof anyEl.checkVisibility === "function") {
      if (
        !anyEl.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
          checkOpacity: true,
          checkVisibilityCSS: true,
        })
      )
        return false;
    } else {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    }
    if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0 || r.left + scrollX >= docW) return false;
    return true;
  };
  const rectOf = (/** @type {Element} */ el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const textOf = (/** @type {Element} */ el) => norm(/** @type {HTMLElement} */ (el).innerText ?? el.textContent);

  const implicitRole = (/** @type {Element} */ el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    switch (tag) {
      case "a":
      case "area":
        return el.hasAttribute("href") ? "link" : "";
      case "button":
      case "summary":
        return "button";
      case "select":
        return /** @type {HTMLSelectElement} */ (el).multiple || /** @type {HTMLSelectElement} */ (el).size > 1 ? "listbox" : "combobox";
      case "textarea":
        return "textbox";
      case "input":
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "search") return "searchbox";
        if (type === "number") return "spinbutton";
        if (type === "file") return "file";
        return "textbox";
      case "img":
        return "img";
      default:
        return "";
    }
  };
  const roleOf = (/** @type {Element} */ el) => {
    if (el.classList.contains("highcharts-legend-item")) return "legend item";
    if (el.classList.contains("highcharts-contextbutton")) return "chart menu";
    if (el.classList.contains("ag-header-cell")) return "column header";
    return (el.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase() || implicitRole(el) || "clickable";
  };

  const accName = (/** @type {Element} */ el) => {
    const aria = norm(el.getAttribute("aria-label"));
    if (aria) return aria;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = norm(
        labelledby
          .split(/\s+/)
          .map((id) => {
            const ref = document.getElementById(id);
            return ref ? /** @type {HTMLElement} */ (ref).innerText || ref.textContent || "" : "";
          })
          .join(" "),
      );
      if (t) return t;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const input = /** @type {HTMLInputElement} */ (el);
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) {
        return norm(input.value) || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
      }
      if (type === "image") return norm(el.getAttribute("alt")) || "Submit";
      if (input.labels && input.labels.length) {
        const t = norm(Array.from(input.labels).map((l) => l.innerText || l.textContent).join(" "));
        if (t) return t;
      }
      return norm(el.getAttribute("placeholder")) || norm(el.getAttribute("title")) || norm(el.getAttribute("name"));
    }
    if (tag === "img") return norm(el.getAttribute("alt")) || norm(el.getAttribute("title"));
    const t = textOf(el);
    if (t) return t;
    const img = el.querySelector("img[alt]");
    if (img && norm(img.getAttribute("alt"))) return norm(img.getAttribute("alt"));
    const svgTitle = el.querySelector("svg title");
    if (svgTitle) return norm(svgTitle.textContent);
    return norm(el.getAttribute("title"));
  };

  const LANDMARKS =
    "header,nav,main,footer,aside,form,dialog,[role=banner],[role=navigation],[role=main],[role=contentinfo],[role=complementary],[role=form],[role=dialog],[role=alertdialog],[role=search],[role=menu],[role=menubar],[role=tablist],[role=toolbar]";
  /** @type {Record<string,string>} */
  const TAG_ROLE = { header: "banner", nav: "navigation", main: "main", footer: "contentinfo", aside: "complementary", form: "form", dialog: "dialog" };
  const landmarkOf = (/** @type {Element} */ el) => {
    const lm = el.parentElement && el.parentElement.closest(LANDMARKS);
    if (!lm) return "body";
    const role = (lm.getAttribute("role") || TAG_ROLE[lm.tagName.toLowerCase()] || lm.tagName.toLowerCase()).toLowerCase();
    const label = norm(lm.getAttribute("aria-label")).toLowerCase();
    return label ? `${role}:${cut(label, 30)}` : role;
  };

  const headingEls = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]"));
  const headingBefore = (/** @type {Element} */ el) => {
    let lo = 0;
    let hi = headingEls.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const h = headingEls[mid];
      if (h === el || h.contains(el) || h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 ? cut(textOf(headingEls[ans]), 60) : "";
  };

  const TEST_ATTRS = ["data-testid", "data-test", "data-test-id", "data-cy", "data-qa", "data-automation-id"];
  const testIdOf = (/** @type {Element} */ el) => {
    for (const a of TEST_ATTRS) {
      const v = el.getAttribute(a);
      if (v) return `${a}=${v}`;
    }
    return "";
  };
  // Generated ids (React's :r1:, ember123, radix-…, hashes) differ between builds.
  const stableId = (/** @type {string} */ id) =>
    id &&
    !/[:\s]/.test(id) &&
    !/^\d/.test(id) &&
    !/\d{3,}/.test(id) &&
    !/[a-f0-9]{8,}/i.test(id) &&
    !/^(ember|react|radix|headlessui|mui|rc-|downshift|uid|id-|el-|ext-|yui_|gwt-|j_id|__|vs-|v-|ng-|cdk-|mat-|chakra|mantine)/i.test(id) &&
    !(/[a-z]/.test(id) && /[A-Z]/.test(id) && /\d/.test(id) && id.length >= 8)
      ? id
      : "";
  const stableClass = (/** @type {string} */ c) =>
    /^[a-z][a-z0-9-]*$/.test(c) && c.length <= 30 && !/^(css|sc|jsx|emotion|styled|svelte|astro)-/.test(c) && !/\d{3,}/.test(c);
  const esc = (/** @type {string} */ s) => (w.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
  const cssPath = (/** @type {Element} */ el) => {
    /** @type {string[]} */
    const parts = [];
    /** @type {Element | null} */
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 5; depth++) {
      const tag = cur.tagName.toLowerCase();
      for (const a of TEST_ATTRS) {
        const v = cur.getAttribute(a);
        if (v) {
          parts.unshift(`[${a}="${v.replace(/"/g, '\\"')}"]`);
          return parts.join(" > ");
        }
      }
      const id = stableId(cur.id);
      if (id) {
        parts.unshift(`#${esc(id)}`);
        return parts.join(" > ");
      }
      let sel = tag;
      const cls = Array.from(cur.classList).filter(stableClass).slice(0, 2);
      if (cls.length) sel += cls.map((c) => "." + esc(c)).join("");
      const parent = /** @type {Element | null} */ (cur.parentElement);
      if (parent) {
        const curTag = cur.tagName;
        const same = Array.from(parent.children).filter((c) => c.tagName === curTag);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      if (tag === "body") break;
      cur = parent;
    }
    return parts.join(" > ");
  };

  const STYLE_PROPS = [
    "color",
    "backgroundColor",
    "fontSize",
    "fontWeight",
    "fontFamily",
    "textDecorationLine",
    "borderTopWidth",
    "borderTopColor",
    "borderRadius",
    // Not opacity: it is what fades, reveals and scroll-linked effects
    // animate, so its value depends on the moment. The screenshot shows it.
  ];
  const stylesOf = (/** @type {Element} */ el) => {
    const cs = /** @type {any} */ (getComputedStyle(el));
    /** @type {Record<string,string>} */
    const out = {};
    for (const p of STYLE_PROPS) {
      let v = String(cs[p] || "");
      if (p === "fontFamily") v = v.split(",")[0].replace(/["']/g, "").trim();
      out[p] = v;
    }
    return out;
  };

  const ignored = (/** @type {Element} */ el) => ignoreSelectors.length > 0 && closestAny(el, ignoreSelectors);

  // ---- actionable elements --------------------------------------------------
  const ACTION_SEL =
    'a[href],area[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=switch],[role=checkbox],[role=radio],[role=combobox],[role=treeitem],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable="true"]';
  /** @type {Set<Element>} */
  const candidates = new Set(document.querySelectorAll(ACTION_SEL));
  // Plain elements with click handlers can only be found by the pointer cursor
  // their CSS gives them. Take the outermost such element, and only when it is
  // not already inside or around a real control.
  const pointerScan = document.body
    ? document.body.querySelectorAll("div,span,li,img,svg,i,p,td,tr,section,article,h1,h2,h3,h4,h5,h6,figure,dt,dd")
    : [];
  let scanned = 0;
  for (const el of Array.from(pointerScan)) {
    if (++scanned > 8000) break;
    if (candidates.has(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.cursor !== "pointer") continue;
    const parent = el.parentElement;
    if (parent && getComputedStyle(parent).cursor === "pointer") continue;
    if (el.closest(ACTION_SEL) || el.querySelector(ACTION_SEL)) continue;
    candidates.add(el);
  }

  // Grids and charts have controls of their own that look like nothing to
  // the scan above, and internals that look like controls but aren't.
  //  - a grid's column headers sort when clicked; sortable or not, both
  //    environments get the same control, and clicking tells them apart
  //  - a chart's legend items show and hide series; its points and trackers
  //    are hovered, not clicked (see chartPoints)
  //  - a grid with hundreds of rows gets two of them clicked, not all
  const GRID_ROOTS = ".ag-root-wrapper,[role=grid],[role=treegrid]";
  const CHART_ROOTS = ".highcharts-container";
  for (const el of Array.from(candidates)) {
    if (el.closest(CHART_ROOTS) || el.closest(".ag-header,.ag-header-cell,.ag-header-group-cell,.ag-floating-filter")) candidates.delete(el);
  }
  for (const h of Array.from(document.querySelectorAll(".ag-root-wrapper .ag-header-cell[col-id]"))) {
    if (!h.classList.contains("ag-floating-filter")) candidates.add(h);
  }
  for (const c of Array.from(document.querySelectorAll(CHART_ROOTS)).slice(0, 30)) {
    for (const li of Array.from(c.querySelectorAll(".highcharts-legend-item"))) candidates.add(li);
    const menu = c.querySelector(".highcharts-contextbutton");
    if (menu) candidates.add(menu);
  }
  /** @type {Map<Element, Set<string>>} The first two data rows of each grid. */
  const sampledRows = new Map();
  const rowIndexOf = (/** @type {Element} */ row) => row.getAttribute("row-index") ?? row.getAttribute("aria-rowindex") ?? "";
  const dataRowOf = (/** @type {Element} */ el) => {
    const row = el.closest(".ag-row[row-index],[role=row]");
    if (!row || row.closest(".ag-header,thead") || row.querySelector("[role=columnheader]")) return null;
    const grid = row.closest(GRID_ROOTS);
    return grid ? { grid: grid.closest(".ag-root-wrapper") || grid, index: rowIndexOf(row) } : null;
  };
  const gridOrdinal = (/** @type {Element} */ g) => Array.from(document.querySelectorAll(".ag-root-wrapper,[role=grid],[role=treegrid]")).filter((x) => !(x.parentElement && x.parentElement.closest(".ag-root-wrapper"))).indexOf(g);
  /**
   * Where a control in a grid row sits — grid, row, column — so the same
   * cell matches across environments whatever data it shows.
   * @param {Element} el
   */
  const dataRowKey = (el) => {
    const r = dataRowOf(el);
    if (!r) return "";
    const keep = sampledRows.get(r.grid);
    const rank = keep ? Array.from(keep).indexOf(r.index) : -1;
    const cell = el.closest(".ag-cell[col-id],[role=gridcell],[role=cell]");
    const col = cell ? cell.getAttribute("col-id") || cell.getAttribute("data-field") || cell.getAttribute("aria-colindex") || "" : "";
    return `${gridOrdinal(r.grid)}:${rank}:${col}:${el.tagName.toLowerCase()}`;
  };
  for (const el of Array.from(candidates)) {
    const r = dataRowOf(el);
    if (!r) continue;
    let keep = sampledRows.get(r.grid);
    if (!keep) {
      const indexes = Array.from(r.grid.querySelectorAll(".ag-row[row-index],[role=row]"))
        .filter((row) => !row.closest(".ag-header,thead") && !row.querySelector("[role=columnheader]"))
        .map(rowIndexOf)
        .filter((i) => /^\d+$/.test(i))
        .map(Number)
        .sort((a, b) => a - b);
      keep = new Set(Array.from(new Set(indexes)).slice(0, 2).map(String));
      sampledRows.set(r.grid, keep);
    }
    if (!keep.has(r.index)) candidates.delete(el);
  }

  /** How a control looks now, for the inventory. @param {Element} el */
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = roleOf(el);
    const anyEl = /** @type {any} */ (el);
    const type = (el.getAttribute("type") || "").toLowerCase();
    let kind = "other";
    if (role === "link") kind = "link";
    else if (tag === "select" || role === "combobox" || role === "listbox") kind = tag === "select" ? "select" : "button";
    else if (["textbox", "searchbox", "spinbutton", "slider"].includes(role) || el.hasAttribute("contenteditable")) kind = "input";
    else if (role === "file") kind = "file";
    else if (["checkbox", "radio", "switch"].includes(role)) kind = "toggle";
    else kind = "button";
    /** @type {any} */
    const item = {
      tag,
      role,
      kind,
      name: cut(accName(el), 120),
      type,
      href: tag === "a" || tag === "area" ? String(anyEl.href || "") : "",
      target: el.getAttribute("target") || "",
      testId: testIdOf(el),
      id: stableId(el.id),
      nameAttr: el.getAttribute("name") || "",
      landmark: landmarkOf(el),
      heading: headingBefore(el),
      rect: rectOf(el),
      disabled: anyEl.disabled === true || el.getAttribute("aria-disabled") === "true",
      expanded: el.getAttribute("aria-expanded"),
      checked: typeof anyEl.checked === "boolean" && (type === "checkbox" || type === "radio") ? anyEl.checked : el.getAttribute("aria-checked"),
      selected: el.getAttribute("aria-selected"),
      // A column header's sort order; a toggle button's or legend item's on/off.
      sort: el.getAttribute("aria-sort"),
      pressed: el.classList.contains("highcharts-legend-item") ? String(!el.classList.contains("highcharts-legend-item-hidden")) : el.getAttribute("aria-pressed"),
      haspopup: el.getAttribute("aria-haspopup"),
      inDialog: !!el.closest("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]"),
      // Inside a grid or chart: compared by the grid and chart checks, not as a control.
      inData: !!el.closest(`${GRID_ROOTS},${CHART_ROOTS}`),
      dataRow: dataRowKey(el),
      cssPath: cssPath(el),
      styles: stylesOf(el),
      skip: skipSelectors.length > 0 && closestAny(el, skipSelectors),
      allow: allowSelectors.length > 0 && closestAny(el, allowSelectors),
    };
    if (tag === "select") {
      const sel = /** @type {HTMLSelectElement} */ (el);
      item.value = sel.selectedOptions && sel.selectedOptions[0] ? norm(sel.selectedOptions[0].textContent) : "";
      item.options = Array.from(sel.options)
        .slice(0, 30)
        .map((o) => ({ text: cut(norm(o.textContent), 60), value: o.value, disabled: o.disabled }));
    }
    return item;
  };

  /** @type {WeakMap<Element, any>} Controls as they looked when last seen on screen. */
  const seen = (state.seen = state.seen || new WeakMap());
  if (opts.census) {
    for (const el of candidates) if (!ignored(el) && isVisible(el)) seen.set(el, describe(el));
    return /** @type {never} */ (undefined);
  }
  // Seen while scrolling through, but hidden again now that it is off screen:
  // keep it as it looked then.
  const seenWhileScrolling = (/** @type {Element} */ el) => {
    if (!seen.has(el) || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    const anyEl = /** @type {any} */ (el);
    if (r.width < 1 || r.height < 1 || (typeof anyEl.checkVisibility === "function" && !anyEl.checkVisibility())) return null;
    return { ...seen.get(el), rect: rectOf(el) };
  };

  const actionables = [];
  for (const el of candidates) {
    if (actionables.length >= maxActionables) break;
    if (ignored(el)) continue;
    if (el.closest("[aria-hidden=true],[inert]")) continue;
    const item = isVisible(el) ? describe(el) : seenWhileScrolling(el);
    if (!item) continue;
    item.idx = els.length;
    els.push(el);
    actionables.push(item);
  }

  // ---- headings, images, forms, links -----------------------------------
  const headings = [];
  for (const h of headingEls.slice(0, 300)) {
    if (ignored(h) || !isVisible(h)) continue;
    const level = /^h[1-6]$/i.test(h.tagName) ? Number(h.tagName[1]) : Number(h.getAttribute("aria-level") || 2);
    headings.push({ level, text: cut(textOf(h), 120), rect: rectOf(h), landmark: landmarkOf(h), styles: stylesOf(h) });
  }

  const images = [];
  for (const img of Array.from(document.images).slice(0, 400)) {
    if (ignored(img)) continue;
    const src = img.currentSrc || img.src || "";
    if (!src) continue;
    const visible = isVisible(img);
    const broken = img.complete && img.naturalWidth === 0 && !!img.getAttribute("src");
    if (!visible && !broken) continue;
    images.push({
      src,
      alt: img.getAttribute("alt"),
      rect: rectOf(img),
      broken,
      visible,
      landmark: landmarkOf(img),
    });
  }

  const forms = [];
  for (const form of Array.from(document.forms).slice(0, 40)) {
    if (ignored(form)) continue;
    const fields = [];
    for (const f of Array.from(form.elements).slice(0, 80)) {
      const fe = /** @type {any} */ (f);
      const tag = f.tagName.toLowerCase();
      const type = (f.getAttribute("type") || (tag === "input" ? "text" : tag)).toLowerCase();
      if (type === "hidden" || tag === "fieldset" || tag === "object" || tag === "output") continue;
      fields.push({
        tag,
        type,
        name: f.getAttribute("name") || "",
        id: stableId(f.id),
        label: cut(accName(f), 80),
        required: !!fe.required || f.getAttribute("aria-required") === "true",
        disabled: !!fe.disabled,
        visible: isVisible(f),
        placeholder: f.getAttribute("placeholder") || "",
        autocomplete: f.getAttribute("autocomplete") || "",
        pattern: f.getAttribute("pattern") || "",
        maxLength: f.getAttribute("maxlength") || "",
        min: f.getAttribute("min") || "",
        max: f.getAttribute("max") || "",
        options: tag === "select" ? /** @type {HTMLSelectElement} */ (f).options.length : undefined,
      });
    }
    forms.push({
      name: form.getAttribute("name") || stableId(form.id) || norm(form.getAttribute("aria-label")) || headingBefore(form) || "",
      action: form.getAttribute("action") === null ? "" : form.action,
      method: (form.getAttribute("method") || "get").toLowerCase(),
      visible: isVisible(form),
      landmark: landmarkOf(form),
      fields,
    });
  }

  /** @type {Set<string>} */
  const linkSet = new Set();
  for (const a of Array.from(document.querySelectorAll("a[href],area[href]")).slice(0, 3000)) {
    const href = /** @type {HTMLAnchorElement} */ (a).href;
    if (href && !ignored(a)) linkSet.add(href);
  }

  // ---- data grids and charts --------------------------------------------
  // Compared for what they are (columns, formats, series, tooltips) rather
  // than as text or pixels: their numbers are data, and data differs between
  // environments even when nothing is broken.
  const hash = (/** @type {string} */ str) => {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const MAX_ROWS = 50;
  /** @type {any[]} */
  const grids = [];
  /** @type {{ x: number, y: number, w: number, h: number }[]} Where data is drawn: left out of pixel comparisons when environments hold different data. */
  const dataRects = [];
  /** @type {Element[]} */
  const dataRoots = [];
  const agRoots = Array.from(document.querySelectorAll(".ag-root-wrapper")).filter((r) => !ignored(r) && isVisible(r) && !(r.parentElement && r.parentElement.closest(".ag-root-wrapper")));
  for (const root of agRoots.slice(0, 20)) {
    dataRoots.push(root);
    const gridEl = root.querySelector("[role=grid],[role=treegrid]");
    const headerCells = Array.from(root.querySelectorAll(".ag-header-cell[col-id]")).filter((h) => !h.classList.contains("ag-floating-filter") && isVisible(h));
    /** @type {Map<string, any>} */
    const cols = new Map();
    for (const h of headerCells) {
      const id = /** @type {string} */ (h.getAttribute("col-id"));
      if (cols.has(id)) continue;
      const label = h.querySelector(".ag-header-cell-text");
      const sort = h.getAttribute("aria-sort");
      cols.set(id, {
        id,
        name: cut(norm(label ? label.textContent : textOf(h)), 60),
        sort: sort && sort !== "none" ? sort : null,
        sortable: h.classList.contains("ag-header-cell-sortable"),
        filtered: h.classList.contains("ag-header-cell-filtered") || !!h.querySelector(".ag-filter-active"),
        numeric: h.classList.contains("ag-right-aligned-header"),
      });
    }
    /** @type {Map<number, Record<string, string>>} */
    const byIndex = new Map();
    for (const row of Array.from(root.querySelectorAll(".ag-row[row-index]"))) {
      if (row.closest(".ag-header,.ag-floating-top,.ag-floating-bottom,.ag-pinned-top,.ag-pinned-bottom,.ag-grid-pinned-top-rows-container,.ag-grid-pinned-bottom-rows-container")) continue;
      const i = row.getAttribute("row-index") || "";
      if (!/^\d+$/.test(i)) continue;
      const cells = byIndex.get(Number(i)) || {};
      for (const c of Array.from(row.querySelectorAll(".ag-cell[col-id]"))) {
        cells[/** @type {string} */ (c.getAttribute("col-id"))] = cut(norm(/** @type {HTMLElement} */ (c).innerText ?? c.textContent), 80);
      }
      if (!row.querySelector(".ag-cell[col-id]")) cells["(row)"] = cut(textOf(row), 120);
      byIndex.set(Number(i), cells);
    }
    const rows = Array.from(byIndex.keys())
      .sort((a, b) => a - b)
      .slice(0, MAX_ROWS)
      .map((i) => /** @type {Record<string, string>} */ (byIndex.get(i)));
    const summaryEl = root.querySelector(".ag-paging-row-summary-panel");
    const summary = summaryEl && isVisible(summaryEl) ? norm(summaryEl.textContent) : "";
    let total = null;
    const of = /(\d[\d,.\s]*)\s*$/.exec(summary);
    if (of) total = Number(of[1].replace(/[^\d]/g, ""));
    if (total == null && gridEl) {
      const rc = Number(gridEl.getAttribute("aria-rowcount"));
      if (rc > 0) total = Math.max(0, rc - root.querySelectorAll(".ag-header-row").length);
    }
    const paging = root.querySelector(".ag-paging-panel");
    let page = null;
    if (paging && isVisible(paging)) {
      const desc = paging.querySelector(".ag-paging-description");
      const input = /** @type {HTMLInputElement | null} */ (desc && desc.querySelector("input"));
      const nums = desc ? Array.from(desc.querySelectorAll(".ag-paging-number")).map((n) => norm(n.textContent)).filter(Boolean) : [];
      page = { current: input ? input.value : nums[0] || "", of: nums[nums.length - 1] || "", summary: cut(summary, 60) };
    }
    const ov = root.querySelector(".ag-overlay");
    let overlay = null;
    if (ov && !ov.classList.contains("ag-hidden") && isVisible(ov.querySelector(".ag-overlay-wrapper") || ov)) {
      const kind = ov.querySelector(".ag-overlay-loading-wrapper,.ag-overlay-loading-center")
        ? "loading"
        : ov.querySelector(".ag-overlay-no-rows-wrapper,.ag-overlay-no-rows-center")
          ? "no-rows"
          : "other";
      overlay = { kind, text: cut(textOf(ov), 80) };
    }
    const columns = Array.from(cols.values());
    const body = root.querySelector(".ag-grid-scrolling-rows,.ag-body-viewport,.ag-body,.ag-center-cols-viewport");
    if (body && isVisible(body)) dataRects.push(rectOf(body));
    if (summaryEl && isVisible(summaryEl)) dataRects.push(rectOf(summaryEl));
    grids.push({
      kind: "ag-grid",
      name: cut(norm(gridEl && gridEl.getAttribute("aria-label")) || headingBefore(root) || norm(root.parentElement && root.parentElement.getAttribute("aria-label")) || stableId((root.parentElement && root.parentElement.id) || "") || `grid ${grids.length + 1}`, 60),
      columns,
      rendered: byIndex.size,
      total,
      page,
      overlay,
      rows,
      rect: rectOf(root),
      digest: hash(JSON.stringify([columns.map((c) => `${c.id}:${c.sort}:${c.filtered}`), rows.slice(0, 20), page, overlay && overlay.kind])),
    });
  }
  // Other grids (MUI, Kendo, hand-made) that follow the ARIA grid pattern.
  for (const g of Array.from(document.querySelectorAll("[role=grid],[role=treegrid]")).slice(0, 20)) {
    if (g.closest(".ag-root-wrapper") || ignored(g) || !isVisible(g) || dataRoots.some((r) => r.contains(g))) continue;
    const headers = Array.from(g.querySelectorAll("[role=columnheader]")).filter(isVisible);
    if (!headers.length) continue;
    dataRoots.push(g);
    const colId = (/** @type {Element} */ e, /** @type {number} */ i) => e.getAttribute("data-field") || e.getAttribute("aria-colindex") || String(i + 1);
    const columns = headers.map((h, i) => {
      const sort = h.getAttribute("aria-sort");
      return { id: colId(h, i), name: cut(textOf(h), 60), sort: sort && sort !== "none" ? sort : null, sortable: !!sort, filtered: false, numeric: false };
    });
    const rows = Array.from(g.querySelectorAll("[role=row]"))
      .filter((r) => !r.querySelector("[role=columnheader]") && isVisible(r))
      .slice(0, MAX_ROWS)
      .map((r) => {
        /** @type {Record<string, string>} */
        const cells = {};
        Array.from(r.querySelectorAll("[role=gridcell],[role=cell],[role=rowheader]")).forEach((c, i) => {
          cells[c.getAttribute("data-field") || c.getAttribute("aria-colindex") || String(i + 1)] = cut(textOf(c), 80);
        });
        return cells;
      });
    const rc = Number(g.getAttribute("aria-rowcount"));
    const headerRows = Array.from(g.querySelectorAll("[role=row]")).filter((r) => r.querySelector("[role=columnheader]")).length;
    dataRects.push(rectOf(g));
    grids.push({
      kind: "aria-grid",
      name: cut(norm(g.getAttribute("aria-label")) || headingBefore(g) || `grid ${grids.length + 1}`, 60),
      columns,
      rendered: rows.length,
      total: rc > 0 ? Math.max(0, rc - headerRows) : null,
      page: null,
      overlay: null,
      rows,
      rect: rectOf(g),
      digest: hash(JSON.stringify([columns.map((c) => `${c.id}:${c.sort}`), rows.slice(0, 20)])),
    });
  }

  /** @type {any[]} */
  const charts = [];
  const allCharts = Array.from(document.querySelectorAll(".highcharts-container"));
  for (const c of allCharts.slice(0, 30)) {
    if (ignored(c) || !isVisible(c)) continue;
    dataRoots.push(c);
    dataRects.push(rectOf(c));
    const host = c.parentElement;
    const idx = host ? host.getAttribute("data-highcharts-chart") : null;
    const H = w.Highcharts;
    const api = H && H.charts && idx != null ? H.charts[Number(idx)] : null;
    const txt = (/** @type {string} */ sel) => {
      const e = c.querySelector(sel);
      return e ? cut(norm(e.textContent), 100) : "";
    };
    const seriesIndex = (/** @type {Element} */ e) => {
      const m = /(?:^|\s)highcharts-series-(\d+)(?:\s|$)/.exec(e.getAttribute("class") || "");
      return m ? Number(m[1]) : -1;
    };
    const legend = Array.from(c.querySelectorAll(".highcharts-legend-item")).map((li) => ({
      name: cut(norm(li.textContent), 60),
      hidden: li.classList.contains("highcharts-legend-item-hidden"),
      index: seriesIndex(li),
    }));
    /** @type {{ name: string, type: string, visible: boolean, points: number }[]} */
    let series = [];
    if (api && Array.isArray(api.series)) {
      series = api.series
        .filter((/** @type {any} */ x) => x && !(x.options && x.options.isInternal))
        .map((/** @type {any} */ x) => ({ name: cut(String(x.name ?? ""), 60), type: String(x.type ?? ""), visible: x.visible !== false, points: (x.points || x.data || []).length }));
    } else {
      for (const g of Array.from(c.querySelectorAll(".highcharts-series-group .highcharts-series"))) {
        const i = seriesIndex(g);
        const typeMatch = /highcharts-(\w+)-series/.exec(g.getAttribute("class") || "");
        const named = legend.find((l) => l.index === i);
        series.push({
          name: named ? named.name : `Series ${i + 1}`,
          type: typeMatch ? typeMatch[1] : "",
          visible: g.getAttribute("visibility") !== "hidden",
          points: c.querySelectorAll(`.highcharts-series-group .highcharts-series-${i} .highcharts-point`).length,
        });
      }
    }
    const xLabels = Array.from(c.querySelectorAll(".highcharts-xaxis-labels text,.highcharts-xaxis-labels span"))
      .map((e) => cut(norm(e.textContent), 40))
      .filter(Boolean)
      .slice(0, 60);
    const title = txt(".highcharts-title");
    charts.push({
      kind: "highcharts",
      domIndex: allCharts.indexOf(c),
      name: cut(title || norm(c.querySelector("svg") && /** @type {Element} */ (c.querySelector("svg")).getAttribute("aria-label")) || headingBefore(c) || `chart ${charts.length + 1}`, 60),
      title,
      subtitle: txt(".highcharts-subtitle"),
      series,
      legend,
      xTitle: txt(".highcharts-xaxis .highcharts-axis-title"),
      yTitle: txt(".highcharts-yaxis .highcharts-axis-title"),
      xLabels,
      yLabelCount: c.querySelectorAll(".highcharts-yaxis-labels text,.highcharts-yaxis-labels span").length,
      noData: txt(".highcharts-no-data"),
      exporting: !!c.querySelector(".highcharts-contextbutton"),
      rect: rectOf(c),
      digest: hash(JSON.stringify([series.map((x) => `${x.name}:${x.visible}:${x.points}`), legend.map((l) => `${l.name}:${l.hidden}`), xLabels])),
    });
  }

  // ---- visible text ------------------------------------------------------
  // innerText follows layout: hidden elements are skipped and blocks become
  // lines. Masked/ignored regions are subtracted afterwards rather than hidden,
  // so collecting never mutates the app's DOM.
  const body = document.body;
  let lines = body ? String(body.innerText || "").split("\n") : [];
  lines = lines.map((l) => norm(l)).filter(Boolean);
  // Grids and charts are compared on their own terms: take their lines out,
  // one for one (the same words elsewhere on the page stay).
  /** @type {Map<string, number>} */
  const dataLines = new Map();
  for (const r of dataRoots) {
    for (const t of String(/** @type {HTMLElement} */ (r).innerText || "").split("\n")) {
      const n = norm(t);
      if (n) dataLines.set(n, (dataLines.get(n) || 0) + 1);
    }
  }
  if (dataLines.size) {
    lines = lines.filter((l) => {
      const n = dataLines.get(l) || 0;
      if (!n) return true;
      dataLines.set(l, n - 1);
      return false;
    });
  }
  const scrub = [...maskSelectors, ...ignoreSelectors];
  if (scrub.length) {
    /** @type {string[]} */
    const remove = [];
    for (const s of scrub) {
      let found;
      try {
        found = document.querySelectorAll(s);
      } catch {
        continue;
      }
      for (const el of Array.from(found).slice(0, 200)) {
        for (const t of String(/** @type {HTMLElement} */ (el).innerText || "").split("\n")) {
          const n = norm(t);
          if (n) remove.push(n);
        }
      }
    }
    remove.sort((a, b) => b.length - a.length);
    lines = lines
      .map((l) => {
        for (const r of remove) if (l.includes(r)) l = l.split(r).join("‹masked›");
        return l;
      })
      .filter((l) => l.replace(/‹masked›/g, "").trim().length > 0);
  }
  const text = lines.slice(0, maxTextLines).map((l) => cut(l, 300));

  // ---- page-level facts ----------------------------------------------------
  const meta = (/** @type {string} */ sel) => {
    const el = document.querySelector(sel);
    return el ? norm(el.getAttribute("content") || el.getAttribute("href")) : "";
  };
  const canonicalEl = /** @type {HTMLLinkElement | null} */ (document.querySelector('link[rel="canonical"]'));
  // A login form on screen: on a page that had none in the other environment,
  // the session has ended.
  const loginForm = Array.from(document.querySelectorAll("input[type=password]")).some((el) => isVisible(el));
  const dialogs = Array.from(document.querySelectorAll("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]"))
    .filter((d) => isVisible(d))
    .map((d) => cut(accName(d) || textOf(d), 60));
  const de = document.documentElement;
  // Colours of the page's big containers: catches theme toggles and similar
  // purely visual responses that change no text or controls.
  const styleSig = ["html", "body", "header", "main", "footer", "nav"]
    .map((s) => {
      const e = document.querySelector(s);
      if (!e) return "";
      const cs = getComputedStyle(e);
      return `${cs.backgroundColor}/${cs.color}`;
    })
    .join("|");

  return {
    url: location.href,
    title: document.title,
    lang: de.getAttribute("lang") || "",
    meta: {
      description: meta('meta[name="description"]'),
      robots: meta('meta[name="robots"]'),
      canonical: canonicalEl ? canonicalEl.href : "",
      ogTitle: meta('meta[property="og:title"]'),
      viewport: meta('meta[name="viewport"]'),
    },
    doc: {
      scrollWidth: de.scrollWidth,
      scrollHeight: Math.max(de.scrollHeight, body ? body.scrollHeight : 0),
      clientWidth: de.clientWidth,
      innerWidth,
      innerHeight,
    },
    actionables,
    headings,
    images,
    forms,
    links: Array.from(linkSet),
    text,
    dialogs,
    loginForm,
    grids,
    charts,
    dataRects,
    styleSig,
    // Filled in by the caller, from before we scrolled.
    perf: /** @type {ReturnType<typeof readPerf> | null} */ (null),
  };
}

/**
 * Where to point at a chart to bring up its tooltip: the chart scrolled into
 * view, then viewport coordinates of a few points (first, middle, last) of
 * its first visible series. Uses the chart's own data when Highcharts is
 * reachable from the page, its point elements otherwise, and for a line
 * drawn without markers, positions along the line.
 * @param {{ domIndex: number, count: number }} o
 * @returns {{ x: number, y: number, label: string }[]}
 */
export function chartPoints(o) {
  const c = document.querySelectorAll(".highcharts-container")[o.domIndex];
  if (!c) return [];
  c.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const box = c.getBoundingClientRect();
  const pick = (/** @type {number} */ n) => {
    const want = Math.min(o.count, n);
    /** @type {number[]} */
    const out = [];
    for (let k = 0; k < want; k++) out.push(want === 1 ? 0 : Math.round((k * (n - 1)) / (want - 1)));
    return Array.from(new Set(out));
  };
  /** @type {{ x: number, y: number, label: string }[]} */
  const out = [];
  const host = c.parentElement;
  const idx = host ? host.getAttribute("data-highcharts-chart") : null;
  const H = /** @type {any} */ (window).Highcharts;
  const api = H && H.charts && idx != null ? H.charts[Number(idx)] : null;
  if (api && Array.isArray(api.series)) {
    const s = api.series.find((/** @type {any} */ x) => x && x.visible !== false && x.points && x.points.length && !(x.options && x.options.isInternal));
    if (s) {
      for (const i of pick(s.points.length)) {
        const p = s.points[i];
        const g = p.graphic && p.graphic.element ? p.graphic.element : p.graphic;
        let x = null;
        let y = null;
        if (g && typeof g.getBoundingClientRect === "function") {
          const r = g.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            x = r.left + r.width / 2;
            y = r.top + Math.min(r.height / 2, 10);
          }
        }
        if (x == null && typeof p.plotX === "number") {
          x = box.left + (api.plotLeft || 0) + p.plotX;
          y = box.top + (api.plotTop || 0) + (typeof p.plotY === "number" ? p.plotY : (api.plotHeight || 0) / 2);
        }
        if (x != null && y != null) out.push({ x, y, label: String(p.category ?? p.name ?? p.x ?? i) });
      }
      if (out.length) return out;
    }
  }
  for (const g of Array.from(c.querySelectorAll(".highcharts-series-group .highcharts-series"))) {
    if (g.getAttribute("visibility") === "hidden") continue;
    const m = /highcharts-series-(\d+)/.exec(g.getAttribute("class") || "");
    if (!m) continue;
    const pts = Array.from(c.querySelectorAll(`.highcharts-series-group .highcharts-series-${m[1]} .highcharts-point`)).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (pts.length) {
      for (const i of pick(pts.length)) {
        const r = pts[i].getBoundingClientRect();
        out.push({ x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 10), label: `point ${i + 1}` });
      }
      return out;
    }
    const line = /** @type {SVGPathElement | null} */ (g.querySelector(".highcharts-graph"));
    const ctm = line && line.getScreenCTM();
    if (line && ctm && typeof line.getTotalLength === "function") {
      const len = line.getTotalLength();
      for (const f of [0.05, 0.5, 0.95].slice(0, o.count)) {
        const pt = line.getPointAtLength(len * f);
        const sp = new DOMPoint(pt.x, pt.y).matrixTransform(ctm);
        out.push({ x: sp.x, y: sp.y, label: `${Math.round(f * 100)}% along` });
      }
      return out;
    }
  }
  return out;
}

/**
 * What the chart's tooltip says right now; "" when none is showing.
 * @param {{ domIndex: number }} o
 */
export function chartTooltip(o) {
  const c = document.querySelectorAll(".highcharts-container")[o.domIndex];
  if (!c) return "";
  const shown = (/** @type {Element} */ el) => {
    if (el.getAttribute("visibility") === "hidden") return false;
    const op = el.getAttribute("opacity");
    if (op != null && Number(op) < 0.1) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.1) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  // Inside the chart, or (tooltip.outside) in a container of its own.
  const all = [...Array.from(c.querySelectorAll(".highcharts-tooltip")), ...Array.from(document.querySelectorAll(".highcharts-tooltip-container .highcharts-tooltip"))];
  for (const t of all) {
    if (!shown(t)) continue;
    // Highcharts breaks lines with <tspan dy="…">; HTML tooltips with <br>.
    let out = "";
    const walk = (/** @type {Node} */ n) => {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1) {
        const e = /** @type {Element} */ (n);
        if ((e.tagName.toLowerCase() === "tspan" && Number(e.getAttribute("dy") || 0) !== 0) || e.tagName.toLowerCase() === "br") out += " · ";
        for (const k of Array.from(e.childNodes)) walk(k);
      }
    };
    walk(t);
    return out.replace(/\u200b/g, "").replace(/\s+/g, " ").replace(/^[\s·]+|[\s·]+$/g, "").replace(/(\s·\s*){2,}/g, " · ").trim();
  }
  return "";
}

/**
 * Viewport rectangles of grids and charts, for screenshots of the viewport.
 * @param {{ x: number, y: number }} [origin] Subtract this (an element screenshot's corner).
 */
export function viewportDataRects(origin) {
  const ox = origin ? origin.x : 0;
  const oy = origin ? origin.y : 0;
  return Array.from(document.querySelectorAll(".ag-grid-scrolling-rows,.ag-body-viewport,.ag-paging-row-summary-panel,.highcharts-container,[role=grid]:not(.ag-root-wrapper [role=grid])"))
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ x: r.left - ox, y: r.top - oy, w: r.width, h: r.height }));
}

/**
 * Scroll one step down. False once the bottom is in view.
 * Instant, even on pages that ask for smooth scrolling.
 */
export function scrollStep() {
  const height = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  if (scrollY + innerHeight >= height) return false;
  window.scrollTo({ top: scrollY + Math.max(200, Math.floor(innerHeight * 0.9)), behavior: "instant" });
  return true;
}

