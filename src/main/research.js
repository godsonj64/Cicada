'use strict';

// Research-grade dataset profiling and scientific validation. The Python engine
// computes bounded statistics locally; JS adds code-methodology checks, experiment
// comparison, persistence, and generated data-quality tests.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const datasets = require('./datasets');
const experiments = require('./experiments');
const projects = require('./projects');

const TIMEOUT_MS = 3 * 60 * 1000;
const MAX_ROWS = 200000;

const SCRIPT = String.raw`
import json, math, os, re, sys
path, kind, target = sys.argv[1], sys.argv[2], sys.argv[3]
MAX_ROWS = int(sys.argv[4])
def clean(v):
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)): return None
    if hasattr(v, "item"):
        try: return clean(v.item())
        except Exception: pass
    return v
def done(x):
    print(json.dumps(x, default=str)); sys.exit(0)
try:
    import pandas as pd
    import numpy as np
except Exception:
    done({"ok":False,"error":"Research profiling requires pandas and numpy. Install them from the Env tab."})
try:
    if kind == "csv": df = pd.read_csv(path, sep="\t" if path.lower().endswith(".tsv") else ",", nrows=MAX_ROWS)
    elif kind == "excel": df = pd.read_excel(path, nrows=MAX_ROWS)
    elif kind == "json":
        df = pd.read_json(path)
        if len(df) > MAX_ROWS: df = df.head(MAX_ROWS)
    else: done({"ok":False,"error":"Unsupported dataset type."})
except Exception as e: done({"ok":False,"error":"Could not load dataset: %s" % e})
n, p = len(df), len(df.columns)
if n == 0: done({"ok":False,"error":"Dataset is empty."})
target = target if target in df.columns else ""
columns, warnings, suggestions = [], [], []
for c in list(df.columns)[:300]:
    s, non = df[c], df[c].dropna()
    missing = int(s.isna().sum()); unique = int(non.nunique(dropna=True))
    item = {"name":str(c),"dtype":str(s.dtype),"missing":missing,"missingPct":clean(100*missing/n),"unique":unique,"uniquePct":clean(100*unique/max(1,len(non)))}
    # Infer units from conventions such as temperature_c, mass_kg, speed [m/s].
    m = re.search(r"\[([^\]]+)\]|(?:_|\b)(kg|g|mg|m|cm|mm|km|s|ms|hz|khz|mhz|c|f|k|pa|kpa|mpa|mol|mmol|percent|pct|usd|eur)$", str(c), re.I)
    item["unit"] = (m.group(1) or m.group(2)) if m else None
    if pd.api.types.is_numeric_dtype(s):
        vals = pd.to_numeric(non, errors="coerce").dropna()
        if len(vals):
            q1,q3 = vals.quantile(.25),vals.quantile(.75); iqr=q3-q1
            outliers = int(((vals < q1-1.5*iqr)|(vals > q3+1.5*iqr)).sum()) if iqr > 0 else 0
            mean=float(vals.mean()); std=float(vals.std()) if len(vals)>1 else 0.0; se=std/math.sqrt(len(vals)) if len(vals)>1 else 0.0
            item.update({"kind":"numeric","mean":clean(mean),"std":clean(std),"min":clean(float(vals.min())),"q1":clean(float(q1)),"median":clean(float(vals.median())),"q3":clean(float(q3)),"max":clean(float(vals.max())),"skew":clean(float(vals.skew())) if len(vals)>2 else None,"outliers":outliers,"outlierPct":clean(100*outliers/len(vals)),"meanCI95":[clean(mean-1.96*se),clean(mean+1.96*se)]})
            # Shapiro is bounded to 5k observations; absence of scipy is non-fatal.
            try:
                from scipy.stats import shapiro
                sample=vals.sample(min(5000,len(vals)),random_state=42) if len(vals)>5000 else vals
                stat,pv=shapiro(sample)
                item["normality"]={"test":"Shapiro-Wilk","statistic":clean(float(stat)),"pValue":clean(float(pv)),"likelyNormal":bool(pv>=.05),"sample":len(sample)}
            except Exception: item["normality"]={"test":"skew heuristic","likelyNormal":bool(abs(item.get("skew") or 0)<1),"sample":len(vals)}
    else:
        top = non.astype(str).value_counts().head(10)
        item.update({"kind":"categorical","topValues":[{"value":str(k)[:120],"count":int(v),"pct":clean(100*v/max(1,len(non)))} for k,v in top.items()]})
    columns.append(item)
    if missing/n >= .2: warnings.append({"severity":"warning","code":"missing","column":str(c),"message":"%s is %.1f%% missing."%(c,100*missing/n)})
    if unique <= 1: warnings.append({"severity":"warning","code":"constant","column":str(c),"message":"%s is constant and adds no information."%c})
    if len(non) and unique/len(non) >= .98: warnings.append({"severity":"info","code":"identifier","column":str(c),"message":"%s is nearly unique and may be an identifier."%c})
dups=int(df.duplicated().sum())
if dups: warnings.append({"severity":"warning","code":"duplicates","message":"%d duplicate rows (%.2f%%)."%(dups,100*dups/n)})
numeric=list(df.select_dtypes(include=[np.number]).columns)[:80]
correlations=[]
if len(numeric)>=2:
    cm=df[numeric].corr()
    for i,a in enumerate(numeric):
        for b in numeric[i+1:]:
            v=cm.loc[a,b]
            if v==v: correlations.append({"a":str(a),"b":str(b),"r":clean(float(v))})
    correlations.sort(key=lambda x:abs(x["r"] or 0),reverse=True)
correlations=correlations[:30]
targetInfo=None; leakage=[]
if target:
    ts=df[target]
    if pd.api.types.is_numeric_dtype(ts):
        vals=pd.to_numeric(ts,errors="coerce").dropna(); mean=float(vals.mean()) if len(vals) else 0; std=float(vals.std()) if len(vals)>1 else 0; se=std/math.sqrt(len(vals)) if len(vals)>1 else 0
        targetInfo={"name":target,"kind":"numeric","mean":clean(mean),"meanCI95":[clean(mean-1.96*se),clean(mean+1.96*se)],"missing":int(ts.isna().sum())}
        for c in numeric:
            if c==target: continue
            v=df[[c,target]].corr().iloc[0,1]
            if v==v and abs(v)>=.95: leakage.append({"column":str(c),"reason":"Correlation |r|=%.3f with the target is suspiciously high."%abs(v),"severity":"warning"})
    else:
        counts=ts.dropna().astype(str).value_counts(); total=int(counts.sum()); minority=int(counts.min()) if len(counts) else 0
        targetInfo={"name":target,"kind":"categorical","classes":int(len(counts)),"distribution":[{"value":str(k)[:120],"count":int(v),"pct":clean(100*v/max(1,total))} for k,v in counts.head(30).items()],"minorityPct":clean(100*minority/max(1,total)),"missing":int(ts.isna().sum())}
        if len(counts)>1 and minority/max(1,total)<.1: warnings.append({"severity":"warning","code":"imbalance","column":target,"message":"Target minority class is below 10%; use stratification and class-aware metrics."})
    for c in df.columns:
        if c==target: continue
        name=str(c).lower()
        if any(x in name for x in ["outcome","result","post_","after_","final_","label","target"]): leakage.append({"column":str(c),"reason":"Name suggests information recorded after or derived from the outcome.","severity":"warning"})
if any(x["code"]=="missing" for x in warnings): suggestions.append("Define an explicit missing-data strategy; compare complete-case and imputed sensitivity analyses.")
if dups: suggestions.append("Review and remove exact duplicates before splitting to prevent train/test contamination.")
if targetInfo and targetInfo.get("kind")=="categorical": suggestions.append("Use a stratified split and report per-class precision, recall, F1, and confidence intervals.")
if targetInfo and targetInfo.get("kind")=="numeric": suggestions.append("Report MAE/RMSE with bootstrap confidence intervals, not a point estimate alone.")
if not target: suggestions.append("Select a target column to enable imbalance and leakage checks.")
done({"ok":True,"engine":"pandas","rows":n,"columnsCount":p,"sampled":n>=MAX_ROWS,"duplicates":dups,"duplicatePct":clean(100*dups/n),"memoryBytes":int(df.memory_usage(deep=True).sum()),"columns":columns,"correlations":correlations,"target":targetInfo,"leakage":leakage,"warnings":warnings[:100],"suggestions":suggestions})
`;

