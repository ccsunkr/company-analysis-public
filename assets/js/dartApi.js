/* =============================================================================
 * dartApi.js — OpenDART API 클라이언트 (편집기 전용)
 * -----------------------------------------------------------------------------
 * OpenDART(opendart.fss.or.kr)는 CORS를 허용하지 않으므로 반드시 서버리스 프록시
 * (serverless/naver-proxy.worker.js, ?dartPath=… 지원)를 경유합니다.
 *
 * 흐름:
 *  1) corpCode.xml(zip) 1회 다운로드 → 종목코드→고유번호 맵 (localStorage 30일 캐시)
 *  2) fnlttSinglAcnt(단일회사 주요계정)를 연도×보고서(1분기·반기·3분기·사업)로 조회
 *     → 누적(YTD) 손익을 분기값으로 차감 변환 (Q4 = 연간 − 3분기 누적)
 *     → 매출액·영업이익·당기순이익(분기), 자본총계(최신 보고서 기말)
 *  3) stockTotqySttus(주식총수)에서 보통주 발행주식총수
 *
 * 미제공(→ PDF 업로드/수기): 매출원가·판관비·OCF·CAPEX·재고자산·매출채권.
 * 주의: 12월 결산 법인 기준의 분기 계산입니다(대부분의 상장사).
 * =========================================================================== */
