'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const configMod = require('./config');
const { LlamaServer, resolveBinary } = require('./llama');
const llamaInstaller = require('./llama-installer');
const { Pipeline } = require('./pipeline');
const { ContextMemory } = require('./memory');
const { streamChatResilient } = require('./llm');
const python = require('./python');
const { Terminal } = require('./terminal');
const projects = require('./projects');
const datasets = require('./datasets');
const github = require('./github');
const experiments = require('./experiments');
const doctor = require('./doctor');
const snapshots = require('./snapshots');
const sysmon = require('./sysmon');
const insights = require('./insights');

// On-demand dataset insights are cached in memory per (workspace, dataset id) — cheap to
// recompute, so no persistence; cleared on project switch and dataset re-analysis.
const insightsCache = new Map();

let mainWindow = null;
let config = configMod.load();
let llama = null;
let pipeline = null;
let terminal = null;
let memory = new ContextMemory(config.workspaceDir);
let envInfo = null;        // detected interpreter + library support
let activeInstall = null;  // current pip install handle

// Probe the configured interpreter for installed ML/scientific libraries, cache the
// result, push it to the pipeline + renderer.
async function detectEnv() {
  envInfo = await python.detectEnvironment({ pythonPath: config.pythonPath });
  if (pipeline) pipeline.env = envInfo;
  send('env:update', envInfo);
  return envInfo;
}
let activeRun = null; // current python.run handle (pipeline or editor Run)
let chatAbort = null; // AbortController for the in-flight chat turn

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---- Chat agent context ------------------------------------------------------
// Resolve the active inference backend (local llama-server or DeepSeek) exactly as the pipeline
// does, so chat uses whatever the user has configured.
function activeBackend() {
  if (config.provider === 'deepseek') {
    return { baseUrl: DEEPSEEK_BASE_URL, apiKey: config.deepseekApiKey, model: config.deepseekModel };
  }
  return { baseUrl: llama ? llama.baseUrl() : '', apiKey: null, model: null };
}

// Render the project file tree as an indented text outline for the chat context.
function treeOutline(nodes, prefix) {
  let out = '';
  for (const n of nodes || []) {
    out += prefix + (n.type === 'dir' ? '📁 ' : '') + n.name + '\n';
    if (n.type === 'dir' && n.children && n.children.length) out += treeOutline(n.children, prefix + '  ');
  }
  return out;
}

// Gather readable source files under the workspace (skipping binaries / big files / vendored
// dirs), up to a total character budget, so chat has broad project awareness without blowing
// the context window.
function gatherProjectFiles(budget) {
  const SKIP_DIRS = new Set(['__pycache__', '.git', 'node_modules', '.venv', 'venv', 'data', 'dist', 'out']);
  const out = [];
  let used = 0;
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (used >= budget) return;
      if (e.name.startsWith('.') || e.name.startsWith('_garm_')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, r); continue; }
      let st; try { st = fs.statSync(abs); } catch (_) { continue; }
      if (st.size > 64 * 1024) continue;
      let buf; try { buf = fs.readFileSync(abs); } catch (_) { continue; }
      if (buf.includes(0)) continue; // binary
      const text = buf.toString('utf8');
      const slice = text.slice(0, Math.max(0, budget - used));
      used += slice.length;
      out.push({ path: r, text: slice, truncated: slice.length < text.length });
    }
  };
  walk(config.workspaceDir, '');
  return out;
}

// System prompt: the assistant's role + a snapshot of the whole project it can reason over.
function buildChatSystem() {
  const parts = [
    "You are Cicada's built-in coding assistant, embedded in an agentic Python IDE. You answer the " +
    "user's questions about THIS project — code, debugging, math, algorithms, ideas, and general " +
    "questions. Be accurate and concise. Format every reply in Markdown: put code in fenced blocks " +
    "with a language tag (```python), use `inline code` for identifiers, and write math with $…$ " +
    "inline or $$…$$ for display. When the user attaches selected lines, focus your answer on them.",
    '\n=== PROJECT: ' + path.basename(config.workspaceDir) + ' ===',
  ];
  try { parts.push('File tree:\n' + treeOutline(projects.tree(config.workspaceDir), '')); } catch (_) { /* ignore */ }
  const files = gatherProjectFiles(48 * 1024);
  if (files.length) {
    parts.push('\nProject files:');
    for (const f of files) parts.push('\n--- ' + f.path + (f.truncated ? ' (truncated)' : '') + ' ---\n' + f.text);
  }
  // Uploaded data files (CSV/Excel/JSON): schemas + load hints, so chat can inspect,
  // summarize, and reason over them and propose programs built on the real data.
  const dataCtx = datasets.formatForPrompt(datasets.list(config.workspaceDir), 6000);
  if (dataCtx) parts.push('\n' + dataCtx);
  return parts.join('\n');
}

// Fold the current editor attachment (active file + selected lines) into the user's question.
function decorateUserMessage(text, context) {
  if (!context) return text;
  const bits = [];
  if (context.file) bits.push('[Active file: ' + context.file + ']');
  const s = context.selection;
  if (s && s.text) {
    const lang = context.language || 'python';
    bits.push('[Selected lines ' + s.startLine + '–' + s.endLine + ' of ' + (context.file || 'the file') +
      ']\n```' + lang + '\n' + s.text + '\n```');
  }
  return bits.length ? bits.join('\n') + '\n\n' + text : text;
}

