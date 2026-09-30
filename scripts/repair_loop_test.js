'use strict';

// Model-free tests for the repair loop (src/main/repair-loop.js). A scripted driver stands
// in for the compiler, the runtime and the LLM, so the LOOP SEMANTICS can be asserted
// exactly: a repeated failure stops the loop, a progressing loop keeps going, the repair
// prompt receives the history of what was tried, and the loop never ends on a regression.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runRepairLoop, STUCK_AFTER } = require('../src/main/repair-loop');
const { ProblemLedger } = require('../src/main/agent-memory');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const VE = (v) => `Traceback (most recent call last):\n  File "main.py", line 3\nValueError: bad value: '${v}'`;
const KE = 'Traceback (most recent call last):\n  File "main.py", line 9\nKeyError: \'k\'';
const NE = (name) => `Traceback (most recent call last):\n  File "main.py", line 4\nNameError: name '${name}' is not defined`;
const RT = (output) => ({ ok: false, phase: 'runtime', output });
const OK = { ok: true, phase: 'runtime', output: '' };

// Drive the loop with a scripted sequence of check results.
function harness(results, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-loop-'));
  const ledger = new ProblemLedger(dir);
  const seen = { checks: 0, repairs: 0, writes: [], histories: [], notes: [] };
  const run = () => runRepairLoop({
    code: 'start',
    maxCompile: opts.maxCompile == null ? 3 : opts.maxCompile,
    maxRuntime: opts.maxRuntime == null ? 3 : opts.maxRuntime,
    ledger,
    note: (t) => seen.notes.push(t),
    write: async (c) => { seen.writes.push(c); },
    check: async () => results[Math.min(seen.checks++, results.length - 1)],
    repair: opts.repair || (async ({ history }) => { seen.histories.push(history || ''); seen.repairs++; return 'code v' + seen.repairs; }),
  });
  return { run, seen, ledger, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

(async () => {
  console.log('repair loop — happy paths');
  {
    const h = harness([OK]);
    const r = await h.run();
    ok('already passing -> no repair attempted', h.seen.repairs === 0 && r.ok === true);
    ok('code is left untouched', r.code === 'start' && !h.seen.writes.length);
    h.cleanup();
  }
  {
    const h = harness([RT(VE('a')), OK]);
    const r = await h.run();
    ok('one failure then a working fix -> ok after 1 attempt', r.ok === true && r.attempts === 1, JSON.stringify({ ok: r.ok, attempts: r.attempts }));
    ok('the repaired code is written and carried out', r.code === 'code v1' && h.seen.writes[0] === 'code v1', r.code);
    h.cleanup();
  }

  console.log('repair loop — problem-aware stopping');
  {
    // The same fault every time: the model is looping and must be stopped early rather
    // than burning the whole budget re-trying what already failed.
    const h = harness([RT(VE('a'))], { maxRuntime: 8 });
    const r = await h.run();
    ok('repeated identical failure stops as "stuck"', r.stopReason === 'stuck', r.stopReason);
    ok('it stops early, well inside the budget', r.attempts <= STUCK_AFTER + 1 && r.attempts < 8, 'attempts=' + r.attempts);
    ok('the stop is explained to the user', h.seen.notes.some((n) => /survived .* repair attempts/.test(n)), JSON.stringify(h.seen.notes));
    h.cleanup();
  }
  {
    // Each repair yields a DIFFERENT fault: that is progress, so the loop keeps going
    // until the configured budget is spent.
    const h = harness([RT(VE('a')), RT(KE), RT(VE('b')), RT(KE)], { maxRuntime: 3 });
    const r = await h.run();
    ok('changing failures run to the iteration budget', r.attempts === 3 && r.stopReason === 'budget', `attempts=${r.attempts} stop=${r.stopReason}`);
    h.cleanup();
  }
  {
    // Regression: every NameError used to share one signature, so fixing 'foo' and then
    // hitting 'bar' read as "the same failure again" and the loop quit while progressing.
    const h = harness([RT(NE('foo')), RT(NE('bar')), RT(NE('baz')), OK], { maxRuntime: 3 });
    const r = await h.run();
    ok('distinct NameErrors are progress, not a stuck loop', r.ok === true && r.stopReason === '', `ok=${r.ok} stop=${r.stopReason}`);
    h.cleanup();
  }
  {
    const h = harness([{ ...RT("ModuleNotFoundError: No module named 'torch'"), stop: 'missing' }]);
    const r = await h.run();
    ok('a non-code stop (missing library) is never "repaired"', h.seen.repairs === 0 && r.stopReason === 'missing', r.stopReason);
    h.cleanup();
  }
  {
    // A model that returns nothing usable: each attempt is recorded, and the loop stops
    // as stuck instead of re-checking code that did not change.
    const h = harness([RT(VE('a'))], { maxRuntime: 5, repair: async () => null });
    const r = await h.run();
    ok('empty repairs count toward the stuck limit', r.stopReason === 'stuck' && h.seen.checks === 1, `stop=${r.stopReason} checks=${h.seen.checks}`);
    const prob = h.ledger.snapshot().problems[0];
    ok('...and are recorded as rejected attempts', prob.attempts.length >= 1 && /rejected/.test(prob.attempts[0].outcome), JSON.stringify(prob.attempts[0]));
    h.cleanup();
  }
  {
    const h = harness([RT(VE('a'))], { repair: async () => ({ rejected: 'returned a fragment' }) });
    await h.run();
    const later = h.ledger.render(h.ledger.snapshot().problems[0].signature);
    ok('a rejected fragment is reported back to the next repair', /returned a fragment/.test(later), later.slice(0, 160));
    h.cleanup();
  }

  console.log('repair loop — separate budgets per phase');
  {
    const h = harness([{ ok: false, phase: 'compile', output: 'SyntaxError: invalid syntax' }, RT(KE), RT(VE('x')), OK], { maxCompile: 1, maxRuntime: 2 });
    const r = await h.run();
    ok('compile and runtime repairs draw on their own budgets', r.ok && r.repairs.compile === 1 && r.repairs.runtime === 2, JSON.stringify(r.repairs));
    h.cleanup();
  }

  console.log('repair loop — never end on a regression');
  {
    // A runtime repair produces code that no longer compiles, and the syntax fix fails too.
    // The loop must put back the version that compiled instead of leaving broken code.
    const h = harness([
      RT(VE('a')),
      { ok: false, phase: 'compile', output: 'SyntaxError: invalid syntax' },
      { ok: false, phase: 'compile', output: 'SyntaxError: unexpected indent' },
    ], { maxCompile: 1, maxRuntime: 1 });
    const r = await h.run();
    ok('the best (compiling) version is restored', r.restored === true && r.code === 'start', JSON.stringify({ restored: r.restored, code: r.code }));
    ok('...and written back to disk', h.seen.writes[h.seen.writes.length - 1] === 'start', JSON.stringify(h.seen.writes));
    ok('...and the reported result is the restored version\'s', r.result.phase === 'runtime', r.result.phase);
    h.cleanup();
  }

  console.log('repair loop — the accuracy mechanism');
  {
    const h = harness([RT(VE('a'))], { maxRuntime: 8 });
    await h.run();
    ok('first repair has no history to go on', h.seen.histories[0] === '');
    const later = h.seen.histories[1] || '';
    ok('the SECOND repair is told what was already tried', /already attempted/i.test(later), JSON.stringify(later.slice(0, 120)));
    ok('...and is told not to repeat it', /do NOT repeat/i.test(later));
    ok('...and that the failure recurred', /occurred \d+ times/.test(later));
    const prob = h.ledger.snapshot().problems[0];
    ok('every attempt is recorded with its outcome', prob.attempts.length >= 1 && /same failure occurred again/.test(prob.attempts[0].outcome), JSON.stringify(prob.attempts[0]));
    ok('the recorded action describes the change', /lines/.test(prob.attempts[0].action), prob.attempts[0].action);
    ok('each check is counted once (no double observe)', prob.count === h.seen.checks, `count=${prob.count} checks=${h.seen.checks}`);
    h.cleanup();
  }
  {
    const h = harness([RT(VE('a')), OK]);
    await h.run();
    const prob = h.ledger.snapshot().problems[0];
    ok('a successful fix is recorded as resolving it', /resolved/.test(prob.attempts[0].outcome), prob.attempts[0].outcome);
    ok('the problem is marked resolved', prob.resolved === true);
    h.cleanup();
  }
  {
    // Getting past failure A to a different failure B resolves A, so A stops being
    // advertised as a known issue to later runs.
    const h = harness([RT(VE('a')), RT(KE)], { maxRuntime: 1 });
    await h.run();
    const known = h.ledger.renderKnownIssues(5);
    ok('a failure the repair moved past is no longer "unresolved"', !/ValueError/.test(known) && /KeyError/.test(known), known);
    h.cleanup();
  }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
