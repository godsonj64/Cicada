'use strict';

const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// Common locations for the llama.cpp server binary (Homebrew on Apple Silicon / Intel,
// plus a couple of conventional build output paths).
const CANDIDATE_PATHS = [
  '/opt/homebrew/bin/llama-server',
  '/usr/local/bin/llama-server',
  path.join(require('os').homedir(), '.local', 'bin', 'llama-server'),
];

function resolveBinary() {
  if (process.env.GARM_LLAMA_SERVER && fs.existsSync(process.env.GARM_LLAMA_SERVER)) {
    return process.env.GARM_LLAMA_SERVER;
  }
  // Try PATH via `which`.
  try {
    const r = spawnSync('which', ['llama-server'], { encoding: 'utf8' });
    const found = (r.stdout || '').trim();
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
    this.binary = resolveBinary();
    this.lastError = null;
    this.logBuffer = [];
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
    this.binary = resolveBinary();
    if (!this.binary) {
      this.lastError = 'llama-server binary not found. Install llama.cpp (e.g. `brew install llama.cpp`).';
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
      '-ngl', String(this.config.gpuLayers),
      '--no-webui',
      // Keep <think> reasoning INLINE in message.content (don't split it into a separate
      // reasoning_content field). GARM parses <think>…</think> itself for the live
      // reasoning panel and code extraction; without this, reasoning models (e.g. the
      // Qwopus coder) leave content empty during thinking and the panel stays blank.
      '--reasoning-format', 'none',
      // Sampling defaults the renderer does NOT send per-request (it only sets
      // temperature + top_p). The active model is Qwen3.5-based, which degrades and
      // hallucinates at low temperature / unconstrained sampling — these match Qwen3's
      // recommended thinking-mode recipe (temp≈0.6, top_p 0.95, top_k 20, min_p 0).
      '--top-k', '20',
      '--min-p', '0',
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
        this.lastError = `Server exited unexpectedly (code=${code})`;
        this._setStatus('error', this.lastError);
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
