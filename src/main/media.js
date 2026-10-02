// Торрент-движок, локальный http-сервер и решение о поверхности воспроизведения.
// Один сервер отдаёт три вида ответов:
//   /raw/:index          сырой файл с поддержкой Range (для нативного <video> и как вход ffmpeg)
//   /play/:index?t=&a=   транскод/ремукс на лету в fragmented MP4 (несовместимые контейнеры и кодеки)
//   /subs/:index?track=  извлечение встроенной дорожки субтитров в WebVTT
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ffmpegPath, ffprobePath } = require('./ffmpeg');
const WindowStore = require('./window-store');

// Кодеки, которые Chromium на macOS воспроизводит нативно.
const NATIVE_VIDEO = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const NATIVE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
// Контейнеры, которые <video> открывает напрямую (по расширению файла).
const NATIVE_CONTAINER = new Set(['mp4', 'm4v', 'mov', 'webm']);
const VIDEO_EXT = new Set(['mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', 'ogv', '3gp']);

let WebTorrent = null;
let client = null;
// pending: раздача, открытая, но ещё без метаданных ({ torrent, reject }).
const state = { torrent: null, pending: null, server: null, port: 0, transcoder: null };

function ext(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function isVideo(name) {
  return VIDEO_EXT.has(ext(name));
}

// Публичные трекеры добавляются к каждой раздаче: быстрее находятся пиры, особенно
// у magnet-ссылок без DHT-соседей. Трекер видит только infoHash и адрес, как и
// любой пир.
const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
];

// Клиент создаётся один раз, в том числе при нескольких одновременных вызовах.
let clientReady = null;
function ensureClient() {
  if (!clientReady) clientReady = createClient();
  return clientReady;
}

async function createClient() {
  WebTorrent = (await import('webtorrent')).default;
  // maxConns: сколько пиров держать одновременно (по умолчанию 55).
  // utp: false, потому что нативный utp-native под Electron роняет главный
  // процесс (SIGSEGV в utp_process_udp); DHT и TCP-пиры работают без него.
  client = new WebTorrent({ maxConns: 100, utp: false });
  applyLimit();
  return client;
}

// --- ограничение скорости загрузки ------------------------------------------
// Ручной режим: постоянный потолок в МБ/с (0 = без ограничения). Авторежим
// смотрит на запас, скачанный подряд от позиции просмотра: меньше
// AUTO_FULL_SEC полная скорость (быстрый старт и перемотка), до
// AUTO_DOUBLE_SEC два битрейта файла, дальше один битрейт, то есть запас
// держится, но не растёт и не забивает роутер. Потолок не ниже AUTO_MIN_RATE,
// чтобы у лёгкого файла не душить куски, которые плеер читает прямо сейчас.
const AUTO_FULL_SEC = 600;
const AUTO_DOUBLE_SEC = 1800;
const AUTO_MIN_RATE = 1e6;
// tier: множитель битрейта для потолка (0 = без потолка).
const speed = { mode: 'auto', tier: 0, pos: null, timer: null };

// Ограничитель движка принимает только целое число байт в секунду больше
// нуля и бросает исключение на дробном: округление здесь, для всех режимов.
function setDownloadRate(rate) {
  if (client) client.throttleDownload(rate > 0 ? Math.max(1, Math.round(rate)) : -1);
}

function applyLimit() {
  clearInterval(speed.timer);
  speed.timer = null;
  if (speed.mode === 'auto') {
    speed.tier = 0;
    setDownloadRate(0);
    speed.timer = setInterval(autoLimitTick, 2000);
  } else {
    setDownloadRate((parseFloat(speed.mode) || 0) * 1e6);
  }
}

// mode: 'auto' или число МБ/с строкой ('0' = без ограничения).
function setSpeedLimit(mode) {
  speed.mode = mode === 'auto' ? 'auto' : String(parseFloat(mode) || 0);
  applyLimit();
}

// Позиция просмотра от окна: номер файла, секунда и длительность.
function setPlaybackPos(index, sec, durationSec) {
  speed.pos = { index, sec, durationSec };
}

