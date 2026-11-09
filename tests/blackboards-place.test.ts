// Blackboards placement: new windows fill their zone's row without covering
// anything, the zone grows to hold them, a move onto a window is nudged.
import { expect, test } from "bun:test";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import { GAP, GRID, PAD, ROW_MAX, TOP, belowZones, grown, inZone, nearestFree, overlaps, slotIn, snapUp, zoneOf } from "../plugins/blackboards/web/place.js";

type R = { id?: string; x: number; y: number; w: number; h: number };
const note = { w: 440, h: 520 };
const noOverlap = (ws: R[]) => { for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) expect(overlaps(ws[i], ws[j])).toBe(false); };
const onGrid = (p: { x: number; y: number }) => { expect(p.x % GRID).toBe(0); expect(p.y % GRID).toBe(0); };

test("three notes into an empty zone: one row, left to right, no overlap, zone grows", () => {
  let z = { id: "z1", title: "Work", x: 0, y: 0, w: 960, h: 720 };
  const ws: R[] = [];
  for (let i = 0; i < 3; i++) {
    const p = slotIn(z, ws, note, [z]); onGrid(p);
    const w = { id: `w${i}`, ...p, ...note }; ws.push(w); z = grown(z, w);
    expect(inZone(z, w)).toBe(true);
  }
  expect(ws.map(w => w.y)).toEqual([TOP, TOP, TOP]);
  expect(ws[0].x).toBe(PAD);
  expect(ws[1].x).toBe(snapUp(ws[0].x + note.w + GAP));
  noOverlap(ws);
  expect(z.w).toBeGreaterThanOrEqual(ws[2].x + note.w + PAD);
  expect(z.h).toBe(720); // never shrinks, only grows as needed
});

test("a gap in the row is filled first; windows outside the zone are avoided too", () => {
  const z = { id: "z1", title: "Work", x: 0, y: 0, w: 2000, h: 720 };
  const step = snapUp(note.w + GAP);
  const ws: R[] = [{ x: PAD, y: TOP, ...note }, { x: PAD + 2 * step, y: TOP, ...note }];
  expect(slotIn(z, ws, note, [z])).toEqual({ x: PAD + step, y: TOP });
  const stray = { x: PAD + step + 100, y: TOP + 50, w: 200, h: 200 }; // a window on top of that gap
  const p = slotIn(z, [...ws, stray], note, [z]);
  noOverlap([...ws, stray, { ...p, ...note }]);
});

test("a row wraps below once it would pass ROW_MAX", () => {
  let z = { id: "z1", title: "Big", x: 0, y: 0, w: 960, h: 720 };
  const ws: R[] = [];
  for (let i = 0; i < 14; i++) { const p = slotIn(z, ws, note, [z]); const w = { ...p, ...note }; ws.push(w); z = grown(z, w); }
  noOverlap(ws);
  expect(Math.max(...ws.map(w => w.x + w.w))).toBeLessThanOrEqual(PAD + ROW_MAX);
  expect(new Set(ws.map(w => w.y)).size).toBe(2);
  for (const w of ws) expect(zoneOf([z], w)).toBe(z);
});

test("a zone with a neighbour to its right wraps down instead of growing into it", () => {
  const a = { id: "z1", title: "A", x: 0, y: 0, w: 1032, h: 720 }, b = { id: "z2", title: "B", x: 1080, y: 0, w: 960, h: 720 };
  const ws: R[] = [{ x: PAD, y: TOP, ...note }, { x: PAD + note.w + GAP, y: TOP, ...note }];
  const p = slotIn(a, ws, note, [a, b]);
  expect(p.x).toBe(PAD);
  expect(p.y).toBeGreaterThan(TOP);
  expect(overlaps(grown(a, { ...p, ...note }), b)).toBe(false);
});

test("Unsorted goes below all zones", () => {
  const r = belowZones([{ x: 48, y: 0, w: 960, h: 720 }, { x: 1200, y: 100, w: 500, h: 900 }] as any);
  expect(r.x).toBe(48); expect(r.y).toBeGreaterThanOrEqual(1000); onGrid(r);
  expect(belowZones([])).toEqual({ x: 0, y: 0, w: 960, h: 720 });
});

test("a move onto another window is nudged to the nearest free slot in the same zone", () => {
  const z = { id: "z1", title: "Work", x: 0, y: 0, w: 2400, h: 1200 };
  const other = { x: 480, y: 96, ...note };
  const want = { x: 528, y: 120, ...note };
  const p = nearestFree(want, [other], z)!;
  expect(p).not.toBeNull(); onGrid(p);
  expect(overlaps({ ...p, ...note }, other)).toBe(false);
  expect(inZone(z, { ...p, ...note })).toBe(true);
  // the nearest: no free slot closer to the wanted spot
  const d = Math.hypot(p.x - want.x, p.y - want.y);
  expect(d).toBeLessThanOrEqual(note.w + GAP + GRID);
  // a free spot stays where it is
  expect(nearestFree({ x: 1200, y: 600, ...note }, [other], z)).toEqual({ x: 1200, y: 600 });
});
