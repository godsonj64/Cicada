'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve the user's home directory in a portable way.
const HOME = os.homedir();

// Default GGUF model the app ships with. Qwen2.5-Coder 3B (instruct, Q4_K_M, ~2 GB) is
// the strongest small local coding model — fast and low-VRAM while still capable — so it
// loads quickly on modest machines. The app looks for it in the user's Downloads folder.
// The user can change this in Settings.
const DEFAULT_MODEL = path.join(HOME, 'Downloads', 'qwen2.5-coder-3b-instruct-q4_k_m.gguf');

const DEFAULTS = {
  // Inference backend: 'local' (llama-server + a GGUF on this machine) or 'deepseek'
  // (DeepSeek's hosted OpenAI-compatible API). When 'deepseek', the local llama-server
  // is not started and requests go to https://api.deepseek.com.
  provider: 'local',
  // DeepSeek API key (https://platform.deepseek.com/api_keys) and model. Both DeepSeek
  // models support thinking; 'deepseek-v4-flash' is faster/cheaper, '-pro' is stronger.
  deepseekApiKey: '',
  deepseekModel: 'deepseek-v4-flash',
  // Path to the .gguf model file.
  modelPath: DEFAULT_MODEL,
  // Explicit path to the llama-server binary. Empty by default; set automatically when
  // Cicada auto-downloads llama.cpp on first run (see src/main/llama-installer.js), or
  // point it at an existing build. Takes priority over PATH / well-known locations.
  llamaServerPath: '',
  // Which llama.cpp compute backend the auto-installer fetched: 'cuda' (NVIDIA GPU),
  // 'metal' (Apple Silicon), or 'cpu'. Empty until first setup. On launch Cicada detects
  // the machine's best backend and, if it differs from this, downloads the matching build
  // so a CPU-only install upgrades to GPU automatically once a GPU is present.
  llamaBackend: '',
  // Local port llama-server binds to.
  serverPort: 8127,
  // Context window passed to llama-server (-c).
  contextSize: 8192,
  // GPU layers to offload (-ngl). 99 == all layers (full Metal offload on Apple Silicon).
  gpuLayers: 99,
  // How the agent emits a NEW program (the create pipeline):
  //   'single' — one self-contained main.py (the classic behaviour), or
  //   'repo'   — a proper multi-file project (packages/modules with accurate imports,
  //              a runnable main.py entry point, optional requirements.txt).
  // Refine/inpaint follow the same mode; inpaint is always single-file (it edits a
  // selection). Defaults to 'single' so existing projects are unaffected.
  agentOutputMode: 'single',
  // Sampling defaults for the agentic pipeline.
  temperature: 0.3,
  topP: 0.9,
  // Ceiling on completion tokens per stage. Code-generation stages size their budget
  // dynamically from the remaining context window (see Pipeline._codeBudget); this is the
  // upper bound. A reasoning model must fit BOTH its <think> block and the whole program
  // in the budget, so this defaults to the full context — a small fixed cap (the old
  // 2048) truncated generation mid-thought before any code was emitted.
  maxTokens: 8192,
  // How many compile/fix iterations the pipeline attempts before giving up.
  maxFixIterations: 3,
  // Idle cap (ms) on a single pipeline verification run. A generated program is killed only after
  // this long with NO output AND no CPU activity — the signature of a real hang (deadlock or a
  // blocking input()). A program that keeps printing, OR that stays quiet but pins the CPU (model
  // training, a large simulation between log lines), is left to run to completion like a standard
  // IDE. The editor's own Run button is interactive and stays uncapped (the user can Stop it).
  runTimeoutMs: 600000, // 10 minutes
  // Absolute path to the workspace where generated code and outputs live. This is the
  // ACTIVE project directory; switching projects repoints it (see src/main/projects.js).
  workspaceDir: path.join(HOME, 'GARM Code', 'workspace'),
  // Root under which new projects are created (each project is a subdirectory).
  projectsRoot: path.join(HOME, 'GARM Code', 'projects'),
  // Python interpreter used for compile + run. Windows installs expose `python`
  // (python3 is usually only a Microsoft Store alias stub there).
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  // GitHub integration: a personal access token (classic or fine-grained with `repo`
  // scope) used to create repositories and push. Stored locally in config.json only.
  githubToken: '',
  // First-run signup. `profile` is { name, email, createdAt } once submitted; it is
  // stored locally and delivered ONCE to the developer's private telemetry repo when
  // telemetry is enabled (see src/main/telemetry.js). `signupDone` is also set by
  // "continue without signing up" so the form never nags. `signupSyncedAt` records
  // successful delivery (empty = still queued; retried on later launches).
  profile: null,
  signupDone: false,
  signupSyncedAt: '',
  // Optional token override for signup delivery (normally embedded at release time).
  telemetryToken: '',
  // App-launch counter + one-time "enjoying Cicada? star it" prompt bookkeeping.
  launchCount: 0,
  starPromptDone: false,
};

function configPath() {
  // Stored next to the app data, but we keep it simple: in the workspace's parent.
  return path.join(HOME, 'GARM Code', 'config.json');
}

function load() {
  const file = configPath();
  let user = {};
  try {
    if (fs.existsSync(file)) {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.error('[config] failed to read config.json, using defaults:', err.message);
  }
  return { ...DEFAULTS, ...user };
}

function save(partial) {
  const merged = { ...load(), ...partial };
  try {
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] failed to write config.json:', err.message);
  }
  return merged;
}

module.exports = { load, save, DEFAULTS, configPath };
