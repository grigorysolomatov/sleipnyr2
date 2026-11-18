// Table component: a poker card set (52 cards, no jokers).
//
// Objects on the table are stacks: {id, kind: "stack", set, x, y, cards}.
// A single card is a stack of one, a deck a stack of many; cards[0] is the
// bottom card, the last one the top. Each card is {c, up}: c = rank + suit
// ("AS", "TH" = ten of hearts), up = face up. Every card belongs to the set
// (deck) it was spawned from: sets [{id, kind: "poker", x, y}] keep each
// deck's home, where Gather rebuilds it.
//
// The table operations below are pure (state in, changed state out, nothing
// drawn), so other components (boards, tokens) can sit beside them and the
// tests can run them without a page. render() draws one stack's top card.

export const KIND = "stack";
export const TITLE = "Poker deck";
export const RANKS = "A23456789TJQK";
export const SUITS = "SHDC";
export const W = 96, H = 134; // a card, in table px

const SUIT = {
  S: { name: "spades", tone: "blue", d: "M12 2.2s-8 6.4-8 11.1c0 2.8 2 4.6 4.4 4.6 1.4 0 2.6-.6 3.1-1.5-.2 2-1 3.6-2.5 4.6h6c-1.5-1-2.3-2.6-2.5-4.6.5.9 1.7 1.5 3.1 1.5 2.4 0 4.4-1.8 4.4-4.6 0-4.7-8-11.1-8-11.1z" },
  H: { name: "hearts", tone: "red", d: "M12 20.8s-7.4-4.5-9.4-9C1.1 8.4 3.1 4.6 6.8 4.6c2.1 0 3.6 1.1 5.2 3.1 1.6-2 3.1-3.1 5.2-3.1 3.7 0 5.7 3.8 4.2 7.2-2 4.5-9.4 9-9.4 9z" },
  D: { name: "diamonds", tone: "red", d: "M12 2.2l7.6 9.8L12 21.8 4.4 12z" },
  C: { name: "clubs", tone: "blue", d: "M12 2.6a4 4 0 0 0-3.6 5.7 4 4 0 1 0 2.3 6.6c-.3 2.2-1.2 4.2-2.6 5.4h7.8c-1.4-1.2-2.3-3.2-2.6-5.4a4 4 0 1 0 2.3-6.6A4 4 0 0 0 12 2.6z" },
};
const RANK_NAME = { A: "ace", T: "10", J: "jack", Q: "queen", K: "king" };

export const rankLabel = r => (r === "T" ? "10" : r);
export const suitOf = c => SUIT[c[1]];
/** "A♠"-style short name and "ace of spades" long name of a card code. */
export const cardName = c => `${rankLabel(c[0])}${{ S: "♠", H: "♥", D: "♦", C: "♣" }[c[1]]}`;
export const cardLong = c => `${RANK_NAME[c[0]] || c[0]} of ${SUIT[c[1]].name}`;

/** The 52 cards in order (spades, hearts, diamonds, clubs; ace to king), face down, the first on top. */
export function freshCards() {
  const out = [];
  for (const s of SUITS) for (const r of RANKS) out.push({ c: r + s, up: false });
  return out.reverse();
}
/** A card code from loose words: "AS", "10h", "queen of hearts", "Q♥". */
export function parseCard(t) {
  const s = String(t || "").trim().toUpperCase().replace("♠", "S").replace("♥", "H").replace("♦", "D").replace("♣", "C");
  const m = s.match(/^(10|[A2-9TJQK])\s*([SHDC])$/);
  if (m) return (m[1] === "10" ? "T" : m[1]) + m[2];
  const w = s.toLowerCase().match(/^(ace|king|queen|jack|10|[2-9])\s+of\s+(spades|hearts|diamonds|clubs)$/);
  if (!w) return "";
  const r = { ace: "A", king: "K", queen: "Q", jack: "J", 10: "T" }[w[1]] || w[1];
  return r + w[2][0].toUpperCase();
}

