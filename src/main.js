// Ricochet: a tiny browser instrument.
// Bounce mode: balls bounce inside a polygon; each wall hit plays a note.
// Grid mode: drag across a 10x10 field of dots to play.
// Sound is made here; plug the device into a mixer (e.g. EP-136 input).

import {
  LIMITS,
  createBounceState,
  bounceStep,
  bounceWindow,
  rebuildPolygon,
  setCorners,
  setSpeed,
  setAmount,
} from './engine.js';
import { cellFromPoint, brushCells, makeTouchTracker } from './grid.js';
import { VOICES, createAudio, scheduleVoice } from './audio.js';
import { SCALE_NAMES, gridFreq } from './notes.js';
import { LinkSync, probeBridge, bridgeWsUrl } from './link.js';

const params = new URLSearchParams(location.search);
const SMOKE = params.has('smoke');
const LINKTEST = params.has('linktest');
const SHOT = params.get('shot'); // 'bounce' | 'grid' for deterministic screenshots

const GRID_COLS = 10;
const GRID_ROWS = 10;
const BALL_COLORS = ['#ffb000', '#fff1d6', '#ff4d00'];
const BG = '#0b0a08';

const canvas = document.getElementById('stage');
const c2d = canvas.getContext('2d');
const hud = document.getElementById('hud');
const controls = document.getElementById('controls');
const overlay = document.getElementById('overlay');

const app = {
  mode: 'bounce',
  sound: 'bell',
  scale: 'pentatonic',
  rootMidi: 60,
  paused: false,
  audio: null,
  bounce: null,
  corners: 7,
  speed: 23,
  amount: 1,
  flashes: new Map(), // edge index -> intensity 0..1
  syncGrid: 0.5, // Link quantization in beats (8th notes)
  grid: {
    sensitivity: 90,
    size: 1,
    tracker: makeTouchTracker(90),
    active: new Map(), // "col,row" -> timestamp
    pointerDown: false,
  },
  triggeredInSmoke: 0,
  hitCount: 0,
  silentUntilCtx: 0,
};

let linkSync = null;
const btnLink = document.getElementById('btn-link');

// ---------- layout ----------

function viewSize() {
  return { w: canvas.clientWidth || window.innerWidth, h: canvas.clientHeight || window.innerHeight };
}

function resize() {
  const { w, h } = viewSize();
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!app.bounce) {
    app.bounce = createBounceState({
      width: w, height: h,
      sides: app.corners, speed: app.speed, amount: app.amount,
      scale: app.scale, rootMidi: app.rootMidi,
    });
  } else {
    app.bounce.width = w;
    app.bounce.height = h;
    rebuildPolygon(app.bounce);
  }
}

function gridRect() {
  const { w, h } = viewSize();
  const side = Math.min(w, h * 0.72) * 0.88;
  return { x: (w - side) / 2, y: (h - side) * 0.45, size: side };
}

// ---------- sound ----------

// Link grid choices, in beats. Coarse grids are what make the sync
// audible: random wall hits snapped to 16ths still sound random.
const SYNC_GRIDS = [['1/16', 0.25], ['1/8', 0.5], ['1/4', 1]];
const slotNotes = new Map(); // gridBeat -> Set of freqs already queued
if (LINKTEST) window.__SYNCGRID = app.syncGrid;

// Several hits landing in one grid slot would stack into a flam; play
// each pitch once per slot. Returns false for a duplicate.
function claimGridSlot(gridBeat, freq) {
  const slot = Math.round(gridBeat * 1000);
  let set = slotNotes.get(slot);
  if (!set) {
    set = new Set();
    slotNotes.set(slot, set);
    for (const k of slotNotes.keys()) if (k < slot - 8000) slotNotes.delete(k);
  }
  if (set.has(freq)) return false;
  set.add(freq);
  return true;
}

// Returns the delay in seconds until the note sounds (0 when immediate,
// null when dropped as a duplicate in its grid slot).
function play(freq, velocity = 1) {
  if (!app.audio) return null;
  if (linkSync && linkSync.isOn) {
    const q = linkSync.quantizedTime(app.audio.ctx, performance.now(), app.syncGrid);
    if (q) {
      if (LINKTEST) (window.__QUANT = window.__QUANT || []).push(q);
      if (!claimGridSlot(q.gridBeat, freq)) return null;
      app.audio.playAt(app.sound, freq, q.when, velocity);
      return Math.max(0, q.when - app.audio.ctx.currentTime);
    }
    // stale timeline: fall through to immediate playback
  }
  app.audio.play(app.sound, freq, velocity);
  return 0;
}

