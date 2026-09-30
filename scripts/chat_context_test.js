'use strict';

// Tests for what the chat model is told about the active project (src/main/chat-context.js).
// Regression: after switching projects, "give me a full overview" described the PREVIOUS
// project (its conversation came along), and on a fresh conversation it described Cicada
// itself — the prompt led with Cicada and never said the project was new.

const fs = require('fs');
const os = require('os');
const path = require('path');
const projects = require('../src/main/projects');
const { ContextMemory } = require('../src/main/memory');
const chat = require('../src/main/chat-context');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-chatctx-'));
const cfg = { projectsRoot: root };

console.log('which project "this" means');
const fresh = projects.create(cfg, 'fresh').path;
let sys = chat.buildChatSystem({ workspaceDir: fresh, budget: 9000 });
ok('the prompt names the user\'s project', /"fresh" project/.test(sys) && /THE USER'S PROJECT: fresh/.test(sys));
ok('...and says "this" / "overview" mean that project, not Cicada', /overview, they mean the "fresh" project/.test(sys) && /not Cicada/.test(sys));
ok('...and forbids claiming there is no context', /never claim you have no context/.test(sys));

console.log('project state');
ok('a brand-new project is reported as NEW (starter main.py only)', /State: this is a NEW project/.test(sys), sys.slice(0, 900));
ok('...with the starter file itself included', /--- main\.py ---[\s\S]*Hello from Cicada/.test(sys));
const empty = path.join(root, 'empty');
fs.mkdirSync(empty);
ok('an empty folder is reported as EMPTY', /State: this project is EMPTY/.test(chat.buildChatSystem({ workspaceDir: empty, budget: 9000 })));

const built = projects.create(cfg, 'built').path;
fs.writeFileSync(path.join(built, 'main.py'), 'from stats import mean\nprint(mean([1, 2, 3]))\n');
fs.writeFileSync(path.join(built, 'stats.py'), 'def mean(xs):\n    return sum(xs) / len(xs)\n');
const memory = new ContextMemory(built);
memory.setSummary('Compute summary statistics for a list of numbers');
memory.addFact('Keep it dependency-free');
sys = chat.buildChatSystem({ workspaceDir: built, budget: 9000, memory });
ok('a project with code is not called new', !/NEW project|EMPTY/.test(sys));
ok('...its contents are summarised', /Contents: 2 file\(s\), 2 of them Python; entry point main\.py/.test(sys));
ok('...with what the agent built it to do (project memory)', /Compute summary statistics/.test(sys));
ok('...and the pinned facts', /Keep it dependency-free/.test(sys));
ok('...and every file', /--- main\.py ---/.test(sys) && /--- stats\.py ---/.test(sys));
ok('a new project never shows an old program\'s summary', !/summary statistics/.test(chat.buildChatSystem({ workspaceDir: fresh, budget: 9000, memory })));

console.log('budget');
fs.writeFileSync(path.join(built, 'big.py'), '# ' + 'x'.repeat(60000) + '\n');
sys = chat.buildChatSystem({ workspaceDir: built, budget: 4000 });
ok('the snapshot stays within its budget', sys.length < 4000 + 2500, 'length=' + sys.length);

console.log('history and attachments');
const h = [{ role: 'user', content: 'a'.repeat(500) }, { role: 'assistant', content: 'b'.repeat(500) }, { role: 'user', content: 'latest' }];
ok('trimHistory keeps the newest turns that fit', JSON.stringify(chat.trimHistory(h, 600).map((m) => m.content.slice(0, 1))) === '["b","l"]');
ok('...and always the latest question', chat.trimHistory(h, 1).length === 1);
ok('an editor selection is attached to the question',
  /\[Selected lines 2–3 of stats\.py\]/.test(chat.decorateUserMessage('why?', { file: 'stats.py', selection: { startLine: 2, endLine: 3, text: 'x' } })));

fs.rmSync(root, { recursive: true, force: true });
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
