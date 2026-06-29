'use strict';

// Thin client over llama-server's OpenAI-compatible /v1/chat/completions endpoint.
// Handles SSE streaming and exposes helpers tailored to a Qwen2-style reasoning
// model that emits <think>...</think> blocks before its answer.

/**
 * Stream a chat completion. Calls onDelta(textChunk) for each token delta.
 * Returns the full concatenated content. `signal` is an AbortSignal.
 */
async function streamChat(baseUrl, { messages, temperature, topP, maxTokens, signal, onDelta, onMeta, apiKey, model }) {
  const headers = { 'Content-Type': 'application/json' };
  // Hosted providers (DeepSeek) need a bearer token + an explicit model id; the local
  // llama-server needs neither (it serves whatever GGUF is loaded).
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const body = {
    messages,
    temperature: temperature ?? 0.3,
    top_p: topP ?? 0.9,
    max_tokens: maxTokens ?? 2048,
    stream: true,
  };
  if (model) body.model = model;

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    // Surface the provider's own error message (e.g. invalid/expired DeepSeek key) cleanly.
    let detail = txt.slice(0, 300);
    try { const j = JSON.parse(txt); if (j.error && j.error.message) detail = j.error.message; } catch (_) { /* keep raw */ }
    throw new Error(`LLM request failed (${res.status}): ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  // Why the response ended: 'stop' (complete) or 'length' (hit the token cap = truncated).
  let finishReason = null;
  // Some providers (DeepSeek) stream chain-of-thought in a SEPARATE `reasoning_content`
  // field instead of inline <think> tags. Re-wrap it as inline <think>…</think> so the rest
  // of GARM (splitThinking / answerStream / extractCode and the live reasoning panel) works
  // identically across providers.
  let thinkOpen = false;
  let thinkClosed = false;
  const finish = () => { if (onMeta) onMeta({ finishReason }); };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by double newlines; each line starts with "data: ".
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { finish(); return full; }
      try {
        const obj = JSON.parse(payload);
        const choice = obj.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const d = choice?.delta || {};
        let chunk = '';
        if (d.reasoning_content) {
          if (!thinkOpen) { chunk += '<think>\n'; thinkOpen = true; }
          chunk += d.reasoning_content;
        }
        if (d.content) {
          if (thinkOpen && !thinkClosed) { chunk += '\n</think>\n\n'; thinkClosed = true; }
          chunk += d.content;
        }
        if (chunk) {
          full += chunk;
          if (onDelta) onDelta(chunk);
        }
      } catch (_) { /* partial frame, ignore */ }
    }
  }
  finish();
  return full;
}

/**
 * Split a model response into { thinking, answer }.
 * Handles both well-formed <think>...</think> and an unclosed leading <think>.
 */
function splitThinking(text) {
  if (!text) return { thinking: '', answer: '' };
  const closed = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (closed) {
    const thinking = closed[1].trim();
    const answer = text.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
    return { thinking, answer };
  }
  // Unclosed <think> (model ran out of tokens mid-thought): treat all after the tag as thinking.
  const open = text.match(/<think>([\s\S]*)$/i);
  if (open) return { thinking: open[1].trim(), answer: '' };
  return { thinking: '', answer: text.trim() };
}

/**
 * True if `src` contains real executable code rather than only comments / blank lines.
 * Truncation can leave a tiny complete placeholder block (e.g. a lone `# code`) ahead of
 * the real, unfinished program — that must not be mistaken for the program.
 */
function isMeaningfulCode(src) {
  if (!src) return false;
  for (const line of src.split('\n')) {
    if (line.replace(/#.*$/, '').trim()) return true;
  }
  return false;
}

/**
 * Extract Python source from a model answer. Prefers the last fenced ```python block that
 * actually contains code; treats a placeholder-only or unclosed (truncated) block as "no
 * code" so a stub is never written to disk; otherwise falls back to raw code-looking text.
 */
function extractCode(answer) {
  if (!answer) return '';
  // Never let reasoning leak in as "code". Drop any complete <think>…</think> blocks
  // first, then look for a fenced block.
  const text = answer.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const fences = [...text.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/gi)];
  if (fences.length) {
    // Prefer the last fence with real code. A truncated run can leave a small complete
    // placeholder (`# code`) before the real, unclosed block — never let that win.
    for (let i = fences.length - 1; i >= 0; i--) {
      const body = fences[i][1].trim();
      if (isMeaningfulCode(body)) return body;
    }
    return '';
  }
  // A fence was opened but never closed → the model was cut off mid-program. Don't write
  // the raw ```python marker to disk as if it were code; report no code so the caller
  // can fail loudly or retry.
  if (/```(?:python|py)?[ \t]*\r?\n/i.test(text)) return '';
  // An unclosed <think> with no fenced block means the model ran out of tokens mid-
  // thought and never produced code — returning the raw reasoning here would write a
  // <think> dump to disk (it often mentions `def`/`import`), so treat it as no code.
  if (/<think>/i.test(text)) return '';
  // No fences and no reasoning: if it parses like code (has def/import/print), use it.
  if (/\b(def |import |print\(|class |for |while |=)/.test(text)) {
    return text.trim();
  }
  return '';
}

/**
 * The answer portion of a streaming response so far, excluding reasoning.
 * Returns '' while the model is still inside an open <think> block, so live code
 * extraction never picks up example fences the model writes while reasoning.
 */
function answerStream(text) {
  if (!text) return '';
  if (/<\/think>/i.test(text)) return text.split(/<\/think>/i).pop();
  if (/<think>/i.test(text)) return '';
  return text;
}

/**
 * Extract the partial code of the LAST fenced block while it is still streaming,
 * even when the closing ``` has not arrived yet. Used to live-stream code into the
 * editor as the model writes it.
 */
function extractCodeStreaming(text) {
  if (!text) return '';
  const re = /```(?:python|py)?[ \t]*\r?\n/gi;
  let lastEnd = -1;
  let m;
  while ((m = re.exec(text)) !== null) lastEnd = re.lastIndex;
  if (lastEnd < 0) return '';
  let rest = text.slice(lastEnd);
  const close = rest.indexOf('```');
  if (close >= 0) rest = rest.slice(0, close);
  return rest;
}

// ---- Multi-file ("repo") extraction ------------------------------------------
//
// In repo mode the model emits SEVERAL files in one answer, each as a fenced block
// labelled with its project-relative path. The label may be a line just before the
// fence (a markdown heading like `### models/net.py`, a `# file: …` comment, or a bare
// path), or carried in the fence info string (```python path=models/net.py). The parser
// below anchors on the fenced blocks (which the single-file extractor already finds
// reliably) and only has to recover the path label sitting next to each one — so a
// truncated trailing file (unclosed fence) is simply dropped, exactly like single-file.

// A safe, project-relative file path: dotted/dashed segments separated by '/', ending in
// a real filename with an extension. No absolute paths, no '..' traversal. Returns the
// cleaned path or null. Tolerates surrounding markdown noise (heading #, bullet, **, `, a
// leading "file:"/"path:" label, a trailing colon).
function looksLikePath(raw) {
  let s = String(raw == null ? '' : raw).trim()
    .replace(/^#{1,6}\s*/, '')                       // markdown heading hashes
    .replace(/^[-*+]\s+/, '')                         // list bullet
    .replace(/\*\*/g, '').replace(/`/g, '')           // bold / inline-code ticks
    .replace(/^(?:file|filename|path|module)\s*[:=]\s*/i, '') // "File: …" label
    .replace(/[\s:]+$/, '')                            // trailing colon / space
    .replace(/^["'<(]+/, '').replace(/["'>)]+$/, '')  // wrapping quotes/brackets
    .replace(/^\.\//, '')                              // leading "./"
    .trim();
  if (!s || s.length > 200) return null;
  if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s)) return null; // absolute (unix / windows)
  if (s.split('/').some((seg) => seg === '..' || seg === '')) return null; // traversal / empty seg
  if (!/^[\w.\-]+(?:\/[\w.\-]+)*\.[A-Za-z0-9_]+$/.test(s)) return null;
  return s;
}

// Recover a path from a fence info string (the text after ```), e.g. "python path=a/b.py"
// or "python a/b.py". The first token is the language and is ignored.
function pathFromInfo(info) {
  const toks = String(info || '').trim().split(/\s+/).filter(Boolean);
  for (const t of toks) {
    const kv = t.match(/^(?:path|file|filename|name)=["']?(.+?)["']?$/i);
    if (kv) { const p = looksLikePath(kv[1]); if (p) return p; }
  }
  for (let i = 1; i < toks.length; i++) { const p = looksLikePath(toks[i]); if (p) return p; }
  return null;
}

// The path label for a block: the nearest non-empty line BEFORE its fence that looks like
// a path (so intervening prose is skipped but a distant unrelated path is not picked up).
function labelFromBefore(before) {
  const lines = String(before || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    return looksLikePath(t); // the closest non-empty line decides (may be null)
  }
  return null;
}

/**
 * Parse a multi-file answer into [{ path, content }]. Drops reasoning, placeholder/empty
 * blocks, and any block that can't be safely placed. A lone unlabeled block is treated as
 * the entry point (main.py) so repo mode degrades gracefully to a single file. Duplicate
 * paths keep the LAST occurrence (mirrors single-file "last fence wins").
 */
function extractFiles(answer) {
  if (!answer) return [];
  const text = String(answer).replace(/<think>[\s\S]*?<\/think>/gi, '');
  const re = /```[ \t]*([^\n`]*)\r?\n([\s\S]*?)```/g;
  const raw = [];
  let m, last = 0;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index);
    last = re.lastIndex;
    raw.push({ path: pathFromInfo(m[1]) || labelFromBefore(before), body: m[2].replace(/\s+$/, '') });
  }
  const out = [];
  const seen = new Map(); // path -> index in out
  for (const blk of raw) {
    let p = blk.path;
    if (!p) { if (raw.length === 1) p = 'main.py'; else continue; }
    let body = blk.body;
    // An empty __init__.py is an intentional package marker — keep it. Any OTHER empty
    // block is truncation/noise, and a placeholder-only Python block (comments only) must
    // never be written as a stub.
    const isInit = /(^|\/)__init__\.py$/i.test(p);
    if (!body.trim()) { if (!isInit) continue; body = ''; }
    else if (/\.py$/i.test(p) && !isInit && !isMeaningfulCode(body)) continue;
    if (seen.has(p)) out[seen.get(p)] = { path: p, content: body };
    else { seen.set(p, out.length); out.push({ path: p, content: body }); }
  }
  return out;
}

/**
 * Choose the file to run for verification: a root main.py, else a file with a
 * `__main__` guard (shallowest wins), else a conventional entry name, else the
 * shallowest Python file. Returns a relative path or null.
 */
function pickEntry(files) {
  if (!files || !files.length) return null;
  const py = files.filter((f) => /\.py$/i.test(f.path));
  const pool = py.length ? py : files;
  const depth = (p) => p.split('/').length;
  const lc = (p) => p.toLowerCase();
  const root = pool.find((f) => lc(f.path) === 'main.py');
  if (root) return root.path;
  const mains = pool
    .filter((f) => /if\s+__name__\s*==\s*['"]__main__['"]/.test(f.content))
    .sort((a, b) => depth(a.path) - depth(b.path));
  if (mains.length) return mains[0].path;
  for (const name of ['app.py', 'run.py', 'cli.py', '__main__.py', 'manage.py']) {
    const f = pool.find((x) => lc(x.path) === name || lc(x.path).endsWith('/' + name));
    if (f) return f.path;
  }
  return pool.slice().sort((a, b) => depth(a.path) - depth(b.path))[0].path;
}

/**
 * A live, append-only preview of a multi-file answer while it streams: each file's code
 * under a `# ===== path =====` banner, with prose and the fence markers themselves
 * stripped. Used to show repo generation flowing into the editor (cosmetic; the real
 * files are written from extractFiles() once the stage completes).
 */
function extractFilesStreaming(text) {
  const ans = answerStream(text);
  if (!ans) return '';
  const out = [];
  let inFence = false;
  for (const line of ans.split('\n')) {
    const fence = line.match(/^[ \t]*```[ \t]*(.*)$/);
    if (fence) {
      if (!inFence) {
        const p = pathFromInfo(fence[1]);
        if (p && out[out.length - 1] !== '# ===== ' + p + ' =====') { if (out.length) out.push(''); out.push('# ===== ' + p + ' ====='); }
        inFence = true;
      } else { inFence = false; }
      continue;
    }
    if (inFence) { out.push(line); continue; }
    const p = looksLikePath(line);
    if (p) { if (out.length) out.push(''); out.push('# ===== ' + p + ' ====='); }
    // non-path prose outside fences is dropped from the preview
  }
  return out.join('\n').replace(/^\n+/, '');
}

module.exports = {
  streamChat, splitThinking, extractCode, extractCodeStreaming, answerStream, isMeaningfulCode,
  extractFiles, extractFilesStreaming, pickEntry, looksLikePath,
};
