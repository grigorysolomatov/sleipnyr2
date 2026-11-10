// Recording context: while a voice message is recorded, what the person sees
// and does on the page, as a short text timeline that goes with the message
// (the agent gets it next to the transcript). Text only, no screenshots.
//
//   const rc = watchRecording(ctx)   at the start of a recording
//   rc.stop() -> {ms, events, snaps}  at the end (events: [{t, text}], t = ms
//                                     since the start; snaps: [{t, text}] =
//                                     what view_describe says, deduped)
//   rc.cancel()                       a discarded recording
//
// Generic on purpose, no view has to cooperate: it samples the view on screen
// every 400 ms through the conventions every view already follows (items
// carry data-k-id / data-k-kind / data-k-label, folded items the class
// "collapsed", orderable ones data-k-order) and notes taps on buttons and
// links. Logged: where the page is (view, board, open thread), the column on
// screen (Columns swipes), the panels / windows in view, fold / unfold,
// removed and moved items, and taps (Accept, Dismiss, Comment, a thread...).
// Switched by the feature "recordingContext" (Settings > Features).

const EVENTS_MAX = 80, TEXT_MAX = 240, SNAP_MAX = 2500, SNAPS_MAX = 4, BUDGET = 8000;
const words = (t, n = 50) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
const shown = e => !!e && e.getClientRects().length > 0;
const ITEMS = /panel|window/; // the kinds whose being in view, folding, removal and moves are noted

