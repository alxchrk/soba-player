#!/bin/sh
# Собирает помощник AirPlay (build/airplay/bin/SobaAirPlay) из main.swift.
# Info.plist встраивается в бинарник: в нём разрешение на обычный http к
# адресам локальной сети (HLS-сервер плеера) и описание доступа к сети.
# Повторный запуск ничего не делает, если бинарник новее исходников.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/bin/SobaAirPlay"

if [ -x "$OUT" ] && [ "$OUT" -nt "$HERE/main.swift" ] && [ "$OUT" -nt "$HERE/Info.plist" ]; then
  echo "SobaAirPlay уже собран: $OUT"
  exit 0
fi

mkdir -p "$HERE/bin"
xcrun swiftc -O \
  -target arm64-apple-macos12.0 \
  -o "$OUT" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$HERE/Info.plist" \
  "$HERE/main.swift"
echo "SobaAirPlay собран: $OUT"
