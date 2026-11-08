// Chat UI: thread list (newest first) + one open thread. Two views, each a
// target of the shell's modality bar (ctx.bar, the Human Context Protocol):
// input in the thread goes to that thread; input in the list goes to the
// list's own history thread (one, reused, never listed) with what the list
// shows and the commands it takes. The reply is a short answer plus "@name
// args" lines the list runs (open, rename, hide, unhide). A strip between
// the list and the bar shows that conversation: collapsed, one line (the
// last answer or the working spinner); tapped, the whole conversation.
// PC: list and thread side by side (the bar defaults to the thread). Phone:
// one at a time (‹ goes back); the bar talks to the view on screen.
// Plain JavaScript (no conversion step), so the chat loads even if a
// TypeScript file elsewhere breaks.
import { render } from "/web/text.js";
import { ONE_SENTENCE, runs } from "/web/hcp.js";
import { BACK_SVG } from "/web/head.js";

const API = "/p/chat";
const IMAGE = /^image\//;
const DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const LIST = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>';
const UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const FULL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
const STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/></svg>';
// a turn still to come or running: a reply waiting or working, or a voice message being heard
const busyIn = msgs => [...msgs.values()].some(m => m.data.role === "agent" ? ["queued", "working"].includes(m.data.status) : m.data.status === "transcribing");
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const FILE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const svg = s => { const t = document.createElement("template"); t.innerHTML = s; return t.content.firstChild; };
const fileSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

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

// Working time since the reply was queued: "8s", "1m 05s", "1h 02m".
const elapsed = t => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(/^\d+$/.test(t) ? Number(t) : t).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
setInterval(() => { for (const e of document.querySelectorAll(".c-el")) e.textContent = elapsed(e.dataset.t); }, 1000);

// Chrome's recorded WebM has no duration header, so the player shows
// Infinity and the slider jumps. Seek far past the end once: the browser
// then learns the real length; jump back to the start.
function fixDuration(a) {
  a.addEventListener("loadedmetadata", () => {
    if (a.duration !== Infinity && !Number.isNaN(a.duration)) return;
    a.dataset.fixing = ""; // media actions wait until the length is known and the jump back done
    const back = () => { a.removeEventListener("durationchange", back); a.currentTime = 0; delete a.dataset.fixing; };
    a.addEventListener("durationchange", back);
    a.currentTime = 1e101;
  }, { once: true });
  return a;
}

// A voice player with no download and no ⋮ menu: only play and the slider.
function voiceEl(url) {
  const a = fixDuration(h("audio", { controls: true, preload: "metadata", src: url, controlslist: "nodownload noplaybackrate noremoteplayback" }));
  a.disableRemotePlayback = true;
  return h("div", { class: "c-voice" }, a);
}

// Streaming replies: text that just arrived fades in instead of popping.
// Each redraw wraps the still-fading pieces in spans whose negative
// animation delay continues the fade where it was.
const FADE_MS = 500;
function fadeNew(box, f) {
  const now = performance.now(), len = box.textContent.length;
  if (len > f.len) f.segs.push([f.len, now]);
  f.len = len;
  f.segs = f.segs.filter(s => now - s[1] < FADE_MS);
  if (!f.segs.length) return;
  const cuts = f.segs.map((s, i) => [s[0], f.segs[i + 1]?.[0] ?? len, now - s[1]]);
  const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT), nodes = [];
  for (let n; (n = walk.nextNode());) nodes.push(n);
  let pos = 0;
  for (const n of nodes) {
    const s0 = pos, e0 = pos + n.data.length, parts = [];
    pos = e0;
    let at = s0;
    for (const [a, b, age] of cuts) {
      const x = Math.max(a, s0), y = Math.min(b, e0);
      if (x >= y) continue;
      if (x > at) parts.push([at, x, -1]);
      parts.push([x, y, age]); at = y;
    }
    if (!parts.length) continue;
    if (at < e0) parts.push([at, e0, -1]);
    n.replaceWith(...parts.map(([x, y, age]) => {
      const t = n.data.slice(x - s0, y - s0);
      return age < 0 ? t : h("span", { class: "c-new", style: `animation-delay:-${Math.round(age)}ms` }, t);
    }));
  }
}

