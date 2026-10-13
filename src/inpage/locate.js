/* global window, document, getComputedStyle */
/**
 * Runs in the page (serialized by Playwright; self-contained): find the
 * control a person means by a few words — "Apply", "the Search orders box",
 * "Date range", "Customer" (a column header), "Target" (a chart legend item).
 *
 * Candidates are scored by how well their accessible name, label,
 * placeholder or text matches the words, with a bonus for the kind of
 * control named ("button", "link", "tab") and for the exact control picked
 * in the other environment (`prefer`). The matches are kept in
 * window.__envdiff.found for the caller to act on, best first.
 *
 * @param {{
 *   kind: "click" | "fill" | "select" | "check" | "hover" | "any",
 *   phrase: string,
 *   hint?: string,
 *   prefer?: { role: string, name: string } | null,
 * }} spec
 * @returns {{ i: number, role: string, name: string, tag: string, score: number }[]}
 */
export function locateTarget(spec) {
  const w = /** @type {any} */ (window);
  /** @type {any} */
  const state = (w.__envdiff = w.__envdiff || {});
  const norm = (/** @type {any} */ s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const loose = (/** @type {any} */ s) =>
    norm(s)
      .toLowerCase()
      .replace(/[“”"‘’'`]/g, "")
      .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "")
      .trim();
  const visible = (/** @type {Element} */ el) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    const anyEl = /** @type {any} */ (el);
    if (typeof anyEl.checkVisibility === "function" && !anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    return !el.closest("[aria-hidden=true],[inert]");
  };
  const textOf = (/** @type {Element} */ el) => norm(/** @type {HTMLElement} */ (el).innerText ?? el.textContent);
  const labelText = (/** @type {Element} */ el) => {
    const parts = [];
    const aria = el.getAttribute("aria-label");
    if (aria) parts.push(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      for (const id of by.split(/\s+/)) {
        const ref = document.getElementById(id);
        if (ref) parts.push(textOf(ref));
      }
    }
    const input = /** @type {HTMLInputElement} */ (el);
    if (input.labels) for (const l of Array.from(input.labels)) parts.push(textOf(l));
    for (const a of ["placeholder", "title", "name", "id"]) {
      const v = el.getAttribute(a);
      if (v) parts.push(a === "name" || a === "id" ? v.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2") : v);
    }
    // Text just before the field ("Search  [_______]").
    const prev = el.previousElementSibling;
    if (prev && !prev.matches("input,select,textarea,button")) {
      const t = textOf(prev);
      if (t && t.length <= 40) parts.push(t);
    }
    return parts;
  };
  const nameOf = (/** @type {Element} */ el) => {
    const tag = el.tagName.toLowerCase();
    if (["input", "select", "textarea"].includes(tag) || el.getAttribute("role") === "textbox" || el.getAttribute("role") === "combobox") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return [norm(/** @type {HTMLInputElement} */ (el).value) || type];
      return labelText(el);
    }
    const parts = [];
    const aria = el.getAttribute("aria-label");
    if (aria) parts.push(aria);
    const t = el.classList.contains("ag-header-cell") ? norm((el.querySelector(".ag-header-cell-text") || el).textContent) : textOf(el) || norm(el.textContent);
    if (t) parts.push(t);
    const title = el.getAttribute("title");
    if (title) parts.push(title);
    const img = el.querySelector("img[alt]");
    if (img) parts.push(img.getAttribute("alt") || "");
    return parts;
  };
  const roleOf = (/** @type {Element} */ el) => {
    if (el.classList.contains("highcharts-legend-item")) return "legend item";
    if (el.classList.contains("ag-header-cell")) return "column header";
    const r = (el.getAttribute("role") || "").split(/\s+/)[0];
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary" || (tag === "input" && ["button", "submit", "reset", "image"].includes(type))) return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") return type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : type === "search" ? "searchbox" : "textbox";
    return tag;
  };

  const CLICKABLE =
    'a[href],button,summary,input[type=submit],input[type=button],input[type=reset],input[type=image],input[type=checkbox],input[type=radio],select,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=treeitem],[role=switch],[role=checkbox],[role=radio],[role=combobox],[onclick],[tabindex]:not([tabindex="-1"]),.ag-header-cell[col-id],.highcharts-legend-item,label';
  const FIELDS = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=file]),textarea,[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox]';
  const SELECTS = "select,[role=combobox],[aria-haspopup=listbox],.mat-mdc-select,.mat-select,.ag-picker-field-wrapper,.p-dropdown,.k-dropdown,.el-select,.ant-select-selector";
  const CHECKS = 'input[type=checkbox],input[type=radio],[role=checkbox],[role=switch],[role=radio],[role=menuitemcheckbox]';
  /** @type {Set<Element>} */
  const pool = new Set();
  const add = (/** @type {string} */ sel) => {
    for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 4000)) if (visible(el)) pool.add(el);
  };
  const phrase = loose(spec.phrase);
  if (spec.kind === "fill") add(FIELDS);
  else if (spec.kind === "select") add(SELECTS);
  else if (spec.kind === "check") add(CHECKS);
  else add(CLICKABLE);
  // Words on screen that aren't a control themselves: climb to what they belong to.
  if ((spec.kind === "click" || spec.kind === "hover" || spec.kind === "any" || spec.kind === "check") && phrase) {
    let scanned = 0;
    const walker = document.createTreeWalker(document.body, 4);
    for (let n = walker.nextNode(); n && scanned < 20000; n = walker.nextNode(), scanned++) {
      if (loose(n.nodeValue) !== phrase) continue;
      const host = /** @type {Element | null} */ (n.parentElement);
      if (!host || !visible(host)) continue;
      const control = host.closest(spec.kind === "check" ? `${CHECKS},label` : CLICKABLE);
      if (control && visible(control)) pool.add(control);
      else if (spec.kind === "hover" || spec.kind === "any" || getComputedStyle(host).cursor === "pointer") pool.add(host);
      else {
        // A click handler on an ancestor shows as a pointer cursor somewhere up the tree.
        let up = host.parentElement;
        for (let d = 0; up && d < 4; d++, up = up.parentElement) {
          if (getComputedStyle(up).cursor === "pointer") {
            pool.add(up);
            break;
          }
        }
        if (!up || getComputedStyle(up).cursor !== "pointer") pool.add(host);
      }
    }
  }
  // A label of a checkbox stands for the checkbox.
  const resolveLabel = (/** @type {Element} */ el) => {
    if (el.tagName.toLowerCase() !== "label") return el;
    const target = /** @type {HTMLLabelElement} */ (el).control;
    return target && visible(target) ? target : el;
  };

  const score = (/** @type {string} */ n, /** @type {string} */ p) => {
    if (!n || !p) return 0;
    if (n === p) return 100;
    if (n.startsWith(`${p} `) || n.endsWith(` ${p}`)) return 85;
    if (n.startsWith(p)) return 80;
    if (p.startsWith(n) && n.length >= 3) return 60;
    if (n.includes(p)) return 55;
    const pw = p.split(" ").filter((x) => x.length > 1);
    const nw = n.split(" ");
    const hit = pw.filter((x) => nw.some((y) => y === x || y.startsWith(x) || (x.length > 3 && x.startsWith(y) && y.length > 3))).length;
    if (pw.length && hit === pw.length) return 45;
    return pw.length ? (25 * hit) / pw.length : 0;
  };
  const HINT_ROLES = /** @type {Record<string, string[]>} */ ({
    button: ["button"],
    link: ["link"],
    tab: ["tab"],
    menu: ["menuitem", "menu", "button", "link"],
    "menu item": ["menuitem", "link", "button"],
    item: ["menuitem", "option", "treeitem", "link", "button"],
    option: ["option", "menuitem"],
    header: ["column header", "columnheader"],
    "column header": ["column header", "columnheader"],
    column: ["column header", "columnheader"],
    checkbox: ["checkbox", "switch"],
    icon: ["button", "link"],
    row: ["row"],
  });
  const wantRoles = spec.hint ? HINT_ROLES[spec.hint.toLowerCase()] || [] : [];
  const preferName = spec.prefer ? loose(spec.prefer.name) : "";

  /** @type {{ el: Element, role: string, name: string, tag: string, score: number }[]} */
  const scored = [];
  const seen = new Set();
  for (const raw of pool) {
    const el = resolveLabel(raw);
    if (seen.has(el)) continue;
    seen.add(el);
    if (/** @type {any} */ (el).disabled === true || el.getAttribute("aria-disabled") === "true") continue;
    const names = nameOf(el).map(loose).filter(Boolean);
    if (spec.kind !== "fill" && el !== raw) names.push(...nameOf(raw).map(loose));
    let best = 0;
    for (const n of names) best = Math.max(best, score(n, phrase));
    const role = roleOf(el);
    // "search" finds the search box even when it is only called "Find…".
    if (spec.kind === "fill" && /^(search|find|filter)\b/.test(phrase) && (role === "searchbox" || /search|find|filter/.test(names.join(" ")))) best = Math.max(best, 70);
    if (!best && !(spec.prefer && preferName && names.includes(preferName))) continue;
    if (wantRoles.includes(role)) best += 15;
    if (spec.prefer && role === spec.prefer.role && names.includes(preferName)) best += 200;
    // Inside an open dialog or menu: that is where a person is looking.
    if (el.closest("dialog[open],[role=dialog],[role=menu],[role=listbox],.cdk-overlay-pane,.ag-popup")) best += 5;
    scored.push({ el, role, name: (nameOf(el)[0] || "").slice(0, 120), tag: el.tagName.toLowerCase(), score: best });
  }
  // Best first; among equals, the smaller (more specific) element, then document order.
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  state.found = scored.slice(0, 8).map((s) => s.el);
  return scored.slice(0, 8).map((s, i) => ({ i, role: s.role, name: s.name, tag: s.tag, score: Math.round(s.score) }));
}

/**
 * Runs in the page: the options a custom dropdown shows once opened.
 * @param {string} wanted
 */
export function locateOption(wanted) {
  const w = /** @type {any} */ (window);
  /** @type {any} */
  const state = (w.__envdiff = w.__envdiff || {});
  const loose = (/** @type {any} */ s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
  const want = loose(wanted).replace(/^["'“”‘’]|["'“”‘’]$/g, "");
  const options = Array.from(document.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],mat-option,.mat-mdc-option,.ag-list-item,.p-dropdown-item,.k-list-item,.el-select-dropdown__item,.ant-select-item-option,li')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  });
  const text = (/** @type {Element} */ el) => loose(/** @type {HTMLElement} */ (el).innerText ?? el.textContent);
  const exact = options.find((o) => text(o) === want);
  const starts = options.find((o) => text(o).startsWith(want));
  const contains = options.find((o) => text(o).includes(want));
  const pick = exact || starts || contains || null;
  state.option = pick;
  return pick ? text(pick) : null;
}
