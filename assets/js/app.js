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
  // 뷰어가 선택한 프리셋을 반영한 회사 사본 (원본 data.js는 건드리지 않음)
  function effectiveCompany(c) {
    var key = viewerPresets()[c.id];
    if (!key) return c;
    var v2 = {}; Object.keys(c.valuation || {}).forEach(function (k) { v2[k] = c.valuation[k]; });
    if (key === 'default') delete v2.weights;
    else if (V.WEIGHT_PRESETS[key]) v2.weights = V.WEIGHT_PRESETS[key];
    var c2 = {}; Object.keys(c).forEach(function (k) { c2[k] = c[k]; });
    c2.valuation = v2;
    return c2;
  }
  function activePresetKey(c) {
    return viewerPresets()[c.id] || V.presetKeyOf((c.valuation || {}).weights);
  }

  function loadCompanies() {
    var base = (window.COMPANIES || []).slice();
    var overrides = {};
    try { overrides = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { overrides = {}; }
    var byId = {};
    base.forEach(function (c) { byId[c.id] = c; });
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
          '<div>' + signalEl(val.signal) + (val.isExample ? ' <span class="example-badge">예시값</span>' : '') + '</div>' +
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
    app.innerHTML =
      '<div class="gallery-head"><h2>분석 기업 ' + companies.length + '</h2>' +
      '<a class="btn primary sm" href="editor.html">＋ 기업 추가 / 편집</a></div>' +
      (companies.length ? '<div class="grid">' + cards + '</div>' : emptyState()) + disclaimer();
    Array.prototype.forEach.call(app.querySelectorAll('.card'), function (el) {
      el.addEventListener('click', function () { location.hash = '#/' + el.getAttribute('data-id'); });
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
    var val = V.computeValuation(effectiveCompany(company));
    var t = val.trends || {};

    app.innerHTML =
      '<a class="back-link" href="#">← 목록으로</a>' +
      detailHead(company, val) +
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
          metric('현재 주가', fmt.price(val.price)) +
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
  function clamp(v) { return Math.max(0, Math.min(100, v)); }

  function route() {
    var companies = loadCompanies();
    var hash = location.hash.replace(/^#\/?/, '');
    if (hash) {
      var c = companies.filter(function (x) { return x.id === hash; })[0];
      if (c) { renderDetail(c); return; }
    }
    renderGallery(companies);
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('DOMContentLoaded', route);
})();
