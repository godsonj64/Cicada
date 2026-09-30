'use strict';

// Thin client over llama-server's OpenAI-compatible /v1/chat/completions endpoint.
// Handles SSE streaming and exposes helpers tailored to a reasoning model that emits
// <think>...</think> blocks before its answer. The tag may arrive fully formed, split into
// a separate reasoning_content field (hosted providers), or with the opening tag supplied
// by the chat template rather than the model — splitThinking handles all three.

// How long a stream may go without receiving a single byte before it is treated as hung.
// Generous on purpose: llama-server sends nothing while it processes a long prompt, and a
// CPU-only build can take minutes over a large one. Without any limit, though, a wedged
// server froze the agent forever.
const STREAM_IDLE_MS = 5 * 60 * 1000;

// The prompt does not fit the model's context window. llama-server reports the exact token
// counts (exceed_context_size_error); hosted providers only say "maximum context length".
// Tagged so callers can trim the prompt and retry instead of failing the whole run.
function contextOverflowError(status, detail, info) {
  const e = new Error(`LLM request failed (${status}): ${detail}`);
  e.status = status;
  e.code = 'context_overflow';
  if (info && Number.isFinite(info.n_prompt_tokens)) e.nPrompt = info.n_prompt_tokens;
  if (info && Number.isFinite(info.n_ctx)) e.nCtx = info.n_ctx;
  return e;
}

function isOverflow(err, detail) {
  return !!((err && err.type === 'exceed_context_size_error') ||
    /exceeds the available context size|maximum context length|context length exceeded|too many tokens/i.test(detail || ''));
}

/**
 * Stream a chat completion. Calls onDelta(textChunk) for each token delta.
 * Returns the full concatenated content. `signal` is an AbortSignal.
 */
