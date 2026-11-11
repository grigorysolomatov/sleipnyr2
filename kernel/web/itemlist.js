// A modality's own list of items (Columns boards, later others), shaped like
// the thread list: one row per item, title left, last change right, newest
// first, pink = the one open last. Tap opens it; hidden items wait under
// "Archived". The modality owns the data and the header; this only draws.
//
//   const list = itemList({ word: "board", href: it => url, open: it => ...,
//                           title: it => text, summary: it => text,
//                           archive: (it, on) => Promise,          // optional
//                           order: { ids: () => [id...], save: ids => Promise } }); // optional
// With `archive`, every row has a small icon button just left of its time: Archive on a listed row
// (a centred confirm dialog: Cancel / Archive), Restore on an archived one (at
// once, nothing to confirm). Clicking it never opens the row.
// With `order`, the listed rows follow that id list (items not in it, e.g. a
// new one, go on top, newest first) and can be reordered by hand: a finger
// holds a row still until it lifts, then drags it; the mouse just drags. The
// others slide aside, it glides into place, and save() gets the new id list.
// Archived rows keep their newest-first order and are never dragged.
//   box.append(list.el); list.draw(items, here);

const HOLD = 350;  // ms a finger rests on a row before it lifts
const SLOP = 8;    // px of movement that turns a press into a drag (or a scroll)
const GLIDE = 220; // ms, rows easing into their new places

const when = t => {
  const d = new Date(Number(t)), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
};
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

const SVG = d => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const BOX = SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>');
const UNBOX = SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M12 18v-6M9.5 14.5L12 12l2.5 2.5"/>');

/** A centred confirm dialog on a dimmed backdrop. Resolves true (confirm: button, Enter) or false (Cancel, Esc, backdrop). */
export function confirmDialog({ title, text, ok = "OK", cancel = "Cancel" }) {
  return new Promise(res => {
    const prev = document.activeElement;
    const done = v => { removeEventListener("keydown", key, true); back.remove(); try { prev?.focus?.({ preventScroll: true }); } catch { /* gone */ } res(v); };
    const yes = h("button", { class: "k-dlg-ok", type: "button", "data-k-id": "dialog-ok", "data-k-kind": "action", onclick: () => done(true) }, ok);
    const no = h("button", { class: "k-dlg-no", type: "button", "data-k-id": "dialog-cancel", "data-k-kind": "action", onclick: () => done(false) }, cancel);
    const back = h("div", { class: "k-dlg-back", onclick: e => { if (e.target === back) done(false); } },
      h("div", { class: "k-dlg", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("div", { class: "k-dlg-t" }, title), text ? h("div", { class: "k-dlg-x" }, text) : null,
        h("div", { class: "k-dlg-b" }, no, yes)));
    const key = e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); (document.activeElement === no ? no : yes).click(); }
      else if (e.key === "Tab") { e.preventDefault(); (document.activeElement === yes ? no : yes).focus(); }
    };
    addEventListener("keydown", key, true);
    document.body.append(back);
    document.querySelector(".k-tip")?.setAttribute("hidden", "");
    yes.focus();
  });
}

/** Items in hand order: those missing from `ids` first (newest first), then the rest as listed. */
export function orderItems(items, ids = []) {
  const rank = new Map((ids || []).map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id), rb = rank.get(b.id);
    if (ra === undefined && rb === undefined) return Number(b.updated) - Number(a.updated);
    if (ra === undefined) return -1;
    if (rb === undefined) return 1;
    return ra - rb;
  });
}

/** `ids` with `id` moved to position `pos` (1 = top; clamped). */
export function moveId(ids, id, pos) {
  const rest = ids.filter(x => x !== id), i = Math.max(0, Math.min(rest.length, Math.round(Number(pos) || 1) - 1));
  rest.splice(i, 0, id);
  return rest;
}

