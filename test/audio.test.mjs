import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPluck, scheduleVoice, VOICES } from '../src/audio.js';

test('advertised voices are the five observed sound choices', () => {
  assert.deepEqual(VOICES, ['bell', 'marimba', 'pluck', 'synth', 'chiptune']);
});

test('pluck renders the requested length', () => {
  const buf = renderPluck(440, 8000, 0.5);
  assert.equal(buf.length, 4000);
});

test('pluck is deterministic for a given seed', () => {
  const a = renderPluck(440, 8000, 0.2, 42);
  const b = renderPluck(440, 8000, 0.2, 42);
  assert.deepEqual([...a], [...b]);
});

test('pluck sounds and decays like a string', () => {
  const buf = renderPluck(440, 16000, 1.0);
  const energy = (from, to) => {
    let e = 0;
    for (let i = from; i < to; i++) e += buf[i] * buf[i];
    return e;
  };
  const early = energy(0, 1000);
  const late = energy(buf.length - 1000, buf.length);
  assert.ok(early > 0.01, 'must be audible at the start');
  assert.ok(late < early * 0.2, 'must decay toward silence');
  let peak = 0;
  for (const s of buf) peak = Math.max(peak, Math.abs(s));
  assert.ok(peak <= 1, 'never clips');
});

test('unknown voice throws before touching the audio context', () => {
  assert.throws(() => scheduleVoice({}, null, 'kazoo', 440));
});
