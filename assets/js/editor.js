/* =============================================================================
 * editor.js — 기업 데이터 입력/편집기
 *   · DART 재무 입력 → 실시간 밸류에이션/차트 미리보기
 *   · 로컬 저장(localStorage) + JSON/data.js 내보내기(→ 저장소 커밋)
 * =========================================================================== */
(function () {
  'use strict';
  var V = window.Valuation, fmt = V.fmt;
  var LS_KEY = 'companyAnalysis.overrides';

  function blankState() {
    return {
      id: '', name: '', ticker: '', market: 'KOSPI', sector: '', statement: '연결',
      updated: today(), unit: '조원', buybackUnit: '억원',
      quarters: [],
      valuationHistory: [],
      buybacks: [],
      valuation: { price: null, shares: null, netIncomeTTM: null, equity: null,
        perBand: { low: null, avg: null, high: null }, pbrBand: { low: null, avg: null, high: null },
        targetPer: null, targetPbr: null, isExample: false },
      principles: { pq: '', catalysts: [], quality: false, chart: false },
      sellTriggers: { flags: [false, false, false, false, false], labels: V.DEFAULT_SELL_TRIGGERS.slice(), memo: '' },
      commentary: []
    };
  }
  var state = blankState();

  /* ---------- 저장소 접근 ---------- */
  var sharedCompanies = {};   // 공유 저장소(워커 KV)에서 로드 — init에서 채움
  function baseCompanies() { return (window.COMPANIES || []).slice(); }
  function overrides() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
  function allCompanies() {
    var byId = {};
    baseCompanies().forEach(function (c) { byId[c.id] = c; });
    Object.keys(sharedCompanies).forEach(function (id) {
      if (sharedCompanies[id] && sharedCompanies[id].id) byId[id] = sharedCompanies[id];
    });
    var ov = overrides();
    Object.keys(ov).forEach(function (id) {
      if (ov[id] && ov[id].__deleted) delete byId[id]; else byId[id] = ov[id];
    });
    return Object.keys(byId).map(function (id) { return byId[id]; });
  }
  function loadShared(done) {
    if (!window.Store || !Store.enabled()) { if (done) done(); return; }
    var st = document.getElementById('store-status');
    Store.list().then(function (obj) {
      sharedCompanies = obj || {};
      if (st) st.innerHTML = '☁ 공유 기업 <b>' + Object.keys(sharedCompanies).length + '개</b> 불러옴.';
    }).catch(function (e) {
      if (st) st.innerHTML = '<span style="color:var(--red)">공유 목록 로드 실패: ' + esc(e.message || e) + '</span>';
    }).then(function () { if (done) done(); });
  }

  /* ---------- 초기화 ---------- */
  function init() {
    buildSelector();
    bindStaticFields();
    bindButtons();
    // URL 해시로 특정 기업 편집 (#samsung)
    var hid = location.hash.replace('#', '');
    // 공유 목록을 먼저 불러온 뒤 선택 (해시 기업이 공유본일 수 있음)
    loadShared(function () {
      buildSelector();
      if (hid) { var c = allCompanies().filter(function (x) { return x.id === hid; })[0]; if (c) { loadInto(c); return; } }
      if (state.id) { document.getElementById('company-select').value = state.id; return; }
      newCompany();
    });
    if (hid) { var c0 = allCompanies().filter(function (x) { return x.id === hid; })[0]; if (c0) loadInto(c0); else newCompany(); }
    else newCompany();
  }

  function buildSelector() {
    var sel = document.getElementById('company-select');
    sel.innerHTML = '<option value="__new">＋ 새 기업</option>' +
      allCompanies().map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + ' (' + esc(c.id) + ')</option>'; }).join('');
    sel.addEventListener('change', function () {
      if (sel.value === '__new') newCompany();
      else { var c = allCompanies().filter(function (x) { return x.id === sel.value; })[0]; if (c) loadInto(c); }
    });
  }

  function newCompany() {
    state = blankState();
    document.getElementById('company-select').value = '__new';
    syncFormFromState();
  }

  function loadInto(c) {
    state = deepClone(c);
    state.unit = state.unit || '조원';
    state.buybackUnit = state.buybackUnit || '억원';
    state.statement = state.statement || '연결';
    state.valuation = state.valuation || {};
    state.valuation.perBand = state.valuation.perBand || { low: null, avg: null, high: null };
    state.valuation.pbrBand = state.valuation.pbrBand || { low: null, avg: null, high: null };
    state.quarters = state.quarters || [];
    state.valuationHistory = state.valuationHistory || [];
    state.buybacks = state.buybacks || [];
    state.commentary = state.commentary || [];
    state.principles = state.principles || { pq: '', catalysts: [], quality: false, chart: false };
    state.principles.catalysts = state.principles.catalysts || [];
    state.sellTriggers = state.sellTriggers || {};
    if (!Array.isArray(state.sellTriggers.labels) || state.sellTriggers.labels.length !== 5) state.sellTriggers.labels = V.DEFAULT_SELL_TRIGGERS.slice();
    if (!Array.isArray(state.sellTriggers.flags) || state.sellTriggers.flags.length !== 5) state.sellTriggers.flags = [false, false, false, false, false];
    state.sellTriggers.memo = state.sellTriggers.memo || '';
    document.getElementById('company-select').value = c.id;
    syncFormFromState();
  }

  /* ---------- 폼 ↔ 상태 동기화 ---------- */
  var textFields = ['id', 'name', 'ticker', 'market', 'sector', 'statement', 'updated', 'unit', 'buybackUnit'];
  var valFields = ['price', 'shares', 'netIncomeTTM', 'equity', 'targetPer', 'targetPbr', 'epsGrowth', 'dps', 'targetDivYield', 'forwardNI', 'debt'];
  var bandFields = [['perBand', 'low'], ['perBand', 'avg'], ['perBand', 'high'],
                    ['pbrBand', 'low'], ['pbrBand', 'avg'], ['pbrBand', 'high']];

  function bindStaticFields() {
    textFields.forEach(function (f) {
      document.getElementById('f-' + f).addEventListener('input', function (e) {
        state[f] = e.target.value; if (f !== 'id') refresh(); else refreshPreviewOnly();
      });
    });
    valFields.forEach(function (f) {
      document.getElementById('v-' + f).addEventListener('input', function (e) {
        state.valuation[f] = numOrNull(e.target.value); refresh();
      });
    });
    bandFields.forEach(function (pair) {
      var key = pair[0] + '-' + pair[1];
      document.getElementById('v-' + key).addEventListener('input', function (e) {
        state.valuation[pair[0]][pair[1]] = numOrNull(e.target.value); refresh();
      });
    });
    document.getElementById('v-isExample').addEventListener('change', function (e) {
      state.valuation.isExample = e.target.checked; refresh();
    });
    var wp = document.getElementById('v-weightPreset');
    if (wp) wp.addEventListener('change', function () {
      if (wp.value === 'default') delete state.valuation.weights;
      else state.valuation.weights = WEIGHT_PRESETS[wp.value];
      refresh();
    });
  }

  // 적정주가 앵커 가중 프리셋 — 정의는 valuation.js(공용). 'default'는 기본값 사용.
  var WEIGHT_PRESETS = V.WEIGHT_PRESETS;
  var presetKeyOf = V.presetKeyOf;

  function syncFormFromState() {
    textFields.forEach(function (f) { document.getElementById('f-' + f).value = state[f] || ''; });
    valFields.forEach(function (f) { document.getElementById('v-' + f).value = state.valuation[f] == null ? '' : state.valuation[f]; });
    bandFields.forEach(function (pair) {
      document.getElementById('v-' + pair[0] + '-' + pair[1]).value =
        state.valuation[pair[0]][pair[1]] == null ? '' : state.valuation[pair[0]][pair[1]];
    });
    document.getElementById('v-isExample').checked = !!state.valuation.isExample;
    var wp = document.getElementById('v-weightPreset');
    if (wp) wp.value = presetKeyOf(state.valuation.weights);
    var pr = state.principles || {};
    var pq = document.getElementById('pr-pq'); if (pq) pq.value = pr.pq || '';
    var q2 = document.getElementById('pr-quality'); if (q2) q2.checked = !!pr.quality;
    var q7 = document.getElementById('pr-chart'); if (q7) q7.checked = !!pr.chart;
    renderQuarterTable();
    renderValHistory();
    renderBuybacks();
    renderCatalysts();
    renderTriggerLabels();
    renderCommentary();
    refresh();
  }

  /* ---------- 매도 트리거 5단계 라벨 (종목별) ---------- */
  function renderTriggerLabels() {
    var box = document.getElementById('trig-labels'); if (!box) return;
    var num = ['①', '②', '③', '④', '⑤'], zone = ['상류', '상류', '중류', '하류', '하류'];
    box.innerHTML = state.sellTriggers.labels.map(function (lbl, i) {
      return '<div class="field" style="margin-bottom:6px"><label style="font-weight:400">' + num[i] + ' <span class="sub">(' + zone[i] + ')</span></label>' +
        '<input data-trigi="' + i + '" type="text" value="' + escAttr(lbl || '') + '" placeholder="' + escAttr(V.DEFAULT_SELL_TRIGGERS[i]) + '"></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-trigi]'), function (inp) {
      inp.addEventListener('input', function () { state.sellTriggers.labels[+inp.getAttribute('data-trigi')] = inp.value; });
    });
  }

  /* ---------- 촉매 (숫자×촉매의 촉매 축) ---------- */
  function renderCatalysts() {
    var tb = document.getElementById('cat-body'); if (!tb) return;
    var cats = (state.principles && state.principles.catalysts) || [];
    tb.innerHTML = cats.map(function (c, i) {
      function sel(key, opts, cur) {
        return '<td><select data-cati="' + i + '" data-catk="' + key + '">' +
          opts.map(function (o) { return '<option' + (o === cur ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select></td>';
      }
      return '<tr>' +
        '<td><input data-cati="' + i + '" data-catk="text" type="text" value="' + escAttr(c.text || '') + '" placeholder="예: 2026 2Q 신공장 가동 → 연매출 +300억"></td>' +
        '<td><input data-cati="' + i + '" data-catk="due" type="text" value="' + escAttr(c.due || '') + '" placeholder="2026-12" style="max-width:90px"></td>' +
        sel('grade', ['Fact/A', 'Fact/B', '추정', '판단'], c.grade || '추정') +
        sel('status', ['유효', '훼손', '실현'], c.status || '유효') +
        '<td class="rm"><button class="icon-btn" data-catrm="' + i + '">×</button></td></tr>';
    }).join('');
    Array.prototype.forEach.call(tb.querySelectorAll('[data-cati]'), function (inp) {
      var ev = inp.tagName === 'SELECT' ? 'change' : 'input';
      inp.addEventListener(ev, function () {
        state.principles.catalysts[+inp.getAttribute('data-cati')][inp.getAttribute('data-catk')] = inp.value;
        refresh();
      });
    });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-catrm]'), function (btn) {
      btn.addEventListener('click', function () {
        state.principles.catalysts.splice(+btn.getAttribute('data-catrm'), 1); renderCatalysts(); refresh();
      });
    });
  }

  /* ---------- 밸류에이션 히스토리 (역사적 PER/PBR → 밴드) ---------- */
  function renderValHistory() {
    var tb = document.getElementById('vh-body');
    tb.innerHTML = (state.valuationHistory || []).map(function (h, i) {
      return '<tr>' +
        '<td><input data-vhi="' + i + '" data-vhk="label" type="text" value="' + escAttr(h.label || '') + '" placeholder="20.1q"></td>' +
        '<td><input data-vhi="' + i + '" data-vhk="per" type="number" step="any" value="' + escAttr(h.per == null ? '' : h.per) + '"></td>' +
        '<td><input data-vhi="' + i + '" data-vhk="pbr" type="number" step="any" value="' + escAttr(h.pbr == null ? '' : h.pbr) + '"></td>' +
        '<td class="rm"><button class="icon-btn" data-vhrm="' + i + '">×</button></td></tr>';
    }).join('');
    Array.prototype.forEach.call(tb.querySelectorAll('input'), function (inp) {
      inp.addEventListener('input', function () {
        var i = +inp.getAttribute('data-vhi'), k = inp.getAttribute('data-vhk');
        state.valuationHistory[i][k] = k === 'label' ? inp.value : numOrNull(inp.value);
        updateBandNote(); refresh();
      });
    });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-vhrm]'), function (btn) {
      btn.addEventListener('click', function () { state.valuationHistory.splice(+btn.getAttribute('data-vhrm'), 1); renderValHistory(); updateBandNote(); refresh(); });
    });
    updateBandNote();
  }
  function updateBandNote() {
    var note = document.getElementById('band-note');
    var band = V.computeBand(state.valuationHistory, 'per');
    if (!band) { note.textContent = 'PER 3개 이상 입력 시 밴드(백분위)가 자동 계산됩니다.'; return; }
    note.innerHTML = '자동 PER 밴드 (' + band.n + '개): 최저 <b>' + band.min.toFixed(1) + '</b> · P25 <b>' + band.p25.toFixed(1) +
      '</b> · 중앙 <b>' + band.median.toFixed(1) + '</b> · P75 <b>' + band.p75.toFixed(1) + '</b> · 최고 <b>' + band.max.toFixed(1) + '</b>';
  }

  /* ---------- 주주환원 (자사주 매입) ---------- */
  function renderBuybacks() {
    var tb = document.getElementById('bb-body');
    tb.innerHTML = (state.buybacks || []).map(function (b, i) {
      return '<tr>' +
        '<td><input data-bbi="' + i + '" data-bbk="label" type="text" value="' + escAttr(b.label || '') + '" placeholder="22.3q"></td>' +
        '<td><input data-bbi="' + i + '" data-bbk="amount" type="number" step="any" value="' + escAttr(b.amount == null ? '' : b.amount) + '"></td>' +
        '<td class="rm"><button class="icon-btn" data-bbrm="' + i + '">×</button></td></tr>';
    }).join('');
    Array.prototype.forEach.call(tb.querySelectorAll('input'), function (inp) {
      inp.addEventListener('input', function () {
        var i = +inp.getAttribute('data-bbi'), k = inp.getAttribute('data-bbk');
        state.buybacks[i][k] = k === 'label' ? inp.value : numOrNull(inp.value);
      });
    });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-bbrm]'), function (btn) {
      btn.addEventListener('click', function () { state.buybacks.splice(+btn.getAttribute('data-bbrm'), 1); renderBuybacks(); });
    });
  }

  /* ---------- 분기 테이블 ---------- */
  function renderQuarterTable() {
    var tb = document.getElementById('qtable-body');
    tb.innerHTML = state.quarters.map(function (q, i) {
      return '<tr>' +
        cell('text', 'label', i, q.label, '2024 1Q') +
        cell('num', 'revenue', i, q.revenue) +
        cell('num', 'op', i, q.op) +
        cell('num', 'cogs', i, q.cogs, '', true) +
        cell('num', 'sga', i, q.sga, '', true) +
        cell('num', 'netIncome', i, q.netIncome, '', true) +
        cell('num', 'ocf', i, q.ocf, '', true) +
        cell('num', 'capex', i, q.capex, '', true) +
        cell('num', 'inventory', i, q.inventory, '', true) +
        cell('num', 'receivables', i, q.receivables, '', true) +
        '<td class="rm"><button class="icon-btn" data-rm="' + i + '" title="삭제">×</button></td>' +
        '</tr>';
    }).join('');
    // bind
    Array.prototype.forEach.call(tb.querySelectorAll('input'), function (inp) {
      inp.addEventListener('input', function () {
        var i = +inp.getAttribute('data-i'), key = inp.getAttribute('data-k');
        state.quarters[i][key] = key === 'label' ? inp.value : numOrNull(inp.value);
        refresh();
      });
    });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-rm]'), function (btn) {
      btn.addEventListener('click', function () {
        state.quarters.splice(+btn.getAttribute('data-rm'), 1); renderQuarterTable(); refresh();
      });
    });
  }
  function cell(type, key, i, val, ph, dart) {
    var v = val == null ? '' : val;
    return '<td><input class="' + (dart ? 'dart' : '') + '" data-i="' + i + '" data-k="' + key + '" ' +
      (type === 'num' ? 'type="number" step="any"' : 'type="text"') +
      ' value="' + escAttr(v) + '"' + (ph ? ' placeholder="' + ph + '"' : '') + '></td>';
  }

  /* ---------- 해설 ---------- */
  function renderCommentary() {
    var box = document.getElementById('commentary-box');
    box.innerHTML = state.commentary.map(function (it, i) {
      return '<div class="field" style="border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:8px">' +
        '<div class="row2" style="align-items:end"><div><label>소제목</label>' +
        '<input data-ci="' + i + '" data-ck="title" value="' + escAttr(it.title || '') + '"></div>' +
        '<div style="text-align:right"><button class="btn sm danger" data-crm="' + i + '">삭제</button></div></div>' +
        '<label style="margin-top:6px">내용</label><textarea data-ci="' + i + '" data-ck="body" rows="3">' + esc(it.body || '') + '</textarea></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-ci]'), function (inp) {
      inp.addEventListener('input', function () {
        state.commentary[+inp.getAttribute('data-ci')][inp.getAttribute('data-ck')] = inp.value; refreshPreviewOnly();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-crm]'), function (btn) {
      btn.addEventListener('click', function () { state.commentary.splice(+btn.getAttribute('data-crm'), 1); renderCommentary(); });
    });
  }

  /* ---------- 버튼 ---------- */
  function bindButtons() {
    document.getElementById('btn-addq').addEventListener('click', function () {
      state.quarters.push({ label: '', revenue: null, op: null }); renderQuarterTable(); refresh();
    });
    document.getElementById('btn-gen20').addEventListener('click', function () {
      var y = prompt('시작 연도(예: 2021)를 입력하세요. 해당 연도부터 5년(20분기) 라벨을 생성합니다.', '2021');
      if (!y) return; y = parseInt(y, 10); if (!y) return;
      state.quarters = [];
      for (var yy = y; yy < y + 5; yy++) for (var qn = 1; qn <= 4; qn++)
        state.quarters.push({ label: yy + ' ' + qn + 'Q', revenue: null, op: null });
      renderQuarterTable(); refresh();
    });
    document.getElementById('btn-addvh').addEventListener('click', function () {
      state.valuationHistory.push({ label: '', per: null, pbr: null }); renderValHistory();
    });
    document.getElementById('btn-genvh').addEventListener('click', function () {
      var y = prompt('역사적 PER 시작 연도(예: 2018)? 해당 연도부터 현재까지 분기 라벨을 생성합니다.', '2018');
      if (!y) return; y = parseInt(y, 10); if (!y) return;
      var endY = new Date().getFullYear();
      state.valuationHistory = [];
      for (var yy = y; yy <= endY; yy++) for (var qn = 1; qn <= 4; qn++)
        state.valuationHistory.push({ label: (yy % 100) + '.' + qn + 'q', per: null, pbr: null });
      renderValHistory();
    });
    document.getElementById('btn-addbb').addEventListener('click', function () {
      state.buybacks.push({ label: '', amount: null }); renderBuybacks();
    });
    document.getElementById('btn-addc').addEventListener('click', function () {
      state.commentary.push({ title: '', body: '' }); renderCommentary();
    });
    var addCat = document.getElementById('btn-addcat');
    if (addCat) addCat.addEventListener('click', function () {
      state.principles.catalysts.push({ text: '', due: '', grade: '추정', status: '유효' }); renderCatalysts();
    });
    var prPq = document.getElementById('pr-pq');
    if (prPq) prPq.addEventListener('change', function () { state.principles.pq = prPq.value; refresh(); });
    var prQ = document.getElementById('pr-quality');
    if (prQ) prQ.addEventListener('change', function () { state.principles.quality = prQ.checked; refresh(); });
    var prC = document.getElementById('pr-chart');
    if (prC) prC.addEventListener('change', function () { state.principles.chart = prC.checked; refresh(); });
    document.getElementById('btn-vh-naver').addEventListener('click', onVhNaver);
    document.getElementById('vh-csv').addEventListener('change', onVhCsv);
    document.getElementById('dart-file').addEventListener('change', onDartFile);
    document.getElementById('btn-naver').addEventListener('click', onNaver);
    var proxyInput = document.getElementById('naver-proxy');
    if (proxyInput) {
      proxyInput.value = getProxyUrl();
      proxyInput.addEventListener('input', function () { setProxyUrl(proxyInput.value); updateDartProxyNote(); });
    }
    updateDartProxyNote();
    var dartKeyInput = document.getElementById('dart-key');
    if (dartKeyInput) {
      dartKeyInput.value = getDartKey();
      dartKeyInput.addEventListener('input', function () { setDartKey(dartKeyInput.value); });
    }
    var dartApiBtn = document.getElementById('btn-dartapi');
    if (dartApiBtn) dartApiBtn.addEventListener('click', onDartApi);
    autodetectLocalProxy();
    document.getElementById('btn-save').addEventListener('click', saveLocal);
    var storeUrlInput = document.getElementById('store-url');
    if (storeUrlInput && window.Store) {
      storeUrlInput.value = Store.url();
      storeUrlInput.addEventListener('input', function () { Store.setUrl(storeUrlInput.value); });
    }
    var storeKeyInput = document.getElementById('store-key');
    if (storeKeyInput && window.Store) {
      storeKeyInput.value = Store.key();
      storeKeyInput.addEventListener('input', function () { Store.setKey(storeKeyInput.value); });
    }
    var bss = document.getElementById('btn-store-save');
    if (bss) bss.addEventListener('click', saveShared);
    var bsd = document.getElementById('btn-store-delete');
    if (bsd) bsd.addEventListener('click', deleteShared);
    var bsl = document.getElementById('btn-store-load');
    if (bsl) bsl.addEventListener('click', function () { loadShared(function () { buildSelector(); if (state.id) document.getElementById('company-select').value = state.id; }); });
    document.getElementById('btn-export-one').addEventListener('click', exportOne);
    document.getElementById('btn-export-all').addEventListener('click', exportAllDataJs);
    document.getElementById('btn-delete').addEventListener('click', deleteLocal);
    document.getElementById('file-import').addEventListener('change', importFile);
  }

  function validateId() {
    if (!state.id) { alert('기업 ID(영문 소문자, 예: samsung)를 입력하세요.'); return false; }
    if (!/^[a-z0-9_-]+$/.test(state.id)) { alert('ID는 영문 소문자·숫자·-·_ 만 사용하세요.'); return false; }
    if (!state.name) { alert('기업명을 입력하세요.'); return false; }
    return true;
  }

  function saveLocal() {
    if (!validateId()) return;
    var ov = overrides();
    ov[state.id] = collect();
    localStorage.setItem(LS_KEY, JSON.stringify(ov));
    buildSelector();
    document.getElementById('company-select').value = state.id;
    toast('로컬에 저장되었습니다. 목록 페이지에서 확인할 수 있어요. (영구 공개하려면 아래 "data.js 내보내기" → 저장소 커밋)');
  }

  /* ---------- 공유 저장소 (워커 KV — 친구들과 실시간 공유) ---------- */
  function storeReady() {
    if (!window.Store) return '스크립트 로드 오류';
    if (!Store.url()) return '공유 서버 URL을 입력하세요 (워커 주소 — 아래 공유 설정 칸)';
    if (!Store.key()) return '공유 비밀번호를 입력하세요 (아래 공유 설정 칸)';
    return null;
  }

  function saveShared() {
    if (!validateId()) return;
    var st = document.getElementById('store-status');
    var why = storeReady();
    if (why) { st.innerHTML = '<span style="color:var(--red)">' + esc(why) + '</span>'; return; }
    var c = collect();
    var btn = document.getElementById('btn-store-save');
    btn.disabled = true; st.textContent = '공유 저장 중…';
    Store.save(c).then(function (j) {
      // 공유본이 목록에 그대로 반영되므로, 같은 내용의 로컬 사본은 제거(그림자 방지)
      var ov = overrides();
      if (ov[c.id] && !ov[c.id].__deleted) { delete ov[c.id]; localStorage.setItem(LS_KEY, JSON.stringify(ov)); }
      sharedCompanies[c.id] = c;
      buildSelector(); document.getElementById('company-select').value = c.id;
      st.innerHTML = '☁ <b>' + esc(c.name) + '</b> 공유 저장 완료 — 친구들 화면에도 바로 반영됩니다. (공유 기업 ' + (j.count != null ? j.count : Object.keys(sharedCompanies).length) + '개)';
      toast('공유 저장 완료. 모두의 목록에 반영되었습니다.');
    }).catch(function (e) {
      st.innerHTML = '<span style="color:var(--red)">공유 저장 실패: ' + esc(e.message || e) + '</span>';
    }).finally(function () { btn.disabled = false; });
  }

  function deleteShared() {
    if (!state.id) return;
    var st = document.getElementById('store-status');
    var why = storeReady();
    if (why) { st.innerHTML = '<span style="color:var(--red)">' + esc(why) + '</span>'; return; }
    if (!confirm('"' + state.name + '"을(를) 공유 저장소에서 삭제할까요? (모두의 목록에서 사라집니다)')) return;
    Store.remove(state.id).then(function (j) {
      delete sharedCompanies[state.id];
      buildSelector();
      st.innerHTML = '공유 저장소에서 삭제했습니다. (남은 공유 기업 ' + (j.count != null ? j.count : Object.keys(sharedCompanies).length) + '개)';
    }).catch(function (e) {
      st.innerHTML = '<span style="color:var(--red)">공유 삭제 실패: ' + esc(e.message || e) + '</span>';
    });
  }

  function deleteLocal() {
    if (!state.id) return;
    if (!confirm('"' + state.name + '"을(를) 로컬 목록에서 삭제할까요? (data.js 원본 기업이면 이 브라우저에서만 숨겨집니다)')) return;
    var ov = overrides();
    var isBase = baseCompanies().some(function (c) { return c.id === state.id; });
    if (isBase) ov[state.id] = { __deleted: true };
    else delete ov[state.id];
    localStorage.setItem(LS_KEY, JSON.stringify(ov));
    buildSelector(); newCompany();
    toast('삭제되었습니다.');
  }

  function exportOne() {
    if (!validateId()) return;
    download(state.id + '.json', JSON.stringify(collect(), null, 2));
  }

  function exportAllDataJs() {
    if (state.id && validateId()) { var ov = overrides(); ov[state.id] = collect(); localStorage.setItem(LS_KEY, JSON.stringify(ov)); buildSelector(); }
    var list = allCompanies();
    var body = 'window.COMPANIES = ' + JSON.stringify(list, null, 2) + ';\n';
    download('data.js', body);
    toast('data.js 내보냈습니다. 저장소의 assets/js/data.js 를 이 파일로 교체하고 커밋하면 공개 사이트에 반영됩니다.');
  }

  function importFile(e) {
    var file = e.target.files[0]; if (!file) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var obj = JSON.parse(r.result);
        if (Array.isArray(obj)) { alert('단일 기업 JSON을 가져오세요. (배열은 data.js로 교체하세요)'); return; }
        loadInto(obj);
        toast('가져왔습니다. 내용 확인 후 "로컬 저장" 하세요.');
      } catch (err) { alert('JSON 파싱 실패: ' + err.message); }
    };
    r.readAsText(file);
    e.target.value = '';
  }

  /* ---------- 상태 수집(정제) ---------- */
  function collect() {
    var c = {
      id: state.id.trim(), name: state.name.trim(), ticker: (state.ticker || '').trim(),
      market: state.market, sector: (state.sector || '').trim(),
      statement: state.statement || '연결', updated: state.updated || today(),
      unit: state.unit || '조원',
      quarters: state.quarters.filter(function (q) { return q.label; }).map(function (q) {
        var o = { label: q.label.trim(), revenue: numOrNull(q.revenue), op: numOrNull(q.op) };
        ['cogs', 'sga', 'netIncome', 'ocf', 'capex', 'inventory', 'receivables'].forEach(function (k) {
          if (numOrNull(q[k]) != null) o[k] = numOrNull(q[k]);
        });
        return o;
      }),
      valuationHistory: (state.valuationHistory || []).filter(function (h) { return h.label && (numOrNull(h.per) != null || numOrNull(h.pbr) != null); })
        .map(function (h) { var o = { label: h.label.trim() }; if (numOrNull(h.per) != null) o.per = numOrNull(h.per); if (numOrNull(h.pbr) != null) o.pbr = numOrNull(h.pbr); return o; }),
      buybacks: (state.buybacks || []).filter(function (b) { return b.label && numOrNull(b.amount) != null; })
        .map(function (b) { return { label: b.label.trim(), amount: numOrNull(b.amount) }; }),
      buybackUnit: state.buybackUnit || '억원',
      valuation: cleanVal(state.valuation),
      commentary: state.commentary.filter(function (x) { return x.title || x.body; })
        .map(function (x) { return { title: (x.title || '').trim(), body: (x.body || '').trim() }; })
    };
    if (!c.valuationHistory.length) delete c.valuationHistory;
    if (!c.buybacks.length) { delete c.buybacks; delete c.buybackUnit; }
    // 투자 원칙 체크 (촉매·P/Q·수기 확인)
    var pr = state.principles || {};
    var cats = (pr.catalysts || []).filter(function (x) { return x.text; }).map(function (x) {
      return { text: x.text.trim(), due: (x.due || '').trim(), grade: x.grade || '추정', status: x.status || '유효' };
    });
    if (pr.pq || cats.length || pr.quality || pr.chart) {
      c.principles = {};
      if (pr.pq) c.principles.pq = pr.pq;
      if (cats.length) c.principles.catalysts = cats;
      if (pr.quality) c.principles.quality = true;
      if (pr.chart) c.principles.chart = true;
    }
    // 매도 트리거 (라벨이 기본값과 다르거나, 점등·메모가 있으면 저장)
    var stg = state.sellTriggers || {};
    var labels = (stg.labels || []).map(function (x) { return (x || '').trim(); });
    var customLabels = labels.some(function (x, i) { return x && x !== V.DEFAULT_SELL_TRIGGERS[i]; });
    var anyFlag = (stg.flags || []).some(Boolean);
    if (customLabels || anyFlag || (stg.memo || '').trim()) {
      c.sellTriggers = {
        flags: (stg.flags || [false, false, false, false, false]).slice(0, 5).map(Boolean),
        labels: labels.map(function (x, i) { return x || V.DEFAULT_SELL_TRIGGERS[i]; }),
        memo: (stg.memo || '').trim()
      };
    }
    return c;
  }
  function cleanVal(v) {
    var o = {};
    ['price', 'shares', 'netIncomeTTM', 'equity', 'targetPer', 'targetPbr', 'epsGrowth', 'dps', 'targetDivYield', 'forwardNI', 'debt'].forEach(function (k) {
      if (numOrNull(v[k]) != null) o[k] = numOrNull(v[k]);
    });
    ['perBand', 'pbrBand'].forEach(function (b) {
      var bb = v[b] || {}, res = {};
      ['low', 'avg', 'high'].forEach(function (k) { if (numOrNull(bb[k]) != null) res[k] = numOrNull(bb[k]); });
      if (Object.keys(res).length) o[b] = res;
    });
    if (v.weights && (numOrNull(v.weights.per) != null || numOrNull(v.weights.pbr) != null || numOrNull(v.weights.div) != null)) {
      o.weights = { per: numOrNull(v.weights.per) || 0, pbr: numOrNull(v.weights.pbr) || 0, div: numOrNull(v.weights.div) || 0 };
    }
    if (v.isExample) o.isExample = true;
    return o;
  }

  /* ---------- 미리보기 ---------- */
  function refresh() { renderPreview(); }
  function refreshPreviewOnly() { renderPreview(); }

  function renderPreview() {
    var c = collect();
    var val = V.computeValuation(c);
    var box = document.getElementById('preview');
    var sig = val.signal || { key: 'na', label: '판단 불가' };
    box.innerHTML =
      '<div class="section" style="margin-top:0">' +
        '<h3>미리보기 — ' + (esc(c.name) || '(기업명)') + '</h3>' +
        '<p class="hint">' + esc(c.market || '') + (c.sector ? ' · ' + esc(c.sector) : '') + '</p>' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">' +
          '<span class="signal ' + sig.key + ' lg"><span class="dot"></span>' + sig.label + '</span>' +
          (val.upside != null ? '<b style="font-size:20px;color:' + (val.upside >= 0 ? 'var(--green)' : 'var(--red)') + '">' + fmt.signedPct(val.upside) + '</b><small style="color:var(--ink-2)">상승여력</small>' : '<span class="small-note">밸류에이션 입력 필요</span>') +
          (c.valuation && c.valuation.isExample ? '<span class="example-badge">예시값</span>' : '') +
        '</div>' +
        '<div class="metric-grid">' +
          mp('현재 주가', fmt.price(val.price)) +
          mp('적정주가', val.fairAvg != null ? fmt.price(val.fairAvg) : '–') +
          mp('현재 PER', fmt.x(val.per)) +
          mp('현재 PBR', fmt.x(val.pbr, 2)) +
          mp('ROE', val.roe != null ? fmt.pct(val.roe) : '–') +
          mp('EPS 성장률', val.epsGrowth != null ? fmt.signedPct(val.epsGrowth) : '–') +
          mp('PEG', val.peg != null ? fmt.x(val.peg, 2)
            : (val.epsGrowth != null && val.epsGrowth <= 0 ? '– <span class="sub">(성장률≤0)</span>' : '–')) +
          mp('EPS(TTM)', val.eps != null ? fmt.price(val.eps) : '–') +
          mp('시가총액', val.marketCap != null ? fmt.won(val.marketCap) : '–') +
        '</div>' +
        '<div class="chart-box" id="pv-chart" style="margin-top:16px"></div>' +
      '</div>';

    renderChecklist(c, val);
    var q = c.quarters || [];
    if (q.length) {
      Charts.renderComboChart(document.getElementById('pv-chart'), {
        labels: q.map(function (x) { return x.label; }),
        bars: [
          { name: '매출액', color: 'var(--blue)', values: q.map(function (x) { return x.revenue; }) },
          { name: '영업이익', color: 'var(--orange)', values: q.map(function (x) { return x.op; }) }
        ],
        line: { name: 'OPM', color: 'var(--grey)',
          values: q.map(function (x) { return (x.revenue && x.op != null) ? x.op / x.revenue : null; }),
          fmt: function (v) { return (v * 100).toFixed(0) + '%'; } }
      });
    }
  }
  function mp(l, v) { return '<div class="metric"><div class="lbl">' + l + '</div><div class="val">' + v + '</div></div>'; }

  /* ---------- 유틸 ---------- */
  function numOrNull(x) { if (x === '' || x == null) return null; var n = Number(x); return isFinite(n) ? n : null; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
  function download(name, text) {
    var blob = new Blob([text], { type: 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._t); t._t = setTimeout(function () { t.style.display = 'none'; }, 6000);
  }

  /* =========================================================================
   * DART 분기보고서 PDF 자동 입력
   * ========================================================================= */
  var UNIT_FACTOR = { '조원': 1e-6, '억원': 0.01, '백만원': 1, '천원': 1000 }; // 백만원 → target

  function convUnit(valMillion, unit) {
    if (valMillion == null) return null;
    var f = UNIT_FACTOR[unit] != null ? UNIT_FACTOR[unit] : 1e-6;
    return Math.round(valMillion * f * 100) / 100;
  }

  // 기존 라벨 스타일에 맞춰 분기 라벨 생성
  function labelStyle() {
    var q = (state.quarters || []).find(function (x) { return x.label; });
    if (q && /^\d{2}\.\dq$/i.test(q.label)) return 'dot';       // '25.1q'
    if (q && /^\d{4}\s*\dQ$/i.test(q.label)) return 'space';    // '2025 1Q'
    return 'space';
  }
  function fmtQLabel(year, q) {
    return labelStyle() === 'dot' ? (String(year).slice(-2) + '.' + q + 'q') : (year + ' ' + q + 'Q');
  }

  var pdfjsReady = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = function () {
        try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; } catch (e) {}
        resolve(window.pdfjsLib);
      };
      s.onerror = function () { reject(new Error('pdf.js 로드 실패 (인터넷 연결 필요)')); };
      document.head.appendChild(s);
    });
    return pdfjsReady;
  }

  function onDartFile(e) {
    var files = Array.prototype.slice.call(e.target.files || []); e.target.value = '';
    if (!files.length) return;
    var status = document.getElementById('dart-status');
    status.textContent = 'PDF ' + files.length + '개 처리 준비…';
    loadPdfJs().then(function (pdfjs) {
      var results = [], seq = Promise.resolve();
      files.forEach(function (file, idx) {
        seq = seq.then(function () {
          status.textContent = '(' + (idx + 1) + '/' + files.length + ') ' + file.name + ' 추출 중…';
          return file.arrayBuffer()
            .then(function (buf) { return pdfjs.getDocument({ data: buf }).promise; })
            .then(function (pdf) { return extractPdfText(pdf, status, idx + 1, files.length, file.name); })
            .then(function (text) { var res = DartParser.parseDartReport(text); res.__file = file.name; results.push(res); })
            .catch(function (err) { results.push({ ok: false, __file: file.name, error: err.message || String(err) }); });
        });
      });
      return seq.then(function () { return results; });
    }).then(function (results) {
      status.textContent = '';
      var ok = results.filter(function (r) { return r.ok; });
      var bad = results.filter(function (r) { return !r.ok; });
      if (!ok.length) { status.innerHTML = '<span style="color:var(--red)">추출 실패: ' + esc((bad[0] && bad[0].error) || '연결재무제표 포함 보고서인지 확인') + '</span>'; return; }
      showDartPreview(ok, bad);
    }).catch(function (err) {
      status.innerHTML = '<span style="color:var(--red)">' + esc(err.message || String(err)) + '</span>';
    });
  }
  function extractPdfText(pdf, status, fileNo, fileTot, name) {
    var pages = pdf.numPages, chunks = [], seq = Promise.resolve();
    for (var p = 1; p <= pages; p++) (function (pn) {
      seq = seq.then(function () {
        if (pn % 40 === 0) status.textContent = '(' + fileNo + '/' + fileTot + ') ' + name + ' — ' + pn + '/' + pages + 'p…';
        return pdf.getPage(pn).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
          chunks[pn] = tc.items.map(function (it) { return it.str; }).join(' ');
        });
      });
    })(p);
    return seq.then(function () { return chunks.join('\n'); });
  }

  // 여러 보고서 미리보기 (연도·분기 순, 사업보고서는 뒤). 누락 항목도 표시.
  function showDartPreview(list, bad) {
    var unit = state.unit || '조원';
    var sorted = list.slice().sort(byOrder);
    var rows = sorted.map(function (r) {
      var type = r.isAnnual ? '사업(연간)' : (r.quarter === 2 ? '반기' : '분기');
      var period, rev, op, miss = [];
      if (r.isAnnual) {
        period = '제' + (r.fiscalNo || '?') + '기 → ' + (r.annual || []).map(function (a) { return fmtQLabel(a.year, 4); }).join('·');
        var a0 = (r.annual || [])[0] || {};
        rev = convUnit(a0.revenue, unit); op = convUnit(a0.op, unit);
      } else {
        period = fmtQLabel(r.year, r.quarter);
        var rr = r.reported; rev = convUnit(rr.revenue, unit); op = convUnit(rr.op, unit);
        [['ocf', 'OCF'], ['inventory', '재고자산'], ['receivables', '매출채권'], ['cogs', '매출원가'], ['netIncome', '순이익']].forEach(function (p) { if (rr[p[0]] == null) miss.push(p[1]); });
      }
      var warn = miss.length ? '<tr><td colspan="5" style="padding:0 6px 5px;text-align:left"><span class="small-note" style="color:var(--amber)">⚠ ' + esc(r.__file || '') + ': ' + miss.join('·') + ' 미추출(적용 후 수기 보완)</span></td></tr>' : '';
      return '<tr><td style="text-align:left">' + esc(r.__file || '') + '</td><td>' + type + '</td><td>' + esc(period) + '</td><td>' + fnum(rev) + '</td><td>' + fnum(op) + '</td></tr>' + warn;
    }).join('');
    var dated = list.slice().sort(byDate);
    var shRes = dated.filter(function (r) { return numOrNull(r.shares) != null; }).pop();
    var eqRes = dated.filter(function (r) { return r.reported && numOrNull(r.reported.equity) != null; }).pop();
    var html = '<div class="dart-preview"><h4>' + list.length + '개 보고서 추출 — 연도·분기 순 자동 적용(사업보고서는 Q4 계산 위해 마지막)</h4>' +
      '<table class="qtable"><thead><tr><th style="text-align:left">파일</th><th>유형</th><th>기간</th><th>매출액(' + esc(unit) + ')</th><th>영업이익</th></tr></thead><tbody>' + rows + '</tbody></table>';
    var notes = [];
    if (shRes) notes.push('발행주식총수 <b>' + shRes.shares.toLocaleString('ko-KR') + '</b>주');
    if (eqRes) notes.push('자본총계 <b>' + fnum(convUnit(eqRes.reported.equity, unit)) + '</b> ' + esc(unit) + ' (' + esc(eqRes.endDate || '') + ')');
    if (notes.length) html += '<p class="small-note">' + notes.join(' · ') + ' — 자본총계·주식수는 <b>가장 최근 보고서</b> 기준으로 반영.</p>';
    if (bad && bad.length) html += '<p class="small-note" style="color:var(--red)">추출 실패 ' + bad.length + '개: ' + bad.map(function (b) { return esc(b.__file || ''); }).join(', ') + '</p>';
    html += '<div class="toolbar"><button class="btn primary sm" id="btn-dart-apply">✓ 전체 적용</button><button class="btn sm" id="btn-dart-cancel">취소</button></div></div>';
    document.getElementById('dart-preview').innerHTML = html;
    document.getElementById('btn-dart-apply').addEventListener('click', function () { applyBatch(list); });
    document.getElementById('btn-dart-cancel').addEventListener('click', function () { document.getElementById('dart-preview').innerHTML = ''; });
  }
  function fnum(v) { return v == null ? '–' : v.toLocaleString('ko-KR'); }
  function byOrder(a, b) { return ((a.year || 0) * 10 + (a.isAnnual ? 9 : a.quarter)) - ((b.year || 0) * 10 + (b.isAnnual ? 9 : b.quarter)); }
  function byDate(a, b) { return String(a.endDate || '').localeCompare(String(b.endDate || '')); }

  // 같은 해 특정 분기 행 찾기 (라벨 스타일 무관)
  function findQ(year, q) {
    return (state.quarters || []).find(function (x) { return (+V.fullYear(x.label)) === year && V.quarterNo(x.label) === q; });
  }
  function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }
  function priorSameYearSum(year, q, key) {
    var s = 0;
    for (var qq = 1; qq < q; qq++) { var row = findQ(year, qq); var v = row ? numOrNull(row[key]) : null; if (v == null) return null; s += v; }
    return s;
  }

  // 여러 보고서를 올바른 순서로 일괄 적용: 분기/반기(연·분기순) → 사업보고서(연도순, Q4 계산)
  function applyBatch(list) {
    var unit = state.unit || '조원';
    document.getElementById('dart-preview').innerHTML = '';
    var quarterly = list.filter(function (r) { return !r.isAnnual; }).sort(function (a, b) { return (a.year * 10 + a.quarter) - (b.year * 10 + b.quarter); });
    var annual = list.filter(function (r) { return r.isAnnual; }).sort(function (a, b) { return a.year - b.year; });
    quarterly.forEach(function (r) { applyQuarterlyToState(r, unit); });
    var q4 = [];
    annual.forEach(function (r) { q4 = q4.concat(applyAnnualToState(r, unit)); });
    // 자본총계·발행주식수·업데이트일자 = 가장 최근(endDate 최신) 보고서 기준
    var dated = list.slice().sort(byDate);
    var eqRes = dated.filter(function (r) { return r.reported && numOrNull(r.reported.equity) != null; }).pop();
    if (eqRes) state.valuation.equity = convUnit(eqRes.reported.equity, unit);
    var shRes = dated.filter(function (r) { return numOrNull(r.shares) != null; }).pop();
    if (shRes) state.valuation.shares = shRes.shares;
    var last = dated[dated.length - 1]; if (last && last.endDate) state.updated = last.endDate;
    sortQuarters(); syncFormFromState();
    var msg = quarterly.length + '개 분기/반기 + ' + annual.length + '개 사업보고서 적용.';
    if (q4.length) msg += ' Q4 자동생성: ' + q4.join('·') + '.';
    if (shRes) msg += ' 발행주식총수 ' + shRes.shares.toLocaleString('ko-KR') + '주.';
    if (eqRes) msg += ' 자본총계 ' + fnum(convUnit(eqRes.reported.equity, unit)) + esc(unit) + '(' + last.endDate + ' 기준).';
    toast(msg);
  }

  function applyQuarterlyToState(res, unit) {
    var r = res.reported, Y = res.year, Q = res.quarter;
    // 현금흐름 누적(YTD) → 분기값 보정: 당분기 = 누적 − 같은해 직전분기 합
    var ocf = convUnit(r.ocf, unit), capex = convUnit(r.capex, unit);
    if (Q > 1) {
      if (ocf != null) { var po = priorSameYearSum(Y, Q, 'ocf'); ocf = po == null ? ocf : round2(ocf - po); }
      if (capex != null) { var pc = priorSameYearSum(Y, Q, 'capex'); capex = pc == null ? capex : round2(capex - pc); }
    }
    upsertQuarter(fmtQLabel(Y, Q), {
      revenue: convUnit(r.revenue, unit), op: convUnit(r.op, unit), cogs: convUnit(r.cogs, unit),
      sga: convUnit(r.sga, unit), netIncome: convUnit(r.netIncome, unit),
      ocf: ocf, capex: capex, inventory: convUnit(r.inventory, unit), receivables: convUnit(r.receivables, unit)
    });
    if (res.prevYear && res.prevYear.revenue != null) {
      var p = res.prevYear;
      upsertQuarter(fmtQLabel(p.year, p.quarter), {
        revenue: convUnit(p.revenue, unit), op: convUnit(p.op, unit), cogs: convUnit(p.cogs, unit),
        sga: convUnit(p.sga, unit), netIncome: convUnit(p.netIncome, unit)
      }, true);
    }
  }

  function applyAnnualToState(res, unit) {
    var done = [];
    (res.annual || []).forEach(function (a) {
      if (findQ(a.year, 1) && findQ(a.year, 2) && findQ(a.year, 3)) {
        function d(key) {
          var A = convUnit(a[key], unit); if (A == null) return null;
          var s = 0; for (var qq = 1; qq <= 3; qq++) { var row = findQ(a.year, qq); var v = row ? numOrNull(row[key]) : null; if (v == null) return null; s += v; }
          return round2(A - s);
        }
        upsertQuarter(fmtQLabel(a.year, 4), { revenue: d('revenue'), op: d('op'), cogs: d('cogs'), sga: d('sga'), netIncome: d('netIncome'), ocf: d('ocf'), capex: d('capex') });
        done.push(fmtQLabel(a.year, 4));
      }
    });
    // 재고자산·매출채권은 '기말 잔액'이라 차감 계산 불가 — 사업보고서의 당기말 잔액이 곧 그 연도 Q4 값.
    var rep = res.reported || {};
    var inv = convUnit(rep.inventory, unit), rec = convUnit(rep.receivables, unit);
    if ((inv != null || rec != null) && res.year) {
      var fields = {};
      if (inv != null) fields.inventory = inv;
      if (rec != null) fields.receivables = rec;
      upsertQuarter(fmtQLabel(res.year, 4), fields);
    }
    return done;
  }

  // 콘솔 디버깅용 (PDF 없이 추출 결과 객체를 직접 적용해 볼 때)
  window.__applyDartBatch = applyBatch;

  function upsertQuarter(label, fields, onlyIfEmpty) {
    var row = (state.quarters || []).find(function (x) { return x.label === label; });
    if (!row) { row = { label: label }; state.quarters.push(row); }
    Object.keys(fields).forEach(function (k) {
      if (fields[k] == null) return;
      if (onlyIfEmpty && numOrNull(row[k]) != null) return;
      row[k] = fields[k];
    });
  }
  function sortQuarters() {
    state.quarters.sort(function (a, b) {
      var ya = V.fullYear(a.label), yb = V.fullYear(b.label);
      if (ya !== yb) return (ya || '').localeCompare(yb || '');
      return (V.quarterNo(a.label) || 0) - (V.quarterNo(b.label) || 0);
    });
  }

  /* =========================================================================
   * OpenDART API 자동 수집 (dartApi.js)
   *   분기 매출액·영업이익·순이익 + 자본총계 + 발행주식총수 → 상태에 병합
   * ========================================================================= */
  var DART_KEY_LS = 'companyAnalysis.dartKey';
  function getDartKey() { try { return (localStorage.getItem(DART_KEY_LS) || '').trim(); } catch (e) { return ''; } }
  function setDartKey(k) { try { localStorage.setItem(DART_KEY_LS, (k || '').trim()); } catch (e) {} }

  // 편집기가 로컬 프록시(dart-local-proxy.py)에서 서빙되고 있으면 프록시 URL을 자동 설정
  function autodetectLocalProxy() {
    if (getProxyUrl()) return;
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(location.origin)) return;
    fetch(location.origin + '/?ping=1').then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.service !== 'dart-local-proxy') return;
      setProxyUrl(location.origin);
      var inp = document.getElementById('naver-proxy'); if (inp) inp.value = location.origin;
      updateDartProxyNote();
    }).catch(function () {});
  }

  // OpenDART 섹션에 "지금 어떤 프록시로 나가는지"를 항상 표시 (프록시 칸이 아래 섹션에 있어 놓치기 쉬움)
  function updateDartProxyNote() {
    var note = document.getElementById('dartapi-proxy-note'); if (!note) return;
    var p = getProxyUrl();
    if (!p) {
      note.innerHTML = '<span style="color:var(--red)">프록시 미설정 — 아래 「자동 입력 ②」의 <b>프록시 URL</b> 칸에 <code>http://127.0.0.1:8321</code>(로컬 프록시 실행 후) 또는 워커 주소를 입력하세요.</span>';
    } else if (/127\.0\.0\.1|localhost/.test(p)) {
      note.innerHTML = '사용할 프록시: <b>' + esc(p) + '</b> (로컬 — <code>python serverless/dart-local-proxy.py</code>가 실행 중이어야 합니다)';
    } else {
      note.innerHTML = '사용할 프록시: <b>' + esc(p) + '</b> <span style="color:var(--amber)">— OpenDART는 해외 IP(Cloudflare 워커)를 차단하는 경우가 많습니다. 시간 초과가 나면 아래 프록시 URL 칸을 <code>http://127.0.0.1:8321</code>(로컬 프록시)로 바꾸세요.</span>';
    }
  }

  // 원 단위 → 선택한 재무 단위
  var WON_TO_UNIT = { '조원': 1e12, '억원': 1e8, '백만원': 1e6, '천원': 1e3 };
  function wonToUnit(won, unit) {
    if (won == null) return null;
    var f = WON_TO_UNIT[unit] || 1e12;
    return Math.round(won / f * 100) / 100;
  }
  function qEndDate(y, q) {
    var lastDay = [null, '03-31', '06-30', '09-30', '12-31'][q];
    return y + '-' + lastDay;
  }

  function onDartApi() {
    var st = document.getElementById('dartapi-status');
    var btn = document.getElementById('btn-dartapi');
    var code = (state.ticker || '').trim();
    if (!/^\d{6}$/.test(code)) { st.innerHTML = '<span style="color:var(--red)">종목코드 6자리를 먼저 입력하세요.</span>'; return; }
    var key = getDartKey();
    if (!key) { st.innerHTML = '<span style="color:var(--red)">OpenDART API 인증키를 입력하세요. (opendart.fss.or.kr에서 무료 발급)</span>'; return; }
    var proxy = getProxyUrl();
    if (!proxy) { st.innerHTML = '<span style="color:var(--red)">OpenDART는 CORS를 막고 있어 <b>프록시 URL</b>이 필요합니다. 아래 프록시 URL에 Cloudflare Worker 주소를 입력하세요 (serverless/README.md, 2분 소요).</span>'; return; }
    var years = parseInt(document.getElementById('dart-years').value, 10) || 5;
    var unit = state.unit || '조원';
    btn.disabled = true;
    DartApi.fetchAll({
      key: key, proxy: proxy, ticker: code, years: years, statement: state.statement || '연결',
      onStatus: function (msg) { st.textContent = msg; }
    }).then(function (res) {
      res.quarters.forEach(function (qr) {
        upsertQuarter(fmtQLabel(qr.y, qr.q), {
          revenue: wonToUnit(qr.revenue, unit),
          op: wonToUnit(qr.op, unit),
          netIncome: wonToUnit(qr.netIncome, unit)
        });
      });
      if (res.equity != null) state.valuation.equity = wonToUnit(res.equity, unit);
      if (res.debt != null) state.valuation.debt = wonToUnit(res.debt, unit);
      if (res.shares != null) state.valuation.shares = res.shares;
      if (res.dividend && res.dividend.dps != null) {
        state.valuation.dps = res.dividend.dps; // 원/주 그대로 (단위 환산 없음)
        if (res.dividend.avgYield != null) state.valuation.targetDivYield = round2(res.dividend.avgYield);
      }
      if (!state.name && res.corpName) state.name = res.corpName;
      if (!state.id && res.corpName) state.id = code;
      if (res.latest) state.updated = qEndDate(res.latest.y, res.latest.q);
      sortQuarters(); syncFormFromState();
      var fsTxt = res.fsUsed === 'OFS' ? '별도(OFS)' : '연결(CFS)';
      var divTxt = '';
      if (res.dividend && res.dividend.dps != null) {
        divTxt = ' · 배당 DPS <b>' + res.dividend.dps.toLocaleString('ko-KR') + '원</b>(' + res.dividend.year + '년' +
          (res.dividend.avgYield != null ? ', 목표배당수익률 ' + round2(res.dividend.avgYield) + '% = ' + res.dividend.nYields + '개년 평균' : '') + ')';
      }
      st.innerHTML = '✓ <b>' + esc(res.corpName || code) + '</b> — 분기 손익 <b>' + res.quarters.length + '개</b>(' + fsTxt + ')' +
        (res.equity != null ? ' · 자본총계 <b>' + wonToUnit(res.equity, unit).toLocaleString('ko-KR') + '</b> ' + esc(unit) : '') +
        (res.shares != null ? ' · 발행주식총수 <b>' + res.shares.toLocaleString('ko-KR') + '</b>주' : '') +
        divTxt + ' 반영. 이제 네이버에서 현재가만 받으면 ROE·PEG·PER이 계산됩니다.';
      toast('OpenDART 수집 완료: 분기 ' + res.quarters.length + '개 반영. 매출원가·현금흐름 등은 PDF 업로드로 보완하세요.');
    }).catch(function (err) {
      st.innerHTML = '<span style="color:var(--red)">수집 실패: ' + esc(err.message || String(err)) + '</span>';
    }).finally(function () { btn.disabled = false; });
  }

  /* =========================================================================
   * 네이버 금융에서 현재가 + 상장주식수
   * ========================================================================= */
  function onNaver() {
    var code = (state.ticker || '').trim();
    var status = document.getElementById('naver-status');
    if (!/^\d{6}$/.test(code)) { status.innerHTML = '<span style="color:var(--red)">종목코드 6자리를 먼저 입력하세요.</span>'; return; }
    status.textContent = '네이버 금융 조회 중…';
    fetchNaver(code).then(function (d) {
      if (d.price != null) { state.valuation.price = d.price; document.getElementById('v-price').value = d.price; }
      // 네이버 주식수는 시총÷현재가 추정치 → DART로 넣은 정확값이 있으면 유지(덮지 않음)
      var keptDart = numOrNull(state.valuation.shares) != null;
      if (d.shares != null && !keptDart) { state.valuation.shares = d.shares; document.getElementById('v-shares').value = d.shares; }
      refresh();
      status.innerHTML = '가져옴: 현재가 <b>' + (d.price != null ? d.price.toLocaleString('ko-KR') : '?') + '원</b>' +
        (keptDart ? ' · 발행주식수는 DART 정확값 유지'
          : (d.shares != null ? ' · 상장주식수(추정) <b>' + d.shares.toLocaleString('ko-KR') + '</b>' : ' · 상장주식수 미확인(수기 입력)'));
    }).catch(function (err) {
      var hint = getProxyUrl() ? '' : ' (안정적 조회를 원하면 위 <b>네이버 프록시 URL</b>에 Cloudflare Worker 주소를 입력하세요 — serverless/README.md)';
      status.innerHTML = '<span style="color:var(--red)">자동 조회 실패: ' + esc(err.message) +
        '</span> — <a href="https://finance.naver.com/item/main.naver?code=' + code + '" target="_blank">네이버에서 직접 확인</a> 후 수기 입력하세요.' + hint;
    });
  }

  // 정적 사이트는 CORS로 네이버를 직접 호출 못 함.
  //  1순위: 사용자가 배포한 서버리스 워커(안정적) — localStorage에 URL 저장
  //  2순위: 공개 CORS 프록시(불안정) → 실패 시 수동 입력 폴백
  var PROXY_KEY = 'companyAnalysis.naverProxy';
  function getProxyUrl() {
    try {
      var u = (localStorage.getItem(PROXY_KEY) || '').trim();
      // 미설정 시 공유 서버(워커)를 프록시로 사용 — 친구는 별도 설정 없이 네이버·DART 조회 가능
      if (!u && window.SITE_CONFIG && SITE_CONFIG.sharedUrl) u = SITE_CONFIG.sharedUrl.trim();
      return u;
    } catch (e) { return ''; }
  }
  function setProxyUrl(u) { try { localStorage.setItem(PROXY_KEY, (u || '').trim()); } catch (e) {} }

  function fetchWithTimeout(url, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { ctrl && ctrl.abort(); }, ms || 6000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : {}).finally(function () { clearTimeout(t); });
  }

  /* ===== 역사적 PER/PBR: 네이버 자동조회 + CSV 업로드 ===== */
  function onVhNaver() {
    var code = (state.ticker || '').trim();
    var st = document.getElementById('vh-status');
    if (!/^\d{6}$/.test(code)) { st.innerHTML = '<span style="color:var(--red)">종목코드 6자리를 먼저 입력하세요.</span>'; return; }
    if (!getProxyUrl()) { st.innerHTML = '<span style="color:var(--amber)">네이버 프록시 URL을 먼저 설정하세요(위 자동입력 영역). 또는 KRX CSV를 업로드하세요.</span>'; return; }
    st.textContent = '네이버 과거 PER/PBR 조회 중…';
    var worker = getProxyUrl().replace(/\/+$/, '');
    var u = worker + (worker.indexOf('?') > -1 ? '&' : '?') + 'code=' + code + '&hist=1';
    fetchWithTimeout(u, 12000).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (j.error) throw new Error(j.error);
        if (!j.history || !j.history.length) throw new Error('과거 데이터 없음');
        var n = mergeValHistory(j.history);
        st.innerHTML = '네이버에서 <b>' + j.history.length + '개</b> 기간(연간+분기)을 불러왔습니다. 더 긴 히스토리는 KRX CSV로 보강하세요.';
      }).catch(function (e) {
        st.innerHTML = '<span style="color:var(--red)">조회 실패: ' + esc(e.message) + '</span> — KRX CSV 업로드를 이용하세요.';
      });
  }

  function onVhCsv(e) {
    var files = Array.prototype.slice.call(e.target.files || []); e.target.value = '';
    if (!files.length) return;
    var st = document.getElementById('vh-status');
    st.textContent = 'CSV ' + files.length + '개 읽는 중…';
    var readFile = function (f) {
      return new Promise(function (resolve) {
        var r = new FileReader();
        r.onload = function () { try { resolve(parseHistoryCsv(r.result)); } catch (err) { resolve([]); } };
        r.onerror = function () { resolve([]); };
        r.readAsText(f, 'utf-8'); // KRX는 EUC-KR이지만 PER/PBR·날짜·숫자는 ASCII라 파싱 가능
      });
    };
    Promise.all(files.map(readFile)).then(function (lists) {
      var all = [];
      lists.forEach(function (items) { all = all.concat(items); });
      if (!all.length) { st.innerHTML = '<span style="color:var(--red)">CSV에서 날짜·PER 열을 찾지 못했습니다. (헤더에 PER/PBR, 날짜 열 필요)</span>'; return; }
      mergeValHistory(all);   // 여러 파일의 분기말 PER/PBR을 라벨 기준으로 병합(중복은 나중 값)
      st.innerHTML = 'CSV ' + files.length + '개에서 <b>' + all.length + '개</b> 분기말 PER/PBR을 불러와 병합했습니다.';
    });
  }

  // valuationHistory 병합(라벨 기준 dedup) + 정렬
  function mergeValHistory(items) {
    var byLabel = {};
    (state.valuationHistory || []).forEach(function (h) { if (h.label) byLabel[h.label] = h; });
    items.forEach(function (it) {
      if (it.label == null || it.label === '') return;
      if (numOrNull(it.per) == null && numOrNull(it.pbr) == null) return;
      byLabel[it.label] = { label: it.label, per: numOrNull(it.per), pbr: numOrNull(it.pbr) };
    });
    state.valuationHistory = Object.keys(byLabel).map(function (k) { return byLabel[k]; }).sort(function (a, b) { return vhKey(a.label) - vhKey(b.label); });
    autofillBandToValuation();   // 밴드 → 밸류에이션(과거 PER/PBR 밴드·목표배수) 자동 반영
    renderValHistory(); refresh();
    return state.valuationHistory.length;
  }

  // 역사적 PER/PBR 밴드가 형성되면 밸류에이션 입력(과거 밴드·목표 배수)을 자동으로 채워 즉시 연계.
  function autofillBandToValuation() {
    var pb = V.computeBand(state.valuationHistory, 'per');
    var xb = V.computeBand(state.valuationHistory, 'pbr');
    if (pb) {
      state.valuation.perBand = { low: round2(pb.min), avg: round2(pb.median), high: round2(pb.max) };
      state.valuation.targetPer = round2(pb.median);
    }
    if (xb) {
      state.valuation.pbrBand = { low: round2(xb.min), avg: round2(xb.median), high: round2(xb.max) };
      state.valuation.targetPbr = round2(xb.median);
    }
    if (pb || xb) syncFormFromState();
  }
  function vhKey(label) { var y = V.fullYear(label) || '0'; var q = V.quarterNo(label) || 4; return (+y) * 10 + q; }

  // KRX 등 CSV → 분기말 PER/PBR. 헤더의 'PER'/'PBR'(ASCII)와 날짜 패턴으로 열 자동 인식.
  function parseHistoryCsv(text) {
    var lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return [];
    var header = parseCsvLine(lines[0]).map(function (s) { return s.trim(); });
    function findCol(pred) { for (var i = 0; i < header.length; i++) if (pred(header[i])) return i; return -1; }
    var perCol = findCol(function (h) { return h.toUpperCase() === 'PER'; });
    if (perCol < 0) perCol = findCol(function (h) { return /PER/i.test(h) && !/선행|forward|f\.?per/i.test(h); });
    var pbrCol = findCol(function (h) { return h.toUpperCase() === 'PBR'; });
    if (pbrCol < 0) pbrCol = findCol(function (h) { return /PBR/i.test(h); });
    // 날짜 열: 첫 데이터행에서 날짜 형태인 열
    var sample = parseCsvLine(lines[1]), dateCol = -1;
    for (var i = 0; i < sample.length; i++) {
      var s = (sample[i] || '').replace(/"/g, '');
      if (/\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}/.test(s) || /^\d{8}$/.test(s.replace(/\D/g, ''))) { dateCol = i; break; }
    }
    if (perCol < 0 || dateCol < 0) return [];
    var byQ = {};
    for (var r = 1; r < lines.length; r++) {
      var c = parseCsvLine(lines[r]); if (c.length <= perCol) continue;
      var d = parseCsvDate(c[dateCol]); if (!d) continue;
      var per = numOrNull((c[perCol] || '').replace(/["',\s]/g, ''));
      var pbr = pbrCol >= 0 ? numOrNull((c[pbrCol] || '').replace(/["',\s]/g, '')) : null;
      if (per == null && pbr == null) continue;
      var qn = Math.ceil(d.m / 3), key = d.y + '-' + qn, prev = byQ[key];
      if (!prev || d.iso > prev.iso) byQ[key] = { iso: d.iso, y: d.y, qn: qn, per: per, pbr: pbr, sort: d.y * 10 + qn };
    }
    return Object.keys(byQ).map(function (k) { return byQ[k]; }).sort(function (a, b) { return a.sort - b.sort; })
      .map(function (x) { return { label: (x.y % 100) + '.' + x.qn + 'q', per: x.per, pbr: x.pbr }; });
  }
  function parseCsvLine(line) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else { if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
    }
    out.push(cur); return out;
  }
  function parseCsvDate(s) {
    if (!s) return null; s = String(s).replace(/"/g, '');
    var m = s.match(/(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
    if (m) return { y: +m[1], m: +m[2], iso: m[1] + p2(m[2]) + p2(m[3]) };
    var d = s.replace(/\D/g, '');
    if (/^\d{8}$/.test(d)) return { y: +d.slice(0, 4), m: +d.slice(4, 6), iso: d };
    return null;
  }

  function fetchNaver(code) {
    var worker = getProxyUrl();
    if (worker) {
      var wurl = worker.replace(/\/+$/, '') + (worker.indexOf('?') > -1 ? '&' : '?') + 'code=' + code;
      return fetchWithTimeout(wurl, 8000).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          if (j.error) throw new Error(j.error);
          if (j.price == null && j.shares == null) throw new Error('빈 응답');
          return { price: numOrNull(j.price), shares: numOrNull(j.shares), name: j.name };
        }).catch(function () { return fetchNaverPublic(code); });
    }
    return fetchNaverPublic(code);
  }

  function fetchNaverPublic(code) {
    var api = 'https://m.stock.naver.com/api/stock/' + code + '/integration';
    var proxies = [
      function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
      function (u) { return 'https://corsproxy.io/?url=' + encodeURIComponent(u); },
      function (u) { return 'https://thingproxy.freeboard.io/fetch/' + u; }
    ];
    var idx = 0;
    function attempt() {
      if (idx >= proxies.length) return Promise.reject(new Error('CORS 프록시 응답 없음(네트워크/프록시 제한)'));
      var url = proxies[idx++](api);
      return fetchWithTimeout(url, 6000).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (t) {
          var price = null, shares = null;
          var mp = t.match(/"closePrice"\s*:\s*"?([\d,]+)"?/);
          if (mp) price = numOrNull(mp[1].replace(/,/g, ''));
          var ms = t.match(/"listedStockCnt"\s*:\s*"?([\d,]+)"?/) || t.match(/상장주식수[^\d]*([\d,]+)/);
          if (ms) shares = numOrNull(ms[1].replace(/,/g, ''));
          if (price == null && shares == null) throw new Error('가격 필드 파싱 실패');
          return { price: price, shares: shares };
        }).catch(function () { return attempt(); });
    }
    return attempt();
  }

  /* =========================================================================
   * 수기 입력 필요 항목 체크리스트
   * ========================================================================= */
  function renderChecklist(c, val) {
    var box = document.getElementById('checklist'); if (!box) return;
    var items = [];
    function chk(ok, label, note) { items.push({ ok: ok, label: label, note: note }); }
    var v = c.valuation || {};
    chk(numOrNull(v.price) != null, '현재 주가', '네이버 버튼 또는 수기');
    chk(numOrNull(v.shares) != null, '발행주식수', 'OpenDART 자동 · PDF · 네이버(추정)');
    chk((c.valuationHistory || []).length >= 3, '역사적 PER (밴드용)', '네이버 자동조회 · KRX CSV 업로드 · 수기');
    chk(numOrNull(v.equity) != null, '자본총계 (ROE·PBR용)', 'OpenDART 자동 · PDF');
    var q = c.quarters || [];
    chk(q.length >= 4, '분기 실적 4개 이상', 'OpenDART 자동 · PDF 업로드');
    chk(q.some(function (x) { return numOrNull(x.netIncome) != null; }), '순이익(PER·ROE용)', 'OpenDART 자동 · PDF');
    chk(val.epsGrowth != null, 'EPS 성장률 (PEG용)', '연간 순이익 2년 이상 자동 · 예상치 수기');
    chk(numOrNull(v.dps) != null, '주당배당금 (배당 앵커)', 'OpenDART 자동(사업보고서) · 수기');
    chk((c.commentary || []).length > 0, '해설/코멘트', '정성 분석 — 수기');
    chk(numOrNull(v.targetPer) != null || (c.valuationHistory || []).length >= 3, '목표배수/밴드', '목표 PER 또는 역사적 밴드');

    var done = items.filter(function (i) { return i.ok; }).length;
    box.innerHTML = '<div class="section" style="margin-top:16px"><h3>입력 상태 (' + done + '/' + items.length + ')</h3>' +
      '<p class="hint">DART PDF·네이버로 자동 채워지는 항목과, 그래도 <b>직접 입력</b>해야 하는 항목입니다.</p>' +
      items.map(function (i) {
        return '<div class="check-row ' + (i.ok ? 'ok' : 'todo') + '"><span class="chk">' + (i.ok ? '✓' : '○') + '</span>' +
          '<span class="chk-label">' + esc(i.label) + '</span><span class="chk-note">' + esc(i.note) + '</span></div>';
      }).join('') + '</div>';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
