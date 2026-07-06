'use strict';

// Headless checks for the llama.cpp auto-installer's pure logic: asset selection per
// platform/arch and binary discovery. No network, no model.

const fs = require('fs');
const os = require('os');
const path = require('path');
const inst = require('../src/main/llama-installer');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (cond || !detail ? '' : '  — ' + detail));
  if (!cond) failures++;
}

// A realistic slice of a llama.cpp release's asset list. Note the cudart runtime archives
// are listed BEFORE the llama build archives and their names ALSO contain "bin-win-cuda-
// <ver>-x64.zip" — the exact shape that made a naive pattern pick the runtime (DLLs only,
// no exe) instead of the real build. Two CUDA toolkits (12.4, 13.3) exercise version pick.
const ASSETS = [
  { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', browser_download_url: 'r1' },
  { name: 'cudart-llama-bin-win-cuda-13.3-x64.zip', browser_download_url: 'r2' },
  { name: 'llama-b4000-bin-win-cpu-x64.zip', browser_download_url: 'u1' },
  { name: 'llama-b4000-bin-win-cuda-12.4-x64.zip', browser_download_url: 'u2' },
  { name: 'llama-b4000-bin-win-cuda-13.3-x64.zip', browser_download_url: 'u2b' },
  { name: 'llama-b4000-bin-win-vulkan-x64.zip', browser_download_url: 'u3' },
  { name: 'llama-b4000-bin-macos-arm64.zip', browser_download_url: 'u4' },
  { name: 'llama-b4000-bin-macos-x64.zip', browser_download_url: 'u5' },
  { name: 'llama-b4000-bin-ubuntu-x64.zip', browser_download_url: 'u6' },
];

check('win x64 -> cpu build', inst.pickAsset(ASSETS, 'win32', 'x64').name === 'llama-b4000-bin-win-cpu-x64.zip');
check('mac arm64 -> arm64 build', inst.pickAsset(ASSETS, 'darwin', 'arm64').name === 'llama-b4000-bin-macos-arm64.zip');
check('mac x64 -> x64 build', inst.pickAsset(ASSETS, 'darwin', 'x64').name === 'llama-b4000-bin-macos-x64.zip');
check('linux x64 -> ubuntu build', inst.pickAsset(ASSETS, 'linux', 'x64').name === 'llama-b4000-bin-ubuntu-x64.zip');
check('no asset -> null', inst.pickAsset([{ name: 'source.tar.gz' }], 'win32', 'x64') === null);

// Newer naming where only a generic win-x64 zip is offered.
check('win falls back to generic x64', inst.pickAsset([{ name: 'llama-bin-win-x64.zip', browser_download_url: 'g' }], 'win32', 'x64').name === 'llama-bin-win-x64.zip');

// --- Backend selection (CUDA / Metal / CPU) ---------------------------------
// CUDA build selection must pick a `llama-*` build (never a `cudart-*` runtime) even though
// cudart archives sort first and share the "bin-win-cuda-<ver>-x64.zip" suffix.
check('win cuda -> newest cuda BUILD (not cudart)', inst.pickAsset(ASSETS, 'win32', 'x64', 'cuda').name === 'llama-b4000-bin-win-cuda-13.3-x64.zip');
check('win cuda default takes highest toolkit', inst.pickAsset(ASSETS, 'win32', 'x64', 'cuda', null).name === 'llama-b4000-bin-win-cuda-13.3-x64.zip');
check('modern GPU (8.9) -> 13.3', inst.pickAsset(ASSETS, 'win32', 'x64', 'cuda', 8.9).name === 'llama-b4000-bin-win-cuda-13.3-x64.zip');
check('Blackwell (12.0) -> 13.3', inst.pickAsset(ASSETS, 'win32', 'x64', 'cuda', 12.0).name === 'llama-b4000-bin-win-cuda-13.3-x64.zip');
check('legacy GPU (6.1) -> 12.4 (CUDA 13 dropped it)', inst.pickAsset(ASSETS, 'win32', 'x64', 'cuda', 6.1).name === 'llama-b4000-bin-win-cuda-12.4-x64.zip');
check('win cuda falls back to cpu when no cuda asset',
  inst.pickAsset([{ name: 'llama-b4000-bin-win-cpu-x64.zip', browser_download_url: 'c' }], 'win32', 'x64', 'cuda').name === 'llama-b4000-bin-win-cpu-x64.zip');
check('win cpu ignores cuda asset', inst.pickAsset(ASSETS, 'win32', 'x64', 'cpu').name === 'llama-b4000-bin-win-cpu-x64.zip');
check('cudaBuildVersion parses build, not cudart', inst.cudaBuildVersion('llama-b4000-bin-win-cuda-13.3-x64.zip') === 13.3 && inst.cudaBuildVersion('cudart-llama-bin-win-cuda-13.3-x64.zip') === null);
check('cudart matches build version', inst.cudartAsset(ASSETS, 'win32', 13.3).name === 'cudart-llama-bin-win-cuda-13.3-x64.zip');
check('cudart falls back to highest', inst.cudartAsset(ASSETS, 'win32', 99).name === 'cudart-llama-bin-win-cuda-13.3-x64.zip');
check('cudart null off-windows', inst.cudartAsset(ASSETS, 'linux', 13.3) === null);

// compute-capability probe parses nvidia-smi CSV (multi-GPU -> max).
const probe = (out, status) => () => ({ status: status == null ? 0 : status, stdout: out });
check('computeCap parses single', inst.nvidiaComputeCap(probe('12.0\n')) === 12.0);
check('computeCap max of many', inst.nvidiaComputeCap(probe('7.5\n8.9\n')) === 8.9);
check('computeCap null on failure', inst.nvidiaComputeCap(probe('', 1)) === null);

// detectBackend uses an injectable GPU probe so it needs no real hardware.
const yes = () => true, no = () => false;
check('detect metal on mac arm64', inst.detectBackend('darwin', 'arm64', no) === 'metal');
check('detect cuda on win w/ gpu', inst.detectBackend('win32', 'x64', yes) === 'cuda');
check('detect cpu on win w/o gpu', inst.detectBackend('win32', 'x64', no) === 'cpu');
check('detect cuda on linux w/ gpu', inst.detectBackend('linux', 'x64', yes) === 'cuda');
check('detect cpu on mac x64', inst.detectBackend('darwin', 'x64', yes) === 'cpu');
check('installDirFor namespaces by backend', /[\\/]cuda$/.test(inst.installDirFor('cuda', '/base')), inst.installDirFor('cuda', '/base'));

// Binary discovery walks nested extraction folders.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-llama-'));
const nested = path.join(dir, 'llama-b4000', 'build', 'bin');
fs.mkdirSync(nested, { recursive: true });
const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
fs.writeFileSync(path.join(nested, binName), '#!/bin/sh\n', 'utf8');
fs.writeFileSync(path.join(nested, 'llama-cli' + (process.platform === 'win32' ? '.exe' : '')), 'x', 'utf8');
const found = inst.findServerBinary(dir);
check('findServerBinary locates nested server', found === path.join(nested, binName), String(found));
check('installedBinary reads an install dir', inst.installedBinary(dir) === found);
check('installedBinary null when absent', inst.installedBinary(path.join(dir, 'nope')) === null);

check('defaultInstallDir under GARM Code', /GARM Code[\\/]+llama\.cpp$/.test(inst.defaultInstallDir()), inst.defaultInstallDir());

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll llama-installer checks passed.');
process.exit(failures ? 1 : 0);
