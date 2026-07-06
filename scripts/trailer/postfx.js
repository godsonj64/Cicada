'use strict';

// Post-production: turn the raw screen capture + beat markers into the finished trailer.
// Per shot it applies an extended-ease camera move (zoom in / out / drift + region crop),
// eased captions, then stitches shots with Apple-style cross-dissolve / dip-to-black
// transitions and lays the ElevenLabs voiceover underneath. Stills are exported too.
//
// Two ffmpeg passes: (1) render each shot to a normalized 1080p/30 clip; (2) xfade-concat
// the clips and mux the VO. Pure string-building so `--dry-run` can print every command.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const beats = require('./beats');

const { W, H, FPS, XDUR, FONT } = beats;

// --- per-shot motion → a zoompan expression (extended-ease: many small steps, linear) -----
function motionFilter(shot, frames) {
  if (!shot.motion || shot.motion === 'hold') {
    return null; // kinetic intro/outro is already animated; leave it still
  }
  const f = shot.focus || { z: 1.0, x: 0.5, y: 0.5 };
  const BZ = (f.z || 1.0);
  const CX = f.x == null ? 0.5 : f.x;
  const CY = f.y == null ? 0.5 : f.y;
  let amp = 0, dxN = 0, dyN = 0;
  if (shot.motion === 'pushIn') amp = 0.12;
  else if (shot.motion === 'pullOut') amp = -0.12;
  else if (shot.motion === 'driftUp') { amp = 0.03; dyN = -0.10; }
  else if (shot.motion === 'driftLeft') { amp = 0.03; dxN = -0.10; }
  const fr = Math.max(1, frames);
  // z(on): start-and-approach, stepped so the curve is smooth and continuous.
  let z;
  if (amp >= 0) {
    const step = (amp / fr).toFixed(6);
    z = 'if(eq(on,0)\\,' + BZ.toFixed(4) + '\\,min(zoom+' + step + '\\,' + (BZ + amp).toFixed(4) + '))';
  } else {
    const step = ((-amp) / fr).toFixed(6);
    z = 'if(eq(on,0)\\,' + (BZ - amp).toFixed(4) + '\\,max(zoom-' + step + '\\,' + BZ.toFixed(4) + '))';
  }
  // Centre drifts linearly across the shot; convert normalized centre → pan offset.
  const cx = '(' + CX.toFixed(4) + '+(' + dxN.toFixed(4) + ')*on/' + fr + ')';
  const cy = '(' + CY.toFixed(4) + '+(' + dyN.toFixed(4) + ')*on/' + fr + ')';
  const x = '(iw-iw/zoom)*' + cx;
  const y = '(ih-ih/zoom)*' + cy;
  return "zoompan=z='" + z + "':x='" + x + "':y='" + y + "':d=1:fps=" + FPS + ':s=' + W + 'x' + H;
}

// Caption: thin white type, eased fade + small rise (echoing the onboarding relay).
// Commas inside expressions must be backslash-escaped for the filtergraph parser (quoting
// alone is not enough — the same rule the zoompan expressions follow). Returns null when
// there is no caption text for this shot key, so callers can skip drawtext entirely (a
// caption-free cut, e.g. the physics demo shot, never touches drawtext/fontfile at all —
// no font-path assumptions needed on machines without Segoe UI).
function captionFilter(text, dur) {
  const t = String(text).replace(/[—–]/g, '-').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const esc = (e) => e.replace(/,/g, '\\,');
  const alpha = esc('if(lt(t,0.5),t/0.5,if(gt(t,' + (dur - 0.6).toFixed(2) + '),max(0,(' + dur.toFixed(2) + '-t)/0.6),1))');
  const y = esc('h*0.82-20*min(1,t/0.6)');
  return "drawtext=fontfile='" + FONT + "':text='" + t + "':fontcolor=white:fontsize=52:" +
    "x=(w-tw)/2:y='" + y + "':alpha='" + alpha + "':shadowcolor=black@0.55:shadowx=0:shadowy=2:borderw=0";
}

// The full -vf for one shot. `captions` defaults to beats.CAPTIONS but callers may pass an
// empty map (or any per-cut map) — e.g. the physics demo shot passes {} for a clean,
// text-free cut.
function shotVf(shot, dur, captions) {
  const cap = captions || beats.CAPTIONS;
  const frames = Math.round(dur * FPS);
  const parts = [
    'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease',
    'pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2:color=black',
    'setsar=1',
  ];
  const m = motionFilter(shot, frames);
  if (m) parts.push(m);
  if (shot.caption && cap[shot.caption]) parts.push(captionFilter(cap[shot.caption], dur));
  parts.push('fps=' + FPS, 'format=yuv420p');
  return parts.join(',');
}

