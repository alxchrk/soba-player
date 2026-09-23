'use strict';

// Логика плеера: контрол-бар, таймлайн, громкость, меню дорожек и субтитров,
// автоскрытие, горячие клавиши. Работает поверх Surface, ничего не знает про
// торрент и ffmpeg.

class Player {
  constructor(root) {
    this.root = root;
    this.video = root.querySelector('#video');
    this.surface = new window.Surface(this.video);
    this.surface.onSeek = (sec) => this.onSeeked(sec);
    this.controls = root.querySelector('#controls');
    this.seekbar = root.querySelector('#seekbar');
    this.buffered = root.querySelector('#buffered');
    this.played = root.querySelector('#played');
    this.volumebar = root.querySelector('#volumebar');
    this.timeEl = root.querySelector('#time');
    this.titleEl = root.querySelector('#title');
    this.titleText = root.querySelector('#title-text');
    this.playPause = root.querySelector('#play-pause');
    this.subtitlesEl = root.querySelector('#subtitles');
    this.hideTimer = null;
    this.cues = [];
    this.listPos = 0;
    this.episodesCount = 0;
    this.onSelect = null;
    // Восстановить громкость, мьют и скорость из прошлого сеанса.
    this.speed = parseFloat(localStorage.getItem('speed')) || 1;
    const vol = parseFloat(localStorage.getItem('volume'));
    this.volumeLevel = 100;
    this.gain = null;
    this.video.muted = localStorage.getItem('muted') === '1';
    this.subsScale = 1;
    this.setSubsScale(parseFloat(localStorage.getItem('subsScale')) || 1);
    this.wire();
    this.setVolumeLevel(Number.isFinite(vol) ? vol * 100 : 100);
    this.wireSubtitleDrag();
    this.buildSpeedMenu();
  }

