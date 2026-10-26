// Web Audio voices and the master output chain.
// scheduleVoice works with any BaseAudioContext, including
// OfflineAudioContext, which is how the smoke test renders real audio.

export const VOICES = ['bell', 'marimba', 'pluck', 'synth', 'chiptune'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Karplus-Strong plucked string rendered into a buffer. Pure and
// deterministic (seeded), so Node tests can assert on the samples.
export function renderPluck(freq, sampleRate, seconds = 1.2, seed = 7, damp = 0.996) {
  const n = Math.floor(seconds * sampleRate);
  const period = Math.max(2, Math.round(sampleRate / freq));
  const rand = mulberry32(seed);
  const ring = new Float32Array(period);
  for (let i = 0; i < period; i++) ring[i] = rand() * 2 - 1;
  const out = new Float32Array(n);
  let i = 0;
  for (let s = 0; s < n; s++) {
    const cur = ring[i];
    out[s] = cur;
    const next = ring[(i + 1) % period];
    ring[i] = damp * 0.5 * (cur + next);
    i = (i + 1) % period;
  }
  return out;
}

function envGain(ctx, dest, when, peak, attack, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  g.connect(dest);
  return g;
}

function osc(ctx, type, freq) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  return o;
}

export function scheduleVoice(ctx, dest, name, freq, when = ctx.currentTime, velocity = 1) {
  const v = Math.max(0, Math.min(1, velocity));
  switch (name) {
    case 'bell': {
      // Inharmonic partials, long decay.
      const partials = [[1, 0.5, 3.2], [2.76, 0.28, 1.8], [5.404, 0.12, 0.8]];
      for (const [ratio, amp, decay] of partials) {
        const g = envGain(ctx, dest, when, amp * v, 0.004, decay);
        const o = osc(ctx, 'sine', freq * ratio);
        o.connect(g);
        o.start(when);
        o.stop(when + decay + 0.1);
      }
      return when + 3.3;
    }
    case 'marimba': {
      const g = envGain(ctx, dest, when, 0.6 * v, 0.003, 0.55);
      const o = osc(ctx, 'sine', freq);
      o.connect(g); o.start(when); o.stop(when + 0.7);
      const g2 = envGain(ctx, dest, when, 0.18 * v, 0.003, 0.12);
      const o2 = osc(ctx, 'sine', freq * 4.2);
      o2.connect(g2); o2.start(when); o2.stop(when + 0.25);
      return when + 0.8;
    }
    case 'pluck': {
      const len = 1.2;
      const buf = ctx.createBuffer(1, Math.floor(len * ctx.sampleRate), ctx.sampleRate);
      buf.getChannelData(0).set(renderPluck(freq, ctx.sampleRate, len));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = 0.9 * v;
      src.connect(g); g.connect(dest);
      src.start(when); src.stop(when + len);
      return when + len;
    }
    case 'synth': {
      const o = osc(ctx, 'sawtooth', freq);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 1;
      f.frequency.setValueAtTime(Math.min(8000, freq * 6), when);
      f.frequency.exponentialRampToValueAtTime(Math.max(120, freq * 1.5), when + 0.6);
      const g = envGain(ctx, dest, when, 0.4 * v, 0.01, 0.85);
      o.connect(f); f.connect(g);
      o.start(when); o.stop(when + 1.0);
      return when + 1.0;
    }
    case 'chiptune': {
      const o = osc(ctx, 'square', freq);
      o.frequency.setValueAtTime(freq, when);
      o.frequency.setValueAtTime(freq * 1.5, when + 0.05);
      o.frequency.setValueAtTime(freq * 2, when + 0.1);
      const g = envGain(ctx, dest, when, 0.25 * v, 0.002, 0.24);
      o.connect(g);
      o.start(when); o.stop(when + 0.32);
      return when + 0.35;
    }
    default:
      throw new Error(`unknown voice: ${name}`);
  }
}

// Live output: voices -> master gain -> limiter-ish compressor -> out.
export function createAudio({ volume = 0.6 } = {}) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) throw new Error('Web Audio is not available in this browser');
  const ctx = new AC();
  const master = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -6;
  comp.knee.value = 6;
  comp.ratio.value = 12;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  master.connect(comp);
  comp.connect(ctx.destination);

  let muted = false;
  let vol = Math.max(0, Math.min(1, volume));
  let active = 0;
  master.gain.value = muted ? 0 : vol;

  return {
    ctx,
    destination: master,
    post: comp,
    play(name, freq, velocity = 1) {
      if (ctx.state !== 'running' || muted || active >= 24) return false;
      active += 1;
      setTimeout(() => { active -= 1; }, 1500);
      scheduleVoice(ctx, master, name, freq, ctx.currentTime, velocity);
      return true;
    },
    setVolume(v) {
      vol = Math.max(0, Math.min(1, v));
      if (!muted) master.gain.setTargetAtTime(vol, ctx.currentTime, 0.02);
    },
    setMuted(m) {
      muted = !!m;
      master.gain.setTargetAtTime(muted ? 0 : vol, ctx.currentTime, 0.02);
    },
    isMuted: () => muted,
    getVolume: () => vol,
    resume: () => ctx.resume(),
    suspend: () => ctx.suspend(),
  };
}
