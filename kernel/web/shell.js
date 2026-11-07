// The browser side of the kernel: loads every plugin's styles, mounts the home
// plugin and hands it a small client for the kernel API (ctx below).
// Plain JavaScript on purpose: the shell must load even if a TypeScript
// conversion breaks.
//
// ctx = {
//   app, user, plugins,                      from GET /k/plugins
//   api(path, opts)  -> JSON                 fetch with errors thrown as Error(message)
//   upload(file)     -> file item            POST /k/files
//   fileUrl(id)                              URL of a file item's bytes
//   on(topic, fn)    -> off()                live events (one shared EventSource)
//   onReconnect(fn)                          called after the event stream reopens
//   address(id), go(id)                      an item's permanent address /i/<id>
//   bar                                      the modality bar (web/bar.js): views
//                                            offer targets, the bar sends input
//   actions                                  declared agent actions (web/actions.js):
//                                            handle(plugin, name, fn), sleep(ms, signal),
//                                            style() = a temporary effect rule
//   levels                                   the modality levels (below): up(), show(id),
//                                            go(id, sub), current(), sub(), onChange(fn)
//   embed(view, box, opts) -> {send} | null  the home plugin's embedded chat, moved into
//                                            box and showing view:<view>'s conversation
// }
//
// Levels: the top level is the modality picker ("/m"), a list of the composed
// modalities, i.e. ways of working with the agent. A plugin is one when its
// manifest has `modality: {title, doc, icon}` and a web entry exporting
// mount(box, ctx); the home plugin is mounted at start, the others on first
// visit. "/" and "/i/<id>" belong to the home plugin, "/m/<id>[/<sub>]" to
// modality <id> (sub = its own place, e.g. an open project). Each level is a
// box; one shows at a time, the modality bar stays underneath all of them.
// ctx.levels.onChange(fn) calls fn(id, sub) after every change.
// The page is one view box (the home plugin mounts there) above the modality
// bar, which the shell owns so every view shares it.
// Other plugins with a web entry are extensions: their module exports
// extend(host, ctx), host = whatever the home plugin's mount() returned.
//
// Frame mode (?frame=1, a window on a Blackboard or a Columns panel): the page runs as usual
// but without its own modality bar, update offer or service worker; live
// events come over the parent page's one stream (window.__kOn), and the parent's
// bar delivers input through window.__kSend(body) to the frame's focused view.

import { createActions, effectStyle, sleep } from "./actions.js";
import { createBar, tooltips } from "./bar.js";

const root = document.getElementById("app");
const parentShell = (() => {
  if (new URLSearchParams(location.search).get("frame") !== "1" || window.parent === window) return null;
  try { return window.parent.__kOn ? window.parent : null; } catch { return null; } // another origin: stand alone
})();
const framed = new URLSearchParams(location.search).get("frame") === "1" && window.parent !== window;

async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.json !== undefined) {
    init.method = init.method || "POST";
    init.body = JSON.stringify(opts.json);
    init.headers["content-type"] = "application/json";
  }
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

const upload = file => api(`/k/files?name=${encodeURIComponent(file.name || "file")}`, {
  method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" },
});

// one EventSource for all topics; reopened with the new topic list when it grows
const handlers = new Map(), reconnects = new Set();
let source = null, opened = false;
function connect() {
  if (source) source.close();
  const qs = [...handlers.keys()].map(t => "topic=" + encodeURIComponent(t)).join("&");
  source = new EventSource("/k/events?" + qs);
  source.onopen = () => { if (opened) reconnects.forEach(f => f()); opened = true; };
  source.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    (handlers.get(m.topic) || []).forEach(fn => { try { fn(m.data); } catch (err) { console.error(err); } });
  };
}
function on(topic, fn) {
  if (parentShell) return frameOn(topic, fn);
  const fresh = !handlers.has(topic);
  if (fresh) handlers.set(topic, new Set());
  handlers.get(topic).add(fn);
  if (fresh) { opened = false; connect(); }
  return () => handlers.get(topic)?.delete(fn);
}
// frame mode: subscribe through the parent's stream; drop it all when the frame goes
const frameOffs = new Set();
function frameOn(topic, fn) {
  const off = parentShell.__kOn(topic, fn);
  frameOffs.add(off);
  return () => { off(); frameOffs.delete(off); };
}
if (parentShell) addEventListener("pagehide", () => { frameOffs.forEach(off => { try { off(); } catch { /* parent gone */ } }); frameOffs.clear(); });
const onReconnect = fn => {
  if (!parentShell) { reconnects.add(fn); return; }
  frameOffs.add(parentShell.__kOnReconnect(fn));
};
// a phone wakes the page up with a dead connection: reopen and let plugins catch up
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && source && source.readyState === EventSource.CLOSED) { opened = true; connect(); }
});

