// Хранилище кусков торрента для режима ограниченного кэша: каждый кусок
// лежит отдельным файлом в папке раздачи, поэтому ненужный кусок удаляется
// с диска целиком (в общем файле на macOS место так не освободить).
// Интерфейс abstract-chunk-store (put, get, close, destroy), который ждёт
// webtorrent. Что и когда удалять, решает media.js через evict().
'use strict';

const fs = require('fs');
const path = require('path');

class WindowStore {
  constructor(chunkLength, opts) {
    this.chunkLength = chunkLength;
    this.length = opts.length;
    this.lastChunkLength = this.length % chunkLength || chunkLength;
    this.lastIndex = Math.ceil(this.length / chunkLength) - 1;
    this.dir = opts.soba.dir;
    this.sizes = new Map(); // номер куска -> байт на диске
    this.bytes = 0;
    fs.mkdirSync(this.dir, { recursive: true });
    if (opts.soba.onCreate) opts.soba.onCreate(this);
  }

  file(index) {
    return path.join(this.dir, String(index));
  }

  put(index, buf, cb = () => {}) {
    fs.writeFile(this.file(index), buf, (err) => {
      if (!err) {
        this.bytes += buf.length - (this.sizes.get(index) || 0);
        this.sizes.set(index, buf.length);
      }
      cb(err || null);
    });
  }

  get(index, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = null; }
    const size = this.sizes.get(index);
    if (size == null) return queueMicrotask(() => cb(new Error('Chunk not found')));
    const offset = (opts && opts.offset) || 0;
    const length = (opts && opts.length != null) ? opts.length : size - offset;
    fs.open(this.file(index), 'r', (err, fd) => {
      if (err) return cb(err);
      const buf = Buffer.alloc(length);
      fs.read(fd, buf, 0, length, offset, (err2, read) => {
        fs.close(fd, () => {});
        if (err2) return cb(err2);
        cb(null, read === length ? buf : buf.subarray(0, read));
      });
    });
  }

  has(index) {
    return this.sizes.has(index);
  }

  indexes() {
    return Array.from(this.sizes.keys());
  }

  // Удалить кусок с диска. Отметку «скачан» в торренте снимает вызывающий.
  evict(index) {
    const size = this.sizes.get(index);
    if (size == null) return;
    this.sizes.delete(index);
    this.bytes -= size;
    fs.rm(this.file(index), { force: true }, () => {});
  }

  close(cb = () => {}) {
    queueMicrotask(() => cb(null));
  }

  destroy(cb = () => {}) {
    this.sizes.clear();
    this.bytes = 0;
    fs.rm(this.dir, { recursive: true, force: true }, () => cb(null));
  }
}

module.exports = WindowStore;
