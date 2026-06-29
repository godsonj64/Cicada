'use strict';

const path = require('path');
const fs = require('fs');
const {
  streamChat, splitThinking, extractCode, extractCodeStreaming, answerStream,
  extractFiles, extractFilesStreaming, pickEntry,
} = require('./llm');
const python = require('./python');
const { spliceRegion, regionText } = require('./splice');
const projects = require('./projects');

const SYS = 'You are Cicada, an expert Python engineer working inside an agentic IDE. Be precise, correct, and concise.';

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
const REPO_FORMAT =
  'Lay the program out as a clean, multi-file Python project. Output EACH file as its own ' +
  'fenced code block, immediately preceded by its project-relative path on its own line as a ' +
  'markdown heading. Exactly this shape:\n\n' +
  '### main.py\n```python\n<contents of main.py>\n```\n\n' +
  '### models/net.py\n```python\n<contents of models/net.py>\n```\n\n' +
  'Hard rules:\n' +
  '- Include a runnable `main.py` at the project ROOT containing `if __name__ == "__main__":`.\n' +
  '- Use ABSOLUTE imports rooted at the project (e.g. `from models.net import Net`, `import data.loader`). ' +
  'Do NOT use package-relative imports (`from .net import Net`) in main.py.\n' +
  '- Add an empty `__init__.py` to EVERY package directory you import from.\n' +
  '- Split the code into focused modules (e.g. models/, data/, training, utils) — not one giant file.\n' +
  '- You may add a `requirements.txt` listing third-party packages.\n' +
  'Output ONLY path headings and fenced code blocks — no commentary between or around them.';

// Fallback library note (used until the environment has been probed). GARM supports
// the full Python ecosystem — including frontier ML/DL frameworks — not just stdlib.
const LIB_NOTE =
  'You may use any installed third-party library (numpy, pandas, scipy, scikit-learn, ' +
  'PyTorch/torch, TensorFlow, JAX, transformers, OpenCV, etc.) as well as the standard library. ' +
  'For plots or graphics, matplotlib runs headless — call plt.show() or plt.savefig(...) and Cicada ' +
  'captures the figure into the Render panel. Do not start servers, GUIs, or blocking input().';

// Stage sets. The renderer builds its cards from whichever set a run declares.
const FULL_STAGES = [
  { id: 'evaluate', name: 'Evaluate' },
  { id: 'design', name: 'System Design' },
  { id: 'generate', name: 'Generate Code' },
  { id: 'review', name: 'Review' },
  { id: 'fix', name: 'Fix & Compile' },
  { id: 'run', name: 'Run & Render' },
];
const REFINE_STAGES = [
  { id: 'plan', name: 'Plan Change' },
  { id: 'apply', name: 'Apply Changes' },
  { id: 'review', name: 'Review' },
  { id: 'fix', name: 'Fix & Compile' },
  { id: 'run', name: 'Run & Render' },
];
// Surgical select-and-replace ("inpaint"): rewrite only the selected region, then
// verify the whole file still compiles/runs — rolling back if it cannot.
const INPAINT_STAGES = [
  { id: 'region', name: 'Rewrite Selection' },
  { id: 'verify', name: 'Splice & Verify' },
  { id: 'run', name: 'Run & Render' },
];

