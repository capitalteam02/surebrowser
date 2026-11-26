const {
  app, BrowserWindow, WebContentsView, session, ipcMain, Menu, clipboard,
  dialog, safeStorage, nativeImage, screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ProxyBridge, checkProxy } = require('./proxy-bridge');
const updater = require('./updater');

/*
 * Model
 * - Havuz: sınırsız proxy. Her biri denetlenince ülkesi (cc) ve çıkış IP'si öğrenilir.
 * - Kimlik = ülke + renk (ör. "TR:red"). Her ülkenin 10 rengi var.
 *   Kimliğin çerezleri, önbelleği, site verileri ve kayıtlı şifreleri kalıcıdır ve diskte tutulur.
 *   Kimliğin IP'si çökerse aynı ülkeden yeni IP gelir; hafıza aynı kalır.
 * - Bir kimlik aynı anda tek sekmede açıktır; iki kimlik aynı çıkış IP'sini paylaşmaz.
 * - Uygulama kapanırken sekmeler, sıraları, geçmişleri ve etkin sekme kaydedilir; açılışta geri gelir.
 */

const TOP_H = 118;      // renderer/styles.css --group-h + --tab-h + --nav-h
const BOTTOM_H = 30;    // renderer/styles.css --status-h
const DRAWER_W = 420;   // renderer/styles.css --drawer-w

const COLORS = [
  { key: 'red', name: 'Kırmızı', hex: '#e5484d' },
  { key: 'orange', name: 'Turuncu', hex: '#f76b15' },
  { key: 'yellow', name: 'Sarı', hex: '#ffc53d' },
  { key: 'green', name: 'Yeşil', hex: '#30a46c' },
  { key: 'teal', name: 'Turkuaz', hex: '#12a594' },
  { key: 'blue', name: 'Mavi', hex: '#0090ff' },
  { key: 'navy', name: 'Lacivert', hex: '#3e63dd' },
  { key: 'purple', name: 'Mor', hex: '#8e4ec6' },
  { key: 'pink', name: 'Pembe', hex: '#d6409f' },
  { key: 'brown', name: 'Kahverengi', hex: '#a07553' },
];
const colorOf = (k) => COLORS.find((c) => c.key === k);
const UNKNOWN_CC = 'XX';
const regionNames = new Intl.DisplayNames(['tr'], { type: 'region' });
const countryName = (cc) => (cc === UNKNOWN_CC ? 'Ülkesi bilinmeyen' : (() => { try { return regionNames.of(cc); } catch { return cc; } })());

const slotKey = (cc, color) => `${cc}:${color}`;
const parseSlot = (k) => { const [cc, color] = String(k).split(':'); return { cc, color }; };
const slotLabel = (k) => { const { cc, color } = parseSlot(k); return `${countryName(cc)} · ${colorOf(color).name}`; };
const ccOf = (p) => (p.cc || UNKNOWN_CC).toUpperCase();

const HEALTH_EVERY_MS = Number(process.env.PT_HEALTH_MS) || 60 * 1000;   // açık sekmelerin IP'leri
const POOL_EVERY_MS = Number(process.env.PT_POOL_MS) || 20 * 60 * 1000;  // tüm havuz
const FRESH_MS = 2 * 60 * 1000;
const POOL_CONCURRENCY = 20;
const HISTORY_KEEP = 50;
const BLOCKED = { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>' };
const PROXY_ERRORS = new Set([-130, -111, -115, -127, -120, -121, -122, -123, -124, -125, -129, -336, -118, -101, -100, -102, -21]);

const CHROME_UA = (() => {
  const v = process.versions.chrome.split('.')[0];
  const os = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
})();
app.setName('SureBrowser');
app.userAgentFallback = CHROME_UA;
if (process.env.PT_USER_DATA) app.setPath('userData', process.env.PT_USER_DATA);

/* ---------------- Kalıcı veri ---------------- */

const storeFile = () => path.join(app.getPath('userData'), 'surebrowser.json');
let store = {
  version: 3, proxies: [], slots: {}, windows: [], passwords: [], neverSave: [], used: [],
  settings: { search: 'duckduckgo', savePasswords: true, autofill: true },
};

const encrypt = (s) => (s && safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : s || '');
const decrypt = (s) => {
  if (!s || !s.startsWith('enc:')) return s || '';
  try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch { return ''; }
};

function loadStore() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { return; }
  const v3 = raw.version === 3;
  store = {
    version: 3,
    proxies: (raw.proxies || []).map((p) => ({
      id: p.id, type: p.type, host: p.host, port: p.port, username: p.username || '', password: decrypt(p.password),
      note: p.note || '', color: p.color || null, status: ['ok', 'dead'].includes(p.status) ? p.status : 'unknown',
      exitIp: p.exitIp || '', cc: p.cc || '', country: p.country || '', city: p.city || '', ms: p.ms || 0, err: p.err || '', checkedAt: p.checkedAt || 0,
    })),
    slots: v3 ? (raw.slots || {}) : {},
    // Eski kayıt (tek pencere) → pencere listesi
    windows: v3 ? (raw.windows || (raw.tabs && raw.tabs.length ? [{ id: uid(), tabs: raw.tabs, activeTabId: raw.activeTabId }] : [])) : [],
    passwords: (raw.passwords || []).map((x) => ({ ...x, password: decrypt(x.password) })),
    neverSave: raw.neverSave || [],
    used: v3 ? (raw.used || []) : [],
    settings: { ...store.settings, ...(raw.settings || {}) },
  };
}

function tabHistory(t) {
  if (!t.view) return t.history || null;
  try {
    const nh = t.view.webContents.navigationHistory;
    let entries = nh.getAllEntries().filter((e) => e.url && !e.url.startsWith('data:'));
    let index = nh.getActiveIndex();
    if (!entries.length) return t.history || null;
    const cut = Math.max(0, entries.length - HISTORY_KEEP);
    entries = entries.slice(cut); index = Math.max(0, Math.min(entries.length - 1, index - cut));
    return { entries: entries.map((e) => ({ url: e.url, title: e.title || '', pageState: e.pageState })), index };
  } catch { return t.history || null; }
}

let saveTimer = null;
function saveStore() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 600); }
function saveNow() {
  clearTimeout(saveTimer);
  if (quitting) return; // kapanış sırasında sekme geçmişi okunamaz; son kayıt geçerli
  const data = {
    ...store,
    proxies: store.proxies.map((p) => ({ ...p, password: encrypt(p.password) })),
    passwords: store.passwords.map((x) => ({ ...x, password: encrypt(x.password) })),
    windows: [...wins.values()].filter((W) => !W.win.isDestroyed()).map((W) => ({
      id: W.id,
      bounds: W.win.getNormalBounds(),
      maximized: W.win.isMaximized(),
      groups: W.groups.map((g) => ({ id: g.id, name: g.name, tabIds: g.tabIds.slice() })),
      gridGroupId: W.gridGroupId,
      activeTabId: W.activeTabId,
      tabs: tabsOf(W).map((t) => ({ id: t.id, slot: t.slot, url: t.url, title: t.title, history: tabHistory(t) })),
    })).filter((w) => w.tabs.length),
  };
  delete data.tabs; delete data.activeTabId;
  try {
    const f = storeFile();
    fs.writeFileSync(f + '.tmp', JSON.stringify(data));
    fs.renameSync(f + '.tmp', f); // yarım yazılmış dosya kalmasın
  } catch (e) { console.error(e); }
}

const uid = () => crypto.randomBytes(5).toString('hex');

/* ---------------- Proxy satırı ayrıştırma ---------------- */

function parseProxyLine(line, defType = 'http') {
  let s = line.trim();
  if (!s || s.startsWith('#')) return null;
  let type = defType;
  let note = '';
  if (s.includes('|')) { const i = s.indexOf('|'); note = s.slice(0, i).trim(); s = s.slice(i + 1).trim(); }
  const m = /^(https?|socks5h?|socks4a?|socks):\/\//i.exec(s);
  if (m) {
    type = m[1].toLowerCase().replace('socks5h', 'socks5').replace('socks4a', 'socks4');
    if (type === 'socks') type = 'socks5';
    s = s.slice(m[0].length);
  }
  let host, port, username = '', password = '';
  if (s.includes('@')) {
    const at = s.lastIndexOf('@');
    const cred = s.slice(0, at); const hp = s.slice(at + 1);
    const ci = cred.indexOf(':');
    username = ci === -1 ? cred : cred.slice(0, ci);
    password = ci === -1 ? '' : cred.slice(ci + 1);
    [host, port] = hp.split(':');
  } else {
    const parts = s.split(':');
    if (parts.length >= 4) { [host, port, username] = parts; password = parts.slice(3).join(':'); } else [host, port] = parts;
  }
  try { username = decodeURIComponent(username); password = decodeURIComponent(password); } catch { /* yoksay */ }
  port = parseInt(port, 10);
  if (!host || !port || port < 1 || port > 65535) return null;
  return {
    id: uid(), type, host, port, username, password, note, color: null,
    status: 'unknown', exitIp: '', cc: '', country: '', city: '', ms: 0, err: '', checkedAt: 0,
  };
}

/* ---------------- Yardımcılar ---------------- */

