// Games tokens: table operations (pure, no page): a new token is a brown
// poop, shapes parse loosely and change in place, ids share the k counter
// with the dice, the edge is darker than the fill, and tokens are removable.
import { expect, test } from "bun:test";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as K from "../plugins/games/web/components/tokens.js";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as D from "../plugins/games/web/components/dice.js";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as Tb from "../plugins/games/web/components/table.js";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as C from "../plugins/games/web/components/colors.js";

const empty = () => ({ sets: [], objects: [] as any[] });

test("a token: a brown poop by default; shape, eyes, duplicate, describe", () => {
  const a = K.addToken(empty(), 100.4, 50);
  const o = a.state.objects[0];
  expect([o.id, o.kind, o.x, o.y, o.shape, o.color, o.eyes]).toEqual(["k1", "token", 100, 50, "poop", "#6b4423", false]);
  expect(K.describe(o)).toBe("k1 | poop | #6b4423 | at 100 50");
  const s = K.setShape(a.state, "k1", "Star");
  expect(s.objects[0].shape).toBe("star");
  expect(s.objects[0].color).toBe("#6b4423"); // the colour stays
  expect(() => K.setShape(a.state, "k1", "dragon")).toThrow();
  expect(K.setEyes(a.state, "k1", true).objects[0].eyes).toBe(true);
  const b = K.duplicate(K.setEyes(a.state, "k1", true), "k1"), d = b.state.objects.find((q: any) => q.id === b.id);
  expect([d.id, d.shape, d.color, d.eyes, d.x >= o.x + K.W]).toEqual(["k2", "poop", "#6b4423", true, true]);
  expect(a.state.objects[0].shape).toBe("poop"); // the input is untouched
});

test("shapes: menu order Poop first, aliases, each its own colour", () => {
  expect(K.SHAPES.map((S: any) => S.id)).toEqual(["poop", "disc", "cube", "star", "heart"]);
  expect(K.shapeOf("coin").id).toBe("disc");
  expect(K.shapeOf(" POO ").id).toBe("poop");
  expect(K.shapeOf("nope")).toBe(null);
  const c = K.addToken(empty(), 0, 0, "cube", "pink").state.objects[0];
  expect([c.shape, c.color]).toEqual(["cube", "#ff0088"]);
  expect(K.addToken(empty(), 0, 0, "star").state.objects[0].color).toBe("#fdd835");
  expect(() => K.addToken(empty(), 0, 0, "poop", "nope")).toThrow();
  expect(() => K.addToken(empty(), 0, 0, "dragon")).toThrow();
});

test("ids: dice and tokens share k1, k2... and never collide", () => {
  let st = D.addDie(empty(), 0, 0).state;          // k1
  st = K.addToken(st, 60, 0).state;                // k2
  st = D.addDie(st, 120, 0).state;                 // k3
  st = K.addToken(st, 180, 0, "heart").state;      // k4
  expect(st.objects.map((o: any) => `${o.id}:${o.kind}`)).toEqual(["k1:die", "k2:token", "k3:die", "k4:token"]);
});

test("edge: darker than the fill (reads on grey tiles); light on black", () => {
  const e = K.edge("#6b4423");
  expect(C.luminance(e)).toBeLessThan(C.luminance("#6b4423"));
  expect(C.luminance(K.edge("#9e9e9e"))).toBeLessThan(C.luminance("#9e9e9e") / 3);
  expect(K.edge("#000000")).toContain("255");
});

test("tokens recolour, and are removable like meeples", () => {
  let st = K.addToken(empty(), 0, 0).state;
  st = C.setColor(st, "k1", "blue");
  expect(st.objects[0].color).toBe("#1e88e5");
  expect(Tb.removable(st.objects[0])).toBe(true);
  expect(Tb.removePieces(st, ["k1"]).objects.length).toBe(0);
});
