// Table component: tiles, plain coloured rectangles to build boards from
// (a chess board, a tic-tac-toe grid, a player mat). They do nothing else:
// places for pieces to stand.
//
// Objects: {id, kind: "tile", x, y, w, h, color, locked}; position and size
// in table px, always on the SNAP grid so tiles butt edge to edge. Tiles lie
// beneath cards and meeples; a locked tile does not move (drags on it pan the
// table). Moving a tile does not carry the pieces standing on it.
import { colorName, ink, parseColor } from "./colors.js";

export const KIND = "tile";
export const TITLE = "Tile";
export const SIZE = 100;            // a new tile, in table px
export const SNAP = 10;             // position and size grid
export const MIN = 20, MAX = 4000;  // side limits
export const COLOR = "#9e9e9e";     // a new tile (grey)
export const LAYER = 0;             // beneath everything

const clone = o => JSON.parse(JSON.stringify(o));
const nextId = list => "t" + (Math.max(0, ...list.filter(o => o.kind === KIND).map(o => Number(String(o.id).slice(1)) || 0)) + 1);
export const snap = v => Math.round(Number(v) / SNAP) * SNAP;
export const side = v => Math.max(MIN, Math.min(MAX, snap(v)));
const color = c => { const v = parseColor(c ?? COLOR); if (!v) throw new Error(`not a colour: ${c}`); return v; };
const need = (st, id) => { const o = (st.objects || []).find(q => q.id === id && q.kind === KIND); if (!o) throw new Error(`no tile ${id}`); return o; };

/** A new tile at (x, y) of w x h, snapped to the grid. */
export function addTile(st, x = 0, y = 0, w = SIZE, h = SIZE, c) {
  const s = clone(st); s.objects ||= [];
  const o = { id: nextId(s.objects), kind: KIND, x: snap(x), y: snap(y), w: side(w), h: side(h), color: color(c), locked: false };
  s.objects.push(o);
  return { state: s, id: o.id };
}
/** The copy goes directly right of it, same size and colour, so a row grows fast. */
export function duplicate(st, id) {
  const o = need(st, id);
  return addTile(st, o.x + o.w, o.y, o.w, o.h, o.color);
}
export function resize(st, id, w, h) {
  const s = clone(st), o = need(s, id);
  if (!Number.isFinite(Number(w)) || !Number.isFinite(Number(h))) throw new Error("size needs two numbers");
  o.w = side(w); o.h = side(h);
  return s;
}
export function setLocked(st, id, on) {
  const s = clone(st), o = need(s, id);
  o.locked = !!on;
  return s;
}
/** One line for the agent: id | colour | size | position | locked. */
export const describe = o => `${o.id} | ${colorName(o.color)} | ${o.w} x ${o.h} | at ${Math.round(o.x)} ${Math.round(o.y)} | ${o.locked ? "locked" : "movable"}`;

// ---------------------------------------------------------------- drawing
/** Fill a tile's element: its colour and size, a resize handle (bottom right). */
export function render(el, o) {
  el.style.width = `${o.w}px`; el.style.height = `${o.h}px`;
  el.style.setProperty("--gm-tile", o.color); el.style.setProperty("--gm-tile-ink", ink(o.color));
  el.classList.toggle("gm-locked", !!o.locked);
  if (!el.querySelector(".gm-handle")) {
    const k = document.createElement("span"); k.className = "gm-handle";
    k.dataset.tip = "Drag to resize"; el.replaceChildren(k);
  }
  el.dataset.kLabel = `${colorName(o.color)} tile ${o.id}, ${o.w} x ${o.h}${o.locked ? ", locked" : ""}`;
}
