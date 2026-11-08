// Design judge: a tour of every view and popover with automated look checks.
//   bun tests/design.ts <url> [shot-dir]
// Run it against a preview copy (deploy/preview.sh): it opens menus, never
// sends. For each state at 390x844 and 1920x1080 it writes a screenshot
// and checks: no horizontal overflow; every visible button has data-tip;
// colours come from the theme tokens; separators are white 1px; on desktop
// the content sits in the centred reading column; popovers share one look;
// text is not clipped without an ellipsis. Prints a findings list (the
// rubric for reading the screenshots is docs/design-rubric.md) and exits 1
// on any finding unless --report.
import { launch, type Page } from "./cdp.ts";

const url = (process.argv[2] || "http://127.0.0.1:8189").replace(/\/+$/, "");
const shots = process.argv[3] || "";
const reportOnly = process.argv.includes("--report");
if (shots) await Bun.$`mkdir -p ${shots}`;

type State = { name: string; path: string; ready: string; act?: string; popover?: string; desktopOnly?: boolean };
const firstThread = ((await (await fetch(`${url}/p/chat/threads`)).json()) as { id: string }[])[0]?.id || "";
const board = ((await (await fetch(`${url}/k/items?type=session&limit=20`)).json()) as { id: string }[])[0]?.id || "";
// /m/columns is the board list since multi-board; the tour opens the first board
const colBoard = ((await (await fetch(`${url}/k/items?type=columns&limit=20`)).json()) as { id: string }[])[0]?.id || "";
const show = (s: string) => `(e => { if (!e) return false; e.hidden = false; return true; })(document.querySelector(${JSON.stringify(s)}))`;
const click = (s: string) => `(e => { if (!e) return false; e.click(); return true; })([...document.querySelectorAll(${JSON.stringify(s)})].find(x => x.getClientRects().length))`;

const STATES: State[] = [
  { name: "list", path: "/", ready: ".c-threads a" },
  { name: "thread", path: `/i/${firstThread}`, ready: ".c-msg" },
  { name: "new-thread-menu", path: `/i/${firstThread}`, ready: ".nt-btn", act: click(".nt-btn"), popover: ".nt-ask" },
  // the attach choice is a row of buttons over the bar, not a popover (open question in the rubric)
  { name: "attach-menu", path: "/", ready: ".mb-attach", act: click(".mb-attach") },
  { name: "queue-send", path: "/", ready: ".mb-when", act: show(".mb-when"), popover: ".mb-when" },
  // hands-free talk is a bar modality; its live row needs a microphone, the tour shows the button
  { name: "talk-button", path: `/i/${firstThread}`, ready: ".mb-mod[data-mod=talk]" },
  { name: "picker", path: "/m", ready: "[data-k-kind=modality]" },
  { name: "projects", path: "/m/projects", ready: "[data-k-kind=project]" },
  { name: "strip-closed", path: "/m/projects", ready: ".c-strip" },
  { name: "strip-open", path: "/m/projects", ready: ".c-strip-line", act: click(".c-strip-line") },
  { name: "tinder", path: "/m/tinder", ready: ".tt-card, .tt-empty, [class^=tt-]" },
  { name: "columns-list", path: "/m/columns", ready: "[data-k-kind]" },
  { name: "columns", path: `/m/columns/${colBoard}`, ready: ".co-panel" },
  { name: "columns-add-menu", path: `/m/columns/${colBoard}`, ready: ".co-add", act: click(".co-add"), popover: ".co-pick" },
  { name: "blackboards", path: "/m/blackboards", ready: "[data-k-kind]" },
  { name: "blackboard", path: `/m/blackboards/${board}`, ready: ".ss-win" },
  { name: "settings", path: "/m/settings", ready: ".tm-row" },
  { name: "people", path: "/m/people", ready: ".pp-tools .pp-ic" },
  { name: "people-invite", path: "/m/people", ready: ".pp-tools .pp-ic", act: click(".pp-tools .pp-ic"), popover: ".pp-pop" },
  { name: "people-accept", path: "/m/people", ready: ".pp-tools .pp-ic", act: click(".pp-tools .pp-ic:nth-child(2)"), popover: ".pp-pop" },
].filter(st => !process.env.ONLY || process.env.ONLY.split(",").includes(st.name)); // ONLY=a,b: a test instance with some plugins

