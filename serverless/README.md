# 네이버 시세 · OpenDART 프록시 (Cloudflare Worker) — 배포 가이드

정적 사이트(GitHub Pages)는 브라우저 CORS 정책 때문에 네이버 금융과 **OpenDART API**를 직접 호출할 수 없습니다.
이 워커가 **서버 측에서 대신 호출**해 CORS 허용 헤더와 함께 돌려줍니다.
- 네이버: 현재가·시가총액·과거 PER/PBR
- OpenDART: 분기 재무제표(매출·영업이익·순이익·자본총계)·발행주식총수·고유번호 목록

무료(Cloudflare Workers 무료 플랜: 하루 10만 요청)이며 배포는 한 번만 하면 됩니다.
**기존에 배포해 둔 워커가 있다면 최신 코드로 교체(재배포)해야 OpenDART 중계가 동작합니다.**

> ⚠ **OpenDART는 해외/데이터센터 IP를 차단하는 경우가 많아 Cloudflare 워커에서 시간 초과가 날 수 있습니다.**
> 그 경우 아래 **로컬 프록시**를 사용하세요 — 네이버 시세 조회는 워커로도 잘 됩니다.

## 로컬 프록시 (OpenDART 수집용 권장) — `dart-local-proxy.py`

내 PC(한국 IP)에서 직접 중계하므로 OpenDART 차단 문제가 없습니다. 파이썬 표준 라이브러리만 사용, 설치 불필요.
**편집기 페이지도 같은 주소에서 서빙**하므로 CORS·브라우저 보안정책 문제가 원천적으로 없습니다.

```bash
cd company_analysis/serverless
python dart-local-proxy.py        # 포트 변경: python dart-local-proxy.py 9000
```

그다음 **브라우저에서 `http://127.0.0.1:8321/editor.html` 을 엽니다** (즐겨찾기 추천).
- 이 주소로 열면 편집기가 로컬 프록시를 자동 감지해 **프록시 URL이 자동 설정**됩니다.
- 네이버 현재가·과거 PER/PBR·OpenDART 수집이 전부 이 주소 하나로 동작합니다.
- ⚠ `editor.html`을 파일로 직접(file://) 열면 브라우저가 127.0.0.1 요청을 차단/지연시킬 수 있습니다 — 반드시 위 주소로 여세요.
- 편집 작업을 하는 동안만 켜두면 되고, 공개 사이트 열람(친구들)에는 필요 없습니다.
- localStorage(API 키·로컬 저장 기업)는 **주소(origin)별로 분리**되므로, file://로 입력했던 키·데이터는 이 주소에서 다시 입력/가져오기 해야 합니다.

배포 파일: [`naver-proxy.worker.js`](naver-proxy.worker.js)

---

## 방법 A — 대시보드 붙여넣기 (계정만 있으면 2분, CLI 불필요) ✅ 추천

1. https://dash.cloudflare.com 가입/로그인 (무료).
2. 좌측 **Workers & Pages → Create → Create Worker** (Start with Hello World).
3. 이름 입력(예: `naver-proxy`) → **Deploy**.
4. **Edit code** 클릭 → 기본 코드를 모두 지우고 [`naver-proxy.worker.js`](naver-proxy.worker.js) 내용을 통째로 붙여넣기 → **Deploy**.
5. 발급된 URL 확인: `https://naver-proxy.<계정>.workers.dev`
6. 브라우저에서 `https://naver-proxy.<계정>.workers.dev/?code=005930` 열어 아래처럼 JSON이 나오면 성공:
   ```json
   { "code":"005930","name":"삼성전자","price":80000,"shares":5969782550,
     "marketValue":477582604000000,"per":25.02,"pbr":4.30,"source":"naver" }
   ```
   과거 PER/PBR(밴드용)은 `...workers.dev/?code=005930&hist=1` → `{ "history":[{"label":"25.1q","per":11.2,"pbr":0.98}, ...] }`
7. (선택) OpenDART 중계 확인: `...workers.dev/?dartPath=fnlttSinglAcnt&crtfc_key=<API키>&corp_code=00126380&bsns_year=2024&reprt_code=11011`
   → `{"status":"000", "list":[...]}`가 나오면 성공.

### (선택) OpenDART 키를 워커에 저장하기
편집기에 키를 넣는 대신 워커 환경변수로 둘 수도 있습니다(공유 시 키 노출 방지):
Worker → **Settings → Variables and Secrets → Add** → 이름 `DART_KEY`, 값에 OpenDART 인증키 → Deploy.
이후 요청에 `crtfc_key`가 없으면 이 값을 자동 사용합니다.

## 방법 B — wrangler CLI

```bash
npm i -g wrangler
wrangler login
# 이 폴더(serverless/)에서:
wrangler deploy naver-proxy.worker.js --name naver-proxy --compatibility-date 2024-01-01
```

---

## 편집기에 연결

1. 위에서 얻은 워커 URL(`https://naver-proxy.<계정>.workers.dev`)을 복사.
2. `editor.html`을 열고 「⚡ 자동 입력」 영역의 **네이버 프록시 URL** 칸에 붙여넣기 → 저장(브라우저 localStorage에 기억).
3. 이후 「📈 네이버에서 현재가·주식수」 버튼이 이 워커를 사용합니다. (프록시 미설정 시 공개 프록시로 시도 → 실패 시 수기 입력)

## 참고
- 네이버 API 응답 필드는 변경될 수 있습니다. 값이 안 잡히면 워커의 `byCodeMap`(시가총액·PER 등) 또는 `closePrice`/`extractPerPbr` 파싱부를 조정하세요.
- 발행주식수는 네이버가 직접 주지 않아 **시가총액 ÷ 현재가**로 추정합니다(약 1~2% 오차). 정확값은 DART 분기보고서에서 자동 추출됩니다.
- 개인용이면 그대로 두어도 되지만, 공개 배포 시 남용을 막으려면 워커에 `Referer`/`Origin` 화이트리스트를 추가하는 것을 권장합니다.