const loadCss = href => new Promise(ok => {
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href; l.onload = l.onerror = ok;
  document.head.appendChild(l);
});

const svgEl = s => { const t = document.createElement("template"); t.innerHTML = String(s || "").trim(); const n = t.content.firstElementChild; return n?.tagName === "svg" ? n : null; };
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter(k => k != null && k !== false));
  return e;
}

const PICKER = "picker";
const RENAMED = { sessions: "blackboards" }; // modality renames: old id -> new
function createLevels(ctx, view, home, mods) {
  const boxes = new Map(), hooks = new Set(), last = new Map();
  let level = "", from = "";
  for (const id of [PICKER, ...mods.map(p => p.id)]) {
    const box = el("div", { class: "k-level", "data-level": id, hidden: true });
    boxes.set(id, { box, mounted: id === home.id || id === PICKER ? Promise.resolve() : null });
    view.append(box);
  }
  const parse = () => {
    const m = location.pathname.match(/^\/m(?:\/([a-z0-9-]+)(?:\/(.*))?)?\/?$/);
    if (!m) return { id: home.id, sub: "" };
    const id = RENAMED[m[1]] || m[1] || PICKER; // old addresses keep working
    return { id, sub: decodeURIComponent(m[2] || "") };
  };
  const pathFor = (id, sub) => id === PICKER ? "/m" : id === home.id ? "/" : `/m/${id}${sub ? "/" + encodeURIComponent(sub) : ""}`;
  async function show(id, push = true, sub) {
    if (!boxes.has(id)) id = home.id;
    if (level && level !== id) from = level;
    if (push) {
      if (level) last.set(level, location.pathname);
      const path = sub !== undefined ? pathFor(id, sub) : last.get(id) || pathFor(id, "");
      if (location.pathname !== path) history.pushState({}, "", path);
    }
    level = id;
    for (const [k, l] of boxes) l.box.hidden = k !== id;
    const l = boxes.get(id), p = mods.find(x => x.id === id);
    l.mounted ||= import(`/p/${p.id}/${p.web.entry}`).then(m => m.mount(l.box, ctx)).catch(e => {
      console.error(e); l.box.replaceChildren(el("p", { class: "boot error" }, `${p.modality.title || p.name} could not start: ${e.message || e}`));
    });
    await l.mounted;
    if (level !== id) return;
    for (const fn of hooks) try { fn(id, parse().sub); } catch (e) { console.error(e); }
    ctx.bar.refresh();
  }
  addEventListener("popstate", () => { const { id } = parse(); show(id, false); });
  return {
    box: id => boxes.get(id)?.box, parse, from: () => from, pathFor,
    api: { up: () => show(PICKER), show: (id, push = true) => show(id, push), go: (id, sub) => show(id, true, sub || ""),
      current: () => level, sub: () => parse().sub, onChange: fn => { hooks.add(fn); return () => hooks.delete(fn); } },
  };
}

// The picker: one row per composed modality (symbol, title, what it is), its
// own conversation in the embedded chat underneath, and the bar talks to it.
const OPEN_HINT = "Talk to the picker with the bar below: open a modality";
function picker(ctx, box, mods, lv) {
  const list = el("ul", { class: "k-mods", role: "list" });
  box.append(el("header", { class: "k-bar" }, el("b", { class: "k-app" }, ctx.app.shortName)), list);
  const draw = () => list.replaceChildren(...mods.map(p => el("li", {}, el("a", {
    href: lv.pathFor(p.id, ""), "data-id": p.id, "data-k-id": p.id, "data-k-kind": "modality", class: p.id === lv.from() ? "here" : null,
    "data-tip": `Open ${p.modality.title || p.name}`, onclick: e => { e.preventDefault(); ctx.levels.show(p.id); } },
    el("span", { class: "k-mod-ic", "aria-hidden": "true" }, svgEl(p.modality.icon)),
    el("span", { class: "k-mod-t" }, el("b", {}, p.modality.title || p.name), p.modality.doc ? el("small", {}, p.modality.doc) : null)))));
  const describe = () => `[Sent from the Sleipnyr modality picker: the top level, a list of the ways to work with ${ctx.app.agentName} `
    + `("composed modalities"). On screen (id | title | what it is):\n${mods.map(p => `- ${p.id} | ${p.modality.title || p.name} | ${p.modality.doc || ""}`).join("\n")}\n`
    + `Came here from: ${lv.from() || "(start)"}. This chat is the picker's own history; the picker acts on your reply. `
    + `Reply with ONE short sentence (at most 12 words, shown on a single line), then one line per action, exactly:\n`
    + `@open <modality id>   (show that modality)\nThe picker runs these lines itself and does not show them: do not call any tool or API for them. `
    + `Use only ids listed above. Never delete anything.]`;
  const run = async (name, args) => {
    const id = String(args).trim().split(/\s+/)[0];
    if (name !== "open") throw new Error("unknown command");
    if (!mods.some(p => p.id === id)) throw new Error("no such modality");
    ctx.levels.show(id); return `open ${id}`;
  };
  let chat = null;
  ctx.bar.offer({ id: "modalities", label: () => "Modalities", shown: () => !!box.getClientRects().length,
    placeholder: () => "Ask the picker: open a modality",
    busy: () => !!chat?.busy?.(),
    send: body => { if (!chat) throw new Error("no conversation here"); return chat.send(body); } });
  ctx.levels.onChange(id => {
    if (id !== PICKER) return;
    draw();
    chat = ctx.embed("modalities", box, { title: "Modality picker conversation", hint: OPEN_HINT, from: "modality picker", describe, run });
    ctx.bar.focus("modalities");
  });
}

