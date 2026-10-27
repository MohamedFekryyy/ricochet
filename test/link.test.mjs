import test from 'node:test';
import assert from 'node:assert/strict';
import { nextGridBeat, GRID_SUBDIVISION } from '../src/link.js';

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