// Сколько секунд видео скачано подряд от позиции просмотра.
function aheadSeconds() {
  const t = state.torrent;
  const p = speed.pos;
  if (!t || !t.bitfield || !p || !p.durationSec) return null;
  const file = t.files[p.index];
  if (!file || file.offset == null) return null;
  const bytesPerSec = file.length / p.durationSec;
  const from = file.offset + Math.min(file.length, Math.max(0, p.sec) * bytesPerSec);
  const fileEnd = file.offset + file.length - 1;
  let piece = Math.floor(from / t.pieceLength);
  const lastPiece = Math.floor(fileEnd / t.pieceLength);
  while (piece <= lastPiece && t.bitfield.get(piece)) piece++;
  const aheadBytes = Math.min(piece * t.pieceLength, fileEnd + 1) - from;
  return { sec: Math.max(0, aheadBytes) / bytesPerSec, bytesPerSec };
}

function autoLimitTick() {
  const a = aheadSeconds();
  const tier = !a || a.sec < AUTO_FULL_SEC ? 0 : a.sec < AUTO_DOUBLE_SEC ? 2 : 1;
  if (tier === speed.tier) return;
  speed.tier = tier;
  setDownloadRate(tier ? Math.max(AUTO_MIN_RATE, tier * a.bytesPerSec) : 0);
}

// --- ограниченный кэш -------------------------------------------------------
// При включённом кэше куски раздачи лежат в WindowStore отдельными файлами.
// Качается окно от позиции просмотра размером с кэш за вычетом запаса
// позади, поэтому файл меньше кэша скачивается целиком и не вытесняется.
// Когда на диске больше лимита, удаляются куски позади позиции (дальние
// первыми), потом куски за окном. KEEP_BEHIND_SEC позади остаются для
// короткой перемотки назад; дальняя перемотка назад докачивает заново.
const KEEP_BEHIND_SEC = 120;
const cache = { bytes: 0, store: null, index: null, window: null, prefetch: null, timer: null };

// gb: размер кэша в ГБ, 0 = выключен. Действует на следующую открытую раздачу;
// у текущей раздачи в режиме кэша меняется только лимит.
function setCacheLimit(gb) {
  cache.bytes = Math.max(0, parseFloat(gb) || 0) * 1e9;
}

function cacheTick() {
  const t = state.torrent;
  const store = cache.store;
  if (!t || t.destroyed || !store || !t.pieces || cache.index == null) return;
  const file = t.files[cache.index];
  if (!file) return;
  const p = speed.pos && speed.pos.index === cache.index ? speed.pos : null;
  const bps = p && p.durationSec ? file.length / p.durationSec : 0;
  const pl = t.pieceLength;
  const posByte = file.offset + Math.min(file.length - 1, Math.max(0, p ? p.sec * bps : 0));
  const posPiece = Math.floor(posByte / pl);
  const behindBytes = bps * KEEP_BEHIND_SEC;
  const limit = cache.bytes || store.bytes + pl;
  const windowBytes = Math.max(pl * 4, limit - behindBytes - pl * 4);
  const endPiece = Math.min(file._endPiece, Math.floor((posByte + windowBytes) / pl));

  if (!cache.window || cache.window[0] !== posPiece || cache.window[1] !== endPiece) {
    try {
      t.deselect(0, t.pieces.length - 1);
      t.select(posPiece, endPiece, 0);
      if (cache.prefetch) t.select(cache.prefetch[0], cache.prefetch[1], 0);
      cache.window = [posPiece, endPiece];
    } catch (_) {}
  }

  if (!cache.bytes || store.bytes <= cache.bytes) return;
  const keepFrom = Math.floor(Math.max(file.offset, posByte - behindBytes) / pl);
  const score = (i) => (i < keepFrom ? 1e12 + (keepFrom - i) : i - endPiece);
  const victims = store.indexes().filter((i) => i < keepFrom || i > endPiece).sort((a, b) => score(b) - score(a));
  for (const i of victims) {
    if (store.bytes <= cache.bytes * 0.95) break;
    store.evict(i);
    t._markUnverified(i);
  }
}

