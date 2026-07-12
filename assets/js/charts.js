/* =============================================================================
 * charts.js — 의존성 없는 SVG 조합 차트 (막대 + 보조축 선)
 *   삼성전자 정량모델의 시그니처 차트: 매출·영업이익 막대 + OPM 선(우측 축)
 * =========================================================================== */
(function (global) {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  /*
   * renderComboChart(container, cfg)
   *   cfg = {
   *     labels: [...],
   *     bars:   [ { name, color, values:[...] }, ... ],   // 좌측 축
   *     line:   { name, color, values:[...], fmt:fn },    // 우측 축(%)
   *     yLabel, y2Label
   *   }
   */
  function renderComboChart(container, cfg) {
    container.innerHTML = '';
    var labels = cfg.labels || [];
    var bars = cfg.bars || [];
    var line = cfg.line;
    var n = labels.length;
    if (!n) { container.textContent = '데이터 없음'; return; }

    var W = Math.max(560, n * 46 + 90);
    var H = 340;
    var m = { top: 24, right: 54, bottom: 62, left: 52 };
    var iw = W - m.left - m.right;
    var ih = H - m.top - m.bottom;

    var svg = el('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      preserveAspectRatio: 'xMinYMid meet',
      class: 'combo-chart', role: 'img'
    });

    // 좌축 스케일 (막대: 0 기준, 음수 대응)
    var allBarVals = [];
    bars.forEach(function (b) { b.values.forEach(function (v) { if (v != null) allBarVals.push(v); }); });
    var bMax = Math.max.apply(null, allBarVals.concat([0]));
    var bMin = Math.min.apply(null, allBarVals.concat([0]));
    if (bMin > 0) bMin = 0;
    var bPad = (bMax - bMin) * 0.08 || 1;
    bMax += bPad;
    function yL(v) { return m.top + ih * (1 - (v - bMin) / (bMax - bMin)); }

    // 우축 스케일 (선)
    var lMax = 1, lMin = 0;
    if (line && line.values.length) {
      var lv = line.values.filter(function (v) { return v != null; });
      lMax = Math.max.apply(null, lv);
      lMin = Math.min.apply(null, lv);
      var lp = (lMax - lMin) * 0.15 || Math.abs(lMax) * 0.1 || 0.02;
      lMax += lp; lMin -= lp;
      if (lMin > 0) lMin = 0;
    }
    function yR(v) { return m.top + ih * (1 - (v - lMin) / (lMax - lMin)); }

    // --- 격자 + 좌축 눈금 ---
    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var val = bMin + (bMax - bMin) * i / ticks;
      var y = yL(val);
      svg.appendChild(el('line', { x1: m.left, y1: y, x2: m.left + iw, y2: y, class: 'grid' }));
      svg.appendChild(el('text', { x: m.left - 8, y: y + 4, class: 'axis-lbl', 'text-anchor': 'end' },
        (Math.round(val * 10) / 10).toString()));
    }
    // 우축 눈금
    if (line) {
      for (var j = 0; j <= ticks; j++) {
        var rv = lMin + (lMax - lMin) * j / ticks;
        var ry = yR(rv);
        svg.appendChild(el('text', { x: m.left + iw + 8, y: ry + 4, class: 'axis-lbl r', 'text-anchor': 'start' },
          (line.fmt ? line.fmt(rv) : (Math.round(rv * 1000) / 10) + '%')));
      }
    }

    // 0선 강조
    svg.appendChild(el('line', { x1: m.left, y1: yL(0), x2: m.left + iw, y2: yL(0), class: 'grid zero' }));

    // --- 막대 ---
    var band = iw / n;
    var groupW = band * 0.62;
    var barW = bars.length ? groupW / bars.length : groupW;
    labels.forEach(function (lab, idx) {
      var x0 = m.left + band * idx + (band - groupW) / 2;
      bars.forEach(function (b, bi) {
        var v = b.values[idx];
        if (v == null) return;
        var y = yL(Math.max(v, 0));
        var h = Math.abs(yL(v) - yL(0));
        svg.appendChild(el('rect', {
          x: x0 + barW * bi, y: y, width: Math.max(barW - 1, 1), height: Math.max(h, 0.5),
          fill: b.color, rx: 1, class: 'bar'
        }));
      });
      // x축 라벨 (분기는 회전)
      var lx = m.left + band * idx + band / 2;
      var tickLbl = el('text', {
        x: lx, y: H - m.bottom + 16, class: 'axis-lbl x',
        'text-anchor': 'end', transform: 'rotate(-40 ' + lx + ' ' + (H - m.bottom + 16) + ')'
      }, lab);
      svg.appendChild(tickLbl);
    });

    // --- 선 ---
    if (line && line.values.length) {
      var pts = [];
      line.values.forEach(function (v, idx) {
        if (v == null) return;
        var cx = m.left + band * idx + band / 2;
        pts.push([cx, yR(v)]);
      });
      if (pts.length > 1) {
        svg.appendChild(el('polyline', {
          points: pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' '),
          fill: 'none', stroke: line.color, 'stroke-width': 2.4, class: 'line'
        }));
      }
      pts.forEach(function (p) {
        svg.appendChild(el('circle', { cx: p[0], cy: p[1], r: 2.8, fill: line.color, class: 'dot' }));
      });
    }

    container.appendChild(svg);

    // --- 범례 ---
    var leg = document.createElement('div');
    leg.className = 'chart-legend';
    bars.forEach(function (b) { leg.appendChild(legendItem(b.color, b.name, 'bar')); });
    if (line) leg.appendChild(legendItem(line.color, line.name, 'line'));
    container.appendChild(leg);
  }

  function legendItem(color, name, type) {
    var s = document.createElement('span');
    s.className = 'legend-item';
    var mark = document.createElement('span');
    mark.className = 'legend-mark ' + type;
    mark.style.background = color;
    s.appendChild(mark);
    s.appendChild(document.createTextNode(name));
    return s;
  }

  /* ---------------------------------------------------------------------------
   * renderLineChart — 다중 선 차트 (마진 등). 음수/퍼센트 지원.
   *   cfg = { labels, lines:[{name,color,values}], fmt, percent, refs:[{value,color,label}] }
   * ------------------------------------------------------------------------- */
  function renderLineChart(container, cfg) {
    container.innerHTML = '';
    var labels = cfg.labels || [], lines = cfg.lines || [], n = labels.length;
    if (!n) { container.textContent = '데이터 없음'; return; }
    var W = Math.max(560, n * 40 + 90), H = 300;
    var m = { top: 20, right: 20, bottom: 62, left: 56 };
    var iw = W - m.left - m.right, ih = H - m.top - m.bottom;
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMinYMid meet', class: 'combo-chart', role: 'img' });

    var all = [];
    lines.forEach(function (l) { l.values.forEach(function (v) { if (v != null) all.push(v); }); });
    (cfg.refs || []).forEach(function (rf) { if (rf.value != null) all.push(rf.value); });
    if (!all.length) { container.textContent = '데이터 없음'; return; }
    var mx = Math.max.apply(null, all), mn = Math.min.apply(null, all);
    var pad = (mx - mn) * 0.12 || Math.abs(mx) * 0.1 || 1; mx += pad; mn -= pad;
    if (mn > 0) mn = 0;
    function y(v) { return m.top + ih * (1 - (v - mn) / (mx - mn)); }
    function x(i) { return m.left + (n === 1 ? iw / 2 : iw * i / (n - 1)); }

    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var val = mn + (mx - mn) * i / ticks, yy = y(val);
      svg.appendChild(el('line', { x1: m.left, y1: yy, x2: m.left + iw, y2: yy, class: 'grid' }));
      svg.appendChild(el('text', { x: m.left - 8, y: yy + 4, class: 'axis-lbl', 'text-anchor': 'end' },
        cfg.fmt ? cfg.fmt(val) : (cfg.percent ? (val * 100).toFixed(0) + '%' : (Math.round(val * 10) / 10).toString())));
    }
    if (mn < 0) svg.appendChild(el('line', { x1: m.left, y1: y(0), x2: m.left + iw, y2: y(0), class: 'grid zero' }));

    // 참조선(밴드 등)
    (cfg.refs || []).forEach(function (rf) {
      svg.appendChild(el('line', { x1: m.left, y1: y(rf.value), x2: m.left + iw, y2: y(rf.value),
        stroke: rf.color, 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: 0.8 }));
      svg.appendChild(el('text', { x: m.left + iw, y: y(rf.value) - 3, class: 'axis-lbl', 'text-anchor': 'end', fill: rf.color }, rf.label || ''));
    });

    labels.forEach(function (lab, idx) {
      var lx = x(idx);
      if (n <= 14 || idx % Math.ceil(n / 14) === 0) {
        svg.appendChild(el('text', { x: lx, y: H - m.bottom + 16, class: 'axis-lbl x', 'text-anchor': 'end',
          transform: 'rotate(-40 ' + lx + ' ' + (H - m.bottom + 16) + ')' }, lab));
      }
    });

    lines.forEach(function (l) {
      var pts = [];
      l.values.forEach(function (v, idx) { if (v != null) pts.push([x(idx), y(v)]); });
      if (pts.length > 1) svg.appendChild(el('polyline', {
        points: pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' '),
        fill: 'none', stroke: l.color, 'stroke-width': 2.2, class: 'line'
      }));
      pts.forEach(function (p) { svg.appendChild(el('circle', { cx: p[0], cy: p[1], r: 2.4, fill: l.color })); });
    });

    container.appendChild(svg);
    var leg = document.createElement('div'); leg.className = 'chart-legend';
    lines.forEach(function (l) { leg.appendChild(legendItem(l.color, l.name, 'line')); });
    container.appendChild(leg);
  }

  /* ---------------------------------------------------------------------------
   * renderBandChart — 역사적 PER/PBR 밴드. 시계열 선 + P25/중앙/P75 밴드 음영 + 현재 마커.
   *   cfg = { labels, values, band:{min,p25,median,p75,max}, current, color, unit:'배' }
   * ------------------------------------------------------------------------- */
  function renderBandChart(container, cfg) {
    container.innerHTML = '';
    var labels = cfg.labels || [], values = cfg.values || [], n = labels.length;
    var band = cfg.band;
    if (!n || !band) { container.textContent = '데이터 없음'; return; }
    var W = Math.max(560, n * 26 + 90), H = 300;
    var m = { top: 18, right: 66, bottom: 62, left: 48 };
    var iw = W - m.left - m.right, ih = H - m.top - m.bottom;
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMinYMid meet', class: 'combo-chart', role: 'img' });
    var color = cfg.color || 'var(--blue)';

    var all = values.filter(function (v) { return v != null; }).concat([band.min, band.max]);
    if (cfg.current != null) all.push(cfg.current);
    var mx = Math.max.apply(null, all), mn = Math.min.apply(null, all);
    var pad = (mx - mn) * 0.08 || 1; mx += pad; mn -= pad; if (mn < 0) mn = 0;
    function y(v) { return m.top + ih * (1 - (v - mn) / (mx - mn)); }
    function x(i) { return m.left + (n === 1 ? iw / 2 : iw * i / (n - 1)); }

    // P25~P75 밴드 음영
    svg.appendChild(el('rect', { x: m.left, y: y(band.p75), width: iw, height: Math.abs(y(band.p25) - y(band.p75)),
      fill: color, opacity: 0.10 }));
    // 중앙값/사분위 참조선
    [['median', band.median, '중앙 ' + band.median.toFixed(1)], ['p25', band.p25, '저 ' + band.p25.toFixed(1)], ['p75', band.p75, '고 ' + band.p75.toFixed(1)]].forEach(function (rf) {
      svg.appendChild(el('line', { x1: m.left, y1: y(rf[1]), x2: m.left + iw, y2: y(rf[1]),
        stroke: color, 'stroke-width': rf[0] === 'median' ? 1.4 : 1, 'stroke-dasharray': rf[0] === 'median' ? '' : '4 3', opacity: 0.65 }));
      svg.appendChild(el('text', { x: m.left + iw + 6, y: y(rf[1]) + 4, class: 'axis-lbl', 'text-anchor': 'start', fill: color }, rf[2]));
    });
    // y축 눈금
    for (var i = 0; i <= 4; i++) {
      var val = mn + (mx - mn) * i / 4;
      svg.appendChild(el('text', { x: m.left - 8, y: y(val) + 4, class: 'axis-lbl', 'text-anchor': 'end' }, (Math.round(val * 10) / 10).toString()));
    }
    // x축 라벨
    labels.forEach(function (lab, idx) {
      if (n <= 16 || idx % Math.ceil(n / 16) === 0) {
        var lx = x(idx);
        svg.appendChild(el('text', { x: lx, y: H - m.bottom + 16, class: 'axis-lbl x', 'text-anchor': 'end',
          transform: 'rotate(-40 ' + lx + ' ' + (H - m.bottom + 16) + ')' }, lab));
      }
    });
    // 시계열 선
    var pts = [];
    values.forEach(function (v, idx) { if (v != null) pts.push([x(idx), y(v)]); });
    if (pts.length > 1) svg.appendChild(el('polyline', { points: pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' '),
      fill: 'none', stroke: color, 'stroke-width': 2, class: 'line' }));
    // 현재 마커
    if (cfg.current != null) {
      svg.appendChild(el('line', { x1: m.left, y1: y(cfg.current), x2: m.left + iw, y2: y(cfg.current), stroke: 'var(--navy)', 'stroke-width': 1.5 }));
      svg.appendChild(el('circle', { cx: x(n - 1), cy: y(cfg.current), r: 4, fill: 'var(--navy)' }));
    }
    container.appendChild(svg);
  }

  global.Charts = {
    renderComboChart: renderComboChart,
    renderLineChart: renderLineChart,
    renderBandChart: renderBandChart
  };
})(window);
