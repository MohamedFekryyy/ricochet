// Sequencer engine: owns the polygon, the balls, and the hit events
// that become notes. Pure logic; rendering and audio live elsewhere.

import { makePolygon, makeBall, setBallSpeed, stepBall, projectInside } from './physics.js';
import { wallFreq } from './notes.js';

export const LIMITS = {
  corners: [3, 12],
  speed: [1, 60],   // px/s ball speed is scaled from this control value
  amount: [1, 3],
};

const SPEED_PX_PER_UNIT = 12;

function clamp(v, [lo, hi]) {
  return Math.min(hi, Math.max(lo, v));
}

export function speedToPx(value) {
  return value * SPEED_PX_PER_UNIT;
}

export function createBounceState({
  width,
  height,
  sides = 7,
  speed = 23,
  amount = 1,
  scale = 'pentatonic',
  rootMidi = 60,
} = {}) {
  const state = {
    width,
    height,
    sides: clamp(sides, LIMITS.corners),
    speed: clamp(speed, LIMITS.speed),
    scale,
    rootMidi,
    balls: [],
    polygon: null,
    ballRadius: Math.max(6, Math.min(width, height) * 0.018),
  };
  rebuildPolygon(state);
  setAmount(state, amount);
  return state;
}

export function rebuildPolygon(state) {
  const cx = state.width / 2;
  const cy = state.height * 0.47;
  const radius = Math.min(state.width, state.height) * 0.4;
  state.polygon = makePolygon(state.sides, cx, cy, radius);
  for (const b of state.balls) projectInside(b, state.polygon);
  return state;
}

export function spawnBall(state, angle) {
  const v = speedToPx(state.speed);
  const c = state.polygon.center;
  const ball = makeBall(c.x, c.y, v * Math.cos(angle), v * Math.sin(angle), state.ballRadius);
  state.balls.push(ball);
  return ball;
}

// Advance the simulation; returns hit events [{ edge, freq, ball }].
export function bounceStep(state, dt) {
  const events = [];
  for (const ball of state.balls) {
    const edge = stepBall(ball, state.polygon, dt);
    if (edge !== null) {
      events.push({ edge, ball, freq: wallFreq(state.rootMidi, state.scale, edge) });
    }
  }
  return events;
}

export function setCorners(state, sides) {
  state.sides = clamp(Math.round(sides), LIMITS.corners);
  rebuildPolygon(state);
  return state;
}

export function setSpeed(state, speed) {
  state.speed = clamp(speed, LIMITS.speed);
  for (const b of state.balls) setBallSpeed(b, speedToPx(state.speed));
  return state;
}

export function setAmount(state, amount) {
  const target = clamp(Math.round(amount), LIMITS.amount);
  while (state.balls.length < target) {
    spawnBall(state, 0.7 + (state.balls.length * 2 * Math.PI) / Math.max(1, target));
  }
  while (state.balls.length > target) state.balls.pop();
  return state;
}
