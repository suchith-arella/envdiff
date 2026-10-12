/**
 * Scripted steps, shared by login (`auth.steps`) and journeys. Designed to be
 * written in YAML by people who don't write Playwright:
 *
 *   - goto: /login
 *   - fill: { label: Email, value: "${QA_USER}" }
 *   - click: { role: button, name: Sign in }
 *   - waitForUrl: "**\/dashboard"
 *   - expectText: { selector: h1, text: Welcome }
 *   - screenshot: Dashboard
 *
 * A locator is either a Playwright selector string ("#email", "text=Sign in",
 * "role=button[name='Go']") or an object: { role, name } | { text } | { label }
 * | { placeholder } | { testId } | { title } | { alt } | { selector }, each with
 * optional `exact` and `nth`.
 */

const ACTIONS = [
  "goto",
  "click",
  "dblclick",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "focus",
  "scroll",
  "wait",
  "waitFor",
  "waitForUrl",
  "screenshot",
  "expectVisible",
  "expectHidden",
  "expectText",
  "expectUrl",
  "evaluate",
];

/**
 * @param {import("playwright").Page} page
 * @param {any} spec
 * @returns {import("playwright").Locator}
 */
export function locatorFor(page, spec) {
  if (typeof spec === "string") return page.locator(spec).first();
  if (!spec || typeof spec !== "object") throw new Error(`Bad locator: ${JSON.stringify(spec)}`);
  const exact = spec.exact === true;
  /** @type {import("playwright").Locator} */
  let loc;
  if (spec.selector) loc = page.locator(spec.selector);
  else if (spec.role) loc = page.getByRole(spec.role, spec.name !== undefined ? { name: spec.name, exact } : {});
  else if (spec.testId) loc = page.getByTestId(spec.testId);
  else if (spec.label) loc = page.getByLabel(spec.label, { exact });
  else if (spec.placeholder) loc = page.getByPlaceholder(spec.placeholder, { exact });
  else if (spec.text) loc = page.getByText(spec.text, { exact });
  else if (spec.title) loc = page.getByTitle(spec.title, { exact });
  else if (spec.alt) loc = page.getByAltText(spec.alt, { exact });
  else throw new Error(`Locator needs one of selector, role, testId, label, placeholder, text, title, alt: ${JSON.stringify(spec)}`);
  return typeof spec.nth === "number" ? loc.nth(spec.nth) : loc.first();
}

/** Which action a step performs, and its argument. */
export function parseStep(/** @type {any} */ step) {
  if (typeof step === "string") return { action: "click", arg: step, step: { click: step } };
  if (!step || typeof step !== "object") throw new Error(`Bad step: ${JSON.stringify(step)}`);
  const action = ACTIONS.find((a) => a in step);
  if (!action) throw new Error(`Unknown step ${JSON.stringify(step)}. Valid actions: ${ACTIONS.join(", ")}`);
  return { action, arg: step[action], step };
}

/** A human label for reports: 'click button "Sign in"'. */
export function describeStep(/** @type {any} */ step) {
  const { action, arg, step: s } = parseStep(step);
  if (s.label) return String(s.label);
  const loc = (/** @type {any} */ l) => {
    if (typeof l === "string") return l;
    if (!l) return "";
    if (l.role) return `${l.role}${l.name !== undefined ? ` "${l.name}"` : ""}`;
    for (const k of ["testId", "label", "placeholder", "text", "title", "alt", "selector"]) if (l[k]) return `${k === "selector" ? "" : k + " "}"${l[k]}"`;
    return JSON.stringify(l);
  };
  switch (action) {
    case "goto":
      return `go to ${arg}`;
    case "fill":
    case "type":
      return `${action} ${loc(arg)}${/pass|secret|token/i.test(JSON.stringify(arg)) ? "" : arg?.value !== undefined ? ` with "${String(arg.value).slice(0, 40)}"` : ""}`;
    case "press":
      return `press ${arg?.key ?? arg}${arg?.selector || arg?.role || arg?.label ? ` in ${loc(arg)}` : ""}`;
    case "wait":
      return `wait ${arg}ms`;
    case "waitForUrl":
    case "expectUrl":
      return `${action === "expectUrl" ? "expect" : "wait for"} URL ${arg}`;
    case "screenshot":
      return `screenshot "${arg}"`;
    case "expectText":
      return `expect ${loc(arg)} to contain "${arg?.text ?? arg?.value ?? ""}"`;
    case "evaluate":
      return "run script";
    default:
      return `${action} ${loc(arg)}`;
  }
}

