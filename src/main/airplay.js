// AirPlay: связка окна плеера, HLS-нарезки (hls.js) и нативного помощника
// SobaAirPlay (build/airplay). Помощник держит AVPlayer и системное меню
// приёмников; здесь решается, что ему грузить, и события пересылаются в окно.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const hls = require('./hls');

// Если после закрытия меню приёмник так и не подключился, сеанс сворачивается.
const CONNECT_TIMEOUT_MS = 10000;
// Перемотка ближе этого к концу нарезанного перезапускает нарезку: иначе
// плеер телевизора упрётся в край и будет ждать.
const RANGE_MARGIN_SEC = 2;

// Порядок как у ffmpeg: переменная окружения, бандл, сборка из исходников.
const HELPER = [
  process.env.SOBA_AIRPLAY_PATH,
  process.resourcesPath && path.join(process.resourcesPath, 'airplay', 'SobaAirPlay'),
  path.join(__dirname, '..', '..', 'build', 'airplay', 'bin', 'SobaAirPlay'),
].find((p) => p && fs.existsSync(p));

// Просмотренные сегменты нарезки чистятся не чаще раза в PRUNE_EVERY_MS.
const PRUNE_EVERY_MS = 10000;
const RELOAD_DEBOUNCE_MS = 700;
const RECOVER_MAX = 3;
const RECOVER_WINDOW_MS = 60000;

const state = {
  proc: null, win: null, active: false, index: null, audio: 0, subs: null, audioOpts: null, start: 0, connectTimer: null, lastT: 0, prunedAt: 0,
  recoveries: [], reloadTimer: null,
};

// Слушатель начала и конца показа на телевизоре (main держит систему без сна).
let activeListener = null;
function onActiveChange(fn) {
  activeListener = fn;
}
function setActive(on) {
  state.active = on;
  if (activeListener) activeListener(on);
}

function available() {
  return !!HELPER;
}

function toWindow(ev) {
  if (state.win && !state.win.isDestroyed()) state.win.webContents.send('airplay-event', ev);
}

function send(obj) {
  if (state.proc) state.proc.stdin.write(JSON.stringify(obj) + '\n');
}

function onHelperEvent(ev) {
  if (ev.ev === 'time') {
    state.lastT = ev.t;
    if (state.active && Date.now() - state.prunedAt > PRUNE_EVERY_MS) {
      state.prunedAt = Date.now();
      hls.prune(state.start + ev.t);
    }
    return toWindow({ type: 'time', pos: state.start + ev.t, playing: ev.playing });
  }
  if (ev.ev === 'picker' && !ev.open && !state.active) {
    // Меню закрыто. Воспроизведение запускается сразу (до подключения помощник
    // держит звук выключенным), без приёмника сеанс сворачивается по таймеру.
    send({ cmd: 'play' });
    clearTimeout(state.connectTimer);
    state.connectTimer = setTimeout(() => { if (!state.active) end('cancel'); }, CONNECT_TIMEOUT_MS);
    return;
  }
  if (ev.ev === 'route') {
    if (ev.active && !state.active) {
      // Приёмник выбран, когда сеанса уже нет (свёрнут): окну нечем управлять.
      if (state.index == null) return console.warn('[airplay] route active without a session');
      setActive(true);
      clearTimeout(state.connectTimer);
      return toWindow({ type: 'connected' });
    }
    if (!ev.active && state.active) return end('disconnected');
    return;
  }
  if (ev.ev === 'ended') return toWindow({ type: 'ended' });
  if (ev.ev === 'subs') return console.log('[airplay] subtitles on:', ev.name);
  if (ev.ev === 'error') {
    console.warn('[airplay]', ev.message);
    if (ev.fatal && state.index != null) return recover(ev.message);
    return toWindow({ type: 'error', message: ev.message });
  }
}

function ensureHelper() {
  if (state.proc) return;
  const proc = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  state.proc = proc;
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { onHelperEvent(JSON.parse(line)); } catch (_) {}
    }
  });
  proc.on('exit', () => {
    if (state.proc !== proc) return;
    state.proc = null;
    if (state.active || state.index != null) end('disconnected');
  });
}

// Нарезка с секунды sec и загрузка в помощник с точной позицией. Субтитры
// (state.subs) идут дорожкой в потоке, помощник сразу её включает.
async function loadAt(index, sec, audio) {
  state.index = index;
  state.audio = audio || 0;
  const r = await hls.start(index, sec, state.audio, state.subs, state.audioOpts);
  state.start = r.start;
  send({ cmd: 'load', url: r.url, at: Math.max(0, sec - r.start), subs: r.subs });
}

