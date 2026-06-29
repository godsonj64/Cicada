'use strict';

// Deterministic, model-free tests for the multi-file ("repo") generation core:
//   - src/main/llm.js   extractFiles / pickEntry / looksLikePath / extractFilesStreaming
//   - src/main/python.js compileCheckFiles
// This is the bug-critical path: parsing the model's multi-file answer into real files
// must place each file at a SAFE path, never write a placeholder/truncated stub, and pick
// a sane entry point. We assert exact parses AND py_compile a generated repo to prove it
// is runnable Python.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extractFiles, extractFilesStreaming, pickEntry, looksLikePath,
} = require('../src/main/llm');
const python = require('../src/main/python');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
    'got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want));
}

// ---- looksLikePath -----------------------------------------------------------
console.log('looksLikePath');
eq('plain file', looksLikePath('main.py'), 'main.py');
eq('nested file', looksLikePath('models/net.py'), 'models/net.py');
eq('dunder init', looksLikePath('pkg/__init__.py'), 'pkg/__init__.py');
eq('strips heading hashes', looksLikePath('### models/net.py'), 'models/net.py');
eq('strips file: label', looksLikePath('# file: utils/io.py'), 'utils/io.py');
eq('strips backticks + colon', looksLikePath('`requirements.txt`:'), 'requirements.txt');
eq('rejects absolute', looksLikePath('/etc/passwd'), null);
eq('rejects traversal', looksLikePath('../secret.py'), null);
eq('rejects bare dir (no ext)', looksLikePath('models'), null);
eq('rejects prose', looksLikePath('the main program does X'), null);
eq('rejects windows absolute', looksLikePath('C:\\x\\y.py'), null);

// ---- extractFiles ------------------------------------------------------------
console.log('extractFiles');

const CANON = [
  'Here is the project.',
  '',
  '### main.py',
  '```python',
  'from models.net import Net',
  'if __name__ == "__main__":',
  '    print(Net().name)',
  '```',
  '',
  '### models/__init__.py',
  '```python',
  '```',                                  // empty __init__ — intentional package marker, kept
  '',
  '### models/net.py',
  '```python',
  'class Net:',
  '    name = "net"',
  '```',
].join('\n');
eq('canonical headings parse to files', extractFiles(CANON).map((f) => f.path),
  ['main.py', 'models/__init__.py', 'models/net.py']);
ok('canonical body preserved', extractFiles(CANON)[0].content === 'from models.net import Net\nif __name__ == "__main__":\n    print(Net().name)');
eq('empty __init__.py kept as empty file',
  extractFiles('### pkg/__init__.py\n```python\n```\n### pkg/m.py\n```python\nx=1\n```'),
  [{ path: 'pkg/__init__.py', content: '' }, { path: 'pkg/m.py', content: 'x=1' }]);

eq('fence-info path label',
  extractFiles('```python path=app/server.py\nprint(1)\n```').map((f) => f.path), ['app/server.py']);

eq('hash-comment label',
  extractFiles('# file: utils/io.py\n```python\nx = 1\n```').map((f) => f.path), ['utils/io.py']);

eq('single unlabeled block becomes main.py',
  extractFiles('```python\nprint("hi")\n```').map((f) => f.path), ['main.py']);

eq('reasoning is stripped (example fence inside think ignored)',
  extractFiles('<think>maybe ```python\nimport os\n``` no</think>\n### main.py\n```python\nprint(1)\n```')
    .map((f) => f.path), ['main.py']);

// A truncated trailing file (unclosed fence) is dropped, exactly like single-file.
eq('truncated trailing file dropped',
  extractFiles('### a.py\n```python\nx=1\n```\n### b.py\n```python\ny=2  # cut off here')
    .map((f) => f.path), ['a.py']);

// Placeholder-only Python (comment only) must never be written as a stub.
eq('placeholder-only py skipped',
  extractFiles('### a.py\n```python\n# TODO\n```\n### b.py\n```python\nz=3\n```')
    .map((f) => f.path), ['b.py']);

