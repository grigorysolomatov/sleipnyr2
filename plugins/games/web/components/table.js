// Whole-table edits that no single component owns: removing pieces, and a
// game's undo history.
//
// Removing: only meeples, dice and tiles go; a locked tile stays, and cards are
// never removed (a set always keeps its 52 cards).
// History: table states as JSON strings. record() is called after every
// change (with the new state); undo() / redo() hand back the state to show.
// A tag joins quick repeats of one action (arrow-key nudges) into one step.
import * as Meeples from "./meeples.js";
import * as Tiles from "./tiles.js";
import * as Dice from "./dice.js";

const clone = o => JSON.parse(JSON.stringify(o));

/** a piece that may be removed: a meeple, a die, or a tile that is not locked */
export const removable = o => !!o && (o.kind === Meeples.KIND || o.kind === Dice.KIND || (o.kind === Tiles.KIND && !o.locked));

/** The table without the removable pieces among ids (others are kept). */
export function removePieces(st, ids) {
  const want = new Set(ids), s = clone(st);
  s.objects = (s.objects || []).filter(o => !(want.has(o.id) && removable(o)));
  return s;
}

export const LIMIT = 100; // undo steps kept per game
export const JOIN_MS = 1000; // tagged repeats closer than this are one step

/** One game's history. base = the state on screen as last recorded. */
export function history(limit = LIMIT) {
  let past = [], future = [], base = null, tag = "", at = 0;
  /** a new state: the old one becomes an undo step (false: nothing new) */
  function record(s, t = "", now = Date.now()) {
    if (base === null || s === base) { base = s; return false; }
    if (t && t === tag && now - at < JOIN_MS) { base = s; at = now; future = []; return false; }
    past.push(base); if (past.length > limit) past.shift();
    future = []; base = s; tag = t; at = now;
    return true;
  }
  /** the state before cur (cur is recorded first if it is new), or null */
  function undo(cur) {
    if (cur != null) record(cur);
    if (!past.length) return null;
    future.push(base); base = past.pop(); tag = "";
    return base;
  }
  /** the state undo left, or null (also after a new change) */
  function redo(cur) {
    if (cur != null) record(cur);
    if (!future.length) return null;
    past.push(base); base = future.pop(); tag = "";
    return base;
  }
  /** the state on screen changed without being a step (another device, a reload) */
  function reset(s) { base = s; tag = ""; }
  return { record, undo, redo, reset, canUndo: () => past.length > 0, canRedo: () => future.length > 0, size: () => past.length };
}
