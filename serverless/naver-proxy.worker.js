/* =============================================================================
 * naver-proxy.worker.js — Cloudflare Worker (네이버 시세 + OpenDART 프록시)
 * -----------------------------------------------------------------------------
 * 정적 사이트(기업분석 대시보드)에서 네이버 금융 시세와 OpenDART API를
 * CORS 없이 받기 위한 서버리스 프록시.
 * 브라우저→워커(같은 CORS 허용)→네이버/OpenDART(서버-서버, CORS 무관).
 *
 * [네이버 시세]
 * 요청:  GET https://<your-worker>.workers.dev/?code=005930
 * 응답:  { "code":"005930", "name":"삼성전자", "price":80000, "shares":5969782550,
 *          "marketValue": 477582604000000, "source":"naver" }
 *
 * [OpenDART] — dartPath 파라미터로 opendart.fss.or.kr/api/<dartPath> 를 그대로 중계
 * 요청:  GET ?dartPath=fnlttSinglAcnt&crtfc_key=…&corp_code=…&bsns_year=2024&reprt_code=11011
 *        GET ?dartPath=corpCode&crtfc_key=…   ← 고유번호 zip (바이너리 그대로 반환)
 * 키:    crtfc_key를 매 요청에 넘기거나, 워커 환경변수 DART_KEY 로 설정해 생략 가능.
 *        (Cloudflare 대시보드 → Worker → Settings → Variables → DART_KEY)
 *
 * 배포: serverless/README.md 참고 (Cloudflare 대시보드 붙여넣기 또는 wrangler).
 * =========================================================================== */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=60'
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}

function toNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/[^\d.-]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// 한글 단위 금액 파싱: '1,809조 4,232억' → 1809e12 + 4232e8 (원)
function parseKMoney(v) {
  if (v == null) return null;
  const s = String(v);
  let won = 0, matched = false;
  const jo = s.match(/([\d,]+)\s*조/); if (jo) { won += Number(jo[1].replace(/,/g, '')) * 1e12; matched = true; }
  const eok = s.match(/([\d,]+)\s*억/); if (eok) { won += Number(eok[1].replace(/,/g, '')) * 1e8; matched = true; }
  const man = s.match(/([\d,]+)\s*만/); if (man) { won += Number(man[1].replace(/,/g, '')) * 1e4; matched = true; }
  if (matched) return won;
  return toNum(s);
}

async function naver(path) {
  const r = await fetch('https://m.stock.naver.com/api/stock/' + path, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://m.stock.naver.com/' }
  });
  if (!r.ok) throw new Error('naver ' + path + ' HTTP ' + r.status);
  return r.json();
}

// totalInfos 배열 → { code: value } 맵
function byCodeMap(intg) {
  const map = {};
  const arr = (intg && (intg.totalInfos || intg.stockItemTotalInfos)) || [];
  for (const it of arr) if (it && it.code != null) map[it.code] = it.value;
  return map;
}

// 과거 PER/PBR 시계열 (finance/annual + finance/quarter → 병합)
function extractPerPbr(d, isQuarter) {
  const fi = d && d.financeInfo;
  if (!fi) return [];
  const rows = {};
  (fi.rowList || []).forEach(r => { if (r.title === 'PER' || r.title === 'PBR') rows[r.title] = r.columns || {}; });
  const out = [];
  (fi.trTitleList || []).forEach(t => {
    if (t.isConsensus === 'Y') return;                 // 컨센서스(추정) 제외
    const key = String(t.key || '');                   // '202503'
    const per = toNum(rows.PER && rows.PER[key] && rows.PER[key].value);
    const pbr = toNum(rows.PBR && rows.PBR[key] && rows.PBR[key].value);
    if (per == null && pbr == null) return;
    const year = +key.slice(0, 4), month = +key.slice(4, 6);
    out.push({ year, month, isQuarter, per, pbr });
  });
  return out;
}

