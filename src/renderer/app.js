'use strict';

const homeEl = document.getElementById('home');
const playerEl = document.getElementById('player');
const dropOverlay = document.getElementById('drop-overlay');
const player = new window.Player(playerEl);

function showPlayer() {
  homeEl.classList.add('hidden');
  playerEl.classList.remove('hidden');
}

// Память просмотра: последняя серия и позиция в каждой серии, по ключу раздачи.
// { key: { lastIndex, positions: { [fileIndex]: seconds } } }
function loadResume() {
  try { return JSON.parse(localStorage.getItem('resume') || '{}'); } catch (_) { return {}; }
}
function saveResume() {
  try { localStorage.setItem('resume', JSON.stringify(resume)); } catch (_) {}
}
const resume = loadResume();
function resumeKey(info) { return info.infoHash || info.name; }

// Последний открытый источник и его прогресс, чтобы предложить продолжить.
function loadLastSession() {
  try { return JSON.parse(localStorage.getItem('lastSession') || 'null'); } catch (_) { return null; }
}
let lastSession = loadLastSession();
function saveLastSession() {
  try { localStorage.setItem('lastSession', JSON.stringify(lastSession)); } catch (_) {}
}

// Одна строка «продолжить», если последнее не досмотрено (между 2% и 90%).
function refreshContinue() {
  const el = document.getElementById('continue');
  if (lastSession && lastSession.fraction > 0.02 && lastSession.fraction < 0.9) {
    el.innerHTML = '<span></span> <b></b>';
    el.querySelector('span').textContent = t('continueWatching');
    el.querySelector('b').textContent = lastSession.name;
    el.classList.remove('hidden');
    el.onclick = () => openSource(lastSession.source);
  } else {
    el.classList.add('hidden');
  }
}

