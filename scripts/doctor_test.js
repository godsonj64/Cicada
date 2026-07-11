'use strict';

// Headless checks for the dependency doctor: import extraction, PyPI mapping,
// workspace scanning (stdlib + local-module filtering) and requirements generation.
// The live interpreter probe (checkInstalled) is exercised only when a python is
// reachable; its absence must degrade gracefully, which is also asserted.

const fs = require('fs');
const os = require('os');
const path = require('path');
const doctor = require('../src/main/doctor');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || !detail ? '' : '  — ' + detail));
  if (!cond) failures += 1;
}

// ---- extractImports ------------------------------------------------------------

let mods = doctor.extractImports([
  'import numpy as np',
  'import os, sys',
  'from sklearn.model_selection import train_test_split',
  'from . import local_thing',
  'from .relative import x',
  '    import torch  # conditional, indented',
  'import pandas.io.json',
  '# import commented_out',
  'x = "import not_code"',
].join('\n'));
check('plain import', mods.includes('numpy'));
check('multi import', mods.includes('os') && mods.includes('sys'));
check('from x.y import', mods.includes('sklearn'));
check('relative import skipped', !mods.includes('') && !mods.some((m) => m.startsWith('.')));
check('indented import found', mods.includes('torch'));
check('dotted root only', mods.includes('pandas') && !mods.includes('pandas.io'));
check('comment line ignored', !mods.includes('commented_out'));
check('string literal ignored', !mods.includes('not_code'));

// ---- mapping -------------------------------------------------------------------

check('cv2 -> opencv-python', doctor.pipNameFor('cv2') === 'opencv-python');
check('sklearn -> scikit-learn', doctor.pipNameFor('sklearn') === 'scikit-learn');
check('PIL -> pillow', doctor.pipNameFor('PIL') === 'pillow');
check('yaml -> pyyaml', doctor.pipNameFor('yaml') === 'pyyaml');
check('unknown maps to itself', doctor.pipNameFor('somelib') === 'somelib');

// ---- scan (stdlib + local filtering) ---------------------------------------------

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-doc-'));
fs.mkdirSync(path.join(ws, 'utils'), { recursive: true });
fs.mkdirSync(path.join(ws, '.venv', 'lib'), { recursive: true }); // must be skipped
fs.writeFileSync(path.join(ws, 'main.py'), 'import os\nimport numpy as np\nimport helpers\nfrom utils.plotting import plot\nimport cv2\n', 'utf8');
fs.writeFileSync(path.join(ws, 'helpers.py'), 'import json\nimport requests\n', 'utf8');
fs.writeFileSync(path.join(ws, 'utils', 'plotting.py'), 'import matplotlib.pyplot as plt\n', 'utf8');
fs.writeFileSync(path.join(ws, '.venv', 'lib', 'junk.py'), 'import should_not_appear\n', 'utf8');

const deps = doctor.scan(ws);
const names = deps.map((d) => d.module);
check('third-party found', names.includes('numpy') && names.includes('requests') && names.includes('matplotlib'));
check('stdlib excluded', !names.includes('os') && !names.includes('json'));
check('local module excluded', !names.includes('helpers'));
check('local package excluded', !names.includes('utils'));
check('venv dir skipped', !names.includes('should_not_appear'));
check('pip name mapped in scan', deps.find((d) => d.module === 'cv2').pip === 'opencv-python');
check('usage files recorded', deps.find((d) => d.module === 'numpy').files.includes('main.py'));

// ---- requirementsText ------------------------------------------------------------

const reqs = doctor.requirementsText([
  { pip: 'numpy', version: '1.26.0' },
  { pip: 'requests', version: null },
  { pip: 'numpy', version: '1.26.0' }, // duplicate collapses
]);
check('pins installed versions', /numpy==1\.26\.0/.test(reqs));
check('missing stays unpinned', /^requests$/m.test(reqs));
check('duplicates collapse', (reqs.match(/numpy/g) || []).length === 1);
check('sorted + trailing newline', reqs === 'numpy==1.26.0\nrequests\n', JSON.stringify(reqs));
check('empty deps -> empty text', doctor.requirementsText([]) === '');

// ---- checkInstalled degradation ----------------------------------------------------

(async () => {
  // A bogus interpreter path must resolve (never reject / never hang).
  const bad = await doctor.checkInstalled('definitely-not-a-python-xyz', ['numpy']);
  check('bad interpreter resolves ok:false', bad.ok === false && typeof bad.results === 'object');

  const none = await doctor.checkInstalled('python', []);
  check('empty module list short-circuits', none.ok === true && Object.keys(none.results).length === 0);

  fs.rmSync(ws, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll doctor checks passed.');
  process.exit(failures ? 1 : 0);
})();
