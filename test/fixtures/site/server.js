/**
 * A small shop used to test envdiff end to end. Two variants:
 *
 *   baseline   — the known-good version
 *   candidate  — the same site with deliberate regressions, each marked
 *                REGRESSION below, that envdiff is expected to catch
 *
 *   node test/fixtures/site/server.js --variant candidate --port 4102
 */
import http from "node:http";
import { PNG } from "pngjs";

const PRODUCTS = [
  { id: 1, name: "Blue shirt", price: 20 },
  { id: 2, name: "Red hat", price: 15 },
  { id: 3, name: "Green scarf", price: 12 },
  { id: 4, name: "Yellow socks", price: 5 },
];

function teamPng() {
  const png = new PNG({ width: 120, height: 80 });
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 120; x++) {
      const i = (y * 120 + x) * 4;
      png.data[i] = 40 + x;
      png.data[i + 1] = 90 + y;
      png.data[i + 2] = 200;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
const TEAM = teamPng();

/** @param {"baseline"|"candidate"} variant */
export function createSite(variant) {
  const cand = variant === "candidate";

  const layout = (/** @type {string} */ title, /** @type {string} */ main, /** @type {string} */ script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Acme</title><meta name="description" content="Acme sells things.">
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; color: #222; }
  header { background: #1d2a44; padding: 12px 20px; }
  header nav { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  header a, header button { color: #fff; }
  header button { background: none; border: 1px solid #fff6; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  #menu { position: absolute; top: 52px; right: 20px; background: #fff; border: 1px solid #ccc; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
  #menu[hidden] { display: none; }
  #menu a, #menu button { color: #222; }
  main { padding: 20px; max-width: 900px; }
  .cta { background: ${cand ? "#d6336c" /* REGRESSION: style changed */ : "#2f6fed"}; color: #fff; border: 0; border-radius: 8px; padding: 10px 18px; font-size: 16px; cursor: pointer; }
  .promo { background: #fff3bf; padding: 14px; margin-bottom: 12px; ${cand ? "width: 640px;" /* REGRESSION: overflows on mobile */ : ""} }
  [role=dialog] { position: fixed; inset: 20% 25%; background: #fff; border: 2px solid #333; padding: 20px; }
  [role=tablist] button[aria-selected=true] { font-weight: bold; }
  .toast { background: #222; color: #fff; padding: 8px 12px; margin-top: 10px; display: inline-block; }
  footer { padding: 20px; color: #666; border-top: 1px solid #eee; }
</style></head>
<body>
<header><nav aria-label="Main">
  <a href="/">Home</a><a href="/products">Products</a><a href="/about">About</a>
  <a href="${cand ? "/contact-us" /* REGRESSION: link points at a page that doesn't exist */ : "/contact"}">Contact</a>
  <a href="/support">Support</a><a href="/dashboard">Dashboard</a>
  <button id="menu-btn" aria-haspopup="true" aria-expanded="false">Menu</button>
</nav>
<div id="menu" hidden><a href="/help">Help</a><button id="dark">Dark mode</button></div>
</header>
<main>${main}</main>
<footer>© Acme · Updated <span class="clock"></span> · <a href="/legacy">Legacy site</a></footer>
<script>
  const clock = document.querySelector('.clock');
  const tick = () => { clock.textContent = new Date().toLocaleTimeString('en-GB'); };
  tick(); setInterval(tick, 1000);
  const mb = document.getElementById('menu-btn'), menu = document.getElementById('menu');
  mb.addEventListener('click', () => { menu.hidden = !menu.hidden; mb.setAttribute('aria-expanded', String(!menu.hidden)); });
  document.getElementById('dark').addEventListener('click', () => { document.body.style.background = '#eee'; });
</script>
${script}
</body></html>`;

  /** @type {Record<string, (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>>} */
  const routes = {
    "/": (req, res) =>
      html(
        res,
        layout(
          "Home",
          `${cand ? `<div class="promo">Free shipping this week only!</div>` /* REGRESSION: new banner shifts content */ : ""}
<h1>Welcome to Acme</h1>
<p>Quality things for quality people.</p>
<p>Visitors online: <span class="visitors">${Math.floor(Math.random() * 100)}</span></p>
<button class="cta" id="subscribe">Subscribe</button>
<div role="dialog" aria-modal="true" aria-label="Join our newsletter" id="dlg" hidden>
  <h2>Join our newsletter</h2>
  <label>Email <input id="news-email" type="email"></label>
  <button id="signup">Sign up</button> <button id="close">Close</button>
  <p id="signup-msg"></p>
</div>
<h2>Featured</h2>
<div role="tablist" aria-label="Featured">
  <button role="tab" aria-selected="true" data-p="p1">Overview</button>
  <button role="tab" aria-selected="false" data-p="p2">Specs</button>
  <button role="tab" aria-selected="false" data-p="p3">Reviews</button>
</div>
<div id="p1" role="tabpanel">Our best sellers this season.</div>
<div id="p2" role="tabpanel" hidden>Cotton, wool and silk.</div>
<div id="p3" role="tabpanel" hidden>★★★★☆ from 120 reviews.</div>
<details><summary>Shipping info</summary><p>Ships in 2 days worldwide.</p></details>
<h2>More items</h2>
<ul id="items"><li>Item 1</li><li>Item 2</li></ul>
<button id="more">Load more</button>`,
          `<script>
  const dlg = document.getElementById('dlg');
  document.getElementById('subscribe').onclick = () => { dlg.hidden = false; };
  document.getElementById('close').onclick = () => { dlg.hidden = true; };
  document.getElementById('signup').onclick = async () => {
    const msg = document.getElementById('signup-msg');
    try { await fetch('/api/subscribe', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ email: 'x@y.z' }) }); msg.textContent = 'Thanks!'; }
    catch { msg.textContent = 'Could not sign up right now.'; }
  };
  document.querySelectorAll('[role=tab]').forEach(t => t.onclick = () => {
    document.querySelectorAll('[role=tab]').forEach(o => o.setAttribute('aria-selected', String(o === t)));
    document.querySelectorAll('[role=tabpanel]').forEach(p => p.hidden = p.id !== t.dataset.p);
  });
  // Background polling, like a notifications badge. Not a response to any click.
  setInterval(() => { fetch('/api/notifications').catch(() => {}); }, 700);
  document.getElementById('more').onclick = async () => {
    const r = await fetch('/api/items?page=2');
    const data = await r.json();
    ${cand ? "const list = data.results.items;" /* REGRESSION: throws TypeError */ : "const list = data.items;"}
    for (const it of list) { const li = document.createElement('li'); li.textContent = it.name; document.getElementById('items').appendChild(li); }
  };
</script>`,
        ),
      ),

    "/products": (req, res) =>
      html(
        res,
        layout(
          "Products",
          `<h1>Products</h1>
<label>Sort by <select id="sort"><option value="name">Name</option><option value="price">Price</option></select></label>
<ul id="plist">${PRODUCTS.map((p) => `<li data-price="${p.price}"><a href="/products/${p.id}">${p.name}</a> — $${p.price}</li>`).join("")}</ul>
<h2>Recommended</h2><div id="recs">Loading…</div>`,
          `<script>
  ${cand ? "console.error('Failed to load recommendations widget');" /* REGRESSION: new console error */ : ""}
  document.getElementById('sort').addEventListener('change', (e) => {
    ${cand ? "return;" /* REGRESSION: sorting does nothing */ : ""}
    const ul = document.getElementById('plist');
    const items = [...ul.children];
    items.sort((a, b) => e.target.value === 'price' ? a.dataset.price - b.dataset.price : a.textContent.localeCompare(b.textContent));
    items.forEach(li => ul.appendChild(li));
  });
  fetch('/graphql', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ operationName: 'Recs', query: 'query Recs { recs { id name } }' }) })
    .then(r => r.json()).then(d => { document.getElementById('recs').textContent = d.data.recs.map(r => r.name).join(', '); })
    .catch(() => { document.getElementById('recs').textContent = 'Could not load recommendations'; });
</script>`,
        ),
      ),

    "/about": async (req, res) => {
      if (cand) await new Promise((r) => setTimeout(r, 1200)); // REGRESSION: slow
      html(
        res,
        layout(
          "About",
          `<h1>About us</h1>
<p>Acme was founded in 1999 by people who like things.</p>
<p>${cand ? "We ship to 12 countries." /* REGRESSION: copy changed */ : "We ship to 40 countries."}</p>
<img src="${cand ? "/img/team-v2.png" /* REGRESSION: broken image */ : "/img/team.png"}" ${cand ? "" /* REGRESSION: no alt */ : 'alt="Our team"'} width="120" height="80">`,
        ),
      );
    },

    "/support": (req, res) => {
      if (!cand) res.setHeader("X-Frame-Options", "DENY"); // REGRESSION: header dropped on candidate
      html(
        res,
        layout(
          "Support",
          `<h1>Support</h1>
<form id="support" name="support" action="/support" method="post">
  <label>Your name <input name="name" required></label>
  <label>Email <input name="email" ${cand ? 'type="text"' : 'type="email" required'}></label>
  <label>Message <textarea name="message" required></textarea></label>
  <button type="submit">Send</button>
</form>`,
        ),
      );
    },

    "/dashboard": (req, res) =>
      html(
        res,
        layout(
          "Dashboard",
          `<h1>Dashboard</h1>
<p id="hello">Loading profile…</p>
<button id="refresh">Refresh stats</button>
<div id="stats"></div>
<button id="tips">Show tips</button>
<div id="tip"></div>`,
          `<script>
  fetch('/api/profile').then(r => r.json()).then(p => { document.getElementById('hello').textContent = 'Hello, ' + p.name; });
  document.getElementById('refresh').onclick = async () => {
    const out = document.getElementById('stats');
    const r = await fetch('/api/stats');
    if (!r.ok) { out.textContent = 'Something went wrong. Please try again.'; return; }
    const s = await r.json();
    out.textContent = 'Visits: ' + s.visits + ' · Orders: ' + s.orders;
  };
  document.getElementById('tips').onclick = async () => {
    const r = await fetch('/api/tips');
    document.getElementById('tip').textContent = (await r.json()).tip;
  };
</script>`,
        ),
      ),

    "/contact": (req, res) => {
      if (cand) return notFound(res); // REGRESSION: page removed
      html(res, layout("Contact", `<h1>Contact</h1><p>Write to hello@acme.test</p>`));
    },

    "/help": (req, res) => html(res, layout("Help", `<h1>Help</h1><p>Read the FAQ.</p>`)),

    "/legacy": (req, res) => {
      if (cand) {
        // REGRESSION: server error
        res.writeHead(500, { "content-type": "text/html" });
        res.end("<h1>Internal Server Error</h1>");
        return;
      }
      html(res, layout("Legacy", `<h1>Legacy</h1><p>The old site lives on.</p>`));
    },

    "/img/team.png": (req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(TEAM);
    },

    "/api/items": (req, res) => json(res, { items: [{ id: 3, name: "Item 3" }, { id: 4, name: "Item 4" }] }),
    "/api/stats": (req, res) => (cand ? json(res, { error: "boom" }, 500) /* REGRESSION */ : json(res, { visits: 1234, orders: 56 })),
    "/api/profile": (req, res) =>
      json(
        res,
        cand
          ? { id: 1, name: "Ada", age: "36", address: { city: "London" } } // REGRESSION: email dropped, age now a string
          : { id: 1, name: "Ada", email: "ada@example.com", age: 36, address: { city: "London" } },
      ),
    "/api/cart": (req, res) => json(res, { ok: true }),
    "/api/notifications": (req, res) => json(res, { unread: 0 }),
    // Slower on the candidate, but not broken: must not be reported.
    "/api/tips": async (req, res) => {
      if (cand) await new Promise((r) => setTimeout(r, 3000));
      json(res, { tip: "Use the search box to find things faster." });
    },
    "/api/subscribe": (req, res) => json(res, { ok: true }),
    "/graphql": (req, res) => json(res, { data: { recs: [{ id: 2, name: "Red hat" }, { id: 3, name: "Green scarf" }] } }),
  };

  /** @param {URL} url */
  const productRoute = (url) => {
    const m = /^\/products\/(\d+)$/.exec(url.pathname);
    return m ? PRODUCTS.find((p) => p.id === Number(m[1])) : undefined;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const product = productRoute(url);
    if (product) {
      html(
        res,
        layout(
          product.name,
          `<h1>${product.name}</h1>
<p class="price">Price: ${cand && product.id === 1 ? "$NaN" /* REGRESSION: broken price */ : `$${product.price.toFixed(2)}`}</p>
<label>Quantity <input id="qty" type="number" value="1" min="1"></label>
<button id="add">Add to cart</button>
${cand ? "" /* REGRESSION: button removed */ : `<button id="wish">Add to wishlist</button>`}
<p id="msg" aria-live="polite"></p>`,
          `<script>
  const msg = document.getElementById('msg');
  document.getElementById('add').onclick = async () => {
    msg.textContent = 'Adding…';
    try {
      const body = ${cand ? "{ sku: " + product.id + " }" /* REGRESSION: quantity no longer sent */ : "{ sku: " + product.id + ", qty: Number(document.getElementById('qty').value) }"};
      const r = await fetch('/api/cart', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
      msg.textContent = r.ok ? 'Added to cart' : 'Could not add to cart';
    } catch { msg.textContent = 'Could not add to cart'; }
  };
  const wish = document.getElementById('wish');
  if (wish) wish.onclick = () => { msg.textContent = 'Saved to wishlist'; };
</script>`,
        ),
      );
      return;
    }
    const route = routes[url.pathname];
    if (!route) return notFound(res);
    try {
      await route(req, res, url);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
}

/** @param {http.ServerResponse} res @param {string} body */
function html(res, body) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}
/** @param {http.ServerResponse} res @param {unknown} body */
function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
/** @param {http.ServerResponse} res */
function notFound(res) {
  res.writeHead(404, { "content-type": "text/html" });
  res.end("<!doctype html><title>Not found</title><h1>Page not found</h1>");
}

/**
 * Start a site on a port (0 = any free port).
 * @param {{ variant: "baseline"|"candidate", port?: number }} opts
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startSite({ variant, port = 0 }) {
  const server = createSite(variant);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const variant = /** @type {"baseline"|"candidate"} */ (args[args.indexOf("--variant") + 1] ?? "baseline");
  const port = Number(args[args.indexOf("--port") + 1] ?? (variant === "baseline" ? 4101 : 4102));
  startSite({ variant, port }).then(({ url }) => console.log(`${variant} fixture on ${url}`));
}
