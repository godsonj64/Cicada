'use strict';

// Builds the JavaScript that is injected into the running Cicada renderer (via
// GARM_AUTORUN=jsfile:...). It drives the REAL app on a timeline and emits `@@BEAT <name>`
// markers on the console — the orchestrator timestamps each marker as it arrives on the
// Electron stdout, so postfx can cut the footage on what actually happened (a live DeepSeek
// run has variable length). The kinetic intro/outro words are spawned through the app's own
// onboarding "extended-ease" engine (identical CSS classes), so that motion is the product's.

const beats = require('./beats');

function build() {
  const DATA = JSON.stringify({ intro: beats.INTRO, outro: beats.OUTRO, prompt: beats.DEMO_PROMPT });

  // NB: the body below runs inside the renderer. No backticks (this is a template literal).
  return '(function(){\n' +
    'var D = ' + DATA + ';\n' +
    'function beat(n){ try { console.error("@@BEAT " + n); } catch(e){} }\n' +
    'function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    'function once(ch, ms){ return new Promise(function(res){ var done=false; var off=null;\n' +
    '  try { off = window.garm.on(ch, function(p){ if(done) return; done=true; if(off) off(); res(p); }); } catch(e){ res({__err:1}); return; }\n' +
    '  if(ms) setTimeout(function(){ if(done) return; done=true; if(off) off(); res({__timeout:1}); }, ms); }); }\n' +
    // Kinetic word engine — mirrors wireOnboarding.introSpawn using the global CSS classes.
    'var EXIT_FRAC=0.62;\n' +
    'function playKinetic(seq){ return new Promise(function(resolve){\n' +
    '  var host=document.getElementById("onboard-intro"), stage=document.getElementById("onboard-intro-stage");\n' +
    '  if(!host||!stage){ resolve(); return; }\n' +
    '  host.classList.remove("hidden","intro-out"); stage.textContent=""; var i=0;\n' +
    '  (function step(){ if(i>=seq.length){ resolve(); return; } var s=seq[i++];\n' +
    '    host.classList.toggle("intro-dark", s.theme==="dark"); host.classList.toggle("intro-light", s.theme!=="dark");\n' +
    '    var life = s.brand ? s.hold : Math.round(s.hold/EXIT_FRAC);\n' +
    '    var word=document.createElement("div");\n' +
    '    word.className="onboard-intro-word "+(s.theme==="dark"?"w-on-dark":"w-on-light")+(s.brand?" is-brand":"");\n' +
    '    word.style.setProperty("--beat", life+"ms");\n' +
    '    var g=document.createElement("span"); g.className="intro-glyph "+s.g; g.textContent=s.w; word.appendChild(g);\n' +
    '    stage.appendChild(word);\n' +
    '    if(!s.brand) word.addEventListener("animationend", function(e){ if(e.target===word) word.remove(); });\n' +
    '    setTimeout(step, s.hold); })(); }); }\n' +
    'function endKinetic(){ var host=document.getElementById("onboard-intro"); if(!host) return;\n' +
    '  host.classList.add("intro-out");\n' +
    '  setTimeout(function(){ host.classList.add("hidden"); host.classList.remove("intro-out","intro-dark","intro-light");\n' +
    '    var st=document.getElementById("onboard-intro-stage"); if(st) st.textContent=""; }, 460); }\n' +
    // Typewriter into a textarea/input over `total` ms.
    'function typewriter(el, text, total){ return new Promise(function(resolve){ el.value=""; var i=0;\n' +
    '  var step=Math.max(16, Math.round(total/Math.max(1,text.length)));\n' +
    '  (function t(){ if(i>=text.length){ resolve(); return; } el.value += text[i++]; el.scrollTop=el.scrollHeight; setTimeout(t, step); })(); }); }\n' +
    // Deterministic "publish" animation into the GitHub pane (visual only — no token/network).
    'function publishAnim(){ return new Promise(function(resolve){\n' +
    '  var body=document.getElementById("gh-body"); if(!body){ resolve(); return; }\n' +
    '  document.getElementById("gh-summary").textContent="Publishing to GitHub…";\n' +
    '  var steps=[["Repository","Initialized git · branch main"],["Required files","README.md · .gitignore · LICENSE · requirements.txt"],["Commit","Initial commit — published from Cicada"],["GitHub repo","Created github.com/you/fibonacci-bars"],["Push","Pushed to github.com/you/fibonacci-bars"]];\n' +
    '  body.innerHTML="<div class=\\"gh-card\\"><div class=\\"gh-card-title\\">Publish to GitHub</div><div id=\\"gh-steps\\" class=\\"gh-steps\\"></div></div>";\n' +
    '  var host=document.getElementById("gh-steps"); var i=0;\n' +
    '  (function nxt(){ if(i>=steps.length){ setTimeout(resolve, 400); return; } var s=steps[i++];\n' +
    '    var row=document.createElement("div"); row.className="gh-step gh-step-running";\n' +
    '    row.innerHTML="<span class=\\"gh-step-ico\\">…</span><span class=\\"gh-step-name\\">"+s[0]+"</span><span class=\\"gh-step-detail\\"></span>";\n' +
    '    host.appendChild(row);\n' +
    '    setTimeout(function(){ row.className="gh-step gh-step-done"; row.querySelector(".gh-step-ico").textContent="\\u2713"; row.querySelector(".gh-step-detail").textContent=s[1]; setTimeout(nxt, 260); }, 360); })(); }); }\n' +
    'function tab(name){ var t=document.querySelector(\'.dock-tab[data-tab="\'+name+\'"]\'); if(t) t.click(); }\n' +
    'function hideOnboarding(){ try{ localStorage.setItem("garm.onboarded","1"); }catch(e){}\n' +
    '  var ov=document.getElementById("onboard-overlay"); if(ov) ov.classList.add("hidden");\n' +
    '  var intro=document.getElementById("onboard-intro"); if(intro){ intro.classList.add("hidden"); } }\n' +
    // --- main timeline ---
    'async function run(){\n' +
    '  hideOnboarding(); await sleep(250);\n' +
    '  beat("intro"); await playKinetic(D.intro); await sleep(150); endKinetic(); await sleep(560); beat("introEnd");\n' +
    '  tab("console");\n' +
    '  var p=document.getElementById("prompt"); if(p){ p.focus(); }\n' +
    '  beat("type"); if(p) await typewriter(p, D.prompt, 2600); await sleep(500); beat("typeEnd");\n' +
    '  var codeStart=once("pipeline:code-stream-start", 90000);\n' +
    '  var codeEnd=once("pipeline:code-stream-end", 90000);\n' +
    '  var runStart=once("run:started", 100000);\n' +
    '  var donePromise=once("pipeline:done", 130000);\n' +
    '  var errPromise=once("pipeline:error", 130000);\n' +
    '  var runBtn=document.getElementById("btn-run-pipeline"); if(runBtn) runBtn.click();\n' +
    '  beat("pipeline"); await sleep(2600);\n' +
    '  await codeStart; beat("code"); await sleep(2600);\n' +
    '  await codeEnd; beat("codeEnd");\n' +
    '  await runStart; await sleep(700); beat("result");\n' +
    '  await Promise.race([donePromise, errPromise]); await sleep(700); beat("resultEnd");\n' +
    '  beat("local"); await sleep(1900); beat("localEnd");\n' +
    '  tab("github"); await sleep(450); beat("publish"); await publishAnim(); await sleep(300); beat("publishEnd");\n' +
    '  tab("console"); document.body.classList.add("app-enter"); beat("pullback"); await sleep(1900); document.body.classList.remove("app-enter"); beat("pullEnd");\n' +
    '  beat("outro"); await playKinetic(D.outro); await sleep(500); beat("outroEnd"); await sleep(300); beat("end");\n' +
    '}\n' +
    'run().catch(function(e){ try{ console.error("@@BEAT fail " + (e && e.message)); }catch(_){} });\n' +
    '})();\n';
}

module.exports = { build };
