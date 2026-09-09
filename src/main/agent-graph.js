'use strict';

// The agentic pipeline as a LangGraph state graph.
//
// The repair loops used to be plain while-loops that fed the model nothing but the current
// code and the latest error. Expressed as a graph they gain explicit state: which problem
// is being worked, what has already been tried against it, and why the loop stopped —
// which is what lets a repair be problem-aware instead of a blind retry.
//
// Subgraph state is deliberately ISOLATED from the parent's. A subgraph that shares an
// append-reducer channel re-merges the values it inherited, duplicating every entry on each
// pass (a parent and subgraph sharing one log channel yields ["parent","parent","sub"]).
// An attempts ledger built on a shared channel would therefore double its own history on
// every repair pass, so subgraphs keep a narrow schema and the parent adapts the result.

const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');
const { describeChange } = require('./agent-memory');

// How many times the SAME problem signature may survive a repair before the loop concedes.
// Beyond this the model is looping, and further iterations burn budget without progress.
const STUCK_AFTER = 2;

const RepairState = Annotation.Root({
  code: Annotation({ reducer: (_, b) => b, default: () => '' }),
  output: Annotation({ reducer: (_, b) => b, default: () => '' }),
  ok: Annotation({ reducer: (_, b) => b, default: () => false }),
  exit: Annotation({ reducer: (_, b) => b, default: () => null }),
  iter: Annotation({ reducer: (_, b) => b, default: () => 0 }),
  signature: Annotation({ reducer: (_, b) => b, default: () => '' }),
  headline: Annotation({ reducer: (_, b) => b, default: () => '' }),
  kind: Annotation({ reducer: (_, b) => b, default: () => '' }),
  // Set by `repair`, resolved by the next `check` — an attempt's outcome is only knowable
  // after the thing has been re-checked.
  pending: Annotation({ reducer: (_, b) => b, default: () => null }),
  repeats: Annotation({ reducer: (_, b) => b, default: () => 0 }),
  stopReason: Annotation({ reducer: (_, b) => b, default: () => '' }),
  missing: Annotation({ reducer: (_, b) => b, default: () => null }),
});

/**
 * A repair loop as a compiled subgraph: check -> (repair -> check)* -> END.
 *
 * driver:
 *   check(code)            -> { ok, output, exit, missing? }
 *   repair({ code, output, headline, history, iter }) -> new code | null
 *   ledger                 -> ProblemLedger (repeat detection + repair history)
 *   maxIter, phase, note(text), aborted()
 */
function buildRepairGraph(driver) {
  const { ledger, phase } = driver;
  const maxIter = Math.max(0, driver.maxIter == null ? 3 : driver.maxIter);

  const check = async (s) => {
    const res = await driver.check(s.code);
    const patch = { ok: !!res.ok, output: res.output || '', exit: res.exit == null ? null : res.exit, missing: res.missing || null };

    // Close out the attempt that led here, so the ledger records what a fix achieved
    // rather than merely that one happened.
    if (s.pending) {
      let outcome;
      let repeats = s.repeats;
      if (res.ok) outcome = 'resolved the failure';
      else {
        const now = ledger ? ledger.observe(phase, res.output) : null;
        if (now && now.signature === s.pending.signature) { outcome = 'the same failure occurred again'; repeats += 1; }
        else { outcome = 'produced a different failure: ' + ((now && now.headline) || 'unknown'); repeats = 0; }
      }
      if (ledger) ledger.recordAttempt(s.pending.signature, { action: s.pending.action, outcome, phase });
      patch.repeats = repeats;
      patch.pending = null;
      driver.note(`  attempt ${s.iter}: ${outcome}\n`);
    }

    if (res.ok) {
      if (ledger && s.signature) ledger.markResolved(s.signature);
      return { ...patch, signature: '', headline: '', stopReason: '' };
    }
    // Identify (or re-identify) the problem now being worked.
    if (ledger) {
      const p = ledger.observe(phase, res.output);
      patch.signature = p.signature;
      patch.headline = p.headline;
      patch.kind = p.kind;
    }
    return patch;
  };

  const repair = async (s) => {
    const history = ledger ? ledger.render(s.signature) : '';
    const before = s.code;
    const next = await driver.repair({
      code: s.code, output: s.output, headline: s.headline, kind: s.kind, history, iter: s.iter,
    });
    if (!next) return { stopReason: 'no-fix', iter: s.iter + 1 };
    return {
      code: next,
      iter: s.iter + 1,
      pending: { signature: s.signature, action: describeChange(before, next) },
    };
  };

  const route = (s) => {
    if (s.ok) return END;
    if (driver.aborted && driver.aborted()) return END;
    if (s.missing) return END;                       // a missing library is not a code bug
    if (s.stopReason === 'no-fix') return END;
    if (s.iter >= maxIter) return END;
    // The same problem has survived repeated repairs: the model is looping, so stop and
    // report it rather than spending the remaining budget on the same dead end.
    if (s.repeats >= STUCK_AFTER) return 'stuck';
    return 'repair';
  };

  const stuck = (s) => {
    driver.note(`  the same failure survived ${s.repeats} repair attempts — stopping to avoid repeating them\n`);
    return { stopReason: 'stuck' };
  };

  return new StateGraph(RepairState)
    .addNode('check', check)
    .addNode('repair', repair)
    .addNode('stuck', stuck)
    .addEdge(START, 'check')
    .addConditionalEdges('check', route, { repair: 'repair', stuck: 'stuck', [END]: END })
    .addEdge('repair', 'check')
    .addEdge('stuck', END)
    .compile();
}

