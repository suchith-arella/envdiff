/* global document, getComputedStyle, Node */
import { createHmac } from "node:crypto";
import { msSinceChange } from "./inpage/collect.js";
import { sleep } from "./util/misc.js";

/**
 * Logging in without a script: find the login form the way a person would,
 * fill it in and tell success from failure.
 *
 *   - no form on the page: follow its "Log in" / "Sign in" link
 *   - username first, password on the next screen: fill, continue, fill
 *   - a one-time code after the password: generated from the authenticator
 *     secret (ENVDIFF_<ENV>_TOTP) when there is one
 *   - an error message, a CAPTCHA or a form that never goes away: a clear
 *     error instead of a run full of login pages
 */

/**
 * RFC 6238 time-based one-time password, as authenticator apps show it.
 * @param {string} secret Base32 secret, or an otpauth:// URI.
 * @param {{ time?: number, step?: number, digits?: number }} [opts]
 */
export function totp(secret, { time = Date.now(), step = 30, digits = 6 } = {}) {
  let s = String(secret ?? "").trim();
  if (/^otpauth:/i.test(s)) s = new URL(s).searchParams.get("secret") ?? "";
  const key = base32(s);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
  const h = createHmac("sha1", key).update(counter).digest();
  const offset = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

/** @param {string} s */
function base32(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  if (!clean) throw new Error("the authenticator secret is empty");
  let bits = 0;
  let value = 0;
  /** @type {number[]} */
  const out = [];
  for (const ch of clean) {
    const i = alphabet.indexOf(ch);
    if (i < 0) throw new Error("the authenticator secret is not base32");
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Runs in the page: the parts of a login form that are on screen now.
 * Self-contained; serialized by Playwright.
 * @param {{ usernameSelector?: string, passwordSelector?: string, submitSelector?: string }} opts
 */
export function findLoginParts(opts) {
  const o = opts || {};
  const visible = (/** @type {Element | null} */ el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) return false;
    return !el.closest("[aria-hidden=true],[inert]");
  };
  const all = (/** @type {string} */ sel, /** @type {ParentNode} */ root = document) => {
    try {
      return Array.from(root.querySelectorAll(sel));
    } catch {
      return [];
    }
  };
  const first = (/** @type {string | undefined} */ sel) => (sel ? all(sel).find(visible) || null : null);
  const norm = (/** @type {any} */ s) => String(s || "").replace(/\s+/g, " ").trim();
  const nameOf = (/** @type {Element} */ el) =>
    norm(el.getAttribute("aria-label") || /** @type {HTMLElement} */ (el).innerText || /** @type {HTMLInputElement} */ (el).value || el.getAttribute("title") || "");
  const hint = (/** @type {HTMLInputElement} */ el) =>
    norm(
      [
        el.getAttribute("name"),
        el.id,
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("autocomplete"),
        ...(el.labels ? Array.from(el.labels).map((l) => l.textContent) : []),
      ].join(" "),
    ).toLowerCase();
  const typeOf = (/** @type {Element} */ el) => (el.getAttribute("type") || "").toLowerCase();
  const inputs = /** @type {HTMLInputElement[]} */ (all("input")).filter((i) => visible(i) && !i.disabled && !i.readOnly);
  const textLike = (/** @type {HTMLInputElement} */ i) => ["", "text", "email", "tel", "number"].includes(typeOf(i));

  const OTP = /one-time-code|\botp\b|one.?time|verification|2fa|mfa|totp|authenticat|security code|passcode/;
  const otp = inputs.find((i) => i.getAttribute("autocomplete") === "one-time-code" || (textLike(i) && OTP.test(hint(i)) && !/user|e-?mail|login/.test(hint(i)))) || null;
  const pass = /** @type {HTMLInputElement | null} */ (first(o.passwordSelector)) || inputs.find((i) => typeOf(i) === "password") || null;

  // The form, or the smallest container holding the field and a button.
  const scopeOf = (/** @type {HTMLInputElement} */ el) => {
    if (el.form) return el.form;
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      if (all("button,input[type=submit],[role=button]", cur).some(visible)) return cur;
      cur = cur.parentElement;
    }
    return document.body;
  };
  const anchor = pass || otp;
  const scope = anchor ? scopeOf(anchor) : document.body;

  const USER = /user|e-?mail|login|account|identifier|\bid\b|mail/;
  const userScore = (/** @type {HTMLInputElement} */ i) =>
    (/(username|email)/.test(i.getAttribute("autocomplete") || "") ? 4 : 0) + (typeOf(i) === "email" ? 3 : 0) + (USER.test(hint(i)) ? 2 : 0);
  // Without a password field, a field that looks like a username starts a
  // login only in a form with nothing else to fill in: the email field of a
  // contact, newsletter or report-request form is not one.
  const NOT_LOGIN = /contact|newsletter|subscri|search|feedback|enquir|inquir|message|demo|quote|report/;
  const SKIP_TYPES = ["checkbox", "radio", "hidden", "submit", "button", "image", "reset", "search"];
  const alone = (/** @type {HTMLInputElement} */ i) => {
    const form = i.form;
    const named = form ? [form.id, form.getAttribute("name"), form.getAttribute("class"), form.getAttribute("action")].join(" ") : "";
    if (NOT_LOGIN.test(hint(i)) || NOT_LOGIN.test(named.toLowerCase())) return false;
    const fields = all("input,textarea,select", scopeOf(i)).filter(
      (f) => visible(f) && !SKIP_TYPES.includes(typeOf(f)) && !/search|query/.test(hint(/** @type {HTMLInputElement} */ (f))),
    );
    return fields.length === 1;
  };
  let user = /** @type {HTMLInputElement | null} */ (first(o.usernameSelector));
  if (!user) {
    const pool = inputs.filter(
      (i) => textLike(i) && i !== otp && (!pass || (scope.contains(i) && !!(i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING))),
    );
    pool.sort((a, b) => userScore(b) - userScore(a));
    // Next to a password field the field before it is the username whatever
    // it is called; on its own it has to look like one, in a form of its own.
    user = pass ? pool[0] || null : pool.find((i) => userScore(i) >= 2 && (otp || alone(i))) || null;
  }

  const AWAY = /forgot|reset|cancel|close|sign ?up|register|create (an )?account|help|show|hide|reveal|toggle|back|language/i;
  const SSO = /with (google|microsoft|apple|github|facebook|linkedin|okta|sso|saml|azure|office)|\bsso\b|single sign/i;
  const GO = /^(log ?in|sign ?in|login|signin|submit|continue|next|go|enter|verify|confirm|ok)$/i;
  const GOISH = /log ?in|sign ?in|login|continue|next|verify|submit/i;
  const buttonScore = (/** @type {Element} */ b) => {
    const n = nameOf(b);
    if (AWAY.test(n) || SSO.test(n)) return -1;
    let s = 0;
    const t = typeOf(b);
    if (t === "submit" || (b.tagName === "BUTTON" && !t && /** @type {HTMLButtonElement} */ (b).form)) s += 3;
    if (GO.test(n)) s += 4;
    else if (GOISH.test(n)) s += 2;
    return s;
  };
  let submit = first(o.submitSelector);
  if (!submit && (anchor || user)) {
    const root = anchor ? scope : user ? scopeOf(user) : document.body;
    const ranked = all("button,input[type=submit],input[type=button],input[type=image],[role=button],a[role=button]", root)
      .filter((b) => visible(b) && !(/** @type {any} */ (b).disabled) && b.getAttribute("aria-disabled") !== "true")
      .map((b) => /** @type {[Element, number]} */ ([b, buttonScore(b)]))
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1]);
    submit = ranked.length ? ranked[0][0] : null;
  }

  // No form here: the way to one.
  let loginLink = null;
  if (!pass && !user && !otp) {
    const LINK = /^(log ?in|sign ?in|login|signin|sign on|member login|customer login|client login)\b/i;
    const links = all("a,button,[role=button],[role=link],[role=menuitem]").filter((e) => {
      const n = nameOf(e);
      return visible(e) && LINK.test(n) && !/sign ?up|register|create/i.test(n) && !SSO.test(n);
    });
    links.sort((a, b) => nameOf(a).length - nameOf(b).length);
    loginLink = links[0] || null;
  }

  const ERRORS =
    "[role=alert],[aria-live=assertive],[aria-live=polite],.error,.errors,.alert,.alert-danger,.invalid-feedback,.mat-error,.mat-mdc-form-field-error,.text-danger,.help-block,.validation-message,.toast-error,[class*=error],[class*=Error]";
  const FAIL = /invalid|incorrect|wrong|failed|not (be )?recogni[sz]ed|locked|expired|try again|does ?n.t match|do not match|not found|unauthori[sz]ed|denied/i;
  const error =
    all(ERRORS)
      .filter(visible)
      .map((e) => norm(/** @type {HTMLElement} */ (e).innerText || e.textContent))
      .find((t) => t && t.length < 300 && FAIL.test(t)) || "";
  const captcha = all('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,.h-captcha,.cf-turnstile').some(visible);
  return { pass, user, submit, otp, loginLink, error, captcha };
}

