// Пути к ffmpeg и ffprobe. Порядок: переменная окружения, затем своя сборка
// под LGPL (в .app лежит в Contents/Resources/ffmpeg, из исходников берётся из
// build/ffmpeg/bin после build/ffmpeg/build.sh), затем системный из Homebrew.
'use strict';

const fs = require('fs');
const path = require('path');

const BUNDLED_DIR = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'ffmpeg'))
  ? path.join(process.resourcesPath, 'ffmpeg')
  : path.join(__dirname, '..', '..', 'build', 'ffmpeg', 'bin');

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function resolve(name, envVar) {
  return process.env[envVar] ||
    firstExisting([path.join(BUNDLED_DIR, name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) ||
    name;
}

const ffmpegPath = resolve('ffmpeg', 'FFMPEG_PATH');
const ffprobePath = resolve('ffprobe', 'FFPROBE_PATH');

module.exports = { ffmpegPath, ffprobePath };