// the in-page checks; returns findings as strings
const CHECKS = `(async (popover) => {
  const out = [], W = innerWidth, desk = W >= 1000;
  const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05 && r.bottom > 0 && r.top < innerHeight; };
  const name = e => (e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\\s+/).join(".") : "")).slice(0, 60);
  const rgb = c => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
  const root = getComputedStyle(document.documentElement);
  const tok = ["--bg", "--surface", "--text", "--text-muted", "--line", "--accent-here", "--accent-attention", "--accent-agent", "--link"]
    .map(t => { const d = document.createElement("i"); d.style.color = root.getPropertyValue(t); document.body.append(d); const c = rgb(getComputedStyle(d).color); d.remove(); return c; }).filter(Boolean);
  // a token itself, or a token mixed toward black/transparent (tints, hovers)
  const themed = c => { if (!c || c.a === 0) return true;
    return tok.some(t => { if (Math.abs(t.r - c.r) + Math.abs(t.g - c.g) + Math.abs(t.b - c.b) < 12) return true;
      const k = Math.max(c.r, c.g, c.b) / Math.max(t.r, t.g, t.b, 1); return k > 0 && k <= 1.02 && Math.abs(t.r * k - c.r) + Math.abs(t.g * k - c.g) + Math.abs(t.b * k - c.b) < 14; }); };
  // 1. horizontal overflow
  const sw = document.scrollingElement.scrollWidth;
  if (sw > W + 1) out.push("overflow: page is " + sw + "px wide on a " + W + "px screen");
  const els = [...document.querySelectorAll("body *")].filter(vis);
  for (const e of els) { const r = e.getBoundingClientRect(); if (r.right > W + 2 && !e.closest(".co-strip, .ss-plane, .co-cols, [style*=transform]") && getComputedStyle(e).position !== "fixed") { out.push("overflow: " + name(e) + " ends at " + Math.round(r.right) + "px"); break; } }
  // 2. tooltips on every button
  for (const b of els.filter(e => e.matches("button, [role=button]")))
    if (!b.closest("[data-tip]") && !b.dataset.tip) out.push("tooltip: " + name(b) + " '" + (b.textContent || b.getAttribute("aria-label") || "").trim().slice(0, 30) + "' has no data-tip");
  // 3. theme colours only
  const bad = new Map();
  for (const e of els) { const s = getComputedStyle(e);
    for (const p of ["color", "background-color", "border-top-color", "border-bottom-color"]) {
      if (p.startsWith("border") && parseFloat(s[p.replace("color", "width")]) === 0) continue;
      if (p === "color" && !e.childNodes.length) continue;
      const c = rgb(s[p]); if (!themed(c)) { const k = p + " " + s[p]; if (!bad.has(k)) bad.set(k, name(e)); } } }
  for (const [k, n] of [...bad].slice(0, 12)) out.push("colour: " + k + " on " + n + " is not a theme token");
  // 4. separators: full-width single lines (not boxes) are white 1px; message
  // dividers are grey by decision (Discord-style), so .c-msg is left out
  for (const e of els) { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    if (r.width < W * 0.6 || e.matches(".c-msg") || parseFloat(s.borderLeftWidth) > 0) continue;
    for (const side of ["top", "bottom"]) { const w = parseFloat(s["border-" + side + "-width"]);
      if (!w || s["border-" + side + "-style"] === "none") continue;
      const c = rgb(s["border-" + side + "-color"]);
      if (c && c.a > 0 && (w !== 1 || c.r < 240 || c.g < 240 || c.b < 240)) out.push("separator: " + name(e) + " " + side + " is " + w + "px " + s["border-" + side + "-color"] + " (want white 1px)"); } }
  // 5. desktop reading column
  if (desk) { const side = parseFloat(root.getPropertyValue("--side")) || 0;
    const page = 48 * parseFloat(root.fontSize || 16), L = (W - page) / 2 - 4, R = (W + page) / 2 + 4;
    for (const e of els.filter(e => e.matches(".c-threads a, .c-msg, .pj-row, [data-k-kind=project], [data-k-kind=modality], .tt-card, .mb-modes"))) {
      const r = e.getBoundingClientRect(); if (r.left < L || r.right > R) { out.push("column: " + name(e) + " spans " + Math.round(r.left) + "-" + Math.round(r.right) + "px, outside the centred " + Math.round(L) + "-" + Math.round(R) + "px column"); break; } } }
  // 6. popover look
  if (popover) { const p = [...document.querySelectorAll(popover)].find(vis);
    if (!p || !vis(p)) out.push("popover: " + popover + " did not open");
    else { const s = getComputedStyle(p), bg = rgb(s.backgroundColor), bc = rgb(s.borderTopColor);
      if (!bg || bg.r + bg.g + bg.b > 30 || bg.a < 0.9) out.push("popover: " + popover + " fill " + s.backgroundColor + " (want black)");
      if (parseFloat(s.borderTopWidth) !== 1 || !bc || bc.r < 240) out.push("popover: " + popover + " border " + s.borderTopWidth + " " + s.borderTopColor + " (want white 1px)");
      if (s.borderTopLeftRadius !== root.getPropertyValue("--radius").trim()) out.push("popover: " + popover + " radius " + s.borderTopLeftRadius + " (want var(--radius))"); } }
  // 7. clipped text without an ellipsis
  for (const e of els) { const s = getComputedStyle(e);
    if (!e.childNodes.length || ![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    if (e.scrollWidth > e.clientWidth + 2 && s.overflowX !== "visible" && s.textOverflow !== "ellipsis" && !/auto|scroll/.test(s.overflowX))
      out.push("clipped: " + name(e) + " '" + e.textContent.trim().slice(0, 30) + "' is cut off without an ellipsis"); }
  return out;
})`;

