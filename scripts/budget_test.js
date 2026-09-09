'use strict';

// Tests for the token-budget accounting behind "cut off before completing … (token budget
// exhausted)". The user-facing complaint was that raising Context size changed nothing, so
// these assert that the budget actually tracks the setting and that the error explains
// itself with real numbers instead of repeating advice that did not work.

const { Pipeline } = require('../src/main/pipeline');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
const mk = (contextSize, maxTokens) => new Pipeline({
  config: { workspaceDir: '/tmp/cicada-budget', contextSize, maxTokens: maxTokens || contextSize, maxFixIterations: 1 },
  baseUrl: '', emit() {}, runFile: async () => ({ code: 0 }),
});
const msg = (chars) => [{ role: 'user', content: 'x'.repeat(chars) }];

console.log('_codeBudget tracks the context setting');
{
  const small = mk(8192), big = mk(32768);
  const b1 = small._codeBudget(msg(10000));
  const b2 = big._codeBudget(msg(10000));
  ok('a larger context yields a larger budget for the same prompt', b2 > b1, `${b1} vs ${b2}`);
  ok('the budget is recorded for diagnostics', small.lastBudget && small.lastBudget.contextSize === 8192);
  ok('prompt cost is estimated from the messages', small.lastBudget.promptTokens > 2000, String(small.lastBudget.promptTokens));
}
{
  // A prompt that swallows the whole window: room goes negative and the floor asks for
  // more than remains, which is exactly when llama-server shifts the context and truncates.
  const p = mk(8192);
  p._codeBudget(msg(40000));
  ok('an oversized prompt leaves negative room', p.lastBudget.room < 0, String(p.lastBudget.room));
  ok('...and the floor still applies', p.lastBudget.budget === 1024, String(p.lastBudget.budget));
  const help = p._budgetHelp();
  ok('the explanation reports the context size', /8,192/.test(help), help);
  ok('the explanation says the prompt was dropped', /context window was shifted/.test(help), help);
  ok('the explanation says the setting now applies immediately', /takes effect immediately/.test(help));
}
{
  const p = mk(32768);
  p._codeBudget(msg(4000));
  const help = p._budgetHelp();
  ok('a healthy budget reports no context shift', !/context window was shifted/.test(help), help);
  ok('...and still names the numbers', /32,768/.test(help));
}
ok('help is safe before any budget was computed', typeof mk(8192)._budgetHelp() === 'string');

console.log('repo dump scales with the window');
{
  // The old fixed 16k dump was ~56% of an 8k window on its own, leaving too little room to
  // write whole files back — so the dump is now proportional rather than fixed.
  ok('the dump is proportional, not the old fixed 16k', mk(8192)._repoBudgetChars() < 16000 && mk(8192)._repoBudgetChars() > 6000, String(mk(8192)._repoBudgetChars()));
  ok('a tiny window still shows something', mk(2048)._repoBudgetChars() >= 6000);
  ok('a larger window shows more of the project', mk(32768)._repoBudgetChars() > mk(8192)._repoBudgetChars());
  // The dump must never crowd out the answer.
  for (const ctx of [8192, 16384, 32768, 65536]) {
    const p = mk(ctx);
    const dumpTokens = p._repoBudgetChars() / 3.5;
    ok(`ctx=${ctx}: the dump stays under half the window`, dumpTokens < ctx * 0.5, `${Math.round(dumpTokens)} of ${ctx}`);
  }
}

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
