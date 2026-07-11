'use strict';

// Live system monitor: CPU / RAM / GPU / VRAM for the dock status strip.
//
// Training a model with no idea whether the GPU is actually being used (or the box is
// swapping) is flying blind — this samples cheap counters every few seconds and pushes
// them to the renderer. CPU% comes from os.cpus() tick deltas, RAM from os.total/free,
// GPU utilisation + VRAM from `nvidia-smi --query-gpu` (the same tool the llama.cpp
// installer already relies on). If the first nvidia-smi probe fails, GPU polling is
// disabled for the session — machines without NVIDIA hardware never spawn a process
// per tick. Every sampler is exception-safe; the monitor can only ever go quiet,
// never take the app down.

const os = require('os');
const { spawn } = require('child_process');

const INTERVAL_MS = 3000;
const GPU_TIMEOUT_MS = 4000;

let timer = null;
let lastCpu = null;    // previous os.cpus() aggregate for delta-based CPU%
let gpuAvailable = null; // null = unknown (probe on first tick), false = never again

// Aggregate ticks across all cores.
function cpuTotals() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

// CPU utilisation % since the previous call (null on the very first sample).
function sampleCpu() {
  const now = cpuTotals();
  let pct = null;
  if (lastCpu && now.total > lastCpu.total) {
    const dTotal = now.total - lastCpu.total;
    const dIdle = now.idle - lastCpu.idle;
    pct = Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)));
  }
  lastCpu = now;
  return pct;
}

function sampleRam() {
  const total = os.totalmem();
  const free = os.freemem();
  return { usedBytes: total - free, totalBytes: total };
}

/**
 * Parse `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total
 * --format=csv,noheader,nounits` output ("34, 2048, 8192"). Multi-GPU: utilisation is
 * the max, memory is summed. Returns { gpuPct, vramUsedMB, vramTotalMB } or null.
 */
function parseGpuCsv(text) {
  const rows = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let gpuPct = null, used = 0, total = 0, any = false;
  for (const row of rows) {
    const parts = row.split(',').map((s) => parseFloat(s.trim()));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) continue;
    any = true;
    gpuPct = Math.max(gpuPct == null ? -1 : gpuPct, parts[0]);
    used += parts[1];
    total += parts[2];
  }
  if (!any) return null;
  return { gpuPct: gpuPct < 0 ? null : Math.round(gpuPct), vramUsedMB: Math.round(used), vramTotalMB: Math.round(total) };
}

// One async GPU sample; resolves null on any failure (and remembers a hard failure).
function sampleGpu() {
  return new Promise((resolve) => {
    if (gpuAvailable === false) { resolve(null); return; }
    let out = '', settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    let proc;
    try {
      proc = spawn('nvidia-smi',
        ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (_) {
      gpuAvailable = false;
      finish(null);
      return;
    }
    const timeout = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ } finish(null); }, GPU_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => { clearTimeout(timeout); gpuAvailable = false; finish(null); });
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) { gpuAvailable = false; finish(null); return; }
      const parsed = parseGpuCsv(out);
      if (parsed) gpuAvailable = true; else gpuAvailable = false;
      finish(parsed);
    });
  });
}

// One full sample: { cpuPct, ram, gpu } (gpu null when unavailable).
async function sample() {
  const cpuPct = sampleCpu();
  const ram = sampleRam();
  const gpu = await sampleGpu();
  return { cpuPct, ram, gpu, at: Date.now() };
}

/**
 * Start periodic sampling; `emit(stats)` receives each sample. Restart-safe (stops any
 * previous loop). The very first sample fires immediately so the UI isn't blank.
 */
function start(emit) {
  stop();
  lastCpu = null;
  const tick = async () => {
    try {
      const s = await sample();
      emit(s);
    } catch (_) { /* a bad sample is skipped, never fatal */ }
  };
  tick();
  timer = setInterval(tick, INTERVAL_MS);
  // Don't let the sampler keep the process alive at quit.
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, sample, sampleCpu, sampleRam, sampleGpu, parseGpuCsv, INTERVAL_MS };