// Естественная сортировка по имени: Серия 2 идёт перед Серия 10.
function sortEpisodes(files) {
  return files
    .filter((f) => f.video)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

let currentInfo = null;
let episodes = [];
let currentListPos = 0;
let currentDur = 0;
let prefetchedFrom = -1; // с какой позиции плейлиста уже начата предзагрузка следующей

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function showError(msg, canWait) {
  document.getElementById('loader').classList.add('hidden');
  document.getElementById('error-message').textContent = msg;
  document.getElementById('error-wait').classList.toggle('hidden', !canWait);
  document.getElementById('error-overlay').classList.remove('hidden');
}

// Ждать сидов дальше или вернуться на главный. Разрешается нажатием одной из
// кнопок экрана ошибки.
function askKeepWaiting() {
  return new Promise((resolve) => {
    const waitBtn = document.getElementById('error-wait');
    const backBtn = document.getElementById('error-back');
    const done = (v) => {
      waitBtn.removeEventListener('click', onWait);
      backBtn.removeEventListener('click', onBack);
      resolve(v);
    };
    const onWait = () => done(true);
    const onBack = () => done(false);
    waitBtn.addEventListener('click', onWait);
    backBtn.addEventListener('click', onBack);
  });
}

function goHome() {
  openGen++;
  currentInfo = null;
  episodes = [];
  document.getElementById('error-overlay').classList.add('hidden');
  document.getElementById('dl-stats').classList.add('hidden');
  document.getElementById('dl-info').classList.add('hidden');
  playerEl.classList.add('hidden');
  homeEl.classList.remove('hidden');
  window.api.setWindowButtons(true);
  window.api.clearAspect();
  refreshContinue();
}
document.getElementById('error-back').addEventListener('click', goHome);

// Номер текущего открытия: после каждого ожидания проверяется, что пользователь
// не открыл другой источник и не вернулся на главный, иначе шаги старого
// открытия продолжили бы работать с чужим состоянием.
let openGen = 0;

// Пока идёт открытие источника или серии, позиция не сохраняется: иначе время
// прежнего видео записалось бы под ключ нового и новое открылось бы с него.
let opening = false;

async function openSource(source) {
  const gen = ++openGen;
  opening = true;
  try {
    await openSourceInner(source, gen);
  } finally {
    if (gen === openGen) opening = false;
  }
}

async function openSourceInner(source, gen) {
  // Куда сохранять: спросить каждый раз, либо путь по умолчанию, либо временная
  // папка (null → main подставит временную).
  let savePath = null;
  if (localStorage.getItem('askPathEachTime') === '1') {
    savePath = await window.api.chooseFolder();
    if (!savePath) return; // отменили выбор папки
  } else {
    savePath = localStorage.getItem('downloadPath') || null;
  }
  document.getElementById('error-overlay').classList.add('hidden');
  document.getElementById('loader').classList.remove('hidden');
  let info;
  try {
    info = await window.api.addTorrent(source, savePath);
  } catch (_) {
    if (gen !== openGen) return;
    showPlayer();
    showError(t('errOpen'));
    return;
  }
  if (gen !== openGen) return;
  currentInfo = info;
  startupStatus = !!info.infoHash;
  episodes = sortEpisodes(currentInfo.files);
  if (!episodes.length) {
    showPlayer();
    showError(t('errNoVideo'));
    return;
  }
  lastSession = { source, name: currentInfo.name, fraction: 0 };
  saveLastSession();
  showPlayer();
  // Продолжить с последней серии, если раздача уже открывалась.
  const saved = resume[resumeKey(currentInfo)];
  let startPos = 0;
  if (saved && saved.lastIndex != null) {
    const i = episodes.findIndex((e) => e.index === saved.lastIndex);
    if (i >= 0) startPos = i;
  }
  await openEpisode(startPos);
}

async function openEpisode(listPos) {
  const gen = ++openGen;
  opening = true;
  try {
    await openEpisodeInner(listPos, gen);
  } finally {
    if (gen === openGen) opening = false;
  }
}

async function openEpisodeInner(listPos, gen) {
  currentListPos = listPos;
  prefetchedFrom = -1;
  const ep = episodes[listPos];
  document.getElementById('loader').classList.remove('hidden');
  // Мёртвая раздача (нет сидов): через 2 минуты вместо спиннера выбор, ждать ещё
  // или открыть другой торрент. Ожидание продолжает тот же запрос.
  const pending = window.api.prepare(ep.index);
  let prepared;
  for (;;) {
    try {
      prepared = await withTimeout(pending, 120000, 'timeout');
      break;
    } catch (e) {
      if (gen !== openGen) return;
      if (e.message !== 'timeout') {
        showError(t('errPlayback'));
        return;
      }
      showError(t('errNoSeeders'), true);
      const wait = await askKeepWaiting();
      if (!wait || gen !== openGen) return;
      document.getElementById('error-overlay').classList.add('hidden');
      document.getElementById('loader').classList.remove('hidden');
    }
  }
  if (gen !== openGen) return;
  currentDur = prepared.probe.durationSec || 0;
  const savedAudio = (resume[resumeKey(currentInfo)] || {}).audio || 0;
  await player.open(ep.index, prepared, ep.name, savedAudio);
  if (gen !== openGen) return;
  player.setPlaylist(episodes, listPos, openEpisode);

  const key = resumeKey(currentInfo);
  resume[key] = resume[key] || { positions: {} };
  resume[key].lastIndex = ep.index;
  saveResume();
  player.restoreSubtitle(resume[key].subs);

  // Продолжить с сохранённой позиции, если она не в самом начале и не в конце.
  const pos = resume[key].positions[ep.index];
  const dur = prepared.probe.durationSec;
  if (pos && pos > 5 && (!dur || pos < dur - 10)) {
    await player.surface.seek(pos);
  }
}

// Кнопки окна macOS прячутся вместе с контролами плеера.
player.onControlsVisible = (v) => window.api.setWindowButtons(v);

// Выбранные субтитры запоминаются по раздаче (дорожка, свой файл или скачанные).
player.onSubsChange = (choice) => {
  if (!currentInfo) return;
  const key = resumeKey(currentInfo);
  resume[key] = resume[key] || { positions: {} };
  resume[key].subs = choice || null;
  saveResume();
};

// Выбранная аудиодорожка тоже запоминается по раздаче: сериал с несколькими
// озвучками продолжается той же дорожкой в каждой серии.
player.onAudioChange = (track) => {
  if (!currentInfo) return;
  const key = resumeKey(currentInfo);
  resume[key] = resume[key] || { positions: {} };
  resume[key].audio = track;
  saveResume();
};

// Автопереход к следующей серии в конце текущей.
player.onEnded = () => {
  if (currentListPos + 1 < episodes.length) openEpisode(currentListPos + 1);
};

// Сохранить позицию в текущей серии (по ключу раздачи, переживает перезапуск).
function savePosition() {
  if (opening || !currentInfo || !episodes.length) return;
  const ep = episodes[currentListPos];
  const t = player.surface.currentTime;
  if (!t) return;
  const key = resumeKey(currentInfo);
  resume[key] = resume[key] || { positions: {} };
  resume[key].positions[ep.index] = t;
  saveResume();
  if (lastSession && currentDur) {
    lastSession.fraction = t / currentDur;
    saveLastSession();
  }
}

// Предзагрузить начало следующей серии, начиная с 80% текущей.
function maybePrefetchNext() {
  if (localStorage.getItem('prefetchNext') === '0') return;
  if (episodes.length < 2 || currentListPos + 1 >= episodes.length) return;
  if (prefetchedFrom === currentListPos || !currentDur) return;
  const t = player.surface.currentTime;
  if (t < 0.8 * currentDur) return;
  prefetchedFrom = currentListPos;
  const cur = episodes[currentListPos];
  const next = episodes[currentListPos + 1];
  // Байты на 3 минуты по битрейту текущей серии.
  const bitrate = cur.length / currentDur;
  const bytes = Math.round(bitrate * 180);
  window.api.prefetch(next.index, bytes);
}

setInterval(() => {
  if (!currentInfo || player.surface.paused) return;
  savePosition();
  maybePrefetchNext();
}, 5000);

// Досохранить позицию при паузе и перед закрытием, чтобы не терять последние секунды.
document.getElementById('video').addEventListener('pause', savePosition);
window.addEventListener('beforeunload', savePosition);

// Инфо о закачке в нижнем баре, справа от имени: i-кнопка показывает и прячет.
const dlStats = document.getElementById('dl-stats');
const dlInfo = document.getElementById('dl-info');
function fmtSpeed(bps) {
  if (bps > 1e6) return (bps / 1e6).toFixed(1) + ' MB/s';
  if (bps > 1e3) return Math.round(bps / 1e3) + ' KB/s';
  return Math.round(bps) + ' B/s';
}
// Пока статус показан в углу, нижний статус и кнопка «i» спрятаны; когда угол
// гаснет, снизу возвращается только «i» со свёрнутым статусом.
function applyDlVisibility(hasStats) {
  const cornerShown = document.getElementById('corner-dl').classList.contains('show');
  if (!hasStats || cornerShown) { dlInfo.classList.add('hidden'); dlStats.classList.add('hidden'); return; }
  dlInfo.classList.remove('hidden');
  dlStats.classList.toggle('hidden', localStorage.getItem('dlStatsOpen') !== '1');
}
dlInfo.addEventListener('click', () => {
  const open = localStorage.getItem('dlStatsOpen') !== '1';
  localStorage.setItem('dlStatsOpen', open ? '1' : '0');
  dlStats.classList.toggle('hidden', !open);
});

// Статус в правом верхнем углу: через 30 с после паузы или через 10 с остановки
// потока; гаснет при возобновлении. Ниже заметка о полностью скачанном файле.
const cornerDl = document.getElementById('corner-dl');
const cornerNote = document.getElementById('corner-note');
const saveFileBtn = document.getElementById('save-file');
const videoEl = document.getElementById('video');
let pauseTimer = null;
let stallTimer = null;
let hasStats = false;
function showCornerDl() {
  if (!hasStats) return;
  cornerDl.classList.add('show');
  applyDlVisibility(true);
}
function hideCornerDl() {
  clearTimeout(pauseTimer);
  clearTimeout(stallTimer);
  startupStatus = false;
  if (cornerDl.classList.contains('show')) {
    cornerDl.classList.remove('show');
    localStorage.setItem('dlStatsOpen', '0');
    applyDlVisibility(hasStats);
  }
}
// Первая подкачка раздачи: статус виден с самого начала, пока не пойдёт
// воспроизведение или не скачается 10 МБ.
let startupStatus = false;
const STARTUP_BYTES = 10 * 1024 * 1024;
videoEl.addEventListener('pause', () => { clearTimeout(pauseTimer); pauseTimer = setTimeout(showCornerDl, 30000); });
videoEl.addEventListener('play', hideCornerDl);
videoEl.addEventListener('waiting', () => { clearTimeout(stallTimer); stallTimer = setTimeout(showCornerDl, 10000); });
videoEl.addEventListener('playing', hideCornerDl);

// Заметка в углу гаснет сама через 20 с; текст стирается, иначе невидимая
// ссылка «Показать в Finder» продолжает ловить клики.
const NOTE_MS = 20000;
let noteTimer = null;
function hideCornerNote() {
  clearTimeout(noteTimer);
  cornerNote.classList.remove('show');
  cornerNote.textContent = '';
}
function showCornerNote(text, link) {
  hideCornerNote();
  cornerNote.textContent = text;
  if (link) cornerNote.appendChild(link);
  cornerNote.classList.add('show');
  noteTimer = setTimeout(hideCornerNote, NOTE_MS);
}

let fullyDownloaded = false;
let cachedSubsKey = null;
function setFullyDownloaded(on) {
  if (on === fullyDownloaded) return;
  fullyDownloaded = on;
  saveFileBtn.classList.toggle('hidden', !on);
  if (on) showCornerNote(t('fullyDownloaded'));
  else hideCornerNote();
}
saveFileBtn.addEventListener('click', async () => {
  const dest = await window.api.saveFile(episodes[currentListPos].index);
  if (!dest) return;
  const link = document.createElement('button');
  link.className = 'corner-link';
  link.textContent = t('showInFinder');
  link.addEventListener('click', () => window.api.showInFolder(dest));
  showCornerNote(t('savedTo') + ' ' + dest.split('/').slice(0, -1).join('/') + ' ', link);
});

// Полоса загрузки и статус.
setInterval(async () => {
  if (!currentInfo || !episodes.length) { applyDlVisibility(false); hasStats = false; hideCornerDl(); setFullyDownloaded(false); return; }
  let frac = 0;
  try {
    frac = await window.api.fileProgress(episodes[currentListPos].index);
    player.setDownloadProgress(frac);
  } catch (_) {}
  // Файл на диске целиком (скачан или локальный): выбранная дорожка субтитров
  // уходит в кэш, следующее открытие обходится без ffmpeg.
  if (frac >= 0.999 && player.subTrack != null) {
    const key = resumeKey(currentInfo) + ':' + episodes[currentListPos].index + ':' + player.subTrack;
    if (cachedSubsKey !== key) { cachedSubsKey = key; window.api.cacheSubtitles(episodes[currentListPos].index, player.subTrack); }
  }
  try {
    const st = await window.api.torrentStats();
    hasStats = !!st;
    if (st) {
      const text = `${st.peers} ${t('peers')} · ${fmtSpeed(st.downloadSpeed)} · ${Math.round(st.progress * 100)}%`;
      dlStats.textContent = text;
      cornerDl.textContent = text;
      applyDlVisibility(true);
      if (startupStatus) {
        if (st.downloaded >= STARTUP_BYTES) hideCornerDl();
        else showCornerDl();
      }
      setFullyDownloaded(frac >= 0.999);
    } else {
      applyDlVisibility(false);
      hideCornerDl();
      setFullyDownloaded(false);
    }
  } catch (_) {}
}, 1500);

const VIDEO_RE = /\.(mkv|mp4|m4v|avi|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg|ogv|3gp)$/i;

// Один путь или список: один файл открываем как есть, несколько как плейлист.
function openPaths(paths) {
  if (!paths || !paths.length) return;
  if (paths.length === 1) return openSource(paths[0]);
  const videos = paths.filter((p) => VIDEO_RE.test(p));
  openSource(videos.length ? videos : paths[0]);
}

async function chooseAndOpen() {
  const files = await window.api.openDialog();
  openPaths(files);
}
document.getElementById('open-file').addEventListener('click', chooseAndOpen);
document.getElementById('open-more').addEventListener('click', chooseAndOpen);
window.api.onOpenDialog(chooseAndOpen);

// Перетаскивание файлов или magnet-ссылки.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('hidden');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) dropOverlay.classList.add('hidden');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.classList.add('hidden');
  const paths = Array.from(e.dataTransfer.files).map((f) => window.api.pathForFile(f)).filter(Boolean);
  const text = e.dataTransfer.getData('text/plain');
  // Файл субтитров, брошенный во время просмотра, подключается к текущему видео.
  if (paths.length === 1 && currentInfo && /\.(srt|ass|ssa|sub|vtt)$/i.test(paths[0])) player.loadExternalSubtitlePath(paths[0]);
  else if (paths.length) openPaths(paths);
  else if (text && /^(magnet:|https?:)/i.test(text.trim())) openSource(text.trim());
});

