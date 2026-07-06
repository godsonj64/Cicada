'use strict';

// Injected into the running Cicada renderer for the "splash screen" demo shot. Runs almost
// immediately after the window loads (a tiny GARM_AUTORUN_DELAY) so it observes the REAL
// splash sequence from close to its true start: the flower-mark spin-up, its hand-off into
// the assembling workbench (#splash gets '.hide' the same instant body gets '.app-enter'),
// and the calm settle once the entrance cascade finishes. No agent run, no captions.
//
// It also marks the onboarding tour as already-seen (the correct localStorage key the app
// itself uses) BEFORE the splash hands off, so the first-run welcome tour can never pop up
// mid-shot and hijack the capture.

function build() {
  return '(function(){\n' +
    'function beat(n){ try { console.error("@@BEAT " + n); } catch(e){} }\n' +
    'function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    // The app's own onboarding-seen flag (see app.js ONBOARD_SEEN_KEY) — setting it now
    // means maybeShowOnboarding() (fired ~220ms after the splash clears) finds it already
    // seen and never opens the kinetic-intro/tour overlay during our capture.
    'try { localStorage.setItem("cicada.onboarding.seen.v1", "1"); } catch(e){}\n' +
    // Wait for a predicate to become true, polling on rAF (cheap, no MutationObserver setup cost).
    'function waitFor(pred, timeoutMs){ return new Promise(function(resolve){\n' +
    '  var start=Date.now();\n' +
    '  (function tick(){ if(pred()){ resolve(true); return; }\n' +
    '    if(Date.now()-start>timeoutMs){ resolve(false); return; }\n' +
    '    requestAnimationFrame(tick); })(); }); }\n' +
    'async function run(){\n' +
    // Extra guard on top of the main-process show/focus/moveTop sequence: don't mark the
    // start beat until the renderer itself reports focus+visibility, so the recorded video
    // segment we keep never starts on a frame where some other window was still on top.
    '  await waitFor(function(){ return document.hasFocus() && document.visibilityState === "visible"; }, 8000);\n' +
    '  beat("start");\n' +
    // The splash starts hiding (opacity fade) at the exact moment body gets 'app-enter' —
    // that shared instant is the hand-off beat.
    '  await waitFor(function(){\n' +
    '    var s=document.getElementById("splash");\n' +
    '    return (s && s.classList.contains("hide")) || document.body.classList.contains("app-enter");\n' +
    '  }, 15000);\n' +
    '  beat("handoff");\n' +
    // The entrance cascade (topbar/sidebars/editor/dock/stage cards) runs for ~1.2s under
    // app-enter; wait for that class to be removed (app.js clears it itself) as the "settled" beat.
    '  await waitFor(function(){ return !document.body.classList.contains("app-enter"); }, 6000);\n' +
    '  beat("settled");\n' +
    '  await sleep(1100);\n' +
    '  beat("end");\n' +
    '}\n' +
    'run().catch(function(e){ try{ console.error("@@BEAT fail " + (e && e.message)); }catch(_){} });\n' +
    '})();\n';
}

module.exports = { build };
