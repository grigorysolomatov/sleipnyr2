// Table component: meeples, the classic standing player pieces.
//
// Objects: {id, kind: "meeple", x, y, color}; x, y = the top left corner in
// table px, color = "#rrggbb". Meeples lie above cards and tiles. The table
// operations are pure (state in, changed state out); render() draws one.
import { PALETTE, colorName, ink, parseColor } from "./colors.js";

export const KIND = "meeple";
export const TITLE = "Meeple";
export const W = 40, H = 44;   // in table px
export const LAYER = 2;        // drawn above tiles (0) and cards (1)

const clone = o => JSON.parse(JSON.stringify(o));
const nextId = list => "m" + (Math.max(0, ...list.filter(o => o.kind === KIND).map(o => Number(String(o.id).slice(1)) || 0)) + 1);
const color = c => { const v = parseColor(c ?? PALETTE[0].hex); if (!v) throw new Error(`not a colour: ${c}`); return v; };

/** A new meeple at (x, y), default the palette's first colour. */
export function addMeeple(st, x = 0, y = 0, c) {
  const s = clone(st); s.objects ||= [];
  const o = { id: nextId(s.objects), kind: KIND, x: Math.round(x), y: Math.round(y), color: color(c) };
  s.objects.push(o);
  return { state: s, id: o.id };
}
/** A copy beside it (to the right), same colour. */
export function duplicate(st, id) {
  const o = (st.objects || []).find(q => q.id === id && q.kind === KIND);
  if (!o) throw new Error(`no meeple ${id}`);
  return addMeeple(st, o.x + W + 8, o.y, o.color);
}
/** One line for the agent: id | colour | position. */
export const describe = o => `${o.id} | ${colorName(o.color)} | at ${Math.round(o.x)} ${Math.round(o.y)}`;

// ---------------------------------------------------------------- drawing
const PATH = "M20 2c-4.4 0-7.6 3.2-7.6 7.4 0 2.3 1 4.2 2.5 5.5C9.6 16 3 17.6 1.5 20.6c-1 2 .3 3.6 2.6 3.9 2.3.3 5.4-.3 8-1.1-1.3 4.4-4.6 10.5-7.6 14.6-1.2 1.7-.4 3.6 1.7 3.6h9.2c1.3 0 2.1-.7 2.6-1.8L20 33l2 6.8c.5 1.1 1.3 1.8 2.6 1.8h9.2c2.1 0 2.9-1.9 1.7-3.6-3-4.1-6.3-10.2-7.6-14.6 2.6.8 5.7 1.4 8 1.1 2.3-.3 3.6-1.9 2.6-3.9C37 17.6 30.4 16 25.1 14.9c1.5-1.3 2.5-3.2 2.5-5.5C27.6 5.2 24.4 2 20 2z";
const NS = "http://www.w3.org/2000/svg";
/** Fill a meeple's element: the silhouette in its colour with a contrasting outline. */
export function render(el, o) {
  let p = el.querySelector("path");
  if (!p) {
    const v = document.createElementNS(NS, "svg"); v.setAttribute("viewBox", `0 0 ${W} ${H}`); v.setAttribute("aria-hidden", "true");
    p = document.createElementNS(NS, "path"); p.setAttribute("d", PATH); p.setAttribute("stroke-width", "1.4"); p.setAttribute("stroke-linejoin", "round");
    v.append(p); el.replaceChildren(v);
  }
  p.setAttribute("fill", o.color); p.setAttribute("stroke", ink(o.color));
  el.dataset.kLabel = `${colorName(o.color)} meeple ${o.id}`;
}
