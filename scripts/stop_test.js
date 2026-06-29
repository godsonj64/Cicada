'use strict';

// Offline test for STOP/CANCEL during the pipeline's Run stage (no model, no llama-server).
// The bug: pressing Stop while the agent's generated program was running did nothing — the
// button was disabled, and Cancel only aborted the LLM, never the Python process; worse, a
// forced kill could look like a crash and make the pipeline "repair" and RE-RUN the program.
//
// We stub llm.streamChat to reach the Run stage, then use a runFile stub to simulate a
// running program. When the stub calls pipeline.cancel() (what Stop/Cancel now do), the
// pipeline must: stop immediately, NOT run the program again, and finish with cancelled:true.

const fs = require('fs');
const os = require('os');
const path = require('path');

let scenario = null;
function fakeStreamChat(_baseUrl, { messages }) {
  return Promise.resolve(scenario(messages[messages.length - 1].content));
}
const llm = require('../src/main/llm');
llm.streamChat = fakeStreamChat;
const { Pipeline } = require('../src/main/pipeline');
const configMod = require('../src/main/config');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

// Single-file scenario: drive evaluate -> design -> generate -> review(NO ISSUES) -> run.
function scen(prompt) {
  if (/Analyze this request/.test(prompt)) return 'Goal: print';
  if (/Design a Python solution/.test(prompt)) return 'Approach: print a line';
  if (/Implement the program/.test(prompt)) return '```python\nprint("hi")\n```';
  if (/Review this Python code/.test(prompt)) return 'NO ISSUES';
  if (/Fix the Python program|crashes at runtime/.test(prompt)) return '```python\nprint("fixed")\n```';
  return 'ok';
}

function freshCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-stop-'));
  return { ...configMod.load(), workspaceDir: dir, agentOutputMode: 'single', maxFixIterations: 1 };
}

// A "running program" that always exits with a crash-like traceback (which would normally
// trigger the runtime-repair loop). `onRun` lets a test cancel mid-run.
function makeRunFile(state, onRun) {
  return function runFile() {
    state.runCalls += 1;
    if (onRun) onRun(state.runCalls);
    return Promise.resolve({ code: 1, images: [], stderr: 'Traceback (most recent call last):\nRuntimeError: still running' });
  };
}

(async () => {
  scenario = scen;

  // --- Test 1: Stop pressed during the run (cancel from inside runFile) ---------
  console.log('stop during the Run stage');
  {
    const cfg = freshCfg();
    const events = {};
    let pipeline;
    const state = { runCalls: 0 };
    const runFile = makeRunFile(state, function () { pipeline.cancel(); }); // user hits Stop
    pipeline = new Pipeline({ config: cfg, baseUrl: 'http://stub', runFile, emit: (e, p) => { (events[e] = events[e] || []).push(p); } });
    await pipeline.run('print a line');

    ok('program was run exactly once (no repair re-run after stop)', state.runCalls === 1, 'runCalls=' + state.runCalls);
    const dones = events['pipeline:done'] || [];
    ok('exactly one terminal pipeline:done', dones.length === 1, 'count=' + dones.length);
    ok('finished as cancelled', dones[0] && dones[0].cancelled === true, JSON.stringify(dones[0]));
    ok('no pipeline:error emitted', !(events['pipeline:error'] || []).length);
    ok('pipeline marked not running afterwards', pipeline.running === false);
    fs.rmSync(cfg.workspaceDir, { recursive: true, force: true });
  }

  // --- Test 2 (control): no stop -> the crash DOES drive a repair re-run ---------
  // Proves the harness would otherwise re-run, so Test 1's single run is due to the guard.
  console.log('control: a real crash still triggers a repair re-run when NOT stopped');
  {
    const cfg = freshCfg();
    const events = {};
    const state = { runCalls: 0 };
    const runFile = makeRunFile(state, null); // never cancel
    const pipeline = new Pipeline({ config: cfg, baseUrl: 'http://stub', runFile, emit: (e, p) => { (events[e] = events[e] || []).push(p); } });
    await pipeline.run('print a line');

    ok('program was run more than once (repair loop engaged)', state.runCalls > 1, 'runCalls=' + state.runCalls);
    const dones = events['pipeline:done'] || [];
    ok('finished normally (not cancelled)', dones.length === 1 && !dones[0].cancelled);
    fs.rmSync(cfg.workspaceDir, { recursive: true, force: true });
  }

  console.log('');
  if (fail) { console.error('✗ ' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
  console.log('✓ ' + pass + ' passed, 0 failed');
})();
