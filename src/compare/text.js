import { diffLines, summarizeDiff } from "../util/textdiff.js";
import { compilePatterns } from "../util/misc.js";

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";

/** Volatile tokens that differ between any two page loads. */
const DYNAMIC = /** @type {[RegExp, string][]} */ ([
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/g, "‹datetime›"],
  [/\b\d{1,2}:\d{2}(:\d{2})?\s?([AaPp]\.?[Mm]\.?)?(?![\d:])/g, "‹time›"],
  [/\b\d{4}-\d{2}-\d{2}\b/g, "‹date›"],
  [/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, "‹date›"],
  [new RegExp(`\\b${MONTH} \\d{1,2}(st|nd|rd|th)?,? \\d{4}\\b`, "gi"), "‹date›"],
  [new RegExp(`\\b\\d{1,2} ${MONTH},? \\d{4}\\b`, "gi"), "‹date›"],
  [/\b(\d+|an?|one|a few) (second|sec|minute|min|hour|hr|day|week|month|year)s? ago\b/gi, "‹ago›"],
  [/\b(just now|moments ago|yesterday|today)\b/gi, "‹ago›"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "‹uuid›"],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi, "‹hash›"],
]);

/**
 * @param {string[]} lines
 * @param {{ normalize: boolean, ignore: RegExp[] }} opts
 */
export function normalizeLines(lines, opts) {
  return lines
    .map((line) => {
      let l = line;
      if (opts.normalize) for (const [re, rep] of DYNAMIC) l = l.replace(re, rep);
      for (const re of opts.ignore) l = l.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "‹ignored›");
      return l.trim();
    })
    .filter((l) => l && l.replace(/‹(ignored|masked)›/g, "").trim());
}

/**
 * Diff the visible text of two pages.
 * @param {string[]} a
 * @param {string[]} b
 * @param {import("../config.js").Config} cfg
 */
export function compareText(a, b, cfg) {
  const opts = { normalize: cfg.text.normalize, ignore: compilePatterns(cfg.ignore.text) };
  const na = normalizeLines(a, opts);
  const nb = normalizeLines(b, opts);
  const ops = diffLines(na, nb);
  return { ...summarizeDiff(ops, 1, 80), total: Math.max(na.length, nb.length) };
}

const TLDS = /\.(com|org|net|io|dev|app|co|ai|in|uk|us|de|fr|info|tech|cloud|site|store|shop|gov|edu|me|ly|sh|js|json|html|css|png|jpg|svg|pdf|txt|md)$/i;

/** Text that means a render went wrong. Each is compared by count against the baseline. */
export const SUSPICIOUS = /** @type {{ name: string, test: (line: string) => boolean }[]} */ ([
  { name: "undefined", test: (l) => /(^|[\s:=(>$€£])undefined($|[\s,.)<])/.test(l) },
  { name: "NaN", test: (l) => /(^|[\s:=($€£])NaN($|[\s,.)%])/.test(l) },
  { name: "[object Object]", test: (l) => l.includes("[object Object]") },
  { name: "null shown as text", test: (l) => /(^|[\s:=($€£])null($|[\s,.)])/.test(l) },
  { name: "Invalid Date", test: (l) => /\bInvalid Date\b/.test(l) },
  { name: "unrendered template", test: (l) => /\{\{\s*[\w.$[\]'"]+\s*\}\}|\$\{[\w.]+\}|<%=?\s*[\w.]+\s*%>/.test(l) },
  {
    name: "raw translation key",
    test: (l) => /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_-]*){2,}$/.test(l) && !TLDS.test(l),
  },
  {
    name: "error message",
    test: (l) =>
      /(something went wrong|an (unexpected )?error (has )?occurred|internal server error|application error|unexpected error|server error|bad gateway|service unavailable|gateway time-?out|cannot read propert(y|ies) of (undefined|null)|is not a function|is not defined\b|uncaught \w*error|traceback \(most recent call last\)|stack trace:|exception:|failed to fetch|network error|request failed with status code|\b(400|401|403|404|405|500|502|503|504) (error|bad request|unauthorized|forbidden|not found|internal server error|bad gateway|service unavailable)\b|page not found|not found\.?$|access denied)/i.test(l),
  },
  { name: "placeholder text", test: (l) => /lorem ipsum|dolor sit amet/i.test(l) },
  { name: "garbled characters", test: (l) => /�|Ã[©¨¢ ±¶¼]|â€[™œ\x9d”“˜]/.test(l) },
]);

/**
 * Suspicious text that the candidate shows more of than the baseline.
 * @param {string[]} a baseline lines
 * @param {string[]} b candidate lines
 * @returns {{ name: string, baseline: number, candidate: number, samples: string[] }[]}
 */
export function suspiciousText(a, b) {
  const out = [];
  for (const s of SUSPICIOUS) {
    const ha = a.filter(s.test);
    const hb = b.filter(s.test);
    if (hb.length > ha.length) {
      const known = new Set(ha);
      out.push({ name: s.name, baseline: ha.length, candidate: hb.length, samples: hb.filter((l) => !known.has(l)).slice(0, 3) });
    }
  }
  return out;
}