function killTranscoder() {
  if (state.transcoder) {
    try { state.transcoder.kill('SIGKILL'); } catch (_) {}
    state.transcoder = null;
  }
}

async function destroyCurrent() {
  // Раздача, не успевшая получить метаданные, отменяется: иначе она позже
  // перехватила бы текущее состояние и качалась бы в фоне.
  if (state.pending) {
    const { torrent, reject } = state.pending;
    state.pending = null;
    try { torrent.destroy(); } catch (_) {}
    reject(new Error('superseded'));
  }
  killTranscoder();
  speed.pos = null;
  clearInterval(cache.timer);
  Object.assign(cache, { store: null, index: null, window: null, prefetch: null, timer: null });
  if (state.server) {
    try { state.server.close(); } catch (_) {}
    state.server = null;
  }
  if (state.torrent) {
    // Освобождаем торрент. Скачанное во временной папке остаётся до выхода из
    // приложения: серии этой сессии доступны при переключении. Папку целиком
    // удаляет before-quit при закрытии. Ссылка обнуляется до ожидания: при
    // быстром повторном открытии второй destroy той же раздачи не вернул бы
    // колбэк, и открытие зависло бы.
    const torrent = state.torrent;
    state.torrent = null;
    await new Promise((res) => torrent.destroy(res));
  }
}

// Номер открытия: после каждого ожидания устаревшее открытие (пользователь уже
// выбрал другой источник) прерывается и не трогает состояние.
let openSeq = 0;
function checkCurrent(seq) {
  if (seq !== openSeq) throw new Error('superseded');
}

function fileByIndex(index) {
  return state.torrent && state.torrent.files[index];
}

function rawUrl(index) {
  return `http://127.0.0.1:${state.port}/raw/${index}`;
}

// --- http-сервер -----------------------------------------------------------

function serveRaw(req, res, file) {
  const total = file.length;
  const range = req.headers.range;
  let start = 0;
  let end = total - 1;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1]) start = parseInt(m[1], 10);
      if (m[2]) end = parseInt(m[2], 10);
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
    });
  } else {
    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': total,
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
    });
  }
  const stream = file.createReadStream({ start, end });
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}

// Звуковые фильтры ffmpeg, общие для воспроизведения на Mac и для AirPlay.
// ffmpeg обрабатывает звук раньше, чем он прозвучит, поэтому фильтры видят
// звук впереди. Веса и точки подобраны замерами громкости (EBU R128) на
// тихой, обычной и громкой сценах фильма с дорожкой 5.1.
//
// Диалоги: сведение в стерео с поднятым центральным каналом, в котором у 5.1
// и 7.1 идёт речь. Голос заметнее примерно на 7 дБ, общая громкость почти как
// у обычного сведения. У 5.1(side) нет BL, у 5.1 нет SL: pan пропускает
// отсутствующие. Канал сабвуфера не подмешивается, как и при обычном
// сведении: в нём рокот, на динамиках ноутбука он гудит. У стерео центр
// сначала выделяет dialoguenhance.
const DIALOG_PAN = 'pan=stereo|FL=0.6*FL+1.0*FC+0.45*BL+0.45*SL|FR=0.6*FR+1.0*FC+0.45*BR+0.45*SR';
// Выравнивание громкости: передаточная кривая с мёртвой зоной. От -31 до -20
// дБ огибающей звук не меняется (обычные сцены), тише подтягивается к нижней
// границе, громче опускается к верхней, тишина ниже -64 не трогается, чтобы
// не поднимать фоновый гул. Подъём за 1.5 с, спад за 0.3 с; delay даёт те же
// 0.3 с заглядывания вперёд, так что громкая сцена приглушается к своему
// началу, а не после него (задержку compand компенсирует сам).
const LEVEL_COMPAND = 'compand=attacks=0.3:decays=1.5:soft-knee=6:delay=0.3:'
  + 'points=-80/-80|-64/-64|-54/-37|-44/-30|-31/-30|-20/-20|-10/-15|0/-12';
