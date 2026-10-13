/**
 * Journeys written the way a tester writes them:
 *
 *   Journey: Filter orders
 *   1. Go to Orders
 *   2. Type "west" into Search orders
 *   3. Sort by Amount descending
 *   4. Expect to see "SO-1001"
 *   5. Take a screenshot "West orders"
 *
 * One step per line (or separated by ";" on one line). Each step is read
 * into an action — go to, click, type, select, check, hover, sort, expect,
 * screenshot… — and a target described in the app's own words. Steps that
 * don't read as any of these are worked out by the AI provider against the
 * page, when one is configured.
 *
 * @typedef {object} PlainStep
 * @property {string} text The step as written.
 * @property {string} action
 * @property {string} [target] The control or text, in the user's words.
 * @property {string} [hint] The kind of control named: button, link, tab, column…
 * @property {string} [value] Text to type.
 * @property {string} [option] Option to choose.
 * @property {string} [key] Key to press.
 * @property {string} [url]
 * @property {number} [ms]
 * @property {string} [name] Screenshot name.
 * @property {string} [direction] asc | desc, for sorting.
 * @property {string} [which] first | middle | last point, for charts.
 * @property {string} [count] Expected rows: "no", "some", a number…
 * @property {boolean} [submit] Press Enter after typing.
 * @property {boolean} [not] Expectation negated.
 */

/** Split a journey script into journeys and their step lines. */
/**
 * @param {string} text
 * @param {{ name?: string }} [opts] Name for steps before any "Journey:" line.
 * @returns {{ name: string, steps: string[] }[]}
 */
export function parseJourneyScript(text, opts = {}) {
  const lines = splitLines(String(text ?? ""));
  // In a document with numbered or bulleted steps, other lines are prose.
  const LIST = /^(?:step\s*\d+\s*[:.)\-–]|\d+\s*[.)\-–:]|[-*•])\s+/i;
  const listed = lines.some((l) => LIST.test(l.trim()));
  /** @type {{ name: string, steps: string[] }[]} */
  const journeys = [];
  /** @type {{ name: string, steps: string[] } | null} */
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^(\/\/|<!--)/.test(line)) continue;
    const heading = /^(?:#{1,6}\s*|(?:journey|scenario|flow|test|case)\s*\d*\s*[:\-–]\s*)(.*)$/i.exec(line);
    if (heading && (line.startsWith("#") || /^(journey|scenario|flow|test|case)\b/i.test(line))) {
      current = { name: heading[1].trim() || `Journey ${journeys.length + 1}`, steps: [] };
      journeys.push(current);
      continue;
    }
    if (listed && !LIST.test(line)) continue;
    const step = line
      .replace(/^(?:step\s*\d+\s*[:.)\-–]?|\d+\s*[.)\-–:]|[-*•]|>\s)\s*/i, "")
      .replace(/\s*[;.]$/, "")
      .trim();
    if (!step) continue;
    if (!current) {
      current = { name: opts.name ?? `Journey ${journeys.length + 1}`, steps: [] };
      journeys.push(current);
    }
    current.steps.push(step);
  }
  return journeys.filter((j) => j.steps.length);
}

/**
 * Lines of a script; each line is split again at semicolons outside quotes
 * ("Journey: Smoke; Go to Orders; Click Apply", as a one-line workflow input).
 * @param {string} text
 */
function splitLines(text) {
  return text.split(/\r?\n/).flatMap(splitSemicolons);
}

