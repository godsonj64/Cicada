'use strict';

const path = require('path');
const fs = require('fs');
const {
  streamChatResilient, splitThinking, extractCode, extractCodeStreaming, answerStream,
  extractFiles, extractFilesStreaming, pickEntry,
} = require('./llm');
const python = require('./python');
const { spliceRegion, regionText } = require('./splice');
const projects = require('./projects');
const { runRepairLoop } = require('./repair-loop');
const { ProblemLedger, describeChange } = require('./agent-memory');

const SYS = 'You are Cicada, an expert Python engineer working inside an agentic IDE. Be precise, correct, and concise.';

// May the answer be streamed to the UI yet? Answer deltas must not be emitted while the
// model might still be inside a <think> block, or reasoning would leak into the answer
// pane. Gating on the CLOSING tag alone, though, meant a model that never opens one — any
// plain instruct model, Qwen2.5-Coder included — streamed nothing at all: no reasoning to
// show, and the answer suppressed until the stage finished. Reasoning models are unaffected.
function answerStreamable(full) {
  if (/<\/think>/i.test(full)) return true;   // thought closed — the rest is the answer
  if (/<think>/i.test(full)) return false;    // still inside the thought
  // No opening tag, but the first bytes could still be growing into one ("<", "<th", …),
  // so hold until the text can no longer become "<think>".
  return !'<think>'.startsWith(full.trimStart().slice(0, 7).toLowerCase());
}

// Code-producing stages (generate / apply / fix / inpaint) run AFTER the Evaluate and
// Design stages have already planned the solution, so the model must NOT re-derive the
// whole approach inside a long <think> block — that is exactly what made "Generate Code"
// sit reasoning for ages before emitting a single line. This directive caps reasoning to a
// few lines and pushes it to open the ```python block almost immediately. (Analysis stages
// — evaluate / design / review — deliberately omit it: their value IS the thinking.)
const BRIEF_THINK =
  'CRITICAL — do not over-think: everything you need to write the code is already above, so ' +
  'keep any reasoning to at most 1–2 short sentences (no restating the request, no weighing ' +
  'alternatives, no step-by-step outline), then immediately start writing the code. Open the ' +
  '```python block as early as possible.';

// Repo mode: how the model must lay out a multi-file project. The format anchors each
// file on a fenced block labelled with its project-relative path, which the parser in
// llm.js (extractFiles) reads back deterministically. The import rules are what keep a
// generated repo runnable as `python main.py`: main.py uses ABSOLUTE imports rooted at
// the project (the run harness puts the project dir on sys.path), and every imported
// package directory carries an __init__.py — the two things small models most often get
// wrong and that turn a multi-file project into ImportError soup.
//
// The example uses obvious PLACEHOLDER names on purpose. It used to show `models/net.py`,
// `from models.net import Net` and "models/, data/, training, utils", and the 3B model
// copied that scaffold into unrelated programs — asked to fix a sine-wave plotter, it
// rewrote it as a PyTorch training project whose `data.loader` did not exist. The rules
// name the two cross-file mistakes seen most in practice: importing a name the other file
// does not define, and using a module (plt, np) in a file that never imports it.
const REPO_FORMAT =
  'Lay the program out as a small multi-file Python project. Output EACH file as its own ' +
  'fenced code block, immediately preceded by its project-relative path on its own line as a ' +
  'markdown heading. FORMAT (the names are placeholders — choose names that fit THIS program):\n\n' +
  '### main.py\n```python\n<contents of main.py>\n```\n\n' +
  '### package_name/module_name.py\n```python\n<contents of the module>\n```\n\n' +
  'Hard rules:\n' +
  '- Include a runnable `main.py` at the project ROOT whose `if __name__ == "__main__":` block calls the program\'s main logic.\n' +
  '- Use ABSOLUTE imports rooted at the project (`from package_name.module_name import some_name`). ' +
  'Do NOT use package-relative imports (`from .x import y`) in main.py.\n' +
  '- Add an empty `__init__.py` to EVERY package directory you import from.\n' +
  '- Create only the modules THIS program needs — a small program needs 2–4 files. Do not add unrelated modules.\n' +
  '- Every name you import from a project file must be defined in that file, with the same parameters you call it with.\n' +
  '- Each file imports what IT uses at its top (e.g. a module that plots needs its own `import matplotlib.pyplot as plt`).\n' +
  '- You may add a `requirements.txt` listing third-party packages.\n' +
  'Output ONLY path headings and fenced code blocks — no commentary between or around them.';

// Repairs and edits to an EXISTING project: return only what changes, and keep the project
// as it is. Repeating the generation layout rules here invited the model to re-architect the
// project on every fix.
const REPO_EDIT_FORMAT =
  'Return ONLY the files you add or change — each as its project-relative path on its own line as a ' +
  'markdown heading (e.g. `### main.py`), followed by the COMPLETE new contents of that file in a ```python ' +
  'fenced block. Keep the existing files, file names, function names and structure: do not rename, ' +
  'reorganize or add files unless the task requires it. Every name imported from a project file must be ' +
  'defined in that file, and each file imports what it uses. No commentary.';

// Fallback library note (used until the environment has been probed). GARM supports
// the full Python ecosystem — including frontier ML/DL frameworks — not just stdlib.
const LIB_NOTE =
  'You may use any installed third-party library (numpy, pandas, scipy, scikit-learn, ' +
  'PyTorch/torch, TensorFlow, JAX, transformers, OpenCV, etc.) as well as the standard library. ' +
  'For plots or graphics, matplotlib runs headless — call plt.show() or plt.savefig(...) and Cicada ' +
  'captures the figure into the Render panel. Do not start servers, GUIs, or blocking input().';

// Stage sets. The renderer builds its cards from whichever set a run declares. Review comes
// AFTER the program has run: it checks the real output against the request, rather than
// asking a model to guess at problems in code nobody has executed yet.
const FULL_STAGES = [
  { id: 'evaluate', name: 'Evaluate' },
  { id: 'design', name: 'System Design' },
  { id: 'generate', name: 'Generate Code' },
  { id: 'fix', name: 'Fix & Compile' },
  { id: 'run', name: 'Run & Render' },
  { id: 'review', name: 'Review' },
];
const REFINE_STAGES = [
  { id: 'plan', name: 'Plan Change' },
  { id: 'apply', name: 'Apply Changes' },
  { id: 'fix', name: 'Fix & Compile' },
  { id: 'run', name: 'Run & Render' },
  { id: 'review', name: 'Review' },
];
// Surgical select-and-replace ("inpaint"): rewrite only the selected region, then
// verify the whole file still compiles/runs — rolling back if it cannot.
const INPAINT_STAGES = [
  { id: 'region', name: 'Rewrite Selection' },
  { id: 'verify', name: 'Splice & Verify' },
  { id: 'run', name: 'Run & Render' },
];
const STAGE_NAMES = [...FULL_STAGES, ...REFINE_STAGES, ...INPAINT_STAGES]
  .reduce((m, s) => { m[s.id] = s.name; return m; }, {});

// A program whose first successful run takes longer than this is not re-run to check review
// edits: the review would double a long training run for a speculative improvement.
const REVIEW_MAX_RUN_MS = 60000;

const REASK =
  '\n\nIMPORTANT: Your previous reply contained NO usable fenced code block. Respond again, and this ' +
  'time output the code inside ONE complete ```python fenced block — open the fence, write the full ' +
  'code, and CLOSE the fence. No prose.';

// Does the request (or the program's own history) call for keyboard input? Verification
// runs have no keyboard, so input() fails at once; this decides whether that is a bug to
// repair (the model added input() gratuitously) or the program's nature (hand the program
// to the user to run interactively). A false positive only skips an automatic repair, so
// the net is cast wide.
const INTERACTIVE_RE = new RegExp([
  'input\\(', '\\binteractive(ly)?\\b', '\\buser input\\b', '\\b(ask|asks|asking|prompt|prompts|prompting) (the )?users?\\b',
  '\\busers? (enter|enters|types?|inputs?|chooses|picks|selects)\\b', '\\benter (a|an|the|your|two|some|their)\\b',
  '\\btype (a|an|the|in)\\b', '\\bkeyboard\\b', '\\bstdin\\b', '\\bmenu\\b', '\\brepl\\b', '\\bchat ?bot\\b',
  '\\bquiz\\b', '\\bcalculator\\b', '\\bguess(ing)?\\b', '\\btic[- ]?tac[- ]?toe\\b', '\\bhangman\\b',
  '\\btext[- ]based\\b', '\\bgame\\b(?! of life)', '\\bplay(er)? against\\b', '\\bcommand[- ]line (tool|app|interface)\\b',
].join('|'), 'i');
function wantsInput(text) { return INTERACTIVE_RE.test(String(text || '')); }

// Does the request ask for a figure? Used to judge a run by its RESULT, not just its exit
// code: a plotting program that exits 0 without drawing anything has not done its job.
const PLOT_RE = /\b(plot|plots|plotted|plotting|chart|charts|figure(?! out)|figures|visuali[sz]e|visuali[sz]ation|imshow|histogram|heatmap|scatter ?plot|subplots?|draw (?:a|the)|show (?:it|them|the (?:figure|plot|chart|image)))\b/i;
function wantsPlot(text) { return PLOT_RE.test(String(text || '')); }

// Folders that never count as a program's output (caches, environments, Cicada's state).
const OUTPUT_SKIP = new Set(['.git', '.garm', '.venv', 'venv', 'env', 'node_modules', '__pycache__', '.ipynb_checkpoints']);

// Did the run write any file under `dir` (a CSV, a model checkpoint, a report…)?
function wroteFilesSince(dir, sinceMs, depth = 3) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return false; }
  for (const e of entries) {
    if (e.name.startsWith('_garm_') || OUTPUT_SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 1 && wroteFilesSince(p, sinceMs, depth - 1)) return true; continue; }
    try { if (fs.statSync(p).mtimeMs >= sinceMs) return true; } catch (_) { /* vanished */ }
  }
  return false;
}

