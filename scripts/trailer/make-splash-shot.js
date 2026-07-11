'use strict';

// Cicada demo shot — "splash screen": the app's real boot sequence, screen-recorded. No
// agent run, no GitHub, no captions — just the flower-mark spin-up handing off into the
// workbench assembling, with cinematic push-in / pull-out camera moves added in post.
//
//   node scripts/trailer/make-splash-shot.js [--music] [--dry-run] [--keep]
//
// Unlike make-trailer.js / make-physics-shot.js this needs no DeepSeek key (nothing runs) —
// it only points the workspace at a clean throwaway project for a pristine-looking reveal,
// and picks a provider that won't show an error banner in the top bar during the shot.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electronExe = require('electron');
const recorder = require('./recorder');
const choreography = require('./splash-choreography');
const postfx = require('./postfx');
const beats = require('./splash-beats');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out-splash');
const WORK = path.join(__dirname, '.work-splash');
const CONFIG = path.join(os.homedir(), 'GARM Code', 'config.json');
const DEMO_PROJECT = path.join(os.homedir(), 'GARM Code', 'projects', 'Splash Demo');

// The splash's own timing (see styles.css / app.js dismissSplash): MIN_MS=2100, MAX_MS=4200.
// Recording starts very early (well before Electron can possibly finish booting), and the
// choreography additionally waits for real focus+visibility before marking its start beat —
// giving the OS fullscreen/always-on-top transition (forced explicitly in main.js under
// GARM_TRAILER) real time to actually complete before any frame is considered "kept" footage.
const REC_START_DELAY = 400;
const AUTORUN_DELAY = 900;
const FF_INIT_MS = 500;
const HARD_TIMEOUT_MS = 30000;

const STARTER_MAIN = [
  '# New Cicada project.',
  '# Describe a program in the Agent panel and run the pipeline.',
  '',
  'def main():',
  '    print("Hello from Cicada")',
  '',
  '',
  'if __name__ == "__main__":',
  '    main()',
  '',
].join('\n');

function freshProject() {
  try { fs.rmSync(DEMO_PROJECT, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  fs.mkdirSync(DEMO_PROJECT, { recursive: true });
  fs.writeFileSync(path.join(DEMO_PROJECT, 'main.py'), STARTER_MAIN, 'utf8');
}

function parseArgs(argv) {
  const defaultMusic = path.join(__dirname, 'music.wav');
  const a = { music: '', musicVolume: 0.3, dryRun: false, keep: false, key: process.env.DEEPSEEK_API_KEY || '' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--keep') a.keep = true;
    else if (k === '--music') a.music = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : defaultMusic;
    else if (k === '--music-volume') a.musicVolume = parseFloat(argv[++i]);
    else if (k === '--key') a.key = argv[++i];
  }
  return a;
}

function log(msg) { process.stdout.write(msg + '\n'); }
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (_) { return null; } }
function writeConfig(obj) { fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(obj, null, 2), 'utf8'); }

