// HLS для AirPlay. ffmpeg с позиции просмотра пишет сегменты fMP4 во
// временную папку, отдельный сервер отдаёт их в локальную сеть: телевизор
// забирает видео сам, как у стриминговых сервисов. Сервер слушает сеть только
// во время сеанса, путь содержит случайный токен.
//
// Два режима плейлиста:
// - VOD (видео копируется, у mkv есть индекс ключевых кадров): плейлист всего
//   фильма от нуля до конца строится сразу, сегмент равен промежутку между
//   соседними ключевыми кадрами, время в сегментах абсолютное. Телевизор знает
//   длительность и позицию, перематывает сам. Запрос ещё не нарезанного сегмента
//   ждёт его готовности; запрос далеко впереди нарезки или позади неё
//   перезапускает ffmpeg с этого сегмента. Плейлист не меняется, поэтому
//   ошибка «плейлист не обновляется» (-12888) здесь невозможна.
// - EVENT (перекодирование или нет индекса): плейлист растёт по мере нарезки
//   сегментами по SEGMENT_SEC. Перемотка внутри нарезанного идёт силами плеера,
//   за его пределами сеанс перезапускается с новой позиции (новый номер в пути).
//
// Субтитры: отдельный ffmpeg с той же позиции пишет выбранную дорожку (встроенную
// или внешний файл) в .vtt. Вторым выходом ffmpeg нарезки их не пишет: с
// редкими пакетами субтитров -readrate сбивается, нарезка идёт рывками в темпе
// около 1x. Мастер-плейлист, плейлист субтитров и сегменты WebVTT по
// SUB_SEGMENT_SEC собираются здесь: собственные плейлисты субтитров ffmpeg для
// HLS получаются с неверными ссылками.
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ffmpegPath } = require('./ffmpeg');
const media = require('./media');
const mkvCues = require('./mkv-cues');

const SEGMENT_SEC = 4;
const ROOT = path.join(os.tmpdir(), 'torrent-player-hls');
// Выше этого битрейта исходник пережимается: Wi-Fi до телевизора его не
// вытягивает (фильм на 40 ГБ длиной 2 часа это ~45 Мбит/с).
const COPY_MAX_BITRATE = 25e6;
// Нарезка идёт не быстрее READ_RATE скорости фильма после первых
// READ_BURST_SEC: запас впереди телевизора растёт медленно и не съедает диск
// и лимит кэша раздачи. Просмотренные сегменты старше KEEP_BEHIND_SEC удаляются.
const READ_RATE = '1.2';
const READ_BURST_SEC = '120';
const KEEP_BEHIND_SEC = 300;
const SUBS_READ_RATE = '2';
const SUBS_READ_BURST_SEC = '300';
const SUB_SEGMENT_SEC = 30;
// Реплики и видео в одной шкале времени (EVENT: от начала потока, VOD: от начала фильма).
const SUB_TIMESTAMP_MAP = 'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000';
// VOD: запрос сегмента дальше края нарезки не больше чем на столько сегментов
// ждёт её, дальше нарезка перезапускается с запрошенного.
const LOOKAHEAD_SEGMENTS = 20;
const SEGMENT_WAIT_MS = 90000;
// Отпускает запрос субтитров обычно нарезка видео (она впереди телевизора),
// предел нужен на случай, если нарезка встала.
const SUBS_WAIT_MS = 60000;
const POLL_MS = 200;
// -ss чуть позже ключевого кадра: для видео с B-кадрами ffmpeg сам отступает
// от точки поиска на 3/23 с назад, и без запаса поиск уходит на предыдущий
// кадр, а номера сегментов сдвигаются на один. Ключевые кадры реже 0.2 с не стоят.
const SEEK_EPSILON_SEC = 0.2;
const KEYFRAMES_TIMEOUT_MS = 20000;

