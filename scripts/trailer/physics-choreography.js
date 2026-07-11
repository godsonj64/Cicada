'use strict';

// Injected into the running Cicada renderer for the "physics manifold" demo shot: types a
// real physics prompt, runs a REAL DeepSeek repo-mode build, waits for the actual rendered
// 3D surface plot to land in the Render tab, shows the console results, then plays the same
// simulated GitHub publish sequence as the trailer. No kinetic text, no captions — clean
// product footage only. Emits @@BEAT markers the same way choreography.js does.

const physics = require('./physics-beats');

function build() {
  const DATA = JSON.stringify({ prompt: physics.DEMO_PROMPT });

  return '(function(){\n' +
    'var D = ' + DATA + ';\n' +
    'function beat(n){ try { console.error("@@BEAT " + n); } catch(e){} }\n' +
    'function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    'function once(ch, ms){ return new Promise(function(res){ var done=false; var off=null;\n' +
    '  try { off = window.garm.on(ch, function(p){ if(done) return; done=true; if(off) off(); res(p); }); } catch(e){ res({__err:1}); return; }\n' +
    '  if(ms) setTimeout(function(){ if(done) return; done=true; if(off) off(); res({__timeout:1}); }, ms); }); }\n' +
    'function typewriter(el, text, total){ return new Promise(function(resolve){ el.value=""; var i=0;\n' +
    '  var step=Math.max(16, Math.round(total/Math.max(1,text.length)));\n' +
    '  (function t(){ if(i>=text.length){ resolve(); return; } el.value += text[i++]; el.scrollTop=el.scrollHeight; setTimeout(t, step); })(); }); }\n' +
    // Same deterministic "publish" animation as the trailer (visual only — no token/network).
    'function publishAnim(){ return new Promise(function(resolve){\n' +
    '  var body=document.getElementById("gh-body"); if(!body){ resolve(); return; }\n' +
    '  document.getElementById("gh-summary").textContent="Publishing to GitHub…";\n' +
    '  var steps=[["Repository","Initialized git · branch main"],["Required files","README.md · .gitignore · LICENSE · requirements.txt"],["Commit","Initial commit — published from Cicada"],["GitHub repo","Created github.com/you/vibrating-membrane"],["Push","Pushed to github.com/you/vibrating-membrane"]];\n' +
    '  body.innerHTML="<div class=\\"gh-card\\"><div class=\\"gh-card-title\\">Publish to GitHub</div><div id=\\"gh-steps\\" class=\\"gh-steps\\"></div></div>";\n' +
    '  var host=document.getElementById("gh-steps"); var i=0;\n' +
    '  (function nxt(){ if(i>=steps.length){ setTimeout(resolve, 500); return; } var s=steps[i++];\n' +
    '    var row=document.createElement("div"); row.className="gh-step gh-step-running";\n' +
    '    row.innerHTML="<span class=\\"gh-step-ico\\">…</span><span class=\\"gh-step-name\\">"+s[0]+"</span><span class=\\"gh-step-detail\\"></span>";\n' +
    '    host.appendChild(row);\n' +
    '    setTimeout(function(){ row.className="gh-step gh-step-done"; row.querySelector(".gh-step-ico").textContent="\\u2713"; row.querySelector(".gh-step-detail").textContent=s[1]; setTimeout(nxt, 300); }, 420); })(); }); }\n' +
    'function tab(name){ var t=document.querySelector(\'.dock-tab[data-tab="\'+name+\'"]\'); if(t) t.click(); }\n' +
    'function hideOnboarding(){ try{ localStorage.setItem("garm.onboarded","1"); }catch(e){}\n' +
    '  var ov=document.getElementById("onboard-overlay"); if(ov) ov.classList.add("hidden");\n' +
    '  var intro=document.getElementById("onboard-intro"); if(intro){ intro.classList.add("hidden"); } }\n' +
    'async function run(){\n' +
    '  hideOnboarding(); tab("console"); await sleep(300);\n' +
    '  var p=document.getElementById("prompt"); if(p){ p.focus(); }\n' +
    '  beat("type"); if(p) await typewriter(p, D.prompt, 3200); await sleep(500); beat("typeEnd");\n' +
    '  var codeStart=once("pipeline:code-stream-start", 90000);\n' +
    '  var codeEnd=once("pipeline:code-stream-end", 90000);\n' +
    '  var images=once("run:images", 150000);\n' +
    '  var donePromise=once("pipeline:done", 180000);\n' +
    '  var errPromise=once("pipeline:error", 180000);\n' +
    '  var runBtn=document.getElementById("btn-run-pipeline"); if(runBtn) runBtn.click();\n' +
    '  beat("pipeline"); await sleep(2400);\n' +
    '  await codeStart; beat("code"); await sleep(2800);\n' +
    '  await codeEnd; beat("codeEnd");\n' +
    '  var got = await Promise.race([images, Promise.race([donePromise, errPromise]).then(function(){ return {__timeout:1}; })]);\n' +
    '  beat("render"); await sleep(3600); beat("renderEnd");\n' +
    '  await Promise.race([donePromise, errPromise]);\n' +
    '  tab("console"); beat("results"); await sleep(2600); beat("resultsEnd");\n' +
    '  tab("github"); await sleep(400); beat("publish"); await publishAnim(); await sleep(300); beat("publishEnd");\n' +
    '  tab("console"); document.body.classList.add("app-enter"); beat("pullback"); await sleep(2200);\n' +
    '  document.body.classList.remove("app-enter"); beat("end");\n' +
    '}\n' +
    'run().catch(function(e){ try{ console.error("@@BEAT fail " + (e && e.message)); }catch(_){} });\n' +
    '})();\n';
}

module.exports = { build };
