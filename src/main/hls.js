// HLS для AirPlay. Один ffmpeg с позиции просмотра пишет сегменты fMP4 по
// SEGMENT_SEC секунд во временную папку, отдельный сервер отдаёт их в
// локальную сеть: телевизор забирает видео сам, как у стриминговых сервисов.
// Сервер слушает сеть только во время сеанса, путь содержит случайный токен.
//
// Плейлист типа EVENT растёт по мере нарезки. Перемотка внутри нарезанного
// диапазона идёт силами плеера, за его пределами сеанс перезапускается с
// новой позиции (новый номер в пути, чтобы плеер не смешал старые сегменты).
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ffmpegPath } = require('./ffmpeg');
const media = require('./media');

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
const KEEP_BEHIND_SEC = 60;
// Плеер начинает с первого сегмента, а не с «живого края» EVENT-плейлиста.
const START_TAG = '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES';

const session = { server: null, port: 0, token: null, gen: 0, ff: null, dir: null, start: 0, pruned: 0 };

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
      args: ['-c:v', 'hevc_videotoolbox', '-profile:v', 'main10', '-pix_fmt', 'p010le', '-b:v', '20M', '-tag:v', 'hvc1', ...keyframes],
    };
  }
  const rate = (v.height || 1080) > 1080 ? '25M' : '12M';
  return { copy: false, args: ['-c:v', 'h264_videotoolbox', '-b:v', rate, '-pix_fmt', 'yuv420p', ...keyframes] };
}

function killFfmpeg() {
  if (session.ff) {
    try { session.ff.kill('SIGKILL'); } catch (_) {}
    session.ff = null;
  }
}

function playlistPath() {
  return session.dir && path.join(session.dir, 'index.m3u8');
}

// Сколько секунд уже нарезано от начала сеанса.
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

// Плейлист отдаётся, когда в нём есть хотя бы два сегмента: иначе плеер
// считает поток пустым и сдаётся.
async function servePlaylist(res, gen) {
  for (let i = 0; i < 240; i++) {
    if (gen !== session.gen) break;
    let text = null;
    try { text = fs.readFileSync(playlistPath(), 'utf8'); } catch (_) {}
    if (text && (segmentCount(text) >= 2 || text.includes('#EXT-X-ENDLIST'))) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
      return res.end(text.replace('#EXTM3U\n', `#EXTM3U\n${START_TAG}\n`));
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  res.writeHead(503);
  res.end();
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
      if (name === 'index.m3u8') return servePlaylist(res, session.gen);
      if (/^(init\.mp4|seg_\d{5}\.m4s)$/.test(name)) return serveFile(req, res, name);
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

// Начать (или перезапустить) нарезку файла index с секунды sec. Возвращает
// адрес плейлиста и реальную секунду начала потока: при копировании видео
// это ключевой кадр не позже sec.
async function start(index, sec, audioTrack) {
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

  const video = videoArgs(probe, file);
  const from = Math.max(0, sec || 0);
  const realStart = from > 0 && video.copy ? await media.seekStart(index, from) : from;
  if (gen !== session.gen) throw new Error('superseded');
  session.start = realStart;

  const args = ['-hide_banner', '-loglevel', 'error', '-readrate', READ_RATE, '-readrate_initial_burst', READ_BURST_SEC];
  if (from > 0 && video.copy) args.push('-noaccurate_seek');
  if (from > 0) args.push('-ss', String(from));
  args.push('-i', media.rawUrl(index));
  args.push('-map', '0:v:0', '-map', `0:a:${audioTrack || 0}?`, '-sn', '-dn');
  args.push(...video.args);
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SEC),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_flags', 'temp_file+independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.m4s'),
    path.join(dir, 'index.m3u8'),
  );
  const ff = spawn(ffmpegPath, args);
  session.ff = ff;
  ff.stderr.on('data', (d) => console.warn('[ffmpeg hls]', d.toString().trim()));
  ff.on('close', () => { if (session.ff === ff) session.ff = null; });
  console.log('[hls] start', { index, from, realStart, copy: video.copy });
  return {
    url: `http://${host}:${session.port}/${session.token}/${gen}/index.m3u8`,
    start: realStart,
    copy: video.copy,
  };
}

// Нарезанный и ещё не удалённый диапазон текущего сеанса в секундах файла.
function range() {
  if (!session.dir) return null;
  return { start: session.start + session.pruned, end: session.start + produced() };
}

// Удалить сегменты, закончившиеся раньше pos - KEEP_BEHIND_SEC (pos в секундах файла).
function prune(pos) {
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
  if (session.server) {
    try { session.server.close(); } catch (_) {}
    session.server = null;
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
}

module.exports = { start, stop, range, prune };
