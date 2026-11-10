// Next thread: a bent-arrow icon in the thread bar asks Clear / Continue / ✕ in
// a small menu right under the icon (effects stay next to their cause).
//   Clear     a new, empty thread
//   Continue  a new thread that shows the one it came from above its first
//             message (read-only, live), a thin bar with that thread's title
//             after it; a chain of Continues shows up to DEPTH threads,
//             oldest on top
// Both open a fresh agent session: the new thread never waits on a run that
// is still busy (or hung) in the old one.
// The same icon sits in the embedded chat (a view's conversation), on its
// collapsed line and in its open header: the new thread becomes the view's
// conversation, the old one moves into the archive, kept. Continue there
// shows the earlier threads above the strip's log exactly as in a thread.
// Plain JavaScript, loaded by the shell as an extension of the chat:
// extend(host, ctx), host = what chat.js mount() returns.
// bent arrow (down, then right), drawn like the chat's own icons
const NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v8a4 4 0 0 0 4 4h9M15 12l4 4-4 4"/></svg>';
const icon = s => { const t = document.createElement("template"); t.innerHTML = s; return t.content.firstChild; };

const API = "/p/next-thread";
const DEPTH = 8;

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

const when = t => {
  const d = new Date(t), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
};

export function extend(host, ctx) {
  if (!host?.el?.bar || !host.onDraw) return;
  const { bar, log } = host.el;

  // ------------------------------------------------------------ ask
  // The icon and its menu, made once per place: the thread bar, and the
  // embedded chat's header (there the new thread replaces the pinned one).
  function asker(bar, pane, thread, open) {
    // a small menu like Columns' add menu: a heading, then one row per
    // choice (name + what it does); Escape or a tap elsewhere cancels
    const msg = h("div", { class: "nt-q" }, "New thread");
    const choice = (mode, label, what) => h("button", { class: "nt-c", type: "button", role: "menuitem", "data-tip": `${label}: ${what.toLowerCase()}`, onclick: () => start(mode) },
      h("span", {}, label), h("small", {}, what));
    const row = h("div", { class: "nt-ask", role: "menu", "aria-label": "New thread", hidden: true },
      msg,
      choice("clear", "Clear", "Start empty"),
      choice("continue", "Continue", "Keep this thread above it"));
    const btn = h("button", { class: "c-btn c-ic nt-btn", type: "button", "data-tip": "New thread from this one", "aria-label": "New thread from this one",
      onclick: () => (row.hidden ? ask() : idle()) }, icon(NEXT));
    bar.append(btn);
    // the menu hangs under the icon (above it when there is no room below,
    // e.g. on the embedded chat's bottom line), inside the pane (the
    // positioning frame), and closes on Escape or a tap elsewhere
    pane.append(row);
    const place = () => {
      const p = pane.getBoundingClientRect(), b = btn.getBoundingClientRect();
      const up = b.bottom + 4 + row.offsetHeight > innerHeight - 64; // keep clear of the bar
      row.style.top = up ? "" : `${b.bottom - p.top + 4}px`;
      row.style.bottom = up ? `${p.bottom - b.top + 4}px` : "";
      row.style.right = `${Math.max(4, p.right - b.right)}px`;
    };
    document.addEventListener("pointerdown", e => {
      if (!row.hidden && !row.contains(e.target) && !btn.contains(e.target)) idle();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !row.hidden) idle(); });

    let busy = false;
    const ask = (text = "New thread") => { msg.textContent = text; msg.classList.toggle("err", text !== "New thread"); row.hidden = false; place(); };
    const idle = () => { row.hidden = true; };
    async function start(mode) {
      const t = thread();
      if (!t || busy) return;
      busy = true; row.classList.add("busy");
      try {
        const made = await ctx.api(`${API}/from/${encodeURIComponent(t.id)}`, { json: { mode } });
        idle();
        await open(made);
      } catch (e) { ask(`Could not start a thread: ${e.message}`); }
      finally { busy = false; row.classList.remove("busy"); }
    }
    return { btn, idle };
  }
  const main = asker(bar, bar.parentElement, () => host.thread(), t => host.open(t));
  if (host.strip) asker(host.strip.tools, host.strip.el, () => host.strip.thread(), t => host.strip.open(t));

  // ------------------------------------------------------------ the threads above (Continue)
  // One drawing for every place that shows a thread: the thread view and the
  // embedded chat. place = {log, thread(), strip}; strip messages carry no
  // element ids (the open thread owns those).
  const shown = new Map(); // thread id -> its sections (one per place) in the blocks above the logs
  const msgEl = (m, place) => { const el = host.messageEl(m); if (place.strip) el.removeAttribute("id"); return el; };

  function above(place) {
    let token = 0;
    return async function draw(threadId) {
      const mine = ++token;
      const { log } = place;
      for (const [id, secs] of shown) { secs.delete(place); if (!secs.size) shown.delete(id); }
      log.querySelector(":scope > .nt-prev")?.remove(); // the strip keeps its log element across pins
      const t = place.thread();
      if (!t || t.id !== threadId || !t.data.continues || !t.data.from) return;
      // the chain, newest first: each thread made by Continue pulls in the one it came from
      const chain = [], seen = new Set([t.id]);
      for (let id = t.data.from; id && !seen.has(id) && chain.length < DEPTH;) {
        seen.add(id);
        let it, msgs;
        try {
          [it, msgs] = await Promise.all([ctx.api(`/k/items/${encodeURIComponent(id)}`),
            ctx.api(`/p/chat/threads/${encodeURIComponent(id)}/messages`)]);
        } catch { break; }
        if (mine !== token) return;
        chain.push({ it, msgs });
        id = it.data.continues ? it.data.from : null;
      }
      if (mine !== token || !chain.length || place.thread()?.id !== threadId) return;
      const block = h("div", { class: "nt-prev" });
      for (const { it, msgs } of chain.reverse()) {
        const sec = h("div", { class: "nt-sec", "data-thread": it.id }, msgs.map(m => msgEl(m, place)));
        if (!msgs.length) sec.append(h("p", { class: "nt-none" }, "No messages"));
        const last = msgs.length ? msgs[msgs.length - 1].created : it.created;
        const link = h("a", { class: "nt-open", href: ctx.address(it.id), "aria-label": `Open ${it.data.title || "the earlier thread"}`,
          onclick: e => { e.preventDefault(); host.open(it); } }, "↗");
        block.append(sec, h("div", { class: "nt-bar", role: "separator" },
          h("span", { class: "nt-line" }), h("span", { class: "nt-t" }, it.data.title || "Thread"),
          h("span", { class: "nt-w" }, "· " + when(last)), h("span", { class: "nt-line" }), link));
        if (!shown.has(it.id)) shown.set(it.id, new Map());
        shown.get(it.id).set(place, sec);
      }
      const fromBottom = log.scrollHeight - log.scrollTop;
      log.prepend(block);
      log.scrollTop = log.scrollHeight - fromBottom; // the open thread stays where it was
    };
  }

  // an earlier thread's reply still running there (or finally landing) shows up live
  ctx.on("item", ({ item }) => {
    if (item.type !== "message") return;
    for (const [place, sec] of shown.get(item.data.thread) || []) {
      if (!sec.isConnected) continue;
      const el = msgEl(item, place), old = [...sec.children].find(x => x.dataset?.id === item.id);
      if (old) old.replaceWith(el);
      else { sec.querySelector(".nt-none")?.remove(); sec.append(el); }
    }
  });

  const drawMain = above({ log, thread: () => host.thread() });
  host.onDraw(threadId => {
    main.btn.hidden = !threadId; if (!threadId) main.idle();
    return drawMain(threadId);
  });
  if (host.strip?.onDraw) host.strip.onDraw(above({ log: host.strip.log, thread: () => host.strip.thread(), strip: true }));
}
