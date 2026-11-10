// Columns: a composed modality. Named columns side by side, one per topic
// kept in mind; each column is a list of foldable panels (a note, or a window
// into another view: a thread, the thread list, Task Tinder, Projects, a
// file, a web page). A phone shows one column at a time: swipe sideways (or
// tap the arrows) to change column. A wide screen shows as many side by side
// as fit. The rows button in the header opens the column list: the board's
// columns as rows like the thread list (pink = the column on screen); a tap
// lands on that column, hold (or mouse-drag) a row to reorder the columns,
// back / Esc / browser back return to the board where it was. A tap on a panel's title bar folds or unfolds it; hold the title
// bar and drag to move the panel up or down its column.
// A window into a view is that view's own page in a frame (?frame=1, see
// shell.js); the shared bar talks to the focused one (the "→ target" label
// switches between it and the columns' conversation).
//
// Boards: the level opens on the list of boards (/m/columns, drawn by the
// kernel's itemList like the thread list: newest first, + = a new board);
// a tap opens one (/m/columns/<board id>), the back arrow returns to the list.
// Each board has its own conversation (view thread data.chatView; the first
// board keeps the old "columns" history) and its own agent notes, and the
// agent's @lines act on the board that asked.
//
// Saved item (kernel /k/items), one per board:
//   columns {title, chatView?, columns: [{id, title}], panels: [{id, col, order, kind, ref, title, named?,
//            text?, collapsed, fresh?}], highlight?: {id, reason}, agentNotes?}
//     columns  in screen order; col = the column id a panel sits in, order = its place there
//     kind     thread (ref = thread id) | threads | tinder | projects (ref = project id or "")
//              | file (ref = file id) | url (ref = http(s) URL) | note (text = Markdown)
//     highlight  the panel the agent points at ("look here"); a tap clears it
//     fresh    the agent marked the panel new (green frame); a tap or unfolding clears it
//     decide   {state: open|accepted|dismissed, board?, log: [{at, verdict, comment?, card?, error?}], card?}
//              a panel that takes decisions (e.g. a suggested task): Dismiss, Comment and Accept
//              sit at its foot; the server records them and hands accept/comment to the agent as an
//              unassigned Kanban card (POST /p/columns/<board>/decide). Dismissed panels are
//              archived, shown again from the column's foot, and can be reopened.
// Saves are conditional (x-if-updated) and replay our own changes onto a newer
// copy per column, per panel and per field, so two devices or the agent never
// overwrite each other. The column on screen is remembered per device.
import { render } from "/web/text.js";
import { itemList } from "/web/itemlist.js";
import { darkFrame } from "/web/frame.js";
import { ONE_SENTENCE, runs } from "/web/hcp.js";
import { backButton } from "/web/head.js";

const ME = "columns";
const WIN = "columns-window"; // the bar's second target: the focused panel
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const LEFT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
const RIGHT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const FULL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
// the same archive glyphs as Blackboards' hide/bring back, the bar's send arrow
const BOX = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>';
const UNBOX = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M12 18v-6M9.5 14.5L12 12l2.5 2.5"/></svg>';
const SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
// the column list: stacked rows (distinct from the threads menu's dotted list)
const ROWS = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="4" rx="1"/><rect x="4" y="10" width="16" height="4" rx="1"/><rect x="4" y="16" width="16" height="4" rx="1"/></svg>';
const SAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H10l-5 4v-4H4z"/></svg>';

