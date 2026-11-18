// Table colours: the palette shared by every coloured piece (meeples, tiles)
// and a loose colour parser for the agent's @lines. Pure, no page.

/** The swatch row of the colour menu, in order; the first is a new meeple's colour. */
export const PALETTE = [
  { name: "white", hex: "#ffffff" },
  { name: "black", hex: "#000000" },
  { name: "pink", hex: "#ff0088" },
  { name: "purple", hex: "#662288" },
  { name: "red", hex: "#e53935" },
  { name: "blue", hex: "#1e88e5" },
  { name: "green", hex: "#43a047" },
  { name: "yellow", hex: "#fdd835" },
  { name: "orange", hex: "#fb8c00" },
  { name: "grey", hex: "#9e9e9e" },
  { name: "light", hex: "#eeeed2" },
  { name: "dark", hex: "#769656" },
];
const ALIAS = { gray: "grey", magenta: "pink", violet: "purple", "chess-light": "light", "chess-dark": "dark", cream: "light" };

/** "#abc", "#aabbcc", "aabbcc" or a palette name -> "#aabbcc"; anything else -> "". */
export function parseColor(t) {
  let s = String(t || "").trim().toLowerCase();
  s = ALIAS[s] || s;
  const p = PALETTE.find(q => q.name === s);
  if (p) return p.hex;
  const m = s.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return "";
  const x = m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1];
  return `#${x}`;
}
/** The palette name of a colour, else its hex: for the agent's lists and tooltips. */
export const colorName = hex => PALETTE.find(q => q.hex === String(hex).toLowerCase())?.name || String(hex);
/** Relative luminance 0..1 of "#rrggbb". */
export function luminance(hex) {
  const v = parseColor(hex) || "#808080", c = [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16) / 255)
    .map(u => (u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** An outline that stays visible on that colour (and on the black table). */
export const ink = hex => (luminance(hex) < 0.12 ? "rgba(255,255,255,.75)" : "rgba(0,0,0,.6)");
/** Recolour a meeple or tile (pure: state in, changed state out). */
export function setColor(st, id, c) {
  const v = parseColor(c); if (!v) throw new Error(`not a colour: ${c}`);
  const s = JSON.parse(JSON.stringify(st)), o = (s.objects || []).find(q => q.id === id);
  if (!o || !("color" in o)) throw new Error(`${id} has no colour`);
  o.color = v;
  return s;
}
