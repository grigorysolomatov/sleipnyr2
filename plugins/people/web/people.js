// People: chat with other people's Sleipnyr instances (trial). A list of the
// configured people; each opens a conversation drawn like a chat thread
// (name + time per message, oldest at the top). The shared bar sends text,
// voice and files to the open person. No agent takes part: there is no
// embedded agent chat here, and the messages carry no data-k-id, so the
// agent's view tools cannot read them.
// Mounted by the shell's levels: mount(box, ctx), /m/people[/<person id>].
import { render } from "/web/text.js";

const BACK = "‹";
const IMAGE = /^image\//;
const RETRY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';

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
const when = t => {
  const d = new Date(Number(t)), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
};

/** What a message's status line says (out messages only); "" = delivered.
 *  behind = an earlier message to this person is still waiting (order is kept). */
export function statusOf(m, peerName, behind = false) {
  const d = m.data;
  if (d.dir !== "out" || d.state === "sent") return "";
  if (d.state === "failed") return `Not delivered: ${d.error || "refused"}`;
  if (behind) return `Waiting for ${peerName}`;
  return d.tries ? `Waiting for ${peerName}, retrying (${d.error || "not reachable"})` : "Sending…";
}

export function mount(box, ctx) {
  const ME = "people";
  const st = { open: "", last: "", me: null, msgs: [], files: new Map() };
  const title = h("b", { class: "pp-title" });
  const back = h("button", { class: "pp-back", type: "button", onclick: () => (st.open ? ctx.levels.go(ME, "") : ctx.levels.up()) }, BACK);
  const body = h("div", { class: "pp-body" });
  box.append(h("header", { class: "pp-bar" }, back, title), body);
  const peer = () => st.me?.peers.find(p => p.id === st.open);

  function fileEl(id) {
    const wrap = h("div", { class: "c-file" });
    const draw = ({ mime = "", name = "file" } = {}) => {
      const url = ctx.fileUrl(id);
      wrap.replaceChildren(/^audio\//.test(mime)
        ? h("div", { class: "c-voice" }, h("audio", { controls: true, preload: "metadata", src: url, controlslist: "nodownload noplaybackrate noremoteplayback" }))
        : IMAGE.test(mime)
          ? h("a", { href: url, target: "_blank" }, h("img", { class: "c-img", src: url, alt: name, loading: "lazy" }))
          : h("a", { class: "c-fchip", href: url, target: "_blank", download: name, "data-tip": `Open ${name}` }, h("span", {}, name)));
    };
    if (st.files.has(id)) draw(st.files.get(id));
    else ctx.api(`/k/items/${encodeURIComponent(id)}`).then(it => { st.files.set(id, it.data); draw(it.data); }, () => draw());
    return wrap;
  }

  function messageEl(m, name, behind) {
    const d = m.data, out = d.dir === "out";
    const el = h("article", { class: `c-msg pp-msg ${out ? "user" : "pp-in"}`, "data-id": m.id });
    el.append(h("header", { class: "c-who" }, h("b", {}, d.name), h("time", {}, when(d.sent))));
    for (const f of d.files || []) el.append(fileEl(f));
    if (d.voice) el.append(h("div", { class: "c-voice" }, h("audio", { controls: true, preload: "metadata", src: ctx.fileUrl(d.voice), controlslist: "nodownload noplaybackrate noremoteplayback" })));
    if (d.text) el.append(h("div", { class: "c-text" }, render(d.text)));
    const s = statusOf(m, name, behind);
    if (s) el.append(h("p", { class: "pp-state" + (d.state === "failed" ? " bad" : "") }, h("span", {}, s),
      !behind && h("button", { class: "pp-retry", type: "button", "data-tip": "Try to deliver now", "aria-label": "Try to deliver now",
        onclick: () => ctx.api(`/p/people/peers/${encodeURIComponent(d.peer)}/retry`, { json: {} }).catch(e => ctx.bar.say(e.message, true)) }, svg(RETRY))));
    return el;
  }

  function drawList() {
    title.textContent = "People";
    back.dataset.tip = "All modalities"; back.setAttribute("aria-label", "All modalities");
    const me = st.me;
    if (!me) { body.replaceChildren(h("p", { class: "pp-note" }, "Loading…")); return; }
    const rows = me.peers.map(p => h("li", {}, h("a", { href: `/m/${ME}/${p.id}`, class: p.id === st.last ? "here" : null, "data-tip": `Chat with ${p.name}`,
      onclick: e => { e.preventDefault(); ctx.levels.go(ME, p.id); } },
      h("span", { class: "pp-row" }, h("b", {}, p.name), h("small", {}, p.last ? (p.last.dir === "out" ? "You: " : "") + p.last.text.replace(/\s+/g, " ").slice(0, 80) : "No messages yet")),
      h("time", {}, p.waiting ? `${p.waiting} waiting` : p.last ? when(p.last.sent) : ""))));
    body.replaceChildren(
      rows.length ? h("ul", { class: "pp-list", role: "list" }, rows)
        : h("p", { class: "pp-note" }, me.key
          ? "No people yet. Add one under plugins.people.peers in the config (docs/PEERS.md)."
          : "Not set up yet: this instance needs a people key and a peer (docs/PEERS.md)."),
      h("p", { class: "pp-note pp-private" }, "Private: no agent reads or answers these conversations."));
  }

  let log = null;
  function drawThread() {
    if (!st.me) { title.textContent = ""; body.replaceChildren(h("p", { class: "pp-note" }, "Loading…")); return; }
    const p = peer();
    if (!p) { drawList(); return; } // not (or no longer) in the config
    title.textContent = p.name;
    back.dataset.tip = "All people"; back.setAttribute("aria-label", "All people");
    const atEnd = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const keep = log?.scrollTop;
    let waiting = false; // only the first undelivered message gets the retry button
    const els = st.msgs.map(m => {
      const el = messageEl(m, p.name, waiting);
      if (m.data.dir === "out" && m.data.state !== "sent") waiting = true;
      return el;
    });
    log = h("div", { class: "c-log pp-log" }, els.length ? els
      : h("p", { class: "c-hello" }, `Say hello to ${p.name}.`));
    body.replaceChildren(log);
    requestAnimationFrame(() => { log.scrollTop = atEnd ? log.scrollHeight : keep; });
  }
  const draw = () => (st.open ? drawThread() : drawList());

  async function loadMe() { st.me = await ctx.api("/p/people/me"); }
  async function loadThread() { st.msgs = st.open ? await ctx.api(`/p/people/peers/${encodeURIComponent(st.open)}/messages`) : []; }

  ctx.bar.offer({ id: ME, label: () => peer()?.name || "People", shown: () => !!box.getClientRects().length,
    placeholder: () => (peer() ? `Message ${peer().name}` : "Open a person first"),
    send: async b => {
      if (!st.open) throw new Error("open a person first");
      const m = await ctx.api(`/p/people/peers/${encodeURIComponent(st.open)}/messages`, { json: { text: b.text, files: b.files, voice: b.voice } });
      try { if (!st.msgs.some(x => x.id === m.id)) { st.msgs.push(m); drawThread(); } } catch (e) { console.error(e); } // sent: a drawing error must not look unsent
    } });

  ctx.levels.onChange(async (level, sub) => {
    if (level !== ME) return;
    st.open = sub || ""; if (st.open) st.last = st.open;
    log = null;
    ctx.bar.focus(ME);
    draw();
    try { await loadMe(); await loadThread(); } catch (e) { ctx.bar.say(e.message, true); }
    draw(); ctx.bar.refresh();
  });

  let pending = null; // one list refresh at a time
  ctx.on("item", ({ item }) => {
    if (item.type !== "peer-message") return;
    if (item.data.peer === st.open) {
      const i = st.msgs.findIndex(m => m.id === item.id);
      if (i >= 0) st.msgs[i] = item; else st.msgs.push(item);
      st.msgs.sort((a, b) => a.data.sent - b.data.sent || a.created - b.created);
    }
    if (!pending) pending = setTimeout(() => { pending = null; loadMe().then(draw, () => {}); }, 150);
    if (item.data.peer === st.open) drawThread();
  });
  draw();
}
