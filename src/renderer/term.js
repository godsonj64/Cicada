// xterm.js front-end for the integrated terminal, exposed as window.GARMTerm.
// Line-based: Enter submits a command (or feeds stdin while a process runs),
// Ctrl+C interrupts, Backspace edits the current line.
window.GARMTerm = (function () {
  var term = null;
  var fit = null;
  var line = '';
  var running = false;
  var cwd = '~';
  var history = [];
  var histIdx = -1;

  function prompt() {
    term.write('\r\n\x1b[38;2;153;153;158m' + shortCwd() + '\x1b[0m \x1b[38;2;245;245;247m$\x1b[0m ');
  }
  function shortCwd() {
    var home = '';
    return cwd.replace(/^\/Users\/[^/]+/, '~');
  }

  function init() {
    term = new Terminal({
      fontFamily: 'SF Mono, JetBrains Mono, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: '#050506',
        foreground: '#f5f5f7',
        cursor: '#f5f5f7',
        selectionBackground: 'rgba(255,255,255,0.18)',
        black: '#050506', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
        blue: '#93a0c8', magenta: '#c9c9d2', cyan: '#9ece9e', white: '#f5f5f7',
        brightBlack: '#5a5a62', brightWhite: '#ffffff',
      },
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('terminal'));
    safeFit();

    term.writeln('\x1b[38;2;130;130;138mCicada integrated terminal — runs in your workspace.\x1b[0m');
    prompt();

    term.onData(onData);

    // Stream backend output.
    window.garm.on('terminal:data', function (p) { term.write(p.text.replace(/\n/g, '\r\n')); });
    window.garm.on('terminal:exit', function (p) {
      running = false;
      if (p.cwd) cwd = p.cwd;
      prompt();
    });

    window.garm.terminal.cwd().then(function (c) { if (c) cwd = c; });
  }

  function onData(data) {
    var code = data.charCodeAt(0);
    if (data === '\r') { // Enter
      term.write('\r\n');
      var cmd = line; line = ''; histIdx = -1;
      if (running) {
        window.garm.terminal.input(cmd + '\n');
      } else if (cmd.trim()) {
        history.push(cmd);
        running = true;
        window.garm.terminal.exec(cmd);
      } else {
        prompt();
      }
    } else if (data === '\x7f') { // Backspace
      if (line.length > 0) { line = line.slice(0, -1); term.write('\b \b'); }
    } else if (data === '\x03') { // Ctrl+C
      if (running) { window.garm.terminal.interrupt(); }
      else { term.write('^C'); line = ''; prompt(); }
    } else if (data === '\x1b[A') { // Up — history
      if (history.length) { histIdx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1); replaceLine(history[histIdx]); }
    } else if (data === '\x1b[B') { // Down — history
      if (histIdx >= 0) { histIdx++; if (histIdx >= history.length) { histIdx = -1; replaceLine(''); } else replaceLine(history[histIdx]); }
    } else if (code >= 32) { // printable
      line += data; term.write(data);
    }
  }

  function replaceLine(text) {
    while (line.length) { term.write('\b \b'); line = line.slice(0, -1); }
    line = text || '';
    term.write(line);
  }

  function safeFit() { try { fit.fit(); } catch (e) { /* not visible yet */ } }

  return {
    init: init,
    fit: safeFit,
    runCommand: function (cmd) {
      if (running) return;
      replaceLine(cmd);
      onData('\r');
    },
  };
})();
