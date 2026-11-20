// Thread switch check: the previous thread's messages leave in the same frame
// as the title, a slow read never draws into a later thread, and a thread seen
// before shows at once. Not part of deploy.sh (it changes the open thread).
//   bun tests/switch.ts <url> [latencyMs]   (latency = simulated slow phone)
import { launch } from "./cdp.ts";
const url = (process.argv[2] || "http://127.0.0.1:8180").replace(/\/+$/, "");
const latency = Number(process.argv[3] || 0);
const threads = await (await fetch(`${url}/p/chat/threads`)).json() as any[];
const withMsgs: { id: string; ids: string[] }[] = [];
for (const t of threads.slice(0, 15)) {
  const m = await (await fetch(`${url}/p/chat/threads/${t.id}/messages`)).json() as any[];
  if (m.length > 1) withMsgs.push({ id: t.id, ids: m.map(x => x.id) });
  if (withMsgs.length === 3) break;
}
const [A, B, C] = withMsgs;
const b = await launch();
let bad = 0;
try {
  for (const [name, w, h] of [["phone", 360, 800], ["desktop", 1280, 800]] as const) {
    const p = await b.page(w, h);
    await p.goto(`${url}/i/${A.id}`);
    await p.waitFor(`document.querySelectorAll(".c-log > .c-msg").length > 0`, 20000);
    // a slow phone connection: every GET of a thread's messages answers after latencyMs
    await p.eval(`(() => { const f = window.fetch; window.fetch = (u, o) => /\\/messages$/.test(String(u)) && !(o && o.method) ? new Promise(r => setTimeout(r, String(u).includes("${A.id}") ? ${latency} * 2 + 300 : ${latency})).then(() => f(u, o)) : f(u, o); return 1; })()`);
    // record per frame
    await p.eval(`(() => {
      const A = new Set(${JSON.stringify(A.ids)}), B = new Set(${JSON.stringify(B.ids)}), C = new Set(${JSON.stringify(C.ids)});
      window.__rec = []; const t0 = performance.now(); window.__t0 = t0;
      const tick = () => { const ids = [...document.querySelectorAll(".c-log > .c-msg")].map(e => e.dataset.id);
        const vis = !!document.querySelector(".c-log")?.getClientRects().length && document.querySelector(".c-shell")?.classList.contains("thread-open");
        const k = ids.some(i => A.has(i)) ? "A" : ids.some(i => C.has(i)) ? "C" : ids.some(i => B.has(i)) ? "B" : "none";
        window.__rec.push([Math.round(performance.now() - t0), vis ? k : "list", document.querySelector(".c-title")?.textContent?.slice(0,20) || ""]);
        if (performance.now() - t0 < ${latency * 4 + 2500}) requestAnimationFrame(tick); };
      requestAnimationFrame(tick); return 1; })()`);
    // back to the list, then tap B (then for the race: quickly C)
    await p.eval(`(() => { document.querySelector(".c-back").click(); return 1; })()`);
    await Bun.sleep(300);
    await p.eval(`(() => { const a = document.querySelector('.c-threads a[href*="${B.id}"]') || [...document.querySelectorAll('.c-threads a')].find(a => a.outerHTML.includes("${B.id}")); window.__tapB = Math.round(performance.now() - window.__t0); a.click(); return !!a; })()`);
    await Bun.sleep(latency * 4 + 2600);
    const rec = await p.eval<any[]>(`window.__rec`);
    const tapB = await p.eval<number>(`window.__tapB`);
    const after = rec.filter(r => r[0] >= tapB);
    const firstB = after.find(r => r[1] === "B"), lastA = [...after].reverse().find(r => r[1] === "A");
    const aMs = lastA ? lastA[0] - tapB : 0;
    console.log(`${name} latency=${latency}: old (A) messages visible ${aMs} ms after tap; B shown at ${firstB ? firstB[0] - tapB : "never"} ms`);
    if (aMs > 20) bad++;
    // race: A -> B -> C quickly, B's response must not land in C
    await p.eval(`(() => { document.querySelector(".c-back").click(); return 1; })()`); await Bun.sleep(200);
    await p.eval(`(() => { const f = id => [...document.querySelectorAll('.c-threads a')].find(a => a.outerHTML.includes(id)); f("${A.id}").click(); document.querySelector(".c-back").click(); setTimeout(() => f("${C.id}").click(), 30); window.__tapC = Math.round(performance.now() - window.__t0); return 1; })()`);
    await Bun.sleep(latency * 3 + 1500);
    const fin = await p.eval<string>(`(() => { const ids = [...document.querySelectorAll(".c-log > .c-msg")].map(e => e.dataset.id); const C = new Set(${JSON.stringify(C.ids)}); return ids.length && ids.every(i => C.has(i)) ? "C-only" : "mixed:" + ids.length + " notC=" + ids.filter(i => !C.has(i)).length + " " + [...document.querySelectorAll(".c-log > .c-msg")].filter(e=>!C.has(e.dataset.id)).slice(0,2).map(e=>e.dataset.id+"|"+e.className+"|"+e.parentElement.className).join(","); })()`);
    console.log(`${name} race A->C: final log ${fin}`);
    if (fin !== "C-only") bad++;
    // back to B (seen before): its messages must show at once, before the slow read
    await p.eval(`(() => { document.querySelector(".c-back").click(); return 1; })()`); await Bun.sleep(200);
    const backB = await p.eval<number>(`new Promise(ok => { const B = new Set(${JSON.stringify(B.ids)}); const t0 = performance.now();
      [...document.querySelectorAll('.c-threads a')].find(a => a.outerHTML.includes("${B.id}")).click();
      const tick = () => { const ids = [...document.querySelectorAll(".c-log > .c-msg")].map(e => e.dataset.id);
        if (ids.length && ids.every(i => B.has(i))) ok(Math.round(performance.now() - t0)); else if (performance.now() - t0 > 8000) ok(-1); else requestAnimationFrame(tick); };
      tick(); })`);
    console.log(`${name} switch back to B: shown after ${backB} ms`);
    if (backB < 0 || (latency && backB > latency / 2)) bad++;
    if (p.errors.length) { console.log("errors", p.errors); bad++; }
  }
} finally { await b.close(); }
console.log(bad ? `FAIL ${bad}` : "PASS");
process.exit(bad ? 1 : 0);
