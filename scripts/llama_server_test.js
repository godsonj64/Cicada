'use strict';

// Lifecycle tests for LlamaServer (src/main/llama.js) using a tiny FAKE llama-server — a
// Node script that parses --port and answers /health — so start/stop/restart can be
// exercised for real without loading a model. Covers the restart race (the old process's
// late exit clobbering its successor and spawning phantom restarts) and port fallback.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { LlamaServer } = require('../src/main/llama');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-llama-'));
const model = path.join(dir, 'model.gguf');
fs.writeFileSync(model, 'fake');
// The fake server: listens on --port, answers /health after a short "load", and on
// SIGTERM lingers briefly before exiting — like a real server freeing a model — which is
// exactly what exposed the restart race.
const fake = path.join(dir, 'fake-llama-server.js');
fs.writeFileSync(fake, `#!/usr/bin/env node
const http = require('http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
let ready = false;
setTimeout(() => { ready = true; }, 300);
http.createServer((req, res) => { res.statusCode = ready ? 200 : 503; res.end(ready ? 'ok' : 'loading'); })
  .listen(port, '127.0.0.1');
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 600));
`);
fs.chmodSync(fake, 0o755);

function occupy(port) {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(port, '127.0.0.1', () => resolve(s)); });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

(async () => {
  if (process.platform === 'win32') { console.log('SKIP — the fake server uses a POSIX shebang'); process.exit(0); }
  const port = 18000 + Math.floor(Math.random() * 1000);
  const config = { llamaServerPath: fake, modelPath: model, serverPort: port, contextSize: 2048, gpuLayers: 0 };

  console.log('start / stop');
  const srv = new LlamaServer(config);
  const statuses = [];
  srv.on('status', (s) => statuses.push(s.status));
  await srv.start();
  ok('reaches ready', srv.status === 'ready', srv.status + ' ' + srv.lastError);
  const pid1 = srv.proc && srv.proc.pid;

  console.log('restart race');
  await srv.restart(config);
  const pid2 = srv.proc && srv.proc.pid;
  ok('restart comes back ready', srv.status === 'ready', srv.status + ' ' + srv.lastError);
  ok('...on a new process', pid2 && pid2 !== pid1);
  ok('...and the old process is gone', !alive(pid1));
  await sleep(1500); // let any late exit from the old process land
  ok('the old process exiting does not detach the new one', srv.proc && srv.proc.pid === pid2);
  ok('...nor trigger a phantom crash-restart', srv.status === 'ready' && !statuses.slice(-3).includes('error'), statuses.join(','));

  console.log('port fallback');
  await srv.stop();
  ok('stop resolves after the process has exited', !alive(pid2));
  const blocker = await occupy(port);
  await srv.start();
  ok('a busy port is skipped automatically', srv.status === 'ready' && srv.port !== port, `status=${srv.status} port=${srv.port}`);
  ok('baseUrl follows the port actually used', srv.baseUrl().endsWith(':' + srv.port));
  blocker.close();

  console.log('crash recovery');
  const pid3 = srv.proc.pid;
  process.kill(pid3, 'SIGKILL');
  await sleep(2500);
  for (let i = 0; i < 20 && srv.status !== 'ready'; i++) await sleep(250);
  ok('an unexpected crash is restarted automatically', srv.status === 'ready' && srv.proc && srv.proc.pid !== pid3, srv.status);

  await srv.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
