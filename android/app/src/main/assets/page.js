// SureBrowser sayfa betiği (her belgenin başında, yalıtılmış değil; yalnızca SBPass mesaj kanalını kullanır)
(function () {
  if (window.__sbInstalled) return; window.__sbInstalled = true;
  // WebRTC kapalı: gerçek IP STUN üzerinden sızmasın
  ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceGatherer'].forEach(function (k) {
    try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  });
  if (top !== window || typeof SBPass === 'undefined') return;

  var USER = { text: 1, email: 1, tel: 1, '': 1 };
  function visible(el) {
    if (!el || el.disabled || el.readOnly) return false;
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function pwFields(root) { return Array.prototype.filter.call((root || document).querySelectorAll('input[type="password"]'), visible); }
  function userFor(pw) {
    var scope = pw.form || document, best = null;
    Array.prototype.forEach.call(scope.querySelectorAll('input'), function (i) {
      if (visible(i) && USER[(i.getAttribute('type') || '').toLowerCase()] && (i.compareDocumentPosition(pw) & 4)) best = i;
    });
    return best || document.querySelector('input[autocomplete="username"],input[name*="user" i],input[name*="mail" i],input[id*="user" i],input[id*="mail" i]');
  }
  var lastUser = '', lastSent = '';
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.tagName === 'INPUT' && USER[(t.getAttribute('type') || '').toLowerCase()] && t.value &&
        (/user|mail|login|phone|tel|account|hesap|kullan/i.test((t.getAttribute('autocomplete') || '') + t.name + t.id) || t.type === 'email')) lastUser = t.value;
  }, true);
  function capture(pwEl) {
    var pw = pwEl && pwEl.value ? pwEl : pwFields().filter(function (p) { return p.value; })[0];
    if (!pw) return;
    var all = pwFields(pw.form || document).filter(function (p) { return p.value; });
    var chosen = all.length >= 2 ? all[all.length - 1] : pw;
    var u = userFor(pw), user = (u && u.value) || lastUser || '';
    var key = user + '\u0000' + chosen.value;
    if (key === lastSent) return; lastSent = key;
    SBPass.postMessage(JSON.stringify({ t: 'cap', u: user, p: chosen.value }));
  }
  document.addEventListener('submit', function (e) { var p = pwFields(e.target).filter(function (x) { return x.value; })[0]; if (p) capture(p); }, true);
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button,input[type="submit"],[role="button"]'); if (!b) return;
    var p = pwFields(b.form || b.closest('form') || document).filter(function (x) { return x.value; })[0];
    if (p) setTimeout(function () { capture(p); }, 0);
  }, true);
  document.addEventListener('keydown', function (e) { var t = e.target; if (e.key === 'Enter' && t && t.type === 'password' && t.value) capture(t); }, true);
  window.addEventListener('pagehide', function () { capture(); });

  // Otomatik doldurma
  var creds = null, asked = false, filled = new WeakSet();
  function setVal(el, v) {
    var s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function fill() {
    var pws = pwFields().filter(function (p) { return !p.value && !filled.has(p) && (p.getAttribute('autocomplete') || '') !== 'new-password'; });
    if (!pws.length) return;
    if (creds === null) { if (!asked) { asked = true; SBPass.postMessage(JSON.stringify({ t: 'get' })); } return; }
    if (!creds.length) return;
    pws.forEach(function (pw) {
      var u = userFor(pw), c = creds[0];
      if (u && u.value) c = creds.filter(function (x) { return x.username === u.value; })[0];
      if (!c) return;
      if (u && !u.value && c.username) setVal(u, c.username);
      setVal(pw, c.password); filled.add(pw);
    });
  }
  SBPass.onmessage = function (e) { try { creds = JSON.parse(e.data); } catch (x) { creds = []; } fill(); };
  var timer = null;
  function schedule() { clearTimeout(timer); timer = setTimeout(fill, 250); }
  document.addEventListener('DOMContentLoaded', function () {
    schedule();
    var mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { mo.disconnect(); }, 20000);
  });
})();