const KINDS = {
  note: "Note", thread: "Thread", threads: "Thread list", tinder: "Task Tinder", projects: "Projects", file: "File", url: "Web page",
};
const HOLD = 350;  // ms a finger rests on a title bar before the panel lifts for reordering
const SLOP = 8;    // px of movement that turns a tap into a drag (or a scroll)
const GLIDE = 220; // ms, panels easing into their new places
const AT_KEY = "sleipnyr2.columns.at"; // the column this device shows first (+ "." + board id)

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
const safeUrl = u => { try { const x = new URL(u, location.origin); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };
const clone = o => JSON.parse(JSON.stringify(o ?? null));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nextId = (pre, list) => pre + (Math.max(0, ...list.map(x => Number(String(x.id).slice(pre.length)) || 0)) + 1);

/** The address a panel shows. */
export function srcOf(p) {
  const f = "frame=1";
  switch (p.kind) {
    case "thread": return `/i/${encodeURIComponent(p.ref)}?${f}`;
    case "threads": return `/?${f}`;
    case "tinder": return `/m/tinder?${f}`;
    case "projects": return `/m/projects${p.ref ? "/" + encodeURIComponent(p.ref) : ""}?${f}`;
    case "file": return `/k/files/${encodeURIComponent(p.ref)}`;
    case "url": return safeUrl(p.ref);
  }
  return "";
}
const fullOf = p => p.kind === "file" || p.kind === "url" ? srcOf(p) : srcOf(p).replace(/[?&]frame=1$/, "");

/** Our changes since base, replayed onto the server's newer list (by id, per field). */
export function mergeList(base, local, server) {
  const bmap = new Map((base || []).map(x => [x.id, x])), lids = new Set(local.map(x => x.id));
  const out = clone(server || []).filter(x => !(bmap.has(x.id) && !lids.has(x.id))); // removed here
  const omap = new Map(out.map(x => [x.id, x]));
  for (const l of local) {
    const b = bmap.get(l.id), o = omap.get(l.id);
    if (!b) { if (!o) { const c = clone(l); out.push(c); omap.set(c.id, c); } continue; } // added here
    if (!o) continue; // removed elsewhere
    for (const k of new Set([...Object.keys(l), ...Object.keys(b)]))
      if (!same(l[k], b[k])) { if (l[k] === undefined) delete o[k]; else o[k] = clone(l[k]); }
  }
  return out;
}

export function mount(box, ctx) {
  const WHO = ctx.user?.name || "the user", AG = ctx.app?.agentName || "the agent";
  const st = { item: null, list: [], last: "", base: null, baseAt: 0, saveTimer: 0, here: "", threads: [], els: new Map(), cels: new Map(), at: "", showDis: false, listOpen: false, noClick: 0 };
  box.classList.add("co-level");
  const back = backButton({ cls: "co-back", onclick: () => (st.listOpen ? closeList() : st.item ? ctx.levels.go(ME, "") : ctx.levels.up()) });
  const titleEl = h("b", { class: "co-title" }, "Columns");
  const pos = h("span", { class: "co-pos", "aria-live": "polite" });
  const addBtn = icon(PLUS, "Add a column or a panel", () => (st.item ? togglePick() : newBoard()), "co-add");
  const listBtn = icon(ROWS, "Column list: pick or reorder columns", () => openList(), "co-listb");
  const head = h("header", { class: "co-bar" }, back, titleEl, pos, listBtn, addBtn);
  const strip = h("div", { class: "co-cols", "aria-label": "Columns", hidden: true,
    "data-k-id": "mode", "data-k-kind": "mode", "data-k-label": "Board: the columns side by side (swipe sideways)" });
  // the column list (the rows button): one row per column, the thread list's look
  const clist = h("ul", { class: "k-items co-clist", role: "list", "aria-label": "Column list", hidden: true,
    "data-k-id": "mode", "data-k-kind": "mode", "data-k-label": "Column list: the columns as rows (a tap opens that column, hold and drag reorders)" });
  const boards = itemList({ word: "board", agent: AG, href: it => `/m/${ME}/${encodeURIComponent(it.id)}`, open: it => ctx.levels.go(ME, it.id),
    title: it => it.data.title || "Untitled board", summary: it => boardSummary(it) });
  const note = h("p", { class: "co-note", "aria-live": "polite", hidden: true });
  const pick = h("div", { class: "co-pick k-pop", hidden: true, role: "menu" });
  const fileIn = h("input", { type: "file", hidden: true, onchange: () => addFile() });
  box.append(head, boards.el, strip, clist, note, pick, fileIn);
  const say = (t, err = false) => { note.hidden = !t; note.textContent = t || ""; note.classList.toggle("err", err); };

  // ------------------------------------------------------------ data
  const data = () => st.item?.data;
  const cols = () => data()?.columns || [];
  const panels = () => data()?.panels || [];
  const findP = id => panels().find(p => p.id === id);
  const inCol = cid => panels().filter(p => p.col === cid).sort((a, b) => a.order - b.order);
  // feature panelDecisions (Settings > Features): unlike other switches it is OFF unless turned on
  const decOn = () => (ctx.settings?.().features?.panelDecisions ?? ctx.app?.features?.panelDecisions) === true;
  const dismissed = p => decOn() && p.decide?.state === "dismissed";
  const shownIn = cid => inCol(cid).filter(p => st.showDis || !dismissed(p)); // dismissed ones wait at the column's foot
  // a column by id, by exact or loose title, or by its number (1 = leftmost)
  function findC(ref) {
    const r = String(ref || "").trim().toLowerCase(); if (!r) return null;
    const cs = cols();
    return cs.find(c => c.id === r) || cs.find(c => c.title.toLowerCase() === r) || (/^\d+$/.test(r) ? cs[Number(r) - 1] : null)
      || cs.find(c => c.title.toLowerCase().startsWith(r)) || cs.find(c => c.title.toLowerCase().includes(r)) || null;
  }
  const needC = ref => { const c = findC(ref); if (!c) throw new Error(`no column ${ref}`); return c; };
  const needP = id => { const p = findP(id); if (!p) throw new Error(`no panel ${id}`); return p; };
  const pTitle = p => (p.kind === "thread" && !p.named ? st.threads.find(t => t.id === p.ref)?.data.title || p.title || "Thread" : p.title || KINDS[p.kind] || p.kind);
  async function loadThreads() { try { st.threads = await ctx.api("/p/chat/threads"); } catch { st.threads = []; } }

  function setBase(it) { st.base = clone({ columns: it.data.columns || [], panels: it.data.panels || [], highlight: it.data.highlight || null, agentNotes: it.data.agentNotes || "" }); st.baseAt = it.updated; }
  function rebase(it) {
    const b = st.base || { columns: [], panels: [], highlight: null, agentNotes: "" }, d = data();
    const pick1 = (k, def) => same(d[k] ?? def, b[k] ?? def) ? it.data[k] ?? def : d[k] ?? def;
    st.item = { ...it, data: { ...it.data, columns: mergeList(b.columns, cols(), it.data.columns), panels: mergeList(b.panels, panels(), it.data.panels),
      highlight: pick1("highlight", null), agentNotes: pick1("agentNotes", "") } };
    setBase(it);
  }
  async function saveOnce() {
    const it = st.item, d = it.data;
    const body = { columns: d.columns, panels: d.panels, highlight: d.highlight || null, agentNotes: d.agentNotes || "" };
    const r = await fetch(`/k/items/${encodeURIComponent(it.id)}`, { method: "PATCH", body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...(st.baseAt ? { "x-if-updated": String(st.baseAt) } : {}) } });
    const out = await r.json().catch(() => ({}));
    if (st.item !== it) return null; // left this board meanwhile: its answer must not touch the next one
    if (r.status === 409 && out.item) return out.item;
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    if (!st.baseAt || out.updated > st.baseAt) setBase(out);
    return null;
  }
  let saving = null;
  function save(now = false) {
    clearTimeout(st.saveTimer);
    if (!st.item) return Promise.resolve(true);
    // resolves true once saved, false when it failed (shown here; an agent run reports it too)
    const go = () => { st.saveTimer = 0; return (saving = (async () => {
      await saving?.catch(() => {});
      for (let i = 0; i < 5 && st.item; i++) {
        try { const newer = await saveOnce(); if (!newer) return true; takeRemote(newer); }
        catch (e) { say(`Not saved: ${e.message}`, true); return false; }
      }
      if (st.item) say("Not saved: the board kept changing elsewhere", true);
      return false;
    })()); };
    if (now) return go();
    st.saveTimer = setTimeout(go, 400);
    return Promise.resolve();
  }
  // leaving a board: only a change still waiting is saved (a visit alone keeps its place in the list)
  const flush = () => (st.saveTimer ? save(true) : saving || Promise.resolve());
  // leaving never waits on the network: a stalled save gets a moment, then goes on alone
  const settle = (pr, ms = 800) => Promise.race([pr.catch(() => {}), new Promise(ok => setTimeout(ok, ms))]);
  function takeRemote(it) { const was = rects(); rebase(it); draw(); glideFrom(was); }
  // never redraw under a finger: a copy arriving mid-drag waits until it ends
  function remote(it) {
    if (!drag && !rowDrag) return takeRemote(it);
    if (!st.later || it.updated > st.later.updated) st.later = it;
  }
  // ------------------------------------------------------------ the boards
  // each board has its own conversation; the first board keeps the old one
  const viewOf = it => it.data.chatView || `${ME}-${String(it.id).replace(/[^a-z0-9]/g, "").slice(-20)}`;
  const boardSummary = it => {
    const n = (it.data.columns || []).length, m = (it.data.panels || []).length;
    return `${n} column${n === 1 ? "" : "s"}, ${m} panel${m === 1 ? "" : "s"}`;
  };
  async function loadList() {
    try { st.list = await ctx.api(`/k/items?type=${ME}&order=-updated&limit=500`); return true; } catch (e) { say(`Could not load the boards: ${e.message}`, true); return false; }
  }
  const today = () => new Date().toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  // one tap: a new board named after today, opened at once; tap its title to rename
  async function newBoard(title = "") {
    try {
      const it = await ctx.api("/k/items", { json: { type: ME, data: { title: String(title).trim().slice(0, 80) || today(), columns: [{ id: "c1", title: "First topic" }], panels: [] } } });
      st.list = [it, ...st.list.filter(x => x.id !== it.id)];
      ctx.levels.go(ME, it.id);
      return it;
    } catch (e) { say(`Could not make a board: ${e.message}`, true); return null; }
  }
  async function patchBoard(id, patch) {
    const it = await ctx.api(`/k/items/${encodeURIComponent(id)}`, { method: "PATCH", json: patch });
    const i = st.list.findIndex(x => x.id === id); if (i >= 0) st.list[i] = it;
    return it;
  }
  async function renameBoard() {
    if (!st.item) return;
    const t = prompt("Board name", st.item.data.title || "");
    if (t === null || !t.trim()) return;
    st.item.data.title = t.trim().slice(0, 80); drawHead();
    try { await patchBoard(st.item.id, { title: st.item.data.title }); } catch (e) { say(`Could not rename: ${e.message}`, true); }
  }
  function drawHead() {
    const it = st.item;
    titleEl.textContent = it ? it.data.title || "Untitled board" : "Columns";
    titleEl.classList.toggle("co-ren", !!it);
    if (it) titleEl.dataset.tip = "Tap to rename"; else delete titleEl.dataset.tip;
    titleEl.onclick = it ? () => renameBoard() : null;
    const bt = st.listOpen ? "Back to the board" : it ? "All boards" : "All modalities", at = it ? "Add a column or a panel" : "New board";
    back.dataset.tip = bt; back.setAttribute("aria-label", bt);
    addBtn.dataset.tip = at; addBtn.setAttribute("aria-label", at);
    pos.hidden = !it || st.listOpen; listBtn.hidden = !it || st.listOpen; addBtn.hidden = st.listOpen;
  }
  function drawList() { drawHead(); strip.hidden = true; clist.hidden = true; boards.el.hidden = false; boards.draw(st.list, st.last); }

  // ------------------------------------------------------------ drawing
  function draw() {
    if (!st.item) return;
    const ids = new Set(cols().map(c => c.id));
    for (const [id, c] of st.cels) if (!ids.has(id)) { c.el.remove(); st.cels.delete(id); }
    const pids = new Set(panels().map(p => p.id));
    for (const [id, e] of st.els) if (!pids.has(id)) { e.el.remove(); st.els.delete(id); }
    cols().forEach((c, i) => {
      const ce = drawCol(c, i);
      if (strip.children[i] !== ce.el) strip.insertBefore(ce.el, strip.children[i] || null);
      const list = shownIn(c.id), gone = inCol(c.id).filter(p => !list.includes(p));
      for (const p of gone) st.els.get(p.id)?.el.remove();
      list.forEach((p, j) => { const e = drawPanel(p); if (ce.list.children[j] !== e.el) ce.list.insertBefore(e.el, ce.list.children[j] || null); });
      if (!list.length) ce.list.insertBefore(ce.empty, ce.list.children[0] || null); else ce.empty.remove();
      const nd = inCol(c.id).filter(dismissed).length;
      ce.dis.hidden = !nd;
      ce.dis.textContent = st.showDis ? "Hide dismissed" : `Show ${nd} dismissed`;
      ce.dis.dataset.tip = st.showDis ? "Put the dismissed suggestions away again" : "Dismissed suggestions are kept: show them to reopen one";
      ce.list.append(ce.dis);
    });
    if (!cols().length) strip.replaceChildren(h("p", { class: "co-empty" }, "No columns yet. Tap + (top right) for a new one."));
    else strip.querySelector(":scope > .co-empty")?.remove();
    drawPos();
    if (st.listOpen) drawColList();
  }
  function drawCol(c, i) {
    let ce = st.cels.get(c.id);
    if (!ce) {
      const name = h("button", { class: "co-cname", type: "button", "data-tip": "Rename this column", onclick: () => renameCol(c.id) });
      const prev = icon(LEFT, "Previous column", () => go(-1), "co-prev");
      const next = icon(RIGHT, "Next column", () => go(1), "co-next");
      const list = h("div", { class: "co-list" });
      const empty = h("p", { class: "co-empty" }, "Nothing here yet.");
      const dis = h("button", { class: "c-btn co-disb", type: "button", hidden: true, onclick: () => { st.showDis = !st.showDis; const was = rects(); draw(); glideFrom(was); } });
      const el = h("section", { class: "co-col", "data-id": c.id, "data-k-id": c.id, "data-k-kind": "column" }, h("header", { class: "co-chead" }, prev, name, next), list);
      ce = { el, name, prev, next, list, empty, dis }; st.cels.set(c.id, ce);
    }
    ce.name.textContent = c.title || "Untitled"; ce.el.dataset.kLabel = ce.name.textContent;
    ce.el.classList.toggle("hl", data().highlight?.id === c.id);
    ce.prev.disabled = i === 0; ce.next.disabled = i === cols().length - 1;
    return ce;
  }
  function drawPanel(p) {
    let e = st.els.get(p.id);
    if (!e) {
      const name = h("span", { class: "co-pname" });
      const fold = icon(UP, "Fold", () => setCollapsed(p.id, !findP(p.id)?.collapsed, true), "co-fold");
      const edit = p.kind === "note" ? icon(PEN, "Edit the note", () => toggleEdit(p.id), "co-edit") : null;
      const close = icon(CLOSE, "Remove panel", () => closeP(p.id), "co-close");
      const state = h("span", { class: "co-pstate" });
      const bar = h("div", { class: "co-pbar" }, name, state, edit, p.kind === "note" ? null : icon(FULL, "Open in full", () => openFull(p.id)), fold, close);
      const content = h("div", { class: "co-pbody" });
      const foot = h("div", { class: "co-dec", hidden: true });
      const el = h("article", { class: "co-panel", "data-id": p.id, "data-k-id": p.id, "data-k-kind": `${p.kind} panel`, "data-k-order": "" }, bar, content, foot);
      e = { el, bar, name, state, fold, edit, close, content, foot, frame: null, src: "", md: null, text: null, editing: false, dec: "" };
      st.els.set(p.id, e);
      el.addEventListener("pointerdown", () => tapP(p.id), true);
      holdDrag(bar, p.id);
    }
    const cur = findP(p.id) || p;
    e.name.textContent = pTitle(cur); e.el.dataset.kLabel = e.name.textContent;
    const hl = data().highlight;
    e.el.classList.toggle("hl", hl?.id === cur.id);
    e.el.classList.toggle("fresh", !!cur.fresh && hl?.id !== cur.id);
    if (hl?.id === cur.id) e.el.dataset.tip = hl.reason ? `Look here: ${hl.reason}` : "Look here";
    else if (cur.fresh) e.el.dataset.tip = typeof cur.fresh === "string" ? `New: ${cur.fresh}` : "New";
    else delete e.el.dataset.tip;
    e.el.classList.toggle("collapsed", !!cur.collapsed);
    e.el.classList.toggle("here", cur.id === st.here);
    e.el.classList.toggle("view", cur.kind !== "note");
    const ft = cur.collapsed ? "Unfold" : "Fold";
    e.fold.dataset.tip = ft; e.fold.setAttribute("aria-label", ft); e.fold.replaceChildren(svg(cur.collapsed ? DOWN : UP));
    drawDecide(cur, e);
    if (cur.kind === "note") { drawNote(cur, e); return e; }
    // a folded panel drops its frame (no page running behind a title bar)
    const src = srcOf(cur);
    if (cur.collapsed || !src) { if (e.frame) { e.frame.remove(); e.frame = null; e.src = ""; } if (!src) e.content.replaceChildren(h("p", { class: "co-empty" }, "Nothing to show here.")); }
    else if (!e.frame || e.src !== src) {
      e.frame = h("iframe", { class: "co-frame", src, title: pTitle(cur), allow: "microphone; autoplay; clipboard-read; clipboard-write; fullscreen" });
      e.frame.addEventListener("load", () => { darkFrame(e.frame); ctx.bar.refresh(); });
      e.src = src; e.content.replaceChildren(e.frame);
    }
    return e;
  }
  // ------------------------------------------------------------ decisions (accept / comment / dismiss)
  const hm = t => new Date(Number(t)).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const VERB = { accept: "Accepted", dismiss: "Dismissed", comment: "Commented", reopen: "Reopened" };
  function decideLine(d) {
    const last = (d.log || []).at(-1);
    if (!last) return "";
    const card = last.card ? `, handed to ${AG} as card ${last.card}` : last.verdict === "accept" && d.card ? `, card ${d.card.id}` : "";
    return `${VERB[last.verdict] || last.verdict} ${hm(last.at)}${card}${last.error ? ` (recorded; the card failed: ${last.error})` : ""}`
      + (last.comment ? `: “${last.comment.length > 140 ? last.comment.slice(0, 140) + "…" : last.comment}”` : "");
  }
  function drawDecide(p, e) {
    const d = decOn() ? p.decide : null;
    e.foot.hidden = !d; e.close.hidden = !!d; // a decided-on panel is never removed: dismiss archives it
    e.el.classList.toggle("decided", !!d && d.state !== "open");
    e.el.classList.toggle("dismissed", !!d && d.state === "dismissed");
    e.el.dataset.kState = d ? d.state : "";
    e.state.textContent = d && d.state !== "open" ? (d.state === "accepted" ? "accepted" : "dismissed") : "";
    if (!d) return;
    const key = JSON.stringify([d.state, (d.log || []).length, e.busy || ""]);
    if (e.dec === key && e.foot.childElementCount) return;
    e.dec = key;
    const ta = e.say?.querySelector("textarea"), keep = ta ? ta.value : "", open = !!e.say && !e.say.hidden;
    const line = h("p", { class: "co-dline", "aria-live": "polite" }, e.busy || decideLine(d) || "Open: your call");
    const btns = d.state === "dismissed"
      ? [icon(UNBOX, "Reopen: back among the open suggestions", () => decide(p.id, "reopen"), "co-reopen")]
      : [icon(BOX, "Dismiss (archived, can be reopened)", () => decide(p.id, "dismiss"), "co-dismiss"),
        icon(SAY, `Comment: ask ${AG} to change it (not an accept)`, () => toggleSay(p.id), "co-say"),
        d.state === "accepted" ? null : icon(CHECK, `Accept: hand it to ${AG} (nothing runs by itself)`, () => decide(p.id, "accept"), "co-accept")];
    const field = h("textarea", { class: "co-sayt", rows: 2, "aria-label": "Comment", placeholder: "Comment" });
    field.value = keep;
    field.addEventListener("keydown", ev => {
      if (ev.key === "Escape") { ev.stopPropagation(); toggleSay(p.id, false); }
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); sendSay(p.id); }
    });
    e.say = h("div", { class: "co-sayrow", hidden: !open }, field, icon(SEND, "Send the comment", () => sendSay(p.id), "co-saysend"));
    e.foot.replaceChildren(h("div", { class: "co-drow" }, line, h("span", { class: "co-dbtns" }, btns)), e.say);
    if (e.busy) e.foot.querySelectorAll("button").forEach(b => { b.disabled = true; });
  }
  function toggleSay(id, on) {
    const e = st.els.get(id); if (!e?.say) return;
    const show = on ?? e.say.hidden;
    e.say.hidden = !show;
    if (show) e.say.querySelector("textarea").focus();
  }
  function sendSay(id) {
    const e = st.els.get(id), t = e?.say?.querySelector("textarea")?.value.trim();
    if (!t) { e?.say?.querySelector("textarea")?.focus(); return; }
    decide(id, "comment", t);
  }
  // the server records it on the panel (and makes the card); the board then takes its copy
  async function decide(id, verdict, comment) {
    const e = st.els.get(id), p = findP(id); if (!decOn() || !e || !p?.decide || e.busy) return;
    const open = e.say && !e.say.hidden ? e.say.querySelector("textarea").value.trim() : "";
    comment = comment ?? (verdict === "accept" ? open : "");
    e.busy = { accept: "Accepting…", dismiss: "Dismissing…", comment: "Sending…", reopen: "Reopening…" }[verdict];
    drawDecide(p, e);
    try {
      await flush().catch(() => {});
      const out = await ctx.api(`/p/${ME}/${encodeURIComponent(st.item.id)}/decide`, { json: { panel: id, verdict, ...(comment ? { comment } : {}) } });
      e.busy = "";
      if (comment && e.say) { e.say.querySelector("textarea").value = ""; e.say.hidden = true; }
      if (out.item && out.item.updated > (st.baseAt || 0)) takeRemote(out.item); else drawDecide(findP(id) || p, e);
      if (out.error) say(`Recorded, but the Kanban card failed: ${out.error}`, true);
    } catch (err) {
      e.busy = ""; drawDecide(findP(id) || p, e);
      say(`Not recorded: ${err.message}`, true);
    }
  }

  function drawNote(p, e) {
    if (e.editing) return;
    const text = p.text || "";
    if (e.md && e.text === text) return;
    e.text = text;
    e.md = h("div", { class: "co-md c-text" }, text.trim() ? render(text) : h("p", { class: "co-empty" }, "An empty note. Tap the pen to write."));
    e.content.replaceChildren(e.md);
  }
  function toggleEdit(id) {
    const p = findP(id), e = st.els.get(id); if (!p || !e) return;
    if (!e.editing) {
      seen(id); if (p.collapsed) setCollapsed(id, false);
      e.editing = true;
      const ta = h("textarea", { class: "co-mdedit", "aria-label": "Note text (Markdown)", spellcheck: "true", rows: 8 });
      ta.value = p.text || "";
      ta.addEventListener("input", () => { p.text = ta.value; save(); });
      e.content.replaceChildren(ta); ta.focus();
    } else {
      const ta = e.content.querySelector("textarea"); if (ta) p.text = ta.value;
      e.editing = false; e.md = null; drawNote(p, e); save();
    }
    const t = e.editing ? "Done editing" : "Edit the note";
    e.edit.dataset.tip = t; e.edit.setAttribute("aria-label", t); e.edit.replaceChildren(svg(e.editing ? CHECK : PEN));
    e.el.classList.toggle("editing", e.editing);
  }

  // ------------------------------------------------------------ moving between columns
  // native sideways scrolling with snap points does the swipe; the arrows and
  // @show glide to a column; the column in view is remembered on this device
  const colW = () => strip.querySelector(".co-col")?.getBoundingClientRect().width || strip.clientWidth || 1;
  const atIdx = () => Math.max(0, Math.min(cols().length - 1, Math.round(strip.scrollLeft / colW())));
  function drawPos() {
    const n = cols().length, per = Math.max(1, Math.floor((strip.clientWidth + 2) / colW()));
    const i = atIdx();
    pos.textContent = n > per ? (per === 1 ? `${i + 1} / ${n}` : `${i + 1}–${Math.min(n, i + per)} / ${n}`) : "";
  }
  function showCol(ref, smooth = true) {
    const i = cols().findIndex(c => c.id === (findC(ref)?.id || ref)); if (i < 0) return;
    st.at = cols()[i].id; localStorage.setItem(atKey(), st.at); // a later restore lands here too
    strip.scrollTo({ left: i * colW(), behavior: smooth ? "smooth" : "auto" });
  }
  function go(d) { const i = atIdx() + d; if (i >= 0 && i < cols().length) showCol(cols()[i].id); }
  let scrollT = 0;
  strip.addEventListener("scroll", () => {
    clearTimeout(scrollT);
    scrollT = setTimeout(() => { if (strip.hidden) return; const c = cols()[atIdx()]; if (c && st.item) { st.at = c.id; localStorage.setItem(atKey(), c.id); } drawPos(); }, 120);
  }, { passive: true });
  const atKey = () => `${AT_KEY}.${st.item?.id || ""}`;
  addEventListener("resize", () => { if (st.item && st.at) showCol(st.at, false); drawPos(); });
  addEventListener("keydown", e => {
    if (!box.getClientRects().length || !st.item || e.target.closest?.("input, textarea, [contenteditable]")) return;
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); go(1); }
  });

  // ------------------------------------------------------------ the column list
  // A second way in (the rows button): the columns top to bottom like the
  // thread list. Open = one history step, so browser back, the back arrow and
  // Esc all return to the board at the column it showed. A tap on a row lands
  // on that column; hold a row (touch) or drag it (mouse) to reorder: the
  // others slide aside, it glides into place, saved like @move-column.
  function openList() {
    if (!st.item || st.listOpen) return;
    const c = cols()[atIdx()]; if (c) { st.at = c.id; localStorage.setItem(atKey(), c.id); }
    pick.hidden = true;
    history.pushState({ ...(history.state || {}), coList: st.item.id }, "", location.pathname);
    setListShown(true);
  }
  function setListShown(on) {
    st.listOpen = on; clist.hidden = !on; strip.hidden = on || !st.item;
    drawHead();
    if (on) {
      drawColList(); clist.scrollTop = 0;
      const a = clist.querySelector("a.here");
      if (a && a.getBoundingClientRect().bottom > clist.getBoundingClientRect().bottom) clist.scrollTop = a.offsetTop - clist.clientHeight / 2;
    }
    ctx.bar.refresh();
  }
  // to = the column to land on (default: where it was)
  function closeList(to) {
    if (!st.listOpen) return;
    if (to) { st.at = to; localStorage.setItem(atKey(), to); }
    if (history.state?.coList) history.back(); else landBoard();
  }
  function landBoard() {
    if (!st.listOpen) return;
    setListShown(false);
    if (st.at && findC(st.at)) showCol(st.at, false);
    drawPos();
  }
  addEventListener("popstate", () => { if (st.listOpen && !history.state?.coList) landBoard(); });
  // a reload starts on the board, never on the list
  if (history.state?.coList) { const { coList, ...rest } = history.state; history.replaceState(rest, "", location.pathname); }
  function drawColList() {
    if (rowDrag) return;
    const cs = cols();
    clist.replaceChildren(...cs.map(c => {
      const n = inCol(c.id).filter(p => !dismissed(p)).length, t = c.title || "Untitled";
      const a = h("a", { href: location.pathname, class: c.id === st.at ? "here" : null, draggable: "false",
        "data-id": c.id, "data-k-id": c.id, "data-k-kind": "column", "data-k-label": t, "data-k-order": "",
        "data-tip": `Open “${t}”; hold and drag to move it`,
        onclick: ev => { ev.preventDefault(); if (Date.now() - st.noClick > 400) closeList(c.id); } },
        h("span", { class: "k-it-t" }, t),
        h("span", { class: "co-cn" }, `${n} panel${n === 1 ? "" : "s"}`));
      rowHold(a, c.id);
      return h("li", {}, a);
    }), ...(cs.length ? [] : [h("li", { class: "k-it-empty" }, "No columns yet. Go back and tap + for a new one.")]));
  }
  let rowDrag = null;
  function rowHold(a, id) {
    a.addEventListener("dragstart", e => e.preventDefault());
    a.addEventListener("contextmenu", e => e.preventDefault());
    a.addEventListener("pointerdown", e => {
      if (e.button > 0 || rowDrag) return;
      const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId, mouse = e.pointerType === "mouse";
      let lifted = false, timer = 0;
      const lift = () => { lifted = true; startRow(id, y0); try { a.setPointerCapture(pid); } catch { /* synthetic */ } };
      if (!mouse) timer = setTimeout(lift, HOLD);
      const move = ev => {
        if (ev.pointerId !== pid) return;
        const dist = Math.hypot(ev.clientX - x0, ev.clientY - y0);
        if (!lifted && dist > SLOP) { if (mouse) lift(); else clearTimeout(timer); } // a finger moving first = a scroll
        if (lifted) moveRow(ev.clientY);
      };
      const end = ev => {
        if (ev.pointerId !== pid) return;
        clearTimeout(timer);
        removeEventListener("pointermove", move, true); removeEventListener("pointerup", end, true); removeEventListener("pointercancel", end, true);
        if (lifted) { st.noClick = Date.now(); endRow(ev.type === "pointercancel"); }
      };
      addEventListener("pointermove", move, true); addEventListener("pointerup", end, true); addEventListener("pointercancel", end, true);
    });
    // once lifted, the list must not scroll under the finger
    a.addEventListener("touchmove", e => { if (rowDrag?.id === id && e.cancelable) e.preventDefault(); }, { passive: false });
  }
  const rowEls = () => [...clist.querySelectorAll(":scope > li > a")];
  function startRow(id, y) {
    const rows = rowEls(), el = rows.find(r => r.dataset.id === id); if (!el) return;
    const r = el.getBoundingClientRect();
    rowDrag = { id, el, y0: y, r, from: rows.indexOf(el), to: rows.indexOf(el), scroll0: clist.scrollTop,
      others: rows.filter(x => x !== el).map(x => ({ el: x, r: x.getBoundingClientRect() })) };
    el.classList.add("drag"); box.classList.add("co-busy");
    navigator.vibrate?.(15);
  }
  function moveRow(y) {
    const d = rowDrag; if (!d) return;
    const lr = clist.getBoundingClientRect();
    if (y < lr.top + 40) clist.scrollTop -= 10; else if (y > lr.bottom - 40) clist.scrollTop += 10;
    const ds = clist.scrollTop - d.scroll0, dy = y - d.y0 + ds;
    d.el.style.transform = `translateY(${dy}px)`;
    const mid = d.r.top + d.r.height / 2 + dy - ds;
    let to = 0;
    for (const o of d.others) if (mid > o.r.top - ds + o.r.height / 2) to++;
    d.to = to;
    d.others.forEach((o, i) => {
      const was = i >= d.from ? i + 1 : i, now = i >= to ? i + 1 : i;
      o.el.style.transform = now === was ? "" : `translateY(${(now - was) * d.r.height}px)`;
      o.el.classList.add("glide");
    });
  }
  function endRow(cancelled) {
    const d = rowDrag; if (!d) return;
    const was = new Map(rowEls().map(x => [x.dataset.id, x.getBoundingClientRect()])); // where they are seen now
    rowDrag = null; box.classList.remove("co-busy");
    for (const o of d.others) { o.el.style.transform = ""; o.el.classList.remove("glide"); }
    d.el.classList.remove("drag"); d.el.style.transform = "";
    if (!cancelled && d.to !== d.from) moveCol(d.id, d.to + 1); else drawColList();
    // FLIP: rows drawn where they were seen, then eased into their places
    for (const x of rowEls()) {
      const a = was.get(x.dataset.id); if (!a) continue;
      const dy = a.top - x.getBoundingClientRect().top; if (Math.abs(dy) < 1) continue;
      x.style.transform = `translateY(${dy}px)`; void x.offsetWidth;
      x.classList.add("glide"); x.style.transform = "";
      setTimeout(() => x.classList.remove("glide"), GLIDE + 60);
    }
    if (st.later) { const it = st.later; st.later = null; if (it.updated > st.baseAt) takeRemote(it); }
  }

  // ------------------------------------------------------------ reordering: hold, then drag
  // A finger (or the mouse) on a title bar: moving under SLOP and lifting =
  // a tap (fold/unfold). Holding still for HOLD ms lifts the panel: it follows
  // the finger, the others slide aside to show where it lands, and on release
  // it glides into its place. Moving before HOLD is a normal scroll or swipe.
  let drag = null;
  function holdDrag(bar, id) {
    bar.addEventListener("contextmenu", e => e.preventDefault());
    bar.addEventListener("pointerdown", e => {
      if (e.button > 0 || e.target.closest("button") || drag) return;
      const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId, mouse = e.pointerType === "mouse";
      let moved = false, lifted = false, timer = 0;
      const lift = () => { lifted = true; startDrag(id, y0); try { bar.setPointerCapture(pid); } catch { /* synthetic */ } };
      if (!mouse) timer = setTimeout(lift, HOLD);
      const move = ev => {
        if (ev.pointerId !== pid) return;
        const dist = Math.hypot(ev.clientX - x0, ev.clientY - y0);
        if (!lifted && mouse && dist > SLOP) { moved = true; lift(); }
        else if (!lifted && dist > SLOP) { moved = true; clearTimeout(timer); }
        if (lifted) { moved = moved || dist > SLOP; moveDrag(ev.clientY); }
      };
      const end = ev => {
        if (ev.pointerId !== pid) return;
        clearTimeout(timer);
        removeEventListener("pointermove", move, true); removeEventListener("pointerup", end, true); removeEventListener("pointercancel", end, true);
        if (lifted) { endDrag(ev.type === "pointercancel"); if (!moved && ev.type === "pointerup") setCollapsed(id, !findP(id)?.collapsed, true); }
        else if (!moved && ev.type === "pointerup") setCollapsed(id, !findP(id)?.collapsed, true);
      };
      addEventListener("pointermove", move, true); addEventListener("pointerup", end, true); addEventListener("pointercancel", end, true);
    });
    // once lifted, the page must not scroll under the finger
    bar.addEventListener("touchmove", e => { if (drag?.id === id && e.cancelable) e.preventDefault(); }, { passive: false });
  }
  function startDrag(id, y) {
    const p = findP(id), e = st.els.get(id); if (!p || !e) return;
    const list = shownIn(p.col), ce = st.cels.get(p.col);
    const others = list.filter(q => q.id !== id).map(q => ({ id: q.id, el: st.els.get(q.id).el, r: st.els.get(q.id).el.getBoundingClientRect() }));
    const r = e.el.getBoundingClientRect(), gap = parseFloat(getComputedStyle(ce.list).rowGap) || 12;
    drag = { id, y0: y, r, gap, others, from: list.findIndex(q => q.id === id), to: list.findIndex(q => q.id === id), ce, scroll0: ce.list.scrollTop, lastY: y };
    e.el.classList.add("drag"); box.classList.add("co-busy");
    navigator.vibrate?.(15);
  }
  function moveDrag(y) {
    if (!drag) return;
    drag.lastY = y;
    const { ce, r, gap, others } = drag, e = st.els.get(drag.id);
    // near the column's top or bottom edge the column scrolls along
    const lr = ce.list.getBoundingClientRect();
    if (y < lr.top + 40) ce.list.scrollTop -= 10; else if (y > lr.bottom - 40) ce.list.scrollTop += 10;
    const ds = ce.list.scrollTop - drag.scroll0;
    const dy = y - drag.y0 + ds;
    e.el.style.transform = `translateY(${dy}px)`;
    const mid = r.top + r.height / 2 + dy - ds; // its centre on screen now
    let to = 0;
    for (const o of others) if (mid > o.r.top - ds + o.r.height / 2) to++;
    drag.to = to;
    const shift = r.height + gap;
    others.forEach((o, i) => {
      const was = i >= drag.from ? i + 1 : i; // its index with the dragged panel in the list
      const now = i >= to ? i + 1 : i;
      o.el.style.transform = now === was ? "" : `translateY(${(now - was) * shift}px)`;
      o.el.classList.add("glide");
    });
  }
  function endDrag(cancelled) {
    if (!drag) return;
    const d = drag; drag = null;
    box.classList.remove("co-busy");
    const e = st.els.get(d.id);
    const was = rects();
    for (const o of d.others) { o.el.style.transform = ""; o.el.classList.remove("glide"); }
    if (e) { e.el.classList.remove("drag"); e.el.style.transform = ""; }
    if (!cancelled && d.to !== d.from) {
      const p = findP(d.id), list = shownIn(p.col).filter(q => q.id !== d.id);
      list.splice(d.to, 0, p);
      [...list, ...inCol(p.col).filter(q => !list.includes(q))].forEach((q, i) => { q.order = i; }); // put-away ones keep their turn after
      draw(); save();
    }
    glideFrom(was);
    if (st.later) { const it = st.later; st.later = null; if (it.updated > st.baseAt) takeRemote(it); }
  }
  // FLIP: panels drawn where they were, then eased to where they are now
  function rects() { return new Map([...st.els].map(([id, e]) => [id, e.el.getBoundingClientRect()])); }
  function glideFrom(was) {
    for (const [id, e] of st.els) {
      const a = was.get(id); if (!a || !e.el.isConnected) continue;
      const b = e.el.getBoundingClientRect(), dy = a.top - b.top, dx = a.left - b.left;
      if (Math.abs(dy) < 1 && Math.abs(dx) < 1) continue;
      e.el.classList.remove("glide"); e.el.style.transform = `translate(${dx}px, ${dy}px)`;
      void e.el.offsetWidth;
      e.el.classList.add("glide"); e.el.style.transform = "";
      clearTimeout(e.gt); e.gt = setTimeout(() => e.el.classList.remove("glide"), GLIDE + 60);
    }
  }

  // ------------------------------------------------------------ changes
  function addCol(title) {
    const t = String(title || "").trim() || "New topic";
    const c = { id: nextId("c", cols()), title: t.slice(0, 80) };
    data().columns = [...cols(), c]; draw(); save();
    requestAnimationFrame(() => showCol(c.id));
    return c;
  }
  function renameCol(id) {
    const c = cols().find(x => x.id === id); if (!c) return;
    const t = prompt("Column name", c.title); if (t?.trim()) { c.title = t.trim().slice(0, 80); draw(); save(); }
  }
  function moveCol(ref, to) {
    const c = needC(ref), cs = cols().filter(x => x !== c);
    cs.splice(Math.max(0, Math.min(cs.length, Number(to) - 1 || 0)), 0, c);
    const was = rects(); data().columns = cs; draw(); glideFrom(was); save();
  }
  // only an empty column can go: panels are never dropped along with it
  function dropCol(ref) {
    const c = needC(ref);
    if (inCol(c.id).length) throw new Error(`column ${c.title} still has panels: move them first`);
    data().columns = cols().filter(x => x !== c); draw(); save(); return c;
  }
  function addP(colRef, kind, ref = "", title = "") {
    if (!st.item) throw new Error("not loaded yet");
    if (!KINDS[kind]) throw new Error(`unknown panel kind ${kind}`);
    if (kind === "thread" && !ref) throw new Error("which thread?");
    if (kind === "file" && !ref) throw new Error("which file?");
    if (kind === "url" && !safeUrl(ref)) throw new Error("not an http(s) address");
    const c = colRef ? needC(colRef) : cols()[atIdx()] || addCol("First topic");
    const list = inCol(c.id);
    const p = { id: nextId("p", panels()), col: c.id, order: list.length ? list[list.length - 1].order + 1 : 0, kind,
      ref: kind === "url" ? safeUrl(ref) : kind === "note" ? "" : String(ref), title: title || (kind === "url" ? new URL(safeUrl(ref)).host : ""),
      ...(kind === "note" ? { text: String(ref || "") } : {}), collapsed: false };
    data().panels = [...panels(), p];
    draw(); save(); showCol(c.id);
    requestAnimationFrame(() => intoView(p.id));
    return p;
  }
  // @move <panel> <column> [position]: position 1 = top; without it, the bottom
  function moveP(id, colRef, at) {
    const p = needP(id), c = colRef ? needC(colRef) : cols().find(x => x.id === p.col);
    const list = inCol(c.id).filter(q => q.id !== id);
    const i = at == null || at === "" ? list.length : Math.max(0, Math.min(list.length, Number(at) - 1 || 0));
    const was = rects();
    list.splice(i, 0, p); p.col = c.id; list.forEach((q, k) => { q.order = k; });
    draw(); glideFrom(was); save();
  }
  function setCollapsed(id, on, byHim = false) {
    const p = needP(id); p.collapsed = !!on; if (!on && byHim) delete p.fresh;
    const was = rects(); drawPanel(p); glideFrom(was); save(); ctx.bar.refresh();
  }
  function closeP(id) {
    needP(id);
    data().panels = panels().filter(p => p.id !== id);
    if (data().highlight?.id === id) data().highlight = null;
    if (st.here === id) { st.here = ""; ctx.bar.focus(ME); }
    const was = rects(); draw(); glideFrom(was); save();
  }
  function setNote(id, text) {
    const p = needP(id); if (p.kind !== "note") throw new Error(`${id} is not a note`);
    if (st.els.get(id)?.editing) throw new Error(`${WHO} is editing ${id}`);
    p.text = String(text || ""); drawPanel(p); save();
  }
  function setTitle(id, t) { const p = needP(id); p.title = String(t).slice(0, 120); p.named = true; drawPanel(p); save(); ctx.bar.refresh(); }
  function setHighlight(id, reason = "") {
    if (id && !findP(id) && !cols().some(c => c.id === id)) throw new Error(`no panel or column ${id}`);
    data().highlight = id ? { id, reason: String(reason).slice(0, 200) } : null;
    draw(); save();
    if (id) reveal(id);
  }
  function setFresh(id, on, reason = "") {
    const p = needP(id);
    if (on) p.fresh = String(reason).trim().slice(0, 200) || true; else delete p.fresh;
    drawPanel(p); save();
  }
  const seen = id => { if (findP(id)?.fresh) setFresh(id, false); };
  // a panel into view inside its own column (vertical only: never moves the sideways strip)
  function intoView(id, smooth = true) {
    const e = st.els.get(id)?.el, list = e?.closest(".co-list"); if (!list) return;
    const r = e.getBoundingClientRect(), lr = list.getBoundingClientRect();
    const dy = r.top < lr.top ? r.top - lr.top - 8 : r.bottom > lr.bottom ? Math.min(r.top - lr.top - 8, r.bottom - lr.bottom + 8) : 0;
    if (dy) list.scrollBy({ top: dy, behavior: smooth ? "smooth" : "auto" });
  }
  function reveal(id) {
    const p = findP(id);
    if (st.listOpen) { closeList(p ? p.col : id); if (p) setTimeout(() => intoView(id), 300); return; }
    showCol(p ? p.col : id);
    if (p) setTimeout(() => intoView(id), 300);
  }
  function tapP(id) {
    const was = st.here; st.here = id;
    if (was !== id) for (const [pid, e] of st.els) e.el.classList.toggle("here", pid === id);
    if (data()?.highlight?.id === id) setHighlight("");
    seen(id);
    if (talks(findP(id))) ctx.bar.focus(WIN); else ctx.bar.refresh();
  }
  const talks = p => !!p && !p.collapsed && !["file", "url", "note"].includes(p.kind);
  const hereP = () => { const p = findP(st.here); return talks(p) && st.els.get(p.id)?.frame ? p : null; };
  // a tap inside a frame does not reach this page: notice the focus moving into it
  addEventListener("blur", () => setTimeout(() => {
    const f = document.activeElement;
    if (f?.classList?.contains("co-frame")) { const id = f.closest(".co-panel")?.dataset.id; if (id) tapP(id); }
  }, 0));
  function openFull(id) {
    const p = findP(id); if (!p) return;
    if (p.kind === "file" || p.kind === "url") open(fullOf(p), "_blank", "noopener"); else location.assign(fullOf(p));
  }
  async function addFile() {
    const f = fileIn.files?.[0]; fileIn.value = "";
    if (!f) return;
    say(`Uploading ${f.name}…`);
    try { const it = await ctx.upload(f); addP("", "file", it.id, f.name); say(""); } catch (e) { say(`Upload failed: ${e.message}`, true); }
  }

  // the add menu: right under its button (locality); panels go into the column in view
  function togglePick(on = pick.hidden) {
    if (!on) { pick.hidden = true; return; }
    const item = (label, tip, fn) => h("button", { class: "co-pi k-pop-i", type: "button", role: "menuitem", "data-tip": tip, onclick: fn }, label);
    const done = fn => () => { pick.hidden = true; try { fn(); } catch (e) { say(e.message, true); } };
    const here = cols()[atIdx()]?.title;
    pick.replaceChildren(
      item("New column", "A new column for another topic", done(() => { const t = prompt("Column name", ""); if (t !== null) addCol(t); })),
      here ? h("p", { class: "co-ph k-pop-h" }, `Into “${here}”:`) : null,
      item("Note", "A short Markdown note; tap its pen to write", done(() => { const p = addP("", "note", "", "Note"); toggleEdit(p.id); })),
      item("Thread…", "A chat thread: pick one", () => threadPick()),
      item("Thread list", "All threads, with their own conversation", done(() => addP("", "threads"))),
      item("Task Tinder", `Swipe ${AG}'s task suggestions`, done(() => addP("", "tinder"))),
      item("Projects", "The project list and dashboards", done(() => addP("", "projects"))),
      item("File or PDF…", "Upload a file; it opens in the browser's own viewer", done(() => fileIn.click())),
      item("Web page…", "Any http(s) address", done(() => { const u = prompt("Web address (https://…)", "https://"); if (u && u.trim() !== "https://") addP("", "url", u.trim()); })));
    pick.hidden = false; anchor();
  }
  async function threadPick() {
    pick.replaceChildren(h("p", { class: "co-empty" }, "Loading threads…")); anchor();
    await loadThreads();
    pick.replaceChildren(h("button", { class: "co-pi k-pop-i co-pback k-pop-back", type: "button", "data-tip": "Back to the menu", onclick: () => togglePick(true) }, "‹ Back"),
      h("div", { class: "co-pscroll k-pop-scroll" }, st.threads.slice(0, 40).map(t => h("button", { class: "co-pi k-pop-i", type: "button", role: "menuitem", "data-tip": `Add “${t.data.title || t.id}”`,
        onclick: () => { pick.hidden = true; try { addP("", "thread", t.id, t.data.title); } catch (e) { say(e.message, true); } } }, t.data.title || t.id))));
    anchor();
  }
  function anchor() {
    const b = addBtn.getBoundingClientRect(), r = box.getBoundingClientRect();
    pick.style.top = (b.bottom - r.top + 4) + "px"; pick.style.right = Math.max(4, r.right - b.right) + "px";
  }
  addEventListener("pointerdown", e => { if (!pick.hidden && !pick.contains(e.target) && !addBtn.contains(e.target)) pick.hidden = true; }, true);
  addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!pick.hidden) { pick.hidden = true; return; }
    if (st.listOpen && box.getClientRects().length && !e.target.closest?.("input, textarea, [contenteditable]")) closeList();
  });

  // ------------------------------------------------------------ the agent: describe + @lines
  const NOTE_MAX = 4000;
  // a long note is cut in the prompt, so the rules and actions always fit
  const NOTE_SHOWN = 600;
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}… (${t.length - n} more characters; ask to see the full text)` : t);
  const describeList = () => {
    const line = it => `- ${it.id} | ${(it.data.title || "Untitled board").replace(/\s+/g, " ")} | ${boardSummary(it)} | updated ${new Date(Number(it.updated)).toISOString()}`;
    const shown = st.list.filter(it => !it.data.hidden), hidden = st.list.filter(it => it.data.hidden);
    return `[Sent from the Sleipnyr Columns board list: ${WHO}'s Columns boards (each a set of named columns of foldable panels), newest first.\n`
      + `Boards (id | title | size | last updated):\n${shown.map(line).join("\n") || "(none)"}\nArchived (hidden) boards:\n${hidden.map(line).join("\n") || "(none)"}\n`
      + `This chat is the board list's own history; the list acts on your reply. ${ONE_SENTENCE}, `
      + `then one line per action, exactly:\n@open <board id>\n@new [title]   (a new board, opened at once; default title = today)\n@rename <board id> <title>\n`
      + `@hide <board id>   (archive; nothing is deleted)\n@unhide <board id>\n`
      + `${runs("list")} Use only ids listed above. Never delete anything.]`;
  };
  const describe = async () => {
    if (!st.item) return describeList();
    await loadThreads();
    const at = cols()[atIdx()];
    const cs = cols().map((c, i) => `Column ${i + 1}: ${c.id} | ${c.title}${c.id === at?.id ? " | on screen" : ""}\n`
      + (inCol(c.id).map(p => `  - ${p.id} | ${p.kind}${p.ref ? " " + p.ref : ""} | ${pTitle(p)}${p.collapsed ? " | folded" : ""}${data().highlight?.id === p.id ? " | highlighted" : ""}${p.fresh ? " | marked new" : ""}${decOn() && p.decide ? ` | decision: ${p.decide.state}${p.decide.log?.length ? ` (${decideLine(p.decide)})` : ""}` : ""}`
        + (p.kind === "note" ? `\n     text:\n${clip(p.text || "(empty)", NOTE_SHOWN).replace(/^/gm, "       ")}` : "")).join("\n") || "  (empty)")).join("\n");
    const threads = st.threads.slice(0, 25).map(t => `- ${t.id} | ${t.data.title || ""}`).join("\n");
    const notes = data().agentNotes ? `[Agent notes, hidden from ${WHO}'s view, kept with the columns]\n${data().agentNotes}\n[End of agent notes]\n\n` : "";
    return `${notes}[Sent from the Sleipnyr Columns board "${(data().title || "").replace(/"/g, "'")}" (${st.item.id}): named columns side by side, one per topic ${WHO} keeps in mind, each a list of foldable panels `
      + `top to bottom (a phone shows one column at a time and swipes between them${matchMedia("(max-width: 760px)").matches ? "; the user is on a phone now" : ""}).\n`
      + (st.listOpen ? `${WHO} has the column list open (the columns as rows, to pick or reorder one; @show <column> closes it and lands there).\n` : "")
      + `Columns are named by id, title or number (1 = leftmost). Actions, exactly:\n`
      + `@column <title>   (a new column at the right)\n@rename-column <column> <title>\n@move-column <column> <position>\n@remove-column <column>   (only an empty one)\n@show <column>   (swipe to it)\n`
      + `@note <column> <title>   (a new note at the bottom; its Markdown text on the next lines, then a line @end; keep it short)\n`
      + `@edit <panel id>   (replace a note's text: new text on the next lines, then @end)\n`
      + `@add <column> thread <thread id> | threads | tinder | projects [project id] | file <file id> [| title] | url <https address>\n`
      + `@move <panel id> <column> [position]   (position 1 = top; without it, the bottom)\n`
      + `@collapse <panel id>   (also @fold)\n@expand <panel id>   (also @unfold)\n@close <panel id>\n@title <panel id> <name>\n@focus <panel id>   (swipe to it and scroll it into view)\n`
      + `@highlight <panel or column id> [why]   (pink "look here" frame, one at a time)\n@unhighlight\n@new <panel id> [why]   (green "new" frame)\n@unnew <panel id>\n`
      + (decOn() ? `@suggest <column> [board=<kanban board>] <title>   (a suggested task: a note with Dismiss, Comment and Accept at its foot; text on the next lines, then @end: what you would do, why it is worth it, rough effort, what ${WHO} must provide)\n`
      + `@decide <panel id> [kanban board]   (give any panel Dismiss, Comment and Accept)\n`
      + `${WHO}'s decisions are recorded on the panel and reach you as unassigned Kanban cards; never decide for ${WHO}.\n` : "")
      + `@memo <text>   (append to this board's hidden notes, shown to you at the top of every prompt from this board; for conventions ${WHO} agrees)\n@memo-clear\n`
      + `@rename-board <title>\n@back   (to the board list)\n`
      + `In notes, link files as [name](/k/files/<file id>) and pages as [name](https://...).\n`
      + `This chat is this board's own history; the board acts on your reply (other boards are not affected). ${ONE_SENTENCE}, `
      + `then one line per action. ${runs("view")} Never delete anything.\n`
      + `${cs || "(no columns)"}\nRecent threads (id | title):\n${threads || "(none)"}]`;
  };
  const run = async (name, args, text = "") => {
    if (!st.item) return runList(name, args);
    const r = await run1(name, args, text);
    if (st.item && !(await save(true))) throw new Error(`not saved (${r})`);
    return r;
  };
  async function runList(name, args) {
    const a = String(args || "").trim(), [first, ...rest] = a.split(/\s+/);
    const need = () => { const it = st.list.find(x => x.id === first); if (!it) throw new Error(`no board ${first}`); return it; };
    switch (name) {
      case "open": need(); ctx.levels.go(ME, first); return `open ${first}`;
      case "new": { const it = await newBoard(a); if (!it) throw new Error("could not make a board"); return `new ${it.id}`; }
      case "rename": need(); await patchBoard(first, { title: rest.join(" ").trim().slice(0, 80) || "Untitled board" }); drawList(); return `rename ${first}`;
      case "hide": case "unhide": need(); await patchBoard(first, { hidden: name === "hide" ? true : null }); drawList(); return `${name} ${first}`;
    }
    throw new Error("unknown command");
  }
  async function run1(name, args, text = "") {
    const a = String(args || "").trim(), [first, ...rest] = a.split(/\s+/);
    switch (name) {
      case "rename-board": { const t = a.slice(0, 80); if (!t) throw new Error("which name?"); data().title = t; drawHead(); await patchBoard(st.item.id, { title: t }); return "rename-board"; }
      case "back": ctx.levels.go(ME, ""); return "back";
      case "column": return `column ${addCol(a).id}`;
      case "rename-column": { const c = needC(first); c.title = rest.join(" ").trim().slice(0, 80) || c.title; draw(); return `rename-column ${c.id}`; }
      case "move-column": moveCol(first, rest[0]); return `move-column ${first}`;
      case "remove-column": return `remove-column ${dropCol(first).id}`;
      case "show": { const c = needC(a); if (st.listOpen) closeList(c.id); else showCol(c.id); return `show ${a}`; }
      case "note": { const c = needC(first); return `note ${addP(c.id, "note", text || "", rest.join(" ") || "Note").id}`; }
      case "edit": setNote(first, text || rest.join(" ")); return `edit ${first}`;
      case "add": {
        const [kind, ...more] = rest, [ref, title] = more.join(" ").split("|").map(s => s.trim());
        return `add ${addP(needC(first).id, kind, ref || "", title || (kind === "thread" ? st.threads.find(t => t.id === ref)?.data.title || "" : "")).id}`;
      }
      case "move": moveP(first, rest[0], rest[1]); return `move ${first}`;
      case "collapse": case "fold": setCollapsed(first, true); return `collapse ${first}`;
      case "expand": case "unfold": setCollapsed(first, false); return `expand ${first}`;
      case "close": closeP(first); return `close ${first}`;
      case "title": if (!rest.length) throw new Error("which name?"); setTitle(first, rest.join(" ")); return `title ${first}`;
      case "focus": needP(first); reveal(first); return `focus ${first}`;
      case "highlight": setHighlight(findP(first) ? first : needC(first).id, rest.join(" ")); return `highlight ${first}`;
      case "unhighlight": setHighlight(""); return "unhighlight";
      case "new": setFresh(first, true, rest.join(" ")); return `new ${first}`;
      case "unnew": setFresh(first, false); return `unnew ${first}`;
      case "memo": {
        const add = (a + (text ? "\n" + text : "")).trim(); if (!add) throw new Error("usage: @memo <text>");
        const next = (data().agentNotes ? data().agentNotes.replace(/\s+$/, "") + "\n" : "") + add;
        if (next.length > NOTE_MAX) throw new Error(`notes full (${NOTE_MAX} characters): @memo-clear first`);
        data().agentNotes = next; return "memo";
      }
      case "memo-clear": data().agentNotes = ""; return "memo-clear";
      case "suggest": {
        if (!decOn()) return "suggest ignored (panel decisions are off)";
        const c = needC(first); let words = rest;
        let board = "";
        if (/^board=/.test(words[0] || "")) { board = words[0].slice(6); words = words.slice(1); }
        const np = addP(c.id, "note", text || "", words.join(" ") || "Suggestion");
        np.decide = { state: "open", ...(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(board) ? { board } : {}), log: [] };
        drawPanel(np); return `suggest ${np.id}`;
      }
      case "decide": {
        if (!decOn()) return "decide ignored (panel decisions are off)";
        const dp = needP(first);
        if (!dp.decide) dp.decide = { state: "open", log: [] };
        if (rest[0] && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(rest[0])) dp.decide.board = rest[0];
        drawPanel(dp); return `decide ${first}`;
      }
    }
    throw new Error("unknown command");
  }

  // ------------------------------------------------------------ level + live updates
  let chat = null;
  ctx.bar.offer({ id: WIN, label: () => pTitle(hereP() || {}), shown: () => !!box.getClientRects().length && !!hereP(),
    send: b => {
      const p = hereP(), win = p && st.els.get(p.id)?.frame?.contentWindow;
      if (!win?.__kSend) throw new Error("that panel is still loading");
      return win.__kSend(b);
    } });
  ctx.bar.offer({ id: ME, label: () => (st.item ? cols()[atIdx()]?.title || data().title || "Columns" : "Columns boards"), shown: () => !!box.getClientRects().length,
    placeholder: () => (st.item ? "Ask the columns: add notes, move or fold panels" : "Ask the boards: open, start or rename one"),
    send: b => { if (!chat) throw new Error("no conversation here"); return chat.send(b); } });
  // the level's place: "" = the board list, else a board id
  const embed = (view, title) => { chat = ctx.embed(view, box, { title, from: "columns", describe, run, scope: () => st.item?.id || "", ownThread: true }); };
  let showing = 0;
  async function show(sub) {
    const mine = ++showing;
    pick.hidden = true; say("");
    if (st.listOpen && !(sub && history.state?.coList === sub)) setListShown(false);
    if (!sub && st.list.length) {
      // back to the list: shown at once from what we have, refreshed behind it
      // (a slow or stalled phone connection must never keep him on the board)
      if (st.item) await settle(flush());
      if (mine !== showing) return;
      st.item = null; st.here = ""; clearBoard();
      drawList(); embed(`${ME}-boards`, "Board list conversation");
      ctx.bar.focus(ME); chat?.retry?.();
      if (await loadList() && mine === showing && !st.item) drawList();
      return;
    }
    const ok = !st.list.length || !sub ? await loadList() : true;
    if (ok && !st.list.length) { await newBoard(); return; } // the very first visit: one board to start with
    if (mine !== showing) return;
    if (!sub) {
      if (st.item) await settle(flush());
      st.item = null; st.here = ""; clearBoard();
      drawList(); embed(`${ME}-boards`, "Board list conversation");
      ctx.bar.focus(ME); chat?.retry?.(); return;
    }
    let it = st.list.find(x => x.id === sub);
    if (!it) try { it = await ctx.api(`/k/items/${encodeURIComponent(sub)}`); } catch { it = null; }
    if (mine !== showing) return;
    if (!it || it.type !== ME) { say("No such board.", true); ctx.levels.go(ME, ""); return; }
    if (st.item?.id !== it.id) {
      if (st.item) await settle(flush());
      if (mine !== showing) return;
      clearBoard();
      st.item = { ...it, data: { columns: [], panels: [], ...it.data } }; setBase(it);
      st.at = localStorage.getItem(atKey()) || (it.data.chatView === ME ? localStorage.getItem(AT_KEY) || "" : "");
    }
    st.last = it.id;
    drawHead(); boards.el.hidden = true; strip.hidden = st.listOpen; clist.hidden = !st.listOpen;
    embed(viewOf(st.item), `${st.item.data.title || "Board"} conversation`);
    await loadThreads();
    if (mine !== showing) return;
    draw();
    // back to the column this device showed last on this board, before any waiting @lines run
    if (st.listOpen) drawColList();
    else if (st.at && findC(st.at)) showCol(st.at, false); else strip.scrollLeft = 0;
    drawPos();
    ctx.bar.focus(hereP() ? WIN : ME);
    chat?.retry?.();
  }
  function clearBoard() {
    clearTimeout(st.saveTimer);
    st.els.forEach(e => e.el.remove()); st.els.clear(); st.cels.clear(); strip.replaceChildren();
    st.base = null; st.baseAt = 0; st.later = null; st.here = "";
  }
  // the kernel's generic view actions (kernel/web/actions.js): showing a
  // panel never scrolls the sideways strip by hand; order = the panels' slots
  ctx.actions?.view?.(ME, {
    scrollTo: id => { if (!st.item || (!findP(id) && !findC(id))) return false; reveal(id); return true; },
    focus: id => { if (!st.item || (!findP(id) && !findC(id))) return false; reveal(id); return true; },
    fold: (id, folded) => {
      const p = st.item && findP(id); if (!p) return false;
      if (!!p.collapsed !== folded) setCollapsed(id, folded, true);
      return `${folded ? "folded" : "unfolded"} panel ${id} "${pTitle(p)}"`;
    },
    order: (ids, { into, at }) => {
      if (!st.item) throw new Error("open a board first");
      if (ids.length && ids.every(id => cols().some(c => c.id === id))) { // columns trade places
        const cs = cols().slice(), slots = ids.map(id => cs.findIndex(c => c.id === id)).sort((a, b) => a - b);
        slots.forEach((k, i) => { cs[k] = cols().find(c => c.id === ids[i]); });
        const was = rects(); data().columns = cs; draw(); glideFrom(was); save();
        return `reordered ${ids.length} column(s)`;
      }
      const ps = ids.map(needP);
      if (into) { ps.forEach((p, i) => moveP(p.id, into, at ? at + i : "")); return `moved ${ps.length} panel(s) into ${needC(into).title}`; }
      const ci = id => cols().findIndex(c => c.id === id);
      const slots = ps.map(p => ({ col: p.col, order: p.order })).sort((a, b) => ci(a.col) - ci(b.col) || a.order - b.order);
      const was = rects();
      ps.forEach((p, i) => { p.col = slots[i].col; p.order = slots[i].order; });
      draw(); glideFrom(was); save();
      return `reordered ${ps.length} panel(s)`;
    },
  });
  ctx.levels.onChange((level, sub) => { if (level === ME) show(sub || ""); });
  ctx.on("item", ({ item }) => {
    if (item?.type === ME) {
      const i = st.list.findIndex(x => x.id === item.id);
      if (i >= 0) st.list[i] = item; else st.list.unshift(item);
      if (!st.item && ctx.levels.current() === ME) drawList();
    }
    if (item?.type === "columns" && st.item?.id === item.id && item.updated > (st.baseAt || 0)) remote(item);
    if (item?.type === "thread" && panels().some(p => p.kind === "thread" && p.ref === item.id)) {
      const i = st.threads.findIndex(t => t.id === item.id); if (i >= 0) st.threads[i] = item;
      for (const p of panels()) if (p.ref === item.id) drawPanel(p);
    }
  });
}