const session = {
  server: null, port: 0, token: null, gen: 0, ff: null, subsFf: null, dir: null, start: 0, pruned: 0,
  subs: null, bandwidth: 0,
  // VOD: план сегментов, текущая нарезка и прогресс субтитров.
  vod: null, runStart: 0, makeArgs: null, subsRuns: [], makeSubsArgs: null, subsWhole: false, startAt: 0,
};

// Индекс ключевых кадров по номеру файла раздачи: чтение индекса стоит
// нескольких запросов к раздаче, повторные сеансы берут готовый.
const keyframeCache = new Map();

// IPv4-адрес Mac в локальной сети: сначала Wi-Fi/Ethernet en0, потом любой.
function lanAddress() {
  const ifaces = os.networkInterfaces();
  const pick = (list) => (list || []).find((a) => a.family === 'IPv4' && !a.internal);
  const en0 = pick(ifaces.en0);
  if (en0) return en0.address;
  for (const name of Object.keys(ifaces)) {
    const a = pick(ifaces[name]);
    if (a) return a.address;
  }
  return null;
}

// Параметры видео: копия, если телевизор примет поток как есть и он не
// слишком тяжёлый, иначе аппаратное пережатие. 10-битный исходник (обычно
// HDR) идёт в HEVC Main10 с той же цветовой разметкой, чтобы не потерять цвета.
function videoArgs(probe, file) {
  const v = probe.video || {};
  const bitrate = probe.durationSec ? (file.length * 8) / probe.durationSec : Infinity;
  const tenBit = /10/.test(v.pixFmt || '');
  const keyframes = ['-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SEC})`];
  if ((v.codec === 'h264' || v.codec === 'hevc') && bitrate <= COPY_MAX_BITRATE) {
    return { copy: true, args: ['-c:v', 'copy', ...(v.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])] };
  }
  if (tenBit) {
    return {
      copy: false,
      bitrate: 20e6,
      args: ['-c:v', 'hevc_videotoolbox', '-profile:v', 'main10', '-pix_fmt', 'p010le', '-b:v', '20M', '-tag:v', 'hvc1', ...keyframes],
    };
  }
  const rate = (v.height || 1080) > 1080 ? 25e6 : 12e6;
  return { copy: false, bitrate: rate, args: ['-c:v', 'h264_videotoolbox', '-b:v', String(rate), '-pix_fmt', 'yuv420p', ...keyframes] };
}

// План VOD: начало и длительность каждого сегмента по ключевым кадрам mkv.
// null, если индекса нет (не mkv, битый индекс, раздача не отдала конец файла).
async function vodPlan(index, durationSec) {
  if (!keyframeCache.has(index)) {
    let r = null;
    try {
      r = await Promise.race([
        mkvCues.readKeyframes(media.rawUrl(index)),
        new Promise((resolve) => setTimeout(() => resolve(null), KEYFRAMES_TIMEOUT_MS)),
      ]);
    } catch (e) {
      console.warn('[hls] keyframe index:', e.message);
    }
    keyframeCache.set(index, r);
  }
  const r = keyframeCache.get(index);
  const total = durationSec || (r && r.durationSec);
  if (!r || !total) return null;
  const starts = r.keyframes.filter((t) => t < total - 0.5);
  if (!starts.length || starts[0] > 0.5) return null;
  const durs = starts.map((t, i) => (i + 1 < starts.length ? starts[i + 1] : total) - t);
  return { starts, durs, total };
}

// Номер сегмента, внутри которого секунда sec.
function segmentAt(sec) {
  const { starts } = session.vod;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= sec) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function segName(k) {
  return `seg_${String(k).padStart(5, '0')}.m4s`;
}

function killProc(key) {
  if (session[key]) {
    try { session[key].kill('SIGKILL'); } catch (_) {}
    session[key] = null;
  }
}

function killFfmpeg() {
  killProc('ff');
  killProc('subsFf');
}

function spawnVideo(args) {
  const ff = spawn(ffmpegPath, args);
  session.ff = ff;
  ff.stderr.on('data', (d) => console.warn('[ffmpeg hls]', d.toString().trim()));
  ff.on('close', () => { if (session.ff === ff) session.ff = null; });
}

