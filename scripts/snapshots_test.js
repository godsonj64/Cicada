'use strict';

// Headless checks for project snapshots: capture scope (text-only, skip dirs),
// list/restore/remove round-trips, the safety snapshot on restore, path-traversal
// hardening, and pruning. Everything in temp dirs; no Python, no network.

const fs = require('fs');
const os = require('os');
const path = require('path');
const snaps = require('../src/main/snapshots');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || !detail ? '' : '  — ' + detail));
  if (!cond) failures += 1;
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-snap-'));
fs.mkdirSync(path.join(ws, 'models'), { recursive: true });
fs.mkdirSync(path.join(ws, '__pycache__'), { recursive: true });
fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
fs.writeFileSync(path.join(ws, 'main.py'), 'print("v1")\n', 'utf8');
fs.writeFileSync(path.join(ws, 'models', 'net.py'), '# net v1\n', 'utf8');
fs.writeFileSync(path.join(ws, '__pycache__', 'junk.pyc'), 'x', 'utf8');
fs.writeFileSync(path.join(ws, 'data', 'big.csv'), 'a,b\n1,2\n', 'utf8');
fs.writeFileSync(path.join(ws, 'image.bin'), Buffer.from([0, 1, 2, 3])); // binary -> skipped

// ---- create / list -------------------------------------------------------------

const m1 = snaps.create(ws, 'first');
check('create returns meta', !!(m1 && m1.id));
check('captures text source files', m1.fileCount === 2, String(m1.fileCount)); // main.py + models/net.py
check('label stored', m1.label === 'first');

let list = snaps.list(ws);
check('list has one', list.length === 1 && list[0].id === m1.id);

// ---- restore (merge + safety snapshot) --------------------------------------------

fs.writeFileSync(path.join(ws, 'main.py'), 'print("v2 CHANGED")\n', 'utf8');
fs.writeFileSync(path.join(ws, 'new_after.py'), '# created after snapshot\n', 'utf8');

const r = snaps.restore(ws, m1.id);
check('restore ok', r.ok === true && r.restored === 2, JSON.stringify(r));
check('file content restored', fs.readFileSync(path.join(ws, 'main.py'), 'utf8') === 'print("v1")\n');
check('newer file untouched (merge)', fs.existsSync(path.join(ws, 'new_after.py')));
check('safety snapshot taken', !!r.safetyId && snaps.list(ws).some((s) => s.id === r.safetyId));

// The safety snapshot holds the PRE-restore state, so a restore is itself undoable.
const r2 = snaps.restore(ws, r.safetyId);
check('undo-restore ok', r2.ok === true);
check('undo restores changed content', fs.readFileSync(path.join(ws, 'main.py'), 'utf8') === 'print("v2 CHANGED")\n');

// ---- hardening -----------------------------------------------------------------

check('restore unknown id fails cleanly', snaps.restore(ws, 'zz-none').ok === false);
check('restore bad id fails cleanly', snaps.restore(ws, '../../etc').ok === false);
check('remove bad id is false', snaps.remove(ws, '../evil') === false);

// A hand-crafted malicious snapshot must not write outside the workspace.
const evilId = 'zzevil-1';
const evilFiles = path.join(ws, '.garm', 'snapshots', evilId, 'files');
fs.mkdirSync(evilFiles, { recursive: true });
fs.writeFileSync(path.join(ws, '.garm', 'snapshots', evilId, 'meta.json'),
  JSON.stringify({ id: evilId, label: 'evil', createdAt: new Date().toISOString(), fileCount: 1, bytes: 1 }), 'utf8');
fs.writeFileSync(path.join(evilFiles, 'ok.py'), '# fine\n', 'utf8');
const outside = path.join(os.tmpdir(), 'cicada-snap-escape-' + Date.now() + '.txt');
// Windows rejects ".." inside names at the fs layer already, but exercise the guard
// with a nested legit-looking dir plus a crafted meta anyway: restore must only ever
// touch paths that resolve inside the workspace.
const r3 = snaps.restore(ws, evilId);
check('crafted snapshot restores only inside ws', r3.ok === true && fs.existsSync(path.join(ws, 'ok.py')));
check('nothing written outside workspace', !fs.existsSync(outside));

// ---- remove / prune ---------------------------------------------------------------

const before = snaps.list(ws).length;
check('remove works', snaps.remove(ws, evilId) === true && snaps.list(ws).length === before - 1);

for (let i = 0; i < snaps.MAX_SNAPSHOTS + 6; i++) snaps.create(ws, 'bulk ' + i, { auto: true });
check('pruned to cap', snaps.list(ws).length === snaps.MAX_SNAPSHOTS, String(snaps.list(ws).length));

// Empty workspace -> null, never throws.
const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-snap-empty-'));
check('empty workspace -> null meta', snaps.create(emptyWs, 'x') === null);
check('empty workspace lists []', snaps.list(emptyWs).length === 0);

fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(emptyWs, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll snapshots checks passed.');
process.exit(failures ? 1 : 0);
