// Web sayfalarında çalışan yalıtılmış betik: şifre yakalama ve otomatik doldurma.
// Sayfanın kendi JavaScript'i bu betiğe ve ipcRenderer'a erişemez (contextIsolation).
const { ipcRenderer } = require('electron');

const visible = (el) => {
  if (!el || el.disabled || el.readOnly) return false;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
};
const USER_TYPES = new Set(['text', 'email', 'tel', '']);

function passwordFields(root = document) {
  return [...root.querySelectorAll('input[type="password"]')].filter(visible);
}

// Şifre alanından önce gelen en yakın görünür kullanıcı adı alanı
function usernameFor(pw) {
  const scope = pw.form || document;
  const inputs = [...scope.querySelectorAll('input')].filter((i) => visible(i) && USER_TYPES.has((i.getAttribute('type') || '').toLowerCase()));
  let best = null;
  for (const i of inputs) {
    if (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) best = i;
  }
  if (!best) {
    // Bazı siteler kullanıcı adını önceki adımda ister
    best = document.querySelector('input[autocomplete="username"], input[name*="user" i], input[name*="mail" i], input[id*="user" i], input[id*="mail" i]');
  }
  return best;
}

let lastSent = '';
let lastUser = '';
function capture(pwEl) {
  const pws = pwEl ? [pwEl] : passwordFields();
  const pw = pws.find((p) => p.value);
  if (!pw) return;
  // Yeni şifre formunda (iki şifre alanı) ilkini değil, yeni olanı kaydet
  const all = passwordFields(pw.form || document).filter((p) => p.value);
  const chosen = all.length >= 2 ? all[all.length - 1] : pw;
  const userEl = usernameFor(pw);
  const username = (userEl && userEl.value) || lastUser || '';
  const key = username + '\u0000' + chosen.value;
  if (key === lastSent) return;
  lastSent = key;
  ipcRenderer.send('pw:capture', { origin: location.origin, username, password: chosen.value });
}

// Kullanıcı adını hatırla (iki adımlı girişler için)
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && USER_TYPES.has((t.getAttribute('type') || '').toLowerCase()) && t.value) {
    const ac = (t.getAttribute('autocomplete') || '') + t.name + t.id;
    if (/user|mail|login|phone|tel|account|hesap|kullan/i.test(ac) || t.type === 'email') lastUser = t.value;
  }
}, true);

document.addEventListener('submit', (e) => {
  const pw = passwordFields(e.target).find((p) => p.value);
  if (pw) capture(pw);
}, true);

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button, input[type="submit"], [role="button"]');
  if (!b) return;
  const scope = b.form || b.closest('form') || document;
  const pw = passwordFields(scope).find((p) => p.value);
  if (pw) setTimeout(() => capture(pw), 0);
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'password' && e.target.value) capture(e.target);
}, true);

// Sayfa giriş sonrası başka yere giderken son bir kez dene
window.addEventListener('pagehide', () => capture());

/* ---------- Otomatik doldurma ---------- */

const setValue = (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

let creds = null;
let filled = new WeakSet();
async function fill() {
  const pws = passwordFields().filter((p) => !p.value && !filled.has(p));
  if (!pws.length) return;
  if (creds === null) creds = await ipcRenderer.invoke('pw:get');
  if (!creds || !creds.length) return;
  for (const pw of pws) {
    // Yeni şifre / kayıt formlarına dokunma
    const ac = (pw.getAttribute('autocomplete') || '').toLowerCase();
    if (ac === 'new-password') continue;
    const userEl = usernameFor(pw);
    let c = creds[0];
    if (userEl && userEl.value) c = creds.find((x) => x.username === userEl.value) || null;
    if (!c) continue;
    if (userEl && !userEl.value && c.username) setValue(userEl, c.username);
    setValue(pw, c.password);
    filled.add(pw);
    ipcRenderer.send('pw:filled', { username: c.username });
  }
}

let timer = null;
const schedule = () => { clearTimeout(timer); timer = setTimeout(fill, 250); };
window.addEventListener('DOMContentLoaded', () => {
  schedule();
  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 20000); // geç yüklenen giriş formları için 20 sn izle
});
ipcRenderer.on('pw:refill', () => { creds = null; filled = new WeakSet(); schedule(); });