const clone = o => JSON.parse(JSON.stringify(o));
export const nextId = (pre, list) => pre + (Math.max(0, ...list.map(x => Number(String(x.id).slice(pre.length)) || 0)) + 1);
export const stacks = st => (st.objects || []).filter(o => o.kind === KIND);
export const topCard = o => o.cards[o.cards.length - 1];

/** Fisher-Yates over a copy. */
export function shuffled(cards, rnd = Math.random) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/** Turning a stack over (like lifting it and flipping it): the order reverses and every card turns. */
export const flipped = cards => cards.slice().reverse().map(k => ({ ...k, up: !k.up }));

// ---------------------------------------------------------------- table operations (pure)

/** A new full face-down deck at (x, y): a new set and its stack. */
export function addDeck(st, x = 0, y = 0) {
  const s = clone(st); s.sets ||= []; s.objects ||= [];
  const set = { id: nextId("d", s.sets), kind: "poker", x: Math.round(x), y: Math.round(y) };
  const o = { id: nextId("s", s.objects), kind: KIND, set: set.id, x: set.x, y: set.y, cards: freshCards() };
  s.sets.push(set); s.objects.push(o);
  return { state: s, set: set.id, stack: o.id };
}
/** Take n cards off the top of a stack into a new stack at (x, y); the taken
 *  cards keep their order (the top card stays on top). up: true/false forces their face. */
export function take(st, id, n = 1, x, y, up) {
  const s = clone(st), o = s.objects.find(q => q.id === id);
  if (!o || o.kind !== KIND) throw new Error(`no stack ${id}`);
  n = Math.max(1, Math.min(o.cards.length, Math.floor(n) || 1));
  if (n >= o.cards.length) throw new Error(`stack ${id} has only ${o.cards.length} card${o.cards.length === 1 ? "" : "s"}`);
  const cards = o.cards.splice(o.cards.length - n, n).map(k => (up === undefined ? k : { ...k, up }));
  const t = { id: nextId("s", s.objects), kind: KIND, set: o.set, x: Math.round(x ?? o.x), y: Math.round(y ?? o.y), cards };
  s.objects.push(t);
  return { state: s, stack: t.id };
}
/** Drop stack `from` onto stack `onto`: allowed within one set; the dropped cards go on top. */
export function merge(st, from, onto) {
  const s = clone(st), a = s.objects.find(q => q.id === from), b = s.objects.find(q => q.id === onto);
  if (!a || !b || a === b) throw new Error("no such stacks");
  if (a.set !== b.set) return { state: st, ok: false };
  b.cards.push(...a.cards);
  s.objects = s.objects.filter(q => q !== a && q !== b).concat(b); // the merged stack on top of the table
  return { state: s, ok: true, stack: b.id };
}
export function shuffleStack(st, id, rnd = Math.random) {
  const s = clone(st), o = s.objects.find(q => q.id === id);
  if (!o || o.kind !== KIND) throw new Error(`no stack ${id}`);
  if (o.cards.length < 2) throw new Error("one card cannot be shuffled");
  o.cards = shuffled(o.cards, rnd);
  return s;
}
export function flipStack(st, id) {
  const s = clone(st), o = s.objects.find(q => q.id === id);
  if (!o || o.kind !== KIND) throw new Error(`no stack ${id}`);
  o.cards = flipped(o.cards);
  return s;
}
/** Gather: every card of a set back into one full, ordered, face-down deck at the set's home. */
export function gather(st, setId) {
  const s = clone(st), set = (s.sets || []).find(q => q.id === setId);
  if (!set) throw new Error(`no set ${setId}`);
  const mine = s.objects.filter(q => q.kind === KIND && q.set === setId);
  const keep = mine.find(q => q.x === set.x && q.y === set.y) || mine[0];
  const o = keep ? { ...keep } : { id: nextId("s", s.objects), kind: KIND, set: setId };
  Object.assign(o, { x: set.x, y: set.y, cards: freshCards() });
  s.objects = s.objects.filter(q => !(q.kind === KIND && q.set === setId)).concat(o);
  return { state: s, stack: o.id, from: mine.length };
}
export function moveTo(st, id, x, y) {
  const s = clone(st), o = s.objects.find(q => q.id === id);
  if (!o) throw new Error(`no object ${id}`);
  o.x = Math.round(x); o.y = Math.round(y);
  s.objects = s.objects.filter(q => q !== o).concat(o);
  return s;
}
/** A free spot beside (x, y) for a new card: to the right first, then rows below. */
export function freeSpot(st, x, y, skip = "") {
  const busy = (px, py) => (st.objects || []).some(o => o.id !== skip && Math.abs(o.x - px) < W * 0.6 && Math.abs(o.y - py) < H * 0.6);
  for (let row = 0; row < 8; row++)
    for (let i = 1; i <= 8; i++) { const px = x + i * (W + 16), py = y + row * (H + 20); if (!busy(px, py)) return { x: px, y: py }; }
  return { x: x + W + 16, y };
}
/** One line per stack for the agent: id | set | count | top card | position. */
export function describeStack(o) {
  const t = topCard(o), n = o.cards.length, ups = o.cards.filter(k => k.up).length;
  const face = n === 1 ? (t.up ? `${cardName(t.c)} (${cardLong(t.c)}) face up` : "one card face down")
    : `${n} cards, top ${t.up ? `${cardName(t.c)} face up` : "face down"}${ups && ups < n ? ` (${ups} face up inside)` : ""}`;
  return `${o.id} | set ${o.set} | ${face} | at ${Math.round(o.x)} ${Math.round(o.y)}`;
}

