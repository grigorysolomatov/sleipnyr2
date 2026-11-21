// Games text decks (custom cards such as Events): pure table operations. A
// text set holds {title, text} cards numbered for good; its cards lie in
// ordinary stacks, so draw / merge / flip / gather follow the poker rules.
import { expect, test } from "bun:test";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as C from "../plugins/games/web/components/cards.js";
// @ts-ignore plain browser JavaScript, its pure helpers run here too
import * as T from "../plugins/games/web/components/textcards.js";

type K = { n: number; up: boolean };
type Stack = { id: string; kind: string; set: string; x: number; y: number; cards: K[] };
type Set = { id: string; kind: string; name?: string; x: number; y: number; cards?: { title: string; text: string }[] };
type Table = { sets: Set[]; objects: Stack[] };
const empty = (): Table => ({ sets: [], objects: [] });
const find = (t: Table, id: string) => t.objects.find(o => o.id === id)!;
const set = (t: Table, id: string) => t.sets.find(s => s.id === id)!;

test("a new text deck: named Events, no cards, an empty slot at its home", () => {
  const r = T.addTextDeck(empty(), 10.4, 20);
  expect(set(r.state, r.set)).toEqual({ id: "d1", kind: "text", name: "Events", x: 10, y: 20, cards: [] });
  expect(find(r.state, r.stack).cards).toEqual([]);
  expect(T.addTextDeck(empty(), 0, 0, "  Weather   cards ").state.sets[0].name).toBe("Weather cards");
});

test("add-card: numbered 1, 2, 3, face down at the bottom of the home stack; the slot is made again if gone", () => {
  let t: Table = T.addTextDeck(empty(), 0, 0).state;
  for (const [a, b] of [["Storm", "Lose a turn"], ["Gold", "Take 2\ncoins"], ["", "Only text"]]) t = T.addCard(t, "d1", a, b).state;
  const o = find(t, "s1");
  expect(o.cards).toEqual([{ n: 3, up: false }, { n: 2, up: false }, { n: 1, up: false }]);
  expect(C.topCard(o).n).toBe(1);
  expect(set(t, "d1").cards![1]).toEqual({ title: "Gold", text: "Take 2\ncoins" });
  // home stack moved away: the next card starts a new stack at home
  t = C.moveTo(t, "s1", 300, 300);
  const r = T.addCard(t, "d1", "Fog", "");
  expect(r.n).toBe(4);
  expect(find(r.state, r.stack)).toMatchObject({ x: 0, y: 0, cards: [{ n: 4, up: false }] });
  expect(() => T.addCard(t, "d1", " ", "")).toThrow();
  expect(() => T.addCard(t, "nope", "x", "")).toThrow();
});

test("edit-card and rename-set change only text; numbers stay; limits hold", () => {
  let t: Table = T.addTextDeck(empty(), 0, 0).state;
  t = T.addCard(t, "d1", "A", "a").state; t = T.addCard(t, "d1", "B", "b").state;
  t = T.editCard(t, "d1", 2, "Bee", "x".repeat(2000));
  expect(set(t, "d1").cards![1].title).toBe("Bee");
  expect(set(t, "d1").cards![1].text.length).toBe(T.MAX_TEXT);
  expect(() => T.editCard(t, "d1", 3, "C", "")).toThrow();
  t = T.renameSet(t, "d1", "Omens");
  expect(set(t, "d1").name).toBe("Omens");
  expect(() => T.renameSet(t, "d1", "  ")).toThrow();
});

test("draw, flip, shuffle and gather work on text stacks; gather = full deck, card 1 on top, face down", () => {
  let t: Table = T.addTextDeck(empty(), 0, 0).state;
  for (const a of ["A", "B", "C"]) t = T.addCard(t, "d1", a, "").state;
  const d = C.take(t, "s1", 1, 200, 0, true); t = d.state;
  expect(find(t, d.stack).cards).toEqual([{ n: 1, up: true }]);
  t = C.flipStack(t, "s1");
  expect(find(t, "s1").cards).toEqual([{ n: 2, up: true }, { n: 3, up: true }]);
  t = C.shuffleStack(t, "s1", () => 0);
  const g = C.gather(t, "d1", T.freshCards);
  expect(g.state.objects.filter((o: Stack) => o.set === "d1").length).toBe(1);
  expect(find(g.state, g.stack)).toMatchObject({ x: 0, y: 0, cards: [{ n: 3, up: false }, { n: 2, up: false }, { n: 1, up: false }] });
  // a deck with no cards gathers to its empty slot
  const e = T.addTextDeck(empty(), 5, 5).state;
  expect(find(C.gather(e, "d1", T.freshCards).state, "s1").cards).toEqual([]);
});

test("text cards never merge with a poker deck or another text deck; within the set they do", () => {
  let t: Table = C.addDeck(empty(), 0, 0).state; // d1 / s1 poker
  t = T.addTextDeck(t, 200, 0).state;             // d2 / s2
  t = T.addCard(t, "d2", "A", "").state; t = T.addCard(t, "d2", "B", "").state;
  t = T.addTextDeck(t, 400, 0, "Other").state;    // d3 / s3
  t = T.addCard(t, "d3", "Z", "").state;
  expect(C.merge(t, "s2", "s1").ok).toBe(false);
  expect(C.merge(t, "s3", "s2").ok).toBe(false);
  const d = C.take(t, "s2", 1, 600, 0);
  expect(C.merge(d.state, d.stack, "s2").ok).toBe(true);
});

test("agent listing: face-down text is never shown; face-up shows n: title; author view only via listCards", () => {
  let t: Table = T.addTextDeck(empty(), 0, 0).state;
  t = T.addCard(t, "d1", "Secret storm", "Hidden rule").state; t = T.addCard(t, "d1", "Gold rush", "Take 2").state;
  const s = set(t, "d1"), o = find(t, "s1");
  const down = T.describeStack(o, s);
  expect(down).not.toContain("Secret"); expect(down).not.toContain("Gold");
  expect(down).toContain("2 cards");
  const up = T.describeStack({ ...o, cards: [{ n: 2, up: false }, { n: 1, up: true }] }, s);
  expect(up).toContain('1: "Secret storm"'); expect(up).not.toContain("Gold");
  expect(T.describeSet(s, t.objects)).toContain("2 cards (numbers 1-2)");
  expect(T.describeSet(s, t.objects)).not.toContain("Secret");
  expect(T.listCards(s)).toContain("2: Gold rush | Take 2");
  expect(T.describeStack(find(T.addTextDeck(empty(), 0, 0).state, "s1"), { id: "d1", name: "Events" })).toContain("empty slot");
});
