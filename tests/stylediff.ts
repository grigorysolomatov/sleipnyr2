// Proves a CSS rewrite changes nothing visible: loads the running app in a
// headless browser, puts the chat into each state (list, thread, typing,
// recording, ...) at phone and desktop size, and compares every computed
// style (elements and ::before/::after) and a screenshot, with the chat
// stylesheet replaced by a baseline file versus a candidate file.
//   bun tests/stylediff.ts <url> <baseline.css> <candidate.css> [screenshot-dir]
// Exit 1 when anything differs. Animations are frozen at their start.
import { launch, type Page } from "./cdp.ts";

const [url0, basePath, candidatePath, shots] = process.argv.slice(2);
if (!url0 || !basePath || !candidatePath) { console.error("usage: bun tests/stylediff.ts <url> <baseline.css> <candidate.css> [dir]"); process.exit(2); }
const url = url0.replace(/\/+$/, "");
const css = { served: await Bun.file(basePath).text(), candidate: await Bun.file(candidatePath).text() };

const threads = await (await fetch(`${url}/p/chat/threads`)).json() as { id: string }[];
let thread = "";
for (const t of threads.slice(0, 10)) {
  const n = (await (await fetch(`${url}/p/chat/threads/${encodeURIComponent(t.id)}/messages`)).json() as unknown[]).length;
  if (n) { thread = t.id; break; }
}

// One extra message that uses every message-level style (kept out of the data).
const SINK = `(() => {
  const log = document.querySelector(".c-log");
  if (!log || document.getElementById("sink")) return;
  const a = document.createElement("div");
  a.innerHTML = \`
  <article class="c-msg user" id="sink-u"><header class="c-who"><b>Me</b><time>now</time></header>
    <div class="c-file"><audio controls></audio></div><p class="c-transcript">spoken words</p>
    <p class="c-working"><span class="c-spin"></span><span>transcribing</span><span class="c-el" data-t="0">0:03</span></p></article>
  <article class="c-msg agent" id="sink"><header class="c-who"><b>Agent</b><time>now</time></header>
    <div class="c-file"><a href="#"><img class="c-img" alt="x" src="/web/icons/icon-192.png"></a></div>
    <div class="c-file"><a class="c-link" href="#">file.pdf</a></div>
    <div class="c-text"><h3>Heading</h3><p>Text with <a href="#">a link</a> and <code>code</code>.</p>
      <ul><li><div class="c-li-h">headline</div><div class="c-li-d">detail line</div></li><li>plain</li></ul>
      <ol><li>one</li></ol><pre><code>block</code></pre></div>
    <p class="c-working"><span class="c-spin"></span><span>a long step text that wraps after the timer and keeps going</span><span class="c-el" data-t="0">1:23</span></p>
    <p class="c-error"><b>! </b>failed</p></article>
  <article class="c-msg agent c-arrive" id="sink-arrive"><div class="c-text"><p>arriving</p></div></article>
  <article class="c-msg agent c-wait" id="sink-wait"><div class="c-text"><p>waiting</p></div></article>\`;
  log.append(...a.children);
})()`;

const STATES: Record<string, string> = {
  list: `history.pushState({}, "", "/"); document.querySelector(".c-shell").classList.remove("thread-open")`,
  thread: ``,
  typing: `document.querySelector(".mb").classList.add("typing")`,
  files: `const f = document.querySelector(".mb"); f.classList.add("has-files"); const t = document.querySelector(".mb-tray"); t.hidden = false;
    t.innerHTML = '<figure><img src="/web/icons/icon-192.png"><button class="c-btn">✕</button></figure><figure class="bad"><img src="/web/icons/icon-192.png"></figure>'`,
  recording: `const f = document.querySelector(".mb"); f.classList.add("rec"); document.querySelector(".mb-rec").hidden = false`,
  "recording-quiet": `const f = document.querySelector(".mb"); f.classList.add("rec"); const r = document.querySelector(".mb-rec"); r.hidden = false; r.classList.add("quiet")`,
  "busy-sending": `const f = document.querySelector(".mb"); f.classList.add("busy", "sending", "sent");
    const n = document.querySelector(".mb-note"); n.hidden = false; n.className = "mb-note bad"; n.innerHTML = 'Not sent: <a href="#">x</a>'`,
  "drop-tip": `document.querySelector("#app").classList.add("mb-drop"); const t = document.querySelector(".k-tip"); t.hidden = false; t.textContent = "tip"; t.style.left = "10px"; t.style.top = "100px"`,
};

