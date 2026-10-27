# Ricochet

A tiny browser instrument for happy accidents. Two ways to play:

- **Bounce** — balls bounce inside a polygon; every wall hit plays a note.
  More corners = a longer climb up the scale. Controls: corners, speed,
  ball amount, sound, scale.
- **Grid** — a 10x10 field of dots; drag across it to play. Row sets the
  pitch (top is highest). Controls: sensitivity (how far a drag must
  travel before the next note fires) and brush size.

Sounds: bell, marimba, pluck, synth, chiptune. Scales: pentatonic, minor,
phrygian. Everything is synthesized live with Web Audio — there are no
samples, no dependencies, and no build step needed to run it.

## Play it

Open `index.html` in any modern browser (or serve the folder statically).
Tap **power** to start — browsers only allow audio after a gesture.

The interface is styled as a little hardware instrument: a recessed
display on a field-grey body, raised keys, and LCD parameter readouts
(see `docs/research.md` for the design grounding).

For the single-file build (everything inlined into one HTML file you can
send to a phone and open locally):

```
node scripts/build.mjs   # writes dist/ricochet.html
```

## Plug it into a mixer (EP-136)

The app makes sound on the device; the device audio out goes into the
mixer. With a Teenage Engineering EP-136 K.O.–sidekick, the official
guide describes two routes:

- 3.5mm stereo input on the top or bottom edge — the guide explicitly
  lists "audio from your phone" as an intended source.
- USB-C — the EP-136 works as an audio interface over USB-C.

Start with the phone volume moderate; the app runs a conservative master
level (0.6) with a compressor/limiter on the output, plus a mute button
in the top bar. Audio suspends when the tab is hidden.

## Develop

```
node --test test/      # 32 unit tests (physics, notes, engine, grid, audio buffer)
node scripts/build.mjs # bundle to a single HTML file
node scripts/smoke.mjs # headless-Chrome functional test incl. real audio rendering
node scripts/shots.mjs # phone-sized screenshots into docs/screenshots/
```

No npm dependencies; Node 22+ only.

Structure:

- `src/physics.js` — balls inside a regular polygon, wall-hit detection
- `src/notes.js` — scales and frequency mapping
- `src/engine.js` — bounce sequencer state and hit events
- `src/grid.js` — touch-grid cell/brush/gesture gating
- `src/audio.js` — Web Audio voices and the master chain
- `src/main.js` — canvas rendering, controls, input, wiring
- `docs/research.md` — where the design comes from and why it's built this way