const getProxy = (id) => store.proxies.find((p) => p.id === id);
const slotProxy = (key) => getProxy(store.slots[key]);
const slotOfProxy = (pid) => Object.keys(store.slots).find((k) => store.slots[k] === pid) || null;
const tabOnSlot = (key) => tabs.find((t) => t.slot === key);
const tabsOnSlot = (key) => tabs.filter((t) => t.slot === key);
const proxyKey = (p) => `${p.type}://${p.username}@${p.host}:${p.port}`;

let notice = null;
function notify(text, kind = 'info') { notice = { text, kind, at: Date.now() }; pushState(); }

let chain = Promise.resolve();
const serial = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

// Ülke → { ok, dead, unknown }
function countryStats() {
  const m = new Map();
  for (const p of store.proxies) {
    if (p.status === 'unknown' || p.status === 'checking') continue;
    const cc = ccOf(p);
    if (!m.has(cc)) m.set(cc, { ok: 0, dead: 0 });
    m.get(cc)[p.status === 'ok' ? 'ok' : 'dead']++;
  }
  for (const t of tabs) if (t.slot) { const { cc } = parseSlot(t.slot); if (!m.has(cc)) m.set(cc, { ok: 0, dead: 0 }); }
  return m;
}
function activeCountries() {
  const m = countryStats();
  return [...m.entries()].filter(([cc, s]) => s.ok > 0 || tabs.some((t) => t.slot && parseSlot(t.slot).cc === cc))
    .map(([cc, s]) => ({ cc, name: countryName(cc), ok: s.ok, dead: s.dead }))
    .sort((a, b) => (a.cc === 'TR' ? -1 : b.cc === 'TR' ? 1 : 0) || (a.cc === UNKNOWN_CC) - (b.cc === UNKNOWN_CC) || b.ok - a.ok || a.name.localeCompare(b.name, 'tr'));
}
const allSlotKeys = () => activeCountries().flatMap((c) => COLORS.map((col) => slotKey(c.cc, col.key)));

/* ---------------- Sağlık kontrolü ---------------- */

const checking = new Map();
function checkOne(p, { retry = true } = {}) {
  if (checking.has(p.id)) return checking.get(p.id);
  const run = (async () => {
    const prev = p.status;
    p.status = 'checking'; pushState();
    let r = await checkProxy(p);
    if (!r.ok && retry) { await new Promise((res) => setTimeout(res, 1500)); r = await checkProxy(p); }
    p.checkedAt = Date.now();
    p.ms = r.ms;
    if (r.ok) {
      Object.assign(p, { status: 'ok', exitIp: r.ip, err: '' });
      if (r.cc) Object.assign(p, { cc: r.cc.toUpperCase(), country: r.country, city: r.city || '' });
    } else Object.assign(p, { status: 'dead', err: r.err });
    if (prev !== p.status) saveStore();
    pushState();
    return r;
  })();
  checking.set(p.id, run);
  run.finally(() => checking.delete(p.id));
  return run;
}

function checkPool(list) {
  const queue = list.slice();
  let active = 0;
  return new Promise((resolve) => {
    const next = () => {
      while (active < POOL_CONCURRENCY && queue.length) {
        const p = queue.shift();
        const k = getProxy(p.id) && slotOfProxy(p.id);
        if (!getProxy(p.id) || (k && tabOnSlot(k))) continue; // açık sekmedekiler sağlık döngüsünde
        active++;
        checkOne(p, { retry: false }).finally(() => { active--; next(); });
      }
      if (!queue.length && !active) resolve();
    };
    next();
  });
}

function usedExitIps(exceptKey) {
  const ips = new Set();
  for (const [k, pid] of Object.entries(store.slots)) {
    if (k === exceptKey) continue;
    const p = getProxy(pid);
    if (p && p.exitIp) ips.add(p.exitIp);
  }
  return ips;
}

/* ---------------- Kimlik yuvaları ---------------- */

const reserved = new Set();
function candidatesFor(key) {
  const { cc, color } = parseSlot(key);
  const inSlot = new Set(Object.values(store.slots));
  const busy = usedExitIps(key);
  const ok = (p) => p.status === 'ok' && ccOf(p) === cc && !inSlot.has(p.id) && !reserved.has(p.id) && !busy.has(p.exitIp);
  return [
    ...store.proxies.filter((p) => p.color === color && ok(p)),
    ...store.proxies.filter((p) => !p.color && ok(p)),
  ];
}

// verify: açmadan hemen önce IP'yi canlı denetle
async function fillSlot(key, { verify = false } = {}) {
  const { cc } = parseSlot(key);
  const skip = new Set();
  for (let i = 0; i < 40; i++) {
    const cand = candidatesFor(key).find((p) => !skip.has(p.id));
    if (!cand) { delete store.slots[key]; pushState(); return null; }
    skip.add(cand.id);
    reserved.add(cand.id);
    try {
      if (verify && Date.now() - cand.checkedAt > FRESH_MS) await checkOne(cand);
      if (cand.status === 'ok' && ccOf(cand) === cc && getProxy(cand.id) && !usedExitIps(key).has(cand.exitIp)) {
        store.slots[key] = cand.id;
        saveStore(); pushState();
        return cand;
      }
    } finally { reserved.delete(cand.id); }
  }
  return null;
}

function slotIsBad(key, p, { openTab }) {
  const { cc, color } = parseSlot(key);
  if (!p || p.status !== 'ok' || ccOf(p) !== cc || usedExitIps(key).has(p.exitIp)) return true;
  return !openTab && p.color && p.color !== color;
}

// Kimliğin IP'sini doğrular; bozuksa aynı ülkeden yenisini o kimliğin tüm sekmelerine bağlar (hafıza aynı kalır)
async function ensureSlot(key, { force = false } = {}) {
  let p = slotProxy(key);
  if (p && p.status !== 'dead' && (force || Date.now() - p.checkedAt > FRESH_MS)) await checkOne(p);
  p = slotProxy(key);
  const ts = tabsOnSlot(key);
  if (!slotIsBad(key, p, { openTab: ts.length > 0 })) {
    for (const t of ts) if (t.proxyId !== p.id) await setTabProxy(t, p);
    return p;
  }
  const old = p;
  delete store.slots[key];
  const fresh = await fillSlot(key, { verify: true });
  for (const t of tabsOnSlot(key)) await setTabProxy(t, fresh);
  if (ts.length) {
    if (fresh && old) notify(`${slotLabel(key)}: ${old.exitIp || old.host} çöktü, yerine ${fresh.exitIp} geldi. Oturum korunuyor.`, 'warn');
    if (!fresh) notify(`${slotLabel(key)}: bu ülkede kullanılabilir IP kalmadı, sekmeler engellendi`, 'error');
  }
  return fresh;
}

let rebalancing = null;
function rebalance() {
  if (rebalancing) { rebalancing.again = true; return rebalancing.p; }
  const state = { again: false };
  state.p = serial(async () => {
    const keys = new Set(allSlotKeys());
    // Ülkesi artık aktif olmayan, sekmesi de olmayan yuvaları bırak
    for (const k of Object.keys(store.slots)) if (!keys.has(k) && !tabOnSlot(k)) delete store.slots[k];
    await Promise.all([...keys].map(async (key) => {
      const cur = slotProxy(key);
      const ts = tabsOnSlot(key);
      if (ts.length) {
        if (slotIsBad(key, cur, { openTab: true }) || ts.some((t) => !t.proxyId)) await ensureSlot(key);
        return;
      }
      const { color } = parseSlot(key);
      const betterTagged = cur && !cur.color && store.proxies.some((p) => p.color === color && p.status === 'ok' && ccOf(p) === ccOf(cur) && !slotOfProxy(p.id));
      if (slotIsBad(key, cur, { openTab: false }) || betterTagged) {
        delete store.slots[key];
        await fillSlot(key);
      }
    }));
    pruneBridges();
    saveStore(); pushState();
  }).finally(() => {
    rebalancing = null;
    if (state.again) rebalance();
  });
  rebalancing = state;
  return state.p;
}

async function healthTick() {
  await serial(async () => {
    const keys = [...new Set(tabs.filter((t) => t.slot).map((t) => t.slot))];
    await Promise.all(keys.map(async (key) => {
      const p = slotProxy(key);
      if (p) await checkOne(p);
      if (slotIsBad(key, slotProxy(key), { openTab: true })) await ensureSlot(key);
    }));
  });
  rebalance();
}

let poolRun = null;
function poolTick() {
  if (poolRun) return poolRun;
  poolRun = checkPool(store.proxies.filter((p) => p.status !== 'dead')).then(rebalance).finally(() => { poolRun = null; });
  return poolRun;
}

/* ---------------- Oturumlar ve proxy köprüleri ---------------- */

