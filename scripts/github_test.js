'use strict';

// Headless checks for the GitHub integration's local (no-network) half:
// requirements scanning, required-file generation, repo-name sanitizing, and the
// init -> commit -> status loop against a throwaway directory. Needs git, no model.

const fs = require('fs');
const os = require('os');
const path = require('path');
const github = require('../src/main/github');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || !detail ? '' : '  — ' + detail));
  if (!cond) failures++;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-gh-'));
  fs.writeFileSync(path.join(dir, 'main.py'), [
    'import os, sys',
    'import numpy as np',
    'from sklearn.linear_model import LinearRegression',
    'import matplotlib.pyplot as plt',
    'from utils.helpers import go',
    '',
    'print("hi")',
  ].join('\n'), 'utf8');
  fs.mkdirSync(path.join(dir, 'utils'));
  fs.writeFileSync(path.join(dir, 'utils', '__init__.py'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'utils', 'helpers.py'), 'import cv2\ndef go():\n    pass\n', 'utf8');

  // Requirements scan: third-party mapped to pip names, stdlib + local modules excluded.
  const reqs = github.scanRequirements(dir);
  check('scan finds numpy', reqs.includes('numpy'));
  check('scan maps sklearn -> scikit-learn', reqs.includes('scikit-learn'));
  check('scan maps cv2 -> opencv-python', reqs.includes('opencv-python'));
  check('scan excludes stdlib', !reqs.includes('os') && !reqs.includes('sys'));
  check('scan excludes local package', !reqs.includes('utils'));

  // File generation: writes the four files, never clobbers an existing one.
  const gen = github.generateFiles(dir, { projectName: 'demo', description: 'A demo.' });
  check('generates .gitignore/README/LICENSE/requirements',
    ['.gitignore', 'README.md', 'LICENSE', 'requirements.txt'].every((f) => gen.written.includes(f)),
    JSON.stringify(gen.written));
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  check('README has name + description', readme.includes('# demo') && readme.includes('A demo.'));
  check('README suggests pip install', readme.includes('pip install -r requirements.txt'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'CUSTOM', 'utf8');
  const gen2 = github.generateFiles(dir, { projectName: 'demo' });
  check('existing files are kept', gen2.skipped.includes('README.md') && fs.readFileSync(path.join(dir, 'README.md'), 'utf8') === 'CUSTOM');

  // Repo names.
  check('repoNameFor sanitizes', github.repoNameFor('My Cool Project!!') === 'My-Cool-Project');
  check('repoNameFor fallback', github.repoNameFor('***') === 'cicada-project');

  // git flow (skipped cleanly when git is missing).
  if (!github.gitVersion()) {
    console.log('SKIP git flow — git not installed');
  } else {
    const st0 = await github.status(dir);
    check('status: not a repo yet', st0.gitInstalled && !st0.isRepo);
    const init = await github.ensureRepo(dir);
    check('ensureRepo initializes', init.ok && init.created);
    const commit = await github.commitAll(dir, 'initial', { name: 'Test', email: 'test@example.com' });
    check('commitAll commits', commit.ok && !commit.nothingToCommit, commit.error);
    const again = await github.commitAll(dir, 'noop');
    check('commitAll detects clean tree', again.ok && again.nothingToCommit === true);
    const st1 = await github.status(dir);
    check('status: repo with commit', st1.isRepo && st1.hasCommits && st1.changeCount === 0,
      JSON.stringify({ isRepo: st1.isRepo, hasCommits: st1.hasCommits, changes: st1.changeCount }));
    check('status: branch main', st1.branch === 'main' || st1.branch === 'master', st1.branch);
  }

  check('webUrl strips .git', github.webUrl('https://github.com/u/r.git') === 'https://github.com/u/r');
  check('webUrl handles ssh', github.webUrl('git@github.com:u/r.git') === 'https://github.com/u/r');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll GitHub checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
