'use strict';

// Язык интерфейса: английский по умолчанию, выбор запоминается. Статические
// строки помечены в html атрибутами data-i18n, data-i18n-title и
// data-i18n-placeholder; строки из кода берутся через t(key).
const I18N = {
  en: {
    settings: 'Settings',
    openFile: 'Open a torrent or video file',
    continueWatching: 'Continue watching',
    dropHint: 'Or drag a .torrent, a magnet link, or a video file into the window.',
    offerDefault: 'Open magnet links and torrent files here by default?',
    offerYes: 'Set as default',
    offerNo: 'Not now',
    setDefault: 'Open magnet links and torrent files in this player',
    setPrefetch: 'Preload the start of the next episode near the end of the current one',
    setAllDesktops: 'Show the window on all desktops',
    setRememberWindow: 'Remember window size and position',
    setAskPath: 'Ask where to save each time',
    language: 'Language',
    whereToDownload: 'Where to download',
    tempFolder: 'Temporary folder',
    choose: 'Choose…',
    cacheNote: 'Downloaded data is a cache and is removed when you quit the app.',
    osKey: 'OpenSubtitles API key',
    osKeyHint: 'for online subtitle search, free.',
    osHowTo: 'How to get a key',
    osStep1: 'Create a free account at opensubtitles.com.',
    osStep2: 'Open Profile → API consumers and add a new consumer (any name).',
    osStep3: 'Copy the API key it shows and paste it below.',
    osOpenSite: 'Open opensubtitles.com',
    optional: 'optional',
    byAuthor: 'by alxchrk',
    done: 'Done',
    keepWaiting: 'Keep waiting',
    openAnother: 'Open another torrent',
    downloadStatus: 'Download status',
    saveFile: 'Save the downloaded file…',
    prevEpisode: 'Previous episode',
    nextEpisode: 'Next episode',
    openMore: 'Open another torrent or file',
    keepOnTop: 'Keep on top',
    dropToOpen: 'Drop to open',
    errOpen: 'Could not open this torrent or file. It may be invalid or unreachable.',
    errNoVideo: 'No playable video was found here.',
    errPlayback: 'Could not start playback. The media may be unreadable.',
    errNoSeeders: 'Still no seeders. Keep waiting, or open another torrent.',
    peers: 'peers',
    fullyDownloaded: 'File fully downloaded',
    savedTo: 'Saved to',
    shortcuts: 'Keyboard shortcuts',
    aboutDesc: 'Torrent streaming player for macOS',
    version: 'Version',
    keyPlayPause: 'Play / pause',
    keySeek10: 'Back / forward 10 seconds',
    keySeek30: 'Back / forward 30 seconds',
    keyVolume: 'Volume up / down',
    keyMute: 'Mute',
    keySubsSize: 'Subtitle size',
    keyFullscreen: 'Full screen',
    keyExitFullscreen: 'Exit full screen',
    keyOpen: 'Open torrent or file',
    keySettings: 'Settings',
    subsOff: 'Off',
    track: 'Track',
    loadSubsFile: 'Load subtitle file…',
    searchOnline: 'Search online (OpenSubtitles)…',
    loadingSubs: 'Loading subtitles…',
    osNeedKey: 'Add your free OpenSubtitles API key in Settings to search online.',
    osSearchFailed: 'Online subtitle search failed. Check your API key in Settings.',
    osNotFound: 'No subtitles found online.',
    osDownloadFailed: 'Could not download this subtitle.',
    subsFileFailed: 'Could not load this subtitle file.',
    volume: 'Volume',
    subtitlesSize: 'Subtitles',
    showInFinder: 'Show in Finder',
    chapter: 'Chapter',
    seekingTo: 'Going to',
    subsReset: 'Subtitles back to default position',
  },
  ru: {
    settings: 'Настройки',
    openFile: 'Открыть торрент или видеофайл',
    continueWatching: 'Продолжить просмотр',
    dropHint: 'Или перетащите .torrent, magnet-ссылку или видеофайл в окно.',
    offerDefault: 'Открывать magnet-ссылки и торренты здесь по умолчанию?',
    offerYes: 'Да, по умолчанию',
    offerNo: 'Не сейчас',
    setDefault: 'Открывать magnet-ссылки и торренты в этом плеере',
    setPrefetch: 'Подгружать начало следующей серии ближе к концу текущей',
    setAllDesktops: 'Показывать окно на всех рабочих столах',
    setRememberWindow: 'Запоминать размер и положение окна',
    setAskPath: 'Спрашивать, куда сохранять, каждый раз',
    language: 'Язык',
    whereToDownload: 'Куда скачивать',
    tempFolder: 'Временная папка',
    choose: 'Выбрать…',
    cacheNote: 'Скачанное это кэш, он удаляется при выходе из приложения.',
    osKey: 'Ключ API OpenSubtitles',
    osKeyHint: 'для онлайн-поиска субтитров, бесплатно.',
    osHowTo: 'Как получить ключ',
    osStep1: 'Создайте бесплатный аккаунт на opensubtitles.com.',
    osStep2: 'Откройте Profile → API consumers и добавьте нового consumer (любое имя).',
    osStep3: 'Скопируйте показанный ключ API и вставьте его ниже.',
    osOpenSite: 'Открыть opensubtitles.com',
    optional: 'необязательно',
    byAuthor: 'автор alxchrk',
    done: 'Готово',
    keepWaiting: 'Ждать дальше',
    openAnother: 'Открыть другой торрент',
    downloadStatus: 'Статус загрузки',
    saveFile: 'Сохранить скачанный файл…',
    prevEpisode: 'Предыдущая серия',
    nextEpisode: 'Следующая серия',
    openMore: 'Открыть другой торрент или файл',
    keepOnTop: 'Поверх всех окон',
    dropToOpen: 'Отпустите, чтобы открыть',
    errOpen: 'Не удалось открыть этот торрент или файл. Возможно, он повреждён или недоступен.',
    errNoVideo: 'Здесь нет видео для воспроизведения.',
    errPlayback: 'Не удалось начать воспроизведение. Возможно, файл нечитаем.',
    errNoSeeders: 'Сидов пока нет. Подождать ещё или открыть другой торрент.',
    peers: 'пиров',
    fullyDownloaded: 'Файл скачан полностью',
    savedTo: 'Сохранено в',
    shortcuts: 'Горячие клавиши',
    aboutDesc: 'Плеер для потокового просмотра торрентов на macOS',
    version: 'Версия',
    keyPlayPause: 'Пауза / воспроизведение',
    keySeek10: 'Назад / вперёд на 10 секунд',
    keySeek30: 'Назад / вперёд на 30 секунд',
    keyVolume: 'Громче / тише',
    keyMute: 'Без звука',
    keySubsSize: 'Размер субтитров',
    keyFullscreen: 'Полный экран',
    keyExitFullscreen: 'Выйти из полного экрана',
    keyOpen: 'Открыть торрент или файл',
    keySettings: 'Настройки',
    subsOff: 'Выкл',
    track: 'Дорожка',
    loadSubsFile: 'Загрузить файл субтитров…',
    searchOnline: 'Найти онлайн (OpenSubtitles)…',
    loadingSubs: 'Загрузка субтитров…',
    osNeedKey: 'Добавьте бесплатный ключ API OpenSubtitles в настройках, чтобы искать онлайн.',
    osSearchFailed: 'Онлайн-поиск не удался. Проверьте ключ API в настройках.',
    osNotFound: 'Субтитры онлайн не найдены.',
    osDownloadFailed: 'Не удалось скачать эти субтитры.',
    subsFileFailed: 'Не удалось загрузить этот файл субтитров.',
    volume: 'Громкость',
    subtitlesSize: 'Субтитры',
    showInFinder: 'Показать в Finder',
    chapter: 'Глава',
    seekingTo: 'Переход к',
    subsReset: 'Субтитры возвращены на место',
  },
};

let lang = localStorage.getItem('lang') === 'ru' ? 'ru' : 'en';

function t(key) {
  return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
}

function applyI18n() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}

function setLanguage(l) {
  lang = l === 'ru' ? 'ru' : 'en';
  try { localStorage.setItem('lang', lang); } catch (_) {}
  applyI18n();
  window.api.setLanguage(lang);
}

function getLanguage() { return lang; }

window.t = t;
window.applyI18n = applyI18n;
window.setLanguage = setLanguage;
window.getLanguage = getLanguage;
