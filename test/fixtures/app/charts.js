/*
 * A stand-in for Highcharts in the test fixture: it renders the same DOM
 * (class names, structure, legend and tooltip behaviour, the window.Highcharts
 * registry) for the few features the fixture uses, so envdiff can be tested
 * without bundling Highcharts itself, which is not open-source licensed.
 */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var COLORS = ["#2caffe", "#544fc5", "#00e272", "#fe6a35"];
  var charts = [];
  var uid = 0;

  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, attrs, lines) {
    var t = el("text", attrs, parent);
    lines.forEach(function (line, i) {
      var ts = el("tspan", i ? { x: attrs.x, dy: 15 } : {}, t);
      ts.textContent = line;
    });
    return t;
  }
  function short(v) {
    return Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + "k" : String(v);
  }
  function circle(x, y, r) {
    return "M " + (x - r) + " " + y + " A " + r + " " + r + " 0 1 1 " + (x + r) + " " + y + " A " + r + " " + r + " 0 1 1 " + (x - r) + " " + y + " Z";
  }

  function chart(renderTo, options) {
    var host = typeof renderTo === "string" ? document.getElementById(renderTo) : renderTo;
    var index = charts.length;
    var id = "highcharts-fixture-" + ++uid;
    host.setAttribute("data-highcharts-chart", String(index));
    host.innerHTML = "";
    var W = Math.max(320, host.clientWidth || 640);
    var H = (options.chart && options.chart.height) || 320;
    var defaultType = (options.chart && options.chart.type) || "line";
    var container = document.createElement("div");
    container.className = "highcharts-container ";
    container.id = id;
    container.style.cssText = "position:relative;overflow:hidden;width:" + W + "px;height:" + H + "px;text-align:left;user-select:none;";
    host.appendChild(container);

    var root = el("svg", { version: "1.1", class: "highcharts-root", width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": options.title ? options.title.text : "" }, container);
    var defs = el("defs", {}, root);
    el("rect", { class: "highcharts-background", fill: "#ffffff", x: 0, y: 0, width: W, height: H }, root);
    var plot = { left: 64, top: 48, width: W - 84, height: H - 120 };
    el("rect", { class: "highcharts-plot-background", fill: "none", x: plot.left, y: plot.top, width: plot.width, height: plot.height }, root);

    var cats = (options.xAxis && options.xAxis.categories) || [];
    var seriesOpts = options.series || [];
    var values = [];
    seriesOpts.forEach(function (s) {
      values = values.concat(s.data);
    });
    var max = values.length ? Math.max.apply(null, values) * 1.15 : 1;

    var yGrid = el("g", { class: "highcharts-grid highcharts-yaxis-grid" }, root);
    var yLabels = el("g", { class: "highcharts-axis-labels highcharts-yaxis-labels" }, root);
    for (var i = 0; i <= 4; i++) {
      var gy = plot.top + plot.height - (i / 4) * plot.height;
      el("path", { class: "highcharts-grid-line", d: "M " + plot.left + " " + gy + " L " + (plot.left + plot.width) + " " + gy, stroke: "#e6e6e6" }, yGrid);
      text(yLabels, { x: plot.left - 8, y: gy + 4, "text-anchor": "end", "font-size": 11, fill: "#666" }, [short(Math.round((max * i) / 4))]);
    }
    var xAxis = el("g", { class: "highcharts-axis highcharts-xaxis" }, root);
    el("path", { class: "highcharts-axis-line", d: "M " + plot.left + " " + (plot.top + plot.height) + " L " + (plot.left + plot.width) + " " + (plot.top + plot.height), stroke: "#ccd6eb" }, xAxis);
    var yAxis = el("g", { class: "highcharts-axis highcharts-yaxis" }, root);
    if (options.yAxis && options.yAxis.title) {
      var cy = plot.top + plot.height / 2;
      text(yAxis, { class: "highcharts-axis-title", x: 16, y: cy, transform: "rotate(270 16 " + cy + ")", "text-anchor": "middle", "font-size": 12, fill: "#666" }, [options.yAxis.title.text]);
    }
    var xLabels = el("g", { class: "highcharts-axis-labels highcharts-xaxis-labels" }, root);
    var slot = plot.width / Math.max(1, cats.length);
    cats.forEach(function (c, ci) {
      text(xLabels, { x: plot.left + slot * (ci + 0.5), y: plot.top + plot.height + 18, "text-anchor": "middle", "font-size": 11, fill: "#666" }, [c]);
    });

    // Series, revealed from the left by a growing clip, as Highcharts animates them in.
    var clip = el("clipPath", { id: id + "-clip" }, defs);
    var clipRect = el("rect", { x: 0, y: -10, width: 0, height: plot.height + 20 }, clip);
    var group = el("g", { class: "highcharts-series-group" }, root);
    var translate = "translate(" + plot.left + "," + plot.top + ")";
    var series = seriesOpts.map(function (s, si) {
      var type = s.type || defaultType;
      var color = COLORS[si % COLORS.length];
      var g = el("g", { class: "highcharts-series highcharts-series-" + si + " highcharts-" + type + "-series highcharts-color-" + si, transform: translate, "clip-path": "url(#" + id + "-clip)" }, group);
      var n = seriesOpts.length;
      var bar = (slot * 0.7) / n;
      var points = s.data.map(function (y, pi) {
        var plotY = plot.height - (y / max) * plot.height;
        var plotX = type === "column" ? slot * pi + slot * 0.15 + bar * (si + 0.5) : slot * (pi + 0.5);
        return { x: pi, y: y, category: cats[pi], plotX: plotX, plotY: plotY, index: pi };
      });
      var markers = null;
      if (type === "column") {
        points.forEach(function (p) {
          p.graphic = el("rect", { class: "highcharts-point highcharts-color-" + si, fill: color, x: p.plotX - bar / 2, y: p.plotY, width: Math.max(1, bar - 2), height: plot.height - p.plotY }, g);
        });
      } else {
        el("path", { class: "highcharts-graph", fill: "none", stroke: color, "stroke-width": 2, d: points.map(function (p, pi) { return (pi ? "L " : "M ") + p.plotX + " " + p.plotY; }).join(" ") }, g);
        markers = el("g", { class: "highcharts-markers highcharts-series-" + si + " highcharts-" + type + "-series highcharts-color-" + si + " highcharts-tracker", transform: translate, "clip-path": "url(#" + id + "-clip)" }, group);
        points.forEach(function (p) {
          p.graphic = el("path", { class: "highcharts-point highcharts-color-" + si, fill: color, d: circle(p.plotX, p.plotY, 4) }, markers);
        });
      }
      var obj = { name: s.name, type: type, visible: true, index: si, points: points, data: points, group: g, markerGroup: markers, color: color };
      points.forEach(function (p) {
        p.series = obj;
      });
      return obj;
    });

    text(root, { class: "highcharts-title", x: W / 2, y: 24, "text-anchor": "middle", "font-size": 16, fill: "#333" }, [options.title ? options.title.text : ""]);

    var legend = el("g", { class: "highcharts-legend highcharts-no-tooltip", transform: "translate(" + Math.max(8, W / 2 - series.length * 60) + "," + (H - 30) + ")" }, root);
    series.forEach(function (s, si) {
      var item = el("g", { class: "highcharts-legend-item highcharts-" + s.type + "-series highcharts-color-" + si + " highcharts-series-" + si, transform: "translate(" + si * 120 + ",0)" }, legend);
      el("rect", { class: "highcharts-point", x: 0, y: 4, width: 12, height: 12, rx: 6, fill: s.color }, item);
      text(item, { x: 18, y: 15, "font-size": 12, fill: "#333", style: "cursor:pointer" }, [s.name]);
      item.style.cursor = "pointer";
      item.addEventListener("click", function () {
        s.visible = !s.visible;
        var vis = s.visible ? "inherit" : "hidden";
        s.group.setAttribute("visibility", vis);
        if (s.markerGroup) s.markerGroup.setAttribute("visibility", vis);
        item.classList.toggle("highcharts-legend-item-hidden", !s.visible);
      });
    });

    var tip = el("g", { class: "highcharts-label highcharts-tooltip", visibility: "hidden", opacity: 0, style: "pointer-events:none;white-space:nowrap" }, root);
    var tipBox = el("path", { class: "highcharts-label-box highcharts-tooltip-box", fill: "rgba(247,247,247,0.95)", stroke: "#999" }, tip);
    var tipText = el("text", { x: 8, y: 20, "font-size": 12, fill: "#333" }, tip);
    var format =
      (options.tooltip && options.tooltip.formatter) ||
      function () {
        return "<b>" + this.x + "</b><br/>" + this.series.name + ": " + this.y;
      };
    var hideTimer = 0;
    container.addEventListener("mousemove", function (e) {
      var r = container.getBoundingClientRect();
      var mx = e.clientX - r.left - plot.left;
      var my = e.clientY - r.top - plot.top;
      if (mx < 0 || my < 0 || mx > plot.width || my > plot.height) return;
      var best = null;
      var bestD = Infinity;
      series.forEach(function (s) {
        if (!s.visible) return;
        s.points.forEach(function (p) {
          var d = Math.abs(p.plotX - mx) + (s.type === "column" ? 0 : Math.abs(p.plotY - my) * 0.25);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        });
      });
      if (!best) return;
      clearTimeout(hideTimer);
      var lines = String(format.call({ x: best.category, y: best.y, point: best, series: best.series }))
        .split(/<br\s*\/?>/i)
        .map(function (l) {
          return l.replace(/<[^>]+>/g, "");
        });
      while (tipText.firstChild) tipText.removeChild(tipText.firstChild);
      lines.forEach(function (l, li) {
        var ts = el("tspan", li ? { x: 8, dy: 16 } : {}, tipText);
        ts.textContent = l;
      });
      var w = 16 + Math.max.apply(null, lines.map(function (l) { return l.length; })) * 7;
      var h = 12 + lines.length * 16;
      tipBox.setAttribute("d", "M 0 0 L " + w + " 0 L " + w + " " + h + " L 0 " + h + " Z");
      var tx = Math.min(W - w - 4, plot.left + best.plotX + 12);
      var ty = Math.max(4, plot.top + best.plotY - h - 8);
      tip.setAttribute("transform", "translate(" + tx + "," + ty + ")");
      tip.setAttribute("class", "highcharts-label highcharts-tooltip highcharts-color-" + best.series.index);
      tip.setAttribute("visibility", "inherit");
      tip.setAttribute("opacity", 1);
    });
    container.addEventListener("mouseleave", function () {
      hideTimer = setTimeout(function () {
        tip.setAttribute("opacity", 0);
        tip.setAttribute("visibility", "hidden");
      }, 500);
    });

    var t0 = performance.now();
    var step = function (now) {
      var k = Math.max(0, Math.min(1, (now - t0) / 700));
      clipRect.setAttribute("width", String(plot.width * k + 10));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);

    var c = {
      index: index,
      renderTo: host,
      container: container,
      series: series,
      title: { textStr: options.title ? options.title.text : "" },
      xAxis: [{ categories: cats }],
      yAxis: [{ axisTitle: options.yAxis && options.yAxis.title ? { textStr: options.yAxis.title.text } : undefined }],
      plotLeft: plot.left,
      plotTop: plot.top,
      plotWidth: plot.width,
      plotHeight: plot.height,
      options: options,
      destroy: function () {
        charts[index] = undefined;
        host.innerHTML = "";
      },
    };
    charts.push(c);
    return c;
  }

  window.Highcharts = { chart: chart, charts: charts, version: "fixture" };
})();
