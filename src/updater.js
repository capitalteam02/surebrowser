// Otomatik güncelleme.
// Sürümler GitHub Releases'a yayınlanır (bkz. .github/workflows/release.yml).
// Windows: güncelleme indirilir ve kurulur. macOS: imzasız uygulama kendini güncelleyemez,
// bu yüzden yeni sürüm bildirilir ve indirme sayfası açılır.
const { app, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

let autoUpdater = null;
let opts = null;
let busy = false;
let releasePage = null;

function feedFile() {
  return path.join(process.resourcesPath || '', 'app-update.yml');
}

function readFeed() {
  try {
    const y = fs.readFileSync(feedFile(), 'utf8');
    const owner = (y.match(/^owner:\s*(.+)$/m) || [])[1];
    const repo = (y.match(/^repo:\s*(.+)$/m) || [])[1];
    if (!owner || !repo || /BURAYA|OWNER/i.test(owner)) return null;
    return { owner: owner.trim(), repo: repo.trim() };
  } catch { return null; }
}

const win = () => (opts && opts.getWindow && opts.getWindow()) || undefined;

async function onAvailable(info) {
  const isMac = process.platform === 'darwin';
  const { response } = await dialog.showMessageBox(win(), {
    type: 'info',
    title: 'Yeni güncelleme var',
    message: `SureBrowser ${info.version} hazır`,
    detail: `Şu an kullandığınız sürüm: ${app.getVersion()}.` + (isMac
      ? '\n\nİndirme sayfası açılacak. Yeni sürümü indirip Uygulamalar klasörüne sürükleyin; sekmeleriniz, şifreleriniz ve IP\'leriniz korunur.'
      : '\n\nGüncelleme indirilip kurulur. Sekmeleriniz, şifreleriniz ve IP\'leriniz korunur.'),
    buttons: [isMac ? 'İndirme sayfasını aç' : 'Güncelle', 'Sonra'],
    defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return;
  if (isMac) { if (releasePage) shell.openExternal(releasePage); return; }
  busy = true;
  autoUpdater.downloadUpdate().catch((e) => { busy = false; showError(e); });
}

async function onDownloaded(info) {
  busy = false;
  const w = win();
  if (w) w.setProgressBar(-1);
  const { response } = await dialog.showMessageBox(w, {
    type: 'info', title: 'Güncelleme hazır',
    message: `SureBrowser ${info.version} indirildi`,
    detail: 'Şimdi yeniden başlatılıp kurulsun mu? "Sonra" derseniz uygulamayı kapattığınızda kurulur.',
    buttons: ['Yeniden başlat ve kur', 'Sonra'], defaultId: 0, cancelId: 1,
  });
  if (response === 0) {
    if (opts.beforeInstall) opts.beforeInstall();
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }
}

function showError(e) {
  const w = win();
  if (w) w.setProgressBar(-1);
  dialog.showMessageBox(w, { type: 'warning', title: 'Güncelleme', message: 'Güncelleme yapılamadı', detail: String((e && e.message) || e).slice(0, 400) });
}

function init(o) {
  opts = o;
  if (!app.isPackaged) return;
  const feed = readFeed();
  if (!feed) return; // yerel derleme: güncelleme adresi yok
  releasePage = `https://github.com/${feed.owner}/${feed.repo}/releases/latest`;
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', onAvailable);
  autoUpdater.on('update-downloaded', onDownloaded);
  autoUpdater.on('download-progress', (p) => { const w = win(); if (w) w.setProgressBar(Math.max(0, Math.min(1, p.percent / 100))); });
  autoUpdater.on('error', (e) => { if (busy) { busy = false; showError(e); } });
  // Açılışta ve sonra 4 saatte bir denetle
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
  setInterval(() => { if (!busy) autoUpdater.checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000);
}

async function checkNow(w) {
  if (!autoUpdater) {
    dialog.showMessageBox(w, { type: 'info', message: 'Güncelleme denetimi bu kopyada kapalı', detail: 'Bu kopya yerelde derlendi. Güncellemeler, GitHub üzerinden yayınlanan sürümlerde çalışır.' });
    return;
  }
  try {
    const r = await autoUpdater.checkForUpdates();
    const latest = r && r.updateInfo && r.updateInfo.version;
    if (!latest || latest === app.getVersion()) {
      dialog.showMessageBox(w, { type: 'info', message: 'SureBrowser güncel', detail: `Sürüm ${app.getVersion()}` });
    }
  } catch (e) { showError(e); }
}

module.exports = { init, checkNow };
