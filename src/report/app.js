/* envdiff report viewer. Plain browser JS; data is embedded in #envdiff-data. */
(function () {
  "use strict";

  var DATA = JSON.parse(document.getElementById("envdiff-data").textContent);
  var SEVS = ["critical", "major", "minor", "info"];
  var findingsById = new Map(DATA.findings.map(function (f) { return [f.id, f]; }));
  var app = document.getElementById("app");

  var state = {
    sev: new Set(["critical", "major", "minor"]),
    cat: "",
    q: "",
    ixAll: false,
    ixQ: "",
    pageQ: "",
  };

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function fmtMs(ms) {
    if (ms == null) return "–";
    return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
  }
  function fmtDuration(ms) {
    var s = Math.round(ms / 1000);
    return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
  }
  function pct(r) { return r == null ? "–" : (r * 100).toFixed(r < 0.01 ? 2 : 1) + "%"; }
  function pageIndexFor(key, viewport) {
    for (var i = 0; i < DATA.pages.length; i++) {
      var p = DATA.pages[i];
      if (p.key === key && (!viewport || p.viewport === viewport)) return i;
    }
    for (var j = 0; j < DATA.pages.length; j++) if (DATA.pages[j].key === key) return j;
    return -1;
  }
  function sevCounts(ids) {
    var c = { critical: 0, major: 0, minor: 0, info: 0 };
    (ids || []).forEach(function (id) { var f = findingsById.get(id); if (f) c[f.severity]++; });
    return c;
  }
  function badges(c) {
    var out = "";
    if (c.critical) out += '<span class="badge critical" title="critical">' + c.critical + "</span>";
    if (c.major) out += '<span class="badge major" title="major">' + c.major + "</span>";
    if (c.minor) out += '<span class="badge minor" title="minor">' + c.minor + "</span>";
    if (!out) out = '<span class="badge ok" title="no significant differences">✓</span>';
    return '<span class="badges">' + out + "</span>";
  }
  function statusHtml(s) {
    if (s.error) return '<span class="status-bad">' + esc(s.error) + "</span>";
    if (s.status == null) return '<span class="muted">–</span>';
    return '<span class="' + (s.status < 400 ? "status-ok" : "status-bad") + '">' + s.status + "</span>";
  }

  // ------------------------------------------------------------------ theme
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem("envdiff-theme");
    if (saved) root.setAttribute("data-theme", saved);
  } catch (e) {}
  document.getElementById("theme").addEventListener("click", function () {
    var dark = root.getAttribute("data-theme") === "dark" ||
      (!root.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    var next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("envdiff-theme", next); } catch (e) {}
  });

  // ------------------------------------------------------------------ header
  function renderHeader() {
    var m = DATA.meta, s = DATA.summary;
    document.getElementById("title").textContent = m.title;
    var v = document.getElementById("verdict");
    v.textContent = s.verdict === "fail" ? "FAIL" : "PASS";
    v.className = "verdict " + s.verdict;
    v.title = s.verdict === "fail" ? s.failing + " finding(s) at or above " + s.failOn : "Nothing at or above " + s.failOn;

    function env(lbl, e) {
      return '<div class="env"><div class="lbl">' + lbl + '</div><div class="name">' + esc(e.label) +
        (e.ref ? ' <span class="muted mono">' + esc(e.ref) + (e.sha ? " @ " + esc(e.sha.slice(0, 7)) : "") + "</span>" : "") +
        '</div><a class="url" href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.url) + "</a></div>";
    }
    var head = document.getElementById("head");
    var aiCard = "";
    if (DATA.ai && DATA.ai.summary) {
      aiCard = '<div class="card"><h3>AI triage <span class="muted small" style="text-transform:none;letter-spacing:0">' + esc(DATA.ai.model || "") + "</span></h3><div class=pad>" + esc(DATA.ai.summary) + "</div></div>";
    } else if (DATA.ai && DATA.ai.error) {
      aiCard = '<div class="banner">AI triage was requested but did not run: ' + esc(DATA.ai.error) + "</div>";
    }
    head.innerHTML =
      '<div class="envs">' + env("Baseline", m.baseline) + '<div class="arrow">→</div>' + env("Candidate", m.candidate) + "</div>" +
      '<div class="runline"><span>' + esc(new Date(m.startedAt).toLocaleString()) + "</span><span>" + fmtDuration(m.durationMs) +
      "</span><span>" + esc(m.viewports.join(", ")) + "</span><span>" + esc(m.browser) + "</span><span>mutations " + esc(m.settings.mutations) +
      "</span><span>fails on " + esc(s.failOn) + "</span></div>" +
      (m.aborted ? '<div class="banner">' + esc(m.aborted) + "</div>" : "") +
      (DATA.errors && DATA.errors.length ? '<div class="banner">' + plural(DATA.errors.length, "page") + ' could not be processed. See <a href="#run">Run info</a>.</div>' : "") +
      aiCard +
      '<div class="tiles">' +
      SEVS.map(function (sev) {
        return '<button class="tile sev-' + sev + (s.counts[sev] ? "" : " zero") + '" data-sev="' + sev + '"><div class="n">' + s.counts[sev] + '</div><div class="l">' + sev + "</div></button>";
      }).join("") +
      '<a class="tile" href="#pages"><div class="n">' + s.pages + '</div><div class="l">pages</div></a>' +
      '<a class="tile" href="#interactions"><div class="n">' + s.interactionsDifferent + '<span class="muted" style="font-size:15px;font-weight:600"> / ' + s.interactions + '</span></div><div class="l">interactions differ</div></a>' +
      '<a class="tile" href="#journeys"><div class="n">' + s.journeys + '</div><div class="l">journeys</div></a>' +
      "</div>";
    head.querySelectorAll("[data-sev]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.sev = new Set([b.getAttribute("data-sev")]);
        location.hash = "findings";
        route();
      });
    });
  }

  // -------------------------------------------------------------------- tabs
  function tabs(active) {
    var s = DATA.summary;
    var items = [
      ["findings", "Findings", DATA.findings.length],
      ["pages", "Pages", DATA.pages.length],
      ["interactions", "Interactions", s.interactions],
      ["journeys", "Journeys", s.journeys],
      ["api", "API", DATA.api.length],
      ["run", "Run info", null],
    ];
    return '<nav class="tabs">' + items.map(function (t) {
      return '<a href="#' + t[0] + '" class="' + (t[0] === active ? "on" : "") + '">' + t[1] + (t[2] != null ? '<span class="count">' + t[2] + "</span>" : "") + "</a>";
    }).join("") + "</nav>";
  }

  // ---------------------------------------------------------------- findings
  function whereOf(f) {
    if (f.journey) return "journey: " + f.journey;
    return (f.page || "") + (f.viewport && DATA.meta.viewports.length > 1 ? " · " + f.viewport : "");
  }
  function findingRows(list, compact) {
    if (!list.length) return '<tr><td colspan="4" class="empty"><b>Nothing here</b>No findings match these filters.</td></tr>';
    return list.map(function (f) {
      return '<tr class="row" data-id="' + f.id + '"><td style="width:90px"><span class="sev ' + f.severity + '">' + f.severity + '</span></td><td class="ftitle">' + esc(f.title) +
        (f.ai ? '<span class="ai-tag" title="' + esc(f.ai.explanation) + '">AI: ' + esc(f.ai.verdict.replace(/_/g, " ")) + "</span>" : "") +
        (compact ? '</td><td class="cat">' + esc(f.category) + "</td></tr>" :
        '</td><td class="where">' + esc(whereOf(f)) + '</td><td class="cat">' + esc(f.category) + "</td></tr>");
    }).join("");
  }
  function findingDetail(f) {
    var kv = [["Type", f.type], ["Id", f.id]];
    if (f.page) {
      var pi = pageIndexFor(f.page, f.viewport);
      kv.push(["Page", pi >= 0 ? '<a href="#pages/' + pi + '">' + esc(f.page) + "</a>" : esc(f.page), true]);
    }
    if (f.viewport) kv.push(["Viewport", f.viewport]);
    if (f.journey) kv.push(["Journey", f.journey]);
    if (f.element) kv.push(["Element", f.element.role + (f.element.name ? ' "' + f.element.name + '"' : "") + (f.element.cssPath ? "  ·  " + f.element.cssPath : "")]);
    if (f.baseline != null) kv.push(["Baseline", typeof f.baseline === "string" ? f.baseline : JSON.stringify(f.baseline)]);
    if (f.candidate != null) kv.push(["Candidate", typeof f.candidate === "string" ? f.candidate : JSON.stringify(f.candidate)]);
    if (f.ai) kv.push(["AI triage", f.ai.verdict.replace(/_/g, " ") + " (" + Math.round(f.ai.confidence * 100) + "%): " + f.ai.explanation]);
    var html = '<dl class="kv">' + kv.map(function (x) {
      return "<dt>" + esc(x[0]) + "</dt><dd>" + (x[2] ? x[1] : esc(x[1])) + "</dd>";
    }).join("") + "</dl>";
    if (f.detail) html += "<pre>" + esc(f.detail) + "</pre>";
    if (f.evidence && (f.evidence.baseline || f.evidence.candidate)) html += thumbs(f.evidence, f.title);
    html += '<div class="small muted">To accept this difference in future runs, add <code>' + esc(f.id) + "</code> to <code>ignore.findings</code>.</div>";
    return html;
  }
  function thumbs(ev, title) {
    var parts = [["baseline", "Baseline"], ["candidate", "Candidate"], ["diff", "Diff"]].filter(function (x) { return ev[x[0]]; });
    return '<div class="thumbs">' + parts.map(function (x) {
      return '<button class="thumb" data-open=\'' + esc(JSON.stringify({ b: ev.baseline, c: ev.candidate, d: ev.diff, t: title, m: x[0] === "diff" ? "diff" : "side" })) +
        '\'><img loading="lazy" src="' + esc(ev[x[0]]) + '" alt=""><span>' + x[1] + "</span></button>";
    }).join("") + "</div>";
  }
  function bindRows(container) {
    container.querySelectorAll("tr.row[data-id]").forEach(function (tr) {
      tr.addEventListener("click", function () {
        var next = tr.nextElementSibling;
        if (next && next.classList.contains("detail")) { next.remove(); return; }
        var f = findingsById.get(tr.getAttribute("data-id"));
        var d = el('<table><tr class="detail"><td colspan="4">' + findingDetail(f) + "</td></tr></table>").querySelector("tr");
        tr.after(d);
        bindThumbs(d);
      });
    });
    bindThumbs(container);
  }
  function bindThumbs(container) {
    container.querySelectorAll("[data-open]").forEach(function (b) {
      if (b._bound) return;
      b._bound = true;
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var o = JSON.parse(b.getAttribute("data-open"));
        openModal(o);
      });
    });
  }

  function renderFindings() {
    var cats = Array.from(new Set(DATA.findings.map(function (f) { return f.category; }))).sort();
    var q = state.q.toLowerCase();
    var list = DATA.findings.filter(function (f) {
      if (!state.sev.has(f.severity)) return false;
      if (state.cat && f.category !== state.cat) return false;
      if (q && (f.title + " " + (f.page || "") + " " + (f.journey || "") + " " + (f.detail || "") + " " + f.type + " " + f.id).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var counts = DATA.summary.counts;
    app.innerHTML = tabs("findings") +
      '<div class="filters">' +
      SEVS.map(function (s) {
        return '<button class="chip ' + (state.sev.has(s) ? "on" : "") + '" data-chip="' + s + '"><span class="dot ' + s + '"></span>' + s + " " + counts[s] + "</button>";
      }).join("") +
      '<select class="sel" id="cat"><option value="">All categories</option>' + cats.map(function (c) {
        return '<option value="' + esc(c) + '"' + (c === state.cat ? " selected" : "") + ">" + esc(c) + "</option>";
      }).join("") + "</select>" +
      '<input class="search" id="q" type="search" placeholder="Search findings, pages, ids…" value="' + esc(state.q) + '">' +
      '<span class="muted small">' + plural(list.length, "finding") + "</span></div>" +
      '<div class="card"><table><thead><tr><th style="width:90px">Severity</th><th>Finding</th><th>Where</th><th>Category</th></tr></thead><tbody>' +
      findingRows(list) + "</tbody></table></div>";
    app.querySelectorAll("[data-chip]").forEach(function (c) {
      c.addEventListener("click", function () {
        var s = c.getAttribute("data-chip");
        if (state.sev.has(s)) state.sev.delete(s); else state.sev.add(s);
        renderFindings();
      });
    });
    document.getElementById("cat").addEventListener("change", function (e) { state.cat = e.target.value; renderFindings(); });
    var qi = document.getElementById("q");
    qi.addEventListener("input", function (e) {
      state.q = e.target.value;
      var pos = qi.selectionStart;
      renderFindings();
      var again = document.getElementById("q");
      again.focus();
      again.setSelectionRange(pos, pos);
    });
    bindRows(app);
  }

  // ------------------------------------------------------------------- pages
  function renderPages(idx) {
    if (!DATA.pages.length) {
      app.innerHTML = tabs("pages") + '<div class="card"><div class="empty"><b>No pages compared</b>Check Run info for errors.</div></div>';
      return;
    }
    if (isNaN(idx) || idx < 0 || idx >= DATA.pages.length) idx = worstPage();
    var q = state.pageQ.toLowerCase();
    var listHtml = DATA.pages.map(function (p, i) {
      if (q && p.key.toLowerCase().indexOf(q) < 0) return "";
      return '<div class="pitem' + (i === idx ? " on" : "") + '" data-i="' + i + '"><span class="k" title="' + esc(p.key) + '">' + esc(p.key) + "</span>" +
        (DATA.meta.viewports.length > 1 ? '<span class="vp">' + esc(p.viewport) + "</span>" : "") + badges(sevCounts(p.findings)) + "</div>";
    }).join("");
    app.innerHTML = tabs("pages") + '<div class="pages"><div class="plist"><input class="search" id="pq" type="search" placeholder="Filter pages…" value="' + esc(state.pageQ) + '">' + listHtml + '</div><div id="pdetail"></div></div>';
    app.querySelectorAll(".pitem").forEach(function (it) {
      it.addEventListener("click", function () { location.hash = "pages/" + it.getAttribute("data-i"); });
    });
    var pq = document.getElementById("pq");
    pq.addEventListener("input", function () {
      state.pageQ = pq.value;
      var pos = pq.selectionStart;
      renderPages(idx);
      var again = document.getElementById("pq");
      again.focus();
      again.setSelectionRange(pos, pos);
    });
    renderPageDetail(DATA.pages[idx], document.getElementById("pdetail"));
  }
  function worstPage() {
    var best = 0, score = -1;
    DATA.pages.forEach(function (p, i) {
      var c = sevCounts(p.findings);
      var s = c.critical * 1000 + c.major * 100 + c.minor * 10 + c.info;
      if (s > score) { score = s; best = i; }
    });
    return best;
  }

  function renderPageDetail(p, box) {
    var b = p.baseline, c = p.candidate;
    var findings = p.findings.map(function (id) { return findingsById.get(id); }).filter(Boolean)
      .sort(function (x, y) { return SEVS.indexOf(x.severity) - SEVS.indexOf(y.severity); });
    var html = '<div class="phead"><h2>' + esc(p.key) + "</h2>" +
      (DATA.meta.viewports.length > 1 ? '<span class="chip">' + esc(p.viewport) + "</span>" : "") +
      '<a href="' + esc(b.url) + '" target="_blank" rel="noopener">baseline ↗</a><a href="' + esc(c.url) + '" target="_blank" rel="noopener">candidate ↗</a></div>';

    function fact(label, bv, cv) {
      return '<div><div class="lbl">' + label + ' · baseline</div><div class="v">' + bv + '</div></div><div><div class="lbl">' + label + ' · candidate</div><div class="v">' + cv + "</div></div>";
    }
    var perfB = b.perf || {}, perfC = c.perf || {};
    html += '<div class="card"><div class="facts">' +
      fact("Status", statusHtml(b), statusHtml(c)) +
      fact("Title", esc(b.title || "–"), esc(c.title || "–")) +
      fact("Ended at", '<span class="mono small">' + esc(b.finalUrl) + "</span>", '<span class="mono small">' + esc(c.finalUrl) + "</span>") +
      fact("Load", fmtMs(b.loadMs) + (perfB.lcp ? " · LCP " + fmtMs(perfB.lcp) : ""), fmtMs(c.loadMs) + (perfC.lcp ? " · LCP " + fmtMs(perfC.lcp) : "")) +
      (b.counts && c.counts ? fact("Page", countsLine(b.counts), countsLine(c.counts)) : "") +
      "</div></div>";

    html += '<div class="card"><h3>Findings <span class="count">' + findings.length + "</span></h3>" +
      (findings.length ? '<table><tbody>' + findingRows(findings, true) + "</tbody></table>" : '<div class="empty"><b>No differences</b>This page matches.</div>') + "</div>";

    if (b.screenshot && c.screenshot) {
      html += '<div class="card"><h3>Visual comparison</h3><div id="viewer-slot"></div></div>';
    }
    if (p.interactions && p.interactions.length) {
      html += '<div class="card"><h3>Interactions <span class="count">' + p.interactions.length + "</span></h3>" + interactionTable(p.interactions, false) + "</div>";
    }
    if (p.text && p.text.lines && p.text.lines.length) {
      html += '<div class="card"><h3>Text changes <span class="muted small" style="text-transform:none;letter-spacing:0">−' + p.text.removed + " +" + p.text.added + "</span></h3>" + textDiff(p.text.lines) + "</div>";
    }
    if (b.a11y || c.a11y) html += a11yCard(b.a11y || [], c.a11y || []);
    if (p.flaky && p.flaky.length) {
      html += '<div class="card"><h3>Didn’t reproduce <span class="count">' + p.flaky.length + '</span></h3>' +
        '<p class="muted small">Seen on the first capture but not on a second one, so not reported. Usually timing: a page still loading or animating.</p>' +
        "<table><tbody>" + p.flaky.map(function (t) { return '<tr><td class="small">' + esc(t) + "</td></tr>"; }).join("") + "</tbody></table></div>";
    }
    if (p.skipped && p.skipped.length) {
      html += '<div class="card"><h3>Not clicked <span class="count">' + p.skipped.length + '</span></h3><table><tbody>' + p.skipped.map(function (s) {
        return '<tr><td class="el">' + esc(s.element) + '</td><td class="muted small">' + esc(s.reason) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    }
    box.innerHTML = html;
    bindRows(box);
    var slot = box.querySelector("#viewer-slot");
    if (slot) {
      slot.appendChild(viewer({
        b: b.screenshot, c: c.screenshot, d: p.visual && p.visual.diff,
        regions: p.visual ? p.visual.regions : [], ratio: p.visual ? p.visual.ratio : null,
      }));
    }
  }
  function countsLine(k) {
    var bits = [plural(k.controls, "control"), plural(k.links, "link"), plural(k.forms, "form")];
    if (k.pageErrors) bits.push('<span class="status-bad">' + plural(k.pageErrors, "exception") + "</span>");
    if (k.consoleErrors) bits.push('<span class="status-bad">' + plural(k.consoleErrors, "console error") + "</span>");
    if (k.failedRequests) bits.push('<span class="status-bad">' + plural(k.failedRequests, "failed request") + "</span>");
    if (k.blockedRequests) bits.push('<span class="muted">' + k.blockedRequests + " blocked</span>");
    return bits.join(" · ");
  }
  function textDiff(lines) {
    return '<div class="textdiff">' + lines.map(function (l) {
      if (l.op === "…") return '<div class="gap">' + esc(l.text || "⋯") + "</div>";
      return '<div class="' + (l.op === "-" ? "del" : l.op === "+" ? "add" : "eq") + '">' + esc(l.text) + "</div>";
    }).join("") + "</div>";
  }
  function a11yCard(av, cv) {
    var ids = Array.from(new Set(av.map(function (v) { return v.id; }).concat(cv.map(function (v) { return v.id; }))));
    if (!ids.length) return "";
    var byA = new Map(av.map(function (v) { return [v.id, v]; })), byC = new Map(cv.map(function (v) { return [v.id, v]; }));
    return '<div class="card"><h3>Accessibility (axe)</h3><table><thead><tr><th>Rule</th><th>Impact</th><th>Baseline</th><th>Candidate</th></tr></thead><tbody>' +
      ids.map(function (id) {
        var a = byA.get(id), c2 = byC.get(id), v = c2 || a;
        var worse = (c2 ? c2.count : 0) > (a ? a.count : 0);
        return "<tr><td>" + esc(v.help) + ' <span class="muted mono small">' + esc(id) + '</span></td><td class="small">' + esc(v.impact) + "</td><td>" + (a ? a.count : 0) + '</td><td class="' + (worse ? "status-bad" : "") + '">' + (c2 ? c2.count : 0) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  // ------------------------------------------------------------ interactions
  function interactionTable(list, withPage) {
    return '<table><thead><tr>' + (withPage ? "<th>Page</th>" : "") + '<th>Action</th><th>Baseline</th><th>Candidate</th><th style="width:90px">Result</th><th>Screens</th></tr></thead><tbody>' +
      list.map(function (ix) {
        var pi = pageIndexFor(ix.page, ix.viewport);
        var ev = ix.screenshots || {};
        var shots = ev.baseline || ev.candidate
          ? '<button class="icon-btn" data-open=\'' + esc(JSON.stringify({ b: ev.baseline, c: ev.candidate, d: ev.diff, t: ix.path.join(" → "), m: "side" })) + "'>View</button>"
          : "";
        return "<tr>" + (withPage ? '<td class="where"><a href="#pages/' + pi + '">' + esc(ix.page) + "</a></td>" : "") +
          '<td class="el">' + (ix.action === "select" ? "choose <b>" + esc(ix.option) + "</b> in " : "") + esc(ix.path.join(" → ")) + "</td>" +
          '<td class="outcome">' + esc(ix.baseline) + '</td><td class="outcome">' + esc(ix.candidate) + "</td>" +
          '<td><span class="verdict-pill ' + ix.verdict + '">' + ix.verdict + "</span>" +
          (ix.flaky ? ' <span class="verdict-pill flaky" title="Differed once, but not when repeated from a fresh load">flaky</span>' : "") +
          (ix.findings && ix.findings.length ? "<div class=small>" + badges(sevCounts(ix.findings)) + "</div>" : "") + "</td><td>" + shots + "</td></tr>";
      }).join("") + "</tbody></table>";
  }
  function renderInteractions() {
    var all = [];
    DATA.pages.forEach(function (p) { (p.interactions || []).forEach(function (ix) { all.push(ix); }); });
    var q = state.ixQ.toLowerCase();
    var list = all.filter(function (ix) {
      if (!state.ixAll && ix.verdict !== "different") return false;
      if (q && (ix.page + " " + ix.path.join(" ") + " " + ix.baseline + " " + ix.candidate).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    app.innerHTML = tabs("interactions") +
      '<div class="filters"><button class="chip ' + (!state.ixAll ? "on" : "") + '" id="ixdiff">Only different</button><button class="chip ' + (state.ixAll ? "on" : "") + '" id="ixall">All ' + all.length + "</button>" +
      '<input class="search" id="ixq" type="search" placeholder="Search interactions…" value="' + esc(state.ixQ) + '"><span class="muted small">' + plural(list.length, "interaction") + "</span></div>" +
      '<div class="card">' + (list.length ? interactionTable(list, true) : '<div class="empty"><b>' + (all.length ? "Every interaction behaved the same" : "No interactions") + "</b>" + (all.length ? "Switch to “All” to see them." : "Exploration was off or found nothing safe to click.") + "</div>") + "</div>";
    document.getElementById("ixdiff").onclick = function () { state.ixAll = false; renderInteractions(); };
    document.getElementById("ixall").onclick = function () { state.ixAll = true; renderInteractions(); };
    var qi = document.getElementById("ixq");
    qi.addEventListener("input", function () {
      state.ixQ = qi.value;
      var pos = qi.selectionStart;
      renderInteractions();
      var again = document.getElementById("ixq");
      again.focus();
      again.setSelectionRange(pos, pos);
    });
    bindThumbs(app);
  }

  // ---------------------------------------------------------------- journeys
  function renderJourneys() {
    if (!DATA.journeys.length) {
      app.innerHTML = tabs("journeys") + '<div class="card"><div class="empty"><b>No journeys configured</b>Journeys are scripted multi-step flows (log in, add to cart, check out) that run on both environments. Add them under <code>journeys:</code> in the config.</div></div>';
      return;
    }
    app.innerHTML = tabs("journeys") + DATA.journeys.map(function (j) {
      return '<div class="card"><h3>' + esc(j.name) + ' <span class="verdict-pill ' + j.verdict + '">' + j.verdict + "</span></h3>" +
        '<table><thead><tr><th>#</th><th>Step</th><th>Baseline</th><th>Candidate</th><th style="width:90px">Result</th><th>Screens</th></tr></thead><tbody>' +
        j.steps.map(function (s, i) {
          var ev = s.screenshots || {};
          var side = function (o) { return o.ok ? '<span class="status-ok">ok</span> <span class="muted mono small">' + esc(o.key || "") + "</span>" : o.error ? '<span class="status-bad">' + esc(o.error) + "</span>" : '<span class="muted">–</span>'; };
          return "<tr><td>" + (i + 1) + '</td><td class="el">' + esc(s.label) + "</td><td>" + side(s.baseline) + "</td><td>" + side(s.candidate) + '</td><td><span class="verdict-pill ' + s.verdict + '">' + s.verdict + "</span></td><td>" +
            (ev.baseline || ev.candidate ? '<button class="icon-btn" data-open=\'' + esc(JSON.stringify({ b: ev.baseline, c: ev.candidate, d: ev.diff, t: j.name + " — " + s.label, m: "side" })) + "'>View</button>" : "") + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }).join("");
    bindThumbs(app);
  }

  // --------------------------------------------------------------------- api
  function renderApi() {
    var apiFindings = DATA.findings.filter(function (f) { return f.category === "api"; });
    app.innerHTML = tabs("api") +
      (apiFindings.length ? '<div class="card"><h3>Contract differences</h3><table><tbody>' + findingRows(apiFindings) + "</tbody></table></div>" : "") +
      '<div class="card"><h3>Endpoints seen <span class="count">' + DATA.api.length + "</span></h3>" +
      (DATA.api.length ? '<table><thead><tr><th>Endpoint</th><th>Baseline</th><th>Candidate</th><th>Pages</th></tr></thead><tbody>' + DATA.api.map(function (a) {
        var st = function (list) { return list.length ? list.map(function (s) { return '<span class="' + (s < 400 ? "status-ok" : "status-bad") + '">' + s + "</span>"; }).join(" ") : '<span class="muted">not called</span>'; };
        return '<tr><td class="mono small">' + esc(a.key.replace("{self}", "")) + "</td><td>" + st(a.baseline) + "</td><td>" + st(a.candidate) + '</td><td class="where">' + esc(a.pages.join(", ")) + "</td></tr>";
      }).join("") + "</tbody></table>" : '<div class="empty"><b>No JSON APIs observed</b>XHR/fetch calls returning JSON appear here with the shape of their responses compared.</div>') + "</div>";
    bindRows(app);
  }

  // --------------------------------------------------------------------- run
  function renderRun() {
    var m = DATA.meta, s = DATA.summary;
    var kv = [
      ["envdiff", DATA.tool.version], ["Started", new Date(m.startedAt).toLocaleString()], ["Duration", fmtDuration(m.durationMs)],
      ["Browser", m.browser], ["Viewports", m.viewports.join(", ")], ["Max pages", m.settings.maxPages], ["Max depth", m.settings.maxDepth],
      ["Exploration", m.settings.explore], ["Mutations", m.settings.mutations], ["Fails on", m.settings.failOn],
      ["Suppressed findings", s.suppressed], ["Didn’t reproduce (not reported)", s.flaky || 0], ["Skipped (same route)", DATA.crawl ? DATA.crawl.skippedByPattern : 0],
    ];
    var html = tabs("run") + '<div class="card"><h3>Settings</h3><div class="pad"><dl class="kv">' + kv.map(function (x) { return "<dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd>"; }).join("") + "</dl></div></div>";
    if (DATA.errors.length) {
      html += '<div class="card"><h3>Errors</h3><table><tbody>' + DATA.errors.map(function (e) { return '<tr><td class="where">' + esc(e.page || "") + "</td><td>" + esc(e.message) + "</td></tr>"; }).join("") + "</tbody></table></div>";
    }
    if (DATA.linkChecks && DATA.linkChecks.length) {
      html += '<div class="card"><h3>Links checked but not crawled <span class="count">' + DATA.linkChecks.length + '</span></h3><table><thead><tr><th>Link</th><th>Baseline</th><th>Candidate</th></tr></thead><tbody>' +
        DATA.linkChecks.map(function (l) {
          var st = function (v) { return typeof v === "number" ? '<span class="' + (v < 400 ? "status-ok" : "status-bad") + '">' + v + "</span>" : '<span class="status-bad">' + esc(v) + "</span>"; };
          return '<tr><td class="mono small">' + esc(l.key) + "</td><td>" + st(l.baseline) + "</td><td>" + st(l.candidate) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    if (DATA.crawl && DATA.crawl.notCrawled.length) {
      html += '<div class="card"><h3>Discovered but not crawled <span class="count">' + s.notCrawled + '</span></h3><div class="pad mono small">' + DATA.crawl.notCrawled.map(esc).join("<br>") + "</div></div>";
    }
    app.innerHTML = html;
  }

  // ------------------------------------------------------------------ viewer
  function viewer(o) {
    var root = el('<div class="viewer"></div>');
    var modes = [["side", "Side by side"], ["swipe", "Swipe"], ["onion", "Onion skin"]];
    if (o.d) modes.push(["diff", "Diff"]);
    var single = !(o.b && o.c);
    var mode = single ? "single" : o.m && modes.some(function (x) { return x[0] === o.m; }) ? o.m : "side";
    var showRegions = true;
    var bar = el('<div class="cmp-bar"></div>');
    var stage = el('<div class="stage"></div>');
    root.appendChild(bar);
    root.appendChild(stage);

    function drawBar() {
      bar.innerHTML = (single ? '<span class="muted small">Only one side has a screenshot</span>' :
        '<div class="seg">' + modes.map(function (x) { return '<button data-m="' + x[0] + '" class="' + (x[0] === mode ? "on" : "") + '">' + x[1] + "</button>"; }).join("") + "</div>") +
        (mode === "swipe" || mode === "onion" ? '<input class="slider" type="range" min="0" max="100" value="50">' : "") +
        (o.regions && o.regions.length && mode !== "diff" ? '<label><input type="checkbox" class="showreg"' + (showRegions ? " checked" : "") + "> changed regions</label>" : "") +
        (o.ratio != null ? '<span class="ratio">' + pct(o.ratio) + " of pixels differ</span>" : "");
      bar.querySelectorAll("[data-m]").forEach(function (b) {
        b.addEventListener("click", function () { mode = b.getAttribute("data-m"); drawBar(); draw(); });
      });
      var sr = bar.querySelector(".showreg");
      if (sr) sr.addEventListener("change", function () { showRegions = sr.checked; draw(); });
      var sl = bar.querySelector(".slider");
      if (sl) sl.addEventListener("input", function () { applySlider(Number(sl.value)); });
    }
    function regionsOn(box, img) {
      if (!showRegions || !o.regions || !o.regions.length) return;
      function place() {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return;
        o.regions.forEach(function (r, i) {
          var d = el('<div class="region"><span>' + (i + 1) + "</span></div>");
          d.style.left = (r.x / w) * 100 + "%";
          d.style.top = (r.y / h) * 100 + "%";
          d.style.width = (r.w / w) * 100 + "%";
          d.style.height = (r.h / h) * 100 + "%";
          d.title = r.label || "";
          box.appendChild(d);
        });
      }
      // Images built in a <template> report complete=true with no size until
      // they are in the document and loaded, so wait unless the size is known.
      if (img.complete && img.naturalWidth) place(); else img.addEventListener("load", place, { once: true });
    }
    function imgBox(src, regions) {
      var box = el('<div class="imgbox"><img alt="" src="' + esc(src) + '"></div>');
      if (regions) regionsOn(box, box.querySelector("img"));
      return box;
    }
    function applySlider(v) {
      var top = stage.querySelector(".top-layer");
      if (!top) return;
      if (mode === "swipe") {
        top.style.clipPath = "inset(0 " + (100 - v) + "% 0 0)";
        var h = stage.querySelector(".handle");
        if (h) h.style.left = v + "%";
      } else {
        top.style.opacity = String(v / 100);
      }
    }
    function draw() {
      stage.innerHTML = "";
      if (single) {
        var s = el('<div class="single"><div class="cap">' + (o.b ? "Baseline" : "Candidate") + "</div></div>");
        s.appendChild(imgBox(o.b || o.c, !o.b));
        stage.appendChild(s);
      } else if (mode === "side") {
        var g = el('<div class="side"><div><div class="cap">Baseline</div></div><div><div class="cap">Candidate</div></div></div>');
        g.children[0].appendChild(imgBox(o.b, false));
        g.children[1].appendChild(imgBox(o.c, true));
        stage.appendChild(g);
      } else if (mode === "diff") {
        var d = el('<div class="single"><div class="cap">Pixel difference (changed pixels in red)</div></div>');
        d.appendChild(imgBox(o.d, true));
        stage.appendChild(d);
      } else {
        var sw = el('<div class="swipe imgbox"><img alt="" src="' + esc(o.c) + '"><div class="top-layer"><img alt="" src="' + esc(o.b) + '"></div>' +
          (mode === "swipe" ? '<div class="handle"></div><span class="tag" style="left:8px">Baseline</span><span class="tag" style="right:8px">Candidate</span>' : '<span class="tag" style="left:8px">Baseline over candidate</span>') + "</div>");
        regionsOn(sw, sw.querySelector("img"));
        stage.appendChild(sw);
        applySlider(50);
      }
      if (o.regions && o.regions.length && !root.querySelector(".regions-list")) {
        root.appendChild(el('<div class="regions-list">' + o.regions.map(function (r, i) {
          return '<span class="r">' + (i + 1) + ". " + esc(r.label || "region") + "</span>";
        }).join("") + "</div>"));
      }
    }
    drawBar();
    draw();
    return root;
  }

  var modal = document.getElementById("modal");
  function openModal(o) {
    modal.querySelector(".t").textContent = o.t || "";
    var body = modal.querySelector(".mbody");
    body.innerHTML = "";
    var v = viewer(o);
    v.querySelector(".stage").style.maxHeight = "calc(100vh - 150px)";
    body.appendChild(v);
    modal.classList.add("open");
  }
  function closeModal() { modal.classList.remove("open"); modal.querySelector(".mbody").innerHTML = ""; }
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
  modal.querySelector(".close").addEventListener("click", closeModal);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  // ------------------------------------------------------------------ router
  function route() {
    var h = decodeURIComponent(location.hash.slice(1)) || "findings";
    var parts = h.split("/");
    var tab = parts[0];
    if (tab === "pages") renderPages(parseInt(parts[1], 10));
    else if (tab === "interactions") renderInteractions();
    else if (tab === "journeys") renderJourneys();
    else if (tab === "api") renderApi();
    else if (tab === "run") renderRun();
    else renderFindings();
    document.querySelectorAll(".tile[data-sev]").forEach(function (t) {
      t.classList.toggle("active", tab === "findings" && state.sev.size === 1 && state.sev.has(t.getAttribute("data-sev")));
    });
  }
  window.addEventListener("hashchange", function () { route(); window.scrollTo(0, Math.min(window.scrollY, 260)); });
  renderHeader();
  route();
})();
