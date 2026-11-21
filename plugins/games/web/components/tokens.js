// Table component: tokens, flat pieces cut in a shape (a poop, a disc, a
// cube, a star, a heart). A shape is only a name and a drawing, so more
// shapes are one entry in SHAPES each; saved games keep working.
//
// Objects: {id, kind: "token", x, y, shape, color, eyes}; x, y = the top
// left corner in table px, shape = a SHAPES id, color = "#rrggbb" (the edge
// is a darker shade of it, so a token reads on grey tiles), eyes = the poop's
// two eyes (off unless turned on). Ids are k1, k2... shared with the dice (t
// is taken by tiles). Tokens lie with the meeples, above tiles and cards.
// The table operations are pure (state in, changed state out).
import { colorName, luminance, parseColor } from "./colors.js";

export const KIND = "token";
export const TITLE = "Token";
export const W = 44, H = 44;   // in table px
export const LAYER = 2;        // with the meeples, above tiles (0) and cards (1)

const NS = "http://www.w3.org/2000/svg";
const star = (() => {
  const p = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 8.6 : 20.5;
    p.push(`${(22 + r * Math.cos(a)).toFixed(1)} ${(23.5 + r * Math.sin(a)).toFixed(1)}`);
  }
  return `M${p.join(" L")} Z`;
})();
/**
 * The shapes, in menu order. parts = the silhouette, drawn in order with the
 * fill and the darker edge (later parts lie in front: the poop's lower tiers
 * overlap the upper ones); lines = edge-coloured strokes only; shade =
 * a lighter face (the cube's top).
 */
export const SHAPES = [
  { id: "poop", name: "Poop", color: "#6b4423", parts: [
    "M17.5 13.5C18 8.6 21.4 6.2 25.6 2.6c1.6 3.4 2.6 6.7 1.9 10.9z",   // the tip, a small twist
    "M18 11h8a5.5 5.5 0 0 1 0 11h-8a5.5 5.5 0 0 1 0-11z",              // top tier
    "M13 19.5h18a6 6 0 0 1 0 12H13a6 6 0 0 1 0-12z",                    // middle tier
    "M9.5 29h25a6.25 6.25 0 0 1 0 12.5h-25a6.25 6.25 0 0 1 0-12.5z",    // bottom tier
  ] },
  { id: "disc", name: "Disc", color: "#e53935", parts: ["M22 3a19 19 0 1 1 0 38a19 19 0 1 1 0-38z"],
    lines: ["M22 9.5a12.5 12.5 0 1 1 0 25a12.5 12.5 0 1 1 0-25z"] },
  { id: "cube", name: "Cube", color: "#1e88e5", parts: ["M22 3L39.5 12.5v19L22 41L4.5 31.5v-19z"],
    shade: "M22 3L39.5 12.5L22 22L4.5 12.5z", lines: ["M4.5 12.5L22 22L39.5 12.5M22 22V41"] },
  { id: "star", name: "Star", color: "#fdd835", parts: [star] },
  { id: "heart", name: "Heart", color: "#e53935",
    parts: ["M22 39.5C10.5 31 3 24 3 15c0-6 4.6-10.5 10.2-10.5 3.8 0 7 2 8.8 5.2 1.8-3.2 5-5.2 8.8-5.2C36.4 4.5 41 9 41 15c0 9-7.5 16-19 24.5z"] },
];
const ALIAS = { poo: "poop", turd: "poop", coin: "disc", circle: "disc", round: "disc", block: "cube", square: "cube", box: "cube", love: "heart" };

/** "Poop", "coin", "cube" -> a SHAPES entry; anything else -> null. */
export function shapeOf(name) {
  let s = String(name || "").trim().toLowerCase();
  s = ALIAS[s] || s;
  return SHAPES.find(q => q.id === s) || null;
}
const shape = n => { const s = shapeOf(n ?? SHAPES[0].id); if (!s) throw new Error(`no token shape ${n} (shapes: ${SHAPES.map(q => q.id).join(", ")})`); return s; };
const clone = o => JSON.parse(JSON.stringify(o));
/** k1, k2...: one counter with the dice, so a die and a token never share an id */
export const nextId = list => "k" + (Math.max(0, ...list.map(o => (/^k\d+$/.test(String(o.id)) ? Number(String(o.id).slice(1)) : 0))) + 1);
const need = (st, id) => { const o = (st.objects || []).find(q => q.id === id && q.kind === KIND); if (!o) throw new Error(`no token ${id}`); return o; };

