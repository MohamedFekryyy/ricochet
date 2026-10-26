// Pure touch-grid logic: pointer position -> cells -> gated note triggers.

export function cellFromPoint(x, y, width, height, cols, rows) {
  const col = Math.floor((x / width) * cols);
  const row = Math.floor((y / height) * rows);
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  return { col, row };
}

// size is the brush radius in cells: 1 = the touched cell only.
export function brushCells(center, size, cols, rows) {
  const reach = Math.max(0, Math.round(size) - 1);
  const cells = [];
  for (let dr = -reach; dr <= reach; dr++) {
    for (let dc = -reach; dc <= reach; dc++) {
      const row = center.row + dr;
      const col = center.col + dc;
      if (row >= 0 && row < rows && col >= 0 && col < cols) cells.push({ col, row });
    }
  }
  return cells;
}

// Gates how freely dragging retriggers notes. sensitivity 0..100 maps to a
// minimum pointer travel (0..48px) from the last triggered point.
export function makeTouchTracker(sensitivity = 90) {
  let last = null;
  const minTravel = () => (Math.max(0, Math.min(100, sensitivity)) / 100) * 48;
  return {
    setSensitivity(v) { sensitivity = v; },
    reset() { last = null; },
    // Returns true when a trigger is allowed at (x, y).
    allow(x, y) {
      if (!last) { last = { x, y }; return true; }
      const d = Math.hypot(x - last.x, y - last.y);
      if (d >= minTravel()) { last = { x, y }; return true; }
      return false;
    },
  };
}
