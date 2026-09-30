'use strict';

// What the chat model is told about the active project: the system prompt (role + a
// snapshot of the project), history trimming, and editor attachments. Kept free of
// Electron and of the global config so it can be tested against a real project folder.

const fs = require('fs');
const path = require('path');
const projects = require('./projects');
const datasets = require('./datasets');

// Render the project file tree as an indented text outline for the chat context.
function treeOutline(nodes, prefix) {
  let out = '';
  for (const n of nodes || []) {
    out += prefix + (n.type === 'dir' ? '📁 ' : '') + n.name + '\n';
    if (n.type === 'dir' && n.children && n.children.length) out += treeOutline(n.children, prefix + '  ');
  }
  return out;
}

// Gather readable source files under the workspace (skipping binaries / big files / vendored
// dirs), up to a total character budget, so chat has broad project awareness without blowing
// the context window.
function gatherProjectFiles(dir, budget) {
  const SKIP_DIRS = new Set(['__pycache__', '.git', 'node_modules', '.venv', 'venv', 'data', 'dist', 'out']);
  const out = [];
  let used = 0;
  const walk = (abs0, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(abs0, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (used >= budget) return;
      if (e.name.startsWith('.') || e.name.startsWith('_garm_')) continue;
      if (e.isSymbolicLink()) continue;
      const abs = path.join(abs0, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, r); continue; }
      let st; try { st = fs.statSync(abs); } catch (_) { continue; }
      if (st.size > 64 * 1024) continue;
      let buf; try { buf = fs.readFileSync(abs); } catch (_) { continue; }
      if (buf.includes(0)) continue; // binary
      const text = buf.toString('utf8');
      const slice = text.slice(0, Math.max(0, budget - used));
      used += slice.length;
      out.push({ path: r, text: slice, truncated: slice.length < text.length });
    }
  };
  walk(dir, '');
  return out;
}

// The state of a project at a glance, so the model can say "this is a new project" instead
// of improvising: 'empty' (no readable files), 'starter' (only Cicada's untouched starter
// main.py), or 'code'.
function projectState(files) {
  if (!files.length) return 'empty';
  if (files.length === 1 && files[0].path === 'main.py' && files[0].text.trim() === projects.STARTER.trim()) return 'starter';
  return 'code';
}

/**
 * System prompt: the assistant's role + a snapshot of the project it can reason over.
 *
 * The wording is deliberately explicit about WHICH project "this" refers to. With a 3B
 * model, a prompt that opened by describing Cicada made "give me a full overview" describe
 * Cicada itself; and the snapshot alone was not enough for the model to recognise a
 * brand-new project, so it improvised or claimed it had no context.
 *
 *   workspaceDir  the active project folder
 *   budget        characters available for the project snapshot
 *   memory        the project's ContextMemory (optional) — what Cicada built here
 */
function buildChatSystem({ workspaceDir, budget, memory }) {
  const filesBudget = budget || 9000;
  const name = path.basename(workspaceDir);
  const files = gatherProjectFiles(workspaceDir, Math.round(filesBudget * 0.7));
  const state = projectState(files);
  const parts = [
    `You are the coding assistant inside Cicada, a Python IDE. The user is working on their project "${name}"; ` +
    'its files are included below. When the user says "this", "the project", "the code" or asks for an ' +
    `overview, they mean the "${name}" project — describe ITS files and what they do, not Cicada. Answer from ` +
    'the files below (never claim you have no context — the project is right here); if something is not in ' +
    'the project, say so. You also help with general Python, math, algorithms and ideas. Be accurate and ' +
    'concise. Format every reply in Markdown: put code in fenced blocks with a language tag (```python), use ' +
    '`inline code` for identifiers, and write math with $…$ inline or $$…$$ for display. When the user ' +
    'attaches selected lines, focus your answer on them.',
    `\n=== THE USER'S PROJECT: ${name} ===`,
  ];
  const overview = [];
  if (state === 'empty') overview.push('State: this project is EMPTY — it has no code files yet.');
  else if (state === 'starter') {
    overview.push('State: this is a NEW project. Nothing has been built yet: it only contains the starter main.py ' +
      'that Cicada creates, which prints "Hello from Cicada". Suggest describing a program in the Agent panel ' +
      '(Run Pipeline) to build one.');
  } else {
    const py = files.filter((f) => /\.py$/i.test(f.path)).length;
    overview.push(`Contents: ${files.length} file(s), ${py} of them Python${files.some((f) => f.path === 'main.py') ? '; entry point main.py' : ''}.`);
  }
  // What Cicada's agent built here (its project memory), when it has built anything.
  const summary = memory && memory.data && state === 'code' ? memory.data.summary : '';
  if (summary) overview.push('What it was built to do (from the agent\'s project memory): ' + summary);
  const facts = memory && memory.data && Array.isArray(memory.data.facts) ? memory.data.facts.slice(-8) : [];
  if (facts.length) overview.push('Pinned project facts:\n' + facts.map((f) => '- ' + f).join('\n'));
  parts.push(overview.join('\n'));
  try {
    const tree = treeOutline(projects.tree(workspaceDir), '');
    parts.push('\nFile tree:\n' + (tree.length > filesBudget * 0.15 ? tree.slice(0, Math.round(filesBudget * 0.15)) + '…\n' : tree));
  } catch (_) { /* ignore */ }
  if (files.length) {
    parts.push('\nProject files:');
    for (const f of files) parts.push('\n--- ' + f.path + (f.truncated ? ' (truncated)' : '') + ' ---\n' + f.text);
  }
  // Uploaded data files (CSV/Excel/JSON): schemas + load hints, so chat can inspect,
  // summarize, and reason over them and propose programs built on the real data.
  const dataCtx = datasets.formatForPrompt(datasets.list(workspaceDir), Math.min(6000, Math.round(filesBudget * 0.15)));
  if (dataCtx) parts.push('\n' + dataCtx);
  return parts.join('\n');
}

// Keep the most recent turns that fit `budget` characters (always the latest user turn).
function trimHistory(history, budget) {
  const out = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const len = String(history[i].content || '').length;
    if (out.length && used + len > budget) break;
    out.unshift(history[i]);
    used += len;
  }
  return out;
}

// Fold the current editor attachment (active file + selected lines) into the user's question.
function decorateUserMessage(text, context) {
  if (!context) return text;
  const bits = [];
  if (context.file) bits.push('[Active file: ' + context.file + ']');
  const s = context.selection;
  if (s && s.text) {
    const lang = context.language || 'python';
    bits.push('[Selected lines ' + s.startLine + '–' + s.endLine + ' of ' + (context.file || 'the file') +
      ']\n```' + lang + '\n' + s.text + '\n```');
  }
  return bits.length ? bits.join('\n') + '\n\n' + text : text;
}

module.exports = { buildChatSystem, gatherProjectFiles, treeOutline, trimHistory, decorateUserMessage, projectState };
