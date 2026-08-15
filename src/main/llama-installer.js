'use strict';

// Auto-download & configure the llama.cpp `llama-server` binary on first run.
//
// When no llama-server is found (no PATH entry, no prior download), Cicada fetches a
// prebuilt release from github.com/ggerganov/llama.cpp, unzips it into
// ~/GARM Code/llama.cpp, locates the server binary, and records its path so the app can
// start inference with zero manual setup. CPU builds are chosen for maximum portability
// (they run everywhere; -ngl is simply ignored without a GPU backend).
//
// Extraction uses tools already present on each OS (PowerShell Expand-Archive / unzip /
// tar), so no new npm dependency is introduced. Pure-ish Node so the selection logic can
// be unit-tested without a network.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELEASES_API = 'https://api.github.com/repos/ggerganov/llama.cpp/releases/latest';
const SERVER_NAME = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

// Where downloads live, keyed off the same ~/GARM Code root the rest of the app uses.
function defaultInstallDir() {
  return path.join(os.homedir(), 'GARM Code', 'llama.cpp');
}

// Per-backend subdirectory so a CPU build and a CUDA build can coexist (and so switching
// machines/GPUs re-downloads the right one instead of reusing an incompatible binary).
function installDirFor(backend, base) {
  return path.join(base || defaultInstallDir(), backend || 'cpu');
}

// Detect the best compute backend for this machine: 'cuda' (an NVIDIA GPU is present),
// 'metal' (Apple Silicon, where the standard macOS arm64 build offloads to the GPU via
// Metal), or 'cpu' (everything else). `probe` is injectable for testing; by default it
// shells out to `nvidia-smi`, which exists only when an NVIDIA driver is installed.
//
// Note on MLX: MLX is Apple's own array framework and does NOT run GGUF files — llama.cpp
// uses Metal for GPU compute on Apple Silicon, so 'metal' is the correct backend here.
function hasNvidiaGpu() {
  try {
    const r = spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return r.status === 0 && /GPU\s*\d+/i.test(r.stdout || '');
  } catch (_) {
    return false;
  }
}

function detectBackend(platform, arch, probe) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  if (p === 'darwin' && a === 'arm64') return 'metal';
  const gpu = probe || hasNvidiaGpu;
  if ((p === 'win32' || p === 'linux') && gpu()) return 'cuda';
  return 'cpu';
}

// The highest CUDA compute capability among installed GPUs (e.g. 8.9 for Ada, 12.0 for
// Blackwell), or null if it can't be read. Used to choose a CUDA toolkit version the GPU
// actually supports. `probe` is injectable for testing.
function nvidiaComputeCap(probe) {
  const run = probe || (() => spawnSync('nvidia-smi',
    ['--query-gpu=compute_cap', '--format=csv,noheader'],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 }));
  try {
    const r = run();
    if (!r || r.status !== 0) return null;
    const caps = String(r.stdout || '').split(/\r?\n/).map((s) => parseFloat(s.trim())).filter((n) => !Number.isNaN(n));
    return caps.length ? Math.max(...caps) : null;
  } catch (_) {
    return null;
  }
}

// Parse the CUDA toolkit version out of a build asset name, e.g.
// "llama-b9888-bin-win-cuda-12.4-x64.zip" -> 12.4. Anchored to the "llama-" prefix so the
// separate "cudart-*" runtime archive (which also contains "cuda-<ver>") never matches.
// Returns a number or null.
function cudaBuildVersion(name) {
  const m = /^llama-.*-cuda-(\d+)(?:\.(\d+))?-x64\.zip$/i.exec(String(name || ''));
  return m ? parseFloat(m[1] + '.' + (m[2] || '0')) : null;
}

// The CUDA toolkit version of a "cudart-*" runtime archive, or null.
function cudartVersion(name) {
  const m = /^cudart-.*cuda-(\d+)(?:\.(\d+))?-x64\.zip$/i.exec(String(name || ''));
  return m ? parseFloat(m[1] + '.' + (m[2] || '0')) : null;
}

