// Table component: custom text decks ("Event cards" and the like).
//
// A text set is a deck whose cards are written by hand or by the agent while
// a game is being designed: sets [{id, kind: "text", name, x, y, cards}],
// cards = [{title, text}], card n = cards[n - 1] (n is stable, 1-based; cards
// are never removed). On the table its cards lie in ordinary stacks (kind
// "stack" of cards.js) as {n, up}, so drawing, merging (within one set only),
// shuffling, flipping and undo work exactly as for poker decks. A set may hold
// no cards yet: its home then shows an empty slot (a stack of 0 cards) until
// the first card is added. Gather rebuilds the full deck, card 1 on top.
//
// The operations are pure (state in, changed state out); render*() draw.
import { KIND, nextId, topCard } from "./cards.js";

export const SET = "text";
export const TITLE = "Text deck";
export const DEFAULT_NAME = "Events";
export const MAX_TITLE = 80, MAX_TEXT = 1000, MAX_NAME = 40;

const clone = o => JSON.parse(JSON.stringify(o));
const line = (t, max) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const para = t => String(t ?? "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT);

export const isText = set => !!set && set.kind === SET;
/** the full deck in order, face down, card 1 on top (cards[0] is the bottom) */
export const freshCards = set => (set.cards || []).map((_, i) => ({ n: i + 1, up: false })).reverse();
/** what card k of a set says */
export const cardOf = (set, k) => (set.cards || [])[k.n - 1] || { title: "", text: "" };

function needSet(s, id) {
  const set = (s.sets || []).find(q => q.id === String(id || "").trim());
  if (!isText(set)) throw new Error(`no text deck ${id}`);
  return set;
}
/** the set's stack at its home, if one lies there */
const homeStack = (s, set) => s.objects.find(o => o.kind === KIND && o.set === set.id && o.x === set.x && o.y === set.y);

/** A new text deck with no cards at (x, y): the set and its empty home slot. */
export function addTextDeck(st, x = 0, y = 0, name = DEFAULT_NAME) {
  const s = clone(st); s.sets ||= []; s.objects ||= [];
  const set = { id: nextId("d", s.sets), kind: SET, name: line(name, MAX_NAME) || DEFAULT_NAME, x: Math.round(x), y: Math.round(y), cards: [] };
  const o = { id: nextId("s", s.objects), kind: KIND, set: set.id, x: set.x, y: set.y, cards: [] };
  s.sets.push(set); s.objects.push(o);
  return { state: s, set: set.id, stack: o.id };
}
/** A new card (number = count + 1), face down at the bottom of the home stack (made again if gone). */
export function addCard(st, setId, title, text = "") {
  const s = clone(st), set = needSet(s, setId);
  const t = line(title, MAX_TITLE), x = para(text);
  if (!t && !x) throw new Error("a card needs a title or a text");
  set.cards.push({ title: t, text: x });
  const n = set.cards.length;
  let o = homeStack(s, set);
  if (!o) { o = { id: nextId("s", s.objects), kind: KIND, set: set.id, x: set.x, y: set.y, cards: [] }; s.objects.push(o); }
  o.cards.unshift({ n, up: false });
  return { state: s, n, stack: o.id };
}
/** Card n gets a new title and text (wherever it lies). */
export function editCard(st, setId, n, title, text = "") {
  const s = clone(st), set = needSet(s, setId), i = Math.floor(Number(n));
  if (!(i >= 1 && i <= set.cards.length)) throw new Error(`${set.id} has no card ${n} (it has ${set.cards.length})`);
  const t = line(title, MAX_TITLE), x = para(text);
  if (!t && !x) throw new Error("a card needs a title or a text");
  set.cards[i - 1] = { title: t, text: x };
  return s;
}
export function renameSet(st, setId, name) {
  const s = clone(st), set = needSet(s, setId), t = line(name, MAX_NAME);
  if (!t) throw new Error("a deck needs a name");
  set.name = t;
  return s;
}

// ---------------------------------------------------------------- for the agent
const short = (set, k) => { const c = cardOf(set, k); return `${k.n}: "${c.title || c.text.slice(0, 40)}"`; };
/** one line per stack: id | set (name) | cards | top card | position (face-down cards only by count) */
export function describeStack(o, set) {
  const n = o.cards.length, at = `at ${Math.round(o.x)} ${Math.round(o.y)}`, sn = `set ${set.id} (${set.name})`;
  if (!n) return `${o.id} | ${sn} | empty slot (no cards yet) | ${at}`;
  const t = topCard(o), ups = o.cards.filter(k => k.up).length;
  const face = n === 1 ? (t.up ? `card ${short(set, t)} face up` : "one card face down")
    : `${n} cards, top ${t.up ? `card ${short(set, t)} face up` : "face down"}${ups && ups < n ? ` (${ups} face up inside)` : ""}`;
  return `${o.id} | ${sn} | ${face} | ${at}`;
}
export function describeSet(set, objects) {
  const mine = objects.filter(o => o.kind === KIND && o.set === set.id), n = set.cards.length;
  const onTable = mine.reduce((k, o) => k + o.cards.length, 0);
  return `${set.id} | text deck "${set.name}" | home at ${set.x} ${set.y} | ${n} card${n === 1 ? "" : "s"}${n ? ` (numbers 1-${n})` : " yet"}, ${onTable} in ${mine.length} stack(s)`;
}
/** every card's title and text: what the agent wrote (author view) */
export function listCards(set) {
  const rows = set.cards.map((c, i) => `${i + 1}: ${c.title}${c.text ? ` | ${c.text.replace(/\s*\n\s*/g, " / ")}` : ""}`);
  return `[for you] author view of ${set.id} "${set.name}" (${set.cards.length} card${set.cards.length === 1 ? "" : "s"}; never read face-down cards out): ${rows.join("; ") || "no cards yet"}`;
}

// ---------------------------------------------------------------- drawing
const el = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; if (text != null) e.textContent = text; return e; };
/** a size step for long texts: the font shrinks, the rest is clipped (zoom in or Edit text to read it) */
const step = c => { const n = c.title.length * 1.6 + c.text.length; return n > 420 ? 4 : n > 260 ? 3 : n > 140 ? 2 : 1; };
/** one card's face (title on top, wrapped text below) or back (the set's name) */
export function renderCard(k, set) {
  if (!k.up) {
    const e = el("div", "gm-card gm-cardback");
    e.append(el("span", "gm-mark"), el("span", "gm-tname", set.name));
    return e;
  }
  const c = cardOf(set, k), e = el("div", `gm-card gm-tface gm-t${step(c)}`);
  if (c.title) e.append(el("b", "gm-ttitle", c.title));
  if (c.text) e.append(el("p", "gm-ttext", c.text));
  e.append(el("span", "gm-tnum", String(k.n)));
  return e;
}
/** Fill a text stack's element: top card, thickness, count badge; an empty slot when it holds no cards. */
export function renderStack(e, o, set) {
  const n = o.cards.length;
  e.style.setProperty("--gm-depth", String(Math.min(6, Math.ceil(Math.max(0, n - 1) / 8))));
  e.classList.toggle("gm-empty", !n);
  if (!n) {
    const s = el("div", "gm-card gm-tslot");
    s.append(el("span", "gm-tname", set.name), el("span", "gm-tsub", "no cards yet"));
    e.replaceChildren(s);
    e.dataset.kLabel = `text deck ${set.name} (set ${set.id}), no cards yet`;
    return;
  }
  const t = topCard(o);
  e.replaceChildren(renderCard(t, set));
  if (n > 1) {
    const b = el("span", "gm-badge", String(n));
    b.dataset.tip = `${n} cards: drag here to move the whole stack`;
    e.append(b);
  }
  const c = cardOf(set, t);
  e.dataset.kLabel = n === 1 ? (t.up ? `${set.name} card ${t.n}: ${c.title}` : `a ${set.name} card, face down`)
    : `${n} ${set.name} cards (set ${set.id})${t.up ? `, top card ${t.n}: ${c.title}` : ""}`;
}
