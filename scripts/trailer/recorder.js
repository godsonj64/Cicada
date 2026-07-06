'use strict';

// ffmpeg plumbing for the trailer: auto-download a static ffmpeg/ffprobe (no manual install),
// screen-record the Cicada window with gdigrab, and probe media duration. Windows-focused
// (the recorder path), but ensure/probe work cross-platform when ffmpeg is already on PATH.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN_DIR = path.join(__dirname, '.bin');
const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

// BtbN publishes self-contained static Windows builds; macOS/Linux users typically have
// ffmpeg from a package manager, so auto-download only targets Windows here.
const WIN_ZIP = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';

function onPath(cmd) {
  try {
    const finder = IS_WIN ? 'where' : 'which';
    const r = spawnSync(finder, [cmd], { encoding: 'utf8' });
    const hit = (r.stdout || '').split(/\r?\n/)[0].trim();
    return hit && fs.existsSync(hit) ? hit : null;
  } catch (_) { return null; }
}

function findUnder(dir, name) {
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.name.toLowerCase() === name.toLowerCase()) return abs;
    }
  }
  return null;
}

// Resolve { ffmpeg, ffprobe }: prefer PATH, then a prior local download, else null.
function resolve() {
  const ff = onPath('ffmpeg') || (fs.existsSync(BIN_DIR) ? findUnder(BIN_DIR, 'ffmpeg' + EXE) : null);
  const fp = onPath('ffprobe') || (fs.existsSync(BIN_DIR) ? findUnder(BIN_DIR, 'ffprobe' + EXE) : null);
  return ff && fp ? { ffmpeg: ff, ffprobe: fp } : null;
}

async function downloadTo(url, dest, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': 'cicada-trailer' }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error('ffmpeg download failed (' + res.status + ')');
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let got = 0, last = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((r, j) => out.write(Buffer.from(value), (e) => (e ? j(e) : r())));
      got += value.length;
      if (total && onProgress) { const p = Math.round((got / total) * 100); if (p !== last) { last = p; onProgress(p); } }
    }
  } finally { await new Promise((r) => out.end(r)); }
  return dest;
}

function unzip(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (IS_WIN) {
    const ps = "$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '" +
      zip.replace(/'/g, "''") + "' -DestinationPath '" + dir.replace(/'/g, "''") + "' -Force";
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return;
    const t = spawnSync('tar', ['-xf', zip, '-C', dir], { encoding: 'utf8', windowsHide: true });
    if (t.status !== 0) throw new Error('Could not unzip ffmpeg: ' + ((r.stderr || t.stderr || '').trim()));
  } else {
    let r = spawnSync('unzip', ['-o', zip, '-d', dir], { encoding: 'utf8' });
    if (r.status !== 0) r = spawnSync('tar', ['-xf', zip, '-C', dir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('Could not unzip ffmpeg');
  }
}

// Return { ffmpeg, ffprobe }, auto-downloading on Windows when missing.
async function ensure(onProgress) {
  const found = resolve();
  if (found) return found;
  if (!IS_WIN) throw new Error('ffmpeg/ffprobe not found. Install ffmpeg (e.g. `brew install ffmpeg`) and retry.');
  onProgress && onProgress({ state: 'download', detail: 'Downloading ffmpeg…', percent: 0 });
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const zip = path.join(BIN_DIR, 'ffmpeg-win64.zip');
  await downloadTo(WIN_ZIP, zip, (p) => onProgress && onProgress({ state: 'download', detail: 'Downloading ffmpeg… ' + p + '%', percent: p }));
  onProgress && onProgress({ state: 'extract', detail: 'Extracting ffmpeg…', percent: null });
  unzip(zip, BIN_DIR);
  try { fs.unlinkSync(zip); } catch (_) { /* ignore */ }
  const out = resolve();
  if (!out) throw new Error('Downloaded ffmpeg but could not locate ffmpeg.exe/ffprobe.exe.');
  onProgress && onProgress({ state: 'done', detail: out.ffmpeg, percent: null });
  return out;
}

// Media duration in seconds (or null).
function duration(ffprobe, file) {
  try {
    const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
    const d = parseFloat((r.stdout || '').trim());
    return Number.isFinite(d) ? d : null;
  } catch (_) { return null; }
}

// Start recording the given window title with gdigrab. Returns a handle; stop() sends 'q'
// so ffmpeg finalizes the file cleanly (falls back to SIGTERM). Output is a resilient .mkv.
function record(ffmpeg, { out, fps }) {
  // Capture the whole (composited) desktop — the app runs fullscreen during trailer mode,
  // so the desktop frame IS the app. Per-window gdigrab is unreliable for GPU-composited
  // Electron windows (returns black/empty), hence desktop capture.
  const args = [
    '-y',
    '-f', 'gdigrab', '-framerate', String(fps || 30),
    '-draw_mouse', '0',
    '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
    out,
  ];
  const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  proc.stdout.on('data', (d) => { log += d.toString(); });
  proc.stderr.on('data', (d) => { log += d.toString(); });
  return {
    proc,
    getLog: () => log,
    stop: () => new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(log); } };
      proc.on('exit', done);
      try { proc.stdin.write('q'); proc.stdin.end(); } catch (_) { /* ignore */ }
      setTimeout(() => { try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ } }, 2500);
      setTimeout(done, 5000);
    }),
  };
}

module.exports = { ensure, resolve, duration, record, BIN_DIR };