function runFfmpeg(ffmpeg, args, dryRun, log) {
  const printable = ffmpeg + ' ' + args.map((a) => (/[\s']/.test(a) ? JSON.stringify(a) : a)).join(' ');
  if (log) log(printable);
  if (dryRun) return { status: 0 };
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error('ffmpeg failed:\n' + (r.stderr || '').split('\n').slice(-12).join('\n'));
  return r;
}

// Per-shot-key duration caps: the live-run and payoff beats carry the story, so they get to
// breathe; kinetic/transitional beats stay tight. Shots not listed fall back to `default`.
const SHOT_CAPS = { pipeline: 12, codeStream: 9, result: 5, render: 8, results: 6, default: 7.5 };

// Resolve each shot's [in,out] window from the beat markers; clamp to sane minimums.
// `shotList` defaults to beats.SHOTS so existing callers (the trailer) are unaffected.
function planShots(beatTimes, shotList) {
  const shots = [];
  for (const s of (shotList || beats.SHOTS)) {
    const inT = beatTimes[s.beat];
    const outT = beatTimes[s.until];
    if (inT == null || outT == null) continue; // beat never fired — skip gracefully
    let dur = Math.max(0.9, outT - inT);
    dur = Math.min(dur, SHOT_CAPS[s.key] == null ? SHOT_CAPS.default : SHOT_CAPS[s.key]);
    shots.push({ shot: s, in: inT, dur });
  }
  return shots;
}

// Cumulative xfade offsets for pairwise chaining.
function xfadeOffsets(durations, xdur) {
  const offs = [];
  let running = durations[0];
  for (let i = 1; i < durations.length; i++) {
    offs.push(running - xdur);
    running = running + durations[i] - xdur;
  }
  return { offs, total: running };
}

const XFADE_TRANSITION = { dissolve: 'fade', dip: 'fadeblack', cut: 'fade' };

// Build & (optionally) run the whole pipeline. opts: { ffmpeg, ffprobe, raw, vo, outDir,
// dryRun, log }. Returns { output, total, stills }.
function run(opts) {
  const log = opts.log || (() => {});
  const dry = !!opts.dryRun;
  const meta = JSON.parse(fs.readFileSync(path.join(opts.outDir, 'meta.json'), 'utf8'));
  const beatTimes = meta.beats || {};
  const shots = planShots(beatTimes, opts.shots);
  if (shots.length < 2) throw new Error('Not enough beat markers were captured to build the cut.');

  const shotsDir = path.join(opts.outDir, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });

  // Align the film length to the voiceover (Apple cut = to the VO). The visible length after
  // crossfades is sum(dur) - XDUR*(n-1); hold the final brand shot to soak up any slack.
  // Match the film to the voiceover (Apple cut = to the VO). Any slack goes into the final
  // brand shot, which holds on a slow continuous push-in (cloned tail + zoompan over the
  // whole thing, so a long hold still drifts — never a frozen logo).
  const target = opts.targetDuration || null;
  let hold = 0;
  if (target) {
    const base = shots.reduce((s, it) => s + it.dur, 0) - XDUR * (shots.length - 1);
    if (target > base) { hold = target - base; shots[shots.length - 1].dur += hold; }
    else if (base - target > 0.4) {
      const last = shots[shots.length - 1];
      last.dur = Math.max(1.4, last.dur - (base - target));
    }
  }

  // Pass 1 — render each shot. Extend by XDUR so neighbours have crossfade overlap material.
  const clipFiles = [];
  shots.forEach((it, i) => {
    const last = i === shots.length - 1;
    const renderDur = it.dur + (last ? 0 : XDUR);
    const out = path.join(shotsDir, 'shot' + String(i).padStart(2, '0') + '.mp4');
    let vf, readDur;
    if (last && hold > 0.05) {
      // Brand hold: read the recorded outro, clone its tail to fill, then a gentle push-in
      // across the ENTIRE (extended) clip so the wordmark keeps breathing.
      readDur = renderDur - hold;
      const frames = Math.round(renderDur * FPS);
      const push = motionFilter({ motion: 'pushIn', focus: { z: 1.0, x: 0.5, y: 0.44 } }, frames);
      vf = [
        'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease',
        'pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2:color=black', 'setsar=1',
        'tpad=stop_mode=clone:stop_duration=' + hold.toFixed(3),
        push, 'fps=' + FPS, 'format=yuv420p',
      ].join(',');
    } else {
      readDur = renderDur;
      vf = shotVf(it.shot, renderDur, opts.captions);
    }
    runFfmpeg(opts.ffmpeg, [
      '-y', '-ss', it.in.toFixed(3), '-t', readDur.toFixed(3), '-i', opts.raw,
      '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out,
    ], dry, log);
    clipFiles.push({ file: out, dur: renderDur, transition: it.shot.transition });
  });

  // Pass 2 — xfade-concat the clips, then mux the voiceover.
  const durations = clipFiles.map((c) => c.dur);
  const { offs, total } = xfadeOffsets(durations, XDUR);
  const inputs = [];
  clipFiles.forEach((c) => { inputs.push('-i', c.file); });
  // Video: chain xfade across the clips → [vout].
  const vParts = [];
  let prev = '[0:v]';
  for (let i = 1; i < clipFiles.length; i++) {
    const trans = XFADE_TRANSITION[clipFiles[i].transition] || 'fade';
    const outLbl = i === clipFiles.length - 1 ? '[vout]' : '[v' + i + ']';
    vParts.push(prev + '[' + i + ':v]xfade=transition=' + trans + ':duration=' + XDUR + ':offset=' + offs[i - 1].toFixed(3) + outLbl);
    prev = outLbl;
  }
  if (clipFiles.length === 1) vParts.push('[0:v]copy[vout]');

  const output = path.join(opts.outDir, 'cicada-trailer.mp4');
  const args = ['-y', ...inputs];
  let voIndex = -1, musIndex = -1;
  if (opts.vo && fs.existsSync(opts.vo)) { args.push('-i', opts.vo); voIndex = clipFiles.length; }
  if (opts.music && fs.existsSync(opts.music)) { args.push('-i', opts.music); musIndex = clipFiles.length + (voIndex >= 0 ? 1 : 0); }

  // Audio: VO on top, keynote bed underneath and side-chain-ducked so the narration stays
  // clear; both fade with the picture.
  const aParts = [];
  let aOut = null;
  const voOut = Math.max(0, total - 1.0).toFixed(2);
  const musOut = Math.max(0, total - 3.0).toFixed(2);
  const musVol = opts.musicVolume == null ? 0.26 : opts.musicVolume;
  if (voIndex >= 0 && musIndex >= 0) {
    aParts.push('[' + voIndex + ':a]afade=t=out:st=' + voOut + ':d=1,asplit=2[vo1][vo2]');
    aParts.push('[' + musIndex + ':a]volume=' + musVol + ',afade=t=in:st=0:d=2.5,afade=t=out:st=' + musOut + ':d=3[mus]');
    aParts.push('[mus][vo1]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350[musd]');
    aParts.push('[vo2][musd]amix=inputs=2:normalize=0,alimiter=limit=0.95[aout]');
    aOut = '[aout]';
  } else if (voIndex >= 0) {
    aParts.push('[' + voIndex + ':a]afade=t=out:st=' + voOut + ':d=1[aout]');
    aOut = '[aout]';
  } else if (musIndex >= 0) {
    aParts.push('[' + musIndex + ':a]volume=' + Math.max(musVol, 0.5) + ',afade=t=in:st=0:d=2.5,afade=t=out:st=' + musOut + ':d=3[aout]');
    aOut = '[aout]';
  }

  const filter = vParts.concat(aParts).join(';');
  args.push('-filter_complex', filter, '-map', '[vout]');
  if (aOut) args.push('-map', aOut, '-shortest');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  if (aOut) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push('-t', total.toFixed(3), output);
  runFfmpeg(opts.ffmpeg, args, dry, log);

  // Stills at each captioned shot's midpoint (the "screenshots" deliverable).
  const stillsDir = path.join(opts.outDir, 'stills');
  fs.mkdirSync(stillsDir, { recursive: true });
  const stills = [];
  let acc = 0;
  shots.forEach((it, i) => {
    const mid = acc + Math.min(it.dur, durations[i]) / 2;
    acc += durations[i] - (i < shots.length - 1 ? XDUR : 0);
    if (!it.shot.caption && it.shot.motion === 'hold') return;
    const png = path.join(stillsDir, 'still' + String(i).padStart(2, '0') + '.png');
    runFfmpeg(opts.ffmpeg, ['-y', '-ss', mid.toFixed(3), '-i', output, '-frames:v', '1', png], dry, log);
    stills.push(png);
  });

  return { output, total, stills, shotCount: clipFiles.length };
}

module.exports = { run, planShots, xfadeOffsets, shotVf, motionFilter, captionFilter };
