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
// [{ id, kind, label, note }]. fold(id, folded) folds / unfolds an item the
// way the view's own fold control does (true when handled). A provider
// registered for level "*" answers on every level (the embedded chat strip).
//
// Media and navigation (view_media_play / _pause / _seek, view_open, view_back,
// view_fold) do what the user's own taps do: players are the <audio>/<video>
// elements inside an item (also inside its same-origin frame), opening clicks
// the item when it is a link or button, back clicks the header's back arrow
// (class *-back or *-up). When several pages are open, the one used most
// recently claims a call (claim: true), so phone and desktop never both play.

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

  const report = (id, status, note, say) =>
    ctx.api(`/k/actions/${encodeURIComponent(id)}`, { json: { status, note, ...(say ? { say } : {}) } }).catch(e => console.warn("action report:", e));
  const show = () => { stopBtn.hidden = running.size === 0; };
  function stopAll() { for (const c of running.values()) c.abort(); }

  const accepts = new Map(); // "plugin/name" -> args => does this page answer?
  const claims = new Set(); // "plugin/name": only one page runs it (the one used last)
  let lastInput = performance.now();
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) addEventListener(ev, () => { lastInput = performance.now(); }, { capture: true, passive: true });
  async function run({ id, plugin, action, args }) {
    const key = `${plugin}/${action}`, fn = handlers.get(key);
    if (!fn || running.has(id)) return; // this page does not show that view: another page answers
    try { if (accepts.has(key) && !accepts.get(key)(args || {})) return; } catch { return; }
    const ctl = new AbortController();
    running.set(id, ctl);
    if (claims.has(key)) {
      // the page touched last answers first; any later page sees it taken and stays quiet
      await sleep(Math.min(1500, (performance.now() - lastInput) / 100)).catch(() => {});
      const r = await report(id, "running");
      if (r?.data && (r.data.pages || 0) > 1) { running.delete(id); return; }
      show();
    } else { show(); report(id, "running"); }
    const say = note => report(id, "running", String(note), true); // a word on what happens, while it runs
    try {
      const note = await fn(args || {}, ctl.signal, say);
      report(id, ctl.signal.aborted ? "stopped" : "done", ctl.signal.aborted ? "stopped" : String(note || ""));
    } catch (e) {
      report(id, ctl.signal.aborted ? "stopped" : "failed", ctl.signal.aborted ? "stopped" : String(e?.message || e));
    } finally { running.delete(id); show(); }
  }

  ctx.on("action", m => {
    if (m?.stop) stopAll();
    else if (m?.run) run(m.run);
  });

  const handle = (plugin, name, fn, accept, opts = {}) => {
    handlers.set(`${plugin}/${name}`, fn);
    if (accept) accepts.set(`${plugin}/${name}`, accept);
    if (opts.claim) claims.add(`${plugin}/${name}`);
    return () => { handlers.delete(`${plugin}/${name}`); accepts.delete(`${plugin}/${name}`); claims.delete(`${plugin}/${name}`); };
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
  const known = id => !!find(id) || !!views.get(level())?.has?.(id) || !!views.get("*")?.has?.(id);
  const accept = a => !framed() && (!!a.view || !ids(a).length || ids(a).some(known));
  async function open(view) {
    if (!view) return;
    const [id, ...rest] = view.split("/"), sub = rest.join("/");
    if (id === level() && (!sub || sub === ctx.levels.sub())) return;
    await (sub ? ctx.levels.go(id, sub) : ctx.levels.show(id));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (level() !== id) throw new Error(`no view ${id}`);
    // a view fetches its items after it opens: wait (up to 5 s) until it has drawn some
    for (let i = 0; i < 50 && !levelBox().querySelector("[data-k-id]"); i++) await sleep(100);
    await sleep(150);
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
      const ord = can && e.dataset.kOrder !== undefined, n = mediaIn(e).length;
      rows.push(`- ${id} ${kind} "${label}"${on ? "" : " (off screen)"}${ord ? " (orderable)" : ""}${n ? ` (${n > 1 ? n + " players" : "player"}: view_media_play)` : ""}`);
    }
    for (const x of [...((await views.get(level())?.extra?.()) || []), ...((await views.get("*")?.extra?.()) || [])]) {
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

  // ---- fold / open / back: what the user's own fold control, tap and back arrow do
  const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const seen = () => document.visibilityState === "visible";
  async function fold(id, folded) {
    for (const v of [views.get(level()), views.get("*")]) {
      const r = v?.fold && await v.fold(id, folded);
      if (r) return typeof r === "string" ? r : `${folded ? "folded" : "unfolded"} ${id}`;
    }
    const e = need(id);
    if (e.matches("details")) { e.open = !folded; return `${folded ? "folded" : "unfolded"} ${id} "${words(e.dataset.kLabel || e.querySelector("summary")?.textContent, 40)}"`; }
    throw new Error(`${id} (${e.dataset.kKind || "item"}) cannot fold`);
  }
  handle("view", "fold", async ({ target, view, folded }) => {
    await open(view); if (target !== "strip") await reveal([target]);
    const r = await fold(target, folded); await settle(); return r;
  }, accept);
  handle("view", "open", async ({ target, view }) => {
    await open(view); await reveal([target]);
    const e = need(target), label = words(e.dataset.kLabel || e.textContent, 50);
    if (e.matches("details")) { e.open = true; return `opened the "${label}" section`; }
    if (!e.matches("a[href], button, summary")) throw new Error(`${target} (${e.dataset.kKind || "item"}) has no tap action; view_fold unfolds panels and windows, view_focus brings an item forward`);
    e.click(); await settle();
    return `opened ${e.dataset.kKind || "item"} ${target} "${label}"; now at ${location.pathname}`;
  }, a => seen() && accept(a), { claim: true });
  handle("view", "back", async () => {
    const b = [...levelBox().querySelectorAll("header button")].find(x => shown(x) && /(^|\s)[a-z]+-(back|up)(\s|$)/.test(x.className));
    if (!b) throw new Error(`the ${level()} view has no back step (it is the top)`);
    const was = location.pathname; b.click(); await settle();
    return `back from ${was} to ${location.pathname}`;
  }, () => !framed() && seen(), { claim: true });

  // ---- media: the players inside an item, as the user's own taps would drive them
  const allMedia = () => mediaIn(document.body);
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}${s % 1 >= 0.05 ? (s % 1).toFixed(1).slice(1) : ""}`;
  async function playersOf(id, signal) {
    let e = need(id), ps = mediaIn(e);
    if (!ps.length && (e.classList.contains("collapsed") || e.querySelector("iframe"))) {
      if (e.classList.contains("collapsed")) await fold(id, false).catch(() => {});
      for (let i = 0; i < 50 && !ps.length; i++) { await sleep(200, signal); e = find(id) || e; ps = mediaIn(e); }
    }
    if (!ps.length) throw new Error(`${id} holds no audio player`);
    return { e, ps };
  }
  async function ready(a, signal) {
    if (a.preload === "none") a.preload = "metadata";
    if (a.readyState === 0 && a.networkState === HTMLMediaElement.NETWORK_EMPTY) a.load();
    const t0 = performance.now(); // recorded WebM learns its length late (the chat's fixDuration)
    while ((a.readyState < 1 || !Number.isFinite(a.duration) || a.dataset.fixing !== undefined || a.seeking) && performance.now() - t0 < 8000) await sleep(100, signal);
  }
  // no tap on this page yet (phones block sound until one): a pink Play prompt at the player
  function tapToPlay(a, e, signal) {
    return new Promise((ok, no) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "k-fx-play"; b.dataset.tip = "The agent wants to play this: tap to listen";
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span>Play</span>';
      let raf = 0;
      const place = () => {
        const r = (a.isConnected && a.ownerDocument === document && shown(a) ? a : e).getBoundingClientRect();
        b.style.left = Math.min(innerWidth - 60, Math.max(60, r.left + r.width / 2)) + "px";
        // on the player, kept clear of the header and of the stop control above the bar
        // too low (the stop control lives there): just above the player instead
        const mid = r.top + r.height / 2, y = mid <= innerHeight - 160 ? mid : r.top - b.offsetHeight / 2 - 6;
        b.style.top = Math.min(innerHeight - 160, Math.max(60, y)) + "px";
        raf = requestAnimationFrame(place);
      };
      const timer = setTimeout(() => { done(); no(new Error("nobody tapped the Play prompt within 10 minutes")); }, 600000);
      const done = () => { cancelAnimationFrame(raf); clearTimeout(timer); b.remove(); signal.removeEventListener("abort", stop); };
      const stop = () => { done(); no(new Error("stopped")); };
      b.onclick = ev => { ev.stopPropagation(); a.play().then(() => { done(); ok(); }, err => { done(); no(err); }); };
      signal.addEventListener("abort", stop, { once: true });
      root.append(b); place();
    });
  }
  const mediaAccept = a => seen() && accept(a);
  handle("view", "media_play", async ({ target, view, index, from_s, to_s, loop }, signal, say) => {
    await open(view); await reveal([target]);
    const { e, ps } = await playersOf(target, signal), a = ps[index - 1];
    if (!a) throw new Error(`${target} has ${ps.length} player${ps.length > 1 ? "s" : ""}, not ${index}`);
    await scrollTo(target, "center").catch(() => {});
    await ready(a, signal);
    if (from_s >= 0) {
      if (Number.isFinite(a.duration) && from_s >= a.duration) throw new Error(`from_s ${from_s} is past the end (${fmt(a.duration)})`);
      a.currentTime = from_s;
    }
    const start = a.currentTime;
    if (to_s && to_s <= start) throw new Error(`to_s ${to_s} is not after the start (${fmt(start)})`);
    for (const o of allMedia()) if (o !== a && !o.paused) o.pause();
    let tapped = false;
    try { await a.play(); } catch (err) {
      if (err?.name !== "NotAllowedError") throw err;
      // the prompt goes on the player: let the scroll to it finish first
      // (images above load late and push it away: re-aim until it stays in view)
      const box = () => (a.isConnected && a.ownerDocument === document && shown(a) ? a : e).getBoundingClientRect();
      for (let k = 0; k < 4; k++) {
        let y = NaN; for (let i = 0; i < 15; i++) { const n = box().top; if (n === y) break; y = n; await sleep(100, signal); }
        const r = box(); if (r.top >= 0 && r.bottom <= innerHeight) break;
        (a.ownerDocument === document && shown(a) ? a : e).scrollIntoView({ block: "center" }); await sleep(150, signal);
      }
      say(`waiting for a tap: this page has had no tap yet (the browser blocks sound), so a pink Play prompt shows at ${target}`);
      await tapToPlay(a, e, signal); tapped = true;
    }
    const what = `${target}${ps.length > 1 ? ` player ${index}` : ""} from ${fmt(a.currentTime)}${to_s ? ` to ${fmt(to_s)}` : ""}${loop ? ", on loop" : ""}`;
    say(`playing ${what}${tapped ? " (after the user's tap)" : ""}`);
    let mine = false; // our own pause, not the user's
    const why = await new Promise(ok => {
      const iv = setInterval(() => {
        if (!to_s || a.currentTime < to_s) return;
        if (loop) a.currentTime = start; else { mine = true; a.pause(); end("reached the end of the stretch"); }
      }, 40);
      const onPause = () => {
        if (mine) return;
        if (a.ended && loop) { a.currentTime = start; a.play().catch(() => end("could not repeat")); return; }
        end(a.ended ? "played to the end" : "paused (by the user or media_pause)");
      };
      const onAbort = () => { mine = true; a.pause(); end("stopped"); };
      const end = r => { clearInterval(iv); a.removeEventListener("pause", onPause); signal.removeEventListener("abort", onAbort); ok(r); };
      a.addEventListener("pause", onPause);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return `played ${what}${tapped ? " after the user's tap" : ""}: ${why} at ${fmt(a.currentTime)}`;
  }, mediaAccept, { claim: true });
  handle("view", "media_pause", async ({ target, view, index }) => {
    await open(view);
    const ps = target ? (await playersOf(target)).ps : allMedia();
    const pick = target && index ? [ps[index - 1]].filter(Boolean) : ps;
    const on = pick.filter(a => !a.paused);
    on.forEach(a => a.pause());
    return on.length ? `paused ${on.length} player${on.length > 1 ? "s" : ""}${target ? ` in ${target}` : ""}` : "nothing was playing";
  }, a => !framed() && (!a.target || accept(a)));
  handle("view", "media_seek", async ({ target, view, index, to_s }) => {
    await open(view); await reveal([target]);
    const { ps } = await playersOf(target), a = ps[index - 1];
    if (!a) throw new Error(`${target} has ${ps.length} player${ps.length > 1 ? "s" : ""}, not ${index}`);
    await ready(a);
    if (Number.isFinite(a.duration) && to_s > a.duration) throw new Error(`to_s ${to_s} is past the end (${fmt(a.duration)})`);
    a.currentTime = to_s;
    return `moved ${target}${ps.length > 1 ? ` player ${index}` : ""} to ${fmt(to_s)} (${a.paused ? "paused" : "playing"})`;
  }, mediaAccept, { claim: true });
}

/** every <audio>/<video> inside an element, also inside its same-origin frames */
function mediaIn(el) {
  const out = [...el.querySelectorAll("audio, video")];
  for (const f of el.querySelectorAll("iframe")) { try { if (f.contentDocument) out.push(...mediaIn(f.contentDocument.documentElement)); } catch { /* another origin */ } }
  return out;
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
