'use strict';

// Lightweight syntax check for all source files (no test runner dependency).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const roots = ['src/main', 'src/renderer', 'scripts'];
let failed = 0;

for (const root of roots) {
  const dir = path.join(__dirname, '..', root);
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const full = path.join(dir, file);
    try {
      execSync(`node --check "${full}"`, { stdio: 'pipe' });
      console.log('OK   ' + path.join(root, file));
    } catch (e) {
      failed += 1;
      console.error('FAIL ' + path.join(root, file) + '\n' + (e.stderr || e.message).toString());
    }
  }
}
process.exit(failed ? 1 : 0);
