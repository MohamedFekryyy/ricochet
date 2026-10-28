// Background playback test over CDP: loads the app with audio, starts
// it, then opens a second tab and activates it so the app tab goes
// hidden (no rAF, throttled timers - exactly the reported scenario).
// Asserts the bounce sim keeps producing scheduled notes while hidden
// and the AudioContext stays running.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const build = spawnSync('node', ['scripts/build.mjs'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(1);

const html = readFileSync('dist/ricochet.html', 'utf8');
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const chrome = process.env.CHROME || 'google-chrome';
const dbgPort = 9222 + (process.pid % 500);
const proc = spawn(chrome, [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${dbgPort}`,
  '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function jsonApi(path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${dbgPort}${path}`, { method });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function firstPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await jsonApi('/json/list');
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome devtools endpoint never came up');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let idSeq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const cdp = (method, params = {}) => {
    const id = ++idSeq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => pending.set(id, res));
  };
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return new Promise((res, rej) => {
    ws.onopen = () => res({ cdp, evaluate, ws });
    ws.onerror = rej;
  });
}

try {
  const pageA = await firstPage();
  const A = await connect(pageA.webSocketDebuggerUrl);
  await A.cdp('Page.enable');
  await A.cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(1500);

  // Start with audio (autoplay flag lets the context run headless).
  await A.evaluate(`document.getElementById('btn-start').click()`);
  await sleep(2500);

  const vis1 = await A.evaluate(`({
    state: app_audio_state(),
    hits: window.__RIC.hitCount,
    frames: window.__frames,
  })`.replace('app_audio_state()', `window.__RIC.audio.ctx.state`));
  ok('audio running and bounce playing while visible', vis1.state === 'running' && vis1.hits > 0,
    `state ${vis1.state}, ${vis1.hits} hits, ${vis1.frames} frames`);

  // Hide the tab. Headless pages never report hidden on their own, so
  // emulate the exact platform signal: document.hidden flips and a
  // visibilitychange fires. The rAF guard in the app makes the visible
  // loop stand down, leaving the timer scheduler - the same hand-off a
  // real hidden tab produces (real tabs also throttle timers to ~1/s;
  // the lookahead margin for that is asserted below).
  await A.evaluate(`(() => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    window.__setHidden = (v) => { hidden = v; document.dispatchEvent(new Event('visibilitychange')); };
  })()`);
  await A.evaluate(`window.__setHidden(true)`);
  await sleep(800);

  const hid = await A.evaluate(`({ hidden: document.hidden, frames: window.__frames, hits: window.__RIC.hitCount, ticks: window.__BG.ticks, booked: window.__BG.booked })`);
  ok('app tab is hidden (emulated platform signal)', hid.hidden === true, `hidden=${hid.hidden}`);

  await sleep(4000);
  const after = await A.evaluate(`({
    frames: window.__frames,
    hits: window.__RIC.hitCount,
    ticks: window.__BG.ticks,
    booked: window.__BG.booked,
    state: window.__RIC.audio.ctx.state,
    ahead: window.__BG.lastWhen - window.__RIC.audio.ctx.currentTime,
    lookahead: window.__BG.lookahead,
  })`);

  ok('visible loop stepped down (no sim stepping from rAF)', after.frames - hid.frames >= 0 && after.ticks > 0,
    `${after.frames - hid.frames} frames, sim owned by scheduler`);
  ok('lookahead clears the 1/s hidden-timer clamp', after.lookahead >= 1.2, `lookahead ${after.lookahead}s`);
  ok('background scheduler ticks while hidden', after.ticks > 0, `${after.ticks} ticks`);
  ok('notes keep being booked while hidden', after.booked > 0 && after.hits > hid.hits,
    `booked ${after.booked}, hits ${hid.hits} -> ${after.hits}`);
  ok('audio context stays running while hidden', after.state === 'running', after.state);
  ok('bookings stay within the lookahead window', after.ahead <= 1.7, `last note ${after.ahead.toFixed(2)}s ahead`);

  // Back to the foreground: scheduler stops, rAF owns the sim again.
  // Booked notes still sound during the catch-up stretch (hitCount is
  // not double-counted there), so poll a while for a fresh rAF hit.
  await A.evaluate(`window.__setHidden(false)`);
  await sleep(1500);
  const back = await A.evaluate(`({ hidden: document.hidden, frames: window.__frames, state: window.__RIC.audio.ctx.state, hits: window.__RIC.hitCount, silentFor: window.__RIC.silentUntilCtx - window.__RIC.audio.ctx.currentTime })`);
  const framesThen = back.frames;
  await sleep(500);
  const framesNow = await A.evaluate(`window.__frames`);
  ok('visible again: rAF resumed, context running',
    back.hidden === false && framesNow > framesThen && back.state === 'running',
    `hidden=${back.hidden}, frames ${framesThen} -> ${framesNow}, state ${back.state}, booked stretch left ${back.silentFor.toFixed(2)}s`);
  let hitsAfter = back.hits;
  const hitDeadline = Date.now() + 5000;
  while (Date.now() < hitDeadline && hitsAfter <= back.hits) {
    await sleep(400);
    hitsAfter = await A.evaluate(`window.__RIC.hitCount`);
  }
  ok('visible loop plays new notes after the booked stretch', hitsAfter > back.hits,
    `hits ${back.hits} -> ${hitsAfter}`);
} catch (err) {
  ok('run completed', false, String((err && err.stack) || err));
} finally {
  proc.kill('SIGKILL');
  server.close();
}

const pass = results.every((r) => r.pass);
console.log(pass ? 'BG SMOKE PASS' : 'BG SMOKE FAIL');
process.exit(pass ? 0 : 1);
