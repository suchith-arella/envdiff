import { collectPage, finishAnimations } from "../inpage/collect.js";
import { truncate } from "../util/misc.js";

/**
 * When a plain-English journey step can't be read, or what it names can't be
 * found, ask the AI provider what the step means on the page as it is: which
 * control, and what to do with it. Only the baseline is asked; the candidate
 * then does the same thing to the same control.
 */

const SYSTEM = `You help run a QA test written in plain English against a web application. You get one step of the test and what the page shows right now: its address, headings, grids, charts, and its controls, each with an index. Turn the step into one browser action.

Actions:
- click, dblclick, hover: on the control at "control"
- fill: type "value" into the text field at "control"
- select: choose the option "value" in the dropdown at "control"
- check, uncheck: the checkbox or switch at "control"
- press: press the key named in "value" (Enter, Escape, Tab, ArrowDown, ...)
- goto: open the path or address in "value"
- expect: the text in "value" should be on the page; "control" is -1
- none: the step can't be done on this page; say why in "explanation"

Pick the control a person following the step would use. Prefer exact name matches; use landmarks and section headings to tell apart controls with the same name. Use only indexes from the list. Keep "explanation" under 20 words.`;

const SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["click", "dblclick", "hover", "fill", "select", "check", "uncheck", "press", "goto", "expect", "none"] },
    control: { type: "integer" },
    value: { type: "string" },
    explanation: { type: "string" },
  },
  required: ["action", "control", "value", "explanation"],
  additionalProperties: false,
};

/**
 * @param {import("./provider.js").AIProvider} provider
 * @param {{ step: import("../plain.js").PlainStep, page: import("playwright").Page, why: string, history: string[] }} o
 * @returns {Promise<(import("../plain.js").PlainStep & { control?: number }) | null>}
 */
export async function planStep(provider, { step, page, why, history }) {
  await page.evaluate(finishAnimations).catch(() => 0);
  const dom = await page.evaluate(collectPage, {});
  const controls = dom.actionables.slice(0, 250).map((/** @type {any} */ e) => {
    const where = [e.landmark !== "body" ? `in ${e.landmark}` : "", e.heading ? `under "${truncate(e.heading, 40)}"` : ""].filter(Boolean).join(" ");
    const kind = e.kind === "input" ? " (text field)" : e.tag === "select" ? ` (dropdown: ${(e.options ?? []).map((/** @type {any} */ o) => o.text).slice(0, 8).join(" | ")})` : "";
    return `${e.idx}. ${e.role} "${truncate(e.name, 60)}"${kind}${where ? ` ${where}` : ""}${e.disabled ? " (disabled)" : ""}`;
  });
  const text = [
    `Step: ${step.text}`,
    why ? `Reading it directly didn't work: ${why}` : "",
    history.length ? `Earlier steps, already done: ${history.slice(-6).join(" → ")}` : "",
    `Page: "${dom.title}" at ${dom.url}`,
    `Headings: ${dom.headings.slice(0, 15).map((/** @type {any} */ h) => h.text).join(" | ") || "(none)"}`,
    dom.grids?.length ? `Grids: ${dom.grids.map((/** @type {any} */ g) => `"${g.name}" (columns: ${g.columns.map((/** @type {any} */ c) => c.name).join(", ")})`).join("; ")}` : "",
    dom.charts?.length ? `Charts: ${dom.charts.map((/** @type {any} */ c) => `"${c.name}" (series: ${c.series.map((/** @type {any} */ s) => s.name).join(", ")})`).join("; ")}` : "",
    "Controls:",
    ...controls,
  ]
    .filter(Boolean)
    .join("\n");
  const res = await provider.ask({ system: SYSTEM, parts: [{ type: "text", text }], schema: SCHEMA, effort: "low", maxTokens: 4000 });
  if (res.refused || !res.json) return null;
  const a = res.json;
  const control = Number.isInteger(a.control) && a.control >= 0 && a.control < dom.actionables.length ? a.control : -1;
  const name = control >= 0 ? dom.actionables[control].name : undefined;
  const base = { text: step.text, control, target: name };
  switch (a.action) {
    case "click":
    case "dblclick":
    case "hover":
    case "check":
    case "uncheck":
      return control >= 0 ? { ...base, action: a.action } : null;
    case "fill":
      return control >= 0 ? { ...base, action: "fill", value: String(a.value ?? "") } : null;
    case "select":
      return control >= 0 ? { ...base, action: "select", option: String(a.value ?? "") } : null;
    case "press":
      return { ...base, action: "press", key: String(a.value || "Enter") };
    case "goto":
      return a.value ? { ...base, action: "goto", url: String(a.value) } : null;
    case "expect":
      return { ...base, action: "expect", target: String(a.value ?? "") };
    default:
      return { ...base, action: "none", target: String(a.explanation ?? "") };
  }
}
