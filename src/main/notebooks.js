'use strict';

// Minimal Jupyter v4 notebook support with a local, stateful Python runner.
// Cells execute sequentially in one namespace. The runner returns structured text,
// tables, errors, and plot paths; notebook content is never uploaded.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const projects = require('./projects');

const MAX_NOTEBOOK_BYTES = 5 * 1024 * 1024;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

function cell(kind, source) {
  return { cell_type: kind, metadata: {}, source: String(source || '').split(/(?<=\n)/), ...(kind === 'code' ? { execution_count: null, outputs: [] } : {}) };
}

function create(title) {
  return {
    cells: [
      cell('markdown', '# ' + (String(title || 'Untitled notebook').trim() || 'Untitled notebook') + '\n\nDescribe the question, then add code cells to explore it.'),
      cell('code', 'import pandas as pd\nimport matplotlib.pyplot as plt\n\nprint("Notebook ready")\n'),
    ],
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' }, cicada: { version: 1 } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function normalize(doc) {
  if (!doc || !Array.isArray(doc.cells)) throw new Error('This is not a valid Jupyter notebook.');
  return {
    cells: doc.cells.map((c) => ({
      cell_type: c.cell_type === 'markdown' ? 'markdown' : 'code',
      metadata: c.metadata && typeof c.metadata === 'object' ? c.metadata : {},
      source: Array.isArray(c.source) ? c.source : String(c.source || '').split(/(?<=\n)/),
      ...(c.cell_type === 'markdown' ? {} : { execution_count: c.execution_count == null ? null : c.execution_count, outputs: Array.isArray(c.outputs) ? c.outputs : [] }),
    })),
    metadata: doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {},
    nbformat: 4,
    nbformat_minor: Number(doc.nbformat_minor) || 5,
  };
}

function load(workspaceDir, relPath) {
  if (!/\.ipynb$/i.test(String(relPath || ''))) throw new Error('Notebook files must end in .ipynb.');
  const abs = projects.resolveInProject(workspaceDir, relPath);
  const stat = fs.statSync(abs);
  if (stat.size > MAX_NOTEBOOK_BYTES) throw new Error('Notebook is larger than 5 MB. Clear large outputs before opening it.');
  return normalize(JSON.parse(fs.readFileSync(abs, 'utf8')));
}

function save(workspaceDir, relPath, doc) {
  const abs = projects.resolveInProject(workspaceDir, relPath);
  if (!/\.ipynb$/i.test(abs)) throw new Error('Notebook files must end in .ipynb.');
  const clean = normalize(doc);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(clean, null, 1) + '\n', 'utf8');
  return clean;
}

