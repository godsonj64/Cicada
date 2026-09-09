'use strict';

// Problem-aware repair memory.
//
// The repair loops were amnesiac: each iteration saw only the current code and the latest
// error, so the model could propose a fix that had just failed, over and over, until the
// iteration budget ran out. This module gives the agent a memory of the problem itself.
//
// Every failure is reduced to a stable SIGNATURE — the exception identity with the volatile
// parts (paths, line numbers, addresses, literals) collapsed — so the same underlying
// problem hashes alike whether it recurs on the next iteration or in a session next week.
// Against each signature we keep the fixes already attempted and what they achieved, and
// render that back into the fix prompt as an explicit "already tried, did not work" list.
//
// Persisted per project in <workspace>/.garm/problems.json, so past issues survive restarts.

const fs = require('fs');
const path = require('path');

const MAX_PROBLEMS = 40;              // distinct signatures retained per project
const MAX_ATTEMPTS = 12;              // attempts retained per problem
const MAX_RENDER_CHARS = 1600;        // ceiling on the block injected into a prompt

// Collapse the parts of an error that vary between runs without changing what is actually
// wrong, so two occurrences of the same fault produce the same signature.
function normalize(s) {
  return String(s == null ? '' : s)
    .replace(/(["'])(?:\\.|(?!\1).)*\1/g, '<v>')      // quoted literals
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.\- ]+){2,}/g, '<path>')
    .replace(/\b0x[0-9a-fA-F]+\b/g, '<addr>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// The line that names the fault. Python puts it last in a traceback, but stderr often has
// trailing noise, so walk backwards for the first "SomeError: detail" shaped line.
function exceptionLine(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^[A-Za-z_][\w.]*(?:Error|Exception|Warning|Interrupt)\b/.test(lines[i])) return lines[i];
  }
  return lines[lines.length - 1] || '';
}

