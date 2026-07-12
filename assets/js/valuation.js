/* =============================================================================
 * valuation.js — 순수 계산 함수 (기업 데이터 → 지표/밸류에이션/추세)
 *   확장: 마진(GPM/판관비율/OPM), 현금흐름(OCF/CAPEX/FCF),
 *         효율성(재고·매출채권 회전율), 역사적 멀티플 밴드(PER/PBR)
 * =========================================================================== */
(function (global) {
  'use strict';

  var UNIT_TO_WON = 1e12; // '조원' → '원' (Samsung 등 조원 단위 기업의 EPS 계산용)

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function yearOf(label) { var m = String(label || '').match(/(\d{2,4})/); return m ? m[1] : null; }

  /* 분기 라벨 정규화 → 연도 4자리 ('17.1q' → '2017', '2021 1Q' → '2021') */
  function fullYear(label) {
    var m = String(label || '').match(/(\d{4}|\d{2})/);
    if (!m) return null;
    var y = m[1];
    if (y.length === 2) y = (Number(y) >= 70 ? '19' : '20') + y;
    return y;
  }
  /* 분기 번호 추출 ('17.3q' → 3, '2021 2Q' → 2) */
  function quarterNo(label) {
    var m = String(label || '').match(/([1-4])\s*[qQ]/);
    return m ? Number(m[1]) : null;
  }

  /* 분기 배열 → 연간 집계 */
  function annualFromQuarters(quarters) {
    var byYear = {};
    (quarters || []).forEach(function (q) {
      var y = fullYear(q.label);
      if (!y) return;
      var r = byYear[y] || (byYear[y] = { year: y, revenue: 0, op: 0, cogs: 0, sga: 0, netIncome: 0,
        ocf: 0, capex: 0, hasNI: false, hasCOGS: false, hasCF: false, n: 0 });
      r.revenue += num(q.revenue) || 0;
      r.op += num(q.op) || 0;
      if (num(q.cogs) != null) { r.cogs += q.cogs; r.hasCOGS = true; }
      if (num(q.sga) != null) r.sga += q.sga;
      if (num(q.netIncome) != null) { r.netIncome += q.netIncome; r.hasNI = true; }
      if (num(q.ocf) != null) { r.ocf += q.ocf; r.hasCF = true; }
      if (num(q.capex) != null) { r.capex += q.capex; r.hasCF = true; }
      r.n++;
    });
    var out = Object.keys(byYear).sort().map(function (y) {
      var r = byYear[y];
      return {
        year: y, revenue: r.revenue, op: r.op, n: r.n,
        opm: r.revenue ? r.op / r.revenue : null,
        gpm: (r.hasCOGS && r.revenue) ? (r.revenue - r.cogs) / r.revenue : null,
        netIncome: r.hasNI ? r.netIncome : null,
        ocf: r.hasCF ? r.ocf : null, capex: r.hasCF ? r.capex : null,
        fcf: r.hasCF ? r.ocf - r.capex : null
      };
    });
    for (var i = 1; i < out.length; i++) {
      out[i].revYoY = out[i - 1].revenue ? out[i].revenue / out[i - 1].revenue - 1 : null;
      out[i].opYoY = out[i - 1].op ? out[i].op / out[i - 1].op - 1 : null;
      out[i].niYoY = (out[i - 1].netIncome != null && out[i - 1].netIncome > 0 && out[i].netIncome != null)
        ? out[i].netIncome / out[i - 1].netIncome - 1 : null;
    }
    return out;
  }

  /* 완전한 연도(4분기) 시계열에서 최근 3년 CAGR (양수 값만, 최소 2개 연도) */
  function cagrOf(rows, key) {
    var pts = rows.filter(function (r) { return r[key] != null && r[key] > 0; });
    if (pts.length < 2) return null;
    var take = pts.slice(-4); // 최근 최대 4개 연도 = 3년 성장
    var f = take[0], l = take[take.length - 1];
    var yrs = Number(l.year) - Number(f.year);
    if (yrs <= 0) return null;
    return Math.pow(l[key] / f[key], 1 / yrs) - 1;
  }

  /* 추세/파생 지표 */
  function computeTrends(company) {
    var q = company.quarters || [];
    var t = { annual: annualFromQuarters(q) };

    // 분기별 파생 시계열
    t.q = q.map(function (x) {
      var rev = num(x.revenue), op = num(x.op), cogs = num(x.cogs), sga = num(x.sga);
      var ocf = num(x.ocf), capex = num(x.capex), fcf = num(x.fcf);
      if (fcf == null && ocf != null && capex != null) fcf = ocf - capex;
      var gp = (rev != null && cogs != null) ? rev - cogs : null;
      return {
        label: x.label, revenue: rev, op: op, cogs: cogs, sga: sga,
        gp: gp,
        gpm: (gp != null && rev) ? gp / rev : null,
        sgaRatio: (sga != null && rev) ? sga / rev : null,
        opm: (op != null && rev) ? op / rev : null,
        ocf: ocf, capex: capex, fcf: fcf,
        inventory: num(x.inventory), receivables: num(x.receivables),
        invTurn: (cogs != null && num(x.inventory)) ? cogs / x.inventory : null,
        arTurn: (rev != null && num(x.receivables)) ? rev / x.receivables : null,
        netIncome: num(x.netIncome)
      };
    });

    var opm = t.q.map(function (x) { return x.opm; }).filter(function (v) { return v != null; });
    if (opm.length) {
      t.opmMin = Math.min.apply(null, opm); t.opmMax = Math.max.apply(null, opm);
      t.opmAvg = opm.reduce(function (a, b) { return a + b; }, 0) / opm.length;
      t.opmLast = opm[opm.length - 1];
    }

    var annual = t.annual;
    if (annual.length >= 2) {
      var f = annual[0], l = annual[annual.length - 1], yrs = Number(l.year) - Number(f.year);
      if (f.revenue > 0 && yrs > 0) t.revCAGR = Math.pow(l.revenue / f.revenue, 1 / yrs) - 1;
    }

    // 성장률 CAGR — 4분기가 모두 채워진 '완전한 연도'만 사용 (부분 연도로 인한 왜곡 방지)
    var fullYears = annual.filter(function (a) { return a.n === 4; });
    t.revCAGR3 = cagrOf(fullYears, 'revenue');
    t.opCAGR3 = cagrOf(fullYears, 'op');
    t.niCAGR3 = cagrOf(fullYears, 'netIncome');
    if (t.niCAGR3 != null) {
      var niPts = fullYears.filter(function (r) { return r.netIncome != null && r.netIncome > 0; }).slice(-4);
      t.niCAGRSpan = niPts[0].year + '→' + niPts[niPts.length - 1].year;
    }

    if (q.length >= 4) {
      var last4 = q.slice(-4);
      t.ttmRevenue = last4.reduce(function (a, x) { return a + (num(x.revenue) || 0); }, 0);
      t.ttmOp = last4.reduce(function (a, x) { return a + (num(x.op) || 0); }, 0);
      var niAll = last4.every(function (x) { return num(x.netIncome) != null; });
      t.ttmNetIncome = niAll ? last4.reduce(function (a, x) { return a + x.netIncome; }, 0) : null;
    }

    // TTM YoY: 최근 4분기 합 vs 직전 4분기 합
    if (q.length >= 8) {
      var prev4 = q.slice(-8, -4), cur4 = q.slice(-4);
      function sum4(arr, key) {
        var all = arr.every(function (x) { return num(x[key]) != null; });
        return all ? arr.reduce(function (a, x) { return a + x[key]; }, 0) : null;
      }
      var pr = sum4(prev4, 'revenue'), cr = sum4(cur4, 'revenue');
      if (pr != null && pr > 0 && cr != null) t.revYoYTTM = cr / pr - 1;
      var po = sum4(prev4, 'op'), co = sum4(cur4, 'op');
      if (po != null && po > 0 && co != null) t.opYoYTTM = co / po - 1;
      var pn = sum4(prev4, 'netIncome'), cn = sum4(cur4, 'netIncome');
      if (pn != null && pn > 0 && cn != null) t.niYoYTTM = cn / pn - 1;
    }

    // 계절성: 분기(1~4) × 연도 매트릭스
    t.seasonal = buildSeasonal(t.q);
    return t;
  }

  function buildSeasonal(qs) {
    var years = [], byQ = { 1: {}, 2: {}, 3: {}, 4: {} };
    qs.forEach(function (x) {
      var y = fullYear(x.label), qn = quarterNo(x.label);
      if (!y || !qn) return;
      if (years.indexOf(y) < 0) years.push(y);
      byQ[qn][y] = x.revenue;
    });
    years.sort();
    var has = years.length > 1 && qs.some(function (x) { return quarterNo(x.label); });
    return has ? { years: years, byQ: byQ } : null;
  }

  /* ---------- 역사적 멀티플 밴드 ---------- */
  function percentile(sorted, p) {
    if (!sorted.length) return null;
    var idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  function computeBand(history, key) {
    if (!history || !history.length) return null;
    var vals = [], last = null;
    history.forEach(function (h) { var v = num(h[key]); if (v != null && v > 0) { vals.push(v); last = v; } });
    if (vals.length < 3) return null;
    var s = vals.slice().sort(function (a, b) { return a - b; });
    return {
      n: s.length, min: s[0], max: s[s.length - 1],
      p25: percentile(s, 0.25), median: percentile(s, 0.5), p75: percentile(s, 0.75),
      last: last
    };
  }

  /* ---------- 앵커 가중 프리셋 (주식 성격별) ---------- */
  // default(미지정)=논문 T-12 근거 PBR 0.5·배당 0.3·PER 0.2 (computeValuation의 FAIR_W)
  var WEIGHT_PRESETS = {
    growth: { per: 0.5, pbr: 0.2, div: 0.3 },    // 안정 성장형: 이익이 꾸준히 우상향 → 이익 앵커 중심
    cyclical: { per: 0.1, pbr: 0.6, div: 0.3 }   // 경기민감·자산형: 사이클 고점의 낮은 PER은 착시 → PBR 중심
  };
  var PRESET_LABELS = {
    default: '기본 (논문 가중: PBR 0.5·배당 0.3·PER 0.2)',
    growth: '안정 성장형 — PER 중심 (PER 0.5·배당 0.3·PBR 0.2)',
    cyclical: '경기민감·자산형 — PBR 중심 (PBR 0.6·배당 0.3·PER 0.1)'
  };
  function presetKeyOf(w) {
    if (!w) return 'default';
    for (var k in WEIGHT_PRESETS) {
      var p = WEIGHT_PRESETS[k];
      if (p.per === w.per && p.pbr === w.pbr && p.div === w.div) return k;
    }
    return 'default';
  }

  /* ---------- 멀티플 밸류에이션 ---------- */
  function computeValuation(company) {
    var v = company.valuation || {};
    var trends = computeTrends(company);
    var r = { ok: false, inputs: v, isExample: !!v.isExample, trends: trends };

    // 역사적 밴드
    r.histPer = computeBand(company.valuationHistory, 'per');
    r.histPbr = computeBand(company.valuationHistory, 'pbr');

    var price = num(v.price), shares = num(v.shares);
    var ni = num(v.netIncomeTTM); if (ni == null && trends.ttmNetIncome != null) ni = trends.ttmNetIncome;
    var eq = num(v.equity);
    r.price = price; r.shares = shares; r.netIncomeTTM = ni; r.equity = eq;

    if (shares != null && price != null) r.marketCap = price * shares;
    r.eps = (ni != null && shares) ? (ni * UNIT_TO_WON) / shares : null;
    r.bps = (eq != null && shares) ? (eq * UNIT_TO_WON) / shares : null;

    // 현재 PER/PBR
    if (price != null) {
      if (ni != null && ni > 0 && r.marketCap != null) r.per = r.marketCap / (ni * UNIT_TO_WON);
      else if (r.eps) r.per = price / r.eps;
      if (eq != null && eq > 0 && r.marketCap != null) r.pbr = r.marketCap / (eq * UNIT_TO_WON);
      else if (r.bps) r.pbr = price / r.bps;
    }
    // 현재 PER을 못 구하면 역사적 최신값으로 대체(위치 판단용)
    if (r.per == null && r.histPer && r.histPer.last != null) { r.per = r.histPer.last; r.perFromHistory = true; }
    if (r.pbr == null && r.histPbr && r.histPbr.last != null) { r.pbr = r.histPbr.last; r.pbrFromHistory = true; }

    // 밴드: 수동 입력 > 역사적
    var manualPer = v.perBand || {}, manualPbr = v.pbrBand || {};
    r.perBand = bandFor(manualPer, r.histPer);
    r.pbrBand = bandFor(manualPbr, r.histPbr);

    // 목표 배수: 명시 > 수동평균 > 역사적 중앙값
    var targetPer = num(v.targetPer); if (targetPer == null) targetPer = num(manualPer.avg);
    if (targetPer == null && r.histPer) targetPer = r.histPer.median;
    var targetPbr = num(v.targetPbr); if (targetPbr == null) targetPbr = num(manualPbr.avg);
    if (targetPbr == null && r.histPbr) targetPbr = r.histPbr.median;
    r.targetPer = targetPer; r.targetPbr = targetPbr;

    // 배당 앵커: 주당배당금(DPS, 원) ÷ 목표 배당수익률(%)
    var dps = num(v.dps);
    var targetDivYield = num(v.targetDivYield);
    if (dps != null && price != null && price > 0) r.divYield = dps / price;

    // 적정주가(원 단위) — 세 앵커의 '가중' 평균 (12개월 관점)
    // 가중치 근거(사용자 논문, KOSPI top30 T-12 종목별 표본외 R² 중앙값):
    //   PBR +10.8%(강건) > 배당수익률 +2.1%(약한 양) > 이익수익률 −3.4%(실패)
    //   → PBR 0.5 · 배당 0.3 · PER 0.2, 없는 앵커는 가중치 재배분.
    var FAIR_W = { pbr: 0.5, div: 0.3, per: 0.2 };
    // 기업별 가중 오버라이드 (valuation.weights) — 이익 안정 성장형은 PER 비중↑,
    // 경기민감·자산형(사이클 고점의 낮은 PER은 착시)은 PBR 비중↑ 식으로 조정.
    var vw = v.weights || {};
    var W = (num(vw.per) != null || num(vw.pbr) != null || num(vw.div) != null)
      ? { per: num(vw.per) || 0, pbr: num(vw.pbr) || 0, div: num(vw.div) || 0 }
      : FAIR_W;
    var anchors = [];
    if (r.eps != null && targetPer != null) { r.fairByPer = r.eps * targetPer; anchors.push({ key: 'per', v: r.fairByPer, w: W.per }); }
    if (r.bps != null && targetPbr != null) { r.fairByPbr = r.bps * targetPbr; anchors.push({ key: 'pbr', v: r.fairByPbr, w: W.pbr }); }
    if (dps != null && targetDivYield != null && targetDivYield > 0) {
      r.fairByDiv = dps / (targetDivYield / 100);
      anchors.push({ key: 'div', v: r.fairByDiv, w: W.div });
    }
    anchors = anchors.filter(function (a) { return a.w > 0; });
    var fairs = anchors.map(function (a) { return a.v; });
    if (anchors.length && price != null) {
      var wSum = anchors.reduce(function (s, a) { return s + a.w; }, 0);
      r.fairLow = Math.min.apply(null, fairs); r.fairHigh = Math.max.apply(null, fairs);
      r.fairAvg = anchors.reduce(function (s, a) { return s + a.v * (a.w / wSum); }, 0);
      r.fairWeights = anchors.map(function (a) {
        return ({ per: 'PER', pbr: 'PBR', div: '배당' })[a.key] + ' ' + Math.round(a.w / wSum * 100) + '%';
      }).join(' · ');
      r.upside = r.fairAvg / price - 1;
    }

    // ROE = 순이익(TTM) ÷ 자본총계
    if (ni != null && eq != null && eq > 0) r.roe = ni / eq;

    // EPS 성장률 (PEG용) — 발행주식수가 크게 안 변한다는 가정에서 순이익 성장률로 근사.
    // 우선순위: ① 사용자가 입력한 예상 성장률(%) ② 연간 순이익 CAGR(완전 연도, 최근 3년) ③ TTM YoY
    var g = num(v.epsGrowth);
    if (g != null) { r.epsGrowth = g / 100; r.epsGrowthSrc = 'manual'; }
    else if (trends.niCAGR3 != null) { r.epsGrowth = trends.niCAGR3; r.epsGrowthSrc = 'cagr'; }
    else if (trends.niYoYTTM != null) { r.epsGrowth = trends.niYoYTTM; r.epsGrowthSrc = 'ttm'; }

    // PEG = PER ÷ EPS 성장률(%) — 1 미만이면 성장 대비 저평가 신호
    if (r.per != null && r.per > 0 && r.epsGrowth != null && r.epsGrowth > 0)
      r.peg = r.per / (r.epsGrowth * 100);

    // 밴드 내 현재 위치 (0=하단, 1=상단)
    if (r.per != null && r.perBand) {
      var b = r.perBand;
      if (b.high > b.low) r.perBandPos = (r.per - b.low) / (b.high - b.low);
    }
    if (r.pbr != null && r.pbrBand) {
      var b2 = r.pbrBand;
      if (b2.high > b2.low) r.pbrBandPos = (r.pbr - b2.low) / (b2.high - b2.low);
    }

    r.signal = judge(r);
    r.ok = fairs.length > 0 || r.per != null || r.pbr != null;
    return r;
  }

  function bandFor(manual, hist) {
    // 역사적 시계열이 있으면 우선(백분위 p25/p75까지 활용) → 시그널이 더 견고.
    if (hist) return { low: hist.min, avg: hist.median, high: hist.max, p25: hist.p25, p75: hist.p75, source: 'history' };
    if (num(manual.low) != null && num(manual.high) != null)
      return { low: manual.low, avg: num(manual.avg), high: manual.high, source: 'manual' };
    return null;
  }

  /* 배수의 자기 역사 밴드 내 위치 → 투표 (하위 25% 이하 저평가, 상위 25% 이상 고평가) */
  function bandVote(x, band, pos) {
    if (x == null || !band) return null;
    if (band.p25 != null && band.p75 != null) return x <= band.p25 ? 1 : (x >= band.p75 ? -1 : 0);
    if (pos != null) return pos <= 0.33 ? 1 : (pos >= 0.67 ? -1 : 0);
    return null;
  }

  // 가중 투표. PBR 밴드 위치의 가중치를 2배로 — 사용자 논문(KOSPI top30, T-12)에서
  // '자기 역사 대비 PBR'이 가장 강건한 12개월 선행신호였음(표본외 R² 중앙값 +10.8%).
  function judge(r) {
    var votes = []; // {v: -1|0|1, w: 가중치}
    if (r.upside != null) votes.push({ v: r.upside >= 0.15 ? 1 : (r.upside <= -0.15 ? -1 : 0), w: 1 });
    var pv = bandVote(r.per, r.perBand, r.perBandPos);
    if (pv != null) votes.push({ v: pv, w: 1 });
    var bv = bandVote(r.pbr, r.pbrBand, r.pbrBandPos);
    if (bv != null) votes.push({ v: bv, w: 2 });
    if (!votes.length) return { key: 'na', label: '판단 불가', desc: '밸류에이션 입력 필요' };
    var wSum = votes.reduce(function (a, x) { return a + x.w; }, 0);
    var s = votes.reduce(function (a, x) { return a + x.v * x.w; }, 0) / wSum;
    if (s >= 0.34) return { key: 'under', label: '저평가', desc: '기업가치 대비 주가가 낮은 구간 (12개월 관점)' };
    if (s <= -0.34) return { key: 'over', label: '고평가', desc: '기업가치 대비 주가가 높은 구간 (12개월 관점)' };
    return { key: 'fair', label: '적정', desc: '기업가치와 주가가 대체로 부합' };
  }

  /* ---------- 포맷 ---------- */
  function unitShort(unit) {
    if (!unit || unit === '조원') return '조';
    if (unit === '억원') return '억';
    if (unit === '백만원') return '백만';
    if (unit === '천원') return '천';
    return '';
  }
  var fmt = {
    // 재무 금액: 단위(unit)에 맞춰 표시. 조원은 소수1자리, 그 외는 천단위 콤마.
    money: function (x, unit) {
      if (x == null || !isFinite(x)) return '–';
      if (!unit || unit === '조원') return x.toFixed(1) + '조';
      return Math.round(x).toLocaleString('ko-KR') + ' ' + unitShort(unit);
    },
    won: function (x) {
      if (x == null || !isFinite(x)) return '–';
      if (Math.abs(x) >= 1e12) return (x / 1e12).toFixed(1) + '조';
      if (Math.abs(x) >= 1e8) return (x / 1e8).toFixed(1) + '억';
      return Math.round(x).toLocaleString('ko-KR') + '원';
    },
    price: function (x) { return x == null ? '–' : Math.round(x).toLocaleString('ko-KR') + '원'; },
    x: function (x, d) { return x == null ? '–' : x.toFixed(d == null ? 1 : d) + '배'; },
    pct: function (x, d) { return x == null ? '–' : (x * 100).toFixed(d == null ? 1 : d) + '%'; },
    signedPct: function (x, d) { if (x == null) return '–'; return (x > 0 ? '+' : '') + (x * 100).toFixed(d == null ? 1 : d) + '%'; }
  };

  global.Valuation = {
    annualFromQuarters: annualFromQuarters, computeTrends: computeTrends,
    computeValuation: computeValuation, computeBand: computeBand,
    WEIGHT_PRESETS: WEIGHT_PRESETS, PRESET_LABELS: PRESET_LABELS, presetKeyOf: presetKeyOf,
    fmt: fmt, yearOf: yearOf, fullYear: fullYear, quarterNo: quarterNo, unitShort: unitShort
  };
})(window);
