// People: chat with other people's Sleipnyr instances (trial). A list of the
// configured people; each opens a conversation drawn like a chat thread
// (name + time per message, oldest at the top). The shared bar sends text,
// voice and files to the open person. No agent takes part: there is no
// embedded agent chat here, and the messages carry no data-k-id, so the
// agent's view tools cannot read them.
// Pairing: Invite (person-plus) shows a one-time code to send; Accept invite
// (ticket) takes the other person's code. Both open as popovers under their
// button. The inbox address and its reachability sit under the list.
// Mounted by the shell's levels: mount(box, ctx), /m/people[/<person id>].
import { render } from "/web/text.js";
import { backButton } from "/web/head.js";

const IMAGE = /^image\//;
const INVITE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 19.5c.6-3.3 3-5.2 6-5.2s5.4 1.9 6 5.2"/><path d="M18 8v6M15 11h6"/></svg>';
const ACCEPT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z"/><path d="M9.5 12l1.8 1.8 3.4-3.6"/></svg>';
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
  const st = { open: "", last: "", me: null, msgs: [], files: new Map(), check: null, pop: "" };
  const title = h("b", { class: "pp-title" });
  const back = backButton({ cls: "pp-back", onclick: () => (st.open ? ctx.levels.go(ME, "") : ctx.levels.up()) });
  const inviteBtn = h("button", { class: "pp-ic", type: "button", "aria-haspopup": "dialog", "data-tip": "Invite someone: a code to send them", "aria-label": "Invite someone",
    onclick: () => toggle("invite") }, svg(INVITE));
  const acceptBtn = h("button", { class: "pp-ic", type: "button", "aria-haspopup": "dialog", "data-tip": "Accept an invite code someone sent you", "aria-label": "Accept invite",
    onclick: () => toggle("accept") }, svg(ACCEPT));
  const tools = h("span", { class: "pp-tools" }, inviteBtn, acceptBtn);
  const pop = h("div", { class: "pp-pop", role: "dialog", hidden: true });
  const fill = pop.replaceChildren.bind(pop);
  pop.replaceChildren = (...kids) => fill(...kids.filter(Boolean)); // h() drops nulls, replaceChildren would print them
  const body = h("div", { class: "pp-body" });
  box.append(h("header", { class: "pp-bar" }, back, title, tools), body, pop);
  box.style.position = "relative"; // the popover is placed inside this view
  const peer = () => st.me?.peers.find(p => p.id === st.open);
  const api = (path, json) => ctx.api(`/p/people${path}`, { json: json || {} });

  // ---------------------------------------------------------------- pairing popovers (locality: under their button)
  function place(btn) {
    const b = btn.getBoundingClientRect(), r = box.getBoundingClientRect();
    pop.style.top = `${b.bottom - r.top + 4}px`;
    pop.style.right = `${Math.max(4, Math.min(r.right - b.right, r.width - pop.offsetWidth - 4))}px`;
  }
  function close() { pop.hidden = true; st.pop = ""; pop.replaceChildren(); }
  function toggle(which) {
    if (!pop.hidden && st.pop === which) { close(); return; }
    st.pop = which; pop.hidden = false;
    (which === "invite" ? drawInvite : drawAccept)();
    place(which === "invite" ? inviteBtn : acceptBtn);
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !pop.hidden) close(); });
  document.addEventListener("pointerdown", e => { if (!pop.hidden && !pop.contains(e.target) && !tools.contains(e.target)) close(); }, true);
  const head = t => h("div", { class: "pp-q" }, t);
  const line = (t, cls = "") => h("p", { class: "pp-line" + (cls ? " " + cls : "") }, t);
  const fence = t => h("div", { class: "pp-code" }, render("```\n" + t + "\n```"));
  const say = (el, e) => { el.textContent = e.message || String(e); el.hidden = false; };

  /** The inbox address: shown, or a field to set it once (unless it comes from the config). */
  function addressEl(after) {
    const me = st.me?.me;
    if (me.publicUrl && me.urlFromConfig) return line(`Your inbox: ${me.publicUrl}`);
    const input = h("input", { class: "pp-field", type: "url", inputmode: "url", spellcheck: "false", autocomplete: "off",
      placeholder: "https://your-machine.your-tailnet.ts.net:10000", value: me.publicUrl || "", "aria-label": "Your inbox address" });
    const err = line("", "bad"); err.hidden = true;
    const save = h("button", { class: "pp-go", type: "button", "data-tip": "Save the address others reach your inbox at", "aria-label": "Save address",
      onclick: async () => {
        try { await api("/url", { url: input.value }); await loadMe(); st.check = null; after(); } catch (e) { say(err, e); }
      } }, "Save");
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); save.click(); } });
    return h("div", { class: "pp-addr" }, head(me.publicUrl ? "Your inbox address" : "First: where others reach your inbox"),
      h("div", { class: "pp-row2" }, input, save), err);
  }

  async function drawInvite() {
    const me = st.me?.me; if (!me) return;
    if (!me.publicUrl) {
      pop.replaceChildren(head("Invite someone"), addressEl(drawInvite), line("To publish your inbox with Tailscale Funnel, run this once:"), fence(me.command),
        line("Then the address is https://<this machine's name>.<your tailnet>.ts.net:10000.", "muted"));
      return;
    }
    pop.replaceChildren(head("Invite someone"), line("Making a code…", "muted"));
    try {
      const { code, expires } = await api("/invite");
      if (st.pop !== "invite") return;
      pop.replaceChildren(head("Invite someone"),
        line("Send this code to the person you want to talk to (any channel). They paste it under Accept invite."),
        fence(code),
        line(`Works once, until ${new Date(expires).toLocaleDateString([], { day: "numeric", month: "short" })}. It holds no secret key.`, "muted"));
      pop.querySelector(".tx-copy")?.setAttribute("data-tip", "Copy the invite code");
    } catch (e) { pop.replaceChildren(head("Invite someone"), line(e.message, "bad")); }
  }

  function drawAccept() {
    const me = st.me?.me; if (!me) return;
    const ta = h("textarea", { class: "pp-field pp-paste", rows: "3", spellcheck: "false", autocomplete: "off", placeholder: "sleipnyr-invite-…", "aria-label": "Invite code" });
    const err = line("", "bad"); err.hidden = true;
    const go = h("button", { class: "pp-go", type: "button", "data-tip": "Pair with the person who sent this code", "aria-label": "Pair",
      onclick: async () => {
        err.hidden = true; go.disabled = true; go.textContent = "Pairing…";
        try {
          const r = await api("/accept", { code: ta.value });
          await loadMe(); draw();
          pop.replaceChildren(head(`Paired with ${r.peer.name}`), line("Safety code (the same on both screens):"), h("p", { class: "pp-safety" }, r.safety),
            line(`Compare it with ${r.peer.name} by phone once: if it matches, nobody is in between.`, "muted"),
            r.warning ? line(r.warning, "bad") : null,
            h("button", { class: "pp-go", type: "button", "data-tip": `Chat with ${r.peer.name}`, "aria-label": `Chat with ${r.peer.name}`,
              onclick: () => { close(); ctx.levels.go(ME, r.peer.id); } }, "Open chat"));
        } catch (e) { say(err, e); go.disabled = false; go.textContent = "Pair"; }
      } }, "Pair");
    pop.replaceChildren(head("Accept an invite"),
      me.publicUrl ? null : addressEl(drawAccept),
      me.publicUrl ? null : line("Your inbox must be reachable first, so the other side can answer. Publish it once with:"),
      me.publicUrl ? null : fence(me.command),
      me.publicUrl ? line("Paste the code the other person sent you.") : null,
      me.publicUrl ? ta : null, me.publicUrl ? h("div", { class: "pp-row2 end" }, go) : null, err);
    if (me.publicUrl) setTimeout(() => ta.focus(), 0);
  }

  /** Under the list: the inbox address and whether it answers from outside. */
  function inboxEl() {
    const me = st.me?.me;
    if (!me.key && !me.publicUrl) return null;
    const kids = [h("b", {}, "Your inbox"), h("span", { class: "pp-url" }, me.publicUrl || "address not set")];
    const c = st.check;
    if (!c) setTimeout(runCheck, 0); // first draw after the key or the address appeared
    const state = h("p", { class: "pp-line " + (c ? (c.ok ? "ok" : "bad") : "muted") }, c ? c.text : "Checking whether it answers…");
    const recheck = h("button", { class: "pp-ic sm", type: "button", "data-tip": "Check again whether your inbox answers", "aria-label": "Check again",
      onclick: () => { st.check = null; draw(); runCheck(); } }, svg(RETRY));
    return h("div", { class: "pp-inbox" }, h("div", { class: "pp-row2" }, h("span", { class: "pp-ib" }, ...kids), recheck), state,
      c?.command ? fence(c.command) : null);
  }
  let checking = null;
  function runCheck() {
    if (checking) return checking;
    checking = api("/check").then(c => { st.check = c; }, e => { st.check = { ok: false, text: e.message }; })
      .finally(() => { checking = null; if (!st.open) draw(); });
    return checking;
  }

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
    title.textContent = "People"; tools.hidden = false;
    back.dataset.tip = "All modalities"; back.setAttribute("aria-label", "All modalities");
    const me = st.me;
    if (!me) { body.replaceChildren(h("p", { class: "pp-note" }, "Loading…")); return; }
    const rows = me.peers.map(p => h("li", {}, h("a", { href: `/m/${ME}/${p.id}`, class: p.id === st.last ? "k-row here" : "k-row", "data-tip": `Chat with ${p.name} · safety code ${p.safety}`,
      onclick: e => { e.preventDefault(); ctx.levels.go(ME, p.id); } },
      h("span", { class: "pp-row" }, h("b", {}, p.name), h("small", {}, p.last ? (p.last.dir === "out" ? "You: " : "") + p.last.text.replace(/\s+/g, " ").slice(0, 80) : "No messages yet")),
      h("time", {}, p.waiting ? `${p.waiting} waiting` : p.last ? when(p.last.sent) : ""))));
    body.replaceChildren(...[
      rows.length ? h("ul", { class: "pp-list", role: "list" }, rows)
        : h("p", { class: "pp-note" }, "No people yet. Tap the person-plus to invite someone, or the ticket to accept a code someone sent you."),
      me.me.keyError ? h("p", { class: "pp-note" }, `The people key is unusable: ${me.me.keyError}`) : null,
      h("div", { class: "pp-foot" }, inboxEl(), h("p", { class: "pp-note pp-private" }, "Private: no agent reads or answers these conversations."))].filter(Boolean));
  }

  let log = null;
  function drawThread() {
    if (!st.me) { title.textContent = ""; body.replaceChildren(h("p", { class: "pp-note" }, "Loading…")); return; }
    const p = peer();
    if (!p) { drawList(); return; } // not (or no longer) in the config
    title.textContent = p.name; tools.hidden = true; close();
    back.dataset.tip = "All people"; back.setAttribute("aria-label", "All people");
    const atEnd = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const keep = log?.scrollTop;
    let waiting = false; // only the first undelivered message gets the retry button
    const els = st.msgs.map(m => {
      const el = messageEl(m, p.name, waiting);
      if (m.data.dir === "out" && m.data.state !== "sent") waiting = true;
      return el;
    });
    const safety = h("p", { class: "pp-safe-line" }, `Safety code ${p.safety}: the same on ${p.name}'s screen means nobody is in between.`);
    log = h("div", { class: "c-log pp-log" }, safety, els.length ? els
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
    log = null; close();
    ctx.bar.focus(ME);
    draw();
    try { await loadMe(); await loadThread(); } catch (e) { ctx.bar.say(e.message, true); }
    draw(); ctx.bar.refresh();
    if (!st.open && st.me && (st.me.me.key || st.me.me.publicUrl)) runCheck();
  });

  // someone accepted an invite of ours: list them at once, and say so in the open Invite popover
  ctx.on("people", async ({ paired }) => {
    try { await loadMe(); } catch { return; }
    if (!st.open) draw();
    const p = st.me.peers.find(x => x.id === paired);
    if (p && st.pop === "invite") pop.replaceChildren(head(`${p.name} accepted your invite`), line("Safety code (the same on both screens):"),
      h("p", { class: "pp-safety" }, p.safety), line(`Compare it with ${p.name} by phone once: if it matches, nobody is in between.`, "muted"),
      h("button", { class: "pp-go", type: "button", "data-tip": `Chat with ${p.name}`, "aria-label": `Chat with ${p.name}`,
        onclick: () => { close(); ctx.levels.go(ME, p.id); } }, "Open chat"));
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
