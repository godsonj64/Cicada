'use strict';

// One-off end-to-end verification of the truncation fix (NOT a committed test).
// Runs the real pipeline at the FULL token budget (config maxTokens, not the 900-cap
// the snappy headless_test uses) so the Generate stage has room to emit a complete
// program. Uses a fresh llama-server on port 8128 to sidestep the wedged 8127 process,
// and feeds the detected environment so the model avoids the missing torchvision.

const path = require('path');
const fs = require('fs');
const configMod = require('../src/main/config');
const { LlamaServer } = require('../src/main/llama');
const { Pipeline } = require('../src/main/pipeline');
const python = require('../src/main/python');

const REQUEST =
  'Build a complete PyTorch program that trains a small neural network to classify ' +
  'handwritten digits (MNIST-style). torchvision is NOT installed, so load the data with ' +
  'sklearn.datasets.load_digits(). Split into train/test, define a small fully-connected ' +
  'torch.nn.Module, train ~30 epochs with Adam, set a random seed, run on CPU, print the ' +
  'final test accuracy, and save a matplotlib figure showing 10 test digits with their ' +
  'predicted labels.';

// Real budget: keep config.maxTokens (8192). Only bound the fix loop so the run stays finite.
const config = {
  ...configMod.load(),
  serverPort: 8128,
  maxFixIterations: 2,
};

// Detected environment so _libNote steers the model to installed libs (no torchvision).
const env = {
  python: '3.14.3',
  libs: [
    { name: 'numpy', installed: true, version: '2.4.3' },
    { name: 'matplotlib', installed: true, version: '3.11.0' },
    { name: 'torch', installed: true, version: '2.11.0' },
    { name: 'sklearn', installed: true, version: '1.8.0' },
  ],
};

function shorten(s, n = 200) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function runFile(file) {
  return new Promise((resolve) => {
    console.log('\n--- RUN OUTPUT ---');
    let stderr = '';
    python.run({
      pythonPath: config.pythonPath, file, cwd: config.workspaceDir, render: true,
      onData: (stream, text) => { if (stream === 'stderr') stderr += text; process.stdout.write(text); },
      onExit: (code, { images }) => { console.log(`--- exit ${code}, images=${images.length} ---`); resolve({ code, images, stderr }); },
    });
  });
}

(async () => {
  console.log(`[cfg] port=${config.serverPort} maxTokens=${config.maxTokens} ctx=${config.contextSize} fixIters=${config.maxFixIterations}`);
  const llama = new LlamaServer(config);
  llama.on('status', (s) => console.log(`[llama] ${s.status}${s.detail ? ' - ' + s.detail : ''}`));
  const t0 = Date.now();
  await llama.start();
  if (llama.status !== 'ready') { console.error('SERVER_NOT_READY'); process.exit(1); }
  console.log(`[llama] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const seen = {};
  const pipeline = new Pipeline({
    config, baseUrl: llama.baseUrl(), env,
    runFile,
    emit: (event, payload) => {
      if (event === 'stage:start') console.log(`\n=== STAGE: ${payload.name} (${payload.id}) ===`);
      else if (event === 'stage:done') console.log(`[done ${payload.id}] ${shorten(payload.answer)}`);
      else if (event === 'stage:error') console.log(`[ERROR ${payload.id}] ${payload.message}`);
      else if (event === 'pipeline:code') seen.code = payload.code;
      else if (event === 'pipeline:missingModule') console.log(`[MISSING MODULE] ${payload.module} -> ${payload.command}`);
      else if (event === 'pipeline:done') console.log(`\n=== PIPELINE DONE (compiled=${payload.compiled}, exit=${payload.exit}) ===`);
      else if (event === 'pipeline:error') console.log(`\n=== PIPELINE ERROR: ${payload.message} ===`);
    },
  });

  const tp = Date.now();
  await pipeline.run(REQUEST);
  console.log(`\nPipeline time: ${((Date.now() - tp) / 1000).toFixed(1)}s`);

  const code = seen.code || '';
  const lines = code ? code.split('\n').length : 0;
  console.log(`\n[final-code] ${lines} lines, ${code.length} chars`);
  // Completeness signals for the truncation fix:
  console.log(`[complete?] has __main__: ${/if\s+__name__\s*==/.test(code)} | ends-cleanly: ${!/[,(\[]\s*$/.test(code.trim())}`);
  console.log('\n--- FINAL CODE ---\n' + (code || '(none)'));
  llama.stop();
  setTimeout(() => process.exit(0), 1200);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
