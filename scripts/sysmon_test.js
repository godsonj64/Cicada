'use strict';

// Headless checks for the system monitor: nvidia-smi CSV parsing (pure), CPU/RAM
// sampling sanity, and a full sample() round-trip on whatever hardware runs this
// (GPU may legitimately be null — that's asserted as a valid shape, not a failure).

const mon = require('../src/main/sysmon');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || !detail ? '' : '  — ' + detail));
  if (!cond) failures += 1;
}

// ---- parseGpuCsv ------------------------------------------------------------

let g = mon.parseGpuCsv('34, 2048, 8192\n');
check('single gpu parsed', g && g.gpuPct === 34 && g.vramUsedMB === 2048 && g.vramTotalMB === 8192, JSON.stringify(g));

g = mon.parseGpuCsv('10, 1000, 8000\n90, 3000, 16000\n');
check('multi gpu: max util, summed vram', g.gpuPct === 90 && g.vramUsedMB === 4000 && g.vramTotalMB === 24000);

check('garbage -> null', mon.parseGpuCsv('NVIDIA-SMI has failed') === null);
check('empty -> null', mon.parseGpuCsv('') === null);
check('null -> null', mon.parseGpuCsv(null) === null);
g = mon.parseGpuCsv(' 5 , 100 , 200 ');
check('whitespace tolerated', g && g.gpuPct === 5);

// ---- RAM / CPU --------------------------------------------------------------

const ram = mon.sampleRam();
check('ram totals sane', ram.totalBytes > 0 && ram.usedBytes > 0 && ram.usedBytes <= ram.totalBytes);

const first = mon.sampleCpu();
check('first cpu sample is null (needs a delta)', first === null);
setTimeout(async () => {
  const second = mon.sampleCpu();
  check('second cpu sample in range', second == null || (second >= 0 && second <= 100), String(second));

  // ---- full sample round-trip ------------------------------------------------
  const s = await mon.sample();
  check('sample has ram', s.ram && s.ram.totalBytes > 0);
  check('sample gpu shape ok', s.gpu === null || (typeof s.gpu.vramTotalMB === 'number'), JSON.stringify(s.gpu));
  check('sample timestamps', typeof s.at === 'number' && s.at > 0);

  // start/stop lifecycle: emits at least once, stop() halts cleanly.
  let emitted = 0;
  mon.start(() => { emitted += 1; });
  setTimeout(() => {
    mon.stop();
    check('start() emitted a sample', emitted >= 1, String(emitted));
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll sysmon checks passed.');
    process.exit(failures ? 1 : 0);
  }, 700);
}, 120);