/**
 * @typedef {object} LoginParts
 * @property {import("playwright").Frame} frame
 * @property {import("playwright").ElementHandle | null} pass
 * @property {import("playwright").ElementHandle | null} user
 * @property {import("playwright").ElementHandle | null} submit
 * @property {import("playwright").ElementHandle | null} otp
 * @property {import("playwright").ElementHandle | null} loginLink
 * @property {string} error
 * @property {boolean} captcha
 */

/**
 * What of a login form each frame shows; the main frame first, then frames
 * that hold a form (hosted login widgets).
 * @param {import("playwright").Page} page
 * @param {any} selectors
 * @returns {Promise<LoginParts>}
 */
async function look(page, selectors) {
  /** @type {LoginParts | null} */
  let fallback = null;
  for (const frame of page.frames()) {
    let handle;
    try {
      handle = await frame.evaluateHandle(findLoginParts, selectors);
    } catch {
      continue; // navigating, or a frame we can't reach
    }
    const el = async (/** @type {string} */ k) => (await handle.getProperty(k)).asElement();
    /** @type {LoginParts} */
    const parts = {
      frame,
      pass: await el("pass"),
      user: await el("user"),
      submit: await el("submit"),
      otp: await el("otp"),
      loginLink: await el("loginLink"),
      error: /** @type {string} */ (await (await handle.getProperty("error")).jsonValue()),
      captcha: /** @type {boolean} */ (await (await handle.getProperty("captcha")).jsonValue()),
    };
    if (parts.pass || parts.user || parts.otp) return parts;
    if (!fallback && frame === page.mainFrame()) fallback = parts;
  }
  return fallback ?? { frame: page.mainFrame(), pass: null, user: null, submit: null, otp: null, loginLink: null, error: "", captcha: false };
}

