/* =============================================================================
 * dartParser.js — DART 분기/반기 보고서 PDF 텍스트 → 재무 항목 추출 (순수 함수)
 *   연결 요약재무정보 + 연결 손익계산서 + 연결 현금흐름표를 파싱.
 *   반환값 금액은 보고서 원단위(백만원). 편집기에서 회사 단위로 환산.
 * =========================================================================== */
(function (global) {
  'use strict';

  function toNum(s) {
    if (s == null) return null;
    s = String(s).replace(/,/g, '').trim();
    var neg = /^△/.test(s) || (/^\(/.test(s) && /\)$/.test(s));
    s = s.replace(/△/g, '').replace(/[()]/g, '').trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    var v = parseFloat(s);
    return isFinite(v) ? (neg ? -v : v) : null;
  }

  // 라벨을 글자 사이 공백 허용 정규식으로 (pdf.js/pdfplumber 렌더 차이 흡수)
  function labelRe(label) {
    return label.replace(/\s+/g, '').split('').map(function (c) {
      return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('\\s*');
  }
  function findLabel(block, label, from) {
    var re = new RegExp(labelRe(label), 'g');
    if (from) re.lastIndex = from;
    var m = re.exec(block);
    return m ? { start: m.index, end: m.index + m[0].length } : null;
  }
  // 라벨의 '모든' 출현을 훑어, 라벨 뒤 span 안에서 숫자가 나오는 첫 지점을 반환.
  // (첫 출현이 소제목/서술문이라 숫자가 없어도 다음 출현에서 잡도록 → 누락 방지)
  function after(block, label, span) {
    var re = new RegExp(labelRe(label), 'g');
    var m;
    while ((m = re.exec(block))) {
      var seg = block.slice(m.index + m[0].length, m.index + m[0].length + (span || 60));
      var nm = seg.match(/△?\(?-?[\d,]{2,}\)?/);
      if (nm) { var v = toNum(nm[0]); if (v != null) return v; }
    }
    return null;
  }
  // 여러 라벨 후보를 순서대로 시도
  function afterAny(block, labels, span) {
    for (var i = 0; i < labels.length; i++) { var v = after(block, labels[i], span); if (v != null) return v; }
    return null;
  }
  // 재무상태표 항목용: 라벨 뒤 숫자 중 'floor 이상인 첫 값'을 선택.
  //   → 주석의 작은 값(예: 매출채권 0.01)은 건너뛰고, '부채와자본총계' 같은 과대 합계(본표보다 뒤)보다
  //     앞선 본표 현재열 값을 정확히 집는다. (floor = 매출액의 일정 비율)
  function afterFloor(block, labels, floor, span) {
    for (var i = 0; i < labels.length; i++) {
      var re = new RegExp(labelRe(labels[i]), 'g'), m;
      while ((m = re.exec(block))) {
        var seg = block.slice(m.index + m[0].length, m.index + m[0].length + (span || 60));
        var nm = seg.match(/△?\(?-?[\d,]{2,}\)?/);
        if (nm) { var v = toNum(nm[0]); if (v != null && Math.abs(v) >= (floor || 0)) return v; }
      }
    }
    return null;
  }
  function parseDartReport(rawText) {
    var res = { ok: false, warnings: [] };
    if (!rawText || rawText.length < 200) { res.error = 'PDF에서 텍스트를 읽지 못했습니다(스캔본일 수 있음).'; return res; }
    var txt = rawText.replace(/\(주[0-9,]+\)/g, ' ').replace(/[ \t]+/g, ' ');

    // 연결 우선. 요약연결재무정보가 없으면 별도라도 시도.
    var af = findLabel(txt, '요약연결재무정보');
    var connected = !!af;
    if (!af) af = findLabel(txt, '요약별도재무정보');
    var anchor = af ? af.start : 0;

    // 기간/분기 판별: 손익계산서(또는 표지)의 날짜 범위
    var period = detectPeriod(txt);
    if (!period) { res.error = '보고서 기간(제N기 N분기)을 찾지 못했습니다.'; return res; }
    res.year = period.year; res.quarter = period.quarter; res.endDate = period.endDate;
    res.fiscalNo = period.fiscalNo; res.connected = connected;
    res.cumulativeCF = period.quarter > 1; // 반기/3분기 현금흐름표는 누적(YTD)

    // pdf.js는 페이지 경계에서 텍스트 순서를 재배열하므로 '블록 슬라이싱'이 불안정.
    // 요약 이후 전체(body)에서 라벨+숫자 패턴을 직접 매칭한다.
    var body = txt.slice(anchor);

    // --- 표 단위 자동 감지 ---
    // 보고서 표마다 '(단위 : 원 | 천원 | 백만원 | 억원 | 십억원)' 표기가 제각각이라,
    // 표기 위치를 모두 수집해 두고 각 값이 매칭된 위치의 '직전 단위'로 백만원 기준 환산한다.
    var unitMarks = [];
    (function () {
      var re = /단\s*위\s*[::]\s*\(?\s*(십\s*억\s*원|백\s*만\s*원|천\s*원|억\s*원|원)/g, m;
      while ((m = re.exec(body))) {
        var u = m[1].replace(/\s+/g, '');
        var f = { '원': 1e-6, '천원': 1e-3, '백만원': 1, '억원': 100, '십억원': 1000 }[u];
        if (f != null) unitMarks.push({ pos: m.index, f: f });
      }
    })();
    if (!unitMarks.length) res.warnings.push('표 단위 표기를 찾지 못해 백만원으로 가정');
    function unitAt(pos) {
      var f = 1; // 표기가 없으면 백만원 가정
      for (var i = 0; i < unitMarks.length; i++) { if (unitMarks[i].pos < pos) f = unitMarks[i].f; else break; }
      return f;
    }

    // 손익계산서 행: 라벨 뒤 숫자 4개 = [당기3개월, 당기누적, 전기3개월, 전기누적]
    // 요약(숫자 3개)이 아닌 손익계산서(숫자 4개) 행을 정확히 집는다. (→백만원 환산)
    function incRow(label) {
      var n = '(△?\\(?-?[\\d,]{2,}\\)?)';
      var re = new RegExp(labelRe(label) + '\\s*' + n + '\\s+' + n + '\\s+' + n + '\\s+' + n);
      var m = re.exec(body);
      if (!m) return [];
      var f = unitAt(m.index);
      return [toNum(m[1]), toNum(m[2]), toNum(m[3]), toNum(m[4])].map(function (v) { return v == null ? null : v * f; });
    }
    // 연간(사업)보고서 행: 라벨 뒤 숫자 3개 = [당기, 전기, 전전기] (연간값, →백만원 환산)
    function annRow(label) {
      var n = '(△?\\(?-?[\\d,]{2,}\\)?)';
      var re = new RegExp(labelRe(label) + '\\s*' + n + '\\s+' + n + '\\s+' + n);
      var m = re.exec(body);
      if (!m) return [];
      var f = unitAt(m.index);
      return [toNum(m[1]), toNum(m[2]), toNum(m[3])].map(function (v) { return v == null ? null : v * f; });
    }
    // after/afterAny/afterFloor의 단위 환산판
    function afterU(label, span) {
      var re = new RegExp(labelRe(label), 'g'), m;
      while ((m = re.exec(body))) {
        var seg = body.slice(m.index + m[0].length, m.index + m[0].length + (span || 60));
        var nm = seg.match(/△?\(?-?[\d,]{2,}\)?/);
        if (nm) { var v = toNum(nm[0]); if (v != null) return v * unitAt(m.index); }
      }
      return null;
    }
    function afterAnyU(labels, span) {
      for (var i = 0; i < labels.length; i++) { var v = afterU(labels[i], span); if (v != null) return v; }
      return null;
    }
    function afterFloorU(labels, floor, span) { // floor는 백만원 기준
      for (var i = 0; i < labels.length; i++) {
        var re = new RegExp(labelRe(labels[i]), 'g'), m;
        while ((m = re.exec(body))) {
          var seg = body.slice(m.index + m[0].length, m.index + m[0].length + (span || 60));
          var nm = seg.match(/△?\(?-?[\d,]{2,}\)?/);
          if (nm) {
            var v = toNum(nm[0]);
            if (v != null) { var mv = v * unitAt(m.index); if (Math.abs(mv) >= (floor || 0)) return mv; }
          }
        }
      }
      return null;
    }

    var r = {};
    var rev = incRow('매출액'), cogs = incRow('매출원가'), sga = incRow('판매비와관리비'),
        op = incRow('영업이익'), ni = incRow('분기순이익');
    r.revenue = rev[0] != null ? rev[0] : afterU('매출액');   // 3개월(분기) 실적
    r.cogs = cogs[0] != null ? cogs[0] : null;
    r.sga = sga[0] != null ? sga[0] : null;
    r.op = op[0] != null ? op[0] : afterU('영업이익');
    r.netIncome = ni[0] != null ? ni[0] : (afterU('연결총당기순이익') || afterU('당기순이익'));
    r.eps = after(body, '기본주당순이익');   // 주당순이익은 원/주 단위 그대로 (환산 금지)

    // 재무상태표 항목 — 매출액의 0.5%를 하한(floor)으로, 주석의 작은 오탐값을 건너뛰고 본표값 채택.
    var bsFloor = Math.abs(r.revenue || 0) * 0.005;
    r.receivables = afterFloorU(['매출채권및기타채권', '매출채권'], bsFloor);
    r.inventory = afterFloorU(['재고자산'], bsFloor);
    r.equity = afterFloorU(['자본총계', '자본 총계'], bsFloor);

    // 현금흐름표(첫 출현) — OCF/CAPEX
    r.ocf = afterAnyU(['영업활동현금흐름', '영업활동으로 인한 현금흐름', '영업활동으로인한현금흐름']);
    var capexT = Math.abs(afterU('유형자산의 취득') || 0);
    var capexI = Math.abs(afterU('무형자산의 취득') || 0);
    r.capex = (capexT + capexI) || null;

    res.reported = r;

    // 발행주식총수(보통주) — '주' 단위(재무단위 환산 금지). 주식의 총수 표는 앵커 앞이라 전체(txt)에서 탐색.
    var sh = shareCount(txt);
    res.shares = sh.value; res.sharesLabel = sh.label;

    // 사업(연간)보고서: 손익·현금흐름 3개년 연간값 → Q4 = 연간 − (Q1+Q2+Q3) 산출용
    res.isAnnual = period.quarter === 4;
    if (res.isAnnual) {
      var aRev = annRow('매출액'), aCogs = annRow('매출원가'), aSga = annRow('판매비와관리비'),
          aOp = annRow('영업이익'), aNi = annRow('당기순이익'),
          aOcf = annRow('영업활동현금흐름'), aCapT = annRow('유형자산의 취득'), aCapI = annRow('무형자산의 취득');
      res.annual = [];
      for (var k = 0; k < 3; k++) {
        if (aRev[k] == null && aOp[k] == null) continue;
        var capex = (aCapT[k] != null || aCapI[k] != null) ? Math.abs(aCapT[k] || 0) + Math.abs(aCapI[k] || 0) : null;
        res.annual.push({
          year: period.year - k, revenue: aRev[k], cogs: aCogs[k], sga: aSga[k],
          op: aOp[k], netIncome: aNi[k], ocf: aOcf[k], capex: capex
        });
      }
      res.ok = true; return res; // 연간보고서는 res.annual 사용(편집기에서 Q4 계산)
    }

    // 전년 동기 손익 (col2 = 전기 3개월)
    if (period.year && (rev[2] != null || op[2] != null)) {
      res.prevYear = {
        year: period.year - 1, quarter: period.quarter,
        revenue: rev[2] != null ? rev[2] : null,
        cogs: cogs[2] != null ? cogs[2] : null,
        sga: sga[2] != null ? sga[2] : null,
        op: op[2] != null ? op[2] : null,
        netIncome: ni[2] != null ? ni[2] : null
      };
    }

    // 현금흐름은 반기/3분기에서 연초 누적(YTD) → 편집기가 직전 분기를 빼서 분기값으로 자동 보정.
    if (r.revenue == null && r.op == null) { res.error = '손익 항목을 찾지 못했습니다. 연결 손익계산서가 포함된 보고서인지 확인하세요.'; return res; }

    res.ok = true;
    return res;
  }

  // 발행주식총수(보통주) 추출. 라벨 뒤 '가까운 큰 숫자'를 요구해 서술문 오탐을 방지.
  //   (라벨과 숫자 사이 '(단위: 주)'·'(Ⅱ-Ⅲ)' 등은 숫자가 없어 자동으로 건너뜀)
  function shareAfter(block, label) {
    var re = new RegExp(labelRe(label) + '[^0-9]{0,20}([\\d,]{7,})', 'g');
    var m;
    while ((m = re.exec(block))) { var v = toNum(m[1]); if (v != null && v > 1e6) return v; }
    return null;
  }
  function shareCount(block) {
    var tries = [
      ['발행주식의 총수', '발행주식총수'],                 // 사업보고서 주식의 총수 표 (Ⅳ)
      ['소각주식 수를 제외한 발행주식수', '발행주식총수(소각 제외)'], // 분기보고서 자본금 주석
      ['가중평균유통보통주식수', '가중평균유통보통주식수'],
      ['기말 유통주식수', '기말 유통주식수']
    ];
    for (var i = 0; i < tries.length; i++) {
      var v = shareAfter(block, tries[i][0]);
      if (v != null) return { value: v, label: tries[i][1] };
    }
    return { value: null, label: null };
  }

  function detectPeriod(txt) {
    // "제 58 기 1분기 2026.01.01 부터 2026.03.31 까지" 또는 날짜범위
    var m = txt.match(/제\s*(\d+)\s*기[\s\S]{0,14}?(\d{4})\.(\d{2})\.\d{2}\s*부터\s*(\d{4})\.(\d{2})\.(\d{2})\s*까지/);
    if (!m) {
      // 표지형: "2026.01.01 부터 ... 2026.03.31 까지"
      m = txt.match(/(\d{4})\.(\d{2})\.\d{2}\s*부터[\s\S]{0,20}?(\d{4})\.(\d{2})\.(\d{2})\s*까지/);
      if (!m) return null;
      var endM2 = parseInt(m[4], 10);
      return { fiscalNo: null, year: parseInt(m[3], 10), quarter: Math.round(endM2 / 3), endDate: m[3] + '-' + m[4] + '-' + m[5] };
    }
    var endM = parseInt(m[5], 10);
    return { fiscalNo: parseInt(m[1], 10), year: parseInt(m[4], 10), quarter: Math.round(endM / 3), endDate: m[4] + '-' + m[5] + '-' + m[6] };
  }

  global.DartParser = { parseDartReport: parseDartReport, _toNum: toNum };
})(window);
