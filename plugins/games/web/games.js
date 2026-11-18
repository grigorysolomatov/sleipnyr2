// Games: a composed modality. A personal tabletop for game prototypes.
//
// The level opens on the list of games (/m/games, the kernel's itemList like
// the Columns boards: newest first, pink = the last one opened, + = a new
// game named after today); a tap opens one (/m/games/<item id>), the back
// arrow returns to the list. Each game has its own conversation (view thread
// data.chatView = games-<id>; the list's is games-list).
//
// A game is an endless table: drag empty space (or one finger on a phone) to
// pan, the wheel (or two fingers) to zoom. On it lie objects drawn by table
// components (web/components/*.js): poker card sets, meeples and tiles.
// The + at the top right (and a right-click / long-press on empty table)
// offers them: Poker deck, Meeple, Tile. Tiles lie at the bottom, cards on
// them, meeples on top. Cards:
//   drag a card or a stack         moves it (a deck: drag its TOP CARD off = draw one card)
//   drag a deck's count badge      moves the whole deck (desktop: also Shift + drag)
//   drop on a stack of the same set   merges (the dropped cards go on top); another set refuses
//   double-click / double-tap      flips the card or the stack
//   right-click / long-press       menu at the object: Flip, Draw, Shuffle, Gather;
//                                  on empty table: add a poker deck, meeple or tile
// meeples: drag to move; menu = colour swatches, Custom colour, Duplicate
// tiles: drag to move (snapped to a 10 px grid), the bottom-right handle resizes
//   (desktop: on hover; phone: tap the tile first); menu = colour, Duplicate
//   (the copy goes right beside it), Lock (a locked tile stays put: drags on it pan)
// copy + paste (meeples and tiles; cards belong to their deck, so not them):
//   a click / tap selects a piece (pink), empty table or Escape clears;
//   Ctrl+C (Cmd+C) copies the selected piece, Ctrl+V pastes one copy per press:
//   at the pointer if it moved since the last paste, else right beside the last
//   one (tiles edge to edge), so C then V V V builds a row. The menus offer
//   Copy (on a piece) and Paste (on empty table). The copy lives in this tab only.
//
// Saved item (kernel /k/items), one per game:
//   game {title, chatView, sets: [{id, kind, x, y}], objects: [{id, kind, x, y, ...}]}
//     objects in drawing order (the last one on top); the component named by
//     kind draws it and owns its fields (stack: set, cards [{c, up}], bottom first;
//     meeple: color; tile: w, h, color, locked); drawn by layer, then this order
// The view (pan, zoom) is kept per device. Saves are short-delayed PATCHes of
// the bare body; another device's newer copy is taken when nothing is pending.
import { itemList } from "/web/itemlist.js";
import { CHAT_FIRST, ONE_SENTENCE, runs } from "/web/hcp.js";
import { backButton } from "/web/head.js";
import * as Cards from "./components/cards.js";
import * as Meeples from "./components/meeples.js";
import * as Tiles from "./components/tiles.js";
import { PALETTE, colorName, parseColor, setColor } from "./components/colors.js";