window.api.onFullscreen((v) => {
  document.body.classList.toggle('fullscreen', v);
});

window.api.onOpenSource((src) => openSource(src));

// Закрепление поверх всех окон: кнопка в панели, состояние сохраняется.
const pinButton = document.getElementById('pin');
function applyAlwaysOnTop(on) {
  window.api.setAlwaysOnTop(on);
  pinButton.classList.toggle('active', on);
}
pinButton.addEventListener('click', () => {
  const on = !(localStorage.getItem('alwaysOnTop') === '1');
  localStorage.setItem('alwaysOnTop', on ? '1' : '0');
  applyAlwaysOnTop(on);
});

// Применить сохранённые оконные настройки при запуске.
applyAlwaysOnTop(localStorage.getItem('alwaysOnTop') === '1');
window.api.setAllDesktops(localStorage.getItem('allDesktops') === '1');

// Ненавязчивое предложение стать обработчиком magnet и .torrent по умолчанию.
// Показывается один раз, если ещё не по умолчанию и не отклонено.
(async () => {
  const offer = document.getElementById('default-offer');
  if (localStorage.getItem('defaultOfferDismissed')) return;
  try { if (await window.api.isDefaultHandler()) return; } catch (_) {}
  offer.classList.remove('hidden');
  document.getElementById('make-default').addEventListener('click', async () => {
    await window.api.makeDefaultHandler();
    localStorage.setItem('defaultOfferDismissed', '1');
    offer.classList.add('hidden');
  });
  document.getElementById('dismiss-default').addEventListener('click', () => {
    localStorage.setItem('defaultOfferDismissed', '1');
    offer.classList.add('hidden');
  });
})();

