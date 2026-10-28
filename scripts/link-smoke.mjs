// End-to-end Link test against the real python bridge (aalink):
//   - access key gating: wrong/missing key -> 404 on http and ws
//   - cross-origin websocket handshake rejected
//   - key appears only via probe; connect; state following
//   - read-only default: remote tempo command ignored
//   - opt-in: bridge with --allow-remote-tempo accepts tempo change
//   - notes quantized onto the 16th grid (scheduled times checked)
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

function startBridge(port, extra = []) {
  const proc = spawn(PY, ['link/bridge.py', '--port', String(port), '--bpm', '120', ...extra], {
    env: { ...process.env, PYTHONPATH: process.env.LINK_PYTHONPATH || '', PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  return { proc, getStdout: () => stdout };
}

const bridge = startBridge(PORT);
let chrome;
try {
  // wait for the URL (with its per-run key) on stdout
  let appUrl = null;
  for (let i = 0; i < 80 && !appUrl; i++) {
    const m = bridge.getStdout().match(/open on the phone: (http:\/\/\S+)/);
    if (m) appUrl = m[1];
    await sleep(250);
  }
  ok('bridge prints an access URL', !!appUrl, appUrl || 'none');
  const key = new URL(appUrl).searchParams.get('key');
  const base = `http://127.0.0.1:${PORT}`;

  // access gating
  const noKey = await fetch(`${base}/`).catch(() => null);
  ok('app requires the key', noKey && noKey.status === 404, `status ${noKey && noKey.status}`);
  const badKey = await fetch(`${base}/link-info?key=wrong`).catch(() => null);
  ok('link-info rejects a wrong key', badKey && badKey.status === 404);
  const info = await fetch(`${base}/link-info?key=${key}`);
  ok('link-info accepts the key', info.ok && (await info.json()).version === 2);
  const wsNoKey = await new Promise((res) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    w.onopen = () => { w.close(); res('opened'); };
    w.onerror = () => res('rejected');
    setTimeout(() => res('timeout'), 3000);
  });
  ok('websocket requires the key', wsNoKey === 'rejected', wsNoKey);
  const wsBadOrigin = await new Promise((res) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${key}`, { headers: { Origin: 'http://evil.example' } });
    w.onopen = () => { w.close(); res('opened'); };
    w.onerror = () => res('rejected');
    setTimeout(() => res('timeout'), 3000);
  });
  ok('cross-origin websocket is rejected', wsBadOrigin === 'rejected', wsBadOrigin);

  // headless chrome
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
  await cdp('Page.navigate', { url: `${base}/?key=${key}&linktest` });
  await sleep(2500);

  ok('link key appears when served by the bridge', await ev(`!document.getElementById('btn-link').hidden`));

  await ev(`document.getElementById('btn-start').click()`);
  await sleep(400);
  await ev(`document.getElementById('btn-link').click()`);
  await sleep(1200);
  ok('link connects through the bridge', await ev(`window.__LINKCTL.get() && window.__LINKCTL.get().isOn === true`));
  ok('state follows the bridge (bpm 120)', await ev(`window.__LINKCTL.get() && Math.abs(window.__LINKCTL.get().bpm - 120) < 0.5`),
     `bpm ${await ev(`window.__LINKCTL.get() && window.__LINKCTL.get().bpm`)}`);
  ok('clock offset estimation is running', await ev(`window.__LINKCTL.get() && window.__LINKCTL.get().estimator.offset !== null`));

  // read-only default: a remote tempo command must be ignored
  const ctl = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${key}`);
  await new Promise((r) => { ctl.onopen = r; });
  ctl.send(JSON.stringify({ t: 'tempo', bpm: 96 }));
  await sleep(700);
  ok('remote tempo change is ignored by default (read-only sync)',
     await ev(`Math.abs(window.__LINKCTL.get().bpm - 120) < 0.5`),
     `bpm ${await ev(`window.__LINKCTL.get().bpm`)}`);
  ctl.close();

  // quantization onto the 16th grid
  await ev(`window.__QUANT = []; true`);
  await sleep(4000);
  const q = await ev(`window.__QUANT || []`);
  ok('bounce hits were scheduled through the link clock', q.length > 0, `${q.length} notes`);
  const sub = 0.25; // every selectable grid (1/16, 1/8, 1/4) is a multiple of a 16th
  const offGrid = q.filter((x) => Math.abs(x.gridBeat / sub - Math.round(x.gridBeat / sub)) > 1e-6);
  ok('every note lands exactly on a 16th grid point', offGrid.length === 0, `${offGrid.length} off-grid`);
  const tooLate = q.filter((x) => x.gridBeat < x.beat - 1e-6);
  ok('no note is scheduled in the past', tooLate.length === 0);
  const sel = await ev('window.__SYNCGRID || 0.25');
  const far = q.filter((x) => x.gridBeat - x.beat > sel + 1e-6);
  ok(`max quantization delay is one slot of the selected grid (${sel} beats)`, far.length === 0);

  // beat indicator pulses at 120 bpm (beat every 500ms)
  const pulses = await ev(`new Promise((res) => { let n = 0; const b = document.getElementById('btn-link');
    const mo = new MutationObserver(() => { if (b.classList.contains('beat')) n++; });
    mo.observe(b, { attributes: true, attributeFilter: ['class'] });
    setTimeout(() => { mo.disconnect(); res(n); }, 2100); })`);
  ok('beat indicator pulses on the link beat', pulses >= 2 && pulses <= 6, `${pulses} pulses in 2.1s`);

  // clean disconnect restores standalone mode
  await ev(`document.getElementById('btn-link').click()`);
  await sleep(300);
  ok('disconnect restores standalone mode', await ev(`!window.__LINKCTL.get() || window.__LINKCTL.get().isOn === false`)
     && await ev(`document.getElementById('link-status').hidden === true`));
  // opt-in remote tempo, on a fresh bridge (a second concurrent aalink
  // instance would join the same Link session and converge timelines)
  bridge.proc.kill('SIGKILL');
  const bridge2 = startBridge(PORT + 50, ['--allow-remote-tempo']);
  let appUrl2 = null;
  for (let i = 0; i < 80 && !appUrl2; i++) {
    const m = bridge2.getStdout().match(/open on the phone: (http:\/\/\S+)/);
    if (m) appUrl2 = m[1];
    await sleep(250);
  }
  const key2 = new URL(appUrl2).searchParams.get('key');
  const ctl2 = new WebSocket(`ws://127.0.0.1:${PORT + 50}/ws?key=${key2}`);
  await new Promise((r) => { ctl2.onopen = r; });
  let bpm2 = null;
  ctl2.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'state') bpm2 = m.bpm; };
  ctl2.send(JSON.stringify({ t: 'tempo', bpm: 96 }));
  await sleep(600);
  ok('opt-in --allow-remote-tempo accepts tempo change', bpm2 !== null && Math.abs(bpm2 - 96) < 0.5, `bpm ${bpm2}`);
  ctl2.close();
  bridge2.proc.kill('SIGKILL');
} catch (err) {
  ok('link-smoke run completed', false, String((err && err.stack) || err));
} finally {
  if (chrome) chrome.kill('SIGKILL');
  bridge.proc.kill('SIGKILL');
}

const pass = results.every((x) => x.pass);
console.log(pass ? 'LINK SMOKE PASS' : 'LINK SMOKE FAIL');
process.exit(pass ? 0 : 1);
