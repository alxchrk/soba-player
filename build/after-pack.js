// Хук electron-builder (afterPack, до подписи). Компилирует build/AppIcon.icon
// (документ Apple Icon Composer) в Assets.car и кладёт его в бандл: macOS 26+
// берёт оттуда светлый, тёмный и тонированный варианты иконки и меняет их
// вместе с темой системы. Старые версии macOS продолжают читать icon.icns
// из CFBundleIconFile. Нужен Xcode (actool); без него шаг пропускается.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ICON_NAME = 'AppIcon';

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const iconSrc = path.join(__dirname, ICON_NAME + '.icon');
  if (!fs.existsSync(iconSrc)) return;

  let actool;
  try {
    actool = execFileSync('xcrun', ['--find', 'actool'], { encoding: 'utf8' }).trim();
  } catch (_) {
    console.warn('  • actool не найден (нужен Xcode), иконка по теме не собрана');
    return;
  }

  const appDir = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  const resources = path.join(appDir, 'Contents', 'Resources');
  const plist = path.join(appDir, 'Contents', 'Info.plist');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'actool-'));

  execFileSync(actool, [
    '--app-icon', ICON_NAME,
    '--output-format', 'human-readable-text',
    '--errors', '--warnings',
    '--platform', 'macosx',
    '--minimum-deployment-target', '12.0',
    '--target-device', 'mac',
    '--output-partial-info-plist', path.join(tmp, 'partial.plist'),
    '--compile', tmp,
    iconSrc,
  ], { stdio: 'inherit' });

  fs.copyFileSync(path.join(tmp, 'Assets.car'), path.join(resources, 'Assets.car'));
  // CFBundleIconFile остаётся icon.icns от electron-builder, добавляем только имя
  // ресурса из каталога.
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Delete :CFBundleIconName', plist], { stdio: 'ignore' });
  } catch (_) {}
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :CFBundleIconName string ${ICON_NAME}`, plist]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('  • Assets.car из ' + ICON_NAME + '.icon добавлен в бандл');
};
