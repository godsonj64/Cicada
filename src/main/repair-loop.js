'use strict';

// The agent's repair loop: check -> (repair -> check)* until the program passes, a repair
// budget is spent, or the repairs stop making progress.
//
// It is deliberately plain async code. It used to be a LangGraph state graph, which added
// ~34 MB of dependencies (and shipped one release that could not start) to express what is
// a single loop. The problem-aware behaviour lives in the ProblemLedger, not in the graph
// runtime: every failure is fingerprinted, every attempt is recorded with what it achieved,
// and the next repair is told what has already been tried.
//
// One loop serves every program shape (a single file, a multi-file repo, an edited
// selection). `code` is opaque to the loop — a string or a list of files — and the driver
// supplies how to write, check and repair it.
//
// driver:
//   code                      the starting program
//   write(code)               persist a candidate (called after every accepted repair)
//   check(code)               -> { ok, phase: 'compile' | 'runtime', output, stop? }
//                                `stop` (e.g. 'missing', 'interactive', 'aborted') ends the
//                                loop without a repair: the failure is not a code bug.
//   repair({ code, failure, history, attempt })
//                             -> new code | { rejected: reason } | null
//   maxCompile / maxRuntime   separate repair budgets per failure phase
//   ledger                    ProblemLedger (optional; signatures fall back to classify)
//   describe(before, after)   one-line summary of a change (defaults to describeChange)
//   note(text)                progress line for the UI
//   aborted()                 true once the user cancelled

const { classify, describeChange } = require('./agent-memory');

// How many consecutive repairs may leave the SAME failure in place before the loop
// concedes. Beyond this the model is looping and further attempts burn time for nothing.
const STUCK_AFTER = 2;

// How far a check got. Used to keep the best version seen: a repair that turns a runtime
// error into a syntax error is a regression, and the loop must never end on one if it had
// something better.
function rank(res) {
  if (!res) return -1;
  if (res.ok) return 2;
  return res.phase === 'compile' ? 0 : 1;
}

async function runRepairLoop(d) {
  const ledger = d.ledger || null;
  const note = d.note || (() => {});
  const describe = d.describe || describeChange;
  const aborted = d.aborted || (() => false);
  const budget = {
    compile: Math.max(0, d.maxCompile == null ? 3 : d.maxCompile),
    runtime: Math.max(0, d.maxRuntime == null ? 3 : d.maxRuntime),
  };
  const used = { compile: 0, runtime: 0 };

  let code = d.code;
  let res = await d.check(code);
  let best = { code, res };
  let current = res.ok ? null : identify(res);
  let repeats = 0;
  let stopReason = '';
  let attempts = 0;

  // Fingerprint a failure. Observing through the ledger both records the occurrence and
  // returns the stable signature used for repeat detection.
  function identify(r) {
    if (ledger) return ledger.observe(r.phase, r.output);
    return classify(r.phase, r.output);
  }

  for (;;) {
    if (res.ok) break;
    if (res.stop) { stopReason = res.stop; break; }
    if (aborted()) { stopReason = 'aborted'; break; }
    const phase = res.phase === 'compile' ? 'compile' : 'runtime';
    if (used[phase] >= budget[phase]) { stopReason = 'budget'; break; }
    if (repeats >= STUCK_AFTER) {
      note(`The same failure survived ${repeats} repair attempts — stopping instead of repeating them.\n`);
      stopReason = 'stuck';
      break;
    }

    used[phase] += 1;
    attempts += 1;
    const history = ledger && current ? ledger.render(current.signature) : '';
    const next = await d.repair({ code, failure: { ...res, phase, headline: current && current.headline }, history, attempt: attempts });
    if (aborted()) { stopReason = 'aborted'; break; }

    // A repair that produced nothing usable (no code block, a collapsed fragment, or the
    // very same program) is still an attempt: record it so the next prompt knows, and
    // count it toward the stuck limit — re-checking unchanged code would prove nothing.
    const rejected = !next ? 'returned no usable code' : (next.rejected || null);
    const change = rejected ? null : describe(code, next);
    if (rejected || /no change/.test(change)) {
      const why = rejected || 'returned identical code (no change)';
      if (ledger && current) ledger.recordAttempt(current.signature, { action: why, outcome: 'rejected — nothing was applied', phase });
      note(`  attempt ${attempts}: ${why} — not applied\n`);
      repeats += 1;
      continue;
    }

    code = next;
    await d.write(code);
    const prev = current;
    res = await d.check(code);

    let outcome;
    if (res.ok) {
      outcome = 'resolved the failure';
      current = null;
      repeats = 0;
    } else if (res.stop) {
      outcome = 'got past it; the program now stops for a non-code reason (' + res.stop + ')';
      current = null;
    } else {
      current = identify(res);
      if (prev && current.signature === prev.signature) { outcome = 'the same failure occurred again'; repeats += 1; }
      else { outcome = 'produced a different failure: ' + (current.headline || 'unknown'); repeats = 0; }
    }
    if (ledger && prev) {
      ledger.recordAttempt(prev.signature, { action: change, outcome, phase });
      // Moving past a failure resolves it, even if a different one surfaced — otherwise it
      // lingers as a "known unresolved issue" in every later prompt.
      if (!current || current.signature !== prev.signature) ledger.markResolved(prev.signature);
    }
    note(`  attempt ${attempts}: ${outcome}\n`);
    if (rank(res) >= rank(best.res)) best = { code, res };
  }

  // Never end on a regression: if an earlier version got further (it compiled where the
  // last repair does not, or it ran), put that version back.
  let restored = false;
  if (rank(best.res) > rank(res) && best.code !== code) {
    code = best.code;
    res = best.res;
    await d.write(code);
    restored = true;
    note('Kept the best earlier version — the last repair made things worse.\n');
  }

  return {
    code,
    ok: !!res.ok,
    result: res,
    stopReason: res.ok ? '' : stopReason,
    attempts,
    repairs: { ...used },
    restored,
  };
}

module.exports = { runRepairLoop, STUCK_AFTER, rank };
