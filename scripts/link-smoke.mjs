// End-to-end Link test: runs the real python bridge (aalink joins a Link
// session), loads the bridge-served app in headless Chrome, enables link
// sync, and verifies real tempo/beat/phase behavior:
//   - bridge HTTP endpoints + link key probe
//   - connect, state following, live tempo change propagation
//   - notes quantized onto the Link 16th grid (times checked, not UI)
//   - beat indicator pulses; disconnect restores standalone mode
// Env: LINK_PYTHON (default python3), LINK_PYTHONPATH for aalink deps.
import { spawn } from 'node:child_process';

const PY = process.env.LINK_PYTHON || 'python3';
const PORT = 8780 + (process.pid % 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const bridge = spawn(PYTHON_CMD_SAFE(PY), ['link/bridge.py', '--port', String(PORT), '--bpm', '120'], {
  env: { ...process.env, PYTHONPATH: process.env.LINK_PYTHONPATH || '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
bridge.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));

function PYTHON_CMD_SAFE(p) { return p; }

let chrome;
try {
  // bridge endpoints
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/link-info`);
      if (res.ok) { up = true; var info = await res.json(); }
    } catch { }
    await sleep(250);
  }
  ok('bridge serves /link-info', up && info && info.name === 'ricochet link bridge');
  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  ok('bridge serves the app over http', page.ok && (await page.text()).includes('ricochet'));

  // headless chrome over CDP
  const dbgPort = 9300 + (process.pid % 300);
  chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${dbgPort}`, '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 40 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
      const pg = list.find((t) => t.type === 'page');
      if (pg) ws = new WebSocket(pg.webSocketDebuggerUrl);
    } catch { }
    if (!ws) await sleep(250);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const cdp = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
  const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/?linktest` });
  await sleep(2500);

  ok('link key appears when served by the bridge', await ev(`!document.getElementById('btn-link').hidden`));

  // power on, then enable link
  await ev(`document.getElementById('btn-start').click()`);
  await sleep(400);
  await ev(`document.getElementById('btn-link').click()`);
  await sleep(800);
  ok('link connects through the bridge', await ev(`window.__LINKCTL.get() && window.__LINKCTL.get().isOn === true`));
  ok('state follows the bridge (bpm 120)', await ev(`window.__LINKCTL.get() && Math.abs(window.__LINKCTL.get().bpm - 120) < 0.5`),
     `bpm ${await ev(`window.__LINKCTL.get() && window.__LINKCTL.get().bpm`)}`);
  ok('caption shows the link tempo', await ev(`document.querySelector('#screen-caption .caption-right').textContent.includes('120.0')`));

  // live tempo change from a second client (stands in for Ableton Live)
  const ctl = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => { ctl.onopen = r; });
  ctl.send(JSON.stringify({ t: 'tempo', bpm: 96 }));
  await sleep(700);
  ok('tempo change propagates to the app', await ev(`Math.abs(window.__LINKCTL.get().bpm - 96) < 0.5`),
     `bpm ${await ev(`window.__LINKCTL.get().bpm`)}`);

  // trigger bounce hits and verify quantization onto the 16th grid
  await ev(`window.__QUANT = []; window.__RIC.bounce.balls.forEach(b => { b.x = window.__RIC.bounce.polygon.center.x; }); true`);
  await sleep(4000);
  const q = await ev(`window.__QUANT || []`);
  ok('bounce hits were scheduled through the link clock', q.length > 0, `${q.length} notes`);
  const sub = 0.25;
  const offGrid = q.filter((x) => Math.abs(x.gridBeat / sub - Math.round(x.gridBeat / sub)) > 1e-6);
  ok('every note lands exactly on a 16th grid point', offGrid.length === 0, `${offGrid.length} off-grid`);
  const tooLate = q.filter((x) => x.gridBeat < x.beat - 1e-6);
  ok('no note is scheduled in the past', tooLate.length === 0);
  const far = q.filter((x) => x.gridBeat - x.beat > sub + 1e-6);
  ok('max quantization delay is one 16th', far.length === 0);
  const ctxT = await ev(`window.__RIC.audio.ctx.currentTime`);
  const inPast = q.filter((x) => x.when < ctxT - 8); // generous: notes decay over seconds
  ok('scheduled times are on the audio clock', inPast.length === 0 && q.every((x) => x.when > 0));

  // beat indicator pulses at 96 bpm (beat every 625ms)
  const pulses = await ev(`new Promise((res) => { let n = 0; const b = document.getElementById('btn-link');
    const mo = new MutationObserver(() => { if (b.classList.contains('beat')) n++; });
    mo.observe(b, { attributes: true, attributeFilter: ['class'] });
    setTimeout(() => { mo.disconnect(); res(n); }, 2100); })`);
  ok('beat indicator pulses on the link beat', pulses >= 2 && pulses <= 5, `${pulses} pulses in 2.1s`);

  // disconnect restores standalone behavior
  await ev(`document.getElementById('btn-link').click()`);
  await sleep(300);
  ok('disconnect restores standalone mode', await ev(`!window.__LINKCTL.get() || window.__LINKCTL.get().isOn === false`)
     && await ev(`document.querySelector('#screen-caption .caption-right').textContent === 'audio out \\u2192 mixer'`));
  ctl.close();
} catch (err) {
  ok('link-smoke run completed', false, String((err && err.stack) || err));
} finally {
  if (chrome) chrome.kill('SIGKILL');
  bridge.kill('SIGKILL');
}

const pass = results.every((x) => x.pass);
console.log(pass ? 'LINK SMOKE PASS' : 'LINK SMOKE FAIL');
process.exit(pass ? 0 : 1);
