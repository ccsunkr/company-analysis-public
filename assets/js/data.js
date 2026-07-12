/* =============================================================================
 * data.js — 기업분석 데이터 (커밋되는 원본 / source of truth)
 * -----------------------------------------------------------------------------
 * 스키마 (schema):
 *  {
 *    id, name, ticker, market, sector, updated,        // 기본 정보
 *    unit:  '조원',                                     // 재무 단위
 *    quarters: [ { label, revenue, op,                  // 분기 실적 (연결)
 *                  cogs?, sga?, ocf?, netIncome? } ],   //   ?=DART 보완입력(선택)
 *    segments: [ { name, type:'revenue'|'op',           // 부문별 (선택)
 *                  values: { '2021':.., ... } } ],
 *    valuation: {                                       // 멀티플 밸류에이션 입력
 *      price,          // 현재 주가 (원)
 *      shares,         // 발행주식수 (주)
 *      netIncomeTTM,   // 최근 4분기 순이익 (조원)  — quarters에 netIncome 다 있으면 자동
 *      equity,         // 자본총계 (조원)
 *      perBand: { low, avg, high },   // 과거 PER 밴드 (직접 입력)
 *      pbrBand: { low, avg, high },   // 과거 PBR 밴드
 *      targetPer,      // 적정주가 산출용 목표 PER (미입력 시 perBand.avg)
 *      targetPbr,      // 적정주가 산출용 목표 PBR (미입력 시 pbrBand.avg)
 *      epsGrowth,      // 예상 EPS 성장률(%) — PEG용. 미입력 시 연간 순이익 CAGR로 자동
 *      dps,            // 주당배당금(원, 연간) — 배당 기준 적정주가·배당수익률용
 *      targetDivYield, // 목표 배당수익률(%) — 배당 기준 적정주가 = dps ÷ (이 값/100)
 *      isExample       // true면 '예시값' 배지 표시
 *    },
 *
 *  적정주가 = 가중 평균(PBR 0.5 · 배당 0.3 · PER 0.2, 없는 앵커는 재배분) — 12개월 관점.
 *  시그널 투표도 PBR 밴드 위치를 2배 가중. 근거: KOSPI top30 T-12 표본외 검증에서
 *  자기 역사 대비 PBR이 가장 강건(+10.8%), 배당수익률 약한 양(+2.1%), 이익수익률 실패(−3.4%).
 *
 *  자동 계산 지표: ROE(순이익TTM÷자본총계), EPS성장률(순이익 CAGR/TTM YoY),
 *    PEG(PER÷EPS성장률%), 매출·영업이익·순이익 성장률(3y CAGR·TTM YoY)
 *    — 분기 순이익·자본총계·발행주식수가 있으면 표시됩니다 (OpenDART 자동 수집 가능).
 *    commentary: [ { title, body } ],                   // 해설 (리스크 헤지 관점)
 *  }
 *
 * 연간요약은 quarters에서 자동 집계됩니다(연도 접두어 기준).
 * =========================================================================== */

