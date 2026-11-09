// Blackboards placement: where a new or moved window goes so that it never
// covers another one. Pure geometry on board units (no DOM), shared by the
// board (blackboards.js) and its tests.
//   rect  {x, y, w, h}   zone  {id, title, x, y, w, h}   window  rect + id
// A window belongs to the zone holding its centre (as on the board).
export const GRID = 24, GAP = 24;
// inside a zone: side padding, room for its title at the top, the widest row
export const PAD = GRID * 2, TOP = GRID * 3, ROW_MAX = 4800;
export const snap = v => Math.round(v / GRID) * GRID;
export const snapUp = v => Math.ceil(v / GRID) * GRID;

/** Do two rects overlap (closer than `gap` counts as overlapping)? */
export function overlaps(a, b, gap = 0) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}
/** Does the zone hold the rect's centre? (a folded window counts by its title bar) */
export function inZone(z, w) {
  const cx = w.x + w.w / 2, cy = w.y + (w.collapsed ? 20 : w.h / 2);
  return cx >= z.x && cx < z.x + z.w && cy >= z.y && cy < z.y + z.h;
}
export const zoneOf = (zones, w) => zones.find(z => inZone(z, w)) || null;
const free = (c, wins, gap) => !wins.some(w => overlaps(c, w, gap));

/**
 * The first free grid slot for a window of `size` {w, h} in zone `z`, in
 * reading order: rows from the zone's top left, each row filled to the right
 * (the zone grows right) up to ROW_MAX wide, then the next row down. Never
 * covers any of `wins` (a GAP stays between windows) and, where possible,
 * keeps the grown zone off the `zones` around it.
 */
export function slotIn(z, wins, size, zones = []) {
  const x0 = snap(z.x + PAD), y0 = snap(z.y + TOP);
  const members = wins.filter(w => inZone(z, w));
  const ys = [...new Set([y0, ...members.map(m => snapUp(m.y + m.h + GAP))])].filter(y => y >= y0).sort((a, b) => a - b);
  const xs = [...new Set([x0, ...members.map(m => snapUp(m.x + m.w + GAP))])].filter(x => x >= x0).sort((a, b) => a - b);
  const limit = x0 + Math.max(ROW_MAX, z.w - 2 * PAD);
  const others = zones.filter(q => q !== z && q.id !== z.id);
  const clear = c => { const g = grown(z, c); return !others.some(q => overlaps(g, q)); };
  for (const keepOff of [true, false])
    for (const y of ys) for (const x of xs) {
      const c = { x, y, w: size.w, h: size.h };
      if (x > x0 && x + size.w > limit) continue;
      if (free(c, wins, GAP) && (!keepOff || clear(c))) return { x, y };
    }
  // below everything in the zone's first column: always free
  const col = wins.filter(w => w.x < x0 + size.w + GAP && w.x + w.w + GAP > x0);
  return { x: x0, y: snapUp(Math.max(y0, ...col.map(w => w.y + w.h + GAP))) };
}
/** The zone after growing (never shrinking) to hold rect r with padding. */
export function grown(z, r) {
  return { ...z, w: Math.max(z.w, snapUp(r.x + r.w + PAD - z.x)), h: Math.max(z.h, snapUp(r.y + r.h + PAD - z.y)) };
}
/** Where a new "Unsorted" zone goes: below all zones, left-aligned with them. */
export function belowZones(zones, w = 960, h = 720) {
  if (!zones.length) return { x: 0, y: 0, w, h };
  return { x: snap(Math.min(...zones.map(z => z.x))), y: snapUp(Math.max(...zones.map(z => z.y + z.h)) + GAP * 2), w, h };
}

// grid offsets around a point, nearest first (computed once)
const RING = 40;
const OFFS = (() => {
  const o = [];
  for (let i = -RING; i <= RING; i++) for (let j = -RING; j <= RING; j++) o.push([i * GRID, j * GRID]);
  return o.sort((a, b) => Math.hypot(...a) - Math.hypot(...b) || a[1] - b[1] || a[0] - b[0]);
})();
/**
 * The free grid slot nearest to rect r (a GAP clear of every window in
 * `wins`); inside zone `z` when given (the window's centre stays in it).
 * null when nothing within RING grid steps is free.
 */
export function nearestFree(r, wins, z = null) {
  const x0 = snap(r.x), y0 = snap(r.y);
  for (const [dx, dy] of OFFS) {
    const c = { x: x0 + dx, y: y0 + dy, w: r.w, h: r.h };
    if (z && !inZone(z, c)) continue;
    if (free(c, wins, GAP)) return { x: c.x, y: c.y };
  }
  return null;
}
