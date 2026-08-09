'use strict';

// GitHub integration for the active project.
//
// Everything is built on the user's own `git` CLI plus the GitHub REST API with a
// personal access token the user supplies (stored locally in config.json, sent only
// to api.github.com / github.com). The one-click "publish" flow:
//
//   check git -> init repo (if needed) -> generate required files (.gitignore,
//   README.md, LICENSE, requirements.txt) -> commit -> create the GitHub repo
//   -> push (token via a per-invocation auth header, never written to .git/config)
//
// Pure Node (no electron) so it can be exercised headlessly like the other modules.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { pkgForImport } = require('./python');

const API = 'https://api.github.com';

// ---- git plumbing --------------------------------------------------------------

// Run git with args in `dir`, resolving { ok, code, stdout, stderr }. Never rejects.
function git(dir, args, extraEnv) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('git', args, {
        cwd: dir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(extraEnv || {}) },
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: e.message });
      return;
    }
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => resolve({ ok: false, code: -1, stdout, stderr: e.message }));
    proc.on('exit', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

function gitVersion() {
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status === 0 && r.stdout) return r.stdout.trim().replace(/^git version\s*/i, '');
  } catch (_) { /* not installed */ }
  return null;
}

// Redact any embedded credentials before a URL is shown or stored.
function cleanRemoteUrl(url) {
  return String(url || '').replace(/^(https?:\/\/)[^@/]+@/i, '$1').trim();
}

// https://github.com/user/repo(.git) -> web URL for "Open on GitHub".
function webUrl(remoteUrl) {
  const u = cleanRemoteUrl(remoteUrl).replace(/\.git$/i, '');
  const ssh = u.match(/^git@github\.com:(.+)$/i);
  if (ssh) return 'https://github.com/' + ssh[1];
  return u;
}

function samePath(a, b) {
  const left = path.resolve(String(a || ''));
  const right = path.resolve(String(b || ''));
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Git searches parent directories by default. Cicada must only operate on a repo
// rooted at the active project; otherwise a project under (for example) the user's
// home repo could accidentally stage and publish unrelated files.
async function ownsRepository(dir) {
  const root = await git(dir, ['rev-parse', '--show-toplevel']);
  return root.ok && samePath(root.stdout.trim(), dir);
}

// ---- repository status -----------------------------------------------------------

async function status(dir) {
  const version = gitVersion();
  const out = {
    gitInstalled: !!version,
    gitVersion: version,
    isRepo: false,
    branch: null,
    changes: [],
    changeCount: 0,
    remoteUrl: null,
    webUrl: null,
    lastCommit: null,
    userName: null,
    userEmail: null,
    hasCommits: false,
  };
  if (!version) return out;

  out.isRepo = await ownsRepository(dir);
  if (!out.isRepo) return out;

  const [branch, porcelain, remote, last, name, email] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['status', '--porcelain']),
    git(dir, ['remote', 'get-url', 'origin']),
    git(dir, ['log', '-1', '--pretty=%h%x09%s%x09%cr']),
    git(dir, ['config', 'user.name']),
    git(dir, ['config', 'user.email']),
  ]);
  out.branch = branch.ok ? branch.stdout.trim() : null;
  const lines = porcelain.ok ? porcelain.stdout.split(/\r?\n/).filter(Boolean) : [];
  out.changeCount = lines.length;
  out.changes = lines.slice(0, 200).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3).trim() }));
  out.remoteUrl = remote.ok ? cleanRemoteUrl(remote.stdout) : null;
  out.webUrl = out.remoteUrl ? webUrl(out.remoteUrl) : null;
  if (last.ok && last.stdout.trim()) {
    const [hash, subject, when] = last.stdout.trim().split('\t');
    out.lastCommit = { hash, subject, when };
    out.hasCommits = true;
  }
  out.userName = name.ok ? name.stdout.trim() : null;
  out.userEmail = email.ok ? email.stdout.trim() : null;
  return out;
}

// ---- required-file generation -----------------------------------------------------