async function boot() {
  const info = await api("/k/plugins");
  document.title = info.app.name;
  await Promise.all(info.plugins.flatMap(p => (p.web?.styles || []).map(s => loadCss(`/p/${p.id}/${s}`))));
  const home = info.plugins.find(p => p.id === info.app.home && p.web?.entry);
  if (!home) throw new Error(`home plugin "${info.app.home}" has no web entry`);
  const mod = await import(`/p/${home.id}/${home.web.entry}`);
  root.textContent = "";
  const view = document.createElement("div");
  view.className = "k-view";
  root.append(view);
  const mods = [home, ...info.plugins.filter(p => p !== home && p.modality && p.web?.entry)];
  if (!home.modality) home.modality = { title: home.name };
  tooltips(root);
  const ctx = {
    app: { ...info.app, agentName: info.app.agentName || "Agent" }, user: info.user, plugins: info.plugins, api, upload, on,
    onReconnect,
    fileUrl: id => `/k/files/${encodeURIComponent(id)}`,
    address: id => `/i/${encodeURIComponent(id)}`,
    go: id => history.pushState({}, "", `/i/${encodeURIComponent(id)}`),
    route: () => decodeURIComponent((location.pathname.match(/^\/i\/(.+)$/) || [])[1] || ""),
  };
  ctx.bar = createBar(ctx, root);
  root.append(ctx.bar.el);
  if (framed) { root.classList.add("k-framed"); window.__kSend = body => ctx.bar.deliver(body); }
  else { window.__kOn = on; window.__kOnReconnect = fn => { reconnects.add(fn); return () => reconnects.delete(fn); }; }
  ctx.actions = { ...createActions(ctx, root), sleep, style: effectStyle };
  const lv = createLevels(ctx, view, home, mods);
  ctx.levels = lv.api;
  let host = null;
  ctx.embed = (v, box, opts) => (host?.embed ? host.embed(v, box, opts) : null);
  host = await mod.mount(lv.box(home.id), ctx);
  picker(ctx, lv.box(PICKER), mods, lv);
  await ctx.levels.show(lv.parse().id, false);
  // extensions: other plugins with a web entry add to the home plugin through
  // what its mount() returned (one failing never stops the app); modalities mount themselves
  for (const p of info.plugins.filter(p => p !== home && p.web?.entry && !p.modality))
    import(`/p/${p.id}/${p.web.entry}`).then(m => m.extend?.(host, ctx)).catch(e => console.warn(`extension ${p.id}:`, e));
  if (!framed) watchBuild(info.build);
}

// A deploy changes the build id: show a small bar, update only when tapped.
function watchBuild(mine) {
  let bar = null;
  const check = async () => {
    try {
      const { build } = await api("/k/plugins");
      if (!build || build === mine || bar) return;
      bar = document.createElement("button");
      bar.className = "update-bar"; bar.type = "button";
      bar.textContent = "↻ New version";
      bar.title = "Reload to get the latest version";
      bar.onclick = () => location.reload();
      document.body.appendChild(bar);
    } catch { /* offline: try again later */ }
  };
  setInterval(check, 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  reconnects.add(check);
}

boot().catch(e => {
  console.error(e);
  root.innerHTML = "";
  const p = document.createElement("p");
  p.className = "boot error";
  p.textContent = "Could not start: " + (e.message || e) + " (tap to retry)";
  p.onclick = () => location.reload();
  root.appendChild(p);
});

if ("serviceWorker" in navigator && !framed) navigator.serviceWorker.register("/sw.js").catch(e => console.warn("service worker:", e));