// the table components by object kind: element class, drawing, size, layer (higher = on top)
const KINDS = {
  [Cards.KIND]: { cls: "gm-stack", render: Cards.renderStack, size: () => [Cards.W, Cards.H], layer: 1 },
  [Meeples.KIND]: { cls: "gm-meeple", render: Meeples.render, size: () => [Meeples.W, Meeples.H], layer: Meeples.LAYER },
  [Tiles.KIND]: { cls: "gm-tile", render: Tiles.render, size: o => [o.w, o.h], layer: Tiles.LAYER },
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
// the copied piece {kind, color, w, h}: per tab, shared by every game
let CLIP = null;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => 1 - Math.pow(1 - t, 3);

export function mount(box, ctx) {
  const WHO = ctx.user?.name || "the user", AG = ctx.app?.agentName || "the agent";
  const st = { item: null, list: [], last: localStorage.getItem(LAST_KEY) || "", els: new Map(), sel: "", saveTimer: 0, savedAt: 0, view: { x: 40, y: 40, z: 1 } };
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
  const hint = h("p", { class: "gm-hint", hidden: true }, "Empty table. Use + above, or right-click / long-press the table, to add a poker deck, a meeple or a tile.");
  const board = h("div", { class: "gm-board", hidden: true, "data-k-id": "table", "data-k-kind": "table",
    "data-k-label": "The table: drag empty space to pan, wheel or pinch to zoom" }, dots, plane, hint);
  const menu = h("div", { class: "gm-menu k-pop", role: "menu", hidden: true });
  const note = h("p", { class: "gm-note", "aria-live": "polite", hidden: true });
  // the Custom colour picker: the browser's own, opened from the menu
  const picker = h("input", { type: "color", class: "gm-picker", tabindex: "-1", "aria-hidden": "true" });
  box.append(head, games.el, board, note, menu, picker);
  const say = (t, err = false) => { note.hidden = !t; note.textContent = t || ""; note.classList.toggle("err", err); };

  // ------------------------------------------------------------ data
  const data = () => st.item?.data;
  const objs = () => data()?.objects || [];
  const findO = id => objs().find(o => o.id === id);
  const needO = id => { const o = findO(String(id || "").trim()); if (!o) throw new Error(`no object ${id}`); return o; };
  const table = () => ({ sets: data().sets || [], objects: objs() });
  /** apply a pure table operation's result and save */
  function commit(state) { data().sets = state.sets; data().objects = state.objects; draw(); save(); }
  const gameSummary = it => {
    const all = it.data.objects || [], os = all.filter(o => o.kind === Cards.KIND), n = os.reduce((s, o) => s + o.cards.length, 0);
    const pl = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`, parts = [];
    if (os.length) parts.push(pl(os.length, "stack"), pl(n, "card"));
    const m = all.filter(o => o.kind === Meeples.KIND).length, t = all.filter(o => o.kind === Tiles.KIND).length;
    if (m) parts.push(pl(m, "meeple"));
    if (t) parts.push(pl(t, "tile"));
    return parts.join(", ") || "empty table";
  };

  async function saveOnce() {
    const it = st.item, d = it.data;
    const out = await ctx.api(`/k/items/${encodeURIComponent(it.id)}`, { method: "PATCH", json: { sets: d.sets || [], objects: d.objects || [] } });
    if (st.item === it) { st.savedAt = Math.max(st.savedAt, Number(out.updated) || 0); it.updated = out.updated; }
  }
  let saving = null, inFlight = 0;
  function save(now = false) {
    clearTimeout(st.saveTimer);
    if (!st.item) return Promise.resolve(true);
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
    const bt = it ? "All games" : "All modalities", at = it ? "Add to the table: poker deck, meeple, tile" : "New game";
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
    for (const o of objs()) {
      const K = kindOf(o);
      let el = st.els.get(o.id);
      if (el && el.dataset.kind !== o.kind) { el.remove(); el = null; }
      if (!el) { el = h("div", { class: `gm-obj ${K.cls}`, "data-k-kind": o.kind }); el.dataset.id = o.id; el.dataset.kId = o.id; el.dataset.kind = o.kind; st.els.set(o.id, el); }
      K.render(el, o);
      el.dataset.kLabel += ` at ${Math.round(o.x)} ${Math.round(o.y)}`;
      el.classList.toggle("gm-sel", st.sel === o.id);
      if (drag?.id !== o.id) { el.style.left = `${o.x}px`; el.style.top = `${o.y}px`; }
    }
    // drawing order = by layer (tiles, cards, meeples), then the objects' order (the last on top)
    const order = objs().map((o, i) => [o, i]).sort((a, b) => kindOf(a[0]).layer - kindOf(b[0]).layer || a[1] - b[1]);
    order.forEach(([o], i) => { const el = st.els.get(o.id); if (plane.children[i] !== el) plane.insertBefore(el, plane.children[i] || null); });
    hint.hidden = objs().length > 0;
  }
  function select(id) {
    if (st.sel === id) return;
    st.els.get(st.sel)?.classList.remove("gm-sel");
    st.sel = id || "";
    st.els.get(st.sel)?.classList.add("gm-sel");
  }
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
  function addMeepleAt(x, y, c) {
    if (!st.item) return null;
    const p = x === undefined ? middle(Meeples.W, Meeples.H) : { x, y };
    const r = Meeples.addMeeple(table(), p.x, p.y, c);
    commit(r.state); pulse(r.id, "gm-land");
    return r;
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
    const r = o.kind === Tiles.KIND ? Tiles.duplicate(table(), o.id) : o.kind === Meeples.KIND ? Meeples.duplicate(table(), o.id) : null;
    if (!r) throw new Error(`only meeples and tiles duplicate (${id} is a ${o.kind})`);
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
    if (on && st.sel === o.id) select("");
    commit(Tiles.setLocked(table(), o.id, on));
  }
  // ---- copy + paste: where the next paste goes
  // last = {game, x, y, w} the previous paste (or the copied original);
  // ptr = the mouse over the table, moved = it moved since the last paste
  const pst = { last: null, ptr: null, moved: false };
  const STEP_MEEPLE = 50;
  function doCopy(id) {
    const o = findO(id);
    if (!o || (o.kind !== Tiles.KIND && o.kind !== Meeples.KIND)) return false; // stacks: nothing
    CLIP = { kind: o.kind, color: o.color, w: o.w, h: o.h };
    pst.last = { game: st.item.id, x: o.x, y: o.y, w: o.kind === Tiles.KIND ? o.w : 0 }; pst.moved = false;
    pulse(o.id, "gm-copied", 360);
    const what = o.kind === Tiles.KIND ? `${colorName(o.color).toLowerCase()} tile ${o.w} x ${o.h}` : `${colorName(o.color).toLowerCase()} meeple`;
    say(`Copied the ${what}. ${lastType === "mouse" ? "Ctrl+V pastes" : "Long-press the table to paste"}.`);
    clearTimeout(pst.noteT); pst.noteT = setTimeout(() => { if (note.textContent.startsWith("Copied")) say(""); }, 2200);
    return true;
  }
  /** one copy of the clipboard: centred on table point p, or (no p) by the rules above */
  function doPaste(p) {
    if (!st.item || !CLIP) return null;
    const c = CLIP, tile = c.kind === Tiles.KIND, w = tile ? c.w : Meeples.W, hh = tile ? c.h : Meeples.H;
    let x, y;
    if (!p && pst.moved && pst.ptr) {
      const r = board.getBoundingClientRect(), q = pst.ptr;
      if (q.cx >= r.left && q.cx <= r.right && q.cy >= r.top && q.cy <= r.bottom) p = tablePt(q.cx, q.cy);
    }
    if (p) { x = p.x - w / 2; y = p.y - hh / 2; }
    else if (pst.last && pst.last.game === st.item.id) { x = pst.last.x + (tile ? (pst.last.w || w) : STEP_MEEPLE); y = pst.last.y; }
    else ({ x, y } = middle(w, hh));
    const r = tile ? Tiles.addTile(table(), x, y, c.w, c.h, c.color) : Meeples.addMeeple(table(), x, y, c.color);
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
    const was = spots(), r = Cards.gather(table(), set);
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
  function stackMenu(id, cx, cy) {
    const o = findO(id); if (!o) return;
    const n = o.cards.length, t = Cards.topCard(o);
    const items = [[n > 1 ? "Flip stack" : "Flip", n > 1 ? "Turn the whole stack over (its order reverses)" : "Turn the card over", () => doFlip(id)]];
    if (n > 1) items.push(["Draw", "Put the top card face up beside the deck", () => doDraw(id)]);
    if (n > 1) items.push(["Shuffle", "Shuffle this stack", () => doShuffle(id)]);
    items.push(["Gather", `Every card of this deck back here: one full ordered deck, face down`, () => doGather(o.set)]);
    openMenu(cx, cy, items, n > 1 ? `${n} cards` : t.up ? Cards.cardLong(t.c) : "Card, face down");
  }
  /** what can be added: at a table point, or (no point) the middle of the screen */
  const addItems = p => [
    ["Poker deck", "A new 52-card deck, face down", () => (p ? addDeckAt(p.x - Cards.W / 2, p.y - Cards.H / 2) : addDeckAt())],
    ["Meeple", "A standing player piece; pick its colour in its menu", () => (p ? addMeepleAt(p.x - Meeples.W / 2, p.y - Meeples.H / 2) : addMeepleAt())],
    ["Tile", "A square to build boards and mats from: resize, colour, duplicate, lock", () => (p ? addTileAt(p.x - Tiles.SIZE / 2, p.y - Tiles.SIZE / 2) : addTileAt())],
  ];
  function tableMenu(cx, cy) {
    const p = tablePt(cx, cy);
    const paste = CLIP ? [["Paste", `Another ${CLIP.kind === Tiles.KIND ? "tile" : "meeple"} like the copied one, here`, () => doPaste(p)]] : [];
    openMenu(cx, cy, [...paste, ...addItems(p)], "Add to the table");
  }
  /** the + at the top right: the same choices, under the button */
  function addMenu() {
    const r = addBtn.getBoundingClientRect();
    openMenu(r.right, r.bottom + 4, addItems(null), "Add to the table", false);
    const m = menu.getBoundingClientRect(), b = box.getBoundingClientRect();
    menu.style.left = `${clamp(r.right - b.left - m.width, 4, b.width - m.width - 4)}px`;
  }
  /** the colour swatches + Custom colour, for meeples and tiles */
  function colorItems(o, cx, cy) {
    const row = h("div", { class: "gm-sws", role: "group", "aria-label": "Colour" },
      PALETTE.map(p => h("button", { class: `gm-sw${o.color === p.hex ? " on" : ""}`, type: "button", style: `--sw:${p.hex}`, "data-tip": p.name, "aria-label": p.name,
        onclick: choose(() => doColor(o.id, p.hex)) })));
    const custom = () => {
      const r = box.getBoundingClientRect();
      picker.style.left = `${clamp(cx - r.left, 0, r.width - 2)}px`; picker.style.top = `${clamp(cy - r.top, 0, r.height - 2)}px`;
      picker.value = o.color;
      picker.oninput = () => { try { doColor(o.id, picker.value); } catch (e) { say(e.message, true); } };
      picker.onchange = picker.oninput;
      picker.click();
    };
    return [row, ["Custom colour…", "Any colour, from the colour picker", custom]];
  }
  function meepleMenu(o, cx, cy) {
    openMenu(cx, cy, [...colorItems(o, cx, cy), ["Duplicate", "Another meeple of this colour beside it", () => doDuplicate(o.id)],
      ["Copy", "Copy it; paste copies with Ctrl+V or from the table's menu", () => doCopy(o.id)]], `${colorName(o.color)} meeple`);
  }
  function tileMenu(o, cx, cy) {
    openMenu(cx, cy, [...colorItems(o, cx, cy),
      ["Duplicate", "A copy directly to its right, same size and colour", () => doDuplicate(o.id)],
      ["Copy", "Copy it; paste copies with Ctrl+V or from the table's menu", () => doCopy(o.id)],
      o.locked ? ["Unlock", "Let the tile move and resize again", () => doLock(o.id, false)]
        : ["Lock", "Keep it in place: drags on it pan the table", () => doLock(o.id, true)]],
      `${colorName(o.color)} tile, ${o.w} x ${o.h}${o.locked ? ", locked" : ""}`);
  }
  function objMenu(id, cx, cy) {
    const o = findO(id); if (!o) return;
    if (o.kind === Meeples.KIND) return meepleMenu(o, cx, cy);
    if (o.kind === Tiles.KIND) return tileMenu(o, cx, cy);
    return stackMenu(id, cx, cy);
  }
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !menu.hidden) { closeMenu(); e.stopPropagation(); } }, true);
  const typing = t => !!t?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");
  document.addEventListener("keydown", e => {
    if (!st.item || board.hidden || !board.getClientRects().length || ctx.levels.current() !== ME) return;
    if (typing(e.target) || typing(document.activeElement)) return; // the chat field keeps its copy + paste
    if (e.key === "Escape" && menu.hidden && st.sel) { select(""); return; }
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "c") {
      if (String(window.getSelection?.() || "")) return; // selected page text copies as usual
      if (st.sel && doCopy(st.sel)) e.preventDefault();
    } else if (k === "v" && CLIP) {
      e.preventDefault();
      try { doPaste(); } catch (err) { say(err.message, true); }
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
    if (!st.item || (e.pointerType === "mouse" && e.button !== 0)) return;
    lastType = e.pointerType;
    cancelAnimationFrame(viewGlide);
    const oEl = objAt(e), hit = oEl && findO(oEl.dataset.id);
    // a locked tile passes the press through to the table (pan), keeping only its menu
    const through = hit && hit.kind === Tiles.KIND && hit.locked ? hit : null;
    if (hit && !through && !drag && !pans.size) {
      const o = hit;
      if (o.kind === Cards.KIND) select(""); // stacks are not copied: the selection goes
      board.setPointerCapture(e.pointerId);
      const p = tablePt(e.clientX, e.clientY);
      drag = { id: o.id, kind: o.kind, pid: e.pointerId, sx: e.clientX, sy: e.clientY, mode: "", off: { x: p.x - o.x, y: p.y - o.y }, p0: p,
        whole: !!e.target.closest(".gm-badge") || e.shiftKey, resize: o.kind === Tiles.KIND && !!e.target.closest(".gm-handle"), w0: o.w, h0: o.h, timer: 0, held: false };
      if (e.pointerType !== "mouse") drag.timer = setTimeout(() => { if (drag && !drag.mode) { drag.held = true; objMenu(drag.id, drag.sx, drag.sy); } }, HOLD);
      e.preventDefault();
      return;
    }
    if (drag) return;
    if (!through && pans.size === 0) select("");
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
  let tableHold = 0;
  board.addEventListener("pointermove", e => {
    if (drag && e.pointerId === drag.pid) {
      if (!drag.mode) {
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < SLOP || drag.held) return;
        clearTimeout(drag.timer); closeMenu();
        const o = findO(drag.id);
        if (drag.resize) drag.mode = "resize";
        else if (o.kind === Cards.KIND && o.cards.length > 1 && !drag.whole) {
          // dragging a deck's top card off draws it
          const r = Cards.take(table(), o.id, 1, o.x, o.y);
          data().sets = r.state.sets; data().objects = r.state.objects; draw();
          drag.id = r.stack; drag.mode = "draw";
        } else {
          drag.mode = "move";
          data().objects = objs().filter(q => q.id !== o.id).concat(o); draw(); // lifted to the top
        }
        if (drag.kind === Tiles.KIND || drag.kind === Meeples.KIND) select(drag.id);
        st.els.get(drag.id)?.classList.add("gm-drag");
      }
      const p = tablePt(e.clientX, e.clientY), o = findO(drag.id), el = st.els.get(drag.id);
      if (drag.mode === "resize") {
        // the handle follows the pointer; the size snaps to the grid
        drag.w = Tiles.side(drag.w0 + p.x - drag.p0.x); drag.h = Tiles.side(drag.h0 + p.y - drag.p0.y);
        if (el) { el.style.width = `${drag.w}px`; el.style.height = `${drag.h}px`; }
        return;
      }
      drag.x = p.x - drag.off.x; drag.y = p.y - drag.off.y;
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
      if (d.kind === Tiles.KIND || d.kind === Meeples.KIND) { select(d.id); return; } // a tap selects a piece (a tile shows its resize handle)
      if (d.kind !== Cards.KIND) return;
      // a tap; a second tap (or click) on the same stack soon after flips it.
      // (no dblclick listener: with the pointer captured it targets the table)
      const now = performance.now();
      if (lastTap.id === d.id && now - lastTap.t < 350) { lastTap = { id: "", t: 0 }; doFlip(d.id); }
      else lastTap = { id: d.id, t: now };
      return;
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
  board.addEventListener("pointerup", e => { if (drag && e.pointerId === drag.pid) endDrag(e); else endPan(e); });
  board.addEventListener("pointercancel", e => { if (drag && e.pointerId === drag.pid) endDrag(e, true); else endPan(e); });
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
    const sets = (data().sets || []).map(s => `- ${s.id} | ${s.kind} deck | home at ${s.x} ${s.y} | ${objs().filter(o => o.set === s.id).reduce((n, o) => n + o.cards.length, 0)} of 52 cards in ${objs().filter(o => o.set === s.id).length} stack(s)`).join("\n");
    const os = objs().filter(o => o.kind === Cards.KIND).map(o => `- ${Cards.describeStack(o)}`).join("\n");
    const ms = objs().filter(o => o.kind === Meeples.KIND).map(o => `- ${Meeples.describe(o)}`).join("\n");
    const ts = objs().filter(o => o.kind === Tiles.KIND).map(o => `- ${Tiles.describe(o)}`).join("\n");
    const r = board.getBoundingClientRect(), a = tablePt(r.left, r.top), b = tablePt(r.right, r.bottom);
    return `[Sent from the Sleipnyr Games table "${(data().title || "").replace(/"/g, "'")}" (${st.item.id}): ${WHO}'s tabletop for game prototypes. `
      + `Objects lie at table coordinates (px, x right, y down; a card is ${Cards.W} x ${Cards.H}); the screen shows ${Math.round(a.x)} ${Math.round(a.y)} to ${Math.round(b.x)} ${Math.round(b.y)}`
      + `${matchMedia("(max-width: 760px)").matches ? " (the user is on a phone)" : ""}.\n`
      + `Cards: poker sets of 52 (no jokers); every card belongs to the set (deck) it came from, and only stacks of one set merge. A stack lists its cards bottom first; its top card shows. `
      + `${WHO} sees face-up cards only; never reveal face-down cards (you are not shown them).\n`
      + `Meeples (${Meeples.W} x ${Meeples.H} standing player pieces) lie on top of everything; tiles (plain coloured rectangles, default ${Tiles.SIZE} x ${Tiles.SIZE}, position and size on a ${Tiles.SNAP} px grid) lie beneath everything, to build boards, grids and player mats from; a locked tile does not move. `
      + `Colours: ${PALETTE.map(p => p.name).join(", ")} or #rrggbb.\n`
      + `Sets:\n${sets || "(none)"}\nStacks (id | set | cards | position):\n${os || "(none)"}\n`
      + `Meeples (id | colour | position):\n${ms || "(none)"}\nTiles (id | colour | size | position | locked):\n${ts || "(none)"}\n`
      + `This chat is this game's own history; the table acts on your reply (other games are not affected). ${CHAT_FIRST}, exactly:\n`
      + `@add-deck [x y]   (a new full deck, face down; default = the middle of the screen)\n@shuffle <stack id>\n@draw <stack id> [n]   (n cards, each face up beside the stack)\n`
      + `@flip <stack id>   (a whole stack turns over: order reverses)\n@move <stack, meeple or tile id> <x> <y>   (top left corner)\n`
      + `@add-meeple [x y] [colour]\n@add-tile [x y] [w h] [colour]   (a 3 x 3 board = nine 100 x 100 tiles stepped 100 px)\n`
      + `@color <meeple or tile id> <colour>\n@resize <tile id> <w> <h>\n@duplicate <meeple or tile id>   (a tile's copy goes directly to its right)\n@lock <tile id>\n@unlock <tile id>\n@merge <stack id> <onto stack id>   (same set only; dropped cards go on top)\n`
      + `@gather <set id or stack id>   (every card of that set back into one full ordered deck, face down, at its home)\n@focus <stack id>   (centre the view on it)\n@fit   (show the whole table)\n`
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
      case "add-meeple": case "add-tile": {
        // numbers first (x y, then w h for a tile), then an optional colour
        const n = [], rest = [];
        for (const t of w) (rest.length || !Number.isFinite(Number(t)) ? rest : n).push(t);
        const c = rest.length ? rest.join(" ") : undefined;
        if (c !== undefined && !parseColor(c)) throw new Error(`not a colour: ${c}`);
        const xy = n.length >= 2 ? [n[0], n[1]].map(Number) : [undefined, undefined];
        const r = name === "add-meeple" ? addMeepleAt(xy[0], xy[1], c)
          : addTileAt(xy[0], xy[1], n.length >= 4 ? Number(n[2]) : undefined, n.length >= 4 ? Number(n[3]) : undefined, c);
        return `${name} ${r.id}`;
      }
      case "color": case "colour": doColor(w[0], w.slice(1).join(" ")); return `color ${w[0]}`;
      case "resize": doResize(w[0], num(w[1]), num(w[2])); return `resize ${w[0]}`;
      case "duplicate": { const r = doDuplicate(w[0]); return `duplicate ${w[0]} -> ${r.id}`; }
      case "lock": case "unlock": doLock(w[0], name === "lock"); return `${name} ${w[0]}`;
      case "merge": { needO(w[0]); needO(w[1]); if (!dropOnto(w[0], w[1])) throw new Error("different sets: not merged"); return `merge ${w[0]} onto ${w[1]}`; }
      case "gather": { const r = doGather(w[0]); return `gather -> ${r.stack}`; }
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
    if (st.item && !(await save(true))) throw new Error(`not saved (${r})`);
    return r;
  };

  // ------------------------------------------------------------ level + live updates
  let chat = null;
  ctx.bar.offer({ id: ME, label: () => (st.item ? data().title || "Game" : "Games"), shown: () => !!box.getClientRects().length,
    placeholder: () => (st.item ? "Ask the table: deal, shuffle, add meeples or tiles" : "Ask the games: open, start or rename one"),
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
    st.item = null; st.sel = ""; drag = null; pans.clear(); pinch = null;
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
      const was = spots();
      st.item = { ...item, data: { sets: [], objects: [], ...item.data } };
      drawHead(); draw(); glideFrom(was);
    }
  });
}
