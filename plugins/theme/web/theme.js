// Theme: a composed modality for setting the look by hand, no agent needed.
// One row per token (what it means, a swatch that opens the colour picker,
// the hex value, back-to-default); sizes as steppers. A change shows at once
// everywhere on this page (CSS variables on <html>), is saved to the active
// theme item shortly after (PATCH /p/theme/tokens, checked on the server),
// and other open pages restyle through the kernel's "styles" event.
// The embedded chat underneath talks to the view: @set / @reset lines.
const ME = "theme";
const API = "/p/theme";
const BACK = "‹";
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
  const st = { tokens: {}, defaults: {}, pending: {}, timer: 0, saving: null, fields: new Map() };
  const rootStyle = document.documentElement.style;

  const back = h("button", { class: "tm-back", type: "button", "data-tip": "All modalities", "aria-label": "All modalities", onclick: () => ctx.levels.up() }, BACK);
  const resetAll = h("button", { class: "tm-ic tm-all", type: "button", "data-tip": "Reset everything to the default look", "aria-label": "Reset all", onclick: () => resetEverything() }, svg(RESET));
  const note = h("p", { class: "tm-note", "aria-live": "polite", hidden: true });
  const body = h("div", { class: "tm-body" });
  box.append(h("header", { class: "tm-bar" }, back, h("b", { class: "tm-title" }, "Theme"), resetAll), body, note);
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
  body.append(preview, list);

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
  const describe = () => `[Sent from the Sleipnyr Theme modality: hand settings for the app's look. Current values (token | name | value | default):\n`
    + ROWS.map(([k, name]) => `- ${k} | ${name} | ${st.tokens[k]} | ${st.defaults[k]}`).join("\n")
    + `\nThis chat is the Theme view's own history; the view acts on your reply. Reply with ONE short sentence (at most 12 words, `
    + `shown on a single line), then one line per action, exactly:\n@set <token> <value>   (colours as #rrggbb; radius 0-24, font-size 12-24 as <n>px)\n`
    + `@reset <token>   (back to its default)\n@reset all   (the whole default look)\n`
    + `The view runs these lines itself and does not show them: do not call any tool or API for them. Use only the tokens listed. Never delete anything.]`;
  const run = async (name, args) => {
    const [k, v] = String(args).trim().split(/\s+/);
    if (name === "reset" && k === "all") { await resetEverything(); return "reset all"; }
    if (!st.fields.has(k)) throw new Error(`no token ${k}`);
    if (name === "reset") { change(k, null); await save(); return `reset ${k}`; }
    if (name !== "set") throw new Error("unknown command");
    const val = SIZES.has(k) ? (/^\d{1,2}(px)?$/.test(v || "") ? parseInt(v, 10) + "px" : null) : full(v);
    if (!val) throw new Error(`bad value ${v}`);
    change(k, val); await save(); return `set ${k} ${val}`;
  };

  let chat = null;
  ctx.bar.offer({ id: ME, label: () => "Theme", shown: () => !!box.getClientRects().length,
    placeholder: () => "Ask for colours",
    busy: () => !!chat?.busy?.(),
    send: b => { if (!chat) throw new Error("no conversation here"); return chat.send(b); } });
  ctx.levels.onChange(level => {
    if (level !== ME) return;
    chat = ctx.embed(ME, box, { title: "Theme conversation", from: "theme", describe, run });
    ctx.bar.focus(ME);
    load();
  });
  load();
}
