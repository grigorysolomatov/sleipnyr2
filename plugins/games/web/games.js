// Games: a composed modality. A personal tabletop for game prototypes.
//
// The level opens on the list of games (/m/games, the kernel's itemList like
// the Columns boards: newest first, pink = the last one opened, + = a new
// game named after today); a tap opens one (/m/games/<item id>), the back
// arrow returns to the list. Each game has its own conversation (view thread
// data.chatView = games-<id>; the list's is games-list).
//
// A game is an endless table: middle-drag (or one finger on a phone) pans,
// a left drag on empty space draws a selection box; the wheel (or two fingers) to zoom. On it lie objects drawn by table
// components (web/components/*.js): poker card sets, meeples, dice and tiles.
// The + at the top right (and a right-click / long-press on empty table)
// offers them: Poker deck, Meeple, D6 die, Tile. Tiles lie at the bottom,
// cards on them, meeples and dice on top. Cards:
//   drag a card or a stack         moves it (a deck: drag its TOP CARD off = draw one card)
//   drag a deck's count badge      moves the whole deck (desktop: also Shift + drag)
//   drop on a stack of the same set   merges (the dropped cards go on top); another set refuses
//   double-click / double-tap      flips the card or the stack
//   right-click / long-press       menu at the object: Flip, Draw, Shuffle, Gather;
//                                  on empty table: add a poker deck, meeple or tile
// meeples: drag to move; menu = colour swatches, Custom colour, Duplicate
// text decks (custom cards, e.g. Events): a named set of {title, text} cards,
//   written by hand (menu Add card / Edit text / Rename deck) or by the agent
//   (@add-text-deck, @add-card, @edit-card, @rename-set, @list-cards); they
//   draw, flip, shuffle, merge (own set only) and gather like poker cards; a
//   deck with no cards yet shows an empty slot at its home
// dice: drag to move; double-click / double-tap, menu Roll or R (over the die,
//   or the selected dice) rolls with a short tumble; menu = Roll, Set value,
//   colour, Duplicate, Copy (dice select, copy, delete and nudge like meeples)
// tiles: drag to move (snapped to a 10 px grid), the bottom-right handle resizes
//   (desktop: on hover; phone: tap the tile first); menu = colour, Duplicate
//   (the copy goes right beside it), Lock (a locked tile stays put: drags on it pan)
// copy + paste (meeples and tiles; cards belong to their deck, so not them):
//   a click / tap selects a piece (pink), empty table or Escape clears;
//   Ctrl+C (Cmd+C) copies the selected piece, Ctrl+V pastes one copy per press:
//   at the pointer if it moved since the last paste, else right beside the last
//   one (tiles edge to edge), so C then V V V builds a row. The menus offer
//   Copy (on a piece) and Paste (on empty table). The copy lives in this tab only.
// several pieces (meeples and tiles; stacks never join):
//   Shift+click or Ctrl/Cmd+click adds or removes a piece; a left drag on empty
//   table (Shift: added to the selection) draws a box that selects every piece it touches. With several
//   selected, the menu of any of them colours, locks, duplicates or copies them
//   all, and dragging one moves them all (locked tiles stay). Ctrl+V pastes the
//   copied group in its layout: its top left at the pointer, or right beside
//   the last paste. Phone: a piece's menu has Select more; taps then add or
//   remove pieces until the Done (n) pill at the top; a long-press on a
//   selected piece then acts on all of them.
// delete + undo: Delete / Backspace (or Delete in a piece's menu) removes the
//   selected meeples and tiles (a locked tile stays; cards are never removed,
//   a set keeps its 52). Ctrl+Z undoes any table change (moves, colours, sizes,
//   locks, pastes, deletes, card draws, flips, shuffles, merges, gathers),
//   Ctrl+Shift+Z or Ctrl+Y redoes; the history is per game, in this tab.
// desktop keys (? shows them): Ctrl+D duplicate, Ctrl+A select all pieces,
//   arrows nudge 10 px (Shift: 50), L lock / unlock tiles, R roll dice; over a stack under
//   the mouse: F flip, S shuffle, D draw, G gather. Keys are ignored while
//   typing in a field.
//
// Saved item (kernel /k/items), one per game:
//   game {title, chatView, sets: [{id, kind, x, y}], objects: [{id, kind, x, y, ...}]}
//     objects in drawing order (the last one on top); the component named by
//     kind draws it and owns its fields (stack: set, cards [{c, up}] or, in a
//     text set {kind: "text", name, cards: [{title, text}]}, [{n, up}], bottom first;
//     meeple: color; die: sides, value, color, rolls; tile: w, h, color, locked); drawn by layer, then this order
// The view (pan, zoom) is kept per device. Saves are short-delayed PATCHes of
// the bare body; another device's newer copy is taken when nothing is pending.
import { itemList } from "/web/itemlist.js";
import { CHAT_FIRST, ONE_SENTENCE, runs } from "/web/hcp.js";
import { backButton } from "/web/head.js";
import * as Cards from "./components/cards.js";
import * as Meeples from "./components/meeples.js";
import * as Tiles from "./components/tiles.js";
import * as Dice from "./components/dice.js";
import * as Text from "./components/textcards.js";
import { PALETTE, colorName, parseColor, setColor } from "./components/colors.js";
import * as Table from "./components/table.js";

// the table components by object kind: element class, drawing, size, layer (higher = on top)
const KINDS = {
  [Cards.KIND]: { cls: "gm-stack", render: Cards.renderStack, size: () => [Cards.W, Cards.H], layer: 1 },
  [Meeples.KIND]: { cls: "gm-meeple", render: Meeples.render, size: () => [Meeples.W, Meeples.H], layer: Meeples.LAYER },
  [Tiles.KIND]: { cls: "gm-tile", render: Tiles.render, size: o => [o.w, o.h], layer: Tiles.LAYER },
  [Dice.KIND]: { cls: "gm-die", render: Dice.render, size: () => [Dice.W, Dice.H], layer: Dice.LAYER },
};
const kindOf = o => KINDS[o.kind] || KINDS[Cards.KIND];
const sizeOf = o => kindOf(o).size(o);

const ME = "games";
const LIST_VIEW = "games-list";
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const SLOP = 8;     // px of movement that turns a press into a drag
const HOLD = 450;   // ms a finger rests before the menu opens
const GLIDE = 220;  // ms, objects easing into place
const GRID = 32;    // table px between the dots
const ZMIN = 0.25, ZMAX = 3;
const VIEW_KEY = "sleipnyr2.games.view."; // + game id: this device's pan and zoom
const LAST_KEY = "sleipnyr2.games.last";

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
};
const svg = s => { const t = document.createElement("template"); t.innerHTML = s; return t.content.firstChild; };
const icon = (ic, tip, onclick, cls = "") => h("button", { class: `c-btn c-ic ${cls}`.trim(), type: "button", "data-tip": tip, "aria-label": tip, onclick }, svg(ic));
// the copied pieces {items: [{kind, color, w, h, dx, dy}], w, h}: dx, dy from
// the group's top left, w x h its size; per tab, shared by every game
let CLIP = null;
// undo histories by game id (this tab)
const HIST = new Map();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => 1 - Math.pow(1 - t, 3);

