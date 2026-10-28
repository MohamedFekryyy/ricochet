// Ableton Link sync client.
// Browsers cannot use Ableton's documented Link integration routes
// (iOS LinkKit / C++ SDK), so ricochet talks to the companion bridge
// (link/bridge.py) over WebSocket. The bridge joins the session and
// relays tempo/beat/phase; this module estimates network delay with
// ping/pong, follows the corrected timeline, and quantizes note
// triggering onto its beat grid.

export const GRID_SUBDIVISION = 0.25; // 16th notes in 4/4
export const STALE_AFTER_MS = 1500; // ~37 missed broadcasts
export const PING_INTERVAL_MS = 1000;

// Smallest grid multiple at or after `beat` (a hit exactly on the grid
// plays immediately).
export function nextGridBeat(beat, sub = GRID_SUBDIVISION) {
  return Math.ceil(beat / sub - 1e-9) * sub + 0; // + 0 normalizes -0
}

// Clock-offset estimator: keeps the offset sample with the smallest
// round-trip time over a sliding window (NTP-style; min-RTT is the
// least delayed sample, so its midpoint is the best offset guess).
// Pure, so unit tests can feed it synthetic networks.
export class OffsetEstimator {
  constructor(windowSize = 12) {
    this.windowSize = windowSize;
    this.samples = []; // { rtt, offset }
  }

  // sentAt/receivedAt on the client clock (performance.now, ms),
  // serverTs on the server clock (ms).
  addSample(sentAt, serverTs, receivedAt) {
    const rtt = receivedAt - sentAt;
    const offset = serverTs - (sentAt + receivedAt) / 2;
    this.samples.push({ rtt, offset });
    if (this.samples.length > this.windowSize) this.samples.shift();
    return rtt;
  }

  // Estimated serverTime - clientTime, or null before any sample.
  get offset() {
    if (!this.samples.length) return null;
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    return best.offset;
  }

  get bestRtt() {
    if (!this.samples.length) return null;
    return Math.min(...this.samples.map((s) => s.rtt));
  }
}

export class LinkSync {
  constructor({ onState, onStatus, pingIntervalMs = PING_INTERVAL_MS, staleAfterMs = STALE_AFTER_MS } = {}) {
    this.onState = onState || (() => {});
    this.onStatus = onStatus || (() => {});
    this.pingIntervalMs = pingIntervalMs;
    this.staleAfterMs = staleAfterMs;
    this.ws = null;
    this.state = null; // last { bpm, beat, phase, quantum, peers, playing, ts }
    this.recvPerf = 0;
    this.lastMsgPerf = 0;
    this.estimator = new OffsetEstimator();
    this.isOn = false;
    this.stale = false;
    this._pingTimer = null;
    this._watchdog = null;
  }

  connect(url) {
    this.disconnect();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.isOn = true;
      this.stale = false;
      this.onStatus('on');
      let pings = 0;
      const ping = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'ping', c: performance.now() }));
          pings += 1;
        }
      };
      ping(); // first sample immediately
      this._pingTimer = setInterval(ping, this.pingIntervalMs);
      this._watchdog = setInterval(() => this._checkStale(), 250);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const now = performance.now();
      this.lastMsgPerf = now;
      if (msg.t === 'pong' && typeof msg.c === 'number') {
        this.estimator.addSample(msg.c, msg.ts, now);
        return;
      }
      if (msg.t !== 'state') return;
      this.state = msg;
      this.recvPerf = now;
      if (this.stale) {
        this.stale = false;
        this.onStatus('on');
      }
      this.onState(msg);
    };
    ws.onclose = () => this._teardown('off');
    ws.onerror = () => ws.close();
  }

  _teardown(status) {
    this.isOn = false;
    this.stale = false;
    this.state = null;
    clearInterval(this._pingTimer);
    clearInterval(this._watchdog);
    this._pingTimer = null;
    this._watchdog = null;
    this.onStatus(status);
  }

  _checkStale() {
    if (!this.isOn || this.stale) return;
    if (this.lastMsgPerf && performance.now() - this.lastMsgPerf > this.staleAfterMs) {
      this.stale = true;
      this.onStatus('stale');
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.isOn = false;
    this.stale = false;
    this.state = null;
    clearInterval(this._pingTimer);
    clearInterval(this._watchdog);
  }

  get bpm() {
    return this.state ? this.state.bpm : 0;
  }

  // Estimated server-clock time for a client-clock instant.
  serverTimeAt(perfNow = performance.now()) {
    const off = this.estimator.offset;
    return off === null ? null : perfNow + off;
  }

  // Continuous Link beat position right now. With an offset estimate,
  // extrapolate on the server clock (corrects one-way lag); before the
  // first pong, fall back to receipt-time anchoring (uncorrected).
  currentBeat(perfNow = performance.now()) {
    if (!this.state) return 0;
    const serverNow = this.serverTimeAt(perfNow);
    if (serverNow !== null) {
      return this.state.beat + ((serverNow - this.state.ts) / 1000) * (this.state.bpm / 60);
    }
    const elapsedBeats = ((perfNow - this.recvPerf) / 1000) * (this.state.bpm / 60);
    return this.state.beat + elapsedBeats;
  }

  // AudioContext time of the next 16th-note boundary, or null when the
  // timeline is stale (callers must fall back to immediate playback).
  quantizedTime(ctx, perfNow = performance.now(), sub = GRID_SUBDIVISION) {
    if (this.stale || !this.state) return null;
    const beat = this.currentBeat(perfNow);
    const gridBeat = nextGridBeat(beat, sub);
    const dtBeats = gridBeat - beat;
    return {
      when: ctx.currentTime + (dtBeats * 60) / this.state.bpm,
      beat,
      gridBeat,
    };
  }

  // AudioContext time of the first grid boundary (sub beats apart) at
  // or after the beat position that corresponds to `when` (itself an
  // AudioContext time). The background scheduler books hits ahead of
  // the clock, so it cannot use quantizedTime (which only quantizes
  // "now").
  quantizeAt(ctx, when, perfNow = performance.now(), sub = GRID_SUBDIVISION) {
    if (this.stale || !this.state) return null;
    const beatNow = this.currentBeat(perfNow);
    const beatAt = beatNow + ((when - ctx.currentTime) * this.state.bpm) / 60;
    const gridBeat = nextGridBeat(beatAt, sub);
    return {
      when: ctx.currentTime + ((gridBeat - beatNow) * 60) / this.state.bpm,
      gridBeat,
    };
  }
}

// The bridge exposes /link-info on the same origin it serves the app
// from (gated by the per-run key in the page URL); the hosted Pages
// copy has no such endpoint, so the link key only appears when the app
// is actually reachable through a bridge.
export async function probeBridge(timeoutMs = 900) {
  try {
    const key = new URLSearchParams(location.search).get('key');
    const res = await fetch(`/link-info${key ? `?key=${key}` : ''}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// WebSocket URL for the bridge that served this page, carrying the
// per-run access key from the page URL.
export function bridgeWsUrl() {
  const key = new URLSearchParams(location.search).get('key');
  return `ws://${location.host}/ws${key ? `?key=${key}` : ''}`;
}