class Pipeline {
  constructor({ config, baseUrl, emit, runFile, memory, env, datasets, apiKey, model }) {
    this.config = config;
    this.baseUrl = baseUrl;
    // For hosted providers (DeepSeek): bearer key + explicit model id. null for local.
    this.apiKey = apiKey || null;
    this.model = model || null;
    this.emit = emit; // (event, payload) => void
    this.runFile = runFile; // (filePath) => Promise<{ code, images }>, streams run:* events
    this.memory = memory || null; // ContextMemory | null (optional; tests omit it)
    this.env = env || null; // detected environment { python, libs:[...] } | null
    this.datasets = datasets || null; // prebuilt data-context block (string) | null
    this.abort = null;
    this.running = false;
    this.code = '';
    this.filePath = path.join(config.workspaceDir, 'main.py');
    // Repo mode working set: the current multi-file project as [{ path, content }] and
    // the relative path of its runnable entry point. Unused in single-file mode.
    this.files = [];
    this.entry = 'main.py';
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

  // The persistent context-memory block to prepend to a stage prompt (or '' when
  // there is nothing remembered yet). Emits a memory:update so the UI panel stays live.
  _memoryBlock() {
    if (!this.memory) return '';
    const block = this.memory.render();
    return block ? block + '\n\n' : '';
  }

  // The uploaded-data context block (schemas + load hints for the project's CSV/Excel/JSON
  // files), prepended to stage prompts so the agent can reason over and build against the
  // real data. '' when the project has no datasets. Built in main via datasets.formatForPrompt.
  _datasetBlock() {
    return this.datasets ? this.datasets + '\n\n' : '';
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

  // A ModuleNotFoundError means the code is fine but a library is not installed — that
  // is not something to "heal" by rewriting. Surface it with the exact pip command and
  // let the UI offer a one-click install.
  _reportMissing(stageId, miss) {
    const cmd = `${this.config.pythonPath} -m pip install ${miss.pkg}`;
    this.emit('stage:delta', { id: stageId, kind: 'answer', text:
      `\n⚠ Missing dependency: the program imports "${miss.module}", which is not installed in this environment.\n` +
      `Install it, then re-run:\n    ${cmd}\n` });
    this.emit('pipeline:missingModule', { module: miss.module, pkg: miss.pkg, command: cmd });
    this._remember('run', `Needs dependency "${miss.module}" — install with: pip install ${miss.pkg}`);
  }

  cancel() {
    if (this.abort) this.abort.abort();
    this.running = false;
  }

  // True once the run has been cancelled (Stop/Cancel pressed — cancel() aborts the signal).
  // Used to bail out of the post-run repair loops instead of "repairing" and re-running a
  // program the user deliberately stopped.
  _aborted() { return !!(this.abort && this.abort.signal.aborted); }

  // Clean terminal "stopped by the user" finish for a run that was cancelled mid-execution.
  // `extra` lets repo mode attach entry/files to the done event.
  _stoppedDone(compiled, extra) {
    this.emit('stage:done', { id: 'run', thinking: '', answer: 'Stopped by the user.' });
    this.emit('pipeline:done', Object.assign(
      { code: this.code, path: this.filePath, compiled: compiled == null ? null : compiled, exit: null, cancelled: true },
      extra || {}
    ));
  }

  _writeCode(code) {
    this.code = code;
    try {
      fs.mkdirSync(this.config.workspaceDir, { recursive: true });
      fs.writeFileSync(this.filePath, code, 'utf8');
    } catch (err) {
      this.emit('pipeline:log', `Failed to write code: ${err.message}`);
    }
    this.emit('pipeline:code', { code, path: this.filePath });
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
        projects.writeFile(dir, f.path, content); // resolveInProject guards traversal
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

  // A path-labelled, fenced concatenation of the repo for prompts, capped to `budget`
  // characters (oldest-first, truncating individual files) so a large project still fits
  // the context window. Mirrors the format the model is asked to emit, so round-trips read
  // naturally to a small model.
  _repoContext(files, budget) {
    budget = budget || 16000;
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
  // and the run harness excluded). Used by repo-mode refine so the model sees the WHOLE
  // project, not just the file open in the editor.
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

  // Compile-check every Python file of the current repo. Returns python.compileCheckFiles'
  // { ok, output } sized over absolute paths.
  _compileRepo() {
    const dir = this.config.workspaceDir;
    const pyFiles = this.files
      .filter((f) => /\.py$/i.test(f.path))
      .map((f) => projects.resolveInProject(dir, f.path));
    return python.compileCheckFiles({ pythonPath: this.config.pythonPath, files: pyFiles });
  }

  // A plain (non-live) completion for repo fix/repair turns: the editor is not streamed
  // into mid-fix (that only makes sense for a single block); the corrected files are
  // written authoritatively once parsed. Returns the raw model text.
  async _complete(userPrompt) {
    const messages = [{ role: 'system', content: SYS }, { role: 'user', content: userPrompt }];
    return streamChat(this.baseUrl, {
      messages,
      temperature: this.config.temperature,
      topP: this.config.topP,
      model: this.model, apiKey: this.apiKey,
      maxTokens: this._codeBudget(messages),
      signal: this.abort.signal,
    });
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
  // substantial program with such a stub: that is exactly how a full CNN script became a
  // broken 3-line `set_device = data_mod.set_device`. A genuine bug fix keeps almost all
  // of the file, so losing more than half its lines means the rewrite failed, not fixed.
  _isDegenerateRewrite(oldCode, newCode) {
    const oldN = this._meaningfulLines(oldCode);
    const newN = this._meaningfulLines(newCode);
    if (oldN < 12) return false;            // tiny programs: nothing worth protecting
    return newN < Math.max(6, oldN * 0.5);  // lost more than half the program → reject
  }

  // Completion-token budget for a code-producing call. A reasoning model has to fit BOTH
  // its <think> block and the entire program in one response, so we hand it as much of the
  // context window as remains after the prompt instead of a small fixed cap (the old 2048
  // cap is exactly why generation truncated mid-thought before emitting any code). Tokens
  // are approximated as chars/3.5 (code is symbol-dense); maxTokens is the upper bound.
  _codeBudget(messages) {
    const chars = messages.reduce((n, m) => n + (m && m.content ? m.content.length : 0), 0);
    const promptTokens = Math.ceil(chars / 3.5);
    const room = this.config.contextSize - promptTokens - 256; // leave a small safety margin
    const ceiling = this.config.maxTokens || this.config.contextSize;
    return Math.max(1024, Math.min(room, ceiling, this.config.contextSize));
  }

  // Run a single LLM stage with streamed thinking/answer routing.
  // When liveCode is set, partial code is streamed to the editor as it is written.
  async _stage(id, name, userPrompt, { maxTokens, liveCode, liveFiles } = {}) {
    this.emit('stage:start', { id, name });
    const messages = [
      { role: 'system', content: SYS },
      { role: 'user', content: this._memoryBlock() + this._datasetBlock() + userPrompt },
    ];
    let full = '';
    let tLen = 0;
    let aLen = 0;
    let lastCode = '';
    let lastCodeAt = 0;
    let finishReason = null;
    // Code stages (single-file liveCode, or multi-file liveFiles) fill the context window;
    // analysis stages keep their explicit small cap.
    const live = liveCode || liveFiles;
    const budget = live ? this._codeBudget(messages) : (maxTokens || this.config.maxTokens);
    if (live) this.emit('pipeline:code-stream-start', {});
    const onDelta = () => {
      if (live) {
        const partial = liveFiles ? extractFilesStreaming(full) : extractCodeStreaming(answerStream(full));
        const now = Date.now();
        if (partial && partial !== lastCode && now - lastCodeAt > 60) {
          lastCode = partial;
          lastCodeAt = now;
          this.emit('pipeline:code-live', { code: partial });
        }
      }
      const { thinking, answer } = splitThinking(full);
      const closed = /<\/think>/i.test(full);
      const tShown = closed ? thinking : thinking.slice(0, Math.max(0, thinking.length - 12));
      if (tShown.length > tLen) {
        this.emit('stage:delta', { id, kind: 'thinking', text: tShown.slice(tLen) });
        tLen = tShown.length;
      }
      if (closed && answer.length > aLen) {
        this.emit('stage:delta', { id, kind: 'answer', text: answer.slice(aLen) });
        aLen = answer.length;
      }
    };

    let text;
    try {
      text = await streamChat(this.baseUrl, {
        messages,
        temperature: this.config.temperature,
        topP: this.config.topP,
        model: this.model, apiKey: this.apiKey,
        maxTokens: budget,
        signal: this.abort.signal,
        onMeta: (m) => { finishReason = m.finishReason; },
        onDelta: (chunk) => { full += chunk; onDelta(); },
      });
    } catch (err) {
      if (live) this.emit('pipeline:code-stream-end', {});
      if (err.name === 'AbortError') { this.emit('stage:error', { id, message: 'Cancelled.' }); throw err; }
      this.emit('stage:error', { id, message: err.message });
      throw err;
    }

    if (live) this.emit('pipeline:code-stream-end', {});
    const { thinking, answer } = splitThinking(text);
    this.emit('stage:done', { id, thinking, answer });
    return { thinking, answer, full: text, finishReason };
  }

  // A streamed code-producing call (generate / apply / fix) that live-streams to the editor.
  // The completion budget is sized to the context window (see _codeBudget).
  async _streamCode(messages) {
    let full = '';
    let lastCode = '';
    let lastAt = 0;
    this.emit('pipeline:code-stream-start', {});
    try {
      const text = await streamChat(this.baseUrl, {
        messages,
        temperature: this.config.temperature,
        topP: this.config.topP,
        model: this.model, apiKey: this.apiKey,
        maxTokens: this._codeBudget(messages),
        signal: this.abort.signal,
        onDelta: (chunk) => {
          full += chunk;
          const partial = extractCodeStreaming(answerStream(full));
          const now = Date.now();
          if (partial && partial !== lastCode && now - lastAt > 60) {
            lastCode = partial;
            lastAt = now;
            this.emit('pipeline:code-live', { code: partial });
          }
        },
      });
      return text;
    } finally {
      this.emit('pipeline:code-stream-end', {});
    }
  }

  // Wrap a run: lifecycle, stage declaration, error + cleanup.
  async _execute(stages, mode, request, body) {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.emit('pipeline:start', { request, mode, stages });
    try {
      await body();
    } catch (err) {
      // A cancel aborts the in-flight fetch (AbortError). It is not a failure, but the
      // renderer still needs a terminal event or it stays stuck in the "running" state
      // forever — so emit a cancelled pipeline:done.
      if (err.name === 'AbortError') {
        this.emit('pipeline:done', { code: this.code, path: this.filePath, cancelled: true, compiled: null, exit: null });
      } else {
        this.emit('pipeline:error', { message: err.message });
      }
    } finally {
      this.running = false;
      this.abort = null;
    }
  }

  // Shared tail: review -> fix & compile loop -> run & render -> done.
  async _finalize(request, code) {
    const reviewRes = await this._stage(
      'review', 'Review',
      `Review this Python code for correctness bugs, runtime errors, and missing edge cases. Output a short numbered list of concrete issues. If it is correct and complete, output exactly: NO ISSUES. Do NOT rewrite the code.\n\nREQUEST:\n${request}\n\nCODE:\n\`\`\`python\n${code}\n\`\`\``,
      { maxTokens: 1024 }
    );
    const reviewText = reviewRes.answer.trim();
    const hasIssues = reviewText.length > 0 && !/no issues/i.test(reviewText);

    this.emit('stage:start', { id: 'fix', name: 'Fix & Compile' });
    let compileResult = await python.compileCheck({ pythonPath: this.config.pythonPath, file: this.filePath });
    this.emit('stage:delta', { id: 'fix', kind: 'answer', text: `Initial compile: ${compileResult.ok ? 'OK' : 'FAILED'}\n` });

    const needFirstFix = hasIssues || !compileResult.ok;
    const maxIter = this.config.maxFixIterations;
    let iter = 0;
    while ((needFirstFix && iter === 0) || (!compileResult.ok && iter < maxIter)) {
      const feedback = !compileResult.ok
        ? `The code fails to compile. Fix the error.\n\nCOMPILER OUTPUT:\n${compileResult.output}`
        : `Apply this review feedback.\n\nREVIEW:\n${reviewRes.answer}`;
      this.emit('stage:delta', { id: 'fix', kind: 'answer', text: `\nFix iteration ${iter + 1}...\n` });

      const fixPrompt = `Fix the Python program. Output EXACTLY ONE \`\`\`python code block with the complete corrected program. No prose outside the code block. ${this._libNote()}\n\nREQUEST:\n${request}\n\nCURRENT CODE:\n\`\`\`python\n${code}\n\`\`\`\n\n${feedback}\n\n${BRIEF_THINK}`;
      const fixText = await this._streamCode(
        [{ role: 'system', content: SYS }, { role: 'user', content: fixPrompt }]
      );
      const fixed = extractCode(splitThinking(fixText).answer) || extractCode(fixText);
      if (fixed && this._isDegenerateRewrite(code, fixed)) {
        this.emit('stage:delta', { id: 'fix', kind: 'answer', text: 'Fix collapsed the program into a fragment — discarding it and keeping the current code.\n' });
        break;
      }
      if (fixed) { code = fixed; this._writeCode(code); }
      compileResult = await python.compileCheck({ pythonPath: this.config.pythonPath, file: this.filePath });
      this.emit('stage:delta', { id: 'fix', kind: 'answer', text: `Compile after fix ${iter + 1}: ${compileResult.ok ? 'OK' : 'FAILED'}\n` });
      iter += 1;
    }
    this.emit('stage:done', {
      id: 'fix', thinking: '',
      answer: compileResult.ok
        ? `Code compiles cleanly${iter ? ` after ${iter} fix iteration(s)` : ''}.`
        : `Code still has syntax errors after ${iter} attempt(s):\n${compileResult.output}`,
    });

    this.emit('stage:start', { id: 'run', name: 'Run & Render' });
    let runResult = await this.runFile(this.filePath, { timeoutMs: this.config.runTimeoutMs || 600000 });
    if (this._aborted()) return this._stoppedDone(compileResult.ok);

    // A missing library is not a code bug — surface it (with the pip command) instead
    // of burning fix iterations rewriting correct code.
    let missing = python.missingModule(runResult.stderr);
    if (missing) this._reportMissing('run', missing);

    // Self-heal runtime errors: compiling cleanly does not mean it runs. If the
    // program crashed with a traceback, feed it back into a fix and re-run.
    let rIter = 0;
    while (
      !this._aborted() && !missing && runResult.code !== 0 && rIter < this.config.maxFixIterations &&
      runResult.stderr && /Traceback|Error:|Exception/.test(runResult.stderr)
    ) {
      this.emit('stage:delta', { id: 'run', kind: 'answer', text: `\nRuntime error detected — repairing (attempt ${rIter + 1})...\n` });
      const fixPrompt = `The program is syntactically valid but crashes at runtime. Diagnose the traceback and fix the root cause. Output EXACTLY ONE \`\`\`python code block with the complete corrected program. No prose outside the code block. ${this._libNote()}\n\nREQUEST:\n${request}\n\nCURRENT CODE:\n\`\`\`python\n${this.code}\n\`\`\`\n\nRUNTIME ERROR (traceback):\n${runResult.stderr.slice(-1600)}\n\n${BRIEF_THINK}`;
      const fixText = await this._streamCode([{ role: 'system', content: SYS }, { role: 'user', content: fixPrompt }]);
      const fixed = extractCode(splitThinking(fixText).answer) || extractCode(fixText);
      if (!fixed) break;
      // Guard against the model collapsing the whole program into a stub: keep the last
      // working version rather than letting each "repair" shrink it further into garbage.
      if (this._isDegenerateRewrite(this.code, fixed)) {
        this.emit('stage:delta', { id: 'run', kind: 'answer', text: 'Repair collapsed the program into a fragment — keeping the last complete version and stopping.\n' });
        break;
      }
      this._writeCode(fixed);
      const recompile = await python.compileCheck({ pythonPath: this.config.pythonPath, file: this.filePath });
      if (!recompile.ok) { this.emit('stage:delta', { id: 'run', kind: 'answer', text: 'Repair did not compile; stopping.\n' }); break; }
      runResult = await this.runFile(this.filePath, { timeoutMs: this.config.runTimeoutMs || 600000 });
      missing = python.missingModule(runResult.stderr);
      if (missing) { this._reportMissing('run', missing); break; }
      rIter += 1;
    }

    const imgN = runResult.images && runResult.images.length ? ` Rendered ${runResult.images.length} image(s).` : '';
    const repaired = rIter ? ` after ${rIter} runtime repair(s)` : '';
    this.emit('stage:done', {
      id: 'run', thinking: '',
      answer: runResult.code === 0
        ? `Ran successfully${repaired} (exit 0).${imgN}`
        : `Process exited with code ${runResult.code}${repaired}.${imgN}`,
    });

    // Remember the outcome so later requests know whether the program currently works.
    const errLine = runResult.code !== 0 && runResult.stderr
      ? ` — ${runResult.stderr.trim().split('\n').pop()}`
      : '';
    this._remember('run', runResult.code === 0
      ? `Program runs cleanly (exit 0).${imgN}`
      : `Program exits with code ${runResult.code}${errLine}`);

    this.emit('pipeline:done', { code: this.code, path: this.filePath, compiled: compileResult.ok, exit: runResult.code });
  }

  // Repo-mode tail: review the whole project -> compile every module (fix loop) -> run the
  // entry point (runtime-repair loop) -> done. Fixes come back as path-labelled files and
  // are merged over the working set, so the model can return only what it changed.
  async _finalizeRepo(request) {
    const pyCount = () => this.files.filter((f) => /\.py$/i.test(f.path)).length;

    const reviewRes = await this._stage(
      'review', 'Review',
      `Review this multi-file Python project for correctness bugs, runtime errors, broken or missing imports, missing __init__.py files, and missing edge cases. Output a short numbered list of concrete issues. If it is correct and complete, output exactly: NO ISSUES. Do NOT rewrite the code.\n\nREQUEST:\n${request}\n\nPROJECT (entry: ${this.entry}):\n${this._repoContext(this.files)}`,
      { maxTokens: 1024 }
    );
    const reviewText = reviewRes.answer.trim();
    const hasIssues = reviewText.length > 0 && !/no issues/i.test(reviewText);

    this.emit('stage:start', { id: 'fix', name: 'Fix & Compile' });
    let compileResult = await this._compileRepo();
    this.emit('stage:delta', { id: 'fix', kind: 'answer', text: `Initial compile (${pyCount()} file(s)): ${compileResult.ok ? 'OK' : 'FAILED'}\n` });

    const needFirstFix = hasIssues || !compileResult.ok;
    const maxIter = this.config.maxFixIterations;
    let iter = 0;
    while ((needFirstFix && iter === 0) || (!compileResult.ok && iter < maxIter)) {
      const feedback = !compileResult.ok
        ? `The project fails to compile. Fix the error(s).\n\nCOMPILER OUTPUT:\n${compileResult.output}`
        : `Apply this review feedback.\n\nREVIEW:\n${reviewRes.answer}`;
      this.emit('stage:delta', { id: 'fix', kind: 'answer', text: `\nFix iteration ${iter + 1}...\n` });
      const fixPrompt = `Fix the Python project. Return the COMPLETE corrected contents of every file you change (whole files, not diffs), each labelled with its path. ${REPO_FORMAT} ${this._libNote()}\n\nREQUEST:\n${request}\n\nCURRENT PROJECT (entry: ${this.entry}):\n${this._repoContext(this.files)}\n\n${feedback}\n\n${BRIEF_THINK}`;
      const fixText = await this._complete(fixPrompt);
      const updates = extractFiles(splitThinking(fixText).answer || fixText);
      if (!updates.length) {
        this.emit('stage:delta', { id: 'fix', kind: 'answer', text: 'No file blocks returned — keeping the current project.\n' });
        break;
      }
      this._writeFiles(this._mergeFiles(this.files, updates), this.entry);
      compileResult = await this._compileRepo();
      this.emit('stage:delta', { id: 'fix', kind: 'answer', text: `Compile after fix ${iter + 1}: ${compileResult.ok ? 'OK' : 'FAILED'}\n` });
      iter += 1;
    }
    this.emit('stage:done', {
      id: 'fix', thinking: '',
      answer: compileResult.ok
        ? `Project compiles cleanly${iter ? ` after ${iter} fix iteration(s)` : ''}.`
        : `Project still has syntax errors after ${iter} attempt(s):\n${compileResult.output}`,
    });

    this.emit('stage:start', { id: 'run', name: 'Run & Render' });
    let runResult = await this.runFile(this.filePath, { timeoutMs: this.config.runTimeoutMs || 600000 });
    if (this._aborted()) return this._stoppedDone(compileResult.ok, { entry: this.entry, files: this.files.map((f) => f.path) });
    let missing = python.missingModule(runResult.stderr);
    if (missing) this._reportMissing('run', missing);

    let rIter = 0;
    while (
      !this._aborted() && !missing && runResult.code !== 0 && rIter < this.config.maxFixIterations &&
      runResult.stderr && /Traceback|Error:|Exception/.test(runResult.stderr)
    ) {
      this.emit('stage:delta', { id: 'run', kind: 'answer', text: `\nRuntime error detected — repairing (attempt ${rIter + 1})...\n` });
      const fixPrompt = `The project is syntactically valid but crashes at runtime when running ${this.entry}. Diagnose the traceback and fix the ROOT CAUSE. Return the COMPLETE corrected contents of every file you change, each labelled with its path. ${REPO_FORMAT} ${this._libNote()}\n\nREQUEST:\n${request}\n\nCURRENT PROJECT (entry: ${this.entry}):\n${this._repoContext(this.files)}\n\nRUNTIME ERROR (traceback):\n${runResult.stderr.slice(-1600)}\n\n${BRIEF_THINK}`;
      const fixText = await this._complete(fixPrompt);
      const updates = extractFiles(splitThinking(fixText).answer || fixText);
      if (!updates.length) break;
      this._writeFiles(this._mergeFiles(this.files, updates), this.entry);
      const recompile = await this._compileRepo();
      if (!recompile.ok) { this.emit('stage:delta', { id: 'run', kind: 'answer', text: 'Repair did not compile; stopping.\n' }); break; }
      runResult = await this.runFile(this.filePath, { timeoutMs: this.config.runTimeoutMs || 600000 });
      missing = python.missingModule(runResult.stderr);
      if (missing) { this._reportMissing('run', missing); break; }
      rIter += 1;
    }

    const imgN = runResult.images && runResult.images.length ? ` Rendered ${runResult.images.length} image(s).` : '';
    const repaired = rIter ? ` after ${rIter} runtime repair(s)` : '';
    this.emit('stage:done', {
      id: 'run', thinking: '',
      answer: runResult.code === 0
        ? `Ran ${this.entry} successfully${repaired} (exit 0).${imgN}`
        : `Process exited with code ${runResult.code}${repaired}.${imgN}`,
    });

    const errLine = runResult.code !== 0 && runResult.stderr ? ` — ${runResult.stderr.trim().split('\n').pop()}` : '';
    this._remember('run', runResult.code === 0
      ? `Project runs cleanly (exit 0).${imgN}`
      : `Project exits with code ${runResult.code}${errLine}`);

    this.emit('pipeline:done', {
      code: this.code, path: this.filePath, compiled: compileResult.ok, exit: runResult.code,
      entry: this.entry, files: this.files.map((f) => f.path),
    });
  }

  // Build a program from scratch. In single-file mode this writes one main.py; in repo
  // mode it writes a whole multi-file project (see _generateRepo / _finalizeRepo).
  async run(request) {
    const repo = this._repoMode();
    return this._execute(FULL_STAGES, 'create', request, async () => {
      const evalRes = await this._stage(
        'evaluate', 'Evaluate',
        `Analyze this request for a Python program. Produce a brief structured evaluation with these headings only: Goal, Inputs, Outputs, Constraints, Edge cases, Success criteria. Use short bullets. Do NOT write code.\n\nREQUEST:\n${request}`,
        { maxTokens: 1024 }
      );
      const designLayout = repo
        ? ' Then list the FILES the project should have (project-relative path — one-line purpose each), as a proper multi-file layout with a root main.py entry point and packages/modules.'
        : '';
      const designRes = await this._stage(
        'design', 'System Design',
        `Design a Python solution. Output a concise plan: Approach, Key functions/classes (one line each), Data flow, Libraries.${designLayout} ${this._libNote()} Use short bullets. Do NOT write the full implementation.\n\nREQUEST:\n${request}\n\nEVALUATION:\n${evalRes.answer}`,
        { maxTokens: 1024 }
      );

      if (repo) { await this._generateRepo(request, designRes.answer); return; }

      const genRes = await this._stage(
        'generate', 'Generate Code',
        `Implement the program. Output EXACTLY ONE \`\`\`python code block containing a complete, runnable, self-contained program. No prose outside the code block. ${this._libNote()} Include an \`if __name__ == "__main__":\` entry point. Avoid input() unless the request truly requires interactive input.\n\nREQUEST:\n${request}\n\nDESIGN:\n${designRes.answer}\n\n${BRIEF_THINK}`,
        { liveCode: true }
      );
      const code = extractCode(genRes.answer) || extractCode(genRes.full);
      if (!code) {
        throw new Error(genRes.finishReason === 'length'
          ? 'Generate stage was cut off before completing the code block (token budget exhausted). Raise Context size in Settings or narrow the request.'
          : 'Model did not return a usable code block in the Generate stage.');
      }
      this._writeCode(code);

      // Establish the project in memory: this request becomes the working summary.
      this._remember('create', `Built program for: ${request}`, request);

      await this._finalize(request, code);
    });
  }

  // Repo-mode Generate: ask for the whole project as path-labelled files, parse them,
  // write them to disk, then verify (review/compile/run) the project as a unit.
  async _generateRepo(request, design) {
    const genRes = await this._stage(
      'generate', 'Generate Code',
      `Implement the program now. ${REPO_FORMAT} ${this._libNote()} Avoid input() unless the request truly requires interactive input.\n\nREQUEST:\n${request}\n\nDESIGN:\n${design}\n\n${BRIEF_THINK}`,
      { liveFiles: true }
    );
    const files = extractFiles(genRes.answer.length ? genRes.answer : genRes.full);
    if (!files.length) {
      throw new Error(genRes.finishReason === 'length'
        ? 'Generate stage was cut off before completing the project (token budget exhausted). Raise Context size in Settings or narrow the request.'
        : 'Model did not return any usable file blocks in the Generate stage.');
    }
    this._writeFiles(files, pickEntry(files));
    this._remember('create', `Built ${files.length}-file project for: ${request} (entry: ${this.entry})`, request);
    await this._finalizeRepo(request);
  }

  // Post-edit agentic iteration: apply a change/addition to the current code. In repo mode
  // the change is applied across the whole project (see _refineRepo); in single-file mode
  // it rewrites the one open file.
  async refine(changeRequest, baseCode) {
    if (this._repoMode()) return this._refineRepo(changeRequest, baseCode);
    return this._execute(REFINE_STAGES, 'refine', changeRequest, async () => {
      const base = String(baseCode || this.code || '').trim();
      if (!base) throw new Error('There is no code to refine yet — generate or write some code first.');
      this._writeCode(base);

      const planRes = await this._stage(
        'plan', 'Plan Change',
        `The user wants to change or extend an existing Python program. Produce a brief plan of the edits: what to add or modify, where, and any new functions or libraries needed. Use short bullets. Do NOT write the full code.\n\nCURRENT CODE:\n\`\`\`python\n${base}\n\`\`\`\n\nREQUESTED CHANGE:\n${changeRequest}`,
        { maxTokens: 1024 }
      );

      const applyRes = await this._stage(
        'apply', 'Apply Changes',
        `Apply the requested change to the program. Output EXACTLY ONE \`\`\`python code block with the COMPLETE updated program (not a diff or snippet). Preserve existing working behaviour unless the change requires altering it. ${this._libNote()}\n\nCURRENT CODE:\n\`\`\`python\n${base}\n\`\`\`\n\nREQUESTED CHANGE:\n${changeRequest}\n\nPLAN:\n${planRes.answer}\n\n${BRIEF_THINK}`,
        { liveCode: true }
      );
      const code = extractCode(applyRes.answer) || extractCode(applyRes.full);
      if (!code) {
        throw new Error(applyRes.finishReason === 'length'
          ? 'Apply Changes was cut off before completing the program (token budget exhausted). Raise Context size in Settings or narrow the change.'
          : 'Model did not return updated code in the Apply Changes stage.');
      }
      // The model sometimes returns a fragment instead of the full updated program; don't
      // let that silently replace the user's working code (it is restored on this throw).
      if (this._isDegenerateRewrite(base, code)) {
        throw new Error('Apply Changes returned a much smaller program than the original — the model likely dropped most of it. Your code was kept unchanged; re-run or rephrase the change.');
      }
      this._writeCode(code);

      this._remember('refine', `Change applied: ${changeRequest}`);

      await this._finalize(`Apply this change to the program: ${changeRequest}`, code);
    });
  }

  // Repo-mode refine: load the whole project off disk (overlaying any unsaved content from
  // the open editor file), plan the change, apply it as path-labelled files, merge over the
  // project, and verify. The model sees the entire project — not just one file — so changes
  // that span modules land coherently.
  async _refineRepo(changeRequest, baseCode) {
    return this._execute(REFINE_STAGES, 'refine', changeRequest, async () => {
      const dir = this.config.workspaceDir;
      let files = this._readRepoFromDisk();
      // Honour unsaved edits to the file currently open in the editor.
      const openRel = path.relative(dir, this.filePath);
      if (baseCode && baseCode.trim() && openRel && !openRel.startsWith('..')) {
        const existing = files.find((f) => f.path === openRel);
        if (existing) existing.content = baseCode;
        else files.push({ path: openRel, content: baseCode });
      }
      if (!files.length || !files.some((f) => f.content && f.content.trim())) {
        throw new Error('There is no code to refine yet — generate or write some code first.');
      }
      this.files = files;
      this.entry = (files.find((f) => f.path === pickEntry(files)) || files[0]).path;
      this.filePath = projects.resolveInProject(dir, this.entry);

      const planRes = await this._stage(
        'plan', 'Plan Change',
        `The user wants to change or extend an existing multi-file Python project. Produce a brief plan: which files to add or modify, what changes each needs, and any new modules or libraries required. Use short bullets. Do NOT write the full code.\n\nPROJECT (entry: ${this.entry}):\n${this._repoContext(this.files)}\n\nREQUESTED CHANGE:\n${changeRequest}`,
        { maxTokens: 1024 }
      );

      const applyRes = await this._stage(
        'apply', 'Apply Changes',
        `Apply the requested change to the project. Return the COMPLETE updated contents of every file you add or modify (whole files, not diffs), each labelled with its path. Preserve existing working behaviour unless the change requires altering it, and keep imports consistent across files. ${REPO_FORMAT} ${this._libNote()}\n\nCURRENT PROJECT (entry: ${this.entry}):\n${this._repoContext(this.files)}\n\nREQUESTED CHANGE:\n${changeRequest}\n\nPLAN:\n${planRes.answer}\n\n${BRIEF_THINK}`,
        { liveFiles: true }
      );
      const updates = extractFiles(applyRes.answer.length ? applyRes.answer : applyRes.full);
      if (!updates.length) {
        throw new Error(applyRes.finishReason === 'length'
          ? 'Apply Changes was cut off before completing the project (token budget exhausted). Raise Context size in Settings or narrow the change.'
          : 'Model did not return updated files in the Apply Changes stage.');
      }
      this._writeFiles(this._mergeFiles(this.files, updates), this.entry);
      this._remember('refine', `Change applied to project: ${changeRequest}`);
      await this._finalizeRepo(`Apply this change to the project: ${changeRequest}`);
    });
  }

  // Surgical select-and-replace ("inpaint"): rewrite ONLY the selected region, splice
  // it back at the exact lines, and verify the whole file still compiles/runs. If a
  // compiling result cannot be reached, the original code is restored — the file is
  // never left broken. `selection` = { startLine, endLine, startColumn, endColumn }.
  async inpaint(instruction, baseCode, selection) {
    return this._execute(INPAINT_STAGES, 'inpaint', instruction, async () => {
      const original = String(baseCode || this.code || '');
      if (!original.trim()) throw new Error('There is no code to edit — generate or write some code first.');
      const sel = selection || {};
      const { startLine, endLine, text: regionSrc } = regionText(original, sel);
      if (!regionSrc.trim()) throw new Error('Select a non-empty region of code to edit.');
      this._writeCode(original);

      // --- Stage 1: rewrite the selection (model sees the whole file for context,
      //     but is asked to output ONLY the replacement for the marked lines). ---
      const rewritePrompt = (extra) =>
        `${this._memoryBlock()}Rewrite ONLY the selected region of this Python file according to the instruction. ` +
        `Output EXACTLY ONE \`\`\`python code block containing the replacement for the selected lines and NOTHING else — ` +
        `no surrounding code, no explanation. Keep it consistent with the rest of the file (same names, indentation level, and APIs) ` +
        `so it splices in cleanly. ${this._libNote()}\n\n` +
        `INSTRUCTION:\n${instruction}\n\n` +
        `FULL FILE (for context only — do NOT reproduce it):\n\`\`\`python\n${original}\n\`\`\`\n\n` +
        `SELECTED REGION TO REWRITE (lines ${startLine}–${endLine}):\n\`\`\`python\n${regionSrc}\n\`\`\`${extra || ''}\n\n${BRIEF_THINK}`;

      const regionRes = await this._stageRaw('region', 'Rewrite Selection', rewritePrompt(''), {
        maxTokens: this.config.maxTokens,
        // Live-preview the splice as the replacement streams in.
        livePreview: (snippet) => spliceRegion(original, sel, snippet),
      });
      let snippet = extractCode(regionRes.answer) || extractCode(regionRes.full);
      if (!snippet) {
        throw new Error(regionRes.finishReason === 'length'
          ? 'Rewrite was cut off before completing the replacement (token budget exhausted). Raise Context size in Settings or select a smaller region.'
          : 'Model did not return a replacement code block for the selection.');
      }

      // --- Stage 2: splice + compile-gate with one heal pass, else roll back. ---
      this.emit('stage:start', { id: 'verify', name: 'Splice & Verify' });
      let candidate = spliceRegion(original, sel, snippet);
      this._writeCode(candidate);
      let compileResult = await python.compileCheck({ pythonPath: this.config.pythonPath, file: this.filePath });
      this.emit('stage:delta', { id: 'verify', kind: 'answer', text: `Spliced lines ${startLine}–${endLine}. Compile: ${compileResult.ok ? 'OK' : 'FAILED'}\n` });

      let heal = 0;
      while (!compileResult.ok && heal < this.config.maxFixIterations) {
        this.emit('stage:delta', { id: 'verify', kind: 'answer', text: `Healing the selection (attempt ${heal + 1})…\n` });
        const healText = await this._streamCodeInto('verify', original, sel,
          rewritePrompt(`\n\nThe previous replacement did not compile. Compiler output:\n${compileResult.output}\nReturn a corrected replacement for the SAME region only.`));
        const healed = extractCode(splitThinking(healText).answer) || extractCode(healText);
        if (!healed) break;
        snippet = healed;
        candidate = spliceRegion(original, sel, snippet);
        this._writeCode(candidate);
        compileResult = await python.compileCheck({ pythonPath: this.config.pythonPath, file: this.filePath });
        this.emit('stage:delta', { id: 'verify', kind: 'answer', text: `Compile after heal ${heal + 1}: ${compileResult.ok ? 'OK' : 'FAILED'}\n` });
        heal += 1;
      }

      if (!compileResult.ok) {
        // Guarantee no broken file is left behind.
        this._writeCode(original);
        this.emit('stage:done', { id: 'verify', thinking: '', answer: `Could not produce a compiling edit after ${heal} attempt(s); reverted the selection — your code is unchanged.` });
        this.emit('stage:start', { id: 'run', name: 'Run & Render' });
        this.emit('stage:done', { id: 'run', thinking: '', answer: 'Skipped — edit was reverted.' });
        this._remember('inpaint', `Reverted edit of lines ${startLine}–${endLine} ("${instruction}") — could not compile.`);
        this.emit('pipeline:done', { code: this.code, path: this.filePath, compiled: false, exit: null, reverted: true });
        return;
      }
      this.emit('stage:done', { id: 'verify', thinking: '', answer: `Selection replaced and compiles cleanly${heal ? ` after ${heal} heal(s)` : ''}.` });

      // --- Stage 3: run. A runtime crash triggers a region-scoped repair (never a
      //     whole-file rewrite), preserving the surgical nature of the edit. All
      //     splices stay anchored on the ORIGINAL code + selection so line-count
      //     changes in the replacement never shift the target region. ---
      this.emit('stage:start', { id: 'run', name: 'Run & Render' });
      let runResult = await this.runFile(this.filePath, { timeoutMs: this.config.runTimeoutMs || 600000 });
      if (this._aborted()) return this._stoppedDone(true);
      let inpaintMissing = python.missingModule(runResult.stderr);
      if (inpaintMissing) this._reportMissing('run', inpaintMissing);
      let currentSnippet = snippet; // what currently occupies the region
      let rIter = 0;
      while (
        !this._aborted() && !inpaintMissing && runResult.code !== 0 && rIter < this.config.maxFixIterations &&
        runResult.stderr && /Traceback|Error:|Exception/.test(runResult.stderr)
      ) {
        this.emit('stage:delta', { id: 'run', kind: 'answer', text: `\nRuntime error — repairing the selection (attempt ${rIter + 1})…\n` });
        const fixText = await this._streamCodeInto('run', original, sel,
          `${this._memoryBlock()}The file compiles but crashes at runtime. Fix the ROOT CAUSE by rewriting ONLY the region you previously edited. ` +
          `Output EXACTLY ONE \`\`\`python block with the replacement for that region and nothing else. ${this._libNote()}\n\n` +
          `INSTRUCTION (original):\n${instruction}\n\n` +
          `FULL FILE (current, for context):\n\`\`\`python\n${this.code}\n\`\`\`\n\n` +
          `THE REGION TO REWRITE (it replaced original lines ${startLine}–${endLine}); its current content is:\n\`\`\`python\n${currentSnippet}\n\`\`\`\n\n` +
          `RUNTIME ERROR (traceback):\n${runResult.stderr.slice(-1600)}\n\n${BRIEF_THINK}`);
        const fixed = extractCode(splitThinking(fixText).answer) || extractCode(fixText);
        if (!fixed) break;
        const recompile = await this._writeAndCompile(spliceRegion(original, sel, fixed));
        if (!recompile.ok) {
          // Keep the last version that compiled rather than a broken repair.
          this._writeCode(spliceRegion(original, sel, currentSnippet));
          this.emit('stage:delta', { id: 'run', kind: 'answer', text: 'Repair did not compile; keeping the last compiling version.\n' });
          break;
        }
        currentSnippet = fixed;
        runResult = await this.runFile(this.filePath, { timeoutMs: this.config.runTimeoutMs || 600000 });
        rIter += 1;
      }

      const imgN = runResult.images && runResult.images.length ? ` Rendered ${runResult.images.length} image(s).` : '';
      this.emit('stage:done', {
        id: 'run', thinking: '',
        answer: runResult.code === 0 ? `Ran successfully (exit 0).${imgN}` : `Process exited with code ${runResult.code}.${imgN}`,
      });
      this._remember('inpaint', `Edited lines ${startLine}–${endLine}: ${instruction}${runResult.code === 0 ? ' (runs)' : ` (exit ${runResult.code})`}`);
      this.emit('pipeline:done', { code: this.code, path: this.filePath, compiled: true, exit: runResult.code });
    });
  }

  // Like _stage, but supports a livePreview(snippet)=>fullCode hook so a region rewrite
  // can stream the spliced result into the editor as it is written. Returns { answer, full }.
  async _stageRaw(id, name, userPrompt, { maxTokens, livePreview } = {}) {
    this.emit('stage:start', { id, name });
    let full = '';
    let tLen = 0;
    let aLen = 0;
    let lastPreview = '';
    let lastAt = 0;
    if (livePreview) this.emit('pipeline:code-stream-start', {});
    const onDelta = () => {
      const { thinking, answer } = splitThinking(full);
      const closed = /<\/think>/i.test(full);
      const tShown = closed ? thinking : thinking.slice(0, Math.max(0, thinking.length - 12));
      if (tShown.length > tLen) { this.emit('stage:delta', { id, kind: 'thinking', text: tShown.slice(tLen) }); tLen = tShown.length; }
      if (closed && answer.length > aLen) { this.emit('stage:delta', { id, kind: 'answer', text: answer.slice(aLen) }); aLen = answer.length; }
      if (livePreview) {
        const snippet = extractCodeStreaming(answerStream(full));
        const now = Date.now();
        if (snippet && now - lastAt > 60) {
          let preview = '';
          try { preview = livePreview(snippet); } catch (_) { preview = ''; }
          if (preview && preview !== lastPreview) { lastPreview = preview; lastAt = now; this.emit('pipeline:code-live', { code: preview }); }
        }
      }
    };
    const messages = [{ role: 'system', content: SYS }, { role: 'user', content: userPrompt }];
    let finishReason = null;
    // A region rewrite (livePreview) is a code stage — give it the full context budget.
    const budget = livePreview ? this._codeBudget(messages) : (maxTokens || this.config.maxTokens);
    let text;
    try {
      text = await streamChat(this.baseUrl, {
        messages,
        temperature: this.config.temperature, topP: this.config.topP,
        model: this.model, apiKey: this.apiKey,
        maxTokens: budget, signal: this.abort.signal,
        onMeta: (m) => { finishReason = m.finishReason; },
        onDelta: (chunk) => { full += chunk; onDelta(); },
      });
    } catch (err) {
      if (livePreview) this.emit('pipeline:code-stream-end', {});
      if (err.name === 'AbortError') { this.emit('stage:error', { id, message: 'Cancelled.' }); throw err; }
      this.emit('stage:error', { id, message: err.message }); throw err;
    }
    if (livePreview) this.emit('pipeline:code-stream-end', {});
    const { thinking, answer } = splitThinking(text);
    this.emit('stage:done', { id, thinking, answer });
    return { thinking, answer, full: text, finishReason };
  }

  // A code-producing call whose live preview splices the streamed snippet into `base`
  // over `sel`. Used by the inpaint heal/repair loops. Returns the raw model text.
  async _streamCodeInto(_stageId, base, sel, userPrompt) {
    let full = '';
    let lastPreview = '';
    let lastAt = 0;
    const messages = [{ role: 'system', content: SYS }, { role: 'user', content: userPrompt }];
    this.emit('pipeline:code-stream-start', {});
    try {
      const text = await streamChat(this.baseUrl, {
        messages,
        temperature: this.config.temperature, topP: this.config.topP,
        model: this.model, apiKey: this.apiKey,
        maxTokens: this._codeBudget(messages), signal: this.abort.signal,
        onDelta: (chunk) => {
          full += chunk;
          const snippet = extractCodeStreaming(answerStream(full));
          const now = Date.now();
          if (snippet && now - lastAt > 60) {
            let preview = '';
            try { preview = spliceRegion(base, sel, snippet); } catch (_) { preview = ''; }
            if (preview && preview !== lastPreview) { lastPreview = preview; lastAt = now; this.emit('pipeline:code-live', { code: preview }); }
          }
        },
      });
      return text;
    } finally {
      this.emit('pipeline:code-stream-end', {});
    }
  }

  // Write code to disk + editor, then syntax-check it. Returns the compile result.
  async _writeAndCompile(code) {
    this._writeCode(code);
    return python.compileCheck({ pythonPath: this.config.pythonPath, file: this.filePath });
  }
}

module.exports = { Pipeline, FULL_STAGES, REFINE_STAGES, INPAINT_STAGES };
