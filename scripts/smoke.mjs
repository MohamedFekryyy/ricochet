// Functional smoke test over the Chrome DevTools Protocol (no deps;
// Node's built-in WebSocket). Builds the single-file app, serves it,
// loads it in headless Chrome with ?smoke=1, polls window.__SMOKE until
// the app's self-test (engine events, live audio-chain voice renders
// measured on an analyser, synthetic grid drag, live bounce loop)
// finishes, and asserts PASS.
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

async function targetWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${dbgPort}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome devtools endpoint never came up');
}

let idSeq = 0;
const pending = new Map();
const ws = new WebSocket(await targetWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function cdp(method, params = {}) {
  const id = ++idSeq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
}

let smoke = null;
try {
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/?smoke=1` });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(700);
    const r = await cdp('Runtime.evaluate', {
      expression: 'window.__SMOKE ? JSON.stringify(window.__SMOKE) : ""',
      returnByValue: true,
    });
    const val = r.result?.result?.value;
    if (val) { smoke = JSON.parse(val); break; }
  }
} finally {
  proc.kill('SIGKILL');
  server.close();
}

if (!smoke) {
  console.error('smoke test never completed in the page');
  process.exit(1);
}
for (const r of smoke.results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(smoke.pass ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(smoke.pass ? 0 : 1);
