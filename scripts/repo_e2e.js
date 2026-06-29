'use strict';

// Offline end-to-end test of the REPO (multi-file) pipeline — no llama-server, no model.
// We stub llm.streamChat with a scripted "model" BEFORE requiring the pipeline (so its
// destructured reference picks up the stub), then drive a real Pipeline against a temp
// workspace with a real Python runner. This proves the integration glue end to end:
// generate -> write files -> review -> compile every module -> run the entry -> (fix loop)
// and that a generated repo's absolute imports actually resolve at run time.

const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Scripted model: route by prompt content, return a canned answer. ---------
let scenario = null; // set per test
function fakeStreamChat(_baseUrl, { messages, onDelta }) {
  const prompt = messages[messages.length - 1].content;
  const reply = scenario(prompt);
  if (onDelta && reply) onDelta(reply);
  return Promise.resolve(reply);
}

const llm = require('../src/main/llm');
llm.streamChat = fakeStreamChat;                 // stub BEFORE requiring the pipeline
const { Pipeline } = require('../src/main/pipeline');
const python = require('../src/main/python');
const configMod = require('../src/main/config');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

function runFile(file, opts) {
  return new Promise((resolve) => {
    let stderr = '', stdout = '';
    python.run({
      pythonPath: cfg.pythonPath, file, cwd: cfg.workspaceDir, render: true,
      timeoutMs: (opts && opts.timeoutMs) || 0,
      onData: (s, t) => { if (s === 'stderr') stderr += t; else stdout += t; },
      onExit: (code, { images }) => resolve({ code, images, stderr, stdout }),
    });
  });
}

let cfg = null;
function freshWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garm-e2e-'));
  cfg = { ...configMod.load(), workspaceDir: dir, agentOutputMode: 'repo', maxFixIterations: 2 };
  return dir;
}

function newPipeline(events) {
  return new Pipeline({
    config: cfg, baseUrl: 'http://stub', runFile,
    emit: (event, payload) => { (events[event] = events[event] || []).push(payload); },
  });
}

// --- Canned project answers ---------------------------------------------------
const CLEAN_PROJECT = [
  '### main.py',
  '```python',
  'from app.calc import add',
  '',
  'def main():',
  '    print("sum=", add(2, 3))',
  '',
  'if __name__ == "__main__":',
  '    main()',
  '```',
  '',
  '### app/__init__.py',
  '```python',
  '```',
  '',
  '### app/calc.py',
  '```python',
  'def add(a, b):',
  '    return a + b',
  '```',
].join('\n');

// Same project but app/calc.py is missing the colon -> compile fails.
const BROKEN_PROJECT = CLEAN_PROJECT.replace('def add(a, b):', 'def add(a, b)');
// The fix returns ONLY the corrected module (exercises _mergeFiles).
const FIX_CALC = '### app/calc.py\n```python\ndef add(a, b):\n    return a + b\n```';

(async () => {
  // ===== Scenario A: clean multi-file project runs first try =====
  console.log('repo pipeline — clean project');
  freshWorkspace();
  scenario = (p) => {
    if (/structured evaluation/.test(p)) return 'Goal: add two numbers.';
    if (/Design a Python solution/.test(p)) return 'Files: main.py, app/calc.py.';
    if (/Implement the program now/.test(p)) return CLEAN_PROJECT;
    if (/Review this multi-file/.test(p)) return 'NO ISSUES';
    return '';
  };
  let events = {};
  await newPipeline(events).run('Add two numbers across modules.');

  const done = (events['pipeline:done'] || [])[0];
  ok('pipeline finished', !!done, JSON.stringify(events['pipeline:error'] || []));
  ok('entry is main.py', done && done.entry === 'main.py', done && done.entry);
  ok('compiled clean', done && done.compiled === true);
  ok('ran exit 0', done && done.exit === 0, done && ('exit ' + done.exit));
  ok('main.py written', fs.existsSync(path.join(cfg.workspaceDir, 'main.py')));
  ok('app/calc.py written', fs.existsSync(path.join(cfg.workspaceDir, 'app', 'calc.py')));
  ok('empty __init__.py written', fs.existsSync(path.join(cfg.workspaceDir, 'app', '__init__.py')));
  const filesEvt = (events['pipeline:files'] || [])[0];
  ok('pipeline:files announced entry + paths', filesEvt && filesEvt.entry === 'main.py' && filesEvt.paths.indexOf('app/calc.py') >= 0);
  // Prove it really runs with imports resolved (absolute import across the package).
  const out = await runFile(path.join(cfg.workspaceDir, 'main.py'), {});
  ok('generated repo runs (sum= 5 on stdout)', out.code === 0 && /sum=\s*5/.test(out.stdout), 'exit ' + out.code + ': ' + out.stdout + out.stderr);
  fs.rmSync(cfg.workspaceDir, { recursive: true, force: true });

  // ===== Scenario B: broken module is caught by compile and repaired =====
  console.log('repo pipeline — compile error repaired via fix loop');
  freshWorkspace();
  let gen = 0;
  scenario = (p) => {
    if (/structured evaluation/.test(p)) return 'Goal.';
    if (/Design a Python solution/.test(p)) return 'Files.';
    if (/Implement the program now/.test(p)) { gen += 1; return BROKEN_PROJECT; }
    if (/Review this multi-file/.test(p)) return 'NO ISSUES';
    if (/Fix the Python project/.test(p)) return FIX_CALC;   // returns only the changed file
    return '';
  };
  events = {};
  await newPipeline(events).run('Add two numbers across modules.');
  const doneB = (events['pipeline:done'] || [])[0];
  ok('pipeline finished after repair', !!doneB, JSON.stringify(events['pipeline:error'] || []));
  ok('compiles after fix', doneB && doneB.compiled === true);
  ok('runs after fix (exit 0)', doneB && doneB.exit === 0, doneB && ('exit ' + doneB.exit));
  const calc = fs.readFileSync(path.join(cfg.workspaceDir, 'app', 'calc.py'), 'utf8');
  ok('merged fix corrected the module', /def add\(a, b\):/.test(calc), calc);
  ok('untouched main.py preserved', fs.existsSync(path.join(cfg.workspaceDir, 'main.py')));
  fs.rmSync(cfg.workspaceDir, { recursive: true, force: true });

  // ===== Scenario C: single-file mode is unchanged (regression guard) =====
  console.log('single-file pipeline — unchanged');
  freshWorkspace();
  cfg.agentOutputMode = 'single';
  scenario = (p) => {
    if (/structured evaluation/.test(p)) return 'Goal.';
    if (/Design a Python solution/.test(p)) return 'Plan.';
    if (/Implement the program/.test(p)) return '```python\nprint("single ok")\n```';
    if (/Review this Python code/.test(p)) return 'NO ISSUES';
    return '';
  };
  events = {};
  await newPipeline(events).run('Print a line.');
  const doneC = (events['pipeline:done'] || [])[0];
  ok('single-file finished', !!doneC, JSON.stringify(events['pipeline:error'] || []));
  ok('single-file compiled + ran', doneC && doneC.compiled === true && doneC.exit === 0);
  ok('wrote main.py only', fs.existsSync(path.join(cfg.workspaceDir, 'main.py')));
  ok('no pipeline:files in single mode', !(events['pipeline:files'] || []).length);
  fs.rmSync(cfg.workspaceDir, { recursive: true, force: true });

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
