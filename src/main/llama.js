'use strict';

const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// Common locations for the llama.cpp server binary (Homebrew on Apple Silicon / Intel,
// conventional build output paths, and typical Windows install/unzip locations).
const HOME = require('os').homedir();
const CANDIDATE_PATHS = process.platform === 'win32'
  ? [
      path.join(HOME, 'llama.cpp', 'llama-server.exe'),
      path.join(HOME, 'llama.cpp', 'build', 'bin', 'Release', 'llama-server.exe'),
      path.join(HOME, 'Downloads', 'llama.cpp', 'llama-server.exe'),
      path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'llama.cpp', 'llama-server.exe'),
      'C:\\llama.cpp\\llama-server.exe',
    ]
  : [
      '/opt/homebrew/bin/llama-server',
      '/usr/local/bin/llama-server',
      path.join(HOME, '.local', 'bin', 'llama-server'),
    ];

function resolveBinary(explicitPath) {
  // An explicit path (e.g. the auto-downloaded copy recorded in config.llamaServerPath)
  // wins over everything else.
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;
  if (process.env.GARM_LLAMA_SERVER && fs.existsSync(process.env.GARM_LLAMA_SERVER)) {
    return process.env.GARM_LLAMA_SERVER;
  }
  // Try PATH via `which` (POSIX) / `where` (Windows).
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(finder, ['llama-server'], { encoding: 'utf8' });
    const found = (r.stdout || '').split(/\r?\n/)[0].trim();
    if (found && fs.existsSync(found)) return found;
  } catch (_) { /* ignore */ }
  for (const p of CANDIDATE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

class LlamaServer extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.proc = null;
    this.status = 'stopped'; // stopped | starting | ready | error
    this.binary = resolveBinary(config.llamaServerPath);
    this.lastError = null;
    this.logBuffer = [];
    // Crash timestamps for the auto-restart guard (see the exit handler in start()).
    this.crashTimes = [];
  }

  baseUrl() {
    return `http://127.0.0.1:${this.config.serverPort}`;
  }

  _setStatus(status, detail) {
    this.status = status;
    this.emit('status', { status, detail: detail || null });
  }

  _log(line) {
    this.logBuffer.push(line);
    if (this.logBuffer.length > 400) this.logBuffer.shift();
    this.emit('log', line);
  }

  async start() {
    if (this.status === 'ready' || this.status === 'starting') return;
    this.binary = resolveBinary(this.config.llamaServerPath);
    if (!this.binary) {
      this.lastError = process.platform === 'win32'
        ? 'llama-server.exe not found. Download a llama.cpp release (github.com/ggerganov/llama.cpp/releases), unzip it, and add it to PATH or set GARM_LLAMA_SERVER.'
        : 'llama-server binary not found. Install llama.cpp (e.g. `brew install llama.cpp`).';
      this._setStatus('error', this.lastError);
      return;
    }
    if (!fs.existsSync(this.config.modelPath)) {
      this.lastError = `Model file not found: ${this.config.modelPath}`;
      this._setStatus('error', this.lastError);
      return;
    }

    this._setStatus('starting', `Loading ${path.basename(this.config.modelPath)}`);
    const args = [
      '-m', this.config.modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.config.serverPort),
      '-c', String(this.config.contextSize),
      // GPU offload. -ngl 99 offloads all layers when a GPU backend (CUDA/Metal) is
      // active; with a CPU-only llama.cpp build the flag is simply ignored. The backend is
      // chosen automatically at install time (see src/main/llama-installer.js).
      '-ngl', String(this.config.gpuLayers),
      '--no-webui',
      // Keep any <think> reasoning INLINE in message.content (don't split it into a separate
      // reasoning_content field). GARM parses <think>…</think> itself for the live reasoning
      // panel and code extraction. Harmless for non-reasoning models (e.g. DeepSeek-Coder,
      // the default), which simply never emit the tag.
      '--reasoning-format', 'none',
    ];
    this._log(`$ ${this.binary} ${args.join(' ')}`);

    this.proc = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const onData = (buf) => {
      const text = buf.toString();
      text.split(/\r?\n/).forEach((l) => { if (l.trim()) this._log(l); });
    };
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);

    this.proc.on('exit', (code, signal) => {
      this._log(`llama-server exited (code=${code}, signal=${signal})`);
      this.proc = null;
      if (this.status !== 'stopped') {
        // Unexpected exit (a crash, an OOM kill, a driver hiccup). Self-heal: restart
        // automatically up to 3 times in a rolling 10-minute window, so a one-off crash
        // never strands the user on a dead status pill. Repeated crashes stop retrying
        // and surface the error (something is genuinely wrong — bad model file, OOM).
        const now = Date.now();
        this.crashTimes = this.crashTimes.filter((t) => now - t < 10 * 60 * 1000);
        this.crashTimes.push(now);
        if (this.crashTimes.length <= 3) {
          this._log(`restarting llama-server automatically (attempt ${this.crashTimes.length}/3)…`);
          this._setStatus('starting', 'Model crashed — restarting it…');
          setTimeout(() => {
            if (this.status === 'stopped' || this.proc) return; // user stopped it meanwhile
            this.status = 'stopped'; // let start() proceed past its re-entry guard
            this.start();
          }, 1200);
        } else {
          this.lastError = `Server exited unexpectedly (code=${code}) and kept crashing after restarts. Check the model file and available memory.`;
          this._setStatus('error', this.lastError);
        }
      }
    });
    this.proc.on('error', (err) => {
      this.lastError = err.message;
      this._setStatus('error', err.message);
    });

    // Poll health until ready or timeout.
    const ready = await this._waitForHealth(120000);
    if (ready) {
      this._setStatus('ready', this.baseUrl());
    } else if (this.status !== 'error') {
      this.lastError = 'Timed out waiting for model to load.';
      this._setStatus('error', this.lastError);
    }
  }

  async _waitForHealth(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.status === 'error' || !this.proc) return false;
      try {
        const res = await fetch(`${this.baseUrl()}/health`, { method: 'GET' });
        if (res.ok) return true;
      } catch (_) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 700));
    }
    return false;
  }

  stop() {
    this._setStatus('stopped');
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try { p.kill('SIGTERM'); } catch (_) { /* ignore */ }
      // Hard kill shortly after if it lingers.
      setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) { /* ignore */ } }, 1500);
    }
  }

  async restart(newConfig) {
    if (newConfig) this.config = newConfig;
    this.stop();
    await new Promise((r) => setTimeout(r, 800));
    await this.start();
  }

  info() {
    return {
      status: this.status,
      binary: this.binary,
      baseUrl: this.baseUrl(),
      modelPath: this.config.modelPath,
      lastError: this.lastError,
    };
  }
}

module.exports = { LlamaServer, resolveBinary };