/**
 * Keep looking until `ready` holds or time runs out.
 * @param {import("playwright").Page} page
 * @param {any} selectors
 * @param {(p: LoginParts) => boolean} ready
 * @param {number} ms
 */
async function lookUntil(page, selectors, ready, ms) {
  const end = Date.now() + ms;
  let parts = await look(page, selectors);
  while (!ready(parts) && Date.now() < end) {
    await sleep(300);
    parts = await look(page, selectors);
  }
  return parts;
}

/** Still attached and on screen. @param {import("playwright").ElementHandle | null} el */
async function stillShown(el) {
  if (!el) return false;
  try {
    return await el.evaluate((/** @type {Element} */ e) => {
      if (!e.isConnected) return false;
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none";
    });
  } catch {
    return false; // the page navigated away
  }
}

/**
 * Click `button`, or press Enter in `field` when there is no button.
 * @param {import("playwright").ElementHandle | null} button
 * @param {import("playwright").ElementHandle | null} field
 */
async function submitWith(button, field) {
  if (button) {
    try {
      await button.click({ timeout: 5000 });
      return;
    } catch {
      // covered or gone: Enter does the same in a form
    }
  }
  await field?.press("Enter").catch(() => {});
}

/**
 * Log in on the page as it is now: it should already show the login form or
 * a link to it.
 * @param {import("playwright").Page} page
 * @param {object} o
 * @param {string} o.username
 * @param {string} o.password
 * @param {string} [o.totp] Authenticator secret.
 * @param {{ usernameSelector?: string, passwordSelector?: string, submitSelector?: string }} [o.selectors]
 * @param {number} [o.timeout] For the whole login, in ms.
 * @param {(stage: string) => void} [o.onStage] Told what is being done, for error messages.
 * @param {string} [o.totpHint] Name of the variable that would hold the authenticator secret.
 * @returns {Promise<{ formUrl: string, landedUrl: string }>}
 */
