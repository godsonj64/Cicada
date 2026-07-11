'use strict';

const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.bmp', '.webp']);

// Run watchdog tuning. When a program has produced no output for a full idle window we do NOT
// kill it outright — model training and large simulations can go minutes between log lines while
// pinning the CPU. Instead we sample the child's CPU time over CPU_PROBE_MS; if it advanced by at
// least CPU_PROGRESS_SECONDS it is still doing real work and we grant another window. Only a
// process that is BOTH silent AND not progressing on the CPU (a deadlock, or a blocking input())
// is treated as stuck and terminated.
const CPU_PROBE_MS = 2500;
const CPU_PROGRESS_SECONDS = 0.25;

// Cumulative CPU time (seconds) a process has used so far, read via `ps` (POSIX) or
// PowerShell (Windows). Returns null if the process can't be read (already gone, or the
// probe tool is unavailable), in which case the watchdog falls back to terminating on idle.
function cpuSecondsOf(pid) {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe',
        ['-NoLogo', '-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).TotalProcessorTime.TotalSeconds`],
        { encoding: 'utf8', timeout: 4000, windowsHide: true }).trim();
      const secs = parseFloat(out);
      return Number.isFinite(secs) ? secs : null;
    } catch (_) { return null; }
  }
  try {
    const out = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (!out) return null;
    // ps TIME formats: "MM:SS.ss", "HH:MM:SS", or "DD-HH:MM:SS".
    let rest = out, days = 0;
    const dash = rest.indexOf('-');
    if (dash >= 0) { days = parseInt(rest.slice(0, dash), 10) || 0; rest = rest.slice(dash + 1); }
    let secs = 0;
    for (const part of rest.split(':')) secs = secs * 60 + (parseFloat(part) || 0);
    return days * 86400 + secs;
  } catch (_) { return null; }
}

// Harness that runs the user's script while (a) forcing a headless matplotlib
// backend and (b) auto-saving any figures the script draws, so the Render panel
// can display plots even when the script never writes a file itself.
const HARNESS = `import os, sys, runpy
os.environ.setdefault("MPLBACKEND", "Agg")
# HTTPS for the python.org framework build: it ignores the macOS Keychain and, unless
# "Install Certificates.command" was ever run, has no CA file -- so every download
# (pandas.read_csv(url), urllib, requests...) fails with CERTIFICATE_VERIFY_FAILED.
# Point OpenSSL + urllib + requests at certifi's bundle so verification works for every
# program. Verification stays ON: this is the secure fix, not a bypass.
try:
    import certifi as _certifi
    _ca = _certifi.where()
    os.environ.setdefault("SSL_CERT_FILE", _ca)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", _ca)
    import ssl as _ssl
    if hasattr(_ssl, "_create_default_https_context"):
        _ssl._create_default_https_context = lambda *a, **k: _ssl.create_default_context(cafile=_ca)
except Exception:
    pass
_target = sys.argv[1]
_outdir = os.path.dirname(os.path.abspath(_target)) or "."
try:
    import matplotlib
    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as _plt
    _n = {"i": 0}
    def _save_open(close=True):
        # Save every open figure that has drawable content, then close it so it
        # is not captured twice (e.g. by both show() and the end-of-run sweep).
        for num in list(_plt.get_fignums()):
            fig = _plt.figure(num)
            if not fig.get_axes():
                continue
            _n["i"] += 1
            try:
                fig.savefig(os.path.join(_outdir, "_garm_plot_%02d.png" % _n["i"]), dpi=120, bbox_inches="tight")
            except Exception as _e:
                print("[cicada] could not save figure:", _e, file=sys.stderr)
            if close:
                _plt.close(fig)
    # plt.show() is a no-op under Agg, so we capture on show.
    _plt.show = lambda *a, **k: _save_open(True)
except Exception:
    pass
sys.argv = [_target] + sys.argv[2:]
runpy.run_path(_target, run_name="__main__")
`;

// Images in `dir` modified at or after `sinceMs`. Detecting by modification time
// (not filename novelty) means re-runs that overwrite the same file — e.g. the
// harness's _garm_plot_01.png, or a script's fixed output.png — are still picked up.
function imagesModifiedSince(dir, sinceMs) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()) && f !== '_garm_harness.py')
      .map((f) => path.join(dir, f))
      .filter((p) => {
        try { return fs.statSync(p).mtimeMs >= sinceMs; } catch (_) { return false; }
      });
  } catch (_) {
    return [];
  }
}

