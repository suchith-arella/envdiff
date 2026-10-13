/*
 * The Insights app: plain JavaScript with a hash router, built the way many
 * Angular apps are (useHash routing, a token in sessionStorage, grids and
 * charts on every page). REGRESSION marks the candidate's deliberate breakage.
 */
(function () {
  "use strict";
  var CAND = window.APP.variant === "candidate";
  var TOKEN = "insights.token";
  var root = document.getElementById("root");
  var USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  var USD0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  var me = null;
  var grids = [];
  var charts = [];

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function api(path, opts) {
    opts = opts || {};
    var token = sessionStorage.getItem(TOKEN);
    var headers = {};
    if (opts.body) headers["content-type"] = "application/json";
    if (token) headers.authorization = "Bearer " + token;
    return fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(function (res) {
      if (res.status === 401 && token && !opts.login) {
        sessionStorage.removeItem(TOKEN);
        me = null;
        location.hash = "#/login";
        throw new Error("Your session has ended");
      }
      return res.json().catch(function () {
        return {};
      }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "Request failed with status code " + res.status);
        return data;
      });
    });
  }

  function clear() {
    grids.forEach(function (g) {
      g.destroy();
    });
    charts.forEach(function (c) {
      c.destroy();
    });
    grids = [];
    charts = [];
  }

  function header(withUser) {
    return (
      '<header><span class="brand">Insights</span><span class="spacer"></span>' +
      (withUser
        ? '<button type="button" id="user-button" aria-haspopup="menu" aria-expanded="false">' + esc(me ? me.name : "Account") + "</button>" +
          '<div id="user-menu" role="menu" hidden><a role="menuitem" href="#/profile">Profile</a><button role="menuitem" type="button" id="logout">Log out</button></div>'
        : "") +
      "</header>"
    );
  }

  function shell(active, content) {
    var links = [
      ["/dashboard", "Dashboard"],
      ["/orders", "Orders"],
      ["/reports", "Reports"],
    ];
    if (me && me.role === "admin") links.push(["/admin", "Admin"]);
    root.innerHTML =
      header(true) +
      '<div class="layout"><nav class="side" aria-label="Main">' +
      links
        .map(function (l) {
          return '<a href="#' + l[0] + '"' + (l[0] === active ? ' class="active" aria-current="page"' : "") + ">" + l[1] + "</a>";
        })
        .join("") +
      '</nav><main id="main">' +
      content +
      "</main></div>";
    var button = document.getElementById("user-button");
    var menu = document.getElementById("user-menu");
    button.addEventListener("click", function () {
      menu.hidden = !menu.hidden;
      button.setAttribute("aria-expanded", String(!menu.hidden));
    });
    document.getElementById("logout").addEventListener("click", function () {
      sessionStorage.removeItem(TOKEN);
      me = null;
      location.hash = "#/";
    });
  }

  function grid(el, options) {
    var g = agGrid.createGrid(
      el,
      Object.assign(
        {
          defaultColDef: { sortable: true, filter: true, resizable: true, flex: 1, minWidth: 110 },
          animateRows: false,
        },
        options,
      ),
    );
    grids.push(g);
    return g;
  }

  // ---- views ----------------------------------------------------------------

  function landing() {
    root.innerHTML =
      header(false) +
      '<div class="hero"><h1>Insights</h1><p class="muted">Sales analytics for your whole team: orders, revenue and reports in one place.</p>' +
      '<a class="login-link" href="#/login">Login</a></div>' +
      // An email field that is not a login, next to the link to the one that is.
      '<form class="contact-form" novalidate><h2>Contact us</h2>' +
      '<label for="contact-first-name">First name</label><input id="contact-first-name" name="firstName">' +
      '<label for="contact-email">Email</label><input id="contact-email" name="email" type="email">' +
      '<label for="contact-message">Message</label><textarea id="contact-message" name="message"></textarea>' +
      '<div class="row"><button class="btn" type="button">Submit</button></div></form>';
  }

  function login() {
    root.innerHTML =
      header(false) +
      '<div class="login-card"><h1>Sign in</h1><form id="login-form" novalidate>' +
      '<label for="email-address">Email</label><input id="email-address" name="useremail" type="email" placeholder="Email" autocomplete="username">' +
      '<label for="password">Password</label><input id="password" name="password" type="password" placeholder="Password" autocomplete="current-password">' +
      '<p><label><input type="checkbox" id="default-screen"> Set this page as the default screen</label></p>' +
      '<div id="login-error"></div>' +
      '<div class="row"><button class="btn" type="submit">Sign In</button>' +
      '<button class="btn secondary" type="button" id="forgot">Forgot your password?</button>' +
      '<button class="btn secondary" type="button" id="close">Close</button></div></form></div>';
    var form = document.getElementById("login-form");
    var error = document.getElementById("login-error");
    document.getElementById("close").addEventListener("click", function () {
      location.hash = "#/";
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      error.innerHTML = "";
      api("/api/login", {
        method: "POST",
        login: true,
        body: { email: document.getElementById("email-address").value, password: document.getElementById("password").value },
      })
        .then(function (r) {
          if (r.otp) return askForCode(r.ticket);
          signedIn(r);
        })
        .catch(function (err) {
          error.innerHTML = '<div class="alert alert-danger" role="alert">' + esc(err.message) + "</div>";
        });
    });
  }

  function askForCode(ticket) {
    var card = document.querySelector(".login-card");
    card.innerHTML =
      '<h1>Two-step verification</h1><form id="otp-form" novalidate><label for="otp">Verification code</label>' +
      '<input id="otp" name="code" type="text" inputmode="numeric" autocomplete="one-time-code">' +
      '<div id="otp-error"></div><div class="row"><button class="btn" type="submit">Verify</button></div></form>';
    document.getElementById("otp-form").addEventListener("submit", function (e) {
      e.preventDefault();
      api("/api/login/otp", { method: "POST", login: true, body: { ticket: ticket, code: document.getElementById("otp").value } })
        .then(signedIn)
        .catch(function (err) {
          document.getElementById("otp-error").innerHTML = '<div class="alert alert-danger" role="alert">' + esc(err.message) + "</div>";
        });
    });
  }

  function signedIn(r) {
    sessionStorage.setItem(TOKEN, r.token);
    me = r.user;
    location.hash = "#/dashboard";
  }

  function dashboard() {
    shell(
      "/dashboard",
      '<h1>Dashboard</h1><div class="tiles" id="kpis"><div class="tile"><div class="label">Revenue</div><div class="value">…</div></div></div>' +
        '<div class="card"><div id="revenue-chart" class="chart"></div></div>' +
        '<h2>Top products</h2><div id="products" class="grid small"></div>',
    );
    var products = grid(document.getElementById("products"), {
      loading: true,
      columnDefs: [
        { field: "rank", headerName: "Rank", maxWidth: 100 },
        { field: "product", headerName: "Product" },
        { field: "units", headerName: "Units", type: "numericColumn" },
        { field: "revenue", headerName: "Revenue", type: "numericColumn", valueFormatter: function (p) { return USD.format(p.value); } },
      ],
    });
    return Promise.all([
      api("/api/kpis").then(function (k) {
        document.getElementById("kpis").innerHTML = [
          ["Revenue", USD0.format(k.revenue)],
          ["Orders", String(k.orders)],
          ["Average order", USD.format(k.average)],
        ]
          .map(function (t) {
            return '<div class="tile"><div class="label">' + t[0] + '</div><div class="value">' + esc(t[1]) + "</div></div>";
          })
          .join("");
      }),
      api("/api/revenue").then(function (r) {
        var series = [{ name: "Revenue", data: r.revenue }];
        // REGRESSION: the Target series no longer reaches the chart.
        if (!CAND) series.push({ name: "Target", data: r.target });
        charts.push(
          Highcharts.chart("revenue-chart", {
            chart: { type: "line", height: 320 },
            title: { text: "Monthly revenue" },
            xAxis: { categories: r.months },
            yAxis: { title: { text: "Revenue (USD)" } },
            tooltip: {
              formatter: CAND
                ? // REGRESSION: the tooltip lost its currency format.
                  function () {
                    return "<b>" + this.x + "</b><br/>" + this.series.name + ": " + this.y;
                  }
                : function () {
                    return "<b>" + this.x + "</b><br/>" + this.series.name + ": " + USD0.format(this.y);
                  },
            },
            series: series,
          }),
        );
      }),
      api("/api/products").then(function (rows) {
        products.setGridOption("rowData", rows);
        products.setGridOption("loading", false);
      }),
    ]);
  }

  function orders() {
    shell(
      "/orders",
      '<h1>Orders</h1><div class="toolbar"><input type="search" id="order-search" placeholder="Search orders" aria-label="Search orders">' +
        '<button class="btn secondary" type="button" id="export">Export CSV</button></div><div id="orders-grid" class="grid"></div>',
    );
    var columns = [
      { field: "id", headerName: "Order ID", maxWidth: 130 },
      // REGRESSION: the candidate can't sort by customer any more.
      { field: "customer", headerName: "Customer", sortable: !CAND },
    ];
    // REGRESSION: the Region column is gone on the candidate.
    if (!CAND) columns.push({ field: "region", headerName: "Region" });
    columns.push(
      { field: "status", headerName: "Status" },
      {
        field: "amount",
        headerName: "Amount",
        type: "numericColumn",
        // REGRESSION: amounts lose their currency format on the candidate.
        valueFormatter: CAND
          ? undefined
          : function (p) {
              return USD.format(p.value);
            },
      },
      { field: "date", headerName: "Date" },
    );
    var g = grid(document.getElementById("orders-grid"), {
      loading: true,
      columnDefs: columns,
      pagination: true,
      paginationPageSize: 20,
      paginationPageSizeSelector: [20, 50, 100],
    });
    document.getElementById("order-search").addEventListener("input", function (e) {
      // REGRESSION: the candidate's search box filters nothing.
      if (!CAND) g.setGridOption("quickFilterText", e.target.value);
    });
    document.getElementById("export").addEventListener("click", function () {
      g.exportDataAsCsv({ fileName: "orders.csv" });
    });
    return api("/api/orders")
      .then(function (rows) {
        // The candidate's environment is slower: rows arrive, then the app
        // takes its time before the grid shows them.
        return sleep(CAND ? 900 : 150).then(function () {
          return rows;
        });
      })
      .then(function (rows) {
        g.setGridOption("rowData", rows);
        g.setGridOption("loading", false);
      });
  }

  function reports() {
    shell(
      "/reports",
      '<h1>Reports</h1><div class="toolbar"><label for="range">Date range</label><select id="range">' +
        '<option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="year">This year</option></select>' +
        '<button class="btn" type="button" id="apply">Apply</button></div><p class="muted" id="range-note">Showing last 7 days</p>' +
        '<div id="report-error"></div><div class="card"><div id="sales-chart" class="chart"></div></div>',
    );
    var range = document.getElementById("range");
    var load = function () {
      var value = range.value;
      document.getElementById("report-error").innerHTML = "";
      return api("/api/sales?range=" + value)
        .then(function (r) {
          charts.forEach(function (c) {
            c.destroy();
          });
          charts = [];
          document.getElementById("range-note").textContent = "Showing " + range.options[range.selectedIndex].text.toLowerCase();
          charts.push(
            Highcharts.chart("sales-chart", {
              chart: { type: "column", height: 320 },
              title: { text: "Sales by region" },
              xAxis: { categories: r.regions },
              yAxis: { title: { text: "Orders" } },
              series: [
                { name: "Online", data: r.online },
                { name: "Retail", data: r.retail },
              ],
            }),
          );
        })
        .catch(function () {
          document.getElementById("report-error").innerHTML = '<div class="alert alert-danger" role="alert">Something went wrong loading the report.</div>';
        });
    };
    document.getElementById("apply").addEventListener("click", load);
    return load();
  }

  function admin() {
    if (!me || me.role !== "admin") {
      shell("/admin", "<h1>Admin</h1><p>You don't have access to this page.</p>");
      return;
    }
    shell("/admin", '<h1>Admin</h1><h2>Users</h2><div id="users-grid" class="grid small"></div>');
    var g = grid(document.getElementById("users-grid"), {
      loading: true,
      columnDefs: [
        { field: "name", headerName: "Name" },
        { field: "email", headerName: "Email" },
        { field: "role", headerName: "Role" },
        { field: "mfa", headerName: "Two-step" },
      ],
    });
    return api("/api/users").then(function (rows) {
      g.setGridOption("rowData", rows);
      g.setGridOption("loading", false);
    });
  }

  function profile() {
    shell("/profile", "<h1>Profile</h1><p>" + esc(me ? me.name : "") + "</p><p class=\"muted\">" + esc(me ? me.email : "") + "</p>");
  }

  function notFound() {
    shell("", "<h1>Page not found</h1>");
  }

  var VIEWS = { "/": landing, "/login": login, "/dashboard": dashboard, "/orders": orders, "/reports": reports, "/admin": admin, "/profile": profile };

  function render() {
    clear();
    var path = (location.hash.replace(/^#/, "") || "/").split("?")[0] || "/";
    var authed = !!sessionStorage.getItem(TOKEN);
    if (!authed && path !== "/" && path !== "/login") {
      location.hash = "#/login";
      return;
    }
    if (authed && (path === "/" || path === "/login")) {
      location.hash = "#/dashboard";
      return;
    }
    var ready = authed && !me ? api("/api/me").then(function (u) { me = u; }) : Promise.resolve();
    ready
      .then(function () {
        return (VIEWS[path] || notFound)();
      })
      .catch(function () {
        // the session ended; api() went to the login page
      });
  }

  window.addEventListener("hashchange", render);
  render();
})();