export function itemList({ word = "item", agent = "the agent", href, open, title, summary, archive, order }) {
  const el = h("ul", { class: "k-items", role: "list" });
  let drag = null, later = null, pressed = 0, last = { items: [], here: "" };
  async function archiveIt(it) {
    const on = !it.data.hidden;
    if (on && !await confirmDialog({ title: `Archive \u201c${title(it)}\u201d?`, text: `It moves to Archived; nothing is deleted.`, ok: "Archive" })) return;
    archive(it, on).catch(e => alert(`Could not ${on ? "archive" : "restore"}: ${e.message}`));
  }

  // one press on a row: a tap opens, a finger held still lifts it (listed rows,
  // with `order`), the mouse drags at once
  function press(e, it, movable) {
    if (e.button > 0 || drag) return;
    if (e.target.closest(".k-it-ar")) return; // the archive button is not a handle
    const a = e.currentTarget, x0 = e.clientX, y0 = e.clientY, pid = e.pointerId, mouse = (e.pointerType || "mouse") === "mouse";
    if (mouse && !movable) return;
    let lifted = false, timer = 0, moved = false;
    if (!mouse) timer = setTimeout(() => {
      lifted = true; startDrag(a, y0); try { a.setPointerCapture(pid); } catch { /* synthetic */ }
    }, HOLD);
    const move = ev => {
      if (ev.pointerId !== pid) return;
      const dist = Math.hypot(ev.clientX - x0, ev.clientY - y0);
      if (!lifted && dist > SLOP) {
        if (mouse) { lifted = true; startDrag(a, y0); } // the mouse drags at once
        else { clearTimeout(timer); return stop(); }    // a finger moving first = a scroll
      }
      if (lifted) { if (dist > SLOP) moved = true; moveDrag(ev.clientY); }
    };
    const end = ev => {
      if (ev.pointerId !== pid) return;
      stop();
      if (!lifted) return;
      pressed = Date.now();
      const cancel = ev.type === "pointercancel";
      endDrag(cancel || !moved);
    };
    function stop() {
      clearTimeout(timer);
      removeEventListener("pointermove", move, true); removeEventListener("pointerup", end, true); removeEventListener("pointercancel", end, true);
    }
    addEventListener("pointermove", move, true); addEventListener("pointerup", end, true); addEventListener("pointercancel", end, true);
  }

  const arBtn = it => {
    const on = !it.data.hidden, tip = on ? "Archive board" : "Restore board";
    const b = h("button", { class: "k-it-ar", type: "button", title: tip, "aria-label": tip, "data-tip": tip, "data-k-id": `${on ? "archive" : "restore"}-${it.id}`, "data-k-kind": "action",
      onclick: e => { e.preventDefault(); e.stopPropagation(); archiveIt(it); } });
    b.innerHTML = on ? BOX : UNBOX;
    return b;
  };
  const row = (it, here, movable) => {
    const a = h("a", { href: href(it), "data-id": it.id, "data-k-id": it.id, "data-k-kind": word, draggable: "false",
      ...(movable ? { "data-k-order": "" } : {}),
      class: it.id === here ? "here" : null,
      "data-tip": summary ? summary(it) : `Open ${title(it)}`,
      onclick: e => { e.preventDefault(); if (Date.now() - pressed < 600) return; open(it); },
      ondragstart: e => e.preventDefault(),
      ...(movable ? { onpointerdown: e => press(e, it, movable) } : {}) },
      h("span", { class: "k-it-t" }, title(it)),
      archive ? arBtn(it) : null,
      h("time", {}, when(it.updated)));
    // once lifted, the list must not scroll under the finger
    if (movable) a.addEventListener("touchmove", e => { if (drag?.el === a && e.cancelable) e.preventDefault(); }, { passive: false });
    return h("li", {}, a);
  };

  // ------------------------------------------------ dragging a listed row
  const rowEls = () => [...el.querySelectorAll(":scope > li > a")];
  function startDrag(a, y) {
    const rows = rowEls(), r = a.getBoundingClientRect();
    drag = { el: a, y0: y, r, from: rows.indexOf(a), to: rows.indexOf(a), scroll0: el.scrollTop,
      others: rows.filter(x => x !== a).map(x => ({ el: x, r: x.getBoundingClientRect() })) };
    a.classList.add("drag"); el.classList.add("k-busy");
    document.querySelector(".k-tip")?.setAttribute("hidden", "");
    navigator.vibrate?.(15);
  }
  function moveDrag(y) {
    const d = drag; if (!d) return;
    const lr = el.getBoundingClientRect();
    if (y < lr.top + 40) el.scrollTop -= 10; else if (y > lr.bottom - 40) el.scrollTop += 10;
    const ds = el.scrollTop - d.scroll0, dy = y - d.y0 + ds;
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
  function endDrag(cancelled) {
    const d = drag; if (!d) return;
    const seen = new Map(rowEls().map(x => [x.dataset.id, x.getBoundingClientRect()])); // where they are seen now
    drag = null; el.classList.remove("k-busy");
    for (const o of d.others) { o.el.style.transform = ""; o.el.classList.remove("glide"); }
    d.el.classList.remove("drag"); d.el.style.transform = "";
    let ids = null;
    if (!cancelled && d.to !== d.from) ids = moveId(rowEls().map(x => x.dataset.id), d.el.dataset.id, d.to + 1);
    if (ids) { pending = ids; order.save(ids).catch(e => alert(`Could not save the order: ${e.message}`)).finally(() => { if (pending === ids) pending = null; }); }
    const next = later || last; later = null;
    draw(next.items, next.here);
    // FLIP: rows drawn where they were seen, then eased into their places
    for (const x of rowEls()) {
      const a = seen.get(x.dataset.id); if (!a) continue;
      const dy = a.top - x.getBoundingClientRect().top; if (Math.abs(dy) < 1) continue;
      x.style.transform = `translateY(${dy}px)`; void x.offsetWidth;
      x.classList.add("glide"); x.style.transform = "";
      setTimeout(() => x.classList.remove("glide"), GLIDE + 60);
    }
  }
  // the order just dropped, until the saved one comes back (a redraw meanwhile must not jump back)
  let pending = null;

  function draw(items, here = "") {
    if (drag) { later = { items, here }; return; } // never redraw under a finger
    last = { items, here };
    const newest = [...items].sort((a, b) => Number(b.updated) - Number(a.updated));
    const shown0 = newest.filter(it => !it.data.hidden), hidden = newest.filter(it => it.data.hidden);
    const shown = order ? orderItems(shown0, pending || order.ids() || []) : shown0;
    const movable = !!order && shown.length > 1;
    el.replaceChildren(...[...shown.map(it => row(it, here, movable)),
      shown.length ? null : h("li", { class: "k-it-empty" }, `No ${word}s yet. Tap + for a new one.`),
      hidden.length ? h("li", { class: "k-it-arch" }, h("details", { "data-k-id": "archived", "data-k-kind": "section", "data-k-label": "Archived" },
        h("summary", { "data-tip": `Hidden ${word}s; use its icon to restore it` }, `Archived (${hidden.length})`),
        h("ul", { class: "k-items", role: "list" }, hidden.map(it => row(it, here, false))))) : null].filter(Boolean));
  }
  const redraw = () => draw(last.items, last.here);
  return { el, draw, redraw, busy: () => !!drag };
}
