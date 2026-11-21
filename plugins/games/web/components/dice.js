// Table component: dice. A D6 for now; the sides field lets D4 to D20 follow
// without changing saved games.
//
// Objects: {id, kind: "die", x, y, sides, value, color, rolls}; x, y = the
// top left corner in table px, value = the face that shows (1..sides),
// color = "#rrggbb" (the body; pips take the contrasting ink), rolls = how
// often it was rolled, so other devices can tell a roll from a set value.
// Dice lie with the meeples, above tiles and cards. The table operations are
// pure (state in, changed state out); render() draws one.
import { PALETTE, colorName, ink, luminance, parseColor } from "./colors.js";

export const KIND = "die";
export const TITLE = "D6 die";
export const W = 50, H = 50;   // in table px
export const LAYER = 2;        // with the meeples, above tiles (0) and cards (1)
export const SIDES = [6];      // the kinds of dice drawn so far

const clone = o => JSON.parse(JSON.stringify(o));
// k1, k2...: one counter with the tokens, so a die and a token never share an id
const nextId = list => "k" + (Math.max(0, ...list.map(o => (/^k\d+$/.test(String(o.id)) ? Number(String(o.id).slice(1)) : 0))) + 1);
const color = c => { const v = parseColor(c ?? PALETTE[0].hex); if (!v) throw new Error(`not a colour: ${c}`); return v; };
const need = (st, id) => { const o = (st.objects || []).find(q => q.id === id && q.kind === KIND); if (!o) throw new Error(`no die ${id}`); return o; };
const sidesOf = n => { n = Number(n ?? 6); if (!SIDES.includes(n)) throw new Error(`no d${n} yet (dice: ${SIDES.map(s => "d" + s).join(", ")})`); return n; };

/** A fair face 1..sides from crypto.getRandomValues (rejection sampling: no modulo bias). */
export function randomFace(sides = 6) {
  const lim = Math.floor(0x100000000 / sides) * sides, b = new Uint32Array(1);
  do crypto.getRandomValues(b); while (b[0] >= lim);
  return (b[0] % sides) + 1;
}
/** A new die at (x, y), default white showing 1 (or the given face). */
export function addDie(st, x = 0, y = 0, c, value = 1, sides = 6) {
  const s = clone(st); s.objects ||= [];
  const n = sidesOf(sides);
  const o = { id: nextId(s.objects), kind: KIND, x: Math.round(x), y: Math.round(y), sides: n, value: face(value, n), color: color(c), rolls: 0 };
  s.objects.push(o);
  return { state: s, id: o.id };
}
const face = (v, sides) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > sides) throw new Error(`a d${sides} shows 1 to ${sides}, not ${v}`);
  return n;
};
/** Roll dice: each gets a fresh random face (rand(sides) -> 1..sides, for tests). */
export function roll(st, ids, rand = randomFace) {
  const s = clone(st);
  for (const id of ids) { const o = need(s, id); o.value = face(rand(o.sides), o.sides); o.rolls = (o.rolls || 0) + 1; }
  return s;
}
/** Turn a die to a face by hand. */
export function setValue(st, id, v) {
  const s = clone(st), o = need(s, id);
  o.value = face(v, o.sides);
  return s;
}
/** A copy beside it (to the right), same colour and face. */
export function duplicate(st, id) {
  const o = need(st, id);
  return addDie(st, o.x + W + 8, o.y, o.color, o.value, o.sides);
}
/** One line for the agent: id | sides | colour | value | position. */
export const describe = o => `${o.id} | d${o.sides} | ${colorName(o.color)} | shows ${o.value} | at ${Math.round(o.x)} ${Math.round(o.y)}`;

/** Pip centres of a D6 face on a 50 x 50 die: the classic layouts. */
const L = 14, M = 25, R = 36;
export const PIPS = {
  1: [[M, M]],
  2: [[R, L], [L, R]],
  3: [[R, L], [M, M], [L, R]],
  4: [[L, L], [R, L], [L, R], [R, R]],
  5: [[L, L], [R, L], [M, M], [L, R], [R, R]],
  6: [[L, L], [R, L], [L, M], [R, M], [L, R], [R, R]],
};
/** Pips that read on that body colour: near-black on light dice, white on dark ones. */
export const pipColor = hex => (luminance(hex) > 0.18 ? "#161616" : "#ffffff");

// ---------------------------------------------------------------- drawing
const NS = "http://www.w3.org/2000/svg";
/** Draw face v (1..6) into a die element without touching its saved object (the tumble uses it). */
export function showFace(el, v, hex) {
  const g = el.querySelector("g"); if (!g) return;
  const pc = pipColor(hex);
  g.replaceChildren(...(PIPS[v] || []).map(([x, y]) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", "4.6"); c.setAttribute("fill", pc);
    return c;
  }));
}
/** Fill a die's element: the rounded body in its colour, a thin contrasting edge, its pips. */
export function render(el, o) {
  let body = el.querySelector("rect");
  if (!body) {
    const v = document.createElementNS(NS, "svg"); v.setAttribute("viewBox", `0 0 ${W} ${H}`); v.setAttribute("aria-hidden", "true");
    body = document.createElementNS(NS, "rect");
    for (const [k, x] of Object.entries({ x: 1, y: 1, width: W - 2, height: H - 2, rx: 9, "stroke-width": 1.2 })) body.setAttribute(k, x);
    v.append(body, document.createElementNS(NS, "g")); el.replaceChildren(v);
  }
  body.setAttribute("fill", o.color); body.setAttribute("stroke", ink(o.color));
  if (!el.dataset.tumbling) showFace(el, o.value, o.color);
  el.dataset.kLabel = `${colorName(o.color)} d${o.sides} ${o.id} showing ${o.value}`;
}
