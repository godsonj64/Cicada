'use strict';

// electron-builder afterPack hook — ad-hoc code signing for the macOS build.
//
// Without a "Developer ID Application" certificate electron-builder skips signing, which
// leaves the packaged app carrying Electron's own linker-signed signature even though the
// bundle contents have changed. The signature no longer matches, so macOS reports the app
// as damaged instead of launching it. Re-signing ad-hoc (`--sign -`) reseals the bundle:
// the app runs on the machine that built it and on any Mac once the quarantine attribute
// is cleared. A real identity, when one is available, is left untouched.
//
// Runs before the DMG/zip are assembled, so the artifacts carry the fixed signature.

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execFileSync('codesign', ['--verify', '--deep', app], { stdio: 'pipe' });
    console.log('[after-pack] already validly signed, leaving as is');
    return;
  } catch {
    // Unsigned or stale signature — fall through and ad-hoc sign.
  }

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' });
  console.log('[after-pack] ad-hoc signed ' + path.basename(app));
};
