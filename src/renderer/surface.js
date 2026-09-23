'use strict';

// Поверхность воспроизведения: прячет разницу между нативным <video> и
// потоком с транскодом. Интерфейс один, чтобы позже рядом могла встать
// другая реализация (например mpv), не задевая плеер.
//
// Транскод отдаётся как fragmented MP4 живым потоком без длительности и без
// перемотки внутри файла. Поэтому длительность берём из ffprobe, а перемотка
// перезапускает ffmpeg с нужной позиции и смещает точку отсчёта времени.

class Surface {
  constructor(video) {
    this.video = video;
    this.index = 0;
    this.mode = 'native';
    this.audioTrack = 0;
    this.knownDuration = 0; // из ffprobe, для транскода
    this.baseline = 0;      // смещение времени при перемотке транскода
  }

  // audioTrack: дорожка, запомненная для раздачи; транскод сразу стартует с ней,
  // без второго перезапуска.
  async load(index, prepared, audioTrack) {
    this.restartGen = (this.restartGen || 0) + 1; // отменить незавершённую перемотку прежнего файла
    this.index = index;
    this.mode = prepared.mode;
    this.probe = prepared.probe;
    this.knownDuration = prepared.probe.durationSec || 0;
    this.audioTrack = audioTrack || 0;
    this.baseline = 0;
    if (this.mode === 'transcode' && this.audioTrack) {
      this.video.src = (await window.api.playUrl(index, 0, this.audioTrack)).url;
    } else {
      this.video.src = prepared.url;
    }
    await this.video.play().catch(() => {});
    if (this.mode === 'native' && this.audioTrack) this.setAudioTrack(this.audioTrack);
  }

  get currentTime() {
    return this.mode === 'transcode' ? this.baseline + this.video.currentTime : this.video.currentTime;
  }

  get duration() {
    if (this.mode === 'transcode') return this.knownDuration;
    return isFinite(this.video.duration) ? this.video.duration : this.knownDuration;
  }

  get paused() { return this.video.paused; }
  play() { return this.video.play().catch(() => {}); }
  pause() { this.video.pause(); }

  async seek(sec) {
    sec = Math.max(0, Math.min(sec, this.duration || sec));
    if (this.onSeek) this.onSeek(sec);
    if (this.mode === 'native') {
      this.video.currentTime = sec;
      return;
    }
    await this.restart(sec, this.audioTrack);
  }

  // Перезапуск потока транскода с позиции. Старый поток останавливается сразу,
  // чтобы до старта нового не шло чужое время. Точка отсчёта это реальное
  // начало потока (ключевой кадр не позже sec), иначе время и субтитры уезжают
  // вперёд на расстояние до ключевого кадра. Пока новый поток готовится, время
  // считается от запрошенной позиции. Повторная перемотка отменяет прежнюю.
  async restart(sec, track) {
    const gen = (this.restartGen = (this.restartGen || 0) + 1);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.baseline = sec;
    if (this.onRestart) this.onRestart(sec);
    const r = await window.api.playUrl(this.index, sec, track);
    if (gen !== this.restartGen) return;
    this.baseline = r.start;
    this.video.src = r.url;
    await this.video.play().catch(() => {});
  }

  async setAudioTrack(track) {
    this.audioTrack = track;
    if (this.mode === 'native') {
      const tracks = this.video.audioTracks;
      if (tracks) {
        for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === track;
      }
      return;
    }
    // Транскод: перезапускаем с той же позиции с новой дорожкой.
    await this.restart(this.currentTime, track);
  }
}

window.Surface = Surface;