export async function autoLogin(page, o) {
  const selectors = o.selectors ?? {};
  const stage = (/** @type {string} */ s) => o.onStage?.(s);
  const deadline = Date.now() + (o.timeout ?? 45000);
  const left = () => Math.max(1000, deadline - Date.now());

  stage("find the login form");
  let parts = await lookUntil(page, selectors, (p) => !!(p.pass || p.user || p.otp || p.loginLink || p.captcha), Math.min(15000, left()));
  if (!parts.pass && !parts.user && parts.loginLink) {
    stage("open the login form");
    await parts.loginLink.click({ timeout: 5000 });
    parts = await lookUntil(page, selectors, (p) => !!(p.pass || p.user || p.otp || p.captcha), Math.min(15000, left()));
  }
  if (parts.captcha && !parts.pass) throw new Error("the login page shows a CAPTCHA; log in by hand once with envdiff login and use --storage");
  if (!parts.pass && !parts.user) {
    throw new Error(`no login form found at ${page.url()}; point auth.loginUrl at the page with the form, or script it with auth.steps`);
  }
  const formUrl = page.url();

  // Username first, password on the next screen.
  if (!parts.pass && parts.user) {
    stage("enter the username");
    await parts.user.fill(o.username);
    await submitWith(parts.submit, parts.user);
    parts = await lookUntil(page, selectors, (p) => !!(p.pass || p.error || p.otp), Math.min(15000, left()));
    if (parts.error) throw new Error(`the login was refused: "${parts.error}"`);
    if (!parts.pass) throw new Error("entered the username, but no password field followed");
  }

  stage("enter the username and password");
  if (parts.user) await parts.user.fill(o.username);
  await /** @type {import("playwright").ElementHandle} */ (parts.pass).fill(o.password);
  stage("submit the login form");
  const passField = parts.pass;
  // A notice that was there before submitting ("too many invalid attempts
  // lock your account") is not the answer to this attempt.
  const standing = parts.error;
  await submitWith(parts.submit, passField);

  let codeSent = 0;
  for (;;) {
    await sleep(400);
    parts = await look(page, selectors);
    if (parts.otp && !parts.pass) {
      if (!o.totp) throw new Error(`the login asks for a one-time code; set ${o.totpHint ?? "the authenticator secret (…_TOTP)"} or save a session with envdiff login`);
      if (codeSent >= 2) throw new Error(`the one-time code was not accepted${parts.error ? `: "${parts.error}"` : ""}`);
      stage("enter the one-time code");
      // A code about to expire may be stale by the time it arrives.
      const remaining = 30 - ((Date.now() / 1000) % 30);
      if (remaining < 3) await sleep(remaining * 1000 + 300);
      await parts.otp.fill(totp(o.totp));
      await submitWith(parts.submit, parts.otp);
      codeSent++;
      await sleep(1500);
      continue;
    }
    if (parts.error && parts.error !== standing && (parts.pass || parts.otp)) throw new Error(`the login was refused: "${parts.error}"`);
    if (parts.captcha && parts.pass) throw new Error("the login page asked for a CAPTCHA; log in by hand once with envdiff login and use --storage");
    if (!parts.pass && !parts.otp && !(await stillShown(passField))) break;
    if (Date.now() > deadline) {
      throw new Error(`still on the login page after ${Math.round((o.timeout ?? 45000) / 1000)}s${parts.error ? `: "${parts.error}"` : ""}`);
    }
  }
  stage("wait for the app to load");
  await afterLogin(page, Math.min(10000, left()));
  return { formUrl, landedUrl: page.url() };
}

/**
 * Wait for the app to finish what a login sets off: its first page loaded and
 * the DOM quiet. Not Playwright's "networkidle": a request whose answer the
 * app never reads (a 401 from before the login, say) keeps that from ever
 * coming.
 * @param {import("playwright").Page} page
 * @param {number} [ms]
 */
export async function afterLogin(page, ms = 10000) {
  const end = Date.now() + ms;
  await page.waitForLoadState("load", { timeout: ms }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: Math.min(1500, ms) }).catch(() => {});
  while (Date.now() < end) {
    const quiet = await page.evaluate(msSinceChange).catch(() => 0);
    if (quiet >= 600) return;
    await sleep(150);
  }
}