const bridges = new Map();
async function proxyConfig(p) {
  if (!p) return BLOCKED;
  if (p.username) {
    const k = proxyKey(p) + p.password;
    let b = bridges.get(p.id);
    if (b && b.key !== k) { b.bridge.stop(); bridges.delete(p.id); b = null; }
    if (!b) {
      const bridge = new ProxyBridge({ ...p });
      try { await bridge.start(); } catch { return BLOCKED; }
      b = { bridge, key: k };
      bridges.set(p.id, b);
    }
    return { mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${b.bridge.port}`, proxyBypassRules: '<-loopback>' };
  }
  const scheme = { socks5: 'socks5', socks4: 'socks4', https: 'https' }[p.type] || 'http';
  return { mode: 'fixed_servers', proxyRules: `${scheme}://${p.host}:${p.port}`, proxyBypassRules: '<-loopback>' };
}
function pruneBridges() {
  const used = new Set(tabs.map((t) => t.proxyId).filter(Boolean));
  for (const [pid, b] of bridges) if (!used.has(pid)) { b.bridge.stop(); bridges.delete(pid); }
}

const prepared = new WeakSet();
function uniqueDownloadPath(name) {
  const dir = app.getPath('downloads');
  const ext = path.extname(name); const base = path.basename(name, ext) || 'indirme';
  let f = path.join(dir, base + ext);
  for (let i = 1; fs.existsSync(f); i++) f = path.join(dir, `${base} (${i})${ext}`);
  return f;
}
function prepareSession(ses) {
  if (prepared.has(ses)) return;
  prepared.add(ses);
  ses.setUserAgent(CHROME_UA);
  // İzin sorusu yok: siteler istediği izni alır
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  ses.setPermissionCheckHandler(() => true);
  ses.setDevicePermissionHandler(() => true);
  // İndirmeler sormadan İndirilenler klasörüne
  ses.on('will-download', (_e, item) => {
    const f = uniqueDownloadPath(item.getFilename());
    item.setSavePath(f);
    notify(`İndiriliyor: ${path.basename(f)}`, 'info');
    item.once('done', (_e2, state) => notify(state === 'completed' ? `İndirildi: ${path.basename(f)} (İndirilenler)` : `İndirme tamamlanamadı: ${path.basename(f)}`, state === 'completed' ? 'info' : 'error'));
  });
}

/* ---------------- Pencereler ve sekmeler ---------------- */

const TILE_HEAD = 36;   // ızgara görünümünde döşeme başlığı + adres çubuğu (renderer/styles.css .tile-head)
const TILE_PAD = 3;
const TILE_GAP = 6;

const wins = new Map();  // pencere id → W
let tabs = [];           // tüm pencerelerin sekmeleri; pencere içi sıra = bu dizideki sıra
let pwPrompt = null;     // { id, tabId, ident, origin, username, password, update }
let quitting = false;
let lastFocusedWinId = null;
const hasMemory = new Set();

const tabsOf = (W) => tabs.filter((t) => t.winId === W.id);
const winOf = (t) => wins.get(t.winId);
const winBySender = (wc) => [...wins.values()].find((W) => !W.win.isDestroyed() && W.win.webContents === wc);
const liveWins = () => [...wins.values()].filter((W) => !W.win.isDestroyed());
const focusedW = () => liveWins().find((W) => W.win.isFocused()) || wins.get(lastFocusedWinId) || liveWins()[0];
const activeTabOf = (W) => tabs.find((t) => t.id === W.activeTabId && t.winId === W.id);
const tabByWc = (wc) => tabs.find((t) => t.view && t.view.webContents === wc);
const identOf = (t) => t.slot || 'direct';
const partitionOf = (t) => (t.slot ? 'persist:id-' + t.slot.replace(':', '-') : 'persist:direct');

function snapshot(W) {
  const counts = { ok: 0, dead: 0, unknown: 0 };
  for (const p of store.proxies) { if (p.status === 'ok') counts.ok++; else if (p.status === 'dead') counts.dead++; else counts.unknown++; }
  const countries = activeCountries();
  const slots = [];
  for (const c of countries) {
    for (const col of COLORS) {
      const key = slotKey(c.cc, col.key);
      const p = slotProxy(key);
      slots.push({
        key, cc: c.cc, color: col.key, proxyId: p ? p.id : null,
        openCount: tabsOnSlot(key).length,
        hasMemory: hasMemory.has(key),
        passwords: store.passwords.filter((x) => x.ident === key).length,
      });
    }
  }
  const mine = tabsOf(W);
  return {
    windowId: W.id, windowCount: liveWins().length,
    colors: COLORS, countries, slots,
    tabs: mine.map((t) => ({
      id: t.id, slot: t.slot, proxyId: t.proxyId, title: t.title, url: t.url, favicon: t.favicon,
      loading: t.loading, connecting: t.connecting, blocked: t.blocked, canGoBack: t.canGoBack, canGoForward: t.canGoForward,
      error: t.error, exitIp: t.exitIp || '',
    })),
    dragging: tabDragging,
    currentGroupId: (currentGroupOf(W) || {}).id || null,
    windowTitle: titleFor(W),
    activeTabId: W.activeTabId, grid: !!W.gridGroupId, gridGroupId: W.gridGroupId, tiles: W.tiles || [],
    groups: W.groups.map((g) => ({ id: g.id, name: g.name, tabIds: g.tabIds.slice() })), groupMax: GROUP_MAX,
    proxies: store.proxies.map((p) => ({ ...p, password: p.password ? '••••' : '' })),
    passwords: store.passwords.map(({ password, ...rest }) => rest),
    neverSave: store.neverSave,
    pwPrompt: pwPrompt && mine.some((t) => t.id === pwPrompt.tabId)
      ? { id: pwPrompt.id, tabId: pwPrompt.tabId, origin: pwPrompt.origin, username: pwPrompt.username, update: pwPrompt.update, ident: pwPrompt.ident } : null,
    counts, settings: store.settings, drawerOpen: W.drawerOpen, pickerOpen: W.pickerOpen, notice,
    version: app.getVersion(),
  };
}

let pushTimer = null;
function titleFor(W) {
  const t = activeTabOf(W);
  if (!t) return 'SureBrowser';
  const p = t.proxyId && getProxy(t.proxyId);
  const g = currentGroupOf(W);
  const parts = [];
  if (p && p.note) parts.push(p.note);
  parts.push(t.slot ? slotLabel(t.slot) : 'Proxysiz');
  if (p) parts.push(p.exitIp);
  if (g) parts.push(g.name);
  return parts.join(' · ') + ' — SureBrowser';
}

// Şu an bulunulan grup: gösterilen ızgara ya da etkin sekmenin grubu
function currentGroupOf(W) {
  if (W.gridGroupId) { const g = groupById(W, W.gridGroupId); if (g) return g; }
  return W.activeTabId ? groupOfTab(W, W.activeTabId) || null : null;
}

function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    for (const W of liveWins()) {
      const title = titleFor(W);
      if (W.win.getTitle() !== title) W.win.setTitle(title);
      W.win.webContents.send('state', snapshot(W));
    }
  }, store.proxies.length > 300 ? 200 : 40);
}

/* ---------- Yerleşim: tek sekme ya da ızgara ---------- */

function gridRects(n, area) {
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = (area.w - TILE_GAP * (cols + 1)) / cols;
    const h = (area.h - TILE_GAP * (rows + 1)) / rows;
    if (w < 60 || h < 60) continue;
    const ratio = w / Math.max(1, h - TILE_HEAD);
    const score = Math.abs(Math.log(ratio / 1.5)) + (cols * rows - n) * 0.15;
    if (!best || score < best.score) best = { cols, w, h, score };
  }
  if (!best) { const cols = Math.ceil(Math.sqrt(n)); best = { cols, w: area.w / cols, h: area.h / Math.ceil(n / cols) }; }
  return Array.from({ length: n }, (_, i) => {
    const c = i % best.cols; const r = Math.floor(i / best.cols);
    return {
      x: Math.round(area.x + TILE_GAP + c * (best.w + TILE_GAP)), y: Math.round(area.y + TILE_GAP + r * (best.h + TILE_GAP)),
      w: Math.floor(best.w), h: Math.floor(best.h),
    };
  });
}

// Izgarada sayfa döşemeye sığsın diye küçültülür; ızgaradan çıkınca eski yakınlaştırma geri gelir
function applyGridZoom(t, width) {
  const wc = t.view.webContents;
  if (t.preGridZoom == null) t.preGridZoom = wc.getZoomFactor();
  const f = Math.max(0.33, Math.min(1, width / 1280));
  if (Math.abs(wc.getZoomFactor() - f) > 0.01) wc.setZoomFactor(f);
}
function restoreZoom(t) {
  if (t.preGridZoom != null && t.view) { t.view.webContents.setZoomFactor(t.preGridZoom); t.preGridZoom = null; }
}

function layout(W) {
  if (!W || W.win.isDestroyed()) return;
  const [w, h] = W.win.getContentSize();
  const area = { x: 0, y: TOP_H, w: Math.max(200, w - (W.drawerOpen ? DRAWER_W : 0)), h: Math.max(0, h - TOP_H - BOTTOM_H) };
  const mine = tabsOf(W);
  const g = W.gridGroupId && groupById(W, W.gridGroupId);
  if (W.gridGroupId && !g) W.gridGroupId = null;
  const gridOn = !!g && !W.pickerOpen;
  W.tiles = [];
  if (gridOn) {
    const members = mine.filter((t) => g.tabIds.includes(t.id));
    const rects = gridRects(members.length, area);
    for (const t of mine) if (!g.tabIds.includes(t.id) && t.view) { restoreZoom(t); t.view.setVisible(false); }
    members.forEach((t, i) => {
      const r = rects[i];
      W.tiles.push({ tabId: t.id, ...r });
      if (!t.view) return;
      const width = Math.max(0, r.w - 2 * TILE_PAD);
      t.view.setBounds({ x: r.x + TILE_PAD, y: r.y + TILE_HEAD, width, height: Math.max(0, r.h - TILE_HEAD - TILE_PAD) });
      // Sekme sürüklenirken sayfalar çekilir, altta "gruba bırak" alanı görünür
      t.view.setVisible(!tabDragging);
      applyGridZoom(t, width);
    });
  } else {
    for (const t of mine) {
      if (!t.view) continue;
      restoreZoom(t);
      t.view.setBounds({ x: 0, y: TOP_H, width: area.w, height: area.h });
      t.view.setVisible(t.id === W.activeTabId && !W.pickerOpen);
    }
  }
  pushState();
}

