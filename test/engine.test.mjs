import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, createBounceState, bounceStep, setCorners, setSpeed, setAmount, speedToPx,
} from '../src/engine.js';
import { ballSpeed, wallDistance } from '../src/physics.js';

const make = (over = {}) => createBounceState({ width: 390, height: 700, ...over });

test('spawns the requested number of balls at the polygon center', () => {
  const st = make({ amount: 3 });
  assert.equal(st.balls.length, 3);
  for (const b of st.balls) {
    assert.ok(Math.hypot(b.x - st.polygon.center.x, b.y - st.polygon.center.y) < 1);
    assert.ok(Math.abs(ballSpeed(b) - speedToPx(st.speed)) < 1e-9);
  }
});

test('produces hit events with finite positive frequencies', () => {
  const st = make({ amount: 3 });
  let hits = 0;
  for (let i = 0; i < 600; i++) {
    for (const ev of bounceStep(st, 1 / 60)) {
      hits += 1;
      assert.ok(Number.isFinite(ev.freq) && ev.freq > 0);
      assert.ok(ev.edge >= 0 && ev.edge < st.sides);
    }
  }
  assert.ok(hits > 10, `expected a lively 10 seconds, got ${hits} hits`);
});

test('setCorners rebuilds the polygon and keeps balls inside', () => {
  const st = make({ sides: 9, amount: 3 });
  for (let i = 0; i < 240; i++) bounceStep(st, 1 / 60); // scatter the balls
  setCorners(st, 3);
  assert.equal(st.sides, 3);
  assert.equal(st.polygon.edges.length, 3);
  for (const b of st.balls) {
    for (const e of st.polygon.edges) {
      assert.ok(wallDistance(e, b.x, b.y) >= b.r - 1e-6, 'ball left outside new wall');
    }
  }
});

test('setAmount grows and shrinks the ball set within limits', () => {
  const st = make({ amount: 1 });
  setAmount(st, 3);
  assert.equal(st.balls.length, 3);
  setAmount(st, 1);
  assert.equal(st.balls.length, 1);
  setAmount(st, 99);
  assert.equal(st.balls.length, LIMITS.amount[1]);
});

test('setSpeed rescales every live ball', () => {
  const st = make({ amount: 2, speed: 10 });
  for (let i = 0; i < 120; i++) bounceStep(st, 1 / 60);
  setSpeed(st, 40);
  for (const b of st.balls) {
    assert.ok(Math.abs(ballSpeed(b) - speedToPx(40)) < 1e-9);
  }
});

test('control values are clamped to their limits', () => {
  const st = make({ sides: 99, speed: 0 });
  assert.equal(st.sides, LIMITS.corners[1]);
  assert.equal(st.speed, LIMITS.speed[0]);
});