window.COMPANIES = [
  {
    id: 'samsung',
    name: '삼성전자',
    ticker: '005930',
    market: 'KOSPI',
    sector: '반도체 / 세트',
    updated: '2026-07-02',
    unit: '조원',
    quarters: [
      { label: '2021 1Q', revenue: 65.39, op: 9.38 },
      { label: '2021 2Q', revenue: 63.67, op: 12.57 },
      { label: '2021 3Q', revenue: 73.98, op: 15.82 },
      { label: '2021 4Q', revenue: 76.57, op: 13.87 },
      { label: '2022 1Q', revenue: 77.78, op: 14.12 },
      { label: '2022 2Q', revenue: 77.20, op: 14.10 },
      { label: '2022 3Q', revenue: 76.78, op: 10.85 },
      { label: '2022 4Q', revenue: 70.46, op: 4.31 },
      { label: '2023 1Q', revenue: 63.75, op: 0.64 },
      { label: '2023 2Q', revenue: 60.01, op: 0.67 },
      { label: '2023 3Q', revenue: 67.40, op: 2.43 },
      { label: '2023 4Q', revenue: 67.78, op: 2.82 },
      { label: '2024 1Q', revenue: 71.92, op: 6.61 },
      { label: '2024 2Q', revenue: 74.07, op: 10.44 },
      { label: '2024 3Q', revenue: 79.10, op: 9.18 },
      { label: '2024 4Q', revenue: 75.80, op: 6.49 },
      { label: '2025 1Q', revenue: 79.14, op: 6.70 },
      { label: '2025 2Q', revenue: 74.60, op: 4.70 },
      { label: '2025 3Q', revenue: 86.06, op: 12.17 },
      { label: '2025 4Q', revenue: 93.80, op: 20.10 }
    ],
    segments: [
      { name: 'DS 반도체', type: 'op', values: {} },
      { name: 'DX 세트', type: 'op', values: {} },
      { name: 'SDC 디스플레이', type: 'op', values: {} },
      { name: 'Harman', type: 'op', values: {} }
    ],
    valuation: {
      // ↓ 예시값입니다. 실제 시세·DART 재무제표로 갱신하세요.
      price: 80000,
      shares: 5969782550,
      netIncomeTTM: 34.0,
      equity: 402.0,
      perBand: { low: 8, avg: 12, high: 18 },
      pbrBand: { low: 0.9, avg: 1.3, high: 1.8 },
      targetPer: 12,
      targetPbr: 1.3,
      isExample: true
    },
    commentary: [
      { title: '장기 추세 요약',
        body: '매출은 60~94조원 사이에서 반도체 사이클에 연동해 등락. 영업이익의 사이클 진폭이 훨씬 커서 OPM이 2021년 20%대 → 2023년 1%대 → 2025년 4Q 21%대로 요동. 실적 변동성은 사실상 메모리 반도체 사이클이 좌우.' },
      { title: '리스크 ①: 메모리 사이클',
        body: '2023년이 리스크 현실화 구간. 분기 영업이익이 0.6~0.7조원(OPM ~1%)까지 붕괴. 매수 후 이런 하락 구간을 심리적으로 버틸 수 있느냐가 핵심. 조합 차트로 "주기적으로 이런 계곡을 지난다"를 체화하면 손실 구간 인내 가능.' },
      { title: '리스크 ②: 이익 편차',
        body: '매출 대비 영업이익 분기 편차가 매우 큼(고정비·재고평가충당 영향). 단일 분기 실적으로 판단 금물. 최소 4~8분기 추세로 방향성 확인.' },
      { title: '회복 스토리(촉매)',
        body: '2024년부터 완만히 회복, 2025년 3~4분기 급반등(3Q OP 12.2조, 4Q 20.1조). HBM 등 AI향 고부가 메모리가 견인. 촉매의 지속성 판단은 정성적 분석(수급·경쟁·CAPEX)에서 별도 검증 필요.' },
      { title: '체크 포인트',
        body: '① DS(반도체) 영업이익 추세가 전사 실적을 사실상 결정. ② 영업활동현금흐름과 영업이익 괴리 여부. ③ 재고자산·재고평가충당 주석(사이클 저점 신호).' }
    ]
  },

  /* ---------------------------------------------------------------------------
   * 미원상사 (002840) — 확장 프레임워크 실데이터 예시 (연결, 단위: 백만원)
   *   출처: 사용자 제공 '미원상사_23.3q.xlsx' (연결 손익/현금흐름 + 역사적 PER + 자사주)
   * ------------------------------------------------------------------------- */
  {
    id: 'miwon',
    name: '미원상사',
    ticker: '002840',
    market: 'KOSPI',
    sector: '정밀화학 (계면활성제·전자재료)',
    statement: '연결',
    updated: '2023-11-01',
    unit: '백만원',
    buybackUnit: '억원',
    quarters: [
      { label: '17.1q', revenue: 98547, cogs: 87686, sga: 7894, op: 2967, ocf: 1372, capex: 7879 },
      { label: '17.2q', revenue: 75853, cogs: 67636, sga: 5924, op: 2293, ocf: 13676, capex: 9665 },
      { label: '17.3q', revenue: 83710, cogs: 71791, sga: 6764, op: 5155, ocf: 3592, capex: 2900 },
      { label: '17.4q', revenue: 60545, cogs: 52845, sga: 7118, op: 582, ocf: 11921, capex: 5208 },
      { label: '18.1q', revenue: 89168, cogs: 76841, sga: 6471, op: 5856, ocf: 8369, capex: 3248 },
      { label: '18.2q', revenue: 94286, cogs: 78476, sga: 7021, op: 8789, ocf: 11787, capex: 4563 },
      { label: '18.3q', revenue: 87176, cogs: 72909, sga: 5827, op: 8440, ocf: 11887, capex: 12448 },
      { label: '18.4q', revenue: 58018, cogs: 47491, sga: 6439, op: 4088, ocf: 5340, capex: 10404 },
      { label: '19.1q', revenue: 53793, cogs: 44613, sga: 4817, op: 4363, ocf: 3158, capex: 7543 },
      { label: '19.2q', revenue: 63098, cogs: 47415, sga: 4959, op: 10724, ocf: -2221, capex: 7238 },
      { label: '19.3q', revenue: 62934, cogs: 48412, sga: 4883, op: 9639, ocf: 6370, capex: 15313 },
      { label: '19.4q', revenue: 70166, cogs: 60099, sga: 7928, op: 2139, ocf: 12409, capex: 11978 },
      { label: '20.1q', revenue: 69811, cogs: 55499, sga: 5465, op: 8847, ocf: 14990, capex: 14141 },
      { label: '20.2q', revenue: 73390, cogs: 54678, sga: 5685, op: 13027, ocf: 15411, capex: 14788 },
      { label: '20.3q', revenue: 73714, cogs: 55281, sga: 5494, op: 12939, ocf: 9051, capex: 9636 },
      { label: '20.4q', revenue: 78068, cogs: 61466, sga: 8531, op: 8071, ocf: 15656, capex: 3733 },
      { label: '21.1q', revenue: 83425, cogs: 63395, sga: 6277, op: 13753, ocf: 8396, capex: 6799 },
      { label: '21.2q', revenue: 88796, cogs: 66612, sga: 6093, op: 16091, ocf: 17577, capex: 5772 },
      { label: '21.3q', revenue: 91787, cogs: 68169, sga: 5975, op: 17643, ocf: 16779, capex: 8641 },
      { label: '21.4q', revenue: 95786, cogs: 76938, sga: 9180, op: 9668, ocf: 12325, capex: 7607 },
      { label: '22.1q', revenue: 102659, cogs: 79609, sga: 6429, op: 16621, ocf: 9237, capex: 9296 },
      { label: '22.2q', revenue: 116954, cogs: 87349, sga: 7383, op: 22222, ocf: 12823, capex: 14005 },
      { label: '22.3q', revenue: 113392, cogs: 80427, sga: 6837, op: 26128, ocf: 27543, capex: 9284 },
      { label: '22.4q', revenue: 105183, cogs: 82661, sga: 10477, op: 12045, ocf: 21179, capex: 8791 },
      { label: '23.1q', revenue: 107403, cogs: 84960, sga: 7694, op: 14749, ocf: 22138, capex: 8354 },
      { label: '23.2q', revenue: 101822, cogs: 77099, sga: 7468, op: 17255, ocf: 26599, capex: 6292 },
      { label: '23.3q', revenue: 105772, cogs: 77981, sga: 8023, op: 19768, ocf: 20021, capex: 27201 }
    ],
    // 역사적 분기별 PER (연결) — 밴드(백분위) 자동 산출의 근거
    valuationHistory: [
      { label: '14.1q', per: 10.46 }, { label: '14.3q', per: 13.24 }, { label: '14.4q', per: 10.07 },
      { label: '15.1q', per: 11.27 }, { label: '15.2q', per: 9.11 }, { label: '15.3q', per: 9.17 }, { label: '15.4q', per: 18.43 },
      { label: '16.1q', per: 7.92 }, { label: '16.2q', per: 8.94 }, { label: '16.3q', per: 10.53 }, { label: '16.4q', per: 6.81 },
      { label: '17.1q', per: 30.20 }, { label: '17.2q', per: 2.28 }, { label: '17.3q', per: 9.28 },
      { label: '18.1q', per: 9.97 }, { label: '18.2q', per: 6.84 }, { label: '18.3q', per: 7.09 }, { label: '18.4q', per: 19.86 },
      { label: '19.1q', per: 14.29 }, { label: '19.2q', per: 5.71 }, { label: '19.3q', per: 7.45 }, { label: '19.4q', per: 11.61 },
      { label: '20.1q', per: 6.58 }, { label: '20.2q', per: 7.23 }, { label: '20.3q', per: 9.30 }, { label: '20.4q', per: 9.66 },
      { label: '21.1q', per: 16.04 }, { label: '21.2q', per: 17.33 }, { label: '21.3q', per: 14.75 }, { label: '21.4q', per: 25.56 },
      { label: '22.1q', per: 13.74 }, { label: '22.2q', per: 10.37 }, { label: '22.3q', per: 8.21 }
    ],
    // 분기별 자사주 매입액 (억원)
    buybacks: [
      { label: '17.1q', amount: 277.5 }, { label: '17.2q', amount: 268.6 }, { label: '17.3q', amount: 266.0 }, { label: '17.4q', amount: 2303.7 },
      { label: '18.1q', amount: 70.4 }, { label: '18.2q', amount: 69.9 }, { label: '18.3q', amount: 67.9 }, { label: '18.4q', amount: 72.8 },
      { label: '20.1q', amount: 2958.4 }, { label: '20.2q', amount: 3664.0 },
      { label: '21.1q', amount: 1757.2 }, { label: '21.3q', amount: 4257.0 },
      { label: '22.1q', amount: 3914.6 }, { label: '22.2q', amount: 5310.8 }, { label: '22.3q', amount: 7408.6 }, { label: '22.4q', amount: 3220.3 }
    ],
    valuation: {
      // 현재 주가만 참고용(예시). 발행주식수·순이익 미입력 → 현재 PER은 역사적 최신값으로 대체, 밴드 위치로 판단.
      price: 161000,
      isExample: true
    },
    commentary: [
      { title: '장기 추세 요약',
        body: '분기 매출 60~117백만(백만원 단위 표기)로 우상향, 영업이익은 2017년 저조(OPM 3~6%)에서 2022년 20%대까지 구조적 개선. GPM(매출총이익률) 상승과 판관비율 안정이 OPM 레벨업을 견인.' },
      { title: '마진 개선 동력',
        body: 'GPM이 2017년 11~17%에서 2022~23년 24~29%로 상승. 고부가 전자재료 비중 확대와 제품가-원재료가 스프레드 확대가 배경. 판관비율은 6~8%대에서 안정적으로 관리.' },
      { title: '현금흐름·재투자',
        body: 'OCF는 대체로 견조(2022~23년 분기 20백만+ 빈번). 다만 CAPEX 변동이 커 FCF가 분기별로 요동(예: 23.3q CAPEX 27,201로 FCF 대폭 마이너스). 증설 사이클과 FCF 흐름을 함께 볼 것.' },
      { title: '밸류에이션 — 역사적 PER 밴드',
        body: '2014~2022년 분기 PER 분포의 백분위 밴드로 현재 위치를 판단. 중앙값 대비 하단(저 PER) 구간은 저평가, 21년처럼 상단(25배대)은 고평가 신호. 단일 분기 PER은 이익 계절성으로 튀므로 밴드 관점이 핵심.' },
      { title: '주주환원',
        body: '2020·2022년 대규모 자사주 매입(분기 3천~7천억원대)으로 주가 하방을 지지. 주주환원 의지가 뚜렷하며, 매입 시점이 주가 조정 구간과 겹치는지 점검하면 진입 참고가 됨.' }
    ]
  }
];
