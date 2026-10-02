// Запрет сна на время просмотра. Причины независимы: локальное воспроизведение
// держит экран включённым, показ на телевизоре держит только систему (экран
// Mac может погаснуть, поток на телевизор идёт дальше).
'use strict';

const { powerSaveBlocker } = require('electron');

const TYPES = { playing: 'prevent-display-sleep', airplay: 'prevent-app-suspension' };
const ids = {};

// reason: 'playing' или 'airplay'.
function set(reason, on) {
  const id = ids[reason];
  if (on && id == null) {
    ids[reason] = powerSaveBlocker.start(TYPES[reason]);
  } else if (!on && id != null) {
    powerSaveBlocker.stop(id);
    delete ids[reason];
  }
}

module.exports = { set };
