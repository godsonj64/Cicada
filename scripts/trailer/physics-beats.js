'use strict';

// Timeline for the "physics manifold" demo shot: a clean, caption-free capture of Cicada
// building a real multi-file repo from a physics prompt (a vibrating-membrane wave-equation
// eigenmode), rendering the resulting 3D surface plot, and a simulated GitHub publish.
// Shares SHOTS/XDUR/FONT/W/H/FPS conventions with beats.js but no captions are set on any
// shot (postfx only draws text when shot.caption is present), and there is no kinetic
// intro/outro — just the product, doing real work.

const base = require('./beats');

const DEMO_PROMPT =
  'Build a small Python project that models a vibrating rectangular membrane using the ' +
  '2D wave-equation eigenmodes (mode m=3, n=2 on a unit rectangle). Compute the mode shape ' +
  'on a fine grid and render it as a beautiful shaded 3D surface plot with matplotlib ' +
  '(3D projection, viridis colormap, smooth shading, no grid clutter, elevation/azimuth ' +
  'chosen for a striking view) and save the figure as a PNG.';

// No `caption` keys anywhere — this is the "no text over the shot" cut.
const SHOTS = [
  { key: 'typing',    beat: 'type',     until: 'typeEnd',   motion: 'pushIn',    transition: 'cut',      focus: { z: 1.32, x: 0.24, y: 0.40 } },
  { key: 'pipeline',  beat: 'pipeline', until: 'code',      motion: 'driftUp',   transition: 'dissolve', focus: { z: 1.16, x: 0.16, y: 0.55 } },
  { key: 'codeStream',beat: 'code',     until: 'codeEnd',   motion: 'pushIn',    transition: 'dissolve', focus: { z: 1.28, x: 0.64, y: 0.45 } },
  { key: 'render',    beat: 'render',   until: 'renderEnd', motion: 'pushIn',    transition: 'dissolve', focus: { z: 1.0,  x: 0.5,  y: 0.5  } },
  { key: 'results',   beat: 'results',  until: 'resultsEnd',motion: 'driftLeft', transition: 'dissolve', focus: { z: 1.22, x: 0.5,  y: 0.72 } },
  { key: 'publish',   beat: 'publish',  until: 'publishEnd',motion: 'pushIn',    transition: 'dissolve', focus: { z: 1.26, x: 0.62, y: 0.78 } },
  { key: 'pullback',  beat: 'pullback', until: 'end',       motion: 'pullOut',   transition: 'dissolve', focus: { z: 1.2,  x: 0.5,  y: 0.5  } },
];

module.exports = {
  DEMO_PROMPT, SHOTS,
  XDUR: base.XDUR, FONT: base.FONT, FONT_BOLD: base.FONT_BOLD,
  W: base.W, H: base.H, FPS: base.FPS,
  CAPTIONS: {}, // intentionally empty: no drawtext anywhere in this cut
};
