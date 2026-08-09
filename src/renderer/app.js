// Cicada — renderer controller. Wires the agentic pipeline, editor, run/console,
// render, terminal, settings, and layout together over the preload `garm` bridge.
(function () {
  var garm = window.garm;
  var $ = function (sel) { return document.querySelector(sel); };
  var currentConfig = null;
  var modelReady = false;
  var pipelineRunning = false;
  var codeRunning = false;
  var timerHandle = null;
  var timerStart = 0;
  var afterSplash = null; // fired once the loading splash is fully removed

  // ---- Stage cards -------------------------------------------------------
  // Stage cards are built dynamically from whatever the active run declares
  // (create vs. refine have different stage lists). This is the default preview.
  var DEFAULT_STAGES = [
    { id: 'evaluate', name: 'Evaluate' },
    { id: 'design', name: 'System Design' },
    { id: 'generate', name: 'Generate Code' },
    { id: 'review', name: 'Review' },
    { id: 'fix', name: 'Fix & Compile' },
    { id: 'run', name: 'Run & Render' },
  ];
  // Stage badges: the first stage wears the original white mark; the rest cycle through the
  // 5 gradient logo variants defined in index.html (#garm-logo-v1..v5).
  var STAGE_LOGOS = ['garm-logo-v1', 'garm-logo-v2', 'garm-logo-v3', 'garm-logo-v4', 'garm-logo-v5'];
  var stageEls = {};

  function buildStages(defs) {
    var container = $('#stages');
    container.innerHTML = '';
    stageEls = {};
    (defs || DEFAULT_STAGES).forEach(function (def, i) {
      var card = document.createElement('div');
      card.className = 'stage pending';
      card.style.setProperty('--si', i); // stagger index for the home-page entrance cascade
      card.innerHTML =
        '<div class="stage-head">' +
        '  <div class="stage-num"><svg class="stage-logo" viewBox="0 0 120 120"><use href="#' +
            (i === 0 ? 'garm-mark' : STAGE_LOGOS[(i - 1) % STAGE_LOGOS.length]) + '" /></svg></div>' +
        '  <div class="stage-name">' + def.name + '</div>' +
        '  <div class="stage-state">pending</div>' +
        '</div>' +
        '<div class="stage-body">' +
        '  <div class="stage-body-inner">' +   // single wrapper so the grid-rows reveal can animate to exact height
        '    <span class="toggle-think">Show reasoning</span>' +
        '    <div class="think-block hidden">' +
        '      <div class="think-label">Reasoning</div>' +
        '      <div class="think-text"></div>' +
        '    </div>' +
        '    <div class="answer-text"></div>' +
        '  </div>' +
        '</div>';
      container.appendChild(card);
      var refs = {
        card: card,
        state: card.querySelector('.stage-state'),
        body: card.querySelector('.stage-body'),
        think: card.querySelector('.think-text'),
        thinkBlock: card.querySelector('.think-block'),
        toggle: card.querySelector('.toggle-think'),
        answer: card.querySelector('.answer-text'),
      };
      card.querySelector('.stage-head').addEventListener('click', function () { card.classList.toggle('open'); });
      refs.toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        refs.thinkBlock.classList.toggle('hidden');
        refs.toggle.textContent = refs.thinkBlock.classList.contains('hidden') ? 'Show reasoning' : 'Hide reasoning';
      });
      stageEls[def.id] = refs;
    });
  }

  function setStage(id, state) {
    var r = stageEls[id]; if (!r) return;
    r.card.className = 'stage ' + state + (state === 'running' ? ' open' : '');
    r.state.textContent = state;
    if (state === 'running') {
      r.card.classList.add('open');
      r.thinkBlock.classList.remove('hidden');
      r.toggle.textContent = 'Hide reasoning';
      r.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (state === 'done') {
      r.thinkBlock.classList.add('hidden');
      r.toggle.textContent = 'Show reasoning';
    }
  }

  // ---- Pipeline events ---------------------------------------------------
  function wirePipeline() {
    garm.on('pipeline:start', function (p) {
      buildStages(p && p.stages);
      startTimer();
      setPipelineRunning(true);
      switchDock('console');
      // A fresh build writes the project's main.py — point the editor tab at it so the
      // streamed code (and any later save/run) maps to the right file.
      if (p && p.mode === 'create') { loadedFile = 'main.py'; setActiveFile('main.py'); }
    });
    garm.on('stage:start', function (p) { setStage(p.id, 'running'); });
    garm.on('stage:delta', function (p) {
      var r = stageEls[p.id]; if (!r) return;
      if (p.kind === 'thinking') { r.think.textContent += p.text; r.think.scrollTop = r.think.scrollHeight; }
      else { r.answer.textContent += p.text; }
    });
    garm.on('stage:done', function (p) {
      var r = stageEls[p.id]; if (!r) return;
      r.think.textContent = p.thinking || r.think.textContent;
      r.answer.textContent = p.answer || r.answer.textContent;
      setStage(p.id, 'done');
    });
    garm.on('stage:error', function (p) {
      var r = stageEls[p.id]; if (!r) return;
      r.answer.textContent = p.message || 'Error';
      setStage(p.id, 'error');
    });
    // Live code stream: partial code flows into the editor as the model writes it.
    garm.on('pipeline:code-stream-start', function () { window.GARMEditor.beginStream(); $('#file-tab').classList.add('streaming'); });
    garm.on('pipeline:code-live', function (p) { window.GARMEditor.streamValue(p.code); });
    garm.on('pipeline:code-stream-end', function () { $('#file-tab').classList.remove('streaming'); });
    // Authoritative code (after extraction / each fix) — replaces the streamed text.
    garm.on('pipeline:code', function (p) { window.GARMEditor.commitValue(p.code); });
    // Repo mode wrote a whole multi-file project: surface the new files in the tree and
    // point the editor tab at the runnable entry point the agent chose.
    garm.on('pipeline:files', function (p) {
      refreshTree();
      if (p && p.entry) { loadedFile = p.entry; setActiveFile(p.entry); }
    });
    garm.on('pipeline:done', function (p) {
      setPipelineRunning(false); stopTimer();
      window.GARMEditor.finishStreaming(); // restore prior code if a stream committed nothing
      window.GARMEditor.clearRegion();
      loadedFile = activeFile;  // editor now matches the file the agent wrote to disk
      refreshTree();            // surface any newly created file (e.g. a fresh main.py)
      if (p && p.cancelled) {
        appendConsole('\n[pipeline] Cancelled.\n', false, true);
        switchDock('console');
      } else if (p && p.reverted) {
        appendConsole('\n[edit] Selection reverted — your code is unchanged (could not produce a compiling edit).\n', false, true);
        switchDock('console');
      }
    });
    garm.on('pipeline:error', function (p) {
      setPipelineRunning(false); stopTimer();
      window.GARMEditor.finishStreaming(); // a crash mid-stream must not leave the editor blank
      appendConsole('\n[pipeline error] ' + p.message + '\n', true);
      // Surface the failure where the user is looking, with one-click recovery.
      toast('Agent run failed: ' + p.message, 'err', 9000,
        lastAgentOp ? { label: 'Retry', run: retryLastAgentOp } : null);
    });
    garm.on('pipeline:log', function (p) { appendConsole('[log] ' + p + '\n', false, true); });
  }

  function setPipelineRunning(on) {
    pipelineRunning = on;
    $('#btn-run-pipeline').disabled = on || !modelReady;
    $('#btn-cancel-pipeline').disabled = !on;
    $('#btn-refine').disabled = on || !modelReady;
    $('#btn-edit-selection').disabled = on || !modelReady;
    $('#btn-inpaint-apply').disabled = on || !modelReady;
    // While the agent owns the file, block editor actions that write/run the same file —
    // an editor Run would kill the agent's verification run; Save/Compile would race its writes.
    $('#btn-run').disabled = on || codeRunning;
    $('#btn-compile').disabled = on;
    $('#btn-save').disabled = on;
    // Don't let the output structure change mid-run.
    document.querySelectorAll('#output-mode .om-opt').forEach(function (b) { b.disabled = on; });
  }

  function startTimer() {
    timerStart = Date.now();
    var el = $('#pipeline-timer');
    timerHandle = setInterval(function () {
      el.textContent = ((Date.now() - timerStart) / 1000).toFixed(0) + 's';
    }, 250);
  }
  function stopTimer() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    if (timerStart) $('#pipeline-timer').textContent = ((Date.now() - timerStart) / 1000).toFixed(1) + 's';
  }

  // ---- Run / compile / console ------------------------------------------
  function appendConsole(text, isErr, isMeta) {
    var c = $('#console');
    var span = document.createElement('span');
    if (isErr) span.className = 'out-err';
    else if (isMeta) span.className = 'out-meta';
    span.textContent = text;
    c.appendChild(span);
    c.scrollTop = c.scrollHeight;
  }

  function wireRun() {
    garm.on('run:clear', function () { $('#console').innerHTML = ''; });
    garm.on('run:started', function (p) { setCodeRunning(true); appendConsole('> python ' + (p.file ? p.file.split(/[\\/]/).pop() : 'main.py') + '\n', false, true); });
    garm.on('run:data', function (p) { appendConsole(p.text, p.stream === 'stderr'); });
    garm.on('run:exit', function (p) { setCodeRunning(false); appendConsole('\n[process exited with code ' + p.code + ']\n', false, true); });
    garm.on('run:images', function (p) { showImages(p.images); if (p.images && p.images.length) switchDock('render'); });
  }

  function setCodeRunning(on) {
    codeRunning = on;
    // Stop must stay live whenever a program is actually executing — INCLUDING the agent
    // pipeline's Run/verify stage — so the user can always halt a running program. (Run
    // stays disabled during the pipeline to prevent a conflicting manual run.)
    $('#btn-stop').disabled = !on;
    $('#btn-run').disabled = on || pipelineRunning;
  }

  function showImages(images) {
    if (!images || !images.length) return;
    var grid = $('#render');
    grid.innerHTML = '';
    images.forEach(function (img) {
      var fig = document.createElement('figure');
      fig.style.margin = '0';
      var el = document.createElement('img');
      el.src = img.url + '?t=' + Date.now();
      var cap = document.createElement('figcaption');
      cap.className = 'muted small';
      cap.style.marginTop = '4px';
      cap.textContent = img.path.split(/[\\/]/).pop();
      el.onerror = function () { cap.textContent = '(could not load) ' + cap.textContent; cap.style.color = 'var(--danger)'; };
      fig.appendChild(el); fig.appendChild(cap);
      grid.appendChild(fig);
    });
    flashTab('render');
  }

  // ---- Dock tabs ---------------------------------------------------------
  function switchDock(name) {
    document.querySelectorAll('.dock-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    document.querySelectorAll('.dock-pane').forEach(function (p) { p.classList.toggle('active', p.dataset.pane === name); });
    if (name === 'terminal') setTimeout(function () { window.GARMTerm.fit(); }, 30);
  }
  function flashTab(name) {
    var tab = document.querySelector('.dock-tab[data-tab="' + name + '"]');
    if (!tab) return;
    tab.style.color = 'var(--text)'; // brighten to full white briefly (--accent was never defined)
    setTimeout(function () { tab.style.color = ''; }, 1200);
  }

  function wireDock() {
    document.querySelectorAll('.dock-tab').forEach(function (t) {
      t.addEventListener('click', function () { switchDock(t.dataset.tab); });
    });
    $('#btn-clear-dock').addEventListener('click', function () {
      var active = document.querySelector('.dock-tab.active').dataset.tab;
      if (active === 'console') $('#console').innerHTML = '';
      else if (active === 'problems') $('#problems').innerHTML = '<div class="empty-hint">Compiler diagnostics appear here.</div>';
      else if (active === 'render') $('#render').innerHTML = '<div class="empty-hint">Plots and images produced by your program appear here.</div>';
    });
  }

  // ---- Toolbar actions ---------------------------------------------------
  function wireToolbar() {
    $('#btn-run').addEventListener('click', function () {
      switchDock('console');
      loadedFile = activeFile;
      garm.code.run(window.GARMEditor.getValue(), activeFile);
    });
    $('#btn-stop').addEventListener('click', function () { garm.run.stop(); });
    $('#btn-save').addEventListener('click', function () { saveActiveFile(); });
    $('#btn-compile').addEventListener('click', function () {
      switchDock('problems');
      var prob = $('#problems');
      prob.innerHTML = '<span class="out-meta">Compiling…</span>';
      garm.code.compile(window.GARMEditor.getValue(), activeFile).then(function (res) {
        if (res.ok) prob.innerHTML = '<span style="color:var(--ok)">No syntax errors. The file compiles cleanly.</span>';
        else prob.innerHTML = '<span class="out-err">' + escapeHtml(res.output || 'Compilation failed.') + '</span>';
      });
    });

    $('#btn-run-pipeline').addEventListener('click', runPipeline);
    $('#btn-cancel-pipeline').addEventListener('click', function () { garm.pipeline.cancel(); });
    $('#prompt').addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runPipeline(); }
    });

    $('#btn-refine').addEventListener('click', runRefine);
    $('#refine-input').addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runRefine(); }
    });

    $('#stdin').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var v = e.target.value;
        garm.run.input(v + '\n');
        appendConsole(v + '\n', false, true);
        e.target.value = '';
      }
    });
  }

  // The last agent operation, so a failed run can be retried in one click from the
  // error toast. Refine/inpaint re-read the CURRENT editor code at retry time (the
  // pipeline restores the original code on failure, so it is the correct base).
  var lastAgentOp = null;

  function retryLastAgentOp() {
    var op = lastAgentOp;
    if (!op || pipelineRunning) return;
    if (!modelReady) { toast('The model is not ready yet — watch the status pill.', 'info'); return; }
    if (op.kind === 'create') { $('#prompt').value = op.req; runPipeline(); }
    else if (op.kind === 'refine') {
      garm.pipeline.refine(op.req, window.GARMEditor.getValue(), activeFile)
        .catch(function (err) { appendConsole('\n[error] ' + err.message + '\n', true); setPipelineRunning(false); stopTimer(); });
    } else if (op.kind === 'inpaint') {
      garm.pipeline.inpaint(op.req, window.GARMEditor.getValue(), op.range, activeFile)
        .catch(function (err) { appendConsole('\n[error] ' + err.message + '\n', true); setPipelineRunning(false); stopTimer(); });
    }
  }

  function runPipeline() {
    var req = $('#prompt').value.trim();
    if (!req) { $('#prompt').focus(); return; }
    if (!modelReady) return;
    lastAgentOp = { kind: 'create', req: req };
    garm.pipeline.run(req).catch(function (err) { appendConsole('\n[error] ' + err.message + '\n', true); setPipelineRunning(false); stopTimer(); });
  }

  // Post-edit agentic iteration: apply a change to the current editor code.
  function runRefine() {
    var req = $('#refine-input').value.trim();
    if (!req) { $('#refine-input').focus(); return; }
    if (!modelReady || pipelineRunning) return;
    var code = window.GARMEditor.getValue();
    lastAgentOp = { kind: 'refine', req: req };
    garm.pipeline.refine(req, code, activeFile).catch(function (err) { appendConsole('\n[error] ' + err.message + '\n', true); setPipelineRunning(false); stopTimer(); });
    $('#refine-input').value = '';
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  // ---- Inpaint: agentic select-and-replace -------------------------------
  var inpaintSelection = null;

  function effectiveEndLine(range) {
    var end = range.endLine;
    if (end > range.startLine && range.endColumn === 1) end -= 1;
    return end;
  }

  function openInpaint(sel) {
    sel = sel || window.GARMEditor.getSelection();
    if (!sel || sel.empty) { flashInpaintHint(); return; }
    if (!modelReady || pipelineRunning) return;
    inpaintSelection = sel;
    var end = effectiveEndLine(sel.range);
    $('#inpaint-range').textContent = sel.range.startLine === end
      ? ('line ' + sel.range.startLine)
      : ('lines ' + sel.range.startLine + '–' + end);
    $('#inpaint-bar').classList.remove('hidden');
    window.GARMEditor.highlightRegion(sel.range);
    window.GARMEditor.layout();
    var input = $('#inpaint-input');
    input.value = '';
    setTimeout(function () { input.focus(); }, 0);
  }

  function closeInpaint() {
    $('#inpaint-bar').classList.add('hidden');
    window.GARMEditor.clearRegion();
    inpaintSelection = null;
    window.GARMEditor.layout();
  }

  function applyInpaint() {
    if (!inpaintSelection) return;
    var instr = $('#inpaint-input').value.trim();
    if (!instr) { $('#inpaint-input').focus(); return; }
    if (!modelReady || pipelineRunning) return;
    var code = window.GARMEditor.getValue();
    var range = inpaintSelection.range;
    closeInpaint();
    switchDock('console');
    lastAgentOp = { kind: 'inpaint', req: instr, range: range };
    garm.pipeline.inpaint(instr, code, range, activeFile).catch(function (err) {
      appendConsole('\n[error] ' + err.message + '\n', true); setPipelineRunning(false); stopTimer();
    });
  }

  function flashInpaintHint() {
    var b = $('#btn-edit-selection');
    if (b.dataset.flashing) return;
    b.dataset.flashing = '1';
    var old = b.textContent;
    b.textContent = 'Select code first';
    b.classList.add('hint');
    setTimeout(function () { b.textContent = old; b.classList.remove('hint'); delete b.dataset.flashing; }, 1300);
  }

  function wireInpaint() {
    $('#btn-edit-selection').addEventListener('click', function () { openInpaint(); });
    window.GARMEditor.onEditSelection(function (sel) { openInpaint(sel); });
    $('#btn-inpaint-apply').addEventListener('click', applyInpaint);
    $('#btn-inpaint-cancel').addEventListener('click', closeInpaint);
    $('#inpaint-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); applyInpaint(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeInpaint(); window.GARMEditor.focus(); }
    });
  }

  // ---- Context memory panel ----------------------------------------------
  function isMemoryEmpty(snap) {
    return !snap || (!snap.summary && !(snap.facts || []).length && !(snap.events || []).length);
  }

  function renderMemory(snap) {
    var body = $('#memory-body');
    if (isMemoryEmpty(snap)) {
      body.innerHTML = '<div class="empty-hint">No memory yet. As the agent builds and edits, it records what the project is and how it behaves here — and you can pin facts it should always remember.</div>';
      return;
    }
    var html = '';
    if (snap.summary) {
      html += '<div class="mem-section"><div class="mem-h">Project</div><div class="mem-summary">' + escapeHtml(snap.summary) + '</div></div>';
    }
    if ((snap.facts || []).length) {
      html += '<div class="mem-section"><div class="mem-h">Pinned facts</div><div class="mem-facts">';
      snap.facts.forEach(function (f, i) {
        html += '<div class="mem-fact"><span>' + escapeHtml(f) + '</span><button class="mem-x" data-fact="' + i + '" title="Forget this fact">×</button></div>';
      });
      html += '</div></div>';
    }
    if ((snap.events || []).length) {
      html += '<div class="mem-section"><div class="mem-h">Recent activity</div><div class="mem-events">';
      snap.events.slice().reverse().forEach(function (e) {
        html += '<div class="mem-event"><span class="mem-kind mem-kind-' + escapeHtml(e.kind) + '">' + escapeHtml(e.kind) + '</span><span class="mem-text">' + escapeHtml(e.text) + '</span></div>';
      });
      html += '</div></div>';
    }
    body.innerHTML = html;
    body.querySelectorAll('.mem-x').forEach(function (btn) {
      btn.addEventListener('click', function () {
        garm.memory.removeFact(parseInt(btn.dataset.fact, 10)).then(renderMemory);
      });
    });
  }

  function addMemoryFact() {
    var v = $('#memory-fact').value.trim();
    if (!v) return;
    garm.memory.addFact(v).then(renderMemory);
    $('#memory-fact').value = '';
  }

  function wireMemory() {
    garm.on('memory:update', renderMemory);
    garm.memory.get().then(renderMemory);
    $('#btn-memory-add').addEventListener('click', addMemoryFact);
    $('#memory-fact').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addMemoryFact(); } });
    $('#btn-memory-clear').addEventListener('click', function () {
      garm.memory.clear().then(renderMemory);
    });
  }

  // ---- Environment / library support -------------------------------------
  var ENV_ORDER = ['Deep learning', 'Classic ML', 'Data & compute', 'Visualization', 'CV / NLP', 'Other'];

  function renderEnv(env) {
    var head = $('#env-python');
    var body = $('#env-body');
    if (!env) { head.textContent = 'Detecting environment…'; body.innerHTML = ''; return; }
    if (env.error) {
      head.textContent = 'Python: not detected';
      body.innerHTML = '<div class="out-err" style="padding:8px 2px">' + escapeHtml(env.error) + '</div>';
      return;
    }
    head.innerHTML = 'Python <b>' + escapeHtml(env.python || '?') + '</b>'
      + (env.executable ? ' <span class="muted small">' + escapeHtml(env.executable) + '</span>' : '');
    var badge = $('#env-venv-badge');
    if (env.is_venv) {
      badge.textContent = (env.conda ? 'conda' : 'venv') + (env.env_name ? ' · ' + env.env_name : '');
      badge.className = 'env-badge venv';
    } else {
      badge.textContent = 'system';
      badge.className = 'env-badge system';
    }
    badge.classList.remove('hidden');
    var libs = env.libs || [];
    var cats = {};
    libs.forEach(function (l) { (cats[l.category] = cats[l.category] || []).push(l); });
    var html = '';
    ENV_ORDER.forEach(function (cat) {
      var arr = cats[cat]; if (!arr) return;
      var on = arr.filter(function (l) { return l.installed; }).length;
      html += '<div class="env-cat"><div class="env-cat-h">' + escapeHtml(cat)
        + ' <span class="muted">' + on + '/' + arr.length + '</span></div><div class="env-chips">';
      arr.forEach(function (l) {
        if (l.installed) {
          html += '<span class="env-chip on" title="installed">' + escapeHtml(l.name)
            + (l.version ? ' <span class="env-ver">' + escapeHtml(l.version) + '</span>' : '') + '</span>';
        } else {
          html += '<span class="env-chip off"><span>' + escapeHtml(l.name)
            + '</span><button class="env-add" data-pkg="' + escapeHtml(l.dist) + '" title="pip install ' + escapeHtml(l.dist) + '">+</button></span>';
        }
      });
      html += '</div></div>';
    });
    body.innerHTML = html;
    body.querySelectorAll('.env-add').forEach(function (b) {
      b.addEventListener('click', function () { startInstall(b.dataset.pkg); });
    });
  }

  function startInstall(spec) {
    if (!spec) return;
    $('#env-install-input').value = spec;
    $('#btn-env-install').disabled = true;
    switchDock('console');
    appendConsole('\n[pip] installing ' + spec + ' …\n', false, true);
    garm.env.install(spec).then(function (res) {
      $('#btn-env-install').disabled = false;
      if (res && res.ok) appendConsole('[pip] ' + spec + ' installed ✓ — library list refreshed.\n', false, true);
      else appendConsole('[pip] install of ' + spec + ' failed' + (res && res.code != null ? ' (exit ' + res.code + ')' : '') + '.\n', true);
    });
  }

  function wireEnv() {
    garm.on('env:update', renderEnv);
    garm.on('env:install-data', function (p) { appendConsole(p.text, p.stream === 'stderr'); });
    garm.on('env:install-start', function () { $('#btn-env-install').disabled = true; });
    garm.on('env:install-exit', function () { $('#btn-env-install').disabled = false; });
    // A run hit a missing dependency: jump to Env, prefill the package, nudge the tab.
    garm.on('pipeline:missingModule', function (p) {
      switchDock('env');
      $('#env-install-input').value = p.pkg;
      flashTab('env');
    });
    garm.env.get().then(renderEnv);
    $('#btn-env-refresh').addEventListener('click', function () {
      $('#env-python').textContent = 'Detecting environment…';
      garm.env.refresh().then(renderEnv);
    });
    $('#btn-env-install').addEventListener('click', function () { startInstall($('#env-install-input').value.trim()); });
    $('#env-install-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); startInstall($('#env-install-input').value.trim()); }
    });
    $('#btn-env-venv').addEventListener('click', function () {
      $('#btn-env-venv').disabled = true;
      switchDock('console');
      appendConsole('\n[venv] creating .venv in the workspace…\n', false, true);
      garm.env.createVenv().then(function (res) {
        $('#btn-env-venv').disabled = false;
        if (res && res.ok) appendConsole('[venv] created and now active: ' + res.pythonPath + '\n      Packages you install from the Env tab now go into this venv; the terminal uses it too.\n', false, true);
        else appendConsole('[venv] failed: ' + ((res && res.error) || 'unknown error') + '\n', true);
      });
    });
  }

  // ---- Toast notifications -------------------------------------------------
  // Transient, non-blocking feedback for actions (save, publish, errors) so the user
  // is never forced to hunt through the Console tab to learn whether something worked.
  // `action` ({ label, run }) renders a button inside the toast — used for one-click
  // recovery ("Retry", "Restart model") right where the failure is reported.
  function toast(message, kind, ms, action) {
    var host = $('#toasts');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + (kind || 'info');
    var msg = document.createElement('span');
    msg.textContent = message;
    el.appendChild(msg);
    if (action && action.label && typeof action.run === 'function') {
      var btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', function (e) { e.stopPropagation(); dismiss(); action.run(); });
      el.appendChild(btn);
    }
    el.addEventListener('click', function () { dismiss(); });
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    var t = setTimeout(dismiss, ms || (kind === 'err' ? 6000 : 3200));
    function dismiss() {
      clearTimeout(t);
      el.classList.remove('show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }
  }

  // ---- GitHub integration --------------------------------------------------
  var ghState = null;   // last github:status snapshot
  var ghUser = null;    // verified account { login, name } once connected
  var ghBusy = false;
  var GH_STEP_NAMES = { git: 'Repository', files: 'Required files', commit: 'Commit', repo: 'GitHub repo', push: 'Push' };

  function ghSummaryText() {
    if (!ghState) return 'Checking repository status…';
    if (!ghState.gitInstalled) return 'git is not installed';
    if (!ghState.isRepo) return 'Not a git repository yet · git ' + ghState.gitVersion;
    var bits = [ghState.branch || 'main'];
    bits.push(ghState.changeCount === 0 ? 'clean' : ghState.changeCount + ' change' + (ghState.changeCount === 1 ? '' : 's'));
    if (ghState.webUrl) bits.push(ghState.webUrl.replace(/^https:\/\//, ''));
    return bits.join(' · ');
  }

  function loadGitHubStatus() {
    return garm.github.status().then(function (st) {
      ghState = st;
      renderGitHub();
      return st;
    });
  }

  function ghBadge() {
    var b = $('#gh-badge');
    if (!b) return;
    var n = ghState && ghState.isRepo ? ghState.changeCount : 0;
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('hidden', !n);
  }

  function renderGitHub() {
    $('#gh-summary').textContent = ghSummaryText();
    $('#btn-gh-open').classList.toggle('hidden', !(ghState && ghState.webUrl));
    ghBadge();
    var body = $('#gh-body');
    if (!ghState) { body.innerHTML = '<div class="empty-hint">Checking git and repository status…</div>'; return; }

    var html = '';
    if (!ghState.gitInstalled) {
      html += '<div class="gh-card gh-card-warn"><div class="gh-card-title">git is not installed</div>' +
        '<div class="gh-card-sub">Cicada’s GitHub integration uses your own git. Install it from ' +
        '<a href="#" id="gh-git-link">git-scm.com/downloads</a>, then hit Refresh.</div></div>';
      body.innerHTML = html;
      var gl = $('#gh-git-link');
      if (gl) gl.addEventListener('click', function (e) { e.preventDefault(); garm.shell.openExternal('https://git-scm.com/downloads'); });
      return;
    }

    // Account: connected chip, or token entry.
    if (ghUser) {
      html += '<div class="gh-card"><div class="gh-card-title">Account</div>' +
        '<div class="gh-account"><span class="gh-avatar-dot"></span>Connected as <b>' + escapeHtml(ghUser.login) + '</b>' +
        '<button id="btn-gh-disconnect" class="btn btn-ghost btn-sm gh-right">Change token</button></div></div>';
    } else {
      html += '<div class="gh-card"><div class="gh-card-title">Connect your GitHub account</div>' +
        '<div class="gh-card-sub">Paste a personal access token with the <code>repo</code> scope. It is stored only on this machine and sent only to github.com. ' +
        '<a href="#" id="gh-token-link">Create a token →</a></div>' +
        '<div class="gh-row"><input id="gh-token" type="password" placeholder="ghp_… or github_pat_…" spellcheck="false" autocomplete="off" />' +
        '<button id="btn-gh-connect" class="btn btn-accent btn-sm">Connect</button></div></div>';
    }

    // Repository state.
    if (ghState.isRepo) {
      html += '<div class="gh-card"><div class="gh-card-title">Repository</div><div class="gh-kv">';
      html += '<span>Branch</span><b>' + escapeHtml(ghState.branch || '—') + '</b>';
      if (ghState.lastCommit) html += '<span>Last commit</span><b>' + escapeHtml(ghState.lastCommit.subject) + ' <i class="muted">' + escapeHtml(ghState.lastCommit.when) + '</i></b>';
      if (ghState.remoteUrl) html += '<span>Remote</span><b class="gh-mono">' + escapeHtml(ghState.remoteUrl) + '</b>';
      html += '</div>';
      if (ghState.changeCount) {
        var shown = ghState.changes.slice(0, 8);
        html += '<div class="gh-changes"><div class="gh-card-sub">' + ghState.changeCount + ' uncommitted change' + (ghState.changeCount === 1 ? '' : 's') + ':</div>';
        shown.forEach(function (c) { html += '<div class="gh-change"><span class="gh-chg-' + escapeHtml((c.status || '?').charAt(0)) + '">' + escapeHtml(c.status || '?') + '</span>' + escapeHtml(c.path) + '</div>'; });
        if (ghState.changeCount > shown.length) html += '<div class="gh-change muted">+ ' + (ghState.changeCount - shown.length) + ' more…</div>';
        html += '</div>';
      } else if (ghState.hasCommits) {
        html += '<div class="gh-card-sub gh-clean">Working tree clean — everything is committed.</div>';
      }
      html += '</div>';
    }

    // Publish (no remote yet) or Commit & Push (already linked).
    if (!ghState.remoteUrl) {
      var defName = (($('#project-name').textContent || 'cicada-project').trim()).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'cicada-project';
      html += '<div class="gh-card"><div class="gh-card-title">Publish to GitHub</div>' +
        '<div class="gh-card-sub">One click: Cicada generates the required repo files (README.md, .gitignore, LICENSE, requirements.txt), initializes git, commits everything, creates the repository on your account, and pushes.</div>' +
        '<div class="gh-form">' +
        '<label>Repository name<input id="gh-name" type="text" value="' + escapeHtml(defName) + '" spellcheck="false" /></label>' +
        '<label>Description<input id="gh-desc" type="text" placeholder="What does this project do? (used in the README too)" /></label>' +
        '<label class="gh-check"><input id="gh-private" type="checkbox" checked /> Private repository</label>' +
        '</div>' +
        '<div class="gh-row gh-row-end">' +
        '<button id="btn-gh-genfiles" class="btn btn-ghost btn-sm" title="Only generate README.md / .gitignore / LICENSE / requirements.txt into the project — no git required">Generate files only</button>' +
        '<button id="btn-gh-publish" class="btn btn-accent btn-sm"' + (ghUser ? '' : ' disabled title="Connect your GitHub account first"') + '>Publish to GitHub</button>' +
        '</div></div>';
    } else {
      html += '<div class="gh-card"><div class="gh-card-title">Sync</div>' +
        '<div class="gh-row"><input id="gh-msg" type="text" placeholder="Commit message — e.g. “add plotting”" />' +
        '<button id="btn-gh-pushall" class="btn btn-accent btn-sm"' + (ghUser ? '' : ' disabled title="Connect your GitHub account first"') + '>Commit &amp; Push</button></div>' +
        '<div class="gh-row gh-row-end"><button id="btn-gh-genfiles" class="btn btn-ghost btn-sm" title="Re-generate any missing repo files (existing files are never overwritten)">Generate missing repo files</button></div></div>';
    }

    // Progress steps (filled by github:progress while publishing/pushing).
    html += '<div id="gh-steps" class="gh-steps"></div>';
    body.innerHTML = html;

    // Wire the freshly rendered controls.
    var tl = $('#gh-token-link');
    if (tl) tl.addEventListener('click', function (e) { e.preventDefault(); garm.shell.openExternal('https://github.com/settings/tokens/new?scopes=repo&description=Cicada%20IDE'); });
    var conn = $('#btn-gh-connect');
    if (conn) conn.addEventListener('click', ghConnect);
    var tok = $('#gh-token');
    if (tok) tok.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ghConnect(); } });
    var disc = $('#btn-gh-disconnect');
    if (disc) disc.addEventListener('click', function () { ghUser = null; renderGitHub(); });
    var pub = $('#btn-gh-publish');
    if (pub) pub.addEventListener('click', ghPublish);
    var pushBtn = $('#btn-gh-pushall');
    if (pushBtn) pushBtn.addEventListener('click', ghPush);
    var msg = $('#gh-msg');
    if (msg) msg.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ghPush(); } });
    var gen = $('#btn-gh-genfiles');
    if (gen) gen.addEventListener('click', ghGenerateFiles);
  }

  function ghConnect() {
    var token = ($('#gh-token') ? $('#gh-token').value : '').trim();
    if (!token) { $('#gh-token').focus(); return; }
    $('#btn-gh-connect').disabled = true;
    garm.github.verifyToken(token).then(function (r) {
      if (r.ok) { ghUser = r; toast('Connected to GitHub as ' + r.login, 'ok'); renderGitHub(); }
      else { toast(r.error || 'Could not verify the token.', 'err'); var b = $('#btn-gh-connect'); if (b) b.disabled = false; }
    });
  }

  function ghStepUpdate(p) {
    var host = $('#gh-steps');
    if (!host) return;
    var row = host.querySelector('[data-step="' + p.step + '"]');
    if (!row) {
      row = document.createElement('div');
      row.className = 'gh-step';
      row.dataset.step = p.step;
      row.innerHTML = '<span class="gh-step-ico"></span><span class="gh-step-name">' + escapeHtml(GH_STEP_NAMES[p.step] || p.step) + '</span><span class="gh-step-detail"></span>';
      host.appendChild(row);
    }
    row.className = 'gh-step gh-step-' + p.state;
    row.querySelector('.gh-step-ico').textContent = p.state === 'done' ? '✓' : (p.state === 'error' ? '✕' : '…');
    if (p.detail) row.querySelector('.gh-step-detail').textContent = p.detail;
  }

  function ghPublish() {
    if (ghBusy || !ghUser) return;
    var name = ($('#gh-name') ? $('#gh-name').value : '').trim();
    if (!name) { $('#gh-name').focus(); return; }
    ghBusy = true;
    $('#btn-gh-publish').disabled = true;
    var steps = $('#gh-steps'); if (steps) steps.innerHTML = '';
    garm.github.publish({
      repoName: name,
      description: ($('#gh-desc') ? $('#gh-desc').value : '').trim(),
      isPrivate: !!($('#gh-private') && $('#gh-private').checked),
    }).then(function (res) {
      ghBusy = false;
      if (res.ok) {
        toast('Published to GitHub: ' + res.htmlUrl, 'ok', 5000);
        if (res.tree) renderTree(res.tree);
        ghState = res.status; renderGitHub();
      } else {
        toast(res.error || 'Publishing failed.', 'err');
        var b = $('#btn-gh-publish'); if (b) b.disabled = false;
      }
    }).catch(function (err) {
      ghBusy = false;
      toast(err.message, 'err');
      var b = $('#btn-gh-publish'); if (b) b.disabled = false;
    });
  }

  function ghPush() {
    if (ghBusy || !ghUser) return;
    ghBusy = true;
    var b = $('#btn-gh-pushall'); if (b) b.disabled = true;
    var steps = $('#gh-steps'); if (steps) steps.innerHTML = '';
    flushEditor(); // push what's on screen, not a stale saved copy
    garm.github.push(($('#gh-msg') ? $('#gh-msg').value : '').trim()).then(function (res) {
      ghBusy = false;
      if (res.ok) { toast('Pushed to GitHub.', 'ok'); ghState = res.status; renderGitHub(); }
      else { toast(res.error || 'Push failed.', 'err'); var btn = $('#btn-gh-pushall'); if (btn) btn.disabled = false; }
    }).catch(function (err) { ghBusy = false; toast(err.message, 'err'); var btn = $('#btn-gh-pushall'); if (btn) btn.disabled = false; });
  }

  function ghGenerateFiles() {
    garm.github.generateFiles({}).then(function (res) {
      if (res.written && res.written.length) toast('Generated: ' + res.written.join(', '), 'ok');
      else toast('All repo files already exist — nothing to generate.', 'info');
      if (res.tree) renderTree(res.tree);
      loadGitHubStatus();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function wireGitHub() {
    garm.on('github:progress', ghStepUpdate);
    $('#btn-gh-refresh').addEventListener('click', loadGitHubStatus);
    $('#btn-gh-open').addEventListener('click', function () { if (ghState && ghState.webUrl) garm.shell.openExternal(ghState.webUrl); });
    // Re-check whenever the tab is opened (cheap: a couple of git subcommands).
    var tab = document.querySelector('.dock-tab[data-tab="github"]');
    if (tab) tab.addEventListener('click', function () { loadGitHubStatus(); });
    // Reconnect silently with the saved token, then take the first status snapshot.
    garm.config.get().then(function (cfg) {
      if (cfg && cfg.githubToken) {
        garm.github.verifyToken(cfg.githubToken).then(function (r) { if (r.ok) { ghUser = r; renderGitHub(); } });
      }
    });
    loadGitHubStatus();
  }

  // ---- Model status ------------------------------------------------------
  function applyStatus(status, detail) {
    var pill = $('#model-status');
    var text = pill.querySelector('.status-text');
    pill.className = 'status-pill status-' + (status || 'stopped');
    modelReady = status === 'ready';
    if (status === 'starting') { text.textContent = detail && /restart|crash/i.test(detail) ? 'Restarting model…' : 'Loading model'; pill.title = detail || ''; }
    else if (status === 'ready') { text.textContent = 'Model ready'; pill.title = detail || ''; }
    else if (status === 'error') {
      // Keep the pill readable; the full reason lives in the tooltip and the click
      // action below offers one-click recovery.
      var brief = String(detail || 'see logs');
      text.textContent = 'Error: ' + (brief.length > 60 ? brief.slice(0, 57) + '…' : brief) + ' — click to retry';
      pill.title = brief + '\nClick to retry (re-detects the binary and model, restarts the server).';
    } else { text.textContent = 'Stopped — click to start'; pill.title = 'Click to start the local model.'; }
    $('#btn-run-pipeline').disabled = pipelineRunning || !modelReady;
    $('#btn-refine').disabled = pipelineRunning || !modelReady;
    $('#btn-edit-selection').disabled = pipelineRunning || !modelReady;
    $('#btn-inpaint-apply').disabled = pipelineRunning || !modelReady;
  }

  var llamaInstalling = false;
  var llamaRecovering = false;
  function wireStatus() {
    garm.on('llama:status', function (p) {
      // While auto-downloading llama.cpp, keep the install progress in the pill until it
      // finishes — don't let a stale 'stopped'/'error' snapshot overwrite it.
      if (llamaInstalling && p.status !== 'ready') return;
      applyStatus(p.status, p.detail);
    });
    garm.on('llama:log', function () { /* available for a future logs panel */ });
    // First-run auto-setup (llama.cpp binary and/or the default model): reflect each
    // phase in the status pill.
    garm.on('llama:install', function (p) {
      var pill = $('#model-status');
      var text = pill.querySelector('.status-text');
      if (p.state === 'done') {
        llamaInstalling = false;
        toast(p.detail === 'model' ? 'Model downloaded — starting it…' : 'llama.cpp installed — starting the model…', 'ok');
        return; // server-start status events take over from here
      }
      if (p.state === 'error') {
        llamaInstalling = false;
        applyStatus('error', p.detail);
        toast('Setup problem: ' + p.detail, 'err', 9000,
          { label: 'Retry', run: function () { garm.llama.recover(); } });
        return;
      }
      llamaInstalling = true;
      modelReady = false;
      pill.className = 'status-pill status-starting';
      text.textContent = p.detail || 'Setting up llama.cpp…';
    });
    // Click the pill to self-heal: re-detect/download the binary and model, restart
    // the server. Only meaningful when not already ready/starting.
    $('#model-status').addEventListener('click', function () {
      if (modelReady || llamaInstalling || llamaRecovering) return;
      var pill = $('#model-status');
      if (!/status-error|status-stopped/.test(pill.className)) return;
      llamaRecovering = true;
      applyStatus('starting', 'Recovering…');
      garm.llama.recover().then(function (s) {
        llamaRecovering = false;
        if (s) applyStatus(s.status, s.detail);
      }).catch(function () { llamaRecovering = false; });
    });
    garm.llama.info().then(function (info) { applyStatus(info.status, info.lastError); });
  }

  // ---- Settings ----------------------------------------------------------
  var SERVER_FIELDS = ['modelPath', 'serverPort', 'contextSize', 'gpuLayers', 'llamaServerPath'];

  // Show the DeepSeek fields or the local-server fields depending on the chosen provider.
  function applyProviderVisibility(provider) {
    var ds = provider === 'deepseek';
    $('#deepseek-only').classList.toggle('hidden', !ds);
    $('#local-only').classList.toggle('hidden', ds);
  }

  function openSettings() {
    garm.config.get().then(function (cfg) {
      currentConfig = cfg;
      $('#cfg-provider').value = cfg.provider || 'local';
      $('#cfg-deepseekModel').value = cfg.deepseekModel || 'deepseek-v4-flash';
      $('#cfg-deepseekApiKey').value = cfg.deepseekApiKey || '';
      $('#cfg-modelPath').value = cfg.modelPath;
      $('#cfg-llamaServerPath').value = cfg.llamaServerPath || '';
      $('#cfg-serverPort').value = cfg.serverPort;
      $('#cfg-contextSize').value = cfg.contextSize;
      $('#cfg-gpuLayers').value = cfg.gpuLayers;
      $('#cfg-temperature').value = cfg.temperature;
      $('#cfg-maxTokens').value = cfg.maxTokens;
      $('#cfg-maxFixIterations').value = cfg.maxFixIterations;
      $('#cfg-pythonPath').value = cfg.pythonPath;
      applyProviderVisibility(cfg.provider || 'local');
      $('#settings-overlay').classList.remove('hidden');
      populateDetectedPythons();
    });
  }

  // List the interpreters GARM found (venvs near the workspace, conda, system) as
  // clickable chips that fill the interpreter field.
  function populateDetectedPythons() {
    var row = $('#cfg-python-detected');
    row.innerHTML = '<span class="detected-label">Scanning…</span>';
    garm.env.discover().then(function (list) {
      row.innerHTML = '';
      if (!list || !list.length) return;
      var lbl = document.createElement('span');
      lbl.className = 'detected-label';
      lbl.textContent = 'Detected:';
      row.appendChild(lbl);
      list.forEach(function (it) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'detected-chip';
        chip.textContent = it.label + ' · ' + it.version;
        chip.title = it.path;
        chip.addEventListener('click', function () { $('#cfg-pythonPath').value = it.path; });
        row.appendChild(chip);
      });
    });
  }
  function wireSettings() {
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-close-settings').addEventListener('click', function () { $('#settings-overlay').classList.add('hidden'); });
    $('#cfg-provider').addEventListener('change', function () { applyProviderVisibility(this.value); });
    $('#link-deepseek-key').addEventListener('click', function (e) {
      e.preventDefault();
      garm.shell.openExternal('https://platform.deepseek.com/api_keys');
    });
    $('#btn-pick-model').addEventListener('click', function () {
      garm.dialog.pickModel().then(function (p) { if (p) $('#cfg-modelPath').value = p; });
    });
    $('#btn-pick-python').addEventListener('click', function () {
      garm.dialog.pickPython().then(function (p) { if (p) $('#cfg-pythonPath').value = p; });
    });
    $('#btn-pick-llama').addEventListener('click', function () {
      garm.dialog.pickLlamaServer().then(function (p) { if (p) $('#cfg-llamaServerPath').value = p; });
    });
    $('#btn-save-settings').addEventListener('click', function () {
      var next = {
        provider: $('#cfg-provider').value,
        deepseekModel: $('#cfg-deepseekModel').value,
        deepseekApiKey: $('#cfg-deepseekApiKey').value.trim(),
        modelPath: $('#cfg-modelPath').value.trim(),
        llamaServerPath: $('#cfg-llamaServerPath').value.trim(),
        serverPort: parseInt($('#cfg-serverPort').value, 10),
        contextSize: parseInt($('#cfg-contextSize').value, 10),
        gpuLayers: parseInt($('#cfg-gpuLayers').value, 10),
        temperature: parseFloat($('#cfg-temperature').value),
        maxTokens: parseInt($('#cfg-maxTokens').value, 10),
        maxFixIterations: parseInt($('#cfg-maxFixIterations').value, 10),
        pythonPath: $('#cfg-pythonPath').value.trim(),
      };
      var serverChanged = currentConfig && SERVER_FIELDS.some(function (k) { return currentConfig[k] !== next[k]; });
      $('#settings-overlay').classList.add('hidden');
      // Only the local server needs a restart (and only when its settings changed). For
      // DeepSeek — or any other change — config:set applies it and pushes a fresh status.
      if (next.provider === 'local' && serverChanged) { applyStatus('starting'); garm.llama.restart(next); }
      else garm.config.set(next);
      currentConfig = next;
    });
  }

  // ---- Splitters ---------------------------------------------------------
  function wireSplitters() {
    var agent = $('#agent');
    var dock = $('#dock');
    document.querySelectorAll('.splitter').forEach(function (sp) {
      sp.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var kind = sp.dataset.split;
        var startX = e.clientX, startY = e.clientY;
        var startW = agent.offsetWidth, startH = dock.offsetHeight;
        function move(ev) {
          if (kind === 'agent') {
            var w = Math.min(640, Math.max(280, startW + (ev.clientX - startX)));
            agent.style.flex = '0 0 ' + w + 'px';
            agent.style.width = w + 'px';
          } else if (kind === 'dock') {
            var h = Math.min(560, Math.max(120, startH - (ev.clientY - startY)));
            dock.style.flex = '0 0 ' + h + 'px';
            dock.style.height = h + 'px';
            window.GARMEditor.layout();
          }
        }
        function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); window.GARMTerm.fit(); window.GARMEditor.layout(); }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
    window.addEventListener('resize', function () { window.GARMTerm.fit(); window.GARMEditor.layout(); });
  }

  // ---- Output structure toggle (single file vs multi-file repo) ----------
  // Lets the user choose how the agent emits a NEW program: one self-contained main.py,
  // or a proper multi-file project (packages/modules with accurate imports). The choice
  // is persisted to config (agentOutputMode) and read by the pipeline at run time.
  var outputMode = 'single';
  function setOutputMode(mode, persist) {
    outputMode = mode === 'repo' ? 'repo' : 'single';
    document.querySelectorAll('#output-mode .om-opt').forEach(function (b) {
      var on = b.dataset.mode === outputMode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    if (persist) garm.config.set({ agentOutputMode: outputMode });
  }
  function wireOutputMode() {
    document.querySelectorAll('#output-mode .om-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        if (pipelineRunning) return; // can't change structure mid-run
        setOutputMode(b.dataset.mode, true);
      });
    });
    garm.config.get().then(function (cfg) { setOutputMode(cfg && cfg.agentOutputMode, false); });
  }

  // ---- Misc --------------------------------------------------------------
  function wireMisc() {
    $('#btn-workspace').addEventListener('click', function () { garm.shell.showWorkspace(); });
  }

  // ---- Custom window controls (frameless Windows/Linux title bar) ---------
  function wireWindowControls() {
    // Tag the body so CSS can show the controls, drop the macOS traffic-light inset,
    // and (later) swap the maximize/restore glyph.
    garm.window.platform().then(function (p) {
      var cls = p === 'darwin' ? 'platform-mac' : (p === 'win32' ? 'platform-win' : 'platform-linux');
      document.body.classList.add(cls);
    });
    $('#win-min').addEventListener('click', function () { garm.window.minimize(); });
    $('#win-max').addEventListener('click', function () { garm.window.maximize(); });
    $('#win-close').addEventListener('click', function () { garm.window.close(); });
    // Double-clicking the drag region toggles maximize, matching native behaviour.
    $('#topbar').addEventListener('dblclick', function (e) {
      if (e.target.closest('button, input, .proj-switch, .status-pill')) return;
      garm.window.maximize();
    });
    garm.on('window:state', function (s) { document.body.classList.toggle('window-maximized', !!s.maximized); });
    garm.window.isMaximized().then(function (m) { document.body.classList.toggle('window-maximized', !!m); });
  }

  // ---- Projects + Files explorer ----------------------------------------
  var activeFile = 'main.py';  // project-relative path shown in the editor tab
  var loadedFile = null;       // the file whose content is actually in the editor
  var fileTree = [];
  var collapsed = {};          // rel dir path -> true when collapsed
  var ftNewKind = null;        // 'file' | 'dir' while the inline create input is open
  var autosaveTimer = null;
  var autosaveArmed = false;
  var saveGeneration = 0;

  function showSaveState(state, label) {
    var el = $('#save-state');
    if (!el) return;
    el.className = 'save-state ' + state;
    el.textContent = label || (state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Unsaved' : state === 'error' ? 'Save failed' : 'Saved');
  }

  function scheduleAutosave() {
    if (!autosaveArmed || !loadedFile || pipelineRunning) return;
    showSaveState('dirty');
    clearTimeout(autosaveTimer);
    var file = loadedFile;
    var generation = ++saveGeneration;
    autosaveTimer = setTimeout(function () {
      if (pipelineRunning || file !== loadedFile || generation !== saveGeneration) return;
      showSaveState('saving');
      garm.files.save(file, window.GARMEditor.getValue()).then(function () {
        if (generation === saveGeneration && file === loadedFile) showSaveState('saved');
      }).catch(function (err) {
        showSaveState('error');
        toast('Autosave failed: ' + err.message, 'err');
      });
    }, 850);
  }

  function setActiveFile(rel) {
    activeFile = rel || 'main.py';
    $('#file-name').textContent = activeFile;
    document.querySelectorAll('#filetree .ft-node.file').forEach(function (n) {
      n.classList.toggle('active', n.dataset.path === activeFile);
    });
  }

  function pathInTree(nodes, rel) {
    for (var i = 0; i < (nodes || []).length; i++) {
      if (nodes[i].path === rel) return true;
      if (nodes[i].children && pathInTree(nodes[i].children, rel)) return true;
    }
    return false;
  }
  function firstFilePath(nodes) {
    for (var i = 0; i < (nodes || []).length; i++) if (nodes[i].type === 'file') return nodes[i].path;
    for (var j = 0; j < (nodes || []).length; j++) {
      if (nodes[j].type === 'dir') { var f = firstFilePath(nodes[j].children); if (f) return f; }
    }
    return '';
  }

  // Persist the file currently in the editor before we replace it (never clobbers a
  // file we never actually loaded, and never fights the agent mid-run).
  function flushEditor() {
    clearTimeout(autosaveTimer);
    if (loadedFile && !pipelineRunning) garm.files.save(loadedFile, window.GARMEditor.getValue());
  }

  function openFile(rel) {
    if (!rel || rel === loadedFile) { if (rel) setActiveFile(rel); return Promise.resolve(); }
    if (/\.ipynb$/i.test(rel)) {
      flushEditor();
      return loadNotebook(rel).then(function () { setActiveFile(rel); loadedFile = null; return true; });
    }
    flushEditor();
    return garm.files.read(rel).then(function (res) {
      if (res.openable === false) {
        // Binary / oversized / folder: like a standard IDE, show a muted notice and leave the
        // currently open file untouched rather than treating it as an error.
        appendConsole('\n[files] ' + rel + ': ' + res.reason + '\n', false, true);
        return false;
      }
      autosaveArmed = false;
      window.GARMEditor.setValue(res.content);
      loadedFile = res.path;
      setActiveFile(res.path);
      showSaveState('saved');
      setTimeout(function () { autosaveArmed = true; }, 0);
      return true;
    }).catch(function (err) {
      // Strip Electron's "Error invoking remote method '...': Error:" IPC wrapper so genuine
      // failures (e.g. a file deleted out from under us) read as plain English.
      var msg = (err && err.message ? err.message : String(err))
        .replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
      appendConsole('\n[files] ' + msg + '\n', true);
      return false;
    });
  }

  function renderTree(nodes) {
    fileTree = nodes || [];
    var root = $('#filetree');
    root.innerHTML = '';
    if (!fileTree.length) {
      root.innerHTML = '<div class="ft-empty">No files yet. Use ＋ to add one — a path like models/net.py creates the folder too.</div>';
      return;
    }
    root.appendChild(buildNodes(fileTree));
  }

  function buildNodes(nodes) {
    var frag = document.createDocumentFragment();
    nodes.forEach(function (node) {
      var isDir = node.type === 'dir';
      var isCol = isDir && collapsed[node.path];
      var row = document.createElement('div');
      row.className = 'ft-node ' + node.type + (isCol ? ' collapsed' : '') + (!isDir && node.path === activeFile ? ' active' : '');
      row.dataset.path = node.path;
      var ico = document.createElement('span'); ico.className = 'ft-ico'; ico.textContent = isDir ? '▾' : '·';
      var lbl = document.createElement('span'); lbl.className = 'ft-label'; lbl.textContent = node.name;
      var del = document.createElement('button'); del.className = 'ft-del'; del.title = 'Move to Trash'; del.textContent = '×';
      del.addEventListener('click', function (e) { e.stopPropagation(); deleteEntry(node); });
      row.appendChild(ico); row.appendChild(lbl); row.appendChild(del);
      row.addEventListener('click', function () {
        if (isDir) { collapsed[node.path] = !collapsed[node.path]; renderTree(fileTree); }
        else openFile(node.path);
      });
      frag.appendChild(row);
      if (isDir && !isCol && node.children && node.children.length) {
        var kids = document.createElement('div');
        kids.className = 'ft-children';
        kids.appendChild(buildNodes(node.children));
        frag.appendChild(kids);
      }
    });
    return frag;
  }

  function refreshTree() { return garm.files.tree().then(renderTree); }

  function deleteEntry(node) {
    garm.files.remove(node.path).then(function (res) {
      renderTree(res.tree);
      var goneIsOpen = loadedFile && (loadedFile === node.path || loadedFile.indexOf(node.path + '/') === 0);
      if (goneIsOpen) { loadedFile = null; openFile(pathInTree(res.tree, 'main.py') ? 'main.py' : firstFilePath(res.tree)); }
      // Deleting an ingested data file through the explorer: refresh the Data tab so its
      // card reflects the now-missing file instead of showing a stale "ready" entry.
      if (node.path === 'data' || node.path.indexOf('data/') === 0) loadDatasets();
    }).catch(function (err) { appendConsole('\n[files] ' + err.message + '\n', true); });
  }

  function openNew(kind) {
    ftNewKind = kind;
    $('#ft-new-kind').textContent = kind === 'dir' ? 'folder' : 'file';
    $('#ft-new').classList.remove('hidden');
    var i = $('#ft-new-input');
    i.value = '';
    i.placeholder = kind === 'dir' ? 'models   or   data/raw' : 'utils.py   or   models/net.py';
    setTimeout(function () { i.focus(); }, 0);
  }
  function closeNew() { ftNewKind = null; $('#ft-new').classList.add('hidden'); $('#ft-new-input').value = ''; }
  function commitNew() {
    var rel = $('#ft-new-input').value.trim();
    if (!rel) { closeNew(); return; }
    var kind = ftNewKind;
    (kind === 'dir' ? garm.files.mkdir(rel) : garm.files.create(rel)).then(function (res) {
      renderTree(res.tree);
      if (kind === 'file' && res.path) openFile(res.path);
      closeNew();
    }).catch(function (err) { appendConsole('\n[files] ' + err.message + '\n', true); $('#ft-new-input').focus(); });
  }

  // ---- Project switcher ----
  function setProjectName(list) {
    var a = (list || []).find(function (p) { return p.active; });
    if (a) $('#project-name').textContent = a.name;
  }

  function renderProjectMenu() {
    garm.projects.list().then(function (list) {
      setProjectName(list);
      var menu = $('#project-menu');
      menu.innerHTML = '';
      (list || []).forEach(function (p) {
        var it = document.createElement('div');
        it.className = 'proj-item' + (p.active ? ' active' : '');
        var nm = document.createElement('span'); nm.className = 'proj-name'; nm.textContent = p.name;
        it.appendChild(nm);
        if (p.external) { var ex = document.createElement('span'); ex.className = 'proj-ext'; ex.textContent = 'external'; it.appendChild(ex); }
        it.addEventListener('click', function () { switchToProject(p.path); });
        menu.appendChild(it);
      });
      var sep = document.createElement('div'); sep.className = 'proj-sep'; menu.appendChild(sep);
      var nw = document.createElement('div'); nw.className = 'proj-new';
      var inp = document.createElement('input'); inp.id = 'proj-new-input'; inp.type = 'text';
      inp.placeholder = 'New project name…'; inp.spellcheck = false;
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); createProject(inp.value.trim()); }
        else if (e.key === 'Escape') { e.preventDefault(); closeProjectMenu(); }
      });
      nw.appendChild(inp); menu.appendChild(nw);
    });
  }
  function toggleProjectMenu() {
    var menu = $('#project-menu');
    if (menu.classList.contains('hidden')) { renderProjectMenu(); menu.classList.remove('hidden'); }
    else closeProjectMenu();
  }
  function closeProjectMenu() { $('#project-menu').classList.add('hidden'); }

  function loadProjectState(state) {
    setProjectName(state.list);
    collapsed = {};
    loadedFile = null;
    renderTree(state.tree || []);
    var open = state.defaultFile || (pathInTree(state.tree, 'main.py') ? 'main.py' : firstFilePath(state.tree));
    if (open) openFile(open); else { window.GARMEditor.setValue(''); setActiveFile('main.py'); }
    garm.memory.get().then(renderMemory);
    loadDatasets(); // refresh the Data tab for the newly opened project
    loadGitHubStatus(); // repo state is per-project too
    $('#console').innerHTML = '';
  }

  function switchToProject(path) {
    closeProjectMenu();
    flushEditor();
    garm.projects.open(path).then(loadProjectState).catch(function (err) { appendConsole('\n[project] ' + err.message + '\n', true); });
  }
  function createProject(name) {
    if (!name) return;
    flushEditor();
    garm.projects.create(name).then(loadProjectState).catch(function (err) {
      appendConsole('\n[project] ' + err.message + '\n', true);
      var i = $('#proj-new-input'); if (i) i.focus();
    });
  }

  function wireExplorer() {
    $('#btn-new-file').addEventListener('click', function () { openNew('file'); });
    $('#btn-new-folder').addEventListener('click', function () { openNew('dir'); });
    $('#btn-refresh-files').addEventListener('click', refreshTree);
    $('#ft-new-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitNew(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeNew(); }
    });
    $('#btn-project').addEventListener('click', function (e) { e.stopPropagation(); toggleProjectMenu(); });
    document.addEventListener('click', function (e) {
      if (!$('#project-switcher').contains(e.target)) closeProjectMenu();
    });
    // Initial load: tree + active project name + open the entry file.
    garm.projects.list().then(setProjectName);
    garm.files.tree().then(function (t) {
      renderTree(t);
      var open = pathInTree(t, 'main.py') ? 'main.py' : firstFilePath(t);
      if (open) openFile(open);
    });
  }

  // ---- Chat agent --------------------------------------------------------
  // A context-aware assistant: the main process injects a snapshot of the whole project, and the
  // editor's right-click "Ask GARM Chat" can attach the exact selected lines. Replies stream in as
  // Markdown and are rendered with syntax-highlighted code (via Monaco) and lightweight math.
  var chatTurns = [];       // [{ role, content, context? }] conversation sent to the model
  var chatAttach = null;    // pending editor attachment for the next user message
  var chatStreaming = false;
  var chatRaw = '';         // accumulating assistant text for the in-flight reply
  var chatStreamEl = null;  // the assistant bubble currently being streamed into

  function openChat(sel) {
    switchDock('chat');
    if (sel && sel.range && !sel.empty) setChatAttach(sel);
    setTimeout(function () { $('#chat-input').focus(); }, 0);
  }

  function setChatAttach(sel) {
    chatAttach = {
      file: activeFile, language: 'python',
      selection: { startLine: sel.range.startLine, endLine: sel.range.endLine, text: sel.text },
    };
    var bar = $('#chat-attach');
    bar.classList.remove('hidden');
    bar.innerHTML = '<span class="chat-chip"><span class="chip-dot"></span>' + escapeHtml(activeFile) +
      ' · lines ' + sel.range.startLine + '–' + sel.range.endLine +
      '<button class="chip-x" title="Remove attached lines">×</button></span>';
    bar.querySelector('.chip-x').addEventListener('click', clearChatAttach);
  }
  function clearChatAttach() {
    chatAttach = null;
    var bar = $('#chat-attach'); bar.classList.add('hidden'); bar.innerHTML = '';
  }

  function chatBubble(role) {
    var empty = $('#chat-empty'); if (empty) empty.remove();
    var wrap = document.createElement('div');
    wrap.className = 'chat-msg chat-' + role;
    var body = document.createElement('div');
    body.className = 'chat-md';
    wrap.appendChild(body);
    $('#chat-body').appendChild(wrap);
    $('#chat-body').scrollTop = $('#chat-body').scrollHeight;
    return body;
  }

  function setChatSendUI(streaming) {
    var btn = $('#btn-chat-send');
    btn.classList.toggle('is-streaming', streaming);
    btn.title = streaming ? 'Stop' : 'Send (⌘↵)';
  }

  function sendChat() {
    if (chatStreaming) return;
    var input = $('#chat-input');
    var text = input.value.trim();
    if (!text) { input.focus(); return; }

    var ub = chatBubble('user');
    var tag = (chatAttach && chatAttach.selection)
      ? '<div class="chat-attach-tag">' + escapeHtml(chatAttach.file) + ' · lines ' +
        chatAttach.selection.startLine + '–' + chatAttach.selection.endLine + '</div>' : '';
    ub.innerHTML = tag + '<div class="chat-user-text">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';

    var turn = { role: 'user', content: text };
    if (chatAttach) turn.context = chatAttach;
    chatTurns.push(turn);
    input.value = ''; input.style.height = 'auto';
    clearChatAttach();

    if (!modelReady) {
      chatBubble('assistant').innerHTML = '<span class="chat-note">Model is not ready yet — set a provider in Settings.</span>';
      chatTurns.pop();
      return;
    }

    chatRaw = '';
    chatStreamEl = chatBubble('assistant');
    chatStreamEl.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>';
    chatStreaming = true; setChatSendUI(true);

    garm.chat.send(chatTurns).catch(function (err) {
      chatStreaming = false; setChatSendUI(false);
      if (chatStreamEl) chatStreamEl.innerHTML = '<span class="out-err">' + escapeHtml(err.message) + '</span>';
      chatStreamEl = null;
    });
  }

  function wireChat() {
    window.GARMEditor.onAskChat(function (sel) { openChat(sel); });
    $('#btn-chat-send').addEventListener('click', function () {
      if (chatStreaming) { garm.chat.cancel(); return; }
      sendChat();
    });
    var input = $('#chat-input');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    });

    garm.on('chat:delta', function (p) {
      if (!chatStreaming || !chatStreamEl) return;
      chatRaw += (p && p.text) || '';
      var parts = splitThink(chatRaw);
      if (!parts.answer && parts.think) chatStreamEl.innerHTML = '<span class="chat-thinking">Thinking…</span>';
      else renderMarkdownInto(chatStreamEl, parts.answer, false);
      $('#chat-body').scrollTop = $('#chat-body').scrollHeight;
    });
    garm.on('chat:done', function (p) {
      chatStreaming = false; setChatSendUI(false);
      var raw = (p && p.text) || chatRaw;
      var parts = splitThink(raw);
      var answer = parts.answer || (p && p.aborted ? '_(stopped)_' : parts.think);
      if (chatStreamEl) {
        renderMarkdownInto(chatStreamEl, answer, true);
        if (parts.think && parts.answer) prependThought(chatStreamEl, parts.think);
      }
      chatTurns.push({ role: 'assistant', content: parts.answer || answer || '' });
      chatStreamEl = null; chatRaw = '';
      $('#chat-body').scrollTop = $('#chat-body').scrollHeight;
    });
    garm.on('chat:error', function (p) {
      chatStreaming = false; setChatSendUI(false);
      if (chatStreamEl) chatStreamEl.innerHTML = '<span class="out-err">' + escapeHtml((p && p.message) || 'Chat failed.') + '</span>';
      chatStreamEl = null;
    });
  }

  function prependThought(el, think) {
    var d = document.createElement('details');
    d.className = 'chat-think';
    d.innerHTML = '<summary>Reasoning</summary>';
    var body = document.createElement('div');
    body.className = 'chat-think-body';
    body.textContent = think;
    d.appendChild(body);
    el.insertBefore(d, el.firstChild);
  }

  // Separate a reasoning model's <think>…</think> from its answer (mirrors src/main/llm.js).
  function splitThink(t) {
    if (!t) return { think: '', answer: '' };
    var closed = t.match(/<think>([\s\S]*?)<\/think>/i);
    if (closed) return { think: closed[1].trim(), answer: t.replace(/<think>[\s\S]*?<\/think>/i, '').trim() };
    var open = t.match(/<think>([\s\S]*)$/i);
    if (open) return { think: open[1].trim(), answer: '' };
    return { think: '', answer: t.trim() };
  }

  function monacoLang(l) {
    l = (l || '').toLowerCase();
    var map = { '': 'python', py: 'python', python: 'python', js: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'typescript', sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell',
      json: 'json', html: 'html', xml: 'xml', css: 'css', md: 'markdown', markdown: 'markdown',
      c: 'c', cpp: 'cpp', 'c++': 'cpp', java: 'java', go: 'go', rust: 'rust', rs: 'rust', sql: 'sql',
      yaml: 'yaml', yml: 'yaml', text: 'plaintext', txt: 'plaintext', plaintext: 'plaintext' };
    return map[l] || l || 'plaintext';
  }

  // Render a LaTeX fragment to HTML. Prefer real KaTeX (bundled locally in
  // node_modules/katex and loaded in index.html); fall back to the lightweight
  // unicode-izer below if KaTeX is unavailable or a fragment doesn't parse.
  function renderMath(raw, display) {
    if (window.katex && typeof window.katex.renderToString === 'function') {
      try {
        return window.katex.renderToString(raw, {
          displayMode: !!display,
          throwOnError: false,
          output: 'html',
          strict: false,
        });
      } catch (e) { /* fall through to the lightweight renderer */ }
    }
    return renderMathFallback(raw);
  }

  // Lightweight LaTeX → HTML fallback: unicode-ize common symbols, fractions, sup/sub.
  function renderMathFallback(raw) {
    var s = escapeHtml(raw);
    var greek = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η',
      theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ',
      sigma: 'σ', tau: 'τ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ',
      Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω' };
    var ops = { times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥',
      ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝', rightarrow: '→',
      to: '→', leftarrow: '←', Rightarrow: '⇒', leftrightarrow: '↔', sum: '∑', prod: '∏', int: '∫',
      oint: '∮', partial: '∂', nabla: '∇', infty: '∞', in: '∈', notin: '∉', subset: '⊂',
      subseteq: '⊆', cup: '∪', cap: '∩', forall: '∀', exists: '∃', emptyset: '∅', angle: '∠',
      cdots: '⋯', ldots: '…', langle: '⟨', rangle: '⟩' };
    s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '<span class="frac"><span class="frac-n">$1</span><span class="frac-d">$2</span></span>');
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, '√<span class="sqrt-r">$1</span>');
    s = s.replace(/\\([a-zA-Z]+)/g, function (_, n) { return greek[n] || ops[n] || n; });
    s = s.replace(/\^\{([^{}]*)\}/g, '<sup>$1</sup>').replace(/\^([A-Za-z0-9])/g, '<sup>$1</sup>');
    s = s.replace(/_\{([^{}]*)\}/g, '<sub>$1</sub>').replace(/_([A-Za-z0-9])/g, '<sub>$1</sub>');
    return s;
  }

  // Inline Markdown on already-escaped text: code, bold, italic, links.
  function mdInline(s) {
    s = s.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, function (_, t, u) {
      return '<a href="#" data-href="' + u.replace(/"/g, '%22') + '">' + t + '</a>';
    });
    return s;
  }

  // Block-level Markdown. Placeholders (…) for code/math survive untouched.
  function mdBlocks(md) {
    var lines = md.split('\n'); var html = ''; var listOpen = false;
    function closeList() { if (listOpen) { html += '</ul>'; listOpen = false; } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]; var t = line.trim();
      if (/^[BM]\d+$/.test(t)) { closeList(); html += t; continue; }
      if (t === '') { closeList(); continue; }
      var h = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (h) { closeList(); var lv = h[1].length; html += '<h' + lv + ' class="md-h">' + mdInline(escapeHtml(h[2])) + '</h' + lv + '>'; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeList(); html += '<hr>'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { if (!listOpen) { html += '<ul>'; listOpen = true; } html += '<li>' + mdInline(escapeHtml(line.replace(/^\s*[-*]\s+/, ''))) + '</li>'; continue; }
      if (/^\s*\d+\.\s+/.test(line)) { if (!listOpen) { html += '<ul>'; listOpen = true; } html += '<li>' + mdInline(escapeHtml(line.replace(/^\s*\d+\.\s+/, ''))) + '</li>'; continue; }
      if (/^\s*>\s?/.test(line)) { closeList(); html += '<blockquote>' + mdInline(escapeHtml(line.replace(/^\s*>\s?/, ''))) + '</blockquote>'; continue; }
      closeList(); html += '<p>' + mdInline(escapeHtml(line)) + '</p>';
    }
    closeList();
    return html;
  }

  // Render Markdown into a container: pull out fenced code + math, render blocks, reinsert, then
  // syntax-highlight code via Monaco (only when colorize=true — skipped mid-stream for speed).
  function renderMarkdownInto(container, md, colorize) {
    md = md || '';
    var code = []; var math = [];
    md = md.replace(/```([a-zA-Z0-9_+\-]*)\n([\s\S]*?)```/g, function (_, lang, c) {
      code.push({ lang: lang, code: c.replace(/\n$/, '') }); return '\nB' + (code.length - 1) + '\n';
    });
    md = md.replace(/\$\$([\s\S]+?)\$\$/g, function (_, m) { math.push({ display: true, tex: m }); return '\nM' + (math.length - 1) + '\n'; });
    md = md.replace(/\\\[([\s\S]+?)\\\]/g, function (_, m) { math.push({ display: true, tex: m }); return '\nM' + (math.length - 1) + '\n'; });
    md = md.replace(/\$([^$\n]+?)\$/g, function (_, m) { math.push({ display: false, tex: m }); return 'M' + (math.length - 1) + ''; });
    md = md.replace(/\\\(([\s\S]+?)\\\)/g, function (_, m) { math.push({ display: false, tex: m }); return 'M' + (math.length - 1) + ''; });
    var html = mdBlocks(md);
    html = html.replace(/M(\d+)/g, function (_, n) {
      var x = math[n];
      return x.display ? '<div class="math-block">' + renderMath(x.tex, true) + '</div>' : '<span class="math">' + renderMath(x.tex, false) + '</span>';
    });
    html = html.replace(/B(\d+)/g, function (_, n) {
      var b = code[n];
      return '<pre class="cb" data-lang="' + escapeHtml(b.lang) + '"><code>' + escapeHtml(b.code) + '</code></pre>';
    });
    container.innerHTML = html;
    if (colorize && window.monaco && monaco.editor && monaco.editor.colorize) {
      container.querySelectorAll('pre.cb').forEach(function (pre) {
        var c = pre.querySelector('code'); var src = c.textContent;
        monaco.editor.colorize(src, monacoLang(pre.getAttribute('data-lang')), {})
          .then(function (hh) { c.innerHTML = hh; }).catch(function () { /* keep plain */ });
      });
    }
    container.querySelectorAll('a[data-href]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); var pr = garm.shell.openExternal(a.getAttribute('data-href')); if (pr && pr.catch) pr.catch(function () {}); });
    });
  }

  // ---- Editor context menu -----------------------------------------------
  // A stable replacement for Monaco's built-in right-click menu, which dismissed
  // itself on the right-click's own mousedown and on small pointer moves (the
  // "pops up then closes suddenly" flicker). This menu opens on `contextmenu`
  // and closes ONLY on an outside click, Escape, scroll, blur, or item choice —
  // never on mouse movement.
  var ctxMenuEl = null;

  function closeCtxMenu() {
    if (!ctxMenuEl || ctxMenuEl.classList.contains('hidden')) return;
    ctxMenuEl.classList.add('hidden');
    ctxMenuEl.innerHTML = '';
    document.removeEventListener('mousedown', onCtxOutside, true);
    document.removeEventListener('keydown', onCtxKey, true);
    document.removeEventListener('scroll', closeCtxMenu, true);
    window.removeEventListener('blur', closeCtxMenu);
    window.removeEventListener('resize', closeCtxMenu);
  }
  function onCtxOutside(e) { if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeCtxMenu(); }
  function onCtxKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeCtxMenu(); } }

  function ctxItem(label, shortcut, enabled, run) {
    var it = document.createElement('button');
    it.type = 'button';
    it.className = 'ctx-item' + (enabled ? '' : ' disabled');
    it.setAttribute('role', 'menuitem');
    it.innerHTML = '<span class="ctx-label">' + escapeHtml(label) + '</span>' +
      (shortcut ? '<span class="ctx-key">' + escapeHtml(shortcut) + '</span>' : '');
    if (enabled) it.addEventListener('click', function () { closeCtxMenu(); run(); });
    return it;
  }
  function ctxSep() { var s = document.createElement('div'); s.className = 'ctx-sep'; return s; }

  function openCtxMenu(x, y) {
    if (!ctxMenuEl) {
      ctxMenuEl = document.createElement('div');
      ctxMenuEl.className = 'ctx-menu hidden';
      ctxMenuEl.setAttribute('role', 'menu');
      // Swallow the menu's own mousedown so it never reaches the outside-close handler.
      ctxMenuEl.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      // Right-clicking the menu itself shouldn't bring up the native menu.
      ctxMenuEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      document.body.appendChild(ctxMenuEl);
    }
    var sel = window.GARMEditor.getSelection();
    var hasSel = !!(sel && !sel.empty);
    var mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

    ctxMenuEl.innerHTML = '';
    ctxMenuEl.appendChild(ctxItem('Cut', mod + 'X', hasSel, function () {
      var s = window.GARMEditor.getSelection();
      if (s && s.text) { garm.clipboard.writeText(s.text); window.GARMEditor.replaceSelection(''); }
    }));
    ctxMenuEl.appendChild(ctxItem('Copy', mod + 'C', hasSel, function () {
      var s = window.GARMEditor.getSelection();
      if (s && s.text) garm.clipboard.writeText(s.text);
    }));
    ctxMenuEl.appendChild(ctxItem('Paste', mod + 'V', true, function () {
      var pr = garm.clipboard.readText();
      if (pr && pr.then) pr.then(function (t) { window.GARMEditor.replaceSelection(t || ''); });
    }));
    ctxMenuEl.appendChild(ctxSep());
    ctxMenuEl.appendChild(ctxItem('Select All', mod + 'A', true, function () { window.GARMEditor.selectAll(); }));
    ctxMenuEl.appendChild(ctxSep());
    ctxMenuEl.appendChild(ctxItem('Cicada: Edit Selection…', mod + 'K', hasSel, function () { openInpaint(sel); }));
    ctxMenuEl.appendChild(ctxItem('Ask Cicada Chat…', mod + 'L', true, function () { openChat(sel); }));

    // Reveal off-screen to measure, then clamp inside the viewport.
    ctxMenuEl.classList.remove('hidden');
    ctxMenuEl.style.left = '-9999px';
    ctxMenuEl.style.top = '-9999px';
    var w = ctxMenuEl.offsetWidth, h = ctxMenuEl.offsetHeight;
    ctxMenuEl.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
    ctxMenuEl.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';

    // Attach dismissers on the next tick so the right-click's own trailing
    // mousedown doesn't immediately close the menu we just opened.
    setTimeout(function () {
      document.addEventListener('mousedown', onCtxOutside, true);
      document.addEventListener('keydown', onCtxKey, true);
      document.addEventListener('scroll', closeCtxMenu, true);
      window.addEventListener('blur', closeCtxMenu);
      window.addEventListener('resize', closeCtxMenu);
    }, 0);
  }

  function wireContextMenu() {
    window.GARMEditor.whenReady(function () {
      var node = window.GARMEditor.getDomNode();
      if (!node) return;
      node.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openCtxMenu(e.clientX, e.clientY);
      });
    });
  }

  // ---- Data ingestion (Data dock tab + drag-and-drop) --------------------
  // Datasets (CSV / Excel / JSON) added to the project are copied into data/, indexed,
  // schema-detected in the main process, and surfaced to the agent. This renders the Data
  // tab, runs the file picker + drag-drop ingestion, and keeps the tab badge/summary live.
  var dsList = [];
  var emptyDataHTML = '';

  function fmtBytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  }
  function fmtInt(n) { return (typeof n === 'number') ? n.toLocaleString('en-US') : String(n); }

  // How the agent (and the user, via Copy) loads a dataset — mirrors datasets.loadHint in main.
  function dsLoadHint(d) {
    var p = d.file, s = d.schema || {};
    if (d.kind === 'csv') return /\.tsv$/i.test(p) ? 'df = pd.read_csv("' + p + '", sep="\\t")' : 'df = pd.read_csv("' + p + '")';
    if (d.kind === 'excel') { var sh = s.sheetNames && s.sheetNames[0]; return sh ? 'df = pd.read_excel("' + p + '", sheet_name="' + sh + '")' : 'df = pd.read_excel("' + p + '")'; }
    if (d.kind === 'json') return (s.format === 'records') ? 'df = pd.read_json("' + p + '")' : 'import json; data = json.load(open("' + p + '"))';
    return 'open("' + p + '")';
  }

  function dsActBtn(kind, val, title, svgPath) {
    return '<button class="ds-act" data-ds-' + kind + '="' + escapeHtml(String(val)) + '" title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' + svgPath + '</svg></button>';
  }

  function dsColChips(cols) {
    cols = cols || [];
    var h = '<div class="ds-cols">';
    cols.slice(0, 24).forEach(function (c) {
      var warn = (c.nullCount != null && c.nullCount > 0);
      h += '<span class="ds-col' + (warn ? ' warn' : '') + '">' + escapeHtml(c.name) + ' <span class="ds-dtype">' + escapeHtml(c.dtype) + '</span>';
      if (warn) h += ' <span class="ds-null">' + fmtInt(c.nullCount) + '∅</span>';
      h += '</span>';
    });
    if (cols.length > 24) h += '<span class="ds-more">+' + (cols.length - 24) + ' more</span>';
    return h + '</div>';
  }

  function dsSampleTable(cols, rows) {
    if (!rows || !rows.length || !cols || !cols.length) return '';
    var head = cols.slice(0, 12).map(function (c) { return '<th>' + escapeHtml(c.name) + '</th>'; }).join('');
    var body = rows.slice(0, 5).map(function (r) {
      return '<tr>' + (r || []).slice(0, 12).map(function (x) { return '<td>' + escapeHtml(x == null ? '' : String(x)) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<div class="ds-sample"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function dsSchemaHtml(s) {
    if (s.format === 'excel') {
      var h = '';
      (s.sheets || []).slice(0, 4).forEach(function (sheet) {
        h += '<div class="ds-section-h">Sheet: ' + escapeHtml(sheet.name) + ' · ' + fmtInt(sheet.rowCount) + ' × ' + fmtInt(sheet.colCount) + '</div>' + dsColChips(sheet.columns);
      });
      return h + dsSampleTable(s.columns, s.sampleRows);
    }
    if (s.format === 'object') {
      var o = '<div class="ds-section-h">Structure</div><div class="ds-cols">';
      (s.columns || []).slice(0, 30).forEach(function (c) {
        o += '<span class="ds-col">' + escapeHtml(c.name) + ' <span class="ds-dtype">' + escapeHtml(c.dtype) + '</span></span>';
      });
      return o + '</div>';
    }
    return '<div class="ds-section-h">Columns (' + (s.columns || []).length + ')</div>' + dsColChips(s.columns) + dsSampleTable(s.columns, s.sampleRows);
  }

  function dsCardHtml(d) {
    var s = d.schema;
    var missing = d.exists === false;
    var status = missing ? 'error' : (d.status === 'ready' ? 'ready' : (d.status === 'busy' ? 'busy' : 'error'));
    var kindLabel = d.kind === 'csv' ? 'CSV' : d.kind === 'excel' ? 'XLSX' : 'JSON';
    var shape = '';
    if (missing) shape = 'file missing';
    else if (s && (s.format === 'table' || s.format === 'records') && s.rowCount != null) shape = fmtInt(s.rowCount) + ' rows × ' + fmtInt(s.colCount) + ' cols';
    else if (s && s.format === 'excel') shape = ((s.sheetNames || []).length) + ' sheet(s)';
    else if (s && s.format === 'object') shape = 'JSON ' + escapeHtml(s.rootType || 'object') + (s.keyCount != null ? ' · ' + s.keyCount + ' keys' : '');
    else if (d.status === 'busy') shape = 'analyzing…';

    var h = '<div class="ds-card' + (missing ? ' missing' : '') + '">';
    h += '<div class="ds-head">';
    h += '<span class="ds-kind ' + escapeHtml(d.kind) + '">' + kindLabel + '</span>';
    h += '<button class="ds-name" data-ds-open="' + escapeHtml(d.file) + '" title="' + escapeHtml(d.file) + '">' + escapeHtml(d.name) + '</button>';
    h += '<span class="ds-status-dot ' + status + '" title="' + status + '"></span>';
    h += '<div class="ds-actions">';
    if (d.status === 'ready' && !missing) h += dsActBtn('insights', d.id, 'Insights — distributions, correlations, quality flags', '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>');
    if (d.status === 'error' && !missing) h += dsActBtn('reanalyze', d.id, 'Re-analyze', '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>');
    h += dsActBtn('remove', d.id, 'Remove from project', '<path d="M6 6l12 12M18 6L6 18"/>');
    h += '</div></div>';

    h += '<div class="ds-meta"><span>' + escapeHtml(d.file) + '</span>';
    if (shape) h += '<span class="ds-sep">·</span><span>' + escapeHtml(shape) + '</span>';
    if (d.bytes != null) h += '<span class="ds-sep">·</span><span>' + fmtBytes(d.bytes) + '</span>';
    h += '</div>';

    if (!missing && s) {
      var hint = dsLoadHint(d);
      h += '<div class="ds-load"><code>' + escapeHtml(hint) + '</code><button class="ds-copy" data-ds-copy="' + encodeURIComponent(hint) + '">Copy</button></div>';
      h += dsSchemaHtml(s);
    } else if (missing) {
      h += '<div class="ds-error">The underlying file was moved or deleted. Remove it from the list, or re-add it.</div>';
    } else if (d.status === 'error') {
      h += '<div class="ds-error">' + escapeHtml(d.error || 'Could not analyze this file.');
      var pkg = /openpyxl/i.test(d.error || '') ? 'openpyxl' : (/pandas/i.test(d.error || '') ? 'pandas' : null);
      h += '<div class="ds-error-actions">';
      if (pkg) h += '<button class="ds-copy" data-ds-install="' + pkg + '" data-ds-id="' + escapeHtml(d.id) + '">Install ' + pkg + '</button>';
      h += '<button class="ds-copy" data-ds-reanalyze="' + escapeHtml(d.id) + '">Re-analyze</button>';
      h += '</div></div>';
    }
    // On-demand insights render into this container (kept across re-renders by id).
    h += '<div class="ds-insights hidden" id="ds-ins-' + escapeHtml(d.id) + '"></div>';
    return h + '</div>';
  }

  function updateDataBadge() {
    var b = $('#data-badge');
    if (dsList.length) { b.textContent = String(dsList.length); b.classList.remove('hidden'); }
    else b.classList.add('hidden');
  }

  function renderDatasets(list) {
    dsList = Array.isArray(list) ? list : [];
    updateDataBadge();
    renderResearchDatasets();
    var body = $('#data-body');
    var summary = $('#data-summary');
    if (!dsList.length) {
      body.innerHTML = emptyDataHTML;
      summary.textContent = 'Drop in CSV, Excel, or JSON to analyze and build from.';
      return;
    }
    var ready = dsList.filter(function (d) { return d.status === 'ready' && d.exists !== false; }).length;
    summary.textContent = dsList.length + ' file' + (dsList.length > 1 ? 's' : '') +
      (ready === dsList.length ? ' · available to the agent' : ' · ' + ready + ' ready');
    body.innerHTML = dsList.map(dsCardHtml).join('');
  }

  function loadDatasets() { return garm.datasets.list().then(renderDatasets).catch(function () { /* ignore */ }); }

  function ingestPaths(paths) {
    if (!paths || !paths.length) return;
    switchDock('data');
    $('#data-summary').textContent = 'Adding ' + paths.length + ' file' + (paths.length > 1 ? 's' : '') + '…';
    garm.datasets.add(paths).then(function (res) {
      renderDatasets(res.datasets);
      refreshTree();
      (res.errors || []).forEach(function (e) { appendConsole('\n[data] ' + e.name + ': ' + e.error + '\n', true); });
      if (res.errors && res.errors.length) flashTab('data');
    }).catch(function (err) { appendConsole('\n[data] ' + err.message + '\n', true); loadDatasets(); });
  }

  // Window-wide drag-and-drop. Capture-phase + preventDefault so external file drops are
  // ingested (and never navigate the window) even when dropped over Monaco or the terminal;
  // internal text drags (no Files) pass through untouched.
  function wireDragDrop() {
    var overlay = $('#drop-overlay');
    var depth = 0;
    var hasFiles = function (e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      if (!t) return false;
      return t.contains ? t.contains('Files') : Array.prototype.indexOf.call(t, 'Files') >= 0;
    };
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth += 1; overlay.classList.remove('hidden');
    }, true);
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (_) { /* ignore */ }
      overlay.classList.remove('hidden'); // keep shown for the whole drag (robust to enter/leave miscount)
    }, true);
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1); if (depth === 0) overlay.classList.add('hidden');
    }, true);
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; overlay.classList.add('hidden');
      var files = (e.dataTransfer && e.dataTransfer.files) || [];
      var paths = [];
      for (var i = 0; i < files.length; i++) {
        var p = garm.files.pathForFile(files[i]);
        if (p) paths.push(p);
      }
      if (paths.length) ingestPaths(paths);
      else appendConsole('\n[data] Could not read the dropped file(s) from disk.\n', true);
    }, true);
  }

  function wireData() {
    emptyDataHTML = $('#data-body').innerHTML; // snapshot the empty/dropzone state from index.html

    $('#btn-data-add').addEventListener('click', function () {
      garm.datasets.import().then(function (res) {
        if (!res || res.canceled) return;
        renderDatasets(res.datasets);
        refreshTree();
        (res.errors || []).forEach(function (e) { appendConsole('\n[data] ' + e.name + ': ' + e.error + '\n', true); });
      }).catch(function (err) { appendConsole('\n[data] ' + err.message + '\n', true); });
    });

    garm.on('datasets:update', renderDatasets);
    garm.on('datasets:progress', function (p) {
      if (p && p.phase) $('#data-summary').textContent = (p.phase === 'analyzing' ? 'Analyzing ' : 'Copying ') + (p.name || '') + '…';
    });

    // Delegated card actions: open, copy load-snippet, remove, re-analyze, install engine.
    $('#data-body').addEventListener('click', function (e) {
      var t = e.target.closest('[data-ds-open],[data-ds-remove],[data-ds-reanalyze],[data-ds-copy],[data-ds-install],[data-ds-insights]');
      if (!t) return;
      if (t.hasAttribute('data-ds-insights')) { toggleInsights(t.getAttribute('data-ds-insights')); }
      else if (t.hasAttribute('data-ds-open')) { switchDock('console'); openFile(t.getAttribute('data-ds-open')); }
      else if (t.hasAttribute('data-ds-copy')) {
        garm.clipboard.writeText(decodeURIComponent(t.getAttribute('data-ds-copy')));
        var prev = t.textContent; t.textContent = 'Copied'; setTimeout(function () { t.textContent = prev; }, 1100);
      } else if (t.hasAttribute('data-ds-remove')) {
        garm.datasets.remove(t.getAttribute('data-ds-remove')).then(function (res) { renderDatasets(res.datasets); refreshTree(); });
      } else if (t.hasAttribute('data-ds-reanalyze')) {
        garm.datasets.reanalyze(t.getAttribute('data-ds-reanalyze')).then(function (res) { renderDatasets(res.datasets); });
      } else if (t.hasAttribute('data-ds-install')) {
        var pkg = t.getAttribute('data-ds-install'); var id = t.getAttribute('data-ds-id');
        switchDock('env');
        garm.env.install(pkg).then(function () { return garm.datasets.reanalyze(id); }).then(function (res) { if (res) renderDatasets(res.datasets); });
      }
    });

    wireDragDrop();
    loadDatasets();
  }

  // ---- Dataset insights (distributions · correlations · quality flags) ----
  // Rendered on demand into the dataset card. The heavy lifting (pandas or the
  // pure-Node CSV fallback) happens in the main process; this only draws.
  function sparkline(hist) {
    var GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    var max = 0;
    (hist || []).forEach(function (v) { if (v > max) max = v; });
    if (!max) return '';
    return (hist || []).map(function (v) {
      return GLYPHS[Math.min(GLYPHS.length - 1, Math.round((v / max) * (GLYPHS.length - 1)))];
    }).join('');
  }

  function fmtStat(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return String(Math.round(n * 1000) / 1000);
  }

  function insightsHtml(res) {
    var h = '<div class="ins-head">Insights · ' + fmtInt(res.rows) + ' rows'
      + (res.sampled ? ' (sampled)' : '') + ' · engine: ' + escapeHtml(res.engine || '?') + '</div>';
    if ((res.flags || []).length) {
      h += '<div class="ins-flags">';
      res.flags.forEach(function (f) { h += '<span class="ins-flag">⚠ ' + escapeHtml(f) + '</span>'; });
      h += '</div>';
    }
    if ((res.columns || []).length) {
      h += '<div class="ins-section-h">Numeric columns</div><table class="ins-table"><thead><tr>'
        + '<th>column</th><th>distribution</th><th>mean</th><th>std</th><th>min</th><th>median</th><th>max</th><th>skew</th><th>missing</th></tr></thead><tbody>';
      res.columns.forEach(function (c) {
        h += '<tr><td class="ins-name">' + escapeHtml(c.name) + '</td>'
          + '<td class="ins-spark" title="10-bin histogram">' + sparkline(c.hist) + '</td>'
          + '<td>' + fmtStat(c.mean) + '</td><td>' + fmtStat(c.std) + '</td><td>' + fmtStat(c.min) + '</td>'
          + '<td>' + fmtStat(c.median) + '</td><td>' + fmtStat(c.max) + '</td><td>' + fmtStat(c.skew) + '</td>'
          + '<td>' + (c.missingPct >= 0.05 ? fmtStat(c.missingPct) + '%' : '0%') + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    if ((res.correlations || []).length) {
      h += '<div class="ins-section-h">Strongest correlations</div><div class="ins-corrs">';
      res.correlations.forEach(function (p) {
        var cls = Math.abs(p.r) >= 0.7 ? ' strong' : '';
        h += '<span class="ins-corr' + cls + '">' + escapeHtml(p.a) + ' ↔ ' + escapeHtml(p.b)
          + ' <b>' + (p.r > 0 ? '+' : '') + fmtStat(p.r) + '</b></span>';
      });
      h += '</div>';
    }
    if (!(res.columns || []).length && !(res.flags || []).length) {
      h += '<div class="empty-hint">No numeric columns to profile in this file.</div>';
    }
    return h;
  }

  function toggleInsights(id) {
    var box = document.getElementById('ds-ins-' + id);
    if (!box) return;
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    if (box.dataset.loaded) return; // already fetched (cached in main anyway)
    box.innerHTML = '<div class="empty-hint">Analyzing distributions and correlations…</div>';
    garm.datasets.insights(id).then(function (res) {
      if (!res || res.ok === false) {
        box.innerHTML = '<div class="ds-error">' + escapeHtml((res && res.error) || 'Could not compute insights.') + '</div>';
        return;
      }
      box.dataset.loaded = '1';
      box.innerHTML = insightsHtml(res);
    }).catch(function (err) {
      box.innerHTML = '<div class="ds-error">' + escapeHtml(err.message) + '</div>';
    });
  }

  // ---- Notebook workbench -------------------------------------------------
  var activeNotebookPath = '';
  var activeNotebook = null;
  var notebookSaveTimer = null;

  function nbSource(cell) { return Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || ''); }
  function setNbSource(cell, text) { cell.source = String(text || '').split(/(?<=\n)/); }

  function notebookOutputHtml(output) {
    if (!output) return '';
    if (output.output_type === 'stream') return '<pre class="nb-stream ' + (output.name === 'stderr' ? 'error' : '') + '">' + escapeHtml(output.text || '') + '</pre>';
    if (output.output_type === 'error') return '<div class="nb-error"><b>' + escapeHtml(output.ename || 'Error') + ': ' + escapeHtml(output.evalue || '') + '</b><pre>' + escapeHtml((output.traceback || []).join('\n')) + '</pre></div>';
    var data = output.data || {};
    var table = data['application/vnd.cicada.table+json'];
    if (table) {
      var head = (table.columns || []).map(function (c) { return '<th>' + escapeHtml(c) + '</th>'; }).join('');
      var rows = (table.rows || []).map(function (row) { return '<tr>' + row.map(function (v) { return '<td>' + escapeHtml(v == null ? '' : String(v)) + '</td>'; }).join('') + '</tr>'; }).join('');
      return '<div class="nb-table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>' + (table.truncated ? '<div class="nb-output-note">Showing 200 of ' + table.totalRows + ' rows</div>' : '');
    }
    if (output.cicada_url) return '<img class="nb-figure" src="' + escapeHtml(output.cicada_url) + '?t=' + Date.now() + '" alt="Notebook figure" />';
    if (data['text/plain'] != null) return '<pre class="nb-result">' + escapeHtml(data['text/plain']) + '</pre>';
    return '';
  }

  function renderNotebook() {
    var body = $('#nb-body');
    if (!activeNotebook) { body.innerHTML = '<div class="nb-empty"><b>Computational notebooks, locally.</b><span>Open an .ipynb from Explorer or create one here.</span></div>'; return; }
    body.innerHTML = (activeNotebook.cells || []).map(function (cell, i) {
      var code = cell.cell_type !== 'markdown';
      var outputs = code ? (cell.outputs || []).map(notebookOutputHtml).join('') : '';
      return '<article class="nb-cell ' + (code ? 'code' : 'markdown') + '" data-nb-index="' + i + '">' +
        '<div class="nb-cell-rail"><span>' + (code ? '[' + (cell.execution_count == null ? ' ' : cell.execution_count) + ']' : 'MD') + '</span></div>' +
        '<div class="nb-cell-main"><div class="nb-cell-tools"><span>' + (code ? 'Python' : 'Markdown') + '</span><button data-nb-move="up" title="Move up">↑</button><button data-nb-move="down" title="Move down">↓</button><button data-nb-delete title="Delete cell">×</button></div>' +
        '<textarea class="nb-source" spellcheck="false" rows="' + Math.max(3, Math.min(18, nbSource(cell).split('\n').length + 1)) + '">' + escapeHtml(nbSource(cell)) + '</textarea>' +
        (code ? '<div class="nb-outputs">' + outputs + '</div>' : '<div class="nb-md-preview" data-md-index="' + i + '"></div>') + '</div></article>';
    }).join('') || '<div class="nb-empty"><b>This notebook has no cells.</b><span>Add a Markdown or Code cell above.</span></div>';
    body.querySelectorAll('.nb-md-preview').forEach(function (el) {
      var c = activeNotebook.cells[Number(el.dataset.mdIndex)]; renderMarkdownInto(el, nbSource(c), false);
    });
  }

  function setNotebook(doc, rel) {
    activeNotebook = doc; activeNotebookPath = rel;
    $('#nb-title').textContent = rel ? rel.split(/[\\/]/).pop().replace(/\.ipynb$/i, '') : 'Notebook';
    $('#nb-path').textContent = rel || 'Create or open a .ipynb file';
    ['#btn-nb-add-markdown','#btn-nb-add-code','#btn-nb-save','#btn-nb-run'].forEach(function (s) { $(s).disabled = !doc; });
    renderNotebook();
  }

  function loadNotebook(rel) {
    switchDock('notebook');
    $('#nb-body').innerHTML = '<div class="nb-empty"><b>Opening notebook…</b></div>';
    return garm.notebooks.load(rel).then(function (res) { setNotebook(res.notebook, res.path); }).catch(function (err) { $('#nb-body').innerHTML = '<div class="nb-empty out-err">' + escapeHtml(err.message) + '</div>'; throw err; });
  }
  function saveNotebook(quiet) {
    if (!activeNotebook || !activeNotebookPath) return Promise.resolve();
    clearTimeout(notebookSaveTimer);
    $('#nb-path').textContent = 'Saving…';
    return garm.notebooks.save(activeNotebookPath, activeNotebook).then(function (res) { activeNotebook = res.notebook; $('#nb-path').textContent = activeNotebookPath + ' · Saved'; if (!quiet) toast('Notebook saved.', 'ok'); });
  }
  function scheduleNotebookSave() { clearTimeout(notebookSaveTimer); $('#nb-path').textContent = activeNotebookPath + ' · Unsaved'; notebookSaveTimer = setTimeout(function () { saveNotebook(true); }, 900); }

  function wireNotebook() {
    $('#btn-nb-new').addEventListener('click', function () {
      var name = window.prompt('Notebook name', 'analysis.ipynb'); if (!name) return;
      if (!/\.ipynb$/i.test(name)) name += '.ipynb';
      garm.notebooks.create(name, name.replace(/\.ipynb$/i, '')).then(function (res) { renderTree(res.tree); setNotebook(res.notebook, res.path); switchDock('notebook'); });
    });
    function addCell(kind) { if (!activeNotebook) return; activeNotebook.cells.push({ cell_type: kind, metadata: {}, source: [], ...(kind === 'code' ? { execution_count: null, outputs: [] } : {}) }); renderNotebook(); scheduleNotebookSave(); }
    $('#btn-nb-add-code').addEventListener('click', function () { addCell('code'); });
    $('#btn-nb-add-markdown').addEventListener('click', function () { addCell('markdown'); });
    $('#btn-nb-save').addEventListener('click', function () { saveNotebook(false); });
    $('#btn-nb-run').addEventListener('click', function () {
      if (!activeNotebook) return;
      var btn = $('#btn-nb-run'); btn.disabled = true; btn.textContent = 'Running…';
      garm.notebooks.run(activeNotebookPath, activeNotebook).then(function (res) {
        if (res.notebook) activeNotebook = res.notebook;
        renderNotebook();
        if (!res.ok) toast(res.error || 'A notebook cell failed. See inline output.', 'err'); else toast('Notebook completed.', 'ok');
      }).catch(function (err) { toast('Notebook failed: ' + err.message, 'err'); }).finally(function () { btn.disabled = false; btn.textContent = 'Run all'; });
    });
    $('#nb-body').addEventListener('input', function (e) {
      var area = e.target.closest('.nb-source'); if (!area || !activeNotebook) return;
      var card = area.closest('.nb-cell'); var index = Number(card.dataset.nbIndex); setNbSource(activeNotebook.cells[index], area.value);
      area.style.height = 'auto'; area.style.height = Math.min(area.scrollHeight, 420) + 'px';
      if (activeNotebook.cells[index].cell_type === 'markdown') { var preview = card.querySelector('.nb-md-preview'); renderMarkdownInto(preview, area.value, false); }
      scheduleNotebookSave();
    });
    $('#nb-body').addEventListener('click', function (e) {
      var card = e.target.closest('.nb-cell'); if (!card || !activeNotebook) return; var index = Number(card.dataset.nbIndex);
      if (e.target.closest('[data-nb-delete]')) { activeNotebook.cells.splice(index, 1); }
      else if (e.target.closest('[data-nb-move="up"]') && index > 0) { var up = activeNotebook.cells.splice(index,1)[0]; activeNotebook.cells.splice(index-1,0,up); }
      else if (e.target.closest('[data-nb-move="down"]') && index < activeNotebook.cells.length-1) { var down = activeNotebook.cells.splice(index,1)[0]; activeNotebook.cells.splice(index+1,0,down); }
      else return;
      renderNotebook(); scheduleNotebookSave();
    });
  }

  // ---- Research Lab -------------------------------------------------------
  var researchView = 'audit';
  var currentResearchReport = null;

  function datasetColumns(d) {
    var schema = d && d.schema; if (!schema) return [];
    if (schema.columns) return schema.columns;
    if (schema.sheets && schema.sheets[0]) return schema.sheets[0].columns || [];
    return [];
  }
  function renderResearchDatasets() {
    var sel = $('#research-dataset'); if (!sel) return; var current = sel.value;
    sel.innerHTML = '<option value="">Select a dataset…</option>' + dsList.filter(function (d) { return d.status === 'ready' && d.exists !== false; }).map(function (d) { return '<option value="' + escapeHtml(d.id) + '">' + escapeHtml(d.name) + '</option>'; }).join('');
    if (dsList.some(function (d) { return d.id === current; })) sel.value = current;
    $('#btn-research-audit').disabled = !sel.value;
  }
  function researchDatasetChanged() {
    var id = $('#research-dataset').value; var d = dsList.find(function (x) { return x.id === id; }); var target = $('#research-target');
    target.innerHTML = '<option value="">Target (optional)</option>' + datasetColumns(d).map(function (c) { return '<option value="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + '</option>'; }).join('');
    target.disabled = !d; $('#btn-research-audit').disabled = !d;
  }
  function severityIcon(s) { return s === 'warning' ? '!' : s === 'error' ? '×' : 'i'; }
  function renderResearchAudit(r) {
    currentResearchReport = r;
    var badge = $('#research-badge'); var issueCount = (r.warnings || []).length + (r.leakage || []).length;
    if (issueCount) { badge.textContent = issueCount > 99 ? '99+' : issueCount; badge.classList.remove('hidden'); } else badge.classList.add('hidden');
    var quality = Math.max(0, 100 - Math.min(60, issueCount * 6) - Math.min(20, r.duplicatePct || 0));
    var h = '<div class="research-overview"><div><span>RESEARCH AUDIT</span><h3>' + escapeHtml(r.dataset.name) + '</h3><p>' + fmtInt(r.rows) + ' rows × ' + fmtInt(r.columnsCount) + ' columns' + (r.sampled ? ' · sampled' : '') + '</p></div><div class="research-score"><b>' + Math.round(quality) + '</b><span>quality score</span></div><button id="btn-generate-tests" class="btn btn-accent btn-sm">Generate data tests</button></div>';
    h += '<div class="research-grid"><section><h4>Quality & scientific risks</h4><div class="research-findings">';
    var findings = (r.warnings || []).concat(r.leakage || []);
    h += findings.length ? findings.map(function (f) { return '<div class="finding ' + escapeHtml(f.severity || 'info') + '"><i>' + severityIcon(f.severity) + '</i><span>' + escapeHtml(f.message || (f.column + ': ' + f.reason)) + '</span></div>'; }).join('') : '<div class="research-good">No major data-quality flags detected in the sampled data.</div>';
    h += '</div></section><section><h4>Methodology validation</h4><div class="method-list">' + (r.methodology.checks || []).map(function (c) { return '<div class="' + (c.ok ? 'pass' : 'fail') + '"><i>' + (c.ok ? '✓' : '○') + '</i><span><b>' + escapeHtml(c.label) + '</b><small>' + escapeHtml(c.ok ? 'Detected in project code' : c.guidance) + '</small></span></div>'; }).join('') + '</div></section></div>';
    if (r.target) {
      h += '<section class="research-section"><h4>Target: ' + escapeHtml(r.target.name) + '</h4>';
      if (r.target.kind === 'categorical') h += '<div class="class-bars">' + (r.target.distribution || []).slice(0,12).map(function (x) { return '<div><span>' + escapeHtml(x.value) + '</span><i><em style="width:' + Math.max(1,x.pct) + '%"></em></i><b>' + fmtStat(x.pct) + '%</b></div>'; }).join('') + '</div>';
      else h += '<p class="research-ci">Mean ' + fmtStat(r.target.mean) + ' · 95% CI [' + fmtStat(r.target.meanCI95[0]) + ', ' + fmtStat(r.target.meanCI95[1]) + ']</p>';
      h += '</section>';
    }
    h += '<section class="research-section"><h4>Column profile</h4><div class="research-table-wrap"><table><thead><tr><th>Column</th><th>Type</th><th>Unit</th><th>Missing</th><th>Unique</th><th>Outliers</th><th>Mean / top value</th><th>95% CI / normality</th></tr></thead><tbody>' + (r.columns || []).map(function (c) { var top = c.kind === 'categorical' && c.topValues && c.topValues[0]; return '<tr><td>' + escapeHtml(c.name) + '</td><td>' + escapeHtml(c.kind || c.dtype) + '</td><td>' + escapeHtml(c.unit || '—') + '</td><td>' + fmtStat(c.missingPct) + '%</td><td>' + fmtInt(c.unique) + '</td><td>' + (c.outliers == null ? '—' : fmtInt(c.outliers) + ' (' + fmtStat(c.outlierPct) + '%)') + '</td><td>' + (c.kind === 'numeric' ? fmtStat(c.mean) : (top ? escapeHtml(top.value) + ' (' + fmtStat(top.pct) + '%)' : '—')) + '</td><td>' + (c.meanCI95 ? '[' + fmtStat(c.meanCI95[0]) + ', ' + fmtStat(c.meanCI95[1]) + ']' : (c.normality ? (c.normality.likelyNormal ? 'likely normal' : 'non-normal') : '—')) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
    if ((r.correlations || []).length) h += '<section class="research-section"><h4>Strongest correlations</h4><div class="research-corrs">' + r.correlations.slice(0,20).map(function (c) { return '<span class="' + (Math.abs(c.r) >= .8 ? 'strong' : '') + '">' + escapeHtml(c.a) + ' ↔ ' + escapeHtml(c.b) + ' <b>' + (c.r>0?'+':'') + fmtStat(c.r) + '</b></span>'; }).join('') + '</div></section>';
    if ((r.suggestions || []).length) h += '<section class="research-section"><h4>Suggested next steps</h4><ol class="research-suggestions">' + r.suggestions.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('') + '</ol></section>';
    $('#research-body').innerHTML = h;
  }
  function renderEvaluation() {
    $('#research-body').innerHTML = '<div class="research-empty"><b>Comparing experiment history…</b></div>';
    garm.research.compareRuns().then(function (res) {
      var h = '<div class="research-overview"><div><span>MODEL EVALUATION</span><h3>' + res.runs.length + ' recorded runs</h3><p>Best values are selected by metric direction; compare methodology before declaring a winner.</p></div></div>';
      if (!res.metrics.length) h += '<div class="research-empty"><b>No comparable metrics yet.</b><span>Print metrics such as accuracy, F1, RMSE, or loss during runs.</span></div>';
      else h += '<div class="metric-compare">' + res.metrics.map(function (m) { return '<section><div><span>' + escapeHtml(m.name) + '</span><b>Best: ' + fmtStat(m.best.value) + '</b><small>' + escapeHtml(m.best.file) + ' · ' + new Date(m.best.startedAt).toLocaleString() + '</small></div><div class="metric-values">' + m.values.slice(0,20).map(function (v) { return '<span title="' + escapeHtml(v.file) + '">' + fmtStat(v.value) + '</span>'; }).join('') + '</div></section>'; }).join('') + '</div>';
      $('#research-body').innerHTML = h;
    });
  }
  function renderRepro() {
    $('#research-body').innerHTML = '<div class="research-empty"><b>Loading reproducibility manifests…</b></div>';
    garm.reproducibility.list().then(function (items) {
      $('#research-body').innerHTML = items.length ? '<div class="repro-list">' + items.map(function (m) { return '<details><summary><span><b>' + escapeHtml(m.run.file) + '</b><small>' + new Date(m.createdAt).toLocaleString() + ' · exit ' + m.run.exitCode + '</small></span><code>' + escapeHtml((m.code.sha256 || '').slice(0,12)) + '</code></summary><div class="repro-detail"><p><b>Python</b> ' + escapeHtml(m.python.version || m.python.executable) + ' · ' + (m.python.packages || []).length + ' packages</p><p><b>Hardware</b> ' + escapeHtml(m.hardware.cpu) + ' · ' + m.hardware.cpuCores + ' cores · ' + fmtBytes(m.hardware.memoryBytes) + ' RAM</p><p><b>Datasets</b> ' + (m.datasets || []).length + ' hashed · <b>Seeds</b> ' + (m.seeds || []).length + ' detected</p><p><b>Source SHA-256</b> <code>' + escapeHtml(m.code.sha256 || 'unavailable') + '</code></p></div></details>'; }).join('') + '</div>' : '<div class="research-empty"><b>No manifests yet.</b><span>Run a script or notebook; Cicada will capture one automatically.</span></div>';
    });
  }
  function switchResearchView(view) {
    researchView = view; document.querySelectorAll('[data-research-view]').forEach(function (b) { b.classList.toggle('active', b.dataset.researchView === view); });
    if (view === 'evaluation') renderEvaluation(); else if (view === 'repro') renderRepro(); else if (currentResearchReport) renderResearchAudit(currentResearchReport); else $('#research-body').innerHTML = '<div class="research-empty"><b>Choose a dataset to begin.</b><span>Cicada will compute quality, uncertainty, leakage, and methodology checks locally.</span></div>';
  }
  function wireResearch() {
    $('#research-dataset').addEventListener('change', researchDatasetChanged);
    $('#btn-research-audit').addEventListener('click', function () {
      var id=$('#research-dataset').value; if(!id)return; var btn=this; btn.disabled=true; btn.textContent='Auditing…';
      $('#research-body').innerHTML='<div class="research-empty"><b>Profiling data and validating scientific assumptions…</b><span>Large datasets are sampled at 200,000 rows.</span></div>';
      garm.research.analyze(id,$('#research-target').value).then(function(r){if(!r.ok)throw new Error(r.error);renderResearchAudit(r);}).catch(function(err){$('#research-body').innerHTML='<div class="research-empty out-err">'+escapeHtml(err.message)+'</div>';}).finally(function(){btn.disabled=false;btn.textContent='Run audit';});
    });
    $('.research-nav').addEventListener('click', function(e){var b=e.target.closest('[data-research-view]');if(b)switchResearchView(b.dataset.researchView);});
    $('#research-body').addEventListener('click', function(e){if(!e.target.closest('#btn-generate-tests')||!currentResearchReport)return;garm.research.generateTests(currentResearchReport).then(function(res){renderTree(res.tree);toast('Generated '+res.path,'ok');openFile(res.path);});});
    garm.on('repro:update', function(){if(researchView==='repro')renderRepro();});
    renderResearchDatasets();
  }

  // ---- Experiment tracker (Runs tab) --------------------------------------
  var runsList = [];
  var LOWER_BETTER = /loss|err|rmse|mse|mae|mape|perplexity|ppl/i;

  function fmtDur(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }

  function timeAgo(iso) {
    var d = new Date(iso).getTime();
    if (!isFinite(d)) return '';
    var s = Math.max(0, Math.round((Date.now() - d) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  // Per-metric best values across the history, so the table can badge them.
  function bestMetricValues(runs) {
    var best = {};
    runs.forEach(function (r) {
      Object.keys(r.metrics || {}).forEach(function (k) {
        var v = r.metrics[k];
        if (typeof v !== 'number') return;
        if (!(k in best)) { best[k] = v; return; }
        best[k] = LOWER_BETTER.test(k) ? Math.min(best[k], v) : Math.max(best[k], v);
      });
    });
    return best;
  }

  function renderRuns(list) {
    runsList = Array.isArray(list) ? list : [];
    var badge = $('#runs-badge');
    if (runsList.length) { badge.textContent = String(runsList.length); badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
    var body = $('#runs-body');
    var summary = $('#runs-summary');
    if (!runsList.length) {
      summary.textContent = 'Every program run is recorded here with its metrics.';
      body.innerHTML = '<div class="empty-hint">No runs yet. Run a program (or let the agent verify one) — Cicada parses metrics like <b>loss</b>, <b>accuracy</b>, <b>f1</b>, <b>rmse</b> straight from the output and tracks them across runs.</div>';
      return;
    }
    var withMetrics = runsList.filter(function (r) { return Object.keys(r.metrics || {}).length; }).length;
    summary.textContent = runsList.length + ' run' + (runsList.length > 1 ? 's' : '') + ' · ' + withMetrics + ' with metrics';
    var best = bestMetricValues(runsList);
    var h = '';
    runsList.forEach(function (r) {
      var ok = r.exitCode === 0;
      h += '<div class="run-row' + (ok ? '' : ' failed') + '">';
      h += '<span class="run-dot ' + (ok ? 'ok' : 'bad') + '" title="exit ' + escapeHtml(String(r.exitCode)) + '"></span>';
      h += '<span class="run-file" title="' + escapeHtml(r.file) + '">' + escapeHtml(r.file) + '</span>';
      h += '<span class="run-meta">' + escapeHtml(r.source) + ' · ' + escapeHtml(timeAgo(r.startedAt)) + ' · ' + escapeHtml(fmtDur(r.durationMs));
      if (r.epochs != null) h += ' · ' + fmtInt(r.epochs) + ' epochs';
      if (r.images) h += ' · ' + r.images + ' plot' + (r.images > 1 ? 's' : '');
      h += '</span>';
      h += '<span class="run-metrics">';
      Object.keys(r.metrics || {}).forEach(function (k) {
        var v = r.metrics[k];
        var isBest = best[k] === v && runsList.length > 1;
        h += '<span class="run-metric' + (isBest ? ' best' : '') + '" title="' + (isBest ? 'best across runs' : '') + '">'
          + escapeHtml(k) + ' <b>' + fmtStat(v) + '</b>' + (isBest ? ' ★' : '') + '</span>';
      });
      h += '</span>';
      h += '<button class="run-x" data-run-del="' + escapeHtml(r.id) + '" title="Delete this run">×</button>';
      h += '</div>';
    });
    body.innerHTML = h;
  }

  function wireRuns() {
    garm.on('experiments:update', renderRuns);
    garm.experiments.list().then(renderRuns).catch(function () { /* ignore */ });
    $('#runs-body').addEventListener('click', function (e) {
      var t = e.target.closest('[data-run-del]');
      if (!t) return;
      garm.experiments.remove(t.getAttribute('data-run-del')).then(renderRuns);
    });
    $('#btn-runs-clear').addEventListener('click', function () {
      garm.experiments.clear().then(renderRuns);
    });
    $('#btn-runs-export').addEventListener('click', function () {
      garm.experiments.exportCsv().then(function (res) {
        appendConsole('\n[runs] exported ' + res.path + '\n', false, true);
        flashTab('runs');
      }).catch(function (err) { appendConsole('\n[runs] export failed: ' + err.message + '\n', true); });
    });
  }

  // ---- Project snapshots (History tab) -------------------------------------
  function reloadActiveFile() {
    if (!activeFile) { refreshTree(); return; }
    garm.files.read(activeFile).then(function (res) {
      if (res && res.openable !== false) { window.GARMEditor.setValue(res.content); loadedFile = res.path; }
      refreshTree();
    }).catch(function () { refreshTree(); });
  }

  function renderSnaps(list) {
    var snaps = Array.isArray(list) ? list : [];
    var body = $('#snap-body');
    var summary = $('#snap-summary');
    if (!snaps.length) {
      summary.textContent = 'Checkpoints of your project source. One is taken automatically before every agent edit.';
      body.innerHTML = '<div class="empty-hint">No snapshots yet. Cicada checkpoints your source before every agent operation, and you can snapshot manually before trying something risky. Restoring merges the snapshot back over the project (a safety snapshot is taken first).</div>';
      return;
    }
    summary.textContent = snaps.length + ' snapshot' + (snaps.length > 1 ? 's' : '') + ' · newest first';
    var h = '';
    snaps.forEach(function (s) {
      h += '<div class="snap-row">';
      h += '<span class="snap-kind ' + (s.auto ? 'auto' : 'manual') + '">' + (s.auto ? 'auto' : 'manual') + '</span>';
      h += '<span class="snap-label" title="' + escapeHtml(s.label) + '">' + escapeHtml(s.label) + '</span>';
      h += '<span class="snap-meta">' + escapeHtml(timeAgo(s.createdAt)) + ' · ' + fmtInt(s.fileCount) + ' files · ' + fmtBytes(s.bytes) + '</span>';
      h += '<button class="btn btn-ghost btn-sm" data-snap-restore="' + escapeHtml(s.id) + '" title="Merge this snapshot back over the project (a safety snapshot is taken first)">Restore</button>';
      h += '<button class="run-x" data-snap-del="' + escapeHtml(s.id) + '" title="Delete this snapshot">×</button>';
      h += '</div>';
    });
    body.innerHTML = h;
  }

  function wireHistory() {
    garm.on('snapshots:update', renderSnaps);
    garm.snapshots.list().then(renderSnaps).catch(function () { /* ignore */ });
    $('#btn-snap-now').addEventListener('click', function () {
      garm.snapshots.create('manual snapshot').then(function (res) {
        renderSnaps(res.snapshots);
        appendConsole('\n[history] snapshot saved' + (res.meta ? ' (' + res.meta.fileCount + ' files)' : '') + '\n', false, true);
      }).catch(function (err) { appendConsole('\n[history] snapshot failed: ' + err.message + '\n', true); });
    });
    $('#snap-body').addEventListener('click', function (e) {
      var t = e.target.closest('[data-snap-restore],[data-snap-del]');
      if (!t) return;
      if (t.hasAttribute('data-snap-del')) {
        garm.snapshots.remove(t.getAttribute('data-snap-del')).then(renderSnaps);
        return;
      }
      t.disabled = true;
      garm.snapshots.restore(t.getAttribute('data-snap-restore')).then(function (res) {
        renderSnaps(res.snapshots);
        if (res.ok) {
          appendConsole('\n[history] restored ' + res.restored + ' file' + (res.restored === 1 ? '' : 's') + ' — a safety snapshot of the previous state was saved.\n', false, true);
          reloadActiveFile();
        } else {
          appendConsole('\n[history] restore failed: ' + (res.error || 'unknown error') + '\n', true);
        }
      }).catch(function (err) { appendConsole('\n[history] restore failed: ' + err.message + '\n', true); });
    });
  }

  // ---- Dependency doctor (Env tab) -----------------------------------------
  var doctorDeps = [];

  function renderDoctor(res) {
    var box = $('#doctor-body');
    box.classList.remove('hidden');
    if (!res) { box.innerHTML = '<div class="empty-hint">Scanning project imports…</div>'; return; }
    doctorDeps = res.deps || [];
    if (!doctorDeps.length) {
      box.innerHTML = '<div class="doctor-head ok">✓ No third-party imports found in this project.</div>';
      return;
    }
    var missing = res.missing || [];
    var h = '<div class="doctor-head' + (missing.length ? ' warn' : ' ok') + '">'
      + (missing.length
        ? '⚠ ' + missing.length + ' of ' + doctorDeps.length + ' imported package' + (doctorDeps.length > 1 ? 's are' : ' is') + ' not installed'
        : '✓ All ' + doctorDeps.length + ' imported packages are installed')
      + (res.ok === false && res.error ? ' <span class="muted">(' + escapeHtml(res.error) + ')</span>' : '')
      + '</div>';
    h += '<div class="doctor-chips">';
    doctorDeps.forEach(function (d) {
      if (d.installed === false) {
        h += '<span class="env-chip off"><span title="imported in: ' + escapeHtml((d.files || []).join(', ')) + '">' + escapeHtml(d.module) + '</span>'
          + '<button class="env-add" data-doc-install="' + escapeHtml(d.pip) + '" title="pip install ' + escapeHtml(d.pip) + '">+</button></span>';
      } else {
        h += '<span class="env-chip on" title="imported in: ' + escapeHtml((d.files || []).join(', ')) + '">' + escapeHtml(d.module)
          + (d.version ? ' <span class="env-ver">' + escapeHtml(d.version) + '</span>' : '') + '</span>';
      }
    });
    h += '</div><div class="doctor-actions">';
    if (missing.length) h += '<button id="btn-doctor-install-all" class="btn btn-accent btn-sm">Install all missing (' + missing.length + ')</button>';
    h += '<button id="btn-doctor-reqs" class="btn btn-ghost btn-sm" title="Write requirements.txt pinned to the installed versions">Write requirements.txt</button>';
    h += '</div>';
    box.innerHTML = h;

    box.querySelectorAll('[data-doc-install]').forEach(function (b) {
      b.addEventListener('click', function () { startInstall(b.getAttribute('data-doc-install')); });
    });
    var all = box.querySelector('#btn-doctor-install-all');
    if (all) {
      all.addEventListener('click', function () {
        all.disabled = true;
        switchDock('console');
        // Installs run strictly one at a time (pip is not concurrency-safe), then rescan.
        var queue = missing.slice();
        var next = function () {
          if (!queue.length) {
            appendConsole('\n[doctor] all installs finished — rescanning…\n', false, true);
            runDoctor();
            return;
          }
          var pkg = queue.shift();
          appendConsole('\n[pip] installing ' + pkg + ' …\n', false, true);
          garm.env.install(pkg).then(next).catch(next);
        };
        next();
      });
    }
    var reqs = box.querySelector('#btn-doctor-reqs');
    if (reqs) {
      reqs.addEventListener('click', function () {
        garm.doctor.writeRequirements(doctorDeps).then(function (r) {
          appendConsole('\n[doctor] wrote ' + r.path + ' (' + r.count + ' packages)\n', false, true);
          refreshTree();
        }).catch(function (err) { appendConsole('\n[doctor] ' + err.message + '\n', true); });
      });
    }
  }

  function runDoctor() {
    renderDoctor(null); // scanning state
    garm.doctor.scan().then(renderDoctor).catch(function (err) {
      $('#doctor-body').innerHTML = '<div class="ds-error">' + escapeHtml(err.message) + '</div>';
    });
  }

  function wireDoctor() {
    $('#btn-env-doctor').addEventListener('click', function () { switchDock('env'); runDoctor(); });
  }

  // ---- System monitor (dock strip) ------------------------------------------
  function fmtGb(bytes) { return (bytes / 1073741824).toFixed(1); }

  function renderSysmon(s) {
    var el = $('#sysmon');
    if (!el || !s) return;
    var bits = [];
    if (s.cpuPct != null) bits.push('CPU ' + s.cpuPct + '%');
    if (s.ram) bits.push('RAM ' + fmtGb(s.ram.usedBytes) + '/' + fmtGb(s.ram.totalBytes) + ' GB');
    if (s.gpu) {
      if (s.gpu.gpuPct != null) bits.push('GPU ' + s.gpu.gpuPct + '%');
      if (s.gpu.vramTotalMB) bits.push('VRAM ' + (s.gpu.vramUsedMB / 1024).toFixed(1) + '/' + (s.gpu.vramTotalMB / 1024).toFixed(1) + ' GB');
    }
    el.textContent = bits.join(' · ');
    el.classList.toggle('hot', (s.cpuPct || 0) >= 90 || !!(s.gpu && s.gpu.vramTotalMB && s.gpu.vramUsedMB / s.gpu.vramTotalMB >= 0.92));
  }

  function wireSysmon() {
    garm.on('sysmon:update', renderSysmon);
  }

  // ---- Onboarding / welcome tour -----------------------------------------
  // A swipeable welcome over the cicada artwork: page 0 is the full cover, and
  // pages 1+ slide a text column over the left half while the cicada stays put.
  // Shows once on first run (flagged in localStorage); the ✦ top-bar button
  // reopens it. Keyboard ←/→ and Esc, clickable dots, and pointer-drag swipe.
  var ONBOARD_SEEN_KEY = 'cicada.onboarding.seen.v1';
  function wireOnboarding() {
    var overlay = $('#onboard-overlay');
    var modal = $('#onboard-modal');
    var track = $('#onboard-track');
    var dotsWrap = $('#onboard-dots');
    var btnBack = $('#onboard-back');
    var btnNext = $('#onboard-next');
    var btnSkip = $('#onboard-skip');
    var btnClose = $('#onboard-close');
    if (!overlay || !track) return;

    var slides = track.querySelectorAll('.onboard-slide');
    var count = slides.length;
    var index = 0;

    var dots = [];
    for (var i = 0; i < count; i++) {
      var d = document.createElement('button');
      d.className = 'onboard-dot';
      d.type = 'button';
      d.setAttribute('role', 'tab');
      d.setAttribute('aria-label', 'Page ' + (i + 1));
      (function (n) { d.addEventListener('click', function () { go(n); }); })(i);
      dotsWrap.appendChild(d);
      dots.push(d);
    }

    function render() {
      track.style.transform = 'translateX(-' + (index * 100) + '%)';
      modal.classList.toggle('show-text', index > 0);
      for (var i = 0; i < count; i++) dots[i].classList.toggle('active', i === index);
      btnBack.style.visibility = index > 0 ? 'visible' : 'hidden';
      btnSkip.style.display = index < count - 1 ? '' : 'none';
      btnNext.textContent = index === 0 ? 'Get started' : (index === count - 1 ? 'Start building' : 'Next');
    }
    function go(n) { index = Math.max(0, Math.min(count - 1, n)); render(); }
    function next() { if (index < count - 1) go(index + 1); else close(); }
    function prev() { go(index - 1); }

    function open() {
      go(0);
      overlay.classList.remove('hidden');
      document.addEventListener('keydown', onKey, true);
    }
    function close() {
      overlay.classList.add('hidden');
      document.removeEventListener('keydown', onKey, true);
      try { localStorage.setItem(ONBOARD_SEEN_KEY, '1'); } catch (e) {}
    }
    function onKey(e) {
      if (overlay.classList.contains('hidden')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    }

    btnNext.addEventListener('click', next);
    btnBack.addEventListener('click', prev);
    btnSkip.addEventListener('click', close);
    btnClose.addEventListener('click', close);
    // Click the dim backdrop (outside the card) to dismiss.
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });

    // Pointer-drag swipe across the card (ignoring the nav + close controls).
    var dragX = null;
    modal.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.onboard-nav') || e.target.closest('.onboard-close')) return;
      dragX = e.clientX;
    });
    window.addEventListener('pointerup', function (e) {
      if (dragX === null) return;
      var dx = e.clientX - dragX; dragX = null;
      if (Math.abs(dx) > 48) { if (dx < 0) next(); else prev(); }
    });

    // ---- Kinetic-typography intro (splash leading into the modal) ----------
    // Beat-timed words on alternating black/white backgrounds, each with a GPU-only
    // (transform/opacity/blur) Apple-smooth motion, ending on a serif "Cicada" reveal that
    // cross-dissolves into the modal. Skippable (click / Esc / Space) + reduced-motion aware.
    var introEl = $('#onboard-intro');
    var introStage = $('#onboard-intro-stage');
    var reduceMotion = (function () { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } })();
    // Each beat's `hold` is the gap before the NEXT word spawns; a word's full
    // lifetime is longer (hold / EXIT_FRAC) so its exit overlaps the next word's
    // enter — that overlap, plus the extended-ease relay spine, is what keeps the
    // motion continuous. `g` picks the inner-glyph accent (see styles.css).
    var EXIT_FRAC = 0.62;
    var INTRO_SEQ = [
      { w: 'you',      theme: 'light', g: 'g-soft',   hold: 480 },
      { w: 'just ask', theme: 'dark',  g: 'g-bounce', hold: 380 },
      { w: 'it',       theme: 'dark',  g: 'g-soft',   hold: 340 },
      { w: 'build',    theme: 'dark',  g: 'g-weight', hold: 520 },
      { w: 'models',   theme: 'light', g: 'g-bounce', hold: 460 },
      { w: 'train',    theme: 'light', g: 'g-soft',   hold: 440 },
      { w: 'explore',  theme: 'dark',  g: 'g-skew',   hold: 480 },
      { w: 'ideas',    theme: 'light', g: 'g-weight', hold: 460 },
      { w: 'Cicada',   theme: 'dark',  g: 'g-reveal', hold: 940, brand: true },
    ];
    var introTimers = [];
    var introActive = false;

    function introClear() {
      introTimers.forEach(clearTimeout); introTimers = [];
      document.removeEventListener('keydown', introKey, true);
      if (introEl) introEl.removeEventListener('click', introSkip);
      introActive = false;
    }
    function introEnd() {
      introClear();
      open(); // the modal pops in behind the fading intro (cross-dissolve)
      if (!introEl) return;
      introEl.classList.add('intro-out');
      setTimeout(function () {
        introEl.classList.add('hidden');
        introEl.classList.remove('intro-out', 'intro-dark', 'intro-light');
        if (introStage) introStage.textContent = ''; // clear spawned words for a clean replay
      }, 440);
    }
    function introSkip() { if (introActive) introEnd(); }
    function introKey(e) {
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); introSkip(); }
    }
    // Spawn one word as a fresh element so it can finish its exit while the next
    // word is already entering. The word carries the shared relay; an inner glyph
    // carries the per-word accent. `--beat` drives both animations' duration.
    function introSpawn(s) {
      var life = s.brand ? s.hold : Math.round(s.hold / EXIT_FRAC);
      var word = document.createElement('div');
      word.className = 'onboard-intro-word ' + (s.theme === 'dark' ? 'w-on-dark' : 'w-on-light');
      if (s.brand) word.classList.add('is-brand');
      word.style.setProperty('--beat', life + 'ms');
      var glyph = document.createElement('span');
      glyph.className = 'intro-glyph ' + s.g;
      glyph.textContent = s.w;
      word.appendChild(glyph);
      introStage.appendChild(word);
      // Transitional words remove themselves once they've relayed out; the brand
      // word stays put and hands off into the modal.
      if (!s.brand) word.addEventListener('animationend', function (e) {
        if (e.target === word) word.remove();
      });
    }
    function playIntro() {
      if (!introEl || !introStage) { open(); return; }
      introActive = true;
      introEl.classList.remove('hidden', 'intro-out');
      introStage.textContent = '';
      document.addEventListener('keydown', introKey, true);
      introEl.addEventListener('click', introSkip);
      var i = 0;
      (function step() {
        if (!introActive) return;
        if (i >= INTRO_SEQ.length) return;
        var s = INTRO_SEQ[i++];
        introEl.classList.toggle('intro-dark', s.theme === 'dark');
        introEl.classList.toggle('intro-light', s.theme !== 'dark');
        introSpawn(s);
        // Hand off to the modal on the brand beat; otherwise queue the next word.
        introTimers.push(setTimeout(s.brand ? introEnd : step, s.hold));
      })();
    }
    // Entry point: play the intro, then open the modal. Guards against stacking, and
    // skips straight to the modal when the user prefers reduced motion.
    function openWithIntro() {
      if (!overlay.classList.contains('hidden') || introActive) return;
      if (reduceMotion) { open(); return; }
      playIntro();
    }

    var welcomeBtn = $('#btn-welcome');
    if (welcomeBtn) welcomeBtn.addEventListener('click', openWithIntro);

    wireOnboarding._open = openWithIntro;
    wireOnboarding._seen = function () {
      try { return localStorage.getItem(ONBOARD_SEEN_KEY) === '1'; } catch (e) { return false; }
    };
  }

  // First run only: show the tour right after the loading splash clears.
  function maybeShowOnboarding() {
    if (typeof wireOnboarding._open !== 'function') return;
    if (wireOnboarding._seen && wireOnboarding._seen()) return;
    setTimeout(wireOnboarding._open, 220);
  }

  // ---- First-run signup ----------------------------------------------------
  // Shown once, before the welcome tour. Submitting stores the profile locally and
  // (when telemetry is enabled in the build) delivers it once to the developer's
  // private repo — exactly what the consent line on the form says. Fully skippable,
  // and either path chains into the onboarding tour.
  function wireSignup() {
    var overlay = $('#signup-overlay');
    if (!overlay) return;
    var name = $('#signup-name');
    var email = $('#signup-email');
    var errEl = $('#signup-error');

    function close() {
      overlay.classList.add('hidden');
      maybeShowOnboarding();
    }
    function submit() {
      var e = email.value.trim();
      // A signup needs a plausible email; names are optional.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) {
        errEl.classList.remove('hidden');
        email.focus();
        return;
      }
      errEl.classList.add('hidden');
      $('#signup-submit').disabled = true;
      garm.profile.signup(name.value.trim(), e).then(function () {
        toast('Welcome aboard' + (name.value.trim() ? ', ' + name.value.trim().split(/\s+/)[0] : '') + '! 🎉', 'ok');
        close();
      }).catch(function () { close(); });
    }

    $('#signup-submit').addEventListener('click', submit);
    $('#signup-skip').addEventListener('click', function () {
      garm.profile.skip().catch(function () {});
      close();
    });
    [name, email].forEach(function (input) {
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    });
    email.addEventListener('input', function () { errEl.classList.add('hidden'); });

    wireSignup._open = function () {
      overlay.classList.remove('hidden');
      setTimeout(function () { name.focus(); }, 60);
    };
  }

  // Splash-clear entry point: signup first (once), then the tour.
  function maybeShowSignup() {
    garm.profile.get().then(function (p) {
      if (!p || p.signupDone) { maybeShowOnboarding(); maybeShowStarPrompt(p); return; }
      if (typeof wireSignup._open === 'function') wireSignup._open();
      else maybeShowOnboarding();
    }).catch(function () { maybeShowOnboarding(); });
  }

  // ---- "Star us on GitHub" prompt -------------------------------------------
  // One-time, after a few launches, never on the signup/tour run, and dismissible
  // forever. "Later" hides it for this launch only.
  var STAR_URL = 'https://github.com/godsonj64/Cicada';
  var STAR_MIN_LAUNCHES = 3;

  function maybeShowStarPrompt(p) {
    if (!p || p.starPromptDone || (p.launchCount || 0) < STAR_MIN_LAUNCHES) return;
    var pop = $('#star-popup');
    if (!pop) return;
    // Let the user settle in before asking anything of them.
    setTimeout(function () {
      pop.classList.remove('hidden');
      requestAnimationFrame(function () { pop.classList.add('show'); });
    }, 20000);
  }

  function wireStarPrompt() {
    var pop = $('#star-popup');
    if (!pop) return;
    function hide() {
      pop.classList.remove('show');
      setTimeout(function () { pop.classList.add('hidden'); }, 250);
    }
    $('#star-go').addEventListener('click', function () {
      garm.shell.openExternal(STAR_URL);
      garm.star.dismiss().catch(function () {});
      hide();
    });
    $('#star-later').addEventListener('click', hide);
    $('#star-never').addEventListener('click', function () {
      garm.star.dismiss().catch(function () {});
      hide();
    });
  }

  // ---- Global project search ---------------------------------------------
  var searchTimer = null;
  var searchRequest = 0;

  function closeSearch() { $('#search-overlay').classList.add('hidden'); }
  function openSearch() {
    $('#search-overlay').classList.remove('hidden');
    setTimeout(function () { $('#search-input').focus(); $('#search-input').select(); }, 0);
  }
  function runSearch() {
    var query = $('#search-input').value.trim();
    var summary = $('#search-summary');
    var root = $('#search-results');
    clearTimeout(searchTimer);
    if (query.length < 2) { summary.textContent = 'Type at least 2 characters to search.'; root.innerHTML = ''; return; }
    summary.textContent = 'Searching…';
    var request = ++searchRequest;
    searchTimer = setTimeout(function () {
      garm.files.search(query, { caseSensitive: $('#search-case').checked, limit: 250 }).then(function (results) {
        if (request !== searchRequest) return;
        summary.textContent = results.length + ' result' + (results.length === 1 ? '' : 's') + (results.length === 250 ? ' (limit reached)' : '');
        if (!results.length) { root.innerHTML = '<div class="search-empty">No matches in source files.</div>'; return; }
        root.innerHTML = results.map(function (r) {
          return '<button class="search-result" data-path="' + escapeHtml(r.path) + '" data-line="' + r.line + '" data-column="' + r.column + '">' +
            '<span class="search-result-loc"><b>' + escapeHtml(r.path) + '</b><span>' + r.line + ':' + r.column + '</span></span>' +
            '<span class="search-result-preview">' + escapeHtml(r.preview || '(blank line)') + '</span></button>';
        }).join('');
      }).catch(function (err) { if (request === searchRequest) { summary.textContent = 'Search failed'; root.innerHTML = '<div class="search-empty out-err">' + escapeHtml(err.message) + '</div>'; } });
    }, 140);
  }
  function wireSearch() {
    $('#btn-search').addEventListener('click', openSearch);
    $('#search-input').addEventListener('input', runSearch);
    $('#search-case').addEventListener('change', runSearch);
    $('#search-overlay').addEventListener('mousedown', function (e) { if (e.target === e.currentTarget) closeSearch(); });
    $('#search-results').addEventListener('click', function (e) {
      var row = e.target.closest('.search-result'); if (!row) return;
      closeSearch();
      openFile(row.dataset.path).then(function (opened) {
        if (opened !== false) window.GARMEditor.setSelection({ startLine: Number(row.dataset.line), startColumn: Number(row.dataset.column), endLine: Number(row.dataset.line), endColumn: Number(row.dataset.column) + 1 });
      });
    });
  }

  // ---- Mission Control ----------------------------------------------------
  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function healthCard(title, state, detail, action, actionLabel) {
    return '<div class="health-card ' + state + '"><div class="health-dot"></div><div class="health-copy"><span>' + escapeHtml(title) + '</span><small>' + escapeHtml(detail) + '</small></div>' +
      (action ? '<button class="btn btn-ghost btn-sm" data-dashboard-action="' + action + '">' + escapeHtml(actionLabel || 'Open') + '</button>' : '') + '</div>';
  }
  function renderDashboard(data) {
    var st = data.project.stats || {};
    var langs = Object.keys(st.languages || {}).sort(function (a, b) { return st.languages[b] - st.languages[a]; }).slice(0, 5);
    var modelOk = data.model.status === 'ready';
    var pyOk = data.python && !data.python.error;
    var gitOk = data.git && data.git.gitInstalled && data.git.isRepo;
    var missing = (data.dependencies && data.dependencies.missing) || [];
    var depOk = data.dependencies && data.dependencies.ok && !missing.length;
    var recentRuns = data.runs || [];
    var recentSnaps = data.snapshots || [];
    $('#dashboard-body').innerHTML =
      '<section class="dashboard-hero"><div><span>ACTIVE PROJECT</span><h3>' + escapeHtml(data.project.name) + '</h3><p>' + escapeHtml(data.project.path) + '</p></div>' +
      '<div class="stat-grid"><div><b>' + (st.files || 0) + '</b><span>files</span></div><div><b>' + (st.lines || 0).toLocaleString() + '</b><span>lines</span></div><div><b>' + formatBytes(st.bytes) + '</b><span>source</span></div><div><b>' + (recentRuns.length || 0) + '</b><span>recent runs</span></div></div></section>' +
      '<section class="dashboard-section"><div class="dashboard-section-title"><h3>Readiness</h3><span>Everything required to build and run</span></div><div class="health-grid">' +
      healthCard('AI model', modelOk ? 'ok' : 'warn', modelOk ? (data.model.provider === 'local' ? 'Local model ready' : 'Cloud provider ready') : (data.model.detail || data.model.status), modelOk ? '' : 'recover', 'Recover') +
      healthCard('Python', pyOk ? 'ok' : 'warn', pyOk ? (data.python.python || data.python.version || 'Interpreter detected') : data.python.error, 'env', 'Environment') +
      healthCard('Dependencies', depOk ? 'ok' : (missing.length ? 'warn' : 'neutral'), missing.length ? missing.length + ' missing: ' + missing.slice(0, 3).join(', ') : (depOk ? 'All detected imports available' : 'Run dependency scan'), 'doctor', 'Doctor') +
      healthCard('Version control', gitOk ? 'ok' : 'neutral', gitOk ? ((data.git.branch || 'main') + ' · ' + (data.git.changeCount || 0) + ' changes') : 'Project is not published yet', 'github', gitOk ? 'Open' : 'Set up') + '</div></section>' +
      '<section class="dashboard-section dashboard-columns"><div><div class="dashboard-section-title"><h3>Quick actions</h3></div><div class="quick-grid">' +
      '<button data-dashboard-action="run"><b>▶ Run current file</b><span>Execute and capture output</span></button><button data-dashboard-action="snapshot"><b>◇ Safe checkpoint</b><span>Save project state now</span></button><button data-dashboard-action="search"><b>⌕ Search project</b><span>Jump to any symbol or text</span></button><button data-dashboard-action="prompt"><b>✦ Ask the agent</b><span>Start a new build request</span></button></div></div>' +
      '<div><div class="dashboard-section-title"><h3>Project shape</h3></div><div class="language-list">' + (langs.length ? langs.map(function (l) { return '<div><span>.' + escapeHtml(l) + '</span><b>' + st.languages[l] + ' file' + (st.languages[l] === 1 ? '' : 's') + '</b></div>'; }).join('') : '<div class="muted">No source files yet.</div>') + '</div></div></section>' +
      '<section class="dashboard-section dashboard-columns"><div><div class="dashboard-section-title"><h3>Recent runs</h3><button data-dashboard-action="runs">View all</button></div><div class="activity-list">' + (recentRuns.length ? recentRuns.map(function (r) { return '<div><span class="activity-state ' + (r.exitCode === 0 ? 'ok' : 'bad') + '"></span><div><b>' + escapeHtml(r.file || 'main.py') + '</b><small>' + (r.exitCode === 0 ? 'Completed' : 'Exited ' + r.exitCode) + ' · ' + Math.round((r.durationMs || 0) / 1000) + 's</small></div></div>'; }).join('') : '<p class="muted">No runs recorded yet.</p>') + '</div></div>' +
      '<div><div class="dashboard-section-title"><h3>Safety net</h3><button data-dashboard-action="history">History</button></div><div class="activity-list">' + (recentSnaps.length ? recentSnaps.map(function (s) { return '<div><span class="activity-state snap"></span><div><b>' + escapeHtml(s.label || 'Snapshot') + '</b><small>' + (s.fileCount || 0) + ' files · ' + new Date(s.createdAt).toLocaleString() + '</small></div></div>'; }).join('') : '<p class="muted">No snapshots yet.</p>') + '</div></div></section>';
  }
  function loadDashboard() {
    $('#dashboard-body').innerHTML = '<div class="dashboard-loading">Scanning model, Python, dependencies, Git, and project files…</div>';
    garm.dashboard.get().then(renderDashboard).catch(function (err) { $('#dashboard-body').innerHTML = '<div class="dashboard-loading out-err">' + escapeHtml(err.message) + '</div>'; });
  }
  function openDashboard() {
    $('#dashboard-overlay').classList.remove('hidden');
    var modal = document.querySelector('.dashboard-modal');
    if (modal) modal.scrollTop = 0;
    loadDashboard();
    requestAnimationFrame(function () { if (modal) modal.scrollTop = 0; });
  }
  function closeDashboard() { $('#dashboard-overlay').classList.add('hidden'); }
  function wireDashboard() {
    $('#btn-dashboard').addEventListener('click', openDashboard);
    $('#btn-dashboard-close').addEventListener('click', closeDashboard);
    $('#btn-dashboard-refresh').addEventListener('click', loadDashboard);
    $('#dashboard-overlay').addEventListener('mousedown', function (e) { if (e.target === e.currentTarget) closeDashboard(); });
    $('#dashboard-body').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-dashboard-action]'); if (!btn) return;
      var action = btn.dataset.dashboardAction;
      if (action === 'recover') garm.llama.recover().then(loadDashboard);
      else if (action === 'run') { closeDashboard(); $('#btn-run').click(); }
      else if (action === 'snapshot') garm.snapshots.create('Mission Control checkpoint').then(function () { toast('Project checkpoint created.', 'ok'); loadDashboard(); });
      else if (action === 'search') { closeDashboard(); openSearch(); }
      else if (action === 'prompt') { closeDashboard(); $('#prompt').focus(); }
      else if (action === 'doctor') { closeDashboard(); switchDock('env'); $('#btn-env-doctor').click(); }
      else if (action === 'env' || action === 'github' || action === 'runs' || action === 'history') { closeDashboard(); switchDock(action); }
    });
  }

  // ---- Command palette + global hotkeys ------------------------------------
  // Ctrl/Cmd+Shift+P opens a fuzzy-searchable list of every IDE action, so nothing
  // requires hunting through toolbars. Ctrl/Cmd+S saves quietly with a toast.
  var paletteOpen = false;
  var paletteSel = 0;
  var paletteMatches = [];

  function saveActiveFile() {
    clearTimeout(autosaveTimer);
    var generation = ++saveGeneration;
    showSaveState('saving');
    garm.code.save(window.GARMEditor.getValue(), activeFile).then(function () {
      loadedFile = activeFile;
      if (generation === saveGeneration) showSaveState('saved');
      toast('Saved ' + activeFile, 'ok', 1600);
    }).catch(function (err) { showSaveState('error'); toast('Save failed: ' + err.message, 'err'); });
  }

  function paletteCommands() {
    var cmds = [
      { name: 'Agent: Run Pipeline', hint: 'Ctrl+↵', run: runPipeline },
      { name: 'Agent: Cancel Pipeline', run: function () { garm.pipeline.cancel(); } },
      { name: 'Agent: Edit Selection', hint: 'Ctrl+K', run: function () { openInpaint(); } },
      { name: 'File: Save', hint: 'Ctrl+S', run: saveActiveFile },
      { name: 'File: Run', run: function () { $('#btn-run').click(); } },
      { name: 'File: Stop Running Program', run: function () { garm.run.stop(); } },
      { name: 'File: Compile (Syntax Check)', run: function () { $('#btn-compile').click(); } },
      { name: 'File: New File', run: function () { openNew('file'); } },
      { name: 'File: New Folder', run: function () { openNew('dir'); } },
      { name: 'File: Refresh Explorer', run: refreshTree },
      { name: 'Search: Find in Project', hint: 'Ctrl+Shift+F', run: openSearch },
      { name: 'View: Mission Control', hint: 'Ctrl+Shift+M', run: openDashboard },
      { name: 'GitHub: Publish Project…', run: function () { switchDock('github'); loadGitHubStatus(); } },
      { name: 'GitHub: Commit & Push…', run: function () { switchDock('github'); loadGitHubStatus(); } },
      { name: 'GitHub: Generate Repo Files (README, .gitignore, LICENSE, requirements.txt)', run: ghGenerateFiles },
      { name: 'Output Mode: Single File', run: function () { setOutputMode('single', true); toast('New programs will be a single main.py', 'info'); } },
      { name: 'Output Mode: Multi-file Repo', run: function () { setOutputMode('repo', true); toast('New programs will be multi-file projects', 'info'); } },
      { name: 'Settings', run: openSettings },
      { name: 'Welcome Tour', run: function () { $('#btn-welcome').click(); } },
      { name: 'Open Project Folder', run: function () { garm.shell.showWorkspace(); } },
    ];
    ['console', 'render', 'data', 'notebook', 'research', 'runs', 'terminal', 'memory', 'env', 'history', 'github', 'problems', 'chat'].forEach(function (tab) {
      cmds.push({ name: 'View: ' + tab.charAt(0).toUpperCase() + tab.slice(1) + ' Tab', run: function () { switchDock(tab); } });
    });
    return cmds;
  }

  // Subsequence fuzzy match; lower score = better (earlier, tighter matches win).
  function fuzzyScore(query, text) {
    var q = query.toLowerCase(), t = text.toLowerCase();
    if (!q) return 0;
    var qi = 0, score = 0, last = -1;
    for (var ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) {
        score += (last >= 0 ? (ti - last - 1) : ti);
        last = ti; qi++;
      }
    }
    return qi === q.length ? score : -1;
  }

  function openPalette() {
    paletteOpen = true;
    $('#palette-overlay').classList.remove('hidden');
    var input = $('#palette-input');
    input.value = '';
    renderPalette('');
    setTimeout(function () { input.focus(); }, 0);
  }
  function closePalette() {
    paletteOpen = false;
    $('#palette-overlay').classList.add('hidden');
  }

  function renderPalette(query) {
    var all = paletteCommands();
    paletteMatches = all
      .map(function (c) { return { cmd: c, score: fuzzyScore(query, c.name) }; })
      .filter(function (m) { return m.score >= 0; })
      .sort(function (a, b) { return a.score - b.score; })
      .slice(0, 12);
    paletteSel = 0;
    var list = $('#palette-list');
    list.innerHTML = '';
    paletteMatches.forEach(function (m, i) {
      var row = document.createElement('div');
      row.className = 'palette-item' + (i === paletteSel ? ' sel' : '');
      row.innerHTML = '<span>' + escapeHtml(m.cmd.name) + '</span>' + (m.cmd.hint ? '<kbd>' + escapeHtml(m.cmd.hint) + '</kbd>' : '');
      row.addEventListener('click', function () { runPaletteItem(i); });
      row.addEventListener('mousemove', function () { setPaletteSel(i); });
      list.appendChild(row);
    });
    if (!paletteMatches.length) list.innerHTML = '<div class="palette-empty">No matching command</div>';
  }

  function setPaletteSel(i) {
    paletteSel = i;
    document.querySelectorAll('.palette-item').forEach(function (el, j) { el.classList.toggle('sel', j === i); });
  }

  function runPaletteItem(i) {
    var m = paletteMatches[i];
    closePalette();
    if (m) setTimeout(function () { m.cmd.run(); }, 0);
  }

  function wirePalette() {
    var input = $('#palette-input');
    input.addEventListener('input', function () { renderPalette(input.value.trim()); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteSel(Math.min(paletteSel + 1, paletteMatches.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteSel(Math.max(paletteSel - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(paletteSel); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    });
    $('#palette-overlay').addEventListener('mousedown', function (e) {
      if (e.target === e.currentTarget) closePalette();
    });
  }

  function wireHotkeys() {
    window.addEventListener('keydown', function (e) {
      var mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault(); e.stopPropagation();
        if (paletteOpen) closePalette(); else openPalette();
      } else if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault(); e.stopPropagation(); openSearch();
      } else if (mod && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        e.preventDefault(); e.stopPropagation(); openDashboard();
      } else if (e.key === 'Escape' && !$('#search-overlay').classList.contains('hidden')) {
        e.preventDefault(); closeSearch();
      } else if (e.key === 'Escape' && !$('#dashboard-overlay').classList.contains('hidden')) {
        e.preventDefault(); closeDashboard();
      } else if (mod && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveActiveFile();
      }
    }, true); // capture: fire even when Monaco has focus
  }

  // The UI ships with macOS key glyphs; swap them for Ctrl+ labels elsewhere.
  function fixPlatformKeys() {
    if (/Mac/i.test(navigator.platform)) return;
    var swap = function (s) {
      return s.replace(/⌘\s?↵/g, 'Ctrl+Enter').replace(/⌘K/g, 'Ctrl+K').replace(/⌘L/g, 'Ctrl+L').replace(/⌘/g, 'Ctrl+');
    };
    document.querySelectorAll('[title]').forEach(function (el) {
      if (el.title.indexOf('⌘') >= 0) el.title = swap(el.title);
    });
    document.querySelectorAll('kbd').forEach(function (el) {
      if (el.textContent.indexOf('⌘') >= 0) el.textContent = swap(el.textContent);
    });
    document.querySelectorAll('.chat-empty-sub, .onboard-p').forEach(function (el) {
      if (el.innerHTML.indexOf('⌘') >= 0) el.innerHTML = swap(el.innerHTML);
    });
  }

  // ---- Loading splash ----------------------------------------------------
  // The overlay + spin animation are pure CSS (they start the moment the page
  // paints). Here we just fade it out once the workbench is ready — but never
  // before the spin has had time to finish, and never hang if Monaco is slow.
  function dismissSplash() {
    var splash = document.getElementById('splash');
    if (!splash) return;
    var start = Date.now();
    var MIN_MS = 2100;   // let the slow→fast→slow spin complete (~2.05s)
    var MAX_MS = 4200;   // hard cap so a slow Monaco load can't strand the splash
    var settled = false;

    function remove() {
      if (splash && splash.parentNode) splash.parentNode.removeChild(splash);
      if (typeof afterSplash === 'function') { var fn = afterSplash; afterSplash = null; fn(); }
    }
    function hide() {
      splash.classList.add('hide');
      // Reveal the workbench: regions stream in (extended-ease) as the splash
      // fades. The class is transient — removed once the entrance finishes so it
      // never replays during normal use (e.g. when the file tree re-renders).
      document.body.classList.add('app-enter');
      setTimeout(function () { document.body.classList.remove('app-enter'); }, 1200);
      splash.addEventListener('transitionend', remove, { once: true });
      setTimeout(remove, 800); // fallback if transitionend doesn't fire
    }
    function go() {
      if (settled) return;
      settled = true;
      setTimeout(hide, Math.max(0, MIN_MS - (Date.now() - start)));
    }
    window.GARMEditor.whenReady(go); // editor ready ⇒ the workbench is painted
    setTimeout(go, MAX_MS);
  }

  // ---- Init --------------------------------------------------------------
  function init() {
    buildStages();
    wirePipeline();
    wireRun();
    wireDock();
    wireToolbar();
    wireStatus();
    wireSettings();
    wireSplitters();
    wireOutputMode();
    wireMisc();
    wireWindowControls();
    window.GARMEditor.init();
    window.GARMEditor.onChange(scheduleAutosave);
    wireInpaint();
    wireContextMenu();
    wireExplorer();
    wireMemory();
    wireEnv();
    wireData();
    wireNotebook();
    wireResearch();
    wireRuns();
    wireHistory();
    wireDoctor();
    wireSysmon();
    wireChat();
    wireGitHub();
    wirePalette();
    wireHotkeys();
    fixPlatformKeys();
    wireOnboarding();
    wireSignup();
    wireStarPrompt();
    wireSearch();
    wireDashboard();
    window.GARMTerm.init();
    applyStatus('starting');
    afterSplash = maybeShowSignup; // first-run signup → tour; later runs → star prompt
    dismissSplash();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