// Parent graph: review -> compile repair -> runtime repair -> done. The two repair loops
// are compiled subgraphs invoked through adapter nodes, so their state stays isolated.
const FinalizeState = Annotation.Root({
  request: Annotation({ reducer: (_, b) => b, default: () => '' }),
  code: Annotation({ reducer: (_, b) => b, default: () => '' }),
  review: Annotation({ reducer: (_, b) => b, default: () => '' }),
  reviewIssues: Annotation({ reducer: (_, b) => b, default: () => false }),
  compileOk: Annotation({ reducer: (_, b) => b, default: () => false }),
  compileOut: Annotation({ reducer: (_, b) => b, default: () => '' }),
  compileIters: Annotation({ reducer: (_, b) => b, default: () => 0 }),
  compileStop: Annotation({ reducer: (_, b) => b, default: () => '' }),
  exit: Annotation({ reducer: (_, b) => b, default: () => null }),
  runIters: Annotation({ reducer: (_, b) => b, default: () => 0 }),
  runStop: Annotation({ reducer: (_, b) => b, default: () => '' }),
  missing: Annotation({ reducer: (_, b) => b, default: () => null }),
  aborted: Annotation({ reducer: (_, b) => b, default: () => false }),
});

/**
 * Compose the finalize graph. `ops` supplies the side-effecting work:
 *   review(request, code)  -> review text
 *   compileDriver / runDriver -> driver objects for buildRepairGraph
 *   aborted()
 */
function buildFinalizeGraph(ops) {
  const compileGraph = buildRepairGraph(ops.compileDriver);
  const runGraph = buildRepairGraph(ops.runDriver);

  const reviewNode = async (s) => {
    const r = await ops.review(s.request, s.code);
    return { review: r.text || '', reviewIssues: !!r.hasIssues };
  };

  // Review feedback is applied once, before compiling — it is advice about correctness,
  // not a failure to loop on. Compile and runtime faults are what get the repair loops.
  const reviewFixNode = async (s) => {
    if (ops.aborted()) return { aborted: true };
    const next = await ops.applyReview(s.request, s.code, s.review);
    return next ? { code: next } : {};
  };

  // Adapter: run the subgraph on its own narrow state, then fold only what the parent
  // needs back in. Never share the parent's schema (see the header note).
  const compileNode = async (s) => {
    if (ops.aborted()) return { aborted: true };
    const r = await compileGraph.invoke({ code: s.code }, { recursionLimit: 100 });
    const out = { code: r.code, compileOk: r.ok, compileOut: r.output, compileIters: r.iter, compileStop: r.stopReason };
    if (ops.onCompileEnd) await ops.onCompileEnd(out);
    return out;
  };

  const runNode = async (s) => {
    if (ops.aborted()) return { aborted: true };
    if (ops.onRunStart) await ops.onRunStart(s);
    const r = await runGraph.invoke({ code: s.code }, { recursionLimit: 100 });
    const out = { code: r.code, exit: r.exit, runIters: r.iter, runStop: r.stopReason, missing: r.missing };
    if (ops.onRunEnd) await ops.onRunEnd(out);
    return out;
  };

  return new StateGraph(FinalizeState)
    // Node names must differ from every state channel name — LangGraph refuses a graph
    // where a node shadows a channel (e.g. a `review` node beside a `review` channel).
    .addNode('doReview', reviewNode)
    .addNode('doReviewFix', reviewFixNode)
    .addNode('doCompile', compileNode)
    .addNode('doRun', runNode)
    .addEdge(START, 'doReview')
    .addConditionalEdges('doReview', (s) => (s.reviewIssues ? 'doReviewFix' : 'doCompile'), { doReviewFix: 'doReviewFix', doCompile: 'doCompile' })
    .addEdge('doReviewFix', 'doCompile')
    .addConditionalEdges('doCompile', (s) => (s.aborted ? END : 'doRun'), { doRun: 'doRun', [END]: END })
    .addEdge('doRun', END)
    .compile();
}

module.exports = { buildRepairGraph, buildFinalizeGraph, RepairState, FinalizeState, STUCK_AFTER };