const findings: string[] = [];
const b = await launch();
try {
  for (const [size, w, h] of [["phone", 390, 844], ["desktop", 1920, 1080]] as const) {
    for (const st of STATES) {
      let p: Page | null = null;
      try {
        p = await b.page(w, h);
        await p.goto(url + st.path);
        await p.waitFor(`document.querySelector(${JSON.stringify(st.ready)})`, 20000);
        await Bun.sleep(400);
        if (st.act && !(await p.eval<boolean>(st.act))) throw new Error(`could not open: ${st.act}`);
        await Bun.sleep(500);
        if (shots) await p.screenshot(`${shots}/${size}-${st.name}.png`);
        for (const f of await p.eval<string[]>(`${CHECKS}(${JSON.stringify(st.popover || "")})`)) findings.push(`${size} ${st.name}: ${f}`);
        for (const e of p.errors) findings.push(`${size} ${st.name}: js error ${e}`);
      } catch (e) { findings.push(`${size} ${st.name}: tour step failed: ${(e as Error).message.slice(0, 160)}`); }
      finally { await p?.send("Page.close").catch(() => {}); }
    }
  }
} finally { await b.close(); }
const uniq = [...new Set(findings)];
console.log(uniq.length ? uniq.map(f => "- " + f).join("\n") : "no findings");
console.log(`${STATES.length * 2} states, ${uniq.length} findings${shots ? `, screenshots in ${shots}` : ""}`);
process.exit(uniq.length && !reportOnly ? 1 : 0);
