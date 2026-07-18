/* =============================================================================
 * macro.js — 거시 매도 트리거 (AI 자금 사슬) 자동 평가
 * -----------------------------------------------------------------------------
 * 책의 매도 트리거 5단계를 AI 자금 사슬 상류→하류로 좁혀 stockanalysis.com
 * 실적으로 자동 판정한다(모든 종목에 공통 영향 → 별도 거시 카드).
 *   ①② 빅테크 FCF·Capex = 하이퍼스케일러 MSFT·GOOGL·AMZN·META
 *   ③ OEM/ODM = TSM (대만 파운드리/조립 대리)
 *   ④⑤ AI 대장주 매출·OPM = NVDA
 * 데이터: 프록시(워커/로컬)의 ?sa=TICKER (분기, 최신순). 6시간 캐시.
 * 판정은 클라이언트에서(규칙 조정이 쉽도록). 수동 오버라이드 가능.
 * =========================================================================== */
(function (global) {
  'use strict';

  var MACRO = {
    hyperscalers: ['MSFT', 'GOOGL', 'AMZN', 'META'], // 현금흐름(FCF·Capex)
    oem: 'TSM',                                       // 손익(매출)
    leader: 'NVDA'                                     // 손익(매출·OPM)
  };
  var CACHE_LS = 'companyAnalysis.macroData';
  var OVR_LS = 'companyAnalysis.macroOverride';
  var TTL = 6 * 60 * 60 * 1000;

  function today() { return new Date().toISOString().slice(0, 10); }

  // 실적만(날짜<=오늘) 최신순으로 정렬된 값 배열
  function actuals(series) {
    if (!series || !series.dates) return [];
    var out = [], t = today();
    for (var i = 0; i < series.dates.length; i++) {
      var d = series.dates[i];
      if (d && d <= t && series.__vals[i] != null) out.push(series.__vals[i]);
    }
    return out;
  }
  function pick(series, key, abs) {
    if (!series) return null;
    series.__vals = (series[key] || []).map(function (v) { return v == null ? null : (abs ? Math.abs(v) : v); });
    return actuals(series);
  }
  function ttm(vals) { // {now, prev} = 최근4Q, 직전4Q 합
    if (!vals || vals.length < 8) return null;
    var now = vals[0] + vals[1] + vals[2] + vals[3];
    var prev = vals[4] + vals[5] + vals[6] + vals[7];
    return prev ? { now: now, prev: prev, yoy: now / prev - 1 } : null;
  }
  function pctTxt(x) { return x == null ? '–' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }

  /* ---------- 데이터 로드 (6h 캐시) ---------- */
  function cached() {
    try { var c = JSON.parse(localStorage.getItem(CACHE_LS) || 'null'); if (c && c.ts && (Date.now() - c.ts) < TTL) return c.data; } catch (e) {}
    return null;
  }
  var lastErr = '';
  function fetchOne(base, ticker, parts) {
    return fetch(base.replace(/\/+$/, '') + (base.indexOf('?') > -1 ? '&' : '?') + 'sa=' + ticker + '&parts=' + parts)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && !j.error && (j.income || j.cashflow)) return j;
        // 구버전 워커는 ?sa= 를 모르고 네이버용 오류를 돌려준다 → 정확히 안내
        if (j && j.error) lastErr = /종목코드|code\)/.test(j.error)
          ? 'OLD_WORKER' : j.error;
        else lastErr = '응답 형식 오류';
        return null;
      })
      .catch(function (e) { lastErr = e.message || String(e); return null; });
  }
  function refresh(base, onStatus) {
    if (!base) return Promise.reject(new Error('프록시(공유 서버) URL이 필요합니다.'));
    onStatus && onStatus('거시 지표 수집 중… (stockanalysis.com)');
    lastErr = '';
    var jobs = MACRO.hyperscalers.map(function (t) { return fetchOne(base, t, 'cashflow'); })
      .concat([fetchOne(base, MACRO.oem, 'income'), fetchOne(base, MACRO.leader, 'income')]);
    return Promise.all(jobs).then(function (arr) {
      var map = {};
      arr.forEach(function (j) { if (j) map[j.ticker] = j; });
      if (!Object.keys(map).length) {
        throw new Error(lastErr === 'OLD_WORKER'
          ? '프록시 워커가 구버전입니다(?sa= 미지원). Cloudflare 대시보드 → 워커 → Edit code → serverless/naver-proxy.worker.js 최신본 붙여넣기 → Deploy 하세요.'
          : ('데이터를 가져오지 못했습니다' + (lastErr ? ' — ' + lastErr : '')));
      }
      try { localStorage.setItem(CACHE_LS, JSON.stringify({ ts: Date.now(), data: map })); } catch (e) {}
      return map;
    });
  }
  function load(base, onStatus) {
    var c = cached();
    if (c) return Promise.resolve(c);
    return refresh(base, onStatus);
  }

  /* ---------- 5대 트리거 자동 판정 ---------- */
  function overrides() { try { return JSON.parse(localStorage.getItem(OVR_LS) || '{}'); } catch (e) { return {}; } }
  function setOverride(i, v) { var o = overrides(); if (v == null) delete o['t' + i]; else o['t' + i] = v; try { localStorage.setItem(OVR_LS, JSON.stringify(o)); } catch (e) {} }

  function evaluate(map) {
    map = map || {};
    var ov = overrides();
    function hsAgg(key, abs) { // 하이퍼스케일러 4곳 TTM 합산 YoY
      var now = 0, prev = 0, n = 0;
      MACRO.hyperscalers.forEach(function (tk) {
        var s = map[tk] && map[tk].cashflow ? ttm(pick(map[tk].cashflow, key, abs)) : null;
        if (s) { now += s.now; prev += s.prev; n++; }
      });
      return n >= 2 && prev ? { yoy: now / prev - 1, n: n } : null;
    }
    var fcf = hsAgg('fcf', false);
    var capex = hsAgg('capex', true);
    var ocf = hsAgg('ocf', false);
    // ① 판정: 책 문구는 'FCF 둔화'지만, FCF는 Capex가 급증하면 기계적으로 줄어든다.
    //   (그건 돈줄이 마른 게 아니라 오히려 상류 호황) → 돈줄 자체인 OCF로 판정하고,
    //   FCF 감소가 '투자 축소와 동반될 때'만 진짜 둔화로 본다.
    var fcfOn = null, fcfDetail = '데이터 부족';
    if (ocf || fcf) {
      var oy = ocf ? ocf.yoy : null, fy = fcf ? fcf.yoy : null, cy = capex ? capex.yoy : null;
      fcfOn = (oy != null && oy < 0) || (fy != null && fy < 0 && cy != null && cy < 0);
      fcfDetail = '합산 OCF TTM YoY ' + pctTxt(oy) + ' · FCF ' + pctTxt(fy);
      if (fy != null && fy < 0 && oy != null && oy > 0 && cy != null && cy > 0)
        fcfDetail += ' — FCF 감소는 Capex 확대 탓(돈줄은 견조, 상류 호황)';
    }
    var tsm = map[MACRO.oem] && map[MACRO.oem].income ? ttm(pick(map[MACRO.oem].income, 'revenue', false)) : null;
    // NVDA 매출 QoQ (순차 감소 = 정점 신호)
    var nvRev = map[MACRO.leader] && map[MACRO.leader].income ? actualsOf(map[MACRO.leader].income, 'revenue') : [];
    var nvRevQoQ = (nvRev.length >= 2 && nvRev[1]) ? nvRev[0] / nvRev[1] - 1 : null;
    var nvOpm = map[MACRO.leader] && map[MACRO.leader].income ? actualsOf(map[MACRO.leader].income, 'operatingMargin') : [];
    var nvOpmD = (nvOpm.length >= 2) ? nvOpm[0] - nvOpm[1] : null;

    var defs = [
      { no: '①', label: '빅테크 현금창출력(FCF/OCF) 둔화', who: 'MSFT·GOOGL·AMZN·META', zone: '상류',
        auto: fcfOn, detail: fcfDetail },
      { no: '②', label: 'Capex 하향', who: 'MSFT·GOOGL·AMZN·META', zone: '상류',
        auto: capex ? capex.yoy < 0 : null, detail: capex ? '합산 Capex TTM YoY ' + pctTxt(capex.yoy) : '데이터 부족' },
      { no: '③', label: 'OEM/ODM·파운드리 둔화', who: 'TSM', zone: '중류',
        auto: tsm ? tsm.yoy < 0 : null, detail: tsm ? 'TSM 매출 TTM YoY ' + pctTxt(tsm.yoy) : '데이터 부족' },
      { no: '④', label: 'NVDA 매출 미스(순차 감소)', who: 'NVDA', zone: '하류',
        auto: nvRevQoQ != null ? nvRevQoQ < 0 : null, detail: nvRevQoQ != null ? 'NVDA 매출 QoQ ' + pctTxt(nvRevQoQ) : '데이터 부족' },
      { no: '⑤', label: 'NVDA 마진(OPM) 둔화', who: 'NVDA', zone: '하류',
        auto: nvOpmD != null ? nvOpmD < 0 : null, detail: nvOpmD != null ? 'NVDA OPM 전분기比 ' + (nvOpmD >= 0 ? '+' : '') + (nvOpmD * 100).toFixed(1) + 'pp' : '데이터 부족' }
    ];
    defs.forEach(function (d, i) {
      d.override = ov['t' + i]; // true/false/undefined
      d.on = d.override != null ? d.override : (d.auto === true);
    });
    var count = defs.filter(function (d) { return d.on; }).length;
    var upstream = defs[0].on || defs[1].on;
    return { triggers: defs, count: count, upstream: upstream };
  }
  function actualsOf(series, key) { series.__vals = (series[key] || []).map(function (v) { return v; }); return actuals(series); }

  global.Macro = {
    load: load, refresh: refresh, evaluate: evaluate,
    setOverride: setOverride, cachedAt: function () { try { return (JSON.parse(localStorage.getItem(CACHE_LS) || '{}')).ts || 0; } catch (e) { return 0; } },
    clearCache: function () { try { localStorage.removeItem(CACHE_LS); } catch (e) {} },
    config: MACRO
  };
})(window);