// Настройки: обработчик по умолчанию, предзагрузка, путь сохранения.
const settings = document.getElementById('settings');
const setDefault = document.getElementById('set-default');
const setPrefetch = document.getElementById('set-prefetch');
const setAskPath = document.getElementById('set-ask-path');
const setAllDesktops = document.getElementById('set-all-desktops');
const setRememberWindow = document.getElementById('set-remember-window');
const osKeyInput = document.getElementById('os-key');
const pathRow = document.getElementById('path-row');
const pathValue = document.getElementById('path-value');

// Когда путь спрашивается каждый раз, выбор пути по умолчанию скрыт.
function updatePathUI() {
  const ask = localStorage.getItem('askPathEachTime') === '1';
  pathRow.classList.toggle('hidden', ask);
  pathValue.textContent = localStorage.getItem('downloadPath') || t('tempFolder');
}

async function openSettings() {
  try { setDefault.checked = await window.api.isDefaultHandler(); } catch (_) {}
  setPrefetch.checked = localStorage.getItem('prefetchNext') !== '0';
  setAskPath.checked = localStorage.getItem('askPathEachTime') === '1';
  setAllDesktops.checked = localStorage.getItem('allDesktops') === '1';
  try { setRememberWindow.checked = await window.api.getRememberWindow(); } catch (_) {}
  osKeyInput.value = localStorage.getItem('osApiKey') || '';
  updatePathUI();
  settings.classList.remove('hidden');
  document.body.classList.add('modal-open');
}
document.getElementById('open-settings').addEventListener('click', openSettings);
document.querySelectorAll('[data-url]').forEach((b) => {
  b.addEventListener('click', () => window.api.openExternal(b.dataset.url));
});
document.getElementById('os-help-toggle').addEventListener('click', () => {
  document.getElementById('os-help').classList.toggle('hidden');
});

