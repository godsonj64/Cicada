'use strict';

// Document ingestion: store uploaded data files inside the active project, index their
// metadata, detect their schema/structure, and surface a compact summary the agent can
// reason over and build programs from.
//
// Files live in <workspace>/data/ ; the metadata index is <workspace>/.garm/datasets.json
// (parallel to the context memory). Schema detection runs LOCALLY through the user's own
// Python interpreter (pandas when available, stdlib otherwise) — no network, no uploads —
// with a pure-Node fallback for CSV/JSON when Python can't be reached. Excel needs pandas
// + an engine (openpyxl/xlrd); when those are missing the file is still stored and the
// detection error is recorded so the UI can prompt an install.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const projects = require('./projects');

const DATA_DIRNAME = 'data';
const MANIFEST_REL = '.garm/datasets.json';
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB hard cap
const DETECT_TIMEOUT_MS = 90000;

// extension -> logical kind. CSV, Excel, JSON (the supported family).
const KIND_BY_EXT = {
  '.csv': 'csv', '.tsv': 'csv',
  '.json': 'json',
  '.xlsx': 'excel', '.xlsm': 'excel', '.xls': 'excel',
};

function kindForName(name) {
  return KIND_BY_EXT[path.extname(String(name || '')).toLowerCase()] || null;
}

function supportedExtensions() {
  return Object.keys(KIND_BY_EXT).map((e) => e.slice(1)); // ['csv','tsv','json','xlsx','xlsm','xls']
}

function humanKind(kind) {
  return kind === 'csv' ? 'CSV' : kind === 'excel' ? 'Excel' : kind === 'json' ? 'JSON' : 'File';
}

// ---- manifest -------------------------------------------------------------

function manifestPath(workspaceDir) {
  return path.join(workspaceDir, '.garm', 'datasets.json');
}

function readManifest(workspaceDir) {
  try {
    const raw = fs.readFileSync(manifestPath(workspaceDir), 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.datasets)) return data;
  } catch (_) { /* missing or corrupt — start fresh */ }
  return { version: 1, datasets: [] };
}

