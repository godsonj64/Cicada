'use strict';

// Tests for environment/library support: ModuleNotFoundError parsing, import->pip
// package mapping, the install-spec safety guard, and a real probe of the configured
// interpreter (so we confirm detection actually sees the installed ML stack).

const configMod = require('../src/main/config');
const python = require('../src/main/python');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

console.log('missingModule — parse ModuleNotFoundError and map to a pip package');
ok('detects torch', JSON.stringify(python.missingModule("ModuleNotFoundError: No module named 'torch'")) === JSON.stringify({ module: 'torch', pkg: 'torch' }));
ok('maps cv2 -> opencv-python', python.missingModule("ModuleNotFoundError: No module named 'cv2'").pkg === 'opencv-python');
ok('maps sklearn -> scikit-learn', python.missingModule("ModuleNotFoundError: No module named 'sklearn'").pkg === 'scikit-learn');
ok('maps PIL -> Pillow', python.missingModule("ModuleNotFoundError: No module named 'PIL'").pkg === 'Pillow');
ok('uses top-level package for submodule misses', python.missingModule("ModuleNotFoundError: No module named 'tensorflow.keras'").module === 'tensorflow');
ok('unknown module falls back to its own name', python.missingModule("ModuleNotFoundError: No module named 'fancylib'").pkg === 'fancylib');
ok('no false positive on a normal traceback', python.missingModule("ValueError: bad input") === null);

console.log('pkgForImport');
ok('tensorflow -> tensorflow', python.pkgForImport('tensorflow') === 'tensorflow');
ok('bs4 -> beautifulsoup4', python.pkgForImport('bs4') === 'beautifulsoup4');

console.log('KNOWN_LIBS covers the frontier frameworks the user asked about');
const names = python.KNOWN_LIBS.map((l) => l[0]);
['torch', 'tensorflow', 'jax', 'keras', 'transformers', 'sklearn', 'pandas', 'numpy', 'matplotlib'].forEach(function (n) {
  ok('lists ' + n, names.indexOf(n) >= 0);
});

(async () => {
  console.log('detectEnvironment — real probe of the configured interpreter');
  const cfg = configMod.load();
  const env = await python.detectEnvironment({ pythonPath: cfg.pythonPath });
  ok('probe returned a python version', !!env.python, JSON.stringify(env).slice(0, 200));
  ok('probe returned the library list', Array.isArray(env.libs) && env.libs.length > 0);
  const installed = (env.libs || []).filter((l) => l.installed).map((l) => l.name);
  console.log('     installed here: ' + (installed.join(', ') || '(none)'));
  ok('every lib entry has name/dist/category/installed fields',
    (env.libs || []).every((l) => l.name && l.dist && l.category && typeof l.installed === 'boolean'));

  // Detection must NOT crash on a bogus interpreter — it returns an { error } object.
  const bad = await python.detectEnvironment({ pythonPath: '/nonexistent/python-xyz' });
  ok('bogus interpreter yields an error object, not a throw', !!bad.error && Array.isArray(bad.libs));

  console.log('virtual environments — discover / create / isolate');
  const found = python.discoverInterpreters(cfg.workspaceDir);
  ok('discoverInterpreters finds at least the system python', Array.isArray(found) && found.length >= 1);
  ok('discovered entries carry path/version/kind/label', found.every((f) => f.path && f.version && f.kind && f.label));

  const fs = require('fs'); const os = require('os'); const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garm-venv-'));
  const venvDir = path.join(root, '.venv');
  const created = await python.createVenv({ pythonPath: cfg.pythonPath, dir: venvDir, onData: () => {} });
  ok('createVenv succeeds', created.ok && created.python);
  if (created.ok) {
    const venvEnv = await python.detectEnvironment({ pythonPath: created.python });
    ok('a created venv is reported as a venv', venvEnv.is_venv === true);
    ok('the venv is isolated (no system libraries leak in)',
      (venvEnv.libs || []).filter((l) => l.installed).length === 0);
    ok('a fresh system probe is NOT flagged as a venv', env.is_venv === false || env.is_venv === undefined);
    // The workspace .venv should now be discoverable from that workspace root.
    const found2 = python.discoverInterpreters(root);
    ok('a workspace .venv becomes discoverable', found2.some((f) => f.path === created.python && f.kind === 'venv'));
  }
  fs.rmSync(root, { recursive: true, force: true });

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