// Choose the CUDA *build* archive whose toolkit best fits the GPU. CUDA 13 dropped support
// for compute capability < 7.5 (Turing), so on older GPUs we prefer a CUDA 12 build;
// otherwise (and for newer GPUs like Blackwell, which need the newest toolkit) we take the
// highest version available. Returns the asset object, or null if the release ships none.
function pickCudaBuild(assets, computeCap) {
  const cands = (Array.isArray(assets) ? assets : [])
    .map((a) => ({ a, v: cudaBuildVersion(a.name) }))
    .filter((x) => x.v != null)
    .sort((x, y) => y.v - x.v); // highest toolkit first
  if (!cands.length) return null;
  if (computeCap != null && computeCap < 7.5) {
    const legacy = cands.filter((x) => Math.floor(x.v) < 13);
    if (legacy.length) return legacy[0].a;
  }
  return cands[0].a;
}

// Ordered asset-name patterns for the NON-CUDA backends (CPU / Metal). CUDA is handled
// separately by pickCudaBuild so version selection and the "llama-" anchor are explicit.
//
// Windows builds ship as .zip, but the macOS and Linux artifacts are .tar.gz (llama.cpp
// moved the POSIX releases to tarballs), so those patterns accept either extension —
// matching only .zip found no asset at all and failed the install with "no prebuilt
// binary is available for this platform".
function assetPatterns(platform, arch) {
  if (platform === 'win32') {
    return [/bin-win-cpu-x64\.zip$/i, /bin-win-avx2-x64\.zip$/i, /bin-win-x64\.zip$/i, /win.*x64\.zip$/i];
  }
  if (platform === 'darwin') {
    // The macOS arm64 build already includes Metal GPU support; nothing extra to select.
    return arch === 'arm64'
      ? [/bin-macos-arm64\.(?:zip|tar\.gz)$/i, /macos-arm64\.(?:zip|tar\.gz)$/i]
      : [/bin-macos-x64\.(?:zip|tar\.gz)$/i, /macos-x64\.(?:zip|tar\.gz)$/i];
  }
  // linux and anything else
  return [/bin-ubuntu-x64\.(?:zip|tar\.gz)$/i, /ubuntu-x64\.(?:zip|tar\.gz)$/i, /linux.*x64\.(?:zip|tar\.gz)$/i];
}

// Choose the best build asset ({ name, browser_download_url }) for this machine/backend.
// For 'cuda' we pick the version-appropriate CUDA build, falling back to the CPU build if
// the release ships no CUDA asset (so we still get a working binary rather than nothing).
function pickAsset(assets, platform, arch, backend, computeCap) {
  const list = Array.isArray(assets) ? assets : [];
  const p = platform || process.platform;
  const a = arch || process.arch;
  if ((backend || 'cpu') === 'cuda') {
    const cuda = pickCudaBuild(list, computeCap == null ? null : computeCap);
    if (cuda) return cuda;
    // fall through to CPU patterns
  }
  for (const pat of assetPatterns(p, a)) {
    const hit = list.find((x) => pat.test(x.name || ''));
    if (hit) return hit;
  }
  return null;
}

// The Windows CUDA build links against the CUDA runtime DLLs (cudart, cublas), shipped as
// a SEPARATE "cudart-llama-bin-win-cuda-<ver>" archive that must be unpacked beside
// llama-server.exe. Prefers the cudart matching the chosen build's toolkit version, else
// the highest available. Returns the asset, or null.
function cudartAsset(assets, platform, version) {
  if ((platform || process.platform) !== 'win32') return null;
  const cands = (Array.isArray(assets) ? assets : [])
    .map((a) => ({ a, v: cudartVersion(a.name) }))
    .filter((x) => x.v != null);
  if (!cands.length) return null;
  if (version != null) { const exact = cands.find((x) => x.v === version); if (exact) return exact.a; }
  cands.sort((x, y) => y.v - x.v);
  return cands[0].a;
}

// Recursively locate the server binary under a directory.
function findServerBinary(dir) {
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.name.toLowerCase() === SERVER_NAME.toLowerCase()) return abs;
    }
  }
  return null;
}

// A server binary from a previous download, if present.
function installedBinary(installDir) {
  const dir = installDir || defaultInstallDir();
  if (!fs.existsSync(dir)) return null;
  return findServerBinary(dir);
}

