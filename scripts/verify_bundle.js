'use strict';

// Post-build guard: every production dependency — and every peer dependency those pull in —
// must actually be inside the packaged app.asar.
//
// This exists because v0.8.0 shipped broken. @langchain/core is a PEER dependency of
// @langchain/langgraph; npm installs peers into node_modules, so development and every test
// worked, but electron-builder bundles from package.json "dependencies" and does not follow
// peerDependencies. The packaged app therefore crashed on startup with
// "Cannot find module '@langchain/core/singletons'" — something no source-level test could
// catch, because the fault only exists in the packaged artifact.
//
//   node scripts/verify_bundle.js [path/to/app.asar]

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const ROOT = path.join(__dirname, '..');
const DEFAULT_ASARS = [
  'release/mac-arm64/Cicada.app/Contents/Resources/app.asar',
  'release/win-unpacked/resources/app.asar',
];

function peersOf(dep) {
  try {
    const pkg = require(path.join(ROOT, 'node_modules', dep, 'package.json'));
    return Object.keys(pkg.peerDependencies || {}).filter((p) => {
      const meta = (pkg.peerDependenciesMeta || {})[p];
      return !(meta && meta.optional);   // optional peers may legitimately be absent
    });
  } catch (_) { return []; }
}

function check(asarPath) {
  const files = asar.listPackage(asarPath);
  const inBundle = (mod) => files.some((f) => f.replace(/\\/g, '/').includes('/node_modules/' + mod + '/'));

  const deps = Object.keys(require(path.join(ROOT, 'package.json')).dependencies || {});
  const required = new Set(deps);
  for (const d of deps) for (const p of peersOf(d)) required.add(p);

  const missing = [...required].filter((m) => !inBundle(m));
  console.log(path.basename(path.dirname(asarPath)) + ': checked ' + required.size + ' module(s)');
  for (const m of [...required].sort()) console.log('  ' + (inBundle(m) ? '✓' : '✗') + ' ' + m);
  if (missing.length) {
    console.error('\nMISSING FROM BUNDLE: ' + missing.join(', '));
    console.error('These resolve in development but not in the packaged app, which will crash on startup.');
    console.error('Add them to "dependencies" in package.json so electron-builder bundles them.');
  }
  return missing.length === 0;
}

const targets = process.argv.slice(2).length ? process.argv.slice(2)
  : DEFAULT_ASARS.map((p) => path.join(ROOT, p)).filter((p) => fs.existsSync(p));

if (!targets.length) {
  console.error('No packaged app.asar found — build first (npm run dist:mac / dist:win).');
  process.exit(1);
}
let ok = true;
for (const t of targets) { ok = check(t) && ok; console.log(''); }
console.log(ok ? '✓ every runtime dependency is present in the bundle' : '✗ bundle is missing runtime dependencies');
process.exit(ok ? 0 : 1);
