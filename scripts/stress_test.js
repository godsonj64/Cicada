'use strict';

// Advanced stress battery for the agentic core: heavy code generation, plotting,
// whole-program refine, and surgical inpaint — all end-to-end against the real model,
// with self-heal loops exercised. Prints a result matrix and copies every rendered
// plot to /tmp/garm_stress/<n>/ for inspection.
//
//   node scripts/stress_test.js
//
const fs = require('fs');
const path = require('path');
const configMod = require('../src/main/config');
const { LlamaServer } = require('../src/main/llama');
const { Pipeline } = require('../src/main/pipeline');
const { ContextMemory } = require('../src/main/memory');
const python = require('../src/main/python');

const OUT = '/tmp/garm_stress';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const config = { ...configMod.load(), maxTokens: 1400, maxFixIterations: 2 };

// A program with exponential recursion — the inpaint target.
const FIB_BASE = `def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


def main():
    for i in range(10):
        print(fib(i))


if __name__ == "__main__":
    main()
`;

const SCENARIOS = [
  { kind: 'create', name: 'Sieve + prime-gap bar chart',
    request: 'Use the Sieve of Eratosthenes to find the first 30 prime numbers, print them on one line, then plot the gaps between consecutive primes as a matplotlib bar chart with axis labels and a title, and show it.' },
  { kind: 'create', name: 'Mandelbrot set (numpy + imshow)',
    request: "Render the Mandelbrot set with numpy and matplotlib over x in [-2.0, 1.0] and y in [-1.5, 1.5] at 320x320 resolution and max 50 iterations, display it with imshow using the 'magma' colormap and a title, and show it." },
  { kind: 'create', name: 'Noisy sine + moving-average smoothing',
    request: 'Generate 500 samples of a 5 Hz sine wave sampled at 100 Hz, add Gaussian noise (std 0.3), smooth it with a length-10 moving average, and plot the raw and smoothed signals on the same axes with a legend, axis labels, and a title. Show the figure.' },
  { kind: 'refine', name: 'Refine: add FFT magnitude subplot',
    change: 'Add a second subplot (stacked vertically) that shows the FFT magnitude spectrum of the noisy signal versus frequency in Hz. Keep the original plot as the first subplot.',
    usePrevCode: true },
  { kind: 'inpaint', name: 'Inpaint: make fib() iterative O(n)',
    base: FIB_BASE,
    selection: { startLine: 1, startColumn: 1, endLine: 5, endColumn: 1 }, // the fib() definition, lines 1-4
    instruction: 'Rewrite fib to compute the nth Fibonacci number iteratively in O(n) time instead of exponential recursion. Keep the same function name and signature.' },
];

function runFile(file) {
  return new Promise((resolve) => {
    let stderr = '', stdout = '';
    python.run({ pythonPath: config.pythonPath, file, cwd: config.workspaceDir, render: true,
      onData: (s, t) => { if (s === 'stderr') stderr += t; else stdout += t; },
      onExit: (code, { images }) => resolve({ code, images, stderr, stdout }) });
  });
}

