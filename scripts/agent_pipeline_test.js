'use strict';

// Integration test for the graph-driven finalize tail, with the model and the Python
// toolchain stubbed. Proves the wiring end to end: that a failing run drives the repair
// subgraph, that every attempt reaches the on-disk ledger, and that the repair prompt is
// actually given the history of what was already tried.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pipeline } = require('../src/main/pipeline');
const python = require('../src/main/python');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const TB = (n) => `Traceback (most recent call last):\n  File "main.py", line ${n}\nNameError: name 'foo' is not defined`;

// Build a Pipeline whose model, compiler and runner are all scripted.
function makePipeline(ws, { compiles, runs }) {
  const seen = { prompts: [], events: [] };
  const p = new Pipeline({
    config: { workspaceDir: ws, pythonPath: 'python3', maxFixIterations: 3, runTimeoutMs: 1000 },
    baseUrl: '',
    emit: (e, payload) => seen.events.push({ e, payload }),
    runFile: async () => (runs.length > 1 ? runs.shift() : runs[0]),
  });
  // Stub the model: record every prompt, return a fenced program each time.
  let n = 0;
  p._streamCode = async (messages) => {
    seen.prompts.push(messages[messages.length - 1].content);
    n += 1;
    return '```python\nprint("v' + n + '")\nimport os\n```';
  };
  p._stage = async (id, name) => { seen.events.push({ e: 'stage', payload: id }); return { answer: 'NO ISSUES', thinking: '', full: '' }; };
  p._writeCode = (code) => { p.code = code; };
  // Scripted compiler.
  python.compileCheck = async () => (compiles.length > 1 ? compiles.shift() : compiles[0]);
  return { p, seen };
}

(async () => {
  console.log('graph-driven finalize — clean path');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-pipe-'));
    const { p, seen } = makePipeline(ws, { compiles: [{ ok: true, output: '' }], runs: [{ code: 0, stderr: '', images: [] }] });
    await p._finalize('print things', 'print(1)');
    ok('no repair prompts when everything passes', seen.prompts.length === 0, JSON.stringify(seen.prompts.length));
    ok('pipeline:done is emitted', seen.events.some((x) => x.e === 'pipeline:done'));
    ok('fix and run stages both reported done',
      ['fix', 'run'].every((id) => seen.events.some((x) => x.e === 'stage:done' && x.payload.id === id)));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('graph-driven finalize — runtime repair reaches the ledger');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-pipe-'));
    const { p, seen } = makePipeline(ws, {
      compiles: [{ ok: true, output: '' }],
      runs: [{ code: 1, stderr: TB(3), images: [] }, { code: 1, stderr: TB(9), images: [] }, { code: 0, stderr: '', images: [] }],
    });
    await p._finalize('print things', 'print(1)');

    const file = path.join(ws, '.garm', 'problems.json');
    ok('the ledger is written to disk', fs.existsSync(file), file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const prob = data.problems[0];
    ok('the failure was recorded', !!prob && /NameError/.test(prob.headline), JSON.stringify(prob && prob.headline));
    ok('the same fault at a different line is ONE problem, not two', data.problems.length === 1, 'problems=' + data.problems.length);
    ok('repair attempts were recorded against it', prob.attempts.length >= 1, 'attempts=' + prob.attempts.length);
    ok('an attempt records what it achieved', /again|resolved|different/.test(prob.attempts[0].outcome), prob.attempts[0].outcome);

    const second = seen.prompts[1] || '';
    ok('the second repair prompt carries the repair history', /REPAIR HISTORY/.test(second), second.slice(0, 80));
    ok('...telling the model not to repeat the failed fix', /do NOT repeat/i.test(second));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('graph-driven finalize — a missing library is not a code bug');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-pipe-'));
    const { p, seen } = makePipeline(ws, {
      compiles: [{ ok: true, output: '' }],
      runs: [{ code: 1, stderr: "ModuleNotFoundError: No module named 'torch'", images: [] }],
    });
    await p._finalize('use torch', 'import torch');
    ok('no rewrite is attempted for a missing import', seen.prompts.length === 0, 'prompts=' + seen.prompts.length);
    ok('the missing module is surfaced to the UI', seen.events.some((x) => x.e === 'pipeline:missingModule' && x.payload.module === 'torch'));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('past issues are carried into new work');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-pipe-'));
    const { p } = makePipeline(ws, { compiles: [{ ok: true, output: '' }], runs: [{ code: 0, stderr: '', images: [] }] });
    ok('a clean project adds no noise to prompts', p._memoryBlock() === '');
    p.ledger.observe('runtime', TB(3));
    const block = p._memoryBlock();
    ok('an unresolved failure is carried into stage prompts', /KNOWN UNRESOLVED ISSUES/.test(block), block.slice(0, 90));
    ok('...naming the actual failure', /NameError/.test(block));
    p.ledger.markResolved(p.ledger.snapshot().problems[0].signature);
    ok('a resolved failure stops being advertised', !/NameError/.test(p._memoryBlock()));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
