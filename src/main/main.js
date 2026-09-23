'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const media = require('./media');

app.setName('Soba Player');

// Язык интерфейса хранится и в main (для меню до загрузки окна), и в окне.
let prefsFile = null;
let prefs = { lang: 'en' };
function loadPrefs() {
  try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile, 'utf8')) }; } catch (_) {}
}
function savePrefs() {
  try { fs.writeFileSync(prefsFile, JSON.stringify(prefs)); } catch (_) {}
}

// Подписи ролей задаются явно: Electron берёт их из локали системы, а не из
// выбранного в приложении языка.
const MENU_LABELS = {
  en: {
    settings: 'Settings…', shortcuts: 'Keyboard Shortcuts', file: 'File', open: 'Open…', edit: 'Edit', view: 'View',
    fullscreen: 'Toggle Full Screen', window: 'Window', about: 'About Soba Player',
    hide: 'Hide Soba Player', hideOthers: 'Hide Others', unhide: 'Show All', quit: 'Quit Soba Player',
    undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    minimize: 'Minimize', zoom: 'Zoom', close: 'Close Window',
  },
  ru: {
    settings: 'Настройки…', shortcuts: 'Горячие клавиши', file: 'Файл', open: 'Открыть…', edit: 'Правка', view: 'Вид',
    fullscreen: 'Полноэкранный режим', window: 'Окно', about: 'О программе Soba Player',
    hide: 'Скрыть Soba Player', hideOthers: 'Скрыть остальные', unhide: 'Показать все', quit: 'Завершить Soba Player',
    undo: 'Отменить', redo: 'Повторить', cut: 'Вырезать', copy: 'Скопировать', paste: 'Вставить', selectAll: 'Выбрать все',
    minimize: 'Свернуть', zoom: 'Изменить масштаб', close: 'Закрыть окно',
  },
};

// Верхнее меню macOS: имя приложения, настройки (Cmd+,), файл, правка для полей
// ввода, вид и окно.
function buildAppMenu() {
  const L = MENU_LABELS[prefs.lang] || MENU_LABELS.en;
  const template = [
    {
      label: 'Soba Player',
      submenu: [
        // Своё окно внутри плеера: системную панель накрывает закреплённое
        // «поверх всех окон» окно, и её не видно.
        { label: L.about, click: () => win && win.webContents.send('open-about') },
        { type: 'separator' },
        { label: L.settings, accelerator: 'CmdOrCtrl+,', click: () => win && win.webContents.send('open-settings') },
        { label: L.shortcuts, accelerator: 'CmdOrCtrl+/', click: () => win && win.webContents.send('open-shortcuts') },
        { type: 'separator' },
        { role: 'hide', label: L.hide },
        { role: 'hideOthers', label: L.hideOthers },
        { role: 'unhide', label: L.unhide },
        { type: 'separator' },
        { role: 'quit', label: L.quit },
      ],
    },
    {
      label: L.file,
      submenu: [
        { label: L.open, accelerator: 'CmdOrCtrl+O', click: () => win && win.webContents.send('open-dialog-request') },
      ],
    },
    {
      label: L.edit,
      submenu: [
        { role: 'undo', label: L.undo }, { role: 'redo', label: L.redo }, { type: 'separator' },
        { role: 'cut', label: L.cut }, { role: 'copy', label: L.copy }, { role: 'paste', label: L.paste },
        { role: 'selectAll', label: L.selectAll },
      ],
    },
    {
      label: L.view,
      submenu: [
        { label: L.fullscreen, accelerator: 'Ctrl+Cmd+F', click: () => win && win.setFullScreen(!win.isFullScreen()) },
      ],
    },
    {
      label: L.window, role: 'window',
      submenu: [{ role: 'minimize', label: L.minimize }, { role: 'zoom', label: L.zoom }, { role: 'close', label: L.close }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const TMP_DIR = path.join(os.tmpdir(), 'torrent-player');

let win = null;
let shown = false;
let pendingOpen = null;

// Реестр папок раздач, скачанных приложением в эту сессию (в том числе в
// выбранную пользователем папку). Скачанное это кэш: удаляется при выходе,
// а не при переключении. Список пишется на диск, чтобы очистить хвосты после
// аварийного закрытия. Удаляются только данные раздач, чужие файлы не трогаются.
let cleanupFile = null;
let pendingCleanup = [];

function loadCleanup() {
  try { return JSON.parse(fs.readFileSync(cleanupFile, 'utf8')); } catch (_) { return []; }
}
function saveCleanup() {
  try { fs.writeFileSync(cleanupFile, JSON.stringify(pendingCleanup)); } catch (_) {}
}
function recordStore(root) {
  if (root && !pendingCleanup.includes(root)) {
    pendingCleanup.push(root);
    saveCleanup();
  }
}
function cleanupStores(roots) {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

// Запоминание размера и позиции окна (по умолчанию выключено). Флаг и границы
// хранятся так, чтобы main мог применить их при создании окна.
let windowStateFile = null;
let windowState = { remember: false, bounds: null };
let saveBoundsTimer = null;
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(windowStateFile, 'utf8')); } catch (_) { return { remember: false, bounds: null }; }
}
function saveWindowState() {
  try { fs.writeFileSync(windowStateFile, JSON.stringify(windowState)); } catch (_) {}
}
// В полном экране размеры не запоминаются: иначе после выхода окно открывалось
// бы во весь экран, остаётся последний обычный размер.
function rememberBounds() {
  if (!windowState.remember || !win || win.isFullScreen()) return;
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (win && !win.isFullScreen()) { windowState.bounds = win.getBounds(); saveWindowState(); }
  }, 400);
}

