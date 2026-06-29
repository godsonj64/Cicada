'use strict';

const fs = require('fs');
const path = require('path');

// Real, persistent context memory for the agentic IDE.
//
// Unlike the per-call message arrays (which are stateless), this remembers the
// project ACROSS requests and across app restarts: what the program is, durable
// facts/decisions the user or agent established, and a rolling log of recent
// activity. It is serialised to <workspace>/.garm/memory.json and rendered into a
// compact, token-bounded block that is injected into every agentic prompt so the
// model has genuine continuity instead of starting cold each time.

const MAX_EVENTS = 24;       // rolling activity log cap
const MAX_FACTS = 16;        // durable facts cap
const MAX_RENDER_CHARS = 1800; // hard ceiling on the injected block

function nowIso() { return new Date().toISOString(); }

function oneLine(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

class ContextMemory {
  constructor(workspaceDir) {
    this.dir = path.join(workspaceDir, '.garm');
    this.file = path.join(this.dir, 'memory.json');
    this.data = { summary: '', facts: [], events: [], updatedAt: null };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = {
          summary: typeof parsed.summary === 'string' ? parsed.summary : '',
          facts: Array.isArray(parsed.facts) ? parsed.facts.slice(-MAX_FACTS) : [],
          events: Array.isArray(parsed.events) ? parsed.events.slice(-MAX_EVENTS) : [],
          updatedAt: parsed.updatedAt || null,
        };
      }
    } catch (err) {
      // Corrupt file should never crash the app — start clean but keep the bad file
      // out of the way for debugging.
      console.error('[memory] failed to read memory.json, starting fresh:', err.message);
    }
    return this.data;
  }

  save() {
    this.data.updatedAt = nowIso();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[memory] failed to write memory.json:', err.message);
    }
    return this.data;
  }

  // The one-line description of what the project currently is.
  setSummary(summary) {
    const s = oneLine(summary, 280);
    if (s) { this.data.summary = s; this.save(); }
    return this.data;
  }

  // Append a durable fact/decision, de-duplicated, newest-wins, capped.
  addFact(fact) {
    const f = oneLine(fact, 200);
    if (!f) return this.data;
    const lower = f.toLowerCase();
    this.data.facts = this.data.facts.filter((x) => x.toLowerCase() !== lower);
    this.data.facts.push(f);
    if (this.data.facts.length > MAX_FACTS) this.data.facts = this.data.facts.slice(-MAX_FACTS);
    this.save();
    return this.data;
  }

  removeFact(index) {
    if (index >= 0 && index < this.data.facts.length) {
      this.data.facts.splice(index, 1);
      this.save();
    }
    return this.data;
  }

  // Record a rolling activity event (create / refine / inpaint / run / note).
  record(kind, text) {
    const t = oneLine(text, 220);
    if (!t) return this.data;
    this.data.events.push({ t: nowIso(), kind: String(kind || 'note'), text: t });
    if (this.data.events.length > MAX_EVENTS) this.data.events = this.data.events.slice(-MAX_EVENTS);
    this.save();
    return this.data;
  }

  clear() {
    this.data = { summary: '', facts: [], events: [], updatedAt: null };
    this.save();
    return this.data;
  }

  // Raw state for the UI panel / IPC.
  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }

  isEmpty() {
    return !this.data.summary && !this.data.facts.length && !this.data.events.length;
  }

  // Compact, token-bounded block injected into model prompts. Returns '' when empty
  // so cold starts carry no noise.
  render() {
    if (this.isEmpty()) return '';
    const parts = [];
    if (this.data.summary) parts.push(`Project: ${this.data.summary}`);
    if (this.data.facts.length) {
      parts.push('Established facts / decisions:');
      for (const f of this.data.facts.slice(-MAX_FACTS)) parts.push(`- ${f}`);
    }
    if (this.data.events.length) {
      parts.push('Recent activity (most recent last):');
      for (const e of this.data.events.slice(-8)) parts.push(`- [${e.kind}] ${e.text}`);
    }
    let block = parts.join('\n');
    if (block.length > MAX_RENDER_CHARS) block = block.slice(0, MAX_RENDER_CHARS - 1) + '…';
    return (
      'CONTEXT MEMORY (persists across this project; use it for continuity and do not ' +
      'contradict it — but the user may also start something new):\n' + block
    );
  }
}

module.exports = { ContextMemory };