function captureSession() {
  return new Promise(async (resolve, reject) => {
    fs.mkdirSync(WORK, { recursive: true });
    fs.mkdirSync(OUT, { recursive: true });
    const choreoPath = path.join(WORK, 'choreo.js');
    fs.writeFileSync(choreoPath, choreography.build(), 'utf8');

    log('• ensuring ffmpeg…');
    const ff = await recorder.ensure((p) => process.stdout.write('  ' + (p.detail || p.state) + '\r'));
    process.stdout.write('\n');

    const env = Object.assign({}, process.env, {
      GARM_AUTORUN: 'jsfile:' + choreoPath,
      GARM_AUTORUN_DELAY: String(AUTORUN_DELAY),
      GARM_TRAILER: '1',
    });

    log('• launching Cicada…');
    const app = spawn(electronExe, ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

    const beatTimes = {};
    let ffmpegStart = 0;
    let rec = null;
    let finished = false;
    const raw = path.join(OUT, 'raw.mkv');

    const onLine = (line) => {
      const m = line.match(/@@BEAT\s+(\w+)/);
      if (!m) return;
      const name = m[1];
      if (ffmpegStart && beatTimes[name] == null) {
        beatTimes[name] = Math.max(0, (Date.now() - ffmpegStart - FF_INIT_MS) / 1000);
        log('  beat ' + name + ' @ ' + beatTimes[name].toFixed(2) + 's');
      }
      if (name === 'end' || name === 'fail') finish();
    };
    let buf = '';
    const feed = (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } };
    app.stdout.on('data', feed);
    app.stderr.on('data', feed);

    // Start recording almost immediately — well before Electron can possibly finish booting,
    // loading index.html, and firing did-finish-load — so no early beat is ever dropped.
    const recTimer = setTimeout(async () => {
      try {
        rec = recorder.record(ff.ffmpeg, { out: raw, fps: beats.FPS });
        ffmpegStart = Date.now();
        log('• recording…');
      } catch (e) { reject(e); }
    }, REC_START_DELAY);

    const hard = setTimeout(() => { log('! hard timeout — wrapping up'); finish(); }, HARD_TIMEOUT_MS);

    async function finish() {
      if (finished) return; finished = true;
      clearTimeout(recTimer); clearTimeout(hard);
      await new Promise((r) => setTimeout(r, 400));
      let recLog = '';
      if (rec) { try { recLog = await rec.stop(); } catch (_) { /* ignore */ } }
      try { app.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32') { try { spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {} }
      if (!Object.keys(beatTimes).length) return reject(new Error('No beats captured — the app may not have started (check that it launches with `npm start`).'));
      let sz = 0; try { sz = fs.statSync(raw).size; } catch (_) {}
      if (sz < 10000) return reject(new Error('Screen capture is empty (' + sz + ' bytes). ffmpeg said:\n' + recLog.split('\n').slice(-8).join('\n')));
      resolve({ beatTimes, raw, ffmpeg: ff.ffmpeg, ffprobe: ff.ffprobe });
    }

    app.on('exit', () => { if (!finished) finish(); });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  log('=== Cicada splash-screen demo shot ===');

  // No agent run happens in this shot, but a fresh project + a "ready"-looking status pill
  // (instead of a red llama.cpp error banner) makes the reveal look its best. DeepSeek with
  // any key is enough for that — nothing is actually called.
  const original = readConfig();
  freshProject();
  const demoCfg = Object.assign({}, original || {}, {
    provider: 'deepseek', deepseekApiKey: args.key || (original && original.deepseekApiKey) || 'unused',
    workspaceDir: DEMO_PROJECT,
  });
  writeConfig(demoCfg);
  const restore = () => { if (original) writeConfig(original); log('• restored your original config.json'); };

  let session;
  try {
    session = await captureSession();
  } finally {
    restore();
  }

  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ beats: session.beatTimes }, null, 2), 'utf8');
  log('• beats captured: ' + Object.keys(session.beatTimes).join(', '));

  log('• rendering the cut' + (args.dryRun ? ' (dry-run — commands only)' : '') + '…');
  const result = postfx.run({
    ffmpeg: session.ffmpeg, ffprobe: session.ffprobe,
    raw: session.raw, vo: null,
    music: args.music && fs.existsSync(args.music) ? args.music : null, musicVolume: args.musicVolume,
    shots: beats.SHOTS, captions: beats.CAPTIONS,
    outDir: OUT, dryRun: args.dryRun, log: (c) => log('  $ ' + c),
  });

  const finalPath = path.join(OUT, 'cicada-splash-demo.mp4');
  if (!args.dryRun && result.output !== finalPath) fs.renameSync(result.output, finalPath);

  log('\n✓ Splash-screen demo shot: ' + finalPath);
  log('  length ≈ ' + result.total.toFixed(1) + 's · ' + result.shotCount + ' shots · ' + result.stills.length + ' stills in ' + path.join(OUT, 'stills'));
  if (!args.keep && !args.dryRun) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) {} }
}

main().catch((e) => { console.error('\n✗ ' + (e && e.stack || e)); process.exit(1); });