// Ограничитель пиков всегда в конце: сведение 5.1 в стерео на взрывах даёт
// пики выше 0 dBFS, и они хрипят. level=0: только срез пиков, без
// автоподъёма громкости; latency=1: его заглядывание (5 мс) компенсируется.
const PEAK_LIMITER = 'alimiter=limit=0.85:level=0:latency=1';
function audioFilters(channels, opts = {}) {
  const f = [];
  if (opts.dialog && channels >= 2) {
    if (channels === 2) f.push('dialoguenhance');
    f.push(DIALOG_PAN);
  } else {
    f.push('aformat=channel_layouts=stereo');
  }
  if (opts.level) f.push(LEVEL_COMPAND);
  f.push(PEAK_LIMITER);
  return ['-af', f.join(',')];
}

function trackChannels(probe, audioTrack) {
  const tr = probe && probe.audioTracks && probe.audioTracks[audioTrack || 0];
  return (tr && tr.channels) || 2;
}

function buildTranscodeArgs(index, seek, audioTrack, probe, audioOpts) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  // Видео копируем, если кодек нативный, иначе аппаратный энкод.
  const copyVideo = !!(probe && NATIVE_VIDEO.has(probe.video && probe.video.codec));
  // При копировании видео точный seek режет только декодируемый звук, а видео
  // начинается с ключевого кадра раньше: звук уходил вперёд на секунду-две.
  // Оба потока начинаются с ключевого кадра.
  if (seek > 0 && copyVideo) args.push('-noaccurate_seek');
  if (seek > 0) args.push('-ss', String(seek));
  args.push('-i', rawUrl(index));
  args.push('-map', '0:v:0');
  args.push('-map', `0:a:${audioTrack || 0}?`);
  // Только видео и звук: субтитровые и данные-потоки в fmp4 ломают декодер <video>.
  args.push('-sn', '-dn');
  if (copyVideo) {
    args.push('-c:v', 'copy');
  } else {
    args.push('-c:v', 'h264_videotoolbox', '-b:v', '8M');
  }
  args.push(...audioFilters(trackChannels(probe, audioTrack), audioOpts));
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof');
  args.push('-f', 'mp4', 'pipe:1');
  return args;
}

function servePlay(req, res, index, query, probe) {
  killTranscoder();
  const seek = parseFloat(query.get('t') || '0') || 0;
  const audioTrack = parseInt(query.get('a') || '0', 10) || 0;
  const args = buildTranscodeArgs(index, seek, audioTrack, probe, { dialog: query.get('d') === '1', level: query.get('l') === '1' });
  // ACAO: страница file:// подключает звук через Web Audio (громкость выше 100%),
  // для этого элемент грузит поток в режиме crossorigin.
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*' });
  const ff = spawn(ffmpegPath, args);
  state.transcoder = ff;
  ff.stdout.pipe(res);
  ff.stderr.on('data', (d) => console.warn('[ffmpeg]', d.toString().trim()));
  ff.on('error', () => res.destroy());
  req.on('close', () => {
    if (state.transcoder === ff) killTranscoder();
  });
}

// Кэш извлечённых субтитров (готовый WebVTT всей дорожки) по раздаче и дорожке.
// Заполняется, когда дорожка прочитана с начала до конца или когда файл скачан
// целиком; при следующем открытии отдаётся сразу, без ffmpeg.
let subsCacheDir = null;
function setSubsCacheDir(dir) {
  subsCacheDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}
function subsCachePath(index, track) {
  if (!subsCacheDir || !state.torrent) return null;
  const key = state.torrent.infoHash || crypto.createHash('sha1').update(filePath(index) || String(index)).digest('hex');
  return path.join(subsCacheDir, `${key}-${index}-${track}.vtt`);
}