// Открыть источник в окне; если окно ещё не готово, запомнить и открыть позже.
function deliverOpen(src) {
  if (shown && win) win.webContents.send('open-source', src);
  else pendingOpen = src;
}

// macOS передаёт magnet-ссылку через open-url, а .torrent через open-file.
app.on('open-url', (e, url) => { e.preventDefault(); deliverOpen(url); });
app.on('open-file', (e, filePath) => { e.preventDefault(); deliverOpen(filePath); });

function createWindow() {
  const b = (windowState.remember && windowState.bounds) || {};
  win = new BrowserWindow({
    width: b.width || 950,
    height: b.height || 550,
    x: b.x,
    y: b.y,
    minWidth: 160,
    minHeight: 90,
    backgroundColor: '#000000',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      // Скрытое окно (свёрнуто, другой рабочий стол) не должно считаться фоновым:
      // иначе Chromium отключает видеодорожку и при возврате перезапрашивает
      // живой поток транскода с начала, видео уезжает от звука.
      backgroundThrottling: false,
    },
  });
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Щипок используется для полного экрана, а не для масштабирования страницы.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.once('ready-to-show', () => {
    win.show();
    shown = true;
    // Источник из аргументов запуска: magnet-ссылка или существующий файл.
    // В собранном приложении argv[0] это сам исполняемый файл, в dev ещё и «.»,
    // они источником не считаются.
    const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && a !== '.');
    const autoOpen = process.env.TP_OPEN || args.find((a) => /^magnet:/i.test(a) || fs.existsSync(a)) || null;
    const src = pendingOpen || autoOpen;
    if (src) win.webContents.send('open-source', src);
    pendingOpen = null;
  });
  win.on('closed', () => (win = null));

  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));
}

app.on('ready', () => {
  cleanupFile = path.join(app.getPath('userData'), 'pending-cleanup.json');
  windowStateFile = path.join(app.getPath('userData'), 'window-state.json');
  windowState = loadWindowState();
  prefsFile = path.join(app.getPath('userData'), 'prefs.json');
  loadPrefs();
  media.setSubsCacheDir(path.join(app.getPath('userData'), 'subtitles-cache'));
  // Хвосты от прошлой сессии: если приложение закрылось аварийно, before-quit
  // мог не отработать. Удаляем записанные раздачи и временную папку.
  cleanupStores(loadCleanup());
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  pendingCleanup = [];
  saveCleanup();
  buildAppMenu();
  // В собранном .app иконку даёт бандл; при запуске из исходников док
  // показывает иконку Electron, подменяем её на свою.
  if (!app.isPackaged && app.dock) {
    app.dock.setIcon(path.join(__dirname, '..', '..', 'build', 'icon.png'));
  }
  createWindow();
  // Обновления из GitHub Releases: проверка через полминуты после старта,
  // скачивание в фоне, установка при следующем запуске (уведомление системы).
  if (app.isPackaged) {
    setTimeout(() => {
      try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.logger = null;
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      } catch (_) {}
    }, 30000);
  }
});