export function mount(box, ctx) {
  const WHO = ctx.user?.name || "the user", AG = ctx.app?.agentName || "the agent";
  const st = { item: null, list: [], last: localStorage.getItem(LAST_KEY) || "", els: new Map(), sel: new Set(), multi: false, saveTimer: 0, savedAt: 0, view: { x: 40, y: 40, z: 1 } };
  box.classList.add("gm-level");
  const back = backButton({ cls: "gm-back", onclick: () => (st.item ? ctx.levels.go(ME, "") : ctx.levels.up()) });
  const titleEl = h("b", { class: "gm-title" }, "Games");
  const zoomEl = h("button", { class: "gm-zoom", type: "button", "data-tip": "Zoom; tap to fit the table", "aria-label": "Fit the table", onclick: () => fitAll(), hidden: true });
  const addBtn = icon(PLUS, "New game", () => (st.item ? addMenu() : newGame()), "gm-add");
  const head = h("header", { class: "gm-bar" }, back, titleEl, zoomEl, addBtn);
  const games = itemList({ word: "game", agent: AG, href: it => `/m/${ME}/${encodeURIComponent(it.id)}`, open: it => ctx.levels.go(ME, it.id),
    title: it => it.data.title || "Untitled game", summary: it => gameSummary(it),
    archive: async (it, on) => { await patchGame(it.id, { hidden: on ? true : null }); drawList(); } });
  const dots = h("canvas", { class: "gm-dots", "aria-hidden": "true" });
  const plane = h("div", { class: "gm-plane" });
  const hint = h("p", { class: "gm-hint", hidden: true }, "Empty table. Use + above, or right-click / long-press the table, to add a poker deck, a text deck, a meeple, a die or a tile.");
  const board = h("div", { class: "gm-board", hidden: true, "data-k-id": "table", "data-k-kind": "table",
    "data-k-label": "The table: middle-drag (phone: one finger) pans, left-drag selects, wheel or pinch zooms" }, dots, plane, hint);
  const menu = h("div", { class: "gm-menu k-pop", role: "menu", hidden: true });
  const note = h("p", { class: "gm-note", "aria-live": "polite", hidden: true });
  // the Custom colour picker: the browser's own, opened from the menu
  const picker = h("input", { type: "color", class: "gm-picker", tabindex: "-1", "aria-hidden": "true" });
  // phone select mode: taps add / remove pieces until this pill is tapped
  const done = h("button", { class: "gm-done", type: "button", hidden: true, "data-tip": "Stop selecting; long-press a selected piece to act on all of them",
    onclick: () => endMulti() }, "Done");
  // Shift+drag on empty table: the selection box
  const boxEl = h("div", { class: "gm-box", hidden: true, "aria-hidden": "true" });
  board.append(boxEl);
  // ? : the desktop keys
  const keysEl = h("div", { class: "gm-keys k-pop", role: "dialog", "aria-label": "Keys", hidden: true });
  box.append(head, games.el, board, note, menu, picker, done, keysEl);
  const say = (t, err = false) => { note.hidden = !t; note.textContent = t || ""; note.classList.toggle("err", err); };

  // ------------------------------------------------------------ data
  const data = () => st.item?.data;
  const objs = () => data()?.objects || [];
  const findO = id => objs().find(o => o.id === id);
  const needO = id => { const o = findO(String(id || "").trim()); if (!o) throw new Error(`no object ${id}`); return o; };
  const table = () => ({ sets: data().sets || [], objects: objs() });
  const setOf = o => (data()?.sets || []).find(s => s.id === o?.set);
  /** the text set a stack belongs to, or null (a poker stack) */
  const textOf = o => { const s = setOf(o); return Text.isText(s) ? s : null; };
  const findSet = id => (data()?.sets || []).find(s => s.id === id);
  const needText = id => { const s = (data()?.sets || []).find(q => q.id === String(id || "").trim()); if (!Text.isText(s)) throw new Error(`no text deck ${id}`); return s; };
  /** apply a pure table operation's result and save */
  function commit(state, tag = "") { data().sets = state.sets; data().objects = state.objects; draw(); save(false, tag); }
  // ---- undo: every save records the table; undo / redo put an older one back
  const snapshot = () => JSON.stringify({ sets: data()?.sets || [], objects: objs() });
  const hist = () => { const id = st.item?.id; if (!id) return null; if (!HIST.has(id)) HIST.set(id, Table.history()); return HIST.get(id); };
  function undoRedo(redo) {
    const H = hist(); if (!H || drag || boxSel) return false;
    const s = redo ? H.redo(snapshot()) : H.undo(snapshot());
    if (s == null) { say(redo ? "Nothing to redo." : "Nothing to undo."); clearTimeout(st.undoT); st.undoT = setTimeout(() => { if (/^Nothing to/.test(note.textContent)) say(""); }, 1800); return false; }
    const was = spots(), t = JSON.parse(s);
    closeMenu(); data().sets = t.sets; data().objects = t.objects; draw(); glideFrom(was); save();
    if (/^Nothing to|^Removed|^Locked tiles/.test(note.textContent)) say("");
    return true;
  }
  const gameSummary = it => {
    const all = it.data.objects || [], os = all.filter(o => o.kind === Cards.KIND), n = os.reduce((s, o) => s + o.cards.length, 0);
    const pl = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`, parts = [];
    if (os.length) parts.push(pl(os.length, "stack"), pl(n, "card"));
    const m = all.filter(o => o.kind === Meeples.KIND).length, t = all.filter(o => o.kind === Tiles.KIND).length;
    if (m) parts.push(pl(m, "meeple"));
    const k = all.filter(o => o.kind === Dice.KIND).length;
    if (k) parts.push(k === 1 ? "1 die" : `${k} dice`);
    if (t) parts.push(pl(t, "tile"));
    return parts.join(", ") || "empty table";
  };

  async function saveOnce() {
    const it = st.item, d = it.data;
    const out = await ctx.api(`/k/items/${encodeURIComponent(it.id)}`, { method: "PATCH", json: { sets: d.sets || [], objects: d.objects || [] } });
    if (st.item === it) { st.savedAt = Math.max(st.savedAt, Number(out.updated) || 0); it.updated = out.updated; }
  }
  let saving = null, inFlight = 0;
  function save(now = false, tag = "") {
    clearTimeout(st.saveTimer);
    if (!st.item) return Promise.resolve(true);
    hist()?.record(snapshot(), tag);
    const go = () => { st.saveTimer = 0; return (saving = (async () => {
      await saving?.catch(() => {});
      inFlight++;
      try { await saveOnce(); return true; } catch (e) { say(`Not saved: ${e.message}`, true); return false; } finally { inFlight--; }
    })()); };
    if (now) return go();
    st.saveTimer = setTimeout(go, 300);
    return Promise.resolve(true);
  }
  const flush = () => (st.saveTimer ? save(true) : saving || Promise.resolve());
  const settle = (pr, ms = 800) => Promise.race([pr.catch(() => {}), new Promise(ok => setTimeout(ok, ms))]);

  // ------------------------------------------------------------ the games
  const viewName = it => it.data.chatView || `${ME}-${String(it.id).replace(/[^a-z0-9]/g, "").slice(-20)}`;
  async function loadList() {
    try { st.list = await ctx.api(`/k/items?type=game&order=-updated&limit=500`); return true; } catch (e) { say(`Could not load the games: ${e.message}`, true); return false; }
  }
  const today = () => new Date().toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  async function newGame(title = "") {
    try {
      let it = await ctx.api("/k/items", { json: { type: "game", data: { title: String(title).trim().slice(0, 80) || today(), sets: [], objects: [] } } });
      it = await ctx.api(`/k/items/${encodeURIComponent(it.id)}`, { method: "PATCH", json: { chatView: `${ME}-${String(it.id).replace(/[^a-z0-9]/g, "").slice(-20)}` } });
      st.list = [it, ...st.list.filter(x => x.id !== it.id)];
      ctx.levels.go(ME, it.id);
      return it;
    } catch (e) { say(`Could not make a game: ${e.message}`, true); return null; }
  }
  async function patchGame(id, patch) {
    const it = await ctx.api(`/k/items/${encodeURIComponent(id)}`, { method: "PATCH", json: patch });
    const i = st.list.findIndex(x => x.id === id); if (i >= 0) st.list[i] = it;
    return it;
  }
  async function rename(t) {
    if (!st.item) return;
    t = String(t || "").trim().slice(0, 80); if (!t) return;
    data().title = t; drawHead();
    try { const it = await patchGame(st.item.id, { title: t }); st.savedAt = Math.max(st.savedAt, Number(it.updated) || 0); } catch (e) { say(`Could not rename: ${e.message}`, true); }
  }
  function drawHead() {
    const it = st.item;
    titleEl.textContent = it ? it.data.title || "Untitled game" : "Games";
    titleEl.classList.toggle("gm-ren", !!it);
    if (it) titleEl.dataset.tip = "Tap to rename"; else delete titleEl.dataset.tip;
    titleEl.onclick = it ? () => { const t = prompt("Game name", data().title || ""); if (t !== null) rename(t); } : null;
    const bt = it ? "All games" : "All modalities", at = it ? "Add to the table: poker deck, meeple, die, tile" : "New game";
    back.dataset.tip = bt; back.setAttribute("aria-label", bt);
    addBtn.dataset.tip = at; addBtn.setAttribute("aria-label", at);
    zoomEl.hidden = !it;
  }
  function drawList() { drawHead(); board.hidden = true; closeMenu(); games.el.hidden = false; games.draw(st.list, st.last); }

  // ------------------------------------------------------------ the view (pan + zoom)
  let dotKey = "", dotTile = null;
  function paintDots() {
    const v = st.view, r = board.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (dots.width !== W) dots.width = W;
    if (dots.height !== H) dots.height = H;
    const cx = dots.getContext("2d"); if (!cx) return;
    const c = GRID * v.z * dpr, T = Math.max(2, Math.round(c)), col = getComputedStyle(dots).color;
    const key = `${T}|${dpr}|${col}`;
    if (key !== dotKey) {
      dotKey = key; dotTile = document.createElement("canvas"); dotTile.width = dotTile.height = T;
      const t = dotTile.getContext("2d"); t.fillStyle = col; t.beginPath(); t.arc(T / 2, T / 2, 1.1 * dpr, 0, Math.PI * 2); t.fill();
    }
    const pat = cx.createPattern(dotTile, "repeat"); if (!pat) return;
    pat.setTransform(new DOMMatrix().translate(v.x * dpr, v.y * dpr).scale(c / T));
    cx.clearRect(0, 0, W, H); cx.fillStyle = pat; cx.fillRect(0, 0, W, H);
  }
  new ResizeObserver(() => { if (st.item) paintDots(); }).observe(board);
  let viewRaf = 0, viewSaveT = 0;
  function applyView() { if (!viewRaf) viewRaf = requestAnimationFrame(paintView); }
  function paintView() {
    viewRaf = 0;
    const v = st.view;
    plane.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    paintDots();
    const zt = `${Math.round(v.z * 100)} %`;
    if (zoomEl.textContent !== zt) zoomEl.textContent = zt;
  }
  // while the view moves the plane is its own compositor layer; at rest it is drawn crisp again
  let movingT = 0;
  function moving() {
    board.classList.add("moving");
    clearTimeout(movingT);
    movingT = setTimeout(() => { if (!pans.size) board.classList.remove("moving"); }, 200);
  }
  function setView(v) {
    if (!st.item) return;
    st.view = { ...st.view, ...v }; moving(); applyView(); closeMenu();
    clearTimeout(viewSaveT);
    const id = st.item.id, keep = st.view;
    viewSaveT = setTimeout(() => localStorage.setItem(VIEW_KEY + id, JSON.stringify(keep)), 300);
  }
  let viewGlide = 0;
  function glideView(to) {
    cancelAnimationFrame(viewGlide);
    const from = st.view, t0 = performance.now();
    const step = now => {
      const k = ease(Math.min(1, (now - t0) / (GLIDE + 80)));
      setView({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z * Math.pow(to.z / from.z, k) });
      if (k < 1) viewGlide = requestAnimationFrame(step);
    };
    viewGlide = requestAnimationFrame(step);
  }
  function zoomAt(z, cx, cy) {
    const v = st.view, nz = clamp(z, ZMIN, ZMAX);
    setView({ z: nz, x: cx - (cx - v.x) * nz / v.z, y: cy - (cy - v.y) * nz / v.z });
  }
  function fitAll() {
    const os = objs(), r = board.getBoundingClientRect();
    if (!os.length) return glideView({ x: 40, y: 40, z: 1 });
    const pad = 32, x0 = Math.min(...os.map(o => o.x)), y0 = Math.min(...os.map(o => o.y));
    const x1 = Math.max(...os.map(o => o.x + sizeOf(o)[0])), y1 = Math.max(...os.map(o => o.y + sizeOf(o)[1]));
    const z = clamp(Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad) / (y1 - y0)), ZMIN, 1.5);
    glideView({ z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z });
  }
  function centreOn(o) {
    const r = board.getBoundingClientRect(), z = st.view.z;
    const [w, hh] = sizeOf(o);
    glideView({ z, x: r.width / 2 - (o.x + w / 2) * z, y: r.height / 2 - (o.y + hh / 2) * z });
  }
  /** a screen point as a table point */
  function tablePt(cx, cy) {
    const r = board.getBoundingClientRect(), v = st.view;
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z };
  }
  /** the top left of a w x h piece centred on the screen, for a new piece */
  function middle(w = Cards.W, hh = Cards.H) {
    const r = board.getBoundingClientRect(), p = tablePt(r.left + r.width / 2, r.top + r.height / 2);
    return { x: p.x - w / 2, y: p.y - hh / 2 };
  }

  // ------------------------------------------------------------ drawing
  function draw() {
    if (!st.item) return;
    const ids = new Set(objs().map(o => o.id));
    for (const [id, el] of st.els) if (!ids.has(id)) { el.remove(); st.els.delete(id); }
    for (const id of st.sel) if (!ids.has(id)) st.sel.delete(id);
    for (const o of objs()) {
      const K = kindOf(o);
      let el = st.els.get(o.id);
      if (el && el.dataset.kind !== o.kind) { el.remove(); el = null; }
      if (!el) { el = h("div", { class: `gm-obj ${K.cls}`, "data-k-kind": o.kind }); el.dataset.id = o.id; el.dataset.kId = o.id; el.dataset.kind = o.kind; st.els.set(o.id, el); }
      const ts = o.kind === Cards.KIND ? textOf(o) : null;
      if (ts) Text.renderStack(el, o, ts); else K.render(el, o);
      el.classList.toggle("gm-tstack", !!ts);
      el.dataset.kLabel += ` at ${Math.round(o.x)} ${Math.round(o.y)}`;
      el.classList.toggle("gm-sel", st.sel.has(o.id));
      if (drag?.id !== o.id) { el.style.left = `${o.x}px`; el.style.top = `${o.y}px`; }
    }
    // drawing order = by layer (tiles, cards, meeples), then the objects' order (the last on top)
    const order = objs().map((o, i) => [o, i]).sort((a, b) => kindOf(a[0]).layer - kindOf(b[0]).layer || a[1] - b[1]);
    order.forEach(([o], i) => { const el = st.els.get(o.id); if (plane.children[i] !== el) plane.insertBefore(el, plane.children[i] || null); });
    hint.hidden = objs().length > 0;
    drawDone();
  }
  // ---- the selection: meeples, dice and tiles only (stacks belong to their deck)
  const selectable = o => !!o && (o.kind === Tiles.KIND || o.kind === Meeples.KIND || o.kind === Dice.KIND);
  function setSel(ids) {
    st.sel = new Set([...ids].filter(id => selectable(findO(id))));
    for (const [id, el] of st.els) el.classList.toggle("gm-sel", st.sel.has(id));
    drawDone();
  }
  /** one piece selected (or none) */
  const select = id => setSel(id ? [id] : []);
  function toggleSel(id) { const n = new Set(st.sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); }
  /** the selected pieces in drawing order, or null when fewer than two */
  const group = () => (st.sel.size > 1 ? objs().filter(o => st.sel.has(o.id)) : null);
  function drawDone() {
    board.classList.toggle("gm-many", st.sel.size > 1); // a group: no resize handles
    done.hidden = !st.multi || board.hidden;
    if (done.hidden) return;
    done.textContent = `Done (${st.sel.size})`;
    done.style.top = `${board.offsetTop + 8}px`;
  }
  function startMulti(id) { st.multi = true; setSel([...st.sel, id]); }
  function endMulti() { st.multi = false; drawDone(); }
  /** play a CSS animation class once on a stack */
  function pulse(id, cls, ms = 420) {
    const el = st.els.get(id); if (!el) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }
  /** FLIP: stacks drawn where they were, then eased to their new places */
  const spots = () => new Map(objs().map(o => [o.id, { x: o.x, y: o.y }]));
  function glideFrom(was, extra = new Map()) {
    for (const o of objs()) {
      const a = was.get(o.id) || extra.get(o.id), el = st.els.get(o.id);
      if (!a || !el || (a.x === o.x && a.y === o.y)) continue;
      el.classList.remove("glide");
      el.style.transform = `translate(${a.x - o.x}px, ${a.y - o.y}px)`;
      void el.offsetWidth;
      el.classList.add("glide"); el.style.transform = "";
      setTimeout(() => el.classList.remove("glide"), GLIDE + 60);
    }
  }

  // ------------------------------------------------------------ actions on the table
  function addDeckAt(x, y) {
    if (!st.item) return null;
    const p = x === undefined ? middle() : { x, y };
    const r = Cards.addDeck(table(), p.x, p.y);
    commit(r.state); pulse(r.stack, "gm-land");
    return r;
  }
  function addTextDeckAt(x, y, name) {
    if (!st.item) return null;
    const p = x === undefined ? middle() : { x, y };
    const r = Text.addTextDeck(table(), p.x, p.y, name);
    commit(r.state); pulse(r.stack, "gm-land");
    return r;
  }
  function doAddCard(setId, title, text) {
    const r = Text.addCard(table(), setId, title, text);
    commit(r.state); pulse(r.stack, "gm-land");
    return r;
  }
  const doEditCard = (setId, n, title, text) => commit(Text.editCard(table(), setId, n, title, text));
  const doRenameSet = (setId, name) => commit(Text.renameSet(table(), setId, name));
  function addMeepleAt(x, y, c) {
    if (!st.item) return null;
    const p = x === undefined ? middle(Meeples.W, Meeples.H) : { x, y };
    const r = Meeples.addMeeple(table(), p.x, p.y, c);
    commit(r.state); pulse(r.id, "gm-land");
    return r;
  }
  function addDieAt(x, y, c) {
    if (!st.item) return null;
    const p = x === undefined ? middle(Dice.W, Dice.H) : { x, y };
    const r = Dice.addDie(table(), p.x, p.y, c);
    commit(r.state); pulse(r.id, "gm-land");
    return r;
  }
  // ---- dice: roll = the new faces are saved at once (undo, other devices), the tumble only shows it
  const TUMBLE = 420; // ms
  const tumbles = new Map(); // die id -> the face flicker timer
  /** the tumble: the die spins and hops while random faces flicker, then lands on its value */
  function tumble(id) {
    const el = st.els.get(id), o = findO(id), v = el?.querySelector("svg"); if (!el || !o || !v) return;
    clearInterval(tumbles.get(id));
    const turn = (Dice.randomFace(2) === 1 ? 1 : -1) * (300 + 60 * Dice.randomFace(3));
    v.animate([{ transform: "rotate(0deg) scale(1)" }, { transform: `rotate(${turn * 0.55}deg) scale(1.16)`, offset: 0.45 },
      { transform: `rotate(${turn * 0.9}deg) scale(0.96)`, offset: 0.8 }, { transform: `rotate(${turn}deg) scale(1)` }],
      { duration: TUMBLE, easing: "cubic-bezier(.2,.7,.3,1)" });
    const tick = setInterval(() => { const q = findO(id); if (q) Dice.showFace(el, Dice.randomFace(q.sides), q.color); }, 70);
    el.dataset.tumbling = "1"; tumbles.set(id, tick);
    setTimeout(() => { if (tumbles.get(id) !== tick) return; clearInterval(tick); tumbles.delete(id); delete el.dataset.tumbling;
      const q = findO(id); if (q) Dice.render(el, q); }, TUMBLE - 40);
  }
  /** roll these dice (other ids are skipped); the ids rolled */
  function doRoll(ids) {
    const ds = ids.map(id => findO(String(id).trim())).filter(o => o?.kind === Dice.KIND).map(o => o.id);
    if (!ds.length) throw new Error(`not a die: ${ids.join(" ")}`);
    // the faces flicker from the first frame; the result is drawn when the tumble ends
    for (const id of ds) { const el = st.els.get(id); if (el) el.dataset.tumbling = "1"; }
    commit(Dice.roll(table(), ds));
    ds.forEach(tumble);
    return ds;
  }
  function doSetDie(id, v) {
    const o = needO(id); if (o.kind !== Dice.KIND) throw new Error(`${id} is not a die`);
    commit(Dice.setValue(table(), o.id, v)); pulse(o.id, "gm-land");
  }
  /** R: the die under the mouse (with the rest of the selection when it is selected), else the selected dice */
  function rollTargets() {
    const dice = [...st.sel].filter(id => findO(id)?.kind === Dice.KIND);
    const el = pst.ptr && document.elementFromPoint(pst.ptr.cx, pst.ptr.cy)?.closest?.(".gm-die");
    const over = el && plane.contains(el) ? el.dataset.id : "";
    if (over && !st.sel.has(over)) return [over];
    return dice;
  }
  function addTileAt(x, y, w, hh, c) {
    if (!st.item) return null;
    w ??= Tiles.SIZE; hh ??= Tiles.SIZE;
    const p = x === undefined ? middle(w, hh) : { x, y };
    const r = Tiles.addTile(table(), p.x, p.y, w, hh, c);
    commit(r.state); pulse(r.id, "gm-land"); select(r.id);
    return r;
  }
  function doColor(id, c) {
    const o = needO(id), v = parseColor(c);
    if (!v) throw new Error(`not a colour: ${c}`);
    commit(setColor(table(), o.id, v));
  }
  function doDuplicate(id) {
    const o = needO(id);
    const r = o.kind === Tiles.KIND ? Tiles.duplicate(table(), o.id) : o.kind === Meeples.KIND ? Meeples.duplicate(table(), o.id)
      : o.kind === Dice.KIND ? Dice.duplicate(table(), o.id) : null;
    if (!r) throw new Error(`only meeples, dice and tiles duplicate (${id} is a ${o.kind})`);
    commit(r.state); pulse(r.id, "gm-land");
    if (o.kind === Tiles.KIND) select(r.id);
    return r;
  }
  function doResize(id, w, hh) {
    const o = needO(id); if (o.kind !== Tiles.KIND) throw new Error(`${id} is not a tile`);
    commit(Tiles.resize(table(), o.id, w, hh));
  }
  function doLock(id, on) {
    const o = needO(id); if (o.kind !== Tiles.KIND) throw new Error(`${id} is not a tile`);
    if (on && st.sel.has(o.id) && st.sel.size === 1) select("");
    commit(Tiles.setLocked(table(), o.id, on));
  }
  // ---- copy + paste: where the next paste goes
  // last = {game, x, y, w} the previous paste (or the copied original);
  // ptr = the mouse over the table, moved = it moved since the last paste
  const pst = { last: null, ptr: null, moved: false };
  const STEP_MEEPLE = 50;
  /** pieces as a layout: items relative to the top left, the size (on the tile grid when tiles are in it) */
  function layout(ids) {
    const want = new Set(ids), os = objs().filter(o => want.has(o.id) && selectable(o));
    if (!os.length) return null;
    const sz = o => sizeOf(o), x0 = Math.min(...os.map(o => o.x)), y0 = Math.min(...os.map(o => o.y));
    let w = Math.max(...os.map(o => o.x + sz(o)[0])) - x0, hh = Math.max(...os.map(o => o.y + sz(o)[1])) - y0;
    const tiles = os.some(o => o.kind === Tiles.KIND);
    if (tiles) { w = Math.ceil(w / Tiles.SNAP) * Tiles.SNAP; hh = Math.ceil(hh / Tiles.SNAP) * Tiles.SNAP; }
    return { x: x0, y: y0, w, h: hh, tiles, items: os.map(o => ({ kind: o.kind, color: o.color, w: o.w, h: o.h, sides: o.sides, value: o.value, dx: o.x - x0, dy: o.y - y0 })) };
  }
  /** one new piece like a layout item, top left at (x, y) */
  const addLike = (state, it, x, y) => (it.kind === Tiles.KIND ? Tiles.addTile(state, x, y, it.w, it.h, it.color)
    : it.kind === Dice.KIND ? Dice.addDie(state, x, y, it.color, it.value, it.sides) : Meeples.addMeeple(state, x, y, it.color));
  /** new pieces from a layout's items with their top left at (x, y); they become the selection */
  function place(items, x, y) {
    let state = table(); const made = [];
    for (const it of items) {
      const r = addLike(state, it, x + it.dx, y + it.dy);
      state = r.state; made.push(r.id);
    }
    commit(state); made.forEach(id => pulse(id, "gm-land")); setSel(made);
    return made;
  }
  function doColorMany(ids, c, tag = "") {
    const v = parseColor(c); if (!v) throw new Error(`not a colour: ${c}`);
    let state = table();
    for (const id of ids) if (selectable(findO(id))) state = setColor(state, id, v);
    commit(state, tag);
  }
  function doLockMany(ids, on) {
    let state = table();
    for (const id of ids) if (findO(id)?.kind === Tiles.KIND) state = Tiles.setLocked(state, id, on);
    commit(state);
  }
  /** remove the selected meeples and tiles (locked tiles stay, cards never go) */
  function doDelete(ids) {
    const os = ids.map(findO).filter(selectable), gone = os.filter(Table.removable), kept = os.length - gone.length;
    if (!gone.length) { if (kept) say("Locked tiles stay: unlock them first (L)."); return 0; }
    commit(Table.removePieces(table(), gone.map(o => o.id)));
    const pl = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
    say(`Removed ${pl(gone.length, "piece")}${kept ? `; ${pl(kept, "locked tile")} kept` : ""}. Ctrl+Z brings ${gone.length === 1 ? "it" : "them"} back.`);
    clearTimeout(st.delT); st.delT = setTimeout(() => { if (note.textContent.startsWith("Removed")) say(""); }, 3000);
    return gone.length;
  }
  /** move the selected pieces by dx, dy (locked tiles stay; tiles keep to the grid) */
  function doNudge(ids, dx, dy) {
    let n = 0;
    for (const id of ids) {
      const o = findO(id); if (!selectable(o) || (o.kind === Tiles.KIND && o.locked)) continue;
      o.x = o.kind === Tiles.KIND ? Tiles.snap(o.x + dx) : Math.round(o.x + dx);
      o.y = o.kind === Tiles.KIND ? Tiles.snap(o.y + dy) : Math.round(o.y + dy); n++;
    }
    if (n) { draw(); save(false, "nudge"); }
    return n;
  }
  /** L: lock the selected tiles, or unlock them when all are locked */
  function toggleLock(ids) {
    const ts = ids.map(findO).filter(o => o?.kind === Tiles.KIND); if (!ts.length) return false;
    doLockMany(ts.map(o => o.id), !ts.every(o => o.locked));
    return true;
  }
  /** copies of the pieces directly to the right of them, the layout kept */
  function doDuplicateMany(ids) {
    const L = layout(ids); if (!L) return [];
    return place(L.items, L.x + L.w, L.y);
  }
  function doCopy(ids) {
    if (typeof ids === "string") ids = [ids];
    const L = layout(ids);
    if (!L) return false; // stacks: nothing
    CLIP = { items: L.items, w: L.w, h: L.h };
    const one = L.items.length === 1 ? findO(ids.find(id => selectable(findO(id)))) : null;
    pst.last = one ? { game: st.item.id, x: one.x, y: one.y, w: one.kind === Tiles.KIND ? one.w : 0 } : { game: st.item.id, x: L.x, y: L.y, w: L.w };
    pst.moved = false;
    for (const id of ids) pulse(id, "gm-copied", 360);
    const what = !one ? `${L.items.length} pieces` : one.kind === Tiles.KIND ? `${colorName(one.color).toLowerCase()} tile ${one.w} x ${one.h}`
      : one.kind === Dice.KIND ? `${colorName(one.color).toLowerCase()} d${one.sides}` : `${colorName(one.color).toLowerCase()} meeple`;
    say(`Copied ${one ? "the " : ""}${what}. ${lastType === "mouse" ? "Ctrl+V pastes" : "Long-press the table to paste"}.`);
    clearTimeout(pst.noteT); pst.noteT = setTimeout(() => { if (note.textContent.startsWith("Copied")) say(""); }, 2200);
    return true;
  }
  /** one copy of the clipboard at table point p (one piece: centred there; a group: its top left there),
   * or (no p) by the rules above */
  function doPaste(p) {
    if (!st.item || !CLIP) return null;
    if (!p && pst.moved && pst.ptr) {
      const r = board.getBoundingClientRect(), q = pst.ptr;
      if (q.cx >= r.left && q.cx <= r.right && q.cy >= r.top && q.cy <= r.bottom) p = tablePt(q.cx, q.cy);
    }
    const here = pst.last && pst.last.game === st.item.id;
    if (CLIP.items.length > 1) {
      const tiles = CLIP.items.some(it => it.kind === Tiles.KIND), sn = v => (tiles ? Tiles.snap(v) : Math.round(v));
      let x, y;
      if (p) { x = sn(p.x); y = sn(p.y); }
      else if (here) { x = pst.last.x + CLIP.w; y = pst.last.y; }
      else { const m = middle(CLIP.w, CLIP.h); x = sn(m.x); y = sn(m.y); }
      const made = place(CLIP.items, x, y);
      pst.last = { game: st.item.id, x, y, w: CLIP.w }; pst.moved = false;
      return { ids: made };
    }
    const c = CLIP.items[0], tile = c.kind === Tiles.KIND, die = c.kind === Dice.KIND;
    const w = tile ? c.w : die ? Dice.W : Meeples.W, hh = tile ? c.h : die ? Dice.H : Meeples.H;
    let x, y;
    if (p) { x = p.x - w / 2; y = p.y - hh / 2; }
    else if (here) { x = pst.last.x + (tile ? (pst.last.w || w) : die ? Dice.W + 8 : STEP_MEEPLE); y = pst.last.y; }
    else ({ x, y } = middle(w, hh));
    const r = addLike(table(), c, x, y);
    commit(r.state); pulse(r.id, "gm-land"); select(r.id);
    const o = findO(r.id);
    pst.last = { game: st.item.id, x: o.x, y: o.y, w: tile ? o.w : 0 }; pst.moved = false;
    return r;
  }
  function doFlip(id) { commit(Cards.flipStack(table(), needO(id).id)); pulse(id, "gm-flip", 260); }
  function doShuffle(id) { commit(Cards.shuffleStack(table(), needO(id).id)); pulse(id, "gm-shuf", 520); }
  /** Draw: the top card face up beside the deck, ready to drag */
  function doDraw(id, n = 1) {
    let o = needO(id), state = table(), made = [];
    n = clamp(Math.floor(n) || 1, 1, o.cards.length - 1);
    if (o.cards.length < 2) throw new Error("a single card cannot be drawn from");
    const was = spots();
    for (let i = 0; i < n; i++) {
      const spot = Cards.freeSpot(state, o.x, o.y);
      const r = Cards.take(state, o.id, 1, spot.x, spot.y, true);
      state = r.state; made.push(r.stack);
    }
    commit(state);
    const from = new Map(made.map(m => [m, { x: o.x, y: o.y }]));
    glideFrom(was, from);
    return made;
  }
  function doGather(ref) {
    ref = String(ref || "").trim();
    const set = (data().sets || []).find(s => s.id === ref) ? ref : findO(ref)?.set;
    if (!set) throw new Error(`no set or stack ${ref}`);
    const ts = Text.isText((data().sets || []).find(s => s.id === set));
    const was = spots(), r = ts ? Cards.gather(table(), set, Text.freshCards) : Cards.gather(table(), set);
    // the gathered stacks fly to the deck's home before they disappear into it
    const home = r.state.sets.find(s => s.id === set);
    for (const o of objs()) if (o.set === set && o.id !== r.stack) {
      const el = st.els.get(o.id); if (!el) continue;
      el.classList.add("glide", "gm-gone"); el.style.transform = `translate(${home.x - o.x}px, ${home.y - o.y}px)`;
    }
    setTimeout(() => { commit(r.state); glideFrom(was); pulse(r.stack, "gm-land"); }, objs().some(o => o.set === set && o.id !== r.stack) ? GLIDE : 0);
    return r;
  }
  function doMove(id, x, y) {
    const o = needO(id), was = spots();
    if (o.kind === Tiles.KIND) { x = Tiles.snap(x); y = Tiles.snap(y); }
    commit(Cards.moveTo(table(), o.id, x, y)); glideFrom(was);
  }
  /** a dropped stack onto another: merge within one set, else a bounce and it lands beside */
  function dropOnto(from, onto) {
    const r = Cards.merge(table(), from, onto);
    if (r.ok) { commit(r.state); pulse(onto, "gm-land"); return true; }
    const t = needO(onto), spot = Cards.freeSpot(table(), t.x, t.y, from), was = spots();
    commit(Cards.moveTo(table(), from, spot.x, spot.y)); glideFrom(was);
    pulse(onto, "gm-refuse", 420);
    say("Those cards belong to another deck: not merged.");
    setTimeout(() => { if (note.textContent.startsWith("Those cards")) say(""); }, 2500);
    return false;
  }

  // ------------------------------------------------------------ the menu (right-click / long-press)
  let openedAt = 0, byHold = false;
  function closeMenu() { menu.hidden = true; menu.replaceChildren(); }
  // the lifting finger of a long-press is not a choice
  const early = () => byHold && performance.now() - openedAt < 350;
  const choose = fn => () => { if (early()) return; closeMenu(); try { fn(); } catch (e) { say(e.message, true); } };
  /** items: [label, tip, fn] rows, or ready elements (the colour swatches) */
  function openMenu(cx, cy, items, heading, hold = lastType !== "mouse") {
    menu.replaceChildren(
      ...(heading ? [h("div", { class: "gm-menu-h" }, heading)] : []),
      ...items.map(it => (it instanceof Element ? it : h("button", { class: "k-pop-i", type: "button", role: "menuitem", "data-tip": it[1], onclick: choose(it[2]) }, it[0]))));
    menu.hidden = false; openedAt = performance.now(); byHold = hold;
    const r = box.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${clamp(cx - r.left, 4, r.width - mw - 4)}px`;
    menu.style.top = `${clamp(cy - r.top, 4, r.height - mh - 4)}px`;
  }
  /** a small form in the menu: a title line and a text box (a text card), or one line (a deck's name) */
  function cardForm(cx, cy, heading, vals, onSave, textBox = true) {
    const t = h("input", { class: "gm-in", type: "text", maxlength: String(textBox ? Text.MAX_TITLE : Text.MAX_NAME), placeholder: textBox ? "Title" : "Name", "aria-label": textBox ? "Title" : "Name" });
    t.value = vals.title || "";
    const x = textBox ? h("textarea", { class: "gm-in gm-ta", rows: "5", maxlength: String(Text.MAX_TEXT), placeholder: "Text", "aria-label": "Text" }) : null;
    if (x) x.value = vals.text || "";
    const ok = () => { try { onSave(t.value, x ? x.value : ""); closeMenu(); } catch (e) { say(e.message, true); } };
    const key = e => { if (e.key === "Enter" && (e.target === t || e.ctrlKey || e.metaKey)) { e.preventDefault(); ok(); } };
    t.addEventListener("keydown", key); x?.addEventListener("keydown", key);
    const form = h("div", { class: "gm-form" }, t, x,
      h("div", { class: "gm-form-row" },
        h("button", { class: "k-pop-i", type: "button", "data-tip": "Close without saving  (Esc)", onclick: () => closeMenu() }, "Cancel"),
        h("button", { class: "k-pop-i gm-save", type: "button", "data-tip": textBox ? "Save the card; Undo takes it back  (Ctrl+Enter)" : "Save the name  (Enter)", onclick: ok }, "Save")));
    openMenu(cx, cy, [form], heading, false);
    setTimeout(() => t.focus(), 30);
  }
  /** a text deck's stack (or its empty slot): the card actions plus Add card, Edit text, Rename deck */
  function textMenu(o, set, cx, cy) {
    const n = o.cards.length, t = Cards.topCard(o), items = [];
    if (n) items.push([n > 1 ? "Flip stack" : "Flip", n > 1 ? "Turn the whole stack over (its order reverses)  (F)" : "Turn the card over  (F)", () => doFlip(o.id)]);
    if (n > 1) items.push(["Draw", "Put the top card face up beside the deck  (D)", () => doDraw(o.id)], ["Shuffle", "Shuffle this stack  (S)", () => doShuffle(o.id)]);
    if (n) {
      const c = Text.cardOf(set, t);
      items.push(["Edit text", `Change the title and text of card ${t.n}${t.up ? "" : " (the top card, face down)"}`,
        () => cardForm(cx, cy, `${set.name}: card ${t.n}`, c, (a, b) => doEditCard(set.id, t.n, a, b))]);
    }
    items.push(["Add card", `A new card for ${set.name}, face down at the bottom of the deck at its home`,
      () => cardForm(cx, cy, `${set.name}: new card ${set.cards.length + 1}`, {}, (a, b) => doAddCard(set.id, a, b))]);
    items.push(["Rename deck", "The name on the backs of its cards", () => cardForm(cx, cy, "Deck name", { title: set.name }, a => doRenameSet(set.id, a), false)]);
    if (set.cards.length) items.push(["Gather", `Every card of this deck back here: the full deck in order, face down  (G)`, () => doGather(o.set)]);
    const c = n ? Text.cardOf(set, t) : null;
    openMenu(cx, cy, items, !n ? `${set.name}: no cards yet` : n > 1 ? `${set.name}: ${n} cards` : t.up ? `${set.name} ${t.n}: ${c.title || "card"}` : `${set.name} card, face down`);
  }
  function stackMenu(id, cx, cy) {
    const o = findO(id); if (!o) return;
    const ts = textOf(o); if (ts) return textMenu(o, ts, cx, cy);
    const n = o.cards.length, t = Cards.topCard(o);
    const items = [[n > 1 ? "Flip stack" : "Flip", n > 1 ? "Turn the whole stack over (its order reverses)  (F)" : "Turn the card over  (F)", () => doFlip(id)]];
    if (n > 1) items.push(["Draw", "Put the top card face up beside the deck  (D)", () => doDraw(id)]);
    if (n > 1) items.push(["Shuffle", "Shuffle this stack  (S)", () => doShuffle(id)]);
    items.push(["Gather", `Every card of this deck back here: one full ordered deck, face down  (G)`, () => doGather(o.set)]);
    openMenu(cx, cy, items, n > 1 ? `${n} cards` : t.up ? Cards.cardLong(t.c) : "Card, face down");
  }
  /** what can be added: at a table point, or (no point) the middle of the screen */
  const addItems = p => [
    ["Poker deck", "A new 52-card deck, face down", () => (p ? addDeckAt(p.x - Cards.W / 2, p.y - Cards.H / 2) : addDeckAt())],
    ["Meeple", "A standing player piece; pick its colour in its menu", () => (p ? addMeepleAt(p.x - Meeples.W / 2, p.y - Meeples.H / 2) : addMeepleAt())],
    [Text.TITLE, `Your own cards with a title and text (a deck named ${Text.DEFAULT_NAME}, no cards yet): add them from its menu`, () => (p ? addTextDeckAt(p.x - Cards.W / 2, p.y - Cards.H / 2) : addTextDeckAt())],
    [Dice.TITLE, "A six-sided die: double-click / double-tap or R rolls it; pick its colour in its menu", () => (p ? addDieAt(p.x - Dice.W / 2, p.y - Dice.H / 2) : addDieAt())],
    ["Tile", "A square to build boards and mats from: resize, colour, duplicate, lock", () => (p ? addTileAt(p.x - Tiles.SIZE / 2, p.y - Tiles.SIZE / 2) : addTileAt())],
  ];
  function tableMenu(cx, cy) {
    const p = tablePt(cx, cy);
    const paste = !CLIP ? [] : [["Paste", CLIP.items.length > 1 ? `The ${CLIP.items.length} copied pieces, their top left here`
      : `Another ${CLIP.items[0].kind === Tiles.KIND ? "tile" : CLIP.items[0].kind === Dice.KIND ? "die" : "meeple"} like the copied one, here`, () => doPaste(p)]];
    const H = hist(), back = [
      ...(H?.canUndo() ? [["Undo", "Take back the last change on the table  (Ctrl+Z)", () => undoRedo(false)]] : []),
      ...(H?.canRedo() ? [["Redo", "Do the undone change again  (Ctrl+Shift+Z)", () => undoRedo(true)]] : []),
      ...(lastType === "mouse" ? [["Keys…", "The keyboard shortcuts  (?)", () => showKeys(true)]] : [])];
    openMenu(cx, cy, [...paste, ...addItems(p), ...back], "Add to the table");
  }
  // ---- the keys sheet (?)
  const KEYS = [["Del / Backspace", "remove the selected pieces"], ["Ctrl+Z", "undo"], ["Ctrl+Shift+Z, Ctrl+Y", "redo"],
    ["Ctrl+C / Ctrl+V", "copy / paste pieces"], ["Ctrl+D", "duplicate the selection"], ["Ctrl+A", "select all pieces"],
    ["Esc", "clear the selection"], ["Arrows", "nudge 10 px (Shift: 50 px)"], ["L", "lock / unlock the selected tiles"],
    ["R", "roll the die under the mouse, or the selected dice"],
    ["F / S / D / G", "over a stack: flip, shuffle, draw, gather"], ["Shift+click", "add or remove a piece (also Ctrl+click)"],
    ["Left drag", "select with a box"], ["Middle drag", "pan"], ["Wheel", "zoom"], ["?", "this sheet"]];
  function showKeys(on) {
    keysEl.hidden = !on; if (!on) return;
    keysEl.replaceChildren(h("div", { class: "gm-menu-h" }, "Keys"),
      h("dl", { class: "gm-keyl" }, KEYS.flatMap(([k, d]) => [h("dt", {}, ...k.split(/(\s*[\/,+]\s*)/).map((x, i) => (i % 2 ? x : h("kbd", {}, x)))), h("dd", {}, d)])));
  }
  /** the + at the top right: the same choices, under the button */
  function addMenu() {
    const r = addBtn.getBoundingClientRect();
    openMenu(r.right, r.bottom + 4, addItems(null), "Add to the table", false);
    const m = menu.getBoundingClientRect(), b = box.getBoundingClientRect();
    menu.style.left = `${clamp(r.right - b.left - m.width, 4, b.width - m.width - 4)}px`;
  }
  /** the colour swatches + Custom colour, for meeples and tiles */
  function colorItems(o, cx, cy, ids = [o.id]) {
    const all = ids.map(findO).filter(Boolean), cur = all.every(q => q.color === o.color) ? o.color : "";
    const row = h("div", { class: "gm-sws", role: "group", "aria-label": "Colour" },
      PALETTE.map(p => h("button", { class: `gm-sw${cur === p.hex ? " on" : ""}`, type: "button", style: `--sw:${p.hex}`, "data-tip": p.name, "aria-label": p.name,
        onclick: choose(() => doColorMany(ids, p.hex)) })));
    const custom = () => {
      const r = box.getBoundingClientRect();
      picker.style.left = `${clamp(cx - r.left, 0, r.width - 2)}px`; picker.style.top = `${clamp(cy - r.top, 0, r.height - 2)}px`;
      picker.value = o.color;
      picker.oninput = () => { try { doColorMany(ids, picker.value, "picker"); } catch (e) { say(e.message, true); } };
      picker.onchange = picker.oninput;
      picker.click();
    };
    return [row, ["Custom colour…", "Any colour, from the colour picker", custom]];
  }
  function meepleMenu(o, cx, cy) {
    openMenu(cx, cy, [...colorItems(o, cx, cy), ["Duplicate", "Another meeple of this colour beside it  (Ctrl+D)", () => doDuplicate(o.id)],
      ["Copy", "Copy it; paste copies with Ctrl+V or from the table's menu  (Ctrl+C)", () => doCopy(o.id)],
      ["Delete", "Remove it; Undo brings it back  (Del, Ctrl+Z)", () => doDelete([o.id])], ...more(o)], `${colorName(o.color)} meeple`);
  }
  function dieMenu(o, cx, cy) {
    const faces = h("div", { class: "gm-faces", role: "group", "aria-label": "Set value" },
      Array.from({ length: o.sides }, (_, i) => i + 1).map(v => h("button", { class: `gm-face-b${o.value === v ? " on" : ""}`, type: "button",
        "data-tip": `Turn it to ${v}`, "aria-label": `Set value ${v}`, onclick: choose(() => doSetDie(o.id, v)) }, String(v))));
    openMenu(cx, cy, [["Roll", "Roll it  (double-click, R)", () => doRoll([o.id])],
      h("div", { class: "gm-menu-h" }, "Set value"), faces, ...colorItems(o, cx, cy),
      ["Duplicate", "Another die like it beside it  (Ctrl+D)", () => doDuplicate(o.id)],
      ["Copy", "Copy it; paste copies with Ctrl+V or from the table's menu  (Ctrl+C)", () => doCopy(o.id)],
      ["Delete", "Remove it; Undo brings it back  (Del, Ctrl+Z)", () => doDelete([o.id])], ...more(o)], `${colorName(o.color)} d${o.sides}, shows ${o.value}`);
  }
  /** phone: Select more (desktop has Shift / Ctrl + click) */
  const more = o => (lastType === "mouse" || st.multi ? [] : [["Select more", "Tap more pieces to add them; Done ends", () => startMulti(o.id)]]);
  function tileMenu(o, cx, cy) {
    openMenu(cx, cy, [...colorItems(o, cx, cy),
      ["Duplicate", "A copy directly to its right, same size and colour  (Ctrl+D)", () => doDuplicate(o.id)],
      ["Copy", "Copy it; paste copies with Ctrl+V or from the table's menu  (Ctrl+C)", () => doCopy(o.id)],
      o.locked ? ["Unlock", "Let the tile move and resize again  (L)", () => doLock(o.id, false)]
        : ["Lock", "Keep it in place: drags on it pan the table  (L)", () => doLock(o.id, true)],
      ...(o.locked ? [] : [["Delete", "Remove it; Undo brings it back  (Del, Ctrl+Z)", () => doDelete([o.id])]]), ...more(o)],
      `${colorName(o.color)} tile, ${o.w} x ${o.h}${o.locked ? ", locked" : ""}`);
  }
  /** several selected: the menu acts on all of them */
  function groupMenu(o, cx, cy) {
    const os = group(), ids = os.map(q => q.id), tiles = os.filter(q => q.kind === Tiles.KIND), n = os.length;
    const dice = os.filter(q => q.kind === Dice.KIND), nd = dice.length;
    const nm = tiles.length, nmp = n - nm - nd, pl = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
    const lockAll = tiles.length && tiles.every(q => q.locked) ? ["Unlock all", "Let the selected tiles move and resize again  (L)", () => doLockMany(ids, false)]
      : ["Lock all", "Keep the selected tiles in place  (L)", () => doLockMany(ids, true)];
    const nDel = os.filter(Table.removable).length;
    openMenu(cx, cy, [...(nd ? [[nd === 1 ? "Roll the die" : `Roll ${nd} dice`, "Roll the selected dice  (R)", () => doRoll(dice.map(q => q.id))]] : []),
      ...colorItems(o, cx, cy, ids),
      ["Duplicate", `Copies of all ${n} directly to the right of them, in the same layout  (Ctrl+D)`, () => doDuplicateMany(ids)],
      ["Copy", "Copy them; Ctrl+V or the table's menu pastes the group  (Ctrl+C)", () => doCopy(ids)],
      ...(tiles.length ? [lockAll] : []),
      ...(nDel ? [[nDel === n ? "Delete" : `Delete ${nDel}`, `Remove ${nDel === n ? "them" : `the ${nDel} not locked`}; Undo brings them back  (Del, Ctrl+Z)`, () => doDelete(ids)]] : []),
      ...(lastType !== "mouse" && !st.multi ? [["Select more", "Tap more pieces to add or remove them; Done ends", () => startMulti(o.id)]] : []),
      ["Clear selection", "Unselect all  (Esc)", () => { endMulti(); select(""); }]],
      `${n} selected: ${[nm ? pl(nm, "tile") : "", nmp ? pl(nmp, "meeple") : "", nd ? (nd === 1 ? "1 die" : `${nd} dice`) : ""].filter(Boolean).join(", ")}`);
  }
  function objMenu(id, cx, cy) {
    const o = findO(id); if (!o) return;
    if (selectable(o) && st.sel.has(o.id) && st.sel.size > 1) return groupMenu(o, cx, cy);
    if (o.kind === Meeples.KIND) return meepleMenu(o, cx, cy);
    if (o.kind === Dice.KIND) return dieMenu(o, cx, cy);
    if (o.kind === Tiles.KIND) return tileMenu(o, cx, cy);
    return stackMenu(id, cx, cy);
  }
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !menu.hidden) { closeMenu(); e.stopPropagation(); } }, true);
  const typing = t => !!t?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");
  document.addEventListener("pointerdown", e => { if (!keysEl.hidden && !keysEl.contains(e.target)) showKeys(false); }, true);
  /** the stack under the mouse, for F / S / D / G */
  const hoverStack = () => (pst.ptr ? hitStack(tablePt(pst.ptr.cx, pst.ptr.cy)) : null);
  document.addEventListener("keydown", e => {
    if (!st.item || board.hidden || !board.getClientRects().length || ctx.levels.current() !== ME) return;
    if (typing(e.target) || typing(document.activeElement)) return; // the chat field keeps its keys
    if (drag || boxSel) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key, cmd = e.ctrlKey || e.metaKey, sel = [...st.sel];
    const act = fn => { e.preventDefault(); try { fn(); } catch (err) { say(err.message, true); } };
    if (k === "Escape") {
      if (!keysEl.hidden) { showKeys(false); return; }
      if (menu.hidden && (st.sel.size || st.multi)) { endMulti(); select(""); }
      return;
    }
    if (e.altKey) return;
    if (cmd) {
      if (k === "z") return act(() => undoRedo(e.shiftKey));
      if (k === "y" && !e.shiftKey) return act(() => undoRedo(true));
      if (e.shiftKey) return;
      if (k === "c") {
        if (String(window.getSelection?.() || "")) return; // selected page text copies as usual
        if (st.sel.size && doCopy(sel)) e.preventDefault();
      } else if (k === "v" && CLIP) act(() => doPaste());
      else if (k === "d") act(() => { if (sel.length) doDuplicateMany(sel); });
      else if (k === "a") act(() => setSel(objs().filter(selectable).map(o => o.id)));
      return;
    }
    if (k === "?") return act(() => showKeys(keysEl.hidden));
    if (k === "Delete" || k === "Backspace") { if (sel.length) act(() => doDelete(sel)); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[k]) { if (sel.length) { const n = e.shiftKey ? 50 : 10; act(() => doNudge(sel, arrows[k][0] * n, arrows[k][1] * n)); } return; }
    if (e.shiftKey) return;
    if (k === "l") { if (sel.length) act(() => toggleLock(sel)); return; }
    if (k === "r") { const ds = rollTargets(); if (ds.length) act(() => { closeMenu(); doRoll(ds); }); return; }
    if ("fsdg".includes(k) && k.length === 1) {
      const o = hoverStack(); if (!o) return;
      act(() => { closeMenu(); if (k === "f") doFlip(o.id); else if (k === "s") doShuffle(o.id); else if (k === "g") doGather(o.set);
        else if (o.cards.length > 1) doDraw(o.id); });
    }
  });

  // ------------------------------------------------------------ gestures
  // presses on a stack: drag (move or draw), hold (menu), double tap (flip);
  // presses on empty table: pan, hold (menu); two fingers: pinch
  let drag = null;            // the stack being pressed or dragged
  const pans = new Map();     // pointer id -> last point, presses on empty table
  let pinch = null, lastType = "mouse", lastTap = { id: "", t: 0 };
  const objAt = e => e.target.closest?.(".gm-obj");
  function hitStack(p, skip) {
    const os = objs();
    for (let i = os.length - 1; i >= 0; i--) {
      const o = os[i];
      if (o.kind === Cards.KIND && o.id !== skip && p.x >= o.x && p.x <= o.x + Cards.W && p.y >= o.y && p.y <= o.y + Cards.H) return o;
    }
    return null;
  }
  function markTarget(t, ok) {
    for (const el of plane.querySelectorAll(".gm-over, .gm-no")) el.classList.remove("gm-over", "gm-no");
    if (t) st.els.get(t.id)?.classList.add(ok ? "gm-over" : "gm-no");
  }
  board.addEventListener("pointerdown", e => {
    // the middle mouse button always pans, even over pieces
    const mid = e.pointerType === "mouse" && e.button === 1;
    if (!st.item || (e.pointerType === "mouse" && e.button !== 0 && !mid)) return;
    lastType = e.pointerType;
    cancelAnimationFrame(viewGlide);
    if (mid) e.preventDefault(); // no autoscroll
    const oEl = !mid && objAt(e), hit = oEl && findO(oEl.dataset.id);
    // Shift / Ctrl / Cmd: add or remove pieces (on empty table: drag a box)
    const mod = e.pointerType === "mouse" && (e.shiftKey || e.ctrlKey || e.metaKey);
    const locked = hit && hit.kind === Tiles.KIND && hit.locked;
    // a locked tile passes the press through to the table (pan), keeping only its menu;
    // while selecting (modifier, phone select mode) it can be picked
    const through = locked && !mod && !st.multi ? hit : null;
    // desktop: a left drag on empty table (or a locked tile) draws the selection box;
    // the middle button pans; Shift / Ctrl / Cmd add to the selection
    if ((!hit || through) && e.pointerType === "mouse" && !mid && !drag && !pans.size) {
      board.setPointerCapture(e.pointerId);
      boxSel = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, base: new Set(mod ? st.sel : []), moved: false, mod };
      e.preventDefault();
      return;
    }
    if (hit && !through && !drag && !pans.size) {
      const o = hit;
      if (o.kind === Cards.KIND && !mod && !st.multi) select(""); // stacks are not copied: the selection goes
      board.setPointerCapture(e.pointerId);
      const p = tablePt(e.clientX, e.clientY);
      drag = { id: o.id, kind: o.kind, pid: e.pointerId, sx: e.clientX, sy: e.clientY, mode: "", off: { x: p.x - o.x, y: p.y - o.y }, p0: p,
        whole: !!e.target.closest(".gm-badge") || e.shiftKey, resize: o.kind === Tiles.KIND && !!e.target.closest(".gm-handle"), w0: o.w, h0: o.h, timer: 0, held: false,
        toggle: mod, locked };
      if (e.pointerType !== "mouse") drag.timer = setTimeout(() => { if (drag && !drag.mode) { drag.held = true; objMenu(drag.id, drag.sx, drag.sy); } }, HOLD);
      e.preventDefault();
      return;
    }
    if (drag) return;
    if (!through && !mid && !st.multi && pans.size === 0) select("");
    board.setPointerCapture(e.pointerId);
    pans.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (pans.size === 2) {
      clearTimeout(tableHold);
      const [a, b] = [...pans.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: st.view.z };
    } else if (e.pointerType !== "mouse") {
      const cx = e.clientX, cy = e.clientY;
      tableHold = setTimeout(() => { const q = pans.get(e.pointerId); if (q && pans.size === 1 && Math.hypot(q.x - q.sx, q.y - q.sy) < SLOP) (through ? objMenu(through.id, cx, cy) : tableMenu(cx, cy)); }, HOLD);
    }
    board.classList.add("panning"); moving();
  });
  let tableHold = 0, boxSel = null;
  /** the box from the press to (cx, cy): drawn, and every piece it touches selected (plus the earlier selection) */
  function moveBox(cx, cy) {
    const b = boxSel; if (Math.hypot(cx - b.sx, cy - b.sy) >= SLOP) b.moved = true;
    if (!b.moved) return;
    const r = board.getBoundingClientRect();
    const l = Math.min(b.sx, cx), t = Math.min(b.sy, cy), w = Math.abs(cx - b.sx), hh = Math.abs(cy - b.sy);
    Object.assign(boxEl.style, { left: `${l - r.left}px`, top: `${t - r.top}px`, width: `${w}px`, height: `${hh}px` });
    boxEl.hidden = false;
    const a = tablePt(l, t), z = tablePt(l + w, t + hh);
    const hits = objs().filter(o => { if (!selectable(o)) return false; const [ow, oh] = sizeOf(o); return o.x <= z.x && o.x + ow >= a.x && o.y <= z.y && o.y + oh >= a.y; });
    setSel([...b.base, ...hits.map(o => o.id)]);
  }
  board.addEventListener("pointermove", e => {
    if (boxSel && e.pointerId === boxSel.pid) { moveBox(e.clientX, e.clientY); return; }
    if (drag && e.pointerId === drag.pid) {
      if (!drag.mode) {
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < SLOP || drag.held) return;
        clearTimeout(drag.timer); closeMenu();
        if (drag.locked) {
          // a locked tile picked while selecting: dragging it pans the table instead
          const d = drag; drag = null;
          pans.set(d.pid, { x: e.clientX, y: e.clientY, sx: d.sx, sy: d.sy });
          board.classList.add("panning"); moving();
          return;
        }
        const o = findO(drag.id);
        if (drag.resize) drag.mode = "resize";
        else if (o.kind === Cards.KIND && o.cards.length > 1 && !drag.whole) {
          // dragging a deck's top card off draws it
          const r = Cards.take(table(), o.id, 1, o.x, o.y);
          data().sets = r.state.sets; data().objects = r.state.objects; draw();
          drag.id = r.stack; drag.mode = "draw";
        } else {
          drag.mode = "move";
          // a selected piece of several carries the others (locked tiles stay)
          const g = selectable(o) && st.sel.has(o.id) ? group()?.filter(q => !(q.kind === Tiles.KIND && q.locked)) : null;
          if (g && g.length > 1) {
            drag.group = g.map(q => q.id); drag.snap = g.some(q => q.kind === Tiles.KIND);
            const gs = new Set(drag.group);
            data().objects = objs().filter(q => !gs.has(q.id)).concat(g); draw();
          } else { data().objects = objs().filter(q => q.id !== o.id).concat(o); draw(); } // lifted to the top
        }
        if (!drag.group && !drag.toggle && !st.multi && selectable(o)) select(drag.id);
        for (const id of drag.group || [drag.id]) st.els.get(id)?.classList.add("gm-drag");
      }
      const p = tablePt(e.clientX, e.clientY), o = findO(drag.id), el = st.els.get(drag.id);
      if (drag.mode === "resize") {
        // the handle follows the pointer; the size snaps to the grid
        drag.w = Tiles.side(drag.w0 + p.x - drag.p0.x); drag.h = Tiles.side(drag.h0 + p.y - drag.p0.y);
        if (el) { el.style.width = `${drag.w}px`; el.style.height = `${drag.h}px`; }
        return;
      }
      drag.x = p.x - drag.off.x; drag.y = p.y - drag.off.y;
      if (drag.group) {
        // the whole group moves by one offset (on the tile grid when tiles are in it)
        let dx = drag.x - o.x, dy = drag.y - o.y;
        if (drag.snap) { dx = Tiles.snap(dx); dy = Tiles.snap(dy); }
        drag.dx = dx; drag.dy = dy;
        for (const id of drag.group) { const ge = st.els.get(id); if (ge) ge.style.transform = `translate(${dx}px, ${dy}px)`; }
        return;
      }
      if (o.kind === Tiles.KIND) { drag.x = Tiles.snap(drag.x); drag.y = Tiles.snap(drag.y); } // tiles butt edge to edge
      if (el) el.style.transform = `translate(${drag.x - o.x}px, ${drag.y - o.y}px)`;
      if (o.kind === Cards.KIND) { const t = hitStack(p, drag.id); markTarget(t, t && t.set === o.set); }
      return;
    }
    const q = pans.get(e.pointerId); if (!q) return;
    const dx = e.clientX - q.x, dy = e.clientY - q.y;
    q.x = e.clientX; q.y = e.clientY;
    if (pans.size >= 2 && pinch) {
      const [a, b] = [...pans.values()], r = board.getBoundingClientRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const v = st.view;
      // both fingers' midpoint moves the table; their spread zooms around it
      setView({ x: v.x + dx / 2, y: v.y + dy / 2 });
      zoomAt(pinch.z * d / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      return;
    }
    if (Math.hypot(q.x - q.sx, q.y - q.sy) >= SLOP) clearTimeout(tableHold);
    setView({ x: st.view.x + dx, y: st.view.y + dy });
  });
  function endDrag(e, cancelled = false) {
    const d = drag; drag = null;
    clearTimeout(d.timer);
    markTarget(null);
    const el = st.els.get(d.id);
    el?.classList.remove("gm-drag");
    if (!d.mode) {
      if (d.held || cancelled) return;
      if (d.kind === Tiles.KIND || d.kind === Meeples.KIND || d.kind === Dice.KIND) {
        // a tap selects a piece (a tile shows its resize handle); with Shift / Ctrl or in select mode it adds or removes it
        if (d.toggle || st.multi) { toggleSel(d.id); return; }
        select(d.id);
        if (d.kind !== Dice.KIND) return;
        // a second tap (or click) on the same die soon after rolls it
        const now = performance.now();
        if (lastTap.id === d.id && now - lastTap.t < 350) { lastTap = { id: "", t: 0 }; doRoll([d.id]); }
        else lastTap = { id: d.id, t: now };
        return;
      }
      if (d.kind !== Cards.KIND) return;
      // a tap; a second tap (or click) on the same stack soon after flips it.
      // (no dblclick listener: with the pointer captured it targets the table)
      const now = performance.now();
      if (lastTap.id === d.id && now - lastTap.t < 350) { lastTap = { id: "", t: 0 }; doFlip(d.id); }
      else lastTap = { id: d.id, t: now };
      return;
    }
    if (d.group) {
      for (const id of d.group) { const ge = st.els.get(id); if (ge) { ge.classList.remove("gm-drag"); ge.style.transform = ""; } }
      if (!cancelled && d.dx !== undefined) for (const id of d.group) { const q = findO(id); if (q) { q.x = Math.round(q.x + d.dx); q.y = Math.round(q.y + d.dy); } }
      draw(); save(); return;
    }
    if (el) el.style.transform = "";
    const o = findO(d.id);
    if (d.mode === "resize") {
      if (!cancelled && d.w !== undefined) { o.w = d.w; o.h = d.h; }
      draw(); save(); return;
    }
    if (cancelled || d.x === undefined) { draw(); save(); return; }
    const t = o.kind === Cards.KIND ? hitStack(tablePt(e.clientX, e.clientY), d.id) : null;
    o.x = Math.round(d.x); o.y = Math.round(d.y);
    if (el) { el.style.left = `${o.x}px`; el.style.top = `${o.y}px`; }
    if (t) dropOnto(d.id, t.id); else { draw(); save(); }
  }
  function endPan(e) {
    if (!pans.has(e.pointerId)) return;
    pans.delete(e.pointerId); clearTimeout(tableHold);
    if (pans.size < 2) pinch = null;
    if (pans.size === 1) { const [q] = pans.values(); q.sx = q.x; q.sy = q.y; }
    if (!pans.size) { board.classList.remove("panning"); moving(); }
  }
  function endBox(e) { if (e && e.pointerId !== boxSel.pid) return false; if (!boxSel.moved && !boxSel.mod && !st.multi) select(""); boxSel = null; boxEl.hidden = true; return true; }
  board.addEventListener("pointerup", e => { if (boxSel && endBox(e)) return; if (drag && e.pointerId === drag.pid) endDrag(e); else endPan(e); });
  board.addEventListener("pointercancel", e => { if (boxSel && endBox(e)) return; if (drag && e.pointerId === drag.pid) endDrag(e, true); else endPan(e); });
  board.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (!st.item || lastType !== "mouse") return; // touch: the hold timers open the menu
    const s = objAt(e);
    if (s) objMenu(s.dataset.id, e.clientX, e.clientY); else tableMenu(e.clientX, e.clientY);
  });
  board.addEventListener("wheel", e => {
    if (!st.item) return;
    e.preventDefault();
    cancelAnimationFrame(viewGlide);
    const r = board.getBoundingClientRect();
    zoomAt(st.view.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // where the mouse is, for Ctrl+V at the pointer
  board.addEventListener("pointermove", e => { if (e.pointerType === "mouse") { pst.ptr = { cx: e.clientX, cy: e.clientY }; pst.moved = true; } });
  board.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") pst.ptr = null; });
  // middle button: no autoscroll, no X11 primary paste
  board.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });
  board.addEventListener("auxclick", e => { if (e.button === 1) e.preventDefault(); });
  // mouse presses remember their type for the contextmenu check
  board.addEventListener("pointerdown", e => { lastType = e.pointerType; }, true);

  // ------------------------------------------------------------ the agent: describe + @lines
  const describeList = () => {
    const line = it => `- ${it.id} | ${(it.data.title || "Untitled game").replace(/\s+/g, " ")} | ${gameSummary(it)} | updated ${new Date(Number(it.updated)).toISOString()}`;
    const shown = st.list.filter(it => !it.data.hidden), hidden = st.list.filter(it => it.data.hidden);
    return `[Sent from the Sleipnyr Games list: ${WHO}'s game prototypes (each a tabletop), newest first.\n`
      + `Games (id | title | what is on the table | last updated):\n${shown.map(line).join("\n") || "(none)"}\nArchived (hidden) games:\n${hidden.map(line).join("\n") || "(none)"}\n`
      + `This chat is the game list's own history; the list acts on your reply. ${ONE_SENTENCE}, `
      + `then one line per action, exactly:\n@open <game id>\n@new [title]   (a new game, opened at once; default title = today)\n@rename <game id> <title>\n`
      + `@hide <game id>   (archive; nothing is deleted)\n@unhide <game id>\n${runs("list")} Use only ids listed above. Never delete anything.]`;
  };
  const describe = async () => {
    if (!st.item) return describeList();
    const sets = (data().sets || []).map(s => (Text.isText(s) ? `- ${Text.describeSet(s, objs())}`
      : `- ${s.id} | ${s.kind} deck | home at ${s.x} ${s.y} | ${objs().filter(o => o.set === s.id).reduce((n, o) => n + o.cards.length, 0)} of 52 cards in ${objs().filter(o => o.set === s.id).length} stack(s)`)).join("\n");
    const os = objs().filter(o => o.kind === Cards.KIND).map(o => { const ts = textOf(o); return `- ${ts ? Text.describeStack(o, ts) : Cards.describeStack(o)}`; }).join("\n");
    const ms = objs().filter(o => o.kind === Meeples.KIND).map(o => `- ${Meeples.describe(o)}`).join("\n");
    const ts = objs().filter(o => o.kind === Tiles.KIND).map(o => `- ${Tiles.describe(o)}`).join("\n");
    const ks = objs().filter(o => o.kind === Dice.KIND).map(o => `- ${Dice.describe(o)}`).join("\n");
    const r = board.getBoundingClientRect(), a = tablePt(r.left, r.top), b = tablePt(r.right, r.bottom);
    return `[Sent from the Sleipnyr Games table "${(data().title || "").replace(/"/g, "'")}" (${st.item.id}): ${WHO}'s tabletop for game prototypes. `
      + `Objects lie at table coordinates (px, x right, y down; a card is ${Cards.W} x ${Cards.H}); the screen shows ${Math.round(a.x)} ${Math.round(a.y)} to ${Math.round(b.x)} ${Math.round(b.y)}`
      + `${matchMedia("(max-width: 760px)").matches ? " (the user is on a phone)" : ""}.\n`
      + `Cards: poker sets of 52 (no jokers); every card belongs to the set (deck) it came from, and only stacks of one set merge. A stack lists its cards bottom first; its top card shows. `
      + `${WHO} sees face-up cards only; never reveal face-down cards (you are not shown them).\n`
      + `Text decks: ${WHO}'s own cards for this prototype (e.g. Events), each card = a title and a text, numbered 1, 2, ... in its set for good (cards are never removed). `
      + `${WHO} dictates card texts and you write them with @add-card / @edit-card; a face-up text card shows as n: "title". `
      + `To see what a deck's cards say (you wrote them), send @list-cards <set id>: the answer comes in your next context; never read face-down cards out to ${WHO}.\n`
      + `Meeples (${Meeples.W} x ${Meeples.H} standing player pieces) and dice (${Dice.W} x ${Dice.H}, six-sided; a roll is fair and random, done by the table, never chosen by you) lie on top of everything; tiles (plain coloured rectangles, default ${Tiles.SIZE} x ${Tiles.SIZE}, position and size on a ${Tiles.SNAP} px grid) lie beneath everything, to build boards, grids and player mats from; a locked tile does not move. `
      + `Colours: ${PALETTE.map(p => p.name).join(", ")} or #rrggbb.\n`
      + `Sets:\n${sets || "(none)"}\nStacks (id | set | cards | position):\n${os || "(none)"}\n`
      + `Meeples (id | colour | position):\n${ms || "(none)"}\nDice (id | sides | colour | value | position):\n${ks || "(none)"}\nTiles (id | colour | size | position | locked):\n${ts || "(none)"}\n`
      + `Selected by ${WHO} (pink; "these", "the selected"): ${[...st.sel].join(" ") || "(none)"}\n`
      + `This chat is this game's own history; the table acts on your reply (other games are not affected). ${CHAT_FIRST}, exactly:\n`
      + `@add-deck [x y]   (a new full deck, face down; default = the middle of the screen)\n@shuffle <stack id>\n@draw <stack id> [n]   (n cards, each face up beside the stack)\n`
      + `@flip <stack id>   (a whole stack turns over: order reverses)\n@move <stack, meeple, die or tile id> <x> <y>   (top left corner)\n`
      + `@add-meeple [x y] [colour]\n@add-die [x y] [colour]   (a six-sided die showing 1)\n@roll <die id ...|all>   (roll dice; the results are in the next context)\n@set-die <die id> <1-6>   (turn a die to a face by hand)\n@add-tile [x y] [w h] [colour]   (a 3 x 3 board = nine 100 x 100 tiles stepped 100 px)\n`
      + `@color <meeple, die or tile id> <colour>\n@resize <tile id> <w> <h>\n@duplicate <meeple, die or tile id>   (a tile's copy goes directly to its right)\n@lock <tile id>\n@unlock <tile id>\n@merge <stack id> <onto stack id>   (same set only; dropped cards go on top)\n`
      + `@gather <set id or stack id>   (every card of that set back into one full ordered deck, face down, at its home)\n`
      + `@add-text-deck [x y] [name]   (a new text deck with no cards yet, default name ${Text.DEFAULT_NAME}; the answer gives its set id)\n`
      + `@add-card <set id> <title> | <text>   (one new card, face down at the bottom of the deck at its home; the answer gives its number)\n`
      + `@edit-card <set id> <n> <title> | <text>   (card n gets this title and text, wherever it lies)\n@rename-set <set id> <name>   (the name on the backs)\n`
      + `@list-cards <set id>   (every card's number, title and text, for you only; in your next context)\n@focus <stack id>   (centre the view on it)\n@fit   (show the whole table)\n`
      + `@rename <title>   (this game's name)\n@back   (to the game list)\n${runs("table")} Never delete anything.]`;
  };
  async function runList(name, args) {
    const a = String(args || "").trim(), [first, ...rest] = a.split(/\s+/);
    const need = () => { const it = st.list.find(x => x.id === first); if (!it) throw new Error(`no game ${first}`); return it; };
    switch (name) {
      case "open": need(); ctx.levels.go(ME, first); return `open ${first}`;
      case "new": { const it = await newGame(a); if (!it) throw new Error("could not make a game"); return `new ${it.id}`; }
      case "rename": need(); await patchGame(first, { title: rest.join(" ").trim().slice(0, 80) || "Untitled game" }); drawList(); return `rename ${first}`;
      case "hide": case "unhide": need(); await patchGame(first, { hidden: name === "hide" ? true : null }); drawList(); return `${name} ${first}`;
    }
    throw new Error("unknown command");
  }
  function run1(name, args) {
    const a = String(args || "").trim(), w = a.split(/\s+/).filter(Boolean), num = s => { const n = Number(s); if (!Number.isFinite(n)) throw new Error(`not a number: ${s}`); return n; };
    switch (name) {
      case "add-deck": { const r = w.length >= 2 ? addDeckAt(num(w[0]), num(w[1])) : addDeckAt(); return `add-deck ${r.set} as ${r.stack}`; }
      case "shuffle": doShuffle(w[0]); return `shuffle ${w[0]}`;
      case "flip": doFlip(w[0]); return `flip ${w[0]}`;
      case "draw": { const made = doDraw(w[0], w[1] ? num(w[1]) : 1); return `draw ${w[0]} -> ${made.join(" ")}`; }
      case "move": doMove(w[0], num(w[1]), num(w[2])); return `move ${w[0]}`;
      case "add-meeple": case "add-tile": case "add-die": {
        // numbers first (x y, then w h for a tile), then an optional colour
        const n = [], rest = [];
        for (const t of w) (rest.length || !Number.isFinite(Number(t)) ? rest : n).push(t);
        const c = rest.length ? rest.join(" ") : undefined;
        if (c !== undefined && !parseColor(c)) throw new Error(`not a colour: ${c}`);
        const xy = n.length >= 2 ? [n[0], n[1]].map(Number) : [undefined, undefined];
        const r = name === "add-meeple" ? addMeepleAt(xy[0], xy[1], c) : name === "add-die" ? addDieAt(xy[0], xy[1], c)
          : addTileAt(xy[0], xy[1], n.length >= 4 ? Number(n[2]) : undefined, n.length >= 4 ? Number(n[3]) : undefined, c);
        return `${name} ${r.id}`;
      }
      case "color": case "colour": doColor(w[0], w.slice(1).join(" ")); return `color ${w[0]}`;
      case "resize": doResize(w[0], num(w[1]), num(w[2])); return `resize ${w[0]}`;
      case "roll": {
        const ids = !w.length || w[0] === "all" ? objs().filter(o => o.kind === Dice.KIND).map(o => o.id) : w;
        if (!ids.length) throw new Error("no dice on the table");
        for (const id of ids) if (needO(id).kind !== Dice.KIND) throw new Error(`${id} is not a die`);
        const ds = doRoll(ids); return `roll ${ds.map(id => `${id}=${findO(id).value}`).join(" ")}`;
      }
      case "set-die": doSetDie(w[0], num(w[1])); return `set-die ${w[0]} ${w[1]}`;
      case "duplicate": { const r = doDuplicate(w[0]); return `duplicate ${w[0]} -> ${r.id}`; }
      case "lock": case "unlock": doLock(w[0], name === "lock"); return `${name} ${w[0]}`;
      case "merge": { needO(w[0]); needO(w[1]); if (!dropOnto(w[0], w[1])) throw new Error("different sets: not merged"); return `merge ${w[0]} onto ${w[1]}`; }
      case "gather": { const r = doGather(w[0]); return `gather -> ${r.stack}`; }
      case "add-text-deck": {
        const xy = w.length >= 2 && Number.isFinite(Number(w[0])) && Number.isFinite(Number(w[1]));
        const r = xy ? addTextDeckAt(num(w[0]), num(w[1]), w.slice(2).join(" ") || undefined) : addTextDeckAt(undefined, undefined, a || undefined);
        return `add-text-deck ${r.set} "${findSet(r.set).name}" (empty slot ${r.stack})`;
      }
      case "add-card": {
        const set = needText(w[0]), [t, ...x] = a.slice(w[0].length).split("|");
        const r = doAddCard(set.id, t, x.join("|")); return `add-card ${set.id} -> card ${r.n} in ${r.stack}`;
      }
      case "edit-card": {
        const set = needText(w[0]), n = num(w[1]), [t, ...x] = a.slice(a.indexOf(w[1], w[0].length) + w[1].length).split("|");
        doEditCard(set.id, n, t, x.join("|")); return `edit-card ${set.id} ${n}`;
      }
      case "rename-set": { const set = needText(w[0]); doRenameSet(set.id, a.slice(w[0].length)); return `rename-set ${set.id} "${findSet(set.id).name}"`; }
      case "list-cards": return Text.listCards(needText(w[0]));
      case "focus": centreOn(needO(w[0])); return `focus ${w[0]}`;
      case "fit": fitAll(); return "fit";
      case "rename": case "rename-game": rename(a); return "rename";
      case "back": ctx.levels.go(ME, ""); return "back";
    }
    throw new Error("unknown command");
  }
  const run = async (name, args) => {
    if (!st.item) return runList(name, args);
    const r = run1(name, args);
    if (name === "gather") await new Promise(ok => setTimeout(ok, GLIDE + 20));
    if (name === "list-cards") return r; // nothing changed
    if (st.item && !(await save(true))) throw new Error(`not saved (${r})`);
    return r;
  };

  // ------------------------------------------------------------ level + live updates
  let chat = null;
  ctx.bar.offer({ id: ME, label: () => (st.item ? data().title || "Game" : "Games"), shown: () => !!box.getClientRects().length,
    placeholder: () => (st.item ? "Ask the table: deal, shuffle, roll, write cards" : "Ask the games: open, start or rename one"),
    send: b => { if (!chat) throw new Error("no conversation here"); return chat.send(b); } });
  const embed = (view, title) => { chat = ctx.embed(view, box, { title, from: ME, describe, run, scope: () => st.item?.id || "", ownThread: true }); };
  let showing = 0;
  async function show(sub) {
    const mine = ++showing;
    closeMenu(); say("");
    if (!sub) {
      if (st.item) await settle(flush());
      if (mine !== showing) return;
      clearTable();
      drawList(); embed(LIST_VIEW, "Game list conversation");
      ctx.bar.focus(ME); chat?.retry?.();
      if (await loadList() && mine === showing && !st.item) drawList();
      return;
    }
    let it = st.list.find(x => x.id === sub);
    if (!it) try { it = await ctx.api(`/k/items/${encodeURIComponent(sub)}`); } catch { it = null; }
    if (mine !== showing) return;
    if (!it || it.type !== "game") { say("No such game.", true); ctx.levels.go(ME, ""); return; }
    if (st.item?.id !== it.id) {
      if (st.item) await settle(flush());
      if (mine !== showing) return;
      clearTable();
      st.item = { ...it, data: { sets: [], objects: [], ...it.data } }; st.savedAt = Number(it.updated) || 0;
      try { st.view = { x: 40, y: 40, z: 1, ...JSON.parse(localStorage.getItem(VIEW_KEY + it.id) || "{}") }; } catch { st.view = { x: 40, y: 40, z: 1 }; }
    }
    hist()?.reset(snapshot()); // the opened table is what undo starts from
    st.last = it.id; localStorage.setItem(LAST_KEY, it.id);
    drawHead(); games.el.hidden = true; board.hidden = false;
    embed(viewName(st.item), `${st.item.data.title || "Game"} conversation`);
    draw(); paintView();
    ctx.bar.focus(ME);
    chat?.retry?.();
  }
  function clearTable() {
    clearTimeout(st.saveTimer); st.saveTimer = 0;
    st.els.forEach(el => el.remove()); st.els.clear();
    st.item = null; st.sel = new Set(); st.multi = false; drawDone(); showKeys(false); boxSel = null; boxEl.hidden = true; drag = null; pans.clear(); pinch = null;
  }
  ctx.actions?.view?.(ME, {
    scrollTo: id => { const o = st.item && findO(id); if (!o) return false; centreOn(o); return true; },
    focus: id => { const o = st.item && findO(id); if (!o) return false; centreOn(o); pulse(id, "gm-land"); return true; },
  });
  ctx.levels.onChange((level, sub) => { if (level === ME) show(sub || ""); });
  ctx.on("item", ({ item }) => {
    if (item?.type !== "game") return;
    const i = st.list.findIndex(x => x.id === item.id);
    if (i >= 0) st.list[i] = item; else st.list.unshift(item);
    if (!st.item && ctx.levels.current() === ME) drawList();
    // another device's (or tab's) newer copy, taken when nothing of ours is pending
    if (st.item?.id === item.id && Number(item.updated) > st.savedAt && !drag && !st.saveTimer && !inFlight) {
      st.savedAt = Number(item.updated);
      const was = spots(), rolled = new Map(objs().filter(o => o.kind === Dice.KIND).map(o => [o.id, o.rolls || 0]));
      st.item = { ...item, data: { sets: [], objects: [], ...item.data } };
      const fresh = objs().filter(o => o.kind === Dice.KIND && rolled.has(o.id) && (o.rolls || 0) > rolled.get(o.id)).map(o => o.id);
      for (const id of fresh) { const el = st.els.get(id); if (el) el.dataset.tumbling = "1"; }
      drawHead(); draw(); glideFrom(was); fresh.forEach(tumble);
      hist()?.reset(snapshot()); // not a step of ours: undo goes back from here
    }
  });
}