// Remove the harness's own plot outputs from a prior run so the Render panel
// reflects only the current run.
function clearHarnessImages(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^_garm_plot_\d+\.png$/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignore */ } }
    }
  } catch (_) { /* ignore */ }
}

/**
 * Syntax-check a Python file (the "compile" stage). Resolves with { ok, output }.
 */
function compileCheck({ pythonPath, file }) {
  return new Promise((resolve) => {
    const proc = spawn(pythonPath, ['-m', 'py_compile', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('error', (err) => resolve({ ok: false, output: `Failed to launch ${pythonPath}: ${err.message}` }));
    proc.on('exit', (code) => resolve({ ok: code === 0, output: out.trim() }));
  });
}

/**
 * Syntax-check several Python files (the "compile" stage in repo mode). Compiles each in
 * turn so a broken module is caught even when the entry point itself is valid. Resolves
 * with { ok, output, failures:[{ file, output }] }; `output` is the first failure's text
 * (prefixed with its path) so the fix loop gets an actionable message.
 */
async function compileCheckFiles({ pythonPath, files }) {
  const list = (files || []).filter((f) => /\.py$/i.test(f));
  const failures = [];
  for (const file of list) {
    const r = await compileCheck({ pythonPath, file });
    if (!r.ok) failures.push({ file, output: r.output });
  }
  const rel = (p) => { const parts = String(p).split(/[\\/]/); return parts.length > 1 ? parts.slice(-2).join('/') : p; };
  const output = failures.length
    ? failures.map((f) => `${rel(f.file)}:\n${f.output}`).join('\n\n')
    : '';
  return { ok: failures.length === 0, output, failures };
}

/**
 * Run a Python file with streaming output. Returns a handle with write()/kill().
 *  onData(stream, text)  stream is 'stdout' | 'stderr'
 *  onExit(code, { images })  images is an array of newly produced image paths
 */
function run({ pythonPath, file, cwd, render = true, timeoutMs = 0, onData, onExit }) {
  const workdir = cwd || path.dirname(file);
  clearHarnessImages(workdir);
  // Small backward buffer guards against clock/mtime granularity at run start.
  const runStart = Date.now() - 1500;

  let harnessPath = null;
  if (render) {
    harnessPath = path.join(workdir, '_garm_harness.py');
    try { fs.writeFileSync(harnessPath, HARNESS, 'utf8'); } catch (_) { harnessPath = null; }
  }

  const args = harnessPath ? ['-u', harnessPath, file] : ['-u', file];
  const proc = spawn(pythonPath, args, { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'] });

  // Idle + CPU watchdog. A genuine hang (a blocking input() with no stdin, a deadlock, or a
  // silent infinite loop) must not freeze the agent's verification run forever — but a program
  // that is doing real work must never be killed, even when it goes a long time between log
  // lines. Model training and large simulations routinely stay quiet for minutes while pinning
  // the CPU, so a pure "no output" timer would terminate them wrongly.
  //
  // So when there has been no output for `timeoutMs`, we don't kill outright: we sample the
  // child's CPU time over a short window. If it is still advancing (training / simulating), we
  // grant another full window; only a process that is BOTH silent AND not using CPU is treated
  // as stuck and terminated. The interactive Run button passes timeoutMs:0 and is never watched.
  // On termination we SIGTERM, escalating to SIGKILL if it ignores the term.
  let timedOut = false;
  let settled = false;
  let idleTimer = null;
  let probeTimer = null;
  let hardTimer = null;
  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (probeTimer) clearTimeout(probeTimer);
    if (hardTimer) clearTimeout(hardTimer);
    idleTimer = probeTimer = hardTimer = null;
  };
  const terminate = (why) => {
    timedOut = true;
    onData && onData('stderr', `\n[cicada] Killed: ${why}\n`);
    try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
    hardTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ } }, 3000);
  };
  const onIdle = () => {
    // Silent for a full window — distinguish "stuck" from "quietly working" by CPU progress.
    const before = cpuSecondsOf(proc.pid);
    probeTimer = setTimeout(() => {
      if (timedOut || settled) return;
      const after = cpuSecondsOf(proc.pid);
      const advanced = (before != null && after != null) ? after - before : 0;
      if (advanced >= CPU_PROGRESS_SECONDS) {
        armWatchdog(); // still burning CPU (training / simulation) — let it keep running
        return;
      }
      const span = timeoutMs >= 60000 ? `${Math.round(timeoutMs / 6000) / 10} min` : `${Math.round(timeoutMs / 1000)}s`;
      terminate(`no output or CPU activity for ${span} (likely a deadlock or a blocking input()).`);
    }, CPU_PROBE_MS);
  };
  const armWatchdog = () => {
    if (timeoutMs <= 0 || timedOut || settled) return;
    if (idleTimer) clearTimeout(idleTimer);
    if (probeTimer) clearTimeout(probeTimer); // cancel any in-flight CPU probe
    probeTimer = null;
    idleTimer = setTimeout(onIdle, timeoutMs);
  };

  const finish = (code, images) => {
    if (settled) return; // guard against error+exit double-fire
    settled = true;
    clearTimers();
    onExit && onExit(code, { images });
  };

  // Any output means the program is alive and doing work — reset the idle countdown.
  proc.stdout.on('data', (d) => { armWatchdog(); onData && onData('stdout', d.toString()); });
  proc.stderr.on('data', (d) => { armWatchdog(); onData && onData('stderr', d.toString()); });
  proc.on('error', (err) => {
    onData && onData('stderr', `Failed to launch ${pythonPath}: ${err.message}\n`);
    finish(-1, []);
  });
  proc.on('exit', (code) => {
    if (harnessPath) { try { fs.unlinkSync(harnessPath); } catch (_) { /* ignore */ } }
    const images = imagesModifiedSince(workdir, runStart);
    // A SIGTERM/SIGKILL surfaces as code null; report a sentinel so the caller can tell.
    finish(timedOut ? (code == null ? 124 : code) : code, images);
  });

  // Start the idle countdown now: a program that emits NO output at all (blocks on input()
  // immediately, or spins silently) would never fire a data event to arm the watchdog otherwise.
  armWatchdog();

  return {
    pid: proc.pid,
    write: (input) => { try { proc.stdin.write(input); } catch (_) { /* closed */ } },
    closeStdin: () => { try { proc.stdin.end(); } catch (_) { /* ignore */ } },
    kill: () => { clearTimers(); try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ } },
  };
}