function writeManifest(workspaceDir, data) {
  const p = manifestPath(workspaceDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

// All datasets for a project, annotated with whether the backing file still exists.
function list(workspaceDir) {
  const data = readManifest(workspaceDir);
  return data.datasets.map((d) => {
    let exists = false;
    try { exists = fs.existsSync(path.join(workspaceDir, d.file)); } catch (_) { exists = false; }
    return Object.assign({}, d, { exists });
  });
}

function get(workspaceDir, id) {
  return list(workspaceDir).find((d) => d.id === id) || null;
}

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// A filesystem-safe destination name inside data/, de-duplicated against what's there.
function uniqueDestName(dataDir, originalName) {
  const base = path.basename(String(originalName || 'data'));
  let safe = base.replace(/[^A-Za-z0-9._ \-()]/g, '_').replace(/\s+/g, ' ').trim() || 'data';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || 'data';
  let candidate = stem + ext;
  let n = 2;
  while (fs.existsSync(path.join(dataDir, candidate))) {
    candidate = `${stem} (${n})${ext}`;
    n += 1;
  }
  return candidate;
}

// ---- validation -----------------------------------------------------------

// Validate a source file before it is copied into the project. Checks extension, that it
// exists and is a regular file, the size cap, and a light content/magic-byte sniff so a
// mislabelled or corrupt file is rejected up front rather than stored as junk.
function validate(srcPath) {
  const name = path.basename(srcPath || '');
  const kind = kindForName(name);
  if (!kind) {
    return { ok: false, error: `Unsupported file type. Add CSV, Excel (.xlsx/.xls), or JSON.` };
  }
  let st;
  try { st = fs.statSync(srcPath); } catch (_) { return { ok: false, error: 'File not found.' }; }
  if (!st.isFile()) return { ok: false, error: 'Not a regular file.' };
  if (st.size === 0) return { ok: false, error: 'File is empty.' };
  if (st.size > MAX_BYTES) {
    return { ok: false, error: `File is too large (${formatBytes(st.size)}). Limit is ${formatBytes(MAX_BYTES)}.` };
  }
  const sniff = sniffContent(srcPath, kind);
  if (!sniff.ok) return sniff;
  return { ok: true, kind, bytes: st.size, name };
}

// Cheap content sniff: Excel must be a ZIP (xlsx/xlsm) or OLE2 (legacy xls) container;
// CSV/JSON must be text (no NUL bytes in the head). Full structural validation happens
// during schema detection.
function sniffContent(srcPath, kind) {
  let fd;
  try {
    fd = fs.openSync(srcPath, 'r');
    const buf = Buffer.alloc(8);
    const n = fs.readSync(fd, buf, 0, 8, 0);
    const head = buf.slice(0, n);
    if (kind === 'excel') {
      const isZip = head[0] === 0x50 && head[1] === 0x4b; // 'PK' (xlsx/xlsm)
      const isOle = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0; // legacy .xls
      if (!isZip && !isOle) return { ok: false, error: 'This does not look like a valid Excel workbook.' };
    } else {
      if (head.includes(0)) return { ok: false, error: 'This looks like a binary file, not a text CSV/JSON.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not read the file: ${e.message}` };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---- schema detection -----------------------------------------------------

// Python introspector. Reads the file path (argv[1]) + kind (argv[2]) and prints ONE JSON
// object describing the structure. pandas is used when importable (rich dtypes, null
// counts, numeric stats, multi-sheet Excel, nested-JSON normalization); otherwise it falls
// back to the stdlib csv/json modules. It never imports or executes the uploaded content.
// String.raw keeps backslashes (e.g. the "\t" TSV delimiter) literal for Python.
const INTROSPECT = String.raw`
import sys, json, os

def run():
    path = sys.argv[1] if len(sys.argv) > 1 else ""
    kind = (sys.argv[2] if len(sys.argv) > 2 else "").lower()
    MAX_COLS, MAX_ROWS, MAX_VALS, MAX_CELL = 100, 5, 6, 160

    def cell(v):
        try:
            s = v if isinstance(v, str) else ("" if v is None else str(v))
        except Exception:
            s = "<unreadable>"
        return s[:MAX_CELL] + "…" if len(s) > MAX_CELL else s

    def done(obj):
        try:
            sys.stdout.write(json.dumps(obj, default=cell))
        except Exception as e:
            sys.stdout.write(json.dumps({"ok": False, "error": "serialize failed: %s" % e}))
        sys.stdout.flush()
        sys.exit(0)

    if not path or not os.path.exists(path):
        done({"ok": False, "error": "file not found"})

    try:
        import pandas as pd
    except Exception:
        pd = None

    def df_summary(df):
        n = int(len(df)); ncols = int(df.shape[1]); cols = []
        for name in list(df.columns)[:MAX_COLS]:
            s = df[name]
            try: non_null = int(s.notna().sum())
            except Exception: non_null = n
            try: uniq = int(s.nunique(dropna=True))
            except Exception: uniq = None
            vals = []
            try:
                for v in list(pd.Series(s.dropna().unique()))[:MAX_VALS]:
                    vals.append(cell(v))
            except Exception:
                pass
            col = {"name": cell(name), "dtype": str(s.dtype), "nonNull": non_null,
                   "nullCount": int(n - non_null), "unique": uniq, "sample": vals}
            try:
                if pd.api.types.is_numeric_dtype(s) and non_null:
                    d = s.describe(); st = {}
                    for k in ("min", "max", "mean", "std"):
                        if k in d and d[k] == d[k]:
                            st[k] = float(d[k])
                    if st: col["stats"] = st
            except Exception:
                pass
            cols.append(col)
        rows = []
        try:
            for _, r in df.head(MAX_ROWS).iterrows():
                rows.append([cell(x) for x in list(r)[:MAX_COLS]])
        except Exception:
            pass
        return {"rowCount": n, "colCount": ncols, "columns": cols, "sampleRows": rows, "moreCols": ncols > MAX_COLS}

    def do_csv():
        sep = "\t" if path.lower().endswith(".tsv") else ","
        if pd is not None:
            try:
                df = pd.read_csv(path, sep=sep)
                out = df_summary(df); out["format"] = "table"; return out
            except Exception:
                pass
        import csv as _csv
        with open(path, "r", newline="", encoding="utf-8", errors="replace") as fh:
            reader = _csv.reader(fh, delimiter=sep)
            try: header = next(reader)
            except StopIteration: header = []
            rows, extra = [], 0
            for row in reader:
                if len(rows) < 2000: rows.append(row)
                else: extra += 1
        ncols = len(header)
        def infer(vs):
            t, seen = "int", False
            for v in vs:
                if v in ("", None): continue
                seen = True
                try: int(v)
                except Exception:
                    try:
                        float(v)
                        if t == "int": t = "float"
                    except Exception:
                        return "str"
            return t if seen else "empty"
        cols = []
        for ci, name in enumerate(header[:MAX_COLS]):
            cv = [r[ci] if ci < len(r) else "" for r in rows]
            nn = sum(1 for v in cv if v not in ("", None))
            uniq, seen = [], set()
            for v in cv:
                if v not in ("", None) and v not in seen:
                    seen.add(v); uniq.append(cell(v))
                    if len(uniq) >= MAX_VALS: break
            cols.append({"name": cell(name), "dtype": infer(cv), "nonNull": nn,
                         "nullCount": len(cv) - nn, "unique": None, "sample": uniq})
        return {"format": "table", "rowCount": len(rows) + extra, "colCount": ncols, "columns": cols,
                "sampleRows": [[cell(x) for x in r[:MAX_COLS]] for r in rows[:MAX_ROWS]], "sampled": True}

    def do_excel():
        if pd is None:
            return {"ok": False, "error": "Reading Excel needs pandas. Install pandas + openpyxl."}
        try:
            sheets = pd.read_excel(path, sheet_name=None)
        except ImportError as e:
            return {"ok": False, "error": "Missing Excel engine (%s). Install openpyxl for .xlsx or xlrd for .xls." % e}
        except Exception as e:
            return {"ok": False, "error": "Could not read Excel: %s" % e}
        sl = []
        for sname, df in list(sheets.items())[:25]:
            s = df_summary(df); s["name"] = cell(sname); sl.append(s)
        first = sl[0] if sl else {}
        return {"format": "excel", "sheetNames": [cell(k) for k in sheets.keys()], "sheets": sl,
                "rowCount": first.get("rowCount"), "colCount": first.get("colCount"),
                "columns": first.get("columns", []), "sampleRows": first.get("sampleRows", [])}

    def jtype(v):
        if isinstance(v, bool): return "bool"
        if isinstance(v, int): return "int"
        if isinstance(v, float): return "float"
        if isinstance(v, str): return "str"
        if v is None: return "null"
        if isinstance(v, list): return "array"
        if isinstance(v, dict): return "object"
        return type(v).__name__

    def outline(v, depth, maxd):
        t = jtype(v)
        if t == "object":
            node = {"type": "object", "keyCount": len(v), "fields": []}
            if depth < maxd:
                for k in list(v.keys())[:40]:
                    node["fields"].append({"key": cell(k), "value": outline(v[k], depth + 1, maxd)})
            return node
        if t == "array":
            node = {"type": "array", "length": len(v)}
            if v and depth < maxd: node["item"] = outline(v[0], depth + 1, maxd)
            return node
        node = {"type": t}
        if t in ("str", "int", "float", "bool"): node["sample"] = cell(v)
        return node

    def do_json():
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                data = json.load(fh)
        except Exception as e:
            return {"ok": False, "error": "Invalid JSON: %s" % e}
        is_records = (isinstance(data, list) and data and
                      sum(1 for x in data[:50] if isinstance(x, dict)) >= max(1, min(len(data), 50) // 2))
        if is_records:
            if pd is not None:
                try:
                    out = df_summary(pd.json_normalize(data)); out["format"] = "records"; return out
                except Exception:
                    pass
            keys, seen = [], set()
            for item in data[:300]:
                if isinstance(item, dict):
                    for k in item.keys():
                        if k not in seen: seen.add(k); keys.append(k)
            cols = []
            for k in keys[:MAX_COLS]:
                vals = [item.get(k) for item in data[:300] if isinstance(item, dict)]
                nn = sum(1 for v in vals if v is not None)
                types = sorted(set(jtype(v) for v in vals if v is not None))
                cols.append({"name": cell(k), "dtype": "/".join(types) or "null", "nonNull": nn,
                             "nullCount": len(vals) - nn, "unique": None,
                             "sample": [cell(v) for v in vals if v is not None][:MAX_VALS]})
            return {"format": "records", "rowCount": len(data), "colCount": len(keys), "columns": cols, "sampleRows": []}
        top = []
        if isinstance(data, dict):
            for k in list(data.keys())[:60]:
                tv = jtype(data[k])
                top.append({"name": cell(k), "dtype": tv, "nonNull": None, "nullCount": None, "unique": None,
                            "sample": [cell(data[k])] if tv in ("str", "int", "float", "bool") else []})
        return {"format": "object", "rootType": jtype(data), "structure": outline(data, 0, 3),
                "columns": top, "keyCount": len(data) if isinstance(data, dict) else None}

    try:
        if kind == "csv": res = do_csv()
        elif kind == "excel": res = do_excel()
        elif kind == "json": res = do_json()
        else: res = {"ok": False, "error": "unsupported file type"}
    except Exception as e:
        res = {"ok": False, "error": str(e)}
    if res.get("ok") is False:
        done(res)
    res["ok"] = True; res["kind"] = kind
    done(res)

run()
`;

// Run the Python introspector on an absolute file path. Resolves with the parsed schema
// object, or { ok:false, error } if Python could not analyze it.
function analyzeWithPython(pythonPath, absPath, kind) {
  return new Promise((resolve) => {
    let out = '', err = '', settled = false;
    let proc;
    const finish = (val) => { if (settled) return; settled = true; resolve(val); };
    try {
      proc = spawn(pythonPath, ['-', absPath, kind], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ ok: false, error: `Could not launch Python: ${e.message}` });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
      finish({ ok: false, error: 'Schema detection timed out.' });
    }, DETECT_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: `Python error: ${e.message}` }); });
    proc.on('exit', () => {
      clearTimeout(timer);
      try { finish(JSON.parse(out.trim())); }
      catch (_) { finish({ ok: false, error: (err || 'Could not analyze the file.').trim().slice(0, 300) }); }
    });
    try { proc.stdin.write(INTROSPECT); proc.stdin.end(); } catch (_) { /* ignore */ }
  });
}

// Pure-Node fallback for CSV/JSON when Python can't be reached at all. Best-effort: a naive
// comma split (no quoted-comma handling) and shallow JSON inspection — enough to index the
// file and give the agent a starting schema. Excel cannot be parsed without a library.
function analyzeWithNode(absPath, kind) {
  try {
    if (kind === 'json') {
      const data = JSON.parse(fs.readFileSync(absPath, 'utf8'));
      const jtype = (v) => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'object' ? 'object' : typeof v;
      const records = Array.isArray(data) && data.length &&
        data.slice(0, 50).filter((x) => x && typeof x === 'object' && !Array.isArray(x)).length >= Math.max(1, Math.min(data.length, 50) / 2);
      if (records) {
        const keys = [];
        const seen = new Set();
        for (const item of data.slice(0, 300)) if (item && typeof item === 'object') for (const k of Object.keys(item)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
        const columns = keys.slice(0, 100).map((k) => {
          const vals = data.slice(0, 300).map((it) => (it && typeof it === 'object') ? it[k] : undefined);
          const present = vals.filter((v) => v !== undefined && v !== null);
          const types = Array.from(new Set(present.map(jtype)));
          return { name: k, dtype: types.join('/') || 'null', nonNull: present.length, nullCount: vals.length - present.length, unique: null, sample: present.slice(0, 6).map((v) => String(v).slice(0, 160)) };
        });
        return { ok: true, kind, format: 'records', rowCount: data.length, colCount: keys.length, columns, sampleRows: [] };
      }
      const columns = (data && typeof data === 'object' && !Array.isArray(data))
        ? Object.keys(data).slice(0, 60).map((k) => ({ name: k, dtype: jtype(data[k]), nonNull: null, nullCount: null, unique: null, sample: ['string', 'number', 'boolean'].includes(typeof data[k]) ? [String(data[k]).slice(0, 160)] : [] }))
        : [];
      return { ok: true, kind, format: 'object', rootType: jtype(data), columns, keyCount: (data && typeof data === 'object' && !Array.isArray(data)) ? Object.keys(data).length : null };
    }
    if (kind === 'csv') {
      const sep = absPath.toLowerCase().endsWith('.tsv') ? '\t' : ',';
      const text = fs.readFileSync(absPath, 'utf8');
      const lines = text.split(/\r?\n/).filter((l, i) => l.length || i === 0);
      const header = (lines[0] || '').split(sep);
      const body = lines.slice(1).filter((l) => l.length);
      const sample = body.slice(0, 500).map((l) => l.split(sep));
      const columns = header.slice(0, 100).map((name, ci) => {
        const cv = sample.map((r) => (ci < r.length ? r[ci] : ''));
        const present = cv.filter((v) => v !== '' && v != null);
        let t = 'int', seen = false;
        for (const v of present) { seen = true; if (!/^[-+]?\d+$/.test(v)) { t = /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(v) ? (t === 'int' ? 'float' : t) : 'str'; if (t === 'str') break; } }
        return { name, dtype: seen ? t : 'empty', nonNull: present.length, nullCount: cv.length - present.length, unique: null, sample: Array.from(new Set(present)).slice(0, 6).map((v) => String(v).slice(0, 160)) };
      });
      return { ok: true, kind, format: 'table', rowCount: body.length, colCount: header.length, columns, sampleRows: sample.slice(0, 5), sampled: true };
    }
  } catch (e) {
    return { ok: false, error: `Could not analyze the file: ${e.message}` };
  }
  return { ok: false, error: 'Could not analyze this file type without Python (pandas + openpyxl for Excel).' };
}

// Detect schema for an absolute file path: Python first (richest), Node fallback for
// CSV/JSON if Python is unreachable.
async function detect(pythonPath, absPath, kind) {
  let schema = await analyzeWithPython(pythonPath, absPath, kind);
  if ((!schema || schema.ok === false) && kind !== 'excel') {
    const node = analyzeWithNode(absPath, kind);
    if (node && node.ok) return node;
    if (!schema || !schema.error) return node; // keep whichever has an error message
  }
  return schema;
}

// ---- add / remove ---------------------------------------------------------

// Ingest source files into the project: validate, copy into data/, detect schema, index.
// Returns { added:[entry], errors:[{ name, error }] }. Validation failures reject the file
// (nothing is stored); detection failures still store the file with status 'error' so the
// user keeps their upload and can retry or install a missing engine.
async function add(workspaceDir, srcPaths, pythonPath, onProgress) {
  const dataDir = path.join(workspaceDir, DATA_DIRNAME);
  const manifest = readManifest(workspaceDir);
  const added = [];
  const errors = [];

  for (const src of (srcPaths || [])) {
    const displayName = path.basename(src || '');
    const v = validate(src);
    if (!v.ok) { errors.push({ name: displayName, error: v.error }); continue; }

    let destRel, destAbs;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const destName = uniqueDestName(dataDir, v.name);
      destAbs = path.join(dataDir, destName);
      destRel = path.posix.join(DATA_DIRNAME, destName);
      if (onProgress) onProgress({ name: v.name, phase: 'copying' });
      fs.copyFileSync(src, destAbs);
    } catch (e) {
      errors.push({ name: displayName, error: `Could not copy into the project: ${e.message}` });
      continue;
    }

    if (onProgress) onProgress({ name: v.name, phase: 'analyzing' });
    let schema = null, status = 'ready', error = null;
    try {
      schema = await detect(pythonPath, destAbs, v.kind);
    } catch (e) {
      schema = { ok: false, error: e.message };
    }
    if (!schema || schema.ok === false) {
      status = 'error';
      error = (schema && schema.error) || 'Schema detection failed.';
      schema = null;
    }

    const entry = {
      id: newId(),
      name: v.name,
      file: destRel,
      kind: v.kind,
      bytes: v.bytes,
      addedAt: new Date().toISOString(),
      status,
      error,
      schema,
    };
    manifest.datasets.push(entry);
    added.push(entry);
  }

  if (added.length) writeManifest(workspaceDir, manifest);
  return { added, errors };
}

// Re-run schema detection for an existing dataset (e.g. after installing pandas/openpyxl).
async function reanalyze(workspaceDir, id, pythonPath) {
  const manifest = readManifest(workspaceDir);
  const entry = manifest.datasets.find((d) => d.id === id);
  if (!entry) return null;
  const absPath = path.join(workspaceDir, entry.file);
  if (!fs.existsSync(absPath)) { entry.status = 'error'; entry.error = 'The data file is missing.'; entry.schema = null; }
  else {
    const schema = await detect(pythonPath, absPath, entry.kind);
    if (schema && schema.ok !== false) { entry.status = 'ready'; entry.error = null; entry.schema = schema; }
    else { entry.status = 'error'; entry.error = (schema && schema.error) || 'Schema detection failed.'; entry.schema = null; }
  }
  writeManifest(workspaceDir, manifest);
  return entry;
}

// Remove a dataset from the index and return its absolute file path so the caller can
// move it to the Trash (recoverable). The manifest entry is dropped regardless.
function remove(workspaceDir, id) {
  const manifest = readManifest(workspaceDir);
  const idx = manifest.datasets.findIndex((d) => d.id === id);
  if (idx < 0) return { removed: false, absPath: null };
  const [entry] = manifest.datasets.splice(idx, 1);
  writeManifest(workspaceDir, manifest);
  let absPath = null;
  try {
    const candidate = path.join(workspaceDir, entry.file);
    if (projects.isInside(workspaceDir, candidate) && fs.existsSync(candidate)) absPath = candidate;
  } catch (_) { /* ignore */ }
  return { removed: true, absPath, entry };
}

// ---- agent prompt context -------------------------------------------------

function fmtNum(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}

// How the agent should load a given dataset from the project working directory.
function loadHint(entry) {
  const p = entry.file;
  if (entry.kind === 'csv') return p.toLowerCase().endsWith('.tsv') ? `df = pd.read_csv("${p}", sep="\\t")` : `df = pd.read_csv("${p}")`;
  if (entry.kind === 'excel') {
    const sheet = entry.schema && entry.schema.sheetNames && entry.schema.sheetNames[0];
    return sheet ? `df = pd.read_excel("${p}", sheet_name="${sheet}")` : `df = pd.read_excel("${p}")`;
  }
  if (entry.kind === 'json') {
    if (entry.schema && entry.schema.format === 'records') return `df = pd.read_json("${p}")`;
    return `import json; data = json.load(open("${p}"))`;
  }
  return `open("${p}")`;
}

// One dataset rendered as a compact, model-readable summary block.
function renderEntryForPrompt(entry) {
  const lines = [];
  const s = entry.schema;
  const head = `• ${entry.file}  (${humanKind(entry.kind)}`;
  if (s && (s.format === 'table' || s.format === 'records') && s.rowCount != null) {
    lines.push(`${head}, ${fmtNum(s.rowCount)} rows × ${fmtNum(s.colCount)} cols)`);
  } else if (s && s.format === 'excel') {
    lines.push(`${head}, sheets: ${(s.sheetNames || []).join(', ')})`);
  } else if (s && s.format === 'object') {
    lines.push(`${head}, JSON ${s.rootType}${s.keyCount != null ? ` with ${s.keyCount} keys` : ''})`);
  } else {
    lines.push(`${head})`);
  }
  lines.push(`  Load: ${loadHint(entry)}`);

  if (!s) { lines.push(`  (schema not available${entry.error ? `: ${entry.error}` : ''})`); return lines.join('\n'); }

  const renderCols = (cols) => {
    for (const c of (cols || []).slice(0, 40)) {
      const bits = [c.dtype];
      if (c.nullCount != null && c.nullCount > 0) bits.push(`${fmtNum(c.nullCount)} nulls`);
      if (c.unique != null) bits.push(`${fmtNum(c.unique)} unique`);
      if (c.stats && c.stats.min != null && c.stats.max != null) bits.push(`min ${round(c.stats.min)}, max ${round(c.stats.max)}`);
      const ex = (c.sample && c.sample.length) ? ` — e.g. ${c.sample.slice(0, 4).join(', ')}` : '';
      lines.push(`    - ${c.name} (${bits.join(', ')})${ex}`);
    }
    if ((cols || []).length > 40) lines.push(`    … and ${cols.length - 40} more columns`);
  };

  if (s.format === 'excel') {
    for (const sheet of (s.sheets || []).slice(0, 6)) {
      lines.push(`  Sheet "${sheet.name}" — ${fmtNum(sheet.rowCount)} rows × ${fmtNum(sheet.colCount)} cols:`);
      renderCols(sheet.columns);
    }
  } else if (s.format === 'object') {
    lines.push(`  Structure:`);
    for (const c of (s.columns || []).slice(0, 30)) {
      const ex = (c.sample && c.sample.length) ? ` = ${c.sample[0]}` : '';
      lines.push(`    - ${c.name}: ${c.dtype}${ex}`);
    }
  } else {
    lines.push(`  Columns:`);
    renderCols(s.columns);
  }
  return lines.join('\n');
}

function round(n) {
  if (typeof n !== 'number' || !isFinite(n)) return n;
  return Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
}

// The data-context block injected into agent prompts (and the chat system prompt). Returns
// '' when the project has no usable datasets. Capped to `budget` characters.
function formatForPrompt(entries, budget) {
  budget = budget || 6000;
  const usable = (entries || []).filter((e) => e.exists !== false);
  if (!usable.length) return '';
  const header =
    '=== PROJECT DATA FILES (uploaded by the user) ===\n' +
    'These real files live in the project and are available at the relative paths below (the working ' +
    'directory is the project root). When the request involves data, USE these files — load them with ' +
    'the given snippet; never invent data or hardcode rows. pandas is the default reader.';
  const blocks = [header];
  let used = header.length;
  for (const e of usable) {
    const block = renderEntryForPrompt(e);
    if (used + block.length + 2 > budget) { blocks.push('• … (more data files not shown)'); break; }
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join('\n\n');
}

module.exports = {
  add, remove, reanalyze, list, get, detect, validate,
  formatForPrompt, kindForName, supportedExtensions, humanKind,
  DATA_DIRNAME, MAX_BYTES,
};
