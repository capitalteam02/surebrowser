/* global pt */
const $ = (id) => document.getElementById(id);
if (pt.platform === 'darwin') document.body.classList.add('mac');

let S = { colors: [], countries: [], slots: [], tabs: [], proxies: [], passwords: [], neverSave: [], counts: {}, settings: {}, activeTabId: null };
let addressDirty = false;
let drawerTab = 'pool';
const POOL_SHOW = 150;
const UNKNOWN = 'XX';

const proxyOf = (id) => S.proxies.find((p) => p.id === id);
const colorOf = (k) => S.colors.find((c) => c.key === k);
const slotOf = (k) => S.slots.find((s) => s.key === k);
const activeTab = () => S.tabs.find((t) => t.id === S.activeTabId);
const parseSlot = (k) => { const [cc, color] = String(k).split(':'); return { cc, color }; };
const regionNames = new Intl.DisplayNames(['tr'], { type: 'region' });
const countryName = (cc) => (!cc || cc === UNKNOWN ? 'Ülkesi bilinmeyen' : (() => { try { return regionNames.of(cc); } catch { return cc; } })());
const DIRECT = { key: null, name: 'Proxysiz', hex: '#9a9993' };

function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.36 ? '#1f1f1d' : '#ffffff';
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
}
const svg = (d, size = 14) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.style.width = s.style.height = size + 'px';
  s.innerHTML = d;
  return s;
};
const ICON = {
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  test: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  copy: '<rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5"/>',
};
const colorVars = (hex, prefix) => `--${prefix}:${hex};--${prefix}-ink:${inkFor(hex)}`;
const flagSrc = (cc) => `flags/${(cc && cc !== UNKNOWN ? cc : 'xx').toLowerCase()}.svg`;
const flagImg = (cc, cls = 'flag') => {
  const i = el('img', { class: cls, src: flagSrc(cc), alt: countryName(cc), title: countryName(cc) });
  i.onerror = () => { i.onerror = null; i.src = 'flags/xx.svg'; };
  return i;
};
const identLabel = (k) => (k === 'direct' ? 'Proxysiz' : `${countryName(parseSlot(k).cc)} · ${colorOf(parseSlot(k).color)?.name || ''}`);
const hostOf = (o) => { try { return new URL(o).host; } catch { return o; } };

function tabColor(t) { return t.slot ? colorOf(parseSlot(t.slot).color) : DIRECT; }
function tabProxy(t) { return t.proxyId ? proxyOf(t.proxyId) : null; }

/* ---------- Sekmeler ---------- */