async function history(code) {
  const [aR, qR] = await Promise.allSettled([naver(code + '/finance/annual'), naver(code + '/finance/quarter')]);
  const a = aR.status === 'fulfilled' ? aR.value : null;
  const q = qR.status === 'fulfilled' ? qR.value : null;
  const qs = extractPerPbr(q, true), as = extractPerPbr(a, false);
  const qYears = new Set(qs.map(x => x.year));
  const merged = [];
  // 분기 데이터가 없는 과거 연도만 연간 PER로 보강
  as.filter(x => !qYears.has(x.year)).forEach(x => merged.push({ label: String(x.year), per: x.per, pbr: x.pbr, sort: x.year * 10 + 4 }));
  qs.forEach(x => { const qn = Math.round(x.month / 3) || 4; merged.push({ label: String(x.year).slice(2) + '.' + qn + 'q', per: x.per, pbr: x.pbr, sort: x.year * 10 + qn }); });
  merged.sort((u, v) => u.sort - v.sort);
  return merged.map(x => ({ label: x.label, per: x.per, pbr: x.pbr }));
}

/* ---------- 공유 저장소 (KV) ----------
 * 여러 사람이 분석한 기업을 공유. 설정(대시보드 → Worker → Settings):
 *   1) Bindings → KV Namespace → 변수명 STORE, 네임스페이스 새로 생성(예: company-store)
 *   2) Variables → STORE_KEY = 팀 공유 비밀번호 (친구들에게만 알려줌)
 * 요청: ?store=list | save | delete | corpmap  (&key=비밀번호, save/delete/corpmap 쓰기는 POST)
 */
