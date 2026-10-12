/**
 * In-page helpers against a real browser, on pages built for one behaviour each.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { collectPage, finishAnimations, initScript, msSinceChange } from "../src/inpage/collect.js";
import { revealAll } from "../src/capture.js";

const FADING = `<!doctype html><style>
  .card { opacity: 0; transform: translateX(40px); transition: opacity 1s 2s, transform 1s 2s; }
  .card.in { opacity: 1; transform: none; }
</style><main><h1>Insights</h1><button class="card">Request access</button></main>`;

test("a control caught fading in is inventoried as it will look, like the screenshot", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(FADING);
    await page.evaluate(() => {
      const card = /** @type {HTMLElement} */ (document.querySelector(".card"));
      void card.offsetWidth; // start from the hidden state
      card.classList.add("in");
    });
    await page.waitForTimeout(100);
    const names = async () => (await page.evaluate(collectPage, {})).actionables.map((/** @type {any} */ e) => e.name);
    // Staggered reveals hold each item at opacity 0 until its delay is up.
    assert.deepEqual(await names(), [], "while waiting to fade in it reads as invisible");
    assert.equal(await page.evaluate(finishAnimations), 2);
    assert.deepEqual(await names(), ["Request access"]);
  } finally {
    await browser.close();
  }
});

test("scrolling counts as the page still changing", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.addInitScript(initScript, { ignoreMutations: [] });
    await page.goto("data:text/html,<div style='height:5000px'>long</div>");
    await page.waitForTimeout(600);
    assert.ok((await page.evaluate(msSinceChange)) >= 500);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(50);
    assert.ok((await page.evaluate(msSinceChange)) < 300);
  } finally {
    await browser.close();
  }
});

const ON_SCREEN_ONLY = `<!doctype html><style>
  .spacer { height: 2400px; }
  .reveal { visibility: hidden; }
  .reveal.on { visibility: visible; }
</style><main><h1>Top</h1><div class="spacer"></div><section class="reveal"><button>Request access</button></section><div class="spacer"></div></main>
<script>
  const io = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle("on", e.isIntersecting)));
  io.observe(document.querySelector(".reveal"));
</script>`;

test("a control shown only while its section is on screen counts, wherever the page is scrolled", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(ON_SCREEN_ONLY);
    const names = async () => (await page.evaluate(collectPage, {})).actionables.map((/** @type {any} */ e) => e.name);
    assert.deepEqual(await names(), []);
    // Just enough of the instrumentation for revealAll's settling.
    const inst = /** @type {any} */ ({ log: { navigations: [] }, networkQuiet: () => true, navigationQuiet: () => true });
    await revealAll(page, inst, /** @type {any} */ ({ ignore: { selectors: [] } }));
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.deepEqual(await names(), ["Request access"]);
  } finally {
    await browser.close();
  }
});
