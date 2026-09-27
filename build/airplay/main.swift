// SobaAirPlay: помощник плеера для AirPlay-видео. Chromium не умеет отдавать
// видео на приёмник AirPlay, системный AVPlayer умеет: при выбранном
// приёмнике телевизор сам забирает HLS-поток по адресу, а AVPlayer на Mac
// становится пультом.
//
// Протокол: команды JSON-строками в stdin, события JSON-строками в stdout.
//   {"cmd":"load","url":"http://...","at":1.5}  загрузить поток, встать на секунду at
//   {"cmd":"pick","x":..,"y":..,"w":..,"h":..}  показать меню приёмников у прямоугольника
//                                               (экранные координаты с левого верхнего угла)
//   {"cmd":"play"} {"cmd":"pause"} {"cmd":"seek","t":12.3} {"cmd":"stop"}
//   события: {"ev":"ready"} {"ev":"route","active":true} {"ev":"time","t":..,"playing":..}
//            {"ev":"picker","open":false} {"ev":"ended"} {"ev":"error","message":".."}
// Закрытие stdin (плеер завершился) завершает помощник.

import AppKit
import AVFoundation
import AVKit

final class Helper: NSObject, AVRoutePickerViewDelegate {
  let player = AVPlayer()
  let picker = AVRoutePickerView(frame: NSRect(x: 0, y: 0, width: 24, height: 24))
  let panel: NSPanel
  var statusObservation: NSKeyValueObservation?
  var externalObservation: NSKeyValueObservation?
  var rateObservation: NSKeyValueObservation?
  var pendingSeek: Double = 0
  var buffer = Data()

  override init() {
    panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 24, height: 24),
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    super.init()
    player.allowsExternalPlayback = true
    // До подключения приёмника поток играет на Mac беззвучно: так AVPlayer
    // сразу переходит на телевизор после выбора, а при отмене ничего не слышно.
    player.isMuted = true
    picker.player = player
    picker.delegate = self
    picker.isRoutePickerButtonBordered = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = .popUpMenu
    panel.alphaValue = 0.01
    panel.contentView = picker

    externalObservation = player.observe(\.isExternalPlaybackActive, options: [.new]) { [weak self] p, _ in
      p.isMuted = !p.isExternalPlaybackActive
      self?.send(["ev": "route", "active": p.isExternalPlaybackActive])
    }
    rateObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
      self?.sendTime()
    }
    player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
      self?.sendTime()
    }
    NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] _ in
      self?.send(["ev": "ended"])
    }
    NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: nil, queue: .main) { [weak self] n in
      let err = n.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
      self?.send(["ev": "error", "message": err?.localizedDescription ?? "playback failed"])
    }
  }

  func send(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  }

  func sendTime() {
    let t = player.currentTime().seconds
    send(["ev": "time", "t": t.isFinite ? t : 0, "playing": player.timeControlStatus != .paused])
  }

  func handle(line: String) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = obj["cmd"] as? String else { return }
    switch cmd {
    case "load": load(url: obj["url"] as? String ?? "", at: obj["at"] as? Double ?? 0)
    case "pick": pick(x: obj["x"] as? Double ?? 0, y: obj["y"] as? Double ?? 0,
                      w: obj["w"] as? Double ?? 24, h: obj["h"] as? Double ?? 24)
    case "play": player.play()
    case "pause": player.pause()
    case "seek":
      let t = obj["t"] as? Double ?? 0
      player.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    case "stop":
      player.pause()
      player.replaceCurrentItem(with: nil)
    default: break
    }
  }

  // Новый поток. Точная секунда выставляется, когда элемент готов: до этого
  // перемотка у AVPlayer не срабатывает.
  func load(url: String, at: Double) {
    guard let u = URL(string: url) else { return send(["ev": "error", "message": "bad url"]) }
    let wasPlaying = player.timeControlStatus != .paused || player.isExternalPlaybackActive
    let item = AVPlayerItem(url: u)
    pendingSeek = at
    statusObservation = item.observe(\.status, options: [.new]) { [weak self] it, _ in
      guard let self = self else { return }
      if it.status == .readyToPlay && self.pendingSeek > 0 {
        let t = self.pendingSeek
        self.pendingSeek = 0
        self.player.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
      } else if it.status == .failed {
        self.send(["ev": "error", "message": it.error?.localizedDescription ?? "load failed"])
      }
    }
    player.replaceCurrentItem(with: item)
    if wasPlaying { player.play() }
  }

  // Меню приёмников: невидимая кнопка AVRoutePickerView ставится поверх
  // кнопки плеера и нажимается программно, система показывает своё меню.
  func pick(x: Double, y: Double, w: Double, h: Double) {
    let screenH = NSScreen.screens.first?.frame.height ?? 0
    panel.setFrame(NSRect(x: x, y: screenH - y - h, width: w, height: h), display: true)
    picker.frame = NSRect(x: 0, y: 0, width: w, height: h)
    panel.orderFrontRegardless()
    NSApp.activate(ignoringOtherApps: true)
    if let button = findButton(in: picker) {
      button.performClick(nil)
    } else {
      send(["ev": "error", "message": "route picker button not found"])
    }
  }

  func findButton(in view: NSView) -> NSButton? {
    if let b = view as? NSButton { return b }
    for sub in view.subviews {
      if let b = findButton(in: sub) { return b }
    }
    return nil
  }

  func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) {
    panel.orderOut(nil)
    send(["ev": "picker", "open": false])
  }

  func readStdin() {
    FileHandle.standardInput.readabilityHandler = { [weak self] fh in
      let chunk = fh.availableData
      DispatchQueue.main.async {
        guard let self = self else { return }
        if chunk.isEmpty { exit(0) }
        self.buffer.append(chunk)
        while let nl = self.buffer.firstIndex(of: 0x0A) {
          let lineData = self.buffer.subdata(in: self.buffer.startIndex..<nl)
          self.buffer.removeSubrange(self.buffer.startIndex...nl)
          if let line = String(data: lineData, encoding: .utf8) { self.handle(line: line) }
        }
      }
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let helper = Helper()
helper.readStdin()
helper.send(["ev": "ready"])
app.run()
