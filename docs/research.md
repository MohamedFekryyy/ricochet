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
  anyway. Hidden tabs get no rAF, so a timer-driven scheduler steps
  the bounce sim and books notes ahead of the AudioContext clock
  (lookahead clears the ~1/s hidden-timer clamp); the page also sets
  navigator.audioSession.type = 'playback', which recent iOS Safari
  honors for background Web Audio (WebKit bug 261554, fixed 2024-03).
  Real-device background behavior on iOS remains unverified.
- **Single-file distribution.** `scripts/build.mjs` inlines everything
  into `dist/ricochet.html`, matching how the original was shared (one
  self-contained HTML file). The dev version stays modular for tests.

## Industrial design (v2)

The first version looked like a generic dark web demo. The redesign
restyles the app as a self-contained hardware instrument, in the spirit
of Teenage Engineering's pocket devices (EP-133 K.O. II, EP-136) without
copying any product's identity, logo, or layout:

- **Light field-grey body, dark display.** The phone becomes the device:
  a light grey shell with a recessed warm-black screen (the canvas)
  framed by a bezel, instead of a full-bleed dark web page.
- **Printed lowercase labels.** TE panels use lowercase technical
  microcopy ("like most daws...", per teenage.engineering product copy);
  all labels here are lowercase monospace with hairline section rules.
- **Physical keys.** Controls are raised keys (gradient face, hard bottom
  edge, pressed-state travel) instead of flat pills. Active functions
  light a small signal-orange LED on the key.
- **LCD readouts.** Parameter values sit in glowing amber-on-black chips
  flanked by −/+ keys, like the segment displays on the EP series.
- **Numbered function keys.** Voices and scales are numbered 01-05 /
  01-03, the way TE pads double as a number pad (per the official EP-133
  buttons guide).
- **Amber LED matrix on screen.** The bounce polygon, balls, and grid
  dots render in amber/signal-orange on warm black, matching the
  dot-matrix aesthetic of the original reel.

Sources: teenage.engineering EP-133 product page and guide
(https://teenage.engineering/products/ep-133,
https://teenage.engineering/guides/ep-133/buttons-and-combos).

Interaction notes: the canvas is measured from its own box inside the
bezel (not the window), and re-measured when the screen frame is revealed
after the power overlay - a full-window canvas with inline pixel sizing
silently broke both under the new layout.

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

## Ableton Link sync (v3)

Request: a button to sync the instrument to Ableton Link on the same
wifi.

- **A browser cannot join a Link session.** Link discovers peers over
  UDP multicast; the web platform exposes no UDP. Every browser-Link
  project we found uses a local bridge (e.g.
  github.com/vigliensoni/browser-sync-ableton-link,
  github.com/artfwo/aalink-js). Of the five implementations we checked,
  every one wraps Ableton's official C++ SDK; we found none implemented
  in browser-runnable JavaScript. Ableton documents two integration
  routes (iOS LinkKit, cross-platform C++), neither of which runs in a
  web page.
- **The bridge is Python + aalink** (pypi.org/project/aalink): prebuilt
  macOS wheels, no compiler, asyncio-native. Node alternatives
  (node-abletonlink, @ktamas77/abletonlink, aalink-js) all compile C++
  at install time.
- **The bridge also serves the app.** A hosted https page cannot open a
  ws:// connection to a LAN device (mixed content), so the app must be
  loaded from the bridge URL for the link key to appear.
- **Sync semantics:** bounce/grid note triggers are quantized onto the
  Link session's 16th-note grid via scheduled Web Audio times
  (scheduleVoice already supports future times). Physics stays
  free-running; Link owns when notes land. Tempo follows the session;
  the bridge relays state at 25 Hz and the client extrapolates between
  updates.
- Verified end-to-end in `scripts/link-smoke.mjs`: real aalink session,
  live tempo-change propagation, every scheduled note checked against
  the 16th grid, beat indicator, disconnect behavior, access-key gating,
  origin rejection, read-only-by-default remote tempo (opt-in via
  `--allow-remote-tempo`). `scripts/link-net-smoke.mjs` adds a TCP delay
  proxy (60 ms each way) between Chrome and the bridge: the client's
  ping/pong offset estimate (min-RTT window, 1 Hz) tracked the bridge
  timeline within ~1 ms, the 1.5 s staleness watchdog flagged a frozen
  connection with a visible "link lost" state, and the link recovered
  when the network returned. **Scope: one machine with a software delay
  proxy** - real wifi adds asymmetry and jitter this does not reproduce,
  so no real-world sync-accuracy figure is claimed. Interop with
  Ableton Live and behavior on a physical iPhone remain untested; what
  is required before this is ready is listed in `link/README.md`.
