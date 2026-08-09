'use strict';

// Project + file-tree management for the multi-file workspace.
//
// A "project" is just a directory. The ACTIVE project's directory is
// config.workspaceDir — everything else (pipeline main.py, terminal cwd, run cwd,
// per-project memory) keys off that, so switching projects is switching workspaceDir.
//
// Projects live under <projectsRoot> (default: ~/GARM Code/projects). The legacy
// single workspace dir is NOT moved (it may hold a .venv with absolute paths); it is
// simply listed alongside the projects root so it stays selectable.
//
// This module is deliberately pure Node (no electron) so it can be unit-tested; the
// only Electron-specific op (delete-to-Trash) lives in main.js.

const fs = require('fs');
const path = require('path');

const IGNORE = new Set([
  '.garm', '.venv', 'venv', '__pycache__', 'node_modules', '.git',
  '.DS_Store', '.ipynb_checkpoints', '.mypy_cache', '.pytest_cache',
]);

const STARTER = [
  '# New Cicada project.',
  '# Describe a program in the Agent panel and run the pipeline, or write Python here.',
  '',
  'def main():',
  '    print("Hello from Cicada")',
  '',
  '',
  'if __name__ == "__main__":',
  '    main()',
  '',
].join('\n');

function projectsRoot(config) {
  return (config && config.projectsRoot) || path.join(require('os').homedir(), 'GARM Code', 'projects');
}

// True when `child` is `parent` or lives somewhere beneath it (no `..` escape).
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolve a project-relative path to an absolute one, refusing anything that escapes
// the project root (path traversal guard for all file IPC).
function resolveInProject(projectDir, relPath) {
  const clean = String(relPath == null ? '' : relPath).replace(/^[\\/]+/, '');
  if (!clean || clean === '.') throw new Error('A project-relative path is required.');
  const abs = path.resolve(projectDir, clean);
  if (!isInside(projectDir, abs)) throw new Error('Path escapes the project: ' + relPath);
  // A lexical containment check is not sufficient when a path component is a
  // symlink/junction. Resolve the nearest existing ancestor and make sure its real
  // target remains inside the real project root before any read/write/delete occurs.
  const realRoot = fs.realpathSync(projectDir);
  let existing = abs;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  if (!isInside(realRoot, realExisting)) throw new Error('Path resolves outside the project: ' + relPath);
  return abs;
}

function sanitizeProjectName(name) {
  return String(name == null ? '' : name).trim()
    .replace(/[\\/]+/g, '-')            // no path separators
    .replace(/^\.+/, '')                // no leading dots (hidden / traversal)
    .replace(/[^A-Za-z0-9 ._-]/g, '')   // conservative, filesystem-safe charset
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

// Ensure the projects root exists and return the directory of the active project.
// Non-destructive: never moves an existing workspace.
function ensureSetup(config) {
  const root = projectsRoot(config);
  try { fs.mkdirSync(root, { recursive: true }); } catch (_) { /* ignore */ }
  let active = config.workspaceDir;
  if (!active) {
    active = path.join(root, 'main');
  }
  try { fs.mkdirSync(active, { recursive: true }); } catch (_) { /* ignore */ }
  return active;
}

// All selectable projects: subdirectories of the projects root, plus the active
// workspace if it lives outside the root (legacy / custom). Marks the active one.
function list(config) {
  const root = projectsRoot(config);
  const active = config.workspaceDir;
  const seen = new Set();
  const out = [];
  // Legacy / external active workspace first, so it isn't hidden.
  if (active && !isInside(root, active) && isDir(active)) {
    out.push({ name: path.basename(active), path: active, external: true });
    seen.add(path.resolve(active));
  }
  try {
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('.')) continue;
      const p = path.join(root, name);
      if (!isDir(p) || seen.has(path.resolve(p))) continue;
      seen.add(path.resolve(p));
      out.push({ name, path: p, external: false });
    }
  } catch (_) { /* root unreadable — return what we have */ }
  out.sort((a, b) => (a.external === b.external ? a.name.localeCompare(b.name) : (a.external ? -1 : 1)));
  out.forEach((p) => { p.active = !!active && path.resolve(p.path) === path.resolve(active); });
  return out;
}

// Create a new project under the root (seeded with a starter main.py). Returns
// { name, path }. Throws if the name is invalid or already taken.
function create(config, name) {
  const safe = sanitizeProjectName(name);
  if (!safe) throw new Error('Please enter a valid project name.');
  const root = projectsRoot(config);
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, safe);
  if (fs.existsSync(dir)) throw new Error('A project named "' + safe + '" already exists.');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.py'), STARTER, 'utf8');
  return { name: safe, path: dir };
}