  static fmt(sec) {
    sec = Math.floor(sec || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  async open(index, prepared, title, audioTrack) {
    this.titleText.textContent = title || '';
    this.stopMarquee();
    this.mediaName = title || '';
    const audio = audioTrack && prepared.probe.audioTracks && audioTrack < prepared.probe.audioTracks.length ? audioTrack : 0;
    this.populateAudioMenu(prepared.probe.audioTracks, audio);
    this.chapters = prepared.probe.chapters || [];
    this.populateSubsMenu(prepared.probe.subtitleTracks, index);
    this.setMediaSession(title);
    this.subsGen = (this.subsGen || 0) + 1; // остановить поток прежней дорожки
    this.cues = [];
    this.subTrack = null;
    this.subsPending = false;
    this.lastSubsHtml = '';
    this.subtitlesEl.textContent = '';
    this.index = index;
    this.fittedIndex = -1;
    await this.surface.load(index, prepared, audio);
    this.video.playbackRate = this.speed; // скорость сбрасывается при новом src
  }

  wire() {
    const v = this.video;

    v.addEventListener('play', () => this.setPlayIcon(false));
    v.addEventListener('pause', () => this.setPlayIcon(true));
    // Лоадер показывается, только если ожидание длится дольше 400 мс: перезапуск
    // потока при перемотке или короткая пауза буфера не должны им мелькать.
    v.addEventListener('waiting', () => this.showLoader());
    v.addEventListener('playing', () => this.hideLoader());
    // На паузе событие playing не придёт; данных хватает для старта: лоадер снимается.
    v.addEventListener('canplay', () => this.hideLoader());
    v.addEventListener('timeupdate', () => this.onTime());
    // Окно под пропорции кадра, один раз на файл (перезапуски потока не считаются).
    v.addEventListener('loadedmetadata', () => {
      if (this.fittedIndex === this.index || !v.videoWidth) return;
      this.fittedIndex = this.index;
      window.api.fitAspect(v.videoWidth, v.videoHeight);
    });
    v.addEventListener('ended', () => { if (this.onEnded) this.onEnded(); });

    this.playPause.addEventListener('click', () => this.toggle());
    this.root.querySelector('#fullscreen').addEventListener('click', () => window.api.toggleFullscreen());
    this.root.querySelector('#mute').addEventListener('click', () => this.toggleMute());

    // Кнопки серий.
    this.root.querySelector('#prev-episode').addEventListener('click', () => {
      if (this.onSelect && this.listPos > 0) this.onSelect(this.listPos - 1);
    });
    this.root.querySelector('#next-episode').addEventListener('click', () => {
      if (this.onSelect && this.listPos < this.episodesCount - 1) this.onSelect(this.listPos + 1);
    });

    // Пока ползунок тянут и пока новый поток после перемотки не пошёл, время
    // показывает выбранную позицию, а не отсчёт старого потока.
    this.seekbar.addEventListener('input', () => {
      const d = this.surface.duration || 0;
      this.showTime((this.seekbar.value / 1000) * d, d);
      this.updateSeekFill();
    });
    this.seekbar.addEventListener('change', () => {
      const d = this.surface.duration || 0;
      this.seekbar.blur();
      this.seekTo((this.seekbar.value / 1000) * d);
    });
    // Пока поток после перемотки готовится, под лоадером написано, к какому
    // времени идёт переход (в том числе при продолжении с запомненной позиции).
    const loaderText = this.root.querySelector('#loader-text');
    this.surface.onRestart = (sec) => {
      this.seekPending = true;
      this.showLoader();
      loaderText.textContent = `${t('seekingTo')} ${Player.fmt(sec)}`;
      loaderText.classList.remove('hidden');
    };
    v.addEventListener('playing', () => loaderText.classList.add('hidden'));
    // Наведение на таймлайн показывает время под курсором вместо текущего.
    const progress = this.root.querySelector('#progress');
    progress.addEventListener('mousemove', (e) => {
      const r = progress.getBoundingClientRect();
      const d = this.surface.duration || 0;
      this.hoverTime = d ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d : null;
      if (this.hoverTime != null) this.showTime(this.hoverTime, d);
    });
    progress.addEventListener('mouseleave', () => {
      this.hoverTime = null;
      if (!this.seekPending) this.showTime(this.surface.currentTime, this.surface.duration || 0);
    });
    v.addEventListener('playing', () => { this.seekPending = false; });

    this.volumebar.addEventListener('input', () => {
      v.muted = false;
      this.setVolumeLevel(parseInt(this.volumebar.value, 10));
    });
    this.updateVolumeFill();

    // Меню по кнопкам.
    this.root.querySelectorAll('.menu-button').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = this.root.querySelector('#' + btn.dataset.menu);
        const wasHidden = menu.classList.contains('hidden');
        this.root.querySelectorAll('.menu').forEach((m) => m.classList.add('hidden'));
        if (wasHidden) menu.classList.remove('hidden');
      });
    });

    // Автоскрытие и наведение.
    this.root.addEventListener('mousemove', () => this.wake());
    this.controls.addEventListener('mouseenter', () => this.keepAwake = true);
    this.controls.addEventListener('mouseleave', () => (this.keepAwake = false));

    // Клик по кадру: если открыто меню, клик его закрывает; иначе ставит паузу.
    // Двойной клик открывает полный экран, поэтому одиночный идёт с задержкой.
    this.clickTimer = null;
    this.root.addEventListener('click', (e) => {
      if (e.target.closest('.menu') || e.target.closest('.menu-button')) return;
      const anyOpen = this.root.querySelector('.menu:not(.hidden)');
      this.root.querySelectorAll('.menu').forEach((m) => m.classList.add('hidden'));
      if (anyOpen || e.target.closest('.controls')) return;
      clearTimeout(this.clickTimer);
      this.clickTimer = setTimeout(() => this.toggle(), 220);
    });
    this.root.addEventListener('dblclick', (e) => {
      if (e.target.closest('.controls')) return;
      clearTimeout(this.clickTimer);
      window.api.toggleFullscreen();
    });

    document.addEventListener('keydown', (e) => this.onKey(e));

    // Щипок на трекпаде приходит как wheel с ctrlKey: разведение пальцев
    // (deltaY < 0) включает полный экран, сведение выключает.
    let pinch = 0;
    let pinchTimer = null;
    this.root.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      pinch += e.deltaY;
      clearTimeout(pinchTimer);
      pinchTimer = setTimeout(() => { pinch = 0; }, 300);
      const full = document.body.classList.contains('fullscreen');
      if (pinch < -40 && !full) { pinch = 0; window.api.toggleFullscreen(); }
      else if (pinch > 40 && full) { pinch = 0; window.api.exitFullscreen(); }
    }, { passive: false });

    // Бегущая строка длинного имени при наведении.
    this.titleEl.addEventListener('mouseenter', () => this.startMarquee());
    this.titleEl.addEventListener('mouseleave', () => this.stopMarquee());
  }

  startMarquee() {
    const overflow = this.titleText.scrollWidth - this.titleEl.clientWidth;
    if (overflow <= 4) return;
    const dur = overflow / 40; // скорость примерно 40 px/сек
    this.titleText.style.transition = `transform ${dur}s linear`;
    this.titleText.style.transform = `translateX(${-overflow}px)`;
    clearTimeout(this.marqueeTimer);
    // Доехав до конца, стоим 5 секунд и прыгаем в начало.
    this.marqueeTimer = setTimeout(() => {
      this.titleText.style.transition = 'none';
      this.titleText.style.transform = 'translateX(0)';
    }, dur * 1000 + 5000);
  }

  stopMarquee() {
    clearTimeout(this.marqueeTimer);
    this.titleText.style.transition = 'transform 0.2s';
    this.titleText.style.transform = 'translateX(0)';
  }

  showLoader() {
    if (this.loaderTimer) return;
    this.loaderTimer = setTimeout(() => {
      this.loaderTimer = null;
      this.root.querySelector('#loader').classList.remove('hidden');
    }, 400);
  }

  hideLoader() {
    clearTimeout(this.loaderTimer);
    this.loaderTimer = null;
    this.root.querySelector('#loader').classList.add('hidden');
  }

  setPlayIcon(paused) {
    this.playPause.querySelector('.ico').className = 'ico ' + (paused ? 'ico-play' : 'ico-pause');
  }

  toggle() {
    if (this.surface.paused) this.surface.play();
    else this.surface.pause();
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    this.updateVolumeFill();
    this.saveVolume();
  }

  saveVolume() {
    try {
      localStorage.setItem('volume', String(this.volumeLevel / 100));
      localStorage.setItem('muted', this.video.muted ? '1' : '0');
    } catch (_) {}
  }

  buildSpeedMenu() {
    const ul = this.root.querySelector('#speed-menu ul');
    ul.innerHTML = '';
    [0.75, 1, 1.25, 1.5, 2].forEach((r) => {
      const li = document.createElement('li');
      li.textContent = r + 'x';
      if (r === this.speed) li.classList.add('active');
      li.addEventListener('click', () => this.setSpeed(r));
      ul.appendChild(li);
    });
    this.root.querySelector('#speed-label').textContent = this.speed + 'x';
  }

  setSpeed(r) {
    this.speed = r;
    this.video.playbackRate = r;
    try { localStorage.setItem('speed', String(r)); } catch (_) {}
    this.root.querySelector('#speed-label').textContent = r + 'x';
    this.root.querySelectorAll('#speed-menu li').forEach((li) => li.classList.toggle('active', li.textContent === r + 'x'));
  }

  onTime() {
    if (this.seekPending) return;
    const t = this.surface.currentTime;
    const d = this.surface.duration || 0;
    if (!this.seekbarActive()) this.seekbar.value = d ? (t / d) * 1000 : 0;
    if (this.hoverTime == null) this.showTime(t, d);
    this.updateSeekFill();
    this.renderSubtitle(t);
  }

  showTime(t, d) {
    this.timeEl.textContent = `${Player.fmt(t)} / ${Player.fmt(d)}`;
  }

  // Перемотка с клавиш и ползунка: ползунок и время сразу встают на цель.
  seekTo(sec) {
    const d = this.surface.duration || 0;
    sec = Math.max(0, Math.min(sec, d || sec));
    if (d) this.seekbar.value = (sec / d) * 1000;
    this.showTime(sec, d);
    this.updateSeekFill();
    this.renderSubtitle(sec);
    this.surface.seek(sec);
  }

  // Серая полоса: какая доля файла уже скачана (для торрента с начала файла).
  setDownloadProgress(fraction) {
    this.buffered.style.width = Math.min(100, Math.max(0, fraction * 100)) + '%';
  }

  seekbarActive() {
    return document.activeElement === this.seekbar;
  }

  updateSeekFill() {
    this.played.style.width = (this.seekbar.value / 1000) * 100 + '%';
  }

  updateVolumeFill() {
    const level = this.video.muted ? 0 : this.volumeLevel;
    const pct = level / 2; // шкала 0..200
    this.root.querySelector('#mute .ico').classList.toggle('muted', this.video.muted);
    this.volumebar.value = level;
    // Заливка до текущего уровня, выше 100% оранжевая; риска на 100%.
    const color = level > 100 ? '#ff9f0a' : '#ddd';
    this.volumebar.style.background =
      `linear-gradient(to right, ${color} ${pct}%, rgba(255,255,255,0.2) ${pct}%)`;
  }

  wake() {
    this.controls.classList.remove('hidden-controls');
    this.root.classList.remove('cursor-none');
    if (this.onControlsVisible) this.onControlsVisible(true);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.keepAwake || this.surface.paused) return;
      this.controls.classList.add('hidden-controls');
      this.root.classList.add('cursor-none');
      if (this.onControlsVisible) this.onControlsVisible(false);
      this.root.querySelectorAll('.menu').forEach((m) => m.classList.add('hidden'));
    }, 2500);
  }

  onKey(e) {
    // В полях ввода и при открытых настройках горячие клавиши плеера не работают.
    if ((e.target.closest && e.target.closest('input, select, textarea')) || document.body.classList.contains('modal-open')) return;
    if (this.root.classList.contains('hidden')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
    else if (e.code === 'KeyK') this.toggle();
    else if (e.code === 'ArrowRight') this.seekTo(this.surface.currentTime + 10);
    else if (e.code === 'ArrowLeft') this.seekTo(this.surface.currentTime - 10);
    else if (e.code === 'ArrowUp') { this.video.muted = false; this.setVolumeLevel(this.volumeLevel + 5); this.osd(`${t('volume')} ${this.volumeLevel}%`); }
    else if (e.code === 'ArrowDown') { this.setVolumeLevel(this.volumeLevel - 5); this.osd(`${t('volume')} ${this.volumeLevel}%`); }
    else if (e.key === '+' || e.key === '=') { this.setSubsScale(this.subsScale + 0.1); this.osd(`${t('subtitlesSize')} ${Math.round(this.subsScale * 100)}%`); }
    else if (e.key === '-' || e.key === '_') { this.setSubsScale(this.subsScale - 0.1); this.osd(`${t('subtitlesSize')} ${Math.round(this.subsScale * 100)}%`); }
    // Буквы по физической клавише: на русской раскладке e.key даёт «д» вместо «l».
    else if (e.code === 'KeyL') this.seekTo(this.surface.currentTime + 30);
    else if (e.code === 'KeyJ') this.seekTo(this.surface.currentTime - 30);
    else if (e.code === 'KeyM') this.toggleMute();
    else if (e.code === 'KeyF') window.api.toggleFullscreen();
    else if (e.key === 'Escape') window.api.exitFullscreen();
  }

  // Список серий для многофайловых раздач. Кнопки появляются от двух файлов.
  setPlaylist(episodes, currentListPos, onSelect) {
    this.listPos = currentListPos;
    this.episodesCount = episodes ? episodes.length : 0;
    this.onSelect = onSelect;
    const multi = episodes && episodes.length >= 2;
    const prev = this.root.querySelector('#prev-episode');
    const next = this.root.querySelector('#next-episode');
    prev.classList.toggle('hidden', !multi);
    next.classList.toggle('hidden', !multi);
    if (multi) {
      prev.disabled = currentListPos <= 0;
      next.disabled = currentListPos >= episodes.length - 1;
      prev.style.opacity = prev.disabled ? '0.35' : '';
      next.style.opacity = next.disabled ? '0.35' : '';
    }
    const btn = this.root.querySelector('#playlist-button');
    const ul = this.root.querySelector('#playlist-menu ul');
    ul.innerHTML = '';
    const chapters = this.chapters || [];
    if (!multi && !chapters.length) { btn.classList.add('hidden'); return; }
    btn.classList.remove('hidden');
    if (multi) {
      episodes.forEach((ep, i) => {
        const li = document.createElement('li');
        li.textContent = ep.name;
        if (i === currentListPos) li.classList.add('active');
        li.addEventListener('click', () => onSelect(i));
        ul.appendChild(li);
      });
    }
    // Главы файла (mkv) в том же списке, после серий.
    chapters.forEach((ch, i) => {
      const li = document.createElement('li');
      li.classList.add('chapter');
      if (i === 0 && multi) li.classList.add('chapter-first');
      li.textContent = `${Player.fmt(ch.start)}  ${ch.title || `${t('chapter')} ${i + 1}`}`;
      li.addEventListener('click', () => this.seekTo(ch.start));
      ul.appendChild(li);
    });
  }

  populateAudioMenu(tracks, active) {
    const btn = this.root.querySelector('#audio-button');
    const ul = this.root.querySelector('#audio-menu ul');
    ul.innerHTML = '';
    if (!tracks || tracks.length < 2) { btn.classList.add('hidden'); return; }
    btn.classList.remove('hidden');
    tracks.forEach((tr, i) => {
      const li = document.createElement('li');
      li.textContent = this.trackLabel(tr, i);
      if (i === (active || 0)) li.classList.add('active');
      li.addEventListener('click', () => {
        ul.querySelectorAll('li').forEach((x) => x.classList.remove('active'));
        li.classList.add('active');
        this.surface.setAudioTrack(i);
        if (this.onAudioChange) this.onAudioChange(i);
      });
      ul.appendChild(li);
    });
  }

  // Название и кнопки в системном виджете «Сейчас играет» и на медиаклавишах.
  setMediaSession(title) {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({ title: title || 'Soba Player', artist: 'Soba Player' });
    ms.setActionHandler('play', () => this.surface.play());
    ms.setActionHandler('pause', () => this.surface.pause());
    ms.setActionHandler('seekbackward', () => this.seekTo(this.surface.currentTime - 10));
    ms.setActionHandler('seekforward', () => this.seekTo(this.surface.currentTime + 10));
    ms.setActionHandler('previoustrack', () => { if (this.onSelect && this.listPos > 0) this.onSelect(this.listPos - 1); });
    ms.setActionHandler('nexttrack', () => { if (this.onSelect && this.listPos < this.episodesCount - 1) this.onSelect(this.listPos + 1); });
  }

  // Короткое сообщение по центру сверху (громкость, размер субтитров).
  osd(text) {
    const el = this.root.querySelector('#osd');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.osdTimer);
    this.osdTimer = setTimeout(() => el.classList.remove('show'), 1200);
  }

  // Громкость 0..200%: до 100% штатная громкость элемента, выше усиление через
  // Web Audio (граф создаётся при первом превышении).
  setVolumeLevel(level) {
    level = Math.max(0, Math.min(200, Math.round(level)));
    this.volumeLevel = level;
    this.video.volume = Math.min(1, level / 100);
    if (level > 100 && !this.gain) {
      try {
        const ctx = new AudioContext();
        this.gain = ctx.createGain();
        ctx.createMediaElementSource(this.video).connect(this.gain).connect(ctx.destination);
      } catch (_) {}
    }
    if (this.gain) this.gain.gain.value = Math.max(1, level / 100);
    this.updateVolumeFill();
    this.saveVolume();
  }

  // Масштаб субтитров 60..200%, клавиши + и -.
  setSubsScale(scale) {
    scale = Math.max(0.6, Math.min(2, Math.round(scale * 10) / 10));
    this.subsScale = scale;
    document.documentElement.style.setProperty('--subs-scale', String(scale));
    try { localStorage.setItem('subsScale', String(scale)); } catch (_) {}
  }

  trackLabel(tr, i) {
    const parts = [];
    if (tr.title) parts.push(tr.title);
    if (tr.language) parts.push(tr.language);
    parts.push(tr.codec);
    return `${t('track')} ${i + 1}: ${parts.join(', ')}`;
  }

  populateSubsMenu(tracks, index) {
    const btn = this.root.querySelector('#subs-button');
    const ul = this.root.querySelector('#subs-menu ul');
    ul.innerHTML = '';
    this.subIndex = index;
    // Кнопка субтитров всегда доступна: даже без вшитых можно загрузить свой файл.
    btn.classList.remove('hidden');
    const off = document.createElement('li');
    off.textContent = t('subsOff');
    off.classList.add('active');
    off.addEventListener('click', () => { this.selectSub(off); this.loadSubtitle(null, index); this.notifySubs(null); });
    ul.appendChild(off);
    const textTracks = (tracks || []).filter((t) => t.text);
    textTracks.forEach((tr) => {
      const li = document.createElement('li');
      li.textContent = this.trackLabel(tr, tr.index);
      li.dataset.track = tr.index;
      li.addEventListener('click', () => {
        this.selectSub(li);
        this.loadSubtitle(tr.index, index);
        this.notifySubs({ kind: 'track', track: tr.index });
      });
      ul.appendChild(li);
    });
    // Загрузка своего файла и онлайн-поиск.
    const load = document.createElement('li');
    load.textContent = t('loadSubsFile');
    load.classList.add('sub-action');
    load.addEventListener('click', () => { this.selectSub(load); this.loadExternalSubtitleFile(); });
    ul.appendChild(load);
    const online = document.createElement('li');
    online.textContent = t('searchOnline');
    online.classList.add('sub-action');
    online.addEventListener('click', () => this.searchOnlineSubtitles());
    ul.appendChild(online);
  }

  async searchOnlineSubtitles() {
    const key = localStorage.getItem('osApiKey');
    if (!key) {
      alert(t('osNeedKey'));
      return;
    }
    let results;
    try {
      results = await window.api.searchSubtitles(key, this.mediaName);
    } catch (_) {
      alert(t('osSearchFailed'));
      return;
    }
    if (!results || !results.length) { alert(t('osNotFound')); return; }
    this.showOnlineSubtitles(results, async (r) => {
      try {
        const { vtt, path } = await window.api.downloadSubtitle(key, r.file_id);
        this.setCuesFromVtt(vtt);
        this.addFileItem(r.label);
        this.notifySubs({ kind: 'file', path, name: r.label });
      } catch (_) {
        alert(t('osDownloadFailed'));
      }
    });
  }

  async loadExternalSubtitleFile() {
    const filePath = await window.api.chooseSubtitle();
    if (filePath) await this.loadExternalSubtitlePath(filePath);
  }

  // Файл субтитров по пути: из диалога или брошенный в окно.
  async loadExternalSubtitlePath(filePath) {
    const name = filePath.split('/').pop();
    try {
      const vtt = await window.api.externalSubs(filePath);
      this.setCuesFromVtt(vtt);
      this.addFileItem(name);
      this.notifySubs({ kind: 'file', path: filePath, name });
    } catch (_) {
      alert(t('subsFileFailed'));
    }
  }

  // Выбор субтитров сообщается наружу для памяти по раздаче:
  // null, { kind: 'track', track } или { kind: 'file', path, name }.
  notifySubs(choice) {
    if (this.onSubsChange) this.onSubsChange(choice);
  }

  // Пункт меню для внешнего файла или скачанных субтитров, отмеченный активным.
  addFileItem(name) {
    const ul = this.root.querySelector('#subs-menu ul');
    ul.querySelectorAll('.sub-file').forEach((x) => x.remove());
    const li = document.createElement('li');
    li.textContent = name;
    li.classList.add('sub-file');
    li.addEventListener('click', () => this.selectSub(li));
    ul.insertBefore(li, ul.querySelector('.sub-action'));
    this.selectSub(li);
  }

  // Вернуть субтитры, выбранные для этой раздачи в прошлый раз.
  async restoreSubtitle(saved) {
    if (!saved) return;
    if (saved.kind === 'track') {
      const li = this.root.querySelector(`#subs-menu li[data-track="${saved.track}"]`);
      if (!li) return;
      this.selectSub(li);
      this.loadSubtitle(saved.track, this.subIndex);
    } else if (saved.kind === 'file' && saved.path) {
      try {
        const vtt = await window.api.externalSubs(saved.path);
        this.setCuesFromVtt(vtt);
        this.addFileItem(saved.name || saved.path.split('/').pop());
      } catch (_) {}
    }
  }

  // Показать список найденных онлайн-субтитров и загрузить выбранный.
  showOnlineSubtitles(results, onPick) {
    const ul = this.root.querySelector('#subs-menu ul');
    // Убираем прежние онлайн-пункты.
    ul.querySelectorAll('.sub-online').forEach((x) => x.remove());
    results.forEach((r) => {
      const li = document.createElement('li');
      li.textContent = r.label;
      li.classList.add('sub-online');
      li.addEventListener('click', () => { this.selectSub(li); onPick(r); });
      ul.appendChild(li);
    });
  }

  setCuesFromVtt(vtt) {
    this.cues = Player.parseVtt(vtt);
    this.subtitlesEl.textContent = '';
  }

  selectSub(li) {
    li.parentElement.querySelectorAll('li').forEach((x) => x.classList.remove('active'));
    li.classList.add('active');
  }

  // Встроенные субтитры читаются потоком с позиции просмотра: ffmpeg отдаёт
  // WebVTT по мере скачивания, реплики добавляются по мере прихода. Перемотка
  // назад за начало загруженного или далеко вперёд перезапускает чтение.
  async loadSubtitle(track, index, fromSec) {
    const gen = (this.subsGen = (this.subsGen || 0) + 1);
    this.cues = [];
    this.subtitlesEl.textContent = '';
    this.subTrack = track;
    this.subsPending = false;
    if (track === null || track === undefined) return;
    const from = Math.max(0, (fromSec != null ? fromSec : this.surface.currentTime) - 2);
    this.subsFrom = from;
    this.subsPending = true;
    const url = await window.api.subsUrl(index, track, from);
    try {
      const reader = (await fetch(url)).body.getReader();
      const decoder = new TextDecoder();
      let rest = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (gen !== this.subsGen) { reader.cancel(); return; }
        rest += decoder.decode(value || new Uint8Array(), { stream: !done });
        const cut = done ? rest.length : rest.lastIndexOf('\n\n');
        if (cut > 0) {
          this.cues.push(...Player.parseVtt(rest.slice(0, cut)));
          rest = rest.slice(cut);
        }
        if (done) break;
      }
    } catch (_) {}
    if (gen === this.subsGen) this.subsPending = false;
  }

  // После перемотки: встроенная дорожка перечитывается, если новая позиция вне
  // загруженного диапазона.
  onSeeked(sec) {
    if (this.subTrack == null) return;
    const last = this.cues.length ? this.cues[this.cues.length - 1].end / 1000 : this.subsFrom;
    if (sec < this.subsFrom - 1 || sec > last + 60) this.loadSubtitle(this.subTrack, this.subIndex, sec);
  }

  static parseVtt(text) {
    const cues = [];
    const blocks = text.replace(/\r/g, '').split('\n\n');
    const toMs = (t) => {
      const m = /(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/.exec(t);
      if (!m) return 0;
      return (parseInt(m[1] || 0) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])) * 1000 + parseInt(m[4]);
    };
    for (const b of blocks) {
      const line = b.split('\n').find((l) => l.includes('-->'));
      if (!line) continue;
      const [a, c] = line.split('-->');
      const body = b.split('\n').slice(b.split('\n').indexOf(line) + 1).join('<br>');
      cues.push({ start: toMs(a.trim()), end: toMs(c.trim()), text: body });
    }
    return cues;
  }

  renderSubtitle(sec) {
    const ms = sec * 1000;
    const cue = this.cues.find((c) => ms >= c.start && ms < c.end);
    let html = cue ? `<span class="subs-text">${cue.text}</span>` : '';
    // Пока встроенная дорожка ещё не дочитана до текущей позиции, показываем статус.
    if (!cue && this.subsPending) {
      const last = this.cues.length ? this.cues[this.cues.length - 1].end : 0;
      if (last < ms) html = `<span class="subs-text subs-status">${t('loadingSubs')}</span>`;
    }
    if (html !== this.lastSubsHtml) {
      this.lastSubsHtml = html;
      this.subtitlesEl.innerHTML = html;
    }
  }

  // Субтитры можно перетащить мышью; положение запоминается.
  wireSubtitleDrag() {
    const el = this.subtitlesEl;
    const apply = (pos) => {
      el.style.bottom = pos.bottom + 'px';
      el.style.transform = `translateX(${pos.dx}px)`;
    };
    const DEFAULT_POS = { bottom: 120, dx: 0 };
    let pos = { ...DEFAULT_POS };
    try { pos = { ...pos, ...JSON.parse(localStorage.getItem('subsPos') || '{}') }; } catch (_) {}
    apply(pos);
    el.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.subs-text')) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY, start = { ...pos };
      const move = (ev) => {
        // Можно опустить хоть под нижнюю панель; небольшой отступ от краёв окна.
        const maxBottom = window.innerHeight - el.offsetHeight - 40;
        pos = {
          bottom: Math.max(8, Math.min(maxBottom, start.bottom - (ev.clientY - startY))),
          dx: start.dx + (ev.clientX - startX),
        };
        apply(pos);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        try { localStorage.setItem('subsPos', JSON.stringify(pos)); } catch (_) {}
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    // Клик по тексту не ставит на паузу и не переключает полный экран; двойной
    // клик возвращает субтитры на место по умолчанию.
    el.addEventListener('click', (e) => { if (e.target.closest('.subs-text')) e.stopPropagation(); });
    el.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.subs-text')) return;
      e.stopPropagation();
      pos = { ...DEFAULT_POS };
      apply(pos);
      try { localStorage.removeItem('subsPos'); } catch (_) {}
      this.osd(t('subsReset'));
    });
  }
}

window.Player = Player;
