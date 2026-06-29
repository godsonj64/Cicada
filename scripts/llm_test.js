'use strict';

// Model-free tests for the response parsing in src/main/llm.js — especially the
// guard that prevents <think> reasoning from leaking into the file when the model
// runs out of tokens mid-thought (the failure the stress battery surfaced).

const { splitThinking, extractCode, extractCodeStreaming, answerStream, isMeaningfulCode } = require('../src/main/llm');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

console.log('extractCode — fenced blocks');
ok('extracts a python fence', extractCode('```python\nprint(1)\n```') === 'print(1)');
ok('prefers the last fence', extractCode('```python\nold()\n```\ntext\n```python\nnew()\n```') === 'new()');
ok('strips a leading think block then extracts the fence',
  extractCode('<think>I will write code that uses def and import</think>\n```python\nx = 1\n```') === 'x = 1');

console.log('extractCode — the think-leak guard (regression for stress scenario 1)');
// Unclosed <think> that ran out of tokens, mentions def/import, has NO code fence.
const leak = '<think>The signature is def bar(x, height). I should import matplotlib and';
ok('unclosed reasoning with no fence is NOT treated as code', extractCode(leak) === '');
ok('a full think block with no fence yields no code', extractCode('<think>def foo(): import x</think>') === '');
ok('plain code without fences still works', extractCode('def f():\n    return 1') === 'def f():\n    return 1');
ok('empty input is safe', extractCode('') === '');

console.log('extractCode — truncation / placeholder guards (regression for the `# code` stub bug)');
// The reasoning model spent its whole token budget thinking, then emitted only a stub
// fence (or an unclosed real block). None of these may pass as the program.
ok('rejects a comment-only placeholder block', extractCode('```python\n# code\n```') === '');
ok('whitespace-only fence yields no code', extractCode('```python\n   \n```') === '');
ok('skips the placeholder, takes the real block',
  extractCode('```python\n# code\n```\n```python\nprint(2)\n```') === 'print(2)');
ok('placeholder + truncated (unclosed) real block yields no code',
  extractCode('```python\n# code\n```\n```python\nimport torch\nx = 1') === '');
ok('a lone unclosed fence (truncated mid-program) yields no code',
  extractCode('```python\nimport torch\nx = 1') === '');
ok('isMeaningfulCode: comment-only is not code', isMeaningfulCode('# code\n  # more') === false);
ok('isMeaningfulCode: a real statement is code', isMeaningfulCode('# c\nx = 1') === true);

console.log('splitThinking');
const st = splitThinking('<think>reasoning here</think>\nfinal answer');
ok('separates closed think from answer', st.thinking === 'reasoning here' && st.answer === 'final answer');
ok('unclosed think -> all thinking, empty answer', splitThinking('<think>still going').answer === '');

console.log('answerStream / extractCodeStreaming');
ok('answerStream hides text inside an open think', answerStream('<think>writing ```python\nfake\n```') === '');
ok('answerStream returns post-think text', answerStream('<think>done</think>\nhello') === '\nhello');
ok('streaming extracts an unterminated fence', extractCodeStreaming('```python\nprint(1)\nprint(2)') === 'print(1)\nprint(2)');
ok('streaming fence partial keeps the trailing newline', extractCodeStreaming('intro\n```python\na = 1\n') === 'a = 1\n');

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
