// Blackboards: a composed modality. A blackboard is an overview board with
// unlimited room: drag the background (or wheel) to pan, Ctrl+wheel or pinch
// to zoom. On it sit windows into other views: a chat thread, the thread list,
// Task Tinder, Projects, a file (PDF etc., the browser's own viewer) or a web
// page. Drag a window by its title bar, resize it from the corner, fold it to
// its title bar, close it. Windows snap to the board's dot grid when dropped
// and glide there (never jump); Arrange lays them all out in a grid without
// overlap. Pans and zooms are composited (transform only), so a busy board
// stays smooth. Phones get the same board: one finger pans (also over a
// window: a window only takes touches once tapped), two fingers pinch-zoom.
// (Named columns of foldable panels are the separate Columns modality.)
// A window into a view is that view's own page in a frame (?frame=1, see
// shell.js): no bar of its own, it shares this page's event stream (many
// windows, one connection), and the shared bar talks to the focused window
// (the "→ target" label switches between it and the board's conversation).
//
// Saved item (kernel /k/items; the type stays "session", the modality's old
// name, so every existing board keeps working):
//   session {title, hidden?, chatView?, agentNotes?, view: {x, y, z}, highlight?: {id, reason}, windows: [{id, kind, ref, title, named?, text?, x, y, w, h, collapsed, z}]}
//     kind  thread (ref = thread id) | threads | tinder | projects (ref = project id or "")
//           | file (ref = file id) | url (ref = http(s) URL) | note (text = Markdown, kept in the session)
//     named  the title was set by hand or by @title (a thread window then keeps it)
//     highlight  the window the agent points at ("look here"); a tap on it clears it
//     fresh  (on a window) the agent marked it new (@new, green frame; true or the reason); a
//            tap, focus or unfolding it clears it; any number of windows at once
//     x, y, w, h  board units (zoom 1 = CSS px); z = stacking order
//     zones  [{id, title, x, y, w, h, auto?}]: labelled frames behind the windows (@zone); a window
//            belongs to the zone holding its centre; Arrange tidies each zone on its own;
//            auto = the "Unsorted" zone the agent's unplaced windows land in (removed once empty)
// Placement (place.js): a new window never covers another one. The agent's
// windows go to the first free slot of the zone it names ("in <zone>"), or of
// "Unsorted" below all zones; a hand-added one to the free slot nearest the
// middle of the screen. The zone grows to hold it. A @move onto another
// window is nudged to the nearest free slot in the same zone.
// Own place: the open board (ctx.levels.go("blackboards", id)). Each board has
// its own conversation (view thread session.chatView, else blackboards-<id>,
// made on first open; boards from before this were given chatView "sessions",
// the old shared thread, so their history stays with them) and the board list has its own (blackboards-boards).
// It sits in the embedded chat (ctx.embed), the bar talks to it, and replies
// may carry "@name args" lines (see describe()).
// Hidden agent notes come in two layers, both first in every prompt: notes for
// all blackboards (kernel settings viewNotes.blackboards, @memo-all) and notes
// for this blackboard (session.agentNotes, @memo; windows[].agentNotes too).
import { render } from "/web/text.js";
import { darkFrame } from "/web/frame.js";
import { CHAT_FIRST, runs, viewNotes, setViewNotes, notesBlock } from "/web/hcp.js";
import { backButton } from "/web/head.js";
import * as P from "./place.js";

const ME = "blackboards";
// the board list's conversation; each board's own is chatOf(board)
const LIST_VIEW = `${ME}-boards`;
const chatOf = it => it.data.chatView || `${ME}-${String(it.id).replace(/[^a-z0-9]/g, "").slice(-18)}`; // view names stay within 31 characters
// What a board is called on screen, in one place (it may become "canvas").
const WORD = "blackboard", WORDS = "blackboards";
const Cap = w => w[0].toUpperCase() + w.slice(1);
const WIN = "blackboards-window"; // the bar's second target: the focused window
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const FULL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';
const BOX = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>';
const UNBOX = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M12 18v-6M9.5 14.5L12 12l2.5 2.5"/></svg>';
const FIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
const ARRANGE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>';
const GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12l-8 8M20 17l-3 3"/></svg>';

