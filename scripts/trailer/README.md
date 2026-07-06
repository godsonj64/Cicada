# Cicada Trailer Toolkit

Automates a 30-second, Apple-keynote-style trailer from the **real** app: it screen-records
Cicada driving itself through a live DeepSeek run, then applies extended-ease camera moves,
crop framing, cross-dissolve / dip-to-black transitions, eased captions, and your voiceover.

## Run it

```bash
node scripts/trailer/make-trailer.js --vo "path/to/voiceover.mp3" --key sk-...
```

Output lands in `scripts/trailer/out/`:
- `cicada-trailer.mp4` — the finished film (1920×1080 · 30 fps · cut to the VO length)
- `stills/` — poster-frame screenshots at each captioned beat
- `raw.mkv` — the raw screen capture
- `meta.json` — the captured beat timeline

### Music
An original, royalty-free "big-event" bed (warm pad + bell arpeggio + sub pulse over an
uplifting I–V–vi–IV progression) is synthesized by `make-music.py` — no copyrighted Apple
audio is used. It is mixed **under** the voiceover with side-chain ducking (the bed dips
whenever the narration speaks) and fades with the picture.

```bash
python scripts/trailer/make-music.py --seconds 108 --out scripts/trailer/music.wav
```

`make-trailer.js` picks up `scripts/trailer/music.wav` automatically. Control it with
`--music <file>`, `--music-volume 0.26`, or `--no-music`.

### Flags
- `--vo <mp3>` voiceover to score the cut (default: the ElevenLabs file in Downloads).
- `--music <wav/mp3>` background bed (default: `scripts/trailer/music.wav` if present); `--no-music` to disable; `--music-volume <0..1>`.
- `--key <sk-...>` DeepSeek key for the live run (or set `DEEPSEEK_API_KEY`, or configure once in-app).
- `--model <name>` DeepSeek model (default `deepseek-v4-flash`).
- `--dry-run` print every ffmpeg command without rendering.
- `--no-record` skip capture and re-run only postfx on an existing `out/raw.mkv` + `meta.json` (fast FX iteration).
- `--keep` keep the temp choreography file.

## How it works

| File | Role |
| --- | --- |
| `trailer-script.md` | the creative — shot list, captions, VO, timing |
| `beats.js` | shared timeline: kinetic words, demo prompt, captions, shot motions/transitions |
| `choreography.js` | injected into the live app; plays the kinetic intro/outro through the app's **own** onboarding engine, runs a real DeepSeek pipeline, animates publish, and emits `@@BEAT` markers |
| `recorder.js` | auto-downloads ffmpeg (Windows), records the window with gdigrab, probes VO duration |
| `postfx.js` | cuts shots on the beat markers, applies zoom-in/out + drift + crop, xfade transitions, captions, and muxes the VO |
| `make-trailer.js` | orchestrator: sets DeepSeek, launches + records + drives the app, then runs postfx |

The intro/outro type is not faked — it is rendered by Cicada's real `intro-rise` "extended-ease"
animation (the same one the onboarding tour uses), captured live. The middle is a genuine agent
run streaming real code from DeepSeek v4-flash. Camera moves and transitions are added in post.

## Requirements
- Windows (auto-downloads ffmpeg). On macOS/Linux install ffmpeg first (`brew install ffmpeg`).
- A DeepSeek API key with access to the demo model.
- The app builds/runs from this repo (`npm install` already done).

> The recording captures whatever window is titled **Cicada**, so leave it in the foreground
> and unobstructed while the ~40s capture runs.