const RUNNER = String.raw`
import ast, contextlib, io, json, os, sys, traceback
os.environ.setdefault("MPLBACKEND", "Agg")

nb_path, out_dir = sys.argv[1], sys.argv[2]
with open(nb_path, "r", encoding="utf-8") as f:
    nb = json.load(f)
os.makedirs(out_dir, exist_ok=True)
ns = {"__name__": "__main__", "__file__": nb_path}
results, execution = [], 0

def output(kind, **kw):
    x = {"type": kind}; x.update(kw); return x

for idx, cell in enumerate(nb.get("cells", [])):
    if cell.get("cell_type") != "code":
        continue
    execution += 1
    source = cell.get("source", "")
    if isinstance(source, list): source = "".join(source)
    stdout, stderr, outs = io.StringIO(), io.StringIO(), []
    try:
        tree = ast.parse(source, filename="%s:cell-%d" % (nb_path, idx + 1), mode="exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
            ast.fix_missing_locations(last)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            if tree.body:
                exec(compile(tree, nb_path, "exec"), ns, ns)
            value = eval(compile(last, nb_path, "eval"), ns, ns) if last else None
        if stdout.getvalue(): outs.append(output("stdout", text=stdout.getvalue()))
        if stderr.getvalue(): outs.append(output("stderr", text=stderr.getvalue()))
        if value is not None:
            try:
                import pandas as pd
                if isinstance(value, (pd.DataFrame, pd.Series)):
                    frame = value.to_frame() if isinstance(value, pd.Series) else value
                    view = frame.head(200)
                    outs.append(output("table", columns=[str(c) for c in view.columns], rows=json.loads(view.to_json(orient="values", date_format="iso")), truncated=len(frame) > len(view), totalRows=int(len(frame))))
                else:
                    outs.append(output("result", text=repr(value)[:20000]))
            except Exception:
                outs.append(output("result", text=repr(value)[:20000]))
        try:
            import matplotlib.pyplot as plt
            for n in list(plt.get_fignums()):
                fig = plt.figure(n)
                name = "notebook-cell-%03d-fig-%02d.png" % (idx + 1, n)
                target = os.path.join(out_dir, name)
                fig.savefig(target, dpi=130, bbox_inches="tight")
                outs.append(output("image", path=target))
                plt.close(fig)
        except Exception:
            pass
        results.append({"index": idx, "executionCount": execution, "ok": True, "outputs": outs})
    except Exception as e:
        if stdout.getvalue(): outs.append(output("stdout", text=stdout.getvalue()))
        if stderr.getvalue(): outs.append(output("stderr", text=stderr.getvalue()))
        outs.append(output("error", name=type(e).__name__, message=str(e), traceback=traceback.format_exc()))
        results.append({"index": idx, "executionCount": execution, "ok": False, "outputs": outs})
        break
sys.stdout.write(json.dumps({"ok": all(r["ok"] for r in results), "cells": results}))
`;

function run(workspaceDir, relPath, pythonPath) {
  const doc = load(workspaceDir, relPath);
  const abs = projects.resolveInProject(workspaceDir, relPath);
  const outputDir = path.join(workspaceDir, '.garm', 'notebook-output', path.basename(relPath, '.ipynb'));
  fs.mkdirSync(outputDir, { recursive: true });
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false;
    let proc;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    try {
      proc = spawn(pythonPath, ['-', abs, outputDir], { cwd: workspaceDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) { finish({ ok: false, error: err.message, cells: [] }); return; }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish({ ok: false, error: 'Notebook run timed out after 10 minutes.', cells: [] }); }, RUN_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { clearTimeout(timer); finish({ ok: false, error: err.message, cells: [] }); });
    proc.on('exit', () => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(stdout.trim()); }
      catch (_) { finish({ ok: false, error: (stderr || 'Notebook runner returned invalid output.').trim().slice(0, 1000), cells: [] }); return; }
      for (const item of result.cells || []) {
        const target = doc.cells[item.index];
        if (!target) continue;
        target.execution_count = item.executionCount;
        target.outputs = (item.outputs || []).map((o) => {
          if (o.type === 'image') return { output_type: 'display_data', data: { 'image/png': o.path }, metadata: {}, cicada_path: o.path };
          if (o.type === 'error') return { output_type: 'error', ename: o.name, evalue: o.message, traceback: String(o.traceback || '').split('\n') };
          if (o.type === 'table') return { output_type: 'display_data', data: { 'application/vnd.cicada.table+json': { columns: o.columns, rows: o.rows, truncated: o.truncated, totalRows: o.totalRows } }, metadata: {} };
          if (o.type === 'result') return { output_type: 'execute_result', execution_count: item.executionCount, data: { 'text/plain': o.text }, metadata: {} };
          return { output_type: 'stream', name: o.type === 'stderr' ? 'stderr' : 'stdout', text: o.text || '' };
        });
      }
      save(workspaceDir, relPath, doc);
      finish({ ...result, notebook: doc });
    });
    try { proc.stdin.end(RUNNER); } catch (_) { /* process ended */ }
  });
}

module.exports = { create, normalize, load, save, run, cell };
