'use strict';

// Model-free tests for the persistent context memory (src/main/memory.js):
// it must survive a reload from disk, de-duplicate facts, render a non-empty
// injection block, and clear cleanly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ContextMemory } = require('../src/main/memory');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'garm-mem-'));

console.log('record + persist');
let m = new ContextMemory(ws);
ok('starts empty', m.isEmpty());
ok('renders nothing when empty', m.render() === '');
m.setSummary('A CSV column-average plotter');
m.record('create', 'Built program for: plot average of each numeric column');
m.addFact('input file is data.csv');
m.addFact('uses matplotlib for the bar chart');
ok('memory.json was written', fs.existsSync(path.join(ws, '.garm', 'memory.json')));

console.log('reload from disk (real, cross-session memory)');
const m2 = new ContextMemory(ws);
ok('summary survives reload', m2.snapshot().summary === 'A CSV column-average plotter');
ok('facts survive reload', m2.snapshot().facts.length === 2);
ok('events survive reload', m2.snapshot().events.length === 1);

console.log('rendered block injected into prompts');
const block = m2.render();
ok('render is non-empty', block.length > 0);
ok('render names the project', /CSV column-average plotter/.test(block));
ok('render lists a pinned fact', /input file is data\.csv/.test(block));
ok('render lists recent activity', /\[create\]/.test(block));

console.log('fact de-duplication (newest wins, case-insensitive)');
m2.addFact('Input file is data.csv'); // same fact, different case
ok('duplicate fact not added twice', m2.snapshot().facts.length === 2);

console.log('removeFact');
const before = m2.snapshot().facts.length;
m2.removeFact(0);
ok('removeFact drops one', m2.snapshot().facts.length === before - 1);

console.log('event cap holds');
for (let i = 0; i < 60; i++) m2.record('run', 'run #' + i);
ok('events capped at 24', m2.snapshot().events.length === 24);
ok('cap keeps the most recent', m2.snapshot().events.slice(-1)[0].text === 'run #59');

console.log('clear');
m2.clear();
ok('clear empties memory', m2.isEmpty());
const m3 = new ContextMemory(ws);
ok('clear persisted to disk', m3.isEmpty());

console.log('corrupt file does not crash');
fs.writeFileSync(path.join(ws, '.garm', 'memory.json'), '{ not json', 'utf8');
const m4 = new ContextMemory(ws);
ok('recovers from corrupt memory.json', m4.isEmpty());

try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) { /* ignore */ }
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