/**
 * Locator part of an action argument that may carry extra fields
 * (value, key, option): { selector: "#q", value: "x" } -> locator for #q.
 * @param {import("playwright").Page} page
 * @param {any} arg
 */
function targetOf(page, arg) {
  if (typeof arg === "string") return locatorFor(page, arg);
  const { value, key, option, index, text, ...rest } = arg ?? {};
  // `text` is a locator for most steps but the expected text for expectText.
  const spec = Object.keys(rest).some((k) => ["selector", "role", "testId", "label", "placeholder", "title", "alt"].includes(k))
    ? rest
    : text !== undefined
      ? { text, exact: rest.exact }
      : rest;
  return locatorFor(page, spec);
}

/**
 * Run one step. Throws on failure, with a message fit for a report.
 * @param {import("playwright").Page} page
 * @param {any} step
 * @param {{ scope: import("./urls.js").Scope, timeout?: number }} ctx
 */
export async function runStep(page, step, ctx) {
  const { action, arg, step: s } = parseStep(step);
  const timeout = s.timeout ?? ctx.timeout ?? 10000;
  switch (action) {
    case "goto":
      await page.goto(ctx.scope.urlFor(String(arg)), { waitUntil: "load", timeout: Math.max(timeout, 30000) });
      return;
    case "click":
      await targetOf(page, arg).click({ timeout });
      return;
    case "dblclick":
      await targetOf(page, arg).dblclick({ timeout });
      return;
    case "fill":
      await targetOf(page, arg).fill(String(arg.value ?? ""), { timeout });
      return;
    case "type":
      await targetOf(page, arg).pressSequentially(String(arg.value ?? ""), { timeout, delay: 20 });
      return;
    case "press":
      if (typeof arg === "string") await page.keyboard.press(arg);
      else if (arg.selector || arg.role || arg.label || arg.placeholder || arg.testId) await targetOf(page, arg).press(arg.key, { timeout });
      else await page.keyboard.press(arg.key);
      return;
    case "select": {
      const value =
        arg.value !== undefined ? { value: String(arg.value) } : arg.option !== undefined ? { label: String(arg.option) } : { index: Number(arg.index ?? 0) };
      await targetOf(page, arg).selectOption(value, { timeout });
      return;
    }
    case "check":
      await targetOf(page, arg).check({ timeout });
      return;
    case "uncheck":
      await targetOf(page, arg).uncheck({ timeout });
      return;
    case "hover":
      await targetOf(page, arg).hover({ timeout });
      return;
    case "focus":
      await targetOf(page, arg).focus({ timeout });
      return;
    case "scroll":
      if (arg === "bottom") await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      else if (arg === "top") await page.evaluate(() => window.scrollTo(0, 0));
      else await targetOf(page, arg).scrollIntoViewIfNeeded({ timeout });
      return;
    case "wait":
      await page.waitForTimeout(Math.min(Number(arg) || 0, 60000));
      return;
    case "waitFor":
      await targetOf(page, arg).waitFor({ state: "visible", timeout });
      return;
    case "waitForUrl":
      await page.waitForURL(String(arg), { timeout });
      return;
    case "screenshot":
      return; // the journey runner captures at this point
    case "expectVisible":
      await targetOf(page, arg).waitFor({ state: "visible", timeout });
      return;
    case "expectHidden":
      await targetOf(page, arg).waitFor({ state: "hidden", timeout });
      return;
    case "expectText": {
      const want = String(arg.text ?? arg.value ?? "");
      const loc = locatorFor(page, arg.selector ?? (arg.role ? { role: arg.role, name: arg.name } : "body"));
      const deadline = Date.now() + timeout;
      let last = "";
      while (Date.now() < deadline) {
        last = (await loc.innerText({ timeout: 1000 }).catch(() => "")) ?? "";
        if (last.includes(want)) return;
        await page.waitForTimeout(200);
      }
      throw new Error(`expected text "${want}", found "${last.replace(/\s+/g, " ").slice(0, 120)}"`);
    }
    case "expectUrl":
      await page.waitForURL(String(arg), { timeout });
      return;
    case "evaluate":
      await page.evaluate(String(arg));
      return;
  }
}

/** Trim Playwright's multi-line error text to the useful first line. */
export function stepError(/** @type {unknown} */ e) {
  const msg = /** @type {Error} */ (e)?.message ?? String(e);
  return msg
    .split("\n")[0]
    .replace(/^(locator|page)\.\w+: /, "")
    .replace(/Timeout (\d+)ms exceeded\.?/, "timed out after $1ms")
    .slice(0, 300);
}
