// Games meeples and tiles: table operations (pure, no page): colours parse
// loosely, tiles snap to the grid and duplicate edge to edge, lock is kept.
import { expect, test } from "bun:test";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as M from "../plugins/games/web/components/meeples.js";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as T from "../plugins/games/web/components/tiles.js";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as C from "../plugins/games/web/components/colors.js";

const empty = () => ({ sets: [], objects: [] as any[] });

test("colours: names, short and long hex; junk refused", () => {
  expect(C.parseColor("pink")).toBe("#ff0088");
  expect(C.parseColor("Gray")).toBe("#9e9e9e");
  expect(C.parseColor("#abc")).toBe("#aabbcc");
  expect(C.parseColor("769656")).toBe("#769656");
  expect(C.parseColor("nope")).toBe("");
  expect(C.colorName("#FF0088")).toBe("pink");
});

test("a meeple gets the palette's first colour; duplicate goes beside it", () => {
  const a = M.addMeeple(empty(), 10, 20);
  const o = a.state.objects[0];
  expect([o.id, o.kind, o.x, o.y, o.color]).toEqual(["m1", "meeple", 10, 20, C.PALETTE[0].hex]);
  const b = M.duplicate(a.state, "m1");
  const d = b.state.objects.find((q: any) => q.id === b.id);
  expect(d.color).toBe(o.color);
  expect(d.x).toBeGreaterThan(o.x + M.W - 1);
  expect(() => M.addMeeple(empty(), 0, 0, "nope")).toThrow();
  expect(C.setColor(a.state, "m1", "blue").objects[0].color).toBe("#1e88e5");
});

test("tiles snap, resize within limits, duplicate into an edge-to-edge row", () => {
  let r = T.addTile(empty(), 13, 27, 104, 96, "light");
  let t = r.state.objects[0];
  expect([t.x, t.y, t.w, t.h, t.color, t.locked]).toEqual([10, 30, 100, 100, "#eeeed2", false]);
  r = T.duplicate(r.state, "t1"); r = T.duplicate(r.state, r.id);
  const row = r.state.objects.map((o: any) => [o.x, o.y]);
  expect(row).toEqual([[10, 30], [110, 30], [210, 30]]);
  const s = T.resize(r.state, "t2", 3, 99999);
  expect([s.objects[1].w, s.objects[1].h]).toEqual([T.MIN, T.MAX]);
  expect(T.setLocked(s, "t1", true).objects[0].locked).toBe(true);
  expect(() => T.resize(s, "m9", 10, 10)).toThrow();
  expect(T.describe(T.setLocked(s, "t1", true).objects[0])).toBe("t1 | light | 100 x 100 | at 10 30 | locked");
});