// The imports small models most often forget in one file of a multi-file project.
const ALIAS_IMPORTS = {
  plt: 'import matplotlib.pyplot as plt', np: 'import numpy as np', pd: 'import pandas as pd',
  sns: 'import seaborn as sns', mpl: 'import matplotlib as mpl', tf: 'import tensorflow as tf',
  torch: 'import torch', nn: 'import torch.nn as nn', F: 'import torch.nn.functional as F',
  optim: 'import torch.optim as optim', stats: 'from scipy import stats', math: 'import math',
  random: 'import random', os: 'import os', sys: 'import sys', time: 'import time', json: 'import json',
  re: 'import re', csv: 'import csv', datetime: 'from datetime import datetime',
};

// Project paths as the model writes them ("utils.py", not "/var/folders/…/utils.py"):
// shorter, and they match the file names in the prompt.
function relativize(text, dir) {
  let out = String(text || '');
  if (!dir) return out;
  const roots = new Set([dir]);
  try { const real = fs.realpathSync(dir); roots.add(real); if (real.startsWith('/private/')) roots.add(real.slice(8)); } catch (_) { /* ignore */ }
  for (const root of roots) out = out.split(root + path.sep).join('').split(root + '/').join('');
  return out;
}

// ---- Cross-file facts for multi-file failures ----------------------------------
// The commonest multi-file failures are mismatches between files: main.py imports a name
// the module defines under another name, or calls a function with the wrong arguments.
// The model cannot see the other file's real names in the error, so it guesses; these
// helpers look them up so the hint can state exactly what exists.

// Absolute path of a project module ("pkg.mod" -> pkg/mod.py or pkg/mod/__init__.py).
function moduleFile(dir, mod) {
  const rel = String(mod || '').replace(/\./g, '/');
  if (!dir || !rel) return null;
  for (const cand of [rel + '.py', rel + '/__init__.py']) {
    const abs = path.join(dir, cand);
    if (fs.existsSync(abs)) return { abs, rel: cand };
  }
  return null;
}

// Names a module defines at top level (functions, classes, assignments).
function topLevelNames(src) {
  const names = [];
  for (const line of String(src || '').split('\n')) {
    const m = line.match(/^(?:async\s+)?def\s+(\w+)|^class\s+(\w+)|^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/);
    const n = m && (m[1] || m[2] || m[3]);
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

// Every project .py file (bounded), for finding where a function is defined.
function projectPyFiles(dir, depth = 4, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (out.length >= 200) break;
    if (OUTPUT_SKIP.has(e.name) || e.name.startsWith('_garm_') || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 1) projectPyFiles(p, depth - 1, out); }
    else if (/\.py$/.test(e.name)) out.push(p);
  }
  return out;
}

// "def name(...):" as written in the project, possibly spanning lines.
function findSignature(dir, fn) {
  for (const abs of projectPyFiles(dir)) {
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    const m = src.match(new RegExp('^[ \\t]*(?:async\\s+)?def\\s+' + escapeRe(fn) + '\\s*\\([\\s\\S]*?\\)\\s*(?:->[^:]*)?:', 'm'));
    if (m) return { file: path.relative(dir, abs).split(path.sep).join('/'), sig: m[0].trim().replace(/\s+/g, ' ').slice(0, 240) };
  }
  return null;
}

// A precise hint for a cross-file mismatch, or ''.
function crossFileHint(exc, dir) {
  let m = exc.match(/ImportError: cannot import name '(\w+)' from '([\w.]+)'/) ||
    exc.match(/AttributeError: module '([\w.]+)' has no attribute '(\w+)'/);
  if (m) {
    const [name, mod] = /^ImportError/.test(exc) ? [m[1], m[2]] : [m[2], m[1]];
    const file = moduleFile(dir, mod);
    if (!file) return '';
    let src = '';
    try { src = fs.readFileSync(file.abs, 'utf8'); } catch (_) { return ''; }
    const names = topLevelNames(src).filter((n) => !n.startsWith('_'));
    return `HINT: ${file.rel} has no \`${name}\`. It defines: ${names.length ? names.slice(0, 25).map((n) => '`' + n + '`').join(', ') : '(nothing importable)'}. ` +
      `Either import one of those names instead, or add \`${name}\` to ${file.rel} — keep every file consistent with the others.`;
  }
  m = exc.match(/TypeError: (?:[\w.]+\.)?(\w+)\(\) (missing \d+ required|takes \d+|got an unexpected keyword|got multiple values)/);
  if (m) {
    const found = findSignature(dir, m[1]);
    if (found) return `HINT: \`${m[1]}\` is defined in ${found.file} as \`${found.sig}\` — make every call match that signature (or change the signature and all its callers together).`;
  }
  return '';
}

/**
 * Turn raw stderr into something a small model can act on. Four real failures in a row on
 * the local 3B model were one-line NameErrors it never fixed: the real error sat under
 * numpy warnings and the run harness's own frames, so the "repair" changed the warning
 * instead. Returns { summary, warnings, traceback }: a one-glance ERROR / WHERE block (with
 * a concrete hint for the NameErrors small models make most), warnings set apart, and the
 * program's own traceback.
 */
function describeFailure(stderr, dir) {
  const lines = relativize(stderr, dir).split('\n');
  const warnings = [];
  const rest = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\S.*:\d+: \w*Warning: /.test(lines[i])) {
      warnings.push(lines[i]);
      if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s+File "/.test(lines[i + 1])) warnings.push(lines[++i]);
      continue;
    }
    rest.push(lines[i]);
  }
  const frameRe = /^\s*File "([^"]+)", line (\d+), in (.+)$/;
  let where = null;
  for (let i = 0; i < rest.length; i++) {
    const m = rest[i].match(frameRe);
    // The last frame in the project's own code (library and <frozen> frames are absolute or bracketed).
    if (m && !path.isAbsolute(m[1]) && !m[1].startsWith('<')) {
      const next = rest[i + 1] || '';
      where = { file: m[1], line: m[2], fn: m[3].trim(), src: next.trim() && !frameRe.test(next) ? next.trim() : '' };
    }
  }
  const exc = rest.map((l) => l.trim()).reverse().find((l) => /^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt)\b/.test(l)) || '';
  const summary = [];
  if (exc) summary.push('ERROR: ' + exc);
  if (where) {
    summary.push(`WHERE: ${where.file}, line ${where.line}${where.fn !== '<module>' ? `, in ${where.fn}()` : ''}`);
    if (where.src) summary.push('    ' + where.src);
  }
  const ne = exc.match(/NameError: name '(\w+)' is not defined/);
  const cross = !ne ? crossFileHint(exc, dir) : '';
  if (cross) summary.push(cross);
  if (ne) {
    const name = ne[1];
    const file = where ? where.file : 'that file';
    summary.push(ALIAS_IMPORTS[name]
      ? `HINT: \`${name}\` is used in ${file} but never imported there — add \`${ALIAS_IMPORTS[name]}\` at the top of ${file}. Each file needs its own imports.`
      : `HINT: \`${name}\` does not exist${where && where.fn !== '<module>' ? ` inside ${where.fn}()` : ''} in ${file}. It is usually a missing import, a variable that belongs to another function (pass it in as a parameter), or a typo.`);
  }
  return { summary: summary.join('\n'), warnings: warnings.join('\n').trim(), traceback: rest.join('\n').trim() };
}

function tail(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? '…' + t.slice(-n) : t;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

function pipCommand(pythonPath, pkg) {
  const py = /\s/.test(pythonPath) ? `"${pythonPath}"` : pythonPath;
  return `${py} -m pip install ${pkg}`;
}

// Flatten a repo snapshot for change descriptions and equality checks.
function serializeFiles(files) {
  return (files || []).map((f) => `### ${f.path}\n${f.content}`).join('\n');
}

/**
 * The project files reachable from `entry` through local imports — the program that is
 * actually run. Repo-mode refine used to hand the model every .py file in the folder,
 * including leftovers from earlier, unrelated programs, which wasted the context window
 * and confused the model about what the project is. Resolves absolute imports from both
 * the importing file's folder and the project root (matching the run harness), relative
 * imports, and `from pkg import module` submodules. Returns project-relative paths.
 */
function localImportClosure(files, entry) {
  const have = new Set((files || []).map((f) => f.path));
  const content = new Map((files || []).map((f) => [f.path, f.content || '']));
  const find = (base) => {
    const clean = base.replace(/^\/+/, '');
    if (!clean) return null;
    for (const cand of [clean + '.py', clean + '/__init__.py']) if (have.has(cand)) return cand;
    return null;
  };
  const seen = new Set();
  const queue = entry && have.has(entry) ? [entry] : [];
  const push = (p) => { if (p && !seen.has(p)) queue.push(p); };
  // An absolute module path, looked up relative to the importing file's folder first (the
  // script's directory is sys.path[0]) and then the project root. Parent packages are
  // included because importing a.b runs a/__init__.py.
  const addAbsolute = (mod, fromDir) => {
    const parts = mod.split('.').filter(Boolean);
    for (const root of fromDir ? [fromDir, ''] : ['']) {
      for (let i = parts.length; i >= 1; i--) {
        const hit = find([root, parts.slice(0, i).join('/')].filter(Boolean).join('/'));
        if (hit) push(hit);
      }
    }
  };
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const dir = path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p);
    for (const line of content.get(p).split('\n')) {
      let m = line.match(/^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/);
      if (m) {
        const dots = m[1].length;
        const mod = m[2];
        const names = m[3].replace(/[()\\]/g, '').split(',')
          .map((s) => s.trim().split(/\s+as\s+/)[0]).filter((s) => /^\w+$/.test(s));
        if (dots) {
          const up = dir.split('/').filter(Boolean);
          const base = up.slice(0, Math.max(0, up.length - (dots - 1))).join('/');
          const target = [base, mod.replace(/\./g, '/')].filter(Boolean).join('/');
          push(find(target));
          for (const n of names) push(find([target, n].filter(Boolean).join('/')));
        } else if (mod) {
          addAbsolute(mod, dir);
          for (const n of names) addAbsolute(mod + '.' + n, dir); // `from pkg import module`
        }
        continue;
      }
      m = line.match(/^\s*import\s+(.+)$/);
      if (m) {
        for (const part of m[1].split(',')) {
          const mod = part.trim().split(/\s+as\s+/)[0].trim();
          if (/^[\w.]+$/.test(mod)) addAbsolute(mod, dir);
        }
      }
    }
  }
  return [...seen];
}

