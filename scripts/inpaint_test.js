'use strict';

// Deterministic, model-free tests for the inpaint splice logic (src/main/splice.js).
// This is the bug-critical path: replacing a selected region must never corrupt code
// outside the region or produce invalid indentation. We assert exact splices AND
// compile the results with py_compile to prove they are runnable Python.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spliceRegion, regionText, resolveRegion, reindent } = require('../src/main/splice');
const python = require('../src/main/python');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, got === want, 'got:\n' + JSON.stringify(got) + '\nwant:\n' + JSON.stringify(want));
}

const BASE = [
  'def process(items):',          // 1
  '    total = 0',                // 2
  '    for x in items:',          // 3
  '        total += x',           // 4
  '    return total',             // 5
  '',                             // 6
  '',                             // 7
  'if __name__ == "__main__":',   // 8
  '    print(process([1, 2, 3]))',// 9
  '',                             // 10
].join('\n');

console.log('resolveRegion');
// Full-line Monaco selection of lines 3-4 ends at col 1 of line 5 -> excludes line 5.
eq('full-line selection trims trailing col-1 line', JSON.stringify(resolveRegion(10, { startLine: 3, endLine: 5, endColumn: 1 })), JSON.stringify({ startLine: 3, endLine: 4 }));
eq('mid-line end keeps the line', JSON.stringify(resolveRegion(10, { startLine: 3, endLine: 4, endColumn: 9 })), JSON.stringify({ startLine: 3, endLine: 4 }));
eq('reversed selection normalises', JSON.stringify(resolveRegion(10, { startLine: 5, endLine: 3, endColumn: 5 })), JSON.stringify({ startLine: 3, endLine: 5 }));
ok('clamps beyond EOF', resolveRegion(10, { startLine: 99, endLine: 200, endColumn: 1 }).endLine <= 10);

console.log('regionText');
const rt = regionText(BASE, { startLine: 3, endLine: 5, endColumn: 1 });
eq('extracts exactly the selected lines', rt.text, '    for x in items:\n        total += x');

console.log('reindent (the anti-IndentationError step)');
eq('dedented model output is lifted to base indent', reindent('total = sum(items)', '    '), '    total = sum(items)');
eq('relative nesting preserved when reindenting', reindent('if items:\n    total = sum(items)\nelse:\n    total = 0', '    '), '    if items:\n        total = sum(items)\n    else:\n        total = 0');
eq('over-indented model output is normalised', reindent('        total = sum(items)', '    '), '    total = sum(items)');
eq('leading/trailing blank lines are trimmed', reindent('\n\ntotal = 1\n\n', '    '), '    total = 1');
eq('blank interior line becomes empty (no trailing ws)', reindent('a = 1\n\nb = 2', ''), 'a = 1\n\nb = 2');

console.log('spliceRegion — region replaced, everything else byte-identical');
const spliced = spliceRegion(BASE, { startLine: 3, endLine: 5, endColumn: 1 }, 'total = sum(items)');
eq('splice replaces only the region and reindents', spliced, [
  'def process(items):',
  '    total = 0',
  '    total = sum(items)',
  '    return total',
  '',
  '',
  'if __name__ == "__main__":',
  '    print(process([1, 2, 3]))',
  '',
].join('\n'));

// Code before and after the region must be untouched.
ok('prefix preserved', spliced.startsWith('def process(items):\n    total = 0\n'));
ok('suffix preserved', spliced.includes('\nif __name__ == "__main__":\n    print(process([1, 2, 3]))\n'));

const multi = spliceRegion(BASE, { startLine: 3, endLine: 5, endColumn: 1 }, 'if items:\n    total = sum(items)\nelse:\n    total = 0');
ok('multi-line nested replacement keeps function indentation', multi.includes('    if items:\n        total = sum(items)\n    else:\n        total = 0\n    return total'));

const single = spliceRegion(BASE, { startLine: 2, endLine: 2, endColumn: 16 }, 'total = 100');
ok('single-line replacement', single.includes('def process(items):\n    total = 100\n    for x in items:'));

// CRLF input is normalised, not doubled.
ok('CRLF input handled', spliceRegion('a = 1\r\nb = 2\r\n', { startLine: 2, endLine: 2, endColumn: 6 }, 'b = 3') === 'a = 1\nb = 3\n');

(async () => {
  console.log('py_compile — spliced results are valid Python');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'garm-inpaint-'));
  const cfgPy = 'python3';
  async function compiles(code) {
    const f = path.join(tmp, 't.py');
    fs.writeFileSync(f, code, 'utf8');
    const r = await python.compileCheck({ pythonPath: cfgPy, file: f });
    return r.ok;
  }
  ok('clean splice compiles', await compiles(spliced));
  ok('nested splice compiles', await compiles(multi));
  ok('single-line splice compiles', await compiles(single));
  // A broken snippet must produce code that FAILS to compile — proving the pipeline's
  // compile-gate would catch it and roll back rather than leaving a broken file.
  const broken = spliceRegion(BASE, { startLine: 3, endLine: 5, endColumn: 1 }, 'for x in items  # missing colon\n    total += x');
  ok('broken snippet is detectable by compile-gate (would trigger rollback)', !(await compiles(broken)));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
