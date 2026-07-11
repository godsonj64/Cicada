'use strict';

// Dependency Doctor: one click from "my imports" to "a working environment".
//
// Scans every .py file in the project for imports, maps import names to their PyPI
// distributions (cv2 -> opencv-python, sklearn -> scikit-learn, …), asks the user's
// own interpreter which of them are actually importable (importlib.util.find_spec —
// nothing is imported or executed), and reports what's missing so the UI can offer
// one-click installs and generate an accurate requirements.txt. Everything runs
// locally against the configured interpreter; no network beyond pip itself.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHECK_TIMEOUT_MS = 30000;
const MAX_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024;

// Directories never scanned (vendored/derived content, not project source).
const SKIP_DIRS = new Set(['__pycache__', '.git', '.garm', 'node_modules', '.venv', 'venv', 'env', 'data', 'dist', 'build', 'out', '.idea', '.vscode']);

// Python standard library (3.8+ superset) — imports of these are never "missing".
const STDLIB = new Set([
  'abc', 'aifc', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'audioop', 'base64', 'bdb',
  'binascii', 'bisect', 'builtins', 'bz2', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd',
  'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall', 'concurrent', 'configparser',
  'contextlib', 'contextvars', 'copy', 'copyreg', 'cProfile', 'crypt', 'csv', 'ctypes', 'curses',
  'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'doctest', 'email', 'encodings',
  'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch',
  'fractions', 'ftplib', 'functools', 'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib',
  'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'imghdr',
  'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache',
  'locale', 'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap',
  'modulefinder', 'multiprocessing', 'netrc', 'nis', 'nntplib', 'ntpath', 'numbers', 'operator',
  'optparse', 'os', 'ossaudiodev', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil',
  'platform', 'plistlib', 'poplib', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd',
  'py_compile', 'pyclbr', 'pydoc', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib',
  'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex',
  'shutil', 'signal', 'site', 'smtplib', 'sndhdr', 'socket', 'socketserver', 'sqlite3', 'ssl',
  'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'sunau', 'symtable', 'sys',
  'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'test',
  'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace',
  'traceback', 'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing', 'unicodedata',
  'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser',
  'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport',
  'zlib', 'zoneinfo', '__future__',
]);

// import name -> PyPI distribution, where they differ (or where capitalisation matters).
// Anything not listed installs under its own import name.
const IMPORT_TO_PIP = {
  cv2: 'opencv-python',
  sklearn: 'scikit-learn',
  skimage: 'scikit-image',
  PIL: 'pillow',
  yaml: 'pyyaml',
  bs4: 'beautifulsoup4',
  dotenv: 'python-dotenv',
  dateutil: 'python-dateutil',
  Crypto: 'pycryptodome',
  fitz: 'pymupdf',
  docx: 'python-docx',
  pptx: 'python-pptx',
  serial: 'pyserial',
  usb: 'pyusb',
  websocket: 'websocket-client',
  OpenGL: 'pyopengl',
  Bio: 'biopython',
  jwt: 'pyjwt',
  git: 'gitpython',
  magic: 'python-magic',
  cairosvg: 'CairoSVG',
  mpl_toolkits: 'matplotlib',
  pylab: 'matplotlib',
  IPython: 'ipython',
  wx: 'wxPython',
  PyQt5: 'PyQt5',
  PyQt6: 'PyQt6',
  PySide6: 'PySide6',
  kaggle: 'kaggle',
  gym: 'gymnasium',
  tensorflow_datasets: 'tensorflow-datasets',
  sentence_transformers: 'sentence-transformers',
  huggingface_hub: 'huggingface-hub',
  google: 'google-api-python-client',
};

/**
 * Extract top-level imported module names from Python source. Handles `import a, b as c`,
 * `from x.y import z`, and indented (conditional / function-local) imports. Relative
 * imports (`from . import x`) and the project's own modules are the caller's problem —
 * this only reports names; scan() filters local modules out.
 */
function extractImports(source) {
  const found = new Set();
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    // Strip trailing comments BEFORE parsing — `import torch  # heavy, optional`
    // must yield just `torch`, and the comment text must never leak into the split.
    const line = rawLine.trim().replace(/#.*$/, '').trim();
    // `import a.b.c as d, e.f` — every comma-separated target's ROOT module counts.
    let m = /^import\s+(.+)$/.exec(line);
    if (m && !line.startsWith('import(')) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/i)[0].trim().split('.')[0];
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) found.add(name);
      }
      continue;
    }
    // `from x.y import z` — the ROOT of x.y counts; skip relative (`from .`).
    m = /^from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+/.exec(line);
    if (m) {
      const name = m[1].split('.')[0];
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) found.add(name);
    }
  }
  return Array.from(found);
}

