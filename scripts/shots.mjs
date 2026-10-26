// Phone-sized screenshots over CDP: loads the built app in headless
// Chrome, lets it run for real seconds, captures PNGs to
// docs/screenshots/. Run after `npm run build`.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

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
  `--remote-debugging-port=${dbgPort}`,
  '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${dbgPort}/json/list`);
      const page = (await res.json()).find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up');
}
let idSeq = 0;
const pending = new Map();
const ws = new WebSocket(await targetWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const cdp = (method, params = {}) => {
  const id = ++idSeq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
};

try {
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  for (const [name, query, waitMs] of [['start', '', 1500], ['bounce', '?shot=bounce', 4000], ['grid', '?shot=grid', 2500]]) {
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/${query}` });
    await sleep(waitMs);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`docs/screenshots/${name}.png`, Buffer.from(shot.result.data, 'base64'));
    console.log(`wrote docs/screenshots/${name}.png`);
  }
} finally {
  proc.kill('SIGKILL');
  server.close();
}
