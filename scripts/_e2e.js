'use strict';

// Shared setup for the model-backed end-to-end scripts (headless_test, refine_test,
// stress_test, inpaint_e2e, verify_mnist). They read the user's model / interpreter /
// llama-server settings, but must NEVER write into a real project: they used to run in
// config.workspaceDir — the user's active project — overwriting its files and clearing its
// memory. Every run now gets a throwaway workspace, removed afterwards unless
// KEEP_WORKSPACE=1 is set.

const fs = require('fs');
const os = require('os');
const path = require('path');
const configMod = require('../src/main/config');
const python = require('../src/main/python');

function isolatedConfig(overrides) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-e2e-'));
  return { ...configMod.load(), workspaceDir, ...(overrides || {}) };
}

// Runs a file the way main.js runFileStreaming does and resolves with the same shape.
function makeRunFile(config, opts) {
  const echo = !opts || opts.echo !== false;
  return (file, runOpts) => new Promise((resolve) => {
    const o = runOpts || {};
    let stderr = '';
    let stdout = '';
    const t0 = Date.now();
    python.run({
      pythonPath: config.pythonPath, file, cwd: config.workspaceDir, render: true,
      timeoutMs: o.timeoutMs || 0, stdin: o.stdin || 'pipe',
      onData: (s, t) => { if (s === 'stderr') stderr += t; else stdout += t; if (echo) process.stdout.write(t); },
      onExit: (code, info) => resolve({
        code, images: info.images, stderr, stdout, timedOut: info.timedOut, signal: info.signal, durationMs: Date.now() - t0, startedAtMs: t0,
      }),
    });
  });
}

function cleanup(config) {
  if (process.env.KEEP_WORKSPACE) { console.log('workspace kept at ' + config.workspaceDir); return; }
  try { fs.rmSync(config.workspaceDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

module.exports = { isolatedConfig, makeRunFile, cleanup };