// Recursive file/folder tree of a project, directories first, noise filtered, depth-capped.
function tree(dir, maxDepth) {
  const cap = maxDepth == null ? 12 : maxDepth;
  function walk(abs, rel, depth) {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return []; }
    entries.sort((a, b) => {
      const ad = a.isDirectory(), bd = b.isDirectory();
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const out = [];
    for (const d of entries) {
      if (IGNORE.has(d.name)) continue;
      if (d.isSymbolicLink()) continue;
      const childRel = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) {
        out.push({ type: 'dir', name: d.name, path: childRel, children: depth < cap ? walk(path.join(abs, d.name), childRel, depth + 1) : [] });
      } else {
        out.push({ type: 'file', name: d.name, path: childRel });
      }
    }
    return out;
  }
  return walk(dir, '', 0);
}

// Pick a sensible file to open when a project is activated: main.py if present,
// else the first top-level file, else ''.
function defaultFile(dir) {
  if (fs.existsSync(path.join(dir, 'main.py'))) return 'main.py';
  const t = tree(dir, 1);
  const firstFile = t.find((e) => e.type === 'file');
  return firstFile ? firstFile.path : '';
}

function readFile(projectDir, relPath) {
  const abs = resolveInProject(projectDir, relPath);
  return fs.readFileSync(abs, 'utf8');
}

function writeFile(projectDir, relPath, content) {
  const abs = resolveInProject(projectDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content == null ? '' : content, 'utf8');
  return abs;
}

// Create an empty file (and any parent directories). Allows "models/net.py" to make
// the subdirectory in one step. Throws if it already exists.
function createFile(projectDir, relPath) {
  const abs = resolveInProject(projectDir, relPath);
  if (fs.existsSync(abs)) throw new Error('"' + relPath + '" already exists.');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '', 'utf8');
  return abs;
}

function createDir(projectDir, relPath) {
  const abs = resolveInProject(projectDir, relPath);
  if (fs.existsSync(abs)) throw new Error('"' + relPath + '" already exists.');
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

function rename(projectDir, fromRel, toRel) {
  const from = resolveInProject(projectDir, fromRel);
  const to = resolveInProject(projectDir, toRel);
  if (!fs.existsSync(from)) throw new Error('"' + fromRel + '" does not exist.');
  if (fs.existsSync(to)) throw new Error('"' + toRel + '" already exists.');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return to;
}

const TEXT_EXTS = new Set([
  '.py', '.pyi', '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt', '.csv',
  '.html', '.css', '.scss', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh',
  '.ps1', '.bat', '.sql', '.r', '.java', '.c', '.h', '.cpp', '.hpp', '.rs', '.go',
]);

// Fast, bounded project search for the global Search UI. It deliberately skips
// generated/vendor directories, binary files, and huge files so a query cannot stall
// the renderer on a model checkpoint or dataset.
function search(projectDir, query, options) {
  const needle = String(query || '').trim();
  if (!needle) return [];
  const opts = options || {};
  const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 500));
  const caseSensitive = !!opts.caseSensitive;
  const target = caseSensitive ? needle : needle.toLowerCase();
  const results = [];
  const walk = (dir, rel) => {
    if (results.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (IGNORE.has(entry.name) || entry.name.startsWith('_garm_plot_')) continue;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { walk(abs, childRel); continue; }
      let stat;
      try { stat = fs.statSync(abs); } catch (_) { continue; }
      if (stat.size > 1024 * 1024) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext && !TEXT_EXTS.has(ext)) continue;
      let source;
      try { source = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
      if (source.includes('\0')) continue;
      const lines = source.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < limit; i += 1) {
        const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
        let from = 0;
        while (results.length < limit) {
          const column = hay.indexOf(target, from);
          if (column < 0) break;
          results.push({ path: childRel, line: i + 1, column: column + 1, preview: lines[i].trim().slice(0, 240) });
          from = column + Math.max(1, target.length);
        }
      }
    }
  };
  walk(projectDir, '');
  return results;
}

// Lightweight project inventory used by Mission Control.
function stats(projectDir) {
  const out = { files: 0, lines: 0, bytes: 0, languages: {}, largest: [] };
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (IGNORE.has(entry.name) || entry.name.startsWith('_garm_plot_')) continue;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { walk(abs, childRel); continue; }
      let stat;
      try { stat = fs.statSync(abs); } catch (_) { continue; }
      out.files += 1;
      out.bytes += stat.size;
      const ext = path.extname(entry.name).toLowerCase().slice(1) || 'other';
      out.languages[ext] = (out.languages[ext] || 0) + 1;
      out.largest.push({ path: childRel, bytes: stat.size });
      if (stat.size <= 1024 * 1024 && (!path.extname(entry.name) || TEXT_EXTS.has(path.extname(entry.name).toLowerCase()))) {
        try {
          const buf = fs.readFileSync(abs);
          if (!buf.includes(0)) out.lines += buf.toString('utf8').split(/\r?\n/).length;
        } catch (_) { /* best effort */ }
      }
    }
  };
  walk(projectDir, '');
  out.largest.sort((a, b) => b.bytes - a.bytes);
  out.largest = out.largest.slice(0, 5);
  return out;
}

module.exports = {
  projectsRoot, ensureSetup, list, create, tree, defaultFile,
  readFile, writeFile, createFile, createDir, rename,
  resolveInProject, sanitizeProjectName, isInside, search, stats, STARTER,
};