// Centralised Python runner. Streams run:* events and resolves with { code, images }.
// Used by both the agentic pipeline and the editor's Run button.
function runFileStreaming(file, opts = {}) {
  return new Promise((resolve) => {
    if (activeRun) { try { activeRun.kill(); } catch (_) { /* ignore */ } }
    send('run:clear', {});
    send('run:started', { file });
    let stderr = '';
    // Rolling tail of combined output for the experiment tracker's metric parser.
    // Capped so a chatty training loop can't grow memory unbounded.
    let outTail = '';
    const TAIL_CAP = 64 * 1024;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    activeRun = python.run({
      pythonPath: config.pythonPath,
      file,
      cwd: config.workspaceDir,
      render: true,
      timeoutMs: opts.timeoutMs || 0, // 0 = no limit (interactive editor Run); pipeline sets one
      onData: (stream, text) => {
        if (stream === 'stderr') stderr += text;
        outTail += text;
        if (outTail.length > TAIL_CAP) outTail = outTail.slice(-TAIL_CAP);
        send('run:data', { stream, text });
      },
      onExit: (code, { images }) => {
        send('run:exit', { code });
        if (images && images.length) {
          // pathToFileURL percent-encodes spaces etc. so paths like ".../GARM Code/..." load.
          send('run:images', { images: images.map((p) => ({ path: p, url: pathToFileURL(p).href })) });
        }
        // Record the run in the experiment tracker. Strictly best-effort: a tracker
        // problem must never affect the run result the pipeline/editor sees.
        try {
          experiments.record(config.workspaceDir, {
            file: path.relative(config.workspaceDir, file) || path.basename(file),
            source: opts.source || 'run',
            startedAt,
            durationMs: Date.now() - t0,
            exitCode: code,
            output: outTail,
            images: (images || []).length,
          });
          send('experiments:update', experiments.list(config.workspaceDir));
        } catch (err) {
          console.error('[experiments] record failed:', err.message);
        }
        activeRun = null;
        resolve({ code, images, stderr });
      },
    });
  });
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  const winOpts = {
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0e1116',
    title: 'Cicada',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  };
  // macOS keeps its inset traffic lights over our custom top bar; Windows/Linux get a
  // frameless window so the OS title bar doesn't sit above our themed header (the app
  // draws its own minimize/maximize/close controls instead — see the renderer).
  if (isMac) winOpts.titleBarStyle = 'hiddenInset';
  else winOpts.frame = false;
  // Trailer-capture mode: fill the screen and stay on top so a full-desktop screen
  // recording captures nothing but the app (gdigrab can't BitBlt a GPU-composited window
  // directly, but the composited desktop records cleanly).
  const trailerMode = !!process.env.GARM_TRAILER;
  if (trailerMode) { winOpts.fullscreen = true; winOpts.alwaysOnTop = true; winOpts.show = false; }
  mainWindow = new BrowserWindow(winOpts);

  // The `fullscreen`/`alwaysOnTop` constructor options are requests, not guarantees — the OS
  // compositor's exclusive-fullscreen transition and window-raise can lag behind window
  // creation by up to a second or so. A screen-recording capture has no way to know when that
  // has actually finished, so force it deterministically: hold the window hidden until it is
  // ready to paint, then show + focus + raise it, and re-assert on every focus loss (some
  // desktop capturers themselves briefly steal focus).
  if (trailerMode) {
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.focus();
      mainWindow.moveTop();
    });
    mainWindow.on('blur', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.moveTop(); });
  }

  // Keep the custom maximize/restore glyph in sync with the real window state.
  mainWindow.on('maximize', () => send('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => send('window:state', { maximized: false }));
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Surface renderer problems on the main process stdout (no interactive DevTools here).
  const wc = mainWindow.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`));
  wc.on('render-process-gone', (_e, details) => console.error('[renderer] gone:', details));
  wc.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer ${level === 3 ? 'error' : 'warn'}] ${message} (${(source || '').split('/').pop()}:${line})`);
  });
  if (process.env.GARM_DEVTOOLS) wc.openDevTools({ mode: 'detach' });

  // Drive the UI programmatically (verification only).
  if (process.env.GARM_AUTORUN) {
    wc.on('did-finish-load', () => {
      setTimeout(() => {
        const mode = process.env.GARM_AUTORUN;
        let js = '';
        if (mode === 'editor') js = "document.querySelector('#btn-run').click();";
        else if (mode === 'plot') {
          const plot = 'import matplotlib.pyplot as plt\\nplt.figure()\\nplt.bar(range(1,6), [i*i for i in range(1,6)])\\nplt.title("squares")\\nplt.xlabel("n")\\nplt.ylabel("n^2")\\nplt.show()\\n';
          js = "window.GARMEditor.setValue('" + plot + "'); setTimeout(function(){ document.querySelector('#btn-run').click(); }, 400);";
        } else if (mode.startsWith('pipeline:')) {
          const prompt = mode.slice('pipeline:'.length).replace(/['\\]/g, '\\$&');
          js = "document.querySelector('#prompt').value='" + prompt + "'; document.querySelector('#btn-run-pipeline').click();";
        } else if (mode.startsWith('refine:')) {
          const change = mode.slice('refine:'.length).replace(/['\\]/g, '\\$&');
          const base = 'def main():\\n    for i in range(1, 6):\\n        print(i)\\n\\nif __name__ == "__main__":\\n    main()\\n';
          js = "window.GARMEditor.setValue('" + base + "'); document.querySelector('#refine-input').value='" + change + "'; setTimeout(function(){ document.querySelector('#btn-refine').click(); }, 500);";
        } else if (mode.startsWith('js:')) {
          // General passthrough for driving the UI in verification (env-gated).
          js = mode.slice('js:'.length);
        } else if (mode.startsWith('jsfile:')) {
          try { js = fs.readFileSync(mode.slice('jsfile:'.length), 'utf8'); } catch (e) { console.error('[autorun] jsfile read failed', e.message); }
        }
        wc.executeJavaScript(js).catch((e) => console.error('[autorun]', e));
      }, parseInt(process.env.GARM_AUTORUN_DELAY || '5000', 10));
    });
  }

  // Permission-free screenshot(s) of the real window (for verification).
  if (process.env.GARM_CAPTURE) {
    wc.on('did-finish-load', () => {
      const delays = (process.env.GARM_CAPTURE_DELAYS || process.env.GARM_CAPTURE_DELAY || '9000')
        .split(',').map((s) => parseInt(s, 10));
      delays.forEach((d, i) => setTimeout(async () => {
        try {
          const img = await wc.capturePage();
          const out = delays.length > 1
            ? process.env.GARM_CAPTURE.replace(/\.png$/, '_' + (i + 1) + '.png')
            : process.env.GARM_CAPTURE;
          fs.writeFileSync(out, img.toPNG());
          console.log('[capture] wrote ' + out);
        } catch (e) { console.error('[capture] failed', e); }
      }, d));
    });
  }
}

// DeepSeek's OpenAI-compatible base (it accepts the /v1/chat/completions path too).
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

// Is an inference backend usable right now? Local => llama-server ready; DeepSeek => key set.
function providerReady() {
  if (config.provider === 'deepseek') return !!(config.deepseekApiKey && config.deepseekApiKey.trim());
  return !!(llama && llama.status === 'ready');
}

// Status for the renderer pill, accounting for the active provider (we never start
// llama-server in deepseek mode). Shape matches applyStatus(): { status, detail }.
function currentStatus() {
  if (config.provider === 'deepseek') {
    return providerReady()
      ? { status: 'ready', detail: 'DeepSeek · ' + config.deepseekModel }
      : { status: 'error', detail: 'Add a DeepSeek API key in Settings' };
  }
  const i = llama ? llama.info() : { status: 'stopped', lastError: null, baseUrl: '' };
  return { status: i.status, detail: i.lastError || i.baseUrl };
}

function pushStatus() { send('llama:status', currentStatus()); }

let installingLlama = false;

// First-run convenience: if local inference is selected but no llama-server binary can be
// found anywhere, auto-download a prebuilt llama.cpp release and record its path in config.
// Streams progress to the renderer via 'llama:install'. Returns true once a binary is usable.
async function ensureLlamaBinary() {
  if (config.provider !== 'local') return true;
  // Pick the best compute backend for this machine (CUDA on an NVIDIA GPU, Metal on Apple
  // Silicon, else CPU). Reuse the recorded binary only when it already matches that backend
  // — so a machine that gained a GPU (or a CPU-only first install) transparently upgrades.
  const backend = llamaInstaller.detectBackend();
  if (config.llamaBackend === backend && resolveBinary(config.llamaServerPath)) return true;
  if (installingLlama) return false;
  installingLlama = true;
  try {
    const label = backend === 'cuda' ? 'CUDA' : backend === 'metal' ? 'Metal' : 'CPU';
    send('llama:install', { state: 'query', detail: `Setting up llama.cpp (${label})…`, percent: null });
    // ensureLlamaServer emits its own 'done' progress event, which is relayed below —
    // so we don't send another here (that would fire the "installed" toast twice).
    const bin = await llamaInstaller.ensureLlamaServer({ backend, onProgress: (p) => send('llama:install', p) });
    if (bin) {
      config = configMod.save({ llamaServerPath: bin, llamaBackend: backend });
      if (llama) llama.config = config;
      return true;
    }
    return false;
  } catch (e) {
    send('llama:install', { state: 'error', detail: e.message, percent: null });
    if (llama) { llama.status = 'error'; llama.lastError = 'llama.cpp setup failed: ' + e.message; }
    pushStatus();
    return false;
  } finally {
    installingLlama = false;
  }
}

let downloadingModel = false;

// First-run convenience #2: when the configured model file is missing and it is the
// stock default, download it automatically from Hugging Face (progress streams to the
// status pill via 'llama:install'). A missing CUSTOM model path is never replaced by a
// 2 GB download — that is surfaced as an actionable error instead.
async function ensureModelFile() {
  if (config.provider !== 'local') return true;
  if (fs.existsSync(config.modelPath)) return true;
  if (!llamaInstaller.isDefaultModel(config.modelPath)) {
    if (llama) {
      llama.status = 'error';
      llama.lastError = `Model file not found: ${config.modelPath} — pick a .gguf in Settings, or clear the path to use the default model.`;
    }
    pushStatus();
    return false;
  }
  if (downloadingModel) return false;
  downloadingModel = true;
  try {
    send('llama:install', { state: 'query', detail: 'Model not found — downloading it (one-time setup)…', percent: null });
    const p = await llamaInstaller.ensureDefaultModel({
      onProgress: (pr) => { if (pr.state !== 'done') send('llama:install', pr); },
    });
    config = configMod.save({ modelPath: p });
    if (llama) llama.config = config;
    send('llama:install', { state: 'done', detail: 'model', percent: null });
    return true;
  } catch (e) {
    send('llama:install', { state: 'error', detail: 'Model download failed: ' + e.message, percent: null });
    if (llama) { llama.status = 'error'; llama.lastError = 'Model download failed: ' + e.message; }
    pushStatus();
    return false;
  } finally {
    downloadingModel = false;
  }
}

// Ensure a binary + model (auto-downloading either if needed), then start the server.
async function startLocalLlama() {
  const ok = await ensureLlamaBinary();
  if (!ok) { pushStatus(); return; }
  const modelOk = await ensureModelFile();
  if (modelOk) llama.start(); else pushStatus();
}

function setupLlama() {
  llama = new LlamaServer(config);
  // In local mode the pill tracks the server; in deepseek mode currentStatus() ignores it.
  llama.on('status', () => pushStatus());
  llama.on('log', (line) => send('llama:log', { line }));
  if (config.provider === 'local') startLocalLlama();
  else pushStatus(); // deepseek: don't spin up a local server; report key/model status
}

function getPipeline() {
  if (!pipeline) {
    pipeline = new Pipeline({
      config,
      baseUrl: llama.baseUrl(),
      emit: (event, payload) => send(event, payload),
      // Tag pipeline verification runs so the experiment tracker can distinguish them
      // from manual editor runs.
      runFile: (file, o) => runFileStreaming(file, { ...(o || {}), source: 'pipeline' }),
      memory,
      env: envInfo,
    });
  }
  pipeline.config = config;
  // Point the pipeline at the active backend each run (provider can change in Settings).
  if (config.provider === 'deepseek') {
    pipeline.baseUrl = DEEPSEEK_BASE_URL;
    pipeline.apiKey = config.deepseekApiKey;
    pipeline.model = config.deepseekModel;
  } else {
    pipeline.baseUrl = llama.baseUrl();
    pipeline.apiKey = null;
    pipeline.model = null;
  }
  pipeline.memory = memory;
  pipeline.env = envInfo;
  // Make the agent aware of the project's uploaded data files (schemas + load hints).
  pipeline.datasets = datasets.formatForPrompt(datasets.list(config.workspaceDir), 6000) || null;
  return pipeline;
}

function getTerminal() {
  if (!terminal) {
    terminal = new Terminal(config.workspaceDir);
    terminal.on('data', (text) => send('terminal:data', { text }));
    terminal.on('exit', (code, cwd) => send('terminal:exit', { code, cwd }));
  }
  terminal.setPython(config.pythonPath); // keep the terminal on GARM's interpreter/venv
  return terminal;
}

// Switch the active project: repoint the workspace dir, per-project memory, terminal
// cwd and pipeline. The renderer reloads its file tree + editor from the return value.
function switchProject(dir) {
  config = configMod.save({ workspaceDir: dir });
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  memory = new ContextMemory(config.workspaceDir);
  if (pipeline) { pipeline.config = config; pipeline.memory = memory; }
  if (terminal) terminal.cwd = config.workspaceDir; // next terminal command runs here
  insightsCache.clear(); // insights are per-dataset-per-project
  send('memory:update', memory.snapshot());
  send('datasets:update', datasets.list(config.workspaceDir)); // per-project data index
  send('experiments:update', experiments.list(config.workspaceDir)); // per-project run history
  send('snapshots:update', snapshots.list(config.workspaceDir));     // per-project checkpoints
  return config.workspaceDir;
}

// Absolute path of an editor target file inside the active project. Defaults to the
// project's main.py (the pipeline's entry point) when no relative path is given.
function activeFilePath(relFile) {
  return relFile
    ? projects.resolveInProject(config.workspaceDir, relFile)
    : path.join(config.workspaceDir, 'main.py');
}

// ----- IPC -----

function registerIpc() {
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:set', (_e, partial) => {
    const prevPython = config.pythonPath;
    const prevProvider = config.provider;
    config = configMod.save(partial || {});
    if (config.pythonPath !== prevPython) {
      if (terminal) terminal.setPython(config.pythonPath);
      detectEnv(); // interpreter changed -> re-probe
    }
    // Provider switch: start the local server when going local, stop it (free the RAM)
    // when going to the hosted DeepSeek API.
    if (config.provider !== prevProvider) {
      if (config.provider === 'local') startLocalLlama(); else llama.stop();
    }
    pushStatus(); // reflect provider / key / model changes in the status pill
    return config;
  });

  // Provider-aware status so the renderer's pill is correct even in deepseek mode
  // (where llama-server isn't running).
  ipcMain.handle('llama:info', () => {
    const s = currentStatus();
    return { ...llama.info(), status: s.status, lastError: s.detail };
  });
  ipcMain.handle('llama:restart', async (_e, partial) => {
    if (partial) config = configMod.save(partial);
    await llama.restart(config);
    return llama.info();
  });
  // One-click recovery (status pill / error toasts): re-run the full local startup path —
  // find or download the binary, find or download the model, start the server.
  ipcMain.handle('llama:recover', async () => {
    if (config.provider === 'local' && llama && llama.status !== 'ready' && llama.status !== 'starting'
        && !installingLlama && !downloadingModel) {
      await startLocalLlama();
    }
    pushStatus();
    return currentStatus();
  });

  ipcMain.handle('dialog:pickModel', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a GGUF model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF model', extensions: ['gguf'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('dialog:pickLlamaServer', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select the llama-server binary',
      properties: ['openFile'],
      message: 'Choose the llama-server executable from a llama.cpp build.',
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  // Gate for every model-backed request. When the local server is down it ALSO kicks a
  // background recovery, so "try again in a moment" is actually true rather than a
  // dead end the user must debug through Settings.
  const requireProvider = () => {
    if (providerReady()) return;
    if (config.provider === 'deepseek') throw new Error('Add a DeepSeek API key in Settings.');
    if (llama && llama.status !== 'starting' && !installingLlama && !downloadingModel) startLocalLlama().catch(() => {});
    const why = llama && llama.lastError ? ' (' + llama.lastError + ')' : '';
    throw new Error('The local model is not ready yet' + why +
      ' — recovery has started; watch the status pill and try again when it shows "Model ready".');
  };

  // Auto-checkpoint the project source before the agent rewrites anything, so any
  // pipeline operation can be undone from the History tab. Best-effort by design.
  const autoSnapshot = (label) => {
    try {
      const meta = snapshots.create(config.workspaceDir, label, { auto: true });
      if (meta) send('snapshots:update', snapshots.list(config.workspaceDir));
    } catch (err) {
      console.error('[snapshots] auto-snapshot failed:', err.message);
    }
  };

  ipcMain.handle('pipeline:run', async (_e, request) => {
    requireProvider();
    const p = getPipeline();
    autoSnapshot('before create');
    p.filePath = path.join(config.workspaceDir, 'main.py'); // a new build writes the entry point
    await p.run(String(request || '').trim());
    return true;
  });
  ipcMain.handle('pipeline:refine', async (_e, { request, code, file }) => {
    requireProvider();
    const p = getPipeline();
    autoSnapshot('before refine');
    p.filePath = activeFilePath(file); // edits apply to the file you have open
    await p.refine(String(request || '').trim(), code || '');
    return true;
  });
  ipcMain.handle('pipeline:inpaint', async (_e, { request, code, selection, file }) => {
    requireProvider();
    const p = getPipeline();
    autoSnapshot('before edit selection');
    p.filePath = activeFilePath(file);
    await p.inpaint(String(request || '').trim(), code || '', selection || {});
    return true;
  });
  ipcMain.handle('pipeline:cancel', () => {
    if (pipeline) pipeline.cancel();
    if (activeRun) { try { activeRun.kill(); } catch (_) { /* already gone */ } } // also stop a program the pipeline is running
    return true;
  });

  // Context-aware chat agent. The renderer sends the whole conversation; the last user turn may
  // carry an editor attachment (active file + selected lines). We prepend a system prompt holding
  // a snapshot of the project, then stream the reply back over chat:delta / chat:done.
  ipcMain.handle('chat:send', async (_e, { messages }) => {
    requireProvider();
    const history = Array.isArray(messages) ? messages.slice() : [];
    const last = history[history.length - 1];
    if (last && last.role === 'user') last.content = decorateUserMessage(last.content, last.context);
    const chatMessages = [{ role: 'system', content: buildChatSystem() }]
      .concat(history.map((m) => ({ role: m.role, content: m.content })));

    if (chatAbort) { try { chatAbort.abort(); } catch (_) { /* ignore */ } }
    const myAbort = new AbortController();
    chatAbort = myAbort;
    const backend = activeBackend();
    try {
      const full = await streamChatResilient(backend.baseUrl, {
        messages: chatMessages,
        temperature: 0.4,
        topP: 0.95,
        maxTokens: 8192,
        signal: myAbort.signal,
        apiKey: backend.apiKey,
        model: backend.model,
        onDelta: (chunk) => send('chat:delta', { text: chunk }),
        // chat:done re-renders from the final text, so a mid-stream retry only shows a
        // brief duplicate while streaming — the finished bubble is always clean.
        onRetry: () => send('chat:delta', { text: '\n\n_(connection dropped — retrying…)_\n\n' }),
      });
      send('chat:done', { text: full });
    } catch (err) {
      if (myAbort.signal.aborted) send('chat:done', { text: '', aborted: true });
      else send('chat:error', { message: err.message });
    } finally {
      if (chatAbort === myAbort) chatAbort = null;
    }
    return true;
  });
  ipcMain.handle('chat:cancel', () => { if (chatAbort) { try { chatAbort.abort(); } catch (_) { /* ignore */ } } return true; });

  // Persistent context memory.
  ipcMain.handle('memory:get', () => memory.snapshot());
  ipcMain.handle('memory:addFact', (_e, { fact }) => {
    memory.addFact(fact);
    const snap = memory.snapshot();
    send('memory:update', snap);
    return snap;
  });
  ipcMain.handle('memory:removeFact', (_e, { index }) => {
    memory.removeFact(index);
    const snap = memory.snapshot();
    send('memory:update', snap);
    return snap;
  });
  ipcMain.handle('memory:clear', () => {
    memory.clear();
    const snap = memory.snapshot();
    send('memory:update', snap);
    return snap;
  });

  // Environment / library support.
  ipcMain.handle('env:get', () => envInfo);
  ipcMain.handle('env:refresh', async () => detectEnv());
  ipcMain.handle('env:install', async (_e, { spec }) => {
    if (activeInstall) return { ok: false, error: 'An install is already running.' };
    return new Promise((resolve) => {
      send('env:install-start', { spec });
      activeInstall = python.pipInstall({
        pythonPath: config.pythonPath,
        spec,
        onData: (stream, text) => send('env:install-data', { stream, text }),
        onExit: async (code) => {
          activeInstall = null;
          send('env:install-exit', { code, spec });
          await detectEnv(); // refresh the library list after a successful install
          resolve({ ok: code === 0, code });
        },
      });
    });
  });
  ipcMain.handle('env:install-cancel', () => { if (activeInstall) activeInstall.kill(); return true; });

  // Virtual environments: discover candidates, pick one, or create a fresh .venv.
  ipcMain.handle('env:discover', () => python.discoverInterpreters(config.workspaceDir));
  ipcMain.handle('dialog:pickPython', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a Python interpreter (e.g. your venv\'s bin/python)',
      properties: ['openFile'],
      message: 'Choose the python binary inside a virtualenv, conda env, or system install.',
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });
  ipcMain.handle('env:createVenv', async () => {
    const dir = path.join(config.workspaceDir, '.venv');
    send('env:install-start', { spec: 'venv' });
    const res = await python.createVenv({
      pythonPath: config.pythonPath, dir,
      onData: (stream, text) => send('env:install-data', { stream, text }),
    });
    if (res.ok && res.python) {
      config = configMod.save({ pythonPath: res.python });
      if (terminal) terminal.setPython(config.pythonPath);
      await detectEnv();
    }
    send('env:install-exit', { code: res.ok ? 0 : 1, spec: 'venv' });
    return { ...res, pythonPath: config.pythonPath };
  });

  // Editor-driven actions.
  // `file` is a project-relative path (the open file); defaults to main.py.
  ipcMain.handle('code:save', (_e, { code, file }) => {
    const target = activeFilePath(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, code, 'utf8');
    return target;
  });
  ipcMain.handle('code:compile', async (_e, { code, file }) => {
    const target = activeFilePath(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, code, 'utf8');
    return python.compileCheck({ pythonPath: config.pythonPath, file: target });
  });
  ipcMain.handle('code:run', async (_e, { code, file }) => {
    const target = activeFilePath(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, code, 'utf8');
    return runFileStreaming(target);
  });
  ipcMain.handle('run:input', (_e, { text }) => { if (activeRun) activeRun.write(text); return true; });
  ipcMain.handle('run:stop', () => {
    if (activeRun) activeRun.kill();
    // If the program is running inside the agent pipeline (its Run/verify stage), Stop must
    // also cancel the pipeline — otherwise it would treat the kill as a crash and try to
    // "repair" and re-run the very program the user just stopped.
    if (pipeline && pipeline.running) pipeline.cancel();
    return true;
  });

  // Terminal.
  ipcMain.handle('terminal:exec', (_e, { command }) => { getTerminal().exec(command); return true; });
  ipcMain.handle('terminal:input', (_e, { data }) => { getTerminal().input(data); return true; });
  ipcMain.handle('terminal:interrupt', () => { getTerminal().interrupt(); return true; });
  ipcMain.handle('terminal:cwd', () => getTerminal().cwd);

  // ----- Projects -----
  ipcMain.handle('projects:list', () => projects.list(config));
  ipcMain.handle('projects:create', (_e, { name }) => {
    const project = projects.create(config, name);
    switchProject(project.path);
    return {
      project, list: projects.list(config),
      tree: projects.tree(config.workspaceDir), defaultFile: projects.defaultFile(config.workspaceDir),
    };
  });
  ipcMain.handle('projects:open', (_e, { path: dir }) => {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Project folder not found.');
    switchProject(dir);
    return {
      list: projects.list(config), workspaceDir: config.workspaceDir,
      tree: projects.tree(config.workspaceDir), defaultFile: projects.defaultFile(config.workspaceDir),
    };
  });

  // ----- Files (scoped to the active project) -----
  ipcMain.handle('files:tree', () => projects.tree(config.workspaceDir));
  ipcMain.handle('files:read', (_e, { path: rel }) => {
    const abs = projects.resolveInProject(config.workspaceDir, rel);
    const st = fs.statSync(abs);
    // A folder / oversized / binary file isn't an error — it just can't be shown in the text
    // editor. Return a structured "not openable" result so the renderer can show a clean notice
    // and leave the current file open, instead of surfacing a raw IPC rejection to the user.
    if (st.isDirectory()) return { path: rel, openable: false, reason: 'this is a folder, not a file' };
    if (st.size > 2 * 1024 * 1024) return { path: rel, openable: false, reason: 'file is larger than 2 MB, not shown in the editor' };
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return { path: rel, openable: false, reason: 'binary file, not shown in the text editor' };
    return { path: rel, content: buf.toString('utf8') };
  });
  ipcMain.handle('files:save', (_e, { path: rel, content }) => projects.writeFile(config.workspaceDir, rel, content));
  ipcMain.handle('files:create', (_e, { path: rel }) => {
    const abs = projects.createFile(config.workspaceDir, rel);
    return { path: path.relative(config.workspaceDir, abs), tree: projects.tree(config.workspaceDir) };
  });
  ipcMain.handle('files:mkdir', (_e, { path: rel }) => {
    projects.createDir(config.workspaceDir, rel);
    return { tree: projects.tree(config.workspaceDir) };
  });
  ipcMain.handle('files:rename', (_e, { from, to }) => {
    projects.rename(config.workspaceDir, from, to);
    return { tree: projects.tree(config.workspaceDir) };
  });
  ipcMain.handle('files:delete', async (_e, { path: rel }) => {
    const abs = projects.resolveInProject(config.workspaceDir, rel);
    await shell.trashItem(abs); // recoverable — moves to the OS Trash, never a hard delete
    return { tree: projects.tree(config.workspaceDir) };
  });

  // ----- Datasets (document ingestion, scoped to the active project) -----
  // add: paths already on disk (drag-drop, resolved via webUtils in the renderer).
  // import: open a native file picker, then ingest the chosen files.
  const ingest = async (paths) => {
    const res = await datasets.add(config.workspaceDir, paths || [], config.pythonPath,
      (p) => send('datasets:progress', p));
    send('datasets:update', datasets.list(config.workspaceDir));
    return Object.assign({}, res, { datasets: datasets.list(config.workspaceDir) });
  };
  ipcMain.handle('datasets:list', () => datasets.list(config.workspaceDir));
  ipcMain.handle('datasets:add', async (_e, { paths }) => ingest(paths));
  ipcMain.handle('datasets:import', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Add data files to this project',
      message: 'Choose CSV, Excel, or JSON files to add to the project.',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Data files (CSV, Excel, JSON)', extensions: datasets.supportedExtensions() },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) {
      return { added: [], errors: [], canceled: true, datasets: datasets.list(config.workspaceDir) };
    }
    return ingest(r.filePaths);
  });
  ipcMain.handle('datasets:remove', async (_e, { id }) => {
    const r = datasets.remove(config.workspaceDir, id);
    if (r.absPath) { try { await shell.trashItem(r.absPath); } catch (_) { /* already gone */ } }
    insightsCache.delete(config.workspaceDir + '|' + id);
    send('datasets:update', datasets.list(config.workspaceDir));
    return { removed: r.removed, datasets: datasets.list(config.workspaceDir) };
  });
  ipcMain.handle('datasets:reanalyze', async (_e, { id }) => {
    await datasets.reanalyze(config.workspaceDir, id, config.pythonPath);
    insightsCache.delete(config.workspaceDir + '|' + id); // schema changed -> stale insights
    send('datasets:update', datasets.list(config.workspaceDir));
    return { datasets: datasets.list(config.workspaceDir) };
  });

  // ----- GitHub integration (scoped to the active project) -----
  ipcMain.handle('github:status', () => github.status(config.workspaceDir));
  ipcMain.handle('github:verifyToken', async (_e, { token }) => {
    const r = await github.verifyToken(token);
    if (r.ok) config = configMod.save({ githubToken: token.trim() }); // remember a working token
    return r;
  });
  ipcMain.handle('github:generateFiles', (_e, opts) => {
    const r = github.generateFiles(config.workspaceDir, {
      projectName: path.basename(config.workspaceDir),
      ...(opts || {}),
    });
    return { ...r, tree: projects.tree(config.workspaceDir) };
  });
  ipcMain.handle('github:commit', async (_e, { message }) => {
    const r = await github.commitAll(config.workspaceDir, message);
    return { ...r, status: await github.status(config.workspaceDir) };
  });
  ipcMain.handle('github:publish', async (_e, opts) => {
    const o = opts || {};
    const token = (o.token || config.githubToken || '').trim();
    if (o.token && o.token.trim() !== config.githubToken) config = configMod.save({ githubToken: o.token.trim() });
    const result = await github.publish(config.workspaceDir, {
      ...o,
      token,
      repoName: github.repoNameFor(o.repoName || path.basename(config.workspaceDir)),
    }, (progress) => send('github:progress', progress));
    return { ...result, status: await github.status(config.workspaceDir), tree: projects.tree(config.workspaceDir) };
  });
  ipcMain.handle('github:push', async (_e, { message }) => {
    const token = (config.githubToken || '').trim();
    if (!token) return { ok: false, error: 'Add a GitHub token first.' };
    const st = await github.status(config.workspaceDir);
    if (!st.isRepo || !st.remoteUrl) return { ok: false, error: 'This project has no GitHub remote yet — use Publish first.' };
    send('github:progress', { step: 'commit', state: 'running', detail: null });
    const commit = await github.commitAll(config.workspaceDir, message || 'Update from Cicada');
    if (!commit.ok) { send('github:progress', { step: 'commit', state: 'error', detail: commit.error }); return { ok: false, error: commit.error }; }
    send('github:progress', { step: 'commit', state: 'done', detail: commit.nothingToCommit ? 'Nothing new to commit.' : 'Changes committed.' });
    send('github:progress', { step: 'push', state: 'running', detail: null });
    const pushed = await github.push(config.workspaceDir, { remoteUrl: st.remoteUrl, token, branch: st.branch || 'main' });
    send('github:progress', { step: 'push', state: pushed.ok ? 'done' : 'error', detail: pushed.ok ? ('Pushed to ' + st.webUrl) : pushed.error });
    return { ...pushed, status: await github.status(config.workspaceDir) };
  });

  // ----- Experiment tracker (Runs tab) -----
  ipcMain.handle('experiments:list', () => experiments.list(config.workspaceDir));
  ipcMain.handle('experiments:remove', (_e, { id }) => {
    experiments.remove(config.workspaceDir, id);
    return experiments.list(config.workspaceDir);
  });
  ipcMain.handle('experiments:clear', () => { experiments.clear(config.workspaceDir); return []; });
  ipcMain.handle('experiments:exportCsv', () => {
    const dest = path.join(config.workspaceDir, 'experiments.csv');
    fs.writeFileSync(dest, experiments.toCsv(config.workspaceDir), 'utf8');
    return { path: dest };
  });

  // ----- Dependency doctor (Env tab) -----
  ipcMain.handle('doctor:scan', () => doctor.diagnose(config.workspaceDir, config.pythonPath));
  ipcMain.handle('doctor:writeRequirements', (_e, { deps }) => {
    // Only well-formed package entries make it into the file (the deps came from our own
    // scan, but the write path stays defensive anyway).
    const safe = (Array.isArray(deps) ? deps : []).filter((d) =>
      d && typeof d.pip === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d.pip) &&
      (d.version == null || /^[A-Za-z0-9.+!_-]+$/.test(String(d.version))));
    const text = doctor.requirementsText(safe);
    const dest = path.join(config.workspaceDir, 'requirements.txt');
    fs.writeFileSync(dest, text, 'utf8');
    return { path: dest, text, count: safe.length };
  });

  // ----- Dataset insights (Data tab) -----
  ipcMain.handle('datasets:insights', async (_e, { id }) => {
    const entry = datasets.get(config.workspaceDir, id);
    if (!entry) return { ok: false, error: 'Dataset not found.' };
    if (entry.exists === false) return { ok: false, error: 'The data file is missing.' };
    const key = config.workspaceDir + '|' + id;
    const cached = insightsCache.get(key);
    if (cached) return cached;
    const absPath = path.join(config.workspaceDir, entry.file);
    const res = await insights.compute(config.pythonPath, absPath, entry.kind);
    if (res && res.ok) insightsCache.set(key, res);
    return res;
  });

  // ----- Project snapshots (History tab) -----
  ipcMain.handle('snapshots:list', () => snapshots.list(config.workspaceDir));
  ipcMain.handle('snapshots:create', (_e, { label }) => {
    const meta = snapshots.create(config.workspaceDir, label || 'manual snapshot');
    const all = snapshots.list(config.workspaceDir);
    send('snapshots:update', all);
    return { meta, snapshots: all };
  });
  ipcMain.handle('snapshots:restore', (_e, { id }) => {
    const res = snapshots.restore(config.workspaceDir, id);
    const all = snapshots.list(config.workspaceDir);
    send('snapshots:update', all);
    return { ...res, snapshots: all, tree: projects.tree(config.workspaceDir) };
  });
  ipcMain.handle('snapshots:remove', (_e, { id }) => {
    snapshots.remove(config.workspaceDir, id);
    const all = snapshots.list(config.workspaceDir);
    send('snapshots:update', all);
    return all;
  });

  // ----- Custom window controls (frameless on Windows/Linux) -----
  ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); return true; });
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); return true; });
  ipcMain.handle('window:isMaximized', () => !!(mainWindow && mainWindow.isMaximized()));
  ipcMain.handle('window:platform', () => process.platform);

  ipcMain.handle('shell:openPath', (_e, { path: p }) => shell.openPath(p));
  ipcMain.handle('shell:showWorkspace', () => shell.openPath(config.workspaceDir));
  // Open an external URL (https only) in the user's default browser — used for the
  // "create a DeepSeek API key" link.
  ipcMain.handle('shell:openExternal', (_e, { url }) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) return shell.openExternal(url);
    return false;
  });

  // Clipboard bridge for the editor's custom right-click menu (Cut/Copy/Paste).
  // Going through the main process keeps these reliable under contextIsolation,
  // where the renderer can't reach Electron's clipboard module directly.
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_e, { text }) => { clipboard.writeText(typeof text === 'string' ? text : ''); return true; });
}

app.whenReady().then(() => {
  // Ensure the projects root exists and resolve the active project directory
  // (non-destructive: never moves an existing workspace). Persist if it changed.
  const active = projects.ensureSetup(config);
  if (active !== config.workspaceDir) config = configMod.save({ workspaceDir: active });
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  memory = new ContextMemory(config.workspaceDir);
  registerIpc();
  createWindow();
  setupLlama();
  detectEnv(); // probe library support in the background; pushed via env:update
  sysmon.start((s) => send('sysmon:update', s)); // live CPU/RAM/GPU strip in the dock

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (llama) llama.stop();
  sysmon.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { if (llama) llama.stop(); sysmon.stop(); });