// Субтитры с секунды from в файл subs_<n>.vtt. VOD: прогресс нужен, чтобы
// сегмент субтитров отдавался, когда реплики за его время уже прочитаны.
function spawnSubs(from) {
  if (!session.makeSubsArgs) return;
  killProc('subsFf');
  const run = { from, progress: from, done: false, file: `subs_${session.subsRuns.length}.vtt` };
  session.subsRuns.push(run);
  const subsFf = spawn(ffmpegPath, session.makeSubsArgs(from, path.join(session.dir, run.file)));
  session.subsFf = subsFf;
  let buf = '';
  subsFf.stdout.on('data', (d) => {
    buf += d;
    const m = buf.match(/out_time_us=(\d+)/g);
    if (m) run.progress = Math.max(run.progress, from + parseInt(m[m.length - 1].slice(12), 10) / 1e6);
    buf = buf.slice(-200);
  });
  subsFf.stderr.on('data', (d) => console.warn('[ffmpeg hls subs]', d.toString().trim()));
  subsFf.on('close', () => {
    run.done = true;
    if (session.subsFf === subsFf) session.subsFf = null;
  });
}

// VOD: нарезка с сегмента k (видео и субтитры).
function startRun(k) {
  killProc('ff');
  session.runStart = k;
  session.pruned = Math.min(session.pruned, k);
  fs.rmSync(path.join(session.dir, 'ff.m3u8'), { force: true });
  spawnVideo(session.makeArgs(k));
  // Внешний файл переводится целиком один раз, встроенная дорожка читается с k.
  if (session.subsWhole) {
    if (!session.subsRuns.length) spawnSubs(0);
  } else {
    spawnSubs(session.vod.starts[k]);
  }
  console.log('[hls] run from segment', k, 'at', session.vod.starts[k].toFixed(3));
}