// Reduce a raw failure to { kind, signature, headline }. `kind` steers the repair strategy;
// `signature` is the identity used for repeat detection; `headline` is human-readable.
function classify(kind, text) {
  const raw = String(text == null ? '' : text);

  // A missing import is not a code bug, and the module name IS the identity — so it is
  // matched before normalisation, which would otherwise erase it as a quoted literal.
  const mod = /No module named ['"]([\w.]+)['"]/.exec(raw);
  if (mod) return { kind: 'missing-dep', signature: 'missing-dep:' + mod[1], headline: 'Missing module ' + mod[1] };

  const line = exceptionLine(raw);
  if (!line) {
    const n = normalize(raw);
    return { kind: kind || 'unknown', signature: (kind || 'unknown') + ':' + n.slice(0, 120), headline: n.slice(0, 160) };
  }
  if (/^(?:SyntaxError|IndentationError|TabError)\b/.test(line)) {
    return { kind: 'syntax', signature: 'syntax:' + normalize(line), headline: line.slice(0, 160) };
  }
  const k = kind || 'runtime';
  return { kind: k, signature: k + ':' + normalize(line), headline: line.slice(0, 160) };
}

// A compact, human-readable description of what a fix actually changed, so the ledger can
// say what was tried rather than only that something was tried.
function describeChange(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  if (!a.length || !b.length) return 'rewrote the program';
  const inA = new Set(a.map((l) => l.trim()));
  const inB = new Set(b.map((l) => l.trim()));
  const added = b.map((l) => l.trim()).filter((l) => l && !inA.has(l));
  const removed = a.map((l) => l.trim()).filter((l) => l && !inB.has(l));
  if (!added.length && !removed.length) return 'returned identical code (no change)';
  const bits = [];
  bits.push(`+${added.length}/-${removed.length} lines`);
  const imports = added.filter((l) => /^(?:import|from)\s/.test(l)).slice(0, 2);
  if (imports.length) bits.push('added ' + imports.join('; '));
  const sample = added.find((l) => !/^(?:import|from|#)/.test(l));
  if (sample) bits.push('e.g. ' + (sample.length > 70 ? sample.slice(0, 69) + '…' : sample));
  return bits.join(', ');
}

class ProblemLedger {
  constructor(workspaceDir) {
    this.dir = path.join(workspaceDir, '.garm');
    this.file = path.join(this.dir, 'problems.json');
    this.data = { problems: [], updatedAt: null };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (Array.isArray(parsed.problems)) this.data.problems = parsed.problems.slice(-MAX_PROBLEMS);
        this.data.updatedAt = parsed.updatedAt || null;
      }
    } catch (err) {
      console.error('[ledger] problems.json unreadable, starting fresh:', err.message);
      this.data = { problems: [], updatedAt: null };
    }
    return this.data;
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[ledger] could not write problems.json:', err.message);
    }
    return this.data;
  }

  find(signature) {
    return this.data.problems.find((p) => p.signature === signature) || null;
  }

  // Register an occurrence of a problem, returning its record. `count` is how many times
  // this exact signature has now been seen, across this run and previous ones.
  observe(kind, text) {
    const c = classify(kind, text);
    let p = this.find(c.signature);
    if (!p) {
      p = { signature: c.signature, kind: c.kind, headline: c.headline, count: 0, attempts: [], resolved: false, firstSeen: new Date().toISOString() };
      this.data.problems.push(p);
      if (this.data.problems.length > MAX_PROBLEMS) this.data.problems = this.data.problems.slice(-MAX_PROBLEMS);
    }
    p.count += 1;
    p.headline = c.headline;
    p.resolved = false;
    p.lastSeen = new Date().toISOString();
    this.save();
    return p;
  }

  // Record what a repair attempt did and what it achieved.
  recordAttempt(signature, { action, outcome, phase }) {
    const p = this.find(signature);
    if (!p) return null;
    p.attempts.push({ t: new Date().toISOString(), phase: phase || 'fix', action: action || 'rewrote the program', outcome: outcome || 'unknown' });
    if (p.attempts.length > MAX_ATTEMPTS) p.attempts = p.attempts.slice(-MAX_ATTEMPTS);
    this.save();
    return p;
  }

  markResolved(signature) {
    const p = this.find(signature);
    if (p) { p.resolved = true; p.resolvedAt = new Date().toISOString(); this.save(); }
    return p;
  }

  // The block injected into a repair prompt: what this problem is, how often it has been
  // seen, and every fix already tried for it. This is what stops the model looping on a
  // fix that has already failed.
  render(signature) {
    const p = this.find(signature);
    if (!p) return '';
    const out = [];
    if (p.count > 1) out.push(`This exact failure has now occurred ${p.count} times — earlier repair attempts did NOT resolve it.`);
    if (p.attempts.length) {
      out.push('Fixes already attempted for this exact failure (do NOT repeat them):');
      p.attempts.forEach((a, i) => out.push(`  ${i + 1}. ${a.action} → ${a.outcome}`));
      out.push('Diagnose the ROOT CAUSE and take a different approach from the ones above.');
    }
    if (!out.length) return '';
    let block = 'REPAIR HISTORY FOR THIS PROBLEM:\n' + out.join('\n');
    if (block.length > MAX_RENDER_CHARS) block = block.slice(0, MAX_RENDER_CHARS - 1) + '…';
    return block;
  }

  // Unresolved problems from earlier sessions, so a new run starts aware of them.
  renderKnownIssues(limit) {
    const open = this.data.problems.filter((p) => !p.resolved && p.count > 0).slice(-(limit || 5));
    if (!open.length) return '';
    const lines = open.map((p) => `- [${p.kind}] ${p.headline} (seen ${p.count}×${p.attempts.length ? `, ${p.attempts.length} failed fix attempt(s)` : ''})`);
    return 'KNOWN UNRESOLVED ISSUES IN THIS PROJECT (from earlier runs):\n' + lines.join('\n');
  }

  snapshot() { return JSON.parse(JSON.stringify(this.data)); }

  clear() { this.data = { problems: [], updatedAt: null }; this.save(); return this.data; }
}

module.exports = { ProblemLedger, classify, normalize, exceptionLine, describeChange };