// Fetch the latest release JSON from GitHub.
async function fetchLatestRelease() {
  const res = await fetch(RELEASES_API, {
    headers: { 'User-Agent': 'cicada-ide', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub releases API returned ${res.status}`);
  return res.json();
}

// Stream a URL to disk, reporting integer percent via onProgress when the length is known.
async function downloadTo(url, dest, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': 'cicada-ide' }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0, lastPct = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((resolve, reject) => out.write(Buffer.from(value), (e) => (e ? reject(e) : resolve())));
      received += value.length;
      if (total && onProgress) {
        const pct = Math.round((received / total) * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress(pct, received, total); }
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  return dest;
}

// Extract a release archive with whatever the OS already provides — no npm dependency.
// Handles both the Windows .zip builds and the .tar.gz used for macOS/Linux.
function extractArchive(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (/\.t(?:ar\.)?gz$/i.test(zipPath)) {
    // tar reads gzip on every supported OS (bsdtar ships with Windows 10 1803+).
    const r = spawnSync('tar', ['-xzf', zipPath, '-C', destDir], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return true;
    throw new Error('Could not extract llama.cpp: ' + ((r.stderr || '').trim() || 'tar failed'));
  }
  if (process.platform === 'win32') {
    // PowerShell's Expand-Archive is present on every supported Windows.
    const ps = `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return true;
    // Fall back to bsdtar (ships with Windows 10 1803+), which also reads zips.
    const t = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { encoding: 'utf8', windowsHide: true });
    if (t.status === 0) return true;
    throw new Error('Could not unzip llama.cpp: ' + ((r.stderr || t.stderr || '').trim() || 'unknown error'));
  }
  // macOS / Linux: prefer unzip, fall back to bsdtar.
  let r = spawnSync('unzip', ['-o', zipPath, '-d', destDir], { encoding: 'utf8' });
  if (r.status === 0) return true;
  r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { encoding: 'utf8' });
  if (r.status === 0) return true;
  throw new Error('Could not unzip llama.cpp: ' + ((r.stderr || '').trim() || 'no unzip/tar available'));
}

// Full flow. onProgress({ state, detail, percent }) states: query, download, extract,
// done, error. Resolves with the absolute path to the server binary, or throws.
//   state 'query'    — contacting GitHub
//   state 'download' — streaming the asset (percent set)
//   state 'extract'  — unzipping
//   state 'done'     — ready (detail = binary path)
async function ensureLlamaServer(opts) {
  const o = opts || {};
  const backend = o.backend || detectBackend();
  const installDir = o.installDir || installDirFor(backend);
  const emit = (state, detail, percent) => { try { o.onProgress && o.onProgress({ state, detail: detail || null, percent: percent == null ? null : percent }); } catch (_) { /* ignore */ } };

  const existing = installedBinary(installDir);
  if (existing) { emit('done', existing); return existing; }

  const label = backend === 'cuda' ? 'CUDA' : backend === 'metal' ? 'Metal' : 'CPU';
  emit('query', `Finding the latest llama.cpp release (${label})…`);
  const release = await fetchLatestRelease();
  // Match the CUDA toolkit to the GPU's compute capability (Blackwell needs the newest;
  // pre-Turing GPUs need CUDA 12). null when not applicable / unreadable.
  const computeCap = backend === 'cuda' ? nvidiaComputeCap() : null;
  const asset = pickAsset(release.assets, process.platform, process.arch, backend, computeCap);
  if (!asset) throw new Error('No prebuilt llama.cpp binary is available for this platform. Install llama.cpp manually and set it in Settings.');

  fs.mkdirSync(installDir, { recursive: true });
  const outDir = path.join(installDir, (release.tag_name || 'llama').replace(/[^\w.-]/g, '_'));

  const zipPath = path.join(installDir, asset.name);
  emit('download', 'Downloading ' + asset.name + '…', 0);
  await downloadTo(asset.browser_download_url, zipPath, (pct) => emit('download', `Downloading llama.cpp (${label})… ` + pct + '%', pct));
  emit('extract', 'Extracting llama.cpp…');
  extractArchive(zipPath, outDir);
  try { fs.unlinkSync(zipPath); } catch (_) { /* keep the zip if it's locked */ }

  // A Windows CUDA build needs the CUDA runtime DLLs, shipped as a separate archive.
  // Extract them into the SAME folder as the server binary so it can load them, matching
  // the build's toolkit version. If the release ships no cudart asset we proceed anyway
  // (the DLLs may already be on the system CUDA install).
  if (backend === 'cuda' && process.platform === 'win32') {
    const cudart = cudartAsset(release.assets, process.platform, cudaBuildVersion(asset.name));
    if (cudart) {
      const cudartZip = path.join(installDir, cudart.name);
      emit('download', 'Downloading CUDA runtime…', 0);
      await downloadTo(cudart.browser_download_url, cudartZip, (pct) => emit('download', 'Downloading CUDA runtime… ' + pct + '%', pct));
      emit('extract', 'Extracting CUDA runtime…');
      extractArchive(cudartZip, outDir);
      try { fs.unlinkSync(cudartZip); } catch (_) { /* ignore */ }
    }
  }

  const binary = findServerBinary(outDir) || findServerBinary(installDir);
  if (!binary) throw new Error('Downloaded llama.cpp but could not find ' + SERVER_NAME + ' inside the archive.');
  // Ensure it is executable on POSIX (zip loses the bit).
  if (process.platform !== 'win32') { try { fs.chmodSync(binary, 0o755); } catch (_) { /* ignore */ } }

  emit('done', binary);
  return binary;
}

