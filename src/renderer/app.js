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
    garm.on('run:started', function (p) { setCodeRunning(true); appendConsole('> python ' + (p.file ? p.file.split('/').pop() : 'main.py') + '\n', false, true); });
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
      cap.textContent = img.path.split('/').pop();
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
    $('#btn-save').addEventListener('click', function () {
      garm.code.save(window.GARMEditor.getValue(), activeFile).then(function (p) {
        loadedFile = activeFile;
        flashTab('console'); appendConsole('Saved ' + p + '\n', false, true); switchDock('console');
      });
    });
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

  function runPipeline() {
    var req = $('#prompt').value.trim();
    if (!req) { $('#prompt').focus(); return; }
    if (!modelReady) return;
    garm.pipeline.run(req).catch(function (err) { appendConsole('\n[error] ' + err.message + '\n', true); setPipelineRunning(false); stopTimer(); });
  }

  // Post-edit agentic iteration: apply a change to the current editor code.
  function runRefine() {
    var req = $('#refine-input').value.trim();
    if (!req) { $('#refine-input').focus(); return; }
    if (!modelReady || pipelineRunning) return;
    var code = window.GARMEditor.getValue();
    garm.pipeline.refine(req, code, activeFile).catch(function (err) { appendConsole('\n[error] ' + err.message + '\n', true); setPipelineRunning(false); stopTimer(); });
    $('#refine-input').value = '';
  }

  function escapeHtml(s) { return String(s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); }

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

  // ---- Model status ------------------------------------------------------
  function applyStatus(status, detail) {
    var pill = $('#model-status');
    var text = pill.querySelector('.status-text');
    pill.className = 'status-pill status-' + (status || 'stopped');
    modelReady = status === 'ready';
    if (status === 'starting') text.textContent = 'Loading model';
    else if (status === 'ready') text.textContent = 'Model ready';
    else if (status === 'error') text.textContent = 'Error: ' + (detail || 'see logs');
    else text.textContent = 'Stopped';
    $('#btn-run-pipeline').disabled = pipelineRunning || !modelReady;
    $('#btn-refine').disabled = pipelineRunning || !modelReady;
    $('#btn-edit-selection').disabled = pipelineRunning || !modelReady;
    $('#btn-inpaint-apply').disabled = pipelineRunning || !modelReady;
  }

  function wireStatus() {
    garm.on('llama:status', function (p) { applyStatus(p.status, p.detail); });
    garm.on('llama:log', function () { /* available for a future logs panel */ });
    garm.llama.info().then(function (info) { applyStatus(info.status, info.lastError); });
  }

  // ---- Settings ----------------------------------------------------------
  var SERVER_FIELDS = ['modelPath', 'serverPort', 'contextSize', 'gpuLayers'];

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
    $('#btn-save-settings').addEventListener('click', function () {
      var next = {
        provider: $('#cfg-provider').value,
        deepseekModel: $('#cfg-deepseekModel').value,
        deepseekApiKey: $('#cfg-deepseekApiKey').value.trim(),
        modelPath: $('#cfg-modelPath').value.trim(),
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

  // ---- Projects + Files explorer ----------------------------------------
  var activeFile = 'main.py';  // project-relative path shown in the editor tab
  var loadedFile = null;       // the file whose content is actually in the editor
  var fileTree = [];
  var collapsed = {};          // rel dir path -> true when collapsed
  var ftNewKind = null;        // 'file' | 'dir' while the inline create input is open

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
    if (loadedFile && !pipelineRunning) garm.files.save(loadedFile, window.GARMEditor.getValue());
  }

  function openFile(rel) {
    if (!rel || rel === loadedFile) { if (rel) setActiveFile(rel); return; }
    flushEditor();
    garm.files.read(rel).then(function (res) {
      if (res.openable === false) {
        // Binary / oversized / folder: like a standard IDE, show a muted notice and leave the
        // currently open file untouched rather than treating it as an error.
        appendConsole('\n[files] ' + rel + ': ' + res.reason + '\n', false, true);
        return;
      }
      window.GARMEditor.setValue(res.content);
      loadedFile = res.path;
      setActiveFile(res.path);
    }).catch(function (err) {
      // Strip Electron's "Error invoking remote method '...': Error:" IPC wrapper so genuine
      // failures (e.g. a file deleted out from under us) read as plain English.
      var msg = (err && err.message ? err.message : String(err))
        .replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
      appendConsole('\n[files] ' + msg + '\n', true);
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
      var t = e.target.closest('[data-ds-open],[data-ds-remove],[data-ds-reanalyze],[data-ds-copy],[data-ds-install]');
      if (!t) return;
      if (t.hasAttribute('data-ds-open')) { switchDock('console'); openFile(t.getAttribute('data-ds-open')); }
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
    window.GARMEditor.init();
    wireInpaint();
    wireContextMenu();
    wireExplorer();
    wireMemory();
    wireEnv();
    wireData();
    wireChat();
    wireOnboarding();
    window.GARMTerm.init();
    applyStatus('starting');
    afterSplash = maybeShowOnboarding; // first-run tour, once the splash clears
    dismissSplash();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
