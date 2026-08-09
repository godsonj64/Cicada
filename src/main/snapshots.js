'use strict';

// Project snapshots: lightweight, git-free checkpoints of the project's source.
//
// Before every agent pipeline operation (create / refine / inpaint) Cicada snapshots
// the project's text files into <workspace>/.garm/snapshots/<id>/, so an aggressive
// rewrite is always one click away from being undone. Users can also snapshot
// manually ("I'm about to try something") and restore any point in the list.
//
// Restores are NON-DESTRUCTIVE merges: files from the snapshot are written back over
// the workspace, but files created after the snapshot are left alone — and a safety
// snapshot of the current state is taken automatically first, so a restore can itself
// be undone. All paths are validated to stay inside the workspace. Only text files
// under the size cap are captured (code, configs, requirements — not datasets,
// venvs, or caches), so snapshots stay small and fast.

const fs = require('fs');
const path = require('path');
const projects = require('./projects');

const MAX_SNAPSHOTS = 30;            // rolling cap (oldest pruned)
const MAX_FILE_BYTES = 256 * 1024;   // per-file cap: source files, not data dumps
const MAX_TOTAL_BYTES = 24 * 1024 * 1024; // whole-snapshot cap
const MAX_FILES = 500;

// Directories never captured (derived / vendored / data — not restorable "source").
const SKIP_DIRS = new Set(['__pycache__', '.git', '.garm', 'node_modules', '.venv', 'venv', 'env', 'data', 'dist', 'build', 'out', '.idea', '.vscode']);

function snapshotsRoot(workspaceDir) {
  return path.join(workspaceDir, '.garm', 'snapshots');
}

function newId() {
  // Sortable id: timestamp first so directory order ≈ chronological order.
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

// Collect capturable files: relative paths of text files within the caps.
function collectFiles(workspaceDir) {
  const out = [];
  let total = 0;
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) return;
      if (e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, r); continue; }
      let st; try { st = fs.statSync(abs); } catch (_) { continue; }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      let buf; try { buf = fs.readFileSync(abs); } catch (_) { continue; }
      if (buf.includes(0)) continue; // binary
      out.push({ rel: r, buf });
      total += buf.length;
    }
  };
  walk(workspaceDir, '');
  return { files: out, bytes: total };
}

/**
 * Create a snapshot. Returns its meta { id, label, createdAt, fileCount, bytes, auto },
 * or null when the workspace has nothing capturable. Never throws.
 */
function create(workspaceDir, label, opts) {
  try {
    const { files, bytes } = collectFiles(workspaceDir);
    if (!files.length) return null;
    const id = newId();
    const dir = path.join(snapshotsRoot(workspaceDir), id);
    const filesDir = path.join(dir, 'files');
    for (const f of files) {
      const dest = path.join(filesDir, f.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.buf);
    }
    const meta = {
      id,
      label: String(label || 'snapshot').slice(0, 120),
      createdAt: new Date().toISOString(),
      fileCount: files.length,
      bytes,
      auto: !!(opts && opts.auto),
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    prune(workspaceDir);
    return meta;
  } catch (err) {
    console.error('[snapshots] create failed:', err.message);
    return null;
  }
}

// Newest-first list of snapshot metas.
function list(workspaceDir) {
  const root = snapshotsRoot(workspaceDir);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  const metas = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, e.name, 'meta.json'), 'utf8'));
      if (meta && meta.id) metas.push(meta);
    } catch (_) { /* skip malformed */ }
  }
  return metas.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Drop the oldest snapshots beyond the cap (auto ones go first at equal age pressure).
function prune(workspaceDir) {
  const metas = list(workspaceDir); // newest first
  const excess = metas.slice(MAX_SNAPSHOTS);
  for (const m of excess) remove(workspaceDir, m.id);
}

function remove(workspaceDir, id) {
  if (!/^[a-z0-9-]+$/i.test(String(id || ''))) return false; // ids are our own alphabet
  const dir = path.join(snapshotsRoot(workspaceDir), String(id));
  if (!projects.isInside(snapshotsRoot(workspaceDir), dir) || !fs.existsSync(dir)) return false;
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
  catch (err) { console.error('[snapshots] remove failed:', err.message); return false; }
}

/**
 * Restore a snapshot into the workspace (merge: snapshot files win, newer files stay).
 * A safety snapshot of the CURRENT state is created first. Every destination path is
 * validated to remain inside the workspace. Returns { ok, restored, safetyId, error? }.
 */
function restore(workspaceDir, id) {
  const root = snapshotsRoot(workspaceDir);
  const filesDir = path.join(root, String(id), 'files');
  if (!/^[a-z0-9-]+$/i.test(String(id || '')) || !projects.isInside(root, filesDir) || !fs.existsSync(filesDir)) {
    return { ok: false, restored: 0, safetyId: null, error: 'Snapshot not found.' };
  }
  const safety = create(workspaceDir, 'before restore', { auto: true });
  let restored = 0;
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(abs, r); continue; }
      const dest = path.join(workspaceDir, r);
      if (!projects.isInside(workspaceDir, dest)) continue; // traversal guard
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(abs, dest);
        restored += 1;
      } catch (err) {
        console.error('[snapshots] restore skipped ' + r + ':', err.message);
      }
    }
  };
  try { walk(filesDir, ''); } catch (err) {
    return { ok: false, restored, safetyId: safety ? safety.id : null, error: err.message };
  }
  return { ok: true, restored, safetyId: safety ? safety.id : null };
}

module.exports = { create, list, remove, restore, prune, collectFiles, MAX_SNAPSHOTS };