// Python standard-library top-level modules (not exhaustive, but covers what generated
// programs import) so the requirements scan lists only real third-party packages.
const PY_STDLIB = new Set(('abc aifc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 '
  + 'calendar cmath cmd code codecs collections colorsys compileall concurrent configparser contextlib copy '
  + 'copyreg cProfile csv ctypes curses dataclasses datetime decimal difflib dis doctest email ensurepip enum '
  + 'errno faulthandler filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob '
  + 'graphlib gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword '
  + 'linecache locale logging lzma mailbox marshal math mimetypes mmap multiprocessing netrc numbers operator '
  + 'os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posixpath pprint profile pstats pty '
  + 'pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched '
  + 'secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat '
  + 'statistics string stringprep struct subprocess symtable sys sysconfig tabnanny tarfile telnetlib tempfile '
  + 'termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty '
  + 'turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound '
  + 'wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo __future__').split(' '));

const SCAN_SKIP = new Set(['.git', '.garm', '.venv', 'venv', 'env', '__pycache__', 'node_modules', 'data', 'dist', 'build']);

// Walk the project's .py files and collect third-party imports mapped to pip package names.
function scanRequirements(dir) {
  const pkgs = new Set();
  const localModules = new Set();
  const pyFiles = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SCAN_SKIP.has(e.name)) continue;
      if (e.isSymbolicLink()) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        // A directory with __init__.py (or any .py) is a local package, not a dependency.
        localModules.add(e.name);
        walk(abs);
      } else if (/\.py$/i.test(e.name) && !e.name.startsWith('_garm_')) {
        localModules.add(e.name.replace(/\.py$/i, ''));
        pyFiles.push(abs);
      }
    }
  };
  walk(dir);
  const IMPORT_RE = /^\s*(?:from\s+([A-Za-z_][\w]*)[\w.]*\s+import|import\s+([A-Za-z_][\w]*))/;
  for (const file of pyFiles) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(IMPORT_RE);
      if (!m) continue;
      const mod = (m[1] || m[2]).split('.')[0];
      if (PY_STDLIB.has(mod) || localModules.has(mod)) continue;
      pkgs.add(pkgForImport(mod));
    }
  }
  return Array.from(pkgs).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

const GITIGNORE = `# Python
__pycache__/
*.py[cod]
*.egg-info/
.eggs/
build/
dist/

# Environments
.venv/
venv/
env/
.env

# Cicada internals (per-project agent memory, dataset index, run artifacts)
.garm/
_garm_harness.py
_garm_plot_*.png

# Tooling caches
.mypy_cache/
.pytest_cache/
.ipynb_checkpoints/

# OS noise
.DS_Store
Thumbs.db
`;

function mitLicense(author) {
  const year = new Date().getFullYear();
  return `MIT License

Copyright (c) ${year} ${author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

// Top-level entries of the project for the README structure section.
function fileOutline(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return ''; }
  const lines = [];
  entries
    .filter((e) => !e.isSymbolicLink() && !e.name.startsWith('.') && !e.name.startsWith('_garm_') && !SCAN_SKIP.has(e.name))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1)))
    .forEach((e) => lines.push(e.isDirectory() ? e.name + '/' : e.name));
  return lines.join('\n');
}

function readmeFor(dir, { projectName, description, requirements }) {
  const outline = fileOutline(dir);
  const parts = [
    `# ${projectName}`,
    '',
    description || 'A Python project built with [Cicada](https://github.com/), the local-first agentic Python IDE.',
    '',
  ];
  if (outline) {
    parts.push('## Project structure', '', '```', outline, '```', '');
  }
  parts.push('## Getting started', '', '```bash');
  if (requirements && requirements.length) parts.push('pip install -r requirements.txt');
  parts.push('python main.py', '```', '');
  if (requirements && requirements.length) {
    parts.push('## Requirements', '', requirements.map((r) => '- `' + r + '`').join('\n'), '');
  }
  parts.push('---', '', '*Generated and maintained with Cicada — plain English → reviewed, executed Python, 100% local.*', '');
  return parts.join('\n');
}

// Generate the standard repo files that are missing. Never overwrites an existing file
// unless force is set. Returns { written, skipped, requirements }.
function generateFiles(dir, opts) {
  const o = opts || {};
  const projectName = o.projectName || path.basename(dir);
  const requirements = scanRequirements(dir);
  const targets = [
    { name: '.gitignore', content: () => GITIGNORE },
    { name: 'README.md', content: () => readmeFor(dir, { projectName, description: o.description, requirements }) },
    { name: 'LICENSE', content: () => mitLicense(o.author || 'The ' + projectName + ' authors') },
  ];
  if (requirements.length) {
    targets.push({ name: 'requirements.txt', content: () => requirements.join('\n') + '\n' });
  }
  const written = [], skipped = [];
  for (const t of targets) {
    const abs = path.join(dir, t.name);
    if (fs.existsSync(abs) && !o.force) { skipped.push(t.name); continue; }
    fs.writeFileSync(abs, t.content(), 'utf8');
    written.push(t.name);
  }
  return { written, skipped, requirements };
}