function serveSubs(req, res, index, query) {
  const track = parseInt(query.get('track') || '0', 10) || 0;
  const from = parseFloat(query.get('t') || '0') || 0;
  res.writeHead(200, { 'Content-Type': 'text/vtt', 'Access-Control-Allow-Origin': '*' });
  const cached = subsCachePath(index, track);
  if (cached && fs.existsSync(cached)) {
    fs.createReadStream(cached).pipe(res);
    return;
  }
  // Субтитры идут вперемешку с видео, и ffmpeg читал бы файл до конца на полной
  // скорости: с включёнными субтитрами докачивался бы весь фильм мимо лимита
  // скорости и кэша. Чтение идёт вдвое быстрее фильма после первых 5 минут,
  // реплики всё равно приходят раньше, чем нужны.
  const args = ['-hide_banner', '-loglevel', 'error', '-readrate', '2', '-readrate_initial_burst', '300'];
  // Чтение с начала файла означало бы скачивание всего до текущей позиции.
  // Стартуем с позиции просмотра; -copyts сохраняет абсолютные метки времени.
  if (from > 0) args.push('-ss', String(from), '-copyts');
  args.push('-i', rawUrl(index), '-map', `0:s:${track}`, '-f', 'webvtt', 'pipe:1');
  const ff = spawn(ffmpegPath, args);
  ff.stdout.pipe(res);
  // Чтение с начала целиком попадает в кэш.
  let tee = null;
  if (from === 0 && cached) {
    tee = fs.createWriteStream(cached + '.part');
    ff.stdout.pipe(tee);
  }
  ff.stderr.on('data', (d) => console.warn('[ffmpeg subs]', d.toString().trim()));
  ff.on('error', () => res.destroy());
  ff.on('close', (code) => {
    if (!tee) return;
    tee.end(() => {
      if (code === 0 && !req.destroyed) fs.rename(cached + '.part', cached, () => {});
      else fs.rm(cached + '.part', { force: true }, () => {});
    });
  });
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (_) {} });
}

// Полное извлечение дорожки в кэш из локального файла (когда он скачан целиком).
function cacheSubtitles(index, track) {
  const cached = subsCachePath(index, track);
  // В режиме кэша целого файла на диске нет, ffmpeg читает его через сервер.
  const src = filePath(index) || (cache.store ? rawUrl(index) : null);
  if (!cached || !src || fs.existsSync(cached) || fs.existsSync(cached + '.part')) return Promise.resolve(false);
  return new Promise((resolve) => {
    const out = fs.createWriteStream(cached + '.part');
    const ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', src, '-map', `0:s:${track}`, '-f', 'webvtt', 'pipe:1']);
    ff.stdout.pipe(out);
    ff.on('error', () => resolve(false));
    ff.on('close', (code) => {
      out.end(() => {
        if (code === 0) fs.rename(cached + '.part', cached, () => resolve(true));
        else fs.rm(cached + '.part', { force: true }, () => resolve(false));
      });
    });
  });
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const parts = u.pathname.split('/').filter(Boolean); // [kind, index]
      const kind = parts[0];
      const index = parseInt(parts[1], 10);
      const file = fileByIndex(index);
      if (!file) { res.writeHead(404); return res.end(); }
      if (kind === 'raw') return serveRaw(req, res, file);
      if (kind === 'play') return servePlay(req, res, index, u.searchParams, state.probeCache && state.probeCache[index]);
      if (kind === 'subs') return serveSubs(req, res, index, u.searchParams);
      res.writeHead(404); res.end();
    });
    // Пока сервер поднимался, могли открыть другой источник: тогда этот
    // сервер не нужен и закрывается.
    const seq = openSeq;
    server.listen(0, '127.0.0.1', () => {
      if (seq !== openSeq) { server.close(); return resolve(); }
      state.server = server;
      state.port = server.address().port;
      resolve();
    });
  });
}

// --- ffprobe ---------------------------------------------------------------

function probeStreams(index) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-show_streams', '-show_format', '-show_chapters', '-print_format', 'json',
      rawUrl(index),
    ];
    const ff = spawn(ffprobePath, args);
    let out = '';
    let err = '';
    ff.stdout.on('data', (d) => (out += d));
    ff.stderr.on('data', (d) => (err += d));
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed: ' + err));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
    ff.on('error', reject);
  });
}

