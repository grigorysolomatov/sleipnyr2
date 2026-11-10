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
//   restyle(plugin)  -> Promise              reload that plugin's stylesheets (a theme change)
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
import { createPush } from "./push.js";
import { ONE_SENTENCE, runs } from "./hcp.js";

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
const settingsHooks = new Set();
let source = null, opened = false, heard = 0;
function connect() {
  if (source) source.close();
  heard = Date.now();
  const qs = [...handlers.keys()].map(t => "topic=" + encodeURIComponent(t)).join("&");
  source = new EventSource("/k/events?" + qs);
  source.onopen = () => { heard = Date.now(); if (opened) reconnects.forEach(f => f()); opened = true; };
  source.addEventListener("ping", () => { heard = Date.now(); });
  source.onmessage = e => {
    heard = Date.now();
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
// A phone wakes the page up with a dead connection that may still claim to be
// open: reopen and let plugins catch up. The server pings every 20 s, so a
// stream silent for 45 s (or 25 s when the page comes back) is dead.
const revive = () => { if (source) { opened = true; connect(); } };
const stale = ms => !source || source.readyState === EventSource.CLOSED || Date.now() - heard > ms;
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && stale(25000)) revive(); });
addEventListener("online", revive);
addEventListener("pageshow", e => { if (e.persisted) revive(); });
setInterval(() => { if (document.visibilityState === "visible" && source && stale(45000)) revive(); }, 5000);

const loadCss = href => new Promise(ok => {
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href; l.onload = l.onerror = ok;
  document.head.appendChild(l);
});

// reload one plugin's stylesheets in place: the new sheet loads first, then
// the old one goes, so the page never flashes unstyled. Plugins listing item
// types in web.restyleOn get this on every change of such an item (a theme
// saved on another page restyles this one without a reload).
const sheetOf = (p, s) => `/p/${p}/${s}`;
async function restyle(plugin) {
  const old = [...document.querySelectorAll('link[rel="stylesheet"]')].filter(l => new URL(l.href).pathname.startsWith(`/p/${plugin}/`));
  await Promise.all(old.map(l => new Promise(ok => {
    const n = document.createElement("link"); n.rel = "stylesheet";
    const u = new URL(l.href); u.searchParams.set("v", Date.now().toString(36)); n.href = u.pathname + u.search;
    n.onload = n.onerror = () => { l.remove(); ok(); };
    l.after(n);
  })));
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
}

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
const RENAMED = { sessions: "blackboards", theme: "settings" }; // modality renames: old id -> new
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
    // the bar belongs to the shell: if a view's redraw ever took it out, put it back
    if (!framed && ctx.bar.el.parentElement !== root) { console.error("modality bar was detached; restored"); root.append(ctx.bar.el); }
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
function picker(ctx, box, all, lv) {
  // pickerHidden: modality ids left out of the picker (still reachable by address); the
  // Settings value when set, else the config's app.pickerHidden; re-read on every draw
  const hidden = () => ctx.settings().pickerHidden || ctx.app.pickerHidden || [];
  let mods = all.filter(p => !hidden().includes(p.id));
  const list = el("ul", { class: "k-mods", role: "list" });
  box.append(el("header", { class: "k-bar" }, el("b", { class: "k-app" }, ctx.app.shortName)), list);
  let recent = [], more = false, recentSoon = 0;
  const when = t => { const d = new Date(Number(t)), now = new Date();
    return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      : d.toLocaleDateString([], { day: "numeric", month: "short" }); };
  // Recent: the latest conversations across all views (pink = last open); 5 rows, More shows 15
  const recentRows = () => !recent.length ? [] : [
    el("li", { class: "k-mods-h" }, "Recent"),
    ...recent.slice(0, more ? 15 : 5).map(r => el("li", {}, el("a", {
      href: "#", class: r.here ? "k-rc here" : "k-rc", "data-k-id": r.id, "data-k-kind": "conversation", "data-tip": `Open ${r.name}`,
      onclick: e => { e.preventDefault(); ctx.conversations?.open(r); } },
      el("span", { class: "k-mod-t" }, el("b", {}, r.name), el("small", {}, `${r.role === "agent" ? ctx.app.agentName + ": " : ""}${r.text || "…"}`)),
      el("time", {}, when(r.updated))))),
    recent.length > 5 ? el("li", {}, el("button", { type: "button", class: "k-more", "data-k-id": "recent-more", "data-k-kind": "toggle",
      "data-tip": more ? "Show fewer conversations" : "Show more conversations", onclick: () => { more = !more; draw(); } }, more ? "Fewer" : "More")) : null,
    el("li", { class: "k-mods-h" }, "Modalities")];
  const loadRecent = async () => {
    if (!ctx.conversations || !ctx.feature("recent")) recent = [];
    else try { recent = await ctx.conversations.recent(); } catch (e) { console.error(e); recent = []; }
    if (ctx.levels.current() === PICKER) draw();
  };
  ctx.on("item", ({ item }) => {
    if (item?.type !== "message" || ctx.levels.current() !== PICKER) return;
    clearTimeout(recentSoon); recentSoon = setTimeout(loadRecent, 800);
  });
  const modRows = () => mods.map(p => el("li", {}, el("a", {
    href: lv.pathFor(p.id, ""), "data-id": p.id, "data-k-id": p.id, "data-k-kind": "modality", class: p.id === lv.from() ? "here" : null,
    "data-tip": `Open ${p.modality.title || p.name}`, onclick: e => { e.preventDefault(); ctx.levels.show(p.id); } },
    el("span", { class: "k-mod-ic", "aria-hidden": "true" }, svgEl(p.modality.icon)),
    el("span", { class: "k-mod-t" }, el("b", {}, p.modality.title || p.name), p.modality.doc ? el("small", {}, p.modality.doc) : null))));
  const draw = () => { mods = all.filter(p => !hidden().includes(p.id)); list.replaceChildren(...[...recentRows(), ...modRows()].filter(Boolean)); };
  ctx.onSettings(() => { if (ctx.levels.current() === PICKER) draw(); else mods = all.filter(p => !hidden().includes(p.id)); });
  const describe = () => `[Sent from the Sleipnyr modality picker: the top level, a list of the ways to work with ${ctx.app.agentName} `
    + `("composed modalities"). On screen (id | title | what it is):\n${mods.map(p => `- ${p.id} | ${p.modality.title || p.name} | ${p.modality.doc || ""}`).join("\n")}\n`
    + `Came here from: ${lv.from() || "(start)"}. This chat is the picker's own history; the picker acts on your reply. `
    + `${ONE_SENTENCE}, then one line per action, exactly:\n`
    + `@open <modality id>   (show that modality)\n${runs("picker")} `
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
    draw(); loadRecent();
    chat = ctx.embed("modalities", box, { title: "Modality picker conversation", from: "modality picker", describe, run });
    ctx.bar.focus("modalities");
  });
}

