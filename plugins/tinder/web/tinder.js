// Task Tinder: a composed modality. The agent suggests tasks (one turn in this
// view's own conversation, started by the spark button: the agent is off until
// then); they come as a card stack. Swipe right = accept (queued as a Kanban
// card that runs), left = reject (kept, sinks, comes back later). Arrow keys
// on a desktop. Comments go through the modality bar into the embedded chat
// underneath and feed the next round. Replies carry "@suggest ..." lines.
const BACK = "‹";
const SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5"/></svg>';
const API = "/p/tinder";
const ME = "tinder";

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

export function mount(box, ctx) {
  const WHO = ctx.user?.name || "the user", AG = ctx.app?.agentName || "the agent";
  // tiers, default board and idea sources come from the server config (plugins.tinder)
  let conf = null;
  const settings = async () => conf || (conf = await ctx.api(`${API}/settings`).catch(() => ({ tiers: {}, defaultTier: "", defaultBoard: "default", assignee: "default", sources: "", apiUrl: "http://127.0.0.1:8180" })));
  const st = { cards: [], counts: {}, busy: false, note: "", asked: false, front: "" };
  // a card the agent brought to the top (view_focus): stays there on this page until decided
  const lift = () => { const i = st.cards.findIndex(c => c.id === st.front); if (i > 0) st.cards.unshift(...st.cards.splice(i, 1)); else if (i < 0) st.front = ""; };
  const back = h("button", { class: "tt-back", type: "button", "data-tip": "All modalities", "aria-label": "All modalities", onclick: () => ctx.levels.up() }, BACK);
  const go = h("button", { class: "c-btn c-ic tt-go", type: "button", "data-tip": `Ask ${AG} for task suggestions`, "aria-label": `Ask ${AG} for task suggestions`,
    onclick: () => activate() }, svg(SPARK));
  const stack = h("div", { class: "tt-stack" });
  const note = h("p", { class: "tt-note", "aria-live": "polite" });
  box.append(h("header", { class: "tt-bar" }, back, h("b", { class: "tt-title" }, "Task Tinder"), go), h("div", { class: "tt-body" }, stack, note));

  const say = (t, err = false) => { note.textContent = t; note.classList.toggle("err", err); };
  const meta = c => [c.data.board, TIER[c.data.tier] || c.data.tier, c.data.cost].filter(Boolean).join(" · ");

  function draw() {
    const [top, next] = st.cards;
    if (!top) {
      stack.replaceChildren(h("div", { class: "tt-empty" }, st.asked ? `Waiting for ${AG}'s suggestions…`
        : `No suggestions. Tap the spark to ask ${AG} for some.`));
      return;
    }
    const card = c => h("article", { class: "tt-card", "data-id": c.id, "data-k-id": c.id, "data-k-kind": "suggestion", "data-k-label": c.data.title },
      h("b", { class: "tt-t" }, c.data.title), c.data.why ? h("p", { class: "tt-why" }, c.data.why) : null,
      h("small", { class: "tt-meta" }, meta(c)),
      c.data.rejects ? h("small", { class: "tt-meta" }, `rejected ${c.data.rejects}× before`) : null,
      h("span", { class: "tt-stamp yes" }, "Accept"), h("span", { class: "tt-stamp no" }, "Reject"));
    const t = card(top);
    t.classList.add("top");
    stack.replaceChildren(...[next ? card(next) : null, t].filter(Boolean),
      h("small", { class: "tt-hint" }, `← reject · accept →   (${st.cards.length} in the stack)`));
    drag(t, top);
  }

  async function load() {
    try { const q = await ctx.api(`${API}/queue`); st.cards = q.cards; st.counts = q.counts; lift(); } catch (e) { say(`Could not load: ${e.message}`, true); }
    if (!st.busy) draw();
  }

  // swipe: the top card follows the finger; far enough (or a fling) decides
  function drag(el, c) {
    let x0 = 0, y0 = 0, dx = 0, t0 = 0, id = null;
    const set = (x, anim) => {
      el.style.transition = anim ? "transform .25s ease-out" : "none";
      el.style.transform = `translateX(${x}px) rotate(${x / 22}deg)`;
      el.style.setProperty("--yes", String(Math.max(0, Math.min(1, x / 110))));
      el.style.setProperty("--no", String(Math.max(0, Math.min(1, -x / 110))));
    };
    el.addEventListener("pointerdown", e => { if (st.busy) return; id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = 0; t0 = performance.now(); el.setPointerCapture(id); });
    el.addEventListener("pointermove", e => { if (e.pointerId !== id) return; dx = e.clientX - x0; if (Math.abs(dx) > Math.abs(e.clientY - y0) || Math.abs(dx) > 8) set(dx); });
    const up = e => {
      if (e.pointerId !== id) return;
      id = null;
      const v = Math.abs(dx) / Math.max(1, performance.now() - t0), far = Math.abs(dx) > Math.min(130, el.offsetWidth * 0.33);
      if (far || (v > 0.6 && Math.abs(dx) > 40)) decide(c, dx > 0 ? "accept" : "reject", el); else set(0, true);
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", e => { if (e.pointerId === id) { id = null; set(0, true); } });
    el.fly = (x) => set(x, true);
  }

  async function decide(c, verdict, el = stack.querySelector(".tt-card.top")) {
    if (st.busy || !c) return;
    st.busy = true;
    if (st.front === c.id) st.front = "";
    el?.fly?.((verdict === "accept" ? 1 : -1) * (innerWidth + 60));
    say(verdict === "accept" ? "Queuing it as a Kanban card…" : "");
    try {
      const out = await ctx.api(`${API}/${encodeURIComponent(c.id)}/${verdict}`, { method: "POST", json: {} });
      const tier = (await settings()).tiers[out.item.data.tier]?.label || out.item.data.tier;
      say(verdict === "accept" ? `Queued: card ${out.card} on board ${out.item.data.board} (runs on ${tier}).`
        : `Rejected: it sinks and may come back later.`);
    } catch (e) { say(`Could not ${verdict}: ${e.message}`, true); }
    await new Promise(r => setTimeout(r, 250));
    st.busy = false;
    await load();
  }

  addEventListener("keydown", e => {
    if (ctx.levels.current() !== ME || e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); decide(st.cards[0], e.key === "ArrowRight" ? "accept" : "reject"); }
  });

  const describe = async () => {
    let q = { cards: [], counts: {} }, past = [];
    try { [q, past] = await Promise.all([ctx.api(`${API}/queue`), ctx.api(`${API}/history`)]); } catch { /* empty */ }
    const c = await settings();
    const tiers = Object.entries(c.tiers).map(([id, t]) => `${id} (${t.label}${id === c.defaultTier ? ", default" : ""}${t.doc ? `; ${t.doc}` : ""})`).join(" or ");
    const line = s => `- ${s.data.title} | ${s.data.board} | ${s.data.tier} | ${s.data.cost || "?"}`;
    const verdicts = past.map(s => `- ${s.data.state === "accepted" ? "ACCEPTED" : `REJECTED ${s.data.rejects}x`} | ${s.data.title} | why: ${s.data.why || "-"}`);
    return `[Sent from the Sleipnyr Task Tinder modality: ${WHO} swipes your task suggestions, right = accept (it becomes `
      + `a Kanban card with assignee ${c.assignee} that runs at once), left = reject (kept, sinks, may come back later). `
      + `This chat is Task Tinder's own history; the view acts on your reply.\n`
      + `In the stack now (title | board | tier | cost):\n${q.cards.map(line).join("\n") || "(empty)"}\n`
      + `${WHO}'s verdicts so far, newest first (learn what they appreciate):\n${verdicts.join("\n") || "(none yet)"}\n`
      + `When asked for suggestions, look at ${WHO}'s recent Sleipnyr threads (curl -s ${c.apiUrl}/p/chat/threads) `
      + `and the Kanban boards (hermes kanban boards list; hermes kanban --board <slug> list)${c.sources ? `, also ${c.sources}` : ""}, then propose `
      + `3 to 6 concrete, self-contained tasks an agent can finish alone, each one line. Skip anything already in the stack, accepted, `
      + `or rejected unless asked again. Email or contact tasks are drafts only (no sending without ${WHO}'s per-message OK).\n`
      + `Reply with ONE short sentence (at most 12 words, shown on a single line), then one line per suggestion, exactly:\n`
      + `@suggest <board slug> | <tier> | <rough cost> | <title, at most 10 words> | <why, one short line>\n`
      + `tier = ${tiers || "default"}. Rough cost like "~20 min, ~3% of 5h". `
      + `Pick an existing board slug that fits the project (${c.defaultBoard} if none). The view runs these lines itself and does not `
      + `show them: do not create cards or call any API for them. When ${WHO} only comments, answer in one sentence and suggest only if asked. Never delete anything.]`;
  };
  const run = async (name, args) => {
    if (name !== "suggest") throw new Error("unknown command");
    const [board, tier, cost, title, why] = String(args).split("|").map(s => s.trim());
    const out = await ctx.api(`${API}/suggest`, { json: { board, tier, cost, title, why } });
    await load();
    return out.merged ? `merged ${out.item.id}${out.skipped ? ` (${out.skipped})` : ""}` : `suggest ${out.item.id}`;
  };

  // agent hooks (kernel view_* tools): only the top two cards are drawn, so a
  // card deeper in the stack is known (has), listed (extra) and brought to
  // the top on view_focus / view_scroll_to; marks then land on it
  ctx.actions?.view?.(ME, {
    has: id => st.cards.some(c => c.id === id),
    extra: () => st.cards.slice(2).map((c, i) => ({ id: c.id, kind: "suggestion", label: c.data.title,
      note: `card ${i + 3} of ${st.cards.length} in the stack, not drawn; view_focus brings it to the top` })),
    focus: async id => {
      if (!st.cards.some(c => c.id === id)) return false;
      if (st.cards[0]?.id !== id && !st.busy) { st.front = id; lift(); draw(); }
      return true;
    },
  });

  let chat = null;
  async function activate() {
    if (!chat) return;
    st.asked = true; draw(); say("");
    try { await chat.send({ text: "Suggest tasks for me.", files: [] }); }
    catch (e) { st.asked = false; draw(); say(`Not sent: ${e.message}`, true); }
  }
  ctx.bar.offer({ id: ME, label: () => "Task Tinder", shown: () => !!box.getClientRects().length,
    placeholder: () => "Comment on the suggestions",
    busy: () => !!chat?.busy?.(),
    send: b => { if (!chat) throw new Error("no conversation here"); return chat.send(b); } });
  ctx.on("item", ({ item }) => {
    if (item?.type === "suggestion" && !st.busy) load();
    if (item?.type === "message" && item.data?.role === "agent" && ["done", "error"].includes(item.data.status) && st.asked) { st.asked = false; if (!st.cards.length) draw(); }
  });
  ctx.levels.onChange(level => {
    if (level !== ME) return;
    chat = ctx.embed(ME, box, { title: "Task Tinder conversation", hint: "Ask for suggestions with the spark, or comment with the bar below",
      from: "task tinder", describe, run });
    ctx.bar.focus(ME);
    load();
  });
  draw();
}