// Упавший на телевизоре поток (например, телевизор догнал край нарезки)
// загружается заново с последней позиции на тот же приёмник. Больше
// RECOVER_MAX раз за RECOVER_WINDOW_MS сеанс сворачивается на Mac.
function recover(message) {
  const now = Date.now();
  state.recoveries = state.recoveries.filter((t) => now - t < RECOVER_WINDOW_MS);
  if (!state.active || state.recoveries.length >= RECOVER_MAX) {
    toWindow({ type: 'error', message });
    return end('error');
  }
  state.recoveries.push(now);
  console.warn('[airplay] reload after failure at', state.start + state.lastT);
  loadAt(state.index, state.start + state.lastT, state.audio).catch((e) => {
    toWindow({ type: 'error', message: e.message });
    end('error');
  });
}

// Кнопка AirPlay: подготовить поток с текущей позиции и показать меню
// приёмников поверх кнопки. rect: прямоугольник кнопки в координатах окна.
async function open(win, index, sec, audio, subs, audioOpts, rect) {
  if (!HELPER) throw new Error('AirPlay helper is missing');
  state.win = win;
  ensureHelper();
  const b = win.getContentBounds();
  const pickAt = { cmd: 'pick', x: b.x + rect.x, y: b.y + rect.y, w: rect.width, h: rect.height };
  // Таймер от прошлого закрытого меню не должен свернуть сеанс, пока открыто это.
  clearTimeout(state.connectTimer);
  if (state.active) return send(pickAt); // уже на телевизоре: меню для смены или отключения
  state.subs = subs || null;
  state.audioOpts = audioOpts || null;
  await loadAt(index, sec, audio);
  send(pickAt);
}

function seek(sec) {
  if (state.index == null) return;
  const r = hls.range();
  if (r && sec >= r.start && sec <= r.end - RANGE_MARGIN_SEC) {
    clearTimeout(state.reloadTimer);
    send({ cmd: 'seek', t: sec - state.start });
    return;
  }
  // Серия нажатий за край нарезки даёт один перезапуск на последнюю цель:
  // частая замена потока подвешивает приёмник.
  clearTimeout(state.reloadTimer);
  state.reloadTimer = setTimeout(() => {
    if (state.index == null) return;
    loadAt(state.index, sec, state.audio).catch((e) => toWindow({ type: 'error', message: e.message }));
  }, RELOAD_DEBOUNCE_MS);
}

function command(cmd) {
  if (cmd === 'play' || cmd === 'pause') send({ cmd });
}

function setAudio(track, sec) {
  if (state.index == null) return;
  loadAt(state.index, sec, track).catch((e) => toWindow({ type: 'error', message: e.message }));
}

// Другие субтитры (или выключение) во время показа: нарезка с той же позиции.
function setSubs(subs, sec) {
  state.subs = subs || null;
  if (state.index == null) return;
  loadAt(state.index, sec, state.audio).catch((e) => toWindow({ type: 'error', message: e.message }));
}

// Настройки звука (выравнивание, диалоги) во время показа: нарезка с той же позиции.
function setAudioOptions(opts, sec) {
  state.audioOpts = opts || null;
  if (state.index == null) return;
  loadAt(state.index, sec, state.audio).catch((e) => toWindow({ type: 'error', message: e.message }));
}

// Другая серия во время показа на телевизоре.
function load(index, sec, audio, subs) {
  if (state.index == null) return;
  state.subs = subs || null;
  loadAt(index, sec, audio).catch((e) => toWindow({ type: 'error', message: e.message }));
}

// Конец сеанса: помощник останавливает поток (телевизор отключается),
// нарезка удаляется, окно получает последнюю позицию для продолжения на Mac.
function end(reason) {
  clearTimeout(state.connectTimer);
  clearTimeout(state.reloadTimer);
  const wasActive = state.active;
  const pos = state.start + state.lastT;
  setActive(false);
  state.index = null;
  state.lastT = 0;
  send({ cmd: 'stop' });
  hls.stop();
  toWindow({ type: 'ended-session', reason, pos, wasActive });
}

function stop() {
  if (state.index != null || state.active) end('stopped');
}

function shutdown() {
  hls.stop();
  if (state.proc) {
    try { state.proc.kill(); } catch (_) {}
    state.proc = null;
  }
}

module.exports = { onActiveChange, available, open, seek, command, setAudio, setSubs, setAudioOptions, load, stop, shutdown };