async function boot() {
  const info = await api("/k/plugins");
  document.title = info.app.name;
  await Promise.all(info.plugins.flatMap(p => (p.web?.styles || []).map(s => loadCss(sheetOf(p.id, s)))));
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
    onReconnect, restyle,
    // feature switches: Settings > Features (kernel settings item) over the app config; default on
    feature: name => (info.settings?.features?.[name] ?? info.app.features?.[name]) !== false,
    // the app settings changed by hand in Settings: {allowDelete, features}; kept fresh live
    settings: () => info.settings || { allowDelete: false, features: {}, pickerHidden: null, viewNotes: {} },
    fileUrl: id => `/k/files/${encodeURIComponent(id)}`,
    address: id => `/i/${encodeURIComponent(id)}`,
    go: id => history.pushState({}, "", `/i/${encodeURIComponent(id)}`),
    route: () => decodeURIComponent((location.pathname.match(/^\/i\/(.+)$/) || [])[1] || ""),
  };
  // a settings change on any page: fetch the merged values, tell the views ("settings" topic is local)
  on("item", ({ item }) => {
    if (item?.type !== "settings") return;
    api("/k/settings").then(s => { info.settings = s; settingsHooks.forEach(f => { try { f(s); } catch (e) { console.error(e); } }); }).catch(() => {});
  });
  ctx.onSettings = fn => { settingsHooks.add(fn); return () => settingsHooks.delete(fn); };
  // a page that just saved settings has the merged values already (the live event follows)
  ctx.settingsChanged = s => { info.settings = s; settingsHooks.forEach(f => { try { f(s); } catch (e) { console.error(e); } }); };
  const restyleOn = new Map(info.plugins.flatMap(p => (p.web?.restyleOn || []).map(t => [t, p.id])));
  if (restyleOn.size) on("item", ({ item }) => { const p = restyleOn.get(item?.type); if (p) restyle(p); });
  ctx.bar = createBar(ctx, root);
  ctx.push = framed ? { shows: () => () => {}, state: async () => ({ supported: false, perm: "", on: false }) } : createPush(ctx); // phone notifications
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