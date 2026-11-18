// Games card set: table operations on stacks (pure, no page): a deck is 52
// cards without jokers, draws keep order, merges stay within one set, flips
// reverse and turn, gather rebuilds the full ordered deck at its home.
import { expect, test } from "bun:test";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as C from "../plugins/games/web/components/cards.js";

type Card = { c: string; up: boolean };
type Stack = { id: string; set: string; x: number; y: number; cards: Card[] };
type Table = { sets: { id: string; x: number; y: number }[]; objects: Stack[] };
const empty = (): Table => ({ sets: [], objects: [] });
const ids = (o: Stack) => o.cards.map(k => k.c).join(" ");
const find = (t: Table, id: string) => t.objects.find(o => o.id === id)!;

test("a fresh deck: 52 distinct cards, no jokers, face down, ace of spades on top", () => {
  const r = C.addDeck(empty(), 10, 20), o = find(r.state, r.stack);
  expect(o.cards.length).toBe(52);
  expect(new Set(o.cards.map((k: Card) => k.c)).size).toBe(52);
  expect(o.cards.every((k: Card) => !k.up && /^[A2-9TJQK][SHDC]$/.test(k.c))).toBe(true);
  expect(C.topCard(o).c).toBe("AS");
  expect([o.x, o.y, o.set]).toEqual([10, 20, r.set]);
});

test("take keeps order and set; refuses the last card", () => {
  let t = C.addDeck(empty()).state as Table;
  const r = C.take(t, "s1", 3, 200, 0); t = r.state;
  expect(find(t, "s1").cards.length).toBe(49);
  expect(ids(find(t, r.stack))).toBe("3S 2S AS");
  expect(find(t, r.stack).set).toBe("d1");
  const up = C.take(t, "s1", 1, 0, 0, true);
  expect(C.topCard(find(up.state, up.stack)).up).toBe(true);
  const one = C.take(t, r.stack, 2, 0, 0).state;
  expect(() => C.take(one, r.stack, 1)).toThrow();
});

test("merge within a set puts the dropped cards on top; another set is refused", () => {
  let t = C.addDeck(empty()).state as Table;
  t = C.addDeck(t, 300, 0).state;
  const a = C.take(t, "s1", 1, 100, 0); t = a.state;
  const m = C.merge(t, a.stack, "s1");
  expect(m.ok).toBe(true);
  expect(find(m.state, "s1").cards.length).toBe(52);
  expect(C.topCard(find(m.state, "s1")).c).toBe("AS");
  expect(m.state.objects.at(-1).id).toBe("s1");
  const x = C.merge(t, a.stack, "s2");
  expect(x.ok).toBe(false);
  expect(x.state).toBe(t);
});

test("flip reverses the order and turns every card; shuffle keeps the cards", () => {
  let t = C.addDeck(empty()).state as Table;
  const f = find(C.flipStack(t, "s1"), "s1");
  expect(C.topCard(f)).toEqual({ c: "KC", up: true });
  expect(f.cards[0]).toEqual({ c: "AS", up: true });
  let n = 0; const rnd = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
  const s = find(C.shuffleStack(t, "s1", rnd), "s1");
  expect(s.cards.map((k: Card) => k.c).sort()).toEqual(find(t, "s1").cards.map((k: Card) => k.c).sort());
  expect(ids(s)).not.toBe(ids(find(t, "s1")));
  const single = C.take(t, "s1", 1, 0, 0);
  expect(() => C.shuffleStack(single.state, single.stack)).toThrow();
});

test("gather: every card of the set into one full ordered face-down deck at home; other sets untouched", () => {
  let t = C.addDeck(empty(), 0, 0).state as Table;
  t = C.addDeck(t, 500, 0).state;
  t = C.moveTo(t, "s1", 40, 40);
  for (let i = 0; i < 4; i++) t = C.take(t, "s1", 2, 100 + i * 120, 300, true).state;
  t = C.flipStack(t, "s1");
  t = C.take(t, "s2", 5, 900, 900).state;
  const g = C.gather(t, "d1"), mine = g.state.objects.filter((o: Stack) => o.set === "d1");
  expect(mine.length).toBe(1);
  expect([mine[0].x, mine[0].y]).toEqual([0, 0]);
  expect(ids(mine[0])).toBe(ids(find(C.addDeck(empty()).state, "s1")));
  expect(mine[0].cards.every((k: Card) => !k.up)).toBe(true);
  expect(g.state.objects.filter((o: Stack) => o.set === "d2").map((o: Stack) => o.cards.length).sort()).toEqual([47, 5].sort());
});

test("parseCard and names", () => {
  expect(C.parseCard("10h")).toBe("TH");
  expect(C.parseCard("queen of spades")).toBe("QS");
  expect(C.parseCard("A♦")).toBe("AD");
  expect(C.parseCard("joker")).toBe("");
  expect(C.cardName("TH")).toBe("10♥");
  expect(C.cardLong("KC")).toBe("king of clubs");
});

test("describeStack hides face-down cards", () => {
  const t = C.addDeck(empty()).state as Table;
  expect(C.describeStack(find(t, "s1"))).toBe("s1 | set d1 | 52 cards, top face down | at 0 0");
  const f = C.flipStack(t, "s1");
  expect(C.describeStack(find(f, "s1"))).toContain("top K♣ face up");
});
