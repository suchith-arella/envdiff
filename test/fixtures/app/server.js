/**
 * "Insights": a single-page analytics app used to test envdiff against the
 * kind of app it is mostly pointed at — hash routes, a login, data grids
 * (real AG Grid) and charts (a stand-in that renders the same DOM as
 * Highcharts).
 *
 *   baseline   the known-good version
 *   candidate  the same app with deliberate regressions, each marked
 *              REGRESSION in client.js, that envdiff is expected to catch
 *
 * The two variants get different data by default, as UAT and production do;
 * pass the same `dataSeed` to both to compare like with like.
 *
 *   node test/fixtures/app/server.js --variant candidate --port 4202
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// The browser bundle, next to the package's entry point (dist/package/main.cjs.js).
const AG_GRID = fs.readFileSync(path.join(path.dirname(require.resolve("ag-grid-community")), "..", "ag-grid-community.min.js"));
const CLIENT = fs.readFileSync(path.join(here, "client.js"));
const CHARTS = fs.readFileSync(path.join(here, "charts.js"));

/** Test users. Passwords are for this fixture only. */
export const USERS = {
  "qa@example.com": { password: "Qa-pass-1", name: "Quinn Analyst", role: "analyst" },
  "admin@example.com": { password: "Admin-pass-1", name: "Ada Admin", role: "admin" },
  "otp@example.com": { password: "Otp-pass-1", name: "Otto Twostep", role: "analyst", totp: "JBSWY3DPEHPK3PXP" },
};

/** @param {string} secret @param {number} time */
function totpAt(secret, time) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of secret) {
    value = ((value << 5) | alphabet.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

/** Small deterministic generator, so a seed always gives the same data. @param {number} seed */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 12;
    return (s >>> 0) / 4294967296;
  };
}

const CUSTOMERS = ["Acme Corp", "Globex", "Initech", "Umbrella", "Stark Industries", "Wayne Enterprises", "Wonka", "Hooli", "Vandelay", "Soylent"];
const REGIONS = ["West", "East", "North", "South"];
const STATUSES = ["Open", "Shipped", "Delivered", "Returned"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];

/** @param {number} seed */
function makeData(seed) {
  const r = rng(seed);
  const orders = Array.from({ length: 60 }, (_, i) => ({
    id: `SO-${1001 + i}`,
    customer: CUSTOMERS[Math.floor(r() * CUSTOMERS.length)],
    region: REGIONS[Math.floor(r() * REGIONS.length)],
    status: STATUSES[Math.floor(r() * STATUSES.length)],
    amount: Math.round((200 + r() * 9800) * 100) / 100,
    date: `2026-0${1 + Math.floor(r() * 6)}-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}`,
  }));
  const revenue = MONTHS.map(() => Math.round(8000 + r() * 9000));
  const target = MONTHS.map((_, i) => 10000 + i * 800);
  /** @param {number} n */
  const sales = (n) => REGIONS.map(() => [Math.round(n * (0.5 + r())), Math.round(n * (0.4 + r()))]);
  return {
    orders,
    revenue,
    target,
    sales: { "7d": sales(40), "30d": sales(160), year: sales(2000) },
    products: ["Analytics Pro", "Data Hub", "Insight Lite", "Report Pack", "Grid Plus"].map((name, i) => ({
      product: name,
      units: Math.round(50 + r() * 400),
      revenue: Math.round((5000 + r() * 40000) * 100) / 100,
      rank: i + 1,
    })),
  };
}

/**
 * @param {"baseline"|"candidate"} variant
 * @param {{ dataSeed?: number, sessionTtlMs?: number }} [opts]
 *   sessionTtlMs: sessions end after this long, as real ones do.
 */