/* ---------- Pencereler ---------- */

function onScreen(b) {
  return b && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y < a.y + a.height - 40 && b.y >= a.y - 20;
  });
}

function createWindow({ id = uid(), bounds = null, maximized = false, groups = [], gridGroupId = null } = {}) {
  const W = { id, win: null, activeTabId: null, drawerOpen: false, pickerOpen: false, pickerUrl: null, pickerGroupId: null, groups, gridGroupId, tiles: [] };
  const opts = {
    width: 1360, height: 880, minWidth: 760, minHeight: 500,
    title: 'SureBrowser',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon-win.png' : 'icon.png'),
    backgroundColor: '#f4f4f2',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 11 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  };
  if (onScreen(bounds)) Object.assign(opts, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  W.win = new BrowserWindow(opts);
  wins.set(id, W);
  lastFocusedWinId = id;
  W.win.on('focus', () => { lastFocusedWinId = id; });
  W.win.on('resize', () => layout(W));
  W.win.on('maximize', () => layout(W));
  W.win.on('unmaximize', () => layout(W));
  W.win.on('move', () => saveStore());
  W.win.on('close', () => onWindowClose(W));
  W.win.on('closed', () => { wins.delete(id); pushState(); });
  W.win.once('ready-to-show', () => { if (maximized) W.win.maximize(); W.win.show(); });
  W.ready = W.win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return W;
}

function destroyTab(t) {
  const W = winOf(t);
  if (W) dropFromGroups(W, t.id);
  const i = tabs.indexOf(t);
  if (i !== -1) tabs.splice(i, 1);
  if (t.view && !t.view.webContents.isDestroyed()) t.view.webContents.close();
  if (pwPrompt && pwPrompt.tabId === t.id) pwPrompt = null;
}

function onWindowClose(W) {
  if (quitting) return;
  if (liveWins().length <= 1) { saveNow(); quitting = true; return; } // son pencere: her şeyi kaydet, uygulama kapanır
  for (const t of tabsOf(W)) destroyTab(t);
  saveStore(); pushState(); rebalance();
}

/* ---------- Sekmeler ---------- */

function normalizeInput(text) {
  const s = (text || '').trim();
  if (!s) return 'about:blank';
  if (/^(https?|file|about|data):/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^[\d.]+(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
  if (!/\s/.test(s) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return 'https://' + s;
  const q = encodeURIComponent(s);
  return store.settings.search === 'google' ? `https://www.google.com/search?q=${q}` : `https://duckduckgo.com/?q=${q}`;
}

function initialLoad(tab) {
  if (tab.loadedOnce || !tab.view) return;
  tab.loadedOnce = true;
  const wc = tab.view.webContents;
  const h = tab.history;
  tab.history = null;
  if (h && h.entries && h.entries.length) {
    wc.navigationHistory.restore({ entries: h.entries, index: h.index }).catch(() => { if (tab.url && tab.url !== 'about:blank') wc.loadURL(tab.url).catch(() => {}); });
  } else if (tab.url && tab.url !== 'about:blank') wc.loadURL(tab.url).catch(() => {});
}

// Sekmenin IP'sini değiştirir. Oturum (çerezler, önbellek) kimliğe ait olduğu için aynı kalır.
async function setTabProxy(tab, proxy) {
  if (!tabs.includes(tab) || !tab.view) return;
  const prevId = tab.proxyId;
  tab.proxyId = proxy ? proxy.id : null;
  tab.exitIp = proxy ? proxy.exitIp : '';
  tab.blocked = !!tab.slot && !proxy;
  tab.connecting = false;
  const ses = tab.view.webContents.session;
  await ses.setProxy(tab.slot ? await proxyConfig(proxy) : { mode: 'direct' });
  if (prevId !== tab.proxyId) await ses.closeAllConnections();
  if (!tab.slot || proxy) {
    if (!tab.loadedOnce) initialLoad(tab);
    else if (prevId && prevId !== tab.proxyId && tab.url !== 'about:blank') tab.view.webContents.reload();
  }
  pruneBridges();
  pushState();
}

function createView(tab) {
  const W = winOf(tab);
  const partition = partitionOf(tab);
  prepareSession(session.fromPartition(partition));
  const view = new WebContentsView({
    webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'page-preload.js') },
  });
  view.setBackgroundColor('#ffffff');
  view.setVisible(false);
  const wc = view.webContents;
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  tab.view = view;
  W.win.contentView.addChildView(view);

  const nav = () => {
    if (tab.view !== view) return;
    const u = wc.getURL();
    if (u) tab.url = u;
    tab.canGoBack = wc.navigationHistory.canGoBack();
    tab.canGoForward = wc.navigationHistory.canGoForward();
    if (tab.slot && !hasMemory.has(tab.slot)) { hasMemory.add(tab.slot); store.used = [...hasMemory]; }
    saveStore(); pushState();
  };
  wc.on('did-start-loading', () => { tab.loading = true; tab.error = null; pushState(); });
  wc.on('did-stop-loading', () => { tab.loading = false; nav(); });
  wc.on('did-navigate', () => { nav(); const w = winOf(tab); if (w && w.gridGroupId) layout(w); });
  wc.on('did-navigate-in-page', nav);
  wc.on('page-title-updated', (_e, title) => { tab.title = title; pushState(); });
  wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] || null; pushState(); });
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMain) => {
    if (!isMain || code === -3) return;
    tab.error = { code, desc, url: failedUrl };
    pushState();
    if (tab.slot && tab.proxyId && PROXY_ERRORS.has(code)) serial(() => ensureSlot(tab.slot, { force: true }));
  });
  // Izgarada tıklanan döşeme etkin sekme olur
  wc.on('focus', () => {
    const w = winOf(tab);
    // Yalnızca ızgarada görünen döşemeler odakla etkinleşir; gizli sekmeler odak çalamaz
    if (w && w.activeTabId !== tab.id && w.tiles && w.tiles.some((r) => r.tabId === tab.id)) { w.activeTabId = tab.id; pushState(); }
  });
  // Sayfa "ayrılmak istiyor musunuz?" diye sormasın
  wc.on('will-prevent-unload', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url, disposition }) => {
    // Gerçek açılır pencereler (ör. "Google ile giriş") aynı kimlik ve IP ile açılır
    if (disposition === 'new-window') {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 720, autoHideMenuBar: true, webPreferences: { partition, contextIsolation: true, sandbox: true } } };
    }
    openTab({ winId: tab.winId, slot: tab.slot, url, activate: disposition !== 'background-tab', after: tab });
    return { action: 'deny' };
  });
  wc.on('context-menu', (_e, params) => pageContextMenu(tab, params));
  wc.on('before-input-event', (e, input) => handleShortcutInput(e, input));
  wc.on('render-process-gone', () => { tab.error = { code: 0, desc: 'Sayfa çöktü, yenileyin', url: tab.url }; pushState(); });
}

// Sekmeyi pencere içinde konuma yerleştirir (toIndex: o penceredeki sıra)
function placeTab(tab, W, toIndex, after) {
  const i = tabs.indexOf(tab);
  if (i !== -1) tabs.splice(i, 1);
  if (after && tabs.includes(after)) {
    // Aynı kaynaktan açılanlar ardışık dursun
    let j = tabs.indexOf(after) + 1;
    while (j < tabs.length && tabs[j].openerId === after.id) j++;
    tabs.splice(j, 0, tab);
    return;
  }
  const list = tabs.filter((t) => t.winId === W.id);
  if (toIndex == null || toIndex >= list.length) tabs.push(tab);
  else tabs.splice(tabs.indexOf(list[Math.max(0, toIndex)]), 0, tab);
}

