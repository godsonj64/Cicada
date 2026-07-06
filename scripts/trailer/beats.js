'use strict';

// Trailer timeline — the single source of truth shared by the choreography (what the app
// does on screen) and postfx (how the footage is cut, moved, and captioned). Timings here
// are the *plan*; the choreography emits @@BEAT markers at real wall-clock moments so
// postfx cuts on what actually happened (a real DeepSeek run has variable length).

// Kinetic INTRO words — rendered through the app's own onboarding "extended-ease" engine
// (same CSS classes: onboard-intro-word / intro-glyph / g-*), so the motion is literally
// the product's. hold = ms before the next word spawns (its exit overlaps the next enter).
const INTRO = [
  { w: 'everyone',   theme: 'light', g: 'g-soft',   hold: 620 },
  { w: 'has',        theme: 'light', g: 'g-soft',   hold: 300 },
  { w: 'an idea',    theme: 'light', g: 'g-bounce', hold: 720 },
  { w: 'almost',     theme: 'dark',  g: 'g-skew',   hold: 380 },
  { w: 'no one',     theme: 'dark',  g: 'g-weight', hold: 420 },
  { w: 'ships it',   theme: 'dark',  g: 'g-bounce', hold: 900 },
];

// Kinetic OUTRO — resolves on the brand beat (rises and settles, no exit).
const OUTRO = [
  { w: 'build',              theme: 'dark', g: 'g-weight', hold: 520 },
  { w: 'what you',           theme: 'dark', g: 'g-soft',   hold: 460 },
  { w: 'imagine',            theme: 'dark', g: 'g-bounce', hold: 900 },
  { w: 'Cicada',             theme: 'dark', g: 'g-reveal', hold: 1600, brand: true },
];

// The REAL prompt typed into the Agent panel and run through DeepSeek v4-flash. Small and
// fast (so v4-flash returns quickly and the code reads well on screen) but structured enough
// to make a real multi-file project in repo mode.
const DEMO_PROMPT =
  'Build a small Python project that computes the first 12 Fibonacci numbers and prints them as a labelled ASCII bar chart.';

// Captions laid over the live product footage (thin type, short, Apple cadence). `at` is the
// beat name they attach to; postfx fades each in/out over that shot with an eased rise.
const CAPTIONS = {
  type:    'Just describe it.',
  pipeline:'It plans. Writes. Reviews. Runs.',
  code:    'Real code — reasoned, not guessed.',
  result:  'Real results.',
  local:   'Runs on your machine.',
  publish: 'Ship it. One click.',
};

// Ordered SHOTS for the final cut. `beat`/`until` name the @@BEAT markers whose real
// timestamps bound the shot in the recording; postfx trims between them. `motion` is the
// extended-ease camera move; `transition` is how we cut INTO this shot.
//   motion: pushIn | pullOut | driftUp | driftLeft | hold
//   focus:  normalized crop centre+scale to frame a region { z, x, y } (1 = full frame)
//   transition: dissolve | dip (dip-to-black, Apple style) | cut
const SHOTS = [
  { key: 'introKinetic', beat: 'intro',    until: 'introEnd', motion: 'hold',     transition: 'cut',      caption: null },
  { key: 'typing',       beat: 'type',     until: 'typeEnd',  motion: 'pushIn',   transition: 'dip',      caption: 'type',    focus: { z: 1.35, x: 0.24, y: 0.42 } },
  { key: 'pipeline',     beat: 'pipeline', until: 'code',     motion: 'driftUp',  transition: 'dissolve', caption: 'pipeline',focus: { z: 1.18, x: 0.16, y: 0.55 } },
  { key: 'codeStream',   beat: 'code',     until: 'codeEnd',  motion: 'pushIn',   transition: 'dissolve', caption: 'code',    focus: { z: 1.30, x: 0.66, y: 0.45 } },
  { key: 'result',       beat: 'result',   until: 'resultEnd',motion: 'pullOut',  transition: 'dissolve', caption: 'result',  focus: { z: 1.40, x: 0.66, y: 0.72 } },
  { key: 'local',        beat: 'local',    until: 'localEnd', motion: 'driftLeft',transition: 'dip',      caption: 'local',   focus: { z: 1.55, x: 0.62, y: 0.06 } },
  { key: 'publish',      beat: 'publish',  until: 'publishEnd',motion: 'pushIn',  transition: 'dissolve', caption: 'publish', focus: { z: 1.28, x: 0.62, y: 0.78 } },
  { key: 'pullback',     beat: 'pullback', until: 'pullEnd',  motion: 'pullOut',  transition: 'dissolve', caption: null,      focus: { z: 1.22, x: 0.5, y: 0.5 } },
  { key: 'outroKinetic', beat: 'outro',    until: 'outroEnd', motion: 'hold',     transition: 'dip',      caption: null },
];

// Cross-dissolve / dip duration between shots (seconds).
const XDUR = 0.5;

// Look. Segoe UI Light gives the thin Apple-keynote type; fall back to Arial.
const FONT = 'C\\:/Windows/Fonts/segoeuil.ttf';
const FONT_BOLD = 'C\\:/Windows/Fonts/segoeui.ttf';

module.exports = {
  INTRO, OUTRO, DEMO_PROMPT, CAPTIONS, SHOTS, XDUR, FONT, FONT_BOLD,
  // Recording canvas (postfx scales the real capture into this).
  W: 1920, H: 1080, FPS: 30,
};
