'use strict';

// Pure, deterministic helpers for "inpainting" — replacing a selected region of a
// source file with model-generated code WITHOUT disturbing anything outside the
// region or breaking indentation. These functions have no I/O and no model calls,
// so they are unit-tested in isolation (scripts/inpaint_test.js): they are the part
// that must never introduce a bug.

// Normalise CRLF/CR to LF so line maths is consistent regardless of the model's or
// the editor's newline style.
function normalizeEol(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
}

// Leading-whitespace string of a line (spaces or tabs, as-is).
function leadingWs(line) {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : '';
}

// The smallest leading-whitespace STRING among non-blank lines (preserves the
// file's tab/space style by returning the actual whitespace, not just a count).
function minIndent(lines) {
  let best = null;
  for (const l of lines) {
    if (!l.trim()) continue; // ignore blank lines
    const ws = leadingWs(l);
    if (best === null || ws.length < best.length) best = ws;
  }
  return best === null ? '' : best;
}

// Resolve a Monaco-style selection to an inclusive, 1-based WHOLE-LINE range.
// Operating on whole lines (not arbitrary columns) is what keeps splicing safe:
// we never cut a statement in half. A selection that ends at column 1 of a line
// did not actually include that line, so it is excluded.
function resolveRegion(lineCount, sel) {
  const clamp = (n) => Math.max(1, Math.min(lineCount, Math.floor(n) || 1));
  let startLine = clamp(sel.startLine);
  let endLine = clamp(sel.endLine);
  if (endLine < startLine) { const t = startLine; startLine = endLine; endLine = t; }
  if (endLine > startLine && Number(sel.endColumn) === 1) endLine -= 1;
  return { startLine, endLine };
}

// Re-indent a model-produced snippet so its OWN least-indented line sits at
// `baseIndent`, preserving the snippet's internal relative indentation. This is the
// step that prevents IndentationError when the model returns code dedented to column
// 0 (or over-indented) instead of at the region's nesting level.
function reindent(snippet, baseIndent) {
  let s = normalizeEol(snippet).replace(/^\n+/, '').replace(/[ \t]*\n+$/, '');
  const lines = s.split('\n');
  const base = minIndent(lines);
  const cut = base.length;
  return lines
    .map((l) => (l.trim() ? baseIndent + l.slice(cut) : ''))
    .join('\n');
}

// Splice `snippet` into `code` over the resolved region, returning the full new file.
// Everything outside the region is preserved byte-for-byte (modulo EOL normalisation).
function spliceRegion(code, sel, snippet) {
  const lines = normalizeEol(code).split('\n');
  const { startLine, endLine } = resolveRegion(lines.length, sel);
  const regionLines = lines.slice(startLine - 1, endLine);
  const baseIndent = minIndent(regionLines);
  const newRegion = reindent(snippet, baseIndent).split('\n');
  const out = [...lines.slice(0, startLine - 1), ...newRegion, ...lines.slice(endLine)];
  return out.join('\n');
}

// The exact text of the resolved region (what the user is asking to rewrite), plus
// the 1-based line numbers — used to build the model prompt and the UI label.
function regionText(code, sel) {
  const lines = normalizeEol(code).split('\n');
  const { startLine, endLine } = resolveRegion(lines.length, sel);
  return { startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n') };
}

module.exports = {
  normalizeEol,
  leadingWs,
  minIndent,
  resolveRegion,
  reindent,
  spliceRegion,
  regionText,
};
