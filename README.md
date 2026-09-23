# Soba Player

A minimal torrent streaming player for macOS. Drop a `.torrent` file, a magnet
link or a local video into the window and it starts playing while the torrent
downloads.

## Install

1. Download the latest `.dmg` from
   [Releases](https://github.com/alxchrk/soba-player/releases).
2. Open it and drag **Soba Player** to Applications.

Requirements: a Mac with Apple Silicon (M1 or newer), macOS 11 Big Sur or later.
Intel Macs are not supported yet.

The app is signed with an Apple Developer ID and notarized by Apple, so it
opens without Gatekeeper warnings. It checks this repository's releases for
updates in the background and installs them on the next launch.

## Features

- Streams torrents and magnet links with [WebTorrent](https://webtorrent.io):
  playback starts after the first pieces arrive, seeking downloads the needed
  part first.
- Plays local video files, including MKV, AVI and other formats Safari cannot
  play. Such files are remuxed or transcoded on the fly by FFmpeg; video is
  copied when possible and uses the hardware encoder when it is not.
- Multi-file torrents become a playlist: previous and next episode, prefetch of
  the next episode near the end of the current one.
- Audio track selection, embedded subtitles, local subtitle files and optional
  online search on OpenSubtitles.com (requires your own free API key).
- Resume from where you stopped, playback speed, a "keep on top"
  window, full screen with a trackpad pinch.
- Downloaded data is a cache: it is deleted when you quit the app, unless you
  save the finished file explicitly.
- English and Russian interface.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| Space, K | Play / pause |
| ← → | Back / forward 10 seconds |
| J, L | Back / forward 30 seconds |
| ↑ ↓ | Volume |
| M | Mute |
| + − | Subtitle size |
| F | Full screen |
| Esc | Exit full screen |
| ⌘O | Open torrent or file |
| ⌘, | Settings |
| ⌘/ | Show shortcuts |

## Privacy

No analytics, no telemetry, no accounts. The app connects only to:

- BitTorrent trackers and peers of the torrent you open;
- OpenSubtitles.com, only when you search subtitles online with your own key;
- GitHub, to check for app updates.

## Roadmap

- AirPlay output to Apple TV and AirPlay 2 smart TVs.
- Chromecast output.
- Streaming from the Mac to iPhone and iPad over HLS on the home network.
- Intel Mac builds.

## Build from source

Requires Node.js 20+, Xcode command line tools and an Apple Silicon Mac.

```
npm install
npm run ffmpeg   # builds FFmpeg from source into build/ffmpeg/bin (a few minutes)
npm run dev
```

`npm run build` produces an unsigned or signed `.app` in `dist/`, depending on
the signing identity available on your machine. Notarization reads Apple API
credentials from a local `.env` file (`APPLE_API_KEY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`), which is never committed.

In development, `FFMPEG_PATH` and `FFPROBE_PATH` override the FFmpeg binaries;
without them the app uses `build/ffmpeg/bin`, then Homebrew.

## Legal

Soba Player is a general-purpose media player and BitTorrent client. It does
not host, index, link to or recommend any content. You are responsible for
making sure you have the right to download and watch what you open with it,
under the laws of your country.

## License

Soba Player source code is released under the [MIT License](LICENSE).

The app bundles third-party software under its own licenses:

| Component | License | Notes |
|---|---|---|
| [FFmpeg](https://ffmpeg.org) 8.1.3 (`ffmpeg`, `ffprobe`) | LGPL-2.1-or-later | Built from unmodified source by [`build/ffmpeg/build.sh`](build/ffmpeg/build.sh), without GPL or non-free parts. The source archive is attached to every release. |
| [Electron](https://www.electronjs.org) and Chromium | MIT and Chromium licenses | Notices ship inside the app. |
| [WebTorrent](https://github.com/webtorrent/webtorrent) | MIT | |
| [electron-updater](https://github.com/electron-userland/electron-builder) | MIT | |
| [node-datachannel](https://github.com/murat-dogan/node-datachannel) | MPL-2.0 | Unmodified, used by WebTorrent. |
| Other npm dependencies | MIT, ISC, BSD, Apache-2.0, BlueOak-1.0.0, Python-2.0 | License files ship inside the app. |

The full list with license texts is in
[`build/licenses`](build/licenses/THIRD-PARTY-NOTICES.txt) and inside the app
at `Soba Player.app/Contents/Resources/licenses`.

FFmpeg is a trademark of Fabrice Bellard. OpenSubtitles is a service of its
respective owners; Soba Player is not affiliated with it. Apple, macOS,
AirPlay and Apple TV are trademarks of Apple Inc. Chromecast is a trademark of
Google LLC.