async function openTab({ winId = null, slot = null, url = null, activate = true, id = null, history = null, title = null, after = null, groupId = null } = {}) {
  const W = wins.get(winId) || focusedW();
  if (!W) return null;
  const tab = {
    id: id || uid(), winId: W.id, slot, proxyId: null, view: null, title: title || (slot ? slotLabel(slot) : 'Proxysiz'), url: url || 'about:blank',
    favicon: null, loading: false, connecting: !!slot, blocked: false, canGoBack: false, canGoForward: false, error: null, exitIp: '',
    history, loadedOnce: false, openerId: after ? after.id : null,
  };
  placeTab(tab, W, null, after);
  // Gruplu sekmeden açılan sekme, yer varsa aynı gruba girer
  const targetGroup = groupId ? groupById(W, groupId) : (after ? groupOfTab(W, after.id) : null);
  if (targetGroup && targetGroup.tabIds.length < GROUP_MAX) { targetGroup.tabIds.push(tab.id); compactGroup(W, targetGroup); }
  if (activate) {
    W.activeTabId = tab.id; W.pickerOpen = false;
    if (W.gridGroupId && !(targetGroup && targetGroup.id === W.gridGroupId && targetGroup.tabIds.includes(tab.id))) W.gridGroupId = null;
    if (groupId && targetGroup && targetGroup.tabIds.includes(tab.id)) W.gridGroupId = targetGroup.id;
  }
  createView(tab);
  layout(W);

  if (slot) {
    const others = tabsOnSlot(slot).filter((t) => t !== tab && t.proxyId);
    // Kimlik zaten başka sekmede açıksa aynı IP ile hemen bağlan
    if (others.length && slotProxy(slot) && others[0].proxyId === store.slots[slot]) await setTabProxy(tab, slotProxy(slot));
    else {
      const p = await serial(() => ensureSlot(slot, { force: true }));
      if (!tabs.includes(tab)) return null;
      if (!tab.proxyId) await setTabProxy(tab, p || null);
      if (!p) notify(`${slotLabel(slot)} için çalışan IP yok. Sekme, bu ülkeden IP bulunca kendiliğinden bağlanacak.`, 'error');
    }
  } else await setTabProxy(tab, null);

  if (!tabs.includes(tab)) return null;
  if (activate && tab.url === 'about:blank' && !history) focusAddress(W);
  else if (activate && tab.view) tab.view.webContents.focus();
  saveStore(); pushState();
  return tab;
}

function activateTab(id, { single = false } = {}) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  const W = winOf(t);
  W.activeTabId = id;
  W.pickerOpen = false;
  if (single) W.gridGroupId = null;
  if (!groupOfTab(W, id)) W.lastLooseTabId = id;
  else if (W.gridGroupId) { const g = groupById(W, W.gridGroupId); if (!g || !g.tabIds.includes(id)) W.gridGroupId = null; }
  layout(W);
  if (t.view && t.url !== 'about:blank') t.view.webContents.focus();
  saveStore();
}

function closeTab(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  const W = winOf(t);
  const list = tabsOf(W);
  const i = list.indexOf(t);
  if (t.view) W.win.contentView.removeChildView(t.view);
  destroyTab(t);
  if (W.activeTabId === id) {
    const rest = tabsOf(W);
    const next = rest[i] || rest[i - 1];
    W.activeTabId = next ? next.id : null;
  }
  if (!tabsOf(W).length) {
    // Penceredeki son sekme: başka pencere varsa pencereyi kapat, yoksa seçiciyi aç
    if (liveWins().length > 1) { W.win.destroy(); saveStore(); pushState(); rebalance(); return; }
    W.pickerOpen = true;
  }
  layout(W); saveStore();
  rebalance();
}

// Sekmeyi başka pencereye taşır (sürükle-bırak ya da menü)
function moveTabToWindow(tab, W2, toIndex) {
  const W1 = winOf(tab);
  if (!W1 || !W2 || W2.win.isDestroyed()) return;
  if (W1 === W2) { placeTab(tab, W2, toIndex); layout(W2); saveStore(); return; }
  restoreZoom(tab);
  dropFromGroups(W1, tab.id);
  if (tab.view) { W1.win.contentView.removeChildView(tab.view); W2.win.contentView.addChildView(tab.view); }
  tab.winId = W2.id;
  placeTab(tab, W2, toIndex);
  if (W1.activeTabId === tab.id) { const rest = tabsOf(W1); W1.activeTabId = rest.length ? rest[rest.length - 1].id : null; }
  W2.activeTabId = tab.id;
  W2.pickerOpen = false;
  if (pwPrompt && pwPrompt.tabId === tab.id) pushState();
  if (!tabsOf(W1).length) W1.win.destroy(); else layout(W1);
  layout(W2);
  W2.win.focus();
  if (tab.view) tab.view.webContents.focus();
  saveStore();
}

async function detachToNewWindow(tab, point) {
  const W1 = winOf(tab);
  const [w, h] = W1.win.getSize();
  const p = point || screen.getCursorScreenPoint();
  const W2 = createWindow({ bounds: { x: Math.round(p.x - 160), y: Math.round(p.y - 18), width: w, height: h } });
  await W2.ready;
  moveTabToWindow(tab, W2);
}

// Sekme pencerenin dışına bırakıldı
function onTabDragEnd(tabId) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const W1 = winOf(tab);
  const p = global.__ptTestCursor || screen.getCursorScreenPoint(); // test kancası
  const inside = (b) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  if (inside(W1.win.getBounds())) return;
  const target = liveWins().find((W) => W !== W1 && inside(W.win.getBounds()));
  if (target) { moveTabToWindow(tab, target); return; }
  if (tabsOf(W1).length === 1) { W1.win.setPosition(Math.round(p.x - 160), Math.round(p.y - 18)); return; }
  detachToNewWindow(tab, p);
}

function openPicker(W, url = null, groupId = null) {
  if (!W) return;
  W.pickerUrl = url;
  W.pickerGroupId = groupId;
  W.pickerOpen = true;
  layout(W);
  W.win.webContents.focus();
}

function focusAddress(W) {
  if (!W) return;
  W.win.webContents.focus();
  W.win.webContents.send('focus-address');
}

function cycleTab(W, dir) {
  const list = tabsOf(W);
  if (list.length < 2) return;
  const i = list.findIndex((t) => t.id === W.activeTabId);
  activateTab(list[(i + dir + list.length) % list.length].id);
}

function toggleGrid(W) {
  if (!W) return;
  if (W.gridGroupId) { W.gridGroupId = null; layout(W); saveStore(); return; }
  const g = groupOfTab(W, W.activeTabId);
  if (g) showGroup(W, g.id);
  else W.win.webContents.send('select-mode'); // gruplanacak sekmeleri seçtir
}

/* ---------- Gruplar (yan yana görünüm, en fazla 6 sekme) ---------- */

const GROUP_MAX = 6;
let tabDragging = false;
const groupById = (W, id) => W.groups.find((g) => g.id === id);
const groupOfTab = (W, tabId) => W.groups.find((g) => g.tabIds.includes(tabId));

function dropFromGroups(W, tabId) {
  for (const g of W.groups) g.tabIds = g.tabIds.filter((x) => x !== tabId);
  W.groups = W.groups.filter((g) => g.tabIds.length);
  if (W.gridGroupId && !groupById(W, W.gridGroupId)) W.gridGroupId = null;
}

// Grup sekmeleri sekme çubuğunda yan yana dursun
function compactGroup(W, g) {
  const members = tabsOf(W).filter((t) => g.tabIds.includes(t.id));
  if (members.length < 2) return;
  const anchor = members[0];
  for (const t of members.slice(1)) tabs.splice(tabs.indexOf(t), 1);
  tabs.splice(tabs.indexOf(anchor) + 1, 0, ...members.slice(1));
  g.tabIds = members.map((t) => t.id);
}

function nextGroupName(W) {
  const used = new Set(W.groups.map((g) => g.name));
  for (let i = 1; ; i++) if (!used.has(`Grup ${i}`)) return `Grup ${i}`;
}

function createGroup(W, tabIds) {
  const ids = [...new Set(tabIds)].filter((id) => tabs.some((t) => t.id === id && t.winId === W.id)).slice(0, GROUP_MAX);
  if (!ids.length) return null;
  ids.forEach((id) => dropFromGroups(W, id));
  const g = { id: uid(), name: nextGroupName(W), tabIds: ids };
  W.groups.push(g);
  compactGroup(W, g);
  return g;
}

function addToGroup(W, groupId, tabId) {
  const g = groupById(W, groupId);
  if (!g || g.tabIds.includes(tabId)) return !!g;
  if (g.tabIds.length >= GROUP_MAX) { notify(`${g.name} dolu (en fazla ${GROUP_MAX} sekme)`, 'warn'); return false; }
  dropFromGroups(W, tabId);
  const g2 = groupById(W, groupId) || g;
  if (!W.groups.includes(g2)) W.groups.push(g2);
  g2.tabIds.push(tabId);
  compactGroup(W, g2);
  return true;
}

function moveGroupToWindow(W1, g, W2) {
  if (!W1 || !g || !W2 || W2.win.isDestroyed()) return;
  const ids = g.tabIds.slice();
  const name = g.name;
  for (const id of ids) { const t = tabs.find((x) => x.id === id); if (t) moveTabToWindow(t, W2); }
  const ng = createGroup(W2, ids);
  if (ng) { ng.name = W2.groups.some((x) => x !== ng && x.name === name) ? nextGroupName(W2) : name; showGroup(W2, ng.id); }
  W2.win.focus();
  saveStore();
}

async function onGroupDragEnd(W1, groupId) {
  const g = W1 && groupById(W1, groupId);
  if (!g) return;
  const p = global.__ptTestCursor || screen.getCursorScreenPoint();
  const inside = (b) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  if (inside(W1.win.getBounds())) return;
  const target = liveWins().find((W) => W !== W1 && inside(W.win.getBounds()));
  if (target) { moveGroupToWindow(W1, g, target); return; }
  // Penceredeki tek şey bu grupsa pencereyi taşı
  if (tabsOf(W1).every((t) => g.tabIds.includes(t.id))) { W1.win.setPosition(Math.round(p.x - 160), Math.round(p.y - 18)); return; }
  const [w, h] = W1.win.getSize();
  const W2 = createWindow({ bounds: { x: Math.round(p.x - 160), y: Math.round(p.y - 18), width: w, height: h } });
  await W2.ready;
  moveGroupToWindow(W1, g, W2);
}

