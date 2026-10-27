# ricochet link bridge (experimental)

Syncs ricochet to Ableton Link on your wifi: tempo, beat and phase come
from the Link session (Ableton Live, an EP-136, or any other Link app),
and every note the instrument plays is quantized onto the shared 16th-note
grid.

> **Status: experimental.** Tested only with the bridge and the browser on
> the same machine, and not yet against Ableton Live or a physical iPhone.
> No sync-accuracy claim is made. Read "Known limitations" before relying
> on it.

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

## Known limitations

- **Same-host test scope.** All automated verification ran with the
  bridge and the browser on one machine, where network delay is near
  zero. Timing behavior across real wifi devices is unmeasured; any
  latency/jitter figures discussed anywhere are estimates, not
  measurements.
- **No clock-offset estimation.** The app re-anchors on each 40 ms state
  broadcast and extrapolates between them; it does not estimate one-way
  delay or clock offset, so a constant network lag shifts the quantized
  grid by that lag.
- **No staleness timeout.** If the websocket freezes without a close
  frame (e.g. the Mac sleeps), the app keeps quantizing to a stale
  timeline and the link key can show a falsely-linked state until TCP
  times out.
- **Unauthenticated remote tempo.** The bridge binds all interfaces and
  accepts tempo changes from any connected client, so anyone on the
  network could change the shared session tempo (which Live follows).
  Home wifi only. Read-only sync should be the default before this is
  considered ready.
- **Not tested against Ableton Live or on a physical iPhone.** The
  bridge speaks Link through Ableton's official SDK (via aalink), but
  real-session interop is unverified.

## Required before this is ready

1. Clock offset / RTT estimation (ping-pong), or a measured,
   evidence-backed tolerance.
2. Staleness timeout with a visible disconnect state on the link key.
3. Read-only sync by default; remote tempo control opt-in or removed.
4. Origin/access restriction on the websocket endpoint.
5. Cross-device measurement on real wifi, and an interop test with Live.
