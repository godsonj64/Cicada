'use strict';

// Headless test of the post-edit refine flow: seed base code, request a change,
// confirm the change is applied and the result runs.
const { isolatedConfig, makeRunFile, cleanup } = require('./_e2e');
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

// A throwaway workspace: never the user's active project.
const config = isolatedConfig({ maxTokens: 900, maxFixIterations: 1 });

// Returns stderr/stdout exactly as main.js does, or the runtime-repair loop can never see
// a traceback and the whole self-healing path goes untested.
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
  await llama.stop();
  cleanup(config);
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error(e); process.exit(1); });
