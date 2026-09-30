'use strict';

// Integration tests for the agent pipeline with the MODEL and the PROGRAM RUNNER scripted
// (compilation is real py_compile). Drives the public API — run / refine — and asserts the
// behaviours that make generation and execution seamless: execution-first review with
// rollback, problem-aware repair, never ending on a regression, missing-library handling,
// interactive programs, context-overflow recovery, and one-request-at-a-time.

const fs = require('fs');
const os = require('os');
const path = require('path');
const llm = require('../src/main/llm');
const { Pipeline, describeFailure } = require('../src/main/pipeline');
const { ContextMemory } = require('../src/main/memory');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const PY = (code) => '```python\n' + code + '\n```';
const TB = (line, name) => `Traceback (most recent call last):\n  File "main.py", line ${line}\nNameError: name '${name}' is not defined`;
const RUN_OK = { code: 0, stderr: '', stdout: 'hello\n', images: [] };
const CRASH = (name) => ({ code: 1, stderr: TB(3, name || 'foo'), stdout: '', images: [] });

// The scripted model: answers by what each prompt asks for, and records every prompt.
let script = null;
llm.streamChat = async (_url, { messages, onDelta, onMeta }) => {
  const prompt = messages[messages.length - 1].content;
  script.calls.push(prompt);
  let text;
  if (script.overflowOnce && /Implement the program/.test(prompt) && !script.overflowed) {
    script.overflowed = true;
    const e = new Error('LLM request failed (400): request (9000 tokens) exceeds the available context size (8192 tokens)');
    e.code = 'context_overflow'; e.nPrompt = 9000; e.nCtx = 8192;
    throw e;
  }
  if (/Analyze this request/.test(prompt)) text = 'Goal: do the thing';
  else if (/Design a Python solution/.test(prompt)) text = 'Approach: simple';
  else if (/Implement the program/.test(prompt)) text = script.generate;
  else if (/Check this Python program against the request/.test(prompt)) text = script.reviews.length > 1 ? script.reviews.shift() : script.reviews[0];
  else if (/Fix the Python program/.test(prompt)) text = script.fixes.length > 1 ? script.fixes.shift() : script.fixes[0];
  else if (/brief plan/.test(prompt)) text = '- change it';
  else if (/Apply the requested change/.test(prompt)) text = script.apply;
  else text = 'ok';
  if (onDelta) onDelta(text);
  if (onMeta) onMeta({ finishReason: 'stop' });
  return text;
};

function setup(opts) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-pipe-'));
  script = {
    calls: [], overflowed: false, overflowOnce: !!opts.overflowOnce,
    generate: opts.generate || PY('print("hello")'),
    reviews: opts.reviews || ['NO ISSUES'],
    fixes: opts.fixes || [PY('print("fixed")')],
    apply: opts.apply || PY('print("changed")'),
  };
  const runs = (opts.runs || [RUN_OK]).slice();
  const seen = { events: [], runOpts: [], installs: [] };
  const memory = opts.memory ? new ContextMemory(ws) : null;
  const p = new Pipeline({
    config: { workspaceDir: ws, pythonPath: 'python3', maxFixIterations: opts.maxFix || 3, runTimeoutMs: 1000, contextSize: 8192, maxTokens: 4096, ...(opts.config || {}) },
    baseUrl: 'http://stub',
    memory,
    emit: (e, payload) => seen.events.push({ e, payload }),
    runFile: async (_file, o) => { seen.runOpts.push(o || {}); return runs.length > 1 ? runs.shift() : runs[0]; },
    installPackage: opts.install ? async (pkg) => { seen.installs.push(pkg); return true; } : null,
  });
  const done = () => (seen.events.find((x) => x.e === 'pipeline:done') || {}).payload;
  const stageDone = (id) => seen.events.filter((x) => x.e === 'stage:done' && x.payload.id === id).map((x) => x.payload.answer).pop() || '';
  const fixPrompts = () => script.calls.filter((c) => /Fix the Python program/.test(c));
  const onDisk = () => fs.readFileSync(path.join(ws, 'main.py'), 'utf8');
  return { p, seen, ws, done, stageDone, fixPrompts, onDisk, memory, cleanup: () => fs.rmSync(ws, { recursive: true, force: true }) };
}

