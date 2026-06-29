'use strict';

// Headless test of the post-edit refine flow: seed base code, request a change,
// confirm the change is applied and the result runs.
const configMod = require('../src/main/config');
const { LlamaServer } = require('../src/main/llama');
const { Pipeline } = require('../src/main/pipeline');
const python = require('../src/main/python');

const BASE = `def main():
    for i in range(1, 6):
        print(i)

if __name__ == "__main__":
    main()
`;
const CHANGE = process.argv.slice(2).join(' ') || 'Also print the total sum of the numbers at the end, labelled "sum:".';

const config = { ...configMod.load(), maxTokens: 900, maxFixIterations: 1 };

function runFile(file) {
  return new Promise((resolve) => {
    console.log('\n--- RUN OUTPUT ---');
    python.run({ pythonPath: config.pythonPath, file, cwd: config.workspaceDir, render: true,
      onData: (s, t) => process.stdout.write(t),
      onExit: (code, { images }) => { console.log(`--- exit ${code}, images=${images.length} ---`); resolve({ code, images }); } });
  });
}

(async () => {
  const llama = new LlamaServer(config);
  llama.on('status', (s) => console.log(`[llama] ${s.status}${s.detail ? ' - ' + s.detail : ''}`));
  await llama.start();
  if (llama.status !== 'ready') { console.error('server not ready'); process.exit(1); }

  let finalCode = '';
  const pipeline = new Pipeline({
    config, baseUrl: llama.baseUrl(), runFile,
    emit: (event, payload) => {
      if (event === 'pipeline:start') console.log(`\n=== REFINE START — stages: ${payload.stages.map((s) => s.id).join(' -> ')} ===`);
      else if (event === 'stage:start') console.log(`\n=== STAGE: ${payload.name} ===`);
      else if (event === 'pipeline:code') finalCode = payload.code;
      else if (event === 'pipeline:done') console.log('\n=== REFINE DONE ===');
      else if (event === 'pipeline:error') console.log('\n=== ERROR: ' + payload.message + ' ===');
    },
  });

  console.log('BASE CODE:\n' + BASE);
  console.log('CHANGE: ' + CHANGE);
  await pipeline.refine(CHANGE, BASE);
  console.log('\n--- FINAL REFINED CODE ---\n' + finalCode);
  console.log('\nContains a sum? ' + /sum/i.test(finalCode));
  llama.stop();
  setTimeout(() => process.exit(0), 800);
})().catch((e) => { console.error(e); process.exit(1); });