// ---------------------------------------------------------------- drawing

const NS = "http://www.w3.org/2000/svg";
function suitSvg(s, cls) {
  const v = document.createElementNS(NS, "svg"); v.setAttribute("viewBox", "0 0 24 24"); v.setAttribute("class", cls); v.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path"); p.setAttribute("d", SUIT[s].d); v.append(p);
  return v;
}
function corner(c, cls) {
  const e = document.createElement("span"); e.className = `gm-corner ${cls}`;
  const b = document.createElement("b"); b.textContent = rankLabel(c[0]);
  e.append(b, suitSvg(c[1], "gm-pip"));
  return e;
}
/** One card's face (or back) as an element: CSS + inline SVG, no image files. */
export function renderCard(k) {
  const e = document.createElement("div");
  if (!k.up) { e.className = "gm-card gm-cardback"; e.append(Object.assign(document.createElement("span"), { className: "gm-mark" })); return e; }
  const c = k.c, s = SUIT[c[1]];
  e.className = `gm-card gm-face gm-${s.tone}`;
  const mid = document.createElement("span"); mid.className = "gm-mid";
  if ("JQK".includes(c[0])) { const b = document.createElement("b"); b.textContent = c[0]; mid.append(b, suitSvg(c[1], "gm-pip")); mid.classList.add("gm-court"); }
  else mid.append(suitSvg(c[1], "gm-big"));
  e.append(corner(c, "gm-tl"), mid, corner(c, "gm-br"));
  return e;
}
/** Fill a stack's element: the top card, its thickness, and a count badge when it holds more than one. */
export function renderStack(el, o) {
  const n = o.cards.length, t = topCard(o);
  const card = renderCard(t);
  const depth = Math.min(6, Math.ceil((n - 1) / 8));
  el.style.setProperty("--gm-depth", String(depth));
  el.replaceChildren(card);
  if (n > 1) {
    const b = document.createElement("span"); b.className = "gm-badge"; b.textContent = String(n);
    b.dataset.tip = `${n} cards: drag here to move the whole stack`;
    el.append(b);
  }
  el.dataset.kLabel = n === 1 ? (t.up ? cardLong(t.c) : "a card, face down") : `${n} cards (set ${o.set})${t.up ? `, top ${cardLong(t.c)}` : ""}`;
}