// Duplicate path: last occurrence wins (mirrors single-file "last fence wins").
const DUP = '### a.py\n```python\nold=1\n```\n### a.py\n```python\nnew=2\n```';
eq('duplicate path keeps last', extractFiles(DUP), [{ path: 'a.py', content: 'new=2' }]);

// Unsafe paths among many blocks are dropped (can't be placed safely).
eq('unsafe path dropped among many',
  extractFiles('### ../evil.py\n```python\nbad=1\n```\n### ok.py\n```python\ngood=1\n```')
    .map((f) => f.path), ['ok.py']);

// Non-Python files (requirements.txt, README) are kept.
eq('non-py files kept',
  extractFiles('### requirements.txt\n```\nnumpy\n```\n### main.py\n```python\nimport numpy\n```')
    .map((f) => f.path), ['requirements.txt', 'main.py']);

// ---- pickEntry ---------------------------------------------------------------
console.log('pickEntry');
eq('root main.py wins', pickEntry([{ path: 'models/net.py', content: 'x' }, { path: 'main.py', content: 'y' }]), 'main.py');
eq('__main__ guard wins when no main.py',
  pickEntry([{ path: 'pkg/a.py', content: 'a=1' }, { path: 'run_me.py', content: 'if __name__ == "__main__":\n  pass' }]),
  'run_me.py');
eq('conventional name fallback',
  pickEntry([{ path: 'lib/x.py', content: 'x' }, { path: 'app.py', content: 'y' }]), 'app.py');
eq('shallowest py fallback',
  pickEntry([{ path: 'deep/dir/z.py', content: 'z' }, { path: 'top.py', content: 't' }]), 'top.py');

// ---- extractFilesStreaming ---------------------------------------------------
console.log('extractFilesStreaming');
const MIDSTREAM = '### main.py\n```python\nimport sys\nprint("hi")\n```\n\n### models/net.py\n```python\nclass Net:';
ok('streaming preview banners both files',
  /# ===== main\.py =====/.test(extractFilesStreaming(MIDSTREAM)) &&
  /# ===== models\/net\.py =====/.test(extractFilesStreaming(MIDSTREAM)));
ok('streaming preview keeps in-progress code',
  /class Net:/.test(extractFilesStreaming(MIDSTREAM)));
ok('streaming preview hides fence markers', extractFilesStreaming(MIDSTREAM).indexOf('```') === -1);
ok('streaming preview empty while still thinking',
  extractFilesStreaming('<think>planning the files') === '');

// ---- compileCheckFiles (real py_compile) -------------------------------------
console.log('compileCheckFiles');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garm-repo-'));
  const { pythonPath } = require('../src/main/config').load();
  const write = (rel, src) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, src, 'utf8');
    return abs;
  };
  // A small but real multi-file project with absolute imports.
  const good = [
    write('models/__init__.py', ''),
    write('models/net.py', 'class Net:\n    def name(self):\n        return "net"\n'),
    write('main.py', 'from models.net import Net\n\nif __name__ == "__main__":\n    print(Net().name())\n'),
  ];
  const goodRes = await python.compileCheckFiles({ pythonPath, files: good });
  ok('valid repo compiles clean', goodRes.ok, goodRes.output);

  // Run it through the harness-equivalent to prove the imports actually resolve.
  const runRes = await new Promise((resolve) => {
    let out = '';
    python.run({
      pythonPath, file: path.join(dir, 'main.py'), cwd: dir, render: false,
      onData: (_s, t) => { out += t; },
      onExit: (code) => resolve({ code, out }),
    });
  });
  ok('valid repo runs (absolute imports resolve)', runRes.code === 0 && /net/.test(runRes.out), 'exit ' + runRes.code + ': ' + runRes.out);

  const broken = [write('models/bad.py', 'def oops(\n    return 1\n'), path.join(dir, 'main.py')];
  const badRes = await python.compileCheckFiles({ pythonPath, files: broken });
  ok('broken module fails compile', !badRes.ok && /bad\.py/.test(badRes.output), badRes.output);

  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