// ---- Environment / library support -------------------------------------------
//
// GARM generates and runs arbitrary Python, so the agent must know what is actually
// importable in the configured interpreter (frontier ML/DL stacks included), and the
// user must be able to install anything that is missing. The lists below drive both
// the model's library note and the Env panel; detection uses importlib.util.find_spec
// (fast, does NOT import heavy packages like torch/tensorflow).

// importName, distName (for pip / version lookup), category.
const KNOWN_LIBS = [
  ['torch', 'torch', 'Deep learning'],
  ['torchvision', 'torchvision', 'Deep learning'],
  ['tensorflow', 'tensorflow', 'Deep learning'],
  ['keras', 'keras', 'Deep learning'],
  ['jax', 'jax', 'Deep learning'],
  ['transformers', 'transformers', 'Deep learning'],
  ['datasets', 'datasets', 'Deep learning'],
  ['sklearn', 'scikit-learn', 'Classic ML'],
  ['xgboost', 'xgboost', 'Classic ML'],
  ['lightgbm', 'lightgbm', 'Classic ML'],
  ['catboost', 'catboost', 'Classic ML'],
  ['statsmodels', 'statsmodels', 'Classic ML'],
  ['numpy', 'numpy', 'Data & compute'],
  ['pandas', 'pandas', 'Data & compute'],
  ['scipy', 'scipy', 'Data & compute'],
  ['polars', 'polars', 'Data & compute'],
  ['numba', 'numba', 'Data & compute'],
  ['sympy', 'sympy', 'Data & compute'],
  ['networkx', 'networkx', 'Data & compute'],
  ['matplotlib', 'matplotlib', 'Visualization'],
  ['seaborn', 'seaborn', 'Visualization'],
  ['plotly', 'plotly', 'Visualization'],
  ['PIL', 'Pillow', 'Visualization'],
  ['cv2', 'opencv-python', 'CV / NLP'],
  ['skimage', 'scikit-image', 'CV / NLP'],
  ['nltk', 'nltk', 'CV / NLP'],
  ['spacy', 'spacy', 'CV / NLP'],
  ['requests', 'requests', 'Other'],
  ['bs4', 'beautifulsoup4', 'Other'],
];