function showGroup(W, groupId) {
  const g = groupById(W, groupId);
  if (!g) return;
  W.gridGroupId = g.id;
  W.pickerOpen = false;
  if (!g.tabIds.includes(W.activeTabId)) W.activeTabId = g.tabIds[0];
  layout(W); saveStore();
}

function handleShortcutInput(e, input) {
  if (input.type !== 'keyDown') return;
  const mod = process.platform === 'darwin' ? input.meta : input.control;
  const W = focusedW();
  if (input.control && input.key === 'Tab') { e.preventDefault(); cycleTab(W, input.shift ? -1 : 1); } else if (mod && input.key.toLowerCase() === 'l') { e.preventDefault(); focusAddress(W); }
}

/* ---------------- Şifreler ---------------- */

const originOk = (o) => { try { const u = new URL(o); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };

function wirePasswords() {
  ipcMain.on('pw:capture', (e, { origin, username, password } = {}) => {
    const tab = tabByWc(e.sender);
    if (!tab || !store.settings.savePasswords || !password || !originOk(origin)) return;
    if (store.neverSave.includes(origin)) return;
    const ident = identOf(tab);
    const existing = store.passwords.find((x) => x.ident === ident && x.origin === origin && x.username === username);
    if (existing && existing.password === password) return;
    pwPrompt = { id: uid(), tabId: tab.id, ident, origin, username: username || '', password, update: !!existing };
    pushState();
  });
  ipcMain.handle('pw:get', (e) => {
    const tab = tabByWc(e.sender);
    if (!tab || !store.settings.autofill) return [];
    let origin;
    try { origin = new URL(e.sender.getURL()).origin; } catch { return []; }
    return store.passwords.filter((x) => x.ident === identOf(tab) && x.origin === origin)
      .sort((a, b) => b.at - a.at).map((x) => ({ username: x.username, password: x.password }));
  });
  ipcMain.on('pw:filled', () => {});
  ipcMain.on('pw:answer', (_e, { id, action }) => {
    if (!pwPrompt || pwPrompt.id !== id) return;
    const p = pwPrompt;
    pwPrompt = null;
    if (action === 'save') {
      const ex = store.passwords.find((x) => x.ident === p.ident && x.origin === p.origin && x.username === p.username);
      if (ex) Object.assign(ex, { password: p.password, at: Date.now() });
      else store.passwords.push({ id: uid(), ident: p.ident, origin: p.origin, username: p.username, password: p.password, at: Date.now() });
      notify(`${new URL(p.origin).host} şifresi kaydedildi`, 'info');
      // Aynı kimlikteki diğer sekmeler de hemen doldurabilsin
      for (const t of tabs) if (t.view && identOf(t) === p.ident) t.view.webContents.send('pw:refill');
    } else if (action === 'never') {
      if (!store.neverSave.includes(p.origin)) store.neverSave.push(p.origin);
    }
    saveStore(); pushState();
  });
  ipcMain.handle('pw:reveal', (_e, id) => { const x = store.passwords.find((y) => y.id === id); return x ? x.password : ''; });
  ipcMain.on('pw:delete', (_e, id) => { store.passwords = store.passwords.filter((x) => x.id !== id); saveStore(); pushState(); });
  ipcMain.on('pw:unnever', (_e, origin) => { store.neverSave = store.neverSave.filter((o) => o !== origin); saveStore(); pushState(); });
}

/* ---------------- Menüler ---------------- */

const iconCache = new Map();
function dotIcon(hex) {
  if (iconCache.has(hex)) return iconCache.get(hex);
  const size = 32; const buf = Buffer.alloc(size * size * 4);
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = Math.max(0, Math.min(1, 13 - Math.hypot(x - 15.5, y - 15.5)));
      const o = (y * size + x) * 4;
      buf[o] = b * a; buf[o + 1] = g * a; buf[o + 2] = r * a; buf[o + 3] = 255 * a;
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
  iconCache.set(hex, img);
  return img;
}

function identityMenu(onPick) {
  const items = activeCountries().map((c) => ({
    label: `${c.name} (${c.ok} IP)`,
    submenu: COLORS.map((col) => {
      const key = slotKey(c.cc, col.key);
      const p = slotProxy(key);
      const n = tabsOnSlot(key).length;
      return {
        label: `${col.name} — ${p ? p.exitIp : 'IP yok'}${n ? ` · ${n} sekmede açık` : ''}${p && p.note ? ' · ' + p.note : ''}`,
        icon: dotIcon(col.hex), enabled: !!p, click: () => onPick(key),
      };
    }),
  }));
  return items.length ? items : [{ label: 'Havuzda çalışan IP yok', enabled: false }];
}

async function clearIdentityData(tab) {
  const W = winOf(tab);
  const { response } = await dialog.showMessageBox(W.win, {
    type: 'warning', buttons: ['Temizle', 'Vazgeç'], defaultId: 1, cancelId: 1,
    message: `${tab.slot ? slotLabel(tab.slot) : 'Proxysiz sekmeler'}: çerezler, önbellek ve site verileri silinsin mi?`,
    detail: 'Bu kimlikteki tüm sitelerden çıkış yapılır. Kayıtlı şifreler silinmez.',
  });
  if (response !== 0 || !tab.view) return;
  const ses = tab.view.webContents.session;
  await ses.clearStorageData();
  await ses.clearCache();
  for (const t of tabs) if (t.view && identOf(t) === identOf(tab)) t.view.webContents.reload();
  notify('Kimlik verileri temizlendi', 'info');
}

function tabContextMenu(tabId) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const W = winOf(tab);
  const g = groupOfTab(W, tab.id);
  const roomy = W.groups.filter((x) => x !== g && x.tabIds.length < GROUP_MAX);
  const tpl = [
    ...(g ? [
      { label: `${g.name}: yan yana göster`, click: () => showGroup(W, g.id) },
      { label: `${g.name} grubundan çıkar`, click: () => { dropFromGroups(W, tab.id); layout(W); saveStore(); } },
    ] : []),
    {
      label: 'Gruba ekle',
      submenu: [
        ...roomy.map((x) => ({ label: `${x.name} (${x.tabIds.length}/${GROUP_MAX})`, click: () => { if (addToGroup(W, x.id, tab.id)) { layout(W); saveStore(); } } })),
        ...(roomy.length ? [{ type: 'separator' }] : []),
        { label: 'Yeni grup (bu sekmeyle)', click: () => { createGroup(W, [tab.id]); layout(W); saveStore(); } },
      ],
    },
    { label: 'Birden çok sekme seçip grupla…', click: () => W.win.webContents.send('select-mode', tab.id) },
    { type: 'separator' },
    { label: 'Aynı kimlikte yeni sekme', click: () => openTab({ winId: W.id, slot: tab.slot, after: tab }) },
    { label: 'Sekmeyi çoğalt', click: () => openTab({ winId: W.id, slot: tab.slot, url: tab.url, after: tab }) },
    { label: 'Sekmeyi yeni pencereye taşı', enabled: tabsOf(W).length > 1, click: () => detachToNewWindow(tab, { x: W.win.getBounds().x + 220, y: W.win.getBounds().y + 60 }) },
    { type: 'separator' },
  ];
  if (tab.slot) {
    tpl.push(
      { label: 'Bu kimliğe aynı ülkeden yeni IP ver', click: () => nextIpForSlot(tab.slot) },
      { label: 'IP adresini şimdi denetle', click: () => serial(() => ensureSlot(tab.slot, { force: true })) },
      { type: 'separator' },
    );
  }
  tpl.push(
    { label: 'Bu kimliğin çerez ve önbelleğini temizle…', click: () => clearIdentityData(tab) },
    { type: 'separator' },
    { label: 'Sekmeyi kapat', click: () => closeTab(tab.id) },
    { label: 'Diğer sekmeleri kapat', click: () => tabsOf(W).filter((t) => t.id !== tab.id).map((t) => t.id).forEach(closeTab) },
  );
  Menu.buildFromTemplate(tpl).popup({ window: W.win });
}

function groupMenu(W, id) {
  const g = groupById(W, id);
  if (!g) return;
  Menu.buildFromTemplate([
    { label: 'Yan yana göster', click: () => showGroup(W, g.id) },
    { label: 'Gruba sekme ekle…', enabled: g.tabIds.length < GROUP_MAX, click: () => { showGroup(W, g.id); openPicker(W, null, g.id); } },
    { label: 'Yeniden adlandır…', click: () => W.win.webContents.send('group-rename', g.id) },
    { type: 'separator' },
    { label: 'Grubu çöz (sekmeler kalır)', click: () => { W.groups = W.groups.filter((x) => x !== g); if (W.gridGroupId === g.id) W.gridGroupId = null; layout(W); saveStore(); } },
    { label: 'Gruptaki sekmeleri kapat', click: () => g.tabIds.slice().forEach(closeTab) },
  ]).popup({ window: W.win });
}

