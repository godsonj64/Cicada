'use strict';

// End-to-end test of the agentic inpaint flow against the real model. Seeds base
// code, selects a region, asks the agent to rewrite ONLY that region, and verifies
// the edit landed, the code outside the region is preserved, and the result compiles.
// Run with the model available:  node scripts/inpaint_e2e.js
const path = require('path');
const configMod = require('../src/main/config');
const { LlamaServer } = require('../src/main/llama');
const { Pipeline } = require('../src/main/pipeline');
const { ContextMemory } = require('../src/main/memory');
const python = require('../src/main/python');

const BASE = `def process(items):
    total = 0
    for x in items:
        total += x
    return total


if __name__ == "__main__":
    print(process([1, 2, 3, 4, 5]))
`;
// Select the loop body: lines 3-4 (Monaco-style full-line selection ends at col 1 of line 5).
const SELECTION = { startLine: 3, startColumn: 1, endLine: 5, endColumn: 1 };
const INSTRUCTION = process.argv.slice(2).join(' ') || 'Replace the loop with a single call to the built-in sum().';

const config = { ...configMod.load(), maxTokens: 900, maxFixIterations: 2 };

function runFile(file) {
  return new Promise((resolve) => {
    let stderr = '';
    python.run({ pythonPath: config.pythonPath, file, cwd: config.workspaceDir, render: true,
      onData: (s, t) => { if (s === 'stderr') stderr += t; process.stdout.write(t); },
      onExit: (code, { images }) => resolve({ code, images, stderr }) });
  });
}

(async () => {
  const llama = new LlamaServer(config);
  llama.on('status', (s) => console.log(`[llama] ${s.status}${s.detail ? ' - ' + s.detail : ''}`));
  await llama.start();
  if (llama.status !== 'ready') { console.error('server not ready'); process.exit(1); }

  let finalCode = '';
  const memory = new ContextMemory(config.workspaceDir);
  const pipeline = new Pipeline({
    config, baseUrl: llama.baseUrl(), runFile, memory,
    emit: (event, payload) => {
      if (event === 'pipeline:start') console.log(`\n=== INPAINT — stages: ${payload.stages.map((s) => s.id).join(' -> ')} ===`);
      else if (event === 'stage:start') console.log(`\n=== STAGE: ${payload.name} ===`);
      else if (event === 'stage:done' && payload.answer) console.log('[done] ' + payload.answer.replace(/\s+/g, ' ').slice(0, 200));
      else if (event === 'pipeline:code') finalCode = payload.code;
      else if (event === 'pipeline:done') console.log(`\n=== DONE (compiled=${payload.compiled}, reverted=${!!payload.reverted}) ===`);
      else if (event === 'pipeline:error') console.log('\n=== ERROR: ' + payload.message + ' ===');
    },
  });

  console.log('BASE:\n' + BASE);
  console.log('SELECTION: lines 3-4   INSTRUCTION: ' + INSTRUCTION);
  await pipeline.inpaint(INSTRUCTION, BASE, SELECTION);

  console.log('\n--- FINAL CODE ---\n' + finalCode);
  const compiled = await python.compileCheck({ pythonPath: config.pythonPath, file: path.join(config.workspaceDir, 'main.py') });
  // Code OUTSIDE the edited region must be preserved verbatim.
  const headOk = finalCode.startsWith('def process(items):\n    total = 0\n');
  const tailOk = /if __name__ == "__main__":\n    print\(process\(\[1, 2, 3, 4, 5\]\)\)/.test(finalCode);
  console.log('\nCompiles?              ' + compiled.ok);
  console.log('Region changed?        ' + !finalCode.includes('for x in items:'));
  console.log('Header preserved?      ' + headOk);
  console.log('Footer preserved?      ' + tailOk);

  llama.stop();
  const good = compiled.ok && headOk && tailOk;
  setTimeout(() => process.exit(good ? 0 : 1), 800);
})().catch((e) => { console.error(e); process.exit(1); });
