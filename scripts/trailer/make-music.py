#!/usr/bin/env python3
"""Synthesize an original, royalty-free 'big-event' background bed in the Apple-keynote
vibe: a warm evolving pad, a gentle bell/piano arpeggio, a soft sub pulse, and a shimmer,
over an uplifting I-V-vi-IV progression. No samples, no copyrighted material — pure
additive synthesis. Writes a 16-bit stereo WAV.

    python scripts/trailer/make-music.py --seconds 108 --out scripts/trailer/music.wav
"""

import argparse
import struct
import wave
import numpy as np

SR = 44100


def adsr(n, a, d, s, r, sus):
    """Simple ADSR envelope of length n samples."""
    env = np.zeros(n)
    a, d, r = int(a * SR), int(d * SR), int(r * SR)
    a = max(1, min(a, n))
    d = min(d, max(0, n - a))
    r = min(r, max(0, n - a - d))
    sus_n = max(0, n - a - d - r)
    i = 0
    env[i:i + a] = np.linspace(0, 1, a); i += a
    if d: env[i:i + d] = np.linspace(1, s, d); i += d
    if sus_n: env[i:i + sus_n] = s; i += sus_n
    if r: env[i:i + r] = np.linspace(s, 0, r)
    return env * sus


def note(freq, dur, partials, detune=0.0):
    """Additive tone: a stack of partials with gentle rolloff."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for k, amp in partials:
        f = freq * k * (1.0 + detune)
        y += amp * np.sin(2 * np.pi * f * t)
    return y


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


# Uplifting I–V–vi–IV in C major, voiced warm and open (MIDI note numbers).
PROG = [
    [48, 60, 64, 67, 72],   # C
    [43, 55, 62, 67, 71],   # G
    [45, 57, 64, 69, 72],   # Am
    [41, 53, 60, 65, 69],   # F
]
PAD_PARTIALS = [(1, 0.6), (2, 0.22), (3, 0.12), (4, 0.06), (5, 0.03)]
BELL_PARTIALS = [(1, 0.7), (2, 0.32), (3.01, 0.14), (4.2, 0.06)]


def render(seconds):
    chord_dur = 4.0                       # one chord per bar (~ two-bar feel at 120bpm)
    total = int(seconds * SR)
    left = np.zeros(total + SR)
    right = np.zeros(total + SR)

    n_chords = int(np.ceil(seconds / chord_dur)) + 1
    for ci in range(n_chords):
        chord = PROG[ci % len(PROG)]
        start = int(ci * chord_dur * SR)

        # Warm pad: all chord tones, slow swell, crossfading into the next chord.
        pad_dur = chord_dur + 1.2
        n = int(pad_dur * SR)
        env = adsr(n, a=0.9, d=0.5, s=0.85, r=1.4, sus=0.16)
        for mi in chord:
            f = midi(mi)
            padL = note(f, pad_dur, PAD_PARTIALS, detune=-0.0015) * env
            padR = note(f, pad_dur, PAD_PARTIALS, detune=+0.0015) * env
            _add(left, start, padL); _add(right, start, padR)

        # Sub pulse on the root — a soft heartbeat every two beats.
        root = midi(chord[0] - 12)
        for b in range(2):
            s = start + int(b * (chord_dur / 2) * SR)
            pn = int(0.7 * SR)
            penv = adsr(pn, 0.01, 0.25, 0.0, 0.2, 0.5)
            sub = np.sin(2 * np.pi * root * np.arange(pn) / SR) * penv
            _add(left, s, sub); _add(right, s, sub)

        # Bell/piano arpeggio: rising through the upper chord tones, soft plucks with tails.
        arp_notes = chord[1:] + chord[1:][::-1]
        step = chord_dur / len(arp_notes)
        for i, mi in enumerate(arp_notes):
            s = start + int(i * step * SR)
            bn = int(1.1 * SR)
            benv = adsr(bn, 0.004, 0.9, 0.0, 0.2, 0.12)
            tone = note(midi(mi + 12), 1.1, BELL_PARTIALS) * benv
            pan = 0.5 + 0.35 * np.sin(i * 1.7)   # drift across the stereo field
            _add(left, s, tone * (1 - pan) * 1.4)
            _add(right, s, tone * pan * 1.4)

        # High shimmer that fades in over the piece for the "lift".
        lift = min(1.0, (ci * chord_dur) / max(1.0, seconds))
        if lift > 0.05:
            sh = note(midi(chord[-1] + 24), pad_dur, [(1, 0.15), (2, 0.05)]) * env
            _add(left, start, sh * 0.5 * lift); _add(right, start, sh * 0.5 * lift)

    left = left[:total]; right = right[:total]

    # A short feedback delay (stereo, ping-pong-ish) for air, then a gentle one-pole lowpass.
    left = _delay(left, 0.33, 0.28); right = _delay(right, 0.41, 0.28)
    left = _lowpass(left, 0.28); right = _lowpass(right, 0.28)

    # Master fades + soft normalize.
    fade = int(2.5 * SR)
    for ch in (left, right):
        ch[:fade] *= np.linspace(0, 1, fade)
        ch[-fade:] *= np.linspace(1, 0, fade)
    peak = max(np.max(np.abs(left)), np.max(np.abs(right)), 1e-6)
    g = 0.82 / peak
    left = np.tanh(left * g); right = np.tanh(right * g)   # soft-limit
    return left, right


def _add(buf, start, seg):
    end = min(len(buf), start + len(seg))
    if end > start:
        buf[start:end] += seg[:end - start]


def _delay(x, time_s, fb):
    d = int(time_s * SR)
    y = x.copy()
    if d < len(x):
        for _ in range(3):
            y[d:] += fb * y[:-d]
            fb *= 0.6
    return y


def _lowpass(x, a):
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a * (x[i] - acc)
        y[i] = acc
    return y


def write_wav(path, left, right):
    data = np.empty(len(left) * 2, dtype=np.int16)
    data[0::2] = np.clip(left, -1, 1) * 32767
    data[1::2] = np.clip(right, -1, 1) * 32767
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(struct.pack('<%dh' % len(data), *data.tolist()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seconds', type=float, default=108.0)
    ap.add_argument('--out', default='scripts/trailer/music.wav')
    args = ap.parse_args()
    print('Synthesizing %.0fs of keynote bed…' % args.seconds)
    left, right = render(args.seconds)
    write_wav(args.out, left, right)
    print('Wrote', args.out)


if __name__ == '__main__':
    main()
