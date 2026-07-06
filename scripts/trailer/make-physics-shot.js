'use strict';

// Cicada demo shot — "physics manifold": a clean, caption-free capture of the real app
// building a multi-file repo from a physics prompt (a vibrating-membrane wave-equation
// eigenmode), rendering the resulting 3D surface plot, and a simulated GitHub publish.
//
//   node scripts/trailer/make-physics-shot.js [--key <sk-...>] [--music] [--dry-run] [--no-record] [--keep]
//
// Same pipeline as make-trailer.js (backup config -> DeepSeek repo mode on a clean project
// -> fullscreen desktop capture with @@BEAT sync -> postfx) but with physics-beats.js /
// physics-choreography.js swapped in, and no drawtext captions anywhere in the cut.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electronExe = require('electron');
const recorder = require('./recorder');
const choreography = require('./physics-choreography');
const postfx = require('./postfx');
const beats = require('./physics-beats');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out-physics');
const WORK = path.join(__dirname, '.work-physics');
const CONFIG = path.join(os.homedir(), 'GARM Code', 'config.json');
const DEMO_PROJECT = path.join(os.homedir(), 'GARM Code', 'projects', 'Physics Manifold Demo');

const AUTORUN_DELAY = 8000;
const FF_INIT_MS = 650;
const HARD_TIMEOUT_MS = 240000; // repo-mode + a 3D render can run long

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
  const a = { music: '', musicVolume: 0.3, dryRun: false, noRecord: false, keep: false,
    key: process.env.DEEPSEEK_API_KEY || '', model: 'deepseek-v4-flash' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--no-record') a.noRecord = true;
    else if (k === '--keep') a.keep = true;
    else if (k === '--music') a.music = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : defaultMusic;
    else if (k === '--music-volume') a.musicVolume = parseFloat(argv[++i]);
    else if (k === '--key') a.key = argv[++i];
    else if (k === '--model') a.model = argv[++i];
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

    const recTimer = setTimeout(async () => {
      try {
        rec = recorder.record(ff.ffmpeg, { out: raw, fps: beats.FPS });
        ffmpegStart = Date.now();
        log('• recording…');
      } catch (e) { reject(e); }
    }, 4000);

    const hard = setTimeout(() => { log('! hard timeout — wrapping up'); finish(); }, HARD_TIMEOUT_MS);

    async function finish() {
      if (finished) return; finished = true;
      clearTimeout(recTimer); clearTimeout(hard);
      await new Promise((r) => setTimeout(r, 500));
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
  log('=== Cicada physics demo shot ===');

  const original = readConfig();
  const key = args.key || (original && original.deepseekApiKey) || '';
  let restore = null;
  if (!args.noRecord) {
    if (!key) log('! No DeepSeek key. Pass --key <sk-...> or set DEEPSEEK_API_KEY (or set it once in the app).');
    freshProject();
    const demoCfg = Object.assign({}, original || {}, {
      provider: 'deepseek', deepseekApiKey: key, deepseekModel: args.model,
      agentOutputMode: 'repo', workspaceDir: DEMO_PROJECT,
    });
    writeConfig(demoCfg);
    restore = () => { if (original) writeConfig(original); log('• restored your original config.json'); };
    log('• clean project + DeepSeek ' + args.model + ' (repo mode) configured for the demo run');
  }

  let session;
  try {
    if (args.noRecord) {
      const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'));
      const ff = recorder.resolve();
      if (!ff) throw new Error('ffmpeg not found for --no-record. Run once without it first.');
      session = { beatTimes: meta.beats, raw: path.join(OUT, 'raw.mkv'), ffmpeg: ff.ffmpeg, ffprobe: ff.ffprobe };
    } else {
      session = await captureSession();
    }
  } finally {
    if (restore) restore();
  }

  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ beats: session.beatTimes }, null, 2), 'utf8');
  log('• beats captured: ' + Object.keys(session.beatTimes).join(', '));

  log('• rendering the cut' + (args.dryRun ? ' (dry-run — commands only)' : '') + '…');
  const result = postfx.run({
    ffmpeg: session.ffmpeg, ffprobe: session.ffprobe,
    raw: session.raw, vo: null,
    music: args.music && fs.existsSync(args.music) ? args.music : null, musicVolume: args.musicVolume,
    shots: beats.SHOTS, captions: beats.CAPTIONS, // no captions map -> no drawtext anywhere
    outDir: OUT, dryRun: args.dryRun, log: (c) => log('  $ ' + c),
  });

  const finalName = 'cicada-physics-demo.mp4';
  const finalPath = path.join(OUT, finalName);
  if (!args.dryRun && result.output !== finalPath) fs.renameSync(result.output, finalPath);

  log('\n✓ Physics demo shot: ' + finalPath);
  log('  length ≈ ' + result.total.toFixed(1) + 's · ' + result.shotCount + ' shots · ' + result.stills.length + ' stills in ' + path.join(OUT, 'stills'));
  if (!args.keep && !args.dryRun) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) {} }
}

main().catch((e) => { console.error('\n✗ ' + (e && e.stack || e)); process.exit(1); });