const KINDS = {
  thread: { label: "Thread", w: 420, h: 560 },
  threads: { label: "Thread list", w: 360, h: 560 },
  tinder: { label: "Task Tinder", w: 420, h: 560 },
  projects: { label: "Projects", w: 480, h: 440 },
  file: { label: "File", w: 560, h: 700 },
  url: { label: "Web page", w: 640, h: 480 },
  note: { label: "Note", w: 440, h: 520 },
};
const ZMIN = 0.2, ZMAX = 2.5;
// the dot grid windows snap to (board px), the gap Arrange leaves, glide length
const { GRID, GAP, snap, snapUp } = P;
const GLIDE = 220;
const ease = t => 1 - Math.pow(1 - t, 3);
const NARROW = "(max-width: 760px)";
const MEMO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/></svg>';

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
// a finger device (or a phone-sized screen): windows take touches only once focused
const touchy = () => matchMedia("(pointer: coarse)").matches || matchMedia(NARROW).matches;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;
const safeUrl = u => { try { const x = new URL(u, location.origin); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };

/** The address a window shows. */
export function srcOf(w) {
  const f = "frame=1";
  switch (w.kind) {
    case "thread": return `/i/${encodeURIComponent(w.ref)}?${f}`;
    case "threads": return `/?${f}`;
    case "tinder": return `/m/tinder?${f}`;
    case "projects": return `/m/projects${w.ref ? "/" + encodeURIComponent(w.ref) : ""}?${f}`;
    case "file": return `/k/files/${encodeURIComponent(w.ref)}`;
    case "url": return safeUrl(w.ref);
  }
  return "";
}
const fullOf = w => w.kind === "file" || w.kind === "url" ? srcOf(w) : srcOf(w).replace(/[?&]frame=1$/, "");

export function mount(box, ctx) {
  const WHO = ctx.user?.name || "the user", AG = ctx.app?.agentName || "the agent";
  const st = {
    list: [], threads: [], open: null, // open = the session item
    saveTimer: 0, narrow: matchMedia(NARROW).matches, here: "", last: "",
    els: new Map(), // window id -> {el, body, frame, src}
  };
  const titleEl = h("b", { class: "ss-title" });
  const back = backButton({ cls: "ss-back", onclick: () => (st.open ? ctx.levels.go(ME, "") : ctx.levels.up()) });
  const addBtn = icon(PLUS, `New ${WORD}`, () => (st.open ? togglePick() : newSession()), "ss-add");
  const fitBtn = icon(FIT, "Show all windows", () => fitAll(), "ss-fit");
  const arrBtn = icon(ARRANGE, "Arrange windows in a tidy grid", () => arrange(), "ss-arr");
  const memoBtn = icon(MEMO, `Agent notes (hidden from the board, read by ${AG} every turn)`, () => toggleMemo(), "ss-memob");
  const zoomEl = h("button", { class: "ss-zoom", type: "button", "data-tip": "Zoom; tap for 100 %", "aria-label": "Zoom to 100 %", onclick: () => zoomTo(1) });
  const memo = h("div", { class: "ss-memo", hidden: true, role: "dialog", "aria-label": "Agent notes" });
  const pick = h("div", { class: "ss-pick k-pop", hidden: true, role: "menu" });
  const fileIn = h("input", { type: "file", hidden: true, onchange: () => addFile() });
  const head = h("header", { class: "ss-bar" }, back, titleEl, zoomEl, arrBtn, fitBtn, memoBtn, addBtn);
  const body = h("div", { class: "ss-body" });
  const note = h("p", { class: "ss-note", "aria-live": "polite", hidden: true });
  box.append(head, body, note, pick, memo, fileIn);
  box.classList.add("ss-level");

  const say = (t, err = false) => { note.hidden = !t; note.textContent = t || ""; note.classList.toggle("err", err); };

  // ------------------------------------------------------------ data
  const sess = () => st.open?.data;
  const wins = () => sess()?.windows || [];
  const zones = () => sess()?.zones || [];
  // the zone holding a window's centre (folded windows count by their title bar)
  const zoneOf = w => P.zoneOf(zones(), w);
  // the phone keeps its own view of the board (viewPhone), the desktop's stays as it was
  const VK = () => (st.narrow ? "viewPhone" : "view");
  const viewOf = () => ({ x: 0, y: 0, z: 1, ...(sess()?.[VK()] || {}) });
  async function loadList() {
    try { st.list = (await ctx.api("/k/items?type=session&order=-updated&limit=500")); } catch (e) { say(`Could not load ${WORDS}: ${e.message}`, true); }
  }
  async function loadThreads() { try { st.threads = await ctx.api("/p/chat/threads"); } catch { st.threads = []; } }
  const threadTitle = id => st.threads.find(t => t.id === id)?.data.title;

  // Saving never overwrites someone else's change (another device, or the
  // agent's @lines run on another page): st.base is the session as the server
  // last had it, a save is conditional on that version (x-if-updated), and when
  // the server has moved on, our changes since base are replayed onto its
  // copy (per window, per field) and sent again. Live changes from elsewhere
  // are merged the same way, so unsaved local changes survive them too.
  const clone = o => JSON.parse(JSON.stringify(o ?? null));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function setBase(it) { st.base = clone({ windows: it.data.windows || [], highlight: it.data.highlight || null, zones: it.data.zones || [], agentNotes: it.data.agentNotes || "" }); st.baseAt = it.updated; }
  // our changes since base, applied onto the server's newer data
  function rebase(item) {
    const base = st.base || { windows: [], highlight: null }, local = wins();
    const bmap = new Map(base.windows.map(w => [w.id, w])), lids = new Set(local.map(w => w.id));
    const out = clone(item.data.windows || []).filter(w => !(bmap.has(w.id) && !lids.has(w.id))); // closed here
    const omap = new Map(out.map(w => [w.id, w]));
    for (const l of local) {
      const b = bmap.get(l.id), o = omap.get(l.id);
      if (!b) { // added here; the same new id added elsewhere too: ours gets a fresh one
        if (o && !(o.kind === l.kind && o.ref === l.ref && o.text === l.text)) {
          const nid = "w" + (Math.max(0, ...[...out, ...local].map(w => Number(String(w.id).slice(1)) || 0)) + 1);
          const e = st.els.get(l.id); if (e) { st.els.delete(l.id); st.els.set(nid, e); e.el.dataset.id = nid; }
          if (st.here === l.id) st.here = nid;
          l.id = nid;
        }
        if (!omap.has(l.id)) { const c = clone(l); out.push(c); omap.set(c.id, c); }
        continue;
      }
      if (!o) continue; // closed elsewhere
      for (const k of new Set([...Object.keys(l), ...Object.keys(b)]))
        if (!same(l[k], b[k])) { if (l[k] === undefined) delete o[k]; else o[k] = clone(l[k]); }
    }
    const lh = st.open.data.highlight || null;
    const lz = st.open.data.zones || [];
    const ln = st.open.data.agentNotes || "";
    const data = { ...st.open.data, ...item.data, windows: out, agentNotes: same(ln, base.agentNotes || "") ? item.data.agentNotes || "" : ln, highlight: same(lh, base.highlight) ? item.data.highlight || null : lh,
      zones: same(lz, base.zones || []) ? item.data.zones || [] : lz };
    for (const k of ["view", "viewPhone"]) data[k] = st.open.data[k] ?? item.data[k]; // each device keeps its own view
    st.open = { ...item, data };
    setBase(item);
  }
  // a newer copy of the open session arrived (live event or a refused save): merge, redraw, glide what moved
  function takeRemote(item) {
    const was = new Map(wins().map(w => [w.id, geo(w)]));
    rebase(item);
    drawBoard();
    for (const w of wins()) { const o = was.get(w.id); if (o && (o.x !== w.x || o.y !== w.y || o.w !== w.w || o.h !== w.h)) glideWin(w, o); }
  }
  // never redraw under a finger: a copy arriving mid-drag waits until it ends
  function remote(item) {
    if (!board.classList.contains("busy")) { st.later = null; return takeRemote(item); }
    if (!st.later || item.updated > st.later.updated) st.later = item;
    clearTimeout(st.laterTimer); st.laterTimer = setTimeout(() => st.later && st.open?.id === st.later.id && st.later.updated > (st.baseAt || 0) ? remote(st.later) : null, 300);
  }
  async function saveOnce(it) {
    const body = { windows: it.data.windows, highlight: it.data.highlight || null, zones: it.data.zones || [], agentNotes: it.data.agentNotes || "", [VK()]: it.data[VK()] || null };
    const r = await fetch(`/k/items/${encodeURIComponent(it.id)}`, { method: "PATCH", body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...(st.baseAt ? { "x-if-updated": String(st.baseAt) } : {}) } });
    const out = await r.json().catch(() => ({}));
    if (r.status === 409 && out.item) return out.item; // changed elsewhere: merge and try again
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    if (st.open?.id === it.id && (!st.baseAt || out.updated > st.baseAt)) setBase(out);
    return null;
  }
  let saving = null;
  function save(now = false) {
    clearTimeout(st.saveTimer);
    if (!st.open) return Promise.resolve(true);
    // resolves true once saved, false when it failed (shown here; an agent run reports it too)
    const go = () => (saving = (async () => {
      await saving?.catch(() => {}); // one save at a time, each on the latest base
      for (let i = 0; i < 5 && st.open; i++) {
        const it = st.open;
        try { const newer = await saveOnce(it); if (!newer) return true; if (st.open?.id === newer.id) takeRemote(newer); }
        catch (e) { say(`Not saved: ${e.message}`, true); return false; }
      }
      if (st.open) say("Not saved: the board kept changing elsewhere", true);
      return false;
    })());
    if (now) return go();
    st.saveTimer = setTimeout(go, 400);
    return Promise.resolve();
  }

  async function newSession(title) {
    try {
      const it0 = await ctx.api("/k/items", { json: { type: "session", data: { title: title || `${Cap(WORD)} ${new Date().toLocaleDateString()}`, windows: [], view: { x: 0, y: 0, z: 1 } } } });
      // its own conversation, named in the item (the same name chatOf() gives a board without one)
      const it = await ctx.api(`/k/items/${encodeURIComponent(it0.id)}`, { method: "PATCH", json: { chatView: chatOf(it0) } }).catch(() => it0);
      st.list.unshift(it);
      ctx.levels.go(ME, it.id);
      return it;
    } catch (e) { say(`Could not make a ${WORD}: ${e.message}`, true); }
  }
  async function patchSession(id, patch) {
    const it = await ctx.api(`/k/items/${encodeURIComponent(id)}`, { method: "PATCH", json: patch });
    const i = st.list.findIndex(x => x.id === id);
    if (i >= 0) st.list[i] = it; else st.list.unshift(it);
    if (st.open?.id === id) { st.open.data = { ...st.open.data, ...patch }; drawHead(); }
    return it;
  }
  async function rename(id) {
    const it = st.list.find(x => x.id === id) || st.open;
    const name = prompt(`Rename ${WORD}`, it?.data.title || "");
    if (name === null || !name.trim()) return;
    try { await patchSession(id, { title: name.trim() }); if (!st.open) drawList(); } catch (e) { say(`Could not rename: ${e.message}`, true); }
  }
  async function hide(id, on = true) {
    try { await patchSession(id, { hidden: on ? true : null }); if (!st.open) drawList(); } catch (e) { say(`Could not ${on ? "hide" : "unhide"}: ${e.message}`, true); }
  }

  // ------------------------------------------------------------ the session list
  function drawHead() {
    const s = sess();
    titleEl.textContent = s ? s.title : Cap(WORDS);
    titleEl.dataset.tip = s ? "Tap to rename" : ""; if (!s) delete titleEl.dataset.tip;
    titleEl.onclick = s ? () => rename(st.open.id) : null;
    titleEl.classList.toggle("ss-ren", !!s);
    const tip = s ? `All ${WORDS}` : "All modalities";
    back.dataset.tip = tip; back.setAttribute("aria-label", tip);
    const at = s ? "Add a window" : `New ${WORD}`;
    addBtn.dataset.tip = at; addBtn.setAttribute("aria-label", at);
    fitBtn.hidden = arrBtn.hidden = !s;
    zoomEl.hidden = !s || st.narrow;
    if (s) zoomEl.textContent = `${Math.round(viewOf().z * 100)} %`;
  }

  function drawList() {
    drawHead();
    box.classList.remove("ss-open");
    const shown = st.list.filter(s => !s.data.hidden), hidden = st.list.filter(s => s.data.hidden);
    const row = (s, archived) => h("li", { class: "ss-row" },
      h("a", { href: `/m/${ME}/${s.id}`, class: s.id === st.last ? "here" : null, "data-id": s.id, "data-k-id": s.id, "data-k-kind": WORD, "data-tip": `Open ${s.data.title}`,
        onclick: e => { e.preventDefault(); ctx.levels.go(ME, s.id); } },
        h("b", {}, s.data.title || `Untitled ${WORD}`), h("small", {}, summary(s))),
      icon(PEN, `Rename ${WORD}`, () => rename(s.id)),
      archived ? icon(UNBOX, "Bring back from the archive", () => hide(s.id, false)) : icon(BOX, "Hide (archive, nothing is deleted)", () => hide(s.id, true)));
    body.replaceChildren(
      shown.length ? h("ul", { class: "ss-list", role: "list" }, shown.map(s => row(s, false)))
        : h("p", { class: "ss-empty" }, `No ${WORDS} yet. Tap + for a new one.`),
      hidden.length ? h("details", { class: "ss-arch" }, h("summary", { "data-tip": `Hidden ${WORDS}; bring one back with its box icon` }, `Archived (${hidden.length})`),
        h("ul", { class: "ss-list", role: "list" }, hidden.map(s => row(s, true)))) : null);
  }
  function summary(s) {
    const ws = s.data.windows || [];
    const kinds = [...new Set(ws.map(w => KINDS[w.kind]?.label || w.kind))];
    return ws.length ? `${ws.length} window${ws.length > 1 ? "s" : ""}: ${kinds.join(", ")}` : "empty";
  }

  // ------------------------------------------------------------ the board
  const plane = h("div", { class: "ss-plane" });
  // the dot grid is its own layer, moved by transform (no repaint while panning)
  const dots = h("div", { class: "ss-dots", "aria-hidden": "true" });
  // where a dragged window will land (the snapped grid slot)
  const ghost = h("div", { class: "ss-ghost", hidden: true, "aria-hidden": "true" });
  plane.append(ghost);
  const board = h("div", { class: "ss-board", "aria-label": `${Cap(WORD)} board` }, dots, plane);

  function drawBoard() {
    drawHead();
    box.classList.add("ss-open");
    board.classList.toggle("touch", touchy());
    if (body.firstChild !== board || body.childNodes.length > 1) body.replaceChildren(board);
    const ids = new Set(wins().map(w => w.id));
    for (const [id, e] of st.els) if (!ids.has(id)) { e.el.remove(); st.els.delete(id); }
    for (const w of wins()) drawWin(w);
    drawZones();
    // only new windows are added: moving one in the DOM reloads its frame
    // (a PDF or image flashed blank after every pan); stacking is z-index
    wins().forEach(w => { const e = st.els.get(w.id).el; if (e.parentNode !== plane) plane.append(e); });
    if (!wins().length) plane.append(emptyHint); else emptyHint.remove();
    applyView();
  }
  // zones: a frame with its title, behind every window; panning passes through it
  st.zels = new Map();
  function drawZones() {
    const ids = new Set(zones().map(z => z.id));
    for (const [id, el] of st.zels) if (!ids.has(id)) { el.remove(); st.zels.delete(id); }
    for (const z of zones()) {
      let el = st.zels.get(z.id);
      if (!el) { el = zoneEl(z.id); st.zels.set(z.id, el); }
      el.querySelector(".ss-ztitle").textContent = z.title;
      const s2 = el.style;
      s2.left = z.x + "px"; s2.top = z.y + "px"; s2.width = z.w + "px"; s2.height = z.h + "px";
      if (el.parentNode !== plane) plane.prepend(el);
    }
  }
  // by hand: drag the label (windows inside follow), tap it to rename, x removes the frame
  // (windows stay), the corner grip resizes. Same data as @zone, so both stay in sync.
  const zfind = id => zones().find(q => q.id === id);
  function zoneEl(id) {
    const ttl = h("span", { class: "ss-ztitle" });
    const x = icon(CLOSE, "Remove this section (its windows stay)", () => { const z = zfind(id); if (z) { dropZone(z.id); } }, "ss-zx");
    const label = h("div", { class: "ss-zname", "data-tip": "Drag to move; tap to rename" }, ttl, x);
    const grip = h("span", { class: "ss-grip ss-zgrip", "data-tip": "Drag to resize" }, svg(GRIP));
    const el = h("div", { class: "ss-zone", "data-k-id": id, "data-k-kind": "section" }, label, grip);
    let members = [], sx = 0, sy = 0, dx = 0, dy = 0;
    const mv = (ddx, ddy) => {
      const z = zfind(id); if (!z) return; dx = ddx; dy = ddy;
      el.style.left = z.x + dx + "px"; el.style.top = z.y + dy + "px";
      for (const w of members) { w.x = w.ox + dx; w.y = w.oy + dy; place(w); }
    };
    mv.start = () => { const z = zfind(id); if (!z) return; sx = z.x; sy = z.y; dx = dy = 0;
      members = wins().filter(w => zoneOf(w) === z); for (const w of members) { w.ox = w.x; w.oy = w.y; } el.classList.add("drag"); };
    track(label, mv, cancelled => {
      el.classList.remove("drag");
      const z = zfind(id); if (!z) return;
      if (Math.hypot(dx, dy) * viewOf().z < 8) {
        for (const w of members) { w.x = w.ox; w.y = w.oy; place(w); delete w.ox; delete w.oy; }
        el.style.left = z.x + "px"; el.style.top = z.y + "px";
        if (!cancelled) { const t = prompt("Section name", z.title); if (t?.trim()) { z.title = t.trim(); delete z.auto; drawZones(); save(); } }
        return;
      }
      const nx = snap(sx + dx), ny = snap(sy + dy), mx = nx - sx, my = ny - sy;
      for (const w of members) { const from = { x: w.ox + dx, y: w.oy + dy, w: w.w, h: w.h }; w.x = w.ox + mx; w.y = w.oy + my; delete w.ox; delete w.oy; glideWin(w, from); }
      z.x = nx; z.y = ny; el.style.left = nx + "px"; el.style.top = ny + "px"; save();
    });
    let sw = 0, sh = 0;
    const rs = (ddx, ddy) => { const z = zfind(id); if (!z) return; el.classList.add("drag");
      el.style.width = Math.max(240, sw + ddx) + "px"; el.style.height = Math.max(144, sh + ddy) + "px"; };
    rs.start = () => { const z = zfind(id); if (z) { sw = z.w; sh = z.h; } };
    track(grip, rs, () => {
      el.classList.remove("drag"); const z = zfind(id); if (!z) return;
      z.w = Math.max(240, snap(parseFloat(el.style.width))); z.h = Math.max(144, snap(parseFloat(el.style.height)));
      el.style.width = z.w + "px"; el.style.height = z.h + "px"; save();
    });
    return el;
  }
  function addZone() {
    if (!st.open) throw new Error(`no ${WORD} is open`);
    const all = zones(); let n = all.length + 1, t;
    while (all.some(q => q.title.toLowerCase() === (t = `Section ${n}`).toLowerCase())) n++;
    const r = board.getBoundingClientRect(), v = viewOf();
    const cx = ((r.width || innerWidth) / 2 - v.x) / v.z, cy = ((r.height || innerHeight) / 2 - v.y) / v.z;
    return setZone(t, cx - 480, cy - 360, 960, 720);
  }
  // @zone <title> <x> <y> <w> <h>: makes one or moves/resizes the one with that title (it glides)
  function setZone(title, x, y, ww, hh) {
    const t = String(title || "").trim(); if (!t) throw new Error("zone title missing");
    const all = sess().zones = [...zones()];
    let z = all.find(q => q.title.toLowerCase() === t.toLowerCase() || q.id === t);
    if (!z) { z = { id: "z" + (Math.max(0, ...all.map(q => Number(String(q.id).slice(1)) || 0)) + 1), title: t, x: 0, y: 0, w: 960, h: 720 }; all.push(z); }
    else { z.title = z.id === t ? z.title : t; delete z.auto; } // placed by hand or by the agent: no longer the automatic one
    z.x = snap(num(x, z.x)); z.y = snap(num(y, z.y)); z.w = Math.max(240, snap(num(ww, z.w))); z.h = Math.max(144, snap(num(hh, z.h)));
    drawBoard(); save(); return z;
  }
  function dropZone(title) {
    const t = String(title || "").trim().toLowerCase();
    const z = zones().find(q => q.title.toLowerCase() === t || q.id === t); if (!z) throw new Error(`no zone ${title}`);
    sess().zones = zones().filter(q => q !== z); drawBoard(); save(); return z;
  }
  const emptyHint = h("p", { class: "ss-empty ss-hint" }, "An empty board. Tap + (top right) to add a window: a thread, the thread list, Task Tinder, Projects, a note, a file or a web page.");

  function winTitle(w) {
    if (w.kind === "thread" && !w.named) return threadTitle(w.ref) || w.title || "Thread";
    return w.title || KINDS[w.kind]?.label || w.kind;
  }

  function drawWin(w) {
    let e = st.els.get(w.id);
    if (!e) {
      const name = h("span", { class: "ss-wname" });
      const fold = icon(UP, "Fold to the title bar", () => setCollapsed(w.id, !find(w.id)?.collapsed, true), "ss-fold");
      const edit = w.kind === "note" ? icon(PEN, "Edit the note", () => toggleEdit(w.id), "ss-edit") : null;
      const tbar = h("div", { class: "ss-wbar" }, name, edit,
        w.kind === "note" ? null : icon(FULL, "Open in full", () => openFull(w.id)), fold, icon(CLOSE, "Close window", () => closeWin(w.id)));
      name.addEventListener("dblclick", () => { const cur = find(w.id); const t = cur && prompt("Window name", winTitle(cur)); if (t?.trim()) setTitle(w.id, t.trim()); });
      const content = h("div", { class: "ss-wbody" });
      const grip = h("span", { class: "ss-grip", "data-tip": "Drag to resize" }, svg(GRIP));
      const el = h("section", { class: "ss-win", "data-id": w.id, "data-k-id": w.id, "data-k-kind": `${w.kind} window`, "data-k-order": "", "aria-label": "Window" }, tbar, content, grip);
      e = { el, name, fold, edit, content, frame: null, src: "", md: null, text: null, editing: false };
      st.els.set(w.id, e);
      el.addEventListener("pointerdown", ev => {
        // touch board: a finger on a window that is not focused pans the board; a tap focuses it (see lift)
        if (touchy() && st.here !== w.id && !ev.target.closest(".ss-wbar, .ss-grip, button")) return;
        tapWin(w.id);
      }, true);
      dragWin(tbar, w.id); resizeWin(grip, w.id);
    }
    const cur = find(w.id) || w;
    e.name.textContent = winTitle(cur); e.name.dataset.tip = `${KINDS[cur.kind]?.label || cur.kind}: ${winTitle(cur)}. Tap to fold or unfold, drag to move, double-click to rename`;
    const hl = sess()?.highlight;
    e.el.classList.toggle("hl", hl?.id === cur.id);
    e.el.classList.toggle("fresh", !!cur.fresh && hl?.id !== cur.id);
    if (hl?.id === cur.id) e.el.dataset.tip = hl.reason ? `Look here: ${hl.reason}` : "Look here";
    else if (cur.fresh) e.el.dataset.tip = typeof cur.fresh === "string" ? `New: ${cur.fresh}` : "New";
    else delete e.el.dataset.tip;
    e.el.classList.toggle("collapsed", !!cur.collapsed);
    e.el.classList.toggle("here", cur.id === st.here);
    const ft = cur.collapsed ? "Unfold" : "Fold to the title bar";
    e.fold.dataset.tip = ft; e.fold.setAttribute("aria-label", ft); e.fold.replaceChildren(svg(cur.collapsed ? DOWN : UP));
    if (cur.kind === "note") { drawNote(cur, e); place(cur); return; }
    // a folded window drops its frame (no page running behind a title bar)
    const src = srcOf(cur);
    if (cur.collapsed || !src) { if (e.frame) { e.frame.remove(); e.frame = null; e.src = ""; } if (!src) e.content.replaceChildren(h("p", { class: "ss-empty" }, "Nothing to show here.")); }
    else if (!e.frame || e.src !== src) {
      e.frame = h("iframe", { class: "ss-frame", src, title: winTitle(cur), allow: "microphone; autoplay; clipboard-read; clipboard-write; fullscreen" });
      e.frame.addEventListener("load", () => { darkFrame(e.frame); ctx.bar.refresh(); });
      e.src = src; e.pdf = false; e.fz = 1; e.content.replaceChildren(e.frame);
      if (cur.kind === "file") {
        const fr = e.frame;
        const ac = new AbortController();
        fetch(src, { signal: ac.signal }).then(r => { ac.abort(); if (e.frame === fr && /pdf/i.test(r.headers.get("content-type") || "")) { e.pdf = true; sharpen(e); } }).catch(() => {});
      }
    }
    place(cur);
  }
  // a note: Markdown kept in the session; links open in a new tab
  function drawNote(w, e) {
    if (e.editing) return;
    const text = w.text || "";
    if (e.md && e.text === text) return;
    e.text = text;
    e.md = h("div", { class: "ss-md c-text" }, text.trim() ? render(text) : h("p", { class: "ss-empty" }, "An empty note. Tap the pen to write."));
    e.content.replaceChildren(e.md);
  }
  function toggleEdit(id) {
    const w = find(id), e = st.els.get(id); if (!w || !e) return;
    if (!e.editing) {
      seen(id); if (w.collapsed) setCollapsed(id, false);
      e.editing = true;
      const ta = h("textarea", { class: "ss-mdedit", "aria-label": "Note text (Markdown)", spellcheck: "true" });
      ta.value = w.text || "";
      ta.addEventListener("input", () => { w.text = ta.value; save(); });
      e.content.replaceChildren(ta); ta.focus();
    } else {
      const ta = e.content.querySelector("textarea");
      if (ta) w.text = ta.value;
      e.editing = false; e.md = null; drawNote(w, e); save();
    }
    const t = e.editing ? "Done editing" : "Edit the note";
    e.edit.dataset.tip = t; e.edit.setAttribute("aria-label", t); e.edit.replaceChildren(svg(e.editing ? CHECK : PEN));
    e.el.classList.toggle("editing", e.editing);
  }
  function setNote(id, text) {
    const w = find(id); if (!w) throw new Error(`no window ${id}`);
    if (w.kind !== "note") throw new Error(`${id} is not a note`);
    const e = st.els.get(id);
    if (e?.editing) throw new Error(`${WHO} is editing ${id}`);
    w.text = String(text || ""); drawWin(w); save();
  }
  function setTitle(id, title) {
    const w = find(id); if (!w) throw new Error(`no window ${id}`);
    w.title = String(title).slice(0, 120); w.named = true; drawWin(w); save(); ctx.bar.refresh();
  }
  // "look here": one window at a time, pink frame; a tap on it (or @unhighlight) clears it
  function setHighlight(id, reason = "") {
    if (!st.open) return;
    if (id && !find(id)) throw new Error(`no window ${id}`);
    st.open.data.highlight = id ? { id, reason: String(reason).slice(0, 200) } : null;
    for (const w of wins()) drawWin(w);
    save();
    if (id) {
      const w = find(id);
      const r = board.getBoundingClientRect(), v = viewOf();
      const vis = w.x * v.z + v.x >= 0 && (w.x + w.w) * v.z + v.x <= r.width && w.y * v.z + v.y >= 0 && w.y * v.z + v.y + 40 <= r.height;
      if (!vis) focusWin(id);
    }
  }
  function place(w) {
    const e = st.els.get(w.id);
    if (!e) return;
    const s = e.el.style;
    s.left = w.x + "px"; s.top = w.y + "px"; s.width = w.w + "px"; s.height = w.collapsed ? "" : w.h + "px"; s.zIndex = String(w.z || 1);
  }
  // a window moves to its saved place smoothly: drawn where it was (from:
  // {x, y, w, h}), then transform and size ease to the new place (FLIP)
  function glideWin(w, from) {
    const e = st.els.get(w.id);
    if (!e || !from) return place(w);
    const el = e.el, s = el.style;
    clearTimeout(e.gt); el.classList.remove("glide");
    place(w);
    s.transform = `translate(${from.x - w.x}px, ${from.y - w.y}px)`;
    if (!w.collapsed) { s.width = from.w + "px"; s.height = from.h + "px"; }
    void el.offsetWidth; // the start state is drawn first
    el.classList.add("glide");
    s.transform = ""; place(w);
    e.gt = setTimeout(() => el.classList.remove("glide"), GLIDE + 60);
  }
  const geo = w => ({ x: w.x, y: w.y, w: w.w, h: w.h });
  // one view update per frame; the plane and the dots move by transform only
  let viewRaf = 0, dotSize = "";
  function applyView() { if (!viewRaf) viewRaf = requestAnimationFrame(paintView); }
  function paintView() {
    viewRaf = 0;
    const v = viewOf();
    plane.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    const c = GRID * v.z, m = n => (((n + 64) % c) + c) % c; // the layer reaches 64px past each edge
    dots.style.transform = `translate(${m(v.x)}px, ${m(v.y)}px)`;
    const ds = `${c}px ${c}px`;
    if (ds !== dotSize) { dotSize = ds; dots.style.backgroundSize = ds; }
    const zt = `${Math.round(v.z * 100)} %`;
    if (zoomEl.textContent !== zt) zoomEl.textContent = zt;
    sharpenSoon();
  }
  // A PDF viewer rasterises at its own size, so the plane's scale(z) would
  // stretch its bitmap. Once the zoom settles the frame is laid out z times
  // larger and scaled by 1/z: the viewer draws at the on-screen size.
  function sharpen(e) {
    if (!e.pdf || !e.frame) return;
    const z = Math.max(0.25, Math.round(viewOf().z * 20) / 20);
    if (e.fz === z) return;
    e.fz = z;
    const f = e.frame.style;
    f.flex = "none"; f.width = (z * 100) + "%"; f.height = (z * 100) + "%";
    f.transform = z === 1 ? "" : `scale(${1 / z})`; f.transformOrigin = "0 0";
  }
  let sharpT = 0;
  function sharpenSoon() { clearTimeout(sharpT); sharpT = setTimeout(() => { for (const e of st.els.values()) sharpen(e); }, 350); }
  // while the view moves the plane is its own compositor layer (no repaint per
  // frame); at rest it is drawn normally again, so text is crisp at any zoom
  let movingT = 0;
  function moving() {
    board.classList.add("moving");
    clearTimeout(movingT);
    movingT = setTimeout(() => { if (!board.classList.contains("panning")) board.classList.remove("moving"); }, 200);
  }
  const find = id => wins().find(w => w.id === id);
  function setView(v) { if (!st.open) return; st.open.data[VK()] = { ...viewOf(), ...v }; moving(); applyView(); save(); }
  // the view eases to a target (Fit, focus, zoom to 100 %); a touch stops it
  let viewGlide = 0;
  function glideView(to) {
    cancelAnimationFrame(viewGlide);
    const from = viewOf(), t0 = performance.now();
    const step = now => {
      const k = ease(Math.min(1, (now - t0) / (GLIDE + 80)));
      setView({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z * Math.pow(to.z / from.z, k) });
      if (k < 1) viewGlide = requestAnimationFrame(step);
    };
    viewGlide = requestAnimationFrame(step);
  }
  function zoomAt(z, cx, cy) {
    const v = viewOf(), nz = clamp(z, ZMIN, ZMAX);
    // keep the board point under (cx, cy) in place
    setView({ z: nz, x: cx - (cx - v.x) * nz / v.z, y: cy - (cy - v.y) * nz / v.z });
  }
  function zoomTo(z) {
    const r = board.getBoundingClientRect(), v = viewOf(), cx = r.width / 2, cy = r.height / 2, nz = clamp(z, ZMIN, ZMAX);
    glideView({ z: nz, x: cx - (cx - v.x) * nz / v.z, y: cy - (cy - v.y) * nz / v.z });
  }
  function fitAll() {
    const ws = [...wins(), ...zones().map(z => ({ ...z, collapsed: false }))];
    if (!ws.length) return glideView({ x: 0, y: 0, z: 1 });
    const r = board.getBoundingClientRect(), pad = 24;
    const x0 = Math.min(...ws.map(w => w.x)), y0 = Math.min(...ws.map(w => w.y));
    const x1 = Math.max(...ws.map(w => w.x + w.w)), y1 = Math.max(...ws.map(w => w.y + (w.collapsed ? 40 : w.h)));
    const z = clamp(Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad) / (y1 - y0)), ZMIN, 1);
    glideView({ z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z });
  }
  // Arrange: rows in reading order, each window on the grid, a gap between
  // them, no overlap (full heights, so unfolding one never covers another);
  // the rows are about as wide as the screen's shape asks; then show all
  // With zones, each zone is tidied on its own: rows from its top left corner,
  // as wide as the zone, and the zone grows to hold them; windows outside any
  // zone are tidied together, as before.
  function arrange(only = "") {
    if (!wins().length) return;
    const r = board.getBoundingClientRect(), aspect = r.width / Math.max(1, r.height) || 1.6;
    const from = new Map(wins().map(w => [w.id, geo(w)]));
    const groups = new Map(); // zone id or "" -> windows (decided before anything moves)
    for (const w of wins()) { const z = zoneOf(w), k = z?.id || ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(w); }
    const pad = GRID * 2, top = GRID * 3; // inside a zone: room for its title
    for (const [k, list] of groups) {
      const z = zones().find(q => q.id === k);
      if (only && (!z || (z.title.toLowerCase() !== only.toLowerCase() && z.id !== only))) continue;
      const ws = list.sort((a, b) => a.y - b.y || a.x - b.x);
      const area = ws.reduce((s, w) => s + (snapUp(w.w) + GAP) * (snapUp(w.h) + GAP), 0);
      const rowW = z ? Math.max(...ws.map(w => snapUp(w.w)), z.w - 2 * pad) : Math.max(...ws.map(w => snapUp(w.w)), Math.sqrt(area * aspect));
      const x0 = z ? snap(z.x + pad) : snap(Math.min(...ws.map(w => w.x))), y0 = z ? snap(z.y + top) : snap(Math.min(...ws.map(w => w.y)));
      let x = x0, y = y0, rowH = 0;
      for (const w of ws) {
        if (x > x0 && x - x0 + w.w > rowW) { x = x0; y += rowH + GAP; rowH = 0; }
        w.x = x; w.y = y;
        x += snapUp(w.w) + GAP; rowH = Math.max(rowH, snapUp(w.h));
      }
      if (z) { // the zone grows (never shrinks) to hold its windows
        const x1 = Math.max(...ws.map(w => w.x + snapUp(w.w))) + pad, y1 = Math.max(...ws.map(w => w.y + snapUp(w.h))) + pad;
        z.w = Math.max(z.w, snapUp(x1 - z.x)); z.h = Math.max(z.h, snapUp(y1 - z.y));
      }
    }
    drawZones();
    wins().forEach(w => glideWin(w, from.get(w.id)));
    save(); if (!only) fitAll();
  }
  function focusWin(id) {
    const w = find(id); if (!w) return;
    raise(id);
    const r = board.getBoundingClientRect(), v = viewOf();
    glideView({ x: r.width / 2 - (w.x + w.w / 2) * v.z, y: r.height / 2 - (w.y + Math.min(w.h, r.height / v.z - 40) / 2) * v.z, z: v.z });
  }

  function raise(id) {
    const w = find(id); if (!w) return;
    const top = Math.max(0, ...wins().map(x => x.z || 0));
    const was = st.here; st.here = id;
    if ((w.z || 0) < top || !w.z) { w.z = top + 1; place(w); save(); }
    if (was !== id) for (const x of wins()) st.els.get(x.id)?.el.classList.toggle("here", x.id === id);
    if (talks(w)) ctx.bar.focus(WIN); else ctx.bar.refresh();
  }
  // windows into the app's own views take the bar's input; files and web pages do not
  const talks = w => !!w && !w.collapsed && !["file", "url", "note"].includes(w.kind);
  const hereWin = () => { const w = find(st.here); return talks(w) && st.els.get(w.id)?.frame ? w : null; };
  // a tap inside a frame does not reach this page: notice the focus moving into it
  addEventListener("blur", () => setTimeout(() => {
    const f = document.activeElement;
    if (f?.classList?.contains("ss-frame")) { const id = f.closest(".ss-win")?.dataset.id; if (id) { raise(id); seen(id); } }
  }, 0));

  // pointer drags: title bar moves, the corner resizes, the background pans
  function track(el, onMove, onEnd) {
    el.addEventListener("pointerdown", e => {
      if (e.button > 0 || e.target.closest("button")) return;
      e.preventDefault(); e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const x0 = e.clientX, y0 = e.clientY, id = e.pointerId;
      board.classList.add("busy");
      const move = ev => { if (ev.pointerId === id) onMove((ev.clientX - x0) / viewOf().z, (ev.clientY - y0) / viewOf().z); };
      const up = ev => {
        if (ev.pointerId !== id) return;
        el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
        board.classList.remove("busy"); onEnd?.(ev.type === "pointercancel");
      };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
      onMove.start?.();
    });
  }
  // the dashed slot a dragged window will snap into
  function showGhost(w, x, y, ww, hh) {
    const s = ghost.style;
    s.left = x + "px"; s.top = y + "px"; s.width = ww + "px"; s.height = hh + "px"; s.zIndex = String(Math.max(0, (w.z || 1) - 1));
    ghost.hidden = false;
  }
  // a window follows the pointer by transform (no layout per move); on drop it
  // glides into the nearest grid slot. A tap (under 8 screen px of movement)
  // folds or unfolds the window instead.
  function dragWin(tbar, id) {
    let sx = 0, sy = 0, dx = 0, dy = 0;
    const el = () => st.els.get(id)?.el;
    const mv = (ddx, ddy) => {
      const w = find(id), e = el(); if (!w || !e) return;
      dx = ddx; dy = ddy;
      e.style.transform = `translate(${dx}px, ${dy}px)`;
      showGhost(w, snap(sx + dx), snap(sy + dy), w.w, w.collapsed ? e.offsetHeight : w.h);
    };
    mv.start = () => { const w = find(id), e = el(); sx = w.x; sy = w.y; dx = dy = 0; e?.classList.remove("glide"); e?.classList.add("drag"); };
    track(tbar, mv, cancelled => {
      ghost.hidden = true; el()?.classList.remove("drag");
      const w = find(id); if (!w) return;
      if (Math.hypot(dx, dy) * viewOf().z < 8) { if (el()) el().style.transform = ""; if (!cancelled) setCollapsed(id, !w.collapsed, true); return; }
      const from = { ...geo(w), x: sx + dx, y: sy + dy };
      w.x = snap(from.x); w.y = snap(from.y);
      glideWin(w, from); pruneAuto(); drawZones(); save();
    });
  }
  function resizeWin(grip, id) {
    let sw = 0, sh = 0;
    const mv = (dx, dy) => {
      const w = find(id); if (!w) return;
      w.w = Math.round(Math.max(200, sw + dx)); if (!w.collapsed) w.h = Math.round(Math.max(120, sh + dy)); place(w);
      showGhost(w, w.x, w.y, Math.max(216, snap(w.w)), w.collapsed ? st.els.get(id).el.offsetHeight : Math.max(120, snap(w.h)));
    };
    mv.start = () => { const w = find(id); sw = w.w; sh = w.h; };
    track(grip, mv, () => {
      ghost.hidden = true;
      const w = find(id); if (!w) return;
      const from = geo(w);
      w.w = Math.max(216, snap(w.w)); if (!w.collapsed) w.h = Math.max(120, snap(w.h));
      glideWin(w, from); save();
    });
  }
  // background: one pointer pans, two pinch-zoom
  const pts = new Map();
  let pinch = null;
  // where a finger may start a pan: the background, or (touch) a window that is not focused
  const pannable = t => t === board || t === plane || t.classList.contains("ss-hint") || !!t.closest(".ss-zone")
    || (touchy() && !!t.closest(".ss-win") && !t.closest(".ss-wbar, .ss-grip, button") && t.closest(".ss-win").dataset.id !== st.here);
  let tap = null; // a touch on a window that may turn out to be a tap (focus it) rather than a pan
  board.addEventListener("pointerdown", e => {
    if (!pannable(e.target)) return;
    e.preventDefault();
    tap = !pts.size ? { id: e.target.closest(".ss-win")?.dataset.id || "", x: e.clientX, y: e.clientY, p: e.pointerId } : null;
    try { board.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    if (!pts.size) { ctx.bar.focus(ME); st.brect = board.getBoundingClientRect(); }
    cancelAnimationFrame(viewGlide);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    board.classList.add("busy", "panning", "moving");
    pinch = null;
  });
  board.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId)) return;
    const [px, py] = pts.get(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (tap && (e.pointerId !== tap.p || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8)) tap = null;
    const r = st.brect || board.getBoundingClientRect();
    if (pts.size === 1) { const v = viewOf(); setView({ x: v.x + e.clientX - px, y: v.y + e.clientY - py }); return; }
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2 - r.left, my = (a[1] + b[1]) / 2 - r.top;
    if (pinch) {
      const v = viewOf();
      setView({ x: v.x + mx - pinch.mx, y: v.y + my - pinch.my });
      zoomAt(viewOf().z * d / pinch.d, mx, my);
    }
    pinch = { d, mx, my };
  });
  const lift = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId); pinch = null;
    if (!pts.size) { board.classList.remove("busy", "panning"); moving(); }
    if (tap && e.type === "pointerup" && tap.p === e.pointerId && tap.id) tapWin(tap.id);
    tap = null;
  };
  board.addEventListener("pointerup", lift); board.addEventListener("pointercancel", lift);
  board.addEventListener("wheel", e => {
    if (!st.open) return;
    e.preventDefault();
    cancelAnimationFrame(viewGlide);
    const r = board.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(viewOf().z * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
    else { const v = viewOf(); setView({ x: v.x - e.deltaX, y: v.y - e.deltaY }); }
  }, { passive: false });

  addEventListener("resize", () => {
    const n = matchMedia(NARROW).matches;
    if (n !== st.narrow) { st.narrow = n; if (st.open) { drawBoard(); firstView(); } else drawHead(); }
  });
  // a phone that never looked at this board starts with all windows in view
  function firstView() { if (st.open && st.narrow && !sess().viewPhone) requestAnimationFrame(() => fitAll()); }
  // the user's own tap on a window: focus it, clear "look here"
  function tapWin(id) { raise(id); if (sess()?.highlight?.id === id) setHighlight(""); seen(id); }
  // "new" (green frame): set by the agent, cleared once the user looks (tap, focus, unfold)
  function setFresh(id, on, reason = "") {
    const w = find(id); if (!w) throw new Error(`no window ${id}`);
    if (on) w.fresh = String(reason).trim().slice(0, 200) || true; else delete w.fresh;
    drawWin(w); save();
  }
  function seen(id) { if (find(id)?.fresh) setFresh(id, false); }

  // ------------------------------------------------------------ windows
  // the zone named in an agent line ("in <zone>"), or null
  const zoneNamed = t => { const q = String(t || "").trim().toLowerCase(); return q ? zones().find(z => z.title.toLowerCase() === q || z.id === q) || null : null; };
  // "<rest> in <zone title>" -> [rest, zone] when the tail names an existing zone
  function splitZone(a) {
    const m = [...String(a).matchAll(/\s+in\s+/gi)];
    for (const x of m) { const z = zoneNamed(a.slice(x.index + x[0].length)); if (z) return [a.slice(0, x.index).trim(), z]; }
    return [a, null];
  }
  // the zone the agent's unplaced windows land in, below all others (made on demand)
  function unsorted(size) {
    const all = sess().zones = [...zones()];
    let z = all.find(q => q.auto) || all.find(q => q.title.toLowerCase() === "unsorted");
    if (z) return z;
    const r = P.belowZones(all, P.snapUp(size.w + 2 * P.PAD), P.snapUp(P.TOP + size.h + P.PAD));
    z = { id: "z" + (Math.max(0, ...all.map(q => Number(String(q.id).slice(1)) || 0)) + 1), title: "Unsorted", auto: true, ...r };
    all.push(z); return z;
  }
  // an empty "Unsorted" goes away by itself
  function pruneAuto() {
    const keep = zones().filter(z => !z.auto || wins().some(w => P.inZone(z, w)));
    if (keep.length !== zones().length) sess().zones = keep;
  }
  // a zone grows (never shrinks) to hold a window (by default the zone holding its centre)
  function growFor(w, z = zoneOf(w)) {
    if (!z) return;
    const g = P.grown(z, w); z.w = g.w; z.h = g.h;
  }
  // where a new window of size k goes; opts.zone = a zone, opts.agent = placed by the agent
  function slotFor(k, opts) {
    const size = { w: k.w, h: k.h }, ws = wins();
    if (opts.zone) return { ...P.slotIn(opts.zone, ws, size, zones()), zone: opts.zone };
    if (opts.agent && zones().length) { const z = unsorted(size); return { ...P.slotIn(z, ws, size, zones()), zone: z }; }
    const r = board.getBoundingClientRect(), v = viewOf();
    const cx = ((r.width || innerWidth) / 2 - v.x) / v.z, cy = ((r.height || innerHeight) / 2 - v.y) / v.z;
    const at = { x: snap(cx - k.w / 2), y: snap(cy - Math.min(k.h, 520) / 2), ...size };
    return P.nearestFree(at, ws, P.zoneOf(zones(), at)) || P.nearestFree(at, ws) || at;
  }
  function addWin(kind, ref = "", title = "", opts = {}) {
    if (!st.open) throw new Error(`no ${WORD} is open`);
    if (!KINDS[kind]) throw new Error(`unknown window kind ${kind}`);
    if (kind === "thread" && !ref) throw new Error("which thread?");
    if (kind === "file" && !ref) throw new Error("which file?");
    if (kind === "url" && !safeUrl(ref)) throw new Error("not an http(s) address");
    const ws = st.open.data.windows ||= [];
    const id = "w" + (Math.max(0, ...ws.map(w => Number(String(w.id).slice(1)) || 0)) + 1);
    const k = KINDS[kind], at = slotFor(k, opts);
    const w = { id, kind, ref: kind === "url" ? safeUrl(ref) : kind === "note" ? "" : String(ref), title: title || (kind === "url" ? new URL(safeUrl(ref)).host : ""),
      ...(kind === "note" ? { text: String(ref || "") } : {}),
      x: at.x, y: at.y, w: k.w, h: k.h, collapsed: false,
      z: Math.max(0, ...ws.map(x => x.z || 0)) + 1 };
    ws.push(w); st.here = id; growFor(w, at.zone || zoneOf(w));
    drawBoard(); save();
    if (talks(w)) ctx.bar.focus(WIN);
    return w;
  }
  function setCollapsed(id, on, byHim = false) {
    const w = find(id); if (!w) throw new Error(`no window ${id}`);
    w.collapsed = !!on; if (!on && byHim) delete w.fresh;
    drawWin(w); save(); ctx.bar.refresh();
  }
  function closeWin(id) {
    if (!find(id)) throw new Error(`no window ${id}`);
    st.open.data.windows = wins().filter(w => w.id !== id);
    if (sess()?.highlight?.id === id) st.open.data.highlight = null;
    if (st.here === id) { st.here = ""; ctx.bar.focus(ME); }
    pruneAuto(); drawBoard(); save();
  }
  function moveWin(id, x, y, ww, hh) {
    const w = find(id); if (!w) throw new Error(`no window ${id}`);
    const from = geo(w);
    w.x = snap(num(x, w.x)); w.y = snap(num(y, w.y));
    if (ww != null) w.w = Math.max(216, snap(num(ww, w.w)));
    if (hh != null) w.h = Math.max(120, snap(num(hh, w.h)));
    // onto another window: the nearest free slot in the same zone instead
    const others = wins().filter(o => o !== w), hit = others.find(o => P.overlaps(w, o));
    let note = "";
    if (hit) {
      const z = zoneOf(w), p = P.nearestFree(w, others, z) || (z ? P.slotIn(z, others, w, zones()) : null);
      if (p) { w.x = p.x; w.y = p.y; note = ` (nudged to x ${p.x} y ${p.y}: ${hit.id} was there)`; }
    }
    growFor(w); pruneAuto(); drawZones();
    glideWin(w, from); save();
    return note;
  }
  function openFull(id) {
    const w = find(id); if (!w) return;
    const url = fullOf(w);
    if (w.kind === "file" || w.kind === "url") open(url, "_blank", "noopener");
    else location.assign(url);
  }
  async function addFile() {
    const f = fileIn.files?.[0]; fileIn.value = "";
    if (!f) return;
    say(`Uploading ${f.name}…`);
    try { const it = await ctx.upload(f); addWin("file", it.id, f.name); say(""); } catch (e) { say(`Upload failed: ${e.message}`, true); }
  }

  // the add-window picker: a small menu right under its button (locality)
  function togglePick(on = pick.hidden) {
    if (!on) { pick.hidden = true; return; }
    const item = (label, tip, fn) => h("button", { class: "ss-pi k-pop-i", type: "button", role: "menuitem", "data-tip": tip, onclick: fn }, label);
    const done = fn => () => { pick.hidden = true; try { fn(); } catch (e) { say(e.message, true); } };
    pick.replaceChildren(
      item("Thread…", "A chat thread: pick one", () => threadPick()),
      item("Thread list", "All threads, with their own conversation", done(() => addWin("threads"))),
      item("Task Tinder", `Swipe ${AG}'s task suggestions`, done(() => addWin("tinder"))),
      item("Projects", "The project list and dashboards", done(() => addWin("projects"))),
      item("Section", "A labelled frame to group windows; drag its label, tap to rename", done(() => addZone())),
      item("Note", "A short Markdown note; tap its pen to write", done(() => { const w = addWin("note", "", "Note"); toggleEdit(w.id); })),
      item("File or PDF…", "Upload a file; it opens in the browser's own viewer", done(() => fileIn.click())),
      item("Web page…", "Any http(s) address", done(() => { const u = prompt("Web address (https://…)", "https://"); if (u && u.trim() !== "https://") addWin("url", u.trim()); })));
    pick.hidden = false;
    anchor();
  }
  async function threadPick() {
    pick.replaceChildren(h("p", { class: "ss-empty" }, "Loading threads…")); anchor();
    await loadThreads();
    const back2 = h("button", { class: "ss-pi k-pop-i ss-pback k-pop-back", type: "button", "data-tip": "Back to the window kinds", onclick: () => togglePick(true) }, "‹ Window kinds");
    pick.replaceChildren(back2, h("div", { class: "ss-pscroll k-pop-scroll" }, st.threads.slice(0, 40).map(t =>
      h("button", { class: "ss-pi k-pop-i", type: "button", role: "menuitem", "data-tip": `Add “${t.data.title || t.id}” as a window`,
        onclick: () => { pick.hidden = true; try { addWin("thread", t.id, t.data.title); } catch (e) { say(e.message, true); } } }, t.data.title || t.id))));
    anchor();
  }
  function anchor() {
    const b = addBtn.getBoundingClientRect(), r = box.getBoundingClientRect();
    pick.style.top = (b.bottom - r.top + 4) + "px";
    pick.style.right = Math.max(4, r.right - b.right) + "px";
  }
  addEventListener("pointerdown", e => { if (!pick.hidden && !pick.contains(e.target) && !addBtn.contains(e.target)) pick.hidden = true; }, true);
  addEventListener("keydown", e => { if (e.key === "Escape") pick.hidden = true; });

  // ------------------------------------------------------------ agent notes
  // Hidden Markdown kept in the session (session.agentNotes, windows[].agentNotes):
  // conventions agreed on this board. describe() puts them first in every prompt.
  const NOTE_MAX = 4000;
  // notes for all blackboards live in the kernel settings: saved a moment after typing stops
  let allTimer = 0, allText = null;
  const saveAll = () => { clearTimeout(allTimer); const t = allText; allText = null;
    return t === null ? Promise.resolve() : setViewNotes(ctx, ME, t).then(() => say("")).catch(e => say(`Notes not saved: ${e.message}`, true)); };
  function drawMemo() {
    const field = (label, get, set, tip, after = save) => {
      const ta = h("textarea", { class: "ss-memota", rows: 3, spellcheck: "true", "aria-label": label, "data-tip": tip });
      ta.value = get() || "";
      ta.addEventListener("input", () => { set(ta.value.slice(0, NOTE_MAX)); after(); });
      return h("label", { class: "ss-memof" }, h("span", {}, label), ta);
    };
    const all = field(`All ${WORDS}`, () => (allText ?? viewNotes(ctx, ME)), v => { allText = v; },
      `Read on every ${WORD} and in the ${WORD} list`, () => { clearTimeout(allTimer); allTimer = setTimeout(saveAll, 600); });
    memo.replaceChildren(
      h("p", { class: "ss-memoh" }, `Agent notes: ${AG} reads these at the top of every prompt. Not shown anywhere else.`),
      all,
      ...(st.open ? [
        field(`This ${WORD}`, () => sess().agentNotes, v => { sess().agentNotes = v; }, `Conventions for this ${WORD} only`),
        ...wins().map(w => field(`${w.id} · ${winTitle(w)}`, () => w.agentNotes, v => { if (v.trim()) w.agentNotes = v; else delete w.agentNotes; }, "Notes about this window"))] : []));
  }
  ctx.onSettings?.(() => { if (!memo.hidden && allText === null) drawMemo(); });
  function toggleMemo(on = memo.hidden) {
    if (!on) saveAll();
    memo.hidden = !on; memoBtn.classList.toggle("on", on);
    if (on) { pick.hidden = true; drawMemo(); const b = memoBtn.getBoundingClientRect(), r = box.getBoundingClientRect();
      memo.style.top = (b.bottom - r.top + 4) + "px"; memo.style.right = Math.max(4, Math.min(r.right - b.right, r.width - memo.offsetWidth - 4)) + "px"; } // under the button, never past the left edge
  }
  addEventListener("pointerdown", e => { if (!memo.hidden && !memo.contains(e.target) && !memoBtn.contains(e.target)) toggleMemo(false); }, true);
  addEventListener("keydown", e => { if (e.key === "Escape" && !memo.hidden) toggleMemo(false); });
  // @memo <text> | @memo <window id> <text> | @memo-clear [window id]: appends, never replaces
  function memoAdd(a) {
    const m = a.match(/^(w\d+)\s+([\s\S]+)$/);
    const target = m ? find(m[1]) : sess();
    if (m && !target) throw new Error(`no window ${m[1]}`);
    const add = (m ? m[2] : a).trim(); if (!add) throw new Error("usage: @memo [window id] <text>");
    const cur = target.agentNotes || "";
    const next = (cur ? cur.replace(/\s+$/, "") + "\n" : "") + add;
    if (next.length > NOTE_MAX) throw new Error(`notes full (${NOTE_MAX} characters): @memo-clear first, then write them again shorter`);
    target.agentNotes = next; if (!memo.hidden) drawMemo();
    return m ? `memo ${m[1]}` : "memo";
  }
  // @memo-all <text> | @memo-all-clear: the notes for every blackboard (appends, never replaces)
  async function memoAll(add) {
    add = add.trim(); if (!add) throw new Error("usage: @memo-all <text>");
    const cur = viewNotes(ctx, ME), next = (cur ? cur.replace(/\s+$/, "") + "\n" : "") + add;
    if (next.length > NOTE_MAX) throw new Error(`notes full (${NOTE_MAX} characters): @memo-all-clear first, then write them again shorter`);
    await setViewNotes(ctx, ME, next); if (!memo.hidden) drawMemo();
    return "memo-all";
  }
  async function memoAllClear() { await setViewNotes(ctx, ME, ""); if (!memo.hidden) drawMemo(); return "memo-all-clear"; }
  function memoClear(id) {
    if (id) { const w = find(id); if (!w) throw new Error(`no window ${id}`); delete w.agentNotes; }
    else delete sess().agentNotes;
    if (!memo.hidden) drawMemo();
    return id ? `memo-clear ${id}` : "memo-clear";
  }

  // ------------------------------------------------------------ the agent: describe + @lines
  // a long note is cut in the prompt, so the rules and actions always fit
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}… (${t.length - n} more characters; ask to see the full text)` : t);
  const describe = async () => {
    await loadThreads();
    const threads = st.threads.slice(0, 25).map(t => `- ${t.id} | ${t.data.title || ""}`).join("\n");
    const memoAllLines = `@memo-all <text>   (append to the hidden notes for ALL ${WORDS}, shown to you at the top of every ${Cap(WORDS)} prompt: for general preferences ${WHO} states)\n@memo-all-clear\n`;
    const commonOpen = `${CHAT_FIRST}. ${runs("view")} Never delete anything.\n`;
    const common = commonOpen.trimEnd() + "]";
    const allNotes = [`Notes for all ${WORDS}`, viewNotes(ctx, ME)];
    if (!st.open) {
      await loadList();
      return `${notesBlock(WHO, [allNotes])}[Sent from the Sleipnyr ${Cap(WORDS)} modality: a list of ${WORDS} (overview boards with windows into threads, `
        + `projects, files and other views). On screen (id | title | windows):\n${st.list.filter(s => !s.data.hidden).map(s => `- ${s.id} | ${s.data.title} | ${summary(s)}`).join("\n") || "(none)"}\n`
        + `Archived: \n${st.list.filter(s => s.data.hidden).map(s => `- ${s.id} | ${s.data.title}`).join("\n") || "(none)"}\n`
        + `Actions, exactly:\n@open <${WORD} id>\n@new <title>   (makes and opens a ${WORD})\n@rename <${WORD} id> <title>\n@hide <${WORD} id>   (archive)\n@unhide <${WORD} id>\n` + memoAllLines
        + `This chat is the ${WORD} list's own conversation (each ${WORD} has its own). ` + common;
    }
    const v = viewOf(), r = board.getBoundingClientRect();
    const hl = sess().highlight?.id;
    const ws = wins().map(w => `- ${w.id} | ${w.kind}${w.ref ? " " + w.ref : ""} | ${winTitle(w)} | x ${w.x} y ${w.y} w ${w.w} h ${w.h}${w.collapsed ? " | folded" : ""}${w.id === hl ? " | highlighted" : ""}${w.fresh ? " | marked new" : ""}`
      + (w.kind === "note" ? `\n  text:\n${clip(w.text || "(empty)", 600).replace(/^/gm, "    ")}` : "")).join("\n");
    const notes = notesBlock(WHO, [allNotes, [`Notes for this ${WORD}`, sess().agentNotes],
      ...wins().map(w => [`Notes for window ${w.id}`, w.agentNotes])]);
    return `${notes}[Sent from the Sleipnyr ${Cap(WORDS)} modality: ${WORD} ${st.open.id} "${sess().title}", an infinite board ${WHO} pans and zooms (phone and desktop alike). `
      + `Actions, exactly:\n@add thread <thread id>\n@add threads   (the thread list)\n@add tinder\n@add projects [project id]\n@add file <file id> [| title]\n@add url <https address>\n`
      + `Placement: a new window never covers another. End @add or @note with " in <zone title>" (an existing zone) to put it in that zone's next free slot (the zone grows); without it, it lands in an "Unsorted" zone below all zones (when the ${WORD} has zones). A later @move still places it exactly.\n`
      + `@move <window id> <x> <y> [<w> <h>]   (snaps to a 24 px grid; onto another window it is nudged to the nearest free slot in the same zone)\n@arrange [zone title]   (tidy grid, no overlap; with zones each zone on its own, or just the named one)\n`
      + `@zone <title> <x> <y> <w> <h>   (a labelled frame behind windows; the same title moves/resizes it; a window belongs to the zone holding its centre)\n@unzone <title>   (remove the frame, windows stay)\n`
      + `@collapse <window id>   (also @fold)\n@expand <window id>   (also @unfold)\n@close <window id>\n@focus <window id>   (bring forward, pan to it)\n`
      + `@fit   (show all windows)\n@rename <${WORD} title>\n@back   (to the ${WORD} list)\n`
      + `@note <title>   (a new note window; its Markdown text follows on the next lines, then a line @end; keep it to one screen)\n`
      + `@edit <window id>   (replace a note's text: the new text on the next lines, then @end)\n`
      + `@title <window id> <name>   (rename a window)\n@highlight <window id> [why]   (pink "look here" frame, one at a time; a tap clears it)\n@unhighlight\n@new <window id> [why]   (green "new" frame, any number of windows; a tap/unfold clears it)\n@unnew <window id>\n`
      + `@memo <text>   (append to the hidden notes for this ${WORD}, shown to you at the top of every prompt: use for conventions ${WHO} agrees)\n@memo <window id> <text>   (append to that window's hidden notes)\n@memo-clear [window id]   (erase the ${WORD}'s notes, or that window's)\n` + memoAllLines
      + `In notes, link files as [name](/k/files/<file id>) and pages as [name](https://...).\n`
      + `This chat is this ${WORD}'s own conversation (other ${WORDS} have their own). ` + commonOpen
      + `Windows on it (id | kind ref | title | position and size in board px):\n${ws || "(none)"}\n`
      + `Zones (title | x y w h | windows | next free slot for a note):\n${zones().map(z => { const p = P.slotIn(z, wins(), KINDS.note, zones());
        return `- ${z.title} | ${z.x} ${z.y} ${z.w} ${z.h} | ${wins().filter(w => zoneOf(w) === z).map(w => w.id).join(" ") || "-"} | x ${p.x} y ${p.y}`; }).join("\n") || "(none)"}\n`
      + (zones().length ? `Windows outside any zone: ${wins().filter(w => !zoneOf(w)).map(w => w.id).join(" ") || "none"}\n` : "")
      + `Visible area now: x ${Math.round(-v.x / v.z)} to ${Math.round((r.width - v.x) / v.z)}, y ${Math.round(-v.y / v.z)} to ${Math.round((r.height - v.y) / v.z)} (zoom ${Math.round(v.z * 100)} %)`
      + `${st.narrow ? "; on a phone" : ""}.\nRecent threads (id | title):\n${threads || "(none)"}]`;
  };
  const run = async (name, args, text = "") => {
    const r = await run1(name, args, text);
    if (st.open && !(await save(true))) throw new Error(`not saved (${r})`);
    return r;
  };
  const run1 = async (name, args, text = "") => {
    const a = String(args || "").trim(), [first, ...rest] = a.split(/\s+/);
    if (name === "memo-all") return memoAll(a + (text ? "\n" + text : ""));
    if (name === "memo-all-clear") return memoAllClear();
    if (!st.open) {
      if (name === "open") { if (!st.list.some(s => s.id === first)) throw new Error(`no such ${WORD}`); ctx.levels.go(ME, first); return `open ${first}`; }
      if (name === "new") { const it = await newSession(a); return `new ${it?.id}`; }
      if (name === "rename") { await patchSession(first, { title: rest.join(" ").trim() || `Untitled ${WORD}` }); drawList(); return `rename ${first}`; }
      if (name === "hide" || name === "unhide") { await hide(first, name === "hide"); return `${name} ${first}`; }
      throw new Error("unknown command");
    }
    switch (name) {
      case "add": {
        const [more, zone] = splitZone(rest.join(" "));
        const [ref, title] = more.split("|").map(s => s.trim());
        const w = addWin(first, ref || "", title || (first === "thread" ? threadTitle(ref) || "" : ""), { agent: true, zone });
        return `add ${w.id} at x ${w.x} y ${w.y}${zoneOf(w) ? ` in ${zoneOf(w).title}` : ""}`;
      }
      case "move": return `move ${first}${moveWin(first, rest[0], rest[1], rest[2], rest[3])}`;
      case "collapse": case "fold": setCollapsed(first, true); return `collapse ${first}`;
      case "expand": case "unfold": setCollapsed(first, false); return `expand ${first}`;
      case "close": closeWin(first); return `close ${first}`;
      case "focus": focusWin(first); return `focus ${first}`;
      case "fit": fitAll(); return "fit";
      case "arrange": arrange(a); return a ? `arrange ${a}` : "arrange";
      case "zone": { const m = a.match(/^(.+?)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s*$/); if (!m) throw new Error("usage: @zone <title> <x> <y> <w> <h>");
        const z = setZone(m[1], m[2], m[3], m[4], m[5]); return `zone ${z.id}`; }
      case "unzone": { const z = dropZone(a); return `unzone ${z.id}`; }
      case "rename": await patchSession(st.open.id, { title: a || `Untitled ${WORD}` }); return "rename";
      case "back": ctx.levels.go(ME, ""); return "back";
      case "note": { const [t, zone] = splitZone(a); const w = addWin("note", text || "", t || "Note", { agent: true, zone });
        return `note ${w.id} at x ${w.x} y ${w.y}${zoneOf(w) ? ` in ${zoneOf(w).title}` : ""}`; }
      case "edit": setNote(first, text || rest.join(" ")); return `edit ${first}`;
      case "title": if (!rest.length) throw new Error("which name?"); setTitle(first, rest.join(" ")); return `title ${first}`;
      case "highlight": setHighlight(first, rest.join(" ")); return `highlight ${first}`;
      case "unhighlight": setHighlight(""); return "unhighlight";
      case "new": setFresh(first, true, rest.join(" ")); return `new ${first}`;
      case "unnew": setFresh(first, false); return `unnew ${first}`;
      case "memo": return memoAdd(a + (text ? "\n" + text : ""));
      case "memo-clear": return memoClear(first);
    }
    throw new Error("unknown command");
  };

  // ------------------------------------------------------------ level + live updates
  let chat = null;
  ctx.bar.offer({ id: WIN, label: () => winTitle(hereWin() || {}), shown: () => !!box.getClientRects().length && !!hereWin(),
    send: b => {
      const w = hereWin(), win = w && st.els.get(w.id)?.frame?.contentWindow;
      if (!win?.__kSend) throw new Error("that window is still loading");
      return win.__kSend(b);
    } });
  ctx.bar.offer({ id: ME, label: () => sess()?.title || Cap(WORDS), shown: () => !!box.getClientRects().length,
    placeholder: () => (st.open ? `Ask the ${WORD}: add, move or fold windows, write notes` : `Ask ${Cap(WORDS)}: open or start a ${WORD}`),
    send: b => { if (!chat) throw new Error("no conversation here"); return chat.send(b); } });

  // the embedded chat: this board's own conversation (or the list's)
  const embed = (view, title) => { chat = ctx.embed(view, box, { title, from: "blackboards", describe, run, scope: () => st.open?.id || "", ownThread: true }); };
  // never waits on the network before drawing what it can (a stalled phone
  // connection must not leave the old view up while the URL changed)
  let showing = 0;
  async function show(sub) {
    const mine = ++showing;
    pick.hidden = true; say("");
    if (!sub) {
      st.open = null; st.here = "";
      embed(LIST_VIEW, `${Cap(WORD)} list conversation`);
      if (!st.list.length) { await loadList(); if (mine !== showing) return; }
      drawList(); chat?.retry?.(); return;
    }
    if (!st.list.length) loadList().catch(() => {});
    let it = st.list.find(s => s.id === sub);
    if (!it) try { it = await ctx.api(`/k/items/${encodeURIComponent(sub)}`); } catch { it = null; }
    if (mine !== showing) return;
    if (!it || it.type !== "session") { say(`No such ${WORD}.`, true); ctx.levels.go(ME, ""); return; }
    if (st.open?.id !== it.id) { st.els.forEach(e => e.el.remove()); st.els.clear(); }
    st.open = { ...it, data: { windows: [], view: { x: 0, y: 0, z: 1 }, ...it.data } }; st.last = it.id; setBase(it);
    drawBoard(); firstView();
    embed(chatOf(it), `${it.data.title || Cap(WORD)} conversation`);
    // thread titles for thread windows arrive behind the drawn board
    loadThreads().then(() => { if (mine === showing && st.open?.id === it.id) drawBoard(); }).catch(() => {});
    chat?.retry?.(); // replies that arrived while this session was not on screen
  }
  // the kernel's generic view actions (kernel/web/actions.js): focus pans to
  // the window; order = the listed windows trade places in reading order
  ctx.actions?.view?.(ME, {
    scrollTo: id => { if (!find(id)) return false; focusWin(id); return true; },
    focus: id => { if (!find(id)) return false; focusWin(id); return true; },
    fold: (id, folded) => {
      const w = find(id); if (!w) return false;
      if (!!w.collapsed !== folded) setCollapsed(id, folded, true);
      return `${folded ? "folded" : "unfolded"} window ${id} "${winTitle(w)}"`;
    },
    order: ids => {
      const ws = ids.map(id => { const w = find(id); if (!w) throw new Error(`no window ${id}`); return w; });
      const from = new Map(ws.map(w => [w.id, geo(w)]));
      const spots = ws.map(w => ({ x: w.x, y: w.y })).sort((a, b) => a.y - b.y || a.x - b.x);
      ws.forEach((w, i) => { w.x = spots[i].x; w.y = spots[i].y; });
      ws.forEach(w => glideWin(w, from.get(w.id)));
      save();
      return `${ws.length} window(s) now read in the given order`;
    },
  });
  ctx.levels.onChange((level, sub) => {
    if (level !== ME) return;
    show(sub || "");
    ctx.bar.focus(hereWin() ? WIN : ME);
  });
  ctx.on("item", ({ item }) => {
    if (item?.type === "session") {
      const i = st.list.findIndex(s => s.id === item.id);
      if (i >= 0) st.list[i] = item; else st.list.unshift(item);
      if (ctx.levels.current() === ME && !st.open) drawList();
      // a newer copy (another page, the agent's lines run elsewhere): merged with our unsaved changes
      if (st.open?.id === item.id && item.updated > (st.baseAt || 0)) remote(item);
    }
    if (item?.type === "thread" && st.open && wins().some(w => w.kind === "thread" && w.ref === item.id)) {
      const i = st.threads.findIndex(t => t.id === item.id); if (i >= 0) st.threads[i] = item;
      for (const w of wins()) if (w.ref === item.id) drawWin(w);
    }
  });
  drawHead();
}