function summarizeProbe(raw) {
  const streams = raw.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const audioTracks = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s, i) => ({
      index: i,
      codec: s.codec_name,
      channels: s.channels,
      language: s.tags && s.tags.language,
      title: (s.tags && s.tags.title) || null,
    }));
  const subtitleTracks = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s, i) => ({
      index: i,
      codec: s.codec_name,
      text: ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt'].includes(s.codec_name),
      language: s.tags && s.tags.language,
      title: (s.tags && s.tags.title) || null,
    }));
  const chapters = (raw.chapters || [])
    .map((c) => ({ start: parseFloat(c.start_time) || 0, title: (c.tags && c.tags.title) || '' }))
    .filter((c, i, arr) => i === 0 || c.start > arr[i - 1].start);
  return {
    durationSec: parseFloat(raw.format && raw.format.duration) || null,
    formatName: (raw.format && raw.format.format_name) || '',
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, pixFmt: v.pix_fmt || '' } : null,
    audioTracks,
    subtitleTracks,
    chapters,
  };
}

function decideMode(index, probe) {
  const file = fileByIndex(index);
  const container = ext(file.name);
  const audio = probe.audioTracks[0];
  const nativeContainer = NATIVE_CONTAINER.has(container);
  const nativeVideo = probe.video && NATIVE_VIDEO.has(probe.video.codec);
  const nativeAudio = audio && NATIVE_AUDIO.has(audio.codec);
  if (nativeContainer && nativeVideo && nativeAudio) return 'native';
  return 'transcode';
}

// --- публичный интерфейс ---------------------------------------------------

// webtorrent v2 не читает .torrent по пути с диска: локальный файл отдаём
// содержимым, magnet и http-ссылки идут строкой как есть.
function normalizeSource(source) {
  if (typeof source === 'string' && /^(magnet:|https?:)/i.test(source)) return source;
  if (typeof source === 'string' && fs.existsSync(source)) return fs.readFileSync(source);
  return source;
}

// Локальные видеофайлы открываются напрямую, без торрента. Оборачиваем каждый
// в тот же интерфейс (name, length, createReadStream), что и файл webtorrent,
// поэтому сервер, ffprobe и транскод работают без изменений. Несколько файлов
// становятся плейлистом.
async function openLocalFiles(paths) {
  const seq = ++openSeq;
  await destroyCurrent();
  checkCurrent(seq);
  state.probeCache = {};
  const files = paths.map((p) => {
    const stat = fs.statSync(p);
    return {
      name: p.split('/').pop(),
      path: p,
      length: stat.size,
      createReadStream({ start = 0, end = stat.size - 1 } = {}) {
        return fs.createReadStream(p, { start, end });
      },
    };
  });
  // Имя набора: папка при нескольких файлах, иначе имя файла (ключ для памяти).
  const name = files.length > 1 ? (paths[0].split('/').slice(-2, -1)[0] || 'Local files') : files[0].name;
  state.torrent = { files, name, destroy: (cb) => cb && cb() };
  await startServer();
  checkCurrent(seq);
  console.log('[local] ready:', name, '| files:', files.length, '| port:', state.port);
  return {
    name,
    infoHash: null,
    files: files.map((f, i) => ({ index: i, name: f.name, length: f.length, video: isVideo(f.name) })),
  };
}

function isLocalVideoPath(s) {
  return typeof s === 'string' && fs.existsSync(s) && isVideo(s);
}

