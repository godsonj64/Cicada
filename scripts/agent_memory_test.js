'use strict';

// Model-free tests for the problem ledger: signature stability (the same fault must hash
// alike across runs), identity preservation (different faults must not collide), and the
// repair-history block that stops the model repeating a failed fix.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProblemLedger, classify, describeChange } = require('../src/main/agent-memory');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

console.log('classify — signature stability');
// The same fault, reported from a different path/line/run. Signatures must match, or the
// ledger cannot tell that a repair failed and the loop goes amnesiac again.
const tb1 = 'Traceback (most recent call last):\n  File "/Users/a/proj/main.py", line 12, in <module>\n    x = int(v)\nValueError: invalid literal for int() with base 10: \'abc\'';
const tb2 = 'Traceback (most recent call last):\n  File "/Users/b/other/main.py", line 481, in <module>\n    x = int(v)\nValueError: invalid literal for int() with base 10: \'zzz\'';
ok('same fault, different path/line/literal -> same signature',
  classify('runtime', tb1).signature === classify('runtime', tb2).signature,
  classify('runtime', tb1).signature + ' vs ' + classify('runtime', tb2).signature);
ok('kind is runtime', classify('runtime', tb1).kind === 'runtime');
ok('headline names the exception', /ValueError/.test(classify('runtime', tb1).headline));

const tb3 = 'Traceback (most recent call last):\n  File "main.py", line 3\nKeyError: \'name\'';
ok('a different exception -> different signature',
  classify('runtime', tb1).signature !== classify('runtime', tb3).signature);

console.log('classify — missing dependency keeps module identity');
const m1 = "ModuleNotFoundError: No module named 'torch'";
const m2 = "ModuleNotFoundError: No module named 'pandas'";
ok('missing-dep kind', classify('runtime', m1).kind === 'missing-dep');
ok('module name preserved in signature', classify('runtime', m1).signature === 'missing-dep:torch', classify('runtime', m1).signature);
ok('different modules do NOT collide', classify('runtime', m1).signature !== classify('runtime', m2).signature);

console.log('classify — syntax');
const syn = '  File "main.py", line 4\n    def f(\n         ^\nSyntaxError: unexpected EOF while parsing';
ok('syntax kind detected', classify('compile', syn).kind === 'syntax');
ok('syntax signature is stable', classify('compile', syn).signature === classify('compile', syn.replace('line 4', 'line 99')).signature);

console.log('describeChange');
ok('identical code is reported as no change', /no change/.test(describeChange('a = 1', 'a = 1')));
ok('added import is named', /import torch/.test(describeChange('a = 1', 'import torch\na = 1')));
ok('counts added and removed', /\+\d+\/-\d+ lines/.test(describeChange('a = 1', 'b = 2')));

console.log('ledger — repeat detection and repair history');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-ledger-'));
const led = new ProblemLedger(dir);
const p1 = led.observe('runtime', tb1);
ok('first sighting has count 1', p1.count === 1);
ok('no history to render yet', led.render(p1.signature) === '');

led.recordAttempt(p1.signature, { action: 'wrapped int(v) in try/except', outcome: 'still failed with the same ValueError', phase: 'run' });
const p2 = led.observe('runtime', tb2);   // same fault recurs
ok('recurrence increments the same record', p2.count === 2 && p2.signature === p1.signature);

const block = led.render(p1.signature);
ok('history block reports the recurrence', /occurred 2 times/.test(block), block);
ok('history block lists what was tried', /wrapped int\(v\) in try\/except/.test(block));
ok('history block forbids repeating it', /do NOT repeat/i.test(block));
ok('history block asks for a different approach', /different approach/i.test(block));

console.log('ledger — persistence and resolution');
led.markResolved(p1.signature);
ok('resolved problems drop out of known issues', !/invalid literal/.test(led.renderKnownIssues(5)));
const led2 = new ProblemLedger(dir);           // reload from disk
ok('ledger survives a restart', led2.find(p1.signature) !== null);
ok('attempt history survives a restart', led2.find(p1.signature).attempts.length === 1);

const led3 = new ProblemLedger(dir);
led3.observe('runtime', tb3);
ok('unresolved issues are surfaced to a new run', /KeyError/.test(led3.renderKnownIssues(5)), led3.renderKnownIssues(5));

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