// import-name -> pip package, so a ModuleNotFoundError can suggest the right install.
const IMPORT_TO_PKG = KNOWN_LIBS.reduce((m, [imp, dist]) => { m[imp] = dist; return m; }, {
  yaml: 'PyYAML', sklearn: 'scikit-learn', cv2: 'opencv-python', PIL: 'Pillow',
  bs4: 'beautifulsoup4', skimage: 'scikit-image', dotenv: 'python-dotenv',
});

function pkgForImport(name) {
  const top = String(name || '').split('.')[0];
  return IMPORT_TO_PKG[top] || top;
}

// Parse a ModuleNotFoundError out of stderr. Returns { module, pkg } or null.
function missingModule(stderr) {
  if (!stderr) return null;
  const m = stderr.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/);
  if (!m) return null;
  const mod = m[1].split('.')[0];
  return { module: mod, pkg: pkgForImport(mod) };
}

const DETECT_SCRIPT = `import json, sys, os
from importlib.util import find_spec
try:
    from importlib.metadata import version
except Exception:
    version = lambda *_: None
LIBS = ${JSON.stringify(KNOWN_LIBS)}
_base = getattr(sys, "base_prefix", sys.prefix)
_venv = sys.prefix != _base or bool(os.environ.get("VIRTUAL_ENV"))
out = {
    "python": sys.version.split()[0],
    "executable": sys.executable,
    "prefix": sys.prefix,
    "base_prefix": _base,
    "is_venv": _venv,
    "env_name": os.path.basename(sys.prefix) if _venv else None,
    "conda": bool(os.environ.get("CONDA_PREFIX")),
    "libs": [],
}
for imp, dist, cat in LIBS:
    installed = False
    try:
        installed = find_spec(imp) is not None
    except Exception:
        installed = False
    ver = None
    if installed:
        try:
            ver = version(dist)
        except Exception:
            ver = None
    out["libs"].append({"name": imp, "dist": dist, "category": cat, "installed": installed, "version": ver})
print(json.dumps(out))
`;

// Detect the interpreter version + which known libraries are importable. Resolves
// with { python, executable, libs:[{name,dist,category,installed,version}] } or an
// { error } object if the interpreter could not be probed.
function detectEnvironment({ pythonPath }) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let proc;
    try {
      proc = spawn(pythonPath, ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ error: `Failed to launch ${pythonPath}: ${e.message}`, libs: [] });
      return;
    }
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => resolve({ error: `Failed to launch ${pythonPath}: ${e.message}`, libs: [] }));
    proc.on('exit', () => {
      try { resolve(JSON.parse(out.trim())); }
      catch (_) { resolve({ error: (err || 'Could not parse environment probe').trim().slice(0, 300), libs: [] }); }
    });
    try { proc.stdin.write(DETECT_SCRIPT); proc.stdin.end(); } catch (_) { /* ignore */ }
  });
}

