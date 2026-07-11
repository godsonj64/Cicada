'use strict';

// Experiment tracking for ML / research workflows.
//
// Every program run (editor Run button or pipeline verification) is recorded as an
// "experiment": when it ran, how long it took, its exit code, and — the useful part —
// any metrics it printed (loss, accuracy, f1, rmse, …), parsed automatically from
// stdout. No decorators, no imports, no server: if the program prints `val_acc: 0.93`
// or a JSON line like {"epoch": 5, "loss": 0.12}, it is captured. Runs are serialised
// to <workspace>/.garm/experiments.json (parallel to memory.json / datasets.json) so
// history survives restarts and travels with the project.
//
// Parsing is deliberately conservative: only numeric values attached to known
// metric-ish names are kept, the scanned output is capped, and every entry point is
// exception-safe — a tracker bug must never break a run.

const fs = require('fs');
const path = require('path');

const MAX_RUNS = 200;            // rolling history cap per project
const MAX_SCAN_CHARS = 64 * 1024; // only the LAST 64 KB of output is scanned
const MAX_METRICS = 24;          // metrics kept per run

// Names that count as metrics when they appear as `name: value` / `name = value`.
// Matched case-insensitively, with common prefixes (train_/val_/test_/best_) allowed.
const METRIC_NAMES = [
  'loss', 'acc', 'accuracy', 'f1', 'f1_score', 'auc', 'roc_auc', 'precision', 'recall',
  'rmse', 'mse', 'mae', 'mape', 'r2', 'r2_score', 'perplexity', 'ppl', 'bleu', 'rouge',
  'iou', 'dice', 'error', 'err', 'score', 'reward', 'return', 'lr', 'learning_rate',
  'epoch', 'step', 'iteration',
];
const METRIC_RE = new RegExp(
  // word boundary, optional split prefix, one of the known names, optional [k] index
  '(?:^|[^A-Za-z0-9_])((?:train|val|valid|validation|test|best|avg|mean|final)?[_ ]?(?:' +
  METRIC_NAMES.join('|') +
  '))\\s*[:=]\\s*([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)(?![\\d.])',
  'gi'
);

// Normalise a captured metric key: trim, lower-case, spaces -> underscores.
function normKey(k) {
  return String(k || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Extract metrics from program output. Returns { metrics, epochs } where `metrics` maps
 * key -> LAST printed numeric value (training logs print a metric per epoch; the last
 * one is the final state) and `epochs` is the highest epoch/step seen (null if none).
 * Only the last MAX_SCAN_CHARS are scanned so a huge log can't stall the tracker.
 */
function parseMetrics(text) {
  const out = { metrics: {}, epochs: null };
  let s = String(text == null ? '' : text);
  if (!s) return out;
  if (s.length > MAX_SCAN_CHARS) s = s.slice(-MAX_SCAN_CHARS);

  // JSON lines first ({"loss": 0.1, "epoch": 3} — common in training loops). Each parsed
  // object contributes its numeric fields whose names look metric-ish.
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('{') && t.endsWith('}') && t.length < 2000) {
      try {
        const obj = JSON.parse(t);
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v !== 'number' || !isFinite(v)) continue;
          const key = normKey(k);
          if (!key || key.length > 40) continue;
          if (METRIC_NAMES.some((m) => key === m || key.endsWith('_' + m) || key.startsWith(m + '_'))) {
            out.metrics[key] = v;
          }
        }
      } catch (_) { /* not JSON — fine */ }
    }
  }

  // Plain-text `name: value` pairs. Later matches overwrite earlier ones (last wins).
  let m;
  METRIC_RE.lastIndex = 0;
  while ((m = METRIC_RE.exec(s)) !== null) {
    const key = normKey(m[1]);
    const val = parseFloat(m[2]);
    if (!key || !isFinite(val)) continue;
    out.metrics[key] = val;
  }

  // epoch/step are progress counters, not quality metrics — lift the max out.
  for (const k of ['epoch', 'step', 'iteration']) {
    if (k in out.metrics) {
      out.epochs = Math.max(out.epochs == null ? -Infinity : out.epochs, out.metrics[k]);
      delete out.metrics[k];
    }
  }
  if (out.epochs === -Infinity) out.epochs = null;

  // Cap the metric count (keep insertion order = reading order of the log).
  const keys = Object.keys(out.metrics);
  if (keys.length > MAX_METRICS) {
    for (const k of keys.slice(MAX_METRICS)) delete out.metrics[k];
  }
  return out;
}

// ---- store ------------------------------------------------------------------

function storePath(workspaceDir) {
  return path.join(workspaceDir, '.garm', 'experiments.json');
}

function readStore(workspaceDir) {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(workspaceDir), 'utf8'));
    if (data && Array.isArray(data.runs)) return data;
  } catch (_) { /* missing or corrupt — start fresh */ }
  return { version: 1, runs: [] };
}

function writeStore(workspaceDir, data) {
  const p = storePath(workspaceDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * Record a finished run. `info`: { file, source, startedAt, durationMs, exitCode,
 * output, images }. Metrics are parsed from `output` here. Returns the new entry,
 * or null when there is nothing worth recording (no metrics AND instant success —
 * e.g. a hello-world; we still record failures and anything that printed metrics).
 */
function record(workspaceDir, info) {
  const parsed = parseMetrics(info.output);
  const entry = {
    id: newId(),
    file: String(info.file || 'main.py'),
    source: info.source === 'pipeline' ? 'pipeline' : 'run',
    startedAt: info.startedAt || new Date().toISOString(),
    durationMs: Math.max(0, Math.round(info.durationMs || 0)),
    exitCode: info.exitCode == null ? null : info.exitCode,
    epochs: parsed.epochs,
    metrics: parsed.metrics,
    images: Math.max(0, info.images || 0),
  };
  const store = readStore(workspaceDir);
  store.runs.push(entry);
  if (store.runs.length > MAX_RUNS) store.runs = store.runs.slice(-MAX_RUNS);
  writeStore(workspaceDir, store);
  return entry;
}

// Newest-first list for the UI.
function list(workspaceDir) {
  return readStore(workspaceDir).runs.slice().reverse();
}

function remove(workspaceDir, id) {
  const store = readStore(workspaceDir);
  const before = store.runs.length;
  store.runs = store.runs.filter((r) => r.id !== id);
  if (store.runs.length !== before) writeStore(workspaceDir, store);
  return store.runs.length !== before;
}

function clear(workspaceDir) {
  writeStore(workspaceDir, { version: 1, runs: [] });
  return true;
}

/**
 * Export history as CSV (one row per run, one column per metric seen anywhere).
 * Returns the CSV string; the caller decides where to write it.
 */
function toCsv(workspaceDir) {
  const runs = readStore(workspaceDir).runs;
  const metricKeys = [];
  const seen = new Set();
  for (const r of runs) for (const k of Object.keys(r.metrics || {})) if (!seen.has(k)) { seen.add(k); metricKeys.push(k); }
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['startedAt', 'file', 'source', 'durationMs', 'exitCode', 'epochs', ...metricKeys];
  const lines = [header.map(esc).join(',')];
  for (const r of runs) {
    lines.push([
      r.startedAt, r.file, r.source, r.durationMs, r.exitCode, r.epochs == null ? '' : r.epochs,
      ...metricKeys.map((k) => (r.metrics && k in r.metrics ? r.metrics[k] : '')),
    ].map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = { parseMetrics, record, list, remove, clear, toCsv, MAX_RUNS };
