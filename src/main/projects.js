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
  const abs = path.resolve(projectDir, clean);
  if (!isInside(projectDir, abs)) throw new Error('Path escapes the project: ' + relPath);
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

module.exports = {
  projectsRoot, ensureSetup, list, create, tree, defaultFile,
  readFile, writeFile, createFile, createDir, rename,
  resolveInProject, sanitizeProjectName, isInside, STARTER,
};