export function watchRecording(ctx, root = document.getElementById("app")) {
  const t0 = performance.now(), events = [], snaps = [];
  const at = () => Math.round(performance.now() - t0);
  let size = 0, full = false;
  const add = text => {
    text = words(text, TEXT_MAX);
    if (!text || full) return;
    if (events.length >= EVENTS_MAX || size + text.length > BUDGET * 0.6) { full = true; events.push({ t: at(), text: "(more happened; the log is full)" }); return; }
    events.push({ t: at(), text }); size += text.length + 8;
  };
  const levelBox = () => document.querySelector(".k-level:not([hidden])") || root;
  const label = e => words(e?.dataset?.kLabel || e?.querySelector?.(".co-pname, .ss-wname, .co-cname, summary, b")?.textContent || e?.textContent, 50);
  const named = e => { const l = words(label(e), 40); return `${e.dataset.kId}${l ? ` '${l}'` : ""}`; };
  const listed = es => es.slice(0, 4).map(named).join(", ") + (es.length > 4 ? ` +${es.length - 4} more` : "");
  const colText = cs => `${cs.length > 1 ? "columns" : "column"} on screen: ${cs.map(named).join(", ")}`;

  // ---- where: the view, its own place (board, project) and its header title
  const place = () => {
    const box = levelBox(), lv = ctx.levels?.current() || "", sub = ctx.levels?.sub() || "";
    const title = [...box.querySelectorAll("header h1, header b")].find(shown)?.textContent || "";
    const name = ctx.plugins?.find(p => p.id === lv)?.modality?.title || lv || "app";
    const thread = (location.pathname.match(/^\/i\/(.+)$/) || [])[1];
    return { key: `${lv}|${sub}|${location.pathname}|${words(title, 80)}`,
      text: `${name}${sub ? ` ${sub}` : ""}${thread ? ` thread ${thread}` : ""}${title ? ` '${words(title, 60)}'` : ""}` };
  };
  // ---- what is in view: the column most on screen, then the panels / windows on screen
  const visArea = e => {
    const r = e.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0), h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const inView = () => {
    const all = [...levelBox().querySelectorAll("[data-k-id]")].filter(shown);
    // the columns on screen (phone: the one swiped to; desktop: all of them that show)
    const cols = all.filter(e => e.dataset.kKind === "column").map(e => [e, visArea(e)]).filter(x => x[1] > 0);
    const big = Math.max(0, ...cols.map(x => x[1]));
    const on = cols.filter(x => x[1] >= big * 0.5).map(x => x[0]);
    const items = all.filter(e => ITEMS.test(e.dataset.kKind || "") && (!on.length || on.some(c => c.contains(e))))
      .map(e => [e, visArea(e), e.getBoundingClientRect()]).filter(x => x[1] > 2000)
      .sort((a, b) => a[2].left - b[2].left || a[2].top - b[2].top).map(x => x[0]);
    return { cols: on, items };
  };
  // ---- item state: folded, its container and position (for moves)
  const states = () => {
    const m = new Map();
    for (const e of levelBox().querySelectorAll("[data-k-id]")) {
      if (!ITEMS.test(e.dataset.kKind || "")) continue;
      const box = e.parentElement?.closest("[data-k-id]");
      m.set(e.dataset.kId, { e, name: named(e), folded: e.classList.contains("collapsed"), box: box?.dataset.kId || "", boxName: box ? named(box) : "",
        index: e.dataset.kOrder !== undefined ? [...(e.parentElement?.children || [])].filter(x => x.dataset?.kOrder !== undefined).indexOf(e) : -1 });
    }
    return m;
  };

  const describe = () => Promise.resolve(ctx.actions?.describe?.()).catch(() => "");
  const snap = async why => {
    const text = String(await describe() || "").slice(0, SNAP_MAX);
    if (!text || snaps.some(s => s.text === text) || snaps.length >= SNAPS_MAX) return;
    snaps.push({ t: at(), why, text });
  };

  let where = place(), view = inView(), was = states(), placeSince = 0, snapTimer = 0;
  add(`on ${where.text}${view.cols.length ? `, ${colText(view.cols)}` : ""}${view.items.length ? `; in view: ${listed(view.items)}` : ""}`);
  snap("start");
  const sample = () => {
    const p = place();
    if (p.key !== where.key) {
      where = p; placeSince = performance.now();
      add(`now on ${p.text}`);
      view = { cols: [], items: [] }; was = states();
      clearTimeout(snapTimer); snapTimer = setTimeout(() => snap("view change"), 900); // let the view draw first
      return;
    }
    if (performance.now() - placeSince < 600) { was = states(); return; } // a fresh view is still drawing
    const v = inView();
    const cs = v.cols.map(c => c.dataset.kId).join(" ");
    const ids = v.items.map(e => e.dataset.kId).join(" "), old = view.items.map(e => e.dataset.kId).join(" ");
    const colMoved = cs && cs !== view.cols.map(c => c.dataset.kId).join(" ");
    if (colMoved) add(`now ${colText(v.cols)}${v.items.length ? ` (in view: ${listed(v.items)})` : ""}`);
    else if (ids && ids !== old) add(`in view: ${listed(v.items)}`);
    view = v;
    const now = states();
    for (const [id, s] of was) {
      const n = now.get(id);
      if (!n) { if (!shown(levelBox())) continue; add(`removed ${s.name}`); continue; }
      if (n.folded !== s.folded) add(`${n.folded ? "folded" : "unfolded"} ${n.name}`);
      if (n.box !== s.box) add(`moved ${n.name} to ${n.boxName || "elsewhere"}`);
      else if (n.index !== s.index && n.index >= 0 && s.index >= 0 && Math.abs(n.index - s.index) > 0 && moved(was, now, id)) add(`moved ${n.name} to position ${n.index + 1}${n.boxName ? ` in ${n.boxName}` : ""}`);
    }
    for (const [id, n] of now) if (!was.has(id) && was.size) add(`new ${n.name}`);
    was = now;
  };
  // only the item that changed its neighbours moved (not every one it pushed along)
  const moved = (a, b, id) => {
    const order = m => [...m].filter(([, s]) => s.box === b.get(id).box && s.index >= 0).sort((x, y) => x[1].index - y[1].index).map(([k]) => k);
    const before = order(a).filter(k => b.has(k)), after = order(b).filter(k => a.has(k));
    const without = l => l.filter(k => k !== id).join(" ");
    return before.join(" ") !== after.join(" ") && without(before) === without(after);
  };

  // ---- taps on buttons and links (the bar's own buttons are the recording itself)
  const QUIET = /^(fold|unfold|remove|close)\b/i; // the sampling notes these with their result
  const onClick = e => {
    const b = e.target.closest?.("button, a, summary, [role=button]");
    if (!b || b.closest(".mb, .k-tip, .k-fx-stop")) return;
    const what = words(b.dataset.kLabel || b.dataset.tip || b.getAttribute("aria-label") || b.textContent, 50);
    if (!what || QUIET.test(what)) return;
    const item = b.closest("[data-k-id]");
    const on = item && item !== b && ITEMS.test(item.dataset.kKind || "") ? ` on ${named(item)}` : "";
    const self = b.dataset.kId ? ` (${b.dataset.kKind || "item"} ${b.dataset.kId})` : "";
    add(`tapped '${what}'${self}${on}`);
  };
  document.addEventListener("click", onClick, true);
  const timer = setInterval(() => { try { sample(); } catch (err) { console.warn("recording context:", err); } }, 400);

  const end = () => { clearInterval(timer); clearTimeout(snapTimer); document.removeEventListener("click", onClick, true); };
  return {
    async stop() {
      try { sample(); } catch { /* keep what we have */ }
      end();
      await snap("end");
      const ms = at();
      // the whole thing stays under the budget: drop the middle snapshots first
      while (snaps.length > 1 && JSON.stringify({ events, snaps }).length > BUDGET) snaps.splice(snaps.length > 2 ? 1 : 0, 1);
      return { v: 1, ms, events, snaps };
    },
    cancel: end,
  };
}
