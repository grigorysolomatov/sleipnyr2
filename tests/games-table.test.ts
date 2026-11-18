// Games table edits (pure, no page): removing pieces keeps locked tiles and
// cards; the undo history steps back and forth and joins quick nudges.
import { expect, test } from "bun:test";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as Tb from "../plugins/games/web/components/table.js";

const st = () => ({ sets: [], objects: [
  { id: "m1", kind: "meeple", x: 0, y: 0, color: "#ff0088" },
  { id: "t1", kind: "tile", x: 0, y: 0, w: 100, h: 100, color: "#9e9e9e", locked: false },
  { id: "t2", kind: "tile", x: 100, y: 0, w: 100, h: 100, color: "#9e9e9e", locked: true },
  { id: "s1", kind: "stack", set: "p1", x: 0, y: 0, cards: [] },
] as any[] });

test("remove: meeples and unlocked tiles go, locked tiles and stacks stay", () => {
  const a = st(), b = Tb.removePieces(a, ["m1", "t1", "t2", "s1"]);
  expect(b.objects.map((o: any) => o.id)).toEqual(["t2", "s1"]);
  expect(a.objects.length).toBe(4); // the input is untouched
});

test("history: undo, redo, a new change drops the redo", () => {
  const H = Tb.history(3);
  H.reset("A"); H.record("B"); H.record("C");
  expect(H.undo(null)).toBe("B"); expect(H.undo(null)).toBe("A"); expect(H.undo(null)).toBe(null);
  expect(H.redo(null)).toBe("B");
  H.record("D"); expect(H.canRedo()).toBe(false); expect(H.undo(null)).toBe("B");
});

test("history: limit, unchanged states and joined nudges", () => {
  const H = Tb.history(2);
  H.reset("0"); H.record("1"); H.record("2"); H.record("3");
  expect(H.size()).toBe(2);
  expect(H.record("3")).toBe(false);
  const N = Tb.history();
  N.reset("a"); N.record("b", "nudge", 1000); N.record("c", "nudge", 1500); N.record("d", "nudge", 1900);
  expect(N.size()).toBe(1); expect(N.undo(null)).toBe("a");
  N.record("e", "nudge", 1000); N.record("f", "nudge", 5000);
  expect(N.size()).toBe(2);
});
