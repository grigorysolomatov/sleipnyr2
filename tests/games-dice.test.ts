// Games dice: table operations (pure, no page): a die starts on 1, rolls
// stay within its sides and count up, set value refuses other faces, the
// random face is uniform, and dice are removable like meeples.
import { expect, test } from "bun:test";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as D from "../plugins/games/web/components/dice.js";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as Tb from "../plugins/games/web/components/table.js";

const empty = () => ({ sets: [], objects: [] as any[] });

test("a die: white d6 showing 1; set value, duplicate, describe", () => {
  const a = D.addDie(empty(), 300.4, 200);
  const o = a.state.objects[0];
  expect([o.id, o.kind, o.x, o.y, o.sides, o.value, o.color, o.rolls]).toEqual(["k1", "die", 300, 200, 6, 1, "#ffffff", 0]);
  const s = D.setValue(a.state, "k1", 4);
  expect(D.describe(s.objects[0])).toBe("k1 | d6 | white | shows 4 | at 300 200");
  expect(() => D.setValue(a.state, "k1", 7)).toThrow();
  expect(() => D.setValue(a.state, "k1", 2.5)).toThrow();
  expect(() => D.addDie(empty(), 0, 0, "nope")).toThrow();
  expect(() => D.addDie(empty(), 0, 0, undefined, 1, 20)).toThrow(); // no d20 drawn yet
  const b = D.duplicate(s, "k1"), d = b.state.objects.find((q: any) => q.id === b.id);
  expect([d.id, d.value, d.color, d.x > o.x + D.W - 1]).toEqual(["k2", 4, "#ffffff", true]);
  expect(a.state.objects[0].value).toBe(1); // the input is untouched
});

test("roll: faces from rand, counted; only dice", () => {
  let st = D.addDie(empty(), 0, 0).state; st = D.addDie(st, 60, 0, "black").state;
  const r = D.roll(st, ["k1", "k2"], () => 5);
  expect(r.objects.map((o: any) => [o.value, o.rolls])).toEqual([[5, 1], [5, 1]]);
  expect(() => D.roll(st, ["m1"])).toThrow();
  expect(() => D.roll(st, ["k1"], () => 9)).toThrow();
});

test("randomFace: always 1..6 and roughly uniform", () => {
  const n = 60000, c = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) c[D.randomFace(6)]++;
  expect(c[0]).toBe(0);
  for (let f = 1; f <= 6; f++) expect(Math.abs(c[f] - n / 6)).toBeLessThan(n / 6 * 0.06);
});

test("pips: classic counts; contrast on light and dark dice; removable", () => {
  for (let v = 1; v <= 6; v++) expect(D.PIPS[v].length).toBe(v);
  expect(D.pipColor("#ffffff")).toBe("#161616");
  expect(D.pipColor("#000000")).toBe("#ffffff");
  expect(D.pipColor("#662288")).toBe("#ffffff");
  expect(D.pipColor("#fdd835")).toBe("#161616");
  const st = D.addDie(empty(), 0, 0).state;
  expect(Tb.removable(st.objects[0])).toBe(true);
  expect(Tb.removePieces(st, ["k1"]).objects).toEqual([]);
});
