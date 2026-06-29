'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve the user's home directory in a portable way.
const HOME = os.homedir();

// Default GGUF model the app was built around. The user can change this in Settings.
const DEFAULT_MODEL = path.join(HOME, 'Downloads', 'mythos-nano-Q4_K_M.gguf');

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
  // Python interpreter used for compile + run.
  pythonPath: 'python3',
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