function pageContextMenu(tab, params) {
  const W = winOf(tab);
  const wc = tab.view.webContents;
  const tpl = [];
  if (params.linkURL) {
    tpl.push(
      { label: 'Bağlantıyı yeni sekmede aç', click: () => openTab({ winId: W.id, slot: tab.slot, url: params.linkURL, activate: false, after: tab }) },
      { label: 'Bağlantıyı başka kimlikte aç', submenu: identityMenu((key) => openTab({ winId: W.id, slot: key, url: params.linkURL })) },
      { label: 'Bağlantı adresini kopyala', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' },
    );
  }
  if (params.isEditable) tpl.push({ role: 'cut', label: 'Kes' }, { role: 'copy', label: 'Kopyala' }, { role: 'paste', label: 'Yapıştır' }, { type: 'separator' });
  else if (params.selectionText) tpl.push({ role: 'copy', label: 'Kopyala' }, { type: 'separator' });
  tpl.push(
    { label: 'Geri', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'İleri', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Yenile', click: () => wc.reload() },
    { type: 'separator' },
    { label: 'İncele', click: () => wc.inspectElement(params.x, params.y) },
  );
  Menu.buildFromTemplate(tpl).popup({ window: W.win });
}

function withActive(fn) { const W = focusedW(); const t = W && activeTabOf(W); if (t && t.view) fn(t.view.webContents, t, W); }

async function newWindow() {
  const W = createWindow();
  await W.ready;
  openPicker(W);
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const updateItem = { label: 'Güncellemeleri denetle…', click: () => updater.checkNow(focusedW() && focusedW().win) };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ label: 'SureBrowser', submenu: [{ role: 'about', label: 'SureBrowser hakkında' }, updateItem, { type: 'separator' }, { role: 'hide', label: 'Gizle' }, { role: 'hideOthers', label: 'Diğerlerini gizle' }, { type: 'separator' }, { role: 'quit', label: 'Çıkış' }] }] : []),
    {
      label: 'Dosya',
      submenu: [
        { label: 'Yeni sekme (ülke ve renk seç)', accelerator: 'CmdOrCtrl+T', click: () => openPicker(focusedW()) },
        { label: 'Yeni pencere', accelerator: 'CmdOrCtrl+N', click: newWindow },
        { label: 'Sekmeyi kapat', accelerator: 'CmdOrCtrl+W', click: () => { const W = focusedW(); if (W && W.activeTabId) closeTab(W.activeTabId); } },
        { label: 'Pencereyi kapat', accelerator: 'CmdOrCtrl+Shift+W', click: () => { const W = focusedW(); if (W) W.win.close(); } },
        { type: 'separator' },
        { label: 'IP havuzu ve şifreler', accelerator: 'CmdOrCtrl+Shift+P', click: () => { const W = focusedW(); if (W) setDrawer(W, !W.drawerOpen); } },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Çıkış' }]),
      ],
    },
    {
      label: 'Düzen',
      submenu: [
        { role: 'undo', label: 'Geri al' }, { role: 'redo', label: 'Yinele' }, { type: 'separator' },
        { role: 'cut', label: 'Kes' }, { role: 'copy', label: 'Kopyala' }, { role: 'paste', label: 'Yapıştır' }, { role: 'selectAll', label: 'Tümünü seç' },
      ],
    },
    {
      label: 'Görünüm',
      submenu: [
        { label: 'Tüm sekmeleri yan yana göster', accelerator: 'CmdOrCtrl+Shift+G', click: () => toggleGrid(focusedW()) },
        { type: 'separator' },
        { label: 'Adres çubuğu', accelerator: 'CmdOrCtrl+L', click: () => focusAddress(focusedW()) },
        { label: 'Yenile', accelerator: 'CmdOrCtrl+R', click: () => withActive((wc) => wc.reload()) },
        { label: 'Geri', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: () => withActive((wc) => wc.navigationHistory.goBack()) },
        { label: 'İleri', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: () => withActive((wc) => wc.navigationHistory.goForward()) },
        { type: 'separator' },
        { label: 'Sonraki sekme', accelerator: 'Ctrl+Tab', click: () => cycleTab(focusedW(), 1) },
        { label: 'Önceki sekme', accelerator: 'Ctrl+Shift+Tab', click: () => cycleTab(focusedW(), -1) },
        { type: 'separator' },
        { label: 'Yakınlaştır', accelerator: 'CmdOrCtrl+=', click: () => withActive((wc) => wc.setZoomLevel(wc.getZoomLevel() + 0.5)) },
        { label: 'Uzaklaştır', accelerator: 'CmdOrCtrl+-', click: () => withActive((wc) => wc.setZoomLevel(wc.getZoomLevel() - 0.5)) },
        { label: 'Gerçek boyut', accelerator: 'CmdOrCtrl+0', click: () => withActive((wc) => wc.setZoomLevel(0)) },
        { type: 'separator' },
        { label: 'Geliştirici araçları (sayfa)', accelerator: isMac ? 'Alt+Cmd+I' : 'F12', click: () => withActive((wc) => wc.toggleDevTools()) },
        { role: 'togglefullscreen', label: 'Tam ekran' },
      ],
    },
    ...(isMac ? [] : [{ label: 'Yardım', submenu: [updateItem, { label: `Sürüm ${app.getVersion()}`, enabled: false }] }]),
  ]));
}

function setDrawer(W, open) { if (!W) return; W.drawerOpen = open; layout(W); }

/* ---------------- Havuz işlemleri ---------------- */

function nextIpForSlot(key) {
  return serial(async () => {
    const cur = slotProxy(key);
    delete store.slots[key];
    if (cur) reserved.add(cur.id);
    let fresh;
    try { fresh = await fillSlot(key, { verify: true }); } finally { if (cur) reserved.delete(cur.id); }
    if (!fresh && cur) { store.slots[key] = cur.id; fresh = cur; }
    const changed = fresh && (!cur || fresh.id !== cur.id);
    if (changed) for (const t of tabsOnSlot(key)) await setTabProxy(t, fresh);
    notify(changed ? `${slotLabel(key)}: yeni IP ${fresh.exitIp}. Oturum korunuyor.` : `${slotLabel(key)}: bu ülkede başka uygun IP yok`, changed ? 'info' : 'warn');
    saveStore();
  });
}

