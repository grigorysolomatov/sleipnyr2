// Projects: a composed modality (trial). A list of projects; each opens its
// dashboard page. The list comes from the config (GET /p/projects/list);
// the dashboards are placeholders for now: the shape of the level, not the
// content. Mounted by the shell's levels (manifest `modality`): mount(box, ctx),
// own place = the open project (ctx.levels.go("projects", id)).
// Its conversation sits in the embedded chat under the list (ctx.embed), and
// the bar talks to it; replies may carry "@open <project id>" / "@back".
import { ONE_SENTENCE, runs } from "/web/hcp.js";
import { backButton } from "/web/head.js";
let PROJECTS = [], loaded = false; // filled from the config at mount
const PANELS = ["Status", "Next steps", "Recent threads", "Files"];

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

export function mount(box, ctx) {
  const ME = "projects";
  const st = { open: "", last: "" };
  const title = h("b", { class: "pj-title" });
  const back = backButton({ cls: "pj-back", onclick: () => (st.open ? ctx.levels.go(ME, "") : ctx.levels.up()) });
  const body = h("div", { class: "pj-body" });
  box.append(h("header", { class: "pj-bar" }, back, title), body);

  function draw() {
    const p = PROJECTS.find(x => x.id === st.open);
    if (st.open && !p && loaded) { st.open = ""; }
    const tip = p ? "All projects" : "All modalities";
    back.dataset.tip = tip; back.setAttribute("aria-label", tip);
    if (!p) {
      title.textContent = "Projects";
      body.replaceChildren(h("ul", { class: "pj-list", role: "list" }, PROJECTS.map(x => h("li", {},
        h("a", { href: `/m/${ME}/${x.id}`, "data-id": x.id, "data-k-id": x.id, "data-k-kind": "project", class: x.id === st.last ? "k-row here" : "k-row", "data-tip": `Open ${x.title}`,
          onclick: e => { e.preventDefault(); ctx.levels.go(ME, x.id); } },
          h("b", {}, x.title), h("small", {}, x.doc))))));
    } else {
      title.textContent = p.title;
      body.replaceChildren(h("div", { class: "pj-dash" },
        h("p", { class: "pj-note" }, `${p.doc}. Placeholder dashboard: the panels come later.`),
        h("div", { class: "pj-grid" }, PANELS.map(n => h("section", { class: "pj-card", "data-tip": `${n} (placeholder)`, "data-k-id": `panel-${n.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, "data-k-kind": "dashboard panel", "data-k-label": n },
          h("b", {}, n), h("small", {}, "nothing here yet"))))));
    }
  }

  const describe = () => {
    const p = PROJECTS.find(x => x.id === st.open);
    return `[Sent from the Sleipnyr Projects modality (trial, placeholder data). `
      + (p ? `On screen: the dashboard of project ${p.id} | ${p.title} (placeholder panels: ${PANELS.join(", ")}).`
        : `On screen: the project list (id | title | what it is):\n${PROJECTS.map(x => `- ${x.id} | ${x.title} | ${x.doc}`).join("\n")}`)
      + `\nThis chat is the Projects view's own history; the view acts on your reply. `
      + `${ONE_SENTENCE}, then one line per action, exactly:\n`
      + `@open <project id>   (show that project's dashboard)\n@back   (back to the project list)\n`
      + `${runs("view")} Use only ids listed above. Never delete anything.]`;
  };
  const run = async (name, args) => {
    const id = String(args).trim().split(/\s+/)[0];
    if (name === "open") { if (!PROJECTS.some(x => x.id === id)) throw new Error("no such project"); ctx.levels.go(ME, id); return `open ${id}`; }
    if (name === "back") { ctx.levels.go(ME, ""); return "back"; }
    throw new Error("unknown command");
  };

  // agent hooks (kernel view_* tools): a project row is known while its
  // dashboard is open; view_focus / view_scroll_to on it goes back to the list
  ctx.actions?.view?.(ME, {
    has: id => !!st.open && PROJECTS.some(x => x.id === id),
    extra: () => st.open ? PROJECTS.map(x => ({ id: x.id, kind: "project", label: x.title,
      note: "in the project list behind this dashboard; view_focus goes back to it" })) : [],
    focus: async id => {
      if (!st.open || !PROJECTS.some(x => x.id === id)) return false;
      await ctx.levels.go(ME, "");
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return false; // the row is drawn now: the kernel scrolls to it and pulses it
    },
  });

  let chat = null;
  ctx.bar.offer({ id: ME, label: () => PROJECTS.find(x => x.id === st.open)?.title || "Projects", shown: () => !!box.getClientRects().length,
    placeholder: () => "Ask Projects: open a project",
    busy: () => !!chat?.busy?.(),
    send: b => { if (!chat) throw new Error("no conversation here"); return chat.send(b); } });
  ctx.levels.onChange((level, sub) => {
    if (level !== ME) return;
    st.open = sub || "";
    if (st.open) st.last = st.open;
    draw();
    chat = ctx.embed(ME, box, { title: "Projects conversation", from: "projects", describe, run });
    ctx.bar.focus(ME);
  });
  draw();
  ctx.api("/p/projects/list").then(list => { PROJECTS = list; loaded = true; draw(); }).catch(() => {});
}
