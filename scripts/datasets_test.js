'use strict';

// Model-free tests for document ingestion (src/main/datasets.js): validation gating,
// copy-into-project + manifest indexing, schema detection, filename de-duplication, the
// agent prompt block, and removal. Schema detection is forced down the pure-Node fallback
// path (by pointing at a non-existent interpreter), so this runs with no pandas / no Python
// dependency — deterministic in any environment.

const fs = require('fs');
const os = require('os');
const path = require('path');
const datasets = require('../src/main/datasets');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const NO_PY = path.join(os.tmpdir(), 'cicada-no-such-python'); // forces the Node fallback
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-ds-'));
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-src-'));
const w = (name, body) => { const p = path.join(src, name); fs.writeFileSync(p, body); return p; };

const csv = w('sales.csv', 'date,region,units,revenue\n2023-01-01,North,12,240.50\n2023-01-02,South,,140.00\n2023-01-03,West,30,610.25\n');
const recJson = w('users.json', '[{"id":1,"name":"Ada","active":true},{"id":2,"name":"Lin","active":false}]');
const objJson = w('config.json', '{"app":"cicada","version":"0.1.0","limits":{"maxTokens":100}}');
const exe = w('bad.exe', Buffer.from([0, 1, 2, 3, 4]));
const fakeCsv = w('binary.csv', Buffer.from([0x41, 0x00, 0x42])); // contains a NUL → not text
const fakeXlsx = w('fake.xlsx', Buffer.from([0x00, 0x01, 0x02, 0x03])); // no PK/OLE magic

console.log('validation');
ok('rejects unsupported extension', datasets.validate(exe).ok === false);
ok('rejects binary masquerading as csv', datasets.validate(fakeCsv).ok === false);
ok('rejects fake xlsx (bad magic bytes)', datasets.validate(fakeXlsx).ok === false);
ok('accepts a real csv', datasets.validate(csv).ok === true && datasets.validate(csv).kind === 'csv');
ok('accepts a real json', datasets.validate(recJson).kind === 'json');
ok('kindForName maps extensions', datasets.kindForName('x.xlsx') === 'excel' && datasets.kindForName('x.tsv') === 'csv');

(async () => {
  console.log('add (validate + copy + index + detect via Node fallback)');
  const res = await datasets.add(ws, [csv, recJson, objJson, exe], NO_PY);
  ok('three valid files added', res.added.length === 3);
  ok('unsupported file reported as error', res.errors.length === 1 && /Unsupported/.test(res.errors[0].error));
  ok('files copied into data/', fs.readdirSync(path.join(ws, 'data')).sort().join(',') === 'config.json,sales.csv,users.json');
  ok('manifest written', fs.existsSync(path.join(ws, '.garm', 'datasets.json')));
  ok('all added entries are ready', res.added.every((d) => d.status === 'ready'), JSON.stringify(res.added.map((d) => [d.name, d.status, d.error])));

  console.log('detected schema (Node fallback)');
  const byName = {};
  datasets.list(ws).forEach((d) => { byName[d.name] = d; });
  const salesCols = (byName['sales.csv'].schema.columns || []).map((c) => c.name);
  ok('csv columns detected', salesCols.join(',') === 'date,region,units,revenue', salesCols.join(','));
  ok('csv null counted in sampled column', byName['sales.csv'].schema.columns[2].nullCount >= 1);
  ok('json array detected as records', byName['users.json'].schema.format === 'records');
  ok('records columns detected', (byName['users.json'].schema.columns || []).map((c) => c.name).join(',') === 'id,name,active');
  ok('json object detected as object', byName['config.json'].schema.format === 'object');
  ok('object top-level keys detected', (byName['config.json'].schema.columns || []).some((c) => c.name === 'app'));

  console.log('list + exists annotation');
  const list = datasets.list(ws);
  ok('list returns three', list.length === 3);
  ok('all marked existing', list.every((d) => d.exists === true));

  console.log('agent prompt block');
  const block = datasets.formatForPrompt(list, 6000);
  ok('mentions a data path', /data\/sales\.csv/.test(block));
  ok('includes a load snippet', /pd\.read_csv\("data\/sales\.csv"\)/.test(block));
  ok('empty when there are no datasets', datasets.formatForPrompt([], 6000) === '');
  ok('skips missing files', datasets.formatForPrompt([{ file: 'data/x.csv', kind: 'csv', exists: false }], 6000) === '');

  console.log('filename de-duplication');
  await datasets.add(ws, [csv], NO_PY);
  ok('re-added file is de-duplicated', fs.existsSync(path.join(ws, 'data', 'sales (2).csv')));

  console.log('remove');
  const target = list[0];
  const rm = datasets.remove(ws, target.id);
  ok('remove reports success', rm.removed === true);
  ok('remove returns the on-disk path for trashing', rm.absPath && fs.existsSync(rm.absPath));
  ok('entry dropped from manifest', !datasets.list(ws).some((d) => d.id === target.id));

  // cleanup
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });

  console.log('');
  if (fail) { console.error('✗ ' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
  console.log('✓ ' + pass + ' passed, 0 failed');
})();
