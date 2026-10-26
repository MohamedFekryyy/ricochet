import test from 'node:test';
import assert from 'node:assert/strict';
import { cellFromPoint, brushCells, makeTouchTracker } from '../src/grid.js';

test('maps points to cells, corners included', () => {
  assert.deepEqual(cellFromPoint(0, 0, 100, 100, 10, 10), { col: 0, row: 0 });
  assert.deepEqual(cellFromPoint(99.9, 99.9, 100, 100, 10, 10), { col: 9, row: 9 });
  assert.deepEqual(cellFromPoint(55, 24, 100, 100, 10, 10), { col: 5, row: 2 });
});

test('out-of-bounds points return null', () => {
  assert.equal(cellFromPoint(-1, 50, 100, 100, 10, 10), null);
  assert.equal(cellFromPoint(100, 50, 100, 100, 10, 10), null);
  assert.equal(cellFromPoint(50, 101, 100, 100, 10, 10), null);
});

test('brush size 1 covers only the touched cell, size 2 a 3x3 block', () => {
  assert.equal(brushCells({ col: 5, row: 5 }, 1, 10, 10).length, 1);
  assert.equal(brushCells({ col: 5, row: 5 }, 2, 10, 10).length, 9);
});

test('brush clips at grid edges', () => {
  assert.equal(brushCells({ col: 0, row: 0 }, 2, 10, 10).length, 4);
});

test('tracker always allows the first touch', () => {
  const t = makeTouchTracker(100);
  assert.equal(t.allow(10, 10), true);
});

test('high sensitivity blocks small movements, then allows real travel', () => {
  const t = makeTouchTracker(100); // 48px minimum travel
  t.allow(0, 0);
  assert.equal(t.allow(5, 5), false);
  assert.equal(t.allow(60, 0), true);
});

test('zero sensitivity never gates', () => {
  const t = makeTouchTracker(0);
  t.allow(0, 0);
  assert.equal(t.allow(0.1, 0.1), true);
});

test('reset clears the gate', () => {
  const t = makeTouchTracker(100);
  t.allow(0, 0);
  t.reset();
  assert.equal(t.allow(1, 1), true);
});
