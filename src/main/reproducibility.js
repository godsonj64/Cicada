'use strict';

// Reproducibility manifests for every execution: code snapshot, interpreter and
// package state, random seeds, datasets, run configuration, and host hardware.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const projects = require('./projects');

function root(workspaceDir) { return path.join(workspaceDir, '.garm', 'reproducibility'); }
function newId() { return new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6); }

function hashFile(file) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function packages(pythonPath) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try { proc = spawn(pythonPath, ['-m', 'pip', 'freeze', '--disable-pip-version-check'], { windowsHide: true }); }
    catch (_) { resolve([]); return; }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} resolve([]); }, 30000);
    proc.stdout.on('data', (d) => { if (out.length < 2 * 1024 * 1024) out += d.toString(); });
    proc.on('error', () => { clearTimeout(timer); resolve([]); });
    proc.on('exit', () => { clearTimeout(timer); resolve(out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 5000)); });
  });
}

function detectSeeds(workspaceDir) {
  const seeds = [];
  const patterns = [
    { library: 'python', re: /random\.seed\s*\(\s*([^\)]+)\)/g },
    { library: 'numpy', re: /(?:np|numpy)\.random\.seed\s*\(\s*([^\)]+)\)/g },
    { library: 'torch', re: /torch\.manual_seed\s*\(\s*([^\)]+)\)/g },
    { library: 'tensorflow', re: /(?:tf|tensorflow)\.random\.set_seed\s*\(\s*([^\)]+)\)/g },
    { library: 'sklearn', re: /random_state\s*=\s*([A-Za-z0-9_.+-]+)/g },
  ];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === 'dir') { walk(node.children); continue; }
      if (!/\.py$/i.test(node.path)) continue;
      let text = '';
      try { text = projects.readFile(workspaceDir, node.path); } catch (_) { continue; }
      for (const p of patterns) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(text))) seeds.push({ library: p.library, value: m[1].trim().slice(0, 80), file: node.path, line: text.slice(0, m.index).split('\n').length });
      }
    }
  };
  walk(projects.tree(workspaceDir));
  return seeds.slice(0, 100);
}

async function capture({ workspaceDir, file, config, env, datasets, run }) {
  const id = newId();
  const dir = path.join(root(workspaceDir), id);
  const sourceDir = path.join(dir, 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
  const rel = String(file || 'main.py').replace(/\\/g, '/');
  const abs = projects.resolveInProject(workspaceDir, rel);
  let sourceHash = null;
  try {
    sourceHash = await hashFile(abs);
    const copy = path.join(sourceDir, rel);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(abs, copy);
  } catch (_) { /* manifest still useful without source copy */ }
  const datasetEntries = [];
  for (const d of datasets || []) {
    let dataHash = null;
    try {
      const dataAbs = projects.resolveInProject(workspaceDir, d.file || '');
      if (fs.existsSync(dataAbs)) dataHash = await hashFile(dataAbs);
    } catch (_) { /* ignore invalid or missing dataset paths */ }
    datasetEntries.push({ id: d.id, name: d.name, file: d.file, kind: d.kind, bytes: d.bytes, schema: d.schema || null, sha256: dataHash });
  }
  const manifest = {
    schemaVersion: 1, id, createdAt: new Date().toISOString(),
    run: { file: rel, source: run.source, startedAt: run.startedAt, durationMs: run.durationMs, exitCode: run.exitCode, metrics: run.metrics || {} },
    code: { sourcePath: 'source/' + rel, sha256: sourceHash },
    python: { executable: config.pythonPath, version: env && env.python, packages: await packages(config.pythonPath) },
    seeds: detectSeeds(workspaceDir),
    datasets: datasetEntries,
    configuration: { provider: config.provider, model: config.provider === 'local' ? path.basename(config.modelPath || '') : config.deepseekModel, contextSize: config.contextSize, outputMode: config.agentOutputMode, maxFixIterations: config.maxFixIterations },
    hardware: { platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0] ? os.cpus()[0].model : 'unknown', cpuCores: os.cpus().length, memoryBytes: os.totalmem(), hostnameHash: crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12) },
  };
  const temp = path.join(dir, 'manifest.json.tmp');
  const target = path.join(dir, 'manifest.json');
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(temp, target);
  return manifest;
}

function list(workspaceDir) {
  const dir = root(workspaceDir);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, entry.name, 'manifest.json'), 'utf8')); } catch (_) { return null; }
  }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function get(workspaceDir, id) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(root(workspaceDir), id, 'manifest.json'), 'utf8')); } catch (_) { return null; }
}

module.exports = { capture, list, get, detectSeeds, hashFile };
