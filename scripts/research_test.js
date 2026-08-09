'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const datasets = require('../src/main/datasets');
const experiments = require('../src/main/experiments');
const reproducibility = require('../src/main/reproducibility');
const research = require('../src/main/research');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-research-'));
  const input = path.join(dir, 'input.csv');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  try {
    const rows = ['id,age,after_result,target'];
    for (let i = 0; i < 50; i += 1) rows.push([i, 20 + (i % 8), i < 47 ? 0 : 1, i < 47 ? 'no' : 'yes'].join(','));
    rows.push(rows[rows.length - 1]); // deliberate duplicate
    fs.writeFileSync(input, rows.join('\n') + '\n', 'utf8');
    const added = await datasets.add(dir, [input], python);
    assert.strictEqual(added.added.length, 1);
    const dataset = added.added[0];
    const report = await research.analyze(dir, dataset.id, 'target', python);
    assert.strictEqual(report.ok, true, report.error);
    assert(report.duplicates >= 1);
    assert(report.warnings.some((w) => w.code === 'imbalance'));
    assert(report.leakage.some((x) => x.column === 'after_result'));
    assert(report.methodology.checks.some((c) => c.id === 'split' && !c.ok));
    const generated = research.generateTests(dir, report);
    assert(fs.existsSync(path.join(dir, generated.path)));
    assert(/duplicate_rate/.test(generated.content));

    experiments.record(dir, { file: 'main.py', output: 'accuracy: 0.81\nloss: 0.4', exitCode: 0 });
    experiments.record(dir, { file: 'main.py', output: 'accuracy: 0.88\nloss: 0.3', exitCode: 0 });
    const comparison = research.compareRuns(dir);
    assert.strictEqual(comparison.metrics.find((m) => m.name === 'accuracy').best.value, 0.88);
    assert.strictEqual(comparison.metrics.find((m) => m.name === 'loss').best.value, 0.3);

    fs.writeFileSync(path.join(dir, 'main.py'), 'import random\nrandom.seed(42)\nprint("accuracy: 0.88")\n', 'utf8');
    const manifest = await reproducibility.capture({ workspaceDir: dir, file: 'main.py', config: { pythonPath: python, provider: 'local', modelPath: 'model.gguf', contextSize: 8192, agentOutputMode: 'single', maxFixIterations: 3 }, env: { python: 'test' }, datasets: datasets.list(dir), run: { source: 'run', exitCode: 0, metrics: { accuracy: .88 } } });
    assert(manifest.code.sha256 && manifest.code.sha256.length === 64);
    assert(manifest.datasets[0].sha256 && manifest.datasets[0].sha256.length === 64);
    assert(manifest.seeds.some((s) => s.library === 'python' && s.value === '42'));
    assert(fs.existsSync(path.join(dir, '.garm', 'reproducibility', manifest.id, 'source', 'main.py')));
    console.log('✓ profiling, validation, generated tests, run comparison, and reproducibility checks passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
