// icon.svg -> icon.png(512) + icon.ico(16~256) 를 Electron 캔버스로 렌더링한다.
// 사용: env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe build/make-icon.cjs build
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const srcDir = path.resolve(process.argv[2] || __dirname);
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(srcDir, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  await win.loadURL('data:text/html,<canvas id=c></canvas>');
  const png = await win.webContents.executeJavaScript(`(async () => {
    const svg = ${JSON.stringify(svg)};
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image(); img.src = url; await img.decode();
    const out = {};
    for (const size of ${JSON.stringify(SIZES)}) {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, size, size);
      out[size] = c.toDataURL('image/png').split(',')[1];
    }
    return out;
  })()`);
  for (const size of SIZES) fs.writeFileSync(path.join(srcDir, `_icon-${size}.png`), Buffer.from(png[size], 'base64'));
  fs.copyFileSync(path.join(srcDir, '_icon-512.png'), path.join(srcDir, 'icon.png'));
  // ICO(PNG 압축 항목): 헤더 6바이트 + 항목 16바이트씩 + 이미지 데이터
  const icoSizes = SIZES.filter(size => size <= 256);
  const images = icoSizes.map(size => Buffer.from(png[size], 'base64'));
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoSizes.length, 4);
  let offset = 6 + 16 * icoSizes.length; const entries = [];
  icoSizes.forEach((size, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0); e.writeUInt8(size === 256 ? 0 : size, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(images[i].length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); offset += images[i].length;
  });
  fs.writeFileSync(path.join(srcDir, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
  for (const size of SIZES) fs.unlinkSync(path.join(srcDir, `_icon-${size}.png`));
  console.log('done');
  app.quit();
});
