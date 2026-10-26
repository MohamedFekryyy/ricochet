# Research notes

## Origin

Ricochet recreates the interaction concept observed in an Instagram reel
by art director Maryan Ivasyk (@maryan.ivasyk):
https://www.instagram.com/reel/De97c7wN-vj/

The reel shows a small browser-based instrument the creator describes as
"an AI-generated app that makes accidental sounds", played into a Korg
NTS-1 mkII for effects. Observed from the footage:

- a ball bouncing inside a polygon, each wall hit triggering a note
- controls: CORNERS, SPEED, AMOUNT, CELL SIZE, and a sound picker
  (bell, marimba, pluck, synth, chiptune)
- a second screen with a 10x10 touch grid, SENSITIVITY and SIZE controls
- dot-matrix numerals on a dark monochrome UI, page dots between screens

The original implementation is not published. Ricochet is a clean-room
implementation of the observed interactions; no code, assets, or branding
were taken from the creator.

## Design decisions

- **Plain Web Audio, no samples.** The brief: the device sends audio to
  an external mixer, so the app itself is the sound source — but it does
  not need to be a synth with deep sound design. Five compact voice
  recipes (oscillator envelopes + Karplus-Strong for the pluck) cover the
  observed sound picker.
- **Physics as sequencer.** Notes emerge from bounce collisions rather
  than a timeline; corners/speed/amount shape the rhythm.
- **Output safety.** Master gain 0.6 into a compressor (threshold -6 dB,
  ratio 12:1), mute button, voice cap, and a tap-to-start overlay —
  browsers (iOS Safari especially) block audio before a user gesture
  anyway. Audio suspends when the tab is hidden.
- **Single-file distribution.** `scripts/build.mjs` inlines everything
  into `dist/ricochet.html`, matching how the original was shared (one
  self-contained HTML file). The dev version stays modular for tests.

## Hardware grounding

Intended rig: a phone playing into an external mixer, e.g. a Teenage Engineering EP-136 K.O.–sidekick.
From the official hardware overview
(https://teenage.engineering/guides/ep-136/hardware-overview):

- "use the 3.5 mm stereo inputs to connect external instruments such as
  other ep series products, tape recorders or audio from your phone"
- "the usb-c port allows K.O.–sidekick to work as a midi controller,
  an 8 in/4 out audio interface and can also be used to control
  parameters from an external midi device"

So a phone's audio out (3.5mm or USB-C) into the EP-136 is an intended
setup; the app only needs to make sound, not speak MIDI.

## Verification

- 32 Node unit tests cover polygon physics (bounce correctness,
  containment over long fast runs), scale mapping, engine behavior
  (hit events, control clamping, live resize), grid cell/brush/gesture
  logic, and the pluck buffer (determinism, decay, no clipping).
- `scripts/smoke.mjs` loads the built app in headless Chrome and
  self-tests: engine hits, real AudioContext start after gesture, safe
  master level, mute gating, all five voices measured on an analyser
  after the limiter (audible, no clipping), a synthetic pointer drag
  triggering grid notes, and the live bounce loop producing hits.
- `scripts/shots.mjs` captures phone-sized (390x844 @2x) screenshots of
  the start, bounce, and grid screens (in `docs/screenshots/`).

Not verified: playback on physical iOS hardware and the actual EP-136
hookup — tested only in headless Chrome with a measured output signal.