function methodologyAudit(workspaceDir) {
  const joined = [];
  const files = [];
  const walk = (nodes) => { for (const n of nodes || []) { if (n.type === 'dir') walk(n.children); else if (/\.py$/i.test(n.path)) { try { joined.push(projects.readFile(workspaceDir, n.path)); files.push(n.path); } catch (_) {} } } };
  walk(projects.tree(workspaceDir));
  const code = joined.join('\n');
  const checks = [
    { id: 'split', label: 'Held-out evaluation split', ok: /train_test_split|StratifiedKFold|KFold|cross_val_score|cross_validate/.test(code), guidance: 'Use a held-out split or cross-validation; never evaluate on training data.' },
    { id: 'seed', label: 'Deterministic random seed', ok: /random_state\s*=|\.seed\s*\(|manual_seed\s*\(|set_seed\s*\(/.test(code), guidance: 'Set seeds for Python, NumPy, and your ML framework.' },
    { id: 'pipeline', label: 'Preprocessing isolation', ok: /Pipeline\s*\(|make_pipeline\s*\(/.test(code), guidance: 'Fit preprocessing inside a Pipeline to avoid leakage across folds.' },
    { id: 'stratify', label: 'Class-preserving split', ok: /stratify\s*=|Stratified/.test(code), guidance: 'For classification, stratify splits unless the design requires otherwise.' },
    { id: 'intervals', label: 'Uncertainty reported', ok: /confidence|conf_int|bootstrap|std_error|sem\s*\(/i.test(code), guidance: 'Report confidence intervals or another uncertainty estimate.' },
    { id: 'metrics', label: 'Multiple evaluation metrics', ok: /(accuracy|precision|recall|f1|roc_auc|mean_squared_error|mean_absolute_error).*(accuracy|precision|recall|f1|roc_auc|mean_squared_error|mean_absolute_error)/is.test(code), guidance: 'Use metrics aligned with the scientific question and failure costs.' },
  ];
  return { files, checks, score: checks.filter((c) => c.ok).length, total: checks.length };
}

function analyze(workspaceDir, datasetId, target, pythonPath) {
  const dataset = datasets.get(workspaceDir, datasetId);
  if (!dataset || !dataset.exists) return Promise.resolve({ ok: false, error: 'Dataset not found.' });
  const abs = projects.resolveInProject(workspaceDir, dataset.file);
  return new Promise((resolve) => {
    let out = '', err = '', settled = false;
    const finish = (x) => { if (!settled) { settled = true; resolve(x); } };
    let proc;
    try { proc = spawn(pythonPath, ['-', abs, dataset.kind, String(target || ''), String(MAX_ROWS)], { cwd: workspaceDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { finish({ ok: false, error: e.message }); return; }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish({ ok: false, error: 'Research audit timed out.' }); }, TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d.toString(); }); proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
    proc.on('exit', () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(out.trim());
        result.dataset = { id: dataset.id, name: dataset.name, file: dataset.file, kind: dataset.kind };
        result.methodology = methodologyAudit(workspaceDir);
        if (result.ok) persist(workspaceDir, result);
        finish(result);
      } catch (_) { finish({ ok: false, error: (err || 'Profiler returned invalid output.').trim().slice(0, 1000) }); }
    });
    proc.stdin.end(SCRIPT);
  });
}

function reportsRoot(workspaceDir) { return path.join(workspaceDir, '.garm', 'research'); }
function persist(workspaceDir, report) {
  const dir = reportsRoot(workspaceDir); fs.mkdirSync(dir, { recursive: true });
  const datasetId = String(report.dataset.id || 'dataset').replace(/[^A-Za-z0-9_-]/g, '_');
  const id = Date.now().toString(36) + '-' + datasetId;
  report.id = id; report.createdAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(report, null, 2), 'utf8');
}
function listReports(workspaceDir) {
  let files=[]; try { files=fs.readdirSync(reportsRoot(workspaceDir)).filter((x)=>x.endsWith('.json')); } catch (_) { return []; }
  return files.map((f)=>{try{return JSON.parse(fs.readFileSync(path.join(reportsRoot(workspaceDir),f),'utf8'));}catch(_){return null;}}).filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

function compareRuns(workspaceDir) {
  const runs = experiments.list(workspaceDir);
  const metricNames = Array.from(new Set(runs.flatMap((r) => Object.keys(r.metrics || {}))));
  const metrics = metricNames.map((name) => {
    const values = runs.filter((r) => Number.isFinite(r.metrics && r.metrics[name])).map((r) => ({ runId: r.id, file: r.file, startedAt: r.startedAt, value: r.metrics[name] }));
    if (!values.length) return null;
    const lowerBetter = /loss|error|rmse|mse|mae|mape|perplexity|ppl/i.test(name);
    const sorted = values.slice().sort((a,b)=>lowerBetter?a.value-b.value:b.value-a.value);
    return { name, lowerBetter, best: sorted[0], values };
  }).filter(Boolean);
  return { runs, metrics };
}

function generateTests(workspaceDir, report) {
  if (!report || !report.ok || !report.dataset) throw new Error('Run a research audit before generating tests.');
  const safe = path.basename(report.dataset.name || 'dataset').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'dataset';
  const rel = 'tests/test_data_quality_' + safe + '.py';
  const required = (report.columns || []).filter((c) => c.missingPct === 0).map((c) => c.name);
  const target = report.target && report.target.name;
  const lines = [
    '"""Generated by Cicada Research Audit. Review thresholds before publication."""',
    'from pathlib import Path', 'import pandas as pd', '',
    `DATA = Path(__file__).parents[1] / ${JSON.stringify(String(report.dataset.file).replace(/\\/g,'/'))}`,
    '', 'def load_data():',
    report.dataset.kind === 'excel' ? '    return pd.read_excel(DATA)' : report.dataset.kind === 'json' ? '    return pd.read_json(DATA)' : '    return pd.read_csv(DATA)',
    '', 'def test_dataset_is_not_empty():', '    assert len(load_data()) > 0',
    '', 'def test_required_columns_exist():', `    required = ${JSON.stringify(required)}`, '    assert set(required).issubset(load_data().columns)',
    '', 'def test_duplicate_rate_is_bounded():', '    df = load_data()', '    assert df.duplicated().mean() <= 0.01, "Duplicate rate exceeds 1%; review split contamination"',
  ];
  if (target) lines.push('', 'def test_target_is_present_and_not_missing():', '    df = load_data()', `    assert ${JSON.stringify(target)} in df.columns`, `    assert df[${JSON.stringify(target)}].isna().mean() <= 0.05, "Target missingness exceeds 5%"`);
  projects.writeFile(workspaceDir, rel, lines.join('\n') + '\n');
  return { path: rel, content: lines.join('\n') + '\n' };
}

module.exports = { analyze, methodologyAudit, compareRuns, generateTests, listReports };
