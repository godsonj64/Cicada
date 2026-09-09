'use strict';

// Model-free tests for the repair subgraph. A scripted driver stands in for the compiler,
// the runtime and the LLM, so the LOOP SEMANTICS can be asserted exactly: does a repeated
// failure stop the loop, does a genuinely-progressing loop keep going, and does the repair
// prompt actually receive the history of what was already tried.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildRepairGraph, STUCK_AFTER } = require('../src/main/agent-graph');
const { ProblemLedger } = require('../src/main/agent-memory');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const VE = (v) => `Traceback (most recent call last):\n  File "main.py", line 3\nValueError: bad value: '${v}'`;
const KE = 'Traceback (most recent call last):\n  File "main.py", line 9\nKeyError: \'k\'';

// Drive the graph with a scripted sequence of check results.
function harness(results, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-graph-'));
  const ledger = new ProblemLedger(dir);
  const seen = { checks: 0, repairs: 0, histories: [], notes: [] };
  const graph = buildRepairGraph({
    phase: opts.phase || 'runtime',
    maxIter: opts.maxIter == null ? 3 : opts.maxIter,
    ledger,
    aborted: () => false,
    note: (t) => seen.notes.push(t),
    check: async () => results[Math.min(seen.checks++, results.length - 1)],
    repair: async ({ history }) => { seen.histories.push(history || ''); seen.repairs++; return 'code v' + seen.repairs; },
  });
  return { graph, seen, ledger, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

(async () => {
  console.log('repair subgraph — happy paths');
  {
    const h = harness([{ ok: true, output: '', exit: 0 }]);
    const r = await h.graph.invoke({ code: 'start' });
    ok('already passing -> no repair attempted', h.seen.repairs === 0 && r.ok === true);
    ok('code is left untouched', r.code === 'start');
    h.cleanup();
  }
  {
    const h = harness([{ ok: false, output: VE('a') }, { ok: true, output: '', exit: 0 }]);
    const r = await h.graph.invoke({ code: 'start' });
    ok('one failure then a working fix -> ok after 1 iteration', r.ok === true && r.iter === 1, JSON.stringify({ ok: r.ok, iter: r.iter }));
    ok('the repaired code is carried out of the loop', r.code === 'code v1', r.code);
    h.cleanup();
  }

  console.log('repair subgraph — problem-aware stopping');
  {
    // The same fault every time: the model is looping and must be stopped early rather
    // than burning the whole budget re-trying what already failed.
    const h = harness([{ ok: false, output: VE('a') }], { maxIter: 8 });
    const r = await h.graph.invoke({ code: 'start' });
    ok('repeated identical failure stops as "stuck"', r.stopReason === 'stuck', r.stopReason);
    ok('it stops early, well inside the budget', r.iter <= STUCK_AFTER + 1 && r.iter < 8, 'iter=' + r.iter);
    ok('the stop is explained to the user', h.seen.notes.some((n) => /survived .* repair attempts/.test(n)), JSON.stringify(h.seen.notes));
    h.cleanup();
  }
  {
    // Each repair yields a DIFFERENT fault: that is progress of a sort, so the loop is
    // allowed to keep going until the configured budget is spent.
    const h = harness([{ ok: false, output: VE('a') }, { ok: false, output: KE }, { ok: false, output: VE('b') }, { ok: false, output: KE }], { maxIter: 3 });
    const r = await h.graph.invoke({ code: 'start' });
    ok('changing failures run to the iteration budget', r.iter === 3, 'iter=' + r.iter);
    ok('not reported as stuck', r.stopReason !== 'stuck', r.stopReason);
    h.cleanup();
  }
  {
    const h = harness([{ ok: false, output: "ModuleNotFoundError: No module named 'torch'", missing: { module: 'torch', pkg: 'torch' } }]);
    const r = await h.graph.invoke({ code: 'start' });
    ok('a missing library is never "repaired" by rewriting', h.seen.repairs === 0, 'repairs=' + h.seen.repairs);
    ok('the missing module is reported out', r.missing && r.missing.module === 'torch');
    h.cleanup();
  }
  {
    const h = harness([{ ok: false, output: VE('a') }]);
    const g = buildRepairGraph({
      phase: 'runtime', maxIter: 3, ledger: h.ledger, aborted: () => false, note: () => {},
      check: async () => ({ ok: false, output: VE('a') }),
      repair: async () => null,                       // model returns nothing usable
    });
    const r = await g.invoke({ code: 'start' });
    ok('a model that returns no fix ends the loop', r.stopReason === 'no-fix', r.stopReason);
    h.cleanup();
  }

  console.log('repair subgraph — the accuracy mechanism');
  {
    const h = harness([{ ok: false, output: VE('a') }], { maxIter: 8 });
    await h.graph.invoke({ code: 'start' });
    ok('first repair has no history to go on', h.seen.histories[0] === '');
    const later = h.seen.histories[1] || '';
    ok('the SECOND repair is told what was already tried', /already attempted/i.test(later), JSON.stringify(later.slice(0, 120)));
    ok('...and is told not to repeat it', /do NOT repeat/i.test(later));
    ok('...and that the failure recurred', /occurred \d+ times/.test(later));
    const prob = h.ledger.snapshot().problems[0];
    ok('every attempt is recorded with its outcome', prob.attempts.length >= 1 && /same failure occurred again/.test(prob.attempts[0].outcome), JSON.stringify(prob.attempts[0]));
    ok('the recorded action describes the change', /lines/.test(prob.attempts[0].action), prob.attempts[0].action);
    h.cleanup();
  }
  {
    const h = harness([{ ok: false, output: VE('a') }, { ok: true, output: '', exit: 0 }]);
    await h.graph.invoke({ code: 'start' });
    const prob = h.ledger.snapshot().problems[0];
    ok('a successful fix is recorded as resolving it', /resolved/.test(prob.attempts[0].outcome), prob.attempts[0].outcome);
    ok('the problem is marked resolved', prob.resolved === true);
    h.cleanup();
  }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