const DND = 'application/x-surebrowser-tab';
// Seçim modu: yan yana gösterilecek sekmeleri seç (en fazla 6)
let selectMode = false;
const selected = new Set();
let renamingGroup = null;
const groupOfTab = (id) => (S.groups || []).find((g) => g.tabIds.includes(id));
function enterSelect(tabId) {
  selectMode = true; selected.clear();
  if (tabId) selected.add(tabId);
  render();
}
function exitSelect() { selectMode = false; selected.clear(); render(); }
function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id);
  else if (selected.size >= (S.groupMax || 6)) { flashSelectBar(); return; }
  else selected.add(id);
  render();
}
function flashSelectBar() { const b = $('selectBar'); b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake'); }

const GDND = 'application/x-surebrowser-group';
let dragGroupId = null;
const hasGroupDrag = (e) => [...(e.dataTransfer.types || [])].includes(GDND);
const GRID_ICON = '<rect x="2" y="2.5" width="5" height="4.5" rx="1"/><rect x="9" y="2.5" width="5" height="4.5" rx="1"/><rect x="2" y="9" width="5" height="4.5" rx="1"/><rect x="9" y="9" width="5" height="4.5" rx="1"/>';

// Grup etiketi sekme bırakma hedefi: sekmeyi o gruba taşır (null: "Grupsuz" → gruptan çıkar)
function tabDropTarget(node, groupId) {
  node.addEventListener('dragover', (e) => {
    if (hasTabDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; node.classList.add('drop-over'); }
    else if (hasGroupDrag(e) && groupId !== undefined) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-over'));
  node.addEventListener('drop', (e) => {
    node.classList.remove('drop-over');
    const tid = e.dataTransfer.getData(DND);
    const gid = e.dataTransfer.getData(GDND);
    if (tid) { e.preventDefault(); if (groupId) pt.addToGroup(groupId, tid); else pt.removeFromGroup(tid); }
    else if (gid) { e.preventDefault(); pt.attachGroup(gid); }
  });
}

function groupChip(g) {
  const isCur = S.currentGroupId === g.id;
  if (renamingGroup === g.id) {
    const input = el('input', { class: 'gchip-rename', value: g.name, maxlength: '30', 'aria-label': 'Grup adı' });
    const done = (save) => { if (renamingGroup !== g.id) return; renamingGroup = null; if (save && input.value.trim()) pt.renameGroup(g.id, input.value); render(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return input;
  }
  const node = el('button', {
    class: 'gchip' + (isCur ? ' current' : ''),
    title: `${g.name}: yan yana göster\nSekmeyi buraya sürükleyin: bu gruba taşır\nEtiketi pencere dışına sürükleyin: grup yeni pencerede açılır\nÇift tık: yeniden adlandır · Sağ tık: seçenekler`,
    draggable: 'true',
    onclick: () => pt.showGroup(g.id),
    ondblclick: () => { renamingGroup = g.id; render(); },
    oncontextmenu: (e) => { e.preventDefault(); pt.groupMenu(g.id); },
    ondragstart: (e) => { dragGroupId = g.id; node.classList.add('dragging'); e.dataTransfer.setData(GDND, g.id); e.dataTransfer.effectAllowed = 'move'; },
    ondragend: (e) => {
      node.classList.remove('dragging');
      if (e.dataTransfer.dropEffect === 'none') pt.groupDragEnd(g.id); // pencere dışına bırakıldı → yeni pencere
      dragGroupId = null;
      renderGroups();
    },
  }, svg(GRID_ICON, 12), g.name, el('span', { class: 'n' }, `${g.tabIds.length}/${S.groupMax || 6}`));
  tabDropTarget(node, g.id);
  return node;
}

function renderGroups() {
  if (dragGroupId) return;
  // Grup adı yazılırken satırı yeniden çizme: kutu silinip odak kaybolur ve hemen kapanır
  const editing = document.querySelector('#groups .gchip-rename');
  if (renamingGroup && editing) { renderWinTitle(); return; }
  const box = $('groups');
  const groups = S.groups || [];
  const loose = S.tabs.filter((t) => !groupOfTab(t.id)).length;
  const looseChip = el('button', {
    class: 'gchip loose' + (S.currentGroupId ? '' : ' current'),
    title: 'Gruba ait olmayan sekmeler\nSekmeyi buraya sürükleyin: gruptan çıkar',
    onclick: () => pt.ungroupedView(),
  }, 'Grupsuz', el('span', { class: 'n' }, String(loose)));
  tabDropTarget(looseChip, null);
  const addChip = el('button', { class: 'gchip add', title: 'Sekmeleri seçip yeni grup oluştur (en fazla 6)', onclick: () => enterSelect(S.activeTabId) }, '+ Yeni grup');
  box.replaceChildren(looseChip, ...groups.map(groupChip), addChip);
  renderWinTitle();
}

// Pencere adı: IP notu · kimlik · IP · grup
function renderWinTitle() {
  const t = activeTab(); const p = t && tabProxy(t);
  const wt = $('winTitle');
  wt.replaceChildren();
  if (t) {
    if (p && p.note) wt.append(el('b', {}, p.note), ' · ');
    wt.append((S.windowTitle || '').replace(/ — SureBrowser$/, '').replace(p && p.note ? p.note + ' · ' : '', ''));
  }
}
$('grouprow').addEventListener('dragover', (e) => { if (hasGroupDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
$('grouprow').addEventListener('drop', (e) => { const gid = e.dataTransfer.getData(GDND); if (gid && !e.target.closest('.gchip')) { e.preventDefault(); pt.attachGroup(gid); } });

let dragId = null;
const hasTabDrag = (e) => [...(e.dataTransfer.types || [])].includes(DND);
function dropAt(e, index) {
  e.preventDefault();
  const id = e.dataTransfer.getData(DND);
  if (!id) return;
  const from = S.tabs.findIndex((x) => x.id === id);
  pt.moveTab(id, from !== -1 && from < index ? index - 1 : index); // aynı pencerede sıra, başka pencereden taşıma
}

function renderTabs() {
  if (dragId) return; // sürükleme sırasında kaynak sekme silinirse sürükleme kopar
  const box = $('tabs');
  box.replaceChildren();
  // Sekme satırı yalnızca bulunulan grubun (ya da grupsuz) sekmelerini gösterir
  const cur = S.currentGroupId || null;
  const shown = S.tabs.filter((t) => ((groupOfTab(t.id) || {}).id || null) === cur);
  const narrow = shown.length > 6;
  const curGroup = cur && (S.groups || []).find((g) => g.id === cur);
  const lbl = $('tabrowLabel');
  lbl.textContent = curGroup ? curGroup.name : 'Grupsuz';
  lbl.className = 'tabrow-label' + (curGroup ? '' : ' loose');
  lbl.title = curGroup ? `Şu an ${curGroup.name} grubundasınız` : 'Şu an gruba ait olmayan sekmeler';
  S.tabs.forEach((t, index) => {
    const g = groupOfTab(t.id);
    if (((g || {}).id || null) !== cur) return;
    const c = tabColor(t);
    const p = tabProxy(t);
    const cc = t.slot ? parseSlot(t.slot).cc : null;
    let icon;
    if (t.loading || t.connecting) icon = el('span', { class: 'spinner' });
    else if (t.favicon) {
      icon = el('img', { class: 'fav', src: t.favicon, alt: '' });
      icon.onerror = () => icon.replaceWith(el('span', { class: 'fav-ph' }));
    } else icon = el('span', { class: 'fav-ph' });

    const title = tabTitle(t);
    const node = el('div', {
      class: 'tab' + (t.id === S.activeTabId ? ' active' : '') + (narrow ? ' narrow' : '') + (t.slot ? '' : ' direct') + (t.blocked ? ' blocked' : '')
        + (g ? ' grouped' + (S.gridGroupId === g.id ? ' group-on' : '') : '') + (selectMode ? ' selecting' : '') + (selected.has(t.id) ? ' selected' : ''),
      role: 'tab', 'aria-selected': String(t.id === S.activeTabId),
      title: `${title}\n${t.slot ? identLabel(t.slot) : 'Proxysiz'}${p ? ` · ${p.exitIp}` : ''}${p && p.note ? `\nNot: ${p.note}` : ''}\nPencere dışına sürükleyerek ayırabilirsiniz`,
      style: `--tc:${c.hex};--tc-ink:${inkFor(c.hex)}`,
      draggable: 'true',
      onmousedown: (e) => {
        if (e.button !== 0) return;
        if (selectMode) { toggleSelect(t.id); return; }
        if (e.metaKey || e.ctrlKey) { enterSelect(S.activeTabId); toggleSelect(t.id); return; }
        // Izgara açıkken basınca değil tıklayınca açılır; böylece sekme sürüklenebilir
        if (S.gridGroupId) return;
        pt.activateTab(t.id, { single: true });
      },
      onclick: (e) => {
        if (selectMode || e.metaKey || e.ctrlKey) return;
        // Gruptayken sekmeye tıklamak yalnızca o sekmeyi açar (ızgaradan çıkar)
        if (S.gridGroupId) pt.activateTab(t.id, { single: true });
      },
      onauxclick: (e) => { if (e.button === 1) pt.closeTab(t.id); },
      oncontextmenu: (e) => { e.preventDefault(); pt.tabMenu(t.id); },
      ondragstart: (e) => { dragId = t.id; node.classList.add('dragging'); e.dataTransfer.setData(DND, t.id); e.dataTransfer.effectAllowed = 'move'; pt.setDragging('tab'); },
      ondragend: (e) => {
        node.classList.remove('dragging');
        pt.setDragging(false);
        // Hiçbir yere bırakılmadıysa: pencere dışına çıkarıldı → yeni pencere ya da diğer pencere
        if (e.dataTransfer.dropEffect === 'none') pt.dragEnd(t.id);
        dragId = null;
        renderTabs();
      },
      ondragover: (e) => { if (hasTabDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; node.classList.add('drop-before'); } },
      ondragleave: () => node.classList.remove('drop-before'),
      ondrop: (e) => { node.classList.remove('drop-before'); dropAt(e, index); },
    },
    selectMode ? el('span', { class: 'tick', 'aria-hidden': 'true' }, selected.has(t.id) ? '✓' : '') : null,
    t.slot ? flagImg(cc) : null,
    icon,
    el('span', { class: 'title' }, title),
    el('span', { class: 'cname' }, c.name),
    el('button', {
      class: 'close', 'aria-label': 'Sekmeyi kapat', title: 'Kapat',
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => { e.stopPropagation(); pt.closeTab(t.id); },
    }, svg(ICON.close, 12)));
    box.append(node);
  });
}

function tabTitle(t) {
  if (t.connecting) return 'IP denetleniyor…';
  if (t.blocked) return 'IP yok, bekliyor';
  return t.title && t.url !== 'about:blank' ? t.title : 'Yeni sekme';
}

/* ---------- Izgara: tüm sekmeler yan yana ---------- */

function renderGrid() {
  const layer = $('gridLayer');
  const on = S.tiles && S.tiles.length > 0;
  layer.hidden = !on;
  $('gridBtn').setAttribute('aria-pressed', String(!!S.gridGroupId));
  $('gridBtn').title = S.gridGroupId ? 'Tek sekme görünümüne dön (Ctrl/⌘+Shift+G)' : 'Sekmeleri yan yana göster: grup seç ya da oluştur, en fazla 6 (Ctrl/⌘+Shift+G)';
  // + düğmesi: gösterilen gruba sekme ekle
  const g = S.gridGroupId && (S.groups || []).find((x) => x.id === S.gridGroupId);
  const addBtn = $('gridAddBtn');
  addBtn.hidden = !g;
  if (g) {
    const full = g.tabIds.length >= (S.groupMax || 6);
    addBtn.disabled = full;
    addBtn.title = full ? `${g.name} dolu (${g.tabIds.length}/${S.groupMax || 6})` : `${g.name} grubuna sekme ekle (${g.tabIds.length}/${S.groupMax || 6})`;
  }
  // Sürükleme sırasında bırakma alanı
  const drop = $('gridDrop');
  drop.hidden = !(on && S.dragging === 'tab' && g);
  if (!drop.hidden) {
    const full = g.tabIds.length >= (S.groupMax || 6);
    const inGroup = dragId && g.tabIds.includes(dragId);
    drop.classList.toggle('full', full && !inGroup);
    drop.querySelector('b').textContent = inGroup ? 'Bu sekme zaten grupta' : full ? `${g.name} dolu` : `${g.name} grubuna eklemek için bırakın`;
    drop.querySelector('span').textContent = `${g.tabIds.length}/${S.groupMax || 6} sekme`;
  }
  const keep = new Set();
  if (on) {
    for (const r of S.tiles) {
      const t = S.tabs.find((x) => x.id === r.tabId);
      if (!t) continue;
      let T = tileEls.get(t.id);
      if (!T) { T = buildTile(t.id); tileEls.set(t.id, T); layer.append(T.el); }
      updateTile(T, r, t);
      keep.add(t.id);
    }
  }
  for (const [id, T] of tileEls) if (!keep.has(id)) { T.el.remove(); tileEls.delete(id); }
  layer.classList.toggle('tile-dragging', S.dragging === 'tile');
}

/* Izgara kutuları kalıcı tutulur: adres çubuğuna yazarken ya da kutu sürüklenirken yeniden çizilip bozulmasınlar */
const TDND = 'application/x-surebrowser-tile';
const hasTileDrag = (e) => [...(e.dataTransfer.types || [])].includes(TDND);
const tileEls = new Map();
let dragTileId = null;
const NAV_ICON = {
  back: '<path d="M10 3L5 8l5 5"/>',
  forward: '<path d="M6 3l5 5-5 5"/>',
  reload: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5"/>',
};

function buildTile(id) {
  const T = { id };
  const navBtn = (action, label) => el('button', {
    class: 'tnav', 'aria-label': label, title: label,
    onmousedown: (e) => e.stopPropagation(),
    onclick: () => pt.navTab(id, T.loading && action === 'reload' ? 'stop' : action),
  }, svg(NAV_ICON[action], 13));
  T.flag = el('img', { class: 'flag', alt: '' });
  T.grip = el('span', {
    class: 'grip', draggable: 'true', title: 'Tutup başka bir kutunun üstüne bırakın: yer değiştirir',
    ondragstart: (e) => {
      dragTileId = id; e.dataTransfer.setData(TDND, id); e.dataTransfer.effectAllowed = 'move';
      T.el.classList.add('dragging');
      pt.setDragging('tile');
    },
    ondragend: () => { T.el.classList.remove('dragging'); dragTileId = null; pt.setDragging(false); },
  }, el('span', { class: 'dots', 'aria-hidden': 'true' }, '⠿'), T.flag);
  T.back = navBtn('back', 'Geri');
  T.forward = navBtn('forward', 'İleri');
  T.reload = navBtn('reload', 'Yenile');
  T.input = el('input', { class: 'tile-addr', spellcheck: 'false', 'aria-label': 'Adres', placeholder: 'Adres yazın veya arayın' });
  T.input.addEventListener('focus', () => { T.editing = true; T.input.select(); pt.activateTab(id); });
  T.input.addEventListener('blur', () => { T.editing = false; T.input.value = T.url; });
  T.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); T.editing = false; pt.goTab(id, T.input.value); T.input.blur(); }
    if (e.key === 'Escape') { T.input.value = T.url; T.input.blur(); }
  });
  T.note = el('span', { class: 'tile-note' });
  T.ip = el('span', { class: 'tile-ip' });
  T.close = el('button', { class: 'close', 'aria-label': 'Sekmeyi kapat', onmousedown: (e) => e.stopPropagation(), onclick: () => pt.closeTab(id) }, svg(ICON.close, 12));
  T.head = el('div', {
    class: 'tile-head',
    onmousedown: (e) => { if (!e.target.closest('input, button')) pt.activateTab(id); },
    oncontextmenu: (e) => { e.preventDefault(); pt.tabMenu(id); },
  }, T.grip, T.back, T.forward, T.reload, T.input, T.note, T.ip, T.close);
  T.el = el('div', { class: 'tile' }, T.head);
  // Kutu sürüklenirken sayfalar çekilir; bütün kutu bırakma hedefi olur
  T.el.addEventListener('dragover', (e) => { if (hasTileDrag(e) && dragTileId !== id) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; T.el.classList.add('swap-over'); } });
  T.el.addEventListener('dragleave', (e) => { if (!T.el.contains(e.relatedTarget)) T.el.classList.remove('swap-over'); });
  T.el.addEventListener('drop', (e) => {
    T.el.classList.remove('swap-over');
    const from = e.dataTransfer.getData(TDND);
    if (from && from !== id) { e.preventDefault(); pt.swapTiles(from, id); }
  });
  return T;
}

function updateTile(T, r, t) {
  const c = tabColor(t);
  const p = tabProxy(t);
  T.el.className = 'tile' + (t.id === S.activeTabId ? ' active' : '') + (dragTileId === t.id ? ' dragging' : '');
  T.el.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;--tc:${c.hex};--tc-ink:${inkFor(c.hex)}`;
  const cc = t.slot ? parseSlot(t.slot).cc : null;
  T.flag.hidden = !cc;
  if (cc && T.flag.dataset.cc !== cc) { T.flag.dataset.cc = cc; T.flag.src = flagSrc(cc); }
  T.back.disabled = !t.canGoBack;
  T.forward.disabled = !t.canGoForward;
  T.loading = t.loading;
  T.reload.classList.toggle('loading', !!t.loading);
  T.url = t.url && t.url !== 'about:blank' ? t.url : '';
  if (!T.editing) T.input.value = T.url;
  T.input.title = tabTitle(t);
  T.note.textContent = p && p.note ? p.note : '';
  T.note.hidden = !(p && p.note);
  T.ip.textContent = p ? p.exitIp : (t.slot ? (t.connecting ? 'denetleniyor…' : 'IP yok') : 'gerçek IP');
  T.head.title = `${tabTitle(t)}\n${t.slot ? identLabel(t.slot) : 'Proxysiz'}${p ? ' · ' + p.exitIp : ''}`;
}

/* ---------- Gezinme ve alt çubuk ---------- */

function renderNav() {
  const t = activeTab();
  const c = t ? tabColor(t) : DIRECT;
  const p = t && tabProxy(t);
  const root = document.documentElement.style;
  root.setProperty('--c', c.hex);
  root.setProperty('--c-ink', inkFor(c.hex));

  $('back').disabled = !(t && t.canGoBack);
  $('forward').disabled = !(t && t.canGoForward);
  $('reload').classList.toggle('loading', !!(t && t.loading));
  $('reload').title = t && t.loading ? 'Durdur' : 'Yenile';

  const cc = t && t.slot ? parseSlot(t.slot).cc : null;
  $('chipFlag').hidden = !cc;
  if (cc) $('chipFlag').src = flagSrc(cc);
  $('chipNote').textContent = p && p.note ? p.note : '';
  $('chipNote').hidden = !(p && p.note);
  document.querySelector('.chip-name').textContent = t ? (t.slot ? `${countryName(cc)} · ${c.name}` : 'Proxysiz') : '';
  document.querySelector('.chip-ip').textContent = !t ? '' : !t.slot ? 'gerçek IP' : t.connecting ? 'denetleniyor…' : p ? p.exitIp : 'IP yok';
  $('colorChip').hidden = !t;
  $('nextIpBtn').hidden = !(t && t.slot);

  const addr = $('address');
  if (!addressDirty || document.activeElement !== addr) {
    addr.value = t && t.url !== 'about:blank' ? t.url : '';
    addressDirty = false;
  }
  $('addressForm').classList.toggle('insecure', !!(t && /^http:/.test(t.url)));

  const errEl = $('loadError');
  if (t && t.error) {
    errEl.hidden = false;
    const proxyish = /PROXY|TUNNEL|SOCKS/.test(t.error.desc);
    errEl.textContent = (proxyish ? 'Proxy hatası: ' : 'Yüklenemedi: ') + t.error.desc.replace('ERR_', '');
    errEl.title = t.error.url;
  } else errEl.hidden = true;

  const tag = $('noteTag');
  if (!$('noteEdit').hidden) { /* düzenleniyor */ } else if (p) {
    tag.textContent = p.note || 'Not ekle';
    tag.classList.toggle('empty', !p.note);
  } else {
    tag.textContent = t ? (t.slot ? 'IP yok' : 'Proxysiz') : 'Sekme yok';
    tag.classList.add('empty');
  }
  $('statusIp').textContent = p
    ? `${p.exitIp}${p.city ? ' · ' + p.city : ''} · ${p.type.toUpperCase()} ${p.host}:${p.port}`
    : (t && !t.slot ? 'Bu sekme proxy kullanmıyor, gerçek IP adresiniz görünür' : '');

  // Şifre kaydetme sorusu bildirimden önce gelir
  const pr = S.pwPrompt;
  const box = $('pwPrompt');
  if (pr) {
    box.hidden = false;
    box.querySelector('.pw-text').textContent = `${hostOf(pr.origin)}${pr.username ? ' · ' + pr.username : ''}: şifre ${pr.update ? 'güncellensin' : 'kaydedilsin'} mi?`;
    box.querySelector('[data-a="save"]').textContent = pr.update ? 'Güncelle' : 'Kaydet';
    box.dataset.id = pr.id;
  } else box.hidden = true;

  const sb = $('selectBar');
  sb.hidden = !selectMode;
  if (selectMode) {
    // Kapanmış sekmeleri seçimden düş
    for (const id of [...selected]) if (!S.tabs.some((x) => x.id === id)) selected.delete(id);
    sb.querySelector('.sel-text').textContent = `Yan yana gösterilecek sekmeleri seçin (en fazla ${S.groupMax || 6}): ${selected.size} seçili`;
    sb.querySelector('[data-a="go"]').disabled = selected.size < 1;
  }

  const n = $('notice');
  if (!pr && !selectMode && S.notice && Date.now() - S.notice.at < 20000) {
    n.hidden = false; n.className = 'notice ' + S.notice.kind; n.textContent = S.notice.text; n.title = 'Kapatmak için tıklayın';
  } else n.hidden = true;

  $('poolSum').textContent = `${S.countries.length} ülke · havuz ${S.proxies.length}: ${S.counts.ok || 0} çalışan, ${S.counts.dead || 0} çöken`;
}

/* ---------- Ülke ve renk seçici ---------- */

function swatch(s) {
  const c = colorOf(s.color);
  const p = s.proxyId && proxyOf(s.proxyId);
  const open = s.openCount > 0;
  let st = 'Hazır', stCls = '';
  if (!p) { st = 'Bu renkte IP yok'; stCls = 'none'; } else if (open) { st = `${s.openCount} sekmede açık`; stCls = 'open'; } else if (s.hasMemory) st = 'Oturumu kayıtlı';
  return el('button', {
    class: 'swatch', style: colorVars(c.hex, 's'), disabled: !p,
    title: open ? 'Bu kimlikte yeni bir sekme daha açılır (aynı IP, aynı oturum)' : '',
    'data-slot': s.key,
    onclick: () => pt.choose(s.key),
  },
  el('div', { class: 'top' }, el('b', {}, c.name),
    el('span', { class: 'badges' }, s.passwords ? el('span', { title: 'Kayıtlı şifre' }, `${s.passwords} şifre`) : null)),
  el('div', { class: 'body' },
    el('span', { class: 'ip' }, p ? p.exitIp : '—'),
    el('span', { class: 'sn' }, p ? (p.note || p.city || '') : ''),
    el('span', { class: 'st ' + stCls }, st)));
}

function renderPicker() {
  $('picker').hidden = !S.pickerOpen;
  document.body.classList.toggle('drawer-open', !!S.drawerOpen);
  if (!S.pickerOpen) return;
  $('pickerClose').hidden = S.tabs.length === 0;
  $('pickerEmpty').hidden = S.countries.length > 0;
  $('countryJump').replaceChildren(...(S.countries.length > 1 ? S.countries.map((c) => el('button', {
    onclick: () => document.getElementById('cc-' + c.cc)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  }, flagImg(c.cc), `${c.name} · ${c.ok}`)) : []));
  $('countryLists').replaceChildren(...S.countries.map((c) => el('section', { class: 'country', id: 'cc-' + c.cc },
    el('div', { class: 'country-head' }, flagImg(c.cc, 'flag lg'), el('h2', {}, c.name),
      el('span', {}, `${c.ok} çalışan IP${c.dead ? ` · ${c.dead} çöken` : ''}`)),
    el('div', { class: 'swatches' }, ...S.slots.filter((s) => s.cc === c.cc).map(swatch)))));
}

/* ---------- Çekmece ---------- */

function colorSelect(value, onChange) {
  const s = el('select', { 'aria-label': 'Renk', onchange: (e) => onChange(e.target.value || null) },
    el('option', { value: '' }, 'Otomatik'),
    ...S.colors.map((c) => el('option', { value: c.key }, c.name)));
  s.value = value || '';
  return s;
}

function statusText(p) {
  if (p.status === 'checking') return ['Deneniyor…', ''];
  if (p.status === 'ok') return [`Çalışıyor · ${p.exitIp} · ${countryName(p.cc)}${p.city ? ', ' + p.city : ''} · ${p.ms} ms`, 'ok'];
  if (p.status === 'dead') return [`Çöktü · ${p.err}`, 'dead'];
  return ['Denenmedi', ''];
}

function renderPool() {
  const ic = $('importColor');
  if (!ic.options.length) {
    ic.append(el('option', { value: '' }, 'Otomatik'), ...S.colors.map((c) => el('option', { value: c.key }, c.name)));
    ic.value = '';
  }
  $('poolCount').textContent = `(${S.proxies.length})`;
  const q = $('poolSearch').value.trim().toLowerCase();
  const f = $('poolFilter').value;
  const activeIds = new Map(S.slots.filter((s) => s.proxyId).map((s) => [s.proxyId, s.key]));
  const rows = S.proxies.filter((p) => {
    if (f === 'ok' && p.status !== 'ok') return false;
    if (f === 'dead' && p.status !== 'dead') return false;
    if (f === 'unknown' && (p.status === 'ok' || p.status === 'dead')) return false;
    if (q && !`${p.host}:${p.port} ${p.note} ${p.exitIp} ${p.cc} ${countryName(p.cc)}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (activeIds.has(b.id) ? 1 : 0) - (activeIds.has(a.id) ? 1 : 0));

  $('poolList').replaceChildren(...rows.slice(0, POOL_SHOW).map((p) => {
    const live = activeIds.get(p.id);
    const col = colorOf(live ? parseSlot(live).color : p.color);
    const [st, stCls] = statusText(p);
    const note = el('input', { value: p.note || '', placeholder: 'Not (sol altta etiket olarak görünür)', maxlength: '80', 'aria-label': 'Not' });
    note.addEventListener('change', () => { if (note.value !== (p.note || '')) pt.updateProxy(p.id, { note: note.value }); });
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter') note.blur(); });
    return el('li', { class: 'item' + (p.status === 'dead' ? ' dead' : ''), style: col ? colorVars(col.hex, 's') : '' },
      el('div', { class: 'addr' },
        p.cc ? flagImg(p.cc) : null,
        el('span', { class: 'type' }, p.type),
        `${p.host}:${p.port}${p.username ? ' 🔒' : ''}`,
        live ? el('span', { class: 'live' }, `${colorOf(parseSlot(live).color).name} · aktif`) : null),
      el('div', { class: 'actions' },
        el('button', { class: 'icon-btn', title: 'Dene', 'aria-label': 'Dene', onclick: () => pt.testProxy(p.id) }, svg(ICON.test)),
        el('button', { class: 'icon-btn', title: 'Sil', 'aria-label': 'Sil', onclick: () => pt.deleteProxy(p.id) }, svg(ICON.trash))),
      el('div', { class: 'edit' }, colorSelect(p.color, (v) => pt.updateProxy(p.id, { color: v })), note),
      el('div', { class: 'meta ' + stCls, title: st }, st));
  }));
  const more = $('poolMore');
  more.hidden = rows.length <= POOL_SHOW && rows.length > 0;
  more.textContent = rows.length === 0
    ? (S.proxies.length ? 'Eşleşen IP yok.' : 'Havuz boş. Yukarıdan IP ekleyin.')
    : `${rows.length - POOL_SHOW} IP daha var. Aramayla daraltın.`;
}

const openGroups = new Set();
function renderIdentities() {
  const box = $('identityGroups');
  if (!S.countries.length) { box.replaceChildren(el('p', { class: 'empty' }, 'Havuzda çalışan IP yok.')); return; }
  box.replaceChildren(...S.countries.map((c) => {
    const slots = S.slots.filter((s) => s.cc === c.cc);
    const openN = slots.filter((s) => s.openCount).length;
    const d = el('details', { class: 'cgroup', open: openGroups.has(c.cc) || openN > 0 },
      el('summary', {}, flagImg(c.cc), c.name, el('span', { class: 'count' }, `${slots.filter((s) => s.proxyId).length}/10 hazır${openN ? ` · ${openN} açık` : ''}`)),
      el('ul', { class: 'slots' }, ...slots.map((s) => {
        const col = colorOf(s.color);
        const p = s.proxyId && proxyOf(s.proxyId);
        const l2 = s.openCount ? [`${s.openCount} sekmede açık`, 'open'] : p ? [p.note || (s.hasMemory ? 'Oturumu kayıtlı' : 'Hazır'), ''] : ['IP yok', 'none'];
        return el('li', { class: 'slot', style: colorVars(col.hex, 's') },
          el('span', { class: 'bar' }),
          el('div', { class: 'main' },
            el('div', { class: 'l1' }, el('b', {}, col.name), el('span', {}, p ? p.exitIp : '—'), s.passwords ? el('span', { class: 'type' }, `${s.passwords} şifre`) : null),
            el('div', { class: 'l2 ' + l2[1] }, l2[0])),
          el('button', { class: 'btn ghost small', title: 'Aynı ülkeden başka IP ver', onclick: () => pt.nextIp(s.key) }, 'Yeni IP'));
      })));
    d.addEventListener('toggle', () => { if (d.open) openGroups.add(c.cc); else openGroups.delete(c.cc); });
    return d;
  }));
}

const revealed = new Map();
function renderPasswords() {
  $('optSave').checked = S.settings.savePasswords !== false;
  $('optFill').checked = S.settings.autofill !== false;
  $('searchSel').value = S.settings.search || 'duckduckgo';
  const q = $('pwSearch').value.trim().toLowerCase();
  const list = S.passwords.filter((x) => !q || `${x.origin} ${x.username} ${identLabel(x.ident)}`.toLowerCase().includes(q))
    .sort((a, b) => b.at - a.at);
  $('pwCount').textContent = S.passwords.length ? `(${S.passwords.length})` : '';
  $('pwEmpty').hidden = S.passwords.length > 0;
  $('pwList').replaceChildren(...list.map((x) => {
    const col = x.ident !== 'direct' ? colorOf(parseSlot(x.ident).color) : DIRECT;
    return el('li', { class: 'item pw-item' },
      el('div', { class: 'addr' }, hostOf(x.origin), x.username ? el('span', { class: 'uname' }, x.username) : null),
      el('div', { class: 'actions' },
        el('button', {
          class: 'icon-btn', title: revealed.has(x.id) ? 'Gizle' : 'Göster', 'aria-label': 'Şifreyi göster',
          onclick: async () => { if (revealed.has(x.id)) revealed.delete(x.id); else revealed.set(x.id, await pt.pwReveal(x.id)); renderPasswords(); },
        }, svg(ICON.eye)),
        el('button', { class: 'icon-btn', title: 'Şifreyi kopyala', 'aria-label': 'Şifreyi kopyala', onclick: async () => navigator.clipboard.writeText(await pt.pwReveal(x.id)) }, svg(ICON.copy)),
        el('button', { class: 'icon-btn', title: 'Sil', 'aria-label': 'Sil', onclick: () => { if (confirm(`${hostOf(x.origin)} şifresi silinsin mi?`)) pt.pwDelete(x.id); } }, svg(ICON.trash))),
      el('div', { class: 'who' }, x.ident !== 'direct' ? flagImg(parseSlot(x.ident).cc) : null, el('span', { class: 'dot', style: `background:${col.hex}` }), identLabel(x.ident)),
      el('div', { class: 'secret' }, revealed.has(x.id) ? revealed.get(x.id) : '••••••••'));
  }));
  $('neverBlock').hidden = !S.neverSave.length;
  $('neverList').replaceChildren(...S.neverSave.map((o) => el('li', { class: 'item' },
    el('div', { class: 'addr' }, hostOf(o)),
    el('div', { class: 'actions' }, el('button', { class: 'btn ghost small', onclick: () => pt.pwUnnever(o) }, 'Listeden çıkar')))));
}

function renderDrawer() {
  $('drawer').hidden = !S.drawerOpen;
  if (!S.drawerOpen) return;
  document.querySelectorAll('#drawerTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.t === drawerTab)));
  document.querySelectorAll('.drawer-body').forEach((p) => { p.hidden = p.dataset.panel !== drawerTab; });
  const focus = document.activeElement;
  if (focus && $('drawer').contains(focus) && focus.matches('.item input, .item select')) return; // yazarken yeniden çizme
  if (drawerTab === 'pool') renderPool();
  else if (drawerTab === 'ids') renderIdentities();
  else renderPasswords();
}

function renderEdges() {
  document.body.classList.toggle('edges', !!S.edge && !S.maximized);
}

function render() { renderEdges(); renderGroups(); renderTabs(); renderNav(); renderGrid(); renderPicker(); renderDrawer(); }

/* ---------- Olaylar ---------- */

$('newTab').onclick = () => pt.openPicker();
$('gridBtn').onclick = () => { if (selectMode) exitSelect(); else pt.toggleGrid(); };
$('gridAddBtn').onclick = () => { if (S.gridGroupId) pt.openPicker(null, S.gridGroupId); };
$('gridDrop').addEventListener('dragover', (e) => { if (hasTabDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; $('gridDrop').classList.add('over'); } });
$('gridDrop').addEventListener('dragleave', () => $('gridDrop').classList.remove('over'));
$('gridDrop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('gridDrop').classList.remove('over');
  const id = e.dataTransfer.getData(DND);
  if (id && S.gridGroupId) pt.addToGroup(S.gridGroupId, id, true);
});
$('selectBar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  if (b.dataset.a === 'go') { const ids = S.tabs.filter((t) => selected.has(t.id)).map((t) => t.id); exitSelect(); pt.createGroup(ids); } else exitSelect();
});
document.addEventListener('keydown', (e) => { if (selectMode && e.key === 'Escape') exitSelect(); });
pt.onSelectMode((tabId) => enterSelect(tabId || S.activeTabId));
pt.onGroupRename((id) => { renamingGroup = id; render(); });
// Sekme çubuğunun boş yerine bırakılan sekme sona eklenir (başka pencereden de)
$('tabbar').addEventListener('dragover', (e) => { if (hasTabDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
$('tabbar').addEventListener('drop', (e) => { if (!e.target.closest('.tab')) dropAt(e, S.tabs.length); });
$('tabbar').addEventListener('dblclick', (e) => { if (e.target.classList.contains('drag-space') || e.target.id === 'tabs') pt.openPicker(); });
$('back').onclick = () => pt.back();
$('forward').onclick = () => pt.forward();
$('reload').onclick = () => { const t = activeTab(); if (t && t.loading) pt.stop(); else pt.reload(); };
$('colorChip').onclick = () => { const t = activeTab(); if (t) pt.tabMenu(t.id); };
$('nextIpBtn').onclick = () => { const t = activeTab(); if (t && t.slot) pt.nextIp(t.slot); };
$('drawerBtn').onclick = () => pt.setDrawer(!S.drawerOpen);
$('drawerClose').onclick = () => pt.setDrawer(false);
document.querySelectorAll('#drawerTabs button').forEach((b) => { b.onclick = () => { drawerTab = b.dataset.t; renderDrawer(); }; });
$('notice').onclick = () => pt.clearNotice();
$('pwPrompt').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]');
  if (b) pt.pwAnswer($('pwPrompt').dataset.id, b.dataset.a);
});

$('directBtn').onclick = () => pt.choose(null);
$('pickerPool').onclick = () => { drawerTab = 'pool'; pt.setDrawer(true); };
$('pickerClose').onclick = () => pt.closePicker();
document.addEventListener('keydown', (e) => {
  if (S.pickerOpen && e.key === 'Escape' && !e.target.matches('input, textarea, select')) pt.closePicker();
});

const noteTag = $('noteTag'), noteEdit = $('noteEdit');
noteTag.onclick = () => {
  const t = activeTab(); const p = t && tabProxy(t);
  if (!p) return;
  noteEdit.value = p.note || '';
  noteEdit.dataset.id = p.id;
  noteTag.hidden = true; noteEdit.hidden = false;
  noteEdit.focus(); noteEdit.select();
};
const endNote = (save) => {
  if (noteEdit.hidden) return;
  if (save) pt.updateProxy(noteEdit.dataset.id, { note: noteEdit.value.trim() });
  noteEdit.hidden = true; noteTag.hidden = false;
  renderNav();
};
noteEdit.addEventListener('keydown', (e) => { if (e.key === 'Enter') endNote(true); if (e.key === 'Escape') endNote(false); });
noteEdit.addEventListener('blur', () => endNote(true));

const addr = $('address');
addr.addEventListener('input', () => { addressDirty = true; });
addr.addEventListener('focus', () => addr.select());
addr.addEventListener('keydown', (e) => { if (e.key === 'Escape') { addressDirty = false; renderNav(); addr.blur(); } });
$('addressForm').addEventListener('submit', (e) => {
  e.preventDefault();
  addressDirty = false;
  pt.go(addr.value);
});

$('searchSel').onchange = (e) => pt.setSettings({ search: e.target.value });
$('optSave').onchange = (e) => pt.setSettings({ savePasswords: e.target.checked });
$('optFill').onchange = (e) => pt.setSettings({ autofill: e.target.checked });
$('pwSearch').addEventListener('input', renderPasswords);
$('testAll').onclick = () => pt.testAll();
$('deleteDead').onclick = () => {
  if ((S.counts.dead || 0) && confirm(`${S.counts.dead} çöken IP havuzdan silinsin mi?`)) pt.deleteDead();
};
$('poolSearch').addEventListener('input', renderPool);
$('poolFilter').addEventListener('change', renderPool);
$('importBtn').onclick = async () => {
  const text = $('importText').value;
  if (!text.trim()) return;
  const { added, dup, bad } = await pt.importProxies(text, $('importType').value, $('importColor').value || null);
  const note = $('importNote');
  note.hidden = false;
  note.className = 'note' + (bad.length ? ' err' : '');
  note.textContent = `${added} IP eklendi, deneniyor ve ülkeleri bulunuyor.` + (dup ? ` ${dup} tekrar atlandı.` : '') +
    (bad.length ? ` Okunamayan ${bad.length} satır: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}` : '');
  $('importText').value = bad.join('\n');
};

pt.onFocusAddress(() => { addr.focus(); addr.select(); });
pt.onState((s) => { S = s; render(); });
pt.getState().then((s) => { S = s; render(); });
setInterval(renderNav, 5000);

/* ---------- Pencere kenarından boyutlandırma (Windows) ---------- */
(function resizeGrips() {
  let drag = null; let raf = 0; let pending = null;
  const flush = () => { raf = 0; if (pending) { pt.setWinBounds(pending); pending = null; } };
  document.querySelectorAll('.rz').forEach((g) => {
    g.addEventListener('pointerdown', async (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      const b = await pt.winBounds();
      if (!b) return;
      drag = { e: g.dataset.e, sx: e.screenX, sy: e.screenY, b };
    });
    g.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.screenX - drag.sx; const dy = e.screenY - drag.sy;
      const b = { ...drag.b }; const ed = drag.e;
      if (ed.includes('e')) b.width = drag.b.width + dx;
      if (ed.includes('s')) b.height = drag.b.height + dy;
      if (ed.includes('w')) { b.x = drag.b.x + dx; b.width = drag.b.width - dx; }
      if (ed.includes('n')) { b.y = drag.b.y + dy; b.height = drag.b.height - dy; }
      // En küçük boyuta gelince karşı kenar kaymasın
      if (b.width < 760) { if (ed.includes('w')) b.x = drag.b.x + drag.b.width - 760; b.width = 760; }
      if (b.height < 500) { if (ed.includes('n')) b.y = drag.b.y + drag.b.height - 500; b.height = 500; }
      pending = b;
      if (!raf) raf = requestAnimationFrame(flush);
    });
    const end = (e) => { if (drag) { try { g.releasePointerCapture(e.pointerId); } catch {} } drag = null; };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    g.addEventListener('dblclick', () => {}); // çift tık pencereyi büyütmesin diye yutulur
  });
})();
