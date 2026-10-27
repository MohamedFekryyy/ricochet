// Link sync under simulated network conditions:
// a node TCP proxy sits between Chrome and the bridge and adds a fixed
// one-way delay (~60ms) to every chunk in both directions.
//   - clock-offset estimation still tracks the bridge timeline (symmetric
//     delay: min-RTT filter recovers the offset to a few ms)
//   - stalling the proxy trips the staleness watchdog (status 'stale',
//     visible 'link lost' hint, quantizedTime refused) and resuming recovers
// Env: LINK_PYTHON (default python3), LINK_PYTHONPATH for aalink deps.
import { spawn } from 'node:child_process';
import net from 'node:net';

const PY = process.env.LINK_PYTHON || 'python3';
const PORT = 9080 + (process.pid % 200);
const PROXY_PORT = PORT + 200;
const DELAY_MS = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const bridge = spawn(PY, ['link/bridge.py', '--port', String(PORT), '--bpm', '120'], {
  env: { ...process.env, PYTHONPATH: process.env.LINK_PYTHONPATH || '', PYTHONUNBUFFERED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
bridge.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
let bridgeOut = '';
bridge.stdout.on('data', (d) => { bridgeOut += d; });

// ---- delay proxy ----
let paused = false;
const pending = [];
function flush() { for (const fn of pending.splice(0)) fn(); }
const proxy = net.createServer((client) => {
  const upstream = net.connect(PORT, '127.0.0.1');
  const relay = (data, sock) => {
    const send = () => { if (!sock.destroyed) sock.write(data); };
    if (paused) pending.push(send);
    else setTimeout(send, DELAY_MS);
  };
  client.on('data', (d) => relay(d, upstream));
  upstream.on('data', (d) => relay(d, client));
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
});
await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));

let chrome;
try {
  let appUrl = null;
  for (let i = 0; i < 80 && !appUrl; i++) {
    const m = bridgeOut.match(/open on the phone: (http:\/\/\S+)/);
    if (m) appUrl = m[1];
    await sleep(250);
  }
  const key = new URL(appUrl).searchParams.get('key');

  // truth channel: direct ws, no added delay
  const direct = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${key}`);
  await new Promise((r) => { direct.onopen = r; });
  let truth = null;
  direct.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'state') truth = m; };

  // headless chrome through the delay proxy
  const dbgPort = 9600 + (process.pid % 300);
  chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${dbgPort}`, 'about:blank'], { stdio: 'ignore' });
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
  let seq = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const cdp = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };
  const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PROXY_PORT}/?key=${key}&linktest` });
  await sleep(2500);
  await ev(`document.getElementById('btn-start').click()`);
  await sleep(300);
  await ev(`document.getElementById('btn-link').click()`);
  await sleep(3500); // connect + several pings through the delay

  const linkUp = await ev(`window.__LINKCTL.get() && window.__LINKCTL.get().isOn === true`);
  ok('link connects through a 60ms-delayed path', linkUp);

  const rtt = await ev(`window.__LINKCTL.get() && window.__LINKCTL.get().estimator.bestRtt`);
  ok('measured RTT reflects the added delay', rtt !== null && rtt >= 100 && rtt <= 220, `bestRtt ${rtt && rtt.toFixed(1)}ms (expected ~${2 * DELAY_MS}ms)`);

  // accuracy: client beat estimate vs bridge truth at the same instant
  const sample = await ev(`(() => { const l = window.__LINKCTL.get(); if (!l) return null;
    const sn = l.serverTimeAt(); return { serverNow: sn, beat: l.currentBeat(), bpm: l.bpm }; })()`);
  ok('offset estimation converged', sample && sample.serverNow !== null);
  if (sample && truth) {
    const trueBeat = truth.beat + (sample.serverNow - truth.ts) / 1000 * (truth.bpm / 60);
    const err = Math.abs(sample.beat - trueBeat);
    ok('client beat estimate tracks bridge timeline under delay',
       err < 0.05, `error ${(err * 1000).toFixed(1)}ms-equivalent (${err.toFixed(4)} beat @ ${truth.bpm}bpm)`);
  } else {
    ok('client beat estimate tracks bridge timeline under delay', false, 'no truth sample');
  }

  // stall: pause the proxy; the watchdog must flag staleness
  paused = true;
  await sleep(2000);
  ok('network stall trips the staleness watchdog', await ev(`window.__LINKCTL.get() && window.__LINKCTL.get().stale === true`));
  ok('stale link refuses quantized scheduling', await ev(`window.__LINKCTL.get() && window.__LINKCTL.get().quantizedTime(1) === null`));
  ok('link-lost hint is visible', await ev(`(() => { const el = document.getElementById('link-status'); return el && !el.hidden && el.textContent.includes('link lost'); })()`));

  // recover
  paused = false;
  flush();
  await sleep(2500);
  ok('link recovers after the network returns', await ev(`window.__LINKCTL.get() && window.__LINKCTL.get().isOn === true && window.__LINKCTL.get().stale === false`));
  ok('status line shows the session again', await ev(`(() => { const el = document.getElementById('link-status'); return el && !el.hidden && el.textContent.includes('bpm'); })()`));

  direct.close();
} catch (err) {
  ok('link-net-smoke run completed', false, String((err && err.stack) || err));
} finally {
  if (chrome) chrome.kill('SIGKILL');
  bridge.kill('SIGKILL');
  proxy.close();
}

const pass = results.every((x) => x.pass);
console.log(pass ? 'LINK NET-SMOKE PASS' : 'LINK NET-SMOKE FAIL');
process.exit(pass ? 0 : 1);