async function streamChat(baseUrl, { messages, temperature, topP, maxTokens, signal, onDelta, onMeta, apiKey, model, idleTimeoutMs }) {
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

  // Our own controller, chained to the caller's, so the idle watchdog can abort a stalled
  // request without the caller mistaking it for a user cancel.
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const idleMs = idleTimeoutMs == null ? STREAM_IDLE_MS : idleTimeoutMs;
  let stalled = false;
  let idleTimer = null;
  const touch = () => {
    if (!idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { stalled = true; ctl.abort(); }, idleMs);
  };

  try {
    touch();
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    touch();

    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => '');
      // Surface the provider's own error message (e.g. invalid/expired DeepSeek key) cleanly.
      let detail = txt.slice(0, 300);
      let errObj = null;
      try { const j = JSON.parse(txt); errObj = j.error || null; if (errObj && errObj.message) detail = errObj.message; } catch (_) { /* keep raw */ }
      if (isOverflow(errObj, detail)) throw contextOverflowError(res.status, detail, errObj);
      const e = new Error(`LLM request failed (${res.status}): ${detail}`);
      e.status = res.status;
      throw e;
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
      touch();
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by double newlines; each line starts with "data: ".
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { finish(); return full; }
        let obj;
        try { obj = JSON.parse(payload); } catch (_) { continue; /* partial frame, ignore */ }
        // A server-side failure mid-generation arrives as an error frame; ignoring it left
        // a silently truncated answer that looked complete.
        if (obj && obj.error) {
          const detail = obj.error.message || JSON.stringify(obj.error).slice(0, 300);
          if (isOverflow(obj.error, detail)) throw contextOverflowError(obj.error.code || 500, detail, obj.error);
          const e = new Error('LLM stream error: ' + detail);
          e.transient = true;
          throw e;
        }
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
      }
    }
    // The connection closed without [DONE] or a finish_reason: the server died or dropped
    // us mid-answer. Returning `full` here passed off a truncated answer as complete, so
    // report it as a transient failure and let the caller retry.
    if (!finishReason) {
      const e = new Error('LLM stream terminated before the answer was complete');
      e.transient = true;
      throw e;
    }
    finish();
    return full;
  } catch (err) {
    if (stalled && !(signal && signal.aborted)) {
      const e = new Error(`LLM stream stalled — no data from the model for ${Math.round(idleMs / 1000)}s`);
      e.transient = true;
      throw e;
    }
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---- Resilience ----------------------------------------------------------------
//
// A local llama-server can drop a request transiently (it is restarting after a crash,
// the OS was paging, the port briefly refused) and hosted providers throw 5xx/overloaded.
// None of those should kill a multi-minute pipeline run outright — they are retried a
// couple of times, waiting for the server's /health to come back in between.

// True for errors worth retrying: connection-level failures and server-side (5xx /
// overload) statuses. 4xx (bad key, bad request) and aborts are NOT transient.
function isTransientLlmError(err) {
  if (!err || err.name === 'AbortError') return false;
  if (err.code === 'context_overflow') return false; // retrying the same prompt cannot help
  if (err.transient) return true;
  const msg = String(err.message || '');
  if (/fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|network|terminated|aborted prematurely/i.test(msg)) return true;
  const m = msg.match(/LLM request failed \((\d{3})\)/);
  if (m) { const code = Number(m[1]); return code >= 500 || code === 429; }
  return false;
}

// Poll `baseUrl`/health until it answers OK, the signal aborts, or `timeoutMs` elapses.
// Resolves true when healthy. Used between retries so a llama-server that is reloading
// the model (10–60 s) gets a real chance instead of three instant failures.
async function waitForServer(baseUrl, signal, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 45000);
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return false;
    try {
      const res = await fetch(`${baseUrl}/health`, { method: 'GET', signal });
      if (res.ok) return true;
    } catch (_) { /* still down */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * streamChat with automatic retries on transient failures. Everything in `opts` is
 * passed through; additionally:
 *   retries  — max retry attempts after the first try (default 2)
 *   onRetry(attempt, err) — called before each retry so the caller can reset its
 *                           streaming accumulators (deltas restart from scratch).
 * Hosted providers (apiKey set) skip the health poll and just back off briefly.
 */
async function streamChatResilient(baseUrl, opts) {
  const { retries = 2, onRetry, ...rest } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      // Via module.exports so tests can stub streamChat (see scripts/stop_test.js).
      return await module.exports.streamChat(baseUrl, rest);
    } catch (err) {
      if (attempt >= retries || !isTransientLlmError(err)) throw err;
      if (rest.signal && rest.signal.aborted) throw err;
      if (onRetry) { try { onRetry(attempt + 1, err); } catch (_) { /* ignore */ } }
      if (rest.apiKey) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      else await waitForServer(baseUrl, rest.signal, 45000);
      if (rest.signal && rest.signal.aborted) throw err;
    }
  }
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
  // Only a CLOSING tag: templates for always-reasoning models (LFM2.5, R1-style) put the
  // opening <think> in the PROMPT, so the completion starts already inside the thought and
  // just closes it. Everything up to the tag is thinking — without this the entire chain of
  // thought, closing tag and all, is handed back as the answer. Splits on the last </think>
  // so this agrees with answerStream about where the answer begins.
  if (/<\/think>/i.test(text)) {
    const parts = text.split(/<\/think>/i);
    const answer = parts.pop();
    return { thinking: parts.join('</think>').trim(), answer: answer.trim() };
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

// ---- Fenced-block parsing -----------------------------------------------------
//
// One line-based parser behind every extractor. The old regexes only recognised
// ```python / ```py / ``` openers, so any other info string broke pairing: a reply that
// showed a ```bash install line before the code paired the bash block's CLOSING fence with
// the python block's OPENING one and returned the prose in between ("Then:") as the
// program, and a ```python3 fence wrote the backticks themselves into main.py.

const PY_LANGS = new Set(['', 'python', 'py', 'python3', 'py3', 'ipython']);

// Split text into fenced blocks: [{ info, lang, body, closed, before }]. A fence opens on a
// line starting with ``` plus an optional info string, and closes on a bare ``` line — or
// on ``` glued to the end of the last code line, which small models often emit. `before`
// is the prose between the previous block and this one (where path labels live). An
// unclosed final block (the model was cut off) is returned with closed:false.
function parseFences(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const blocks = [];
  let cur = null;
  let prose = [];
  const open = (info) => {
    cur = { info: info.trim(), lang: (info.trim().split(/\s+/)[0] || '').toLowerCase(), lines: [], closed: false, before: prose.join('\n') };
    prose = [];
  };
  for (let raw of lines) {
    raw = raw.replace(/\r$/, '');
    if (!cur) {
      const m = raw.match(/^\s*`{3,}\s*([^`]*)$/);
      if (m) open(m[1]); else prose.push(raw);
      continue;
    }
    if (/^\s*`{3,}\s*$/.test(raw)) { cur.closed = true; blocks.push(cur); cur = null; continue; }
    // A new ```python opener while a block is still open: the model abandoned the first
    // block (never closed it) and started again. Keep the abandoned one as unclosed.
    const reopen = raw.match(/^\s*`{3,}\s*(python3?|py3?)\s*$/i);
    if (reopen) { blocks.push(cur); open(reopen[1]); continue; }
    const glued = raw.match(/^(.*\S)\s*`{3,}\s*$/);
    if (glued && !/`{3}/.test(glued[1])) { cur.lines.push(glued[1]); cur.closed = true; blocks.push(cur); cur = null; continue; }
    cur.lines.push(raw);
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => ({ info: b.info, lang: b.lang, body: b.lines.join('\n'), closed: b.closed, before: b.before }));
}

// A block that holds Python: an untagged/python fence, or one labelled with a .py path.
function isPythonBlock(b) {
  if (PY_LANGS.has(b.lang)) return true;
  if (/\.pyw?$/i.test(b.lang)) return true;
  return /\bpath=\S+\.py\b/i.test(b.info);
}

// Strip leading blank lines and trailing whitespace, but NOT the first line's indentation:
// an Edit Selection answer for a region inside a function starts indented, and trimming it
// left the first line at column 0 while the rest kept their indent, so re-indenting the
// splice produced an IndentationError on every such edit.
function tidyBody(body) {
  return String(body).replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}

// Does unfenced text read like a Python program rather than prose? The old test accepted
// anything containing "for " or "=", so a chatty reply ("First, for the loop we need a
// counter = 0.") was written to main.py as code.
const CODE_LINE = new RegExp([
  '^\\s*(?:#|@|def |class |import |from \\S+ import |if |elif |else:|for |while |try:|except\\b|finally:|with |return\\b|yield\\b|raise\\b|pass\\b|break\\b|continue\\b|print\\(|assert |async |await |global |nonlocal |del )',
  '^\\s*[A-Za-z_][\\w.]*(?:\\[[^\\]]*\\])?(?:\\s*,\\s*[A-Za-z_][\\w.]*)*\\s*(?:=|\\+=|-=|\\*=|/=)(?!=)',
  '^\\s*[A-Za-z_][\\w.]*\\(.*\\)\\s*$',
  '^\\s+\\S',
  '^\\s*[\\)\\]\\}]',
].join('|'));

function looksLikePython(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (!lines.length || !CODE_LINE.test(lines[0])) return false;
  const code = lines.filter((l) => CODE_LINE.test(l)).length;
  return code / lines.length >= 0.7;
}

/**
 * Extract Python source from a model answer. Prefers the last complete Python fence that
 * actually contains code; treats a placeholder-only or unclosed (truncated) block as "no
 * code" so a stub is never written to disk; otherwise accepts unfenced text only when it
 * genuinely reads as Python.
 */
function extractCode(answer) {
  if (!answer) return '';
  // Never let reasoning leak in as "code". Drop any complete <think>…</think> blocks
  // first, then look for a fenced block.
  const text = answer.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const blocks = parseFences(text);
  if (blocks.length) {
    // Prefer the last closed Python fence with real code. A truncated run can leave a
    // small complete placeholder (`# code`) before the real, unclosed block — never let
    // that win — and a later truncated block must not displace an earlier complete one.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.closed && isPythonBlock(b) && isMeaningfulCode(b.body)) return tidyBody(b.body);
    }
    // Only non-Python blocks, placeholders, or a block cut off mid-program: no code.
    return '';
  }
  // An unclosed <think> with no fenced block means the model ran out of tokens mid-
  // thought and never produced code — returning the raw reasoning here would write a
  // <think> dump to disk (it often mentions `def`/`import`), so treat it as no code.
  if (/<think>/i.test(text)) return '';
  return looksLikePython(text) ? tidyBody(text) : '';
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
  // Only Python blocks count, so an install snippet (```bash) shown before the code is not
  // streamed into the editor. An opener still arriving ("```pyt") parses as a non-Python
  // block and is skipped until its line completes.
  const blocks = parseFences(text).filter((b) => isPythonBlock(b));
  if (!blocks.length) return '';
  const b = blocks[blocks.length - 1];
  // Hide a closing fence that is still arriving ("`", "``") on the last line.
  return b.closed ? b.body : b.body.replace(/\n?[ \t]*`{1,3}$/, (m) => (m.startsWith('\n') ? '\n' : ''));
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
  // Only complete blocks can become files: a truncated trailing file (unclosed fence) is
  // dropped rather than written half-finished.
  const raw = parseFences(text)
    .filter((b) => b.closed)
    .map((b) => ({ path: pathFromInfo(b.info) || labelFromBefore(b.before), body: b.body.replace(/\s+$/, ''), python: isPythonBlock(b) }));
  // A lone unlabeled Python block is the entry point, so repo mode degrades gracefully to a
  // single file — even when the reply also shows, say, an unlabeled ```bash install line.
  const unlabeledPy = raw.filter((b) => !b.path && b.python);
  const loneEntry = !raw.some((b) => b.path) && unlabeledPy.length === 1 ? unlabeledPy[0] : null;
  const out = [];
  const seen = new Map(); // path -> index in out
  for (const blk of raw) {
    let p = blk.path;
    if (!p) { if (blk === loneEntry) p = 'main.py'; else continue; }
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
  streamChat, streamChatResilient, isTransientLlmError, waitForServer,
  splitThinking, extractCode, extractCodeStreaming, answerStream, isMeaningfulCode,
  extractFiles, extractFilesStreaming, pickEntry, looksLikePath, parseFences, looksLikePython,
};
