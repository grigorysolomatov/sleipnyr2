// A modality's own list of items (Columns boards, later others), shaped like
// the thread list: one row per item, title left, last change right, newest
// first, pink = the one open last. Tap opens it; hidden items wait under
// "Archived". The modality owns the data and the header; this only draws.
//
//   const list = itemList({ word: "board", href: it => url, open: it => ...,
//                           title: it => text, summary: it => text });
//   box.append(list.el); list.draw(items, here);

const when = t => {
  const d = new Date(Number(t)), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
};
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

export function itemList({ word = "item", agent = "the agent", href, open, title, summary }) {
  const el = h("ul", { class: "k-items", role: "list" });
  const row = (it, here) => h("li", {},
    h("a", { href: href(it), "data-id": it.id, "data-k-id": it.id, "data-k-kind": word,
      class: it.id === here ? "here" : null, "data-tip": summary ? summary(it) : `Open ${title(it)}`,
      onclick: e => { e.preventDefault(); open(it); } },
      h("span", { class: "k-it-t" }, title(it)),
      h("time", {}, when(it.updated))));
  function draw(items, here = "") {
    const newest = [...items].sort((a, b) => Number(b.updated) - Number(a.updated));
    const shown = newest.filter(it => !it.data.hidden), hidden = newest.filter(it => it.data.hidden);
    el.replaceChildren(...[...shown.map(it => row(it, here)),
      shown.length ? null : h("li", { class: "k-it-empty" }, `No ${word}s yet. Tap + for a new one.`),
      hidden.length ? h("li", { class: "k-it-arch" }, h("details", {},
        h("summary", { "data-tip": `Hidden ${word}s; ask ${agent} to bring one back` }, `Archived (${hidden.length})`),
        h("ul", { class: "k-items", role: "list" }, hidden.map(it => row(it, here))))) : null].filter(Boolean));
  }
  return { el, draw };
}
