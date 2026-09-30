'use strict';

// Tests for the streaming client (src/main/llm.js streamChat / streamChatResilient) against
// a local fake OpenAI-compatible server: the failure modes that used to either kill a run
// or silently pass off a broken answer as complete.

const http = require('http');
const llm = require('../src/main/llm');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const frame = (content, finish) => 'data: ' + JSON.stringify({ choices: [{ delta: content ? { content } : {}, finish_reason: finish || null }] }) + '\n\n';
let behaviour = null;
let hits = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  hits += 1;
  behaviour(req, res, hits);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (extra) => llm.streamChat(base, { messages: [{ role: 'user', content: 'hi' }], ...(extra || {}) });

  console.log('normal stream');
  behaviour = (req, res) => { res.write(frame('Hello ')); res.write(frame('world', 'stop')); res.end('data: [DONE]\n\n'); };
  let meta = null;
  ok('a complete stream returns the full text', (await call({ onMeta: (m) => { meta = m; } })) === 'Hello world');
  ok('...with its finish reason', meta && meta.finishReason === 'stop');

  console.log('failures that used to pass as complete');
  behaviour = (req, res) => { res.write(frame('def main(')); res.destroy(); };
  let err = await call().catch((e) => e);
  ok('a connection dropped mid-answer is an error, not a truncated answer', err instanceof Error, String(err));
  ok('...and it is retryable', llm.isTransientLlmError(err), err && err.message);

  behaviour = (req, res) => { res.write(frame('partial')); res.end('data: ' + JSON.stringify({ error: { message: 'slot unavailable' } }) + '\n\n'); };
  err = await call().catch((e) => e);
  ok('a mid-stream error frame is surfaced', err instanceof Error && /slot unavailable/.test(err.message), String(err));

  console.log('context overflow');
  behaviour = (req, res) => {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { code: 400, type: 'exceed_context_size_error', message: 'request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it', n_prompt_tokens: 9000, n_ctx: 8192 } }));
  };
  err = await call().catch((e) => e);
  ok('an oversized prompt is tagged context_overflow', err && err.code === 'context_overflow', err && err.message);
  ok('...with the server\'s exact token counts', err.nPrompt === 9000 && err.nCtx === 8192);
  ok('...and is not blindly retried', !llm.isTransientLlmError(err));
  behaviour = (req, res) => { res.statusCode = 400; res.end(JSON.stringify({ error: { message: "This model's maximum context length is 65536 tokens." } })); };
  err = await call().catch((e) => e);
  ok('a hosted provider\'s wording is recognised too', err && err.code === 'context_overflow', err && err.message);

  console.log('stalls');
  behaviour = (req, res) => { res.write(frame('thinking…')); /* then nothing, forever */ };
  const t0 = Date.now();
  err = await call({ idleTimeoutMs: 400 }).catch((e) => e);
  ok('a stream that goes silent is abandoned instead of hanging forever', err && /stalled/.test(err.message) && Date.now() - t0 < 3000, String(err));
  ok('...and is retryable', llm.isTransientLlmError(err));

  console.log('user cancel');
  behaviour = (req, res) => { res.write(frame('slow')); };
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 150);
  err = await call({ signal: ctl.signal, idleTimeoutMs: 5000 }).catch((e) => e);
  ok('a user cancel is an AbortError, not a stall', err && err.name === 'AbortError', err && (err.name + ': ' + err.message));
  ok('...and is never retried', !llm.isTransientLlmError(err));

  console.log('resilient retry');
  hits = 0;
  behaviour = (req, res, n) => {
    if (n === 1) { res.write(frame('half')); res.destroy(); return; }
    res.write(frame('whole answer', 'stop')); res.end('data: [DONE]\n\n');
  };
  let retried = 0;
  const text = await llm.streamChatResilient(base, { messages: [{ role: 'user', content: 'x' }], onRetry: () => { retried += 1; } });
  ok('a dropped stream is retried and completes', text === 'whole answer' && retried === 1, `text=${text} retried=${retried}`);

  server.close();
  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
