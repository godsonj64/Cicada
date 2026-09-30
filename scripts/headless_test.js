'use strict';

// Headless end-to-end test of the agentic core (no Electron):
// starts llama-server, runs the pipeline on a small request, executes the result.

const path = require('path');
const { isolatedConfig, makeRunFile, cleanup } = require('./_e2e');
const { LlamaServer } = require('../src/main/llama');
const { Pipeline } = require('../src/main/pipeline');
const python = require('../src/main/python');

const REQUEST = process.argv.slice(2).join(' ') || 'Print the first 10 Fibonacci numbers, one per line.';

// A throwaway workspace: never the user's active project.
const config = isolatedConfig({
  maxTokens: 900,        // keep the test snappy
  maxFixIterations: 2,
});

function shorten(s, n = 240) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const runOnce = makeRunFile(config);
async function runFile(file, opts) {
  console.log('\n--- RUN OUTPUT ---');
  const r = await runOnce(file, opts);
  console.log(`--- exit ${r.code}, images=${r.images.length} ---`);
  return r;
}

(async () => {
  const llama = new LlamaServer(config);
  llama.on('status', (s) => console.log(`[llama] ${s.status}${s.detail ? ' - ' + s.detail : ''}`));
  await llama.start();
  if (llama.status !== 'ready') { console.error('Server failed to become ready.'); process.exit(1); }

  const seen = {};
  const pipeline = new Pipeline({
    config, baseUrl: llama.baseUrl(),
    runFile,
    emit: (event, payload) => {
      if (event === 'stage:start') console.log(`\n=== STAGE: ${payload.name} (${payload.id}) ===`);
      else if (event === 'stage:done') console.log(`[done ${payload.id}] ${shorten(payload.answer)}`);
      else if (event === 'stage:error') console.log(`[ERROR ${payload.id}] ${payload.message}`);
      else if (event === 'pipeline:code') seen.code = payload.code;
      else if (event === 'pipeline:done') console.log(`\n=== PIPELINE DONE (compiled=${payload.compiled}) ===`);
      else if (event === 'pipeline:error') console.log(`\n=== PIPELINE ERROR: ${payload.message} ===`);
    },
  });

  const t0 = Date.now();
  await pipeline.run(REQUEST);
  console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('\n--- FINAL CODE ---\n' + (seen.code || '(none)'));
  await llama.stop();
  cleanup(config);
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error(e); process.exit(1); });