const COLLECT = `(() => {
  for (const a of document.getAnimations()) { a.pause(); a.currentTime = 0; }
  const out = {};
  // only rendered elements: a hidden element's styles cannot change what is seen
  const els = [...document.querySelectorAll("body *")].filter(e => !["SCRIPT", "LINK", "STYLE"].includes(e.tagName)
    && e.checkVisibility({ contentVisibilityAuto: true }));
  els.forEach((e, i) => {
    const key = i + ":" + e.tagName + (e.id ? "#" + e.id : "") + "." + [...e.classList].join(".");
    for (const pseudo of [null, "::before", "::after"]) {
      const cs = getComputedStyle(e, pseudo);
      if (pseudo && (cs.content === "none" || cs.content === "normal")) continue;
      const o = {};
      for (let j = 0; j < cs.length; j++) { const p = cs[j]; if (!p.startsWith("--")) o[p] = cs.getPropertyValue(p); }
      out[key + (pseudo || "")] = o;
    }
  });
  return out;
})()`;

async function useCss(p: Page, which: "served" | "candidate") {
  await p.eval(`(async () => {
    const l = [...document.querySelectorAll("link[rel=stylesheet]")].find(l => l.dataset.swap || /\\/p\\/chat\\/web\\/chat\\.css/.test(l.href));
    l.dataset.swap = "1"; window.__css = window.__css || {};
    const want = window.__css[${JSON.stringify(which)}] ||= URL.createObjectURL(new Blob([${JSON.stringify(css[which])}], { type: "text/css" }));
    if (l.href === want) return;
    await new Promise(ok => { l.onload = l.onerror = ok; l.href = want; });
  })()`);
  await Bun.sleep(150);
}

const b = await launch();
let diffs = 0;
const report: string[] = [];
try {
  for (const [vp, w, h] of [["phone", 360, 800], ["desktop", 1280, 800]] as const) {
    for (const [state, setup] of Object.entries(STATES)) {
      const p = await b.page(w, h);
      await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
      await p.goto(thread ? `${url}/i/${encodeURIComponent(thread)}` : `${url}/`);
      await p.waitFor(`document.querySelectorAll(".c-msg").length > 0 || document.querySelector(".c-hello")`);
      // freeze the page: no timers rewriting elapsed times, no live updates
      await p.eval(`(() => { const top = setTimeout(() => {}, 0); for (let i = 0; i <= top; i++) { clearTimeout(i); clearInterval(i); } })()`);
      await p.send("Network.enable");
      await p.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await p.eval(SINK);
      await p.eval(`(() => { ${setup} })()`);
      await p.waitFor(`[...document.images].every(i => i.complete || i.loading === "lazy")`);
      await Bun.sleep(300);
      await p.eval(`document.querySelector(".c-log").scrollTop = 1e9`);
      const snap: Record<string, { styles: Record<string, Record<string, string>>; png: string }> = {};
      for (const which of ["served", "candidate"] as const) {
        await useCss(p, which);
        const styles = await p.eval<Record<string, Record<string, string>>>(COLLECT);
        const png = (await p.send("Page.captureScreenshot", { format: "png" })).data as string;
        if (shots) await Bun.write(`${shots}/${vp}-${state}-${which}.png`, Buffer.from(png, "base64"));
        snap[which] = { styles, png };
      }
      const a = snap.served.styles, c = snap.candidate.styles;
      const lines: string[] = [];
      for (const k of new Set([...Object.keys(a), ...Object.keys(c)])) {
        if (!a[k] || !c[k]) { lines.push(`${k}: only in ${a[k] ? "served" : "candidate"}`); continue; }
        for (const prop of Object.keys(a[k])) if (a[k][prop] !== c[k][prop]) lines.push(`${k} ${prop}: ${a[k][prop]} -> ${c[k][prop]}`);
      }
      const samePng = snap.served.png === snap.candidate.png;
      diffs += lines.length + (samePng ? 0 : 1);
      report.push(`${vp}/${state}: ${Object.keys(a).length} boxes, ${lines.length} style differences, screenshot ${samePng ? "identical" : "DIFFERENT"}`);
      for (const l of lines.slice(0, 40)) report.push("    " + l);
      if (p.errors.length) report.push("    page errors: " + p.errors.join("; "));
      await p.send("Page.close").catch(() => {});
    }
  }
} finally {
  await b.close();
}
console.log(report.join("\n"));
console.log(diffs ? `DIFFERENT (${diffs})` : "identical");
process.exit(diffs ? 1 : 0);
