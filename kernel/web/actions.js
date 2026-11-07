// The page side of declared agent actions (kernel/actions.ts). The server
// relays each allowed call on the "action" event topic; the plugin that
// declared it runs it here through a handler registered with
//   ctx.actions.handle(plugin, name, async (args, signal) => "what happened")
// A handler only ever gets checked, typed arguments; there is no way to send
// code. While any effect runs, a stop control shows above the bar: it ends
// the effects on every open page. A reload resets everything.
//
// The kernel's generic view actions (view_describe, view_mark, view_scroll_to,
// view_focus, view_animate, view_order; declared in kernel/actions.ts) run
// here too, on whatever view is on screen. The convention every view follows:
// an element an agent may point at carries data-k-id="<item id>" and
// data-k-kind="<kind>" (optional data-k-label = a short name). A view that can
// do more than the generic DOM fallback registers itself:
//   ctx.actions.view(<level id>, { scrollTo(id, block), focus(id), order(ids, {into, at}),
//                                  has(id), extra() })
// scrollTo/focus return true when they handled it; order returns what it did.
// has(id) = the view knows an item that is not drawn right now (a card deeper
// in a stack, a row of a list behind an open page): focus/scroll_to then ask
// the view to bring it up, and so do mark/animate when none of their targets is drawn. extra() lists such items for view_describe as
// [{ id, kind, label, note }].

export function createActions(ctx, root) {
  const handlers = new Map(); // "plugin/name" -> fn
  const running = new Map(); // call id -> AbortController
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "k-fx-stop";
  stopBtn.hidden = true;
  stopBtn.dataset.tip = "Stop the agent's effects on screen";
  stopBtn.setAttribute("aria-label", "Stop effects");
  stopBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/></svg><span>Stop effect</span>';
  stopBtn.onclick = () => {
    stopAll();
    ctx.api("/k/actions/stop", { method: "POST", json: {} }).catch(() => { /* this page has stopped anyway */ });
  };
  root.append(stopBtn);

  const report = (id, status, note) =>
    ctx.api(`/k/actions/${encodeURIComponent(id)}`, { json: { status, note } }).catch(e => console.warn("action report:", e));
  const show = () => { stopBtn.hidden = running.size === 0; };
  function stopAll() { for (const c of running.values()) c.abort(); }

  const accepts = new Map(); // "plugin/name" -> args => does this page answer?
  async function run({ id, plugin, action, args }) {
    const fn = handlers.get(`${plugin}/${action}`);
    if (!fn || running.has(id)) return; // this page does not show that view: another page answers
    try { if (accepts.has(`${plugin}/${action}`) && !accepts.get(`${plugin}/${action}`)(args || {})) return; } catch { return; }
    const ctl = new AbortController();
    running.set(id, ctl); show();
    report(id, "running");
    try {
      const note = await fn(args || {}, ctl.signal);
      report(id, ctl.signal.aborted ? "stopped" : "done", ctl.signal.aborted ? "stopped" : String(note || ""));
    } catch (e) {
      report(id, ctl.signal.aborted ? "stopped" : "failed", ctl.signal.aborted ? "stopped" : String(e?.message || e));
    } finally { running.delete(id); show(); }
  }

  ctx.on("action", m => {
    if (m?.stop) stopAll();
    else if (m?.run) run(m.run);
  });

  const handle = (plugin, name, fn, accept) => {
    handlers.set(`${plugin}/${name}`, fn);
    if (accept) accepts.set(`${plugin}/${name}`, accept);
    return () => { handlers.delete(`${plugin}/${name}`); accepts.delete(`${plugin}/${name}`); };
  };
  const views = new Map(); // level id -> what the view adds to the generic actions
  viewActions(ctx, root, handle, views);
  return {
    /** register what one declared action does on this page (accept: args => whether this page answers) */
    handle,
    /** a view's own part of the generic view_* actions (see the top of this file) */
    view(level, provider) { views.set(level, provider); return () => views.delete(level); },
    running: () => running.size,
    stop: stopAll,
  };
}