/** A new token at (x, y), default a poop in the shape's own colour. */
export function addToken(st, x = 0, y = 0, sh, c, eyes = false) {
  const s = clone(st); s.objects ||= [];
  const S = shape(sh), v = parseColor(c ?? S.color);
  if (!v) throw new Error(`not a colour: ${c}`);
  const o = { id: nextId(s.objects), kind: KIND, x: Math.round(x), y: Math.round(y), shape: S.id, color: v, eyes: !!eyes };
  s.objects.push(o);
  return { state: s, id: o.id };
}
/** Cut it in another shape (the colour stays). */
export function setShape(st, id, sh) {
  const s = clone(st); need(s, id).shape = shape(sh).id;
  return s;
}
/** The poop's eyes on or off. */
export function setEyes(st, id, on) {
  const s = clone(st); need(s, id).eyes = !!on;
  return s;
}
/** A copy beside it (to the right), same shape, colour and eyes. */
export function duplicate(st, id) {
  const o = need(st, id);
  return addToken(st, o.x + W + 8, o.y, o.shape, o.color, o.eyes);
}
/** One line for the agent: id | shape | colour | position. */
export const describe = o => `${o.id} | ${o.shape}${o.eyes ? " with eyes" : ""} | ${colorName(o.color)} | at ${Math.round(o.x)} ${Math.round(o.y)}`;
/** "brown poop token" style words for menus and notes */
export const label = o => `${colorName(o.color)} ${(shapeOf(o.shape) || SHAPES[0]).name.toLowerCase()} token`;

/** The edge: the fill darkened, so the outline reads on grey tiles; light on near-black. */
export function edge(hex) {
  const v = parseColor(hex) || "#808080";
  if (luminance(v) < 0.02) return "rgba(255,255,255,.7)";
  const c = [1, 3, 5].map(i => Math.round(parseInt(v.slice(i, i + 2), 16) * 0.45));
  return `#${c.map(n => n.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------- drawing
const el = (tag, at) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(at)) e.setAttribute(k, v); return e; };
/** An svg of the shape in that colour (also the menus' small icons). */
export function icon(sh, hex, eyes = false, size = 0) {
  const S = shapeOf(sh) || SHAPES[0], line = edge(hex);
  const v = el("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", ...(size ? { width: size, height: size } : {}) });
  const st = { stroke: line, "stroke-width": 1.6, "stroke-linejoin": "round", "stroke-linecap": "round" };
  for (const d of S.parts) v.append(el("path", { d, fill: hex, ...st }));
  if (S.shade) v.append(el("path", { d: S.shade, fill: "#ffffff", "fill-opacity": ".28", stroke: "none" }));
  for (const d of S.lines || []) v.append(el("path", { d, fill: "none", ...st, "stroke-opacity": ".8" }));
  if (eyes && S.id === "poop") {
    for (const x of [18.5, 25.5]) {
      v.append(el("circle", { cx: x, cy: 25, r: 2.9, fill: "#ffffff", stroke: line, "stroke-width": 0.8 }));
      v.append(el("circle", { cx: x + 0.5, cy: 25.5, r: 1.3, fill: "#161616" }));
    }
  }
  return v;
}
/** Fill a token's element: redrawn only when its shape, colour or eyes change. */
export function render(e, o) {
  const key = `${o.shape}|${o.color}|${o.eyes ? 1 : 0}`;
  if (e.dataset.look !== key) { e.replaceChildren(icon(o.shape, o.color, o.eyes)); e.dataset.look = key; }
  e.dataset.kLabel = `${label(o)} ${o.id}`;
}
