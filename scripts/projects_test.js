'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projects = require('../src/main/projects');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-projects-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-outside-'));

try {
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'main.py'), 'print("Hello")\n# hello again\n', 'utf8');
  fs.writeFileSync(path.join(root, 'pkg', 'tool.py'), 'def hello_world():\n    return "hello"\n', 'utf8');
  fs.writeFileSync(path.join(root, 'image.png'), Buffer.from([0, 1, 2, 3]));

  assert.throws(() => projects.resolveInProject(root, ''), /relative path/i);
  assert.throws(() => projects.resolveInProject(root, '../escape.py'), /escapes/i);
  assert.strictEqual(projects.resolveInProject(root, 'pkg/tool.py'), path.join(root, 'pkg', 'tool.py'));

  const matches = projects.search(root, 'hello');
  assert.strictEqual(matches.length, 4);
  assert(matches.some((m) => m.path === 'main.py' && m.line === 1));
  assert(matches.some((m) => m.path === 'pkg/tool.py'));
  assert.strictEqual(projects.search(root, 'HELLO', { caseSensitive: true }).length, 0);

  const stats = projects.stats(root);
  assert.strictEqual(stats.files, 3);
  assert(stats.lines >= 5);
  assert.strictEqual(stats.languages.py, 2);

  // Regression: a symlink/junction inside the workspace must not turn file IPC into
  // arbitrary access outside the project boundary. Some locked-down Windows hosts do
  // not permit creating links, so only the setup is conditionally skipped.
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside', 'utf8');
  try {
    fs.symlinkSync(outside, path.join(root, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => projects.resolveInProject(root, 'escape-link/secret.txt'), /outside the project/i);
    assert.strictEqual(projects.search(root, 'outside').length, 0);
    assert(!projects.tree(root).some((entry) => entry.name === 'escape-link'));
    assert.strictEqual(projects.stats(root).files, 3);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
  }

  console.log('✓ project boundary, search, and stats checks passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
