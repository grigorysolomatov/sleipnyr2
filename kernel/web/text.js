// A small, safe Markdown subset -> DOM nodes (never innerHTML):
// ``` code blocks ```, `code`, **bold**, *italic*, [text](https://link),
// [text](/same-origin/path) links (e.g. /k/files/<id>), bare https:// links, "- " / "1. " lists (indented lines = item details), "# " headings, paragraphs.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((?:https?:\/\/|\/(?!\/))[^\s)]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    let el;
    if (m[1]) { el = document.createElement("code"); el.textContent = s.slice(1, -1); }
    else if (m[2]) { el = document.createElement("strong"); el.append(...inline(s.slice(2, -2))); }
    else if (m[3]) { el = document.createElement("em"); el.append(...inline(s.slice(1, -1))); }
    else {
      el = document.createElement("a");
      const [label, href] = m[4] ? [s.slice(1, s.indexOf("](")), s.slice(s.indexOf("](") + 2, -1)] : [s, s];
      el.href = href; el.textContent = label; el.target = "_blank"; el.rel = "noopener noreferrer";
    }
    out.push(el);
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Copy button on every code block (two overlapping squares; tick for 1.5 s once copied).
const COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const DONE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';

async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; } catch {}
  const ta = document.createElement("textarea"); // fallback: plain http or no permission
  ta.value = s; ta.style.cssText = "position:fixed;opacity:0"; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {}
  ta.remove(); return ok;
}

function copyButton(code) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "tx-copy"; b.dataset.tip = "Copy"; b.setAttribute("aria-label", "Copy");
  b.innerHTML = COPY;
  b.addEventListener("click", async e => {
    e.stopPropagation();
    if (!(await copyText(code.textContent))) return;
    b.innerHTML = DONE; b.dataset.tip = "Copied"; b.classList.add("done");
    setTimeout(() => { b.innerHTML = COPY; b.dataset.tip = "Copy"; b.classList.remove("done"); }, 1500);
  });
  return b;
}

export function render(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text).split(/^```[^\n]*\n?/m); // odd parts are code
  parts.forEach((part, i) => {
    if (i % 2) {
      const pre = document.createElement("pre"), code = document.createElement("code");
      code.textContent = part.replace(/\n$/, ""); pre.append(code, copyButton(code)); frag.append(pre);
      return;
    }
    // a "# " heading is its own block even without blank lines around it
    for (const block of part.replace(/^(#{1,4} .*)$/gm, "\n$1\n").split(/\n{2,}/)) {
      const lines = block.split("\n").filter(l => l.trim());
      if (!lines.length) continue;
      // a list starts with an item; indented lines after an item are its details
      const isB = l => /^[-*] /.test(l), isN = l => /^\d+[.)] /.test(l), indented = l => /^\s+\S/.test(l);
      const bullet = isB(lines[0]) && lines.every(l => isB(l) || indented(l));
      const number = isN(lines[0]) && lines.every(l => isN(l) || indented(l));
      if (bullet || number) {
        const list = document.createElement(bullet ? "ul" : "ol");
        let li = null;
        for (const l of lines) {
          if ((bullet ? isB : isN)(l)) {
            li = document.createElement("li");
            const head = document.createElement("div"); head.className = "c-li-h";
            head.append(...inline(l.replace(/^([-*]|\d+[.)]) /, ""))); li.append(head); list.append(li);
          } else {
            const d = document.createElement("div"); d.className = "c-li-d";
            d.append(...inline(l.trim())); li.append(d);
          }
        }
        frag.append(list);
      } else if (lines.length === 1 && /^#{1,4} /.test(lines[0])) {
        const hd = document.createElement("h3"); hd.append(...inline(lines[0].replace(/^#+ /, ""))); frag.append(hd);
      } else {
        const p = document.createElement("p");
        lines.forEach((l, j) => { if (j) p.append(document.createElement("br")); p.append(...inline(l)); });
        frag.append(p);
      }
    }
  });
  return frag;
}