// ---- Default model auto-download ------------------------------------------------
//
// The other half of a zero-setup first run: when the configured model file does not
// exist and is the stock default, fetch it from Hugging Face into ~/GARM Code/models.
// Downloads to a .part file and renames only on completion, so an interrupted download
// never leaves a truncated .gguf that llama-server would then crash on.

const DEFAULT_MODEL_FILE = 'qwen2.5-coder-3b-instruct-q4_k_m.gguf';
const DEFAULT_MODEL_URL =
  'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/' + DEFAULT_MODEL_FILE;
const DEFAULT_MODEL_SIZE_HINT = '≈2.1 GB';

// Stock model file names shipped as the default by EARLIER versions. A config still naming
// one of these is treated as "the default" so first run fetches the current model instead
// of refusing with "pick a .gguf in Settings" — the user never chose that path, we did.
// Only ever add names this app actually shipped: anything else is a model the user picked
// deliberately, and silently replacing it with a 2 GB download is the very thing
// isDefaultModel exists to prevent. Lower-case — isDefaultModel lower-cases before lookup.
const LEGACY_MODEL_FILES = [
  'mythos-nano-q4_k_m.gguf', // the default up to v0.2.0
];

function defaultModelDir() {
  return path.join(os.homedir(), 'GARM Code', 'models');
}

function defaultModelPath() {
  return path.join(defaultModelDir(), DEFAULT_MODEL_FILE);
}

// True when `modelPath` refers to a stock model shipped by the app (current or legacy),
// so a missing custom model is surfaced as an error instead of silently replaced by a
// 2 GB download. Both sides are lower-cased — the current default is mixed-case.
function isDefaultModel(modelPath) {
  const name = path.basename(String(modelPath || '')).toLowerCase();
  return name === DEFAULT_MODEL_FILE.toLowerCase() || LEGACY_MODEL_FILES.includes(name);
}

// Download the default model if it is not already present. onProgress states mirror
// ensureLlamaServer: 'query' / 'download' (percent set) / 'done' / (throws on failure).
// Resolves with the absolute path to the .gguf.
async function ensureDefaultModel(opts) {
  const o = opts || {};
  const dest = o.dest || defaultModelPath();
  const emit = (state, detail, percent) => { try { o.onProgress && o.onProgress({ state, detail: detail || null, percent: percent == null ? null : percent }); } catch (_) { /* ignore */ } };

  if (fs.existsSync(dest)) { emit('done', dest); return dest; }

  const part = dest + '.part';
  try { fs.unlinkSync(part); } catch (_) { /* no stale partial */ }
  emit('query', `Downloading the default model (${DEFAULT_MODEL_SIZE_HINT}) — one-time setup…`);
  await downloadTo(o.url || DEFAULT_MODEL_URL, part,
    (pct) => emit('download', `Downloading the model (${DEFAULT_MODEL_SIZE_HINT})… ${pct}%`, pct));
  // A finished download of a GGUF is never tiny; guard against an HTML error page.
  const size = fs.statSync(part).size;
  if (size < 50 * 1024 * 1024) {
    try { fs.unlinkSync(part); } catch (_) { /* ignore */ }
    throw new Error('Model download was incomplete or blocked (received ' + Math.round(size / 1024) + ' KB). Check your connection and try again.');
  }
  fs.renameSync(part, dest);
  emit('done', dest);
  return dest;
}

module.exports = {
  defaultInstallDir, installDirFor, assetPatterns, pickAsset, pickCudaBuild, cudartAsset,
  cudaBuildVersion, cudartVersion, detectBackend, hasNvidiaGpu, nvidiaComputeCap,
  findServerBinary, installedBinary, ensureLlamaServer, SERVER_NAME,
  defaultModelDir, defaultModelPath, isDefaultModel, ensureDefaultModel,
  DEFAULT_MODEL_FILE, DEFAULT_MODEL_URL,
};
