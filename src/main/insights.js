'use strict';

// Dataset insights: the analysis a data scientist runs by hand before modeling —
// distributions, correlations, and data-quality flags — computed on demand for any
// dataset in the project and rendered in the Data panel.
//
// Two engines, mirroring datasets.js schema detection: the user's own Python with
// pandas (richest — handles CSV/Excel/JSON-records), falling back to a pure-Node
// analyzer for CSV so insights work even on a machine with no Python libraries at
// all. Row counts are capped so a 200 MB file can't stall the app; nothing is
// uploaded anywhere and the uploaded content is never imported or executed.

const fs = require('fs');
const { spawn } = require('child_process');

const TIMEOUT_MS = 120000;
const MAX_ROWS_NODE = 50000;   // Node fallback: rows scanned
const HIST_BINS = 10;
const MAX_NUMERIC_COLS = 30;   // columns profiled / correlated
const TOP_CORR = 8;

// ---- Python engine ----------------------------------------------------------

// Reads path (argv[1]) + kind (argv[2]), prints ONE JSON object. Sampling keeps it
// fast: at most 100k rows are analyzed (uniformly from the head — good enough for
// profiling). String.raw keeps "\t" literal for Python.
const INSIGHT_SCRIPT = String.raw`
import sys, json

def run():
    path = sys.argv[1] if len(sys.argv) > 1 else ""
    kind = (sys.argv[2] if len(sys.argv) > 2 else "").lower()
    MAX_ROWS, BINS, MAXC, TOPC = 100000, 10, 30, 8

    def done(obj):
        sys.stdout.write(json.dumps(obj))
        sys.stdout.flush()
        sys.exit(0)

    try:
        import pandas as pd
        import numpy as np
    except Exception:
        done({"ok": False, "error": "needs-pandas"})

    try:
        if kind == "csv":
            sep = "\t" if path.lower().endswith(".tsv") else ","
            df = pd.read_csv(path, sep=sep, nrows=MAX_ROWS)
        elif kind == "excel":
            df = pd.read_excel(path, nrows=MAX_ROWS)
        elif kind == "json":
            df = pd.read_json(path)
            if len(df) > MAX_ROWS: df = df.head(MAX_ROWS)
        else:
            done({"ok": False, "error": "unsupported kind"})
    except Exception as e:
        done({"ok": False, "error": "Could not load: %s" % e})

    n = int(len(df))
    if n == 0:
        done({"ok": False, "error": "The table is empty."})

    num = df.select_dtypes(include=[np.number])
    numcols = list(num.columns)[:MAXC]

    columns = []
    for c in numcols:
        s = num[c].dropna()
        if not len(s):
            continue
        try:
            counts, edges = np.histogram(s, bins=BINS)
            col = {
                "name": str(c)[:80],
                "mean": float(s.mean()), "std": float(s.std()) if len(s) > 1 else 0.0,
                "min": float(s.min()), "max": float(s.max()),
                "median": float(s.median()),
                "skew": float(s.skew()) if len(s) > 2 else 0.0,
                "missingPct": float(100.0 * (n - len(s)) / n),
                "hist": [int(x) for x in counts],
            }
            columns.append(col)
        except Exception:
            pass

    corr = []
    if len(numcols) >= 2:
        try:
            cm = num[numcols].corr()
            seen = set()
            pairs = []
            for a in numcols:
                for b in numcols:
                    if a >= b or (a, b) in seen: continue
                    seen.add((a, b))
                    v = cm.loc[a, b]
                    if v == v:  # not NaN
                        pairs.append((abs(float(v)), str(a)[:80], str(b)[:80], float(v)))
            pairs.sort(reverse=True)
            corr = [{"a": p[1], "b": p[2], "r": round(p[3], 4)} for p in pairs[:TOPC]]
        except Exception:
            corr = []

    flags = []
    try:
        dup = int(df.duplicated().sum())
        if dup: flags.append("%d duplicate rows" % dup)
    except Exception:
        pass
    for c in list(df.columns)[:200]:
        try:
            s = df[c]
            miss = float(100.0 * s.isna().sum() / n)
            if miss >= 50: flags.append("'%s' is %.0f%% missing" % (str(c)[:60], miss))
            elif s.nunique(dropna=True) <= 1: flags.append("'%s' is constant" % str(c)[:60])
        except Exception:
            pass

    done({"ok": True, "engine": "pandas", "rows": n, "sampled": n >= MAX_ROWS,
          "columns": columns, "correlations": corr, "flags": flags[:12]})

run()
`;

function analyzeWithPython(pythonPath, absPath, kind) {
  return new Promise((resolve) => {
    let out = '', err = '', settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    let proc;
    try {
      proc = spawn(pythonPath, ['-', absPath, kind], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      finish({ ok: false, error: 'Could not launch Python: ' + e.message });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
      finish({ ok: false, error: 'Insights timed out.' });
    }, TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: 'Python error: ' + e.message }); });
    proc.on('exit', () => {
      clearTimeout(timer);
      try { finish(JSON.parse(out.trim())); }
      catch (_) { finish({ ok: false, error: (err || 'Could not analyze the file.').trim().slice(0, 300) }); }
    });
    try { proc.stdin.write(INSIGHT_SCRIPT); proc.stdin.end(); } catch (_) { /* ignore */ }
  });
}

// ---- Node fallback (CSV only) -------------------------------------------------

// Minimal RFC-4180-ish CSV line splitter: handles quoted fields with embedded
// separators and doubled quotes. One line at a time (multi-line quoted cells are a
// pandas job — the fallback trades that corner for zero dependencies).
function splitCsvLine(line, sep) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : num / den;
}