async function addTorrent(source, tmpDir) {
  // Локальные видеофайлы (список или один) открываем напрямую.
  if (Array.isArray(source) && source.every(isLocalVideoPath)) {
    return openLocalFiles(source);
  }
  if (isLocalVideoPath(source)) {
    return openLocalFiles([source]);
  }
  const seq = ++openSeq;
  await ensureClient();
  checkCurrent(seq);
  await destroyCurrent();
  checkCurrent(seq);
  state.probeCache = {};
  const torrentId = normalizeSource(source);
  // Режим кэша: куски в WindowStore в скрытой папке, выбор кусков ведёт
  // cacheTick (deselect: движок сам ничего не выбирает).
  const addOpts = { path: tmpDir, announce: PUBLIC_TRACKERS };
  let cacheDir = null;
  let torrent = null;
  if (cache.bytes > 0) {
    cacheDir = path.join(tmpDir, '.soba-cache-' + Date.now().toString(36));
    Object.assign(addOpts, {
      store: WindowStore,
      storeCacheSlots: 0,
      deselect: true,
      storeOpts: { soba: { dir: cacheDir, onCreate: (s) => { if (state.pending && state.pending.torrent === torrent) cache.store = s; } } },
    });
  }
  return new Promise((resolve, reject) => {
    torrent = client.add(torrentId, addOpts);
    state.pending = { torrent, reject };
    torrent.on('error', (e) => {
      if (state.pending && state.pending.torrent === torrent) state.pending = null;
      reject(e);
    });
    // Папка раздачи, существовавшая до нас (например, та же раздача уже лежит в
    // выбранной папке), не должна попасть под удаление при выходе: имя раздачи
    // известно с metadata, файлы создаются позже.
    let preexisting = false;
    torrent.on('metadata', () => {
      preexisting = fs.existsSync(path.join(tmpDir, torrent.name));
    });
    torrent.on('ready', async () => {
      if (!state.pending || state.pending.torrent !== torrent) return;
      state.pending = null;
      state.torrent = torrent;
      await startServer();
      if (seq !== openSeq) return reject(new Error('superseded'));
      const files = torrent.files.map((f, i) => ({
        index: i, name: f.name, length: f.length, video: isVideo(f.name),
      }));
      if (cache.store) cache.timer = setInterval(cacheTick, 2000);
      console.log('[torrent] ready:', torrent.name, '| files:', files.length, '| port:', state.port, '| cache:', cache.store ? cache.bytes / 1e9 + ' GB' : 'off');
      resolve({ name: torrent.name, infoHash: torrent.infoHash, files, preexisting, cacheDir });
    });
  });
}

// Качать только выбранный файл, остальные снять с загрузки. Для многофайловой
// раздачи это не даёт грузить все серии разом. Для локального файла и раздачи
// из одного файла это ничего не меняет.
function selectOnly(index) {
  const t = state.torrent;
  if (!t || typeof t.deselect !== 'function' || !t.pieces) return;
  if (cache.store) {
    cache.index = index;
    cache.window = null;
    cache.prefetch = null;
    cacheTick();
    return;
  }
  try {
    t.deselect(0, t.pieces.length - 1, 0);
    t.files.forEach((f, i) => (i === index ? f.select() : f.deselect()));
  } catch (_) {}
}

// Предзагрузить начало следующего файла (первые несколько минут) низким
// приоритетом, чтобы переход к следующей серии был мгновенным.
function prefetchBytes(index, bytes) {
  const t = state.torrent;
  if (!t || typeof t.select !== 'function' || !t.pieces) return;
  const file = t.files[index];
  if (!file || file.offset == null) return;
  const start = Math.floor(file.offset / t.pieceLength);
  const end = Math.floor((file.offset + Math.min(bytes, file.length)) / t.pieceLength);
  if (cache.store) cache.prefetch = [start, end];
  try { t.select(start, end, 0); } catch (_) {}
}

async function prepare(index) {
  selectOnly(index);
  const rawProbe = await probeStreams(index);
  const probe = summarizeProbe(rawProbe);
  state.probeCache[index] = probe;
  const mode = decideMode(index, probe);
  const url = mode === 'native' ? rawUrl(index) : `http://127.0.0.1:${state.port}/play/${index}`;
  return { mode, url, probe };
}

// Статус загрузки раздачи. Для локального файла и одиночного файла возвращает
// null (нечего показывать).
function stats() {
  const t = state.torrent;
  if (!t || typeof t.numPeers !== 'number') return null;
  return {
    peers: t.numPeers, downloadSpeed: t.downloadSpeed || 0, progress: t.progress || 0, downloaded: t.downloaded || 0,
    limited: speed.mode === 'auto' ? speed.tier > 0 : parseFloat(speed.mode) > 0,
  };
}