async function handleStore(request, url, env) {
  const kv = env && env.STORE;
  if (!kv) return json({ error: '공유 저장소 미설정 — 워커에 KV 바인딩(STORE)을 추가하세요 (serverless/README.md).' }, 501);
  if (!env.STORE_KEY) return json({ error: '공유 비밀번호 미설정 — 워커 환경변수 STORE_KEY를 추가하세요.' }, 501);
  const given = (url.searchParams.get('key') || '').trim();
  if (given !== env.STORE_KEY) return json({ error: '공유 비밀번호가 틀립니다.' }, 403);

  const action = url.searchParams.get('store');

  if (action === 'list') {
    const raw = await kv.get('companies');
    return json({ companies: raw ? JSON.parse(raw) : {} });
  }
  if (action === 'corpmap') {
    if (request.method === 'POST') {
      const body = await request.text();
      if (body.length > 3e6) return json({ error: 'corpmap이 너무 큽니다.' }, 413);
      JSON.parse(body); // 유효성 검사
      await kv.put('corpmap', body);
      return json({ ok: true });
    }
    const raw = await kv.get('corpmap');
    if (!raw) return json({ error: 'corpmap 없음' }, 404);
    return new Response(raw, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
  }
  if (action === 'save' && request.method === 'POST') {
    const c = await request.json();
    if (!c || typeof c.id !== 'string' || !/^[a-z0-9_-]+$/.test(c.id)) return json({ error: '올바른 기업 id가 필요합니다.' }, 400);
    const raw = await kv.get('companies');
    const all = raw ? JSON.parse(raw) : {};
    c.__savedAt = new Date().toISOString().slice(0, 10);
    all[c.id] = c;
    const out = JSON.stringify(all);
    if (out.length > 20e6) return json({ error: '저장소 용량 초과' }, 413);
    await kv.put('companies', out);
    return json({ ok: true, count: Object.keys(all).length });
  }
  if (action === 'delete' && request.method === 'POST') {
    const b = await request.json();
    if (!b || !b.id) return json({ error: 'id가 필요합니다.' }, 400);
    const raw = await kv.get('companies');
    const all = raw ? JSON.parse(raw) : {};
    delete all[b.id];
    await kv.put('companies', JSON.stringify(all));
    return json({ ok: true, count: Object.keys(all).length });
  }
  return json({ error: '알 수 없는 store 동작: ' + action }, 400);
}

/* ---------- OpenDART 중계 ---------- */
const DART_PATHS = new Set(['corpCode', 'fnlttSinglAcnt', 'fnlttSinglAcntAll', 'stockTotqySttus', 'alotMatter', 'company']);

async function handleDart(url, env) {
  const path = url.searchParams.get('dartPath');
  if (!DART_PATHS.has(path)) return json({ error: '허용되지 않은 dartPath: ' + path }, 400);
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (k !== 'dartPath') params.set(k, v);
  if (!params.get('crtfc_key') && env && env.DART_KEY) params.set('crtfc_key', env.DART_KEY);
  if (!params.get('crtfc_key')) return json({ error: 'OpenDART 인증키(crtfc_key)가 필요합니다.' }, 400);

  const ext = path === 'corpCode' ? '.xml' : '.json';
  const target = 'https://opendart.fss.or.kr/api/' + path + ext + '?' + params.toString();
  const r = await fetch(target, { headers: { 'User-Agent': UA } });

  if (path === 'corpCode') {
    // 고유번호 목록은 zip 바이너리 → 그대로 통과 (브라우저에서 해제)
    const buf = await r.arrayBuffer();
    return new Response(buf, {
      status: r.status,
      headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/zip', ...CORS, 'Cache-Control': 'public, max-age=86400' }
    });
  }
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}

async function handle(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const url = new URL(request.url);

  // 공유 저장소 요청
  if (url.searchParams.get('store')) {
    try { return await handleStore(request, url, env); }
    catch (e) { return json({ error: String(e && e.message || e) }, 502); }
  }

  // OpenDART 중계 요청
  if (url.searchParams.get('dartPath')) {
    try { return await handleDart(url, env); }
    catch (e) { return json({ error: String(e && e.message || e) }, 502); }
  }

  const code = (url.searchParams.get('code') || '').trim();
  if (!/^\d{6}$/.test(code)) return json({ error: '종목코드 6자리(code) 파라미터가 필요합니다.' }, 400);

  // 과거 PER/PBR 밴드용 시계열 요청
  if (url.searchParams.get('hist') === '1') {
    try {
      const h = await history(code);
      if (!h.length) return json({ error: '과거 PER/PBR을 찾지 못했습니다.', code }, 502);
      return json({ code, history: h, source: 'naver' });
    } catch (e) { return json({ error: String(e && e.message || e), code }, 502); }
  }

  try {
    // basic: 현재가(closePrice). integration: 시가총액·PER·PBR·EPS·BPS.
    const [basicR, intgR] = await Promise.allSettled([
      naver(code + '/basic'),
      naver(code + '/integration')
    ]);
    const basic = basicR.status === 'fulfilled' ? basicR.value : null;
    const intg = intgR.status === 'fulfilled' ? intgR.value : null;
    if (!intg && !basic) throw new Error('네이버 응답 없음');

    let price = toNum(basic && basic.closePrice);
    if (price == null) price = toNum(intg && intg.closePrice);

    const m = byCodeMap(intg);
    const marketValue = parseKMoney(m.marketValue);      // 시가총액(원)
    const per = toNum(m.per), pbr = toNum(m.pbr), eps = toNum(m.eps), bps = toNum(m.bps);

    // 네이버는 상장주식수를 직접 주지 않음 → 시가총액 ÷ 현재가 로 추정
    let shares = (marketValue != null && price) ? Math.round(marketValue / price) : null;

    const name = (basic && basic.stockName) || (intg && intg.stockName) || null;
    if (price == null && marketValue == null) return json({ error: '가격/시가총액 파싱 실패', code }, 502);

    return json({ code, name, price, shares, marketValue, per, pbr, eps, bps, source: 'naver' });
  } catch (e) {
    return json({ error: String(e && e.message || e), code }, 502);
  }
}

export default { fetch: handle };

// (구형 Service Worker 문법 호환)
if (typeof addEventListener === 'function') {
  addEventListener('fetch', (event) => { event.respondWith(handle(event.request)); });
}
