/* =============================================================================
 * app.js — 기업분석 대시보드 (목록 + 상세)
 * =========================================================================== */
(function () {
  'use strict';
  var V = window.Valuation, fmt = V.fmt;
  var LS_KEY = 'companyAnalysis.overrides';
  var PALETTE = ['#2e75b6', '#ed7d31', '#1e9e6a', '#8e6fbe', '#d1495b', '#c8871a', '#3aa0a0', '#7a869a'];

  /* ---------- 보는 사람(뷰어)별 앵커 가중 프리셋 (이 브라우저에만 저장) ---------- */
  var PRESET_LS = 'companyAnalysis.viewerPresets';
  function viewerPresets() { try { return JSON.parse(localStorage.getItem(PRESET_LS) || '{}'); } catch (e) { return {}; } }
  function setViewerPreset(id, key) {
    var vp = viewerPresets(); vp[id] = key;
    try { localStorage.setItem(PRESET_LS, JSON.stringify(vp)); } catch (e) {}
  }
  /* ---------- 실시간 시세 (워커 경유 네이버 · 5분 캐시) ---------- */
  var PRICE_TTL = 5 * 60 * 1000;
  var livePrices = {}; // ticker → { price, ts }
  try { livePrices = JSON.parse(sessionStorage.getItem('companyAnalysis.livePrices') || '{}'); } catch (e) {}
  function priceBase() { return (window.Store && Store.url()) || ''; }
  function livePriceOf(ticker) {
    var e = livePrices[ticker];
    return (e && (Date.now() - e.ts) < PRICE_TTL) ? e : null;
  }
  // 화면에 필요한 종목의 현재가를 병렬 조회. 새로 받아온 게 있으면 true.
  function fetchLivePrices(companies) {
    var base = priceBase();
    if (!base) return Promise.resolve(false);
    var need = [];
    companies.forEach(function (c) {
      var t = (c.ticker || '').trim();
      if (/^\d{6}$/.test(t) && !livePriceOf(t) && need.indexOf(t) < 0) need.push(t);
    });
    if (!need.length) return Promise.resolve(false);
    return Promise.all(need.map(function (t) {
      return fetch(base + '?code=' + t)
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.price != null) livePrices[t] = { price: j.price, ts: Date.now() }; })
        .catch(function () {});
    })).then(function () {
      try { sessionStorage.setItem('companyAnalysis.livePrices', JSON.stringify(livePrices)); } catch (e) {}
      return true;
    });
  }
  function hhmm(ts) { var d = new Date(ts); function p(n) { return (n < 10 ? '0' : '') + n; } return p(d.getHours()) + ':' + p(d.getMinutes()); }

  // 뷰어 프리셋·실시간 시세를 반영한 회사 사본 (원본 data.js는 건드리지 않음)
  function effectiveCompany(c) {
    var key = viewerPresets()[c.id];
    var lp = livePriceOf((c.ticker || '').trim());
    if (!key && !lp) return c;
    var v2 = {}; Object.keys(c.valuation || {}).forEach(function (k) { v2[k] = c.valuation[k]; });
    if (key === 'default') delete v2.weights;
    else if (key && V.WEIGHT_PRESETS[key]) v2.weights = V.WEIGHT_PRESETS[key];
    if (lp) v2.price = lp.price;
    var c2 = {}; Object.keys(c).forEach(function (k) { c2[k] = c[k]; });
    c2.valuation = v2;
    if (lp) c2.__livePrice = lp;
    return c2;
  }
  function activePresetKey(c) {
    return viewerPresets()[c.id] || V.presetKeyOf((c.valuation || {}).weights);
  }

  /* 공유 저장소(워커 KV) 상태 — route()가 최초 1회 로드 */
  var sharedCompanies = null; // null=미로드, {}=로드됨(비어있음 포함)
  var sharedError = '';

  /* ---------- 매도 트리거 5단계 (종목별 — 자금 사슬 상류→하류) ----------
   * 업종마다 사슬이 다르므로 종목마다 5단계 항목(labels)을 따로 둔다.
   * company.sellTriggers = { flags:[5], labels:[5], memo }
   * ①② 점등 시부터 비중 축소(⑤까지 기다리면 늦음). */
  function companyTriggers(c) {
    var st = (c && c.sellTriggers) || {};
    var labels = (Array.isArray(st.labels) && st.labels.length === 5 && st.labels.some(function (x) { return x; }))
      ? st.labels.slice(0, 5) : V.DEFAULT_SELL_TRIGGERS.slice();
    var flags = Array.isArray(st.flags) ? st.flags.slice(0, 5) : [];
    while (flags.length < 5) flags.push(false);
    return { labels: labels, flags: flags.map(Boolean), memo: st.memo || '', updated: st.updated || '' };
  }
  function triggerAlertFor(c) {
    var f = companyTriggers(c).flags, n = f.filter(Boolean).length;
    if (!n) return null;
    var upstream = f[0] || f[1];
    return upstream
      ? { n: n, col: 'var(--red)', bg: '#fdecec', msg: '🔻 매도 트리거 ' + n + '/5 점등 — <b>상류(①②) 둔화</b>. 원칙: ①② 점등 시부터 <b>비중 축소 시작</b> (⑤까지 기다리면 늦음).' }
      : { n: n, col: 'var(--amber)', bg: '#fff6e6', msg: '⚠ 매도 트리거 ' + n + '/5 점등 (하류 ③~⑤). 상류(①②)까지 번지는지 점검.' };
  }
  function triggerBannerFor(c) {
    var a = triggerAlertFor(c);
    if (!a) return '';
    return '<div style="border-left:4px solid ' + a.col + ';background:' + a.bg + ';padding:8px 14px;border-radius:6px;margin-bottom:12px;font-size:13px;font-weight:600;color:' + a.col + '">' + a.msg + '</div>';
  }
  // 종목별 트리거 상태 저장: 공유본이면 공유 저장소, 아니면 로컬 오버라이드
  function persistCompany(company) {
    if (company.__shared && window.Store && Store.enabled()) {
      Store.save(company).then(function () { if (sharedCompanies) sharedCompanies[company.id] = company; })
        .catch(function (e) { alert('공유 저장 실패: ' + (e.message || e)); });
    } else {
      var ov = {}; try { ov = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) {}
      ov[company.id] = company;
      try { localStorage.setItem(LS_KEY, JSON.stringify(ov)); } catch (e) {}
    }
  }

  function loadCompanies() {
    var base = (window.COMPANIES || []).slice();
    var overrides = {};
    try { overrides = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { overrides = {}; }
    var byId = {};
    base.forEach(function (c) { byId[c.id] = c; });
    // 공유 기업: data.js보다 우선 (여럿이 함께 갱신하는 최신본)
    var sh = sharedCompanies || {};
    Object.keys(sh).forEach(function (id) {
      if (sh[id] && sh[id].id) { byId[id] = sh[id]; byId[id].__shared = true; }
    });
    Object.keys(overrides).forEach(function (id) {
      if (overrides[id] && overrides[id].__deleted) { delete byId[id]; return; }
      byId[id] = overrides[id];
    });
    return Object.keys(byId).map(function (id) { var c = byId[id]; c.__local = !!overrides[id]; return c; });
  }

  function signalEl(s, big) {
    var cls = 'signal ' + (s && s.key ? s.key : 'na') + (big ? ' lg' : '');
    return '<span class="' + cls + '"><span class="dot"></span>' + (s ? s.label : '판단 불가') + '</span>';
  }

  /* ---------- 뷰 모드 (카드 ↔ 비교표) ---------- */
  var VIEW_LS = 'companyAnalysis.viewMode';
  function viewMode() { try { return localStorage.getItem(VIEW_LS) || 'cards'; } catch (e) { return 'cards'; } }
  function setViewMode(m) { try { localStorage.setItem(VIEW_LS, m); } catch (e) {} }
  var tableSort = { key: 'fper', dir: 1 };

  function sectorKey(c) { return (c.sector || '').trim() || '미분류'; }

  /* 종목별 계산 결과 일괄 생성 (+업종 내 포워드PER 비교용 peers) */
  function buildRows(companies) {
    var rows = companies.map(function (c) {
      var eff = effectiveCompany(c);
      var val = V.computeValuation(eff);
      var U = V.unitToWon(c.unit);
      var fni = Number((eff.valuation || {}).forwardNI);
      var zp = (fni > 0 && val.marketCap != null) ? val.marketCap / (fni * U) : val.per;
      return { c: c, eff: eff, val: val, zonePer: (zp != null && isFinite(zp) && zp > 0) ? zp : null };
    });
    var bySector = {};
    rows.forEach(function (r) { (bySector[sectorKey(r.c)] = bySector[sectorKey(r.c)] || []).push(r.zonePer); });
    rows.forEach(function (r) { r.pr = V.computePrinciples(r.eff, r.val, bySector[sectorKey(r.c)]); });
    return rows;
  }

  /* ---------- 목록 ---------- */
  function renderGallery(companies) {
    var app = document.getElementById('app');
    var cards = companies.map(function (c) {
      var u = c.unit || '조원';
      var val = V.computeValuation(effectiveCompany(c));
      var t = val.trends || {};
      var lastY = (t.annual && t.annual.length) ? t.annual[t.annual.length - 1] : null;
      var upsideHtml = (val.upside != null) ? '<b>' + fmt.signedPct(val.upside) + '</b>' : '<b>–</b>';
      return '' +
        '<div class="card" data-id="' + c.id + '">' +
          '<div class="card-top"><div>' +
            '<div class="card-name">' + esc(c.name) + '</div>' +
            '<div class="card-meta">' + esc(c.market || '') + (c.sector ? ' · ' + esc(c.sector) : '') + '</div>' +
          '</div>' + (c.ticker ? '<span class="ticker-chip">' + esc(c.ticker) + '</span>' : '') + '</div>' +
          '<div>' + signalEl(val.signal) + (val.isExample ? ' <span class="example-badge">예시값</span>' : '') +
            (c.__shared ? ' <span class="example-badge" style="background:#e8f1fb;color:#2e75b6">☁ 공유</span>' : '') +
            (function () { var a = triggerAlertFor(c); return a ? ' <span class="example-badge" style="background:' + a.bg + ';color:' + a.col + '">🔻 매도 ' + a.n + '/5</span>' : ''; })() + '</div>' +
          '<div class="card-mini">' +
            '<div class="mini">상승여력' + upsideHtml + '</div>' +
            '<div class="mini">현재 PER<b>' + fmt.x(val.per) + (val.perFromHistory ? ' <span class="sub">(과거최신)</span>' : '') + '</b></div>' +
            '<div class="mini">ROE<b>' + (val.roe != null ? colorNum(fmt.pct(val.roe), val.roe >= 0.15 ? 1 : (val.roe < 0.05 ? -1 : 0)) : '–') + '</b></div>' +
            '<div class="mini">PEG<b>' + (val.peg != null ? colorNum(fmt.x(val.peg, 2), val.peg <= 1 ? 1 : (val.peg >= 2 ? -1 : 0)) : '–') + '</b></div>' +
            '<div class="mini">최근 연매출<b>' + (lastY ? fmt.money(lastY.revenue, u) : '–') + '</b></div>' +
            '<div class="mini">최근 영업이익<b>' + (lastY ? fmt.money(lastY.op, u) : '–') + '</b></div>' +
          '</div>' +
        '</div>';
    }).join('');
    var mode = viewMode();
    var toggle =
      '<span style="display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden">' +
      '<button class="btn sm" id="btn-view-cards" style="border:0;border-radius:0;' + (mode === 'cards' ? 'background:var(--navy);color:#fff' : '') + '">카드</button>' +
      '<button class="btn sm" id="btn-view-table" style="border:0;border-radius:0;' + (mode === 'table' ? 'background:var(--navy);color:#fff' : '') + '">비교표</button></span>';
    app.innerHTML =
      '<div class="gallery-head"><h2>분석 기업 ' + companies.length + '</h2>' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' + sharedStatusHtml() + toggle +
      '<a class="btn primary sm" href="editor.html">＋ 기업 추가 / 편집</a></div></div>' +
      (companies.length
        ? (mode === 'table' ? compareTable(companies) : '<div class="grid">' + cards + '</div>')
        : emptyState()) + disclaimer();
    Array.prototype.forEach.call(app.querySelectorAll('[data-id]'), function (el) {
      el.addEventListener('click', function () { location.hash = '#/' + el.getAttribute('data-id'); });
    });
    var bvc = document.getElementById('btn-view-cards');
    if (bvc) bvc.addEventListener('click', function () { setViewMode('cards'); renderGallery(loadCompanies()); });
    var bvt = document.getElementById('btn-view-table');
    if (bvt) bvt.addEventListener('click', function () { setViewMode('table'); renderGallery(loadCompanies()); });
    Array.prototype.forEach.call(app.querySelectorAll('[data-sortkey]'), function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sortkey');
        if (tableSort.key === k) tableSort.dir = -tableSort.dir; else { tableSort.key = k; tableSort.dir = 1; }
        renderGallery(loadCompanies());
      });
    });
    bindStoreKeyBtn();
  }

  /* ---------- 매도 트리거 5단계 보드 (종목별 — 상세 페이지) ---------- */
  function sellTriggerSection(company) {
    var t = companyTriggers(company);
    var lit = t.flags.filter(Boolean).length;
    var shared = (company.__shared && window.Store && Store.enabled());
    var num = ['①', '②', '③', '④', '⑤'];
    var chips = t.labels.map(function (lbl, i) {
      var on = t.flags[i];
      var zone = i < 2 ? '상류' : (i < 3 ? '중류' : '하류');
      return '<button class="btn sm" data-trig="' + i + '" title="' + zone + '" ' +
        'style="text-align:left;' + (on ? 'background:var(--red);color:#fff;border-color:var(--red)' : '') + '">' +
        (on ? '● ' : '○ ') + num[i] + ' ' + esc(lbl) + ' <span class="sub" style="' + (on ? 'color:#fff' : '') + '">' + zone + '</span></button>';
    }).join(' ');
    return '<div class="section"><h3>🔻 매도 트리거 5단계 — 이 종목의 자금 사슬</h3>' +
      '<p class="hint">이 종목이 속한 사슬의 <b>상류→하류</b> 조기경보입니다(업종마다 다름 — 항목은 편집기에서 수정). ' +
      '<b>①② 점등 시부터 비중 축소</b>를 시작하세요(⑤까지 기다리면 늦음). 클릭해 점등/소등 · ' +
      (shared ? '☁ 공유(친구들과 공유)' : '이 브라우저에 저장') + '.</p>' +
      '<div style="display:flex;flex-direction:column;gap:6px;max-width:560px">' + chips + '</div>' +
      '<div class="field" style="margin-top:10px;max-width:560px"><label>메모 (근거·날짜)</label>' +
      '<textarea id="trig-memo" rows="2" placeholder="예: 전방 고객사 3Q Capex 가이던스 하향, 2026-07">' + esc(t.memo || '') + '</textarea></div>' +
      (t.updated ? '<p class="small-note">갱신 ' + esc(t.updated) + '</p>' : '') + '</div>';
  }
  function bindSellTriggerSection(company) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-trig]'), function (btn) {
      btn.addEventListener('click', function () {
        var i = +btn.getAttribute('data-trig');
        var t = companyTriggers(company);
        t.flags[i] = !t.flags[i];
        company.sellTriggers = { flags: t.flags, labels: t.labels, memo: t.memo, updated: new Date().toISOString().slice(0, 10) };
        persistCompany(company);
        var y = window.scrollY; renderDetail(company); window.scrollTo(0, y);
      });
    });
    var memo = document.getElementById('trig-memo');
    if (memo) memo.addEventListener('change', function () {
      var t = companyTriggers(company);
      company.sellTriggers = { flags: t.flags, labels: t.labels, memo: memo.value, updated: new Date().toISOString().slice(0, 10) };
      persistCompany(company);
    });
  }

  /* ---------- 비교표 — 내가 알아본 종목끼리, 같은 업종끼리 (핵심: PER·포워드PER·ROE·영업이익률) ---------- */
  function compareTable(companies) {
    var rows = buildRows(companies);
    // 정렬용 수치 추출
    rows.forEach(function (r) {
      var t = r.val.trends || {};
      r.m = {
        mcap: r.val.marketCap, per: r.val.per, fper: r.pr.forwardPer,
        roe: r.val.roe, opm: (t.ttmRevenue ? t.ttmOp / t.ttmRevenue : null),
        pbr: r.val.pbr, debt: r.pr.debtRatio, div: r.val.divYield,
        revYoY: r.pr.screen ? r.pr.screen.revYoY : null, opYoY: r.pr.screen ? r.pr.screen.opYoY : null,
        score: r.pr.score
      };
    });
    var k = tableSort.key, dir = tableSort.dir;
    rows.sort(function (a, b) {
      var x = a.m[k], y = b.m[k];
      if (x == null && y == null) return 0;
      if (x == null) return 1; if (y == null) return -1;
      return (x - y) * dir;
    });
    // 업종 그룹핑 (같은 업종 텍스트끼리) + 그룹 내 하이라이트(최저 포워드PER·최고 ROE)
    var groups = {};
    rows.forEach(function (r) { (groups[sectorKey(r.c)] = groups[sectorKey(r.c)] || []).push(r); });
    var sigTxt = { go: ['● 매수후보', 'var(--green)'], numbersOnly: ['숫자만', 'var(--amber)'], catalystOnly: ['촉매만 ⚠', 'var(--red)'], none: ['–', 'var(--grey)'] };
    function th(label, key, hint) {
      return '<th data-sortkey="' + key + '" style="cursor:pointer;white-space:nowrap" title="' + (hint || '클릭해 정렬') + '">' + label +
        (tableSort.key === key ? (tableSort.dir === 1 ? ' ▲' : ' ▼') : '') + '</th>';
    }
    var head = '<tr><th style="text-align:left">기업</th>' +
      th('시총', 'mcap') + '<th style="color:var(--blue)" data-sortkey="per">PER' + (tableSort.key === 'per' ? (tableSort.dir === 1 ? ' ▲' : ' ▼') : '') + '</th>' +
      th('포워드PER', 'fper', '내년 예상이익 기준 — 포워드 중시 원칙') + th('ROE', 'roe') + th('영업이익률', 'opm', 'TTM — 해자 신호') +
      th('PBR', 'pbr') + th('부채비율', 'debt') + th('배당', 'div') +
      th('매출YoY', 'revYoY', '최근 분기, 전년 동분기 대비') + th('영익YoY', 'opYoY') +
      '<th title="매출↑+이익↑+흑자 (AND)">3대<br>스크리닝</th>' + th('7대<br>필터', 'score') + '<th>촉매</th><th>신호<br>(숫자×촉매)</th></tr>';
    var body = '';
    Object.keys(groups).sort().forEach(function (sec) {
      var g = groups[sec];
      var minF = null, maxR = null;
      if (g.length >= 2) {
        g.forEach(function (r) {
          if (r.m.fper != null && (minF == null || r.m.fper < minF)) minF = r.m.fper;
          if (r.m.roe != null && (maxR == null || r.m.roe > maxR)) maxR = r.m.roe;
        });
      }
      body += '<tr><td colspan="14" style="text-align:left;background:var(--bg-soft,#f4f6f8);font-weight:700;padding:6px 8px">' + esc(sec) + ' (' + g.length + ')</td></tr>';
      g.forEach(function (r) {
        var s = sigTxt[r.pr.signal] || sigTxt.none;
        var warn = r.pr.alerts.length ? ' <span title="' + esc(r.pr.alerts.join('\n')) + '" style="color:var(--red)">⚠</span>' : '';
        function td(v, fmtFn, hl) {
          return '<td' + (hl ? ' style="color:var(--green);font-weight:800"' : '') + '>' + (v == null ? '–' : fmtFn(v)) + '</td>';
        }
        body += '<tr style="cursor:pointer" data-id="' + r.c.id + '">' +
          '<td style="text-align:left;font-weight:700">' + esc(r.c.name) + warn +
          (r.c.__shared ? ' <span class="sub" style="color:#2e75b6">☁</span>' : '') + '</td>' +
          td(r.m.mcap, fmt.won) +
          td(r.m.per, function (x) { return x.toFixed(1); }) +
          td(r.m.fper, function (x) { return '<b>' + x.toFixed(1) + '</b>'; }, g.length >= 2 && r.m.fper === minF) +
          td(r.m.roe, function (x) { return fmt.pct(x); }, g.length >= 2 && r.m.roe === maxR) +
          td(r.m.opm, fmt.pct) +
          td(r.m.pbr, function (x) { return x.toFixed(2); }) +
          td(r.m.debt, function (x) { return Math.round(x) + '%'; }) +
          td(r.m.div, function (x) { return fmt.pct(x, 1); }) +
          td(r.m.revYoY, fmt.signedPct) + td(r.m.opYoY, fmt.signedPct) +
          '<td title="' + (r.pr.screen ? esc('매출↑ ' + mk(r.pr.screen.rev) + ' · 이익↑ ' + mk(r.pr.screen.op) + ' · 흑자 ' + mk(r.pr.screen.profit) + ' (' + (r.pr.latestLabel || '') + ' YoY)') : '') + '">' +
            (r.pr.screen ? (r.pr.screen.pass ? '<span style="color:var(--green);font-weight:800">✓</span>' : '<span style="color:var(--red)">✗</span>') : '–') + '</td>' +
          '<td>' + (r.pr.scoreKnown ? r.pr.score + '/' + r.pr.scoreKnown : '–') + '</td>' +
          '<td>' + (r.pr.catalysts.length ? r.pr.catalysts.filter(function (x) { return x.status === '유효' && !x.expired; }).length + '/' + r.pr.catalysts.length : '–') + '</td>' +
          '<td style="white-space:nowrap;color:' + s[1] + ';font-weight:700">' + s[0] + '</td></tr>';
      });
    });
    return '<div class="section" style="margin-top:0"><p class="hint" style="margin-top:0">' +
      '핵심 3지표(<b>PER·ROE·영업이익률</b>)+포워드PER 중심 · <b>같은 업종끼리만</b> 비교(업종명이 같은 종목끼리 묶임) · 그룹 내 <span style="color:var(--green);font-weight:700">최저 포워드PER·최고 ROE</span> 강조 · 열 제목 클릭 = 정렬 · ⚠ = 재고/채권이 매출보다 빨리 증가</p>' +
      '<div class="tbl-scroll"><table class="fin"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div></div>';
  }

  /* ---------- 공유 저장소 상태 표시 + 비밀번호 입력 ---------- */
  function sharedStatusHtml() {
    if (!window.Store || !Store.url()) return '';
    if (!Store.key())
      return '<button class="btn sm" id="btn-store-key" type="button">🔑 공유 데이터 보기 (비밀번호)</button>';
    if (sharedError)
      return '<span class="small-note" style="color:var(--red)">공유 로드 실패: ' + esc(sharedError) + '</span>' +
        '<button class="btn sm" id="btn-store-key" type="button">비밀번호 재입력</button>';
    var n = sharedCompanies ? Object.keys(sharedCompanies).length : 0;
    var live = Object.keys(livePrices).length ? ' · 📈 실시간 시세 반영(5분 캐시)' : '';
    return '<span class="small-note">☁ 공유 기업 ' + n + '개' + live + '</span>';
  }
  function bindStoreKeyBtn() {
    var b = document.getElementById('btn-store-key');
    if (!b) return;
    b.addEventListener('click', function () {
      var k = prompt('공유 비밀번호를 입력하세요 (이 브라우저에 저장됩니다):', Store.key() || '');
      if (k == null) return;
      Store.setKey(k);
      sharedCompanies = null; sharedError = '';
      route();
    });
  }

  function emptyState() {
    return '<div class="empty"><h3>아직 등록된 기업이 없습니다</h3>' +
      '<p>DART 공시 재무 데이터를 입력해 첫 기업을 추가해 보세요.</p>' +
      '<a class="btn primary" href="editor.html">＋ 기업 추가하기</a></div>';
  }

  /* ---------- 상세 ---------- */
  function renderDetail(company) {
    var app = document.getElementById('app');
    var u = company.unit || '조원';
    var eff = effectiveCompany(company);
    var val = V.computeValuation(eff);
    val.livePrice = eff.__livePrice || null;
    var t = val.trends || {};

    // 투자 원칙 체크 — 업종 내 비교(내가 알아본 종목 사이에서만)
    var all = loadCompanies();
    var peers = all.filter(function (x) { return sectorKey(x) === sectorKey(company); }).map(function (x) {
      var e2 = x.id === company.id ? eff : effectiveCompany(x);
      var v2 = x.id === company.id ? val : V.computeValuation(e2);
      var U = V.unitToWon(x.unit);
      var fni = Number((e2.valuation || {}).forwardNI);
      var zp = (fni > 0 && v2.marketCap != null) ? v2.marketCap / (fni * U) : v2.per;
      return (zp != null && isFinite(zp) && zp > 0) ? zp : null;
    });
    var pr = V.computePrinciples(eff, val, peers);

    app.innerHTML =
      '<a class="back-link" href="#">← 목록으로</a>' +
      triggerBannerFor(company) +
      detailHead(company, val) +
      principlesSection(pr, company, val) +
      sellTriggerSection(company) +
      valuationSection(company, val) +
      growthSection(val, t) +
      quarterChartSection() +
      marginSection(t) +
      cashflowSection(t, u) +
      seasonalSection(t, u) +
      efficiencySection(t) +
      annualSection(t.annual, u) +
      quarterTableSection(company, t, u) +
      buybackSection(company) +
      commentarySection(company) +
      disclaimer();

    // ----- 차트 렌더 -----
    var q = t.q || [];
    Charts.renderComboChart(document.getElementById('chart-q'), {
      labels: q.map(ql), bars: [
        { name: '매출액', color: 'var(--blue)', values: q.map(function (x) { return x.revenue; }) },
        { name: '영업이익', color: 'var(--orange)', values: q.map(function (x) { return x.op; }) }
      ],
      line: { name: 'OPM', color: 'var(--grey)', values: q.map(function (x) { return x.opm; }), fmt: pctFmt }
    });

    // PER 밴드
    if (val.histPer && document.getElementById('chart-perband')) {
      var vh = company.valuationHistory || [];
      Charts.renderBandChart(document.getElementById('chart-perband'), {
        labels: vh.map(ql), values: vh.map(function (x) { return x.per; }),
        band: val.histPer, current: val.per, color: 'var(--blue)'
      });
    }
    // 마진 추세
    if (document.getElementById('chart-margin')) {
      Charts.renderLineChart(document.getElementById('chart-margin'), {
        labels: q.map(ql), percent: true, lines: [
          { name: 'GPM(매출총이익률)', color: 'var(--blue)', values: q.map(function (x) { return x.gpm; }) },
          { name: 'OPM(영업이익률)', color: 'var(--orange)', values: q.map(function (x) { return x.opm; }) },
          { name: '판관비율', color: 'var(--grey)', values: q.map(function (x) { return x.sgaRatio; }) }
        ]
      });
    }
    // 현금흐름
    if (document.getElementById('chart-cf')) {
      Charts.renderComboChart(document.getElementById('chart-cf'), {
        labels: q.map(ql), bars: [
          { name: 'OCF(영업현금흐름)', color: 'var(--blue)', values: q.map(function (x) { return x.ocf; }) },
          { name: 'CAPEX(설비투자)', color: 'var(--orange)', values: q.map(function (x) { return x.capex; }) },
          { name: 'FCF(잉여현금흐름)', color: 'var(--green)', values: q.map(function (x) { return x.fcf; }) }
        ]
      });
    }
    // 계절성
    if (t.seasonal && document.getElementById('chart-season')) {
      var sn = t.seasonal;
      Charts.renderComboChart(document.getElementById('chart-season'), {
        labels: ['1Q', '2Q', '3Q', '4Q'],
        bars: sn.years.map(function (y, i) {
          return { name: y, color: PALETTE[i % PALETTE.length],
            values: [1, 2, 3, 4].map(function (qn) { var v = sn.byQ[qn][y]; return v == null ? null : v; }) };
        })
      });
    }
    // 효율성
    if (document.getElementById('chart-eff')) {
      Charts.renderLineChart(document.getElementById('chart-eff'), {
        labels: q.map(ql), lines: [
          { name: '재고자산 회전율', color: 'var(--blue)', values: q.map(function (x) { return x.invTurn; }) },
          { name: '매출채권 회전율', color: 'var(--orange)', values: q.map(function (x) { return x.arTurn; }) }
        ], fmt: function (v) { return (Math.round(v * 100) / 100).toString(); }
      });
    }
    // 주주환원
    if (document.getElementById('chart-buyback')) {
      var bb = company.buybacks || [];
      Charts.renderComboChart(document.getElementById('chart-buyback'), {
        labels: bb.map(ql), bars: [{ name: '자사주 매입액', color: 'var(--navy-2, #2e4a7d)', values: bb.map(function (x) { return x.amount; }) }]
      });
    }
    // 주식 성격 '적용' → 이 브라우저에 저장 후 재계산 (스크롤 위치 유지)
    var pBtn = document.getElementById('preset-apply');
    if (pBtn) pBtn.addEventListener('click', function () {
      setViewerPreset(company.id, document.getElementById('preset-select').value);
      var y = window.scrollY;
      renderDetail(company);
      window.scrollTo(0, y);
    });
    bindSellTriggerSection(company);
    window.scrollTo(0, 0);
  }

  function ql(x) { return x.label; }
  function pctFmt(v) { return (v * 100).toFixed(0) + '%'; }

  function detailHead(c, val) {
    return '<div class="detail-head"><div>' +
      '<div class="detail-title"><h2>' + esc(c.name) + '</h2>' +
      (c.ticker ? '<span class="ticker-chip">' + esc(c.ticker) + '</span>' : '') +
      signalEl(val.signal, true) +
      (val.isExample ? '<span class="example-badge">예시값 — 시세·DART로 갱신 필요</span>' : '') + '</div>' +
      '<p class="detail-sub">' + esc(c.market || '') + (c.sector ? ' · ' + esc(c.sector) : '') +
      (c.statement ? ' · ' + esc(c.statement) : '') +
      (c.updated ? ' · 업데이트 ' + esc(c.updated) : '') + '</p></div>' +
      '<a class="btn sm" href="editor.html#' + c.id + '">✎ 편집</a></div>';
  }

  function valuationSection(c, val) {
    if (!val.ok) {
      return '<div class="section"><h3>밸류에이션</h3>' +
        '<p class="hint">밸류에이션 입력이 부족합니다. <a href="editor.html#' + c.id + '">편집에서 입력</a></p></div>';
    }
    var upCls = val.upside == null ? '' : (val.upside >= 0 ? 'pos' : 'neg');
    var bandBar = '';
    if (val.perBandPos != null && val.perBand) {
      var b = val.perBand;
      var srcTxt = b.source === 'history' ? '역사적 ' + val.histPer.n + '개 분기 PER 분포' : '수동 입력 밴드';
      bandBar = '<div class="band"><div class="band-track">' +
        '<div class="band-marker" style="left:' + clamp(val.perBandPos * 100) + '%"></div></div>' +
        '<div class="band-scale"><span>저 ' + fmt.x(b.low) + '</span><span>' + (b.avg != null ? '중앙 ' + fmt.x(b.avg) : '') + '</span><span>고 ' + fmt.x(b.high) + '</span></div>' +
        '<div class="small-note" style="margin-top:4px">현재 PER ' + fmt.x(val.per) + (val.perFromHistory ? ' (과거 최신값)' : '') + ' · 기준: ' + srcTxt + '</div></div>';
    }
    var perbandChart = val.histPer
      ? '<div style="margin-top:16px"><div class="hint" style="margin-bottom:6px">역사적 PER 밴드 (분기별) — 현재 위치(굵은 선)가 아래쪽일수록 저평가</div><div class="chart-box" id="chart-perband"></div></div>'
      : '';

    var anchorSub = [];
    if (val.fairByPbr != null) anchorSub.push('PBR기준 ' + fmt.price(val.fairByPbr));
    if (val.fairByDiv != null) anchorSub.push('배당기준 ' + fmt.price(val.fairByDiv));
    if (val.fairByPer != null) anchorSub.push('PER기준 ' + fmt.price(val.fairByPer));
    return '<div class="section"><h3>밸류에이션 — 기업가치 대비 현재 주가 (12개월 관점)</h3>' +
      '<p class="hint">멀티플(PER·PBR·배당) 기반. ' + (val.histPer ? '<b>역사적 배수 밴드</b>로 현재 위치를 판단. ' : '') +
      '적정주가 = 앵커별 <b>가중</b> 평균' + (val.fairWeights ? ' (' + val.fairWeights + ')' : '') +
      ' — 자기 역사 대비 <b>PBR</b>이 12개월 표본외 검증에서 가장 강건해 가중치를 높게, 이익수익률(PER)은 낮게 둡니다. 6개월 이하 단기 타이밍 신호가 아닙니다.</p>' +
      presetControl(c) +
      '<div class="verdict">' +
        '<div class="verdict-left">' + signalEl(val.signal, true) +
          (val.upside != null ? '<div class="upside ' + upCls + '">' + fmt.signedPct(val.upside) + '</div><small>적정주가 대비 상승여력</small>'
            : '<div class="upside" style="font-size:20px">' + fmt.x(val.per) + '</div><small>현재 PER (밴드 대비 위치로 판단)</small>') + '</div>' +
        '<div class="metric-grid">' +
          metric('현재 주가', fmt.price(val.price),
                 val.livePrice ? '📈 실시간 시세 (' + hhmm(val.livePrice.ts) + ' 조회)' : '저장 시점 값 — 시세 서버 미연결') +
          metric('적정주가(밴드)', val.fairLow != null ? fmt.price(val.fairLow) + ' ~ ' + fmt.price(val.fairHigh) : '–',
                 (val.fairAvg != null ? '가중평균 ' + fmt.price(val.fairAvg) : '') + (anchorSub.length ? ' · ' + anchorSub.join(' · ') : '')) +
          metric('현재 PER', fmt.x(val.per), val.targetPer != null ? '목표/중앙 ' + fmt.x(val.targetPer) : '') +
          metric('현재 PBR', fmt.x(val.pbr, 2), val.targetPbr != null ? '목표/중앙 ' + fmt.x(val.targetPbr, 2) : '') +
          metric('배당수익률', val.divYield != null ? fmt.pct(val.divYield, 2) : '–',
                 val.inputs && val.inputs.targetDivYield != null ? '목표 ' + val.inputs.targetDivYield + '%' : 'DPS 입력 시 표시') +
          metric('EPS(TTM)', val.eps != null ? fmt.price(val.eps) : '–', val.bps != null ? 'BPS ' + fmt.price(val.bps) : '') +
          metric('시가총액', val.marketCap != null ? fmt.won(val.marketCap) : '–', val.netIncomeTTM != null ? '순이익TTM ' + val.netIncomeTTM : '') +
        '</div></div>' +
        (bandBar ? '<div style="margin-top:16px">' + bandBar + '</div>' : '') + perbandChart +
      '</div>';
  }

  function metric(lbl, val, sub) {
    return '<div class="metric"><div class="lbl">' + lbl + '</div><div class="val">' + val + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
  }

  /* 주식 성격(앵커 가중) 선택 — 보는 사람이 직접 바꿔서 '적용' (이 브라우저에만 저장) */
  function presetControl(c) {
    var active = activePresetKey(c);
    var authorKey = V.presetKeyOf((c.valuation || {}).weights);
    var opts = ['default', 'growth', 'cyclical'].map(function (k) {
      return '<option value="' + k + '"' + (k === active ? ' selected' : '') + '>' + esc(V.PRESET_LABELS[k]) +
        (k === authorKey ? ' — 작성자 설정' : '') + '</option>';
    }).join('');
    var overridden = viewerPresets()[c.id] && viewerPresets()[c.id] !== authorKey;
    return '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0 14px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg-soft,#fafbfc)">' +
      '<b style="font-size:13px">주식 성격</b>' +
      '<select id="preset-select" style="font-size:13px;padding:6px 8px;max-width:420px">' + opts + '</select>' +
      '<button class="btn sm primary" id="preset-apply" type="button">적용</button>' +
      (overridden ? '<span class="small-note" style="color:var(--amber)">이 브라우저에서 바꾼 가중이 적용 중 (작성자 설정과 다름)</span>' : '') +
      '</div>';
  }

  /* ---------- 투자 원칙 체크 섹션 (숫자×촉매 · 3대 스크리닝 · 7대 필터 · 밸류 3좌표) ---------- */
  function chip(label, ok, sub) {
    var col = ok === true ? 'var(--green)' : (ok === false ? 'var(--red)' : 'var(--grey)');
    return '<span style="font-weight:700;color:' + col + '">' + mk(ok) + ' ' + label +
      (sub ? ' <span class="sub" style="font-weight:400">' + sub + '</span>' : '') + '</span>';
  }
  function principlesSection(pr, c, val) {
    var hasAny = pr.screen || pr.catalysts.length || pr.zonePer != null;
    if (!hasAny) return '';
    var u = c.unit || '조원';
    var t = val.trends || {};
    var SIG = {
      go: ['var(--green)', '● 매수 후보 (숫자 × 촉매 충족)', '곱셈이 살아있음 — 마지막 관문: ⑦주봉 바닥권 확인 후 3분할 매수(40/30/30).'],
      numbersOnly: ['var(--amber)', '숫자만 충족 — 촉매 없음', '촉매 없이는 하염없이 기다릴 수 있음(가치함정 주의). 6~12개월 내 구체적 촉매를 찾아 입력하세요.'],
      catalystOnly: ['var(--red)', '⚠ 촉매만 있음 — 숫자 미충족', '숫자(실적 개선) 없는 테마는 폭탄. 매출↑·이익↑·흑자가 확인될 때까지 관망.'],
      none: ['var(--grey)', '관망', '숫자도 촉매도 없음 — "아직 싼데 막 좋아지기 시작한" 자리가 아님. 현금도 포지션.']
    };
    var s = SIG[pr.signal];
    var scr = pr.screen;
    var html = '<div class="section"><h3>🎯 투자 원칙 체크 — 주가 = 숫자 × 촉매</h3>';

    // ── 1행: 시가총액 (시작점 — 주가가 아니라 몸값을 보라) ──
    if (val.marketCap != null) {
      var mc = val.marketCap;
      var size = mc < 5e11 ? ['중소형주', 'var(--green)', '소외 구간 — 작은 실적 변화에도 재평가 탄력 큼']
        : (mc < 2e12 ? ['중형주', 'var(--blue)', '']
        : ['대형주', 'var(--grey)', '커버리지 많음 — 개인의 정보 우위 작음']);
      html += '<div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:10px">' +
        '<span class="lbl" style="font-size:12px;color:var(--ink-2)">시가총액(몸값)</span>' +
        '<b style="font-size:22px">' + fmt.won(mc) + '</b>' +
        '<span style="font-weight:700;color:' + size[1] + '">' + size[0] + '</span>' +
        (size[2] ? '<span class="small-note">' + size[2] + '</span>' : '') +
        (val.livePrice ? '<span class="small-note">📈 실시간가 기준</span>' : '') + '</div>';
    }

    // ── 2행: 핵심 지표 한 줄 (매출·영업이익·영업이익률·PER·ROE) ──
    if (pr.latestRev != null) {
      html += '<div class="metric-grid" style="margin-bottom:10px">' +
        metric('매출액', fmt.money(pr.latestRev, u), esc(pr.latestLabel || '')) +
        metric('영업이익', fmt.money(pr.latestOp, u), esc(pr.latestLabel || '')) +
        metric('영업이익률', pr.latestOpm != null ? fmt.pct(pr.latestOpm) : '–', '해자 신호') +
        metric('PER', fmt.x(val.per), pr.forwardPer != null ? '포워드 ' + pr.forwardPer.toFixed(1) + '배' : '') +
        metric('ROE', val.roe != null ? fmt.pct(val.roe) : '–', '') +
        '</div>';
    }

    // ── 3행: 변화율 + 흑자 신호 (색상) ──
    if (scr) {
      var PS = {
        turnBlack: ['🔥 흑자 전환!', 'var(--green)', '#e6f6ee'],
        stayBlack: [pr.profitYoYKnown ? '흑자 유지' : '흑자', 'var(--green)', ''],
        turnRed: ['⚠ 적자 전환', 'var(--red)', '#fdecec'],
        stayRed: [pr.profitYoYKnown ? '적자 지속' : '적자', 'var(--red)', '#fdecec']
      };
      var ps = PS[pr.profitState] || PS.stayRed;
      function delta(label, ok, yoy) {
        var col = ok === true ? 'var(--green)' : (ok === false ? 'var(--red)' : 'var(--grey)');
        return '<span style="border:1.5px solid ' + col + ';color:' + col + ';border-radius:8px;padding:4px 10px;font-weight:800">' +
          label + ' ' + (yoy != null ? fmt.signedPct(yoy) : mk(ok)) + '</span>';
      }
      html += '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px">' +
        '<b style="font-size:13px">변화(3대 스크리닝)</b>' +
        delta('매출 YoY', scr.rev, scr.revYoY) +
        delta('영업이익 YoY', scr.op, scr.opYoY) +
        '<span style="border-radius:8px;padding:4px 10px;font-weight:800;color:' + ps[1] + ';' + (ps[2] ? 'background:' + ps[2] : 'border:1.5px solid ' + ps[1]) + '">' + ps[0] + '</span>' +
        '<span class="small-note">' + esc(pr.latestLabel || '') + ' 전년 동분기 대비' +
        (pr.revQoQ != null ? ' · QoQ 매출 ' + fmt.signedPct(pr.revQoQ) : '') +
        (pr.opQoQ != null ? ' 영업이익 ' + fmt.signedPct(pr.opQoQ) : '') + '</span></div>';
    }
    pr.alerts.forEach(function (a) { html += '<p class="small-note" style="color:var(--red);margin:2px 0">' + esc(a) + ' — 이익의 질 점검 필요</p>'; });

    // ── 4행: P-사이클 위치 점검 (OPM 밴드·GPM 방향·재고·PBR 밴드) ──
    var cyc = [];
    if (t.opmLast != null && t.opmMin != null && t.opmMax > t.opmMin) {
      var opos = (t.opmLast - t.opmMin) / (t.opmMax - t.opmMin);
      var oc = opos >= 0.67 ? ['역사적 상단 — 정점 부근 가능성 ⚠', 'var(--red)'] : (opos <= 0.33 ? ['역사적 하단 — 바닥권 가능성', 'var(--green)'] : ['중간', 'var(--grey)']);
      cyc.push('OPM ' + fmt.pct(t.opmLast) + ' <span style="color:' + oc[1] + ';font-weight:700">' + oc[0] + '</span> <span class="sub">(역사 ' + fmt.pct(t.opmMin) + '~' + fmt.pct(t.opmMax) + ')</span>');
    }
    var gq = (t.q || []).filter(function (x) { return x.gpm != null; });
    if (gq.length >= 5) {
      var gLast = gq[gq.length - 1].gpm;
      var gPrev = gq.slice(-5, -1).reduce(function (a, x) { return a + x.gpm; }, 0) / 4;
      cyc.push('GPM(스프레드) ' + (gLast > gPrev ? '<span style="color:var(--green);font-weight:700">▲ 확대</span>' : '<span style="color:var(--red);font-weight:700">▼ 축소</span>') +
        ' <span class="sub">' + fmt.pct(gLast) + ' vs 직전4Q평균 ' + fmt.pct(gPrev) + '</span>');
    }
    if (pr.invYoY != null) cyc.push('재고 YoY ' + fmt.signedPct(pr.invYoY) +
      (pr.screen && pr.screen.revYoY != null && pr.invYoY > pr.screen.revYoY ? ' <span style="color:var(--red);font-weight:700">(매출보다 빠름 ⚠)</span>' : ''));
    if (val.pbrBandPos != null) cyc.push('PBR 역사 밴드 위치 <b>' + Math.round(val.pbrBandPos * 100) + '%</b>' +
      (val.pbrBandPos >= 0.67 ? ' <span style="color:var(--red);font-weight:700">상단 ⚠</span>' : (val.pbrBandPos <= 0.33 ? ' <span style="color:var(--green);font-weight:700">하단</span>' : '')));
    if (cyc.length) {
      html += '<div style="margin-top:10px;border:1px solid var(--line);border-radius:8px;padding:8px 12px">' +
        '<b style="font-size:13px">' + (pr.pq === 'P' ? '⚠ P-사이클 위치 점검 — 사이클 위치가 전부, 정점의 저PER은 함정' : '사이클 위치 점검') + '</b>' +
        (pr.pq === 'Q' ? ' <span class="small-note">Q-사이클(수량 성장) — 저PER이 진짜 기회일 수 있음</span>' : '') +
        '<div class="small-note" style="margin-top:4px;line-height:2">' + cyc.join('<br>') + '</div></div>';
    } else if (pr.pq === 'P') {
      html += '<p class="small-note" style="color:var(--amber)">⚠ P-사이클 — 정점의 저PER은 함정. OPM 밴드·재고를 보려면 원가·재고 데이터를 입력하세요.</p>';
    }

    // ── 5행: 주봉 차트 (네이버) — ⑦ 바닥권 확인 ──
    if (/^\d{6}$/.test((c.ticker || '').trim())) {
      var code = c.ticker.trim();
      var chartUrl = 'https://ssl.pstatic.net/imgfinance/chart/item/candle/week/' + code + '.png?sidcode=' + Date.now();
      html += '<div style="margin-top:12px"><b style="font-size:13px">⑦ 주봉 차트 — 바닥권 확인</b> ' +
        '<span class="small-note">하락 중(떨어지는 칼날)이 아니라 <b>바닥을 다진 뒤</b>인지. ' +
        '<a href="https://finance.naver.com/item/fchart.naver?code=' + code + '" target="_blank" rel="noopener">네이버에서 크게 보기 ↗</a></span>' +
        '<div style="margin-top:6px"><img src="' + chartUrl + '" referrerpolicy="no-referrer" alt="주봉 차트" ' +
        'style="max-width:100%;border:1px solid var(--line);border-radius:8px;background:#fff" ' +
        'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\'">' +
        '<p class="small-note" style="display:none">차트 이미지를 불러오지 못했습니다 — 위 네이버 링크로 확인하세요.</p></div></div>';
    }

    // ── 판정: 숫자 × 촉매 신호 배너 ──
    html += '<div style="border-left:4px solid ' + s[0] + ';background:var(--bg-soft,#fafbfc);padding:10px 14px;border-radius:6px;margin-top:14px">' +
      '<b style="color:' + s[0] + ';font-size:15px">' + s[1] + '</b><div class="small-note" style="margin-top:3px">' + s[2] + '</div></div>';
    // 포워드 PER · 밸류 3좌표
    if (pr.zonePer != null) {
      function pos(x) { var lo = Math.log(5), hi = Math.log(80); return Math.max(0, Math.min(100, (Math.log(x) - lo) / (hi - lo) * 100)); }
      html += '<div style="margin-top:12px"><b style="font-size:13px">밸류 3좌표 — ' +
        (pr.zoneIsForward ? '포워드 PER <b>' + pr.zonePer.toFixed(1) + '배</b> (내년 예상이익 기준)' : '현재 PER ' + pr.zonePer.toFixed(1) + '배 <span class="sub">(포워드 순이익 입력 시 포워드 기준)</span>') +
        ' → <span style="color:var(--blue)">' + esc(pr.zone || '') + '</span></b>' +
        '<div class="band" style="margin-top:6px"><div class="band-track">' +
        '<div class="band-marker" style="left:' + pos(pr.zonePer) + '%"></div></div>' +
        '<div class="band-scale"><span>저 10배 (매수 검토)</span><span>중 20배 (분할매도 시작)</span><span>고 60배</span></div></div>' +
        '<p class="small-note">전략: "저→중" 재평가 구간을 먹는다. 중 도달 시 분할 매도 시작.</p></div>';
    }
    // 7대 필터
    html += '<div style="margin-top:12px"><b style="font-size:13px">7대 필터 — ' + pr.score + '/' + pr.scoreKnown + ' 통과' +
      (pr.scoreKnown < 7 ? ' <span class="sub">(' + (7 - pr.scoreKnown) + '개 미확인)</span>' : '') + '</b>';
    pr.filters.forEach(function (f) {
      var st = f.ok === true ? 'ok' : 'todo';
      html += '<div class="check-row ' + st + '"><span class="chk" style="' + (f.ok === false ? 'color:var(--red)' : '') + '">' + mk(f.ok) + '</span>' +
        '<span class="chk-label">' + f.no + '. ' + esc(f.label) + '</span>' +
        '<span class="chk-note">' + esc(f.note || (f.auto ? '자동' : '')) + '</span></div>';
    });
    html += '</div>';
    // 촉매 목록
    if (pr.catalysts.length) {
      var GCOL = { 'Fact/A': 'var(--green)', 'Fact/B': 'var(--blue)', '추정': 'var(--amber)', '판단': 'var(--grey)' };
      html += '<div style="margin-top:12px"><b style="font-size:13px">촉매 (' + pr.catalysts.length + ')</b>';
      pr.catalysts.forEach(function (cat) {
        var dead = cat.expired || cat.status !== '유효';
        html += '<div style="border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin-top:6px;' + (dead ? 'opacity:.55' : '') + '">' +
          '<span style="border:1px solid ' + (GCOL[cat.grade] || 'var(--grey)') + ';color:' + (GCOL[cat.grade] || 'var(--grey)') + ';border-radius:6px;padding:1px 6px;font-size:11px;font-weight:700">' + esc(cat.grade) + '</span> ' +
          esc(cat.text) +
          '<span class="small-note" style="margin-left:8px">' + (cat.due ? '시한 ' + esc(cat.due) : '시한 미지정') +
          ' · ' + esc(cat.status) + (cat.expired ? ' · <b style="color:var(--red)">기한 경과 — 논리 재점검</b>' : '') + '</span></div>';
      });
      html += '</div>';
    }

    // ── 원칙 가이드 (접이식) — 이익의 질 · 동일업종 포워드 PER ──
    html += '<div style="margin-top:14px;border-top:1px dashed var(--line);padding-top:10px">';
    var qBadge = pr.qFlags.length ? ' <span style="color:var(--red);font-weight:700">⚠ 자동 점검에 걸린 항목 있음</span>' : '';
    html += '<details style="margin-bottom:6px"><summary style="cursor:pointer;font-weight:700;font-size:13px">📎 이익의 질 — 정기보고서 어디를 보나' + qBadge + '</summary>' +
      '<div class="small-note" style="line-height:1.9;margin-top:6px">' +
      'DART 「<b>III. 재무에 관한 사항</b>」의 재무제표와 <b>주석</b>을 봅니다.<br>' +
      '① <b>손익계산서</b>: 영업이익과 순이익을 나란히. <b>순이익이 영업이익보다 유난히 크면</b> 본업 밖에서 번 돈이 섞인 신호.' +
      (pr.qNiOpGap != null ? ' <b>이 종목 순이익/영업이익 = ' + pr.qNiOpGap.toFixed(2) + '배' + (pr.qNiOpGap > 1.3 ? ' (⚠ 큼)' : ' (정상)') + '</b>' : '') + '<br>' +
      '② <b>주석</b>: 「기타수익·영업외수익·금융수익」 내역에서 유형자산처분이익·보험금·보상금·지분법이익·환율효과가 크면 <b>일회성</b>(이번 분기만 있고 다음엔 없을 돈).<br>' +
      '③ <b>현금흐름표</b>: 영업활동현금흐름(OCF)이 (+)인지.' +
      (pr.ocfPos != null ? ' <b>이 종목 최근 4Q OCF 합 = ' + (pr.ocfPos ? '(+)' : '(−) ⚠') + '</b>' : '') +
      ' 영업이익은 나는데 OCF가 계속 (−)면 장부상 흑자를 의심.<br>' +
      '요약: “<b>영업이익에서 나왔고 · 큰 일회성이 없고 · 현금으로 들어오는가</b>” — 주석 확인 후 편집기에서 ②를 체크하세요.</div></details>';
    html += '<details><summary style="cursor:pointer;font-weight:700;font-size:13px">📎 동일업종 PER 비교 — 포워드로, 직접 고른 경쟁사 2~3개와</summary>' +
      '<div class="small-note" style="line-height:1.9;margin-top:6px">' +
      '① <b>업종 평균은 성격 다른 회사가 섞여 왜곡</b>되기 쉬움 → 직접 고른 <b>경쟁사 2~3개</b>와 비교(여기에 그 경쟁사를 등록하면 위 비교표·필터⑤에 자동 반영).<br>' +
      '② 보라는 건 과거가 아니라 <b>포워드 PER</b> = 시가총액 ÷ <b>내년 예상 순이익</b>. 컨센서스 있으면 네이버 「종목분석」 추정 PER, 소형주는 직접 추정.' +
      ' 이 추정은 근거등급 <b>[추정]</b>으로 촉매/노트에 표시.<br>' +
      '참고: 네이버 금융 종목페이지 「동일업종 PER·동일업종 비교」, KRX(data.krx.co.kr) 업종 PER, FnGuide(comp.fnguide.com).' +
      (pr.forwardPer != null ? '<br><b>이 종목 포워드 PER = ' + pr.forwardPer.toFixed(1) + '배</b>' + (pr.peerMedianPer != null ? ' · 동종 ' + pr.peerCount + '곳 중앙값 ' + pr.peerMedianPer.toFixed(1) + '배 → ' + (pr.cheapVsPeers ? '<span style="color:var(--green);font-weight:700">싸다</span>' : '<span style="color:var(--red);font-weight:700">비싸다</span>') : '') : '<br><span style="color:var(--amber)">포워드 순이익을 입력하면 포워드 PER로 계산됩니다.</span>') +
      '</div></details>';
    html += '</div>';

    return html + '</div>';
  }

  /* 좋음(+1)/나쁨(-1)/중립(0)에 따라 값에 색을 입힘 */
  function colorNum(txt, good) {
    if (good > 0) return '<span style="color:var(--green)">' + txt + '</span>';
    if (good < 0) return '<span style="color:var(--red)">' + txt + '</span>';
    return txt;
  }

  /* ---------- 성장·수익성 핵심 지표 (ROE · EPS성장률 · PEG · 매출/영업이익 성장률) ---------- */
  function growthSection(val, t) {
    var has = val.roe != null || val.epsGrowth != null || val.peg != null ||
              t.revCAGR3 != null || t.opCAGR3 != null;
    if (!has) return '';
    var srcTxt = { manual: '입력한 예상 성장률', cagr: '연간 순이익 CAGR ' + (t.niCAGRSpan || ''), ttm: '최근 4분기 vs 직전 4분기' }[val.epsGrowthSrc] || '';
    return '<div class="section"><h3>성장 · 수익성 핵심 지표</h3>' +
      '<p class="hint">가치투자 핵심 체크: <b>ROE ≥ 15%</b>·<b>PEG ≤ 1</b>이면 우량·저평가 신호, ROE &lt; 5%·PEG ≥ 2면 주의. ' +
      'EPS 성장률은 발행주식수가 크게 변하지 않았다는 가정에서 순이익 성장률로 근사합니다.</p>' +
      '<div class="metric-grid">' +
        metric('ROE', val.roe != null ? colorNum(fmt.pct(val.roe), val.roe >= 0.15 ? 1 : (val.roe < 0.05 ? -1 : 0)) : '–', '순이익TTM ÷ 자본총계') +
        metric('EPS 성장률', val.epsGrowth != null ? colorNum(fmt.signedPct(val.epsGrowth), val.epsGrowth >= 0.1 ? 1 : (val.epsGrowth < 0 ? -1 : 0)) : '–', srcTxt) +
        metric('PEG', val.peg != null ? colorNum(fmt.x(val.peg, 2), val.peg <= 1 ? 1 : (val.peg >= 2 ? -1 : 0)) : '–',
               (val.peg == null && val.epsGrowth != null && val.epsGrowth <= 0)
                 ? 'EPS 성장률 ≤ 0 → 계산 불가 (예상 성장률 입력 시 표시)'
                 : 'PER ÷ EPS성장률(%) · 1↓ 저평가') +
        metric('매출 성장률(3y)', t.revCAGR3 != null ? fmt.signedPct(t.revCAGR3) : '–', t.revYoYTTM != null ? 'TTM YoY ' + fmt.signedPct(t.revYoYTTM) : 'CAGR, 완전 연도 기준') +
        metric('영업이익 성장률(3y)', t.opCAGR3 != null ? fmt.signedPct(t.opCAGR3) : '–', t.opYoYTTM != null ? 'TTM YoY ' + fmt.signedPct(t.opYoYTTM) : 'CAGR, 완전 연도 기준') +
        metric('순이익 성장률(3y)', t.niCAGR3 != null ? fmt.signedPct(t.niCAGR3) : '–', t.niYoYTTM != null ? 'TTM YoY ' + fmt.signedPct(t.niYoYTTM) : '분기 순이익 입력 필요') +
      '</div></div>';
  }

  function quarterChartSection() {
    return '<div class="section"><h3>분기 실적 장기 추세 (조합 차트)</h3>' +
      '<p class="hint">매출·영업이익(막대) + OPM(선). 리스크 헤지 관점의 핵심 시각화 — 사이클의 계곡을 체화하세요.</p>' +
      '<div class="chart-box" id="chart-q"></div></div>';
  }

  function marginSection(t) {
    var has = (t.q || []).some(function (x) { return x.gpm != null || x.sgaRatio != null; });
    if (!has) return '';
    return '<div class="section"><h3>마진 추세 (GPM · 판관비율 · OPM)</h3>' +
      '<p class="hint">매출총이익률(GPM)과 영업이익률(OPM)의 간격이 판관비율. 원가·스프레드 변화가 마진에 반영됩니다.</p>' +
      '<div class="chart-box" id="chart-margin"></div></div>';
  }

  function cashflowSection(t, u) {
    var has = (t.q || []).some(function (x) { return x.ocf != null || x.capex != null || x.fcf != null; });
    if (!has) return '';
    return '<div class="section"><h3>현금흐름 (OCF · CAPEX · FCF, ' + esc(u) + ')</h3>' +
      '<p class="hint">FCF(잉여현금흐름) = OCF(영업현금흐름) − CAPEX(설비투자). FCF가 꾸준히 (+)인지, 이익과 괴리는 없는지 확인.</p>' +
      '<div class="chart-box" id="chart-cf"></div></div>';
  }

  function seasonalSection(t, u) {
    if (!t.seasonal) return '';
    return '<div class="section"><h3>계절성 — 같은 분기 연도별 비교 (매출, ' + esc(u) + ')</h3>' +
      '<p class="hint">1~4분기별로 연도를 나란히 배치. 계절적 성수기·비수기 패턴과 연도별 성장을 함께 확인.</p>' +
      '<div class="chart-box" id="chart-season"></div></div>';
  }

  function efficiencySection(t) {
    var has = (t.q || []).some(function (x) { return x.invTurn != null || x.arTurn != null; });
    if (!has) return '';
    return '<div class="section"><h3>효율성 — 재고·매출채권 회전율</h3>' +
      '<p class="hint">재고회전율 = 매출원가 ÷ 재고자산, 매출채권회전율 = 매출액 ÷ 매출채권. 낮아지면 재고 적체·대금 회수 지연 신호.</p>' +
      '<div class="chart-box" id="chart-eff"></div></div>';
  }

  function annualSection(annual, u) {
    if (!annual || !annual.length) return '';
    var hasGpm = annual.some(function (a) { return a.gpm != null; });
    var hasFcf = annual.some(function (a) { return a.fcf != null; });
    var hasNI = annual.some(function (a) { return a.netIncome != null; });
    var rows = annual.map(function (a) {
      var partial = a.n < 4 ? ' <span class="sub">(' + a.n + 'Q)</span>' : '';
      return '<tr><td>' + a.year + partial + '</td><td>' + fmt.money(a.revenue, u) + '</td><td>' + fmt.money(a.op, u) + '</td>' +
        '<td>' + fmt.pct(a.opm) + '</td>' + (hasGpm ? '<td>' + fmt.pct(a.gpm) + '</td>' : '') +
        (hasNI ? '<td>' + (a.netIncome != null ? fmt.money(a.netIncome, u) : '–') + '</td>' : '') +
        (hasFcf ? '<td>' + (a.fcf != null ? fmt.money(a.fcf, u) : '–') + '</td>' : '') +
        '<td>' + (a.revYoY != null ? fmt.signedPct(a.revYoY) : '–') + '</td>' +
        '<td>' + (a.opYoY != null ? fmt.signedPct(a.opYoY) : '–') + '</td>' +
        (hasNI ? '<td>' + (a.niYoY != null ? fmt.signedPct(a.niYoY) : '–') + '</td>' : '') + '</tr>';
    }).join('');
    return '<div class="section"><h3>연간 요약</h3><div class="tbl-scroll"><table class="fin"><thead><tr>' +
      '<th>연도</th><th>매출액</th><th>영업이익</th><th>OPM</th>' + (hasGpm ? '<th>GPM</th>' : '') +
      (hasNI ? '<th>순이익</th>' : '') + (hasFcf ? '<th>FCF</th>' : '') +
      '<th>매출 YoY</th><th>영업이익 YoY</th>' + (hasNI ? '<th>순이익 YoY</th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  function quarterTableSection(c, t, u) {
    var q = t.q || [];
    if (!q.length) return '';
    var hasGpm = q.some(function (x) { return x.gpm != null; });
    var hasCF = q.some(function (x) { return x.ocf != null || x.fcf != null; });
    var rows = q.map(function (x) {
      return '<tr><td>' + esc(x.label) + '</td><td>' + fmt.money(x.revenue, u) + '</td><td>' + fmt.money(x.op, u) + '</td><td>' + fmt.pct(x.opm) + '</td>' +
        (hasGpm ? '<td>' + fmt.pct(x.gpm) + '</td><td>' + fmt.pct(x.sgaRatio) + '</td>' : '') +
        (hasCF ? '<td>' + (x.ocf != null ? fmt.money(x.ocf, u) : '–') + '</td><td>' + (x.fcf != null ? fmt.money(x.fcf, u) : '–') + '</td>' : '') +
        '</tr>';
    }).join('');
    var th = '<th>분기</th><th>매출액</th><th>영업이익</th><th>OPM</th>' +
      (hasGpm ? '<th>GPM</th><th>판관비율</th>' : '') + (hasCF ? '<th>OCF</th><th>FCF</th>' : '');
    return '<div class="section"><h3>분기 데이터 (' + esc(u) + ')</h3><div class="tbl-scroll"><table class="fin"><thead><tr>' +
      th + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  function buybackSection(c) {
    var bb = c.buybacks || [];
    if (!bb.length) return '';
    var total = bb.reduce(function (a, x) { return a + (x.amount || 0); }, 0);
    return '<div class="section"><h3>주주환원 — 자사주 매입 (' + esc(c.buybackUnit || '억원') + ')</h3>' +
      '<p class="hint">분기별 자사주 매입액. 누적 ' + Math.round(total).toLocaleString('ko-KR') + ' ' + esc(c.buybackUnit || '억원') + '. 주가 하방 지지·주주환원 의지 지표.</p>' +
      '<div class="chart-box" id="chart-buyback"></div></div>';
  }

  function commentarySection(c) {
    var items = c.commentary || [];
    if (!items.length) return '';
    var html = items.map(function (it) {
      return '<div class="commentary-item"><h4>' + esc(it.title) + '</h4><p>' + esc(it.body) + '</p></div>';
    }).join('');
    return '<div class="section"><h3>해설 — 리스크 헤지 관점</h3>' + html + '</div>';
  }

  function disclaimer() {
    return '<div class="disclaimer">※ 본 페이지는 DART 공시 기반 정량적 분석 자료이며, 특정 종목의 매수·매도 추천이 아닙니다. ' +
      '밸류에이션은 입력한 가정(목표 배수·역사적 밴드 등)에 따라 달라지며, 최종 수치는 반드시 원본 공시(dart.fss.or.kr)와 실시간 시세로 대조하십시오.</div>';
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function mk(b) { return b === true ? '✓' : (b === false ? '✗' : '?'); }
  function clamp(v) { return Math.max(0, Math.min(100, v)); }

  function route() {
    // 공유 저장소가 설정돼 있으면 최초 1회 로드 후 렌더
    if (window.Store && Store.enabled() && sharedCompanies === null) {
      Store.list()
        .then(function (obj) { sharedCompanies = obj; })
        .catch(function (e) { sharedCompanies = {}; sharedError = e.message || String(e); })
        .then(doRoute);
      return;
    }
    doRoute();
  }
  function doRoute() {
    var companies = loadCompanies();
    var hash = location.hash.replace(/^#\/?/, '');
    var target = null;
    if (hash) target = companies.filter(function (x) { return x.id === hash; })[0];
    if (target) renderDetail(target); else renderGallery(companies);
    // 실시간 시세 조회 후 1회 재렌더 (5분 내 캐시가 다 있으면 아무것도 안 함)
    fetchLivePrices(target ? [target] : companies).then(function (updated) {
      if (!updated) return;
      var y = window.scrollY;
      if (target) renderDetail(target); else renderGallery(loadCompanies());
      window.scrollTo(0, y);
    });
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('DOMContentLoaded', route);
})();