// Доля скачанного для файла (0..1). Для локального файла всегда 1.
function fileProgress(index) {
  const file = fileByIndex(index);
  if (!file) return 0;
  if (typeof file.progress === 'number') return file.progress;
  if (typeof file.downloaded === 'number' && file.length) return file.downloaded / file.length;
  return 1;
}

// Сколько секунд видео скачано подряд от позиции просмотра файла index;
// null, пока позиция этого файла не известна.
function aheadSecondsOf(index) {
  if (!speed.pos || speed.pos.index !== index) return null;
  const a = aheadSeconds();
  return a ? a.sec : null;
}

// Путь к файлу на диске: в папке раздачи или сам локальный файл.
function filePath(index) {
  const file = fileByIndex(index);
  if (!file || !file.path || cache.store) return null;
  if (path.isAbsolute(file.path)) return file.path;
  return path.join(state.torrent.path, file.path);
}

// Копия файла в dest: с диска, а в режиме кэша через движок по кускам.
async function copyFileTo(index, dest) {
  const src = filePath(index);
  if (src) return fs.promises.copyFile(src, dest);
  const file = fileByIndex(index);
  if (!file) throw new Error('no file');
  await require('stream/promises').pipeline(file.createReadStream(), fs.createWriteStream(dest));
}

// Реальное начало потока при seek с копированием видео: ffmpeg стартует с
// ключевого кадра не позже запрошенной позиции и отсчитывает время от него.
// Та же демуксерная перемотка в ffprobe даёт этот кадр (dts первого пакета).
function seekStart(index, sec) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=dts_time,pts_time', '-of', 'csv=p=0',
      '-read_intervals', `${sec}%+#1`, rawUrl(index),
    ];
    const ff = spawn(ffprobePath, args);
    let out = '';
    ff.stdout.on('data', (d) => (out += d));
    ff.on('error', () => resolve(sec));
    ff.on('close', () => {
      const [dts, pts] = out.trim().split('\n')[0]?.split(',') || [];
      const t = parseFloat(dts) || parseFloat(pts);
      resolve(Number.isFinite(t) && t <= sec ? t : sec);
    });
  });
}

// URL потока и точка отсчёта времени для него.
// audioOpts: обработка звука { level, dialog } (флаги l и d в адресе потока).
async function playUrl(index, seekSec, audioTrack, audioOpts) {
  const q = new URLSearchParams();
  let start = 0;
  if (seekSec > 0) {
    q.set('t', String(seekSec));
    const probe = state.probeCache && state.probeCache[index];
    const copyVideo = !!(probe && NATIVE_VIDEO.has(probe.video && probe.video.codec));
    start = copyVideo ? await seekStart(index, seekSec) : seekSec;
  }
  if (audioTrack) q.set('a', String(audioTrack));
  if (audioOpts && audioOpts.dialog) q.set('d', '1');
  if (audioOpts && audioOpts.level) q.set('l', '1');
  return { url: `http://127.0.0.1:${state.port}/play/${index}?${q.toString()}`, start };
}

function subsUrl(index, track, fromSec) {
  const t = fromSec > 0 ? `&t=${fromSec}` : '';
  return `http://127.0.0.1:${state.port}/subs/${index}?track=${track}${t}`;
}

// Конвертация внешнего файла субтитров (srt, ass, ssa, sub, vtt) в WebVTT.
function externalSubs(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-f', 'webvtt', 'pipe:1'];
    const ff = spawn(ffmpegPath, args);
    let out = '';
    let err = '';
    ff.stdout.on('data', (d) => (out += d));
    ff.stderr.on('data', (d) => (err += d));
    ff.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
    ff.on('error', reject);
  });
}

module.exports = {
  addTorrent, prepare, playUrl, subsUrl, externalSubs, prefetchBytes, fileProgress, filePath, stats,
  destroyCurrent, setSubsCacheDir, cacheSubtitles, setSpeedLimit, setPlaybackPos, setCacheLimit,
  rawUrl, seekStart, fileByIndex, aheadSecondsOf, copyFileTo, audioFilters, trackChannels, probeOf: (index) => state.probeCache && state.probeCache[index],
};
