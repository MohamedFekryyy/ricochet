# ricochet link bridge (experimental)

Syncs ricochet to Ableton Link on your wifi: tempo, beat and phase come
from the Link session (Ableton Live, an EP-136, or any other Link app),
and every note the instrument plays is quantized onto the shared 16th-note
grid.

> **Status: experimental.** All testing so far is automated and local:
> same-host end-to-end, plus a simulated-delay network test. Not yet
> verified against Ableton Live, on a physical iPhone, or across real
> wifi. Read "Known limitations" before relying on it.

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

The bridge prints an access URL with a fresh random key, like
`http://192.168.1.42:8780/?key=x7Kq...`. Open exactly that URL on the
phone (same wifi), tap power, then tap the **link** key (it only appears
when the app is served by the bridge). The header shows the session tempo
and peer count; the key's LED pulses on the beat.

Enable Link in Ableton Live (the Link toggle in the top-left bar). Tempo
changes in Live land in ricochet; the bounce/grid notes you trigger snap
to the next 16th of the shared grid. Options: `--port`, `--bpm`
(starting tempo before Live joins).

## Safety defaults

- **Per-run access key.** Every page and the websocket endpoint require
  the random key printed at startup; anything without it gets a 404. The
  key changes on every launch, so only someone who sees the bridge's
  terminal output can connect. Treat the printed URL as a secret.
- **Same-origin websockets.** Handshakes whose Origin header points at a
  different host are rejected.
- **Read-only sync.** Clients can follow the session but cannot change
  it; remote tempo commands are ignored unless you start the bridge with
  `--allow-remote-tempo` (which lets any keyed client set the tempo Live
  follows - home wifi only).
- **Staleness watchdog.** If no message arrives for ~1.5 s (Mac sleeps,
  wifi drops), the app shows "link lost", stops quantizing to the stale
  timeline, and falls back to immediate playback; it recovers by itself
  when the connection returns.

## Clock sync

The client pings the bridge once per second; the bridge answers with its
Link beat position and its own millisecond clock. The client keeps the
lowest-RTT samples in a short window and estimates the offset between
the two clocks from them, then reads the shared timeline on the bridge's
clock. This corrects constant network delay but assumes the delay is
roughly symmetric (same lag each way) - the standard assumption for LAN
sync. The bridge also stamps its clock on every state broadcast as a
fallback reference.

## What syncs and what doesn't

- Synced: tempo, beat phase, note timing (quantized to 16ths), peer
  presence, beat indicator.
- Not synced: your sound/scale/parameter choices stay local; physics
  (corners/speed/amount) still shapes rhythm density, Link shapes when
  notes land.

## Known limitations

- **Simulated-network test scope.** Timing verification ran on one
  machine behind a software delay proxy (60 ms added each way): the
  client's beat estimate stayed within ~1 ms of the bridge timeline in
  that setup, and the watchdog flagged a stalled connection. Real wifi
  adds asymmetric delay and jitter this test does not reproduce, so no
  real-world accuracy figure is claimed.
- **Not tested against Ableton Live or on a physical iPhone.** The
  bridge speaks Link through Ableton's official SDK (via aalink), but
  real-session interop is unverified, and mobile Safari's
  playback/scheduling behavior is untested.
- **Anyone with the printed URL can follow the session.** The key gates
  casual access on a home network; it is not authentication against a
  determined attacker on the same LAN. Don't run the bridge on networks
  you don't trust.

## Required before this is ready

1. Cross-device measurement on real wifi (phone + Mac), with observed
   sync error recorded.
2. Interop test with Ableton Live running an actual set.
3. A run on the physical iPhone it will be used on.
