// Pure 2D physics: balls bouncing inside a regular convex polygon.
// No DOM, no audio, no globals: safe to unit-test in Node.

export function polygonVertices(sides, cx, cy, radius, rotation = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i * 2 * Math.PI) / sides;
    pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  return pts;
}

function centroid(vertices) {
  let x = 0, y = 0;
  for (const p of vertices) { x += p.x; y += p.y; }
  return { x: x / vertices.length, y: y / vertices.length };
}

// A polygon with precomputed inward-pointing wall normals.
// edges[i] is the wall from vertices[i] to vertices[(i+1) % sides].
export function makePolygon(sides, cx, cy, radius, rotation) {
  const vertices = polygonVertices(sides, cx, cy, radius, rotation);
  const c = centroid(vertices);
  const edges = vertices.map((a, i) => {
    const b = vertices[(i + 1) % vertices.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    let nx = -ey, ny = ex;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    // Flip so the normal points toward the centroid (inward).
    if ((c.x - a.x) * nx + (c.y - a.y) * ny < 0) { nx = -nx; ny = -ny; }
    return { ax: a.x, ay: a.y, nx, ny };
  });
  return { sides, vertices, edges, center: c, radius };
}

// Signed distance from point to a wall line, positive toward the interior.
export function wallDistance(edge, x, y) {
  return (x - edge.ax) * edge.nx + (y - edge.ay) * edge.ny;
}

export function makeBall(x, y, vx, vy, r) {
  return { x, y, vx, vy, r };
}

export function ballSpeed(b) {
  return Math.hypot(b.vx, b.vy);
}

// Set an absolute speed (px/s), preserving direction. A resting ball
// gets pushed along +x; callers that want a direction set one first.
export function setBallSpeed(b, speed) {
  const s = ballSpeed(b);
  if (s === 0) { b.vx = speed; b.vy = 0; return b; }
  const k = speed / s;
  b.vx *= k; b.vy *= k;
  return b;
}

// Push a ball back inside the polygon if numeric drift or a shape change
// left it overlapping a wall.
export function projectInside(ball, poly) {
  for (let pass = 0; pass < 2; pass++) {
    for (const e of poly.edges) {
      const d = wallDistance(e, ball.x, ball.y);
      if (d < ball.r) {
        ball.x += e.nx * (ball.r - d);
        ball.y += e.ny * (ball.r - d);
      }
    }
  }
  return ball;
}

// Advance one ball by dt seconds. Returns the hit wall index, or null.
// Substeps prevent tunneling at high speed.
export function stepBall(ball, poly, dt) {
  const speed = ballSpeed(ball);
  const steps = Math.max(1, Math.ceil((speed * dt) / (ball.r * 0.5)));
  const h = dt / steps;
  let hit = null;
  for (let s = 0; s < steps; s++) {
    ball.x += ball.vx * h;
    ball.y += ball.vy * h;
    for (let i = 0; i < poly.edges.length; i++) {
      const e = poly.edges[i];
      const d = wallDistance(e, ball.x, ball.y);
      const outward = ball.vx * e.nx + ball.vy * e.ny < 0;
      if (d < ball.r && outward) {
        const vn = ball.vx * e.nx + ball.vy * e.ny;
        ball.vx -= 2 * vn * e.nx;
        ball.vy -= 2 * vn * e.ny;
        ball.x += e.nx * (ball.r - d);
        ball.y += e.ny * (ball.r - d);
        if (hit === null) hit = i;
      }
    }
  }
  return hit;
}
