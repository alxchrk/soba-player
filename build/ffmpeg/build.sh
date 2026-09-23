#!/bin/sh
# Собирает ffmpeg и ffprobe для бандла из официальных исходников FFmpeg.
#
# Лицензия результата LGPL-2.1-or-later: без --enable-gpl и --enable-nonfree,
# без сторонних библиотек. Приложению хватает встроенных декодеров, кодера AAC
# и аппаратного кодера h264_videotoolbox. Автоопределение выключено, поэтому
# бинарники зависят только от системных библиотек macOS и не тянут ничего из
# Homebrew.
#
# Результат: build/ffmpeg/bin/{ffmpeg,ffprobe}. Повторный запуск ничего не
# делает, если бинарники нужной версии уже собраны.
set -eu

VERSION=8.1.3
SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
MACOS_MIN=11.0

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/src"
OUT="$HERE/bin"
TARBALL="ffmpeg-$VERSION.tar.xz"

if [ -x "$OUT/ffmpeg" ] && [ -x "$OUT/ffprobe" ] && "$OUT/ffmpeg" -version 2>/dev/null | head -1 | grep -q "ffmpeg version $VERSION "; then
  echo "ffmpeg $VERSION уже собран: $OUT"
  exit 0
fi

mkdir -p "$SRC" "$OUT"
cd "$SRC"
[ -f "$TARBALL" ] || curl -fL -o "$TARBALL" "https://ffmpeg.org/releases/$TARBALL"
echo "$SHA256  $TARBALL" | shasum -a 256 -c -
rm -rf "ffmpeg-$VERSION"
tar xf "$TARBALL"
cd "ffmpeg-$VERSION"

./configure \
  --arch=arm64 \
  --cc=clang \
  --extra-cflags="-mmacosx-version-min=$MACOS_MIN" \
  --extra-ldflags="-mmacosx-version-min=$MACOS_MIN" \
  --extra-libs=-liconv \
  --disable-autodetect \
  --enable-videotoolbox \
  --enable-audiotoolbox \
  --enable-zlib \
  --enable-bzlib \
  --enable-iconv \
  --enable-static \
  --disable-shared \
  --disable-ffplay \
  --disable-doc \
  --disable-debug

make -j"$(sysctl -n hw.ncpu)" ffmpeg ffprobe
cp ffmpeg ffprobe "$OUT/"
"$OUT/ffmpeg" -hide_banner -L | head -3