// Язык интерфейса: применяется сразу и сообщается main для меню.
const setLang = document.getElementById('set-lang');
setLang.value = getLanguage();
setLang.addEventListener('change', () => {
  setLanguage(setLang.value);
  updatePathUI();
  refreshContinue();
});
applyI18n();
window.api.setLanguage(getLanguage());
window.api.onOpenSettings(openSettings);
setRememberWindow.addEventListener('change', () => {
  window.api.setRememberWindow(setRememberWindow.checked);
});
osKeyInput.addEventListener('change', () => {
  const v = osKeyInput.value.trim();
  if (v) localStorage.setItem('osApiKey', v);
  else localStorage.removeItem('osApiKey');
});
setDefault.addEventListener('change', async () => {
  if (setDefault.checked) await window.api.makeDefaultHandler();
  else await window.api.removeDefaultHandler();
  localStorage.setItem('defaultOfferDismissed', '1');
});
setPrefetch.addEventListener('change', () => {
  localStorage.setItem('prefetchNext', setPrefetch.checked ? '1' : '0');
});
setAskPath.addEventListener('change', () => {
  localStorage.setItem('askPathEachTime', setAskPath.checked ? '1' : '0');
  updatePathUI();
});
setAllDesktops.addEventListener('change', () => {
  localStorage.setItem('allDesktops', setAllDesktops.checked ? '1' : '0');
  window.api.setAllDesktops(setAllDesktops.checked);
});
document.getElementById('choose-path').addEventListener('click', async () => {
  const p = await window.api.chooseFolder();
  if (p) { localStorage.setItem('downloadPath', p); updatePathUI(); }
});
document.getElementById('close-settings').addEventListener('click', () => {
  settings.classList.add('hidden');
  document.body.classList.remove('modal-open');
});
settings.addEventListener('click', (e) => { if (e.target === settings) settings.classList.add('hidden'); });

// Окно горячих клавиш из меню приложения (Cmd+/).
const shortcutsModal = document.getElementById('shortcuts');
function openShortcuts() {
  shortcutsModal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}
function closeShortcuts() {
  shortcutsModal.classList.add('hidden');
  document.body.classList.remove('modal-open');
}
window.api.onOpenShortcuts(openShortcuts);
document.getElementById('close-shortcuts').addEventListener('click', closeShortcuts);
shortcutsModal.addEventListener('click', (e) => { if (e.target === shortcutsModal) closeShortcuts(); });

// Окно «О программе» из меню приложения.
const aboutModal = document.getElementById('about-modal');
async function openAbout() {
  try { document.getElementById('about-version').textContent = t('version') + ' ' + await window.api.appVersion(); } catch (_) {}
  aboutModal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}
function closeAbout() {
  aboutModal.classList.add('hidden');
  document.body.classList.remove('modal-open');
}
window.api.onOpenAbout(openAbout);
document.getElementById('close-about').addEventListener('click', closeAbout);
aboutModal.addEventListener('click', (e) => { if (e.target === aboutModal) closeAbout(); });

// Показать строку продолжения при старте на главном экране.
refreshContinue();
