// Balance (plugin id limits): a composed modality, read only. Money balances
// first (one box each: amount, last check, facts such as running instances),
// then what is left of each AI subscription (GET /p/limits/limits, see
// server.ts): one outlined box per provider, one bar per window. Numbers and bars show REMAINING % (100 = a
// fresh window, falls to 0), like 1.0 and the desktop bar widgets; the week
// comes first (the main quota, thicker bar). 20 % or less = the attention
// accent; a stale reading is dimmed. Refreshes every minute while visible.
// The embedded chat underneath talks about the view; it has no actions.
const ME = "limits";
const BACK = "‹";
const LOW = 20, EVERY = 60000;
const REFRESH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/></svg>';

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
const two = n => String(n).padStart(2, "0");
// reset time: today 'HH:MM', within a week 'Sun HH:MM', later '14 Nov'
function at(t) {
  const d = new Date(t * 1000), now = new Date(), hm = two(d.getHours()) + ":" + two(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return hm;
  if (t - now / 1000 < 6.5 * 86400) return d.toLocaleDateString("en-GB", { weekday: "short" }) + " " + hm;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
// countdown: '2 h 13 min' / '4 d 6 h' / '12 min'
function left(t) {
  const s = Math.max(0, t - Date.now() / 1000), d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return s < 60 ? "now" : d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`;
}
const hm = t => { const d = new Date(t * 1000); return two(d.getHours()) + ":" + two(d.getMinutes()); };
const money = (a, c) => c === "USD" ? "$" + a.toFixed(2) : `${a.toFixed(2)} ${c || ""}`.trim();
const ago = t => { const s = Date.now() / 1000 - t; return s < 90 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago"; };
const wname = w => w.name || (w.label === "5h" ? "Session" : w.label === "7d" ? "Week" : w.label);
// week first (the main quota), then the rest in their order
const ordered = ws => { const i = ws.findIndex(w => w.label === "7d"); return i < 0 ? ws : [ws[i], ...ws.filter((_, k) => k !== i)]; };

export function mount(box, ctx) {
  const st = { data: null, err: "", timer: 0 };
  const back = h("button", { class: "rl-back", type: "button", "data-tip": "All modalities", "aria-label": "All modalities", onclick: () => ctx.levels.up() }, BACK);
  const again = h("button", { class: "rl-ic", type: "button", "data-tip": "Check again now", "aria-label": "Check again now", onclick: () => load() }, svg(REFRESH));
  const body = h("div", { class: "rl-body" });
  box.append(h("header", { class: "rl-bar" }, back, h("b", { class: "rl-title" }, "Balance"), again), body);

  function bar(w, stale, main) {
    const na = w.left == null;
    const lvl = na || stale ? "dim" : Math.round(w.left) <= LOW ? "low" : "ok";
    const name = wname(w);
    return h("div", { class: `rl-w${main ? " main" : ""} ${lvl}`, "data-k-id": `${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"), "data-k-kind": "window", "data-k-label": name },
      h("p", { class: "rl-wl" }, h("span", {}, name, h("small", {}, w.label)),
        h("b", {}, na ? (w.note || "not reported") : `${Math.round(w.left)}% left`)),
      h("div", { class: "rl-meter", role: "meter", "aria-label": `${name} remaining`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": na ? null : String(Math.round(w.left)),
        "data-tip": na ? "The provider sent no value for this window" : `${Math.round(w.left)}% of the ${name.toLowerCase()} limit left` },
        na ? null : h("i", { style: `width:${w.left}%` })),
      h("p", { class: "rl-wr" }, na ? "the provider sent no value for this window" : w.resets_at ? `resets ${at(w.resets_at)} · in ${left(w.resets_at)}` : "reset time unknown"));
  }
  function credit(b) {
    return h("section", { class: `rl-p rl-m${b.stale || b.error ? " dim" : ""}`, "data-k-id": b.id, "data-k-kind": "balance", "data-k-label": b.name },
      h("p", { class: "rl-ph" }, h("b", {}, b.name),
        b.stale ? h("span", { class: "rl-flag", "data-tip": "The last reading is old; the fetcher may be stuck" }, "stale") : null,
        b.error ? h("span", { class: "rl-flag" }, b.error) : null),
      b.amount == null ? null : h("p", { class: "rl-amt", "data-tip": `${b.name} balance` }, money(b.amount, b.currency)),
      b.facts.map(f => h("p", { class: "rl-fact" }, h("span", {}, f.label), h("b", {}, String(f.value)))),
      b.updated_at ? h("p", { class: "rl-wr" }, `checked ${hm(b.updated_at)} · ${ago(b.updated_at)}`) : null);
  }
  function draw() {
    const d = st.data;
    if (!d) { body.replaceChildren(h("p", { class: "rl-note" }, st.err ? `Could not load: ${st.err}` : "…")); return; }
    const bals = d.balances || [];
    if (!d.providers.length && !bals.length) { body.replaceChildren(h("p", { class: "rl-note" }, "No sources configured (plugins.limits.balances, plugins.limits.sources).")); return; }
    body.replaceChildren(...bals.map(credit), ...d.providers.map(p => h("section", { class: "rl-p", "data-k-id": p.id, "data-k-kind": "subscription", "data-k-label": p.name },
      h("p", { class: "rl-ph" }, h("b", {}, p.name),
        p.plan ? h("span", { class: "rl-plan" }, p.plan) : null,
        p.stale ? h("span", { class: "rl-flag", "data-tip": "The last reading is old; the fetcher may be stuck" }, "stale") : null,
        p.error ? h("span", { class: "rl-flag" }, p.error) : null,
        p.updated_at ? h("small", { class: "rl-upd" }, `updated ${ago(p.updated_at)}`) : null),
      ordered(p.windows).map((w, i) => bar(w, p.stale, i === 0 && w.label === "7d")))),
      h("p", { class: "rl-note" }, `checked ${ago(d.fetched_at)} · refreshes every minute`));
  }
  async function load() {
    try { st.data = await ctx.api(`/p/${ME}/limits`); st.err = ""; }
    catch (e) { st.err = e.message || String(e); }
    draw();
  }
  const visible = () => !!box.getClientRects().length && !document.hidden;
  const tick = () => { if (visible()) load(); };
  document.addEventListener("visibilitychange", tick);

  const describe = () => `[Sent from the Sleipnyr Balance modality: read-only money balances and remaining percent of each AI subscription's rate limits. On screen:\n`
    + (st.data?.balances || []).map(b => `- ${b.name}: ${b.amount == null ? b.error || "no data" : money(b.amount, b.currency)}${b.stale ? " (stale)" : ""}`
      + b.facts.map(f => `, ${f.label} ${f.value}`).join("") + (b.updated_at ? `, checked ${new Date(b.updated_at * 1000).toString()}` : "") + "\n").join("")
    + (st.data?.providers || []).map(p => `- ${p.name}${p.plan ? ` (${p.plan})` : ""}${p.error ? `: ${p.error}` : ""}${p.stale ? " (stale)" : ""}`
      + p.windows.map(w => `\n  ${wname(w)} ${w.label}: ${w.left == null ? "not reported" : Math.round(w.left) + "% left"}${w.resets_at ? `, resets ${new Date(w.resets_at * 1000).toString()}` : ""}`).join("")).join("\n")
    + `\nThis chat is the Balance view's own history. Reply briefly. The view has no actions.]`;
  const run = async () => { throw new Error("this view has no actions"); };

  let chat = null;
  ctx.bar.offer({ id: ME, label: () => "Balance", shown: () => !!box.getClientRects().length,
    placeholder: () => "Ask about the balances",
    busy: () => !!chat?.busy?.(),
    send: b => { if (!chat) throw new Error("no conversation here"); return chat.send(b); } });
  ctx.levels.onChange(level => {
    clearInterval(st.timer);
    if (level !== ME) return;
    chat = ctx.embed(ME, box, { title: "Balance conversation", from: "balance", describe, run });
    ctx.bar.focus(ME);
    load();
    st.timer = setInterval(tick, EVERY);
  });
  draw();
}