function wire() {
  const W = (e) => winBySender(e.sender);
  const act = (e, fn) => { const w = W(e); const t = w && activeTabOf(w); if (t && t.view) fn(t.view.webContents, t, w); };
  ipcMain.handle('state:get', (e) => { const w = W(e); return w ? snapshot(w) : null; });
  ipcMain.on('picker:open', (e, url, groupId) => openPicker(W(e), url, groupId || null));
  ipcMain.on('picker:close', (e) => { const w = W(e); if (w && tabsOf(w).length) { w.pickerOpen = false; layout(w); } });
  ipcMain.on('picker:choose', (e, slot) => {
    const w = W(e); if (!w) return;
    const url = w.pickerUrl; const groupId = w.pickerGroupId;
    w.pickerUrl = null; w.pickerGroupId = null;
    openTab({ winId: w.id, slot: slot || null, url, groupId });
  });
  ipcMain.on('group:create', (e, ids) => {
    const w = W(e); if (!w) return;
    if (ids.length > GROUP_MAX) notify(`En fazla ${GROUP_MAX} sekme yan yana gösterilir; ilk ${GROUP_MAX} tanesi gruplandı`, 'warn');
    const g = createGroup(w, ids);
    if (g) showGroup(w, g.id);
  });
  ipcMain.on('group:show', (e, id) => { const w = W(e); if (w) showGroup(w, id); });
  ipcMain.on('group:add', (e, { groupId, tabId, focus }) => {
    const w = W(e); const tab = tabs.find((t) => t.id === tabId);
    if (!w || !tab) return;
    const g = groupById(w, groupId);
    if (!g) return;
    if (g.tabIds.length >= GROUP_MAX && !g.tabIds.includes(tabId)) { notify(`${g.name} dolu (en fazla ${GROUP_MAX} sekme)`, 'warn'); return; }
    if (tab.winId !== w.id) moveTabToWindow(tab, w); // başka pencereden sürüklendi
    const wasActive = w.activeTabId === tabId;
    w.__prevGroup = groupOfTab(w, tabId) || null;
    if (addToGroup(w, groupId, tabId)) {
      if (focus) { w.gridGroupId = groupId; w.activeTabId = tabId; } // ızgaraya bırakıldı: o gruba geç
      else if (wasActive) { // etkin sekme başka gruba gitti: bulunulan grupta kal
        const rest = tabsOf(w).filter((t) => t.id !== tabId && (groupOfTab(w, t.id) || null) === (w.__prevGroup || null));
        if (rest.length) w.activeTabId = rest[0].id;
      }
      layout(w); saveStore();
    }
  });
  // on: 'tab' (sekme sürükleniyor), 'tile' (ızgara kutusu sürükleniyor) ya da false
  ipcMain.on('ui:dragging', (_e, on) => {
    const kind = on === 'tile' ? 'tile' : on ? 'tab' : false;
    if (tabDragging === kind) return;
    tabDragging = kind;
    clearTimeout(global.__dragSafety);
    // Sürükleme bitiş haberi kaybolursa sayfalar gizli kalmasın
    if (tabDragging) global.__dragSafety = setTimeout(() => { tabDragging = false; for (const w of liveWins()) layout(w); }, 20000);
    for (const w of liveWins()) layout(w);
  });
  ipcMain.on('group:remove', (e, tabId) => {
    const w = W(e); const tab = tabs.find((t) => t.id === tabId);
    if (!w || !tab) return;
    if (tab.winId !== w.id) moveTabToWindow(tab, w); // başka pencereden "Grupsuz"a bırakıldı
    dropFromGroups(w, tabId);
    if (w.gridGroupId && !(groupById(w, w.gridGroupId) || { tabIds: [] }).tabIds.includes(w.activeTabId)) w.gridGroupId = null;
    layout(w); saveStore();
  });
  ipcMain.on('group:ungroupedView', (e) => {
    const w = W(e); if (!w) return;
    const loose = tabsOf(w).filter((t) => !groupOfTab(w, t.id));
    w.gridGroupId = null;
    if (loose.length) activateTab((loose.find((t) => t.id === w.lastLooseTabId) || loose[loose.length - 1]).id, { single: true });
    else openPicker(w);
  });
  ipcMain.on('group:dragEnd', (e, id) => onGroupDragEnd(W(e), id));
  ipcMain.on('group:attach', (e, id) => {
    const w = W(e); if (!w) return;
    const src = liveWins().find((x) => groupById(x, id));
    if (src && src !== w) moveGroupToWindow(src, groupById(src, id), w);
  });
  ipcMain.on('group:rename', (e, { id, name }) => { const w = W(e); const g = w && groupById(w, id); if (g && String(name).trim()) { g.name = String(name).trim().slice(0, 30); pushState(); saveStore(); } });
  ipcMain.on('group:menu', (e, id) => { const w = W(e); if (w) groupMenu(w, id); });
  ipcMain.on('tab:close', (_e, id) => closeTab(id));
  ipcMain.on('tab:activate', (_e, id, opts) => activateTab(id, opts || {}));
  ipcMain.on('tab:menu', (_e, id) => tabContextMenu(id));
  ipcMain.on('tab:move', (e, { id, toIndex }) => {
    const tab = tabs.find((t) => t.id === id); const w = W(e);
    if (tab && w) moveTabToWindow(tab, w, toIndex);
  });
  ipcMain.on('tab:dragEnd', (_e, id) => onTabDragEnd(id));
  ipcMain.on('grid:toggle', (e) => toggleGrid(W(e)));
  ipcMain.on('nav:go', (e, text) => act(e, (wc, t) => {
    t.url = normalizeInput(text); t.error = null; t.loadedOnce = true;
    if (t.blocked) { pushState(); return; }
    wc.loadURL(t.url).catch(() => {}); wc.focus();
  }));
  // Izgaradaki kutunun kendi adres çubuğu ve düğmeleri
  ipcMain.on('tab:go', (_e, { id, text }) => {
    const t = tabs.find((x) => x.id === id);
    if (!t || !t.view) return;
    t.url = normalizeInput(text); t.error = null; t.loadedOnce = true;
    if (t.blocked) { pushState(); return; }
    t.view.webContents.loadURL(t.url).catch(() => {});
    t.view.webContents.focus();
  });
  ipcMain.on('tab:nav', (_e, { id, action }) => {
    const t = tabs.find((x) => x.id === id);
    if (!t || !t.view) return;
    const wc = t.view.webContents;
    if (action === 'back') wc.navigationHistory.goBack();
    else if (action === 'forward') wc.navigationHistory.goForward();
    else if (action === 'stop') wc.stop();
    else wc.reload();
  });
  // Izgarada iki kutunun yerini değiştir
  ipcMain.on('group:swap', (e, { a, b }) => {
    const w = W(e); if (!w || a === b) return;
    const ta = tabs.find((x) => x.id === a); const tb = tabs.find((x) => x.id === b);
    if (!ta || !tb || ta.winId !== w.id || tb.winId !== w.id) return;
    const ia = tabs.indexOf(ta); const ib = tabs.indexOf(tb);
    tabs[ia] = tb; tabs[ib] = ta;
    const g = groupOfTab(w, a);
    if (g && g.tabIds.includes(b)) g.tabIds = tabsOf(w).filter((t) => g.tabIds.includes(t.id)).map((t) => t.id);
    layout(w); saveStore();
  });
  ipcMain.on('nav:back', (e) => act(e, (wc) => wc.navigationHistory.goBack()));
  ipcMain.on('nav:forward', (e) => act(e, (wc) => wc.navigationHistory.goForward()));
  ipcMain.on('nav:reload', (e) => act(e, (wc) => wc.reload()));
  ipcMain.on('nav:stop', (e) => act(e, (wc) => wc.stop()));

  ipcMain.on('slot:next', (_e, key) => nextIpForSlot(key));
  ipcMain.on('slot:check', (_e, key) => serial(() => ensureSlot(key, { force: true })));

  ipcMain.handle('proxy:import', (_e, { text, type, color }) => {
    const seen = new Set(store.proxies.map(proxyKey));
    let added = 0, dup = 0; const bad = []; const fresh = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const p = parseProxyLine(line, type);
      if (!p) { bad.push(line.trim()); continue; }
      if (seen.has(proxyKey(p))) { dup++; continue; }
      seen.add(proxyKey(p));
      p.color = color || null;
      store.proxies.push(p); fresh.push(p); added++;
    }
    saveStore(); pushState();
    checkPool(fresh).then(rebalance);
    return { added, dup, bad };
  });
  ipcMain.on('proxy:update', (_e, { id, patch }) => {
    const p = getProxy(id);
    if (!p) return;
    if ('note' in patch) p.note = String(patch.note || '').slice(0, 80);
    if ('color' in patch) p.color = patch.color || null;
    saveStore(); pushState();
    if ('color' in patch) rebalance();
  });
  ipcMain.on('proxy:delete', (_e, id) => {
    store.proxies = store.proxies.filter((p) => p.id !== id);
    const key = slotOfProxy(id);
    if (key) { delete store.slots[key]; if (tabsOnSlot(key).length) serial(() => ensureSlot(key)); }
    saveStore(); pushState(); rebalance();
  });
  ipcMain.on('proxy:deleteDead', () => {
    const dead = new Set(store.proxies.filter((p) => p.status === 'dead' && !slotOfProxy(p.id)).map((p) => p.id));
    store.proxies = store.proxies.filter((p) => !dead.has(p.id));
    saveStore(); pushState();
  });
  ipcMain.on('proxy:test', (_e, id) => { const p = getProxy(id); if (p) checkOne(p).then(rebalance); });
  ipcMain.on('proxy:testAll', () => { checkPool(store.proxies).then(healthTick); });
  ipcMain.on('settings:set', (_e, patch) => { Object.assign(store.settings, patch); saveStore(); pushState(); });
  ipcMain.on('ui:drawer', (e, open) => setDrawer(W(e), !!open));
  ipcMain.on('notice:clear', () => { notice = null; pushState(); });
  wirePasswords();
}

/* ---------------- Başlat ---------------- */

async function restoreWindow(sw) {
  const W = createWindow({ id: sw.id || uid(), bounds: sw.bounds, maximized: sw.maximized });
  const savedGroups = sw.groups || [];
  const savedGrid = sw.gridGroupId || null;
  await W.ready;
  const opens = [];
  for (const t of sw.tabs || []) {
    if (t.slot && !colorOf(parseSlot(t.slot).color)) continue;
    if (t.slot) hasMemory.add(t.slot);
    opens.push(openTab({ winId: W.id, slot: t.slot || null, url: t.url, title: t.title, id: t.id, history: t.history, activate: false }));
  }
  await Promise.all(opens);
  const ids = new Set(tabsOf(W).map((t) => t.id));
  W.groups = savedGroups.map((g) => ({ id: g.id, name: g.name, tabIds: (g.tabIds || []).filter((x) => ids.has(x)).slice(0, GROUP_MAX) })).filter((g) => g.tabIds.length);
  W.gridGroupId = W.groups.some((g) => g.id === savedGrid) ? savedGrid : null;
  const list = tabsOf(W);
  if (list.length) activateTab(list.find((t) => t.id === sw.activeTabId) ? sw.activeTabId : list[0].id);
  else openPicker(W);
  return W;
}

async function boot() {
  if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  loadStore();
  for (const k of store.used || []) hasMemory.add(k);
  buildAppMenu();
  wire();

  // Son oturumu geri yükle: tüm pencereler, konumları, sekmeleri, geçmişleri
  const saved = (store.windows || []).filter((w) => w.tabs && w.tabs.length);
  for (const sw of saved) await restoreWindow(sw);
  if (!liveWins().length) { const W = createWindow(); await W.ready; openPicker(W); }

  rebalance();
  setInterval(healthTick, HEALTH_EVERY_MS);
  setInterval(poolTick, POOL_EVERY_MS);
  setTimeout(poolTick, 15000);
  updater.init({ getWindow: () => focusedW() && focusedW().win, beforeInstall: () => { saveNow(); quitting = true; } });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Uygulama ikinci kez açılırsa mevcut pencereyi öne getir
  app.on('second-instance', () => { const W = focusedW(); if (W) { if (W.win.isMinimized()) W.win.restore(); W.win.focus(); } });
  app.whenReady().then(boot);
}
app.on('before-quit', () => { if (!quitting) { saveNow(); quitting = true; } });
app.on('window-all-closed', () => {
  for (const b of bridges.values()) b.bridge.stop();
  app.quit();
});