app.on('window-all-closed', async () => {
  await media.destroyCurrent();
  app.quit();
});

app.on('before-quit', () => {
  // Удаляем всё скачанное этой сессией (временную папку и раздачи в выбранных
  // папках), затем очищаем реестр.
  cleanupStores(pendingCleanup);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  pendingCleanup = [];
  saveCleanup();
});

// --- IPC --------------------------------------------------------------------

const VIDEO_EXTS = ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', 'ogv', '3gp'];

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video and Torrent', extensions: ['torrent', ...VIDEO_EXTS] },
      { name: 'Video', extensions: VIDEO_EXTS },
      { name: 'Torrent', extensions: ['torrent'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths;
});

ipcMain.handle('add-torrent', async (_e, source, savePath) => {
  const dir = savePath || TMP_DIR;
  const info = await media.addTorrent(source, dir);
  // Локальный файл (infoHash null) ничего не скачивает, чистить нечего. Папка,
  // существовавшая до открытия, остаётся: удалять чужие данные нельзя.
  if (info.infoHash && !info.preexisting) recordStore(path.join(dir, info.name));
  return info;
});

// Папка по умолчанию (временная, чистится при выходе).
ipcMain.handle('default-download-path', () => TMP_DIR);

// Диалог выбора папки для сохранения.
ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('prepare', async (_e, index) => {
  return media.prepare(index);
});

ipcMain.handle('play-url', (_e, index, seekSec, audioTrack) => {
  return media.playUrl(index, seekSec, audioTrack);
});

ipcMain.handle('subs-url', (_e, index, track, fromSec) => {
  return media.subsUrl(index, track, fromSec);
});

