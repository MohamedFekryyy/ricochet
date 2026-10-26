import test from 'node:test';
import assert from 'node:assert/strict';
import { midiToFreq, degreeFreq, wallFreq, gridFreq, SCALES, SCALE_NAMES } from '../src/notes.js';

test('A4 is 440 Hz', () => {
  assert.equal(midiToFreq(69), 440);
});

test('degree frequencies ascend through the scale and across octaves', () => {
  let prev = 0;
  for (let d = 0; d <= 2 * SCALES.pentatonic.length; d++) {
    const f = degreeFreq(60, 'pentatonic', d);
    assert.ok(f > prev, `degree ${d} must be higher than the previous`);
    prev = f;
  }
});

test('octave degree doubles the root frequency', () => {
  const root = degreeFreq(60, 'pentatonic', 0);
  const octave = degreeFreq(60, 'pentatonic', SCALES.pentatonic.length);
  assert.ok(Math.abs(octave / root - 2) < 1e-9);
});

test('higher wall index means higher pitch', () => {
  assert.ok(wallFreq(60, 'pentatonic', 6) > wallFreq(60, 'pentatonic', 2));
});

test('grid rows: top row is the highest pitch', () => {
  const top = gridFreq(60, 'pentatonic', 0, 10);
  const bottom = gridFreq(60, 'pentatonic', 9, 10);
  assert.ok(top > bottom);
});

test('all advertised scales resolve', () => {
  for (const name of SCALE_NAMES) {
    assert.ok(degreeFreq(60, name, 3) > 0);
  }
});

test('unknown scale throws', () => {
  assert.throws(() => degreeFreq(60, 'bluesy', 0));
});