// ---- commits ---------------------------------------------------------------------

async function ensureRepo(dir) {
  if (await ownsRepository(dir)) return { ok: true, created: false };
  let r = await git(dir, ['init', '-b', 'main']);
  if (!r.ok) {
    // Older git without -b support.
    r = await git(dir, ['init']);
    if (r.ok) await git(dir, ['checkout', '-B', 'main']);
  }
  return { ok: r.ok, created: r.ok, error: r.ok ? null : (r.stderr || r.stdout) };
}

// Make sure commits can be created even when git has no global identity configured
// (common on a fresh machine): set a repo-local identity from the GitHub account.
async function ensureIdentity(dir, fallbackName, fallbackEmail) {
  const name = await git(dir, ['config', 'user.name']);
  if (!name.ok || !name.stdout.trim()) {
    await git(dir, ['config', 'user.name', fallbackName || 'Cicada']);
  }
  const email = await git(dir, ['config', 'user.email']);
  if (!email.ok || !email.stdout.trim()) {
    await git(dir, ['config', 'user.email', fallbackEmail || 'cicada@localhost']);
  }
}

async function commitAll(dir, message, identity) {
  await ensureIdentity(dir, identity && identity.name, identity && identity.email);
  const add = await git(dir, ['add', '-A']);
  if (!add.ok) return { ok: false, error: add.stderr || 'git add failed' };
  const staged = await git(dir, ['diff', '--cached', '--quiet']);
  if (staged.ok) return { ok: true, nothingToCommit: true };
  const commit = await git(dir, ['commit', '-m', message || 'Update from Cicada']);
  if (!commit.ok) return { ok: false, error: commit.stderr || commit.stdout || 'git commit failed' };
  return { ok: true, output: commit.stdout.trim() };
}

// ---- GitHub REST API ----------------------------------------------------------------