// Выбор файла субтитров и его конвертация в WebVTT.
ipcMain.handle('choose-subtitle', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Subtitles', extensions: ['srt', 'ass', 'ssa', 'sub', 'smi', 'vtt'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('external-subs', (_e, filePath) => media.externalSubs(filePath));

// Онлайн-поиск субтитров на OpenSubtitles по ключу пользователя (новый REST API
// требует бесплатный ключ приложения). Это единственный внешний вызов, только
// по явному действию.
function osHeaders(apiKey) {
  return { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'SobaPlayer v' + app.getVersion() };
}
ipcMain.handle('search-subtitles', async (_e, apiKey, query) => {
  const q = String(query || '').replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim();
  const res = await fetch('https://api.opensubtitles.com/api/v1/subtitles?query=' + encodeURIComponent(q), {
    headers: osHeaders(apiKey),
  });
  if (!res.ok) throw new Error('search failed ' + res.status);
  const json = await res.json();
  const out = [];
  for (const item of json.data || []) {
    const a = item.attributes || {};
    const file = (a.files && a.files[0]) || {};
    if (!file.file_id) continue;
    out.push({
      file_id: file.file_id,
      language: a.language || '',
      label: [a.language, a.release || file.file_name].filter(Boolean).join(' - '),
    });
  }
  // Русские и английские субтитры показываем первыми.
  const rank = (l) => (l === 'ru' ? 0 : l === 'en' ? 1 : 2);
  out.sort((x, y) => rank(x.language) - rank(y.language));
  return out.slice(0, 30);
});
ipcMain.handle('download-subtitle', async (_e, apiKey, fileId) => {
  const res = await fetch('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST', headers: osHeaders(apiKey), body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) throw new Error('download failed ' + res.status);
  const { link } = await res.json();
  const text = await (await fetch(link)).text();
  const tmp = path.join(app.getPath('temp'), 'os-sub-' + Date.now() + '.srt');
  fs.writeFileSync(tmp, text);
  let vtt;
  try { vtt = await media.externalSubs(tmp); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  // Готовый WebVTT хранится в данных приложения, чтобы при следующем открытии
  // раздачи подхватить те же субтитры без повторного запроса.
  const dir = path.join(app.getPath('userData'), 'subtitles');
  fs.mkdirSync(dir, { recursive: true });
  const saved = path.join(dir, 'os-' + fileId + '.vtt');
  fs.writeFileSync(saved, vtt);
  return { vtt, path: saved };
});

// Сохранить полностью скачанный файл в место, выбранное пользователем. Копия не
// попадает в реестр очистки. Диалог открывается в папке кэша раздачи.
ipcMain.handle('save-file', async (_e, index) => {
  const src = media.filePath(index);
  if (!src) return null;
  const r = await dialog.showSaveDialog(win, { defaultPath: src });
  if (r.canceled || !r.filePath || r.filePath === src) return null;
  await fs.promises.copyFile(src, r.filePath);
  return r.filePath;
});

ipcMain.handle('cache-subtitles', (_e, index, track) => media.cacheSubtitles(index, track));

ipcMain.handle('prefetch', (_e, index, bytes) => {
  media.prefetchBytes(index, bytes);
});

ipcMain.handle('file-progress', (_e, index) => {
  return media.fileProgress(index);
});

ipcMain.handle('torrent-stats', () => media.stats());

ipcMain.handle('set-language', (_e, lang) => {
  const l = lang === 'ru' ? 'ru' : 'en';
  if (prefs.lang !== l) {
    prefs.lang = l;
    savePrefs();
    buildAppMenu();
  }
});

// Окно подгоняется под пропорции видео: ширина остаётся, высота по кадру,
// без полос сверху и снизу; ручное изменение размера держит пропорцию.
// На главном экране пропорция снимается.
ipcMain.handle('fit-aspect', (_e, w, h) => {
  if (!win || !w || !h) return;
  if (win.isFullScreen() || win.isMaximized()) return;
  const ratio = w / h;
  win.setAspectRatio(ratio);
  const [cw] = win.getSize();
  const { workArea } = require('electron').screen.getDisplayMatching(win.getBounds());
  let width = cw;
  let height = Math.round(width / ratio);
  if (height > workArea.height) { height = workArea.height; width = Math.round(height * ratio); }
  win.setSize(width, height, true);
});
ipcMain.handle('clear-aspect', () => { if (win) win.setAspectRatio(0); });

// Показать сохранённый файл в Finder.
ipcMain.handle('show-in-folder', (_e, p) => { if (p) shell.showItemInFolder(p); });

// Кнопки окна (закрыть, свернуть, развернуть) прячутся вместе с контролами.
ipcMain.handle('set-window-buttons', (_e, visible) => {
  if (win && !win.isFullScreen()) win.setWindowButtonVisibility(!!visible);
});

ipcMain.handle('toggle-fullscreen', () => {
  if (win) win.setFullScreen(!win.isFullScreen());
});

ipcMain.handle('exit-fullscreen', () => {
  if (win && win.isFullScreen()) win.setFullScreen(false);
});

// Закрепить окно поверх всех окон.
ipcMain.handle('set-always-on-top', (_e, on) => {
  if (win) win.setAlwaysOnTop(!!on);
  return !!on;
});

ipcMain.handle('app-version', () => app.getVersion());

// Показывать окно на всех виртуальных рабочих столах (Spaces).
ipcMain.handle('set-all-desktops', (_e, on) => {
  // skipTransformProcessType: без него Electron переводит процесс в UIElement,
  // и приложение теряет иконку в доке и меню у яблока.
  if (win) win.setVisibleOnAllWorkspaces(!!on, { visibleOnFullScreen: true, skipTransformProcessType: true });
  return !!on;
});

// Запоминание размера и позиции окна.
ipcMain.handle('get-remember-window', () => windowState.remember);
ipcMain.handle('set-remember-window', (_e, on) => {
  windowState.remember = !!on;
  if (on && win && !win.isFullScreen()) windowState.bounds = win.getBounds();
  saveWindowState();
  return windowState.remember;
});

// Обработчик по умолчанию для magnet-ссылок. Ассоциация с .torrent задаётся в
// Info.plist собранного приложения; здесь регистрируется протокол magnet.
// Ссылки автора из настроек открываются в браузере; разрешены только они.
const EXTERNAL_LINKS = ['https://t.me/alxchrk', 'https://github.com/alxchrk', 'https://www.opensubtitles.com/en/consumers'];
ipcMain.handle('open-external', (_e, url) => {
  if (EXTERNAL_LINKS.includes(url)) return shell.openExternal(url);
});

ipcMain.handle('is-default-handler', () => app.isDefaultProtocolClient('magnet'));
ipcMain.handle('make-default-handler', () => {
  app.setAsDefaultProtocolClient('magnet');
  return app.isDefaultProtocolClient('magnet');
});
ipcMain.handle('remove-default-handler', () => {
  app.removeAsDefaultProtocolClient('magnet');
  return app.isDefaultProtocolClient('magnet');
});
