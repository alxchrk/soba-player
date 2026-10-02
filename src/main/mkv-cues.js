// Ключевые кадры видео из индекса Matroska (элемент Cues) без чтения всего
// файла: SeekHead в начале сегмента указывает, где лежат Info, Tracks и Cues,
// они читаются запросами Range к raw-серверу плеера. Для раздачи это несколько
// кусков: начало файла и место индекса (обычно конец).
'use strict';

const http = require('http');

const ID = {
  SEGMENT: 0x18538067, SEEK_HEAD: 0x114d9b74, SEEK: 0x4dbb, SEEK_ID: 0x53ab, SEEK_POS: 0x53ac,
  INFO: 0x1549a966, TIMESTAMP_SCALE: 0x2ad7b1, DURATION: 0x4489,
  TRACKS: 0x1654ae6b, TRACK_ENTRY: 0xae, TRACK_NUMBER: 0xd7, TRACK_TYPE: 0x83,
  CUES: 0x1c53bb6b, CUE_POINT: 0xbb, CUE_TIME: 0xb3, CUE_TRACK_POSITIONS: 0xb7, CUE_TRACK: 0xf7,
};
const MASTERS = new Set([ID.SEEK_HEAD, ID.SEEK, ID.INFO, ID.TRACKS, ID.TRACK_ENTRY, ID.CUES, ID.CUE_POINT, ID.CUE_TRACK_POSITIONS]);
// Индекс трёхчасового фильма с кадром каждые пару секунд занимает сотни КБ.
const MAX_ELEMENT = 32 * 1024 * 1024;

function fetchRange(url, start, end) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Range: `bytes=${start}-${end}` } }, (res) => {
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume();
        return reject(new Error('range request failed: ' + res.statusCode));
      }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('range request timeout')));
  });
}

// Число переменной длины EBML. keepMarker: для ID маркер длины остаётся в значении.
function readVint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let unknown = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) unknown = false;
  }
  return { value, len, unknown: !keepMarker && unknown };
}

function readHeader(buf, pos) {
  const id = readVint(buf, pos, true);
  if (!id) return null;
  const size = readVint(buf, pos + id.len, false);
  if (!size) return null;
  return { id: id.value, size: size.unknown ? null : size.value, dataStart: pos + id.len + size.len };
}

function readUint(buf, start, size) {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[start + i];
  return v;
}

function readFloat(buf, start, size) {
  if (size === 4) return buf.readFloatBE(start);
  if (size === 8) return buf.readDoubleBE(start);
  return 0;
}

// Обход дочерних элементов master-элемента: onChild(id, dataStart, size).
function walk(buf, start, end, onChild) {
  let pos = start;
  while (pos < end) {
    const h = readHeader(buf, pos);
    if (!h || h.size == null) return;
    onChild(h.id, h.dataStart, h.size);
    if (MASTERS.has(h.id)) walk(buf, h.dataStart, Math.min(end, h.dataStart + h.size), onChild);
    pos = h.dataStart + h.size;
  }
}

// Элемент целиком по абсолютному смещению в файле.
async function fetchElement(url, offset) {
  const head = await fetchRange(url, offset, offset + 15);
  const h = readHeader(head, 0);
  if (!h || h.size == null || h.size > MAX_ELEMENT) throw new Error('bad element at ' + offset);
  const body = await fetchRange(url, offset, offset + h.dataStart + h.size - 1);
  return { buf: body, h };
}

// Времена ключевых кадров видео в секундах по возрастанию и длительность файла.
// null: индекса нет или в нём нет видео.
async function readKeyframes(url) {
  const start = await fetchRange(url, 0, 65535);
  let pos = 0;
  const ebml = readHeader(start, 0);
  if (!ebml) return null;
  pos = ebml.dataStart + ebml.size;
  const seg = readHeader(start, pos);
  if (!seg || seg.id !== ID.SEGMENT) return null;
  const segData = seg.dataStart;

  // Уровень 1 в начале файла: SeekHead, иногда сразу Info и Tracks.
  const where = {};
  const top = {};
  let p = segData;
  while (p < start.length) {
    const h = readHeader(start, p);
    if (!h || h.size == null) break;
    top[h.id] = top[h.id] || p;
    if (h.id === ID.SEEK_HEAD && h.dataStart + h.size <= start.length) {
      let seekId = null;
      walk(start, h.dataStart, h.dataStart + h.size, (id, ds, size) => {
        if (id === ID.SEEK_ID) seekId = readUint(start, ds, size);
        if (id === ID.SEEK_POS && seekId != null) { where[seekId] = segData + readUint(start, ds, size); seekId = null; }
      });
    }
    if (h.id === 0x1f43b675) break; // Cluster: дальше медиаданные
    p = h.dataStart + h.size;
  }
  const at = (id) => where[id] != null ? where[id] : top[id];
  if (at(ID.CUES) == null || at(ID.INFO) == null || at(ID.TRACKS) == null) return null;

  let scale = 1e6;
  let duration = 0;
  const info = await fetchElement(url, at(ID.INFO));
  walk(info.buf, info.h.dataStart, info.buf.length, (id, ds, size) => {
    if (id === ID.TIMESTAMP_SCALE) scale = readUint(info.buf, ds, size);
    if (id === ID.DURATION) duration = readFloat(info.buf, ds, size);
  });

  let videoTrack = null;
  const tracks = await fetchElement(url, at(ID.TRACKS));
  let num = null;
  let type = null;
  walk(tracks.buf, tracks.h.dataStart, tracks.buf.length, (id, ds, size) => {
    if (id === ID.TRACK_ENTRY) { num = null; type = null; }
    if (id === ID.TRACK_NUMBER) num = readUint(tracks.buf, ds, size);
    if (id === ID.TRACK_TYPE) type = readUint(tracks.buf, ds, size);
    if (num != null && type === 1 && videoTrack == null) videoTrack = num;
  });
  if (videoTrack == null) return null;

  const cues = await fetchElement(url, at(ID.CUES));
  const times = [];
  let time = null;
  walk(cues.buf, cues.h.dataStart, cues.buf.length, (id, ds, size) => {
    if (id === ID.CUE_TIME) time = readUint(cues.buf, ds, size);
    if (id === ID.CUE_TRACK && time != null && readUint(cues.buf, ds, size) === videoTrack) times.push((time * scale) / 1e9);
  });
  if (!times.length) return null;
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  return { keyframes: sorted, durationSec: (duration * scale) / 1e9 };
}

module.exports = { readKeyframes };
