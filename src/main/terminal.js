'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A pragmatic integrated terminal: each submitted command runs in the user's
// login shell, and we persist the working directory across commands via a
// sentinel marker so `cd` behaves as expected. This avoids a native PTY
// dependency while remaining fully capable for the IDE's needs (python, pip,
// git, build commands). Input can be streamed to a running process's stdin.
class Terminal extends EventEmitter {
  constructor(cwd) {
    super();
    this.cwd = cwd || os.homedir();
    this.isWindows = process.platform === 'win32';
    this.shell = this.isWindows ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
    this.proc = null;
    this.pythonPath = null; // when set, the terminal "activates" this interpreter
  }

  get busy() { return this.proc !== null; }

  // Point the terminal at an interpreter so `python`/`pip` resolve to it (and, when it
  // is a venv, set VIRTUAL_ENV) — keeping the terminal consistent with GARM's runner.
  setPython(pythonPath) { this.pythonPath = pythonPath || null; }

  _env() {
    const env = { ...process.env };
    if (!this.pythonPath) return env;
    const binDir = path.dirname(this.pythonPath);
    env.PATH = `${binDir}${path.delimiter}${env.PATH || ''}`;
    // If the interpreter lives in a venv (pyvenv.cfg one level up), activate it.
    const prefix = path.dirname(binDir);
    try {
      if (fs.existsSync(path.join(prefix, 'pyvenv.cfg'))) {
        env.VIRTUAL_ENV = prefix;
        delete env.PYTHONHOME;
      }
    } catch (_) { /* ignore */ }
    return env;
  }

  exec(command) {
    if (this.proc) {
      // A process is already running: forward as stdin instead.
      this.input(command + '\n');
      return;
    }
    const marker = '__GARM_CWD__';
    // cd into tracked dir, run the command, then emit the resulting cwd so we can
    // track directory changes. The marker line is stripped from displayed output.
    if (this.isWindows) {
      // PowerShell equivalent of the POSIX wrapper below: run in the tracked cwd,
      // then print the resulting location behind the marker so `cd` persists.
      const psCwd = String(this.cwd).replace(/'/g, "''");
      const wrapped =
        `try { Set-Location -LiteralPath '${psCwd}' } catch {}; ${command}\n` +
        `Write-Output ('${marker}' + (Get-Location).Path)`;
      this.proc = spawn(this.shell, ['-NoLogo', '-NoProfile', '-Command', wrapped],
        { cwd: this.cwd, env: this._env(), windowsHide: true });
    } else {
      const wrapped = `cd ${shellQuote(this.cwd)} 2>/dev/null; ${command}\n__rc=$?; printf '\\n${marker}%s\\n' "$(pwd)"; exit $__rc`;
      this.proc = spawn(this.shell, ['-lc', wrapped], { cwd: this.cwd, env: this._env() });
    }

    const handle = (buf) => {
      let text = buf.toString();
      const mIdx = text.indexOf(marker);
      if (mIdx >= 0) {
        const after = text.slice(mIdx + marker.length);
        const newCwd = after.split(/\r?\n/)[0].trim();
        if (newCwd) this.cwd = newCwd;
        text = text.slice(0, mIdx).replace(/\n$/, '');
      }
      if (text) this.emit('data', text);
    };
    this.proc.stdout.on('data', handle);
    this.proc.stderr.on('data', handle);
    this.proc.on('error', (err) => this.emit('data', `\r\n[shell error] ${err.message}\r\n`));
    this.proc.on('exit', (code) => {
      this.proc = null;
      this.emit('exit', code, this.cwd);
    });
  }

  input(data) {
    if (this.proc) { try { this.proc.stdin.write(data); } catch (_) { /* closed */ } }
  }

  interrupt() {
    if (!this.proc) return;
    if (this.isWindows) this._killTree();
    else { try { this.proc.kill('SIGINT'); } catch (_) { /* ignore */ } }
  }

  kill() {
    if (!this.proc) return;
    if (this.isWindows) this._killTree();
    else { try { this.proc.kill('SIGKILL'); } catch (_) { /* ignore */ } }
    this.proc = null;
  }

  // Windows has no signals; taskkill /T takes down the shell and its children.
  _killTree() {
    try { spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true }); }
    catch (_) { try { this.proc.kill(); } catch (_) { /* ignore */ } }
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { Terminal };