class Pipeline {
  constructor({ config, baseUrl, emit, runFile, memory, env, datasets, apiKey, model, ledger, installPackage }) {
    this.config = config;
    this.baseUrl = baseUrl;
    // For hosted providers (DeepSeek): bearer key + explicit model id. null for local.
    this.apiKey = apiKey || null;
    this.model = model || null;
    this.emit = emit; // (event, payload) => void
    // (filePath, { timeoutMs, clear, stdin }) => Promise<{ code, images, stderr, stdout,
    // timedOut, durationMs }>; streams run:* events to the console.
    this.runFile = runFile;
    this.memory = memory || null; // ContextMemory | null (optional; tests omit it)
    this.env = env || null; // detected environment { python, libs:[...] } | null
    this.datasets = datasets || null; // prebuilt data-context block (string) | null
    // (pipName) => Promise<boolean>. Installs a missing, allowlisted package so a program
    // that only lacked a common library runs without the user stepping in. null = never.
    this.installPackage = installPackage || null;
    // Problem-aware repair memory: which failures have been seen, and which fixes were
    // already tried against them. Injected for tests; otherwise per-project on disk.
    this.ledger = ledger || (config.workspaceDir ? new ProblemLedger(config.workspaceDir) : null);
    this.abort = null;
    this.running = false;
    this.code = '';
    this.filePath = path.join(config.workspaceDir, 'main.py');
    // Repo mode working set: the current multi-file project as [{ path, content }] and
    // the relative path of its runnable entry point. Unused in single-file mode.
    this.files = [];
    this.entry = 'main.py';
    this._stagesOpen = new Set();
    this._interactive = false; // is this program meant to read the keyboard?
    this._wantsPlot = false;   // must a successful run produce a figure?
    this._created = null;      // repo paths created since tracking began (review rollback)
  }

  // True when the agent should emit a multi-file project rather than a single main.py.
  // Driven by config.agentOutputMode ('single' | 'repo'); defaults to single.
  _repoMode() {
    return (this.config && this.config.agentOutputMode) === 'repo';
  }

  // Library guidance for the model, grounded in what is actually importable. Lists the
  // detected frameworks (so the agent knows torch/tensorflow/etc. are usable) and gives
  // ML-appropriate run guidance. Falls back to LIB_NOTE before detection completes.
  _libNote() {
    const libs = this.env && Array.isArray(this.env.libs) ? this.env.libs.filter((l) => l.installed) : null;
    if (!libs || !libs.length) return LIB_NOTE;
    const names = libs.map((l) => l.name + (l.version ? ' ' + l.version : ''));
    const hasDL = libs.some((l) => ['torch', 'tensorflow', 'jax', 'keras'].includes(l.name));
    return (
      `You may use any installed Python library as well as the standard library. Installed in this ` +
      `environment: ${names.join(', ')}.` +
      (hasDL
        ? ' For deep learning use an installed framework (torch / tensorflow / jax). Keep demo runs fast and ' +
          'deterministic: small models, few epochs, modest data, set random seeds, and pick the device ' +
          'sensibly (CUDA/MPS if available else CPU).'
        : '') +
      ' For plots, matplotlib runs headless — call plt.show() or plt.savefig(...) and Cicada captures the figure ' +
      'into the Render panel. Do not start servers, GUIs, long-running training without a small iteration cap, ' +
      'or blocking input().'
    );
  }

  // The persistent context-memory block (memory + unresolved failures from earlier runs),
  // or '' when there is nothing remembered yet.
  _memoryBlock() {
    const parts = [];
    if (this.memory) {
      const block = this.memory.render();
      if (block) parts.push(block);
    }
    // Unresolved failures from earlier runs. Carrying these into prompts is what lets the
    // agent plan around a problem it has already hit — rather than rediscovering the same
    // dead end each session and repeating fixes that are known not to work.
    if (this.ledger) {
      const known = this.ledger.renderKnownIssues(5);
      if (known) parts.push(known);
    }
    return parts.length ? parts.join('\n\n') + '\n\n' : '';
  }

  // The uploaded-data context block (schemas + load hints for the project's CSV/Excel/JSON
  // files), capped to a share of the context window so it cannot crowd out the answer.
  _datasetBlock() {
    if (!this.datasets) return '';
    const cap = Math.max(1500, Math.round((this.config.contextSize || 8192) * 3.5 * 0.12));
    return this.datasets.length > cap ? this.datasets.slice(0, cap) + '\n…(data summary truncated)' : this.datasets;
  }

  // The context prepended to a prompt:
  //   'full'   memory + known issues + data  (working on the existing program)
  //   'create' pinned facts + data           (a brand-new program: the previous program's
  //                                           summary and failures would only mislead it)
  //   'data'   data only                     (repairs: the failure itself is the context)
  //   'none'
  _contextBlock(kind) {
    if (kind === 'none') return '';
    const parts = [];
    if (kind === 'full') {
      const mem = this._memoryBlock().trim();
      if (mem) parts.push(mem);
    } else if (kind === 'create' && this.memory && this.memory.renderFacts) {
      const facts = this.memory.renderFacts();
      if (facts) parts.push(facts);
    }
    const data = this._datasetBlock();
    if (data) parts.push(data);
    return parts.length ? parts.join('\n\n') + '\n\n' : '';
  }

  // Record an activity event + optional summary into persistent memory and notify the UI.
  _remember(kind, text, summary) {
    if (!this.memory) return;
    try {
      if (summary) this.memory.setSummary(summary);
      this.memory.record(kind, text);
      this.emit('memory:update', this.memory.snapshot());
    } catch (_) { /* memory is best-effort, never fatal */ }
  }

  // A library that is genuinely missing (and was not installed automatically): surface the
  // exact pip command and let the UI offer a one-click install.
  _reportMissing(miss, note) {
    const cmd = pipCommand(this.config.pythonPath, miss.pkg);
    note(`\n⚠ Missing dependency: the program imports "${miss.module}", which is not installed in this environment.\n` +
      `Install it, then re-run:\n    ${cmd}\n`);
    this.emit('pipeline:missingModule', { module: miss.module, pkg: miss.pkg, command: cmd });
    this._remember('run', `Needs dependency "${miss.module}" — install with: pip install ${miss.pkg}`);
  }

  cancel() {
    // Only abort: `running` is cleared by _execute once the cancelled body has actually
    // unwound. Clearing it here let a new request start while the old one was still
    // running, and both then wrote the same files.
    if (this.abort) this.abort.abort();
  }

  // True once the run has been cancelled (Stop/Cancel pressed — cancel() aborts the signal).
  _aborted() { return !!(this.abort && this.abort.signal.aborted); }

  // Clean terminal "stopped by the user" finish for a run that was cancelled mid-execution.
  // `extra` lets repo mode attach entry/files to the done event.
  _stoppedDone(compiled, extra) {
    this._done('run', 'Stopped by the user.');
    this.emit('pipeline:done', Object.assign(
      { code: this.code, path: this.filePath, compiled: compiled == null ? null : compiled, exit: null, cancelled: true },
      extra || {}
    ));
  }