(function (global) {
  'use strict';

  var LS_CORP = 'companyAnalysis.dartCorpMap';
  var CORP_TTL = 1000 * 60 * 60 * 24 * 30; // 30일

  // 보고서 코드: 1분기·반기·3분기·사업(연간)
  var REPRT = [
    { code: '11013', q: 1, nm: '1분기' },
    { code: '11012', q: 2, nm: '반기' },
    { code: '11014', q: 3, nm: '3분기' },
    { code: '11011', q: 4, nm: '사업(연간)' }
  ];

  function num(s) {
    if (s == null || s === '' || s === '-') return null;
    var n = Number(String(s).replace(/,/g, '').trim());
    return isFinite(n) ? n : null;
  }

  function proxyUrl(base, params) {
    var u = String(base || '').trim().replace(/\/+$/, '');
    var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return u + (u.indexOf('?') > -1 ? '&' : '?') + qs;
  }

  function fetchWithTimeout(url, ms, label) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { ctrl && ctrl.abort(); }, ms || 15000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .catch(function (e) {
        if (e && (e.name === 'AbortError' || /abort/i.test(e.message || '')))
          throw new Error((label || '요청') + ' 응답 대기 시간 초과(' + Math.round((ms || 15000) / 1000) + '초). ' +
            '프록시→OpenDART 연결이 느리거나 차단된 상태일 수 있습니다. OpenDART는 해외 IP(Cloudflare 등)를 차단하기도 합니다 — ' +
            '로컬 프록시(python serverless/dart-local-proxy.py 실행 후 프록시 URL에 http://127.0.0.1:8321)를 사용해 보세요.');
        throw e;
      })
      .finally(function () { clearTimeout(t); });
  }

  function apiJson(cfg, path, params, retried) {
    var p = { dartPath: path, crtfc_key: cfg.key };
    Object.keys(params || {}).forEach(function (k) { p[k] = params[k]; });
    return fetchWithTimeout(proxyUrl(cfg.proxy, p), 30000, path).then(function (r) {
      if (!r.ok) return proxyErr(r, path);
      return r.json();
    }).catch(function (e) {
      if (!retried && /시간 초과/.test(e.message || '')) return apiJson(cfg, path, params, true); // 1회 재시도
      throw e;
    });
  }

  // 프록시 오류 응답 → 원인별 안내. 구버전 워커(dartPath 미지원)는 'code 파라미터 필요' 400을 돌려줌.
  function proxyErr(r, label) {
    return r.text().then(function (t) {
      var m = (t.match(/"error"\s*:\s*"([^"]+)"/) || [])[1] || '';
      if (r.status === 400 && /종목코드|code/.test(m))
        throw new Error('프록시 워커가 구버전입니다(OpenDART 중계 미지원). Cloudflare 대시보드에서 워커 코드를 최신 serverless/naver-proxy.worker.js 내용으로 교체하고 Deploy 하세요.');
      throw new Error(label + ' HTTP ' + r.status + (m ? ' — ' + m : ''));
    });
  }

  // OpenDART 오류 코드 → 사용자 메시지
  function dartError(j) {
    var msgs = {
      '010': '등록되지 않은 인증키입니다. OpenDART API 키를 확인하세요.',
      '011': '사용할 수 없는 인증키입니다(폐기/중지).',
      '020': '요청 제한(일 사용량)을 초과했습니다. 내일 다시 시도하세요.',
      '100': '요청 파라미터 오류입니다.',
      '800': 'OpenDART 시스템 점검 중입니다.'
    };
    return new Error(msgs[j.status] || ('OpenDART 오류(' + j.status + '): ' + (j.message || '')));
  }

  /* ==========================================================================
   * 1) 고유번호(corp_code) — corpCode.xml zip 다운로드 + 브라우저 내 압축 해제
   * ========================================================================== */
  function getCorpMap(cfg, onStatus) {
    try {
      var cached = JSON.parse(localStorage.getItem(LS_CORP) || 'null');
      if (cached && cached.ts && (Date.now() - cached.ts) < CORP_TTL && cached.map) return Promise.resolve(cached.map);
    } catch (e) {}
    // 공유 저장소(워커 KV)에 다른 사람이 올려둔 고유번호 맵이 있으면 그걸 사용 (zip 다운로드 생략)
    var viaStore = (global.Store && global.Store.enabled())
      ? global.Store.corpmapGet().then(function (m) {
          if (m && typeof m === 'object' && Object.keys(m).length > 100) return m;
          return null;
        }).catch(function () { return null; })
      : Promise.resolve(null);
    return viaStore.then(function (m) {
      if (m) {
        try { localStorage.setItem(LS_CORP, JSON.stringify({ ts: Date.now(), map: m })); } catch (e) {}
        onStatus('고유번호 목록: 공유 저장소 캐시 사용');
        return m;
      }
      return downloadCorpMap(cfg, onStatus);
    });
  }

  function downloadCorpMap(cfg, onStatus) {
    onStatus('DART 고유번호 목록 다운로드 중… (최초 1회 · OpenDART가 느리면 수 분 소요 — 로컬 프록시 터미널에 진행률 표시. 시간 초과되어도 프록시에 캐시되므로 다시 클릭하면 즉시 이어집니다)');
    return fetchWithTimeout(proxyUrl(cfg.proxy, { dartPath: 'corpCode', crtfc_key: cfg.key }), 300000, '고유번호 목록(corpCode)')
      .then(function (r) {
        if (!r.ok) return proxyErr(r, 'corpCode');
        return r.arrayBuffer();
      })
      .then(function (buf) {
        var head = new Uint8Array(buf.slice(0, 2));
        if (!(head[0] === 0x50 && head[1] === 0x4b)) { // 'PK'가 아니면 오류 응답(XML/JSON)
          var txt = new TextDecoder('utf-8').decode(buf.slice(0, 600));
          var m = txt.match(/<message>([^<]+)<\/message>/) || txt.match(/"message"\s*:\s*"([^"]+)"/) || txt.match(/"error"\s*:\s*"([^"]+)"/);
          throw new Error(m ? m[1] : ('corpCode 응답이 ZIP이 아닙니다: ' + txt.slice(0, 120)));
        }
        onStatus('고유번호 목록 압축 해제·파싱 중…');
        return unzipFirst(buf);
      })
      .then(function (xml) {
        var map = {}, re = /<list>([\s\S]*?)<\/list>/g, m;
        while ((m = re.exec(xml))) {
          var chunk = m[1];
          var stock = (chunk.match(/<stock_code>\s*(\d{6})\s*<\/stock_code>/) || [])[1];
          if (!stock) continue; // 비상장 제외
          var code = (chunk.match(/<corp_code>\s*(\d+)\s*<\/corp_code>/) || [])[1];
          var name = (chunk.match(/<corp_name>\s*([^<]*?)\s*<\/corp_name>/) || [])[1];
          if (code) map[stock] = { c: code, n: name || '' };
        }
        if (!Object.keys(map).length) throw new Error('corpCode XML에서 상장기업을 찾지 못했습니다.');
        try { localStorage.setItem(LS_CORP, JSON.stringify({ ts: Date.now(), map: map })); } catch (e) {}
        // 공유 저장소에 업로드 — 친구들은 zip 다운로드 없이 즉시 사용 (실패해도 무시)
        if (global.Store && global.Store.enabled()) global.Store.corpmapPut(map).catch(function () {});
        return map;
      });
  }

  // ZIP 내 첫 파일을 UTF-8 텍스트로 해제 (corpCode.xml 단일 파일 전제)
  function unzipFirst(buf) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf);
    var min = Math.max(0, buf.byteLength - 22 - 65535), i = buf.byteLength - 22;
    for (; i >= min; i--) if (dv.getUint32(i, true) === 0x06054b50) break; // EOCD
    if (i < min) throw new Error('ZIP 형식 오류(EOCD 없음)');
    var cdOff = dv.getUint32(i + 16, true);
    if (dv.getUint32(cdOff, true) !== 0x02014b50) throw new Error('ZIP 중앙 디렉터리 오류');
    var method = dv.getUint16(cdOff + 10, true);
    var csize = dv.getUint32(cdOff + 20, true);
    var lhOff = dv.getUint32(cdOff + 42, true);
    if (dv.getUint32(lhOff, true) !== 0x04034b50) throw new Error('ZIP 로컬 헤더 오류');
    var nameLen = dv.getUint16(lhOff + 26, true), extraLen = dv.getUint16(lhOff + 28, true);
    var dataOff = lhOff + 30 + nameLen + extraLen;
    var comp = u8.subarray(dataOff, dataOff + csize);
    if (method === 0) return Promise.resolve(new TextDecoder('utf-8').decode(comp));
    if (method !== 8) throw new Error('지원하지 않는 ZIP 압축방식: ' + method);
    if (typeof DecompressionStream === 'undefined')
      throw new Error('이 브라우저는 압축 해제를 지원하지 않습니다. 최신 Chrome/Edge/Safari를 사용하세요.');
    var stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  /* ==========================================================================
   * 2) 재무제표 — fnlttSinglAcnt (연도×보고서 순차 조회)
   * ========================================================================== */
  function fetchFinancials(cfg, corpCode, years, onStatus) {
    var now = new Date(), curY = now.getFullYear(), startY = curY - years + 1;
    var jobs = [];
    for (var y = startY; y <= curY; y++) {
      REPRT.forEach(function (rp) {
        var qEnd = new Date(y, rp.q * 3, 0); // 해당 분기 말일
        if (qEnd > now) return;              // 아직 끝나지 않은 분기는 건너뜀
        jobs.push({ y: y, rp: rp });
      });
    }
    var out = [], seq = Promise.resolve();
    jobs.forEach(function (job, idx) {
      seq = seq.then(function () {
        onStatus('재무제표 조회 ' + (idx + 1) + '/' + jobs.length + ' — ' + job.y + '년 ' + job.rp.nm + ' 보고서…');
        return apiJson(cfg, 'fnlttSinglAcnt', { corp_code: corpCode, bsns_year: String(job.y), reprt_code: job.rp.code })
          .then(function (j) {
            if (j.status === '000' && j.list && j.list.length) out.push({ y: job.y, q: job.rp.q, list: j.list });
            else if (j.status !== '013' && j.status !== '000') throw dartError(j); // 013 = 데이터 없음(미제출) → skip
          });
      });
    });
    return seq.then(function () { return out; });
  }

  /* 조회 결과 → 분기별 {revenue, op, netIncome}(원) + 자본총계(최신) */
  function extractQuarters(results, statement) {
    var ACC = {
      revenue: /^(매출액|수익\(매출액\)|영업수익)$/,
      op: /^영업이익(\(손실\))?$/,
      netIncome: /^당기순이익(\(손실\))?$/
    };
    var wantFs = statement === '별도' ? 'OFS' : 'CFS';
    var cum = {};       // 연도 → 계정 → {분기: 누적값}
    var quarters = {};  // 'y-q' → {y, q, revenue, op, netIncome}
    var equity = null, equityAt = -1, debt = null, debtAt = -1, fsUsed = null, latest = null;

    results.sort(function (a, b) { return (a.y * 10 + a.q) - (b.y * 10 + b.q); });

    results.forEach(function (res) {
      var rows = res.list.filter(function (r) { return r.fs_div === wantFs; });
      var fs = wantFs;
      if (!rows.length) { rows = res.list.filter(function (r) { return r.fs_div === 'OFS'; }); fs = 'OFS'; }
      if (!rows.length) return;
      fsUsed = fsUsed || fs;
      var at = res.y * 10 + res.q;
      if (!latest || at > latest.y * 10 + latest.q) latest = { y: res.y, q: res.q };

      rows.forEach(function (r) {
        var nm = String(r.account_nm || '').replace(/\s+/g, '');
        // 자본총계·부채총계 (재무상태표, 기말 잔액) — 가장 최근 보고서 값 사용
        if (nm === '자본총계' && (!r.sj_div || r.sj_div === 'BS')) {
          var ev = num(r.thstrm_amount);
          if (ev != null && at > equityAt) { equity = ev; equityAt = at; }
          return;
        }
        if (nm === '부채총계' && (!r.sj_div || r.sj_div === 'BS')) {
          var dv = num(r.thstrm_amount);
          if (dv != null && at > debtAt) { debt = dv; debtAt = at; }
          return;
        }
        Object.keys(ACC).forEach(function (key) {
          if (!ACC[key].test(nm)) return;
          if (r.sj_div && r.sj_div !== 'IS' && r.sj_div !== 'CIS') return;
          var add = num(r.thstrm_add_amount);   // 누적(제공 시)
          var amt = num(r.thstrm_amount);
          // thstrm_dt 시작일이 1월이면 누적, 아니면 해당 분기 3개월 값
          var startsJan = /(\d{4})\s*[.\-\/]\s*0?1\s*[.\-\/]\s*0?1/.test(String(r.thstrm_dt || '').split('~')[0]);
          var cumVal = null, isoVal = null;
          if (add != null) { cumVal = add; if (amt != null && amt !== add) isoVal = amt; }
          else if (amt != null) {
            if (res.q === 1 || res.q === 4 || startsJan) cumVal = amt; // Q1=3개월=누적, 사업보고서=연간 누적
            else isoVal = amt;
          }
          var yc = cum[res.y] || (cum[res.y] = {});
          var kc = yc[key] || (yc[key] = {});
          if (cumVal != null) kc[res.q] = cumVal;
          else if (isoVal != null) { // 누적 미제공 시 직전 누적 + 3개월로 복원
            if (res.q === 1) kc[1] = isoVal;
            else if (kc[res.q - 1] != null) kc[res.q] = kc[res.q - 1] + isoVal;
          }
          var qv = null;
          if (isoVal != null && res.q !== 4) qv = isoVal;
          else if (cumVal != null) {
            if (res.q === 1) qv = cumVal;
            else if (kc[res.q - 1] != null) qv = cumVal - kc[res.q - 1];
          }
          if (qv != null) {
            var qk = res.y + '-' + res.q;
            (quarters[qk] = quarters[qk] || { y: res.y, q: res.q })[key] = qv;
          }
        });
      });
    });

    var list = Object.keys(quarters).map(function (k) { return quarters[k]; })
      .sort(function (a, b) { return (a.y * 10 + a.q) - (b.y * 10 + b.q); });
    return { quarters: list, equity: equity, debt: debt, fsUsed: fsUsed, latest: latest };
  }

  /* ==========================================================================
   * 3) 발행주식총수 — stockTotqySttus (최신 보고서부터 역순 시도)
   * ========================================================================== */
  function fetchShares(cfg, corpCode, results, onStatus) {
    var byQ = { 1: '11013', 2: '11012', 3: '11014', 4: '11011' };
    var tries = results.slice()
      .sort(function (a, b) { return (b.y * 10 + b.q) - (a.y * 10 + a.q); })
      .slice(0, 3)
      .map(function (r) { return { y: r.y, code: byQ[r.q] }; });
    function tryOne(i) {
      if (i >= tries.length) return Promise.resolve(null);
      var t = tries[i];
      onStatus('발행주식총수 조회 중…');
      return apiJson(cfg, 'stockTotqySttus', { corp_code: corpCode, bsns_year: String(t.y), reprt_code: t.code })
        .then(function (j) {
          if (j.status !== '000' || !j.list || !j.list.length) return tryOne(i + 1);
          var row = j.list.filter(function (r) { return /보통주/.test(r.se || ''); })[0] ||
                    j.list.filter(function (r) { return /합계/.test(r.se || ''); })[0];
          var v = row ? (num(row.istc_totqy) || num(row.distb_stock_co)) : null;
          return v != null ? v : tryOne(i + 1);
        })
        .catch(function () { return tryOne(i + 1); });
    }
    return tryOne(0);
  }

  /* ==========================================================================
   * 4) 배당 — alotMatter (사업보고서 '배당에 관한 사항': 주당 현금배당금·배당수익률 3개년)
   * ========================================================================== */
  function fetchDividends(cfg, corpCode, results, onStatus) {
    var annuals = results.filter(function (r) { return r.q === 4; }).map(function (r) { return r.y; })
      .sort(function (a, b) { return b - a; });
    var tries = annuals.slice(0, 2);
    if (!tries.length && results.length)
      tries = [Math.max.apply(null, results.map(function (r) { return r.y; })) - 1];
    function tryOne(i) {
      if (i >= tries.length) return Promise.resolve(null);
      onStatus('배당 정보 조회 중… (' + tries[i] + '년 사업보고서)');
      return apiJson(cfg, 'alotMatter', { corp_code: corpCode, bsns_year: String(tries[i]), reprt_code: '11011' })
        .then(function (j) {
          if (j.status !== '000' || !j.list || !j.list.length) return tryOne(i + 1);
          return parseDividend(j.list, tries[i]) || tryOne(i + 1);
        })
        .catch(function () { return tryOne(i + 1); });
    }
    return tryOne(0);
  }

  function parseDividend(list, year) {
    // se 예: '주당 현금배당금(원)', '현금배당수익률(%)' — 보통주 행 우선. thstrm/frmtrm/lwfr = 당기/전기/전전기.
    function pick(rePat) {
      var rows = list.filter(function (r) { return rePat.test(String(r.se || '').replace(/\s+/g, '')); });
      var row = rows.filter(function (r) { return /보통주/.test(r.stock_knd || ''); })[0] || rows[0];
      return row ? [num(row.thstrm), num(row.frmtrm), num(row.lwfr)] : null;
    }
    var dps = pick(/^주당현금배당금/);
    if (!dps || dps[0] == null || dps[0] <= 0) return null; // 최근 연도 무배당이면 앵커 무의미
    var yld = pick(/^현금배당수익률/) || [];
    var yields = yld.filter(function (x) { return x != null && x > 0; });
    var avgYield = yields.length ? yields.reduce(function (a, b) { return a + b; }, 0) / yields.length : null;
    return { dps: dps[0], year: year, avgYield: avgYield, nYields: yields.length };
  }

  /* ==========================================================================
   * 진입점 — cfg: { key, proxy, ticker, years, statement, onStatus }
   * 반환: { corpCode, corpName, quarters:[{y,q,revenue,op,netIncome}](원 단위),
   *         equity(원), shares(주), fsUsed:'CFS'|'OFS', latest:{y,q},
   *         dividend:{dps(원/주), year, avgYield(%, 최대3개년 평균), nYields}|null }
   * ========================================================================== */
  function fetchAll(cfg) {
    var onStatus = cfg.onStatus || function () {};
    return getCorpMap(cfg, onStatus).then(function (map) {
      var ent = map[cfg.ticker];
      if (!ent) throw new Error('종목코드 ' + cfg.ticker + '에 해당하는 DART 상장기업을 찾지 못했습니다.');
      return fetchFinancials(cfg, ent.c, cfg.years || 5, onStatus).then(function (results) {
        if (!results.length) throw new Error('조회된 재무제표가 없습니다. (조회 기간·인증키 확인)');
        var fin = extractQuarters(results, cfg.statement);
        if (!fin.quarters.length) throw new Error('손익 계정(매출액·영업이익)을 찾지 못했습니다.');
        return fetchShares(cfg, ent.c, results, onStatus).then(function (shares) {
          return fetchDividends(cfg, ent.c, results, onStatus).then(function (dividend) {
            return {
              corpCode: ent.c, corpName: ent.n,
              quarters: fin.quarters, equity: fin.equity, debt: fin.debt,
              shares: shares, fsUsed: fin.fsUsed, latest: fin.latest,
              dividend: dividend
            };
          });
        });
      });
    });
  }

  function clearCorpCache() { try { localStorage.removeItem(LS_CORP); } catch (e) {} }

  global.DartApi = { fetchAll: fetchAll, clearCorpCache: clearCorpCache };
})(window);
