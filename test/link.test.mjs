import test from 'node:test';
import assert from 'node:assert/strict';
import { nextGridBeat, GRID_SUBDIVISION, OffsetEstimator } from '../src/link.js';

test('a hit exactly on the grid stays on the grid', () => {
  assert.equal(nextGridBeat(0), 0);
  assert.equal(nextGridBeat(0.25), 0.25);
  assert.equal(nextGridBeat(4), 4);
});

test('a hit between grid points moves to the next 16th', () => {
  assert.ok(Math.abs(nextGridBeat(0.1) - 0.25) < 1e-9);
  assert.ok(Math.abs(nextGridBeat(0.26) - 0.5) < 1e-9);
  assert.ok(Math.abs(nextGridBeat(1.749999) - 1.75) < 1e-6);
  assert.ok(Math.abs(nextGridBeat(-0.1) - 0) < 1e-9);
});

test('quantized delay is never more than one subdivision', () => {
  for (let b = -2; b < 8; b += 0.0137) {
    const d = nextGridBeat(b) - b;
    assert.ok(d >= -1e-9 && d <= GRID_SUBDIVISION + 1e-9, `beat ${b} delay ${d}`);
  }
});

test('offset estimator recovers the true offset under symmetric delay', () => {
  const est = new OffsetEstimator();
  // client clock = server clock + 5000ms; network adds 30ms each way
  for (let i = 0; i < 5; i++) {
    const sentAt = 1000 + i * 1000; // client time
    const serverTs = sentAt + 30 + 5000; // server stamps on receipt
    const receivedAt = sentAt + 60; // reply takes another 30ms
    est.addSample(sentAt, serverTs, receivedAt);
  }
  assert.ok(Math.abs(est.offset - 5000) < 1e-9, `offset ${est.offset}`);
});

test('min-RTT selection tolerates jitter and asymmetric spikes', () => {
  const est = new OffsetEstimator();
  const trueOffset = 5000;
  // mostly 30ms symmetric, with two bad spikes
  const delays = [[30, 30], [150, 40], [30, 90], [25, 25], [200, 200]];
  let t = 1000;
  for (const [up, down] of delays) {
    const serverTs = t + up + trueOffset;
    est.addSample(t, serverTs, t + up + down);
    t += 1000;
  }
  // best sample is [25,25]: midpoint error 0
  assert.ok(Math.abs(est.offset - trueOffset) <= 5, `offset ${est.offset}`);
  assert.equal(est.bestRtt, 50);
});

test('offset is null before any sample', () => {
  assert.equal(new OffsetEstimator().offset, null);
});

test('estimator window forgets stale samples', () => {
  const est = new OffsetEstimator(3);
  // three samples at offset 100 with big rtt
  for (let i = 0; i < 3; i++) est.addSample(i * 1000, i * 1000 + 500 + 100, i * 1000 + 1000);
  // then a good sample at the true offset 0
  est.addSample(10000, 10010, 10020);
  assert.ok(Math.abs(est.offset - 0) < 1e-9, `offset ${est.offset}`);
});

test('quantizeAt books a future hit onto the beat grid', async () => {
  const { LinkSync } = await import('../src/link.js');
  const l = new LinkSync({});
  // 120 bpm = 2 beats/s; receipt-anchored timeline (no pong samples).
  l.state = { bpm: 120, beat: 4, ts: 0, phase: 0, quantum: 4, peers: 0, playing: true };
  l.recvPerf = performance.now();
  const ctx = { currentTime: 10 };
  const q = l.quantizeAt(ctx, 10.5);
  // beat at ctx time 10.5 is beatNow + 1.0; the booking must land on a
  // 16th boundary no earlier than that beat.
  assert.ok(q.when >= 10.5 - 1e-9, `when ${q.when}`);
  assert.ok(Math.abs(q.gridBeat / GRID_SUBDIVISION - Math.round(q.gridBeat / GRID_SUBDIVISION)) < 1e-9);
  const beatNow = l.currentBeat();
  const beatAt = beatNow + (10.5 - ctx.currentTime) * 2;
  assert.ok(q.gridBeat >= beatAt - 1e-9);
  assert.ok(q.gridBeat - beatAt <= GRID_SUBDIVISION + 1e-9);
});

test('quantizeAt honours the selected grid subdivision', async () => {
  const { LinkSync } = await import('../src/link.js');
  const l = new LinkSync({});
  l.state = { bpm: 120, beat: 4, ts: 0, phase: 0, quantum: 4, peers: 0, playing: true };
  l.recvPerf = performance.now();
  const ctx = { currentTime: 10 };
  const beatNow = l.currentBeat();
  const beatAt = beatNow + (10.5 - ctx.currentTime) * 2;
  for (const sub of [0.25, 0.5, 1]) {
    const q = l.quantizeAt(ctx, 10.5, performance.now(), sub);
    assert.ok(Math.abs(q.gridBeat / sub - Math.round(q.gridBeat / sub)) < 1e-9, `grid ${q.gridBeat} sub ${sub}`);
    assert.ok(q.gridBeat >= beatAt - 1e-9);
    assert.ok(q.gridBeat - beatAt <= sub + 1e-9, `delay ${q.gridBeat - beatAt} sub ${sub}`);
  }
  // a coarser grid books strictly further out (or equal) than a finer one
  const fine = l.quantizeAt(ctx, 10.5, performance.now(), 0.25);
  const coarse = l.quantizeAt(ctx, 10.5, performance.now(), 1);
  assert.ok(coarse.gridBeat >= fine.gridBeat - 1e-9);
});

test('quantizeAt is null without a live timeline', async () => {
  const { LinkSync } = await import('../src/link.js');
  const l = new LinkSync({});
  assert.equal(l.quantizeAt({ currentTime: 1 }, 2), null);
  l.state = { bpm: 120, beat: 4, ts: 0, phase: 0, quantum: 4, peers: 0, playing: true };
  l.stale = true;
  assert.equal(l.quantizeAt({ currentTime: 1 }, 2), null);
});
