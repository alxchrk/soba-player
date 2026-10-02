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
    // Обработка звука ({ level, dialog }) делается в ffmpeg, поэтому с ней
    // файл идёт через транскод даже там, где мог бы играть напрямую.
    this.audioOpts = { level: false, dialog: false };
    // Стоп-кадр поверх видео на время перезапуска потока: без него экран
    // чернеет при каждой перемотке и мелькает при серии нажатий.
    this.freeze = document.createElement('canvas');
    this.freeze.className = 'freeze';
    video.insertAdjacentElement('afterend', this.freeze);
  }

  // Снять текущий кадр в стоп-кадр. Уже показанный стоп-кадр не переснимается:
  // при повторной перемотке видео под ним скрыто или пустое.
  showFreeze() {
    const v = this.video;
    if (this.freeze.classList.contains('show') || !v.videoWidth || v.readyState < 2) return;
    this.freeze.width = v.videoWidth;
    this.freeze.height = v.videoHeight;
    this.freeze.getContext('2d').drawImage(v, 0, 0);
    this.freeze.classList.add('show');
  }

  hideFreeze() {
    this.freeze.classList.remove('show');
  }

  // audioTrack: дорожка, запомненная для раздачи; транскод сразу стартует с ней,
  // без второго перезапуска.
  async load(index, prepared, audioTrack) {
    this.restartGen = (this.restartGen || 0) + 1; // отменить незавершённую перемотку прежнего файла
    this.cancelSkip();
    this.hideFreeze();
    this.index = index;
    this.mode = prepared.mode;
    this.probe = prepared.probe;
    this.knownDuration = prepared.probe.durationSec || 0;
    this.audioTrack = audioTrack || 0;
    this.baseline = 0;
    if (this.mode === 'native' && this.processing) this.mode = 'transcode';
    if (this.mode === 'transcode' && (this.audioTrack || this.processing)) {
      this.video.src = (await window.api.playUrl(index, 0, this.audioTrack, this.audioOpts)).url;
    } else {
      this.video.src = prepared.url;
    }
    // На телевизоре новая серия идёт туда, локально файл только готовится к
    // возврату на Mac.
    if (this.tv) {
      this.tv.pos = 0;
      window.api.airplayLoad(index, 0, this.audioTrack);
      return;
    }
    await this.video.play().catch(() => {});
    if (this.mode === 'native' && this.audioTrack) this.setAudioTrack(this.audioTrack);
  }

  // Остановить и выгрузить текущее видео (открывается другой источник).
  unload() {
    this.restartGen = (this.restartGen || 0) + 1;
    this.cancelSkip();
    this.hideFreeze();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.baseline = 0;
  }

  // Показ на телевизоре (AirPlay): позиция и управление идут через помощник,
  // локальное видео стоит на паузе и ждёт возврата.
  enterTv(pos) {
    this.cancelSkip();
    this.hideFreeze();
    this.video.pause();
    this.tv = { pos, playing: true };
  }

  leaveTv() {
    const pos = this.tv ? this.tv.pos : this.currentTime;
    this.tv = null;
    return pos;
  }

  get currentTime() {
    if (this.tv) return this.tv.pos;
    return this.mode === 'transcode' ? this.baseline + this.video.currentTime : this.video.currentTime;
  }

  get duration() {
    if (this.mode === 'transcode') return this.knownDuration;
    return isFinite(this.video.duration) ? this.video.duration : this.knownDuration;
  }

  get paused() { return this.tv ? !this.tv.playing : this.video.paused; }

  play() {
    if (this.tv) return window.api.airplayCommand('play');
    return this.video.play().catch(() => {});
  }

  pause() {
    if (this.tv) return window.api.airplayCommand('pause');
    this.video.pause();
  }

  async seek(sec) {
    sec = Math.max(0, Math.min(sec, this.duration || sec));
    if (this.onSeek) this.onSeek(sec);
    if (this.tv) {
      this.tv.pos = sec;
      return window.api.airplaySeek(sec);
    }
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
    this.showFreeze();
    this.cancelSkip();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.baseline = sec;
    if (this.onRestart) this.onRestart(sec);
    const r = await window.api.playUrl(this.index, sec, track, this.audioOpts);
    if (gen !== this.restartGen) return;
    this.baseline = r.start;
    this.video.src = r.url;
    // Стоп-кадр уходит, когда новый поток показал нужный кадр: сразу при
    // старте или после скрытой докрутки (finishSkip).
    this.video.addEventListener('playing', () => { if (!this.skip && gen === this.restartGen) this.hideFreeze(); }, { once: true });
    this.skipTo(sec - r.start);
    await this.video.play().catch(() => {});
  }

  // Поток с копированием видео начинается с ключевого кадра раньше цели, а
  // перемотка внутри живого потока недоступна. Недостающие секунды
  // проигрываются скрыто и без звука на повышенной скорости, картинка и звук
  // появляются ровно с запрошенной позиции. Скорость снижается у цели, чтобы
  // не проскочить её между проверками.
  skipTo(offset) {
    if (offset < 0.1) return;
    const v = this.video;
    this.skip = { rate: v.playbackRate, muted: v.muted, timer: null };
    v.style.opacity = '0';
    v.muted = true;
    v.playbackRate = 16;
    this.skip.timer = setInterval(() => {
      const left = offset - v.currentTime;
      if (left <= 0.02) return this.finishSkip();
      v.playbackRate = left > 3 ? 16 : left > 0.4 ? 4 : 1;
    }, 15);
  }

  get skipping() { return !!this.skip; }

  finishSkip() {
    this.cancelSkip();
    this.hideFreeze();
    if (this.onSkipDone) this.onSkipDone();
  }

  cancelSkip() {
    if (!this.skip) return;
    clearInterval(this.skip.timer);
    this.video.playbackRate = this.skip.rate;
    this.video.muted = this.skip.muted;
    this.video.style.opacity = '';
    this.skip = null;
  }

  get processing() {
    return !!(this.audioOpts.level || this.audioOpts.dialog);
  }

  // Новые настройки обработки звука: поток перезапускается с той же секунды
  // (на телевизоре это делает помощник AirPlay).
  setAudioOpts(opts) {
    this.audioOpts = { level: !!opts.level, dialog: !!opts.dialog };
    if (this.tv || !this.video.getAttribute('src')) return;
    const pos = this.currentTime;
    if (this.mode === 'native') {
      if (!this.processing) return;
      this.mode = 'transcode';
    }
    this.restart(pos, this.audioTrack);
  }

  async setAudioTrack(track) {
    this.audioTrack = track;
    if (this.tv) return window.api.airplayAudio(track, this.tv.pos);
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
