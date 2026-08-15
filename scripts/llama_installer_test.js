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

// Current releases ship the macOS/Linux builds as .tar.gz (Windows stays .zip). Matching
// only .zip picked nothing here and aborted the install with "no prebuilt binary is
// available for this platform" — the regression this set guards.
const TARBALLS = [
  { name: 'llama-b10436-bin-macos-arm64.tar.gz', browser_download_url: 't1' },
  { name: 'llama-b10436-bin-macos-x64.tar.gz', browser_download_url: 't2' },
  { name: 'llama-b10436-bin-ubuntu-x64.tar.gz', browser_download_url: 't3' },
  { name: 'llama-b10436-bin-ubuntu-vulkan-x64.tar.gz', browser_download_url: 't4' },
  { name: 'llama-b10436-bin-ubuntu-openvino-2026.2.1-x64.tar.gz', browser_download_url: 't5' },
  { name: 'llama-b10436-bin-win-cpu-x64.zip', browser_download_url: 't6' },
  { name: 'llama-b10436-xcframework.zip', browser_download_url: 't7' },
];

check('mac arm64 -> arm64 tarball', inst.pickAsset(TARBALLS, 'darwin', 'arm64').name === 'llama-b10436-bin-macos-arm64.tar.gz');
check('mac x64 -> x64 tarball', inst.pickAsset(TARBALLS, 'darwin', 'x64').name === 'llama-b10436-bin-macos-x64.tar.gz');
check('linux x64 -> plain ubuntu tarball (not vulkan/openvino)', inst.pickAsset(TARBALLS, 'linux', 'x64').name === 'llama-b10436-bin-ubuntu-x64.tar.gz');
check('win still prefers the zip build', inst.pickAsset(TARBALLS, 'win32', 'x64').name === 'llama-b10436-bin-win-cpu-x64.zip');
check('mac metal backend uses the same tarball', inst.pickAsset(TARBALLS, 'darwin', 'arm64', 'metal').name === 'llama-b10436-bin-macos-arm64.tar.gz');
check('xcframework is never chosen', inst.pickAsset([TARBALLS[6]], 'darwin', 'arm64') === null);

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

// --- Default model identification -------------------------------------------
// isDefaultModel gates the automatic download: true means "we chose this path, replace
// it", false means "the user picked this, tell them it's missing instead".
check('default model is Qwen2.5-Coder 3B Q4_K_M', inst.DEFAULT_MODEL_FILE === 'qwen2.5-coder-3b-instruct-q4_k_m.gguf', inst.DEFAULT_MODEL_FILE);
check('model URL points at the Qwen GGUF repo', inst.DEFAULT_MODEL_URL === 'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf', inst.DEFAULT_MODEL_URL);
check('defaultModelPath sits under GARM Code/models', /GARM Code[\\/]+models[\\/]+qwen2\.5-coder-3b-instruct-q4_k_m\.gguf$/.test(inst.defaultModelPath()), inst.defaultModelPath());
check('recognises the default by name', inst.isDefaultModel(inst.defaultModelPath()));
check('recognises it case-insensitively', inst.isDefaultModel('/tmp/QWEN2.5-CODER-3B-INSTRUCT-Q4_K_M.GGUF'));
check('recognises it in any directory', inst.isDefaultModel(path.join(os.homedir(), 'Downloads', 'qwen2.5-coder-3b-instruct-q4_k_m.gguf')));
check('recognises the legacy mythos-nano default (so it migrates)', inst.isDefaultModel(path.join(os.homedir(), 'GARM Code', 'mythos-nano-Q4_K_M.gguf')));
// A model the user chose themselves must never be swapped out from under them, however
// plausible the name — only filenames this app actually shipped as a default migrate.
check('a model the user picked is NOT treated as a stock default', inst.isDefaultModel('/tmp/LFM2.5-2.6B-Q4_K_M.gguf') === false);
check('a custom model is NOT default', inst.isDefaultModel('/tmp/my-own-model.gguf') === false);
check('empty path is NOT default', inst.isDefaultModel('') === false && inst.isDefaultModel(null) === false);

// The config default must be the exact file the downloader writes, or first run downloads
// the model and then still reports it missing.
const cfg = require('../src/main/config');
check('config default == download destination', cfg.DEFAULTS.modelPath === inst.defaultModelPath(), cfg.DEFAULTS.modelPath);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll llama-installer checks passed.');
process.exit(failures ? 1 : 0);