// VOD: первый ещё не нарезанный сегмент текущей нарезки.
function runNext() {
  let text = '';
  try { text = fs.readFileSync(path.join(session.dir, 'ff.m3u8'), 'utf8'); } catch (_) {}
  return session.runStart + (text.match(/#EXTINF:/g) || []).length;
}

function playlistPath() {
  return session.dir && path.join(session.dir, 'index.m3u8');
}

// EVENT: сколько секунд уже нарезано от начала сеанса.
function produced() {
  try {
    const text = fs.readFileSync(playlistPath(), 'utf8');
    let sum = 0;
    for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) sum += parseFloat(m[1]);
    return sum;
  } catch (_) {
    return 0;
  }
}

function segmentCount(text) {
  return (text.match(/#EXTINF:/g) || []).length;
}

// Плеер начинает с первого сегмента, а не с «живого края» EVENT-плейлиста.
const EVENT_START_TAG = '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES';

// EVENT: плейлист отдаётся, когда в нём есть хотя бы два сегмента: иначе
// плеер считает поток пустым и сдаётся.
async function serveEventPlaylist(res, gen) {
  for (let i = 0; i < 240; i++) {
    if (gen !== session.gen) break;
    let text = null;
    try { text = fs.readFileSync(playlistPath(), 'utf8'); } catch (_) {}
    if (text && (segmentCount(text) >= 2 || text.includes('#EXT-X-ENDLIST'))) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
      return res.end(text.replace('#EXTM3U\n', `#EXTM3U\n${EVENT_START_TAG}\n`));
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  res.writeHead(503);
  res.end();
}

// VOD: весь фильм сразу. Старт с позиции, с которой открыт сеанс.
function serveVodPlaylist(res) {
  const { starts, durs } = session.vod;
  const target = Math.ceil(Math.max(...durs));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-START:TIME-OFFSET=${session.startAt.toFixed(3)},PRECISE=YES`, '#EXT-X-MAP:URI="init.mp4"'];
  for (let k = 0; k < starts.length; k++) lines.push(`#EXTINF:${durs[k].toFixed(6)},`, segName(k));
  lines.push('#EXT-X-ENDLIST');
  sendText(res, 'application/vnd.apple.mpegurl', lines.join('\n') + '\n');
}

function readText(name) {
  try { return fs.readFileSync(path.join(session.dir, name), 'utf8'); } catch (_) { return null; }
}

function sendText(res, type, text) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(text);
}

// Видео плюс группа субтитров из одной дорожки, выбранной сразу.
function serveMaster(res) {
  const name = String(session.subs.name).replace(/"/g, "'");
  const lang = session.subs.lang ? `LANGUAGE="${session.subs.lang}",` : '';
  sendText(res, 'application/vnd.apple.mpegurl', [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${name}",${lang}DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="subs.m3u8"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=${session.bandwidth},SUBTITLES="subs"`,
    'index.m3u8',
    '',
  ].join('\n'));
}

// Плейлист субтитров: VOD на весь фильм, EVENT покрывает уже нарезанное.
function serveSubsPlaylist(res) {
  const vod = session.vod;
  const total = vod ? vod.total : produced();
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SUB_SEGMENT_SEC}`,
    '#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-PLAYLIST-TYPE:${vod ? 'VOD' : 'EVENT'}`];
  for (let k = 0; k * SUB_SEGMENT_SEC < total; k++) {
    const dur = Math.min(SUB_SEGMENT_SEC, total - k * SUB_SEGMENT_SEC);
    lines.push(`#EXTINF:${dur.toFixed(3)},`, `sub_${k}.vtt`);
  }
  if (vod || (readText('index.m3u8') || '').includes('#EXT-X-ENDLIST')) lines.push('#EXT-X-ENDLIST');
  sendText(res, 'application/vnd.apple.mpegurl', lines.join('\n') + '\n');
}

function vttSeconds(s) {
  const m = /(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/.exec(s);
  return m ? (parseInt(m[1] || 0, 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000) : 0;
}

// VOD: секунда фильма, до которой нарезано видео текущей нарезки.
function videoProducedUntil() {
  const { starts, total } = session.vod;
  const next = runNext();
  return next < starts.length ? starts[next] : total;
}

// Сегмент k: реплики, пересекающие [k*S, (k+1)*S), из всех файлов субтитров
// сеанса. VOD: сначала ждём, пока чтение субтитров пройдёт конец сегмента,
// иначе телевизор запомнит пустой сегмент. У редкой дорожки (только надписи)
// ffmpeg прогресс не сообщает, поэтому достаточно, чтобы дальше конца уже
// было нарезано видео: субтитры читаются быстрее видео. Ждём не дольше
// SUBS_WAIT_MS: телевизор без сегмента субтитров останавливает и видео.
async function serveSubsSegment(req, res, k, gen) {
  const from = k * SUB_SEGMENT_SEC;
  const to = from + SUB_SEGMENT_SEC;
  if (session.vod) {
    const end = Math.min(to, session.vod.total);
    const deadline = Date.now() + SUBS_WAIT_MS;
    while (Date.now() < deadline && gen === session.gen && !req.destroyed) {
      const run = session.subsRuns[session.subsRuns.length - 1];
      if (!run || run.done || run.from > from + 0.5 || run.progress >= end || videoProducedUntil() >= end) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (gen !== session.gen || req.destroyed) return res.destroy();
  }
  const files = session.vod ? session.subsRuns.map((r) => r.file) : ['subs.vtt'];
  const seen = new Set();
  const cues = [];
  for (const f of files) {
    for (const block of (readText(f) || '').replace(/\r/g, '').split(/\n\n+/)) {
      const line = block.split('\n').find((l) => l.includes('-->'));
      if (!line) continue;
      const [a, b] = line.split('-->');
      if (!(vttSeconds(b) > from && vttSeconds(a) < to)) continue;
      const key = block.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      cues.push(key);
    }
  }
  sendText(res, 'text/vtt', ['WEBVTT', SUB_TIMESTAMP_MAP, '', ...cues.map((c) => c + '\n')].join('\n'));
}

function serveFile(req, res, name) {
  const file = path.join(session.dir, name);
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size });
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

// VOD: сегмент (или init.mp4, k = null) отдаётся, когда нарезан. Если
// нарезка стоит, ушла дальше запрошенного или не дойдёт до него в пределах
// LOOKAHEAD_SEGMENTS, она перезапускается с запрошенного сегмента.
async function serveVodFile(req, res, name, k, gen) {
  const file = path.join(session.dir, name);
  const deadline = Date.now() + SEGMENT_WAIT_MS;
  let restarted = false;
  while (gen === session.gen && !req.destroyed) {
    if (fs.existsSync(file)) return serveFile(req, res, name);
    if (Date.now() > deadline) break;
    if (k != null && !restarted) {
      const next = runNext();
      // k < next при отсутствии файла: сегмент уже удалён как просмотренный.
      if (!session.ff || k < session.runStart || k < next || k > next + LOOKAHEAD_SEGMENTS) {
        startRun(k);
        restarted = true;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (!res.headersSent && !req.destroyed) {
    res.writeHead(503);
    res.end();
  }
}

function ensureServer() {
  if (session.server) return Promise.resolve();
  session.token = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Путь: /<токен>/<номер сеанса>/<файл>. Имя файла строго из тех, что пишет ffmpeg.
      const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
      const [token, gen, name] = parts;
      if (parts.length !== 3 || token !== session.token || Number(gen) !== session.gen) {
        res.writeHead(404);
        return res.end();
      }
      if (name === 'index.m3u8') return session.vod ? serveVodPlaylist(res) : serveEventPlaylist(res, session.gen);
      if (session.subs && name === 'master.m3u8') return serveMaster(res);
      if (session.subs && name === 'subs.m3u8') return serveSubsPlaylist(res);
      const sub = /^sub_(\d+)\.vtt$/.exec(name);
      if (session.subs && sub) return serveSubsSegment(req, res, Number(sub[1]), session.gen);
      const seg = /^seg_(\d{5})\.m4s$/.exec(name);
      if (session.vod && (seg || name === 'init.mp4')) {
        const k = seg ? Number(seg[1]) : null;
        if (k != null && k >= session.vod.starts.length) { res.writeHead(404); return res.end(); }
        return serveVodFile(req, res, name, k, session.gen);
      }
      if (seg || name === 'init.mp4') return serveFile(req, res, name);
      res.writeHead(404);
      res.end();
    });
    server.on('error', reject);
    server.listen(0, '0.0.0.0', () => {
      session.server = server;
      session.port = server.address().port;
      resolve();
    });
  });
}

// Трёхбуквенные коды языка из mkv в коды BCP 47 для атрибута LANGUAGE:
// без него плеер телевизора называет дорожку «Unknown».
const LANG = {
  rus: 'ru', eng: 'en', ukr: 'uk', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it',
  jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', por: 'pt', pol: 'pl', tur: 'tr',
};

// Название и язык дорожки субтитров для меню телевизора.
function subsInfo(probe, subs) {
  if (subs.kind === 'file') return { name: subs.name || 'Subtitles', lang: null };
  const tr = (probe.subtitleTracks || []).find((t) => t.index === subs.track) || {};
  const code = String(tr.language || '').toLowerCase();
  return { name: tr.title || tr.language || 'Subtitles', lang: LANG[code] || (code.length === 2 ? code : null) };
}

// Общая часть команды нарезки: вход, дорожки, видео, звук.
function mediaArgs(index, probe, video, audioTrack, audioOpts, seekArgs) {
  const args = ['-hide_banner', '-loglevel', 'error', '-readrate', READ_RATE, '-readrate_initial_burst', READ_BURST_SEC];
  args.push(...seekArgs.input, '-i', media.rawUrl(index));
  args.push('-map', '0:v:0', '-map', `0:a:${audioTrack || 0}?`, '-sn', '-dn');
  args.push(...video.args);
  args.push(...media.audioFilters(media.trackChannels(probe, audioTrack), audioOpts || {}));
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', ...seekArgs.output);
  return args;
}

function hlsArgs(dir, playlist, extra) {
  return [
    '-f', 'hls',
    ...extra,
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_flags', 'temp_file+independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.m4s'),
    path.join(dir, playlist),
  ];
}

// Начать (или перезапустить) нарезку файла index с секунды sec. Возвращает
// адрес плейлиста и секунду, от которой считается время потока (VOD: 0,
// EVENT: начало нарезки; при копировании видео это ключевой кадр не позже
// sec). subs: выбор субтитров плеера ({ kind: 'track', track } или
// { kind: 'file', path, name }) или null. audioOpts: { level, dialog }.
async function start(index, sec, audioTrack, subs, audioOpts) {
  const file = media.fileByIndex(index);
  const probe = media.probeOf(index);
  if (!file || !probe) throw new Error('file is not prepared');
  const host = lanAddress();
  if (!host) throw new Error('no local network address');
  await ensureServer();
  killFfmpeg();
  const gen = ++session.gen;
  const dir = path.join(ROOT, String(gen));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  session.dir = dir;
  session.pruned = 0;
  session.vod = null;
  session.subsRuns = [];
  session.makeSubsArgs = null;

  const video = videoArgs(probe, file);
  const bitrate = probe.durationSec ? (file.length * 8) / probe.durationSec : 20e6;
  session.bandwidth = Math.round((video.copy ? bitrate : video.bitrate) + 192e3);
  const textTrack = subs && subs.kind === 'track' && (probe.subtitleTracks || []).some((t) => t.index === subs.track && t.text);
  const subsFile = subs && subs.kind === 'file' && subs.path && fs.existsSync(subs.path);
  const from = Math.max(0, sec || 0);
  const plan = video.copy ? await vodPlan(index, probe.durationSec) : null;
  if (gen !== session.gen) throw new Error('superseded');
  session.subs = textTrack || subsFile ? subsInfo(probe, subs) : null;
  const url = `http://${host}:${session.port}/${session.token}/${gen}/${session.subs ? 'master' : 'index'}.m3u8`;

  if (plan) {
    session.vod = plan;
    session.start = 0;
    session.startAt = from;
    // Нарезка с ключевого кадра сегмента k: время в сегментах абсолютное
    // (сдвиг выхода равен точке входа), номера сегментов совпадают с планом,
    // каждый ключевой кадр начинает новый сегмент.
    session.makeArgs = (k) => {
      const at = String(plan.starts[k] + (k > 0 ? SEEK_EPSILON_SEC : 0));
      const seek = k > 0 ? { input: ['-noaccurate_seek', '-ss', at], output: ['-output_ts_offset', at] } : { input: [], output: [] };
      return [...mediaArgs(index, probe, video, audioTrack, audioOpts, seek),
        ...hlsArgs(dir, 'ff.m3u8', ['-hls_time', '0.001', '-start_number', String(k)])];
    };
    if (textTrack) {
      session.makeSubsArgs = (at, out) => ['-hide_banner', '-loglevel', 'error', '-readrate', SUBS_READ_RATE,
        '-readrate_initial_burst', SUBS_READ_BURST_SEC, ...(at > 0 ? ['-ss', String(at)] : []), '-i', media.rawUrl(index),
        '-map', `0:s:${subs.track}`, ...(at > 0 ? ['-output_ts_offset', String(at)] : []),
        '-flush_packets', '1', '-progress', 'pipe:1', '-f', 'webvtt', out];
    } else if (subsFile) {
      // Внешний файл на диске, время как в файле.
      session.makeSubsArgs = (_at, out) => ['-hide_banner', '-loglevel', 'error', '-i', subs.path,
        '-progress', 'pipe:1', '-f', 'webvtt', out];
    }
    session.subsWhole = !!subsFile;
    startRun(segmentAt(from));
    console.log('[hls] start vod', { index, from, segments: plan.starts.length, subs: session.subs && session.subs.name });
    return { url, subs: !!session.subs, start: 0, copy: true };
  }

  const realStart = from > 0 && video.copy ? await media.seekStart(index, from) : from;
  if (gen !== session.gen) throw new Error('superseded');
  session.start = realStart;
  const seek = from > 0
    ? { input: [...(video.copy ? ['-noaccurate_seek'] : []), '-ss', String(from)], output: [] }
    : { input: [], output: [] };
  spawnVideo([...mediaArgs(index, probe, video, audioTrack, audioOpts, seek),
    ...hlsArgs(dir, 'index.m3u8', ['-hls_time', String(SEGMENT_SEC)])]);
  if (textTrack || subsFile) {
    // Встроенная дорожка читается из раздачи быстрее нарезки видео, чтобы
    // реплики были готовы раньше сегментов; внешний файл лежит на диске целиком.
    const conv = ['-hide_banner', '-loglevel', 'error'];
    if (textTrack) conv.push('-readrate', SUBS_READ_RATE, '-readrate_initial_burst', SUBS_READ_BURST_SEC);
    if (realStart > 0) conv.push('-ss', String(realStart));
    conv.push('-i', textTrack ? media.rawUrl(index) : subs.path);
    if (textTrack) conv.push('-map', `0:s:${subs.track}`);
    conv.push('-flush_packets', '1', '-f', 'webvtt', path.join(dir, 'subs.vtt'));
    const subsFf = spawn(ffmpegPath, conv);
    session.subsFf = subsFf;
    subsFf.stderr.on('data', (d) => console.warn('[ffmpeg hls subs]', d.toString().trim()));
    subsFf.on('close', () => { if (session.subsFf === subsFf) session.subsFf = null; });
  }
  console.log('[hls] start event', { index, from, realStart, copy: video.copy, subs: session.subs && session.subs.name });
  return { url, subs: !!session.subs, start: realStart, copy: video.copy };
}

// Диапазон, внутри которого перемотка идёт силами плеера, в секундах файла.
// VOD: весь фильм, недостающее нарезается по запросу.
function range() {
  if (!session.dir) return null;
  if (session.vod) return { start: 0, end: session.vod.total };
  return { start: session.start + session.pruned, end: session.start + produced() };
}

// Удалить сегменты, закончившиеся раньше pos - KEEP_BEHIND_SEC (pos в секундах файла).
function prune(pos) {
  if (session.vod) {
    const { starts, durs } = session.vod;
    const limit = pos - KEEP_BEHIND_SEC;
    let k = session.pruned;
    for (; k < starts.length && starts[k] + durs[k] < limit; k++) {
      fs.rm(path.join(session.dir, segName(k)), { force: true }, () => {});
    }
    session.pruned = k;
    return;
  }
  let text;
  try { text = fs.readFileSync(playlistPath(), 'utf8'); } catch (_) { return; }
  const limit = pos - KEEP_BEHIND_SEC - session.start;
  let t = 0;
  let dur = 0;
  for (const line of text.split('\n')) {
    const m = /^#EXTINF:([\d.]+)/.exec(line);
    if (m) { dur = parseFloat(m[1]); continue; }
    if (!/^seg_\d{5}\.m4s$/.test(line)) continue;
    if (t + dur > limit) break;
    t += dur;
    if (t > session.pruned) fs.rm(path.join(session.dir, line), { force: true }, () => {});
  }
  session.pruned = Math.max(session.pruned, t);
}

function stop() {
  killFfmpeg();
  session.gen++;
  session.dir = null;
  session.subs = null;
  session.vod = null;
  session.subsRuns = [];
  if (session.server) {
    try { session.server.close(); } catch (_) {}
    session.server = null;
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
}

module.exports = { start, stop, range, prune };
