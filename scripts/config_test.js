'use strict';

// Tests for config loading: GARM_HOME isolation and the one-time settings migration.
// Runs entirely inside a temp GARM_HOME, so the real ~/GARM Code/config.json is never read
// or written.

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-config-'));
process.env.GARM_HOME = home;
const configMod = require('../src/main/config');
const { defaultModelPath } = require('../src/main/llama-installer');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
const writeCfg = (obj) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(obj), 'utf8');

console.log('GARM_HOME isolation');
ok('config lives under GARM_HOME', configMod.configPath() === path.join(home, 'config.json'), configMod.configPath());
ok('projects and workspace default under GARM_HOME',
  configMod.load().projectsRoot.startsWith(home) && configMod.load().workspaceDir.startsWith(home));
ok('a fresh install gets the 16k context', configMod.load().contextSize === 16384);
ok('auto-install of common packages is on by default', configMod.load().autoInstallDeps === true);

console.log('one-time migration of the old stock context size');
writeCfg({ contextSize: 8192, modelPath: defaultModelPath(), provider: 'local', temperature: 0.6 });
let c = configMod.load();
ok('stock model on the old stock 8k -> 16k', c.contextSize === 16384, String(c.contextSize));
ok('other user settings are untouched', c.temperature === 0.6);
configMod.save({});
ok('the migration is recorded, so it runs once', JSON.parse(fs.readFileSync(configMod.configPath(), 'utf8')).configVersion === 2);
configMod.save({ contextSize: 8192 });
ok('choosing 8k again afterwards sticks', configMod.load().contextSize === 8192);

writeCfg({ contextSize: 8192, modelPath: '/models/my-14b-model.gguf', provider: 'local' });
ok('a custom model keeps its size (it may not have the memory)', configMod.load().contextSize === 8192);
writeCfg({ contextSize: 4096, modelPath: defaultModelPath(), provider: 'local' });
ok('a size the user picked keeps it', configMod.load().contextSize === 4096);
writeCfg({ contextSize: 8192, provider: 'deepseek' });
ok('the hosted provider is left alone', configMod.load().contextSize === 8192);

fs.rmSync(home, { recursive: true, force: true });
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