export async function mount(root, ctx) {
  // lost conversations (each part behind an app.features switch, default on)
  const feat = name => (ctx.feature ? ctx.feature(name) : true);
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
  const PILLS_KEY = "sleipnyr2.pills", PLACES_KEY = "sleipnyr2.places", LAST_KEY = "sleipnyr2.lastConversation";
  const FIN = ["done", "error", "stopped", "cancelled"];
  const pills = new Map([].concat(lsGet(PILLS_KEY, [])).filter(p => p?.id && Date.now() - p.at < 864e5).slice(-10).map(p => [p.id, p]));
  const places = lsGet(PLACES_KEY, {}) || {}; // view -> {level, sub, name}: where its embedded chat was last shown
  let pill = null;
  const who = ctx.user?.name || "the user", agentName = ctx.app?.agentName || "the agent";
  // A message file: audio plays inline (like a voice message), images show,
  // anything else is a file chip (symbol, name, size) that opens the file.
  // The type comes from the file item (cached).
  const fileInfo = new Map(); // file id -> {mime, name, size}
  function fileEl(id) {
    const box = h("div", { class: "c-file" });
    const draw = ({ mime = "", name = "file", size } = {}) => {
      const url = ctx.fileUrl(id);
      box.replaceChildren(/^audio\//.test(mime)
        ? voiceEl(url)
        : IMAGE.test(mime) || !mime
          ? h("a", { href: url, target: "_blank" }, h("img", { class: "c-img", src: url, alt: "attached image", loading: "lazy" }))
          : h("a", { class: "c-fchip", href: url, target: "_blank", download: name, "data-tip": `Open ${name}` },
            svg(FILE), h("span", {}, name), size != null ? h("small", {}, fileSize(size)) : null));
    };
    if (fileInfo.has(id)) draw(fileInfo.get(id));
    else ctx.api(`/k/items/${encodeURIComponent(id)}`).then(it => {
      const info = { mime: it.data.mime || "", name: it.data.name || "file", size: it.data.size };
      fileInfo.set(id, info); draw(info);
    }, () => draw());
    return box;
  }

  const st = {
    threads: [], open: "", msgs: new Map(), // id -> message item (open thread)
    live: new Map(), // reply id -> {text, progress} streamed but not yet saved
    steps: new Map(), // reply id -> {cur, prev, at}: step line text, for the crossfade
    fades: new Map(), // reply id -> {len, segs:[[from, t]]} streamed text still fading in
    agentNames: new Map(), // agent id -> display name
    hist: null, // the thread the embedded chat shows: the view's history thread (item, made on first use) or, from the threads menu, any other thread
    viewThread: null, altView: "", // the view's own history thread, and the view the strip was last pinned for
    histLast: null, // its latest {user, reply} messages, for the strip's one line
    histMsgs: new Map(), // id -> message item of that thread, for the expanded strip
    histLive: new Map(), // reply id -> {progress} streamed for it, for the strip's line
    histFresh: new Set(), // reply ids the strip already highlighted
    stripHooks: new Set(), // extensions: fn(threadId) after the strip is pinned to a thread
    marks: new Map(), // thread id -> {reason, color}, while the agent highlights it (action chat_highlight)
    fxMarks: new Map(), // "id:part" -> {id, part, style, color, reason}, while the agent marks it (action chat_mark)
  };

  // ------------------------------------------------------------ layout
  const list = h("ul", { class: "c-threads", role: "list" });
  // The embedded chat: the list's conversation, pinned between the list and
  // the bar. Collapsed: ONE line, the last answer (or the spinner) and the
  // tools (extensions' buttons, e.g. next thread), right under the thumb.
  // Open: a header (chevron, title, full thread, the same tools) over the
  // whole conversation. Drag the line or the header to any height; a tap
  // opens / folds.
  const stripLine = h("button", { class: "c-strip-line", type: "button",
    "data-tip": "The last answer here. Tap for the whole conversation", onclick: () => { if (!dragged()) openStrip(true); } });
  const stripMsgs = h("div", { class: "c-strip-msgs" });
  const stripLog = h("div", { class: "c-strip-log", role: "log", "aria-live": "polite" }, stripMsgs);
  const fold = h("button", { class: "c-btn c-ic c-strip-fold", type: "button", "aria-expanded": "false", "data-tip": "Unfold", "aria-label": "Unfold",
    onclick: () => openStrip(!strip.classList.contains("open")) }, svg(DOWN));
  // threads menu (list icon, right side): this view's conversation, its earlier ones, recent threads
  const tmBtn = h("button", { class: "c-btn c-ic c-tm-btn", type: "button", "aria-haspopup": "menu", "data-tip": "Threads", "aria-label": "Threads",
    onclick: () => (tm.hidden ? openMenu() : closeMenu()) }, svg(LIST));
  const tm = h("div", { class: "c-tm", role: "menu", "aria-label": "Threads for this view", hidden: true });
  const stripTools = h("span", { class: "c-strip-tools" }); // moves between the line and the header
  const stripName = h("b", {}, "Thread list conversation");
  const stripHead = h("div", { class: "c-strip-head", "data-tip": "Embedded chat: drag to resize, tap to fold or unfold" },
    h("span", { class: "c-strip-grip", "aria-hidden": "true" }), fold,
    stripName, tmBtn,
    h("button", { class: "c-btn c-ic", type: "button", "data-tip": "Open as a full thread", "aria-label": "Open as a full thread",
      onclick: () => { if (st.hist) openThread(st.hist.id, true); } }, svg(FULL)));
  // stop: only while a turn of this conversation runs or waits (the running one stops first)
  const stripStop = h("button", { class: "c-btn c-ic c-stop", type: "button", hidden: true, "data-tip": `Stop ${agentName}`, "aria-label": `Stop ${agentName}`,
    onclick: () => { if (st.hist) stopTurn(st.hist.id); } }, svg(STOP));
  const stripRow = h("div", { class: "c-strip-row" }, stripLine, stripStop, stripTools);
  const strip = h("section", { class: "c-strip", hidden: true, "aria-label": "Embedded chat" }, stripHead, stripLog, stripRow, tm);
  const side = h("nav", { class: "c-side" },
    h("header", { class: "c-bar" },
      ctx.levels?.up ? h("button", { class: "c-btn k-back c-up", type: "button", "data-tip": "All modalities", "aria-label": "All modalities",
        onclick: () => ctx.levels.up() }, svg(BACK_SVG)) : null,
      h("b", { class: "c-app" }, ctx.app.shortName),
      h("button", { class: "c-btn c-ic c-add", type: "button", "data-tip": "New thread (Alt+N)", "aria-label": "New thread",
        onclick: () => newThread() }, svg(PLUS))),
    list, strip);
  const title = h("h1", { class: "c-title", title: "Tap to rename", onclick: () => renameOpen() });
  const back = h("button", { class: "c-btn k-back c-back", type: "button", "data-tip": "Threads (Alt+T)", "aria-label": "Threads", onclick: () => showList() }, svg(BACK_SVG));
  const log = h("div", { class: "c-log", role: "log", "aria-live": "polite" });
  const bar = h("header", { class: "c-bar" }, back, title);
  // "Jump to latest": shows while the scroller is more than a screen above its end
  function jumper(scroller, endOf, host) {
    const btn = h("button", { class: "c-btn c-ic c-jump", type: "button", hidden: true, "data-tip": "Jump to latest", "aria-label": "Jump to latest",
      onclick: () => scroller.scrollTo({ top: endOf(), behavior: "smooth" }) }, svg(DOWN));
    const sync = () => { btn.hidden = !(endOf() - scroller.scrollTop > scroller.clientHeight); };
    scroller.addEventListener("scroll", sync, { passive: true });
    new ResizeObserver(sync).observe(scroller);
    host.append(btn);
    return sync;
  }
  const main = h("section", { class: "c-main" }, bar, log);
  const mb = ctx.bar, form = mb.el; // the shell's modality bar (form kept for extensions)
  const syncJump = jumper(log, () => logEnd(), main);
  const syncStripJump = jumper(stripLog, () => Math.max(0, stripLog.scrollHeight - stripLog.clientHeight), strip);
  const shell = h("div", { class: "c-shell" }, side, main);
  root.append(shell);

  // ------------------------------------------------------------ threads
  const say = (text, isError) => mb.say(text, isError);

  function drawThreads() {
    list.replaceChildren(...st.threads.map(t => h("li", {},
      h("a", { href: ctx.address(t.id), "data-id": t.id, "data-k-id": t.id, "data-k-kind": "thread", class: [t.id === (st.cursor ?? st.open) ? "here" : "", st.marks.has(t.id) ? "marked" : "", t.data.unread ? "unread" : ""].join(" ").trim(),
        "aria-current": t.id === st.open ? "page" : false, "data-tip": st.marks.get(t.id)?.reason || null,
        style: st.marks.get(t.id)?.color ? `--mark: ${st.marks.get(t.id).color}` : null,
        onclick: e => { e.preventDefault(); openThread(t.id, true); } },
        h("span", { class: "c-t" }, t.data.title || "New thread"),
        h("time", {}, when(t.updated))))));
    if (!st.threads.length) list.append(h("li", { class: "c-empty" }, "No threads yet."));
    for (const a of list.querySelectorAll("a[data-id]")) markTips(a, a.dataset.id);
  }

  async function loadAgents() {
    try { for (const a of await ctx.api(`${API}/agents`)) st.agentNames.set(a.id, a.name); } catch { /* names fall back to ids */ }
  }

  const threadOf = id => st.threads.find(x => x.id === id) || (st.hist?.id === id ? st.hist : null);

  function author(d) {
    if (d.notice) return "Notice";
    if (d.role === "user") return ctx.user?.name || "You";
    const t = threadOf(d.thread);
    const id = t?.data.agent || "";
    return st.agentNames.get(id) || id || "Agent";
  }

  // A manual rename: the server then stops renaming this thread automatically.
  async function renameOpen() {
    const t = threadOf(st.open);
    if (!t || t.data.view) return;
    const name = prompt("Rename thread", t.data.title || "");
    if (name === null || !name.trim() || name.trim() === t.data.title) return;
    try { await ctx.api(`${API}/threads/${encodeURIComponent(t.id)}`, { method: "PATCH", json: { title: name } }); }
    catch (e) { say(`Could not rename: ${e.message}`, true); }
  }

  async function loadThreads() { st.threads = await ctx.api(`${API}/threads`); drawThreads(); }

  async function newThread() {
    const t = await ctx.api(`${API}/threads`, { json: {} });
    // the live event for this thread can land before the POST returns: add it once
    st.threads = [t, ...st.threads.filter(x => x.id !== t.id)];
    await openThread(t.id, true);
  }

  async function openThread(id, push) {
    st.animate = false; setTimeout(() => { st.animate = true; }, 600);
    st.open = id; st.live.clear(); st.fades.clear(); st.steps.clear(); setLast(id);
    if (push) ctx.go(id);
    const t = threadOf(id);
    title.textContent = t ? t.data.title : "";
    if (t?.data.unread) markRead(id);
    shell.classList.add("thread-open");
    mb.focus("thread"); // opening a thread: the bar talks to it
    drawThreads();
    const msgs = await ctx.api(`${API}/threads/${encodeURIComponent(id)}/messages`);
    if (st.open !== id) return;
    st.msgs = new Map(msgs.map(m => [m.id, m]));
    drawLog(true);
  }

  // a thread with news nobody asked for (a notice's reply) is bold in the list until opened
  function markRead(id) {
    ctx.api(`${API}/threads/${encodeURIComponent(id)}`, { method: "PATCH", json: { read: true } }).catch(() => { /* stays bold */ });
  }

  // back to the list: the address follows, so a reload or the browser's back stays where you are
  function showList(push = true) {
    if (push && ctx.route()) history.pushState({}, "", "/");
    shell.classList.remove("thread-open"); mb.focus("threads"); mb.refresh();
  }

  // ------------------------------------------------------------ messages
  // The log's end where its messages rest. A message still rising sits lower
  // (transform) and would count as scroll space; scrolling to scrollHeight
  // then follows it down and cancels the rise.
  function logEnd() {
    const last = log.lastElementChild;
    if (!last) return 0;
    const end = last.offsetTop - log.offsetTop + last.offsetHeight + parseFloat(getComputedStyle(log).paddingBottom);
    return Math.max(0, Math.min(log.scrollHeight, end) - log.clientHeight);
  }
  const nearBottom = () => logEnd() - log.scrollTop < 80;
  // A redraw builds a message anew; a player that has started (playing, paused
  // mid-way) moves into the new copy so sound and position carry on.
  function keepPlayers(old, el) {
    if (!old) return;
    const was = [...old.querySelectorAll("audio")].filter(a => a.currentTime > 0 || !a.paused);
    if (!was.length) return;
    const now = [...el.querySelectorAll("audio")];
    for (const a of was) { const n = now.find(x => x.src === a.src); if (n) { n.replaceWith(a); now.splice(now.indexOf(n), 1); } }
  }

  function drawLog(toBottom) {
    const stick = toBottom || nearBottom();
    const olds = new Map([...log.querySelectorAll(".c-msg")].map(e => [e.id, e]));
    log.replaceChildren(...[...st.msgs.values()].filter(m => !heldBack(m)).map(m => { const el = messageEl(m); keepPlayers(olds.get(m.id), el); return el; }));
    if (!st.msgs.size) log.append(h("p", { class: "c-hello" }, st.open ? "New thread. Write, talk or paste a screenshot." : "Pick a thread or start a new one."));
    if (stick) log.scrollTop = logEnd();
    syncJump();
    for (const fn of drawHooks) try { fn(st.open); } catch (e) { console.error(e); }
  }
  const drawHooks = new Set(); // extensions redrawing their part of the log (host.onDraw)

  // The step line is rebuilt on every redraw: remember what it showed last and
  // when it changed, so the old text fades out and the new one in. Negative
  // animation delays continue the fade where a redraw interrupted it.
  const FADE_MS = 220;
  function stepEl(id, what) {
    const box = h("span", { class: "c-step" });
    let s = st.steps.get(id);
    if (!s) st.steps.set(id, s = { cur: what, prev: "", at: 0 });
    if (s.cur !== what) { s.prev = s.cur; s.cur = what; s.at = Date.now(); }
    const age = Date.now() - s.at;
    const fading = s.prev && age < FADE_MS && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (fading) box.append(h("span", { class: "c-step-t c-step-out", style: `animation-delay:-${age}ms` }, s.prev));
    box.append(h("span", { class: "c-step-t" + (fading ? " c-step-in" : ""), style: fading ? `animation-delay:-${age}ms` : "" }, what));
    return box;
  }

  function messageEl(m) {
    const d = m.data, live = st.live.get(m.id);
    const el = h("article", { class: `c-msg ${d.role}${d.notice ? " notice" : ""}`, id: m.id, "data-id": m.id, "data-k-id": m.id, "data-k-kind": `${d.role} message` });
    el.append(h("header", { class: "c-who" }, h("b", {}, author(d)), h("time", {}, when(m.created)),
      d.from ? h("small", { class: "c-from", "data-tip": "Sent with what that view showed" }, `from the ${d.from}`) : null));
    for (const f of d.files || []) el.append(fileEl(f));
    if (d.voice) {
      el.append(voiceEl(ctx.fileUrl(d.voice)));
      if (d.transcript !== undefined) el.append(h("p", { class: "c-transcript" }, d.transcript || "(no speech recognised)"));
    }
    // a notice (posted by a local service, e.g. a finished Kanban card) shows its one line; the agent got the full text
    const text = d.notice ? d.notice : d.role === "agent" && live && live.text.length > (d.text || "").length ? live.text : d.text;
    if (text) {
      const box = h("div", { class: "c-text" }, render(text));
      el.append(box);
      if (d.role === "agent" && live && !st.fades.has(m.id)) st.fades.set(m.id, { len: d.text ? box.textContent.length : 0, segs: [] });
      const f = d.role === "agent" && st.fades.get(m.id);
      if (f) { try { fadeNew(box, f); } catch { /* fade is cosmetic */ } if (!live && !f.segs.length) st.fades.delete(m.id); }
    }
    const working = ["queued", "working", "transcribing"].includes(d.status);
    if (working) {
      const what = d.status === "transcribing" ? "transcribing…" : live?.progress || (d.status === "queued" ? "waiting…" : "working…");
      el.append(h("p", { class: "c-working", role: "status" }, h("span", { class: "c-spin", "aria-hidden": "true" }), stepEl(m.id, what), h("span", { class: "c-el", "data-t": m.created }, elapsed(m.created)),
        h("button", { class: "c-btn c-ic c-stop", type: "button", "data-tip": `Stop ${agentName}`, "aria-label": `Stop ${agentName}`, onclick: () => stopTurn(d.thread, m.id) }, svg(STOP))));
    }
    if (d.status === "error") el.append(h("p", { class: "c-error", role: "alert" }, h("b", {}, "! "), d.error || "failed"));
    // stopped by the user: quiet notes, never an error
    if (d.status === "stopped" && !d.skipped) el.append(h("p", { class: "c-quiet" }, "stopped"));
    if (d.status === "cancelled") el.append(h("p", { class: "c-quiet" }, "cancelled, not sent"));
    if (d.role === "user" && d.steered) el.append(h("p", { class: "c-quiet" }, "added to the answer already running"));
    if (d.role === "agent" && (d.skipped || d.steered)) el.hidden = true; // no reply of its own
    if (d.calls?.length) el.append(h("ul", { class: "c-calls", "data-tip": "What the agent did on screen (declared actions)" },
      d.calls.map(c => h("li", {}, `⚡ ${c.text}`))));
    markTips(el, m.id);
    return el;
  }

  // While a voice message is still transcribing, the reply that only waits
  // for it stays out of the log; it slides in once the transcript is there.
  // After the transcript lands it waits a little longer: the message grows,
  // then a short pause, and only then does the reply's working line appear.
  function heldBack(m) {
    if (m.data.role === "agent" && performance.now() < (st.holdUntil || 0) && !document.getElementById(m.id)) return true;
    return m.data.role === "agent" && m.data.status === "queued" && !st.live.get(m.id)?.progress
      && [...st.msgs.values()].some(u => u.data.role === "user" && u.data.status === "transcribing");
  }

  // Transcript landed: the status line gives way to the text. Instead of a
  // jump, the message grows from its old height to the new one while the
  // status line fades out and the transcript fades in. Returns a starter to
  // call once `el` is in the DOM, or null when there is nothing to animate.
  const GROW_MS = 320, PAUSE_MS = 350; // pause = the gap between user glide and reply glide (900 - 550 ms)
  function growFrom(old, el) {
    // a redraw that lands mid-grow carries on from the current height and fade
    const going = old.classList.contains("c-grow"), line = old.querySelector(going ? ".c-ghost" : ".c-working"), text = el.querySelector(".c-transcript");
    if (!line || !text || el.querySelector(".c-working") || matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
    const h0 = going ? old.getBoundingClientRect().height : old.offsetHeight, ghost = line.cloneNode(true);
    const t0 = going ? +old.dataset.grow : Date.now(), age = Date.now() - t0;
    el.dataset.grow = t0;
    ghost.classList.add("c-ghost"); ghost.removeAttribute("role");
    if (!going) ghost.style.top = line.offsetTop + "px";
    ghost.style.animationDelay = `-${age}ms`;
    text.classList.add("c-new"); text.style.animationDelay = `-${age}ms`;
    return stick => {
      try {
        const h1 = el.offsetHeight;
        if (Math.abs(h1 - h0) < 1) return;
        el.classList.add("c-grow"); el.style.height = h0 + "px"; el.append(ghost);
        void el.offsetHeight;
        el.style.height = h1 + "px";
        const done = () => { el.classList.remove("c-grow"); el.style.height = ""; ghost.remove(); };
        el.addEventListener("transitionend", e => { if (e.target === el) done(); }, { once: true });
        setTimeout(done, GROW_MS + 150);
        if (stick) { const t0 = performance.now(), follow = () => { log.scrollTop = logEnd(); if (performance.now() - t0 < GROW_MS + 60) requestAnimationFrame(follow); }; follow(); }
      } catch { /* cosmetic */ }
    };
  }

  // A new message rises from under the modality bar, also in a short thread
  // where nothing scrolls: it starts at the log's bottom edge (--rise), and
  // the messages it pushes up glide from where they were instead of jumping.
  const tops = () => new Map([...log.children].filter(s => s.offsetParent && !s.getAnimations().some(x => x.playState === "running")).map(s => [s, s.getBoundingClientRect().top]));
  function liftIn(el, before) {
    try {
      log.scrollTop = logEnd();
      const top = el.offsetParent === log ? el.offsetTop : el.offsetTop - log.offsetTop;
      el.style.setProperty("--rise", Math.max(24, Math.round(log.scrollTop + log.clientHeight - top)) + "px");
      for (const [s, y] of before) {
        const d = y - s.getBoundingClientRect().top;
        if (s !== el && Math.abs(d) > 1) s.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], { duration: 550, easing: "cubic-bezier(.2, .7, .2, 1)" });
      }
    } catch { /* cosmetic */ }
  }

  function redrawMessage(id) {
    const m = st.msgs.get(id), old = document.getElementById(id);
    if (!m) return;
    if (heldBack(m)) { old?.remove(); return; }
    // a transcript just landed: let replies that were held back slide in now
    if (m.data.role === "user" && m.data.status !== "transcribing") {
      const release = () => { for (const r of st.msgs.values()) if (!document.getElementById(r.id) && r.data.role === "agent" && !heldBack(r)) redrawMessage(r.id); };
      if (old?.querySelector(".c-working:not(.c-ghost)") && m.data.transcript !== undefined) {
        const wait = matchMedia("(prefers-reduced-motion: reduce)").matches ? PAUSE_MS : GROW_MS + PAUSE_MS;
        st.holdUntil = performance.now() + wait;
        setTimeout(release, wait + 20);
      } else queueMicrotask(release);
    }
    const stick = nearBottom(), el = messageEl(m);
    // glide-in: new messages slide up; the agent's reply follows once the user's has landed.
    // A redraw mid-glide continues where it was (negative delay) instead of restarting.
    const now = performance.now();
    if (!old && st.animate && !(st.arrived ||= new Map()).has(id)) {
      const prev = [...st.arrived.values()].pop();
      st.arrived.set(id, Math.max(now, prev && now - prev < 400 ? prev + 900 : now)); // user glide (.55s) + a short pause
    }
    const t0 = st.arrived?.get(id);
    // not its turn yet: in the page but display:none (takes no space, cannot drag
    // the user's message); one timer reveals it, redraws in between keep it hidden
    if (t0 !== undefined && t0 - now > 16) {
      el.classList.add("c-wait");
      if (!(st.reveal ||= new Map()).has(id)) st.reveal.set(id, setTimeout(() => {
        const e = document.getElementById(id); if (!e) return;
        const before = tops();
        e.classList.remove("c-wait"); e.classList.add("c-arrive"); e.style.animationDelay = "0ms";
        liftIn(e, before);
      }, t0 - now));
    } else if (t0 !== undefined && now - t0 < 600) { el.classList.add("c-arrive"); el.style.animationDelay = `${Math.round(t0 - now)}ms`; }
    const rise = old?.style.getPropertyValue("--rise");
    if (rise) el.style.setProperty("--rise", rise); // a redraw mid-rise keeps its start
    const lift = !old && stick && el.classList.contains("c-arrive"), before = lift ? tops() : null;
    const grow = old ? growFrom(old, el) : null;
    keepPlayers(old, el);
    if (old) old.replaceWith(el);
    else { log.querySelector(".c-hello")?.remove(); log.append(el); }
    if (grow) grow(stick);
    if (lift) liftIn(el, before);
    else if (stick) log.scrollTo({ top: logEnd(), behavior: st.animate && !old ? "smooth" : "auto" });
  }

  // ------------------------------------------------------------ live updates
  ctx.on("item", ({ item }) => {
    if (item.type === "thread") {
      if (item.data.view) { if (item.data.view === emb.view) { st.viewThread = item; if (st.hist?.id === item.id) st.hist = item; else if (!isAlt()) pinHist(item); } } // never listed
      else {
        const i = st.threads.findIndex(t => t.id === item.id);
        if (i >= 0) st.threads.splice(i, 1);
        if (!item.data.hidden) st.threads.unshift(item); // hidden = archived: out of the list
        st.threads.sort((a, b) => b.updated - a.updated);
        drawThreads();
      }
      if (item.id === st.open) { title.textContent = item.data.title; mb.refresh();
        if (item.data.unread && shell.classList.contains("thread-open") && document.visibilityState === "visible") markRead(item.id); }
      if (st.hist?.id === item.id && !item.data.view) { st.hist = item; setStripName(); }
    } else if (item.type === "message") {
      if (pills.has(item.id)) pillUpdate(item);
      if (st.hist && item.data.thread === st.hist.id) try { histMessage(item); } catch (e) { console.error(e); }
      if (item.data.thread !== st.open) return;
      st.msgs.set(item.id, item);
      if (["done", "error", "stopped", "cancelled"].includes(item.data.status)) { st.live.delete(item.id); st.steps.delete(item.id); }
      redrawMessage(item.id);
    }
  });
  ctx.on("chat", ev => {
    if (st.hist && ev.thread === st.hist.id && ev.progress !== undefined) {
      st.histLive.set(ev.message, { progress: ev.progress });
      if (st.histLast?.reply?.id === ev.message) try { drawStripLine(); } catch (e) { console.error(e); }
    }
    if (ev.thread !== st.open) return;
    const cur = st.live.get(ev.message) || { text: st.msgs.get(ev.message)?.data.text || "", progress: "" };
    if (ev.delta) cur.text += ev.delta;
    if (ev.progress !== undefined) cur.progress = ev.progress;
    st.live.set(ev.message, cur);
    redrawMessage(ev.message);
  });
  ctx.onReconnect(() => { loadThreads(); loadHist(); if (st.open) openThread(st.open, false); });

  // ------------------------------------------------------------ bar targets
  async function ensureThread() {
    if (!st.open) await newThread();
    return st.open;
  }

  // POST /threads/:id/stop: that message's turn (none = the running one); a stopped turn keeps its partial reply
  async function stopTurn(thread, message) {
    try { await ctx.api(`${API}/threads/${encodeURIComponent(thread)}/stop`, { json: message ? { message } : {} }); }
    catch (e) { say(`Not stopped: ${e.message}`, true); }
  }

  async function post(id, body) {
    const out = await ctx.api(`${API}/threads/${encodeURIComponent(id)}/messages`, { json: body });
    pillAdd(out.reply?.id, "", id);
    if (st.open !== id) return out;
    // the server has it now: a drawing glitch must never look like "not sent" (that invites resends)
    for (const m of [out.user, out.reply]) { st.msgs.set(m.id, m); try { redrawMessage(m.id); } catch (e) { console.error(e); } }
    log.scrollTo({ top: logEnd(), behavior: "smooth" });
    return out;
  }

  // ------------------------------------------------------------ the list acts on itself
  // What the list takes from the agent: one "@name args" line per action.
  const COMMANDS = [
    ["open", "<thread id>", "open that thread on screen"],
    ["rename", "<thread id> <new title>", "rename it (counts as the user's own name)"],
    ["hide", "<thread id>", "archive it: out of the list, nothing deleted"],
    ["unhide", "<thread id>", "bring an archived thread back"],
  ];
  const short = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

  async function loadHist(view = emb.view) {
    if (isAlt() && st.altView === view) return; // showing another thread from the menu
    try { await pinHist(await ctx.api(`${API}/views/${encodeURIComponent(view)}/thread`, { method: "POST", json: {} })); }
    catch (e) { console.error(e); }
  }

  // the strip shows this thread from now on (a next thread started from the strip replaces the old one)
  let pinning = 0;
  async function pinHist(t) {
    const mine = ++pinning;
    st.hist = t;
    if (t.data.view) st.viewThread = t; else st.altView = emb.view;
    const pl = t.data.view && places[t.data.view], was = t.data.place || {};
    if (pl && (was.level !== pl.level || was.sub !== pl.sub || was.name !== pl.name)) {
      t.data.place = { ...pl };
      ctx.api(`/k/items/${encodeURIComponent(t.id)}`, { method: "PATCH", json: { place: t.data.place } }).catch(e => console.error(e));
    }
    setStripName();
    const msgs = await ctx.api(`${API}/threads/${encodeURIComponent(t.id)}/messages`);
    if (mine !== pinning) return;
    st.histMsgs = new Map(msgs.map(m => [m.id, m]));
    const reply = [...msgs].reverse().find(m => m.data.role === "agent");
    const user = reply && msgs.find(m => m.data.reply === reply.id);
    st.histLast = reply ? { user, reply } : null;
    stripMsgs.replaceChildren(); stripLog.replaceChildren(stripMsgs);
    drawStrip();
    if (strip.classList.contains("open")) stripLog.scrollTop = stripLog.scrollHeight;
    for (const fn of st.stripHooks) try { fn(t.id); } catch (e) { console.error(e); }
    retryPending();
  }

  // a thread shown in place of the view's conversation (picked in the threads menu, or a next thread of it)
  const plain = t => String(t || "").replace(/ \(until [^)]*\)$/, ""); // a retired history is titled "<name> (until <time>)"
  const isAlt = () => !!st.hist && !st.hist.data.view;
  function setStripName() {
    stripName.textContent = isAlt() ? plain(st.hist.data.title) || "Thread" : emb.title || `${emb.view} conversation`;
    tmBtn.classList.toggle("alt", isAlt());
  }

  // ------------------------------------------------------------ threads menu of the embedded chat
  const dayTime = t => { const d = new Date(Number(t)), now = new Date();
    return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : d.toLocaleDateString([], { day: "numeric", month: "short" }); };
  let menuToken = 0;
  async function openMenu() {
    const mine = ++menuToken;
    tm.hidden = false; placeMenu();
    // the view's own conversation, plus the conversations it had before a next thread replaced them (the from chain)
    let own = st.viewThread;
    if (!own || own.data.view !== emb.view) { try { own = await ctx.api(`${API}/views/${encodeURIComponent(emb.view)}/thread`, { method: "POST", json: {} }); st.viewThread = own; } catch (e) { console.error(e); } }
    const earlier = [], seen = new Set(own ? [own.id] : []);
    for (let id = own?.data.from; id && !seen.has(id) && earlier.length < 6; ) {
      seen.add(id);
      let it; try { it = await ctx.api(`/k/items/${encodeURIComponent(id)}`); } catch { break; }
      earlier.push(it); id = it.data.from;
    }
    if (mine !== menuToken || tm.hidden) return;
    const recent = st.threads.filter(t => !seen.has(t.id) && !t.data.hidden).slice(0, 8);
    const row = (t, name, what) => h("button", { class: "c-tm-row" + (st.hist?.id === t.id ? " here" : ""), type: "button", role: "menuitem", "data-id": t.id,
      "aria-current": st.hist?.id === t.id ? "true" : null, onclick: () => pickThread(t) },
      h("span", {}, name), h("small", {}, what));
    const head = text => h("div", { class: "c-tm-h" }, text);
    tm.replaceChildren(
      head("Conversations here"),
      own ? row(own, emb.title || `${emb.view} conversation`, "This view's own · " + dayTime(own.updated)) : null,
      ...earlier.map(t => row(t, `${emb.title || "Earlier conversation"} (earlier)`, "Replaced by a new thread · " + dayTime(t.updated))),
      recent.length ? head("Recent threads") : null,
      ...recent.map(t => row(t, t.data.title || "Thread", dayTime(t.updated))));
    placeMenu();
    tm.scrollTop = 0;
  }
  function closeMenu() { menuToken++; tm.hidden = true; }
  // hangs under the header; above it when the strip leaves no room below
  function placeMenu() {
    const p = strip.getBoundingClientRect(), b = stripHead.getBoundingClientRect(), vh = innerHeight - 64;
    const below = vh - b.bottom - 8, above = b.top - 8;
    const up = below < 180 && above > below;
    tm.style.maxHeight = Math.max(120, Math.min(Math.round(up ? above : below), 420)) + "px";
    tm.style.top = up ? "" : `${b.bottom - p.top + 4}px`;
    tm.style.bottom = up ? `${p.bottom - b.top + 4}px` : "";
  }
  async function pickThread(t) {
    closeMenu();
    try { await pinHist(t); if (!strip.classList.contains("open")) openStrip(true); }
    catch (e) { console.error(e); }
  }
  document.addEventListener("pointerdown", e => { if (!tm.hidden && !tm.contains(e.target) && !tmBtn.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !tm.hidden) closeMenu(); });

  // collapsed: one line, the last answer (or spinner, time and step while it works)
  function drawStripLine() {
    const { user, reply } = st.histLast || {};
    const d = reply?.data || {}, hearing = user?.data.status === "transcribing";
    const busy = (!!reply && (["queued", "working"].includes(d.status) || hearing)) || busyIn(st.histMsgs);
    const text = !reply ? ""
      : busy ? (hearing ? "transcribing…" : st.histLive.get(reply.id)?.progress || (d.status === "queued" ? "waiting…" : "working…"))
      : d.status === "error" ? `! ${d.error || "failed"}` : d.text || (d.actions?.length ? "done" : d.status === "stopped" ? "stopped" : "");
    strip.classList.toggle("busy", busy);
    stripStop.hidden = !busy;
    stripLine.classList.toggle("quiet", !reply);
    stripLine.replaceChildren(...[
      busy ? h("span", { class: "c-spin", "aria-hidden": "true" }) : null,
      busy ? h("span", { class: "c-el", "data-t": reply.created || user?.created || Date.now() }, elapsed(reply.created || user?.created || Date.now())) : null,
      h("span", { class: "c-strip-t" }, short(text, 300))].filter(Boolean));
  }

  // open: every message of the pinned thread, drawn as in a thread (no ids: the open thread owns those)
  function drawStripLog() {
    const end = stripLog.scrollHeight - stripLog.clientHeight - stripLog.scrollTop < 40;
    // as in a thread: the reply that only waits for a transcript stays out until the transcript is there
    const all = [...st.histMsgs.values()], hearing = all.some(u => u.data.role === "user" && u.data.status === "transcribing");
    const shown = all.filter(m => !(hearing && m.data.role === "agent" && m.data.status === "queued" && !st.histLive.get(m.id)?.progress));
    const olds = new Map([...stripMsgs.querySelectorAll(".c-msg")].map(e => [e.dataset.id, e]));
    stripMsgs.replaceChildren(...shown.map(m => { const el = messageEl(m); el.removeAttribute("id"); keepPlayers(olds.get(m.id), el); return el; }));
    if (end) stripLog.scrollTop = stripLog.scrollHeight;
    syncStripJump();
  }

  function drawStrip() {
    strip.hidden = !st.hist;
    drawStripLine();
    if (strip.classList.contains("open")) drawStripLog();
  }

  const STRIP_KEY = "sleipnyr2.stripHeight";
  function openStrip(on) {
    const was = strip.classList.contains("open"), h0 = strip.getBoundingClientRect().height;
    strip.classList.toggle("open", on);
    if (on) stripHead.insertBefore(stripTools, tmBtn); else stripRow.append(stripTools); // open: new thread, threads, full thread
    if (!on) closeMenu();
    const what = on ? "Fold" : "Unfold";
    fold.setAttribute("aria-expanded", String(on)); fold.dataset.tip = what; fold.setAttribute("aria-label", what);
    const saved = Number(localStorage.getItem(STRIP_KEY));
    if (on && saved && !strip.style.getPropertyValue("--strip-h")) strip.style.setProperty("--strip-h", saved + "px");
    if (on) { drawStripLog(); stripLog.scrollTop = stripLog.scrollHeight; }
    if (was !== on && !strip.classList.contains("drag")) glide(h0);
  }
  // the strip grows / shrinks from its old height to the new one (no jump)
  function glide(h0) {
    const h1 = strip.getBoundingClientRect().height;
    if (Math.abs(h1 - h0) < 2 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    strip.getAnimations().forEach(a => a.cancel());
    strip.animate([{ height: h0 + "px" }, { height: h1 + "px" }], { duration: 240, easing: "cubic-bezier(.2,.7,.3,1)" });
  }

  // drag the header (or the collapsed line) to any height; dropped near the
  // bottom it folds. A drag never also counts as a tap.
  let drag = null, dragEnd = 0;
  const dragged = () => performance.now() - dragEnd < 400;
  function dragStart(e) {
    const b = e.target.closest("button");
    if (e.button > 0 || (b && b !== stripLine)) return;
    drag = { y: e.clientY, h: strip.getBoundingClientRect().height, moved: false, id: e.pointerId };
    if (e.pointerType === "mouse") e.preventDefault(); // no text selection or native drag, which would cancel the pointer
  }
  function dragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 6) return;
    if (!drag.moved) { drag.moved = true; strip.classList.add("drag"); }
    const max = (strip.parentElement || side).getBoundingClientRect().height - 96, hgt = Math.max(stripHead.offsetHeight + 40, Math.min(max, drag.h - dy));
    strip.style.setProperty("--strip-h", Math.round(hgt) + "px");
    if (!strip.classList.contains("open")) openStrip(true);
  }
  function dragStop(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved) return;
    dragEnd = performance.now(); strip.classList.remove("drag");
    const hgt = strip.getBoundingClientRect().height;
    if (hgt < stripHead.offsetHeight + 72) { strip.style.removeProperty("--strip-h"); openStrip(false); }
    else localStorage.setItem(STRIP_KEY, String(Math.round(hgt)));
  }
  // moves are followed on the whole page: a mouse leaves the header at once
  for (const el of [stripHead, stripRow]) el.addEventListener("pointerdown", dragStart);
  strip.addEventListener("dragstart", e => e.preventDefault());
  document.addEventListener("pointermove", dragMove);
  document.addEventListener("pointerup", dragStop);
  document.addEventListener("pointercancel", dragStop);
  stripHead.addEventListener("click", e => { if (!e.target.closest("button") && !dragged()) openStrip(!strip.classList.contains("open")); });

  // a new answer the strip shows: a short pink highlight on its line
  function freshen(id) {
    if (st.histFresh.has(id)) return;
    st.histFresh.add(id);
    strip.classList.remove("fresh"); void strip.offsetWidth; strip.classList.add("fresh");
    clearTimeout(st.histFreshTimer); st.histFreshTimer = setTimeout(() => strip.classList.remove("fresh"), 2600);
  }

  function histMessage(m) {
    st.histMsgs.set(m.id, m);
    const cur = st.histLast || {};
    if (m.data.role === "user") st.histLast = { user: m, reply: cur.reply?.id === m.data.reply ? cur.reply : null };
    else if (!cur.user || !cur.user.data.reply || cur.user.data.reply === m.id) st.histLast = { user: cur.user, reply: m };
    else st.histLast = { user: null, reply: m };
    if (!st.histLast.reply) st.histLast.reply = { id: m.data.reply, data: { role: "agent", status: "queued" } };
    if (m.data.role === "agent" && ["done", "error", "stopped"].includes(m.data.status)) { st.histLive.delete(m.id); if (st.histLast.reply.id === m.id) freshen(m.id); }
    drawStrip();
    if (m.data.role === "agent" && m.data.status === "done" && m.data.actions?.length && !m.data.actionsDone) runActions(m);
  }

  // Runs a reply's actions once, on the device that asked (another device showing
  // the list does not repeat them); what happened is saved as actionsDone.
  // The device remembers what it asked (localStorage), so a reply that lands
  // while the page sleeps, reloads or shows something else still runs later:
  // when its view (and its scope, e.g. the same session) is on screen again.
  // A conditional claim on the reply keeps two pages from both running it.
  const mine = new Set(), ran = new Set(), runFor = new Map(); // reply ids this page asked for / already ran / their view's runner
  const ASKED_KEY = "sleipnyr2.asked"; // reply id -> {view, scope, t}
  const askedAll = () => { try { return JSON.parse(localStorage.getItem(ASKED_KEY) || "{}") || {}; } catch { return {}; } };
  function remember(id, view, scope) {
    const all = askedAll(), old = Date.now() - 2 * 864e5;
    for (const [k, v] of Object.entries(all)) if (!(v?.t > old)) delete all[k];
    all[id] = { view, scope, t: Date.now() };
    try { localStorage.setItem(ASKED_KEY, JSON.stringify(all)); } catch { /* private mode: this page only */ }
  }
  function forget(id) { const all = askedAll(); if (all[id]) { delete all[id]; try { localStorage.setItem(ASKED_KEY, JSON.stringify(all)); } catch { /* ignore */ } } }
  const scopeOf = e => { try { return String(e.scope?.() || ""); } catch { return ""; } };
  // a reply whose actions are still waiting: run them if their view is on screen now
  function retryPending() {
    for (const m of st.histMsgs.values())
      if (m.data.role === "agent" && m.data.status === "done" && m.data.actions?.length && !m.data.actionsDone) runActions(m);
  }
  // A reply to a notice (a local service started the turn, nobody asked on a
  // page): run it in the view whose own conversation it is, when that view is on
  // screen. A view whose thread is shared by several scopes (boards) opts in
  // with ownThread only if each scope has its own thread.
  function noticeReply(m) {
    if (isAlt() || !st.hist || st.hist.data.view !== emb.view || m.data.thread !== st.hist.id) return false;
    if (!(Number(m.created) > Date.now() - 2 * 864e5)) return false;
    if (scopeOf(emb) && !emb.ownThread) return false;
    for (const u of st.histMsgs.values()) if (u.data.reply === m.id) return !!u.data.notice;
    return false;
  }
  async function runActions(m) {
    if (ran.has(m.id)) return;
    const rec = askedAll()[m.id];
    if (!mine.has(m.id) && !rec && !noticeReply(m)) return;
    if (rec && (rec.view !== emb.view || (rec.scope || "") !== scopeOf(emb))) return; // not on screen now: later
    ran.add(m.id);
    // claim it (conditional write): only one page runs a reply
    let at = m.updated, claimed = false;
    for (let i = 0; i < 4 && !claimed; i++) {
      const r = await fetch(`/k/items/${encodeURIComponent(m.id)}`, { method: "PATCH", body: JSON.stringify({ actionsDone: ["running"] }),
        headers: { "content-type": "application/json", "x-if-updated": String(at) } }).catch(() => null);
      if (r?.ok) { claimed = true; break; }
      const cur = r?.status === 409 ? (await r.json().catch(() => ({}))).item : null;
      if (!cur || cur.data.actionsDone) break; // another page has it, or it is done
      at = cur.updated; // the reply changed in another way: claim again
    }
    forget(m.id);
    if (!claimed) return;
    const report = [], run = runFor.get(m.id) || (rec || !mine.has(m.id) ? emb.run : null); // another view's conversation: that view runs its own commands
    for (const a of m.data.actions) {
      const [id, ...rest] = a.args.split(/\s+/), arg = rest.join(" ");
      try {
        if (run) { report.push(`ok ${await run(a.name, a.args, a.body)}`); continue; }
        if (a.name === "open") {
          if (!threadOf(id) && !(await ctx.api(`/k/items/${encodeURIComponent(id)}`).catch(() => null))) throw new Error("no such thread");
          await openThread(id, true);
        } else if (a.name === "rename") await ctx.api(`${API}/threads/${encodeURIComponent(id)}`, { method: "PATCH", json: { title: arg } });
        else if (a.name === "hide" || a.name === "unhide") await ctx.api(`${API}/threads/${encodeURIComponent(id)}`, { method: "PATCH", json: { hidden: a.name === "hide" } });
        else throw new Error("unknown command");
        report.push(`ok ${a.name} ${id}`);
      } catch (e) { report.push(`failed ${a.name} ${id}: ${e.message}`); say(`List: could not ${a.name} ${id}: ${e.message}`, true); }
    }
    try { await ctx.api(`/k/items/${encodeURIComponent(m.id)}`, { method: "PATCH", json: { actionsDone: report } }); } catch { /* report only */ }
  }

  // What the thread list shows, for the agent: the threads on screen (newest first),
  // the archived ones (for unhide) and the commands the list runs.
  async function describeList() {
    const box = list.getBoundingClientRect();
    const on = [...list.querySelectorAll("a[data-id]")].filter(a => { const r = a.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; })
      .map(a => a.dataset.id);
    const shown = (on.length ? st.threads.filter(t => on.includes(t.id)) : st.threads.slice(0, 20)).slice(0, 40);
    const line = t => `- ${t.id} | ${(t.data.title || "New thread").replace(/\s+/g, " ")} | updated ${new Date(Number(t.updated)).toISOString()}`;
    let hidden = [];
    try { hidden = (await ctx.api(`${API}/threads?hidden=1`)).slice(0, 30); } catch { /* none listed */ }
    return `[Sent from the Sleipnyr thread list (${st.threads.length} threads; ${shown.length} on screen, newest first). `
      + `This chat is the list's own history; the list acts on your reply. Threads on screen (id | title | last updated):\n${shown.map(line).join("\n")}\n`
      + `Archived (hidden) threads:\n${hidden.map(line).join("\n") || "(none)"}\n`
      + `${ONE_SENTENCE}, then one line per action, exactly:\n`
      + COMMANDS.map(([n, a, d]) => `@${n} ${a}   (${d})`).join("\n")
      + `\n${runs("list")} `
      + `Selected thread: ${st.open || "(none)"}. To show something on ${who}'s screen (blink the selection or a thread, `
      + `highlight threads, unfold this reply) call the sleipnyr2 tools (chat_blink, chat_highlight, chat_reply_open) instead of a line. `
      + `Use only ids listed above. Never delete anything.]`;
  }

  const visible = el => !!el.getClientRects().length;
  mb.offer({ id: "thread", label: () => threadOf(st.open)?.data.title || "This thread",
    shown: () => !!st.open && visible(main), busy: () => !!st.open && busyIn(st.msgs),
    send: async body => { const id = await ensureThread(); return post(id, body); } });
  mb.offer({ id: "threads", label: () => "Thread list", shown: () => visible(side),
    placeholder: () => "Ask the list: open, rename, hide threads", busy: () => !!st.hist && busyIn(st.histMsgs),
    send: async body => { if (emb.view !== "threads") embedHome(); return sendView("threads", body); } });

  // ------------------------------------------------------------ the embedded chat elsewhere
  // Other levels (the modality picker, other modalities) borrow the embedded
  // chat through ctx.embed: it moves into their box and shows their own view
  // conversation (view:<name>). One at a time; the thread list takes it back
  // when its level returns.
  const HOME = { view: "threads", title: "Thread list conversation",
    from: "thread list", describe: () => describeList(), run: null };
  let emb = HOME;
  function embed(view, box, opts = {}) {
    notePlace(view, opts);
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(view)) throw new Error("bad view name");
    emb = { ...opts, view };
    closeMenu();
    if (strip.parentElement !== box || strip.nextElementSibling) box.append(strip);
    if (isAlt() && st.altView === view) { setStripName(); drawStrip(); } // a picked thread stays while this view stays
    else if (st.hist?.data.view !== view) { strip.hidden = true; st.hist = null; setStripName(); loadHist(view); } else { setStripName(); drawStrip(); }
    return { send: body => sendView(view, body), busy: () => (isAlt() ? st.altView === view : st.hist?.data.view === view) && busyIn(st.histMsgs), retry: () => retryPending() };
  }
  function embedHome() { embed("threads", side, HOME); }
  async function sendView(view, body) {
    const e = emb;
    if (e.view !== view) throw new Error("that conversation is not on screen");
    // what the view shows, plus any note the sender adds (hands-free talk: "answer briefly, spoken")
    const context = [e.describe ? await e.describe() : "", body.context || ""].filter(Boolean).join("\n\n");
    if (!(isAlt() && st.altView === view) && st.hist?.data.view !== view) await pinHist(await ctx.api(`${API}/views/${encodeURIComponent(view)}/thread`, { method: "POST", json: {} }));
    const out = await ctx.api(`${API}/threads/${encodeURIComponent(st.hist.id)}/messages`, { json: { ...body, context, from: e.from || view } });
    // the server has it: a drawing glitch must not look like "not sent"
    mine.add(out.reply.id); if (e.run) runFor.set(out.reply.id, e.run);
    remember(out.reply.id, view, scopeOf(e));
    pillAdd(out.reply.id, view, st.hist?.id);
    try { st.histLast = out; for (const m of [out.user, out.reply]) st.histMsgs.set(m.id, m); drawStrip(); } catch (err) { console.error(err); }
    return out;
  }
  ctx.levels?.onChange(level => { if (level === "chat") { embedHome(); mb.focus(st.open && visible(main) ? "thread" : "threads"); } });
  mb.focus(st.open ? "thread" : "threads");
  // several views on screen (PC): the one the bar talks to gets the "you are here" line
  // a tap inside a view (not on a thread link, which opens and focuses the thread) points the bar at it
  side.addEventListener("pointerdown", e => { if (!e.target.closest("a[data-id]")) mb.focus("threads"); });
  main.addEventListener("pointerdown", () => { if (st.open) mb.focus("thread"); });
  mb.onChange((cur, several) => {
    side.classList.toggle("mb-here", several && cur === "threads");
    main.classList.toggle("mb-here", several && cur === "thread");
  });

  // ------------------------------------------------------------ agent actions
  // What the manifest's declared actions do on this page (kernel/web/actions.js
  // relays a checked call; the stop control or a reload ends an effect).
  const fx = ctx.actions;
  // the embedded chat under every view: view_fold target "strip"
  fx?.view?.("*", {
    has: id => id === "strip" && !strip.hidden && !!st.hist,
    extra: () => !strip.hidden && st.hist ? [{ id: "strip", kind: "embedded chat", label: strip.classList.contains("open") ? "unfolded" : "folded to one line" }] : [],
    fold: (id, folded) => {
      if (id !== "strip") return false;
      if (strip.hidden || !st.hist) throw new Error("this view shows no embedded chat");
      openStrip(!folded); return `${folded ? "folded" : "unfolded"} the embedded chat`;
    },
  });
  const rowSel = id => `.c-threads a[data-id="${CSS.escape(id)}"]`;
  fx?.handle("chat", "blink", async ({ target, times, interval_ms, colours }, signal) => {
    const id = target === "selection" ? st.open : target === "list" ? null : target;
    if (target === "selection" && !id) throw new Error("no thread is selected");
    if (id && !threadOf(id)) throw new Error(`no thread ${id} in the list`);
    const sel = id ? rowSel(id) : ".c-threads";
    const look = c => id ? `${sel} { border-left-color: ${c} !important; background: var(--surface); }`
      : `${sel} { box-shadow: inset 0 0 0 2px ${c}; }`;
    const style = fx.style(), half = interval_ms / 2;
    try {
      for (let i = 0; i < times; i++) {
        style.set(look(colours[i % colours.length]));
        await fx.sleep(half, signal);
        style.set("");
        if (i < times - 1) await fx.sleep(half, signal);
      }
    } finally { style.remove(); }
    const seen = visible(side) && (!id || list.querySelector(rowSel(id)));
    return `blinked ${id ? (target === "selection" ? "the selection" : id) : "the list"} ${times}×` + (seen ? "" : " (list not on screen here)");
  });
  fx?.handle("chat", "glow", async ({ target, duration_ms, cycle_ms }, signal) => {
    const id = target === "selection" ? st.open : target === "list" ? null : target;
    if (target === "selection" && !id) throw new Error("no thread is selected");
    if (id && !threadOf(id)) throw new Error(`no thread ${id} in the list`);
    // a registered --hue turns smoothly; rows are offset by their position (a rule per row, so redraws keep it)
    const rows = id ? 1 : Math.max(list.querySelectorAll("a").length, 40);
    const rule = id ? [`${rowSel(id)}`] : Array.from({ length: rows }, (_, i) => `.c-threads li:nth-child(${i + 1}) a`);
    const css = ["@property --fx-hue { syntax: '<number>'; inherits: false; initial-value: 0; }",
      `@keyframes fx-hue { from { --fx-hue: 0; } to { --fx-hue: 360; } }`,
      ...rule.map((s, i) => `${s} { animation: fx-hue ${cycle_ms}ms linear infinite; animation-delay: -${Math.round(i * cycle_ms / 12) % cycle_ms}ms;`
        + ` border-left-color: hsl(var(--fx-hue) 100% 60%) !important; background: hsl(var(--fx-hue) 100% 60% / .14) !important;`
        + ` box-shadow: inset 0 0 0 1px hsl(var(--fx-hue) 100% 60%), 0 0 10px hsl(var(--fx-hue) 100% 60% / .5); }`)].join("\n");
    const style = fx.style();
    try { style.set(css); await fx.sleep(duration_ms, signal); } finally { style.remove(); }
    const seen = visible(side) && (!id || list.querySelector(rowSel(id)));
    return `rainbow glow on ${id ? (target === "selection" ? "the selection" : id) : "the list"} for ${Math.round(duration_ms / 1000)} s` + (seen ? "" : " (list not on screen here)");
  });
  fx?.handle("chat", "highlight", async ({ ids, reason, color, duration_ms }, signal) => {
    const known = ids.filter(id => threadOf(id));
    if (!known.length) throw new Error("none of those ids is in the list");
    if (color && !CSS.supports("color", color)) throw new Error(`not a colour: ${color}`);
    const mark = { reason: reason || "Marked by the agent", color: color || "" };
    for (const id of known) st.marks.set(id, mark);
    drawThreads();
    try { await fx.sleep(duration_ms, signal); }
    finally { for (const id of known) if (st.marks.get(id) === mark) st.marks.delete(id); drawThreads(); }
    return `highlighted ${known.length} thread${known.length > 1 ? "s" : ""}` + (known.length < ids.length ? ` (${ids.length - known.length} unknown)` : "");
  });
  fx?.handle("chat", "select", async ({ ids, step_ms, loops }, signal) => {
    const known = ids.filter(id => threadOf(id));
    if (!known.length) throw new Error("none of those ids is in the list");
    const run = Symbol(); st.cursorRun = run;
    try {
      for (let l = 0; l < loops; l++) for (const id of known) {
        if (st.cursorRun !== run) return "taken over by a later select";
        st.cursor = id; drawThreads();
        list.querySelector(`a[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
        await fx.sleep(step_ms, signal);
      }
    } finally { if (st.cursorRun === run) { st.cursor = null; drawThreads(); } }
    return `walked the selection over ${known.length} steps x ${loops}`;
  });
  // chat_mark: any part of a message (or a list row), one generic look per
  // call. All marks live in one map ("id:part" -> mark, so a later call on
  // the same target takes over) and are drawn by one effect style rebuilt
  // from it; selectors address data-id, so redraws keep them.
  const PARTS = { whole: "", voice: ".c-voice audio", time: ".c-who time", name: ".c-who b", text: ".c-text",
    transcript: ".c-transcript", attachment: ".c-file" };
  const markStyle = fx?.style();
  function markSel(k) {
    const { id, part, row } = st.fxMarks.get(k);
    if (row) return `.c-threads a[data-id="${CSS.escape(id)}"]`;
    const base = `.c-msg[data-id="${CSS.escape(id)}"]`;
    return part === "whole" ? base : `${base} ${PARTS[part]}`;
  }
  function markCss() {
    const out = [`@keyframes fx-mark-pulse { 0%, 100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 0 3px var(--fx-c), 0 0 14px var(--fx-c); } }`];
    for (const [k, mk] of st.fxMarks) {
      const c = mk.color, inset = mk.row || mk.part === "whole", off = inset ? "-2px" : "2px";
      const look = {
        frame: `outline: 2px solid ${c} !important; outline-offset: ${off};`,
        tint: `background-color: color-mix(in srgb, ${c} 24%, transparent) !important; box-shadow: 0 0 0 ${inset ? "0" : "4px"} color-mix(in srgb, ${c} 24%, transparent) !important;`,
        underline: `text-decoration: underline 2px ${c} !important; text-underline-offset: 3px; box-shadow: inset 0 -2px 0 ${c} !important;`,
        pulse: `--fx-c: ${c}; outline: 1px solid ${c} !important; outline-offset: ${off}; animation: fx-mark-pulse 1.2s ease-in-out infinite !important;`,
      }[mk.style];
      out.push(`${markSel(k)} { ${look} border-radius: var(--radius); }`);
    }
    return out.join("\n");
  }
  // the reason as tooltip on the marked part (set at each draw; attributes we set carry data-fx-tip)
  function markTips(el, id) {
    for (const mk of st.fxMarks.values()) {
      if (mk.id !== id || !mk.reason) continue;
      const part = mk.row || mk.part === "whole" ? el : el.querySelector(PARTS[mk.part]);
      if (part) { part.setAttribute("data-tip", mk.reason); part.setAttribute("data-fx-tip", ""); }
    }
  }
  function markRedraw() {
    markStyle?.set(st.fxMarks.size ? markCss() : "");
    for (const e of root.querySelectorAll("[data-fx-tip]")) { e.removeAttribute("data-fx-tip"); e.removeAttribute("data-tip"); }
    for (const e of root.querySelectorAll(".c-msg[data-id]")) markTips(e, e.dataset.id);
    drawThreads();
  }
  fx?.handle("chat", "mark", async ({ targets, part, style, color, reason, duration_ms }, signal) => {
    const c = color || "var(--accent-here)";
    if (color && (!CSS.supports("color", color) || /[;{}<>]/.test(color))) throw new Error(`not a CSS colour: ${color}`);
    const mine = new Map();
    for (const t of targets) {
      const [id, p] = t.split(":");
      const row = !!threadOf(id) && !st.msgs.has(id) && !st.histMsgs.has(id);
      mine.set(row ? `${id}:row` : `${id}:${p || part}`, { id, part: row ? "whole" : p || part, row, style, color: c, reason });
    }
    for (const [k, mk] of mine) st.fxMarks.set(k, mk);
    markRedraw();
    const seen = [...mine.keys()].filter(k => [...root.querySelectorAll(markSel(k))].some(visible)).length;
    try { await fx.sleep(duration_ms, signal); }
    finally {
      for (const [k, mk] of mine) if (st.fxMarks.get(k) === mk) st.fxMarks.delete(k);
      markRedraw();
    }
    return `${style} mark on ${mine.size} target${mine.size > 1 ? "s" : ""} for ${Math.round(duration_ms / 1000)} s`
      + (seen < mine.size ? ` (${mine.size - seen} not on screen here)` : "");
  });

  // chat_scroll: to one message (smooth) or a steady read-along scroll that
  // any touch, wheel, click or key on that area ends at once.
  const scrollRuns = new Map(); // scroller -> run token (a later call takes over)
  fx?.handle("chat", "scroll", async ({ view, to, block, direction, px_per_s, duration_ms }, signal) => {
    const box = { thread: log, list, embedded: stripLog }[view];
    if (view === "thread" && !st.open) throw new Error("no thread is open");
    if (view === "embedded" && !strip.classList.contains("open")) openStrip(true);
    const run = Symbol(); scrollRuns.set(box, run);
    if (to) {
      const el = box.querySelector(view === "list" ? `a[data-id="${CSS.escape(to)}"]` : `.c-msg[data-id="${CSS.escape(to)}"]`);
      if (!el) throw new Error(`${to} is not in the ${view === "list" ? "thread list" : view === "embedded" ? "embedded chat" : "open thread"} here`);
      const aim = () => {
        const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
        const y = r.top - b.top + box.scrollTop, fit = { start: y, end: y + r.height - box.clientHeight, center: y + r.height / 2 - box.clientHeight / 2 }[block]
          ?? (r.top < b.top ? y : r.bottom > b.bottom ? y + r.height - box.clientHeight : box.scrollTop);
        return Math.max(0, Math.min(box.scrollHeight - box.clientHeight, fit));
      };
      box.scrollTo({ top: aim(), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      await fx.sleep(700, signal);
      // images and players above load while it glides and push the target away: re-aim until it holds still
      for (let i = 0, still = 0; i < 30 && still < 3 && scrollRuns.get(box) === run; i++) {
        const want = aim();
        if (Math.abs(want - box.scrollTop) > 2) { box.scrollTop = want; still = 0; } else still++;
        await fx.sleep(100, signal);
      }
      if (scrollRuns.get(box) === run) scrollRuns.delete(box);
      return `scrolled the ${view} to ${to} (${block})` + (visible(box) ? "" : " (not on screen here)");
    }
    const sign = direction === "up" ? -1 : 1, y0 = box.scrollTop, t0 = performance.now();
    let why = "";
    const user = e => { why = `stopped by ${who} (${e.type})`; };
    const evs = ["wheel", "touchstart", "pointerdown"];
    for (const e of evs) box.addEventListener(e, user, { passive: true });
    addEventListener("keydown", user);
    try {
      await new Promise(done => {
        const step = now => {
          if (why || signal.aborted || scrollRuns.get(box) !== run) return done();
          const t = Math.min(now - t0, duration_ms), max = box.scrollHeight - box.clientHeight;
          const y = Math.max(0, Math.min(max, y0 + sign * px_per_s * t / 1000));
          box.scrollTop = y;
          if (t >= duration_ms) return done();
          if ((sign > 0 && y >= max - .5) || (sign < 0 && y <= 0)) { why = "reached the end"; return done(); }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    } finally {
      for (const e of evs) box.removeEventListener(e, user);
      removeEventListener("keydown", user);
      if (scrollRuns.get(box) === run) scrollRuns.delete(box);
    }
    if (signal.aborted) throw new Error("stopped");
    const moved = Math.round(Math.abs(box.scrollTop - y0));
    return `${scrollRuns.has(box) && !why ? "taken over by a later scroll; " : why ? why + "; " : ""}scrolled the ${view} ${direction} ${moved} px in ${((performance.now() - t0) / 1000).toFixed(1)} s`
      + (visible(box) ? "" : " (not on screen here)");
  });
  fx?.handle("chat", "reply_open", async () => {
    if (!st.hist) throw new Error("the list has no conversation yet");
    openStrip(true);
    return "unfolded the reply";
  });

  // ------------------------------------------------------------ lost conversations
  // A: a pill above the bar while a reply waits in a conversation that is not
  // on screen; tap goes there with its chat open, swipe dismisses.
  // C: ctx.conversations feeds the picker's Recent list.
  const pillT = h("span", { class: "c-pill-t" }), pillN = h("span", { class: "c-pill-n" });
  const pillS = h("span", { class: "c-pill-spin", "aria-hidden": "true" });
  let swiped = false, x0 = null;
  pill = h("button", { type: "button", class: "c-pill", hidden: true, "data-k-id": "reply-pill", "data-k-kind": "pill",
    onclick: () => { if (swiped) { swiped = false; return; } const p = pillTop(); if (p) goConversation(p); },
    onpointerdown: e => { x0 = e.clientX; try { pill.setPointerCapture(e.pointerId); } catch { /* old browsers */ } },
    onpointermove: e => { if (x0 !== null) pill.style.translate = `${e.clientX - x0}px 0`; },
    onpointerup: e => {
      const dx = x0 === null ? 0 : e.clientX - x0; x0 = null; pill.style.translate = "";
      if (Math.abs(dx) > 50) { swiped = true; const p = pillTop(); if (p) pills.delete(p.id); drawPill(); }
    },
    onpointercancel: () => { x0 = null; pill.style.translate = ""; } }, pillS, pillT, pillN);
  mb.el.append(pill);

  function placeOf(view) {
    if (places[view]) return places[view];
    const [first, ...rest] = String(view).split("-");
    const level = first === "threads" ? "chat" : first === "sessions" ? "blackboards" : first;
    const p = (ctx.plugins || []).find(x => x.id === level);
    return { level: p ? level : "chat", sub: p ? rest.join("-") : "", name: p?.modality?.title || view };
  }
  function notePlace(view, opts) {
    if (!view) return;
    const name = String(opts?.title || "").replace(/\s*conversation$/i, "").trim() || placeOf(view).name;
    places[view] = { level: ctx.levels?.current() || "chat", sub: ctx.levels?.sub?.() || "", name };
    lsSet(PLACES_KEY, places);
    if (view !== "modalities") setLast(view);
  }
  function setLast(key) { lsSet(LAST_KEY, key); }
  function placeName(p) { return p.view ? placeOf(p.view).name : (threadOf(p.thread)?.data.title || "a thread"); }
  function onScreen(p) {
    if (document.visibilityState !== "visible") return false;
    if (p.view) return emb?.view === p.view && visible(strip);
    return st.open === p.thread && shell.classList.contains("thread-open") && visible(main);
  }
  function pillTop() { return [...pills.values()].filter(p => !onScreen(p)).sort((a, b) => b.at - a.at)[0]; }
  function drawPill() {
    if (!pill) return;
    for (const [id, p] of pills) if (p.done && onScreen(p)) pills.delete(id); // seen
    lsSet(PILLS_KEY, [...pills.values()]);
    const away = [...pills.values()].filter(p => !onScreen(p)).sort((a, b) => b.at - a.at);
    if (!feat("replyPill") || !away.length) { pill.hidden = true; return; }
    const p = away[0], name = placeName(p);
    pillT.textContent = p.done ? `${agentName} replied in ${name}` : `${agentName} is working in ${name}`;
    pillS.hidden = !!p.done;
    pillN.hidden = away.length < 2; pillN.textContent = away.length < 2 ? "" : `+${away.length - 1}`;
    pill.dataset.tip = `Go to ${name} (swipe to dismiss)`;
    pill.setAttribute("aria-label", pill.dataset.tip);
    const above = visible(strip) && emb?.view ? strip.getBoundingClientRect().top : mb.el.getBoundingClientRect().top;
    pill.style.setProperty("--pill-b", `${Math.max(0, innerHeight - above) + 8}px`);
    pill.hidden = false;
  }
  function pillAdd(id, view, thread) {
    if (!id) return;
    pills.set(id, { id, view: view || "", thread: thread || "", at: Date.now(), done: false });
    drawPill();
  }
  function pillUpdate(item) {
    const p = pills.get(item?.id); if (!p) return;
    const done = FIN.includes(item.data?.status);
    if (done && !p.done) p.at = Date.now();
    p.done = done; drawPill();
  }
  async function goConversation(p) {
    if (p.id) pills.delete(p.id);
    try {
      if (!p.view) {
        if (ctx.levels && ctx.levels.current() !== "chat") await ctx.levels.go("chat");
        await openThread(p.thread, true);
      } else {
        const pl = placeOf(p.view);
        if (!(ctx.levels?.current() === pl.level && emb?.view === p.view)) await ctx.levels?.go(pl.level, pl.sub);
        if (pl.level === "chat" && shell.classList.contains("thread-open")) showList(true);
        for (let i = 0; i < 60 && !(emb?.view === p.view && st.hist); i++) await new Promise(r => setTimeout(r, 50));
        if (emb?.view === p.view && st.hist) openStrip(true);
      }
    } finally { drawPill(); }
  }
  ctx.conversations = {
    recent: async () => {
      const last = lsGet(LAST_KEY, "");
      const rows = await ctx.api(`${API}/recent`);
      return rows.filter(r => r.view !== "modalities")
        .map(r => { if (r.view && r.place && !places[r.view]) places[r.view] = r.place;
          return { ...r, name: r.view ? placeOf(r.view).name : r.title, here: (r.view || r.id) === last }; });
    },
    open: r => goConversation(r.view ? { view: r.view } : { thread: r.id }),
  };
  fx?.handle("chat", "pill_show", async ({ target }) => {
    let p = { id: `agent-${Date.now()}`, view: target, thread: "", at: Date.now(), done: true };
    try {
      const it = await ctx.api(`/k/items/${encodeURIComponent(target)}`);
      if (it?.type === "thread") p = { ...p, view: it.data.view || "", thread: it.data.view ? "" : it.id };
    } catch { /* not an item: a view name */ }
    pills.set(p.id, p); drawPill();
    if (pill.hidden) throw new Error(feat("replyPill") ? "that conversation is on screen already" : "the reply pill is switched off");
    return `the pill points at ${placeName(p)}`;
  });
  fx?.handle("chat", "pill_clear", async () => { pills.clear(); drawPill(); return "pill cleared"; });
  ctx.levels?.onChange(() => setTimeout(drawPill, 250));
  addEventListener("resize", () => drawPill());
  document.addEventListener("visibilitychange", () => drawPill());
  setInterval(() => { if (pills.size) drawPill(); }, 1000);
  for (const p of [...pills.values()]) if (!p.done && !p.id.startsWith("agent-"))
    ctx.api(`/k/items/${encodeURIComponent(p.id)}`).then(pillUpdate).catch(() => { pills.delete(p.id); drawPill(); });

  // ------------------------------------------------------------ keys + start
  addEventListener("keydown", e => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === "n") { e.preventDefault(); newThread(); }
    else if (k === "t") { e.preventDefault(); ctx.levels?.show("chat"); showList(); mb.focus("threads"); list.querySelector("a")?.focus(); }
  });
  addEventListener("popstate", () => { if (ctx.levels && ctx.levels.current() !== "chat") return; const id = ctx.route(); id ? openThread(id, false) : showList(false); });

  await loadAgents();
  await loadThreads();
  await loadHist();
  const start = ctx.route();
  if (start && threadOf(start)) await openThread(start, false);
  else drawLog(true);
  mb.refresh();

  // What extension plugins may use (the shell hands it to their extend(host, ctx)).
  return {
    el: { bar, log, form },
    // the embedded chat in the thread list: tools (buttons there, on the collapsed line and
    // in the open header), frame (positions popovers), log and pinned thread
    strip: {
      tools: stripTools, el: strip, log: stripLog,
      thread: () => st.hist,
      open: t => pinHist(t), // pin the strip to this thread (it must be the list's view thread)
      onDraw: fn => { st.stripHooks.add(fn); if (st.hist) fn(st.hist.id); return () => st.stripHooks.delete(fn); },
    },
    thread: () => st.threads.find(t => t.id === st.open) || null, // the open thread item
    open: t => { st.threads = [t, ...st.threads.filter(x => x.id !== t.id)]; return openThread(t.id, true); },
    messageEl, // a message item drawn as in the log
    embed, // embed(view, box, {title, from, describe, run, scope?, ownThread?}) -> {send}: the embedded chat in another level
    onDraw: fn => { drawHooks.add(fn); if (st.open) fn(st.open); return () => drawHooks.delete(fn); }, // after each full redraw
  };
}