'use strict';

// Timeline for the "splash screen" demo shot: the app's real boot sequence — the flower-mark
// spin-up (extended-ease flywheel), its hand-off into the assembling workbench (the app-enter
// cascade), and a calm settle. No agent run, no GitHub, no captions — just the product's own
// launch choreography, screen-recorded and given cinematic camera moves in post.

const base = require('./beats');

// No `caption` keys — a clean, text-free cut.
const SHOTS = [
  { key: 'splash', beat: 'start',  until: 'handoff', motion: 'pushIn',  transition: 'cut',      focus: { z: 1.18, x: 0.5, y: 0.40 } },
  { key: 'reveal',  beat: 'handoff', until: 'settled', motion: 'pullOut', transition: 'dissolve', focus: { z: 1.14, x: 0.5, y: 0.5  } },
  { key: 'hold',    beat: 'settled', until: 'end',      motion: 'pushIn',  transition: 'dissolve', focus: { z: 1.0,  x: 0.5, y: 0.5  } },
];

module.exports = {
  SHOTS,
  XDUR: base.XDUR, FONT: base.FONT, FONT_BOLD: base.FONT_BOLD,
  W: base.W, H: base.H, FPS: base.FPS,
  CAPTIONS: {}, // intentionally empty: no drawtext anywhere in this cut
};