// ---------- ableton link ----------

function updateLinkStatus(msg) {
  const el = document.getElementById('link-status');
  if (linkSync && linkSync.isOn && !linkSync.stale && msg) {
    el.hidden = false;
    el.textContent = `link \u00b7 ${msg.bpm.toFixed(1)} bpm \u00b7 ${msg.peers + 1} peer${msg.peers ? 's' : ''}`;
  } else if (linkSync && linkSync.stale) {
    el.hidden = false;
    el.textContent = 'link lost \u00b7 tap link to retry';
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

function toggleLink() {
  if (linkSync && linkSync.isOn) {
    linkSync.disconnect();
    linkSync = null;
    btnLink.classList.remove('active');
    updateLinkStatus(null);
    return;
  }
  linkSync = new LinkSync({
    onState: updateLinkStatus,
    onStatus: (st) => {
      btnLink.classList.toggle('active', st === 'on');
      if (st === 'stale') updateLinkStatus(null); // shows the link-lost hint
      if (st === 'off') {
        linkSync = null;
        updateLinkStatus(null);
      }
    },
  });
  linkSync.connect(bridgeWsUrl());
}

btnLink.addEventListener('click', toggleLink);

// The link key only exists when the app is served by the bridge
// (the hosted Pages copy cannot reach a LAN websocket from https).
probeBridge().then((info) => {
  if (info) {
    btnLink.hidden = false;
    document.getElementById('section-sync').hidden = false;
  }
});

// ---------- grid input ----------

function gridTriggerAt(x, y) {
  const g = gridRect();
  const cell = cellFromPoint(x - g.x, y - g.y, g.size, g.size, GRID_COLS, GRID_ROWS);
  if (!cell) return 0;
  const cells = brushCells(cell, app.grid.size, GRID_COLS, GRID_ROWS);
  const now = performance.now();
  let n = 0;
  for (const c of cells) {
    const key = `${c.col},${c.row}`;
    const last = app.grid.active.get(key);
    if (last && now - last < 120) continue; // don't retrigger a still-lit cell
    if (!app.grid.tracker.allow(x, y)) continue;
    const vel = 1 - 0.25 * (Math.abs(c.col - cell.col) + Math.abs(c.row - cell.row));
    play(gridFreq(app.rootMidi, app.scale, c.row, GRID_ROWS), Math.max(0.4, vel));
    app.grid.active.set(key, now);
    n += 1;
  }
  if (SMOKE) app.triggeredInSmoke += n;
  return n;
}

// ---------- controls ----------

function key(label, active, onTap) {
  const b = document.createElement('button');
  b.className = `key${active ? ' active' : ''}`;
  const l = document.createElement('span');
  l.className = 'lbl';
  l.textContent = label;
  b.append(l);
  b.addEventListener('click', () => onTap(b));
  return b;
}

function param(label, get, set, step, lo, hi) {
  const wrap = document.createElement('div');
  wrap.className = 'param';
  const name = document.createElement('div');
  name.className = 'param-label';
  name.textContent = label;
  const face = document.createElement('div');
  face.className = 'param-face';
  const minus = document.createElement('button');
  minus.className = 'key';
  minus.textContent = '−';
  const value = document.createElement('span');
  value.className = 'lcd';
  value.textContent = String(get()).padStart(2, '0');
  const plus = document.createElement('button');
  plus.className = 'key';
  plus.textContent = '+';
  const update = (d) => {
    const v = Math.min(hi, Math.max(lo, get() + d));
    set(v);
    value.textContent = String(get()).padStart(2, '0');
  };
  minus.addEventListener('click', () => update(-step));
  plus.addEventListener('click', () => update(step));
  face.append(minus, value, plus);
  wrap.append(name, face);
  return wrap;
}

function buildControls() {
  const soundRow = document.getElementById('sound-keys');
  const soundButtons = new Map();
  VOICES.forEach((v) => {
    const b = key(v, v === app.sound, () => {
      app.sound = v;
      for (const [name, btn] of soundButtons) btn.classList.toggle('active', name === v);
      if (app.audio) play(660); // audition the voice
    });
    soundButtons.set(v, b);
    soundRow.append(b);
  });

  const scaleRow = document.getElementById('scale-keys');
  const scaleButtons = new Map();
  SCALE_NAMES.forEach((s) => {
    const b = key(s, s === app.scale, () => {
      app.scale = s;
      app.bounce.scale = s;
      for (const [name, btn] of scaleButtons) btn.classList.toggle('active', name === s);
    });
    scaleButtons.set(s, b);
    scaleRow.append(b);
  });

  const syncRow = document.getElementById('sync-keys');
  const syncButtons = new Map();
  SYNC_GRIDS.forEach(([label, sub]) => {
    const b = key(label, sub === app.syncGrid, () => {
      app.syncGrid = sub;
      if (LINKTEST) window.__SYNCGRID = sub;
      for (const [s, btn] of syncButtons) btn.classList.toggle('active', s === sub);
    });
    syncButtons.set(sub, b);
    syncRow.append(b);
  });

  const bouncePanel = document.getElementById('panel-bounce');
  const bounceParams = document.createElement('div');
  bounceParams.className = 'params';
  bounceParams.append(
    param('corners', () => app.corners, (v) => { app.corners = v; setCorners(app.bounce, v); }, 1, ...LIMITS.corners),
    param('speed', () => app.speed, (v) => { app.speed = v; setSpeed(app.bounce, v); }, 1, ...LIMITS.speed),
    param('amount', () => app.amount, (v) => { app.amount = v; setAmount(app.bounce, v); }, 1, ...LIMITS.amount),
  );
  bouncePanel.append(bounceParams);

  const gridPanel = document.getElementById('panel-grid');
  const gridParams = document.createElement('div');
  gridParams.className = 'params';
  gridParams.append(
    param('sensitivity', () => app.grid.sensitivity,
      (v) => { app.grid.sensitivity = v; app.grid.tracker.setSensitivity(v); }, 5, 0, 100),
    param('brush', () => app.grid.size, (v) => { app.grid.size = v; }, 1, 1, 3),
  );
  gridPanel.append(gridParams);
}

function switchMode(mode) {
  app.mode = mode;
  document.querySelectorAll('.key-mode').forEach((d) => {
    d.classList.toggle('active', d.dataset.mode === mode);
  });
  document.getElementById('panel-bounce').hidden = mode !== 'bounce';
  document.getElementById('panel-grid').hidden = mode !== 'grid';
}

// ---------- rendering ----------

let lastT = 0;
window.__frames = 0;

function frame(t) {
  window.__frames += 1;
  const dt = Math.min(1 / 30, lastT ? (t - lastT) / 1000 : 1 / 60);
  lastT = t;
  const { w, h } = viewSize();
  c2d.fillStyle = BG;
  c2d.fillRect(0, 0, w, h);

  if (linkSync && linkSync.isOn && !linkSync.stale && linkSync.state) {
    const beatInt = Math.floor(linkSync.currentBeat());
    if (beatInt !== window.__lastBeatInt) {
      window.__lastBeatInt = beatInt;
      btnLink.classList.add('beat');
      setTimeout(() => btnLink.classList.remove('beat'), 110);
    }
  }

  if (app.mode === 'bounce') {
    if (!app.paused && !document.hidden) {
      // Hits already booked by the background scheduler (up to
      // silentUntilCtx) must not be replayed as the sim re-lives them.
      const silent = app.audio && app.audio.ctx.currentTime < (app.silentUntilCtx || 0);
      for (const ev of bounceStep(app.bounce, dt)) {
        if (silent) continue;
        app.hitCount += 1;
        const delay = play(ev.freq, 0.9);
        // Flash the wall when the note sounds, not when the ball hits,
        // so sight and sound agree under Link quantization.
        if (delay === null) continue;
        if (delay > 0.005) setTimeout(() => app.flashes.set(ev.edge, 1), delay * 1000);
        else app.flashes.set(ev.edge, 1);
      }
    }
    drawBounce(dt);
  } else {
    drawGrid(t);
  }
  requestAnimationFrame(frame);
}

function drawBounce(dt) {
  const { polygon, balls } = app.bounce;
  const { vertices, edges } = polygon;

  c2d.lineWidth = 1.5;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const f = app.flashes.get(i) || 0;
    c2d.strokeStyle = f > 0.02
      ? `rgba(255, 77, 0, ${0.25 + 0.75 * f})`
      : 'rgba(255, 241, 214, 0.75)';
    c2d.lineWidth = f > 0.02 ? 2.5 : 1.5;
    c2d.beginPath();
    c2d.moveTo(a.x, a.y);
    c2d.lineTo(b.x, b.y);
    c2d.stroke();
    if (f > 0) app.flashes.set(i, f * Math.exp(-dt * 5));
  }

  balls.forEach((ball, i) => {
    c2d.beginPath();
    c2d.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
    c2d.fillStyle = BALL_COLORS[i % BALL_COLORS.length];
    c2d.shadowColor = BALL_COLORS[i % BALL_COLORS.length];
    c2d.shadowBlur = 14;
    c2d.fill();
    c2d.shadowBlur = 0;
  });
}

function drawGrid(now) {
  const g = gridRect();
  const cell = g.size / GRID_COLS;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const cx = g.x + (col + 0.5) * cell;
      const cy = g.y + (row + 0.5) * cell;
      const key = `${col},${row}`;
      const t = app.grid.active.get(key);
      const age = t ? (now - t) / 600 : Infinity;
      if (age < 1) {
        const k = 1 - age;
        c2d.beginPath();
        c2d.arc(cx, cy, cell * 0.16 + cell * 0.22 * k, 0, Math.PI * 2);
        c2d.fillStyle = `rgba(255, 77, 0, ${0.25 + 0.75 * k})`;
        c2d.fill();
      } else {
        if (t) app.grid.active.delete(key);
        c2d.beginPath();
        c2d.arc(cx, cy, 2.2, 0, Math.PI * 2);
        c2d.fillStyle = 'rgba(255, 176, 0, 0.28)';
        c2d.fill();
      }
    }
  }
}

