// Ableton Link sync client.
// Browsers cannot join a Link session directly (Link needs UDP multicast
// on the LAN; the web platform has no UDP), so ricochet talks to the
// companion bridge (link/bridge.py) over WebSocket. The bridge joins the
// session and relays tempo/beat/phase; this module follows that timeline
// and quantizes note triggering onto its beat grid.

export const GRID_SUBDIVISION = 0.25; // 16th notes in 4/4

// Smallest grid multiple at or after `beat` (a hit exactly on the grid
// plays immediately).
export function nextGridBeat(beat, sub = GRID_SUBDIVISION) {
  return Math.ceil(beat / sub - 1e-9) * sub + 0; // + 0 normalizes -0
}

export class LinkSync {
  constructor({ onState, onStatus } = {}) {
    this.onState = onState || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.state = null; // last { bpm, beat, phase, quantum, peers, playing }
    this.recvPerf = 0; // performance.now() when that state arrived
    this.isOn = false;
  }

  connect(url) {
    this.disconnect();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.isOn = true;
      this.onStatus('on');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t !== 'state') return;
      this.state = msg;
      this.recvPerf = performance.now();
      this.onState(msg);
    };
    ws.onclose = () => {
      this.isOn = false;
      this.state = null;
      this.onStatus('off');
    };
    ws.onerror = () => ws.close();
  }

  disconnect() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.isOn = false;
    this.state = null;
  }

  get bpm() {
    return this.state ? this.state.bpm : 0;
  }

  // Continuous Link beat position right now, extrapolated from the last
  // broadcast (40ms cadence; LAN jitter is the error, a few ms).
  currentBeat(perfNow = performance.now()) {
    if (!this.state) return 0;
    const elapsedBeats = ((perfNow - this.recvPerf) / 1000) * (this.state.bpm / 60);
    return this.state.beat + elapsedBeats;
  }

  // AudioContext time of the next 16th-note boundary. Assumes tempo is
  // constant over the sub-second horizon, which holds in practice.
  quantizedTime(ctx, perfNow = performance.now()) {
    const beat = this.currentBeat(perfNow);
    const gridBeat = nextGridBeat(beat);
    const dtBeats = gridBeat - beat;
    return {
      when: ctx.currentTime + (dtBeats * 60) / this.state.bpm,
      beat,
      gridBeat,
    };
  }
}

// The bridge exposes /link-info on the same origin it serves the app
// from; the hosted Pages copy has no such endpoint, so the link key
// only appears when the app is actually reachable through a bridge.
export async function probeBridge(timeoutMs = 900) {
  try {
    const res = await fetch('/link-info', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
