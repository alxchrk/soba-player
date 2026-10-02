// Обновления из GitHub Releases через electron-updater: проверка при старте
// и по кнопке в окне «О плеере», скачивание в фоне, установка при выходе или
// по кнопке «Перезапустить». Состояние уходит в окно событием update-state.
'use strict';

const { app, Notification } = require('electron');

// status: idle | checking | latest | downloading | ready | error | unavailable (запуск из исходников)
let state = { status: 'idle' };
let updater = null;
let send = () => {};
let notifyText = null;

function setState(next) {
  state = next;
  send(state);
}

function getUpdater() {
  if (updater || !app.isPackaged) return updater;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => setState({ status: 'latest' }));
  autoUpdater.on('update-available', (info) => setState({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => setState({ ...state, status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'ready', version: info.version });
    // Системное уведомление видно, даже если окно плеера свёрнуто.
    if (notifyText && Notification.isSupported()) new Notification(notifyText(info.version)).show();
  });
  autoUpdater.on('error', (e) => setState({ status: 'error', message: String(e && e.message || e) }));
  updater = autoUpdater;
  return updater;
}

// onState(state): доставка состояния в окно. notification(version) → { title, body }.
function init(onState, notification) {
  send = onState;
  notifyText = notification;
}

function check() {
  const u = getUpdater();
  if (!u) {
    setState({ status: 'unavailable' });
    return state;
  }
  // Уже скачанное или скачиваемое не проверяется заново.
  if (state.status === 'downloading' || state.status === 'ready' || state.status === 'checking') return state;
  u.checkForUpdates().catch((e) => setState({ status: 'error', message: String(e && e.message || e) }));
  return state;
}

function install() {
  if (updater && state.status === 'ready') updater.quitAndInstall();
}

function current() {
  return state;
}

module.exports = { init, check, install, current };