// ---------- input ----------

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

let swipeStart = null;

canvas.addEventListener('pointerdown', (e) => {
  if (!app.audio) return;
  app.audio.resume(); // iOS may have suspended the context
  const p = canvasPoint(e);
  if (app.mode === 'grid') {
    app.grid.pointerDown = true;
    app.grid.tracker.reset();
    gridTriggerAt(p.x, p.y);
  } else {
    swipeStart = p;
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (app.mode === 'grid' && app.grid.pointerDown) {
    const p = canvasPoint(e);
    gridTriggerAt(p.x, p.y);
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (app.mode === 'grid') {
    app.grid.pointerDown = false;
    app.grid.tracker.reset();
    return;
  }
  if (swipeStart) {
    const p = canvasPoint(e);
    if (Math.abs(p.x - swipeStart.x) > 70) switchMode(p.x < swipeStart.x ? 'grid' : 'bounce');
    swipeStart = null;
  }
});

document.getElementById('btn-pause').addEventListener('click', (e) => {
  app.paused = !app.paused;
  e.currentTarget.innerHTML = app.paused ? '&#9654;' : '&#10074;&#10074;';
  e.currentTarget.classList.toggle('off', app.paused);
});

// Master fader, 0..100 -> gain 0..1. Read before audio exists so the
// level set on the controls carries into createAudio.
const masterVol = document.getElementById('master-vol');
const masterLcd = document.getElementById('master-lcd');
masterVol.addEventListener('input', () => {
  masterLcd.textContent = String(masterVol.value).padStart(2, '0');
  if (app.audio) app.audio.setVolume(masterVol.value / 100);
});

document.getElementById('btn-mute').addEventListener('click', (e) => {
  if (!app.audio) return;
  app.audio.setMuted(!app.audio.isMuted());
  e.currentTarget.classList.toggle('off', app.audio.isMuted());
});

document.querySelectorAll('.key-mode').forEach((d) => {
  d.addEventListener('click', () => switchMode(d.dataset.mode));
});

// ---------- background playback ----------
// Hidden tabs get no rAF frames, so the visible loop cannot produce
// notes there. While hidden, a timer keeps stepping the bounce sim and
// books hits ahead of the AudioContext clock (Chrome clamps hidden-tab
// timers to ~1/s, so the lookahead must clear a second with margin).
// Flashes are a rendering concern and are skipped here; on return the
// rAF loop picks the sim up exactly where the scheduler left it.

const BG_LOOKAHEAD_S = 1.5;
const BG_TICK_MS = 250;
let bg = null; // { timer, anchorCtx, scheduled }

window.__BG = { ticks: 0, booked: 0, lastWhen: 0, lookahead: BG_LOOKAHEAD_S };

function scheduleNoteAt(freq, velocity, whenCtx) {
  if (!app.audio) return;
  window.__BG.booked += 1;
  window.__BG.lastWhen = whenCtx;
  if (linkSync && linkSync.isOn) {
    const q = linkSync.quantizeAt(app.audio.ctx, whenCtx, performance.now(), app.syncGrid);
    if (q) {
      // Booked hits share the live grid and its per-slot dedupe, so
      // hiding the tab does not change the groove.
      if (!claimGridSlot(q.gridBeat, freq)) return;
      app.audio.playAt(app.sound, freq, q.when, velocity);
      return;
    }
  }
  app.audio.playAt(app.sound, freq, whenCtx, velocity);
}

function bgTick() {
  if (!bg || !app.audio) return;
  const ctx = app.audio.ctx;
  if (ctx.state !== 'running') return;
  window.__BG.ticks += 1;
  const target = (ctx.currentTime - bg.anchorCtx) + BG_LOOKAHEAD_S;
  const span = target - bg.scheduled;
  if (span <= 0) return;
  for (const ev of bounceWindow(app.bounce, span)) {
    const when = bg.anchorCtx + bg.scheduled + ev.t;
    if (when < ctx.currentTime - 0.05) continue; // timer stalled; skip the gap
    app.hitCount += 1;
    scheduleNoteAt(ev.freq, 0.9, when);
  }
  bg.scheduled = target;
}

function startBackground() {
  if (bg || !app.audio || app.paused || app.mode !== 'bounce') return;
  if (app.audio.ctx.state !== 'running') return;
  bg = {
    anchorCtx: app.audio.ctx.currentTime + 0.1,
    hiddenAtCtx: app.audio.ctx.currentTime,
    scheduled: 0,
    snapshot: app.bounce.balls.map((b) => ({ ...b })),
  };
  bg.timer = setInterval(bgTick, BG_TICK_MS);
  bgTick();
}

function stopBackground() {
  if (!bg) return;
  clearInterval(bg.timer);
  if (app.audio) {
    const ctx = app.audio.ctx;
    // The scheduler stepped the shared sim up to a lookahead into the
    // future and booked those notes. Rewind to the pre-hidden snapshot
    // and silently re-step the elapsed stretch (its notes are already
    // booked), so ball visuals and sound stay glued together.
    app.bounce.balls.forEach((b, i) => Object.assign(b, bg.snapshot[i] || b));
    const elapsed = Math.max(0, ctx.currentTime - bg.hiddenAtCtx);
    if (elapsed > 0) bounceWindow(app.bounce, elapsed);
    app.silentUntilCtx = bg.anchorCtx + bg.scheduled;
  }
  bg = null;
}

document.addEventListener('visibilitychange', () => {
  if (!app.audio) return;
  if (document.hidden) startBackground();
  else {
    stopBackground();
    app.audio.resume(); // best effort; iOS may have interrupted the context
  }
});

// ---------- startup ----------

function showUI() {
  overlay.hidden = true;
  hud.hidden = false;
  document.getElementById('screen').hidden = false;
  controls.hidden = false;
  // the canvas was laid out while its screen frame was still hidden
  // (client size 0), so re-measure now that it's visible.
  requestAnimationFrame(resize);
}

function start(withAudio) {
  if (withAudio && !app.audio) {
    app.audio = createAudio({ volume: masterVol.value / 100 });
    app.audio.resume();
  }
  showUI();
}

document.getElementById('btn-start').addEventListener('click', () => start(true));

window.__RIC = app;
window.__LINKCTL = { get: () => linkSync, toggle: toggleLink };
resize();
buildControls();
window.addEventListener('resize', resize);
requestAnimationFrame(frame);

// ---------- headless hooks (used by scripts/smoke.mjs and shots) ----------

if (SHOT) {
  start(false); // visuals only, no audio context
  if (SHOT === 'grid') {
    switchMode('grid');
    app.grid.sensitivity = 0;
    app.grid.tracker.setSensitivity(0);
    // Trace a deterministic stroke repeatedly so any capture moment
    // shows freshly lit cells (they fade after 600ms).
    const stroke = () => {
      const g = gridRect();
      for (let i = 0; i < 7; i++) {
        gridTriggerAt(g.x + (2 + i) * (g.size / GRID_COLS), g.y + (3 + i) * (g.size / GRID_ROWS));
      }
      gridTriggerAt(g.x + 5 * (g.size / GRID_COLS), g.y + 2 * (g.size / GRID_ROWS));
    };
    stroke();
    setInterval(stroke, 400);
  }
}

async function runSmoke() {
  const results = [];
  const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail });
  try {
    // 1. Engine: 10 simulated seconds with 3 balls must produce clean hits.
    const sim = createBounceState({ width: 390, height: 700, sides: 7, speed: 23, amount: 3 });
    let hits = 0;
    let freqOk = true;
    for (let i = 0; i < 600; i++) {
      for (const ev of bounceStep(sim, 1 / 60)) {
        hits += 1;
        if (!Number.isFinite(ev.freq) || ev.freq <= 0) freqOk = false;
      }
    }
    ok('bounce engine produces wall hits', hits > 10, `${hits} hits in 10 simulated s`);
    ok('hit frequencies are finite and positive', freqOk);

    // 2. Real start: audio context, safe defaults, mute behavior.
    start(true);
    await app.audio.resume();
    ok('audio context running after start', app.audio.ctx.state === 'running', app.audio.ctx.state);
    ok('default master volume is safe', app.audio.getVolume() <= 0.85, `volume ${app.audio.getVolume()}`);
    app.audio.setMuted(true);
    ok('mute blocks notes', app.audio.play('bell', 440) === false);
    app.audio.setMuted(false);
    ok('unmute allows notes', app.audio.play('bell', 440) === true);

    // 3. Voices: play each through the live chain and measure real output
    //    on an analyser tap (headless Chrome renders to a null sink; the
    //    analyser still sees the signal).
    const analyser = app.audio.ctx.createAnalyser();
    analyser.fftSize = 2048;
    app.audio.post.connect(analyser); // measure after the limiter
    const buf = new Float32Array(analyser.fftSize);
    const currentPeak = () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      return peak;
    };
    const waitQuiet = async () => {
      for (let k = 0; k < 150; k++) {
        await new Promise((r) => setTimeout(r, 60));
        if (currentPeak() < 0.02) return;
      }
    };
    const measurePeak = async (ms) => {
      let peak = 0;
      for (let t = 0; t < ms; t += 30) {
        await new Promise((r) => setTimeout(r, 30));
        peak = Math.max(peak, currentPeak());
      }
      return peak;
    };
    for (const v of VOICES) {
      await waitQuiet(); // let the previous voice decay so peaks stay comparable
      app.sound = v;
      play(440, 1);
      const peak = await measurePeak(500);
      ok(`voice "${v}" produces audible, limited output`, peak > 0.005 && peak <= 1.3, `peak ${peak.toFixed(3)}`);
    }
    app.sound = 'bell';

    // 4. Grid: synthetic pointer drag must trigger notes.
    switchMode('grid');
    const r = canvas.getBoundingClientRect();
    const fire = (type, fx, fy) => canvas.dispatchEvent(new PointerEvent(type, {
      clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true,
    }));
    fire('pointerdown', 0.2, 0.25);
    for (let i = 1; i <= 20; i++) fire('pointermove', 0.2 + i * 0.03, 0.25 + i * 0.02);
    fire('pointerup', 0.8, 0.65);
    ok('grid drag triggers notes', app.triggeredInSmoke > 0, `${app.triggeredInSmoke} notes`);

    // 5. Bounce: the live loop must keep producing wall hits.
    switchMode('bounce');
    const frames = (n) => new Promise((res) => {
      let left = n;
      const tick = () => (--left <= 0 ? res() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    const before = app.hitCount;
    await frames(150); // 2.5s of animation frames, independent of wall clock
    ok('live bounce loop keeps playing', app.hitCount > before, `${app.hitCount - before} hits`);
  } catch (err) {
    results.push({ name: 'smoke run completed', pass: false, detail: String((err && err.stack) || err) });
  }
  const pass = results.every((x) => x.pass);
  const pre = document.createElement('pre');
  pre.id = 'smoke';
  pre.textContent = JSON.stringify({ pass, results }, null, 2);
  document.body.appendChild(pre);
  document.title = pass ? 'SMOKE PASS' : 'SMOKE FAIL';
  window.__SMOKE = { pass, results };
}

if (SMOKE) runSmoke();
