import test from 'node:test';
import assert from 'node:assert/strict';
import {
  polygonVertices, makePolygon, makeBall, stepBall,
  setBallSpeed, ballSpeed, wallDistance, projectInside,
} from '../src/physics.js';

test('polygon has the requested number of vertices', () => {
  assert.equal(polygonVertices(7, 0, 0, 100).length, 7);
  assert.equal(polygonVertices(3, 0, 0, 100).length, 3);
});

test('wall normals point inward toward the centroid', () => {
  const p = makePolygon(6, 100, 100, 80);
  for (const e of p.edges) {
    const towardCenter = (p.center.x - e.ax) * e.nx + (p.center.y - e.ay) * e.ny;
    assert.ok(towardCenter > 0, 'normal must point at the centroid');
  }
});

test('ball aimed at a wall bounces back inside and reports the wall', () => {
  const poly = makePolygon(7, 200, 200, 120);
  const ball = makeBall(200, 200, 0, -150, 8);
  let hit = null;
  for (let i = 0; i < 600 && hit === null; i++) hit = stepBall(ball, poly, 1 / 60);
  assert.notEqual(hit, null);
  assert.ok(hit >= 0 && hit < 7);
  assert.ok(ball.vy > 0, 'vertical velocity reversed after hitting the top');
  // Inside the polygon means on the interior side of every wall line;
  // near a vertex the ball may legitimately sit within r of the next wall.
  for (const e of poly.edges) {
    assert.ok(wallDistance(e, ball.x, ball.y) >= -1e-6, 'ball outside a wall line');
  }
});

test('a long fast run never escapes the polygon', () => {
  const poly = makePolygon(5, 0, 0, 100);
  const ball = makeBall(0, 0, 173, -242, 6);
  const maxR = 100 + 6 * 1.5; // circumradius + slack for corner overlap
  for (let i = 0; i < 5000; i++) {
    stepBall(ball, poly, 1 / 60);
    const d = Math.hypot(ball.x - poly.center.x, ball.y - poly.center.y);
    assert.ok(d <= maxR, `ball escaped at step ${i}: ${d}`);
  }
});

test('setBallSpeed sets an absolute speed and preserves direction', () => {
  const b = makeBall(0, 0, 30, 40, 5); // speed 50
  setBallSpeed(b, 100);
  assert.ok(Math.abs(ballSpeed(b) - 100) < 1e-9);
  assert.ok(b.vx > 0 && b.vy > 0, 'direction preserved');
});

test('projectInside pushes an overlapping ball back in', () => {
  const poly = makePolygon(6, 0, 0, 100);
  const v0 = poly.vertices[0];
  const v1 = poly.vertices[1];
  const mid = { x: (v0.x + v1.x) / 2, y: (v0.y + v1.y) / 2 };
  const n = poly.edges[0];
  // 2px beyond the wall, away from corners
  const ball = makeBall(mid.x - n.nx * 2, mid.y - n.ny * 2, 0, 0, 8);
  projectInside(ball, poly);
  for (const e of poly.edges) {
    assert.ok(wallDistance(e, ball.x, ball.y) >= ball.r - 1e-6);
  }
});
