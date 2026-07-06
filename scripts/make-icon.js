'use strict';

// Rasterize assets/cicada-logo.svg into build/icon.png (512x512, transparent) using
// Electron's own Chromium — no image-processing dependencies. electron-builder then
// converts the PNG into the platform icon formats (.ico for the Windows build).
//
//   npx electron scripts/make-icon.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 512;
const ROOT = path.join(__dirname, '..');

app.whenReady().then(async () => {
  try {
    let svg = fs.readFileSync(path.join(ROOT, 'assets', 'cicada-logo.svg'), 'utf8');
    // The mark includes a white petal, so it sits on the app's dark squircle (matching
    // the window chrome) instead of raw transparency; corners stay transparent.
    const inner = Math.round(SIZE * 0.82);
    svg = svg.replace('width="120" height="120"', `width="${inner}" height="${inner}"`);
    const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">` +
      `<div style="width:${SIZE}px;height:${SIZE}px;background:#0e1116;border-radius:${Math.round(SIZE * 0.22)}px;` +
      `display:grid;place-items:center">${svg}</div></body></html>`;

    const win = new BrowserWindow({
      width: SIZE, height: SIZE, show: false, frame: false, transparent: true,
      webPreferences: { offscreen: true },
    });
    win.webContents.setFrameRate(1);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 600)); // let the gradients paint

    const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
    fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
    const out = path.join(ROOT, 'build', 'icon.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('[icon] wrote ' + out + ' (' + img.getSize().width + 'x' + img.getSize().height + ')');
    app.exit(0);
  } catch (e) {
    console.error('[icon] failed:', e);
    app.exit(1);
  }
});
