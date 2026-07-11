'use strict';

// Headless checks for dataset insights. The pure-Node engine (CSV parsing, Pearson
// correlation, histograms, quality flags) is tested exactly; the Python/pandas path
// is exercised through compute()'s fallback contract using a bogus interpreter, so
// the test passes on machines with or without pandas installed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ins = require('../src/main/insights');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || !detail ? '' : '  — ' + detail));
  if (!cond) failures += 1;
}

// ---- splitCsvLine -----------------------------------------------------------

let r = ins.splitCsvLine('a,b,c', ',');
check('simple split', r.length === 3 && r[2] === 'c');
r = ins.splitCsvLine('"x,y",2,"he said ""hi"""', ',');
check('quoted separator + doubled quotes', r[0] === 'x,y' && r[2] === 'he said "hi"', JSON.stringify(r));
r = ins.splitCsvLine('1\t2\t3', '\t');
check('tsv split', r.length === 3);

// ---- pearson ------------------------------------------------------------------

check('perfect positive corr', Math.abs(ins.pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
check('perfect negative corr', Math.abs(ins.pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-9);
check('constant column -> null', ins.pearson([1, 1, 1, 1], [1, 2, 3, 4]) === null);
check('too few points -> null', ins.pearson([1, 2], [3, 4]) === null);

// ---- histogram ------------------------------------------------------------------

const h = ins.histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0, 9, 10);
check('histogram bins sum to n', h.reduce((a, b) => a + b, 0) === 10);
check('histogram edge value in last bin', h[9] === 1);
check('degenerate range single bin', ins.histogram([5, 5, 5], 5, 5, 10)[0] === 3);

// ---- analyzeCsvNode ---------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-ins-'));
const csvPath = path.join(dir, 't.csv');
// y = 2x (perfect corr), z constant, w half-missing, label non-numeric.
const rows = ['x,y,z,w,label'];
for (let i = 1; i <= 40; i++) {
  rows.push([i, i * 2, 7, i <= 20 ? '' : i, 'c' + (i % 3)].join(','));
}
// one duplicate row
rows.push(rows[1]);
fs.writeFileSync(csvPath, rows.join('\n') + '\n', 'utf8');

const res = ins.analyzeCsvNode(csvPath);
check('node engine ok', res.ok === true && res.engine === 'node');
check('row count', res.rows === 41, String(res.rows));
const names = res.columns.map((c) => c.name);
check('numeric columns detected', names.includes('x') && names.includes('y'));
check('non-numeric excluded', !names.includes('label'));
const xCol = res.columns.find((c) => c.name === 'x');
check('mean sane', Math.abs(xCol.mean - 20.02) < 0.5, String(xCol.mean));
check('hist has bins', xCol.hist.length === ins.HIST_BINS);
const xy = res.correlations.find((c) => (c.a === 'x' && c.b === 'y') || (c.a === 'y' && c.b === 'x'));
check('x~y correlation ≈ 1', xy && Math.abs(xy.r - 1) < 1e-6, JSON.stringify(res.correlations[0]));
check('duplicate flagged', res.flags.some((f) => /duplicate/.test(f)), JSON.stringify(res.flags));
check('constant column flagged', res.flags.some((f) => /'z' is constant/.test(f)));
check("missing column flagged", res.flags.some((f) => /'w' is \d+% missing/.test(f)));

check('empty file -> clean error', ins.analyzeCsvNode(path.join(dir, 'missing.csv')).ok === false);
fs.writeFileSync(path.join(dir, 'empty.csv'), 'a,b\n', 'utf8');
check('header-only -> clean error', ins.analyzeCsvNode(path.join(dir, 'empty.csv')).ok === false);

// ---- compute() fallback contract ----------------------------------------------------

(async () => {
  // Bogus interpreter: CSV must still succeed via the Node engine.
  const viaFallback = await ins.compute('definitely-not-a-python-xyz', csvPath, 'csv');
  check('compute falls back to node for csv', viaFallback.ok === true && viaFallback.engine === 'node');

  // Non-CSV with no Python: must fail cleanly, never throw.
  const noEngine = await ins.compute('definitely-not-a-python-xyz', csvPath, 'excel');
  check('compute excel w/o python fails cleanly', noEngine.ok === false && typeof noEngine.error === 'string');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll insights checks passed.');
  process.exit(failures ? 1 : 0);
})();