export function createApp(variant, opts = {}) {
  const cand = variant === "candidate";
  const data = makeData(opts.dataSeed ?? (cand ? 2 : 1));
  /** @type {Map<string, { email: string, expires: number }>} */
  const sessions = new Map();
  /** @type {Map<string, string>} one-time-code tickets → email */
  const tickets = new Map();
  /** Seen by tests: how often each user logged in. */
  const logins = /** @type {Record<string, number>} */ ({});

  const page = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Insights</title>
<style>
  * { box-sizing: border-box; }
  body { font: 14px/1.45 system-ui, sans-serif; margin: 0; color: #1f2933; background: #f5f7fa; }
  header { display: flex; align-items: center; gap: 16px; background: #102a43; color: #fff; padding: 10px 20px; height: 52px; }
  header .brand { font-weight: 700; font-size: 18px; }
  header .spacer { flex: 1; }
  header a, header button { color: #fff; }
  header button { background: none; border: 1px solid #ffffff55; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  #user-menu { position: absolute; right: 16px; top: 50px; background: #fff; color: #222; border: 1px solid #ccd; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 4px; z-index: 10; }
  #user-menu[hidden] { display: none; }
  #user-menu a, #user-menu button { color: #222; border: 0; text-align: left; background: none; }
  .layout { display: flex; min-height: calc(100vh - 52px); }
  nav.side { width: 190px; background: #fff; border-right: 1px solid #dde3ea; padding: 16px 0; }
  nav.side a { display: block; padding: 8px 20px; color: #243b53; text-decoration: none; }
  nav.side a.active { background: #e6f0ff; font-weight: 600; }
  main { flex: 1; padding: 20px 24px; min-width: 0; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  h2 { font-size: 16px; margin: 24px 0 10px; }
  .tiles { display: flex; gap: 14px; flex-wrap: wrap; }
  .tile { background: #fff; border: 1px solid #dde3ea; border-radius: 8px; padding: 14px 18px; min-width: 180px; }
  .tile .label { color: #627d98; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .tile .value { font-size: 22px; font-weight: 700; }
  .card { background: #fff; border: 1px solid #dde3ea; border-radius: 8px; padding: 14px; margin-top: 16px; }
  .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .toolbar input, .toolbar select { padding: 6px 8px; border: 1px solid #bcccdc; border-radius: 6px; font: inherit; }
  .btn { background: #2f6fed; color: #fff; border: 0; border-radius: 6px; padding: 7px 14px; cursor: pointer; font: inherit; }
  .btn.secondary { background: #fff; color: #2f6fed; border: 1px solid #2f6fed; }
  .grid { height: 420px; }
  .grid.small { height: 260px; }
  .chart { width: 100%; }
  .alert { padding: 10px 12px; border-radius: 6px; margin: 10px 0; }
  .alert-danger { background: #ffe3e3; color: #a61b1b; }
  .login-card { max-width: 380px; margin: 60px auto; background: #fff; border: 1px solid #dde3ea; border-radius: 10px; padding: 26px; }
  .login-card label { display: block; margin: 12px 0 4px; font-weight: 600; }
  .login-card input[type=email], .login-card input[type=password], .login-card input[type=text] { width: 100%; padding: 8px 10px; border: 1px solid #bcccdc; border-radius: 6px; font: inherit; }
  .login-card .row { display: flex; gap: 8px; margin-top: 16px; align-items: center; }
  .hero { max-width: 640px; margin: 60px auto; text-align: center; }
  .hero a.login-link { display: inline-block; margin-top: 18px; }
  .muted { color: #627d98; }
</style>
<script>window.APP = ${JSON.stringify({ variant })};</script>
<script src="/vendor/ag-grid.js"></script>
<script src="/vendor/charts.js"></script>
</head><body><div id="root"></div><script src="/app.js"></script></body></html>`;

  /** @param {http.IncomingMessage} req */
  const userOf = (req) => {
    const m = /^Bearer (\w+)$/.exec(String(req.headers.authorization ?? ""));
    const s = m ? sessions.get(m[1]) : undefined;
    if (!s) return null;
    if (opts.sessionTtlMs && Date.now() > s.expires) {
      sessions.delete(/** @type {RegExpExecArray} */ (m)[1]);
      return null;
    }
    return { email: s.email, ...USERS[/** @type {keyof typeof USERS} */ (s.email)] };
  };
  /** @param {string} email */
  const startSession = (email) => {
    const token = randomBytes(16).toString("hex");
    sessions.set(token, { email, expires: Date.now() + (opts.sessionTtlMs ?? 0) });
    logins[email] = (logins[email] ?? 0) + 1;
    const u = USERS[/** @type {keyof typeof USERS} */ (email)];
    return { token, user: { email, name: u.name, role: u.role } };
  };

  /** @param {http.IncomingMessage} req @returns {Promise<any>} */
  const body = (req) =>
    new Promise((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(s || "{}"));
        } catch {
          resolve({});
        }
      });
    });

  /** @type {http.RequestListener} */
  const handler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const json = (/** @type {number} */ status, /** @type {any} */ value, delay = 0) =>
      setTimeout(() => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(value));
      }, delay);

    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page());
    }
    if (p === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(CLIENT);
    }
    if (p === "/vendor/ag-grid.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=3600" });
      return res.end(AG_GRID);
    }
    if (p === "/vendor/charts.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(CHARTS);
    }
    if (p === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    if (p === "/api/login" && req.method === "POST") {
      const { email, password } = await body(req);
      const u = USERS[/** @type {keyof typeof USERS} */ (String(email ?? "").toLowerCase())];
      if (!u || u.password !== password) return json(401, { error: "Invalid email or password" }, 150);
      if ("totp" in u) {
        const ticket = randomBytes(8).toString("hex");
        tickets.set(ticket, String(email).toLowerCase());
        return json(200, { otp: true, ticket }, 100);
      }
      return json(200, startSession(String(email).toLowerCase()), 150);
    }
    if (p === "/api/login/otp" && req.method === "POST") {
      const { ticket, code } = await body(req);
      const email = tickets.get(String(ticket));
      const u = email ? USERS[/** @type {keyof typeof USERS} */ (email)] : null;
      const now = Date.now();
      const ok = u && "totp" in u && [now - 30000, now, now + 30000].some((t) => totpAt(/** @type {string} */ (u.totp), t) === String(code));
      if (!ok || !email) return json(401, { error: "That code is incorrect" }, 100);
      tickets.delete(String(ticket));
      return json(200, startSession(email), 100);
    }

    if (p.startsWith("/api/")) {
      const user = userOf(req);
      if (!user) return json(401, { error: "Not signed in" });
      if (p === "/api/me") return json(200, { email: user.email, name: user.name, role: user.role });
      if (p === "/api/kpis") {
        const total = data.orders.reduce((s, o) => s + o.amount, 0);
        return json(200, { revenue: total, orders: data.orders.length, average: total / data.orders.length }, 120);
      }
      if (p === "/api/orders") return json(200, data.orders, 250);
      if (p === "/api/products") return json(200, data.products, 150);
      if (p === "/api/revenue") return json(200, { months: MONTHS, revenue: data.revenue, target: data.target }, 200);
      if (p === "/api/sales") {
        const range = /** @type {"7d"|"30d"|"year"} */ (url.searchParams.get("range") ?? "7d");
        // REGRESSION: the candidate's sales report fails for the 30-day range.
        if (cand && range === "30d") return json(500, { error: "Internal Server Error" }, 120);
        const rows = data.sales[range] ?? data.sales["7d"];
        return json(200, { regions: REGIONS, online: rows.map((r) => r[0]), retail: rows.map((r) => r[1]) }, 180);
      }
      if (p === "/api/users") {
        if (user.role !== "admin") return json(403, { error: "Forbidden" });
        return json(200, Object.entries(USERS).map(([email, u]) => ({ email, name: u.name, role: u.role, mfa: "totp" in u ? "Yes" : "No" })), 120);
      }
      return json(404, { error: "Not found" });
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  };
  return { handler, sessions, logins };
}

/**
 * @param {{ variant: "baseline"|"candidate", port?: number, dataSeed?: number, sessionTtlMs?: number }} o
 * @returns {Promise<{ url: string, close: () => Promise<void>, app: ReturnType<typeof createApp> }>}
 */
export function startApp({ variant, port = 0, dataSeed, sessionTtlMs }) {
  const app = createApp(variant, { dataSeed, sessionTtlMs });
  const server = http.createServer(app.handler);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        app,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const arg = (/** @type {string} */ name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const variant = arg("variant") === "candidate" ? "candidate" : "baseline";
  const { url } = await startApp({ variant, port: Number(arg("port") ?? (variant === "candidate" ? 4202 : 4201)), dataSeed: arg("seed") ? Number(arg("seed")) : undefined });
  console.log(`${variant}: ${url}`);
}