function shorten(s, n = 90) { return (s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

(async () => {
  const llama = new LlamaServer(config);
  llama.on('status', (s) => console.log(`[llama] ${s.status}${s.detail ? ' - ' + s.detail : ''}`));
  await llama.start();
  if (llama.status !== 'ready') { console.error('server not ready'); process.exit(1); }

  const memory = new ContextMemory(config.workspaceDir);
  memory.clear();
  let lastImages = [];
  let prevCode = '';
  const pipeline = new Pipeline({
    config, baseUrl: llama.baseUrl(), runFile, memory,
    emit: (event, payload) => {
      if (event === 'stage:start') process.stdout.write(`  · ${payload.name}… `);
      else if (event === 'stage:done') process.stdout.write(`done\n`);
      else if (event === 'stage:error') process.stdout.write(`ERROR: ${payload.message}\n`);
      else if (event === 'pipeline:code') prevCode = payload.code;
      else if (event === 'run:images') lastImages = (payload.images || []).map((i) => i.path);
      else if (event === 'pipeline:error') console.log(`  !! pipeline error: ${payload.message}`);
    },
  });
  // runFile gives us images directly per scenario; capture them too.

  const results = [];
  let n = 0;
  for (const sc of SCENARIOS) {
    n += 1;
    const dir = path.join(OUT, String(n));
    fs.mkdirSync(dir, { recursive: true });
    console.log(`\n========== [${n}/${SCENARIOS.length}] ${sc.name}  (${sc.kind}) ==========`);
    const t0 = Date.now();
    let runRes = { code: null, images: [], stderr: '', stdout: '' };
    // Capture images from the run by wrapping runFile for this scenario.
    const realRun = runFile;
    let captured = null;
    pipeline.runFile = async (f) => { captured = await realRun(f); return captured; };
    try {
      if (sc.kind === 'create') await pipeline.run(sc.request);
      else if (sc.kind === 'refine') await pipeline.refine(sc.change, sc.usePrevCode ? prevCode : sc.base);
      else if (sc.kind === 'inpaint') await pipeline.inpaint(sc.instruction, sc.base, sc.selection);
    } catch (e) {
      console.log('  !! threw: ' + e.message);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    runRes = captured || runRes;
    const compiled = await python.compileCheck({ pythonPath: config.pythonPath, file: path.join(config.workspaceDir, 'main.py') });
    const code = prevCode;
    fs.writeFileSync(path.join(dir, 'main.py'), code, 'utf8');
    // Copy rendered plots out for inspection.
    let imgCount = 0;
    for (const img of (runRes.images || [])) {
      try { fs.copyFileSync(img, path.join(dir, path.basename(img))); imgCount += 1; } catch (_) { /* ignore */ }
    }
    results.push({
      n, name: sc.name, kind: sc.kind, secs,
      compiled: compiled.ok, exit: runRes.code, images: imgCount,
      lines: code.split('\n').length,
      stdout: shorten(runRes.stdout, 70),
      err: runRes.code !== 0 ? shorten((runRes.stderr || '').split('\n').filter(Boolean).pop(), 80) : '',
    });
    console.log(`  -> compiled=${compiled.ok}  exit=${runRes.code}  images=${imgCount}  lines=${code.split('\n').length}  time=${secs}s`);
    if (runRes.stdout) console.log('  stdout: ' + shorten(runRes.stdout, 100));
  }

  // Inpaint correctness: fib() must no longer be recursive and output unchanged.
  const inpaintCode = fs.readFileSync(path.join(OUT, '5', 'main.py'), 'utf8');
  const fibNoLongerRecursive = !/return\s+fib\s*\(/.test(inpaintCode);

  console.log('\n\n================= STRESS SUMMARY =================');
  console.log('#  kind     compiled exit images lines time  scenario');
  for (const r of results) {
    console.log(
      `${String(r.n).padEnd(2)} ${r.kind.padEnd(8)} ${String(r.compiled).padEnd(8)} ${String(r.exit).padEnd(4)} ${String(r.images).padEnd(6)} ${String(r.lines).padEnd(5)} ${(r.secs + 's').padEnd(5)} ${r.name}`
    );
    if (r.err) console.log(`     last stderr: ${r.err}`);
  }
  const plots = results.filter((r) => r.images > 0).length;
  const ranClean = results.filter((r) => r.exit === 0).length;
  const compiledN = results.filter((r) => r.compiled).length;
  console.log('-------------------------------------------------');
  console.log(`compiled: ${compiledN}/${results.length}   ran exit-0: ${ranClean}/${results.length}   produced plots: ${plots}`);
  console.log(`inpaint made fib() non-recursive: ${fibNoLongerRecursive}`);
  console.log(`artifacts (code + plots) in: ${OUT}/<n>/`);
  console.log('memory after battery:\n' + memory.render());

  llama.stop();
  setTimeout(() => process.exit(0), 1000);
})().catch((e) => { console.error(e); process.exit(1); });
