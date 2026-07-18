/* =============================================================================
 * store.js — 공유 저장소 클라이언트 (Cloudflare Worker KV)
 * -----------------------------------------------------------------------------
 * 여러 사람이 분석한 기업을 워커 KV에 저장·공유합니다.
 *   URL: localStorage 오버라이드 > config.js(SITE_CONFIG.sharedUrl)
 *   비밀번호: 브라우저별 localStorage (친구마다 1회 입력)
 * 엔드포인트(워커): ?store=list | save | delete | corpmap  (+ &key=비밀번호)
 * =========================================================================== */
(function (global) {
  'use strict';
  var URL_LS = 'companyAnalysis.storeUrl';
  var KEY_LS = 'companyAnalysis.storeKey';

  function ls(k) { try { return (localStorage.getItem(k) || '').trim(); } catch (e) { return ''; } }
  function cfgUrl() {
    var u = ls(URL_LS);
    if (!u) u = ((global.SITE_CONFIG && global.SITE_CONFIG.sharedUrl) || '').trim();
    return u.replace(/\/+$/, '');
  }
  function getKey() { return ls(KEY_LS); }
  function setKey(k) { try { localStorage.setItem(KEY_LS, (k || '').trim()); } catch (e) {} }
  function setUrl(u) { try { localStorage.setItem(URL_LS, (u || '').trim()); } catch (e) {} }
  function enabled() { return !!(cfgUrl() && getKey()); }

  function call(action, body) {
    var u = cfgUrl() + '?store=' + action + '&key=' + encodeURIComponent(getKey());
    var opts = body != null
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {};
    return fetch(u, opts).then(function (r) {
      return r.json()
        .catch(function () { throw new Error('공유 서버 응답 오류 (HTTP ' + r.status + ')'); })
        .then(function (j) {
          if (!r.ok || (j && j.error)) throw new Error((j && j.error) || ('HTTP ' + r.status));
          return j;
        });
    });
  }

  global.Store = {
    url: cfgUrl, setUrl: setUrl, key: getKey, setKey: setKey, enabled: enabled,
    list: function () { return call('list').then(function (j) { return j.companies || {}; }); },
    save: function (c) { return call('save', c); },
    remove: function (id) { return call('delete', { id: id }); },
    corpmapGet: function () { return call('corpmap'); },
    corpmapPut: function (map) { return call('corpmap', map); },
    triggersGet: function () { return call('triggers'); },
    triggersPut: function (obj) { return call('triggers', obj); }
  };
})(window);