// Discover candidate interpreters the user might want to point GARM at: the active
// VIRTUAL_ENV/CONDA_PREFIX, any venv folder in or above the workspace (.venv/venv/env),
// and python3/python on PATH. Returns [{ path, label, version, kind }] for the ones that
// exist and run. `kind` is 'venv' | 'conda' | 'system'.
function discoverInterpreters(workspaceDir) {
  const found = new Map(); // path -> {kind, hint}
  const add = (p, kind) => { if (p && !found.has(p)) found.set(p, { kind }); };
  const venvPython = (dir) => venvInterpreter(dir);

  if (process.env.VIRTUAL_ENV) add(venvPython(process.env.VIRTUAL_ENV), 'venv');
  if (process.env.CONDA_PREFIX) add(venvPython(process.env.CONDA_PREFIX), 'conda');

  // Walk up from the workspace looking for common venv directory names.
  let dir = workspaceDir;
  for (let i = 0; i < 4 && dir; i++) {
    for (const name of ['.venv', 'venv', 'env', '.env']) add(venvPython(path.join(dir, name)), 'venv');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // System interpreters on PATH.
  for (const cmd of ['python3', 'python']) {
    try {
      const r = spawnSyncSafe(cmd, ['-c', 'import sys; print(sys.executable)']);
      if (r) add(r, 'system');
    } catch (_) { /* ignore */ }
  }

  const out = [];
  for (const [p, meta] of found) {
    if (!fs.existsSync(p)) continue;
    let version = null;
    try {
      const r = spawnSyncSafe(p, ['-c', 'import sys;print(sys.version.split()[0])']);
      if (r) version = r;
    } catch (_) { /* not runnable */ }
    if (version === null) continue; // only list interpreters that actually run
    out.push({ path: p, version, kind: meta.kind, label: labelFor(p, meta.kind) });
  }
  return out;
}

// Interpreter path inside a venv/conda prefix: bin/python on POSIX, Scripts\python.exe
// on Windows (conda on Windows puts python.exe at the prefix root, tried as a fallback).
function venvInterpreter(dir) {
  if (process.platform === 'win32') {
    const scripts = path.join(dir, 'Scripts', 'python.exe');
    if (fs.existsSync(scripts)) return scripts;
    return path.join(dir, 'python.exe');
  }
  return path.join(dir, 'bin', 'python');
}

function labelFor(p, kind) {
  if (kind === 'venv') return `venv · ${path.basename(path.dirname(path.dirname(p)))}`;
  if (kind === 'conda') return `conda · ${path.basename(path.dirname(path.dirname(p)))}`;
  return 'system';
}

// Tiny synchronous helper: run a command, return trimmed stdout or null.
function spawnSyncSafe(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 4000 });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return null;
}

// Create a virtual environment at `dir` using `pythonPath`, streaming output. Resolves
// with { ok, python } where python is the new interpreter path.
function createVenv({ pythonPath, dir, onData }) {
  return new Promise((resolve) => {
    const args = ['-m', 'venv', dir];
    onData && onData('stdout', `$ ${pythonPath} ${args.join(' ')}\n`);
    const proc = spawn(pythonPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stdout.on('data', (d) => onData && onData('stdout', d.toString()));
    proc.stderr.on('data', (d) => { err += d.toString(); onData && onData('stderr', d.toString()); });
    proc.on('error', (e) => { onData && onData('stderr', `venv failed: ${e.message}\n`); resolve({ ok: false, error: e.message }); });
    proc.on('exit', (code) => {
      const python = venvInterpreter(dir);
      const ok = code === 0 && fs.existsSync(python);
      if (ok) onData && onData('stdout', `Created venv at ${dir}\n`);
      resolve({ ok, python: ok ? python : null, error: ok ? null : (err.trim() || `exit ${code}`) });
    });
  });
}

// A pip package spec is safe to pass to `pip install` (no leading dash / shell metachars).
function isSafePkgSpec(spec) {
  return /^[A-Za-z0-9][A-Za-z0-9._\-]*(\[[A-Za-z0-9,_\-]+\])?([=<>!~]=?[A-Za-z0-9._*\-]+)?$/.test(String(spec || '').trim());
}

// Install (or upgrade) a package with pip, streaming output. Returns a handle with kill().
function pipInstall({ pythonPath, spec, onData, onExit }) {
  if (!isSafePkgSpec(spec)) {
    onData && onData('stderr', `Refusing to install unsafe package spec: ${spec}\n`);
    onExit && onExit(-1);
    return { kill: () => {} };
  }
  const args = ['-m', 'pip', 'install', '--upgrade', spec];
  onData && onData('stdout', `$ ${pythonPath} ${args.join(' ')}\n`);
  const proc = spawn(pythonPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => onData && onData('stdout', d.toString()));
  proc.stderr.on('data', (d) => onData && onData('stderr', d.toString()));
  proc.on('error', (e) => { onData && onData('stderr', `pip failed to launch: ${e.message}\n`); onExit && onExit(-1); });
  proc.on('exit', (code) => onExit && onExit(code));
  return { kill: () => { try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ } } };
}

module.exports = {
  compileCheck, compileCheckFiles, run, detectEnvironment, pipInstall, missingModule, pkgForImport,
  KNOWN_LIBS, discoverInterpreters, createVenv,
};
