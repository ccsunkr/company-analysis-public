#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dart-local-proxy.py — 로컬 프록시 + 편집기 서버 (Cloudflare Worker 대체)
-----------------------------------------------------------------------------
OpenDART(금융감독원)는 해외/데이터센터 IP(Cloudflare 워커 포함)를 차단하는
경우가 있습니다. 이 스크립트를 내 PC(한국 IP)에서 실행하면 OpenDART·네이버를
직접 중계하고, **기업분석 사이트(편집기 포함)도 같은 주소에서 서빙**합니다.
같은 주소에서 페이지와 API가 나가므로 CORS·브라우저 보안정책 문제가 없습니다.

사용법:
  python dart-local-proxy.py          # http://127.0.0.1:8321
  python dart-local-proxy.py 9000    # 포트 지정

그다음 브라우저에서  http://127.0.0.1:8321/editor.html  을 여세요.
(editor.html을 파일로 직접(file://) 열면 브라우저가 127.0.0.1 요청을 막을 수
있으니, 반드시 위 주소로 여는 것을 권장합니다. 프록시 URL은 자동 설정됩니다.)

지원 (Cloudflare 워커와 동일한 쿼리):
  GET /?dartPath=fnlttSinglAcnt&crtfc_key=…&corp_code=…&bsns_year=…&reprt_code=…
  GET /?dartPath=corpCode&crtfc_key=…        ← 고유번호 zip 바이너리 그대로
  GET /?code=005930                           ← 네이버 현재가·시가총액·주식수(추정)
  GET /?code=005930&hist=1                    ← 네이버 과거 PER/PBR 시계열
  GET /?ping=1                                ← 프록시 확인용 (편집기 자동감지)
  GET /editor.html, /index.html, /assets/…    ← 정적 사이트 서빙
"""
import json
import mimetypes
import os
import re
import sys
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Windows 콘솔(cp949)이 못 그리는 문자가 있어도 print가 죽지 않도록 (오류 시 ?로 대체)
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(errors='replace')
    except Exception:
        pass

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/125 Safari/537.36')
DART_PATHS = {'corpCode', 'fnlttSinglAcnt', 'fnlttSinglAcntAll', 'stockTotqySttus', 'alotMatter', 'company'}
CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
}
# 정적 사이트 루트 = 이 스크립트의 상위 폴더 (company_analysis/)
SITE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 고유번호(corpCode) zip 디스크 캐시 — OpenDART가 매우 느리게 내려주는 경우가 있어
# 한 번 받으면 30일간 재사용. (첫 다운로드가 브라우저 대기시간을 넘겨 실패해도
# 캐시는 남으므로 다시 클릭하면 즉시 성공)
CORP_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'corpCode.cache.zip')
CORP_CACHE_TTL = 30 * 24 * 3600  # 30일


def download_corpcode(target):
    """corpCode zip 다운로드(진행률 표시) → 디스크 캐시 → bytes 반환"""
    import time
    if os.path.isfile(CORP_CACHE) and (time.time() - os.path.getmtime(CORP_CACHE)) < CORP_CACHE_TTL \
            and os.path.getsize(CORP_CACHE) > 100000:
        with open(CORP_CACHE, 'rb') as f:
            body = f.read()
        print(f'[proxy] corpCode 디스크 캐시 사용 ({len(body):,} bytes)', flush=True)
        return 200, 'application/zip', body
    print('[proxy] OpenDART corpCode 다운로드 시작 (느리면 수 분 걸릴 수 있습니다)', flush=True)
    req = urllib.request.Request(target, headers={'User-Agent': UA})
    chunks, total, last_mark = [], 0, 0
    with urllib.request.urlopen(req, timeout=120) as r:
        status, ctype = r.status, r.headers.get('Content-Type', '')
        while True:
            b = r.read(65536)
            if not b:
                break
            chunks.append(b)
            total += len(b)
            if total - last_mark >= 512 * 1024:
                last_mark = total
                print(f'[proxy]   … {total // 1024:,} KB 수신', flush=True)
    body = b''.join(chunks)
    print(f'[proxy] corpCode 다운로드 완료 ({total:,} bytes)', flush=True)
    if body[:2] == b'PK':  # 정상 zip일 때만 캐시 (인증키 오류 XML은 캐시 금지)
        try:
            with open(CORP_CACHE, 'wb') as f:
                f.write(body)
            print(f'[proxy] corpCode 캐시 저장 → {CORP_CACHE} (30일 재사용)', flush=True)
        except OSError as e:
            print(f'[proxy] 캐시 저장 실패(무시): {e}', flush=True)
    return status, ctype or 'application/zip', body


def http_get(url, timeout=90, headers=None):
    h = {'User-Agent': UA}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.headers.get('Content-Type', ''), r.read()


# ---------- 네이버 (워커의 quote/history와 동일 로직) ----------

def naver_json(path):
    _, _, body = http_get('https://m.stock.naver.com/api/stock/' + path, timeout=15,
                          headers={'Accept': 'application/json', 'Referer': 'https://m.stock.naver.com/'})
    return json.loads(body)


def to_num(v):
    if v is None:
        return None
    s = re.sub(r'[^\d.\-]', '', str(v))
    if not s:
        return None
    try:
        n = float(s)
        return n if n == n else None
    except ValueError:
        return None


def parse_kmoney(v):
    """'1,809조 4,232억' → 원 단위 정수"""
    if v is None:
        return None
    s = str(v)
    won, matched = 0, False
    for unit, mul in (('조', 10**12), ('억', 10**8), ('만', 10**4)):
        m = re.search(r'([\d,]+)\s*' + unit, s)
        if m:
            won += int(m.group(1).replace(',', '')) * mul
            matched = True
    return won if matched else to_num(s)


def by_code_map(intg):
    out = {}
    for it in (intg or {}).get('totalInfos') or (intg or {}).get('stockItemTotalInfos') or []:
        if it and it.get('code') is not None:
            out[it['code']] = it.get('value')
    return out


def extract_per_pbr(d, is_quarter):
    fi = (d or {}).get('financeInfo')
    if not fi:
        return []
    rows = {}
    for r in fi.get('rowList') or []:
        if r.get('title') in ('PER', 'PBR'):
            rows[r['title']] = r.get('columns') or {}
    out = []
    for t in fi.get('trTitleList') or []:
        if t.get('isConsensus') == 'Y':
            continue
        key = str(t.get('key') or '')
        per = to_num(((rows.get('PER') or {}).get(key) or {}).get('value'))
        pbr = to_num(((rows.get('PBR') or {}).get(key) or {}).get('value'))
        if per is None and pbr is None:
            continue
        out.append({'year': int(key[:4]), 'month': int(key[4:6]), 'isQuarter': is_quarter,
                    'per': per, 'pbr': pbr})
    return out


def naver_history(code):
    def safe(path):
        try:
            return naver_json(path)
        except Exception:
            return None
    qs = extract_per_pbr(safe(code + '/finance/quarter'), True)
    as_ = extract_per_pbr(safe(code + '/finance/annual'), False)
    q_years = {x['year'] for x in qs}
    merged = []
    for x in as_:
        if x['year'] not in q_years:
            merged.append({'label': str(x['year']), 'per': x['per'], 'pbr': x['pbr'],
                           'sort': x['year'] * 10 + 4})
    for x in qs:
        qn = round(x['month'] / 3) or 4
        merged.append({'label': str(x['year'])[2:] + '.' + str(qn) + 'q',
                       'per': x['per'], 'pbr': x['pbr'], 'sort': x['year'] * 10 + qn})
    merged.sort(key=lambda x: x['sort'])
    return [{'label': x['label'], 'per': x['per'], 'pbr': x['pbr']} for x in merged]


def naver_forward(annual):
    """컨센서스(추정) 연간 → 포워드 EPS/PER/순이익(억원). 커버리지 없으면 None."""
    fi = (annual or {}).get('financeInfo')
    if not fi:
        return None
    cons = [t for t in (fi.get('trTitleList') or []) if t.get('isConsensus') == 'Y']
    if not cons:
        return None
    key = str(cons[0].get('key') or '')
    rows = {r.get('title'): (r.get('columns') or {}) for r in (fi.get('rowList') or [])}
    def val(title):
        c = rows.get(title, {}).get(key)
        return to_num(c.get('value')) if isinstance(c, dict) else None
    eps, per, ni = val('EPS'), val('PER'), val('당기순이익')
    if eps is None and per is None and ni is None:
        return None
    return {'fyear': key[:4], 'eps': eps, 'per': per, 'bps': val('BPS'), 'pbr': val('PBR'), 'netIncomeEok': ni}


def naver_quote(code):
    def safe(path):
        try:
            return naver_json(path)
        except Exception:
            return None
    basic = safe(code + '/basic')
    intg = safe(code + '/integration')
    forward = naver_forward(safe(code + '/finance/annual'))
    if not basic and not intg:
        raise RuntimeError('네이버 응답 없음')
    price = to_num((basic or {}).get('closePrice'))
    if price is None:
        price = to_num((intg or {}).get('closePrice'))
    m = by_code_map(intg)
    market_value = parse_kmoney(m.get('marketValue'))
    shares = round(market_value / price) if (market_value and price) else None
    name = (basic or {}).get('stockName') or (intg or {}).get('stockName')
    if price is None and market_value is None:
        raise RuntimeError('가격/시가총액 파싱 실패')
    return {'code': code, 'name': name, 'price': price, 'shares': shares,
            'marketValue': market_value,
            'per': to_num(m.get('per')), 'pbr': to_num(m.get('pbr')),
            'eps': to_num(m.get('eps')), 'bps': to_num(m.get('bps')),
            'forward': forward, 'source': 'naver'}


# ---------- stockanalysis.com (거시 AI 자금 사슬 트리거용) ----------

def sa_nums(html, key):
    m = re.search(r'[,{]' + re.escape(key) + r':\[([^\]]*)\]', html)
    if not m:
        return None
    out = []
    for s in m.group(1).split(','):
        s = s.strip()
        if s in ('', 'null'):
            out.append(None)
        else:
            try:
                out.append(float(s))
            except ValueError:
                out.append(None)
    return out


def sa_dates(html):
    m = re.search(r'[,{]datekey:\[([^\]]*)\]', html)
    if not m:
        return None
    return [x.strip().strip('"') for x in m.group(1).split(',')]


def sa_fetch_page(ticker, part):
    base = 'https://stockanalysis.com/stocks/' + ticker.lower() + '/financials/'
    url = base + ('cash-flow-statement/?p=quarterly' if part == 'cashflow' else '?p=quarterly')
    _, _, body = http_get(url, timeout=25)
    return body.decode('utf-8', 'replace')


def sa_data(ticker, parts):
    res = {'ticker': ticker.upper()}
    if parts in ('income', 'both'):
        h = sa_fetch_page(ticker, 'income')
        res['income'] = {'dates': sa_dates(h), 'revenue': sa_nums(h, 'revenue'),
                         'operatingMargin': sa_nums(h, 'operatingMargin')}
    if parts in ('cashflow', 'both'):
        h = sa_fetch_page(ticker, 'cashflow')
        res['cashflow'] = {'dates': sa_dates(h), 'capex': sa_nums(h, 'capex'),
                           'fcf': sa_nums(h, 'fcf'), 'ocf': sa_nums(h, 'ncfo')}
    return res


# ---------- HTTP 핸들러 ----------

class Handler(BaseHTTPRequestHandler):
    def _send(self, status, ctype, body):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')   # 정적 파일 강캐시 방지 (편집 중 즉시 반영)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status=200):
        self._send(status, 'application/json; charset=utf-8',
                   json.dumps(obj, ensure_ascii=False).encode('utf-8'))

    def do_OPTIONS(self):
        self._send(204, 'text/plain', b'')

    def _static(self, path):
        """company_analysis/ 아래 정적 파일 서빙 (디렉터리 탈출 방지)"""
        rel = urllib.parse.unquote(path.lstrip('/')) or 'index.html'
        full = os.path.normpath(os.path.join(SITE_ROOT, rel))
        if not full.startswith(SITE_ROOT):
            return self._json({'error': '잘못된 경로'}, 400)
        if os.path.isdir(full):
            full = os.path.join(full, 'index.html')
        if not os.path.isfile(full):
            return self._json({'error': '파일 없음: /' + rel +
                               ' — 편집기는 http://127.0.0.1:%d/editor.html' % self.server.server_port}, 404)
        ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json'):
            ctype += '; charset=utf-8'
        with open(full, 'rb') as f:
            self._send(200, ctype, f.read())

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(parsed.query)
            get = lambda k: (q.get(k) or [''])[0].strip()

            # ---- 프록시 확인 (편집기 자동감지용) ----
            if get('ping'):
                return self._json({'ok': True, 'service': 'dart-local-proxy'})

            # ---- stockanalysis.com 거시 트리거 데이터 ----
            if get('sa'):
                tk = get('sa')
                if not re.fullmatch(r'[A-Za-z.]{1,8}', tk):
                    return self._json({'error': '잘못된 티커'}, 400)
                parts = get('parts') or 'both'
                try:
                    return self._json(sa_data(tk, parts))
                except Exception as e:
                    return self._json({'error': str(e), 'ticker': tk.upper()}, 502)

            # ---- OpenDART 중계 ----
            dart_path = get('dartPath')
            if dart_path:
                if dart_path not in DART_PATHS:
                    return self._json({'error': '허용되지 않은 dartPath: ' + dart_path}, 400)
                params = {k: v[0] for k, v in q.items() if k != 'dartPath'}
                if not params.get('crtfc_key'):
                    return self._json({'error': 'OpenDART 인증키(crtfc_key)가 필요합니다.'}, 400)
                ext = '.xml' if dart_path == 'corpCode' else '.json'
                target = ('https://opendart.fss.or.kr/api/' + dart_path + ext + '?' +
                          urllib.parse.urlencode(params))
                if dart_path == 'corpCode':
                    status, ctype, body = download_corpcode(target)
                    return self._send(status, ctype, body)
                print(f'[proxy] OpenDART {dart_path} 조회 중…', flush=True)
                status, ctype, body = http_get(target, timeout=120)
                print(f'[proxy] OpenDART {dart_path} 완료 ({len(body):,} bytes)', flush=True)
                return self._send(status, 'application/json; charset=utf-8', body)

            # ---- 네이버 시세 ----
            code = get('code')
            if code:
                if not re.fullmatch(r'\d{6}', code):
                    return self._json({'error': '종목코드는 6자리 숫자여야 합니다.'}, 400)
                if get('hist') == '1':
                    h = naver_history(code)
                    if not h:
                        return self._json({'error': '과거 PER/PBR을 찾지 못했습니다.', 'code': code}, 502)
                    return self._json({'code': code, 'history': h, 'source': 'naver'})
                return self._json(naver_quote(code))

            # ---- 정적 사이트 (편집기 포함) ----
            return self._static(parsed.path)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError) as e:
            # 브라우저가 대기시간 초과 등으로 먼저 연결을 끊은 경우 — 응답 시도 불가, 무시
            print(f'[proxy] 브라우저가 연결을 끊었습니다(대기시간 초과?) - 다시 클릭하면 캐시로 빠르게 응답합니다. ({e})', flush=True)
        except Exception as e:
            print(f'[proxy] 오류: {e}', flush=True)
            try:
                self._json({'error': str(e)}, 502)
            except Exception:
                pass

    def log_message(self, fmt, *args):
        sys.stderr.write('[proxy] ' + (fmt % args) + '\n')


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8321
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('=' * 56)
    print(f'  로컬 프록시 + 편집기 서버 실행 중  (Ctrl+C로 종료)')
    print(f'  브라우저에서 여세요:  http://127.0.0.1:{port}/editor.html')
    print('=' * 56)
    print('(이 주소로 열면 프록시 URL이 자동 설정됩니다. 사이트 열람: /index.html)')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
