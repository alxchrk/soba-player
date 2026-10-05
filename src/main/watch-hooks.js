'use strict';

// Хуки просмотра для своей автоматизации (дневник просмотров, календарь).
// Если в <userData>/hooks лежит исполняемый on-watch, плеер запускает его на
// каждое событие сеанса и передаёт JSON на stdin. Без файла хуков ничего не
// запускается и никуда не отправляется.
//
// Сеанс считает фактическое время воспроизведения по часам: паузы и
// перемотка вперёд в него не входят. Пауза до 30 минут продолжает тот же
// сеанс, после более долгой паузы воспроизведение начинает новый.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_GAP_MS = 30 * 60 * 1000;
const HOOK_TIMEOUT_MS = 60 * 1000;

let hookPath = null;
let appVersion = '';
let describe = () => ({});
let sourceName = null;
let session = null;
const queue = [];
let running = false;

function init(userDataDir, version, describeFile) {
  hookPath = path.join(userDataDir, 'hooks', 'on-watch');
  appVersion = version;
  describe = describeFile;
}

function hookExists() {
  try { fs.accessSync(hookPath, fs.constants.X_OK); return true; } catch (_) { return false; }
}

// Локальное время с часовым поясом: 2026-10-06T21:15:03+03:00.
function isoLocal(ms) {
  const d = new Date(ms);
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

const RELEASE_TAG = /\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr|bdrip|brrip|bluray|blu-ray|web-?dl|webrip|hdrip|dvdrip|hdtv|remux|x264|x265|h\.?264|h\.?265|hevc|avc|aac|ac3|dts)\b/i;

// Название из имени файла: без расширения, тегов в скобках и хвоста с
// качеством релиза; год отдельно.
function cleanTitle(name) {
  let s = String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ');
  // Год не в самом начале имени: «1917.2019» это фильм «1917» 2019 года.
  const yearMatch = [...s.matchAll(/[^\d](19\d{2}|20\d{2})(?!\d)/g)].pop();
  s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  let cut = s.length;
  const tag = RELEASE_TAG.exec(s);
  if (tag) cut = Math.min(cut, tag.index);
  const year = yearMatch ? s.lastIndexOf(yearMatch[1]) : -1;
  if (year > 0) cut = Math.min(cut, year);
  const title = s.slice(0, cut).replace(/[\s-]+$/, '').trim() || s;
  return { title, year: yearMatch ? Number(yearMatch[1]) : null };
}

function watchedMs(s, now) {
  return s.watchedMs + (s.playingSince ? now - s.playingSince : 0);
}

function payload(event, s, now) {
  const info = describe(s.index) || {};
  const cleaned = cleanTitle(info.fileName);
  return {
    event,
    session_id: s.id,
    title: info.metaTitle || cleaned.title,
    year: cleaned.year,
    file_name: info.fileName || null,
    torrent_name: sourceName,
    path: info.path || null,
    duration_seconds: s.durationSec ? Math.round(s.durationSec) : null,
    position_seconds: Math.round(s.pos || 0),
    watched_seconds: Math.round(watchedMs(s, now) / 1000),
    started_at: isoLocal(s.startedAt),
    ended_at: isoLocal(s.playingSince ? now : s.endedAt),
    app_version: appVersion,
  };
}

// JSON уходит через временный файл на stdin: так дочерний процесс получает
// данные целиком, даже если плеер в этот момент завершается.
function spawnHook(data, onExit) {
  const tmp = path.join(os.tmpdir(), `soba-watch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  let fd = null;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data) + '\n');
    fd = fs.openSync(tmp, 'r');
    const child = spawn(hookPath, [data.event], {
      cwd: path.dirname(hookPath), stdio: [fd, 'ignore', 'ignore'], detached: true,
    });
    child.on('error', (e) => { console.log('[watch-hook] failed:', e.message); if (onExit) onExit(); });
    if (onExit) {
      const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, HOOK_TIMEOUT_MS);
      child.on('exit', () => { clearTimeout(timer); onExit(); });
    }
    child.unref();
  } catch (e) {
    console.log('[watch-hook] failed:', e.message);
    if (onExit) onExit();
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// Вызовы идут по одному, в порядке событий: скрипт не получает «паузу»
// раньше, чем закончил обрабатывать «старт».
function runNext() {
  if (running || !queue.length) return;
  running = true;
  spawnHook(queue.shift(), () => { running = false; runNext(); });
}

function emit(event, s, now) {
  if (!hookExists()) return;
  queue.push(payload(event, s, now));
  runNext();
}

function finish(now) {
  if (!session) return;
  if (session.playingSince) {
    session.watchedMs += now - session.playingSince;
    session.playingSince = null;
    session.endedAt = now;
  }
  emit('stop', session, now);
  session = null;
}

// Состояние воспроизведения из окна: index null значит, что файл закрыт.
function update(index, playing, pos, durationSec) {
  const now = Date.now();
  if (session && session.index !== index) finish(now);
  if (index == null) return;
  if (session) {
    session.pos = pos;
    session.durationSec = durationSec || session.durationSec;
  }
  if (playing && !session) {
    session = { id: crypto.randomUUID(), index, pos, durationSec, startedAt: now, endedAt: now, playingSince: now, watchedMs: 0 };
    emit('start', session, now);
  } else if (playing && !session.playingSince) {
    if (now - session.endedAt > SESSION_GAP_MS) {
      finish(now);
      update(index, playing, pos, durationSec);
      return;
    }
    session.playingSince = now;
    emit('resume', session, now);
  } else if (!playing && session && session.playingSince) {
    session.watchedMs += now - session.playingSince;
    session.playingSince = null;
    session.endedAt = now;
    emit('pause', session, now);
  }
}

// Позиция между событиями: нужна для «stop» при выходе из плеера.
function setPos(index, pos) {
  if (session && session.index === index) session.pos = pos;
}

// Новый источник: прежний сеанс закрывается.
function setSource(name) {
  finish(Date.now());
  sourceName = name || null;
}

// Выход из плеера: последнее событие уходит сразу, без очереди.
function shutdown() {
  const now = Date.now();
  if (session && session.playingSince) {
    session.watchedMs += now - session.playingSince;
    session.playingSince = null;
    session.endedAt = now;
  }
  if (hookExists()) {
    for (const data of queue.splice(0)) spawnHook(data);
    if (session) spawnHook(payload('stop', session, now));
  }
  session = null;
}

module.exports = { init, update, setPos, setSource, shutdown, cleanTitle };
