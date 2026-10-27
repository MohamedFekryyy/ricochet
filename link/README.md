# ricochet link bridge

Syncs ricochet to Ableton Link on your wifi: tempo, beat and phase come
from the Link session (Ableton Live, an EP-136, or any other Link app),
and every note the instrument plays is quantized onto the shared 16th-note
grid.

## Why a bridge exists

A browser page cannot join a Link session: Link discovers peers over UDP
multicast, and the web platform has no UDP. This bridge joins the session
for the app and relays the timeline over WebSocket. It also serves the
app itself over plain HTTP, because a hosted https page (GitHub Pages) is
not allowed to open a ws:// connection to a device on your LAN.

## Setup (once, on the Mac that runs Live)

```
pip install -r link/requirements.txt
```

`aalink` ships prebuilt wheels for macOS (Intel and Apple Silicon), so no
compiler is needed.

## Run

From the repo root:

```
node scripts/build.mjs     # only if dist/ricochet.html is missing
python3 link/bridge.py
```

It prints a URL like `http://192.168.1.42:8780`. Open that on the phone
(same wifi), tap power, then tap the **link** key (it only appears when
the app is served by the bridge). The screen caption shows the session
tempo and peer count; the key's LED pulses on the beat.

Enable Link in Ableton Live (the Link toggle in the top-left bar). Tempo
changes in Live land in ricochet within a beat; the bounce/grid notes you
trigger snap to the next 16th of the shared grid. Options: `--port`,
`--bpm` (starting tempo before Live joins).

## What syncs and what doesn't

- Synced: tempo, beat phase, note timing (quantized to 16ths), peer
  presence, beat indicator.
- Not synced: your sound/scale/parameter choices stay local; physics
  (corners/speed/amount) still shapes rhythm density, Link shapes when
  notes land.