function histogram(values, min, max, bins) {
  const counts = new Array(bins).fill(0);
  const span = max - min;
  for (const v of values) {
    const idx = span === 0 ? 0 : Math.min(bins - 1, Math.floor(((v - min) / span) * bins));
    counts[idx] += 1;
  }
  return counts;
}

/**
 * Pure-Node insights for a CSV file. Same result shape as the Python engine
 * (engine: "node"). Row-capped; numbers detected per column when ≥80% of the
 * non-empty values parse as finite numbers.
 */
function analyzeCsvNode(absPath) {
  let text;
  try { text = fs.readFileSync(absPath, 'utf8'); }
  catch (e) { return { ok: false, error: 'Could not read the file: ' + e.message }; }
  const sep = absPath.toLowerCase().endsWith('.tsv') ? '\t' : ',';
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].length) lines.pop();
  if (lines.length < 2) return { ok: false, error: 'The table is empty.' };

  const header = splitCsvLine(lines[0], sep).map((h) => h.trim().slice(0, 80));
  const nRows = Math.min(lines.length - 1, MAX_ROWS_NODE);
  const cells = [];
  for (let i = 1; i <= nRows; i++) cells.push(splitCsvLine(lines[i], sep));

  // Numeric column detection + per-column numeric value arrays (aligned by row for corr).
  const numericCols = [];
  for (let ci = 0; ci < header.length && numericCols.length < MAX_NUMERIC_COLS; ci++) {
    let present = 0, numeric = 0;
    const vals = new Array(nRows).fill(null);
    for (let ri = 0; ri < nRows; ri++) {
      const raw = (cells[ri][ci] || '').trim();
      if (!raw) continue;
      present += 1;
      const v = Number(raw);
      if (Number.isFinite(v)) { numeric += 1; vals[ri] = v; }
    }
    if (present > 0 && numeric / present >= 0.8 && numeric >= 3) {
      numericCols.push({ ci, name: header[ci] || 'col' + ci, vals, missing: nRows - numeric });
    }
  }

  const columns = numericCols.map((c) => {
    const xs = c.vals.filter((v) => v != null);
    let min = Infinity, max = -Infinity, sum = 0;
    for (const v of xs) { if (v < min) min = v; if (v > max) max = v; sum += v; }
    const mean = sum / xs.length;
    let m2 = 0, m3 = 0;
    for (const v of xs) { const d = v - mean; m2 += d * d; m3 += d * d * d; }
    const variance = xs.length > 1 ? m2 / (xs.length - 1) : 0;
    const std = Math.sqrt(variance);
    const skew = (xs.length > 2 && std > 0) ? (m3 / xs.length) / Math.pow(std, 3) : 0;
    const sorted = xs.slice().sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    return {
      name: c.name, mean, std, min, max, median, skew,
      missingPct: (c.missing / nRows) * 100,
      hist: histogram(xs, min, max, HIST_BINS),
    };
  });

  const correlations = [];
  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i + 1; j < numericCols.length; j++) {
      const xs = [], ys = [];
      for (let r = 0; r < nRows; r++) {
        const a = numericCols[i].vals[r], b = numericCols[j].vals[r];
        if (a != null && b != null) { xs.push(a); ys.push(b); }
      }
      const r = pearson(xs, ys);
      if (r != null) correlations.push({ a: numericCols[i].name, b: numericCols[j].name, r: Math.round(r * 10000) / 10000 });
    }
  }
  correlations.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  const flags = [];
  const seenRows = new Set();
  let dups = 0;
  for (let ri = 0; ri < nRows; ri++) {
    const key = cells[ri].join('');
    if (seenRows.has(key)) dups += 1; else seenRows.add(key);
  }
  if (dups) flags.push(dups + ' duplicate rows');
  for (let ci = 0; ci < header.length && ci < 200; ci++) {
    let present = 0;
    const uniq = new Set();
    for (let ri = 0; ri < nRows; ri++) {
      const raw = (cells[ri][ci] || '').trim();
      if (!raw) continue;
      present += 1;
      if (uniq.size <= 2) uniq.add(raw);
    }
    const missPct = ((nRows - present) / nRows) * 100;
    if (missPct >= 50) flags.push("'" + (header[ci] || 'col' + ci) + "' is " + Math.round(missPct) + '% missing');
    else if (present > 0 && uniq.size <= 1) flags.push("'" + (header[ci] || 'col' + ci) + "' is constant");
  }

  return {
    ok: true, engine: 'node', rows: nRows, sampled: lines.length - 1 > nRows,
    columns, correlations: correlations.slice(0, TOP_CORR), flags: flags.slice(0, 12),
  };
}

/**
 * Compute insights for a dataset file: pandas when available, Node fallback for CSV.
 * Always resolves with { ok, … } — never rejects.
 */
async function compute(pythonPath, absPath, kind) {
  let res = await analyzeWithPython(pythonPath, absPath, kind);
  if (res && res.ok) return res;
  if (kind === 'csv') {
    const node = analyzeCsvNode(absPath);
    if (node.ok) return node;
  }
  if (res && res.error === 'needs-pandas') {
    res = { ok: false, error: 'Insights for this file type need pandas. Install pandas in the Env tab.' };
  }
  return res || { ok: false, error: 'Could not analyze the file.' };
}

module.exports = { compute, analyzeCsvNode, splitCsvLine, pearson, histogram, HIST_BINS };
