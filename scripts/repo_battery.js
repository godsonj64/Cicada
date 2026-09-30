'use strict';

// Model-backed battery for MULTI-FILE (repo mode) generation: realistic projects, each
// created from scratch and then changed with a follow-up refine, against the configured
// local model. Prints a result matrix. Runs in a throwaway workspace per scenario (see
// _e2e.js) — never in a real project. Takes several minutes.
//
//   node scripts/repo_battery.js            (KEEP_WORKSPACE=1 to keep the projects)

const fs = require('fs');
const path = require('path');
const { isolatedConfig, makeRunFile, cleanup } = require('./_e2e');
const { LlamaServer } = require('../src/main/llama');
const { Pipeline } = require('../src/main/pipeline');
const { ContextMemory } = require('../src/main/memory');

const SCENARIOS = [
  { name: 'Inventory manager',
    request: 'An inventory manager: a Product dataclass module, an Inventory class module with add, remove and restock operations and a low-stock report, and a main.py that demonstrates it with 5 products and prints the report.',
    change: 'Add a function that exports the inventory report to a CSV file named report.csv and call it from main.py.' },
  { name: 'K-means from scratch',
    request: 'K-means clustering from scratch with numpy on 3 synthetic Gaussian blobs (fixed random seed): one module for data generation, one for the k-means algorithm, and one for plotting a scatter plot of the clusters with their centroids. main.py runs it and shows the plot.',
    change: 'Also print how many points ended up in each cluster.' },
  { name: 'Text statistics tool',
    request: 'A text statistics tool: a tokenizer module, a stats module (word counts, the 10 most common words, average sentence length), and a main.py that analyzes a built-in sample paragraph and prints a report.',
    change: 'Also report the 5 longest words.' },
  { name: 'Bank account simulator',
    request: 'A bank account simulator: an accounts package with an Account class and a SavingsAccount subclass that earns interest, a transactions module that logs deposits and withdrawals and rejects overdrafts, and a main.py that runs a scripted scenario and prints the balances and the transaction log.',
    change: 'Add a monthly interest step for savings accounts and print the balances after applying it.' },
  { name: 'Linear regression (GD)',
    request: 'Linear regression trained with gradient descent: a data module that generates noisy linear data (fixed seed), a model module with fit and predict, a metrics module with MSE and R^2, and a main.py that trains the model, prints the metrics and plots the data with the fitted line.',
    change: 'Also plot the training loss curve in a second figure.' },
];

// The old prompt template's example scaffold; it must not appear in unrelated projects.
const SCAFFOLD = /^(models\/net\.py|data\/loader\.py|training\.py)$/;

async function runPhase(pipeline, fn) {
  const t0 = Date.now();
  const seen = { done: null, error: null, repairs: 0 };
  pipeline.emit = (event, p) => {
    if (event === 'pipeline:done') seen.done = p;
    else if (event === 'pipeline:error') seen.error = p.message;
    else if (event === 'stage:delta' && p.kind === 'answer' && /repairing \(attempt|Fixing the syntax error/.test(p.text)) seen.repairs += 1;
  };
  await fn();
  return { ...seen, secs: Math.round((Date.now() - t0) / 1000) };
}

(async () => {
  const base = isolatedConfig({});
  const llama = new LlamaServer(base);
  llama.on('status', (s) => { if (s.status !== 'starting') console.log(`[llama] ${s.status}${s.detail ? ' - ' + s.detail : ''}`); });
  await llama.start();
  if (llama.status !== 'ready') { console.error('server not ready: ' + llama.lastError); process.exit(1); }
  cleanup(base);

  const rows = [];
  for (const [i, sc] of SCENARIOS.entries()) {
    console.log(`\n========== [${i + 1}/${SCENARIOS.length}] ${sc.name} ==========`);
    const config = isolatedConfig({ agentOutputMode: 'repo' });
    const memory = new ContextMemory(config.workspaceDir);
    const pipeline = new Pipeline({ config, baseUrl: llama.baseUrl(), runFile: makeRunFile(config, { echo: false }), memory, emit: () => {} });

    const create = await runPhase(pipeline, () => pipeline.run(sc.request));
    const files = (create.done && create.done.files) || [];
    const py = files.filter((f) => /\.py$/.test(f));
    console.log(`  create: ${create.error ? 'ERROR ' + create.error : `exit=${create.done.exit}`}  files=${files.join(', ')}  repairs=${create.repairs}  ${create.secs}s`);

    let refine = { done: null, error: 'skipped (create failed)', repairs: 0, secs: 0 };
    if (create.done && create.done.exit === 0) {
      const entry = path.join(config.workspaceDir, create.done.entry || 'main.py');
      refine = await runPhase(pipeline, () => pipeline.refine(sc.change, fs.readFileSync(entry, 'utf8')));
      console.log(`  refine: ${refine.error ? 'ERROR ' + refine.error : `exit=${refine.done.exit}`}  repairs=${refine.repairs}  ${refine.secs}s`);
    }
    rows.push({
      name: sc.name, files: py.length, entry: create.done ? create.done.entry : '-',
      create: create.error ? 'error' : create.done.exit, createRepairs: create.repairs, createSecs: create.secs,
      refine: refine.error ? (refine.done ? 'error' : '-') : refine.done.exit, refineRepairs: refine.repairs, refineSecs: refine.secs,
      scaffold: files.filter((f) => SCAFFOLD.test(f)).length,
    });
    cleanup(config);
  }

  await llama.stop();
  console.log('\n===================== REPO BATTERY =====================');
  const col = (v, n) => String(v).padEnd(n);
  console.log(col('scenario', 25) + col('.py', 5) + col('entry', 10) + col('create (repairs, s)', 22) + col('refine (repairs, s)', 22) + 'scaffold');
  for (const r of rows) {
    console.log(col(r.name, 25) + col(r.files, 5) + col(r.entry, 10) +
      col(`${r.create} (${r.createRepairs}, ${r.createSecs})`, 22) + col(`${r.refine} (${r.refineRepairs}, ${r.refineSecs})`, 22) + r.scaffold);
  }
  const created = rows.filter((r) => r.create === 0).length;
  const refined = rows.filter((r) => r.refine === 0).length;
  console.log('--------------------------------------------------------');
  console.log(`created and ran: ${created}/${rows.length}   refined and ran: ${refined}/${created}   template scaffold leaks: ${rows.reduce((n, r) => n + r.scaffold, 0)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