(async () => {
  console.log('clean path — generate, compile, run, review');
  {
    const t = setup({});
    await t.p.run('print hello');
    ok('pipeline:done reports a clean run', t.done() && t.done().exit === 0 && t.done().compiled === true, JSON.stringify(t.done()));
    ok('no repair prompts when everything passes', t.fixPrompts().length === 0);
    const order = t.seen.events.filter((x) => x.e === 'stage:done').map((x) => x.payload.id);
    ok('review runs after the program has run', order.indexOf('run') >= 0 && order.lastIndexOf('review') > order.indexOf('run'), order.join(','));
    ok('verification runs have no keyboard (stdin EOF)', t.seen.runOpts[0].stdin === 'eof', JSON.stringify(t.seen.runOpts[0]));
    const review = script.calls.find((c) => /Check this Python program/.test(c)) || '';
    ok('the review sees the real program output', /OUTPUT[\s\S]*hello/.test(review), review.slice(-200));
    t.cleanup();
  }

  console.log('extraction — a reply with an install snippet before the code');
  {
    const t = setup({ generate: 'Install:\n```bash\npip install numpy\n```\nThen:\n```python\nprint("real program")\n```' });
    await t.p.run('print something');
    ok('the python block is written, not the prose between blocks', /real program/.test(t.onDisk()), t.onDisk());
    t.cleanup();
  }

  console.log('runtime repair — problem-aware');
  {
    const t = setup({ runs: [CRASH('foo'), CRASH('foo'), RUN_OK], fixes: [PY('print("v1")'), PY('print("v2")')] });
    await t.p.run('print things');
    ok('ends in a working program', t.done().exit === 0, JSON.stringify(t.done()));
    const data = JSON.parse(fs.readFileSync(path.join(t.ws, '.garm', 'problems.json'), 'utf8'));
    ok('the failure reached the on-disk ledger', data.problems.length === 1 && /NameError/.test(data.problems[0].headline), JSON.stringify(data.problems.map((p) => p.headline)));
    const second = t.fixPrompts()[1] || '';
    ok('the second repair prompt carries the repair history', /REPAIR HISTORY/.test(second) && /do NOT repeat/i.test(second), second.slice(0, 120));
    ok('re-runs keep the console (the failing output stays visible)', t.seen.runOpts[1] && t.seen.runOpts[1].clear === false, JSON.stringify(t.seen.runOpts));
    t.cleanup();
  }
  {
    const t = setup({ runs: [{ code: 2, stderr: 'usage: main.py [-h] --input INPUT\nmain.py: error: the following arguments are required: --input\n', stdout: '', images: [] }, RUN_OK] });
    await t.p.run('a cli tool');
    ok('a non-zero exit without a traceback (argparse) is repaired', t.fixPrompts().length === 1 && t.done().exit === 0, `fixes=${t.fixPrompts().length}`);
    t.cleanup();
  }

  console.log('never end on a regression');
  {
    // The runtime repair returns code that does not compile, and so does the syntax fix.
    const t = setup({ maxFix: 1, runs: [CRASH('foo')], generate: PY('x = 1\nprint(foo)'), fixes: [PY('def broken(:\n    pass'), PY('def still broken(:')] });
    await t.p.run('print things');
    ok('the compiling version is back on disk', t.onDisk().trim() === 'x = 1\nprint(foo)', t.onDisk());
    ok('reported as compiled (not left broken)', t.done().compiled === true, JSON.stringify(t.done()));
    t.cleanup();
  }

  console.log('missing libraries');
  {
    const t = setup({ runs: [{ code: 1, stderr: "ModuleNotFoundError: No module named 'torch'", stdout: '', images: [] }] });
    await t.p.run('use torch');
    ok('a heavy framework is never "repaired" by rewriting', t.fixPrompts().length === 0, 'fixes=' + t.fixPrompts().length);
    ok('it is surfaced to the UI with a pip command', t.seen.events.some((x) => x.e === 'pipeline:missingModule' && x.payload.module === 'torch'));
    ok('pipeline:done names the missing package', t.done().missing && t.done().missing.pkg === 'torch');
    t.cleanup();
  }
  {
    const t = setup({ install: true, runs: [{ code: 1, stderr: "ModuleNotFoundError: No module named 'sklearn'", stdout: '', images: [] }, RUN_OK] });
    await t.p.run('classify iris');
    ok('a common library is installed automatically', t.seen.installs.join() === 'scikit-learn', t.seen.installs.join());
    ok('...and the program re-runs to success without a rewrite', t.done().exit === 0 && t.fixPrompts().length === 0);
    t.cleanup();
  }
  {
    const t = setup({ runs: [{ code: 1, stderr: "ModuleNotFoundError: No module named 'sine_utils'", stdout: '', images: [] }, RUN_OK] });
    await t.p.run('print a table of sine values');
    ok('an unknown module the model invented is repaired, not pip-installed', t.fixPrompts().length === 1 && !t.seen.events.some((x) => x.e === 'pipeline:missingModule'));
    ok('...with guidance not to depend on it', /not an installed library/.test(t.fixPrompts()[0] || ''));
    t.cleanup();
  }

  console.log('failure reports a small model can act on');
  {
    // Regression from real-model runs: the NameError sat under numpy warnings and absolute
    // temp paths, and the "repair" clamped the warning instead of adding the import.
    const ws = '/tmp/cicada-ws';
    const stderr = `${ws}/mandelbrot.py:9: RuntimeWarning: overflow encountered in square\n  z = z**2 + c\n` +
      `Traceback (most recent call last):\n  File "${ws}/main.py", line 9, in <module>\n    plot(z)\n` +
      `  File "${ws}/mandelbrot.py", line 12, in plot\n    plt.imshow(z)\nNameError: name 'plt' is not defined`;
    const f = describeFailure(stderr, ws);
    ok('the summary leads with the actual error', /^ERROR: NameError: name 'plt'/.test(f.summary), f.summary);
    ok('...names the file, line and function', /WHERE: mandelbrot\.py, line 12, in plot\(\)/.test(f.summary), f.summary);
    ok('...and says exactly which import is missing', /import matplotlib\.pyplot as plt/.test(f.summary));
    ok('warnings are set apart from the traceback', /RuntimeWarning/.test(f.warnings) && !/RuntimeWarning/.test(f.traceback));
    ok('paths are project-relative', !/\/tmp\/cicada-ws/.test(f.summary + f.traceback), f.traceback);
    const t = setup({ runs: [{ code: 1, stderr, stdout: '', images: [] }, RUN_OK] });
    await t.p.run('print things');
    const fb = t.fixPrompts()[0] || '';
    ok('the repair prompt carries the summary', /ERROR: NameError/.test(fb) && /HINT:/.test(fb), fb.slice(-700));
    t.cleanup();
  }
  {
    // Cross-file mismatches (real-model failures in repo mode): the hint states what the
    // other file actually defines, instead of leaving the model to guess.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-xf-'));
    fs.writeFileSync(path.join(ws, 'utils.py'), 'def make_signal(n):\n    return n\n\ndef plot_signals(t, raw,\n                 sampling_rate):\n    pass\n');
    const tb = (e) => `Traceback (most recent call last):\n  File "${ws}/main.py", line 2, in <module>\n    go()\n${e}`;
    const imp = describeFailure(tb(`ImportError: cannot import name 'generate_sine_wave' from 'utils' (${ws}/utils.py)`), ws).summary;
    ok('a wrong import name gets the names the module really defines', /utils\.py has no `generate_sine_wave`/.test(imp) && /`make_signal`, `plot_signals`/.test(imp), imp);
    const sig = describeFailure(tb("TypeError: plot_signals() missing 1 required positional argument: 'sampling_rate'"), ws).summary;
    ok('a wrong call gets the real signature', /def plot_signals\(t, raw, sampling_rate\):/.test(sig), sig);
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('judging a run by its result, not just its exit code');
  {
    // Regression from a real-model run: main.py was just `import mandelbrot`, whose work sat
    // behind that module's own __main__ guard — exit 0, nothing drawn, and the reviewer
    // called it fine.
    const silent = { code: 0, stderr: '', stdout: '', images: [] };
    const t = setup({ runs: [silent, RUN_OK] });
    await t.p.run('compute the mandelbrot escape counts');
    ok('a run that does nothing observable is repaired', t.fixPrompts().length === 1 && /did nothing observable/.test(t.fixPrompts()[0]), t.fixPrompts()[0] && t.fixPrompts()[0].slice(-400));
    t.cleanup();
  }
  {
    const img = { code: 0, stderr: '', stdout: '', images: ['/tmp/_garm_plot_01.png'] };
    const t = setup({ runs: [RUN_OK, img] });
    await t.p.run('plot a sine wave');
    ok('a plot request that draws nothing is repaired', t.fixPrompts().length === 1 && /produced NO figure/.test(t.fixPrompts()[0]));
    ok('...and passes once the figure appears', t.done().exit === 0 && t.fixPrompts().length === 1);
    t.cleanup();
  }
  {
    const logged = { code: 0, stderr: 'INFO:root:processed 42 rows\n', stdout: '', images: [] };
    const t = setup({ runs: [logged] });
    await t.p.run('count the rows in the log');
    ok('output reported through logging (stderr) counts as output', t.fixPrompts().length === 0 && t.done().exit === 0);
    t.cleanup();
    const warned = { code: 0, stderr: '/x/main.py:3: DeprecationWarning: old api\n  f()\n', stdout: '', images: [] };
    const u = setup({ runs: [warned, RUN_OK] });
    await u.p.run('count the rows');
    ok('...but warnings alone do not', u.fixPrompts().length === 1);
    u.cleanup();
  }
  {
    const t = setup({ runs: [RUN_OK] });
    await t.p.run('figure out the first prime above 1000');
    ok('"figure out" is not a plot request', t.fixPrompts().length === 0 && t.done().exit === 0);
    t.cleanup();
  }

  console.log('keyboard input');
  {
    const eof = { code: 1, stderr: 'Traceback (most recent call last):\n  File "main.py", line 1\nEOFError: EOF when reading a line', stdout: 'Name? ', images: [] };
    const t = setup({ runs: [eof, RUN_OK] });
    await t.p.run('print the first 10 primes');
    ok('a gratuitous input() is repaired away', t.fixPrompts().length === 1 && /Remove the input\(\) calls/.test(t.fixPrompts()[0]));
    t.cleanup();
    const u = setup({ runs: [eof] });
    await u.p.run('ask the user for their name and greet them');
    ok('an interactive program is not "repaired"', u.fixPrompts().length === 0);
    ok('...it is handed to the user to run interactively', u.done().needsInput === true, JSON.stringify(u.done()));
    u.cleanup();
  }

  console.log('execution-first review');
  {
    const t = setup({ reviews: ['1. It prints the wrong greeting.'], fixes: [PY('print("hello, world")')], runs: [RUN_OK, RUN_OK] });
    await t.p.run('print hello, world');
    ok('a review fix that still runs is kept', /hello, world/.test(t.onDisk()) && /✓ Applied/.test(t.stageDone('review')), t.stageDone('review'));
    t.cleanup();
  }
  {
    const t = setup({ generate: PY('print("hello")'), reviews: ['1. Add a greeting.'], fixes: [PY('print(greeting)')], runs: [RUN_OK, CRASH('greeting'), RUN_OK] });
    await t.p.run('print hello');
    ok('a review fix that breaks the program is rolled back', t.onDisk().trim() === 'print("hello")', t.onDisk());
    ok('...and the user is told why', /working version was kept/.test(t.stageDone('review')), t.stageDone('review'));
    ok('...and the result is still a working program', t.done().exit === 0, JSON.stringify(t.done()));
    t.cleanup();
  }
  {
    const t = setup({ runs: [CRASH('foo')], maxFix: 1, fixes: [PY('print(foo)')] });
    await t.p.run('print things');
    ok('a program that does not run is not reviewed', !script.calls.some((c) => /Check this Python program/.test(c)) && /Skipped/.test(t.stageDone('review')));
    t.cleanup();
  }

  console.log('context window');
  {
    const t = setup({ overflowOnce: true, memory: true });
    t.memory.addFact('always use numpy');
    await t.p.run('print hello');
    ok('a prompt that does not fit is retried trimmed, not failed', t.done() && t.done().exit === 0 && script.overflowed, JSON.stringify(t.done()));
    const gens = script.calls.filter((c) => /Implement the program/.test(c));
    ok('...the retry drops the optional context', gens.length === 2 && /always use numpy/.test(gens[0]) && !/always use numpy/.test(gens[1]));
    t.cleanup();
  }

  console.log('memory hygiene');
  {
    const t = setup({ memory: true });
    t.memory.setSummary('A previous sine-wave program');
    t.memory.addFact('data lives in data/sales.csv');
    t.p.ledger.observe('runtime', TB(3, 'old_thing'));
    await t.p.run('print hello');
    const evalPrompt = script.calls.find((c) => /Analyze this request/.test(c)) || '';
    ok('a new program gets pinned facts', /data\/sales\.csv/.test(evalPrompt));
    ok('...but not the previous program\'s summary', !/sine-wave/.test(evalPrompt), evalPrompt.slice(0, 200));
    ok('...nor its old failures', !/old_thing/.test(evalPrompt));
    ok('old failures are retired when a new program replaces them', !/old_thing/.test(t.p.ledger.renderKnownIssues(5)));
    t.cleanup();
  }

  console.log('one request at a time');
  {
    const t = setup({});
    const first = t.p.run('print hello');
    let rejected = null;
    await t.p.run('print again').catch((e) => { rejected = e; });
    await first;
    ok('a second request while one is running is refused, not interleaved', rejected && /already working/.test(rejected.message));
    ok('...and the first still completes', t.done() && t.done().exit === 0);
    t.cleanup();
  }

  console.log('refine keeps an interactive program interactive');
  {
    const eof = { code: 1, stderr: 'EOFError: EOF when reading a line', stdout: '', images: [] };
    const t = setup({ runs: [eof], apply: PY('a = float(input("a? "))\nb = float(input("b? "))\nprint(a ** b)') });
    await t.p.refine('add a power operation', 'a = float(input("a? "))\nb = float(input("b? "))\nprint(a + b)');
    ok('existing input() marks the program interactive', t.done().needsInput === true && t.fixPrompts().length === 0, JSON.stringify(t.done()));
    t.cleanup();
  }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