/** @param {string} text */
function splitSemicolons(text) {
  /** @type {string[]} */
  const out = [];
  let cur = "";
  /** @type {string | null} */
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote || (quote === "“" && ch === "”")) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'" || ch === "“") {
      // An apostrophe inside a word ("don't") is not a quote.
      if (ch === "'" && /\w$/.test(cur)) cur += ch;
      else {
        quote = ch;
        cur += ch;
      }
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Without surrounding quotes. @param {string | undefined} s */
export function unquote(s) {
  const t = String(s ?? "").trim();
  const m = /^(["'“‘`])([\s\S]*)(["'”’`])$/.exec(t);
  return m ? m[2] : t;
}

/** "the Search orders box" -> "Search orders"; "the Apply button" -> "Apply". @param {string} s */
function targetWords(s) {
  let t = String(s ?? "").trim();
  t = t.replace(/^(?:on\s+)?(?:the|a|an|my)\s+/i, "");
  t = t.replace(/\s+(?:field|box|input|textbox|text box|search box|searchbox|area|button|link|tab|icon|menu item|dropdown|drop-down)$/i, "").trim();
  return unquote(t);
}

const KEYS = /** @type {Record<string, string>} */ ({
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  space: "Space",
  spacebar: "Space",
  backspace: "Backspace",
  delete: "Delete",
  "arrow up": "ArrowUp",
  "arrow down": "ArrowDown",
  "arrow left": "ArrowLeft",
  "arrow right": "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  "page up": "PageUp",
  "page down": "PageDown",
  home: "Home",
  end: "End",
});

const CONTROL_WORDS = "button|link|tab|menu item|menu|item|icon|option|column header|header|column|checkbox|row|card|tile|tab item";

/**
 * Read one step. Null when it doesn't read as any known action.
 * @param {string} text
 * @returns {PlainStep | null}
 */
export function parsePlainStep(text) {
  const original = String(text ?? "").trim();
  const s = original
    .replace(/^(?:(?:and\s+then|then|and|now|finally|please|lastly)[,\s]+|(?:next|first|after that),\s*)/i, "")
    .replace(/\s*[.;!]$/, "")
    .trim();
  if (!s) return null;
  /** @param {Omit<PlainStep, "text">} step @returns {PlainStep} */
  const make = (step) => /** @type {PlainStep} */ (Object.fromEntries(Object.entries({ text: original, ...step }).filter(([, v]) => v !== undefined)));
  let m;

  // ---- expectations ---------------------------------------------------------
  m = /^(?:expect|verify|assert|ensure|make sure|confirm|check that|check if|check whether|validate)\s+(?:that\s+)?(.+)$/i.exec(s) || /^(?:i|we|you)?\s*should\s+(.+)$/i.exec(s);
  if (m) return expectation(m[1], make);
  // "The Apply button should be visible", "Orders should appear"
  if (/\s(?:should|must)\s/i.test(s) && !/^(?:click|type|select|go|open|enter)\b/i.test(s)) return expectation(s.replace(/\s(?:should|must)\s+(?:be\s+)?/i, " is "), make);
  if (/^(?:i\s+|we\s+)?(?:can\s+)?see\s+/i.test(s)) return expectation(s, make);

  // ---- grid rows -------------------------------------------------------------------------------
  m = /^(double[- ]?click|click|open|select|choose)\s+(?:on\s+)?(?:the\s+)?(first|second|third|last|\d+(?:st|nd|rd|th)?)\s+row(?:\s+(?:of|in|on)\s+(?:the\s+)?(.+?)(?:\s+(?:grid|table))?)?$/i.exec(s);
  if (m) {
    const words = /** @type {Record<string, string>} */ ({ first: "1", second: "2", third: "3", last: "last" });
    const which = words[m[2].toLowerCase()] ?? m[2].replace(/\D/g, "");
    return make({ action: "row", which, target: m[3] ? unquote(m[3]) : undefined, hint: /double/i.test(m[1]) ? "double" : undefined });
  }

  // ---- going places ------------------------------------------------------------
  if (/^(?:go|navigate|head)\s+back$/i.test(s) || /^back$/i.test(s)) return make({ action: "back" });
  if (/^(?:refresh|reload)(?:\s+the\s+(?:page|screen|app))?$/i.test(s)) return make({ action: "reload" });
  m = /^(?:go to|goto|navigate to|open|visit|browse to|head to|load|switch to)\s+(.+)$/i.exec(s);
  if (m) {
    const where = m[1].trim();
    const url = unquote(where);
    if (/^(?:\/|#\/|https?:\/\/)/i.test(url) || (/^\S+$/.test(url) && url.includes("/"))) return make({ action: "goto", url });
    const named = /^(?:the\s+)?(next|previous|prev|first|last)\s+page$/i.exec(where);
    if (named) return make({ action: "page", which: named[1].toLowerCase() === "prev" ? "previous" : named[1].toLowerCase() });
    const target = targetWords(where.replace(/\s+(?:page|screen|view|section|tab|area|module)$/i, ""));
    return make({ action: "navigate", target });
  }
  m = /^(?:the\s+)?(next|previous|first|last)\s+page$/i.exec(s);
  if (m) return make({ action: "page", which: m[1].toLowerCase() });

  // ---- logging in ---------------------------------------------------------------
  m = /^(?:log ?in|sign ?in|login|signin)(?:\s+as\s+(.+))?$/i.exec(s);
  if (m) return make({ action: "login", target: m[1] ? unquote(m[1]) : undefined });

  // ---- typing --------------------------------------------------------------------
  m = /^(?:type|enter|input|write|put|key in|fill in)\s+(.+?)\s+(?:in|into|inside|on)\s+(?:the\s+)?(.+)$/i.exec(s);
  if (m) return make({ action: "fill", value: unquote(m[1]), target: targetWords(m[2]) });
  m = /^(?:fill(?: in)?|set|populate|complete|change)\s+(?:the\s+)?(.+?)\s+(?:with|to|as|=)\s+(.+)$/i.exec(s);
  if (m) return make({ action: "fill", target: targetWords(m[1]), value: unquote(m[2]) });
  m = /^search(?:\s+for)?\s+(.+?)(?:\s+(?:in|on|using)\s+(?:the\s+)?(.+))?$/i.exec(s);
  if (m) return make({ action: "fill", value: unquote(m[1]), target: m[2] ? targetWords(m[2]) : "search", submit: true });
  m = /^(?:clear|empty)\s+(?:the\s+)?(.+)$/i.exec(s);
  if (m) return make({ action: "fill", target: targetWords(m[1]), value: "" });

  // ---- choosing ---------------------------------------------------------------------
  m = /^(?:select|choose|pick)\s+(.+?)\s+(?:from|in|on|for|under)\s+(?:the\s+)?(.+?)(?:\s+(?:dropdown|drop-down|drop down|list|menu|select|picker|filter|field|combo ?box))?$/i.exec(s);
  if (m) return make({ action: "select", option: unquote(m[1]), target: targetWords(m[2]) });

  // ---- toggles ----------------------------------------------------------------------
  m = /^(?:uncheck|untick|deselect|turn off|switch off)\s+(?:the\s+)?(.+?)(?:\s+(?:checkbox|check box|box|option|toggle|switch))?$/i.exec(s);
  if (m) return make({ action: "uncheck", target: targetWords(m[1]) });
  m = /^(?:check|tick|turn on|switch on)\s+(?:the\s+)?(.+?)(?:\s+(?:checkbox|check box|box|option|toggle|switch))?$/i.exec(s);
  if (m) return make({ action: "check", target: targetWords(m[1]) });

  // ---- keys -----------------------------------------------------------------------------
  m = /^(?:press|hit|tap)\s+(?:the\s+)?(.+?)(?:\s+key)?$/i.exec(s);
  if (m && KEYS[m[1].toLowerCase()]) return make({ action: "press", key: KEYS[m[1].toLowerCase()] });

  // ---- pointing --------------------------------------------------------------------------
  m = /^(?:hover|mouse ?over|point at|move the mouse (?:over|to))\s+(?:over\s+|on\s+|onto\s+)?(?:the\s+)?(.+)$/i.exec(s);
  if (m) {
    const chart = /^(?:(first|middle|last)\s+point\s+(?:of|on|in)\s+(?:the\s+)?)?(.+?)\s+chart$/i.exec(m[1].trim());
    if (chart) return make({ action: "hoverChart", target: unquote(chart[2]), which: (chart[1] ?? "first").toLowerCase() });
    return make({ action: "hover", target: targetWords(m[1]) });
  }

  // ---- grids --------------------------------------------------------------------------------
  m = /^sort\s+(?:the\s+)?(?:(.+?)\s+(?:grid|table)\s+)?by\s+(.+?)(?:\s+(asc|ascending|desc|descending|a-z|z-a|lowest first|highest first))?$/i.exec(s);
  if (m) {
    const dir = /desc|z-a|highest/i.test(m[3] ?? "") ? "desc" : "asc";
    return make({ action: "sort", target: targetWords(m[2].replace(/\s+column$/i, "")), direction: dir, hint: "column header" });
  }

  // ---- waiting --------------------------------------------------------------------------------
  m = /^wait(?:\s+for)?\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|minutes?|mins?)?$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = (m[2] ?? "s").toLowerCase();
    return make({ action: "wait", ms: Math.round(unit.startsWith("ms") || unit.startsWith("milli") ? n : unit.startsWith("min") ? n * 60000 : n * 1000) });
  }
  m = /^wait\s+(?:until|till)\s+(?:the\s+)?(.+?)\s+(?:disappears|is gone|goes away|is hidden|closes)$/i.exec(s);
  if (m) return make({ action: "expect", target: targetWords(m[1]), not: true });
  m = /^wait\s+(?:for|until|till)\s+(?:the\s+)?(.+?)(?:\s+to\s+(?:appear|load|show|show up|be visible|finish loading|be shown))?(?:\s+(?:appears|loads|shows|is visible|is shown))?$/i.exec(s);
  if (m) return make({ action: "expect", target: unquote(targetWords(m[1])) });

  // ---- screenshots and scrolling -------------------------------------------------------------
  m = /^(?:take\s+)?(?:a\s+)?(?:screenshot|screen ?shot|snapshot|capture(?:\s+the\s+(?:page|screen))?)(?:\s+(?:of|called|named|as|for))?\s*(.*)$/i.exec(s);
  if (m) return make({ action: "screenshot", name: unquote(m[1]).replace(/^(?:the\s+)/i, "") || original });
  m = /^scroll\s+(?:down|up|to\s+(?:the\s+)?(bottom|top)|to\s+(?:the\s+)?(.+))$/i.exec(s);
  if (m) return make({ action: "scroll", target: m[1] ? m[1].toLowerCase() : m[2] ? targetWords(m[2]) : /up/i.test(s) ? "up" : "down" });

  // ---- clicking -------------------------------------------------------------------------------
  m = new RegExp(`^(?:double[- ]?click|dbl[- ]?click)\\s+(?:on\\s+)?(?:the\\s+)?(.+?)(?:\\s+(${CONTROL_WORDS}))?$`, "i").exec(s);
  if (m) return make({ action: "dblclick", target: targetWords(m[1]), hint: m[2]?.toLowerCase() });
  m = new RegExp(`^(?:click|click on|press|tap|tap on|hit|push|select|choose|open|expand|collapse|close|dismiss)\\s+(?:on\\s+)?(?:the\\s+)?(.+?)(?:\\s+(${CONTROL_WORDS}))?$`, "i").exec(s);
  if (m) return make({ action: "click", target: targetWords(m[1]), hint: m[2]?.toLowerCase() });
  return null;
}

/**
 * What an expectation says should be true.
 * @param {string} body e.g. 'I see "Saved"', 'the URL contains /orders', 'the Orders grid has rows'
 * @param {(s: Omit<PlainStep, "text">) => PlainStep} make
 * @returns {PlainStep}
 */
function expectation(body, make) {
  const b = body.trim().replace(/^(?:that\s+)/i, "");
  let m;
  m = /^(?:the\s+)?(?:page\s+)?url\s+(?:contains|includes|has|ends with|is|matches|should contain)\s+(.+)$/i.exec(b);
  if (m) return make({ action: "expectUrl", url: unquote(m[1]) });
  m = /^(?:the\s+)?(?:page\s+)?title\s+(?:is|contains|includes|should be|should contain)\s+(.+)$/i.exec(b);
  if (m) return make({ action: "expectTitle", target: unquote(m[1]) });
  m = /^(?:the\s+)?(.+?)\s+(?:grid|table)\s+(?:has|shows|contains|should have|should show|lists)\s+(?:(no|some|any|at least \d+|\d+|more than \d+|fewer than \d+)\s+)?(?:rows?|records?|items?|results?|entries|data)$/i.exec(b);
  if (m) return make({ action: "expectRows", target: unquote(m[1]), count: (m[2] ?? "some").toLowerCase() });
  m = /^(?:the\s+)?(.+?)\s+chart\s+(?:has|shows|contains|includes|should have|should show)\s+(?:a\s+|the\s+)?(.+?)(?:\s+series)?$/i.exec(b);
  if (m) return make({ action: "expectSeries", target: unquote(m[1]), value: unquote(m[2]) });
  m = /^(?:there\s+(?:is|are)\s+)?no\s+(?:errors?|error messages?)(?:\s+(?:is|are)\s+shown)?$/i.exec(b);
  if (m) return make({ action: "expectNoErrors" });
  m = /^(?:i\s+|we\s+|you\s+)?(?:can\s+)?(?:not|no longer|cannot|can't|don't|do not)\s+see\s+(.+)$/i.exec(b) || /^(?:not\s+)?see\s+no\s+(.+)$/i.exec(b);
  if (m) return make({ action: "expect", target: unquote(targetWords(m[1])), not: true });
  m = /^(?:i\s+|we\s+|you\s+)?(?:can\s+)?(?:see|to see|be able to see|show|display)\s+(.+)$/i.exec(b);
  if (m) return make({ action: "expect", target: unquote(targetWords(m[1])) });
  m = /^(.+?)\s+(?:is|are|should be)\s+(?:not\s+(?:visible|shown|displayed|present)|hidden|gone|closed)$/i.exec(b) || /^(.+?)\s+(?:disappears?|goes away|is removed)$/i.exec(b);
  if (m) return make({ action: "expect", target: unquote(targetWords(m[1])), not: true });
  m = /^(.+?)\s+(?:is|are|should be)\s+(?:visible|shown|displayed|present|there|open|on (?:the )?(?:page|screen))$/i.exec(b) || /^(.+?)\s+(?:appears?|shows up|is shown|loads)$/i.exec(b);
  if (m) return make({ action: "expect", target: unquote(targetWords(m[1])) });
  return make({ action: "expect", target: unquote(b) });
}

/**
 * A label for reports and logs, with anything secret hidden.
 * @param {PlainStep} step
 * @param {string[]} secrets Values that must not be shown.
 */
export function plainLabel(step, secrets = []) {
  let t = step.text;
  for (const v of secrets) if (v && v.length >= 3) t = t.split(v).join("••••");
  return t;
}
