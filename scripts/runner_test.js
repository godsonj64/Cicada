'use strict';

// Tests for how generated programs are executed (src/main/python.js run + helpers), against
// the real interpreter: the behaviours the agent's verification depends on.

const fs = require('fs');
const os = require('os');
const path = require('path');
const python = require('../src/main/python');
const { pythonPath } = require('../src/main/config').load();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-runner-'));
const write = (rel, src) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, src, 'utf8');
  return abs;
};
const run = (file, opts) => new Promise((resolve) => {
  let stdout = '', stderr = '';
  const t0 = Date.now();
  python.run({
    pythonPath, file, cwd: dir, render: true, ...(opts || {}),
    onData: (s, t) => { if (s === 'stderr') stderr += t; else stdout += t; },
    onExit: (code, info) => resolve({ code, stdout, stderr, ms: Date.now() - t0, ...info }),
  });
});
const hasMpl = (() => { try { return require('child_process').spawnSync(pythonPath, ['-c', 'import matplotlib'], { timeout: 20000 }).status === 0; } catch (_) { return false; } })();

(async () => {
  console.log('nested files behave like `python path/to/file.py`');
  write('pkg/helper.py', 'def val():\n    return 42\n');
  write('pkg/tool.py', 'from helper import val\nprint("tool", val())\n');
  let r = await run(path.join(dir, 'pkg', 'tool.py'));
  ok('a nested script can import its siblings', r.code === 0 && /tool 42/.test(r.stdout), r.stderr.trim().split('\n').pop());
  write('models/__init__.py', '');
  write('models/net.py', 'NAME = "net"\n');
  write('scripts/train.py', 'from models.net import NAME\nprint("train", NAME)\n');
  r = await run(path.join(dir, 'scripts', 'train.py'));
  ok('...and still import from the project root', r.code === 0 && /train net/.test(r.stdout), r.stderr.trim().split('\n').pop());

  if (hasMpl) {
    console.log('plots');
    write('pkg/plot.py', 'import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.show()\n');
    r = await run(path.join(dir, 'pkg', 'plot.py'));
    ok('a nested script\'s figure is captured where the IDE looks', r.images.some((p) => path.dirname(p) === dir && /_garm_plot_01\.png$/.test(p)), JSON.stringify(r.images));
    write('figs.py', 'import os\nimport matplotlib.pyplot as plt\nos.makedirs("outputs", exist_ok=True)\nplt.plot([3, 1])\nplt.savefig("outputs/curve.png")\n');
    r = await run(path.join(dir, 'figs.py'));
    ok('images written to a subfolder are found', r.images.some((p) => /outputs[\\/]curve\.png$/.test(p)), JSON.stringify(r.images));
    // Headless matplotlib ignores Figure.show(), and a figure that is never shown at all was
    // simply lost — both are the program's output and must reach the Render panel.
    write('figshow.py', 'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1, 2])\nfig.show()\n');
    r = await run(path.join(dir, 'figshow.py'));
    ok('a figure shown with fig.show() is captured', r.images.some((p) => /_garm_plot_01\.png$/.test(p)), JSON.stringify(r.images));
    write('noshow.py', 'import sys\nimport matplotlib.pyplot as plt\nplt.plot([3, 2, 1])\nsys.exit(3)\n');
    r = await run(path.join(dir, 'noshow.py'));
    ok('a figure never shown is captured at exit (even via sys.exit)', r.images.some((p) => /_garm_plot_01\.png$/.test(p)), JSON.stringify(r.images));
    ok('...and the exit code is preserved', r.code === 3, 'code=' + r.code);
  } else {
    console.log('plots — SKIP (matplotlib not installed)');
  }

  console.log('verification runs');
  write('ask.py', 'name = input("name? ")\nprint("hi", name)\n');
  r = await run(path.join(dir, 'ask.py'), { stdin: 'eof', timeoutMs: 60000 });
  ok('input() with no keyboard fails at once instead of hanging', r.code !== 0 && /EOFError/.test(r.stderr) && r.ms < 10000, `code=${r.code} ms=${r.ms}`);
  ok('...and is not reported as a timeout', r.timedOut === false);
  write('cli.py', 'import argparse\np = argparse.ArgumentParser()\np.add_argument("--input", required=True)\np.parse_args()\n');
  r = await run(path.join(dir, 'cli.py'), { stdin: 'eof' });
  ok('an argparse usage error exits non-zero (so the pipeline treats it as a failure)', r.code === 2, 'code=' + r.code);
  write('hang.py', 'import time\ntime.sleep(30)\n');
  r = await run(path.join(dir, 'hang.py'), { stdin: 'eof', timeoutMs: 1500 });
  ok('a silent, idle program is stopped and flagged as timed out', r.timedOut === true && r.code !== 0, `code=${r.code} timedOut=${r.timedOut}`);

  console.log('missing modules');
  ok('common packages are on the auto-install allowlist', python.autoInstallPkg('sklearn') === 'scikit-learn' && python.autoInstallPkg('PIL') === 'Pillow');
  ok('unknown names are never auto-installed', python.autoInstallPkg('sine_utils') === null && python.autoInstallPkg('utils') === null);
  ok('heavy frameworks wait for the user', python.autoInstallPkg('torch') === null && python.isKnownPackage('torch'));
  ok('submodule imports map to their top-level package', python.autoInstallPkg('matplotlib.pyplot') === 'matplotlib');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
