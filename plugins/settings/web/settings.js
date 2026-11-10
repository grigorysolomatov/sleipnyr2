// Settings: a composed modality for the app's settings by hand, no agent needed.
// Sections: Theme (below), Features (the app's on/off switches) and Data
// (whether archived things may be deleted for good). Features and Data are the
// kernel's settings item (GET/PATCH /k/settings); every open page follows a
// change live. Theme:
// One row per token (what it means, a swatch that opens the colour picker,
// the hex value, back-to-default); sizes as steppers. A change shows at once
// everywhere on this page (CSS variables on <html>), is saved to the active
// theme item shortly after (PATCH /p/settings/tokens, checked on the server),
// and other open pages restyle through the kernel's "styles" event.
// The embedded chat underneath talks to the view: @set / @reset / @feature /
// @allow-delete lines.
import { ONE_SENTENCE, runs } from "/web/hcp.js";
import { backButton } from "/web/head.js";
const ME = "settings";
const API = "/p/settings";
const RESET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></svg>';

// what each token means, in plain words; the order is the order on screen
const GROUPS = [
  ["Accents", [
    ["accent-here", "Here", "Where you are: the open thread, the selection, you"],
    ["accent-attention", "Attention", "Asks for your attention: the agent's \u201cnew\u201d frames"],
    ["accent-agent", "Agent", "The agent: its name, speaking, working"],
    ["link", "Links", "Links in messages and notes"],
  ]],
  ["Text and lines", [
    ["text", "Text", "Normal text and the white separator lines"],
    ["text-muted", "Quiet text", "Times, details, hints, spinners"],
    ["line", "Faint lines", "Outlines of fields, players and menus"],
  ]],
  ["Backgrounds", [
    ["bg", "Background", "The page behind everything"],
    ["surface", "Raised", "Hovered and selected rows, code"],
  ]],
  ["Shape", [
    ["radius", "Corners", "Roundness of boxes, in pixels", 0, 24],
    ["font-size", "Text size", "Base text size, in pixels", 12, 24],
  ]],
];
// the app's feature switches (others the config names show with their id)
const FEATURES = [
  ["replyPill", "Reply pill", "A pill names the view where the agent replied, tap to go there"],
  ["phoneTarget", "Bar target on the phone", "The bar shows which conversation it sends to, on small screens too"],
  ["recent", "Recent conversations", "The modality list shows the latest conversations at the top"],
  ["panelDecisions", "Panel decisions", "Columns panels can carry Dismiss, Comment and Accept (off by default)"],
  ["recordingContext", "Recording context", "A voice message tells the agent what you looked at and tapped while recording"],
  ["notifications", "Notifications", "Phone notifications for agent replies, finished cards and things that need you"],
];
const ROWS = GROUPS.flatMap(([, rows]) => rows);
const SIZES = new Set(["radius", "font-size"]);
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const full = v => { const s = String(v || "").trim().toLowerCase(); const m = s.match(HEX); return m ? "#" + (m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1]) : null; };

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
  const AG = ctx.app.agentName;
  const st = { tokens: {}, defaults: {}, pending: {}, timer: 0, saving: null, fields: new Map(), app: ctx.settings?.() || { allowDelete: false, features: {} } };
  const pickerMods = () => (ctx.plugins || []).filter(p => p.modality).map(p => ({ id: p.id, title: p.modality.title || p.name }));
  const rootStyle = document.documentElement.style;

  const back = backButton({ cls: "tm-back", tip: "All modalities", onclick: () => ctx.levels.up() });
  const resetAll = h("button", { class: "tm-ic tm-all", type: "button", "data-tip": "Reset everything to the default look", "aria-label": "Reset all", onclick: () => resetEverything() }, svg(RESET));
  const note = h("p", { class: "tm-note", "aria-live": "polite", hidden: true });
  const body = h("div", { class: "tm-body" });
  box.append(h("header", { class: "tm-bar" }, back, h("b", { class: "tm-title" }, "Settings"), resetAll), body, note);
  const say = (t, err = false) => { note.hidden = !t; note.textContent = t || ""; note.classList.toggle("err", err); };

  // ------------------------------------------------------------ preview
  // each accent in use, drawn with the same tokens as the real views
  const preview = h("section", { class: "tm-prev", "aria-label": "Preview", "data-k-id": "preview", "data-k-kind": "preview" },
    h("div", { class: "tm-p-row here", "data-tip": "A selected row: the Here bar" }, h("span", {}, "Open thread"), h("small", {}, "12:40")),
    h("div", { class: "tm-p-row", "data-tip": "A row that is not selected" }, h("span", {}, "Another thread"), h("small", {}, "11:05")),
    h("div", { class: "tm-p-msg" },
      h("p", { class: "tm-p-who" }, h("b", { class: "tm-p-me" }, ctx.user?.name || "You"), h("small", {}, "12:41")),
      h("p", {}, "A message with ", h("a", { href: "#", "data-tip": "A link", onclick: e => e.preventDefault() }, "a link"), ".")),
    h("div", { class: "tm-p-msg" },
      h("p", { class: "tm-p-who" }, h("b", { class: "tm-p-ag" }, AG), h("small", {}, "12:41")),
      h("p", { class: "tm-p-work" }, h("i", { class: "tm-p-spin", "aria-hidden": "true" }), h("small", {}, "0:04 working"))),
    h("div", { class: "tm-p-new", "data-tip": "A panel the agent marked new: the Attention frame" }, "New panel"));

  // ------------------------------------------------------------ rows
  function row([k, name, doc, min, max]) {
    const reset = h("button", { class: "tm-ic tm-reset", type: "button", "aria-label": `${name}: back to default`, onclick: () => change(k, null) }, svg(RESET));
    let ctl, f;
    if (SIZES.has(k)) {
      const val = h("output", { class: "tm-num" });
      const step = d => () => { const n = parseInt(st.tokens[k], 10) + d; if (n >= min && n <= max) change(k, `${n}px`); };
      ctl = h("span", { class: "tm-step" },
        h("button", { class: "tm-sb", type: "button", "data-tip": `Smaller ${name.toLowerCase()}`, "aria-label": `Smaller ${name.toLowerCase()}`, onclick: step(-1) }, "\u2212"),
        val,
        h("button", { class: "tm-sb", type: "button", "data-tip": `Bigger ${name.toLowerCase()}`, "aria-label": `Bigger ${name.toLowerCase()}`, onclick: step(1) }, "+"));
      f = { draw: v => { val.textContent = parseInt(v, 10) + " px"; } };
    } else {
      const pick = h("input", { type: "color", "aria-label": `${name} colour`, oninput: () => change(k, pick.value) });
      const sw = h("label", { class: "tm-sw", "data-tip": `Pick the ${name.toLowerCase()} colour` }, pick);
      const hex = h("input", { class: "tm-hex", type: "text", inputmode: "text", spellcheck: "false", autocomplete: "off", maxlength: "7",
        "aria-label": `${name} hex value`, "data-tip": "Hex colour, like #ff0088",
        oninput: () => { const c = full(hex.value); hex.classList.toggle("bad", !c); if (c) change(k, c); },
        onchange: () => { if (!full(hex.value)) { say(`${hex.value} is not a colour; use #rrggbb.`, true); f.draw(st.tokens[k]); } },
        onkeydown: e => { if (e.key === "Enter") hex.blur(); } });
      sw.style.background = `var(--${k})`;
      f = { draw: v => { pick.value = v; if (document.activeElement !== hex) { hex.value = v; hex.classList.remove("bad"); } } };
      ctl = h("span", { class: "tm-col" }, sw, hex);
    }
    f.reset = reset;
    st.fields.set(k, f);
    return h("li", { class: "tm-row", "data-k-id": k, "data-k-kind": "token", "data-k-label": name },
      h("span", { class: "tm-t" }, h("b", {}, name), h("small", {}, doc)), ctl, reset);
  }
  const list = h("div", { class: "tm-groups" }, GROUPS.map(([title, rows]) =>
    h("section", { class: "tm-group" }, h("p", { class: "tm-gh" }, title), h("ul", { class: "tm-rows", role: "list" }, rows.map(row)))));
  // ------------------------------------------------------------ features + data
  const toggles = new Map(); // key -> {btn, get}
  function toggle(key, name, doc, get, set) {
    const btn = h("button", { class: "tm-tg", type: "button", role: "switch", "aria-label": name,
      onclick: () => set(!get()) }, h("i", { "aria-hidden": "true" }));
    toggles.set(key, { btn, name, get });
    return h("li", { class: "tm-row", "data-k-id": key, "data-k-kind": "setting", "data-k-label": name },
      h("span", { class: "tm-t" }, h("b", {}, name), h("small", {}, doc)), btn);
  }
  const featureNames = () => {
    const known = new Set(FEATURES.map(([k]) => k));
    return [...FEATURES, ...Object.keys(st.app.features || {}).filter(k => !known.has(k)).map(k => [k, k, "A feature switch from the app config"])];
  };
  const featRows = h("ul", { class: "tm-rows", role: "list" });
  const drawFeatureRows = () => featRows.replaceChildren(...featureNames().map(([k, name, doc]) =>
    toggle(`feature.${k}`, name, doc, () => st.app.features?.[k] !== false, on => saveApp({ features: { [k]: on } }))));
  drawFeatureRows();
  // this device's notifications: the permission prompt needs a tap, so it is a button here
  const pushDoc = h("small", {}, "");
  const pushBtns = h("span", { class: "tm-acts" });
  const pushRow = h("li", { class: "tm-row", "data-k-id": "push.device", "data-k-kind": "setting", "data-k-label": "Notifications on this device" },
    h("span", { class: "tm-t" }, h("b", {}, "This device"), pushDoc), pushBtns);
  const act = (label, tip, fn) => h("button", { class: "tm-act", type: "button", "data-tip": tip, onclick: async e => {
    const b = e.currentTarget; b.disabled = true; say("");
    try { await fn(); } catch (err) { say(err.message || String(err), true); }
    b.disabled = false; drawPush();
  } }, label);
  async function drawPush() {
    const p = ctx.push, s = p ? await p.state() : { supported: false };
    if (!s.supported) { pushDoc.textContent = "This browser cannot show notifications (on iPhone: add the app to the home screen first)"; pushBtns.replaceChildren(); return; }
    if (s.perm === "denied") { pushDoc.textContent = "Blocked in the browser: allow notifications for this site in its settings, then reload"; pushBtns.replaceChildren(); return; }
    pushDoc.textContent = s.on ? "Notifications arrive on this device" : "No notifications on this device yet";
    pushBtns.replaceChildren(...(s.on
      ? [act("Test", "Send a test notification to this device", async () => {
          const r = await p.test(); const bad = (r.results || []).filter(x => !x.ok);
          say(bad.length ? `Test not delivered: ${bad.map(x => `${x.host} ${x.status} ${x.error || ""}`).join("; ")}` : "Test sent: it should appear in a few seconds.", !!bad.length);
        }),
        act("Turn off", "Stop notifications on this device", () => p.disable())]
      : [act("Enable", "Ask this device for permission and turn notifications on", async () => { await p.enable(); say("Notifications are on for this device."); })]));
  }
  const pushRows = h("ul", { class: "tm-rows", role: "list" }, pushRow);
  drawPush();
  // Picker: one 'Show in picker' switch per modality (hidden ones stay reachable by address)
  const hiddenIds = () => st.app.pickerHidden || ctx.app?.pickerHidden || [];
  const pickRows = h("ul", { class: "tm-rows", role: "list" });
  const drawPickRows = () => pickRows.replaceChildren(...pickerMods().map(m =>
    toggle(`picker.${m.id}`, m.title, "Show in picker", () => !hiddenIds().includes(m.id),
      on => saveApp({ pickerHidden: [...hiddenIds().filter(x => x !== m.id), ...(on ? [] : [m.id])] }))));
  drawPickRows();
  const dataRows = h("ul", { class: "tm-rows", role: "list" },
    toggle("data.allowDelete", "Allow deleting", "Archived threads get a delete button; deleting is for good",
      () => st.app.allowDelete === true, on => saveApp({ allowDelete: on })));
  const section = (title, ...kids) => h("section", { class: "tm-sec", "data-k-id": `section-${title.toLowerCase()}`, "data-k-kind": "section" },
    h("h2", { class: "tm-sh" }, title), ...kids);
  body.append(
    section("Theme", preview, list),
    section("Features", h("section", { class: "tm-group" }, featRows, pushRows)),
    section("Picker", h("section", { class: "tm-group" }, pickRows)),
    section("Data", h("section", { class: "tm-group" }, dataRows)));

  function drawApp() {
    for (const [, t] of toggles) {
      const on = t.get();
      t.btn.setAttribute("aria-checked", String(on));
      t.btn.dataset.tip = `${t.name}: ${on ? "on, tap to turn off" : "off, tap to turn on"}`;
    }
  }
  async function saveApp(patch) {
    const before = st.app;
    st.app = { ...st.app, ...(patch.allowDelete !== undefined ? { allowDelete: patch.allowDelete } : {}),
      features: { ...st.app.features, ...(patch.features || {}) },
      ...(patch.pickerHidden !== undefined ? { pickerHidden: patch.pickerHidden } : {}) };
    drawApp(); say("");
    try { st.app = await ctx.api("/k/settings", { method: "PATCH", json: patch }); drawApp(); }
    catch (e) { st.app = before; drawApp(); say(`Not saved: ${e.message}`, true); }
  }
  async function loadApp() {
    try { st.app = await ctx.api("/k/settings"); drawFeatureRows(); drawPickRows(); drawApp(); }
    catch (e) { say(`Could not load the settings: ${e.message}`, true); }
  }
  ctx.onSettings?.(s => { st.app = s; drawFeatureRows(); drawPickRows(); drawApp(); });
  drawApp();

  function drawAll() {
    for (const [k, f] of st.fields) {
      const v = st.tokens[k] || st.defaults[k] || "";
      f.draw(v);
      const def = v === st.defaults[k];
      f.reset.disabled = def;
      f.reset.dataset.tip = def ? "Already the default" : `Back to the default (${st.defaults[k]})`;
    }
  }

  // ------------------------------------------------------------ change + save
  // value null = back to the default; shows at once, saves after a short pause
  function change(k, v) {
    const val = v === null ? st.defaults[k] : v;
    if (!val) return;
    st.tokens[k] = val;
    st.pending[k] = v;
    rootStyle.setProperty(`--${k}`, val);
    drawAll(); say("");
    clearTimeout(st.timer);
    st.timer = setTimeout(save, 350);
  }
  async function save() {
    if (st.saving) { await st.saving; }
    const sent = st.pending; st.pending = {};
    if (!Object.keys(sent).length) return;
    st.saving = (async () => {
      try {
        const out = await ctx.api(`${API}/tokens`, { method: "PATCH", json: { tokens: sent } });
        await ctx.restyle?.(ME); // the saved theme is on the page: drop the editing overrides it covers
        for (const k of Object.keys(sent)) if (!(k in st.pending)) rootStyle.removeProperty(`--${k}`);
        st.defaults = out.defaults;
        for (const k of Object.keys(out.tokens)) if (!(k in st.pending)) st.tokens[k] = out.tokens[k];
        drawAll();
      } catch (e) {
        say(`Not saved: ${e.message}`, true);
        for (const k of Object.keys(sent)) rootStyle.removeProperty(`--${k}`);
        await load();
      } finally { st.saving = null; }
    })();
    await st.saving;
  }
  async function load() {
    try {
      const t = await ctx.api(`${API}/tokens`);
      st.tokens = { ...t.tokens, ...Object.fromEntries(Object.keys(st.pending).map(k => [k, st.tokens[k]])) };
      st.defaults = t.defaults;
      drawAll();
    } catch (e) { say(`Could not load the theme: ${e.message}`, true); }
  }
  async function resetEverything() {
    clearTimeout(st.timer); st.pending = {};
    if (st.saving) await st.saving;
    try {
      await ctx.api(`${API}/commands/default-theme`, { method: "POST", json: {} });
      await ctx.restyle?.(ME);
      for (const [k] of ROWS) rootStyle.removeProperty(`--${k}`);
      await load(); say("Back to the default look.");
    } catch (e) { say(`Not reset: ${e.message}`, true); }
  }
  // another page changed the theme: show its values (unless a change here is still on its way)
  ctx.on("item", ({ item }) => { if (item?.type === "theme" && !Object.keys(st.pending).length && !st.saving) load(); });

  // ------------------------------------------------------------ agent
  const describe = () => `[Sent from the Sleipnyr Settings modality: hand settings for the app. Theme values (token | name | value | default):\n`
    + ROWS.map(([k, name]) => `- ${k} | ${name} | ${st.tokens[k]} | ${st.defaults[k]}`).join("\n")
    + `\nFeatures (id | name | on/off):\n` + featureNames().map(([k, name]) => `- ${k} | ${name} | ${st.app.features?.[k] !== false ? "on" : "off"}`).join("\n")
    + `\nData: deleting archived things for good is ${st.app.allowDelete ? "ON" : "OFF"}.`
    + `\nThis chat is the Settings view's own history; the view acts on your reply. ${ONE_SENTENCE}, `
    + `then one line per action, exactly:\n@set <token> <value>   (colours as #rrggbb; radius 0-24, font-size 12-24 as <n>px)\n`
    + `@reset <token>   (back to its default)\n@reset all   (the whole default look)\n@feature <id> on|off\n@allow-delete on|off   (only when the user asks for it in so many words)\n`
    + `${runs("view")} Use only the tokens and feature ids listed. Never delete anything.]`;
  const run = async (name, args) => {
    const [k, v] = String(args).trim().split(/\s+/);
    const onOff = x => { const w = String(x || "").toLowerCase(); if (w === "on" || w === "off") return w === "on"; throw new Error(`say on or off, not ${x}`); };
    if (name === "feature") {
      if (!featureNames().some(([f]) => f === k)) throw new Error(`no feature ${k}`);
      await saveApp({ features: { [k]: onOff(v) } }); return `feature ${k} ${v}`;
    }
    if (name === "allow-delete") { await saveApp({ allowDelete: onOff(k) }); return `allow-delete ${k}`; }
    if (name === "reset" && k === "all") { await resetEverything(); return "reset all"; }
    if (!st.fields.has(k)) throw new Error(`no token ${k}`);
    if (name === "reset") { change(k, null); await save(); return `reset ${k}`; }
    if (name !== "set") throw new Error("unknown command");
    const val = SIZES.has(k) ? (/^\d{1,2}(px)?$/.test(v || "") ? parseInt(v, 10) + "px" : null) : full(v);
    if (!val) throw new Error(`bad value ${v}`);
    change(k, val); await save(); return `set ${k} ${val}`;
  };

  let chat = null;
  ctx.bar.offer({ id: ME, label: () => "Settings", shown: () => !!box.getClientRects().length,
    placeholder: () => "Ask for a setting",
    busy: () => !!chat?.busy?.(),
    send: b => { if (!chat) throw new Error("no conversation here"); return chat.send(b); } });
  ctx.levels.onChange(level => {
    if (level !== ME) return;
    chat = ctx.embed(ME, box, { title: "Settings conversation", from: "settings", describe, run });
    ctx.bar.focus(ME);
    load(); loadApp();
  });
  load(); loadApp();
}