// ------------------------------------------------------------ generic view actions

/** properties an animation frame may set: the same list as ANIM_PROPS in kernel/actions.ts */
const ANIM_PROPS = new Set(["opacity", "scale", "rotate", "translate", "background-color", "color", "outline-color",
  "outline-width", "outline-offset", "border-color", "box-shadow", "filter"]);
const VALUE = /^[-+0-9a-zA-Z.,%#() /]{1,120}$/;
const safeColor = c => !c || (CSS.supports("color", c) && !/[;{}<>\\]/.test(c));
const sel = id => `[data-k-id="${CSS.escape(id)}"]`;
const shown = e => !!e && e.getClientRects().length > 0;
const words = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);

function viewActions(ctx, root, handle, views) {
  const framed = () => root.classList.contains("k-framed"); // a window inside a board: its parent page answers
  const level = () => ctx.levels?.current() || "";
  const levelBox = () => document.querySelector(`.k-level[data-level="${CSS.escape(level())}"]`) || root;
  const find = id => [...levelBox().querySelectorAll(sel(id))].sort((a, b) => shown(b) - shown(a))[0] || null;
  // a call naming a view this page does not show opens it first; one naming
  // none runs only where its targets are on screen (other pages stay quiet)
  const ids = a => [...(a.targets || a.ids || []), ...(a.target ? [a.target] : [])];
  const known = id => !!find(id) || !!views.get(level())?.has?.(id);
  const accept = a => !framed() && (!!a.view || !ids(a).length || ids(a).some(known));
  async function open(view) {
    if (!view) return;
    const [id, ...rest] = view.split("/"), sub = rest.join("/");
    if (id === level() && (!sub || sub === ctx.levels.sub())) return;
    await (sub ? ctx.levels.go(id, sub) : ctx.levels.show(id));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (level() !== id) throw new Error(`no view ${id}`);
  }
  const need = id => { const e = find(id); if (!e) throw new Error(`${id} is not in the ${level()} view (view_describe lists the ids)`); return e; };
  const missing = (here, all) => {
    const hid = all.filter(id => !here.includes(id) && views.get(level())?.has?.(id));
    return hid.length ? `; not drawn now (view_focus brings it up): ${hid.join(", ")}` : "";
  };
  // no target drawn but the view knows one: let it bring that one up (Tinder: to the top of the stack)
  async function reveal(targets) {
    const v = views.get(level());
    if (targets.some(id => find(id)) || !v?.focus) return;
    const id = targets.find(t => v.has?.(t));
    if (id) { await v.focus(id); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }
  }
  const notHere = targets => `none of ${targets.join(", ")} is drawn in the ${level()} view`
    + (targets.some(id => views.get(level())?.has?.(id)) ? " (it is there but hidden: view_focus brings it up first)" : "");

  // ---- describe
  handle("view", "describe", async ({ view }) => {
    await open(view);
    const box = levelBox(), seen = new Set(), rows = [];
    const vh = innerHeight, vw = innerWidth, can = !!views.get(level())?.order;
    for (const e of box.querySelectorAll("[data-k-id]")) {
      const id = e.dataset.kId; if (seen.has(id) || !shown(e)) continue; seen.add(id);
      const r = e.getBoundingClientRect(), on = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      const kind = e.dataset.kKind || "item", label = words(e.dataset.kLabel || e.textContent, 70);
      const ord = can && e.dataset.kOrder !== undefined;
      rows.push(`- ${id} ${kind} "${label}"${on ? "" : " (off screen)"}${ord ? " (orderable)" : ""}`);
    }
    for (const x of (await views.get(level())?.extra?.()) || []) {
      if (seen.has(x.id)) continue; seen.add(x.id);
      rows.push(`- ${x.id} ${x.kind || "item"} "${words(x.label, 70)}" (${x.note || "not drawn now; view_focus brings it up"})`);
    }
    const sub = ctx.levels?.sub() || "";
    return [`view: ${level()}${sub ? "/" + sub : ""} on a ${vw}x${vh} page; ${rows.length} items`,
      ...rows.slice(0, 150), rows.length > 150 ? `(+${rows.length - 150} more)` : ""].filter(Boolean).join("\n");
  }, () => !framed());

  // ---- marks: one map (item id -> mark, a later call takes over), one style rebuilt from it
  const marks = new Map(), style = effectStyle();
  const LOOK = {
    frame: c => `outline: 2px solid ${c} !important; outline-offset: -2px;`,
    tint: c => `background-color: color-mix(in srgb, ${c} 24%, transparent) !important;`,
    underline: c => `box-shadow: inset 0 -2px 0 ${c} !important;`,
    pulse: c => `--k-fx-c: ${c}; outline: 1px solid ${c} !important; outline-offset: -2px; animation: k-fx-pulse 1.2s ease-in-out infinite !important;`,
  };
  function redraw() {
    style.set(marks.size ? [`@keyframes k-fx-pulse { 0%, 100% { box-shadow: inset 0 0 0 0 transparent; } 50% { box-shadow: inset 0 0 0 3px var(--k-fx-c), 0 0 14px var(--k-fx-c); } }`,
      ...[...marks].map(([id, m]) => `${sel(id)} { ${LOOK[m.style](m.color)} border-radius: var(--radius); }`)].join("\n") : "");
    tips();
  }
  // the reason as the item's tooltip; the view's own tooltip comes back afterwards (redraws make fresh elements: watched)
  function tips() {
    for (const e of document.querySelectorAll("[data-k-tipped]")) {
      if (marks.get(e.dataset.kId)?.reason) continue;
      if (e.dataset.kTipWas) e.dataset.tip = e.dataset.kTipWas; else delete e.dataset.tip;
      delete e.dataset.kTipWas; delete e.dataset.kTipped;
    }
    for (const [id, m] of marks) if (m.reason) for (const e of document.querySelectorAll(sel(id))) {
      if (e.dataset.kTipped === undefined && e.dataset.tip) e.dataset.kTipWas = e.dataset.tip;
      e.dataset.tip = m.reason; e.dataset.kTipped = "";
    }
  }
  let tipRaf = 0;
  new MutationObserver(() => { if (!tipRaf && [...marks.values()].some(m => m.reason)) tipRaf = requestAnimationFrame(() => { tipRaf = 0; tips(); }); })
    .observe(root, { childList: true, subtree: true });
  let callNo = 0;
  async function mark(targets, look, color, reason, ms, signal) {
    const me = ++callNo;
    for (const id of targets) marks.set(id, { style: look, color, reason, call: me });
    redraw();
    try { await sleep(ms, signal); } catch { /* stopped: clear below */ }
    for (const id of targets) if (marks.get(id)?.call === me) marks.delete(id);
    redraw();
  }
  handle("view", "mark", async ({ targets, view, style: look, color, reason, duration_ms }, signal) => {
    if (!safeColor(color)) throw new Error(`not a CSS colour: ${color}`);
    await open(view); await reveal(targets);
    const here = targets.filter(id => find(id));
    if (!here.length) throw new Error(notHere(targets));
    const gone = targets.filter(id => !here.includes(id) && !views.get(level())?.has?.(id));
    mark(here, look, color || "var(--accent-here)", reason, duration_ms, signal);
    await sleep(Math.min(duration_ms, 600), signal).catch(() => {});
    return `${look} on ${here.length} item${here.length > 1 ? "s" : ""} in ${level()} for ${Math.round(duration_ms / 1000)} s`
      + (gone.length ? `; not found: ${gone.join(", ")}` : "") + missing(here, targets);
  }, accept);

  // ---- scroll_to / focus
  async function scrollTo(id, block) {
    const v = views.get(level());
    if (v?.scrollTo && await v.scrollTo(id, block)) return;
    if (!find(id) && v?.has?.(id) && v.focus && await v.focus(id)) { if (find(id)) need(id).scrollIntoView({ block, inline: "nearest", behavior: "smooth" }); return; }
    need(id).scrollIntoView({ block, inline: "nearest", behavior: "smooth" });
  }
  handle("view", "scroll_to", async ({ target, view, block }) => {
    await open(view); if (!known(target)) need(target);
    await scrollTo(target, block);
    return `${target} brought into view in ${level()}`;
  }, accept);
  handle("view", "focus", async ({ target, view, pulse_ms }, signal) => {
    await open(view);
    if (!target) return `opened ${level()}`;
    if (!known(target)) need(target);
    const v = views.get(level());
    if (!(v?.focus && await v.focus(target))) await scrollTo(target, "center");
    if (pulse_ms) await mark([target], "pulse", "var(--accent-here)", "", pulse_ms, signal);
    return `focused ${target} in ${level()}`;
  }, accept);

  // ---- animate: keyframes over whitelisted properties, per-target phase, cleared at the end
  handle("view", "animate", async ({ targets, view, frames, duration_ms, loops, phase_ms, easing, alternate }, signal) => {
    const steps = frames.map(f => f.split(";").filter(Boolean).map(d => {
      const i = d.indexOf(":"), prop = d.slice(0, i).trim(), value = d.slice(i + 1).trim();
      if (!ANIM_PROPS.has(prop) || !VALUE.test(value) || /url|expression|image/i.test(value) || !CSS.supports(prop, value))
        throw new Error(`not allowed in a frame: ${d}`);
      return `${prop}: ${value}`;
    }).join("; "));
    await open(view); await reveal(targets);
    const here = targets.filter(id => find(id));
    if (!here.length) throw new Error(notHere(targets));
    const name = `k-fx-anim-${++callNo}`, ease = easing === "steps" ? `steps(${steps.length - 1}, jump-none)` : easing;
    const fx = effectStyle();
    fx.set([`@keyframes ${name} { ${steps.map((s, i) => `${Math.round(i / (steps.length - 1) * 1000) / 10}% { ${s} }`).join(" ")} }`,
      ...here.map((id, i) => `${sel(id)} { animation: ${name} ${duration_ms}ms ${ease} ${i * phase_ms}ms ${loops} ${alternate ? "alternate" : "normal"} both !important; }`)].join("\n"));
    try { await sleep(duration_ms * loops + phase_ms * (here.length - 1), signal); } finally { fx.remove(); }
    return `animated ${here.length} item${here.length > 1 ? "s" : ""} in ${level()} (${loops}× ${duration_ms} ms)`;
  }, accept);

  // ---- order: only where the view saves an order itself
  handle("view", "order", async ({ ids: list, view, into, at }) => {
    await open(view);
    const v = views.get(level());
    if (!v?.order) throw new Error(`the ${level()} view cannot reorder its items`);
    return String(await v.order(list, { into, at }) || `reordered ${list.length} in ${level()}`);
  }, accept);
}

/** Waits ms, or rejects at once when the signal aborts (effects call this between steps). */
export const sleep = (ms, signal) => new Promise((ok, no) => {
  if (signal?.aborted) return no(new Error("stopped"));
  const t = setTimeout(ok, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); no(new Error("stopped")); }, { once: true });
});

/**
 * A temporary style rule (an effect), removed by the returned function. Rules
 * address elements by selector, so they survive a view redrawing its rows.
 */
export function effectStyle() {
  const el = document.createElement("style");
  el.dataset.effect = "";
  document.head.append(el);
  return { set: css => { el.textContent = css; }, remove: () => el.remove() };
}