async function api(token, method, endpoint, body) {
  const res = await fetch(API + endpoint, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cicada-ide',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, ok: res.ok, data };
}

// Validate a token and identify its user. Returns { ok, login, name, email, avatarUrl } or { ok:false, error }.
async function verifyToken(token) {
  if (!token || !token.trim()) return { ok: false, error: 'No token provided.' };
  try {
    const r = await api(token.trim(), 'GET', '/user');
    if (r.status === 401) return { ok: false, error: 'Token rejected by GitHub (401). Check that it is valid and has the "repo" scope.' };
    if (!r.ok) return { ok: false, error: 'GitHub API error (' + r.status + ').' };
    return { ok: true, login: r.data.login, name: r.data.name || r.data.login, email: r.data.email, avatarUrl: r.data.avatar_url };
  } catch (e) {
    return { ok: false, error: 'Could not reach api.github.com: ' + e.message };
  }
}

// Create a repository under the token's user, or reuse it when it already exists.
// Returns { ok, url, htmlUrl, existed } or { ok:false, error }.
async function createRepo(token, { name, description, isPrivate }) {
  const payload = {
    name,
    description: description || undefined,
    private: !!isPrivate,
    auto_init: false,
  };
  const r = await api(token, 'POST', '/user/repos', payload);
  if (r.ok) return { ok: true, url: r.data.clone_url, htmlUrl: r.data.html_url, existed: false };
  const msg = (r.data && r.data.errors && r.data.errors[0] && r.data.errors[0].message) || (r.data && r.data.message) || '';
  if (r.status === 422 && /already exists/i.test(msg)) {
    const me = await api(token, 'GET', '/user');
    if (me.ok) {
      const repo = await api(token, 'GET', `/repos/${me.data.login}/${name}`);
      if (repo.ok) return { ok: true, url: repo.data.clone_url, htmlUrl: repo.data.html_url, existed: true };
    }
    return { ok: false, error: `A repository named "${name}" already exists but could not be read with this token.` };
  }
  if (r.status === 401) return { ok: false, error: 'Token rejected by GitHub (401).' };
  if (r.status === 403) return { ok: false, error: 'GitHub refused the request (403): ' + msg };
  return { ok: false, error: 'Could not create the repository: ' + (msg || ('HTTP ' + r.status)) };
}

// ---- push -----------------------------------------------------------------------

// Push with the token supplied per-invocation via an Authorization header, so it is
// never written into .git/config or the remote URL.
async function push(dir, { remoteUrl, token, branch }) {
  const clean = cleanRemoteUrl(remoteUrl);
  const existing = await git(dir, ['remote', 'get-url', 'origin']);
  if (existing.ok) await git(dir, ['remote', 'set-url', 'origin', clean]);
  else await git(dir, ['remote', 'add', 'origin', clean]);

  const b = branch || 'main';
  const auth = Buffer.from('x-access-token:' + token).toString('base64');
  const r = await git(dir, [
    '-c', `http.https://github.com/.extraheader=Authorization: Basic ${auth}`,
    'push', '-u', 'origin', b,
  ]);
  if (!r.ok) {
    let err = (r.stderr || r.stdout || 'git push failed').trim();
    if (/authentication failed|401|403/i.test(err)) {
      err += '\nCheck that the token has the "repo" (or fine-grained "Contents: read & write") permission.';
    }
    return { ok: false, error: err };
  }
  return { ok: true, output: (r.stderr || r.stdout).trim() }; // git reports push progress on stderr
}

// ---- one-click publish ------------------------------------------------------------

// The full flow. `onProgress(step, state, detail)` streams UI updates; steps are:
// git, files, commit, repo, push.
async function publish(dir, opts, onProgress) {
  const p = (step, state, detail) => { try { onProgress && onProgress({ step, state, detail: detail || null }); } catch (_) { /* ignore */ } };
  const token = (opts.token || '').trim();

  p('git', 'running');
  if (!gitVersion()) {
    p('git', 'error', 'git is not installed or not on PATH. Install it from https://git-scm.com/downloads and retry.');
    return { ok: false, error: 'git not found' };
  }
  const user = await verifyToken(token);
  if (!user.ok) { p('git', 'error', user.error); return { ok: false, error: user.error }; }
  const repoState = await ensureRepo(dir);
  if (!repoState.ok) { p('git', 'error', repoState.error); return { ok: false, error: repoState.error }; }
  p('git', 'done', repoState.created ? 'Initialized a new git repository (branch main).' : 'Existing git repository.');

  p('files', 'running');
  let gen = { written: [], skipped: [], requirements: [] };
  if (opts.generateFiles !== false) {
    try { gen = generateFiles(dir, { projectName: opts.repoName, description: opts.description, author: user.name || user.login }); }
    catch (e) { p('files', 'error', e.message); return { ok: false, error: e.message }; }
  }
  p('files', 'done', gen.written.length
    ? 'Generated: ' + gen.written.join(', ') + (gen.skipped.length ? ' (kept existing: ' + gen.skipped.join(', ') + ')' : '')
    : 'All required files already present.');

  p('commit', 'running');
  const commit = await commitAll(dir, opts.commitMessage || 'Initial commit — published from Cicada',
    { name: user.name || user.login, email: user.email || (user.login + '@users.noreply.github.com') });
  if (!commit.ok) { p('commit', 'error', commit.error); return { ok: false, error: commit.error }; }
  p('commit', 'done', commit.nothingToCommit ? 'Nothing new to commit.' : 'Changes committed.');

  p('repo', 'running');
  const repo = await createRepo(token, {
    name: opts.repoName,
    description: opts.description,
    isPrivate: opts.isPrivate,
  });
  if (!repo.ok) { p('repo', 'error', repo.error); return { ok: false, error: repo.error }; }
  p('repo', 'done', (repo.existed ? 'Using existing repository ' : 'Created ') + repo.htmlUrl);

  p('push', 'running');
  const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const pushed = await push(dir, { remoteUrl: repo.url, token, branch: branch.ok ? branch.stdout.trim() : 'main' });
  if (!pushed.ok) { p('push', 'error', pushed.error); return { ok: false, error: pushed.error }; }
  p('push', 'done', 'Pushed to ' + repo.htmlUrl);

  return { ok: true, htmlUrl: repo.htmlUrl, existed: repo.existed };
}

// Sanitize a project name into a valid GitHub repository name.
function repoNameFor(projectName) {
  return String(projectName || 'cicada-project')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'cicada-project';
}

module.exports = {
  status, generateFiles, scanRequirements, commitAll, verifyToken, createRepo, push,
  publish, ensureRepo, repoNameFor, gitVersion, webUrl,
};