// PyPI distribution for an import name.
function pipNameFor(importName) {
  return IMPORT_TO_PIP[importName] || importName;
}

/**
 * Walk the workspace and collect third-party imports across all .py files.
 * Returns [{ module, pip, files: [rel, …] }] sorted by module. The project's own
 * modules (a sibling x.py or x/ package for import x) and stdlib names are excluded.
 */
function scan(workspaceDir) {
  const usage = new Map(); // module -> Set(relPath)
  const localNames = new Set(); // project-local modules/packages, never "dependencies"
  let fileCount = 0;

  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (fileCount >= MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        localNames.add(e.name); // a package directory satisfies `import <dirname>`
        walk(abs, r);
        continue;
      }
      if (!e.name.endsWith('.py')) continue;
      localNames.add(e.name.slice(0, -3));
      let st; try { st = fs.statSync(abs); } catch (_) { continue; }
      if (st.size > MAX_FILE_BYTES) continue;
      let src; try { src = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
      fileCount += 1;
      for (const mod of extractImports(src)) {
        if (!usage.has(mod)) usage.set(mod, new Set());
        usage.get(mod).add(r);
      }
    }
  };
  walk(workspaceDir, '');

  const out = [];
  for (const [mod, files] of usage) {
    if (STDLIB.has(mod) || localNames.has(mod)) continue;
    out.push({ module: mod, pip: pipNameFor(mod), files: Array.from(files).sort() });
  }
  return out.sort((a, b) => a.module.localeCompare(b.module));
}

// Python one-liner: for each argv module report importability + installed version as JSON.
// find_spec only LOCATES modules — project code is never imported or executed.
const CHECK_SCRIPT = [
  'import sys, json',
  'import importlib.util as u',
  'try:',
  '    from importlib.metadata import version as _v',
  'except Exception:',
  '    _v = None',
  'out = {}',
  'for name in sys.argv[1:]:',
  '    try:',
  '        found = u.find_spec(name) is not None',
  '    except Exception:',
  '        found = False',
  '    ver = None',
  '    if found and _v is not None:',
  '        try:',
  '            ver = _v(name)',
  '        except Exception:',
  '            ver = None',
  '    out[name] = {"installed": found, "version": ver}',
  'sys.stdout.write(json.dumps(out))',
].join('\n');

/**
 * Ask the interpreter which modules are importable. Resolves with
 * { ok, results: { module: { installed, version } } } — never rejects.
 */
function checkInstalled(pythonPath, modules) {
  return new Promise((resolve) => {
    const mods = (modules || []).filter((m) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(m));
    if (!mods.length) { resolve({ ok: true, results: {} }); return; }
    let out = '', err = '', settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    let proc;
    try {
      proc = spawn(pythonPath, ['-', ...mods], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      finish({ ok: false, error: 'Could not launch Python: ' + e.message, results: {} });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
      finish({ ok: false, error: 'Import check timed out.', results: {} });
    }, CHECK_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message, results: {} }); });
    proc.on('exit', () => {
      clearTimeout(timer);
      try { finish({ ok: true, results: JSON.parse(out.trim()) }); }
      catch (_) { finish({ ok: false, error: (err || 'Import check failed.').trim().slice(0, 300), results: {} }); }
    });
    try { proc.stdin.write(CHECK_SCRIPT); proc.stdin.end(); } catch (_) { /* ignore */ }
  });
}

/**
 * Full diagnosis: scan + check. Resolves with
 * { ok, deps: [{ module, pip, files, installed, version }], missing: [pip…], error? }.
 */
async function diagnose(workspaceDir, pythonPath) {
  const deps = scan(workspaceDir);
  const check = await checkInstalled(pythonPath, deps.map((d) => d.module));
  for (const d of deps) {
    const r = check.results[d.module];
    d.installed = r ? !!r.installed : null; // null = unknown (probe failed)
    d.version = r && r.version ? String(r.version) : null;
  }
  const missing = deps.filter((d) => d.installed === false).map((d) => d.pip);
  return { ok: check.ok, error: check.error || null, deps, missing: Array.from(new Set(missing)) };
}

/**
 * requirements.txt content from a diagnosis: installed packages pinned to their
 * detected version, missing ones unpinned (they'll resolve to latest on install).
 */
function requirementsText(deps) {
  const lines = [];
  const seen = new Set();
  for (const d of deps || []) {
    if (seen.has(d.pip)) continue;
    seen.add(d.pip);
    lines.push(d.version ? d.pip + '==' + d.version : d.pip);
  }
  return lines.sort((a, b) => a.localeCompare(b)).join('\n') + (lines.length ? '\n' : '');
}

module.exports = { extractImports, pipNameFor, scan, checkInstalled, diagnose, requirementsText, STDLIB, IMPORT_TO_PIP };
