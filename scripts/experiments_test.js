'use strict';

// Headless checks for the experiment tracker: metric parsing from realistic training
// output, store round-trips, pruning, and CSV export. No Python, no network.

const fs = require('fs');
const os = require('os');
const path = require('path');
const exp = require('../src/main/experiments');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || !detail ? '' : '  — ' + detail));
  if (!cond) failures += 1;
}

// ---- parseMetrics ------------------------------------------------------------

const TRAIN_LOG = [
  'Epoch 1/5',
  'loss: 0.9321 - accuracy: 0.61',
  'Epoch 2/5',
  'loss: 0.5123 - accuracy: 0.79',
  'epoch: 5',
  'val_loss = 0.3111',
  'val_accuracy = 0.8842',
  'Test RMSE: 3.52',
  'f1: 0.77',
].join('\n');

let p = exp.parseMetrics(TRAIN_LOG);
check('last value wins (loss)', p.metrics.loss === 0.5123, JSON.stringify(p.metrics));
check('val_ prefix kept', p.metrics.val_accuracy === 0.8842);
check('= separator works', p.metrics.val_loss === 0.3111);
check('rmse captured (with test prefix)', p.metrics.test_rmse === 3.52, JSON.stringify(p.metrics));
check('f1 captured', p.metrics.f1 === 0.77);
check('epoch lifted out of metrics', !('epoch' in p.metrics) && p.epochs === 5, String(p.epochs));

p = exp.parseMetrics('{"epoch": 3, "loss": 0.25, "lr": 0.001, "name": "run"}');
check('json line metrics', p.metrics.loss === 0.25 && p.metrics.lr === 0.001);
check('json epoch counter', p.epochs === 3);
check('non-numeric json field ignored', !('name' in p.metrics));

p = exp.parseMetrics('nothing to see here\njust prints\n42');
check('no false positives', Object.keys(p.metrics).length === 0 && p.epochs === null, JSON.stringify(p));

p = exp.parseMetrics('glossary: 5\nfloss: 3');
check('substring names do not match', !('loss' in p.metrics), JSON.stringify(p.metrics));

p = exp.parseMetrics('accuracy: 0.5e-2');
check('scientific notation', p.metrics.accuracy === 0.005);

p = exp.parseMetrics(null);
check('null input safe', Object.keys(p.metrics).length === 0);

// Huge input: only the tail is scanned, and it doesn't blow up.
const huge = 'x'.repeat(300000) + '\nloss: 0.1\n';
p = exp.parseMetrics(huge);
check('huge log scans tail', p.metrics.loss === 0.1);

// ---- store round-trip ----------------------------------------------------------

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-exp-'));
const e1 = exp.record(ws, { file: 'main.py', source: 'run', durationMs: 1234, exitCode: 0, output: 'loss: 0.4\naccuracy: 0.9', images: 2 });
check('record returns entry', !!(e1 && e1.id));
check('metrics recorded', e1.metrics.loss === 0.4 && e1.metrics.accuracy === 0.9);
check('images counted', e1.images === 2);

exp.record(ws, { file: 'train.py', source: 'pipeline', durationMs: 60, exitCode: 1, output: 'Traceback ...', images: 0 });
let runs = exp.list(ws);
check('list newest first', runs.length === 2 && runs[0].file === 'train.py');
check('failure recorded with exit code', runs[0].exitCode === 1);

check('remove works', exp.remove(ws, runs[0].id) === true && exp.list(ws).length === 1);
check('remove missing id is false', exp.remove(ws, 'nope') === false);

// CSV export: header carries metric columns, values line up.
const csv = exp.toCsv(ws);
check('csv has metric columns', /loss/.test(csv.split('\n')[0]) && /accuracy/.test(csv.split('\n')[0]));
check('csv has data row', csv.split('\n').length >= 3, csv);

// Corrupt store starts fresh instead of crashing.
fs.writeFileSync(path.join(ws, '.garm', 'experiments.json'), '{not json', 'utf8');
check('corrupt store tolerated', Array.isArray(exp.list(ws)) && exp.list(ws).length === 0);

// Pruning: cap at MAX_RUNS.
exp.clear(ws);
for (let i = 0; i < exp.MAX_RUNS + 25; i++) {
  exp.record(ws, { file: 'r' + i + '.py', source: 'run', durationMs: 1, exitCode: 0, output: 'loss: ' + i });
}
runs = exp.list(ws);
check('history pruned to cap', runs.length === exp.MAX_RUNS, String(runs.length));
check('newest kept after prune', runs[0].file === 'r' + (exp.MAX_RUNS + 24) + '.py');

fs.rmSync(ws, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll experiments checks passed.');
process.exit(failures ? 1 : 0);