  _writeCode(code) {
    this.code = code;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, code, 'utf8');
    } catch (err) {
      this.emit('pipeline:log', `Failed to write code: ${err.message}`);
    }
    this.emit('pipeline:code', { code, path: this.filePath });
  }

  // ---- Stage cards ------------------------------------------------------------

  _open(id, name) {
    if (this._stagesOpen.has(id)) return;
    this._stagesOpen.add(id);
    this.emit('stage:start', { id, name: name || STAGE_NAMES[id] || id });
  }

  _note(id, text) {
    this._open(id);
    this.emit('stage:delta', { id, kind: 'answer', text });
  }

  _done(id, answer) {
    this._open(id);
    this.emit('stage:done', { id, thinking: '', answer });
  }

  // ---- Repo (multi-file) helpers ----------------------------------------------

  // Write every file of a repo to disk under the workspace, pick/keep the entry point,
  // and surface it to the UI: the entry's content streams into the editor (pipeline:code)
  // and the renderer refreshes its file tree (pipeline:files). Path safety is enforced by
  // projects.resolveInProject (no absolute paths, no '..' escape). Returns the entry path.
  _writeFiles(files, entry) {
    const dir = this.config.workspaceDir;
    fs.mkdirSync(dir, { recursive: true });
    const written = [];
    for (const f of files) {
      try {
        const content = f.content.endsWith('\n') ? f.content : f.content + '\n';
        const abs = projects.resolveInProject(dir, f.path); // guards traversal
        const existed = fs.existsSync(abs);
        projects.writeFile(dir, f.path, content);
        if (!existed && this._created) this._created.add(f.path);
        written.push(f.path);
      } catch (err) {
        this.emit('pipeline:log', `Skipped ${f.path}: ${err.message}`);
      }
    }
    this.files = files.filter((f) => written.includes(f.path));
    const chosen = (entry && this.files.find((f) => f.path === entry)) ||
      this.files.find((f) => f.path === pickEntry(this.files)) || this.files[0];
    this.entry = chosen ? chosen.path : (entry || 'main.py');
    this.filePath = projects.resolveInProject(dir, this.entry);
    this.code = chosen ? chosen.content : '';
    this.emit('pipeline:code', { code: this.code, path: this.filePath });
    this.emit('pipeline:files', { entry: this.entry, paths: written, root: dir });
    return this.entry;
  }

  // How much of the project to show the model, in characters: ~40% of the window, so the
  // majority stays available for writing complete files back, with a small floor so tiny
  // contexts still see something.
  _repoBudgetChars() {
    const ctx = this.config.contextSize || 8192;
    return Math.max(6000, Math.round(ctx * 3.5 * 0.4));
  }

  // A path-labelled, fenced concatenation of the repo for prompts, capped to `budget`
  // characters (truncating individual files) so a large project still fits the context
  // window. Mirrors the format the model is asked to emit, so round-trips read naturally.
  _repoContext(files, budget) {
    budget = budget || this._repoBudgetChars();
    let used = 0;
    const parts = [];
    for (const f of files) {
      const lang = /\.py$/i.test(f.path) ? 'python' : '';
      const header = `### ${f.path}\n\`\`\`${lang}\n`;
      const footer = '\n```\n\n';
      const overhead = header.length + footer.length;
      if (used + overhead >= budget) break;
      const bodyRoom = budget - used - overhead;
      const body = f.content.length > bodyRoom ? f.content.slice(0, bodyRoom) + '\n# … (truncated)' : f.content;
      parts.push(header + body + footer);
      used += header.length + body.length + footer.length;
    }
    return parts.join('');
  }

  // Read the active project off disk as [{ path, content }] (text/code files only, noise
  // and the run harness excluded).
  _readRepoFromDisk() {
    const dir = this.config.workspaceDir;
    const exts = new Set(['.py', '.txt', '.md', '.cfg', '.toml', '.ini', '.json', '.yaml', '.yml']);
    const out = [];
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.type === 'dir') { if (n.path !== 'data') walk(n.children); continue; }
        if (n.name.startsWith('_garm_')) continue;
        // Uploaded datasets live in data/ — the agent gets their schema via _datasetBlock(),
        // so don't also dump raw data files into the repo source context.
        if (n.path.startsWith('data/')) continue;
        if (!exts.has(path.extname(n.name).toLowerCase())) continue;
        try {
          const abs = projects.resolveInProject(dir, n.path);
          if (fs.statSync(abs).size > 128 * 1024) continue;
          out.push({ path: n.path, content: fs.readFileSync(abs, 'utf8') });
        } catch (_) { /* unreadable — skip */ }
      }
    };
    try { walk(projects.tree(dir)); } catch (_) { /* tree unreadable */ }
    return out;
  }

  // Merge model-returned files over the current repo (the model may return only the files
  // it changed). A returned file that would COLLAPSE a substantial existing file into a
  // stub is rejected — the same guard that protects single-file fixes — so a bad rewrite
  // never silently guts a working module.
  _mergeFiles(base, updates) {
    const order = [];
    const map = new Map();
    for (const f of base) { if (!map.has(f.path)) order.push(f.path); map.set(f.path, f.content); }
    for (const u of updates) {
      const old = map.get(u.path);
      if (old != null && this._isDegenerateRewrite(old, u.content)) continue;
      if (!map.has(u.path)) order.push(u.path);
      map.set(u.path, u.content);
    }
    return order.map((p) => ({ path: p, content: map.get(p) }));
  }

  // Compile-check every Python file of the current repo.
  _compileRepo() {
    const dir = this.config.workspaceDir;
    const pyFiles = this.files
      .filter((f) => /\.py$/i.test(f.path))
      .map((f) => projects.resolveInProject(dir, f.path));
    return python.compileCheckFiles({ pythonPath: this.config.pythonPath, files: pyFiles });
  }

  // Undo files a rejected repo edit created (tracked by _writeFiles while _created is set).
  _removeCreated() {
    if (!this._created || !this._created.size) return;
    const dir = this.config.workspaceDir;
    for (const rel of this._created) {
      try { fs.unlinkSync(projects.resolveInProject(dir, rel)); } catch (_) { /* already gone */ }
    }
    this._created = null;
    this.emit('pipeline:files', { entry: this.entry, paths: this.files.map((f) => f.path), root: dir });
  }

  // Count lines that hold real code (not blank, not comment-only).
  _meaningfulLines(code) {
    let n = 0;
    for (const line of String(code || '').split('\n')) {
      if (line.replace(/#.*$/, '').trim()) n += 1;
    }
    return n;
  }

  // True when a "fix"/"repair" has COLLAPSED the program — the model returned a tiny
  // fragment instead of the complete corrected file. Auto-repair must never overwrite a
  // substantial program with such a stub. A genuine bug fix keeps almost all of the file,
  // so losing more than half its lines means the rewrite failed, not fixed.
  _isDegenerateRewrite(oldCode, newCode) {
    const oldN = this._meaningfulLines(oldCode);
    const newN = this._meaningfulLines(newCode);
    if (oldN < 12) return false;            // tiny programs: nothing worth protecting
    return newN < Math.max(6, oldN * 0.5);  // lost more than half the program → reject
  }

  // ---- Model calls --------------------------------------------------------------

  // Completion-token budget for a code-producing call: as much of the context window as
  // remains after the prompt (tokens approximated as chars/3.5; code is symbol-dense), up
  // to config.maxTokens. llama-server accepts a budget larger than what remains and simply
  // stops at the window's end, so the floor is safe.
  _codeBudget(messages) {
    const chars = messages.reduce((n, m) => n + (m && m.content ? m.content.length : 0), 0);
    const promptTokens = Math.ceil(chars / 3.5);
    const room = this.config.contextSize - promptTokens - 256; // leave a small safety margin
    const ceiling = this.config.maxTokens || this.config.contextSize;
    const budget = Math.max(1024, Math.min(room, ceiling, this.config.contextSize));
    // Kept so a truncation can be explained with real numbers.
    this.lastBudget = { promptTokens, room, budget, contextSize: this.config.contextSize };
    return budget;
  }

  // Why generation ran out of room, in concrete terms.
  _budgetHelp() {
    const b = this.lastBudget;
    if (!b) return 'Raise Context size in Settings, or narrow the request.';
    const n = (v) => Math.max(0, v).toLocaleString();
    const parts = [
      `The prompt used roughly ${n(b.promptTokens)} of the ${n(b.contextSize)}-token context, leaving about ${n(b.room)} for the answer.`,
    ];
    if (b.room < 2048) parts.push('That is too little room to write out a complete program.');
    parts.push('Raise Context size in Settings (it takes effect immediately), or narrow the request.');
    return parts.join(' ');
  }

  // The prompt itself does not fit, even trimmed.
  _overflowHelp(err) {
    const ctx = err.nCtx || this.config.contextSize || 8192;
    const need = err.nPrompt;
    let suggest = 4096;
    while (suggest < (need ? need * 1.8 : ctx * 2)) suggest *= 2;
    return `The request is too large for the model's context window` +
      (need ? ` (the prompt alone needs about ${need.toLocaleString()} tokens; the window holds ${ctx.toLocaleString()})` : '') +
      `. Raise Context size in Settings (try ${suggest.toLocaleString()}), or work on a smaller part of the project.`;
  }

  // Note streamed into a stage's answer panel when a transient LLM failure is retried,
  // so the user sees the recovery instead of a silent stall.
  _retryNote(id, attempt, err) {
    this.emit('stage:delta', {
      id, kind: 'answer',
      text: `\n⟳ Connection to the model dropped (${(err && err.message) || 'transient error'}) — retrying (attempt ${attempt})…\n`,
    });
  }

  /**
   * Every model call goes through here. Streams the answer, routes reasoning and answer
   * text to a stage card, live-streams code into the editor, retries transient failures,
   * and — when the prompt does not fit the context window — retries once with the optional
   * context dropped and any project dump shrunk to fit.
   *
   *   id, name     the stage card this call reports on (notes and retries go here)
   *   stage        true: emit stage:start / deltas / stage:done for the card
   *   keepOpen     with stage: leave the card running (the caller finishes it)
   *   prompt       a string, or ({ scale }) => string where scale < 1 asks for a smaller dump
   *   context      'full' | 'create' | 'data' | 'none'  (see _contextBlock)
   *   live         null | 'code' | 'files' | (snippet) => full-file preview
   *   maxTokens    explicit completion cap (analysis stages); code calls size to the window
   * Returns { thinking, answer, full, finishReason }.
   */
  async _llm(opts) {
    const { id, name, stage = false, keepOpen = false, context = 'full' } = opts;
    if (stage) { this._stagesOpen.add(id); this.emit('stage:start', { id, name: name || STAGE_NAMES[id] || id }); }
    let scale = 1;
    let lean = false;
    for (let attempt = 0; ; attempt++) {
      const prompt = typeof opts.prompt === 'function' ? opts.prompt({ scale }) : opts.prompt;
      const messages = [
        { role: 'system', content: SYS },
        { role: 'user', content: (lean ? '' : this._contextBlock(context)) + prompt },
      ];
      try {
        const res = await this._streamOnce(messages, opts);
        if (stage && !keepOpen) this.emit('stage:done', { id, thinking: res.thinking, answer: res.answer });
        return res;
      } catch (err) {
        if (err && err.code === 'context_overflow' && attempt === 0 && !this._aborted()) {
          lean = true;
          scale = err.nPrompt && err.nCtx ? Math.max(0.15, Math.min(0.6, (err.nCtx * 0.5) / err.nPrompt)) : 0.5;
          if (id) this.emit('stage:delta', { id, kind: 'answer', text: `\n⟳ The prompt did not fit the model's context${err.nPrompt ? ` (${err.nPrompt.toLocaleString()} > ${err.nCtx.toLocaleString()} tokens)` : ''} — retrying with a trimmed prompt…\n` });
          continue;
        }
        const e = err && err.code === 'context_overflow' ? new Error(this._overflowHelp(err)) : err;
        if (id && (stage || this._stagesOpen.has(id))) {
          this.emit('stage:error', { id, message: e && e.name === 'AbortError' ? 'Cancelled.' : e.message });
        }
        throw e;
      }
    }
  }

  async _streamOnce(messages, { id, stage, live, maxTokens }) {
    const budget = maxTokens || this._codeBudget(messages);
    let full = '';
    let tLen = 0;
    let aLen = 0;
    let lastLive = '';
    let lastAt = 0;
    let finishReason = null;
    if (live) this.emit('pipeline:code-stream-start', {});
    const onDelta = () => {
      if (live) {
        const now = Date.now();
        if (now - lastAt > 60) {
          let preview = '';
          if (live === 'files') preview = extractFilesStreaming(full);
          else {
            const snippet = extractCodeStreaming(answerStream(full));
            if (typeof live === 'function') { if (snippet) { try { preview = live(snippet); } catch (_) { preview = ''; } } }
            else preview = snippet;
          }
          if (preview && preview !== lastLive) { lastLive = preview; lastAt = now; this.emit('pipeline:code-live', { code: preview }); }
        }
      }
      if (!stage) return;
      const { thinking, answer } = splitThinking(full);
      const closed = /<\/think>/i.test(full);
      const tShown = closed ? thinking : thinking.slice(0, Math.max(0, thinking.length - 12));
      if (tShown.length > tLen) {
        this.emit('stage:delta', { id, kind: 'thinking', text: tShown.slice(tLen) });
        tLen = tShown.length;
      }
      if (answerStreamable(full) && answer.length > aLen) {
        this.emit('stage:delta', { id, kind: 'answer', text: answer.slice(aLen) });
        aLen = answer.length;
      }
    };
    try {
      const text = await streamChatResilient(this.baseUrl, {
        messages,
        temperature: this.config.temperature,
        topP: this.config.topP,
        model: this.model, apiKey: this.apiKey,
        maxTokens: budget,
        signal: this.abort.signal,
        onMeta: (m) => { finishReason = m.finishReason; },
        onDelta: (chunk) => { full += chunk; onDelta(); },
        // A retry restarts the stream from scratch — reset the accumulators so the
        // second attempt's deltas don't misalign against the first attempt's text.
        onRetry: (attempt, err) => { full = ''; tLen = 0; aLen = 0; lastLive = ''; if (id) this._retryNote(id, attempt, err); },
      });
      const { thinking, answer } = splitThinking(text);
      return { thinking, answer, full: text, finishReason };
    } finally {
      if (live) this.emit('pipeline:code-stream-end', {});
    }
  }

  // A reported analysis/code stage (evaluate, design, plan, …).
  _stage(id, name, prompt, opts = {}) {
    return this._llm({ id, name, prompt, stage: true, ...opts });
  }

  // Run a code-producing stage and, if the model returned NO usable code (the most common
  // small-model failure: prose instead of a fenced block), re-ask ONCE with a firmer
  // instruction. Truncation (finishReason 'length') is not re-asked — a longer answer needs
  // a bigger budget, not a sterner prompt. Returns { res, out }.
  async _stageWithReask(id, name, prompt, opts, extract) {
    let res = await this._stage(id, name, prompt, opts);
    let out = extract(res);
    const empty = (v) => !v || (Array.isArray(v) && !v.length);
    if (empty(out) && res.finishReason !== 'length' && !this._aborted()) {
      this.emit('stage:delta', { id, kind: 'answer', text: '\n⟳ No usable code block came back — asking the model once more…\n' });
      const again = typeof prompt === 'function' ? (o) => prompt(o) + REASK : prompt + REASK;
      res = await this._stage(id, name, again, opts);
      out = extract(res);
    }
    return { res, out };
  }

  // What a repair is told about the failure it is fixing.
  _feedback(failure) {
    if (failure.phase === 'compile') {
      return `The code fails to compile. Fix the error.\n\nCOMPILER OUTPUT:\n${tail(relativize(failure.output, this.config.workspaceDir), 1600)}`;
    }
    if (failure.phase === 'review') {
      return 'Apply this review feedback. Keep everything that already works — change only what the review ' +
        `asks for.\n\nREVIEW:\n${failure.output}`;
    }
    // _failureText already bounds each section, so this cap only guards pathological output
    // (and, being a tail, would cut the summary last).
    return 'The program compiles but does not run successfully. Fix the ERROR shown below at its ROOT CAUSE ' +
      `(do not just silence it).\n\nRUN RESULT:\n${tail(failure.output, 4000)}`;
  }

  // One single-file repair turn. `history` is the ledger's account of what has ALREADY been
  // tried against this exact failure — the difference between a problem-aware repair and
  // a blind retry that re-proposes a fix which just failed.
  async _askFix({ request, code, failure, history, card }) {
    const hist = history ? `\n\n${history}` : '';
    const prompt = `Fix the Python program. Output EXACTLY ONE \`\`\`python code block with the complete corrected program. No prose outside the code block. ${this._libNote()}\n\nREQUEST:\n${request}\n\nCURRENT CODE:\n\`\`\`python\n${code}\n\`\`\`\n\n${this._feedback(failure)}${hist}\n\n${BRIEF_THINK}`;
    const res = await this._llm({ id: card, prompt, live: 'code', context: 'data' });
    return extractCode(res.answer) || extractCode(res.full) || null;
  }

  // ---- Verification ---------------------------------------------------------------

  // One verification run of `prog.entry`, classified for the repair loop. Programs run with
  // stdin closed (input() fails at once instead of hanging until the watchdog), any non-zero
  // exit is a failure (argparse errors and sys.exit(1) used to pass as success), and a
  // missing module is sorted into install / report / repair instead of always stopping.
  async _verifyRun(prog, { request, first, note }) {
    for (let installs = 0; ; installs++) {
      const launched = Date.now();
      const r = await this.runFile(prog.entry, {
        timeoutMs: this.config.runTimeoutMs || 600000,
        clear: first && installs === 0,
        stdin: 'eof',
      });
      const base = {
        ok: false, phase: 'runtime', exit: r.code, images: r.images || [],
        stdout: r.stdout || '', stderr: r.stderr || '', durationMs: r.durationMs || 0,
      };
      if (this._aborted()) return { ...base, stop: 'aborted', output: '' };
      if (r.code === 0) {
        const hollow = this._hollowRun(r, launched);
        return hollow ? { ...base, output: hollow } : { ...base, ok: true, output: '' };
      }

      const miss = python.missingModule(r.stderr);
      if (miss) {
        const action = this._missingAction(miss, request, prog);
        if (action === 'install') {
          const pkg = python.autoInstallPkg(miss.module);
          if (this.installPackage && installs < 3) {
            note(`\n📦 "${miss.module}" is not installed — installing ${pkg}…\n`);
            const installed = await this.installPackage(pkg);
            if (this._aborted()) return { ...base, stop: 'aborted', output: '' };
            if (installed) { note(`Installed ${pkg} — running again.\n`); continue; }
            note(`Could not install ${pkg} automatically.\n`);
          }
        }
        if (action === 'repair') {
          return { ...base, output: this._failureText(r) + '\n\n' + this._missingGuidance(miss, prog) };
        }
        this._reportMissing(miss, note);
        return { ...base, stop: 'missing', missing: miss, output: this._failureText(r) };
      }

      if (/EOFError: EOF when reading a line/.test(r.stderr || '')) {
        if (this._interactive) return { ...base, stop: 'interactive', output: this._failureText(r) };
        return {
          ...base,
          output: this._failureText(r) + '\n\nNOTE: the program called input(), but it runs unattended with no ' +
            'keyboard, and the request does not ask for an interactive program. Remove the input() calls and use ' +
            'sensible default or example values instead.',
        };
      }
      if (r.timedOut) {
        return {
          ...base,
          output: 'The program hung: it produced no output and used no CPU for a long time, so it was stopped ' +
            '(a deadlock, an endless wait, or a blocking call). Make it finish on its own.\n\n' + this._failureText(r),
        };
      }
      return { ...base, output: this._failureText(r) };
    }
  }

  // A run that exited 0 but did not do its job, judged deterministically from what it
  // produced — far more reliable than asking a small model to notice. Returns the failure
  // text for the repair, or null when the run looks genuine.
  _hollowRun(r, launched) {
    const images = (r.images || []).length;
    // stdout, or stderr that is more than warnings: the `logging` module reports on stderr.
    const printed = (String(r.stdout || '').trim() + '\n' + describeFailure(r.stderr, this.config.workspaceDir).traceback).trim();
    if (this._wantsPlot && !images) {
      return 'The program exited normally (exit code 0) but produced NO figure, although the request asks for ' +
        'a plot. Make sure the plotting code actually runs when the entry point is executed (is it called?) ' +
        'and that it ends with plt.show() or plt.savefig(...).' +
        (printed ? `\n\nSTDOUT (last lines):\n${tail(printed, 800)}` : '');
    }
    // Files written since the run began are output; main.py itself was written before it.
    const since = r.startedAtMs || launched;
    if (!images && !printed && !wroteFilesSince(this.config.workspaceDir, since)) {
      return 'The program exited normally (exit code 0) but did nothing observable: it printed nothing and wrote ' +
        'no files or figures. The entry point probably never runs the main logic — for example it only imports a ' +
        'module whose work sits behind that module\'s own `if __name__ == "__main__":` guard, or it defines ' +
        'functions without calling them. Make running the entry point actually do the work and print its results.';
    }
    return null;
  }

  _failureText(r) {
    const exit = r.code == null ? `killed by signal ${r.signal || 'unknown'}` : `exit code ${r.code}`;
    const f = describeFailure(r.stderr, this.config.workspaceDir);
    const out = tail(r.stdout, f.traceback ? 400 : 1200).trim();
    // The traceback goes LAST so its exception line ends the text — that is what the ledger
    // fingerprints. The summary goes first, where a small model actually looks.
    return `The program failed (${exit}).` +
      (f.summary ? `\n\n${f.summary}` : '') +
      (out ? `\n\nSTDOUT (last lines):\n${out}` : '') +
      (f.warnings ? `\n\nWARNINGS (printed before the failure — usually NOT its cause):\n${tail(f.warnings, 400)}` : '') +
      (f.traceback ? `\n\nTRACEBACK:\n${tail(f.traceback, 1600)}` : '');
  }

  // Is the missing module one of the project's own? Then it is an import bug, not a package.
  _isLocalModule(mod, prog) {
    const top = String(mod || '').split('.')[0];
    if (!top) return false;
    const here = (dir) => fs.existsSync(path.join(dir, top + '.py')) || isDir(path.join(dir, top));
    if (here(this.config.workspaceDir)) return true;
    if (prog && prog.entry && here(path.dirname(prog.entry))) return true;
    if (prog && Array.isArray(prog.code)) return prog.code.some((f) => f.path === top + '.py' || f.path.split('/')[0] === top);
    return false;
  }

  // install: a common package the agent may add itself.
  // report:  a real package the user should choose to install (heavy, or asked for by name).
  // repair:  a code bug — a local import that does not resolve, or a module that is neither
  //          installed, well known, nor requested (typically one the model invented). Asking
  //          the user to `pip install` such a name was both useless and risky.
  _missingAction(miss, request, prog) {
    if (this._isLocalModule(miss.module, prog)) return 'repair';
    if (this.config.autoInstallDeps !== false && python.autoInstallPkg(miss.module)) return 'install';
    if (python.isKnownPackage(miss.module)) return 'report';
    if (new RegExp('\\b' + escapeRe(miss.module) + '\\b', 'i').test(String(request || ''))) return 'report';
    return 'repair';
  }

  _missingGuidance(miss, prog) {
    if (this._isLocalModule(miss.module, prog)) {
      return `NOTE: "${miss.module}" is part of this project, but the import cannot find it. Fix the import so it ` +
        'resolves when the program is run from the project root (imports rooted at the project, e.g. ' +
        '"from pkg.module import name", with an __init__.py in every package directory).';
    }
    if (Array.isArray(prog && prog.code)) {
      return `NOTE: "${miss.module}" is not an installed library and is not part of this project. If it is meant ` +
        "to be one of the project's own modules, create it (return its complete file); otherwise remove the " +
        'dependency and implement what is needed directly.';
    }
    return `NOTE: "${miss.module}" is not an installed library and is not part of this project — do not import it. ` +
      'Implement what is needed directly, or use the standard library or an installed package.';
  }

  /**
   * Compile -> run -> repair until the program works, the budget is spent, or repairs stop
   * making progress (see repair-loop.js). `prog` adapts one program shape:
   *   code, entry (absolute path to run), write(code), compile() -> { ok, output },
   *   repair({ code, failure, history, card }) -> code | { rejected } | null, describe(a, b)
   * Compile problems before the program first compiles are reported on the fix card;
   * everything from the first run onward on the run card. `quiet` reports only notes.
   * Returns the loop result plus { compiled, lastRun }.
   */
  async _verify(request, prog, opts = {}) {
    const fixId = opts.fixStage || 'fix';
    const runId = opts.runStage || 'run';
    const quiet = !!opts.quiet;
    let compiledOnce = false;
    let ran = false;
    let lastRun = null;
    let compileFixes = 0;
    const card = () => (ran ? runId : fixId);
    const note = (text) => this._note(card(), text);
    if (!quiet) this._open(fixId);

    const loop = await runRepairLoop({
      code: prog.code,
      ledger: this.ledger,
      maxCompile: opts.maxCompile != null ? opts.maxCompile : this.config.maxFixIterations,
      maxRuntime: opts.maxRuntime != null ? opts.maxRuntime : this.config.maxFixIterations,
      aborted: () => this._aborted(),
      note,
      describe: prog.describe || describeChange,
      write: (c) => prog.write(c),
      check: async () => {
        const comp = await prog.compile();
        if (!comp.ok) {
          note(`Compile: FAILED\n${tail(comp.output, 600)}\n`);
          return { ok: false, phase: 'compile', output: comp.output };
        }
        if (!compiledOnce) {
          compiledOnce = true;
          if (!quiet) this._done(fixId, `Code compiles cleanly${compileFixes ? ` after ${compileFixes} fix iteration(s)` : ''}.`);
        }
        ran = true;
        if (!quiet) this._open(runId);
        const r = await this._verifyRun(prog, { request, first: !lastRun && !opts.rerun, note });
        lastRun = r;
        return r;
      },
      repair: async (args) => {
        if (args.failure.phase === 'compile') { if (!ran) compileFixes += 1; note(`\nFixing the syntax error (attempt ${args.attempt})…\n`); }
        else note(`\nThe run failed — repairing (attempt ${args.attempt})…\n`);
        return prog.repair({ ...args, card: card() });
      },
    });

    // Once any version compiled, the loop never ends on one that does not (it restores the
    // best version), so "compiled" and "compiled at least once" coincide.
    const compiled = loop.ok || loop.result.phase !== 'compile';
    if (!quiet && !this._aborted()) {
      if (!compiledOnce) {
        this._done(fixId, `Code still has syntax errors after ${loop.repairs.compile} fix attempt(s)` +
          `${loop.stopReason === 'stuck' ? ' — the same error kept recurring' : ''}.\n${tail(loop.result.output, 800)}`);
        this._done(runId, 'Skipped — the code does not compile.');
      } else {
        this._done(runId, this._runSummary(loop, lastRun));
      }
    }
    return { ...loop, compiled, lastRun };
  }

  _runSummary(loop, run) {
    const res = loop.result;
    const images = run && run.images && run.images.length ? ` Rendered ${run.images.length} image(s).` : '';
    const reps = loop.repairs.runtime ? ` after ${loop.repairs.runtime} repair(s)` : '';
    if (res.ok) return `Ran successfully${reps} (exit 0).${images}`;
    if (res.stop === 'interactive') {
      return 'The program waits for keyboard input, so it cannot be checked unattended. It compiles and starts ' +
        'correctly — it is now running interactively: type your input into the stdin box below the console.';
    }
    if (res.stop === 'missing' && res.missing) {
      return `Needs the "${res.missing.module}" package, which is not installed. Install it (Env tab, or:\n    ` +
        `${pipCommand(this.config.pythonPath, res.missing.pkg)}\n) and press Run.`;
    }
    const exit = run ? (run.exit == null ? 'a signal' : `code ${run.exit}`) : 'an error';
    const why = loop.stopReason === 'stuck' ? ' The same error kept recurring, so repair stopped early.'
      : loop.stopReason === 'budget' ? ' The repair budget ran out.' : '';
    const kept = loop.restored ? ' Kept the version that got furthest.' : '';
    const last = String(res.output || '').trim().split('\n').filter(Boolean).pop() || '';
    return `Process exited with ${exit}${reps}.${images}${why}${kept}${last ? `\n${last}` : ''}`;
  }

  // Execution-first review: only a program that runs is reviewed, against its real output.
  // Review edits are re-verified and rolled back if they break the working program, so the
  // review can improve the result but never make it worse.
  async _review(request, prog, verified) {
    const id = 'review';
    if (this._aborted()) return verified;
    if (!verified.ok) {
      this._done(id, verified.result && verified.result.stop === 'interactive'
        ? 'Skipped — an interactive program cannot be checked unattended.'
        : verified.compiled
          ? 'Skipped — the program does not run successfully yet, so there is no working output to review.'
          : 'Skipped — the code does not compile.');
      return verified;
    }
    const run = verified.lastRun || {};
    if (run.durationMs > REVIEW_MAX_RUN_MS) {
      this._done(id, 'Skipped — the program already runs cleanly, and it takes long enough that re-running it to check review edits is not worth the wait.');
      return verified;
    }

    const code = verified.code;
    const repo = Array.isArray(code);
    const imgs = run.images && run.images.length ? `, and wrote ${run.images.length} image file(s): ${run.images.map((p) => path.basename(p)).join(', ')}` : '';
    const output = tail(run.stdout, 1500).trim();
    const res = await this._llm({
      id, name: 'Review', stage: true, keepOpen: true, maxTokens: 1024, context: 'data',
      prompt: ({ scale }) =>
        'Check this Python program against the request, using the ACTUAL output of a real run shown below. ' +
        'Report ONLY definite problems: a bug, or behaviour/output that does not do what the request asks ' +
        '(for example a missing plot, a wrong count, wrong values, or a requested feature that is missing). ' +
        'Do NOT report style, naming, comments, missing error handling, performance, or optional improvements. ' +
        'If the program does what was asked, output exactly: NO ISSUES. Otherwise output a short numbered list ' +
        'of the concrete problems. Do NOT rewrite the code.\n\n' +
        `REQUEST:\n${request}\n\n` +
        (repo ? `PROJECT (entry: ${this.entry}):\n${this._repoContext(code, Math.round(this._repoBudgetChars() * scale))}\n\n`
          : `CODE:\n\`\`\`python\n${code}\n\`\`\`\n\n`) +
        `RUN RESULT: exit 0${imgs}.\nOUTPUT (stdout${output ? ', last lines' : ''}):\n${output || '(no output)'}`,
    });
    const text = (res.answer || '').trim();
    if (!text || /\bno issues\b/i.test(text)) {
      this._done(id, 'NO ISSUES — the program runs and does what was asked.');
      return verified;
    }

    this._note(id, '\n\nApplying the review and re-checking…\n');
    this._created = repo ? new Set() : null;
    const fixed = await prog.repair({ code, failure: { phase: 'review', output: text }, history: '', card: id });
    if (this._aborted()) return verified;
    const describe = prog.describe || describeChange;
    if (!fixed || fixed.rejected || /no change/.test(describe(code, fixed))) {
      this._created = null;
      this._done(id, `${text}\n\n— Could not turn the review into a clean edit, so the working version was kept.`);
      return verified;
    }
    await prog.write(fixed);
    const re = await this._verify(request, { ...prog, code: fixed }, {
      quiet: true, fixStage: id, runStage: id, maxCompile: 1, maxRuntime: 1, rerun: true,
    });
    if (this._aborted()) return re;
    if (re.ok) {
      this._created = null;
      this._done(id, `${text}\n\n✓ Applied the review and re-verified — the program still runs (exit 0).`);
      return re;
    }

    // The edit broke a working program: put the verified version back, and re-run it so the
    // console and Render panel show the output of the code that is actually on disk.
    await prog.write(code);
    this._removeCreated();
    this._created = null;
    this._note(id, 'The revised version failed — restoring the working version…\n');
    const back = await this._verifyRun({ ...prog, code }, { request, first: false, note: (t) => this._note(id, t) });
    const why = String(re.result.output || '').trim().split('\n').filter(Boolean).pop() || 'it no longer ran';
    this._done(id, `${text}\n\n↩ Applying the review broke the program (${why}), so the working version was kept.`);
    return { ...verified, lastRun: back };
  }

  // Shared tail for every mode except inpaint: verify -> review -> done.
  async _finish(request, prog, extra) {
    const more = () => (extra ? extra() : {});
    const verified = await this._verify(request, prog);
    if (this._aborted()) return this._stoppedDone(verified.compiled, more());
    const final = await this._review(request, prog, verified);
    if (this._aborted()) return this._stoppedDone(final.compiled, more());

    const res = final.result || {};
    const run = final.lastRun;
    const exit = run ? run.exit : null;
    const last = String(res.output || '').trim().split('\n').filter(Boolean).pop() || '';
    const noun = Array.isArray(prog.code) ? 'Project' : 'Program';
    this._remember('run',
      res.ok ? `${noun} runs cleanly (exit 0).`
        : res.stop === 'interactive' ? `${noun} is interactive (reads keyboard input).`
          : res.stop === 'missing' ? `${noun} needs the "${res.missing.module}" package.`
            : !final.compiled ? `${noun} does not compile.`
              : `${noun} exits with code ${exit}${last ? ` — ${last}` : ''}`);

    this.emit('pipeline:done', Object.assign({
      code: this.code, path: this.filePath, compiled: final.compiled, exit,
      needsInput: res.stop === 'interactive',
      missing: res.stop === 'missing' ? res.missing : null,
    }, more()));
  }

  // Wrap a run: lifecycle, stage declaration, error + cleanup.
  async _execute(stages, mode, request, body) {
    if (this.running) throw new Error('The agent is already working on a request — wait for it to finish, or press Cancel.');
    this.running = true;
    const abort = new AbortController();
    this.abort = abort;
    this._stagesOpen = new Set();
    this._interactive = false;
    this._wantsPlot = false;
    this._created = null;
    this.emit('pipeline:start', { request, mode, stages });
    try {
      await body();
    } catch (err) {
      // A cancel aborts the in-flight fetch (AbortError). It is not a failure, but the
      // renderer still needs a terminal event or it stays stuck in the "running" state.
      if ((err && err.name === 'AbortError') || abort.signal.aborted) {
        this.emit('pipeline:done', { code: this.code, path: this.filePath, cancelled: true, compiled: null, exit: null });
      } else {
        this.emit('pipeline:error', { message: err.message });
      }
    } finally {
      this.running = false;
      if (this.abort === abort) this.abort = null;
    }
  }

  // ---- Program shapes -----------------------------------------------------------

  _singleProgram(request) {
    return {
      code: this.code,
      entry: this.filePath,
      write: (c) => this._writeCode(c),
      compile: () => python.compileCheck({ pythonPath: this.config.pythonPath, file: this.filePath }),
      describe: describeChange,
      repair: async ({ code, failure, history, card }) => {
        const fixed = await this._askFix({ request, code, failure, history, card });
        if (!fixed) return { rejected: 'returned no complete code block' };
        // Guard against the model collapsing the program into a stub: a repair that loses
        // most of the file failed, whatever it claims to fix.
        if (this._isDegenerateRewrite(code, fixed)) return { rejected: 'returned a fragment instead of the complete program' };
        return fixed;
      },
    };
  }

  _repoProgram(request) {
    return {
      code: this.files,
      entry: this.filePath,
      write: (files) => { this._writeFiles(files, this.entry); },
      compile: () => this._compileRepo(),
      describe: (a, b) => describeChange(serializeFiles(a), serializeFiles(b)),
      repair: async ({ code: files, failure, history, card }) => {
        const hist = history ? `\n\n${history}` : '';
        const res = await this._llm({
          id: card, context: 'data',
          prompt: ({ scale }) => `Fix the Python project. ${REPO_EDIT_FORMAT} ${this._libNote()}\n\nREQUEST:\n${request}\n\nCURRENT PROJECT (entry: ${this.entry}):\n${this._repoContext(files, Math.round(this._repoBudgetChars() * scale))}\n\n${this._feedback(failure)}${hist}\n\n${BRIEF_THINK}`,
        });
        const updates = extractFiles(res.answer || res.full);
        if (!updates.length) return { rejected: 'returned no file blocks' };
        return this._mergeFiles(files, updates);
      },
    };
  }

  // ---- Modes ----------------------------------------------------------------------

  // Build a program from scratch. In single-file mode this writes one main.py; in repo
  // mode it writes a whole multi-file project.
  async run(request) {
    const repo = this._repoMode();
    return this._execute(FULL_STAGES, 'create', request, async () => {
      this._interactive = wantsInput(request);
      this._wantsPlot = wantsPlot(request);
      // A new program replaces the old one, so the old one's failures no longer apply.
      if (this.ledger) this.ledger.retireAll('superseded by a new program');
      const evalRes = await this._stage(
        'evaluate', 'Evaluate',
        `Analyze this request for a Python program. Produce a brief structured evaluation with these headings only: Goal, Inputs, Outputs, Constraints, Edge cases, Success criteria. Use short bullets. Do NOT write code.\n\nREQUEST:\n${request}`,
        { maxTokens: 1024, context: 'create' }
      );
      const designLayout = repo
        ? ' Then list the FILES the project should have (project-relative path — one-line purpose each): a root main.py entry point plus only the modules THIS program needs (2–4 files for a small program), and for each module the functions it defines with their parameters.'
        : '';
      const designRes = await this._stage(
        'design', 'System Design',
        `Design a Python solution. Output a concise plan: Approach, Key functions/classes (one line each), Data flow, Libraries.${designLayout} ${this._libNote()} Use short bullets. Do NOT write the full implementation.\n\nREQUEST:\n${request}\n\nEVALUATION:\n${evalRes.answer}`,
        { maxTokens: 1024, context: 'create' }
      );

      if (repo) { await this._generateRepo(request, designRes.answer); return; }

      const gen = await this._stageWithReask(
        'generate', 'Generate Code',
        `Implement the program. Output EXACTLY ONE \`\`\`python code block containing a complete, runnable, self-contained program. No prose outside the code block. ${this._libNote()} Include an \`if __name__ == "__main__":\` entry point. It must run to completion with no command-line arguments${this._interactive ? '' : ' and no keyboard input (do not call input())'}.\n\nREQUEST:\n${request}\n\nDESIGN:\n${designRes.answer}\n\n${BRIEF_THINK}`,
        { live: 'code', context: 'create' },
        (r) => extractCode(r.answer) || extractCode(r.full)
      );
      const code = gen.out;
      if (!code) {
        throw new Error(gen.res.finishReason === 'length'
          ? 'Generate stage was cut off before completing the code block. ' + this._budgetHelp()
          : 'The model did not return usable code after two attempts. Re-run the request, rephrase it more concretely, or switch to a stronger model in Settings.');
      }
      this._writeCode(code);

      // Establish the project in memory: this request becomes the working summary.
      this._remember('create', `Built program for: ${request}`, request);

      await this._finish(request, this._singleProgram(request));
    });
  }

  // Repo-mode Generate: ask for the whole project as path-labelled files, parse them,
  // write them to disk, then verify the project as a unit.
  async _generateRepo(request, design) {
    const gen = await this._stageWithReask(
      'generate', 'Generate Code',
      `Implement the program now. ${REPO_FORMAT} ${this._libNote()} main.py must run to completion with no command-line arguments${this._interactive ? '' : ' and no keyboard input (do not call input())'}.\n\nREQUEST:\n${request}\n\nDESIGN:\n${design}\n\n${BRIEF_THINK}`,
      { live: 'files', context: 'create' },
      (r) => extractFiles(r.answer.length ? r.answer : r.full)
    );
    const files = gen.out;
    if (!files.length) {
      throw new Error(gen.res.finishReason === 'length'
        ? 'Generate stage was cut off before completing the project. ' + this._budgetHelp()
        : 'The model did not return any usable file blocks after two attempts. Re-run, rephrase the request, or switch to a stronger model in Settings.');
    }
    this._writeFiles(files, pickEntry(files));
    this._remember('create', `Built ${files.length}-file project for: ${request} (entry: ${this.entry})`, request);
    await this._finish(request, this._repoProgram(request), () => ({ entry: this.entry, files: this.files.map((f) => f.path) }));
  }

  // Is the program being changed meant to read the keyboard? The change request alone often
  // does not say ("add a square-root button"), so the project summary and the existing code
  // count too — otherwise a refine would "repair" an interactive program into a demo.
  _interactiveFor(text, existingCode) {
    const summary = this.memory && this.memory.data ? this.memory.data.summary : '';
    return wantsInput(text) || wantsInput(summary) || /\binput\s*\(/.test(String(existingCode || ''));
  }

  // Must the changed program still draw a figure? Yes if the change asks for one, or if the
  // program already plots (its summary says so) — unless the change removes the plotting.
  _plotFor(text, existingCode) {
    if (/\b(remove|drop|delete|without|no longer|instead of)\b[^.]{0,40}\b(plot|chart|figure|graph)/i.test(String(text || ''))) return false;
    const summary = this.memory && this.memory.data ? this.memory.data.summary : '';
    return wantsPlot(text) || (wantsPlot(summary) && /\b(plt|matplotlib|seaborn|plotly)\b/.test(String(existingCode || '')));
  }

  // Post-edit agentic iteration: apply a change/addition to the current code. In repo mode
  // the change is applied across the whole project (see _refineRepo); in single-file mode
  // it rewrites the one open file.
  async refine(changeRequest, baseCode) {
    if (this._repoMode()) return this._refineRepo(changeRequest, baseCode);
    return this._execute(REFINE_STAGES, 'refine', changeRequest, async () => {
      const base = String(baseCode || this.code || '').trim();
      if (!base) throw new Error('There is no code to refine yet — generate or write some code first.');
      this._interactive = this._interactiveFor(changeRequest, base);
      this._wantsPlot = this._plotFor(changeRequest, base);
      this._writeCode(base);

      const planRes = await this._stage(
        'plan', 'Plan Change',
        `The user wants to change or extend an existing Python program. Produce a brief plan of the edits: what to add or modify, where, and any new functions or libraries needed. Use short bullets. Do NOT write the full code.\n\nCURRENT CODE:\n\`\`\`python\n${base}\n\`\`\`\n\nREQUESTED CHANGE:\n${changeRequest}`,
        { maxTokens: 1024 }
      );

      const apply = await this._stageWithReask(
        'apply', 'Apply Changes',
        `Apply the requested change to the program. Output EXACTLY ONE \`\`\`python code block with the COMPLETE updated program (not a diff or snippet). Preserve existing working behaviour unless the change requires altering it. ${this._libNote()}\n\nCURRENT CODE:\n\`\`\`python\n${base}\n\`\`\`\n\nREQUESTED CHANGE:\n${changeRequest}\n\nPLAN:\n${planRes.answer}\n\n${BRIEF_THINK}`,
        { live: 'code' },
        (r) => extractCode(r.answer) || extractCode(r.full)
      );
      const code = apply.out;
      if (!code) {
        throw new Error(apply.res.finishReason === 'length'
          ? 'Apply Changes was cut off before completing the program. ' + this._budgetHelp()
          : 'The model did not return updated code after two attempts. Your code is unchanged — re-run or rephrase the change.');
      }
      // The model sometimes returns a fragment instead of the full updated program; don't
      // let that silently replace the user's working code.
      if (this._isDegenerateRewrite(base, code)) {
        throw new Error('Apply Changes returned a much smaller program than the original — the model likely dropped most of it. Your code was kept unchanged; re-run or rephrase the change.');
      }
      this._writeCode(code);
      this._remember('refine', `Change applied: ${changeRequest}`);

      const req = `Apply this change to the program: ${changeRequest}`;
      await this._finish(req, this._singleProgram(req));
    });
  }

  // Repo-mode refine: load the program off disk (overlaying unsaved content from the open
  // editor file), plan the change, apply it as path-labelled files, merge, and verify. The
  // model sees the files the program actually uses — not every file in the folder.
  async _refineRepo(changeRequest, baseCode) {
    return this._execute(REFINE_STAGES, 'refine', changeRequest, async () => {
      const dir = this.config.workspaceDir;
      let files = this._readRepoFromDisk();
      // Honour unsaved edits to the file currently open in the editor.
      const openRel = path.relative(dir, this.filePath).split(path.sep).join('/');
      if (baseCode && baseCode.trim() && openRel && !openRel.startsWith('..')) {
        const existing = files.find((f) => f.path === openRel);
        if (existing) existing.content = baseCode;
        else files.push({ path: openRel, content: baseCode });
      }
      if (!files.length || !files.some((f) => f.content && f.content.trim())) {
        throw new Error('There is no code to refine yet — generate or write some code first.');
      }
      const entry = (files.find((f) => f.path === pickEntry(files)) || files[0]).path;
      const keep = new Set(localImportClosure(files, entry));
      if (files.some((f) => f.path === openRel)) keep.add(openRel);
      for (const f of files) if (/^requirements\.txt$/i.test(f.path)) keep.add(f.path);
      const scoped = files.filter((f) => keep.has(f.path));
      this.files = scoped.length ? scoped : files;
      this.entry = entry;
      this.filePath = projects.resolveInProject(dir, this.entry);
      const allCode = this.files.map((f) => f.content).join('\n');
      this._interactive = this._interactiveFor(changeRequest, allCode);
      this._wantsPlot = this._plotFor(changeRequest, allCode);

      const planRes = await this._stage(
        'plan', 'Plan Change',
        ({ scale }) => `The user wants to change or extend an existing multi-file Python project. Produce a brief plan: which files to add or modify, what changes each needs, and any new modules or libraries required. Use short bullets. Do NOT write the full code.\n\nPROJECT (entry: ${this.entry}):\n${this._repoContext(this.files, Math.round(this._repoBudgetChars() * scale))}\n\nREQUESTED CHANGE:\n${changeRequest}`,
        { maxTokens: 1024 }
      );

      const apply = await this._stageWithReask(
        'apply', 'Apply Changes',
        ({ scale }) => `Apply the requested change to the project. Preserve existing working behaviour unless the change requires altering it. ${REPO_EDIT_FORMAT} ${this._libNote()}\n\nCURRENT PROJECT (entry: ${this.entry}):\n${this._repoContext(this.files, Math.round(this._repoBudgetChars() * scale))}\n\nREQUESTED CHANGE:\n${changeRequest}\n\nPLAN:\n${planRes.answer}\n\n${BRIEF_THINK}`,
        { live: 'files' },
        (r) => extractFiles(r.answer.length ? r.answer : r.full)
      );
      const updates = apply.out;
      if (!updates.length) {
        throw new Error(apply.res.finishReason === 'length'
          ? 'Apply Changes was cut off before completing the project. ' + this._budgetHelp()
          : 'The model did not return updated files after two attempts. Your project is unchanged — re-run or rephrase the change.');
      }
      this._writeFiles(this._mergeFiles(this.files, updates), this.entry);
      this._remember('refine', `Change applied to project: ${changeRequest}`);
      const req = `Apply this change to the project: ${changeRequest}`;
      await this._finish(req, this._repoProgram(req), () => ({ entry: this.entry, files: this.files.map((f) => f.path) }));
    });
  }

  // Surgical select-and-replace ("inpaint"): rewrite ONLY the selected region, splice it
  // back at the exact lines, and verify the whole file still compiles/runs. Every splice is
  // anchored on the ORIGINAL code + selection, so line-count changes in the replacement
  // never shift the target region. If a compiling result cannot be reached, the original
  // code is restored — the file is never left broken.
  // `selection` = { startLine, endLine, startColumn, endColumn }.
  async inpaint(instruction, baseCode, selection) {
    return this._execute(INPAINT_STAGES, 'inpaint', instruction, async () => {
      const original = String(baseCode || this.code || '');
      if (!original.trim()) throw new Error('There is no code to edit — generate or write some code first.');
      const sel = selection || {};
      const { startLine, endLine, text: regionSrc } = regionText(original, sel);
      if (!regionSrc.trim()) throw new Error('Select a non-empty region of code to edit.');
      this._interactive = wantsInput(instruction) || /\binput\s*\(/.test(original);
      this._writeCode(original);
      const splice = (snippet) => spliceRegion(original, sel, snippet);

      // --- Stage 1: rewrite the selection (the model sees the whole file for context,
      //     but is asked to output ONLY the replacement for the marked lines). ---
      const rewritePrompt = (extra) =>
        `Rewrite ONLY the selected region of this Python file according to the instruction. ` +
        `Output EXACTLY ONE \`\`\`python code block containing the replacement for the selected lines and NOTHING else — ` +
        `no surrounding code, no explanation. Keep it consistent with the rest of the file (same names, indentation level, and APIs) ` +
        `so it splices in cleanly. ${this._libNote()}\n\n` +
        `INSTRUCTION:\n${instruction}\n\n` +
        `FULL FILE (for context only — do NOT reproduce it):\n\`\`\`python\n${original}\n\`\`\`\n\n` +
        `SELECTED REGION TO REWRITE (lines ${startLine}–${endLine}):\n\`\`\`python\n${regionSrc}\n\`\`\`${extra || ''}\n\n${BRIEF_THINK}`;

      const extract = (r) => extractCode(r.answer) || extractCode(r.full);
      let regionRes = await this._stage('region', 'Rewrite Selection', rewritePrompt(''), { live: splice });
      let snippet = extract(regionRes);
      // Small models sometimes answer in prose with no fenced block — re-ask once, firmly.
      if (!snippet && regionRes.finishReason !== 'length' && !this._aborted()) {
        this.emit('stage:delta', { id: 'region', kind: 'answer', text: '\n⟳ No usable code block came back — asking the model once more…\n' });
        regionRes = await this._stage('region', 'Rewrite Selection',
          rewritePrompt('\n\nIMPORTANT: Your previous reply contained NO usable fenced code block. Respond again with ONLY the replacement code inside one complete ```python fenced block (open AND close the fence). No prose.'),
          { live: splice });
        snippet = extract(regionRes);
      }
      if (!snippet) {
        throw new Error(regionRes.finishReason === 'length'
          ? 'Rewrite was cut off before completing the replacement. ' + this._budgetHelp()
          : 'The model did not return a replacement code block after two attempts. Your code is unchanged — try again or rephrase the instruction.');
      }

      // --- Stage 2: splice, then verify. Repairs stay region-scoped — never a whole-file
      //     rewrite — which preserves the surgical nature of the edit. ---
      const prog = {
        code: snippet,
        entry: this.filePath,
        write: (s) => this._writeCode(splice(s)),
        compile: () => python.compileCheck({ pythonPath: this.config.pythonPath, file: this.filePath }),
        describe: describeChange,
        repair: async ({ code: current, failure, history, card }) => {
          const hist = history ? `\n\n${history}` : '';
          const res = await this._llm({
            id: card, live: splice, context: 'full',
            prompt: `The edited region below causes a problem. Fix it by rewriting ONLY that region. ` +
              `Output EXACTLY ONE \`\`\`python block with the replacement for the region and nothing else. ${this._libNote()}\n\n` +
              `INSTRUCTION (original):\n${instruction}\n\n` +
              `FULL FILE (current, for context — do NOT reproduce it):\n\`\`\`python\n${splice(current)}\n\`\`\`\n\n` +
              `THE REGION TO REWRITE (it replaced original lines ${startLine}–${endLine}); its current content is:\n\`\`\`python\n${current}\n\`\`\`\n\n` +
              `${this._feedback(failure)}${hist}\n\n${BRIEF_THINK}`,
          });
          return extract(res) || { rejected: 'returned no replacement code block' };
        },
      };
      prog.write(snippet);
      this._note('verify', `Spliced lines ${startLine}–${endLine}.\n`);
      const verified = await this._verify(instruction, prog, { fixStage: 'verify', runStage: 'run' });
      if (this._aborted()) return this._stoppedDone(verified.compiled);

      if (!verified.compiled) {
        // Guarantee no broken file is left behind.
        this._writeCode(original);
        this._done('verify', `Could not produce a compiling edit after ${verified.repairs.compile} attempt(s); reverted the selection — your code is unchanged.`);
        this._done('run', 'Skipped — edit was reverted.');
        this._remember('inpaint', `Reverted edit of lines ${startLine}–${endLine} ("${instruction}") — could not compile.`);
        this.emit('pipeline:done', { code: this.code, path: this.filePath, compiled: false, exit: null, reverted: true });
        return;
      }
      const run = verified.lastRun;
      const res = verified.result;
      this._remember('inpaint', `Edited lines ${startLine}–${endLine}: ${instruction}${res.ok ? ' (runs)' : run ? ` (exit ${run.exit})` : ''}`);
      this.emit('pipeline:done', {
        code: this.code, path: this.filePath, compiled: true, exit: run ? run.exit : null,
        needsInput: res.stop === 'interactive', missing: res.stop === 'missing' ? res.missing : null,
      });
    });
  }
}

module.exports = { Pipeline, FULL_STAGES, REFINE_STAGES, INPAINT_STAGES, localImportClosure, wantsInput, wantsPlot, describeFailure };
