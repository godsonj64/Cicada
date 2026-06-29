// Monaco editor wrapper exposed as window.GARMEditor.
window.GARMEditor = (function () {
  var editor = null;
  var ready = false;
  var pending = [];
  var changeCb = null;
  var editSelectionCb = null;
  var askChatCb = null;
  var regionDecorations = [];
  var streamPrev = '';        // last value pushed during a live code stream (for delta appends)
  // Live-stream lifecycle. A code stage clears the editor and fills it as the model
  // writes — but the model may "think" for a long time before any code appears, or be
  // cut off before producing any, so we must NOT blank the editor until real code
  // arrives and must restore the prior code if the stage commits nothing.
  var streaming = false;      // between beginStream() and finishStreaming()
  var streamWrote = false;    // did any live code actually land in the buffer?
  var streamCommitted = false;// did an authoritative commitValue() land this stream?
  var streamSnapshot = '';    // editor contents captured when the stream began

  var WELCOME = [
    '# Cicada',
    '# Describe a program in the Agent panel and run the pipeline,',
    '# or write Python here directly and press Run.',
    '',
    'print("Hello from Cicada")',
    '',
  ].join('\n');

  function init() {
    require.config({ paths: { vs: window.__GARM_VS__ } });
    require(['vs/editor/editor.main'], function () {
      // Midnight-black monochrome to match the GARM app, with restrained tints
      // so Python stays readable.
      monaco.editor.defineTheme('garm-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '595962', fontStyle: 'italic' },
          { token: 'keyword', foreground: 'c9c9d2' },
          { token: 'string', foreground: '9ece9e' },
          { token: 'number', foreground: 'd9c79a' },
          { token: 'function', foreground: 'f5f5f7' },
          { token: 'type', foreground: 'e8e8ee' },
          { token: 'delimiter', foreground: '8b8b93' },
        ],
        colors: {
          'editor.background': '#050506',
          'editor.foreground': '#f5f5f7',
          'editorLineNumber.foreground': '#3a3a42',
          'editorLineNumber.activeForeground': '#9a9aa2',
          'editor.lineHighlightBackground': '#ffffff08',
          'editor.selectionBackground': '#ffffff1f',
          'editorCursor.foreground': '#f5f5f7',
          'editorIndentGuide.background1': '#ffffff0d',
          'editorWidget.background': '#0c0c0f',
          'editorWidget.border': '#ffffff14',
          'editorGutter.background': '#050506',
          'input.background': '#08080a',
        },
      });

      editor = monaco.editor.create(document.getElementById('editor'), {
        value: WELCOME,
        language: 'python',
        theme: 'garm-dark',
        automaticLayout: true,
        fontFamily: 'SF Mono, JetBrains Mono, Menlo, monospace',
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'all',
        smoothScrolling: true,
        tabSize: 4,
        padding: { top: 10, bottom: 10 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        // Render the hover / autocomplete in a fixed top-level layer so they are
        // not clipped (or visually overlapped) by the editor's overflow:hidden
        // ancestors.
        fixedOverflowWidgets: true,
        // Disable Monaco's built-in right-click menu: its context-view dismisses on
        // the right-click's own mousedown and on tiny pointer moves, which made it
        // "flicker" open/closed. app.js renders its own stable menu instead.
        contextmenu: false,
      });

      editor.onDidChangeModelContent(function () {
        if (changeCb) changeCb(editor.getValue());
      });

      // "Edit Selection" — surgical, agentic select-and-replace. Available from the
      // right-click menu and via Cmd/Ctrl+K. Opens the inpaint composer in app.js.
      editor.addAction({
        id: 'garm.editSelection',
        label: 'Cicada: Edit Selection…',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
        contextMenuGroupId: 'modification',
        contextMenuOrder: 1,
        run: function () { if (editSelectionCb) editSelectionCb(getSelection()); },
      });

      // "Ask GARM Chat" — opens the context-aware chat. With a selection active it attaches the
      // exact file + line range; otherwise it just opens chat. Right-click menu and Cmd/Ctrl+L.
      editor.addAction({
        id: 'garm.askChat',
        label: 'Ask Cicada Chat…',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.5,
        run: function () { if (askChatCb) askChatCb(getSelection()); },
      });

      ready = true;
      pending.forEach(function (fn) { fn(); });
      pending = [];
    });
  }

  function whenReady(fn) { if (ready) fn(); else pending.push(fn); }

  // The current selection as { text, range, empty }. range is 1-based line/column,
  // matching what src/main/splice.js expects.
  function getSelection() {
    if (!editor) return { text: '', range: null, empty: true };
    var sel = editor.getSelection();
    var model = editor.getModel();
    if (!sel || !model) return { text: '', range: null, empty: true };
    var text = model.getValueInRange(sel);
    return {
      text: text,
      empty: text.length === 0,
      range: {
        startLine: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLine: sel.endLineNumber,
        endColumn: sel.endColumn,
      },
    };
  }

  // Programmatically set the selection (used by the agent UI and verification).
  function setSelection(range) {
    if (!editor || !range) return;
    editor.setSelection(new monaco.Range(range.startLine, range.startColumn || 1, range.endLine, range.endColumn || 1));
    editor.revealLineInCenter(range.startLine);
    editor.focus();
  }

  // Highlight the region being inpainted (whole lines, to mirror the splice).
  function highlightRegion(range) {
    if (!editor || !range) return;
    var endLine = range.endLine;
    if (endLine > range.startLine && range.endColumn === 1) endLine -= 1;
    regionDecorations = editor.deltaDecorations(regionDecorations, [{
      range: new monaco.Range(range.startLine, 1, endLine, 1),
      options: { isWholeLine: true, className: 'inpaint-region', linesDecorationsClassName: 'inpaint-region-gutter' },
    }]);
  }
  function clearRegion() {
    if (editor) regionDecorations = editor.deltaDecorations(regionDecorations, []);
  }

  return {
    init: init,
    whenReady: whenReady,
    getValue: function () { return editor ? editor.getValue() : ''; },
    // Authoritative, non-stream set (opening a file, switching projects). Cancels any
    // in-flight stream tracking so a later finishStreaming() can't clobber this content.
    setValue: function (v) { whenReady(function () { editor.setValue(v == null ? '' : v); streamPrev = ''; streaming = false; }); },
    // Begin a live code stream. Snapshots the current code but does NOT clear the
    // editor — clearing is deferred to the first real delta (streamValue) so the prior
    // code stays visible while the model is still thinking. If a previous stream was
    // left armed without a commit, restore it first.
    beginStream: function () {
      whenReady(function () {
        if (streaming && streamWrote && !streamCommitted) editor.setValue(streamSnapshot);
        streamSnapshot = editor.getValue();
        streaming = true; streamWrote = false; streamCommitted = false; streamPrev = '';
      });
    },
    // Authoritative code for the current stage (post-extraction / each fix). Replaces the
    // streamed text and marks the stream as committed so its content survives finishStreaming.
    commitValue: function (v) {
      whenReady(function () {
        editor.setValue(v == null ? '' : v);
        streamPrev = '';
        if (streaming) streamCommitted = true;
      });
    },
    // End-of-run resolution. If a stream wrote partial code but nothing authoritative
    // was committed (the stage was cut off, errored, or cancelled), roll the editor back
    // to the pre-stream code so the user's program is never left blank or half-written.
    finishStreaming: function () {
      whenReady(function () {
        if (streaming && streamWrote && !streamCommitted) editor.setValue(streamSnapshot);
        streaming = false; streamWrote = false; streamCommitted = false; streamPrev = '';
      });
    },
    // Live-stream partial code. The stream is monotonic (it grows by appending), so we
    // apply only the new tail via executeEdits instead of replacing the whole document
    // every tick — that full-replace was what reset undo/cursor/scroll and caused the
    // visible flicker. Falls back to a replace only if the block is rewritten mid-stream.
    streamValue: function (v) {
      whenReady(function () {
        v = v == null ? '' : v;
        var model = editor.getModel();
        if (!model) return;
        // First real code of this stream: now clear the prior contents and start fresh.
        if (streaming && !streamWrote) { model.setValue(''); streamPrev = ''; streamWrote = true; }
        if (v.length >= streamPrev.length && v.indexOf(streamPrev) === 0) {
          var added = v.slice(streamPrev.length);
          if (added) {
            var last = model.getLineCount();
            var col = model.getLineMaxColumn(last);
            editor.executeEdits('garm-stream', [{
              range: new monaco.Range(last, col, last, col),
              text: added,
              forceMoveMarkers: true,
            }]);
          }
        } else {
          model.setValue(v); // extracted block changed (e.g. a new fence opened)
        }
        streamPrev = v;
        editor.revealLine(model.getLineCount());
      });
    },
    onChange: function (cb) { changeCb = cb; },
    onEditSelection: function (cb) { editSelectionCb = cb; },
    onAskChat: function (cb) { askChatCb = cb; },
    getSelection: getSelection,
    setSelection: setSelection,
    // The editor's root DOM node — the custom context menu binds its `contextmenu`
    // listener here so right-click is handled only inside the code editor.
    getDomNode: function () { return editor ? editor.getDomNode() : null; },
    selectAll: function () {
      if (!editor) return;
      editor.focus();
      var m = editor.getModel(); if (m) editor.setSelection(m.getFullModelRange());
    },
    // Replace the current selection (or insert at the cursor) with `text` as one
    // undo-able edit. Used by the menu's Paste; pass '' from Cut to delete.
    replaceSelection: function (text) {
      if (!editor) return;
      var sel = editor.getSelection(); if (!sel) return;
      editor.focus();
      editor.executeEdits('garm-clip', [{ range: sel, text: text == null ? '' : text, forceMoveMarkers: true }]);
      editor.pushUndoStop();
    },
    highlightRegion: highlightRegion,
    clearRegion: clearRegion,
    layout: function () { if (editor) editor.layout(); },
    focus: function () { if (editor) editor.focus(); },
  };
})();
